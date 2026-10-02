import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_SHELL_SESSIONS, type Repo, type ShellSession } from '@tm/shared';
import { broadcast } from '../events.ts';
import type { SessionManager } from '../pty/session-manager.ts';
import type { Storage } from '../storage/types.ts';

/** Thrown for "not now" refusals (cap reached) — the route maps it to 409. */
export class ShellConflict extends Error {}

/**
 * The user's login shell, resolved once per spawn: `$SHELL` when it names an
 * executable, else the account's shell from the passwd entry, else the
 * platform default. Only ever an absolute path handed to node-pty as argv[0] —
 * no shell string is ever built from user input.
 */
export function resolveLoginShell(): string {
  const candidates = [process.env.SHELL, safeUserShell(), process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash', '/bin/sh'];
  for (const c of candidates) {
    if (!c || !path.isAbsolute(c)) continue;
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      // try the next one
    }
  }
  return '/bin/sh';
}

function safeUserShell(): string | undefined {
  try {
    return os.userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Plain interactive shells per repo (docs/terminals.md): the user's login
 * shell in a real PTY with cwd = the repo, attachable over the same
 * `/ws/terminal/:id` as every other session.
 *
 * Its PTYs live in their OWN SessionManager pool — the fourth, beside agents,
 * repo commands and aux — for the reason commands have theirs: a shell is open
 * for hours and must never touch agent concurrency or the agents' spawn cap.
 * The registry is in memory only: a PTY dies with the server.
 *
 * An entry outlives its shell's exit (the tab shows "exited" and keeps its
 * scrollback) until the user closes it, so `MAX_SHELL_SESSIONS` counts every
 * entry, live or not. That bound is also what keeps the pool under its own
 * `MAX_LIVE_SESSIONS`, so the pool's cap error is never the one a user sees.
 */
export class ShellRunner {
  private shells = new Map<string, ShellSession>();
  /** shells we asked to die, so their exit reports `killed` rather than `exited` */
  private stopping = new Set<string>();

  constructor(
    private storage: Storage,
    private sessions: SessionManager,
  ) {
    this.sessions.onExit(({ runId, exitCode }) => {
      const shell = this.shells.get(runId);
      // Absent = already closed: close() forgets the entry before the exit lands.
      if (!shell || shell.status !== 'running') return;
      shell.status = this.stopping.delete(runId) ? 'killed' : 'exited';
      shell.exitCode = exitCode;
      shell.endedAt = new Date().toISOString();
      broadcast({ type: 'shell.session', session: { ...shell } });
    });
  }

  /** Oldest first, so tabs keep the order they were opened in. */
  list(): ShellSession[] {
    return [...this.shells.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.index - b.index);
  }

  get(id: string): ShellSession | undefined {
    return this.shells.get(id);
  }

  running(): ShellSession[] {
    return this.list().filter((s) => s.status === 'running');
  }

  /**
   * Opens `count` shells in the repo's directory. All-or-nothing on the cap:
   * a request for 3 with 2 slots left is refused whole rather than half done.
   */
  async open(repo: Repo, count: number, actor: string): Promise<ShellSession[]> {
    let isDir = false;
    try {
      isDir = fs.statSync(repo.path).isDirectory();
    } catch {
      // missing → refused below
    }
    if (!isDir) throw new Error(`repo directory does not exist: ${repo.path}`);
    const free = MAX_SHELL_SESSIONS - this.shells.size;
    if (count > free) {
      throw new ShellConflict(
        free <= 0
          ? `${MAX_SHELL_SESSIONS} terminals are already open — close one first`
          : `only ${free} more terminal(s) can be opened (limit ${MAX_SHELL_SESSIONS})`,
      );
    }

    const bin = resolveLoginShell();
    const name = path.basename(bin);
    const opened: ShellSession[] = [];
    try {
      for (let i = 0; i < count; i++) {
        const index = this.nextIndex(repo.id);
        const id = `sh-${randomUUID()}`;
        // `-l`: a login shell reads the profile, which is where PATH comes from
        // on a Mac — a server started by launchd inherits a bare PATH otherwise.
        const session = this.sessions.spawn({
          runId: id,
          cmd: bin,
          args: ['-l'],
          cwd: repo.path,
          env: { TERM_PROGRAM: 'task-manager' },
        });
        const shell: ShellSession = {
          id,
          repoId: repo.id,
          repoName: repo.name,
          title: `${name} ${index}`,
          index,
          cwd: repo.path,
          shell: bin,
          status: 'running',
          pid: session.pty.pid,
          exitCode: null,
          startedAt: new Date().toISOString(),
          endedAt: null,
        };
        this.shells.set(id, shell);
        opened.push(shell);
        broadcast({ type: 'shell.session', session: { ...shell } });
      }
    } finally {
      // A spawn failing half way still leaves the ones before it open: audit those.
      if (opened.length > 0) {
        await this.storage
          .appendEvent({
            kind: 'shell.session',
            actor,
            repoId: repo.id,
            data: { action: 'opened', count: opened.length, shell: bin, cwd: repo.path, ids: opened.map((s) => s.id) },
          })
          .catch(() => {});
      }
    }
    return opened;
  }

  /**
   * Ends the shell if it is still alive (SIGHUP, SIGKILL after 5s — the same
   * kill as every other session) and forgets it: scrollback dropped, attached
   * terminals closed. Returns false for an unknown id.
   */
  async close(id: string, actor: string): Promise<boolean> {
    const shell = this.shells.get(id);
    if (!shell) return false;
    this.shells.delete(id);
    if (shell.status === 'running') this.sessions.kill(id);
    this.stopping.delete(id);
    this.sessions.dispose(id);
    broadcast({ type: 'shell.closed', id });
    await this.storage
      .appendEvent({
        kind: 'shell.session',
        actor,
        repoId: shell.repoId,
        data: { action: 'closed', id, title: shell.title, wasRunning: shell.status === 'running' },
      })
      .catch(() => {});
    return true;
  }

  /** Process shutdown/restart: a shell must not outlive the server that owns its PTY. */
  stopAll(): void {
    for (const shell of this.running()) {
      this.stopping.add(shell.id);
      if (!this.sessions.kill(shell.id)) this.stopping.delete(shell.id);
    }
  }

  /** Lowest positive number not taken by an open shell of this repo. */
  private nextIndex(repoId: string): number {
    const taken = new Set([...this.shells.values()].filter((s) => s.repoId === repoId).map((s) => s.index));
    let n = 1;
    while (taken.has(n)) n++;
    return n;
  }
}
