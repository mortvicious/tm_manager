import type { Feature, Proposal, Question, ReviewState, ServerEvent, Task, UsageSnapshot, UsageWindow } from '@tm/shared';
import { usageSnapshot } from '../claude/usage.ts';
import type { TelegramNotifyConfig } from '../config.ts';
import { onEvent } from '../events.ts';
import type { Storage } from '../storage/types.ts';
import { encodeAction } from './actions.ts';
import { escapeHtml, type Reply } from './api.ts';
import { buildReport, type ReportDocument } from './report.ts';
import type { InlineKeyboardMarkup } from './types.ts';
import { questionMessages, settledNotice } from './questions.ts';

// The push half of the bot (docs/telegram.md § Notifications): subscribes to
// the same in-process broadcast() bus the /ws/events endpoint fans out to
// browsers, and turns the events a phone should hear about into messages.
//
// Three rules shape everything here:
//
// - **Coalesce, then re-check.** A task can bounce review → running → review
//   in seconds (the adversarial-review fix loop), and one mutation often emits
//   several broadcasts. Every task-scoped notification waits COALESCE_MS and
//   then re-reads the entity from storage; only what is STILL true gets sent.
//   That re-check is also what keeps the fix loop quiet: a review landing
//   followed by a fix round back into `running` flushes into nothing.
// - **The row is the truth.** The "in review" ping waits for the task's own
//   `reviewState` to settle (`docs/design.md` § Adversarial review) — an
//   entry that still reads pending/reviewing is not announced, and the update
//   that settles it is what triggers the ping. The attention ping is re-read
//   against the LIVE RUN at flush, never against the event that raised it.
// - **The bus is live-only.** Events fired while the bot is stopped are not
//   replayed — the "back online" message plus /status are the catch-up story.
// - **Config is read at flush time**, so /mute takes effect for messages
//   already in the 5s window too.

const COALESCE_MS = 5_000;
const USAGE_POLL_MS = 60_000;
/** Ascending; a crossing notifies once per window per threshold. */
const USAGE_THRESHOLDS_PCT = [50, 80, 95];
/** The task's summary is quoted in the review ping — bounded so the message
 *  (Telegram caps one at 4096 chars) always has room for the title and verdict. */
const SUMMARY_CLIP = 1500;

interface PendingTask {
  review?: boolean;
  /** a requested ("Review now") round settled on a task NOT in `review` */
  reviewedElsewhere?: boolean;
  failed?: boolean;
  blocked?: boolean;
  published?: boolean;
  /** the run whose needs-attention flag was raised — re-read at flush */
  attentionRun?: string;
}

export interface NotifierDeps {
  storage: Storage;
  notify: TelegramNotifyConfig;
  send(html: string, keyboard?: InlineKeyboardMarkup): Promise<void>;
  /**
   * Is a "Review now" round in flight for this task? A verdict on a `done`/
   * `failed`/`blocked` task is only pinged when a human asked for it — the
   * automatic round on a `done` (autoComplete) task stays as quiet as ever.
   * Absent in a harness: no such pings.
   */
  requestedReview?(taskId: string): boolean;
  /**
   * Upload a report with the text as its caption (docs/telegram.md § Reports).
   * The feature-plan message uses it so an analyzed plan arrives as the same
   * document `/report feature <id>` produces, rather than a second, divergent
   * rendering of the same facts.
   */
  sendDocument(
    doc: { filename: string; html: string },
    caption?: string,
    keyboard?: InlineKeyboardMarkup,
  ): Promise<void>;
}

const short = (id: string) => id.slice(0, 8);

const unsettled = (state: ReviewState | null | undefined): boolean => state === 'pending' || state === 'reviewing';

function verdictBadge(verdict: string): string {
  return verdict === 'clean' ? '✓ clean' : verdict === 'blocker' ? '⛔ blocker' : `⚠ ${verdict}`;
}

/**
 * The review verdict clause of the "in review" ping, from the task row: what
 * the reviewer said about THIS change. Bare when the change was never
 * auto-reviewed (publish landing, review off) — a stale badge next to live
 * Publish buttons would invite shipping on it.
 */
export function reviewClause(task: Task): string | null {
  const last = task.reviewRounds[task.reviewRounds.length - 1];
  switch (task.reviewState) {
    case 'passed': {
      if (!last) return null;
      const minors = last.findings.length;
      const rounds = task.reviewRounds.length > 1 ? `, ${task.reviewRounds.length} rounds` : '';
      return `✓ reviewed by ${last.model}${minors ? ` — ${minors} minor` : ' — clean'}${rounds}`;
    }
    case 'flagged': {
      if (!last) return null;
      const open = last.findings.filter((f) => f.severity !== 'minor').length;
      return `${last.verdict === 'blocker' ? '⛔' : '⚠'} review flagged ${open} issue(s) (${last.model})`;
    }
    case 'error':
      return '⚠ review could not run';
    case 'skipped':
      return 'nothing to review';
    default:
      return null;
  }
}

export function taskReviewKeyboard(taskId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Mark done', callback_data: encodeAction({ kind: 'task.done', id: taskId }) },
        { text: '🚀 Publish', callback_data: encodeAction({ kind: 'task.publish', id: taskId }) },
        { text: '💬 Proceed', callback_data: encodeAction({ kind: 'task.proceed', id: taskId }) },
      ],
    ],
  };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * A pending proposal in full, with its decision buttons — the notification and
 * the board's 💡 row (docs/telegram.md § The board) send the SAME message, so
 * an options proposal is never accepted from a view that did not spell the
 * options out.
 */
export function proposalMessage(fresh: Proposal): Reply {
  const what = fresh.payload.title ?? fresh.payload.rationale;
  const subtasks = fresh.payload.subtasks?.length ? ` · ${fresh.payload.subtasks.length} subtask(s)` : '';
  const lines = [
    `💡 <b>Proposal</b> (${escapeHtml(fresh.kind)}${escapeHtml(subtasks)}): ${escapeHtml(what)}`,
    escapeHtml(fresh.payload.rationale),
  ];
  // The options ARE the decision — each one spelled out in full before a
  // button can commit it (its approach lands in the task description).
  for (const [i, o] of (fresh.payload.options ?? []).entries()) {
    lines.push(
      ``,
      `<b>${i + 1}. ${escapeHtml(o.label)}</b>`,
      escapeHtml(o.approach),
      `<i>Tradeoffs:</i> ${escapeHtml(o.tradeoffs)}`,
    );
  }
  return { html: lines.join('\n'), keyboard: proposalKeyboard(fresh) };
}

/**
 * A `solution_options` proposal is a CHOICE: one button per option, and no
 * bare Accept — storage resolves an index-less accept as option 0, which
 * would silently commit an approach the owner never read (review round 3).
 */
export function proposalKeyboard(proposal: Proposal): InlineKeyboardMarkup {
  const options = proposal.payload.options ?? [];
  if (options.length > 0) {
    return {
      inline_keyboard: [
        ...options.map((o, i) => [
          {
            text: `✅ ${i + 1}. ${clip(o.label, 40)}`,
            callback_data: encodeAction({ kind: 'proposal.accept', id: proposal.id, option: i }),
          },
        ]),
        [{ text: '✖ Reject', callback_data: encodeAction({ kind: 'proposal.reject', id: proposal.id }) }],
      ],
    };
  }
  return {
    inline_keyboard: [
      [
        { text: '✅ Accept', callback_data: encodeAction({ kind: 'proposal.accept', id: proposal.id }) },
        { text: '✖ Reject', callback_data: encodeAction({ kind: 'proposal.reject', id: proposal.id }) },
      ],
    ],
  };
}

export function featureKeyboard(featureId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '✅ Approve & start', callback_data: encodeAction({ kind: 'feature.approve', id: featureId }) }],
    ],
  };
}

export class TelegramNotifier {
  private unsubscribe: (() => void) | null = null;
  private started = false;

  /** last seen status per entity — the "is this a transition" memory */
  private readonly taskStatus = new Map<string, Task['status']>();
  /** last seen review state per task — the "did the reviewer just settle" memory */
  private readonly taskReview = new Map<string, ReviewState | null>();
  private readonly featureStatus = new Map<string, Feature['status']>();

  private readonly pendingTasks = new Map<string, PendingTask>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** proposal/feature ids already scheduled — dedupes upsert re-broadcasts */
  private readonly pendingKeys = new Set<string>();

  /** true once any queued/running work was seen — arms "queue drained" */
  private hadWork = false;
  private queueTimer: ReturnType<typeof setTimeout> | null = null;

  private usageTimer: ReturnType<typeof setInterval> | null = null;
  private lastUsage: UsageSnapshot | null = null;

  constructor(private readonly deps: NotifierDeps) {}

  /** Prime the transition memory, then subscribe. Never throws. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      // Without priming, the first broadcast for a pre-existing task (a title
      // edit while it sat in review since before boot) would read as a
      // transition and ping the phone about old news.
      const [tasks, features] = await Promise.all([this.deps.storage.listTasks(), this.deps.storage.listFeatures()]);
      for (const t of tasks) {
        this.taskStatus.set(t.id, t.status);
        this.taskReview.set(t.id, t.reviewState);
      }
      for (const f of features) this.featureStatus.set(f.id, f.status);
      this.hadWork = tasks.some((t) => t.status === 'queued' || t.status === 'running');
    } catch (e) {
      console.warn('telegram: notifier could not prime its status memory:', e instanceof Error ? e.message : e);
    }
    this.unsubscribe = onEvent((e) => {
      // broadcast() swallows listener throws, but not async rejections.
      void this.handle(e).catch((err) =>
        console.warn('telegram: notification handler failed:', err instanceof Error ? err.message : err),
      );
    });
    this.usageTimer = setInterval(() => {
      void this.usageTick().catch(() => {});
    }, USAGE_POLL_MS);
    this.usageTimer.unref?.();
  }

  stop(): void {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.pendingTasks.clear();
    this.pendingKeys.clear();
    if (this.queueTimer) clearTimeout(this.queueTimer);
    this.queueTimer = null;
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = null;
  }

  // ---- routing -----------------------------------------------------------

  private async handle(e: ServerEvent): Promise<void> {
    switch (e.type) {
      case 'task.updated':
        this.onTask(e.task);
        break;
      case 'task.deleted':
        this.taskStatus.delete(e.taskId);
        this.taskReview.delete(e.taskId);
        break;
      case 'run.needs-attention':
        // The same event announces the CLEAR (Stop, or the agent moving on
        // after the prompt was answered) — only a raised flag is news.
        if (e.run.taskId && e.run.needsAttention) {
          const runId = e.run.id;
          this.mark(e.run.taskId, (p) => (p.attentionRun = runId));
        }
        break;
      case 'run.exited':
        this.scheduleQueueCheck();
        break;
      case 'proposal.created':
        this.onProposal(e.proposal);
        break;
      case 'feature.updated':
        this.onFeature(e.feature);
        break;
      case 'feature.deleted':
        this.featureStatus.delete(e.featureId);
        break;
      case 'question.updated':
        // Not coalesced and not gated by the notify flags: an agent is
        // BLOCKED on this until someone answers, and a question is never the
        // kind of chatter /mute exists for (docs/questions.md).
        await this.onQuestion(e.question);
        break;
    }
  }

  private async onQuestion(q: Question): Promise<void> {
    const task = await this.deps.storage.getTask(q.taskId);
    if (q.status === 'pending') {
      for (const m of questionMessages(q, task)) await this.deps.send(m.html, m.keyboard);
      return;
    }
    const notice = settledNotice(q, task);
    if (notice) await this.deps.send(notice);
  }

  private onTask(t: Task): void {
    const prevStatus = this.taskStatus.get(t.id);
    const prevReview = this.taskReview.get(t.id);
    this.taskStatus.set(t.id, t.status);
    this.taskReview.set(t.id, t.reviewState);
    // `waiting` is a running session between two of its own turns — work, not a pause
    if (t.status === 'queued' || t.status === 'running' || t.status === 'waiting') this.hadWork = true;
    else this.scheduleQueueCheck();
    const moved = prevStatus !== t.status;
    const reviewMoved = prevReview !== t.reviewState;
    if (!moved && !reviewMoved) return; // a content edit, not a transition
    // A requested review settling on a task parked anywhere but `review` (the
    // `review` arm below already pings that one, with its buttons). Asked
    // synchronously: the settling broadcast is emitted from inside the round,
    // while the orchestrator still holds the request.
    if (
      t.status !== 'review' &&
      !moved &&
      unsettled(prevReview) &&
      t.reviewState &&
      !unsettled(t.reviewState) &&
      this.deps.requestedReview?.(t.id)
    ) {
      this.mark(t.id, (p) => (p.reviewedElsewhere = true));
    }
    switch (t.status) {
      case 'review':
        // Announced once the reviewer has spoken — or was never going to.
        // An entry that reads pending/reviewing waits for the update that
        // settles it; a fix round's re-entry (running → review, pending
        // again) waits the same way, so the phone hears one verdict per
        // change instead of one ping per bounce. The settling update is a
        // review-state move on an unchanged status, hence the second arm.
        if (unsettled(t.reviewState)) break;
        if (moved || (reviewMoved && unsettled(prevReview))) this.mark(t.id, (p) => (p.review = true));
        break;
      case 'failed':
        if (moved) this.mark(t.id, (p) => (p.failed = true));
        break;
      case 'blocked':
        if (moved) this.mark(t.id, (p) => (p.blocked = true));
        break;
      case 'published':
        if (moved) this.mark(t.id, (p) => (p.published = true));
        break;
    }
  }

  /** Merge into the task's pending record; the first mark starts the 5s clock. */
  private mark(taskId: string, mutate: (p: PendingTask) => void): void {
    let p = this.pendingTasks.get(taskId);
    if (!p) {
      p = {};
      this.pendingTasks.set(taskId, p);
      this.after(COALESCE_MS, () => this.flushTask(taskId));
    }
    mutate(p);
  }

  private after(ms: number, fn: () => Promise<void>): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void fn().catch((err) =>
        console.warn('telegram: notification flush failed:', err instanceof Error ? err.message : err),
      );
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
  }

  // ---- flushes (re-check, then speak) ------------------------------------

  private async flushTask(taskId: string): Promise<void> {
    const p = this.pendingTasks.get(taskId);
    this.pendingTasks.delete(taskId);
    if (!p) return;
    const task = await this.deps.storage.getTask(taskId);
    if (!task) return;
    const n = this.deps.notify;
    const title = `<b>${escapeHtml(task.title)}</b> <code>${short(task.id)}</code>`;
    const lines: string[] = [];
    let keyboard: InlineKeyboardMarkup | undefined;

    // Re-checked against the row: a review that went back into a fix round
    // (running again) or is still being reviewed (the reviewer started after
    // the mark) flushes into nothing — its settling update will mark again.
    if (n.review && p.review && task.status === 'review' && !unsettled(task.reviewState)) {
      const verdict = reviewClause(task);
      lines.push(`📋 ${title} is in <b>review</b>${verdict ? ` · ${escapeHtml(verdict)}` : ''}.`);
      const last = task.reviewRounds[task.reviewRounds.length - 1];
      if (task.error) {
        // The failed-publish landing (docs/publish.md): settlePublish drops
        // the task back to review with the reason — the one line the Publish
        // button promised.
        lines.push(`⚠ ${escapeHtml(task.error)}`);
      } else if ((task.reviewState === 'passed' || task.reviewState === 'flagged') && last?.summary) {
        // The reviewer's overall reading of the work, not the worker's last
        // "fixed 1 and 2" — the human's summary (docs/design.md § Adversarial review).
        lines.push(escapeHtml(clip(last.summary, SUMMARY_CLIP)));
      } else if (task.resultSummary) {
        lines.push(escapeHtml(clip(task.resultSummary, SUMMARY_CLIP)));
      }
      keyboard = taskReviewKeyboard(task.id);
    }
    if (n.review && p.reviewedElsewhere && task.status !== 'review' && task.reviewState && !unsettled(task.reviewState)) {
      // "Review now" on a done/failed/blocked task: the verdict only — no
      // Publish/Done buttons, the status was deliberately left alone.
      const verdict = reviewClause(task);
      lines.push(
        `🔍 ${title} (${escapeHtml(task.status)}) was reviewed${verdict ? ` · ${escapeHtml(verdict)}` : ''}.`,
      );
      const last = task.reviewRounds[task.reviewRounds.length - 1];
      if ((task.reviewState === 'passed' || task.reviewState === 'flagged') && last?.summary) {
        lines.push(escapeHtml(clip(last.summary, SUMMARY_CLIP)));
      }
    }
    if (n.failed && p.failed && task.status === 'failed') {
      lines.push(`❌ ${title} <b>failed</b>${task.error ? `: ${escapeHtml(task.error)}` : '.'}`);
    }
    if (n.blocked && p.blocked && task.status === 'blocked') {
      lines.push(`⛔ ${title} is <b>blocked</b> (waiting on its subtasks).`);
    }
    if (n.published && p.published && task.status === 'published') {
      lines.push(`🚀 ${title} was <b>published</b> — committed and pushed.`);
    }
    if (n.attention && p.attentionRun && task.status === 'running') {
      // The flag is cleared the moment the agent moves on (the prompt was
      // answered in the terminal) and on Stop — only a run that STILL waits
      // is worth a ping, so the run is re-read rather than trusted.
      const run = await this.deps.storage.getRun(p.attentionRun);
      if (run && run.status === 'running' && !run.idle && run.needsAttention) {
        lines.push(`✋ ${title} <b>needs attention</b> — the agent is waiting on a prompt in its hidden terminal.`);
      }
    }
    if (lines.length) await this.deps.send(lines.join('\n'), keyboard);
  }

  private onProposal(pr: Proposal): void {
    // accept/reject re-broadcast the same event as an upsert — only a pending
    // proposal is news, and each id is announced once.
    if (pr.status !== 'pending') return;
    const key = `proposal:${pr.id}`;
    if (this.pendingKeys.has(key)) return;
    this.pendingKeys.add(key);
    this.after(COALESCE_MS, async () => {
      const fresh = await this.deps.storage.getProposal(pr.id);
      if (!fresh || fresh.status !== 'pending' || !this.deps.notify.proposal) return;
      const msg = proposalMessage(fresh);
      await this.deps.send(msg.html, msg.keyboard);
    });
  }

  private onFeature(f: Feature): void {
    const prev = this.featureStatus.get(f.id);
    this.featureStatus.set(f.id, f.status);
    if (prev === f.status) return;
    if (f.status !== 'proposed' && f.status !== 'paused') return;
    const key = `feature:${f.id}:${f.status}`;
    if (this.pendingKeys.has(key)) return;
    this.pendingKeys.add(key);
    const wanted = f.status;
    this.after(COALESCE_MS, async () => {
      this.pendingKeys.delete(key); // a later re-analysis / re-pause is news again
      const fresh = await this.deps.storage.getFeature(f.id);
      if (!fresh || fresh.status !== wanted || !this.deps.notify.feature) return;
      const title = `<b>${escapeHtml(fresh.title)}</b> <code>${short(fresh.id)}</code>`;
      if (wanted === 'proposed') {
        const plan = fresh.analysis;
        const phases = plan?.phases.length ?? 0;
        const tasks = plan?.phases.reduce((a, ph) => a + ph.tasks.filter((t) => !t.excluded).length, 0) ?? 0;
        const round = fresh.review?.rounds.at(-1);
        const verdict = round ? ` · plan review: ${escapeHtml(verdictBadge(round.verdict))} (${round.findings.length} finding(s))` : '';
        const headline =
          `🧩 Feature ${title} analyzed — <b>${phases} phase(s), ${tasks} task(s)</b>${verdict}.\n` +
          `Approve to create the tasks and start phase 1.`;
        // The plan itself is long — phases, goals, per-task exit criteria — so
        // it leaves the chat as the report document rather than as ten chunked
        // messages, and the caption carries the Russian gist. A report that
        // cannot be built must not cost the notification: fall back to the
        // message that existed before this was a document.
        let doc: ReportDocument | null = null;
        try {
          doc = await buildReport(this.deps.storage, { kind: 'feature', feature: fresh });
        } catch (e) {
          console.warn('telegram: feature report failed, sending the plain message:', String(e));
        }
        if (doc) {
          const caption = `${headline}\n\n${doc.lines.map((l) => escapeHtml(l)).join('\n')}`;
          await this.deps.sendDocument(doc, caption, featureKeyboard(fresh.id));
        } else {
          await this.deps.send(
            `${headline}\n${plan?.summary ? escapeHtml(plan.summary) : ''}`,
            featureKeyboard(fresh.id),
          );
        }
      } else {
        await this.deps.send(
          `⏸ Feature ${title} was <b>paused</b>${fresh.error ? `: ${escapeHtml(fresh.error)}` : '.'}`,
        );
      }
    });
  }

  // ---- queue drained -----------------------------------------------------

  private scheduleQueueCheck(): void {
    if (!this.hadWork || this.queueTimer) return;
    const timer = setTimeout(() => {
      this.queueTimer = null;
      void this.queueCheck().catch(() => {});
    }, COALESCE_MS);
    timer.unref?.();
    this.queueTimer = timer;
  }

  private async queueCheck(): Promise<void> {
    if (!this.hadWork) return;
    const [queued, running] = await Promise.all([
      this.deps.storage.listTasks({ status: 'queued' }),
      this.deps.storage.listTasks({ status: 'running' }),
    ]);
    if (queued.length > 0 || running.length > 0) return; // still working; re-armed by the next event
    this.hadWork = false; // settle even when muted, or unmuting replays old news
    if (!this.deps.notify.queue) return;
    const review = await this.deps.storage.listTasks({ status: 'review' });
    await this.deps.send(
      `🏁 <b>Queue drained</b> — nothing queued, nothing running.` +
        (review.length ? ` ${review.length} task(s) waiting in review.` : ''),
    );
  }

  // ---- usage windows -----------------------------------------------------

  private async usageTick(): Promise<void> {
    const snap = await usageSnapshot(this.deps.storage);
    const prev = this.lastUsage;
    this.lastUsage = snap;
    if (!prev || !this.deps.notify.usage) return;
    const lines: string[] = [];
    const windows: [string, UsageWindow, UsageWindow][] = [
      ['5h', prev.fiveHour, snap.fiveHour],
      ['weekly', prev.week, snap.week],
      ['weekly fable', prev.weekFable, snap.weekFable],
    ];
    for (const [label, was, now] of windows) {
      // Reset: the deadline we knew has passed and the account shows a new one
      // (or a pct that fell back to ~0 on the estimate path).
      if (was.resetsAt && Date.parse(was.resetsAt) <= Date.now() && now.resetsAt !== was.resetsAt) {
        lines.push(`🔄 The <b>${label}</b> usage window reset (was ${was.pct.toFixed(1)}%).`);
        continue; // a crossing computed against the old window would be noise
      }
      const crossed = USAGE_THRESHOLDS_PCT.filter((t) => was.pct < t && now.pct >= t);
      if (crossed.length) {
        const resets = now.resetsAt ? ` · resets ${escapeHtml(new Date(now.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}` : '';
        lines.push(`📈 <b>${label}</b> usage crossed ${Math.max(...crossed)}% — now ${now.pct.toFixed(1)}%${resets}.`);
      }
    }
    if (lines.length) await this.deps.send(lines.join('\n'));
  }
}
