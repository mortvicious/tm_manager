// The board versions' shared relations helper (docs/board-versions.md § Versions control).
// Run: npm test   (node:test through tsx; pure, no git and no DB)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  TASK_RELATION_KINDS,
  buildRelationIndex,
  taskNeighbourhood,
  type RelationDispatch,
  type RelationRun,
  type RelationTask,
} from '@tm/shared';

const t = (id: string, parentId: string | null = null, createdByRun: string | null = null): RelationTask => ({
  id,
  parentId,
  createdByRun,
});
let seq = 0;
const d = (fromTaskId: string, toTaskId: string, createdAt = `2026-11-03T10:00:0${seq}Z`): RelationDispatch => ({
  id: `d${++seq}`,
  fromTaskId,
  toTaskId,
  intent: 'needs_action',
  status: 'pending',
  createdAt,
});

// root ─┬─ a ── a1
//       └─ b
// filer (run r1) filed `f1` and `b`; `aux` run has no task
const tasks = [t('root'), t('a', 'root'), t('b', 'root', 'r1'), t('a1', 'a'), t('filer'), t('f1', null, 'r1'), t('lone', null, 'aux1')];
const runs: RelationRun[] = [
  { id: 'r1', taskId: 'filer' },
  { id: 'aux1', taskId: null },
];

const kinds = (id: string, input = { tasks, runs, dispatches: [] as RelationDispatch[] }) =>
  taskNeighbourhood(input, id)!.relations.map((r) => `${r.kind}:${r.taskId}`);

describe('task relations', () => {
  test('tree: parent, children, siblings in group', () => {
    assert.deepEqual(kinds('root'), ['child:a', 'child:b']);
    assert.deepEqual(kinds('a'), ['parent:root', 'child:a1', 'sibling-in-group:b']);
    // a grandchild's siblings are its own parent's children only
    assert.deepEqual(kinds('a1'), ['parent:a']);
  });

  test('filed-by / filed through createdByRun → run.taskId', () => {
    assert.deepEqual(kinds('b'), ['parent:root', 'sibling-in-group:a', 'filed-by:filer']);
    assert.deepEqual(kinds('filer'), ['filed:b', 'filed:f1']);
    assert.deepEqual(kinds('f1'), ['filed-by:filer']);
    // an aux run carries no task, so it relates nothing
    assert.deepEqual(kinds('lone'), []);
    assert.equal(buildRelationIndex({ tasks, runs }).filerOf('b'), 'filer');
    assert.equal(buildRelationIndex({ tasks }).filerOf('b'), null, 'no runs → no filer');
  });

  test('dispatches: in and out, one relation per partner, oldest first', () => {
    seq = 0;
    const dispatches = [d('a', 'f1', '2026-11-03T10:00:05Z'), d('a', 'f1', '2026-11-03T10:00:01Z'), d('f1', 'a'), d('a', 'a')];
    const n = taskNeighbourhood({ tasks, runs, dispatches }, 'a')!;
    assert.deepEqual(
      n.relations.map((r) => `${r.kind}:${r.taskId}`),
      ['parent:root', 'child:a1', 'sibling-in-group:b', 'dispatch-in:f1', 'dispatch-out:f1'],
    );
    const out = n.relations.find((r) => r.kind === 'dispatch-out')!;
    assert.deepEqual(
      out.dispatches!.map((x) => x.createdAt),
      ['2026-11-03T10:00:01Z', '2026-11-03T10:00:05Z'],
    );
    assert.ok(!n.ids.has('a'), 'a self-dispatch is not a relation');
    assert.deepEqual(kinds('f1', { tasks, runs, dispatches }), ['filed-by:filer', 'dispatch-in:a', 'dispatch-out:a']);
  });

  test('ids: every related task once, the task itself excluded', () => {
    const n = taskNeighbourhood({ tasks: [t('p'), t('c', 'p', 'r')], runs: [{ id: 'r', taskId: 'p' }] }, 'c')!;
    // p is both the parent and the filer: two relations, one id
    assert.deepEqual(n.relations.map((r) => r.kind), ['parent', 'filed-by']);
    assert.deepEqual([...n.ids], ['p']);
  });

  test('only tasks in the list relate (scope, hidden tasks left out)', () => {
    seq = 0;
    const visible = tasks.filter((x) => x.id !== 'root' && x.id !== 'filer');
    const dispatches = [d('a', 'gone')];
    assert.deepEqual(kinds('a', { tasks: visible, runs, dispatches }), ['child:a1']);
    assert.deepEqual(kinds('b', { tasks: visible, runs, dispatches }), []);
    assert.equal(taskNeighbourhood({ tasks: visible }, 'root'), null);
  });

  test('order follows the input list', () => {
    const rev = [...tasks].reverse();
    assert.deepEqual(kinds('root', { tasks: rev, runs, dispatches: [] }), ['child:b', 'child:a']);
  });

  test('every kind is listed once', () => {
    assert.equal(new Set(TASK_RELATION_KINDS).size, 7);
  });
});
