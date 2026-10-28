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
import { PROGRESS_MIN_TASKS, PROGRESS_WINDOW_DAYS, PROGRESS_WORK_END } from './progress.ts';
// Values from types.ts are read only inside functions: types.ts re-exports this
// module, so a top-level use would meet them uninitialised.
import {
  compareClaimOrder,
  customQueueHoldsRepo,
  customQueueWaiting,
  effectiveLanding,
  holdsRepoForClaim,
  isFeatureTaskBlocking,
  repoHasRoom,
  repoParallelCap,
  verifyOpen,
  CHECK_BUSY_STATES,
  REVIEW_BUSY_STATES,
} from './types.ts';
import type { AppSettings, AuditEvent, Feature, Repo, Run, Task } from './types.ts';

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

// ---------------------------------------------------------------------------
// The schedule simulator (docs/schedule.md § Simulator)
//
// `predictSchedule` replays `Orchestrator.maybeSchedule` (server/src/
// orchestrator.ts) over VIRTUAL time: at every instant something changes — a
// predicted work segment ends, a review/check round settles, a wake-up falls
// due — it runs one claim pass in the server's own order and starts what that
// pass would start. Every gate is the server's JS twin run over mutable copies
// of the task rows, so a predicted landing frees a repo, or opens a feature
// phase, exactly where the real row write would:
//   1. Pause all → nothing starts (no verify round settles either)
//   2. paused-turn markers resume first, oldest marker first, within the cap
//   3. the custom-queue pump (regardless of `orchestrator.enabled`): FIFO by
//      `customQueueWaiting`, `CUSTOM_QUEUE_HEAD_WHERE` (members' `heldBy`, an
//      agent-filed member's filer), `repoBusy`, `queue_held_at` skipped
//   4. loop iterations due (`loop_state = 'next'`), oldest first, within the cap
//   5. queue on only: the global claim in `compareClaimOrder` order, gated by
//      `REPO_EXCLUSIVE_GATE` (`holdsRepoForClaim` + `repoHasRoom`) and
//      `FEATURE_CLAIM_GATE` (`isFeatureTaskBlocking`), push-failing repos out
//   6. queue on only: the overflow claim for children of live worker runs
//   then the 30 s wake sweep (`wakeDue`, only with `agent.autoWake`): due
//   wake-ups within the cap, the queue switch holding non-members.
// Steps 3–6 also stop at the day budget fuse. A twin edit on the server side
// must move this simulator with it (the SQL comments point here).

export type ScheduleSource = 'resume' | 'custom-queue' | 'loop' | 'global' | 'overflow' | 'wake' | 'running';

export type ScheduleWaitCode =
  | 'paused'
  | 'draft'
  | 'blocked'
  | 'held'
  | 'no-repo'
  | 'queue-off'
  | 'day-budget'
  | 'push-failing'
  | 'feature'
  | 'phase'
  | 'repo'
  | 'filer'
  | 'cap'
  | 'wake';

/** why a task did not start (yet): a code for the UI, words for the human */
export interface ScheduleWait {
  code: ScheduleWaitCode;
  /** e.g. "waits for nest: Fix login in review round", "queue off", "phase 2 after phase 1" */
  text: string;
}

/** a predicted stretch after the work segment that holds the repo but no worker lane */
export interface ScheduleAfter {
  kind: 'checks' | 'review' | 'publish';
  start: string;
  end: string;
}

export interface ScheduledSlot {
  scheduled: true;
  taskId: string;
  repoId: string | null;
  /** worker lane, 0-based; null = no worker session (a verify round already open, a land marker) */
  lane: number | null;
  /** the work segment: when the session starts / is predicted to stop */
  start: string;
  end: string;
  source: ScheduleSource;
  /** checks → review → publish, in order, as each would run after `end` */
  after: ScheduleAfter[];
  /** where the row is predicted to stand when the last segment ends */
  lands: 'review' | 'done' | 'published';
  /** what held it back before `start`, oldest first (empty: starts now) */
  waits: ScheduleWait[];
}

export interface UnscheduledSlot {
  scheduled: false;
  taskId: string;
  repoId: string | null;
  lane: null;
  start: null;
  end: null;
  source: null;
  after: [];
  lands: null;
  /** never empty; the last entry is what it still waits for */
  waits: ScheduleWait[];
}

export type PredictedSlot = ScheduledSlot | UnscheduledSlot;

/** a live run, as `GET /api/runs?status=running` lists it */
export type ScheduleRun = Pick<Run, 'id' | 'taskId' | 'startedAt' | 'label' | 'mode'> &
  Partial<Pick<Run, 'kind' | 'subjectId' | 'idle'>>;

export interface ScheduleInput {
  /** every task the board holds (terminal ones too: they settle feature phases) */
  tasks: readonly Task[];
  repos: readonly Pick<Repo, 'id' | 'name' | 'parallel' | 'delivery' | 'landing'>[];
  features: readonly Pick<Feature, 'id' | 'title' | 'status'>[];
  settings: Pick<AppSettings, 'orchestrator.enabled' | 'orchestrator.paused' | 'orchestrator.concurrency'> &
    Partial<Pick<AppSettings, 'review.enabled' | 'agent.autoWake'>>;
  /** the LIVE runs (worker and aux); a worker run's start is the elapsed time of the turn */
  runs: readonly ScheduleRun[];
  /** taskId → `taskProgress(...).pct` for running tasks */
  progress?: Readonly<Record<string, number | null | undefined>>;
  /** `GET /api/schedule/baseline`; null → SCHEDULE_DEFAULT_LINE */
  baseline?: ScheduleBaseline | null;
  /** `OrchestratorStatus.pushHealth` repos with `ok: false` (auth/protected hold the repo) */
  pushFailing?: readonly string[];
  /** `budget.dayUsd` spent for today: nothing new is claimed */
  dayBudgetReached?: boolean;
  /** repoId → the names of its check commands (`isCheck`); absent = no checks */
  repoChecks?: Readonly<Record<string, readonly string[]>>;
  /** runId → taskId for the `createdByRun` ids the tasks name (live worker runs are known already) */
  runTaskIds?: Readonly<Record<string, string>>;
  now: string | number | Date;
}

const MIN = 60_000;
/** used when no baseline exists yet (fewer than PROGRESS_MIN_TASKS landed tasks overall) */
export const SCHEDULE_DEFAULT_LINE: DurationLine = {
  workMs: { median: 20 * MIN, p75: 35 * MIN },
  reviewMs: 8 * MIN,
  checkMs: 4 * MIN,
  n: 0,
};
/** a publish turn / a worktree land (no baseline of their own) */
export const SCHEDULE_PUBLISH_MS = 3 * MIN;
/** a wake-up resumes this long after `wake_at` (the CLI's own continue jitter, the 30 s sweep) */
export const SCHEDULE_WAKE_DELAY_MS = 90_000;
/** no live segment is predicted to end sooner than this */
const MIN_REMAINING_MS = MIN;

/**
 * The work segment the simulator predicts for a fresh turn of a task in this
 * repo: the repo's (else all repos', else the default) median worked time.
 * Exported so the accuracy replay (schedule-accuracy.ts) scores the SAME figure.
 */
export function scheduleWorkMs(baseline: ScheduleBaseline | null | undefined, repoId: string | null): number {
  const line = (baseline ? scheduleLineFor(baseline, repoId) : null) ?? SCHEDULE_DEFAULT_LINE;
  return Math.max(MIN_REMAINING_MS, line.workMs.median);
}
const MAX_WAITS = 6;
const MAX_INSTANTS = 10_000;

interface SimTask {
  row: Task;
  /** in the output at all */
  listed: boolean;
  slot: ScheduledSlot | null;
  waits: ScheduleWait[];
  /** a live, non-idle session: counts against the cap (`activeWorkers`) and `repoBusy` */
  live: boolean;
  lane: number | null;
  /** its real live worker run, while it lasts — the overflow claim's credit */
  liveRunId: string | null;
  /** a pending wake-up (ms), cleared when it resumes */
  wakeDue: number | null;
}

const short = (s: string) => (s.length > 48 ? `${s.slice(0, 47)}…` : s);

/**
 * Predict when every queued, parked or live task starts and stops, and why
 * the rest wait. Pure: no I/O, `now` injected. See the block comment above.
 */
export function predictSchedule(input: ScheduleInput): PredictedSlot[] {
  const nowMs = typeof input.now === 'number' ? input.now : new Date(input.now).getTime();
  const cap = Math.max(1, Math.floor(input.settings['orchestrator.concurrency']) || 1);
  const paused = !!input.settings['orchestrator.paused'];
  const enabled = !!input.settings['orchestrator.enabled'];
  const reviewOn = input.settings['review.enabled'] ?? true;
  const autoWake = input.settings['agent.autoWake'] ?? true;
  const dayOk = !input.dayBudgetReached;
  const repos = new Map(input.repos.map((r) => [r.id, r]));
  const features = new Map(input.features.map((f) => [f.id, f]));
  const pushFailing = new Set(input.pushFailing ?? []);
  const iso = (ms: number) => new Date(ms).toISOString();

  const rows: Task[] = input.tasks.map((t) => ({ ...t }));
  const byId = new Map(rows.map((t) => [t.id, t]));
  const sims = new Map<string, SimTask>();
  for (const row of rows) {
    sims.set(row.id, { row, listed: false, slot: null, waits: [], live: false, lane: null, liveRunId: null, wakeDue: null });
  }
  const sim = (t: Task) => sims.get(t.id)!;

  // the newest live worker run per task; review rounds in flight per task
  const workerRun = new Map<string, ScheduleRun>();
  const reviewRun = new Map<string, ScheduleRun>();
  const taskOfRun = new Map<string, string>(Object.entries(input.runTaskIds ?? {}));
  for (const r of input.runs) {
    if (r.mode === 'worker' && r.taskId) {
      taskOfRun.set(r.id, r.taskId);
      const prev = workerRun.get(r.taskId);
      if (!prev || prev.startedAt < r.startedAt) workerRun.set(r.taskId, r);
    } else if (r.kind === 'review' && r.subjectId) reviewRun.set(r.subjectId, r);
  }

  const lineOf = (repoId: string | null) =>
    (input.baseline ? scheduleLineFor(input.baseline, repoId) : null) ?? SCHEDULE_DEFAULT_LINE;
  const workMs = (t: Task) => scheduleWorkMs(input.baseline, t.repoId);
  const checkMs = (t: Task) => Math.max(MIN_REMAINING_MS, lineOf(t.repoId).checkMs ?? SCHEDULE_DEFAULT_LINE.checkMs!);
  const reviewMs = (t: Task) => Math.max(MIN_REMAINING_MS, lineOf(t.repoId).reviewMs ?? SCHEDULE_DEFAULT_LINE.reviewMs!);
  const repoName = (id: string | null) => (id && repos.get(id)?.name) || 'its repo';

  // the server's own "will the checks / the review run on this landing" tests
  const checksWillRun = (t: Task) => {
    const names = t.repoId ? input.repoChecks?.[t.repoId] : undefined;
    if (!names?.length) return false; // selectChecks over the repo's isCheck commands
    return t.checks == null || t.checks.some((n) => names.includes(n));
  };
  const reviewWillRun = (t: Task) => t.review ?? reviewOn; // worker.ts reviewWillRun

  // --- virtual time --------------------------------------------------------
  let t = nowMs;
  let seq = 0;
  const steps: { at: number; seq: number; fn: () => void }[] = [];
  const at = (when: number, fn: () => void) => steps.push({ at: when, seq: seq++, fn });
  const lanes: (string | null)[] = [];
  const takeLane = (id: string) => {
    let i = lanes.indexOf(null);
    if (i === -1) i = lanes.push(null) - 1;
    lanes[i] = id;
    return i;
  };
  const active = () => [...sims.values()].filter((s) => s.live).length;

  const addWait = (s: SimTask, w: ScheduleWait) => {
    if (s.waits.some((x) => x.code === w.code && x.text === w.text)) return;
    s.waits.push(w);
    if (s.waits.length > MAX_WAITS) s.waits.shift();
  };

  // --- reasons -----------------------------------------------------------
  const holderText = (h: Task): string => {
    if (h.pausedTurn) return 'owed a turn by Pause all';
    if (h.status === 'running') return h.kind === 'loop' && h.loopState !== 'iterating' ? 'between loop iterations' : 'running';
    if (h.status === 'waiting') return 'waiting on its subagents';
    if (h.status === 'blocked') return 'blocked on its split children';
    if (h.status === 'failed') return 'failed';
    if (h.status === 'review' && h.checkState && CHECK_BUSY_STATES.includes(h.checkState)) return 'in its checks';
    if (h.status === 'review' && h.reviewState && REVIEW_BUSY_STATES.includes(h.reviewState)) return 'in review round';
    return h.status;
  };
  const repoWait = (repoId: string, holders: Task[]): ScheduleWait => {
    const repoCap = repoParallelCap(repos.get(repoId));
    const main = holders.find((h) => !h.workdir);
    const text =
      repoCap > 1 && !main
        ? `waits for ${repoName(repoId)}: ${holders.length} of ${repoCap} parallel slots taken (${holders.map((h) => short(h.title)).join(', ')})`
        : `waits for ${repoName(repoId)}: ${short((main ?? holders[0]).title)} ${holderText(main ?? holders[0])}`;
    return { code: 'repo', text };
  };
  const capWait = (): ScheduleWait => ({ code: 'cap', text: `all ${cap} worker slot${cap === 1 ? '' : 's'} busy` });
  const W = {
    paused: { code: 'paused', text: 'paused (Pause all)' },
    draft: { code: 'draft', text: 'draft — not queued' },
    blocked: { code: 'blocked', text: 'blocked on its split children' },
    held: { code: 'held', text: 'held (Undo start)' },
    noRepo: { code: 'no-repo', text: 'no repo' },
    queueOff: { code: 'queue-off', text: 'queue off' },
    day: { code: 'day-budget', text: 'day budget reached' },
    wake: { code: 'wake', text: 'waits for the usage window to reopen' },
    wakeOff: { code: 'wake', text: 'auto wake-up off — waits for Proceed' },
  } satisfies Record<string, ScheduleWait>;

  /** FEATURE_CLAIM_GATE (full) / FEATURE_OVERFLOW_GATE (overflow): null = passes */
  const featureGate = (c: Task, overflow: boolean): ScheduleWait | null => {
    if (!c.featureId) return null;
    const f = features.get(c.featureId);
    if (overflow) return f?.status === 'cancelled' ? { code: 'feature', text: `feature ${short(f.title)} is cancelled` } : null;
    if (f?.status !== 'running') {
      return { code: 'feature', text: f ? `feature ${short(f.title)} is ${f.status}` : 'feature not running' };
    }
    if (c.featurePhase == null) return null; // `lo.feature_phase < NULL` matches nothing
    const lower = rows
      .filter((lo) => lo.featureId === c.featureId && lo.featurePhase != null && lo.featurePhase < c.featurePhase! && isFeatureTaskBlocking(lo))
      .sort((a, b) => a.featurePhase! - b.featurePhase!);
    if (!lower.length) return null;
    const lo = lower[0];
    const why =
      lo.status === 'failed' ? ` — ${short(lo.title)} failed`
      : lo.status === 'review' && !verifyOpen(lo) ? ` — ${short(lo.title)} waits for you in review`
      : lo.status === 'draft' ? ` — ${short(lo.title)} is a draft`
      : '';
    return { code: 'phase', text: `phase ${c.featurePhase} after phase ${lo.featurePhase}${why}` };
  };
  const pushGate = (c: Task): ScheduleWait | null =>
    c.repoId && pushFailing.has(c.repoId) ? { code: 'push-failing', text: `push failing (${repoName(c.repoId)})` } : null;
  /** room among `holders` of the candidate's repo (candidate excluded): `repoHasRoom` */
  const roomGate = (c: Task, isHolder: (o: Task) => boolean): ScheduleWait | null => {
    const holders = rows.filter((o) => o.repoId === c.repoId && o.id !== c.id && isHolder(o));
    return repoHasRoom(holders, repos.get(c.repoId!)) ? null : repoWait(c.repoId!, holders);
  };
  /** REPO_EXCLUSIVE_GATE */
  const exclusiveGate = (c: Task) => roomGate(c, holdsRepoForClaim);
  /** CUSTOM_QUEUE_HEAD_WHERE, then the pump's `repoBusy` (live non-idle sessions of the repo) */
  const customQueueGate = (c: Task): ScheduleWait | null => {
    const members = roomGate(c, (o) => !!o.pausedTurn || (!!o.customQueueAt && customQueueHoldsRepo(o)));
    if (members) return members;
    if (c.createdByRun) {
      const filerId = taskOfRun.get(c.createdByRun);
      const f = filerId ? byId.get(filerId) : undefined;
      if (f && f.id !== c.id && f.repoId === c.repoId && (f.status === 'failed' || customQueueHoldsRepo(f))) {
        return { code: 'filer', text: `waits for its filer ${short(f.title)} (${holderText(f)})` };
      }
      const any = roomGate(c, customQueueHoldsRepo);
      if (any) return any;
    }
    return roomGate(c, (o) => sim(o).live);
  };

  // --- segments ------------------------------------------------------------
  const newSlot = (s: SimTask, source: ScheduleSource, start: number, end: number, lane: number | null): ScheduledSlot => {
    s.slot = {
      scheduled: true,
      taskId: s.row.id,
      repoId: s.row.repoId,
      lane,
      start: iso(start),
      end: iso(end),
      source,
      after: [],
      lands: 'review',
      waits: s.waits,
    };
    s.listed = true;
    return s.slot;
  };

  /** a worker turn from `start` for `ms`: a lane, a live session, then its Stop */
  const startWork = (s: SimTask, source: ScheduleSource, ms: number, publish = false, start = t) => {
    const row = s.row;
    const fresh = source === 'custom-queue' || source === 'global' || source === 'overflow';
    // a fresh session of a pr repo forks its own worktree (docs/parallel.md)
    if (fresh && !row.workdir && repos.get(row.repoId ?? '')?.delivery === 'pr') row.workdir = `worktree:${row.id}`;
    row.status = 'running';
    row.pausedTurn = null;
    row.wakeAt = null;
    row.reviewState = null;
    row.checkState = null;
    if (row.kind === 'loop') row.loopState = 'iterating';
    s.wakeDue = null;
    s.live = true;
    s.lane = takeLane(row.id);
    const end = start + ms;
    newSlot(s, source, start, end, s.lane);
    at(end, () => endWork(s, publish));
  };

  /** the turn's Stop: free the lane, then the publish result or the verify round */
  const endWork = (s: SimTask, publish: boolean) => {
    if (s.lane != null) lanes[s.lane] = null;
    s.lane = null;
    s.live = false;
    s.liveRunId = null;
    if (publish) {
      s.row.status = 'published';
      if (s.slot) s.slot.lands = 'published';
      return;
    }
    // the Stop hook always lands `review` (a loop's endLoop too, after this iteration)
    s.row.status = 'review';
    s.row.loopState = null;
    if (paused) {
      // nothing automatic runs while paused: the round stays due
      s.row.reviewState = reviewWillRun(s.row) ? 'pending' : null;
      s.row.checkState = checksWillRun(s.row) ? 'pending' : null;
      return;
    }
    verify(s, checksWillRun(s.row) ? checkMs(s.row) : null, reviewWillRun(s.row) ? reviewMs(s.row) : null);
  };

  /** checks then review (runCheckStage before runReviewRound), each holding the repo; then the landing */
  const verify = (s: SimTask, checks: number | null, review: number | null) => {
    const row = s.row;
    row.status = 'review';
    row.checkState = checks != null ? 'running' : null;
    row.reviewState = review != null ? 'pending' : null;
    let when = t;
    if (checks != null) {
      s.slot?.after.push({ kind: 'checks', start: iso(when), end: iso(when + checks) });
      when += checks;
      at(when, () => (row.checkState = 'green'));
    }
    if (review != null) {
      s.slot?.after.push({ kind: 'review', start: iso(when), end: iso(when + review) });
      when += review;
      at(when, () => (row.reviewState = 'passed'));
    }
    if (when === t) land(s);
    else at(when, () => land(s));
  };

  /** landIfClean on a clean verdict, by the task's landing tier */
  const land = (s: SimTask) => {
    const row = s.row;
    const tier = effectiveLanding(row, repos.get(row.repoId ?? ''));
    if (tier === 'supervised') return; // stays in review for the human
    if (tier === 'on-green') {
      // a worktree task's change is not on the default branch yet: it stays in review, PR ready
      if (row.workdir) return;
      row.status = 'done';
      if (s.slot) s.slot.lands = 'done';
      return;
    }
    // auto-publish: the publish turn in its own session (a live PTY), or the worktree land
    if (!row.workdir) {
      row.status = 'running';
      s.live = true;
    }
    s.slot?.after.push({ kind: 'publish', start: iso(t), end: iso(t + SCHEDULE_PUBLISH_MS) });
    at(t + SCHEDULE_PUBLISH_MS, () => {
      s.live = false;
      row.status = 'published';
      if (s.slot) s.slot.lands = 'published';
    });
  };

  /** remaining time of a live turn: elapsed × (100/pct − 1) over the work band, clamped to the baseline */
  const remainingMs = (row: Task, run: ScheduleRun | undefined): number => {
    const elapsed = run ? Math.max(0, nowMs - Date.parse(run.startedAt)) : 0;
    if (run?.label === 'publish') return Math.max(MIN_REMAINING_MS, SCHEDULE_PUBLISH_MS - elapsed);
    const line = lineOf(row.repoId).workMs;
    const pct = input.progress?.[row.id];
    if (pct != null && pct > 0 && pct < PROGRESS_WORK_END && elapsed > 0) {
      const workPct = (pct / PROGRESS_WORK_END) * 100;
      const est = elapsed * (100 / workPct - 1);
      return Math.min(Math.max(MIN_REMAINING_MS, line.p75), Math.max(MIN_REMAINING_MS, est));
    }
    return Math.max(MIN_REMAINING_MS, line.median - elapsed);
  };

  // --- where every row stands at `now` -------------------------------------
  for (const s of sims.values()) {
    const row = s.row;
    if (row.wakeAt && (row.status === 'review' || row.status === 'failed') && !row.pausedTurn) {
      const w = Date.parse(row.wakeAt);
      if (Number.isFinite(w)) {
        s.wakeDue = Math.max(nowMs, w + SCHEDULE_WAKE_DELAY_MS);
        s.listed = true;
      }
    }
    switch (row.status) {
      case 'draft':
        s.listed = true;
        addWait(s, W.draft);
        break;
      case 'blocked':
        s.listed = true;
        addWait(s, W.blocked);
        break;
      case 'queued':
        s.listed = true;
        break;
      case 'review':
      case 'failed':
        if (row.pausedTurn) s.listed = true;
        else if (verifyOpen(row)) {
          s.listed = true;
          if (paused) {
            addWait(s, W.paused);
            break;
          }
          newSlot(s, 'running', nowMs, nowMs, null);
          const rr = reviewRun.get(row.id);
          const review = !row.reviewState || !REVIEW_BUSY_STATES.includes(row.reviewState) ? null
            : row.reviewState === 'reviewing' && rr ? Math.max(MIN_REMAINING_MS, reviewMs(row) - (nowMs - Date.parse(rr.startedAt)))
            : reviewMs(row);
          const checks = row.checkState && CHECK_BUSY_STATES.includes(row.checkState) ? checkMs(row) : null;
          verify(s, checks, review);
        }
        break;
      case 'running':
      case 'waiting': {
        s.listed = true;
        if (row.kind === 'loop' && (row.loopState === 'next' || row.loopState === 'checking')) {
          // no session between iterations; `checking` turns `next` once its checks ran
          if (row.loopState === 'checking') at(nowMs + checkMs(row), () => (row.loopState = 'next'));
          break;
        }
        const run = workerRun.get(row.id);
        s.live = !run?.idle;
        s.liveRunId = run && !run.idle ? run.id : null;
        s.lane = takeLane(row.id);
        // left to the CLI at a usage limit: the session itself continues after the reset
        const w = row.wakeAt ? Date.parse(row.wakeAt) : NaN;
        const resumeAt = Number.isFinite(w) ? Math.max(nowMs, w + SCHEDULE_WAKE_DELAY_MS) : nowMs;
        if (resumeAt > nowMs) addWait(s, W.wake);
        const publish = run?.label === 'publish';
        const end = resumeAt + remainingMs(row, run);
        newSlot(s, 'running', nowMs, end, s.lane);
        at(end, () => endWork(s, publish));
        break;
      }
    }
  }

  // --- one claim pass at `t` (maybeSchedule, then the wake sweep) ----------
  const reasons = new Map<string, ScheduleWait>();
  const why = (c: Task, w: ScheduleWait) => {
    if (!reasons.has(c.id)) reasons.set(c.id, w);
  };
  const isCandidate = (c: Task) => c.status === 'queued';

  const pass = (): boolean => {
    let started = false;
    if (paused) {
      for (const s of sims.values()) {
        const r = s.row;
        if (isCandidate(r) || (r.pausedTurn && !s.slot) || (s.wakeDue != null && !s.slot)) why(r, W.paused);
      }
      return false;
    }
    // 2. paused-turn markers, oldest first
    const owed = rows
      .filter((r) => (r.status === 'review' || r.status === 'failed') && r.pausedTurn)
      .sort((a, b) => a.pausedTurn!.at.localeCompare(b.pausedTurn!.at));
    for (const r of owed) {
      if (active() >= cap) {
        why(r, capWait());
        continue;
      }
      const s = sim(r);
      const kind = r.pausedTurn!.kind;
      started = true;
      if (kind === 'land') {
        r.pausedTurn = null;
        newSlot(s, 'resume', t, t, null);
        land(s);
      } else startWork(s, 'resume', kind === 'publish' ? SCHEDULE_PUBLISH_MS : workMs(r), kind === 'publish');
    }
    if (!dayOk) {
      for (const r of rows) {
        if (isCandidate(r) || (r.status === 'running' && r.kind === 'loop' && r.loopState === 'next')) why(r, W.day);
      }
    } else {
      // 3. the custom queue: one head per repo, FIFO, regardless of the queue switch
      for (const c of customQueueWaiting(rows)) {
        if (c.queueHeldAt) why(c, W.held);
        if (!c.repoId) why(c, W.noRepo);
        const gate = reasons.has(c.id) ? null : (pushGate(c) ?? featureGate(c, false) ?? customQueueGate(c));
        if (gate) why(c, gate);
        if (reasons.has(c.id)) continue;
        if (active() >= cap) {
          why(c, capWait());
          continue;
        }
        startWork(sim(c), 'custom-queue', workMs(c));
        started = true;
      }
      // 4. loop iterations due, oldest first
      const due = rows
        .filter((r) => r.status === 'running' && r.kind === 'loop' && r.loopState === 'next')
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      for (const r of due) {
        if (active() >= cap) {
          why(r, capWait());
          continue;
        }
        startWork(sim(r), 'loop', workMs(r));
        started = true;
      }
    }
    // global candidates: queued, not members
    const global = rows.filter((r) => isCandidate(r) && !r.customQueueAt);
    if (!enabled || !dayOk) {
      for (const c of global) {
        if (c.queueHeldAt) why(c, W.held);
        why(c, dayOk ? W.queueOff : W.day);
      }
    } else {
      // 5. the global claim
      for (const c of [...global].sort(compareClaimOrder(byId))) {
        if (c.queueHeldAt) why(c, W.held);
        if (!c.repoId) why(c, W.noRepo);
        const gate = reasons.has(c.id) ? null : (featureGate(c, false) ?? pushGate(c) ?? exclusiveGate(c));
        if (gate) why(c, gate);
        if (reasons.has(c.id)) continue;
        if (active() >= cap) {
          why(c, capWait());
          continue;
        }
        startWork(sim(c), 'global', workMs(c));
        started = true;
      }
      // 6. overflow: one child per live creating session, past the cap
      for (;;) {
        const credits = new Set([...sims.values()].filter((s) => s.live && s.liveRunId).map((s) => s.liveRunId!));
        for (const r of rows) if (r.status === 'running' && r.createdByRun) credits.delete(r.createdByRun);
        const next = rows
          .filter((c) => isCandidate(c) && !c.customQueueAt && !c.queueHeldAt && c.repoId && c.createdByRun && credits.has(c.createdByRun))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .find((c) => !featureGate(c, true) && !pushGate(c) && !exclusiveGate(c));
        if (!next) break;
        reasons.delete(next.id);
        startWork(sim(next), 'overflow', workMs(next));
        started = true;
      }
    }
    // the wake sweep: due wake-ups, earliest first, within the cap
    const wakes = [...sims.values()]
      .filter((s) => s.wakeDue != null && !s.slot && (s.row.status === 'review' || s.row.status === 'failed'))
      .sort((a, b) => a.wakeDue! - b.wakeDue!);
    for (const s of wakes) {
      if (!autoWake) {
        why(s.row, W.wakeOff);
        continue;
      }
      if (s.wakeDue! > t) {
        why(s.row, W.wake);
        continue;
      }
      if (!enabled && !s.row.customQueueAt) {
        why(s.row, W.queueOff);
        continue;
      }
      if (active() >= cap) {
        why(s.row, capWait());
        continue;
      }
      startWork(s, 'wake', workMs(s.row));
      started = true;
    }
    return started;
  };

  for (let n = 0; n < MAX_INSTANTS; n++) {
    // apply what happens at `t`, in the order it was scheduled
    for (;;) {
      const ready = steps.filter((x) => x.at <= t).sort((a, b) => a.at - b.at || a.seq - b.seq);
      if (!ready.length) break;
      for (const x of ready) steps.splice(steps.indexOf(x), 1);
      for (const x of ready) x.fn();
    }
    // a pass that started something may have freed a gate for an earlier step (a land marker
    // landing on-green opens a phase): the server re-runs maybeSchedule the same way
    for (let k = 0; k < 4; k++) {
      reasons.clear();
      if (!pass()) break;
    }
    for (const [id, w] of reasons) {
      const s = sims.get(id)!;
      if (!s.slot) addWait(s, w);
    }
    const nexts = [
      ...steps.map((x) => x.at),
      ...[...sims.values()].filter((s) => autoWake && s.wakeDue != null && !s.slot && s.wakeDue > t).map((s) => s.wakeDue!),
    ];
    if (!nexts.length || paused) break;
    t = Math.min(...nexts);
  }

  const out: PredictedSlot[] = [];
  for (const s of sims.values()) {
    if (!s.listed) continue;
    if (s.slot) out.push(s.slot);
    else {
      out.push({
        scheduled: false,
        taskId: s.row.id,
        repoId: s.row.repoId,
        lane: null,
        start: null,
        end: null,
        source: null,
        after: [],
        lands: null,
        waits: s.waits.length ? s.waits : [{ code: 'cap', text: 'not reached by the simulation' }],
      });
    }
  }
  const startOf = (p: PredictedSlot) => (p.start ? Date.parse(p.start) : Infinity);
  return out.sort(
    (a, b) =>
      startOf(a) - startOf(b) ||
      (a.lane ?? Infinity) - (b.lane ?? Infinity) ||
      byId.get(a.taskId)!.createdAt.localeCompare(byId.get(b.taskId)!.createdAt) ||
      a.taskId.localeCompare(b.taskId),
  );
}
