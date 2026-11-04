# Scheduled jobs

A **job** is a check that must happen later: "in 7 days, read the signup error
rate and the CloudWatch alarms", "every day for a week, look at the queue
backlog". It is NOT a task. Before jobs, an agent that wanted a later check
filed a task with a date in its title. That task sat in the queue, was claimed
at once, and burned a worker slot on a check that was a week early.

A job has an instruction, a due time and an optional simple repeat. It lives in
its own table (`tm_jobs`, migration 52) and its own queue. The server fires it
by itself when it is due and the machine is quiet enough. Each firing is a
**job run** (`tm_job_runs`): an aux claude terminal (kind `job`) that ends in a
verdict, findings, a markdown report and at most 3 follow-up drafts.

Code: `shared/src/jobs.ts` (types, schedule parsing, the firing rule — pure),
`server/src/storage/job-sql.ts` (SQL shared by both drivers),
`server/src/jobs.ts` (`JobService`), `server/src/routes/jobs.ts` (human API),
`server/src/routes/agent-jobs.ts` (agent API), `server/src/telegram/jobs.ts`,
`web/src/pages/Jobs.tsx`, `web/src/components/BoardJobs.tsx`.

## The model

| field | meaning |
|---|---|
| `title`, `instructions` | what to check and what counts as a problem (≤ 80 / 20 000 chars) |
| `repoId` | the run's cwd; the repo's CLAUDE.md is loaded as in any session |
| `context` | a SNAPSHOT taken at create time: the filer task's id, title, brief, result summary, its trailer commits (`git log --all -F --grep "Task: <id>"`, ≤ 20), and free notes. A snapshot, because the task may be deleted or rewritten by the time the job fires |
| `source` | `agent` · `human` · `telegram` |
| `createdByRun` / `createdByTask` | the filer, for agent jobs |
| `status` | `scheduled` → `running` → `scheduled` (repeat) or `done`; `paused`, `cancelled` |
| `nextRunAt` | the due time; null once done/cancelled |
| `repeatEveryMs`, `repeatUntil`, `maxRuns` | the simple repeat; null = one-shot. No cron |
| `model`, `effort` | per job; null = `jobs.model` / `jobs.effort` |
| `runsCount`, `last*` | the counted runs and the newest verdict/summary |

A job run row has its own `id`, the aux `runId` (the terminal, attachable from
the runs list and the job page), `runNumber`, `firedBy` (`orchestrator`,
`human`, `telegram`), `verdict` (`ok` · `attention` · `error` · `failed`),
`summary`, `findings[{severity, text, evidence}]`, `followUpTaskIds`,
`reportPath` and `acknowledgedAt`.

### Schedule input

Both APIs take the same shape (`JobScheduleInput`, resolved by
`resolveSchedule`):

```json
{ "delay": "7d" }                         // or "runAt": "2026-11-10T09:00:00Z"
{ "delay": "1d", "repeat": { "every": "1d", "maxRuns": 7 } }
{ "runAt": "…", "repeat": { "every": "12h", "until": "2026-12-01T00:00:00Z" } }
```

- Durations: `m`/`min`, `h`, `d`, `w` and compounds (`1w 2d`, `2h30m`); a bare
  number is refused (minutes or days?).
- The first run is at most 180 days away. An agent's first run must be at least
  10 minutes away; a human's may be now.
- `repeat.every` ≥ 1 h, `maxRuns` ≤ 100.
- **Cadence, not catch-up**: the next slot is the previous slot plus `every`.
  A slot missed while the server was off or busy fires once, and the slot
  after it is `now + every`. A week of downtime does not become seven runs
  in a row (`nextRunAfter`). `maxRuns` or `until` reached → `done`.

## When a job fires

The pure rule is `jobsDue()` in shared. `JobService.sweep()` runs it every 30 s
and at the top of every orchestrator scheduling pass. It is single-flight. In
this order:

1. **Pause all** (`orchestrator.paused`) → nothing fires (`hold: 'paused'`).
2. **`jobs.enabled`** off → nothing fires (`'off'`). This is the jobs queue's
   OWN switch: the task queue switch (`orchestrator.enabled`) does not stop
   jobs, and the jobs switch does not stop tasks.
3. **Busy**: tasks `running` + `waiting` across ALL repos ≥
   `jobs.maxActiveTasks` (default 3, 0 = no threshold) → wait (`'busy'`). A
   deferred check is the lowest-priority work there is. It waits for a quiet
   moment rather than compete with the work it is checking.
4. **Concurrency**: live job runs ≥ `jobs.concurrency` (default 1, max 3) →
   wait (`'concurrency'`).
5. **Day budget**: `budgetAllows(null, 'job')` — the `budget.dayUsd` fuse,
   like a claim (`'budget'`).

Then the OLDEST due job fires first (`nextRunAt`, then `createdAt`). The claim
is a conditional write (`claimDueJob`: `scheduled` and due → `running`), so a
job never fires twice.

A job run is an **aux** session, never a worker slot: it does not count toward
`orchestrator.concurrency`, never holds a repo, and is not seen by
`REPO_EXCLUSIVE_GATE` or the custom queue. It does not appear in
`activeTasks`, so a job never delays itself.

`OrchestratorStatus.jobs` = `{ enabled, due, overdue, running, hold,
activeTasks, maxActiveTasks }`. `jobHoldText()` turns `hold` into the one line
the page, the board strip and Telegram show ("3 tasks active — fires when
fewer than 3").

### Run now

Run now (page, Telegram 🔁, `POST /api/jobs/:id/run`) fires one immediately.
It skips the busy threshold and the jobs switch, because a human asked. It
still refuses: a job already running, a cancelled job, Pause all, and a full
`jobs.concurrency` (`runNowRefusal`). It never eats a future slot. A one-shot
that is scheduled and not yet due stays scheduled at its time. A paused job
goes back to paused. A done job ends done again unless its repeat continues.

## The run

`JobService.execute` spawns `aux().run` with:

- cwd = the repo, label `job: <title>`, subject = the job id, `task_id` NULL
  (like every aux row).
- `--dangerously-skip-permissions` with `Edit`, `Write`, `NotebookEdit`,
  `AskUserQuestion` and the plan-mode tools disallowed. **Bash is allowed** on
  purpose: a check reads logs, alarms and metrics through `aws`, `gh`, `curl`
  and the repo's scripts. `dontAsk` would deny every Bash call that would
  prompt, which is all of them. The prompt says OBSERVE ONLY: no commits, no
  deploys, no writes to any remote system. See SECURITY.md.
- **Permissions of an agent-filed job** (`jobPermission`, read at fire time):
  never wider than the workers' own `agent.permissionMode`, or a restricted
  worker could launder Bash through a job. `bypassPermissions` → bypass as
  above; `auto` → `--permission-mode auto` (the same classifier gates its
  Bash); `acceptEdits` → `dontAsk` (Bash would prompt, nobody is at the
  terminal, so the job reads files only). A human's job (browser, Telegram)
  always runs as above.
- `lean`, `jobs.timeoutMinutes` (default 20), the model through
  `withModelFallback` (a Fable `model_not_found` falls back to Opus).
- The prompt (`jobPrompt`): the instructions, the context snapshot, the
  previous run's verdict and summary, the rules (observe only, nobody is at the
  terminal, ≤ 3 subagents, never change the orchestrator's concurrency, how
  to pick the verdict), then `resultInstruction` for

```json
{ "verdict": "ok" | "attention", "summary": "…", "findings": [{ "severity": "info|warning|critical", "text": "…", "evidence": "…" }],
  "followUps": [{ "title": "…", "brief": "…", "description": "…", "repo": "optional id or name" }] }
```

  The block is validated with zod (`acceptJson`). An invalid block gets a
  correction typed into the same session, up to 2 times.

### How a run settles

| outcome | run verdict | job |
|---|---|---|
| a valid result | `ok` / `attention` | counted; the next slot by `nextRunAfter`, or `done` |
| timed out, failed, no valid block | `error` (the reason, or the terminal's last words) | counted; next slot as above |
| StopFailure `overloaded`/`server_error`, first time | `error` | NOT counted; due again in 2 min (once per job) |
| aborted by a human (Kill, `/killall`, delete) | `failed` | `paused`, not counted — a human stopped it on purpose |
| aborted by Pause all | `failed` | back to `scheduled`, due now, not counted — fires again on Continue |
| server shutdown or restart | left as-is | boot: the run → `error` "interrupted by restart", the job → `scheduled`, due now (`recoverOnBoot`) |
| the job was deleted mid-run | — | nothing written |

Follow-ups become **drafts** (`createTask`, `source: 'job'`, `sourceRef` = the
job id, ≤ 3). The repo is the job's, or the one the entry names. A job source is
external (`isExternalTask`), so a follow-up never lands above supervised.

The report is written to `server/data/artifacts/jobs/<jobId>/<jobRunId>.md`:
verdict, summary, findings, follow-ups and the agent's final message, passed
through `redactSecrets`. `GET /api/jobs/:id/runs/:runId/report` serves it. The
path is re-resolved under the artifacts dir, never taken from a request.
Deleting a job removes its folder.

Every step is an audit row: `job.created|updated|fired|finished|paused|resumed|cancelled|deleted`
and `jobs.toggle`. Titles and errors in the audit data are secret-redacted.

## Agent API

The worker sheet (`docs/agent-instructions.md` § Scheduled jobs) tells agents
when to use it. `STANDING_RULES` and `RESUME_REMINDER` say "a later check is a
job, never a dated task".

| route | what |
|---|---|
| `POST /api/agent/jobs` | `{title, instructions, delay?/runAt?, repeat?, repo?, context?}` → 201 `{job, note}`. Only a WORKER run (403 for aux). Only the caller's OWN repo (by id or name, or omitted): another repo is 403, because a job runs Bash in that repo's checkout. ≤ 5 per session (403), ≤ 50 live jobs per repo (409), first run ≥ 10 min away (400). The server adds the filer's context snapshot |
| `GET /api/agent/jobs` | the caller's repo's jobs (a view without instructions/context) |
| `GET /api/agent/jobs/:id` | one, if in the caller's repo or filed by its task |
| `DELETE /api/agent/jobs/:id` | only a job the caller's TASK created, not while running |

A job run cannot schedule jobs (it is aux, not a worker), so jobs cannot spawn
themselves into a loop.

## Human API

Reads need nothing. Every write needs `Origin` (a worker's curl has none):

`GET /api/jobs` (`?repoId`, `?task`) · `GET /api/jobs/:id` → `{job, runs}` with
each run's `costUsd` from its aux run row · `GET /api/job-runs/open` (attention/error
runs not acknowledged — the Inbox kind) · `GET …/runs/:runId/report` ·
`POST /api/jobs` (201) · `PATCH /api/jobs/:id` (`schedule` re-plans it; a
done job with a new schedule is live again) · `DELETE` · `POST /:id/run` (202)
· `/pause` · `/resume` (a slot already past becomes now) · `/cancel` · `/ack
{runId?}` (null = all of the job's runs) · `POST /api/jobs/toggle {enabled}`.

Events: `job.updated`, `job.deleted`, `job-run.updated`, `jobs.toggle`, plus
`orchestrator.status` for the counts.

## Settings

| key | default | |
|---|---|---|
| `jobs.enabled` | true | the jobs queue's switch (also on /jobs and `/jobs on|off`) |
| `jobs.maxActiveTasks` | 3 | fire only while running+waiting tasks < N; 0 = always |
| `jobs.concurrency` | 1 | job runs at once, 1–3 |
| `jobs.timeoutMinutes` | 20 | 2–120 |
| `jobs.model` / `jobs.effort` | `claude-opus-5-5` / `high` | |
| `jobs.notifyOk` | false | ping for an `ok` verdict too |

## UI

- **`/jobs`** (sidebar and More sheet, after Reports): the switch with the
  live "fires when fewer than N tasks are active (now n)" line and what holds
  a due job. Then sections Due · Running · Scheduled · Paused · Done &
  cancelled, scoped by the current workspace. A row shows title, repo, next run
  (relative + absolute), repeat, last summary and last verdict chip. A due row
  that is held says why ("overdue — …"). `?job=<id>` opens the detail:
  - the actions: Run now, Pause/Resume, Edit, Acknowledge all, Cancel, Delete;
  - instructions, notes and the filer task link;
  - the run history: verdict, summary, cost and age per run, unfolding into
    findings, follow-up drafts, the report, the terminal and Acknowledge.

  New job: repo, title, instructions, delay or time, repeat (every / max runs
  / until), model. On a phone the detail and the form are `<Sheet>`s.
- **On the board** (§ On the board): `BoardRoute` renders `BoardJobs` above
  whichever board version is showing, never inside the frozen `BoardPage`.
  The rows are tiny and dashed, like a mini task. They show running jobs, jobs
  with an open attention/error run, and jobs due within 7 days, at most 6, each
  with its state (`running`, `attention`, `due`, `in 2d`). A click opens
  `/jobs?job=`. Nothing renders when there is none.
- **In the task panel** (§ In the task panel): a task that scheduled jobs
  shows "scheduled a later check: <title> (<when>)" among its alerts.
- **Inbox**: kind `job` (`buildInbox`, after `blocked`, before proposals),
  one item per job, carrying its newest attention/error run that is not
  acknowledged. Keys: `a` acknowledge, `r` run again, `o` open. A `failed` run
  (a human stopped it) is not an inbox item.
- **Config → Scheduled jobs**: every `jobs.*` setting, in the original page and as the `jobs` section of the settings registry (`web/src/settingsRegistry.tsx`), so every settings version shows them.
- **Runs list**: a job run is a `job` kind badge linking to `/jobs?job=`.

## Notifications

- **Web Push** kind `job` (on by default for new devices; migration 52 adds it
  to existing devices that already had `failed`). It fires once per run when an
  `attention` or `error` verdict lands, or `ok` with `jobs.notifyOk`. The tag
  is `job-<runId>` and a tap opens `/jobs?job=<id>`.
- **Telegram** (`telegram/notifications.ts` → `jobRunMessage`): the same
  trigger, at most once per run, skipping acknowledged runs and runs settled
  more than 10 minutes ago. The ping has the verdict, summary, top findings and
  follow-up count, with 🔁 Ещё раз · ⏸ Пауза / ⏯ Продолжить · 👌 Принято.
  `/jobs` lists the live jobs with run/pause buttons; `/jobs on|off` flips the
  switch. Buttons are the `j:<id>:r|p|s|a` namespace, parsed before the action
  codec. The 📥 inbox view has a job row with Ack / Run again.

## Verification (2026-11-03)

- `server/src/jobs-due.test.ts` (16): duration parsing, `resolveSchedule`
  limits, cadence/no catch-up, maxRuns/until, the firing rule's hold order and
  oldest-first, `runNowRefusal`, `jobRunNeedsHuman`.
- `server/src/storage/jobs.test.ts` (5): CRUD, the conditional claim (a
  second claim loses), forced claim, the step guards, open/unfinished runs, ack.
- Inject harness on a fresh temp DB with a stub aux runner (30 checks, saved
  with the task's artifacts): the agent refusals (no token, aux run, < 10 min,
  no schedule, < 1 h repeat, unknown repo, 6th job), the context snapshot,
  Origin on every human write, Run now → aux kind `job`, bypass, Edit denied,
  prompt with context, the one-shot slot kept, the follow-up draft
  (`source: job`), the report, the Inbox item and ack, pause/resume, the
  transient retry, agent delete, the toggle persisting, the audit rows.
