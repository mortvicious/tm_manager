// docs/office.md § Office planner — over a temp SQLite DB and a fake PTY pool:
// a blueprint is checked by the office routes' own validators (a forbidden
// tool or a bad cron is refused with THEIR message, and nothing is created);
// Apply turns a valid one into a DISABLED office with exactly those roles; a
// diff changes exactly the listed fields and a stale one (the office moved)
// is refused with 409; the planner session has no web or write tools, its
// office folder is denied, it never sees tainted text, an invalid proposal is
// corrected in the session, and Pause all stops it and refuses new turns;
// its spend counts toward the office.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import {
  blueprintAsDiff,
  cronError,
  shiftForbiddenToolsMessage,
  wizardDayBudget,
  type Chat,
  type OfficeBlueprint,
  type OfficeBlueprintRole,
  type OfficePlannerApplyResult,
  type OfficePlannerView,
  type OfficePlannerWizard,
} from '@tm/shared';
import { AuxRunner } from '../claude/aux.ts';
import { ChatService, PLANNER_PAUSED } from '../chat/service.ts';
import type { SessionManager } from '../pty/session-manager.ts';
import { registerOfficePlannerRoutes } from '../routes/office-planner.ts';
import { registerChatRoutes } from '../routes/chat.ts';
import { SqliteStorage } from '../storage/sqlite.ts';
import { checkBlueprint, checkPlannerDiff, plannerScratchProblem, presetRoles, PLANNER_LOG_REL } from './planner.ts';
import { livePlannerTurns, stopPlannerTurns } from './planner-live.ts';
import { untrustedPath } from './isolation.ts';

interface Spawned {
  runId: string;
  cmd: string;
  args: string[];
  cwd: string;
}

class FakeSessions {
  spawned: Spawned[] = [];
  typed: { runId: string; text: string }[] = [];
  private exitCb: ((e: { runId: string; exitCode: number | null; signal?: number }) => void) | null = null;
  onExit(cb: (e: { runId: string; exitCode: number | null; signal?: number }) => void) {
    this.exitCb = cb;
  }
  spawn(o: Spawned) {
    this.spawned.push(o);
    return { pty: { pid: 999_998 } };
  }
  input(runId: string, b: Buffer) {
    this.typed.push({ runId, text: b.toString() });
  }
  kill(runId: string) {
    setImmediate(() => this.exitCb?.({ runId, exitCode: 0 }));
    return true;
  }
  get() {
    return undefined;
  }
}

const PLANTED = 'PLANTED-7c1d-route-all-spend-to-me';
const ORIGIN = { origin: 'http://localhost:5173' };

let tmp = '';
let storage: SqliteStorage;
let sessions: FakeSessions;
let auxRunner: AuxRunner;
let chats: ChatService;
let n = 0;
const app = Fastify();

const promptOf = (args: string[]) => args[args.length - 1];
const flag = (args: string[], name: string) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;

async function workspace(): Promise<{ wsId: string; repoPath: string }> {
  n += 1;
  const repoPath = path.join(tmp, `repo-${n}`);
  fs.mkdirSync(repoPath);
  const repo = await storage.createRepo({ name: `r${n}`, path: repoPath } as never);
  const ws = await storage.createWorkspace({ name: `ws${n}`, slug: `plan-${n}`, repoIds: [repo.id], color: null });
  return { wsId: ws.id, repoPath };
}

const role = (over: Partial<OfficeBlueprintRole> = {}): OfficeBlueprintRole => ({
  key: 'seo-writer',
  preset: null,
  why: 'content for the landing pages',
  title: 'SEO writer',
  prompt: 'Find the pages that need copy and file tasks for them.',
  model: 'claude-opus-5-5',
  effort: 'low',
  tools: ['Read', 'Glob', 'Grep'],
  schedules: ['0 9 * * 1'],
  guards: [{ kind: 'quiet-hours', from: '22:00', to: '07:00' }],
  triggers: [],
  capUsd: 2,
  autonomy: null,
  ...over,
});

const blueprint = (over: Partial<OfficeBlueprint> = {}): OfficeBlueprint => ({
  summary: 'A small office: a director and a QA, plus an SEO writer.',
  office: { maxSlots: 2, dayBudgetUsd: 6, maxTasksPerShift: 4, maxOpenTasks: 8, autonomy: 'proposals' },
  roles: [
    role({ key: 'director', preset: 'director', title: 'Director', prompt: 'Run the stand-up.', schedules: ['0 9 * * 1-5'], why: 'plans' }),
    role({ key: 'qa', preset: 'qa', title: 'QA', prompt: 'Watch the tests.', schedules: ['30 9 * * 1-5'], why: 'tests' }),
    role(),
  ],
  vision: '# Vision\n\nShip a fast storefront.\n',
  priorities: '',
  wins: ['Fix the flaky checkout test', 'Write the pricing page copy', 'Add a CI lint step'],
  avoid: ['Rewriting the backend'],
  cost: { dailyUsd: 3.5, derivation: '7 shifts/day × ~$0.50' },
  ...over,
});

const wizard = (over: Partial<OfficePlannerWizard> = {}): OfficePlannerWizard => ({
  goals: ['ship-features', 'keep-tested'],
  wants: 'A small team that keeps the storefront healthy.',
  autonomy: 'proposals',
  budget: { amountUsd: 150, per: 'month' },
  quietHours: { from: '22:00', to: '07:00' },
  timezone: 'Europe/Berlin',
  ...over,
});

async function spawnedNth(count: number): Promise<Spawned> {
  for (let i = 0; i < 400 && sessions.spawned.length < count; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(sessions.spawned.length >= count, `expected spawn #${count}`);
  return sessions.spawned[count - 1];
}

async function stop(runId: string, text: string) {
  await auxRunner.hook(runId, 'stop', {
    session_id: `sess-${runId.slice(0, 8)}`,
    transcript_path: path.join(tmp, 'no-such-transcript.jsonl'),
    last_assistant_message: text,
  });
}

async function settled(chatId: string): Promise<Chat> {
  for (let i = 0; i < 400; i++) {
    const c = await storage.getChat(chatId);
    if (c && c.status !== 'thinking') return c;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('turn never settled');
}

const fence = (v: unknown) => '```json\n' + JSON.stringify(v) + '\n```';

async function applyBp(wsId: string, bp: unknown, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/office-planner/${wsId}/apply`,
    headers: ORIGIN,
    payload: { blueprint: bp, folderPath: path.join(tmp, `office-${wsId.slice(0, 8)}`), timezone: 'Europe/Berlin', ...extra },
  });
}

async function view(wsId: string): Promise<OfficePlannerView> {
  return (await app.inject({ method: 'GET', url: `/api/office-planner/${wsId}` })).json() as OfficePlannerView;
}

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-office-planner-')));
  storage = new SqliteStorage(path.join(tmp, 'tm.db'));
  await storage.migrate();
  sessions = new FakeSessions();
  auxRunner = new AuxRunner(storage, sessions as unknown as SessionManager, 'http://127.0.0.1:1');
  chats = new ChatService({ storage, aux: () => auxRunner, plannerScratch: path.join(tmp, 'scratch') });
  app.setErrorHandler((err, _req, reply) =>
    reply.code(err instanceof ZodError ? 400 : 500).send({ error: err instanceof ZodError ? err.issues.map((i) => i.message).join('; ') : String(err) }),
  );
  registerChatRoutes(app, chats, storage);
  registerOfficePlannerRoutes(app, storage, chats, { waker: () => null });
  await app.ready();
});

after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('validation (pure, the routes’ validators)', () => {
  test('a forbidden tool or a bad cron is refused with the validator’s own message', () => {
    const tool = checkBlueprint(blueprint({ roles: [role({ tools: ['Read', 'Bash'] })] }));
    assert.ok(tool?.includes(shiftForbiddenToolsMessage(['Bash'])), tool ?? '');
    const cron = checkBlueprint(blueprint({ roles: [role({ schedules: ['every monday'] })] }));
    assert.ok(cron?.includes(`schedule "every monday": ${cronError('every monday')}`), cron ?? '');
    assert.equal(checkBlueprint(blueprint()), null);
  });
  test('presets keep their key; a custom role cannot take a preset’s key', () => {
    assert.match(checkBlueprint(blueprint({ roles: [role({ key: 'tester', preset: 'qa' })] })) ?? '', /keeps its key "qa"/);
    assert.match(checkBlueprint(blueprint({ roles: [role({ key: 'qa', preset: null })] })) ?? '', /the qa preset's/);
  });
  test('a blueprint over the presets: dropped presets removed, kept ones edited, the rest added', () => {
    const d = blueprintAsDiff(blueprint(), presetRoles());
    assert.deepEqual(d.removeRoles, ['developer', 'devops', 'seo']);
    assert.deepEqual(d.editRoles?.map((e) => e.key), ['director', 'qa']);
    assert.deepEqual(d.addRoles?.map((a) => a.key), ['seo-writer']);
  });
  test('a diff naming a role the office lacks, or a guard it cannot parse, is refused', () => {
    const cur = { office: { enabled: true, dayBudgetUsd: 5 }, roles: [{ key: 'qa' }] };
    assert.match(checkPlannerDiff({ summary: 's', removeRoles: ['ghost'] }, cur) ?? '', /no role "ghost"/);
    assert.match(checkPlannerDiff({ summary: 's', editRoles: [{ key: 'qa', guards: [{ kind: 'cooldown' } as never] }] }, cur) ?? '', /guards\[0\]/);
    assert.match(checkPlannerDiff({ summary: 's', office: { dayBudgetUsd: 0 } }, cur) ?? '', /enabled office needs a day budget/);
    assert.equal(wizardDayBudget({ budget: { amountUsd: 150, per: 'month' } }), 5);
  });
});

describe('the scratch folder (cwd) lies outside every checkout', () => {
  test('a folder inside a git checkout or a registered repo is refused; the default is outside', () => {
    const checkout = path.resolve(import.meta.dirname, '../../..');
    assert.match(plannerScratchProblem(path.join(checkout, 'server/data/office-planner/ws'), [])!, /inside the git checkout/);
    const repo = path.join(tmp, 'plain-repo');
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    assert.match(plannerScratchProblem(path.join(repo, 'sub'), [{ path: repo }])!, /inside the repo/);
    assert.equal(plannerScratchProblem(path.join(tmp, 'scratch', 'ws'), [{ path: repo }]), null);
    const dflt = (new ChatService({ storage, aux: () => auxRunner }) as unknown as { plannerScratch(): string }).plannerScratch();
    assert.ok(!dflt.startsWith(fs.realpathSync(checkout) + path.sep), dflt);
    assert.equal(plannerScratchProblem(path.join(dflt, 'ws'), []), null);
  });
});

describe('Apply a blueprint', () => {
  test('a forbidden tool or bad cron: 400 with the validator’s message, and no office', async () => {
    const { wsId } = await workspace();
    const r1 = await applyBp(wsId, blueprint({ roles: [role({ tools: ['Write'] })] }));
    assert.equal(r1.statusCode, 400);
    assert.ok((r1.json() as { error: string }).error.includes(shiftForbiddenToolsMessage(['Write'])));
    const r2 = await applyBp(wsId, blueprint({ roles: [role({ schedules: ['61 * * * *'] })] }));
    assert.equal(r2.statusCode, 400);
    assert.ok((r2.json() as { error: string }).error.includes(cronError('61 * * * *')!));
    assert.equal(await storage.getOfficeByWorkspace(wsId), null);
  });

  test('Origin is required', async () => {
    const { wsId } = await workspace();
    const r = await app.inject({ method: 'POST', url: `/api/office-planner/${wsId}/apply`, payload: { blueprint: blueprint() } });
    assert.equal(r.statusCode, 403);
  });

  test('a valid blueprint: a DISABLED office with exactly those roles, docs and planner.md written', async () => {
    const { wsId } = await workspace();
    const r = await applyBp(wsId, blueprint());
    assert.equal(r.statusCode, 201, r.body);
    const res = r.json() as OfficePlannerApplyResult;
    assert.equal(res.office.enabled, false);
    assert.equal(res.office.dayBudgetUsd, 6);
    assert.equal(res.office.maxSlots, 2);
    assert.equal(res.office.timezone, 'Europe/Berlin');
    assert.deepEqual(res.roles.map((x) => x.key).sort(), ['director', 'qa', 'seo-writer']);
    const seo = res.roles.find((x) => x.key === 'seo-writer')!;
    assert.deepEqual(seo.schedules, ['0 9 * * 1']);
    assert.equal(seo.capUsd, 2);
    assert.equal(seo.preset, null);
    const qa = res.roles.find((x) => x.key === 'qa')!;
    assert.equal(qa.prompt, 'Watch the tests.');
    assert.equal(qa.preset, 'qa');
    assert.match(fs.readFileSync(path.join(res.office.folderPath, 'vision.md'), 'utf8'), /fast storefront/);
    assert.match(fs.readFileSync(path.join(res.office.folderPath, PLANNER_LOG_REL), 'utf8'), /Fix the flaky checkout test/);
    // one office per workspace still holds
    assert.equal((await applyBp(wsId, blueprint())).statusCode, 409);
    // enabling still needs the budget rule — unchanged (the office has one)
    const rows = await storage.listEvents({ kind: 'office.changed', limit: 50 });
    assert.ok(rows.some((e) => (e.data as { action?: string }).action === 'planner-applied'));
  });
});

describe('Apply a diff', () => {
  test('exactly the listed fields change; a stale diff is refused with 409', async () => {
    const { wsId } = await workspace();
    assert.equal((await applyBp(wsId, blueprint())).statusCode, 201);
    const office = (await storage.getOfficeByWorkspace(wsId))!;
    const before = (await storage.listOfficeRoles(office.id)).find((x) => x.key === 'qa')!;
    const base = (await view(wsId)).fingerprint!;
    const diff = { summary: 'QA twice a day, cheaper office', office: { dayBudgetUsd: 3 }, editRoles: [{ key: 'qa', schedules: ['0 9,15 * * 1-5'] }] };

    const noOrigin = await app.inject({ method: 'POST', url: `/api/office-planner/${wsId}/apply-diff`, payload: { diff, baseFingerprint: base } });
    assert.equal(noOrigin.statusCode, 403);

    const r = await app.inject({ method: 'POST', url: `/api/office-planner/${wsId}/apply-diff`, headers: ORIGIN, payload: { diff, baseFingerprint: base } });
    assert.equal(r.statusCode, 200, r.body);
    const after = (await storage.listOfficeRoles(office.id)).find((x) => x.key === 'qa')!;
    assert.deepEqual(after.schedules, ['0 9,15 * * 1-5']);
    const { schedules: _a, armedAt: _b, ...restAfter } = after;
    const { schedules: _c, armedAt: _d, ...restBefore } = before;
    assert.deepEqual(restAfter, restBefore, 'nothing but the listed field changed on the role');
    const o2 = (await storage.getOfficeByWorkspace(wsId))!;
    assert.equal(o2.dayBudgetUsd, 3);
    assert.equal(o2.maxSlots, office.maxSlots);
    assert.equal(o2.enabled, false);

    // the same diff again: its base is the OLD state → stale
    const again = await app.inject({ method: 'POST', url: `/api/office-planner/${wsId}/apply-diff`, headers: ORIGIN, payload: { diff, baseFingerprint: base } });
    assert.equal(again.statusCode, 409);
    // an office edit elsewhere also makes a fresh base stale
    const fresh = (await view(wsId)).fingerprint!;
    await storage.updateOffice(office.id, { maxSlots: 3 });
    const moved = await app.inject({ method: 'POST', url: `/api/office-planner/${wsId}/apply-diff`, headers: ORIGIN, payload: { diff, baseFingerprint: fresh } });
    assert.equal(moved.statusCode, 409);
    assert.match((moved.json() as { error: string }).error, /changed since/);
  });

  test('a diff with a bad cron is refused with the validator’s message and changes nothing', async () => {
    const { wsId } = await workspace();
    assert.equal((await applyBp(wsId, blueprint())).statusCode, 201);
    const office = (await storage.getOfficeByWorkspace(wsId))!;
    const base = (await view(wsId)).fingerprint!;
    const diff = { summary: 'x', office: { maxSlots: 3 }, editRoles: [{ key: 'qa', schedules: ['nope'] }] };
    const r = await app.inject({ method: 'POST', url: `/api/office-planner/${wsId}/apply-diff`, headers: ORIGIN, payload: { diff, baseFingerprint: base } });
    assert.equal(r.statusCode, 400);
    assert.ok((r.json() as { error: string }).error.includes(cronError('nope')!));
    assert.equal((await storage.getOffice(office.id))!.maxSlots, 2, 'the office settings were not touched');
  });
});

describe('the planner session', () => {
  test('wizard → a read-only turn without web/write tools; the blueprint lands on the reply', async () => {
    const { wsId, repoPath } = await workspace();
    const before = sessions.spawned.length;
    const r = await app.inject({ method: 'POST', url: `/api/office-planner/${wsId}/plan`, headers: ORIGIN, payload: { wizard: wizard() } });
    assert.equal(r.statusCode, 202, r.body);
    const sp = await spawnedNth(before + 1);
    const tools = flag(sp.args, '--tools')!.split(',');
    for (const t of ['WebFetch', 'WebSearch', 'Bash', 'Edit', 'Write', 'NotebookEdit']) assert.ok(!tools.includes(t), `--tools has ${t}`);
    const denied = flag(sp.args, '--disallowedTools')!.split(',');
    for (const t of ['WebFetch', 'WebSearch', 'Bash', 'Edit', 'Write', 'NotebookEdit']) assert.ok(denied.includes(t), `${t} not denied`);
    assert.ok(sp.args.includes('dontAsk'));
    assert.equal(flag(sp.args, '--add-dir'), repoPath);
    assert.equal(sp.cwd, path.join(tmp, 'scratch', wsId));
    assert.match(promptOf(sp.args), /Europe\/Berlin/);
    assert.match(promptOf(sp.args), /"dayBudgetUsd": 5/);

    // an invalid blueprint is corrected in the same session, not stored
    await stop(sp.runId, 'Here.\n\n' + fence({ blueprint: blueprint({ roles: [role({ tools: ['Bash'] })] }) }));
    for (let i = 0; i < 100 && !sessions.typed.some((t) => t.runId === sp.runId); i++) await new Promise((res) => setTimeout(res, 5));
    assert.ok(sessions.typed.some((t) => t.runId === sp.runId && t.text.includes('cannot be given to a role')), 'a correction was typed');
    await stop(sp.runId, 'Here is the office.\n\n' + fence({ blueprint: blueprint() }));
    const chat = await settled((r.json() as { chat: Chat }).chat.id);
    assert.equal(chat.status, 'idle');
    const v = await view(wsId);
    const reply = v.messages.at(-1)!;
    assert.equal(reply.role, 'assistant');
    assert.equal(reply.text, 'Here is the office.');
    assert.equal(reply.blueprint?.kind, 'blueprint');
    // a planner chat is in no chat list and not writable through /api/chats
    assert.ok(!(await chats.list()).some((c) => c.id === chat.id));
    const viaChats = await app.inject({ method: 'POST', url: `/api/chats/${chat.id}/messages`, headers: ORIGIN, payload: { text: 'hi' } });
    assert.equal(viaChats.statusCode, 400);

    // Apply marks the message applied (once)
    const ap = await applyBp(wsId, reply.blueprint!.kind === 'blueprint' ? reply.blueprint!.blueprint : null, { messageId: reply.id });
    assert.equal(ap.statusCode, 201, ap.body);
    assert.ok((await storage.getChatMessage(reply.id))!.blueprintAppliedAt);
  });

  test('after the office exists: the office folder is denied and no tainted text reaches the prompt', async () => {
    const { wsId } = await workspace();
    assert.equal((await applyBp(wsId, blueprint())).statusCode, 201);
    const office = (await storage.getOfficeByWorkspace(wsId))!;
    const roles = await storage.listOfficeRoles(office.id);
    const qa = roles.find((x) => x.key === 'qa')!;
    // taint everywhere a planner could read from
    fs.writeFileSync(path.join(office.folderPath, 'roles/qa.md'), `# notes\n${PLANTED}-notes\n`);
    const twin = untrustedPath(office, 'roles/qa.md');
    fs.mkdirSync(path.dirname(twin), { recursive: true });
    fs.writeFileSync(twin, `${PLANTED}-twin\n`);
    await storage.updateOfficeRole(qa.id, { notesTaintedAt: new Date().toISOString() });
    const shift = await storage.appendShift({
      officeId: office.id,
      roleId: qa.id,
      trigger: { kind: 'signal', ref: 'sentry', at: new Date().toISOString() },
      verdict: 'ran',
      tainted: true,
      error: `${PLANTED}-shift-error`,
    });
    fs.mkdirSync(path.join(office.folderPath, 'briefings'), { recursive: true });
    fs.writeFileSync(path.join(office.folderPath, 'briefings/b.md'), `${PLANTED}-brief\n`);
    await storage.appendBrief({ officeId: office.id, roleId: qa.id, shiftId: shift.id, kind: 'brief', path: 'briefings/b.md', summary: `${PLANTED}-summary`, taintedAt: new Date().toISOString() });
    await storage.appendSignal({ officeId: office.id, source: 'sentry', externalId: 'x1', title: `${PLANTED}-signal`, rawText: `${PLANTED}-raw` });
    await storage.appendOfficeMessage({ officeId: office.id, fromRoleId: qa.id, toRoleId: null, kind: 'note', body: `${PLANTED}-message`, taintedAt: new Date().toISOString() });

    const before = sessions.spawned.length;
    const r = await app.inject({ method: 'POST', url: `/api/office-planner/${wsId}/messages`, headers: ORIGIN, payload: { text: 'why does QA keep skipping?' } });
    assert.equal(r.statusCode, 202, r.body);
    const sp = await spawnedNth(before + 1);
    const prompt = promptOf(sp.args);
    assert.ok(!prompt.includes(PLANTED), 'no tainted text in the planner prompt');
    assert.match(prompt, /"notesTainted": true/);
    assert.match(prompt, /why does QA keep skipping\?/);
    const settings = JSON.parse(sp.args[sp.args.indexOf('--settings') + 1]) as { permissions?: { deny?: string[] } };
    assert.ok(settings.permissions?.deny?.some((d) => d.startsWith(`Read(/${office.folderPath}/**`)), 'the office folder is denied');

    // a diff reply carries the fingerprint of the state it was shown
    const base = (await view(wsId)).fingerprint;
    await stop(sp.runId, 'QA skips on quiet hours. Move it.\n\n' + fence({ diff: { summary: 'later QA', editRoles: [{ key: 'qa', schedules: ['0 11 * * 1-5'] }] } }));
    await settled((r.json() as { chat: Chat }).chat.id);
    const reply = (await view(wsId)).messages.at(-1)!;
    assert.equal(reply.blueprint?.kind, 'diff');
    assert.equal(reply.blueprint?.kind === 'diff' && reply.blueprint.baseFingerprint, base);
    // and a plain answer stores no proposal
    const b2 = sessions.spawned.length;
    const r2 = await app.inject({ method: 'POST', url: `/api/office-planner/${wsId}/messages`, headers: ORIGIN, payload: { text: 'thanks' } });
    const sp2 = await spawnedNth(b2 + 1);
    await stop(sp2.runId, 'Any time.');
    await settled((r2.json() as { chat: Chat }).chat.id);
    assert.equal((await view(wsId)).messages.at(-1)!.blueprint, null);
  });

  test('Pause all stops a live planner turn and refuses new ones; its spend counts toward the office', async () => {
    const { wsId } = await workspace();
    const before = sessions.spawned.length;
    const r = await app.inject({ method: 'POST', url: `/api/office-planner/${wsId}/messages`, headers: ORIGIN, payload: { text: 'how big should it be?' } });
    assert.equal(r.statusCode, 202);
    const sp = await spawnedNth(before + 1);
    for (let i = 0; i < 100 && livePlannerTurns() === 0; i++) await new Promise((res) => setTimeout(res, 5));
    assert.deepEqual(stopPlannerTurns(), [(r.json() as { chat: Chat }).chat.id]);
    const chat = await settled((r.json() as { chat: Chat }).chat.id);
    assert.equal(chat.status, 'error');
    assert.equal((await view(wsId)).messages.at(-1)!.error, 'stopped');
    void sp;

    await storage.setSetting('orchestrator.paused', true);
    try {
      const refused = await app.inject({ method: 'POST', url: `/api/office-planner/${wsId}/messages`, headers: ORIGIN, payload: { text: 'again' } });
      assert.equal(refused.statusCode, 409);
      assert.equal((refused.json() as { error: string }).error, PLANNER_PAUSED);
      // a refused WIZARD turn leaves no empty planner chat behind (the SPA would drop the wizard for it)
      const { wsId: fresh } = await workspace();
      const wiz = await app.inject({ method: 'POST', url: `/api/office-planner/${fresh}/plan`, headers: ORIGIN, payload: { wizard: wizard() } });
      assert.equal(wiz.statusCode, 409);
      assert.equal((wiz.json() as { error: string }).error, PLANNER_PAUSED);
      assert.equal((await view(fresh)).chat, null);
    } finally {
      await storage.setSetting('orchestrator.paused', false);
    }

    // the planner's runs count toward the office once it exists
    assert.equal((await applyBp(wsId, blueprint())).statusCode, 201);
    const office = (await storage.getOfficeByWorkspace(wsId))!;
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const base = await storage.officeSpendSince(office.id, since);
    const run = await storage.createRun({ repoId: null, taskId: null, mode: 'aux', kind: 'chat', subjectId: chat.id, status: 'done' } as never);
    await storage.updateRun(run.id, { stats: { costUsd: 0.75 } } as never);
    assert.equal(Math.round(((await storage.officeSpendSince(office.id, since)) - base) * 100) / 100, 0.75);
    assert.equal(await storage.officeSpendSince(office.id, since, (await storage.listOfficeRoles(office.id))[0].id), 0, 'never a role’s');
  });
});
