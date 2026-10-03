// Custom-queue SQL fragments shared VERBATIM by both drivers (docs/queue.md),
// the same arrangement as feature-sql.ts: dialect-neutral, no `?` placeholders,
// fixed `tm_` prefix. Both drivers must agree on what "the head of the custom
// queue" and "the custom queue is busy" mean, or SQLite and Postgres would
// serialize differently.

/**
 * "This task still holds its repo's place" (docs/queue.md § When the next
 * member starts), over a row aliased `a`: it is working (`running`/`waiting`,
 * which also covers a turn inside the resume gate with no live PTY yet),
 * `blocked` on its split children, or in `review` with an automatic review
 * round still open (review_state pending/reviewing/fixing — its findings are
 * about to be typed back into a session in this checkout).
 *
 * Finished work that merely sits in `review` for the human does NOT hold it
 * (decisions.md 2026-09-28, "Review no longer holds the custom queue"): the
 * task stays in `review`, keeps its mark, and the next member starts on top of
 * its tree. That is a deliberate trade — the next agent works in a checkout
 * with the previous change still in it (committed or not), and a Publish of the
 * first task while the next one is running will not find a clean tree.
 * JS twin: `customQueueHoldsRepo` in shared/src/types.ts — edit together.
 */
const heldBy = (a: string) =>
  `(${a}.status IN ('running', 'waiting', 'blocked')
      OR (${a}.status = 'review' AND ${a}.review_state IN ('pending', 'reviewing', 'fixing')))`;

/**
 * Selects the head of the custom queue: the oldest-added queued task that is
 * a member (`custom_queue_at` set), has a repo, is not held by an Undo start
 * (`queue_held_at`, docs/queue.md § Undo start), passes the feature phase
 * gate, AND whose repo has no other member still holding it (`heldBy`), while
 * members of OTHER repos may go ahead. Priority is deliberately NOT consulted
 * — the custom queue is a FIFO of what the human added.
 *
 * A member an AGENT created (`created_by_run` set — a request filed through
 * the shared ledger, docs/shared-spaces.md § Filing) waits for more:
 *  - for its FILER (the task behind `created_by_run`, same repo) to stop
 *    holding the repo — or to be `failed`: a filer that crashed after filing
 *    may have left its edits behind, and a retry or cancel resolves it.
 *  - for ANY task in the repo, member or not, that holds it by the same
 *    `heldBy` test (a global-queue filer's open review round included).
 * The caller interpolates the gate; expects the candidate row aliased `t`.
 */
export const CUSTOM_QUEUE_HEAD_WHERE = `t.status = 'queued' AND t.repo_id IS NOT NULL AND t.custom_queue_at IS NOT NULL
  AND t.queue_held_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM tm_tasks o
    WHERE o.repo_id = t.repo_id AND o.id <> t.id AND o.custom_queue_at IS NOT NULL
      AND ${heldBy('o')}
  )
  AND (t.created_by_run IS NULL OR (
    NOT EXISTS (
      SELECT 1 FROM tm_runs r JOIN tm_tasks f ON f.id = r.task_id
      WHERE r.id = t.created_by_run AND f.id <> t.id AND f.repo_id = t.repo_id
        AND (f.status = 'failed' OR ${heldBy('f')})
    )
    AND NOT EXISTS (
      SELECT 1 FROM tm_tasks a
      WHERE a.repo_id = t.repo_id AND a.id <> t.id
        AND ${heldBy('a')}
    )
  ))`;

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
