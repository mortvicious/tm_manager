import type { FastifyInstance } from 'fastify';
import { estimateUsagePct } from '../claude/usage.ts';
import type { Orchestrator } from '../orchestrator.ts';
import type { Storage } from '../storage/types.ts';

export function registerOrchestratorRoutes(app: FastifyInstance, storage: Storage, orch: Orchestrator) {
  app.get('/api/orchestrator', async () => orch.status());

  app.get('/api/usage', async () => {
    const s = await storage.getSettings();
    const pct = await estimateUsagePct(s['router.budget5hTokens']);
    const belowThreshold = pct < s['router.usageThresholdPct'];
    return {
      pct: Math.round(pct * 10) / 10,
      threshold: s['router.usageThresholdPct'],
      routedModel: s['router.enabled']
        ? belowThreshold
          ? s['router.primaryModel']
          : s['router.fallbackModel']
        : s['agent.model'],
    };
  });

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
