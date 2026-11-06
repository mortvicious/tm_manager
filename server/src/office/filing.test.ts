// docs/office.md § Filing — shift task filing on a temp SQLite DB: the status
// matrix (tainted → draft + tainted_at, queue stopped → draft + note, else
// queued), proposals hold, the two office caps, provenance + supervised
// landing, and the agent ceiling that no longer counts office tasks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  DEFAULT_SETTINGS,
  OFFICE_MAX_OPEN_TASKS_DEFAULT,
  OFFICE_MAX_TASKS_PER_SHIFT_DEFAULT,
  OFFICE_QUEUE_STOPPED_NOTE,
  OFFICE_TAINTED_NOTE,
  effectiveLanding,
  type Office,
  type OfficeRole,
} from '@tm/shared';
import { SqliteStorage } from '../storage/sqlite.ts';
import { agentEnqueueGate, QUEUED_AGENT_CEILING } from '../routes/agent-caps.ts';
import { dropReasons, fileShiftTasks, planShiftFiling, shiftTasksSchema, type ShiftTaskInput } from './filing.ts';

let tmp = '';
let storage: SqliteStorage;
let repoId = '';
let otherRepoId = '';
let n = 0;

async function office(over: Partial<Parameters<SqliteStorage['createOffice']>[0]> = {}): Promise<Office> {
  n += 1;
  const ws = await storage.createWorkspace({ name: `ws${n}`, slug: `ws-${n}`, repoIds: [repoId], color: null });
  return storage.createOffice({
    workspaceId: ws.id,
    folderPath: `/tmp/office-${n}`,
    timezone: 'UTC',
    enabled: true,
    dayBudgetUsd: 5,
    autonomy: 'auto-run',
    ...over,
  });
}

const role = (officeId: string): Promise<OfficeRole> =>
  storage.createOfficeRole({
    officeId,
    key: `qa${++n}`,
    name: 'Quinn',
    avatar: '🧪',
    title: 'QA',
    prompt: 'find bugs',
    model: 'claude-opus-5-5',
    tools: ['Read'],
    schedules: [],
    triggers: [],
    guards: [],
    notesPath: 'roles/qa.md',
  });

/** A shift with a run row, as the runner leaves it before the result is applied. */
async function shift(o: Office, r: OfficeRole, tainted = false) {
  const s = await storage.appendShift({ officeId: o.id, roleId: r.id, trigger: { kind: 'request', ref: 'human', at: new Date().toISOString() }, verdict: 'ran', tainted });
  const run = await storage.createRun({ repoId: null, mode: 'aux', kind: 'shift', subjectId: s.id } as any);
  await storage.updateShift(s.id, { runId: run.id });
  return { shiftId: s.id, runId: run.id };
}

const req = (i: number, over: Partial<ShiftTaskInput> = {}): ShiftTaskInput => ({
  repoId,
  title: `Write tests for module ${i}`,
  description: `Cover module ${i}; done when npm test passes.`,
  category: 'QA',
  effort: 'medium',
  ...over,
});

async function file(o: Office, r: OfficeRole, list: ShiftTaskInput[], tainted = false) {
  const { shiftId, runId } = await shift(o, r, tainted);
  const out = await fileShiftTasks({ storage }, { office: o, role: r, shiftId, tainted, now: new Date('2026-11-05T10:00:00Z') }, list);
  return { ...out, shiftId, runId, row: (await storage.getShift(shiftId))! };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-office-filing-'));
  storage = new SqliteStorage(path.join(tmp, 'tm.db'));
  await storage.migrate();
  repoId = (await storage.createRepo({ name: 'r', path: path.join(tmp, 'r') } as any)).id;
  otherRepoId = (await storage.createRepo({ name: 'other', path: path.join(tmp, 'other') } as any)).id;
});

beforeEach(async () => {
  await storage.setSetting('orchestrator.enabled', true);
  await storage.setSetting('agent.allowEnqueue', false); // never consulted for office filings
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('office caps defaults', () => {
  test('a new office gets 8 per shift and 12 open', async () => {
    const o = await office();
    assert.equal(o.maxTasksPerShift, OFFICE_MAX_TASKS_PER_SHIFT_DEFAULT);
    assert.equal(o.maxTasksPerShift, 8);
    assert.equal(o.maxOpenTasks, OFFICE_MAX_OPEN_TASKS_DEFAULT);
    assert.equal(o.maxOpenTasks, 12);
  });
});

describe('fileShiftTasks', () => {
  test('group decision (docs/grouping.md § Agent filings): one `<role>: <day>` group per shift, a named group id joins, taint never mixes', async () => {
    const o = await office();
    const r = await role(o.id);
    const out = await file(o, r, [req(1), req(2)]);
    const [a, b] = out.filed.map((t) => t.id);
    const root = (await storage.getTask(a))!;
    assert.equal(root.groupName, 'Quinn: 2026-11-05');
    assert.equal((await storage.getTask(b))!.groupId, root.id);
    // a request naming an existing (trusted, in-workspace) task joins THAT group
    const human = await storage.createTask({ title: 'human work', repoId, status: 'queued' }, 'test');
    const joined = await file(o, r, [req(3, { group: human.id })]);
    assert.equal((await storage.getTask(joined.filed[0].id))!.groupId, human.id);
    // a tainted shift may not: it lands in its own group, the reason audited
    const tainted = await file(o, r, [req(4, { group: human.id })], true);
    const t = (await storage.getTask(tainted.filed[0].id))!;
    assert.notEqual(t.groupId, human.id);
    assert.notEqual(t.groupId, root.id, 'the trusted same-day shift group is not deduped onto either');
    const created = (await storage.listEvents({ kind: 'task.created', limit: 2000 })).find((e) => e.taskId === t.id);
    assert.match(String((created?.data?.group as { downgraded?: string })?.downgraded), /different trust/);
  });

  test('an untainted auto-run shift files queued, with provenance, supervised landing, allowEnqueue off', async () => {
    const o = await office();
    const r = await role(o.id);
    const out = await file(o, r, [req(1), req(2)]);
    assert.equal(out.filed.length, 2);
    for (const t of out.filed) {
      const row = (await storage.getTask(t.id))!;
      assert.equal(row.status, 'queued');
      assert.equal(row.source, 'office');
      assert.equal(row.officeId, o.id);
      assert.equal(row.roleId, r.id);
      assert.equal(row.createdByRun, out.runId);
      assert.equal(row.taintedAt, null);
      assert.equal(row.category, 'QA');
      assert.equal(row.effort, 'medium');
      assert.match(row.description ?? '', /Filed by \*\*Quinn\*\*/);
      assert.match(row.description ?? '', /tm:standing-caps/);
      const repo = (await storage.getRepo(repoId))!;
      assert.equal(effectiveLanding(row, { ...repo, landing: 'auto-publish' }), 'supervised');
    }
    assert.deepEqual(out.row.filedTaskIds, out.filed.map((t) => t.id));
    assert.deepEqual(out.row.filing, { status: 'queued', note: null, held: [], dropped: [] });
    const ev = (await storage.listEvents({ kind: 'office.filing', limit: 100 })).find((e) => (e.data as any)?.shiftId === out.shiftId);
    assert.ok(ev);
    assert.deepEqual((ev!.data as any).filed, out.filed.map((t) => t.id));
  });

  test('autonomous files queued too', async () => {
    const o = await office({ autonomy: 'autonomous' });
    const out = await file(o, await role(o.id), [req(1)]);
    assert.equal(out.filed[0].status, 'queued');
  });

  test('a tainted shift files drafts with tainted_at set', async () => {
    const o = await office();
    const out = await file(o, await role(o.id), [req(1), req(2)], true);
    assert.equal(out.filed.length, 2);
    for (const t of out.filed) {
      assert.equal(t.status, 'draft');
      assert.equal(t.taintedAt, '2026-11-05T10:00:00.000Z');
    }
    assert.equal(out.row.filing?.status, 'draft');
    assert.equal(out.row.filing?.note, OFFICE_TAINTED_NOTE);
  });

  test('a stopped global queue files drafts with the "queue is stopped" note', async () => {
    await storage.setSetting('orchestrator.enabled', false);
    const o = await office();
    const out = await file(o, await role(o.id), [req(1)]);
    assert.equal(out.filed[0].status, 'draft');
    assert.equal(out.filed[0].taintedAt, null);
    assert.equal(out.row.filing?.note, OFFICE_QUEUE_STOPPED_NOTE);
    assert.match(OFFICE_QUEUE_STOPPED_NOTE, /^queue is stopped/);
  });

  test('proposals autonomy files nothing and holds the requests on the shift row', async () => {
    const o = await office({ autonomy: 'proposals' });
    const before = (await storage.listTasks({})).length;
    const out = await file(o, await role(o.id), [req(1), req(2)]);
    assert.equal(out.filed.length, 0);
    assert.equal((await storage.listTasks({})).length, before);
    assert.equal(out.row.filing?.status, 'proposal');
    assert.equal(out.row.filing?.held.length, 2);
    assert.equal(out.row.filing?.held[0].title, 'Write tests for module 1');
    assert.deepEqual(out.row.filedTaskIds, []);
  });

  test('the role override wins, and a lowered autonomy is re-read at filing time', async () => {
    const o = await office();
    const r = await role(o.id);
    await storage.updateOffice(o.id, { autonomy: 'proposals' });
    const out = await file(o, r, [req(1)]); // ctx carries the stale auto-run office
    assert.equal(out.filed.length, 0);
    assert.equal(out.row.filing?.status, 'proposal');
    await storage.updateOfficeRole(r.id, { autonomy: 'auto-run' });
    assert.equal((await file(o, r, [req(2)])).filed[0].status, 'queued');
  });

  test('requests past maxTasksPerShift are dropped and listed', async () => {
    const o = await office({ maxTasksPerShift: 3 });
    const out = await file(o, await role(o.id), [1, 2, 3, 4, 5].map((i) => req(i)));
    assert.equal(out.filed.length, 3);
    assert.deepEqual(
      out.row.filing?.dropped.map((d) => [d.title, d.reason]),
      [
        ['Write tests for module 4', dropReasons.perShift(3)],
        ['Write tests for module 5', dropReasons.perShift(3)],
      ],
    );
  });

  test('requests past maxOpenTasks are dropped and listed; terminal office tasks free room', async () => {
    const o = await office({ maxOpenTasks: 4 });
    const r = await role(o.id);
    const first = await file(o, r, [1, 2, 3].map((i) => req(i)));
    assert.equal(first.filed.length, 3);
    const second = await file(o, r, [4, 5, 6].map((i) => req(i)));
    assert.equal(second.filed.length, 1);
    assert.deepEqual(second.row.filing?.dropped.map((d) => d.reason), [dropReasons.open(4), dropReasons.open(4)]);
    await storage.updateTask(first.filed[0].id, { status: 'cancelled' } as any);
    assert.equal((await file(o, r, [req(7)])).filed.length, 1);
  });

  test('a repo outside the workspace and a repeated title are dropped', async () => {
    const o = await office();
    const out = await file(o, await role(o.id), [req(1, { repoId: otherRepoId }), req(2), req(2)]);
    assert.equal(out.filed.length, 1);
    assert.deepEqual(out.row.filing?.dropped.map((d) => d.reason), [dropReasons.repo, dropReasons.duplicate]);
  });

  test('concurrent shifts of one office never overshoot maxOpenTasks', async () => {
    const o = await office({ maxOpenTasks: 3 });
    const r = await role(o.id);
    const [a, b] = await Promise.all([file(o, r, [1, 2].map((i) => req(i))), file(o, r, [3, 4].map((i) => req(i)))]);
    assert.equal(a.filed.length + b.filed.length, 3);
    assert.equal(await storage.countOpenOfficeTasks(o.id), 3);
  });
});

describe('planShiftFiling', () => {
  const base = { workspaceRepoIds: ['r'], autonomy: 'auto-run' as const, tainted: false, queueStopped: false, maxTasksPerShift: 8, maxOpenTasks: 12, openTasks: 0 };
  const rq = (i: number) => ({ repoId: 'r', title: `t${i}`, description: 'd', category: null, effort: null });
  test('a stored cap above 15 is clamped to 15', () => {
    const p = planShiftFiling({ ...base, maxTasksPerShift: 20, maxOpenTasks: 200, requests: Array.from({ length: 20 }, (_, i) => rq(i)) });
    assert.equal(p.file.length, 15);
    assert.equal(p.dropped.length, 5);
  });
  test('tainted outranks the stopped queue for the note', () => {
    assert.equal(planShiftFiling({ ...base, tainted: true, queueStopped: true, requests: [rq(1)] }).note, OFFICE_TAINTED_NOTE);
  });
  test('the result schema accepts more than any cap (excess is dropped, not a correction)', () => {
    assert.ok(shiftTasksSchema.safeParse(Array.from({ length: 20 }, (_, i) => ({ repoId: 'r', title: `t${i}`, description: 'd' }))).success);
    assert.ok(!shiftTasksSchema.safeParse([{ repoId: 'r', title: 't', description: 'd', status: 'queued' }]).success);
  });
});

describe('agent ceiling decoupling', () => {
  test('12 queued office tasks leave an agent enqueue queued, not draft', async () => {
    const before = await storage.countQueuedAgentTasks();
    const o = await office({ maxTasksPerShift: 15, maxOpenTasks: 200 });
    const r = await role(o.id);
    const out = await file(o, r, Array.from({ length: 12 }, (_, i) => req(100 + i)));
    assert.equal(out.filed.filter((t) => t.status === 'queued').length, 12);
    assert.ok(12 >= QUEUED_AGENT_CEILING, 'the test must exceed the agent ceiling to mean anything');
    // office tasks carry created_by_run, yet the agent ceiling does not count them
    assert.equal(await storage.countQueuedAgentTasks(), before);
    const gate = await agentEnqueueGate(storage, { ...DEFAULT_SETTINGS, 'agent.allowEnqueue': true, 'orchestrator.enabled': true }, {
      enqueue: true,
      targetRepoId: otherRepoId,
      runRepoId: repoId,
    });
    assert.deepEqual(gate, { status: 'queued', note: null });
  });

  test('agent filings still count toward the ceiling, and never against the office caps', async () => {
    const before = await storage.countQueuedAgentTasks();
    const run = await storage.createRun({ repoId, mode: 'worker' } as any);
    for (let i = 0; i < QUEUED_AGENT_CEILING; i++) {
      await storage.createTask({ title: `agent ${i}`, repoId: otherRepoId, status: 'queued', source: 'auto', createdByRun: run.id }, 'agent:x');
    }
    assert.equal(await storage.countQueuedAgentTasks(), before + QUEUED_AGENT_CEILING);
    const gate = await agentEnqueueGate(storage, { ...DEFAULT_SETTINGS, 'agent.allowEnqueue': true, 'orchestrator.enabled': true }, {
      enqueue: true,
      targetRepoId: otherRepoId,
      runRepoId: repoId,
    });
    assert.equal(gate.status, 'draft');
    const o = await office({ maxOpenTasks: 2 });
    assert.equal((await file(o, await role(o.id), [req(1), req(2)])).filed.length, 2);
  });
});
