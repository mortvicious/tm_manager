// Budget fuses (docs/token-budget.md § Fuses). Every automatic loop this
// server runs — the review fix round, dispatch wakes, auto wake-up, and the
// later check-fix / transient-resume rounds — asks `budgetAllows` before it
// starts a turn, and the claim loop asks it before it claims. All three fuses
// are OFF by default (0); a human click never goes through here.

import type { AppSettings, Run, Task } from '@tm/shared';
import { runTaskId } from '@tm/shared';
import { broadcast } from './events.ts';
import type { Storage } from './storage/types.ts';

/**
 * What is asking. `claim` is the day fuse (a new task starting); every other
 * kind is an AUTOMATIC turn on an existing task and is measured against that
 * task's roll-up. `check-round` is the repo-check fix round of the verify
 * loop (docs/checks.md); `transient-resume` is reserved for the worker
 * StopFailure resume (a later autonomy part).
 */
export type BudgetTurn =
  | 'claim'
  | 'fix-round'
  | 'dispatch'
  | 'wake'
  | 'check-round'
  | 'transient-resume'
  | 'auto-publish'
  | 'loop-iteration';

/**
 * `loop.budgetUsd` is a loop task's OWN ceiling (`Task.loopBudgetUsd`,
 * docs/loops.md), measured like `budget.taskUsd` against the task's roll-up
 * and applied to every automatic turn on that task, the next iteration
 * included; the lower of the two caps wins.
 */
export type BudgetFuse = 'budget.taskUsd' | 'budget.dayUsd' | 'loop.budgetUsd';

export type BudgetVerdict =
  | { ok: true }
  | { ok: false; fuse: BudgetFuse; spentUsd: number; capUsd: number; reason: string };

/** Midnight of the server-local day `d` falls in — the same day the Dashboard buckets on (routes/stats.ts). */
export function localDayStart(d = new Date()): Date {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  return start;
}

/** Server-local YYYY-MM-DD, the day fuse's audit and coalescing key. */
export function localDayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Today's spend: every run started since local midnight, any mode — attributed by start time like the Dashboard. */
export function spentToday(storage: Storage, at = new Date()): Promise<number> {
  return storage.spendSince(localDayStart(at).toISOString());
}

/** A fuse value from settings: anything not a positive finite number is off. */
function fuse(settings: AppSettings, key: 'budget.taskUsd' | 'budget.dayUsd' | 'budget.runMinutes'): number {
  const v = Number(settings[key]);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function runMinutesCap(settings: AppSettings): number {
  return fuse(settings, 'budget.runMinutes');
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * May this automatic turn (or claim) start? The one gate the autonomy parts
 * call. Per-task kinds re-read the task row, so the roll-up is the one the
 * storage layer last wrote, not whatever copy the caller holds; a task that is
 * gone is allowed (the caller's own checks refuse it with a better reason).
 * At or OVER the cap refuses: a cap of $5 means the fifth dollar is the last.
 */
export async function budgetAllows(
  storage: Storage,
  task: Pick<Task, 'id'> | null,
  kind: BudgetTurn,
  settings?: AppSettings,
): Promise<BudgetVerdict> {
  const s = settings ?? (await storage.getSettings());
  if (kind === 'claim') {
    const cap = fuse(s, 'budget.dayUsd');
    if (!cap) return { ok: true };
    const spent = await spentToday(storage);
    if (spent < cap) return { ok: true };
    return {
      ok: false,
      fuse: 'budget.dayUsd',
      spentUsd: spent,
      capUsd: cap,
      reason: `today's spend ${usd(spent)} reached the ${usd(cap)} day budget — claiming stopped until midnight`,
    };
  }
  const taskCap = fuse(s, 'budget.taskUsd');
  if (!task) return { ok: true };
  const fresh = await storage.getTask(task.id);
  if (!fresh) return { ok: true };
  const loopCap = fresh.kind === 'loop' ? loopBudget(fresh) : 0;
  // the lower positive cap wins; a loop's own budget names itself
  const useLoop = loopCap > 0 && (!taskCap || loopCap <= taskCap);
  const cap = useLoop ? loopCap : taskCap;
  if (!cap) return { ok: true };
  if (fresh.costUsd < cap) return { ok: true };
  return {
    ok: false,
    fuse: useLoop ? 'loop.budgetUsd' : 'budget.taskUsd',
    spentUsd: fresh.costUsd,
    capUsd: cap,
    reason: `budget: this task has cost ${usd(fresh.costUsd)}, at or over the ${usd(cap)} ${useLoop ? 'loop' : 'per-task'} budget — the automatic ${KIND_LABEL[kind]} was not started. ${useLoop ? 'Raise the loop budget and Continue' : 'Proceed, Follow-up or Retry still work'}.`,
  };
}

/** A loop task's own ceiling; anything not a positive finite number is none. */
export function loopBudget(t: Pick<Task, 'loopBudgetUsd'>): number {
  const v = Number(t.loopBudgetUsd);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

const KIND_LABEL: Record<BudgetTurn, string> = {
  claim: 'claim',
  'fix-round': 'review fix round',
  dispatch: 'dispatch turn',
  wake: 'wake-up resume',
  'check-round': 'check fix round',
  'transient-resume': 'transient-error resume',
  'auto-publish': 'publish turn (auto-publish landing)',
  'loop-iteration': 'next loop iteration',
};

/**
 * A run's stats were just written: re-read the task its cost rolls up to and
 * announce it, so the card's cost chip moves with the run's. Best-effort.
 */
export async function broadcastTaskCost(storage: Storage, run: Pick<Run, 'taskId' | 'kind' | 'subjectId'> | null): Promise<void> {
  const taskId = run ? runTaskId(run) : null;
  if (!taskId) return;
  try {
    const task = await storage.getTask(taskId);
    if (task) broadcast({ type: 'task.updated', task });
  } catch {
    // a cost refresh must never break the writer it rides on
  }
}
