/**
 * Shared spaces (docs/shared-spaces.md) — the SQL both drivers run verbatim,
 * so a column or filter added here cannot land in one driver and not the
 * other. Dialect-neutral with `?` placeholders (the pg driver rewrites them).
 */
import type { SharedNoteFilter, SharedNotePatch, SpacePatch } from './types.ts';

export const SPACE_INSERT_SQL = `INSERT INTO tm_spaces (id, name, path, repo_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`;

export const SHARED_NOTE_INSERT_SQL = `INSERT INTO tm_shared_notes
  (id, space_id, kind, title, body, from_repo_id, from_task_id, to_repo_id, status, task_id, resolution, files, actor, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export function spacePatchColumns(patch: SpacePatch): [string, unknown][] {
  const out: [string, unknown][] = [];
  if (patch.name !== undefined) out.push(['name', patch.name]);
  if (patch.path !== undefined) out.push(['path', patch.path]);
  if (patch.repoIds !== undefined) out.push(['repo_ids', JSON.stringify(patch.repoIds)]);
  return out;
}

export function sharedNotePatchColumns(patch: SharedNotePatch): [string, unknown][] {
  const out: [string, unknown][] = [];
  if (patch.title !== undefined) out.push(['title', patch.title]);
  if (patch.body !== undefined) out.push(['body', patch.body]);
  if (patch.toRepoId !== undefined) out.push(['to_repo_id', patch.toRepoId]);
  if (patch.status !== undefined) out.push(['status', patch.status]);
  if (patch.taskId !== undefined) out.push(['task_id', patch.taskId]);
  if (patch.resolution !== undefined) out.push(['resolution', patch.resolution]);
  if (patch.files !== undefined) out.push(['files', JSON.stringify(patch.files)]);
  return out;
}

/**
 * `UPDATE … RETURNING *` for a note, conditional on its current status when
 * `fromStatus` is given — the claim that makes "file a task for this request"
 * single-winner (open → filed) without a generic transaction.
 */
export function sharedNoteUpdate(
  id: string,
  patch: SharedNotePatch,
  at: string,
  fromStatus?: readonly string[],
): { sql: string; params: unknown[] } | null {
  const cols = sharedNotePatchColumns(patch);
  if (cols.length === 0) return null;
  const sets = cols.map(([c]) => `${c} = ?`);
  const params: unknown[] = cols.map(([, v]) => v);
  sets.push('updated_at = ?');
  params.push(at, id);
  let where = 'id = ?';
  if (fromStatus && fromStatus.length > 0) {
    where += ` AND status IN (${fromStatus.map(() => '?').join(', ')})`;
    params.push(...fromStatus);
  }
  return { sql: `UPDATE tm_shared_notes SET ${sets.join(', ')} WHERE ${where} RETURNING *`, params };
}

export function sharedNoteListQuery(f: SharedNoteFilter): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.spaceId) {
    where.push('space_id = ?');
    params.push(f.spaceId);
  }
  if (f.kind) {
    where.push('kind = ?');
    params.push(f.kind);
  }
  if (f.status && f.status.length > 0) {
    where.push(`status IN (${f.status.map(() => '?').join(', ')})`);
    params.push(...f.status);
  }
  if (f.toRepoId !== undefined) {
    if (f.toRepoId === null) where.push('to_repo_id IS NULL');
    else {
      where.push('to_repo_id = ?');
      params.push(f.toRepoId);
    }
  }
  if (f.taskId) {
    where.push('task_id = ?');
    params.push(f.taskId);
  }
  if (f.createdAfter) {
    where.push('created_at > ?');
    params.push(f.createdAfter);
  }
  const limit = Math.max(1, Math.min(f.limit ?? 500, 2000));
  // Oldest first for open work (the forgotten ones matter most), newest first otherwise.
  const order = f.oldestFirst ? 'created_at ASC, id ASC' : 'created_at DESC, id DESC';
  return {
    sql: `SELECT * FROM tm_shared_notes${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ${limit}`,
    params,
  };
}
