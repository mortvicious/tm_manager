// The Metro board version's pure layout (docs/board-versions.md § Metro).
// Run: npm test   (node:test through tsx; pure, no git and no DB)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { layoutMetro, metroRows, type MetroLine, type MetroTask, type TaskStatus } from '@tm/shared';

let order = 0;
const t = (id: string, parentId: string | null = null, extra: Partial<MetroTask> = {}): MetroTask => ({
  id,
  title: id,
  parentId,
  groupId: parentId ? (extra.groupId ?? 'root') : id,
  groupName: null,
  groupColor: null,
  status: 'queued' as TaskStatus,
  sortOrder: ++order,
  priority: 0,
  createdAt: '2026-11-03T00:00:00.000Z',
  ...extra,
});

/** A branch's drop at x = fromSlot passes every lane above its own: none of their branches may cover that slot. */
function assertNoDropCrosses(l: MetroLine) {
  for (const b of l.branches)
    for (const c of l.branches) {
      if (c === b || c.lane >= b.lane) continue;
      const covers = c.fromSlot <= b.fromSlot && b.fromSlot <= c.fromSlot + c.stations.length;
      assert.ok(!covers, `${b.fromId} (lane ${b.lane}) drops through ${c.fromId} (lane ${c.lane})`);
    }
  // and no two branches in one lane overlap
  for (const b of l.branches)
    for (const c of l.branches) {
      if (c === b || c.lane !== b.lane) continue;
      const overlap = c.fromSlot <= b.fromSlot + b.stations.length && b.fromSlot <= c.fromSlot + c.stations.length;
      assert.ok(!overlap, `${b.fromId} and ${c.fromId} overlap in lane ${b.lane}`);
    }
}

describe('layoutMetro', () => {
  test('a blocked split root is the origin; stations in run order; deeper subtasks branch', () => {
    // root(blocked) ─┬─ a(done) ─┬─ a1(done)
    //                │           └─ a2
    //                ├─ c(running)   (sortOrder before b: claims first)
    //                └─ b
    const b = t('b', 'root', { sortOrder: 50 });
    const c = t('c', 'root', { sortOrder: 40, status: 'running' });
    const tasks = [
      t('root', null, { status: 'blocked', groupName: 'Big' }),
      t('a', 'root', { status: 'done' }),
      t('a1', 'a', { status: 'done' }),
      t('a2', 'a'),
      b,
      c,
    ];
    const { lines, local } = layoutMetro(tasks);
    assert.deepEqual(local, []);
    assert.equal(lines.length, 1);
    const l = lines[0];
    assert.equal(l.label, 'Big');
    assert.equal(l.originId, 'root');
    assert.deepEqual(l.main.map((s) => s.id), ['a', 'c', 'b']);
    assert.deepEqual(l.main.map((s) => s.slot), [0, 1, 2]);
    assert.equal(l.lastStarted, 1, 'solid up to the running station');
    assert.equal(l.count, 6);
    assert.equal(l.landed, 2);
    assert.equal(l.branches.length, 1);
    assert.deepEqual(l.branches[0], {
      fromId: 'a',
      fromSlot: 0,
      lane: 1,
      stations: [
        { id: 'a1', slot: 1 },
        { id: 'a2', slot: 2 },
      ],
      lastStarted: 0,
    });
    assert.equal(l.lanes, 1);
    assert.equal(l.maxSlot, 2);
  });

  test('a root that is not blocked is the first station', () => {
    const { lines } = layoutMetro([t('r2'), t('x', 'r2', { groupId: 'r2' })]);
    assert.equal(lines[0].originId, null);
    assert.deepEqual(lines[0].main.map((s) => s.id), ['r2', 'x']);
    assert.equal(lines[0].lastStarted, -1);
  });

  test('a branch never drops through another branch: lanes go right to left', () => {
    const g = { groupId: 'g' };
    const tasks = [
      t('g'),
      t('p', 'g', g),
      t('q', 'g', g),
      t('r', 'g', g),
      t('s', 'g', g),
      t('p1', 'p', g),
      t('p2', 'p', g),
      t('p3', 'p', g),
      t('q1', 'q', g),
      t('s1', 's', g),
    ];
    const l = layoutMetro(tasks).lines[0];
    assert.deepEqual(l.main.map((s) => s.id), ['g', 'p', 'q', 'r', 's']);
    const lane = Object.fromEntries(l.branches.map((b) => [b.fromId, b.lane]));
    // q's (slots 2..3) and s's (4..5) branches are disjoint, so both sit in
    // lane 1; p's (1..4) contains both their drops, so it goes below them and
    // its own drop at slot 1 passes lane 1 left of q's start
    assert.deepEqual(lane, { p: 2, q: 1, s: 1 });
    assert.equal(l.lanes, 2);
    assert.equal(l.maxSlot, 5);
    assertNoDropCrosses(l);
  });

  test('no drop crosses an upper lane on a staircase of nested branches', () => {
    const g = { groupId: 'n' };
    const tasks = [t('n')];
    // five main stations, each with a branch long enough to reach past the next ones
    for (let i = 0; i < 5; i++) {
      tasks.push(t(`m${i}`, 'n', g));
      for (let j = 0; j < 5 - i; j++) tasks.push(t(`m${i}-${j}`, `m${i}`, g));
    }
    const l = layoutMetro(tasks).lines[0];
    assertNoDropCrosses(l);
    // every branch overlaps every later one's drop, so each sits below the next
    assert.deepEqual(l.branches.map((b) => b.lane), [5, 4, 3, 2, 1]);
  });

  test('a member whose parent is not shown hangs off the root level', () => {
    const tasks = [t('h'), t('h2', 'hidden', { groupId: 'h' })];
    const l = layoutMetro(tasks).lines[0];
    assert.deepEqual(l.main.map((s) => s.id), ['h', 'h2']);
    assert.deepEqual(l.branches, []);
  });

  test('a group without its root still gets a line; singles are local stops in run order', () => {
    const tasks = [
      t('m1', 'gone', { groupId: 'gone' }),
      t('m2', 'gone', { groupId: 'gone' }),
      t('solo-late', null, { sortOrder: 900 }),
      t('solo-urgent', null, { sortOrder: 950, priority: 2 }),
      t('kid', 'parent-alone', { groupId: 'parent-alone' }),
    ];
    const { lines, local } = layoutMetro(tasks);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].label, 'Group');
    assert.equal(lines[0].originId, null);
    assert.deepEqual(local, ['solo-urgent', 'kid', 'solo-late']);
  });

  test('lines follow the queue order of their roots, priority first', () => {
    const tasks = [
      t('L1', null, { sortOrder: 1 }),
      t('L1a', 'L1', { groupId: 'L1' }),
      t('L2', null, { sortOrder: 2, priority: 1 }),
      t('L2a', 'L2', { groupId: 'L2' }),
    ];
    assert.deepEqual(layoutMetro(tasks).lines.map((l) => l.id), ['L2', 'L1']);
  });
});

describe('metroRows', () => {
  test('rails split solid/dashed at the last started station, branches indented under their station', () => {
    const tasks = [
      t('o', null, { status: 'blocked' }),
      t('a', 'o', { groupId: 'o', status: 'done' }),
      t('a1', 'a', { groupId: 'o', status: 'review' }),
      t('a2', 'a', { groupId: 'o' }),
      t('b', 'o', { groupId: 'o', status: 'running' }),
      t('c', 'o', { groupId: 'o' }),
    ];
    const rows = metroRows(layoutMetro(tasks).lines[0]);
    assert.deepEqual(
      rows.map((r) => [r.id, r.branchOf, r.railUp, r.railDown, r.branchUp, r.branchDown]),
      [
        ['a', null, 'solid', 'solid', null, null],
        ['a1', 'a', 'solid', 'solid', 'solid', 'dashed'],
        ['a2', 'a', 'solid', 'solid', 'dashed', null],
        ['b', null, 'solid', 'dashed', null, null],
        ['c', null, 'dashed', null, null, null],
      ],
    );
  });

  test('without an origin the first station has no rail above', () => {
    const rows = metroRows(layoutMetro([t('r'), t('r1', 'r', { groupId: 'r' })]).lines[0]);
    assert.equal(rows[0].railUp, null);
    assert.equal(rows[1].railDown, null);
  });
});
