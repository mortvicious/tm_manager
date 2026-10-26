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
import type { HostStatus, RebuildJob, RebuildWaitingFor } from '@tm/shared';
import { loadBootConfig, serverRoot } from './config.ts';
import { isAllowedHost, isAllowedOriginHost, lanAddresses, setLanEnabled } from './net.ts';
import { buildSpa, hostFingerprint, readBuildId, swapDist, typecheck, webDist } from './rebuild.ts';
import { checkRemote, looksProxied, mintHostToken, stripTailscaleHeaders } from './remote.ts';
import { clearStopIntent, writeStopIntent, type StopCause } from './stop-cause.ts';

const cfg = loadBootConfig();
setLanEnabled(cfg.lan.enabled);

const API_PORT = cfg.port;
const HOST_PORT = cfg.host.port;
const API_ORIGIN = `127.0.0.1:${API_PORT}`;
/** What an admitted remote request's Origin becomes before the API judges it (see admitRemote). */
const LOOPBACK_ORIGIN = `http://127.0.0.1:${HOST_PORT}`;
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
    // TM_WATCH tells the API that an unannounced SIGTERM is most likely
    // `tsx watch` reloading on a file change (docs/host.md § Restart causes).
    env: { ...process.env, TM_SUPERVISED: '1', ...(useWatch ? { TM_WATCH: '1' } : {}) },
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

/**
 * SIGTERM the tree, escalate to SIGKILL, resolve when the process is gone.
 * `why` is left for the API first (`writeStopIntent`): a signal carries no
 * sender, and the API's next boot reports the cause (docs/host.md § Restart
 * causes).
 */
async function stopApi(why: { action: NonNullable<StopCause['action']>; actor?: string; force?: boolean }): Promise<void> {
  api.desired = 'down';
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  const child = api.child;
  if (!child) return;
  writeStopIntent(why);
  const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  killTree(child, 'SIGTERM');
  const escalate = setTimeout(() => killTree(child, 'SIGKILL'), 8000);
  await gone;
  clearTimeout(escalate);
  // Consumed by the API's signal handler; one it never read (it died first)
  // must not be taken for the reason of some later, unrelated signal.
  clearStopIntent();
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
          ? 'the task-manager API is not running — tap Start server (the header, or the offline banner on a phone), or POST /host/start'
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
  // Once a socket is upgraded, Node's http server drops its own 'error' handler,
  // so this listener is the only one. Without it, a browser that goes away while
  // the API is still streaming (tab closed, phone backgrounded) EPIPEs inside
  // the pipe below, the error is unhandled, and the front door dies.
  socket.on('error', () => proxied.destroy());
  proxied.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    upstreamSocket.setNoDelay(true);
    socket.on('error', () => upstreamSocket.destroy());
    socket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => socket.destroy());
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

// ------------------------------------------------------------ remote gate

// The gate itself is server/src/remote.ts; this is what the front door does
// with its verdict. It lives HERE and not in the API because the proxy rewrites
// Host to 127.0.0.1:<api>, after which the API cannot tell a request that came
// through `tailscale serve` from one typed at the Mac. Remote-ness is decided by
// WHICH LISTENER a request arrived on (remoteServer below), never by its Host:
// serve forwards the client's Host verbatim.

// Minted every boot, remote or not, so a file left by an earlier boot never stays valid.
const hostToken = mintHostToken();

/**
 * An admitted remote request, made to look like what it now is — a request
 * the front door vouches for — before any other rule reads it:
 *
 * - every `tailscale-*` header is stripped: the API never sees identity it
 *   cannot verify itself.
 * - Origin: the gate has just checked it is EXACTLY `https://<remote.hostname>`,
 *   so it is rewritten to this front door's own loopback origin. The API's
 *   Origin rules (index.ts onRequest, the WS routes) and the /host check below
 *   stay loopback/LAN-only and never learn a non-private name; the API has no
 *   `remote` code path that a direct hit on 127.0.0.1:<api> could exercise.
 * - the first request of each login this boot is audited (one row, not per request).
 */
function admitRemote(req: http.IncomingMessage, login: string): void {
  stripTailscaleHeaders(req.headers);
  if (req.headers.origin !== undefined) req.headers.origin = LOOPBACK_ORIGIN;
  auditRemoteLogin(login, String(req.headers['user-agent'] ?? '').slice(0, 300));
}

/** login -> 'pending' while the API write is in flight, 'done' once it landed. */
const remoteLogins = new Map<string, 'pending' | 'done'>();
const loggedLogins = new Set<string>();

function auditRemoteLogin(login: string, userAgent: string): void {
  if (remoteLogins.has(login)) return;
  remoteLogins.set(login, 'pending');
  if (!loggedLogins.has(login)) {
    loggedLogins.add(login);
    console.log(`[host] remote sign-in: ${login} (${userAgent || 'no user agent'})`);
  }
  const payload = JSON.stringify({ login, userAgent });
  const req = http.request(
    {
      host: '127.0.0.1',
      port: API_PORT,
      path: '/api/host/remote-login',
      method: 'POST',
      headers: {
        host: API_ORIGIN,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-tm-host-token': hostToken,
      },
    },
    (res) => {
      res.resume();
      // Anything but a 2xx (API down, an older API without the route) is
      // retried on this login's next request rather than silently dropped.
      if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) remoteLogins.set(login, 'done');
      else remoteLogins.delete(login);
    },
  );
  req.setTimeout(3000, () => req.destroy());
  req.on('error', () => remoteLogins.delete(login));
  req.end(payload);
}

/** Refusals are logged, but at most once a minute per reason: a tailnet peer can send a lot of requests. */
const lastDenyLog = new Map<string, number>();
function logDeny(reason: string, req: http.IncomingMessage): void {
  const now = Date.now();
  if (now - (lastDenyLog.get(reason) ?? 0) < 60_000) return;
  lastDenyLog.set(reason, now);
  const who = req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '?';
  console.warn(`[host] remote request refused (${reason}) from ${who}: ${req.method} ${(req.url ?? '/').split('?')[0]}`);
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

// -------------------------------------------------------- rebuild & restart

// docs/host.md § Rebuild & restart. The job runs HERE, in the front door's
// lifetime, because the API is the thing it restarts. The steps themselves are
// rebuild.ts (shared with scripts/rebuild-restart.mjs); this is the sequencing.

/** host.ts and its imports as this process booted them (see hostFingerprint). */
const bootFingerprint = hostFingerprint();
let staleSeen = false;
/** Re-hashed per status read (five small files), and sticky once true. */
function hostStale(): boolean {
  if (!staleSeen && hostFingerprint() !== bootFingerprint) staleSeen = true;
  return staleSeen;
}

const idleJob = (): RebuildJob => ({
  state: 'idle',
  startedAt: null,
  finishedAt: null,
  step: null,
  error: null,
  reason: null,
  logTail: '',
  buildId: null,
  hostStale: false,
  dev,
  bootedBefore: null,
  bootedAfter: null,
  drain: false,
  drainDeadline: null,
  waitingFor: null,
  pausedByJob: false,
  continued: null,
});

let job: RebuildJob = idleJob();
/** between the press and the job's first state: see the route */
let jobClaimed = false;
/** the vite / tsc process the job is waiting on, killed on shutdown */
let jobChild: ChildProcess | null = null;
const setJobChild = (c: ChildProcess | null) => (jobChild = c);
const REBOOT_TIMEOUT_MS = 60_000;
/** Drain mode's default patience (docs/host.md § Drain), and its bounds. */
const DRAIN_DEFAULT_MIN = 30;
const DRAIN_MAX_MIN = 240;
/** How often a draining job re-reads the restart check. */
const DRAIN_POLL_MS = 2_000;
/** Set by POST /host/rebuild-restart/cancel; read by the drain loop. */
let cancelRequested = false;

const jobRunning = () =>
  job.state === 'draining' ||
  job.state === 'building' ||
  job.state === 'typechecking' ||
  job.state === 'restarting' ||
  job.state === 'continuing';

function jobStep(state: RebuildJob['state'], step: string): void {
  job = { ...job, state, step };
  console.log(`[host] rebuild: ${step}`);
}

function jobEnd(state: 'done' | 'failed', patch: Partial<RebuildJob>): void {
  job = { ...job, ...patch, state, finishedAt: new Date().toISOString(), hostStale: hostStale() };
  console.log(`[host] rebuild ${state}${job.error ? `: ${job.error}` : ''}`);
  if (job.hostStale) console.log('[host] host.ts changed since this front door booted — restart `npm start` to load it');
}

/** Poll until the API answers with a bootedAt that is not `before`. */
async function waitNewBoot(before: string | null, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await pollHealth();
    if (api.up && api.bootedAt && api.bootedAt !== before) return api.bootedAt;
    await sleep(500);
  }
  return null;
}

interface RebuildOptions {
  force: boolean;
  check: boolean;
  /** drain mode: pause without suspending, wait for quiet (docs/host.md § Drain) */
  drain: boolean;
  drainMinutes: number;
}

function startRebuild(opts: RebuildOptions): void {
  cancelRequested = false;
  job = {
    ...idleJob(),
    state: opts.drain ? 'draining' : !dev ? 'building' : opts.check ? 'typechecking' : 'restarting',
    startedAt: new Date().toISOString(),
    drain: opts.drain,
  };
  void runRebuild(opts).catch(async (e) => {
    // Never leave the machine paused by a job that died: the hold is ours.
    const released = await releasePause();
    jobEnd('failed', { error: `${(e as Error).message}${released}`, reason: 'error' });
  });
}

/**
 * The orchestrator's pause, from the front door: the API's own routes with
 * this process's loopback Origin (they refuse a request without one — a
 * worker's curl must not pause the machine). `by: 'rebuild'` labels the audit
 * row; the API decides everything else.
 */
async function orchestratorCall(
  which: 'pause' | 'continue',
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  // 60 s: a suspending pause waits up to 15 s for compaction gates between
  // its two sweeps, and a timeout here would read as a failure of a pause
  // that in fact happened.
  const r = await apiRequest('POST', `/api/orchestrator/${which}`, { ...body, by: 'rebuild' }, LOOPBACK_ORIGIN, 60_000);
  let json: any = null;
  try {
    json = JSON.parse(r.body);
  } catch {
    /* keep null */
  }
  return { status: r.status, json };
}

/**
 * Undo the hold this job set (and ONLY that one — a pause the human pressed
 * before the job is theirs to lift). Returns a sentence for the job's error
 * line, empty when there was nothing to release.
 */
async function releasePause(): Promise<string> {
  if (!job.pausedByJob) return '';
  const r = await orchestratorCall('continue', {});
  if (r.status === 200) {
    job = { ...job, pausedByJob: false, continued: true };
    return ' The pause the job set was released (Continue); no work was lost.';
  }
  job = { ...job, continued: false };
  return ` The pause the job set could NOT be released (${r.status}: ${r.json?.error ?? 'no answer'}) — press Continue.`;
}

function waitingFrom(guard: any): RebuildWaitingFor {
  return {
    running: Number(guard?.running ?? 0),
    aux: Array.isArray(guard?.auxLabels) ? guard.auxLabels.map(String) : [],
    notPauseAware: Array.isArray(guard?.notPauseAware) ? guard.notPauseAware.map(String) : [],
  };
}

function drainStep(w: RebuildWaitingFor, deadline: number): string {
  const parts: string[] = [];
  if (w.running) parts.push(`${w.running} agent turn(s) finishing`);
  const held = w.aux.length - w.notPauseAware.length;
  if (held > 0) parts.push(`${held} review/compaction session(s)`);
  if (w.notPauseAware.length) parts.push(`${w.notPauseAware.length} session(s) the pause does not stop (${w.notPauseAware.join(', ')})`);
  const left = Math.max(0, Math.ceil((deadline - Date.now()) / 60_000));
  return `Draining — waiting for ${parts.join(', ') || 'the restart check'} (gives up in ${left} min)…`;
}

/**
 * Drain (docs/host.md § Drain): re-read the restart check until it is quiet.
 * On the deadline: without force, release the job's own pause and fail
 * `drain_timeout` (nothing was cut); with force, suspend the live turns with
 * a normal Pause all (each resumes in its own session on Continue) and let the
 * forced restart end whatever the pause does not. Cancel releases like a
 * timeout. true = go on and restart.
 */
async function drainUntilQuiet(force: boolean): Promise<boolean> {
  const deadline = Date.parse(job.drainDeadline!);
  for (;;) {
    if (cancelRequested) {
      const released = await releasePause();
      jobEnd('failed', { error: `Cancelled while draining — the API was NOT restarted.${released}`, reason: 'cancelled', waitingFor: null });
      return false;
    }
    const guard = await readRestartCheck();
    // An unreachable API cannot be killing anything: nothing to drain.
    if (!guard || !guard.blocked) {
      job = { ...job, waitingFor: null };
      return true;
    }
    const w = waitingFrom(guard);
    job = { ...job, waitingFor: w, step: drainStep(w, deadline) };
    if (Date.now() >= deadline) {
      if (force) {
        jobStep('draining', 'Drain timed out — forced: suspending the remaining turns (Pause all)…');
        const p = await orchestratorCall('pause', { suspend: true });
        if (p.status !== 200 && api.up) {
          const released = await releasePause();
          jobEnd('failed', {
            error: `the suspending pause failed (${p.status}: ${p.json?.error ?? 'no answer'}) — the API was NOT restarted.${released}`,
            reason: 'pause',
          });
          return false;
        }
        return true;
      }
      const released = await releasePause();
      jobEnd('failed', {
        error: `Drain timed out: ${String(guard.error ?? 'work is still running')} The API was NOT restarted.${released}`,
        reason: 'drain_timeout',
      });
      return false;
    }
    await sleep(DRAIN_POLL_MS);
  }
}

async function runRebuild(opts: RebuildOptions): Promise<void> {
  const { force, check, drain } = opts;
  /** the machine was already paused when the job started: that pause is the human's */
  let humanPause = false;
  // 0. Drain: the pause FIRST, without suspending anything, so nothing new
  //    starts while the build runs; live turns keep working.
  if (drain) {
    job = { ...job, drainDeadline: new Date(Date.now() + opts.drainMinutes * 60_000).toISOString() };
    jobStep('draining', 'Pausing new work (live turns keep running)…');
    await pollHealth();
    if (api.up) {
      // An API that predates drain mode ignores `suspend: false` and would
      // SUSPEND every live turn — the opposite of a drain. Its restart check
      // lacks `notPauseAware`; refuse rather than cut work.
      const guard = await readRestartCheck();
      if (guard && !Array.isArray(guard.notPauseAware)) {
        return jobEnd('failed', {
          error:
            'the running API predates drain mode (it would suspend live turns instead of letting them finish) — nothing was paused, built or restarted. Restart it once without drain, or Pause all yourself.',
          reason: 'pause',
        });
      }
      const p = await orchestratorCall('pause', { suspend: false });
      if (p.status !== 200) {
        return jobEnd('failed', {
          error: `could not pause the orchestrator (${p.status}: ${p.json?.error ?? 'no answer'}) — nothing was built or restarted`,
          reason: 'pause',
        });
      }
      humanPause = p.json?.wasPaused === true;
      job = { ...job, pausedByJob: !humanPause };
    }
  }

  // 1. Build into dist.next and swap. Dev has nothing to build: Vite serves
  //    source, and the reload picks it up.
  if (!dev) {
    jobStep('building', 'Building the web app…');
    const b = await buildSpa(setJobChild);
    if (!b.ok) {
      const released = await releasePause();
      return jobEnd('failed', {
        error: `${b.error} — nothing was restarted; the current page is still served${released}`,
        reason: 'build',
        logTail: b.tail,
      });
    }
    swapDist();
    job = { ...job, buildId: b.buildId, logTail: b.tail };
    console.log(`[host] rebuild: web/dist is now build ${b.buildId ?? '(no id)'}`);
  }

  // 2. Typecheck (fast-fail): refuse a restart into a server that does not
  //    compile. The new dist stays — it is already served, and harmless.
  if (check) {
    jobStep('typechecking', 'Typechecking…');
    const t = await typecheck(setJobChild);
    if (!t.ok) {
      const released = await releasePause();
      return jobEnd('failed', {
        error: `${t.error} — the API was NOT restarted${dev ? '' : ' (the new web build is already served)'}${released}`,
        reason: 'typecheck',
        logTail: t.tail,
      });
    }
  }

  // 3. The build took a while; an agent may have started since the press.
  //    Drain mode waits for it instead of refusing.
  let forceRestart = force;
  for (;;) {
    if (drain) {
      jobStep('draining', 'Draining…');
      if (!(await drainUntilQuiet(force))) return;
      // past the deadline under force: whatever the suspending pause left
      // (non-pause-aware sessions) goes with the restart
      forceRestart = force && Date.now() >= Date.parse(job.drainDeadline!);
    } else {
      const blocked = await restartBlocked(force);
      if (blocked) {
        return jobEnd('failed', {
          error: `${String(blocked.error ?? 'agents are working')} The API was NOT restarted.`,
          reason: 'not_quiet',
          logTail: '',
        });
      }
    }

    // 4. Restart and wait for a NEW bootedAt — up is not enough, the old one was up.
    jobStep('restarting', 'Restarting the API…');
    await pollHealth();
    const before = api.up ? api.bootedAt : null;
    job = { ...job, bootedBefore: before };
    if (api.up && !api.managed) {
      // Adopted, not ours to respawn: it detaches its own replacement.
      const r = await askApiToRestart(forceRestart);
      // A human click started a turn between the drain's last read and this
      // request (the pause holds everything automatic): drain again.
      if (r.status === 409 && drain && Date.now() < Date.parse(job.drainDeadline!)) continue;
      if (r.status !== 200) {
        let msg = `the API refused the restart (${r.status})`;
        try {
          msg = JSON.parse(r.body)?.error ?? msg;
        } catch {
          /* keep the status */
        }
        const released = await releasePause();
        return jobEnd('failed', { error: `${msg}${released}`, reason: 'restart', logTail: '' });
      }
    } else {
      await stopApi({ action: 'rebuild-restart', actor: 'rebuild', force: forceRestart });
      api.desired = 'up';
      backoffMs = 500;
      await waitPortFree(5000);
      spawnApi();
    }
    const after = await waitNewBoot(before, REBOOT_TIMEOUT_MS);
    if (!after) {
      return jobEnd('failed', {
        error:
          'the API did not come back within 60 s — the front door keeps respawning it with backoff; check its terminal output (a broken server file is the usual cause)' +
          (job.pausedByJob ? '. The orchestrator is still paused by this job — press Continue once it is up.' : ''),
        reason: 'timeout',
        // the build's log says nothing about this; the API's own output is in
        // this process's terminal (stdio is inherited)
        logTail: '',
      });
    }
    job = { ...job, bootedAfter: after };
    break;
  }

  // 5. Drain mode: Continue — but ONLY a pause this job set. A pause the human
  //    pressed before the press stays theirs (docs/decisions.md 2026-10-26).
  if (drain && job.pausedByJob) {
    jobStep('continuing', 'Continuing (the pause this job set)…');
    const c = await orchestratorCall('continue', {});
    if (c.status !== 200) {
      return jobEnd('done', {
        step: 'Done — but Continue failed',
        continued: false,
        error: `restarted, but Continue failed (${c.status}: ${c.json?.error ?? 'no answer'}) — the orchestrator is still paused; press Continue`,
      });
    }
    return jobEnd('done', { step: 'Done', continued: true, pausedByJob: false });
  }
  jobEnd('done', {
    step: humanPause ? 'Done — left paused (the pause was not the job’s)' : 'Done',
    continued: drain ? false : null,
  });
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
    host: {
      port: HOST_PORT,
      dev,
      spaBuilt: fs.existsSync(path.join(webDist, 'index.html')),
      // dev: the page is Vite's, whatever an old `npm run build` left in dist
      buildId: dev ? null : readBuildId(),
      stale: hostStale(),
    },
    rebuild: { ...job, hostStale: job.hostStale || hostStale() },
  };
}

/** One request to the API (Host rewritten like the proxy does). `origin`
 *  only for the browser-action routes the job calls (pause / continue). */
function apiRequest(
  method: 'GET' | 'POST',
  route: string,
  body: unknown,
  origin: string | null,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string | number> = { host: API_ORIGIN };
    if (origin) headers.origin = origin;
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port: API_PORT, path: route, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 502, body: text }));
    });
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on('error', (e) => resolve({ status: 502, body: JSON.stringify({ error: (e as Error).message }) }));
    req.end(payload || undefined);
  });
}

/** The API's restart check as it answers it; null when the API is unreachable. */
async function readRestartCheck(): Promise<Record<string, any> | null> {
  const r = await apiRequest('GET', '/api/server/restart-check', undefined, null, 1500);
  if (r.status !== 200) return null;
  try {
    return JSON.parse(r.body);
  } catch {
    return null;
  }
}

/** The API owns the "are agents working?" rule; ask it rather than restate it.
 *  An unreachable API cannot be killing anything, so a down server is free. */
async function restartBlocked(force: boolean): Promise<null | Record<string, unknown>> {
  if (force) return null;
  const guard = await readRestartCheck();
  return guard?.blocked ? guard : null;
}

/** POST the API's own restart route — the path for an API we did not spawn,
 *  which detaches its own replacement and stays outside our supervision. */
function askApiToRestart(force: boolean): Promise<{ status: number; body: string }> {
  return apiRequest('POST', '/api/server/restart', { force }, null, 5000);
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
  if (route === '/host/rebuild-restart' && req.method === 'GET') {
    return json(res, 200, status().rebuild);
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  let body: any;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: (e as Error).message });
  }
  const force = body?.force === true;

  // The job stops and starts the API itself; a second hand on that switch
  // mid-job would leave its wait for a new bootedAt reading the wrong process.
  if ((route === '/host/stop' || route === '/host/restart') && jobRunning()) {
    return json(res, 409, { error: 'a rebuild & restart is running — wait for it', reason: 'in_progress', ...status() });
  }

  if (route === '/host/rebuild-restart/cancel') {
    // Only a drain can be cancelled: a build or a restart in flight is
    // minutes or seconds from its own end, and stopping it half-way is worse.
    if (job.state !== 'draining') {
      return json(res, 409, { error: 'only a draining rebuild can be cancelled', reason: 'not_draining', ...status() });
    }
    cancelRequested = true;
    return json(res, 202, { ok: true, ...status() });
  }

  if (route === '/host/rebuild-restart') {
    // Checked and taken synchronously: two presses must not both pass the
    // guard's await below and start two builds into one dist.next.
    if (jobRunning() || jobClaimed) {
      return json(res, 409, { error: 'a rebuild & restart is already running', reason: 'in_progress', ...status() });
    }
    const drain = body?.drain === true;
    const minutes = Number(body?.drainMinutes ?? DRAIN_DEFAULT_MIN);
    if (drain && (!Number.isFinite(minutes) || minutes < 1 || minutes > DRAIN_MAX_MIN)) {
      return json(res, 400, { error: `drainMinutes must be 1…${DRAIN_MAX_MIN}` });
    }
    jobClaimed = true;
    try {
      await pollHealth();
      // Drain mode waits for quiet instead of refusing (docs/host.md § Drain).
      if (!drain) {
        const blocked = await restartBlocked(force);
        if (blocked) return json(res, 409, { ...blocked, reason: 'not_quiet', ...status() });
      }
      startRebuild({ force, check: body?.typecheck !== false, drain, drainMinutes: minutes });
    } finally {
      jobClaimed = false;
    }
    return json(res, 202, { ok: true, ...status() });
  }

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
    await stopApi({ action: 'stop', force });
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
    await stopApi({ action: 'restart', force });
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

/** Everything after admission, shared by both listeners. */
function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
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
}

const refuseUpgrade = (socket: net.Socket) =>
  socket.on('error', () => socket.destroy()).end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');

const server = http.createServer((req, res) => {
  // Proxied traffic belongs on the remote listener. serve forwards the client's
  // Host verbatim, so if it were ever pointed HERE a `Host: 127.0.0.1:<port>`
  // request would pass the check below with nobody's identity behind it.
  if (looksProxied(req.headers)) {
    logDeny('proxied request on the local listener', req);
    return json(res, 403, { error: 'forbidden: proxied requests are not served on the local port' });
  }
  // Same DNS-rebinding guard as the API, against THIS port: a hostile page whose
  // DNS re-resolves to 127.0.0.1 still arrives with its own Host header.
  if (!isAllowedHost(req.headers.host, HOST_PORT)) {
    return json(res, 403, { error: 'forbidden host' });
  }
  handle(req, res);
});

server.on('upgrade', (req, socket, head) => {
  if (looksProxied(req.headers)) {
    logDeny('proxied request on the local listener', req);
    refuseUpgrade(socket as net.Socket);
    return;
  }
  if (!isAllowedHost(req.headers.host, HOST_PORT) || !isProxied((req.url ?? '/').split('?')[0])) {
    socket.destroy();
    return;
  }
  proxyUpgrade(req, socket as net.Socket, head);
});

/**
 * The remote listener: `tailscale serve` → 127.0.0.1:<remote.port>, opened only
 * when remote access is on. EVERY request here is gated, whatever its Host —
 * there is no "local" on this port — so the loopback allowlist never runs.
 */
const remoteServer = cfg.remote.enabled
  ? http.createServer((req, res) => {
      const gate = checkRemote(req.headers, req.socket.remoteAddress, req.method, false, cfg.remote);
      if (gate.kind === 'deny') {
        logDeny(gate.reason, req);
        return json(res, 403, { error: `forbidden: ${gate.reason}` });
      }
      admitRemote(req, gate.login);
      handle(req, res);
    })
  : null;

remoteServer?.on('upgrade', (req, socket, head) => {
  const gate = checkRemote(req.headers, req.socket.remoteAddress, req.method, true, cfg.remote);
  if (gate.kind === 'deny') {
    logDeny(gate.reason, req);
    refuseUpgrade(socket as net.Socket);
    return;
  }
  if (!isProxied((req.url ?? '/').split('?')[0])) {
    socket.destroy();
    return;
  }
  admitRemote(req, gate.login);
  proxyUpgrade(req, socket as net.Socket, head);
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // The child is detached (see killTree) so it does NOT die with us. Ctrl-C in
  // this terminal has to mean "stop the whole thing", or the next boot meets an
  // orphan already holding the API port.
  if (jobChild) jobChild.kill('SIGKILL');
  // A drain's pause is a row: it outlives this process, and the API's next
  // boot comes up paused. Said here so the terminal shows it.
  if (job.state === 'draining' && job.pausedByJob) {
    console.log('[host] shutting down mid-drain — the orchestrator stays paused; press Continue after the next start');
  }
  await stopApi({ action: 'shutdown' });
  server.close();
  remoteServer?.close();
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
if (remoteServer) {
  // Loopback ALWAYS: serve connects from 127.0.0.1, and remote mode refuses to
  // boot with LAN mode, so nothing else should ever reach this port.
  await new Promise<void>((resolve, reject) => {
    remoteServer.once('error', reject);
    remoteServer.listen(cfg.remote.port, '127.0.0.1', resolve);
  });
}

console.log(`task-manager front door on http://127.0.0.1:${HOST_PORT}  → API 127.0.0.1:${API_PORT}`);
if (cfg.lan.enabled) {
  for (const addr of lanAddresses()) console.log(`  LAN: http://${addr}:${HOST_PORT}  ⚠ anyone on this network can run commands here`);
}
if (cfg.remote.enabled) {
  console.log(
    `  remote: https://${cfg.remote.hostname} → 127.0.0.1:${cfg.remote.port} (\`tailscale serve --bg --https=443 http://127.0.0.1:${cfg.remote.port}\`) for ${cfg.remote.allowedLogins.join(', ')} only`,
  );
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
