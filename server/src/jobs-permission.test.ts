// docs/jobs.md § Permissions — an agent-filed job never runs more permissively
// than the workers, and an agent schedules only in its own repo.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { DEFAULT_SETTINGS, type AppSettings } from '@tm/shared';
import { JobService, jobPermission } from './jobs.ts';
import { registerAgentJobRoutes } from './routes/agent-jobs.ts';
import { SqliteStorage } from './storage/sqlite.ts';

const withMode = (m: AppSettings['agent.permissionMode']): AppSettings => ({ ...DEFAULT_SETTINGS, 'agent.permissionMode': m });

describe('jobPermission', () => {
  test('a human job keeps bypass whatever the worker mode', () => {
    for (const source of ['human', 'telegram'] as const) {
      assert.equal(jobPermission({ source, createdByRun: null }, withMode('acceptEdits')), 'bypass');
      assert.equal(jobPermission({ source, createdByRun: null }, withMode('auto')), 'bypass');
    }
  });
  test('an agent job follows agent.permissionMode, never wider', () => {
    const job = { source: 'agent' as const, createdByRun: 'run1' };
    assert.equal(jobPermission(job, withMode('bypassPermissions')), 'bypass');
    assert.equal(jobPermission(job, withMode('auto')), 'auto');
    assert.equal(jobPermission(job, withMode('acceptEdits')), 'dontAsk');
  });
  test('a job with a filer run is an agent job even if its source says otherwise', () => {
    assert.equal(jobPermission({ source: 'human', createdByRun: 'run1' }, withMode('auto')), 'auto');
  });
});

describe('POST /api/agent/jobs repo scope', () => {
  let tmp = '';
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let token = '';
  let ownId = '';
  let otherName = '';

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-jobperm-'));
    storage = new SqliteStorage(path.join(tmp, 'tm.db'));
    await storage.migrate();
    const own = await storage.createRepo({ name: 'own', path: tmp });
    const other = await storage.createRepo({ name: 'other', path: tmp });
    ownId = own.id;
    otherName = other.name;
    const task = await storage.createTask({ title: 'filer', repoId: own.id, status: 'running' }, 'test');
    token = 'tok-jobperm';
    await storage.createRun({ taskId: task.id, repoId: own.id, mode: 'worker', runToken: token });
    const jobs = new JobService({ storage, isPaused: async () => false, budget: async () => ({ ok: true }) as never });
    app = Fastify();
    registerAgentJobRoutes(app, storage, jobs);
    await app.ready();
  });

  after(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const post = (body: object) =>
    app.inject({ method: 'POST', url: '/api/agent/jobs', headers: { 'x-tm-token': token }, payload: body });

  test('another repo is refused', async () => {
    const r = await post({ title: 'peek', instructions: 'read their logs', delay: '1h', repo: otherName });
    assert.equal(r.statusCode, 403);
    assert.match(r.json().error, /own repo/);
  });

  test('the own repo, named or defaulted, is accepted', async () => {
    const named = await post({ title: 'check', instructions: 'read the error rate', delay: '1h', repo: 'own' });
    assert.equal(named.statusCode, 201, named.body);
    assert.equal(named.json().job.repoId, ownId);
    const dflt = await post({ title: 'check 2', instructions: 'read the error rate', delay: '2h' });
    assert.equal(dflt.statusCode, 201, dflt.body);
  });
});
