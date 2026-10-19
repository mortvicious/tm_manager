# Loop tasks (autonomy 6/6)

A loop task is for work that is "iterate until X" over many sessions: "get
coverage of `server/src/storage` to 80%", "fix every `tsc --strict` error in
web/". It carries a **goal**, the **checks** that judge it, a **maximum number
of iterations** and its own **budget**, and the server runs it as a series of
FRESH worker sessions over a progress ledger until the goal is met or a limit
is hit. Decision log: `docs/decisions.md` 2026-10-19 (loop tasks).

**Why fresh sessions, not one resumed session** (the user's decision): a
`--resume` re-buys the whole conversation before it says a word, about $15 on a
long session (`docs/token-budget.md`), and that cost grows with every
iteration. A fresh session over a short ledger costs the same every time.

## The task

`kind: 'loop'` (`tm_tasks.kind`, migration 37; default `'task'`; **create-only**,
the PATCH schema has no `kind`).

| field | column | rule |
|---|---|---|
| `loopGoal` | `loop_goal` | required, ≤ 4000 chars |
| `checks` | `checks` (existing) | the subset of the repo's checks (`docs/checks.md`); null = all, [] = none |
| `loopMaxIterations` | `loop_max_iterations` | 1..`LOOP_MAX_ITERATIONS_LIMIT` (30), default `LOOP_DEFAULT_MAX_ITERATIONS` (5) |
| `loopBudgetUsd` | `loop_budget_usd` | required, > 0 |
| `loopIteration` | `loop_iteration` | iterations STARTED (the n of the current or last one) |
| `loopState` | `loop_state` | `LoopState`, see below |
| `loopHistory` | `loop_history` | JSON `LoopIteration[]`, one per ended iteration |

`loopProblem()` (`task-actions.ts`) validates create and edit for REST (and
any future surface): a loop needs a repo, a goal and a budget; the loop fields
on a plain task are a 400. **Creating a loop, or setting its budget or
iterations, needs `Origin`** (403 `loop tasks and their budgets are set from the
dashboard`): these are ceilings the server spends against on its own, like a
landing tier, and a worker's curl has no Origin. Continue needs it too.

## No new TaskStatus

Between iterations the task stays `running`; where the loop stands is
`loop_state`, rendered as synthetic badges (`StatusBadge`):

| `loopState` | status | meaning | badge |
|---|---|---|---|
| `iterating` | running (or waiting) | an iteration's worker session is live | running |
| `checking` | running | the iteration ended; the server commits leftovers, runs the checks, decides | **loop checks** |
| `next` | running | another iteration is due and waits for a worker slot | **next iteration** |
| `met` | review → done/published | checks green and the agent says the goal is met | — |
| `max-iterations` / `budget` / `no-progress` | review | stopped short | — (the reason is the row's `error`) |
| `paused` | review / failed / cancelled | a human was needed, or the loop was interrupted | — |
| `error` | review | the iteration could not be judged (git or a throw) | — |

**Invariant**: an in-flight state (`iterating|checking|next`) exists only while
the task is `running` (or `waiting`, for `iterating`). `transitionTask` in both
drivers writes `LOOP_LEAVES_RUNNING_SQL` (`storage/loop-sql.ts`) on any move
out of `running`/`waiting` that does not set `loopState` itself, which turns an
in-flight state into `paused`. So a cancel, Undo, budget refusal, exit, usage
park or boot sweep can never leave the pump a cancelled task to start.

Loop-state writes while the task is running go through the conditional
composite `stepLoop(id, from, patch)` (status `running`, `kind = 'loop'`,
`loop_state IN from`), shared SQL in `storage/loop-sql.ts`. A cancel that wins
a race leaves the step a no-op.

## An iteration

```
start (claim · Run now · Retry · custom queue · loop pump)
  └─ startWorker → beginLoopIteration: from `next` n+1, else a FRESH loop (n = 1, history cleared)
       fresh prompt: task + "## Loop — iteration n of max" (goal, definition of done,
       ledger, last 5 iterations, last check results) … standing rules, trailer, ship gate,
       "## Loop result (required)" LAST
  └─ the agent works, rewrites $TM_ARTIFACTS_DIR/progress.md, commits locally (Task trailer)
Stop hook (not waiting, not publish) ─ isLoopIterationStop → loopIterationStopped
  └─ stepLoop iterating → checking (task stays running), run idled, PTY killed + awaited
  └─ settleLoopIteration (off the hook path, single-flight per task)
       parseLoopResult(last message)        goalMet + one-line note (none → not met)
       loopNeededHuman(run)                 a tm_questions row, or a hook run.attention row
       handoffCommit("Loop n: …")           leftovers, Task trailer, never pushed
       runChecks (commands pool, abort if the task leaves running/checking)
       workerDiff(changeScope) hash         commits + uncommitted
       loopMetric                           last TM_METRIC=<n> in a check's output, else green count
       budgetAllows(task, 'loop-iteration') the loop's own budget (and budget.taskUsd)
       loopStop → null: stepLoop checking → next, maybeSchedule
                  end:  endLoop → `review`
```

- **Prompt.** `loopNote()` and `loopResultBlock()` (`server/src/loop.ts`),
  passed to `buildWorkerInvocation` as `loop`. A loop iteration gets no
  `## Previous attempt` (the ledger replaces it) and no separate
  `## Definition of done` (the loop block carries the acceptance text and the
  checks). Never on a resume or the publish turn.
- **The ledger** is `progress.md` in the task's artifacts dir. The agent owns
  it (told to REWRITE it, ≤ ~60 lines: done, this iteration, what failed,
  what next); the server reads its last 12 000 chars into the next prompt
  (`readLedger`) and serves it at `GET /api/tasks/:id/loop/ledger`. It is the
  only memory a fresh session has; the server's own record of each iteration
  (`loopHistory`, the last five in the prompt) is the check on it.
- **Structured result.** The prompt ends with a fenced ```` ```json ````
  block `{"goalMet": false, "progress": "…"}`. It is read from the Stop
  payload's `last_assistant_message` (the transcript may not have flushed it),
  with `extractJson` from `aux.ts`. There is no typed correction like the aux
  runner's: a missing or invalid block reads as **not met** with the start of
  the message as the note. A forgetful iteration costs one more iteration,
  never a false "met".
- **Clean tree.** The agent is told to commit locally under the task's
  trailer (`commitTrailerRule`); whatever it left is committed by the server
  (`handoffCommit` with a `Loop n` subject), so the next iteration starts from
  a clean tree and a known commit. A failed commit ends the loop `error`.
- **Concurrency.** Each iteration is its own worker run and counts toward
  `orchestrator.concurrency` (2). Between iterations the loop holds no slot
  (its PTY is closed; checks run in the commands pool) but it keeps its repo:
  it is `running`, so `REPO_EXCLUSIVE_GATE` and the custom queue hold.
  `pumpLoops(cap)` starts due (`next`) iterations at the top of every
  scheduling pass, after the custom queue and before the global claim, oldest
  first, while `activeWorkers() < cap`. It runs whether or not the queue
  switch is on (the task is already running) but not past `budget.dayUsd`. A
  spawn refused by the PTY cap steps the iteration back to `next` with the
  same number.
- **Attempts.** Iterations after the first do not bump `tm_tasks.attempts`
  (they are the design, not re-attempts). `run.started` carries
  `loopIteration`.

## Stop conditions

`loopStop()`, in this order, after every iteration:

1. **met**: `goalMet === true` and the checks are green (or none apply).
2. **paused**: the iteration asked a question (`docs/questions.md`) or raised
   a permission prompt (a `run.attention` row from the Notification hook; the
   `budget.runMinutes` fuse's flag is not a prompt). Read from rows, so it
   survives the run's in-memory state.
3. **max-iterations**: `n >= loopMaxIterations`.
4. **budget**: `budgetAllows(task, 'loop-iteration')` refuses. `budget.ts`
   applies a loop task's `loopBudgetUsd` to EVERY automatic turn on it (fix
   rounds, check rounds, wakes, dispatch, the next iteration), measured like
   `budget.taskUsd` against `Task.costUsd`, the lower cap winning; the fuse is
   reported as `loop.budgetUsd`. The pump asks again before it starts an
   iteration. The budget is the task's WHOLE cost (worker runs + its reviews
   and compactions), across restarts of the loop.
5. **no-progress**: `LOOP_NO_PROGRESS_LIMIT` (2) iterations in a row with no
   progress. No progress = the `workerDiff` hash did not move, or both
   iterations printed a `TM_METRIC` and it did not move. The first iteration
   is no progress only when it changed nothing at all. A green count is drawn
   on the sparkline but never counts as "no progress": a red check hides how
   much was fixed under it.

Checks red with `goalMet` true is NOT met: the next iteration gets the red
output. A check `error` (timeout) is not green either.

**The metric.** A check that prints `TM_METRIC=<number>` (or `TM_METRIC: n`)
gives the loop a real metric — the coverage percent, the count of `tsc`
errors. The last one printed across the task's checks (launcher order) wins.

## The end

`endLoop()` lands `review` in ONE conditional transition (`running → review`,
actor `orchestrator`, audit `{loop: {stop, iterations}}`) that also writes
`loopState` (the end), `checkState` (the last iteration's verdict),
`reviewState` and the error/summary. The last iteration's results and hash are
already on the row (`checkResults`, `checkDiffHash`), so the check stage has
nothing to re-run. Then, under the custom-queue hold, `reviewCompletedRun`
when a review is due, else `landIfClean` alone. Not the review loop on a red,
paused or error end: `runReviewRound` reads the task's review SETTING, not
`reviewState`, so it would review those anyway (the first verification run
caught exactly that).

- **The review runs ONCE**, here, over all the loop's commits (`workerDiff`'s
  trailer scope covers every iteration's commits and the server's `Loop n`
  hand-offs). Not on a `paused` or `error` end (the loop is not over), and not
  on red checks (red never reaches the reviewer — `run.reviewed { skipped:
  'checks-red', stop: 'loop-<end>' }`). Its fix rounds resume the LAST
  iteration's session, as any task's do, and their Stops land normally (the
  loop is no longer `iterating`).
- **Landing** follows the task's tier (`docs/design.md` § Landing tiers), with
  one more rule in `landingReason` (shared): a loop lands on its own only when
  it ended `met`. A loop out of iterations with green checks and a clean
  review of an unfinished goal is a human's call on every tier.
- The row's `error` says why a loop stopped short (`loopStopText`), e.g.
  `loop stopped: 5 iterations used without meeting the goal`; `met` clears it.

## Continue, Retry, follow-ups

- **Continue** (`POST /api/tasks/:id/loop/continue`, Origin;
  `Orchestrator.continueLoop`, `continueLoopTask` in task-actions): a loop
  ended in `max-iterations|budget|no-progress|paused|error`
  (`LOOP_CONTINUABLE_STATES`) and parked in `review|failed|cancelled` goes on,
  numbering on: `→ running` with `loopState: 'next'`. Refused (409) while a
  review round or checks are open, when every iteration is used or the budget
  is spent (raise them first — the panel's limits are editable), or while the
  agent is still working. An idle terminal of the last turn is closed first.
- **Retry / Enqueue / Run now** start the loop AFRESH: iteration 1, history
  cleared. The ledger file and the task's cost stay — so a loop that ended on
  its budget stops again after one iteration unless the budget is raised.
- **A follow-up** on an ended loop is a normal turn (its Stop lands normally).
  Between iterations (`checking`/`next`) a follow-up or Proceed is refused
  (409): there is no session to talk to.
- **A resume of an interrupted iteration** (a usage-limit park, a budget
  refusal, a crash — `paused` with no history entry for the current n) goes
  back to `iterating`, so its Stop finishes that iteration (`followUp`).

## Recovery and the red buttons

- **Boot**: an iteration that was live is failed by the orphan-run sweep
  (`server restarted while the worker was running`) and so becomes `paused`.
  The stranded-`running` sweep skips a loop in `next` (a decision already
  taken: the pump starts it) and parks one in `checking` in `review` +
  `paused` (`server restarted while the loop was checking iteration n —
  Continue goes on`): its checks died with the process.
- **`handleExit`** leaves a loop task alone while it is `checking`/`next` — the
  loop closed that PTY itself.
- **`/killall`** cancels loops between iterations along with the queued work
  (`telegram/emergency.ts`): nothing else would stop the next iteration.
- The restart guard does not count a loop between iterations (no agent
  session is working); a restart in `checking` pauses it as above.

## Surfaces

- **Board card**: `LoopChip` — `↻ n/max` plus a sparkline of the metric
  (`LoopSparkline`, inline SVG in `currentColor`; drawn from two iterations
  on), and the `loop checks` / `next iteration` badges.
- **Task panel**: `LoopPanel` — iteration n/max, state, cost of budget, the
  goal, editable limits (Save limits), **Continue loop**, a table of
  iterations (checks, goal, metric, Σ $, note, no-progress / leftovers / stop
  marks) and the ledger rendered as markdown.
- **New task form**: "Loop task" checkbox → goal, max iterations, budget
  (`LoopFields`, `loopInput`); the checks are the form's existing picker.
- **Telegram**: an optional ping per iteration that went on, `telegram.notify.loop`
  in `data/config.json` (default **off**; `/notify loop on`): "🔁 <title> ·
  loop iteration n/max: checks red, goal not met, metric 2, $0.41" plus the
  note. The loop's end is the ordinary review ping (its `error` says why).
  `/new` does not create loops.
- **Audit**: `task.loop` rows — `started {n, max, fresh?}`, `ended {n, goalMet,
  checks, metric, metricSource, noProgress, handoff, costUsd, stop, humanNeeded?,
  fuse?}`, `continued {from, n}`, `taken-over {n}`; the landing's
  `task.transition` carries `{loop: {stop, iterations}}`.

## Not in scope

Loops filed by agents (`/api/agent/tasks` has no `kind`), loops from Telegram
`/new`, and a loop over several repos.

## Verification (2026-10-19)

See `docs/progress.md` § Loop tasks for the run: a real three-iteration loop on
a scratch goal in a local clone of this repo, against a copy of the live DB
(own port, internal + task routes only, no boot recovery), with its cost.
