import { randomUUID } from 'node:crypto';
import type { CheckBaseline, Repo, RepoCommand } from '@tm/shared';
import { gitStatus } from '../git.ts';
import type { Storage } from '../storage/types.ts';
import type { CommandRunner } from './runner.ts';

/** Finished baselines kept for the save that follows (in memory, like command runs). */
const MAX_KEPT = 50;

export interface BaselineSpec {
  name: string;
  command: string;
  /** '' = repo root (already validated by the caller) */
  cwd: string;
  timeoutSec: number | null;
}

/** The spec a save must match to count the baseline (trimmed, '' / '.' = root). */
function sameSpec(b: CheckBaseline, repoId: string, spec: { command: string; cwd: string; timeoutSec: number | null }): boolean {
  const cwd = spec.cwd === '.' ? '' : spec.cwd;
  return b.repoId === repoId && b.command === spec.command.trim() && b.cwd === cwd && b.timeoutSec === spec.timeoutSec;
}

/**
 * A check's BASELINE (docs/checks.md § Baseline): before a command is saved as
 * a check it runs once on the checkout as it stands, through the same
 * `runCheck` the verify loop uses (commands pool, attachable, `CI=1`, the
 * check's own timeout). A check that is already red there would send every
 * task through `checks.maxRounds` fix turns for someone else's failure, so a
 * red or no-verdict baseline blocks the save until the human confirms.
 *
 * In memory only: a restart forgets them, and the save then asks for a new run.
 */
export class CheckBaselines {
  private jobs = new Map<string, CheckBaseline>();

  constructor(
    private storage: Storage,
    private runner: CommandRunner,
  ) {}

  get(id: string): CheckBaseline | null {
    const b = this.jobs.get(id);
    return b ? { ...b } : null;
  }

  /** The baseline a save names, if it is for exactly this command line. */
  forSave(id: string, repoId: string, spec: { command: string; cwd: string; timeoutSec: number | null }):
    | { ok: true; baseline: CheckBaseline }
    | { ok: false; reason: string } {
    const b = this.jobs.get(id);
    if (!b) return { ok: false, reason: 'that baseline is gone (the server restarted) — run it again' };
    if (!sameSpec(b, repoId, spec)) return { ok: false, reason: 'that baseline was run for a different command line — run it again' };
    if (b.status === 'running') return { ok: false, reason: 'the baseline is still running' };
    return { ok: true, baseline: { ...b } };
  }

  /**
   * Starts a baseline and returns it at once (status `running`); the run takes
   * up to the check's timeout, so the caller polls `get`. A second press while
   * one for the same command line is running gets that one back.
   */
  async start(repo: Repo, spec: BaselineSpec, actor: string): Promise<CheckBaseline> {
    const live = [...this.jobs.values()].find((b) => b.status === 'running' && sameSpec(b, repo.id, spec));
    if (live) return { ...live };
    const git = await gitStatus(repo).catch(() => null);
    const b: CheckBaseline = {
      id: `bl-${randomUUID()}`,
      repoId: repo.id,
      name: spec.name,
      command: spec.command.trim(),
      cwd: spec.cwd,
      timeoutSec: spec.timeoutSec,
      status: 'running',
      verdict: null,
      exit: null,
      error: null,
      durationMs: 0,
      tail: '',
      runId: null,
      branch: git?.branch ?? null,
      dirty: git?.dirty ?? 0,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.jobs.set(b.id, b);
    this.trim();
    // Not a saved row: a definition of its own, so a human's live run of a
    // same-named command is never waited on or mistaken for this one.
    const now = b.startedAt;
    const command: RepoCommand = {
      id: b.id,
      repoId: repo.id,
      name: `${spec.name} (baseline)`,
      command: b.command,
      kind: 'task',
      cwd: b.cwd || null,
      sortOrder: 0,
      isCheck: true,
      timeoutSec: spec.timeoutSec,
      ownerTaskId: null,
      archivedAt: null,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    };
    void this.finish(b, command, repo, actor);
    return { ...b };
  }

  private async finish(b: CheckBaseline, command: RepoCommand, repo: Repo, actor: string): Promise<void> {
    const run = await this.runner.runCheck(command, repo, { baseline: true }, undefined, actor);
    b.runId = run.runId;
    b.exit = run.exit;
    b.error = run.error;
    b.durationMs = run.durationMs;
    b.tail = run.tail;
    b.verdict = run.error ? 'error' : run.exit === 0 ? 'green' : 'red';
    b.status = 'done';
    b.endedAt = new Date().toISOString();
    await this.storage
      .appendEvent({
        kind: 'command.run',
        actor,
        repoId: repo.id,
        data: {
          action: 'baseline',
          name: b.name,
          command: b.command,
          cwd: b.cwd || null,
          verdict: b.verdict,
          exit: b.exit,
          error: b.error,
          durationMs: b.durationMs,
          branch: b.branch,
          dirty: b.dirty,
        },
      })
      .catch(() => {});
  }

  private trim(): void {
    const done = [...this.jobs.values()].filter((b) => b.status === 'done');
    for (const b of done.slice(0, Math.max(0, done.length - MAX_KEPT))) this.jobs.delete(b.id);
  }
}
