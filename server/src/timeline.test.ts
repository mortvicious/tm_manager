// Timeline past segments + range API (docs/timeline.md).
// Run: npm test   (node:test through tsx; a temp SQLite DB)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  buildTaskSegments,
  foldEvent,
  foldRun,
  initTimeline,
  stateAt,
  timelineSegments,
  type AuditEvent,
  type AuditKind,
  type Run,
  type TimelineSegment,
} from '@tm/shared';
import { loadTaskHistory, loadTimeline, parseTimelineQuery } from './routes/timeline.ts';
import { SqliteStorage } from './storage/sqlite.ts';

// ── synthetic rows in the shapes the server writes ─────────────────────────

const BASE = Date.parse('2026-10-01T10:00:00.000Z');
/** minute n of the fixture day */
const T = (n: number) => new Date(BASE + n * 60_000).toISOString();
let seq = 0;
function ev(kind: AuditKind, at: string, taskId: string, data: Record<string, unknown>, extra: Partial<AuditEvent> = {}): AuditEvent {
  // the server's id shape: ms hex + per-ms sequence (time-sortable, insertion order within a ms)
  const id = `${Date.parse(at).toString(16).padStart(12, '0')}${(seq++).toString(16).padStart(3, '0')}-test`;
  return { id, at, kind, actor: 'system', taskId, runId: null, repoId: 'repo-1', data, ...extra };
}
const tr = (at: string, taskId: string, from: string | null, to: string, more: Record<string, unknown> = {}) =>
  ev('task.transition', at, taskId, { ...more, from, to });
const started = (at: string, taskId: string, runId: string, handoff = 'fresh') =>
  ev('run.started', at, taskId, { handoff, model: 'claude-opus-5-5' }, { runId, actor: 'orchestrator' });
function run(id: string, taskId: string, startedAt: string, endedAt: string | null, over: Partial<Run> = {}): Run {
  return {
    id, taskId, repoId: 'repo-1', mode: 'worker', kind: 'worker', subjectId: null, label: null,
    status: endedAt ? 'exited' : 'running', pid: null, exitCode: null, needsAttention: false, idle: false,
    model: null, effort: null, sessionId: null, transcriptPath: null, stats: null, resumedFrom: null,
    statsBaseline: null, startedAt, endedAt, ...over,
  };
}
const shape = (segs: TimelineSegment[] | undefined) => (segs ?? []).map((s) => [s.kind, s.start, s.end, s.outcome ?? null]);

// A: claimed → running → review (pending) → reviewed → idle → done
const A = [
  tr(T(0), 'A', 'draft', 'queued'),
  tr(T(1), 'A', 'queued', 'running', { claim: 'base' }),
  started(T(1), 'A', 'rA1'),
  tr(T(10), 'A', 'running', 'review', { runId: 'rA1', reviewState: 'pending', checkState: null }),
  ev('run.reviewed', T(14), 'A', { model: 'claude-fable-5-1', verdict: 'clean', findings: [], round: 1, fixRound: 0, state: 'passed' }),
  tr(T(30), 'A', 'review', 'done', { landing: 'on-green', reason: 'checks green, review clean' }),
];
// B: a waiting park — the turn parks on a background subagent and comes back
const B = [
  tr(T(2), 'B', 'queued', 'running', { claim: 'custom-queue' }),
  started(T(2), 'B', 'rB1'),
  tr(T(5), 'B', 'running', 'waiting'),
  ev('task.waiting', T(5), 'B', { children: 1 }, { actor: 'hook', runId: 'rB1' }),
  tr(T(9), 'B', 'waiting', 'running'),
  ev('task.waiting', T(9), 'B', { resumed: 'children-done', waitedMs: 240_000 }, { runId: 'rB1' }),
  tr(T(12), 'B', 'running', 'review', { runId: 'rB1', reviewState: null, checkState: null }),
];
// C: an OLD-shaped landing (no reviewState on the row) → checks green → review
// asks for a fix → fix turn → checks red → check fix turn → green → passed →
// a human turn → failed
const C = [
  tr(T(3), 'C', 'queued', 'running', { claim: 'base' }),
  started(T(3), 'C', 'rC1'),
  tr(T(6), 'C', 'running', 'review'),
  ev('task.checked', T(7), 'C', { state: 'green', round: 1, results: [{ name: 'typecheck', outcome: 'green' }] }),
  ev('run.reviewed', T(11), 'C', { verdict: 'blocker', findings: [{}, {}], actionable: 2, round: 1, fixRound: 0, state: 'fixing' }),
  ev('task.follow-up', T(11), 'C', { reason: 'adversarial-review', round: 1, actionable: 2 }),
  tr(T(11), 'C', 'review', 'running'),
  ev('task.follow-up', T(11), 'C', { delivery: 'resume', resumedFrom: 'rC1', purpose: 'work', chars: 300 }, { repoId: null }),
  started(T(11), 'C', 'rC2', 'resume'),
  tr(T(15), 'C', 'running', 'review', { runId: 'rC2', reviewState: 'pending', checkState: 'pending' }),
  ev('task.checked', T(16), 'C', { state: 'red', round: 1, results: [{ name: 'test', outcome: 'red' }] }),
  ev('task.follow-up', T(16), 'C', { reason: 'checks', round: 2, red: ['test'] }),
  tr(T(16), 'C', 'review', 'running'),
  started(T(16), 'C', 'rC3', 'resume'),
  tr(T(20), 'C', 'running', 'review', { runId: 'rC3', reviewState: 'pending', checkState: 'pending' }),
  ev('task.checked', T(21), 'C', { state: 'green', round: 2, results: [{ name: 'test', outcome: 'green' }] }),
  ev('run.reviewed', T(24), 'C', { verdict: 'clean', findings: [], round: 2, fixRound: 1, state: 'passed' }),
  tr(T(40), 'C', 'review', 'running'),
  started(T(40), 'C', 'rC4', 'resume'),
  tr(T(42), 'C', 'running', 'failed'),
];
const RUNS = [run('rA1', 'A', T(1), T(31)), run('rB1', 'B', T(2), null), run('rC1', 'C', T(3), T(11))];
const ALL = [...A, ...B, ...C];
const WIN = { since: T(0), until: T(60), now: T(60) };

describe('buildTaskSegments', () => {
  const segs = buildTaskSegments(ALL, RUNS, WIN);

  test('claimed → running → review round → idle → landed', () => {
    assert.deepEqual(shape(segs.A), [
      ['queued', T(0), T(1), 'running'],
      ['running', T(1), T(10), 'review'],
      ['review-round', T(10), T(14), 'passed'],
      ['idle-in-review', T(14), T(30), 'done'],
      ['landed', T(30), null, null],
    ]);
    const [, running, round, , landed] = segs.A;
    assert.equal(running.runId, 'rA1');
    assert.equal(running.data.claim, 'base');
    assert.equal(round.data.verdict, 'clean');
    assert.equal(round.data.findings, 0);
    assert.equal(landed.data.status, 'done');
    assert.equal(landed.data.landing, 'on-green');
  });

  test('a waiting park splits the turn, and the turn resumes with its run', () => {
    assert.deepEqual(shape(segs.B), [
      ['running', T(2), T(5), 'waiting'],
      ['waiting', T(5), T(9), 'running'],
      ['running', T(9), T(12), 'review'],
      ['idle-in-review', T(12), null, null],
    ]);
    assert.equal(segs.B[0].data.claim, 'custom-queue');
    assert.equal(segs.B[1].data.children, 1);
    assert.equal(segs.B[1].data.ended, 'children-done');
    assert.equal(segs.B[2].runId, 'rB1');
  });

  test('checks, a review fix round, a check fix round, then a failed marker', () => {
    assert.deepEqual(shape(segs.C), [
      ['running', T(3), T(6), 'review'],
      ['checks', T(6), T(7), 'green'], // relabelled: the old row said nothing about a pending stage
      ['review-round', T(7), T(11), 'fixing'],
      ['idle-in-review', T(11), T(11), 'running'],
      ['fixing', T(11), T(15), 'review'],
      ['checks', T(15), T(16), 'red'],
      ['idle-in-review', T(16), T(16), 'running'],
      ['fixing', T(16), T(20), 'review'],
      ['checks', T(20), T(21), 'green'],
      ['review-round', T(21), T(24), 'passed'],
      ['idle-in-review', T(24), T(40), 'running'],
      ['running', T(40), T(42), 'failed'],
      ['failed', T(42), T(42), null],
    ]);
    const fix1 = segs.C[4];
    assert.equal(fix1.data.fix, 'adversarial-review');
    assert.equal(fix1.runId, 'rC2');
    assert.equal(fix1.data.handoff, 'resume');
    assert.equal(segs.C[7].data.fix, 'checks');
    assert.equal(segs.C[7].data.round, 2);
    assert.equal(segs.C[11].data.fix, undefined, 'a later human turn is plain running');
    assert.equal(segs.C[11].runId, 'rC4');
  });

  test('every kind of the eight appears', () => {
    const kinds = new Set(Object.values(segs).flat().map((s) => s.kind));
    for (const k of ['queued', 'running', 'waiting', 'review-round', 'checks', 'fixing', 'idle-in-review', 'landed', 'failed'])
      assert.ok(kinds.has(k as never), k);
  });

  test('a stale fix announcement does not relabel a much later turn', () => {
    const s = buildTaskSegments(
      [
        tr(T(0), 'D', 'running', 'review', { reviewState: null, checkState: null }),
        ev('task.follow-up', T(1), 'D', { reason: 'checks', round: 2 }),
        tr(T(30), 'D', 'review', 'running'),
      ],
      [],
      WIN,
    );
    assert.equal(s.D[1].kind, 'running');
  });

  test('runs fill in a missing runId; done → published stays one landed segment', () => {
    const s = buildTaskSegments(
      [tr(T(1), 'E', 'queued', 'running', { claim: 'base' }), tr(T(5), 'E', 'running', 'done'), tr(T(8), 'E', 'done', 'published')],
      [run('rE1', 'E', T(1), T(5))],
      WIN,
    );
    assert.equal(s.E[0].runId, 'rE1');
    assert.deepEqual(shape(s.E), [
      ['running', T(1), T(5), 'done'],
      ['landed', T(5), null, null],
    ]);
    assert.equal(s.E[1].data.status, 'published');
  });

  test('a cancelled task is a zero-length marker with the reason', () => {
    const s = buildTaskSegments([tr(T(0), 'F', 'draft', 'queued'), tr(T(4), 'F', 'queued', 'cancelled', { reason: 'stale draft triage' })], [], WIN);
    assert.deepEqual(shape(s.F), [
      ['queued', T(0), T(4), 'cancelled'],
      ['cancelled', T(4), T(4), 'stale draft triage'],
    ]);
  });

  test('clipped to the window', () => {
    const s = buildTaskSegments(A, RUNS, { since: T(5), until: T(20), now: T(60) });
    assert.deepEqual(shape(s.A), [
      ['running', T(5), T(10), 'review'],
      ['review-round', T(10), T(14), 'passed'],
      ['idle-in-review', T(14), T(20), null], // ends at T(30), past the window: no outcome
    ]);
    assert.equal(s.A[0].clippedStart, true);
    assert.equal(s.A[2].clippedEnd, true);
    // a live window keeps the open segment open
    assert.equal(buildTaskSegments(A, RUNS, { since: T(5), until: T(60), now: T(60) }).A.at(-1)?.end, null);
  });
});

describe('foldEvent', () => {
  test('event by event yields the batch build, without touching earlier states', () => {
    let state = initTimeline();
    for (const r of RUNS) state = foldRun(state, r);
    const snapshots: string[] = [];
    const states = [];
    // the SPA appends live rows oldest first
    for (const e of [...ALL].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      states.push(state);
      snapshots.push(JSON.stringify(state));
      state = foldEvent(state, e);
    }
    assert.deepEqual(timelineSegments(state, WIN), buildTaskSegments(ALL, RUNS, WIN));
    states.forEach((s, i) => assert.equal(JSON.stringify(s), snapshots[i], `state ${i} was mutated`));
    // a duplicate (the live append overlapping the initial fetch) is ignored
    assert.equal(foldEvent(state, ALL[3]), state);
  });
});

describe('stateAt', () => {
  const segs = buildTaskSegments(ALL, RUNS, WIN);
  test('mid-sequence', () => {
    const at = stateAt(segs, T(5.5));
    assert.deepEqual(at.running.sort(), ['A', 'C']);
    assert.deepEqual(at.waiting, ['B']);
    assert.deepEqual(at.inReview, []);
    assert.deepEqual(at.checking, []);
    const later = stateAt(segs, Date.parse(T(12.5)));
    assert.deepEqual(later.inReview.sort(), ['A', 'B']);
    assert.deepEqual(later.running, ['C'], 'a fix turn counts as running');
    assert.deepEqual(stateAt(segs, T(15.5)).checking, ['C']);
    const end = stateAt(segs, new Date(T(50)));
    assert.deepEqual(end.landed, ['A']);
    assert.deepEqual(end.inReview, ['B']);
    assert.deepEqual(end.running, [], 'a failed marker holds no time');
    assert.deepEqual(stateAt(segs, T(0.5)).queued, ['A']);
  });
  test('a boundary instant belongs to the segment that starts there', () => {
    const at = stateAt(segs, T(10));
    assert.ok(at.inReview.includes('A'));
    assert.ok(!at.running.includes('A'));
  });
});

// ── storage filters + the range API over a temp SQLite DB ──────────────────

describe('storage + range API (temp SQLite)', () => {
  let tmp: string;
  let storage: SqliteStorage;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-timeline-'));
    storage = new SqliteStorage(path.join(tmp, 'tm.db'));
    await storage.migrate();
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('migration 50 adds the (repo_id, at) and (kind, at) indexes', () => {
    const db = (storage as any).db;
    const idx = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tm_events' AND sql IS NOT NULL`).all() as { name: string; sql: string }[];
    const byName = Object.fromEntries(idx.map((i) => [i.name, i.sql.replace(/\s+/g, '')]));
    assert.match(byName.tm_events_repo_at_idx, /ONtm_events\(repo_id,at\)/);
    assert.match(byName.tm_events_kind_at_idx, /ONtm_events\(kind,at\)/);
  });

  test('EventFilter until / repoIds / kinds / taskIds; taskSeedEvents', async () => {
    const r1 = await storage.createRepo({ name: 'one', path: path.join(tmp, 'one') });
    const r2 = await storage.createRepo({ name: 'two', path: path.join(tmp, 'two') });
    const add = async (kind: AuditKind, repoId: string, taskId: string) => {
      const e = await storage.appendEvent({ kind, actor: 'test', repoId, taskId, data: { n: seq++ } });
      await sleep(3);
      return e;
    };
    const e1 = await add('task.transition', r1.id, 't1');
    const e2 = await add('run.started', r2.id, 't2');
    const e3 = await add('task.edited', r1.id, 't1');
    const e4 = await add('task.transition', r1.id, 't1');
    const ids = (rows: AuditEvent[]) => rows.map((e) => e.id).sort();
    const scope = { since: e1.at, limit: 100 };
    assert.deepEqual(ids(await storage.listEvents({ ...scope, until: e2.at })), [e1.id]);
    assert.deepEqual(ids(await storage.listEvents({ ...scope, repoIds: [r1.id] })), ids([e1, e3, e4]));
    assert.deepEqual(await storage.listEvents({ ...scope, repoIds: [] }), []);
    assert.deepEqual(ids(await storage.listEvents({ ...scope, kinds: ['task.transition', 'run.started'] })), ids([e1, e2, e4]));
    assert.deepEqual(await storage.listEvents({ ...scope, kinds: [] }), []);
    assert.deepEqual(ids(await storage.listEvents({ ...scope, taskIds: ['t2'] })), [e2.id]);
    assert.deepEqual(await storage.listEvents({ ...scope, taskIds: [] }), []);
    assert.deepEqual(ids(await storage.listEvents({ ...scope, repoIds: [r1.id], kinds: ['task.transition'], until: e4.at })), [e1.id]);
    // each task's newest anchor before the instant, plus its `kinds` rows after the anchor
    assert.deepEqual(ids(await storage.taskSeedEvents(['task.transition'], ['task.edited'], ['t1', 't2'], e4.at)), ids([e1, e3]));
    assert.deepEqual(ids(await storage.taskSeedEvents(['task.transition'], ['run.started'], ['t1', 't2'], e4.at)), [e1.id]);
    const later = new Date(Date.now() + 1000).toISOString();
    assert.deepEqual(ids(await storage.taskSeedEvents(['task.transition'], ['task.edited'], ['t1'], later)), [e4.id]);
    assert.deepEqual(await storage.taskSeedEvents(['task.transition'], ['task.edited'], [], e3.at), []);
  });

  test('loadTimeline: seeds, window, repo scope, runs overlap, truncation; loadTaskHistory', async () => {
    const repo = await storage.createRepo({ name: 'tl', path: path.join(tmp, 'tl') });
    const other = await storage.createRepo({ name: 'tl2', path: path.join(tmp, 'tl2') });
    const task = await storage.createTask({ title: 'timeline', repoId: repo.id, status: 'queued' }, 'test');
    const elsewhere = await storage.createTask({ title: 'other', repoId: other.id, status: 'queued' }, 'test');
    await sleep(3);
    await storage.transitionTask(task.id, ['queued'], 'running', 'orchestrator');
    await storage.transitionTask(elsewhere.id, ['queued'], 'running', 'orchestrator');
    const workerRun = await storage.createRun({ taskId: task.id, repoId: repo.id, mode: 'worker' });
    await storage.appendEvent({ kind: 'run.started', actor: 'orchestrator', taskId: task.id, runId: workerRun.id, repoId: repo.id, data: { handoff: 'fresh' } });
    await sleep(5);
    const since = new Date().toISOString(); // the task enters the window already running
    await sleep(5);
    await storage.transitionTask(task.id, ['running'], 'review', 'hook', { reviewState: 'pending' }, { runId: workerRun.id, reviewState: 'pending', checkState: null });
    await sleep(3);
    await storage.appendEvent({ kind: 'run.reviewed', actor: 'system', taskId: task.id, repoId: repo.id, data: { verdict: 'clean', state: 'passed', round: 1 } });
    await storage.appendEvent({ kind: 'task.edited', actor: 'human', taskId: task.id, repoId: repo.id, data: {} });
    await sleep(3);
    const now = new Date().toISOString();

    const res = await loadTimeline(storage, { since, until: now, now, repoIds: [repo.id] });
    assert.equal(res.truncated, false);
    assert.equal(res.coveredSince, since);
    assert.ok(!res.events.some((e) => e.kind === 'task.edited'), 'only timeline kinds');
    assert.ok(!res.segments[elsewhere.id], 'out of scope');
    assert.ok(res.runs.some((r) => r.id === workerRun.id), 'a run started before the window but still live overlaps it');
    assert.deepEqual(
      res.segments[task.id].map((s) => s.kind),
      ['running', 'review-round', 'idle-in-review'],
    );
    assert.equal(res.segments[task.id][0].start, since);
    assert.equal(res.segments[task.id][0].clippedStart, true);
    assert.equal(res.segments[task.id][0].runId, workerRun.id);
    assert.equal(res.segments[task.id][2].end, null);
    // the seed row is in `events`, so a client can rebuild the same fold
    assert.ok(res.events[0].at < since && res.events[0].kind === 'task.transition');

    const none = await loadTimeline(storage, { since, until: now, now, repoIds: [] });
    assert.deepEqual([none.events.length, none.runs.length, Object.keys(none.segments).length], [0, 0, 0]);

    const cut = await loadTimeline(storage, { since, until: now, now, repoIds: [repo.id], cap: 1 });
    assert.equal(cut.truncated, true);
    assert.ok(cut.coveredSince > since);

    const hist = await loadTaskHistory(storage, task.id, task.createdAt, now);
    assert.equal(hist.truncated, false);
    assert.deepEqual(
      hist.segments.map((s) => [s.kind, s.outcome ?? null]),
      [
        ['queued', 'running'],
        ['running', 'review'],
        ['review-round', 'passed'],
        ['idle-in-review', null],
      ],
    );
  });
});

describe('verdicts settled before the window (temp SQLite)', () => {
  let tmp: string;
  let storage: SqliteStorage;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-timeline-seed-'));
    storage = new SqliteStorage(path.join(tmp, 'tm.db'));
    await storage.migrate();
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('a round / checks stage settled before `since` is not reopened', async () => {
    const repo = await storage.createRepo({ name: 'seed', path: path.join(tmp, 'seed') });
    const mk = async (title: string) => {
      const t = await storage.createTask({ title, repoId: repo.id, status: 'queued' }, 'test');
      await storage.transitionTask(t.id, ['queued'], 'running', 'orchestrator');
      // the Stop hook's landing: checks and a review both due
      await storage.transitionTask(t.id, ['running'], 'review', 'hook', { reviewState: 'pending', checkState: 'pending' }, { reviewState: 'pending', checkState: 'pending' });
      await storage.appendEvent({ kind: 'task.checked', actor: 'system', taskId: t.id, repoId: repo.id, data: { state: 'green', round: 1, results: [] } });
      return t;
    };
    const verdictBefore = await mk('reviewed before the window');
    await storage.appendEvent({ kind: 'run.reviewed', actor: 'system', taskId: verdictBefore.id, repoId: repo.id, data: { verdict: 'clean', state: 'passed', round: 1 } });
    const verdictInside = await mk('checked before, reviewed inside');
    await sleep(5);
    const since = new Date().toISOString();
    await sleep(5);
    await storage.appendEvent({ kind: 'run.reviewed', actor: 'system', taskId: verdictInside.id, repoId: repo.id, data: { verdict: 'clean', state: 'passed', round: 1 } });
    await sleep(3);
    await storage.transitionTask(verdictBefore.id, ['review'], 'published', 'human');
    await sleep(3);
    const now = new Date().toISOString();

    const res = await loadTimeline(storage, { since, until: now, now, repoIds: [repo.id] });
    const kinds = (id: string) => res.segments[id].map((s) => [s.kind, s.outcome ?? null, s.clippedStart ?? false]);
    assert.deepEqual(kinds(verdictBefore.id), [
      ['idle-in-review', 'published', true],
      ['landed', null, false],
    ]);
    assert.deepEqual(kinds(verdictInside.id), [
      ['review-round', 'passed', true], // the checks closed before the window: the round, not the stage, was open
      ['idle-in-review', null, false],
    ]);
    const mid = stateAt(res.segments, since);
    assert.deepEqual(mid.checking, []);
    assert.deepEqual(mid.inReview.sort(), [verdictBefore.id, verdictInside.id].sort());

    // a truncated history seeds the same way: only the landing is in the kept rows
    const hist = await loadTaskHistory(storage, verdictBefore.id, verdictBefore.createdAt, now, 2);
    assert.equal(hist.truncated, true);
    assert.deepEqual(hist.segments.map((s) => s.kind), ['idle-in-review', 'landed']);
  });
});

describe('tasks in one state through the whole window (temp SQLite)', () => {
  let tmp: string;
  let storage: SqliteStorage;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-timeline-idle-'));
    storage = new SqliteStorage(path.join(tmp, 'tm.db'));
    await storage.migrate();
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('a review waiting on the human and a long-queued task are listed; terminal and other-repo tasks are not', async () => {
    const repo = await storage.createRepo({ name: 'idle', path: path.join(tmp, 'idle') });
    const other = await storage.createRepo({ name: 'other', path: path.join(tmp, 'other') });
    const inReview = await storage.createTask({ title: 'waits on the human', repoId: repo.id, status: 'queued' }, 'test');
    await storage.transitionTask(inReview.id, ['queued'], 'running', 'orchestrator');
    await storage.transitionTask(inReview.id, ['running'], 'review', 'hook', { reviewState: 'pending' }, { reviewState: 'pending' });
    await storage.appendEvent({ kind: 'run.reviewed', actor: 'system', taskId: inReview.id, repoId: repo.id, data: { verdict: 'clean', state: 'passed', round: 1 } });
    const queued = await storage.createTask({ title: 'long queue', repoId: repo.id, status: 'queued' }, 'test');
    const landed = await storage.createTask({ title: 'shipped before', repoId: repo.id, status: 'queued' }, 'test');
    await storage.transitionTask(landed.id, ['queued'], 'running', 'orchestrator');
    await storage.transitionTask(landed.id, ['running'], 'published', 'human');
    const draft = await storage.createTask({ title: 'a draft', repoId: repo.id, status: 'draft' }, 'test');
    const elsewhere = await storage.createTask({ title: 'other repo', repoId: other.id, status: 'queued' }, 'test');
    await sleep(5);
    const since = new Date().toISOString();
    await sleep(5);
    const now = new Date().toISOString();

    const res = await loadTimeline(storage, { since, until: now, now, repoIds: [repo.id] });
    const kinds = (id: string) => res.segments[id]?.map((s) => [s.kind, s.end, s.clippedStart ?? false]);
    assert.deepEqual(kinds(inReview.id), [['idle-in-review', null, true]]);
    assert.deepEqual(kinds(queued.id), [['queued', null, true]]);
    assert.equal(res.segments[landed.id], undefined);
    assert.equal(res.segments[draft.id], undefined);
    assert.equal(res.segments[elsewhere.id], undefined);
    const at = stateAt(res.segments, since);
    assert.deepEqual(at.inReview, [inReview.id]);
    assert.deepEqual(at.queued, [queued.id]);

    // every repo: the other repo's queued task is there too; an empty scope is nothing
    const all = await loadTimeline(storage, { since, until: now, now });
    assert.deepEqual(stateAt(all.segments, since).queued.sort(), [queued.id, elsewhere.id].sort());
    assert.deepEqual((await loadTimeline(storage, { since, until: now, now, repoIds: [] })).segments, {});
  });

  test('a deleted task is closed at its deletion and never haunts a later window', async () => {
    const repo = await storage.createRepo({ name: 'gone', path: path.join(tmp, 'gone') });
    // the DELETE route: no transition, a repo-less `task.deleted` row
    const del = async (id: string, title: string) => {
      await storage.deleteTask(id);
      await storage.appendEvent({ kind: 'task.deleted', actor: 'human', taskId: id, data: { title } });
    };
    const toReview = async (title: string) => {
      const t = await storage.createTask({ title, repoId: repo.id, status: 'queued' }, 'test');
      await storage.transitionTask(t.id, ['queued'], 'running', 'orchestrator');
      await storage.transitionTask(t.id, ['running'], 'review', 'hook', { reviewState: null }, { reviewState: null });
      return t;
    };
    const deletedBefore = await toReview('deleted before the window');
    await del(deletedBefore.id, deletedBefore.title);
    const queuedGone = await storage.createTask({ title: 'deleted from the queue', repoId: repo.id, status: 'queued' }, 'test');
    await del(queuedGone.id, queuedGone.title);
    const deletedInside = await toReview('deleted inside the window');
    await sleep(5);
    const since = new Date().toISOString();
    await sleep(5);
    await del(deletedInside.id, deletedInside.title);
    const deletedAt = new Date().toISOString();
    await sleep(5);
    const now = new Date().toISOString();

    for (const repoIds of [[repo.id], undefined]) {
      const res = await loadTimeline(storage, { since, until: now, now, repoIds });
      assert.equal(res.segments[deletedBefore.id], undefined);
      assert.equal(res.segments[queuedGone.id], undefined);
      assert.deepEqual(
        res.segments[deletedInside.id].map((s) => [s.kind, s.outcome ?? null, s.end !== null]),
        [['idle-in-review', 'deleted', true]],
      );
      // (the unscoped pass also sees the previous test's tasks)
      const mine = (ids: string[]) => ids.filter((id) => [deletedBefore.id, queuedGone.id, deletedInside.id].includes(id));
      assert.deepEqual(mine(stateAt(res.segments, since).inReview), [deletedInside.id]);
      const after = stateAt(res.segments, now);
      assert.deepEqual(mine([...after.inReview, ...after.queued]), []);
      assert.ok(res.segments[deletedInside.id][0].end! <= deletedAt);
    }
  });
});

describe('parseTimelineQuery', () => {
  const now = Date.parse('2026-10-28T12:00:00.000Z');
  test('defaults to the last 24 h, normalises ISO', () => {
    const q = parseTimelineQuery({}, now);
    assert.equal(q.until, '2026-10-28T12:00:00.000Z');
    assert.equal(q.since, '2026-10-27T12:00:00.000Z');
    assert.equal(q.repoIds, undefined);
  });
  test('repoIds: absent = all, present-empty = nothing', () => {
    assert.deepEqual(parseTimelineQuery({ repoIds: '' }, now).repoIds, []);
    assert.deepEqual(parseTimelineQuery({ repoIds: 'a, b,' }, now).repoIds, ['a', 'b']);
  });
  test('refuses a bad or too-long window', () => {
    assert.throws(() => parseTimelineQuery({ since: 'yesterday' }, now), /ISO/);
    assert.throws(() => parseTimelineQuery({ since: '2026-10-28T13:00:00Z' }, now), /before/);
    assert.throws(() => parseTimelineQuery({ since: '2026-09-01T00:00:00Z' }, now), /31 days/);
    assert.doesNotThrow(() => parseTimelineQuery({ since: '2026-09-27T12:00:00Z' }, now));
  });
});
