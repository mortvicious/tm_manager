// Event and run list SQL, shared verbatim by both drivers (dialect-neutral,
// `?` placeholders only — the pg driver rewrites them to `$n`). One builder so
// the two drivers' filters cannot drift (docs/timeline.md).
import type { AuditKind } from '@tm/shared';
import type { EventFilter, RunFilter } from './types.ts';

/** `listEvents` hard row cap (the timeline asks for up to TIMELINE_ROW_CAP + 1) */
export const EVENT_LIST_MAX = 50_000;

/** `col IN (?, …)`; an EMPTY list matches nothing (`1 = 0` keeps the query's shape) */
function inList(where: string[], params: unknown[], col: string, values: readonly string[]) {
  if (values.length === 0) where.push(`1 = 0`);
  else {
    where.push(`${col} IN (${values.map(() => '?').join(', ')})`);
    params.push(...values);
  }
}

export function eventListSql(f?: EventFilter): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f?.kind) {
    where.push(`kind = ?`);
    params.push(f.kind);
  }
  if (f?.kinds) inList(where, params, 'kind', f.kinds);
  if (f?.actor) {
    where.push(`actor = ?`);
    params.push(f.actor);
  }
  if (f?.taskId) {
    where.push(`task_id = ?`);
    params.push(f.taskId);
  }
  if (f?.taskIds) inList(where, params, 'task_id', f.taskIds);
  if (f?.repoIds) inList(where, params, 'repo_id', f.repoIds);
  if (f?.since) {
    where.push(`at >= ?`);
    params.push(f.since);
  }
  if (f?.until) {
    where.push(`at < ?`);
    params.push(f.until);
  }
  params.push(Math.min(f?.limit ?? 100, EVENT_LIST_MAX));
  const sql = `SELECT * FROM tm_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  return { sql, params };
}

/**
 * Each task's newest `anchorKinds` row before `before` (id is time-sortable,
 * so MAX(id) is the newest) plus every `kinds` row of that task after it and
 * still before `before` — the stint the task entered the window in, so a
 * review/checks verdict that settled before the window is folded too. All
 * three lists non-empty.
 */
export function taskSeedEventsSql(
  anchorKinds: readonly AuditKind[],
  kinds: readonly AuditKind[],
  taskIds: readonly string[],
  before: string,
): { sql: string; params: unknown[] } {
  const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');
  const sql = `SELECT e.* FROM tm_events e
    JOIN (
      SELECT i.task_id AS seed_task, MAX(i.id) AS anchor_id FROM tm_events i
      WHERE i.kind IN (${marks(anchorKinds.length)}) AND i.at < ? AND i.task_id IN (${marks(taskIds.length)})
      GROUP BY i.task_id
    ) s ON e.task_id = s.seed_task
    WHERE (e.id = s.anchor_id OR (e.id > s.anchor_id AND e.kind IN (${marks(kinds.length)}) AND e.at < ?))
    ORDER BY e.id`;
  return { sql, params: [...anchorKinds, before, ...taskIds, ...kinds, before] };
}

/**
 * EVERY task's newest `anchorKinds` row before `before` — what state each task
 * was in at that instant, so the timeline can list the tasks that sat in one
 * state through the whole window (no row, no run inside it). `repoIds` scopes
 * by the anchor row's repo (an empty list matches nothing). `anchorKinds` non-empty.
 */
export function taskAnchorsSql(anchorKinds: readonly AuditKind[], before: string, repoIds?: readonly string[]): { sql: string; params: unknown[] } {
  const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');
  const where: string[] = [];
  const params: unknown[] = [...anchorKinds, before];
  if (repoIds) inList(where, params, 'e.repo_id', repoIds);
  const sql = `SELECT e.* FROM tm_events e
    WHERE e.id IN (
      SELECT MAX(i.id) FROM tm_events i
      WHERE i.kind IN (${marks(anchorKinds.length)}) AND i.at < ? AND i.task_id IS NOT NULL
      GROUP BY i.task_id
    )${where.length ? ' AND ' + where.join(' AND ') : ''}
    ORDER BY e.id`;
  return { sql, params };
}

export function runListSql(f?: RunFilter): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const eq = (col: string, v: unknown) => {
    where.push(`${col} = ?`);
    params.push(v);
  };
  if (f?.taskId) eq('task_id', f.taskId);
  if (f?.repoId) eq('repo_id', f.repoId);
  if (f?.status) eq('status', f.status);
  if (f?.mode) eq('mode', f.mode);
  if (f?.kind) eq('kind', f.kind);
  if (f?.subjectId) eq('subject_id', f.subjectId);
  if (f?.repoIds) inList(where, params, 'repo_id', f.repoIds);
  if (f?.since) {
    where.push(`started_at >= ?`);
    params.push(f.since);
  }
  if (f?.until) {
    where.push(`started_at < ?`);
    params.push(f.until);
  }
  if (f?.activeSince) {
    where.push(`(ended_at IS NULL OR ended_at >= ?)`);
    params.push(f.activeSince);
  }
  let sql = `SELECT * FROM tm_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC, id DESC`;
  if (f?.limit != null) {
    sql += ` LIMIT ?`;
    params.push(f.limit);
  }
  return { sql, params };
}
