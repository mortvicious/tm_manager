import type { ReviewState, TaskStatus } from '@tm/shared';

const cls: Partial<Record<TaskStatus, string>> = {
  running: 's-running',
  waiting: 's-waiting',
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
  onOpenReviewer,
}: {
  status: TaskStatus;
  attention?: boolean;
  /** the agent is waiting on an answer to its question (docs/questions.md) */
  question?: boolean;
  reviewState?: ReviewState | null;
  /** set while the reviewer's terminal is live: the auto-review badge opens it */
  onOpenReviewer?: () => void;
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
    // The reviewer is a terminal of its own (docs/design.md § PTY sessions):
    // while it is live the badge is the way in.
    if (onOpenReviewer) {
      return (
        <button
          type="button"
          className="badge s-autoreview badge-link"
          title="the adversarial reviewer is reading this change — open its terminal"
          onClick={(e) => {
            e.stopPropagation();
            onOpenReviewer();
          }}
        >
          <span className="dot" /> auto-review ↗
        </button>
      );
    }
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
  if (status === 'waiting') {
    return (
      <span
        className="badge s-waiting"
        title="the agent ended its turn with a background subagent still running — it resumes on its own when that child returns"
      >
        <span className="dot" /> waiting
      </span>
    );
  }
  return (
    <span className={`badge ${cls[status] ?? ''}`}>
      <span className="dot" /> {status}
    </span>
  );
}
