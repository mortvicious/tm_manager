// Memory per run (docs/memory.md § Memory per run): the process-table
// parsers, the tree fold, the `memory-high` episode, and the sampler over a
// SIMULATED table — never the machine's own reading. Run: npm test.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MemorySample, MemTree, MemTreeRoot } from '@tm/shared';
import {
  MEMORY_HIGH_CLEAR_SAMPLES,
  MEMORY_HIGH_IDLE,
  foldTrees,
  memoryHighBreach,
  memoryHighLimits,
  parsePsRss,
  parseTopMem,
  stepMemoryHigh,
} from '@tm/shared';

const sys = (freePct: number, pressureLevel: number | null = 1): MemorySample => ({
  at: new Date().toISOString(),
  freePct,
  swapUsedMb: 4900,
  swapTotalMb: 6144,
  swapPct: 80,
  pressureLevel,
});
const root = (id: string, pid: number, kind: MemTreeRoot['kind'] = 'worker'): MemTreeRoot => ({
  id,
  kind,
  pid,
  label: id,
  taskId: null,
  repoId: null,
  runId: kind === 'worker' || kind === 'aux' ? id : null,
  sub: null,
});
const tree = (label: string, mb: number): MemTree => ({ ...root(label, 1), mb, peakMb: mb, procs: 1, biggest: null });

describe('process table parsers', () => {
  test('top -l 1: header skipped, units and +/- suffixes, command with spaces', () => {
    const out = [
      'Processes: 540 total, 3 running, 537 sleeping, 2831 threads',
      'PhysMem: 7591M used (1440M wired, 2602M compressor), 98M unused.',
      '',
      'PID    PPID  MEM   COMMAND',
      '474    1     892M  WindowServer',
      '64489  64487 2464K node',
      '7      1     1.7G+ tsc --noEmit',
      '8      7     512B- x',
    ].join('\n');
    const rows = parseTopMem(out);
    assert.deepEqual(
      rows.map((r) => [r.pid, r.ppid, Math.round(r.mb * 10) / 10, r.comm]),
      [
        [474, 1, 892, 'WindowServer'],
        [64489, 64487, 2.4, 'node'],
        [7, 1, 1740.8, 'tsc --noEmit'],
        [8, 7, 0, 'x'],
      ],
    );
  });

  test('ps rss is KiB and comm is a basename', () => {
    assert.deepEqual(parsePsRss('  10   1  2048 /usr/bin/node\n  11  10 1024 claude\n'), [
      { pid: 10, ppid: 1, mb: 2, comm: 'node' },
      { pid: 11, ppid: 10, mb: 1, comm: 'claude' },
    ]);
  });
});

describe('foldTrees', () => {
  const procs = [
    { pid: 1, ppid: 0, mb: 50, comm: 'launchd' },
    { pid: 100, ppid: 1, mb: 300, comm: 'node' }, // the API
    { pid: 200, ppid: 100, mb: 250, comm: 'claude' }, // worker A
    { pid: 201, ppid: 200, mb: 1700, comm: 'tsc' },
    { pid: 202, ppid: 201, mb: 10, comm: 'sh' },
    { pid: 300, ppid: 100, mb: 2600, comm: 'node' }, // a repo command
    { pid: 400, ppid: 100, mb: 40, comm: 'orphan' },
  ];

  test('each process billed once; the server row is the API alone; biggest first', () => {
    const trees = foldTrees(procs, [root('api', 100, 'server'), root('run-a', 200), root('cmd', 300, 'command'), root('gone', 999)], new Map([['run-a', 5000]]));
    assert.deepEqual(
      trees.map((t) => [t.id, t.mb, t.procs, t.biggest?.comm, t.peakMb]),
      [
        ['cmd', 2600, 1, 'node', 2600],
        ['run-a', 1960, 3, 'tsc', 5000],
        ['api', 300, 1, 'node', 300],
      ],
    );
  });

  test('a root nested under another root is not counted twice', () => {
    const trees = foldTrees(procs, [root('outer', 200), root('inner', 201, 'command')]);
    const byId = Object.fromEntries(trees.map((t) => [t.id, t.mb]));
    assert.deepEqual(byId, { outer: 250, inner: 1710 });
  });
});

describe('memory-high episode (pure)', () => {
  const limits = memoryHighLimits({ 'anomaly.memoryTreeGb': 2, 'anomaly.memoryPressure': true });

  test('limits: 0 GB is the tree half off; pressure defaults on', () => {
    assert.deepEqual(memoryHighLimits({}), { treeMb: 0, pressure: true });
    assert.deepEqual(memoryHighLimits({ 'anomaly.memoryTreeGb': 0, 'anomaly.memoryPressure': false }), { treeMb: 0, pressure: false });
  });

  test('a big tree or kernel pressure is a breach; normal is not', () => {
    assert.equal(memoryHighBreach(sys(40), [tree('nest', 1000)], limits), null);
    assert.match(memoryHighBreach(sys(40), [tree('nest watch', 2600)], limits)!, /nest watch 2\.5 GB above 2\.0 GB/);
    assert.match(memoryHighBreach(sys(8, 2), [], limits)!, /system memory pressure warn \(8% free, swap 4\.8 GB of 6\.0 GB\)/);
    // no kernel level (Linux): under 10 % free counts as pressure
    assert.match(memoryHighBreach(sys(5, null), [], limits)!, /system memory pressure \(5% free/);
    assert.equal(memoryHighBreach(sys(8, 2), [], { treeMb: 0, pressure: false }), null);
  });

  test('opens after 2 samples, holds in the band, closes after 3 calm samples', () => {
    const at = (n: number) => `2026-11-06T10:00:${String(n).padStart(2, '0')}Z`;
    let s = stepMemoryHigh(MEMORY_HIGH_IDLE, sys(40), [tree('nest', 2600)], limits, at(0));
    assert.equal(s.high, false);
    assert.equal(s.breaches, 1);
    s = stepMemoryHigh(s, sys(40), [tree('nest', 2600)], limits, at(1));
    assert.equal(s.high, true);
    assert.equal(s.since, at(1));
    assert.equal(s.severity, 'warn');
    // 1900 MB is under the line but inside 90 %: stays high, does not count
    for (let i = 0; i < 5; i++) s = stepMemoryHigh(s, sys(40), [tree('nest', 1900)], limits, at(2 + i));
    assert.equal(s.high, true);
    assert.equal(s.since, at(1), 'one episode, one key');
    // critical pressure escalates the open episode's severity
    s = stepMemoryHigh(s, sys(3, 4), [], limits, at(10));
    assert.equal(s.severity, 'critical');
    const highs: boolean[] = [];
    for (let i = 0; i < MEMORY_HIGH_CLEAR_SAMPLES; i++) highs.push((s = stepMemoryHigh(s, sys(40), [tree('nest', 500)], limits, at(20 + i))).high);
    assert.deepEqual(highs, [true, true, false]);
    assert.equal(s.since, null);
  });

  test('a single spike never opens an episode; both halves off resets', () => {
    let s = stepMemoryHigh(MEMORY_HIGH_IDLE, sys(40), [tree('tsc', 3000)], limits, 'a');
    s = stepMemoryHigh(s, sys(40), [tree('tsc', 100)], limits, 'b');
    assert.equal(s.breaches, 0);
    s = stepMemoryHigh(s, sys(40), [tree('tsc', 3000)], limits, 'c');
    assert.equal(s.high, false);
    assert.deepEqual(stepMemoryHigh({ ...s, high: true }, sys(3, 4), [], { treeMb: 0, pressure: false }, 'd'), MEMORY_HIGH_IDLE);
  });
});

// ---- the sampler and the orchestrator sweep, over a SIMULATED process table ----

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before } from 'node:test';
import type { ProcEntry } from '@tm/shared';
import { MEMORY_HIGH_TRIP_SAMPLES, PEAK_WRITE_STEP_MB } from '@tm/shared';
import { AuxRunner, initAux } from './claude/aux.ts';
import { Orchestrator } from './orchestrator.ts';
import { procMemoryState, sampleProcMemory, setProcMemoryReaders } from './proc-memory.ts';
import { SessionManager } from './pty/session-manager.ts';
import { SqliteStorage } from './storage/sqlite.ts';

describe('sampleProcMemory', () => {
  afterEach(() => setProcMemoryReaders(null));
  const ON = { 'anomaly.memoryTreeGb': 2, 'anomaly.memoryPressure': true };

  test('peaks grow, writes only on a real step, a gone root flushes its peak; an unreadable table keeps the trees', async () => {
    let worker = 500;
    let alive = true;
    let fail = false;
    setProcMemoryReaders(
      async () => {
        if (fail) throw new Error('top failed');
        const procs: ProcEntry[] = [{ pid: 1, ppid: 0, mb: 10, comm: 'launchd' }];
        if (alive) procs.push({ pid: 50, ppid: 1, mb: worker, comm: 'claude' });
        return { procs, method: 'footprint' };
      },
      async () => sys(40),
    );
    const roots = [root('run-1', 50)];
    let r = await sampleProcMemory(roots, ON);
    assert.deepEqual(r.writes, [{ runId: 'run-1', peakMb: 500 }], 'the first sample writes');
    worker = 500 + PEAK_WRITE_STEP_MB - 1;
    r = await sampleProcMemory(roots, ON);
    assert.deepEqual(r.writes, [], 'under the step: no write');
    worker = 900;
    r = await sampleProcMemory(roots, ON);
    assert.deepEqual(r.writes, [{ runId: 'run-1', peakMb: 900 }]);
    worker = 920; // peak 920, under the step → not written yet
    r = await sampleProcMemory(roots, ON);
    assert.equal(r.snapshot.trees[0].peakMb, 920);
    worker = 300;
    r = await sampleProcMemory(roots, ON);
    assert.equal(r.snapshot.trees[0].mb, 300);
    assert.equal(r.snapshot.trees[0].peakMb, 920, 'the peak never drops');
    alive = false;
    r = await sampleProcMemory(roots, ON);
    assert.deepEqual(r.writes, [{ runId: 'run-1', peakMb: 920 }], 'the end flushes the unwritten rest');
    assert.equal(r.snapshot.trees.length, 0);
    alive = true;
    worker = 100;
    await sampleProcMemory(roots, ON);
    fail = true;
    r = await sampleProcMemory(roots, ON);
    assert.equal(r.snapshot.error, 'top failed');
    assert.equal(r.snapshot.trees.length, 1, 'the previous trees stay');
    assert.equal(r.change, null);
  });
});

describe('the orchestrator sweep (temp SQLite, simulated table)', () => {
  let tmp = '';
  let storage: SqliteStorage;
  let orch: Orchestrator;
  let sessions: SessionManager;
  let treeMb = 500;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-procmem-'));
    storage = new SqliteStorage(path.join(tmp, 'tm.db'));
    await storage.migrate();
    sessions = new SessionManager(() => 1024);
    // the PTY's exit path and status() read the aux runner
    initAux(new AuxRunner(storage, new SessionManager(() => 1024), 'http://127.0.0.1:1'));
    orch = new Orchestrator(storage, sessions, 'http://127.0.0.1:1');
  });
  after(() => {
    setProcMemoryReaders(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('a live worker PTY is measured, its peak stored on tm_runs, and memory-high alerts once per episode', async () => {
    const repo = await storage.createRepo({ name: 'r', path: tmp } as any);
    const task = await storage.createTask({ title: 'big tsc', repoId: repo.id, status: 'queued' } as any, 'test');
    const run = await storage.createRun({ taskId: task.id, repoId: repo.id, mode: 'worker' } as any);
    // a real PTY (sleep), so livePids sees a real pid; its tree is simulated around that pid
    const s = sessions.spawn({ runId: run.id, cmd: 'sleep', args: ['60'], cwd: tmp, env: { PATH: process.env.PATH ?? '/bin:/usr/bin' } });
    const pid = s.pty.pid;
    setProcMemoryReaders(
      async () => ({
        procs: [
          { pid: process.pid, ppid: 1, mb: 300, comm: 'node' },
          { pid, ppid: process.pid, mb: 200, comm: 'claude' },
          { pid: 999_999, ppid: pid, mb: treeMb - 200, comm: 'tsc' },
        ],
        method: 'footprint',
      }),
      async () => sys(40),
    );
    try {
      treeMb = 500;
      await orch.procMemorySweep();
      const snap = procMemoryState();
      const w = snap.trees.find((t) => t.kind === 'worker')!;
      assert.equal(w.runId, run.id);
      assert.equal(w.taskId, task.id);
      assert.equal(w.label, 'big tsc');
      assert.equal(w.mb, 500);
      assert.equal(w.biggest?.comm, 'tsc');
      assert.ok(snap.trees.some((t) => t.id === 'api' && t.mb === 300), 'the API is its own row');
      assert.equal((await storage.getRun(run.id))!.peakMemMb, 500);

      treeMb = 3000; // above the 2 GB default line
      for (let i = 0; i < MEMORY_HIGH_TRIP_SAMPLES + 3; i++) await orch.procMemorySweep();
      assert.equal(procMemoryState().memoryHigh.high, true);
      assert.equal((await storage.getRun(run.id))!.peakMemMb, 3000);
      const alerts = (await storage.listEvents({ kind: 'anomaly.notified', limit: 50 })).filter((e) => (e.data as { type?: string }).type === 'memory-high');
      assert.equal(alerts.length, 1, 'one alert for the episode');
      assert.equal(alerts[0].taskId, task.id);
      assert.match(String((alerts[0].data as { message?: string }).message), /big tsc 2\.9 GB above 2\.0 GB/);

      // calm, then a new episode → a second alert
      treeMb = 400;
      for (let i = 0; i < 3; i++) await orch.procMemorySweep();
      assert.equal(procMemoryState().memoryHigh.high, false);
      assert.equal((await storage.getRun(run.id))!.peakMemMb, 3000, 'the stored peak never drops');
      treeMb = 3000;
      for (let i = 0; i < MEMORY_HIGH_TRIP_SAMPLES; i++) {
        await new Promise((r) => setTimeout(r, 5)); // a distinct episode start
        await orch.procMemorySweep();
      }
      const again = (await storage.listEvents({ kind: 'anomaly.notified', limit: 50 })).filter((e) => (e.data as { type?: string }).type === 'memory-high');
      assert.equal(again.length, 2);
    } finally {
      sessions.kill(run.id);
    }
  });
});
