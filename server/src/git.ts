import { execFile } from 'node:child_process';
import type { Repo } from '@tm/shared';
import type { Storage } from './storage/types.ts';

// Repo git operations behind explicit UI buttons. Commit messages are written
// by claude-opus-5 from the staged diff (user policy 2026-08-24).

const COMMIT_MODEL = 'claude-opus-5';

function run(cwd: string, cmd: string, args: string[], timeoutMs = 60_000): Promise<{ out: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: cleanEnv() },
      (err, stdout, stderr) => {
        const rawCode = (err as { code?: unknown } | null)?.code;
        resolve({
          out: `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim(),
          code: err ? (typeof rawCode === 'number' ? rawCode : 1) : 0,
        });
      },
    );
  });
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE') env[k] = v;
  }
  return env;
}

// One git operation per repo at a time — a double-click must not race add/commit.
const busy = new Set<string>();

/** commitRepo's "clean tree" refusal, which publishRepo treats as a non-error. */
const NOTHING_TO_COMMIT = 'nothing to commit — working tree is clean';

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  dirty: number;
  ahead: number;
}

export async function gitStatus(repo: Repo): Promise<GitStatus> {
  const isRepo = await run(repo.path, 'git', ['rev-parse', '--git-dir']);
  if (isRepo.code !== 0) return { isRepo: false, branch: null, dirty: 0, ahead: 0 };
  // --abbrev-ref HEAD fails on an unborn branch (repo with no commits yet);
  // fall back to the symbolic ref so a fresh repo still shows its controls.
  let branch = (await run(repo.path, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'])).out.split('\n')[0].trim();
  if (!branch || branch === 'HEAD') {
    branch = (await run(repo.path, 'git', ['symbolic-ref', '--short', '-q', 'HEAD'])).out.trim() || 'main';
  }
  const status = await run(repo.path, 'git', ['status', '--porcelain']);
  const dirty = status.out ? status.out.split('\n').filter(Boolean).length : 0;
  const aheadRes = await run(repo.path, 'git', ['rev-list', '--count', '@{upstream}..HEAD']);
  const ahead = aheadRes.code === 0 ? Number(aheadRes.out.trim()) || 0 : 0;
  return { isRepo: true, branch, dirty, ahead };
}

export async function commitRepo(
  storage: Storage,
  repo: Repo,
  actor = 'human',
): Promise<{ ok: true; message: string; summary: string } | { ok: false; code: number; error: string }> {
  if (busy.has(repo.id)) return { ok: false, code: 409, error: 'a git operation is already running for this repo' };
  busy.add(repo.id);
  try {
    const check = await run(repo.path, 'git', ['rev-parse', '--git-dir']);
    if (check.code !== 0) return { ok: false, code: 409, error: 'not a git repository' };

    const add = await run(repo.path, 'git', ['add', '-A']);
    if (add.code !== 0) return { ok: false, code: 500, error: `git add failed: ${add.out.slice(0, 300)}` };

    const stat = await run(repo.path, 'git', ['diff', '--cached', '--stat']);
    if (!stat.out.trim()) return { ok: false, code: 409, error: NOTHING_TO_COMMIT };
    const diff = await run(repo.path, 'git', ['diff', '--cached']);
    const diffText = diff.out.slice(0, 30_000);

    // Opus writes the message from the staged diff (headless, read-only).
    const prompt = [
      'Write a git commit message for the staged changes below.',
      'First line: concise imperative summary under 70 chars. If the change set is non-trivial,',
      'add a blank line and 1-4 short bullet lines. No code fences, no quotes around the message.',
      '',
      '--- diffstat ---',
      stat.out.slice(0, 3000),
      '',
      '--- diff (truncated) ---',
      diffText,
    ].join('\n');
    const gen = await new Promise<{ out: string; code: number }>((resolve) => {
      const child = execFile(
        'claude',
        [
          '-p',
          '--model',
          COMMIT_MODEL,
          '--permission-mode',
          'dontAsk',
          '--disallowedTools',
          'Edit',
          'Write',
          'NotebookEdit',
          'Bash',
          '--output-format',
          'json',
          '--json-schema',
          JSON.stringify({
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
          }),
        ],
        { cwd: repo.path, timeout: 180_000, maxBuffer: 16 * 1024 * 1024, env: cleanEnv() },
        (err, stdout) => resolve({ out: String(stdout ?? ''), code: err ? 1 : 0 }),
      );
      child.stdin?.on('error', () => {});
      child.stdin?.write(prompt);
      child.stdin?.end();
    });
    let message = '';
    try {
      const envelope = JSON.parse(gen.out);
      message = String(envelope?.structured_output?.message ?? '').trim();
    } catch {
      // fall through
    }
    if (!message) {
      // never leave changes staged-but-uncommitted silently; fall back plainly
      message = `chore: update (${stat.out.trim().split('\n').pop()?.trim() ?? 'changes'})`;
    }
    message += `\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>`;

    const commit = await run(repo.path, 'git', ['commit', '-m', message]);
    if (commit.code !== 0) return { ok: false, code: 500, error: `git commit failed: ${commit.out.slice(0, 300)}` };

    await storage.appendEvent({
      kind: 'repo.changed',
      actor,
      repoId: repo.id,
      data: { action: 'commit', message: message.split('\n')[0], model: COMMIT_MODEL },
    });
    return { ok: true, message, summary: stat.out.trim().split('\n').pop()?.trim() ?? '' };
  } finally {
    busy.delete(repo.id);
  }
}

export async function pushRepo(
  storage: Storage,
  repo: Repo,
  actor = 'human',
): Promise<{ ok: true; output: string } | { ok: false; code: number; error: string }> {
  if (busy.has(repo.id)) return { ok: false, code: 409, error: 'a git operation is already running for this repo' };
  busy.add(repo.id);
  try {
    const check = await run(repo.path, 'git', ['rev-parse', '--git-dir']);
    if (check.code !== 0) return { ok: false, code: 409, error: 'not a git repository' };
    // push current branch; set upstream on first push
    const upstream = await run(repo.path, 'git', ['rev-parse', '--abbrev-ref', '@{upstream}']);
    const args = upstream.code === 0 ? ['push'] : ['push', '-u', 'origin', 'HEAD'];
    const push = await run(repo.path, 'git', args, 120_000);
    if (push.code !== 0) return { ok: false, code: 500, error: `git push failed: ${push.out.slice(0, 400)}` };
    await storage.appendEvent({
      kind: 'repo.changed',
      actor,
      repoId: repo.id,
      data: { action: 'push' },
    });
    return { ok: true, output: push.out.slice(0, 400) };
  } finally {
    busy.delete(repo.id);
  }
}

// ---- publish (docs/publish.md) ----

export interface PublishCheck {
  /** the work is committed AND on the remote */
  ok: boolean;
  /** what is still missing; null when ok */
  reason: string | null;
  branch: string | null;
  /** short HEAD sha, for the audit trail */
  head: string | null;
}

/**
 * Ground truth for "is this shipped?". The publish step is carried out by the
 * agent inside its own terminal, and an agent can believe it pushed when it
 * did not (rejected push, a file left untracked, a wedged credential helper) —
 * so the task only reaches `published` when git itself agrees: nothing
 * uncommitted, an upstream exists, and nothing left ahead of it.
 */
export async function verifyPublished(repo: Repo): Promise<PublishCheck> {
  const isRepo = await run(repo.path, 'git', ['rev-parse', '--git-dir']);
  if (isRepo.code !== 0) return { ok: false, reason: 'not a git repository', branch: null, head: null };
  const branchRes = await run(repo.path, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRes.code === 0 ? branchRes.out.split('\n')[0].trim() || null : null;
  const headRes = await run(repo.path, 'git', ['rev-parse', '--short', 'HEAD']);
  const head = headRes.code === 0 ? headRes.out.split('\n')[0].trim() || null : null;
  if (!head) return { ok: false, reason: 'the branch has no commits yet', branch, head: null };

  const status = await run(repo.path, 'git', ['status', '--porcelain']);
  const dirty = status.out ? status.out.split('\n').filter(Boolean).length : 0;
  if (dirty > 0) {
    return { ok: false, reason: `${dirty} uncommitted change(s) still in the working tree`, branch, head };
  }
  const upstream = await run(repo.path, 'git', ['rev-parse', '--abbrev-ref', '@{upstream}']);
  if (upstream.code !== 0) return { ok: false, reason: 'the branch has no upstream — nothing was pushed', branch, head };
  const aheadRes = await run(repo.path, 'git', ['rev-list', '--count', '@{upstream}..HEAD']);
  const ahead = aheadRes.code === 0 ? Number(aheadRes.out.trim()) || 0 : 0;
  if (ahead > 0) {
    return { ok: false, reason: `${ahead} commit(s) not pushed to ${upstream.out.split('\n')[0].trim()}`, branch, head };
  }
  return { ok: true, reason: null, branch, head };
}

/**
 * add + commit + push, in-process. This is the FALLBACK path: publishing
 * normally happens inside the agent's own session (see Orchestrator.publish),
 * and this runs only when there is no session left to reopen — otherwise a
 * task whose transcript was pruned could never be published at all.
 * A clean tree is not a failure here: there may still be local commits to push.
 */
export async function publishRepo(
  storage: Storage,
  repo: Repo,
  actor = 'human',
): Promise<
  { ok: true; committed: boolean; message: string | null; output: string } | { ok: false; code: number; error: string }
> {
  const commit = await commitRepo(storage, repo, actor);
  if (!commit.ok && commit.error !== NOTHING_TO_COMMIT) return commit;
  const push = await pushRepo(storage, repo, actor);
  if (!push.ok) return push;
  return {
    ok: true,
    committed: commit.ok,
    message: commit.ok ? commit.message : null,
    output: push.output,
  };
}
