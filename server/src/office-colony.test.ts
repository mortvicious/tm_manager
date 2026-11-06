// The Space colony skin's pure geometry: module lights, tube walks, culling (docs/office.md § Space colony).
// Run: npm test   (node:test through tsx; pure, no git and no DB)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  OFFICE_ROLE_STATES,
  colonyCull,
  colonyLampOf,
  colonyModuleLight,
  colonyRoute,
  colonyTubes,
  layoutOffice,
  officePixelAct,
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


const ALL = [...OFFICE_ROLE_STATES];

/** a point lies on the tube network (a row tube, a trunk or a hatch tube) */
function onTubes(l: OfficeLayout, p: OfficeViewPoint): boolean {
  const n = colonyTubes(l);
  const eq = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const within = (x: number, a: number, b: number) => x >= Math.min(a, b) - 1e-6 && x <= Math.max(a, b) + 1e-6;
  return (
    n.rows.some((r) => eq(p.y, r.y) && within(p.x, r.x0, r.x1)) ||
    n.trunks.some((k) => eq(p.x, k.x) && within(p.y, k.y0, k.y1)) ||
    n.hatches.some((h) => eq(p.x, h.x) && within(p.y, h.y0, h.y1))
  );
}

describe('module lights', () => {
  test('every role state lights its console, and the module shows the most urgent', () => {
    const lamps = new Set(ALL.map((s) => colonyLampOf({ state: s, pose: s === 'off-duty' ? 'dozing' : 'idle' })));
    assert.deepEqual([...lamps].sort(), ['active', 'alert', 'dark', 'fault', 'standby']);
    assert.equal(colonyLampOf({ state: 'off-duty', pose: 'idle' }), 'standby', 'on call reads standby, not dark');
    const l = layoutOffice(office(), [role('dev', 'developer'), role('qa', 'qa')], states({ dev: 'on-shift', qa: 'waiting-for-you' }), [], [], [], { now: NOW });
    const eng = l.rooms.find((r) => r.id === 'engineering')!;
    assert.equal(colonyModuleLight(eng, l.avatars), 'alert');
    const quiet = layoutOffice(office(), [role('dev', 'developer')], states({ dev: 'paused' }), [], [], [], { now: NOW });
    assert.equal(colonyModuleLight(quiet.rooms[0], quiet.avatars), 'fault');
    assert.equal(colonyModuleLight({ id: 'growth' }, quiet.avatars), 'dark', 'a module with no crew is dark');
  });

  test('each state keeps its own act (the shared acting)', () => {
    const acts = new Set(ALL.map((s) => officePixelAct({ state: s, pose: s === 'on-shift' ? 'working' : s === 'in-huddle' ? 'huddling' : s === 'waiting-for-you' ? 'waiting' : s === 'paused' || s === 'over-budget' ? 'blocked' : s === 'off-duty' ? 'dozing' : 'idle' })));
    assert.ok(acts.size >= 6);
  });
});

describe('walks', () => {
  for (const cols of [3, 2, 1]) {
    test(`a hand-off between modules walks the tubes (${cols} columns)`, () => {
      const msgs = [message('m1', 'dir', 'seo'), message('m2', 'dev', 'cust'), message('m3', null, 'ops'), message('m4', 'qa', null), message('m5', 'dev', 'qa')];
      const l = lay(cols, msgs);
      assert.ok(l.edges.length >= 5);
      for (const e of l.edges) {
        const route = colonyRoute(e, l);
        assert.ok(route.length >= 2, e.id);
        assert.deepEqual(route[0], e.fromAt);
        assert.deepEqual(route[route.length - 1], e.toAt);
        // every leg is straight along x or y, except the in-module first/last steps
        for (let i = 1; i < route.length; i++) assert.ok(route[i].x !== route[i - 1].x || route[i].y !== route[i - 1].y, 'no zero-length leg');
        const sameRoom = 'role' in e.from && 'role' in e.to && l.avatars.find((a) => a.roleId === (e.from as { role: string }).role)?.room === l.avatars.find((a) => a.roleId === (e.to as { role: string }).role)?.room;
        if (!sameRoom && route.length > 2) {
          // the inner points (past the hatch steps) are on the network or in the hub
          for (const p of route.slice(2, -2)) assert.ok(onTubes(l, p) || p.y >= l.lobby.y, `${e.id} ${JSON.stringify(p)}`);
        }
        for (const p of route) assert.ok(p.x >= 0 && p.x <= l.width && p.y >= 0 && p.y <= l.height, 'inside the map');
      }
    });
  }

  test('a walk follows the colonists to where ambient life has them', () => {
    const l = lay(3, [message('m1', 'dir', 'seo')]);
    const moved: OfficeViewPoint = { x: 40, y: 12 };
    const r = colonyRoute(l.edges[0], l, new Map([['seo', moved]]));
    assert.deepEqual(r[r.length - 1], moved);
  });
});

describe('culling', () => {
  test('null view shows everything; a view shows only what it touches', () => {
    const l = lay(3, [message('m1', 'dir', 'dev')]);
    const routes = new Map(l.edges.map((e) => [e.id, colonyRoute(e, l)]));
    const all = colonyCull(l, null, routes);
    assert.equal(all.rooms.size, l.rooms.length);
    assert.equal(all.avatars.size, l.avatars.length);
    assert.equal(all.hub, true);
    const first = l.rooms[0].rect;
    const part = colonyCull(l, { x: first.x, y: first.y, w: 4, h: 4 }, routes, undefined, 0);
    assert.deepEqual([...part.rooms], [l.rooms[0].id]);
    assert.equal(part.hub, false);
    assert.ok(part.avatars.size < l.avatars.length);
    const none = colonyCull(l, { x: -500, y: -500, w: 0, h: 0 }, routes, undefined, 0);
    assert.equal(none.rooms.size + none.avatars.size + none.edges.size, 0);
  });

  test('a big office draws a bounded slice', () => {
    const many = Array.from({ length: 60 }, (_, i) => role(`r${i}`, (['developer', 'qa', 'devops', 'seo', null] as const)[i % 5]));
    const l = layoutOffice(office(), many, states({}), [], [], [], { now: NOW, columns: 3 });
    const v = colonyCull(l, { x: 0, y: 0, w: 48, h: 8 }, new Map());
    assert.ok(l.height > 30, `tall: ${l.height}`);
    assert.ok(v.avatars.size < many.length / 2, `${v.avatars.size} of ${many.length}`);
  });
});
