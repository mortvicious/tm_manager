// Task waits (docs/task-waits.md): a worker that finds its next step needs
// another task's change calls `POST /api/agent/wait`, ends its turn, parks
// `blocked` with `Task.waitFor`, and is resumed in its OWN session once that
// task settles. This module is the pure part — whether a wait may begin,
// whether it is over, and what the resumed turn is told — so the routes and
// the orchestrator share one reading and the tests need no server.

import type { Task, TaskStatus, TaskWait } from '@tm/shared';
import { DEPENDENCY_SETTLED_STATUSES, dependencyCycle } from '@tm/shared';
import type { Storage } from './storage/types.ts';

/** a wait that outlives this is handed back to its agent (it may wait again) */
export const WAIT_MAX_MS = 24 * 60 * 60_000;

/** what the waited-for task may be when a wait begins */
export const WAITABLE_STATUSES: readonly TaskStatus[] = ['queued', 'running', 'waiting', 'review', 'blocked'];

export type WaitRefusal = { code: 400 | 404 | 409; error: string };

/**
 * Why `caller` may not wait for `target` now, or null when it may. `cycle` is
 * the caller's `dependencyCycle` answer (the target, transitively, waits on
 * or depends on the caller).
 */
export function waitRefusal(
  caller: Pick<Task, 'id' | 'status' | 'kind'> | null,
  target: Pick<Task, 'id' | 'status' | 'title'> | null,
  opts: { publishTurn: boolean; cycle: boolean; stuck?: string | null },
): WaitRefusal | null {
  if (!caller) return { code: 400, error: 'this session has no task' };
  if (caller.status !== 'running') return { code: 409, error: `your task is ${caller.status}, not running — only a working turn can wait` };
  if (caller.kind === 'loop') {
    return { code: 409, error: 'a loop task cannot wait: every iteration is a fresh session — end the iteration and report what blocks you' };
  }
  if (opts.publishTurn) return { code: 409, error: 'the publish turn cannot wait — finish publishing' };
  if (!target) return { code: 404, error: 'no such task — use an exact task id (GET /api/agent/tasks lists the active ones)' };
  if (target.id === caller.id) return { code: 400, error: 'a task cannot wait for itself' };
  if (target.status === 'done' || target.status === 'published') {
    return {
      code: 409,
      error: `"${target.title}" has already landed (${target.status}) — bring its change in now (worktree: git fetch origin && git rebase origin/<base>; checkout: its commits are already here) and carry on`,
    };
  }
  if (target.status === 'draft') {
    return { code: 409, error: `"${target.title}" is a draft — it never starts on its own; ask the human (AskUserQuestion) instead of waiting` };
  }
  if (!WAITABLE_STATUSES.includes(target.status)) {
    return { code: 409, error: `"${target.title}" is ${target.status} — its change is not coming; decide without it or ask the human` };
  }
  if (opts.cycle) return { code: 409, error: `"${target.title}" already waits on (or depends on) your task — waiting for it would deadlock both` };
  if (opts.stuck) return { code: 409, error: `${opts.stuck} — waiting for it would hold you until the ${WAIT_MAX_MS / 3_600_000} h timeout; do that part yourself if it is in your scope, else ask the human (AskUserQuestion)` };
  return null;
}

/**
 * Why a QUEUED target cannot start while the caller is parked, or null
 * (review round 1): the claim would never reach it, so the wait could only
 * end at the timeout. Mirrors the claim's own holds — the feature phase gate
 * (the parked caller is an unsettled lower-phase task), a feature that is not
 * running, Undo start's hold, and the stopped global queue (the custom queue
 * runs regardless; overflow claims only run while the queue does).
 */
export function waitTargetStuck(
  caller: Pick<Task, 'featureId' | 'featurePhase'>,
  target: Pick<Task, 'title' | 'status' | 'featureId' | 'featurePhase' | 'queueHeldAt' | 'customQueueAt'>,
  ctx: { queueEnabled: boolean; targetFeatureStatus: string | null },
): string | null {
  if (target.status !== 'queued') return null;
  const name = `"${target.title}"`;
  if (target.queueHeldAt) return `${name} is held in the queue (Undo start) and starts only when a human releases it`;
  if (target.featureId) {
    if (ctx.targetFeatureStatus !== 'running') return `${name} belongs to a feature that is ${ctx.targetFeatureStatus ?? 'gone'}, so it does not start`;
    if (
      target.featureId === caller.featureId &&
      caller.featurePhase != null &&
      target.featurePhase != null &&
      target.featurePhase > caller.featurePhase
    ) {
      return `${name} is in a later phase (${target.featurePhase}) of your feature: it starts only after your phase (${caller.featurePhase}) settles, which includes you`;
    }
  }
  if (!target.customQueueAt && !ctx.queueEnabled) return `${name} is in the global queue, which is stopped`;
  return null;
}

export type WaitOutcome = 'published' | 'done' | 'cancelled' | 'deleted' | 'timeout' | 'human';

/**
 * Whether a parked wait is over: the target settled
 * (`DEPENDENCY_SETTLED_STATUSES`), was deleted, or the wait ran past
 * `maxMs`. null = keep waiting. A `failed` target keeps the wait (it is
 * retried) until the timeout.
 */
export function waitOutcome(
  wait: Pick<TaskWait, 'since'>,
  target: Pick<Task, 'status'> | null,
  nowMs: number,
  maxMs = WAIT_MAX_MS,
): WaitOutcome | null {
  if (!target) return 'deleted';
  if (DEPENDENCY_SETTLED_STATUSES.includes(target.status)) return target.status as 'published' | 'done' | 'cancelled';
  const since = Date.parse(wait.since);
  if (Number.isFinite(since) && nowMs - since >= maxMs) return 'timeout';
  return null;
}

export interface WaitTurnInput {
  wait: TaskWait;
  /** the waited-for task, re-read (null = deleted) */
  target: Pick<Task, 'id' | 'title' | 'status' | 'resultSummary' | 'workdir' | 'branch'> | null;
  outcome: WaitOutcome;
  /** the waiter works in its own worktree (docs/parallel.md) */
  waiterInWorktree: boolean;
  /** both tasks are in one repo */
  sameRepo: boolean;
  /** the target's repo name, when it is another repo */
  targetRepoName: string | null;
  /** the waiter's base ref, e.g. `origin/main`; null = unknown */
  baseRef: string | null;
  maxMs?: number;
}

/** The follow-up typed into the waiter's own session when its wait ends. */
export function waitTurnMessage(i: WaitTurnInput): string {
  const { wait, target } = i;
  const base = i.baseRef ?? 'origin/<default branch>';
  const name = `"${target?.title ?? wait.title}" (task ${wait.taskId})`;
  const lines = [`## Your wait is over`, ``, `You were waiting for ${name}${wait.reason ? ` — ${wait.reason}` : ''}.`];
  const summary = target?.resultSummary?.trim()
    ? [``, `What it did (its agent's summary):`, target.resultSummary.trim().slice(0, 3000)]
    : [];
  const trailer = `git log ${i.waiterInWorktree ? base : 'HEAD'} --oneline --grep 'Task: ${wait.taskId}'`;
  const bringIn = (): string[] => {
    if (!i.sameRepo) {
      return [`It is in another repo${i.targetRepoName ? ` (${i.targetRepoName})` : ''}: there is nothing to merge here — read what you need from that repo and build against it.`];
    }
    if (i.waiterInWorktree) {
      return [
        `Bring its change into your branch before you go on: commit your own work in progress first (with your Task trailer), then`,
        `\`git fetch origin && git rebase ${base}\`. Resolve any conflict keeping both changes, re-run what verifies your work, and do not push.`,
        `If \`git fetch origin && ${trailer}\` shows nothing, its change is not on ${base} yet — do NOT merge its branch${target?.branch ? ` (${target.branch})` : ''} into yours (it would land twice); proceed without it if you can, else ask the human with AskUserQuestion.`,
      ];
    }
    return [
      `Its commits should already be in this checkout — confirm with \`${trailer}\` and re-read the files it touched before you edit them.`,
      `If they are missing, its change has not reached this checkout: proceed without it if you can, else ask the human with AskUserQuestion.`,
    ];
  };
  switch (i.outcome) {
    case 'published':
    case 'done':
      lines.push(`It has ${i.outcome === 'published' ? 'landed (published)' : 'finished (done)'}.`, ...summary, ``, ...bringIn());
      break;
    case 'cancelled':
    case 'deleted':
      lines.push(
        `It was ${i.outcome} — its change will not come.`,
        `Do the part you need yourself only if it is within your own task's scope; otherwise say what is missing and ask the human with AskUserQuestion.`,
      );
      break;
    case 'timeout':
      lines.push(
        `It is still ${target?.status ?? 'unfinished'} after ${Math.round((i.maxMs ?? WAIT_MAX_MS) / 3_600_000)} hours.`,
        `Proceed without it if you can, wait again (POST /api/agent/wait), or ask the human with AskUserQuestion.`,
      );
      break;
    case 'human':
      lines.push(`The human ended your wait; that task is ${target?.status ?? 'deleted'} now.`);
      if (target && (target.status === 'done' || target.status === 'published')) lines.push(...summary, ``, ...bringIn());
      else lines.push(`Proceed without it if you can, or ask the human with AskUserQuestion.`);
      break;
  }
  lines.push(``, `Then carry on with your task.`);
  return lines.join('\n');
}

// ---- Declared dependencies (docs/task-waits.md § Declared dependencies) ----

/** statuses whose dependencies may still be edited: they apply before a task starts */
export const DEPENDS_ON_EDITABLE: readonly TaskStatus[] = ['draft', 'queued'];

/** dependencies per task — a plan's same-phase edges are a handful */
export const DEPENDS_ON_MAX = 12;

/**
 * id → task for the cycle test: every task that can still carry an edge.
 * `pending` (waiter task id → target id, `Orchestrator.pendingWaitEdges`)
 * overlays the wait requests not yet parked, so two tasks asking to wait on
 * each other before either Stop are a cycle too (review round 1). Read the
 * overlay AFTER this await and act on the answer without awaiting again.
 */
export async function edgeIndex(storage: Storage, pending?: () => ReadonlyMap<string, string>): Promise<Map<string, Task>> {
  const all = await storage.listTasks();
  const byId = new Map(all.map((t) => [t.id, t]));
  for (const [waiter, on] of pending?.() ?? []) {
    const t = byId.get(waiter);
    if (t && !t.waitFor) byId.set(waiter, { ...t, waitFor: { taskId: on, title: '', since: '', reason: null, runId: '' } });
  }
  return byId;
}

/**
 * Why `dependsOn` may not become `taskId`'s dependencies, or null. Each id
 * must be an existing task other than `taskId`, and none may (transitively)
 * depend on or wait for `taskId`.
 */
export function dependsOnRefusal(taskId: string | null, dependsOn: string[], byId: Map<string, Task>): string | null {
  for (const id of dependsOn) {
    if (id === taskId) return 'a task cannot depend on itself';
    if (!byId.has(id)) return `no task ${id} — use exact task ids`;
  }
  if (taskId && dependencyCycle(taskId, dependsOn, byId)) return 'that would be a cycle: one of those tasks already depends on (or waits for) this one';
  return null;
}

/**
 * The block a FRESH worker prompt of a task with declared dependencies gets
 * (docs/task-waits.md § Declared dependencies): what landed before it, so the
 * agent builds on it instead of re-doing it. null = no dependencies.
 */
export function dependenciesNote(deps: Pick<Task, 'id' | 'title' | 'status' | 'resultSummary'>[], missing: number): string | null {
  if (!deps.length && !missing) return null;
  const lines = [`## Tasks this one depends on`, ``, `This task was declared to start only after these settled:`];
  for (const d of deps) {
    const summary = d.resultSummary?.trim() ? ` — ${d.resultSummary.trim().replace(/\s+/g, ' ').slice(0, 600)}` : '';
    lines.push(`- "${d.title}" (task ${d.id}, ${d.status})${summary}`);
  }
  if (missing) lines.push(`- ${missing} task(s) since deleted`);
  lines.push(
    ``,
    `A done/published one's change is your starting point (its commits carry \`Task: <its id>\`) — build on it, do not redo it.`,
    `A cancelled one's change will not come: do what you need only if it is in your task's scope, else ask the human with AskUserQuestion.`,
  );
  return lines.join('\n');
}
