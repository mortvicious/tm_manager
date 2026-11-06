// docs/office.md § Scorecard — the pure `officeScorecard` over fixture rows,
// and GET /api/offices/:id/scorecard over a temp SQLite DB (Fastify inject).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  isBugTask,
  officeScorecard,
  scorecardDays,
  scorecardLine,
  scorecardMarkdown,
  type OfficeScorecardResponse,
  type OfficeScorecardRows,
} from '@tm/shared';
import { registerOfficeRoutes } from '../routes/offices.ts';
import { SqliteStorage } from '../storage/sqlite.ts';
import { ScorecardCache } from './scorecard.ts';

const W = { since: '2026-11-01T00:00:00.000Z', until: '2026-11-08T00:00:00.000Z' };
const IN = '2026-11-03T10:00:00.000Z';
const OUT = '2026-10-20T10:00:00.000Z';

function fixture(): OfficeScorecardRows {
  return {
    officeId: 'o1',
    roles: [
      { id: 'qa', key: 'qa', name: 'Quinn' },
      { id: 'dev', key: 'dev', name: 'Dana' },
    ],
    tasks: [
      // a bug filed and fixed in the window by qa
      { id: 't1', roleId: 'qa', source: 'office', category: 'bug', createdAt: IN },
      // a bug filed in the window, not landed
      { id: 't2', roleId: 'qa', source: 'office', category: 'ui-bugs', createdAt: IN },
      // a feature filed before the window, landed in it (twice: done then published = one landing)
      { id: 't3', roleId: 'dev', source: 'office', category: 'feature', createdAt: OUT },
      // a task with no role (counts office-wide only)
      { id: 't4', roleId: null, source: 'office', category: null, createdAt: IN },
    ],
    events: [
      { kind: 'task.transition', at: IN, actor: 'orchestrator', taskId: 't1', data: { from: 'review', to: 'done' } },
      { kind: 'task.transition', at: IN, actor: 'human', taskId: 't3', data: { from: 'review', to: 'done' } },
      { kind: 'task.transition', at: IN, actor: 'orchestrator', taskId: 't3', data: { from: 'done', to: 'published' } },
      // a human move on t2 (no landing)
      { kind: 'task.transition', at: IN, actor: 'telegram', taskId: 't2', data: { from: 'draft', to: 'queued' } },
      // a landing outside the window does not count
      { kind: 'task.transition', at: OUT, actor: 'human', taskId: 't2', data: { from: 'review', to: 'done' } },
      // a transition on a task that is not the office's is ignored
      { kind: 'task.transition', at: IN, actor: 'human', taskId: 'other', data: { from: 'review', to: 'done' } },
      { kind: 'question.answered', at: IN, actor: 'human', taskId: 't3', data: {} },
      // the autopilot is not a human
      { kind: 'question.answered', at: IN, actor: 'autopilot', taskId: 't3', data: {} },
      { kind: 'approval.decided', at: IN, actor: 'human', taskId: 't4', data: { approved: true } },
      { kind: 'approval.decided', at: IN, actor: 'telegram', taskId: 't1', data: { approved: false } },
      { kind: 'office.taint-cleared', at: IN, actor: 'human', taskId: null, data: { officeId: 'o1', roleId: 'dev' } },
      // another office's taint clear
      { kind: 'office.taint-cleared', at: IN, actor: 'human', taskId: null, data: { officeId: 'o2', roleId: 'dev' } },
    ],
    shifts: [
      { id: 's1', roleId: 'qa', verdict: 'ran', skipCode: null, startedAt: IN },
      { id: 's2', roleId: 'qa', verdict: 'skipped', skipCode: 'guard', startedAt: IN },
      { id: 's3', roleId: 'qa', verdict: 'skipped', skipCode: 'guard', startedAt: IN },
      { id: 's4', roleId: 'dev', verdict: 'skipped', skipCode: 'budget', startedAt: IN },
      { id: 's5', roleId: 'dev', verdict: 'skipped', skipCode: null, startedAt: IN },
      { id: 's6', roleId: 'dev', verdict: 'skipped', skipCode: 'guard', startedAt: OUT },
    ],
    proposals: [
      { id: 'p1', roleId: 'dev', status: 'accepted', decidedAt: IN },
      { id: 'p2', roleId: 'dev', status: 'rejected', decidedAt: IN },
      { id: 'p3', roleId: 'qa', status: 'rejected', decidedAt: OUT },
      { id: 'p4', roleId: 'qa', status: 'pending', decidedAt: null },
    ],
    ratings: [
      { roleId: 'qa', value: 1, updatedAt: IN },
      { roleId: 'qa', value: -1, updatedAt: IN },
      { roleId: 'dev', value: 1, updatedAt: OUT },
    ],
    spend: { officeUsd: 12.345, byRole: { qa: 4, dev: 8 } },
  };
}

describe('officeScorecard (pure)', () => {
  test('office-wide figures', () => {
    const card = officeScorecard(fixture(), W);
    const f = card.office;
    assert.equal(card.since, W.since);
    assert.equal(f.landed, 2, 't1 + t3 (t3 once though done then published)');
    assert.equal(f.filed, 3);
    assert.equal(f.bugsFound, 2);
    assert.equal(f.bugsFixed, 1);
    assert.equal(f.proposalsAccepted, 1);
    assert.equal(f.proposalsRejected, 1);
    assert.equal(f.shifts, 1);
    assert.equal(f.spentUsd, 12.35);
    assert.equal(f.usdPerLanded, 6.17);
    assert.deepEqual(f.interventions, { transitions: 2, answers: 1, approvals: 1, rejections: 1, taintClears: 1, total: 6 });
    assert.deepEqual(f.skips, { guard: 2, budget: 1, other: 1 });
    assert.equal(f.skipsTotal, 4);
    assert.deepEqual(f.ratings, { up: 1, down: 1 });
  });

  test('per role', () => {
    const card = officeScorecard(fixture(), W);
    const qa = card.roles.find((r) => r.roleId === 'qa')!;
    const dev = card.roles.find((r) => r.roleId === 'dev')!;
    assert.equal(qa.key, 'qa');
    assert.equal(qa.name, 'Quinn');
    assert.deepEqual([qa.landed, qa.filed, qa.bugsFound, qa.bugsFixed], [1, 2, 2, 1]);
    assert.deepEqual(qa.interventions, { transitions: 1, answers: 0, approvals: 0, rejections: 1, taintClears: 0, total: 2 });
    assert.deepEqual(qa.skips, { guard: 2 });
    assert.deepEqual(qa.ratings, { up: 1, down: 1 });
    assert.equal(qa.spentUsd, 4);
    assert.equal(qa.usdPerLanded, 4);
    assert.deepEqual([dev.landed, dev.filed, dev.proposalsAccepted, dev.proposalsRejected], [1, 0, 1, 1]);
    assert.deepEqual(dev.interventions, { transitions: 1, answers: 1, approvals: 0, rejections: 0, taintClears: 1, total: 3 });
    assert.deepEqual(dev.skips, { budget: 1, other: 1 });
    assert.deepEqual(dev.ratings, { up: 0, down: 0 }, 'the 👍 is outside the window');
    // the role-less task's approval counts office-wide only
    assert.equal(card.office.interventions.approvals, 1);
    assert.equal(qa.interventions.approvals + dev.interventions.approvals, 0);
  });

  test('nothing landed → no $ per landed; empty rows → zeros', () => {
    const rows = fixture();
    const card = officeScorecard({ ...rows, events: [], tasks: [], proposals: [], shifts: [], ratings: [], spend: { officeUsd: 3, byRole: {} } }, W);
    assert.equal(card.office.landed, 0);
    assert.equal(card.office.usdPerLanded, null);
    assert.equal(card.office.spentUsd, 3);
    assert.equal(card.roles.length, 2);
    assert.equal(card.roles[0].spentUsd, 0);
    assert.match(scorecardLine(card.office), /0 landed · .*\$3\.00 spent \(—\/landed\).*skips: none/);
    // a quiet role is left out of the markdown block
    assert.deepEqual(scorecardMarkdown(card), [`> **Office:** ${scorecardLine(card.office)}`]);
  });

  test('is pure: same rows, same answer, input untouched', () => {
    const rows = fixture();
    const copy = JSON.parse(JSON.stringify(rows));
    assert.deepEqual(officeScorecard(rows, W), officeScorecard(rows, W));
    assert.deepEqual(rows, copy);
  });

  test('isBugTask and the days clamp', () => {
    assert.ok(isBugTask({ source: 'sentry', category: null }));
    assert.ok(isBugTask({ source: 'office', category: 'Bugs' }));
    assert.ok(!isBugTask({ source: 'office', category: 'debugging' }));
    assert.equal(scorecardDays(undefined), 7);
    assert.equal(scorecardDays('30'), 30);
    assert.equal(scorecardDays('0'), 7);
    assert.equal(scorecardDays('5000'), 90);
  });
});

describe('ScorecardCache', () => {
  test('one computation per key per ttl; a failure is not cached', async () => {
    let now = 0;
    const cache = new ScorecardCache(1000, () => now);
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return { calls } as unknown as OfficeScorecardResponse;
    };
    await cache.get('a:7', compute);
    await cache.get('a:7', compute);
    assert.equal(calls, 1);
    now = 1001;
    await cache.get('a:7', compute);
    assert.equal(calls, 2);
    await assert.rejects(cache.get('b:7', async () => Promise.reject(new Error('boom'))));
    await new Promise((r) => setImmediate(r));
    await cache.get('b:7', compute);
    assert.equal(calls, 3);
  });
});

describe('GET /api/offices/:id/scorecard', () => {
  let tmp = '';
  let storage: SqliteStorage;
  let app: FastifyInstance;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-office-scorecard-'));
    storage = new SqliteStorage(path.join(tmp, 'tm.db'));
    await storage.migrate();
    app = Fastify();
    registerOfficeRoutes(app, storage);
    await app.ready();
  });
  after(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('office and per-role figures for the window', async () => {
    fs.mkdirSync(path.join(tmp, 'repo'));
    const repo = await storage.createRepo({ name: 'r', path: path.join(tmp, 'repo') } as never);
    const ws = await storage.createWorkspace({ name: 'W', slug: 'w', repoIds: [repo.id], color: null });
    const office = await storage.createOffice({ workspaceId: ws.id, folderPath: path.join(tmp, 'office'), timezone: 'UTC', enabled: false, dayBudgetUsd: 5, autonomy: 'proposals' });
    const mk = (key: string) =>
      storage.createOfficeRole({ officeId: office.id, key, name: key.toUpperCase(), avatar: '🛠', title: 'x', prompt: 'p', model: 'claude-opus-5-5', tools: ['Read'], schedules: [], triggers: [], guards: [], notesPath: `roles/${key}.md` });
    const qa = await mk('qa');
    const dev = await mk('dev');
    const bug = await storage.createTask({ title: 'bug', repoId: repo.id, source: 'office', category: 'bug', officeId: office.id, roleId: qa.id, status: 'queued' }, 'office');
    const feat = await storage.createTask({ title: 'feat', repoId: repo.id, source: 'office', officeId: office.id, roleId: dev.id, status: 'queued' }, 'office');
    const mine = await storage.createTask({ title: 'not the office', repoId: repo.id, status: 'queued' }, 'human');
    await storage.appendEvent({ kind: 'task.transition', actor: 'orchestrator', taskId: bug.id, repoId: repo.id, data: { from: 'review', to: 'done' } });
    await storage.appendEvent({ kind: 'task.transition', actor: 'human', taskId: feat.id, repoId: repo.id, data: { from: 'queued', to: 'cancelled' } });
    await storage.appendEvent({ kind: 'task.transition', actor: 'human', taskId: mine.id, repoId: repo.id, data: { from: 'review', to: 'done' } });
    await storage.appendShift({ officeId: office.id, roleId: dev.id, trigger: { kind: 'cron', ref: '0 9 * * *', at: new Date().toISOString() }, verdict: 'skipped', skipCode: 'guard', skipReason: 'quiet' });
    const s = await storage.appendShift({ officeId: office.id, roleId: dev.id, trigger: { kind: 'request', ref: 'human', at: new Date().toISOString() }, verdict: 'ran' });
    const p = await storage.appendOfficeProposal({ officeId: office.id, roleId: dev.id, shiftId: s.id, title: 'idea', body: 'b' });
    await storage.decideProposal(p.id, 'rejected', 'human');
    await storage.upsertOfficeRating({ officeId: office.id, roleId: qa.id, subjectKind: 'task', subjectId: bug.id, value: 1, comment: null });

    const res = await app.inject({ method: 'GET', url: `/api/offices/${office.id}/scorecard?days=30` });
    assert.equal(res.statusCode, 200);
    const card = res.json() as OfficeScorecardResponse;
    assert.equal(card.days, 30);
    assert.equal(card.officeId, office.id);
    assert.ok(Date.parse(card.until) - Date.parse(card.since) >= 30 * 86_400_000 - 1000);
    assert.equal(card.office.landed, 1, 'only the office task counts');
    assert.equal(card.office.filed, 2);
    assert.deepEqual([card.office.bugsFound, card.office.bugsFixed], [1, 1]);
    assert.equal(card.office.proposalsRejected, 1);
    assert.equal(card.office.interventions.transitions, 1);
    assert.deepEqual(card.office.skips, { guard: 1 });
    const rq = card.roles.find((r) => r.key === 'qa')!;
    const rd = card.roles.find((r) => r.key === 'dev')!;
    assert.deepEqual([rq.landed, rq.ratings.up], [1, 1]);
    assert.deepEqual([rd.landed, rd.proposalsRejected, rd.interventions.transitions, rd.skipsTotal], [0, 1, 1, 1]);

    // cached: a new landing does not show for 10 minutes
    await storage.appendEvent({ kind: 'task.transition', actor: 'orchestrator', taskId: feat.id, repoId: repo.id, data: { from: 'review', to: 'done' } });
    const again = (await app.inject({ method: 'GET', url: `/api/offices/${office.id}/scorecard?days=30` })).json() as OfficeScorecardResponse;
    assert.equal(again.computedAt, card.computedAt);
    assert.equal(again.office.landed, 1);
    // another window is its own entry
    const week = (await app.inject({ method: 'GET', url: `/api/offices/${office.id}/scorecard` })).json() as OfficeScorecardResponse;
    assert.equal(week.days, 7);
    assert.equal(week.office.landed, 2);

    assert.equal((await app.inject({ method: 'GET', url: '/api/offices/nope/scorecard' })).statusCode, 404);
  });
});
