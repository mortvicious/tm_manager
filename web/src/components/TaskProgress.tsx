import type { CSSProperties } from 'react';
import type { Task } from '@tm/shared';
import { progressTitle, useTaskProgress } from '../progress.ts';

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

export function ProgressPct({ task }: { task: Task }) {
  const p = useTaskProgress(task);
  if (!p) return null;
  return (
    <span className={`progress-pct${p.overrun ? ' overrun' : ''}`} title={progressTitle(p)}>
      ~{p.pct}%
    </span>
  );
}
