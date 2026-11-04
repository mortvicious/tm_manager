// docs/jobs.md — the storage half on a temp SQLite DB: the conditional claim
// (single winner, only while due), steps, run rows and acknowledgement.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { SqliteStorage } from './sqlite.ts';
import type { NewJob } from './job-sql.ts';

let tmp = '';
let storage: SqliteStorage;
const iso = (ms: number) => new Date(ms).toISOString();

const newJob = (over: Partial<NewJob> = {}): NewJob => ({
  repoId: 'r1',
  title: 'check the logs',
  instructions: 'look at error rates',
  context: { taskId: 't1', taskTitle: 'endpoint', commits: [{ sha: 'abc', subject: 'add endpoint' }] },
  source: 'agent',
  createdByRun: 'run1',
  createdByTask: 't1',
  nextRunAt: iso(Date.now() - 60_000),
  repeatEveryMs: 15_552_000_000, // 180 days: overflows a 32-bit int
  repeatUntil: null,
  maxRuns: null,
  model: null,
  effort: null,
  ...over,
});

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-jobs-'));
  storage = new SqliteStorage(path.join(tmp, 'tm.db'));
  await storage.migrate();
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('jobs storage', () => {
  test('create reads back every field', async () => {
    const j = await storage.createJob(newJob());
    assert.equal(j.status, 'scheduled');
    assert.equal(j.runsCount, 0);
    assert.equal(j.repeatEveryMs, 15_552_000_000);
    assert.deepEqual(j.context?.commits, [{ sha: 'abc', subject: 'add endpoint' }]);
    assert.equal(await storage.countLiveJobs('r1'), 1);
    assert.equal((await storage.listJobs({ createdByTask: 't1' })).length, 1);
    assert.equal((await storage.listJobs({ status: [] })).length, 0);
  });

  test('claimDueJob: only while due, single winner', async () => {
    const later = await storage.createJob(newJob({ nextRunAt: iso(Date.now() + 3_600_000) }));
    assert.equal(await storage.claimDueJob(later.id, iso(Date.now())), null, 'not due yet');
    const due = await storage.createJob(newJob());
    const now = iso(Date.now());
    const [a, b] = await Promise.all([storage.claimDueJob(due.id, now), storage.claimDueJob(due.id, now)]);
    assert.ok((a && !b) || (!a && b), 'exactly one claim wins');
    assert.equal((await storage.getJob(due.id))!.status, 'running');
    assert.equal(await storage.claimDueJob(due.id, now, true), null, 'running is never re-claimed, even forced');
  });

  test('forced claim (Run now) takes paused/done, never cancelled', async () => {
    const j = await storage.createJob(newJob({ nextRunAt: iso(Date.now() + 3_600_000) }));
    assert.ok(await storage.stepJob(j.id, ['scheduled'], 'paused'));
    assert.ok(await storage.claimDueJob(j.id, iso(Date.now()), true));
    const c = await storage.createJob(newJob());
    assert.ok(await storage.stepJob(c.id, ['scheduled'], 'cancelled', { nextRunAt: null }));
    assert.equal(await storage.claimDueJob(c.id, iso(Date.now()), true), null);
  });

  test('stepJob is conditional and writes last_* + runs_count', async () => {
    const j = await storage.createJob(newJob());
    await storage.claimDueJob(j.id, iso(Date.now()));
    const next = iso(Date.now() + 86_400_000);
    const done = await storage.stepJob(j.id, ['running'], 'scheduled', {
      nextRunAt: next,
      last: { runId: 'aux1', verdict: 'attention', summary: '5xx up', at: iso(Date.now()), counted: true },
    });
    assert.ok(done);
    assert.equal(done.runsCount, 1);
    assert.equal(done.nextRunAt, next);
    assert.equal(done.lastVerdict, 'attention');
    assert.equal(await storage.stepJob(j.id, ['running'], 'scheduled'), null, 'not running any more');
  });

  test('job runs: finish once, open list, acknowledge', async () => {
    const j = await storage.createJob(newJob());
    const r = await storage.createJobRun({ jobId: j.id, runNumber: 1, firedBy: 'orchestrator' });
    assert.equal(r.endedAt, null);
    await storage.setJobRunRunId(r.id, 'aux9');
    assert.deepEqual((await storage.listUnfinishedJobRuns()).map((x) => x.id).includes(r.id), true);
    const fin = { verdict: 'attention' as const, summary: 's', findings: [{ severity: 'warn' as const, text: 't' }], followUpTaskIds: ['x'], reportPath: null, error: null };
    const f = await storage.finishJobRun(r.id, fin);
    assert.ok(f);
    assert.equal(f.runId, 'aux9');
    assert.deepEqual(f.findings, fin.findings);
    assert.equal(await storage.finishJobRun(r.id, fin), null, 'finished once');
    assert.ok((await storage.listOpenJobRuns()).some((x) => x.id === r.id));
    assert.equal((await storage.acknowledgeJobRuns(j.id)).length, 1);
    assert.ok(!(await storage.listOpenJobRuns()).some((x) => x.id === r.id));
    assert.equal(await storage.deleteJob(j.id), true);
    assert.equal((await storage.listJobRuns(j.id)).length, 0);
  });
});
