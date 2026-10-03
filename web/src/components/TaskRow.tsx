import { useEffect, useState, type CSSProperties, type HTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import type { Task, TaskStatus } from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { IconCheck, IconGrip, IconMore, IconPlay, IconPublish, IconQueue, IconTerminal, IconX } from './Icons.tsx';
import { useIsMobile } from './Layout.tsx';
import { QueueMark } from './QueueMark.tsx';
import { Sheet, SheetAction } from './Sheet.tsx';

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
  onClick,
  children,
}: {
  label: string;
  className?: string;
  disabled: boolean;
  onClick: (e: MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <span className="quick-wrap" title={label}>
      <button
        className={`btn ghost quick ${className ?? ''}`}
        aria-label={label}
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
  grip?: HTMLAttributes<HTMLElement>;
  /** drop indicator while a drag hovers this row (`drop-before`, `dragging`…) */
  dropClass?: string;
  children?: ReactNode;
}) {
  const { runs, tasks, activity, refresh } = useApp();
  const mobile = useIsMobile();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);

  // Row errors are transient — a 409 here is informational, not a state to sit in.
  useEffect(() => {
    if (!err) return;
    const t = setTimeout(() => setErr(null), 6000);
    return () => clearTimeout(t);
  }, [err]);

  const taskRuns = runs.filter((r) => r.taskId === task.id);
  // Prefer the live session (its PTY is certain to still be attachable);
  // listRuns is started_at DESC, so [0] is otherwise the newest.
  const run = taskRuns.find((r) => r.status === 'running') ?? taskRuns[0];
  // A run row stays 'running' while a finished session idles at the prompt
  // (internal Stop hook sets idle, not the status), and boot recovery flips
  // stale rows to 'exited' — so this is the client mirror of the server's
  // hasLiveSession() guard that both enqueue and run-now enforce.
  const live = taskRuns.some((r) => r.status === 'running');

  const act = async (e: MouseEvent | null, fn: () => Promise<unknown>) => {
    e?.stopPropagation();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await refresh();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
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
  const canQueue = inQueue || (!!task.repoId && CAN_QUEUE.includes(task.status) && !live);
  const queueLabel = inQueue
    ? 'Remove from queue'
    : !task.repoId
      ? 'Assign a repo before queueing this task'
      : task.status === 'running' || task.status === 'waiting'
        ? 'Already running'
        : !CAN_QUEUE.includes(task.status)
          ? `Cannot add to the queue from '${task.status}'`
          : live
            ? LIVE_MSG
            : 'Add to queue — runs one task at a time, independent of the global queue';

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
  // with somewhere to push from.
  const publishLabel = !task.repoId
    ? 'Assign a repo before publishing this task'
    : 'Publish — commit and push this work in the agent\'s own terminal';
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
  const liveLine = run ? activity[run.id] : undefined;

  const termLabel = run
    ? `Open terminal (session ${run.id.slice(0, 8)}${run.status === 'running' ? '' : ', ended'})`
    : 'No session yet — run this task first';

  // Phones (docs/mobile.md § Rows): one primary action for the status, then
  // everything else behind ⋯. The primary falls back to the terminal, or to
  // nothing, rather than sit on the row disabled. A disabled button with its
  // reason in a tooltip is exactly what a phone cannot read.
  const openTerm = () => run && onOpenTerminal(run.id);
  const doRun = (e: MouseEvent | null) => act(e, () => api.taskAction(task.id, 'run-now'));
  const doPublish = (e: MouseEvent | null) => act(e, () => api.taskAction(task.id, 'publish'));
  const runnable: TaskStatus[] = ['draft', 'queued', 'failed', 'cancelled'];
  const primary: 'terminal' | 'run' | 'publish' | null =
    task.status === 'review' && task.repoId
      ? 'publish'
      : runnable.includes(task.status) && canRun
        ? 'run'
        : run && (live || !runnable.includes(task.status))
          ? 'terminal'
          : null;

  if (mobile) {
    const close = () => setSheet(false);
    // close first, then act: the sheet must not sit over the row's error line
    const fromSheet = (fn: () => void) => () => {
      close();
      fn();
    };
    return (
      <div
        className={`task-row m ${grip ? '' : 'no-grip'} ${depth > 0 ? 'nested' : ''} ${fresh ? 'fresh' : ''} ${dropClass ?? ''}`}
        // on the row, not the title: the meta line below indents by it too
        style={depth > 1 ? ({ '--tm-depth': depth } as CSSProperties) : undefined}
        data-drop-task={grip ? task.id : undefined}
        onClick={() => onOpenTask(task.id)}
      >
        {grip && (
          <span className="drag-grip" title="Drag: onto a task to group with it, above or below it to reorder" {...grip}>
            <IconGrip />
          </span>
        )}
        <span className={`task-main ${depth > 0 ? 'child' : ''}`}>
          <span className="title">{task.title}</span>
          <QueueMark task={task} tasks={tasks} />
          {liveLine?.text && (
            <span className={`row-activity ${liveLine.kind}`}>
              <span className="live-dot" aria-hidden="true" />
              <span className="what">{liveLine.text}</span>
            </span>
          )}
        </span>
        <span className="row-actions">
          {primary === 'terminal' && (
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
          {primary === 'run' && (
            <QuickBtn label="Run now" className="primary-act" disabled={busy} onClick={(e) => doRun(e)}>
              <IconPlay />
            </QuickBtn>
          )}
          {primary === 'publish' && (
            <QuickBtn label={publishLabel} className="primary-act" disabled={busy} onClick={(e) => doPublish(e)}>
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
        {children && <span className="row-meta">{children}</span>}
        {err && (
          <span className="warn-text row-err" title={err}>
            {err}
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
                  label="Publish"
                  hint={task.repoId ? "Commit and push this work in the agent's own terminal" : publishLabel}
                  tone="primary"
                  disabled={busy || !task.repoId}
                  onClick={fromSheet(() => void doPublish(null))}
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
                onClick={fromSheet(() => void act(null, () => api.taskAction(task.id, markDone ? 'complete' : 'enqueue')))}
              />
              <SheetAction
                icon={inQueue ? <IconX /> : <IconQueue />}
                label={inQueue ? 'Remove from queue' : 'Add to queue'}
                hint={inQueue ? 'Take it out of the one-at-a-time queue' : queueLabel}
                disabled={busy || !canQueue}
                onClick={fromSheet(() => void act(null, () => api.taskAction(task.id, inQueue ? 'unqueue' : 'queue')))}
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
      </div>
    );
  }

  return (
    <div
      className={`task-row ${fresh ? 'fresh' : ''} ${dropClass ?? ''}`}
      data-drop-task={grip ? task.id : undefined}
      onClick={() => onOpenTask(task.id)}
    >
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
      {children}
      {err && (
        <span className="warn-text row-err" title={err}>
          {err}
        </span>
      )}
      <span className="row-actions">
        <QuickBtn
          label={queueLabel}
          className={inQueue ? 'queued' : undefined}
          disabled={busy || !canQueue}
          onClick={(e) => act(e, () => api.taskAction(task.id, inQueue ? 'unqueue' : 'queue'))}
        >
          {inQueue ? <IconX /> : <IconQueue />}
        </QuickBtn>
        {markDone && (
          <QuickBtn
            label={publishLabel}
            disabled={busy || !task.repoId}
            onClick={(e) => act(e, () => api.taskAction(task.id, 'publish'))}
          >
            <IconPublish />
          </QuickBtn>
        )}
        <QuickBtn
          label={runLabel}
          disabled={busy || !canRun}
          onClick={(e) => act(e, () => api.taskAction(task.id, 'run-now'))}
        >
          <IconPlay />
        </QuickBtn>
        <QuickBtn
          label={readyLabel}
          className={markDone ? 'affirm' : undefined}
          disabled={busy || !canReady}
          onClick={(e) => act(e, () => api.taskAction(task.id, markDone ? 'complete' : 'enqueue'))}
        >
          <IconCheck />
        </QuickBtn>
      </span>
    </div>
  );
}
