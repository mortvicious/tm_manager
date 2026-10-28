// docs/approvals.md — an agent's request, the human's tap, the server's run.
// Real git against temp bare remotes and a temp SQLite DB.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Approval, Repo, Run } from '@tm/shared';
import { ApprovalService } from './approvals.ts';
import { SqliteStorage } from './storage/sqlite.ts';

let tmp = '';
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();
const commit = (cwd: string, file: string, msg: string) => {
  fs.writeFileSync(path.join(cwd, file), `${msg}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', msg);
  return git(cwd, 'rev-parse', 'HEAD');
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

let storage: SqliteStorage;
let service: ApprovalService;
const published: string[] = [];

/** the service settles in the background after a decision — wait for the final status */
async function settled(id: string): Promise<Approval> {
  const a = await service.wait(id, 10_000);
  assert.ok(a, 'approval row');
  return a;
}

async function runFor(repo: Repo): Promise<Run> {
  const task = await storage.createTask({ title: `asker in ${repo.name}`, repoId: repo.id, status: 'running' }, 'test');
  return storage.createRun({ taskId: task.id, repoId: repo.id, mode: 'worker' });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-approvals-'));
  storage = new SqliteStorage(path.join(tmp, 'tm.db'));
  await storage.migrate();
  service = new ApprovalService({
    storage,
    markPublished: async (id) => {
      published.push(id);
      return { ok: true };
    },
    hostPort: 1,
    supervised: false,
  });
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('push-ref', () => {
  test('a fast-forward is described, waits for the tap, and the server pushes exactly it', async () => {
    const { bare, work } = makeRepo('ff');
    const repo = await storage.createRepo({ name: 'ff', path: work });
    const old = git(work, 'rev-parse', 'HEAD');
    commit(work, 'b.txt', 'second');
    const sha = commit(work, 'c.txt', 'third');
    const run = await runFor(repo);

    const r = await service.request(run, { action: 'push-ref', branch: 'release', sha: 'HEAD', reason: 'ship it' });
    assert.ok(r.ok, !r.ok ? r.error : '');
    assert.equal(r.approval.status, 'pending');
    assert.deepEqual(r.approval.params, { action: 'push-ref', sha, ref: 'refs/heads/release', expectedOld: null, commits: 0 });
    // nothing happened yet
    assert.equal(git(bare, 'branch', '--list', 'release'), '');

    const again = await service.request(run, { action: 'push-ref', branch: 'release', sha: 'HEAD', reason: 'retry' });
    assert.ok(again.ok && again.reused && again.approval.id === r.approval.id, 'the same request is the same row');

    const d = await service.decide(r.approval.id, true, 'human');
    assert.ok(d.ok);
    const done = await settled(r.approval.id);
    assert.equal(done.status, 'done', done.result ?? '');
    assert.equal(git(bare, 'rev-parse', 'refs/heads/release'), sha);

    // and a fast-forward of an existing branch counts what it adds
    const ff = await service.request(run, { action: 'push-ref', branch: 'main', sha, reason: 'land' });
    assert.ok(ff.ok && ff.approval.params.action === 'push-ref');
    assert.equal(ff.approval.params.expectedOld, old);
    assert.equal(ff.approval.params.commits, 2);
    assert.match(ff.approval.summary, /fast-forward main .* \(\+2 commits\)/);
  });

  test('never a force: a non-fast-forward is refused at request time', async () => {
    const { bare, work } = makeRepo('nff');
    const repo = await storage.createRepo({ name: 'nff', path: work });
    const other = path.join(tmp, 'nff-other');
    git(tmp, 'clone', '-q', bare, other);
    commit(other, 'x.txt', 'theirs');
    git(other, 'push', '-q', 'origin', 'main');
    commit(work, 'y.txt', 'ours');
    const r = await service.request(await runFor(repo), { action: 'push-ref', branch: 'main', sha: 'HEAD', reason: 'r' });
    assert.ok(!r.ok);
    assert.equal(r.code, 409);
    assert.match(r.error, /not a fast-forward/);
  });

  test('the remote moved between the request and the tap → not pushed', async () => {
    const { bare, work } = makeRepo('moved');
    const repo = await storage.createRepo({ name: 'moved', path: work });
    commit(work, 'b.txt', 'second');
    const r = await service.request(await runFor(repo), { action: 'push-ref', branch: 'main', sha: 'HEAD', reason: 'r' });
    assert.ok(r.ok);
    const other = path.join(tmp, 'moved-other');
    git(tmp, 'clone', '-q', bare, other);
    const theirs = commit(other, 'x.txt', 'theirs');
    git(other, 'push', '-q', 'origin', 'main');

    await service.decide(r.approval.id, true, 'telegram');
    const out = await settled(r.approval.id);
    assert.equal(out.status, 'failed');
    assert.match(out.result ?? '', /moved since the request/);
    assert.equal(git(bare, 'rev-parse', 'refs/heads/main'), theirs);
  });

  test('a new tag is pushed; a tag already on origin is refused', async () => {
    const { bare, work } = makeRepo('tag');
    const repo = await storage.createRepo({ name: 'tag', path: work });
    git(work, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0');
    const run = await runFor(repo);
    const r = await service.request(run, { action: 'push-ref', tag: 'v1.0.0', reason: 'release' });
    assert.ok(r.ok, !r.ok ? r.error : '');
    await service.decide(r.approval.id, true, 'human');
    assert.equal((await settled(r.approval.id)).status, 'done');
    assert.equal(git(bare, 'rev-parse', 'refs/tags/v1.0.0'), git(work, 'rev-parse', 'refs/tags/v1.0.0'));

    git(work, 'tag', '-f', '-a', 'v1.0.0', '-m', 'moved', 'HEAD');
    const again = await service.request(run, { action: 'push-ref', tag: 'v1.0.0', reason: 'move it' });
    assert.ok(!again.ok);
    assert.match(again.error, /already exists on origin/);
  });

  test('rejected → nothing runs, and a second decision is refused', async () => {
    const { bare, work } = makeRepo('reject');
    const repo = await storage.createRepo({ name: 'reject', path: work });
    commit(work, 'b.txt', 'second');
    const r = await service.request(await runFor(repo), { action: 'push-ref', branch: 'main', sha: 'HEAD', reason: 'r' });
    assert.ok(r.ok);
    const before = git(bare, 'rev-parse', 'refs/heads/main');
    assert.ok((await service.decide(r.approval.id, false, 'human', 'not now')).ok);
    const second = await service.decide(r.approval.id, true, 'telegram');
    assert.ok(!second.ok && second.code === 409);
    assert.equal((await storage.getApproval(r.approval.id))!.status, 'rejected');
    assert.equal(git(bare, 'rev-parse', 'refs/heads/main'), before);
  });
});

describe('sync-branch and auto-approve', () => {
  test('fast-forwards the checked-out base branch; pre-approved by the repo, it needs no tap', async () => {
    const { bare, work } = makeRepo('sync');
    let repo = await storage.createRepo({ name: 'sync', path: work });
    const other = path.join(tmp, 'sync-other');
    git(tmp, 'clone', '-q', bare, other);
    const tip = commit(other, 'x.txt', 'upstream');
    git(other, 'push', '-q', 'origin', 'main');
    const run = await runFor(repo);

    const asked = await service.request(run, { action: 'sync-branch', reason: 'r' });
    assert.ok(asked.ok, !asked.ok ? asked.error : '');
    assert.equal(asked.approval.status, 'pending');
    assert.ok((await service.decide(asked.approval.id, false, 'human')).ok);

    repo = (await storage.updateRepo(repo.id, { autoApprove: ['sync-branch', 'push-ref' as never] }))!;
    assert.deepEqual(repo.autoApprove, ['sync-branch'], 'a push can never be pre-approved');
    const auto = await service.request(run, { action: 'sync-branch', branch: 'main', reason: 'r' });
    assert.ok(auto.ok);
    const out = await settled(auto.approval.id);
    assert.equal(out.status, 'done', out.result ?? '');
    assert.equal(out.decidedBy, 'auto-approve');
    assert.equal(git(work, 'rev-parse', 'HEAD'), tip);
  });

  test('refused when the local branch has commits origin lacks, or the checkout has tracked changes', async () => {
    const { bare, work } = makeRepo('sync2');
    const repo = await storage.createRepo({ name: 'sync2', path: work });
    const other = path.join(tmp, 'sync2-other');
    git(tmp, 'clone', '-q', bare, other);
    commit(other, 'x.txt', 'upstream');
    git(other, 'push', '-q', 'origin', 'main');
    const run = await runFor(repo);

    fs.writeFileSync(path.join(work, 'a.txt'), 'dirty\n');
    const r = await service.request(run, { action: 'sync-branch', reason: 'r' });
    assert.ok(r.ok);
    await service.decide(r.approval.id, true, 'human');
    const out = await settled(r.approval.id);
    assert.equal(out.status, 'failed');
    assert.match(out.result ?? '', /tracked changes/);
    git(work, 'checkout', '--', 'a.txt');

    commit(work, 'mine.txt', 'local only');
    const diverged = await service.request(run, { action: 'sync-branch', reason: 'r' });
    assert.ok(!diverged.ok);
    assert.match(diverged.error, /origin lacks/);
  });
});

describe('mark-published and the rest', () => {
  test('names review/done tasks by prefix and hands each to markPublished with the deciding actor', async () => {
    const repo = await storage.createRepo({ name: 'mp', path: tmp });
    const a = await storage.createTask({ title: 'a', repoId: repo.id, status: 'review' }, 'test');
    const b = await storage.createTask({ title: 'b', repoId: repo.id, status: 'draft' }, 'test');
    const run = await runFor(repo);
    const bad = await service.request(run, { action: 'mark-published', taskIds: [a.id, b.id.slice(0, 8)], reason: 'r' });
    assert.ok(!bad.ok);
    assert.match(bad.error, /only review\/done/);

    const r = await service.request(run, { action: 'mark-published', taskIds: [a.id.slice(0, 8)], reason: 'landed by the release push' });
    assert.ok(r.ok);
    await service.decide(r.approval.id, true, 'telegram');
    const out = await settled(r.approval.id);
    assert.equal(out.status, 'done');
    assert.deepEqual(published, [a.id]);
  });

  test('rebuild-restart is refused without the front door; a reason is required', async () => {
    const repo = await storage.createRepo({ name: 'rr', path: tmp });
    const run = await runFor(repo);
    const r = await service.request(run, { action: 'rebuild-restart', reason: 'new code' });
    assert.ok(!r.ok && r.code === 409);
    const noReason = await service.request(run, { action: 'sync-branch' });
    assert.ok(!noReason.ok && noReason.code === 400);
  });

  test('boot expires a row cut mid-run, never re-runs it', async () => {
    const repo = await storage.createRepo({ name: 'boot', path: tmp });
    const run = await runFor(repo);
    const row = await storage.createApproval({
      taskId: run.taskId,
      runId: run.id,
      repoId: repo.id,
      action: 'rebuild-restart',
      params: { action: 'rebuild-restart', drainMinutes: null },
      summary: 's',
      reason: 'r',
    });
    await storage.decideApproval(row.id, 'approved', 'human');
    await storage.stepApproval(row.id, ['approved'], 'running');
    await service.recoverOnBoot();
    const after = (await storage.getApproval(row.id))!;
    assert.equal(after.status, 'expired');
    assert.ok(after.finishedAt);
  });
});
