// Heavy work slots (docs/memory.md § Heavy work, docs/checks.md § One check at
// a time): the pure slot count / pressure verdict / badge text, the FIFO
// semaphore with its stale and memory rules, and two tasks in DIFFERENT repos
// whose checks run one after another through a real CommandRunner over a fake
// PTY pool (nothing is executed). Run: npm test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import type { Repo, RepoCommand } from '@tm/shared';
import {
  HEAVY_PRESSURE_EMPTY,
  HEAVY_TICKET_STALE_MS,
  HEAVY_UNCLAIMED_MS,
  foldHeavySample,
  heavyMaxParallel,
  heavyWaitLabel,
  judgeHeavyPressure,
} from '@tm/shared';
import { runChecks } from './checks.ts';
import { CommandRunner } from './commands/runner.ts';
import { HeavySlots, initHeavy } from './heavy.ts';
import type { SessionManager } from './pty/session-manager.ts';
import { SqliteStorage } from './storage/sqlite.ts';

const GIB = 1024 ** 3;

describe('heavy (pure)', () => {
  test('slot count: the setting wins, 0 = auto from RAM', () => {
    assert.deepEqual(heavyMaxParallel(0, 8 * GIB), { max: 1, auto: true });
    assert.deepEqual(heavyMaxParallel(0, 16 * GIB), { max: 2, auto: true });
    assert.deepEqual(heavyMaxParallel(0, 64 * GIB), { max: 3, auto: true });
    assert.deepEqual(heavyMaxParallel(2, 8 * GIB), { max: 2, auto: false });
    assert.deepEqual(heavyMaxParallel(99, 8 * GIB), { max: 4, auto: false });
    assert.deepEqual(heavyMaxParallel(undefined, 8 * GIB), { max: 1, auto: true });
  });

  test('pressure verdict: clear machine vs a saturated one', () => {
    const calm = foldHeavySample(HEAVY_PRESSURE_EMPTY, { freePct: 40, swapPct: 10, pressureLevel: 1, load1: 3, fuseTripped: false, others: 0 });
    assert.equal(judgeHeavyPressure(calm, 8).underPressure, false);
    const busy = foldHeavySample(calm, { freePct: 9, swapPct: 80, pressureLevel: 2, load1: 37, fuseTripped: true, others: 1 });
    const p = judgeHeavyPressure(busy, 8);
    assert.equal(p.underPressure, true);
    assert.equal(p.minFreePct, 9);
    assert.equal(p.peakLoad1, 37);
    assert.equal(p.reasons.length, 5);
  });

  test('badge text', () => {
    const w = (kind: 'check' | 'lighthouse', waitingOn: 'slot' | 'memory') => ({
      waiting: [{ id: 'x', kind, taskId: 't1', runId: null, repoId: null, label: '', requestedAt: '', grantedAt: null, waitingOn }],
    });
    assert.equal(heavyWaitLabel(w('check', 'slot'), 't1'), 'waiting for a check slot');
    assert.equal(heavyWaitLabel(w('lighthouse', 'slot'), 't1'), 'waiting for a heavy slot');
    assert.equal(heavyWaitLabel(w('lighthouse', 'memory'), 't1'), 'waiting for a heavy slot (memory pressure)');
    assert.equal(heavyWaitLabel(w('check', 'slot'), 't2'), null);
    assert.equal(heavyWaitLabel(null, 't1'), null);
  });
});

/** Settings + audit rows, in memory. */
function fakeStorage(settings: Record<string, unknown> = {}) {
  const events: Array<{ kind: string; data?: Record<string, unknown> | null }> = [];
  return {
    events,
    settings,
    storage: {
      getSettings: async () => ({ 'heavy.maxParallel': 0, ...settings }) as never,
      appendEvent: async (e: { kind: string; data?: Record<string, unknown> | null }) => {
        events.push(e);
        return e as never;
      },
    },
  };
}

const lease = (over: Partial<Parameters<HeavySlots['acquire']>[0]> = {}) => ({
  kind: 'lighthouse' as const,
  taskId: 't-agent',
  runId: 'run-1',
  repoId: 'r1',
  label: 'lighthouse /home',
  actor: 'agent:run-1',
  gateOnMemory: true,
  polled: true,
  ...over,
});

describe('HeavySlots', () => {
  test('one slot: FIFO, the second waits, release hands it on', async () => {
    const { storage } = fakeStorage();
    const slots = new HeavySlots({ storage, memoryHold: () => null, totalMem: () => 8 * GIB, timers: false });
    const a = slots.acquire(lease());
    const b = slots.acquire(lease({ runId: 'run-2', taskId: 't-b' }));
    assert.equal(await slots.wait(a.id, 0), true);
    assert.equal(await slots.wait(b.id, 10), false);
    assert.equal(slots.status().waiting[0].id, b.id);
    assert.equal(slots.position(b.id), 1);
    const pending = slots.wait(b.id, 5000);
    const rel = slots.release(a.id);
    assert.equal(rel?.end, 'released');
    assert.ok(rel?.pressure, 'a granted lease reports pressure');
    assert.equal(await pending, true);
    slots.stopAll();
  });

  test('memory fuse holds a lease but not a check behind it', async () => {
    const { storage } = fakeStorage();
    let hold: string | null = 'memory pressure: 5% free';
    const slots = new HeavySlots({ storage, memoryHold: () => hold, totalMem: () => 8 * GIB, timers: false });
    const l = slots.acquire(lease());
    const c = slots.acquire(lease({ kind: 'check', gateOnMemory: false, polled: false, runId: null, taskId: 't-c' }));
    assert.equal(slots.get(l.id)?.waitingOn, 'memory');
    assert.equal(await slots.wait(c.id, 0), true, 'the check steps past the held lease');
    slots.release(c.id);
    assert.equal(slots.get(l.id)?.grantedAt, null, 'still held by the fuse');
    hold = null;
    await slots.tick();
    assert.ok(slots.get(l.id)?.grantedAt, 'granted once the fuse clears');
    slots.stopAll();
  });

  test('turn end releases the run’s tickets; stale and unclaimed tickets go', async () => {
    const { storage, events } = fakeStorage();
    const slots = new HeavySlots({ storage, memoryHold: () => null, totalMem: () => 8 * GIB, timers: false });
    const a = slots.acquire(lease());
    const b = slots.acquire(lease({ runId: 'run-2' }));
    assert.deepEqual(slots.releaseForRun('run-1', 'turn-ended').map((r) => r.end), ['turn-ended']);
    assert.ok(slots.get(b.id)?.grantedAt, 'run-2 now holds it');
    assert.equal(slots.get(a.id), null);
    // b was granted but never picked up by a poll → unclaimed
    await slots.tick(Date.now() + HEAVY_UNCLAIMED_MS + 1000);
    assert.equal(slots.get(b.id), null);
    // a waiting ticket nobody polls → abandoned
    const c = slots.acquire(lease({ runId: 'run-3' }));
    const d = slots.acquire(lease({ runId: 'run-4' }));
    await slots.wait(c.id, 0, true);
    await slots.tick(Date.now() + HEAVY_TICKET_STALE_MS + 1000);
    assert.equal(slots.get(d.id), null, 'stale waiter dropped');
    assert.ok(slots.get(c.id), 'a delivered lease is kept');
    const actions = events.filter((e) => e.kind === 'heavy.lease').map((e) => e.data?.action);
    for (const want of ['granted', 'turn-ended', 'unclaimed', 'abandoned']) assert.ok(actions.includes(want), want);
    slots.stopAll();
  });

  test('the setting raises the slot count', async () => {
    const { storage, settings } = fakeStorage();
    const slots = new HeavySlots({ storage, memoryHold: () => null, totalMem: () => 8 * GIB, timers: false });
    slots.acquire(lease());
    const b = slots.acquire(lease({ runId: 'run-2' }));
    assert.equal(slots.get(b.id)?.grantedAt, null);
    settings['heavy.maxParallel'] = 2;
    await slots.tick();
    assert.ok(slots.get(b.id)?.grantedAt);
    assert.equal(slots.status().max, 2);
    slots.stopAll();
  });
});

// ---- two repos' checks through a real CommandRunner ----------------------

type ExitCb = (e: { runId: string; exitCode: number | null }) => void;

/** The commands pool: a spawn stays "running" until the test ends it. */
class ManualSessions {
  spawned: Array<{ runId: string; cwd: string }> = [];
  private exitCb: ExitCb | null = null;
  onExit(cb: ExitCb) {
    this.exitCb = cb;
  }
  spawn(o: { runId: string; cwd: string }) {
    this.spawned.push(o);
    return { pty: { pid: 4242 } };
  }
  finish(runId: string, code = 0) {
    this.exitCb?.({ runId, exitCode: code });
  }
  kill(runId: string) {
    setImmediate(() => this.exitCb?.({ runId, exitCode: null }));
    return true;
  }
  get() {
    return { buffer: { snapshot: () => Buffer.from('ok\n') } };
  }
}

describe('checks of two repos run one after another', () => {
  let tmp = '';
  let storage: SqliteStorage;
  let slots: HeavySlots;

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-heavy-')));
    storage = new SqliteStorage(path.join(tmp, 'tm.db'));
    await storage.migrate();
  });
  afterEach(() => {
    slots?.stopAll();
    initHeavy(null);
  });
  after(() => {
    storage.close?.();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const until = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  test('task B waits for a check slot while task A’s check runs', async () => {
    slots = new HeavySlots({ storage, memoryHold: () => null, totalMem: () => 8 * GIB, timers: false });
    initHeavy(slots);
    const sessions = new ManualSessions();
    const runner = new CommandRunner(storage, sessions as unknown as SessionManager);
    const mk = async (name: string): Promise<{ repo: Repo; check: RepoCommand }> => {
      const dir = path.join(tmp, name);
      fs.mkdirSync(dir);
      const repo = await storage.createRepo({ name, path: dir } as never);
      const check = await storage.createCommand({ repoId: repo.id, name: 'typecheck', command: 'node --version', kind: 'task', isCheck: true } as never);
      return { repo, check };
    };
    const a = await mk('repo-a');
    const b = await mk('repo-b');

    const runA = runChecks(runner, a.repo, [a.check], 'task-a', () => false);
    await until(() => sessions.spawned.length === 1);
    const runB = runChecks(runner, b.repo, [b.check], 'task-b', () => false);
    await until(() => slots.status().waiting.length === 1);
    assert.equal(heavyWaitLabel(slots.status(), 'task-b'), 'waiting for a check slot', 'the waiting state is visible');
    assert.equal(heavyWaitLabel(slots.status(), 'task-a'), null);
    assert.equal(slots.status().held[0].taskId, 'task-a');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sessions.spawned.length, 1, 'repo B’s check has not started');

    sessions.finish(sessions.spawned[0].runId, 0);
    const resA = await runA;
    assert.equal(resA?.[0].outcome, 'green');
    await until(() => sessions.spawned.length === 2);
    assert.equal(sessions.spawned[1].cwd, b.repo.path);
    assert.equal(slots.status().held[0].taskId, 'task-b');
    sessions.finish(sessions.spawned[1].runId, 0);
    const resB = await runB;
    assert.equal(resB?.[0].outcome, 'green');
    assert.equal(slots.status().held.length, 0);
    assert.equal(slots.status().waiting.length, 0);
    const rows = await storage.listEvents({ kind: 'heavy.lease' });
    assert.ok(rows.some((e) => e.taskId === 'task-b' && (e.data as { kind?: string })?.kind === 'check'), 'the wait is audited');
  });

  test('an aborted wait never spawns', async () => {
    slots = new HeavySlots({ storage, memoryHold: () => null, totalMem: () => 8 * GIB, timers: false });
    initHeavy(slots);
    const sessions = new ManualSessions();
    const runner = new CommandRunner(storage, sessions as unknown as SessionManager);
    const blocker = slots.acquire(lease());
    const cmds = await storage.listCommands?.((await storage.listRepos())[0].id);
    const repo = (await storage.listRepos())[0];
    const check = (cmds ?? []).find((c: RepoCommand) => c.isCheck)!;
    let stop = false;
    const res = runChecks(runner, repo, [check], 'task-x', () => stop);
    await until(() => slots.status().waiting.length === 1);
    stop = true;
    assert.equal(await res, null);
    assert.equal(sessions.spawned.length, 0);
    assert.equal(slots.status().waiting.length, 0, 'the ticket is gone');
    slots.release(blocker.id);
  });
});

describe('agent lease routes', () => {
  test('acquire → waiting → granted after the holder releases; pressure in the release', async () => {
    const Fastify = (await import('fastify')).default;
    const { registerAgentHeavyRoutes } = await import('./routes/agent-heavy.ts');
    const { storage } = fakeStorage();
    const slots = new HeavySlots({ storage, memoryHold: () => null, totalMem: () => 8 * GIB, timers: false, loadavg: () => 30, cpus: () => 8 });
    initHeavy(slots);
    const runs: Record<string, { id: string; taskId: string | null; repoId: string; mode: string }> = {
      ta: { id: 'run-a', taskId: 'task-a', repoId: 'r1', mode: 'worker' },
      tb: { id: 'run-b', taskId: 'task-b', repoId: 'r2', mode: 'worker' },
      tx: { id: 'run-x', taskId: null, repoId: 'r1', mode: 'aux' },
    };
    const app = Fastify();
    registerAgentHeavyRoutes(app, async (req) => (runs[String(req.headers['x-tm-token'])] as never) ?? null);
    const call = async (token: string, method: 'GET' | 'POST', url: string, payload?: unknown) => {
      const res = await app.inject({ method, url, headers: { 'x-tm-token': token }, ...(payload ? { payload } : {}) });
      return { code: res.statusCode, body: res.json() as Record<string, unknown> };
    };
    try {
      const a = await call('ta', 'POST', '/api/agent/heavy/acquire', { kind: 'lighthouse', why: 'audit /', waitMs: 0 });
      assert.equal(a.body.status, 'granted');
      const again = await call('ta', 'POST', '/api/agent/heavy/acquire', { kind: 'build', why: 'again', waitMs: 0 });
      assert.equal(again.body.leaseId, a.body.leaseId, 'one lease per run');
      const b = await call('tb', 'POST', '/api/agent/heavy/acquire', { kind: 'playwright', why: 'e2e', waitMs: 0 });
      assert.equal(b.body.status, 'waiting');
      assert.equal(b.body.position, 1);
      assert.equal(heavyWaitLabel(slots.status(), 'task-b'), 'waiting for a heavy slot');
      assert.equal((await call('tx', 'POST', '/api/agent/heavy/acquire', { kind: 'other', why: 'x', waitMs: 0 })).code, 409, 'aux runs get none');
      assert.equal((await call('tb', 'POST', `/api/agent/heavy/${a.body.leaseId}/release`)).code, 404, 'not yours');
      const poll = call('tb', 'GET', `/api/agent/heavy/${b.body.leaseId}?waitMs=5000`);
      await slots.sampleNow();
      const rel = await call('ta', 'POST', `/api/agent/heavy/${a.body.leaseId}/release`);
      assert.equal(rel.body.status, 'released');
      const pressure = rel.body.pressure as { underPressure: boolean; reasons: string[] };
      assert.equal(pressure.underPressure, true, 'load 30 on 8 cores is a saturated machine');
      assert.match(String(rel.body.advice), /re-measure/);
      const granted = await poll;
      assert.equal(granted.body.status, 'granted');
      // the turn ends: released without a call
      slots.releaseForRun('run-b', 'turn-ended');
      assert.equal((await call('tb', 'GET', `/api/agent/heavy/${b.body.leaseId}`)).code, 404);
    } finally {
      await app.close();
      slots.stopAll();
      initHeavy(null);
    }
  });
});
