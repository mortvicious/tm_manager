// docs/office.md § Product metrics — over a temp SQLite DB: the definition
// routes (400 for a check / agent-owned / archived / service / out-of-workspace
// command, a bad cron, half a threshold; 403 without Origin), a due metric run
// by a REAL CommandRunner whose PTY pool is a fake (no process, no claude),
// the point from TM_METRIC, the crossing state (exactly one signal per
// crossing, none while in breach, re-armed by ok), and the untainted wake of
// the metric's role through the real ShiftRunner.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { after, before, describe, test } from 'node:test';
import {
  OFFICE_SIGNAL_DEBOUNCE_MS,
  lastTmMetric,
  metricDue,
  metricSide,
  nextCronSlot,
  officeSignalRefTrusted,
  shiftTaint,
  type Office,
  type OfficeMetric,
  type OfficeMetricWithPoints,
  type OfficeRole,
  type Repo,
} from '@tm/shared';
import { AuxRunner } from '../claude/aux.ts';
import { CommandRunner } from '../commands/runner.ts';
import type { SessionManager } from '../pty/session-manager.ts';
import { registerOfficeMetricRoutes } from '../routes/office-metrics.ts';
import { SqliteStorage } from '../storage/sqlite.ts';
import { scaffoldOfficeFolder } from './folder.ts';
import { OfficeMetrics, initOfficeMetrics } from './metrics.ts';
import { ShiftRunner } from './shift.ts';
import { OfficeSignals } from './signals.ts';

interface Spawned {
  runId: string;
  cmd: string;
  args: string[];
  cwd: string;
}
type ExitCb = (e: { runId: string; exitCode: number | null; signal?: number }) => void;

/** The aux pool (claude): records every spawn, runs nothing. */
class FakeAuxSessions {
  spawned: Spawned[] = [];
  private exitCb: ExitCb | null = null;
  onExit(cb: ExitCb) {
    this.exitCb = cb;
  }
  spawn(o: Spawned) {
    this.spawned.push(o);
    return { pty: { pid: 999_997 } };
  }
  input() {}
  kill(runId: string) {
    setImmediate(() => this.exitCb?.({ runId, exitCode: 0 }));
    return true;
  }
  get() {
    return undefined;
  }
}

/** The COMMANDS pool: a spawn "prints" `next` and exits with `code`. Nothing is executed. */
class FakeCommandSessions {
  spawned: Spawned[] = [];
  next = 'TM_METRIC=1\n';
  code = 0;
  private out = new Map<string, Buffer>();
  private exitCb: ExitCb | null = null;
  onExit(cb: ExitCb) {
    this.exitCb = cb;
  }
  spawn(o: Spawned) {
    this.spawned.push(o);
    this.out.set(o.runId, Buffer.from(this.next));
    const code = this.code;
    setTimeout(() => this.exitCb?.({ runId: o.runId, exitCode: code }), 5);
    return { pty: { pid: 4243 } };
  }
  kill(runId: string) {
    setImmediate(() => this.exitCb?.({ runId, exitCode: null }));
    return true;
  }
  get(runId: string) {
    const b = this.out.get(runId);
    return b ? { buffer: { snapshot: () => b } } : undefined;
  }
}

let tmp = '';
let storage: SqliteStorage;
let auxSessions: FakeAuxSessions;
let cmdSessions: FakeCommandSessions;
let auxRunner: AuxRunner;
let shifts: ShiftRunner;
let signals: OfficeSignals;
let metrics: OfficeMetrics;
let app: FastifyInstance;
let repo: Repo;
let otherRepo: Repo;
let clock = Date.now();
let n = 0;

const ORIGIN = { origin: 'http://127.0.0.1:5173' };
const result = (v: unknown) => `Done.\n\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;

async function office(): Promise<Office> {
  n += 1;
  const ws = await storage.createWorkspace({ name: `ws${n}`, slug: `ws-${n}`, repoIds: [repo.id], color: null });
  const folderPath = path.join(tmp, `office-${n}`);
  fs.mkdirSync(folderPath);
  const o = await storage.createOffice({ workspaceId: ws.id, folderPath, timezone: 'UTC', enabled: true, dayBudgetUsd: 5 });
  scaffoldOfficeFolder(o, []);
  return o;
}

async function role(o: Office, over: Partial<Parameters<SqliteStorage['createOfficeRole']>[0]> = {}): Promise<OfficeRole> {
  const key = over.key ?? `growth${++n}`;
  const r = await storage.createOfficeRole({
    officeId: o.id,
    key,
    name: `Growth ${n}`,
    avatar: '📈',
    title: 'Growth',
    prompt: 'Watch the funnel.',
    model: 'claude-opus-5-5',
    tools: ['Read', 'Glob', 'Grep'],
    schedules: [],
    triggers: [],
    guards: [],
    notesPath: `roles/${key}.md`,
    ...over,
  });
  fs.writeFileSync(path.join(o.folderPath, `roles/${key}.md`), `# ${r.name}\n`);
  return r;
}

const saved = (name: string, command: string, over: Partial<Parameters<SqliteStorage['createCommand']>[0]> = {}) =>
  storage.createCommand({ repoId: repo.id, name, command, ...over });

const post = (o: Office, payload: object, origin = true) =>
  app.inject({ method: 'POST', url: `/api/offices/${o.id}/metrics`, payload, headers: origin ? ORIGIN : {} });

async function metric(o: Office, r: OfficeRole, over: object = {}): Promise<OfficeMetricWithPoints> {
  const cmd = await saved(`measure ${++n}`, 'node measure.js');
  const res = await post(o, { roleId: r.id, commandId: cmd.id, name: 'p95', unit: 'ms', better: 'down', schedule: '*/5 * * * *', ...over });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

async function runWith(m: OfficeMetric, out: string, code = 0) {
  cmdSessions.next = out;
  cmdSessions.code = code;
  const r = await metrics.runNow(m.officeId, m.id);
  assert.ok(r.ran, !r.ran ? r.reason : '');
  return r;
}

const metricSignals = async (o: Office) => (await storage.listSignals({ officeId: o.id, limit: 100 })).filter((s) => s.source === 'metric');

async function nextAuxSpawn(count: number): Promise<Spawned> {
  for (let i = 0; i < 400 && auxSessions.spawned.length < count; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(auxSessions.spawned.length >= count, `expected aux spawn #${count}`);
  return auxSessions.spawned[count - 1];
}

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-office-metrics-')));
  storage = new SqliteStorage(path.join(tmp, 'tm.db'));
  await storage.migrate();
  const repoDir = path.join(tmp, 'repo');
  const otherDir = path.join(tmp, 'other');
  fs.mkdirSync(repoDir);
  fs.mkdirSync(otherDir);
  repo = await storage.createRepo({ name: 'web', path: repoDir } as never);
  otherRepo = await storage.createRepo({ name: 'other', path: otherDir } as never);
  auxSessions = new FakeAuxSessions();
  cmdSessions = new FakeCommandSessions();
  auxRunner = new AuxRunner(storage, auxSessions as unknown as SessionManager, 'http://127.0.0.1:1');
  const commandRunner = new CommandRunner(storage, cmdSessions as unknown as SessionManager);
  shifts = new ShiftRunner({ storage, aux: () => auxRunner });
  signals = new OfficeSignals({
    storage,
    shifts: () => shifts,
    fetchers: { sentry: async () => null, github: async () => [] },
    now: () => clock,
    log: () => {},
  });
  metrics = new OfficeMetrics({ storage, runner: () => commandRunner, signals: () => signals, now: () => clock, broadcast: () => {}, log: () => {} });
  initOfficeMetrics(metrics);

  app = Fastify();
  registerOfficeMetricRoutes(app, storage);
  await app.ready();
});

after(async () => {
  signals.stop();
  metrics.stop();
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('pure parts', () => {
  test('TM_METRIC, the side, the due test and the trusted ref', () => {
    assert.equal(lastTmMetric('noise\nTM_METRIC=3\nTM_METRIC: -4.5\nbye'), -4.5);
    assert.equal(lastTmMetric('no metric here'), null);
    const below = { thresholdOp: 'below' as const, thresholdValue: 10 };
    assert.equal(metricSide(9.9, below), 'breach');
    assert.equal(metricSide(10, below), 'ok', 'at the threshold is ok');
    assert.equal(metricSide(11, { thresholdOp: 'above', thresholdValue: 10 }), 'breach');
    assert.equal(metricSide(11, { thresholdOp: null, thresholdValue: null }), null);
    const t0 = Date.parse('2026-11-06T10:01:00Z');
    const m = { schedule: '0 * * * *', lastRunAt: null, createdAt: new Date(t0).toISOString() };
    assert.equal(metricDue(m, t0 + 30 * 60_000, 'UTC'), false);
    assert.equal(metricDue(m, t0 + 60 * 60_000, 'UTC'), true);
    // one run however many slots were missed: the anchor is the last run
    assert.equal(metricDue({ ...m, lastRunAt: new Date(t0 + 10 * 3600_000).toISOString() }, t0 + 10 * 3600_000 + 60_000, 'UTC'), false);
    assert.equal(metricDue({ ...m, schedule: 'nonsense' }, t0 + 99 * 3600_000, 'UTC'), false);
    assert.equal(officeSignalRefTrusted('metric:a metric:b'), true);
    assert.equal(officeSignalRefTrusted('metric:a github:b'), false);
    assert.equal(officeSignalRefTrusted('metric:a +3'), false);
    assert.equal(officeSignalRefTrusted(''), false);
    assert.equal(shiftTaint({ trigger: { kind: 'signal', ref: 'metric:a' }, tools: ['Read'] }).tainted, false);
    assert.equal(shiftTaint({ trigger: { kind: 'signal', ref: 'sentry:a' }, tools: ['Read'] }).tainted, true);
  });
});

describe('the definition routes', () => {
  test('refuses a check, an agent-owned, an archived, a service and an out-of-workspace command; a bad cron; half a threshold', async () => {
    const o = await office();
    const r = await role(o);
    const check = await saved('typecheck', 'npm run typecheck', { isCheck: true });
    const agent = await saved('agent script', 'node x.js', { ownerTaskId: 'task-1' });
    const archived = await saved('old', 'node old.js');
    await storage.updateCommand(archived.id, { archivedAt: new Date().toISOString() });
    const service = await saved('dev', 'npm run dev', { kind: 'service' });
    const outside = await storage.createCommand({ repoId: otherRepo.id, name: 'outside', command: 'node --version' });
    const ok = await saved('conversion', 'node conv.js');
    const base = { roleId: r.id, name: 'conversion', schedule: '0 9 * * *' };
    const cases: [object, RegExp][] = [
      [{ ...base, commandId: check.id }, /is a check/],
      [{ ...base, commandId: agent.id }, /saved by an agent/],
      [{ ...base, commandId: archived.id }, /archived/],
      [{ ...base, commandId: service.id }, /is a service/],
      [{ ...base, commandId: outside.id }, /outside the office's workspace/],
      [{ ...base, commandId: 'nope' }, /no saved command/],
      [{ ...base, commandId: ok.id, schedule: 'every day' }, /schedule/],
      [{ ...base, commandId: ok.id, thresholdOp: 'below' }, /come together/],
      [{ ...base, commandId: ok.id, thresholdValue: 3 }, /come together/],
      [{ ...base, commandId: ok.id, roleId: 'not-a-role' }, /roleId/],
    ];
    for (const [body, why] of cases) {
      const res = await post(o, body);
      assert.equal(res.statusCode, 400, `${JSON.stringify(body)}: ${res.body}`);
      assert.match(res.json().error, why);
    }
    assert.equal((await post(o, { ...base, commandId: ok.id }, false)).statusCode, 403);
    assert.equal((await storage.listOfficeMetrics({ officeId: o.id })).length, 0);

    const created = await post(o, { ...base, commandId: ok.id, thresholdOp: 'below', thresholdValue: 2.5, unit: '%' });
    assert.equal(created.statusCode, 201, created.body);
    const m = created.json() as OfficeMetricWithPoints;
    assert.equal(m.repoId, repo.id);
    assert.deepEqual(m.points, []);
    // an edit is checked whole: dropping half the threshold is refused, Origin required
    const url = `/api/offices/${o.id}/metrics/${m.id}`;
    assert.equal((await app.inject({ method: 'PATCH', url, payload: { thresholdOp: null }, headers: ORIGIN })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PATCH', url, payload: { name: 'x' } })).statusCode, 403);
    const patched = await app.inject({ method: 'PATCH', url, payload: { thresholdOp: null, thresholdValue: null, name: 'Conversion' }, headers: ORIGIN });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal(patched.json().thresholdOp, null);
    // a command that became a check since is refused on the next edit
    await storage.updateCommand(ok.id, { isCheck: true });
    assert.equal((await app.inject({ method: 'PATCH', url, payload: { name: 'y' }, headers: ORIGIN })).statusCode, 400);
    assert.equal((await app.inject({ method: 'DELETE', url })).statusCode, 403);
    assert.equal((await app.inject({ method: 'DELETE', url, headers: ORIGIN })).statusCode, 200);
    assert.equal(await storage.getOfficeMetric(m.id), null);
  });
});

describe('a due metric', () => {
  test('runs in the commands pool without spawning claude and appends a point from TM_METRIC', async () => {
    const o = await office();
    const r = await role(o);
    const m = await metric(o, r);
    const auxBefore = auxSessions.spawned.length;
    const cmdBefore = cmdSessions.spawned.length;
    clock = Date.parse(m.createdAt);
    assert.deepEqual(await metrics.onTick(o, clock), [], 'not due before its first slot');
    cmdSessions.next = 'warming up\n\u001b[32mTM_METRIC=412.5\u001b[0m\ndone\n';
    // anchored on the cron grid, not the wall clock: just past the first slot
    const slot1 = nextCronSlot(m.schedule, Date.parse(m.createdAt), 'UTC')!;
    clock = slot1 + 1000;
    assert.deepEqual(await metrics.onTick(o, clock), [m.id]);
    await metrics.settled();
    assert.equal(cmdSessions.spawned.length, cmdBefore + 1, 'one command run');
    assert.equal(path.basename(cmdSessions.spawned[cmdBefore].cmd), 'node');
    assert.deepEqual(cmdSessions.spawned[cmdBefore].args, ['measure.js']);
    assert.equal(auxSessions.spawned.length, auxBefore, 'no claude');
    const points = await storage.listOfficeMetricPoints(m.id, 10);
    assert.equal(points.length, 1);
    assert.equal(points[0].value, 412.5);
    assert.ok(points[0].runId);
    const after = (await storage.getOfficeMetric(m.id))!;
    assert.equal(after.lastValue, 412.5);
    assert.equal(after.lastSide, null, 'no threshold, no side');
    assert.equal(after.lastError, null);
    // the anchor moved: not due again until the next slot
    assert.deepEqual(await metrics.onTick(o, clock + 60_000), []);

    // no TM_METRIC: the error is recorded, no point, the anchor still moves
    cmdSessions.next = 'it broke\n';
    cmdSessions.code = 1;
    clock = slot1 + 5 * 60_000 + 1000;
    assert.deepEqual(await metrics.onTick(o, clock), [m.id]);
    await metrics.settled();
    cmdSessions.code = 0;
    const errored = (await storage.getOfficeMetric(m.id))!;
    assert.match(errored.lastError ?? '', /exit 1: no TM_METRIC/);
    assert.equal(errored.lastValue, 412.5, 'the last value stands');
    assert.equal(errored.lastRunAt, new Date(clock).toISOString());
    assert.equal((await storage.listOfficeMetricPoints(m.id, 10)).length, 1);
    const [ev] = await storage.listEvents({ kind: 'office.metric', limit: 5 });
    assert.equal((ev.data as { action: string }).action, 'error');
  });

  test('a disabled or paused office runs nothing; the slot stays owed', async () => {
    const o = await office();
    const r = await role(o);
    const m = await metric(o, r);
    clock = Date.parse(m.createdAt) + 6 * 60_000;
    const before = cmdSessions.spawned.length;
    const off = (await storage.updateOffice(o.id, { enabled: false }))!;
    assert.deepEqual(await metrics.onTick(off, clock), []);
    await storage.updateOffice(o.id, { enabled: true });
    const paused = (await storage.pauseOffice(o.id, 'test pause', false))!;
    assert.ok(paused.pausedAt);
    await metrics.onTick(paused, clock);
    await metrics.settled();
    assert.equal(cmdSessions.spawned.length, before);
    assert.equal((await storage.getOfficeMetric(m.id))!.lastRunAt, null);
    await storage.pauseOffice(o.id, null, true);
  });
});

describe('the crossing state', () => {
  test('ok → breach files exactly one signal; staying in breach none; back to ok re-arms it', async () => {
    const o = await office();
    const r = await role(o);
    const m = await metric(o, r, { thresholdOp: 'above', thresholdValue: 100 });
    clock = Date.now();

    let run = await runWith(m, 'TM_METRIC=50\n');
    assert.equal(run.ran && run.metric.lastSide, 'ok');
    assert.equal((await metricSignals(o)).length, 0);

    run = await runWith(m, 'TM_METRIC=150\n');
    assert.ok(run.ran && run.crossed);
    let sigs = await metricSignals(o);
    assert.equal(sigs.length, 1, 'one signal for the crossing');
    assert.match(sigs[0].title, /"p95" breached: 150 ms \(breach = above 100 ms\)/);
    assert.match(sigs[0].rawText, /previous: 50 ms/);
    assert.ok(!sigs[0].rawText.includes('TM_METRIC'), 'server-built text, not the output');

    run = await runWith(m, 'TM_METRIC=160\n');
    assert.ok(run.ran && !run.crossed);
    run = await runWith(m, 'TM_METRIC=999\nboom\n', 1);
    assert.ok(run.ran && !run.crossed, 'a value printed by a failing script still counts, and still no second signal');
    assert.equal((await metricSignals(o)).length, 1, 'staying in breach files nothing');

    run = await runWith(m, 'TM_METRIC=90\n');
    assert.equal(run.ran && run.metric.lastSide, 'ok');
    assert.equal(run.ran && run.metric.breachedAt, null);
    clock += 1000;
    run = await runWith(m, 'TM_METRIC=101\n');
    assert.ok(run.ran && run.crossed, 're-armed');
    sigs = await metricSignals(o);
    assert.equal(sigs.length, 2);
    assert.notEqual(sigs[0].externalId, sigs[1].externalId);
    const kinds = (await storage.listEvents({ kind: 'office.metric', limit: 50 }))
      .filter((e) => (e.data as { metricId: string }).metricId === m.id)
      .map((e) => (e.data as { action: string }).action);
    assert.deepEqual(kinds.sort(), ['breach', 'breach', 'recovered']);
    assert.equal((await storage.listOfficeMetricPoints(m.id, 100)).length, 6);

    // an edit of the threshold re-arms too (a breach under the new rule is news)
    const res = await app.inject({ method: 'PATCH', url: `/api/offices/${o.id}/metrics/${m.id}`, payload: { thresholdValue: 120 }, headers: ORIGIN });
    assert.equal(res.json().lastSide, null);
  });

  test('two runs at once: the second is refused while the first runs', async () => {
    const o = await office();
    const r = await role(o);
    const m = await metric(o, r, { thresholdOp: 'below', thresholdValue: 1 });
    cmdSessions.next = 'TM_METRIC=0\n';
    const [a, b] = await Promise.all([metrics.runNow(o.id, m.id), metrics.runNow(o.id, m.id)]);
    assert.ok(a.ran);
    assert.ok(!b.ran && b.code === 'busy');
    assert.equal((await metricSignals(o)).length, 1);
  });
});

describe('the wake', () => {
  test("a crossing wakes the metric's subscribed role with an UNTAINTED shift, even with web tools", async () => {
    const o = await office();
    const r = await role(o, { tools: ['Read', 'Glob', 'Grep', 'WebFetch'], triggers: [{ kind: 'signal', source: 'metric' }] });
    const bystander = await role(o, { triggers: [{ kind: 'signal', source: 'metric' }] });
    const m = await metric(o, r, { thresholdOp: 'below', thresholdValue: 2 });
    clock = Date.now();
    await runWith(m, 'TM_METRIC=5\n');
    await runWith(m, 'TM_METRIC=1.5\n');
    assert.deepEqual(
      signals.queued().map((q) => q.roleId),
      [r.id],
      'only the metric’s own role',
    );
    const before = auxSessions.spawned.length;
    const woke = await signals.flush(o.id, clock + OFFICE_SIGNAL_DEBOUNCE_MS);
    assert.equal(woke.woken.length, 1, JSON.stringify(woke));
    assert.equal(woke.woken[0].roleId, r.id);
    const sp = await nextAuxSpawn(before + 1);
    const shift = (await storage.getShift(woke.woken[0].shiftId))!;
    assert.equal(shift.trigger.kind, 'signal');
    assert.match(shift.trigger.ref ?? '', /^metric:/);
    assert.equal(shift.tainted, false, shift.taintSources.join(','));
    assert.deepEqual(shift.taintSources, []);
    assert.ok(sp.args.includes('--tools=Read,Glob,Grep'), 'no web tool on a signal wake');
    const prompt = sp.args[sp.args.length - 1];
    assert.match(prompt, /## Product metrics that crossed their threshold/);
    assert.match(prompt, /"p95" breached: 1\.5 ms/);
    assert.ok(!prompt.includes('untrusted external data'), 'neither the fence heading nor the outside-signal wording');
    assert.match(prompt, /started by product metrics that crossed their threshold/);
    assert.equal((await metricSignals(o))[0].consumedShiftId, shift.id, 'consumed by that shift');
    assert.ok(!signals.queued().some((q) => q.roleId === bystander.id));
    await auxRunner.hook(sp.runId, 'stop', { session_id: 'sess-metric', transcript_path: path.join(tmp, 'none.jsonl'), last_assistant_message: result({}) });
  });

  test('a role not subscribed to signal: metric is not woken', async () => {
    const o = await office();
    const r = await role(o);
    const m = await metric(o, r, { thresholdOp: 'above', thresholdValue: 0 });
    await runWith(m, 'TM_METRIC=1\n');
    assert.equal((await metricSignals(o)).length, 1, 'the signal is still filed');
    assert.ok(!signals.queued().some((q) => q.roleId === r.id));
  });
});
