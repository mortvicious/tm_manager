import { randomUUID } from 'node:crypto';
import type { CommandRun, Repo, RepoCommand } from '@tm/shared';
import { broadcast } from '../events.ts';
import type { SessionManager } from '../pty/session-manager.ts';
import type { Storage } from '../storage/types.ts';
import { parseCommandLine, resolveBin, resolveCommandCwd } from './parse.ts';

/** Finished runs kept for the launcher's history strip. */
const MAX_FINISHED = 25;

/**
 * Runs saved repo commands in real PTYs — the same terminal machinery as an
 * agent session, so `/ws/terminal/:id` and the drawer work unchanged.
 *
 * The PTYs live in their OWN SessionManager instance, never the orchestrator's:
 * a dev server is alive for hours, and sharing the manager would let it eat the
 * agent concurrency accounting (`liveCount()`) and the `MAX_LIVE_SESSIONS` hard
 * cap that spawns are checked against.
 */
export class CommandRunner {
  private runs = new Map<string, CommandRun>();
  /** runs we asked to die, so their exit reports `killed` rather than `exited` */
  private stopping = new Set<string>();
  /** callers awaiting a run's exit (agent restart: stop, wait, start) */
  private exitWaiters = new Map<string, Array<() => void>>();

  constructor(
    private storage: Storage,
    private sessions: SessionManager,
  ) {
    this.sessions.onExit(({ runId, exitCode }) => {
      const run = this.runs.get(runId);
      if (!run || run.status !== 'running') return;
      run.status = this.stopping.delete(runId) ? 'killed' : 'exited';
      run.exitCode = exitCode;
      run.endedAt = new Date().toISOString();
      broadcast({ type: 'command.run', run: { ...run } });
      for (const resolve of this.exitWaiters.get(runId) ?? []) resolve();
      this.exitWaiters.delete(runId);
      void this.storage
        .appendEvent({
          kind: 'command.run',
          actor: 'system',
          repoId: run.repoId,
          data: { action: run.status, name: run.name, command: run.command, exitCode },
        })
        .catch(() => {});
      this.trim();
    });
  }

  /** Newest first; running runs always survive trimming. */
  list(): CommandRun[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(runId: string): CommandRun | undefined {
    return this.runs.get(runId);
  }

  /** Live runs — `service` ones are what the header indicator counts. */
  running(): CommandRun[] {
    return this.list().filter((r) => r.status === 'running');
  }

  /** The live run of a command definition, if any (one at a time). */
  runningFor(commandId: string): CommandRun | undefined {
    return this.running().find((r) => r.commandId === commandId);
  }

  /** The newest run of a definition, live or finished — what an agent's logs read. */
  latestFor(commandId: string): CommandRun | undefined {
    return this.list().find((r) => r.commandId === commandId);
  }

  /**
   * The last `bytes` of a run's terminal output, ANSI stripped, for an agent
   * that cannot attach a terminal. Readable as long as the PTY session is kept
   * (a finished one until the session TTL); null when it is gone.
   */
  tail(runId: string, bytes: number): string | null {
    const buf = this.sessions.get(runId)?.buffer.snapshot();
    if (!buf) return null;
    return plainText(buf.subarray(Math.max(0, buf.length - bytes)).toString('utf8'));
  }

  /** Resolves true once the run is no longer `running`, false after `ms`. */
  waitForExit(runId: string, ms: number): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'running') return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const list = this.exitWaiters.get(runId);
        const at = list?.indexOf(done) ?? -1;
        if (list && at >= 0) list.splice(at, 1);
        if (list?.length === 0) this.exitWaiters.delete(runId);
        resolve(false);
      }, ms);
      const list = this.exitWaiters.get(runId) ?? [];
      list.push(done);
      this.exitWaiters.set(runId, list);
    });
  }

  /**
   * `ownerTaskId` is set when an agent starts it (docs/commands.md § Agent API):
   * that task's sessions may stop it again; nobody else's agent may.
   */
  async start(command: RepoCommand, repo: Repo, actor: string, ownerTaskId: string | null = null): Promise<CommandRun> {
    const existing = this.runningFor(command.id);
    if (existing) {
      const err = new Error(`"${command.name}" is already running`) as Error & { conflict?: true };
      err.conflict = true;
      throw err;
    }
    // Every failure below is a 400 with a readable reason: unparseable command,
    // escaping cwd, missing binary. Nothing is recorded for an attempt that
    // never produced a process.
    const cwd = resolveCommandCwd(repo.path, command.cwd);
    const argv = parseCommandLine(command.command);
    const bin = resolveBin(argv[0], cwd, repo.path);

    const id = `cmd-${randomUUID()}`;
    const session = this.sessions.spawn({
      runId: id,
      cmd: bin,
      args: argv.slice(1),
      cwd,
      // Colour: the process gets a real tty, and FORCE_COLOR settles the
      // node tools that check for CI rather than for a tty.
      env: { FORCE_COLOR: '1' },
    });
    const run: CommandRun = {
      id,
      commandId: command.id,
      repoId: repo.id,
      repoName: repo.name,
      name: command.name,
      command: command.command,
      kind: command.kind,
      cwd,
      status: 'running',
      pid: session.pty.pid,
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      startedBy: actor,
      ownerTaskId,
    };
    this.runs.set(id, run);
    broadcast({ type: 'command.run', run: { ...run } });
    await this.storage.appendEvent({
      kind: 'command.run',
      actor,
      repoId: repo.id,
      data: { action: 'started', name: command.name, command: command.command, cwd, pid: run.pid, ownerTaskId },
    });
    this.trim();
    return run;
  }

  /** SIGHUP now, SIGKILL after 5s (SessionManager.kill). The exit handler is
   *  what flips the status, so a process that ignores the signal stays
   *  truthfully `running` until it actually dies. */
  stop(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'running') return false;
    this.stopping.add(runId);
    const killed = this.sessions.kill(runId);
    if (!killed) this.stopping.delete(runId);
    return killed;
  }

  /** The definition was deleted while a run of it was alive: the run keeps its
   *  snapshot (name, command, cwd) and simply stops pointing at a row that no
   *  longer exists. Killing it instead would be a surprise — a dev server the
   *  user is browsing must not die because its shortcut was tidied away. */
  detach(commandId: string): void {
    for (const run of this.runs.values()) {
      if (run.commandId !== commandId) continue;
      run.commandId = null;
      broadcast({ type: 'command.run', run: { ...run } });
    }
  }

  /** Process shutdown: never leave dev servers parented to a dead server. */
  stopAll(): void {
    for (const run of this.running()) this.stop(run.id);
  }

  /** Drops finished runs from the list (their PTYs are already gone). */
  clearFinished(): number {
    let n = 0;
    for (const [id, run] of this.runs) {
      if (run.status !== 'running') {
        this.runs.delete(id);
        n++;
      }
    }
    return n;
  }

  private trim(): void {
    const finished = this.list().filter((r) => r.status !== 'running');
    for (const run of finished.slice(MAX_FINISHED)) this.runs.delete(run.id);
  }
}

/**
 * Terminal output → what a reader sees: CSI/OSC escapes dropped (same patterns
 * as limit.ts), CRLF normalised, and a carriage-return redraw (spinners,
 * progress bars) collapsed to the line's last frame.
 */
function plainText(raw: string): string {
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[()][0-9A-Za-z]|\x1b[=>78]/g, '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => {
        const l = line.replace(/\r+$/, '');
        return l.slice(l.lastIndexOf('\r') + 1);
      })
      .join('\n')
  );
}
