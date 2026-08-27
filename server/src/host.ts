/**
 * The front door (docs/host.md).
 *
 * One process serves the built SPA and reverse-proxies `/api` and `/ws` to the
 * API server, while SUPERVISING that API as a child. The point is a lifetime
 * split: the API can stop, crash, or restart without the page it is talking to
 * going down with it, and a page whose API is gone still has something alive to
 * start it again. Before this, `npm start` was one process serving both, so a
 * restart took the UI with it and a server that failed to come back left nothing
 * to press the button from.
 *
 * A reverse proxy, deliberately, and not a second origin: the SPA addresses
 * `/api/...` and `location.host` relative (web/src/api.ts, web/src/state.tsx),
 * and keeping it same-origin means no CORS layer and no loosening of the
 * Host/Origin allowlists in net.ts — which are the DNS-rebinding guard on a
 * server whose terminal WebSocket is a code-execution surface. Origin is passed
 * through untouched so the API still judges it; only Host is rewritten, exactly
 * like Vite's `changeOrigin` does in dev.
 *
 * No new dependency: `node:http` + `node:net`. A proxy is ~80 lines and this
 * process must be the most boring thing in the repo — it is the one that has to
 * still be running when everything else is not.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { HostStatus } from '@tm/shared';
import { loadBootConfig, serverRoot } from './config.ts';
import { isAllowedHost, isAllowedOriginHost, lanAddresses, setLanEnabled } from './net.ts';

const cfg = loadBootConfig();
setLanEnabled(cfg.lan.enabled);

const API_PORT = cfg.port;
const HOST_PORT = cfg.host.port;
const API_ORIGIN = `127.0.0.1:${API_PORT}`;
const webDist = path.resolve(serverRoot, '../web/dist');
const serverEntry = path.join(serverRoot, 'src/index.ts');
/** `npm run dev` — the child is `tsx watch`, so a server edit still hot-reloads. */
const dev = process.env.TM_DEV === '1';

// ---------------------------------------------------------------- supervisor

interface ApiState {
  /** what we WANT: an explicit stop must not be undone by the exit watcher. */
  desired: 'up' | 'down';
  child: ChildProcess | null;
  /** false when the API was already listening at boot — we adopted it. */
  managed: boolean;
  up: boolean;
  bootedAt: string | null;
  restarts: number;
  lastExit: { code: number | null; signal: string | null; at: string } | null;
  lastError: string | null;
}

const api: ApiState = {
  desired: 'up',
  child: null,
  managed: false,
  up: false,
  bootedAt: null,
  restarts: 0,
  lastExit: null,
  lastError: null,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One short GET; anything but a 200 with `ok` counts as down. */
function probeHealth(timeoutMs = 1200): Promise<{ bootedAt: string | null } | null> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: API_PORT, path: '/api/health', method: 'GET', headers: { host: API_ORIGIN } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            const j = JSON.parse(body);
            resolve(j?.ok ? { bootedAt: j.bootedAt ?? null } : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

/** Resolves once nothing is listening on the API port — an orphan holding it
 *  would make the replacement die on EADDRINUSE with no explanation. */
async function waitPortFree(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const free = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port: API_PORT });
      const done = (v: boolean) => {
        s.destroy();
        resolve(v);
      };
      s.setTimeout(500, () => done(true));
      s.on('connect', () => done(false));
      s.on('error', () => done(true));
    });
    if (free) return true;
    if (Date.now() > deadline) return false;
    await sleep(200);
  }
}

/**
 * `tsx watch` runs the real server as a GRANDCHILD, so signalling the pid we
 * hold is not enough — an orphan would keep the API port and the next spawn
 * would lose to EADDRINUSE. `detached: true` puts the child in its own process
 * group and `kill(-pid)` takes the whole tree down. It also means the child does
 * NOT die with us, which is why every exit path below kills it explicitly.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

let backoffMs = 500;
let respawnTimer: ReturnType<typeof setTimeout> | null = null;

function spawnApi(): void {
  if (api.child) return;
  const tsxBin = path.resolve(serverRoot, '../node_modules/.bin/tsx');
  const useWatch = dev && fs.existsSync(tsxBin);
  const [cmd, args] = useWatch
    ? [tsxBin, ['watch', serverEntry]]
    : // Not `process.argv`: this process is the HOST. The loader flags in
      // execArgv are what let a plain node run a .ts entry under tsx.
      [process.execPath, [...process.execArgv, serverEntry]];

  const child = spawn(cmd, args, {
    cwd: path.resolve(serverRoot, '..'),
    detached: true,
    stdio: 'inherit',
    // TM_SUPERVISED tells the API that POST /api/server/restart should EXIT
    // rather than detach a replacement of its own: two supervisors racing for
    // one port is the failure this flag exists to prevent.
    env: { ...process.env, TM_SUPERVISED: '1' },
  });
  api.child = child;
  api.managed = true;
  api.lastError = null;
  const startedAt = Date.now();

  child.on('error', (e) => {
    api.lastError = (e as Error).message;
    console.error(`[host] could not start the API: ${(e as Error).message}`);
  });
  child.on('exit', (code, signal) => {
    if (api.child !== child) return; // a newer child already took over
    api.child = null;
    api.up = false;
    api.bootedAt = null;
    api.lastExit = { code, signal, at: new Date().toISOString() };
    if (api.desired !== 'up') {
      console.log(`[host] API stopped (${signal ?? code})`);
      return;
    }
    // A child that lived a while is a fresh incident, not a crash loop.
    if (Date.now() - startedAt > 10_000) backoffMs = 500;
    console.log(`[host] API exited (${signal ?? code}) — restarting in ${backoffMs}ms`);
    respawnTimer = setTimeout(() => {
      respawnTimer = null;
      if (api.desired !== 'up') return;
      api.restarts += 1;
      void waitPortFree().then(() => {
        if (api.desired === 'up') spawnApi();
      });
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 15_000);
  });
}

/** SIGTERM the tree, escalate to SIGKILL, resolve when the process is gone. */
async function stopApi(): Promise<void> {
  api.desired = 'down';
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  const child = api.child;
  if (!child) return;
  const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  killTree(child, 'SIGTERM');
  const escalate = setTimeout(() => killTree(child, 'SIGKILL'), 8000);
  await gone;
  clearTimeout(escalate);
}

/** Poll rather than trust the child handle: an ADOPTED API has no handle, and a
 *  spawned one is only really "up" once it answers. */
async function pollHealth(): Promise<void> {
  const h = await probeHealth();
  api.up = h !== null;
  api.bootedAt = h?.bootedAt ?? null;
}
setInterval(() => void pollHealth().catch(() => {}), 1500).unref();

// -------------------------------------------------------------------- proxy

const isProxied = (url: string) => url === '/api' || url.startsWith('/api/') || url === '/ws' || url.startsWith('/ws/');

function proxyHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
  // Host is rewritten so the API's DNS-rebinding allowlist (which pins the port
  // to its own) passes; Origin is passed through so the API still judges it.
  const headers = { ...req.headers, host: API_ORIGIN };
  delete headers['connection'];
  const proxied = http.request(
    { host: '127.0.0.1', port: API_PORT, method: req.method, path: req.url, headers },
    (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(res);
    },
  );
  proxied.on('error', (e) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const down = (e as NodeJS.ErrnoException).code === 'ECONNREFUSED';
    // A refused socket reads to the SPA as a network failure with no message.
    // Say what happened instead, and say who can fix it.
    res.writeHead(down ? 503 : 502, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: down
          ? 'the task-manager API is not running — start it from the header, or POST /host/start'
          : `proxy error: ${(e as Error).message}`,
        apiDown: down,
      }),
    );
  });
  req.pipe(proxied);
}

function proxyUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
  socket.setNoDelay(true);
  const headers = { ...req.headers, host: API_ORIGIN };
  const proxied = http.request({ host: '127.0.0.1', port: API_PORT, method: req.method, path: req.url, headers });
  proxied.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    upstreamSocket.setNoDelay(true);
    const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}`];
    for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
      lines.push(`${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`);
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upstreamHead?.length) upstreamSocket.unshift(upstreamHead);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
    upstreamSocket.on('error', () => socket.destroy());
  });
  // The API refuses a bad Origin/token with a normal response (the WS routes
  // close 4403 after upgrading, but Fastify's own guards answer 403 first).
  proxied.on('response', (upstreamRes) => {
    const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}`];
    for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
      lines.push(`${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`);
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    upstreamRes.pipe(socket);
  });
  proxied.on('error', () => socket.destroy());
  // Bytes the client sent with the upgrade are replayed after the pipe is up.
  if (head?.length) socket.unshift(head);
  proxied.end();
}

// ------------------------------------------------------------------- static

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const NOT_BUILT =
  'task-manager: the front door is running, but the UI has not been built.\n\n' +
  '  npm run build     then reload this page\n' +
  '  npm run dev       and open port 5173 instead\n';

function sendFile(res: http.ServerResponse, file: string, status = 200): void {
  const ext = path.extname(file).toLowerCase();
  // index.html must never be cached: it is what points at the hashed bundle,
  // so a stale copy pins the browser to assets a rebuild has already deleted.
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(status, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const indexFile = path.join(webDist, 'index.html');
  if (!fs.existsSync(indexFile)) {
    // Checked per request, not once at boot: the front door outlives builds,
    // and `npm run build` in another terminal should just start working.
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(NOT_BUILT);
    return;
  }
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const target = path.join(webDist, urlPath);
  // `path.join` normalises `..`, so this comparison is the traversal guard.
  const inside = target === webDist || target.startsWith(webDist + path.sep);
  if (inside && fs.existsSync(target) && fs.statSync(target).isFile()) {
    sendFile(res, target);
    return;
  }
  sendFile(res, indexFile); // SPA fallback — client-side routes are not files
}

// ------------------------------------------------------------- control API

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 4096) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Typed against @tm/shared so the UI and this process cannot drift apart. */
function status(): HostStatus {
  return {
    api: {
      up: api.up,
      managed: api.managed,
      pid: api.child?.pid ?? null,
      port: API_PORT,
      bootedAt: api.bootedAt,
      restarts: api.restarts,
      desired: api.desired,
      lastExit: api.lastExit,
      lastError: api.lastError,
    },
    host: { port: HOST_PORT, dev, spaBuilt: fs.existsSync(path.join(webDist, 'index.html')) },
  };
}

/** The API owns the "are agents working?" rule; ask it rather than restate it.
 *  An unreachable API cannot be killing anything, so a down server is free. */
async function restartBlocked(force: boolean): Promise<null | Record<string, unknown>> {
  if (force) return null;
  const guard = await new Promise<any>((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: API_PORT, path: '/api/server/restart-check', method: 'GET', headers: { host: API_ORIGIN } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(res.statusCode === 200 ? JSON.parse(body) : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.setTimeout(1500, () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
  return guard?.blocked ? guard : null;
}

/** POST the API's own restart route — the path for an API we did not spawn,
 *  which detaches its own replacement and stays outside our supervision. */
function askApiToRestart(force: boolean): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ force });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: API_PORT,
        path: '/api/server/restart',
        method: 'POST',
        headers: { host: API_ORIGIN, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 502, body }));
      },
    );
    req.setTimeout(5000, () => req.destroy());
    req.on('error', (e) => resolve({ status: 502, body: JSON.stringify({ error: (e as Error).message }) }));
    req.end(payload);
  });
}

/** Bring a managed child up and wait for it to actually answer. */
async function startAndWait(timeoutMs = 30_000): Promise<boolean> {
  api.desired = 'up';
  backoffMs = 500;
  await waitPortFree(5000);
  spawnApi();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await pollHealth();
    if (api.up) return true;
    await sleep(300);
  }
  return false;
}

async function control(req: http.IncomingMessage, res: http.ServerResponse, route: string): Promise<void> {
  if (route === '/host/status') {
    await pollHealth();
    return json(res, 200, status());
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  let body: any;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: (e as Error).message });
  }
  const force = body?.force === true;

  if (route === '/host/start') {
    await pollHealth();
    if (api.up) return json(res, 200, { ok: true, already: true, ...status() });
    const ok = await startAndWait();
    return json(res, ok ? 200 : 500, {
      ok,
      error: ok ? undefined : 'the API did not come up — check this terminal for its output',
      ...status(),
    });
  }

  if (route === '/host/stop') {
    await pollHealth();
    if (api.up && !api.managed) {
      return json(res, 409, {
        error: 'this API was not started by the front door — stop it where you started it',
        ...status(),
      });
    }
    const blocked = await restartBlocked(force);
    if (blocked) return json(res, 409, { ...blocked, ...status() });
    await stopApi();
    await pollHealth();
    return json(res, 200, { ok: true, ...status() });
  }

  if (route === '/host/restart') {
    await pollHealth();
    const blocked = await restartBlocked(force);
    if (blocked) return json(res, 409, { ...blocked, ...status() });
    if (api.up && !api.managed) {
      // Not ours to respawn: let it detach its own replacement.
      const r = await askApiToRestart(force);
      res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' });
      return void res.end(r.body);
    }
    await stopApi();
    const ok = await startAndWait();
    return json(res, ok ? 200 : 500, {
      ok,
      error: ok ? undefined : 'the API did not come back — check this terminal for its output',
      ...status(),
    });
  }
  return json(res, 404, { error: 'not found' });
}

// -------------------------------------------------------------------- serve

const server = http.createServer((req, res) => {
  // Same DNS-rebinding guard as the API, against THIS port: a hostile page whose
  // DNS re-resolves to 127.0.0.1 still arrives with its own Host header.
  if (!isAllowedHost(req.headers.host, HOST_PORT)) {
    return json(res, 403, { error: 'forbidden host' });
  }
  const url = req.url ?? '/';
  const route = url.split('?')[0];
  if (route === '/host' || route.startsWith('/host/')) {
    // The control routes stop and start a server; a drive-by page must not be
    // able to fire them blind. Browsers always attach Origin to a POST.
    if (req.method !== 'GET' && req.headers.origin !== undefined && !isAllowedOriginHost(req.headers.origin)) {
      return json(res, 403, { error: 'forbidden origin' });
    }
    void control(req, res, route).catch((e) => {
      if (!res.headersSent) json(res, 500, { error: (e as Error).message });
    });
    return;
  }
  if (isProxied(route)) return proxyHttp(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
  serveStatic(req, res);
});

server.on('upgrade', (req, socket, head) => {
  if (!isAllowedHost(req.headers.host, HOST_PORT) || !isProxied((req.url ?? '/').split('?')[0])) {
    socket.destroy();
    return;
  }
  proxyUpgrade(req, socket as net.Socket, head);
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // The child is detached (see killTree) so it does NOT die with us. Ctrl-C in
  // this terminal has to mean "stop the whole thing", or the next boot meets an
  // orphan already holding the API port.
  await stopApi();
  server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

const bindHost = cfg.lan.enabled ? '::' : '127.0.0.1';
await new Promise<void>((resolve, reject) => {
  server.once('error', (e) => {
    // LAN mode mirrors the API: `::` is dual-stack, `0.0.0.0` is IPv4-only and
    // loses `localhost` on macOS, where it resolves to ::1 first.
    const code = (e as NodeJS.ErrnoException).code;
    if (cfg.lan.enabled && (code === 'EAFNOSUPPORT' || code === 'EADDRNOTAVAIL')) {
      server.listen(HOST_PORT, '0.0.0.0', resolve);
      return;
    }
    reject(e);
  });
  server.listen(HOST_PORT, bindHost, resolve);
});

console.log(`task-manager front door on http://127.0.0.1:${HOST_PORT}  → API 127.0.0.1:${API_PORT}`);
if (cfg.lan.enabled) {
  for (const addr of lanAddresses()) console.log(`  LAN: http://${addr}:${HOST_PORT}  ⚠ anyone on this network can run commands here`);
}
if (!fs.existsSync(path.join(webDist, 'index.html'))) {
  console.warn(`  ⚠ web/dist not found — run \`npm run build\` (the front door picks it up without a restart).`);
}

// Adopt an API that is already listening instead of fighting it for the port:
// someone running `npm run dev:server` in another terminal is a normal setup,
// and killing or shadowing it would be a surprise. Adopted means unmanaged —
// we can proxy to it and ask it to restart itself, but we cannot respawn it.
await pollHealth();
if (api.up) {
  api.managed = false;
  console.log(`[host] adopted the API already listening on :${API_PORT} (not supervised — start it here to manage it)`);
} else {
  spawnApi();
}
