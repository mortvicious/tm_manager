import { repoParallelCap, type PredictedSlot, type Repo, type ScheduledSlot, type TimelineSegment, type TimelineSegmentKind } from '@tm/shared';
import { assignLanes } from '../../timeline.ts';
import { segmentEnd, type Lookup } from './format.ts';

/**
 * The desktop tracks' geometry in TIME (docs/timeline.md § Tracks) — pure, so
 * the component only maps it to px for the visible window. One row per repo;
 * on a row, a task's past is cut into BARS (a maximal run of active segments:
 * a worker turn and the verify round it parks into), each followed by the idle
 * stretch it left behind (its TAIL, drawn thin and under the next bar — a
 * settled review does not hold the repo, so the next task runs over it) and
 * the marker it ended on. Predicted slots are GHOSTS after NOW. Lanes come
 * from `assignLanes` over the bars' active intervals and the ghosts.
 */

/** what a bar's fill says about how it ended */
export type BarOutcome = 'running' | 'review' | 'done' | 'published' | 'failed' | 'cancelled' | 'queued';

const ACTIVE: ReadonlySet<TimelineSegmentKind> = new Set(['running', 'waiting', 'review-round', 'checks', 'fixing']);
const MARKERS: ReadonlySet<TimelineSegmentKind> = new Set(['landed', 'failed', 'cancelled']);

export interface TrackBar {
  key: string;
  taskId: string;
  /** the active interval (epoch ms): what holds the lane */
  start: number;
  end: number;
  /** the active segments, oldest first (empty for a bar that is only a tail or a marker) */
  segs: TimelineSegment[];
  /** idle-in-review stretches after the active part */
  tail: TimelineSegment[];
  /** landed / failed / cancelled it ended on */
  marker: TimelineSegment | null;
  outcome: BarOutcome;
  /** the last active segment is still open */
  live: boolean;
  /** drawn extent, tail and marker included — what the visible-window cull reads */
  extentEnd: number;
  lane: number;
}

export interface TrackGhost {
  key: string;
  slot: ScheduledSlot;
  start: number;
  /** the work segment's end */
  workEnd: number;
  /** the last `after` segment's end (= workEnd without one) */
  end: number;
  lane: number;
}

export interface TrackRow {
  key: string;
  repoId: string | null;
  name: string;
  /** the repo's parallel cap (1 unless a pr repo with `parallel` 2–3) */
  cap: number;
  lanes: number;
  bars: TrackBar[];
  ghosts: TrackGhost[];
}

export interface TrackLayout {
  rows: TrackRow[];
  /** latest drawn instant (bars, tails, ghosts) */
  lastAt: number;
  /** per task: running + waiting + fixing inside the window */
  workedMs: Record<string, number>;
}

function outcomeOf(bar: Pick<TrackBar, 'segs' | 'tail' | 'marker' | 'live'>): BarOutcome {
  const m = bar.marker;
  if (m?.kind === 'landed') return m.data.status === 'published' ? 'published' : 'done';
  if (m?.kind === 'failed') return 'failed';
  if (m?.kind === 'cancelled') return 'cancelled';
  if (bar.live) return 'running';
  if (bar.tail.length) return 'review';
  // the next status the last stretch moved to (an Undo → queued, a park in review …)
  const next = bar.segs[bar.segs.length - 1]?.outcome;
  if (next === 'queued' || next === 'draft') return 'queued';
  if (next === 'failed') return 'failed';
  if (next === 'cancelled') return 'cancelled';
  return 'review';
}

/** a task's segments as bars (lane still 0) */
export function taskBars(taskId: string, segs: readonly TimelineSegment[], now: number): TrackBar[] {
  type Draft = Omit<TrackBar, 'outcome' | 'extentEnd' | 'start' | 'end'>;
  const bars: Draft[] = [];
  let cur: Draft | null = null;
  // set once the current bar has gone idle/ended: the next active segment opens a new bar
  let broken = true;
  const fresh = (): Draft => {
    const b: Draft = { key: `${taskId}:${bars.length}`, taskId, segs: [], tail: [], marker: null, live: false, lane: 0 };
    bars.push(b);
    return b;
  };
  for (const s of segs) {
    if (ACTIVE.has(s.kind)) {
      if (broken || !cur) cur = fresh();
      cur.segs.push(s);
      broken = false;
    } else if (s.kind === 'idle-in-review') {
      // idle from the window's start (or after a marker): a tail-only bar
      if (!cur || cur.marker) cur = fresh();
      cur.tail.push(s);
      broken = true;
    } else if (MARKERS.has(s.kind)) {
      if (!cur || cur.marker) cur = fresh();
      cur.marker = s;
      broken = true;
    } else {
      // queued: not drawn (the ghost shows when it is predicted to start); it ends the bar
      broken = true;
    }
  }
  return bars.map((b) => {
    const last = b.segs[b.segs.length - 1];
    const live = !!last && last.end === null;
    const first = b.segs[0] ?? b.tail[0] ?? b.marker!;
    const start = Date.parse(first.start);
    // a bar with no active part holds no lane time
    const end = last ? segmentEnd(last, now) : start;
    const tailEnd = b.tail.length ? segmentEnd(b.tail[b.tail.length - 1], now) : end;
    const markerAt = b.marker ? Date.parse(b.marker.start) : end;
    const withLive = { ...b, live };
    return { ...withLive, start, end, outcome: outcomeOf(withLive), extentEnd: Math.max(end, tailEnd, markerAt) };
  });
}

const WORKED: ReadonlySet<TimelineSegmentKind> = new Set(['running', 'waiting', 'fixing']);

export function buildTrackLayout(input: {
  segments: Record<string, TimelineSegment[]>;
  predicted: readonly PredictedSlot[];
  /** the workspace's repos, in display order */
  repos: readonly Pick<Repo, 'id' | 'parallel' | 'delivery'>[];
  names: Lookup;
  now: number;
}): TrackLayout {
  const { segments, predicted, repos, names, now } = input;
  const rows = new Map<string, TrackRow>();
  const rowKey = (repoId: string | null) => repoId ?? '—';
  const rowFor = (repoId: string | null): TrackRow => {
    const key = rowKey(repoId);
    let row = rows.get(key);
    if (!row) {
      const repo = repoId ? repos.find((r) => r.id === repoId) : undefined;
      row = {
        key,
        repoId,
        name: repoId ? (names.repo(repoId) ?? `repo ${repoId.slice(0, 8)}`) : 'no repo',
        cap: repo ? repoParallelCap(repo) : 1,
        lanes: 1,
        bars: [],
        ghosts: [],
      };
      rows.set(key, row);
    }
    return row;
  };
  // every workspace repo has a track, busy or not, in the given order
  for (const r of repos) rowFor(r.id);

  const workedMs: Record<string, number> = {};
  let lastAt = now;
  for (const [taskId, segs] of Object.entries(segments)) {
    if (!segs.length) continue;
    let worked = 0;
    for (const s of segs) if (WORKED.has(s.kind)) worked += segmentEnd(s, now) - Date.parse(s.start);
    workedMs[taskId] = worked;
    const row = rowFor(segs[0].repoId);
    for (const b of taskBars(taskId, segs, now)) {
      row.bars.push(b);
      lastAt = Math.max(lastAt, b.extentEnd);
    }
  }
  for (const p of predicted) {
    if (!p.scheduled) continue;
    const start = Date.parse(p.start);
    const workEnd = Date.parse(p.end);
    const end = p.after.length ? Date.parse(p.after[p.after.length - 1].end) : workEnd;
    rowFor(p.repoId).ghosts.push({ key: `g:${p.taskId}`, slot: p, start, workEnd, end, lane: 0 });
    lastAt = Math.max(lastAt, end);
  }

  for (const row of rows.values()) {
    // a live bar and the ghost that continues it are one interval on one lane
    const liveBar = new Map(row.bars.filter((b) => b.live).map((b) => [b.taskId, b]));
    const items: { start: number; end: number }[] = row.bars.map((b) => ({ start: b.start, end: b.end }));
    const ghostOwn: TrackGhost[] = [];
    for (const g of row.ghosts) {
      const b = liveBar.get(g.slot.taskId);
      if (b) items[row.bars.indexOf(b)].end = Math.max(b.end, g.end);
      else ghostOwn.push(g);
    }
    for (const g of ghostOwn) items.push({ start: g.start, end: g.end });
    const { lanes, count } = assignLanes(items, row.cap);
    row.bars.forEach((b, i) => (b.lane = lanes[i]));
    ghostOwn.forEach((g, i) => (g.lane = lanes[row.bars.length + i]));
    for (const g of row.ghosts) {
      const b = liveBar.get(g.slot.taskId);
      if (b) g.lane = b.lane;
    }
    row.lanes = count;
  }
  return { rows: [...rows.values()], lastAt, workedMs };
}

/** the segment of a bar under the time `t` (the nearest one past either end) */
export function segmentAt(bar: TrackBar, t: number, now: number): TimelineSegment {
  const all = [...bar.segs, ...bar.tail];
  if (!all.length) return bar.marker!;
  for (const s of all) if (t >= Date.parse(s.start) && t <= segmentEnd(s, now)) return s;
  return t < Date.parse(all[0].start) ? all[0] : all[all.length - 1];
}
