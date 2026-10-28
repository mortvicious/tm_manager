/**
 * Workspaces (docs/workspaces.md) — the SQL both drivers run verbatim, so a
 * column added here cannot land in one driver and not the other.
 * Dialect-neutral with `?` placeholders (the pg driver rewrites them).
 */
import type { WorkspacePatch } from './types.ts';

/** Explicit `sort_order` — migration 49's seed. */
export const WORKSPACE_INSERT_SQL = `INSERT INTO tm_workspaces (id, name, slug, repo_ids, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

/** A new workspace goes LAST in the switcher (max + 1, 0 for the first). */
export const WORKSPACE_APPEND_SQL = `INSERT INTO tm_workspaces (id, name, slug, repo_ids, color, sort_order, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tm_workspaces), ?, ?)`;

export const WORKSPACE_LIST_SQL = `SELECT * FROM tm_workspaces ORDER BY sort_order ASC, name ASC, id ASC`;

export const WORKSPACE_SORT_SQL = `UPDATE tm_workspaces SET sort_order = ?, updated_at = ? WHERE id = ?`;

export function workspacePatchColumns(patch: WorkspacePatch): [string, unknown][] {
  const out: [string, unknown][] = [];
  if (patch.name !== undefined) out.push(['name', patch.name]);
  if (patch.slug !== undefined) out.push(['slug', patch.slug]);
  if (patch.repoIds !== undefined) out.push(['repo_ids', JSON.stringify(patch.repoIds)]);
  if (patch.color !== undefined) out.push(['color', patch.color]);
  return out;
}

/**
 * `reorderWorkspaces`' target positions: the listed ids first, in that
 * order, then every unlisted workspace in its current order (a workspace
 * created while the human dragged is not thrown to the top).
 */
export function workspaceOrder(current: readonly { id: string }[], ids: readonly string[]): string[] {
  const known = new Set(current.map((w) => w.id));
  const listed = [...new Set(ids)].filter((id) => known.has(id));
  const seen = new Set(listed);
  return [...listed, ...current.filter((w) => !seen.has(w.id)).map((w) => w.id)];
}

/** A unique-index violation on either driver (SQLite's constraint code, Postgres' 23505). */
export function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === '23505';
}
