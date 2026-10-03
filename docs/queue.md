# Custom queue

A second, human-curated queue next to the global one. The global queue is the
orchestrator's `orchestrator.enabled` switch plus every task in `queued`; it is
off and stays off for now. The custom queue is what **Add to queue** puts a task
into, and it has three properties the global queue does not:

1. **Independent of the global switch.** It runs whether `orchestrator.enabled`
   is true or false. Stopping the global queue never stops it; the only ways to
   stop it are to remove/cancel its members or to hit the worker cap.
2. **Strictly serial, and same-repo members wait for the predecessor's turn
   and review.** One task at a time — so one repo works at a time. Beyond
   that, a member whose repo has another member still *holding* it (`running`,
   `waiting`, `blocked`, or `review` with its automatic review round still open
   — `review_state` `pending|reviewing|fixing`) is not eligible: its findings
   are about to go back into a session in that checkout. Once the
   predecessor's review has settled (or it was never going to be reviewed) it
   sits in `review` for the human and **no longer holds the queue** — see
   [When the next member starts](#when-the-next-member-starts). Members of
   *other* repos may go ahead meanwhile. It still counts against
   `orchestrator.concurrency`, so with the global queue on it takes one of the
   two slots, never a third.
3. **FIFO by the click.** The order is the order tasks were added, not
   `priority`, not `created_at`. The board shows that order as `queue #n`.

## When the next member starts

(2026-09-28, `docs/decisions.md` "Review no longer holds the custom queue".)
A member's turn ends in `review` (unless auto-complete is on). While the
automatic adversarial review of that turn is open — `pending`, `reviewing`, or
a fix round (`fixing`, the task is `running` again) — the repo is still held,
and the stop-hook's in-process hold covers the seconds between the Stop and
the round (and an auto-publish turn). Once the review settles (`passed`,
`flagged`, `skipped`, `error`, or no review at all) the task **stays in
`review`** — it is not moved, completed or dequeued, and keeps its mark — but
the next same-repo member starts. So "queue five tasks for one repo, walk
away" runs all five back to back, each landing in your review column. The
board says which is which: `queue · in auto-review` while a member's round
still holds the repo, `queue · done here` once it is waiting for you and the
queue has moved on.

The next agent works in a checkout that still has the previous change in it,
so two rules keep each task's work its own — § Stacked tasks.

## Stacked tasks

(Review round 1 of the change above; user decision "hand-off commit + in
order".) Without these, B's reviewer would read A's uncommitted edits as B's,
and B's Publish (`git add -A` + `git push`) would ship A before you approved it.

**Hand-off commit.** Right before the custom queue claims a task, the pump
(`handOffCheckout`) looks at the repo's *tree owner* — the task whose worker
ran last there (`treeOwner`; publish turns, marked `label = 'publish'` on
their worker run row, never count: they edit nothing). If the tree is dirty
and that task is not working, the server commits the tree LOCALLY under the
owner's trailer. That covers `review`, and just as much a task an **Undo start** put
back in `queued`/`draft`, whose half-finished edits (review round 2) would
otherwise become the next task's; `failed`/`cancelled` owners are committed
too, so their leftovers never read as the next task's in its review (`git.ts` `handoffCommit`: `git add -A -- . ':!.claude/worktrees'`,
subject `Hand-off: <title>`, trailer `Task: <owner id>`, hooks run, never
pushed; audited `repo.changed {action:'handoff-commit', sha}`). So B starts on a
clean tree: its base is past A's work, and its review (trailer commits + the
uncommitted tree, which is now B's alone) sees only B. While the owner is
`running`/`waiting`, or its review round is still open, or when the commit
fails, nothing starts in that repo this pass; a failure is written on the owner's `error` once ("hand-off commit
failed, so the next queued task in this repo waits: …") and cleared by the next
successful hand-off.

**Publish in order** (`Orchestrator.publishPlan`, from `git.ts`
`unpushedCommits`: the unpushed commits oldest-first with their `Task:`
trailers). The tasks whose work is *unapproved* are those in
`review|running|waiting|blocked|queued|draft` (`UNAPPROVED_STATUSES`). `queued` and
`draft` cover a task an Undo start stopped part-way: its commits are unfinished
work. The refusal then says to run it to review first (Release / Run now).
Done/published work may ride along. Failed/cancelled leftovers are outside this
rule, as they were before it: there is no way to approve them short of a retry.
- **Refused** when an unapproved task's commit sits *under* this task's work.
  "This task's work" means up to its last unpushed commit, or everything when it
  owns the working tree. The reason is written on the task as `publish held:
  publish in order — "<A>" (review) has unpushed commits under this task's work
  … Publish or Mark done "<A>" first`, and audited `task.publish
  {phase:'refused'}`. Auto-publish discards publish's result, which is why the
  row carries it. A refused auto-publish stays in `review`: press Publish once
  the earlier task is out of the way. It is not retried automatically.
- **Partial** when unapproved work sits *on top* (later commits, or a tree a
  later unapproved task owns). The turn is `publishUpToInstruction` (a publish
  turn like `PUBLISH_INSTRUCTION`, recognised by `isPublishInstruction`). It runs
  `git push <remote> <sha>:<merge ref>` for this task's last commit, stages
  nothing, and only runs post-push steps that act on what was pushed, never a
  deploy from the local tree. Without a resumable session the server runs the
  same push itself (`pushUpTo`). A task whose commits are all pushed already
  settles at once. A stacked task with no commits of its own is refused, because
  its work would be the later task's tree. A partial publish needs a branch with
  an upstream, and is refused otherwise.
- **Full** otherwise: the ordinary publish, unchanged.

`settlePublish` recomputes the same plan from git rather than remembering it
(`publishedCheck`). A full publish is judged by `verifyPublished` (clean tree,
nothing ahead). A partial publish counts as published when none of the task's
own commits remain unpushed: the later tasks' commits and tree stay local on
purpose.

So with A in review and B stacked on it: Publish A first, which pushes exactly
A and leaves B local, then Publish B. Or Mark done A (you accept it without
shipping it), after which B's Publish ships both.

Limits: the hand-off runs on the custom queue's claim only. A global-queue claim
or a Run now in a repo whose last worker left uncommitted edits behaves as
before. A later turn on an OLDER task (Proceed, a dispatch) after a newer one
has started makes the older task the tree owner again, so its turn works on
top of the newer task's uncommitted edits.

## Undo start

**Undo start** (`POST /api/tasks/:id/undo`, task panel button beside Cancel,
Telegram ↩ card button and `/undo <id>`) stops a `running`/`waiting` task
WITHOUT cancelling or failing it: its live run is killed exactly as Cancel
kills it (marked `killed` first, so the exit handler leaves the task alone, and
a resume-gate compaction is aborted), and the task goes back to the status it
had before the turn — the `from` of its newest `task.transition` into
`running` that did not come from `running`/`waiting` (claims write that row
too). So a claimed task returns to `queued`, a Run now from draft to `draft`, a
follow-up or publish turn on a reviewed task to `review` (its verdict kept; a
`fixing` state is cleared, it described the dead turn). With no such row it
goes to `queued`.

Back in `queued` it keeps its place — the global sort key and the custom-queue
mark are untouched — but it is **held**: `tm_tasks.queue_held_at` (migration
31, `Task.queueHeldAt`) is set in the same conditional transition, and every
claim skips a held row (`claimNextQueuedTask`, `claimNextAgentChildTask`,
`CUSTOM_QUEUE_HEAD_WHERE`). Without it the queue would start the task again on
the very next pass. The hold only means anything in `queued`, so every other
status transition clears it (`transitionTask` in both drivers). It is released
by:

- **Release** (`POST /api/tasks/:id/release`, button in the panel, ▶ Release on
  the Telegram card, `/release <id>`) — stays where it is and becomes
  claimable; refused (409) while the stopped PTY is still shutting down;
- **Run now** — the transition to `running` clears it;
- **Add to queue** — on a held member, releases it in its old place; on a held
  global task, moves it to the back of the custom queue, released;
- **Enqueue** — releases it into the global queue (dropping a custom mark, as
  Enqueue always does).

Nothing in the working tree is reverted, and the next start is a fresh session
(the killed run is not resumed). If the queue starts another task in the same
repo meanwhile, the undone task's leftovers are first committed locally under
ITS trailer (§ Stacked tasks, hand-off), and a later task's Publish is refused
while those commits sit unpushed under it. Audit: `task.undo` rows,
`{action:'undo', from, to, held, killedRuns}` and `{action:'release', queue}`.
Undo is refused (409) for a task that is not `running`/`waiting`, or that left
`running` while the undo was killing it.

## Data

One nullable column, `tm_tasks.custom_queue_at` (`Task.customQueueAt`,
migration 16): set = member, its value = position. No status was added —
a member is an ordinary `queued` task with a mark, so every status rule
(cancel, delete, feature gates, boot recovery) applies unchanged.

The mark survives the task's turn (a member in `review` keeps it, whether or
not it still holds its repo) and is cleared in exactly three ways: any transition to a
**terminal** status (`published`/`done`/`failed`/`cancelled` — done inside
`transitionTask` in both drivers, so no mark outlives the work), **Remove from
queue**, and **Enqueue**/**Retry** (which mean the *global* queue). So a task
that was once queued and later followed-up into `review` cannot hold a repo
again unless you add it to the queue again — which stamps a fresh position.

## Claiming (`orchestrator.pumpCustomQueue`)

Runs at the top of every `maybeSchedule()` pass, **before** the
`orchestrator.enabled` check. It claims at most one task per pass, and only when:

- a worker slot is free (`activeWorkers() < concurrency`, PTY cap not hit);
- the head is not **held** by an Undo start (`queue_held_at IS NULL`);
- the head's repo has **no other member holding it** (`running`/`waiting`/
  `blocked`, or `review` with an open automatic round — the `heldBy` fragment
  of `CUSTOM_QUEUE_HEAD_WHERE`, JS twin `customQueueHoldsRepo` in shared) —
  such a member is skipped and the next eligible one, from another repo,
  becomes the head. A member whose review has settled sits in `review` without
  holding anything;
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
  when a same-repo task still holds the repo), `queue #n · held` after an Undo
  start (a global-queue task shows `held`), a pulsing `queue` chip while the
  member holds the slot, `queue · in auto-review` / `queue · in blocked` while
  a member still holds its repo's place, and `queue · done here` once it waits
  for you in review (`components/QueueMark.tsx`, `.chip.queue-chip` on
  accent/status tokens; the predicate is `customQueueHoldsRepo` in shared, twin
  of the SQL `heldBy`).
- Task panel: **Add to queue** / **Remove from queue** buttons beside Enqueue;
  **Undo start** beside Cancel on a running task; **Release** on a held one.
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
- 2026-09-28 (review no longer holds; Undo start): the same scratch-DB harness
  through the real driver and a stub-session `Orchestrator` — a same-repo
  member blocked by `review` + `pending|reviewing|fixing`, `running`,
  `waiting`, `blocked`, eligible behind `review` + `passed|flagged|null` and
  claimed while the predecessor stays in `review` with its mark; the filer
  clause likewise (and `failed` still holding); undo of a global claim →
  `queued`, held, same `sort_order`, run `killed`, not re-claimed until
  Release; undo of a custom claim keeps the mark and Add to queue releases it
  in place; Run now from draft → undo → `draft`; a resumed review task (through
  a `waiting` park) → undo → `review` with its verdict; Enqueue on a held
  member → global and released; undo refused off `running`; any other
  transition clears the hold; `task.undo` audited. Postgres untested.
- Not verified live: the running server predates this change and the
  agents-working rule refuses a restart while this task's own session is up.
  The routes and the pump go live at the next API start; Postgres path is
  untested (as before).

## Agent-filed members (2026-09-28)

A worker that picks up a shared-space request addressed to its own repo files
it straight into this queue (`POST /api/agent/shared/notes/:id/file`,
`docs/shared-spaces.md` § Filing). The request is recorded as the actor
`agent:<run8>`, like any queue add. The queue's own guards are what make that
safe: one member at a time, and a head whose repo has a live, non-idle worker
waits (`repoBusy`). That is **not** enough on its own. At its Stop the filer is
idle and parked in `review` with an uncommitted diff, and the filer is usually
not a member, so the member-only in-flight rule does not see it either (review
round 1). So a member with `created_by_run` set, meaning an agent created it,
gets one more clause in `CUSTOM_QUEUE_HEAD_WHERE`. It is skipped while its
filer (the task behind `created_by_run`, same repo) holds the repo by the
same `heldBy` test (`running`, `waiting`, `blocked`, or `review` with an open
round) or is `failed`. It is also skipped while ANY task in its repo, member
or not, holds it that way. A filed task therefore starts once its filer's
turn and automatic review are over — since 2026-09-28 a filer that merely
sits in `review` for the human no longer holds it (see [When the next member
starts](#when-the-next-member-starts)) — and nothing else in the repo is
working. Unrelated finished work waiting in `review` does not hold it.
Round 1's first fix held on every unresolved task in the repo, which on a
repo with a standing review column meant never (review round 2). Human-added
members keep the member-only rule; the human chose that order. The SPA's `customQueueBlocker` mirrors the clause, so the chip says
`waiting for <filer>`. Other repos' members go ahead meanwhile, as always.
