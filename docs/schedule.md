# Schedule — timeline ETAs

Feature *Timeline: live past, now and predicted future*. This page grows with
its phases; phase 1 (data foundations) adds the duration baseline the ETAs are
predicted from.

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
