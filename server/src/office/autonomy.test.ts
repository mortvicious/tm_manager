// docs/office.md § Autonomous opt-in, docs/approvals.md § Office autonomy,
// decisions.md 2026-11-07 — the one exception to "an external task never lands
// above supervised": the pure rule as a table, then the I/O half on a temp
// SQLite DB (the filing shift, the kill switch on queued and review tasks),
// the push-ref auto-approval (rebuild-restart always waits), and the Origin +
// audit rules of the opt-in and the kill switch.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { after, before, describe, test } from 'node:test';
import {
  effectiveLanding,
  officeAutonomyRefusal,
  officeDay,
  type Approval,
  type ApprovalParams,
  type LandingTier,
  type Office,
  type OfficeAutonomyFacts,
  type OfficeAutonomyTask,
  type OfficeRole,
  type Repo,
  type ServerEvent,
  type Task,
} from '@tm/shared';
import { ApprovalService } from '../approvals.ts';
import { onEvent } from '../events.ts';
import { registerOfficeRoutes } from '../routes/offices.ts';
import { registerRepoRoutes } from '../routes/repos.ts';
import { SqliteStorage } from '../storage/sqlite.ts';
import { landingRefusal } from '../task-actions.ts';
import { autonomousOfficeTasks, officeAutonomyFacts, resolveLanding } from './autonomy.ts';
import { setKillSwitch } from './kill-switch.ts';

const NOW = Date.parse('2026-11-07T12:00:00Z');

// ---- the pure rule ------------------------------------------------------------

const baseOffice = {
  id: 'o1',
  autonomy: 'autonomous',
  enabled: true,
  pausedAt: null,
  killSwitch: false,
  dayBudgetUsd: 20,
  budgetTrippedOn: null,
  timezone: 'UTC',
} as OfficeAutonomyFacts['office'] & object;
const baseFacts = (): OfficeAutonomyFacts => ({
  office: { ...baseOffice },
  role: { id: 'r1', autonomy: null },
  repo: { id: 'repo1', officeAutonomyOptin: true },
  feature: null,
  filer: { tainted: false, trigger: 'cron' },
  spentTodayUsd: 3,
  now: NOW,
});
const baseTask = (): OfficeAutonomyTask & Pick<Task, 'createdByRun' | 'landing'> => ({
  source: 'office',
  officeId: 'o1',
  roleId: 'r1',
  taintedAt: null,
  repoId: 'repo1',
  featureId: null,
  createdByRun: 'run1',
  landing: null,
});
const repoTier = (landing: LandingTier) => ({ landing });

type Case = {
  name: string;
  task?: (t: ReturnType<typeof baseTask>) => void;
  facts?: (f: OfficeAutonomyFacts) => void;
  /** null = granted (the repo's tier stands) */
  why: RegExp | null;
};

const CASES: Case[] = [
  { name: 'every condition holds', why: null },
  { name: 'a feature card of an untainted office feature', task: (t) => { t.source = 'feature'; t.createdByRun = null; t.featureId = 'f1'; }, facts: (f) => { f.feature = { id: 'f1', taintedAt: null }; }, why: null },
  { name: 'the role overrides an auto-run office to autonomous', facts: (f) => { f.office!.autonomy = 'auto-run'; f.role = { id: 'r1', autonomy: 'autonomous' }; }, why: null },
  { name: 'the task is tainted', task: (t) => { t.taintedAt = '2026-11-07T10:00:00Z'; }, why: /task is tainted/ },
  { name: 'its feature is tainted', task: (t) => { t.source = 'feature'; t.featureId = 'f1'; }, facts: (f) => { f.feature = { id: 'f1', taintedAt: '2026-11-07T10:00:00Z' }; }, why: /feature is tainted/ },
  { name: 'its feature is gone', task: (t) => { t.featureId = 'f1'; }, why: /feature is gone/ },
  { name: 'the repo has not opted in', facts: (f) => { f.repo = { id: 'repo1', officeAutonomyOptin: false }; }, why: /not opted in/ },
  { name: 'the repo is unknown', facts: (f) => { f.repo = null; }, why: /no repo/ },
  { name: 'the kill switch is on', facts: (f) => { f.office!.killSwitch = true; }, why: /kill switch/ },
  { name: 'over budget: tripped today', facts: (f) => { f.office!.budgetTrippedOn = officeDay(NOW, 'UTC'); }, why: /over its day budget/ },
  { name: 'over budget: spent ≥ the day budget', facts: (f) => { f.spentTodayUsd = 20; }, why: /over its day budget/ },
  { name: 'no day budget at all', facts: (f) => { f.office!.dayBudgetUsd = 0; }, why: /no day budget/ },
  { name: 'the office is paused', facts: (f) => { f.office!.pausedAt = '2026-11-07T09:00:00Z'; }, why: /paused/ },
  { name: 'the office is off', facts: (f) => { f.office!.enabled = false; }, why: /office is off/ },
  { name: 'the office is auto-run', facts: (f) => { f.office!.autonomy = 'auto-run'; }, why: /autonomy is 'auto-run'/ },
  { name: 'the office is proposals', facts: (f) => { f.office!.autonomy = 'proposals'; }, why: /autonomy is 'proposals'/ },
  { name: 'the role overrides an autonomous office down to auto-run', facts: (f) => { f.role = { id: 'r1', autonomy: 'auto-run' }; }, why: /autonomy is 'auto-run'/ },
  { name: 'its role is gone', facts: (f) => { f.role = null; }, why: /role is gone/ },
  { name: 'filed by a tainted shift', facts: (f) => { f.filer = { tainted: true, trigger: 'cron' }; }, why: /shift it came from was tainted/ },
  { name: 'filed by a signal-woken shift (even an untainted metric signal)', facts: (f) => { f.filer = { tainted: false, trigger: 'signal' }; }, why: /woken by a signal/ },
  { name: 'the filing shift is unknown', facts: (f) => { f.filer = null; }, why: /unknown/ },
  { name: 'a different office', facts: (f) => { f.office!.id = 'o2'; }, why: /office not found/ },
  { name: 'a partial row (taintedAt not read)', task: (t) => { delete (t as Partial<typeof t>).taintedAt; }, why: /incomplete/ },
  { name: 'a non-office source', task: (t) => { (t as { source: string }).source = 'sentry'; }, why: /not an office filing/ },
];

describe('officeAutonomyRefusal + effectiveLanding (table)', () => {
  for (const c of CASES) {
    test(c.name, () => {
      const t = baseTask();
      const f = baseFacts();
      c.task?.(t);
      c.facts?.(f);
      const why = officeAutonomyRefusal(t, f);
      if (c.why === null) assert.equal(why, null);
      else assert.match(why ?? '', c.why);
      for (const tier of ['on-green', 'auto-publish'] as const) {
        assert.equal(effectiveLanding(t, repoTier(tier), f), c.why === null ? tier : 'supervised', `${tier} via the repo`);
        assert.equal(effectiveLanding({ ...t, landing: tier }, repoTier('supervised'), f), c.why === null ? tier : 'supervised', `${tier} via the task`);
      }
    });
  }

  test('no facts → an office task stays clamped', () => {
    assert.equal(effectiveLanding(baseTask(), repoTier('auto-publish')), 'supervised');
    assert.equal(effectiveLanding(baseTask(), repoTier('auto-publish'), null), 'supervised');
  });

  test('a non-office external task is clamped even with granting facts', () => {
    const f = baseFacts();
    const sentry = { ...baseTask(), source: 'sentry' as const, officeId: null, createdByRun: null };
    assert.equal(effectiveLanding(sentry, repoTier('auto-publish'), f), 'supervised');
    const agentFiled = { ...baseTask(), source: 'manual' as const, officeId: null, createdByRun: 'run9' };
    assert.equal(effectiveLanding(agentFiled, repoTier('on-green'), f), 'supervised');
    // and a human task is untouched by the facts either way
    const human = { ...baseTask(), source: 'manual' as const, officeId: null, createdByRun: null };
    assert.equal(effectiveLanding(human, repoTier('on-green')), 'on-green');
  });

  test('a granted task never rises above its own or its repo’s tier', () => {
    assert.equal(effectiveLanding(baseTask(), repoTier('supervised'), baseFacts()), 'supervised');
    assert.equal(effectiveLanding({ ...baseTask(), landing: 'on-green' }, repoTier('auto-publish'), baseFacts()), 'on-green');
  });

  test('landingRefusal follows the same rule', () => {
    assert.equal(landingRefusal(baseTask(), 'on-green', baseFacts()), null);
    assert.equal(landingRefusal(baseTask(), 'supervised'), null);
    const f = baseFacts();
    f.office!.killSwitch = true;
    assert.match(landingRefusal(baseTask(), 'auto-publish', f) ?? '', /autonomy opt-in.*kill switch/);
    assert.match(landingRefusal(baseTask(), 'on-green') ?? '', /autonomy opt-in/);
    assert.match(landingRefusal({ source: 'sentry', createdByRun: null, officeId: null }, 'on-green', baseFacts()) ?? '', /supervised/);
  });
});

// ---- the I/O half -------------------------------------------------------------

let tmp = '';
let storage: SqliteStorage;
let app: FastifyInstance;
const events: ServerEvent[] = [];
let unsubscribe = () => {};
let n = 0;
const ORIGIN = { origin: 'http://127.0.0.1:5173' };

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();
const commit = (cwd: string, file: string, msg: string, trailer?: string) => {
  fs.writeFileSync(path.join(cwd, file), `${msg}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', msg, ...(trailer ? ['-m', `Task: ${trailer}`] : []));
  return git(cwd, 'rev-parse', 'HEAD');
};
/** a bare origin with one commit on main and a clone of it */
function gitRepo(name: string): string {
  const bare = path.join(tmp, `${name}.git`);
  const seed = path.join(tmp, `${name}-seed`);
  const work = path.join(tmp, name);
  git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  git(tmp, 'init', '-q', '-b', 'main', seed);
  commit(seed, 'a.txt', 'first');
  git(seed, 'push', '-q', bare, 'main');
  git(tmp, 'clone', '-q', bare, work);
  return work;
}

interface World {
  office: Office;
  role: OfficeRole;
  repo: Repo;
}

/** an enabled autonomous office over one opted-in repo with the given tier */
async function world(opts: { landing?: LandingTier; optin?: boolean; git?: boolean; autonomy?: Office['autonomy'] } = {}): Promise<World> {
  n += 1;
  const dir = opts.git ? gitRepo(`repo${n}`) : fs.mkdtempSync(path.join(tmp, `repo${n}-`));
  let repo = await storage.createRepo({ name: `repo${n}`, path: dir, landing: opts.landing ?? 'on-green' });
  repo = (await storage.updateRepo(repo.id, { officeAutonomyOptin: opts.optin ?? true }))!;
  const ws = await storage.createWorkspace({ name: `ws${n}`, slug: `ws-${n}`, repoIds: [repo.id], color: null });
  const office = await storage.createOffice({
    workspaceId: ws.id,
    folderPath: path.join(tmp, `office-${n}`),
    timezone: 'UTC',
    enabled: true,
    dayBudgetUsd: 25,
    autonomy: opts.autonomy ?? 'autonomous',
  });
  const role = await storage.createOfficeRole({
    officeId: office.id,
    key: `dev${n}`,
    name: 'Dana',
    avatar: '🛠',
    title: 'Developer',
    prompt: 'build',
    model: 'claude-opus-5-5',
    tools: ['Read'],
    schedules: [],
    triggers: [],
    guards: [],
    notesPath: `roles/dev${n}.md`,
  });
  return { office, role, repo };
}

/** a shift with its aux run, as the runner leaves it */
async function shift(w: World, o: { tainted?: boolean; trigger?: 'cron' | 'signal' | 'request' } = {}) {
  const s = await storage.appendShift({
    officeId: w.office.id,
    roleId: w.role.id,
    trigger: { kind: o.trigger ?? 'cron', ref: null, at: new Date().toISOString() },
    verdict: 'ran',
    tainted: o.tainted ?? false,
  });
  const run = await storage.createRun({ repoId: null, mode: 'aux', kind: 'shift', subjectId: s.id } as any);
  await storage.updateShift(s.id, { runId: run.id });
  return { shiftId: s.id, runId: run.id };
}

/** a task the shift filed, as `fileShiftTasks` writes it */
async function filed(w: World, runId: string, status: Task['status'] = 'queued', over: Record<string, unknown> = {}): Promise<Task> {
  return storage.createTask(
    { title: `office task ${++n}`, repoId: w.repo.id, status, source: 'office', officeId: w.office.id, roleId: w.role.id, createdByRun: runId, taintedAt: null, ...over } as any,
    'office',
  );
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-office-autonomy-'));
  storage = new SqliteStorage(path.join(tmp, 'tm.db'));
  await storage.migrate();
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return reply.code(500).send({ error: String(err) });
  });
  registerRepoRoutes(app, storage);
  registerOfficeRoutes(app, storage);
  await app.ready();
  unsubscribe = onEvent((e) => events.push(e));
});

after(async () => {
  unsubscribe();
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('resolveLanding on a real DB', () => {
  test('a trusted shift’s task in an opted-in repo lands by the repo’s tier', async () => {
    const w = await world();
    const { runId } = await shift(w);
    const t = await filed(w, runId);
    assert.equal(await resolveLanding(storage, t, w.repo), 'on-green');
    const listed = await autonomousOfficeTasks(storage);
    assert.ok(listed.some((a) => a.taskId === t.id && a.landing === 'on-green'));
  });

  test('a tainted or signal-woken shift never grants, nor does a missing opt-in or a non-autonomous office', async () => {
    const w = await world();
    const tainted = await filed(w, (await shift(w, { tainted: true })).runId);
    const signal = await filed(w, (await shift(w, { trigger: 'signal' })).runId);
    const taintedTask = await filed(w, (await shift(w)).runId, 'queued', { taintedAt: '2026-11-07T10:00:00Z' });
    for (const t of [tainted, signal, taintedTask]) assert.equal(await resolveLanding(storage, t, w.repo), 'supervised', t.title);

    const noOptin = await world({ optin: false });
    assert.equal(await resolveLanding(storage, await filed(noOptin, (await shift(noOptin)).runId), noOptin.repo), 'supervised');
    const autoRun = await world({ autonomy: 'auto-run' });
    assert.equal(await resolveLanding(storage, await filed(autoRun, (await shift(autoRun)).runId), autoRun.repo), 'supervised');
  });

  test('a feature card finds its shift through the office.feature row; a tainted feature never grants', async () => {
    const w = await world();
    const { shiftId } = await shift(w);
    const card = async (taintedAt: string | null) => {
      const feature = await storage.createFeature({ repoId: w.repo.id, title: 'F', request: 'r', officeId: w.office.id, taintedAt }, 'office');
      await storage.appendEvent({ kind: 'office.feature', actor: 'office', repoId: w.repo.id, data: { officeId: w.office.id, shiftId, featureId: feature.id } });
      return storage.createTask(
        { title: 'card', repoId: w.repo.id, status: 'queued', source: 'feature', featureId: feature.id, officeId: w.office.id, roleId: w.role.id, taintedAt } as any,
        'test',
      );
    };
    assert.equal(await resolveLanding(storage, await card(null), w.repo), 'on-green');
    assert.equal(await resolveLanding(storage, await card('2026-11-07T10:00:00Z'), w.repo), 'supervised');
  });

  test('a non-office external task in an opted-in repo stays clamped', async () => {
    const w = await world();
    const sentry = await storage.createTask({ title: 'sentry', repoId: w.repo.id, status: 'queued', source: 'sentry' }, 'test');
    assert.equal(await resolveLanding(storage, sentry, w.repo), 'supervised');
    const human = await storage.createTask({ title: 'human', repoId: w.repo.id, status: 'queued' }, 'test');
    assert.equal(await resolveLanding(storage, human, w.repo), 'on-green');
  });

  test('the kill switch drops queued and review office tasks to supervised at once, audited; release restores', async () => {
    const w = await world();
    const { runId } = await shift(w);
    const queued = await filed(w, runId, 'queued');
    const review = await filed(w, runId, 'review');
    const read = async () => Promise.all([queued, review].map(async (t) => resolveLanding(storage, (await storage.getTask(t.id))!, (await storage.getRepo(w.repo.id))!)));
    assert.deepEqual(await read(), ['on-green', 'on-green']);

    const on = await setKillSwitch(storage, w.office.id, true, 'human');
    assert.ok(on.ok && on.changed);
    assert.deepEqual([...on.dropped].sort(), [queued.id, review.id].sort());
    assert.deepEqual(await read(), ['supervised', 'supervised']);
    assert.ok(!(await autonomousOfficeTasks(storage)).some((a) => a.officeId === w.office.id));
    const rows = (await storage.listEvents({ kind: 'office.kill-switch' } as any)).filter((e) => (e.data as any).officeId === w.office.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor, 'human');
    assert.equal((rows[0].data as any).on, true);

    const again = await setKillSwitch(storage, w.office.id, true, 'telegram');
    assert.ok(again.ok && !again.changed, 'pressing it twice changes nothing');

    const off = await setKillSwitch(storage, w.office.id, false, 'telegram');
    assert.ok(off.ok && off.changed);
    assert.deepEqual(await read(), ['on-green', 'on-green']);
    assert.equal((await storage.listEvents({ kind: 'office.kill-switch' } as any)).filter((e) => (e.data as any).officeId === w.office.id).length, 2);
  });

  test('the facts are read lazily: a refusing office never reads the filer', async () => {
    const w = await world({ optin: false });
    const t = await filed(w, (await shift(w)).runId);
    const f = await officeAutonomyFacts(storage, t);
    assert.ok(f && f.filer === null && f.spentTodayUsd === null);
    assert.match(officeAutonomyRefusal(t, f) ?? '', /not opted in/);
  });
});

describe('push-ref auto-approval', () => {
  let service: ApprovalService;
  before(() => {
    service = new ApprovalService({ storage, markPublished: async () => ({ ok: true }), hostPort: 1, supervised: true });
  });

  const runOf = async (t: Task) => storage.createRun({ taskId: t.id, repoId: t.repoId, mode: 'worker' });
  /** a passing review round over these commits, as `runReviewRound` records it */
  const passed = (commits: string[]) => ({
    round: 1,
    at: new Date().toISOString(),
    model: 'claude-fable-5-1',
    effort: null,
    verdict: 'pass',
    summary: 'ok',
    findings: [],
    fixRound: 0,
    diffHash: 'h',
    error: null,
    commits,
  });
  /**
   * Commit (with the task's trailer unless `trailer: null`), settle the
   * verify the way the publish turn finds it — checks off, the review passed
   * over that commit — unless `state` says otherwise, then request the push:
   * a fast-forward of origin's `main` (the repo's default branch, which is
   * what the publish turn ships) unless `to` names another branch or a tag
   * (created on the new commit).
   */
  const push = async (
    w: World,
    t: Task,
    o: { trailer?: string | null; state?: Partial<Task>; reviewed?: (sha: string) => string[]; to?: { branch: string } | { tag: string } } = {},
  ) => {
    const sha = commit(w.repo.path, `f${++n}.txt`, `change ${n}`, o.trailer === undefined ? t.id : o.trailer ?? undefined);
    await storage.updateTask(t.id, { reviewState: 'passed', checkState: null, reviewRounds: [passed(o.reviewed ? o.reviewed(sha) : [sha])] as any, ...o.state });
    const to = o.to ?? { branch: 'main' };
    if ('tag' in to) git(w.repo.path, 'tag', to.tag);
    const target = 'tag' in to ? { tag: to.tag } : { branch: to.branch, sha: 'HEAD' };
    const r = await service.request(await runOf(t), { action: 'push-ref', ...target, reason: 'ship' });
    assert.ok(r.ok, !r.ok ? r.error : '');
    return r.approval;
  };
  const autoRows = async (a: Approval) => (await storage.listEvents({ kind: 'approval.auto' } as any)).filter((e) => (e.data as any).approvalId === a.id);
  const waits = async (a: Approval, label: string) => {
    assert.equal(a.status, 'pending', label);
    assert.equal(a.decidedBy, null, label);
    assert.equal((await autoRows(a)).length, 0, label);
    await service.decide(a.id, false, 'human');
  };

  test('an autonomous office task on auto-publish, verify settled clean, its own reviewed commits: approved without a tap, approval.auto written, the push runs', async () => {
    const w = await world({ landing: 'auto-publish', git: true });
    const t = await filed(w, (await shift(w)).runId, 'running');
    const a = await push(w, t);
    assert.equal(a.decidedBy, 'auto-approve');
    const rows = await autoRows(a);
    assert.equal(rows.length, 1);
    assert.equal((rows[0].data as any).rule, 'office-autonomy');
    assert.equal((rows[0].data as any).officeId, w.office.id);
    const done = await service.wait(a.id, 15_000);
    assert.equal(done?.status, 'done', done?.result ?? '');
  });

  test('without the opt-in, with the kill switch, under on-green, or from a tainted shift it waits for a human', async () => {
    const noOptin = await world({ landing: 'auto-publish', git: true, optin: false });
    const killed = await world({ landing: 'auto-publish', git: true });
    await setKillSwitch(storage, killed.office.id, true, 'human');
    const onGreen = await world({ landing: 'on-green', git: true });
    const taintedShift = await world({ landing: 'auto-publish', git: true });
    const cases: [World, Task][] = [
      [noOptin, await filed(noOptin, (await shift(noOptin)).runId, 'running')],
      [killed, await filed(killed, (await shift(killed)).runId, 'running')],
      [onGreen, await filed(onGreen, (await shift(onGreen)).runId, 'running')],
      [taintedShift, await filed(taintedShift, (await shift(taintedShift, { tainted: true })).runId, 'running')],
    ];
    for (const [w, t] of cases) await waits(await push(w, t), w.repo.name);
  });

  test('requested before the verify settled clean — checks or review pending, mid-turn with no review yet, review off, flagged — it waits', async () => {
    const states: [string, Task['status'], Partial<Task>][] = [
      ['checks pending', 'review', { checkState: 'pending' }],
      ['checks running', 'review', { checkState: 'running' }],
      ['review pending', 'review', { reviewState: 'pending' }],
      ['review reviewing', 'review', { reviewState: 'reviewing' }],
      ['mid-turn, nothing reviewed yet', 'running', { reviewState: null, reviewRounds: [] }],
      ['review off', 'running', { reviewState: null }],
      ['review flagged', 'review', { reviewState: 'flagged' }],
      ['checks red', 'review', { checkState: 'red' }],
    ];
    for (const [label, status, state] of states) {
      const w = await world({ landing: 'auto-publish', git: true }); // its own repo: nothing else unpushed
      const t = await filed(w, (await shift(w)).runId, status);
      await waits(await push(w, t, { state }), label);
    }
  });

  test('a commit without the task’s trailer, another task’s commit, or one the passing review never saw: it waits', async () => {
    const cases: [string, { trailer?: string | null; reviewed?: (sha: string) => string[] }][] = [
      ['no trailer', { trailer: null }],
      ['another task’s trailer', { trailer: '0f0f0f0f-0000-4000-8000-000000000000' }],
      ['committed after the review', { reviewed: () => ['0'.repeat(40)] }],
    ];
    for (const [label, o] of cases) {
      const w = await world({ landing: 'auto-publish', git: true });
      const t = await filed(w, (await shift(w)).runId, 'running');
      await waits(await push(w, t, o), label);
    }
  });

  test('only a fast-forward of the default branch: a new branch, another existing branch, or a new tag waits', async () => {
    const shapes: [string, (w: World) => { branch: string } | { tag: string }][] = [
      ['a new branch', () => ({ branch: `b${n + 1}` })],
      [
        'an existing non-default branch (a release ref)',
        (w) => {
          git(w.repo.path, 'push', '-q', 'origin', 'HEAD:release');
          return { branch: 'release' };
        },
      ],
      ['a new tag', () => ({ tag: `v${n + 1}` })],
    ];
    for (const [label, shape] of shapes) {
      const w = await world({ landing: 'auto-publish', git: true });
      const t = await filed(w, (await shift(w)).runId, 'running');
      const to = shape(w);
      const a = await push(w, t, { to });
      const p = a.params as Extract<ApprovalParams, { action: 'push-ref' }>;
      assert.equal(p.ref, 'tag' in to ? `refs/tags/${to.tag}` : `refs/heads/${to.branch}`, label);
      assert.equal(p.expectedOld === null, label !== 'an existing non-default branch (a release ref)', label); // only `release` is a fast-forward
      await waits(a, label);
    }
  });

  test('a pull-request repo never auto-approves a push (it lands through its own land step)', async () => {
    const w = await world({ landing: 'auto-publish', git: true });
    w.repo = (await storage.updateRepo(w.repo.id, { delivery: 'pr', parallel: 2 }))!;
    const t = await filed(w, (await shift(w)).runId, 'running');
    await waits(await push(w, t), 'pr repo');
  });

  test('rebuild-restart never auto-approves, even for a granted task', async () => {
    const w = await world({ landing: 'auto-publish', git: true });
    const t = await filed(w, (await shift(w)).runId, 'running');
    const r = await service.request(await runOf(t), { action: 'rebuild-restart', reason: 'new code' });
    assert.ok(r.ok, !r.ok ? r.error : '');
    assert.equal(r.approval.status, 'pending');
    assert.equal((await autoRows(r.approval)).length, 0);
    await service.decide(r.approval.id, false, 'human');
  });
});

describe('Origin and audit', () => {
  test('the opt-in needs Origin to turn on, is audited, and turns off from anywhere', async () => {
    const w = await world({ optin: false });
    const id = w.repo.id;
    const no = await app.inject({ method: 'PATCH', url: `/api/repos/${id}`, payload: { officeAutonomyOptin: true } });
    assert.equal(no.statusCode, 403);
    assert.equal((await storage.getRepo(id))!.officeAutonomyOptin, false);

    const yes = await app.inject({ method: 'PATCH', url: `/api/repos/${id}`, payload: { officeAutonomyOptin: true }, headers: ORIGIN });
    assert.equal(yes.statusCode, 200, yes.body);
    assert.equal((await storage.getRepo(id))!.officeAutonomyOptin, true);
    const row = (await storage.listEvents({ kind: 'repo.changed' } as any)).find((e) => e.repoId === id && (e.data as any)?.officeAutonomyOptin);
    assert.deepEqual((row?.data as any)?.officeAutonomyOptin, { from: false, to: true });

    const off = await app.inject({ method: 'PATCH', url: `/api/repos/${id}`, payload: { officeAutonomyOptin: false } });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal((await storage.getRepo(id))!.officeAutonomyOptin, false);

    const create = await app.inject({ method: 'POST', url: '/api/repos', payload: { name: 'x', path: tmp, officeAutonomyOptin: true }, headers: ORIGIN });
    assert.equal(create.statusCode, 400);
  });

  test('the kill switch route needs Origin, is audited, and broadcasts the office', async () => {
    const w = await world();
    const url = `/api/offices/${w.office.id}/kill-switch`;
    const no = await app.inject({ method: 'POST', url, payload: { on: true } });
    assert.equal(no.statusCode, 403);
    assert.equal((await storage.getOffice(w.office.id))!.killSwitch, false);

    const before = events.length;
    const yes = await app.inject({ method: 'POST', url, payload: { on: true }, headers: ORIGIN });
    assert.equal(yes.statusCode, 200, yes.body);
    assert.equal(yes.json().changed, true);
    assert.equal((await storage.getOffice(w.office.id))!.killSwitch, true);
    assert.ok(events.slice(before).some((e) => e.type === 'office.updated' && e.office.id === w.office.id && e.office.killSwitch));
    const rows = (await storage.listEvents({ kind: 'office.kill-switch' } as any)).filter((e) => (e.data as any).officeId === w.office.id);
    assert.equal(rows.length, 1);

    assert.equal((await app.inject({ method: 'POST', url, payload: { on: false } })).statusCode, 403, 'release needs Origin too');
    assert.equal((await app.inject({ method: 'POST', url: '/api/offices/nope/kill-switch', payload: { on: true }, headers: ORIGIN })).statusCode, 404);
  });
});
