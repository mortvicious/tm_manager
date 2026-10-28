import type { GitFailureKind, Repo, RepoPushHealth } from '@tm/shared';
import { run } from './git.ts';

// Push health of `delivery: 'pr'` repos (docs/parallel.md § Push health).
//
// The night of 2026-10-26/27 every push the server made to neko-frontend
// failed with `Permission denied (publickey)` — the Mac had rebooted and the
// key's passphrase was in neither the ssh-agent nor the keychain — and the
// only trace was `task.pr push-failed` audit rows: 14 of them, while the
// queue kept forking new worktrees from a stale `origin/main`. So a push
// failure is now a REPO state, not a row: read by a preflight (ls-remote +
// `push --dry-run`) at boot and on a timer, and by every real push the server
// makes. While a repo fails it starts no new task, pushes nothing and lands
// nothing, and the first failure raises one `push-failed` alert.

/**
 * What a failed git network command says about its cause. From git's and
 * ssh's own words, network first: "Could not read from remote repository"
 * follows an unresolvable host as well as a refused key.
 */
export function classifyGitFailure(out: string): GitFailureKind {
  const t = out.toLowerCase();
  if (
    /could not resolve host|could not resolve hostname|connection timed out|operation timed out|network is unreachable|connection refused|connection reset|connection closed by|failed to connect to|no route to host|temporary failure in name resolution/.test(
      t,
    )
  ) {
    return 'network';
  }
  if (/protected branch|gh006|gh013|repository rule violations|pre-receive hook declined|\[remote rejected\]/.test(t)) return 'protected';
  if (
    /permission denied \(publickey|permission denied|could not read from remote repository|could not read (username|password)|terminal prompts disabled|authentication failed|invalid username or password|host key verification failed|repository not found|correct access rights|returned error: 40[13]|marked as read only|password authentication was removed/.test(
      t,
    )
  ) {
    return 'auth';
  }
  if (/\[rejected\]|non-fast-forward|fetch first|stale info/.test(t)) return 'race';
  return 'other';
}

/** Kinds that hold a repo until it is fixed: a retry cannot help, and a human must act. */
export function holdsRepo(kind: GitFailureKind | undefined): boolean {
  return kind === 'auth' || kind === 'protected';
}

function tail(text: string, n = 3): string {
  return text.trim().split('\n').filter((l) => l.trim()).slice(-n).join(' ').slice(0, 400);
}

/**
 * The environment of every network git call the server makes (fetch, push,
 * ls-remote): never a prompt. The server may run in a terminal, where ssh
 * would otherwise ask for a passphrase on that TTY and hang until the timeout;
 * a repo's own `core.sshCommand` (or an inherited `GIT_SSH_COMMAND`) is left alone.
 */
export async function gitNetEnv(repoPath: string): Promise<Record<string, string>> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  if (process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) return env;
  const own = await run(repoPath, 'git', ['config', '--get', 'core.sshCommand']);
  if (own.code === 0 && own.out.trim()) return env;
  env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=20';
  return env;
}

export interface ProbeResult {
  ok: boolean;
  kind?: GitFailureKind;
  error?: string;
  step?: RepoPushHealth['step'];
  base?: string;
  localAhead?: number;
}

/** `origin/<base>` of a repo, as the land resolves it (worktrees.ts `defaultBranch`). */
export type BaseResolver = (repo: Repo) => Promise<{ remote: string; branch: string; ref: string } | null>;

/**
 * The preflight: can the server READ the base branch (`ls-remote`) and WRITE
 * to the remote (`push --dry-run` of the base to a probe ref — nothing is
 * sent, but the remote still checks the credentials for a push)? Plus how many
 * commits the local base branch has that the remote's lacks.
 */
export async function probePush(repo: Repo, resolveBase: BaseResolver, timeoutMs = 45_000): Promise<ProbeResult> {
  const def = await resolveBase(repo);
  if (!def) {
    return { ok: false, kind: 'other', step: 'base', error: repo.baseBranch ? `origin/${repo.baseBranch} does not exist` : 'no origin default branch' };
  }
  const env = await gitNetEnv(repo.path);
  const ls = await run(repo.path, 'git', ['ls-remote', '--heads', def.remote, `refs/heads/${def.branch}`], timeoutMs, env);
  if (ls.code !== 0) return { ok: false, kind: classifyGitFailure(ls.out), step: 'ls-remote', error: tail(ls.out), base: def.ref };
  const push = await run(
    repo.path,
    'git',
    ['push', '--dry-run', '--porcelain', def.remote, `${def.ref}:refs/heads/tm-push-probe`],
    timeoutMs,
    env,
  );
  if (push.code !== 0) return { ok: false, kind: classifyGitFailure(push.out), step: 'push', error: tail(push.out), base: def.ref };
  const remoteSha = ls.out.trim().split(/\s+/)[0] ?? '';
  return { ok: true, base: def.ref, localAhead: await localAhead(repo.path, def, remoteSha) };
}

/**
 * Commits on the local `<base>` that the remote's `<base>` lacks — measured
 * against the sha ls-remote just read when this clone has it, else against
 * the tracking ref. 0 when there is no local branch of that name.
 */
export async function localAhead(repoPath: string, def: { branch: string; ref: string }, remoteSha = ''): Promise<number> {
  const local = await run(repoPath, 'git', ['rev-parse', '--verify', '--quiet', `refs/heads/${def.branch}`]);
  if (local.code !== 0) return 0;
  const known = /^[0-9a-f]{40}$/.test(remoteSha) && (await run(repoPath, 'git', ['cat-file', '-e', `${remoteSha}^{commit}`])).code === 0;
  const n = await run(repoPath, 'git', ['rev-list', '--count', `${known ? remoteSha : def.ref}..refs/heads/${def.branch}`]);
  return n.code === 0 ? Number(n.out.trim()) || 0 : 0;
}

type Listener = (now: RepoPushHealth, prev: RepoPushHealth | undefined) => void | Promise<void>;

/**
 * The in-memory health of every `pr` repo. One per process (`pushHealth`
 * below); the orchestrator configures its probe and listener, and reads
 * `failingRepoIds()` into every claim. A real push the server makes reports
 * here too: an auth/protected failure holds the repo at once (no waiting for
 * the next probe), and a successful push clears a hold.
 */
export class PushHealth {
  private entries = new Map<string, RepoPushHealth>();
  private inFlight = new Map<string, Promise<RepoPushHealth>>();

  constructor(
    private probe: (repo: Repo) => Promise<ProbeResult> = async () => ({ ok: true }),
    private listener?: Listener,
    private clock: () => Date = () => new Date(),
  ) {}

  configure(o: { probe?: (repo: Repo) => Promise<ProbeResult>; onChange?: Listener }): void {
    if (o.probe) this.probe = o.probe;
    if (o.onChange) this.listener = o.onChange;
  }

  list(): RepoPushHealth[] {
    return [...this.entries.values()].sort((a, b) => a.repoName.localeCompare(b.repoName));
  }

  get(repoId: string): RepoPushHealth | undefined {
    return this.entries.get(repoId);
  }

  failingRepoIds(): string[] {
    return [...this.entries.values()].filter((e) => !e.ok).map((e) => e.repoId);
  }

  /** Why nothing may push/land/fork in this repo right now, or null. */
  refusal(repoId: string): string | null {
    const e = this.entries.get(repoId);
    if (!e || e.ok) return null;
    return `push to origin fails for ${e.repoName}${e.kind ? ` (${e.kind})` : ''}: ${e.error ?? 'unknown error'} — fix the server's git credentials; it is re-checked every minute`;
  }

  /** Run the preflight now (single-flight per repo). */
  check(repo: Repo): Promise<RepoPushHealth> {
    const running = this.inFlight.get(repo.id);
    if (running) return running;
    const p = this.probe(repo)
      .catch((e): ProbeResult => ({ ok: false, kind: 'other', error: String((e as Error)?.message ?? e).slice(0, 300) }))
      .then((r) => this.apply(repo, r))
      .finally(() => this.inFlight.delete(repo.id));
    this.inFlight.set(repo.id, p);
    return p;
  }

  /**
   * Probe the `pr` repos that are due: a failing one every pass (the caller's
   * minute), a healthy one every `healthyEveryMs`. Repos no longer `pr` are
   * forgotten, so a repo switched to `direct` never stays held.
   */
  async sweep(repos: Repo[], healthyEveryMs = 5 * 60_000, force = false): Promise<void> {
    const pr = repos.filter((r) => r.delivery === 'pr');
    const keep = new Set(pr.map((r) => r.id));
    for (const id of [...this.entries.keys()]) if (!keep.has(id)) this.entries.delete(id);
    const now = this.clock().getTime();
    for (const repo of pr) {
      const e = this.entries.get(repo.id);
      const due = force || !e || !e.ok || now - Date.parse(e.checkedAt) >= healthyEveryMs;
      if (due) await this.check(repo);
    }
  }

  /**
   * A real network git command failed (`step` names which). Holds the repo
   * when the cause is one only a human can fix (auth, branch protection);
   * returns the classification either way.
   */
  async report(repo: Repo, out: string, step: RepoPushHealth['step']): Promise<GitFailureKind> {
    const kind = classifyGitFailure(out);
    if (holdsRepo(kind)) {
      const prev = this.entries.get(repo.id);
      await this.apply(repo, { ok: false, kind, step, error: tail(out), base: prev?.base, localAhead: prev?.localAhead });
    }
    return kind;
  }

  /** A real push succeeded: the credentials work, whatever the last probe said. */
  async reportOk(repo: Repo): Promise<void> {
    const prev = this.entries.get(repo.id);
    if (prev && !prev.ok) await this.apply(repo, { ok: true, base: prev.base, localAhead: prev.localAhead });
  }

  private async apply(repo: Repo, r: ProbeResult): Promise<RepoPushHealth> {
    const prev = this.entries.get(repo.id);
    const at = this.clock().toISOString();
    const next: RepoPushHealth = {
      repoId: repo.id,
      repoName: repo.name,
      ok: r.ok,
      checkedAt: at,
      ...(r.base ? { base: r.base } : {}),
      ...(r.localAhead !== undefined ? { localAhead: r.localAhead } : prev?.localAhead !== undefined ? { localAhead: prev.localAhead } : {}),
      ...(r.ok
        ? {}
        : {
            kind: r.kind ?? 'other',
            step: r.step,
            error: r.error ?? 'unknown error',
            failingSince: prev && !prev.ok && prev.failingSince ? prev.failingSince : at,
          }),
    };
    this.entries.set(repo.id, next);
    const changed = !prev || prev.ok !== next.ok || prev.kind !== next.kind || (prev.localAhead ?? 0) !== (next.localAhead ?? 0);
    if (changed && this.listener) {
      try {
        await this.listener(next, prev);
      } catch (e) {
        console.error('push health listener failed:', e);
      }
    }
    return next;
  }
}

/** The process's one health store (the orchestrator configures it at construction). */
export const pushHealth = new PushHealth();
