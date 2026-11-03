// Task waits + declared dependencies (docs/task-waits.md): the pure rules,
// then the sqlite gates end to end (claim, custom queue, split-parent
// resolution, the transition that clears a wait).
// Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { customQueueHoldsRepo, dependencyCycle, unmetDependency, type Feature, type Task, type TaskWait } from '@tm/shared';
import { planCards, planSchema, toStoredPlan } from './claude/feature-plan.ts';
import { SqliteStorage } from './storage/sqlite.ts';
import { dependenciesNote, dependsOnRefusal, edgeIndex, waitOutcome, waitRefusal, waitTargetStuck, waitTurnMessage, WAIT_MAX_MS } from './task-wait.ts';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const wait = (over: Partial<TaskWait> = {}): TaskWait => ({
  taskId: 'b',
  title: 'Orders API',
  since: new Date(NOW - 60_000).toISOString(),
  reason: 'needs POST /orders',
  runId: 'r1',
  ...over,
});
const t = (id: string, over: Partial<Task> = {}) => ({ id, title: id, status: 'queued', dependsOn: [], waitFor: null, ...over }) as Task;

describe('waitRefusal', () => {
  const caller = { id: 'a', status: 'running', kind: 'task' } as Task;
  const target = { id: 'b', status: 'running', title: 'B' } as Task;
  const ok = { publishTurn: false, cycle: false };
  test('a running task may wait for a running one', () => assert.equal(waitRefusal(caller, target, ok), null));
  test('refusals', () => {
    assert.equal(waitRefusal(caller, null, ok)?.code, 404);
    assert.equal(waitRefusal(caller, { ...target, id: 'a' }, ok)?.code, 400);
    assert.match(waitRefusal(caller, { ...target, status: 'published' }, ok)!.error, /already landed/);
    assert.match(waitRefusal(caller, { ...target, status: 'draft' }, ok)!.error, /draft/);
    assert.equal(waitRefusal(caller, { ...target, status: 'failed' }, ok)?.code, 409);
    assert.equal(waitRefusal(caller, { ...target, status: 'cancelled' }, ok)?.code, 409);
    assert.match(waitRefusal(caller, target, { ...ok, cycle: true })!.error, /deadlock/);
    assert.match(waitRefusal({ ...caller, kind: 'loop' }, target, ok)!.error, /loop/);
    assert.match(waitRefusal(caller, target, { ...ok, publishTurn: true })!.error, /publish/);
    assert.equal(waitRefusal({ ...caller, status: 'review' }, target, ok)?.code, 409);
  });
  test('every live status is waitable', () => {
    for (const status of ['queued', 'running', 'waiting', 'review', 'blocked'] as const) {
      assert.equal(waitRefusal(caller, { ...target, status }, ok), null, status);
    }
  });
});

describe('waitOutcome', () => {
  test('settled, deleted, timeout, or keep waiting', () => {
    assert.equal(waitOutcome(wait(), { status: 'running' }, NOW), null);
    assert.equal(waitOutcome(wait(), { status: 'failed' }, NOW), null, 'a failed task is retried — keep waiting');
    assert.equal(waitOutcome(wait(), { status: 'review' }, NOW), null);
    assert.equal(waitOutcome(wait(), { status: 'published' }, NOW), 'published');
    assert.equal(waitOutcome(wait(), { status: 'done' }, NOW), 'done');
    assert.equal(waitOutcome(wait(), { status: 'cancelled' }, NOW), 'cancelled');
    assert.equal(waitOutcome(wait(), null, NOW), 'deleted');
    assert.equal(waitOutcome(wait({ since: new Date(NOW - WAIT_MAX_MS).toISOString() }), { status: 'running' }, NOW), 'timeout');
  });
});

describe('waitTurnMessage', () => {
  const base = {
    wait: wait(),
    target: { id: 'b', title: 'Orders API', status: 'published', resultSummary: 'Added POST /orders', workdir: '/x', branch: 'tm/bbbbbbbb' } as Task,
    outcome: 'published' as const,
    sameRepo: true,
    targetRepoName: null,
    baseRef: 'origin/staging',
  };
  test('worktree waiter: fetch + rebase onto the base, never merge the branch', () => {
    const m = waitTurnMessage({ ...base, waiterInWorktree: true });
    assert.match(m, /git fetch origin && git rebase origin\/staging/);
    assert.match(m, /Added POST \/orders/);
    assert.match(m, /do NOT merge its branch \(tm\/bbbbbbbb\)/);
    assert.match(m, /do not push/);
  });
  test('checkout waiter: its commits are already here', () => {
    const m = waitTurnMessage({ ...base, waiterInWorktree: false });
    assert.match(m, /already be in this checkout/);
    assert.doesNotMatch(m, /git rebase/);
  });
  test('another repo: nothing to merge', () => {
    assert.match(waitTurnMessage({ ...base, waiterInWorktree: true, sameRepo: false, targetRepoName: 'nest' }), /another repo \(nest\)/);
  });
  test('cancelled / timeout / human', () => {
    assert.match(waitTurnMessage({ ...base, waiterInWorktree: true, outcome: 'cancelled' }), /will not come/);
    assert.match(waitTurnMessage({ ...base, waiterInWorktree: true, outcome: 'timeout', target: { ...base.target, status: 'running' } }), /still running after 24 hours/);
    assert.match(waitTurnMessage({ ...base, waiterInWorktree: true, outcome: 'human', target: { ...base.target, status: 'running' } }), /human ended your wait/);
  });
});

describe('waitTargetStuck (review round 1)', () => {
  const caller = { featureId: 'f', featurePhase: 1 } as Task;
  const q = (over: Partial<Task> = {}) => t('b', { title: 'B', featureId: null, featurePhase: null, queueHeldAt: null, customQueueAt: null, ...over });
  const on = { queueEnabled: true, targetFeatureStatus: 'running' };
  test('a claimable queued task, or one not queued, is fine', () => {
    assert.equal(waitTargetStuck(caller, q(), on), null);
    assert.equal(waitTargetStuck(caller, q({ status: 'running' as const, queueHeldAt: 'x' }), on), null);
    assert.equal(waitTargetStuck(caller, q({ featureId: 'f', featurePhase: 1 }), on), null, 'same phase runs beside it');
    assert.equal(waitTargetStuck(caller, q({ featureId: 'g', featurePhase: 3 }), on), null, 'another feature');
  });
  test('a later phase of the caller’s own feature waits for the caller', () => {
    assert.match(waitTargetStuck(caller, q({ featureId: 'f', featurePhase: 2 }), on)!, /later phase/);
    const r = waitRefusal({ id: 'a', status: 'running', kind: 'task' } as Task, q(), { publishTurn: false, cycle: false, stuck: 'x' });
    assert.equal(r?.code, 409);
    assert.match(r!.error, /yourself/);
  });
  test('held by Undo start, a feature not running, the stopped global queue', () => {
    assert.match(waitTargetStuck(caller, q({ queueHeldAt: 'x' }), on)!, /held/);
    assert.match(waitTargetStuck(caller, q({ featureId: 'g', featurePhase: 1 }), { ...on, targetFeatureStatus: 'paused' })!, /paused/);
    assert.match(waitTargetStuck(caller, q(), { ...on, queueEnabled: false })!, /stopped/);
    assert.equal(waitTargetStuck(caller, q({ customQueueAt: 'x' }), { ...on, queueEnabled: false }), null, 'the custom queue runs regardless');
  });
});

describe('dependencies (pure)', () => {
  test('unmetDependency: settled and deleted dependencies are met', () => {
    const byId = new Map([t('a', { status: 'running' }), t('b', { status: 'done' }), t('c', { status: 'cancelled' })].map((x) => [x.id, x]));
    assert.equal(unmetDependency(t('x', { dependsOn: ['b', 'c', 'gone'] }), byId), null);
    assert.equal(unmetDependency(t('x', { dependsOn: ['b', 'a'] }), byId)?.id, 'a');
    assert.equal(unmetDependency(t('x', { dependsOn: ['f'] }), new Map([['f', t('f', { status: 'failed' })]]))?.id, 'f');
  });
  test('dependencyCycle follows dependsOn and waitFor', () => {
    const byId = new Map(
      [t('a', { dependsOn: ['b'] }), t('b', { status: 'blocked', waitFor: wait({ taskId: 'c' }) }), t('c')].map((x) => [x.id, x]),
    );
    assert.equal(dependencyCycle('c', ['a'], byId), true, 'c → a → b ⇢ c');
    assert.equal(dependencyCycle('a', ['c'], byId), false);
  });
  test('dependsOnRefusal', () => {
    const byId = new Map([t('a', { dependsOn: ['b'] }), t('b')].map((x) => [x.id, x]));
    assert.match(dependsOnRefusal('a', ['a'], byId)!, /itself/);
    assert.match(dependsOnRefusal('a', ['zz'], byId)!, /no task/);
    assert.match(dependsOnRefusal('b', ['a'], byId)!, /cycle/);
    assert.equal(dependsOnRefusal(null, ['a', 'b'], byId), null);
  });
  test('a waiter does not hold the custom queue; a split parent does', () => {
    const blocked = { status: 'blocked', reviewState: null, checkState: null, pausedTurn: null } as const;
    assert.equal(customQueueHoldsRepo({ ...blocked, waitFor: null }), true);
    assert.equal(customQueueHoldsRepo({ ...blocked, waitFor: wait() }), false);
  });
  test('dependenciesNote', () => {
    assert.equal(dependenciesNote([], 0), null);
    assert.match(dependenciesNote([t('b', { title: 'API', status: 'published', resultSummary: 'did it' })], 1)!, /"API" \(task b, published\) — did it[\s\S]*1 task\(s\) since deleted/);
  });
});

describe('feature plan dependsOn', () => {
  const raw = planSchema.parse({
    summary: 's',
    considerations: [],
    phases: [
      {
        title: 'P1',
        goal: 'g',
        tasks: [
          { title: 'API', description: 'd', exitCriteria: null },
          { title: 'UI', description: 'd', exitCriteria: null, dependsOn: ['1.1', '1.2', '1.3', 'junk'] },
          { title: 'Docs', description: 'd', exitCriteria: null, dependsOn: ['1.2'] },
        ],
      },
    ],
  });
  const plan = toStoredPlan(raw, (p, i) => `c${p}${i}`);
  test('only refs to EARLIER cards survive', () => {
    assert.deepEqual(plan.phases[0].tasks[1].dependsOn, ['c00']);
    assert.deepEqual(plan.phases[0].tasks[2].dependsOn, ['c01']);
  });
  test('planCards drops an edge onto an excluded or later card', () => {
    const excl = structuredClone(plan);
    excl.phases[0].tasks[1].excluded = true;
    const cards = planCards({ title: 'F', analysis: excl } as Feature);
    assert.deepEqual(cards.map((c) => c.dependsOnCards), [[], []]);
    const swapped = structuredClone(plan);
    swapped.phases[0].tasks.reverse(); // Docs, UI, API — every edge now points forward
    assert.deepEqual(planCards({ title: 'F', analysis: swapped } as Feature).map((c) => c.dependsOnCards), [[], [], []]);
  });
});

describe('sqlite gates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-task-wait-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a dependency holds the claim until it settles; deleted is met', async () => {
    const s = new SqliteStorage(path.join(dir, 'claim.db'));
    await s.migrate();
    const r1 = await s.createRepo({ name: 'r1', path: path.join(dir, 'r1') });
    const r2 = await s.createRepo({ name: 'r2', path: path.join(dir, 'r2') });
    const api = await s.createTask({ title: 'api', repoId: r1.id, status: 'draft' }, 'test');
    const ui = await s.createTask({ title: 'ui', repoId: r2.id, status: 'queued', dependsOn: [api.id] }, 'test');
    assert.deepEqual(ui.dependsOn, [api.id]);
    assert.equal(await s.claimNextQueuedTask('test'), null, 'held by its dependency');
    await s.transitionTask(api.id, ['draft'], 'done', 'test');
    assert.equal((await s.claimNextQueuedTask('test'))?.id, ui.id);

    const other = await s.createTask({ title: 'other', repoId: r1.id, status: 'draft' }, 'test');
    const r3 = await s.createRepo({ name: 'r3', path: path.join(dir, 'r3') }); // r2 is busy with `ui`
    const late = await s.createTask({ title: 'late', repoId: r3.id, status: 'queued' }, 'test');
    await s.setTaskDependsOn(late.id, [other.id], 'test');
    assert.equal(await s.claimNextQueuedTask('test'), null);
    await s.deleteTask(other.id);
    assert.equal((await s.claimNextQueuedTask('test'))?.id, late.id, 'a deleted dependency is met');
    await s.close();
  });

  test('a parked waiter: set by its transition, cleared by any other; frees the custom queue; ignored by child resolution', async () => {
    const s = new SqliteStorage(path.join(dir, 'wait.db'));
    await s.migrate();
    const r = await s.createRepo({ name: 'r', path: path.join(dir, 'r') });
    const waiter = await s.createTask({ title: 'waiter', repoId: r.id, status: 'running' }, 'test');
    await s.updateTask(waiter.id, { customQueueAt: new Date(NOW).toISOString() });
    const next = await s.createTask({ title: 'next', repoId: r.id, status: 'queued' }, 'test');
    await s.updateTask(next.id, { customQueueAt: new Date(NOW + 1000).toISOString() });
    assert.equal(await s.peekCustomQueue(), null, 'a running member holds its repo');

    const w = wait({ taskId: next.id, title: 'next' });
    const parked = await s.transitionTask(waiter.id, ['running'], 'blocked', 'hook', { waitFor: w });
    assert.deepEqual(parked?.waitFor, w);
    assert.equal((await s.peekCustomQueue())?.id, next.id, 'a waiter does not hold the custom queue');

    // a child of the waiter settling must not land it (that is the split parent's rule)
    const kid = await s.createTask({ title: 'kid', repoId: r.id, parentId: waiter.id, status: 'queued' }, 'test');
    await s.transitionTask(kid.id, ['queued'], 'done', 'test');
    assert.equal(await s.resolveChildCompletion(kid.id, 'review', 'test'), null);
    assert.equal((await s.getTask(waiter.id))?.status, 'blocked');

    const resumed = await s.transitionTask(waiter.id, ['blocked'], 'running', 'orchestrator');
    assert.equal(resumed?.waitFor, null, 'any other transition clears the wait');
    await s.close();
  });

  test('edgeIndex overlays wait requests not parked yet: crossing requests are a cycle (review round 1)', async () => {
    const s = new SqliteStorage(path.join(dir, 'edges.db'));
    await s.migrate();
    const r = await s.createRepo({ name: 'r', path: path.join(dir, 'r') });
    const a = await s.createTask({ title: 'a', repoId: r.id, status: 'running' }, 'test');
    const b = await s.createTask({ title: 'b', repoId: r.id, status: 'running' }, 'test');
    const q = await s.createTask({ title: 'q', repoId: r.id, status: 'queued' }, 'test');
    assert.equal(dependencyCycle(b.id, [a.id], await edgeIndex(s)), false, 'rows alone show no edge');
    const pending = () => new Map([[a.id, b.id]]); // a asked to wait on b, has not stopped yet
    assert.equal(dependencyCycle(b.id, [a.id], await edgeIndex(s, pending)), true, 'b may not wait on a');
    assert.equal(dependsOnRefusal(b.id, [q.id], await edgeIndex(s, pending)), null, 'unrelated edges stay allowed');
    assert.ok(dependsOnRefusal(q.id, [a.id], await edgeIndex(s, () => new Map([[a.id, q.id]]))), 'a dependency onto a pending waiter of it is a cycle');
    await s.close();
  });
});
