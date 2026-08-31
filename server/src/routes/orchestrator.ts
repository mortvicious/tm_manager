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

  app.post('/api/orchestrator/stop-and-kill', async () => {
    await orch.setEnabled(false);
    const running = await storage.listRuns({ status: 'running', mode: 'worker' });
    for (const run of running) await orch.killRun(run.id);
    return orch.status();
  });
}
