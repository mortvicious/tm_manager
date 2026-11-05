// docs/office.md § Director features → Ask the Director — over a temp SQLite
// DB with a fake shift starter (no claude): POST /api/offices/:id/ask-feature
// wakes the Director once with trigger `request`, ref FEATURE_ASK_REF and the
// text as the note; it is 403 without Origin, 400 on empty text, 409 without a
// Director or with the open-feature cap reached; the Director's prompt asks
// for the `feature` section; GET /api/offices/:id links a shift to the feature
// its `office.feature` row names (`shiftFeatures`).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { after, before, describe, test } from 'node:test';
import { FEATURE_ASK_REF, type Office, type OfficeDetail, type OfficeFeatureAskResult, type OfficeRole } from '@tm/shared';
import { SqliteStorage } from '../storage/sqlite.ts';
import type { NewOfficeRole } from '../storage/office-sql.ts';
import { registerOfficeRoutes } from '../routes/offices.ts';
import { OfficeScheduler, type ShiftStarter } from './scheduler.ts';
import { ShiftRunner, type ShiftStart, type ShiftTriggerInput } from './shift.ts';
import { OFFICE_OPEN_FEATURES_MAX } from './features.ts';

let tmp = '';
let storage: SqliteStorage;
let repoId = '';
let n = 0;

class FakeStarter implements ShiftStarter {
  calls: { roleId: string; trigger: ShiftTriggerInput }[] = [];
  async start(office: Office, role: OfficeRole, trigger: ShiftTriggerInput): Promise<ShiftStart> {
    this.calls.push({ roleId: role.id, trigger });
    const at = new Date().toISOString();
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

async function office(): Promise<Office> {
  n += 1;
  const ws = await storage.createWorkspace({ name: `ws${n}`, slug: `ask-${n}`, repoIds: [repoId], color: null });
  const folderPath = path.join(tmp, `office-${n}`);
  fs.mkdirSync(folderPath, { recursive: true });
  return storage.createOffice({ workspaceId: ws.id, folderPath, timezone: 'UTC', enabled: true, dayBudgetUsd: 5 });
}

const role = (officeId: string, over: Partial<NewOfficeRole> = {}): Promise<OfficeRole> =>
  storage.createOfficeRole({
    officeId,
    key: `r${++n}`,
    name: `Role ${n}`,
    avatar: '🧭',
    title: 'Director',
    prompt: 'plan the work',
    model: 'claude-opus-5-5',
    tools: ['Read'],
    schedules: [],
    triggers: [],
    guards: [],
    notesPath: `roles/r${n}.md`,
    preset: 'director',
    ...over,
  });

describe('Ask the Director for a feature', () => {
  let app: FastifyInstance;
  let starter: FakeStarter;
  const ORIGIN = { origin: 'http://127.0.0.1:5173' };

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-office-ask-'));
    storage = new SqliteStorage(path.join(tmp, 'tm.db'));
    await storage.migrate();
    repoId = (await storage.createRepo({ name: 'r', path: tmp } as any)).id;
    starter = new FakeStarter();
    const sched = new OfficeScheduler({ storage, shifts: () => starter, broadcast: () => {}, log: () => {} });
    app = Fastify();
    app.setErrorHandler((err, _req, reply) =>
      reply.code(err instanceof ZodError ? 400 : 500).send({ error: err instanceof ZodError ? err.issues.map((i) => i.message).join('; ') : String(err) }),
    );
    registerOfficeRoutes(app, storage, { scheduler: () => sched });
    await app.ready();
  });

  after(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('wakes the Director once with the text as a trusted request note', async () => {
    const o = await office();
    const d = await role(o.id);
    const url = `/api/offices/${o.id}/ask-feature`;
    assert.equal((await app.inject({ method: 'POST', url, payload: { text: 'x' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url, payload: { text: '  ' }, headers: ORIGIN })).statusCode, 400);
    assert.equal(starter.calls.length, 0);
    const res = await app.inject({ method: 'POST', url, payload: { text: 'Single sign-on across the apps' }, headers: ORIGIN });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as OfficeFeatureAskResult;
    assert.equal(body.roleId, d.id);
    assert.equal(starter.calls.length, 1);
    const t = starter.calls[0].trigger;
    assert.equal(t.kind, 'request');
    assert.equal(t.ref, FEATURE_ASK_REF);
    assert.equal(t.note, 'Single sign-on across the apps');
    const wake = (await storage.listEvents({ kind: 'office.wake' })).find((e) => (e.data as { shiftId?: string }).shiftId === body.shiftId);
    assert.ok(wake, 'an office.wake row names the shift');
    assert.equal((wake!.data as { ref?: string }).ref, FEATURE_ASK_REF);
  });

  test('409 without a Director, and once the open-feature cap is reached', async () => {
    const o = await office();
    await role(o.id, { preset: 'qa', title: 'QA' });
    const url = `/api/offices/${o.id}/ask-feature`;
    const none = await app.inject({ method: 'POST', url, payload: { text: 'x' }, headers: ORIGIN });
    assert.equal(none.statusCode, 409);
    assert.match(none.json().error, /no Director/);
    await role(o.id);
    for (let i = 0; i < OFFICE_OPEN_FEATURES_MAX; i++) {
      await storage.createFeature({ repoId, title: `f${i}`, request: 'r', officeId: o.id }, 'test');
    }
    const before = starter.calls.length;
    const full = await app.inject({ method: 'POST', url, payload: { text: 'x' }, headers: ORIGIN });
    assert.equal(full.statusCode, 409);
    assert.match(full.json().error, /open features/);
    assert.equal(starter.calls.length, before);
  });

  test('the Director’s prompt asks for the feature section; another role keeps the plain request', async () => {
    const o = await office();
    const d = await role(o.id);
    const qa = await role(o.id, { preset: 'qa', title: 'QA' });
    const runner = new ShiftRunner({ storage, aux: () => ({}) as any });
    const trigger: ShiftTriggerInput = { kind: 'request', ref: FEATURE_ASK_REF, note: 'Build dark mode everywhere' };
    const prompt = await runner.prompt(o, d, trigger, await runner.plan(o, d, trigger, await storage.getSettings()), []);
    assert.match(prompt, /## Feature request/);
    assert.match(prompt, /`feature` result section/);
    assert.match(prompt, /Build dark mode everywhere/);
    assert.ok(!prompt.includes('## The request'));
    const other = await runner.prompt(o, qa, trigger, await runner.plan(o, qa, trigger, await storage.getSettings()), []);
    assert.ok(!other.includes('## Feature request'));
    assert.match(other, /## The request/);
  });

  test('GET /api/offices/:id links a shift to the feature it filed', async () => {
    const o = await office();
    const d = await role(o.id);
    const at = new Date().toISOString();
    const shift = await storage.appendShift({ officeId: o.id, roleId: d.id, trigger: { kind: 'request', ref: FEATURE_ASK_REF, at }, verdict: 'ran', startedAt: at, endedAt: at });
    const other = await storage.appendShift({ officeId: o.id, roleId: d.id, trigger: { kind: 'cron', ref: '0 9 * * *', at }, verdict: 'ran', startedAt: at, endedAt: at });
    const f = await storage.createFeature({ repoId, title: 'SSO', request: 'r', officeId: o.id }, 'test');
    await storage.appendEvent({ kind: 'office.feature', actor: 'office:x', data: { officeId: o.id, roleId: d.id, shiftId: shift.id, featureId: f.id } });
    // a dropped section (no featureId) and another office's row link nothing
    await storage.appendEvent({ kind: 'office.feature', actor: 'office:x', data: { officeId: o.id, roleId: d.id, shiftId: other.id, dropped: 'cap' } });
    await storage.appendEvent({ kind: 'office.feature', actor: 'office:x', data: { officeId: 'elsewhere', shiftId: other.id, featureId: f.id } });
    const detail = (await app.inject({ method: 'GET', url: `/api/offices/${o.id}` })).json() as OfficeDetail;
    assert.deepEqual(detail.shiftFeatures, { [shift.id]: f.id });
  });
});

test('featurePlanRepoIds: included cards, listing repo for a card without one, plan order, no repeats', async () => {
  const { featurePlanRepoIds } = await import('@tm/shared');
  const card = (repoId: string | null, excluded = false) => ({ id: 'c', title: 't', description: '', repoId, excluded }) as any;
  const plan = { summary: '', considerations: [], phases: [{ title: 'a', goal: '', tasks: [card('b'), card(null), card('x', true)] }, { title: 'b', goal: '', tasks: [card('a'), card('b')] }] } as any;
  assert.deepEqual(featurePlanRepoIds({ repoId: 'L', analysis: plan }), ['b', 'L', 'a']);
  assert.deepEqual(featurePlanRepoIds({ repoId: 'L', analysis: null }), []);
});
