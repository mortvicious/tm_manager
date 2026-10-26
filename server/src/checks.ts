// Repo checks — the deterministic half of a task's definition of done
// (docs/checks.md). A check is a saved repo command flagged `isCheck`; after a
// worker turn ends, the orchestrator runs the task's checks here, in the
// commands pool, before the adversarial review round. This module is the pure
// part: which checks apply, how a set is run (serially, one silent re-run of a
// red), and the text the worker and the reviewer are shown.

import type { CheckResult, CheckState, Repo, RepoCommand, Task } from '@tm/shared';
import type { CommandRunner } from './commands/runner.ts';
import { CHECK_TAIL_LINES } from './commands/runner.ts';

/**
 * The checks that apply to `task`, in launcher order: the repo's `isCheck`
 * commands, narrowed to `task.checks` when the task names a subset (null =
 * all, [] = none). A name that matches no check any more is ignored.
 */
export function selectChecks(commands: RepoCommand[], task: Pick<Task, 'checks'>): RepoCommand[] {
  const checks = commands.filter((c) => c.isCheck).sort((a, b) => a.sortOrder - b.sortOrder);
  if (task.checks == null) return checks;
  const wanted = new Set(task.checks);
  return checks.filter((c) => wanted.has(c.name));
}

/**
 * Runs `checks` one after another (they share one working tree, and a build
 * and a typecheck racing each other prove nothing). A red check is re-run
 * once before it counts — the flaky-test guard; the second result is the one
 * kept, marked `retried`. A timeout / spawn failure is `error` and is NOT
 * re-run: a hang would just hang again for another full timeout. `abort` is
 * polled between and during runs; once it says stop, the rest is skipped and
 * null is returned (the caller owns no verdict any more).
 */
export async function runChecks(
  runner: CommandRunner,
  repo: Repo,
  checks: RepoCommand[],
  taskId: string,
  abort: () => boolean | Promise<boolean>,
): Promise<CheckResult[] | null> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    if (await abort()) return null;
    let run = await runner.runCheck(check, repo, { taskId }, abort);
    let retried = false;
    if (run.error === 'aborted') return null;
    if (!run.error && run.exit !== 0) {
      if (await abort()) return null;
      retried = true;
      run = await runner.runCheck(check, repo, { taskId }, abort);
      if (run.error === 'aborted') return null;
    }
    results.push({
      name: check.name,
      command: check.command,
      exit: run.exit,
      durationMs: run.durationMs,
      outcome: run.error ? 'error' : run.exit === 0 ? 'green' : 'red',
      error: run.error,
      retried,
      tail: run.tail,
      runId: run.runId,
    });
  }
  return results;
}

/**
 * The set's verdict. Red wins over error: a red check is something the worker
 * can fix, so it drives the fix loop even when another check timed out. Only
 * all-green is green.
 */
export function checksVerdict(results: CheckResult[]): Exclude<CheckState, 'pending' | 'running'> {
  if (results.some((r) => r.outcome === 'red')) return 'red';
  if (results.some((r) => r.outcome === 'error')) return 'error';
  return 'green';
}

const fence = (s: string) => '```\n' + (s.trim() || '(no output)') + '\n```';

/** One check as a heading line for the worker or the reviewer. */
function headline(r: CheckResult): string {
  const how =
    r.outcome === 'error' ? `no verdict — ${r.error}` : r.outcome === 'red' ? `exit ${r.exit ?? '?'}` : 'exit 0';
  const flaky = r.retried ? (r.outcome === 'green' ? ' (red once, green on the re-run)' : ' (red twice)') : '';
  return `\`${r.name}\` (\`${r.command}\`): ${r.outcome.toUpperCase()}, ${how}${flaky}, ${Math.round(r.durationMs / 1000)}s`;
}

/**
 * The fix instruction typed into the worker's own session when checks are
 * red. Names every failing check with its exit code and the last lines of its
 * output, and forbids the cheap way out.
 */
export function checkFixMessage(results: CheckResult[], round: number, maxRounds: number): string {
  const red = results.filter((r) => r.outcome === 'red');
  const errored = results.filter((r) => r.outcome === 'error');
  const lines = [
    `Repo checks failed after your turn (check round ${round} of ${maxRounds}). The task is not done until they pass.`,
    '',
  ];
  for (const r of red) {
    lines.push(`Check ${headline(r)}. Last ${CHECK_TAIL_LINES} lines:`, fence(r.tail), '');
  }
  for (const r of errored) lines.push(`Also: ${headline(r)}.`, '');
  lines.push(
    'Fix the code so these checks pass. Do NOT weaken, skip, disable or delete a check, a test or a type to make it pass — the reviewer reads the diff. ' +
      'When you finish, the server re-runs the checks.',
  );
  return lines.join('\n');
}

/**
 * Evidence for the reviewer: the checks the server ran on this change and how
 * they ended, with output tails. null when the task has no check results for
 * it (no checks configured, or none ran).
 */
export function checkEvidence(task: Pick<Task, 'checkState' | 'checkResults'>): string | null {
  if (!task.checkState || !task.checkResults.length) return null;
  if (task.checkState === 'pending' || task.checkState === 'running') return null;
  const parts = [
    `## Repo checks (run by the server on this change, not by the worker)`,
    `checks: ${task.checkState}`,
  ];
  for (const r of task.checkResults) {
    parts.push(`- ${headline(r)}`);
    // Tails as evidence, shorter for green (a passing check's last lines are a summary).
    const tail = r.outcome === 'green' ? r.tail.split('\n').slice(-15).join('\n') : r.tail;
    if (tail.trim()) parts.push(fence(tail));
  }
  return parts.join('\n');
}

/**
 * The definition-of-done block of a FRESH worker prompt: the task's acceptance
 * text, plus the checks the server will run when the turn ends. null when the
 * task has neither.
 */
export function definitionOfDone(acceptance: string | null, checks: Pick<RepoCommand, 'name' | 'command'>[]): string | null {
  const text = acceptance?.trim();
  if (!text && !checks.length) return null;
  const lines = ['## Definition of done'];
  if (text) lines.push(text);
  if (checks.length) {
    lines.push(
      `When you finish, the server runs these checks in the repo and hands any failure back to you: ${checks
        .map((c) => `\`${c.name}\` (\`${c.command}\`)`)
        .join(', ')}. Run them yourself before you finish; never weaken or delete one to make it pass.`,
    );
  }
  return lines.join('\n');
}
