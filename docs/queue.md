# Custom queue

A second, human-curated queue next to the global one. The global queue is the
orchestrator's `orchestrator.enabled` switch plus every task in `queued`; it is
off and stays off for now. The custom queue is what **Add to queue** puts a task
into, and it has three properties the global queue does not:

1. **Independent of the global switch.** It runs whether `orchestrator.enabled`
   is true or false. Stopping the global queue never stops it; the only ways to
   stop it are to remove/cancel its members or to hit the worker cap.
2. **Strictly serial, and same-repo members wait for the whole predecessor.**
   One task at a time — so one repo works at a time. Beyond that, a member
   whose repo has another member still *in flight* (`running`, `review`, or
   `blocked`) is not eligible at all: a finished-but-unshipped task still owns
   its working tree, and starting the next one there would leak its edits into
   the first one's review diff and its half-done tree into the first one's
   publish commit. The same-repo member waits until the predecessor is
   `published`/`done`/`failed`/`cancelled` — or removed from the queue — while
   members of *other* repos may go ahead of it. It still counts against
   `orchestrator.concurrency`, so with the global queue on it takes one of the
   two slots, never a third.
3. **FIFO by the click.** The order is the order tasks were added, not
   `priority`, not `created_at`. The board shows that order as `queue #n`.

## Running a same-repo sequence unattended

A member's turn ends in `review` (unless auto-complete is on), and a member in
`review` still holds its repo's place: the next same-repo member does **not**
start until you Publish, Mark done, or Remove the first one. So "queue five
tasks for one repo, turn the global queue off, walk away" runs the first task
and then **waits for you** — the board says so (`queue #1 · waiting for <task>`
on the waiting row, `queue · in review` on the one holding the repo). To run
the whole sequence without a human in the loop, turn on **auto-publish** on
each task (ships it, releases the repo) or the global **auto-complete**
setting (lands it in `done`). Members of *other* repos are never held up by
this; they run in between.

## Data

One nullable column, `tm_tasks.custom_queue_at` (`Task.customQueueAt`,
migration 16): set = member, its value = position. No status was added —
a member is an ordinary `queued` task with a mark, so every status rule
(cancel, delete, feature gates, boot recovery) applies unchanged.

The mark survives the task's turn (a member in `review` still holds its repo's
place, see below) and is cleared in exactly three ways: any transition to a
**terminal** status (`published`/`done`/`failed`/`cancelled` — done inside
`transitionTask` in both drivers, so no mark outlives the work), **Remove from
queue**, and **Enqueue**/**Retry** (which mean the *global* queue). So a task
that was once queued and later followed-up into `review` cannot hold a repo
again unless you add it to the queue again — which stamps a fresh position.

## Claiming (`orchestrator.pumpCustomQueue`)

Runs at the top of every `maybeSchedule()` pass, **before** the
`orchestrator.enabled` check. It claims at most one task per pass, and only when:

- a worker slot is free (`activeWorkers() < concurrency`, PTY cap not hit);
- the head's repo has **no other member in flight** (`running`/`review`/
  `blocked`, part of `CUSTOM_QUEUE_HEAD_WHERE`) — such a member is skipped and
  the next eligible one, from another repo, becomes the head. A member parked
  in `review` therefore holds its repo's place in the queue until you Publish,
  Mark done, or Remove it from the queue;
- **no member is `running`** — enforced inside the claim statement
  (`CUSTOM_QUEUE_IDLE` in `storage/queue-sql.ts`, shared verbatim by both
  drivers), so a second member can never be claimed while the first is `running`
  from any path, including a human **Run now** on a member;
- no member is **held**: a member's turn ends with the Stop hook (`running` →
  `review`), and its adversarial-review fix round or auto-publish turn may
  reopen it seconds later (`followUp` → `running`). In that gap `review` is not
  `running`, so the stop-hook route parks the task in `customQueueHold` before
  the transition and releases it when the follow-on (`reviewCompletedRun`,
  `publish`, `settlePublish`) has resolved — release wakes the scheduler. The
  hold cannot leak: the route releases in a `finally` on every path that does
  not hand off to a follow-on, a hold only counts while its task is a member
  sitting in `review`, and one older than 30 minutes is dropped with a
  `console.warn` (`CUSTOM_QUEUE_HOLD_TTL_MS`);
- the head's repo has **no other live non-idle session** (`repoBusy`): a run-now
  or dispatch turn in that repo makes the head *wait*, never skip. The order the
  human set is the order that runs.

The global loop (`claimNextQueuedTask`) and the overflow claim
(`claimNextAgentChildTask`) both carry `AND t.custom_queue_at IS NULL`, so a
member is invisible to them even when the global queue is on. The feature phase
gate (`FEATURE_CLAIM_GATE`) applies to the custom head as well.

## API

- `POST /api/tasks/:id/queue` — Add to queue. Same guards as enqueue (repo
  assigned, no live session, from `draft|failed|cancelled|review`); a task
  already `queued` for the global queue moves over. The mark is written
  **before** the status transition so the global loop can never claim the row
  in between; a refused transition rolls the mark back. 409 if already a member.
- `POST /api/tasks/:id/unqueue` — Remove from queue. A waiting member is
  cancelled (the same thing the global "Remove from queue" does); a member that
  already ran just drops its mark. 409 if not a member.
- `enqueue`/`retry` clear the mark (they mean the global queue) — only after the
  status guard has passed, so a refused call leaves a waiting member exactly
  where it was; a lost race restores the mark and broadcasts.
- The generic `PATCH` does not accept `customQueueAt` (`.strict()`), by design.
- Audit: `task.queue` events with `{queue:'custom', action:'add'|'remove'}`;
  claims log `task.transition` with `claim:'custom-queue'`.

## UI

- Board row / every `TaskRow`: a queue quick action (list icon) — "Add to
  queue" or, on a waiting member, "Remove from queue" (×). The **queue sign**
  sits right after the title: `queue #n` while waiting (`· waiting for <task>`
  when a same-repo member is still in flight), a pulsing `queue` chip while the
  member holds the slot, `queue · in review` while a finished member still
  holds its repo's place (`components/QueueMark.tsx`, `.chip.queue-chip` on
  accent/status tokens; the in-flight list is `CUSTOM_QUEUE_IN_FLIGHT_STATUSES`
  in shared, twin of the SQL predicate).
- Task panel: **Add to queue** / **Remove from queue** buttons beside Enqueue.
- Queue page: a **Queue** section listing members in run order above the
  global queue.

## Verification

- `npm run typecheck`, `npm run build` clean.
- Storage semantics exercised against a scratch SQLite DB through the real
  driver (migration 16, FIFO by mark not `created_at`, global claim skipping
  members, second custom claim refused while one is `running`, run-now'd member
  blocking the queue, a same-repo member waiting while its predecessor sits in
  `review` while an other-repo member proceeds, repo-less member never a head,
  cleared mark returning the row to the global loop, terminal transitions
  clearing the mark, row-mapper round trip).
- Not verified live: the running server predates this change and the
  agents-working rule refuses a restart while this task's own session is up.
  The routes and the pump go live at the next API start; Postgres path is
  untested (as before).
