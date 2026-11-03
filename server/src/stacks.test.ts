// The Stacks board version's pure model (docs/board-versions.md § Stacks).
// Run: npm test   (node:test through tsx; pure, no git and no DB)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildInbox, buildStacks, stackSectionOf, type Question, type Run, type StackGroup, type StackSection, type Task } from '@tm/shared';

let order = 0;
const NOW = Date.parse('2026-11-03T12:00:00Z');
const iso = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();

/** a task in group `groupId` under `parent` (null = a root) */
function t(id: string, status: Task['status'], parent: Task | null = null, extra: Partial<Task> = {}): Task {
  order++;
  return {
    id,
    title: `T ${id}`,
    status,
    repoId: 'r1',
    parentId: parent?.id ?? null,
    groupId: parent ? parent.groupId : id,
    groupPath: parent ? `${parent.groupPath}${parent.id}/` : '',
    groupName: null,
    groupColor: null,
    priority: 0,
    sortOrder: order,
    source: 'manual',
    createdByRun: null,
    hiddenAt: null,
    pausedTurn: null,
    reviewState: null,
    checkState: null,
    featureId: null,
    featurePhase: null,
    createdAt: iso(1000 - order),
    updatedAt: iso(1000 - order),
    ...extra,
  } as unknown as Task;
}

const stacks = (tasks: Task[], opts: { questions?: Question[]; runs?: Run[]; mode?: 'stacks' | 'flat' } = {}) =>
  buildStacks({
    tasks,
    inbox: buildInbox({ tasks, questions: opts.questions ?? [], runs: opts.runs ?? [], proposals: [], features: [], now: NOW }),
    mode: opts.mode,
  });
const ids = (s: StackSection[]) => Object.fromEntries(s.map((x) => [x.id, x.items.map((i) => (i.kind === 'stack' ? `[${i.groupId}]` : i.member.task.id))]));

describe('stackSectionOf', () => {
  test('statuses without a need', () => {
    assert.equal(stackSectionOf(t('a', 'running'), null), 'working');
    assert.equal(stackSectionOf(t('a', 'waiting'), null), 'working');
    assert.equal(stackSectionOf(t('a', 'review', null, { reviewState: 'reviewing' }), null), 'working');
    assert.equal(stackSectionOf(t('a', 'queued'), null), 'up-next');
    assert.equal(stackSectionOf(t('a', 'blocked'), null), 'up-next');
    assert.equal(stackSectionOf(t('a', 'draft'), null), 'drafts');
    assert.equal(stackSectionOf(t('a', 'done'), null), 'landed');
    assert.equal(stackSectionOf(t('a', 'published'), null), 'landed');
    assert.equal(stackSectionOf(t('a', 'cancelled'), null), 'stopped');
    assert.equal(stackSectionOf(t('a', 'failed'), 'failed'), 'needs-you');
  });
});

describe('buildStacks', () => {
  test('needs you is the inbox: settled review, recent failure, question, attention — not an open verify round', () => {
    const settled = t('rv', 'review', null, { reviewState: 'passed' });
    const open = t('ro', 'review', null, { reviewState: 'pending' });
    const failedNew = t('fn', 'failed', null, { updatedAt: iso(60) });
    const failedOld = t('fo', 'failed', null, { updatedAt: iso(60 * 24 * 30) });
    const asks = t('q', 'running');
    const att = t('at', 'running');
    const q = { id: 'q1', taskId: 'q', runId: 'x', status: 'pending', createdAt: iso(5) } as unknown as Question;
    const run = { id: 'run-at', taskId: 'at', status: 'running', idle: false, needsAttention: true, startedAt: iso(10) } as unknown as Run;
    const s = ids(stacks([settled, open, failedNew, failedOld, asks, att], { questions: [q], runs: [run] }));
    // inbox decision order: question, attention, review, failed
    assert.deepEqual(s['needs-you'], ['q', 'at', 'rv', 'fn']);
    assert.deepEqual(s.working, ['ro']);
    assert.deepEqual(s.stopped, ['fo']);
  });

  test('a group is one stack in its most urgent member\'s section, members in run order', () => {
    const root = t('g', 'blocked');
    const b = t('b', 'queued', root, { sortOrder: 20 });
    const a = t('a', 'done', root, { sortOrder: 10 });
    const a1 = t('a1', 'review', a, { reviewState: 'flagged' });
    const c = t('c', 'running', root, { sortOrder: 30 });
    const single = t('s', 'queued');
    const s = stacks([root, b, a, a1, c, single]);
    assert.deepEqual(ids(s), { 'needs-you': ['[g]'], 'up-next': ['s'] });
    const g = s[0].items[0] as StackGroup;
    assert.deepEqual(
      g.members.map((m) => `${m.task.id}:${m.depth}`),
      ['g:0', 'a:1', 'a1:2', 'b:1', 'c:1'],
    );
    assert.equal(g.now.task.id, 'a1');
    assert.equal(g.now.need, 'review');
    assert.equal(g.landed, 1);
    assert.equal(g.label, 'T g');
    assert.equal(s[0].tasks, 5);
  });

  test('now prefers a runnable member over the blocked split parent waiting on it', () => {
    const root = t('p', 'blocked');
    t('x', 'done', root);
    const q = t('q', 'queued', root);
    const g = stacks([root, q]).find((x) => x.id === 'up-next')!.items[0] as StackGroup;
    assert.equal(g.now.task.id, 'q');
  });

  test('a group whose root is not on the board is still a stack, named after its first member', () => {
    const root = t('r', 'done');
    const k1 = t('k1', 'running', root);
    const k2 = t('k2', 'queued', root);
    const g = stacks([k1, k2])[0].items[0] as StackGroup;
    assert.equal(g.kind, 'stack');
    assert.equal(g.label, 'T k1');
    assert.deepEqual(g.members.map((m) => m.depth), [0, 0]);
  });

  test('flat: every task its own row, by its own section, carrying its group', () => {
    const root = t('f', 'running', null, { groupName: 'Feature F' });
    const k = t('fk', 'draft', root);
    const s = stacks([root, k], { mode: 'flat' });
    assert.deepEqual(ids(s), { working: ['f'], drafts: ['fk'] });
    const row = s[1].items[0];
    assert.ok(row.kind === 'task' && row.group?.label === 'Feature F' && row.group.groupId === 'f');
  });

  test('a lone task has no group in flat mode', () => {
    const s = stacks([t('solo', 'queued')], { mode: 'flat' });
    const row = s[0].items[0];
    assert.ok(row.kind === 'task' && row.group === null);
  });

  test('queue order: priority, then group root position; landed newest first', () => {
    const lo = t('lo', 'queued', null, { sortOrder: 1 });
    const hi = t('hi', 'queued', null, { priority: 5, sortOrder: 9 });
    const mid = t('mid', 'queued', null, { sortOrder: 2 });
    const old = t('old', 'done', null, { updatedAt: iso(500) });
    const fresh = t('new', 'published', null, { updatedAt: iso(1) });
    const s = ids(stacks([lo, hi, mid, old, fresh]));
    assert.deepEqual(s['up-next'], ['hi', 'lo', 'mid']);
    assert.deepEqual(s.landed, ['new', 'old']);
  });

  test('empty sections are left out', () => {
    assert.deepEqual(stacks([]), []);
  });
});
