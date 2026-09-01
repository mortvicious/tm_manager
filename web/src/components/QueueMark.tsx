import { CUSTOM_QUEUE_IN_FLIGHT_STATUSES, customQueueWaiting, type Task } from '@tm/shared';

/**
 * Members of the custom queue (docs/queue.md) that are still waiting, in the
 * order they will run: FIFO by the moment each was added. The server orders
 * the same way (storage/queue-sql.ts), so the position shown is the position
 * the orchestrator will honour — except that a member whose repo has another
 * member in flight is skipped over until that one is resolved (see below).
 *
 * The implementation moved to `@tm/shared` so the Telegram bot's `/task` and
 * `/queue` compute the SAME ordinal; re-exported here because the board and
 * the Queue page have always imported it from this module.
 */
export { customQueueWaiting };

/** The same-repo member this waiting member is blocked behind, if any. */
export function customQueueBlocker(task: Task, tasks: Task[]): Task | undefined {
  if (!task.repoId) return undefined;
  return tasks.find(
    (o) =>
      o.id !== task.id &&
      o.repoId === task.repoId &&
      !!o.customQueueAt &&
      CUSTOM_QUEUE_IN_FLIGHT_STATUSES.includes(o.status),
  );
}

/**
 * The queue sign on a board row: `queue #n` while the task waits its turn
 * (plus what it is waiting for when a same-repo member is still in flight),
 * a pulsing `queue` while it holds the queue's single slot, and `queue · in
 * review` while a finished member still holds its repo's place — the state
 * an unattended same-repo sequence parks in unless auto-publish is on.
 */
export function QueueMark({ task, tasks }: { task: Task; tasks: Task[] }) {
  if (!task.customQueueAt) return null;
  if (task.status === 'running') {
    return (
      <span className="chip queue-chip working" title="custom queue — this task holds the queue's single slot">
        <span className="dot" /> queue
      </span>
    );
  }
  if (task.status === 'review' || task.status === 'blocked') {
    return (
      <span
        className="chip queue-chip holding"
        title={`custom queue — finished but not shipped: it still holds its repo's place, so queued tasks from the same repo wait until you Publish, Mark done, or Remove it from the queue`}
      >
        queue · in {task.status}
      </span>
    );
  }
  if (task.status !== 'queued') return null;
  const pos = customQueueWaiting(tasks).findIndex((t) => t.id === task.id) + 1;
  const blocker = customQueueBlocker(task, tasks);
  return (
    <span
      className="chip queue-chip"
      title={
        blocker
          ? `custom queue — position ${pos}; waiting for "${blocker.title}" (${blocker.status}) in the same repo to be published, marked done, or removed from the queue`
          : `custom queue — position ${pos}; runs one task at a time, even while the global queue is stopped`
      }
    >
      queue #{pos}
      {blocker && <span className="waiting"> · waiting for {blocker.title}</span>}
    </span>
  );
}
