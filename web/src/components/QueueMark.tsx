import { customQueueHoldsRepo, customQueueWaiting, type Run, type Task } from '@tm/shared';
import { useApp } from '../state.tsx';

/**
 * Members of the custom queue (docs/queue.md) that are still waiting, in the
 * order they will run: FIFO by the moment each was added. The server orders
 * the same way (storage/queue-sql.ts), so the position shown is the position
 * the orchestrator will honour — except that a member whose repo is still held
 * by another task, or that an Undo start holds, is skipped over (see below).
 *
 * The implementation moved to `@tm/shared` so the Telegram bot's `/task` and
 * `/queue` compute the SAME ordinal; re-exported here because the board and
 * the Queue page have always imported it from this module.
 */
export { customQueueWaiting };

/**
 * The same-repo task this waiting member is blocked behind, if any: another
 * member that still holds the repo (`customQueueHoldsRepo` — working, blocked,
 * or in review with an automatic round still open; a settled review does not
 * hold) — or, for a member an agent created (a filed request), its filer
 * while it holds the repo or is `failed`, or any task in its repo that holds
 * it. JS twin of CUSTOM_QUEUE_HEAD_WHERE (storage/queue-sql.ts) — edit them
 * together. `runs` maps the member's `createdByRun` to its filer; without the
 * run the filer clause is skipped.
 */
export function customQueueBlocker(task: Task, tasks: Task[], runs: Run[] = []): Task | undefined {
  if (!task.repoId) return undefined;
  const sameRepo = (o: Task) => o.id !== task.id && o.repoId === task.repoId;
  const member = tasks.find((o) => sameRepo(o) && !!o.customQueueAt && customQueueHoldsRepo(o));
  if (member || !task.createdByRun) return member;
  const filerId = runs.find((r) => r.id === task.createdByRun)?.taskId;
  const filer = filerId
    ? tasks.find((o) => o.id === filerId && sameRepo(o) && (o.status === 'failed' || customQueueHoldsRepo(o)))
    : undefined;
  return filer ?? tasks.find((o) => sameRepo(o) && customQueueHoldsRepo(o));
}

/**
 * The queue sign on a board row: `queue #n` while the task waits its turn
 * (plus what it is waiting for when a same-repo task still holds the repo),
 * `queue #n · held` after an Undo start, a pulsing `queue` while it holds the
 * queue's single slot, `queue · in review` while its automatic review round
 * still holds the repo (or `blocked` on its children), and `queue · done
 * here` once it sits in review for the human — the queue has moved on.
 */
export function QueueMark({ task, tasks }: { task: Task; tasks: Task[] }) {
  const { runs } = useApp();
  if (!task.customQueueAt) {
    // A global-queue task an Undo start put back: same sign, no position.
    return task.status === 'queued' && task.queueHeldAt ? (
      <span
        className="chip queue-chip holding"
        title="queued, held by Undo start: the queue skips it until you Release it (or Run now)"
      >
        held
      </span>
    ) : null;
  }
  if (task.status === 'running' || task.status === 'waiting') {
    return (
      <span className="chip queue-chip working" title="custom queue — this task holds the queue's single slot">
        <span className="dot" /> queue
      </span>
    );
  }
  if (task.status === 'review' || task.status === 'blocked') {
    return customQueueHoldsRepo(task) ? (
      <span
        className="chip queue-chip holding"
        title={
          task.status === 'blocked'
            ? `custom queue — blocked on its subtasks: it still holds its repo's place, so queued tasks from the same repo wait`
            : `custom queue — its automatic review is still open: queued tasks from the same repo wait until the review settles`
        }
      >
        queue · in {task.status === 'review' ? 'auto-review' : task.status}
      </span>
    ) : (
      <span
        className="chip queue-chip"
        title="custom queue — finished and waiting for you in review; the queue has moved on. Its leftovers were committed locally under its own Task trailer before the next task started, and publishing goes in order: Publish (or Mark done) this one before a later task in the same repo can publish"
      >
        queue · done here
      </span>
    );
  }
  if (task.status !== 'queued') return null;
  const pos = customQueueWaiting(tasks).findIndex((t) => t.id === task.id) + 1;
  if (task.queueHeldAt) {
    return (
      <span
        className="chip queue-chip holding"
        title={`custom queue — position ${pos}, held by Undo start: the queue skips it until you Release it (or Run now)`}
      >
        queue #{pos} · held
      </span>
    );
  }
  const blocker = customQueueBlocker(task, tasks, runs);
  return (
    <span
      className="chip queue-chip"
      title={
        blocker
          ? `custom queue — position ${pos}; waiting for "${blocker.title}" (${blocker.status}) in the same repo to finish its turn and review`
          : `custom queue — position ${pos}; runs one task at a time, even while the global queue is stopped`
      }
    >
      queue #{pos}
      {blocker && <span className="waiting"> · waiting for {blocker.title}</span>}
    </span>
  );
}
