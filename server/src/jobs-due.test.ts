// docs/jobs.md — the pure firing rule and schedule parsing.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  formatDuration,
  jobsDue,
  nextRunAfter,
  parseDuration,
  resolveSchedule,
  roughDuration,
  runNowRefusal,
  type Job,
  type JobsDueInput,
} from '@tm/shared';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const H = 3_600_000;

function job(id: string, nextRunAt: string | null, over: Partial<Job> = {}): Job {
  return {
    id,
    repoId: 'r1',
    title: id,
    instructions: 'look',
    context: null,
    source: 'human',
    createdByRun: null,
    createdByTask: null,
    status: 'scheduled',
    nextRunAt,
    repeatEveryMs: null,
    repeatUntil: null,
    maxRuns: null,
    runsCount: 0,
    model: null,
    effort: null,
    lastRunId: null,
    lastVerdict: null,
    lastSummary: null,
    lastRunAt: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...over,
  };
}
const iso = (ms: number) => new Date(ms).toISOString();
const input = (over: Partial<JobsDueInput> = {}): JobsDueInput => ({
  now: NOW,
  activeTasks: 0,
  liveJobRuns: 0,
  paused: false,
  settings: { enabled: true, maxActiveTasks: 3, concurrency: 1 },
  ...over,
});

describe('parseDuration', () => {
  test('units and compounds', () => {
    assert.equal(parseDuration('7d'), 7 * 24 * H);
    assert.equal(parseDuration('36h'), 36 * H);
    assert.equal(parseDuration('90m'), 90 * 60_000);
    assert.equal(parseDuration('90min'), 90 * 60_000);
    assert.equal(parseDuration('2w'), 14 * 24 * H);
    assert.equal(parseDuration('1d12h'), 36 * H);
    assert.equal(parseDuration(' 1D 12H '), 36 * H);
  });
  test('refuses bare numbers and junk', () => {
    for (const s of ['', '7', 'd', '7x', '-1d', '0h', '1d-2h', 'tomorrow']) assert.equal(parseDuration(s), null, s);
  });
  test('formatDuration round-trips', () => {
    for (const s of ['7d', '36h', '1h30m', '2w', '12h']) {
      const ms = parseDuration(s)!;
      assert.equal(parseDuration(formatDuration(ms)), ms, s);
    }
    assert.equal(formatDuration(36 * H), '1d12h');
  });
  test('roughDuration keeps one or two units', () => {
    assert.equal(roughDuration(2 * 24 * H - 60_000), '2d');
    assert.equal(roughDuration(29 * H), '1d 5h');
    assert.equal(roughDuration(4 * 24 * H + 7 * H), '4d');
    assert.equal(roughDuration(3 * H + 20 * 60_000), '3h');
    assert.equal(roughDuration(40 * 60_000), '40m');
  });
});

describe('resolveSchedule', () => {
  test('delay and runAt', () => {
    const a = resolveSchedule({ delay: '7d' }, NOW);
    assert.ok(!('error' in a));
    assert.equal(a.nextRunAt, iso(NOW + 7 * 24 * H));
    assert.equal(a.repeatEveryMs, null);
    const b = resolveSchedule({ runAt: iso(NOW + H) }, NOW);
    assert.ok(!('error' in b) && b.nextRunAt === iso(NOW + H));
  });
  test('refusals', () => {
    const err = (s: ReturnType<typeof resolveSchedule>) => ('error' in s ? s.error : '');
    assert.match(err(resolveSchedule({}, NOW)), /required/);
    assert.match(err(resolveSchedule({ delay: '1d', runAt: iso(NOW) }, NOW)), /not both/);
    assert.match(err(resolveSchedule({ delay: '5m' }, NOW, { minDelayMs: 10 * 60_000 })), /at least 10m/);
    assert.match(err(resolveSchedule({ delay: '181d' }, NOW)), /180 days/);
    assert.match(err(resolveSchedule({ delay: '1d', repeat: { every: '30m' } }, NOW)), /at least 1h/);
    assert.match(err(resolveSchedule({ delay: '1d', repeat: { every: '1d', maxRuns: 101 } }, NOW)), /maxRuns/);
    assert.match(err(resolveSchedule({ delay: '2d', repeat: { every: '1d', until: iso(NOW + H) } }, NOW)), /before the first/);
  });
  test('repeat resolves', () => {
    const r = resolveSchedule({ delay: '1d', repeat: { every: '12h', maxRuns: 4, until: iso(NOW + 10 * 24 * H) } }, NOW);
    assert.ok(!('error' in r));
    assert.equal(r.repeatEveryMs, 12 * H);
    assert.equal(r.maxRuns, 4);
    assert.equal(r.repeatUntil, iso(NOW + 10 * 24 * H));
  });
});

describe('jobsDue', () => {
  test('fires the oldest due first, within concurrency', () => {
    const jobs = [job('b', iso(NOW - H)), job('a', iso(NOW - 2 * H)), job('later', iso(NOW + H)), job('p', iso(NOW - 3 * H), { status: 'paused' })];
    const r = jobsDue(jobs, input());
    assert.deepEqual(r.fire.map((j) => j.id), ['a']);
    assert.deepEqual(r.due.map((j) => j.id), ['a', 'b']);
    assert.equal(r.hold, 'concurrency');
    const r2 = jobsDue(jobs, input({ settings: { enabled: true, maxActiveTasks: 3, concurrency: 3 } }));
    assert.deepEqual(r2.fire.map((j) => j.id), ['a', 'b']);
    assert.equal(r2.hold, null);
  });
  test('ties break on createdAt', () => {
    const at = iso(NOW - H);
    const r = jobsDue([job('y', at, { createdAt: '2026-11-02T00:00:00Z' }), job('x', at, { createdAt: '2026-11-01T00:00:00Z' })], input());
    assert.equal(r.fire[0].id, 'x');
  });
  test('threshold: running+waiting < maxActiveTasks; 0 = no threshold', () => {
    const jobs = [job('a', iso(NOW - H))];
    assert.equal(jobsDue(jobs, input({ activeTasks: 2 })).fire.length, 1);
    const busy = jobsDue(jobs, input({ activeTasks: 3 }));
    assert.equal(busy.fire.length, 0);
    assert.equal(busy.hold, 'busy');
    assert.equal(jobsDue(jobs, input({ activeTasks: 9, settings: { enabled: true, maxActiveTasks: 0, concurrency: 1 } })).fire.length, 1);
  });
  test('switch, pause and live runs hold', () => {
    const jobs = [job('a', iso(NOW - H))];
    assert.equal(jobsDue(jobs, input({ settings: { enabled: false, maxActiveTasks: 3, concurrency: 1 } })).hold, 'off');
    assert.equal(jobsDue(jobs, input({ paused: true })).hold, 'paused');
    const live = jobsDue(jobs, input({ liveJobRuns: 1 }));
    assert.equal(live.fire.length, 0);
    assert.equal(live.hold, 'concurrency');
  });
  test('nothing due → no hold', () => {
    assert.deepEqual(jobsDue([job('a', iso(NOW + H))], input({ paused: true })), { fire: [], due: [], hold: null });
  });
});

describe('nextRunAfter', () => {
  const every = { repeatEveryMs: 24 * H, repeatUntil: null, maxRuns: null };
  test('one-shot is done', () => {
    assert.equal(nextRunAfter({ repeatEveryMs: null, repeatUntil: null, maxRuns: null }, 1, NOW, NOW), null);
  });
  test('on time keeps the cadence', () => {
    assert.equal(nextRunAfter(every, 1, NOW - 60_000, NOW), iso(NOW - 60_000 + 24 * H));
  });
  test('missed slots fire once, then now + every (no catch-up storm)', () => {
    assert.equal(nextRunAfter(every, 1, NOW - 5 * 24 * H, NOW), iso(NOW + 24 * H));
  });
  test('maxRuns and until end it', () => {
    assert.equal(nextRunAfter({ ...every, maxRuns: 3 }, 3, NOW, NOW), null);
    assert.ok(nextRunAfter({ ...every, maxRuns: 3 }, 2, NOW, NOW));
    assert.equal(nextRunAfter({ ...every, repeatUntil: iso(NOW + H) }, 1, NOW, NOW), null);
  });
});

describe('runNowRefusal', () => {
  test('bypasses switch/threshold, not pause or concurrency', () => {
    assert.equal(runNowRefusal({ status: 'scheduled' }, { liveJobRuns: 0, paused: false, concurrency: 1 }), null);
    assert.equal(runNowRefusal({ status: 'done' }, { liveJobRuns: 0, paused: false, concurrency: 1 }), null);
    assert.match(runNowRefusal({ status: 'scheduled' }, { liveJobRuns: 0, paused: true, concurrency: 1 })!, /Pause/);
    assert.match(runNowRefusal({ status: 'scheduled' }, { liveJobRuns: 1, paused: false, concurrency: 1 })!, /concurrency/);
    assert.match(runNowRefusal({ status: 'running' }, { liveJobRuns: 0, paused: false, concurrency: 1 })!, /already/);
  });
});
