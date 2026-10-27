import type { Repo, Task } from '@tm/shared';

/** What `updateTaskWorktree` may write — server-owned columns, never part of `updateTask` (docs/parallel.md). */
export type WorktreePatch = Partial<Pick<Task, 'workdir' | 'branch' | 'prNumber' | 'prUrl' | 'prState' | 'worktreeEvictedAt' | 'worktreeBase'>>;

const COLUMNS: [keyof WorktreePatch, string][] = [
  ['workdir', 'workdir'],
  ['branch', 'branch'],
  ['prNumber', 'pr_number'],
  ['prUrl', 'pr_url'],
  ['prState', 'pr_state'],
  ['worktreeEvictedAt', 'worktree_evicted_at'],
  ['worktreeBase', 'worktree_base'],
];

/**
 * The UPDATE both drivers run for `updateTaskWorktree` (`?` placeholders; the
 * pg driver rewrites them). undefined leaves a column alone, null clears it.
 * `updated_at` is deliberately not touched: the idle-eviction clock reads it,
 * and a PR sync or an eviction is bookkeeping, not activity.
 */
export function worktreePatchSql(id: string, patch: WorktreePatch): { sql: string; params: unknown[] } | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, col] of COLUMNS) {
    if (patch[key] === undefined) continue;
    sets.push(`${col} = ?`);
    params.push(patch[key]);
  }
  if (!sets.length) return null;
  params.push(id);
  return { sql: `UPDATE tm_tasks SET ${sets.join(', ')} WHERE id = ? RETURNING *`, params };
}

/** The UPDATE `updateRepo` runs for the delivery columns (both drivers, params from `repoParallelParams` + id). */
export const REPO_PARALLEL_SQL = `UPDATE tm_repos SET parallel = ?, delivery = ?, worktree_setup = ?, worktree_copy = ?, base_branch = ? WHERE id = ?`;

/** The `parallel, delivery, worktree_setup, worktree_copy, base_branch` values `updateRepo` writes (both drivers). */
export function repoParallelParams(
  cur: Pick<Repo, 'parallel' | 'delivery' | 'worktreeSetup' | 'worktreeCopy' | 'baseBranch'>,
  patch: Partial<Pick<Repo, 'parallel' | 'delivery' | 'worktreeSetup' | 'worktreeCopy' | 'baseBranch'>>,
): unknown[] {
  const copy = patch.worktreeCopy === undefined ? cur.worktreeCopy : patch.worktreeCopy;
  return [
    patch.parallel ?? cur.parallel,
    patch.delivery ?? cur.delivery,
    patch.worktreeSetup === undefined ? cur.worktreeSetup : patch.worktreeSetup,
    copy == null ? null : JSON.stringify(copy),
    patch.baseBranch === undefined ? cur.baseBranch : patch.baseBranch,
  ];
}
