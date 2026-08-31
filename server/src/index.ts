import { spawn } from 'node:child_process';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';
import { z, ZodError } from 'zod';
import { DEFAULT_SETTINGS } from '@tm/shared';
import './app-types.ts';
import { sessionToken } from './auth.ts';
import { ActivityWatcher } from './claude/activity.ts';
import { CommandRunner } from './commands/runner.ts';
import { liveHeadless, onHeadlessChange, stopAllHeadless } from './claude/headless.ts';
import { loadBootConfig, serverRoot } from './config.ts';
import { isAllowedHost, isAllowedOriginHost, lanAddresses, setLanEnabled } from './net.ts';
import { broadcast } from './events.ts';
import { Orchestrator } from './orchestrator.ts';
import { SessionManager } from './pty/session-manager.ts';
import { createStorage } from './storage/index.ts';
import { registerAgentRoutes } from './routes/agent.ts';
import { registerCommandRoutes } from './routes/commands.ts';
import { registerFeatureRoutes } from './routes/features.ts';
import { registerInternalRoutes } from './routes/internal.ts';
import { registerProposalRoutes } from './routes/proposals.ts';
import { registerOrchestratorRoutes } from './routes/orchestrator.ts';
import { registerRepoRoutes } from './routes/repos.ts';
import { registerRunRoutes } from './routes/runs.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerStatsRoutes } from './routes/stats.ts';
import { registerTaskRoutes } from './routes/tasks.ts';
import { TelegramBot } from './telegram/bot.ts';
import { registerEventsWs } from './ws/events.ts';
import { registerTerminalWs } from './ws/terminal.ts';

const cfg = loadBootConfig();
// Must be set before any route or WS upgrade can be served: every Host/Origin
// decision in net.ts reads it.
setLanEnabled(cfg.lan.enabled);
const storage = await createStorage(cfg);

// PTY knobs are read live so a config change takes effect without a restart
// (the session TTL in particular — 0 means "keep terminals forever").
let scrollbackBytes = DEFAULT_SETTINGS['pty.scrollbackBytes'];
let sessionTtlMs = DEFAULT_SETTINGS['pty.sessionTtlMinutes'] * 60_000;
const refreshPtySettings = async () => {
  const s = await storage.getSettings();
  scrollbackBytes = s['pty.scrollbackBytes'];
  sessionTtlMs = s['pty.sessionTtlMinutes'] * 60_000;
};
void refreshPtySettings().catch(() => {}); // keep the defaults on failure (review F13)
setInterval(() => void refreshPtySettings().catch(() => {}), 30_000).unref();
const sessions = new SessionManager(
  () => scrollbackBytes,
  () => sessionTtlMs,
);
// Repo commands (docs/commands.md) get their OWN PTY pool: a dev server runs
// for hours, and sharing the agent pool would let it consume the orchestrator's
// concurrency accounting and the MAX_LIVE_SESSIONS spawn cap.
const commandSessions = new SessionManager(
  () => scrollbackBytes,
  () => sessionTtlMs,
);
const orchestrator = new Orchestrator(storage, sessions, `http://127.0.0.1:${cfg.port}`);
const commandRunner = new CommandRunner(storage, commandSessions);
await orchestrator.recoverOnBoot();

// Live "what is it doing right now" line per running agent, tailed off the
// session transcripts. Started after boot recovery so orphaned runs from the
// previous process are already retired and never get tailed.
// Headless agents start and finish without any PTY event, so nothing else
// would refresh the status the header (and its restart guard) reads.
onHeadlessChange(() => {
  void orchestrator
    .status()
    .then((status) => broadcast({ type: 'orchestrator.status', status }))
    .catch(() => {});
});

const activity = new ActivityWatcher({
  hasLiveSessions: () => sessions.liveCount() > 0,
  liveRuns: async () => {
    const runs = await storage.listRuns({ status: 'running' });
    return runs
      .filter((r) => !r.idle)
      .map((r) => ({ runId: r.id, taskId: r.taskId, transcriptPath: r.transcriptPath }));
  },
  emit: (a) => broadcast({ type: 'run.activity', activity: a }),
});
activity.start();

const app = Fastify({
  logger: {
    level: 'info',
    serializers: {
      // never log the terminal token from WS attach URLs (review F12)
      req(req: { method: string; url: string }) {
        return { method: req.method, url: req.url.replace(/([?&]token=)[^&]+/, '$1***') };
      },
    },
  },
});
await app.register(fastifyWebsocket, { options: { maxPayload: 8 * 1024 * 1024 } });
await app.register(fastifyMultipart, { limits: { fileSize: 25 * 1024 * 1024, files: 10 } });
app.orchestrator = orchestrator;

// DNS-rebinding guard: loopback binding alone doesn't stop a hostile page whose
// DNS re-resolves to 127.0.0.1 — its requests arrive with a foreign Host header.
// In LAN mode the allowlist widens to private addresses ONLY (server/src/net.ts);
// a routable host is still refused, so a rebind to a public name cannot pass.
app.addHook('onRequest', async (req, reply) => {
  if (!isAllowedHost(req.headers.host, cfg.port)) {
    return reply.code(403).send({ error: 'forbidden host' });
  }
  // Browsers always attach Origin to non-GET requests; a drive-by page cannot
  // strip it. Reject foreign Origins so body-less POSTs (stop-and-kill, kill)
  // can't be blind-fired cross-origin. curl/hooks send no Origin → allowed. (F6)
  if (req.method !== 'GET' && req.headers.origin !== undefined) {
    if (!isAllowedOriginHost(req.headers.origin)) {
      return reply.code(403).send({ error: 'forbidden origin' });
    }
  }
});

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  }
  if (/FOREIGN KEY/i.test((err as Error).message ?? '')) {
    return reply.code(400).send({ error: 'referenced entity does not exist' });
  }
  app.log.error(err);
  return reply.code(500).send({ error: 'internal error' });
});

const bootedAt = new Date().toISOString();
// `supervised` tells the UI (and the front door) who owns this process's
// lifetime: under the host it is a child that will be respawned when it exits,
// so a restart is a clean exit rather than a detached self-respawn.
const supervised = process.env.TM_SUPERVISED === '1';
// `logLevel: 'silent'` because the front door polls this every 1.5s to decide
// whether the API is alive: at the default level it is two log lines a second
// and it buries everything the server actually has to say.
app.get('/api/health', { logLevel: 'silent' }, async () => ({ ok: true, driver: cfg.storage.driver, bootedAt, supervised }));

// A restart kills every agent, so it is REFUSED while any is working: worker
// tasks would be swept to `failed` by boot recovery and their sessions lost,
// and an in-flight analysis / adversarial review / feature plan dies mid-run.
// BOTH kinds count — interactive PTY workers AND headless `claude -p` children,
// which own no PTY and would otherwise slip through the gate entirely.
//
// The guard is ONE function behind ONE route, because the front door
// (server/src/host.ts) has to enforce the same rule when it restarts this
// process from the outside; two copies of the wording is how two answers drift.
const restartGuard = async () => {
  const { running } = await orchestrator.status();
  const headless = liveHeadless();
  const services = commandRunner.running().length;
  const blocked = running > 0 || headless.length > 0;
  const parts = [
    running > 0 ? `${running} agent session(s)` : null,
    headless.length > 0 ? `${headless.length} headless agent(s) (${headless.join(', ')})` : null,
  ].filter(Boolean);
  return {
    blocked,
    error: blocked ? `${parts.join(' and ')} still working — stop them first, or retry with force.` : null,
    running,
    headless: headless.length,
    services,
  };
};
app.get('/api/server/restart-check', async () => restartGuard());

// Self-restart: spawn a detached copy of this process, then exit. The child
// outlives us (detached+unref) and rebinds the port after we release it. Only
// works when launched normally (npm start:api / tsx) — with no supervisor above
// us, this IS the supervisor for one hop. Under the front door a real
// supervisor exists and the branch below hands the job to it instead.
// `{"force": true}` is the deliberate override (curl / a UI that asked twice).
const restartBody = z.object({ force: z.boolean().optional() }).strict();
app.post('/api/server/restart', async (req, reply) => {
  const { force } = restartBody.parse(req.body ?? {});
  const guard = await restartGuard();
  if (guard.blocked && !force) {
    return reply.code(409).send({
      error: guard.error,
      running: guard.running,
      headless: guard.headless,
      services: guard.services,
    });
  }
  // Dev servers are children of this process: kill them deliberately instead
  // of orphaning them onto the port the restarted server's repos will want.
  // Headless agents only ever exist here on the force path — same reasoning.
  commandRunner.stopAll();
  stopAllHeadless();
  // Abort the in-flight long poll NOW so the socket is not still open when the
  // teardown below runs; that teardown awaits the same (idempotent) stop, so
  // the last audit row still lands before storage.close().
  void telegram.stop();
  reply.send({ ok: true, restarting: true });
  setTimeout(async () => {
    // Under the front door there is already a supervisor watching this pid:
    // exit and let it respawn. Self-respawning here would detach a SECOND
    // server onto the same port that the host cannot stop, and the host's own
    // replacement would then lose the race described below.
    if (supervised) {
      void stop();
      return;
    }
    // Release the port BEFORE the replacement is spawned. The old order —
    // spawn, then exit 400ms later — is a race the child loses whenever it
    // boots in under 400ms (an empty database and no repos to recover is
    // enough): it dies on EADDRINUSE with `stdio: 'ignore'` swallowing the
    // stack trace, and the restart button leaves NOTHING running. Closing
    // first makes the handoff ordered instead of hopeful; the timeout is
    // there because a Fastify close waits on in-flight requests and a wedged
    // one must not turn a restart into a permanent stop.
    await Promise.race([
      (async () => {
        await telegram.stop();
        await app.close();
        await storage.close();
      })().catch(() => {}),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
    try {
      // Two things this respawn has to get right, both learned the hard way:
      // `spawn` is imported at the top (this file is ESM — the `require` that
      // used to be here threw "require is not defined"), and the loader flags
      // are carried over. Under tsx, `process.argv` is already rewritten to
      // [node, /abs/index.ts], so respawning argv alone gave a bare node that
      // died on the first type annotation. `execArgv` holds tsx's --require /
      // --import; it is empty for a plain `node file.js`, where this is a no-op.
      const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
        cwd: process.cwd(),
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.unref();
    } catch (e) {
      console.error('restart spawn failed:', e);
    }
    setTimeout(() => process.exit(0), 100);
  }, 250);
});
app.get('/api/session', async () => ({ token: sessionToken }));

registerRepoRoutes(app, storage);
registerTaskRoutes(app, storage);
registerSettingsRoutes(app, storage);
registerRunRoutes(app, storage, orchestrator, activity);
registerOrchestratorRoutes(app, storage, orchestrator);
registerInternalRoutes(app, storage, sessions, orchestrator);
registerAgentRoutes(app, storage, orchestrator);
registerCommandRoutes(app, storage, commandRunner);
registerProposalRoutes(app, storage);
registerFeatureRoutes(app, storage);
registerStatsRoutes(app, storage, sessions, orchestrator);
registerTerminalWs(app, [sessions, commandSessions]);
registerEventsWs(app);

// The Telegram bot (docs/telegram.md) reaches OUT — it registers no route and
// opens no port, so it is not part of the Fastify surface at all. Started
// after the routes so a command that lands in the first second finds a fully
// wired server; start() never throws and never blocks on the network.
const telegram = new TelegramBot(cfg.telegram, storage, orchestrator);

// Serve the built SPA when present (production mode). When it is absent this
// used to register nothing at all, so `/` answered Fastify's default 404 JSON
// and the browser showed a blank-looking error on a server that was working
// fine — the failure has to name its own cause.
const webDist = path.resolve(serverRoot, '../web/dist');
const servingSpa = fs.existsSync(path.join(webDist, 'index.html'));
if (servingSpa) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });
} else {
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply
      .code(503)
      .type('text/plain; charset=utf-8')
      .send(
        'task-manager: the API is running, but the UI has not been built.\n\n' +
          '  npm run build     then start the server again\n' +
          '  npm run dev       (or npm run dev:lan) and open port 5173 instead\n\n' +
          `This port serves the SPA only as a fallback. \`npm start\` runs the front door\n` +
          `on :${cfg.host.port} instead, which keeps the page up across a restart of this one.\n`,
      );
  });
}

const stop = async () => {
  // Dev servers and watchers die with us either way; signalling them first is
  // what makes them release their ports before the next boot. Headless agents
  // do NOT die with us — they would keep spending tokens for nobody.
  commandRunner.stopAll();
  stopAllHeadless();
  // Awaited, unlike the others: the bot has an in-flight long poll to abort and
  // a last audit row to write, and both need the storage still open.
  await telegram.stop();
  await app.close();
  await storage.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// 127.0.0.1 by default — the terminal WS is a code-execution surface. LAN mode
// (data/config.json `lan.enabled` or TM_LAN=1) is the ONE way to widen this, and
// it is opt-in precisely because anyone who reaches /api/session gets that surface.
//
// LAN mode listens on `::` rather than `0.0.0.0`: the latter is IPv4-only, and
// `localhost` resolves to `::1` first on macOS, so a browser that does not fall
// back to IPv4 gets a refused connection on a server that is plainly running.
// `::` is dual-stack on every platform that has IPv6 at all; where it is off,
// binding it throws and IPv4 is the correct answer anyway.
/**
 * A restart hands the port from one process to the next, and the outgoing one
 * may still be letting go of it. Rather than assume the handoff is instant,
 * retry EADDRINUSE for a few seconds — a bind that fails here kills the only
 * server there is, and `stdio: 'ignore'` on the respawn means nobody sees why.
 * Every other listen error is still fatal on the first try.
 */
const listenOrRetry = async (host: string, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await app.listen({ port: cfg.port, host });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
};

if (cfg.lan.enabled) {
  try {
    await listenOrRetry('::');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EAFNOSUPPORT' && (e as NodeJS.ErrnoException).code !== 'EADDRNOTAVAIL') throw e;
    await listenOrRetry('0.0.0.0');
  }
} else {
  await listenOrRetry('127.0.0.1');
}
console.log(`task-manager listening on http://127.0.0.1:${cfg.port} (storage: ${cfg.storage.driver})`);
if (cfg.lan.enabled) {
  for (const addr of lanAddresses()) console.log(`  LAN: http://${addr}:${cfg.port}  ⚠ anyone on this network can run commands here`);
}
if (!servingSpa) {
  console.warn(
    `  ⚠ web/dist not found — the API is up but there is no UI to open at :${cfg.port}.\n` +
      `    Production: run \`npm run build\` and start again.\n` +
      `    Development: use \`npm run dev\` (or dev:lan) and open the Vite port 5173 instead.`,
  );
}
telegram.start();
if (!supervised) {
  console.log(
    `  note: \`npm start\` runs the front door on :${cfg.host.port}, which serves the UI and proxies here,\n` +
      `        so the page survives a restart of this process (docs/host.md). This is \`start:api\`.`,
  );
}
