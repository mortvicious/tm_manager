// Push health + loud land failures (docs/parallel.md § Push health).
// Run: npm test   (node:test through tsx; real git in temp dirs, a temp SQLite DB)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Repo, RepoPushHealth, Task } from '@tm/shared';
import { integratedIn, PUSH_FAILED_PREFIX, syncPr } from './land.ts';
import { classifyGitFailure, localAhead, probePush, PushHealth, pushHealth, type ProbeResult } from './push-health.ts';
import { SqliteStorage } from './storage/sqlite.ts';
import { defaultBranch } from './worktrees.ts';

// The exact tail the server logged 14 times on 2026-10-26/27.
const NIGHT_OF_10_26 = [
  'git@github.com: Permission denied (publickey).',
  'fatal: Could not read from remote repository.',
  '',
  'Please make sure you have the correct access rights',
  'and the repository exists.',
].join('\n');

describe('classifyGitFailure', () => {
  test('the publickey refusal is auth, also when only its last lines survived', () => {
    assert.equal(classifyGitFailure(NIGHT_OF_10_26), 'auth');
    assert.equal(classifyGitFailure(' Please make sure you have the correct access rights and the repository exists.'), 'auth');
  });
  test('https credential failures are auth', () => {
    assert.equal(classifyGitFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), 'auth');
    assert.equal(classifyGitFailure('remote: Permission to o/r.git denied to bot.\nfatal: unable to access: The requested URL returned error: 403'), 'auth');
    assert.equal(classifyGitFailure('ERROR: The key you are authenticating with has been marked as read only.'), 'auth');
  });
  test('an unreachable host is network, not auth, though git adds "Could not read from remote"', () => {
    assert.equal(
      classifyGitFailure('ssh: Could not resolve hostname github.com: nodename nor servname provided\nfatal: Could not read from remote repository.'),
      'network',
    );
    assert.equal(classifyGitFailure('ssh: connect to host github.com port 22: Operation timed out'), 'network');
  });
  test('branch protection is protected — never retried as a race', () => {
    assert.equal(classifyGitFailure(' ! [remote rejected] HEAD -> main (protected branch hook declined)'), 'protected');
    assert.equal(classifyGitFailure('remote: error: GH006: Protected branch update failed for refs/heads/main.'), 'protected');
  });
  test('someone landing first is a race', () => {
    assert.equal(classifyGitFailure(' ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs'), 'race');
    assert.equal(classifyGitFailure(' ! [rejected] HEAD -> main (non-fast-forward)'), 'race');
  });
  test('anything else is other', () => {
    assert.equal(classifyGitFailure(''), 'other');
    assert.equal(classifyGitFailure('error: src refspec nope does not match any'), 'other');
  });
});

const repoOf = (id: string, delivery: Repo['delivery'] = 'pr'): Repo => ({ id, name: `repo ${id}`, path: '/nowhere', delivery }) as Repo;

describe('PushHealth', () => {
  test('a failing probe holds the repo, notifies once per episode, and recovers', async () => {
    let result: ProbeResult = { ok: false, kind: 'auth', step: 'push', error: 'Permission denied (publickey).' };
    const changes: [RepoPushHealth, RepoPushHealth | undefined][] = [];
    let now = Date.parse('2026-10-27T00:00:00Z');
    const h = new PushHealth(async () => result, (n, p) => void changes.push([n, p]), () => new Date(now));
    const repo = repoOf('r1');

    await h.check(repo);
    assert.deepEqual(h.failingRepoIds(), ['r1']);
    assert.match(h.refusal('r1') ?? '', /push to origin fails for repo r1 \(auth\): Permission denied/);
    assert.equal(changes.length, 1);
    assert.equal(changes[0][1], undefined); // first sight: the caller alerts on prev undefined/ok
    const since = h.get('r1')!.failingSince;

    now += 60_000;
    await h.check(repo); // still failing: no new notification, same episode
    assert.equal(changes.length, 1);
    assert.equal(h.get('r1')!.failingSince, since);

    result = { ok: true, base: 'origin/main', localAhead: 0 };
    await h.check(repo);
    assert.deepEqual(h.failingRepoIds(), []);
    assert.equal(h.refusal('r1'), null);
    assert.equal(changes.length, 2);
    assert.equal(changes[1][1]?.ok, false);
  });

  test('sweep: failing repos every pass, healthy ones on their interval, non-pr repos forgotten', async () => {
    let probes = 0;
    let ok = true;
    let now = 0;
    const h = new PushHealth(async () => (probes++, ok ? { ok: true } : { ok: false, kind: 'auth' }), undefined, () => new Date(now));
    const repo = repoOf('r2');
    await h.sweep([repo, repoOf('d1', 'direct')], 5 * 60_000);
    assert.equal(probes, 1); // the direct repo is never probed
    now += 60_000;
    await h.sweep([repo], 5 * 60_000);
    assert.equal(probes, 1); // healthy, not due
    ok = false;
    await h.sweep([repo], 5 * 60_000, true);
    assert.equal(probes, 2);
    now += 60_000;
    await h.sweep([repo], 5 * 60_000);
    assert.equal(probes, 3); // failing: re-probed every pass
    await h.sweep([{ ...repo, delivery: 'direct' }], 5 * 60_000);
    assert.deepEqual(h.failingRepoIds(), []); // switched to direct: never held again
  });

  test('a real push failure holds the repo only for causes a human must fix', async () => {
    const h = new PushHealth();
    const repo = repoOf('r3');
    assert.equal(await h.report(repo, ' ! [rejected] HEAD -> main (fetch first)', 'land'), 'race');
    assert.deepEqual(h.failingRepoIds(), []);
    assert.equal(await h.report(repo, NIGHT_OF_10_26, 'pr-sync'), 'auth');
    assert.deepEqual(h.failingRepoIds(), ['r3']);
    assert.equal(h.get('r3')!.step, 'pr-sync');
    await h.reportOk(repo);
    assert.deepEqual(h.failingRepoIds(), []);
  });
});

// ---- real git ---------------------------------------------------------------

let tmp = '';
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const commit = (cwd: string, file: string, msg: string) => {
  fs.writeFileSync(path.join(cwd, file), `${msg}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', msg);
};

/** a bare "origin" with one commit on main, and a clone of it */
function makeRepo(name: string): { bare: string; work: string } {
  const bare = path.join(tmp, `${name}.git`);
  const seed = path.join(tmp, `${name}-seed`);
  const work = path.join(tmp, name);
  git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  git(tmp, 'init', '-q', '-b', 'main', seed);
  commit(seed, 'a.txt', 'first');
  git(seed, 'push', '-q', bare, 'main');
  git(tmp, 'clone', '-q', bare, work);
  return { bare, work };
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-push-health-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('probePush (real git)', () => {
  test('ok against a reachable remote, and counts local base commits origin lacks', async () => {
    const { work } = makeRepo('probe-ok');
    const repo = { id: 'p1', name: 'p1', path: work, delivery: 'pr', baseBranch: null } as unknown as Repo;
    let r = await probePush(repo, (x) => defaultBranch(x));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.base, 'origin/main');
    assert.equal(r.localAhead, 0);
    commit(work, 'b.txt', 'local only');
    commit(work, 'c.txt', 'local only 2');
    r = await probePush(repo, (x) => defaultBranch(x));
    assert.equal(r.localAhead, 2);
    assert.equal(await localAhead(work, { branch: 'main', ref: 'origin/main' }), 2);
    // the dry run sent nothing: no probe ref on the remote
    assert.equal(git(work, 'ls-remote', 'origin', 'refs/heads/tm-push-probe'), '');
  });

  test('fails with a classified cause when the remote refuses us', async () => {
    const { work } = makeRepo('probe-bad');
    git(work, 'remote', 'set-url', 'origin', path.join(tmp, 'gone.git'));
    const repo = { id: 'p2', name: 'p2', path: work, delivery: 'pr', baseBranch: null } as unknown as Repo;
    const r = await probePush(repo, (x) => defaultBranch(x));
    assert.equal(r.ok, false);
    assert.equal(r.step, 'ls-remote');
    assert.equal(r.kind, 'auth'); // "…correct access rights and the repository exists."
  });
});

describe('integratedIn (real git)', () => {
  test('a branch merged into another open task branch is integrated there', async () => {
    const { work } = makeRepo('integ');
    git(work, 'checkout', '-q', '-b', 'tm/aaaaaaaa', 'origin/main');
    commit(work, 'x.txt', 'task a');
    git(work, 'checkout', '-q', '-b', 'tm/cccccccc', 'origin/main'); // no commit of its own
    git(work, 'checkout', '-q', '-b', 'tm/bbbbbbbb', 'origin/main');
    commit(work, 'y.txt', 'task b');
    git(work, 'merge', '-q', '--no-edit', 'tm/aaaaaaaa');
    const t = (id: string, status: Task['status'] = 'done') => ({ id, branch: `tm/${id}`, status }) as Task;
    const [a, b, c] = [t('aaaaaaaa'), t('bbbbbbbb', 'running'), t('cccccccc')];
    assert.equal((await integratedIn(work, a, [a, b, c], 'origin/main'))?.id, 'bbbbbbbb');
    assert.equal(await integratedIn(work, b, [a, b, c], 'origin/main'), null);
    assert.equal(await integratedIn(work, c, [a, b, c], 'origin/main'), null); // fork point only
    assert.equal(await integratedIn(work, a, [a, { ...b, status: 'published' }], 'origin/main'), null);
  });
});

// ---- storage + syncPr ---------------------------------------------------------

describe('claims and PR sync (temp SQLite)', () => {
  let storage: SqliteStorage;
  before(async () => {
    storage = new SqliteStorage(path.join(tmp, 'tm.db'));
    await storage.migrate();
  });

  test('a claim skips a repo whose push fails, and takes it once it works', async () => {
    const repo = await storage.createRepo({ name: 'claim', path: path.join(tmp, 'claim') });
    const task = await storage.createTask({ title: 'q', repoId: repo.id, status: 'queued' }, 'test');
    assert.equal(await storage.claimNextQueuedTask('test', [repo.id]), null);
    assert.equal((await storage.claimNextQueuedTask('test', []))?.id, task.id);
  });

  test('syncPr: an auth refusal is on the task and holds the repo; a working push clears both', async () => {
    const { work } = makeRepo('sync');
    git(work, 'checkout', '-q', '-b', 'tm/sync0001');
    commit(work, 's.txt', 'task work');
    const good = git(work, 'remote', 'get-url', 'origin');
    let repo = await storage.createRepo({ name: 'sync', path: work });
    repo = (await storage.updateRepo(repo.id, { delivery: 'pr' }))!;
    let task = await storage.createTask({ title: 'sync me', repoId: repo.id, status: 'review' }, 'test');
    task = (await storage.updateTaskWorktree(task.id, { workdir: work, branch: 'tm/sync0001' }))!;

    git(work, 'remote', 'set-url', 'origin', path.join(tmp, 'gone.git'));
    const failed = await syncPr(storage, repo, task, work, false);
    assert.ok(failed.error?.startsWith(PUSH_FAILED_PREFIX), failed.error ?? 'no error');
    assert.deepEqual(pushHealth.failingRepoIds(), [repo.id]);
    const rows = await storage.listEvents({ kind: 'task.pr', limit: 10 });
    assert.equal(rows.find((e) => e.taskId === task.id)?.data?.kind, 'auth');

    git(work, 'remote', 'set-url', 'origin', good);
    // the PR step needs `gh`; the push before it is what this asserts
    const fixed = await syncPr(storage, repo, failed, work, false);
    assert.equal(fixed.error ?? null, null);
    assert.deepEqual(pushHealth.failingRepoIds(), []);
    assert.equal(git(work, 'ls-remote', 'origin', 'refs/heads/tm/sync0001').length > 0, true);
  });
});
