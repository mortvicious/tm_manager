import type { AuditEvent, Feature, Proposal, ServerEvent, Task, UsageSnapshot, UsageWindow } from '@tm/shared';
import { usageSnapshot } from '../claude/usage.ts';
import type { TelegramNotifyConfig } from '../config.ts';
import { onEvent } from '../events.ts';
import type { Storage } from '../storage/types.ts';
import { encodeAction } from './actions.ts';
import { escapeHtml } from './api.ts';
import type { InlineKeyboardMarkup } from './types.ts';

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
//   That re-check is also what keeps the fix loop quiet: `run.reviewed`
//   followed by a follow-up back into `running` flushes into nothing.
// - **The bus is live-only.** Events fired while the bot is stopped are not
//   replayed — the "back online" message plus /status are the catch-up story.
// - **Config is read at flush time**, so /mute takes effect for messages
//   already in the 5s window too.

const COALESCE_MS = 5_000;
const USAGE_POLL_MS = 60_000;
/** Ascending; a crossing notifies once per window per threshold. */
const USAGE_THRESHOLDS_PCT = [50, 80, 95];
/**
 * While an adversarial review round is in flight the "in review" ping is
 * DEFERRED, not dropped: re-checked every minute until the verdict event
 * arrives (the normal end) or the cap says the round is not going to produce
 * one — then the bare ping goes out late rather than never.
 */
const REVIEW_RETRY_MS = 60_000;
const MAX_REVIEW_RETRIES = 30;

interface PendingTask {
  review?: boolean;
  /** from the run.reviewed audit event — verdict + findings count */
  reviewed?: { verdict: string; findings: number };
  failed?: boolean;
  blocked?: boolean;
  published?: boolean;
  attention?: boolean;
  /** deferrals already spent waiting out a pending review round */
  retries?: number;
}

export interface NotifierDeps {
  storage: Storage;
  notify: TelegramNotifyConfig;
  /** live truth from the orchestrator — is a review round in flight? */
  isReviewPending(taskId: string): boolean;
  send(html: string, keyboard?: InlineKeyboardMarkup): Promise<void>;
}

const short = (id: string) => id.slice(0, 8);

function verdictBadge(verdict: string): string {
  return verdict === 'clean' ? '✓ clean' : verdict === 'blocker' ? '⛔ blocker' : `⚠ ${verdict}`;
}

export function taskReviewKeyboard(taskId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Mark done', callback_data: encodeAction({ kind: 'task.done', id: taskId }) },
        { text: '🚀 Publish', callback_data: encodeAction({ kind: 'task.publish', id: taskId }) },
        { text: '▶ Proceed', callback_data: encodeAction({ kind: 'task.proceed', id: taskId }) },
      ],
    ],
  };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

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
      for (const t of tasks) this.taskStatus.set(t.id, t.status);
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
        break;
      case 'run.needs-attention':
        if (e.run.taskId) this.mark(e.run.taskId, (p) => (p.attention = true));
        break;
      case 'run.exited':
        this.scheduleQueueCheck();
        break;
      case 'event.appended':
        this.onAudit(e.event);
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
    }
  }

  private onTask(t: Task): void {
    const prev = this.taskStatus.get(t.id);
    this.taskStatus.set(t.id, t.status);
    if (t.status === 'queued' || t.status === 'running') this.hadWork = true;
    else this.scheduleQueueCheck();
    if (prev === t.status) return; // a content edit, not a transition
    switch (t.status) {
      case 'review':
        this.mark(t.id, (p) => (p.review = true));
        break;
      case 'failed':
        this.mark(t.id, (p) => (p.failed = true));
        break;
      case 'blocked':
        this.mark(t.id, (p) => (p.blocked = true));
        break;
      case 'published':
        this.mark(t.id, (p) => (p.published = true));
        break;
    }
  }

  private onAudit(ev: AuditEvent): void {
    // The verdict + findings count live in the run.reviewed audit row, not on
    // the task; the review transition itself happens minutes earlier (the
    // adversarial run is async off the Stop hook).
    if (ev.kind !== 'run.reviewed' || !ev.taskId) return;
    const verdict = typeof ev.data?.verdict === 'string' ? ev.data.verdict : null;
    const findings = typeof ev.data?.findings === 'number' ? ev.data.findings : 0;
    if (!verdict) return;
    this.mark(
      ev.taskId,
      (p) => {
        p.review = true;
        p.reviewed = { verdict, findings };
      },
      // The record may be parked on a minutes-long review-retry timer; the
      // verdict must not wait that timer out. The extra flush is harmless if
      // both fire — a flush on a taken record is a no-op.
      { prompt: true },
    );
  }

  /** Merge into the task's pending record; the first mark starts the 5s clock. */
  private mark(taskId: string, mutate: (p: PendingTask) => void, opts?: { prompt?: boolean }): void {
    let p = this.pendingTasks.get(taskId);
    if (!p) {
      p = {};
      this.pendingTasks.set(taskId, p);
      this.after(COALESCE_MS, () => this.flushTask(taskId));
    } else if (opts?.prompt || p.retries) {
      // `p.retries`: the record is parked on a minutes-long review-retry
      // timer, and whatever just happened (a verdict, a new transition) must
      // not wait it out. A duplicate timer is harmless — the first flush
      // takes the record, the rest find nothing.
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

    if (n.review && (p.review || p.reviewed) && task.status === 'review') {
      // A bare entry ping while the adversarial round is still running would
      // arrive verdict-less minutes before the verdict — and every fix-round
      // re-entry would ping again. Defer until the round settles: the verdict
      // arrives as run.reviewed (p.reviewed, prompt-flushed), a fix round
      // moves the task back to running (the status re-check above goes
      // silent), and only a round that produces NO verdict event at all runs
      // the retries out and sends the bare ping late rather than never.
      if (!p.reviewed && this.deps.isReviewPending(taskId) && (p.retries ?? 0) < MAX_REVIEW_RETRIES) {
        p.retries = (p.retries ?? 0) + 1;
        this.pendingTasks.set(taskId, p);
        this.after(REVIEW_RETRY_MS, () => this.flushTask(taskId));
        return;
      }
      const verdict = p.reviewed ? `${verdictBadge(p.reviewed.verdict)} — ${p.reviewed.findings} finding(s)` : null;
      // No fallback to the reviewSummary badge here: on a re-entry (a failed
      // publish landing, a re-run) it is the PREVIOUS round's verdict, and a
      // stale "✓ clean" next to live Publish buttons invites shipping on it.
      lines.push(`📋 ${title} is in <b>review</b>${verdict ? ` · ${escapeHtml(verdict)}` : ''}.`);
      if (task.error) {
        // The failed-publish landing (docs/publish.md): settlePublish drops
        // the task back to review with the reason — the one line the Publish
        // button promised.
        lines.push(`⚠ ${escapeHtml(task.error)}`);
      } else if (task.resultSummary) {
        lines.push(escapeHtml(task.resultSummary));
      }
      keyboard = taskReviewKeyboard(task.id);
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
    if (n.attention && p.attention && task.status === 'running') {
      lines.push(`✋ ${title} <b>needs attention</b> — the agent is waiting on a prompt in its hidden terminal.`);
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
      await this.deps.send(lines.join('\n'), proposalKeyboard(fresh));
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
        await this.deps.send(
          `🧩 Feature ${title} analyzed — <b>${phases} phase(s), ${tasks} task(s)</b>${verdict}.\n` +
            (plan?.summary ? escapeHtml(plan.summary) : '') +
            `\nApprove to create the tasks and start phase 1.`,
          featureKeyboard(fresh.id),
        );
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
