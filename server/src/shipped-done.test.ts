// Done work that shipped (docs/publish.md § Done work that shipped): a `done`
// task whose trailer commits reached a remote is promoted to `published`.
// Run: npm test   (node:test through tsx; real git in temp dirs, a temp SQLite DB)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Repo } from '@tm/shared';
import { remoteStateKey } from './git.ts';
import { gatherTasks } from './reports/service.ts';
import { isCompletionTransition } from './routes/stats.ts';
import { Orchestrator } from './orchestrator.ts';
import { SessionManager } from './pty/session-manager.ts';
import { SqliteStorage } from './storage/sqlite.ts';

let tmp = '';
let storage: SqliteStorage;
let orch: Orchestrator;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();
const commit = (cwd: string, file: string, msg: string) => {
  fs.writeFileSync(path.join(cwd, file), `${msg}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', msg);
};

function makeRepo(name: string): string {
  const bare = path.join(tmp, `${name}.git`);
  const work = path.join(tmp, name);
  git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  git(tmp, 'clone', '-q', bare, work);
  commit(work, 'a.txt', 'first');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  return work;
}

async function doneTask(repo: Repo, title: string) {
  const t = await storage.createTask({ title, repoId: repo.id, status: 'done' }, 'test');
  assert.equal(t.status, 'done');
  return t;
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-shipped-done-'));
  storage = new SqliteStorage(path.join(tmp, 'tm.db'));
  await storage.migrate();
  orch = new Orchestrator(storage, new SessionManager(() => 1024), 'http://127.0.0.1:1');
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('remoteStateKey', () => {
  test('moves on a push, null outside a checkout', async () => {
    const work = makeRepo('key');
    const k1 = await remoteStateKey(work);
    assert.ok(k1);
    assert.equal(await remoteStateKey(work), k1);
    commit(work, 'b.txt', 'b');
    const k2 = await remoteStateKey(work);
    assert.notEqual(k2, k1); // HEAD moved
    git(work, 'push', '-q');
    assert.notEqual(await remoteStateKey(work), k2); // origin/main moved
    assert.equal(await remoteStateKey(tmp), null);
  });
});

describe('promoteShippedDone', () => {
  test('a done task whose trailer commits are pushed becomes published; unpushed or untrailered ones stay done', async () => {
    const work = makeRepo('promote');
    const repo = await storage.createRepo({ name: 'promote', path: work });
    const carried = await doneTask(repo, 'carried along');
    const local = await doneTask(repo, 'still local');
    const bare = await doneTask(repo, 'no trailer');

    commit(work, 'c.txt', `carried\n\nTask: ${carried.id}`);
    git(work, 'push', '-q'); // e.g. a later task's publish pushed the pile
    commit(work, 'd.txt', `local\n\nTask: ${local.id}`);

    assert.equal(await orch.promoteShippedDone(), 1);
    const c = (await storage.getTask(carried.id))!;
    assert.equal(c.status, 'published');
    assert.equal(c.shippedSha, git(work, 'rev-parse', 'HEAD~1'));
    assert.equal((await storage.getTask(local.id))!.status, 'done');
    assert.equal((await storage.getTask(bare.id))!.status, 'done');

    const events = await storage.listEvents({ taskId: carried.id });
    const tr = events.find((e) => e.kind === 'task.transition' && (e.data as { to?: string }).to === 'published');
    assert.ok(tr, 'transition audited');
    assert.equal(tr.actor, 'orchestrator');
    const pub = events.find((e) => e.kind === 'task.publish');
    assert.equal((pub?.data as { delivery?: string }).delivery, 'observed');

    // nothing moved: the unshipped verdict is cached, no promotion
    assert.equal(await orch.promoteShippedDone(), 0);
    // the push lands it on the next pass
    git(work, 'push', '-q');
    assert.equal(await orch.promoteShippedDone(), 1);
    assert.equal((await storage.getTask(local.id))!.status, 'published');
    assert.equal((await storage.getTask(bare.id))!.status, 'done');
  });

  test('a done task that owns a dirty tree is not promoted', async () => {
    const work = makeRepo('dirty');
    const repo = await storage.createRepo({ name: 'dirty', path: work });
    const t = await doneTask(repo, 'dirty owner');
    const run = await storage.createRun({ taskId: t.id, repoId: repo.id, mode: 'worker' });
    assert.ok(run);
    commit(work, 'e.txt', `e\n\nTask: ${t.id}`);
    git(work, 'push', '-q');
    fs.writeFileSync(path.join(work, 'left.txt'), 'left over\n');
    assert.equal(await orch.promoteShippedDone(), 0);
    assert.equal((await storage.getTask(t.id))!.status, 'done');
    // cleaning the tree moves no ref, but it is part of the key: the next pass re-reads
    fs.rmSync(path.join(work, 'left.txt'));
    assert.equal(await orch.promoteShippedDone(), 1);
    assert.equal((await storage.getTask(t.id))!.status, 'published');
  });
});

describe('client reports date a promotion by its first landing (gatherTasks)', () => {
  test('done before the window, promoted to published inside it: not in the report', async () => {
    const work = makeRepo('report');
    const repo = await storage.createRepo({ name: 'report', path: work });
    const old = await doneTask(repo, 'finished last week');
    const fresh = await doneTask(repo, 'finished in the window');
    await storage.appendEvent({ kind: 'task.transition', actor: 'human', taskId: old.id, repoId: repo.id, data: { from: 'review', to: 'done' } });
    await new Promise((r) => setTimeout(r, 15));
    const since = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 15));
    // the promotion, inside the window
    await storage.transitionTask(old.id, ['done'], 'published', 'orchestrator', {}, { observed: true });
    await storage.appendEvent({ kind: 'task.transition', actor: 'human', taskId: fresh.id, repoId: repo.id, data: { from: 'review', to: 'done' } });
    const until = new Date(Date.now() + 60_000).toISOString();
    const { items } = await gatherTasks(storage, [repo.id], since, until);
    assert.deepEqual(items.map((i) => i.task.id), [fresh.id]);
  });
});

describe('the Dashboard counts a promotion once (isCompletionTransition)', () => {
  test('done → published is not a second completion; review → published is one', () => {
    assert.equal(isCompletionTransition({ from: 'review', to: 'done' }), true);
    assert.equal(isCompletionTransition({ from: 'review', to: 'published' }), true);
    assert.equal(isCompletionTransition({ from: 'running', to: 'published' }), true);
    assert.equal(isCompletionTransition({ from: 'done', to: 'published' }), false);
    assert.equal(isCompletionTransition({ from: 'review', to: 'failed' }), false);
    assert.equal(isCompletionTransition(null), false);
  });
});
