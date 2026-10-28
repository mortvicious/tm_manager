/**
 * Schedule prediction accuracy (docs/timeline.md § Prediction accuracy). Pure:
 * `GET /api/schedule/accuracy` loads the rows, this replays them.
 *
 * For every claim the server made — a `task.transition` carrying `data.claim`
 * (`base` = the global claim, `custom-queue`, `overflow`) — rebuild the board
 * as it stood just before that row and ask `predictSchedule` what it would
 * have claimed first at that instant:
 *  - statuses: the task's last `task.transition` / `task.created` before the
 *    claim (id order, so rows of the same millisecond keep their order);
 *  - review / check rounds: the past-segment fold (`buildTaskSegments` →
 *    `segmentAt`) — a `review-round` is an open review, `checks` open checks,
 *    an idle review is settled;
 *  - custom-queue marks and Undo-start holds: `task.queue` / `task.undo` rows
 *    and the transitions that clear them;
 *  - Pause-all markers: `orchestrator.pause` rows' `suspended` ids, cleared by
 *    the task's next transition;
 *  - settings: `orchestrator.toggle` (enabled), `orchestrator.pause` (paused),
 *    `feature.transition` (feature status), `repo.push-health` (auth/protected
 *    hold the repo);
 *  - everything else — priority, sort order, feature phase, workdir, the repo
 *    rows, concurrency, review/autoWake — from the CURRENT rows: a stated
 *    approximation (`ScheduleAccuracy.approximations`).
 * A claim matches when the simulator's first claim (earliest start, then lane)
 * is the claimed task AND starts at the claim's instant.
 */
import {
  firstIdleByRun,
  predictSchedule,
  runWorkedMs,
  scheduleWorkMs,
  type PredictedSlot,
  type ScheduleBaseline,
  type ScheduleInput,
  type ScheduleRun,
  type ScheduleSource,
} from './schedule.ts';
import { buildTaskSegments, segmentAt, sortEvents, type TimelineSegment } from './timeline.ts';
// Values from types.ts are read only inside functions: types.ts re-exports this module.
import { TERMINAL_TASK_STATUSES } from './types.ts';
import type { AuditEvent, AuditKind, FeatureStatus, PausedTurn, Run, Task, TaskStatus } from './types.ts';

export const CLAIM_KINDS = ['base', 'custom-queue', 'overflow'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const ACCURACY_DEFAULT_DAYS = 14;
export const ACCURACY_MISMATCH_CAP = 50;

/** the non-timeline rows the replay reads (the route fetches them over all time: they are few) */
export const ACCURACY_CONTROL_KINDS: readonly AuditKind[] = [
  'task.queue',
  'task.undo',
  'orchestrator.toggle',
  'orchestrator.pause',
  'feature.transition',
  'repo.push-health',
  'config.changed',
];

export interface AccuracyMismatch {
  at: string;
  /** the simulator's first claim from that instant on; null = it predicted none */
  predicted: { taskId: string; title: string | null; source: ScheduleSource; start: string } | null;
  actual: { taskId: string; title: string | null; claim: ClaimKind };
  reason: string;
}

export interface RateCount {
  total: number;
  matched: number;
  /** matched / total; null when total is 0 */
  rate: number | null;
}

export interface DurationAccuracy {
  /** tasks that landed (done/published) in the window with worked time */
  n: number;
  /** median |predicted − actual| worked time */
  medianAbsErrorMs: number | null;
  /** median of predicted − actual (negative: the prediction is short) */
  medianErrorMs: number | null;
  medianPredictedMs: number | null;
  medianActualMs: number | null;
}

export interface ScheduleAccuracy extends RateCount {
  since: string;
  until: string;
  byClaimKind: Record<ClaimKind, RateCount>;
  /**
   * the claims that were a real choice: two or more queued, unheld candidates
   * in the rebuilt state (one waiting task is an easy match)
   */
  contested: RateCount;
  /** claims not counted: the claimed task's row no longer exists */
  skipped: number;
  /** of the misses: the claimed task WAS among the claims predicted for that instant, in another order */
  samePassOtherOrder: number;
  /** oldest first, at most `mismatchCap` */
  mismatches: AccuracyMismatch[];
  mismatchesTotal: number;
  duration: DurationAccuracy;
  /** what the replay could not rebuild from the log and took from the current rows instead */
  approximations: string[];
  /** the timeline load was cut by its row cap: the oldest claims may be rebuilt from partial rows */
  truncated: boolean;
}

export interface ReplayInput {
  /** the CURRENT task rows (every one: terminal rows settle feature phases) */
  tasks: readonly Task[];
  repos: ScheduleInput['repos'];
  features: ScheduleInput['features'];
  /** the CURRENT settings — the fallbacks for what the log does not record */
  settings: ScheduleInput['settings'];
  /**
   * the timeline rows of the window (seeds included — `loadTimeline`), the
   * `ACCURACY_CONTROL_KINDS` rows up to `until`, and `run.stats-final` rows for
   * the worked durations
   */
  events: readonly AuditEvent[];
  /** worker runs (all of them: overflow credits name old runs) and review aux runs */
  runs: readonly Run[];
  baseline?: ScheduleBaseline | null;
  since: string;
  until: string;
  mismatchCap?: number;
  truncated?: boolean;
}

const SETTLED = new Set<TaskStatus>(['done', 'published', 'cancelled']);
const HOLDING_PUSH_KINDS = new Set(['auth', 'protected']);
const HUMAN = new Set(['human', 'telegram']);
const isClaimKind = (v: unknown): v is ClaimKind => typeof v === 'string' && (CLAIM_KINDS as readonly string[]).includes(v);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const rate = (c: { total: number; matched: number }): RateCount => ({ ...c, rate: c.total ? c.matched / c.total : null });

/** the whole replay at once (tests, small logs); the server drains `replayClaimSteps` instead */
export function replayClaims(input: ReplayInput): ScheduleAccuracy {
  const it = replayClaimSteps(input);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/**
 * The replay as a generator that yields after the segment fold and after every
 * claim (each one a full `predictSchedule`), so the single-process server can
 * hand the event loop back between them (`loadAccuracy`) instead of holding it
 * for the seconds a month of claims takes.
 */
export function* replayClaimSteps(input: ReplayInput): Generator<void, ScheduleAccuracy, void> {
  const evs = sortEvents([...new Map(input.events.map((e) => [e.id, e])).values()]);
  const rows = new Map(input.tasks.map((t) => [t.id, t]));
  const sinceMs = Date.parse(input.since);
  const untilMs = Date.parse(input.until);
  const cap = input.mismatchCap ?? ACCURACY_MISMATCH_CAP;
  const terminal = new Set<string>(TERMINAL_TASK_STATUSES);

  // the past segments over everything the log holds: a round relabelled by a
  // later verdict is known at every instant inside it
  const segments: Record<string, TimelineSegment[]> = evs.length
    ? buildTaskSegments(evs, input.runs as Run[], { since: evs[0].at, until: input.until, now: input.until })
    : {};
  yield;

  // --- initial values: what held before the first row that changes them --------
  const firstOf = (pred: (e: AuditEvent) => boolean) => evs.find(pred);
  const initialStatus = new Map<string, TaskStatus | null>();
  for (const e of evs) {
    if (!e.taskId || initialStatus.has(e.taskId)) continue;
    if (e.kind === 'task.created') initialStatus.set(e.taskId, null); // did not exist before it
    else if (e.kind === 'task.transition' && typeof e.data?.from === 'string') initialStatus.set(e.taskId, e.data.from as TaskStatus);
  }
  const toggle = firstOf((e) => e.kind === 'orchestrator.toggle' && typeof e.data?.enabled === 'boolean');
  const pauseRow = firstOf((e) => e.kind === 'orchestrator.pause' && typeof e.data?.paused === 'boolean');
  // the value before the first row that changed it, else the current one
  let enabled = toggle ? !toggle.data?.enabled : !!input.settings['orchestrator.enabled'];
  let paused = pauseRow ? !pauseRow.data?.paused : !!input.settings['orchestrator.paused'];

  const featureStatus = new Map<string, FeatureStatus>();
  for (const f of input.features) featureStatus.set(f.id, f.status);
  const seenFeature = new Set<string>();
  for (const e of evs) {
    const id = e.kind === 'feature.transition' ? (e.data?.featureId as string | undefined) : undefined;
    if (!id || seenFeature.has(id)) continue;
    seenFeature.add(id);
    const from = e.data?.from as FeatureStatus | null | undefined;
    if (from) featureStatus.set(id, from);
  }

  // custom-queue members with no `task.queue add` before their first custom-queue
  // claim (an agent's shared-note filing joins at creation): marked from creation
  const firstAdd = new Map<string, string>();
  const firstCqClaim = new Map<string, string>();
  for (const e of evs) {
    if (!e.taskId) continue;
    if (e.kind === 'task.queue' && e.data?.action === 'add' && !firstAdd.has(e.taskId)) firstAdd.set(e.taskId, e.id);
    if (e.kind === 'task.transition' && e.data?.claim === 'custom-queue' && !firstCqClaim.has(e.taskId)) firstCqClaim.set(e.taskId, e.id);
  }

  const status = new Map<string, TaskStatus | null>();
  const mark = new Map<string, string | null>();
  const markBeforeQueued = new Map<string, string | null>();
  const held = new Map<string, string | null>();
  const pausedTurn = new Map<string, PausedTurn | null>();
  const pushFailing = new Set<string>();
  for (const t of input.tasks) {
    const cq = firstCqClaim.get(t.id);
    const add = firstAdd.get(t.id);
    mark.set(t.id, cq && !(add && add < cq) ? t.createdAt : null);
  }

  // --- the replay -----------------------------------------------------------------
  const counts = { total: 0, matched: 0 };
  const contested = { total: 0, matched: 0 };
  const byKind = Object.fromEntries(CLAIM_KINDS.map((k) => [k, { total: 0, matched: 0 }])) as Record<ClaimKind, { total: number; matched: number }>;
  let skipped = 0;
  let samePassOtherOrder = 0;
  const mismatches: AccuracyMismatch[] = [];
  let mismatchesTotal = 0;
  const titleOf = (id: string) => rows.get(id)?.title ?? null;

  const statusAt = (id: string): TaskStatus | null | undefined =>
    status.has(id) ? status.get(id) : initialStatus.has(id) ? initialStatus.get(id) : undefined;

  const evaluate = (claim: AuditEvent, kind: ClaimKind) => {
    const actualId = claim.taskId!;
    if (!rows.has(actualId)) {
      skipped++;
      return;
    }
    const T = Date.parse(claim.at);
    const tasks: Task[] = [];
    for (const row of input.tasks) {
      if (row.createdAt > claim.at) continue;
      const st = statusAt(row.id);
      if (st === null) continue; // created after this instant (by the log)
      const s: TaskStatus = st ?? row.status;
      // a landed/cancelled row gates nothing but a feature phase (a FAILED one still holds an agent-filed
      // member and a phase): leave the rest out of the simulation, which walks every row at every instant
      if (SETTLED.has(s) && !row.featureId) continue;
      const t: Task = {
        ...row,
        status: s,
        customQueueAt: mark.get(row.id) ?? null,
        queueHeldAt: held.get(row.id) ?? null,
        pausedTurn: pausedTurn.get(row.id) ?? null,
        reviewState: null,
        checkState: null,
        wakeAt: null,
        loopState: row.kind === 'loop' && s === 'running' ? 'iterating' : null,
      };
      if (s === 'review') {
        const seg = segmentAt(segments[row.id] ?? [], T);
        if (seg?.kind === 'review-round') t.reviewState = 'reviewing';
        else if (seg?.kind === 'checks') t.checkState = 'running';
      }
      tasks.push(t);
    }
    const live = (r: Run) => Date.parse(r.startedAt) <= T && (r.endedAt ? T < Date.parse(r.endedAt) : r.status === 'running');
    const runs: ScheduleRun[] = input.runs
      .filter((r) => (r.mode === 'worker' || r.kind === 'review') && live(r))
      // `idle` is the run's state NOW; a running task's session is never idle
      .map((r) => ({ id: r.id, taskId: r.taskId, startedAt: r.startedAt, label: r.label, mode: r.mode, kind: r.kind, subjectId: r.subjectId }));
    const runTaskIds: Record<string, string> = {};
    for (const r of input.runs) if (r.mode === 'worker' && r.taskId) runTaskIds[r.id] = r.taskId;

    const slots = predictSchedule({
      tasks,
      repos: input.repos,
      features: input.features.map((f) => ({ ...f, status: featureStatus.get(f.id) ?? f.status })),
      settings: { ...input.settings, 'orchestrator.enabled': enabled, 'orchestrator.paused': paused },
      runs,
      baseline: input.baseline,
      pushFailing: [...pushFailing],
      runTaskIds,
      now: T,
    });

    const claims = slots
      .filter((p): p is Extract<PredictedSlot, { scheduled: true }> => p.scheduled && (p.source === 'custom-queue' || p.source === 'global' || p.source === 'overflow'))
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || (a.lane ?? Infinity) - (b.lane ?? Infinity));
    const first = claims[0];
    const now = claims.filter((p) => Date.parse(p.start) === T);
    const choice = tasks.filter((x) => x.status === 'queued' && !x.queueHeldAt).length >= 2;
    counts.total++;
    byKind[kind].total++;
    if (choice) contested.total++;
    if (first && first.taskId === actualId && Date.parse(first.start) === T) {
      counts.matched++;
      byKind[kind].matched++;
      if (choice) contested.matched++;
      return;
    }
    mismatchesTotal++;
    const inPass = now.some((p) => p.taskId === actualId);
    if (inPass) samePassOtherOrder++;
    const mine = slots.find((p) => p.taskId === actualId);
    const wait = mine?.waits.at(-1)?.text;
    let reason: string;
    if (inPass) reason = `same pass, other order: predicted ${first.source} claim of "${titleOf(first.taskId)}" first`;
    else if (mine?.scheduled) {
      const mins = Math.round((Date.parse(mine.start) - T) / 60_000);
      reason = `predicted ${mins >= 1 ? `${mins} min later` : 'later'} (${mine.source})${wait ? ` — ${wait}` : ''}`;
    } else if (mine) reason = `predicted to wait: ${wait ?? 'unknown'}`;
    else {
      const t = tasks.find((x) => x.id === actualId);
      reason = t ? `not a candidate in the rebuilt state (status ${t.status}${t.customQueueAt ? ', custom queue' : ''})` : 'task not in the rebuilt state';
    }
    if (first && !inPass && Date.parse(first.start) === T) reason = `predicted ${first.source} claim of "${titleOf(first.taskId)}" instead; ${reason}`;
    if (mismatches.length < cap) {
      mismatches.push({
        at: claim.at,
        predicted: first ? { taskId: first.taskId, title: titleOf(first.taskId), source: first.source, start: first.start } : null,
        actual: { taskId: actualId, title: titleOf(actualId), claim: kind },
        reason,
      });
    }
  };

  const concurrencyChanges: string[] = [];
  const landed = new Map<string, string>();
  for (const e of evs) {
    const id = e.taskId;
    const d = (e.data ?? {}) as Record<string, unknown>;
    const atMs = Date.parse(e.at);
    const inWindow = atMs >= sinceMs && atMs < untilMs;
    switch (e.kind) {
      case 'task.created':
        if (id && typeof d.status === 'string') status.set(id, d.status as TaskStatus);
        break;
      case 'task.transition': {
        if (!id || typeof d.to !== 'string') break;
        const to = d.to as TaskStatus;
        // the state just BEFORE this row is what the claim pass saw
        if (inWindow && isClaimKind(d.claim)) {
          evaluate(e, d.claim);
          yield;
        }
        if (inWindow && (to === 'done' || to === 'published') && !landed.has(id)) landed.set(id, e.at);
        status.set(id, to);
        held.set(id, null); // every transitionTask clears the Undo-start hold
        pausedTurn.set(id, null); // …and a Pause-all marker it did not set
        if (terminal.has(to)) mark.set(id, null);
        else if (to === 'queued' && HUMAN.has(e.actor)) {
          // Enqueue / Retry mean the GLOBAL queue (Add to queue writes its mark back in its `task.queue` row)
          markBeforeQueued.set(id, mark.get(id) ?? null);
          mark.set(id, null);
        }
        break;
      }
      case 'task.queue':
        if (!id) break;
        if (d.action === 'add') {
          mark.set(id, e.at);
          held.set(id, null);
        } else if (d.action === 'remove') mark.set(id, null);
        else if (d.action === 'reorder' && typeof d.after === 'string') mark.set(id, d.after);
        break;
      case 'task.undo':
        if (!id) break;
        if (d.action === 'undo') {
          // back in `queued` it keeps its place
          if (markBeforeQueued.has(id)) mark.set(id, markBeforeQueued.get(id) ?? null);
          held.set(id, d.held ? e.at : null);
        } else if (d.action === 'release') {
          held.set(id, null);
          if (d.queue === 'global') mark.set(id, null);
        }
        break;
      case 'orchestrator.toggle':
        if (typeof d.enabled === 'boolean') enabled = d.enabled;
        break;
      case 'orchestrator.pause':
        if (typeof d.paused === 'boolean') paused = d.paused;
        if (Array.isArray(d.suspended)) {
          for (const sid of d.suspended) if (typeof sid === 'string') pausedTurn.set(sid, { at: e.at, kind: 'resume' });
        }
        break;
      case 'feature.transition':
        if (typeof d.featureId === 'string' && typeof d.to === 'string') featureStatus.set(d.featureId, d.to as FeatureStatus);
        break;
      case 'repo.push-health':
        if (!e.repoId) break;
        if (d.ok === false && typeof d.kind === 'string' && HOLDING_PUSH_KINDS.has(d.kind)) pushFailing.add(e.repoId);
        else pushFailing.delete(e.repoId);
        break;
      case 'config.changed':
        if (Array.isArray(d.keys) && d.keys.includes('orchestrator.concurrency') && atMs < untilMs) concurrencyChanges.push(e.at);
        break;
    }
  }

  // --- worked duration: predicted (the simulator's work segment) vs actual -------
  const idleAt = firstIdleByRun(evs.filter((e) => e.kind === 'run.stats-final'));
  const worked = new Map<string, number>();
  for (const r of input.runs) {
    if (r.mode !== 'worker' || !r.taskId || !landed.has(r.taskId)) continue;
    worked.set(r.taskId, (worked.get(r.taskId) ?? 0) + runWorkedMs(r, idleAt.get(r.id), untilMs));
  }
  const errs: number[] = [];
  const preds: number[] = [];
  const acts: number[] = [];
  for (const [taskId] of landed) {
    const actual = worked.get(taskId) ?? 0;
    if (!(actual > 0)) continue; // landed without a worker turn (marked done, a no-op)
    const predicted = scheduleWorkMs(input.baseline, rows.get(taskId)?.repoId ?? null);
    preds.push(predicted);
    acts.push(actual);
    errs.push(predicted - actual);
  }

  const lastConcurrency = concurrencyChanges.filter((at) => Date.parse(at) > sinceMs).at(-1);
  const approximations = [
    'priority, sort order, group, feature phase, workdir and the task fields not listed below come from the CURRENT rows',
    'repo rows (parallel, delivery, landing) are the current ones',
    `orchestrator.concurrency is the current value (${input.settings['orchestrator.concurrency']}): config.changed rows record keys, never values` +
      (lastConcurrency ? ` — it changed at ${lastConcurrency}, so claims before that may have run under another cap` : ''),
    'review.enabled and agent.autoWake are the current values; wake-ups (wake_at) and loop states are not replayed; the day budget fuse is taken as never reached',
    'a custom-queue member with no `task.queue add` row before its custom-queue claim (an agent filing) is a member from its creation',
    'deleted tasks are gone from the board (their claims are skipped; their hold on a repo is not seen)',
    'worked-duration predictions read the current baseline, which includes the window\'s own landed tasks',
  ];

  return {
    since: input.since,
    until: input.until,
    ...rate(counts),
    byClaimKind: Object.fromEntries(CLAIM_KINDS.map((k) => [k, rate(byKind[k])])) as Record<ClaimKind, RateCount>,
    contested: rate(contested),
    skipped,
    samePassOtherOrder,
    mismatches,
    mismatchesTotal,
    duration: {
      n: errs.length,
      medianAbsErrorMs: median(errs.map(Math.abs)),
      medianErrorMs: median(errs),
      medianPredictedMs: median(preds),
      medianActualMs: median(acts),
    },
    approximations,
    truncated: !!input.truncated,
  };
}
