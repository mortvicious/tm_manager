import { durationBaseline, PROGRESS_WINDOW_DAYS, type ScheduleBaseline } from '@tm/shared';
import type { Storage } from './storage/types.ts';

/**
 * The duration baseline schedule ETAs read (docs/schedule.md § Baseline):
 * worked / review / check time over the done/published tasks of the last
 * PROGRESS_WINDOW_DAYS, per repo and over all repos. Recomputed at most
 * hourly with one in-flight read, like `progressBaselineCached` — a baseline
 * moves over weeks, never between two renders.
 */
const TTL_MS = 3600_000;
/** listEvents' own ceiling; one row per run / per check stage stays well under it */
const EVENT_LIMIT = 2000;
let cache: { at: number; value: ScheduleBaseline } | null = null;
let inFlight: Promise<ScheduleBaseline> | null = null;

export async function scheduleBaselineCached(storage: Storage, now = Date.now()): Promise<ScheduleBaseline> {
  if (cache && now - cache.at < TTL_MS) return cache.value;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const since = new Date(now - PROGRESS_WINDOW_DAYS * 24 * 3600_000).toISOString();
    // durationBaseline keeps only done/published
    const tasks = await storage.listTasks({ updatedSince: since });
    const landed = new Set(tasks.filter((t) => t.status === 'done' || t.status === 'published').map((t) => t.id));
    const [workerRuns, reviewRuns] = await Promise.all([
      // every worker run: a task landed this month may have started its first run last quarter
      storage.listRuns({ mode: 'worker' }),
      storage.listRuns({ kind: 'review' }),
    ]);
    const runs = [
      ...workerRuns.filter((r) => r.taskId && landed.has(r.taskId)),
      ...reviewRuns.filter((r) => r.subjectId && landed.has(r.subjectId)),
    ];
    // stats-finals by kind, back to the oldest run they can belong to (not the whole log)
    const oldest = runs.reduce((m, r) => (r.startedAt < m ? r.startedAt : m), since);
    const [statsFinals, checked] = await Promise.all([
      storage.listEvents({ kind: 'run.stats-final', since: oldest, limit: EVENT_LIMIT }),
      storage.listEvents({ kind: 'task.checked', since: oldest, limit: EVENT_LIMIT }),
    ]);
    const value = durationBaseline(tasks, runs, [...statsFinals, ...checked], new Date(now));
    cache = { at: now, value };
    return value;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
