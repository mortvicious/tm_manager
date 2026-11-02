import { buildTaskSegments, HISTORY_EVENT_KINDS, TIMELINE_EVENT_KINDS, type AuditEvent, type Dispatch, type Run, type Task, type TimelineSegment } from '@tm/shared';

/**
 * The History tab's data path, pure (docs/timeline.md § The History tab): which
 * live rows belong to a task's `/history` answer, how they merge into it, and
 * the segments re-folded over the merged rows. `TaskHistory.tsx` holds the
 * subscription and the rendering.
 */

const HISTORY_KINDS: ReadonlySet<string> = new Set(HISTORY_EVENT_KINDS);
const TIMELINE_KINDS: ReadonlySet<string> = new Set(TIMELINE_EVENT_KINDS);

export interface Rows {
  events: AuditEvent[];
  runs: Run[];
  dispatches: Dispatch[];
  truncated: boolean;
}

export type RowsPatch = { events?: AuditEvent[]; runs?: Run[]; dispatches?: Dispatch[] };

/** an `event.appended` row the task's `/history` would carry */
export function historyEvent(e: AuditEvent, taskId: string): boolean {
  return e.taskId === taskId && HISTORY_KINDS.has(e.kind);
}

/** the runs the server's `/history` carries (routes/timeline.ts `loadTaskHistory`) */
export function historyRun(r: Run, taskId: string): boolean {
  const mine = r.taskId === taskId || (r.mode === 'aux' && r.subjectId === taskId);
  return mine && (r.mode === 'worker' || r.kind === 'review' || r.kind === 'compact');
}

/** merge by id; a later copy of a run/dispatch (updated, exited) replaces the earlier one */
function mergeById<T extends { id: string }>(base: readonly T[], more: readonly T[]): T[] {
  if (!more.length) return base as T[];
  const map = new Map(base.map((r) => [r.id, r]));
  for (const r of more) map.set(r.id, r);
  return [...map.values()];
}

export const byId = (a: AuditEvent, b: AuditEvent) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function mergeRows(rows: Rows, add: RowsPatch): Rows {
  const events = add.events?.length ? mergeById(rows.events, add.events).sort(byId) : rows.events;
  return {
    events,
    runs: mergeById(rows.runs, add.runs ?? []),
    dispatches: mergeById(rows.dispatches, add.dispatches ?? []),
    truncated: rows.truncated,
  };
}

/**
 * The fold over the merged `TIMELINE_EVENT_KINDS` rows, from the task's creation
 * (or its oldest row: a truncated answer's seed) to now — what the server
 * returned as `segments`, moved by every live row.
 */
export function historySegments(rows: Rows, task: Pick<Task, 'id' | 'createdAt'>, nowIso: string): TimelineSegment[] {
  const fold = rows.events.filter((e) => TIMELINE_KINDS.has(e.kind));
  const since = fold.length && fold[0].at < task.createdAt ? fold[0].at : task.createdAt;
  const last = rows.events.length ? rows.events[rows.events.length - 1].at : nowIso;
  const until = last > nowIso ? last : nowIso;
  return buildTaskSegments(fold, rows.runs, { since, until, now: until })[task.id] ?? [];
}
