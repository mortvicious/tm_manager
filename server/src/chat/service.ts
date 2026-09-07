import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import {
  CHAT_MODES,
  EFFORT_LEVELS,
  MODEL_OPTIONS,
  type Chat,
  type ChatMessage,
  type ChatMode,
  type EffortLevel,
} from '@tm/shared';
import { registerHeadless } from '../claude/headless.ts';
import { pidLooksLikeOurs } from '../pty/session-manager.ts';
import { broadcast } from '../events.ts';
import type { ChatPatch, Storage } from '../storage/types.ts';

// A chat is the terminal you would have opened yourself, held open across the
// browser and the phone. See docs/chat.md for why every turn is a headless
// `claude -p --resume` run rather than a PTY.

/** One turn's wall clock. Long enough for real work in `write` mode, short
 *  enough that a wedged child cannot hold the chat's lock forever. */
const TURN_TIMEOUT_MS = 15 * 60_000;

/** A single message that no chat window should have to render. Cut here rather
 *  than at the transport, so the phone and the browser store the same text. */
const MAX_PROMPT_CHARS = 32_000;

/** Same idea in the other direction: a reply this long is a report, not a
 *  chat turn, and truncating at storage time keeps `/ws/events` frames sane. */
const MAX_REPLY_CHARS = 60_000;

/** Hard ceiling on what one turn may print. `execFile`'s maxBuffer by hand,
 *  because this spawns directly (see runTurn) and gets no such option. */
const MAX_STDOUT_CHARS = 64 * 1024 * 1024;

const TITLE_MAX = 120;

/** The read-mode tool fence — deliberately the SAME list `analyze.ts` and
 *  `review.ts` pass, so "read-only" means one thing in this codebase. */
const READ_ONLY_DISALLOWED = ['Edit', 'Write', 'NotebookEdit', 'Bash'];

export interface ChatDeps {
  storage: Storage;
}

export interface ChatCreateInput {
  repoId: string;
  title?: string;
  model?: string;
  effort?: EffortLevel | null;
  mode?: ChatMode;
}

export type ChatResult<T> = { ok: true; value: T } | { ok: false; code: number; error: string };

/** What an ACCEPTED send hands back: what was stored, and the pending reply. */
export interface ChatTurn {
  /** the chat as it was locked, i.e. the settings this turn actually runs on */
  chat: Chat;
  user: ChatMessage;
  done: Promise<ChatResult<ChatMessage>>;
}

const fail = (code: number, error: string): ChatResult<never> => ({ ok: false, code, error });
const ok = <T>(value: T): ChatResult<T> => ({ ok: true, value });

/** `claude` inherits our env minus the vars that would make it think it is
 *  running INSIDE a claude session — the same scrub the other headless
 *  callers do (`analyze.ts` cleanEnv). */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE') env[k] = v;
  }
  return env;
}

function firstLine(text: string): string {
  const line = text.trim().split('\n').find((l) => l.trim().length > 0) ?? 'Chat';
  return line.trim().slice(0, TITLE_MAX);
}

/**
 * Every live chat turn, so `stop()` can cut one short. Keyed by chat id: a
 * chat runs at most one turn at a time (that is what `beginChatTurn` buys),
 * so one entry per chat is the whole story.
 */
const liveTurns = new Map<string, ChildProcess>();

/**
 * Chat ids whose turn was stopped ON PURPOSE. `execFile` reports a signalled
 * child as a plain command failure, so without this the transcript would show
 * the whole argv as an error for something the human asked for.
 */
const stopRequested = new Set<string>();

/** Grace between SIGTERM and SIGKILL, matching SessionManager.kill(). */
const KILL_GRACE_MS = 5_000;

/**
 * Signal a turn's whole PROCESS GROUP, not just the child.
 *
 * This is the difference between a stop that works and one that appears to: a
 * turn's `claude` spawns its own children (a `Bash` tool call is one), they
 * inherit its stdout, and `execFile` only calls back when that pipe reaches
 * EOF. Kill the child alone and a surviving grandchild holds the pipe open —
 * the callback never fires, the chat's lock is never released, and the chat is
 * unusable until the process dies of something else. Spawning `detached` makes
 * the child a group leader so `-pid` reaches everything it started.
 *
 * Falls back to the plain child kill if the group is already gone (ESRCH), so
 * a race between exit and signal is not an exception.
 */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already reaped
    }
  }
}

export class ChatService {
  constructor(private readonly deps: ChatDeps) {}

  private get storage(): Storage {
    return this.deps.storage;
  }

  // ---- reads ----

  list(repoId?: string): Promise<Chat[]> {
    return this.storage.listChats(repoId);
  }

  get(id: string): Promise<Chat | null> {
    return this.storage.getChat(id);
  }

  messages(id: string, limit?: number): Promise<ChatMessage[]> {
    return this.storage.listChatMessages(id, limit);
  }

  // ---- lifecycle ----

  async create(input: ChatCreateInput, actor: string): Promise<ChatResult<Chat>> {
    const repo = await this.storage.getRepo(input.repoId);
    if (!repo) return fail(404, 'no such repo');
    if (!fs.existsSync(repo.path)) {
      // A chat's whole value is the cwd it runs in; finding out at the first
      // turn instead of at creation wastes a message and a model call.
      return fail(400, `repo path does not exist: ${repo.path}`);
    }
    const settings = await this.storage.getSettings();
    const model = input.model ?? settings['chat.model'];
    if (!MODEL_OPTIONS.includes(model)) return fail(400, `unknown model: ${model}`);
    const effort = input.effort === undefined ? settings['chat.effort'] : input.effort;
    if (effort !== null && !EFFORT_LEVELS.includes(effort)) return fail(400, `unknown effort: ${effort}`);
    const mode = input.mode ?? 'read';
    if (!CHAT_MODES.includes(mode)) return fail(400, `unknown mode: ${mode}`);

    const chat = await this.storage.createChat({
      repoId: repo.id,
      title: (input.title?.trim() || `Chat · ${repo.name}`).slice(0, TITLE_MAX),
      model,
      effort,
      mode,
    });
    await this.storage.appendEvent({
      kind: 'chat.created',
      actor,
      repoId: repo.id,
      data: { chatId: chat.id, title: chat.title, model, mode },
    });
    broadcast({ type: 'chat.updated', chat });
    return ok(chat);
  }

  async edit(id: string, patch: ChatPatch, actor: string): Promise<ChatResult<Chat>> {
    const cur = await this.storage.getChat(id);
    if (!cur) return fail(404, 'no such chat');
    if (patch.model !== undefined && !MODEL_OPTIONS.includes(patch.model)) {
      return fail(400, `unknown model: ${patch.model}`);
    }
    if (patch.effort !== undefined && patch.effort !== null && !EFFORT_LEVELS.includes(patch.effort)) {
      return fail(400, `unknown effort: ${patch.effort}`);
    }
    if (patch.mode !== undefined && !CHAT_MODES.includes(patch.mode)) return fail(400, `unknown mode: ${patch.mode}`);
    // Model, effort and mode are read at the START of each turn, so changing
    // them mid-turn would silently apply to the NEXT one and leave the running
    // child on the old settings. Refuse rather than half-apply.
    if (cur.status === 'thinking' && (patch.model !== undefined || patch.effort !== undefined || patch.mode !== undefined)) {
      return fail(409, 'chat is mid-turn — wait for the reply or stop it first');
    }
    const next = await this.storage.updateChat(id, {
      ...patch,
      ...(patch.title !== undefined ? { title: patch.title.trim().slice(0, TITLE_MAX) || cur.title } : {}),
    });
    if (!next) return fail(404, 'no such chat');
    await this.storage.appendEvent({
      kind: 'chat.edited',
      actor,
      repoId: next.repoId,
      data: { chatId: id, keys: Object.keys(patch) },
    });
    broadcast({ type: 'chat.updated', chat: next });
    return ok(next);
  }

  async remove(id: string, actor: string): Promise<ChatResult<true>> {
    const cur = await this.storage.getChat(id);
    if (!cur) return fail(404, 'no such chat');
    // Kill first, then delete: a turn whose chat row vanished would write its
    // reply into nothing and leave a `claude` child with no owner.
    this.stop(id);
    const gone = await this.storage.deleteChat(id);
    if (!gone) return fail(404, 'no such chat');
    await this.storage.appendEvent({ kind: 'chat.deleted', actor, repoId: cur.repoId, data: { chatId: id } });
    broadcast({ type: 'chat.deleted', chatId: id });
    return ok(true);
  }

  /**
   * Cut a live turn short. Its own completion path records the outcome and
   * releases the lock, so there is nothing to clean up here — but the lock is
   * only released when the child actually dies, which is why SIGTERM is
   * followed by SIGKILL. A child that ignores the first signal would otherwise
   * hold its chat unusable until TURN_TIMEOUT_MS, and that timeout sends
   * SIGTERM as well: the same signal that was already ignored once.
   */
  stop(id: string): boolean {
    const child = liveTurns.get(id);
    if (!child) return false;
    stopRequested.add(id);
    killGroup(child, 'SIGTERM');
    const escalate = setTimeout(() => {
      // Only if it is still THIS child: a turn that died and was replaced by
      // the next message must not be killed by the previous stop's timer.
      if (liveTurns.get(id) === child) killGroup(child, 'SIGKILL');
    }, KILL_GRACE_MS);
    // Do not hold the event loop open for a grace period nobody is waiting on.
    escalate.unref?.();
    return true;
  }

  /**
   * Chats left `thinking` by a crash or a restart.
   *
   * Clearing the lock is only HALF of it, and the dangerous half on its own.
   * A chat turn owns no `tm_runs` row, so the orchestrator's boot pid sweep
   * cannot see its child, and the child is spawned detached — a `kill -9`, an
   * OOM or the front door's SIGKILL escalation leaves it alive and, in write
   * mode, still editing the repo. Release the lock without killing it and the
   * next message spawns a second `claude --resume` on the SAME session id
   * alongside the orphan: precisely the two-children-one-session corruption
   * the lock exists to prevent, arrived at by way of the recovery.
   *
   * So the pid recorded on the row is killed FIRST, as a process group and
   * behind the same command-line check the orchestrator's sweep uses — across
   * a restart pid reuse is realistic, and signalling a stranger is worse than
   * missing an orphan.
   *
   * @returns how many locks were cleared, and how many live orphans were killed
   */
  async recoverOnBoot(): Promise<{ cleared: number; killed: number }> {
    const stuck = (await this.storage.listChats()).filter((c) => c.status === 'thinking');
    let killed = 0;
    for (const c of stuck) {
      if (c.pid && pidLooksLikeOurs(c.pid, /claude/)) {
        try {
          // The group: this child's own tools inherited its pipes, and one
          // surviving grandchild is a process still writing to the repo.
          process.kill(-c.pid, 'SIGKILL');
          killed++;
        } catch {
          try {
            process.kill(c.pid, 'SIGKILL');
            killed++;
          } catch {
            // gone between the check and the signal
          }
        }
      }
      const next = await this.storage.finishChatTurn(c.id, {
        error: 'the server restarted while this turn was running',
        costUsd: 0,
      });
      if (next) broadcast({ type: 'chat.updated', chat: next });
    }
    return { cleared: stuck.length, killed };
  }

  // ---- the turn ----

  /**
   * Two phases, and they are two phases on purpose. `send` resolves once the
   * message is ACCEPTED — validated, the concurrency fence passed, the lock
   * taken, the user's message stored — and hands back `done`, which resolves
   * when the reply lands. Every refusal is therefore a real error the caller
   * can answer with (the REST route turns it into a 4xx), while the minutes
   * the turn itself takes are nobody's HTTP timeout. Collapsing the two into
   * one promise would force the route to guess when a refusal had stopped
   * being possible, and that guess is different on SQLite and on Postgres.
   *
   * `done` never rejects — a failed turn is recorded on the chat and on the
   * assistant message, and reported as `ok: false`.
   */
  async send(id: string, text: string, actor: string): Promise<ChatResult<ChatTurn>> {
    const prompt = text.trim();
    if (!prompt) return fail(400, 'empty message');

    const existing = await this.storage.getChat(id);
    if (!existing) return fail(404, 'no such chat');
    if (existing.status === 'thinking') return fail(409, 'chat is already answering — one turn at a time');

    const settings = await this.storage.getSettings();
    const cap = settings['chat.concurrency'];
    // Checked BEFORE the lock is taken: a chat that fails this fence must stay
    // idle, not be left `thinking` by a claim we then have to undo.
    if ((await this.storage.countThinkingChats()) >= cap) {
      return fail(429, `${cap} chat turns already running — wait for one to finish`);
    }

    const repo = await this.storage.getRepo(existing.repoId);
    if (!repo) return fail(404, 'the repo this chat points at is gone');
    if (!fs.existsSync(repo.path)) return fail(400, `repo path does not exist: ${repo.path}`);

    // The lock. Everything after this point MUST reach finishChatTurn.
    const chat = await this.storage.beginChatTurn(id);
    if (!chat) return fail(409, 'chat is already answering — one turn at a time');
    broadcast({ type: 'chat.updated', chat });

    const sent = prompt.slice(0, MAX_PROMPT_CHARS);
    let userMsg: ChatMessage;
    try {
      userMsg = await this.storage.appendChatMessage({
        chatId: id,
        role: 'user',
        text: sent,
        actor,
      });
      broadcast({ type: 'chat.message', message: userMsg });

      // First real message names the chat, unless a human already did.
      if (chat.turns === 0 && chat.title.startsWith('Chat · ')) {
        const renamed = await this.storage.updateChat(id, { title: firstLine(sent) });
        if (renamed) broadcast({ type: 'chat.updated', chat: renamed });
      }
    } catch (e) {
      // The lock is taken but no child exists yet, and this is the ONE window
      // where a throw would escape without `completeTurn` to settle it. A
      // dropped Postgres connection or a SQLITE_BUSY here used to reject
      // `send()` with the chat left `thinking` — refusing every later message
      // until the next boot sweep, for a turn that never even spawned.
      //
      // Releasing the lock is the whole job; the failure is reported as a 500
      // rather than rethrown, because a caller that gets an error AND a dead
      // chat has been told the less useful half of what happened.
      const why = `failed to record the message: ${(e as Error).message}`;
      console.error(`chat ${id}: ${why}`);
      const freed = await this.storage.finishChatTurn(id, { error: why, costUsd: 0 }).catch(() => null);
      if (freed) broadcast({ type: 'chat.updated', chat: freed });
      return fail(500, why);
    }

    // Detached deliberately: the acceptance below returns while this runs.
    // It swallows nothing — `completeTurn` has its own try/catch and settles
    // the lock on every path, which is the one thing that must not be skipped.
    const done = this.completeTurn(chat, repo.path, sent, actor);
    // A caller that never touches `done` (the REST route) must not turn a
    // rejection into an unhandled promise; `completeTurn` resolves rather than
    // throws, and this is the belt to that suspenders.
    done.catch(() => {});
    return ok({ chat, user: userMsg, done });
  }

  /** The turn itself, from spawn to released lock. Resolves, never rejects. */
  private async completeTurn(
    chat: Chat,
    cwd: string,
    sent: string,
    actor: string,
  ): Promise<ChatResult<ChatMessage>> {
    const id = chat.id;
    const started = Date.now();
    let res: Awaited<ReturnType<ChatService['runTurn']>>;
    try {
      res = await this.runTurn(chat, cwd, sent);
    } catch (e) {
      // runTurn resolves rather than throws, but the lock is not allowed to
      // depend on that staying true.
      res = { text: '', sessionId: null, costUsd: 0, error: (e as Error).message };
    }
    const durationMs = Date.now() - started;

    try {
      return await this.recordTurn(chat, res, durationMs, actor);
    } catch (e) {
      // The bookkeeping itself failed (a storage error mid-turn). Releasing
      // the lock is the ONE thing that cannot be skipped: a chat left
      // `thinking` refuses every future message until the next boot sweep.
      const why = `failed to record the reply: ${(e as Error).message}`;
      console.error(`chat ${id}: ${why}`);
      const freed = await this.storage
        .finishChatTurn(id, { sessionId: res.sessionId, error: why, costUsd: res.costUsd })
        .catch(() => null);
      if (freed) broadcast({ type: 'chat.updated', chat: freed });
      return fail(500, why);
    }
  }

  /** Everything a finished turn writes down. Separated only so the lock's
   *  release can be guaranteed around it. */
  private async recordTurn(
    chat: Chat,
    res: { text: string; sessionId: string | null; costUsd: number; error: string | null },
    durationMs: number,
    actor: string,
  ): Promise<ChatResult<ChatMessage>> {
    const id = chat.id;
    const replyText = res.error
      ? ''
      : (res.text.trim() || '(the model returned an empty reply)').slice(0, MAX_REPLY_CHARS);

    const assistantMsg = await this.storage.appendChatMessage({
      chatId: id,
      role: 'assistant',
      text: res.error ? '' : replyText,
      actor: 'claude',
      error: res.error,
      costUsd: res.costUsd,
      durationMs,
    });
    const finished = await this.storage.finishChatTurn(id, {
      sessionId: res.sessionId,
      error: res.error,
      costUsd: res.costUsd,
    });
    await this.storage.appendEvent({
      kind: 'chat.turn',
      actor,
      repoId: chat.repoId,
      data: {
        chatId: id,
        model: chat.model,
        mode: chat.mode,
        resumed: chat.sessionId !== null,
        durationMs,
        costUsd: res.costUsd,
        ...(res.error ? { ok: false, error: res.error } : { ok: true, chars: replyText.length }),
      },
    });
    broadcast({ type: 'chat.message', message: assistantMsg });
    if (finished) broadcast({ type: 'chat.updated', chat: finished });

    if (res.error) return fail(502, res.error);
    return ok(assistantMsg);
  }

  /**
   * The `claude -p` invocation. `--resume` goes FIRST when there is a session
   * to resume, exactly as `buildWorkerInvocation` orders it; turn one has no
   * session id yet, which is why it is the one turn that runs fresh.
   */
  private runTurn(
    chat: Chat,
    cwd: string,
    prompt: string,
  ): Promise<{ text: string; sessionId: string | null; costUsd: number; error: string | null }> {
    const args: string[] = [];
    if (chat.sessionId) args.push('--resume', chat.sessionId);
    args.push('-p', '--model', chat.model);
    if (chat.effort) args.push('--effort', chat.effort);
    // A headless turn can never ANSWER a permission prompt, so the only two
    // honest settings are "would never be asked" and "never prompts". Which
    // one depends entirely on the mode, and getting this wrong is silent:
    //
    // - `read` is `dontAsk` plus the disallow list, exactly as analyze.ts and
    //   review.ts run. Nothing it may do would prompt, so nothing is denied.
    // - `write` must NOT be `dontAsk`. Measured against the real CLI: with
    //   `dontAsk` and no disallow list, "create a file" answers *"Claude Code
    //   is running in don't ask mode, I can't proceed without your explicit
    //   approval"* and writes nothing — a write mode that cannot write. In a
    //   repo with no allow rules Edit, Write and Bash all prompt, and under
    //   `dontAsk` every one of those prompts is a denial.
    //
    //   So write mode skips permissions outright, which is also the only
    //   honest reading of "the same as sitting in the terminal". There is
    //   deliberately no knob between the two: `acceptEdits` was measured to
    //   run `Bash` in `-p` as well (it created a file with `echo >`), so a
    //   setting offering it as the narrower option would have been a
    //   difference that does not exist. The lever is `read` vs `write`, and
    //   write is gated per chat, warned in the UI, and additionally gated
    //   behind `telegram.chat.allowWrite` for the phone.
    if (chat.mode === 'read') {
      args.push('--permission-mode', 'dontAsk', '--disallowedTools', ...READ_ONLY_DISALLOWED);
    } else {
      args.push('--dangerously-skip-permissions');
    }
    args.push('--output-format', 'json');

    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn('claude', args, {
          cwd,
          env: cleanEnv(),
          // Its own process group, so killGroup can reach the tools this turn
          // spawns. `spawn` and not `execFile`, which the rest of this
          // codebase uses for headless runs, for exactly this one reason:
          // execFile does not forward `detached` to spawn at all.
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        stopRequested.delete(chat.id);
        resolve({ text: '', sessionId: null, costUsd: 0, error: (e as Error).message });
        return;
      }

      let out = '';
      let errTail = '';
      let overflowed = false;
      let settled = false;

      const watchdog = setTimeout(() => {
        if (liveTurns.get(chat.id) === child) {
          killGroup(child, 'SIGTERM');
          const hard = setTimeout(() => {
            if (liveTurns.get(chat.id) === child) killGroup(child, 'SIGKILL');
          }, KILL_GRACE_MS);
          hard.unref?.();
        }
      }, TURN_TIMEOUT_MS);
      watchdog.unref?.();

      /** Both `close` and `error` can fire; the first one wins. */
      const finish = (spawnError: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        liveTurns.delete(chat.id);
        const wasStopped = stopRequested.delete(chat.id);

        let envelope: any = null;
        try {
          envelope = JSON.parse(out);
        } catch {
          // non-JSON stdout = the run did not complete
        }
        // The session id is worth keeping even from a FAILED turn: claude has
        // already created the session, and dropping it here would make the
        // next message start a second conversation in the same chat.
        const sessionId = (envelope?.session_id as string | undefined) ?? null;
        const costUsd = Math.round((Number(envelope?.total_cost_usd ?? 0) || 0) * 1000) / 1000;
        if (!envelope || envelope.is_error) {
          const detail = wasStopped
            ? 'stopped'
            : overflowed
              ? 'the reply was too large to read'
              : (envelope && String(envelope.result ?? '').slice(0, 500)) ||
                spawnError ||
                errTail.trim().slice(-500) ||
                'claude returned no result';
          resolve({ text: '', sessionId, costUsd, error: detail });
          return;
        }
        resolve({ text: String(envelope.result ?? ''), sessionId, costUsd, error: null });
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (c: string) => {
        if (overflowed) return;
        if (out.length + c.length > MAX_STDOUT_CHARS) {
          // execFile's maxBuffer, done by hand: stop reading and take the
          // whole group down rather than grow the heap without a bound.
          overflowed = true;
          out = '';
          killGroup(child, 'SIGKILL');
          return;
        }
        out += c;
      });
      // Kept only for the error message — claude's result is on stdout.
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (c: string) => {
        errTail = (errTail + c).slice(-2000);
      });
      // `close`, not `exit`: close fires once the pipes are drained, and a
      // reply arriving in the last chunk must not be lost to an early exit.
      child.on('close', () => finish(null));
      child.on('error', (e) => finish(e.message));

      liveTurns.set(chat.id, child);
      // Persisted so the NEXT process can find this child. A chat owns no
      // tm_runs row, so the orchestrator's boot pid sweep cannot see it, and
      // `detached` means a crash or a SIGKILL leaves it running — in write
      // mode, still editing the repo. Without this column the next boot would
      // clear the lock and the next message would put a SECOND `--resume` on
      // the same session id alongside the orphan.
      //
      // Fire-and-forget: a failed write must not take down a turn that has
      // already spawned. The cost is that recovery could not kill that one,
      // which is exactly the old behaviour and never worse than it.
      void this.storage.setChatPid(chat.id, child.pid ?? null).catch(() => {});
      // The prompt goes on stdin, never in argv: a chat message is arbitrary
      // user text and has no business in a process listing.
      child.stdin?.on('error', () => {});
      child.stdin?.write(prompt);
      child.stdin?.end();
      // This turn owns no run row, so the headless registry is the only thing
      // that knows it is working — which is what puts it under the restart
      // guard and /killall's stopAllHeadless().
      // `group: true` — this child is detached, so shutdown and /killall must
      // signal `-pid` or the tools it spawned outlive them.
      registerHeadless(child, `chat: ${chat.title.slice(0, 60)}`, { group: true });
    });
  }
}
