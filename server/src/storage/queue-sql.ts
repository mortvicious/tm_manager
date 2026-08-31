// Custom-queue SQL fragments shared VERBATIM by both drivers (docs/queue.md),
// the same arrangement as feature-sql.ts: dialect-neutral, no `?` placeholders,
// fixed `tm_` prefix. Both drivers must agree on what "the head of the custom
// queue" and "the custom queue is busy" mean, or SQLite and Postgres would
// serialize differently.

/**
 * Selects the head of the custom queue: the oldest-added queued task that is
 * a member (`custom_queue_at` set), has a repo, passes the feature phase gate,
 * AND whose repo has no other member still in flight. "Tasks from the same
 * repo wait": a member that finished its turn but has not been shipped or
 * closed (`review`, or `blocked` on children) still owns its repo's working
 * tree — starting the next member there would put its edits into the first
 * one's review diff and its half-done tree into the first one's publish
 * commit. So a same-repo member is skipped until its predecessor is resolved
 * (`published`/`done`/`failed`/`cancelled`, or removed from the queue), while
 * members of OTHER repos may go ahead. Priority is deliberately NOT consulted
 * — the custom queue is a FIFO of what the human added.
 * The caller interpolates the gate; expects the candidate row aliased `t`.
 */
export const CUSTOM_QUEUE_HEAD_WHERE = `t.status = 'queued' AND t.repo_id IS NOT NULL AND t.custom_queue_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM tm_tasks o
    WHERE o.repo_id = t.repo_id AND o.id <> t.id AND o.custom_queue_at IS NOT NULL
      AND o.status IN ('running', 'review', 'blocked')
  )`;

// JS twin of the in-flight predicate above: CUSTOM_QUEUE_IN_FLIGHT_STATUSES in
// shared/src/types.ts (the board uses it to say what a member is waiting for).
export const CUSTOM_QUEUE_HEAD_ORDER = `ORDER BY t.custom_queue_at, t.created_at LIMIT 1`;

/**
 * "No custom-queue member is working right now." A member's status is
 * `running` from claim (or run-now) until its turn ends, including every
 * adversarial-review fix round and the publish turn, so this is the one
 * predicate that makes the queue strictly serial. The gap between a Stop hook
 * and the next resumed turn (status `review`) is covered in-process by the
 * orchestrator's hold set, not here.
 */
export const CUSTOM_QUEUE_IDLE = `NOT EXISTS (
  SELECT 1 FROM tm_tasks w WHERE w.status = 'running' AND w.custom_queue_at IS NOT NULL
)`;
