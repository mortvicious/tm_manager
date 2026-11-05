// docs/office.md § Wishes and vision — over a temp SQLite DB with an injected
// clock and a fake shift starter (no claude): a wish is stored and starts ONE
// Director shift with trigger `request`; a vision save with a change wakes the
// Director and an unchanged one does not; a hand edit to priorities.md is
// noticed by the tick and wakes it ONCE (and not again after a restart); a
// busy slot leaves the wake pending for the next tick; the routes are 403
// without Origin; the `roadmap` / `wishUpdates` sections and the re-plan prompt.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Office, OfficeDocPutResult, OfficeRole, OfficeWishCreateResult } from '@tm/shared';
import { SqliteStorage } from '../storage/sqlite.ts';
import type { NewOfficeRole } from '../storage/office-sql.ts';
import { registerOfficeRoutes } from '../routes/offices.ts';
import { OfficeScheduler, type ShiftStarter } from './scheduler.ts';
import { ShiftRunner, type ShiftStart, type ShiftTriggerInput } from './shift.ts';
import { checkOfficeDocs, createOfficeWish, pendingDirectorWake, resetOfficeDocsMemory, saveOfficeDoc } from './docs.ts';
import { applyShiftResult } from './shift-result.ts';
import { untrustedPath } from './isolation.ts';

let tmp = '';
let storage: SqliteStorage;
let repoId = '';
let n = 0;

class FakeStarter implements ShiftStarter {
  calls: { roleId: string; trigger: ShiftTriggerInput }[] = [];
  refuse: { code: 'office-busy'; reason: string } | null = null;
  async start(office: Office, role: OfficeRole, trigger: ShiftTriggerInput): Promise<ShiftStart> {
    if (this.refuse) return { ok: false, ...this.refuse };
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

function harness() {
  const starter = new FakeStarter();
  const sched = new OfficeScheduler({ storage, shifts: () => starter, broadcast: () => {}, log: () => {} });
  return { sched, starter, deps: { storage, waker: sched } };
}

async function office(): Promise<Office> {
  n += 1;
  const ws = await storage.createWorkspace({ name: `ws${n}`, slug: `ws-${n}`, repoIds: [repoId], color: null });
  const folderPath = path.join(tmp, `office-${n}`);
  fs.mkdirSync(folderPath, { recursive: true });
  fs.writeFileSync(path.join(folderPath, 'vision.md'), '# Vision\n\nShip it.\n');
  fs.writeFileSync(path.join(folderPath, 'priorities.md'), '# Priorities\n');
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
    notesPath: 'roles/director.md',
    preset: 'director',
    ...over,
  });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-office-docs-'));
  storage = new SqliteStorage(path.join(tmp, 'tm.db'));
  await storage.migrate();
  repoId = (await storage.createRepo({ name: 'r', path: tmp } as any)).id;
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => resetOfficeDocsMemory());

describe('wishes and vision', () => {
  test('a wish is stored and starts one Director shift with trigger request', async () => {
    const o = await office();
    const d = await role(o.id);
    await role(o.id, { preset: 'qa', key: 'qa1', title: 'QA' });
    const h = harness();
    const r = await createOfficeWish(h.deps, o, '  Dark mode on the dashboard  ');
    assert.equal(r.wish.text, 'Dark mode on the dashboard');
    assert.equal(r.wish.status, 'open');
    assert.ok(r.wake.ok);
    assert.equal(h.starter.calls.length, 1);
    assert.equal(h.starter.calls[0]!.roleId, d.id);
    assert.equal(h.starter.calls[0]!.trigger.kind, 'request');
    assert.equal(h.starter.calls[0]!.trigger.ref, `wish:${r.wish.id}`);
    assert.deepEqual((await storage.listWishes({ officeId: o.id })).map((w) => w.id), [r.wish.id]);
    const wake = (await storage.listEvents({ kind: 'office.wake' })).find((e) => (e.data as any).wishId === r.wish.id);
    assert.ok(wake, 'office.wake row carries the wish');
  });

  test('saving vision.md with a change wakes the Director; unchanged does not', async () => {
    const o = await office();
    await role(o.id);
    const h = harness();
    const changed = await saveOfficeDoc(h.deps, o, 'vision.md', '# Vision\n\nShip it faster.');
    assert.equal(changed.changed, true);
    assert.ok(changed.wake?.ok);
    assert.equal(fs.readFileSync(path.join(o.folderPath, 'vision.md'), 'utf8'), '# Vision\n\nShip it faster.\n');
    assert.equal(h.starter.calls.length, 1);
    assert.equal(h.starter.calls[0]!.trigger.ref, 're-plan:vision.md');
    const same = await saveOfficeDoc(h.deps, o, 'vision.md', '# Vision\n\nShip it faster.\n');
    assert.equal(same.changed, false);
    assert.equal(same.wake, null);
    assert.equal(h.starter.calls.length, 1);
    const rows = (await storage.listEvents({ kind: 'office.vision-changed' })).filter((e) => (e.data as any).officeId === o.id);
    assert.equal(rows.length, 1);
    assert.equal((rows[0]!.data as any).source, 'dashboard');
    // the tick sees the dashboard save as already recorded
    await checkOfficeDocs(h.deps, o);
    assert.equal(h.starter.calls.length, 1);
  });

  test('a stale baseSha256 is a conflict and writes nothing', async () => {
    const o = await office();
    await role(o.id);
    const h = harness();
    await assert.rejects(saveOfficeDoc(h.deps, o, 'priorities.md', 'x', { baseSha256: 'f'.repeat(64) }), /changed since you opened it/);
    assert.equal(fs.readFileSync(path.join(o.folderPath, 'priorities.md'), 'utf8'), '# Priorities\n');
    assert.equal(h.starter.calls.length, 0);
  });

  test('a hand edit to priorities.md is noticed by the tick and wakes the Director once', async () => {
    const o = await office();
    await role(o.id);
    const h = harness();
    await h.sched.tick(); // first sight: baseline rows, no wake
    assert.equal(h.starter.calls.length, 0);
    fs.writeFileSync(path.join(o.folderPath, 'priorities.md'), '# Priorities\n\n1. Billing\n');
    await h.sched.tick();
    assert.equal(h.starter.calls.length, 1);
    assert.equal(h.starter.calls[0]!.trigger.kind, 'request');
    assert.equal(h.starter.calls[0]!.trigger.ref, 're-plan:priorities.md');
    await h.sched.tick();
    assert.equal(h.starter.calls.length, 1, 'once');
    // a restart (memory gone) reads the last hash off the audit rows: no second wake
    resetOfficeDocsMemory();
    await h.sched.tick();
    assert.equal(h.starter.calls.length, 1, 'not again after a restart');
    const row = (await storage.listEvents({ kind: 'office.vision-changed' })).find(
      (e) => (e.data as any).officeId === o.id && (e.data as any).source === 'hand-edit',
    );
    assert.equal(row?.actor, 'human');
  });

  test('a busy slot leaves the wake pending; the next tick starts it', async () => {
    const o = await office();
    await role(o.id);
    const h = harness();
    h.starter.refuse = { code: 'office-busy', reason: 'a shift of this office is running' };
    const r = await createOfficeWish(h.deps, o, 'Export to CSV');
    assert.equal(r.wake.ok, false);
    assert.equal(r.wake.ok === false && r.wake.pending, true);
    assert.equal(pendingDirectorWake(o.id), `wish:${r.wish.id}`);
    h.starter.refuse = null;
    await h.sched.tick();
    assert.equal(h.starter.calls.length, 1);
    assert.equal(h.starter.calls[0]!.trigger.ref, `wish:${r.wish.id}`);
    assert.equal(pendingDirectorWake(o.id), null);
  });

  test('a disabled office records the wish, refuses the wake, keeps nothing pending', async () => {
    const o = await office();
    await role(o.id);
    await storage.updateOffice(o.id, { enabled: false });
    const h = harness();
    const r = await createOfficeWish(h.deps, (await storage.getOffice(o.id))!, 'Later');
    assert.equal(r.wake.ok, false);
    assert.equal(r.wake.ok === false && r.wake.pending, false);
    assert.equal(h.starter.calls.length, 0);
  });

  test('roadmap and wishUpdates: the Director writes them; tainted goes to untrusted/; others refused', async () => {
    const o = await office();
    const d = await role(o.id);
    const qa = await role(o.id, { preset: 'qa', key: 'qa2', title: 'QA' });
    const w1 = await storage.createWish({ officeId: o.id, text: 'one' });
    const w2 = await storage.createWish({ officeId: o.id, text: 'two' });
    const ctx = (r: OfficeRole, tainted: boolean) => ({
      storage,
      office: o,
      role: r,
      shiftId: 'shift-x',
      tainted,
      now: new Date(),
      untrustedPath: (rel: string) => untrustedPath(o, rel),
    });
    const ok = await applyShiftResult(
      { roadmap: '# Roadmap\n\n- Q1: billing', wishUpdates: [{ id: w1.id, status: 'planned' }, { id: w2.id, status: 'done' }, { id: 'nope', status: 'done' }] },
      ctx(d, false),
    );
    assert.deepEqual(ok.errors, []);
    assert.equal(fs.readFileSync(path.join(o.folderPath, 'roadmap.md'), 'utf8'), '# Roadmap\n\n- Q1: billing\n');
    assert.equal((await storage.getWish(w1.id))!.status, 'planned');
    assert.equal((await storage.getWish(w2.id))!.status, 'done');
    assert.ok(ok.applied.find((a) => a.section === 'wishUpdates')!.errors![0]!.includes('nope'));

    const tainted = await applyShiftResult({ roadmap: '# Injected', wishUpdates: [{ id: w1.id, status: 'dropped' }] }, ctx(d, true));
    assert.equal(fs.readFileSync(path.join(o.folderPath, 'roadmap.md'), 'utf8'), '# Roadmap\n\n- Q1: billing\n', 'roadmap.md untouched');
    const twin = path.join(o.folderPath, path.relative(path.resolve(o.folderPath), path.resolve(o.folderPath, untrustedPath(o, 'roadmap.md'))));
    assert.equal(fs.readFileSync(twin, 'utf8'), '# Injected\n');
    assert.equal((await storage.getWish(w1.id))!.status, 'planned', 'a tainted shift moves no wish');
    assert.ok(tainted.errors.some((e) => e.section === 'wishUpdates'));

    const other = await applyShiftResult({ roadmap: '# Not mine' }, ctx(qa, false));
    assert.match(other.errors[0]!.error, /only the Director/);
  });

  test('the Director’s re-plan prompt carries vision, priorities, roadmap and open wishes', async () => {
    const o = await office();
    const d = await role(o.id);
    fs.writeFileSync(path.join(o.folderPath, 'roadmap.md'), '# Roadmap\n\nNOW: onboarding\n');
    const open = await storage.createWish({ officeId: o.id, text: 'Faster search' });
    const done = await storage.createWish({ officeId: o.id, text: 'Old wish', status: 'done' });
    const runner = new ShiftRunner({ storage, aux: () => ({}) as any });
    const trigger: ShiftTriggerInput = { kind: 'request', ref: 're-plan:vision.md' };
    const plan = await runner.plan(o, d, trigger, await storage.getSettings());
    const prompt = await runner.prompt(o, d, trigger, plan, []);
    assert.match(prompt, /## Re-plan/);
    assert.match(prompt, /changed `vision.md`/);
    assert.match(prompt, /Ship it\./);
    assert.match(prompt, /NOW: onboarding/);
    assert.ok(prompt.includes(open.id) && prompt.includes('Faster search'));
    assert.ok(!prompt.includes(done.id), 'a done wish is not re-planned');
    assert.match(prompt, /`roadmap`/);
    assert.match(prompt, /`wishUpdates`/);
    // a cron shift of the Director still sees the roadmap, without the re-plan block
    const cron = await runner.prompt(o, d, { kind: 'cron', ref: '0 9 * * *' }, plan, []);
    assert.ok(!cron.includes('## Re-plan'));
    assert.match(cron, /NOW: onboarding/);
  });
});

describe('wish and doc routes', () => {
  let app: FastifyInstance;
  let h: ReturnType<typeof harness>;
  let o: Office;
  const ORIGIN = { origin: 'http://127.0.0.1:5173' };

  before(async () => {
    h = harness();
    o = await office();
    await role(o.id);
    app = Fastify();
    app.setErrorHandler((err, _req, reply) =>
      reply.code(err instanceof ZodError ? 400 : 500).send({ error: err instanceof ZodError ? err.issues.map((i) => i.message).join('; ') : String(err) }),
    );
    registerOfficeRoutes(app, storage, { scheduler: () => h.sched });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  test('403 without Origin', async () => {
    for (const [method, url, payload] of [
      ['POST', `/api/offices/${o.id}/wishes`, { text: 'x' }],
      ['PUT', `/api/offices/${o.id}/docs/vision.md`, { content: 'x' }],
      ['PATCH', `/api/office-wishes/whatever`, { status: 'done' }],
    ] as const) {
      const res = await app.inject({ method, url, payload });
      assert.equal(res.statusCode, 403, `${method} ${url}`);
    }
    assert.equal(h.starter.calls.length, 0);
  });

  test('POST a wish → 201 with the wake; GET lists it; PATCH re-statuses it', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/offices/${o.id}/wishes`, payload: { text: 'A wish' }, headers: ORIGIN });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as OfficeWishCreateResult;
    assert.ok(body.wake.ok);
    assert.equal(h.starter.calls.at(-1)!.trigger.kind, 'request');
    const list = (await app.inject({ method: 'GET', url: `/api/offices/${o.id}/wishes` })).json();
    assert.deepEqual(list.map((w: { id: string }) => w.id), [body.wish.id]);
    const p = await app.inject({ method: 'PATCH', url: `/api/office-wishes/${body.wish.id}`, payload: { status: 'dropped' }, headers: ORIGIN });
    assert.equal(p.json().status, 'dropped');
    const empty = await app.inject({ method: 'POST', url: `/api/offices/${o.id}/wishes`, payload: { text: '   ' }, headers: ORIGIN });
    assert.equal(empty.statusCode, 400);
  });

  test('GET / PUT a doc: changed wakes, unchanged does not, roadmap is read-only, unknown 404', async () => {
    const before = h.starter.calls.length;
    const cur = (await app.inject({ method: 'GET', url: `/api/offices/${o.id}/docs/priorities.md` })).json();
    assert.equal(cur.content, '# Priorities\n');
    const put = await app.inject({
      method: 'PUT',
      url: `/api/offices/${o.id}/docs/priorities.md`,
      payload: { content: '# Priorities\n\n1. Speed\n', baseSha256: cur.sha256 },
      headers: ORIGIN,
    });
    const r = put.json() as OfficeDocPutResult;
    assert.equal(r.changed, true);
    assert.equal(h.starter.calls.length, before + 1);
    assert.equal(h.starter.calls.at(-1)!.trigger.ref, 're-plan:priorities.md');
    const again = await app.inject({ method: 'PUT', url: `/api/offices/${o.id}/docs/priorities.md`, payload: { content: '# Priorities\n\n1. Speed\n' }, headers: ORIGIN });
    assert.equal((again.json() as OfficeDocPutResult).changed, false);
    assert.equal(h.starter.calls.length, before + 1);
    const stale = await app.inject({ method: 'PUT', url: `/api/offices/${o.id}/docs/priorities.md`, payload: { content: 'y', baseSha256: cur.sha256 }, headers: ORIGIN });
    assert.equal(stale.statusCode, 409);
    assert.equal((await app.inject({ method: 'PUT', url: `/api/offices/${o.id}/docs/roadmap.md`, payload: { content: 'x' }, headers: ORIGIN })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: `/api/offices/${o.id}/docs/roadmap.md` })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: `/api/offices/${o.id}/docs/README.md` })).statusCode, 404);
  });
});
