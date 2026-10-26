# Pause all — a safe, resumable stop for the whole machine

## The gap this closes

Updating the task manager means restarting it, and a restart is refused while
any agent works (the restart guard, `docs/host.md`). The tools for getting to
zero all lose work. The queue switch (`/off`) does not stop the custom queue,
loops, dispatches or wake-ups, and it leaves live turns running. Cancel,
`/killall` and stop-and-kill end those turns and cancel the queue. The custom
queue's order, the half-finished turns and the follow-ups in flight are gone,
and every task has to be put back by hand.

**One sentence: Pause all holds every automatic start and suspends every live
agent turn so that its own claude session resumes exactly there on Continue.
Nothing is cancelled, nothing loses its place.**

## State: one setting, one column

| where | what |
|---|---|
| `tm_config` `orchestrator.paused` | the switch. Machine state like `orchestrator.enabled`: changed only through `POST /api/orchestrator/pause` / `continue`, never `PUT /api/config` (the Config page strips it). It survives a restart, and that is the point. |
| `tm_tasks.paused_turn` (migration 40, `Task.pausedTurn`) | the turn Continue owes this task, JSON `PausedTurn`: `{ at, kind: 'resume' \| 'publish' \| 'land', message?, purpose?, auto? }`. null means nothing is owed. |

There is no new `TaskStatus`. A suspended task sits in `review` (the status a
resume accepts, as for a wake-up), and the SPA renders the synthetic
**paused** badge over it. The marker is released by **every** status
transition (`transitionTask`, both drivers, like `queue_held_at`), unless that
transition is the one setting it. A human who moves the task has taken it over,
and the resume itself releases the marker by moving the task to `running`.

## Pause

`Orchestrator.pauseAll(actor)` sets the flag **first**, because every gate
below reads it. Then it sweeps twice. Between the two sweeps it waits (≤15 s)
for compaction gates and fired dispatch turns to settle:

- **Live worker turns** (`running`/`waiting` with a live PTY) are ended the way
  the wake path ends a stall (`endStalledRun`, `docs/wake.md`). The run is
  marked `killed` **first**, which is what makes `handleExit` leave the task
  alone. Then the PTY is killed (with its subagents and background shells), a
  `run.killed { reason: 'paused' }` row is written, and the task moves
  `running|waiting → review` with `paused_turn {kind: 'resume'}`. A publish
  turn gets `{kind: 'publish', auto}` instead. A loop iteration becomes
  `loop_state: paused` through the same transition, and `followUp`'s rule
  resumes it as the same iteration.
- **Resume gates mid-compaction** are aborted (`abortCompaction`). The gate's
  abort branch sees the flag and parks the task with the turn it was about to
  start: `{kind: 'resume', message: <the follow-up>}`. The message is kept, so
  a review-fix, check-fix, transient or human follow-up is delivered on
  Continue rather than lost. A dispatch turn gets no marker, because its
  messages stay pending and are redelivered (a marker would deliver them
  twice).
- **Review rounds in flight** (aux `review` sessions) are aborted. When
  `runReviewRound` sees the pause and a cut-short or fix-bound verdict, it
  records nothing and puts the row back to `pending`. The diff hash was never
  written, so Continue runs a real round.
- **Transient back-offs**: a terminal still in its turn is suspended as above.
  One whose terminal already died (the task is in review/failed, waiting for
  the `--resume`) is marked `{kind: 'resume'}`.
- **Not touched**:
  - Idle sessions of tasks already in `review`. They do not block a restart.
  - Repo commands and dev servers, and the `/terminals` shells.
  - Chats, reports and feature planning sessions. These are human-started aux
    terminals. The restart guard still lists them; finish or stop them, or
    force the restart.
  - A loop between iterations (`next`/`checking`). It has no session; the loop
    pump is held, so `next` simply waits.

Pressing Pause again only sweeps again (idempotent).

## Held while paused

Every automatic way a turn starts checks the flag:

| path | while paused |
|---|---|
| `maybeSchedule` | returns before anything runs: the custom-queue pump, the loop pump, the global and overflow claims, dispatch delivery. Queued tasks keep their place and their custom-queue mark. |
| `wakeSweep` | parks stalls as before, but wakes nothing. `wake_at` stays and fires after Continue. |
| `fireTransient` / `resumeTransient` | the turn is owed to Continue instead (`pauseTransient`) |
| `reviewLoop` | starts no check stage and no review round. The row keeps `pending`, and Continue re-runs it. A settled task that its tier would land on its own (`landingReason` holds) is marked `{kind: 'land'}` (`deferLanding`), because nothing else would look at it again. |
| check fix turn (`runCheckStage`) | not typed. `check_state` goes back to `pending`, so Continue re-runs the checks and then types the failure. |
| review fix turn (`runReviewRound`) | not sent; the round is not recorded (see above) |
| auto-publish (`landIfClean`) | marked `{kind: 'land'}`; Continue runs the landing again, budget and verdict re-read. An `on-green` landing still happens: it starts no agent. |
| `followUp` | backstop: any non-human actor gets 409 `the task manager is paused`, and the caller keeps its own refusal path |
| `startWorker` | backstop after the resume gate's re-read, for a turn that passed its check just before the flag went up. A resume is parked with its turn (as above). A fresh claim goes back to `queued`, keeping its place and mark. A loop's next iteration stays `running`+`next`. |
| boot recovery | a worker run found `running` is owed (`review` + marker) instead of `failed`, and so is a stranded `running` task that ever had a worker. Verify rounds are not re-run until Continue. |
| `reviewNow` | 409. A reviewer is an automatic session, and the human asks again after Continue. |
| starvation anomaly | off: queued tasks are held on purpose |

**Human clicks still work** (`HUMAN_ACTORS` = `human`, `telegram`): Run now,
Proceed, Follow up, Apply fixes and Publish start a turn while paused. That is
a deliberate exception for one task, not a way around the pause. Such a turn's
Stop still lands `review` with its verify round left `pending` for Continue.

## Continue

`Orchestrator.continueAll(actor)` clears the flag, then:

1. **Every marked task gets its turn, in its own session.** Oldest marker
   first, fired concurrently:
   - `resume` without a message → `proceed(…, PAUSE_PROCEED)`. That is
     `claude --resume <its session>`, with a prompt saying the turn was cut by
     a pause, not finished, and to re-check state before carrying on.
   - `resume` with a message → `followUp(message)`.
   - `publish` → `publish()` again. Git decides the landing, as always.
   - `land` → `landIfClean()`.

   A resume that cannot start (no transcript left on disk, a human took the
   task) releases the marker and writes the reason on the row
   (`Continue could not resume this task: …`). Every outcome is a `task.paused`
   audit row. A Pause pressed again before a resume ran leaves the marker for
   the next Continue.
2. **Verify rounds the pause held** are re-run with boot recovery's rule
   (`resumeVerifyRounds`): reviews in `pending|reviewing`, and checks in
   `pending|running` on `review`. Marked tasks are skipped, because their own
   Stop marks the round again.
3. **The queues**: `maybeSchedule()`.

**The marked tasks hold their repos** until their resume is under way, so the
claim loop that Continue wakes cannot start another task on top of the work.
That hold is enforced in three places:

- **SQL**: `paused_turn IS NOT NULL` in `heldBy` and `REPO_EXCLUSIVE_GATE`, plus
  a clause in `CUSTOM_QUEUE_HEAD_WHERE` for non-member owners
  (`storage/queue-sql.ts`). The JS twins are `holdsRepoForClaim`,
  `customQueueHoldsRepo` and the SPA's `customQueueBlocker`; edit them
  together.
- **In memory**, between the marker's release and a live PTY (a compaction gate
  can take minutes): `pauseResumesInFlight` (taskId → repoId). The custom-queue
  pump skips those repos, and `activeWorkers()` counts them as slots on their
  way.
- **After that**, the task is `running`, and the existing rules apply.

All owed tasks resume at once, not throttled by `orchestrator.concurrency`:
they were all running when the pause was pressed.

## Restart while paused

Pause, wait for the header's **Restart server** to enable (it counts worker and
aux sessions), then restart. The flag and the markers are rows, so the new
process comes up paused. Boot recovery treats anything it finds cut as owed
(see the table), and nothing starts until Continue. If the process dies after
Continue cleared the flag but before every owed turn started, boot finishes the
job (`resumePaused` when unpaused rows still carry a marker).

## Surfaces

- **SPA**: a `⏸ Pause all` button beside the queue switch in the desktop
  header, and in the phone's More sheet. While paused it reads
  `▶ Continue (n)`, where n is the number of tasks Continue resumes. Both
  directions take a second press (`useArm`): pausing ends live terminals, and
  continuing spends money again. The task badge reads **paused**. The restart
  button's "agents working" tooltip points at Pause all.
- **REST**: `POST /api/orchestrator/pause` → status + `suspended[]`;
  `POST /api/orchestrator/continue` → status + `resumed[]`. Both need `Origin`
  (403 otherwise): a worker's curl must not pause, and so kill, every other
  session, nor un-pause a machine the human stopped. `OrchestratorStatus`
  gains `paused` and `pausedTasks`.
- **Telegram**: `/pause` and `/continue` (`setPaused` in `telegram/actions.ts`).
  The board's status line shows `⏸ paused (n to resume)`.
- **Notifications**: the review ping (Telegram and Web Push) skips a marked
  task, which is not ready for anyone. The Inbox leaves it out of its review
  rows.

## Knowingly left

- **A loop in `checking`** whose checks were still running at a restart is
  paused by boot recovery as before (`review` + `loop_state: paused`). Continue
  does not restart it; Continue on the loop does.
- **Background shells and subagents** die with the suspended PTY. The resumed
  session is told to re-check what it was running. Dev servers started through
  the repo-commands API are not touched.
- **A question pending in a suspended turn** expires with it (`handleExit`).
  The agent asks again after the resume.

## Verification

A throwaway harness drove a real `Orchestrator` and real SQLite storage over
two temp git repos, with a real PTY standing in for claude. It is not in the
repo (no test framework yet); see the task's artifacts. 31 assertions:

- Pause kills the PTY, marks the run `killed` and parks the task in `review`
  with a `resume` marker. The killed PTY's exit leaves the task alone.
- The flag persists, and status reports `paused` with 1 task owed.
- `maybeSchedule` starts nothing. The custom-queue member keeps its place and
  mark, and the global queued task stays queued.
- An automatic `followUp` and Review now both get 409.
- The marker holds its repo in the JS twins and in both SQL claims, while the
  other repo stays claimable.
- `startWorker` reached by a claim while paused returns the task to `queued`
  and spawns nothing. An edit keeps the marker.
- Boot recovery while paused leaves a cut run owed, not `failed`.
- Continue resumes every owed task through `proceed` with the pause message,
  and a same-repo custom-queue member does not start while a slow resume is in
  flight. The flag and markers are cleared.
- A refused resume releases the marker and writes the reason on the row.
- `npm run typecheck` and `npm run build` are clean.
