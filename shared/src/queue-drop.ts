import { customQueueWaiting, groupLabel, type Task } from './types.ts';

/**
 * Dragging a predicted point on the timeline (docs/timeline.md § Drag the
 * future): which REAL mutation a drop of `moving` before/after `target` maps
 * to, the optimistic patch that makes the prediction show it at once, and the
 * refusal when no mutation means "this one runs first".
 *
 * - Both in the custom queue → `POST /api/tasks/:id/queue-move` beside the
 *   target. That queue's order is its mark alone (`customQueueWaiting`), so
 *   any two waiting members can swap, whatever their repo or priority.
 * - Both in the global queue → `POST /api/tasks/:id/move` `before|after`,
 *   which RE-PARENTS onto the target's parent — so only between siblings.
 *   For a target in another group the dragged task's group ROOT moves beside
 *   the target's root (roots are siblings: no regrouping), which is what the
 *   claim order reads after priority (`compareClaimOrder`). Two tasks of one
 *   group under different parents have no such move and are refused.
 * - Refused: one in each queue (different orders; Add/Remove from queue moves
 *   a task between them), or different priorities in the global queue (the
 *   claim is priority first, so no key change can put one above the other).
 */

export type QueueDropSide = 'before' | 'after';

export type QueueDropCall =
  | { kind: 'queue-move'; id: string; place: QueueDropSide; targetId: string }
  | { kind: 'move'; id: string; place: QueueDropSide; targetId: string };

export type QueueDropPatch = Record<string, Partial<Pick<Task, 'sortOrder' | 'customQueueAt'>>>;

export type QueueDropPlan =
  | { refusal: string }
  | {
      call: QueueDropCall;
      /** task id → fields as the server is expected to write them */
      patch: QueueDropPatch;
      /** what letting go will do, in words */
      hint: string;
    };

/** a task whose predicted point can be dragged: waiting in either queue */
export function queueDropMovable(t: Task | undefined): boolean {
  return !!t && t.status === 'queued';
}

const quote = (s: string) => `“${s}”`;

export function planQueueDrop(tasks: readonly Task[], movingId: string, targetId: string, side: QueueDropSide): QueueDropPlan {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const moving = byId.get(movingId);
  const target = byId.get(targetId);
  if (!moving || !target) return { refusal: 'task not found' };
  if (moving.id === target.id) return { refusal: 'drop it beside another queued task' };
  if (!queueDropMovable(moving)) return { refusal: `only a queued task can move (it is ${moving.status})` };
  if (!queueDropMovable(target)) return { refusal: `only beside a queued task (that one is ${target.status})` };
  const where = side === 'before' ? 'above' : 'below';

  const inCustom = !!moving.customQueueAt;
  if (inCustom !== !!target.customQueueAt) {
    return {
      refusal: inCustom
        ? 'that task is in the global queue and this one in the custom queue — separate orders; Remove from queue moves it over'
        : 'that task is in the custom queue and this one in the global queue — separate orders; Add to queue moves it over',
    };
  }

  if (inCustom) {
    const marks = customQueueMarks([...tasks], moving.id, target.id, side);
    if (!marks) return { refusal: 'not waiting in the custom queue' };
    return {
      call: { kind: 'queue-move', id: moving.id, place: side, targetId: target.id },
      patch: marks,
      hint: `custom queue: run ${where} ${quote(target.title)}`,
    };
  }

  if (moving.priority !== target.priority) {
    return {
      refusal: `claim order is priority first: this is priority ${moving.priority}, that one ${target.priority} — change the priority instead`,
    };
  }
  if (moving.parentId === target.parentId) {
    return {
      call: { kind: 'move', id: moving.id, place: side, targetId: target.id },
      patch: { [moving.id]: { sortOrder: keyBeside(tasks, target, moving.id, side) } },
      hint: `run ${where} ${quote(target.title)}`,
    };
  }
  if (moving.groupId === target.groupId) {
    return {
      refusal: 'same group, different parents — a move beside it would re-parent the task; reorder it inside its group on the board',
    };
  }
  const rootA = byId.get(moving.groupId);
  const rootB = byId.get(target.groupId);
  if (!rootA || !rootB || rootA.parentId !== null || rootB.parentId !== null) return { refusal: 'group root not found' };
  const groupName = (root: Task) => quote(groupLabel(root, root.title));
  return {
    call: { kind: 'move', id: rootA.id, place: side, targetId: rootB.id },
    patch: { [rootA.id]: { sortOrder: keyBeside(tasks, rootB, rootA.id, side) } },
    hint:
      rootA.id === moving.id
        ? `run ${where} group ${groupName(rootB)}`
        : `move group ${groupName(rootA)} ${where} ${rootB.id === target.id ? quote(target.title) : `group ${groupName(rootB)}`}`,
  };
}

/**
 * The key `/move` would give `movingId` beside `target`: a midpoint with the
 * neighbour on that side among the target's siblings, else one step past the
 * target. The server's own midpoint (or a renumber) may differ; only the
 * order has to match.
 */
function keyBeside(tasks: readonly Task[], target: Task, movingId: string, side: QueueDropSide): number {
  const sibs = tasks
    .filter((t) => t.parentId === target.parentId && t.id !== movingId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
  const i = sibs.findIndex((t) => t.id === target.id);
  const next = side === 'before' ? sibs[i - 1] : sibs[i + 1];
  if (!next) return target.sortOrder + (side === 'before' ? -1 : 1);
  return (target.sortOrder + next.sortOrder) / 2;
}

/**
 * The custom queue in its new order as marks: the moved member at a
 * millisecond midpoint when its new neighbours leave room, else the waiting
 * set renumbered across its current span — the shape of the server's
 * `planQueueReorder`, which is what decides the real marks.
 */
function customQueueMarks(tasks: Task[], movingId: string, targetId: string, side: QueueDropSide): QueueDropPatch | null {
  const rows = customQueueWaiting(tasks);
  const self = rows.find((t) => t.id === movingId);
  const others = rows.filter((t) => t.id !== movingId);
  const i = others.findIndex((t) => t.id === targetId);
  if (!self || i === -1) return null;
  const at = side === 'before' ? i : i + 1;
  const lo = others[at - 1];
  const hi = others[at];
  if (lo && hi) {
    const a = Date.parse(lo.customQueueAt!);
    const b = Date.parse(hi.customQueueAt!);
    if (b - a >= 2) return { [self.id]: { customQueueAt: new Date(a + Math.floor((b - a) / 2)).toISOString() } };
  }
  const order = [...others.slice(0, at), self, ...others.slice(at)];
  const ms = rows.map((t) => Date.parse(t.customQueueAt!));
  if (ms.some((v) => Number.isNaN(v))) return null;
  const n = order.length;
  const min = ms[0];
  const span = ms[n - 1] - min;
  const start = span >= n - 1 ? min : ms[n - 1] - (n - 1);
  const width = Math.max(span, n - 1, 1);
  const patch: QueueDropPatch = {};
  order.forEach((t, k) => {
    const iso = new Date(start + Math.floor((k * width) / Math.max(1, n - 1))).toISOString();
    if (iso !== t.customQueueAt) patch[t.id] = { customQueueAt: iso };
  });
  return patch;
}
