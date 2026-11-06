// The top-down skins' projection and place names — Starship bridge and Fantasy
// guild hall (docs/office.md § Starship bridge / § Fantasy guild hall).
// Run: npm test   (node:test through tsx; pure, no git and no DB)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  OFFICE_DEPARTMENTS,
  OFFICE_SKIN_PLACES,
  OFFICE_THEME_IDS,
  layoutOffice,
  officeFlatProjection,
  officePlateName,
  officeScatter,
  type Office,
  type OfficeLayout,
  type OfficeMessage,
  type OfficeRole,
  type OfficeRolePreset,
  type OfficeRoleState,
  type OfficeStates,
  type OfficeViewPoint,
} from '@tm/shared';
import { generateOfficeIdentities } from './office/names.ts';

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

describe('flat projection', () => {
  test('the floor fits the width it was given, at a whole-px tile within bounds', () => {
    for (const [cols, width] of [
      [3, 1100],
      [3, 720],
      [2, 700],
      [1, 375],
      [1, 320],
    ] as const) {
      const l = lay(cols);
      const p = officeFlatProjection(l, width, { minTile: 12, maxTile: 26 });
      assert.ok(Number.isInteger(p.tile), `tile ${p.tile} is whole px`);
      assert.ok(p.tile >= 12 && p.tile <= 26, `tile ${p.tile} in bounds`);
      assert.ok(p.width <= width || p.tile === 12, `${cols} cols fit ${width}px (tile ${p.tile})`);
      assert.equal(p.width, l.width * p.tile);
      assert.equal(p.height, l.height * p.tile);
      for (const pt of points(l)) {
        const s = p.project(pt);
        assert.ok(s.x >= 0 && s.x <= p.width && s.y >= 0 && s.y <= p.height, `${JSON.stringify(pt)} → ${JSON.stringify(s)}`);
      }
    }
  });

  test('a phone keeps a legible tile; a wide frame does not blow the floor up', () => {
    assert.ok(officeFlatProjection(lay(1), 375, { minTile: 12, maxTile: 26 }).tile >= 20);
    assert.equal(officeFlatProjection(lay(3), 5000, { maxTile: 24 }).tile, 24);
    assert.equal(officeFlatProjection(lay(3), 0, { maxTile: 24 }).tile, 24, 'an unmeasured frame draws at the largest tile');
    // headroom above the top row: a bubble over a seated avatar stays on the floor
    const l = lay(3);
    const top = Math.min(...l.avatars.map((a) => a.seat.y));
    assert.ok(top >= 3, `seat ${top} tiles below the top edge`);
  });

  test('rects scale with points', () => {
    const p = officeFlatProjection(lay(3), 900);
    const r = p.rect({ x: 1, y: 2, w: 3, h: 4 });
    assert.deepEqual(r, { x: p.tile, y: 2 * p.tile, w: 3 * p.tile, h: 4 * p.tile });
  });
});

describe('themed places', () => {
  test('every theme names every department, the lobby and both hand-off ends', () => {
    for (const id of OFFICE_THEME_IDS) {
      const places = OFFICE_SKIN_PLACES[id];
      for (const d of OFFICE_DEPARTMENTS) assert.ok(places.rooms[d.id].trim(), `${id} names ${d.id}`);
      assert.ok(places.lobby && places.door && places.board, id);
    }
    assert.equal(OFFICE_SKIN_PLACES['pixel-office'].rooms.leadership, "Director's office", 'the Pixel office keeps the layout labels');
  });

  test('the bridge and the hall speak their own words, matching the generated names', () => {
    const bridge = OFFICE_SKIN_PLACES['starship-bridge'];
    const hall = OFFICE_SKIN_PLACES['fantasy-guild'];
    assert.equal(bridge.rooms.leadership, 'Command');
    assert.equal(hall.rooms.leadership, "Guildmaster's hall");
    const keys = ['director', 'developer', 'devops', 'qa', 'seo'];
    const crew = generateOfficeIdentities('o1', keys, 'starship-bridge');
    const guild = generateOfficeIdentities('o1', keys, 'fantasy-guild');
    assert.match(crew.director.name, /^Captain /);
    assert.match(crew.developer.name, /^Chief Engineer /);
    assert.match(guild.director.name, /^Guildmaster /);
    assert.match(guild.devops.name, / the Smith$/);
    assert.equal(hall.rooms.operations, 'Smithy', "the Smith works in the hall's smithy");
  });
});

describe('name plates', () => {
  test('a long themed name shows its given name; a short one shows whole', () => {
    assert.equal(officePlateName('Captain Vega'), 'Vega');
    assert.equal(officePlateName('Boss Pat'), 'Boss Pat');
    assert.equal(officePlateName('Chief Engineer Orion'), 'Orion');
    assert.equal(officePlateName('Thorin the Artificer'), 'Thorin');
    assert.equal(officePlateName('Guildmaster Elowen'), 'Elowen');
    assert.equal(officePlateName('Lt. Rhea'), 'Lt. Rhea');
    assert.equal(officePlateName('  Supercalifragilistic  '), 'Supercalifragilistic', 'one long word stays itself');
  });
});

describe('scatter', () => {
  test('deterministic, inside the area', () => {
    const a = officeScatter(42, 50, 300, 200);
    assert.deepEqual(a, officeScatter(42, 50, 300, 200));
    assert.notDeepEqual(a, officeScatter(43, 50, 300, 200));
    assert.equal(a.length, 50);
    for (const s of a) assert.ok(s.x >= 0 && s.x < 300 && s.y >= 0 && s.y < 200 && s.k >= 0 && s.k < 3);
    assert.equal(officeScatter(0, 3, 10, 10).length, 3, 'a zero seed still scatters');
  });
});
