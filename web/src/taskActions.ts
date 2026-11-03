import { createElement, type ReactNode } from 'react';
import { CHECK_BUSY_STATES, REVIEW_BUSY_STATES, REVIEW_NOW_FROM, publishCaution, publishGateReason, type Run, type Task } from '@tm/shared';
import { api } from './api.ts';
import { IconAnalyze, IconPlay, IconPublish, IconQueue, IconStop, IconTerminal } from './components/Icons.tsx';
import { ACTION_TITLE, runTaskAction, type TaskActionId } from './pending.ts';
import { confirmMarkPublished, confirmPublish, markPublishedLabel, markPublishedOffered, publishIsPrimary } from './publish.ts';

/**
 * Which task actions are offered, when, with which label, disabled reason and
 * confirm — the ONE offer rule (docs/design.md § Task panel tabs). The task
 * panel draws it (desktop row, phone bar + ⋯ sheet); the ⌘K palette reads the
 * same list, so the two surfaces cannot drift. Rendering, the two-press arm
 * (src/arm.ts) and the phone bar's pick stay with each surface.
 */

/**
 * One button of the panel's action set. Desktop draws the whole list as one
 * wrapping row, in this order. Phones (docs/mobile.md § Task panel) pin up to
 * three of them in a bar (`MOBILE_PRIMARY`) and put the rest in a ⋯ sheet, with
 * the `destructive` ones apart at the bottom. Both read this one list, so the
 * conditions for offering an action cannot drift between the two.
 */
export interface TaskAction {
  id: string;
  label: string;
  /** the bar's shorter wording, where the full label would not fit */
  short?: string;
  icon?: ReactNode;
  /** desktop button class after `btn` (`primary`, `danger`, `queue-btn`) */
  cls?: string;
  title?: string;
  disabled?: boolean;
  /** kills or discards something: bottom of the phone sheet, in red */
  destructive?: boolean;
  /**
   * Two-press arm (src/arm.ts): the first press only swaps the label for this
   * question, a second press within 4 s runs `onClick`. For what kills a run.
   */
  confirm?: string;
  onClick: () => void;
  /** the task action it runs — while one is in flight (src/pending.ts) the
   *  pressed button says so ("Publishing…") and the others wait */
  act?: TaskActionId;
}

/** Same words as the board row (TaskRow), for the same server refusal. */
export const LIVE_MSG = 'Previous session is still live — open its terminal or kill it first';

/** What the builder reads beyond the task row, and what the surface owns. */
export interface TaskActionContext {
  /** the task's worker runs, newest first (liveSession / latestRun) */
  taskRuns: Run[];
  /** `OrchestratorStatus.shellWaits`: parks held by background shells alone */
  shellWaits: string[] | undefined;
  /** the session Publish would reopen, if any (title wording only) */
  resumeSession: string | null;
  /** phone wording for the arm question ("tap again" vs "click again") */
  mobile: boolean;
  refresh: () => Promise<unknown>;
  toastError: (e: unknown, title?: string | null) => void;
  onOpenTerminal: (runId: string) => void;
  analyze: () => void;
  delete: () => void;
}

/** The task's action set, in display order (the desktop row's; the phone bar picks from it by id). */
export function buildTaskActions(task: Task, ctx: TaskActionContext): TaskAction[] {
  const { taskRuns, shellWaits, resumeSession, mobile, refresh, toastError, onOpenTerminal, analyze } = ctx;
  const del = ctx.delete;
  const latestRun = taskRuns[0];

  // Every task action: in flight on every surface until the server answers,
  // then a confirmation toast, or the refusal (docs/mobile.md § Action feedback)
  const track = async (a: TaskActionId, call: () => Promise<unknown>, then = true) => {
    try {
      const r = await runTaskAction(task, a, call);
      if (r !== undefined && then) await refresh();
    } catch (e) {
      toastError(e, ACTION_TITLE[a]);
    }
  };
  const action = (a: Parameters<typeof api.taskAction>[1]) => track(a, () => api.taskAction(task.id, a));

  // the repo checks run inside the same round lock (docs/checks.md), so "Review now" waits for them too
  const reviewBusy =
    (task.reviewState !== null && REVIEW_BUSY_STATES.includes(task.reviewState)) ||
    (task.status === 'review' && task.checkState !== null && CHECK_BUSY_STATES.includes(task.checkState));
  const publishGate = publishGateReason(task);
  const actions: TaskAction[] = [];
  const again = mobile ? 'tap again' : 'click again';
  const running = task.status === 'running' || task.status === 'waiting';
  // the client mirror of the server's hasLiveSession() guard (see TaskRow):
  // enqueue, add-to-queue, release and run-now are refused while the PTY is up
  const liveSession = taskRuns.some((r) => r.status === 'running');
  // A failed/cancelled task speaks one vocabulary (docs/inbox.md § Retry or
  // Resume): Retry / Retry now start a FRESH agent, Resume (the follow-up box)
  // reopens the same session. The server move is the same as Enqueue/Run now.
  const retryable = task.status === 'failed' || task.status === 'cancelled';
  if (['draft', 'review', 'blocked', 'failed', 'cancelled'].includes(task.status)) {
    actions.push({
      id: 'enqueue',
      label: retryable ? 'Retry' : 'Enqueue',
      disabled: liveSession,
      title: liveSession
        ? LIVE_MSG
        : retryable
          ? 'A fresh agent through the queue, told what the last attempt hit'
          : 'Mark it ready — the orchestrator claims it when a slot frees up',
      onClick: () => action(retryable ? 'retry' : 'enqueue'),
    });
  }
  // custom queue (docs/queue.md): runs even with the global queue stopped, one task per repo
  if (['draft', 'review', 'failed', 'cancelled'].includes(task.status) || (task.status === 'queued' && !task.customQueueAt)) {
    actions.push({
      id: 'queue',
      label: 'Add to queue',
      icon: createElement(IconQueue),
      cls: 'queue-btn',
      disabled: liveSession,
      title: liveSession ? LIVE_MSG : 'Add to the queue — runs one task per repo, independent of the global queue',
      onClick: () => action('queue'),
    });
  }
  if (task.status === 'queued' && task.customQueueAt) {
    // a WAITING member leaves the custom queue cancelled (docs/queue.md), so it is named for that
    actions.push({
      id: 'unqueue',
      label: 'Cancel task',
      cls: 'danger',
      destructive: true,
      title: 'Take it out of the one-at-a-time queue and cancel it (asks for a second press)',
      confirm: `Cancel task? ${again}`,
      onClick: () => action('unqueue'),
    });
  }
  if (['draft', 'queued', 'review', 'failed', 'cancelled'].includes(task.status)) {
    actions.push({
      id: 'run-now',
      label: retryable ? 'Retry now' : 'Run now',
      icon: createElement(IconPlay),
      cls: 'primary',
      disabled: liveSession,
      title: liveSession
        ? LIVE_MSG
        : retryable
          ? 'A fresh agent at once, ahead of the queue, told what the last attempt hit'
          : 'Spawn an agent at once, ahead of the queue',
      onClick: () => action('run-now'),
    });
  }
  if (task.status === 'queued' && task.queueHeldAt) {
    actions.push({
      id: 'release',
      label: 'Release',
      cls: 'primary',
      disabled: liveSession,
      title: liveSession ? LIVE_MSG : 'Let the queue take this task again, from the place it kept',
      onClick: () => action('release'),
    });
  }
  // Stop waiting (docs/design.md § Waiting): offered only while background
  // shells alone hold the park — a subagent's park ends on its own.
  if (task.status === 'waiting' && shellWaits?.includes(task.id)) {
    actions.push({
      id: 'stop-waiting',
      label: 'Stop waiting',
      icon: createElement(IconStop),
      cls: 'primary',
      title:
        'Only background shells keep this task waiting. Land the turn now — review and queue go on as if the shells had exited — and kill those shells. Asks for a second press.',
      confirm: `Stop waiting? ${again}`,
      onClick: () => action('stop-waiting'),
    });
  }
  if (running) {
    actions.push({
      id: 'undo',
      label: 'Undo start',
      title:
        'Stop this run and put the task back where it was before it started (a queued task keeps its place, held until you Release it). Nothing in the working tree is reverted. Asks for a second press.',
      confirm: `Undo start? ${again}`,
      onClick: () => action('undo'),
    });
    actions.push({
      id: 'cancel',
      label: 'Cancel',
      cls: 'danger',
      destructive: true,
      title: 'Kill the run and cancel the task (asks for a second press)',
      confirm: `Cancel? ${again}`,
      onClick: () => action('cancel'),
    });
  }
  // out of the GLOBAL queue the server move is a plain cancel, and it says so
  if (task.status === 'queued' && !task.customQueueAt) {
    actions.push({
      id: 'dequeue',
      label: 'Cancel task',
      cls: 'danger',
      destructive: true,
      title: 'Cancel the task — it leaves the global queue (asks for a second press)',
      confirm: `Cancel task? ${again}`,
      onClick: () => action('cancel'),
    });
  }
  // Observed publish (docs/publish.md § Observed publish): the agent already
  // pushed it, so the publish slot records that — no turn, nothing pushed.
  if (markPublishedOffered(task)) {
    const caution = publishCaution(task);
    actions.push({
      id: 'mark-published',
      label: caution && task.status === 'review' ? 'Mark published anyway' : 'Mark published',
      short: 'Published',
      icon: createElement(IconPublish),
      cls: task.status === 'review' && publishIsPrimary(task) ? 'primary' : undefined,
      title: `${caution && task.status === 'review' ? `${caution} — asks first. ` : ''}${markPublishedLabel(task)}`,
      onClick: () => {
        if (task.status !== 'review' || confirmMarkPublished(task)) void action('mark-published');
      },
    });
  }
  if (task.status === 'review' && !markPublishedOffered(task)) {
    const caution = publishCaution(task);
    actions.push({
      id: 'publish',
      label: caution ? 'Publish anyway' : 'Publish',
      short: 'Publish',
      icon: createElement(IconPublish),
      cls: publishIsPrimary(task) ? 'primary' : undefined,
      disabled: !!publishGate,
      title: publishGate
        ? `Publish waits: ${publishGate}`
        : `${caution ? `${caution} — asks first. ` : ''}${
            resumeSession
              ? `Commit and push this work in session ${resumeSession.slice(0, 8)} — the same terminal the agent worked in`
              : 'Commit and push this work (no agent session left to reopen, so the server does it directly)'
          }`,
      onClick: () => {
        if (confirmPublish(task)) void action('publish');
      },
    });
  }
  if (task.status === 'review') {
    actions.push({ id: 'complete', label: 'Mark done', title: 'Close the task without publishing', onClick: () => action('complete') });
  }
  // "Review now" (docs/design.md § Adversarial review): runs the reviewer itself, fresh verdict
  if (task.repoId && REVIEW_NOW_FROM.includes(task.status)) {
    actions.push({
      id: 'review-now',
      label: 'Review now',
      icon: createElement(IconAnalyze),
      disabled: reviewBusy,
      title: reviewBusy
        ? 'A review round is already queued, running or being fixed'
        : task.status === 'review'
          ? 'Run the adversarial reviewer over the current diff now — blocker/major findings go back to the live session to fix'
          : 'Run the adversarial reviewer over the current diff now — the verdict is recorded, the status stays',
      // No refresh(): the round can settle (empty/unchanged diff) within
      // ms, and a full list read in flight across that write lands after
      // the WS row and pins a stale `pending`. The `task.updated`
      // broadcasts carry both steps in order.
      onClick: () => void track('review', () => api.reviewNow(task.id), false),
    });
  }
  if (['review', 'done', 'failed'].includes(task.status)) {
    actions.push({
      id: 'apply-review',
      label: 'Apply review fixes',
      icon: createElement(IconAnalyze),
      title: task.reviewSummary
        ? 'Send the review findings back to a worker to fix'
        : 'Adversarially review this task and fix what it finds',
      onClick: () => void track('apply-review', () => api.applyReview(task.id)),
    });
  }
  if (task.status === 'blocked') {
    actions.push({ id: 'unblock', label: 'Unblock', title: 'Stop waiting on its split children and let it run', onClick: () => action('unblock') });
  }
  if (latestRun) {
    actions.push({
      id: 'terminal',
      label: 'Open terminal',
      short: 'Terminal',
      icon: createElement(IconTerminal),
      title: `Attach to session ${latestRun.id.slice(0, 8)}${latestRun.status === 'running' ? '' : ' (ended)'}`,
      onClick: () => onOpenTerminal(latestRun.id),
    });
  }
  if (task.status !== 'running' && latestRun?.status === 'running') {
    actions.push({
      id: 'stop-agent',
      label: 'Stop agent',
      cls: 'danger',
      destructive: true,
      title: "Close the agent's terminal session (task status is unchanged; asks for a second press)",
      confirm: `Stop agent? ${again}`,
      onClick: () => void track('stop-agent', () => api.stopAgent(task.id)),
    });
  }
  // Hidden tasks (docs/design.md § Hidden tasks): a working task stays visible.
  if (task.hiddenAt) {
    actions.push({ id: 'unhide', label: 'Unhide', title: 'Back to its usual section on the board', onClick: () => action('unhide') });
  } else if (task.status !== 'running' && task.status !== 'waiting') {
    actions.push({ id: 'hide', label: 'Hide', title: 'Move into the dimmed Hidden section — out of Drafts and the rest of the board until you unhide it or its status changes', onClick: () => action('hide') });
  }
  actions.push({ id: 'analyze', label: 'Analyze', icon: createElement(IconAnalyze), title: 'A read-only session reads the repo and proposes how to split or solve this task', onClick: analyze });
  actions.push({ id: 'delete', label: 'Delete', cls: 'danger', destructive: true, title: 'Delete the task (asks first)', onClick: del });

  // which task action each button runs, for the in-flight state
  const ACT_OF: Record<string, TaskActionId> = {
    enqueue: retryable ? 'retry' : 'enqueue',
    queue: 'queue',
    unqueue: 'unqueue',
    'run-now': 'run-now',
    release: 'release',
    'stop-waiting': 'stop-waiting',
    undo: 'undo',
    cancel: 'cancel',
    dequeue: 'cancel',
    'mark-published': 'mark-published',
    publish: 'publish',
    complete: 'complete',
    'review-now': 'review',
    'apply-review': 'apply-review',
    unblock: 'unblock',
    'stop-agent': 'stop-agent',
    hide: 'hide',
    unhide: 'unhide',
  };
  for (const a of actions) a.act = ACT_OF[a.id];
  return actions;
}
