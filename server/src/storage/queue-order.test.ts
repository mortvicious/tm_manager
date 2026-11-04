// Custom-queue reorder (docs/queue.md § Reordering): the pure plan, then the
// sqlite composite end to end against customQueueWaiting / peekCustomQueue.
// Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { customQueueWaiting, officeDay, predictSchedule } from '@tm/shared';
import { planQueueReorder, type QueueOrderRow } from './queue-sql.ts';
import { SqliteStorage } from './sqlite.ts';

const T0 = Date.parse('2026-10-28T10:00:00.000Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const row = (id: string, ms: number, created = 0): QueueOrderRow => ({
  id,
  custom_queue_at: iso(ms),
  created_at: iso(created),
});
const self = (r: QueueOrderRow, status = 'queued') => ({ id: r.id, status, custom_queue_at: r.custom_queue_at });

/** Apply a plan and return the ids in claim order. */
function apply(rows: QueueOrderRow[], plan: ReturnType<typeof planQueueReorder>): string[] {
  assert.ok(!('refused' in plan), JSON.stringify(plan));
  const at = new Map(plan.writes.map((w) => [w.id, w.at]));
  return rows
    .map((r) => ({ ...r, custom_queue_at: at.get(r.id) ?? r.custom_queue_at }))
    .sort((a, b) => a.custom_queue_at.localeCompare(b.custom_queue_at) || a.created_at.localeCompare(b.created_at))
    .map((r) => r.id);
}

describe('planQueueReorder', () => {
  const rows = [row('a', 0), row('b', 1000), row('c', 2000)];

  test('midpoint between neighbours writes one row', () => {
    const plan = planQueueReorder(self(rows[2]), rows, { side: 'before', targetId: 'b' });
    assert.ok(!('refused' in plan));
    assert.equal(plan.writes.length, 1);
    assert.equal(plan.writes[0].at, iso(500));
    assert.equal(plan.renumbered, false);
    assert.deepEqual(apply(rows, plan), ['a', 'c', 'b']);
  });

  test('first renumbers within the span', () => {
    const plan = planQueueReorder(self(rows[2]), rows, 'first');
    assert.ok(!('refused' in plan) && plan.renumbered);
    assert.deepEqual(apply(rows, plan), ['c', 'a', 'b']);
    for (const w of plan.writes) assert.ok(w.at >= iso(0) && w.at <= iso(2000));
  });

  test('a gap under 2 ms renumbers', () => {
    const tight = [row('a', 0), row('b', 1), row('c', 2000)];
    const plan = planQueueReorder(self(tight[2]), tight, { side: 'after', targetId: 'a' });
    assert.ok(!('refused' in plan) && plan.renumbered);
    assert.deepEqual(apply(tight, plan), ['a', 'c', 'b']);
  });

  test('ties keep the current (created_at) order', () => {
    const tied = [row('a', 0, 1), row('b', 0, 2), row('c', 0, 3), row('d', 10, 0)];
    const plan = planQueueReorder(self(tied[3]), tied, { side: 'after', targetId: 'a' });
    assert.deepEqual(apply(tied, plan), ['a', 'd', 'b', 'c']);
    assert.ok(!('refused' in plan));
    for (const w of plan.writes) assert.ok(w.at >= iso(0) && w.at <= iso(10));
  });

  test('a span narrower than the set reaches back, never forward', () => {
    const tied = [row('a', 5, 1), row('b', 5, 2), row('c', 5, 3)];
    const plan = planQueueReorder(self(tied[2]), tied, 'first');
    assert.deepEqual(apply(tied, plan), ['c', 'a', 'b']);
    assert.ok(!('refused' in plan));
    for (const w of plan.writes) assert.ok(w.at <= iso(5));
  });

  test('no-op writes nothing', () => {
    const plan = planQueueReorder(self(rows[0]), rows, { side: 'before', targetId: 'b' });
    assert.deepEqual(plan, { writes: [], renumbered: false, before: iso(0), after: iso(0) });
  });

  test('refusals', () => {
    const r = (p: ReturnType<typeof planQueueReorder>) => ('refused' in p ? p.refused : null);
    assert.match(r(planQueueReorder({ id: 'x', status: 'queued', custom_queue_at: null }, rows, 'first'))!, /not in the custom queue/);
    assert.match(r(planQueueReorder(self(rows[0], 'running'), rows, 'first'))!, /only a waiting member/);
    assert.match(r(planQueueReorder(self(rows[0]), rows, { side: 'after', targetId: 'zz' }))!, /target is not waiting/);
    assert.match(r(planQueueReorder(self(rows[0]), rows, { side: 'after', targetId: 'a' }))!, /itself/);
  });
});

describe('reorderCustomQueue (sqlite)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-queue-order-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('reorders across repos; peek and customQueueWaiting agree; running mark untouched', async () => {
    const s = new SqliteStorage(path.join(dir, 'tm.db'));
    await s.migrate();
    const r1 = await s.createRepo({ name: 'r1', path: path.join(dir, 'r1') });
    const r2 = await s.createRepo({ name: 'r2', path: path.join(dir, 'r2') });
    const r3 = await s.createRepo({ name: 'r3', path: path.join(dir, 'r3') });
    const mk = async (title: string, repoId: string, ms: number, status: 'queued' | 'running' = 'queued') => {
      const t = await s.createTask({ title, repoId, status }, 'test');
      return (await s.updateTask(t.id, { customQueueAt: iso(ms) }))!;
    };
    const a = await mk('a', r1.id, 0);
    const b = await mk('b', r2.id, 1000);
    const c = await mk('c', r1.id, 2000);
    const run = await mk('run', r3.id, 500, 'running');

    const res = await s.reorderCustomQueue(c.id, 'first', 'human');
    assert.ok(res && 'tasks' in res);
    assert.equal(res.tasks[0].id, c.id);
    const waiting = customQueueWaiting(await s.listTasks()).map((t) => t.title);
    assert.deepEqual(waiting, ['c', 'a', 'b']);
    assert.equal((await s.peekCustomQueue())!.title, 'c');
    assert.equal((await s.getTask(run.id))!.customQueueAt, iso(500));

    const mid = await s.reorderCustomQueue(b.id, { side: 'before', targetId: a.id }, 'human');
    assert.ok(mid && 'tasks' in mid && mid.tasks.length === 1);
    assert.deepEqual(customQueueWaiting(await s.listTasks()).map((t) => t.title), ['c', 'b', 'a']);
    assert.equal((await s.peekCustomQueue([r1.id]))!.title, 'b');

    const refused = await s.reorderCustomQueue(run.id, 'first', 'human');
    assert.deepEqual(refused, { refused: 'only a waiting member can move (task is running)' });
    const cross = await s.reorderCustomQueue(a.id, { side: 'before', targetId: run.id }, 'human');
    assert.deepEqual(cross, { refused: 'target is not waiting in the custom queue' });

    const audit = (await s.listEvents({ taskId: c.id })).filter((e: any) => e.kind === 'task.queue');
    assert.equal(audit.length, 1);
    assert.equal((audit[0].data as any).action, 'reorder');
  });
});

// The office claim share (docs/office.md § Claim share): OFFICE_CLAIM_GATE in
// every claim path, and its JS twin in predictSchedule agreeing with it.
describe('office claim share (sqlite)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-office-claim-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const fresh = async () => {
    const s = new SqliteStorage(path.join(dir, `tm-${++n}.db`));
    await s.migrate();
    const repo = (name: string) => s.createRepo({ name, path: path.join(dir, `${n}-${name}`) });
    return { s, repo };
  };
  const settings = { 'orchestrator.enabled': true, 'orchestrator.paused': false, 'orchestrator.concurrency': 4 };
  const predict = async (s: SqliteStorage) =>
    predictSchedule({
      tasks: await s.listTasks(),
      repos: await s.listRepos(),
      features: [],
      settings,
      runs: [],
      offices: await s.listOffices(),
      now: Date.now(),
    });

  test('max_slots 1: one office task runs, the second waits; every claim path agrees', async () => {
    const { s, repo } = await fresh();
    const [r1, r2, r3, r4, r5] = await Promise.all(['r1', 'r2', 'r3', 'r4', 'r5'].map(repo));
    const o = await s.createOffice({ workspaceId: 'ws', folderPath: path.join(dir, 'office'), timezone: 'Europe/Berlin', maxSlots: 1, enabled: true });
    const a = await s.createTask({ title: 'office a', repoId: r1.id, status: 'queued', officeId: o.id }, 'test');
    const b = await s.createTask({ title: 'office b', repoId: r2.id, status: 'queued', officeId: o.id }, 'test');

    // the simulator, before any claim: a starts now, b waits for the share
    const before = await predict(s);
    const pa = before.find((p) => p.taskId === a.id)!;
    const pb = before.find((p) => p.taskId === b.id)!;
    assert.ok(pa.scheduled && pa.source === 'global' && pa.waits.length === 0);
    assert.ok(pb.scheduled && Date.parse(pb.start) >= Date.parse(pa.end));
    assert.deepEqual(pb.waits, [{ code: 'office', text: 'office slot share 1/1' }]);

    // the SQL: exactly the same — a, then nothing
    assert.equal((await s.claimNextQueuedTask('test'))!.id, a.id);
    assert.equal(await s.claimNextQueuedTask('test'), null);

    // the custom queue: an office member waits for the share too
    const c = await s.createTask({ title: 'office c', repoId: r3.id, status: 'queued', officeId: o.id }, 'test');
    await s.updateTask(c.id, { customQueueAt: new Date().toISOString() });
    assert.equal(await s.peekCustomQueue(), null);
    assert.equal(await s.claimCustomQueuedTask(c.id, 'test'), null);

    // the overflow claim: a child of a live run, filed for the office, waits
    const filer = await s.createTask({ title: 'filer', repoId: r4.id, status: 'running' }, 'test');
    const run = await s.createRun({ taskId: filer.id, repoId: r4.id, mode: 'worker' });
    const d = await s.createTask({ title: 'office d', repoId: r5.id, status: 'queued', officeId: o.id, createdByRun: run.id }, 'test');
    assert.equal(await s.claimNextAgentChildTask([run.id], 'test'), null);

    // the simulator over the live rows says why b waits
    const live = await predict(s);
    assert.deepEqual(live.find((p) => p.taskId === b.id)!.waits[0], { code: 'office', text: 'office slot share 1/1' });

    // a lands in review: the share frees and the next office task goes
    await s.transitionTask(a.id, ['running'], 'review', 'test');
    assert.equal((await s.claimNextAgentChildTask([run.id], 'test'))!.id, d.id);
    assert.equal(await s.claimNextQueuedTask('test'), null, 'd holds the one slot now');
    await s.transitionTask(d.id, ['running'], 'review', 'test');
    assert.equal((await s.peekCustomQueue())!.id, c.id);
    assert.equal((await s.claimCustomQueuedTask(c.id, 'test'))!.id, c.id);
    // `waiting` holds the share as well as `running`
    await s.transitionTask(c.id, ['running'], 'waiting', 'test');
    assert.equal(await s.claimNextQueuedTask('test'), null);
  });

  test('a paused, off or over-budget office is skipped; a non-office task is claimed', async () => {
    const { s, repo } = await fresh();
    const [r1, r2] = await Promise.all(['r1', 'r2'].map(repo));
    const tz = 'Europe/Berlin';
    const o = await s.createOffice({ workspaceId: 'ws', folderPath: path.join(dir, 'office2'), timezone: tz, maxSlots: 2, enabled: true });
    // the office task outranks the plain one, so only the gate can skip it
    const ot = await s.createTask({ title: 'office', repoId: r1.id, status: 'queued', priority: 5, officeId: o.id }, 'test');
    const plain = await s.createTask({ title: 'plain', repoId: r2.id, status: 'queued' }, 'test');
    const reset = async () => {
      for (const t of await s.listTasks()) if (t.status === 'running') await s.transitionTask(t.id, ['running'], 'queued', 'test');
    };
    const waitOf = async () => (await predict(s)).find((p) => p.taskId === ot.id)!.waits.find((w) => w.code === 'office')?.text;

    await s.pauseOffice(o.id, 'test pause', false);
    assert.equal(await waitOf(), 'office paused');
    assert.equal((await s.claimNextQueuedTask('test'))!.id, plain.id);
    assert.equal(await s.claimNextQueuedTask('test'), null);
    await reset();
    await s.pauseOffice(o.id, null, true);

    await s.updateOffice(o.id, { budgetTrippedOn: officeDay(Date.now(), tz) });
    assert.equal(await waitOf(), 'office day budget spent');
    assert.equal((await s.claimNextQueuedTask('test'))!.id, plain.id);
    assert.equal(await s.claimNextQueuedTask('test'), null);
    await reset();

    await s.updateOffice(o.id, { enabled: false, budgetTrippedOn: null });
    assert.equal(await waitOf(), 'office is off');
    assert.equal((await s.claimNextQueuedTask('test'))!.id, plain.id);
    await reset();

    // a trip on an EARLIER office day no longer holds anything
    await s.updateOffice(o.id, { enabled: true, budgetTrippedOn: '2000-01-01' });
    assert.equal(await waitOf(), undefined);
    assert.equal((await s.claimNextQueuedTask('test'))!.id, ot.id);

    // a task whose office row is gone fails closed
    await reset();
    await s.deleteOffice(o.id);
    assert.equal(await waitOf(), 'office not found');
    assert.equal((await s.claimNextQueuedTask('test'))!.id, plain.id);
  });
});
