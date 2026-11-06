// docs/commands.md § Idle agent servers — the reaper over a temp SQLite DB and
// a REAL CommandRunner whose PTY pool is a fake (no process is spawned): an
// agent-started run is stopped once no running/waiting user needs it for the
// window, a human's never, reuse and an attached terminal keep it alive,
// checks are exempt, and the per-repo cap evicts the longest-idle unused one
// or refuses.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import type { Repo, RepoCommand, Run, Task } from '@tm/shared';
import { registerAgentCommandRoutes } from '../routes/agent-commands.ts';
import type { SessionManager } from '../pty/session-manager.ts';
import { SqliteStorage } from '../storage/sqlite.ts';
import { CapRefusal, IdleServerReaper, idleFrom, taskNeedsServer } from './reaper.ts';
import { CommandRunner } from './runner.ts';

type ExitCb = (e: { runId: string; exitCode: number | null }) => void;

/** The commands pool: processes live until killed; `clients` per run is settable. */
class FakeSessions {
  private exitCb: ExitCb | null = null;
  clients = new Map<string, Set<unknown>>();
  onExit(cb: ExitCb) {
    this.exitCb = cb;
  }
  spawn(o: { runId: string }) {
    this.clients.set(o.runId, new Set());
    return { pty: { pid: 4242 } };
  }
  kill(runId: string) {
    setImmediate(() => this.exitCb?.({ runId, exitCode: null }));
    return true;
  }
  get(runId: string) {
    const clients = this.clients.get(runId);
    return clients ? { clients, buffer: { snapshot: () => Buffer.from('') } } : undefined;
  }
}

const MIN = 60_000;
let tmp = '';
let storage: SqliteStorage;
let sessions: FakeSessions;
let runner: CommandRunner;
let reaper: IdleServerReaper;
let repo: Repo;
let n = 0;

const command = (kind: RepoCommand['kind'] = 'service', over: Partial<RepoCommand> = {}) =>
  storage.createCommand({ repoId: repo.id, name: `dev ${++n}`, command: `sleep ${1000 + n}`, kind, ...over });

const task = (status: Task['status']) => storage.createTask({ title: `t${++n}`, repoId: repo.id, status }, 'test');

async function settle(id: string, to: Task['status'], patch: Parameters<SqliteStorage['transitionTask']>[4] = {}) {
  const t = (await storage.getTask(id))!;
  assert.ok(await storage.transitionTask(id, [t.status], to, 'test', patch));
}

const exited = (runId: string) => runner.waitForExit(runId, 2000);

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-reaper-')));
  storage = new SqliteStorage(path.join(tmp, 'tm.db'));
  await storage.migrate();
  const dir = path.join(tmp, 'repo');
  fs.mkdirSync(dir);
  repo = await storage.createRepo({ name: 'web', path: dir } as never);
});

beforeEach(async () => {
  sessions = new FakeSessions();
  runner = new CommandRunner(storage, sessions as unknown as SessionManager);
  reaper = new IdleServerReaper(storage, runner);
  await storage.setSetting('commands.idleStopMinutes', 30);
  await storage.setSetting('commands.agentServersPerRepo', 2);
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('pure parts', () => {
  test('a task needs its server while running, waiting, or in an open verify round', () => {
    assert.equal(taskNeedsServer(null), false);
    assert.equal(taskNeedsServer({ status: 'running', reviewState: null, checkState: null }), true);
    assert.equal(taskNeedsServer({ status: 'waiting', reviewState: null, checkState: null }), true);
    assert.equal(taskNeedsServer({ status: 'review', reviewState: null, checkState: 'running' }), true);
    assert.equal(taskNeedsServer({ status: 'review', reviewState: 'reviewing', checkState: null }), true);
    assert.equal(taskNeedsServer({ status: 'review', reviewState: 'passed', checkState: 'green' }), false);
    assert.equal(taskNeedsServer({ status: 'done', reviewState: null, checkState: null }), false);
    assert.equal(taskNeedsServer({ status: 'blocked', reviewState: null, checkState: null }), false);
  });

  test('idleness starts at the later of the mark and the last use', () => {
    assert.equal(idleFrom('1970-01-01T00:00:10.000Z', 5_000, 99_000), 10_000);
    assert.equal(idleFrom('1970-01-01T00:00:10.000Z', 20_000, 99_000), 20_000);
    assert.equal(idleFrom(null, 5_000, 99_000), 99_000);
  });
});

describe('idle reaping', () => {
  test('an agent server is stopped after the window once its owner is done, and audited', async () => {
    const owner = await task('running');
    const run = await runner.start(await command(), repo, 'agent:abc', owner.id);
    const t0 = Date.now();
    assert.equal(await reaper.sweep(t0 + 120 * MIN), 0, 'owner running: in use');
    assert.equal(runner.get(run.id)!.idleSince, undefined);

    await settle(owner.id, 'review', { reviewState: 'passed', checkState: 'green' });
    assert.equal(await reaper.sweep(t0 + MIN), 0, 'first idle sweep only marks');
    assert.ok(runner.get(run.id)!.idleSince);
    assert.equal(await reaper.sweep(t0 + 20 * MIN), 0, 'inside the window');
    assert.equal(await reaper.sweep(t0 + 32 * MIN), 1, 'past the window');
    assert.ok(await exited(run.id));
    const done = runner.get(run.id)!;
    assert.equal(done.status, 'killed');
    assert.equal(done.reaped?.reason, 'idle');
    assert.ok(done.reaped!.idleMinutes >= 30);
    const ev = (await storage.listEvents({ kinds: ['command.reaped'] })).find((e) => (e.data as { runId: string }).runId === run.id);
    assert.ok(ev, 'command.reaped row');
    assert.equal(ev.taskId, owner.id);
    assert.equal((ev.data as { reason: string; ownerStatus: string }).reason, 'idle');
    assert.equal((ev.data as { ownerStatus: string }).ownerStatus, 'review');
  });

  test('a human-started run is never touched', async () => {
    const run = await runner.start(await command(), repo, 'human', null);
    const t0 = Date.now();
    await reaper.sweep(t0 + MIN);
    assert.equal(await reaper.sweep(t0 + 10_000 * MIN), 0);
    assert.equal(runner.get(run.id)!.status, 'running');
    assert.equal(runner.get(run.id)!.idleSince, undefined);
    assert.equal(runner.reap(run.id, { at: new Date().toISOString(), reason: 'idle', idleMinutes: 99 }), false);
    runner.stop(run.id);
    await exited(run.id);
  });

  test('reuse by another running task keeps it; the clock restarts from that use', async () => {
    const owner = await task('done');
    const user = await task('running');
    const run = await runner.start(await command(), repo, 'agent:abc', owner.id);
    runner.noteUse(run.id, user.id);
    const t0 = Date.now();
    assert.equal(await reaper.sweep(t0 + 60 * MIN), 0, 'user running');
    await settle(user.id, 'review', { reviewState: 'passed' });
    assert.equal(await reaper.sweep(t0 + 61 * MIN), 0, 'mark');
    assert.equal(await reaper.sweep(t0 + 80 * MIN), 0, '19 min idle');
    // a fresh use (logs read) clears the mark
    runner.noteUse(run.id, user.id);
    assert.equal(runner.get(run.id)!.idleSince, undefined);
    assert.equal(await reaper.sweep(t0 + 85 * MIN), 0, 'mark again');
    assert.equal(await reaper.sweep(t0 + 110 * MIN), 0, '25 min since the new mark');
    assert.equal(await reaper.sweep(t0 + 116 * MIN), 1);
    await exited(run.id);
  });

  test('an attached terminal keeps it alive', async () => {
    const owner = await task('done');
    const run = await runner.start(await command(), repo, 'agent:abc', owner.id);
    sessions.clients.get(run.id)!.add({});
    const t0 = Date.now();
    await reaper.sweep(t0 + MIN);
    assert.equal(await reaper.sweep(t0 + 100 * MIN), 0);
    sessions.clients.get(run.id)!.clear();
    await reaper.sweep(t0 + 101 * MIN);
    assert.equal(await reaper.sweep(t0 + 132 * MIN), 1);
    await exited(run.id);
  });

  test('a check run is exempt, and window 0 turns reaping off', async () => {
    const owner = await task('done');
    const check = await runner.start(await command('task', { isCheck: true }), repo, 'system', owner.id, { taskId: owner.id });
    const server = await runner.start(await command(), repo, 'agent:abc', owner.id);
    await storage.setSetting('commands.idleStopMinutes', 0);
    const t0 = Date.now();
    await reaper.sweep(t0 + MIN);
    assert.equal(await reaper.sweep(t0 + 10_000 * MIN), 0, 'off');
    await storage.setSetting('commands.idleStopMinutes', 30);
    assert.equal(await reaper.sweep(t0 + 10_001 * MIN), 1, 'only the server');
    assert.equal(runner.get(check.id)!.status, 'running');
    assert.equal(runner.get(check.id)!.idleSince, undefined);
    runner.stop(check.id);
    await Promise.all([exited(check.id), exited(server.id)]);
  });
});

describe('per-repo cap', () => {
  test('a third server evicts the longest-idle unused one', async () => {
    const done = await task('done');
    const a = await runner.start(await command(), repo, 'agent:a', done.id);
    await new Promise((r) => setTimeout(r, 5));
    const b = await runner.start(await command(), repo, 'agent:b', done.id);
    const live = await task('running');
    const c = await reaper.admit(repo.id, 'service', async () => runner.start(await command(), repo, 'agent:c', live.id));
    assert.equal(runner.get(a.id)!.status, 'killed', 'oldest evicted');
    assert.equal(runner.get(a.id)!.reaped?.reason, 'cap');
    assert.equal(runner.get(b.id)!.status, 'running');
    assert.equal(runner.get(c.id)!.status, 'running');
    for (const id of [b.id, c.id]) runner.stop(id);
    await Promise.all([exited(b.id), exited(c.id)]);
  });

  test('all in use → refused; task-kind runs and human runs do not count', async () => {
    const live = await task('running');
    const human = await runner.start(await command(), repo, 'human', null);
    const script = await reaper.admit(repo.id, 'task', async () => runner.start(await command('task'), repo, 'agent:s', live.id));
    const a = await reaper.admit(repo.id, 'service', async () => runner.start(await command(), repo, 'agent:a', live.id));
    const b = await reaper.admit(repo.id, 'service', async () => runner.start(await command(), repo, 'agent:b', live.id));
    let started = false;
    await assert.rejects(
      reaper.admit(repo.id, 'service', async () => {
        started = true;
        return runner.start(await command(), repo, 'agent:c', live.id);
      }),
      (e: unknown) => e instanceof CapRefusal && e.live.length === 2,
    );
    assert.equal(started, false);
    // a task-kind run past the cap is not a server
    const script2 = await reaper.admit(repo.id, 'task', async () => runner.start(await command('task'), repo, 'agent:s2', live.id));
    assert.equal(runner.get(script2.id)!.status, 'running');
    await storage.setSetting('commands.agentServersPerRepo', 0);
    const d = await reaper.admit(repo.id, 'service', async () => runner.start(await command(), repo, 'agent:d', live.id));
    assert.equal(runner.get(d.id)!.status, 'running', 'cap 0 = none');
    const ids = [human.id, script.id, script2.id, a.id, b.id, d.id];
    for (const id of ids) runner.stop(id);
    await Promise.all(ids.map(exited));
  });

  test('concurrent admissions are serialized: two starts cannot both pass', async () => {
    const live = await task('running');
    const a = await reaper.admit(repo.id, 'service', async () => runner.start(await command(), repo, 'agent:a', live.id));
    const both = await Promise.allSettled([
      reaper.admit(repo.id, 'service', async () => runner.start(await command(), repo, 'agent:b', live.id)),
      reaper.admit(repo.id, 'service', async () => runner.start(await command(), repo, 'agent:c', live.id)),
    ]);
    assert.deepEqual(
      both.map((r) => r.status),
      ['fulfilled', 'rejected'],
    );
    const b = (both[0] as PromiseFulfilledResult<Awaited<ReturnType<CommandRunner['start']>>>).value;
    for (const id of [a.id, b.id]) runner.stop(id);
    await Promise.all([exited(a.id), exited(b.id)]);
  });
});

describe('agent routes', () => {
  /** The agent API with a stub auth: `x-task` names the caller's task. */
  async function api() {
    const app = Fastify();
    registerAgentCommandRoutes(
      app,
      storage,
      runner,
      async (req) =>
        ({ id: `run-${String(req.headers['x-task'])}`, taskId: String(req.headers['x-task']), repoId: repo.id, status: 'running' }) as Run,
      reaper,
    );
    await app.ready();
    return app;
  }

  test('start-or-reuse records use; restart keeps the users; the cap answers 409', async () => {
    const app = await api();
    const owner = await task('running');
    const other = await task('running');
    const c = await command();
    const first = await app.inject({ method: 'POST', url: `/api/agent/commands/${c.id}/start`, headers: { 'x-task': owner.id }, payload: {} });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().started, true);
    const runId = first.json().run.id as string;
    const reuse = await app.inject({ method: 'POST', url: `/api/agent/commands/${c.id}/start`, headers: { 'x-task': other.id }, payload: {} });
    assert.equal(reuse.json().started, false);
    assert.deepEqual(runner.usersOf(runId).map((u) => u.taskId).sort(), [owner.id, other.id].sort());

    const restart = await app.inject({ method: 'POST', url: `/api/agent/commands/${c.id}/restart`, headers: { 'x-task': owner.id }, payload: {} });
    assert.equal(restart.statusCode, 200);
    const next = restart.json().run.id as string;
    assert.notEqual(next, runId);
    assert.deepEqual(runner.usersOf(next).map((u) => u.taskId).sort(), [owner.id, other.id].sort(), 'users carried over');

    // owner done, `other` still running → in use after the window
    await settle(owner.id, 'done');
    const t0 = Date.now();
    await reaper.sweep(t0 + MIN);
    assert.equal(await reaper.sweep(t0 + 100 * MIN), 0);

    // a second server fills the cap; a third, with both in use, is refused
    const c2 = await command();
    assert.equal((await app.inject({ method: 'POST', url: `/api/agent/commands/${c2.id}/start`, headers: { 'x-task': other.id }, payload: {} })).statusCode, 200);
    const c3 = await command();
    const refused = await app.inject({ method: 'POST', url: `/api/agent/commands/${c3.id}/start`, headers: { 'x-task': other.id }, payload: {} });
    assert.equal(refused.statusCode, 409);
    assert.match(refused.json().error, /agentServersPerRepo/);
    assert.equal(refused.json().runs.length, 2);
    assert.equal(runner.runningFor(c3.id), undefined);

    // `other` lands: the third start now evicts one of the idle two
    await settle(other.id, 'done');
    const third = await app.inject({ method: 'POST', url: `/api/agent/commands/${c3.id}/start`, headers: { 'x-task': other.id }, payload: {} });
    assert.equal(third.statusCode, 200);
    assert.equal(runner.running().filter((r) => r.ownerTaskId).length, 2);
    runner.stopAll();
    await Promise.all(runner.list().map((r) => exited(r.id)));
    await app.close();
  });
});
