// The memory fuse (docs/memory.md): the pure hysteresis, the sampler cache,
// and the holds it puts on the claim pass and office shifts — with a
// SIMULATED sampler, never the machine's own reading. Run: npm test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import type { MemorySample, Office, OfficeRole } from '@tm/shared';
import {
  MEMORY_CLEAR_SAMPLES,
  MEMORY_FUSE_IDLE,
  MEMORY_TRIP_SAMPLES,
  memoryBreach,
  memoryHoldReason,
  memoryLimits,
  parseSwapUsage,
  stepMemoryFuse,
} from '@tm/shared';
import { memoryHold, memoryState, sampleMemory, setMemorySampler } from './memory.ts';
import { officeGate } from './office/gate.ts';
import { Orchestrator } from './orchestrator.ts';
import { SessionManager } from './pty/session-manager.ts';
import { SqliteStorage } from './storage/sqlite.ts';

const sample = (freePct: number, swapUsedMb = 0, swapTotalMb = 4096): MemorySample => ({
  at: new Date().toISOString(),
  freePct,
  swapUsedMb,
  swapTotalMb,
  swapPct: swapTotalMb > 0 ? (swapUsedMb / swapTotalMb) * 100 : 0,
  pressureLevel: 1,
});
const ON = { 'memory.minFreePct': 10, 'memory.maxSwapPct': 80 };
const OFF = { 'memory.minFreePct': 0, 'memory.maxSwapPct': 0 };

describe('stepMemoryFuse (pure)', () => {
  const limits = memoryLimits(ON);

  test('trips only after consecutive breaching samples', () => {
    let s = stepMemoryFuse(MEMORY_FUSE_IDLE, sample(5), limits);
    assert.equal(s.tripped, false, 'one sample is not an episode');
    s = stepMemoryFuse(s, sample(30), limits);
    assert.equal(s.breaches, 0, 'a clear sample resets the count');
    for (let i = 0; i < MEMORY_TRIP_SAMPLES; i++) s = stepMemoryFuse(s, sample(5), limits);
    assert.equal(s.tripped, true);
    assert.equal(s.reason, 'memory pressure: 5% free (minimum 10%)');
    assert.ok(s.since);
  });

  test('swap over its limit trips too, with the GB in the reason', () => {
    let s = MEMORY_FUSE_IDLE;
    for (let i = 0; i < MEMORY_TRIP_SAMPLES; i++) s = stepMemoryFuse(s, sample(40, 5017.6, 6144), limits);
    assert.equal(s.tripped, true);
    assert.match(s.reason!, /swap 82% used \(4\.9 of 6\.0 GB, maximum 80%\)/);
  });

  test('clears only after MEMORY_CLEAR_SAMPLES samples inside the margin (hysteresis)', () => {
    let s = MEMORY_FUSE_IDLE;
    for (let i = 0; i < MEMORY_TRIP_SAMPLES; i++) s = stepMemoryFuse(s, sample(5), limits);
    const since = s.since;
    // back over the line but within the 5-point margin: neither clears nor counts
    for (let i = 0; i < 10; i++) s = stepMemoryFuse(s, sample(12), limits);
    assert.equal(s.tripped, true);
    assert.equal(s.clears, 0);
    assert.equal(s.since, since, 'the episode keeps its start');
    for (let i = 0; i < MEMORY_CLEAR_SAMPLES - 1; i++) s = stepMemoryFuse(s, sample(20), limits);
    assert.equal(s.tripped, true);
    // a relapse resets the clearing count
    s = stepMemoryFuse(s, sample(8), limits);
    assert.equal(s.clears, 0);
    for (let i = 0; i < MEMORY_CLEAR_SAMPLES; i++) s = stepMemoryFuse(s, sample(20), limits);
    assert.equal(s.tripped, false);
    assert.equal(s.since, null);
    assert.equal(s.reason, null);
  });

  test('turning it off clears at once; an unreadable machine fails open', () => {
    let s = MEMORY_FUSE_IDLE;
    for (let i = 0; i < MEMORY_TRIP_SAMPLES; i++) s = stepMemoryFuse(s, sample(5), limits);
    assert.equal(stepMemoryFuse(s, sample(5), memoryLimits(OFF)).tripped, false);
    let n = s;
    for (let i = 0; i < MEMORY_CLEAR_SAMPLES; i++) n = stepMemoryFuse(n, null, limits, 'sysctl failed');
    assert.equal(n.tripped, false);
    assert.equal(n.error, 'sysctl failed');
    let never = MEMORY_FUSE_IDLE;
    for (let i = 0; i < 5; i++) never = stepMemoryFuse(never, null, limits, 'x');
    assert.equal(never.tripped, false, 'a failed read never trips');
  });

  test('limits, breach, reason and the sysctl swap line', () => {
    assert.deepEqual(memoryLimits({ 'memory.minFreePct': -1, 'memory.maxSwapPct': Number.NaN }), { minFreePct: 0, maxSwapPct: 0 });
    assert.equal(memoryBreach(sample(5, 4000, 0), { minFreePct: 0, maxSwapPct: 50 }), null, 'no swap allocated is not a breach');
    assert.equal(memoryHoldReason({ tripped: true, reason: 'memory pressure: x' }, OFF), null, 'off releases the hold');
    assert.match(memoryHoldReason({ tripped: true, reason: 'memory pressure: x' }, ON)!, /new automatic work waits/);
    assert.deepEqual(parseSwapUsage('total = 4096.00M  used = 2791.75M  free = 1304.25M  (encrypted)'), { totalMb: 4096, usedMb: 2791.75 });
    assert.deepEqual(parseSwapUsage('total = 6.00G  used = 512.00M  free = 5.5G'), { totalMb: 6144, usedMb: 512 });
    assert.equal(parseSwapUsage('garbage'), null);
  });
});

describe('the sampler cache', () => {
  afterEach(() => setMemorySampler(null));

  test('a simulated sampler trips and clears the cached hold; off takes no sample', async () => {
    let free = 5;
    let calls = 0;
    setMemorySampler(async () => (calls++, sample(free)));
    assert.equal((await sampleMemory(ON)).change, null);
    assert.equal((await sampleMemory(ON)).change, 'tripped');
    assert.match(memoryHold(ON)!, /5% free/);
    assert.equal(memoryHold(OFF), null);
    free = 50;
    const changes = [];
    for (let i = 0; i < MEMORY_CLEAR_SAMPLES; i++) changes.push((await sampleMemory(ON)).change);
    assert.deepEqual(changes, [null, null, 'cleared']);
    assert.equal(memoryHold(ON), null);
    const before = calls;
    await sampleMemory(OFF);
    assert.equal(calls, before, 'the fuse off never reads the machine');
    // a throwing sampler fails open
    setMemorySampler(async () => {
      throw new Error('boom');
    });
    await sampleMemory(ON);
    assert.equal(memoryState().error, 'boom');
    assert.equal(memoryState().tripped, false);
  });
});

describe('the holds (simulated sampler)', () => {
  let tmp = '';
  let storage: SqliteStorage;
  let orch: Orchestrator;
  let repoId = '';
  let free = 50;
  const started: string[] = [];

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-memory-'));
    storage = new SqliteStorage(path.join(tmp, 'tm.db'));
    await storage.migrate();
    repoId = (await storage.createRepo({ name: 'r', path: tmp } as any)).id;
    setMemorySampler(async () => sample(free));
    orch = new Orchestrator(storage, new SessionManager(() => 1024), 'http://127.0.0.1:1');
    // never spawn a real claude: record the start and refuse it
    (orch as any).startWorker = async (task: { id: string }) => {
      started.push(task.id);
      return false;
    };
  });
  after(() => {
    setMemorySampler(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** one scheduling pass, settled */
  async function pass(): Promise<void> {
    orch.maybeSchedule();
    for (let i = 0; i < 100 && (orch as any).scheduling; i++) await new Promise((r) => setTimeout(r, 10));
  }

  async function office(): Promise<{ o: Office; r: OfficeRole }> {
    const ws = await storage.createWorkspace({ name: 'ws', slug: 'ws-mem', repoIds: [repoId], color: null });
    const o = await storage.createOffice({ workspaceId: ws.id, folderPath: path.join(tmp, 'office'), timezone: 'UTC', enabled: true, dayBudgetUsd: 5 });
    const r = await storage.createOfficeRole({
      officeId: o.id,
      key: 'qa',
      name: 'Quinn',
      avatar: '🧪',
      title: 'QA',
      prompt: 'find bugs',
      model: 'claude-opus-5-5',
      tools: ['Read'],
      schedules: [],
      triggers: [],
      guards: [],
      notesPath: 'roles/qa.md',
    });
    return { o, r };
  }

  test('tripped: no claim, an alert once, a readable status; cleared: the claim runs', async () => {
    await storage.setSetting('memory.minFreePct', 10);
    await storage.setSetting('orchestrator.enabled', true);
    const queued = await storage.createTask({ title: 'q', repoId, status: 'queued' } as any, 'test');
    if (queued.status !== 'queued') await storage.transitionTask(queued.id, [queued.status], 'queued', 'test');
    const { o, r } = await office();

    free = 4;
    for (let i = 0; i < MEMORY_TRIP_SAMPLES; i++) await orch.memorySweep();
    // what status() carries as `memory` (status() itself needs the aux runner)
    assert.equal(memoryState().tripped, true);
    assert.match(memoryHold(await storage.getSettings())!, /memory pressure: 4% free \(minimum 10%\) — new automatic work waits/);

    await pass();
    assert.deepEqual(started, [], 'nothing is claimed while the fuse holds');
    assert.equal((await storage.getTask(queued.id))!.status, 'queued');

    // an automatic shift defers with the reason; a human's request still passes
    const cron = await officeGate(storage, o, r, { kind: 'cron' });
    assert.equal(!cron.ok && cron.code, 'memory');
    assert.equal((await officeGate(storage, o, r, { kind: 'request' })).ok, true);

    // a verify round due in `review` is held with its state left `pending`
    const parked = await storage.createTask({ title: 'p', repoId, status: 'queued' } as any, 'test');
    await storage.updateTask(parked.id, { status: 'review', reviewState: 'pending' } as any);
    const fresh = await storage.getTask(parked.id);
    if (fresh!.status !== 'review') await storage.transitionTask(parked.id, [fresh!.status], 'review', 'test', { reviewState: 'pending' } as any);
    await orch.reviewCompletedRun(parked.id);
    assert.equal((await storage.getTask(parked.id))!.reviewState, 'pending');
    const held = await storage.listEvents({ kind: 'task.memory-held', limit: 10 });
    assert.equal(held.length, 1);
    assert.equal(held[0].taskId, parked.id);
    // the clear re-runs it: park it out of review first so the re-run is a no-op here
    await storage.transitionTask(parked.id, ['review'], 'cancelled', 'test');

    // still low: no second alert for the same episode
    await orch.memorySweep();
    const alerts = (await storage.listEvents({ kind: 'anomaly.notified', limit: 100 })).filter(
      (e) => (e.data as { type?: string }).type === 'memory-pressure',
    );
    assert.equal(alerts.length, 1);
    assert.equal((await storage.listEvents({ kind: 'memory.fuse', limit: 100 })).length, 1);

    // back over the line but inside the margin: still held
    free = 12;
    for (let i = 0; i < MEMORY_CLEAR_SAMPLES + 1; i++) await orch.memorySweep();
    assert.equal(memoryState().tripped, true);

    free = 40;
    for (let i = 0; i < MEMORY_CLEAR_SAMPLES; i++) await orch.memorySweep();
    assert.equal(memoryHold(await storage.getSettings()), null);
    await pass();
    assert.deepEqual(started, [queued.id], 'the clear releases the claim');
    const fuseRows = await storage.listEvents({ kind: 'memory.fuse', limit: 100 });
    assert.deepEqual(fuseRows.map((e) => (e.data as { tripped: boolean }).tripped).sort(), [false, true]);
    assert.equal((await officeGate(storage, o, r, { kind: 'cron' })).ok, true);
  });
});
