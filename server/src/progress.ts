import { PROGRESS_WINDOW_DAYS, progressBaseline, type ProgressBaseline } from '@tm/shared';
import type { Storage } from './storage/types.ts';

/**
 * The repo token baselines the board's work % reads (docs/task-progress.md
 * § Baseline): median + p90 of the per-task worker output-token sum over the
 * done/published tasks of the last PROGRESS_WINDOW_DAYS, per repo and over all
 * repos. Recomputed at most hourly, like the `cost-high` line in anomalies.ts —
 * a baseline moves over weeks, never between two board renders.
 */
const TTL_MS = 3600_000;
let cache: { at: number; value: ProgressBaseline } | null = null;
let inFlight: Promise<ProgressBaseline> | null = null;

export async function progressBaselineCached(storage: Storage, now = Date.now()): Promise<ProgressBaseline> {
  if (cache && now - cache.at < TTL_MS) return cache.value;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const since = new Date(now - PROGRESS_WINDOW_DAYS * 24 * 3600_000).toISOString();
    // progressBaseline keeps only done/published
    const tasks = await storage.listTasks({ updatedSince: since });
    // every worker run: a task landed this month may have started its first run last quarter
    const runs = await storage.listRuns({ mode: 'worker' });
    const value = progressBaseline(tasks, runs, new Date(now));
    cache = { at: now, value };
    return value;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
