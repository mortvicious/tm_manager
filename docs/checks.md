# Repo checks and the verify loop (definition of done)

Autonomy part 2 of 6 (the autonomy proposal's §1–§2). Before this, "done" was
whatever the agent said: the Stop hook landed `review` (or `done`), "verify it
compiles" was prose in the standing rules, and the reviewer is read-only and
cannot run anything. A task whose typecheck was red reached the human looking
exactly like a green one.

A **check** is a saved repo command the server runs itself after every worker
turn, before the adversarial review. Red checks go back into the SAME live
worker session to fix, bounded. A task can also carry its **acceptance**
criteria, the human's definition of done, which the worker and the reviewer
both see.

## Checks are repo commands

A check is a row in `tm_commands` (`docs/commands.md`) with `is_check = 1`,
plus `timeout_sec` (NULL = `CHECK_DEFAULT_TIMEOUT_SEC`, 600 s; allowed
10–3600). Migration 34. Nothing about execution is new:

- The command line goes through the same tokenizer and the same shell-operator
  rejection (`commands/parse.ts`), and is spawned as argv. `npm test | tee x`
  is a 400, as it is for any command.
- A check runs in the **commands pool** (`CommandRunner.runCheck`), as an
  ordinary, attachable command run. It shows in the header launcher as
  `check of task <id8>`, and the task panel opens its terminal. It never takes
  a worker slot.
- A check gets `CI=1` in its environment beside `FORCE_COLOR=1`. Test runners
  that default to watch mode in a tty (vitest) would otherwise never exit.
- A check must be a one-shot (`kind: 'task'`): a service never exits, so it
  could only time out (400). Two checks of one repo may not share a name,
  because tasks pick checks by name (409).

In the SPA the kind dropdown on the Repos page's command drawer has a third
value, **check**, and a check row grows a timeout field (seconds, blank = the
default). The API takes `isCheck` and `timeoutSec` on `POST/PATCH
/api/commands`. Agents cannot define checks: `/api/agent/commands` does not
take the flag, so a worker cannot redefine its own definition of done.

## Per task: acceptance and which checks

| field | column | meaning |
|---|---|---|
| `acceptance` | `tm_tasks.acceptance` | free text, ≤ 4000. Blank is stored as null |
| `checks` | `tm_tasks.checks` (JSON) | check names. **null = all** of the repo's checks, including ones added later. **[] = none** (an explicit opt-out). A name that matches no check is ignored |

Both go through `task-actions.ts` (`createTask`, `editTask`), so the REST
routes and Telegram share one path. They are normalised there: acceptance is
trimmed, and names are trimmed and de-duplicated. On the SPA they are
`DoneFields` in NewTaskForm and the TaskSlideOver settings grid: a textarea,
plus a tick box per check of the task's repo. Ticking every box again goes
back to null. Changing the repo resets the pick to "all", because names belong
to a repo. On Telegram, `/new` has an optional **Definition of done** step
after the description, and `/edit` has a *Definition of done* field (`-`
clears it).

**What the worker sees.** A FRESH prompt carries a `## Definition of done`
block right under the task description, above any follow-up and the standing
rules (`definitionOfDone()` → `doneNote`, built in `startWorker`). The block
holds the acceptance text and the checks the server will run, with their
command lines, and says "run them yourself before you finish; never weaken or
delete one". A resumed turn does not repeat it, since the session already has
it, and the publish turn never gets it.

**What the reviewer sees.** The review prompt gains an `## Acceptance criteria`
section and the check evidence (below).

## The loop

```
Stop hook (worker turn ends, not waiting, not a publish turn)
  └─ checks due? (checksDue: repo has selected checks, task not auto-publish)
       no  ──► today's path, unchanged (review / done, review round)
       yes ──► land `review` with checkState 'pending' (even under autoComplete)
               └─ reviewCompletedRun → reviewLoop → runCheckStage, then runReviewRound
                    empty diff        ► checkState null, audited, review as today
                    same diff + green ► no re-run (talk-only turn), audited
                    run the checks serially; a red is re-run once before it counts
                    green ► review round runs; its prompt gets "checks: green" + tails
                    error ► (a check timed out / could not start) review runs, told so
                    red   ► fix turn into the SAME session (followUp), unless spent:
                            checks.maxRounds · budget.taskUsd · no progress ·
                            no live session · a human took over
                            spent ► stays `review`, checkState 'red', output on the
                                    row, reviewer skipped (run.reviewed checks-red)
```

- **Where.** At the top of every `reviewLoop` pass (`Orchestrator.runCheckStage`),
  so the checks run inside the same single-flight lock (`pendingReviews`) and
  the same custom-queue hold the review round already has. A Stop that lands
  while checks are running is a `reviewRecheck` pass, as for review. "Review
  now" is refused (409, the lock) while checks run, and the SPA disables it.
- **The fix turn** is a `followUp` with `checkFixMessage()`. It names every red
  check with its command, its exit code and the last 80 lines of output (ANSI
  stripped, ≤ 8000 chars). It also mentions any check that gave no verdict,
  and it says: *Do NOT weaken, skip, disable or delete a check, a test or a
  type to make it pass — the reviewer reads the diff.* Its Stop comes back
  through the Stop hook, which marks the checks `pending` again. A fix turn's
  last message is APPENDED to `resultSummary` like a review fix round's
  (`pre.checkState === 'red'`).
- **Bounds.** `checks.maxRounds` (setting, default 3, 0 = never ask for a fix)
  and `budgetAllows(task, 'check-round')` (`docs/token-budget.md` § Fuses).
  A refusal calls `refuseOverBudget`, which puts the reason on the row and
  writes a `task.budget` audit row. The **no-progress guard**: the loop
  remembers the `workerDiff` hash the last red was measured on
  (`Orchestrator.checkLoops`, in memory like `fixRounds`). A fix turn after
  which the hash is unchanged and the checks are still red ends the loop at
  once, without another resume.
- **Red never reaches the reviewer.** A fix turn is coming, whose own Stop marks
  the review again, or the change fails its own definition of done. The red
  write clears a `pending` review state in the same write. A spent loop
  audits `run.reviewed { skipped: 'checks-red' }`, so the skip is a decision in
  the log.
- **Error is not red.** A check past its timeout is stopped (SIGHUP, SIGKILL
  after 5 s) and is `error` with `timed out after Ns`. So are a check that
  could not start, one stopped from the UI mid-run, and one whose definition
  is still running from a human's click past the timeout (`runCheck` waits for
  that run first, because there is one run per definition). Error is not re-run
  and starts no fix turn: a hang would hang again. The review then runs, with
  the error in its evidence. When reds and errors mix, red wins, because the
  red is something the worker can fix.
- **Flaky tests.** A red result gets one silent re-run before it counts. The
  second result is kept, marked `retried`, and is shown as "red twice", or
  "red once, green on the re-run" when the re-run was green.
- **autoComplete.** Checks decide "done". A task with checks due therefore
  lands `review` even under `orchestrator.autoComplete`. A non-red settle
  (green, empty diff, or checks gone) promotes it `review → done` in the same
  write as the check state (`settleChecks`), and the review round then runs on
  the done task exactly as before. `error` and `red` stay in `review` for a
  human. This is the narrow form of "on-green landing"; the landing tiers in a
  later part replace it.
- **Taken over.** While a check runs, the task's status is polled every 2 s. A
  human Proceed, cancel, or Undo that moves it out of `review` stops the
  check. The verdict is dropped and the state is cleared (`taken-over`).
- **Skipped turns.** Publish and auto-publish turns never run checks
  (`checksDue` is false for an auto-publish task, and the Stop route leaves
  `checkState` alone on a publish turn). Enqueue/Retry clears the previous
  attempt's verdict.

## State on the row

`tm_tasks.check_state` (`CheckState`: `pending|running|green|red|error|null`),
`check_results` (JSON `CheckResult[]`: name, command, exit, durationMs, outcome,
error, retried, tail, runId) and `check_diff_hash` (the change the results
belong to). Like `review_state` there is **no new TaskStatus**. The Stop route
writes `pending` in the same conditional transition that parks the task, so no
surface sees `review` without knowing checks are due.

- `running` also covers two short gaps: the seconds a red's fix turn takes to
  resume, and a green about to be promoted. During those, `review + red` would
  read as a landing to every notifier. The final state is written once the
  task is `running` again, or in the same write as `done`.
- **Repo holds.** A task in `review` whose checks are `pending|running` holds
  its repo, exactly as an open review round does. That covers the global and
  overflow claims (`REPO_EXCLUSIVE_GATE`), the custom queue (`heldBy`), and
  the stacked-task hand-off (`handOffCheckout`), because checks read the
  checkout. JS twin: `verifyOpen()` in shared, used by `holdsRepoForClaim` and
  `customQueueHoldsRepo`. Edit the SQL and the twin together.
- **Boot recovery** re-runs a `review` row left `pending|running`, through the
  same loop, joined if the review re-run already started it. On any other
  status it clears the mark.
- **Audit.** Each stage writes a `task.checked` row: `state`, `round`, per-check
  `results` (outcome, exit, duration, retried, error) and `stop`
  (`no-progress|max-rounds|budget|no-session|taken-over`), or `skipped:
  'empty-diff'|'unchanged-diff'|'taken-over'`. A fix turn is a `task.follow-up`
  row with `reason: 'checks'`. Each check run is also a `command.run` row
  carrying `checkTaskId`.

## Surfaces

- **SPA.** `StatusBadge` shows `review` + `pending|running` as **checking**,
  `review` + `red` as **checks red**, and `running` + `red|running` as
  **fixing checks**. These badges sit ahead of auto-review. The task panel's
  `ChecksPanel`, above the review section, shows the state, each check
  (outcome, exit, duration, re-run), the output tail (collapsed when green),
  and buttons for the live check's terminal and each kept run's terminal.
  Config has **Check→fix rounds**.
- **Telegram.** The review ping waits for the checks as it waits for the
  review, and opens with `checkClause()`: `✓ checks green (n)`,
  `✗ checks red: typecheck (exit 2)`, or `⚠ checks gave no verdict: …`. The
  task card has a Checks line. Board marks: 🧪 checking, ✗ checks red.
- **Push.** The same wait and clause. The auto-complete `done` push also fires
  for the `review → done` promotion.
- **Reviewer evidence.** `checkEvidence()` adds `## Repo checks (run by the
  server on this change, not by the worker)` with `checks: <state>`, one line
  per check, and the tails (15 lines for green, 80 for red). It is included
  only when `check_diff_hash` equals the change being reviewed, so a Review now
  over later edits does not quote stale results. The prompt adds: a green
  check is evidence it builds, not that the task is done, and a check
  weakened in the diff to turn green is a blocker.

## Verification (2026-10-19)

`npm run typecheck`, and a scratch `vite build` (not `web/dist`, which the
live front door serves). A throwaway `app.inject` harness ran on a copy of the
live DB, with this repo itself as the test subject: a `git archive` of HEAD in
the scratchpad, with its own `node_modules` links so its typecheck reads its
own `shared/`. The harness used the real SQLite driver, the commands, tasks
and internal routes, the real `Orchestrator` (scheduler, wake and anomaly
sweeps stubbed so nothing in the copy was ever claimed), the real
`CommandRunner` on a real PTY pool, and `sleep` PTYs standing in for workers.
A stub `followUp` recorded the fix instruction, played the worker on the
scratch tree, and fired the next Stop. Results: 35/35, saved in the task's
artifacts as `checks-harness-results.txt`.

- **Exercised:**
  - Migration 34 over 638 existing tasks.
  - The command API refusals: duplicate check name, service + check, timeout
    bounds, shell operator, rename clash.
  - The acceptance and checks normalisation.
  - The fresh vs resumed worker prompt.
  - `npm run typecheck` with a deliberate `number = 'string'` error. It was
    red twice, and the fix instruction carried `exit 2`, the TS error text and
    the no-weakening rule. The fix turn went green with the run id on the row,
    and a talk-only Stop on the same change was skipped.
  - No-progress: one fix turn, then red on the row in `review`.
  - `checks.maxRounds` = 2: two turns, then the reviewer skipped as
    `checks-red`.
  - A 10 s timeout on `sleep 40` gave `error`, not re-run, the run killed, no
    fix turn.
  - autoComplete + green → `done`, and an empty diff → `done` with checks
    skipped. This one was a bug the harness found and that was fixed.
  - The budget fuse refusing the check round.
  - Auto-publish and `checks: []` opting out.
  - A stranded `running` check re-run through the loop.
- **Not exercised:**
  - A real claude worker typing the fix (the follow-up was stubbed).
  - The reviewer session itself reading the evidence: only `checkEvidence()`
    was checked.
  - `recoverOnBoot` as a whole: it would sweep the copy's live pids, so only
    its check branch's loop call was driven.
  - Telegram and push delivery (typecheck only).
  - A browser pass of the new SPA controls.
  - The Postgres driver: same `ALTER TABLE … ADD COLUMN` shape as earlier
    migrations; typechecked only.
