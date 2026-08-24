import { execFileSync } from 'node:child_process';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import type { WebSocket } from 'ws';
import type { TerminalServerMsg } from '@tm/shared';
import { RingBuffer } from './ring-buffer.ts';

/** Guard against pid reuse before an escalated SIGKILL (review F9): only kill
 *  a pid whose command still looks like a claude/node/shell process we spawned. */
export function pidLooksLikeOurs(pid: number, pattern: RegExp = /claude|node|zsh|bash|sh$/): boolean {
  try {
    const comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim();
    return pattern.test(comm);
  } catch {
    return false; // process gone
  }
}

export interface SessionEndInfo {
  runId: string;
  exitCode: number;
}

export interface Session {
  runId: string;
  pty: IPty;
  buffer: RingBuffer;
  clients: Set<WebSocket>;
  cols: number;
  rows: number;
  exit: { code: number } | null;
  /** true after the task completed (first Stop hook): PTY stays attachable but
   *  no longer occupies a concurrency slot */
  idle: boolean;
  idleAt: number | null;
  endedAt: number | null;
}

const EXITED_TTL_MS = 30 * 60_000;
export const MAX_LIVE_SESSIONS = 10;

export class SessionManager {
  private sessions = new Map<string, Session>();
  private onExitCb: ((info: SessionEndInfo) => void) | null = null;

  constructor(private scrollbackBytes: () => number) {
    // GC exited sessions past their post-mortem window — unless someone is
    // still reading them (review F8). Idle-completed sessions never exit on
    // their own, so they get the same TTL (review R2).
    setInterval(() => {
      const cutoff = Date.now() - EXITED_TTL_MS;
      for (const [id, s] of this.sessions) {
        if (s.clients.size > 0) continue;
        const exitedLongAgo = s.endedAt !== null && s.endedAt < cutoff;
        const idleLongAgo = s.exit === null && s.idle && s.idleAt !== null && s.idleAt < cutoff;
        if (exitedLongAgo || idleLongAgo) this.dispose(id);
      }
    }, 60_000).unref();
  }

  onExit(cb: (info: SessionEndInfo) => void): void {
    this.onExitCb = cb;
  }

  get(runId: string): Session | undefined {
    return this.sessions.get(runId);
  }

  /** ALL alive PTYs, idle included — the hard-cap denominator. */
  totalLiveCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.exit === null) n++;
    return n;
  }

  /** Sessions occupying a concurrency slot: alive and not yet idle. */
  liveCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.exit === null && !s.idle) n++;
    return n;
  }

  /** Task finished (first Stop): keep the PTY attachable, free the slot. */
  markIdle(runId: string): void {
    const s = this.sessions.get(runId);
    if (s && !s.idle) {
      s.idle = true;
      s.idleAt = Date.now();
    }
  }

  /** A follow-up woke the session: it occupies a worker slot again. */
  markActive(runId: string): void {
    const s = this.sessions.get(runId);
    if (s && s.exit === null) {
      s.idle = false;
      s.idleAt = null;
    }
  }

  isIdle(runId: string): boolean {
    return this.sessions.get(runId)?.idle === true;
  }

  spawn(opts: { runId: string; cmd: string; args: string[]; cwd: string; env: Record<string, string> }): Session {
    // Under cap pressure, evict in preference order: unwatched exited, then
    // unwatched idle-completed (their claude never exits on its own — without
    // this the cap fills after ~10 completed tasks and every spawn fails,
    // review R2). dispose() kills live ptys. Never evict active or watched.
    while (this.sessions.size >= MAX_LIVE_SESSIONS) {
      const evictable = [...this.sessions.values()]
        .filter((s) => s.clients.size === 0 && (s.exit !== null || s.idle))
        .sort((a, b) => (a.endedAt ?? a.idleAt ?? 0) - (b.endedAt ?? b.idleAt ?? 0));
      if (!evictable[0]) break;
      this.dispose(evictable[0].runId);
    }
    if ([...this.sessions.values()].filter((s) => s.exit === null && !s.idle).length >= MAX_LIVE_SESSIONS) {
      throw new Error(`session cap reached (${MAX_LIVE_SESSIONS} active PTYs)`);
    }

    // Strip inherited Claude Code session markers: if this server was itself
    // started from inside a claude session, CLAUDE_CODE_CHILD_SESSION would
    // disable transcript saving in workers — and transcripts feed run stats.
    const baseEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE') baseEnv[k] = v;
    }
    baseEnv.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1';

    const pty = ptySpawn(opts.cmd, opts.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd: opts.cwd,
      env: { ...baseEnv, TERM: 'xterm-256color', ...opts.env },
    });

    const session: Session = {
      runId: opts.runId,
      pty,
      buffer: new RingBuffer(this.scrollbackBytes()),
      clients: new Set(),
      cols: 120,
      rows: 32,
      exit: null,
      idle: false,
      idleAt: null,
      endedAt: null,
    };
    this.sessions.set(opts.runId, session);

    pty.onData((data: string) => {
      const bytes = Buffer.from(data, 'utf8');
      session.buffer.append(bytes);
      const frame: TerminalServerMsg = { type: 'data', data: bytes.toString('base64') };
      this.fanout(session, frame);
    });

    pty.onExit(({ exitCode }) => {
      session.exit = { code: exitCode };
      session.endedAt = Date.now();
      this.fanout(session, { type: 'exit', code: exitCode });
      this.onExitCb?.({ runId: opts.runId, exitCode });
    });

    return session;
  }

  attach(runId: string, ws: WebSocket): boolean {
    const s = this.sessions.get(runId);
    if (!s) return false;
    s.clients.add(ws);
    const history: TerminalServerMsg = { type: 'history', data: s.buffer.snapshot().toString('base64') };
    ws.send(JSON.stringify(history));
    if (s.exit) ws.send(JSON.stringify({ type: 'exit', code: s.exit.code } satisfies TerminalServerMsg));
    ws.on('close', () => s.clients.delete(ws));
    return true;
  }

  input(runId: string, data: Buffer): void {
    const s = this.sessions.get(runId);
    if (s && s.exit === null) s.pty.write(data.toString('utf8'));
  }

  resize(runId: string, cols: number, rows: number): void {
    const s = this.sessions.get(runId);
    if (!s || s.exit !== null) return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return; // NaN poisons pty state (F10)
    const c = Math.max(20, Math.min(500, Math.floor(cols)));
    const r = Math.max(5, Math.min(200, Math.floor(rows)));
    s.cols = c;
    s.rows = r;
    try {
      s.pty.resize(c, r);
    } catch {
      // resizing a just-exited pty throws; harmless
    }
  }

  kill(runId: string): boolean {
    const s = this.sessions.get(runId);
    if (!s || s.exit !== null) return false;
    try {
      s.pty.kill('SIGHUP');
    } catch {
      return false;
    }
    const pid = s.pty.pid;
    setTimeout(() => {
      if (s.exit === null && pidLooksLikeOurs(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }, 5000).unref();
    return true;
  }

  private fanout(s: Session, msg: TerminalServerMsg): void {
    const json = JSON.stringify(msg);
    for (const ws of s.clients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(json);
        } catch {
          // dead socket; close handler will remove it
        }
      }
    }
  }

  private dispose(runId: string): void {
    const s = this.sessions.get(runId);
    if (!s) return;
    if (s.exit === null) {
      try {
        s.pty.kill();
      } catch {
        // already gone
      }
    }
    for (const ws of s.clients) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.sessions.delete(runId);
  }
}
