// docs/office.md § Scheduler and states — the office scheduler over a temp
// SQLite DB with an injected clock and a fake shift starter (no claude): a
// due slot wakes once with trigger `cron`, a guard skip writes a skipped row
// and ONE coalesced office.shift-skipped event, a six-hour sleep wakes each
// role once, a busy office defers instead of skipping, the role states, the
// re-arm rule, and Wake now (403 without Origin, 409 with the hard-gate
// reason, guards skipped, the note handed over).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { after, before, describe, test } from 'node:test';
import type { Office, OfficeRole, ServerEvent } from '@tm/shared';
import { roleRearms } from '@tm/shared';
import { SqliteStorage } from '../storage/sqlite.ts';
import type { NewOfficeRole } from '../storage/office-sql.ts';
import { registerOfficeRoutes } from '../routes/offices.ts';
import { OFFICE_SKIP_COALESCE_MS, OfficeScheduler, officeStates, type ShiftStarter } from './scheduler.ts';
import type { ShiftStart, ShiftTriggerInput } from './shift.ts';

let tmp = '';
let storage: SqliteStorage;
let repoId = '';
let n = 0;

const T = (s: string) => Date.parse(s);
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Records every start and writes the shift row the real runner would (ended at once, so slots stay free). */
class FakeStarter implements ShiftStarter {
  calls: { officeId: string; roleId: string; trigger: ShiftTriggerInput }[] = [];
  refuse: { code: 'office-busy' | 'folder'; reason: string } | null = null;
  constructor(private clock: () => number) {}
  async start(office: Office, role: OfficeRole, trigger: ShiftTriggerInput): Promise<ShiftStart> {
    if (this.refuse) return { ok: false, ...this.refuse };
    this.calls.push({ officeId: office.id, roleId: role.id, trigger });
    const at = new Date(this.clock()).toISOString();
    const s = await storage.appendShift({
      officeId: office.id,
      roleId: role.id,
      trigger: { kind: trigger.kind, ref: trigger.ref ?? null, at: trigger.at ?? at },
      verdict: 'ran',
      startedAt: at,
      endedAt: at,
    });
    return { ok: true, shiftId: s.id, done: new Promise(() => {}) };
  }
}

function harness(start: number) {
  let now = start;
  const clock = () => now;
  const starter = new FakeStarter(clock);
  const sent: ServerEvent[] = [];
  const sched = new OfficeScheduler({ storage, shifts: () => starter, now: clock, broadcast: (m) => sent.push(m), log: () => {} });
  return { sched, starter, sent, set: (t: number) => (now = t), advance: (ms: number) => (now += ms), clock };
}

async function office(over: Partial<Parameters<SqliteStorage['createOffice']>[0]> = {}): Promise<Office> {
  n += 1;
  const ws = await storage.createWorkspace({ name: `ws${n}`, slug: `ws-${n}`, repoIds: [repoId], color: null });
  return storage.createOffice({ workspaceId: ws.id, folderPath: path.join(tmp, `office-${n}`), timezone: 'UTC', enabled: true, dayBudgetUsd: 5, ...over });
}

const role = (officeId: string, over: Partial<NewOfficeRole> = {}): Promise<OfficeRole> =>
  storage.createOfficeRole({
    officeId,
    key: `r${++n}`,
    name: `Role ${n}`,
    avatar: '🧪',
    title: 'QA',
    prompt: 'find bugs',
    model: 'claude-opus-5-5',
    tools: ['Read'],
    schedules: ['0 9 * * *'],
    triggers: [],
    guards: [],
    notesPath: 'roles/qa.md',
    armedAt: '2026-11-05T00:00:00.000Z',
    ...over,
  });

const skipEvents = async (roleId: string) =>
  (await storage.listEvents({ kind: 'office.shift-skipped', limit: 1000 })).filter((e) => (e.data as { roleId?: string }).roleId === roleId);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-office-sched-'));
  storage = new SqliteStorage(path.join(tmp, 'tm.db'));
  await storage.migrate();
  repoId = (await storage.createRepo({ name: 'r', path: tmp } as any)).id;
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('office scheduler', () => {
  test('a due cron slot wakes the role once, recorded as trigger cron', async () => {
    const o = await office();
    const r = await role(o.id);
    const h = harness(T('2026-11-05T08:59:30Z'));
    assert.equal((await h.sched.tick()).woken.length, 0, 'before the slot');
    h.set(T('2026-11-05T09:00:20Z'));
    const rep = await h.sched.tick();
    assert.equal(rep.woken.length, 1);
    assert.equal(h.starter.calls.length, 1);
    const [shift] = await storage.listShifts({ roleId: r.id });
    assert.equal(shift!.trigger.kind, 'cron');
    assert.equal(shift!.trigger.ref, '0 9 * * *');
    assert.equal(shift!.trigger.at, '2026-11-05T09:00:00.000Z');
    h.advance(MIN);
    await h.sched.tick();
    assert.equal(h.starter.calls.length, 1, 'the slot is not owed twice');
    // a fresh process (restart) reads lastSlot back from the shift rows
    const h2 = harness(T('2026-11-05T09:05:00Z'));
    await h2.sched.tick();
    assert.equal(h2.starter.calls.length, 0);
  });

  test('a guard skip writes a skipped row and one coalesced office.shift-skipped event', async () => {
    const o = await office();
    const r = await role(o.id, { schedules: ['* * * * *'], guards: [{ kind: 'quiet-hours', from: '00:00', to: '23:59' }] });
    const h = harness(T('2026-11-05T10:00:10Z'));
    const rep = await h.sched.tick();
    assert.equal(rep.skipped.length, 1);
    assert.equal(h.starter.calls.length, 0);
    const [s] = await storage.listShifts({ roleId: r.id });
    assert.equal(s!.verdict, 'skipped');
    assert.equal(s!.skipCode, 'guard');
    assert.match(s!.skipReason ?? '', /quiet hours/);
    assert.ok(s!.endedAt);
    let ev = await skipEvents(r.id);
    assert.equal(ev.length, 1);
    assert.match(String((ev[0]!.data as { reason: string }).reason), /quiet hours/);
    assert.equal((ev[0]!.data as { guard: string }).guard, 'quiet-hours');
    for (let i = 0; i < 5; i++) {
      h.advance(MIN);
      await h.sched.tick();
    }
    assert.equal((await storage.listShifts({ roleId: r.id, verdict: 'skipped' })).length, 6, 'one row per slot');
    assert.equal((await skipEvents(r.id)).length, 1, 'a minute tick never floods the log');
    h.set(T('2026-11-05T10:00:10Z') + OFFICE_SKIP_COALESCE_MS + MIN);
    await h.sched.tick();
    ev = await skipEvents(r.id);
    assert.equal(ev.length, 2, 'a new hour writes a new row');
    assert.equal((ev[0]!.data as { suppressed?: number }).suppressed, 5, 'it says how many were folded');
  });

  test('after a simulated 6-hour sleep each role runs once, not once per missed slot', async () => {
    const o = await office({ maxSlots: 3 });
    const armedAt = '2026-11-04T23:50:00.000Z';
    const hourly = await role(o.id, { schedules: ['0 * * * *'], armedAt });
    const quarter = await role(o.id, { schedules: ['*/15 * * * *'], armedAt });
    const h = harness(T('2026-11-05T00:00:30Z'));
    await h.sched.tick();
    assert.equal(h.starter.calls.length, 2);
    h.set(T('2026-11-05T06:07:00Z')); // asleep through 6 hourly and 24 quarter slots
    const rep = await h.sched.tick();
    assert.equal(rep.woken.length, 2);
    assert.deepEqual(
      rep.woken.map((w) => [w.roleId, w.at, w.missed]).sort(),
      [
        [hourly.id, '2026-11-05T06:00:00.000Z', 6],
        [quarter.id, '2026-11-05T06:00:00.000Z', 24],
      ].sort(),
    );
    await h.sched.tick();
    assert.equal(h.starter.calls.length, 4, 'no backlog after the catch-up');
  });

  test('a busy office defers the slot instead of skipping it', async () => {
    const o = await office();
    const r = await role(o.id);
    const h = harness(T('2026-11-05T09:00:05Z'));
    h.starter.refuse = { code: 'office-busy', reason: 'a shift of this office is already running' };
    const rep = await h.sched.tick();
    assert.equal(rep.deferred.filter((d) => d.roleId === r.id).length, 1);
    assert.equal((await storage.listShifts({ roleId: r.id })).length, 0, 'no row: the slot is still owed');
    h.starter.refuse = null;
    h.advance(MIN);
    const woken = (await h.sched.tick()).woken.filter((w) => w.roleId === r.id);
    assert.equal(woken.length, 1);
    assert.equal(woken[0]!.at, '2026-11-05T09:00:00.000Z');
  });

  test('a paused office skips with the hard-gate reason; a runner refusal skips too', async () => {
    const o = await office();
    const r = await role(o.id);
    await storage.pauseOffice(o.id, 'holiday', false);
    const h = harness(T('2026-11-05T09:00:05Z'));
    const rep = await h.sched.tick();
    assert.equal(rep.skipped[0]!.code, 'office-paused');
    assert.equal((await storage.listShifts({ roleId: r.id }))[0]!.skipReason, 'office paused: holiday');
    const o2 = await office();
    const r2 = await role(o2.id);
    h.starter.refuse = { code: 'folder', reason: 'office folder /x does not exist' };
    await h.sched.tick();
    assert.equal((await storage.listShifts({ roleId: r2.id }))[0]!.skipCode, 'folder');
  });

  test('a disabled office or role never wakes; a slot before armedAt was never owed', async () => {
    const off = await office({ enabled: false, dayBudgetUsd: 5 });
    const r1 = await role(off.id);
    const o = await office();
    const r2 = await role(o.id, { enabled: false });
    const r3 = await role(o.id, { armedAt: '2026-11-05T09:30:00.000Z' });
    const h = harness(T('2026-11-05T10:00:00Z'));
    await h.sched.tick();
    for (const r of [r1, r2, r3]) assert.equal((await storage.listShifts({ roleId: r.id })).length, 0);
  });

  test('role states: scheduled (next HH:MM) and guarded (skip: …), broadcast in office.updated', async () => {
    const o = await office();
    const plain = await role(o.id);
    const guarded = await role(o.id, { schedules: ['0 * * * *'], guards: [{ kind: 'quiet-hours', from: '00:00', to: '23:59' }] });
    const h = harness(T('2026-11-05T08:00:30Z'));
    await h.sched.tick();
    const st = await officeStates(storage, o.id, h.clock());
    const of = (id: string) => st!.states.find((s) => s.roleId === id)!;
    assert.deepEqual([of(plain.id).state, of(plain.id).detail], ['scheduled', 'next 09:00']);
    assert.equal(of(plain.id).nextSlotAt, '2026-11-05T09:00:00.000Z');
    assert.equal(of(guarded.id).state, 'guarded');
    assert.match(of(guarded.id).detail, /^skip: quiet hours \(00:00–23:59\) · next 09:00$/);
    const upd = h.sent.filter((e) => e.type === 'office.updated' && e.office.id === o.id);
    assert.equal(upd.length, 1);
    assert.ok(upd[0]!.type === 'office.updated' && upd[0]!.states?.states.length === 2);
    await h.sched.tick();
    assert.equal(h.sent.filter((e) => e.type === 'office.updated' && e.office.id === o.id).length, 1, 'unchanged states are not re-sent');
  });

  test('roleRearms: on enable and on a schedule change only', () => {
    const cur = { enabled: false, schedules: ['0 9 * * *'] };
    assert.equal(roleRearms(cur, { enabled: true }), true);
    assert.equal(roleRearms({ ...cur, enabled: true }, { enabled: true }), false);
    assert.equal(roleRearms(cur, { schedules: [' 0 9 * * *'] }), false);
    assert.equal(roleRearms(cur, { schedules: ['0 10 * * *'] }), true);
    assert.equal(roleRearms(cur, { enabled: false }), false);
  });
});

describe('Wake now', () => {
  let app: FastifyInstance;
  let h: ReturnType<typeof harness>;
  const ORIGIN = { origin: 'http://127.0.0.1:5173' };

  before(async () => {
    h = harness(Date.now());
    app = Fastify();
    registerOfficeRoutes(app, storage, { scheduler: () => h.sched });
    await app.ready();
  });
  after(async () => {
    await app.close();
  });

  test('403 without Origin, 409 with the hard-gate reason when paused, 202 past the guards with the note', async () => {
    const o = await office();
    const r = await role(o.id, { guards: [{ kind: 'quiet-hours', from: '00:00', to: '23:59' }, { kind: 'cooldown', minutes: 600 }] });
    const url = `/api/offices/${o.id}/roles/${r.id}/wake`;
    let res = await app.inject({ method: 'POST', url, payload: { note: 'check the login page' } });
    assert.equal(res.statusCode, 403);

    await storage.pauseOffice(o.id, 'holiday', false);
    res = await app.inject({ method: 'POST', url, payload: {}, headers: ORIGIN });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'office paused: holiday');
    assert.equal(res.json().code, 'office-paused');
    assert.equal(h.starter.calls.length, 0);

    await storage.pauseOffice(o.id, null, true);
    res = await app.inject({ method: 'POST', url, payload: { note: '  check the login page ' }, headers: ORIGIN });
    assert.equal(res.statusCode, 202);
    const call = h.starter.calls.at(-1)!;
    assert.equal(call.trigger.kind, 'request');
    assert.equal(call.trigger.note, 'check the login page');
    assert.equal(res.json().shiftId, (await storage.listShifts({ roleId: r.id }))[0]!.id);
    const wakeRows = (await storage.listEvents({ kind: 'office.wake' })).filter((e) => (e.data as { roleId: string }).roleId === r.id);
    assert.equal(wakeRows.length, 1);
    assert.equal(wakeRows[0]!.actor, 'human');

    res = await app.inject({ method: 'POST', url: `/api/offices/${o.id}/roles/nope/wake`, payload: {}, headers: ORIGIN });
    assert.equal(res.statusCode, 404);
  });

  test('GET /api/offices/:id/states', async () => {
    const o = await office();
    await role(o.id);
    const res = await app.inject({ method: 'GET', url: `/api/offices/${o.id}/states` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().states.length, 1);
    assert.equal((await app.inject({ method: 'GET', url: '/api/offices/nope/states' })).statusCode, 404);
  });
});
