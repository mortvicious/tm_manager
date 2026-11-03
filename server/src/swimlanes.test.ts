// The Swimlanes board version's pure layout (docs/board-versions.md § Swimlanes).
// Run: npm test   (node:test through tsx; pure, no git and no DB)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SWIMLANE_LOOSE, layoutSwimlanes, swimlaneStage, type SwimlaneInput, type SwimlaneTask, type TaskStatus } from '@tm/shared';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const DAY = 24 * 3600_000;
let order = 0;
const t = (id: string, status: TaskStatus, extra: Partial<SwimlaneTask> = {}): SwimlaneTask => ({
  id,
  title: id,
  parentId: null,
  groupId: id,
  groupName: null,
  groupColor: null,
  status,
  sortOrder: ++order,
  repoId: 'r1',
  featureId: null,
  updatedAt: new Date(NOW - 3600_000).toISOString(),
  ...extra,
});
const child = (id: string, parent: string, group: string, status: TaskStatus, extra: Partial<SwimlaneTask> = {}) =>
  t(id, status, { parentId: parent, groupId: group, ...extra });

// big ─┬─ a (running) ─── a1 (running)
//      ├─ b (review, repo r2)
//      └─ c (done)
// old ─── o1 (done, 30 days ago), root done 30 days ago
// lone (queued), gone (cancelled), stale (done 30 days ago)
const tasks: SwimlaneTask[] = [
  t('big', 'blocked', { groupName: 'Big split', featureId: 'f1' }),
  child('a', 'big', 'big', 'running'),
  child('a1', 'a', 'big', 'running'),
  child('b', 'big', 'big', 'review', { repoId: 'r2' }),
  child('c', 'big', 'big', 'done'),
  t('old', 'done', { updatedAt: new Date(NOW - 30 * DAY).toISOString() }),
  child('o1', 'old', 'old', 'published', { updatedAt: new Date(NOW - 30 * DAY).toISOString() }),
  t('lone', 'queued', { repoId: null as unknown as string }),
  t('gone', 'cancelled'),
  t('stale', 'done', { updatedAt: new Date(NOW - 30 * DAY).toISOString() }),
];
const base: Omit<SwimlaneInput, 'laneBy' | 'showAll'> = {
  tasks,
  repos: [
    { id: 'r1', name: 'tm' },
    { id: 'r2', name: 'api' },
  ],
  features: [{ id: 'f1', title: 'Feature One', repoId: 'r1' }],
  now: NOW,
};
const ids = (cards: { id: string }[]) => cards.map((c) => c.id);

describe('swimlaneStage', () => {
  test('maps every status but cancelled', () => {
    assert.equal(swimlaneStage('draft'), 'queued');
    assert.equal(swimlaneStage('waiting'), 'working');
    assert.equal(swimlaneStage('blocked'), 'stuck');
    assert.equal(swimlaneStage('failed'), 'stuck');
    assert.equal(swimlaneStage('published'), 'landed');
    assert.equal(swimlaneStage('cancelled'), null);
  });
});

describe('layoutSwimlanes by group', () => {
  const recent = layoutSwimlanes({ ...base, laneBy: 'group', showAll: false });
  const all = layoutSwimlanes({ ...base, laneBy: 'group', showAll: true });

  test('a lane per group, single tasks in one loose lane at the bottom, cancelled left out', () => {
    assert.deepEqual(
      all.lanes.map((l) => l.id),
      ['big', 'old', SWIMLANE_LOOSE],
    );
    const loose = all.lanes.at(-1)!;
    assert.equal(loose.label, 'Ungrouped');
    assert.equal(loose.colorSlot, null);
    assert.deepEqual(ids(loose.cells.queued), ['lone']);
    assert.ok(!all.lanes.some((l) => Object.values(l.cells).flat().some((c) => c.id === 'gone')));
  });

  test('the header counts every member and the bar follows the mockup order', () => {
    const big = all.lanes[0];
    assert.equal(big.label, 'Big split');
    assert.equal(big.sub, 'Feature One');
    assert.equal(big.repoId, 'r1');
    assert.equal(big.total, 5);
    assert.equal(big.landed, 1);
    assert.deepEqual(big.segments, [
      { status: 'done', count: 1 },
      { status: 'review', count: 1 },
      { status: 'running', count: 2 },
      { status: 'blocked', count: 1 },
    ]);
  });

  test('a child under its parent in the same cell is indented; across cells it is flush', () => {
    const big = all.lanes[0];
    assert.deepEqual(big.cells.working, [
      { id: 'a', depth: 0 },
      { id: 'a1', depth: 1 },
    ]);
    assert.deepEqual(big.cells.stuck, [{ id: 'big', depth: 0 }]);
    assert.deepEqual(big.cells.review, [{ id: 'b', depth: 0 }]);
  });

  test('hide finished drops old landed tasks and lanes left empty, keeps the header counts', () => {
    assert.deepEqual(
      recent.lanes.map((l) => l.id),
      ['big', SWIMLANE_LOOSE],
    );
    const loose = recent.lanes.at(-1)!;
    assert.deepEqual(ids(loose.cells.landed), []);
    assert.equal(loose.total, 2);
    assert.equal(recent.stageCounts.landed, 1);
    assert.equal(all.stageCounts.landed, 4);
  });

  test('a root outside the set still names its lane', () => {
    const l = layoutSwimlanes({
      ...base,
      tasks: [child('k1', 'hid', 'hid', 'queued'), child('k2', 'hid', 'hid', 'queued')],
      laneBy: 'group',
      showAll: true,
      rootOf: (id) => (id === 'hid' ? { ...t('hid', 'done'), groupName: 'Hidden root' } : undefined),
    });
    assert.equal(l.lanes[0].label, 'Hidden root');
    assert.equal(layoutSwimlanes({ ...base, tasks: [child('k1', 'hid', 'hid', 'queued'), child('k2', 'hid', 'hid', 'queued')], laneBy: 'group', showAll: true }).lanes[0].label, 'Group');
  });

  test('finished lanes sort after live ones', () => {
    const live = layoutSwimlanes({
      ...base,
      tasks: [t('g1', 'done'), child('g1a', 'g1', 'g1', 'done'), t('g2', 'queued'), child('g2a', 'g2', 'g2', 'queued')],
      laneBy: 'group',
      showAll: true,
    });
    assert.deepEqual(
      live.lanes.map((l) => l.id),
      ['g2', 'g1'],
    );
  });
});

describe('layoutSwimlanes by repo and feature', () => {
  test('repo lanes by name, no-repo last', () => {
    const l = layoutSwimlanes({ ...base, laneBy: 'repo', showAll: true });
    assert.deepEqual(
      l.lanes.map((x) => [x.id, x.label]),
      [
        ['r2', 'api'],
        ['r1', 'tm'],
        [SWIMLANE_LOOSE, 'No repo'],
      ],
    );
    assert.equal(l.lanes[1].repoId, 'r1');
  });

  test('feature lanes: a single-task feature is still a lane, no-feature last', () => {
    const l = layoutSwimlanes({ ...base, tasks: [t('x', 'queued', { featureId: 'f1' }), t('y', 'queued')], laneBy: 'feature', showAll: true });
    assert.deepEqual(
      l.lanes.map((x) => [x.id, x.label]),
      [
        ['f1', 'Feature One'],
        [SWIMLANE_LOOSE, 'No feature'],
      ],
    );
  });
});
