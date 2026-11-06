import type { CSSProperties } from 'react';
import type { Task } from '@tm/shared';
import { heavyWaitLabel } from '@tm/shared';
import { progressTitle, useTaskProgress } from '../progress.ts';
import { useApp } from '../state.tsx';

/**
 * The task's place behind the heavy slots (docs/memory.md § Heavy work):
 * `waiting for a check slot` / `waiting for a heavy slot`, or null.
 */
export function useHeavyWait(taskId: string): string | null {
  const { orch } = useApp();
  return heavyWaitLabel(orch.heavy, taskId);
}

/**
 * The board row's approximate progress (docs/task-progress.md): a hairline along
 * the row's bottom edge plus "~45%" beside the status badge. Both read the
 * same `useTaskProgress`, so they can never disagree; both render nothing
 * where a % means nothing (draft, queued, a settled review, …).
 */
export function ProgressBar({ task }: { task: Task }) {
  const p = useTaskProgress(task);
  if (!p) return null;
  return (
    <span
      className={`row-progress${p.overrun ? ' overrun' : ''}`}
      data-band={p.band}
      title={progressTitle(p)}
      aria-hidden="true"
      style={{ '--tm-progress': p.pct / 100 } as CSSProperties}
    />
  );
}

/**
 * "~45%" — and, while the task is queued behind the heavy slots, the reason
 * the number is not moving: every board row renders this, the frozen original
 * included, so the wait is visible on each of them.
 */
export function ProgressPct({ task }: { task: Task }) {
  const p = useTaskProgress(task);
  const wait = useHeavyWait(task.id);
  if (wait) {
    return (
      <span className="progress-pct heavy-wait" title={`${wait} — heavy work (checks, builds, browser runs) goes one job at a time`}>
        {p ? `~${p.pct}% · ` : ''}
        {wait}
      </span>
    );
  }
  if (!p) return null;
  return (
    <span className={`progress-pct${p.overrun ? ' overrun' : ''}`} title={progressTitle(p)}>
      ~{p.pct}%
    </span>
  );
}
