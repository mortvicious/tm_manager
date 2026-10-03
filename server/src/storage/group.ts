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

// ---- manual order (docs/grouping.md § Order) ----
//
// `sort_order` ranks a task among its SIBLINGS — the rows sharing its parent,
// or all root rows. Keys are doubles: a move writes the midpoint between the
// two neighbours at the drop point, so a drag touches one row. Only when the
// neighbours are too close to split (or tied) is the sibling set renumbered.

/** Where a move puts the row among its new siblings. */
export type MoveAnchor =
  /** next to this sibling */
  | { id: string; side: 'before' | 'after' }
  /** after everything (the global max + 1, which is also where a new row lands) */
  | 'end'
  /** leave the key alone — a plain re-parent */
  | 'keep';

/** The sibling set of a destination parent, minus the row being moved. Ordered. */
export function siblingsQuery(parentId: string | null, movingId: string): { sql: string; params: unknown[] } {
  return {
    sql: `SELECT id, sort_order FROM tm_tasks WHERE ${parentId ? 'parent_id = ?' : 'parent_id IS NULL'} AND id <> ?
          ORDER BY sort_order, created_at, id`,
    params: parentId ? [parentId, movingId] : [movingId],
  };
}

/** The key a new row (or a move to the end) takes. */
export const NEXT_SORT_ORDER_SQL = `SELECT COALESCE(MAX(sort_order), 0) + 1 AS k FROM tm_tasks`;

/**
 * The moved row's new key next to `anchor`, or — when the gap cannot be split —
 * the whole sibling set in its new order, to be renumbered 1..n. Throws when
 * the anchor is not among the siblings (the caller's transaction rolls back).
 */
export function keyNextTo(
  siblings: { id: string; sort_order: number | string }[],
  movingId: string,
  anchor: { id: string; side: 'before' | 'after' },
): { key: number } | { renumber: string[] } {
  const keys = siblings.map((s) => Number(s.sort_order));
  const at = siblings.findIndex((s) => s.id === anchor.id);
  if (at < 0) throw new Error('the drop target is not a sibling at the destination');
  const lo = anchor.side === 'before' ? at - 1 : at;
  const hi = lo + 1;
  if (lo < 0) return { key: keys[hi] - 1 };
  if (hi >= keys.length) return { key: keys[lo] + 1 };
  const key = (keys[lo] + keys[hi]) / 2;
  if (key > keys[lo] && key < keys[hi]) return { key };
  const ids = siblings.map((s) => s.id);
  ids.splice(hi, 0, movingId);
  return { renumber: ids };
}

/**
 * The global claim's ORDER BY after priority, over alias `t`: a group runs in
 * its root's slot (root key, then group id so two tied groups never
 * interleave), root first, then members by their own key. Exact for a flat
 * group — which is what the board's drag produces; members nested deeper
 * compare by their own key within the group rather than depth-first.
 * JS twin: `compareClaimOrder` in shared/src/types.ts — edit them together.
 */
export const MANUAL_CLAIM_ORDER = `t.priority DESC,
       COALESCE((SELECT g.sort_order FROM tm_tasks g WHERE g.id = t.group_id), t.sort_order), t.group_id,
       CASE WHEN t.parent_id IS NULL THEN 0 ELSE 1 END, t.sort_order, t.created_at`;
