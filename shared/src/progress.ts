/**
 * Approximate progress % of a live task (docs/task-progress.md). Pure: the board
 * row reads it today, and any later surface must read the SAME number, so
 * the bands, the work fraction and the overrun hold all live here.
 *
 * Bands follow the row's own state (the reading `badgeReading()` in
 * `web/src/components/StatusBadge.tsx` makes):
 *   work 0–70 · checks 70–80 · auto-review 80–90 · fixing/landing 90–95 · done 100
 * Hidden (null) wherever a % means nothing: draft, queued, blocked, failed,
 * cancelled, a SETTLED review (it waits on the human) and a paused marker.
 */
import type { Run, Task } from './types.ts';

export type ProgressBand = 'work' | 'checks' | 'auto-review' | 'fixing' | 'landing' | 'done';

/** per-run todo counts read off the agent's latest todo list (ActivityWatcher) */
export interface TodoCounts {
  done: number;
  inProgress: number;
  total: number;
}

/** median / p90 of the per-task worker output-token sum over landed tasks */
export interface TokenLine {
  median: number;
  p90: number;
  /** landed tasks the line was taken over */
  n: number;
}

/** what `GET /api/progress/baseline` answers */
export interface ProgressBaseline {
  /** repoId → that repo's own line (only repos with ≥ PROGRESS_MIN_TASKS) */
  byRepo: Record<string, TokenLine>;
  /** every repo together; null below PROGRESS_MIN_TASKS overall */
  all: TokenLine | null;
  windowDays: number;
  computedAt: string;
}

export interface ProgressSignals {
  /** the task's latest todo list, when the agent keeps one */
  todos?: TodoCounts | null;
  /** sum of `stats.outputTokens` over the task's `mode: 'worker'` runs */
  outputTokens?: number;
  /** a publish turn is live for the task (run label `publish`) */
  publishing?: boolean;
  /**
   * the highest % already shown for this task since it last left a hidden
   * state — the bar never moves backwards (a re-check after a fix round holds
   * the fix band's value; a todo list that grows does not shrink the bar)
   */
  floor?: number | null;
}

export interface TaskProgress {
  /** 0–100, rounded; 100 only once landed */
  pct: number;
  band: ProgressBand;
  /** what the work-band % came from; `stage` = a fixed point of a later band */
  source: 'todos' | 'tokens' | 'loop' | 'stage' | 'done';
  /** past the baseline p90 in the work band: held, shown "longer than usual" */
  overrun: boolean;
  /** one line for the tooltip, e.g. "work · 4/6 todos" */
  detail: string;
}

export const PROGRESS_MIN_TASKS = 10;
export const PROGRESS_WINDOW_DAYS = 90;
/** work band 0–70: the agent is coding */
const WORK_END = 70;
/** the share of a band a held (overrun / all-ticked) reading stops at */
const HOLD = 0.95;
/** fixed in-band points for the stages that have no fraction of their own */
const STAGE_PCT = {
  checksPending: 72,
  checksRunning: 76,
  reviewPending: 82,
  reviewing: 86,
  fixing: 91,
  landing: 95,
} as const;

/** `54123` → `54k` (tooltip text only) */
export function kTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

/** The repo's own line when it has enough landed tasks, else all repos; null below the floor. */
export function tokenLineFor(
  repoId: string | null,
  baseline: ProgressBaseline | null | undefined,
): { line: TokenLine; scope: 'repo' | 'all' } | null {
  if (!baseline) return null;
  const own = repoId ? baseline.byRepo[repoId] : undefined;
  if (own && own.n >= PROGRESS_MIN_TASKS) return { line: own, scope: 'repo' };
  if (baseline.all && baseline.all.n >= PROGRESS_MIN_TASKS) return { line: baseline.all, scope: 'all' };
  return null;
}

/** Piecewise 0 → 0, median → 0.6, p90 → 0.95; above p90 it holds at 0.95 (overrun). */
export function tokenFraction(tokens: number, line: TokenLine): { frac: number; overrun: boolean } {
  const t = Math.max(0, tokens);
  const med = Math.max(1, line.median);
  const p90 = Math.max(med + 1, line.p90);
  if (t > p90) return { frac: HOLD, overrun: true };
  if (t <= med) return { frac: 0.6 * (t / med), overrun: false };
  return { frac: 0.6 + (HOLD - 0.6) * ((t - med) / (p90 - med)), overrun: false };
}

/**
 * Median and nearest-rank p90 of the per-task worker output-token sum over
 * `tasks` (the landed ones in the window), per repo and overall. Pure: the
 * server caches it, a script can check it against a DB copy.
 */
export function progressBaseline(
  tasks: Pick<Task, 'id' | 'repoId' | 'status'>[],
  runs: Pick<Run, 'taskId' | 'mode' | 'stats'>[],
  now = new Date(),
): ProgressBaseline {
  const landed = new Map<string, string | null>();
  for (const t of tasks) if (t.status === 'done' || t.status === 'published') landed.set(t.id, t.repoId);
  const sum = new Map<string, number>();
  for (const r of runs) {
    if (r.mode !== 'worker' || !r.taskId || !landed.has(r.taskId)) continue;
    const out = r.stats?.outputTokens ?? 0;
    sum.set(r.taskId, (sum.get(r.taskId) ?? 0) + out);
  }
  const all: number[] = [];
  const perRepo = new Map<string, number[]>();
  for (const [taskId, tokens] of sum) {
    // a landed task with no output at all (a pre-stats row, a no-op) says nothing about work
    if (!(tokens > 0)) continue;
    all.push(tokens);
    const repo = landed.get(taskId);
    if (repo) perRepo.set(repo, [...(perRepo.get(repo) ?? []), tokens]);
  }
  const byRepo: Record<string, TokenLine> = {};
  for (const [repo, xs] of perRepo) if (xs.length >= PROGRESS_MIN_TASKS) byRepo[repo] = lineOf(xs);
  return {
    byRepo,
    all: all.length >= PROGRESS_MIN_TASKS ? lineOf(all) : null,
    windowDays: PROGRESS_WINDOW_DAYS,
    computedAt: now.toISOString(),
  };
}

function lineOf(xs: number[]): TokenLine {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  const p90 = s[Math.ceil(0.9 * s.length) - 1];
  return { median, p90, n: s.length };
}

type ProgressTask = Pick<
  Task,
  'status' | 'reviewState' | 'checkState' | 'kind' | 'loopState' | 'loopIteration' | 'loopMaxIterations' | 'pausedTurn' | 'repoId'
>;

/**
 * The approximate % for one task, or null when it should show none.
 * Never 100 before the row is done/published; never a later band than the
 * row's state; never below `signals.floor`, capped under 100 while live.
 */
export function taskProgress(
  task: ProgressTask,
  signals: ProgressSignals = {},
  baseline?: ProgressBaseline | null,
): TaskProgress | null {
  const raw = rawProgress(task, signals, baseline);
  if (!raw || raw.band === 'done') return raw;
  const floor = signals.floor ?? 0;
  // a stage reading may only rise to the floor, never past landing's point
  const pct = Math.min(STAGE_PCT.landing, Math.max(raw.pct, Math.min(floor, STAGE_PCT.landing)));
  return { ...raw, pct: Math.round(pct) };
}

function rawProgress(task: ProgressTask, s: ProgressSignals, baseline?: ProgressBaseline | null): TaskProgress | null {
  const stage = (band: ProgressBand, pct: number, detail: string): TaskProgress => ({
    pct,
    band,
    source: 'stage',
    overrun: false,
    detail,
  });
  const { status, reviewState, checkState } = task;
  if (status === 'done' || status === 'published')
    return { pct: 100, band: 'done', source: 'done', overrun: false, detail: status };
  // a Pause-all marker: the turn is suspended and waits on Continue
  if (task.pausedTurn) return null;

  if (status === 'review') {
    if (s.publishing) return stage('landing', STAGE_PCT.landing, 'landing · publish turn');
    if (checkState === 'pending') return stage('checks', STAGE_PCT.checksPending, 'checks · queued');
    if (checkState === 'running') return stage('checks', STAGE_PCT.checksRunning, 'checks · running');
    if (checkState === 'red') return null; // fix rounds spent — the human's
    if (reviewState === 'pending') return stage('auto-review', STAGE_PCT.reviewPending, 'auto-review · queued');
    if (reviewState === 'reviewing') return stage('auto-review', STAGE_PCT.reviewing, 'auto-review · reading the change');
    return null; // a settled review waits on the human
  }

  if (status !== 'running' && status !== 'waiting') return null;

  // the order StatusBadge reads a running row in
  if (status === 'running' && s.publishing) return stage('landing', STAGE_PCT.landing, 'landing · publish turn');
  if (status === 'running' && (checkState === 'red' || checkState === 'running'))
    return stage('fixing', STAGE_PCT.fixing, 'fixing checks');
  if (status === 'running' && reviewState === 'fixing') return stage('fixing', STAGE_PCT.fixing, "fixing the reviewer's findings");

  if (task.kind === 'loop') {
    const max = task.loopMaxIterations ?? 0;
    if (max > 0) {
      const iter = Math.max(0, Math.min(max, task.loopIteration));
      // an iteration counts once it has ended (its checks running or the next one queued)
      const ended = task.loopState === 'checking' || task.loopState === 'next' ? iter : Math.max(0, iter - 1);
      const frac = Math.min(HOLD, ended / max);
      return {
        pct: WORK_END * frac,
        band: 'work',
        source: 'loop',
        overrun: false,
        detail: `loop · iteration ${Math.max(1, iter)}/${max}`,
      };
    }
  }

  const todos = s.todos;
  if (todos && todos.total >= 2) {
    const frac = Math.min(HOLD, Math.max(0, (todos.done + 0.5 * todos.inProgress) / todos.total));
    return {
      pct: WORK_END * frac,
      band: 'work',
      source: 'todos',
      overrun: false,
      detail: `work · ${todos.done}/${todos.total} todos`,
    };
  }

  const pick = tokenLineFor(task.repoId, baseline);
  if (!pick) return null; // no baseline yet: no honest number to show
  const tokens = s.outputTokens ?? 0;
  const { frac, overrun } = tokenFraction(tokens, pick.line);
  const scope = pick.scope === 'repo' ? 'repo median' : 'all-repo median';
  return {
    pct: WORK_END * frac,
    band: 'work',
    source: 'tokens',
    overrun,
    detail: `work · ${kTokens(tokens)} of ~${kTokens(pick.line.median)} tokens (${scope})${overrun ? ' · longer than usual' : ''}`,
  };
}
