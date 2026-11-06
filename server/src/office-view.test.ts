// The office view's pure layout (docs/office.md § The view).
// Run: npm test   (node:test through tsx; pure, no git and no DB)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  OFFICE_THEME_IDS,
  layoutOffice,
  officeDepartment,
  officeThemeId,
  officeWanderSpot,
  type AuditEvent,
  type HistoryStep,
  type Office,
  type OfficeBrief,
  type OfficeHuddle,
  type OfficeMessage,
  type OfficeRole,
  type OfficeRolePreset,
  type OfficeRoleState,
  type OfficeShift,
  type OfficeStates,
} from '@tm/shared';
import { OFFICE_THEMES, officeTheme } from './office/names.ts';

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

const shift = (id: string, roleId: string, extra: Partial<OfficeShift> = {}): OfficeShift => ({
  id,
  officeId: 'o1',
  roleId,
  trigger: { kind: 'cron', ref: '0 9 * * *', at: ago(60) },
  verdict: 'ran',
  skipReason: null,
  skipCode: null,
  runId: `run-${id}`,
  costUsd: 0.25,
  tainted: false,
  taintSources: [],
  briefId: null,
  filedTaskIds: [],
  filing: null,
  commands: null,
  startedAt: ago(60),
  endedAt: ago(50),
  error: null,
  ...extra,
});

const message = (id: string, from: string | null, to: string | null, createdAt: string, extra: Partial<OfficeMessage> = {}): OfficeMessage => ({
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
  createdAt,
  ...extra,
});

const huddle = (id: string, roleIds: string[], extra: Partial<OfficeHuddle> = {}): OfficeHuddle => ({
  id,
  officeId: 'o1',
  subject: { kind: 'task', id: 't1' },
  roleIds,
  turns: 1,
  maxTurns: 4,
  status: 'open',
  decision: null,
  taintedAt: null,
  createdAt: ago(5),
  updatedAt: ago(2),
  closedAt: null,
  ...extra,
});

const ROLES = [role('dir', 'director'), role('dev', 'developer'), role('qa', 'qa'), role('ops', 'devops'), role('seo', 'seo'), role('cust', null)];

describe('themes', () => {
  test('an unknown theme reads as the default; the server names the same ids', () => {
    assert.equal(officeThemeId(null), 'pixel-office');
    assert.equal(officeThemeId('nope'), 'pixel-office');
    assert.equal(officeThemeId('fantasy-guild'), 'fantasy-guild');
    assert.deepEqual([...OFFICE_THEMES], [...OFFICE_THEME_IDS]);
    assert.equal(officeTheme('nope'), 'pixel-office');
  });
});

describe('rooms', () => {
  test('one room per department with roles, in department order, desks in role order', () => {
    const l = layoutOffice(office(), ROLES, null, [], [], [], { now: NOW, columns: 3 });
    assert.deepEqual(
      l.rooms.map((r) => r.id),
      ['leadership', 'engineering', 'operations', 'growth', 'commons'],
    );
    assert.deepEqual(
      l.rooms[1].desks.map((d) => d.roleId),
      ['dev', 'qa'],
    );
    assert.equal(officeDepartment({ preset: null }), 'commons');
    // three to a row: the second row starts below the first
    assert.equal(l.rooms[0].rect.y, l.rooms[2].rect.y);
    assert.ok(l.rooms[3].rect.y > l.rooms[0].rect.y + l.rooms[0].rect.h - 1);
    // rooms never overlap and sit inside the floor; the lobby is below them all
    for (const a of l.rooms) {
      assert.ok(a.rect.x >= 0 && a.rect.x + a.rect.w <= l.width);
      assert.ok(a.rect.y + a.rect.h <= l.lobby.y);
      for (const b of l.rooms) {
        if (a === b) continue;
        const apart = a.rect.x + a.rect.w <= b.rect.x || b.rect.x + b.rect.w <= a.rect.x || a.rect.y + a.rect.h <= b.rect.y || b.rect.y + b.rect.h <= a.rect.y;
        assert.ok(apart, `${a.id} overlaps ${b.id}`);
      }
    }
    assert.ok(l.lobby.y + l.lobby.h <= l.height);
  });

  test('one column stacks the rooms vertically (the phone)', () => {
    const l = layoutOffice(office(), ROLES, null, [], [], [], { now: NOW, columns: 1 });
    const xs = new Set(l.rooms.map((r) => r.rect.x));
    assert.equal(xs.size, 1);
    for (let i = 1; i < l.rooms.length; i++) assert.ok(l.rooms[i].rect.y > l.rooms[i - 1].rect.y);
  });

  test('a fourth desk starts a second desk row and makes the room taller', () => {
    const many = [role('a', 'developer'), role('b', 'developer'), role('c', 'developer'), role('d', 'developer')];
    const l = layoutOffice(office(), many, null, [], [], [], { now: NOW, columns: 3 });
    const one = layoutOffice(office(), many.slice(0, 3), null, [], [], [], { now: NOW, columns: 3 });
    assert.ok(l.rooms[0].rect.h > one.rooms[0].rect.h);
    assert.ok(l.rooms[0].desks[3].seat.y > l.rooms[0].desks[0].seat.y);
  });

  test('an office with no roles is an empty floor with a lobby', () => {
    const l = layoutOffice(office(), [], null, [], [], [], { now: NOW });
    assert.deepEqual(l.rooms, []);
    assert.deepEqual(l.avatars, []);
    assert.ok(l.width > 0 && l.height > l.lobby.h);
  });
});

describe('avatars', () => {
  test('each state maps to a pose; only idle avatars wander', () => {
    const l = layoutOffice(
      office(),
      ROLES,
      states({ dir: 'on-shift', dev: 'waiting-for-you', qa: 'scheduled', ops: 'over-budget', seo: 'paused', cust: 'guarded' }),
      [],
      [],
      [],
      { now: NOW },
    );
    const pose = Object.fromEntries(l.avatars.map((a) => [a.roleId, a.pose]));
    assert.deepEqual(pose, { dir: 'working', dev: 'waiting', qa: 'idle', ops: 'blocked', seo: 'blocked', cust: 'idle' });
    assert.deepEqual(
      l.avatars.filter((a) => a.wanders).map((a) => a.roleId),
      ['qa', 'cust'],
    );
    assert.equal(l.avatars[0].detail, 'on-shift detail');
  });

  test('off-duty dozes only when the role or the office is off; on call is idle', () => {
    const roles = [role('a', 'developer'), role('b', 'developer', { enabled: false })];
    const l = layoutOffice(office(), roles, states({ a: 'off-duty', b: 'off-duty' }), [], [], [], { now: NOW });
    assert.deepEqual(
      l.avatars.map((a) => a.pose),
      ['idle', 'dozing'],
    );
    const off = layoutOffice(office({ enabled: false }), roles, states({ a: 'off-duty', b: 'off-duty' }), [], [], [], { now: NOW });
    assert.deepEqual(
      off.avatars.map((a) => a.pose),
      ['dozing', 'dozing'],
    );
  });

  test('without states every role reads off-duty', () => {
    const l = layoutOffice(office(), ROLES, null, [], [], [], { now: NOW });
    assert.ok(l.avatars.every((a) => a.state === 'off-duty'));
  });

  test('live and last shift, last brief, colour slot', () => {
    const shifts = [
      shift('s1', 'dev', { startedAt: ago(120), endedAt: ago(110) }),
      shift('s2', 'dev', { startedAt: ago(10), endedAt: null }),
      shift('s3', 'dev', { verdict: 'skipped', startedAt: ago(1), endedAt: ago(1), runId: null }),
    ];
    const briefs: OfficeBrief[] = [
      { id: 'b1', officeId: 'o1', roleId: 'dev', shiftId: 's1', kind: 'brief', path: 'x', summary: 'old', taintedAt: null, reviewedAt: null, createdAt: ago(110) },
      { id: 'b2', officeId: 'o1', roleId: 'dev', shiftId: 's1', kind: 'brief', path: 'y', summary: 'new', taintedAt: ago(5), reviewedAt: null, createdAt: ago(5) },
    ];
    const l = layoutOffice(office(), ROLES, null, shifts, [], [], { now: NOW, briefs });
    const dev = l.avatars.find((a) => a.roleId === 'dev')!;
    assert.equal(dev.liveShift?.id, 's2');
    assert.equal(dev.lastShift?.id, 's2');
    assert.equal(dev.lastShift?.runId, 'run-s2');
    assert.deepEqual(dev.lastBrief, { id: 'b2', summary: 'new', createdAt: ago(5), tainted: true });
    assert.ok(dev.colorSlot >= 1 && dev.colorSlot <= 7);
    const again = layoutOffice(office(), ROLES, null, shifts, [], [], { now: NOW, briefs });
    assert.deepEqual(again, l, 'pure: the same inputs give the same layout');
  });

  test('huddle members sit at a table in the first participant’s room; a paused member stays at its desk', () => {
    const l = layoutOffice(office(), ROLES, states({ dev: 'in-huddle', ops: 'in-huddle', seo: 'paused' }), [], [], [huddle('h1', ['dev', 'ops', 'seo'])], { now: NOW });
    const eng = l.rooms.find((r) => r.id === 'engineering')!;
    assert.ok(eng.table);
    assert.deepEqual(eng.huddleIds, ['h1']);
    const dev = l.avatars.find((a) => a.roleId === 'dev')!;
    const ops = l.avatars.find((a) => a.roleId === 'ops')!;
    const seo = l.avatars.find((a) => a.roleId === 'seo')!;
    assert.equal(dev.pose, 'huddling');
    assert.equal(ops.pose, 'huddling');
    assert.equal(ops.huddleId, 'h1');
    assert.notDeepEqual(ops.at, ops.seat, 'walked over to the table');
    assert.ok(ops.at.x >= eng.rect.x && ops.at.x <= eng.rect.x + eng.rect.w, 'in the host room');
    assert.equal(seo.pose, 'blocked');
    assert.deepEqual(seo.at, seo.seat);
    assert.equal(seo.huddleId, null);
  });

  test('a closed huddle seats nobody', () => {
    const l = layoutOffice(office(), ROLES, null, [], [], [huddle('h1', ['dev', 'ops'], { status: 'decided', closedAt: ago(1) })], { now: NOW });
    assert.ok(l.avatars.every((a) => a.huddleId === null));
    assert.ok(l.rooms.every((r) => r.table === null));
  });
});

describe('hand-off edges', () => {
  test('recent messages are edges; old ones and huddle transcript are not', () => {
    const msgs = [
      message('m1', 'dev', 'dir', ago(5)),
      message('m2', null, 'dev', ago(10)), // the stakeholder, from the door
      message('m3', 'qa', null, ago(1)), // unrouted, on the board
      message('m4', 'dev', 'qa', ago(90)), // too old
      message('m5', 'dev', null, ago(1), { subject: { kind: 'huddle', id: 'h1' }, routedAt: ago(1) }), // transcript
    ];
    const l = layoutOffice(office(), ROLES, null, [], msgs, [], { now: NOW });
    assert.deepEqual(
      l.edges.map((e) => e.id),
      ['m:m1', 'm:m2', 'm:m3'],
    );
    const dev = l.avatars.find((a) => a.roleId === 'dev')!;
    const dir = l.avatars.find((a) => a.roleId === 'dir')!;
    assert.deepEqual(l.edges[0].fromAt, dev.at);
    assert.deepEqual(l.edges[0].toAt, dir.at);
    assert.deepEqual(l.edges[1].from, { place: 'door' });
    assert.deepEqual(l.edges[1].fromAt, l.door);
    assert.deepEqual(l.edges[2].toAt, l.board);
    assert.equal(l.edges[0].at, ago(5));
  });

  test('a forward is a route edge from the routing shift’s role; other routes draw none', () => {
    const msgs = [message('m1', 'qa', null, ago(20)), message('m2', 'ops', null, ago(20))];
    const shifts = [shift('sd', 'dir')];
    const routes = {
      m1: { messageId: 'm1', action: 'forward' as const, at: ago(3), shiftId: 'sd', tainted: false, toRoleId: 'dev' },
      m2: { messageId: 'm2', action: 'task' as const, at: ago(3), shiftId: 'sd', tainted: false, taskId: 't9' },
    };
    const l = layoutOffice(office(), ROLES, null, shifts, msgs, [], { now: NOW, routes });
    const route = l.edges.filter((e) => e.kind === 'route');
    assert.deepEqual(
      route.map((e) => [e.id, e.from, e.to]),
      [['r:m1', { role: 'dir' }, { role: 'dev' }]],
    );
  });

  test('an open huddle is a ring of edges between its seated members (one edge for two)', () => {
    const three = layoutOffice(office(), ROLES, null, [], [], [huddle('h1', ['dev', 'qa', 'ops'])], { now: NOW });
    assert.deepEqual(
      three.edges.map((e) => e.id),
      ['h:h1:0', 'h:h1:1', 'h:h1:2'],
    );
    assert.equal(three.edges[0].at, ago(2));
    const two = layoutOffice(office(), ROLES, null, [], [], [huddle('h1', ['dev', 'qa'])], { now: NOW });
    assert.equal(two.edges.length, 1);
  });

  test('an edge to a deleted role is dropped', () => {
    const l = layoutOffice(office(), ROLES, null, [], [message('m1', 'gone', 'dev', ago(1))], [], { now: NOW });
    assert.deepEqual(l.edges, []);
    assert.match(l.feed[0].text, /a former role/);
  });
});

describe('feed', () => {
  test('newest first across shifts, briefs, messages, huddles, events and task steps', () => {
    const shifts = [shift('s1', 'dev', { startedAt: ago(60), endedAt: ago(50), filedTaskIds: ['t1'] }), shift('s2', 'qa', { verdict: 'skipped', skipReason: 'quiet', startedAt: ago(40), endedAt: ago(40) })];
    const briefs: OfficeBrief[] = [{ id: 'b1', officeId: 'o1', roleId: 'dev', shiftId: 's1', kind: 'brief', path: 'x', summary: 'did things', taintedAt: null, reviewedAt: null, createdAt: ago(49) }];
    const msgs = [message('m1', 'dev', 'dir', ago(30))];
    const huddles = [huddle('h1', ['dev', 'qa'], { createdAt: ago(20), status: 'decided', closedAt: ago(15) })];
    const events: AuditEvent[] = [
      { id: 'e1', at: ago(10), kind: 'office.wake', actor: 'human', taskId: null, runId: null, repoId: null, data: { officeId: 'o1', roleId: 'dir' } },
      { id: 'e2', at: ago(9), kind: 'office.wake', actor: 'human', taskId: null, runId: null, repoId: null, data: { officeId: 'other', roleId: 'dir' } },
      { id: 'e3', at: ago(8), kind: 'office.shift', actor: 'system', taskId: null, runId: null, repoId: null, data: { officeId: 'o1' } },
    ];
    const step = (kind: HistoryStep['kind'], at: string, label: string): HistoryStep => ({ kind, at, end: at, durationMs: 0, costUsd: null, tokens: null, actor: null, label, detail: null, tone: 'good' });
    const taskSteps = [{ taskId: 't1', title: 'Fix login', roleId: 'dev', steps: [step('created', ago(48), 'created'), step('claimed', ago(5), 'claimed'), step('landed', ago(1), 'landed')] }];
    const l = layoutOffice(office(), ROLES, null, shifts, msgs, huddles, { now: NOW, briefs, events, taskSteps });
    assert.deepEqual(
      l.feed.map((f) => f.id),
      ['t:t1:landed:' + ago(1), 't:t1:claimed:' + ago(5), 'e:e1', 'h:h1:close', 'h:h1:open', 'm:m1', 's:s2:skip', 'b:b1', 's:s1:end', 's:s1:start'],
    );
    // other offices' rows, duplicate kinds (office.shift) and non-feed steps (created) are left out
    assert.ok(!l.feed.some((f) => f.id === 'e:e2' || f.id === 'e:e3' || f.id.includes(':created:')));
    assert.match(l.feed.find((f) => f.id === 's:s1:end')!.text, /filed 1 task/);
    assert.deepEqual(l.feed.find((f) => f.id === 'm:m1')!.roleIds, ['dev', 'dir']);
    assert.equal(l.feed.find((f) => f.id === 'm:m1')!.edgeId, 'm:m1');
    assert.equal(l.feed.find((f) => f.id === 't:t1:landed:' + ago(1))!.ref?.kind, 'task');
  });

  test('ties order by id descending; the limit keeps the newest', () => {
    const msgs = [message('a', 'dev', 'dir', ago(5)), message('b', 'dev', 'dir', ago(5)), message('c', 'dev', 'dir', ago(1))];
    const l = layoutOffice(office(), ROLES, null, [], msgs, [], { now: NOW, feedLimit: 2 });
    assert.deepEqual(
      l.feed.map((f) => f.id),
      ['m:c', 'm:b'],
    );
  });

  test('a failed shift reads bad with its error', () => {
    const l = layoutOffice(office(), ROLES, null, [shift('s1', 'dev', { error: 'timed out after 10 min' })], [], [], { now: NOW });
    const end = l.feed.find((f) => f.kind === 'shift-end')!;
    assert.equal(end.tone, 'bad');
    assert.match(end.text, /timed out/);
  });
});

describe('ambient life', () => {
  test('deterministic, inside the room, and only for wandering avatars', () => {
    const l = layoutOffice(office(), ROLES, states({ dev: 'scheduled', qa: 'scheduled', dir: 'on-shift' }), [], [], [], { now: NOW });
    const dev = l.avatars.find((a) => a.roleId === 'dev')!;
    const dir = l.avatars.find((a) => a.roleId === 'dir')!;
    const eng = l.rooms.find((r) => r.id === 'engineering')!;
    const seen = new Set<string>();
    for (let t = 0; t < 200; t++) {
      const s = officeWanderSpot(dev, l, t);
      assert.deepEqual(officeWanderSpot(dev, l, t), s);
      seen.add(s.activity);
      assert.ok(s.at.x >= eng.rect.x && s.at.x <= eng.rect.x + eng.rect.w, `x in room at tick ${t}`);
      assert.ok(s.at.y >= eng.rect.y && s.at.y <= eng.rect.y + eng.rect.h, `y in room at tick ${t}`);
      assert.deepEqual(officeWanderSpot(dir, l, t), { at: dir.at, activity: 'desk' });
    }
    assert.deepEqual([...seen].sort(), ['chat', 'coffee', 'desk', 'stroll']);
  });
});
