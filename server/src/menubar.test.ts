// TM Bar's summary route (docs/menubar.md): GET /api/menubar over a temp SQLite
// DB with a stubbed orchestrator status. Run: npm test (node:test through tsx).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import Fastify from 'fastify';
import { buildInbox, menubarInboxCounts, type MenubarSummary, type OrchestratorStatus } from '@tm/shared';
import { registerMenubarRoutes } from './routes/menubar.ts';
import { loadInboxSources } from './inbox-input.ts';
import { SqliteStorage } from './storage/sqlite.ts';

const status: OrchestratorStatus = {
  enabled: true,
  paused: true,
  running: 1,
  concurrency: 2,
  aux: 0,
  memory: {
    sample: { at: '2026-11-06T00:00:00.000Z', freePct: 7, swapUsedMb: 900, swapTotalMb: 2048, swapPct: 44, pressureLevel: 2 },
    limits: { minFreePct: 10, maxSwapPct: 0 },
    tripped: true,
    since: '2026-11-06T00:00:00.000Z',
    reason: 'memory pressure: 7% free (minimum 10%)',
    breaches: 2,
    clears: 0,
    error: null,
    hold: 'memory pressure: 7% free (minimum 10%)',
  },
  heavy: { max: 1, auto: true, held: [], waiting: [] },
} as unknown as OrchestratorStatus;

let current = status;
let samples = 0;

describe('GET /api/menubar', () => {
  let tmp: string;
  let storage: SqliteStorage;
  const app = Fastify();
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-menubar-'));
    storage = new SqliteStorage(path.join(tmp, 'tm.db'));
    await storage.migrate();
    registerMenubarRoutes(app, storage, { status: () => current }, async () => {
      samples++;
      return { at: '2026-11-06T00:00:00.000Z', freePct: 55, swapUsedMb: 10, swapTotalMb: 1024, swapPct: 1, pressureLevel: 1 };
    });
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('running/waiting tasks with repo, run start and question; inbox = the shared buildInbox', async () => {
    const repo = await storage.createRepo({ name: 'nest', path: tmp });
    const a = await storage.createTask({ title: 'asks', repoId: repo.id, status: 'queued' }, 'human');
    const b = await storage.createTask({ title: 'parked', repoId: repo.id, status: 'queued' }, 'human');
    await storage.createTask({ title: 'idle draft', repoId: repo.id }, 'human');
    await storage.transitionTask(a.id, ['queued'], 'running', 'orchestrator');
    await storage.transitionTask(b.id, ['queued'], 'running', 'orchestrator');
    await storage.transitionTask(b.id, ['running'], 'waiting', 'orchestrator');
    const runA = await storage.createRun({ taskId: a.id, repoId: repo.id, mode: 'worker' });
    await storage.createQuestion({
      taskId: a.id,
      runId: runA.id,
      toolUseId: 'tu-1',
      questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'x', description: '' }, { label: 'y', description: '' }] }],
    } as never);

    const res = await app.inject({ method: 'GET', url: '/api/menubar' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as MenubarSummary;

    assert.deepEqual(body.queue, { enabled: true, paused: true, running: 1, concurrency: 2, aux: 0 });
    assert.equal(body.tasks.length, 2);
    // a known start sorts before an unknown one
    assert.equal(body.tasks[0].id, a.id);
    assert.equal(body.tasks[0].repoName, 'nest');
    assert.equal(body.tasks[0].status, 'running');
    assert.equal(body.tasks[0].startedAt, runA.startedAt);
    assert.equal(body.tasks[0].asking, true);
    assert.equal(body.tasks[1].id, b.id);
    assert.equal(body.tasks[1].status, 'waiting');
    assert.equal(body.tasks[1].startedAt, null);

    const src = await loadInboxSources(storage);
    const expected = menubarInboxCounts(buildInbox({ ...src, runs: src.live }));
    assert.deepEqual(body.inbox, expected);
    assert.equal(body.inbox.questions, 1);
    assert.equal(body.inbox.urgent, true);

    assert.equal(body.memory?.freePct, 7);
    assert.equal(body.memory?.armed, true);
    assert.equal(body.memory?.tripped, true);
    assert.match(body.memory?.hold ?? '', /7% free/);
    assert.deepEqual(body.heavy, { max: 1, held: 0, waiting: 0 });
  });

  test('with the fuse off the route reads free/swap itself, cached', async () => {
    current = { ...status, memory: { ...status.memory!, sample: null, limits: { minFreePct: 0, maxSwapPct: 0 }, tripped: false, reason: null, hold: null } };
    await new Promise((r) => setTimeout(r, 1100)); // past the 1 s coalescing window
    const a = (await app.inject({ method: 'GET', url: '/api/menubar' })).json() as MenubarSummary;
    await new Promise((r) => setTimeout(r, 1100));
    const b = (await app.inject({ method: 'GET', url: '/api/menubar' })).json() as MenubarSummary;
    assert.equal(a.memory?.freePct, 55);
    assert.equal(a.memory?.armed, false);
    assert.equal(a.memory?.hold, null);
    assert.equal(b.memory?.freePct, 55);
    assert.equal(samples, 1);
    current = status;
  });

  test('stale drafts are not counted', () => {
    const counts = menubarInboxCounts([{ kind: 'stale-draft' }, { kind: 'failed' }] as never);
    assert.deepEqual(counts, { total: 1, questions: 0, needsYou: 1, urgent: false });
  });
});
