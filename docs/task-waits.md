# Task waits and declared dependencies

Two ways for one task to come after another (decisions.md 2026-11-03):

- **A wait**: a worker that is already RUNNING finds that its next step needs
  code another task is still writing. It parks until that task lands, then
  carries on in its own session with that code merged in.
- **A dependency**: a task that has not STARTED is declared to come after
  others. The claim leaves it alone until they settle.

Example: a feature plan of ten tasks, four running at once in parallel
worktrees. One of the four finds that it needs a sibling's API. It waits for
that sibling instead of re-implementing it or stalling a worker slot. When the
analyzer can see the order up front, it writes it into the plan instead, as
`dependsOn`.

## Waits

### The agent's side (`docs/agent-instructions.md` § Waiting for another task)

1. `GET /api/agent/tasks[?repo=]` lists the active tasks with their ids:
   draft, queued, running, waiting, review and blocked. The caller's own task
   is left out.
2. `POST /api/agent/wait {task, reason?}` validates the request, records it in
   memory per run (`Orchestrator.requestWait`), writes a `task.wait
   {phase:'requested'}` audit row, and answers with a note: commit your work
   in progress if you are in the main checkout, then end the turn.
   `DELETE /api/agent/wait` withdraws the request before the Stop.
3. The agent ends its turn.

`waitRefusal` (`server/src/task-wait.ts`) refuses the request when:

- the caller is not `running`
- the caller is a loop (every iteration is a fresh session)
- the caller is in its publish turn
- the target is missing or is the caller itself
- the target has already landed (`done`/`published`) — the 409 tells the agent
  to bring the change in now
- the target is a draft, which never starts on its own
- the target is failed or cancelled
- the wait would close a cycle: `dependencyCycle` follows both `dependsOn`
  and `waitFor` edges, plus every wait REQUESTED but not parked yet
  (`Orchestrator.pendingWaitEdges`, overlaid by `edgeIndex`). Two siblings
  asking to wait on each other before either Stop are a cycle too. The route
  reads that index as its last `await` and records the request synchronously
  after it, and a request stays in the map until `parkForWait` has written
  `wait_for`, so two crossing requests can never both pass (review round 1).
  The dependency writes (agent route, `PATCH /api/tasks/:id`) use the same
  overlay.
- the target is queued but the claim cannot reach it while the caller is
  parked (`waitTargetStuck`): it is in a LATER phase of the caller's own
  feature (the parked caller holds that phase gate), its feature is not
  `running`, it is held by Undo start (`queue_held_at`), or it waits in the
  global queue while `orchestrator.enabled` is off. The 409 says to do the
  part yourself or ask — otherwise the wait could only end at the timeout.

The target must also be within `reachOf`, the same reach that closing and
moving tasks use: your repo, your shared space, your group, filed by or for
you, or named in your brief.

### The park (`server/src/routes/internal.ts` → `Orchestrator.parkForWait`)

The Stop route looks for a wait request on its run. It does so after the
subagent/shell `waiting` decision and the loop branch, and never on the
publish turn. When it finds one, the task goes `running|waiting → blocked` in
one conditional transition:

- `waitFor` is set: `TaskWait {taskId, title, since, reason, runId}`, stored
  in `tm_tasks.wait_for` (migration 51).
- `reviewState` and `checkState` are cleared.
- The agent's last words become the summary.

**No checks, no review and no landing tier run**, because the change is
unfinished. The session is idled (`markIdle` + `idle: true`): the worker slot
is free and the PTY stays attachable. The route also writes a `task.wait
{phase:'parked'}` row and schedules.

**Why `blocked` and not a new status**: `blocked` already means "waits on
other tasks, not on you". It does not hold the repo for the global claim
(`REPO_EXCLUSIVE_GATE`), and it is not claimable. Every place where `blocked`
means "split parent" now checks `!waitFor`:

- `heldBy` (queue-sql.ts) and its JS twin `customQueueHoldsRepo`: a waiter
  does not hold the custom queue. The task it waits for may be the next
  member, or a task it filed itself, so holding the queue would deadlock it.
- `resolveChildCompletion`, both drivers: `AND wait_for IS NULL`, so a child
  settling never lands a waiter.
- The inbox `blocked` kind and the blocked pings (push and Telegram): a wait
  is not news for the human.
- `reparentRefusal`, the agent move guard and `linkToParent`.
- The schedule simulator's wait text.

### The resume (`Orchestrator.resumeWaiters`)

`maybeSchedule` calls `resumeWaiters` on every pass, right after the
Pause-all resumes and before any claim. Like dispatch delivery it runs
regardless of the queue switch and the day budget, because it continues a
session that already exists. Pause all stops it, because `maybeSchedule`
returns first.

For each `blocked` task with `waitFor`, oldest wait first, `waitOutcome`
decides:

- the target is `done`, `published` or `cancelled` (`DEPENDENCY_SETTLED_STATUSES`) → over
- the target is deleted → over
- the wait has lasted `WAIT_MAX_MS` (24 h) → over
- the target is `failed` → keep waiting, because a failed task is retried

When the wait is over, the gates are the same as dispatch delivery's:

- `repoBusy`: no other live session in the main checkout, and room under the
  repo's parallel cap
- free worker slots (`activeWorkers()`, which counts `waitResumesInFlight`)
- `budgetAllows(task, 'wait-resume')`: a refusal is audited once and the task
  stays parked

If the gates pass, the turn is fired without being awaited:
`followUp(id, waitTurnMessage(…), 'orchestrator', 'resume', 'work',
['blocked'])`. Its own `blocked → running` transition clears `wait_for`. The
message (`waitTurnMessage`) says what happened and how to bring the change in:

- **Same repo, worktree waiter**: commit your work in progress, then `git fetch
  origin && git rebase origin/<base>`, resolve conflicts, re-verify, do not
  push. If the target's trailer is not on `<base>` (it was marked done without
  landing), do NOT merge its branch, because the change would land twice.
- **Same repo, checkout waiter**: its commits should already be here. Confirm
  with `git log --grep 'Task: <id>'`.
- **Another repo**: nothing to merge; read it from that repo.
- **Cancelled or deleted**: its change will not come. Do the part yourself
  only if it is in scope, else ask.
- **Timeout**: proceed, wait again, or ask.

Each attempt writes a `task.wait {phase:'resumed'|'resume-failed', outcome,
waitedMs}` row. A resume that fails (for example, no resumable session) moves
the task `blocked → review` with the reason in `error`. It is not retried
every pass.

### End wait (the human)

On a waiter, **Unblock** becomes **End wait**: the SPA action row and
Telegram's `⏭ End wait` (`t:unb`). `unblockTask` hands it to
`Orchestrator.endTaskWait`, which resumes the session with the `human`
outcome, telling the agent the target's state. Without a resumable session it
falls back to the old `blocked → review`. Like every transition, it clears
the marker. "End wait" is deliberately not called "Stop waiting": that name
belongs to the shell-held `waiting` park (docs/design.md § Waiting).

## Declared dependencies

`tm_tasks.depends_on` (migration 51) is a JSON array of task ids, read as
`Task.dependsOn` (`[]` = none). **`DEPENDS_ON_GATE`** (`storage/feature-sql.ts`)
is AND-ed into both `FEATURE_CLAIM_GATE` and `FEATURE_OVERFLOW_GATE`, so
every claim carries it: global, custom queue (peek and by-id claim) and
overflow.

A dependency is met when it is `done`, `published` or `cancelled`, or has
been deleted (it no longer has a row). `failed` holds the dependent, because
the failed task gets retried. Ids are UUIDs, so the gate's `LIKE '%"' || id ||
'"%'` match is exact on both dialects. The JS twins, which must be edited
together with the SQL, are `unmetDependency` (shared) and `predictSchedule`'s
`featureGate`. The simulator shows the hold as wait code `depends`
("after <title>").

There are several ways to set dependencies:

- **Feature plans** (`docs/features.md`). The planner may give a card
  `"dependsOn": ["phase.task", …]` (1-based) naming an EARLIER task of the
  plan. `toStoredPlan` maps the reference to card ids and drops forward
  references, self-references and junk, so no cycle can exist. `planCards`
  keeps only edges onto earlier INCLUDED cards, which also covers an excluded
  card or a human reorder. `approveFeature` (both drivers) maps card ids to
  the new task ids as it inserts the tasks. The plan page shows each edge as
  an `after <title>` chip.
- **Agents**: `dependsOn` on `POST /api/agent/tasks`, or `POST
  /api/agent/tasks/:id/depends-on {dependsOn}` on a draft or queued task
  within reach (`[]` clears it).
- **Humans**: `dependsOn` on `POST`/`PATCH /api/tasks`. Editable only on
  `draft` and `queued`, because after the claim a dependency is history. The
  task panel lists the dependencies with a × on each.

`dependsOnRefusal` is applied on every write: the dependency must exist, must
not be the task itself, and must not close a cycle. At most `DEPENDS_ON_MAX`
(12) entries. The write itself is `setTaskDependsOn`, outside `updateTask`,
and writes one `task.depends-on` audit row.

A FRESH work prompt of a task with dependencies gets a `## Tasks this one
depends on` block (`dependenciesNote`): each dependency's status and summary,
with "build on it, do not redo it".

## SPA

- The badge (`badgeReading`) shows **waits for task** for a waiter and
  **after task** for a queued task held by a dependency (task panel). The
  frozen Board shows plain `blocked`, whose explanation now covers both
  meanings.
- The task panel shows a line for a waiter (target link, its status, since
  when, why) and the dependency list.
- The inbox counts a task's waiters and dependents in its `unblocks` weight.

## Verification

`server/src/task-wait.test.ts` (in `npm test`) covers:

- the pure rules: refusals, outcomes, the messages, cycles, the plan mapping
- against SQLite: a dependency holds the claim until it is done, a deleted
  dependency is met, a waiter's marker is set by its own transition and
  cleared by the next, a waiter does not hold the custom queue, and a child
  settling does not land a waiter
