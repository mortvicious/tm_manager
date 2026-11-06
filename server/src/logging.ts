/**
 * The API's logger (docs/host.md § Logging).
 *
 * Two things this module exists to stop:
 *  - VOLUME. Fastify's default is two `info` lines per request ("incoming
 *    request" + "request completed"). Every worker hook is a curl, the SPA reads
 *    on every event, agents long-poll — that was nearly every line the API
 *    wrote. Request logging is therefore off (`disableRequestLogging: true`)
 *    and `registerRequestLog` writes ONE line, only for a request worth reading:
 *    5xx (error), 4xx or slower than `log.slowRequestMs` (warn). Routine
 *    requests go to `debug`, so `log.level: "debug"` brings every one back.
 *  - BLOCKING. Node writes to a TTY (and to a file) synchronously on macOS;
 *    a terminal that stopped reading wedged the API in a console write
 *    (2026-10-29). BOTH pino and every `console.*` call (`installAsyncConsole`)
 *    now go through `nonBlockingWriter` on fd 1/2 — stdout is the TTY under
 *    `npm start` in a terminal and the front door's log file under the
 *    service — so a stalled reader costs a queue, bounded by `MAX_BUFFER`
 *    (lines past it are dropped), never the event loop and never an exit.
 */
import fs from 'node:fs';
import net from 'node:net';
import type { Writable } from 'node:stream';
import tty from 'node:tty';
import { format } from 'node:util';
import pino from 'pino';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { LogConfig } from './config.ts';

/** Unflushed log bytes kept while stdout does not drain; beyond it lines are dropped. */
export const MAX_BUFFER = 16 * 1024 * 1024;

/** Never log the terminal token from WS attach URLs (review F12). */
export function redactUrl(url: string): string {
  return url.replace(/([?&]token=)[^&]+/, '$1***');
}

/** A request whose wait is its job: `?waitMs=` long polls (agent tasks/approvals, the question hook). */
export function isLongPoll(url: string): boolean {
  return /[?&]waitMs=/.test(url);
}

/** What pino and the console shim write to. */
export interface LogWriter {
  write(s: string): unknown;
}

let stdoutDest: LogWriter | null = null;
let stderrDest: LogWriter | null = null;

/**
 * A writer for fd 1/2 that never blocks the process — not while running, not
 * at exit:
 *  - a TTY or a pipe: a libuv stream in NON-blocking mode (`tty.WriteStream`
 *    with `setBlocking(false)` — libuv reopens the tty for its own handle, so
 *    the terminal's shared description is untouched, measured — or a
 *    `net.Socket` on the pipe). A write the reader does not take is queued on
 *    the event loop, beyond `MAX_BUFFER` queued bytes lines are dropped, and
 *    exit just leaves the queue. NOT sonic-boom here: its async write is a
 *    blocking `write(2)` on libuv's threadpool, and Node joins that pool at
 *    exit, so a stalled terminal hung every exit (and so every restart) —
 *    measured with an unread pty.
 *  - a regular file (launchd `StandardOutPath`, `> file`): sonic-boom async,
 *    flushed by pino on exit; a file write does not stall on a reader.
 */
function nonBlockingWriter(fd: 1 | 2): LogWriter {
  let kind: 'file' | 'tty' | 'pipe' = 'pipe';
  try {
    kind = tty.isatty(fd) ? 'tty' : fs.fstatSync(fd).isFile() ? 'file' : 'pipe';
  } catch {
    // fstat failed (closed fd): a socket write will fail quietly below
  }
  if (kind === 'file') {
    const d = pino.destination({ dest: fd, sync: false, maxLength: MAX_BUFFER });
    d.on('error', () => {}); // a log write must never be what takes the API down
    return d;
  }
  let stream: Writable;
  if (kind === 'tty') {
    const t = new tty.WriteStream(fd) as tty.WriteStream & { _handle?: { setBlocking?(b: boolean): unknown } };
    t._handle?.setBlocking?.(false);
    stream = t;
  } else {
    stream = new net.Socket({ fd, readable: false, writable: true });
  }
  // EPIPE (the front door that read our stdout is gone) or the like.
  stream.on('error', () => {});
  return {
    write(s: string) {
      if (stream.destroyed || stream.writableLength > MAX_BUFFER) return false;
      return stream.write(s);
    },
  };
}

/** THE stdout writer of this process: pino and the console shim share it, so their lines keep their order. */
export function asyncStdout(): LogWriter {
  return (stdoutDest ??= nonBlockingWriter(1));
}

export function asyncStderr(): LogWriter {
  return (stderrDest ??= nonBlockingWriter(2));
}

/**
 * Re-point `console.log/info/debug` (→ async fd 1) and `console.warn/error`
 * (→ async fd 2) at the non-blocking writers above. Node's console writes to a TTY or a
 * file SYNCHRONOUSLY, and the API has ~150 console calls on live paths
 * (orchestrator, Telegram, office) — the 2026-10-29 wedge was one of them
 * blocked in `write`. Formatting is `util.format`, exactly what console does,
 * so the text (boot lines quoted in docs/telegram.md included) is unchanged.
 * Installed by `async-console.ts`, the first import of index.ts. Returns a
 * restore function (tests).
 */
export function installAsyncConsole(
  out: LogWriter = asyncStdout(),
  err: LogWriter = asyncStderr(),
): () => void {
  const saved = { log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error };
  const to = (w: LogWriter) => (...args: unknown[]) => {
    w.write(format(...args) + '\n');
  };
  console.log = to(out);
  console.info = to(out);
  console.debug = to(out);
  console.warn = to(err);
  console.error = to(err);
  return () => Object.assign(console, saved);
}

// Typed as Fastify's base logger so the app keeps its default generic (every
// route module takes a plain `FastifyInstance`).
export function createLogger(cfg: LogConfig, stream?: pino.DestinationStream): FastifyBaseLogger {
  const dest = stream ?? (asyncStdout() as pino.DestinationStream);
  return pino(
    {
      level: cfg.level,
      serializers: {
        req(req: { method: string; url: string }) {
          return { method: req.method, url: redactUrl(req.url) };
        },
      },
    },
    dest,
  );
}

export type RequestLogLevel = 'error' | 'warn' | 'debug' | null;

/**
 * Which level the one line for a finished request goes to. `null` = no line:
 * a hijacked reply (a WebSocket upgrade) is not a finished request.
 */
export function requestLogLevel(
  r: { statusCode: number; elapsedMs: number; url: string; hijacked: boolean },
  slowRequestMs: number,
): RequestLogLevel {
  if (r.hijacked) return null;
  if (r.statusCode >= 500) return 'error';
  if (r.statusCode >= 400) return 'warn';
  if (r.elapsedMs > slowRequestMs && !isLongPoll(r.url)) return 'warn';
  return 'debug';
}

/**
 * The one line per request worth reading (see the header). Registered as a
 * global `onResponse` hook on an app built with `disableRequestLogging: true`.
 */
export function registerRequestLog(app: FastifyInstance, cfg: LogConfig): void {
  app.addHook('onResponse', async (req, reply) => {
    const url = req.raw.url ?? req.url;
    const level = requestLogLevel(
      {
        statusCode: reply.statusCode,
        elapsedMs: reply.elapsedTime,
        url,
        hijacked: String(req.headers.upgrade ?? '').toLowerCase() === 'websocket',
      },
      cfg.slowRequestMs,
    );
    if (level === null) return;
    const msg = level === 'debug' ? 'request' : reply.statusCode >= 400 ? 'request failed' : 'slow request';
    req.log[level](
      {
        method: req.method,
        url: redactUrl(url),
        statusCode: reply.statusCode,
        responseTime: Math.round(reply.elapsedTime),
      },
      msg,
    );
  });
}
