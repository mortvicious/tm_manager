// Schedule simulator (docs/schedule.md § Simulator): predictSchedule replays the
// claim pass over virtual time. Run: npm test (node:test through tsx; pure).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  predictSchedule,
  SCHEDULE_PUBLISH_MS,
  SCHEDULE_WAKE_DELAY_MS,
  type PredictedSlot,
  type ScheduleBaseline,
  type ScheduledSlot,
  type ScheduleInput,
  type Task,
} from '@tm/shared';
import { isFeatureTaskBlocking } from './storage/feature-sql.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-10-28T10:00:00.000Z');
const at = (min: number) => new Date(T0 + min * MIN).toISOString();

/** a baseline whose every repo reads work 30 min (p75 45), review 10, checks 5 */
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
const repo = (id: string, over: Partial<RepoIn> = {}): RepoIn => ({
  id,
  name: id,
  parallel: 1,
  delivery: 'direct',
  landing: 'supervised',
  ...over,
});

function predict(over: Partial<ScheduleInput>): PredictedSlot[] {
  return predictSchedule({
    tasks: [],
    repos: [repo('nest'), repo('vite')],
    features: [],
    settings: {
      'orchestrator.enabled': true,
      'orchestrator.paused': false,
      'orchestrator.concurrency': 2,
      'review.enabled': false,
    },
    runs: [],
    baseline: BASELINE,
    now: T0,
    ...over,
  });
}

const slotOf = (slots: PredictedSlot[], id: string): PredictedSlot => {
  const s = slots.find((x) => x.taskId === id);
  assert.ok(s, `no slot for ${id}`);
  return s;
};
const scheduled = (slots: PredictedSlot[], id: string): ScheduledSlot => {
  const s = slotOf(slots, id);
  assert.ok(s.scheduled, `${id} not scheduled: ${JSON.stringify(s.waits)}`);
  return s;
};
const startMin = (s: ScheduledSlot) => (Date.parse(s.start) - T0) / MIN;
const endMin = (s: ScheduledSlot) => (Date.parse(s.end) - T0) / MIN;
const codes = (s: PredictedSlot) => s.waits.map((w) => w.code);

describe('predictSchedule', () => {
  test('queue off: the custom queue still runs, the global queue waits with a reason', () => {
    const slots = predict({
      settings: { 'orchestrator.enabled': false, 'orchestrator.paused': false, 'orchestrator.concurrency': 2 },
      tasks: [task('g', { repoId: 'nest' }), task('m', { repoId: 'vite', customQueueAt: at(-5) })],
    });
    const m = scheduled(slots, 'm');
    assert.equal(m.source, 'custom-queue');
    assert.equal(startMin(m), 0);
    assert.deepEqual(m.waits, []);
    const g = slotOf(slots, 'g');
    assert.equal(g.scheduled, false);
    assert.deepEqual(g.waits, [{ code: 'queue-off', text: 'queue off' }]);
  });

  test('same-repo exclusivity: the second nest task waits for the first, vite goes in parallel', () => {
    const slots = predict({
      tasks: [task('a', { title: 'Fix login' }), task('b'), task('v', { repoId: 'vite' })],
    });
    const a = scheduled(slots, 'a');
    const b = scheduled(slots, 'b');
    const v = scheduled(slots, 'v');
    assert.equal(a.source, 'global');
    assert.equal(startMin(a), 0);
    assert.equal(endMin(a), 30);
    assert.equal(startMin(v), 0, 'another repo claims the second worker slot');
    assert.notEqual(a.lane, v.lane);
    // review off, supervised: the first lands review at 30 and stops holding nest
    assert.equal(startMin(b), 30);
    assert.equal(b.waits[0].code, 'repo');
    assert.equal(b.waits[0].text, 'waits for nest: Fix login running');
    assert.equal(a.lands, 'review');
  });

  test('pr repo with parallel 2 admits two holders, the third waits for a parallel slot', () => {
    const slots = predict({
      repos: [repo('nest', { delivery: 'pr', parallel: 2 })],
      settings: { 'orchestrator.enabled': true, 'orchestrator.paused': false, 'orchestrator.concurrency': 3, 'review.enabled': false },
      tasks: [task('a'), task('b'), task('c')],
    });
    const [a, b, c] = ['a', 'b', 'c'].map((id) => scheduled(slots, id));
    assert.equal(startMin(a), 0);
    assert.equal(startMin(b), 0);
    assert.equal(startMin(c), 30);
    assert.match(c.waits[0].text, /^waits for nest: 2 of 2 parallel slots taken/);
    // a checkout-held repo stays exclusive whatever the cap
    const held = predict({
      repos: [repo('nest', { delivery: 'pr', parallel: 2 })],
      settings: { 'orchestrator.enabled': true, 'orchestrator.paused': false, 'orchestrator.concurrency': 3 },
      tasks: [task('live', { status: 'running', workdir: null }), task('q')],
      runs: [{ id: 'r-live', taskId: 'live', startedAt: at(-10), label: null, mode: 'worker' }],
    });
    assert.ok(startMin(scheduled(held, 'q')) > 0);
  });

  test('a review round holds the repo after each work segment; an open round holds it from now', () => {
    const settings = { 'orchestrator.enabled': true, 'orchestrator.paused': false, 'orchestrator.concurrency': 2, 'review.enabled': true };
    const slots = predict({ settings, tasks: [task('a', { title: 'Add cache' }), task('b')] });
    const a = scheduled(slots, 'a');
    assert.deepEqual(a.after, [{ kind: 'review', start: at(30), end: at(40) }]);
    const b = scheduled(slots, 'b');
    assert.equal(startMin(b), 40, 'b starts once the review round settles');
    assert.ok(b.waits.some((w) => w.text === 'waits for nest: Add cache in review round'));

    // a round already in flight: 4 of its 10 minutes gone
    const open = predict({
      settings,
      tasks: [task('x', { status: 'review', reviewState: 'reviewing', title: 'Ship X' }), task('y')],
      runs: [{ id: 'aux', taskId: null, startedAt: at(-4), label: 'review: Ship X', mode: 'aux', kind: 'review', subjectId: 'x' }],
    });
    const x = scheduled(open, 'x');
    assert.equal(x.lane, null);
    assert.deepEqual(x.after, [{ kind: 'review', start: at(0), end: at(6) }]);
    const y = scheduled(open, 'y');
    assert.equal(startMin(y), 6);
    assert.deepEqual(y.waits, [{ code: 'repo', text: 'waits for nest: Ship X in review round' }]);

    // checks run before the review, and only when the repo has check commands
    const checked = predict({ settings, repoChecks: { nest: ['typecheck'] }, tasks: [task('c')] });
    assert.deepEqual(
      scheduled(checked, 'c').after.map((s) => s.kind),
      ['checks', 'review'],
    );
  });

  test('feature phase gate: phase 2 waits for phase 1 to land; supervised never lands it', () => {
    const feature = { id: 'f1', title: 'Timeline', status: 'running' as const };
    const tasks = () => [
      task('p1', { featureId: 'f1', featurePhase: 1, source: 'feature', title: 'Phase one' }),
      task('p2', { featureId: 'f1', featurePhase: 2, source: 'feature', repoId: 'vite' }),
    ];
    const green = predict({ repos: [repo('nest', { landing: 'on-green' }), repo('vite')], features: [feature], tasks: tasks() });
    const p1 = scheduled(green, 'p1');
    assert.equal(p1.lands, 'done');
    const p2 = scheduled(green, 'p2');
    assert.equal(startMin(p2), 30, 'starts the moment phase 1 lands done');
    assert.deepEqual(p2.waits, [{ code: 'phase', text: 'phase 2 after phase 1' }]);

    const supervised = predict({ features: [feature], tasks: tasks() });
    const waiting = slotOf(supervised, 'p2');
    assert.equal(waiting.scheduled, false);
    assert.equal(waiting.waits.at(-1)!.text, 'phase 2 after phase 1 — Phase one waits for you in review');

    const stopped = predict({ features: [{ ...feature, status: 'paused' }], tasks: tasks() });
    assert.deepEqual(slotOf(stopped, 'p1').waits, [{ code: 'feature', text: 'feature Timeline is paused' }]);

    // the twin moved to shared and is still served from feature-sql.ts
    assert.equal(isFeatureTaskBlocking({ status: 'failed', source: 'feature' }), true);
    assert.equal(isFeatureTaskBlocking({ status: 'draft', source: 'auto' }), false);
  });

  test('paused: nothing starts, live turns keep their ETA, markers resume first once continued', () => {
    const tasks = [
      task('live', { status: 'running', repoId: 'vite' }),
      task('q'),
      task('owed', { status: 'review', repoId: 'vite', pausedTurn: { at: at(-20), kind: 'resume' } }),
    ];
    const runs = [{ id: 'r1', taskId: 'live', startedAt: at(-10), label: null, mode: 'worker' as const }];
    const paused = predict({
      settings: { 'orchestrator.enabled': true, 'orchestrator.paused': true, 'orchestrator.concurrency': 2 },
      tasks,
      runs,
    });
    const live = scheduled(paused, 'live');
    assert.equal(live.source, 'running');
    assert.equal(endMin(live), 20, 'no progress %: baseline 30 − 10 elapsed');
    for (const id of ['q', 'owed']) assert.deepEqual(codes(slotOf(paused, id)), ['paused']);

    // continued at cap 1 with a live turn: the owed marker takes the slot before the claim
    const continued = predict({
      settings: { 'orchestrator.enabled': true, 'orchestrator.paused': false, 'orchestrator.concurrency': 1 },
      tasks: [task('owed2', { status: 'review', repoId: 'vite', pausedTurn: { at: at(-20), kind: 'resume' } }), task('q2')],
    });
    const owed = scheduled(continued, 'owed2');
    assert.equal(owed.source, 'resume');
    assert.equal(startMin(owed), 0);
    const q2 = scheduled(continued, 'q2');
    assert.equal(startMin(q2), 30);
    assert.deepEqual(codes(q2), ['cap']);
  });

  test('wake_at: a parked task resumes at wake time + 90 s; an overdue one at once', () => {
    const slots = predict({
      tasks: [
        task('w', { status: 'review', wakeAt: at(45) }),
        task('late', { status: 'failed', repoId: 'vite', wakeAt: at(-30) }),
      ],
    });
    const w = scheduled(slots, 'w');
    assert.equal(w.source, 'wake');
    assert.equal(Date.parse(w.start), T0 + 45 * MIN + SCHEDULE_WAKE_DELAY_MS);
    assert.deepEqual(codes(w), ['wake']);
    const late = scheduled(slots, 'late');
    assert.equal(startMin(late), 0);
    // the switch off holds a non-member's wake-up
    const off = predict({
      settings: { 'orchestrator.enabled': false, 'orchestrator.paused': false, 'orchestrator.concurrency': 2 },
      tasks: [task('w2', { status: 'review', wakeAt: at(-5) })],
    });
    assert.deepEqual(codes(slotOf(off, 'w2')), ['queue-off']);
    const manual = predict({
      settings: { 'orchestrator.enabled': true, 'orchestrator.paused': false, 'orchestrator.concurrency': 2, 'agent.autoWake': false },
      tasks: [task('w3', { status: 'review', wakeAt: at(-5) })],
    });
    assert.deepEqual(slotOf(manual, 'w3').waits, [{ code: 'wake', text: 'auto wake-up off — waits for Proceed' }]);
  });

  test('agent-filed custom-queue member: held by its filer, then by a failed filer for good', () => {
    const filer = (status: Task['status']) => task('filer', { status, title: 'Backend API', repoId: 'nest' });
    const member = task('child', { customQueueAt: at(-2), createdByRun: 'run-f' });
    const runs = [{ id: 'run-f', taskId: 'filer', startedAt: at(-5), label: null, mode: 'worker' as const }];
    const settings = { 'orchestrator.enabled': false, 'orchestrator.paused': false, 'orchestrator.concurrency': 2, 'review.enabled': true };
    const live = predict({ settings, tasks: [filer('running'), member], runs });
    const c = scheduled(live, 'child');
    // filer's turn ends at 25 (30 − 5 elapsed) and its review round runs to 35
    assert.equal(startMin(c), 35);
    assert.ok(codes(c).includes('repo') || codes(c).includes('filer'));
    assert.ok(c.waits.some((w) => w.text === 'waits for its filer Backend API (in review round)'));

    const failed = predict({ settings, tasks: [filer('failed'), member], runTaskIds: { 'run-f': 'filer' } });
    const f = slotOf(failed, 'child');
    assert.equal(f.scheduled, false);
    assert.deepEqual(f.waits, [{ code: 'filer', text: 'waits for its filer Backend API (failed)' }]);
  });

  test('a running task: remaining = elapsed × (100/pct − 1) over the work band, clamped to the baseline', () => {
    const run = (id: string, startedMin: number, label: string | null = null) => ({
      id: `r-${id}`,
      taskId: id,
      startedAt: at(startedMin),
      label,
      mode: 'worker' as const,
    });
    const slots = predict({
      settings: { 'orchestrator.enabled': true, 'orchestrator.paused': false, 'orchestrator.concurrency': 4 },
      repos: ['a', 'b', 'c', 'd'].map((id) => repo(id)),
      tasks: [
        task('half', { status: 'running', repoId: 'a' }),
        task('slow', { status: 'running', repoId: 'b' }),
        task('pub', { status: 'running', repoId: 'c' }),
        task('over', { status: 'running', repoId: 'd' }),
      ],
      runs: [run('half', -10), run('slow', -10), run('pub', -1, 'publish'), run('over', -50)],
      progress: { half: 35, slow: 7 },
    });
    assert.equal(endMin(scheduled(slots, 'half')), 10, '35% = half the work band: as long again');
    assert.equal(endMin(scheduled(slots, 'slow')), 45, '10% of the band → 90 min, clamped to p75');
    const pub = scheduled(slots, 'pub');
    assert.equal(Date.parse(pub.end), T0 - MIN + SCHEDULE_PUBLISH_MS);
    assert.equal(pub.lands, 'published');
    assert.equal(endMin(scheduled(slots, 'over')), 1, 'past the baseline: the floor, never negative');
  });

  test('drafts, blocked parents and held tasks are listed with their reason; overflow starts a live run’s child past the cap', () => {
    const slots = predict({
      settings: { 'orchestrator.enabled': true, 'orchestrator.paused': false, 'orchestrator.concurrency': 1 },
      tasks: [
        task('d', { status: 'draft' }),
        task('p', { status: 'blocked' }),
        task('h', { queueHeldAt: at(-1), repoId: 'vite' }),
        task('parent', { status: 'running', repoId: 'nest' }),
        task('kid', { repoId: 'vite', createdByRun: 'run-p' }),
        task('other', { repoId: 'vite' }),
      ],
      runs: [{ id: 'run-p', taskId: 'parent', startedAt: at(-1), label: null, mode: 'worker' }],
      pushFailing: [],
    });
    assert.deepEqual(codes(slotOf(slots, 'd')), ['draft']);
    assert.deepEqual(codes(slotOf(slots, 'p')), ['blocked']);
    assert.deepEqual(slotOf(slots, 'h').waits, [{ code: 'held', text: 'held (Undo start)' }]);
    const kid = scheduled(slots, 'kid');
    assert.equal(kid.source, 'overflow');
    assert.equal(startMin(kid), 0);
    assert.deepEqual(kid.waits, []);
    assert.ok(startMin(scheduled(slots, 'other')) > 0);
  });

  test('push failing and the day budget hold claims with their own reason', () => {
    const push = predict({ tasks: [task('a')], pushFailing: ['nest'] });
    assert.deepEqual(slotOf(push, 'a').waits, [{ code: 'push-failing', text: 'push failing (nest)' }]);
    const day = predict({ tasks: [task('a'), task('m', { repoId: 'vite', customQueueAt: at(-1) })], dayBudgetReached: true });
    assert.deepEqual(codes(slotOf(day, 'a')), ['day-budget']);
    assert.deepEqual(codes(slotOf(day, 'm')), ['day-budget']);
  });
});
