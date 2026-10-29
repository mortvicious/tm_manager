import type { BarOutcome } from './layout.ts';
import type { PredictedSlot, Repo, ScheduleAfter, ScheduleSource, Task, TimelineSegment, TimelineSegmentKind } from '@tm/shared';

/**
 * Words and colours shared by the two timeline views (TimelineTracks on the
 * desktop, TimelineStream on a phone) — docs/timeline.md § SPA. Colours are
 * `--tm-*` tokens only.
 */

export const SEGMENT_LABEL: Record<TimelineSegmentKind, string> = {
  queued: 'queued',
  running: 'running',
  waiting: 'waiting',
  'review-round': 'review round',
  checks: 'checks',
  fixing: 'fixing',
  'idle-in-review': 'idle in review',
  landed: 'landed',
  failed: 'failed',
  cancelled: 'cancelled',
};

export const SEGMENT_COLOR: Record<TimelineSegmentKind, string> = {
  queued: 'var(--tm-status-queued)',
  running: 'var(--tm-status-running)',
  waiting: 'var(--tm-status-attention)',
  'review-round': 'var(--tm-status-review)',
  checks: 'var(--tm-tl-checks)',
  fixing: 'var(--tm-tl-fixing)',
  'idle-in-review': 'var(--tm-text-faint)',
  landed: 'var(--tm-status-done)',
  failed: 'var(--tm-status-failed)',
  cancelled: 'var(--tm-text-faint)',
};

/** a track bar's fill: how the stretch ended (layout.ts `BarOutcome`) */
export const OUTCOME_COLOR: Record<BarOutcome, string> = {
  running: 'var(--tm-status-running)',
  review: 'var(--tm-status-review)',
  done: 'var(--tm-status-done)',
  published: 'var(--tm-status-published)',
  failed: 'var(--tm-status-failed)',
  cancelled: 'var(--tm-text-faint)',
  queued: 'var(--tm-status-queued)',
};

/** a ghost's stretches after the work */
export const AFTER_COLOR: Record<ScheduleAfter['kind'], string> = {
  checks: 'var(--tm-tl-checks)',
  review: 'var(--tm-status-review)',
  publish: 'var(--tm-status-published)',
};

export const SOURCE_LABEL: Record<ScheduleSource, string> = {
  running: 'running now',
  resume: 'resumes (paused turn)',
  'custom-queue': 'custom queue',
  loop: 'loop iteration',
  global: 'global queue',
  overflow: 'child of a live run',
  wake: 'wake-up',
};

export const AFTER_LABEL: Record<ScheduleAfter['kind'], string> = {
  checks: 'checks',
  review: 'review',
  publish: 'publish',
};

const pad = (n: number) => String(n).padStart(2, '0');

/** "14:05", or "Oct 27 14:05" when not on NOW's day */
export function clock(at: string | number, now: number): string {
  const d = new Date(at);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date(now).toDateString()
    ? t
    : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${t}`;
}

/** "45s", "38m", "2h 05m", "3d 4h" */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${pad(m % 60)}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "in 12m" / "now" / "12m ago" */
export function relative(at: string | number, now: number): string {
  const d = new Date(at).getTime() - now;
  if (Math.abs(d) < 60_000) return 'now';
  return d > 0 ? `in ${span(d)}` : `${span(-d)} ago`;
}

export function segmentEnd(s: TimelineSegment, now: number): number {
  return s.end === null ? now : Date.parse(s.end);
}

/** "14:05 → 14:43 · 38m", an open one "14:05 → now · 38m" */
export function segmentWhen(s: TimelineSegment, now: number): string {
  const start = Date.parse(s.start);
  if (s.kind === 'failed' || s.kind === 'cancelled') return clock(start, now);
  const end = segmentEnd(s, now);
  return `${clock(start, now)} → ${s.end === null ? 'now' : clock(end, now)} · ${span(end - start)}`;
}

/** the slot's ETA line: "14:05 → 14:43 (in 12m)" */
export function slotWhen(p: PredictedSlot, now: number): string | null {
  if (!p.scheduled) return null;
  const last = p.after.length ? p.after[p.after.length - 1].end : p.end;
  return `${clock(p.start, now)} → ${clock(last, now)} (${p.source === 'running' ? `ends ${relative(last, now)}` : `starts ${relative(p.start, now)}`})`;
}

export interface Lookup {
  task(id: string): Task | undefined;
  title(id: string): string;
  repo(id: string | null): string | null;
}

export function lookup(tasks: readonly Task[], repos: readonly Repo[]): Lookup {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const repoName = new Map(repos.map((r) => [r.id, r.name]));
  return {
    task: (id) => byId.get(id),
    title: (id) => byId.get(id)?.title ?? `task ${id.slice(0, 8)} (gone)`,
    repo: (id) => (id ? (repoName.get(id) ?? null) : null),
  };
}

/** past tracks, the task that moved most recently first (newest segment start: open ones all end at NOW) */
export function pastTracks(segments: Record<string, TimelineSegment[]>): [string, TimelineSegment[]][] {
  const last = (segs: TimelineSegment[]) => Math.max(...segs.map((s) => Date.parse(s.start)));
  return Object.entries(segments).sort((a, b) => last(b[1]) - last(a[1]));
}
