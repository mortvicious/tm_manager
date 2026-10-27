// Branch tracking (docs/branches.md): per registered repo, what is merged
// into an essential branch (main, staging, …) and on the remote, versus what
// exists only locally — unpushed essential commits, unmerged work in
// worktrees and branches, uncommitted files. Everything is read from git on
// request; nothing is stored.

/** Names treated as essential when the repo has them, after the remote's default branch. */
export const DEFAULT_ESSENTIAL_BRANCHES = [
  'main',
  'master',
  'staging',
  'stage',
  'develop',
  'development',
  'dev',
  'production',
  'prod',
  'release',
] as const;

export interface BranchCommit {
  sha: string;
  subject: string;
  /** committer date, ISO */
  at: string;
  /** `Task: <id>` trailers in the message */
  taskIds: string[];
}

export interface EssentialBranchState {
  /** `main` — without the remote prefix */
  name: string;
  /** the remote's default branch (`origin/HEAD`) */
  isDefault: boolean;
  /** null: no local branch of that name */
  localSha: string | null;
  /** null: not on the remote (or the repo has no remote) */
  remoteSha: string | null;
  /** local commits the remote does not have — newest first, capped at 20 */
  unpushed: BranchCommit[];
  unpushedCount: number;
  /** remote commits the local branch does not have (as of the last fetch) */
  behind: number;
}

export interface MergeTarget {
  /** essential branch name */
  branch: string;
  /** `remote`: on the remote's copy; `local`: only in the local branch, not pushed yet */
  where: 'remote' | 'local';
  /** `ancestor`: the tip is in its history; `equivalent`: same patches (rebase/cherry-pick); `squash`: a squash commit carries the task trailers */
  how: 'ancestor' | 'equivalent' | 'squash';
}

/**
 * `merged`: every commit of the branch is in an essential branch (`mergedInto`
 * says which, and whether only locally). `unmerged`: `pending` commits are in
 * no essential branch, local or remote — work that awaits merging.
 */
export type BranchMergeState = 'merged' | 'unmerged';

export interface WorkBranchState {
  name: string;
  sha: string;
  subject: string;
  at: string;
  state: BranchMergeState;
  /** essential branches holding all of this branch's work; empty when unmerged */
  mergedInto: MergeTarget[];
  /** commits in no essential branch (local or remote) — newest first, capped at 20 */
  pending: BranchCommit[];
  pendingCount: number;
  /** of `pendingCount`, how many are on no remote at all */
  pendingLocalOnly: number;
  /** essential-branch commits this branch is built on that are not on the remote yet */
  inheritedUnpushed: number;
  /** `origin/<name>` when the branch exists on the remote */
  remoteRef: string | null;
  /** local commits newer than `remoteRef` (null without a remote branch) */
  aheadOfRemote: number | null;
  /** remote commits not in the local branch */
  behindRemote: number | null;
  /** worktree path when the branch is checked out somewhere */
  worktreePath: string | null;
  /** the task whose work this is (from `Task:` trailers, else a `tm/<id8>` name) */
  taskId: string | null;
  taskTitle: string | null;
  taskStatus: string | null;
}

export interface WorktreeState {
  path: string;
  /** null when detached */
  branch: string | null;
  sha: string | null;
  /** the repo's own checkout (the first entry of `git worktree list`) */
  isMain: boolean;
  /** changed tracked files */
  changed: number;
  untracked: number;
  locked: boolean;
  /** the directory is gone; `git worktree prune` would drop the entry */
  prunable: boolean;
}

export interface RepoBranchState {
  repoId: string;
  repoName: string;
  path: string;
  /** set when the repo could not be read at all (not a git repo, path gone) */
  error: string | null;
  remote: string | null;
  defaultBranch: string | null;
  /** last `git fetch` (FETCH_HEAD mtime); the remote side is only as fresh as this */
  fetchedAt: string | null;
  /** set by a fetch request that failed for this repo */
  fetchError: string | null;
  essentials: EssentialBranchState[];
  worktrees: WorktreeState[];
  /** every local branch that is not essential, unmerged first */
  branches: WorkBranchState[];
  /** more local branches existed than were inspected */
  truncated: boolean;
}

export interface BranchesOverview {
  generatedAt: string;
  repos: RepoBranchState[];
}
