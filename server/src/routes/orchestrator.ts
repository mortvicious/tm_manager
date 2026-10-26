import type { FastifyInstance } from 'fastify';
import { usageSnapshot } from '../claude/usage.ts';
import type { Orchestrator } from '../orchestrator.ts';
import type { Storage } from '../storage/types.ts';

export function registerOrchestratorRoutes(app: FastifyInstance, storage: Storage, orch: Orchestrator) {
  app.get('/api/orchestrator', async () => orch.status());

  // The assembly moved to claude/usage.ts so the Telegram bot's /status can
  // call it in-process instead of re-deriving the same three windows.
  app.get('/api/usage', async () => usageSnapshot(storage));

  app.post('/api/orchestrator/start', async () => {
    await orch.setEnabled(true);
    return orch.status();
  });

  app.post('/api/orchestrator/stop', async () => {
    // Stop picking new tasks; live sessions keep running.
    await orch.setEnabled(false);
    return orch.status();
  });

  // Pause all / Continue (docs/pause.md). Browser actions: a worker's curl
  // carries no Origin, and an agent must not be able to pause (and so kill)
  // every other session, nor un-pause a machine the human stopped.
  app.post('/api/orchestrator/pause', async (req, reply) => {
    if (!req.headers.origin) return reply.code(403).send({ error: 'Pause all is a browser action (Origin required)' });
    // `suspend: false` = drain (docs/pause.md § Drain): the flag only, live
    // turns finish on their own. `by: 'rebuild'` is the front door's
    // Rebuild & restart job (it calls with its loopback Origin) — an audit
    // label, nothing more.
    const body = (req.body ?? {}) as { suspend?: unknown; by?: unknown };
    const actor = body.by === 'rebuild' ? 'rebuild' : 'human';
    const { suspended, already } = await orch.pauseAll(actor, { suspend: body.suspend !== false });
    return { ...(await orch.status()), suspended, wasPaused: already };
  });

  app.post('/api/orchestrator/continue', async (req, reply) => {
    if (!req.headers.origin) return reply.code(403).send({ error: 'Continue is a browser action (Origin required)' });
    const body = (req.body ?? {}) as { by?: unknown };
    const { resumed, waiting } = await orch.continueAll(body.by === 'rebuild' ? 'rebuild' : 'human');
    return { ...(await orch.status()), resumed, waiting };
  });

  app.post('/api/orchestrator/stop-and-kill', async () => {
    await orch.setEnabled(false);
    const running = await storage.listRuns({ status: 'running', mode: 'worker' });
    for (const run of running) await orch.killRun(run.id);
    return orch.status();
  });
}
