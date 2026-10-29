// The task panel's diff read (docs/task-diff.md): `taskChangeRead` over a real
// git repo in a temp dir, and the pure `splitDiffFiles` / `capDiffFiles`.
// Run: npm test   (node:test through tsx)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { capDiffFiles, splitDiffFiles, UNTRACKED_DIFF_CAP, type Repo } from '@tm/shared';
import { taskChangeRead, type ChangeScope } from './claude/review.ts';

const TASK = 'dc162b07-0000-4000-8000-000000000001';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-task-diff-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();

function makeRepo(name: string): { repo: Repo; base: string } {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'alpha\nbeta\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  return { repo: { id: name, name, path: dir } as Repo, base: git(dir, 'rev-parse', 'HEAD') };
}

const scopeOf = (base: string, extra: Partial<ChangeScope> = {}): ChangeScope => ({
  taskId: TASK,
  baseSha: base,
  until: new Date(Date.now() + 60_000).toISOString(),
  soleWorker: false,
  includeUncommitted: true,
  ...extra,
});

describe('taskChangeRead', () => {
  test('trailer commit + tracked edit + untracked files → each listed, index untouched, exclusions honoured', async () => {
    const { repo, base } = makeRepo('main-case');
    const dir = repo.path;
    // the task's commit: a.txt two → TWO, plus a line
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n');
    git(dir, 'commit', '-q', '-am', 'task work', '--trailer', `Task: ${TASK}`);
    // someone else's commit, no trailer: must not be listed
    fs.writeFileSync(path.join(dir, 'other.txt'), 'not ours\n');
    git(dir, 'add', 'other.txt');
    git(dir, 'commit', '-q', '-m', 'other task');
    // uncommitted tracked edit and an untracked new file
    fs.writeFileSync(path.join(dir, 'b.txt'), 'alpha\nbeta\ngamma\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'x\ny\n');
    fs.writeFileSync(path.join(dir, 'empty.txt'), '');
    // an agent worktree in the checkout: excluded everywhere
    fs.mkdirSync(path.join(dir, '.claude/worktrees/w1'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude/worktrees/w1/junk.txt'), 'junk\n');
    fs.mkdirSync(path.join(dir, '.worktrees/w2'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.worktrees/w2/junk.txt'), 'junk\n');
    // make the index stat-dirty so a refreshing read WOULD rewrite it
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(dir, 'a.txt'), later, later);

    const indexPath = path.join(dir, '.git/index');
    const before = { bytes: fs.readFileSync(indexPath), mtime: fs.statSync(indexPath).mtimeMs };
    const read = await taskChangeRead(repo, scopeOf(base));
    const after = { bytes: fs.readFileSync(indexPath), mtime: fs.statSync(indexPath).mtimeMs };
    assert.ok(before.bytes.equals(after.bytes), '.git/index bytes changed');
    assert.equal(after.mtime, before.mtime, '.git/index mtime changed');

    assert.equal(read.attribution, 'trailer');
    assert.deepEqual(read.commits.map((c) => c.subject), ['task work']);
    const byPath = Object.fromEntries(read.files.map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(byPath).sort(), ['a.txt', 'b.txt', 'empty.txt', 'new.txt']);
    assert.equal(byPath['empty.txt'].status, 'added');
    assert.equal(byPath['a.txt'].status, 'modified');
    assert.equal(byPath['a.txt'].insertions, 2);
    assert.equal(byPath['a.txt'].deletions, 1);
    assert.deepEqual(byPath['a.txt'].sections.map((s) => s.source), ['committed']);
    assert.equal(byPath['b.txt'].status, 'modified');
    assert.equal(byPath['b.txt'].insertions, 1);
    assert.equal(byPath['b.txt'].deletions, 0);
    assert.deepEqual(byPath['b.txt'].sections.map((s) => s.source), ['uncommitted']);
    assert.equal(byPath['new.txt'].status, 'added');
    assert.equal(byPath['new.txt'].insertions, 2);
    assert.match(byPath['new.txt'].sections[0].patch, /^diff --git a\/new\.txt b\/new\.txt\n/);
    assert.ok(!read.files.some((f) => f.path.includes('worktrees')), 'an excluded worktree path was listed');
    assert.deepEqual(read.stat, { files: 4, insertions: 5, deletions: 1 });
    assert.equal(read.truncated, false);
    assert.equal(read.untrackedCapped, false);
    // the tree is not left with intent-to-add entries
    assert.match(git(dir, 'status', '--porcelain'), /\?\? new\.txt/);
  });

  test('includeUncommitted false reads only the commits', async () => {
    const { repo, base } = makeRepo('no-uncommitted');
    fs.writeFileSync(path.join(repo.path, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(repo.path, 'new.txt'), 'x\n');
    const read = await taskChangeRead(repo, scopeOf(base, { includeUncommitted: false }));
    assert.equal(read.attribution, 'none');
    assert.deepEqual(read.files, []);
  });

  test('more untracked files than the cap: all listed, the rest without a patch, flagged', async () => {
    const { repo, base } = makeRepo('many-untracked');
    fs.mkdirSync(path.join(repo.path, 'gen'));
    const n = UNTRACKED_DIFF_CAP + 5;
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(repo.path, 'gen', `f${String(i).padStart(3, '0')}.txt`), `${i}\n`);
    const read = await taskChangeRead(repo, scopeOf(base));
    assert.equal(read.files.length, n);
    assert.equal(read.untrackedCapped, true);
    assert.equal(read.truncated, true);
    // at most the cap carry a patch (fewer when the time budget ran out first)
    const withPatch = read.files.filter((f) => f.sections.some((s) => s.patch)).length;
    assert.ok(withPatch > 0 && withPatch <= UNTRACKED_DIFF_CAP, `${withPatch} untracked patches`);
    for (const f of read.files.filter((f) => !f.sections.some((s) => s.patch))) assert.equal(f.sections[0]?.truncated, true);
  });
});

describe('splitDiffFiles', () => {
  test('rename, binary, new, deleted', () => {
    const text = [
      'diff --git a/old name.txt b/new name.txt',
      'similarity index 90%',
      'rename from old name.txt',
      'rename to new name.txt',
      'index 1111111..2222222 100644',
      '--- a/old name.txt',
      '+++ b/new name.txt',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '+new',
      'diff --git a/img.png b/img.png',
      'new file mode 100644',
      'index 0000000..3333333',
      'Binary files /dev/null and b/img.png differ',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      'index 4444444..0000000',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '--- committed (1 commit) ---', // a removed line that LOOKS like a marker
      '-x',
      '',
    ].join('\n');
    const files = splitDiffFiles(text);
    assert.equal(files.length, 3);
    const [ren, bin, del] = files;
    assert.equal(ren.path, 'new name.txt');
    assert.equal(ren.oldPath, 'old name.txt');
    assert.equal(ren.status, 'renamed');
    assert.equal(ren.insertions, 1);
    assert.equal(ren.deletions, 1);
    assert.equal(bin.path, 'img.png');
    assert.equal(bin.status, 'added');
    assert.equal(bin.binary, true);
    assert.equal(bin.insertions + bin.deletions, 0);
    assert.equal(del.path, 'gone.txt');
    assert.equal(del.status, 'deleted');
    assert.equal(del.deletions, 2, 'the marker-looking removed line is a deletion, not a marker');
    assert.equal(del.sections[0].source, 'uncommitted');
  });

  test('multi-commit input: one entry per file, one section per commit and the tree', () => {
    const patch = (file: string, minus: string, plus: string) =>
      [`diff --git a/${file} b/${file}`, 'index 1..2 100644', `--- a/${file}`, `+++ b/${file}`, '@@ -1 +1 @@', `-${minus}`, `+${plus}`].join('\n');
    const text = [
      '--- committed (2 commits) ---',
      '### commit aaaaaaaaaaaa',
      patch('x.ts', 'a', 'b'),
      '',
      '### commit bbbbbbbbbbbb',
      patch('x.ts', 'b', 'c'),
      patch('y.ts', '1', '2'),
      '',
      '--- uncommitted (git diff HEAD) ---',
      patch('x.ts', 'c', 'd'),
      '',
    ].join('\n');
    const files = splitDiffFiles(text);
    assert.deepEqual(files.map((f) => f.path), ['x.ts', 'y.ts']);
    assert.deepEqual(files[0].sections.map((s) => s.source), ['commit:aaaaaaaaaaaa', 'commit:bbbbbbbbbbbb', 'uncommitted']);
    assert.equal(files[0].insertions, 3);
    assert.equal(files[0].deletions, 3);
    assert.deepEqual(files[1].sections.map((s) => s.source), ['commit:bbbbbbbbbbbb']);
    for (const s of files[0].sections) assert.match(s.patch, /^diff --git a\/x\.ts b\/x\.ts\n[\s\S]*\n$/);
    assert.ok(!files[0].sections[0].patch.includes('### commit'), 'a marker leaked into a patch');
  });

  test('capDiffFiles cuts patches per file and in total, keeps every file', () => {
    const body = (file: string, n: number) =>
      [`diff --git a/${file} b/${file}`, `@@ -0,0 +1,${n} @@`, ...Array.from({ length: n }, (_, i) => `+line ${i}`)].join('\n');
    const files = splitDiffFiles([body('a', 100), body('b', 100), body('c', 100), ''].join('\n'));
    const perFile = capDiffFiles(files, { perFile: 200, total: 10_000 });
    assert.equal(perFile.truncated, true);
    assert.equal(perFile.files.length, 3);
    for (const f of perFile.files) {
      assert.ok(f.sections[0].patch.length <= 200 && f.sections[0].patch.endsWith('\n'));
      assert.equal(f.sections[0].truncated, true);
      assert.equal(f.insertions, 100, 'counts are the full file, not the cut');
    }
    const total = capDiffFiles(files, { perFile: 10_000, total: 1_500 });
    assert.equal(total.truncated, true);
    assert.equal(total.files[0].sections[0].truncated, false);
    assert.equal(total.files[2].sections[0].patch, '');
    assert.equal(total.files[2].sections[0].truncated, true);
    assert.equal(capDiffFiles(files).truncated, false);
  });
});
