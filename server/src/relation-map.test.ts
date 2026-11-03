// The Relation map board version's pure layout (docs/board-versions.md § Relation map).
// Run: npm test   (node:test through tsx; pure, no git and no DB)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  RM_BAND_PAD,
  RM_COL_W,
  RM_NODE_H,
  RM_ROW_GAP,
  RM_X0,
  UNGROUPED_BAND,
  cullRelationMap,
  layoutRelationMap,
  type RelationDispatch,
  type RelationMapTask,
  type TaskStatus,
} from '@tm/shared';

let order = 0;
const t = (id: string, parentId: string | null = null, extra: Partial<RelationMapTask> = {}): RelationMapTask => ({
  id,
  title: id,
  parentId,
  groupId: parentId ? (extra.groupId ?? 'root') : id,
  groupName: null,
  groupColor: null,
  status: 'queued' as TaskStatus,
  sortOrder: ++order,
  featurePhase: null,
  ...extra,
});

// root ─┬─ a ─┬─ a1
//       │     └─ a2
//       └─ b
// lone1 filed lone2 (both ungrouped); lone1 filed b; lone1 → a dispatches
const tasks = [
  t('root', null, { groupName: 'Big' }),
  t('a', 'root'),
  t('a1', 'a'),
  t('a2', 'a'),
  t('b', 'root', { status: 'review' }),
  t('lone1'),
  t('lone2', null, { status: 'done' }),
];
const filed: Record<string, string> = { lone2: 'lone1', b: 'lone1' };
const filerOf = (id: string) => filed[id] ?? null;
const disp = (id: string, from: string, to: string, status: RelationDispatch['status']): RelationDispatch => ({
  id,
  fromTaskId: from,
  toTaskId: to,
  intent: 'needs_action',
  status,
  createdAt: '2026-11-03T10:00:00Z',
});
const rowY = (bandY: number, r: number) => bandY + RM_BAND_PAD + r * (RM_NODE_H + RM_ROW_GAP);

describe('layoutRelationMap', () => {
  const l = layoutRelationMap({ tasks, filerOf, columns: 'depth', dispatches: [disp('d1', 'lone1', 'a', 'delivered'), disp('d2', 'lone1', 'a', 'pending'), disp('d3', 'a', 'a', 'pending')] });

  test('one band per group, then the ungrouped band', () => {
    assert.deepEqual(
      l.bands.map((b) => [b.id, b.label, b.count]),
      [
        ['root', 'Big', 5],
        [UNGROUPED_BAND, 'Ungrouped', 2],
      ],
    );
    assert.equal(l.bands[1].colorSlot, null);
    assert.ok(l.bands[1].y >= l.bands[0].y + l.bands[0].height);
  });

  test('the tree reads left to right with the parent centred over its children', () => {
    const n = (id: string) => l.byId.get(id)!;
    const top = l.bands[0].y;
    assert.equal(n('a1').y, rowY(top, 0));
    assert.equal(n('a2').y, rowY(top, 1));
    assert.equal(n('b').y, rowY(top, 2));
    assert.equal(n('a').y, rowY(top, 0.5));
    assert.equal(n('root').y, rowY(top, 1.25));
    assert.deepEqual(['root', 'a', 'a1'].map((id) => n(id).x), [RM_X0, RM_X0 + RM_COL_W, RM_X0 + 2 * RM_COL_W]);
  });

  test('in the ungrouped band a filed task sits one column right of its filer', () => {
    const a = l.byId.get('lone1')!;
    const b = l.byId.get('lone2')!;
    assert.equal(b.y, a.y);
    assert.equal(b.x, a.x + RM_COL_W);
  });

  test('edges: subtask, filed by, dispatches aggregated per direction', () => {
    const keys = l.edges.map((e) => e.key).sort();
    assert.deepEqual(keys, [
      'dispatch:lone1>a',
      'filed:lone1>b',
      'filed:lone1>lone2',
      'subtask:a>a1',
      'subtask:a>a2',
      'subtask:root>a',
      'subtask:root>b',
    ]);
    const d = l.edges.find((e) => e.kind === 'dispatch')!;
    assert.equal(d.count, 2);
    assert.equal(d.pending, true);
    assert.equal(l.edges.find((e) => e.key === 'subtask:root>a')!.colorSlot, l.bands[0].colorSlot);
  });

  test('status columns: compacted to the ones in use, one row per task', () => {
    const s = layoutRelationMap({ tasks, filerOf, columns: 'status' });
    assert.deepEqual(s.columns.map((c) => c.label), ['queued', 'review', 'landed']);
    assert.equal(s.byId.get('b')!.col, 1);
    assert.equal(s.byId.get('lone2')!.col, 2);
    const ys = s.nodes.filter((n) => n.bandId === 'root').map((n) => n.y);
    assert.equal(new Set(ys).size, ys.length, 'no two tasks of a band share a row');
  });

  test('phase columns', () => {
    const p = layoutRelationMap({ tasks: [t('x', null, { featurePhase: 2 }), t('y', null, { featurePhase: 0 }), t('z')], filerOf: () => null, columns: 'phase' });
    assert.deepEqual(p.columns.map((c) => c.label), ['no phase', 'phase 1', 'phase 3']);
    assert.equal(p.byId.get('x')!.col, 2);
  });

  test('a group whose root is out of the set still bands, and a cycle never loops', () => {
    const q = layoutRelationMap({
      tasks: [t('c1', 'gone', { groupId: 'g' }), t('c2', 'gone', { groupId: 'g' }), t('u1'), t('u2')],
      filerOf: (id) => (id === 'u1' ? 'u2' : id === 'u2' ? 'u1' : null),
      columns: 'depth',
    });
    assert.equal(q.nodes.length, 4);
    assert.equal(q.bands[0].label, 'Group');
  });

  test('300 tasks lay out and cull to the viewport', () => {
    const many: RelationMapTask[] = [];
    for (let g = 0; g < 30; g++) {
      many.push(t(`g${g}`));
      for (let i = 0; i < 9; i++) many.push(t(`g${g}-${i}`, i < 3 ? `g${g}` : `g${g}-${i % 3}`, { groupId: `g${g}` }));
    }
    for (let i = 0; i < 30; i++) many.push(t(`u${i}`));
    const big = layoutRelationMap({ tasks: many, filerOf: () => null, columns: 'depth' });
    assert.equal(big.nodes.length, 330);
    const seen = cullRelationMap(big, { x: 0, y: 0, width: 1280, height: 800 });
    assert.ok(seen.nodes.length > 0 && seen.nodes.length < 60, `culled to ${seen.nodes.length}`);
    assert.ok(seen.edges.every((e) => e.minY <= 800));
  });
});
