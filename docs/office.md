# Virtual Office

An **office** is a set of standing **roles** working on one workspace
(`docs/workspaces.md`): a product manager, a QA, a researcher. A role wakes on
its own schedule, on an event this server raised, on an outside signal or on a
human's request. Each time it wakes it runs one **shift**, a read-only claude
session that looks at the workspace and files what it finds as ordinary tasks,
or as proposals. A shift never executes or edits anything. Execution is a filed
worker task or a saved-command run, and those go through the normal queue,
review and landing rules.

The office is built in phases (feature "Virtual Office"). This page covers the
foundations: the pure model in `shared/src/office.ts`. Each later phase fills in
its own section below.

Code so far: `shared/src/office.ts` (types and pure logic, no I/O, exported from
`@tm/shared`) and `server/src/office/office-pure.test.ts`.

## Concepts

| Thing | What it is |
|---|---|
| `Office` | One per workspace. Has a knowledge folder (`folderPath`, outside every repo), an autonomy level, a day budget (`dayBudgetUsd`, per office-local day; 0 means nothing runs), shift concurrency (`maxSlots`), filing caps (`maxTasksPerShift`, `maxOpenTasks`), a pause (`pausedAt`/`pausedReason`), `budgetTrippedOn` (the local day the budget tripped), a `theme` and a `timezone` (IANA). Schedules, quiet hours and the budget day are all read in that zone. |
| `OfficeRole` | A standing role. Has a kebab `key` (`OFFICE_ROLE_KEY_RE`), a name, avatar and title, its human-written `prompt`, model and effort, and `tools` (always a subset of `SHIFT_TOOL_ALLOWLIST`). It can override autonomy (`autonomy`) and set a per-day cap (`capUsd`). It wakes on `schedules` (5-field cron) and `triggers`, and pre-run `guards` can skip a wake. `notesPath` is its notes file and `notesTaintedAt` marks notes written by a tainted shift. `sessionId` is the session it resumes, and `sessionTainted` marks that session as tainted. |
| `OfficeShift` | One wake: its `trigger` (`cron`/`event`/`signal`/`request`, a `ref`, and `at` = the slot or event time), a `verdict` of `ran` or `skipped` with a readable `skipReason`, the aux run, cost, the taint and its sources (`kind:ref` strings), the brief, the tasks filed, and the times and error. |
| Trigger | `{kind:'event', event}` is something this server did (`OFFICE_EVENT_NAMES`: task-landed, task-failed, review-flagged, checks-red, job-attention), so it is trusted. `{kind:'signal', source}` comes from outside (a webhook, an alert), so it is untrusted. |
| Presets | `OFFICE_ROLE_PRESETS` are the ids of the built-in role templates. Their content belongs to the presets phase. |

### Tools

`SHIFT_TOOL_ALLOWLIST` = the server's `READ_ONLY_TOOLS` (`server/src/claude/aux.ts`:
Read, Glob, Grep, Agent, TodoWrite) plus `SHIFT_WEB_TOOLS` (WebFetch,
WebSearch). A test keeps the list equal to `READ_ONLY_TOOLS` + web tools. Bash,
Edit, Write and NotebookEdit are never on it, because a shift does not execute
or edit. `shiftToolsRefusal(tools)` is the write-time check. The web tools are
the ones that taint a shift.

## When a role wakes

### Cron

`parseCron(expr)` / `cronError(expr)` / `nextCronSlot(expr, after, tz)` have no
dependencies. The five fields are minute, hour, day of month, month and day of
week. Each field accepts lists, ranges, steps (`*/15`, `10-50/20`, `45/5`), month
and weekday names, and 7 as Sunday. The macros `@hourly`, `@daily`, `@weekly`,
`@monthly` and `@yearly` also work. Day of month and day of week combine the
Vixie way: when both are restricted they are OR-ed, and a field that starts with
`*` makes the match an AND. The zone is handled through `Intl`. A wall time that
does not exist (the spring-forward gap) is **skipped** that day. A wall time
that occurs twice (fall back) fires **once**, at its first occurrence. That
includes hourly schedules, so the repeated hour is not a second slot.
`nextCronSlot` returns the first slot strictly after `after`, or null when the
expression never fires (`0 0 30 2 *`). The search spans 8 years, so Feb 29
finds the next leap year.

### Catch-up: one wake, never a backlog

`dueSlots(role, lastShiftAt, armedAt, now, tz)` returns **at most one** wake per
role, as an array of 0 or 1 elements so callers can concat across roles. Take a
laptop that slept through five slots. The role wakes once, at the **latest**
due slot (`at`). `at` is found by a binary search over minutes, not by
walking every missed slot, so it is the true latest slot however long the gap
was. `firstMissedAt` and `missed` say how many slots the wake stands for.
`missed` is counted only up to `CATCH_UP_SCAN_MAX` (500), so above that it is
a lower bound. With several
schedules, the latest due slot across them wins.

- `lastShiftAt` is the `trigger.at` of the role's last **cron** shift, ran
  **or skipped**. A guard skip uses up its slot. Otherwise the same slot would
  be judged again on every sweep.
- `armedAt` is when the schedule started counting (role created or enabled,
  office enabled). Slots before it never fire.
- A disabled role never wakes. A bad expression is skipped here, since it was
  refused on write.

`nextRoleSlot(role, after, tz)` gives the soonest slot over all of a role's
schedules (the role card's "next 09:00").

## Guards

Guards are per-role, configurable conditions checked before a due shift. A
failing guard **skips** the shift with a readable line (`skipReason`), and the
skip is recorded as a shift with verdict `skipped`. `evalGuards(guards, facts)`
takes facts the caller has already computed (no I/O). It returns
`{pass: true}`, or `{pass: false, skip: true, reason, guard}` for the **first**
failing guard.

| Guard | Skips when | Example reason |
|---|---|---|
| `new-commits-since` | no commits since the last ran shift (passes on a first shift) | `no new code since the last shift` |
| `tasks-landed-since` | no task landed since the last ran shift | `no task landed since the last shift` |
| `open-bugs-below(n)` | open bugs ≥ n | `7 open bugs — runs only below 5` |
| `budget-left(minUsd?)` | budget left ≤ 0 or < minUsd | `only $1.50 of today's budget left (needs $2.00)` |
| `office-not-paused` | the office is paused | `office paused: holiday` |
| `quiet-hours(from,to)` | office-local time in [from, to), wrapping midnight when from > to | `quiet hours (22:00–07:00)` |
| `no-open-task-of-this-role` | the role has an open task of its own | `already has 2 open tasks of its own` |
| `cooldown(min)` | the last ran shift ended less than min minutes ago | `cooling down — last shift 20 min ago (cooldown 60 min)` |

A guard whose fact is missing fails **closed** ("cannot tell … — skipped to be
safe"), because a guard exists to save money. A malformed guard (`guardError`)
also skips. `describeGuard` gives the phrase shown on a role card.

## The hard gate

`officeHardGate(facts)` holds rules that cannot be configured, checked in
order. It returns the first refusal (`{code, reason}`), or null:

1. `office-disabled`, then `role-disabled`
2. `office-paused` (with the reason)
3. `server-paused`: Pause all (`docs/pause.md`) stops the office too
4. `day-budget`: spent ≥ `dayBudgetUsd`, or `budgetTrippedOn` is today (`officeDay(now, tz)`)
5. `role-cap`: the role's spend today ≥ `capUsd`
6. `slots`: live shifts ≥ `maxSlots`

## Autonomy and filing

`effectiveAutonomy(office, role)`: the role's override wins over the office's level.

`filingStatus(autonomy, tainted, {queueStopped})` decides what a filing becomes:

| | trusted, queue on | trusted, queue stopped | tainted |
|---|---|---|---|
| `proposals` | proposal (no task) | proposal | proposal |
| `auto-run` | `queued` | `draft` | `draft` |
| `autonomous` | `queued` | `draft` | `draft` |

A tainted shift or a stopped queue **never** files `queued`. A human reads the
draft before anything runs.

## The taint model

Text the server did not write can carry a prompt injection. A shift is
**tainted** when any untrusted text could have reached its context.
`shiftTaint(inputs)` returns `{tainted, sources}`, deduplicated, with sources of
these `TaintSourceKind`s:

| Kind | From |
|---|---|
| `signal` | an outside signal started the shift |
| `web-tool` | WebFetch or WebSearch was used. Pass the **granted** tools when use is unknown, so the check fails closed. |
| `command-output` | the shift read a saved command's output |
| `tainted-notes` | the role's notes were written by a tainted shift |
| `tainted-artifact` | it read an office artifact a tainted shift wrote |
| `tainted-session` | it resumes a session a tainted shift ran in |

What taint changes:

- **Filing**: a tainted shift files drafts only (`filingStatus`).
- **Resume**: `mayResume(role, shiftTainted)` is false when there is no
  session, and false when a **trusted** shift would resume a **tainted**
  session, because the injected text would then sit in the trusted shift's
  context. A tainted shift may resume either kind of session, and the session
  is then tainted.
- **Reading back**: a trusted reader (a later trusted shift, a brief) never
  sees a tainted artifact's text. It gets `taintedDigest(artifact)` instead,
  which is rebuilt field by field from server-known facts only: the role name,
  times, cost, filed task ids and statuses, and file paths. It never copies
  the summary, the body, task titles or extra fields. Ids, statuses and paths
  are agent-influenced strings too, so any that do not look like an id, a
  status or a plain path (a "path" containing a sentence, or a `..` segment)
  is replaced with "withheld".

## Role states

`roleState(role, facts)` returns `{state, detail}`. When several states could
apply, the first one in this list wins:

| State | When | Detail |
|---|---|---|
| `paused` | the office is paused, or Pause all is on | `office paused: <reason>` |
| `off-duty` | the office or role is off, or there is no schedule | `role is off`, `no schedule`, `on call: wakes on task-landed` |
| `waiting-for-you` | questions, proposals or approvals from this role are waiting on the human | `2 items waiting on you` |
| `in-huddle` | in a huddle | `in a huddle` |
| `on-shift` | a shift is live | the shift's label |
| `over-budget` | the office day budget is spent or tripped today, or the role cap is spent | `role spent $2.00 of its $2.00 cap today` |
| `guarded` | the latest due wake was skipped by a guard and no shift has run since | `<skip reason> · next 09:00` |
| `scheduled` | a next cron slot exists | `next 09:00`, `next Thu 09:00`, `next 2026-12-01 09:00` |

Times are formatted in the office zone (`formatOfficeTime`).

## Presets

_To be filled by the presets phase._

## Office folder

_To be filled by the folder phase._

## Data layer

_To be filled by the data-layer phase (tables, migrations, storage composites)._

## API

_To be filled by the API phase._

## Shifts at run time

_To be filled by the phase that runs shifts (aux kind, prompt, sweep, filing)._

## UI

_To be filled by the UI phase._
