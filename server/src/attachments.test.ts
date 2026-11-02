// Attached files (docs/design.md § Attached files): what a fresh worker prompt
// lists from the task's artifacts dir. Run: npm test   (node:test through tsx)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { ATTACHED_LIST_MAX, attachedFilesNote, readAttachedFiles } from './attachments.ts';
import { buildWorkerInvocation } from './claude/worker.ts';
import { DEFAULT_SETTINGS, type Task } from '@tm/shared';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-attach-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('readAttachedFiles', () => {
  test('top-level files, oldest first, skipping server files, dotfiles and folders', () => {
    const dir = path.join(tmp, 'a');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    const put = (name: string, body: string, at: number) => {
      fs.writeFileSync(path.join(dir, name), body);
      fs.utimesSync(path.join(dir, name), at, at);
    };
    put('second.png', 'xx', 2000);
    put('first.txt', 'x', 1000);
    put('worktree-setup.log', 'log', 500);
    put('progress.md', 'ledger', 500);
    put('.DS_Store', '', 500);
    fs.writeFileSync(path.join(dir, 'sub', 'nested.txt'), 'n');
    assert.deepEqual(readAttachedFiles(dir), [
      { name: 'first.txt', size: 1 },
      { name: 'second.png', size: 2 },
    ]);
  });

  test('a missing dir is no files', () => {
    assert.deepEqual(readAttachedFiles(path.join(tmp, 'nope')), []);
  });
});

describe('attachedFilesNote', () => {
  test('nothing attached → no block', () => {
    assert.equal(attachedFilesNote([]), null);
  });

  test('names every file with a readable size, capped', () => {
    const note = attachedFilesNote([
      { name: 'shot.png', size: 2 * 1024 * 1024 },
      { name: 'notes.txt', size: 300 },
    ])!;
    assert.match(note, /^## Attached files/);
    assert.match(note, /- shot\.png \(2\.0 MB\)/);
    assert.match(note, /- notes\.txt \(300 B\)/);
    const many = attachedFilesNote(Array.from({ length: ATTACHED_LIST_MAX + 5 }, (_, i) => ({ name: `f${i}`, size: 1 })))!;
    assert.match(many, /… and 5 more/);
    assert.ok(!many.includes(`- f${ATTACHED_LIST_MAX} `));
  });
});

describe('worker prompt', () => {
  const task = {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    title: 'Fix the header',
    description: 'see the screenshot',
  } as Task;
  const base = {
    task,
    settings: DEFAULT_SETTINGS,
    runId: 'r1',
    token: 't',
    callbackUrl: 'http://127.0.0.1:1',
    artifactsDir: tmp,
    landing: 'supervised' as const,
    pushPolicy: 'repo-rules' as const,
    filesNote: '## Attached files\n- shot.png (1 KB)',
  };
  const promptOf = (inv: { args: string[] }) => inv.args[inv.args.length - 1];

  test('a fresh prompt carries the block right under the description', () => {
    const p = promptOf(buildWorkerInvocation(base));
    assert.ok(p.includes('see the screenshot\n\n## Attached files\n- shot.png'));
  });

  test('a resumed session does not get it again', () => {
    const p = promptOf(buildWorkerInvocation({ ...base, resumeSessionId: 's1', followUp: 'go on' }));
    assert.ok(!p.includes('## Attached files'));
  });
});
