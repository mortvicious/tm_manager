import type { TaskStatus } from '@tm/shared';

const cls: Partial<Record<TaskStatus, string>> = {
  running: 's-running',
  queued: 's-queued',
  done: 's-done',
  review: 's-review',
  blocked: 's-blocked',
  failed: 's-failed',
};

export function StatusBadge({ status, attention }: { status: TaskStatus; attention?: boolean }) {
  if (attention) {
    return (
      <span className="badge s-attention">
        <span className="dot" /> needs attention
      </span>
    );
  }
  return (
    <span className={`badge ${cls[status] ?? ''}`}>
      <span className="dot" /> {status}
    </span>
  );
}
