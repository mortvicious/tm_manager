// The Pixel office's isometric projection and acting (docs/office.md § Pixel office).
// Run: npm test   (node:test through tsx; pure, no git and no DB)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  OFFICE_ROLE_STATES,
  layoutOffice,
  officeEdgeEnds,
  officeIsStacked,
  officeIsoProjection,
  officePixelAct,
  officeSkipReason,
  type Office,
  type OfficeLayout,
  type OfficeMessage,
  type OfficeRole,
  type OfficeRolePreset,
  type OfficeRoleState,
  type OfficeStates,
  type OfficeViewPoint,
} from '@tm/shared';

const NOW = '2026-11-06T12:00:00.000Z';
const ago = (min: number): string => new Date(Date.parse(NOW) - min * 60_000).toISOString();

const office = (extra: Partial<Office> = {}): Office => ({
  id: 'o1',
  workspaceId: 'w1',
  folderPath: '/tmp/office',
  autonomy: 'proposals',
  dayBudgetUsd: 10,
  maxSlots: 1,
  maxTasksPerShift: 8,
  maxOpenTasks: 12,
  pausedAt: null,
  pausedReason: null,
  budgetTrippedOn: null,
  theme: null,
  timezone: 'UTC',
  enabled: true,
  killSwitch: false,
  ...extra,
});

const role = (id: string, preset: OfficeRolePreset | null, extra: Partial<OfficeRole> = {}): OfficeRole => ({
  id,
  officeId: 'o1',
  preset,
  key: id,
  name: id.toUpperCase(),
  avatar: '🙂',
  title: 'Title',
  prompt: '',
  model: 'claude-opus-5-5',
  effort: null,
  tools: [],
  autonomy: null,
  capUsd: null,
  schedules: ['0 9 * * *'],
  triggers: [],
  guards: [],
  commands: [],
  notesPath: `roles/${id}.md`,
  notesTaintedAt: null,
  sessionId: null,
  sessionTainted: false,
  enabled: true,
  armedAt: null,
  ...extra,
});

const states = (map: Record<string, OfficeRoleState>): OfficeStates => ({
  officeId: 'o1',
  at: NOW,
  spentTodayUsd: 1,
  states: Object.entries(map).map(([roleId, state]) => ({ roleId, state, detail: `${state} detail`, nextSlotAt: null, spentTodayUsd: 0.5 })),
});

const message = (id: string, from: string | null, to: string | null): OfficeMessage => ({
  id,
  officeId: 'o1',
  fromRoleId: from,
  toRoleId: to,
  kind: 'handoff',
  subject: null,
  body: `Subject ${id}\n\nbody`,
  taintedAt: null,
  reviewedAt: null,
  routedAt: null,
  routedTaskId: null,
  createdAt: ago(2),
});

const ROLES = [role('dir', 'director'), role('dev', 'developer'), role('qa', 'qa'), role('ops', 'devops'), role('seo', 'seo'), role('cust', null)];
const lay = (columns: number, messages: OfficeMessage[] = []): OfficeLayout =>
  layoutOffice(office(), ROLES, states({ dir: 'on-shift', dev: 'scheduled' }), [], messages, [], { now: NOW, columns });

/** every point the skin projects */
function points(l: OfficeLayout): OfficeViewPoint[] {
  const out: OfficeViewPoint[] = [l.door, l.board];
  for (const r of l.rooms) {
    out.push(r.coffee, { x: r.rect.x, y: r.rect.y }, { x: r.rect.x + r.rect.w, y: r.rect.y + r.rect.h });
    for (const d of r.desks) out.push(d.seat, { x: d.rect.x, y: d.rect.y });
  }
  for (const a of l.avatars) out.push(a.at);
  return out;
}

describe('projection', () => {
  test('a multi-column layout is one floor; a one-column layout stacks its blocks', () => {
    const wide = lay(3);
    const tall = lay(1);
    assert.equal(officeIsStacked(wide), false);
    assert.equal(officeIsStacked(tall), true);
    assert.equal(officeIsoProjection(wide, 900).mode, 'floor');
    const stack = officeIsoProjection(tall, 375);
    assert.equal(stack.mode, 'stack');
    // every room plus the lobby, in top-to-bottom order
    assert.equal(stack.regions.length, tall.rooms.length + 1);
  });

  test('2:1 isometric: +x goes right-down, +y goes left-down, height goes up', () => {
    const p = officeIsoProjection(lay(3), 900);
    const o = p.project({ x: 5, y: 5 });
    const ex = p.project({ x: 6, y: 5 });
    const ey = p.project({ x: 5, y: 6 });
    const up = p.project({ x: 5, y: 5 }, 1);
    assert.deepEqual([ex.x - o.x, ex.y - o.y], [p.a, p.a / 2]);
    assert.deepEqual([ey.x - o.x, ey.y - o.y], [-p.a, p.a / 2]);
    assert.deepEqual([up.x - o.x, up.y - o.y], [0, -p.a]);
    assert.ok(ex.depth > o.depth && ey.depth > o.depth, 'nearer the viewer paints later');
  });

  test('everything lands inside the drawn area, and the floor fits the width it was given', () => {
    for (const [cols, width] of [
      [3, 1100],
      [2, 700],
      [1, 375],
      [1, 320],
    ] as const) {
      const l = lay(cols);
      const p = officeIsoProjection(l, width);
      assert.ok(p.width <= width || p.a === 8, `${cols} cols fit ${width}px (a=${p.a})`);
      for (const pt of points(l)) {
        const s = p.project(pt, 0);
        const top = p.project(pt, 3);
        assert.ok(s.x >= 0 && s.x <= p.width && s.y <= p.height, `${JSON.stringify(pt)} → ${JSON.stringify(s)} in ${p.width}×${p.height}`);
        assert.ok(top.y >= 0, `headroom above ${JSON.stringify(pt)}`);
      }
    }
  });

  test('a phone width keeps a legible tile (the stack, not a diagonal ribbon)', () => {
    const p = officeIsoProjection(lay(1), 375);
    assert.ok(p.a >= 12, `a=${p.a}`);
    // stacked blocks never overlap on screen
    for (let k = 1; k < p.regions.length; k++) {
      const prev = p.regions[k - 1];
      const bottom = prev.oy + ((prev.rect.w + prev.rect.h) * p.a) / 2;
      assert.ok(p.regions[k].oy - 1.6 * p.a >= bottom - 0.001, `block ${k} starts below block ${k - 1}`);
    }
  });

  test('a point in a stacked block projects through that block, deeper blocks paint later', () => {
    const l = lay(1);
    const p = officeIsoProjection(l, 375);
    const first = l.rooms[0];
    const last = l.rooms[l.rooms.length - 1];
    assert.equal(p.regionOf(first.desks[0].seat).rect, first.rect);
    assert.equal(p.regionOf(l.door).rect, l.lobby);
    assert.ok(p.project(last.desks[0].seat).depth > p.project(first.coffee).depth);
    assert.ok(p.project(l.door).y > p.project(last.coffee).y, 'the lobby is the bottom block');
  });
});

describe('hand-offs', () => {
  test('an edge runs between the avatars it names, following them as they move', () => {
    const l = lay(3, [message('m1', 'dir', 'dev'), message('m2', null, null)]);
    const e = l.edges.find((x) => x.id === 'm:m1')!;
    const devSeat = l.avatars.find((a) => a.roleId === 'dev')!.seat;
    const dirAt = l.avatars.find((a) => a.roleId === 'dir')!.at;
    const moved = { x: devSeat.x + 2, y: devSeat.y + 1 };
    const ends = officeEdgeEnds(e, new Map([['dev', moved]]));
    assert.deepEqual(ends.to, moved, 'the addressee end follows the wandering avatar');
    assert.deepEqual(ends.from, dirAt, 'an end with no spot keeps the layout point');
    // the stakeholder's unrouted channel message: door → board, never an avatar
    const s = l.edges.find((x) => x.id === 'm:m2')!;
    const sEnds = officeEdgeEnds(s, new Map([['dev', moved]]));
    assert.deepEqual([sEnds.from, sEnds.to], [l.door, l.board]);
  });
});

describe('acting', () => {
  test('every role state reads distinctly (act, else the plate pip for the idle ones)', () => {
    const acts = new Map<OfficeRoleState, string>();
    const roles = OFFICE_ROLE_STATES.map((s, k) => role(`r${k}`, 'developer', { enabled: s !== 'off-duty' }));
    const map = Object.fromEntries(OFFICE_ROLE_STATES.map((s, k) => [`r${k}`, s]));
    const l = layoutOffice(office(), roles, states(map), [], [], [], { now: NOW, columns: 3 });
    for (const a of l.avatars) acts.set(a.state, officePixelAct(a));
    assert.deepEqual(Object.fromEntries(acts), {
      'off-duty': 'dozing',
      scheduled: 'idle',
      guarded: 'asleep',
      'on-shift': 'typing',
      'in-huddle': 'huddle',
      'waiting-for-you': 'hand-up',
      'over-budget': 'greyed',
      paused: 'greyed',
    });
    assert.equal(officePixelAct({ pose: 'huddling', state: 'in-huddle' }), 'huddle');
    // an enabled on-call off-duty role is idle like a scheduled one — the state pip tells them apart
    assert.equal(officePixelAct({ pose: 'idle', state: 'off-duty' }), 'idle');
  });

  test('the guard bubble carries the skip reason only', () => {
    assert.equal(officeSkipReason('skip: no commits since the last shift · next tomorrow 09:00'), 'no commits since the last shift');
    assert.equal(officeSkipReason('skip: open tasks ≥ 3'), 'open tasks ≥ 3');
    assert.equal(officeSkipReason(''), '');
  });
});
