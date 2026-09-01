import { saveTelegramNotify, type TelegramConfig } from '../config.ts';
import type { Orchestrator } from '../orchestrator.ts';
import type { Storage } from '../storage/types.ts';
import { parseActionData, runButtonAction, type ActionOutcome } from './actions.ts';
import { TelegramApi, TelegramApiError, escapeHtml, toReply, type Reply } from './api.ts';
import { commandSpecs, findCommand, parseCommand, unknownCommandReply } from './commands.ts';
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
import { TelegramNotifier } from './notifications.ts';
import { formatClock, type GateCounters } from './status.ts';
import type { InlineKeyboardMarkup, TelegramCallbackQuery, TelegramUpdate } from './types.ts';

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
  /**
   * The single conversational flow (docs/telegram.md § Conversations). One
   * user means one flow; it lives in memory and dies with the process, which
   * is the same rule the boot-discard filter enforces for updates.
   */
  private readonly flows = new FlowStore();

  constructor(
    private readonly cfg: TelegramConfig,
    private readonly storage: Storage,
    private readonly orchestrator: Orchestrator,
  ) {
    this.api = new TelegramApi(cfg.botToken);
    this.notifier = new TelegramNotifier({
      storage,
      // The live object, not a copy: /mute and /notify flip cfg.notify in
      // place and the notifier must see it at its next flush.
      notify: cfg.notify,
      isReviewPending: (taskId) => orchestrator.isReviewPending(taskId),
      send: (html, keyboard) => this.send(cfg.allowedUserId, html, keyboard),
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
    const parsed = msg.text ? parseCommand(msg.text) : null;
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
          flows: this.flows,
          actor: ACTOR,
          args: parsed.args,
          message: msg,
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
    await this.send(msg.chat.id, dropNote(dropped) + reply.html, reply.keyboard);
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
    return { storage: this.storage, orchestrator: this.orchestrator, actor: ACTOR };
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
    await this.answerCallback(cb.id, outcome.ok ? 'Done' : 'Failed');
    await this.send(this.cfg.allowedUserId, `${outcome.ok ? '✅' : '⚠'} ${escapeHtml(outcome.text)}`);
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

  private async send(chatId: number, html: string, keyboard?: InlineKeyboardMarkup): Promise<void> {
    try {
      await this.api.sendMessage(chatId, html, { signal: this.abort.signal }, keyboard);
    } catch (e) {
      if (this.abort.signal.aborted) return;
      console.warn('telegram: sendMessage failed:', errText(e));
    }
  }

  private async audit(kind: 'telegram.command' | 'telegram.rejected' | 'telegram.bot', data: Record<string, unknown>) {
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
