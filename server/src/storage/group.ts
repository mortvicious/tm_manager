// Task-group bookkeeping shared verbatim by BOTH storage drivers (docs/grouping.md).
//
// Every task row carries `group_id` (the id of its root ancestor) and
// `group_path` (the ancestor ids root-first, '/'-delimited with a leading AND
// trailing slash: '/' for a root, '/rootId/' for its child). The pair is
// denormalized on purpose: the board needs the whole tree of a task in one
// query, and neither driver may rely on a recursive CTE (better-sqlite3 is
// sync-only and Postgres is a second dialect to keep in step).
//
// Invariants, enforced on every write path:
//   root:  group_id = id, group_path = '/'
//   child: group_id = parent.group_id, group_path = parent.group_path + parent.id + '/'
// A node's own children therefore all share `childPrefix(node)`, which is what
// makes a subtree a single LIKE-prefix range.

export const ROOT_PATH = '/';

/** The `group_path` every direct child of `parentPath` + `parentId` carries. */
export function childPrefix(parentPath: string, parentId: string): string {
  return `${parentPath}${parentId}/`;
}

/** Ancestor ids in a `group_path`, root first. */
export function pathIds(groupPath: string): string[] {
  return groupPath.split('/').filter(Boolean);
}

/** Would parenting `id` under a node with this path create a cycle? */
export function pathContains(groupPath: string, id: string): boolean {
  return pathIds(groupPath).includes(id);
}

/** Where a task lands when re-parented (or promoted to a root with `parent = null`). */
export function placement(
  id: string,
  parent: { id: string; group_id: string; group_path: string } | null,
): { groupId: string; groupPath: string } {
  if (!parent) return { groupId: id, groupPath: ROOT_PATH };
  return { groupId: parent.group_id, groupPath: childPrefix(parent.group_path, parent.id) };
}

/**
 * The one statement that moves a whole subtree. Rows under `node` keep the
 * tail of their path below the node and get the node's new prefix instead:
 *
 *   node '/a/'  ->  '/b/c/'      grandchild '/a/N/x/'  ->  '/b/c/N/x/'
 *
 * `?` placeholders only (the Postgres driver rewrites them), and no `?` inside
 * a string literal — the house rule for dialect-neutral SQL.
 */
export const MOVE_SUBTREE_SQL = `UPDATE tm_tasks
     SET group_id = ?, group_path = ? || substr(group_path, ?), updated_at = ?
   WHERE group_path LIKE ?`;

/** Params for MOVE_SUBTREE_SQL: descendants of `node` re-based onto `next`. */
export function moveSubtreeParams(
  node: { id: string; group_path: string },
  next: { groupId: string; groupPath: string },
  ts: string,
): unknown[] {
  const oldPrefix = childPrefix(node.group_path, node.id);
  const newPrefix = childPrefix(next.groupPath, node.id);
  // substr() is 1-based in both dialects, so the tail starts one past the prefix.
  return [next.groupId, newPrefix, oldPrefix.length + 1, ts, `${oldPrefix}%`];
}
