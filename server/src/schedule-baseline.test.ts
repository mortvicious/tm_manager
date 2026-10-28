// Duration baseline for schedule ETAs (docs/schedule.md § Baseline).
// Run: npm test   (node:test through tsx; the pure function only)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { durationBaseline, PROGRESS_MIN_TASKS, runWorkedMs, scheduleLineFor } from '@tm/shared';

const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const NOW = new Date(T0 + 30 * 24 * 3600_000);
const MIN = 60_000;

type Run = Parameters<typeof durationBaseline>[1][number];
type Ev = Parameters<typeof durationBaseline>[2][number];

let seq = 0;
const worker = (taskId: string, start: number, end: number | null): Run => ({
  id: `r${++seq}`,
  taskId,
  mode: 'worker',
  kind: 'worker' as Run['kind'],
  subjectId: null,
  startedAt: at(start),
  endedAt: end === null ? null : at(end),
});
const statsFinal = (runId: string, min: number): Ev => ({ kind: 'run.stats-final', runId, taskId: null, at: at(min), data: {} });

/** `count` landed tasks in `repo`, each one worker run of `minutes`, exiting at the end */
function landedTasks(repo: string, count: number, minutes: number) {
  const tasks = Array.from({ length: count }, (_, i) => ({ id: `${repo}-${i}`, repoId: repo, status: 'done' as const }));
  return { tasks, runs: tasks.map((t) => worker(t.id, 0, minutes)) };
}

describe('runWorkedMs', () => {
  test('stops at the first idle, else the exit, else now', () => {
    const run = { startedAt: at(0), endedAt: at(600) };
    assert.equal(runWorkedMs(run, at(20)), 20 * MIN);
    assert.equal(runWorkedMs(run, undefined), 600 * MIN);
    assert.equal(runWorkedMs({ startedAt: at(0), endedAt: null }, undefined, T0 + 5 * MIN), 5 * MIN);
  });
});

describe('durationBaseline', () => {
  test('hours idle after the first stats-final are not worked time', () => {
    const { tasks, runs } = landedTasks('a', PROGRESS_MIN_TASKS, 10);
    // one session idled in review for 8 h before its PTY exited
    const idle = worker('a-0', 0, 8 * 60 + 15);
    runs[0] = idle;
    const b = durationBaseline(tasks, runs, [statsFinal(idle.id, 15), statsFinal(idle.id, 8 * 60 + 15)], NOW);
    const line = b.byRepo.a;
    assert.ok(line);
    assert.equal(line.n, PROGRESS_MIN_TASKS);
    // 9 tasks at 10 min + one at 15 (its first stats-final), not 495
    assert.equal(line.workMs.median, 10 * MIN);
    assert.equal(line.workMs.p75, 10 * MIN);
    assert.ok(Math.max(line.workMs.median, line.workMs.p75) < 60 * MIN);
  });

  test('a task with several worker runs sums them', () => {
    const tasks = Array.from({ length: PROGRESS_MIN_TASKS }, (_, i) => ({ id: `m${i}`, repoId: 'm', status: 'published' as const }));
    const runs = tasks.flatMap((t) => [worker(t.id, 0, 10), worker(t.id, 100, 120), worker(t.id, 300, 305)]);
    const b = durationBaseline(tasks, runs, [], NOW);
    assert.equal(b.byRepo.m.workMs.median, 35 * MIN);
  });

  test('a repo below the threshold falls back to all repos', () => {
    const big = landedTasks('big', PROGRESS_MIN_TASKS, 10);
    const small = landedTasks('small', PROGRESS_MIN_TASKS - 1, 40);
    const b = durationBaseline([...big.tasks, ...small.tasks], [...big.runs, ...small.runs], [], NOW);
    assert.ok(b.byRepo.big);
    assert.equal(b.byRepo.small, undefined);
    assert.equal(b.all?.n, 2 * PROGRESS_MIN_TASKS - 1);
    assert.equal(scheduleLineFor(b, 'small'), b.all);
    assert.equal(scheduleLineFor(b, 'big'), b.byRepo.big);
    // below the threshold overall there is no line at all
    const none = durationBaseline(small.tasks, small.runs, [], NOW);
    assert.equal(none.all, null);
    assert.equal(scheduleLineFor(none, 'small'), null);
  });

  test('only landed tasks count; review runs and check stages give medians', () => {
    const { tasks, runs } = landedTasks('r', PROGRESS_MIN_TASKS, 10);
    const open = { id: 'open', repoId: 'r', status: 'review' as const };
    const review = (subjectId: string, minutes: number, i: number): Run => ({
      id: `rv${i}`,
      taskId: null,
      mode: 'aux',
      kind: 'review',
      subjectId,
      startedAt: at(20),
      endedAt: at(20 + minutes),
    });
    const checked = (taskId: string, data: Record<string, unknown>): Ev => ({ kind: 'task.checked', runId: null, taskId, at: at(15), data });
    const b = durationBaseline(
      [...tasks, open],
      [
        ...runs,
        worker('open', 0, 999),
        review('r-0', 4, 1),
        review('r-1', 6, 2),
        review('r-2', 8, 3),
        review('open', 60, 4),
        { ...review('r-3', 0, 5), endedAt: null },
      ],
      [
        checked('r-0', { state: 'green', round: 1, results: [{ durationMs: 30_000 }, { durationMs: 60_000 }] }),
        checked('r-1', { skipped: 'empty-diff' }),
        checked('open', { state: 'red', results: [{ durationMs: 999_000 }] }),
      ],
      NOW,
    );
    const line = b.byRepo.r;
    assert.equal(line.n, PROGRESS_MIN_TASKS);
    assert.equal(line.workMs.p75, 10 * MIN);
    assert.equal(line.reviewMs, 6 * MIN);
    assert.equal(line.checkMs, 90_000);
    assert.equal(b.all?.checkMs, 90_000);
  });
});
