import fs from 'node:fs';
import http from 'node:http';
import {
  APPROVAL_LABELS,
  APPROVAL_MARK_MAX,
  APPROVAL_PENDING_CAP,
  AUTO_APPROVE_ACTOR,
  type Approval,
  type ApprovalAction,
  type ApprovalParams,
  type Repo,
  type Run,
  type Task,
} from '@tm/shared';
import { broadcast, onEvent } from './events.ts';
import { run } from './git.ts';
import { gitNetEnv, pushHealth } from './push-health.ts';
import type { Storage } from './storage/types.ts';
import { defaultBranch, withRepoLock } from './worktrees.ts';

// Approvals (docs/approvals.md): a worker asks for a human-only action, the
// human taps Approve (SPA, Telegram, Web Push → SPA), and the SERVER runs
// exactly what the row says. The agent never holds the power — no Origin, no
// push credentials of its own beyond what it already had, no restart route —
// so every guard that kept these actions human stays where it is; this only
// moves the legwork (which refs, which tasks, what changed) to the agent and
// the decision to one tap.
//
// Every action is validated and DESCRIBED at request time (the card the human
// reads is `summary`), and re-checked at run time against what was approved:
// a push refuses if the remote moved since the request, a sync refuses a
// branch that diverged, mark-published re-reads git per task.

export const APPROVAL_WAIT_CAP_MS = 60_000;
const SHA = /^[0-9a-f]{40}$/;

export type RequestResult = { ok: true; approval: Approval; reused?: boolean } | { ok: false; code: 400 | 404 | 409; error: string };
export type DecideResult = { ok: true; approval: Approval } | { ok: false; code: 404 | 409; error: string };

export interface ApprovalDeps {
  storage: Storage;
  markPublished: (taskId: string, actor: string) => Promise<{ ok: boolean; code?: number; error?: string }>;
  /** the front door's port; rebuild-restart POSTs there */
  hostPort: number;
  /** TM_SUPERVISED — without the front door there is nothing to rebuild-restart through */
  supervised: boolean;
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : '—');
type Refusal = { ok: false; code: 400 | 404 | 409; error: string };
const refused = (code: 400 | 404 | 409, error: string): Refusal => ({ ok: false, code, error });

export class ApprovalService {
  /** rows this process is running now — the boot sweep's twin for a live process */
  private running = new Set<string>();

  constructor(private deps: ApprovalDeps) {}

  private get storage() {
    return this.deps.storage;
  }

  list(f?: { status?: Approval['status']; taskId?: string }) {
    return this.storage.listApprovals(f);
  }

  get(id: string) {
    return this.storage.getApproval(id);
  }

  /** Boot: a row cut mid-run by a restart is not re-run (it may have half-happened) — it is expired with the reason. */
  async recoverOnBoot(): Promise<void> {
    const rows = await this.storage.expireApprovals(['approved', 'running'], 'the server restarted before it finished — ask again');
    for (const a of rows) await this.settled(a, 'approval.finished', { status: 'expired' });
  }

  // ---- request (the agent) --------------------------------------------------

  async request(runRow: Run, body: unknown): Promise<RequestResult> {
    const b = (body ?? {}) as Record<string, unknown>;
    const action = b.action as ApprovalAction;
    if (!(action in APPROVAL_LABELS)) return refused(400, `action must be one of ${Object.keys(APPROVAL_LABELS).join(', ')}`);
    const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 2000) : '';
    if (!reason) return refused(400, 'reason is required — the human reads it on the card');
    const taskId = runRow.taskId ?? null;
    if (taskId) {
      const pending = await this.storage.listApprovals({ taskId, status: 'pending' });
      if (pending.length >= APPROVAL_PENDING_CAP) return refused(409, `this task already has ${pending.length} pending approvals — wait for them`);
    }
    const built = await this.build(action, b, runRow);
    if (!built.ok) return built;
    const { params, summary, repo, autoRepos } = built;
    // the same request twice (a retried curl) is the same row
    if (taskId) {
      const same = (await this.storage.listApprovals({ taskId, status: 'pending' })).find(
        (a) => a.action === action && JSON.stringify(a.params) === JSON.stringify(params),
      );
      if (same) return { ok: true, approval: same, reused: true };
    }
    let approval = await this.storage.createApproval({ taskId, runId: runRow.id, repoId: repo?.id ?? null, action, params, summary, reason });
    await this.storage.appendEvent({
      kind: 'approval.requested',
      actor: `agent:${runRow.id.slice(0, 8)}`,
      taskId: taskId ?? undefined,
      runId: runRow.id,
      repoId: repo?.id,
      data: { approvalId: approval.id, action, params, summary },
    });
    broadcast({ type: 'approval.updated', approval });
    // pre-approved by every repo it touches (docs/approvals.md § Auto-approve)
    if (autoRepos.length && autoRepos.every((r) => r.autoApprove.includes(action))) {
      const r = await this.decide(approval.id, true, AUTO_APPROVE_ACTOR);
      if (r.ok) approval = r.approval;
    }
    return { ok: true, approval };
  }

  private async resolveRepo(ref: unknown, runRow: Run): Promise<Repo | null> {
    const repos = await this.storage.listRepos();
    if (typeof ref === 'string' && ref.trim()) {
      const k = ref.trim();
      return repos.find((r) => r.id === k) ?? repos.find((r) => r.name === k) ?? repos.find((r) => r.id.startsWith(k) && k.length >= 8) ?? null;
    }
    return runRow.repoId ? repos.find((r) => r.id === runRow.repoId) ?? null : null;
  }

  private async build(
    action: ApprovalAction,
    b: Record<string, unknown>,
    runRow: Run,
  ): Promise<{ ok: true; params: ApprovalParams; summary: string; repo: Repo | null; autoRepos: Repo[] } | { ok: false; code: 400 | 404 | 409; error: string }> {
    switch (action) {
      case 'push-ref': {
        const repo = await this.resolveRepo(b.repo, runRow);
        if (!repo) return refused(404, 'no such repo (pass `repo`: a registered repo name or id)');
        const r = await describePush(repo, b);
        if (!r.ok) return r;
        return { ok: true, params: r.params, summary: r.summary, repo, autoRepos: [] };
      }
      case 'sync-branch': {
        const repo = await this.resolveRepo(b.repo, runRow);
        if (!repo) return refused(404, 'no such repo (pass `repo`: a registered repo name or id)');
        const r = await describeSync(repo, b.branch);
        if (!r.ok) return r;
        return { ok: true, params: r.params, summary: r.summary, repo, autoRepos: [repo] };
      }
      case 'mark-published': {
        const ids = Array.isArray(b.taskIds) ? b.taskIds.filter((x): x is string => typeof x === 'string' && x.trim().length >= 8) : [];
        if (!ids.length) return refused(400, 'taskIds: an array of task ids (full, or 8+ character prefixes)');
        if (ids.length > APPROVAL_MARK_MAX) return refused(400, `at most ${APPROVAL_MARK_MAX} tasks per request`);
        const all = await this.storage.listTasks({});
        const tasks: Task[] = [];
        for (const k of ids) {
          const hits = all.filter((t) => t.id === k.trim() || t.id.startsWith(k.trim()));
          if (hits.length !== 1) return refused(404, `${k}: ${hits.length ? 'ambiguous' : 'no such task'}`);
          if (!tasks.some((t) => t.id === hits[0].id)) tasks.push(hits[0]);
        }
        const wrong = tasks.filter((t) => t.status !== 'review' && t.status !== 'done');
        if (wrong.length) {
          return refused(409, `only review/done tasks can be marked published: ${wrong.map((t) => `${t.id.slice(0, 8)} is ${t.status}`).join(', ')}`);
        }
        const repos = await this.storage.listRepos();
        const touched = [...new Set(tasks.map((t) => t.repoId))].map((id) => repos.find((r) => r.id === id)).filter((r): r is Repo => !!r);
        const lines = tasks.map((t) => `• ${t.id.slice(0, 8)} ${t.title.slice(0, 80)}`);
        return {
          ok: true,
          params: { action, taskIds: tasks.map((t) => t.id) },
          summary: `Mark ${tasks.length} task${tasks.length === 1 ? '' : 's'} published (git is re-read for each; one not on its remote is refused):\n${lines.join('\n')}`,
          repo: touched.length === 1 ? touched[0] : null,
          // pre-approved only when EVERY repo it touches says so, and only when each task has one
          autoRepos: tasks.every((t) => t.repoId) ? touched : [],
        };
      }
      case 'rebuild-restart': {
        if (!this.deps.supervised) return refused(409, 'the API is not running under the front door (npm start / npm run dev) — nothing can rebuild-restart it');
        const m = b.drainMinutes;
        const drainMinutes = typeof m === 'number' && Number.isFinite(m) && m > 0 ? Math.min(Math.round(m), 120) : null;
        return {
          ok: true,
          params: { action, drainMinutes },
          summary: `Rebuild & restart the Task Manager (drain): pause new work, build the SPA, typecheck, then restart once no agent is working${drainMinutes ? ` (wait up to ${drainMinutes} min)` : ''}. The requesting agent must END ITS TURN for the drain to finish.`,
          repo: null,
          autoRepos: [],
        };
      }
    }
  }

  // ---- decide (the human) ---------------------------------------------------

  /**
   * Approve or reject, once (conditional on `pending`). An approval runs the
   * action in the background; the row and `approval.updated` carry the outcome.
   */
  async decide(id: string, approve: boolean, actor: string, note?: string): Promise<DecideResult> {
    const cur = await this.storage.getApproval(id);
    if (!cur) return { ok: false, code: 404, error: 'no such approval' };
    if (cur.status !== 'pending') return { ok: false, code: 409, error: `already ${cur.status}${cur.decidedBy ? ` by ${cur.decidedBy}` : ''}` };
    const row = await this.storage.decideApproval(id, approve ? 'approved' : 'rejected', actor, approve ? null : note?.trim().slice(0, 500) || null);
    if (!row) return { ok: false, code: 409, error: 'decided elsewhere first' };
    await this.storage.appendEvent({
      kind: 'approval.decided',
      actor,
      taskId: row.taskId ?? undefined,
      runId: row.runId,
      repoId: row.repoId ?? undefined,
      data: { approvalId: id, action: row.action, approved: approve, ...(note ? { note } : {}) },
    });
    broadcast({ type: 'approval.updated', approval: row });
    if (approve) void this.execute(row, actor);
    return { ok: true, approval: row };
  }

  /** Until the row reaches a final status, or `waitMs` (≤ 60 s) — the agent's poll. */
  async wait(id: string, waitMs: number): Promise<Approval | null> {
    const wait = Math.min(Math.max(Number(waitMs) || 0, 0), APPROVAL_WAIT_CAP_MS);
    const final = (a: Approval) => ['done', 'failed', 'rejected', 'expired'].includes(a.status);
    let a = await this.storage.getApproval(id);
    if (!a || final(a) || wait === 0) return a;
    return new Promise<Approval | null>((resolve) => {
      let done = false;
      const finish = (v: Approval | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        resolve(v);
      };
      const timer = setTimeout(() => finish(a), wait);
      const off = onEvent((e) => {
        if (e.type === 'approval.updated' && e.approval.id === id) {
          a = e.approval;
          if (final(a)) finish(a);
        }
      });
      void this.storage.getApproval(id).then((fresh) => {
        if (fresh && final(fresh)) finish(fresh);
      });
    });
  }

  // ---- execute (the server) -------------------------------------------------

  private async execute(a: Approval, actor: string): Promise<void> {
    if (this.running.has(a.id)) return;
    this.running.add(a.id);
    try {
      const started = await this.storage.stepApproval(a.id, ['approved'], 'running');
      if (!started) return;
      broadcast({ type: 'approval.updated', approval: started });
      let out: { ok: boolean; result: string };
      try {
        out = await this.perform(started, actor);
      } catch (e) {
        out = { ok: false, result: String((e as Error)?.message ?? e).slice(0, 500) };
      }
      const row = await this.storage.stepApproval(a.id, ['running'], out.ok ? 'done' : 'failed', out.result);
      if (row) await this.settled(row, 'approval.finished', { status: row.status, result: out.result }, actor);
    } finally {
      this.running.delete(a.id);
    }
  }

  private async settled(a: Approval, kind: 'approval.finished', data: Record<string, unknown>, actor = 'system'): Promise<void> {
    await this.storage.appendEvent({
      kind,
      actor,
      taskId: a.taskId ?? undefined,
      runId: a.runId,
      repoId: a.repoId ?? undefined,
      data: { approvalId: a.id, action: a.action, ...data },
    });
    broadcast({ type: 'approval.updated', approval: a });
  }

  private async perform(a: Approval, actor: string): Promise<{ ok: boolean; result: string }> {
    const p = a.params;
    const repo = a.repoId ? await this.storage.getRepo(a.repoId) : null;
    switch (p.action) {
      case 'push-ref':
        if (!repo) return { ok: false, result: 'the repo is gone' };
        return pushApproved(repo, p);
      case 'sync-branch':
        if (!repo) return { ok: false, result: 'the repo is gone' };
        return withRepoLock(repo.id, () => syncApproved(repo, p));
      case 'mark-published': {
        const lines: string[] = [];
        let ok = 0;
        for (const id of p.taskIds) {
          const r = await this.deps.markPublished(id, actor);
          if (r.ok) ok++;
          lines.push(`${id.slice(0, 8)}: ${r.ok ? 'published' : r.error ?? 'refused'}`);
        }
        return { ok: ok > 0, result: `${ok} of ${p.taskIds.length} marked published\n${lines.join('\n')}` };
      }
      case 'rebuild-restart':
        return requestRebuild(this.deps.hostPort, p.drainMinutes);
    }
  }
}

// ---- push-ref ---------------------------------------------------------------

async function refName(repo: Repo, ref: string): Promise<boolean> {
  return (await run(repo.path, 'git', ['check-ref-format', ref])).code === 0;
}

async function remoteSha(repo: Repo, ref: string): Promise<{ ok: true; sha: string | null } | { ok: false; error: string }> {
  const ls = await run(repo.path, 'git', ['ls-remote', 'origin', ref], 45_000, await gitNetEnv(repo.path));
  if (ls.code !== 0) return { ok: false, error: `ls-remote failed: ${ls.out.trim().split('\n').slice(-2).join(' ')}` };
  const line = ls.out.split('\n').find((l) => l.endsWith(`\t${ref}`));
  return { ok: true, sha: line ? line.split('\t')[0] : null };
}

/**
 * Validate and describe a push: `branch` (+ `sha`, any rev) or `tag`. Only a
 * fast-forward of a branch or a NEW tag — never a force, never a moved tag.
 */
export async function describePush(
  repo: Repo,
  b: Record<string, unknown>,
): Promise<{ ok: true; params: Extract<ApprovalParams, { action: 'push-ref' }>; summary: string } | { ok: false; code: 400 | 404 | 409; error: string }> {
  const branch = typeof b.branch === 'string' ? b.branch.trim() : '';
  const tag = typeof b.tag === 'string' ? b.tag.trim() : '';
  if (!!branch === !!tag) return refused(400, 'pass exactly one of `branch` (with `sha`) or `tag`');
  const ref = branch ? `refs/heads/${branch}` : `refs/tags/${tag}`;
  if (!(await refName(repo, ref))) return refused(400, `${ref} is not a valid ref name`);
  let sha: string;
  if (branch) {
    const src = typeof b.sha === 'string' ? b.sha.trim() : '';
    if (!src) return refused(400, '`sha`: the commit to push (a sha or a local ref)');
    if (src.startsWith('-')) return refused(400, 'bad sha');
    const r = await run(repo.path, 'git', ['rev-parse', '--verify', '--quiet', `${src}^{commit}`]);
    if (r.code !== 0) return refused(404, `${src} is not a commit in ${repo.name}`);
    sha = r.out.trim();
  } else {
    const r = await run(repo.path, 'git', ['rev-parse', '--verify', '--quiet', ref]);
    if (r.code !== 0) return refused(404, `no local tag ${tag} in ${repo.name} — create it first`);
    sha = r.out.trim();
  }
  if (!SHA.test(sha)) return refused(404, 'could not resolve the sha');
  const remote = await remoteSha(repo, ref);
  if (!remote.ok) return refused(409, remote.error);
  const old = remote.sha;
  if (old === sha) return refused(409, `${ref} on origin is already ${short(sha)} — nothing to push`);
  let commits = 0;
  let log = '';
  if (branch) {
    if (old) {
      // the remote tip must be here to judge the fast-forward
      if ((await run(repo.path, 'git', ['cat-file', '-e', `${old}^{commit}`])).code !== 0) {
        await run(repo.path, 'git', ['fetch', '--quiet', 'origin', ref], 60_000, await gitNetEnv(repo.path));
      }
      if ((await run(repo.path, 'git', ['merge-base', '--is-ancestor', old, sha])).code !== 0) {
        return refused(409, `not a fast-forward: origin's ${branch} (${short(old)}) is not an ancestor of ${short(sha)} — force pushes are never offered`);
      }
      commits = Number((await run(repo.path, 'git', ['rev-list', '--count', `${old}..${sha}`])).out.trim()) || 0;
      log = (await run(repo.path, 'git', ['log', '--oneline', '--no-decorate', '-8', `${old}..${sha}`])).out.trim();
    } else {
      log = (await run(repo.path, 'git', ['log', '--oneline', '--no-decorate', '-3', sha])).out.trim();
    }
  } else if (old) {
    return refused(409, `tag ${tag} already exists on origin at ${short(old)} — moving a published tag is never offered`);
  }
  const target = branch
    ? old
      ? `fast-forward ${branch} ${short(old)} → ${short(sha)} (+${commits} commit${commits === 1 ? '' : 's'})`
      : `create branch ${branch} at ${short(sha)}`
    : `new tag ${tag} (${short(sha)})`;
  const summary = `git push origin ${short(sha)}:${ref} in ${repo.name}\n${target}${log ? `\n${log.split('\n').map((l) => `  ${l}`).join('\n')}${commits > 8 ? `\n  … ${commits - 8} more` : ''}` : ''}`;
  return { ok: true, params: { action: 'push-ref', sha, ref, expectedOld: old, commits }, summary };
}

async function pushApproved(repo: Repo, p: Extract<ApprovalParams, { action: 'push-ref' }>): Promise<{ ok: boolean; result: string }> {
  const held = pushHealth.refusal(repo.id);
  if (held) return { ok: false, result: held };
  const now = await remoteSha(repo, p.ref);
  if (!now.ok) return { ok: false, result: now.error };
  if (now.sha === p.sha) return { ok: true, result: `${p.ref} was already ${short(p.sha)} on origin` };
  if (now.sha !== p.expectedOld) {
    return { ok: false, result: `origin's ${p.ref} moved since the request (${short(p.expectedOld)} → ${short(now.sha)}) — not pushed; ask again` };
  }
  // no --force of any kind: git itself refuses a non-fast-forward
  const env = await gitNetEnv(repo.path);
  const push = await run(repo.path, 'git', ['push', '--porcelain', 'origin', `${p.sha}:${p.ref}`], 120_000, env);
  if (push.code !== 0) {
    const kind = await pushHealth.report(repo, push.out, 'push');
    return { ok: false, result: `push failed (${kind}): ${push.out.trim().split('\n').slice(-3).join(' ').slice(0, 400)}` };
  }
  await pushHealth.reportOk(repo);
  await run(repo.path, 'git', ['fetch', '--quiet', 'origin'], 60_000, env);
  return { ok: true, result: `pushed ${short(p.sha)} → ${p.ref}${p.expectedOld ? ` (was ${short(p.expectedOld)})` : ''}` };
}

// ---- sync-branch ------------------------------------------------------------

async function counts(repo: Repo, branch: string): Promise<{ ahead: number; behind: number } | null> {
  const r = await run(repo.path, 'git', ['rev-list', '--left-right', '--count', `refs/heads/${branch}...refs/remotes/origin/${branch}`]);
  if (r.code !== 0) return null;
  const [ahead, behind] = r.out.trim().split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0 };
}

/**
 * Where `branch` is checked out: `'checkout'` (the repo's own path), another
 * worktree's path, or null. git prints REAL paths (`/private/var/…` on macOS),
 * so both sides are resolved before comparing.
 */
async function checkedOutAt(repo: Repo, branch: string): Promise<string | null> {
  const r = await run(repo.path, 'git', ['worktree', 'list', '--porcelain']);
  let at: string | null = null;
  for (const line of r.out.split('\n')) {
    if (line.startsWith('worktree ')) at = line.slice(9);
    else if (line === `branch refs/heads/${branch}` && at) return real(at) === real(repo.path) ? 'checkout' : at;
  }
  return null;
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

export async function describeSync(
  repo: Repo,
  branchIn: unknown,
): Promise<{ ok: true; params: Extract<ApprovalParams, { action: 'sync-branch' }>; summary: string } | { ok: false; code: 400 | 404 | 409; error: string }> {
  let branch = typeof branchIn === 'string' ? branchIn.trim() : '';
  if (!branch) branch = (await defaultBranch(repo))?.branch ?? '';
  if (!branch) return refused(404, `${repo.name} has no origin default branch — pass \`branch\``);
  if (!(await refName(repo, `refs/heads/${branch}`))) return refused(400, `${branch} is not a valid branch name`);
  if ((await run(repo.path, 'git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code !== 0) {
    return refused(404, `no local branch ${branch} in ${repo.name}`);
  }
  const f = await run(repo.path, 'git', ['fetch', '--quiet', 'origin', branch], 60_000, await gitNetEnv(repo.path));
  if (f.code !== 0) return refused(409, `fetch failed: ${f.out.trim().split('\n').slice(-2).join(' ')}`);
  const c = await counts(repo, branch);
  if (!c) return refused(404, `origin has no ${branch}`);
  if (c.ahead > 0) {
    return refused(409, `local ${branch} has ${c.ahead} commit${c.ahead === 1 ? '' : 's'} origin lacks — not a fast-forward; push or drop them by hand`);
  }
  if (c.behind === 0) return refused(409, `local ${branch} is already at origin/${branch}`);
  const at = await checkedOutAt(repo, branch);
  if (at && at !== 'checkout') return refused(409, `${branch} is checked out in another worktree (${at}) — not touched`);
  const how = at ? `merge --ff-only in the checkout (${repo.path}; refused if it has tracked changes)` : 'update-ref (not checked out)';
  return {
    ok: true,
    params: { action: 'sync-branch', branch, behind: c.behind },
    summary: `Fast-forward local ${branch} in ${repo.name} to origin/${branch} (+${c.behind} commit${c.behind === 1 ? '' : 's'}), via ${how}`,
  };
}

async function syncApproved(repo: Repo, p: Extract<ApprovalParams, { action: 'sync-branch' }>): Promise<{ ok: boolean; result: string }> {
  const b = p.branch;
  const f = await run(repo.path, 'git', ['fetch', '--quiet', 'origin', b], 60_000, await gitNetEnv(repo.path));
  if (f.code !== 0) return { ok: false, result: `fetch failed: ${f.out.trim().split('\n').slice(-2).join(' ')}` };
  const c = await counts(repo, b);
  if (!c) return { ok: false, result: `origin has no ${b}` };
  if (c.ahead > 0) return { ok: false, result: `local ${b} now has ${c.ahead} commit(s) origin lacks — not a fast-forward, not touched` };
  if (c.behind === 0) return { ok: true, result: `local ${b} was already at origin/${b}` };
  const at = await checkedOutAt(repo, b);
  if (at && at !== 'checkout') return { ok: false, result: `${b} is checked out in ${at} — not touched` };
  if (at) {
    const dirty = await run(repo.path, 'git', ['status', '--porcelain', '--untracked-files=no']);
    if (dirty.out.trim()) return { ok: false, result: `the checkout has tracked changes — not touched:\n${dirty.out.trim().split('\n').slice(0, 8).join('\n')}` };
    const m = await run(repo.path, 'git', ['merge', '--ff-only', `refs/remotes/origin/${b}`]);
    if (m.code !== 0) return { ok: false, result: `merge --ff-only failed: ${m.out.trim().split('\n').slice(-2).join(' ')}` };
  } else {
    const old = (await run(repo.path, 'git', ['rev-parse', `refs/heads/${b}`])).out.trim();
    const u = await run(repo.path, 'git', ['update-ref', `refs/heads/${b}`, `refs/remotes/origin/${b}`, old]);
    if (u.code !== 0) return { ok: false, result: `update-ref failed: ${u.out.trim()}` };
  }
  const head = (await run(repo.path, 'git', ['rev-parse', '--short', `refs/heads/${b}`])).out.trim();
  return { ok: true, result: `local ${b} fast-forwarded ${c.behind} commit${c.behind === 1 ? '' : 's'} to ${head}` };
}

// ---- rebuild-restart --------------------------------------------------------

/** POST the front door's rebuild job with drain (the way the header button does, minus the Origin: the host accepts loopback without one). */
function requestRebuild(hostPort: number, drainMinutes: number | null, timeoutMs = 15_000): Promise<{ ok: boolean; result: string }> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ drain: true, ...(drainMinutes ? { drainMinutes } : {}) });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: hostPort,
        path: '/host/rebuild-restart',
        method: 'POST',
        headers: { host: `127.0.0.1:${hostPort}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let parsed: any = null;
          try {
            parsed = JSON.parse(body);
          } catch {
            /* status alone */
          }
          if (res.statusCode === 202 || res.statusCode === 200) {
            return resolve({ ok: true, result: 'rebuild job started (drain): it restarts once no agent is working — end your turn now' });
          }
          resolve({ ok: false, result: `the front door answered ${res.statusCode}: ${String(parsed?.error ?? parsed?.reason ?? body).slice(0, 300)}` });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
    req.on('error', (e) => resolve({ ok: false, result: `front door unreachable: ${(e as Error).message}` }));
    req.end(payload);
  });
}
