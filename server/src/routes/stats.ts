import type { FastifyInstance } from 'fastify';
import type { Anomaly, AuditEvent, StatsOverview } from '@tm/shared';
import type { Orchestrator } from '../orchestrator.ts';
import type { SessionManager } from '../pty/session-manager.ts';
import type { Storage } from '../storage/types.ts';

// Aggregates come from the base tables wherever they can (permanent truth);
// the event log answers only what they cannot: per-day done/failed, byActor,
// attention counts, overflow claims (dashboard review Q4/A1).
// All day bucketing happens in JS on SERVER-LOCAL time — SQL date() on UTC
// would split Baku evenings across two bars (review Q5).

const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** workedMs for a run: start → first-idle (stats-final event) or exit (review A3). */
function runWorkedMs(run: { startedAt: string; endedAt: string | null }, idleAt: string | undefined): number {
  const start = Date.parse(run.startedAt);
  const end = idleAt ? Date.parse(idleAt) : run.endedAt ? Date.parse(run.endedAt) : Date.now();
  return Math.max(0, end - start);
}

export function registerStatsRoutes(
  app: FastifyInstance,
  storage: Storage,
  sessions: SessionManager,
  orchestrator: Orchestrator,
) {
  void orchestrator;

  app.get('/api/stats/overview', async (req) => {
    const q = req.query as { days?: string };
    const days = Math.min(Math.max(Number(q.days) || 14, 1), 90);
    // Anchor at LOCAL midnight of the window's first day — a wall-clock
    // cutoff would admit runs whose dayKey precedes the first seeded bucket,
    // inflating tiles invisibly (dashboard impl W1).
    const anchor = new Date();
    anchor.setHours(0, 0, 0, 0);
    anchor.setDate(anchor.getDate() - (days - 1));
    const sinceMs = anchor.getTime();
    const since = new Date(sinceMs).toISOString();

    // Per-kind queries: one mixed stream truncates at the limit and silently
    // drops the OLDEST events — per-kind volumes stay well under it (W2).
    const [runs, tasks, repos, transitions, statsFinals, attention, agentCreates, allForActors] =
      await Promise.all([
        storage.listRuns(),
        storage.listTasks(),
        storage.listRepos(),
        storage.listEvents({ kind: 'task.transition', since, limit: 2000 }),
        storage.listEvents({ kind: 'run.stats-final', since, limit: 2000 }),
        storage.listEvents({ kind: 'run.attention', since, limit: 2000 }),
        storage.listEvents({ kind: 'agent.create', since, limit: 2000 }),
        storage.listEvents({ since, limit: 2000 }), // byActor only; newest-biased truncation acceptable
      ]);
    const windowRuns = runs.filter((r) => Date.parse(r.startedAt) >= sinceMs);

    // first-idle timestamps from stats-final events (≤1 per run by dedupe;
    // DESC order + !has() keeps the newest if that ever changes)
    const idleAtByRun = new Map<string, string>();
    for (const e of statsFinals) {
      if (e.runId && !idleAtByRun.has(e.runId)) idleAtByRun.set(e.runId, e.at);
    }

    const totals = {
      workedMs: 0,
      costUsd: 0,
      tokens: 0,
      runs: windowRuns.length,
      tasksDone: 0,
      tasksFailed: 0,
      avgCtxPct: 0,
      maxCtxPct: 0,
      attentionEvents: 0,
      agentFiledTasks: 0,
      overflowClaims: 0,
    };
    const perDayMap = new Map<
      string,
      { date: string; workerRuns: number; analyzeRuns: number; workedMs: number; costUsd: number; done: number; failed: number }
    >();
    for (let i = days - 1; i >= 0; i--) {
      const key = dayKey(new Date(Date.now() - i * 24 * 3600 * 1000).toISOString());
      perDayMap.set(key, { date: key, workerRuns: 0, analyzeRuns: 0, workedMs: 0, costUsd: 0, done: 0, failed: 0 });
    }

    const perRepoMap = new Map<string, { repoId: string; name: string; runs: number; costUsd: number; done: number; failed: number }>();
    for (const r of repos) perRepoMap.set(r.id, { repoId: r.id, name: r.name, runs: 0, costUsd: 0, done: 0, failed: 0 });
    const perModelMap = new Map<string, { model: string; runs: number; costUsd: number; tokens: number }>();

    let ctxSum = 0;
    let ctxN = 0;
    for (const run of windowRuns) {
      const worked = runWorkedMs(run, idleAtByRun.get(run.id));
      const cost = run.stats?.costUsd ?? 0;
      const tokens = (run.stats?.inputTokens ?? 0) + (run.stats?.outputTokens ?? 0);
      totals.workedMs += worked;
      totals.costUsd += cost;
      totals.tokens += tokens;
      if (run.stats) {
        ctxSum += run.stats.contextPct;
        ctxN++;
        totals.maxCtxPct = Math.max(totals.maxCtxPct, run.stats.contextPct);
      }
      const day = perDayMap.get(dayKey(run.startedAt));
      if (day) {
        if (run.mode === 'worker') day.workerRuns++;
        else day.analyzeRuns++;
        day.workedMs += worked;
        day.costUsd += cost;
      }
      if (run.repoId) {
        const repo = perRepoMap.get(run.repoId);
        if (repo) {
          repo.runs++;
          repo.costUsd += cost;
        }
      }
      const model = run.model ?? 'unknown';
      const m = perModelMap.get(model) ?? { model, runs: 0, costUsd: 0, tokens: 0 };
      m.runs++;
      m.costUsd += cost;
      m.tokens += tokens;
      perModelMap.set(model, m);
    }
    totals.avgCtxPct = ctxN ? ctxSum / ctxN : 0;

    // events answer done/failed history + actor/attention/overflow counts
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const byActorMap = new Map<string, number>();
    for (const e of allForActors) byActorMap.set(e.actor, (byActorMap.get(e.actor) ?? 0) + 1);
    totals.attentionEvents = attention.length;
    totals.agentFiledTasks = agentCreates.length;
    for (const e of transitions) {
      const to = (e.data as any)?.to;
      const claim = (e.data as any)?.claim;
      if (claim === 'overflow') totals.overflowClaims++;
      const day = perDayMap.get(dayKey(e.at));
      if (day && to === 'done') {
        day.done++;
        totals.tasksDone++;
      }
      if (day && to === 'failed') {
        day.failed++;
        totals.tasksFailed++;
      }
      const t = e.taskId ? taskById.get(e.taskId) : undefined;
      if (t?.repoId) {
        const repo = perRepoMap.get(t.repoId);
        if (repo && to === 'done') repo.done++;
        if (repo && to === 'failed') repo.failed++;
      }
    }

    const depthMap = new Map<number, number>();
    for (const t of tasks) depthMap.set(t.spawnDepth, (depthMap.get(t.spawnDepth) ?? 0) + 1);

    const overview: StatsOverview = {
      totals: {
        ...totals,
        avgCtxPct: Math.round(totals.avgCtxPct * 10) / 10,
        costUsd: Math.round(totals.costUsd * 100) / 100,
      },
      perDay: [...perDayMap.values()],
      perRepo: [...perRepoMap.values()].filter((r) => r.runs > 0 || r.done > 0 || r.failed > 0),
      perModel: [...perModelMap.values()].sort((a, b) => b.costUsd - a.costUsd),
      depth: [...depthMap.entries()].map(([depth, count]) => ({ depth, count })).sort((a, b) => a.depth - b.depth),
      byActor: [...byActorMap.entries()].map(([actor, events]) => ({ actor, events })).sort((a, b) => b.events - a.events),
    };
    return overview;
  });

  app.get('/api/stats/anomalies', async () => {
    const settings = await storage.getSettings();
    const longRunMs = settings['anomaly.longRunMin'] * 60_000;
    const costCap = settings['anomaly.costUsd'];
    const staleReviewMs = settings['anomaly.staleReviewHours'] * 3600_000;
    const nowMs = Date.now();
    const anomalies: Anomaly[] = [];

    const [runs, tasks] = await Promise.all([storage.listRuns(), storage.listTasks()]);

    // context/cost rules fire only for live runs or runs ended in the last
    // 24h — every historical crossing would otherwise sit on the panel
    // forever and drown real findings (dashboard impl R2).
    const recentOrLive = (run: (typeof runs)[number]) =>
      (run.status === 'running' && !run.idle) ||
      (run.endedAt != null && nowMs - Date.parse(run.endedAt) < 24 * 3600_000);
    for (const run of runs) {
      if (run.status === 'running' && !run.idle) {
        const s = sessions.get(run.id);
        const alive = s !== undefined && s.exit === null;
        const ageMs = nowMs - Date.parse(run.startedAt);
        if (alive && ageMs > longRunMs) {
          anomalies.push({
            severity: 'warn',
            kind: 'long-run',
            message: `run has been working ${Math.round(ageMs / 60000)} min without finishing`,
            runId: run.id,
            taskId: run.taskId ?? undefined,
          });
        }
      }
      if (!recentOrLive(run)) continue;
      if ((run.stats?.contextPct ?? 0) > 80) {
        anomalies.push({
          severity: 'warn',
          kind: 'context-high',
          message: `context window ${Math.round(run.stats!.contextPct)}% full — agent quality degrades near the limit`,
          runId: run.id,
          taskId: run.taskId ?? undefined,
        });
      }
      if ((run.stats?.costUsd ?? 0) > costCap) {
        anomalies.push({
          severity: 'critical',
          kind: 'cost-high',
          message: `run cost $${run.stats!.costUsd.toFixed(2)} exceeds the $${costCap} threshold`,
          runId: run.id,
          taskId: run.taskId ?? undefined,
        });
      }
    }

    // repeat failures via event history (30d window — with retention cut,
    // unbounded history would resurface ancient failures forever)
    const failEvents = await storage.listEvents({
      kind: 'task.transition',
      limit: 2000,
      since: new Date(nowMs - 30 * 24 * 3600_000).toISOString(),
    });
    const failCounts = new Map<string, number>();
    for (const e of failEvents) {
      if ((e.data as any)?.to === 'failed' && e.taskId) {
        failCounts.set(e.taskId, (failCounts.get(e.taskId) ?? 0) + 1);
      }
    }
    for (const [taskId, n] of failCounts) {
      if (n >= 2) {
        anomalies.push({
          severity: 'warn',
          kind: 'repeat-failure',
          message: `task failed ${n} times`,
          taskId,
        });
      }
    }

    const queuedSinceMs = 30 * 60_000;
    const settingsEnabled = settings['orchestrator.enabled'];
    for (const t of tasks) {
      if (t.status === 'review' && nowMs - Date.parse(t.updatedAt) > staleReviewMs) {
        anomalies.push({
          severity: 'info',
          kind: 'stale-review',
          message: `in review for ${Math.round((nowMs - Date.parse(t.updatedAt)) / 3600_000)}h — waiting on you`,
          taskId: t.id,
        });
      }
      if (t.createdByRun && t.status === 'draft' && nowMs - Date.parse(t.createdAt) > 7 * 24 * 3600_000) {
        anomalies.push({
          severity: 'warn',
          kind: 'untriaged-agent-draft',
          message: `agent-filed draft untouched for ${Math.round((nowMs - Date.parse(t.createdAt)) / (24 * 3600_000))}d`,
          taskId: t.id,
        });
      }
      if (t.status === 'queued' && settingsEnabled && nowMs - Date.parse(t.updatedAt) > queuedSinceMs) {
        anomalies.push({
          severity: 'critical',
          kind: 'starved-queue',
          message: `queued ${Math.round((nowMs - Date.parse(t.updatedAt)) / 60_000)} min with the queue running — check for stuck sessions`,
          taskId: t.id,
        });
      }
      if (t.spawnDepth >= 2) {
        anomalies.push({
          severity: 'info',
          kind: 'max-depth',
          message: `depth-2 task (agent chain at the cap) — worth a look at what agents are delegating`,
          taskId: t.id,
        });
      }
    }

    const recovery = await storage.listEvents({ kind: 'boot.recovery', limit: 10, since: new Date(nowMs - 24 * 3600_000).toISOString() });
    for (const e of recovery) {
      anomalies.push({
        severity: 'warn',
        kind: 'boot-recovery',
        message: `server restarted mid-run and swept ${(e.data as any)?.swept ?? '?'} run(s)`,
        at: e.at,
      });
    }

    const order = { critical: 0, warn: 1, info: 2 } as const;
    anomalies.sort((a, b) => order[a.severity] - order[b.severity]);
    return anomalies;
  });

  app.get('/api/events', async (req) => {
    const q = req.query as { kind?: any; actor?: string; taskId?: string; limit?: string };
    const events: AuditEvent[] = await storage.listEvents({
      kind: q.kind,
      actor: q.actor,
      taskId: q.taskId,
      limit: Math.min(Number(q.limit) || 50, 500),
    });
    return events;
  });
}
