import { useState, type CSSProperties, type HTMLAttributes, type MouseEvent, type ReactNode, type Ref } from 'react';
import { publishCaution, publishGateReason, type Task, type TaskStatus } from '@tm/shared';
import { api } from '../api.ts';
import { confirmMarkPublished, confirmPublish, markPublishedLabel, markPublishedOffered, publishIsPrimary } from '../publish.ts';
import { useApp, useAppSelector } from '../state.tsx';
import { runsOfTask } from '../runIndex.ts';
import { toastError } from '../toast.ts';
import { ACTION_TITLE, publishBusy, runTaskAction, usePendingAction, type TaskActionId } from '../pending.ts';
import { nextStep, type NextStep } from '../nextStep.ts';
import { useArm } from '../arm.ts';
import { IconCheck, IconEye, IconGrip, IconMore, IconPlay, IconPublish, IconQueue, IconStop, IconTerminal, IconX } from './Icons.tsx';
import { useIsMobile } from './Layout.tsx';
import { QueueMark } from './QueueMark.tsx';
import { RoleChip, useTaskRole } from './RoleChip.tsx';
import { Sheet, SheetAction } from './Sheet.tsx';
import { ProgressBar } from './TaskProgress.tsx';
import { useRowSwipe, type SwipeSide } from './RowSwipe.tsx';

// Mirrors the server guards (server/src/routes/tasks.ts + orchestrator.runNow)
// so a disabled quick action gives the same answer a 409 would have.
const CAN_RUN: TaskStatus[] = ['draft', 'queued', 'review', 'failed', 'cancelled'];
// 'review' is absent on purpose: there the check means "mark done" (complete),
// which is what the slide-over's primary button does for a task in review.
const CAN_READY: TaskStatus[] = ['draft', 'failed', 'cancelled'];
// Custom queue (docs/queue.md): the same enqueue guards, plus a task already
// queued for the GLOBAL queue may move over.
const CAN_QUEUE: TaskStatus[] = ['draft', 'failed', 'cancelled', 'review', 'queued'];
const LIVE_MSG = 'Previous session is still live — open its terminal or kill it first';

/** Icon button in a row. The title lives on the wrapper: `.btn:disabled` sets
 *  pointer-events:none, so a title on the button itself would never show. */
function QuickBtn({
  label,
  className,
  disabled,
  inFlight,
  onClick,
  children,
}: {
  label: string;
  className?: string;
  disabled: boolean;
  /** this button's action is in flight (src/pending.ts): its icon breathes, its label says so */
  inFlight?: string | null;
  onClick: (e: MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <span className="quick-wrap" title={inFlight ?? label}>
      <button
        className={`btn ghost quick ${className ?? ''}${inFlight ? ' in-flight' : ''}`}
        aria-label={inFlight ?? label}
        aria-busy={inFlight ? true : undefined}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    </span>
  );
}

/**
 * One task line with its quick actions: terminal on the left (attaches to the
 * task's live session, else its most recent one), then publish (review only),
 * run-now and mark-as-ready (mark-done for a task in review) on the right.
 * `children` renders between the title and the actions (chips, status badge,
 * age).
 */
export function TaskRow({
  task,
  onOpenTask,
  onOpenTerminal,
  fresh,
  depth = 0,
  grip,
  dropClass,
  select,
  progress,
  children,
}: {
  task: Task;
  onOpenTask: (id: string) => void;
  onOpenTerminal: (runId: string) => void;
  /** filed recently — draws the accent edge that separates new from old */
  fresh?: boolean;
  /** nesting level under the deepest ancestor visible in the SAME list
   *  (0 = shown as a root there); drives the indent, not the data model */
  depth?: number;
  /** props for the drag grip (components/TaskDrag.tsx); absent = the row is
   *  neither draggable nor a drop target (the flat `recent` list) */
  grip?: HTMLAttributes<HTMLElement> & { ref?: Ref<HTMLElement> };
  /** drop indicator while a drag hovers this row (`drop-before`, `dragging`…) */
  dropClass?: string;
  /** board multi-select (docs/inbox.md § Bulk actions): a click toggles the
   *  row instead of opening it, and a checkbox leads the row */
  select?: { on: boolean; toggle: () => void };
  /** draw the approximate progress bar along the row's bottom (docs/task-progress.md; the board only) */
  progress?: boolean;
  children?: ReactNode;
}) {
  const { runs, tasks, refresh, orch, questions } = useApp();
  const mobile = useIsMobile();
  // one action at a time per TASK, whichever surface pressed it (src/pending.ts)
  const pend = usePendingAction(task.id);
  const busy = !!pend;
  /** the in-flight wording when `a` is the action under way, for that one button */
  const flying = (...a: TaskActionId[]) => (pend && a.includes(pend.action) ? pend.verb : null);
  const [sheet, setSheet] = useState(false);
  // taking a WAITING member out of the custom queue cancels it (docs/queue.md),
  // so the × arms first and a second press cancels (src/arm.ts)
  const arm = useArm();

  const taskRuns = runsOfTask(runs, task.id);
  // Prefer the live session (its PTY is certain to still be attachable);
  // listRuns is started_at DESC, so [0] is otherwise the newest.
  const run = taskRuns.find((r) => r.status === 'running') ?? taskRuns[0];
  // A run row stays 'running' while a finished session idles at the prompt
  // (internal Stop hook sets idle, not the status), and boot recovery flips
  // stale rows to 'exited' — so this is the client mirror of the server's
  // hasLiveSession() guard that both enqueue and run-now enforce.
  const live = taskRuns.some((r) => r.status === 'running');

  const act = async (e: MouseEvent | null, a: TaskActionId, fn: () => Promise<unknown>) => {
    e?.stopPropagation();
    try {
      // in flight on every surface, then a confirmation (docs/mobile.md § Action feedback)
      if ((await runTaskAction(task, a, fn)) !== undefined) await refresh();
    } catch (e2) {
      // the shared toast (docs/mobile.md § Action errors): a row is too small
      // to hold a 409 reason, and the refused row may be scrolled off by now
      toastError(e2, ACTION_TITLE[a]);
    }
  };

  // review → the check completes the task (and the server closes its idle
  // session), so the live-session guard does not apply to that variant.
  const markDone = task.status === 'review';
  const canRun = !!task.repoId && CAN_RUN.includes(task.status) && !live;
  const canReady = markDone || (!!task.repoId && CAN_READY.includes(task.status) && !live);
  // A waiting member's queue button turns into "remove"; a running member
  // keeps its slot until its turn ends (cancel is the way to stop it).
  const inQueue = !!task.customQueueAt && task.status === 'queued';
  // hiding is for a task at rest (docs/design.md § Hidden tasks)
  const working = task.status === 'running' || task.status === 'waiting';
  // parked by background shells alone (docs/design.md § Waiting): Stop waiting lands it
  const shellWait = task.status === 'waiting' && !!orch.shellWaits?.includes(task.id);
  const stopWaitArmed = arm.armed === 'stop-waiting';
  const stopWaitLabel = stopWaitArmed
    ? `Stop waiting? ${mobile ? 'tap' : 'click'} again`
    : 'Stop waiting — only background shells hold this task; land the turn now and kill them (asks for a second press)';
  const canQueue = inQueue || (!!task.repoId && CAN_QUEUE.includes(task.status) && !live);
  const unqueueArmed = inQueue && arm.armed === 'unqueue';
  const queueLabel = inQueue
    ? unqueueArmed
      ? `Cancel task? ${mobile ? 'tap' : 'click'} again`
      : 'Cancel task — it leaves the queue and is cancelled (asks for a second press)'
    : !task.repoId
      ? 'Assign a repo before queueing this task'
      : task.status === 'running' || task.status === 'waiting'
        ? 'Already running'
        : !CAN_QUEUE.includes(task.status)
          ? `Cannot add to the queue from '${task.status}'`
          : live
            ? LIVE_MSG
            : 'Add to queue — runs one task per repo, independent of the global queue';

  const runLabel = !task.repoId
    ? 'Assign a repo before running this task'
    : task.status === 'running' || task.status === 'waiting'
      ? 'Already running'
      : !CAN_RUN.includes(task.status)
        ? `Cannot run from '${task.status}'`
        : live
          ? LIVE_MSG
          : 'Run now';
  // Publish is offered only where the server accepts it: a task in review,
  // with somewhere to push from, whose review/checks are not still open
  // (docs/publish.md § The verify gate).
  const publishGate = publishGateReason(task);
  // the agent already pushed it: the slot records that instead (§ Observed publish)
  const shipped = markPublishedOffered(task);
  const publishLabel = shipped
    ? markPublishedLabel(task)
    : !task.repoId
    ? 'Assign a repo before publishing this task'
    : publishGate
      ? `Publish — ${publishGate}`
      : publishCaution(task)
        ? `Publish anyway (asks first) — ${publishCaution(task)}`
        : 'Publish — commit and push this work in the agent\'s own terminal';
  const canPublish = markDone && !!task.repoId && !publishGate;
  const readyLabel = markDone
    ? 'Mark done'
    : !task.repoId
      ? 'Assign a repo before queueing this task'
      : task.status === 'queued'
        ? 'Already queued'
        : !CAN_READY.includes(task.status)
          ? `Cannot enqueue from '${task.status}'`
          : live
            ? LIVE_MSG
            : 'Mark as ready — enqueue for the orchestrator';
  // The live line: what the agent is doing right now, straight off its
  // transcript. The server only tracks live, non-idle runs and clears the
  // entry when one ends, so a present entry means "still working".
  // A selector, not the whole `activity` slice: a run's activity line
  // re-renders only its own row (docs/spa-performance.md § Store).
  const runId = run?.id;
  const liveLine = useAppSelector((s) => (runId ? s.activity[runId] : undefined));

  const termLabel = run
    ? `Open terminal (session ${run.id.slice(0, 8)}${run.status === 'running' ? '' : ', ended'})`
    : 'No session yet — run this task first';

  // Phones (docs/mobile.md § Rows): one primary action for the status, then
  // everything else behind ⋯. The primary falls back to the terminal, or to
  // nothing, rather than sit on the row disabled. A disabled button with its
  // reason in a tooltip is exactly what a phone cannot read.
  const openTerm = () => run && onOpenTerminal(run.id);
  const doRun = (e: MouseEvent | null) => act(e, 'run-now', () => api.taskAction(task.id, 'run-now'));
  const doPublish = (e: MouseEvent | null) => {
    e?.stopPropagation();
    if (shipped) {
      if (!confirmMarkPublished(task)) return;
      void act(e, 'mark-published', () => api.taskAction(task.id, 'mark-published'));
      return;
    }
    if (!confirmPublish(task)) return;
    void act(e, 'publish', () => api.taskAction(task.id, 'publish'));
  };
  const runnable: TaskStatus[] = ['draft', 'queued', 'failed', 'cancelled'];
  const primary: 'terminal' | 'run' | 'publish' | null =
    publishIsPrimary(task)
      ? 'publish'
      : runnable.includes(task.status) && canRun
        ? 'run'
        : run && (live || !runnable.includes(task.status))
          ? 'terminal'
          : null;

  // The next step (docs/mobile.md § Next step): the phone row names what the
  // human should do, read like the status pill (nextStep.ts). A press in
  // flight keeps its own step on the button, saying so.
  const pubBusy = publishBusy(task, runs, orch, pend);
  const step = nextStep(task, {
    question: questions.some((q) => q.taskId === task.id),
    attention: task.status === 'running' && taskRuns.some((r) => r.status === 'running' && r.needsAttention),
    live,
    busy: !!pubBusy && pend?.action !== 'publish' && pend?.action !== 'mark-published',
  });
  const attnRun = taskRuns.find((r) => r.status === 'running' && r.needsAttention) ?? run;
  const doStep = (st: NextStep, e: MouseEvent | null) => {
    e?.stopPropagation();
    switch (st.kind) {
      case 'answer':
      case 'findings':
        onOpenTask(task.id);
        return;
      case 'prompt':
        if (attnRun) onOpenTerminal(attnRun.id);
        return;
      case 'publish':
        doPublish(e);
        return;
      case 'retry':
        void act(e, 'retry', () => api.taskAction(task.id, 'retry'));
        return;
      case 'run':
        void doRun(e);
        return;
    }
  };
  const stepFlying = step
    ? step.kind === 'publish'
      ? flying('publish', 'mark-published')
      : step.kind === 'retry'
        ? flying('retry')
        : step.kind === 'run'
          ? flying('run-now')
          : null
    : null;
  // opening a task or a terminal is never blocked by a press in flight
  const stepAct = step && step.kind !== 'answer' && step.kind !== 'findings' && step.kind !== 'prompt';

  // Row swipe (docs/mobile.md § Row swipe): trailing = the next step (+ Cancel
  // for a queued task, two-press), leading = Hide/Unhide. Off while selecting.
  const cancelKind: 'cancel' | 'unqueue' | null = task.status === 'queued' ? (task.customQueueAt ? 'unqueue' : 'cancel') : null;
  const swipeCancelArmed = arm.armed === 'swipe-cancel';
  const trailCount = (step ? 1 : 0) + (cancelKind ? 1 : 0);
  const canHide = !!task.hiddenAt || !working;
  const trail: SwipeSide | null = trailCount
    ? {
        count: trailCount,
        render: (closeSwipe) => (
          <>
            {step && (
              <button
                type="button"
                className={`swipe-btn k-${step.kind}${stepFlying ? ' in-flight' : ''}`}
                title={step.title}
                aria-busy={stepFlying ? true : undefined}
                disabled={!!stepAct && busy}
                onClick={(e) => {
                  closeSwipe();
                  doStep(step, e);
                }}
              >
                {stepFlying ?? step.label}
              </button>
            )}
            {cancelKind && (
              <button
                type="button"
                className={`swipe-btn k-cancel${swipeCancelArmed ? ' armed' : ''}`}
                title="Cancel the task — it leaves the queue (asks for a second press)"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  // the arming tap keeps the row open for the second one (src/arm.ts)
                  if (!arm.press('swipe-cancel')) return;
                  closeSwipe();
                  void act(null, cancelKind, () => api.taskAction(task.id, cancelKind));
                }}
              >
                {swipeCancelArmed ? 'Cancel? tap again' : 'Cancel'}
              </button>
            )}
          </>
        ),
      }
    : null;
  const lead: SwipeSide | null = canHide
    ? {
        count: 1,
        render: (closeSwipe) => (
          <button
            type="button"
            className="swipe-btn k-hide"
            title={task.hiddenAt ? 'Back to its usual section' : 'Into the dimmed Hidden section'}
            disabled={busy}
            onClick={(e) => {
              closeSwipe();
              void act(e, task.hiddenAt ? 'unhide' : 'hide', () => api.taskAction(task.id, task.hiddenAt ? 'unhide' : 'hide'));
            }}
          >
            {flying('hide', 'unhide') ?? (task.hiddenAt ? 'Unhide' : 'Hide')}
          </button>
        ),
      }
    : null;
  const swipe = useRowSwipe(`row:${task.id}`, lead, trail, mobile && !select && !sheet);
  // the office role that filed the task (docs/office.md § Role-tagged work) leads the row's chips
  const hasRole = useTaskRole(task) !== null;

  if (mobile) {
    const close = () => setSheet(false);
    // close first, then act: the sheet must not sit over the row's error line
    const fromSheet = (fn: () => void) => () => {
      close();
      fn();
    };
    return (
      <div
        {...swipe.rowProps}
        className={`task-row m ${progress ? 'has-progress' : ''} ${grip ? '' : 'no-grip'} ${depth > 0 ? 'nested' : ''} ${fresh ? 'fresh' : ''} ${dropClass ?? ''} ${swipe.cls}`}
        // on the row, not the title: the meta line below indents by it too
        style={depth > 1 || swipe.rowProps.style ? ({ ...(depth > 1 ? { '--tm-depth': depth } : {}), ...swipe.rowProps.style } as CSSProperties) : undefined}
        data-drop-task={grip ? task.id : undefined}
        onClick={() => (select ? select.toggle() : onOpenTask(task.id))}
        data-selected={select?.on || undefined}
      >
        {swipe.layer}
        {select && <SelectBox on={select.on} />}
        {grip && (
          <span className="drag-grip" title="Press and hold, then drag: onto a task to group with it, above or below it to reorder" {...grip}>
            <IconGrip />
          </span>
        )}
        <span className={`task-main ${depth > 0 ? 'child' : ''}`}>
          <span className="title">{task.title}</span>
          <QueueMark task={task} tasks={tasks} explain={!select} />
          {liveLine?.text && (
            <span className={`row-activity ${liveLine.kind}`}>
              <span className="live-dot" aria-hidden="true" />
              <span className="what">{liveLine.text}</span>
            </span>
          )}
        </span>
        <span className="row-actions">
          {step && (
            <span className="quick-wrap" title={stepFlying ?? step.title}>
              <button
                type="button"
                className={`btn next-step k-${step.kind}${stepFlying ? ' in-flight' : ''}`}
                aria-label={stepFlying ?? step.title}
                aria-busy={stepFlying ? true : undefined}
                disabled={!!stepAct && busy}
                onClick={(e) => doStep(step, e)}
              >
                {stepFlying ?? step.label}
              </button>
            </span>
          )}
          {!step && primary === 'terminal' && (
            <QuickBtn
              label={termLabel}
              className="primary-act"
              disabled={false}
              onClick={(e) => {
                e.stopPropagation();
                openTerm();
              }}
            >
              <IconTerminal />
            </QuickBtn>
          )}
          {!step && primary === 'run' && (
            <QuickBtn label="Run now" className="primary-act" disabled={busy} inFlight={flying('run-now')} onClick={(e) => doRun(e)}>
              <IconPlay />
            </QuickBtn>
          )}
          {!step && primary === 'publish' && (
            <QuickBtn
              label={publishLabel}
              className="primary-act"
              disabled={busy}
              inFlight={flying('publish', 'mark-published')}
              onClick={(e) => doPublish(e)}
            >
              <IconPublish />
            </QuickBtn>
          )}
          <QuickBtn
            label="More actions"
            disabled={false}
            onClick={(e) => {
              e.stopPropagation();
              setSheet(true);
            }}
          >
            <IconMore />
          </QuickBtn>
        </span>
        {(children || hasRole) && (
          <span className="row-meta">
            <RoleChip task={task} />
            {children}
          </span>
        )}
        {sheet && (
          <Sheet label={`Actions for ${task.title}`} title={task.title} onClose={close}>
            <div className="sheet-actions">
              <SheetAction
                icon={<IconTerminal />}
                label="Open terminal"
                hint={
                  run
                    ? `Session ${run.id.slice(0, 8)}${run.status === 'running' ? ', live' : ', ended'}`
                    : 'No session yet — run this task first'
                }
                disabled={!run}
                onClick={fromSheet(openTerm)}
              />
              {markDone && (
                <SheetAction
                  icon={<IconPublish />}
                  label={flying('publish', 'mark-published') ?? (shipped ? 'Mark published' : 'Publish')}
                  hint={shipped ? publishLabel : publishIsPrimary(task) ? "Commit and push this work in the agent's own terminal" : publishLabel}
                  tone={publishIsPrimary(task) ? 'primary' : undefined}
                  disabled={busy || !canPublish}
                  onClick={fromSheet(() => void doPublish(null))}
                />
              )}
              {shellWait && (
                <SheetAction
                  icon={<IconStop />}
                  label={stopWaitArmed ? 'Stop waiting? tap again' : 'Stop waiting'}
                  hint="Only background shells hold this task — land the turn now and kill them"
                  tone="primary"
                  disabled={busy}
                  onClick={() => {
                    if (!arm.press('stop-waiting')) return;
                    fromSheet(() => void act(null, 'stop-waiting', () => api.taskAction(task.id, 'stop-waiting')))();
                  }}
                />
              )}
              <SheetAction
                icon={<IconPlay />}
                label="Run now"
                hint={canRun ? 'Spawn an agent at once, ahead of the queue' : runLabel}
                disabled={busy || !canRun}
                onClick={fromSheet(() => void doRun(null))}
              />
              <SheetAction
                icon={<IconCheck />}
                label={markDone ? 'Mark done' : 'Mark as ready'}
                hint={markDone ? 'Close the task without publishing' : readyLabel}
                disabled={busy || !canReady}
                onClick={fromSheet(() => void act(null, markDone ? 'complete' : 'enqueue', () => api.taskAction(task.id, markDone ? 'complete' : 'enqueue')))}
              />
              <SheetAction
                icon={inQueue ? <IconX /> : <IconQueue />}
                label={inQueue ? (unqueueArmed ? 'Cancel task? tap again' : 'Cancel task') : 'Add to queue'}
                hint={inQueue ? 'Takes it out of the one-at-a-time queue and cancels it' : queueLabel}
                tone={inQueue ? 'danger' : undefined}
                disabled={busy || !canQueue}
                onClick={() => {
                  // the arming tap keeps the sheet open for the second one
                  if (inQueue && !arm.press('unqueue')) return;
                  fromSheet(() => void act(null, inQueue ? 'unqueue' : 'queue', () => api.taskAction(task.id, inQueue ? 'unqueue' : 'queue')))();
                }}
              />
              <SheetAction
                icon={<IconEye off={!task.hiddenAt} />}
                label={task.hiddenAt ? 'Unhide' : 'Hide'}
                hint={task.hiddenAt ? 'Back to its usual section' : working ? 'A working task stays visible' : 'Into the dimmed Hidden section, out of Drafts'}
                disabled={busy || (!task.hiddenAt && working)}
                onClick={fromSheet(() => void act(null, task.hiddenAt ? 'unhide' : 'hide', () => api.taskAction(task.id, task.hiddenAt ? 'unhide' : 'hide')))}
              />
              <SheetAction
                icon={<IconMore />}
                label="Open details"
                hint="Edit, follow up, review, files"
                onClick={fromSheet(() => onOpenTask(task.id))}
              />
            </div>
          </Sheet>
        )}
        {progress && <ProgressBar task={task} />}
      </div>
    );
  }

  return (
    <div
      className={`task-row ${progress ? 'has-progress' : ''} ${fresh ? 'fresh' : ''} ${dropClass ?? ''}`}
      data-drop-task={grip ? task.id : undefined}
      // where the task panel hands focus back on close (dialogFocus.ts):
      // focusable by script and click, never a Tab stop
      data-task-row={task.id}
      tabIndex={-1}
      onClick={() => (select ? select.toggle() : onOpenTask(task.id))}
      data-selected={select?.on || undefined}
    >
      {select && <SelectBox on={select.on} />}
      {grip && (
        <span className="drag-grip" title="Drag: onto a task to group with it, above or below it to reorder" {...grip}>
          <IconGrip />
        </span>
      )}
      <QuickBtn
        label={termLabel}
        disabled={!run}
        onClick={(e) => {
          e.stopPropagation();
          if (run) onOpenTerminal(run.id);
        }}
      >
        <IconTerminal />
      </QuickBtn>
      <span
        className={`task-main ${depth > 0 ? 'child' : ''}`}
        style={depth > 1 ? ({ '--tm-depth': depth } as CSSProperties) : undefined}
      >
        <span className="title">{task.title}</span>
        <QueueMark task={task} tasks={tasks} />
        {liveLine?.text && (
          <span
            className={`row-activity ${liveLine.kind}`}
            title={`${liveLine.text}\n(live — from the agent's session)`}
          >
            <span className="live-dot" aria-hidden="true" />
            <span className="what">{liveLine.text}</span>
          </span>
        )}
      </span>
      <RoleChip task={task} />
      {children}
      <span className="row-actions">
        {shellWait && (
          <QuickBtn
            label={stopWaitLabel}
            className={stopWaitArmed ? 'armed' : undefined}
            disabled={busy}
            inFlight={flying('stop-waiting')}
            onClick={(e) => {
              if (!arm.press('stop-waiting')) {
                e.stopPropagation();
                return;
              }
              void act(e, 'stop-waiting', () => api.taskAction(task.id, 'stop-waiting'));
            }}
          >
            {stopWaitArmed ? 'Stop?' : <IconStop />}
          </QuickBtn>
        )}
        <QuickBtn
          label={queueLabel}
          className={unqueueArmed ? 'armed' : inQueue ? 'queued' : undefined}
          disabled={busy || !canQueue}
          inFlight={flying('queue', 'unqueue')}
          onClick={(e) => {
            if (inQueue && !arm.press('unqueue')) {
              e.stopPropagation();
              return;
            }
            void act(e, inQueue ? 'unqueue' : 'queue', () => api.taskAction(task.id, inQueue ? 'unqueue' : 'queue'));
          }}
        >
          {unqueueArmed ? 'Cancel?' : inQueue ? <IconX /> : <IconQueue />}
        </QuickBtn>
        {markDone && (
          <QuickBtn
            label={publishLabel}
            disabled={busy || !canPublish}
            inFlight={flying('publish', 'mark-published')}
            onClick={(e) => doPublish(e)}
          >
            <IconPublish />
          </QuickBtn>
        )}
        <QuickBtn
          label={runLabel}
          disabled={busy || !canRun}
          inFlight={flying('run-now')}
          onClick={(e) => act(e, 'run-now', () => api.taskAction(task.id, 'run-now'))}
        >
          <IconPlay />
        </QuickBtn>
        <QuickBtn
          label={readyLabel}
          className={markDone ? 'affirm' : undefined}
          disabled={busy || !canReady}
          inFlight={flying('complete', 'enqueue')}
          onClick={(e) => act(e, markDone ? 'complete' : 'enqueue', () => api.taskAction(task.id, markDone ? 'complete' : 'enqueue'))}
        >
          <IconCheck />
        </QuickBtn>
      </span>
      {progress && <ProgressBar task={task} />}
    </div>
  );
}

/** The multi-select tick: the row itself is the control (its click toggles), so this is the mark. */
function SelectBox({ on }: { on: boolean }) {
  return (
    <span className={`row-select${on ? ' on' : ''}`} role="checkbox" aria-checked={on} aria-label="Select task">
      {on && <IconCheck />}
    </span>
  );
}
