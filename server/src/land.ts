import fs from 'node:fs';
import path from 'node:path';
import type { Repo, Task } from '@tm/shared';
import { run, type ShippedCheck } from './git.ts';
import { commitLeftovers, defaultBranch, type DefaultBranch } from './worktrees.ts';
import { classifyGitFailure, gitNetEnv, holdsRepo, pushHealth } from './push-health.ts';
import type { Storage } from './storage/types.ts';

// PR delivery (docs/parallel.md § The PR / § Land). The PR is a RECORD, not
// the merge mechanism: the server pushes the task branch and keeps a draft PR
// in step with it, and lands by a local squash + fast-forward push of the
// default branch — GitHub then marks the PR merged by itself, because its head
// commit is now on the base branch. The task manager keeps deciding WHEN
// (landing tiers, the verify gate); the human's main checkout is never touched
// by a land except for a fast-forward when it is clean and on the default branch.

const GH_TIMEOUT = 60_000;

function tail(text: string, n = 3): string {
  return text.trim().split('\n').slice(-n).join(' ').slice(0, 500);
}

async function event(storage: Storage, kind: 'task.pr' | 'task.land', task: Task, data: Record<string, unknown>): Promise<void> {
  await storage.appendEvent({ kind, actor: 'orchestrator', taskId: task.id, repoId: task.repoId, data });
}

/**
 * Is a worktree task landed? Read from git, never from the PR: a commit
 * carrying the task's `Task:` trailer is reachable from origin/<default>
 * (the land's squash commit, or anything the human merged by hand with the
 * trailer kept). No fetch — the land's own push moved the tracking ref.
 */
export async function landedCheck(repo: Repo, task: Task): Promise<ShippedCheck> {
  const none = (reason: string): ShippedCheck => ({ ok: false, reason, sha: null, ref: null, commits: 0, attribution: 'none' });
  const def = await defaultBranch(repo);
  if (!def) return none('no base branch on origin');
  const log = await run(repo.path, 'git', ['log', def.ref, '--fixed-strings', `--grep=Task: ${task.id}`, '--format=%H %ct', '-n', '20']);
  if (log.code !== 0) return none(`git log failed: ${tail(log.out, 1)}`);
  const landed = log.out.split('\n').map((l) => l.trim().split(' ')).filter((p) => p[0]);
  if (!landed.length) return none(`no commit of this task is on ${def.ref} yet`);
  // A trailer on the default branch is not enough: a follow-up after a land
  // adds commits the old squash does not contain. What the task has NOW (its
  // worktree, else its branch) must be landed too — the tip reachable from
  // the default branch (the server's own land pushes it there), or no newer
  // than the newest landed trailer commit (a merge someone did on GitHub).
  const live = !!task.workdir && fs.existsSync(task.workdir);
  if (live) {
    // tracked changes only: a check's untracked output is not the task's work
    const dirty = await run(task.workdir!, 'git', ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=dirty']);
    if (dirty.code === 0 && dirty.out.trim()) return none('the worktree has uncommitted work');
  }
  const tipRef = live ? 'HEAD' : task.branch ? `refs/heads/${task.branch}` : null;
  const cwd = live ? task.workdir! : repo.path;
  const tip = tipRef ? await run(cwd, 'git', ['log', '-1', '--format=%H %ct', tipRef]) : null;
  if (tip && tip.code === 0 && tip.out.trim()) {
    const [tipSha, tipAt] = tip.out.trim().split(' ');
    const reachable = (await run(cwd, 'git', ['merge-base', '--is-ancestor', tipSha, def.ref])).code === 0;
    // same second counts as newer: a false "not shipped" only keeps the task in review
    if (!reachable && Number(tipAt) >= Number(landed[0][1])) return none(`commits after the last landing are not on ${def.ref} yet`);
  }
  return { ok: true, reason: null, sha: landed[0][0], ref: def.ref, commits: landed.length, attribution: 'trailer' };
}

/** `Task.error` of a push the server could not make — cleared by the next push that works. */
export const PUSH_FAILED_PREFIX = 'push to origin failed';

/** `https://github.com/o/r/pull/12` → 12 */
function prNumberOf(text: string): { url: string; number: number } | null {
  const m = text.match(/https:\/\/\S+\/pull\/(\d+)/);
  return m ? { url: m[0], number: Number(m[1]) } : null;
}

function prBody(task: Task): string {
  return [
    task.brief?.trim() || (task.description ?? '').trim().slice(0, 4000) || task.title,
    ...(task.resultSummary ? ['', '## Summary', '', task.resultSummary.trim().slice(0, 6000)] : []),
    '',
    '---',
    'Opened by Task Manager as a record of this task; it lands the change itself (local squash + fast-forward), which marks this PR merged.',
    '',
    `Task: ${task.id}`,
  ].join('\n');
}

/**
 * Push the task branch and keep its PR in step (docs/parallel.md § The PR):
 * opened as a DRAFT the first time the branch has a commit of its own, the
 * branch re-pushed (with lease) on every later call — a fix round, a rebase —
 * and marked ready once `ready` (checks green, review clean). Only committed
 * work is pushed; leftovers wait for the land. Never fatal: a failure is a
 * `task.pr` audit row and the PR columns stay as they were.
 */
export async function syncPr(storage: Storage, repo: Repo, task: Task, cwd: string, ready: boolean): Promise<Task> {
  if (!task.branch) return task;
  const def = await defaultBranch(repo, cwd);
  if (!def) return task;
  const ahead = await run(cwd, 'git', ['rev-list', '--count', `${def.ref}..HEAD`]);
  if (ahead.code !== 0 || Number(ahead.out.trim()) === 0) return task; // nothing of its own committed yet
  const push = await run(cwd, 'git', ['push', '--force-with-lease', def.remote, `HEAD:refs/heads/${task.branch}`], GH_TIMEOUT, await gitNetEnv(repo.path));
  if (push.code !== 0) {
    // docs/parallel.md § Push health: a failure only a human can fix (auth,
    // branch protection) holds the whole repo and says so on the task — no
    // more silent audit rows while the queue keeps forking from a stale base
    const kind = await pushHealth.report(repo, push.out, 'pr-sync');
    await event(storage, 'task.pr', task, { action: 'push-failed', kind, error: tail(push.out) });
    if (!holdsRepo(kind)) return task;
    return (await storage.updateTask(task.id, { error: `${PUSH_FAILED_PREFIX} (${kind}): ${tail(push.out)} — the PR branch was not updated` })) ?? task;
  }
  await pushHealth.reportOk(repo);
  let row = task;
  if (task.error?.startsWith(PUSH_FAILED_PREFIX)) row = (await storage.updateTask(task.id, { error: null })) ?? row;
  if (!task.prNumber) {
    const create = await run(
      cwd,
      'gh',
      ['pr', 'create', '--draft', '--base', def.branch, '--head', task.branch, '--title', task.title.slice(0, 250), '--body', prBody(task)],
      GH_TIMEOUT,
    );
    // "a pull request for branch … already exists: <url>" is the same answer
    const pr = prNumberOf(create.out);
    if (!pr) {
      await event(storage, 'task.pr', task, { action: 'create-failed', error: tail(create.out) });
      return row;
    }
    row = (await storage.updateTaskWorktree(task.id, { prNumber: pr.number, prUrl: pr.url, prState: 'draft' })) ?? row;
    await event(storage, 'task.pr', task, { action: 'opened', number: pr.number, url: pr.url, draft: true });
  } else {
    await event(storage, 'task.pr', task, { action: 'pushed', number: task.prNumber });
  }
  if (ready && row.prNumber && row.prState === 'draft') {
    const r = await run(cwd, 'gh', ['pr', 'ready', String(row.prNumber)], GH_TIMEOUT);
    if (r.code === 0) {
      row = (await storage.updateTaskWorktree(task.id, { prState: 'open' })) ?? row;
      await event(storage, 'task.pr', task, { action: 'ready', number: row.prNumber });
    } else {
      await event(storage, 'task.pr', task, { action: 'ready-failed', number: row.prNumber, error: tail(r.out) });
    }
  }
  return row;
}

/** Close a cancelled task's PR (best effort; its remote branch is deleted by the cleanup). */
export async function closePr(storage: Storage, repo: Repo, task: Task, why: string): Promise<void> {
  if (!task.prNumber || task.prState === 'merged' || task.prState === 'closed') return;
  const r = await run(repo.path, 'gh', ['pr', 'close', String(task.prNumber), '--comment', `Closed by Task Manager: ${why}.`], GH_TIMEOUT);
  if (r.code === 0) await storage.updateTaskWorktree(task.id, { prState: 'closed' });
  await event(storage, 'task.pr', task, { action: r.code === 0 ? 'closed' : 'close-failed', number: task.prNumber, why, ...(r.code ? { error: tail(r.out) } : {}) });
}

/** `gh pr view` until GitHub reports the land as a merge (it notices a pushed head within seconds). */
export async function confirmMerged(storage: Storage, repo: Repo, task: Task, tries = 6): Promise<boolean> {
  if (!task.prNumber) return false;
  for (let i = 0; i < tries; i++) {
    const r = await run(repo.path, 'gh', ['pr', 'view', String(task.prNumber), '--json', 'state'], GH_TIMEOUT);
    if (r.code === 0 && /"state"\s*:\s*"MERGED"/.test(r.out)) {
      await storage.updateTaskWorktree(task.id, { prState: 'merged' });
      await event(storage, 'task.pr', task, { action: 'merged', number: task.prNumber });
      return true;
    }
    await new Promise((res) => setTimeout(res, 5_000));
  }
  await event(storage, 'task.pr', task, { action: 'merge-unconfirmed', number: task.prNumber });
  return false;
}

export type LandResult =
  | { kind: 'landed'; sha: string; ref: string; checked: boolean; attempts: number }
  | { kind: 'conflict'; files: string[]; onto: string }
  | { kind: 'red'; sha: string; detail: string; tree: string }
  | { kind: 'failed'; error: string };

/**
 * The land itself, in the task's worktree (`cwd`), serialised per repo by the
 * caller:
 *  1. leftovers committed under the trailer;
 *  2. fetch + rebase onto origin/<default> — a conflict is ABORTED and
 *     returned (the task's own session resolves it, docs/parallel.md § Conflicts);
 *  3. squash to ONE commit (`reset --soft` onto the fork point) with the
 *     task's title, summary and `Task:` trailer;
 *  4. the checks again — only when the squashed tree differs from the tree
 *     the verify round judged (`verify` returns null for green / no checks,
 *     else the reason), i.e. when origin/<default> moved underneath;
 *  5. `push --force-with-lease` of the task branch (the PR's head becomes the
 *     squash commit), then a plain — fast-forward only — push of
 *     HEAD:<default>. A rejection means someone landed first: fetch and go
 *     again from 2, three times at most.
 */
export async function landWorktree(
  storage: Storage,
  repo: Repo,
  task: Task,
  cwd: string,
  verify: (cwd: string) => Promise<string | null>,
  /** the tree a previous land found red: never skip the checks on it again */
  redTree: string | null = null,
): Promise<LandResult> {
  const def = await defaultBranch(repo, cwd);
  if (!def) return { kind: 'failed', error: repo.baseBranch ? `the base branch origin/${repo.baseBranch} does not exist` : 'no origin default branch to land onto' };
  if (!task.branch) return { kind: 'failed', error: 'the task has no branch' };
  // a rebase a crash left half-done: abort it first, or the leftovers commit
  // would land on its detached HEAD and the next abort would drop it
  for (const p of ['rebase-merge', 'rebase-apply']) {
    const gp = (await run(cwd, 'git', ['rev-parse', '--git-path', p])).out.trim();
    if (gp && fs.existsSync(path.resolve(cwd, gp))) {
      await run(cwd, 'git', ['rebase', '--abort']);
      break;
    }
  }
  const leftovers = await commitLeftovers(cwd, task.id, 'WIP: uncommitted work at land time');
  if (leftovers.error) return { kind: 'failed', error: `could not commit the leftovers: ${leftovers.error}` };
  const judged = await treeOf(cwd);
  const net = await gitNetEnv(repo.path);
  let checked = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const fetched = await run(cwd, 'git', ['fetch', def.remote, def.branch], GH_TIMEOUT, net);
    if (fetched.code !== 0) return { kind: 'failed', error: `git fetch failed: ${tail(fetched.out)}` };
    const rebased = await rebaseOnto(cwd, def);
    if (rebased) return rebased;
    const squashed = await squash(cwd, def, task);
    if ('error' in squashed) return { kind: 'failed', error: squashed.error };
    const tree = await treeOf(cwd);
    if (tree !== judged || tree === redTree) {
      checked = true;
      const red = await verify(cwd);
      if (red) return { kind: 'red', sha: squashed.sha, detail: red, tree };
    }
    const branchPush = await run(cwd, 'git', ['push', '--force-with-lease', def.remote, `HEAD:refs/heads/${task.branch}`], GH_TIMEOUT, net);
    if (branchPush.code !== 0) return { kind: 'failed', error: `could not update the PR branch: ${tail(branchPush.out)}` };
    const land = await run(cwd, 'git', ['push', def.remote, `HEAD:refs/heads/${def.branch}`], GH_TIMEOUT, net);
    if (land.code === 0) {
      await event(storage, 'task.land', task, { phase: 'pushed', sha: squashed.sha, onto: def.ref, attempt, checked });
      return { kind: 'landed', sha: squashed.sha, ref: def.ref, checked, attempts: attempt };
    }
    // only a real race (someone landed first) is worth another round; a
    // protected branch's `[remote rejected]` or a refused key never changes
    if (classifyGitFailure(land.out) !== 'race') {
      return { kind: 'failed', error: `push to ${def.branch} refused: ${tail(land.out)}` };
    }
    await event(storage, 'task.land', task, { phase: 'raced', attempt, error: tail(land.out, 2) });
  }
  return { kind: 'failed', error: `${def.ref} kept moving — three fast-forward pushes were rejected; publish again` };
}

/**
 * Is this task's branch already contained in ANOTHER open task's branch
 * (docs/parallel.md § Integrated elsewhere)? An integration task that merged
 * a pile of finished branches by hand ships them — landing one of them on its
 * own again would squash the same change twice and conflict with the
 * integration. Returns the first such task, else null. An `other` whose tip
 * equals ours has nothing of its own and does not count, and neither does a
 * task whose tip is already on `baseRef` (no commit of its own).
 */
export async function integratedIn(repoPath: string, task: Task, others: Task[], baseRef: string): Promise<Task | null> {
  if (!task.branch) return null;
  const tip = await run(repoPath, 'git', ['rev-parse', '--verify', '--quiet', `refs/heads/${task.branch}`]);
  if (tip.code !== 0 || !tip.out.trim()) return null;
  // no commit of its own yet (the fork point is an ancestor of every branch)
  if ((await run(repoPath, 'git', ['merge-base', '--is-ancestor', tip.out.trim(), baseRef])).code === 0) return null;
  for (const o of others) {
    if (o.id === task.id || !o.branch || o.status === 'published' || o.status === 'cancelled') continue;
    const theirs = await run(repoPath, 'git', ['rev-parse', '--verify', '--quiet', `refs/heads/${o.branch}`]);
    if (theirs.code !== 0 || theirs.out.trim() === tip.out.trim()) continue;
    if ((await run(repoPath, 'git', ['merge-base', '--is-ancestor', tip.out.trim(), theirs.out.trim()])).code === 0) return o;
  }
  return null;
}

async function treeOf(cwd: string): Promise<string> {
  return (await run(cwd, 'git', ['rev-parse', 'HEAD^{tree}'])).out.trim();
}

/** null = rebased cleanly (or nothing to do); otherwise the conflict, already aborted. */
async function rebaseOnto(cwd: string, def: DefaultBranch): Promise<LandResult | null> {
  const r = await run(cwd, 'git', ['-c', 'core.editor=true', 'rebase', def.ref], 5 * 60_000);
  if (r.code === 0) return null;
  const files = (await run(cwd, 'git', ['diff', '--name-only', '--diff-filter=U'])).out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  await run(cwd, 'git', ['rebase', '--abort']);
  if (!files.length) return { kind: 'failed', error: `git rebase ${def.ref} failed: ${tail(r.out)}` };
  return { kind: 'conflict', files, onto: def.ref };
}

async function squash(cwd: string, def: DefaultBranch, task: Task): Promise<{ sha: string } | { error: string }> {
  const ahead = await run(cwd, 'git', ['rev-list', '--count', `${def.ref}..HEAD`]);
  const n = Number(ahead.out.trim());
  if (ahead.code !== 0) return { error: `git rev-list failed: ${tail(ahead.out)}` };
  if (n === 0) return { error: `nothing to land: the branch has no change against ${def.ref}` };
  const reset = await run(cwd, 'git', ['reset', '--soft', def.ref]);
  if (reset.code !== 0) return { error: `git reset --soft failed: ${tail(reset.out)}` };
  const staged = await run(cwd, 'git', ['diff', '--cached', '--quiet']);
  if (staged.code === 0) return { error: `nothing to land: the branch's commits add up to no change against ${def.ref}` };
  const body = (task.resultSummary ?? '').trim().slice(0, 4000);
  const commit = await run(cwd, 'git', [
    'commit',
    '--no-verify',
    '-m',
    task.title.slice(0, 200),
    ...(body ? ['-m', body] : []),
    '-m',
    `Squashed from ${n} commit(s) on ${task.branch}${task.prUrl ? ` (${task.prUrl})` : ''}.`,
    '--trailer',
    `Task: ${task.id}`,
  ]);
  if (commit.code !== 0) return { error: `git commit failed: ${tail(commit.out)}` };
  return { sha: (await run(cwd, 'git', ['rev-parse', 'HEAD'])).out.trim() };
}

/**
 * After a land: fast-forward the human's main checkout to the landed default
 * branch, ONLY when it is on that branch and has no tracked change — anything
 * else (another branch, local edits, local commits) is left alone.
 */
export async function fastForwardCheckout(storage: Storage, repo: Repo, task: Task): Promise<void> {
  const def = await defaultBranch(repo);
  if (!def) return;
  const head = await run(repo.path, 'git', ['symbolic-ref', '--short', 'HEAD']);
  if (head.code !== 0 || head.out.trim() !== def.branch) return;
  const status = await run(repo.path, 'git', ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=dirty']);
  if (status.code !== 0 || status.out.trim()) return;
  const ff = await run(repo.path, 'git', ['merge', '--ff-only', def.ref]);
  await event(storage, 'task.land', task, { phase: 'checkout', ok: ff.code === 0, ...(ff.code ? { error: tail(ff.out, 2) } : {}) });
}
