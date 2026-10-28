import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { WORKTREE_COPY_DEFAULTS, type Repo, type Task } from '@tm/shared';
import { cleanEnv, run } from './git.ts';
import { gitNetEnv, holdsRepo, localAhead, pushHealth } from './push-health.ts';
import { parseCommandLine, resolveBin } from './commands/parse.ts';
import type { Storage } from './storage/types.ts';

// Parallel same-repo tasks (docs/parallel.md): in a `delivery: 'pr'` repo each
// task works in its OWN git worktree on its own branch, so two agents (and
// their reviewers and checks) never share a tree. This module owns the
// worktree's life: created at the task's first spawn, its directory evicted
// when it idles (branch kept, re-created at the SAME path — the claude CLI
// files a session under its cwd, so `--resume` only finds it from there),
// removed when the task lands, is cancelled or deleted.

/** Where a repo's task worktrees live: a sibling of the checkout, `<repo>.worktrees/` (decided 2026-10-26). */
export function worktreeRoot(repo: Pick<Repo, 'path'>): string {
  return `${path.resolve(repo.path)}.worktrees`;
}

export function worktreeDirFor(repo: Pick<Repo, 'path'>, taskId: string): string {
  return path.join(worktreeRoot(repo), taskId.slice(0, 8));
}

export function branchFor(taskId: string): string {
  return `tm/${taskId.slice(0, 8)}`;
}

/** THE cwd of everything a task's agent, reviewer and checks do: its worktree, else the checkout. */
export function taskWorkdir(task: Pick<Task, 'workdir'>, repo: Pick<Repo, 'path'>): string {
  return task.workdir ?? repo.path;
}

/**
 * The claude CLI's project-directory name for a cwd (every non-alphanumeric
 * character becomes `-`, measured against ~/.claude/projects). Used to tell
 * which directory a stored session belongs to; null when the name is too long
 * to trust (the CLI may shorten those).
 */
export function claudeProjectName(cwd: string): string | null {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return name.length > 200 ? null : name;
}

/**
 * Whether a session recorded at `transcriptPath` belongs to `cwd`. True when
 * it cannot be told (no path, an over-long name), so the check only ever
 * REFUSES a session that was demonstrably filed under another directory.
 */
export function sessionBelongsTo(transcriptPath: string | null, cwd: string): boolean {
  if (!transcriptPath) return true;
  const dir = path.basename(path.dirname(transcriptPath));
  const names = new Set<string>();
  for (const c of [path.resolve(cwd), realpathOrSelf(cwd)]) {
    const n = claudeProjectName(c);
    if (!n) return true;
    names.add(n);
  }
  return names.has(dir);
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    // an evicted worktree: resolve the parent, which still exists
    try {
      return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return path.resolve(p);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-repo serialisation. `git worktree add/remove` share the repo's
// $GIT_COMMON_DIR metadata, and a land must never interleave with another
// land's rebase/push — so every such step runs under this lock, which WAITS
// (unlike git.ts's `busy`, which refuses a double-click).

const locks = new Map<string, Promise<unknown>>();

export function withRepoLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(repoId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.catch(() => undefined);
  locks.set(repoId, settled);
  void settled.then(() => {
    if (locks.get(repoId) === settled) locks.delete(repoId);
  });
  return next;
}

// ---------------------------------------------------------------------------

export interface DefaultBranch {
  remote: string;
  /** e.g. `main` */
  branch: string;
  /** e.g. `origin/main` */
  ref: string;
}

/**
 * The remote's own default branch (`origin/HEAD`, else origin/main|master) —
 * what a repo with no `baseBranch` forks from and lands onto, and what a
 * worktree recorded before `worktree_base` existed was forked from.
 */
export async function remoteDefaultBranch(cwd: string): Promise<DefaultBranch | null> {
  const head = await run(cwd, 'git', ['rev-parse', '--abbrev-ref', 'origin/HEAD']);
  if (head.code === 0 && /^origin\/\S+$/.test(head.out.trim())) {
    const ref = head.out.trim();
    return { remote: 'origin', branch: ref.slice('origin/'.length), ref };
  }
  for (const b of ['main', 'master']) {
    const r = await run(cwd, 'git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`]);
    if (r.code === 0) return { remote: 'origin', branch: b, ref: `origin/${b}` };
  }
  return null;
}

/**
 * The branch a `pr` repo's worktrees fork from, its PRs target and its lands
 * push to (docs/parallel.md § Base branch): `origin/<repo.baseBranch>` when the
 * repo names one, else the remote default. `cwd` may be a task's worktree (the
 * remote-tracking refs are shared). A configured branch not fetched yet is
 * fetched once; null when it still does not exist on the remote.
 */
export async function defaultBranch(repo: Pick<Repo, 'path' | 'baseBranch'>, cwd: string = repo.path): Promise<DefaultBranch | null> {
  const name = repo.baseBranch;
  if (!name) return remoteDefaultBranch(cwd);
  const has = async () => (await run(cwd, 'git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`])).code === 0;
  if (!(await has())) {
    await run(cwd, 'git', ['fetch', 'origin', name], 60_000);
    if (!(await has())) return null;
  }
  return { remote: 'origin', branch: name, ref: `origin/${name}` };
}

/** A branch name we accept as a repo's base: plain git ref characters, no option or range lookalikes. */
export function validBaseBranchName(name: string): boolean {
  return (
    /^[A-Za-z0-9._/-]{1,200}$/.test(name) &&
    !name.startsWith('-') &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.endsWith('.lock') &&
    !name.includes('..') &&
    !name.includes('//') &&
    name !== 'HEAD'
  );
}

/**
 * Why a repo cannot take `delivery: 'pr'`, or null: it needs a GitHub
 * `origin` with a default branch and an authenticated `gh` (the server opens
 * the PRs). Read at the route before the switch is written.
 */
export async function prDeliveryRefusal(repo: Pick<Repo, 'path' | 'baseBranch'>): Promise<string | null> {
  const repoPath = repo.path;
  const url = await run(repoPath, 'git', ['remote', 'get-url', 'origin']);
  if (url.code !== 0) return 'pr delivery needs an `origin` remote';
  if (!/github\.com[:/]/i.test(url.out)) return 'pr delivery needs a GitHub `origin` remote';
  if (!(await defaultBranch(repo))) {
    return repo.baseBranch
      ? `pr delivery needs the base branch on the remote — origin/${repo.baseBranch} does not exist`
      : 'pr delivery needs origin/HEAD (or origin/main) — run `git fetch origin` in the repo';
  }
  const auth = await run(repoPath, 'gh', ['auth', 'status'], 20_000);
  if (auth.code !== 0) return `pr delivery needs an authenticated GitHub CLI — run \`gh auth login\` (${auth.out.split('\n')[0] || 'gh not found'})`;
  return null;
}

export type EnsureResult =
  | {
      ok: true;
      task: Task;
      cwd: string;
      created: boolean;
      note?: string;
      retargeted?: Retargeted;
      /** a NEW fork whose local base branch had commits origin lacks (docs/parallel.md § Base branch) */
      staleBase?: StaleBase;
    }
  | { ok: false; error: string };

/** The local `<base>` was ahead of `origin/<base>` when a worktree forked from the latter. */
export interface StaleBase {
  /** `origin/main` */
  ref: string;
  /** `main` */
  branch: string;
  /** commits on the local branch the fork does not have */
  ahead: number;
}

/** A branch `retargetWorktree` moved: from which base onto which, carrying how many of the task's own commits. */
export interface Retargeted {
  from: string;
  to: string;
  commits: number;
}

function noBase(repo: Pick<Repo, 'baseBranch'>): string {
  return repo.baseBranch
    ? `the base branch origin/${repo.baseBranch} does not exist on the remote (Repos page → base branch)`
    : 'no origin default branch to fork the worktree from (run `git fetch origin`)';
}

/**
 * Make sure a worktree task's directory exists, creating or re-creating it.
 * The row gets `workdir`/`branch` BEFORE any git step, so a crash mid-way
 * leaves a directory this module recognises as the task's own, and the repo
 * gate counts the task as a worktree holder from its first second.
 *
 * - fresh: `git worktree add -b tm/<task8> <dir> origin/<default>` (after a
 *   fetch; offline falls back to the last-fetched ref)
 * - evicted: `git worktree add <dir> tm/<task8>` — the branch carries the WIP
 *   commit the eviction made, the path is the session's cwd again
 * then the setup: ignored files copied, node_modules cloned, optional setup
 * command (`setupWorktree`).
 */
export async function ensureWorktree(
  storage: Storage,
  repo: Repo,
  task: Task,
  opts: {
    logPath?: string;
    /**
     * Also move the branch onto the repo's base when it was forked from
     * another one (`retargetWorktree`). Only where nothing of the task is
     * running: a turn about to spawn, a land — never a reviewer or a check.
     */
    retarget?: boolean;
  } = {},
): Promise<EnsureResult> {
  const made = await ensureTree(storage, repo, task, opts);
  if (!made.ok || !opts.retarget) return made;
  const moved = await retargetWorktree(storage, repo, made.task, made.cwd);
  if (!moved.ok) return moved;
  return { ...made, task: moved.task, ...(moved.retargeted ? { retargeted: moved.retargeted } : {}) };
}

async function ensureTree(storage: Storage, repo: Repo, task: Task, opts: { logPath?: string }): Promise<EnsureResult> {
  // the common case, a later turn of a live worktree: no lock (a land may hold
  // it for minutes) — unless an eviction is removing it right now, or its setup
  // never finished (a failed setup command, a crash mid-clone)
  if (task.workdir && !evicting.has(task.id) && setupDone(task.workdir)) return { ok: true, task, cwd: task.workdir, created: false };
  return withRepoLock(`wt:${repo.id}`, async () => {
    let dir = task.workdir ?? worktreeDirFor(repo, task.id);
    let branch = task.branch ?? branchFor(task.id);
    if (task.workdir && isWorktreeDir(dir)) {
      if (setupDone(dir)) return { ok: true, task, cwd: dir, created: false };
      // checked out but never set up: finish the setup, keep the tree
      const setup = await setupWorktree(repo, dir, opts.logPath);
      if (!setup.ok) return { ok: false, error: setup.error };
      markSetupDone(dir);
      return { ok: true, task, cwd: dir, created: false, note: setup.note };
    }
    if (!task.workdir) {
      // an 8-char id prefix shared with another task of this repo: take a longer name
      // rather than ever clearing that task's tree
      const others = (await storage.listTasks({ repoId: repo.id })).filter((o) => o.id !== task.id);
      if (others.some((o) => o.workdir && path.resolve(o.workdir) === path.resolve(dir)) || others.some((o) => o.branch === branch)) {
        dir = path.join(worktreeRoot(repo), task.id.slice(0, 13));
        branch = `tm/${task.id.slice(0, 13)}`;
      }
    }

    let row = await storage.updateTaskWorktree(task.id, { workdir: dir, branch });
    if (!row) return { ok: false, error: 'task is gone' };

    await run(repo.path, 'git', ['worktree', 'prune']);
    if (fs.existsSync(dir)) {
      // Our own directory (named by the task id, under the managed root) that
      // git no longer knows — a crash between mkdir and checkout. Clear it.
      if (!dir.startsWith(worktreeRoot(repo) + path.sep)) return { ok: false, error: `worktree path is outside ${worktreeRoot(repo)}: ${dir}` };
      await rmrf(dir);
    }
    fs.mkdirSync(path.dirname(dir), { recursive: true });

    const hasBranch = (await run(repo.path, 'git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
    let add: { out: string; code: number };
    let base: string | null = null;
    let staleBase: StaleBase | undefined;
    if (hasBranch) {
      add = await run(repo.path, 'git', ['worktree', 'add', dir, branch], 120_000);
    } else {
      // docs/parallel.md § Push health: no new fork while the server cannot
      // push here — its work could not land, and the fetch below could not
      // refresh the base it forks from
      const held = pushHealth.refusal(repo.id);
      if (held) return { ok: false, error: held };
      const def = await defaultBranch(repo);
      if (!def) return { ok: false, error: noBase(repo) };
      const fetched = await run(repo.path, 'git', ['fetch', def.remote, def.branch], 60_000, await gitNetEnv(repo.path));
      if (fetched.code !== 0) {
        // offline still falls back to the last known origin/<base>; a refused
        // key does not — that is the stale base the night of 2026-10-26 forked from
        const kind = await pushHealth.report(repo, fetched.out, 'fetch');
        if (holdsRepo(kind)) return { ok: false, error: pushHealth.refusal(repo.id) ?? `git fetch failed (${kind}): ${lastLines(fetched.out, 2)}` };
      }
      const ahead = await localAhead(repo.path, def);
      if (ahead > 0) staleBase = { ref: def.ref, branch: def.branch, ahead };
      add = await run(repo.path, 'git', ['worktree', 'add', '--no-track', '-b', branch, dir, def.ref], 120_000);
      base = def.ref;
      if (add.code === 0) row = (await storage.updateTaskWorktree(task.id, { worktreeBase: def.branch })) ?? row;
    }
    if (add.code !== 0) return { ok: false, error: `git worktree add failed: ${lastLines(add.out, 3)}` };

    const setup = await setupWorktree(repo, dir, opts.logPath);
    if (!setup.ok) return { ok: false, error: setup.error };
    markSetupDone(dir);
    row = (await storage.updateTaskWorktree(task.id, { worktreeEvictedAt: null })) ?? row;
    await storage.appendEvent({ kind: 'task.worktree', actor: 'orchestrator', taskId: task.id, data: {
      action: hasBranch ? 'recreated' : 'created',
      dir,
      branch,
      ...(base ? { base } : {}),
      ...(staleBase ? { staleBase } : {}),
      cloned: setup.cloned,
      copied: setup.copied,
      setup: setup.setupRan,
    } });
    return { ok: true, task: row, cwd: dir, created: !hasBranch, note: setup.note, ...(staleBase ? { staleBase } : {}) };
  });
}

/**
 * Move a worktree task's branch onto the repo's CURRENT base when it was forked
 * from (or last moved onto) another one (docs/parallel.md § Base branch) — a
 * repo whose real line is `staging` while GitHub's default `main` is months
 * stale. Only the task's OWN commits move: the upstream of the rebase is the
 * branch's fork point off the old base, or off the new one when the branch
 * already sits on it (an agent that moved it by hand), whichever is newer —
 * so neither the old base's history nor the new one's is ever replayed.
 * Leftovers are committed first (like a land). A conflict is aborted and
 * refused with the files, the branch untouched. An open PR gets the new base
 * and the moved branch. Runs under the `wt:` lock; a no-op once
 * `worktree_base` matches.
 */
export async function retargetWorktree(
  storage: Storage,
  repo: Repo,
  task: Task,
  cwd: string,
): Promise<{ ok: true; task: Task; retargeted?: Retargeted } | { ok: false; error: string }> {
  if (!task.branch) return { ok: true, task };
  const def = await defaultBranch(repo, cwd);
  if (!def) return { ok: false, error: noBase(repo) };
  if (task.worktreeBase === def.branch) return { ok: true, task };
  // a row from before worktree_base: forked from the remote default
  const from = task.worktreeBase ?? (await remoteDefaultBranch(cwd))?.branch ?? null;
  if (from === def.branch) {
    return { ok: true, task: (await storage.updateTaskWorktree(task.id, { worktreeBase: def.branch })) ?? task };
  }
  return withRepoLock(`wt:${repo.id}`, async () => {
    const fresh = (await storage.getTask(task.id)) ?? task;
    if (fresh.worktreeBase === def.branch) return { ok: true as const, task: fresh };
    const fail = (error: string) => ({ ok: false as const, error: `moving ${task.branch} from ${from ? `origin/${from}` : 'its old base'} onto ${def.ref}: ${error}` });

    await run(cwd, 'git', ['fetch', def.remote, def.branch], 60_000);
    if (from) await run(cwd, 'git', ['fetch', def.remote, from], 60_000);
    for (const p of ['rebase-merge', 'rebase-apply']) {
      const gp = (await run(cwd, 'git', ['rev-parse', '--git-path', p])).out.trim();
      if (gp && fs.existsSync(path.resolve(cwd, gp))) {
        await run(cwd, 'git', ['rebase', '--abort']);
        break;
      }
    }
    const leftovers = await commitLeftovers(cwd, task.id, `WIP: uncommitted work before moving onto ${def.ref}`);
    if (leftovers.error) return fail(`could not commit the leftovers: ${leftovers.error}`);

    const mergeBase = async (ref: string) => {
      const r = await run(cwd, 'git', ['merge-base', 'HEAD', ref]);
      return r.code === 0 && r.out.trim() ? r.out.trim() : null;
    };
    const forkNew = await mergeBase(def.ref);
    const oldRef = from && (await run(cwd, 'git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${from}`])).code === 0 ? `origin/${from}` : null;
    const forkOld = oldRef ? await mergeBase(oldRef) : null;
    let upstream = forkNew ?? forkOld;
    if (forkOld && forkNew && forkOld !== forkNew) {
      upstream = (await run(cwd, 'git', ['merge-base', '--is-ancestor', forkOld, forkNew])).code === 0 ? forkNew : forkOld;
    }
    if (!upstream) return fail('the branch shares no history with either base');
    const own = await run(cwd, 'git', ['rev-list', '--count', '--no-merges', `${upstream}..HEAD`]);
    const commits = Number(own.out.trim()) || 0;

    const r = await run(cwd, 'git', ['-c', 'core.editor=true', 'rebase', '--onto', def.ref, upstream], 5 * 60_000);
    if (r.code !== 0) {
      const files = (await run(cwd, 'git', ['diff', '--name-only', '--diff-filter=U'])).out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      await run(cwd, 'git', ['rebase', '--abort']);
      await storage.appendEvent({ kind: 'task.worktree', actor: 'orchestrator', taskId: task.id, repoId: repo.id, data: {
        action: 'retarget-failed', from, to: def.branch, ...(files.length ? { conflicts: files } : { error: lastLines(r.out, 3) }),
      } });
      return fail(
        files.length
          ? `conflict in ${files.slice(0, 8).join(', ')} — resolve by hand in ${cwd} (git rebase --onto ${def.ref} ${upstream.slice(0, 12)}), then run the task again`
          : `git rebase failed: ${lastLines(r.out, 3)}`,
      );
    }
    let row = (await storage.updateTaskWorktree(task.id, { worktreeBase: def.branch })) ?? fresh;
    await storage.appendEvent({ kind: 'task.worktree', actor: 'orchestrator', taskId: task.id, repoId: repo.id, data: {
      action: 'retargeted', from, to: def.branch, commits, ...(leftovers.sha ? { leftovers: leftovers.sha } : {}),
    } });
    // the PR (a record): its base follows, and its head is the moved branch
    if (row.prNumber && (row.prState === 'draft' || row.prState === 'open')) {
      const push = await run(cwd, 'git', ['push', '--force-with-lease', def.remote, `HEAD:refs/heads/${task.branch}`], 60_000);
      const edit = await run(cwd, 'gh', ['pr', 'edit', String(row.prNumber), '--base', def.branch], 60_000);
      const ok = push.code === 0 && edit.code === 0;
      await storage.appendEvent({ kind: 'task.pr', actor: 'orchestrator', taskId: task.id, repoId: repo.id, data: {
        action: ok ? 'retargeted' : 'retarget-failed',
        number: row.prNumber,
        base: def.branch,
        ...(ok ? {} : { error: lastLines(push.code !== 0 ? push.out : edit.out, 3) }),
      } });
    }
    row = (await storage.getTask(task.id)) ?? row;
    return { ok: true as const, task: row, retargeted: { from: from ?? '?', to: def.branch, commits } };
  });
}

/**
 * The worktree's own git dir (`<common>/worktrees/<name>`), read from its
 * `.git` FILE; null when `dir` is not a linked worktree.
 */
function worktreeGitDir(dir: string): string | null {
  try {
    const m = fs.readFileSync(path.join(dir, '.git'), 'utf8').match(/^gitdir:\s*(.+)$/m);
    return m ? path.resolve(dir, m[1].trim()) : null;
  } catch {
    return null;
  }
}

/** Setup finished in this worktree (marker in its git dir, so never in the tree, never committed). */
function setupDone(dir: string): boolean {
  const g = worktreeGitDir(dir);
  return !!g && fs.existsSync(path.join(g, 'tm-setup-done'));
}

function markSetupDone(dir: string): void {
  const g = worktreeGitDir(dir);
  if (g) fs.writeFileSync(path.join(g, 'tm-setup-done'), new Date().toISOString() + '\n');
}

/** Whether `dir` is a linked worktree of THIS repo (its git dir under the repo's common dir). */
function isWorktreeOf(repo: Repo, dir: string, commonDir: string): boolean {
  const g = worktreeGitDir(dir);
  if (!g) return false;
  try {
    return fs.realpathSync(path.dirname(path.dirname(g))) === commonDir;
  } catch {
    return false;
  }
}

/** Tasks whose worktree an eviction is removing right now — `ensureWorktree`'s fast path waits on the lock instead. */
const evicting = new Set<string>();

function isWorktreeDir(dir: string): boolean {
  try {
    // a linked worktree has a `.git` FILE pointing at the common dir
    return fs.statSync(path.join(dir, '.git')).isFile();
  } catch {
    return false;
  }
}

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

interface SetupResult {
  ok: boolean;
  error: string;
  cloned: number;
  copied: number;
  setupRan: boolean;
  note?: string;
}

/**
 * A fresh worktree has only tracked files. Bring over what the checkout has
 * and git does not:
 * 1. the IGNORED files matching the repo's copy list (`.env*`, the CLI's
 *    local settings) — ignored only, so the agent's `git add -A`, an eviction's
 *    WIP commit or the land's squash can never pick one up and push it;
 * 2. every `node_modules` (to depth 3) as an APFS/reflink CLONE — copy-on-
 *    write, ~2 s and ~0 bytes for a 1 GB tree until a file differs;
 * 3. the repo's setup command, only when it could matter: configured, and
 *    not (something was cloned AND every lockfile equals the checkout's).
 * A failing setup command fails the start with its last lines.
 */
async function setupWorktree(repo: Repo, dir: string, logPath?: string): Promise<SetupResult> {
  const res: SetupResult = { ok: true, error: '', cloned: 0, copied: 0, setupRan: false };
  const patterns = repo.worktreeCopy ?? [...WORKTREE_COPY_DEFAULTS];
  if (patterns.length) {
    const ls = await run(repo.path, 'git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory']);
    for (const rel of ls.out.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (rel.endsWith('/') || rel.split('/').includes('node_modules')) continue;
      if (!patterns.some((p) => globMatch(p, rel))) continue;
      const src = path.join(repo.path, rel);
      const dst = path.join(dir, rel);
      try {
        if (!fs.statSync(src).isFile() || fs.existsSync(dst)) continue;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE);
        res.copied++;
      } catch {
        /* unreadable — the agent will see it missing */
      }
    }
  }

  for (const rel of findNodeModules(repo.path)) {
    const parent = path.join(dir, path.dirname(rel));
    const dst = path.join(dir, rel);
    if (!fs.existsSync(parent) || fs.existsSync(dst)) continue;
    const r = await cloneTree(path.join(repo.path, rel), dst);
    if (r) res.cloned++;
  }

  const lockfilesEqual = LOCKFILES.every((f) => sameFile(path.join(repo.path, f), path.join(dir, f)));
  const line = repo.worktreeSetup?.trim();
  if (line && !(res.cloned > 0 && lockfilesEqual)) {
    res.setupRan = true;
    const out = await runSetup(line, dir);
    if (logPath) {
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.writeFileSync(logPath, out.out);
      } catch {
        /* best effort */
      }
    }
    if (out.code !== 0) return { ...res, ok: false, error: `worktree setup \`${line}\` exited ${out.code}: ${lastLines(out.out, 6)}` };
  } else if (!line && res.cloned > 0 && !lockfilesEqual) {
    res.note = 'the lockfile differs from the checkout and no setup command is configured — install dependencies before relying on them';
  }
  return res;
}

function runSetup(line: string, cwd: string): Promise<{ out: string; code: number }> {
  let argv: string[];
  try {
    argv = parseCommandLine(line);
    argv[0] = resolveBin(argv[0], cwd, cwd);
  } catch (err) {
    return Promise.resolve({ out: (err as Error).message, code: 127 });
  }
  return new Promise((resolve) => {
    execFile(
      argv[0],
      argv.slice(1),
      { cwd, timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024, env: { ...cleanEnv(), CI: '1' } },
      (err, stdout, stderr) => {
        const raw = (err as { code?: unknown } | null)?.code;
        resolve({ out: `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`, code: err ? (typeof raw === 'number' ? raw : 1) : 0 });
      },
    );
  });
}

/** `node_modules` directories under `root` (relative), to depth 3, never descending into one. */
function findNodeModules(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = rel ? path.join(rel, e.name) : e.name;
      if (e.name === 'node_modules') out.push(child);
      else if (depth < 3 && !e.name.startsWith('.')) walk(child, depth + 1);
    }
  };
  walk('', 1);
  return out;
}

/** Copy-on-write clone of a directory tree (macOS `cp -c`, Linux `--reflink=auto`); false when it failed. */
function cloneTree(src: string, dst: string): Promise<boolean> {
  const args = process.platform === 'darwin' ? ['-c', '-R', src, dst] : ['-R', '--reflink=auto', src, dst];
  return new Promise((resolve) => {
    execFile('cp', args, { timeout: 10 * 60_000 }, (err) => {
      if (!err) return resolve(true);
      // a partial clone is worse than none: the setup command then installs
      void rmrf(dst).then(() => resolve(false));
    });
  });
}

function sameFile(a: string, b: string): boolean {
  const ea = fs.existsSync(a);
  const eb = fs.existsSync(b);
  if (ea !== eb) return false;
  if (!ea) return true;
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

/** `*` matches within one path segment; a pattern without `/` matches the basename. */
export function globMatch(pattern: string, rel: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
  return pattern.includes('/') ? re.test(rel) : re.test(path.basename(rel));
}

function rmrf(p: string): Promise<void> {
  // a child process: removing a cloned node_modules is hundreds of thousands
  // of unlinks, which must not block the event loop
  return new Promise((resolve) => execFile('rm', ['-rf', p], { timeout: 10 * 60_000 }, () => resolve()));
}

function lastLines(text: string, n: number): string {
  return text.trim().split('\n').slice(-n).join(' ').slice(0, 600);
}

// ---------------------------------------------------------------------------

/** Commit whatever the worktree has uncommitted under the task's trailer; the sha, or null when clean. */
export async function commitLeftovers(cwd: string, taskId: string, subject: string): Promise<{ sha: string | null; error?: string }> {
  const status = await run(cwd, 'git', ['status', '--porcelain', '--ignore-submodules=dirty']);
  if (status.code !== 0) return { sha: null, error: lastLines(status.out, 2) };
  if (!status.out.trim()) return { sha: null };
  const add = await run(cwd, 'git', ['add', '-A']);
  if (add.code !== 0) return { sha: null, error: lastLines(add.out, 2) };
  const commit = await run(cwd, 'git', ['commit', '--no-verify', '-m', subject, '--trailer', `Task: ${taskId}`]);
  if (commit.code !== 0) return { sha: null, error: lastLines(commit.out, 2) };
  const sha = await run(cwd, 'git', ['rev-parse', 'HEAD']);
  return { sha: sha.code === 0 ? sha.out.trim() : null };
}

/**
 * Evict an idle worktree: leftovers WIP-committed to its branch, the
 * directory removed, the branch and `workdir` kept — the next turn re-creates
 * it at the same path (`ensureWorktree`) and resumes the same session.
 */
export async function evictWorktree(
  storage: Storage,
  repo: Repo,
  task: Task,
  why: string,
  stillIdle: (fresh: Task) => Promise<boolean> | boolean = () => true,
): Promise<boolean> {
  if (!task.workdir || task.worktreeEvictedAt) return false;
  evicting.add(task.id);
  try {
    return await withRepoLock(`wt:${repo.id}`, () => evictLocked(storage, repo, task, why, stillIdle));
  } finally {
    evicting.delete(task.id);
  }
}

async function evictLocked(
  storage: Storage,
  repo: Repo,
  task: Task,
  why: string,
  stillIdle: (fresh: Task) => Promise<boolean> | boolean,
): Promise<boolean> {
  {
    // re-read under the lock: the sweep's snapshot may be seconds old, and a
    // turn, a land or a review may have taken the task since
    const fresh = await storage.getTask(task.id);
    if (!fresh || fresh.worktreeEvictedAt || fresh.workdir !== task.workdir || fresh.updatedAt !== task.updatedAt) return false;
    if (!(await stillIdle(fresh))) return false;
    const dir = task.workdir!;
    if (isWorktreeDir(dir)) {
      const wip = await commitLeftovers(dir, task.id, 'WIP: leftovers before the worktree was evicted');
      if (wip.error) {
        await storage.appendEvent({ kind: 'task.worktree', actor: 'orchestrator', taskId: task.id, data: { action: 'evict-failed', dir, error: wip.error } });
        return false;
      }
      const removed = await removeDir(repo, dir);
      if (!removed) return false;
    }
    await storage.updateTaskWorktree(task.id, { worktreeEvictedAt: new Date().toISOString() });
    await storage.appendEvent({ kind: 'task.worktree', actor: 'orchestrator', taskId: task.id, data: { action: 'evicted', dir, why } });
    return true;
  }
}

/**
 * Remove a task's worktree for good (landed, cancelled, deleted). The local
 * branch goes only with `deleteBranch` (land, delete) — a cancelled task can
 * be retried and its branch is refs only, no disk. `deleteRemote` deletes
 * `origin/tm/<task8>` too (best effort: GitHub may have deleted it on merge).
 */
export async function removeWorktree(
  storage: Storage,
  repo: Repo,
  task: Task,
  opts: { deleteBranch: boolean; deleteRemote: boolean; why: string },
): Promise<void> {
  if (!task.workdir && !task.branch) return;
  await withRepoLock(`wt:${repo.id}`, async () => {
    // a kept branch keeps the work: leftovers committed under the trailer
    // first, as the checkout's hand-off does for a cancelled task
    let wip: string | null = null;
    if (!opts.deleteBranch && task.workdir && isWorktreeDir(task.workdir)) {
      const c = await commitLeftovers(task.workdir, task.id, `WIP: leftovers when the task was ${opts.why}`);
      if (c.error) {
        await storage.appendEvent({ kind: 'task.worktree', actor: 'orchestrator', taskId: task.id, data: { action: 'remove-failed', dir: task.workdir, error: c.error } });
        return;
      }
      wip = c.sha;
    }
    if (task.workdir && fs.existsSync(task.workdir)) await removeDir(repo, task.workdir);
    await run(repo.path, 'git', ['worktree', 'prune']);
    const branch = task.branch;
    if (branch && opts.deleteBranch) await run(repo.path, 'git', ['branch', '-D', branch]);
    if (branch && opts.deleteRemote) await run(repo.path, 'git', ['push', 'origin', '--delete', branch], 60_000);
    await storage.updateTaskWorktree(task.id, { worktreeEvictedAt: task.worktreeEvictedAt ?? new Date().toISOString() });
    await storage.appendEvent({ kind: 'task.worktree', actor: 'orchestrator', taskId: task.id, data: {
      action: 'removed',
      dir: task.workdir,
      branch,
      branchDeleted: opts.deleteBranch,
      remoteDeleted: opts.deleteRemote,
      why: opts.why,
      ...(wip ? { wip } : {}),
    } });
  });
}

async function removeDir(repo: Repo, dir: string): Promise<boolean> {
  if (!dir.startsWith(worktreeRoot(repo) + path.sep)) return false; // never outside the managed root
  const r = await run(repo.path, 'git', ['worktree', 'remove', '--force', '--force', dir], 10 * 60_000);
  if (r.code !== 0 || fs.existsSync(dir)) {
    await rmrf(dir);
    await run(repo.path, 'git', ['worktree', 'prune']);
  }
  return !fs.existsSync(dir);
}

/**
 * Boot hygiene for one `pr` repo (or one that has had worktree tasks):
 * `git worktree prune`, then remove the directories under `<repo>.worktrees`
 * that are THIS module's — named like a task (`<8 hex>` / `<13>`), a linked
 * worktree of this repo — and that no live task row owns, and `branch -d`
 * (never -D) local `tm/*` branches with no task row. The rows are read INSIDE
 * the lock, so a worktree created while the sweep ran is never judged against
 * a stale snapshot. Anything else in the folder (a human's own worktree, a
 * file) is never touched.
 */
export async function pruneOrphans(storage: Storage, repo: Repo): Promise<{ dirs: number; branches: number }> {
  const root = worktreeRoot(repo);
  const out = { dirs: 0, branches: 0 };
  if (!fs.existsSync(root)) return out;
  return withRepoLock(`wt:${repo.id}`, async () => {
    const tasks = await storage.listTasks({ repoId: repo.id });
    if (repo.delivery !== 'pr' && !tasks.some((t) => t.workdir)) return out;
    await run(repo.path, 'git', ['worktree', 'prune']);
    const common = await run(repo.path, 'git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (common.code !== 0) return out;
    let commonDir: string;
    try {
      commonDir = fs.realpathSync(common.out.trim());
    } catch {
      return out;
    }
    // a cancelled task's tree is the sweep's (it commits the leftovers first); only a
    // landed task's tree is disposable here
    const wanted = new Set(tasks.filter((t) => t.workdir && t.status !== 'published').map((t) => path.resolve(t.workdir!)));
    for (const name of fs.readdirSync(root)) {
      if (!OWN_NAME.test(name)) continue;
      const dir = path.join(root, name);
      if (wanted.has(path.resolve(dir))) continue;
      if (!isWorktreeOf(repo, dir, commonDir)) continue;
      if (await removeDir(repo, dir)) out.dirs++;
    }
    const known = new Set(tasks.map((t) => t.branch).filter(Boolean));
    const refs = await run(repo.path, 'git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/tm/']);
    for (const b of refs.out.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (known.has(b) || !OWN_NAME.test(b.slice('tm/'.length))) continue;
      // `branch -d` (not -D): an orphan branch git considers unmerged stays for a human to look at
      if ((await run(repo.path, 'git', ['branch', '-d', b])).code === 0) out.branches++;
    }
    if (out.dirs || out.branches) await storage.appendEvent({ kind: 'repo.worktrees-pruned', actor: 'orchestrator', repoId: repo.id, data: out });
    return out;
  });
}

/** The names this module gives worktrees and branches: a task id's first 8 (or, on a clash, 13) characters. */
const OWN_NAME = /^[0-9a-f]{8}(-[0-9a-f]{4})?$/;
