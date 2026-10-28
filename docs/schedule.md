# Schedule — timeline ETAs

Feature *Timeline: live past, now and predicted future*. This page grows with
its phases; phase 1 (data foundations) adds the duration baseline the ETAs are
predicted from, phase 2 the simulator that predicts them (§ Simulator).

## Baseline

`GET /api/schedule/baseline` (read-only, `server/src/routes/schedule.ts`)
answers `ScheduleBaseline`:

```jsonc
{
  "byRepo": { "<repoId>": { "workMs": { "median": 0, "p75": 0 }, "reviewMs": 0, "checkMs": 0, "n": 12 } },
  "all": { "workMs": { "median": 0, "p75": 0 }, "reviewMs": null, "checkMs": null, "n": 40 },
  "windowDays": 90,
  "computedAt": "2026-10-28T…Z"
}
```

Computed by the pure `durationBaseline(tasks, runs, events, now)` in
`shared/src/schedule.ts`, cached by `scheduleBaselineCached` in
`server/src/schedule-baseline.ts` (1 h TTL, one in-flight read, the same shape
as `progressBaselineCached` — docs/task-progress.md § Baseline).

Over the `done`/`published` tasks updated in the last `PROGRESS_WINDOW_DAYS`
(90):

- **workMs** — per task, the sum over its `mode: 'worker'` runs of WORKED time,
  `runWorkedMs`: start → the run's first `run.stats-final` (the first idle,
  written by the Stop hook) else its exit. Never wall time: a session that sat
  idle in review for hours before its PTY exited counts only up to its first
  idle. `runWorkedMs` is the Dashboard's own (`routes/stats.ts` imports it from
  shared). Median and nearest-rank p75; tasks with zero worked time are left out.
- **reviewMs** — median of the adversarial-review aux runs (`kind: 'review'`,
  `subject_id` = a landed task), `startedAt → endedAt`; rounds without an
  `endedAt` are skipped. `null` when none ran.
- **checkMs** — median check stage: a `task.checked` audit row carrying
  `results` is one stage, its time the sum of the results' `durationMs` (the
  checks run serially). Skipped stages (`skipped: …`, no results) are left out.
  `null` when none ran.
- **n** — the landed tasks with worked time behind `workMs`.

A repo gets its own line once it has `PROGRESS_MIN_TASKS` (10) such tasks;
below that it is absent from `byRepo` and a reader uses `all`
(`scheduleLineFor(baseline, repoId)`), which itself is `null` below 10 overall.
Review and check medians of a repo line are that repo's own rows.

Reads: tasks by `updatedSince`, all worker runs plus `kind: 'review'` runs
(filtered to landed tasks), and the events by KIND — `run.stats-final` and
`task.checked`, each since the oldest relevant run start, capped at
`listEvents`' 2000 rows (≈1000 stats-finals over 90 days on this machine; a
truncated stats-final makes that run fall back to its exit time).

Verify: `npm test` (`server/src/schedule-baseline.test.ts`: idle hours after
the first stats-final excluded, several runs summed, fallback below the
threshold, review/check medians, only landed tasks), then
`curl -s http://127.0.0.1:5175/api/schedule/baseline`.

## Simulator

`predictSchedule(input): PredictedSlot[]` in `shared/src/schedule.ts` — pure
(no I/O, `now` injected), so the SPA and the server can run it over the same
rows and get the same answer. It replays `Orchestrator.maybeSchedule`
(server/src/orchestrator.ts) over **virtual time**: at every instant something
changes — a predicted work segment ends, a review/check round settles, a
wake-up falls due — it runs one claim pass in the server's own order and starts
what that pass would start, then jumps to the next instant. Rows are copied
and mutated as the simulation goes (`running` at a start, `review` + an open
`reviewState`/`checkState` at a Stop, `done`/`published` at a landing), so a
predicted landing frees a repo or opens a feature phase exactly where the real
row write would.

### Input

| field | what |
| --- | --- |
| `tasks` | every task row (terminal ones too — they settle feature phases) |
| `repos` | `id, name, parallel, delivery, landing` |
| `features` | `id, title, status` |
| `settings` | `orchestrator.enabled`, `orchestrator.paused`, `orchestrator.concurrency`; optional `review.enabled`, `agent.autoWake` (both default on) |
| `runs` | the live runs: `id, taskId, startedAt, label, mode` (+ `kind`, `subjectId`, `idle` when known) |
| `progress` | taskId → `taskProgress(...).pct` |
| `baseline` | `GET /api/schedule/baseline`; null → `SCHEDULE_DEFAULT_LINE` (work 20 min / p75 35, review 8, checks 4) |
| `pushFailing` | repo ids whose push health is failing |
| `dayBudgetReached` | `budget.dayUsd` spent today |
| `repoChecks` | repoId → its check command names (absent = no checks) |
| `runTaskIds` | runId → taskId for `createdByRun` ids that are not live runs (the filer gate) |
| `now` | ISO string, ms or Date |

### The pass (same order as `maybeSchedule`)

1. **Pause all** → nothing starts and no verify round settles; every candidate
   waits `paused`. Live turns keep their predicted end.
2. **Paused-turn markers** (`review`/`failed` + `pausedTurn`) resume first,
   oldest marker first, within `orchestrator.concurrency` — `resume` as a work
   segment, `publish` as a publish turn, `land` as an immediate landing.
3. **Custom queue** (only the day fuse stops it, never the queue switch):
   `customQueueWaiting` FIFO; `queue_held_at` skipped; push-failing repos
   skipped; `FEATURE_CLAIM_GATE`; `CUSTOM_QUEUE_HEAD_WHERE` — `repoHasRoom`
   over members holding by `customQueueHoldsRepo` plus paused markers, and for
   an agent-filed member its FILER (same repo, `failed` or holding) and any
   holder in the repo — then the pump's `repoBusy` (live sessions in the repo).
4. **Loops** in `loop_state = 'next'`, oldest `updatedAt` first, within the cap.
5. **Global claim** (queue on, day fuse not tripped): `compareClaimOrder`
   order over non-member queued rows, `FEATURE_CLAIM_GATE`
   (`isFeatureTaskBlocking`), push-failing repos out, `REPO_EXCLUSIVE_GATE`
   (`holdsRepoForClaim` + `repoHasRoom`/`repoParallelCap`, so a `pr` repo with
   `parallel` 2–3 admits several worktree holders but never one next to a
   main-checkout holder).
6. **Overflow claim**: one child per live, non-idle creating run, past the cap
   (`FEATURE_OVERFLOW_GATE`, same repo gate), oldest child first.

Then the 30 s **wake sweep** (`wakeDue`, only with `agent.autoWake`):
`review`/`failed` rows with `wake_at` resume at `wake_at` + 90 s
(`SCHEDULE_WAKE_DELAY_MS`), earliest first, within the cap; a non-member waits
while the queue is off. A wake ignores the repo gate, as `wakeDue` does. A
`running` row with `wake_at` (left to the CLI at a usage limit) keeps its lane
and its remaining time starts at `wake_at` + 90 s.

A pass that started something is re-run at the same instant (up to 4 times),
the way each settled turn calls `maybeSchedule` again.

### Durations

- **Fresh work segment** (claim, resume, wake, loop iteration): the repo's
  `workMs.median` (`scheduleLineFor`, else the default line).
- **A live turn**: `elapsed × (100/pct − 1)`, where `elapsed` is now − the live
  worker run's `startedAt` and `pct` is the progress % rescaled to the WORK
  band (`pct / PROGRESS_WORK_END × 100` — the bar's 70–100 are checks, review
  and landing, which the simulator adds as their own segments), clamped to
  [1 min, `workMs.p75`]. Without a usable % (none, 0, or past the work band —
  a fix turn) it is `workMs.median − elapsed`, at least 1 min. A publish run
  (`label = 'publish'`) is `SCHEDULE_PUBLISH_MS` (3 min) − elapsed.
- **After each work segment** (never after a publish turn): the checks
  (`checkMs`) when the repo has check commands the task selects (`checks`
  null = all), then the review round (`reviewMs`) when `task.review ??
  review.enabled` — each holding the repo (`verifyOpen`) but no worker lane. A
  round already open at `now` holds from now: a `reviewing` round with a live
  aux run counts its elapsed time.
- **Landing** (`effectiveLanding`, a clean verdict assumed): `supervised` stays
  in `review` for the human; `on-green` → `done` (a worktree task stays in
  `review`, PR ready); `auto-publish` → a 3-min publish turn (a live session
  in the checkout, or the worktree land) → `published`.

### Output

`PredictedSlot` is `ScheduledSlot | UnscheduledSlot`:

```jsonc
{ "scheduled": true, "taskId": "…", "repoId": "…", "lane": 0,
  "start": "…Z", "end": "…Z",                 // the work segment
  "source": "global",                          // resume|custom-queue|loop|global|overflow|wake|running
  "after": [{ "kind": "review", "start": "…Z", "end": "…Z" }],  // checks|review|publish
  "lands": "review",                           // review|done|published
  "waits": [{ "code": "repo", "text": "waits for nest: Fix login in review round" }] }
{ "scheduled": false, "taskId": "…", "lane": null, "start": null, "end": null, "source": null,
  "after": [], "lands": null, "waits": [{ "code": "phase", "text": "phase 2 after phase 1 — Phase one waits for you in review" }] }
```

`lane` is the worker lane (null for a round already open, or a land marker).
`waits` lists what held the task back, oldest first, deduplicated, at most 6;
empty means it starts now. Codes: `paused`, `draft`, `blocked`, `held` (Undo
start), `no-repo`, `queue-off`, `day-budget`, `push-failing`, `feature`,
`phase`, `repo`, `filer`, `cap`, `wake`. Listed: queued, draft and blocked rows,
live `running`/`waiting` rows, `review`/`failed` rows with a paused marker, a
wake-up or an open verify round. A settled `review` (waiting for the human)
and terminal rows are not listed.

Not modelled, on purpose: fix rounds (a clean verdict is assumed), dispatch
turns, a blocked split parent resolving, a feature pausing after a failure, a
loop beyond its current/next iteration (it is predicted to end there), the PTY
hard cap, in-process follow-on holds (`customQueueHold`).

### Twins

The simulator is a JS twin of the claim SQL. `queue-sql.ts`
(`repoCapSql`, `repoHasRoom`, `heldBy`, `CUSTOM_QUEUE_HEAD_WHERE`,
`CUSTOM_QUEUE_HEAD_ORDER`, `REPO_EXCLUSIVE_GATE`), `feature-sql.ts`
(`FEATURE_CLAIM_GATE`, `FEATURE_OVERFLOW_GATE`), `group.ts`
(`MANUAL_CLAIM_ORDER`) and the shared twins it calls (`repoParallelCap`,
`repoHasRoom`, `holdsRepoForClaim`, `verifyOpen`, `customQueueHoldsRepo`,
`customQueueWaiting`, `compareClaimOrder`, `isFeatureTaskBlocking`) each carry a
`JS twin: predictSchedule` line, so an edit to the gate moves the prediction
with it. `isFeatureTaskBlocking` moved to shared (`shared/src/types.ts`) for
it; `feature-sql.ts` re-exports it for both drivers.

Verify: `npm test` (`server/src/schedule.test.ts`: queue off with the custom
queue still running, same-repo exclusivity, a pr repo at parallel 2, a review
round holding the repo, the feature phase gate, Pause all and paused markers,
`wake_at`, an agent-filed member held by its filer, the remaining-time
formula, overflow, push failing and the day fuse).

## SPA

The SPA reads the baseline once per hour (`useScheduleBaseline` in `web/src/timeline.ts`) and runs `predictSchedule()` over its own state on every change and a 30 s tick — docs/timeline.md § SPA.
