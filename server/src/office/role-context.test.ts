// Role-tagged work (docs/office.md § Role-tagged work): the role block a fresh
// worker prompt of an office-filed task leads with. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { DEFAULT_SETTINGS, type Task } from '@tm/shared';
import { buildWorkerInvocation, PUBLISH_INSTRUCTION } from '../claude/worker.ts';
import { untrustedPath } from './isolation.ts';
import { ROLE_NOTES_WITHHELD, roleContextBlock } from './role-context.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-role-ctx-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const office = { folderPath: path.join(tmp, 'office') };
fs.mkdirSync(path.join(office.folderPath, 'roles'), { recursive: true });
fs.writeFileSync(path.join(office.folderPath, 'roles/qa.md'), 'trusted notes: flaky login test');
const twin = untrustedPath(office, 'roles/qa.md');
fs.mkdirSync(path.dirname(twin), { recursive: true });
fs.writeFileSync(twin, 'tainted notes: from a web page');

const role = { key: 'qa', name: 'Mira', title: 'QA lead', prompt: 'Hunt regressions.', notesTaintedAt: null as string | null };
const clean = { taintedAt: null } as Pick<Task, 'taintedAt'>;
const tainted = { taintedAt: '2026-11-05T00:00:00.000Z' } as Pick<Task, 'taintedAt'>;

describe('roleContextBlock', () => {
  test('untainted notes: name, title, brief and the notes', () => {
    const b = roleContextBlock(office, role, clean);
    assert.ok(b.startsWith('## Office role: Mira — QA lead'));
    assert.ok(b.includes('Hunt regressions.'));
    assert.ok(b.includes('### Role notes (roles/qa.md)\ntrusted notes: flaky login test'));
  });

  test('tainted notes are withheld from an untainted task', () => {
    const b = roleContextBlock(office, { ...role, notesTaintedAt: '2026-11-04T00:00:00.000Z' }, clean);
    assert.ok(b.includes(ROLE_NOTES_WITHHELD));
    assert.ok(!b.includes('tainted notes'));
    assert.ok(!b.includes('trusted notes'));
  });

  test('a tainted task reads tainted notes (the untrusted twin)', () => {
    const b = roleContextBlock(office, { ...role, notesTaintedAt: '2026-11-04T00:00:00.000Z' }, tainted);
    assert.ok(b.includes('tainted notes: from a web page'));
    assert.ok(!b.includes(ROLE_NOTES_WITHHELD));
  });

  test('a missing notes file reads as empty', () => {
    const b = roleContextBlock(office, { ...role, key: 'nobody' }, clean);
    assert.ok(b.includes('### Role notes (roles/nobody.md)\n(empty)'));
  });
});

describe('worker prompt with a role block', () => {
  const task = { id: 'bbbbbbbb-0000-4000-8000-000000000002', title: 'Fix login', description: 'it flakes' } as Task;
  const officeNote = roleContextBlock(office, role, clean);
  const base = {
    task,
    settings: DEFAULT_SETTINGS,
    runId: 'r1',
    token: 't',
    callbackUrl: 'http://127.0.0.1:1',
    artifactsDir: tmp,
    landing: 'supervised' as const,
    pushPolicy: 'repo-rules' as const,
    officeNote,
  };
  const promptOf = (inv: { args: string[] }) => inv.args[inv.args.length - 1];

  test('a fresh prompt starts with the role block, above the shared block', () => {
    const p = promptOf(buildWorkerInvocation({ ...base, shared: { dir: tmp, note: '## Shared space' } }));
    assert.ok(p.startsWith(officeNote));
    assert.ok(p.indexOf('## Shared space') > p.indexOf('### Role notes'));
  });

  test('a resume carries no role block', () => {
    const p = promptOf(buildWorkerInvocation({ ...base, resumeSessionId: 's1', followUp: 'go on' }));
    assert.ok(!p.includes('## Office role'));
  });

  test('the publish turn carries no role block', () => {
    const fresh = promptOf(buildWorkerInvocation({ ...base, followUp: PUBLISH_INSTRUCTION }));
    assert.ok(!fresh.includes('## Office role'));
    const resumed = promptOf(buildWorkerInvocation({ ...base, resumeSessionId: 's1', followUp: PUBLISH_INSTRUCTION }));
    assert.ok(!resumed.includes('## Office role'));
  });
});
