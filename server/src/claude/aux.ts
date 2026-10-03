import { randomBytes } from 'node:crypto';
import type { EffortLevel, Run, RunKind, RunStats } from '@tm/shared';
import { broadcast } from '../events.ts';
import type { SessionManager } from '../pty/session-manager.ts';
import type { Storage } from '../storage/types.ts';
import { summarizeRun, summarizeTranscript } from './stats.ts';

/**
 * Every claude this server spawns that is NOT a task's worker — adversarial
 * review, feature planning and plan review, analysis, resume-gate compaction,
 * reports, chat turns, commit messages — runs here, as a real interactive
 * `claude` in a PTY of its OWN pool (docs/design.md § PTY sessions). There is
 * no `claude -p` left in this server (docs/decisions.md 2026-09-24).
 *
 * What an interactive session does not have is the `-p` JSON envelope, so:
 *
 *  - **Completion** comes from the hooks injected through `--settings`, like a
 *    worker: Stop (the turn ended), StopFailure (the API refused the turn —
 *    `model_not_found` is how an unavailable model shows up), SessionEnd, and
 *    process exit only as the backstop. `compact` settles on a
 *    `compact_boundary` instead, because `/compact` ends no turn.
 *  - **Structured results** are read from the Stop hook's own
 *    `last_assistant_message` (the transcript as fallback): the prompt asks for
 *    a fenced ```json block, the caller's `accept` validates it with the same
 *    zod schema `--json-schema` used to enforce, and a block that does not
 *    validate is answered by TYPING a correction into the same live session —
 *    bounded by `maxRetries`, never a fresh process that would re-buy context.
 *
 * Once a result is accepted the process is ended: the terminal (ring buffer)
 * stays attachable until the pool's TTL disposes it, but no idle claude is
 * left holding the session id, which a later `--resume` of the same session
 * (a chat's next turn, the worker a compaction ran for) would race. `done`
 * resolves only AFTER the process has exited, for exactly that reason.
 *
 * None of this takes a worker slot: the pool is separate from the agents'
 * `SessionManager` (as repo commands are), so orchestrator concurrency and the
 * worker PTY cap never see it. The callers keep their own bounds
 * (`chat.concurrency`, reports' MAX_CONCURRENT).
 */

export type AuxKind = Exclude<RunKind, 'worker'>;

/**
 * The permission denials every read-only role carried as `claude -p`, kept
 * verbatim (analysis/review/compact/report/commit and chat read mode).
 */
export const READ_ONLY_DISALLOWED = ['Edit', 'Write', 'NotebookEdit', 'Bash'];

/**
 * The tool SCHEMAS a read-only session is given (`--tools`). What `-p` +
 * `dontAsk` + the denials above effectively left usable — reading, searching,
 * delegating a read (Agent) and a todo list — minus everything else's
 * schemas, so the interactive preamble comes out SMALLER than `-p`'s
 * (docs/token-budget.md § Aux sessions). Never wider than the old set:
 * the denials still ride along, and `dontAsk` still refuses any prompt.
 */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'Agent', 'TodoWrite'];

/** What the caller's validator answers for a turn's final text. */
export type AuxAccept<T> = { ok: true; value: T } | { ok: false; error: string };

export interface AuxSpec<T> {
  kind: AuxKind;
  /** the task / feature / chat / report / repo the session is about (Run.subjectId) */
  subjectId: string | null;
  repoId: string | null;
  /** runs-list label, also the restart guard's wording */
  label: string;
  cwd: string;
  model: string;
  effort?: EffortLevel | string | null;
  /** the first turn — passed as the positional prompt after `--` */
  prompt: string;
  /** continue this claude session (`--resume`) — chat turns, compaction */
  resumeSessionId?: string | null;
  /** the resumed session's transcript, so the run reports only its OWN usage */
  baselineTranscript?: string | null;
  /**
   * Built-in tool SCHEMAS the session is given (`--tools`, docs/token-budget.md).
   * null = the CLI default set (chat keeps the terminal a human would open).
   */
  tools: string[] | null;
  /** permission denials, unchanged from the `-p` era — interactivity must not widen them */
  disallowedTools: string[];
  /**
   * `dontAsk` = deny anything that would prompt (every read-only role);
   * `bypass` = `--dangerously-skip-permissions` (chat write mode only).
   */
  permission: 'dontAsk' | 'bypass';
  /**
   * Trim the fixed preamble: `--no-chrome` + `disableBundledSkills`. Every role
   * except chat — a chat is the terminal the human would have opened.
   */
  lean: boolean;
  timeoutMs: number;
  /**
   * How the session ends:
   *  - `result` (default): each Stop's final text goes to `accept`;
   *  - `compact`: `isCompacted(transcriptPath)` is polled and asked on the
   *    SessionStart(source: compact) hook; a Stop, a StopFailure or the CLI's
   *    idle notification without it is a failure.
   */
  completion?: 'result' | 'compact';
  accept?: (text: string) => AuxAccept<T>;
  isCompacted?: (transcriptPath: string) => Promise<boolean>;
  /** corrections typed into the session after an invalid result (default 2) */
  maxRetries?: number;
  signal?: AbortSignal;
}

export interface AuxOutcome<T> {
  /** `aborted` = WE stopped it (abort, /killall, shutdown); `timeout` = its own deadline */
  status: 'ok' | 'failed' | 'aborted' | 'timeout';
  value: T | null;
  /** the final assistant text of the last turn */
  text: string | null;
  error: string | null;
  /**
   * The CLI's own failure code — StopFailure's `error` (`model_not_found`,
   * `rate_limit`, `server_error`…) — and null for every other outcome. The
   * one input `modelUnavailable` reads: free text is never classified.
   */
  code: string | null;
  runId: string;
  sessionId: string | null;
  transcriptPath: string | null;
  stats: RunStats | null;
}

interface Live {
  spec: AuxSpec<unknown>;
  runId: string;
  startedAt: number;
  retries: number;
  /** set once, by the first thing that decides the result */
  outcome: AuxOutcome<unknown> | null;
  exited: boolean;
  timers: NodeJS.Timeout[];
  resolve: (o: AuxOutcome<unknown>) => void;
  done: Promise<AuxOutcome<unknown>>;
  offAbort?: () => void;
}

/** How long a correction's text sits in the prompt before Enter is sent. */
const TYPE_ENTER_DELAY_MS = 400;
const COMPACT_POLL_MS = 2_000;
/** after a settle, how long `done` waits for the process to go before giving up on it */
const EXIT_WAIT_MS = 8_000;

export class AuxRunner {
  private live = new Map<string, Live>();
  private listeners = new Set<() => void>();
  /** see `stoppedSince` */
  private lastStopAll = 0;

  constructor(
    private storage: Storage,
    private sessions: SessionManager,
    private callbackUrl: string,
  ) {
    // The pool is ours alone, so its single exit slot is too.
    sessions.onExit(({ runId, exitCode, signal }) => void this.handleExit(runId, exitCode, signal));
  }

  /** The pool, for the terminal WebSocket. */
  get pool(): SessionManager {
    return this.sessions;
  }

  /** Notified whenever the live set changes, so the UI's session count can follow. */
  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Labels of the aux sessions working right now (restart guard, /killall). */
  liveLabels(): string[] {
    return [...this.live.values()].filter((l) => !l.exited).map((l) => l.spec.label);
  }

  liveCount(): number {
    return this.liveLabels().length;
  }

  isLive(runId: string): boolean {
    const l = this.live.get(runId);
    return !!l && !l.exited;
  }

  /**
   * Did a global stop (`stopAll` — /killall, forced restart, shutdown) happen
   * at or after `since`? A session killed by that sweep did not FAIL, and the
   * difference matters to anything that answers a failure with more work: the
   * resume gate answers a failed compaction by spawning an agent.
   */
  stoppedSince(since: number): boolean {
    return this.lastStopAll >= since;
  }

  /**
   * Start a session. Resolves once the PTY is spawned (the run row exists and
   * is broadcast); `done` resolves after the process has exited. Throws only
   * when nothing could be spawned — the run row is then already closed.
   */
  async start<T>(spec: AuxSpec<T>): Promise<{ runId: string; done: Promise<AuxOutcome<T>> }> {
    const runToken = randomBytes(24).toString('hex');
    let statsBaseline: RunStats | null = null;
    if (spec.resumeSessionId && spec.baselineTranscript) {
      statsBaseline = (await summarizeTranscript(spec.baselineTranscript, spec.model).catch(() => null))?.stats ?? null;
    }
    const run = await this.storage.createRun({
      mode: 'aux',
      kind: spec.kind,
      subjectId: spec.subjectId,
      label: spec.label,
      repoId: spec.repoId,
      model: spec.model,
      effort: (spec.effort ?? null) as Run['effort'],
      runToken,
      statsBaseline,
    });

    let resolve!: (o: AuxOutcome<unknown>) => void;
    const done = new Promise<AuxOutcome<unknown>>((r) => (resolve = r));
    const live: Live = {
      spec: spec as AuxSpec<unknown>,
      runId: run.id,
      startedAt: Date.now(),
      retries: 0,
      outcome: null,
      exited: false,
      timers: [],
      resolve,
      done,
    };
    this.live.set(run.id, live);

    try {
      if (spec.signal?.aborted) throw new Error('aborted before start');
      const session = this.sessions.spawn({
        runId: run.id,
        cmd: 'claude',
        args: buildAuxArgs(spec),
        cwd: spec.cwd,
        env: { TM_RUN_ID: run.id, TM_TOKEN: runToken, TM_CALLBACK_URL: this.callbackUrl },
      });
      const updated = (await this.storage.updateRun(run.id, { pid: session.pty.pid })) ?? run;
      broadcast({ type: 'run.started', run: updated });
    } catch (err) {
      this.live.delete(run.id);
      const closed = await this.storage.updateRun(run.id, {
        status: 'exited',
        exitCode: -1,
        endedAt: new Date().toISOString(),
      });
      if (closed) broadcast({ type: 'run.exited', run: closed });
      throw err;
    }
    this.notify();

    live.timers.push(setTimeout(() => this.stop(run.id, 'timeout'), spec.timeoutMs));
    if (spec.completion === 'compact') {
      live.timers.push(setInterval(() => void this.checkCompacted(live), COMPACT_POLL_MS));
    }
    if (spec.signal) {
      const onAbort = () => this.stop(run.id, 'aborted');
      spec.signal.addEventListener('abort', onAbort, { once: true });
      live.offAbort = () => spec.signal?.removeEventListener('abort', onAbort);
    }
    return { runId: run.id, done: done as Promise<AuxOutcome<T>> };
  }

  /**
   * `start` + `done`, with a spawn failure folded into a `failed` outcome —
   * the shape every caller wants when it has nothing to do in between.
   */
  async run<T>(spec: AuxSpec<T>, onStarted?: (runId: string) => void): Promise<AuxOutcome<T>> {
    try {
      const { runId, done } = await this.start(spec);
      onStarted?.(runId);
      return await done;
    } catch (err) {
      return {
        status: spec.signal?.aborted ? 'aborted' : 'failed',
        value: null,
        text: null,
        error: `could not start the ${spec.kind} session: ${(err as Error).message}`,
        code: null,
        runId: '',
        sessionId: null,
        transcriptPath: null,
        stats: null,
      };
    }
  }

  /** Resolves when the session's process is gone (immediately if it is not live). */
  whenDone(runId: string): Promise<void> {
    const l = this.live.get(runId);
    return l ? l.done.then(() => undefined) : Promise.resolve();
  }

  /** Stop one session — the runs list's Kill, a caller's abort. */
  abort(runId: string): boolean {
    if (!this.isLive(runId)) return false;
    this.stop(runId, 'aborted');
    return true;
  }

  /**
   * /killall, forced restart, shutdown: every live aux session. Returns the
   * labels of the ones THIS call stopped — a session already settling (its
   * result decided, its PTY on the way down) is not counted twice.
   */
  stopAll(): string[] {
    this.lastStopAll = Date.now();
    const stopped: string[] = [];
    for (const l of [...this.live.values()]) {
      if (l.exited || l.outcome) continue;
      this.stop(l.runId, 'aborted');
      stopped.push(l.spec.label);
    }
    return stopped;
  }

  // ---- hooks (routes/internal.ts forwards every aux run's hooks here) ----

  async hook(
    runId: string,
    event: 'session-start' | 'stop' | 'stop-failure' | 'session-end' | 'notification',
    body: unknown,
  ): Promise<void> {
    const live = this.live.get(runId);
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    await this.recordIdentity(runId, b);
    if (!live || live.outcome) return;

    if (event === 'session-start') {
      if (b.source === 'compact') await this.checkCompacted(live);
      return;
    }

    if (event === 'notification') {
      // The CLI's ~60s "waiting for your input" is not a prompt anybody has
      // to answer — it means the session went quiet. For a compaction that is
      // the end of the road (the boundary either landed or it never will).
      const msg = typeof b.message === 'string' ? b.message : '';
      if (/waiting for your input/i.test(msg)) {
        if (live.spec.completion === 'compact') await this.failUnlessCompacted(live, 'compaction went idle');
        return;
      }
      const run = await this.storage.getRun(runId);
      if (run && run.status === 'running' && !run.needsAttention) {
        const updated = await this.storage.updateRun(runId, { needsAttention: true });
        if (updated) broadcast({ type: 'run.needs-attention', run: updated });
      }
      return;
    }

    if (event === 'stop-failure') {
      const text = typeof b.last_assistant_message === 'string' ? b.last_assistant_message : null;
      const code = typeof b.error === 'string' ? b.error : 'error';
      this.settle(live, { status: 'failed', value: null, text, code, error: `${code}: ${text ?? 'the turn failed'}` });
      return;
    }

    if (event === 'session-end') {
      if (live.spec.completion === 'compact') await this.failUnlessCompacted(live, 'session ended');
      // No hook said why (a bad --resume, a refused flag): the CLI said it on
      // the terminal, and that tail is the only record of the reason.
      else
        this.settle(live, {
          status: 'failed',
          value: null,
          text: null,
          error: this.withTerminalTail(runId, 'session ended without a result'),
        });
      return;
    }

    // stop
    await this.clearAttention(runId);
    if (live.spec.completion === 'compact') {
      await this.failUnlessCompacted(live, 'the turn ended without compacting');
      return;
    }
    let text = typeof b.last_assistant_message === 'string' ? b.last_assistant_message : null;
    if (text === null) {
      // An older CLI without the field: the transcript's last assistant text.
      const run = await this.storage.getRun(runId);
      if (run) text = (await summarizeRun(run).catch(() => null))?.lastAssistantText ?? null;
    }
    const accept = live.spec.accept ?? ((t: string) => ({ ok: true as const, value: t }));
    const verdict = text !== null ? accept(text) : ({ ok: false, error: 'no final message' } as const);
    if (verdict.ok) {
      this.settle(live, { status: 'ok', value: verdict.value, text, error: null });
      return;
    }
    if (live.retries < (live.spec.maxRetries ?? 2)) {
      live.retries++;
      this.type(runId, correction(verdict.error));
      return;
    }
    this.settle(live, { status: 'failed', value: null, text, error: `invalid result: ${verdict.error}` });
  }

  // ---- internals ----

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // a broken listener must not break the spawn path
      }
    }
  }

  /** One line typed into the session's prompt, then Enter — as a human would. */
  private type(runId: string, line: string): void {
    this.sessions.input(runId, Buffer.from(line.replace(/\s+/g, ' ').trim()));
    setTimeout(() => this.sessions.input(runId, Buffer.from('\r')), TYPE_ENTER_DELAY_MS);
  }

  private async recordIdentity(runId: string, b: Record<string, unknown>): Promise<void> {
    const run = await this.storage.getRun(runId);
    if (!run) return;
    const patch: Parameters<Storage['updateRun']>[1] = {};
    if (typeof b.session_id === 'string' && !run.sessionId) patch.sessionId = b.session_id;
    if (typeof b.transcript_path === 'string' && !run.transcriptPath) patch.transcriptPath = b.transcript_path;
    if (Object.keys(patch).length) await this.storage.updateRun(runId, patch);
  }

  private async clearAttention(runId: string): Promise<void> {
    const run = await this.storage.getRun(runId);
    if (run?.needsAttention) {
      const updated = await this.storage.updateRun(runId, { needsAttention: false });
      if (updated) broadcast({ type: 'run.needs-attention', run: updated });
    }
  }

  private async compacted(live: Live): Promise<boolean> {
    const tp =
      live.spec.baselineTranscript ?? (await this.storage.getRun(live.runId))?.transcriptPath ?? null;
    if (!tp || !live.spec.isCompacted) return false;
    return live.spec.isCompacted(tp).catch(() => false);
  }

  private async checkCompacted(live: Live): Promise<void> {
    if (live.outcome || live.exited) return;
    if (await this.compacted(live)) this.settle(live, { status: 'ok', value: null, text: null, error: null });
  }

  private async failUnlessCompacted(live: Live, why: string): Promise<void> {
    if (await this.compacted(live)) this.settle(live, { status: 'ok', value: null, text: null, error: null });
    else this.settle(live, { status: 'failed', value: null, text: null, error: `${why} (no compact_boundary)` });
  }

  /**
   * `what` plus the last readable words on the session's terminal. When the
   * CLI quits without a hook naming the cause, its stderr went to the PTY —
   * the reason is there or nowhere. Bounded, so a caller's own truncation
   * keeps the whole of it.
   */
  private withTerminalTail(runId: string, what: string): string {
    let raw = '';
    try {
      const buf = this.sessions.get(runId)?.buffer.snapshot();
      if (buf) raw = buf.subarray(Math.max(0, buf.length - 8_000)).toString('utf8');
    } catch {
      // no buffer, no tail
    }
    const tail = readableTail(raw);
    return tail ? `${what} — terminal: ${tail}` : what;
  }

  private stop(runId: string, status: 'aborted' | 'timeout'): void {
    const live = this.live.get(runId);
    if (!live || live.exited) return;
    this.settle(live, {
      status,
      value: null,
      text: null,
      error: status === 'timeout' ? `timed out after ${duration(live.spec.timeoutMs)}` : 'stopped',
    });
  }

  /**
   * The first decision wins; every later one is ignored. Deciding ends the
   * process — `done` waits for its exit (`handleExit`), with a bounded wait so
   * a PTY that never reports its exit cannot hold a caller forever.
   */
  private settle(
    live: Live,
    o: Pick<AuxOutcome<unknown>, 'status' | 'value' | 'text' | 'error'> & { code?: string | null },
  ): void {
    if (live.outcome) return;
    live.outcome = { ...o, code: o.code ?? null, runId: live.runId, sessionId: null, transcriptPath: null, stats: null };
    for (const t of live.timers) clearTimeout(t);
    live.timers = [];
    live.offAbort?.();
    if (live.exited) {
      void this.finish(live, null);
      return;
    }
    if (!this.sessions.kill(live.runId)) {
      void this.finish(live, null);
      return;
    }
    live.timers.push(
      setTimeout(() => {
        if (!live.exited) void this.finish(live, null);
      }, EXIT_WAIT_MS),
    );
  }

  private async handleExit(runId: string, exitCode: number | null, signal?: number): Promise<void> {
    const live = this.live.get(runId);
    if (!live) return;
    live.exited = true;
    if (!live.outcome) {
      const how = signal ? `was killed by signal ${signal}` : `exited (code ${exitCode ?? '?'})`;
      live.outcome = {
        status: 'failed',
        value: null,
        text: null,
        error: this.withTerminalTail(runId, `claude ${how} without a result`),
        code: null,
        runId,
        sessionId: null,
        transcriptPath: null,
        stats: null,
      };
      for (const t of live.timers) clearTimeout(t);
      live.timers = [];
      live.offAbort?.();
    }
    await this.finish(live, exitCode);
  }

  private finishing = new Set<string>();

  private async finish(live: Live, exitCode: number | null): Promise<void> {
    if (this.finishing.has(live.runId)) return;
    this.finishing.add(live.runId);
    for (const t of live.timers) clearTimeout(t);
    const o = live.outcome!;
    try {
      const run = await this.storage.getRun(live.runId);
      const stats = run ? ((await summarizeRun(run).catch(() => null))?.stats ?? run.stats) : null;
      const updated = await this.storage.updateRun(live.runId, {
        status: o.status === 'aborted' ? 'killed' : 'exited',
        exitCode: o.status === 'ok' ? 0 : (exitCode ?? 1),
        needsAttention: false,
        endedAt: new Date().toISOString(),
        stats: stats ?? undefined,
      });
      o.sessionId = updated?.sessionId ?? run?.sessionId ?? null;
      o.transcriptPath = updated?.transcriptPath ?? run?.transcriptPath ?? null;
      o.stats = stats ?? null;
      if (updated) broadcast({ type: 'run.exited', run: updated });
    } catch {
      // the outcome still has to reach the caller
    } finally {
      live.exited = true;
      this.live.delete(live.runId);
      this.finishing.delete(live.runId);
      this.notify();
      live.resolve(o);
    }
  }
}

/** The argv of an aux session — args array only, never a shell string. */
export function buildAuxArgs(spec: AuxSpec<unknown>): string[] {
  const hook = (path: string) =>
    `curl -s --max-time 5 -X POST -H "x-tm-token: $TM_TOKEN" -H "content-type: application/json" --data-binary @- "$TM_CALLBACK_URL/api/internal/runs/$TM_RUN_ID/${path}" >/dev/null 2>&1 || true`;
  const on = (path: string) => [{ hooks: [{ type: 'command', command: hook(path) }] }];
  const settings: Record<string, unknown> = {
    hooks: {
      SessionStart: on('session-start'),
      Stop: on('stop'),
      StopFailure: on('stop-failure'),
      SessionEnd: on('session-end'),
      Notification: on('needs-attention'),
    },
  };
  if (spec.lean) settings.disableBundledSkills = true;

  const args: string[] = [];
  if (spec.resumeSessionId) args.push('--resume', spec.resumeSessionId);
  args.push('--model', spec.model);
  if (spec.effort) args.push('--effort', String(spec.effort));
  args.push('--settings', JSON.stringify(settings));
  if (spec.permission === 'bypass') args.push('--dangerously-skip-permissions');
  else args.push('--permission-mode', 'dontAsk');
  // Variadic flags take the `--flag=value` form (docs/token-budget.md): as
  // two argv elements the parser would keep consuming.
  if (spec.tools) args.push(`--tools=${spec.tools.join(',')}`);
  if (spec.disallowedTools.length) args.push(`--disallowedTools=${spec.disallowedTools.join(',')}`);
  if (spec.lean) args.push('--no-chrome');
  // `--` ends the options: a chat message that starts with `-` is a prompt.
  args.push('--', spec.prompt);
  return args;
}

/** "10 min", or "45 s" under a minute — a round-down to "0 min" names no deadline at all. */
function duration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

/** The typed correction after a final message whose result block did not validate. */
function correction(error: string): string {
  return (
    `Your last message did not end with a valid result block (${error.slice(0, 300)}). ` +
    'Reply now with ONLY the fenced ```json block described in your instructions, matching its schema exactly — no other text.'
  );
}

/**
 * The instruction appended to every structured-result prompt — the interactive
 * stand-in for `--json-schema`. The schema is the SAME object the `-p` flag
 * used to receive; the caller's zod schema still does the validating.
 */
export function resultInstruction(schema: object | string): string {
  return [
    '',
    '## How to return your result',
    '',
    'You are running in an interactive terminal that a human may be watching (and may type into).',
    'When you are done, END your final message with your result as ONE fenced ```json code block',
    'that validates against the JSON Schema below. Nothing may follow the block. Prose before it is fine.',
    '',
    '```json',
    typeof schema === 'string' ? schema : JSON.stringify(schema),
    '```',
  ].join('\n');
}

/**
 * The JSON value at the end of a final message: the LAST ```json fence, else
 * the last bare fence, else the whole text. null when none of them parse.
 */
export function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(json)?[ \t]*\r?\n([\s\S]*?)```/g)];
  const tagged = fences.filter((m) => m[1]);
  for (const m of [...tagged.reverse(), ...fences.filter((f) => !f[1]).reverse()]) {
    try {
      return JSON.parse(m[2]);
    } catch {
      // try the next candidate
    }
  }
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

/** `accept` for a zod-like schema over the fenced JSON block. */
export function acceptJson<T>(schema: {
  safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { message: string } };
}): (text: string) => AuxAccept<T> {
  return (text) => {
    const raw = extractJson(text);
    if (raw === null) return { ok: false, error: 'no ```json block found' };
    const parsed = schema.safeParse(raw);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: parsed.error.message };
  };
}

/**
 * The last readable words of a terminal: CSI/OSC/charset escapes removed (a
 * cursor-forward is how the TUI draws a space, so it becomes one), lines
 * collapsed, the CLI's own "Resume this session with: claude --resume …"
 * epilogue dropped (it closes every exit and would push the reason out), and
 * the last `max` characters kept. '' when nothing readable is left.
 */
export function readableTail(raw: string, max = 300): string {
  /* eslint-disable no-control-regex */
  const text = raw
    .replace(/\x1b\[\d*C/g, ' ')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b[ -~]?/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' ');
  /* eslint-enable no-control-regex */
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l && !/^Resume this session with:?$/i.test(l) && !/^claude --resume \S+$/.test(l));
  const joined = lines.join(' | ');
  return joined.length > max ? '…' + joined.slice(joined.length - max) : joined;
}

/**
 * StopFailure codes that mean "this model cannot serve this account". The
 * code is the CLI's own classification (measured: a bogus `--model` fires
 * StopFailure `error: "model_not_found"`), so it is the whole test — never
 * the free text: a `server_error` saying "Service Unavailable", a
 * `rate_limit` naming the model, or an argv echo all mention a model without
 * the model being the problem, and a false positive here swaps every later
 * Fable run for Opus until restart.
 */
const MODEL_UNAVAILABLE_CODES = new Set(['model_not_found']);

/**
 * The model-unavailable test the Fable→Opus fallbacks share. Only a `failed`
 * outcome qualifies: `timeout` (its own deadline) and `aborted` (we stopped
 * it) say nothing about the model and must never buy a second run.
 */
export function modelUnavailable(o: AuxOutcome<unknown>): boolean {
  return o.status === 'failed' && o.code !== null && MODEL_UNAVAILABLE_CODES.has(o.code);
}

/**
 * The tier every unavailable model lands on. A named constant because the
 * retry guard compares against it: if the REQUESTED model already is the
 * fallback there is nothing left to try, and a literal that drifted from the
 * one assigned would retry the same unavailable model forever.
 */
export const FALLBACK_MODEL = 'claude-opus-5-5';

/**
 * Set once a FABLE request came back `model_not_found`, and read by every
 * role (review, plan/plan-review, report) until restart: availability is a
 * fact about the account, not about the caller. Only a Fable failure sets it —
 * a per-task Sonnet that is unavailable falls back for that run only.
 */
let fableUnavailable = false;

/**
 * The one Fable→Opus fallback (review.ts, feature-analysis.ts,
 * reports/service.ts): run the requested model — straight to FALLBACK_MODEL
 * for a Fable request once Fable is known unavailable — and, on
 * `modelUnavailable` only, run once more on FALLBACK_MODEL at
 * `fallbackEffort`. `mayRetry` lets a caller veto the second run (a report
 * deleted mid-run). Returns what ACTUALLY ran, which the callers record.
 */
export async function withModelFallback<T>(
  requested: { model: string; effort: string | null },
  fallbackEffort: string,
  attempt: (model: string, effort: string | null) => Promise<AuxOutcome<T>>,
  mayRetry: () => boolean = () => true,
): Promise<{ res: AuxOutcome<T>; model: string; effort: string | null }> {
  const isFable = /fable/i.test(requested.model);
  let model = fableUnavailable && isFable ? FALLBACK_MODEL : requested.model;
  let effort = model === requested.model ? requested.effort : fallbackEffort;
  let res = await attempt(model, effort);
  if (modelUnavailable(res) && model !== FALLBACK_MODEL && mayRetry()) {
    if (isFable) fableUnavailable = true;
    model = FALLBACK_MODEL;
    effort = fallbackEffort;
    res = await attempt(model, effort);
  }
  return { res, model, effort };
}

let instance: AuxRunner | null = null;

/** Boot wiring (index.ts). */
export function initAux(runner: AuxRunner): void {
  instance = runner;
}

/** The process-wide runner; throws before boot wiring, which is a programming error. */
export function aux(): AuxRunner {
  if (!instance) throw new Error('aux runner not initialised');
  return instance;
}
