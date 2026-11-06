/**
 * File logs for the front door and the API it supervises (docs/host.md
 * § Running as a service).
 *
 * In a terminal, `npm start` keeps `stdio: 'inherit'` exactly as before. Off a
 * terminal (a launchd agent, or `TM_LOG_FILES=1`) the API's stdout/stderr are
 * PIPED into this process and appended to `server/data/logs/api.log`, and the
 * front door's own console lines go to `host.log`. Two reasons it matters:
 *
 * - a TTY write is synchronous on macOS, so a terminal that stops reading
 *   wedges the API inside a console write (it happened, 2026-10-29); a pipe
 *   drained by an async file stream cannot do that;
 * - scrollback that grows for days is memory billed to the terminal app.
 *
 * Writes are async (`fs.WriteStream`), size-rotated (`api.log` →
 * `api.log.1` … `.N`, oldest dropped), and bounded: if the disk falls behind by
 * more than `MAX_BACKLOG` bytes, lines are DROPPED and counted rather than
 * buffered without limit, because the point of all this is a front door that
 * cannot be taken down by its own logging.
 */
import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_KEEP = 5;
/** Bytes queued on the stream beyond which incoming chunks are dropped. */
const MAX_BACKLOG = 8 * 1024 * 1024;

export interface RotatingLogOptions {
  maxBytes?: number;
  keep?: number;
}

export class RotatingLog {
  readonly file: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private stream: fs.WriteStream;
  private size: number;
  private dropped = 0;
  private closed = false;

  constructor(file: string, opts: RotatingLogOptions = {}) {
    this.file = file;
    this.maxBytes = opts.maxBytes ?? LOG_MAX_BYTES;
    this.keep = Math.max(1, opts.keep ?? LOG_KEEP);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.size = fileSize(file);
    this.stream = this.open();
  }

  private open(): fs.WriteStream {
    // The fd is opened synchronously so the file EXISTS before the first write
    // returns — an async open would let a rotation's rename miss it.
    const s = fs.createWriteStream(this.file, { fd: fs.openSync(this.file, 'a') });
    // A log that cannot be written must never take the process down with it.
    s.on('error', () => {});
    return s;
  }

  /** Appends a chunk; rotates first when it would push the file past maxBytes. */
  write(chunk: string | Buffer): void {
    if (this.closed) return;
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (buf.length === 0) return;
    if (this.stream.writableLength > MAX_BACKLOG) {
      this.dropped += buf.length;
      return;
    }
    if (this.size > 0 && this.size + buf.length > this.maxBytes) this.rotate();
    if (this.dropped > 0) {
      const note = Buffer.from(`[log] ${this.dropped} bytes dropped: the disk fell behind\n`);
      this.dropped = 0;
      this.stream.write(note);
      this.size += note.length;
    }
    this.stream.write(buf);
    this.size += buf.length;
  }

  /**
   * Renames are synchronous on purpose: they are metadata-only and must not
   * interleave with the next write. The old stream keeps its fd, so whatever
   * it still has queued lands at the end of the file that just became `.1`.
   */
  private rotate(): void {
    const old = this.stream;
    try {
      fs.rmSync(`${this.file}.${this.keep}`, { force: true });
      for (let i = this.keep - 1; i >= 1; i--) {
        const from = `${this.file}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${i + 1}`);
      }
      fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      // A failed rename keeps appending to the current file rather than losing lines.
      return;
    }
    old.end();
    this.stream = this.open();
    this.size = 0;
  }

  /** Resolves once everything queued so far is on disk. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return new Promise((resolve) => this.stream.end(() => resolve()));
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Where the logs go. Order: `TM_LOG_FILES=1|0` wins, then `host.logFiles` in
 * data/config.json, then the automatic rule: files when NEITHER stdout nor
 * stderr is a terminal. Dev (`TM_DEV=1`) is the exception to the automatic
 * rule only — `npm run dev` runs under `concurrently`, whose pipes are not a
 * TTY, and its whole point is the output in that terminal.
 */
export function logToFiles(opts: { configured: boolean | undefined; dev: boolean }): boolean {
  const env = process.env.TM_LOG_FILES;
  if (env === '1') return true;
  if (env === '0') return false;
  if (opts.configured !== undefined) return opts.configured;
  if (opts.dev) return false;
  return !process.stdout.isTTY && !process.stderr.isTTY;
}

/** `[2026-11-06T10:00:00.000Z] ` — the API's own lines carry pino's time already. */
const stamp = () => `[${new Date().toISOString()}] `;

/**
 * Sends this process's console.* to `log` instead of its stdout/stderr. Only
 * the console methods are replaced: an uncaught exception's trace still goes
 * to fd 2, which the launchd plist points at `launchd.log`.
 */
export function redirectConsole(log: RotatingLog): void {
  const line = (level: string) =>
    (...args: unknown[]) => {
      log.write(`${stamp()}${level}${format(...args)}\n`);
    };
  console.log = line('');
  console.info = line('');
  console.warn = line('WARN ');
  console.error = line('ERROR ');
}
