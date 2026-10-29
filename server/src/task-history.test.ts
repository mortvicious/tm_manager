// Task History steps + the widened /api/tasks/:id/history (docs/timeline.md § Task history).
// Run: npm test   (node:test through tsx; a temp SQLite DB)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  buildTaskHistory,
  buildTaskSegments,
  HISTORY_EVENT_KINDS,
  historyTotals,
  sortEvents,
  TIMELINE_EVENT_KINDS,
  TIMELINE_ROW_CAP,
  type AuditEvent,
  type AuditKind,
  type Dispatch,
  type HistoryStep,
  type Run,
  type RunStats,
  type Task,
  type TimelineSegment,
} from '@tm/shared';
import { loadTaskHistory, loadTimeline } from './routes/timeline.ts';
import { SqliteStorage } from './storage/sqlite.ts';
import type { Storage } from './storage/types.ts';

const BASE = Date.parse('2026-10-01T10:00:00.000Z');
/** minute n of the fixture day */
const T = (n: number) => new Date(BASE + n * 60_000).toISOString();
const MIN = 60_000;
let seq = 0;
function ev(kind: AuditKind, at: string, taskId: string, data: Record<string, unknown>, extra: Partial<AuditEvent> = {}): AuditEvent {
  const id = `${Date.parse(at).toString(16).padStart(12, '0')}${(seq++).toString(16).padStart(3, '0')}-test`;
  return { id, at, kind, actor: 'system', taskId, runId: null, repoId: 'repo-1', data, ...extra };
}
const tr = (at: string, taskId: string, from: string | null, to: string, more: Record<string, unknown> = {}, extra: Partial<AuditEvent> = {}) =>
  ev('task.transition', at, taskId, { ...more, from, to }, extra);
const started = (at: string, taskId: string, runId: string, handoff = 'fresh') =>
  ev('run.started', at, taskId, { handoff, model: 'claude-opus-5-5' }, { runId, actor: 'orchestrator' });
const stats = (costUsd: number, tokens: number): RunStats => ({
  inputTokens: tokens / 2,
  outputTokens: tokens / 4,
  cacheReadTokens: tokens / 8,
  cacheWriteTokens: tokens / 8,
  costUsd,
  contextPct: 0,
  contextTokens: 0,
});
function run(id: string, taskId: string, startedAt: string, endedAt: string | null, over: Partial<Run> = {}): Run {
  return {
    id, taskId, repoId: 'repo-1', mode: 'worker', kind: 'worker', subjectId: null, label: null,
    status: endedAt ? 'exited' : 'running', pid: null, exitCode: null, needsAttention: false, idle: false,
    model: 'claude-opus-5-5', effort: null, sessionId: null, transcriptPath: null, stats: null, resumedFrom: null,
    statsBaseline: null, startedAt, endedAt, ...over,
  };
}
const review = (id: string, taskId: string, startedAt: string, endedAt: string, cost: number) =>
  run(id, null as unknown as string, startedAt, endedAt, { taskId: null, mode: 'aux', kind: 'review', subjectId: taskId, stats: stats(cost, 800) });
const task = (id: string, over: Partial<Task> = {}) =>
  ({ id, createdAt: T(0), createdByRun: null, spawnDepth: 0, source: 'manual', status: 'done', error: null, ...over }) as Task;

function history(t: Task, events: AuditEvent[], runs: Run[], dispatches?: Dispatch[], now = T(120)) {
  const segments = buildTaskSegments(events, runs, { since: T(0), until: now, now })[t.id] ?? [];
  return { segments, steps: buildTaskHistory({ task: t, events, runs, segments, dispatches, now }) };
}
const kinds = (steps: HistoryStep[]) => steps.map((s) => s.kind);
const one = (steps: HistoryStep[], pred: (s: HistoryStep) => boolean) => {
  const hit = steps.filter(pred);
  assert.equal(hit.length, 1, `exactly one step: ${JSON.stringify(hit)}`);
  return hit[0];
};

describe('buildTaskHistory', () => {
  test('a full life: created → claimed → run → review flagged → fix → review passed → done', () => {
    const events = [
      ev('task.created', T(0), 'A', { title: 'a', status: 'queued', source: 'manual', spawnDepth: 0 }, { actor: 'human' }),
      tr(T(1), 'A', 'queued', 'running', { claim: 'base' }, { actor: 'orchestrator' }),
      started(T(1), 'A', 'rA1'),
      tr(T(10), 'A', 'running', 'review', { runId: 'rA1', reviewState: 'pending', checkState: null }, { actor: 'hook' }),
      ev('run.reviewed', T(14), 'A', { model: 'claude-fable-5-1', verdict: 'blocker', findings: [{}, {}], actionable: 2, round: 1, fixRound: 0, state: 'fixing' }),
      ev('task.follow-up', T(15), 'A', { reason: 'adversarial-review', round: 1, actionable: 2 }),
      tr(T(15), 'A', 'review', 'running'),
      ev('task.follow-up', T(15), 'A', { delivery: 'resume', resumedFrom: 'rA1', purpose: 'work', chars: 300 }),
      started(T(15), 'A', 'rA2', 'resume'),
      tr(T(20), 'A', 'running', 'review', { runId: 'rA2', reviewState: 'pending', checkState: null }, { actor: 'hook' }),
      ev('run.reviewed', T(24), 'A', { model: 'claude-fable-5-1', verdict: 'clean', findings: [], round: 2, fixRound: 1, state: 'passed' }),
      tr(T(30), 'A', 'review', 'done', { landing: 'on-green', reason: 'checks green, review clean' }, { actor: 'orchestrator' }),
    ];
    const runs = [
      // the PTYs stay attachable, idle, until the landing closes them: endedAt is NOT the worked time
      run('rA1', 'A', T(1), T(30), { stats: stats(1.5, 4000) }),
      review('rv1', 'A', T(10), T(14), 0.25),
      run('rA2', 'A', T(15), T(30), { resumedFrom: 'rA1', stats: stats(0.5, 2000) }),
      review('rv2', 'A', T(20), T(24), 0.25),
    ];
    const { steps } = history(task('A'), events, runs);
    assert.deepEqual(kinds(steps), ['created', 'queued', 'claimed', 'run', 'review', 'fix', 'review', 'landed']);

    const [created, queued, claimed, first, flagged, fix, passed, landed] = steps;
    assert.equal(created.actor, 'human');
    assert.equal(created.label, 'created');
    assert.equal(queued.durationMs, MIN);
    assert.equal(claimed.label, 'claimed from the queue');
    assert.equal(claimed.durationMs, 0);

    // worked time from the running segment (T1..T10), cost/tokens from the run row
    assert.deepEqual([first.at, first.end, first.durationMs, first.costUsd, first.tokens, first.runId], [T(1), T(10), 9 * MIN, 1.5, 4000, 'rA1']);
    assert.match(first.detail!, /fresh/);

    assert.deepEqual([flagged.at, flagged.end, flagged.durationMs, flagged.costUsd, flagged.tokens, flagged.runId], [T(10), T(14), 4 * MIN, 0.25, 800, 'rv1']);
    assert.equal(flagged.tone, 'warn');
    assert.match(flagged.label, /round 1: fixing/);
    assert.match(flagged.detail!, /2 findings/);
    assert.match(flagged.detail!, /claude-fable-5-1/);

    assert.deepEqual([fix.at, fix.end, fix.durationMs, fix.costUsd, fix.runId], [T(15), T(20), 5 * MIN, 0.5, 'rA2']);
    assert.equal(fix.label, 'fix turn (review findings)');
    assert.match(fix.detail!, /resume/);
    assert.match(fix.detail!, /round 1/);

    assert.equal(passed.tone, 'good');
    assert.equal(passed.runId, 'rv2');
    assert.equal(landed.label, 'auto-landed: done');
    assert.match(landed.detail!, /on-green/);

    const totals = historyTotals(steps, runs);
    assert.deepEqual(totals, { wallMs: 30 * MIN, workedMs: 14 * MIN, costUsd: 2.5, attempts: 1 });
  });

  test('a run retired idle (status killed, no run.killed row) is not a cut turn', () => {
    const events = [
      tr(T(1), 'K', 'queued', 'running', { claim: 'base' }),
      started(T(1), 'K', 'rK1'),
      tr(T(10), 'K', 'running', 'review', { runId: 'rK1', reviewState: null }),
      // followUp retires the idle rK1 (status killed, no audit row) and resumes as rK2
      tr(T(15), 'K', 'review', 'running'),
      started(T(15), 'K', 'rK2', 'resume'),
      tr(T(20), 'K', 'running', 'review', { runId: 'rK2', reviewState: null }),
      tr(T(25), 'K', 'review', 'running'),
      started(T(25), 'K', 'rK3', 'resume'),
      // a cancel mid-turn: run.killed, then the PTY ends with the turn open
      ev('run.killed', T(27), 'K', {}, { runId: 'rK3', actor: 'human' }),
      tr(T(27), 'K', 'running', 'cancelled', { reason: 'not needed' }, { actor: 'human' }),
      // a turn cut with no row (killed while running, its segment still open at endedAt)
      tr(T(30), 'K', 'cancelled', 'queued'),
      tr(T(31), 'K', 'queued', 'running', { claim: 'base' }),
      started(T(31), 'K', 'rK4'),
    ];
    const runs = [
      run('rK1', 'K', T(1), T(15), { status: 'killed' }),
      run('rK2', 'K', T(15), T(25), { status: 'killed', resumedFrom: 'rK1' }),
      run('rK3', 'K', T(25), T(27), { status: 'killed', resumedFrom: 'rK2' }),
      run('rK4', 'K', T(31), T(35), { status: 'killed' }),
    ];
    const { steps } = history(task('K', { status: 'running' }), events, runs);
    const turns = steps.filter((s) => s.kind === 'run');
    assert.deepEqual(turns.map((s) => s.runId), ['rK1', 'rK2', 'rK3', 'rK4']);
    assert.deepEqual(turns.map((s) => /killed/.test(s.detail ?? '')), [false, false, true, true]);
    assert.deepEqual(turns.map((s) => s.tone), ['neutral', 'neutral', 'warn', 'warn']);
  });

  test('retry, undo/release, wake, transient, questions, dispatches both ways', () => {
    const SECRET = 'hunter2-very-secret';
    const events = [
      ev('task.created', T(0), 'B', { status: 'draft', source: 'auto', spawnDepth: 2 }, { actor: 'agent:rX000000' }),
      ev('agent.create', T(0), 'B', { requestedEnqueue: true, effectiveStatus: 'queued', note: null }, { actor: 'agent:rX000000', runId: 'rX000000-run' }),
      tr(T(0), 'B', 'draft', 'queued'),
      tr(T(1), 'B', 'queued', 'running', { claim: 'custom-queue' }, { actor: 'orchestrator' }),
      started(T(1), 'B', 'rB1'),
      ev('question.asked', T(3), 'B', { questionId: 'q1', questions: ['Which database should I use?'] }, { actor: 'hook', runId: 'rB1' }),
      ev('question.answered', T(5), 'B', { questionId: 'q1', answers: { 'Which database should I use?': SECRET } }, { actor: 'human' }),
      ev('question.asked', T(5), 'B', { questionId: 'q2', questions: ['Ship it?'] }, { actor: 'hook', runId: 'rB1' }),
      ev('question.autopilot', T(5), 'B', { questionId: 'q2', action: 'skipped', reason: 'outward word', waitedMs: 1000 }),
      ev('question.expired', T(6), 'B', { questionId: 'q2', note: 'the run ended' }),
      ev('run.stop-failure', T(6), 'B', { code: 'rate_limit', action: 'left-to-wake', resumesUsed: 0 }, { actor: 'hook', runId: 'rB1' }),
      tr(T(6), 'B', 'running', 'review', { reviewState: null }, { actor: 'hook' }),
      ev('task.wake', T(6), 'B', { action: 'parked', wakeAt: T(20), status: 'review' }),
      ev('task.wake', T(20), 'B', { action: 'resumed' }),
      tr(T(20), 'B', 'review', 'running'),
      started(T(20), 'B', 'rB2', 'resume'),
      ev('run.transient-retry', T(22), 'B', { action: 'resumed', attempt: 1, code: 'overloaded', delivery: 'typed' }, { runId: 'rB2' }),
      ev('run.auto-compact', T(23), 'B', { trigger: 'auto', contextTokens: 267_000 }, { runId: 'rB2' }),
      tr(T(25), 'B', 'running', 'failed', {}, { actor: 'system' }),
      ev('task.retry', T(30), 'B', { via: 'enqueue', from: 'failed', previousError: 'boom: exit 1' }, { actor: 'human' }),
      tr(T(30), 'B', 'failed', 'queued', {}, { actor: 'human' }),
      tr(T(31), 'B', 'queued', 'running', { claim: 'base' }, { actor: 'orchestrator' }),
      started(T(31), 'B', 'rB3'),
      ev('run.killed', T(32), 'B', {}, { runId: 'rB3', actor: 'human' }),
      tr(T(32), 'B', 'running', 'queued', {}, { actor: 'human' }),
      ev('task.undo', T(32), 'B', { action: 'undo', from: 'running', to: 'queued', held: true, killedRuns: 1 }, { actor: 'human' }),
      ev('task.undo', T(33), 'B', { action: 'release', queue: 'global' }, { actor: 'human' }),
      // the receiver's audit row of the dispatch it received
      ev('task.dispatch', T(40), 'B', { phase: 'created', dispatchId: 'd2', fromTaskId: 'DDDDDDDD-from', intent: 'fyi', chars: 40 }, { actor: 'agent:rD' }),
    ];
    const runs = [
      run('rB1', 'B', T(1), T(6), { stats: stats(0.4, 1000) }),
      run('rB2', 'B', T(20), T(25), { resumedFrom: 'rB1', stats: stats(0.6, 1000), exitCode: 1 }),
      run('rB3', 'B', T(31), T(32), { status: 'killed', stats: stats(0.1, 100) }),
    ];
    const dispatches: Dispatch[] = [
      { id: 'd1', fromTaskId: 'B', fromRunId: 'rB1', toTaskId: 'CCCCCCCC-to', message: 'please', intent: 'needs_action', status: 'delivered', note: null, createdAt: T(4), deliveredAt: T(8) },
      { id: 'd2', fromTaskId: 'DDDDDDDD-from', fromRunId: 'rD', toTaskId: 'B', message: 'fyi', intent: 'fyi', status: 'pending', note: null, createdAt: T(40), deliveredAt: null },
    ];
    const b = task('B', { createdByRun: 'rX000000-run', spawnDepth: 2, source: 'auto', status: 'queued' });
    const { steps } = history(b, events, runs, dispatches);
    for (const k of ['created', 'claimed', 'run', 'question', 'dispatch', 'stop-failure', 'wake', 'transient', 'auto-compact', 'failed', 'retry', 'undo', 'release'] as const) {
      assert.ok(steps.some((s) => s.kind === k), `has a ${k} step`);
    }

    // never the answer text, anywhere
    assert.ok(!JSON.stringify(steps).includes(SECRET), 'no answer text on any step');

    const created = steps[0];
    assert.equal(created.label, 'filed by an agent');
    assert.match(created.detail!, /run rX000000/);
    assert.match(created.detail!, /depth 2/);
    assert.equal(created.runId, 'rX000000-run');

    const q1 = one(steps, (s) => s.kind === 'question' && s.at === T(3));
    assert.deepEqual([q1.label, q1.end, q1.durationMs, q1.actor, q1.runId], ['question answered', T(5), 2 * MIN, 'human', 'rB1']);
    assert.match(q1.detail!, /Which database/);
    const q2 = one(steps, (s) => s.kind === 'question' && s.at === T(5));
    assert.equal(q2.label, 'question expired');
    assert.match(q2.detail!, /autopilot skipped: outward word/);

    const sent = one(steps, (s) => s.kind === 'dispatch' && s.label.startsWith('dispatch sent'));
    assert.deepEqual([sent.label, sent.at, sent.end, sent.durationMs, sent.runId], ['dispatch sent to CCCCCCCC', T(4), T(8), 4 * MIN, 'rB1']);
    assert.match(sent.detail!, /needs action · delivered/);
    const got = one(steps, (s) => s.kind === 'dispatch' && s.label.startsWith('dispatch received'));
    assert.deepEqual([got.label, got.end], ['dispatch received from DDDDDDDD', null]);
    assert.match(got.detail!, /fyi · pending/);
    assert.equal(got.durationMs, 80 * MIN, 'an open step measured to `now`');

    // without the dispatch list only the received one is known (from the receiver's row)
    const fallback = buildTaskHistory({ task: b, events, runs, segments: [] });
    assert.deepEqual(fallback.filter((s) => s.kind === 'dispatch').map((s) => s.label), ['dispatch received from DDDDDDDD']);

    const wakes = steps.filter((s) => s.kind === 'wake');
    assert.deepEqual(wakes.map((s) => s.label), ['parked on the usage limit', 'woken after the limit']);
    assert.match(wakes[0].detail!, new RegExp(`until ${T(20)}`));
    assert.equal(one(steps, (s) => s.kind === 'stop-failure').label, 'stopped on rate_limit');
    assert.equal(one(steps, (s) => s.kind === 'transient').label, 'API error overloaded: resumed');
    assert.match(one(steps, (s) => s.kind === 'auto-compact').detail!, /267k tokens/);

    // the failure's error comes from the retry that cleared it
    assert.equal(one(steps, (s) => s.kind === 'failed').detail, 'boom: exit 1');
    assert.equal(one(steps, (s) => s.kind === 'retry').detail, 'boom: exit 1');
    const undo = one(steps, (s) => s.kind === 'undo');
    assert.match(undo.detail!, /back to queued · held/);
    assert.equal(one(steps, (s) => s.kind === 'release').detail, 'global queue');

    const turns = steps.filter((s) => s.kind === 'run');
    assert.deepEqual(turns.map((s) => s.runId), ['rB1', 'rB2', 'rB3']);
    assert.match(turns[1].detail!, /exit 1/);
    assert.match(turns[2].detail!, /killed/);
    assert.deepEqual(turns.map((s) => s.durationMs), [5 * MIN, 5 * MIN, MIN]);
    // the retry sorts before the queued stretch it opens
    const at30 = steps.filter((s) => s.at === T(30)).map((s) => s.kind);
    assert.deepEqual(at30, ['retry', 'queued']);

    const totals = historyTotals(steps, runs, T(120));
    assert.equal(totals.attempts, 2);
    assert.equal(totals.workedMs, 11 * MIN);
    assert.ok(Math.abs(totals.costUsd - 1.1) < 1e-9);
    assert.equal(totals.wallMs, 120 * MIN);
  });

  test('checks stages, waiting, publish/PR/landing points', () => {
    const events = [
      tr(T(0), 'C', 'queued', 'running', { claim: 'overflow' }),
      started(T(0), 'C', 'rC1'),
      tr(T(2), 'C', 'running', 'waiting'),
      ev('task.waiting', T(2), 'C', { children: 2 }, { runId: 'rC1' }),
      tr(T(6), 'C', 'waiting', 'running'),
      ev('task.waiting', T(6), 'C', { resumed: 'children-done', waitedMs: 240_000 }, { runId: 'rC1' }),
      tr(T(8), 'C', 'running', 'review', { runId: 'rC1', reviewState: 'pending', checkState: 'pending' }),
      ev('task.checked', T(10), 'C', { state: 'red', round: 1, results: [{ name: 'typecheck', outcome: 'red', durationMs: 60_000 }] }),
      ev('run.reviewed', T(10), 'C', { skipped: 'checks-red', state: null, stop: 'rounds' }),
      ev('task.pr', T(11), 'C', { action: 'opened', number: 42, url: 'https://github.com/x/y/pull/42', draft: true }),
      ev('task.landing', T(12), 'C', { landing: 'auto-publish', reason: 'ok', phase: 'publish' }),
      ev('task.publish', T(12), 'C', { phase: 'start', delivery: 'squash' }),
      ev('task.land', T(13), 'C', { phase: 'pushed', sha: 'abcdef1234567', onto: 'main', attempt: 1, checked: false }),
      ev('task.shipped', T(13), 'C', { sha: 'abcdef1234567', ref: 'origin/main', pushedBeforeReview: false }),
      ev('task.publish', T(14), 'C', { phase: 'published', delivery: 'squash', reason: null }),
      tr(T(14), 'C', 'review', 'published', { landing: 'auto-publish' }, { actor: 'orchestrator' }),
    ];
    const { steps } = history(task('C', { status: 'published' }), events, [run('rC1', 'C', T(0), T(14), { stats: stats(1, 10) })]);
    const runStep = one(steps, (s) => s.kind === 'run');
    // the waiting park is part of the same run but not its worked time
    assert.equal(runStep.durationMs, 4 * MIN);
    assert.equal(runStep.end, T(8));
    const wait = one(steps, (s) => s.kind === 'waiting');
    assert.deepEqual([wait.at, wait.end, wait.durationMs], [T(2), T(6), 4 * MIN]);
    assert.match(wait.detail!, /2 subagents · ended: children-done/);
    const checks = one(steps, (s) => s.kind === 'checks');
    assert.deepEqual([checks.label, checks.at, checks.durationMs, checks.tone], ['checks red (round 1)', T(8), 2 * MIN, 'bad']);
    assert.equal(checks.detail, 'typecheck red');
    assert.equal(one(steps, (s) => s.kind === 'review').label, 'review skipped: checks red');
    assert.equal(one(steps, (s) => s.kind === 'claimed').label, 'claimed as overflow');
    assert.equal(one(steps, (s) => s.kind === 'pr').label, 'PR #42 opened');
    assert.equal(one(steps, (s) => s.kind === 'landing').label, 'auto-publishing');
    assert.deepEqual(steps.filter((s) => s.kind === 'publish').map((s) => s.label), ['publish started', 'publish published']);
    assert.equal(one(steps, (s) => s.kind === 'land').tone, 'good');
    assert.match(one(steps, (s) => s.kind === 'shipped').detail!, /abcdef12/);
    assert.equal(one(steps, (s) => s.kind === 'landed').label, 'auto-landed: published');
    assert.ok(steps.every((s, i) => i === 0 || steps[i - 1].at <= s.at), 'oldest first');
  });
});

// ── the route over a temp SQLite DB ──────────────────────────────────────────

/** `loadTaskHistory` as it was before the widening — the segments must not move */
async function oldSegments(storage: Storage, taskId: string, createdAt: string, now: string, cap = TIMELINE_ROW_CAP): Promise<TimelineSegment[]> {
  const rows = await storage.listEvents({ kinds: [...TIMELINE_EVENT_KINDS], taskId, limit: cap + 1 });
  const since = rows.length && rows[rows.length - 1].at < createdAt ? rows[rows.length - 1].at : createdAt;
  let events = rows;
  let coveredSince = since;
  const truncated = rows.length > cap;
  if (truncated) {
    const kept = rows.slice(0, cap);
    coveredSince = new Date(Date.parse(kept[kept.length - 1].at) + 1).toISOString();
    events = kept.filter((e) => e.at >= coveredSince);
  }
  const seeds = truncated ? await storage.taskSeedEvents(['task.transition', 'task.created', 'task.deleted'], [...TIMELINE_EVENT_KINDS], [taskId], coveredSince) : [];
  const [own, about] = await Promise.all([storage.listRuns({ taskId }), storage.listRuns({ subjectId: taskId })]);
  const runs = [...own, ...about.filter((r) => r.mode === 'aux')].filter((r) => r.mode === 'worker' || r.kind === 'review' || r.kind === 'compact');
  return buildTaskSegments(sortEvents([...seeds, ...events]), runs, { since: coveredSince, until: now, now })[taskId] ?? [];
}

describe('loadTaskHistory (temp SQLite)', () => {
  let tmp: string;
  let storage: SqliteStorage;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-task-history-'));
    storage = new SqliteStorage(path.join(tmp, 'tm.db'));
    await storage.migrate();
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('returns the history kinds and dispatches both ways; segments equal the old result', async () => {
    const repo = await storage.createRepo({ name: 'hist', path: path.join(tmp, 'hist') });
    const t = await storage.createTask({ title: 'history', repoId: repo.id, status: 'queued' }, 'test');
    const peer = await storage.createTask({ title: 'peer', repoId: repo.id, status: 'queued' }, 'test');
    const add = (kind: AuditKind, data: Record<string, unknown>, runId: string | null = null, taskId = t.id) =>
      storage.appendEvent({ kind, actor: 'system', taskId, runId, repoId: repo.id, data });
    await sleep(3);
    await storage.transitionTask(t.id, ['queued'], 'running', 'orchestrator', {}, { claim: 'base' });
    const w = await storage.createRun({ taskId: t.id, repoId: repo.id, mode: 'worker' });
    await add('run.started', { handoff: 'fresh' }, w.id);
    await sleep(3);
    await add('question.asked', { questionId: 'q1', questions: ['A or B?'] }, w.id);
    await add('question.answered', { questionId: 'q1', answers: { 'A or B?': 'answer-text-xyz' } });
    await add('run.attention', { type: 'permission_prompt' }, w.id); // noisy: never fetched
    await add('task.edited', {}); // not a history kind
    const out = await storage.createDispatch({ fromTaskId: t.id, fromRunId: w.id, toTaskId: peer.id, message: 'hi', intent: 'needs_action' });
    await add('task.dispatch', { phase: 'created', dispatchId: out.id, fromTaskId: t.id, intent: 'needs_action' }, w.id, peer.id);
    await sleep(3);
    const inbound = await storage.createDispatch({ fromTaskId: peer.id, toTaskId: t.id, message: 'fyi', intent: 'fyi' });
    await add('task.dispatch', { phase: 'created', dispatchId: inbound.id, fromTaskId: peer.id, intent: 'fyi' });
    await sleep(3);
    await storage.transitionTask(t.id, ['running'], 'review', 'hook', { reviewState: 'pending' }, { runId: w.id, reviewState: 'pending', checkState: null });
    await sleep(3);
    await add('run.reviewed', { verdict: 'clean', state: 'passed', round: 1 });
    await add('task.retry', { via: 'run-now', from: 'review', previousError: null });
    await sleep(3);
    const now = new Date().toISOString();

    const hist = await loadTaskHistory(storage, t.id, t.createdAt, now);
    const got = new Set(hist.events.map((e) => e.kind));
    for (const k of ['question.asked', 'question.answered', 'task.dispatch', 'task.retry', 'run.started', 'task.transition'] as const) {
      assert.ok(got.has(k), `fetched ${k}`);
    }
    assert.ok(!got.has('run.attention') && !got.has('task.edited'), 'only history kinds');
    assert.ok(hist.events.every((e) => HISTORY_EVENT_KINDS.includes(e.kind)));
    assert.ok(hist.events.every((e, i) => i === 0 || hist.events[i - 1].id < e.id), 'oldest first, no duplicates');
    // the dispatch the task SENT is filed under the receiver: only `dispatches` has it
    assert.ok(!hist.events.some((e) => e.kind === 'task.dispatch' && e.data?.dispatchId === out.id));
    assert.deepEqual(hist.dispatches.map((d) => d.id), [out.id, inbound.id]);
    assert.deepEqual(hist.segments, await oldSegments(storage, t.id, t.createdAt, now));
    assert.deepEqual(hist.segments.map((s) => s.kind), ['queued', 'running', 'review-round', 'idle-in-review']);

    // end to end through the builder: both directions are steps
    const steps = buildTaskHistory({ task: t, ...hist, now });
    assert.deepEqual(
      steps.filter((s) => s.kind === 'dispatch').map((s) => s.label),
      [`dispatch sent to ${peer.id.slice(0, 8)}`, `dispatch received from ${peer.id.slice(0, 8)}`],
    );
    assert.ok(!JSON.stringify(steps).includes('answer-text-xyz'), 'no answer text');

    // truncated: the same cap, seed and coverage as before for the segments
    const cut = await loadTaskHistory(storage, t.id, t.createdAt, now, 2);
    assert.equal(cut.truncated, true);
    assert.deepEqual(cut.segments, await oldSegments(storage, t.id, t.createdAt, now, 2));

    // /api/timeline still reads the fold's kinds only
    const tl = await loadTimeline(storage, { since: t.createdAt, until: now, now, repoIds: [repo.id] });
    assert.ok(tl.events.every((e) => TIMELINE_EVENT_KINDS.includes(e.kind)));
    assert.ok(!tl.events.some((e) => e.kind === 'question.asked' || e.kind === 'task.retry'));
  });
});
