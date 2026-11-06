// Quiet request logging (docs/host.md § Logging).
// Run: npm test   (node:test through tsx; an in-memory Fastify app via inject)
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { describe, test } from 'node:test';
import Fastify from 'fastify';
import { parseLog } from './config.ts';
import { createLogger, installAsyncConsole, isLongPoll, registerRequestLog, requestLogLevel } from './logging.ts';

// `slowRequestMs` is per test: this runs on a loaded laptop, where even a
// trivial inject can take a few hundred ms.
function app(level: 'info' | 'debug' = 'info', slowRequestMs = 60_000) {
  const lines: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      for (const l of String(chunk).split('\n')) if (l) lines.push(JSON.parse(l));
      cb();
    },
  });
  const cfg = { level, slowRequestMs } as const;
  const a = Fastify({ loggerInstance: createLogger(cfg, sink), disableRequestLogging: true });
  registerRequestLog(a, cfg);
  a.post('/api/internal/runs/:id/stop', async () => ({ ok: true }));
  a.get('/api/tasks', async () => []);
  a.get('/api/agent/tasks/:id', async () => {
    await new Promise((r) => setTimeout(r, 300));
    return { status: 'running' };
  });
  a.get('/api/slow', async () => {
    await new Promise((r) => setTimeout(r, 300));
    return {};
  });
  a.get('/api/conflict', async (_req, reply) => reply.code(409).send({ error: 'busy' }));
  a.get('/api/boom', async () => {
    throw new Error('kaput');
  });
  return { a, lines };
}

describe('request logging', () => {
  test('routine requests write nothing at info', async () => {
    const { a, lines } = app();
    for (let i = 0; i < 20; i++) {
      await a.inject({ method: 'POST', url: '/api/internal/runs/r1/stop', payload: {} });
      await a.inject({ method: 'GET', url: '/api/tasks' });
    }
    assert.deepEqual(lines, []);
  });

  test('a long poll that waited is not "slow"', async () => {
    const { a, lines } = app('info', 100);
    await a.inject({ method: 'GET', url: '/api/agent/tasks/t1?waitMs=60000' });
    assert.deepEqual(lines, []);
  });

  test('4xx, 5xx and slow requests get exactly one line each', async () => {
    const { a, lines } = app('info', 200);
    await a.inject({ method: 'GET', url: '/api/conflict' });
    await a.inject({ method: 'GET', url: '/api/nope' });
    await a.inject({ method: 'GET', url: '/api/boom' });
    await a.inject({ method: 'GET', url: '/api/slow' });
    // the error handler's own line for the 500 has no statusCode; a request
    // the loaded test machine made slow is not one of ours
    const req = lines.filter((l) => typeof l.statusCode === 'number' && !(l.msg === 'slow request' && l.url !== '/api/slow'));
    assert.deepEqual(
      req.map((l) => [l.level, l.url, l.statusCode, l.msg]),
      [
        [40, '/api/conflict', 409, 'request failed'],
        [40, '/api/nope', 404, 'request failed'],
        [50, '/api/boom', 500, 'request failed'],
        [40, '/api/slow', 200, 'slow request'],
      ],
    );
    assert.ok((req[3]!.responseTime as number) >= 200);
  });

  test('debug brings one line per request back, with the token redacted', async () => {
    const { a, lines } = app('debug');
    await a.inject({ method: 'GET', url: '/api/tasks?token=secret123&x=1' });
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.level, 20);
    assert.equal(lines[0]!.url, '/api/tasks?token=***&x=1');
  });

  test('requestLogLevel', () => {
    const base = { statusCode: 200, elapsedMs: 5, url: '/api/x', hijacked: false };
    assert.equal(requestLogLevel(base, 2000), 'debug');
    assert.equal(requestLogLevel({ ...base, hijacked: true, statusCode: 500 }, 2000), null);
    assert.equal(requestLogLevel({ ...base, elapsedMs: 2001 }, 2000), 'warn');
    assert.equal(requestLogLevel({ ...base, elapsedMs: 59_000, url: '/a?b=1&waitMs=60000' }, 2000), 'debug');
    assert.equal(requestLogLevel({ ...base, statusCode: 503 }, 2000), 'error');
    assert.ok(isLongPoll('/api/internal/runs/1/question?waitMs=60000'));
    assert.ok(!isLongPoll('/api/tasks?notwaitMs=1'));
  });
});

describe('log config', () => {
  test('defaults and validation', () => {
    assert.deepEqual(parseLog(undefined), { level: 'info', slowRequestMs: 2000 });
    assert.deepEqual(parseLog({ level: 'warn' }), { level: 'warn', slowRequestMs: 2000 });
    assert.throws(() => parseLog({ level: 'loud' }), /log\.level/);
    assert.throws(() => parseLog({ slowRequestMs: 5 }), /slowRequestMs/);
    assert.throws(() => parseLog([]), /log must be an object/);
  });
});

describe('async console', () => {
  test('console.* goes to the given writers, formatted like console', () => {
    const out: string[] = [];
    const err: string[] = [];
    const restore = installAsyncConsole({ write: (s) => out.push(s) }, { write: (s) => err.push(s) });
    try {
      console.log('boot %s on :%d', 'api', 5175, { a: 1 });
      console.info('i');
      console.warn('w');
      console.error(new Error('e').message);
    } finally {
      restore();
    }
    assert.deepEqual(out, ['boot api on :5175 { a: 1 }\n', 'i\n']);
    assert.deepEqual(err, ['w\n', 'e\n']);
  });
});
