// docs/office.md § Data model — the storage half on a temp SQLite DB:
// migrations on a fresh AND an existing DB, CRUD round-trips, the conditional
// pause, spend attribution, open-task counting, and the create-only task columns.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { after, before, describe, test } from 'node:test';
import { isExternalTask, effectiveLanding } from '@tm/shared';
import { SqliteStorage } from './sqlite.ts';
import { MIGRATIONS } from './migrations.ts';
import { isUniqueViolation } from './workspace-sql.ts';
import type { NewOfficeRole } from './office-sql.ts';
import { planSchema, toStoredPlan } from '../claude/feature-plan.ts';

let tmp = '';
let storage: SqliteStorage;
let repoId = '';

const newRole = (officeId: string, over: Partial<NewOfficeRole> = {}): NewOfficeRole => ({
  officeId,
  preset: 'qa',
  key: 'qa',
  name: 'Quinn',
  avatar: '🧪',
  title: 'QA',
  prompt: 'find bugs',
  model: 'claude-opus-5-5',
  tools: ['Read', 'Grep'],
  schedules: ['0 9 * * 1-5'],
  triggers: [{ kind: 'event', event: 'task-landed' }],
  guards: [{ kind: 'cooldown', minutes: 30 }],
  notesPath: 'roles/qa.md',
  ...over,
});

function columns(file: string, table: string): string[] {
  const db = new Database(file, { readonly: true });
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  } finally {
    db.close();
  }
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-office-'));
  storage = new SqliteStorage(path.join(tmp, 'tm.db'));
  await storage.migrate();
  repoId = (await storage.createRepo({ name: 'r', path: tmp } as any)).id;
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('office migrations', () => {
  test('fresh DB has the tables and every column', () => {
    const file = path.join(tmp, 'tm.db');
    for (const c of ['paused_at', 'paused_reason', 'budget_tripped_on', 'workspace_id'])
      assert.ok(columns(file, 'tm_offices').includes(c), c);
    for (const c of ['notes_tainted_at', 'session_id', 'session_tainted', 'role_key'])
      assert.ok(columns(file, 'tm_office_roles').includes(c), c);
    assert.ok(columns(file, 'tm_office_shifts').includes('run_id'));
    for (const c of ['office_id', 'role_id', 'tainted_at']) assert.ok(columns(file, 'tm_tasks').includes(c), c);
  });

  test('an existing DB (migrated up to 52, with a task) gains them on the next migrate', async () => {
    const file = path.join(tmp, 'old.db');
    const db = new Database(file);
    db.exec(`CREATE TABLE tm_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
    for (const m of MIGRATIONS.filter((m) => m.id <= 52)) {
      for (const s of m.statements) db.exec(s);
      db.prepare(`INSERT INTO tm_migrations (id, applied_at) VALUES (?, ?)`).run(m.id, new Date().toISOString());
    }
    const at = new Date().toISOString();
    db.prepare(`INSERT INTO tm_tasks (id, title, status, source, created_at, updated_at) VALUES ('old', 'old task', 'draft', 'manual', ?, ?)`).run(at, at);
    db.close();
    assert.ok(!columns(file, 'tm_tasks').includes('office_id'));
    const s = new SqliteStorage(file);
    await s.migrate();
    const t = await s.getTask('old');
    assert.equal(t?.officeId, null);
    assert.equal(t?.roleId, null);
    assert.equal(t?.taintedAt, null);
    assert.ok((await s.listOffices()).length === 0);
    await s.close();
    assert.ok(columns(file, 'tm_office_roles').includes('session_tainted'));
  });
});

describe('office storage', () => {
  test('office CRUD, one per workspace', async () => {
    const o = await storage.createOffice({ workspaceId: 'ws1', folderPath: '/tmp/office', timezone: 'Europe/Berlin' });
    assert.equal(o.autonomy, 'proposals');
    assert.equal(o.enabled, false);
    assert.equal(o.pausedAt, null);
    assert.equal((await storage.getOfficeByWorkspace('ws1'))?.id, o.id);
    await assert.rejects(
      storage.createOffice({ workspaceId: 'ws1', folderPath: '/tmp/x', timezone: 'UTC' }),
      (e) => isUniqueViolation(e),
    );
    const u = await storage.updateOffice(o.id, { dayBudgetUsd: 12.5, enabled: true, budgetTrippedOn: '2026-11-04' });
    assert.equal(u?.dayBudgetUsd, 12.5);
    assert.equal(u?.enabled, true);
    assert.equal(u?.budgetTrippedOn, '2026-11-04');
    assert.equal(await storage.updateOffice('nope', { enabled: true }), null);
  });

  test('pauseOffice is conditional on the pause state the caller saw', async () => {
    const o = await storage.createOffice({ workspaceId: 'ws-pause', folderPath: '/tmp/p', timezone: 'UTC' });
    assert.equal(await storage.pauseOffice(o.id, null, true), null, 'cannot resume an office that is not paused');
    const p = await storage.pauseOffice(o.id, 'budget', false);
    assert.ok(p?.pausedAt);
    assert.equal(p?.pausedReason, 'budget');
    assert.equal(await storage.pauseOffice(o.id, 'human', false), null, 'a second pause on a stale read loses');
    const re = await storage.pauseOffice(o.id, 'human', true);
    assert.equal(re?.pausedReason, 'human');
    assert.equal(re?.pausedAt, p?.pausedAt, 'paused_at keeps the first pause');
    const r = await storage.pauseOffice(o.id, null, true);
    assert.equal(r?.pausedAt, null);
    assert.equal(r?.pausedReason, null);
  });

  test('roles round-trip every field; key unique per office', async () => {
    const o = await storage.createOffice({ workspaceId: 'ws-roles', folderPath: '/tmp/r', timezone: 'UTC' });
    const r = await storage.createOfficeRole(newRole(o.id));
    assert.deepEqual(r.tools, ['Read', 'Grep']);
    assert.deepEqual(r.triggers, [{ kind: 'event', event: 'task-landed' }]);
    assert.deepEqual(r.guards, [{ kind: 'cooldown', minutes: 30 }]);
    assert.equal(r.enabled, true);
    assert.equal(r.sessionTainted, false);
    await assert.rejects(storage.createOfficeRole(newRole(o.id)), (e) => isUniqueViolation(e));
    const u = await storage.updateOfficeRole(r.id, { sessionId: 's1', sessionTainted: true, notesTaintedAt: '2026-11-04T00:00:00.000Z', capUsd: 2 });
    assert.equal(u?.sessionId, 's1');
    assert.equal(u?.sessionTainted, true);
    assert.equal(u?.capUsd, 2);
    assert.equal((await storage.listOfficeRoles(o.id)).length, 1);
    assert.ok(await storage.deleteOfficeRole(r.id));
    assert.equal(await storage.getOfficeRole(r.id), null);
  });

  test('shifts append, update and filter; deleting an office takes roles and shifts', async () => {
    const o = await storage.createOffice({ workspaceId: 'ws-shifts', folderPath: '/tmp/s', timezone: 'UTC' });
    const role = await storage.createOfficeRole(newRole(o.id));
    const s1 = await storage.appendShift({
      officeId: o.id,
      roleId: role.id,
      trigger: { kind: 'cron', ref: '0 9 * * 1-5', at: '2026-11-04T09:00:00.000Z' },
      verdict: 'ran',
      startedAt: '2026-11-04T09:00:01.000Z',
    });
    assert.deepEqual(s1.filedTaskIds, []);
    assert.equal(s1.endedAt, null);
    await storage.appendShift({
      officeId: o.id,
      roleId: role.id,
      trigger: { kind: 'cron', ref: '0 9 * * 1-5', at: '2026-11-03T09:00:00.000Z' },
      verdict: 'skipped',
      skipReason: 'quiet hours',
      startedAt: '2026-11-03T09:00:01.000Z',
      endedAt: '2026-11-03T09:00:01.000Z',
    });
    const u = await storage.updateShift(s1.id, { filedTaskIds: ['t1'], tainted: true, taintSources: ['web:x'], costUsd: 0.4, endedAt: '2026-11-04T09:05:00.000Z' });
    assert.deepEqual(u?.filedTaskIds, ['t1']);
    assert.equal(u?.tainted, true);
    assert.deepEqual(u?.taintSources, ['web:x']);
    const all = await storage.listShifts({ officeId: o.id });
    assert.deepEqual(all.map((s) => s.verdict), ['ran', 'skipped'], 'newest first');
    assert.equal((await storage.listShifts({ officeId: o.id, verdict: 'skipped' })).length, 1);
    assert.equal((await storage.listShifts({ roleId: role.id, since: '2026-11-04T00:00:00.000Z' })).length, 1);
    assert.equal((await storage.listShifts({ officeId: o.id, until: '2026-11-04T00:00:00.000Z' })).length, 1);
    assert.equal((await storage.listShifts({ officeId: o.id, open: true })).length, 0);
    assert.ok(await storage.deleteOffice(o.id));
    assert.equal((await storage.listShifts({ officeId: o.id })).length, 0);
    assert.equal((await storage.listOfficeRoles(o.id)).length, 0);
  });

  test('office task columns are create-only and make the task external', async () => {
    const t = await storage.createTask(
      { title: 'card', repoId, source: 'feature', officeId: 'o1', roleId: 'r1', taintedAt: '2026-11-04T00:00:00.000Z' },
      'test',
    );
    assert.equal(t.officeId, 'o1');
    assert.equal(t.roleId, 'r1');
    assert.equal(t.taintedAt, '2026-11-04T00:00:00.000Z');
    assert.equal(isExternalTask(t), true, 'a source feature task with an officeId is external');
    assert.equal(effectiveLanding({ ...t, landing: 'auto-publish' }, { landing: 'auto-publish' }), 'supervised');
    const u = await storage.updateTask(t.id, { officeId: null, roleId: 'other', taintedAt: null, title: 'renamed' } as any);
    assert.equal(u?.title, 'renamed');
    assert.equal(u?.officeId, 'o1');
    assert.equal(u?.roleId, 'r1');
    assert.equal(u?.taintedAt, '2026-11-04T00:00:00.000Z');
    const plain = await storage.createTask({ title: 'mine', repoId, source: 'feature' }, 'test');
    assert.equal(plain.officeId, null);
    assert.equal(isExternalTask(plain), false);
  });

  test('officeSpendSince: shift runs + office-task runs, nothing else, since the cutoff', async () => {
    const o = await storage.createOffice({ workspaceId: 'ws-spend', folderPath: '/tmp/sp', timezone: 'UTC' });
    const role = await storage.createOfficeRole(newRole(o.id, { key: 'pm' }));
    const role2 = await storage.createOfficeRole(newRole(o.id, { key: 'writer' }));
    const otherOffice = await storage.createOffice({ workspaceId: 'ws-spend-2', folderPath: '/tmp/sp2', timezone: 'UTC' });
    const officeTask = await storage.createTask({ title: 'o', repoId, source: 'office', officeId: o.id, roleId: role.id }, 'test');
    const role2Task = await storage.createTask({ title: 'o2', repoId, source: 'office', officeId: o.id, roleId: role2.id }, 'test');
    const otherTask = await storage.createTask({ title: 'x', repoId }, 'test');
    const otherOfficeTask = await storage.createTask({ title: 'y', repoId, source: 'office', officeId: otherOffice.id }, 'test');

    const run = async (over: Record<string, unknown>, cost: number) => {
      const r = await storage.createRun({ repoId, mode: 'worker', status: 'done', ...over } as any);
      await storage.updateRun(r.id, { stats: { costUsd: cost } } as any);
      return r;
    };
    const since = new Date(Date.now() - 60_000).toISOString();

    // a shift's aux run, linked by run_id (1)
    const shiftRun = await run({ taskId: null, mode: 'aux', kind: 'shift', subjectId: 'pending' }, 1);
    await storage.appendShift({ officeId: o.id, roleId: role.id, trigger: { kind: 'request', ref: 'human', at: since }, verdict: 'ran', runId: shiftRun.id });
    // a shift's aux run linked only by subject (2)
    const sh2 = await storage.appendShift({ officeId: o.id, roleId: role2.id, trigger: { kind: 'request', ref: 'human', at: since }, verdict: 'ran' });
    await run({ taskId: null, mode: 'aux', kind: 'shift', subjectId: sh2.id }, 2);
    // office task: worker (4) + review aux about it (8) + compact aux about it (16)
    await run({ taskId: officeTask.id }, 4);
    await run({ taskId: null, mode: 'aux', kind: 'review', subjectId: officeTask.id }, 8);
    await run({ taskId: null, mode: 'aux', kind: 'compact', subjectId: officeTask.id }, 16);
    // role2's task worker (32)
    await run({ taskId: role2Task.id }, 32);
    // NOT counted: another task, another office's task, a chat aux whose subject happens to be the office task
    await run({ taskId: otherTask.id }, 100);
    await run({ taskId: otherOfficeTask.id }, 200);
    await run({ taskId: null, mode: 'aux', kind: 'chat', subjectId: officeTask.id }, 400);

    assert.equal(await storage.officeSpendSince(o.id, since), 1 + 2 + 4 + 8 + 16 + 32);
    assert.equal(await storage.officeSpendSince(o.id, since, role.id), 1 + 4 + 8 + 16);
    assert.equal(await storage.officeSpendSince(o.id, since, role2.id), 2 + 32);
    assert.equal(await storage.officeSpendSince(otherOffice.id, since), 200);
    assert.equal(await storage.officeSpendSince(o.id, new Date(Date.now() + 60_000).toISOString()), 0, 'runs before the cutoff are out');
  });

  test('countOpenOfficeTasks skips terminal statuses and narrows by role', async () => {
    const o = await storage.createOffice({ workspaceId: 'ws-open', folderPath: '/tmp/op', timezone: 'UTC' });
    const mk = (roleId: string) => storage.createTask({ title: 't', repoId, source: 'office', officeId: o.id, roleId }, 'test');
    const a = await mk('ra');
    await mk('ra');
    await mk('rb');
    const done = await mk('ra');
    await storage.updateTask(done.id, { status: 'done' });
    const cancelled = await mk('rb');
    await storage.updateTask(cancelled.id, { status: 'cancelled' });
    assert.equal(await storage.countOpenOfficeTasks(o.id), 3);
    assert.equal(await storage.countOpenOfficeTasks(o.id, 'ra'), 2);
    assert.equal(await storage.countOpenOfficeTasks(o.id, 'rb'), 1);
    await storage.updateTask(a.id, { status: 'published' });
    assert.equal(await storage.countOpenOfficeTasks(o.id, 'ra'), 1);
  });
});

describe('office briefs, proposals, wishes (migration 58)', () => {
  test('fresh DB has the tables and the feature columns', () => {
    const file = path.join(tmp, 'tm.db');
    for (const c of ['kind', 'path', 'summary', 'tainted_at', 'reviewed_at', 'shift_id']) assert.ok(columns(file, 'tm_office_briefs').includes(c), c);
    for (const c of ['status', 'repo_id', 'decided_at', 'decided_by', 'filed_task_id', 'tainted_at', 'reviewed_at'])
      assert.ok(columns(file, 'tm_office_proposals').includes(c), c);
    for (const c of ['text', 'status', 'updated_at']) assert.ok(columns(file, 'tm_office_wishes').includes(c), c);
    for (const c of ['office_id', 'tainted_at']) assert.ok(columns(file, 'tm_features').includes(c), c);
  });

  test('an existing DB (migrated up to 57, with a feature) gains them on the next migrate', async () => {
    const file = path.join(tmp, 'old57.db');
    const db = new Database(file);
    db.exec(`CREATE TABLE tm_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
    for (const m of MIGRATIONS.filter((m) => m.id <= 57)) {
      for (const st of m.statements) db.exec(st);
      db.prepare(`INSERT INTO tm_migrations (id, applied_at) VALUES (?, ?)`).run(m.id, new Date().toISOString());
    }
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO tm_features (id, repo_id, title, request, status, analysis_rounds, created_at, updated_at) VALUES ('f-old', NULL, 'old', 'r', 'draft', 0, ?, ?)`,
    ).run(at, at);
    db.close();
    assert.ok(!columns(file, 'tm_features').includes('office_id'));
    const s = new SqliteStorage(file);
    await s.migrate();
    const f = await s.getFeature('f-old');
    assert.equal(f?.officeId, null);
    assert.equal(f?.taintedAt, null);
    assert.deepEqual(await s.listOfficeProposals(), []);
    await s.close();
  });

  test('features carry the create-only office columns', async () => {
    const f = await storage.createFeature({ repoId, title: 'X', request: 'r', officeId: 'off-1', taintedAt: '2026-11-05T00:00:00.000Z' }, 'test');
    assert.equal(f.officeId, 'off-1');
    assert.equal(f.taintedAt, '2026-11-05T00:00:00.000Z');
    const plain = await storage.createFeature({ repoId, title: 'Y', request: 'r' }, 'test');
    assert.equal(plain.officeId, null);
  });

  test('briefs round-trip, filter and markReviewed stamps once', async () => {
    const b = await storage.appendBrief({ officeId: 'ob', roleId: 'r1', shiftId: 's1', kind: 'standup', path: 'deliverables/a.md', summary: 'all quiet' });
    assert.equal(b.taintedAt, null);
    assert.equal(b.reviewedAt, null);
    await storage.appendBrief({ officeId: 'ob', roleId: 'r2', shiftId: 's2', kind: 'brief', path: 'b.md', summary: 's', taintedAt: '2026-11-05T00:00:00.000Z' });
    assert.equal((await storage.listBriefs({ officeId: 'ob' })).length, 2);
    assert.equal((await storage.listBriefs({ officeId: 'ob', kind: 'brief' })).length, 1);
    const r = await storage.markReviewed('brief', b.id);
    assert.ok(r?.reviewedAt);
    const again = await storage.markReviewed('brief', b.id);
    assert.equal(again?.reviewedAt, r?.reviewedAt, 'a repeat keeps the first time');
    assert.equal(await storage.markReviewed('brief', 'nope'), null);
    assert.deepEqual((await storage.listBriefs({ officeId: 'ob', unreviewed: true })).map((x) => x.roleId), ['r2']);
  });

  test('decideProposal is conditional on pending: a second decision returns null', async () => {
    const p = await storage.appendOfficeProposal({ officeId: 'op', roleId: 'r', shiftId: 's', title: 'Add caching', body: 'why', repoId });
    assert.equal(p.status, 'pending');
    assert.equal(p.repoId, repoId);
    const a = await storage.decideProposal(p.id, 'accepted', 'human');
    assert.equal(a?.status, 'accepted');
    assert.equal(a?.decidedBy, 'human');
    assert.ok(a?.decidedAt);
    assert.equal(await storage.decideProposal(p.id, 'rejected', 'telegram'), null, 'the second decision loses');
    assert.equal(await storage.decideProposal(p.id, 'accepted', 'telegram'), null, 'even the same decision');
    assert.equal((await storage.getOfficeProposal(p.id))?.decidedBy, 'human');
    const f = await storage.setProposalFiledTask(p.id, 'task-1');
    assert.equal(f?.filedTaskId, 'task-1');
    assert.equal(await storage.setProposalFiledTask(p.id, 'task-2'), null, 'the filed task is written once');

    const rej = await storage.appendOfficeProposal({ officeId: 'op', roleId: 'r', shiftId: 's', title: 'No', body: '' });
    assert.equal(rej.repoId, null);
    assert.equal((await storage.decideProposal(rej.id, 'rejected', 'telegram'))?.status, 'rejected');
    assert.equal(await storage.setProposalFiledTask(rej.id, 'task-3'), null, 'a rejected proposal files nothing');
    assert.equal(await storage.decideProposal('nope', 'accepted', 'human'), null);
    assert.deepEqual((await storage.listOfficeProposals({ officeId: 'op', status: 'pending' })).length, 0);
    assert.equal((await storage.listOfficeProposals({ officeId: 'op' })).length, 2);
    assert.ok((await storage.markReviewed('proposal', rej.id))?.reviewedAt);
  });

  test('wishes CRUD, oldest first', async () => {
    const w1 = await storage.createWish({ officeId: 'ow', text: 'faster pages' });
    // a later millisecond: within one, `created_at` ties and the random id decides
    await new Promise((r) => setTimeout(r, 2));
    const w2 = await storage.createWish({ officeId: 'ow', text: 'dark mode' });
    assert.equal(w1.status, 'open');
    assert.deepEqual((await storage.listWishes({ officeId: 'ow' })).map((w) => w.id), [w1.id, w2.id]);
    const u = await storage.updateWish(w1.id, { status: 'planned' });
    assert.equal(u?.status, 'planned');
    assert.deepEqual((await storage.listWishes({ officeId: 'ow', status: 'open' })).map((w) => w.id), [w2.id]);
    assert.ok(await storage.deleteWish(w2.id));
    assert.equal(await storage.getWish(w2.id), null);
    assert.equal(await storage.updateWish('nope', { text: 'x' }), null);
  });

  test('deleteOffice takes its briefs, proposals and wishes', async () => {
    const o = await storage.createOffice({ workspaceId: 'ws-del58', folderPath: '/tmp/d', timezone: 'UTC' });
    await storage.appendBrief({ officeId: o.id, roleId: 'r', shiftId: 's', kind: 'brief', path: 'p.md', summary: 's' });
    await storage.appendOfficeProposal({ officeId: o.id, roleId: 'r', shiftId: 's', title: 't', body: 'b' });
    await storage.createWish({ officeId: o.id, text: 'w' });
    assert.ok(await storage.deleteOffice(o.id));
    assert.equal((await storage.listBriefs({ officeId: o.id })).length, 0);
    assert.equal((await storage.listOfficeProposals({ officeId: o.id })).length, 0);
    assert.equal((await storage.listWishes({ officeId: o.id })).length, 0);
  });

  test('FeaturePlanTask.repoId is optional and round-trips through toStoredPlan', () => {
    const raw = planSchema.parse({
      summary: 's',
      considerations: [],
      phases: [
        {
          title: 'P',
          goal: 'g',
          tasks: [
            { title: 'API', description: 'd', repoId: 'repo-nest' },
            { title: 'UI', description: 'd' },
          ],
        },
      ],
    });
    const plan = toStoredPlan(raw, (p, i) => `c${p}${i}`);
    assert.equal(plan.phases[0].tasks[0].repoId, 'repo-nest');
    assert.ok(!('repoId' in plan.phases[0].tasks[1]), 'a single-repo card carries no repoId');
  });
});
