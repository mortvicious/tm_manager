// Loop tasks (docs/loops.md) — the pure half: the ledger file, the
// iteration's prompt blocks, the agent's structured result, the progress
// metric and the stop test. The orchestrator owns the state machine
// (`Orchestrator.settleLoopIteration` / `pumpLoops`); nothing here touches
// storage, git or a PTY.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  LOOP_DEFAULT_MAX_ITERATIONS,
  LOOP_NO_PROGRESS_LIMIT,
  type CheckResult,
  type LoopIteration,
  type LoopState,
  type RepoCommand,
  type Task,
} from '@tm/shared';
import { extractJson } from './claude/aux.ts';

/** The ledger's file name inside the task's artifacts dir ($TM_ARTIFACTS_DIR). */
export const LOOP_LEDGER = 'progress.md';
/** How much of the ledger a prompt carries — its END, where the latest state is. */
const LEDGER_PROMPT_CHARS = 12_000;
/** Lines of a red check's output an iteration prompt carries (the fix message's 80 is for one turn, this is per iteration). */
const PROMPT_TAIL_LINES = 40;

export function ledgerPath(artifactsDir: string): string {
  return path.join(artifactsDir, LOOP_LEDGER);
}

/** The ledger as the agent left it, bounded to its last LEDGER_PROMPT_CHARS; null when there is none yet. */
export function readLedger(artifactsDir: string): string | null {
  try {
    const text = fs.readFileSync(ledgerPath(artifactsDir), 'utf8').trim();
    if (!text) return null;
    return text.length > LEDGER_PROMPT_CHARS ? `…(earlier lines cut)\n${text.slice(-LEDGER_PROMPT_CHARS)}` : text;
  } catch {
    return null;
  }
}

export function maxIterations(t: Pick<Task, 'loopMaxIterations'>): number {
  const n = Number(t.loopMaxIterations);
  return Number.isInteger(n) && n >= 1 ? n : LOOP_DEFAULT_MAX_ITERATIONS;
}

const fence = (s: string) => '```\n' + (s.trim() || '(no output)') + '\n```';

function checksSection(task: Pick<Task, 'checkResults' | 'loopHistory'>, checks: Pick<RepoCommand, 'name' | 'command'>[]): string {
  if (!checks.length) return 'No repo checks apply to this loop: the goal and your own verification decide.';
  const last = task.loopHistory.at(-1);
  if (!last || !task.checkResults.length) {
    return `None ran yet. When this iteration ends the server runs: ${checks.map((c) => `\`${c.name}\` (\`${c.command}\`)`).join(', ')}.`;
  }
  const lines = [`After iteration ${last.n} (verdict: ${last.checkState ?? 'none'}):`];
  for (const r of task.checkResults) {
    const how = r.outcome === 'error' ? `no verdict — ${r.error}` : `exit ${r.exit ?? '?'}`;
    lines.push(`- \`${r.name}\` (\`${r.command}\`): ${r.outcome.toUpperCase()}, ${how}`);
    if (r.outcome === 'red') lines.push(fence(r.tail.split('\n').slice(-PROMPT_TAIL_LINES).join('\n')));
  }
  return lines.join('\n');
}

/**
 * The block under the task in an iteration's FRESH prompt: where the loop
 * stands, the goal, the ledger the earlier iterations left, the latest check
 * results, and the rules of an iteration. `n` is this iteration's number.
 */
export function loopNote(opts: {
  task: Pick<Task, 'loopGoal' | 'loopMaxIterations' | 'loopBudgetUsd' | 'costUsd' | 'checkResults' | 'loopHistory' | 'acceptance'>;
  n: number;
  ledger: string | null;
  checks: Pick<RepoCommand, 'name' | 'command'>[];
}): string {
  const { task, n } = opts;
  const max = maxIterations(task);
  const budget = Number(task.loopBudgetUsd) > 0 ? ` Budget: $${task.costUsd.toFixed(2)} spent of $${Number(task.loopBudgetUsd).toFixed(2)}.` : '';
  const recent = task.loopHistory
    .slice(-5)
    .map((h) => `- iteration ${h.n}: ${h.goalMet ? 'said goal met' : 'goal not met'}, checks ${h.checkState ?? 'n/a'}${h.metric !== null ? `, metric ${h.metric}` : ''}${h.noProgress ? ', NO PROGRESS' : ''} — ${h.note ?? '(no note)'}`);
  return [
    `## Loop — iteration ${n} of ${max}`,
    `This task is a LOOP: one goal, worked over several FRESH sessions, one per iteration. You are iteration ${n} and remember nothing of the earlier ones — the ledger below is what they left you.${budget}`,
    '',
    '### Goal',
    task.loopGoal?.trim() || '(no goal recorded — work from the task description)',
    ...(task.acceptance?.trim() ? ['', '### Definition of done', task.acceptance.trim()] : []),
    '',
    `### Ledger ($TM_ARTIFACTS_DIR/${LOOP_LEDGER})`,
    opts.ledger ?? '(empty — this is the first iteration, or the last one wrote nothing: create it)',
    ...(recent.length ? ['', '### Earlier iterations (server record)', ...recent] : []),
    '',
    '### Repo checks',
    checksSection(task, opts.checks),
    '',
    '### This iteration',
    '1. Read the ledger, then take the next most valuable step toward the goal. Do not redo finished work; if the last attempt failed, say why in the ledger and try a different approach.',
    `2. Before you end, REWRITE $TM_ARTIFACTS_DIR/${LOOP_LEDGER} (at most ~60 lines): what is done, what this iteration did, what failed and why, and what the next iteration should do first. It is the only memory the next session has.`,
    '3. Commit your work LOCALLY (the Task trailer below) so the next iteration starts from a clean tree. Never push. Never weaken, skip or delete a check, test or type to make it pass.',
    `4. When you end, the server commits anything you left, runs the checks and decides: the loop ends when the checks are green AND you report the goal met, or after ${max} iterations, the budget, or ${LOOP_NO_PROGRESS_LIMIT} iterations in a row that changed nothing measurable. Asking a question pauses the loop after this iteration — ask only when you cannot decide.`,
  ].join('\n');
}

/** The LAST block of an iteration's prompt: the structured result the server reads at the Stop. */
export function loopResultBlock(): string {
  return [
    '## Loop result (required)',
    'END your final message with this fenced block, nothing after it:',
    '```json',
    '{"goalMet": false, "progress": "one line: what this iteration changed"}',
    '```',
    '`goalMet` is true only when the WHOLE goal is reached in the committed code; the server still checks it.',
  ].join('\n');
}

const loopResultSchema = z.object({
  goalMet: z.boolean(),
  progress: z.string().optional(),
});

/**
 * The agent's structured result from its last message. A missing or invalid
 * block is not an error — it reads as "goal not met" with the start of the
 * message as the note, so a forgetful iteration costs one more iteration,
 * never a silent "met".
 */
export function parseLoopResult(text: string | null | undefined): { goalMet: boolean | null; note: string | null } {
  const raw = text ? extractJson(text) : null;
  const parsed = loopResultSchema.safeParse(raw);
  if (parsed.success) {
    const note = parsed.data.progress?.trim().replace(/\s+/g, ' ').slice(0, 240) || null;
    return { goalMet: parsed.data.goalMet, note };
  }
  const first = text?.trim().split('\n').find((l) => l.trim())?.trim().slice(0, 240) ?? null;
  return { goalMet: null, note: first };
}

const METRIC_RE = /\bTM_METRIC\s*[=:]\s*(-?\d+(?:\.\d+)?)/g;

/**
 * The iteration's progress metric: the LAST `TM_METRIC=<number>` any check
 * printed (checks in launcher order), else the number of green checks. null
 * when no checks ran. Only a TM_METRIC counts toward the no-progress rule: a
 * green count of 0 → 0 is "still red", not "no progress", since a red check
 * hides how much was fixed under it.
 */
export function loopMetric(results: CheckResult[] | null): Pick<LoopIteration, 'metric' | 'metricSource'> {
  if (!results || !results.length) return { metric: null, metricSource: null };
  let found: number | null = null;
  for (const r of results) {
    for (const m of r.tail.matchAll(METRIC_RE)) {
      const v = Number(m[1]);
      if (Number.isFinite(v)) found = v;
    }
  }
  if (found !== null) return { metric: found, metricSource: 'tm-metric' };
  return { metric: results.filter((r) => r.outcome === 'green').length, metricSource: 'green-count' };
}

/**
 * Did this iteration change nothing measurable? The change hash
 * (`workerDiff`: the task's commits + the uncommitted rest) did not move, or
 * — when both iterations report one — the TM_METRIC did not. The first
 * iteration has nothing to compare with: no progress only when it changed
 * nothing at all.
 */
export function noProgress(
  prev: Pick<LoopIteration, 'diffHash' | 'metric' | 'metricSource'> | undefined,
  cur: Pick<LoopIteration, 'diffHash' | 'metric' | 'metricSource'>,
): boolean {
  if (!prev) return cur.diffHash === null;
  if (cur.diffHash === prev.diffHash) return true;
  return cur.metricSource === 'tm-metric' && prev.metricSource === 'tm-metric' && cur.metric === prev.metric;
}

/** Consecutive no-progress iterations at the end of `history`. */
export function noProgressStreak(history: Pick<LoopIteration, 'noProgress'>[]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0 && history[i].noProgress; i--) n++;
  return n;
}

/**
 * The stop test after an iteration, in order: goal met, a human was needed,
 * iterations spent, budget spent, no progress. null = go on. The budget is
 * passed in as a verdict (`budgetAllows(task, 'loop-iteration')` — the part-1
 * helper), so this stays pure.
 */
export function loopStop(opts: {
  n: number;
  max: number;
  goalMet: boolean | null;
  checkState: LoopIteration['checkState'];
  humanNeeded: boolean;
  budgetOk: boolean;
  streak: number;
}): LoopState | null {
  if (opts.goalMet === true && (opts.checkState === 'green' || opts.checkState === null)) return 'met';
  if (opts.humanNeeded) return 'paused';
  if (opts.n >= opts.max) return 'max-iterations';
  if (!opts.budgetOk) return 'budget';
  if (opts.streak >= LOOP_NO_PROGRESS_LIMIT) return 'no-progress';
  return null;
}

/** Human words for an end state — the row's `error`/summary line and the pings. */
export function loopStopText(state: LoopState, n: number, max: number): string {
  switch (state) {
    case 'met':
      return `loop: goal met after ${n} iteration${n === 1 ? '' : 's'}, checks green`;
    case 'paused':
      return `loop paused after iteration ${n}: it needed a human (a question or a permission prompt) — Continue goes on`;
    case 'max-iterations':
      return `loop stopped: ${max} iteration${max === 1 ? '' : 's'} used without meeting the goal`;
    case 'budget':
      return `loop stopped after iteration ${n}: its budget is spent — raise it and Continue`;
    case 'no-progress':
      return `loop stopped after iteration ${n}: ${LOOP_NO_PROGRESS_LIMIT} iterations in a row changed nothing measurable`;
    case 'error':
      return `loop stopped after iteration ${n}: the iteration could not be judged`;
    default:
      return `loop: ${state}`;
  }
}
