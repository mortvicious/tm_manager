/**
 * Timeline past segments (docs/timeline.md). Pure: the server builds them for
 * `GET /api/timeline` / `GET /api/tasks/:id/history`, and the SPA keeps the
 * same fold alive by appending `event.appended` rows — so the batch build IS a
 * fold (`buildTaskSegments` = `foldEvent` over the sorted events, then
 * `timelineSegments`), and both sides read one set of rules.
 *
 * A segment is a stretch of one task in one state, read off the audit log:
 *   queued · running · waiting · review-round · checks · fixing ·
 *   idle-in-review · landed   (+ zero-length `failed` / `cancelled` markers)
 *
 * Sources: `task.created` (a task born `queued`), `task.transition` (from/to, `data.claim`, and — since the Stop hook
 * records them — `data.reviewState`/`data.checkState`), `run.started`,
 * `task.follow-up` (`reason` = a fix turn is coming), `run.reviewed`,
 * `task.checked`, `task.review-requested`, `task.waiting`, `task.land`,
 * `task.landing`, `task.shipped`; `tm_runs` only fill in a missing `runId`.
 *
 * A landing in `review` whose row says nothing about a pending round (rows
 * written before the Stop hook recorded it, a pause, a stall park) opens a
 * PROVISIONAL idle-in-review: when a `task.checked` / `run.reviewed` follows
 * in the same stint, that open stretch was the checks / the review round and
 * is relabelled in place. Only the OPEN segment is ever relabelled, so a live
 * fold and a batch build agree.
 */
import type { AuditEvent, AuditKind, Run, TaskStatus } from './types.ts';

export type TimelineSegmentKind =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'review-round'
  | 'checks'
  | 'fixing'
  | 'idle-in-review'
  | 'landed'
  /** end markers: start === end */
  | 'failed'
  | 'cancelled';

export interface TimelineSegment {
  taskId: string;
  repoId: string | null;
  kind: TimelineSegmentKind;
  start: string;
  /** null = the task is still in this state (as of the newest event folded) */
  end: string | null;
  /** the worker run of a running/fixing stretch, the reviewer's aux run of a review round */
  runId?: string;
  /**
   * how the stretch ended: the next status for running/fixing/waiting/queued/
   * idle/landed, the review state for a round (`passed`, `fixing`, …,
   * `skipped:unchanged-diff`), the verdict for checks (`green`, `red`, `error`,
   * `skipped:empty-diff`), the error/reason on a failed/cancelled marker
   */
  outcome?: string;
  /** claim kind, handoff, verdict, round, check state, waiting children, land phase … */
  data: Record<string, unknown>;
  /** started before the window: `start` is the window's start, not the real one */
  clippedStart?: true;
  /** still open when the window ends before `now`: `end` is the window's end */
  clippedEnd?: true;
}

/** the audit kinds the fold reads — what `/api/timeline` fetches */
export const TIMELINE_EVENT_KINDS: readonly AuditKind[] = [
  'task.created',
  'task.transition',
  'run.started',
  'task.follow-up',
  'run.reviewed',
  'task.checked',
  'task.review-requested',
  'task.waiting',
  'task.land',
  'task.landing',
  'task.shipped',
  'task.deleted',
];

/** `/api/timeline` window bound and row cap (events and runs each) */
export const TIMELINE_MAX_DAYS = 31;
export const TIMELINE_ROW_CAP = 20_000;

/** what `GET /api/timeline` answers */
export interface TimelineResponse {
  events: AuditEvent[];
  runs: Run[];
  segments: Record<string, TimelineSegment[]>;
  since: string;
  until: string;
  /** a cap cut the window: segments before `coveredSince` are incomplete */
  truncated: boolean;
  /** the oldest instant the events cover (= `since` unless truncated) */
  coveredSince: string;
}

/** what `GET /api/tasks/:id/history` answers */
export interface TaskHistoryResponse {
  events: AuditEvent[];
  runs: Run[];
  segments: TimelineSegment[];
  truncated: boolean;
}

/** per-task fold state */
export interface TimelineTrack {
  taskId: string;
  repoId: string | null;
  /** closed segments, oldest first, then the open one (if any) last */
  segments: TimelineSegment[];
  /** the last segment is open (end null) */
  open: boolean;
  /** the open idle-in-review is a guess: a checks/review verdict relabels it */
  provisional: boolean;
  /** a fix turn was announced (`task.follow-up` with a reason): the next `running` is `fixing` */
  pendingFix: { reason: string; round: unknown; at: string } | null;
  status: TaskStatus | null;
}

export interface TimelineState {
  tasks: Record<string, TimelineTrack>;
  runs: Record<string, Run>;
  /** newest event folded; an event at or below it is a duplicate and ignored */
  lastEventId: string | null;
}

export interface TimelineWindow {
  since: string;
  until: string;
  now: string;
}

export function initTimeline(): TimelineState {
  return { tasks: {}, runs: {}, lastEventId: null };
}

/** the open kinds a task holds while its status is `review` */
const REVIEW_KINDS: ReadonlySet<TimelineSegmentKind> = new Set(['review-round', 'checks', 'idle-in-review']);
const TURN_KINDS: ReadonlySet<TimelineSegmentKind> = new Set(['running', 'fixing']);

/** how long a `task.follow-up` fix announcement waits for its transition to running */
const FIX_ANNOUNCE_MS = 5 * 60_000;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function openSeg(track: TimelineTrack): TimelineSegment | null {
  return track.open ? track.segments[track.segments.length - 1] : null;
}

function close(track: TimelineTrack, at: string, outcome?: string): TimelineSegment | null {
  const seg = openSeg(track);
  if (!seg) return null;
  seg.end = at;
  if (outcome !== undefined && seg.outcome === undefined) seg.outcome = outcome;
  track.open = false;
  track.provisional = false;
  return seg;
}

function open(track: TimelineTrack, kind: TimelineSegmentKind, at: string, data: Record<string, unknown> = {}, runId?: string) {
  track.segments.push({
    taskId: track.taskId,
    repoId: track.repoId,
    kind,
    start: at,
    end: null,
    ...(runId ? { runId } : {}),
    data,
  });
  track.open = true;
  track.provisional = false;
}

function marker(track: TimelineTrack, kind: 'failed' | 'cancelled', at: string, outcome: string | undefined, data: Record<string, unknown>) {
  track.segments.push({
    taskId: track.taskId,
    repoId: track.repoId,
    kind,
    start: at,
    end: at,
    ...(outcome ? { outcome } : {}),
    data,
  });
  track.open = false;
  track.provisional = false;
}

/** the most recent segment of a kind (open or closed) */
function lastOf(track: TimelineTrack, kind: TimelineSegmentKind): TimelineSegment | null {
  for (let i = track.segments.length - 1; i >= 0; i--) if (track.segments[i].kind === kind) return track.segments[i];
  return null;
}

function onTransition(track: TimelineTrack, e: AuditEvent) {
  const d = e.data ?? {};
  const to = d.to as TaskStatus | undefined;
  if (!to) return;
  const from = (d.from as TaskStatus | null | undefined) ?? null;
  const cur = openSeg(track);
  // a turn that parked in `waiting` and comes back is the same turn
  const resumedTurn = from === 'waiting' && to === 'running' ? lastOf(track, 'waiting') : null;
  const turnBefore = resumedTurn ? track.segments[track.segments.indexOf(resumedTurn) - 1] : null;
  // the fix turn's transition follows its announcement within the resume; a
  // stale one (the resume was refused) must not relabel a later human turn
  const fix = track.pendingFix && ms(e.at) - ms(track.pendingFix.at) <= FIX_ANNOUNCE_MS ? track.pendingFix : null;
  track.status = to;

  // done → published: the change was already landed; one segment, status updated
  if (cur?.kind === 'landed' && (to === 'done' || to === 'published')) {
    cur.data = { ...cur.data, status: to, ...(to === 'published' ? { publishedAt: e.at } : {}), ...pick(d, ['observed', 'sha', 'landing', 'reason']) };
    return;
  }

  close(track, e.at, to);
  track.pendingFix = null;
  switch (to) {
    case 'queued':
      open(track, 'queued', e.at, pick(d, ['reason', 'featureId', 'featurePhase']));
      return;
    case 'running': {
      if (fix) {
        open(track, 'fixing', e.at, { fix: fix.reason, round: fix.round, actor: e.actor });
      } else if (turnBefore && TURN_KINDS.has(turnBefore.kind)) {
        open(track, turnBefore.kind, e.at, { ...pick(turnBefore.data, ['fix', 'round']), resumedFromWait: true, actor: e.actor }, turnBefore.runId);
      } else {
        open(track, 'running', e.at, { ...pick(d, ['claim', 'reason', 'loop']), actor: e.actor });
      }
      return;
    }
    case 'waiting':
      open(track, 'waiting', e.at, {});
      return;
    case 'review': {
      const data = pick(d, ['reason', 'reviewState', 'checkState', 'loop']);
      if (d.checkState === 'pending') open(track, 'checks', e.at, data);
      else if (d.reviewState === 'pending') open(track, 'review-round', e.at, data);
      else {
        open(track, 'idle-in-review', e.at, data);
        // the row did not say whether a round is due (older rows, pause, a stall park)
        track.provisional = !('reviewState' in d);
      }
      return;
    }
    case 'done':
    case 'published':
      open(track, 'landed', e.at, { status: to, ...pick(d, ['observed', 'sha', 'landing', 'reason']), actor: e.actor });
      return;
    case 'failed':
    case 'cancelled':
      marker(track, to, e.at, str(d.reason) ?? str(d.error), { from, actor: e.actor, ...pick(d, ['reason', 'error']) });
      return;
    default:
      // draft, blocked: not on the timeline — the task simply has no open segment
      return;
  }
}

function pick(d: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (d[k] !== undefined) out[k] = d[k];
  return out;
}

function onCreated(track: TimelineTrack, e: AuditEvent) {
  // a task created straight into `queued` has no transition row for it
  if (track.segments.length || e.data?.status !== 'queued') return;
  track.status = 'queued';
  open(track, 'queued', e.at, { created: true });
}

function onRunStarted(track: TimelineTrack, e: AuditEvent) {
  if (!e.runId) return;
  const d = e.data ?? {};
  const info = pick(d, ['handoff', 'model', 'loopIteration']);
  const cur = openSeg(track);
  if (cur && TURN_KINDS.has(cur.kind)) {
    if (!cur.runId) {
      cur.runId = e.runId;
      cur.data = { ...cur.data, ...info };
    } else if (cur.runId !== e.runId) {
      // a second run inside one running stretch (a loop iteration, a transient
      // resume): one segment per run
      const kind = cur.kind;
      const carry = pick(cur.data, ['fix', 'round']);
      close(track, e.at, 'next-run');
      open(track, kind, e.at, { ...carry, ...info }, e.runId);
    }
    return;
  }
  if (!cur && track.status === null) {
    // no transition seen (the task's state before the window is unknown): the
    // run says it was running
    track.status = 'running';
    open(track, 'running', e.at, info, e.runId);
  }
}

function onFollowUp(track: TimelineTrack, e: AuditEvent) {
  const d = e.data ?? {};
  const reason = str(d.reason);
  if (reason) {
    track.pendingFix = { reason, round: d.round ?? null, at: e.at };
    return;
  }
  // followUp's own row comes right AFTER its transition to running
  const cur = openSeg(track);
  if (cur && TURN_KINDS.has(cur.kind) && d.purpose === 'publish') cur.data = { ...cur.data, publish: true };
}

function onChecked(track: TimelineTrack, e: AuditEvent) {
  const d = e.data ?? {};
  const cur = openSeg(track);
  if (!cur || !REVIEW_KINDS.has(cur.kind)) return; // a loop's checks run while `running`
  const skipped = str(d.skipped);
  const isStage = cur.kind === 'checks' || (cur.kind === 'idle-in-review' && track.provisional);
  if (!isStage) {
    cur.data = { ...cur.data, checkState: d.state ?? null };
    return;
  }
  if (skipped && cur.kind !== 'checks') return; // nothing ran: the guess stands for the review that may follow
  cur.kind = 'checks';
  cur.data = {
    ...cur.data,
    checkState: d.state ?? null,
    ...pick(d, ['round', 'stop', 'skipped']),
    ...(Array.isArray(d.results) ? { checks: d.results.length } : {}),
  };
  close(track, e.at, skipped ? `skipped:${skipped}` : str(d.state));
  // a red with a fix turn coming, or a green/error with a review round that may follow
  open(track, 'idle-in-review', e.at, {});
  track.provisional = !d.stop;
}

function onReviewed(track: TimelineTrack, e: AuditEvent) {
  const d = e.data ?? {};
  const cur = openSeg(track);
  if (!cur || !REVIEW_KINDS.has(cur.kind)) return;
  const skipped = str(d.skipped);
  const verdict = pick(d, ['verdict', 'round', 'fixRound', 'actionable', 'model', 'skipped', 'state', 'stop', 'requestedBy']);
  if (Array.isArray(d.findings)) verdict.findings = d.findings.length;
  if (skipped === 'checks-red') {
    // no reviewer: the checks stayed red
    cur.data = { ...cur.data, ...verdict };
    track.provisional = false;
    return;
  }
  const isRound = cur.kind === 'review-round' || (cur.kind === 'idle-in-review' && track.provisional);
  if (!isRound) {
    cur.data = { ...cur.data, lastReview: verdict };
    return;
  }
  cur.kind = 'review-round';
  cur.data = { ...cur.data, ...verdict };
  close(track, e.at, str(d.state) ?? (skipped ? `skipped:${skipped}` : str(d.verdict)));
  open(track, 'idle-in-review', e.at, {});
  // `fixing`: the fix turn follows at once; the idle sliver until it is real
}

function onReviewRequested(track: TimelineTrack, e: AuditEvent) {
  const cur = openSeg(track);
  if (!cur || cur.kind !== 'idle-in-review') return; // Review now on done/failed changes no status
  close(track, e.at, 'review-requested');
  open(track, 'review-round', e.at, { requested: true, actor: e.actor });
}

function onWaiting(track: TimelineTrack, e: AuditEvent) {
  const d = e.data ?? {};
  const cur = openSeg(track);
  if ('children' in d && !d.stale && cur?.kind === 'waiting') {
    cur.data = { ...cur.data, ...pick(d, ['children', 'shells']) };
    return;
  }
  const end = str(d.resumed) ?? (str(d.expired) ? `expired:${d.expired}` : d.stale ? 'stale' : undefined);
  if (!end) return; // `ignored` shells: no state change
  const seg = lastOf(track, 'waiting');
  if (seg) seg.data = { ...seg.data, ended: end, ...pick(d, ['waitedMs']) };
}

function onLand(track: TimelineTrack, e: AuditEvent) {
  const cur = openSeg(track) ?? track.segments[track.segments.length - 1];
  if (!cur) return;
  const d = e.data ?? {};
  if (e.kind === 'task.shipped') cur.data = { ...cur.data, shippedSha: d.sha ?? null };
  else if (e.kind === 'task.landing') cur.data = { ...cur.data, landingPhase: d.phase ?? null, ...pick(d, ['landing']) };
  else cur.data = { ...cur.data, landPhase: d.phase ?? null };
}

function track(state: TimelineState, e: AuditEvent): TimelineTrack | null {
  if (!e.taskId) return null;
  let t = state.tasks[e.taskId];
  if (!t) {
    t = { taskId: e.taskId, repoId: e.repoId, segments: [], open: false, provisional: false, pendingFix: null, status: null };
    state.tasks[e.taskId] = t;
  } else if (!t.repoId && e.repoId) t.repoId = e.repoId;
  return t;
}

/** a deleted task's open stretch ends at the deletion (the row carries no repo: the route fetches it by task) */
function onDeleted(track: TimelineTrack, e: AuditEvent) {
  close(track, e.at, 'deleted');
  track.pendingFix = null;
}

/** mutating fold step (the batch build); `foldEvent` is the copy-on-write form */
function foldInto(state: TimelineState, e: AuditEvent): void {
  if (state.lastEventId !== null && e.id <= state.lastEventId) return;
  state.lastEventId = e.id;
  if (!TIMELINE_KIND_SET.has(e.kind)) return;
  const t = track(state, e);
  if (!t) return;
  switch (e.kind) {
    case 'task.created':
      return onCreated(t, e);
    case 'task.transition':
      return onTransition(t, e);
    case 'run.started':
      return onRunStarted(t, e);
    case 'task.follow-up':
      return onFollowUp(t, e);
    case 'task.checked':
      return onChecked(t, e);
    case 'run.reviewed':
      return onReviewed(t, e);
    case 'task.review-requested':
      return onReviewRequested(t, e);
    case 'task.waiting':
      return onWaiting(t, e);
    case 'task.land':
    case 'task.landing':
    case 'task.shipped':
      return onLand(t, e);
    case 'task.deleted':
      return onDeleted(t, e);
  }
}

const TIMELINE_KIND_SET: ReadonlySet<string> = new Set(TIMELINE_EVENT_KINDS);

/**
 * Append one audit row (oldest first; a row at or below the newest one folded
 * is a duplicate and ignored). Copy-on-write: the touched task's track is
 * replaced, every other track keeps its identity — React-friendly.
 */
export function foldEvent(state: TimelineState, e: AuditEvent): TimelineState {
  if (state.lastEventId !== null && e.id <= state.lastEventId) return state;
  const prev = e.taskId ? state.tasks[e.taskId] : undefined;
  const next: TimelineState = { ...state, tasks: { ...state.tasks } };
  if (prev) {
    next.tasks[prev.taskId] = {
      ...prev,
      pendingFix: prev.pendingFix ? { ...prev.pendingFix } : null,
      segments: prev.segments.map((s) => ({ ...s, data: { ...s.data } })),
    };
  }
  foldInto(next, e);
  return next;
}

/** add or replace a run (the SPA's `run.updated`); runs only fill in missing runIds */
export function foldRun(state: TimelineState, run: Run): TimelineState {
  return { ...state, runs: { ...state.runs, [run.id]: run } };
}

const ms = (iso: string) => Date.parse(iso);

/** a run of the task that started inside the segment */
function runFor(seg: TimelineSegment, runs: Run[], endMs: number): string | undefined {
  const startMs = ms(seg.start);
  const wantReview = seg.kind === 'review-round';
  for (const r of runs) {
    const mine = wantReview ? r.mode === 'aux' && r.kind === 'review' && r.subjectId === seg.taskId : r.mode === 'worker' && r.taskId === seg.taskId;
    if (!mine) continue;
    const t = ms(r.startedAt);
    if (t >= startMs && t <= endMs) return r.id;
  }
  return undefined;
}

/**
 * The segments per task, clipped to the window: a segment that ended before
 * `since` is dropped, one that began before it starts at `since`
 * (`clippedStart`); one still open is `end: null` when the window reaches
 * `now`, else ends at `until` (`clippedEnd`). Running/fixing stretches without
 * a `run.started` row, and review rounds, get their run from `state.runs`.
 */
export function timelineSegments(state: TimelineState, win: TimelineWindow): Record<string, TimelineSegment[]> {
  const sinceMs = ms(win.since);
  const untilMs = ms(win.until);
  const live = untilMs >= ms(win.now);
  const runs = Object.values(state.runs).sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  const out: Record<string, TimelineSegment[]> = {};
  for (const t of Object.values(state.tasks)) {
    const segs: TimelineSegment[] = [];
    for (const s of t.segments) {
      const startMs = ms(s.start);
      const endMs = s.end === null ? Infinity : ms(s.end);
      if (startMs > untilMs) continue;
      const marker = s.kind === 'failed' || s.kind === 'cancelled';
      if (marker ? startMs < sinceMs : endMs <= sinceMs) continue;
      const seg: TimelineSegment = { ...s, data: { ...s.data } };
      if (startMs < sinceMs) {
        seg.start = win.since;
        seg.clippedStart = true;
      }
      if (seg.end === null && !live) {
        seg.end = win.until;
        seg.clippedEnd = true;
      } else if (seg.end !== null && endMs > untilMs) {
        // the window did not see it end
        seg.end = win.until;
        seg.clippedEnd = true;
        delete seg.outcome;
      }
      if (!seg.runId && (TURN_KINDS.has(seg.kind) || seg.kind === 'review-round')) {
        const id = runFor(s, runs, endMs);
        if (id) seg.runId = id;
      }
      segs.push(seg);
    }
    if (segs.length) out[t.taskId] = segs;
  }
  return out;
}

/** events oldest first: ids are time-sortable and keep insertion order within a millisecond */
export function sortEvents(events: readonly AuditEvent[]): AuditEvent[] {
  return [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** batch build — exactly `foldEvent` over the sorted events, then `timelineSegments` */
export function buildTaskSegments(
  events: readonly AuditEvent[],
  runs: readonly Run[],
  win: TimelineWindow,
): Record<string, TimelineSegment[]> {
  const state = initTimeline();
  for (const r of runs) state.runs[r.id] = r;
  for (const e of sortEvents(events)) foldInto(state, e);
  return timelineSegments(state, win);
}

export interface TimelineStateAt {
  running: string[];
  waiting: string[];
  inReview: string[];
  checking: string[];
  queued: string[];
  landed: string[];
}

/**
 * Which tasks were where at time T. A segment holds [start, end); an open one
 * holds everything after its start. `running` counts fix turns too; `inReview`
 * is a review round or an idle review (checks are `checking`); markers hold no
 * time.
 */
export function stateAt(segmentsByTask: Record<string, readonly TimelineSegment[]>, at: string | number | Date): TimelineStateAt {
  const T = typeof at === 'number' ? at : at instanceof Date ? at.getTime() : ms(at);
  const res: TimelineStateAt = { running: [], waiting: [], inReview: [], checking: [], queued: [], landed: [] };
  for (const [taskId, segs] of Object.entries(segmentsByTask)) {
    const s = segs.find((x) => ms(x.start) <= T && (x.end === null || T < ms(x.end)));
    if (!s) continue;
    switch (s.kind) {
      case 'running':
      case 'fixing':
        res.running.push(taskId);
        break;
      case 'waiting':
        res.waiting.push(taskId);
        break;
      case 'review-round':
      case 'idle-in-review':
        res.inReview.push(taskId);
        break;
      case 'checks':
        res.checking.push(taskId);
        break;
      case 'queued':
        res.queued.push(taskId);
        break;
      case 'landed':
        res.landed.push(taskId);
        break;
    }
  }
  return res;
}
