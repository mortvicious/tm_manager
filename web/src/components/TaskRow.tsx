import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import type { Task, TaskStatus } from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { IconCheck, IconPlay, IconTerminal } from './Icons.tsx';

// Mirrors the server guards (server/src/routes/tasks.ts + orchestrator.runNow)
// so a disabled quick action gives the same answer a 409 would have.
const CAN_RUN: TaskStatus[] = ['draft', 'queued', 'review', 'failed', 'cancelled'];
// 'review' is absent on purpose: there the check means "mark done" (complete),
// which is what the slide-over's primary button does for a task in review.
const CAN_READY: TaskStatus[] = ['draft', 'failed', 'cancelled'];
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
 * task's live session, else its most recent one), run-now + mark-as-ready
 * (mark-done for a task in review) on the right. `children` renders between
 * the title and the actions (chips, status badge, age).
 */
export function TaskRow({
  task,
  onOpenTask,
  onOpenTerminal,
  fresh,
  children,
}: {
  task: Task;
  onOpenTask: (id: string) => void;
  onOpenTerminal: (runId: string) => void;
  /** filed recently — draws the accent edge that separates new from old */
  fresh?: boolean;
  children?: ReactNode;
}) {
  const { runs, refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

  const act = async (e: MouseEvent, fn: () => Promise<unknown>) => {
    e.stopPropagation();
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

  const runLabel = !task.repoId
    ? 'Assign a repo before running this task'
    : task.status === 'running'
      ? 'Already running'
      : !CAN_RUN.includes(task.status)
        ? `Cannot run from '${task.status}'`
        : live
          ? LIVE_MSG
          : 'Run now';
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
  const termLabel = run
    ? `Open terminal (session ${run.id.slice(0, 8)}${run.status === 'running' ? '' : ', ended'})`
    : 'No session yet — run this task first';

  return (
    <div className={`task-row ${fresh ? 'fresh' : ''}`} onClick={() => onOpenTask(task.id)}>
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
      <span className={`title ${task.parentId ? 'child' : ''}`}>{task.title}</span>
      {children}
      {err && (
        <span className="warn-text row-err" title={err}>
          {err}
        </span>
      )}
      <span className="row-actions">
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
