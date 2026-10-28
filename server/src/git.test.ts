// Nested worktrees and unpushed trailer commits (docs/parallel.md § Checkout tasks).
// Run: npm test   (node:test through tsx; real git in temp dirs)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Repo } from '@tm/shared';
import { gitStatus, hasUnpushedTaskCommit, verifyPublished } from './git.ts';

const TASK = '27fbfba5-c665-4a45-b376-fc006d7bfba0';
let root: string;
let repo: Repo;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-git-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, work);
  git(work, 'config', 'user.email', 't@t');
  git(work, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  repo = { id: 'r', name: 'r', path: work } as Repo;
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('a worktree nested in the checkout', () => {
  test('is not an uncommitted change of the checkout', async () => {
    git(repo.path, 'worktree', 'add', '-q', '-b', `tm/${TASK.slice(0, 8)}`, path.join(repo.path, '.worktrees', TASK.slice(0, 8)));
    assert.match(git(repo.path, 'status', '--porcelain'), /\.worktrees\//);
    assert.equal((await gitStatus(repo)).dirty, 0);
    assert.equal((await verifyPublished(repo)).ok, true);
  });
});

describe('hasUnpushedTaskCommit', () => {
  test('sees a trailer commit on any local branch until a remote has it', async () => {
    const wt = path.join(repo.path, '.worktrees', TASK.slice(0, 8));
    assert.equal(await hasUnpushedTaskCommit(repo, TASK), false);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
    git(wt, 'add', '.');
    git(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', `work\n\nTask: ${TASK}`);
    assert.equal(await hasUnpushedTaskCommit(repo, TASK), true);
    assert.equal(await hasUnpushedTaskCommit(repo, '00000000-0000-0000-0000-000000000000'), false);
    git(wt, 'push', '-q', 'origin', `tm/${TASK.slice(0, 8)}`);
    assert.equal(await hasUnpushedTaskCommit(repo, TASK), false);
  });
});
