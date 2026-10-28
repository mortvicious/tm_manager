import {
  ANOMALY_ALERT_LABELS,
  AUTOPILOT_ACTOR,
  questionWaitedMinutes,
  type AnomalyAlert,
  type Chat,
  type ChatMessage,
  type Feature,
  type Proposal,
  landingReason,
  type Approval,
  APPROVAL_LABELS,
  type Question,
  type Report,
  type CheckState,
  type ReviewState,
  type ServerEvent,
  type Task,
  type TaskStatus,
} from '@tm/shared';
import { onEvent } from '../events.ts';
import type { Storage } from '../storage/types.ts';
import { checkClause, checking, reviewClause } from '../telegram/notifications.ts';
import type { PushService } from './service.ts';

/**
 * What the Home Screen PWA is pinged about (docs/push.md § What pings). The
 * same triggers and re-checks as the Telegram notifier (telegram/
 * notifications.ts), deliberately independent of it: push works with the bot
 * off, and each device picks its kinds instead of reading `telegram.notify`.
 *
 * Task news is coalesced per task for 5s and re-read at flush, so a status
 * that has already moved on is never announced; a question goes out at once
 * because an agent is blocked on it.
 */

const COALESCE_MS = 5000;
const SUMMARY_CLIP = 600;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const unsettled = (s: ReviewState | null | undefined) => s === 'pending' || s === 'reviewing';
const taskUrl = (id: string) => `/?task=${encodeURIComponent(id)}`;

interface PendingTask {
  review?: boolean;
  reviewedElsewhere?: boolean;
  done?: boolean;
  failed?: boolean;
  blocked?: boolean;
  published?: boolean;
  started?: boolean;
  attentionRun?: string;
  /** set when the flag is the budget.runMinutes fuse's: the cap in minutes */
  attentionOvertime?: number;
}

export interface PushNotifierDeps {
  storage: Storage;
  push: PushService;
  /** Orchestrator.isRequestedReview — a "Review now" verdict on a non-review task. */
  requestedReview?: (taskId: string) => boolean;
}

export class PushNotifier {
  private readonly taskStatus = new Map<string, TaskStatus>();
  private readonly taskReview = new Map<string, ReviewState | null>();
  private readonly taskCheck = new Map<string, CheckState | null>();
  private readonly featureStatus = new Map<string, Feature['status']>();
  private readonly reportStatus = new Map<string, Report['status']>();
  /** who wrote each chat's latest user message — a phone-typed turn is answered in Telegram */
  private readonly chatAsker = new Map<string, string>();
  private readonly pendingTasks = new Map<string, PendingTask>();
  private readonly pendingKeys = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private queueTimer: ReturnType<typeof setTimeout> | null = null;
  private hadWork = false;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: PushNotifierDeps) {}

  async start(): Promise<void> {
    if (this.unsubscribe || !this.deps.push.enabled) return;
    try {
      // Primed, so the first broadcast for a task that sat in review since
      // before boot reads as an edit, not as news.
      const [tasks, features, reports] = await Promise.all([
        this.deps.storage.listTasks(),
        this.deps.storage.listFeatures(),
        this.deps.storage.listReports(),
      ]);
      for (const t of tasks) {
        this.taskStatus.set(t.id, t.status);
        this.taskReview.set(t.id, t.reviewState);
        this.taskCheck.set(t.id, t.checkState);
      }
      for (const f of features) this.featureStatus.set(f.id, f.status);
      for (const r of reports) this.reportStatus.set(r.id, r.status);
      this.hadWork = tasks.some((t) => isWork(t.status));
    } catch (e) {
      console.warn('push: notifier could not prime its status memory:', e instanceof Error ? e.message : e);
    }
    this.unsubscribe = onEvent((e) => {
      void this.handle(e).catch((err) =>
        console.warn('push: notification handler failed:', err instanceof Error ? err.message : err),
      );
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.queueTimer) clearTimeout(this.queueTimer);
    this.queueTimer = null;
  }

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
        // the same event announces the CLEAR — only a raised flag is news
        if (e.run.taskId && e.run.needsAttention) {
          const runId = e.run.id;
          const overtime = e.reason === 'run-minutes' ? e.minutes : undefined;
          this.mark(e.run.taskId, (p) => {
            p.attentionRun = runId;
            p.attentionOvertime = overtime;
          });
        }
        break;
      case 'anomaly.raised':
        await this.onAnomaly(e.alert);
        break;
      case 'run.exited':
        this.scheduleQueueCheck();
        break;
      case 'question.updated':
        await this.onQuestion(e.question);
        break;
      case 'approval.updated':
        await this.onApproval(e.approval);
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
      case 'chat.message':
        await this.onChatMessage(e.message);
        break;
      case 'chat.deleted':
        this.chatAsker.delete(e.chatId);
        break;
      case 'report.updated':
        this.onReport(e.report);
        break;
      case 'report.deleted':
        this.reportStatus.delete(e.reportId);
        break;
    }
  }

  // ---- tasks ----------------------------------------------------------------

  private onTask(t: Task): void {
    const prevStatus = this.taskStatus.get(t.id);
    const prevReview = this.taskReview.get(t.id);
    const prevCheck = this.taskCheck.get(t.id);
    this.taskStatus.set(t.id, t.status);
    this.taskReview.set(t.id, t.reviewState);
    this.taskCheck.set(t.id, t.checkState);
    if (isWork(t.status)) this.hadWork = true;
    else this.scheduleQueueCheck();
    const moved = prevStatus !== t.status;
    const reviewMoved = prevReview !== t.reviewState;
    const checkMoved = prevCheck !== t.checkState;
    if (!moved && !reviewMoved && !checkMoved) return;
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
        // one verdict per change: wait for the review to settle, then speak
        // ...and for the repo checks before it (docs/checks.md)
        // A turn Pause all suspended is not ready for anyone (docs/pause.md).
        if (unsettled(t.reviewState) || checking(t.checkState) || t.pausedTurn) break;
        if (moved || (reviewMoved && unsettled(prevReview)) || (checkMoved && checking(prevCheck))) {
          this.mark(t.id, (p) => (p.review = true));
        }
        break;
      case 'done':
        // Only a task that got to done without a human: an on-green landing
        // (docs/design.md § Landing tiers, `autoLandedAt`) or an agent closing
        // its own task. A human pressing Mark done does not need telling.
        if (moved && (prevStatus === 'running' || prevStatus === 'waiting' || !!t.autoLandedAt)) {
          this.mark(t.id, (p) => (p.done = true));
        }
        break;
      case 'running':
        // picked up from the queue — not a fix round, a wake from waiting or a resume
        if (moved && prevStatus === 'queued') this.mark(t.id, (p) => (p.started = true));
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
      void fn().catch((err) => console.warn('push: flush failed:', err instanceof Error ? err.message : err));
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
  }

  /**
   * Re-read from the row, then speak. Every status ping shares the task's tag
   * (`task-<id>`), so the lock screen keeps the task's LATEST state instead of
   * a stack of them; the statuses are mutually exclusive on one row anyway.
   * Attention has its own tag: it is about the live run, not the status.
   */
  private async flushTask(taskId: string): Promise<void> {
    const p = this.pendingTasks.get(taskId);
    this.pendingTasks.delete(taskId);
    if (!p) return;
    const task = await this.deps.storage.getTask(taskId);
    if (!task) return;
    const push = this.deps.push;
    const tag = `task-${task.id}`;
    const url = taskUrl(task.id);
    const send = (kind: Parameters<PushService['deliver']>[0], title: string, body: string) =>
      push.deliver(kind, { title, body, tag, url });
    const last = task.reviewRounds[task.reviewRounds.length - 1];
    const reviewerSummary = (task.reviewState === 'passed' || task.reviewState === 'flagged') && last?.summary ? last.summary : null;

    if (p.attentionRun && task.status === 'running') {
      const run = await this.deps.storage.getRun(p.attentionRun);
      if (run && run.status === 'running' && !run.idle && run.needsAttention) {
        const overtime = p.attentionOvertime;
        await push.deliver(
          'attention',
          overtime
            ? {
                title: `⏱ Over ${overtime} min · ${task.title}`,
                body: 'This turn has run past budget.runMinutes. It is still working — nothing was stopped.',
                tag: `attention-${task.id}`,
                url,
              }
            : {
                title: `✋ Needs attention · ${task.title}`,
                body: 'The agent is waiting on a prompt in its hidden terminal.',
                tag: `attention-${task.id}`,
                url,
              },
          { urgency: 'high' },
        );
      }
    }
    if (p.review && task.status === 'review' && !unsettled(task.reviewState) && !checking(task.checkState) && !task.pausedTurn) {
      const verdict = [checkClause(task), reviewClause(task)].filter(Boolean).join(' · ') || null;
      const body = [verdict, task.error ? `⚠ ${task.error}` : (reviewerSummary ?? task.resultSummary)]
        .filter(Boolean)
        .join('\n');
      await send('review', `📋 In review · ${task.title}`, clip(body || 'Ready for your review.', SUMMARY_CLIP));
    }
    if (p.reviewedElsewhere && task.status !== 'review' && task.reviewState && !unsettled(task.reviewState)) {
      const verdict = reviewClause(task);
      await send(
        'review',
        `🔍 Reviewed (${task.status}) · ${task.title}`,
        clip([verdict, reviewerSummary].filter(Boolean).join('\n') || 'Review finished.', SUMMARY_CLIP),
      );
    }
    if (p.done && task.status === 'done') {
      if (task.autoLandedAt) {
        const body = [`auto-landed: ${landingReason(task) ?? 'landed on its own'}`, reviewerSummary ?? task.resultSummary]
          .filter(Boolean)
          .join('\n');
        await send('done', `✅ Auto-landed · ${task.title}`, clip(body, SUMMARY_CLIP));
      } else {
        await send('done', `✅ Done · ${task.title}`, clip(task.resultSummary ?? 'Finished.', SUMMARY_CLIP));
      }
    }
    if (p.failed && task.status === 'failed') {
      await send('failed', `❌ Failed · ${task.title}`, clip(task.error ?? 'The task failed.', SUMMARY_CLIP));
    }
    if (p.blocked && task.status === 'blocked') {
      await send('blocked', `⛔ Blocked · ${task.title}`, 'Waiting on its subtasks.');
    }
    if (p.published && task.status === 'published') {
      await send('published', `🚀 Published · ${task.title}`, 'Committed and pushed.');
    }
    if (p.started && task.status === 'running') {
      await send('started', `▶ Started · ${task.title}`, 'An agent picked it up.');
    }
  }

  // ---- questions --------------------------------------------------------------

  private async onQuestion(q: Question): Promise<void> {
    // Only the ask is news. Answered/expired are not pushed: iOS must show a
    // notification for every push it receives, so a "never mind" would be a
    // second banner; the SPA closes the stale one when it next opens instead.
    // The one exception is an AUTOPILOT pick (docs/questions.md § Autopilot):
    // nobody answered, so what the server chose for them is news. Its own tag,
    // so the SPA's stale-question sweep (`question-*`) leaves it up.
    if (q.status === 'answered' && q.answeredBy === AUTOPILOT_ACTOR) {
      const task = await this.deps.storage.getTask(q.taskId);
      const picks = q.questions.map((item) => `• ${q.answers?.[item.question] ?? '—'}`).join('\n');
      await this.deps.push.deliver('question', {
        title: `🤖 Auto-picked · ${task?.title ?? `Task ${q.taskId.slice(0, 8)}`}`,
        body: clip(`Nobody answered in ${questionWaitedMinutes(q) ?? '?'} min, so the Recommended option was taken:\n${picks}`, SUMMARY_CLIP),
        tag: `autopick-${q.id}`,
        url: taskUrl(q.taskId),
      });
      return;
    }
    if (q.status !== 'pending') return;
    const task = await this.deps.storage.getTask(q.taskId);
    const first = q.questions[0];
    if (!first) return;
    const more = q.questions.length > 1 ? `\n(+${q.questions.length - 1} more question${q.questions.length > 2 ? 's' : ''})` : '';
    const options = first.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
    await this.deps.push.deliver(
      'question',
      {
        title: `❓ ${task?.title ?? `Task ${q.taskId.slice(0, 8)}`} asks you`,
        body: clip(`${first.question}${options ? `\n${options}` : ''}${more}`, SUMMARY_CLIP),
        tag: `question-${q.id}`,
        // the question modal pops on any page; the task panel gives it context
        url: taskUrl(q.taskId),
      },
      // an agent is blocked until someone answers; a question outlives a day
      // only as an expired row, so a day of TTL is enough
      { urgency: 'high' },
    );
  }

  // ---- approvals (docs/approvals.md § Web Push) -----------------------------

  private approvalsSent = new Set<string>();

  private async onApproval(a: Approval): Promise<void> {
    // Only the request is news, like a question: the outcome shows in the app
    // (and a banner per outcome would be a second banner for one decision).
    // A failed run is the exception — something the human approved did not happen.
    if (a.status === 'failed') {
      await this.deps.push.deliver('approval', {
        title: `⚠ ${APPROVAL_LABELS[a.action]} failed`,
        body: clip(a.result ?? a.summary, SUMMARY_CLIP),
        tag: `approvalfail-${a.id}`,
        url: '/inbox',
      });
      return;
    }
    if (a.status !== 'pending' || this.approvalsSent.has(a.id)) return;
    this.approvalsSent.add(a.id);
    // a pre-approved request is decided in the same breath — no banner for it
    await new Promise((r) => setTimeout(r, 1500));
    const fresh = await this.deps.storage.getApproval(a.id);
    if (!fresh || fresh.status !== 'pending') return;
    const task = fresh.taskId ? await this.deps.storage.getTask(fresh.taskId) : null;
    await this.deps.push.deliver(
      'approval',
      {
        title: `🔐 Approve: ${APPROVAL_LABELS[fresh.action]}${task ? ` · ${task.title}` : ''}`,
        body: clip(`${fresh.summary}\n— ${fresh.reason}`, SUMMARY_CLIP),
        tag: `approval-${fresh.id}`,
        url: '/inbox',
      },
      { urgency: 'high' },
    );
  }

  // ---- anomalies (already coalesced by AnomalyAlerts: one per key) ----------

  private async onAnomaly(a: AnomalyAlert): Promise<void> {
    const task = a.taskId ? await this.deps.storage.getTask(a.taskId) : null;
    await this.deps.push.deliver('anomaly', {
      title: `${ANOMALY_ALERT_LABELS[a.type].icon} ${ANOMALY_ALERT_LABELS[a.type].label}${task ? ` · ${task.title}` : ''}`,
      body: clip(a.message, SUMMARY_CLIP),
      tag: `anomaly-${a.key}`,
      url: task ? taskUrl(task.id) : '/',
    });
  }

  // ---- proposals, features, chats, reports -----------------------------------

  private onProposal(pr: Proposal): void {
    if (pr.status !== 'pending') return;
    const key = `proposal:${pr.id}`;
    if (this.pendingKeys.has(key)) return;
    this.pendingKeys.add(key);
    this.after(COALESCE_MS, async () => {
      const fresh = await this.deps.storage.getProposal(pr.id);
      if (!fresh || fresh.status !== 'pending') return;
      const what = fresh.payload.title ?? fresh.payload.rationale ?? fresh.kind;
      await this.deps.push.deliver('proposal', {
        title: `💡 Proposal · ${fresh.kind.replace(/_/g, ' ')}`,
        body: clip(`${what}${fresh.payload.rationale && fresh.payload.title ? `\n${fresh.payload.rationale}` : ''}`, SUMMARY_CLIP),
        tag: `proposal-${fresh.id}`,
        url: fresh.taskId ? taskUrl(fresh.taskId) : '/',
      });
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
      if (!fresh || fresh.status !== wanted) return;
      const url = `/features/${encodeURIComponent(fresh.id)}`;
      if (wanted === 'proposed') {
        const plan = fresh.analysis;
        const phases = plan?.phases.length ?? 0;
        const tasks = plan?.phases.reduce((a, ph) => a + ph.tasks.filter((t) => !t.excluded).length, 0) ?? 0;
        await this.deps.push.deliver('feature', {
          title: `🧩 Plan ready · ${fresh.title}`,
          body: clip(`${phases} phase(s), ${tasks} task(s). Approve to start phase 1.${plan?.summary ? `\n${plan.summary}` : ''}`, SUMMARY_CLIP),
          tag: `feature-${fresh.id}`,
          url,
        });
      } else {
        await this.deps.push.deliver('feature', {
          title: `⏸ Feature paused · ${fresh.title}`,
          body: clip(fresh.error ?? 'Paused.', SUMMARY_CLIP),
          tag: `feature-${fresh.id}`,
          url,
        });
      }
    });
  }

  private async onChatMessage(m: ChatMessage): Promise<void> {
    if (m.role === 'user') {
      this.chatAsker.set(m.chatId, m.actor);
      return;
    }
    // A turn typed on the phone is answered in Telegram already; pinging the
    // PWA too would be the same reply twice. Unknown asker (a turn started
    // before this boot) counts as the browser.
    if (this.chatAsker.get(m.chatId) === 'telegram') return;
    const chat: Chat | null = await this.deps.storage.getChat(m.chatId);
    await this.deps.push.deliver('chat', {
      title: `${m.error ? '⚠' : '💬'} ${chat?.title ?? 'Chat'}`,
      body: clip(m.error ?? (m.text || '(empty reply)'), SUMMARY_CLIP),
      tag: `chat-${m.chatId}`,
      url: `/chat/${encodeURIComponent(m.chatId)}`,
    });
  }

  private onReport(r: Report): void {
    const prev = this.reportStatus.get(r.id);
    this.reportStatus.set(r.id, r.status);
    if (prev === r.status || (r.status !== 'ready' && r.status !== 'failed')) return;
    void this.deps.push.deliver('report', {
      title: r.status === 'ready' ? `📄 Report ready · ${r.title}` : `⚠ Report failed · ${r.title}`,
      body: clip(r.status === 'ready' ? `${r.fromDate} → ${r.toDate}` : (r.error ?? 'The report could not be written.'), SUMMARY_CLIP),
      tag: `report-${r.id}`,
      url: '/reports',
    });
  }

  // ---- queue drained ------------------------------------------------------------

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
    const [queued, running, waiting] = await Promise.all([
      this.deps.storage.listTasks({ status: 'queued' }),
      this.deps.storage.listTasks({ status: 'running' }),
      this.deps.storage.listTasks({ status: 'waiting' }),
    ]);
    if (queued.length || running.length || waiting.length) return;
    this.hadWork = false;
    const review = await this.deps.storage.listTasks({ status: 'review' });
    await this.deps.push.deliver(
      'queue',
      {
        title: '🏁 Queue drained',
        body: `Nothing queued, nothing running.${review.length ? ` ${review.length} task(s) waiting in review.` : ''}`,
        tag: 'queue-drained',
        url: '/',
      },
      { ttlSec: 3600 },
    );
  }
}

function isWork(s: TaskStatus): boolean {
  return s === 'queued' || s === 'running' || s === 'waiting';
}
