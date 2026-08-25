import type { FastifyInstance } from 'fastify';
import { liveWindow, readAccountUsage, type AccountWindow } from '../claude/account-usage.ts';
import { estimateUsage, pctOf } from '../claude/usage.ts';
import type { UsageWindow } from '@tm/shared';
import type { Orchestrator } from '../orchestrator.ts';
import type { Storage } from '../storage/types.ts';

export function registerOrchestratorRoutes(app: FastifyInstance, storage: Storage, orch: Orchestrator) {
  app.get('/api/orchestrator', async () => orch.status());

  const round1 = (n: number) => Math.round(n * 10) / 10;

  /**
   * Real account utilization wins; the transcript estimate is the fallback for
   * a window the CLI never cached or whose reset time has already passed.
   */
  const window = (account: AccountWindow | null, tokens: number, budget: number): UsageWindow => {
    const live = liveWindow(account);
    if (live) {
      return { pct: round1(live.percent), source: 'account', resetsAt: live.resetsAt, tokens: null, budget: null };
    }
    return { pct: round1(pctOf(tokens, budget)), source: 'estimate', resetsAt: null, tokens, budget };
  };

  app.get('/api/usage', async () => {
    const s = await storage.getSettings();
    const u = await estimateUsage();
    const acct = readAccountUsage();
    const fiveHour = window(acct?.session ?? null, u.fiveHourTokens, s['router.budget5hTokens']);
    const week = window(acct?.weekly ?? null, u.weekTokens, s['router.budgetWeekTokens']);
    const weekFable = window(acct?.weeklyFable ?? null, u.weekFableTokens, s['router.budgetWeekFableTokens']);
    // Routing compares against the session/5h window only — the weekly figures
    // are reporting, not an input to model selection.
    const belowThreshold = fiveHour.pct < s['router.usageThresholdPct'];
    return {
      pct: fiveHour.pct,
      threshold: s['router.usageThresholdPct'],
      routedModel: s['router.enabled']
        ? belowThreshold
          ? s['router.primaryModel']
          : s['router.fallbackModel']
        : s['agent.model'],
      fiveHour,
      week,
      weekFable,
      // Only meaningful when at least one window actually used the account data.
      accountAgeMs:
        [fiveHour, week, weekFable].some((w) => w.source === 'account') && acct ? acct.ageMs : null,
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
