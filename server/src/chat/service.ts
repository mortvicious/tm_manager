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
import { READ_ONLY_DISALLOWED, aux } from '../claude/aux.ts';
import { pidLooksLikeOurs } from '../pty/session-manager.ts';
import { broadcast } from '../events.ts';
import type { ChatPatch, Storage } from '../storage/types.ts';

// A chat is the terminal you would have opened yourself, held open across the
// browser and the phone. Every turn is its own aux terminal (kind `chat`,
// `claude --resume <sessionId>`), attachable from the runs list; the phone
// and the chat page read the reply from the Stop hook, never from the xterm
// bytes. See docs/chat.md § Turns are terminals.

/** One turn's wall clock. Long enough for real work in `write` mode, short
 *  enough that a wedged child cannot hold the chat's lock forever. */
const TURN_TIMEOUT_MS = 15 * 60_000;

/** A single message that no chat window should have to render. Cut here rather
 *  than at the transport, so the phone and the browser store the same text. */
const MAX_PROMPT_CHARS = 32_000;

/** Same idea in the other direction: a reply this long is a report, not a
 *  chat turn, and truncating at storage time keeps `/ws/events` frames sane. */
const MAX_REPLY_CHARS = 60_000;

const TITLE_MAX = 120;

/**
 * Denied in BOTH modes: a question dialog or plan-mode approval drawn in a
 * terminal nobody may be watching (the phone sent this turn) would hold the
 * turn — and the chat's lock — until TURN_TIMEOUT_MS. `-p` never offered
 * them; the interactive CLI does.
 */
const NEVER_IN_CHAT = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];

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

function firstLine(text: string): string {
  const line = text.trim().split('\n').find((l) => l.trim().length > 0) ?? 'Chat';
  return line.trim().slice(0, TITLE_MAX);
}

/**
 * Every live chat turn's abort handle, so `stop()` can cut one short. Keyed by
 * chat id: a chat runs at most one turn at a time (that is what
 * `beginChatTurn` buys), so one entry per chat is the whole story.
 */
const liveTurns = new Map<string, AbortController>();

/**
 * Chat ids whose turn was stopped ON PURPOSE, so the transcript says
 * "stopped" rather than reporting the abort as a failure.
 */
const stopRequested = new Set<string>();

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
    const ctl = liveTurns.get(id);
    if (!ctl) return false;
    stopRequested.add(id);
    // The aux runner ends the PTY (SIGHUP to the terminal's session, SIGKILL
    // after its grace — the whole session, so the tools the turn started go
    // with it) and settles the turn `aborted`; completeTurn then releases the
    // lock. A stop that lands before the PTY exists is refused at spawn.
    ctl.abort();
    return true;
  }

  /**
   * Chats left `thinking` by a crash or a restart.
   *
   * Clearing the lock is only HALF of it, and the dangerous half on its own.
   * A turn's PTY is its own session leader — a `kill -9`, an OOM or the front
   * door's SIGKILL escalation can leave it alive and, in write mode, still
   * editing the repo. (The orchestrator's boot sweep also kills it through
   * its aux run row; this pid is the belt to that, recorded on the chat.) Release the lock without killing it and the
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
   * One turn = one aux terminal. `--resume` when there is a session to
   * resume; turn one has no session id yet, which is why it is the one turn
   * that runs fresh. The reply is the Stop hook's `last_assistant_message` —
   * the same final text `-p` returned as `result` — so the phone never sees
   * a byte of the terminal. The PTY is ended once that Stop lands and `done`
   * resolves only after it exited, so the next turn's `--resume` never shares
   * the session id with a live process.
   */
  private async runTurn(
    chat: Chat,
    cwd: string,
    prompt: string,
  ): Promise<{ text: string; sessionId: string | null; costUsd: number; error: string | null }> {
    // Two honest permission settings, depending entirely on the mode, and
    // getting this wrong is silent:
    //
    // - `read` is `dontAsk` plus the disallow list, exactly as analysis and
    //   review run. Nothing it may do would prompt, so nothing is denied.
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
    const read = chat.mode === 'read';
    // The previous turn's transcript is this session's: its totals are the
    // baseline, so a turn reports only its OWN usage (what `-p` reported as
    // `total_cost_usd`).
    const prev = chat.sessionId
      ? (await this.storage.listRuns({ kind: 'chat', subjectId: chat.id })).find((r) => r.transcriptPath)
      : undefined;
    const ctl = new AbortController();
    liveTurns.set(chat.id, ctl);
    try {
      const { runId, done } = await aux().start<string>({
        kind: 'chat',
        subjectId: chat.id,
        repoId: chat.repoId,
        label: `chat: ${chat.title.slice(0, 60)}`,
        cwd,
        model: chat.model,
        effort: chat.effort,
        prompt,
        resumeSessionId: chat.sessionId,
        baselineTranscript: prev?.transcriptPath ?? null,
        // The CLI's default tool set: a chat is the terminal the human would
        // have opened, not a trimmed role.
        tools: null,
        disallowedTools: [...(read ? READ_ONLY_DISALLOWED : []), ...NEVER_IN_CHAT],
        permission: read ? 'dontAsk' : 'bypass',
        lean: false,
        timeoutMs: TURN_TIMEOUT_MS,
        // Any final text is the reply; there is no schema to correct against.
        maxRetries: 0,
        signal: ctl.signal,
      });
      // Persisted so the NEXT process can find this turn's claude should the
      // server die without reaping it (recoverOnBoot). Fire-and-forget: a
      // failed write must not take down a turn that has already spawned.
      void this.storage
        .getRun(runId)
        .then((r) => this.storage.setChatPid(chat.id, r?.pid ?? null))
        .catch(() => {});
      const o = await done;
      const costUsd = Math.round((o.stats?.costUsd ?? 0) * 1000) / 1000;
      // The session id is worth keeping even from a FAILED turn: claude has
      // already created the session, and dropping it here would make the next
      // message start a second conversation in the same chat.
      const sessionId = o.sessionId ?? chat.sessionId ?? null;
      if (o.status === 'ok') return { text: o.value ?? o.text ?? '', sessionId, costUsd, error: null };
      const error = stopRequested.has(chat.id) ? 'stopped' : (o.error ?? 'claude returned no result').slice(0, 500);
      return { text: '', sessionId, costUsd, error };
    } catch (e) {
      return {
        text: '',
        sessionId: null,
        costUsd: 0,
        error: stopRequested.has(chat.id) ? 'stopped' : (e as Error).message,
      };
    } finally {
      if (liveTurns.get(chat.id) === ctl) liveTurns.delete(chat.id);
      stopRequested.delete(chat.id);
    }
  }
}
