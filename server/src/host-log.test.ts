import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { logToFiles, RotatingLog } from './host-log.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-host-log-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('RotatingLog', () => {
  test('rotates at maxBytes and keeps at most `keep` old files', async () => {
    const file = path.join(dir, 'api.log');
    const log = new RotatingLog(file, { maxBytes: 100, keep: 2 });
    for (let i = 0; i < 10; i++) log.write(`${String(i).padStart(2, '0')}${'x'.repeat(37)}\n`); // 40 bytes each
    await log.close();
    // 10 lines × 40 B, two per 100 B file: 5 generations, only api.log + .1 + .2 kept
    assert.deepEqual(fs.readdirSync(dir).sort(), ['api.log', 'api.log.1', 'api.log.2']);
    assert.ok(fs.readFileSync(file, 'utf8').startsWith('08'));
    assert.ok(fs.readFileSync(`${file}.1`, 'utf8').startsWith('06'));
    assert.ok(fs.readFileSync(`${file}.2`, 'utf8').startsWith('04'));
    for (const f of fs.readdirSync(dir)) assert.ok(fs.statSync(path.join(dir, f)).size <= 100);
  });

  test('appends to an existing file and counts its size', async () => {
    const file = path.join(dir, 'host.log');
    fs.writeFileSync(file, 'a'.repeat(90));
    const log = new RotatingLog(file, { maxBytes: 100, keep: 1 });
    log.write('b'.repeat(20));
    await log.close();
    assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'a'.repeat(90));
    assert.equal(fs.readFileSync(file, 'utf8'), 'b'.repeat(20));
  });

  test('a write after close is ignored, not thrown', async () => {
    const log = new RotatingLog(path.join(dir, 'closed.log'));
    await log.close();
    log.write('late\n');
  });
});

describe('logToFiles', () => {
  test('TM_LOG_FILES outranks config, config outranks the TTY rule', () => {
    const prev = process.env.TM_LOG_FILES;
    try {
      process.env.TM_LOG_FILES = '0';
      assert.equal(logToFiles({ configured: true, dev: false }), false);
      process.env.TM_LOG_FILES = '1';
      assert.equal(logToFiles({ configured: false, dev: true }), true);
      delete process.env.TM_LOG_FILES;
      assert.equal(logToFiles({ configured: true, dev: true }), true);
      assert.equal(logToFiles({ configured: false, dev: false }), false);
      // dev never switches by itself (concurrently's pipes are not a TTY)
      assert.equal(logToFiles({ configured: undefined, dev: true }), false);
    } finally {
      if (prev === undefined) delete process.env.TM_LOG_FILES;
      else process.env.TM_LOG_FILES = prev;
    }
  });
});
