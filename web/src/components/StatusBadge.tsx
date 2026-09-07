import type { ReviewState, TaskStatus } from '@tm/shared';

const cls: Partial<Record<TaskStatus, string>> = {
  running: 's-running',
  queued: 's-queued',
  published: 's-published',
  done: 's-done',
  review: 's-review',
  blocked: 's-blocked',
  failed: 's-failed',
};

/**
 * Status pill. Two synthetic readings sit on top of the real status, both
 * derived from server-owned fields rather than being statuses of their own
 * (docs/design.md § Adversarial review): `auto-review` while a task parked in
 * `review` is still being read by the adversarial reviewer, and `fixing` while
 * it is `running` on that reviewer's findings. `needs attention` is the third,
 * from the live run.
 */
export function StatusBadge({
  status,
  attention,
  question,
  reviewState,
}: {
  status: TaskStatus;
  attention?: boolean;
  /** the agent is waiting on an answer to its question (docs/questions.md) */
  question?: boolean;
  reviewState?: ReviewState | null;
}) {
  if (question) {
    return (
      <span className="badge s-attention" title="the agent asked you a question and is waiting for the answer">
        <span className="dot" /> asks you
      </span>
    );
  }
  if (attention) {
    return (
      <span className="badge s-attention">
        <span className="dot" /> needs attention
      </span>
    );
  }
  if (status === 'review' && (reviewState === 'pending' || reviewState === 'reviewing')) {
    return (
      <span className="badge s-autoreview" title="the adversarial reviewer is reading this change">
        <span className="dot" /> auto-review
      </span>
    );
  }
  if (status === 'running' && reviewState === 'fixing') {
    return (
      <span className="badge s-running s-fixing" title="the agent is fixing the adversarial reviewer's findings">
        <span className="dot" /> fixing
      </span>
    );
  }
  return (
    <span className={`badge ${cls[status] ?? ''}`}>
      <span className="dot" /> {status}
    </span>
  );
}
