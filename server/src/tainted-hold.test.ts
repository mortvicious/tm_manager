// docs/office.md § Director features → UI: a tainted office feature's held
// draft is queued only by a human who read it. Enqueue / Add to queue / Run now /
// Retry without Origin (a worker's curl) are 403 on such a card, in any status
// (cancel → retry must not re-queue it); an ordinary draft
// and a browser request are not refused by this gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { after, before, describe, test } from 'node:test';
import { SqliteStorage } from './storage/sqlite.ts';
import { TAINTED_FROM_BROWSER, registerTaskRoutes, taintedHoldRefusal } from './routes/tasks.ts';

describe('tainted feature cards need a browser to queue', () => {
  let tmp = '';
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let tainted = '';
  let plain = '';

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-tainted-hold-'));
    storage = new SqliteStorage(path.join(tmp, 'tm.db'));
    await storage.migrate();
    const repoId = (await storage.createRepo({ name: 'r', path: tmp } as any)).id;
    const at = new Date().toISOString();
    tainted = (await storage.createTask({ title: 'held', repoId, status: 'draft', source: 'feature', taintedAt: at }, 'test')).id;
    plain = (await storage.createTask({ title: 'plain', repoId, status: 'draft', source: 'feature' }, 'test')).id;
    app = Fastify();
    registerTaskRoutes(app, storage);
    await app.ready();
  });

  after(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('the gate: tainted draft without Origin refused; with Origin or untainted, not', async () => {
    assert.equal(await taintedHoldRefusal(storage, tainted, undefined), TAINTED_FROM_BROWSER);
    assert.equal(await taintedHoldRefusal(storage, tainted, 'http://127.0.0.1:5173'), null);
    assert.equal(await taintedHoldRefusal(storage, plain, undefined), null);
    assert.equal(await taintedHoldRefusal(storage, 'missing', undefined), null);
  });

  test('Enqueue and Add to queue without Origin are 403 and leave the card a draft', async () => {
    for (const action of ['enqueue', 'queue']) {
      const res = await app.inject({ method: 'POST', url: `/api/tasks/${tainted}/${action}` });
      assert.equal(res.statusCode, 403, `${action}: ${res.body}`);
      assert.equal(res.json().error, TAINTED_FROM_BROWSER);
    }
    const row = await storage.getTask(tainted);
    assert.equal(row?.status, 'draft');
    assert.equal(row?.customQueueAt ?? null, null);
  });

  test('cancel (no Origin) then retry / enqueue / queue: still 403, still cancelled', async () => {
    // cancel needs no Origin (a worker may cancel the card); done here through storage — the harness has no orchestrator
    await storage.transitionTask(tainted, ['draft'], 'cancelled', 'test');
    assert.equal((await storage.getTask(tainted))?.status, 'cancelled');
    for (const action of ['retry', 'enqueue', 'queue']) {
      const res = await app.inject({ method: 'POST', url: `/api/tasks/${tainted}/${action}` });
      assert.equal(res.statusCode, 403, `${action}: ${res.body}`);
    }
    assert.equal(await taintedHoldRefusal(storage, tainted, undefined), TAINTED_FROM_BROWSER);
    assert.equal((await storage.getTask(tainted))?.status, 'cancelled');
  });
});
