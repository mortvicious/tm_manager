// docs/office.md § Gate and budget — the office gate and the office day
// budget on a temp SQLite DB (and a temp git repo for new-commits-since):
// hard gate before guards, the office fuse in budgetAllows, one office.paused
// row per crossing, the midnight clear on an injected clock, and Pause all
// never written.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Office, OfficeRole } from '@tm/shared';
import { OFFICE_OVER_BUDGET_REASON, nextOfficeDayStart, officeDay, officeDayStart } from '@tm/shared';
import { SqliteStorage } from '../storage/sqlite.ts';
import type { NewOfficeRole } from '../storage/office-sql.ts';
import { budgetAllows } from '../budget.ts';
import { settleOfficeBudget } from './budget.ts';
import { officeGate } from './gate.ts';

let tmp = '';
let storage: SqliteStorage;
let repoId = '';
let repoPath = '';
let n = 0;

const TZ = 'Pacific/Auckland'; // far from the test machine's zone on purpose

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

async function office(over: Partial<Parameters<SqliteStorage['createOffice']>[0]> = {}): Promise<Office> {
  n += 1;
  const ws = await storage.createWorkspace({ name: `ws${n}`, slug: `ws-${n}`, repoIds: [repoId], color: null });
  return storage.createOffice({ workspaceId: ws.id, folderPath: `/tmp/office-${n}`, timezone: TZ, enabled: true, dayBudgetUsd: 5, ...over });
}

const role = (officeId: string, over: Partial<NewOfficeRole> = {}): Promise<OfficeRole> =>
  storage.createOfficeRole({
    officeId,
    key: `r${++n}`,
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
    ...over,
  });

async function spend(taskId: string, cost: number) {
  const r = await storage.createRun({ taskId, repoId, mode: 'worker' } as any);
  await storage.updateRun(r.id, { status: 'done', stats: { costUsd: cost } } as any);
}

const pausedRows = async (officeId: string, kind: 'office.paused' | 'office.resumed' = 'office.paused') =>
  (await storage.listEvents({ kind, limit: 1000 })).filter((e) => (e.data as { officeId?: string } | null)?.officeId === officeId);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-office-gate-'));
  storage = new SqliteStorage(path.join(tmp, 'tm.db'));
  await storage.migrate();
  repoPath = path.join(tmp, 'repo');
  fs.mkdirSync(repoPath);
  git(repoPath, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repoPath, 'a.txt'), 'a');
  git(repoPath, 'add', '.');
  git(repoPath, 'commit', '-q', '-m', 'first');
  repoId = (await storage.createRepo({ name: 'r', path: repoPath } as any)).id;
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('office-local day', () => {
  test('day start and next midnight in the office zone, across DST', () => {
    const berlin = 'Europe/Berlin';
    // 2026-10-25 is the fall-back day in Berlin (25 h long)
    const noon = Date.parse('2026-10-25T11:00:00Z');
    assert.equal(new Date(officeDayStart(noon, berlin)).toISOString(), '2026-10-24T22:00:00.000Z');
    assert.equal(new Date(nextOfficeDayStart(noon, berlin)).toISOString(), '2026-10-25T23:00:00.000Z');
    // 23:30 local is still the same day; the next day starts at local 00:00
    const late = Date.parse('2026-11-04T22:30:00Z'); // 23:30 in Berlin (CET)
    assert.equal(officeDay(late, berlin), '2026-11-04');
    assert.equal(new Date(nextOfficeDayStart(late, berlin)).toISOString(), '2026-11-04T23:00:00.000Z');
    assert.equal(officeDay(nextOfficeDayStart(late, berlin), berlin), '2026-11-05');
    // month end rolls over
    assert.equal(officeDay(nextOfficeDayStart(Date.parse('2026-12-31T12:00:00Z'), 'UTC'), 'UTC'), '2027-01-01');
    // a zone whose midnight is the DST gap (Santiago springs forward 00:00 → 01:00, 2026-09-06)
    const start = officeDayStart(Date.parse('2026-09-06T15:00:00Z'), 'America/Santiago');
    assert.equal(officeDay(start, 'America/Santiago'), '2026-09-06');
    assert.notEqual(officeDay(start - 60_000, 'America/Santiago'), '2026-09-06');
  });
});

describe('officeGate', () => {
  test('the hard-gate reason comes before any guard, and no guard fact is gathered', async () => {
    const o = await office();
    const r = await role(o.id, { guards: [{ kind: 'cooldown', minutes: 0 }, { kind: 'new-commits-since' }] });
    await storage.appendShift({ officeId: o.id, roleId: r.id, trigger: { kind: 'cron', ref: '* * * * *', at: new Date().toISOString() }, verdict: 'ran', endedAt: new Date().toISOString() });
    const paused = (await storage.pauseOffice(o.id, 'holiday', false))!;
    let counted = 0;
    const v = await officeGate(storage, paused, r, { kind: 'cron' }, { countCommits: async () => (counted++, 1) });
    assert.equal(v.ok, false);
    assert.equal(!v.ok && v.code, 'office-paused');
    assert.equal(!v.ok && v.reason, 'office paused: holiday');
    assert.equal(counted, 0, 'guards are not evaluated once the hard gate refuses');
    // with the pause lifted the misconfigured guard is what skips
    const open = (await storage.pauseOffice(o.id, null, true))!;
    const g = await officeGate(storage, open, r, { kind: 'cron' });
    assert.equal(!g.ok && g.code, 'guard');
    assert.match(!g.ok ? g.reason : '', /misconfigured guard/);
  });

  test('Pause all, disabled, role cap and slots are hard reasons; the gate never writes orchestrator.paused', async () => {
    const o = await office();
    const r = await role(o.id, { capUsd: 1 });
    const settings = { ...(await storage.getSettings()), 'orchestrator.paused': true };
    const v = await officeGate(storage, o, r, { kind: 'cron' }, { settings });
    assert.equal(!v.ok && v.code, 'server-paused');
    const t = await storage.createTask({ title: 'o', repoId, source: 'office', officeId: o.id, roleId: r.id }, 'test');
    await spend(t.id, 1);
    assert.equal(await officeGate(storage, o, r, { kind: 'cron' }).then((x) => !x.ok && x.code), 'role-cap');
    const r2 = await role(o.id);
    const shift = await storage.appendShift({ officeId: o.id, roleId: r2.id, trigger: { kind: 'request', ref: 'human', at: new Date().toISOString() }, verdict: 'ran' });
    assert.equal(await officeGate(storage, o, r2, { kind: 'cron' }).then((x) => !x.ok && x.code), 'slots');
    await storage.updateShift(shift.id, { endedAt: new Date().toISOString() });
    assert.equal((await officeGate(storage, o, r2, { kind: 'cron' })).ok, true);
    const off = (await storage.updateOffice(o.id, { enabled: false }))!;
    assert.equal(await officeGate(storage, off, r2, { kind: 'cron' }).then((x) => !x.ok && x.code), 'office-disabled');
    assert.equal((await storage.getSettings())['orchestrator.paused'], false);
  });

  test('guard facts: new commits (real git), tasks landed, open bugs by category, open role tasks; a request skips guards', async () => {
    const o = await office();
    const r = await role(o.id, { guards: [{ kind: 'new-commits-since' }] });
    // never ran → passes
    assert.equal((await officeGate(storage, o, r, { kind: 'cron' })).ok, true);
    // ran a minute in the future → no commit since
    const future = new Date(Date.now() + 60_000).toISOString();
    await storage.appendShift({ officeId: o.id, roleId: r.id, trigger: { kind: 'cron', ref: 'x', at: future }, verdict: 'ran', startedAt: future, endedAt: future });
    const none = await officeGate(storage, o, r, { kind: 'cron' });
    assert.equal(!none.ok && none.reason, 'no new code since the last shift');
    assert.equal(none.facts?.newCommitsSinceLastShift, 0);
    assert.equal((await officeGate(storage, o, r, { kind: 'request' })).ok, true, 'a human request is not guarded');
    // a role that ran before the repo's commit sees it
    const r3 = await role(o.id, { guards: [{ kind: 'new-commits-since' }, { kind: 'tasks-landed-since' }] });
    const past = new Date(Date.now() - 3_600_000).toISOString();
    await storage.appendShift({ officeId: o.id, roleId: r3.id, trigger: { kind: 'cron', ref: 'x', at: past }, verdict: 'ran', startedAt: past, endedAt: past });
    const landedNone = await officeGate(storage, o, r3, { kind: 'cron' });
    assert.equal(landedNone.facts?.newCommitsSinceLastShift, 1);
    assert.equal(!landedNone.ok && landedNone.reason, 'no task landed since the last shift');
    const done = await storage.createTask({ title: 'landed', repoId }, 'test');
    await storage.appendEvent({ kind: 'task.transition', actor: 'orchestrator', taskId: done.id, repoId, data: { from: 'review', to: 'done' } });
    assert.equal((await officeGate(storage, o, r3, { kind: 'cron' })).ok, true);

    const r4 = await role(o.id, { guards: [{ kind: 'open-bugs-below', n: 2 }, { kind: 'no-open-task-of-this-role' }] });
    await storage.createTask({ title: 'b1', repoId, category: 'UI bug' }, 'test');
    await storage.createTask({ title: 'feature', repoId, category: 'debugging tools' }, 'test');
    const g4 = await officeGate(storage, o, r4, { kind: 'cron' });
    assert.equal(g4.ok, true);
    assert.equal(g4.facts?.openBugs, 1);
    assert.deepEqual((g4.facts as { openBugsByCategory?: unknown }).openBugsByCategory, { 'UI bug': 1 });
    await storage.createTask({ title: 'mine', repoId, source: 'office', officeId: o.id, roleId: r4.id }, 'test');
    await storage.createTask({ title: 'b2', repoId, source: 'sentry' }, 'test');
    const g4b = await officeGate(storage, o, r4, { kind: 'cron' });
    assert.equal(!g4b.ok && g4b.reason, '2 open bugs — runs only below 2');
  });

  test('a workspace that is gone fails the repo guards closed', async () => {
    const o = await storage.createOffice({ workspaceId: 'gone', folderPath: '/tmp/gone', timezone: TZ, enabled: true, dayBudgetUsd: 5 });
    const r = await role(o.id, { guards: [{ kind: 'open-bugs-below', n: 3 }] });
    const v = await officeGate(storage, o, r, { kind: 'cron' });
    assert.match(!v.ok ? v.reason : '', /cannot tell the open bug count/);
  });
});

describe('office day budget', () => {
  test('crossing pauses only the office, one office.paused row; office tasks refused, others not', async () => {
    const o = await office();
    const r = await role(o.id);
    const t = await storage.createTask({ title: 'o', repoId, source: 'office', officeId: o.id, roleId: r.id }, 'test');
    const plain = await storage.createTask({ title: 'mine', repoId }, 'test');
    assert.deepEqual(await budgetAllows(storage, t, 'fix-round'), { ok: true });
    await spend(t.id, 5.5);
    await spend(plain.id, 50);

    const verdicts = await Promise.all([
      budgetAllows(storage, t, 'fix-round'),
      budgetAllows(storage, t, 'check-round'),
      settleOfficeBudget(storage, o),
      officeGate(storage, o, r, { kind: 'cron' }),
    ]);
    const v = verdicts[0];
    assert.equal(v.ok, false);
    assert.ok(!v.ok && (v.fuse === 'office.paused' || v.fuse === 'office.dayBudgetUsd'));
    assert.match(!v.ok ? v.reason : '', /^budget: /, 'the orchestrator recognises its own budget line');
    const after1 = (await storage.getOffice(o.id))!;
    assert.equal(after1.pausedReason, OFFICE_OVER_BUDGET_REASON);
    assert.equal(after1.budgetTrippedOn, officeDay(Date.now(), TZ));
    await budgetAllows(storage, t, 'wake');
    assert.equal((await pausedRows(o.id)).length, 1, 'exactly one office.paused row');
    const gate = await officeGate(storage, after1, r, { kind: 'cron' });
    assert.equal(!gate.ok && gate.code, 'office-paused');
    assert.equal(!gate.ok && gate.reason, `office paused: ${OFFICE_OVER_BUDGET_REASON}`);

    // the plain task and the claim fuse are untouched; Pause all is never written
    assert.deepEqual(await budgetAllows(storage, plain, 'fix-round'), { ok: true });
    assert.deepEqual(await budgetAllows(storage, null, 'claim'), { ok: true });
    const s = await storage.getSettings();
    assert.equal(s['orchestrator.paused'], false);
    assert.equal(s['orchestrator.enabled'], (await storage.getSettings())['orchestrator.enabled']);
  });

  test('the office unpauses at its next local midnight (injected clock)', async () => {
    const o = await office({ dayBudgetUsd: 2 });
    const r = await role(o.id);
    const t = await storage.createTask({ title: 'o', repoId, source: 'office', officeId: o.id, roleId: r.id }, 'test');
    await spend(t.id, 3);
    const now = Date.now();
    const tripped = await settleOfficeBudget(storage, o, now);
    assert.equal(tripped.changed, 'tripped');
    assert.equal((await budgetAllows(storage, t, 'fix-round', undefined, { now })).ok, false);

    const midnight = nextOfficeDayStart(now, TZ);
    const before = await settleOfficeBudget(storage, (await storage.getOffice(o.id))!, midnight - 60_000);
    assert.equal(before.office.pausedReason, OFFICE_OVER_BUDGET_REASON, 'still paused a minute before midnight');
    assert.equal((await pausedRows(o.id, 'office.resumed')).length, 0);

    assert.deepEqual(await budgetAllows(storage, t, 'fix-round', undefined, { now: midnight + 60_000 }), { ok: true });
    const cleared = (await storage.getOffice(o.id))!;
    assert.equal(cleared.pausedAt, null);
    assert.equal(cleared.budgetTrippedOn, null);
    const resumed = await pausedRows(o.id, 'office.resumed');
    assert.equal(resumed.length, 1);
    assert.equal((resumed[0].data as { reason?: string }).reason, 'midnight');
    assert.equal((await officeGate(storage, cleared, r, { kind: 'cron' }, { now: midnight + 60_000 })).ok, true);
    assert.equal((await pausedRows(o.id)).length, 1, 'no second trip on the new day');
  });

  test("a human's pause is never replaced or lifted by the budget; raising the budget clears the trip", async () => {
    const o = await office({ dayBudgetUsd: 1 });
    const r = await role(o.id);
    const t = await storage.createTask({ title: 'o', repoId, source: 'office', officeId: o.id, roleId: r.id }, 'test');
    await storage.pauseOffice(o.id, 'holiday', false);
    await spend(t.id, 2);
    const s = await settleOfficeBudget(storage, (await storage.getOffice(o.id))!);
    assert.equal(s.office.pausedReason, 'holiday');
    assert.equal(s.office.budgetTrippedOn, officeDay(Date.now(), TZ));
    assert.equal((await pausedRows(o.id)).length, 0, 'no pause was written');
    const v = await budgetAllows(storage, t, 'dispatch');
    assert.equal(!v.ok && v.fuse, 'office.paused');
    await settleOfficeBudget(storage, (await storage.getOffice(o.id))!, nextOfficeDayStart(Date.now(), TZ) + 1);
    assert.equal((await storage.getOffice(o.id))!.pausedReason, 'holiday', 'midnight leaves a human pause alone');

    // an over-budget pause, then the human raises the budget the same day
    const o2 = await office({ dayBudgetUsd: 1 });
    const t2 = await storage.createTask({ title: 'o2', repoId, source: 'office', officeId: o2.id }, 'test');
    await spend(t2.id, 2);
    assert.equal((await settleOfficeBudget(storage, o2)).changed, 'tripped');
    const raised = (await storage.updateOffice(o2.id, { dayBudgetUsd: 10 }))!;
    const c = await settleOfficeBudget(storage, raised);
    assert.equal(c.changed, 'cleared');
    assert.equal(c.office.pausedAt, null);
    assert.equal(c.office.budgetTrippedOn, null);
    assert.deepEqual(await budgetAllows(storage, t2, 'fix-round'), { ok: true });
  });

  test('a $0 budget refuses office work without calling it a trip', async () => {
    const o = await office({ dayBudgetUsd: 0 });
    const t = await storage.createTask({ title: 'o', repoId, source: 'office', officeId: o.id }, 'test');
    const v = await budgetAllows(storage, t, 'fix-round');
    assert.equal(!v.ok && v.fuse, 'office.dayBudgetUsd');
    const fresh = (await storage.getOffice(o.id))!;
    assert.equal(fresh.pausedAt, null);
    assert.equal(fresh.budgetTrippedOn, null);
  });
});
