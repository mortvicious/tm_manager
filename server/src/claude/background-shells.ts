import { open, lstat } from 'node:fs/promises';
import type { BackgroundShell, BackgroundShellOutput } from '@tm/shared';
import { broadcast } from '../events.ts';
import type { SessionManager } from '../pty/session-manager.ts';
import type { Storage } from '../storage/types.ts';
import { killShellGroup, reportedOutputPath, shellDetails, shellProcessFor, shellProcesses } from './shells.ts';

/**
 * Agents' background shells (docs/terminals.md § Background shells).
 *
 * The CLI tells us about them only in the `background_tasks` list of a Stop or
 * SubagentStop payload (`{ id, type: 'shell', status, command, description }`
 * — no pid, no path). Each run's latest list is kept here, in memory, until
 * the run ends; the transcript adds the launch time and the output file the
 * CLI reported (`shellDetails`), and a sweep of the live claude processes
 * (`shellProcesses`) adds the pid and whether the shell is still alive — the
 * payload is a snapshot taken at the end of a turn, and a shell can exit or
 * start between two of them. A shell the CLI already reported finished is
 * not probed again.
 */

/** how many shells a run keeps listed — the newest win */
const MAX_PER_RUN = 20;
/** the liveness sweep's cadence while any listed shell may still be running */
const SWEEP_MS = 5_000;
/** the most output one read returns (the viewer pages forward from there) */
const MAX_READ = 256 * 1024;
/** what the viewer is shown first: the end of the file */
const INITIAL_TAIL = 64 * 1024;

interface Entry {
  id: string;
  command: string;
  description: string | null;
  cliStatus: string;
  /** our own observation of the process (`running` until a sweep says otherwise) */
  state: 'running' | 'exited' | 'killed';
  pid: number | null;
  seenAt: number;
  startedAt: number | null;
  outputPath: string | null;
  /** the transcript has been read for it (found or not) — read once */
  described: boolean;
}

interface RunShells {
  runId: string;
  taskId: string;
  repoId: string;
  transcriptPath: string | null;
  shells: Map<string, Entry>;
}

/** Hooks into the orchestrator's wait bookkeeping. */
export interface ShellWaitHooks {
  /** does this shell currently count toward the run's `waiting` park? */
  holdsWait(runId: string, shellId: string, now: number, shellWaitMs: number): boolean;
  /** shells of this run were killed: ignore them and let the park re-evaluate */
  afterKill(runId: string, shellIds: string[], actor: string): Promise<void>;
}

export class BackgroundShells {
  private readonly runs = new Map<string, RunShells>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping = false;
  private lastBroadcast = '[]';

  constructor(
    private storage: Storage,
    private sessions: SessionManager,
    private hooks: ShellWaitHooks,
  ) {}

  /**
   * A Stop / SubagentStop payload of a live worker run: take its shell entries
   * as the run's latest list. An entry the list no longer names is kept (its
   * output stays watchable until the run ends) and left to the sweep.
   */
  async record(runId: string, body: unknown): Promise<void> {
    const list = (body as { background_tasks?: unknown } | null)?.background_tasks;
    if (!Array.isArray(list) || !this.sessions.get(runId)) return;
    const shellsInPayload = list.filter(
      (t): t is Record<string, unknown> =>
        typeof t === 'object' && t !== null && (t as { type?: unknown }).type === 'shell',
    );
    let found = this.runs.get(runId);
    if (!found && !shellsInPayload.length) return;
    if (!found) {
      const run = await this.storage.getRun(runId);
      if (!run || run.mode !== 'worker' || !run.taskId || !this.sessions.get(runId)) return;
      // two hooks racing past the read above must share one record
      found = this.runs.get(runId) ?? {
        runId,
        taskId: run.taskId,
        repoId: run.repoId ?? '',
        transcriptPath: run.transcriptPath ?? null,
        shells: new Map(),
      };
      this.runs.set(runId, found);
    }
    const rec = found;
    const tp = (body as { transcript_path?: unknown }).transcript_path;
    if (typeof tp === 'string' && tp) rec.transcriptPath = tp;
    const now = Date.now();
    for (const t of shellsInPayload) {
      const id = t.id;
      if (typeof id !== 'string' || !id) continue;
      const cliStatus = typeof t.status === 'string' ? t.status : 'unknown';
      const prev = rec.shells.get(id);
      const live = cliStatus === 'running' || cliStatus === 'pending';
      if (prev) {
        prev.cliStatus = cliStatus;
        // the CLI saw it end: believe it; a kill we made stays `killed`
        if (!live && prev.state === 'running') prev.state = 'exited';
        continue;
      }
      rec.shells.set(id, {
        id,
        command: typeof t.command === 'string' ? t.command : '',
        description: typeof t.description === 'string' && t.description ? t.description : null,
        cliStatus,
        state: live ? 'running' : 'exited',
        pid: null,
        seenAt: now,
        startedAt: null,
        outputPath: null,
        described: false,
      });
    }
    // newest MAX_PER_RUN, finished ones dropped first
    if (rec.shells.size > MAX_PER_RUN) {
      const order = [...rec.shells.values()].sort(
        (a, b) => Number(a.state === 'running') - Number(b.state === 'running') || a.seenAt - b.seenAt,
      );
      for (const e of order.slice(0, rec.shells.size - MAX_PER_RUN)) rec.shells.delete(e.id);
    }
    await this.describe(rec);
    await this.sweep();
  }

  /** The run is over: its shells are no longer ours to show. */
  forgetRun(runId: string): void {
    if (!this.runs.delete(runId)) return;
    void this.publish();
  }

  /** Every listed shell of every live worker run, newest first. */
  async list(): Promise<BackgroundShell[]> {
    const settings = await this.storage.getSettings();
    const shellWaitMs = settings['agent.shellWaitMinutes'] * 60_000;
    const now = Date.now();
    const out: BackgroundShell[] = [];
    for (const rec of this.runs.values()) {
      const task = await this.storage.getTask(rec.taskId);
      for (const e of rec.shells.values()) {
        out.push({
          runId: rec.runId,
          taskId: rec.taskId,
          taskTitle: task?.title ?? '',
          repoId: rec.repoId,
          shellId: e.id,
          command: e.command,
          description: e.description,
          cliStatus: e.cliStatus,
          state: e.state,
          pid: e.pid,
          startedAt: new Date(e.startedAt ?? e.seenAt).toISOString(),
          startedKnown: e.startedAt !== null,
          holdsWait: e.state === 'running' && this.hooks.holdsWait(rec.runId, e.id, now, shellWaitMs),
          hasOutput: e.outputPath !== null,
        });
      }
    }
    return out.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }

  /**
   * Kill one shell (`shellId`) or every running shell of the given runs
   * (`shellId` null). The pid is re-resolved from a FRESH process scan right
   * here — a direct child of this run's claude, leading its own group, tied to
   * the id by its stdout file — never taken from an earlier sweep or from the
   * request, and its whole group is SIGTERMed. Each kill is a `shell.killed`
   * audit row; then the run's park (if any) re-evaluates.
   */
  async kill(
    targets: { runId: string; shellId: string | null }[],
    actor: string,
  ): Promise<{
    killed: { runId: string; shellId: string }[];
    missed: { runId: string; shellId: string; reason: string }[];
  }> {
    const killed: { runId: string; shellId: string }[] = [];
    const missed: { runId: string; shellId: string; reason: string }[] = [];
    const pids = new Map<string, number>();
    for (const t of targets) {
      const pid = this.sessions.get(t.runId)?.pty.pid;
      if (pid) pids.set(t.runId, pid);
    }
    const procs = await shellProcesses([...pids.values()]);
    for (const t of targets) {
      const rec = this.runs.get(t.runId);
      const claudePid = pids.get(t.runId);
      const entries = rec
        ? [...rec.shells.values()].filter((e) => (t.shellId ? e.id === t.shellId : e.state === 'running'))
        : [];
      if (t.shellId && !entries.length) {
        missed.push({
          runId: t.runId,
          shellId: t.shellId,
          reason: 'no such background shell',
        });
        continue;
      }
      if (!rec || !claudePid) {
        for (const e of entries)
          missed.push({
            runId: t.runId,
            shellId: e.id,
            reason: 'the agent session is not live',
          });
        continue;
      }
      const done: string[] = [];
      for (const e of entries) {
        if (e.state !== 'running') {
          missed.push({
            runId: t.runId,
            shellId: e.id,
            reason: 'already finished',
          });
          continue;
        }
        const p = shellProcessFor(procs, claudePid, e.id, e.command);
        if (!p) {
          e.state = 'exited';
          e.pid = null;
          missed.push({
            runId: t.runId,
            shellId: e.id,
            reason: 'no running process found for it',
          });
          continue;
        }
        const ok = killShellGroup(p.pid);
        e.state = ok ? 'killed' : 'exited';
        e.pid = null;
        if (!ok) {
          missed.push({
            runId: t.runId,
            shellId: e.id,
            reason: 'it exited before the signal',
          });
          continue;
        }
        done.push(e.id);
        killed.push({ runId: t.runId, shellId: e.id });
        await this.storage.appendEvent({
          kind: 'shell.killed',
          actor,
          runId: t.runId,
          taskId: rec.taskId,
          repoId: rec.repoId,
          data: { shellId: e.id, command: e.command.slice(0, 500), pid: p.pid },
        });
      }
      if (done.length) await this.hooks.afterKill(t.runId, done, actor);
    }
    await this.publish();
    return { killed, missed };
  }

  /**
   * A slice of a shell's output file, read-only. Only the path the CLI
   * reported for THIS run's shell is ever opened (re-checked here, and it
   * must still be a regular file, not a link); from `from` (bytes) when
   * given, else the last `INITIAL_TAIL` bytes.
   */
  async output(
    runId: string,
    shellId: string,
    from: number | null,
  ): Promise<BackgroundShellOutput | { error: string; code: number }> {
    const e = this.runs.get(runId)?.shells.get(shellId);
    if (!e) return { error: 'no such background shell', code: 404 };
    const p = e.outputPath;
    if (!p || !reportedOutputPath(p, shellId))
      return {
        error: 'the CLI reported no output file for this shell',
        code: 404,
      };
    let st;
    try {
      st = await lstat(p);
    } catch {
      return { error: 'the output file is gone', code: 404 };
    }
    if (!st.isFile()) return { error: 'the output file is not a regular file', code: 404 };
    const size = st.size;
    let start = from === null ? Math.max(0, size - INITIAL_TAIL) : Math.min(Math.max(0, from), size);
    // a file that shrank (rewritten) starts over from its end
    if (from !== null && from > size) start = Math.max(0, size - INITIAL_TAIL);
    const len = Math.min(MAX_READ, size - start);
    if (len <= 0)
      return {
        text: '',
        from: start,
        next: start,
        size,
        reset: from !== null && from > size,
      };
    const fh = await open(p, 'r');
    try {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, start);
      let end = bytesRead;
      // never split a UTF-8 sequence: hold back an incomplete tail for the next read
      let back = 0;
      while (back < 3 && end - back - 1 >= 0 && (buf[end - back - 1] & 0xc0) === 0x80) back++;
      if (end - back - 1 >= 0) {
        const lead = buf[end - back - 1];
        const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
        if (need > back + 1) end = end - back - 1;
      }
      // a first read from the middle starts at a line boundary
      let skip = 0;
      if (from === null && start > 0) {
        const nl = buf.indexOf(0x0a);
        if (nl >= 0 && nl < end) skip = nl + 1;
      }
      return {
        text: buf.subarray(skip, end).toString('utf8'),
        from: start + skip,
        next: start + end,
        size,
        reset: from !== null && from > size,
      };
    } finally {
      await fh.close();
    }
  }

  /** Read the transcript once per shell for its launch time and output path. */
  private async describe(rec: RunShells): Promise<void> {
    const todo = [...rec.shells.values()].filter((e) => !e.described);
    if (!todo.length || !rec.transcriptPath) return;
    const found = await shellDetails(
      rec.transcriptPath,
      todo.map((e) => e.id),
    );
    for (const e of todo) {
      e.described = true;
      const d = found.get(e.id);
      if (!d) continue;
      if (d.startedAt !== null) e.startedAt = d.startedAt;
      if (d.outputPath) e.outputPath = d.outputPath;
    }
  }

  /**
   * Which listed shells are still alive, and their pids. A shell whose
   * transcript said nothing (a subagent's) gets its output path from its own
   * stdout, when that is exactly `…/tasks/<id>.output`.
   */
  async refresh(): Promise<void> {
    await this.sweep();
  }

  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const pids = new Map<string, number>();
      for (const rec of this.runs.values()) {
        const live = this.sessions.get(rec.runId);
        if (!live) {
          this.runs.delete(rec.runId);
          continue;
        }
        if ([...rec.shells.values()].some((e) => e.state === 'running')) pids.set(rec.runId, live.pty.pid);
      }
      const procs = pids.size ? await shellProcesses([...pids.values()]) : [];
      for (const [runId, claudePid] of pids) {
        const rec = this.runs.get(runId);
        if (!rec) continue;
        for (const e of rec.shells.values()) {
          if (e.state !== 'running') continue;
          const p = shellProcessFor(procs, claudePid, e.id, e.command);
          if (!p) {
            e.state = 'exited';
            e.pid = null;
            continue;
          }
          e.pid = p.pid;
          if (!e.outputPath && p.stdout && reportedOutputPath(p.stdout, e.id)) e.outputPath = p.stdout;
        }
      }
    } finally {
      this.sweeping = false;
    }
    await this.publish();
    this.schedule();
  }

  private schedule(): void {
    const anyRunning = [...this.runs.values()].some((r) => [...r.shells.values()].some((e) => e.state === 'running'));
    if (!anyRunning) {
      if (this.sweepTimer) clearTimeout(this.sweepTimer);
      this.sweepTimer = null;
      return;
    }
    if (this.sweepTimer) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      void this.sweep().catch((err) =>
        console.warn('[background-shells] sweep failed:', err instanceof Error ? err.message : err),
      );
    }, SWEEP_MS);
    this.sweepTimer.unref();
  }

  /** Broadcast the list when it changed (the elapsed time is the client's to tick). */
  async publish(): Promise<void> {
    if (!this.runs.size && this.lastBroadcast === '[]') return;
    const shells = await this.list().catch(() => null);
    if (!shells) return;
    const key = JSON.stringify(shells);
    if (key === this.lastBroadcast) return;
    this.lastBroadcast = key;
    broadcast({ type: 'background-shells', shells });
  }
}
