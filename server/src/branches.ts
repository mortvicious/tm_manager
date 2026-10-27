import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_ESSENTIAL_BRANCHES,
  type BranchCommit,
  type BranchesOverview,
  type EssentialBranchState,
  type MergeTarget,
  type Repo,
  type RepoBranchState,
  type Task,
  type WorkBranchState,
  type WorktreeState,
} from '@tm/shared';

// Branch tracking (docs/branches.md). Read-only: every answer comes from git
// in the repo's own checkout — `git fetch` (an explicit request) is the only
// write, and it only moves remote-tracking refs. The question it answers:
// which work is merged into an essential branch (main, staging, …) and on the
// remote, and which exists only here — unpushed essential commits, unmerged
// branches and worktrees, uncommitted files.

/** local branches inspected per repo (newest first); the rest are reported as truncated */
const MAX_BRANCHES = 60;
/** commits listed per branch / essential branch */
const LIST_CAP = 20;
/** a branch with more pending commits than this is not checked for squash/rebase landings */
const COVERAGE_CAP = 200;
const FETCH_TIMEOUT = 60_000;

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

// stdout and stderr apart: git.ts's run() joins them, which is fine for a
// message but not for output that is parsed.
function git(cwd: string, args: string[], timeoutMs = 20_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: gitEnv() },
      (err, stdout, stderr) => {
        const rawCode = (err as { code?: unknown } | null)?.code;
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: err ? (typeof rawCode === 'number' ? rawCode : 1) : 0 });
      },
    );
  });
}

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE') env[k] = v;
  }
  // never wait on a credential prompt nobody can see
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function lines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** git's own verdict (`fatal: …`), not the advice lines after it */
function errorLine(r: GitResult): string {
  const all = lines(r.stderr || r.stdout);
  return (all.find((l) => /^(fatal|error):/.test(l)) ?? all[0] ?? `exit ${r.code}`).slice(0, 300);
}

async function count(cwd: string, args: string[]): Promise<number> {
  const r = await git(cwd, ['rev-list', '--count', ...args]);
  return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
}

const SEP = '\x1f';
const LOG_FORMAT = ['%H', '%cI', '%ct', '%s', '%(trailers:key=Task,valueonly,separator=%x2C)'].join('%x1f');

interface Commit extends BranchCommit {
  ct: number;
}

function parseTaskIds(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s));
}

async function commits(cwd: string, args: string[], max: number): Promise<Commit[]> {
  const r = await git(cwd, ['log', `--max-count=${max}`, `--format=${LOG_FORMAT}%x1e`, ...args]);
  if (r.code !== 0) return [];
  const out: Commit[] = [];
  for (const rec of r.stdout.split('\x1e')) {
    const [sha, at, ct, subject, trailers] = rec.trim().split(SEP);
    if (!sha) continue;
    out.push({ sha, at, ct: Number(ct) || 0, subject: subject ?? '', taskIds: parseTaskIds(trailers ?? '') });
  }
  return out;
}

const publicCommit = ({ sha, subject, at, taskIds }: Commit): BranchCommit => ({ sha, subject, at, taskIds });

/** `origin` when it exists, else the only remote; null without one. */
async function pickRemote(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['remote']);
  const remotes = r.code === 0 ? lines(r.stdout) : [];
  return remotes.includes('origin') ? 'origin' : (remotes[0] ?? null);
}

async function gitCommonDir(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--git-common-dir']);
  if (r.code !== 0) return null;
  return path.resolve(cwd, r.stdout.trim());
}

interface Head {
  sha: string;
  at: string;
  subject: string;
  taskIds: string[];
}

async function readRefs(cwd: string, remote: string | null): Promise<{ heads: Map<string, Head>; remoteHeads: Map<string, string> }> {
  const fmt = ['%(refname)', '%(objectname)', '%(committerdate:iso-strict)', '%(subject)', '%(trailers:key=Task,valueonly,separator=%x2C)'].join('%1f');
  const r = await git(cwd, ['for-each-ref', `--format=${fmt}`, 'refs/heads', ...(remote ? [`refs/remotes/${remote}`] : [])]);
  const heads = new Map<string, Head>();
  const remoteHeads = new Map<string, string>();
  for (const line of r.stdout.split('\n')) {
    const [ref, sha, at, subject, trailers] = line.split(SEP);
    if (!ref || !sha) continue;
    if (ref.startsWith('refs/heads/')) {
      heads.set(ref.slice('refs/heads/'.length), { sha, at, subject: subject ?? '', taskIds: parseTaskIds(trailers ?? '') });
    } else if (remote && ref.startsWith(`refs/remotes/${remote}/`)) {
      const name = ref.slice(`refs/remotes/${remote}/`.length);
      if (name !== 'HEAD') remoteHeads.set(name, sha);
    }
  }
  return { heads, remoteHeads };
}

async function readWorktrees(cwd: string): Promise<WorktreeState[]> {
  const r = await git(cwd, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0) return [];
  const out: WorktreeState[] = [];
  const blocks = r.stdout.split(/\n\s*\n/).filter((b) => b.trim());
  for (const [i, block] of blocks.entries()) {
    const wt: WorktreeState = { path: '', branch: null, sha: null, isMain: false, changed: 0, untracked: 0, locked: false, prunable: false };
    let bare = false;
    for (const line of block.split('\n')) {
      const sp = line.indexOf(' ');
      const key = sp < 0 ? line : line.slice(0, sp);
      const value = sp < 0 ? '' : line.slice(sp + 1);
      if (key === 'worktree') wt.path = value;
      else if (key === 'HEAD') wt.sha = value;
      else if (key === 'branch') wt.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'bare') bare = true;
      else if (key === 'locked') wt.locked = true;
      else if (key === 'prunable') wt.prunable = true;
    }
    if (!wt.path || bare) continue;
    // the first entry is the main working tree (skipped above when it is bare)
    wt.isMain = i === 0;
    if (!wt.prunable && !fs.existsSync(wt.path)) wt.prunable = true;
    out.push(wt);
  }
  await Promise.all(
    out
      .filter((wt) => !wt.prunable)
      .map(async (wt) => {
        // --ignore-submodules=dirty: a tracked worktree gitlink reads -dirty forever (CLAUDE.md § Adversarial review)
        const s = await git(wt.path, ['status', '--porcelain=v1', '--ignore-submodules=dirty']);
        if (s.code !== 0) return;
        for (const l of s.stdout.split('\n')) {
          if (!l.trim()) continue;
          if (l.startsWith('??')) wt.untracked++;
          else wt.changed++;
        }
      }),
  );
  return out;
}

async function defaultBranchOf(
  cwd: string,
  remote: string | null,
  heads: Map<string, Head>,
  remoteHeads: Map<string, string>,
): Promise<string | null> {
  if (remote) {
    const r = await git(cwd, ['symbolic-ref', '-q', `refs/remotes/${remote}/HEAD`]);
    const name = r.code === 0 ? r.stdout.trim().replace(`refs/remotes/${remote}/`, '') : '';
    if (name && (remoteHeads.has(name) || heads.has(name))) return name;
  }
  for (const n of ['main', 'master']) if (remoteHeads.has(n) || heads.has(n)) return n;
  return null;
}

interface EssentialRef {
  branch: string;
  where: 'remote' | 'local';
  ref: string;
  sha: string;
}

async function essentialState(
  cwd: string,
  name: string,
  isDefault: boolean,
  remote: string | null,
  heads: Map<string, Head>,
  remoteHeads: Map<string, string>,
): Promise<EssentialBranchState> {
  const localSha = heads.get(name)?.sha ?? null;
  const remoteSha = remoteHeads.get(name) ?? null;
  const state: EssentialBranchState = { name, isDefault, localSha, remoteSha, unpushed: [], unpushedCount: 0, behind: 0 };
  if (!localSha || !remote) return state;
  const local = `refs/heads/${name}`;
  // with a remote copy: ahead/behind it; without one: whatever is on no remote ref at all
  const notPushed = remoteSha ? [`refs/remotes/${remote}/${name}..${local}`] : [local, '--not', `--remotes=${remote}`];
  state.unpushedCount = await count(cwd, notPushed);
  if (state.unpushedCount) state.unpushed = (await commits(cwd, notPushed, LIST_CAP)).map(publicCommit);
  if (remoteSha) state.behind = await count(cwd, [`${local}..refs/remotes/${remote}/${name}`]);
  return state;
}

/** pending commits of `ref` that an essential ref holds by patch (rebase / cherry-pick) */
async function equivalentIn(cwd: string, target: string, ref: string): Promise<Set<string>> {
  const r = await git(cwd, ['cherry', target, ref]);
  const out = new Set<string>();
  if (r.code !== 0) return out;
  for (const l of lines(r.stdout)) if (l.startsWith('- ')) out.add(l.slice(2).trim());
  return out;
}

/** per task id, the newest commit time on `target` carrying its `Task:` trailer (a squash land) */
async function landedTimes(cwd: string, target: string, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const r = await git(cwd, [
    'log',
    '--fixed-strings',
    ...ids.map((id) => `--grep=Task: ${id}`),
    '--format=%ct%x1f%(trailers:key=Task,valueonly,separator=%x2C)%x1e',
    target,
  ]);
  if (r.code !== 0) return out;
  for (const rec of r.stdout.split('\x1e')) {
    const [ct, trailers] = rec.trim().split(SEP);
    if (!ct) continue;
    for (const id of parseTaskIds(trailers ?? '')) out.set(id, Math.max(out.get(id) ?? 0, Number(ct) || 0));
  }
  return out;
}

interface TaskInfo {
  id: string;
  title: string;
  status: string;
}

async function branchState(
  cwd: string,
  name: string,
  head: Head,
  remote: string | null,
  remoteHeads: Map<string, string>,
  essentials: EssentialRef[],
  worktreePath: string | null,
  findTask: (ids: string[], branch: string) => TaskInfo | null,
): Promise<WorkBranchState> {
  const ref = `refs/heads/${name}`;
  const notEssential = essentials.length ? ['--not', ...essentials.map((e) => e.ref)] : [];
  // on no essential ref AND on no remote ref (`--not` governs every rev after it, --remotes included)
  const notEssentialNorRemote = ['--not', ...essentials.map((e) => e.ref), ...(remote ? [`--remotes=${remote}`] : [])];
  // Every git call costs a process spawn (measured 200-300ms each on a busy
  // machine), so the independent ones run together.
  const remoteSide = remote && remoteHeads.has(name) ? `refs/remotes/${remote}/${name}` : null;
  const [fetched, localOnlyList, notOnRemote, ownNotOnRemote, track] = await Promise.all([
    commits(cwd, [ref, ...notEssential], COVERAGE_CAP + 1),
    remote ? git(cwd, ['rev-list', `--max-count=${COVERAGE_CAP + 1}`, ref, ...notEssentialNorRemote]) : null,
    remote ? count(cwd, [ref, '--not', `--remotes=${remote}`]) : 0,
    remote ? count(cwd, [ref, ...notEssentialNorRemote]) : 0,
    remoteSide ? git(cwd, ['rev-list', '--left-right', '--count', `${ref}...${remoteSide}`]) : null,
  ]);
  const totalPending = fetched.length > COVERAGE_CAP ? await count(cwd, [ref, ...notEssential]) : fetched.length;

  let mergedInto: MergeTarget[] = [];
  let pending = fetched.slice(0, COVERAGE_CAP);
  let pendingCount = totalPending;
  if (totalPending === 0) {
    // the tip is in an essential branch's history: list every one that has it
    if (essentials.length) {
      const r = await git(cwd, ['for-each-ref', `--contains=${head.sha}`, '--format=%(refname)', ...essentials.map((e) => e.ref)]);
      const holding = new Set(lines(r.stdout));
      mergedInto = essentials.filter((e) => holding.has(e.ref)).map((e) => ({ branch: e.branch, where: e.where, how: 'ancestor' }));
    }
  } else if (essentials.length && totalPending <= COVERAGE_CAP) {
    // Not in any history — but a squash land, a rebase or a cherry-pick puts
    // the same work there under other shas. A commit is covered by an
    // essential ref when that ref has the same patch, or a commit carrying the
    // commit's `Task:` trailer that is no older than it (a commit made after
    // the land is new work — the same rule as land.ts's landedCheck). A local
    // and a remote copy at the same sha are read once.
    const ids = [...new Set(pending.flatMap((c) => c.taskIds))];
    const bySha = new Map<string, Promise<[Set<string>, Map<string, number>]>>();
    const evidence = await Promise.all(
      essentials.map((e) => {
        let p = bySha.get(e.sha);
        if (!p) {
          p = Promise.all([equivalentIn(cwd, e.ref, ref), landedTimes(cwd, e.ref, ids)]);
          bySha.set(e.sha, p);
        }
        return p;
      }),
    );
    const coveredAny = new Set<string>();
    const partial: MergeTarget[] = [];
    essentials.forEach((e, i) => {
      const [equivalent, landed] = evidence[i];
      let squash = false;
      let all = true;
      let some = false;
      for (const c of pending) {
        const at = Math.max(0, ...c.taskIds.map((id) => landed.get(id) ?? 0));
        if (equivalent.has(c.sha)) some = true;
        else if (at && c.ct <= at) some = squash = true;
        else {
          all = false;
          continue;
        }
        coveredAny.add(c.sha);
      }
      const target: MergeTarget = { branch: e.branch, where: e.where, how: squash ? 'squash' : 'equivalent' };
      if (all) mergedInto.push(target);
      else if (some) partial.push(target);
    });
    // every commit landed, but no one essential ref holds them all: the refs that hold some
    if (!mergedInto.length && pending.every((c) => coveredAny.has(c.sha))) mergedInto = partial;
    if (mergedInto.length) {
      pending = [];
      pendingCount = 0;
    } else {
      pending = pending.filter((c) => !coveredAny.has(c.sha));
      pendingCount = totalPending - coveredAny.size;
    }
  }

  // "Only here": pending commits on no remote ref, and the unpushed essential
  // commits (local main ahead of origin/main) the branch was built on.
  let pendingLocalOnly = pendingCount;
  if (localOnlyList && pendingCount) {
    const localOnly = new Set(lines(localOnlyList.stdout));
    pendingLocalOnly = totalPending > COVERAGE_CAP ? ownNotOnRemote : pending.filter((c) => localOnly.has(c.sha)).length;
    pendingLocalOnly = Math.min(pendingLocalOnly, pendingCount);
  }
  const inheritedUnpushed = remote ? Math.max(0, notOnRemote - ownNotOnRemote) : 0;

  let aheadOfRemote: number | null = null;
  let behindRemote: number | null = null;
  if (track && track.code === 0) {
    const [a, b] = track.stdout.trim().split(/\s+/).map(Number);
    aheadOfRemote = a || 0;
    behindRemote = b || 0;
  }

  const task = findTask([...new Set([...pending.flatMap((c) => c.taskIds), ...head.taskIds, ...fetched.flatMap((c) => c.taskIds)])], name);
  return {
    name,
    sha: head.sha,
    subject: head.subject,
    at: head.at,
    state: pendingCount === 0 ? 'merged' : 'unmerged',
    mergedInto,
    pending: pending.slice(0, LIST_CAP).map(publicCommit),
    pendingCount,
    pendingLocalOnly,
    inheritedUnpushed,
    remoteRef: remoteSide ? `${remote}/${name}` : null,
    aheadOfRemote,
    behindRemote,
    worktreePath,
    taskId: task?.id ?? null,
    taskTitle: task?.title ?? null,
    taskStatus: task?.status ?? null,
  };
}

/** run `fn` over `items` with at most `limit` in flight */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function taskFinder(tasks: Task[]): (ids: string[], branch: string) => TaskInfo | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return (ids, branch) => {
    for (const id of ids) {
      const t = byId.get(id);
      if (t) return { id: t.id, title: t.title, status: t.status };
    }
    // a task branch is `tm/<first 8 of the id>` (docs/parallel.md)
    const m = branch.match(/^tm\/([0-9a-f]{8})$/);
    if (m) {
      const hits = tasks.filter((t) => t.id.startsWith(m[1]));
      if (hits.length === 1) return { id: hits[0].id, title: hits[0].title, status: hits[0].status };
    }
    return null;
  };
}

export async function repoBranchState(repo: Repo, tasks: Task[], extraEssential: readonly string[] = DEFAULT_ESSENTIAL_BRANCHES): Promise<RepoBranchState> {
  const cwd = repo.path;
  const base: RepoBranchState = {
    repoId: repo.id,
    repoName: repo.name,
    path: repo.path,
    error: null,
    remote: null,
    defaultBranch: null,
    fetchedAt: null,
    fetchError: null,
    essentials: [],
    worktrees: [],
    branches: [],
    truncated: false,
  };
  if (!fs.existsSync(cwd)) return { ...base, error: 'path does not exist' };
  const [commonDir, remote] = await Promise.all([gitCommonDir(cwd), pickRemote(cwd)]);
  if (!commonDir) return { ...base, error: 'not a git repository' };

  const [{ heads, remoteHeads }, worktrees] = await Promise.all([readRefs(cwd, remote), readWorktrees(cwd)]);
  const defaultBranch = await defaultBranchOf(cwd, remote, heads, remoteHeads);
  let fetchedAt: string | null = null;
  try {
    fetchedAt = fs.statSync(path.join(commonDir, 'FETCH_HEAD')).mtime.toISOString();
  } catch {
    // never fetched
  }

  const names = [...new Set([...(defaultBranch ? [defaultBranch] : []), ...extraEssential])].filter(
    (n) => heads.has(n) || remoteHeads.has(n),
  );
  const essentials = await Promise.all(names.map((n) => essentialState(cwd, n, n === defaultBranch, remote, heads, remoteHeads)));
  const essentialRefs: EssentialRef[] = names.flatMap((n) => [
    ...(remote && remoteHeads.has(n) ? [{ branch: n, where: 'remote' as const, ref: `refs/remotes/${remote}/${n}`, sha: remoteHeads.get(n)! }] : []),
    ...(heads.has(n) ? [{ branch: n, where: 'local' as const, ref: `refs/heads/${n}`, sha: heads.get(n)!.sha }] : []),
  ]);

  const worktreeOf = new Map(worktrees.filter((w) => w.branch).map((w) => [w.branch!, w.path]));
  const work = [...heads.entries()].filter(([n]) => !names.includes(n)).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at));
  // a checked-out branch is always inspected, however old
  const inspected = work.filter(([n], i) => i < MAX_BRANCHES || worktreeOf.has(n));
  const findTask = taskFinder(tasks);
  const branches = await pool(inspected, 4, ([n, h]) =>
    branchState(cwd, n, h, remote, remoteHeads, essentialRefs, worktreeOf.get(n) ?? null, findTask),
  );
  branches.sort((a, b) => (a.state === b.state ? Date.parse(b.at) - Date.parse(a.at) : a.state === 'unmerged' ? -1 : 1));

  return {
    ...base,
    remote,
    defaultBranch,
    fetchedAt,
    essentials,
    worktrees,
    branches,
    truncated: inspected.length < work.length,
  };
}

// One fetch per repo at a time: a double-click joins the running one.
const fetching = new Map<string, Promise<string | null>>();

/** `git fetch --prune <remote>`; resolves to an error line, null on success (or no remote). */
export function fetchRepo(repo: Repo): Promise<string | null> {
  const running = fetching.get(repo.id);
  if (running) return running;
  const p = (async () => {
    if (!fs.existsSync(repo.path)) return 'path does not exist';
    const remote = await pickRemote(repo.path);
    if (!remote) return null;
    const r = await git(repo.path, ['fetch', '--prune', '--quiet', remote], FETCH_TIMEOUT);
    return r.code === 0 ? null : `git fetch ${remote} failed: ${errorLine(r)}`;
  })().finally(() => fetching.delete(repo.id));
  fetching.set(repo.id, p);
  return p;
}

export async function branchesOverview(repos: Repo[], tasks: Task[], fetchErrors = new Map<string, string | null>()): Promise<BranchesOverview> {
  const states = await pool(repos, 3, async (repo) => {
    try {
      const s = await repoBranchState(repo, tasks);
      return { ...s, fetchError: fetchErrors.get(repo.id) ?? null };
    } catch (err) {
      return {
        repoId: repo.id,
        repoName: repo.name,
        path: repo.path,
        error: err instanceof Error ? err.message : String(err),
        remote: null,
        defaultBranch: null,
        fetchedAt: null,
        fetchError: fetchErrors.get(repo.id) ?? null,
        essentials: [],
        worktrees: [],
        branches: [],
        truncated: false,
      } satisfies RepoBranchState;
    }
  });
  return { generatedAt: new Date().toISOString(), repos: states };
}
