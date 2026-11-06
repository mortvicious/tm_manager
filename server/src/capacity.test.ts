// Worker concurrency from RAM (docs/memory.md § Concurrency from RAM): the
// pure suggestion and warnings, the storage default it feeds (an unsaved key
// reads as the suggestion, a saved row always wins), and the PUT /api/config
// rule that an agent (no Origin) cannot move the value. Run: npm test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { concurrencyAdvice, DEFAULT_SETTINGS, suggestedConcurrency } from '@tm/shared';
import { machineInfo, overrideTotalMem } from './machine.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { SqliteStorage } from './storage/sqlite.ts';

const GIB = 1024 ** 3;
const defaults = {
  'orchestrator.concurrency': 2,
  'chat.concurrency': DEFAULT_SETTINGS['chat.concurrency'],
  'jobs.concurrency': DEFAULT_SETTINGS['jobs.concurrency'],
  'jobs.enabled': DEFAULT_SETTINGS['jobs.enabled'],
};

describe('capacity (pure)', () => {
  test('suggested concurrency by RAM: ≤ 8 GB → 2, ≤ 24 GB → 3, above → 4', () => {
    assert.equal(suggestedConcurrency(4 * GIB), 2);
    assert.equal(suggestedConcurrency(8 * GIB), 2);
    assert.equal(suggestedConcurrency(8.4 * GIB), 2);
    assert.equal(suggestedConcurrency(16 * GIB), 3);
    assert.equal(suggestedConcurrency(24 * GIB), 3);
    assert.equal(suggestedConcurrency(32 * GIB), 4);
    assert.equal(suggestedConcurrency(128 * GIB), 4);
    assert.equal(suggestedConcurrency(0), 2);
    assert.equal(suggestedConcurrency(Number.NaN), 2);
  });

  test('the defaults on an 8 GB Mac warn about nothing', () => {
    const a = concurrencyAdvice(defaults, 8 * GIB);
    assert.equal(a.suggested, 2);
    assert.equal(a.totalGb, 8);
    assert.equal(a.over, false);
    assert.equal(a.stacked, false);
    assert.deepEqual(a.warnings, []);
  });

  test('4 workers on 8 GB: over the suggestion, and chats + jobs stack on top', () => {
    const a = concurrencyAdvice({ ...defaults, 'orchestrator.concurrency': 4 }, 8 * GIB);
    assert.equal(a.over, true);
    assert.equal(a.stacked, true);
    assert.equal(a.sessions, 7);
    assert.equal(a.sessionsSuggested, 5);
    assert.equal(a.warnings.length, 2);
    assert.match(a.warnings[0], /4 workers is above the 2 this Mac's 8 GB suggests/);
    assert.match(a.warnings[1], /Chats \(2\) and jobs \(1\) stack on top.*up to 7 claude sessions/);
  });

  test('4 workers on 32 GB: no warning', () => {
    assert.deepEqual(concurrencyAdvice({ ...defaults, 'orchestrator.concurrency': 4 }, 32 * GIB).warnings, []);
  });

  test('raised chat concurrency alone stacks; a disabled jobs queue counts no jobs', () => {
    const chats = concurrencyAdvice({ ...defaults, 'chat.concurrency': 4 }, 8 * GIB);
    assert.equal(chats.over, false);
    assert.equal(chats.stacked, true);
    assert.equal(chats.warnings.length, 1);
    const off = concurrencyAdvice({ ...defaults, 'chat.concurrency': 3, 'jobs.enabled': false }, 8 * GIB);
    assert.equal(off.sessions, 5);
    assert.equal(off.stacked, false);
    const offOver = concurrencyAdvice({ ...defaults, 'chat.concurrency': 4, 'jobs.enabled': false }, 8 * GIB);
    assert.match(offOver.warnings[0], /^Chats \(4\) stack on top/);
  });
});

describe('capacity (storage default + PUT /api/config)', () => {
  let tmp: string;
  let storage: SqliteStorage;
  let app: FastifyInstance;

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-capacity-')));
    storage = new SqliteStorage(path.join(tmp, 'tm.db'));
    await storage.migrate();
    app = Fastify();
    registerSettingsRoutes(app, storage);
    await app.ready();
  });
  afterEach(async () => {
    overrideTotalMem(null);
    await storage.deleteSetting('orchestrator.concurrency');
  });
  after(async () => {
    await app.close();
    storage.close?.();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('a fresh config on an 8 GB machine reads 2; on 16 GB 3; on 32 GB 4 — never written', async () => {
    overrideTotalMem(8 * GIB);
    assert.equal((await storage.getSettings())['orchestrator.concurrency'], 2);
    assert.deepEqual(machineInfo(), { totalMemBytes: 8 * GIB, suggestedConcurrency: 2 });
    overrideTotalMem(16 * GIB);
    assert.equal((await storage.getSettings())['orchestrator.concurrency'], 3);
    overrideTotalMem(32 * GIB);
    assert.equal((await storage.getSettings())['orchestrator.concurrency'], 4);
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    assert.equal(res.json()['orchestrator.concurrency'], 4);
  });

  test('a saved value above the suggestion is kept, and it warns', async () => {
    overrideTotalMem(8 * GIB);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: { origin: 'http://localhost:5173' },
      payload: { 'orchestrator.concurrency': 4 },
    });
    assert.equal(put.statusCode, 200);
    const s = await storage.getSettings();
    assert.equal(s['orchestrator.concurrency'], 4);
    assert.match(concurrencyAdvice(s, 8 * GIB).warnings[0], /4 workers is above the 2/);
    // a bigger or smaller machine never moves a saved value
    overrideTotalMem(64 * GIB);
    assert.equal((await storage.getSettings())['orchestrator.concurrency'], 4);
  });

  test('an agent (no Origin) cannot change the concurrency, up or down', async () => {
    overrideTotalMem(8 * GIB);
    for (const v of [5, 1]) {
      const res = await app.inject({ method: 'PUT', url: '/api/config', payload: { 'orchestrator.concurrency': v } });
      assert.equal(res.statusCode, 403);
    }
    assert.equal((await storage.getSettings())['orchestrator.concurrency'], 2);
    // re-sending the current value is not a change
    const same = await app.inject({ method: 'PUT', url: '/api/config', payload: { 'orchestrator.concurrency': 2 } });
    assert.equal(same.statusCode, 200);
  });
});
