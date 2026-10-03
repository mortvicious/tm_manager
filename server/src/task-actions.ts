import { GROUP_COLOR_COUNT, TASK_MOVE_PLACES, type EffortLevel, type TaskMovePlace, type Task, type TaskStatus } from '@tm/shared';
import type { ActionResult, OrchestratorApi } from './app-types.ts';
import { broadcast } from './events.ts';
import type { MoveAnchor } from './storage/group.ts';
import type { NewTask, Storage } from './storage/types.ts';

// The task lifecycle moves, once. Every one of these used to live inline in
// routes/tasks.ts with `actor: 'human'` welded in; the Telegram bot needs the
// same moves with `actor: 'telegram'`, and docs/telegram.md is explicit that a
// second implementation is how the phone and the browser start disagreeing.
// So the logic moved here and BOTH call it — the route passing 'human', the
// bot's action layer passing 'telegram'.
//
// The return shape is the orchestrator's `ActionResult` (`{ task }` or
// `{ error, code }`), so a route can `reply.code(r.code)` and the bot can turn
// the same value into a chat line without either one inventing its own errors.

export interface TaskActionDeps {
  storage: Storage;
  /** Optional exactly as `app.orchestrator` is: boot registers routes first. */
  orchestrator?: OrchestratorApi;
}

/**
 * `blocked` is deliberately NOT enqueueable: split parents leave blocked only
 * via child resolution or the explicit unblock action (design MAJOR-2).
 */
export const ENQUEUE_FROM: TaskStatus[] = ['draft', 'failed', 'cancelled', 'review'];
/** What /retry accepts — the same move from the two failure statuses. */
export const RETRY_FROM: TaskStatus[] = ['failed', 'cancelled'];

const err = (code: number, error: string): ActionResult => ({ code, error });

/** Fields a human (or the bot) may edit on a task — status stays machine-owned. */
export interface TaskEdit {
  title?: string;
  description?: string | null;
  repoId?: string | null;
  parentId?: string | null;
  priority?: number;
  source?: 'manual' | 'sentry' | 'auto';
  sourceRef?: string | null;
  model?: string | null;
  effort?: EffortLevel | null;
  category?: string | null;
  review?: boolean | null;
  reviewModel?: string | null;
  reviewEffort?: EffortLevel | null;
  autoPublish?: boolean;
  groupName?: string | null;
  groupColor?: number | null;
}

/** POST /api/tasks — create + broadcast. */
export async function createTask(deps: TaskActionDeps, input: NewTask, actor: string): Promise<Task> {
  const task = await deps.storage.createTask(input, actor);
  broadcast({ type: 'task.updated', task });
  return task;
}

/**
 * PATCH /api/tasks/:id — the content edit, with the group-identity and
 * re-parenting guards the route has always applied. A move re-groups the whole
 * subtree, so those rows are broadcast too.
 */
export async function editTask(
  deps: TaskActionDeps,
  id: string,
  patch: TaskEdit,
  actor: string,
): Promise<ActionResult> {
  const { storage } = deps;
  if (patch.parentId === id) return err(400, 'a task cannot be its own parent');
  if (patch.groupColor != null && (patch.groupColor < 1 || patch.groupColor > GROUP_COLOR_COUNT)) {
    return err(400, `groupColor must be 1..${GROUP_COLOR_COUNT}`);
  }
  const cur = await storage.getTask(id);
  if (!cur) return err(404, 'task not found');
  // Naming/colouring is a property of the GROUP, so it is only accepted on the
  // group's root — otherwise two members could claim different names.
  const namesGroup = patch.groupName !== undefined || patch.groupColor !== undefined;
  const parentAfter = patch.parentId === undefined ? cur.parentId : (patch.parentId ?? null);
  if (namesGroup && parentAfter) {
    return err(400, 'only the root task of a group can be named or coloured — patch the root instead');
  }
  const moving = patch.parentId !== undefined && (patch.parentId ?? null) !== cur.parentId;
  if (moving) {
    const refused = await reparentRefusal(storage, cur, patch.parentId ?? null);
    if (refused) return refused;
  }
  const task = await storage.updateTask(id, patch);
  if (!task) return err(404, 'task not found');
  await storage.appendEvent({
    kind: 'task.edited',
    actor,
    taskId: id,
    repoId: task.repoId,
    data: { fields: Object.keys(patch), ...(moving ? { groupId: task.groupId } : {}) },
  });
  broadcast({ type: 'task.updated', task });
  if (moving) {
    for (const t of await storage.listTasks({ groupId: task.groupId })) {
      if (t.id !== task.id) broadcast({ type: 'task.updated', task: t });
    }
  }
  return { task };
}

/**
 * Why `task` may not take `parentId` as its new parent, or null when it may.
 * Shared by the PATCH and the move so the two cannot disagree.
 */
async function reparentRefusal(storage: Storage, task: Task, parentId: string | null): Promise<ActionResult | null> {
  if (parentId === task.id) return err(400, 'a task cannot be its own parent');
  if (parentId) {
    const parent = await storage.getTask(parentId);
    if (!parent) return err(400, 'parent task not found');
    if (parent.groupPath.split('/').includes(task.id)) {
      return err(400, 'a task cannot be moved under its own descendant');
    }
  }
  // A blocked split parent resolves when its LAST child lands — pulling a child
  // out from under it could leave it waiting on nothing forever.
  if (task.parentId) {
    const from = await storage.getTask(task.parentId);
    if (from?.status === 'blocked') {
      return err(409, 'its parent is blocked waiting on its split children — unblock the parent first');
    }
  }
  return null;
}

/** Where a dropped task goes, relative to `targetId` (docs/grouping.md § Drag and drop). */
export type MovePlace = TaskMovePlace;
export const MOVE_PLACES = TASK_MOVE_PLACES;

/**
 * POST /api/tasks/:id/move — one drop on the board:
 * - `before`/`after`: a sibling of the target, next to it (the target's parent
 *   becomes this task's parent, so dropping beside a group member joins it)
 * - `into`: join the target's group FLAT — right after the target when it has
 *   a parent, otherwise as the target's last child (a lone task starts a group)
 * - `child`: the target's last child, at any depth (the task panel's picker)
 * - `group`: last child of the target's group root ("append to group")
 * - `ungroup`: become a root, keeping its key
 * The subtree always moves with the task. Every changed row is broadcast.
 */
export async function moveTask(
  deps: TaskActionDeps,
  id: string,
  input: { place: MovePlace; targetId?: string | null },
  actor: string,
): Promise<ActionResult> {
  const { storage } = deps;
  const cur = await storage.getTask(id);
  if (!cur) return err(404, 'task not found');
  let parentId: string | null = null;
  let anchor: MoveAnchor = 'keep';
  // already a root: nothing to write, and nothing worth an audit row
  if (input.place === 'ungroup' && !cur.parentId) return { task: cur };
  if (input.place !== 'ungroup') {
    if (!input.targetId) return err(400, `targetId is required for place "${input.place}"`);
    if (input.targetId === id) return err(400, 'a task cannot be dropped onto itself');
    const target = await storage.getTask(input.targetId);
    if (!target) return err(400, 'target task not found');
    if (input.place === 'before' || input.place === 'after') {
      parentId = target.parentId;
      anchor = { id: target.id, side: input.place };
    } else if (input.place === 'into') {
      parentId = target.parentId ?? target.id;
      anchor = target.parentId ? { id: target.id, side: 'after' } : 'end';
    } else if (input.place === 'child') {
      parentId = target.id;
      anchor = 'end';
    } else {
      parentId = target.groupId;
      anchor = 'end';
    }
  }
  if (parentId !== cur.parentId) {
    const refused = await reparentRefusal(storage, cur, parentId);
    if (refused) return refused;
  }
  let rows: Task[] | null;
  try {
    rows = await storage.moveTask(id, parentId, anchor, actor);
  } catch (e) {
    // The driver re-checks inside its transaction; a row that changed between
    // the checks above and the write lands here instead of as a 500.
    return err(409, e instanceof Error ? e.message : String(e));
  }
  if (!rows) return err(404, 'task not found');
  const task = rows.find((t) => t.id === id);
  if (!task) return err(404, 'task not found');
  broadcast({ type: 'task.updated', task });
  for (const t of rows) if (t.id !== id) broadcast({ type: 'task.updated', task: t });
  return { task };
}

/**
 * The global queue: draft/failed/cancelled/review → queued. `from` narrows it
 * for /retry, which accepts only the two failure statuses.
 */
export async function enqueueTask(
  deps: TaskActionDeps,
  id: string,
  from: TaskStatus[],
  actor: string,
): Promise<ActionResult> {
  const { storage } = deps;
  const cur = await storage.getTask(id);
  if (!cur) return err(404, 'task not found');
  if (!cur.repoId) return err(409, 'assign a repo before running this task');
  // Enqueue-from-review while the previous session is alive would make the
  // claim loop double-spawn into the repo (review R3b).
  if (await deps.orchestrator?.hasLiveSession(id)) {
    return err(409, 'previous session is still live — open its terminal or kill it first');
  }
  // Enqueue/retry mean the GLOBAL queue: leaving the custom queue is part of
  // the transition, cleared FIRST so the custom pump cannot claim the row in
  // between (a stale timestamp would also put a retried task at the head).
  // Only once the status is known to be accepted, though — a refused call must
  // not quietly move a waiting member into the global queue (review R3).
  // A task held by Undo start is already `queued`: Enqueue releases it into
  // the GLOBAL queue (dropping any custom mark, as enqueue always does).
  if (cur.status === 'queued' && cur.queueHeldAt) {
    return releaseTask(deps, id, actor, { toGlobal: true });
  }
  if (!from.includes(cur.status)) return err(409, `cannot enqueue from status '${cur.status}'`);
  if (cur.customQueueAt && !(await storage.updateTask(id, { customQueueAt: null }))) {
    return err(404, 'task not found');
  }
  const task = await storage.transitionTask(id, from, 'queued', actor, { error: null });
  if (!task) {
    // Lost a race with a status change since the check above: put the mark back
    // (a member that is now e.g. running keeps its slot semantics).
    if (cur.customQueueAt) {
      const restored = await storage.updateTask(id, { customQueueAt: cur.customQueueAt });
      if (restored) broadcast({ type: 'task.updated', task: restored });
    }
    return err(409, `cannot enqueue from status '${cur.status}'`);
  }
  broadcast({ type: 'task.updated', task });
  deps.orchestrator?.maybeSchedule();
  return { task };
}

/**
 * Custom queue (docs/queue.md): "Add to queue" — independent of the global
 * orchestrator switch, strictly one task at a time, FIFO by this click. A task
 * already `queued` for the global queue simply moves over; anything else takes
 * the same enqueue transition (and the same guards).
 */
export async function queueAddTask(deps: TaskActionDeps, id: string, actor: string): Promise<ActionResult> {
  const { storage } = deps;
  const cur = await storage.getTask(id);
  if (!cur) return err(404, 'task not found');
  if (!cur.repoId) return err(409, 'assign a repo before queueing this task');
  // Held by Undo start: a member goes back to waiting in its OLD place.
  if (cur.status === 'queued' && cur.customQueueAt && cur.queueHeldAt) return releaseTask(deps, id, actor);
  if (cur.status === 'queued' && cur.customQueueAt) return err(409, 'already in the queue');
  if (cur.status !== 'queued' && !ENQUEUE_FROM.includes(cur.status)) {
    return err(409, `cannot add to the queue from status '${cur.status}'`);
  }
  if (await deps.orchestrator?.hasLiveSession(id)) {
    return err(409, 'previous session is still live — open its terminal or kill it first');
  }
  // Membership FIRST, then the status transition: a row that is `queued`
  // without the mark belongs to the global claim loop, which must never see
  // this one even for an instant.
  // A held global-queue task moving over is released by the move (the click
  // is the human saying "run it", at the back of the custom queue).
  const marked = await storage.updateTask(id, { customQueueAt: new Date().toISOString(), queueHeldAt: null });
  if (!marked) return err(404, 'task not found');
  let task = marked;
  if (cur.status !== 'queued') {
    const moved = await storage.transitionTask(id, ENQUEUE_FROM, 'queued', actor, { error: null });
    if (!moved) {
      await storage.updateTask(id, { customQueueAt: null });
      return err(409, `cannot add to the queue from status '${cur.status}'`);
    }
    task = moved;
  }
  await storage.appendEvent({
    kind: 'task.queue',
    actor,
    taskId: id,
    repoId: task.repoId,
    data: { queue: 'custom', action: 'add' },
  });
  broadcast({ type: 'task.updated', task });
  deps.orchestrator?.maybeSchedule();
  return { task };
}

/**
 * "Remove from queue": a waiting member is cancelled exactly like a global
 * queue removal; a member that already ran just drops its mark.
 */
export async function queueRemoveTask(deps: TaskActionDeps, id: string, actor: string): Promise<ActionResult> {
  const { storage } = deps;
  const cur = await storage.getTask(id);
  if (!cur) return err(404, 'task not found');
  if (!cur.customQueueAt) return err(409, 'task is not in the queue');
  let task = await storage.updateTask(id, { customQueueAt: null });
  if (!task) return err(404, 'task not found');
  if (task.status === 'queued') {
    const dequeued = await storage.transitionTask(id, ['queued'], 'cancelled', actor);
    if (dequeued) {
      task = dequeued;
      // No actor: the cascade this kicks off (a split parent unblocking, a
      // feature phase advancing) is the machine reacting, not the person who
      // pressed the button. `resolveCompletion` defaults to 'system' and the
      // audit trail should keep saying so on every surface — see the note on
      // completeTask below.
      await deps.orchestrator?.resolveCompletion(dequeued);
    }
  }
  await storage.appendEvent({
    kind: 'task.queue',
    actor,
    taskId: id,
    repoId: task.repoId,
    data: { queue: 'custom', action: 'remove' },
  });
  broadcast({ type: 'task.updated', task });
  // A running member keeps running; the queue itself may move on.
  deps.orchestrator?.maybeSchedule();
  return { task };
}

/**
 * "Review now" (docs/design.md § Adversarial review): run the adversarial
 * reviewer over the task's current diff on demand. Returns at once with the
 * row marked `pending`; the verdict lands on the row (and over /ws/events)
 * minutes later. Status is never changed here — findings go back to a live
 * worker only for a task in `review`, exactly as the automatic round does.
 */
export async function reviewTask(deps: TaskActionDeps, id: string, actor: string): Promise<ActionResult> {
  if (!deps.orchestrator) return err(503, 'orchestrator not ready');
  return deps.orchestrator.reviewNow(id, actor);
}

/** blocked → review: the explicit "the subtasks are dealt with" move. */
export async function unblockTask(deps: TaskActionDeps, id: string, actor: string): Promise<ActionResult> {
  const task = await deps.storage.transitionTask(id, ['blocked'], 'review', actor, { error: null });
  if (!task) return err(409, 'task is not blocked');
  broadcast({ type: 'task.updated', task });
  return { task };
}

/**
 * review → done: the only sanctioned human "complete" transition (R13).
 * Completing also closes the task's idle terminal — done means done.
 */
export async function completeTask(deps: TaskActionDeps, id: string, actor: string): Promise<ActionResult> {
  const task = await deps.storage.transitionTask(id, ['review'], 'done', actor);
  if (!task) return err(409, 'task is not in review');
  broadcast({ type: 'task.updated', task });
  await deps.orchestrator?.closeTaskSessions(id, actor);
  // A done child may unblock a split parent (and settle a feature phase).
  //
  // Deliberately WITHOUT an actor, which leaves `resolveCompletion`'s default
  // of 'system'. The human (or the bot) completed the CHILD; the parent's
  // blocked→review transition and the next phase's enqueue are consequences the
  // orchestrator draws on its own, and attributing an automatic cascade to
  // whoever happened to close the last child would make the audit trail read as
  // if a person had reopened the parent. This is also what the REST route did
  // before these moves came out of it — parameterising the actor must not
  // quietly re-attribute the follow-on rows.
  await deps.orchestrator?.resolveCompletion(task);
  return { task };
}

/**
 * "Undo start" (docs/queue.md § Undo start): stop a running task and put it
 * back where it was before the turn — not `cancelled`, not `failed`.
 */
export async function undoTask(deps: TaskActionDeps, id: string, actor: string): Promise<ActionResult> {
  if (!deps.orchestrator) return err(503, 'orchestrator not ready');
  return deps.orchestrator.undoStart(id, actor);
}

/**
 * Release a task held by Undo start: it stays `queued` in its old place and
 * the next claim may take it. `toGlobal` (Enqueue on a held task) also drops
 * its custom-queue mark, which is what Enqueue means everywhere else.
 */
export async function releaseTask(
  deps: TaskActionDeps,
  id: string,
  actor: string,
  opts: { toGlobal?: boolean } = {},
): Promise<ActionResult> {
  const { storage } = deps;
  const cur = await storage.getTask(id);
  if (!cur) return err(404, 'task not found');
  if (cur.status !== 'queued' || !cur.queueHeldAt) return err(409, 'task is not held');
  // The undone turn's PTY dies asynchronously; a claim racing it would find the
  // session still live and bounce the task to review (startWorker's guard).
  if (await deps.orchestrator?.hasLiveSession(id)) {
    return err(409, 'the stopped session is still shutting down — try again in a moment');
  }
  const task = await storage.updateTask(id, {
    queueHeldAt: null,
    ...(opts.toGlobal ? { customQueueAt: null } : {}),
  });
  if (!task) return err(404, 'task not found');
  await storage.appendEvent({
    kind: 'task.undo',
    actor,
    taskId: id,
    repoId: task.repoId,
    data: { action: 'release', queue: task.customQueueAt ? 'custom' : 'global' },
  });
  broadcast({ type: 'task.updated', task });
  deps.orchestrator?.maybeSchedule();
  return { task };
}

/**
 * Cancel: queued tasks can be de-queued without the orchestrator (R12);
 * anything running goes through it so the PTY dies with the row.
 */
export async function cancelTask(deps: TaskActionDeps, id: string, actor: string): Promise<ActionResult> {
  const dequeued = await deps.storage.transitionTask(id, ['queued'], 'cancelled', actor);
  if (dequeued) {
    broadcast({ type: 'task.updated', task: dequeued });
    // cancelled child resolves its parent (F2) — as 'system', see completeTask
    await deps.orchestrator?.resolveCompletion(dequeued);
    return { task: dequeued };
  }
  if (!deps.orchestrator) return err(503, 'orchestrator not ready');
  return deps.orchestrator.cancel(id, actor);
}
