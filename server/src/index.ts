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
import { registerEventsWs } from './ws/events.ts';
import { registerTerminalWs } from './ws/terminal.ts';

const cfg = loadBootConfig();
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
const allowedHosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`]);
app.addHook('onRequest', async (req, reply) => {
  if (!allowedHosts.has(req.headers.host ?? '')) {
    return reply.code(403).send({ error: 'forbidden host' });
  }
  // Browsers always attach Origin to non-GET requests; a drive-by page cannot
  // strip it. Reject foreign Origins so body-less POSTs (stop-and-kill, kill)
  // can't be blind-fired cross-origin. curl/hooks send no Origin → allowed. (F6)
  if (req.method !== 'GET' && req.headers.origin !== undefined) {
    let ok = false;
    try {
      const h = new URL(req.headers.origin).hostname;
      ok = h === '127.0.0.1' || h === 'localhost';
    } catch {
      ok = false;
    }
    if (!ok) return reply.code(403).send({ error: 'forbidden origin' });
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
app.get('/api/health', async () => ({ ok: true, driver: cfg.storage.driver, bootedAt }));

// Self-restart: spawn a detached copy of this process, then exit. The child
// outlives us (detached+unref) and rebinds the port after we release it. Only
// works when launched normally (npm start / tsx); there is no supervisor, so
// this IS the supervisor for one hop.
// A restart kills every agent, so it is REFUSED while any is working: worker
// tasks would be swept to `failed` by boot recovery and their sessions lost,
// and an in-flight analysis / adversarial review / feature plan dies mid-run.
// BOTH kinds count — interactive PTY workers AND headless `claude -p` children,
// which own no PTY and would otherwise slip through the gate entirely.
// `{"force": true}` is the deliberate override (curl / a UI that asked twice).
const restartBody = z.object({ force: z.boolean().optional() }).strict();
app.post('/api/server/restart', async (req, reply) => {
  const { force } = restartBody.parse(req.body ?? {});
  const { running } = await orchestrator.status();
  const headless = liveHeadless();
  const services = commandRunner.running().length;
  if ((running > 0 || headless.length > 0) && !force) {
    const parts = [
      running > 0 ? `${running} agent session(s)` : null,
      headless.length > 0 ? `${headless.length} headless agent(s) (${headless.join(', ')})` : null,
    ].filter(Boolean);
    return reply.code(409).send({
      error: `${parts.join(' and ')} still working — stop them first, or retry with force.`,
      running,
      headless: headless.length,
      services,
    });
  }
  // Dev servers are children of this process: kill them deliberately instead
  // of orphaning them onto the port the restarted server's repos will want.
  // Headless agents only ever exist here on the force path — same reasoning.
  commandRunner.stopAll();
  stopAllHeadless();
  reply.send({ ok: true, restarting: true });
  setTimeout(() => {
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
    // Give the child a moment to start binding, then exit so the port frees.
    setTimeout(() => process.exit(0), 400);
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

// Serve the built SPA when present (production mode).
const webDist = path.resolve(serverRoot, '../web/dist');
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });
}

const stop = async () => {
  // Dev servers and watchers die with us either way; signalling them first is
  // what makes them release their ports before the next boot. Headless agents
  // do NOT die with us — they would keep spending tokens for nobody.
  commandRunner.stopAll();
  stopAllHeadless();
  await app.close();
  await storage.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// 127.0.0.1 only — the terminal WS is a code-execution surface; never expose it.
await app.listen({ port: cfg.port, host: '127.0.0.1' });
console.log(`task-manager listening on http://127.0.0.1:${cfg.port} (storage: ${cfg.storage.driver})`);
