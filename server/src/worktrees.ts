import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { WORKTREE_COPY_DEFAULTS, type Repo, type Task } from '@tm/shared';
import { cleanEnv, run } from './git.ts';
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

/** The remote default branch the worktrees fork from and land onto (`origin/HEAD`, else origin/main|master). */
export async function defaultBranch(repoPath: string): Promise<DefaultBranch | null> {
  const head = await run(repoPath, 'git', ['rev-parse', '--abbrev-ref', 'origin/HEAD']);
  if (head.code === 0 && /^origin\/\S+$/.test(head.out.trim())) {
    const ref = head.out.trim();
    return { remote: 'origin', branch: ref.slice('origin/'.length), ref };
  }
  for (const b of ['main', 'master']) {
    const r = await run(repoPath, 'git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`]);
    if (r.code === 0) return { remote: 'origin', branch: b, ref: `origin/${b}` };
  }
  return null;
}

/**
 * Why a repo cannot take `delivery: 'pr'`, or null: it needs a GitHub
 * `origin` with a default branch and an authenticated `gh` (the server opens
 * the PRs). Read at the route before the switch is written.
 */
export async function prDeliveryRefusal(repoPath: string): Promise<string | null> {
  const url = await run(repoPath, 'git', ['remote', 'get-url', 'origin']);
  if (url.code !== 0) return 'pr delivery needs an `origin` remote';
  if (!/github\.com[:/]/i.test(url.out)) return 'pr delivery needs a GitHub `origin` remote';
  if (!(await defaultBranch(repoPath))) return 'pr delivery needs origin/HEAD (or origin/main) — run `git fetch origin` in the repo';
  const auth = await run(repoPath, 'gh', ['auth', 'status'], 20_000);
  if (auth.code !== 0) return `pr delivery needs an authenticated GitHub CLI — run \`gh auth login\` (${auth.out.split('\n')[0] || 'gh not found'})`;
  return null;
}

export type EnsureResult =
  | { ok: true; task: Task; cwd: string; created: boolean; note?: string }
  | { ok: false; error: string };

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
  opts: { logPath?: string } = {},
): Promise<EnsureResult> {
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
    if (hasBranch) {
      add = await run(repo.path, 'git', ['worktree', 'add', dir, branch], 120_000);
    } else {
      const def = await defaultBranch(repo.path);
      if (!def) return { ok: false, error: 'no origin default branch to fork the worktree from (run `git fetch origin`)' };
      await run(repo.path, 'git', ['fetch', def.remote, def.branch], 60_000);
      add = await run(repo.path, 'git', ['worktree', 'add', '--no-track', '-b', branch, dir, def.ref], 120_000);
      base = def.ref;
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
      cloned: setup.cloned,
      copied: setup.copied,
      setup: setup.setupRan,
    } });
    return { ok: true, task: row, cwd: dir, created: !hasBranch, note: setup.note };
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
