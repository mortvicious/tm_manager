import { DEFAULT_DIGEST, saveTelegramDigest, saveTelegramNotify, type TelegramConfig } from '../config.ts';
import type { Orchestrator } from '../orchestrator.ts';
import type { Storage } from '../storage/types.ts';
import { parseActionData, runButtonAction, type ActionOutcome } from './actions.ts';
import { TelegramApi, TelegramApiError, escapeHtml, isNotModified, MAX_MESSAGE_CHARS, toReply, type Reply } from './api.ts';
import {
  BoardMemory,
  messageContext,
  parseListData,
  renderBoard,
  renderCard,
  shortcutCommand,
  taskActionKeyboard,
  type ActivitySource,
  type BoardDeps,
  type ListButton,
  type MessageContext,
} from './board.ts';
import { resolveFeature, resolveProposal, resolveTask } from './ids.ts';
import { commandSpecs, findCommand, parseCommand, unknownCommandReply } from './commands.ts';
import type { Chat } from '@tm/shared';
import type { ChatService } from '../chat/service.ts';
import {
  activeChat,
  handleChatButton,
  parseChatData,
  phoneMaySend,
  renderReply,
  WRITE_BLOCKED_REPLY,
  type ChatButton,
  type ChatDeps,
} from './chat.ts';
import {
  CONFIRM_LABEL,
  ConfirmStore,
  KillWatcher,
  RateLimiter,
  executeKillAll,
  parseConfirmData,
  renderKillAllReport,
  requestHostRestart,
  type BotHooks,
  type Confirm,
  type ConfirmButton,
} from './emergency.ts';
import {
  FlowStore,
  handleFlowButton,
  handleFlowText,
  offerDraft,
  parseFlowData,
  startProceed,
  type Flow,
  type FlowButton,
} from './flows.ts';
import { DigestScheduler } from './digest.ts';
import { TelegramNotifier, featureKeyboard, proposalMessage } from './notifications.ts';
import {
  QuestionDrafts,
  handleQuestionButton,
  parseQuestionData,
  questionMessages,
  type QuestionButton,
  type QuestionDeps,
} from './questions.ts';
import type { QuestionService } from '../questions.ts';
import { buildReport, type ReportDocument } from './report.ts';
import { formatClock, type GateCounters } from './status.ts';
import type { InlineKeyboardMarkup, ReplyKeyboardMarkup, TelegramCallbackQuery, TelegramUpdate } from './types.ts';

// The bot process-side: one long-polling loop, one allowlisted user, one
// audit trail. See docs/telegram.md.
//
// Why long polling and not a webhook: `getUpdates` is a request THIS machine
// makes outward and Telegram holds open. No inbound port, no public address,
// no certificate — and none of the Host/Origin allowlists in server/src/net.ts
// are involved, which is precisely why the single-user gate below is the only
// thing standing between a stranger who found the bot's name and this server.

/** Cap on drain passes at boot, so a pathological backlog cannot loop forever. */
const MAX_DRAIN_PASSES = 50;
/**
 * The long poll is what keeps this loop cheap: Telegram holds the request open
 * for `timeout` seconds and the process sits idle. A timeout of 0 turns the
 * same loop into a busy spin at 100% CPU that never yields to a timer, so the
 * configured value is floored here as well as validated in config.ts.
 */
const MIN_POLL_TIMEOUT_SEC = 1;
/**
 * Belt and braces for the above: if a poll comes back empty faster than this,
 * something upstream is not honouring `timeout` (a proxy, a stub) and the loop
 * would spin. Pause instead.
 */
const MIN_EMPTY_POLL_MS = 250;
/** Never answer the same stranger's /start more often than this. */
const STRANGER_REPLY_COOLDOWN_MS = 60 * 60_000;
/** Bounded memory for traffic we do not trust: strangers cannot grow these. */
const MAX_TRACKED_STRANGERS = 200;
/** Rejections are audited as ONE periodic summary — see recordRejection(). */
const REJECT_AUDIT_INTERVAL_MS = 10 * 60_000;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Every row this module writes carries it; the gate guarantees one human. */
const ACTOR = 'telegram';

/** BotFather's shape: `<numeric bot id>:<secret>`. */
const TOKEN_RE = /^\d+:[A-Za-z0-9_-]{20,}$/;

/**
 * The line that announces a flow this command threw away. Empty when nothing
 * was dropped, and empty for a pending draft OFFER: that is a proposal the bot
 * made about a stray message, not work the human was part-way through, and it
 * created nothing — announcing its loss would put noise in front of every
 * command typed after a stray message.
 */
function dropNote(dropped: Flow | null): string {
  return dropped && dropped.kind !== 'draft'
    ? `<i>(dropped the unfinished /${escapeHtml(dropped.kind)})</i>\n\n`
    : '';
}

/** Unix seconds the update describes, or null when it carries no usable time. */
function updateTimestamp(u: TelegramUpdate): number | null {
  const m = u.message ?? u.edited_message ?? u.channel_post;
  return m && typeof m.date === 'number' ? m.date : null;
}

export class TelegramBot {
  private readonly api: TelegramApi;
  private running = false;
  private loop: Promise<void> | null = null;
  /** Set by the first stop(); later callers await the SAME shutdown. */
  private stopping: Promise<void> | null = null;
  /** True once the loop was actually launched — stop() has work to do. */
  private started = false;
  private readonly abort = new AbortController();
  private offset = 0;
  private failures = 0;
  private username: string | null = null;

  /**
   * Cutoff for the boot discard. PROCESS start, not bot start: a message typed
   * while the server was still booting is a live intent, and dropping it would
   * make a restart feel like the bot ate the request.
   */
  private readonly cutoffSec = Math.floor((Date.now() - process.uptime() * 1000) / 1000);
  private readonly bootedAt = new Date().toISOString();

  private readonly counters: GateCounters = {
    discardedAtBoot: 0,
    discardedLate: 0,
    rejected: 0,
    rejectedUsers: 0,
    rejectedUsersCapped: false,
  };
  /** distinct foreign ids seen since boot — the /status figure, bounded */
  private readonly seenStrangers = new Set<number>();
  /** foreign id → when we last answered its /start, for the cooldown */
  private readonly strangerReplyAt = new Map<number, number>();
  private pendingRejects = 0;
  private lastRejectAudit = 0;
  /** the loop ended itself on an unrecoverable token, not on a shutdown */
  private fatal = false;

  private readonly notifier: TelegramNotifier;
  private readonly digest: DigestScheduler;
  /**
   * The single conversational flow (docs/telegram.md § Conversations). One
   * user means one flow; it lives in memory and dies with the process, which
   * is the same rule the boot-discard filter enforces for updates.
   */
  private readonly flows = new FlowStore();
  /** half-answered multi-part questions (docs/questions.md) */
  private readonly questionDrafts = new QuestionDrafts();
  /**
   * The red button's state (docs/telegram.md § Emergency controls). In memory,
   * like the flow store — which is also the answer to "what if the server
   * restarts mid-confirm": the window dies with the process, and the boot
   * drain treats a callback_query as undatable and therefore stale, so a
   * Confirm pressed before a restart can neither survive nor be replayed.
   */
  private readonly confirms = new ConfirmStore();
  private readonly limiter = new RateLimiter();
  /** the board's remembered `/tasks <text>` search (docs/telegram.md § The board) */
  private readonly boardMemory = new BoardMemory();
  private readonly killWatcher: KillWatcher;

  constructor(
    private readonly cfg: TelegramConfig,
    private readonly storage: Storage,
    private readonly orchestrator: Orchestrator,
    private readonly hooks: BotHooks | null = null,
    /** the chat service (docs/chat.md). Null in a harness with no chat
     *  surface — /chat then says so rather than throwing. */
    private readonly chats: ChatService | null = null,
    /** the question service (docs/questions.md). Null in a harness — the
     *  buttons and /questions then say so rather than throwing. */
    private readonly questions: QuestionService | null = null,
    /** the activity watcher's read side, for the board's live lines. Null in
     *  a harness — the board then renders without narration. */
    private readonly activity: ActivitySource | null = null,
  ) {
    // `loadBootConfig()` always merges this block in, but a config built by
    // hand — a harness, an older caller — can be missing it entirely. The
    // digest is the most optional thing in this module and it must not be able
    // to throw the bot's startup, so it is normalised once, in place, and both
    // the scheduler and the `/digest` handler share the one live object.
    if (!cfg.digest) cfg.digest = { ...DEFAULT_DIGEST };
    this.api = new TelegramApi(cfg.botToken);
    this.killWatcher = new KillWatcher((html) => this.send(cfg.allowedUserId, html));
    this.notifier = new TelegramNotifier({
      storage,
      // The live object, not a copy: /mute and /notify flip cfg.notify in
      // place and the notifier must see it at its next flush.
      notify: cfg.notify,
      send: (html, keyboard) => this.send(cfg.allowedUserId, html, keyboard),
      requestedReview: (taskId) => this.orchestrator.isRequestedReview(taskId),
      // The feature-plan message carries the SAME report /report builds — one
      // generator, one shape (docs/telegram.md § Reports).
      sendDocument: (doc, caption, keyboard) => this.sendDocument(cfg.allowedUserId, doc, caption, keyboard),
    });
    this.digest = new DigestScheduler({
      storage,
      // The live object, like notify above: /digest flips it in place.
      digest: cfg.digest,
      send: (doc) => this.deliverDocument(cfg.allowedUserId, doc, doc.summary),
      onSent: (day) => this.audit('telegram.bot', { event: 'digest', day, hour: cfg.digest.hour }),
      onError: (e) => console.warn('telegram: digest tick failed:', errText(e)),
    });
  }

  /**
   * Never throws and never blocks boot: a bot that cannot reach Telegram must
   * not be able to stop the server from listening. Returns once the decision
   * to run (or not) is logged; the connection itself happens in the loop.
   */
  start(): void {
    if (!this.cfg.enabled) {
      console.log('telegram: bot disabled (data/config.json telegram.enabled)');
      return;
    }
    if (!this.cfg.botToken) {
      console.warn('telegram: enabled but telegram.botToken is empty — bot NOT started (docs/telegram.md)');
      return;
    }
    // Checked here rather than in config.ts, for the same reason the empty
    // token is: a malformed one must not take the server down. It must also
    // not reach `fetch`, whose URL-parse error quotes the token back into the
    // log — the one place a credential must never appear.
    if (!TOKEN_RE.test(this.cfg.botToken)) {
      console.warn(
        'telegram: telegram.botToken is not in BotFather\'s `<id>:<secret>` form — bot NOT started (docs/telegram.md)',
      );
      return;
    }
    if (!this.cfg.allowedUserId) {
      console.warn('telegram: enabled but telegram.allowedUserId is 0 — bot NOT started; nobody would be allowed to use it');
      return;
    }
    console.log(`telegram: bot enabled, answering user id ${this.cfg.allowedUserId} only`);
    this.running = true;
    this.started = true;
    this.loop = this.run().catch((e) => {
      // The loop owns its own error handling; anything reaching here is a bug,
      // and it must not become an unhandled rejection that kills the server.
      console.error('telegram: loop crashed:', errText(e));
    });
  }

  /**
   * Stop polling and settle the audit trail. Safe to call when never started,
   * and safe to call twice: the restart route fires one to abort the socket
   * early and the teardown awaits another, and the second must WAIT for the
   * first rather than return into a `storage.close()` that races the flush.
   */
  async stop(timeoutMs = 3000): Promise<void> {
    if (this.stopping) return this.stopping;
    // `started`, not `running`: a bot that stopped ITSELF on a bad token still
    // has a rejection summary to flush and a lifecycle row to write, and that
    // is precisely the failure you want in the audit trail.
    if (!this.started) return;
    this.stopping = this.shutdown(timeoutMs);
    return this.stopping;
  }

  private async shutdown(timeoutMs: number): Promise<void> {
    this.running = false;
    this.notifier.stop();
    this.digest.stop();
    this.killWatcher.stop();
    this.confirms.clear();
    this.abort.abort();
    await Promise.race([this.loop ?? Promise.resolve(), new Promise((r) => setTimeout(r, timeoutMs))]);
    this.loop = null;
    // Flush before storage closes, or a burst of rejections right before a
    // restart would leave no trace at all.
    await this.flushRejectAudit(true);
    await this.audit('telegram.bot', {
      event: 'stopped',
      offset: this.offset,
      reason: this.fatal ? 'fatal' : 'shutdown',
    }).catch(() => {});
    console.log('telegram: bot stopped');
  }

  // ---- the loop ---------------------------------------------------------

  private async run(): Promise<void> {
    // Handshake first: getMe is the one call that tells a wrong token apart
    // from a network outage, and doing it before any getUpdates means a typo'd
    // token says so instead of retrying silently forever.
    while (this.running) {
      try {
        const me = await this.api.getMe({ signal: this.abort.signal });
        this.username = me.username ?? null;
        this.failures = 0;
        console.log(`telegram: connected as @${this.username ?? me.id}`);
        break;
      } catch (e) {
        if (!(await this.backoff(e, 'getMe'))) return;
      }
    }
    if (!this.running) return;

    // Best-effort: the command menu is a convenience, not a precondition.
    this.api
      .setMyCommands(commandSpecs(), { signal: this.abort.signal })
      .catch((e) => console.warn('telegram: setMyCommands failed:', errText(e)));

    const settings = await this.storage.getSettings().catch(() => null);
    // Sanitised, not trusted: a hand-edited or corrupted row could hold a
    // negative number, which Telegram reads as "resend the last N updates" —
    // exactly the replay the persisted offset exists to prevent.
    const stored = settings?.['telegram.updateOffset'];
    this.offset = Number.isSafeInteger(stored) && (stored as number) > 0 ? (stored as number) : 0;

    await this.bootDrain();
    // The drain can end on a fatal token or a stop(); neither is a start.
    if (!this.running) return;
    // AFTER the drain: the "back online" message must be the first thing the
    // phone hears, not a notification racing it.
    await this.notifier.start();
    // Same rule as the token check in start(): one optional subsystem failing
    // must not cost the bot its poll loop. A digest that cannot start says so
    // and the commands still answer.
    try {
      await this.digest.start();
    } catch (e) {
      console.warn('telegram: daily digest not scheduled:', errText(e));
    }
    await this.audit('telegram.bot', {
      event: 'started',
      username: this.username,
      discardedAtBoot: this.counters.discardedAtBoot,
      // the "back online" message is sent by bootDrain(), just above
      bootMessageSent: true,
      offset: this.offset,
    }).catch(() => {});
    await this.pollLoop();
  }

  /**
   * Everything Telegram queued while this server was down, fetched with
   * `timeout: 0` so the count is known BEFORE the "back online" message that
   * reports it. Updates predating the process are discarded, not run: an
   * action typed six hours ago must not fire on a restart.
   */
  private async bootDrain(): Promise<void> {
    const pending: TelegramUpdate[] = [];
    let consecutiveFailures = 0;
    for (let pass = 0; pass < MAX_DRAIN_PASSES && this.running; pass++) {
      let batch: TelegramUpdate[];
      try {
        batch = await this.api.getUpdates(
          { offset: this.offset, limit: 100, timeout: 0, allowed_updates: ['message', 'callback_query'] },
          { signal: this.abort.signal },
        );
        consecutiveFailures = 0;
        // The poll loop's backoff must start from zero, not from an exponent
        // the drain ran up.
        this.failures = 0;
      } catch (e) {
        // Three failures in and the drain is not worth blocking on. BREAK, not
        // return: `pending` already holds updates whose ids this.offset has
        // moved past, so returning here would confirm them to Telegram and
        // drop them on the floor — and skip the "back online" message with them.
        if (++consecutiveFailures >= 3) {
          console.warn(`telegram: boot drain gave up after 3 failures: ${errText(e)}`);
          break;
        }
        if (!(await this.backoff(e, 'getUpdates (boot drain)'))) return;
        continue;
      }
      if (!batch.length) break;
      // Telegram does not contractually order a batch; taking the last id
      // would confirm away a higher one that arrived earlier in the array.
      this.offset = Math.max(this.offset, ...batch.map((u) => u.update_id + 1));
      pending.push(...batch);
      if (pass === MAX_DRAIN_PASSES - 1) {
        console.warn(
          `telegram: boot drain hit its ${MAX_DRAIN_PASSES}-pass cap with updates still queued; ` +
            `the rest are handled by the poll loop and counted after the "back online" message`,
        );
      }
    }
    await this.persistOffset();

    const fresh: TelegramUpdate[] = [];
    for (const u of pending) {
      if (this.isStale(u)) this.counters.discardedAtBoot++;
      else fresh.push(u);
    }
    await this.sendBootMessage();
    for (const u of fresh) await this.safeDispatch(u);
  }

  private async pollLoop(): Promise<void> {
    const timeout = Math.max(MIN_POLL_TIMEOUT_SEC, this.cfg.pollTimeoutSec);
    while (this.running) {
      let batch: TelegramUpdate[];
      const startedAt = Date.now();
      try {
        batch = await this.api.getUpdates(
          { offset: this.offset, limit: 100, timeout, allowed_updates: ['message', 'callback_query'] },
          // Telegram answers within `timeout`; the margin covers the round trip
          // and turns a silently dead socket into a retry instead of a hang.
          { signal: this.abort.signal, timeoutMs: (timeout + 20) * 1000 },
        );
        this.failures = 0;
      } catch (e) {
        if (!(await this.backoff(e, 'getUpdates'))) return;
        continue;
      }
      if (!batch.length) {
        const elapsed = Date.now() - startedAt;
        if (elapsed < MIN_EMPTY_POLL_MS) await this.sleep(MIN_EMPTY_POLL_MS - elapsed);
        continue;
      }
      // Advance and PERSIST before handling. An update that crashes a handler
      // must not be redelivered on the next boot and run half of itself twice;
      // losing it is the safer half of that trade for an action bot.
      this.offset = Math.max(this.offset, ...batch.map((u) => u.update_id + 1));
      await this.persistOffset();
      for (const u of batch) {
        if (!this.running) return;
        // A callback_query has no time of its own and the message it hangs off
        // can be days old (a button on an old notification) — but arriving
        // through the LIVE poll means it was pressed just now, so it is fresh
        // by construction. Only the boot drain treats callbacks as stale.
        if (!u.callback_query && this.isStale(u)) {
          // Not `discardedAtBoot`: the "back online" message has already gone
          // out with that number, and /status must not silently restate it.
          this.counters.discardedLate++;
          continue;
        }
        await this.safeDispatch(u);
      }
    }
  }

  /**
   * The last line of defence around update handling. Every path inside
   * `dispatch()` guards itself, but "every path" is a claim that has to stay
   * true as paths are added — and it did not: the `task.proceed` button branch
   * shipped without one, and a `SQLITE_BUSY` on the `getTask` behind it would
   * have propagated out of `dispatch` → `pollLoop` → `run()` into `start()`'s
   * `.catch`, which only logs. `running` stays true, nothing restarts the
   * loop, and the bot goes silent until the server is restarted — with no
   * message to the phone.
   *
   * So the guard lives at the loop instead, where it covers the paths that do
   * not exist yet. The offset has already been advanced and persisted, so the
   * update is not retried; one broken update must not cost the next one.
   */
  private async safeDispatch(u: TelegramUpdate): Promise<void> {
    try {
      await this.dispatch(u);
    } catch (e) {
      console.error('telegram: dispatch failed:', errText(e));
      await this.audit('telegram.command', { command: null, ok: false, error: errText(e) });
      // Best-effort: say something rather than swallowing the update in
      // silence. `send()` never throws, so this cannot re-enter the failure.
      await this.send(this.cfg.allowedUserId, `⚠ Something went wrong handling that: ${escapeHtml(errText(e))}`);
    }
  }

  /** Older than this process, or carrying no timestamp we can trust. */
  private isStale(u: TelegramUpdate): boolean {
    return (updateTimestamp(u) ?? 0) < this.cutoffSec;
  }

  private async persistOffset(): Promise<void> {
    try {
      await this.storage.setSetting('telegram.updateOffset', this.offset);
    } catch (e) {
      // Not fatal: the in-memory offset still advances, so the only cost is a
      // replay window if the process dies before the next successful write.
      console.warn('telegram: could not persist the update offset:', errText(e));
    }
  }

  // ---- the gate ---------------------------------------------------------

  /**
   * The whole authorization model: one user id, in their own private chat.
   * A group message is refused even when the owner sent it — everyone else in
   * that group would then be able to read the answers, and (with a reply) to
   * bait commands past a check that only looked at `from`.
   */
  private async dispatch(u: TelegramUpdate): Promise<void> {
    if (u.callback_query) {
      await this.handleCallback(u.callback_query);
      return;
    }
    const msg = u.message;
    if (!msg) {
      // `allowed_updates: ['message']` does not apply to updates Telegram had
      // already created, so an edited_message or a channel_post can still turn
      // up. Dropped like any other unhandled traffic — and counted, because an
      // invisible drop is one /status cannot explain.
      await this.countRejection(null);
      return;
    }
    const from = msg.from;
    // A bottom-keyboard button sends its LABEL as text; the exact labels are
    // read as the command they stand for, so they win over a flow or chat
    // mode exactly like a typed command does.
    const parsed = msg.text ? parseCommand(shortcutCommand(msg.text) ?? msg.text) : null;
    const authorized =
      !!from &&
      from.id === this.cfg.allowedUserId &&
      msg.chat.id === this.cfg.allowedUserId &&
      msg.chat.type === 'private';
    if (!authorized) {
      await this.reject(msg.chat.id, msg.chat.type, from?.id ?? null, parsed?.name ?? null);
      return;
    }
    if (!msg.text) {
      await this.audit('telegram.command', { command: null, ignored: 'non-text message' });
      await this.send(msg.chat.id, 'I only read text for now. Send /help for the commands.');
      return;
    }
    if (!parsed) {
      await this.handleFreeText(msg.chat.id, msg.text);
      return;
    }
    if (parsed.to && this.username && parsed.to.toLowerCase() !== this.username.toLowerCase()) {
      // `/status@other_bot` in a shared chat is addressed elsewhere.
      await this.audit('telegram.command', { command: parsed.name, ignored: `addressed to @${parsed.to}` });
      return;
    }
    const cmd = findCommand(parsed.name);
    if (!cmd) {
      await this.audit('telegram.command', { command: parsed.name, known: false });
      await this.send(msg.chat.id, unknownCommandReply(parsed.name));
      return;
    }
    // A command ALWAYS wins over a half-finished conversation: typing /status
    // in the middle of /new is a person changing their mind, not the title of
    // a task. Dropped rather than stacked, and said out loud so the abandoned
    // flow is never a surprise.
    const live = this.flows.get();
    const keepsFlow = cmd.command === 'help' || cmd.command === 'status';
    // `dropped` is what this command ACTUALLY threw away — null when there was
    // no flow, and null for the read-only commands that leave one running.
    // Reading the store again after the handler cannot answer that: the clear
    // has happened and any flow found afterwards is the new one.
    const dropped = live && !keepsFlow ? live : null;
    if (dropped) this.flows.clear();

    let reply: Reply;
    try {
      reply = toReply(
        await cmd.handler({
          storage: this.storage,
          orchestrator: this.orchestrator,
          counters: this.counters,
          bootedAt: this.bootedAt,
          notify: this.cfg.notify,
          persistNotify: () => {
            try {
              saveTelegramNotify(this.cfg.notify);
              return null;
            } catch (e) {
              return errText(e);
            }
          },
          digest: this.cfg.digest,
          digestControl: this.digest,
          persistDigest: () => {
            try {
              saveTelegramDigest(this.cfg.digest);
              return null;
            } catch (e) {
              return errText(e);
            }
          },
          flows: this.flows,
          chatDeps: this.chatDeps(),
          questions: this.questionDeps(),
          confirms: this.confirms,
          limiter: this.limiter,
          hooks: this.hooks,
          actor: ACTOR,
          args: parsed.args,
          message: msg,
          board: { activity: this.activity, memory: this.boardMemory },
        }),
      );
    } catch (e) {
      console.error(`telegram: /${parsed.name} failed:`, errText(e));
      await this.audit('telegram.command', { command: parsed.name, ok: false, error: errText(e) });
      // The drop already happened, above, before the handler ran — so the
      // failure path owes the same note as the success path. Without it a
      // half-finished /new dropped by a command that then threw vanishes with
      // no mention, which is precisely the surprise the note exists to prevent.
      await this.send(
        msg.chat.id,
        dropNote(dropped) + `⚠ <b>/${escapeHtml(parsed.name)}</b> failed: ${escapeHtml(errText(e))}`,
      );
      return;
    }
    // Audited BEFORE the send: the row records that the server acted, which is
    // true even if Telegram then refuses to deliver the answer.
    // `reply.ok` is the WRITE's outcome. A handler that answers
    // "⚠ cannot enqueue from status 'running'" returned normally but performed
    // nothing, and the same refusal pressed as a BUTTON already audits
    // ok: false — one surface must not disagree with the other about whether
    // /publish published.
    await this.audit('telegram.command', {
      command: parsed.name,
      ok: reply.ok !== false,
      args: parsed.args || null,
    });
    const text = dropNote(dropped) + reply.html;
    // A reply carrying a document (`/report`) goes out as ONE upload with the
    // text as its caption, not a message plus a file: two notifications for
    // one command is the thing a phone surface must not do.
    if (reply.document) await this.sendDocument(msg.chat.id, reply.document, text, reply.keyboard);
    else await this.send(msg.chat.id, text, reply.keyboard ?? reply.replyKeyboard);
    // A multi-part question is one message per part (docs/questions.md).
    for (const more of reply.extra ?? []) await this.send(msg.chat.id, more.html, more.keyboard);
  }

  /**
   * A message that is not a command. Either it answers the step a flow is
   * waiting on, or it is a bare thought — and a bare thought never becomes a
   * task on its own: docs/telegram.md keeps that behind an explicit confirm
   * button, because "I was thinking out loud" and "queue this" look identical
   * in a chat window.
   */
  private async handleFreeText(chatId: number, text: string): Promise<void> {
    const flow = this.flows.get();
    let reply: { html: string; keyboard?: InlineKeyboardMarkup };
    try {
      const answered = await handleFlowText(this.flowDeps(), this.flows, text);
      if (answered) {
        // `answered.ok` is the WRITE's outcome, not "a step ran" — a refused
        // edit still produces a perfectly good sentence, and the audit row
        // must not call that a success.
        await this.audit('telegram.command', {
          command: `flow:${flow?.kind}:${flow?.step}`,
          ok: answered.ok,
        });
        reply = answered.reply;
      } else if (flow) {
        // A flow is live but waiting for a BUTTON. Saying so beats swallowing
        // what was typed into a field it was never meant for.
        await this.audit('telegram.command', { command: null, ignored: 'flow expects a button' });
        reply = { html: 'Use the buttons above, or ✕ Cancel to start over.' };
      } else {
        // Chat mode (docs/chat.md) swallows plain text — that is the whole
        // point of it. Checked only when no flow is live: a half-finished
        // /new is answering a question it asked, and a mode must not steal
        // the answer. `offerDraft` stays the behaviour outside chat mode.
        const deps = this.chatDeps();
        const chat = deps && this.cfg.chat.enabled ? await activeChat(this.storage) : null;
        if (chat) {
          await this.sendToChat(chatId, chat, text);
          return;
        }
        await this.audit('telegram.command', { command: null, ignored: 'free text' });
        reply = offerDraft(this.flows, text);
      }
    } catch (e) {
      console.error('telegram: flow step failed:', errText(e));
      this.flows.clear();
      await this.audit('telegram.command', { command: `flow:${flow?.kind}`, ok: false, error: errText(e) });
      reply = { html: `⚠ That step failed: ${escapeHtml(errText(e))}` };
    }
    await this.send(chatId, reply.html, reply.keyboard);
  }

  private flowDeps() {
    return { storage: this.storage, orchestrator: this.orchestrator, actor: ACTOR, questions: this.questionDeps() };
  }

  /** Null when this bot was built without a chat service (a harness). */
  private chatDeps(): ChatDeps | null {
    return this.chats ? { storage: this.storage, chats: this.chats, cfg: this.cfg.chat } : null;
  }

  /**
   * One chat turn, from the phone.
   *
   * Awaits the ACCEPTANCE only, and that is load-bearing: this runs inside the
   * update loop, which handles updates one at a time. Awaiting the reply would
   * make the whole bot deaf for the minutes the turn takes — no /endchat, no
   * /status, and in particular no ⏹ Stop for the very turn you are waiting on.
   * The two-phase `send()` (docs/chat.md § The API) exists so this method can
   * return as soon as the message is safely stored and let the reply land on
   * its own.
   *
   * The tail keeps the typing indicator alive for the whole turn — Telegram
   * clears it after ~5s and a silent five minutes reads as a dead bot — and
   * clears the timer on every path, including a throw.
   */
  private async sendToChat(chatId: number, chat: Chat, text: string): Promise<void> {
    const deps = this.chatDeps()!;
    // The security boundary, and it is HERE rather than only on /mode: a chat
    // switched to write in the browser and left there would otherwise let an
    // unlocked handset run anything. Refused before the turn is accepted, so
    // nothing is stored and nothing is spawned (docs/chat.md § From the phone).
    if (!phoneMaySend(deps.cfg, chat)) {
      await this.audit('telegram.command', {
        command: 'chat',
        ok: false,
        target: chat.id,
        error: 'write mode not allowed from telegram',
      });
      await this.send(chatId, WRITE_BLOCKED_REPLY);
      return;
    }
    const accepted = await deps.chats.send(chat.id, text, ACTOR);
    if (!accepted.ok) {
      await this.audit('telegram.command', { command: 'chat', ok: false, target: chat.id, error: accepted.error });
      await this.send(chatId, `⚠ ${escapeHtml(accepted.error)}`);
      return;
    }
    const turn = accepted.value;
    // Detached on purpose — see above. It resolves rather than throws, and the
    // catch is the floor under `this.send` failing on a network blip.
    void (async () => {
      const typing = setInterval(() => {
        // Best effort: an indicator that failed must not cost the reply.
        void this.api.sendChatAction(chatId, 'typing').catch(() => {});
      }, 4000);
      void this.api.sendChatAction(chatId, 'typing').catch(() => {});
      try {
        const done = await turn.done;
        // The turn's own audit row is written by the service (`chat.turn`);
        // this one records that the PHONE was the surface, like every command.
        await this.audit('telegram.command', { command: 'chat', ok: done.ok, target: chat.id });
        if (!done.ok) await this.send(chatId, `⚠ <b>${escapeHtml(chat.title)}</b> — ${escapeHtml(done.error)}`);
        else await this.send(chatId, renderReply(done.value.text));
      } catch (e) {
        console.error('telegram: chat reply failed to deliver:', errText(e));
      } finally {
        clearInterval(typing);
      }
    })();
  }

  /**
   * A button press. Same gate as messages — the presser's id, and (when the
   * carrying message survived Telegram's 48h window) the chat it lives in
   * must both be the owner's private chat. Buttons only ever go out to that
   * chat, so a mismatch means a forwarded message or a forged update.
   */
  private async handleCallback(cb: TelegramCallbackQuery): Promise<void> {
    const from = cb.from;
    const authorized =
      !!from &&
      from.id === this.cfg.allowedUserId &&
      (!cb.message || (cb.message.chat.id === this.cfg.allowedUserId && cb.message.chat.type === 'private'));
    if (!authorized) {
      // Dropped in silence like every other unauthorized update; their client
      // spinner times out on its own.
      await this.countRejection(from?.id ?? null);
      return;
    }
    // Wizard buttons first. They live in their own `w:` namespace precisely so
    // a stale one can be REFUSED (the flow it belonged to is gone) instead of
    // being misread as one of the stateless action buttons, which stay valid
    // forever — a Publish button on a week-old notification still means one
    // thing, a "pick this repo" button does not.
    const flowButton = cb.data ? parseFlowData(cb.data) : null;
    if (flowButton) {
      await this.handleFlowPress(cb, flowButton);
      return;
    }
    // Then the confirm buttons. Same reason they go before the action codec:
    // they EXPIRE, and an expired one must be refused rather than fall through
    // to a stateless action that is still valid a week later.
    const confirmButton = cb.data ? parseConfirmData(cb.data) : null;
    if (confirmButton) {
      await this.handleConfirmPress(cb, confirmButton);
      return;
    }
    // Then the chat buttons. Before the action codec for the same reason as
    // the two above: they name a chat that either surface can delete, so a
    // stale one must be refused rather than fall through to a codec whose
    // buttons stay valid forever.
    const chatButton = cb.data ? parseChatData(cb.data) : null;
    if (chatButton) {
      await this.handleChatPress(cb, chatButton);
      return;
    }
    // Then the question buttons — same reason again: a question is answered
    // or expired within hours, and a stale one must be refused with the
    // outcome, never fall through to the codec.
    const questionButton = cb.data ? parseQuestionData(cb.data) : null;
    if (questionButton) {
      await this.handleQuestionPress(cb, questionButton);
      return;
    }
    // The board (docs/telegram.md § The board). Navigation only — a tab, a
    // page, a card, a 🔄 — so it is deliberately NOT audited; the mutations
    // its action buttons carry go through the codec below like any other.
    const listButton = cb.data ? parseListData(cb.data) : null;
    if (listButton) {
      await this.handleListPress(cb, listButton);
      return;
    }
    const action = cb.data ? parseActionData(cb.data) : null;
    if (!action) {
      await this.audit('telegram.command', { command: 'button', ignored: 'unparseable callback data' });
      await this.answerCallback(cb.id, 'Unknown button');
      return;
    }
    // Proceed is a conversation, not a one-tap action. `/proceed <id>` with no
    // text deliberately asks what to do next rather than resuming with the
    // generic "carry on from where you left off"; a button that did the latter
    // would undo that rule from the other side, one tap at a time. So the
    // button starts the same flow — and gets the same "is there a session to
    // resume" pre-check.
    if (action.kind === 'task.proceed') {
      await this.startProceedFromButton(cb, action.id);
      return;
    }
    let outcome: ActionOutcome;
    try {
      outcome = await runButtonAction({ storage: this.storage, orchestrator: this.orchestrator }, action, ACTOR);
    } catch (e) {
      outcome = { ok: false, text: errText(e) };
    }
    // Audited BEFORE the answers, like commands: the row records that the
    // server acted, which stays true if Telegram then fails to deliver.
    await this.audit('telegram.command', {
      command: `button:${action.kind}`,
      target: action.id,
      ok: outcome.ok,
      ...(outcome.ok ? {} : { error: outcome.text }),
    });
    const sentence = `${outcome.ok ? '✅' : '⚠'} ${outcome.text}`;
    // Pressed on a board or a card: that message redraws itself with the new
    // state and the outcome is the toast — no second message, no stale
    // buttons left behind (docs/telegram.md § The board).
    const where = messageContext(cb.message?.reply_markup);
    if (where) {
      let redrawn: Reply | null = null;
      try {
        redrawn = await this.renderContext(where);
      } catch (e) {
        console.warn('telegram: redraw after a button failed:', errText(e));
      }
      if (redrawn) {
        await this.answerCallback(cb.id, sentence);
        await this.redraw(cb, redrawn);
        return;
      }
    }
    await this.answerCallback(cb.id, outcome.ok ? 'Done' : 'Failed');
    await this.send(this.cfg.allowedUserId, `${outcome.ok ? '✅' : '⚠'} ${escapeHtml(outcome.text)}`);
    if (outcome.ok) await this.retireStaleButtons(cb, action);
  }

  private boardDeps(): BoardDeps {
    return { storage: this.storage, orchestrator: this.orchestrator, activity: this.activity, memory: this.boardMemory };
  }

  /** What a board or a card looks like NOW. A card whose task is gone falls back to its board. */
  private async renderContext(where: MessageContext): Promise<Reply> {
    if (where.kind === 'board') return renderBoard(this.boardDeps(), where.state);
    const found = await resolveTask(this.storage, where.task);
    return found.ok ? renderCard(this.boardDeps(), found.value, where.back) : renderBoard(this.boardDeps(), where.back);
  }

  /**
   * An `l:` press. Every branch answers the callback exactly once; the ones
   * that open something (a question, a proposal, a feature plan) send it as a
   * NEW message because it carries its own keyboard, and leave the board alone.
   */
  private async handleListPress(cb: TelegramCallbackQuery, button: ListButton): Promise<void> {
    const toMe = this.cfg.allowedUserId;
    try {
      switch (button.kind) {
        case 'noop':
          await this.answerCallback(cb.id);
          return;
        case 'board': {
          const reply = await renderBoard(this.boardDeps(), button.state);
          await this.answerCallback(cb.id);
          await this.redraw(cb, reply);
          return;
        }
        case 'card': {
          const found = await resolveTask(this.storage, button.task);
          if (!found.ok) {
            // Stale (gone) or ambiguous short id: say why, and put the board
            // it came from back — never guess between two tasks.
            await this.answerCallback(cb.id, found.error);
            await this.redraw(cb, await renderBoard(this.boardDeps(), button.back));
            return;
          }
          const reply = await renderCard(this.boardDeps(), found.value, button.back);
          await this.answerCallback(cb.id);
          await this.redraw(cb, reply);
          return;
        }
        case 'ask': {
          const found = await resolveTask(this.storage, button.task);
          if (!found.ok) {
            await this.answerCallback(cb.id, found.error);
            return;
          }
          const pending = await this.storage.listQuestions({ status: 'pending', taskId: found.value.id });
          if (pending.length === 0) {
            await this.answerCallback(cb.id, 'No open question — it was answered or expired');
            const where = messageContext(cb.message?.reply_markup);
            if (where) await this.redraw(cb, await this.renderContext(where));
            return;
          }
          await this.answerCallback(cb.id);
          for (const q of pending) {
            for (const r of questionMessages(q, found.value, this.questionDrafts)) await this.send(toMe, r.html, r.keyboard);
          }
          return;
        }
        case 'proposal': {
          const found = await resolveProposal(this.storage, button.id);
          if (!found.ok || found.value.status !== 'pending') {
            await this.answerCallback(cb.id, found.ok ? `That proposal is already ${found.value.status}` : found.error);
            const where = messageContext(cb.message?.reply_markup);
            if (where) await this.redraw(cb, await this.renderContext(where));
            return;
          }
          const msg = proposalMessage(found.value);
          await this.answerCallback(cb.id);
          await this.send(toMe, msg.html, msg.keyboard);
          return;
        }
        case 'feature': {
          const found = await resolveFeature(this.storage, button.id);
          if (!found.ok) {
            await this.answerCallback(cb.id, found.error);
            return;
          }
          const f = found.value;
          const doc = await buildReport(this.storage, { kind: 'feature', feature: f });
          const caption = `🧩 <b>${escapeHtml(f.title)}</b> · ${escapeHtml(f.status)}\n\n${doc.lines.map((l) => escapeHtml(l)).join('\n')}`;
          await this.answerCallback(cb.id);
          await this.sendDocument(toMe, doc, caption, f.status === 'proposed' ? featureKeyboard(f.id) : undefined);
          return;
        }
      }
    } catch (e) {
      console.error('telegram: board button failed:', errText(e));
      await this.answerCallback(cb.id, 'Failed');
      await this.send(toMe, `⚠ ${escapeHtml(errText(e))}`);
    }
  }

  /**
   * Put `reply` in place of the pressed message. Falls back to a fresh send
   * when there is no message to edit (aged past 48h — Telegram then hands an
   * inaccessible stub with date 0), when the text cannot be one message, or
   * when Telegram refuses the edit for any reason but "nothing changed".
   */
  private async redraw(cb: TelegramCallbackQuery, reply: Reply): Promise<void> {
    const m = cb.message;
    if (m && m.date !== 0 && reply.html.length <= MAX_MESSAGE_CHARS) {
      try {
        await this.api.editMessageText(m.chat.id, m.message_id, reply.html, { signal: this.abort.signal }, reply.keyboard);
        return;
      } catch (e) {
        if (this.abort.signal.aborted || isNotModified(e)) return;
        console.warn('telegram: editMessageText failed, sending fresh:', errText(e));
      }
    }
    await this.send(this.cfg.allowedUserId, reply.html, reply.keyboard);
  }

  /**
   * After a successful action pressed on a message that is neither a board nor
   * a card (a review ping, a proposal, a feature plan), swap its keyboard for
   * what is possible now — but only when EVERY button on it targets the same
   * id, so a list of several things never loses the others' buttons.
   */
  private async retireStaleButtons(cb: TelegramCallbackQuery, action: NonNullable<ReturnType<typeof parseActionData>>) {
    const m = cb.message;
    const buttons = m?.reply_markup?.inline_keyboard.flat() ?? [];
    if (!m || m.date === 0 || buttons.length === 0) return;
    if (!buttons.every((b) => parseActionData(b.callback_data)?.id === action.id)) return;
    try {
      let next: InlineKeyboardMarkup | undefined;
      if (action.kind.startsWith('task.')) {
        const t = await this.storage.getTask(action.id);
        next = t ? taskActionKeyboard(t) : undefined;
      }
      await this.api.editMessageReplyMarkup(m.chat.id, m.message_id, next, { signal: this.abort.signal });
    } catch (e) {
      if (!this.abort.signal.aborted && !isNotModified(e)) console.warn('telegram: could not retire stale buttons:', errText(e));
    }
  }

  /**
   * A wizard press. Same gate as any other button (handleCallback ran it
   * already); the difference is that the flow, not the payload, decides what
   * the press means — a press for a step the flow has moved past is stale and
   * is refused rather than replayed.
   */
  private async handleFlowPress(cb: TelegramCallbackQuery, button: FlowButton): Promise<void> {
    let press: Awaited<ReturnType<typeof handleFlowButton>>;
    try {
      press = await handleFlowButton(this.flowDeps(), this.flows, button);
    } catch (e) {
      console.error('telegram: flow button failed:', errText(e));
      this.flows.clear();
      press = { toast: 'Failed', reply: { html: `⚠ ${escapeHtml(errText(e))}` }, audit: `flow:${button.step}`, ok: false };
    }
    // Audited BEFORE the answers, like every other command.
    await this.audit('telegram.command', {
      command: `button:${press.audit}`,
      value: button.value,
      ok: press.ok,
    });
    await this.answerCallback(cb.id, press.toast);
    if (press.reply) await this.send(this.cfg.allowedUserId, press.reply.html, press.reply.keyboard);
  }

  /**
   * A confirm press — the second half of every destructive command.
   *
   * `take()` CONSUMES the window, and that single fact answers the two things
   * a reviewer probes here. A duplicated update (Telegram redelivering after a
   * network blip, or a double-tap arriving as two callback_query updates)
   * finds an empty store on its second visit and is refused, so nothing fires
   * twice. And a press that survived a restart finds an empty store too — the
   * window lives in memory only.
   *
   * The nonce is also the only identity on the wire: the window's KIND is held
   * here, so a captured `k:go:<nonce>` cannot be re-pointed at a different
   * action, and a nonce spent on `/killall` cannot fire a `/restart`.
   *
   * Everything below is inside one try/catch, per the rule the loop's
   * `safeDispatch` exists to enforce: a branch that throws bare is a branch
   * that can silence the bot until the next restart.
   */
  /** A `c:` press (docs/chat.md). Same gate as any other button. */
  private async handleChatPress(cb: TelegramCallbackQuery, button: ChatButton): Promise<void> {
    const deps = this.chatDeps();
    if (!deps) {
      await this.answerCallback(cb.id, 'Chat is unavailable');
      return;
    }
    let press: Awaited<ReturnType<typeof handleChatButton>>;
    try {
      press = await handleChatButton(deps, button, ACTOR);
    } catch (e) {
      console.error('telegram: chat button failed:', errText(e));
      press = { reply: { html: `⚠ ${escapeHtml(errText(e))}`, ok: false }, toast: 'Failed' };
    }
    // Audited BEFORE the answers, like every other button.
    await this.audit('telegram.command', {
      command: `button:chat.${button.kind}`,
      target: button.id,
      ok: press.reply.ok !== false,
    });
    await this.answerCallback(cb.id, press.toast);
    await this.send(this.cfg.allowedUserId, press.reply.html, press.reply.keyboard);
  }

  private async handleQuestionPress(cb: TelegramCallbackQuery, button: QuestionButton): Promise<void> {
    const deps = this.questionDeps();
    if (!deps) {
      await this.answerCallback(cb.id, 'Questions are unavailable');
      return;
    }
    let press: Awaited<ReturnType<typeof handleQuestionButton>>;
    try {
      press = await handleQuestionButton(deps, button);
    } catch (e) {
      console.error('telegram: question button failed:', errText(e));
      press = { reply: { html: `⚠ ${escapeHtml(errText(e))}`, ok: false }, toast: 'Failed' };
    }
    // Audited BEFORE the answers, like every other button.
    await this.audit('telegram.command', {
      command: `button:question.${button.verb}`,
      target: button.id,
      ok: press.reply.ok !== false,
    });
    await this.answerCallback(cb.id, press.toast);
    await this.send(this.cfg.allowedUserId, press.reply.html, press.reply.keyboard);
  }

  private questionDeps(): QuestionDeps | null {
    return this.questions
      ? { storage: this.storage, questions: this.questions, drafts: this.questionDrafts, flows: this.flows, actor: ACTOR }
      : null;
  }

  private async handleConfirmPress(cb: TelegramCallbackQuery, button: ConfirmButton): Promise<void> {
    let confirm: Confirm | null = null;
    try {
      confirm = this.confirms.take(button.nonce);
      if (!confirm) {
        await this.audit('telegram.command', {
          command: 'button:confirm',
          ok: false,
          error: 'no such confirm window (expired, already used, or from before a restart)',
        });
        await this.answerCallback(cb.id, 'Expired');
        await this.send(
          this.cfg.allowedUserId,
          '⌛ That confirm has expired, was already used, or belongs to a previous run of the server. Send the command again.',
        );
        return;
      }
      if (button.verb === 'no') {
        // Cancelling destroyed nothing, so it costs no rate-limit slot.
        await this.audit('telegram.command', { command: `button:confirm:${confirm.kind}`, ok: true, cancelled: true });
        await this.answerCallback(cb.id, 'Cancelled');
        await this.send(this.cfg.allowedUserId, `✅ ${escapeHtml(CONFIRM_LABEL[confirm.kind])} cancelled — nothing was touched.`);
        return;
      }
      if (confirm.kind === 'killall') await this.runKillAll();
      else await this.runRestart(confirm.kind === 'restart-force');
    } catch (e) {
      console.error('telegram: confirm press failed:', errText(e));
      await this.audit('telegram.command', {
        command: `button:confirm:${confirm?.kind ?? 'unknown'}`,
        ok: false,
        error: errText(e),
      }).catch(() => {});
      await this.answerCallback(cb.id, 'Failed');
      await this.send(this.cfg.allowedUserId, `⚠ That failed: ${escapeHtml(errText(e))}`);
      return;
    }
    await this.answerCallback(cb.id, 'Done');
  }

  /** The red button, once confirmed. */
  private async runKillAll(): Promise<void> {
    this.limiter.record('/killall');
    // Armed BEFORE the kills go out: a pty can exit inside the same tick that
    // signalled it, and an exit that lands before the watcher is listening
    // would leave the follow-up waiting for an event that already happened.
    this.killWatcher.arm();
    const report = await executeKillAll({ storage: this.storage, orchestrator: this.orchestrator }, ACTOR);
    // A domain row of its own, not just the transport one: "what killed my
    // session?" should be answerable from a single event, even though every
    // leg also wrote its own task.transition / run.killed / feature.transition.
    await this.audit('telegram.killall', {
      queueWasEnabled: report.queueWasEnabled,
      killed: report.killed.map((k) => ({ runId: k.runId, taskId: k.taskId, mode: k.mode, title: k.title })),
      killFailed: report.killFailed.map((f) => ({ runId: f.target.runId, reason: f.reason })),
      cancelled: report.cancelled,
      cancelFailed: report.cancelFailed,
      paused: report.paused,
      dispatchesCancelled: report.dispatchesCancelled,
      headlessStopped: report.headlessStopped,
      resweptSomething: report.resweptSomething,
      idle: report.idle,
    });
    await this.audit('telegram.command', { command: 'button:confirm:killall', ok: true });
    await this.send(this.cfg.allowedUserId, renderKillAllReport(report));
    // The message above says what was SIGNALLED. The follow-up says what has
    // actually exited — see KillWatcher.
    this.killWatcher.expect(report.killed);
  }

  /** The restart, once confirmed. `force` only ever comes from a window that
   *  was armed as `restart-force`, i.e. after the guard already refused once
   *  and the owner pressed a button that says so. */
  private async runRestart(force: boolean): Promise<void> {
    if (!this.hooks) {
      await this.send(this.cfg.allowedUserId, '⚠ Restart is not available in this process (no front door wired).');
      return;
    }
    this.limiter.record('/restart');
    // Sent BEFORE the request: the front door answers by killing this process,
    // so anything we tried to send afterwards would die with the socket.
    await this.send(
      this.cfg.allowedUserId,
      force
        ? '🔄 Forcing a restart — every session dies with it. The next message will be the boot notice.'
        : '🔄 Restarting through the front door. The next message will be the boot notice.',
    );
    await this.audit('telegram.restart', { force, hostPort: this.hooks.hostPort, supervised: this.hooks.supervised });
    const result = await requestHostRestart(this.hooks.hostPort, force);
    await this.audit('telegram.command', { command: 'button:confirm:restart', ok: result.ok, force });
    if (result.ok) return; // the boot message is the confirmation
    await this.send(
      this.cfg.allowedUserId,
      result.blocked
        ? `⛔ The restart guard refused: ${escapeHtml(result.error)}`
        : `⚠ Restart failed: ${escapeHtml(result.error)}`,
    );
  }

  /**
   * The 💬 Proceed button, on a `/task` card or a review notification: resolve
   * the task, refuse when nothing is resumable, otherwise open the same
   * reply-to conversation `/proceed <id>` opens. Whatever the human types next
   * becomes the instruction.
   */
  private async startProceedFromButton(cb: TelegramCallbackQuery, taskId: string): Promise<void> {
    let reply: Reply;
    let ok = false;
    // Guarded like every sibling path (`cmd.handler`, `handleFlowText`,
    // `handleFlowButton`, `runButtonAction`): both calls below reach storage,
    // and a throw here must cost this press, not the poll loop.
    try {
      const task = await this.storage.getTask(taskId);
      if (!task) {
        reply = { html: '⚠ That task is gone.' };
      } else if ((await this.orchestrator.resumableSessionId(taskId)) === null) {
        reply = {
          html:
            `⚠ “${escapeHtml(task.title)}” has no claude session to resume — ` +
            `<code>/run ${taskId.slice(0, 8)}</code> starts a fresh agent instead.`,
        };
      } else {
        // Starting a flow is a command-shaped act, so it drops whatever was in
        // progress — and SAYS so, exactly as a typed /proceed would. Clearing
        // bare was the silent-vanish this rule exists to prevent.
        const dropped = this.flows.get();
        this.flows.clear();
        const resumable = true; // checked immediately above
        const prompt = startProceed(this.flows, task.id, task.title, resumable);
        reply = { ...prompt, html: dropNote(dropped) + prompt.html };
        ok = true;
      }
    } catch (e) {
      console.error('telegram: proceed button failed:', errText(e));
      reply = { html: `⚠ Could not open that: ${escapeHtml(errText(e))}` };
    }
    await this.audit('telegram.command', { command: 'button:task.proceed', target: taskId, ok });
    await this.answerCallback(cb.id, ok ? 'What next?' : 'Nothing to resume');
    await this.send(this.cfg.allowedUserId, reply.html, reply.keyboard);
  }

  private async answerCallback(id: string, text?: string): Promise<void> {
    try {
      await this.api.answerCallbackQuery(id, text, { signal: this.abort.signal });
    } catch (e) {
      if (!this.abort.signal.aborted) console.warn('telegram: answerCallbackQuery failed:', errText(e));
    }
  }

  /** Count a dropped update. No reply, ever — see reject() for the one exception. */
  private async countRejection(userId: number | null): Promise<void> {
    this.counters.rejected++;
    this.pendingRejects++;
    // The owner's OWN id, refused because the chat was a group, is not a
    // stranger — counting it as one would make /status accuse its reader.
    if (userId !== null && userId !== this.cfg.allowedUserId) {
      if (this.seenStrangers.size < MAX_TRACKED_STRANGERS) this.seenStrangers.add(userId);
      else this.counters.rejectedUsersCapped = true;
    }
    this.counters.rejectedUsers = this.seenStrangers.size;
    await this.flushRejectAudit(false);
  }

  /**
   * Anyone can message a bot by its name, so everything that is not the owner
   * is dropped in silence and counted (visible in /status) — with one
   * exception the setup depends on: `/start` gets told which id it is, because
   * finding your own Telegram user id is otherwise a third-party bot's job.
   *
   * That exception is fenced on three sides, and each fence is load-bearing:
   *
   * - **private chats only.** Group privacy mode still delivers slash commands
   *   to a bot, and anyone can add a bot to a group. Without this check, a
   *   stranger turns this server into something that posts unsolicited into
   *   arbitrary groups.
   * - **never to the owner.** The owner typing `/start` in a group lands here
   *   too (the chat is not private), and the reply would publish the owner's
   *   own user id — the one value the entire gate is built on — to everyone in
   *   that group.
   * - **throttled per id**, so it cannot be turned into an echo service.
   */
  private async reject(
    chatId: number,
    chatType: string,
    userId: number | null,
    command: string | null,
  ): Promise<void> {
    await this.countRejection(userId);
    if (
      command === 'start' &&
      userId !== null &&
      userId !== this.cfg.allowedUserId &&
      chatType === 'private' &&
      this.mayAnswerStranger(userId)
    ) {
      await this.send(
        chatId,
        `Not allowed. Your Telegram user id is <code>${userId}</code>.\n` +
          `If this bot is yours, put that number in <code>server/data/config.json</code> as ` +
          `<code>telegram.allowedUserId</code> and restart the server.`,
      );
    }
  }

  private mayAnswerStranger(userId: number): boolean {
    const now = Date.now();
    const last = this.strangerReplyAt.get(userId);
    if (last !== undefined && now - last < STRANGER_REPLY_COOLDOWN_MS) return false;
    if (last === undefined && this.strangerReplyAt.size >= MAX_TRACKED_STRANGERS) {
      // The table is full of strangers; stop answering new ones rather than
      // let an unauthenticated caller grow a map inside this process.
      return false;
    }
    this.strangerReplyAt.set(userId, now);
    return true;
  }

  /**
   * Rejections are audited as a periodic SUMMARY, not one row each: the events
   * table would otherwise be a write target for anyone who knows the bot's
   * name. Six rows an hour at most, whatever the flood — plus the very first
   * one, which goes through immediately (`lastRejectAudit` starts at 0) so
   * that "someone found the bot" is not news that waits ten minutes.
   */
  private async flushRejectAudit(force: boolean): Promise<void> {
    if (this.pendingRejects === 0) return;
    const now = Date.now();
    if (!force && now - this.lastRejectAudit < REJECT_AUDIT_INTERVAL_MS) return;
    const dropped = this.pendingRejects;
    this.pendingRejects = 0;
    this.lastRejectAudit = now;
    await this.audit('telegram.rejected', {
      dropped,
      totalSinceBoot: this.counters.rejected,
      distinctUsers: this.counters.rejectedUsers,
    }).catch(() => {});
  }

  // ---- plumbing ---------------------------------------------------------

  private async sendBootMessage(): Promise<void> {
    // `boot` is an event class like any other (docs/telegram.md § Notifications).
    if (!this.cfg.notify.boot) return;
    const discarded = this.counters.discardedAtBoot;
    await this.send(
      this.cfg.allowedUserId,
      [
        `<b>Task Manager is back online.</b>`,
        discarded > 0
          ? `${discarded} update(s) from before the restart were discarded — resend anything that still matters.`
          : `Nothing was waiting from before the restart.`,
        `Up since ${escapeHtml(formatClock(this.bootedAt))}. Send /status.`,
      ].join('\n'),
    );
  }

  /**
   * Upload a report and say the gist in the same breath. The caption carries
   * the Russian summary; if it is over Telegram's 1024-character caption cap,
   * api.ts hands it back as `overflow` and it goes out as its own (chunked)
   * message instead of being cut — the summary is the part that has to arrive
   * whole, since it is what is readable without opening the file.
   */
  private async sendDocument(
    chatId: number,
    doc: { filename: string; html: string },
    caption?: string,
    keyboard?: InlineKeyboardMarkup,
  ): Promise<void> {
    try {
      await this.deliverDocument(chatId, doc, caption, keyboard);
    } catch (e) {
      if (this.abort.signal.aborted) return;
      console.warn('telegram: sendDocument failed:', errText(e));
      // A failed upload must not swallow the summary: the gist still goes out
      // as a plain message, which is the whole point of duplicating it.
      if (caption) await this.send(chatId, caption, keyboard);
    }
  }

  /**
   * The same upload, but it THROWS. The digest needs that: it records the day
   * as sent only on success, so a Telegram outage at 09:00 has to be visible
   * as a rejection here or the scheduler would mark the day done and lose it.
   */
  private async deliverDocument(
    chatId: number,
    doc: { filename: string; html: string },
    caption?: string,
    keyboard?: InlineKeyboardMarkup,
  ): Promise<void> {
    const { overflow } = await this.api.sendDocument(chatId, doc, caption, { signal: this.abort.signal }, keyboard);
    if (overflow) await this.send(chatId, overflow);
  }

  private async send(chatId: number, html: string, keyboard?: InlineKeyboardMarkup | ReplyKeyboardMarkup): Promise<void> {
    try {
      await this.api.sendMessage(chatId, html, { signal: this.abort.signal }, keyboard);
    } catch (e) {
      if (this.abort.signal.aborted) return;
      console.warn('telegram: sendMessage failed:', errText(e));
    }
  }

  private async audit(
    kind: 'telegram.command' | 'telegram.rejected' | 'telegram.bot' | 'telegram.killall' | 'telegram.restart',
    data: Record<string, unknown>,
  ) {
    try {
      await this.storage.appendEvent({ kind, actor: 'telegram', data });
    } catch (e) {
      console.warn('telegram: could not write the audit event:', errText(e));
    }
  }

  /** Returns false when the loop must end (stopped, or an unrecoverable token). */
  private async backoff(e: unknown, what: string): Promise<boolean> {
    if (!this.running || this.abort.signal.aborted) return false;
    if (e instanceof TelegramApiError && e.fatal) {
      // Reached only for a real `ok: false` envelope carrying 401/404 (see
      // TelegramApiError.fatal) — Telegram itself refusing the token, not a
      // proxy's error page wearing the same status code.
      console.error(
        `telegram: ${what} refused by Telegram (${e.message}). The token in data/config.json is wrong, ` +
          `revoked, or belongs to a deleted bot — the bot is stopping until the server restarts.`,
      );
      this.running = false;
      this.fatal = true;
      return false;
    }
    this.failures++;
    let waitMs =
      e instanceof TelegramApiError && e.retryAfter
        ? Math.min(e.retryAfter * 1000, 300_000)
        : Math.min(1000 * 2 ** Math.min(this.failures - 1, 6), 60_000);
    // Jitter: a flapping network otherwise produces a metronome of retries.
    waitMs = Math.round(waitMs * (0.8 + Math.random() * 0.4));
    if (this.failures === 1 || this.failures % 10 === 0) {
      const hint =
        e instanceof TelegramApiError && e.code === 409
          ? ' — another process is polling this bot token (a second server, or a webhook still set)'
          : '';
      console.warn(`telegram: ${what} failed: ${errText(e)}${hint}; retrying in ${Math.round(waitMs / 1000)}s`);
    }
    await this.sleep(waitMs);
    return this.running;
  }

  /** setTimeout that also resolves the moment stop() aborts. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.abort.signal;
      if (signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      // .unref() so a pending backoff never keeps the process alive on exit.
      timer.unref?.();
      signal.addEventListener('abort', done, { once: true });
    });
  }
}
