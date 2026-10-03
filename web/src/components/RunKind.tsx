import type { Run, RunKind, Task } from '@tm/shared';

/**
 * Every claude the server spawns is a terminal (docs/design.md § PTY
 * sessions); `kind` says which. Workers keep their plain look — the badge is
 * for the aux sessions that sit beside them in the runs list.
 */
const KIND_TITLE: Record<RunKind, string> = {
  worker: 'the task’s own agent',
  review: 'adversarial review of the task’s diff (read-only)',
  plan: 'feature planning (read-only)',
  'plan-review': 'adversarial review of a feature plan (read-only)',
  analysis: 'task analysis / proposals (read-only)',
  compact: 'compacting the task’s session before it is resumed',
  report: 'writing a client report (no tools)',
  chat: 'one chat turn',
  commit: 'writing a commit message (no tools)',
};

export function KindBadge({ kind }: { kind: RunKind }) {
  return (
    <span className={`chip run-kind k-${kind}`} title={KIND_TITLE[kind]}>
      {kind}
    </span>
  );
}

/** The task an aux session is about, when it is about one (review, compact). */
export function runTaskId(r: Run): string | null {
  if (r.taskId) return r.taskId;
  return r.kind === 'review' || r.kind === 'compact' ? r.subjectId : null;
}

/** Where a click on the run's title goes. */
export function runLink(r: Run): { taskId: string } | { path: string } | null {
  const taskId = runTaskId(r);
  if (taskId) return { taskId };
  if (!r.subjectId) return null;
  if (r.kind === 'plan' || r.kind === 'plan-review') return { path: `/features/${r.subjectId}` };
  if (r.kind === 'chat') return { path: `/chat/${r.subjectId}` };
  if (r.kind === 'report') return { path: '/reports' };
  return null;
}

/** The row title: the task's for a worker, the session's own label otherwise. */
export function runTitle(r: Run, tasks: Task[]): string {
  if (r.mode === 'worker') return tasks.find((t) => t.id === r.taskId)?.title ?? `(${r.kind})`;
  return r.label ?? `(${r.kind})`;
}

/** The live reviewer terminal of a task, if one is running right now. */
export function liveReviewRun(runs: Run[], taskId: string): Run | undefined {
  return runs.find((r) => r.kind === 'review' && r.subjectId === taskId && r.status === 'running');
}
