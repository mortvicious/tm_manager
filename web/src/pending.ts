import { useSyncExternalStore } from 'react';
import type { OrchestratorStatus, Run, Task } from '@tm/shared';
import { toastDone } from './toast.ts';

/**
 * Action feedback (docs/mobile.md § Action feedback): a task action pressed on
 * any surface — panel bar, ⋯ sheet, desktop row, board row, Inbox — is IN
 * FLIGHT from the press until its POST answers, and that window can be long (a
 * worktree land rebases, re-runs the checks and pushes inside the request; a
 * publish turn first waits for the idle session to exit). Before this nothing
 * changed on screen until the WS row arrived, so a press read as a press that
 * did nothing.
 *
 * A module store, not component state, for the same reason as the toasts: the
 * phone ⋯ sheet closes on the press and the board row re-renders from a new
 * list, so the component that started the call is often not the one that
 * should show it — every surface reads the same entry by task id. One entry
 * per task: a second press on the same task while one is in flight is dropped
 * (`runTaskAction` returns undefined), which is also the double-tap guard.
 */

/** Every task action a surface can press — `api.taskAction`'s set plus the ones with their own route. */
export type TaskActionId =
  | 'enqueue'
  | 'run-now'
  | 'cancel'
  | 'undo'
  | 'stop-waiting'
  | 'release'
  | 'retry'
  | 'unblock'
  | 'complete'
  | 'publish'
  | 'mark-published'
  | 'queue'
  | 'unqueue'
  | 'hide'
  | 'unhide'
  | 'review'
  | 'apply-review'
  | 'stop-agent'
  | 'proceed'
  | 'keep'
  | 'continue-loop';

export interface PendingAction {
  action: TaskActionId;
  /** the button's label while in flight ("Publishing…") */
  verb: string;
  since: number;
}

/** In-flight wording: what the pressed button says until the server answers. */
export const ACTION_VERB: Record<TaskActionId, string> = {
  enqueue: 'Queuing…',
  'run-now': 'Starting…',
  cancel: 'Cancelling…',
  undo: 'Undoing…',
  'stop-waiting': 'Landing…',
  release: 'Releasing…',
  retry: 'Retrying…',
  unblock: 'Unblocking…',
  complete: 'Closing…',
  publish: 'Publishing…',
  'mark-published': 'Marking…',
  queue: 'Adding…',
  unqueue: 'Cancelling…',
  hide: 'Hiding…',
  unhide: 'Unhiding…',
  review: 'Starting review…',
  'apply-review': 'Sending…',
  'stop-agent': 'Stopping…',
  proceed: 'Resuming…',
  keep: 'Keeping…',
  'continue-loop': 'Continuing…',
};

/** The toast's "<what> failed:" title when the server refuses it. */
export const ACTION_TITLE: Record<TaskActionId, string> = {
  enqueue: 'Enqueue',
  'run-now': 'Run now',
  cancel: 'Cancel',
  undo: 'Undo start',
  'stop-waiting': 'Stop waiting',
  release: 'Release',
  retry: 'Retry',
  unblock: 'Unblock',
  complete: 'Mark done',
  publish: 'Publish',
  'mark-published': 'Mark published',
  queue: 'Add to queue',
  unqueue: 'Cancel task',
  hide: 'Hide',
  unhide: 'Unhide',
  review: 'Review now',
  'apply-review': 'Apply review fixes',
  'stop-agent': 'Stop agent',
  proceed: 'Proceed',
  keep: 'Keep',
  'continue-loop': 'Continue loop',
};

function clip(s: string, n = 48): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function isTask(x: unknown): x is Task {
  return !!x && typeof x === 'object' && typeof (x as Task).id === 'string' && typeof (x as Task).status === 'string';
}

/**
 * What the success toast says, read off the row the server answered with
 * where there is one — a publish that settled at once (observed, direct, a
 * worktree land) reads "published", one that started the agent's publish turn
 * reads "publishing". Pure, so it can be checked from node.
 */
export function actionOutcome(action: TaskActionId, title: string, result: unknown): string {
  const t = isTask(result) ? result : null;
  const name = `“${clip(title)}”`;
  switch (action) {
    case 'publish':
      if (t?.status === 'published') return `Published ${name}`;
      if (t?.status === 'running') return `Publishing ${name} — the agent commits and pushes in its own terminal`;
      return `Publish of ${name} started`;
    case 'mark-published':
      return `Marked ${name} published`;
    case 'enqueue':
      return `Queued ${name}`;
    case 'retry':
      return `Queued ${name} for a fresh attempt`;
    case 'run-now':
      return t?.status === 'running' ? `Started ${name}` : `Starting ${name}`;
    case 'queue':
      return `Added ${name} to the queue`;
    case 'unqueue':
    case 'cancel':
      return `Cancelled ${name}`;
    case 'undo':
      return t ? `Start of ${name} undone — back to ${t.status}` : `Start of ${name} undone`;
    case 'release':
      return `Released ${name} — the queue may take it again`;
    case 'stop-waiting':
      return `Landed ${name} — its shells were stopped`;
    case 'complete':
      return `Marked ${name} done`;
    case 'unblock':
      return `Unblocked ${name}`;
    case 'hide':
      return `Hid ${name}`;
    case 'unhide':
      return `Unhid ${name}`;
    case 'review':
      return `Review of ${name} started`;
    case 'apply-review':
      return `Review fixes sent for ${name}`;
    case 'stop-agent':
      return `Stopped the agent of ${name}`;
    case 'proceed':
      return `Resumed ${name}`;
    case 'keep':
      return `Kept ${name} off the stale list`;
    case 'continue-loop':
      return `Loop ${name} continues`;
  }
}

/**
 * The synthetic `publishing` badge (StatusBadge `busy`): the human's own
 * publish press still in flight on this tab, a worktree land the server is
 * running (`OrchestratorStatus.landing` — every tab and the phone see it), or
 * the task's agent publish turn working (a live, non-idle worker run labelled
 * `publish`). Null for anything else.
 */
export function publishBusy(
  task: Pick<Task, 'id' | 'status'>,
  runs: readonly Pick<Run, 'taskId' | 'mode' | 'status' | 'label' | 'idle'>[],
  orch: Pick<OrchestratorStatus, 'landing'> | null,
  pending: PendingAction | null | undefined,
): 'publishing' | 'landing' | null {
  if (orch?.landing?.includes(task.id)) return 'landing';
  if (pending?.action === 'publish') return 'publishing';
  if (task.status !== 'running') return null;
  const turn = runs.some((r) => r.taskId === task.id && r.mode !== 'aux' && r.status === 'running' && r.label === 'publish' && !r.idle);
  return turn ? 'publishing' : null;
}

// ---- the store ----

let pending: ReadonlyMap<string, PendingAction> = new Map();
const listeners = new Set<() => void>();

function set(next: Map<string, PendingAction>) {
  pending = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function pendingFor(taskId: string): PendingAction | null {
  return pending.get(taskId) ?? null;
}

/** Every in-flight action, by task id (the board reads many rows at once). */
export function usePendingActions(): ReadonlyMap<string, PendingAction> {
  return useSyncExternalStore(subscribe, () => pending);
}

export function usePendingAction(taskId: string | null | undefined): PendingAction | null {
  const all = usePendingActions();
  return taskId ? (all.get(taskId) ?? null) : null;
}

/**
 * Run one task action with feedback: marks the task in flight, awaits `call`,
 * toasts the outcome, clears the mark. A refusal is re-thrown untouched, so the
 * caller's own `catch` → `toastError` stays where it was. Returns undefined
 * without calling when the task already has an action in flight.
 */
export async function runTaskAction<T>(
  task: Pick<Task, 'id' | 'title'>,
  action: TaskActionId,
  call: () => Promise<T>,
  opts: { quiet?: boolean } = {},
): Promise<T | undefined> {
  if (pending.has(task.id)) return undefined;
  set(new Map(pending).set(task.id, { action, verb: ACTION_VERB[action], since: Date.now() }));
  try {
    const result = await call();
    if (!opts.quiet) toastDone(`task:${task.id}`, actionOutcome(action, task.title, result));
    return result;
  } finally {
    const next = new Map(pending);
    next.delete(task.id);
    set(next);
  }
}
