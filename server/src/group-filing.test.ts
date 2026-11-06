// Group decisions for non-human filings (docs/grouping.md § Agent filings):
// the agent API's join/new/ungrouped + defaults, name dedup (incl. a race),
// trust/reach refusals, GET /api/agent/groups, and the server-side creators
// (job follow-ups, feature approval). Real sqlite in a temp dir.
// Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { isSplitChild, normalizeGroupName, pickNamedGroup, type FeaturePlan, type Job, type NamedGroupCandidate, type Repo, type Task } from '@tm/shared';
import { registerAgentRoutes } from './routes/agent.ts';
import { SqliteStorage } from './storage/sqlite.ts';
import { fileJobFollowUp } from './jobs.ts';
import type { Orchestrator } from './orchestrator.ts';
import type { CommandRunner } from './commands/runner.ts';

describe('pure: normalizeGroupName / pickNamedGroup', () => {
  test('case, whitespace and punctuation do not matter', () => {
    assert.equal(normalizeGroupName('  Orders  API — v2! '), normalizeGroupName('orders api v2'));
    assert.notEqual(normalizeGroupName('orders api v2'), normalizeGroupName('orders api v3'));
  });
  const c = (over: Partial<NamedGroupCandidate> = {}): NamedGroupCandidate => ({
    rootId: 'r1', name: 'Orders', rootStatus: 'queued', rootWaiting: false, members: 2, open: 1, untrusted: 0, createdAt: '2026-11-01', ...over,
  });
  const key = normalizeGroupName('orders');
  test('open, joinable, same trust → picked; oldest wins', () => {
    assert.equal(pickNamedGroup([c({ rootId: 'b', createdAt: '2026-11-02' }), c({ rootId: 'a' })], key, false)?.rootId, 'a');
  });
  test('finished, blocked split root, full, other trust → skipped', () => {
    assert.equal(pickNamedGroup([c({ open: 0 })], key, false), null);
    assert.equal(pickNamedGroup([c({ rootStatus: 'blocked' })], key, false), null);
    assert.ok(pickNamedGroup([c({ rootStatus: 'blocked', rootWaiting: true })], key, false), 'a waiting worker is not a split parent');
    assert.equal(pickNamedGroup([c({ members: 40 })], key, false), null);
    assert.equal(pickNamedGroup([c({ untrusted: 1 })], key, false), null, 'trusted filer, mixed group');
    assert.equal(pickNamedGroup([c()], key, true), null, 'untrusted filer, trusted group');
    assert.ok(pickNamedGroup([c({ untrusted: 2 })], key, true), 'untrusted filer, all-untrusted group');
  });
});

describe('agent filings over the API', () => {
  let tmp: string;
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let r1: Repo, r2: Repo, r3: Repo;
  let tok = 0;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-group-filing-'));
    storage = new SqliteStorage(path.join(tmp, 'tm.db'));
    await storage.migrate();
    r1 = await storage.createRepo({ name: 'r1', path: path.join(tmp, 'r1') });
    r2 = await storage.createRepo({ name: 'r2', path: path.join(tmp, 'r2') });
    r3 = await storage.createRepo({ name: 'r3', path: path.join(tmp, 'r3') }); // outside every reach below
    await storage.createWorkspace({ name: 'W', slug: 'w', repoIds: [r1.id, r2.id], color: null });
    app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof ZodError) return reply.code(400).send({ error: err.issues.map((i) => i.message).join('; ') });
      return reply.code(500).send({ error: String(err) });
    });
    const orchestrator = { maybeSchedule() {}, deliverDispatches: async () => {} } as unknown as Orchestrator;
    const commands = { runningFor: () => null } as unknown as CommandRunner;
    registerAgentRoutes(app, storage, orchestrator, commands);
    await app.ready();
  });
  after(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A running worker session on a fresh task (or `task`), returning its token. */
  async function session(repo: Repo, task?: Task, over: Partial<Parameters<SqliteStorage['createTask']>[0]> = {}) {
    const t = task ?? (await storage.createTask({ title: `worker ${++tok}`, repoId: repo.id, status: 'running', ...over }, 'test'));
    const token = `tok-${++tok}`;
    const run = await storage.createRun({ taskId: t.id, repoId: repo.id, mode: 'worker', runToken: token });
    return { token, task: t, run };
  }
  const file = (token: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/agent/tasks',
      headers: { 'x-tm-token': token },
      payload: { title: `filed ${++tok}`, brief: 'Does the thing.', repo: 'r1', ...body },
    });
  const groupEvent = async (taskId: string) =>
    (await storage.listEvents({ kind: 'agent.create', limit: 500 })).find((e) => e.taskId === taskId)?.data?.group as Record<string, unknown>;

  test('new → a named root; a second new of the same name (normalised) joins it', async () => {
    const s = await session(r1);
    const a = await file(s.token, { group: { new: 'Orders API v2' } });
    assert.equal(a.statusCode, 200, a.body);
    const aj = a.json();
    assert.equal(aj.group.decision, 'new');
    const rootA = (await storage.getTask(aj.task.id))!;
    assert.equal(rootA.groupName, 'Orders API v2');
    assert.equal(rootA.groupId, rootA.id);
    assert.equal((await groupEvent(rootA.id)).decision, 'new');

    const s2 = await session(r1);
    const b = (await file(s2.token, { group: { new: '  orders api — V2 ' } })).json();
    assert.equal(b.group.decision, 'joined');
    assert.equal(b.group.joinedExisting, true);
    assert.equal(b.task.groupId, rootA.id);
    assert.match(b.note, /already exists — joined it/);
    const evt = await groupEvent(b.task.id);
    assert.equal(evt.joinedExisting, true);
    assert.equal(evt.groupId, rootA.id);

    const c = (await file(s2.token, { group: { new: 'orders api v2', forceNew: true } })).json();
    assert.equal(c.group.decision, 'new');
    assert.notEqual(c.task.groupId, rootA.id);
  });

  test('race: two agents filing `new` with one name at once mint ONE group', async () => {
    const [x, y] = await Promise.all([session(r1), session(r2)]);
    const [a, b] = await Promise.all([
      file(x.token, { group: { new: 'Race Group' } }),
      file(y.token, { group: { new: 'race group' } }),
    ]);
    assert.equal(a.json().task.groupId, b.json().task.groupId);
    const members = await storage.listTasks({ groupId: a.json().task.groupId });
    assert.equal(members.length, 2);
  });

  test('a finished group is not deduped onto, but an explicit join to it is allowed', async () => {
    const s = await session(r1);
    const old = (await file(s.token, { group: { new: 'Landed Work' } })).json();
    await storage.transitionTask(old.task.id, ['draft'], 'done', 'test');
    const fresh = (await file(s.token, { group: { new: 'landed work' } })).json();
    assert.equal(fresh.group.decision, 'new');
    assert.notEqual(fresh.task.groupId, old.task.groupId);
    const follow = (await file(s.token, { group: { join: old.task.id } })).json();
    assert.equal(follow.group.decision, 'joined');
    assert.equal(follow.task.groupId, old.task.groupId);
  });

  test('join by a member id lands flat under the ROOT, at the end of the run order', async () => {
    const s = await session(r1);
    const root = (await file(s.token, { group: { new: 'Flat' } })).json().task;
    const mid = (await file(s.token, { group: { join: root.id } })).json().task;
    const last = (await file(s.token, { group: { join: mid.id } })).json().task;
    const row = (await storage.getTask(last.id))!;
    assert.equal(row.parentId, root.id);
    const midRow = (await storage.getTask(mid.id))!;
    assert.ok(row.sortOrder > midRow.sortOrder);
  });

  test('ungrouped + why is audited; a second one in the repo gets the hint, never a refusal', async () => {
    const s = await session(r1);
    const a = (await file(s.token, { group: { ungrouped: 'a one-off typo fix' } })).json();
    assert.equal(a.group.decision, 'ungrouped');
    assert.equal(a.note, null);
    assert.equal((await groupEvent(a.task.id)).reason, 'a one-off typo fix');
    const b = await file(s.token, { group: { ungrouped: 'another one-off' } });
    assert.equal(b.statusCode, 200);
    assert.match(b.json().note, /second ungrouped filing.*"new"/);
    assert.match(b.json().note, new RegExp(a.task.id));
  });

  test('exactly one form; ungrouped is one line', async () => {
    const s = await session(r1);
    assert.equal((await file(s.token, { group: { join: 'x', new: 'y' } })).statusCode, 400);
    assert.equal((await file(s.token, { group: { ungrouped: 'two\nlines' } })).statusCode, 400);
  });

  describe('omitted group — the default rules', () => {
    test('(3) nothing to join → ungrouped, defaulted, with a note', async () => {
      const s = await session(r1);
      const r = (await file(s.token, {})).json();
      assert.equal(r.group.decision, 'ungrouped');
      assert.equal(r.group.defaulted, 'ungrouped');
      assert.match(r.note, /no "group" given/);
      assert.deepEqual((await groupEvent(r.task.id)).defaulted, 'ungrouped');
    });
    test('(1) the group of this run\'s previous grouped filing in the same repo', async () => {
      const s = await session(r1);
      const first = (await file(s.token, { group: { new: 'Previous Filing' } })).json();
      const r = (await file(s.token, {})).json();
      assert.equal(r.group.decision, 'joined');
      assert.equal(r.group.defaulted, 'previous-filing');
      assert.equal(r.task.groupId, first.task.groupId);
      // a different repo has no previous filing of this run
      const other = (await file(s.token, { repo: 'r2' })).json();
      assert.equal(other.group.decision, 'ungrouped');
    });
    test('(1) skips a deliberately ungrouped previous filing', async () => {
      const s = await session(r1);
      await file(s.token, { group: { ungrouped: 'solo' } });
      const r = (await file(s.token, {})).json();
      assert.equal(r.group.decision, 'ungrouped');
    });
    test('(2) the caller\'s own group when it has ≥ 2 members and a name', async () => {
      const root = await storage.createTask({ title: 'human root', repoId: r1.id, status: 'review' }, 'test');
      await storage.updateTask(root.id, { groupName: 'Checkout' });
      const own = await storage.createTask({ title: 'me', repoId: r1.id, status: 'running', parentId: root.id }, 'test');
      const s = await session(r1, own);
      const r = (await file(s.token, {})).json();
      assert.equal(r.group.decision, 'joined');
      assert.equal(r.group.defaulted, 'own-group');
      assert.equal(r.task.groupId, root.id);
      // an unnamed own group does not count
      const plain = await storage.createTask({ title: 'plain root', repoId: r1.id, status: 'review' }, 'test');
      const kid = await storage.createTask({ title: 'kid', repoId: r1.id, status: 'running', parentId: plain.id }, 'test');
      const s2 = await session(r1, kid);
      assert.equal((await file(s2.token, {})).json().group.decision, 'ungrouped');
    });
  });

  describe('reach, blocked split roots, cap, trust', () => {
    test('join outside reach → 403; a missing id → 404', async () => {
      const far = await storage.createTask({ title: 'far', repoId: r3.id, status: 'queued' }, 'test');
      const s = await session(r1);
      assert.equal((await file(s.token, { group: { join: far.id } })).statusCode, 403);
      assert.equal((await file(s.token, { group: { join: 'nope' } })).statusCode, 404);
      // a workspace repo is in reach
      const near = await storage.createTask({ title: 'near', repoId: r2.id, status: 'queued' }, 'test');
      assert.equal((await file(s.token, { group: { join: near.id } })).statusCode, 200);
    });
    test('a blocked split root refuses a join (409 suggesting new), and the default never lands under it', async () => {
      const parent = await storage.createTask({ title: 'split parent', repoId: r1.id, status: 'blocked' }, 'test');
      const child = await storage.createTask({ title: 'split child', repoId: r1.id, status: 'running', parentId: parent.id }, 'test');
      const s = await session(r1, child);
      const r = await file(s.token, { group: { join: parent.id } });
      assert.equal(r.statusCode, 409);
      assert.match(r.json().error, /blocked split parent.*"new"/);
      // the omitted default skips it too (own group is unnamed anyway) — never under the blocked parent
      const d = (await file(s.token, {})).json();
      assert.notEqual(d.task.groupId, parent.id);
    });
    test('a group of 40 refuses an agent join', async () => {
      const root = await storage.createTask({ title: 'big', repoId: r1.id, status: 'queued' }, 'test');
      for (let i = 0; i < 39; i++) await storage.createTask({ title: `m${i}`, repoId: r1.id, parentId: root.id }, 'test');
      const s = await session(r1);
      const r = await file(s.token, { group: { join: root.id } });
      assert.equal(r.statusCode, 409);
      assert.match(r.json().error, /40 members/);
    });
    test('a tainted filer never joins a trusted group — downgraded to ungrouped, not refused', async () => {
      const trusted = await storage.createTask({ title: 'trusted', repoId: r1.id, status: 'queued' }, 'test');
      await storage.updateTask(trusted.id, { groupName: 'Trusted Work' });
      const s = await session(r1, undefined, { taintedAt: new Date().toISOString(), source: 'office' });
      const r = await file(s.token, { group: { join: trusted.id } });
      assert.equal(r.statusCode, 200);
      assert.equal(r.json().group.decision, 'ungrouped');
      assert.match(r.json().note, /different trust/);
      assert.equal((await groupEvent(r.json().task.id)).downgraded !== undefined, true);
      // name dedup skips it too: a new group of its own
      const n = (await file(s.token, { group: { new: 'trusted work' } })).json();
      assert.equal(n.group.decision, 'new');
      assert.notEqual(n.task.groupId, trusted.id);
    });
    test('taint follows the filing chain: a task filed by a job follow-up\'s worker is untrusted too', async () => {
      const job = await storage.createTask({ title: 'job follow-up', repoId: r1.id, status: 'running', source: 'job' }, 'test');
      const s = await session(r1, job);
      const child = (await file(s.token, { group: { new: 'Chain Child' } })).json().task;
      // the child's own worker files again: still untrusted (two hops from the job)
      const childRow = (await storage.getTask(child.id))!;
      await storage.transitionTask(child.id, ['draft'], 'running', 'test');
      const s2 = await session(r1, childRow);
      const trusted = await storage.createTask({ title: 'human', repoId: r1.id, status: 'queued' }, 'test');
      const r = (await file(s2.token, { group: { join: trusted.id } })).json();
      assert.equal(r.group.decision, 'ungrouped');
      assert.ok((await storage.untrustedTaskIds([child.id, r.task.id])).size === 2);
      // ...and it CAN join its own untrusted chain's group
      assert.equal((await file(s2.token, { group: { join: child.id } })).json().group.decision, 'joined');
    });
    test('a trusted agent cannot move its filing into a tainted group either', async () => {
      const tainted = await storage.createTask({ title: 'tainted', repoId: r1.id, status: 'queued', source: 'office', taintedAt: new Date().toISOString() }, 'test');
      const s = await session(r1);
      const mine = (await file(s.token, { group: { ungrouped: 'will move' } })).json().task;
      const mv = await app.inject({
        method: 'POST',
        url: `/api/agent/tasks/${mine.id}/move`,
        headers: { 'x-tm-token': s.token },
        payload: { place: 'into', targetId: tainted.id },
      });
      assert.equal(mv.statusCode, 409, mv.body);
      assert.match(mv.json().error, /mix trust/);
    });
  });

  test('GET /api/agent/groups lists open groups in reach; context carries own + top groups', async () => {
    const s = await session(r1);
    const g = (await file(s.token, { group: { new: 'Listed Group' } })).json();
    await file(s.token, { group: { join: g.task.id } });
    const far = await storage.createTask({ title: 'far root', repoId: r3.id, status: 'queued' }, 'test');
    await storage.updateTask(far.id, { groupName: 'Listed Far' });
    const res = await app.inject({ method: 'GET', url: '/api/agent/groups?q=listed', headers: { 'x-tm-token': s.token } });
    assert.equal(res.statusCode, 200);
    const groups = res.json().groups as { id: string; name: string; members: number; open: number; joinRefusal: string | null }[];
    const mine = groups.find((x) => x.id === g.task.groupId)!;
    assert.equal(mine.name, 'Listed Group');
    assert.equal(mine.members, 2);
    assert.equal(mine.joinRefusal, null);
    assert.ok(!groups.some((x) => x.id === far.id), 'r3 is outside reach');
    assert.equal((await app.inject({ method: 'GET', url: '/api/agent/groups?repo=r3', headers: { 'x-tm-token': s.token } })).statusCode, 403);
    const ctx = (await app.inject({ method: 'GET', url: '/api/agent/context', headers: { 'x-tm-token': s.token } })).json();
    assert.equal(ctx.group.id, s.task.groupId);
    assert.ok(Array.isArray(ctx.openGroups) && ctx.openGroups.length <= 10);
    assert.ok(ctx.openGroups.some((x: { id: string }) => x.id === g.task.groupId));
  });

  test('job follow-ups: one `Job: <title>` group per job, re-joined while open', async () => {
    const job = { id: 'job-1', repoId: r1.id, title: 'Error rate check' } as Job;
    const a = await fileJobFollowUp(storage, job, { title: 'fix A', repoId: r1.id, source: 'job', sourceRef: job.id, status: 'draft' });
    assert.equal(a.groupName, 'Job: Error rate check');
    const b = await fileJobFollowUp(storage, job, { title: 'fix B', repoId: r1.id, source: 'job', sourceRef: job.id, status: 'draft' });
    assert.equal(b.groupId, a.id);
    // a human renames the group: the next follow-up still finds it by the job
    await storage.updateTask(a.id, { groupName: 'Renamed by human' });
    const c = await fileJobFollowUp(storage, job, { title: 'fix C', repoId: r1.id, source: 'job', sourceRef: job.id, status: 'draft' });
    assert.equal(c.groupId, a.id);
    const created = (await storage.listEvents({ kind: 'task.created', limit: 500 })).find((e) => e.taskId === c.id);
    assert.equal((created?.data?.group as { by?: string })?.by, 'job');
  });

  test('feature approval: the cards form ONE group named after the feature; a split root waits on its split pieces only', async () => {
    const f = await storage.createFeature({ repoId: r1.id, title: 'Checkout v2', request: 'r' }, 'test');
    const analysis = {
      summary: 's',
      considerations: [],
      phases: [
        { title: 'P1', tasks: [{ id: 'a', title: 'API', description: 'd', exitCriteria: [] }, { id: 'a2', title: 'Schema', description: 'd', exitCriteria: [] }] },
        { title: 'P2', tasks: [{ id: 'b', title: 'UI', description: 'd', exitCriteria: [] }, { id: 'c', title: 'Docs', description: 'd', exitCriteria: [] }] },
      ],
    } as unknown as FeaturePlan;
    await storage.updateFeature(f.id, { analysis }, 'test');
    await storage.transitionFeature(f.id, ['draft'], 'proposed', 'test');
    const res = (await storage.approveFeature(f.id, 'test'))!;
    const [api, schema, ui, docs] = res.tasks;
    assert.equal(api.groupName, 'Checkout v2');
    assert.equal(api.groupId, api.id);
    for (const card of [schema, ui, docs]) assert.equal(card.parentId, api.id);
    // split the phase-1 root (acceptProposal's children: source auto, the
    // parent's feature + phase): it waits on its split piece only — not on the
    // other cards, not even a SAME-phase one, and not failed by one
    await storage.transitionTask(api.id, ['draft'], 'blocked', 'test');
    const split = await storage.createTask({ title: 'API part', repoId: r1.id, parentId: api.id, featureId: f.id, featurePhase: 0, source: 'auto', status: 'queued' }, 'test');
    await storage.transitionTask(schema.id, ['draft'], 'failed', 'test');
    const blocked = (await storage.getTask(api.id))!;
    assert.equal(isSplitChild((await storage.getTask(split.id))!, blocked), true);
    for (const card of [schema, ui, docs]) assert.equal(isSplitChild(card, blocked), false);
    // a plan card's worker is no split sibling: linkToParent under the root is refused
    const uiRun = await session(r1, (await storage.transitionTask(ui.id, ['draft'], 'running', 'test'))!);
    const link = await file(uiRun.token, { linkToParent: true, enqueue: true });
    assert.equal(link.statusCode, 400, link.body);
    assert.match(link.json().error, /split siblings only/);
    await storage.transitionTask(split.id, ['queued'], 'done', 'test');
    const resolved = await storage.resolveChildCompletion(split.id, 'review', 'test');
    assert.equal(resolved?.status, 'review');
    assert.equal(resolved?.error ?? null, null);
  });
});
