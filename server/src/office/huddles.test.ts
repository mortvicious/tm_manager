// docs/office.md § Huddles — over a temp SQLite DB and a fake PTY pool: a
// huddle with no subject (or a bad role set / turn cap) is refused, its turns
// run round-robin as shifts of each participant in its OWN session with its
// OWN notes, it never runs more than max_turns shifts and ends with a decision
// row (decided, or expired with the server's line), the decision reaches the
// Director as an unrouted channel message, taint from a participant or a
// mid-way turn propagates to the decision and the work filed from it, and the
// participants read `in-huddle` while it is open.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { OFFICE_ROUTE_DEBOUNCE_MS, type Office, type OfficeHuddle, type OfficeHuddlesResponse, type OfficeRole } from '@tm/shared';
import { AuxRunner } from '../claude/aux.ts';
import { CONVERSATIONAL_REPLY_RULE } from '../claude/reply-style.ts';
import type { SessionManager } from '../pty/session-manager.ts';
import { registerOfficeRoutes } from '../routes/offices.ts';
import { SqliteStorage } from '../storage/sqlite.ts';
import type { NewOfficeRole } from '../storage/office-sql.ts';
import { officeChannel, wakeChannelRouting } from './channel.ts';
import { scaffoldOfficeFolder } from './folder.ts';
import { HuddleRunner, OfficeHuddleRefused, openHuddle, type HuddleAdvance } from './huddles.ts';
import { officeStates } from './scheduler.ts';
import { ShiftRunner } from './shift.ts';

interface Spawned {
  runId: string;
  cmd: string;
  args: string[];
  cwd: string;
}

class FakeSessions {
  spawned: Spawned[] = [];
  private exitCb: ((e: { runId: string; exitCode: number | null; signal?: number }) => void) | null = null;
  onExit(cb: (e: { runId: string; exitCode: number | null; signal?: number }) => void) {
    this.exitCb = cb;
  }
  spawn(o: Spawned) {
    this.spawned.push(o);
    return { pty: { pid: 999_999 } };
  }
  input() {}
  kill(runId: string) {
    setImmediate(() => this.exitCb?.({ runId, exitCode: 0 }));
    return true;
  }
  get() {
    return undefined;
  }
}

const ORIGIN = { origin: 'http://localhost:5173' };

let tmp = '';
let storage: SqliteStorage;
let sessions: FakeSessions;
let auxRunner: AuxRunner;
let runner: ShiftRunner;
let huddles: HuddleRunner;
let repoId = '';
let n = 0;
const app = Fastify();

const result = (v: unknown) => `Done.\n\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;
const promptOf = (args: string[]) => args[args.length - 1];

async function office(): Promise<Office> {
  n += 1;
  const ws = await storage.createWorkspace({ name: `ws${n}`, slug: `hud-${n}`, repoIds: [repoId], color: null });
  const folderPath = path.join(tmp, `office-${n}`);
  fs.mkdirSync(folderPath);
  const o = await storage.createOffice({ workspaceId: ws.id, folderPath, timezone: 'UTC', enabled: true, dayBudgetUsd: 5, autonomy: 'auto-run' });
  scaffoldOfficeFolder(o, []);
  return o;
}

async function role(o: Office, over: Partial<NewOfficeRole> = {}, notes = '# notes\n'): Promise<OfficeRole> {
  const key = over.key ?? `r${++n}`;
  const r = await storage.createOfficeRole({
    officeId: o.id,
    key,
    name: `Role ${key}`,
    avatar: '🧪',
    title: 'Role',
    prompt: 'Do the job.',
    model: 'claude-opus-5-5',
    tools: ['Read', 'Glob', 'Grep'],
    schedules: [],
    triggers: [],
    guards: [],
    notesPath: `roles/${key}.md`,
    ...over,
  });
  fs.writeFileSync(path.join(o.folderPath, `roles/${key}.md`), notes);
  return r;
}

const director = (o: Office) => role(o, { key: `director${++n}`, preset: 'director', title: 'Director' });

async function task(title = 'Checkout fails on Safari') {
  return storage.createTask({ title, description: 'The pay button does nothing on Safari 17.', repoId, status: 'queued' } as never, 'test');
}

async function spawnedNth(count: number): Promise<Spawned> {
  for (let i = 0; i < 400 && sessions.spawned.length < count; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(sessions.spawned.length >= count, `expected spawn #${count}`);
  return sessions.spawned[count - 1];
}

async function stop(runId: string, text: string, sessionId = `sess-${runId.slice(0, 8)}`) {
  await auxRunner.hook(runId, 'stop', {
    session_id: sessionId,
    transcript_path: path.join(tmp, 'no-such-transcript.jsonl'),
    last_assistant_message: text,
  });
}

/**
 * One huddle turn: advance the runner, answer the spawned turn with `value`
 * (or a function of its prompt) and wait for the runner's after-turn work.
 */
async function turn(o: Office, value: unknown | ((prompt: string) => unknown)) {
  const spawns = sessions.spawned.length;
  const out = await huddles.advance((await storage.getOffice(o.id))!);
  const started = out.find((a): a is Extract<HuddleAdvance, { kind: 'started' }> => a.kind === 'started');
  assert.ok(started, `a turn starts: ${JSON.stringify(out)}`);
  const sp = await spawnedNth(spawns + 1);
  const prompt = promptOf(sp.args);
  await stop(sp.runId, result(typeof value === 'function' ? (value as (p: string) => unknown)(prompt) : value));
  await started.done;
  return { prompt, args: sp.args, shiftId: started.shiftId, turn: started.turn };
}

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-office-huddles-')));
  storage = new SqliteStorage(path.join(tmp, 'tm.db'));
  await storage.migrate();
  const repoPath = path.join(tmp, 'repo');
  fs.mkdirSync(repoPath);
  repoId = (await storage.createRepo({ name: 'r', path: repoPath } as never)).id;
  sessions = new FakeSessions();
  auxRunner = new AuxRunner(storage, sessions as unknown as SessionManager, 'http://127.0.0.1:1');
  runner = new ShiftRunner({ storage, aux: () => auxRunner });
  huddles = new HuddleRunner({ storage, shifts: () => runner, chain: false });
  app.setErrorHandler((err, _req, reply) =>
    reply.code(err instanceof ZodError ? 400 : 500).send({ error: err instanceof ZodError ? err.issues.map((i) => i.message).join('; ') : String(err) }),
  );
  registerOfficeRoutes(app, storage);
  await app.ready();
});

after(async () => {
  huddles.stop();
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('opening a huddle', () => {
  test('a huddle without a subject is refused — no free chat — and so are bad role sets and turn caps', async () => {
    const o = await office();
    await director(o);
    await role(o, { key: 'qa' });
    await role(o, { key: 'dev' });
    await role(o, { key: 'ops' });
    await role(o, { key: 'pm' });
    const t = await task();
    const base = { roles: ['qa', 'dev'], openedBy: 'stakeholder' as const, actor: 'human' };
    await assert.rejects(openHuddle(storage, o, { ...base, subject: null }), (e: Error) => e instanceof OfficeHuddleRefused && /needs a subject/.test(e.message));
    await assert.rejects(openHuddle(storage, o, { ...base, subject: { kind: 'huddle', id: 'x' } }), OfficeHuddleRefused);
    await assert.rejects(openHuddle(storage, o, { ...base, subject: { kind: 'task', id: 'no-such-task' } }), /no task/);
    await assert.rejects(openHuddle(storage, o, { ...base, roles: ['qa'], subject: { kind: 'task', id: t.id } }), /between 2 and 3/);
    await assert.rejects(openHuddle(storage, o, { ...base, roles: ['qa', 'dev', 'ops', 'pm'], subject: { kind: 'task', id: t.id } }), /between 2 and 3/);
    await assert.rejects(openHuddle(storage, o, { ...base, roles: ['qa', 'nobody'], subject: { kind: 'task', id: t.id } }), /no role "nobody"/);
    await assert.rejects(openHuddle(storage, o, { ...base, maxTurns: 7, subject: { kind: 'task', id: t.id } }), /maxTurns is 2\.\.6/);
    assert.equal((await storage.listHuddles({ officeId: o.id })).length, 0);

    // the API: Origin required, a missing subject is a 400, a second huddle on one subject a 409
    const noOrigin = await app.inject({ method: 'POST', url: `/api/offices/${o.id}/huddles`, payload: { roles: ['qa', 'dev'], subject: { kind: 'task', id: t.id } } });
    assert.equal(noOrigin.statusCode, 403);
    const noSubject = await app.inject({ method: 'POST', url: `/api/offices/${o.id}/huddles`, headers: ORIGIN, payload: { roles: ['qa', 'dev'] } });
    assert.equal(noSubject.statusCode, 400);
    assert.match(noSubject.json().error, /needs a subject/);
    const ok = await app.inject({ method: 'POST', url: `/api/offices/${o.id}/huddles`, headers: ORIGIN, payload: { roles: ['qa', 'dev'], subject: { kind: 'task', id: t.id } } });
    assert.equal(ok.statusCode, 201, ok.body);
    assert.equal((ok.json() as OfficeHuddle).maxTurns, 4, 'default 4 turns');
    const twice = await app.inject({ method: 'POST', url: `/api/offices/${o.id}/huddles`, headers: ORIGIN, payload: { roles: ['qa', 'ops'], subject: { kind: 'task', id: t.id } } });
    assert.equal(twice.statusCode, 409);
    const close = await app.inject({ method: 'POST', url: `/api/office-huddles/${(ok.json() as OfficeHuddle).id}/close`, headers: ORIGIN });
    assert.equal(close.statusCode, 200);
    assert.equal(close.json().status, 'expired');
    assert.match(close.json().decision, /closed by a human/);
  });
});

describe('running a huddle', () => {
  test('turns run round-robin in each role’s own session with its own notes, capped, and end with a decision routed by the Director', async () => {
    const o = await office();
    const d = await director(o);
    const qa = await role(o, { key: 'qa', preset: 'qa' }, '# QA notes\nQA-NOTES-MARK\n');
    const dev = await role(o, { key: 'dev' }, '# Dev notes\nDEV-NOTES-MARK\n');
    const t = await task();
    await storage.setSetting('agent.resumeContextCap', 0);
    try {
      const h = await openHuddle(storage, o, {
        subject: { kind: 'task', id: t.id },
        roles: ['qa', 'dev'],
        maxTurns: 4,
        openedBy: 'stakeholder',
        opening: 'Is this a Safari bug or ours?',
        actor: 'human',
      });
      assert.equal(h.taintedAt, null);
      // role state while open
      const states = await officeStates(storage, o.id);
      assert.equal(states!.states.find((s) => s.roleId === qa.id)!.state, 'in-huddle');
      assert.equal(states!.states.find((s) => s.roleId === dev.id)!.state, 'in-huddle');
      assert.notEqual(states!.states.find((s) => s.roleId === d.id)!.state, 'in-huddle');

      const t1 = await turn(o, (p: string) => {
        assert.match(p, /## Huddle — turn 1 of 4/);
        assert.match(p, /QA-NOTES-MARK/);
        assert.doesNotMatch(p, /DEV-NOTES-MARK/);
        assert.match(p, /Is this a Safari bug or ours\?/, 'the opening question is in the transcript');
        assert.match(p, /Checkout fails on Safari/, 'the subject is in the prompt');
        assert.doesNotMatch(p, /Saved commands you may request/, 'a turn has a lean prompt');
        assert.doesNotMatch(p, /"tasks"/, 'a turn cannot file tasks');
        assert.ok(p.includes(CONVERSATIONAL_REPLY_RULE), 'a huddle turn carries the conversational reply rule');
        assert.match(p, /Say only what moves the decision along/);
        return { huddle: { say: 'QA-SAYS: reproduced only on Safari 17 with ITP on.' } };
      });
      assert.ok(!t1.args.includes('--resume'), 'qa had no session yet');
      const qaSession = (await storage.getOfficeRole(qa.id))!.sessionId;
      assert.ok(qaSession);

      const t2 = await turn(o, (p: string) => {
        assert.match(p, /turn 2 of 4/);
        assert.match(p, /DEV-NOTES-MARK/);
        assert.doesNotMatch(p, /QA-NOTES-MARK/);
        assert.match(p, /QA-SAYS/, 'the transcript so far');
        return { huddle: { say: 'DEV-SAYS: our cookie is SameSite=None without Secure.' }, notes: '# Dev notes\nDEV-NOTES-MARK\nSafari cookie lesson.\n' };
      });
      assert.ok(!t2.args.includes('--resume'));
      assert.match(fs.readFileSync(path.join(o.folderPath, 'roles/dev.md'), 'utf8'), /Safari cookie lesson/, 'a turn may keep its own notes');

      const t3 = await turn(o, (p: string) => {
        assert.match(p, /turn 3 of 4/);
        assert.match(p, /QA-NOTES-MARK/);
        assert.match(p, /DEV-SAYS/);
        return { huddle: { say: 'Agreed, that explains ITP.' } };
      });
      assert.equal(t3.args[t3.args.indexOf('--resume') + 1], qaSession, 'qa’s own session is resumed');

      // a `tasks` section in a turn is refused by the result schema (typed correction), so return a valid one
      const t4 = await turn(o, (p: string) => {
        assert.match(p, /This is the LAST turn: you MUST return `decision`/);
        return { huddle: { say: 'Fix it.', decision: 'Set Secure on the session cookie and add a Safari check.' } };
      });
      assert.equal(t4.turn, 4);

      const closed = (await storage.getHuddle(h.id))!;
      assert.equal(closed.status, 'decided');
      assert.equal(closed.turns, 4);
      assert.equal(closed.decision, 'Set Secure on the session cookie and add a Safari check.');
      const turnShifts = (await storage.listShifts({ officeId: o.id, triggerKind: 'huddle' })).filter((s) => s.trigger.ref?.startsWith(`huddle:${h.id}#`));
      assert.equal(turnShifts.length, 4, 'exactly max_turns shifts');
      assert.deepEqual(
        turnShifts.map((s) => s.roleId).reverse(),
        [qa.id, dev.id, qa.id, dev.id],
        'round-robin',
      );
      // nothing more runs; no role is in a huddle any more
      const more = await huddles.advance(o);
      assert.ok(!more.some((a) => a.kind === 'started'));
      const after = await officeStates(storage, o.id);
      assert.ok(after!.states.every((s) => s.state !== 'in-huddle'));

      // the decision is an unrouted message to the Director; transcript lines are not channel traffic
      const [decision] = await storage.listOfficeMessages({ officeId: o.id, unrouted: true });
      assert.equal(decision.toRoleId, d.id);
      assert.deepEqual(decision.subject, { kind: 'huddle', id: h.id });
      assert.match(decision.body, /^Huddle decision — task/);
      assert.equal(decision.taintedAt, null);
      const chan = await officeChannel(storage, o);
      assert.deepEqual(
        chan.messages.map((m) => m.id),
        [decision.id],
        'the channel shows the decision, not the transcript',
      );
      const view = (await app.inject({ method: 'GET', url: `/api/offices/${o.id}/huddles` })).json() as OfficeHuddlesResponse;
      const v = view.huddles.find((x) => x.id === h.id)!;
      assert.deepEqual(
        v.entries.map((e) => [e.kind, e.turn]),
        [
          ['opening', null],
          ['turn', 1],
          ['turn', 2],
          ['turn', 3],
          ['turn', 4],
        ],
      );
      assert.equal(v.decisionMessageId, decision.id);
      assert.equal(v.openedBy, 'stakeholder');

      // the Director's routing pass turns the decision into work; a huddle of a huddle is refused
      let started: { done: Promise<unknown>; spawns: number } | null = null;
      const spawns = sessions.spawned.length;
      const wake = await wakeChannelRouting(
        {
          storage,
          now: Date.now() + OFFICE_ROUTE_DEBOUNCE_MS + 1_000,
          start: async (oo, rr, tt) => {
            const s = await runner.start(oo, rr, tt);
            if (s.ok) started = { done: s.done, spawns };
            return s;
          },
        },
        o,
      );
      assert.ok(wake?.ok, JSON.stringify(wake));
      const sp = await spawnedNth(spawns + 1);
      const dp = promptOf(sp.args);
      assert.match(dp, /"huddleId"/);
      assert.match(dp, /never another huddle/);
      await stop(
        sp.runId,
        result({ routes: [{ messageId: decision.id, action: 'task', task: { repoId, title: 'Secure session cookie', description: 'Set Secure; add a Safari check.' } }] }),
      );
      await started!.done;
      const routed = (await storage.getOfficeMessage(decision.id))!;
      assert.ok(routed.routedAt);
      const filed = (await storage.getTask(routed.routedTaskId!))!;
      assert.equal(filed.title, 'Secure session cookie');
      assert.equal(filed.taintedAt, null, 'a trusted huddle files trusted work');
      await assert.rejects(
        openHuddle(storage, o, { subject: { kind: 'message', id: decision.id }, roles: ['qa', 'dev'], openedBy: 'director', actor: 'test' }),
        /not huddled again/,
      );
    } finally {
      await storage.setSetting('agent.resumeContextCap', 300_000);
    }
  });

  test('a huddle runs at most max_turns shifts: no decision → expired with the server’s line', async () => {
    const o = await office();
    await director(o);
    await role(o, { key: 'qa' });
    await role(o, { key: 'dev' });
    const t = await task('Slow search');
    const h = await openHuddle(storage, o, { subject: { kind: 'task', id: t.id }, roles: ['qa', 'dev'], maxTurns: 2, openedBy: 'stakeholder', actor: 'human' });
    await turn(o, { huddle: { say: 'Index is missing.' } });
    // the last turn says nothing usable: the server notes it and closes the huddle
    await turn(o, {});
    const closed = (await storage.getHuddle(h.id))!;
    assert.equal(closed.status, 'expired');
    assert.equal(closed.turns, 2);
    assert.match(closed.decision ?? '', /^No decision: the last turn \(2\) ended without a decision/);
    // the cap holds even against a direct step
    assert.equal(await storage.stepHuddle(h.id), null);
    const more = await huddles.advance(o);
    assert.ok(!more.some((a) => a.kind === 'started'));
    const shifts = (await storage.listShifts({ officeId: o.id, triggerKind: 'huddle' })).filter((s) => s.trigger.ref?.startsWith(`huddle:${h.id}#`));
    assert.equal(shifts.length, 2);
    const view = (await app.inject({ method: 'GET', url: `/api/offices/${o.id}/huddles` })).json() as OfficeHuddlesResponse;
    const entries = view.huddles.find((x) => x.id === h.id)!.entries;
    assert.deepEqual(
      entries.map((e) => e.kind),
      ['turn', 'server'],
    );
    assert.match(entries[1].text, /said nothing — it returned no `huddle` section/);
    // no decision: nothing for the Director to route
    assert.equal((await storage.listOfficeMessages({ officeId: o.id, unrouted: true })).length, 0);
  });

  test('in production the next turn starts as soon as one ends', async () => {
    const o = await office();
    await director(o);
    await role(o, { key: 'qa' });
    await role(o, { key: 'dev' });
    const t = await task('Chained turns');
    const chained = new HuddleRunner({ storage, shifts: () => runner });
    try {
      const h = await openHuddle(storage, o, { subject: { kind: 'task', id: t.id }, roles: ['qa', 'dev'], maxTurns: 2, openedBy: 'stakeholder', actor: 'human' });
      const spawns = sessions.spawned.length;
      const out = await chained.advance(o);
      assert.ok(out.some((a) => a.kind === 'started'));
      const first = await spawnedNth(spawns + 1);
      await stop(first.runId, result({ huddle: { say: 'one' } }));
      // nobody calls advance: the runner chains the second turn by itself
      const second = await spawnedNth(spawns + 2);
      assert.match(promptOf(second.args), /turn 2 of 2/);
      await stop(second.runId, result({ huddle: { say: 'two', decision: 'Ship it.' } }));
      for (let i = 0; i < 200 && (await storage.getHuddle(h.id))!.status === 'open'; i++) await new Promise((r) => setTimeout(r, 5));
      assert.equal((await storage.getHuddle(h.id))!.status, 'decided');
    } finally {
      chained.stop();
    }
  });
});

describe('taint', () => {
  test('a tainted participant taints the huddle, every turn, the decision and the work filed from it', async () => {
    const o = await office();
    await director(o);
    // web tools: this role's shifts read the outside world
    await role(o, { key: 'scout', tools: ['Read', 'Glob', 'Grep', 'WebFetch'] });
    await role(o, { key: 'dev' });
    const t = await task('Upgrade the SDK');
    const h = await openHuddle(storage, o, { subject: { kind: 'task', id: t.id }, roles: ['dev', 'scout'], maxTurns: 2, openedBy: 'stakeholder', actor: 'human' });
    assert.ok(h.taintedAt, 'tainted at open');
    const opened = (await storage.listEvents({ kind: 'office.huddle', limit: 50 })).find((e) => (e.data as { huddleId?: string }).huddleId === h.id);
    assert.ok(((opened!.data as { taintSources: string[] }).taintSources ?? []).some((s) => /scout:web-tool/.test(s)));

    const a = await turn(o, { huddle: { say: 'The SDK changelog says v5 drops Node 18.' } });
    const b = await turn(o, { huddle: { say: 'Then upgrade with Node 20.', decision: 'Upgrade the SDK to v5 and bump Node to 20.' } });
    for (const s of [a, b]) {
      const row = (await storage.getShift(s.shiftId))!;
      assert.equal(row.tainted, true);
      assert.ok(row.taintSources.includes(`tainted-huddle:${h.id}`), row.taintSources.join(', '));
    }
    const lines = await storage.listOfficeMessages({ officeId: o.id, subject: { kind: 'huddle', id: h.id } });
    assert.ok(lines.every((m) => m.taintedAt !== null), 'every transcript line and the decision are untrusted');
    const decision = lines.find((m) => m.toRoleId !== null)!;
    assert.ok(decision.taintedAt);

    // the Director routes it on the digest: the task it files is tainted (a draft)
    let done: Promise<unknown> | null = null;
    const spawns = sessions.spawned.length;
    const wake = await wakeChannelRouting(
      {
        storage,
        now: Date.now() + OFFICE_ROUTE_DEBOUNCE_MS + 1_000,
        start: async (oo, rr, tt) => {
          const s = await runner.start(oo, rr, tt);
          if (s.ok) done = s.done;
          return s;
        },
      },
      o,
    );
    assert.ok(wake?.ok, JSON.stringify(wake));
    const sp = await spawnedNth(spawns + 1);
    assert.doesNotMatch(promptOf(sp.args), /bump Node to 20/, 'the Director sees a tainted decision only as a digest');
    await stop(sp.runId, result({ routes: [{ messageId: decision.id, action: 'task', task: { repoId, title: 'Upgrade SDK to v5', description: 'Per the huddle.' } }] }));
    await done!;
    const filed = (await storage.getTask((await storage.getOfficeMessage(decision.id))!.routedTaskId!))!;
    assert.ok(filed.taintedAt, 'work filed from a tainted decision is tainted');
    assert.equal(filed.status, 'draft');
  });

  test('a turn that becomes tainted mid-way taints the huddle before it speaks, and every turn after it', async () => {
    const o = await office();
    await director(o);
    const qa = await role(o, { key: 'qa' });
    await role(o, { key: 'dev' });
    const t = await task('Flaky upload');
    const h = await openHuddle(storage, o, { subject: { kind: 'task', id: t.id }, roles: ['qa', 'dev'], maxTurns: 3, openedBy: 'stakeholder', actor: 'human' });
    assert.equal(h.taintedAt, null);
    const a = await turn(o, { huddle: { say: 'Fails 1 in 10.' } });
    assert.equal((await storage.getShift(a.shiftId))!.tainted, false);
    // dev's turn is still trusted
    const b = await turn(o, { huddle: { say: 'Retry is missing.' } });
    assert.equal((await storage.getShift(b.shiftId))!.tainted, false);
    // qa's notes were written by a tainted shift since: its next turn is tainted, and so is the huddle from then on
    await storage.updateOfficeRole(qa.id, { notesTaintedAt: new Date().toISOString() });
    const c = await turn(o, { huddle: { say: 'Add a retry.', decision: 'Add a retry with backoff to the upload.' } });
    assert.equal((await storage.getShift(c.shiftId))!.tainted, true);
    const closed = (await storage.getHuddle(h.id))!;
    assert.ok(closed.taintedAt);
    assert.equal(closed.status, 'decided');
    const lines = await storage.listOfficeMessages({ officeId: o.id, subject: { kind: 'huddle', id: h.id } });
    assert.deepEqual(
      lines.map((m) => m.taintedAt !== null),
      [false, false, true, true],
      'earlier lines stay trusted; the tainted turn and the decision are not',
    );
    assert.ok((await storage.listEvents({ kind: 'office.huddle', limit: 100 })).some((e) => (e.data as { huddleId?: string; phase?: string }).huddleId === h.id && (e.data as { phase?: string }).phase === 'tainted'));
  });
});
