/**
 * Duration baselines for schedule ETAs (docs/schedule.md § Baseline). Pure: the
 * server caches it (`server/src/schedule-baseline.ts`), and any surface that
 * predicts "when will this land" must read the SAME figures.
 *
 * Over the done/published tasks of the last PROGRESS_WINDOW_DAYS:
 *  - work  = per task, the sum over its `mode: 'worker'` runs of WORKED time
 *            (`runWorkedMs`: start → first `run.stats-final`, else exit) — never
 *            wall time, so a session left idle in review for hours adds nothing
 *  - review = per adversarial-review aux run (`kind: 'review'`, subject = the
 *            task), startedAt → endedAt
 *  - check  = per check stage (`task.checked` row with `results`), the sum of
 *            its checks' `durationMs` (they run serially)
 * Per repo once it has PROGRESS_MIN_TASKS landed tasks with worked time,
 * otherwise the caller falls back to `all` (`scheduleLineFor`).
 */
import { PROGRESS_MIN_TASKS, PROGRESS_WINDOW_DAYS } from './progress.ts';
import type { AuditEvent, Run, Task } from './types.ts';

export interface DurationLine {
  /** per-task worked time of landed tasks */
  workMs: { median: number; p75: number };
  /** median review round (aux `review` run); null when none ran */
  reviewMs: number | null;
  /** median check stage; null when none ran */
  checkMs: number | null;
  /** landed tasks with worked time the line was taken over */
  n: number;
}

/** what `GET /api/schedule/baseline` answers */
export interface ScheduleBaseline {
  /** repoId → that repo's own line (only repos with ≥ PROGRESS_MIN_TASKS) */
  byRepo: Record<string, DurationLine>;
  /** every repo together; null below PROGRESS_MIN_TASKS overall */
  all: DurationLine | null;
  windowDays: number;
  computedAt: string;
}

/**
 * Worked time of one run: start → first idle (the `run.stats-final` event's
 * `at`) or exit, else `now` while it is still live (dashboard review A3).
 */
export function runWorkedMs(
  run: { startedAt: string; endedAt: string | null },
  idleAt: string | undefined,
  now = Date.now(),
): number {
  const start = Date.parse(run.startedAt);
  const end = idleAt ? Date.parse(idleAt) : run.endedAt ? Date.parse(run.endedAt) : now;
  return Math.max(0, end - start);
}

/** runId → the EARLIEST `run.stats-final` `at` (the first idle) */
export function firstIdleByRun(statsFinals: Pick<AuditEvent, 'runId' | 'at'>[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of statsFinals) {
    if (!e.runId) continue;
    const prev = out.get(e.runId);
    if (!prev || Date.parse(e.at) < Date.parse(prev)) out.set(e.runId, e.at);
  }
  return out;
}

export function durationBaseline(
  tasks: Pick<Task, 'id' | 'repoId' | 'status'>[],
  runs: Pick<Run, 'id' | 'taskId' | 'mode' | 'kind' | 'subjectId' | 'startedAt' | 'endedAt'>[],
  events: Pick<AuditEvent, 'kind' | 'runId' | 'taskId' | 'at' | 'data'>[],
  now = new Date(),
): ScheduleBaseline {
  const landed = new Map<string, string | null>();
  for (const t of tasks) if (t.status === 'done' || t.status === 'published') landed.set(t.id, t.repoId);
  const idleAt = firstIdleByRun(events.filter((e) => e.kind === 'run.stats-final'));

  const worked = new Map<string, number>();
  const reviews: { repo: string | null; ms: number }[] = [];
  for (const r of runs) {
    if (r.mode === 'worker') {
      if (!r.taskId || !landed.has(r.taskId)) continue;
      worked.set(r.taskId, (worked.get(r.taskId) ?? 0) + runWorkedMs(r, idleAt.get(r.id), now.getTime()));
    } else if (r.kind === 'review' && r.subjectId && landed.has(r.subjectId) && r.endedAt) {
      // a still-live (or crash-orphaned, endedAt null) round says nothing yet
      reviews.push({ repo: landed.get(r.subjectId) ?? null, ms: Math.max(0, Date.parse(r.endedAt) - Date.parse(r.startedAt)) });
    }
  }

  const checks: { repo: string | null; ms: number }[] = [];
  for (const e of events) {
    if (e.kind !== 'task.checked' || !e.taskId || !landed.has(e.taskId)) continue;
    // skipped stages (empty/unchanged diff, taken over) carry no results: no time spent
    const results = (e.data as { results?: unknown } | null)?.results;
    if (!Array.isArray(results) || !results.length) continue;
    const ms = results.reduce((s: number, x) => s + (Number((x as { durationMs?: unknown })?.durationMs) || 0), 0);
    if (ms > 0) checks.push({ repo: landed.get(e.taskId) ?? null, ms });
  }

  const allWork: number[] = [];
  const workByRepo = new Map<string, number[]>();
  for (const [taskId, ms] of worked) {
    // a landed task with no worked time (a pre-stats row, a no-op) says nothing
    if (!(ms > 0)) continue;
    allWork.push(ms);
    const repo = landed.get(taskId);
    if (repo) workByRepo.set(repo, [...(workByRepo.get(repo) ?? []), ms]);
  }
  const msOf = (xs: { repo: string | null; ms: number }[], repo?: string) =>
    xs.filter((x) => repo === undefined || x.repo === repo).map((x) => x.ms);
  const lineOf = (work: number[], repo?: string): DurationLine => ({
    workMs: { median: quantile(work, 0.5), p75: quantile(work, 0.75) },
    reviewMs: medianOrNull(msOf(reviews, repo)),
    checkMs: medianOrNull(msOf(checks, repo)),
    n: work.length,
  });

  const byRepo: Record<string, DurationLine> = {};
  for (const [repo, xs] of workByRepo) if (xs.length >= PROGRESS_MIN_TASKS) byRepo[repo] = lineOf(xs, repo);
  return {
    byRepo,
    all: allWork.length >= PROGRESS_MIN_TASKS ? lineOf(allWork) : null,
    windowDays: PROGRESS_WINDOW_DAYS,
    computedAt: now.toISOString(),
  };
}

/** the repo's own line, else the all-repos fallback (null: no baseline yet) */
export function scheduleLineFor(b: ScheduleBaseline, repoId: string | null | undefined): DurationLine | null {
  return (repoId && b.byRepo[repoId]) || b.all;
}

/** median (mean of the two middles) at q = 0.5, nearest rank otherwise */
function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (q === 0.5) {
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  return s[Math.max(0, Math.ceil(q * s.length) - 1)];
}

function medianOrNull(xs: number[]): number | null {
  return xs.length ? quantile(xs, 0.5) : null;
}
