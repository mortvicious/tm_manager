// Schedule prediction accuracy (docs/timeline.md § Prediction accuracy): the
// claim replay over a synthetic audit log. Run: npm test (node:test through tsx).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import Fastify from 'fastify';
import {
  replayClaims,
  type AuditEvent,
  type AuditKind,
  type ReplayInput,
  type Run,
  type ScheduleBaseline,
  type ScheduleInput,
  type Task,
} from '@tm/shared';
import { registerTimelineRoutes, resetAccuracyCache } from './routes/timeline.ts';
import { SqliteStorage } from './storage/sqlite.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-10-20T10:00:00.000Z');
const at = (min: number) => new Date(T0 + min * MIN).toISOString();

/** every repo reads work 30 min */
const BASELINE: ScheduleBaseline = {
  byRepo: {},
  all: { workMs: { median: 30 * MIN, p75: 45 * MIN }, reviewMs: 10 * MIN, checkMs: 5 * MIN, n: 20 },
  windowDays: 90,
  computedAt: at(0),
};


let order = 0;
function task(id: string, over: Partial<Task> = {}): Task {
  order++;
  return {
    id,
    title: `Task ${id}`,
    description: null,
    repoId: 'nest',
    parentId: null,
    groupId: id,
    groupPath: '/',
    groupName: null,
    groupColor: null,
    status: 'queued',
    source: 'manual',
    sourceRef: null,
    priority: 0,
    sortOrder: order,
    model: null,
    effort: null,
    category: null,
    createdByRun: null,
    spawnDepth: 0,
    featureId: null,
    featurePhase: null,
    brief: null,
    resultSummary: null,
    review: null,
    reviewModel: null,
    reviewEffort: null,
    landing: null,
    autoLandedAt: null,
    shippedSha: null,
    shippedAt: null,
    workdir: null,
    branch: null,
    prNumber: null,
    prUrl: null,
    prState: null,
    worktreeEvictedAt: null,
    worktreeBase: null,
    customQueueAt: null,
    reviewSummary: null,
    reviewDiffHash: null,
    baseSha: null,
    baseRef: null,
    baseAt: null,
    reviewState: null,
    reviewRounds: [],
    wakeAt: null,
    queueHeldAt: null,
    pausedTurn: null,
    hiddenAt: null,
    inboxKeptUntil: null,
    costUsd: 0,
    attempts: 0,
    acceptance: null,
    checks: null,
    checkState: null,
    checkResults: [],
    checkDiffHash: null,
    kind: 'task',
    loopGoal: null,
    loopMaxIterations: null,
    loopBudgetUsd: null,
    loopIteration: 0,
    loopState: null,
    loopHistory: [],
    error: null,
    createdAt: at(-100 + order),
    updatedAt: at(-100 + order),
    ...over,
  };
}

type RepoIn = ScheduleInput['repos'][number];
const repo = (id: string): RepoIn => ({ id, name: id, parallel: 1, delivery: 'direct', landing: 'supervised' });

// ── audit rows in the shapes the server writes ─────────────────────────────

let seq = 0;
function ev(kind: AuditKind, when: string, taskId: string | null, data: Record<string, unknown>, extra: Partial<AuditEvent> = {}): AuditEvent {
  // the server's id shape: ms hex + per-ms sequence (time-sortable, insertion order within a ms)
  const id = `${Date.parse(when).toString(16).padStart(12, '0')}${(seq++).toString(16).padStart(4, '0')}-test`;
  return { id, at: when, kind, actor: 'system', taskId, runId: null, repoId: null, data, ...extra };
}
const tr = (when: string, taskId: string, from: string, to: string, more: Record<string, unknown> = {}, actor = 'system') =>
  ev('task.transition', when, taskId, { ...more, from, to }, { actor });
const claim = (when: string, taskId: string, kind: 'base' | 'custom-queue' | 'overflow') =>
  tr(when, taskId, 'queued', 'running', { claim: kind }, 'orchestrator');
const queueAdd = (when: string, taskId: string) => ev('task.queue', when, taskId, { queue: 'custom', action: 'add' }, { actor: 'human' });

function run(id: string, taskId: string | null, startedAt: string, endedAt: string | null, over: Partial<Run> = {}): Run {
  return {
    id, taskId, repoId: null, mode: 'worker', kind: 'worker', subjectId: null, label: null,
    status: endedAt ? 'exited' : 'running', pid: null, exitCode: null, needsAttention: false, idle: false,
    model: null, effort: null, sessionId: null, transcriptPath: null, stats: null, resumedFrom: null,
    statsBaseline: null, startedAt, endedAt, ...over,
  };
}

/**
 * The fixture day, every claim one the server's own pass would make:
 *  T0  queue switched on
 *  T1  B (nest, priority 1) beats A (nest) by priority; C (vite) next — two base claims in one pass
 *  T10 B parks in review with a round pending; the round passes at T14 → A claimed (nest free again)
 *  T15/T16 D (nest) and E (vite) join the custom queue
 *  T20 C lands idle in review → E claimed from the custom queue (D waits: A runs in nest)
 *  T30 A parks with checks pending; green at T35 → D claimed from the custom queue
 *  T40 E's session files F (kit); D + E fill the cap of 2 → F claimed by the overflow claim at T41
 *  T44–T46 Pause all and Continue
 *  T42 G (kit, priority 5) queued; F lands at T50 → G claimed
 *  T52 Undo start puts G back, HELD; T53 H (kit) queued → H claimed past the held G
 *  T60 B is done
 */
function fixture(): ReplayInput {
  seq = 0;
  order = 0;
  const tasks: Task[] = [
    task('A', { repoId: 'nest', status: 'review' }),
    task('B', { repoId: 'nest', status: 'done', priority: 1 }),
    task('C', { repoId: 'vite', status: 'review' }),
    task('D', { repoId: 'nest', status: 'review', customQueueAt: at(15) }),
    task('E', { repoId: 'vite', status: 'running', customQueueAt: at(16) }),
    task('F', { repoId: 'kit', status: 'review', createdByRun: 'rE', source: 'auto', createdAt: at(40), updatedAt: at(50) }),
    task('G', { repoId: 'kit', status: 'queued', priority: 5, queueHeldAt: at(52) }),
    task('H', { repoId: 'kit', status: 'running' }),
  ];
  const events: AuditEvent[] = [
    ev('orchestrator.toggle', at(0), null, { enabled: true }, { actor: 'human' }),
    tr(at(0.5), 'A', 'draft', 'queued', {}, 'human'),
    tr(at(0.5), 'B', 'draft', 'queued', {}, 'human'),
    tr(at(0.5), 'C', 'draft', 'queued', {}, 'human'),
    claim(at(1), 'B', 'base'),
    claim(at(1), 'C', 'base'),
    tr(at(10), 'B', 'running', 'review', { reviewState: 'pending', checkState: null }),
    ev('run.reviewed', at(14), 'B', { verdict: 'clean', findings: [], round: 1, fixRound: 0, state: 'passed' }),
    claim(at(14), 'A', 'base'),
    tr(at(15), 'D', 'draft', 'queued', {}, 'human'),
    queueAdd(at(15), 'D'),
    tr(at(16), 'E', 'draft', 'queued', {}, 'human'),
    queueAdd(at(16), 'E'),
    tr(at(20), 'C', 'running', 'review', { reviewState: null, checkState: null }),
    claim(at(20), 'E', 'custom-queue'),
    tr(at(30), 'A', 'running', 'review', { reviewState: null, checkState: 'pending' }),
    ev('task.checked', at(35), 'A', { state: 'green', results: [{ name: 'test', ok: true, durationMs: 5 * MIN }] }),
    claim(at(35), 'D', 'custom-queue'),
    ev('task.created', at(40), 'F', { status: 'queued' }, { actor: 'agent' }),
    claim(at(41), 'F', 'overflow'),
    tr(at(42), 'G', 'draft', 'queued', {}, 'human'),
    ev('orchestrator.pause', at(44), null, { paused: true }, { actor: 'human' }),
    ev('orchestrator.pause', at(46), null, { paused: false }, { actor: 'human' }),
    tr(at(48), 'D', 'running', 'review', { reviewState: null, checkState: null }),
    tr(at(50), 'F', 'running', 'review', { reviewState: null, checkState: null }),
    claim(at(50), 'G', 'base'),
    tr(at(52), 'G', 'running', 'queued', {}, 'human'),
    ev('task.undo', at(52), 'G', { action: 'undo', from: 'running', to: 'queued', held: true }, { actor: 'human' }),
    tr(at(53), 'H', 'draft', 'queued', {}, 'human'),
    claim(at(53), 'H', 'base'),
    tr(at(60), 'B', 'review', 'done', { reason: 'marked done' }, 'human'),
    ev('run.stats-final', at(9), 'B', {}, { runId: 'rB' }),
  ];
  const runs: Run[] = [
    run('rB', 'B', at(1.01), at(10)),
    run('rvB', null, at(10.01), at(14), { mode: 'aux', kind: 'review', subjectId: 'B' }),
    run('rC', 'C', at(1.02), at(20)),
    run('rA', 'A', at(14.01), at(30)),
    run('rE', 'E', at(20.01), null),
    run('rD', 'D', at(35.01), at(48)),
    run('rF', 'F', at(41.01), at(50)),
    run('rG', 'G', at(50.01), at(52)),
    run('rH', 'H', at(53.01), null),
  ];
  return {
    tasks,
    repos: [repo('nest'), repo('vite'), repo('kit')],
    features: [],
    // the CURRENT settings: the log says the queue was off before T0
    settings: { 'orchestrator.enabled': true, 'orchestrator.paused': false, 'orchestrator.concurrency': 2, 'review.enabled': false },
    events,
    runs,
    baseline: BASELINE,
    since: at(0),
    until: at(70),
  };
}

describe('replayClaims', () => {
  test('a synthetic log of server-made claims replays at 100%', () => {
    const r = replayClaims(fixture());
    assert.deepEqual(r.mismatches, []);
    assert.equal(r.total, 8);
    assert.equal(r.matched, 8);
    assert.equal(r.rate, 1);
    assert.deepEqual(r.byClaimKind, {
      base: { total: 5, matched: 5, rate: 1 },
      'custom-queue': { total: 2, matched: 2, rate: 1 },
      overflow: { total: 1, matched: 1, rate: 1 },
    });
    assert.ok(r.contested.total >= 3, 'the priority, review-round and hold claims are real choices');
    assert.equal(r.contested.rate, 1);
    assert.equal(r.skipped, 0);
  });

  test('a claim the simulator would not make is a mismatch with its reason', () => {
    const input = fixture();
    // A claimed while B's review round is still open (the round passes at T14)
    const events = [...input.events];
    const i = events.findIndex((e) => e.taskId === 'A' && e.data?.claim === 'base');
    events[i] = { ...events[i], id: `${Date.parse(at(12)).toString(16).padStart(12, '0')}0000-test`, at: at(12) };
    input.events = events;
    const r = replayClaims(input);
    assert.equal(r.matched, 7);
    assert.equal(r.byClaimKind.base.matched, 4);
    assert.equal(r.mismatches.length, 1);
    const m = r.mismatches[0];
    assert.equal(m.at, at(12));
    assert.deepEqual(m.actual, { taskId: 'A', title: 'Task A', claim: 'base' });
    assert.equal(m.predicted?.taskId, 'A'); // after the round: two minutes later
    assert.match(m.reason, /later \(global\) — waits for nest: Task B in review round/);
  });

  test('without its hold row the held task is predicted instead', () => {
    const input = fixture();
    input.events = input.events.filter((e) => e.kind !== 'task.undo');
    const r = replayClaims(input);
    assert.equal(r.mismatches.length, 1);
    assert.equal(r.mismatches[0].actual.taskId, 'H');
    assert.equal(r.mismatches[0].predicted?.taskId, 'G');
    assert.match(r.mismatches[0].reason, /^predicted global claim of "Task G" instead/);
  });

  test('a claim of a deleted task is skipped, not counted', () => {
    const input = fixture();
    input.tasks = input.tasks.filter((t) => t.id !== 'H');
    const r = replayClaims(input);
    assert.equal(r.skipped, 1);
    assert.equal(r.total, 7);
  });

  test('mismatches are capped, the total is not', () => {
    const input = { ...fixture(), mismatchCap: 0 };
    input.settings = { ...input.settings, 'orchestrator.concurrency': 1 };
    const r = replayClaims(input);
    assert.ok(r.mismatchesTotal > 0);
    assert.deepEqual(r.mismatches, []);
  });

  test('worked duration: the simulator\'s work segment against the runs of tasks landed in the window', () => {
    const r = replayClaims(fixture());
    // only B landed (T60): worked T1.01 → its first idle at T9, predicted the 30-min median
    const worked = Date.parse(at(9)) - Date.parse(at(1.01));
    assert.equal(r.duration.n, 1);
    assert.equal(r.duration.medianActualMs, worked);
    assert.equal(r.duration.medianPredictedMs, 30 * MIN);
    assert.equal(r.duration.medianAbsErrorMs, 30 * MIN - worked);
    assert.equal(r.duration.medianErrorMs, 30 * MIN - worked);
  });
});

describe('GET /api/schedule/accuracy', () => {
  let tmp: string;
  let storage: SqliteStorage;
  const app = Fastify();
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-accuracy-'));
    storage = new SqliteStorage(path.join(tmp, 'tm.db'));
    await storage.migrate();
    registerTimelineRoutes(app, storage);
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('days is an integer from 1 to 31', async () => {
    for (const days of ['0', '32', '1.5', 'x']) {
      const res = await app.inject({ method: 'GET', url: `/api/schedule/accuracy?days=${days}` });
      assert.equal(res.statusCode, 400, days);
    }
  });

  test('a real claim through the storage driver replays', async () => {
    const r = await storage.createRepo({ name: 'nest', path: tmp });
    const t = await storage.createTask({ title: 'only', repoId: r.id, status: 'queued' }, 'human');
    const claimed = await storage.claimNextQueuedTask('orchestrator');
    assert.equal(claimed?.id, t.id);
    await storage.setSetting('orchestrator.enabled', true);
    const res = await app.inject({ method: 'GET', url: '/api/schedule/accuracy' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.total, 1);
    assert.equal(body.byClaimKind.base.matched, 1);
    assert.equal(body.duration.n, 0);
    assert.ok(body.approximations.length > 0);
  });

  test('a replay is cached per days and recomputed once the cache is reset', async () => {
    resetAccuracyCache();
    const first = (await app.inject({ method: 'GET', url: '/api/schedule/accuracy?days=7' })).json();
    const r = (await storage.listRepos())[0];
    await storage.createTask({ title: 'second', repoId: r.id, status: 'queued' }, 'human');
    await storage.transitionTask((await storage.listTasks({ status: 'running' }))[0].id, ['running'], 'done', 'human');
    assert.ok(await storage.claimNextQueuedTask('orchestrator'));
    // two concurrent callers share one computation; both still see the cached answer
    const [a, b] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/schedule/accuracy?days=7' }),
      app.inject({ method: 'GET', url: '/api/schedule/accuracy?days=7' }),
    ]);
    assert.equal(a.json().total, first.total);
    assert.equal(b.json().total, first.total);
    resetAccuracyCache();
    const fresh = (await app.inject({ method: 'GET', url: '/api/schedule/accuracy?days=7' })).json();
    assert.equal(fresh.total, first.total + 1);
    assert.equal(fresh.matched, fresh.total);
  });
});
