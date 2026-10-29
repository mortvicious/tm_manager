// Timeline drag (docs/timeline.md § Drag the future): a drop beside a predicted
// point → the real queue mutation, its optimistic patch, and the refusals.
// Run: npm test (node:test through tsx).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compareClaimOrder, customQueueWaiting, planQueueDrop, type Task } from '@tm/shared';

const T0 = Date.parse('2026-10-20T10:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
let order = 0;
function task(id: string, over: Partial<Task> = {}): Task {
  order++;
  return {
    id,
    title: `Task ${id}`,
    description: null,
    repoId: 'nest',
    parentId: null,
    groupId: id,
    groupPath: '/',
    groupName: null,
    groupColor: null,
    status: 'queued',
    source: 'manual',
    sourceRef: null,
    priority: 0,
    sortOrder: order,
    model: null,
    effort: null,
    category: null,
    createdByRun: null,
    spawnDepth: 0,
    featureId: null,
    featurePhase: null,
    brief: null,
    resultSummary: null,
    review: null,
    reviewModel: null,
    reviewEffort: null,
    landing: null,
    autoLandedAt: null,
    shippedSha: null,
    shippedAt: null,
    workdir: null,
    branch: null,
    prNumber: null,
    prUrl: null,
    prState: null,
    worktreeEvictedAt: null,
    worktreeBase: null,
    customQueueAt: null,
    reviewSummary: null,
    reviewDiffHash: null,
    baseSha: null,
    baseRef: null,
    baseAt: null,
    reviewState: null,
    reviewRounds: [],
    wakeAt: null,
    queueHeldAt: null,
    pausedTurn: null,
    hiddenAt: null,
    inboxKeptUntil: null,
    costUsd: 0,
    attempts: 0,
    acceptance: null,
    checks: null,
    checkState: null,
    checkResults: [],
    checkDiffHash: null,
    kind: 'task',
    loopGoal: null,
    loopMaxIterations: null,
    loopBudgetUsd: null,
    loopIteration: 0,
    loopState: null,
    loopHistory: [],
    error: null,
    createdAt: at(-100 + order),
    updatedAt: at(-100 + order),
    ...over,
  };
}

/** the board with a plan's patch laid over it */
function patched(tasks: Task[], patch: Record<string, Partial<Task>>): Task[] {
  return tasks.map((t) => (patch[t.id] ? { ...t, ...patch[t.id] } : t));
}
function globalOrder(tasks: Task[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return tasks.filter((t) => t.status === 'queued' && !t.customQueueAt).sort(compareClaimOrder(byId)).map((t) => t.id);
}

describe('planQueueDrop', () => {
  test('global siblings → /move beside the target; the patch reorders the claim', () => {
    const tasks = [task('a'), task('b'), task('c')];
    const plan = planQueueDrop(tasks, 'c', 'a', 'before');
    assert.ok('call' in plan);
    assert.deepEqual(plan.call, { kind: 'move', id: 'c', place: 'before', targetId: 'a' });
    assert.deepEqual(globalOrder(patched(tasks, plan.patch)), ['c', 'a', 'b']);
    const after = planQueueDrop(tasks, 'a', 'b', 'after');
    assert.ok('call' in after);
    assert.deepEqual(globalOrder(patched(tasks, after.patch)), ['b', 'a', 'c']);
  });

  test('another group → the dragged task’s ROOT moves beside the target’s root (no regrouping)', () => {
    const r1 = task('r1', { status: 'done' });
    const k1 = task('k1', { parentId: 'r1', groupId: 'r1', groupPath: '/r1/' });
    const r2 = task('r2');
    const k2 = task('k2', { parentId: 'r2', groupId: 'r2', groupPath: '/r2/' });
    const tasks = [r1, k1, r2, k2];
    const plan = planQueueDrop(tasks, 'k2', 'k1', 'before');
    assert.ok('call' in plan);
    assert.deepEqual(plan.call, { kind: 'move', id: 'r2', place: 'before', targetId: 'r1' });
    assert.deepEqual(globalOrder(patched(tasks, plan.patch)), ['r2', 'k2', 'k1']);
    assert.match(plan.hint, /move group/);
  });

  test('same group under different parents is refused (before/after would re-parent)', () => {
    const r = task('r', { status: 'done' });
    const p = task('p', { parentId: 'r', groupId: 'r', status: 'done' });
    const x = task('x', { parentId: 'r', groupId: 'r' });
    const y = task('y', { parentId: 'p', groupId: 'r' });
    const plan = planQueueDrop([r, p, x, y], 'y', 'x', 'before');
    assert.ok('refusal' in plan);
    assert.match(plan.refusal, /re-parent/);
  });

  test('a priority boundary is refused with the reason', () => {
    const plan = planQueueDrop([task('a', { priority: 2 }), task('b')], 'b', 'a', 'before');
    assert.ok('refusal' in plan);
    assert.match(plan.refusal, /priority first/);
  });

  test('custom ↔ global is refused both ways', () => {
    const tasks = [task('g'), task('c', { customQueueAt: at(0) })];
    const a = planQueueDrop(tasks, 'c', 'g', 'before');
    const b = planQueueDrop(tasks, 'g', 'c', 'before');
    assert.ok('refusal' in a && 'refusal' in b);
    assert.match(a.refusal, /Remove from queue/);
    assert.match(b.refusal, /Add to queue/);
  });

  test('custom queue → queue-move, any priority; midpoint and renumber both keep the new order', () => {
    const tasks = [
      task('a', { customQueueAt: at(0), priority: 3 }),
      task('b', { customQueueAt: at(1) }),
      task('c', { customQueueAt: at(2), repoId: 'vite' }),
    ];
    const mid = planQueueDrop(tasks, 'a', 'c', 'before');
    assert.ok('call' in mid);
    assert.deepEqual(mid.call, { kind: 'queue-move', id: 'a', place: 'before', targetId: 'c' });
    assert.deepEqual(Object.keys(mid.patch), ['a']);
    assert.deepEqual(customQueueWaiting(patched(tasks, mid.patch)).map((t) => t.id), ['b', 'a', 'c']);
    // to the front: no neighbour before → renumbered across the span
    const front = planQueueDrop(tasks, 'c', 'a', 'before');
    assert.ok('call' in front);
    assert.deepEqual(customQueueWaiting(patched(tasks, front.patch)).map((t) => t.id), ['c', 'a', 'b']);
    // marks stamped in one millisecond: still distinct and ordered
    const tied = [task('x', { customQueueAt: at(5) }), task('y', { customQueueAt: at(5) }), task('z', { customQueueAt: at(5) })];
    const t = planQueueDrop(tied, 'z', 'x', 'before');
    assert.ok('call' in t);
    assert.deepEqual(customQueueWaiting(patched(tied, t.patch)).map((r) => r.id), ['z', 'x', 'y']);
  });

  test('only queued tasks move or take a drop', () => {
    const a = planQueueDrop([task('a', { status: 'running' }), task('b')], 'a', 'b', 'after');
    const b = planQueueDrop([task('a'), task('b', { status: 'review' })], 'a', 'b', 'after');
    assert.ok('refusal' in a && 'refusal' in b);
  });
});
