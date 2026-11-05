// docs/office.md § Shifts at run time — the shift runner over a REAL AuxRunner
// whose SessionManager is a fake (no claude is spawned): the argv a shift is
// given, the run row, the read-only denials, the tools refusal, the taint and
// the resume rule, the notes/feedback split, the untrusted routing of a
// tainted shift's files, the standard correction, Pause all and boot recovery.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Office, OfficeRole } from '@tm/shared';
import { AuxRunner, READ_ONLY_DISALLOWED } from '../claude/aux.ts';
import type { SessionManager } from '../pty/session-manager.ts';
import { SqliteStorage } from '../storage/sqlite.ts';
import type { NewOfficeRole } from '../storage/office-sql.ts';
import { appendRoleFeedback, feedbackSettled, readRoleFeedback, roleFeedbackRel } from './feedback.ts';
import { scaffoldOfficeFolder } from './folder.ts';
import { trustedShiftDenies, untrustedPath } from './isolation.ts';
import { isDeliverablePath, shiftResultSchema, writeOfficeFile } from './shift-result.ts';
import { SHIFT_ISOLATION, ShiftRunner, type ShiftIsolation } from './shift.ts';

interface Spawned {
  runId: string;
  cmd: string;
  args: string[];
  cwd: string;
}

/** The SessionManager surface AuxRunner uses, with nothing behind it. */
class FakeSessions {
  spawned: Spawned[] = [];
  inputs = new Map<string, string[]>();
  private exitCb: ((e: { runId: string; exitCode: number | null; signal?: number }) => void) | null = null;
  onExit(cb: (e: { runId: string; exitCode: number | null; signal?: number }) => void) {
    this.exitCb = cb;
  }
  spawn(o: Spawned) {
    this.spawned.push(o);
    return { pty: { pid: 999_999 } };
  }
  input(runId: string, buf: Buffer) {
    const l = this.inputs.get(runId) ?? [];
    l.push(buf.toString('utf8'));
    this.inputs.set(runId, l);
  }
  kill(runId: string) {
    setImmediate(() => this.exitCb?.({ runId, exitCode: 0 }));
    return true;
  }
  get() {
    return undefined;
  }
}

let tmp = '';
let storage: SqliteStorage;
let sessions: FakeSessions;
let auxRunner: AuxRunner;
let runner: ShiftRunner;
let repoPath = '';
let repoId = '';
let n = 0;

/** The isolation card's real resolvers, with every call recorded. */
const denyCalls: { folder: string; tainted: readonly string[] }[] = [];
const isolation: ShiftIsolation = {
  trustedShiftDenies: (o, tainted) => {
    denyCalls.push({ folder: o.folderPath, tainted });
    return trustedShiftDenies(o, tainted);
  },
  untrustedPath,
};

const result = (v: unknown, prose = 'Done.') => `${prose}\n\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;

async function office(): Promise<Office> {
  n += 1;
  const ws = await storage.createWorkspace({ name: `ws${n}`, slug: `ws-${n}`, repoIds: [repoId], color: null });
  const folderPath = path.join(tmp, `office-${n}`);
  fs.mkdirSync(folderPath);
  const o = await storage.createOffice({ workspaceId: ws.id, folderPath, timezone: 'UTC', enabled: true, dayBudgetUsd: 5 });
  scaffoldOfficeFolder(o, []);
  fs.writeFileSync(path.join(folderPath, 'vision.md'), '# Vision\n\nShip the best listing site.\n');
  return o;
}

async function role(o: Office, over: Partial<NewOfficeRole> = {}): Promise<OfficeRole> {
  const key = over.key ?? `qa${++n}`;
  const r = await storage.createOfficeRole({
    officeId: o.id,
    key,
    name: `Quinn ${n}`,
    avatar: '🧪',
    title: 'QA',
    prompt: 'Find bugs. File what you find.',
    model: 'claude-opus-5-5',
    tools: ['Read', 'Glob', 'Grep'],
    schedules: [],
    triggers: [],
    guards: [],
    notesPath: `roles/${key}.md`,
    ...over,
  });
  fs.writeFileSync(path.join(o.folderPath, `roles/${key}.md`), `# ${r.name}\n\n## Notes\n\nold notes\n`);
  return r;
}

/** Wait until the fake has seen `count` spawns; returns the last. */
async function spawnedNth(count: number): Promise<Spawned> {
  for (let i = 0; i < 400 && sessions.spawned.length < count; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(sessions.spawned.length >= count, `expected spawn #${count}`);
  return sessions.spawned[count - 1];
}

const settingsOf = (args: string[]) => JSON.parse(args[args.indexOf('--settings') + 1]) as { permissions?: { deny?: string[] } };
const promptOf = (args: string[]) => args[args.length - 1];

async function stop(runId: string, text: string, sessionId = `sess-${runId.slice(0, 8)}`) {
  await auxRunner.hook(runId, 'stop', {
    session_id: sessionId,
    transcript_path: path.join(tmp, 'no-such-transcript.jsonl'),
    last_assistant_message: text,
  });
}

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-office-shift-')));
  storage = new SqliteStorage(path.join(tmp, 'tm.db'));
  await storage.migrate();
  repoPath = path.join(tmp, 'repo');
  fs.mkdirSync(repoPath);
  repoId = (await storage.createRepo({ name: 'r', path: repoPath } as never)).id;
  sessions = new FakeSessions();
  auxRunner = new AuxRunner(storage, sessions as unknown as SessionManager, 'http://127.0.0.1:1');
  runner = new ShiftRunner({ storage, isolation, aux: () => auxRunner });
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('spawn', () => {
  test('an attachable aux terminal: kind shift, task_id NULL, read-only argv, trusted denies, add-dir', async () => {
    const o = await office();
    const r = await role(o);
    const start = await runner.start(o, r, { kind: 'request', ref: 'human' });
    assert.ok(start.ok);
    const sp = await spawnedNth(sessions.spawned.length + 1);
    assert.equal(sp.cmd, 'claude');
    assert.equal(sp.cwd, o.folderPath);
    const run = await storage.getRun(sp.runId);
    assert.ok(run);
    assert.equal(run.taskId, null);
    assert.equal(run.mode, 'aux');
    assert.equal(run.kind, 'shift');
    assert.equal(run.subjectId, start.shiftId);
    assert.equal(run.label, r.name);
    assert.ok(sp.args.includes(`--disallowedTools=${READ_ONLY_DISALLOWED.join(',')}`));
    assert.deepEqual(READ_ONLY_DISALLOWED, ['Edit', 'Write', 'NotebookEdit', 'Bash']);
    assert.equal(sp.args[sp.args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.ok(sp.args.includes('--tools=Read,Glob,Grep'));
    assert.ok(sp.args.includes(`--add-dir=${repoPath}`));
    assert.ok(!sp.args.includes('--resume'), 'no session yet: fresh');
    // the isolation card's own rules, untouched: the untrusted storage on both spellings
    assert.equal(SHIFT_ISOLATION.trustedShiftDenies, trustedShiftDenies);
    assert.equal(SHIFT_ISOLATION.untrustedPath, untrustedPath);
    const deny = settingsOf(sp.args).permissions?.deny;
    assert.deepEqual(deny, trustedShiftDenies(o, []));
    assert.ok(deny?.includes(`Read(/${untrustedPath(o, '')}/**)`));
    const shift = await storage.getShift(start.shiftId);
    assert.equal(shift?.verdict, 'ran');
    assert.equal(shift?.runId, sp.runId);
    assert.equal(shift?.tainted, false);
    assert.equal(shift?.endedAt, null);

    await stop(sp.runId, result({}));
    const out = await start.done;
    assert.equal(out.status, 'ok');
    const ended = await storage.getShift(start.shiftId);
    assert.ok(ended?.endedAt);
    assert.equal(ended?.error, null);
    // the role keeps the new session, trusted
    const after1 = await storage.getOfficeRole(r.id);
    assert.equal(after1?.sessionId, `sess-${sp.runId.slice(0, 8)}`);
    assert.equal(after1?.sessionTainted, false);
  });

  test('a role whose stored tools fall outside SHIFT_TOOL_ALLOWLIST is refused before any spawn', async () => {
    const o = await office();
    const before = sessions.spawned.length;
    for (const tools of [['Read', 'Bash'], ['Edit'], ['Write'], ['NotebookEdit'], ['Read', 'mcp__evil']]) {
      const r = await role(o, { tools });
      const s = await runner.start(o, r, { kind: 'request' });
      assert.equal(s.ok, false);
      assert.equal(!s.ok && s.code, 'tools');
    }
    assert.equal(sessions.spawned.length, before);
    // a caller holding a stale copy: the STORED tools decide
    const sneaky = await role(o);
    await storage.updateOfficeRole(sneaky.id, { tools: ['Read', 'Bash'] });
    const s2 = await runner.start(o, sneaky, { kind: 'request' });
    assert.equal(!s2.ok && s2.code, 'tools');
    assert.equal(sessions.spawned.length, before);
    assert.equal(runner.liveCount(), 0);
    assert.equal((await storage.listShifts({ officeId: o.id })).length, 0, 'a refusal writes no shift row');
  });

  test('invalid result JSON gets the standard correction typed into the session, at most twice', async () => {
    const o = await office();
    const r = await role(o);
    const start = await runner.start(o, r, { kind: 'request' });
    assert.ok(start.ok);
    const sp = await spawnedNth(sessions.spawned.length + 1);
    await stop(sp.runId, 'no block at all');
    await stop(sp.runId, result({ unknownSection: 1 }));
    const typed = (sessions.inputs.get(sp.runId) ?? []).filter((l) => l.includes('did not end with a valid result block'));
    assert.equal(typed.length, 2);
    await stop(sp.runId, result({ notes: '' }));
    const out = await start.done;
    assert.equal(out.status, 'failed');
    assert.match(out.error ?? '', /invalid result/);
    const shift = await storage.getShift(start.shiftId);
    assert.match(shift?.error ?? '', /invalid result/);
    assert.ok(shift?.endedAt);
  });
});

describe('notes and feedback', () => {
  test('a feedback line appended while the shift runs survives its notes replacement and reaches the next prompt', async () => {
    const o = await office();
    const r = await role(o);
    const s1 = await runner.start(o, r, { kind: 'request' });
    assert.ok(s1.ok);
    const sp1 = await spawnedNth(sessions.spawned.length + 1);
    // the server writes about the role while its shift is live
    await appendRoleFeedback(o, r, 'Proposal "cache listings" was ACCEPTED by a human.\nThanks.');
    await stop(sp1.runId, result({ notes: '# Notes\n\nnew notes, replacing the old\n' }));
    const out = await s1.done;
    assert.equal(out.status, 'ok');
    assert.deepEqual(out.applied.map((a) => a.files), [[`roles/${r.key}.md`]]);
    assert.equal(fs.readFileSync(path.join(o.folderPath, `roles/${r.key}.md`), 'utf8'), '# Notes\n\nnew notes, replacing the old\n');
    const fb = fs.readFileSync(path.join(o.folderPath, roleFeedbackRel(r.key)), 'utf8');
    assert.match(fb, /ACCEPTED by a human\. Thanks\./);

    const fresh = (await storage.getOfficeRole(r.id))!;
    const s2 = await runner.start(o, fresh, { kind: 'request' });
    assert.ok(s2.ok);
    const sp2 = await spawnedNth(sessions.spawned.length + 1);
    const p = promptOf(sp2.args);
    assert.match(p, /Proposal "cache listings" was ACCEPTED by a human\. Thanks\./);
    assert.match(p, /new notes, replacing the old/);
    assert.match(p, /Ship the best listing site/, 'vision inline');
    assert.match(p, /## Recent office history[\s\S]*```json[\s\S]*"shift": "/, 'history as fenced data');
    assert.match(p, /## How to return your result/);
    await stop(sp2.runId, result({}));
    await s2.done;
  });

  test('appendRoleFeedback: serialized, append-only, newline-folded, symlink refused', async () => {
    const o = await office();
    const r = await role(o);
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendRoleFeedback(o, r, `entry ${i}`)));
    const entries = await readRoleFeedback(o, r);
    assert.deepEqual(
      entries.map((e) => e.replace(/^\S+ — /, '')),
      Array.from({ length: 20 }, (_, i) => `entry ${i}`),
    );
    for (let i = 20; i < 70; i++) await appendRoleFeedback(o, r, `entry ${i}`);
    const last = await readRoleFeedback(o, r);
    assert.equal(last.length, 50);
    assert.match(last[49], /entry 69$/);
    // a shift section cannot target the file
    assert.throws(() => writeOfficeFile(o, roleFeedbackRel(r.key), 'overwrite'), /written by the server only/);
    // a symlink planted there is refused, not followed
    const other = await role(o);
    const outside = path.join(tmp, `outside-${n}.txt`);
    fs.writeFileSync(outside, 'secret\n');
    fs.symlinkSync(outside, path.join(o.folderPath, roleFeedbackRel(other.key)));
    await assert.rejects(appendRoleFeedback(o, other, 'x'));
    assert.equal(fs.readFileSync(outside, 'utf8'), 'secret\n');
    await feedbackSettled(o, other);
    await assert.rejects(appendRoleFeedback(o, other, ' \n '), /empty/);
  });
});

describe('taint', () => {
  test('a role with WebFetch is tainted (web-tool); its notes and deliverables land at untrustedPath', async () => {
    const o = await office();
    const r = await role(o, { tools: ['Read', 'WebFetch'] });
    const start = await runner.start(o, r, { kind: 'cron', ref: '0 9 * * 1-5' });
    assert.ok(start.ok);
    const sp = await spawnedNth(sessions.spawned.length + 1);
    assert.equal(settingsOf(sp.args).permissions, undefined, 'the trusted denies are a trusted shift’s');
    const row = await storage.getShift(start.shiftId);
    assert.equal(row?.tainted, true);
    assert.deepEqual(row?.taintSources.map((s) => s.split(':')[0]), ['web-tool']);
    assert.deepEqual(row?.taintSources, ['web-tool:WebFetch']);

    await stop(
      sp.runId,
      result({ notes: 'tainted notes', deliverables: [{ path: 'deliverables/seo/audit.md', markdown: '# Audit' }] }),
    );
    const out = await start.done;
    assert.equal(out.status, 'ok');
    const notesAt = untrustedPath(o, `roles/${r.key}.md`);
    const delivAt = untrustedPath(o, 'deliverables/seo/audit.md');
    assert.equal(fs.readFileSync(notesAt, 'utf8'), 'tainted notes\n');
    assert.equal(fs.readFileSync(delivAt, 'utf8'), '# Audit\n');
    assert.deepEqual(out.applied.flatMap((a) => a.files), [path.relative(o.folderPath, notesAt), path.relative(o.folderPath, delivAt)]);
    assert.match(fs.readFileSync(path.join(o.folderPath, `roles/${r.key}.md`), 'utf8'), /old notes/, 'trusted notes untouched');
    assert.ok(!fs.existsSync(path.join(o.folderPath, 'deliverables/seo/audit.md')));
    const after1 = await storage.getOfficeRole(r.id);
    assert.ok(after1?.notesTaintedAt, 'notes_tainted_at set');
    assert.equal(after1?.sessionTainted, true);

    // the next shift of that role reads the untrusted twin and is tainted by it
    const plan = await runner.plan(o, after1!, { kind: 'request' }, await storage.getSettings());
    assert.equal(plan.notesText, 'tainted notes\n');
    assert.ok(plan.taintSources.some((t) => t.startsWith('tainted-notes:')));
    assert.equal(plan.denies, null);

    // a TRUSTED shift of another role: that role's notes file is denied where it stands, too
    const other = await role(o);
    denyCalls.length = 0;
    const p2 = await runner.plan(o, other, { kind: 'request' }, await storage.getSettings());
    assert.equal(p2.tainted, false);
    assert.deepEqual(denyCalls.at(-1)?.tainted, [`roles/${r.key}.md`]);
    assert.ok(p2.denies?.includes(`Read(/${path.join(o.folderPath, `roles/${r.key}.md`)})`));
  });

  test('a trusted shift: notes and deliverables at their own paths; notes_tainted_at stays null', async () => {
    const o = await office();
    const r = await role(o);
    const start = await runner.start(o, r, { kind: 'request' });
    assert.ok(start.ok);
    const sp = await spawnedNth(sessions.spawned.length + 1);
    await stop(sp.runId, result({ notes: 'trusted', deliverables: [{ path: 'deliverables/report.md', markdown: 'r' }] }));
    await start.done;
    assert.equal(fs.readFileSync(path.join(o.folderPath, 'deliverables/report.md'), 'utf8'), 'r\n');
    assert.equal((await storage.getOfficeRole(r.id))?.notesTaintedAt, null);
  });
});

describe('resume', () => {
  async function priorSession(o: Office, r: OfficeRole, opts: { tainted: boolean; contextTokens?: number }) {
    const run = await storage.createRun({ mode: 'aux', kind: 'shift', subjectId: null, label: r.name } as never);
    await storage.updateRun(run.id, {
      sessionId: `prior-${run.id.slice(0, 8)}`,
      transcriptPath: '/nowhere.jsonl',
      status: 'exited',
      ...(opts.contextTokens !== undefined ? { stats: { contextTokens: opts.contextTokens } as never } : {}),
    });
    await storage.appendShift({ officeId: o.id, roleId: r.id, trigger: { kind: 'request', ref: null, at: new Date().toISOString() }, verdict: 'ran', runId: run.id, endedAt: new Date().toISOString() });
    return (await storage.updateOfficeRole(r.id, { sessionId: `prior-${run.id.slice(0, 8)}`, sessionTainted: opts.tainted }))!;
  }
  const settings = async (cap: number) => ({ ...(await storage.getSettings()), 'agent.resumeContextCap': cap });

  test('a small trusted session is resumed', async () => {
    const o = await office();
    const r = await priorSession(o, await role(o), { tainted: false, contextTokens: 50_000 });
    const plan = await runner.plan(o, r, { kind: 'request' }, await settings(300_000));
    assert.equal(plan.resumeSessionId, r.sessionId);
    assert.equal(plan.baselineTranscript, '/nowhere.jsonl');
    assert.equal(plan.tainted, false);
  });

  test('a trusted shift never resumes a tainted session', async () => {
    const o = await office();
    const r = await priorSession(o, await role(o), { tainted: true, contextTokens: 1_000 });
    const stale: OfficeRole = { ...r, sessionTainted: false };
    const plan = await runner.plan(o, r, { kind: 'request' }, await settings(300_000));
    assert.equal(plan.resumeSessionId, null);
    assert.equal(plan.tainted, false);
    assert.match(plan.freshReason ?? '', /never resumes a tainted session/);
    // end to end, handed a STALE copy that calls the session trusted: the stored row decides
    const start = await runner.start(o, stale, { kind: 'request' });
    assert.ok(start.ok);
    const sp = await spawnedNth(sessions.spawned.length + 1);
    assert.ok(!sp.args.includes('--resume'));
    await stop(sp.runId, result({}), 'fresh-trusted');
    await start.done;
    const after1 = await storage.getOfficeRole(r.id);
    assert.equal(after1?.sessionId, 'fresh-trusted');
    assert.equal(after1?.sessionTainted, false);
  });

  test('a tainted shift may resume a tainted session (and it stays tainted)', async () => {
    const o = await office();
    const r = await priorSession(o, await role(o, { tools: ['Read', 'WebSearch'] }), { tainted: true, contextTokens: 1_000 });
    const plan = await runner.plan(o, r, { kind: 'request' }, await settings(300_000));
    assert.equal(plan.resumeSessionId, r.sessionId);
    assert.equal(plan.tainted, true);
    assert.ok(plan.taintSources.includes(`tainted-session:${r.sessionId}`));
  });

  test('an oversized (or unmeasured) session starts fresh', async () => {
    const o = await office();
    const big = await priorSession(o, await role(o), { tainted: false, contextTokens: 300_000 });
    const p1 = await runner.plan(o, big, { kind: 'request' }, await settings(300_000));
    assert.equal(p1.resumeSessionId, null);
    assert.match(p1.freshReason ?? '', /resume cap/);
    const unknown = await priorSession(o, await role(o), { tainted: false });
    const p2 = await runner.plan(o, unknown, { kind: 'request' }, await settings(300_000));
    assert.equal(p2.resumeSessionId, null);
    // end to end with the argv
    const start = await runner.start(o, big, { kind: 'request' });
    assert.ok(start.ok);
    const sp = await spawnedNth(sessions.spawned.length + 1);
    assert.ok(!sp.args.includes('--resume'));
    await stop(sp.runId, result({}));
    await start.done;
  });

  test('a resumable session goes on the argv as --resume', async () => {
    const o = await office();
    const r = await priorSession(o, await role(o), { tainted: false, contextTokens: 10 });
    const start = await runner.start(o, r, { kind: 'request' });
    assert.ok(start.ok);
    const sp = await spawnedNth(sessions.spawned.length + 1);
    assert.equal(sp.args[sp.args.indexOf('--resume') + 1], r.sessionId);
    await stop(sp.runId, result({}), r.sessionId!);
    const out = await start.done;
    assert.equal(out.resumed, true);
  });

  test('a tainted shift resuming a trusted session marks it tainted before the run', async () => {
    const o = await office();
    const r = await priorSession(o, await role(o), { tainted: false, contextTokens: 10 });
    const start = await runner.start(o, r, { kind: 'signal', ref: 'sentry' });
    assert.ok(start.ok);
    await spawnedNth(sessions.spawned.length + 1);
    assert.equal((await storage.getOfficeRole(r.id))?.sessionTainted, true, 'tainted while the shift is live');
    runner.suspendAll();
    await start.done;
  });
});

describe('concurrency, Pause all, boot', () => {
  test('one live shift per office, two overall', async () => {
    const [o1, o2, o3] = [await office(), await office(), await office()];
    const a = await runner.start(o1, await role(o1), { kind: 'request' });
    assert.ok(a.ok);
    const again = await runner.start(o1, await role(o1), { kind: 'request' });
    assert.equal(!again.ok && again.code, 'office-busy');
    const b = await runner.start(o2, await role(o2), { kind: 'request' });
    assert.ok(b.ok);
    const c = await runner.start(o3, await role(o3), { kind: 'request' });
    assert.equal(!c.ok && c.code, 'busy');
    assert.equal(runner.suspendAll(), 2);
    const [oa, ob] = await Promise.all([a.done, b.done]);
    assert.equal(oa.error, 'suspended by Pause all');
    assert.equal(ob.error, 'suspended by Pause all');
    assert.equal((await storage.getShift(a.shiftId))?.error, 'suspended by Pause all');
    assert.ok((await storage.getShift(a.shiftId))?.endedAt);
    assert.equal(runner.liveCount(), 0);
  });

  test('a folder no deny rule can match exactly is refused before any row', async () => {
    const ws = await storage.createWorkspace({ name: 'odd', slug: 'odd-ws', repoIds: [repoId], color: null });
    const folderPath = path.join(tmp, 'odd [office]');
    fs.mkdirSync(path.join(folderPath, 'roles'), { recursive: true });
    const o = await storage.createOffice({ workspaceId: ws.id, folderPath, timezone: 'UTC', enabled: true, dayBudgetUsd: 5 });
    const r = await role(o);
    const s = await runner.start(o, r, { kind: 'request' });
    assert.equal(!s.ok && s.code, 'folder');
    assert.equal((await storage.listShifts({ officeId: o.id })).length, 0);
    assert.equal(runner.liveCount(), 0);
  });

  test('Pause all on: no shift starts', async () => {
    const o = await office();
    const r = await role(o);
    await storage.setSetting('orchestrator.paused', true);
    try {
      const s = await runner.start(o, r, { kind: 'request' });
      assert.equal(!s.ok && s.code, 'paused');
      assert.equal(runner.liveCount(), 0);
    } finally {
      await storage.setSetting('orchestrator.paused', false);
    }
  });

  test('boot recovery closes a shift row a crash left open', async () => {
    const o = await office();
    const r = await role(o);
    const open = await storage.appendShift({ officeId: o.id, roleId: r.id, trigger: { kind: 'cron', ref: '* * * * *', at: new Date().toISOString() }, verdict: 'ran' });
    assert.ok((await runner.recoverOnBoot()) >= 1);
    const row = await storage.getShift(open.id);
    assert.ok(row?.endedAt);
    assert.equal(row?.error, 'interrupted by restart');
  });
});

describe('result registry', () => {
  test('deliverable paths stay under deliverables/', () => {
    for (const ok of ['deliverables/a.md', 'deliverables/seo/2026-11/audit.v2.md']) assert.ok(isDeliverablePath(ok), ok);
    for (const bad of ['a.md', 'deliverables/../roles/x.md', 'deliverables/.hidden.md', 'deliverables/a.txt', '/deliverables/a.md', 'deliverables//a.md', 'roles/x.feedback.md', 'deliverables/a b.md'])
      assert.ok(!isDeliverablePath(bad), bad);
    const schema = shiftResultSchema();
    assert.equal(schema.safeParse({}).success, true);
    assert.equal(schema.safeParse({ deliverables: [{ path: 'deliverables/x.md', markdown: 'm' }, { path: 'deliverables/x.md', markdown: 'n' }] }).success, false);
    assert.equal(schema.safeParse({ notes: 'x'.repeat(24_001) }).success, false);
    assert.equal(schema.safeParse({ briefs: [] }).success, false, 'an unregistered section is refused');
    assert.equal(schema.safeParse({ tasks: [] }).success, true, 'tasks is registered (filing.ts)');
  });
});

describe('tasks section (docs/office.md § Filing)', () => {
  const ask = (i: number) => ({ repoId, title: `Add tests for parser ${i}`, description: `Cover parser ${i}.`, effort: 'low' });

  test('a trusted auto-run shift files queued role-tagged tasks; ids on the shift row and the office.shift row', async () => {
    await storage.setSetting('orchestrator.enabled', true);
    const o = (await storage.updateOffice((await office()).id, { autonomy: 'auto-run' }))!;
    const r = await role(o);
    const start = await runner.start(o, r, { kind: 'request' });
    assert.ok(start.ok);
    const sp = await spawnedNth(sessions.spawned.length + 1);
    assert.ok(promptOf(sp.args).includes('(repoId `' + repoId + '`)'), 'the prompt lists the repo id');
    assert.match(promptOf(sp.args), /`tasks`:/);
    // the second asks by repo NAME: mapped to the workspace repo
    await stop(sp.runId, result({ tasks: [ask(1), { ...ask(2), repoId: 'R' }] }));
    const out = await start.done;
    assert.equal(out.status, 'ok');
    assert.equal(out.error, null);
    const row = (await storage.getShift(start.shiftId))!;
    assert.equal(row.filedTaskIds.length, 2);
    assert.deepEqual(row.filing, { status: 'queued', note: null, held: [], dropped: [] });
    for (const id of row.filedTaskIds) {
      const t = (await storage.getTask(id))!;
      assert.equal(t.status, 'queued');
      assert.equal(t.source, 'office');
      assert.equal(t.officeId, o.id);
      assert.equal(t.roleId, r.id);
      assert.equal(t.createdByRun, sp.runId);
      assert.equal(t.repoId, repoId);
      assert.equal(t.taintedAt, null);
    }
    const ev = (await storage.listEvents({ kind: 'office.shift', limit: 200 })).find((e) => (e.data as any)?.shiftId === start.shiftId);
    assert.deepEqual((ev?.data as any).sections, [{ section: 'tasks', files: [], taskIds: row.filedTaskIds }]);
  });

  test('a tainted (WebFetch) shift files drafts with tainted_at', async () => {
    await storage.setSetting('orchestrator.enabled', true);
    const o = (await storage.updateOffice((await office()).id, { autonomy: 'autonomous' }))!;
    const r = await role(o, { tools: ['Read', 'WebFetch'] });
    const start = await runner.start(o, r, { kind: 'request' });
    assert.ok(start.ok);
    const sp = await spawnedNth(sessions.spawned.length + 1);
    await stop(sp.runId, result({ tasks: [ask(3)] }));
    await start.done;
    const row = (await storage.getShift(start.shiftId))!;
    assert.equal(row.tainted, true);
    const t = (await storage.getTask(row.filedTaskIds[0]))!;
    assert.equal(t.status, 'draft');
    assert.ok(t.taintedAt);
  });

  test('proposals (the default autonomy) files nothing and holds the requests', async () => {
    const o = await office();
    const r = await role(o);
    const start = await runner.start(o, r, { kind: 'request' });
    assert.ok(start.ok);
    const sp = await spawnedNth(sessions.spawned.length + 1);
    await stop(sp.runId, result({ tasks: [ask(4)] }));
    await start.done;
    const row = (await storage.getShift(start.shiftId))!;
    assert.deepEqual(row.filedTaskIds, []);
    assert.equal(row.filing?.status, 'proposal');
    assert.equal(row.filing?.held[0].title, 'Add tests for parser 4');
  });
});
