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
`@tm/shared`), `server/src/office/presets.ts`, `names.ts` and `folder.ts`, the
shared folder rule in `server/src/folder-guard.ts`, and the tests
`server/src/office/office-pure.test.ts` and `office-scaffold.test.ts`, plus the
data layer (§ Data model): migrations 53–54, `server/src/storage/office-sql.ts`,
the Storage methods in both drivers, and `server/src/storage/office.test.ts`.

## Concepts

| Thing | What it is |
|---|---|
| `Office` | One per workspace. Has a knowledge folder (`folderPath`, outside every repo), an autonomy level, a day budget (`dayBudgetUsd`, per office-local day; 0 means nothing runs), shift concurrency (`maxSlots`), filing caps (`maxTasksPerShift`, `maxOpenTasks`), a pause (`pausedAt`/`pausedReason`), `budgetTrippedOn` (the local day the budget tripped), a `theme` and a `timezone` (IANA). Schedules, quiet hours and the budget day are all read in that zone. |
| `OfficeRole` | A standing role. Has a kebab `key` (`OFFICE_ROLE_KEY_RE`), a name, avatar and title, its human-written `prompt`, model and effort, and `tools` (always a subset of `SHIFT_TOOL_ALLOWLIST`). It can override autonomy (`autonomy`) and set a per-day cap (`capUsd`). It wakes on `schedules` (5-field cron) and `triggers`, and pre-run `guards` can skip a wake. `notesPath` is its notes file and `notesTaintedAt` marks notes written by a tainted shift. `sessionId` is the session it resumes, and `sessionTainted` marks that session as tainted. |
| `OfficeShift` | One wake: its `trigger` (`cron`/`event`/`signal`/`request`, a `ref`, and `at` = the slot or event time), a `verdict` of `ran` or `skipped` with a readable `skipReason`, the aux run, cost, the taint and its sources (`kind:ref` strings), the brief, the tasks filed, and the times and error. |
| Trigger | `{kind:'event', event}` is something this server did (`OFFICE_EVENT_NAMES`: task-landed, task-failed, review-flagged, checks-red, job-attention), so it is trusted. `{kind:'signal', source}` comes from outside (a webhook, an alert), so it is untrusted. |
| Presets | `OFFICE_ROLE_PRESETS` are the ids of the built-in role templates (director, developer, devops, qa, seo). Their content is in `server/src/office/presets.ts` (§ Presets). |

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

## Claim share

The tasks an office files (`office_id` set) run on the ordinary worker queue,
but never past their office's share of it (decisions.md 2026-11-04, open
decision 4: a slot share, not first come first served).
`OFFICE_CLAIM_GATE` (`server/src/storage/queue-sql.ts`) is AND-ed into every
claim path of both drivers: the global claim, the overflow (agent-child)
claim, and the custom queue's peek and by-id claim. A queued office task is
claimed only while its office:

1. exists (the table is FK-less; a deleted office fails closed),
2. is `enabled`,
3. is not paused (`paused_at IS NULL`),
4. has not tripped its day budget **today** — `budget_tripped_on` equal to
   the office-local day (`officeDay(now, timezone)`),
5. has fewer `running`/`waiting` tasks than `max_slots`.

A held office task is skipped, not waited on: the next eligible task, office
or not, is claimed in its place, like the repo gate. `t.office_id IS NULL`
short-circuits the gate, so a task no office filed is claimed exactly as
before. The share counts the office's TASKS; its live shifts are aux
terminals counted by the hard gate's `slots` rule above, never here.

**Today in SQL.** SQLite cannot read an IANA zone, so the gate binds ONE
value: the comma-joined ids of the offices whose budget tripped on their own
local day. Each driver reads `OFFICE_TRIPPED_SQL` in the claim's own
transaction and asks the shared `officeTrippedParam` (an unreadable zone
fails closed). The postgres global and overflow claims therefore moved to
`?` placeholders through `toPg`, like every other statement.

**Twins (edit together).** `officeClaimRefusal` / `officeHasSlot` in
`shared/src/office.ts` are the JS twin. `predictSchedule`
(`shared/src/schedule.ts`) applies it at the custom-queue, global and
overflow steps when the caller passes `offices`. A held task gets the wait
`{code: 'office', text: 'office slot share 1/1'}` (or `office paused`,
`office is off`, `office day budget spent`, `office not found`). Without
`offices` the share is not modelled: the SPA timeline and the accuracy
replay do not load office rows yet. The Dashboard's `starved-queue` anomaly
(`routes/stats.ts`) skips an office-held task, since that wait is by design.
Tests: `server/src/storage/queue-order.test.ts` § office claim share.

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

`server/src/office/presets.ts` holds one template per `OFFICE_ROLE_PRESETS` id
(`OFFICE_PRESETS`). A preset is a **starting point**: `roleFromPreset(id)`
returns a deep copy of it as a role body, which the human then edits freely.
Nothing reads a preset at run time, so editing a role never changes the preset
and changing a preset never changes an existing role.

| Preset | Model, effort | Schedule | Triggers | Guards |
|---|---|---|---|---|
| Director | `claude-opus-5-5`, high | `0 9,17 * * 1-5` (stand-up) | none | office-not-paused, budget-left |
| Developer | `claude-opus-5-5`, high | `0 10 * * 1-5` | task-failed | no-open-task-of-this-role, cooldown 120 |
| DevOps | `claude-opus-5-5`, medium | `0 8 * * 1-5` | checks-red, job-attention | cooldown 60, quiet-hours 22:00–07:00 |
| QA / Tester | `claude-opus-5-5`, medium | `0 11,16 * * 1-5` | task-landed | **new-commits-since** (runs only after code lands), cooldown 60, open-bugs-below 10 |
| SEO | `claude-opus-5-5`, low | `0 10 * * 1` (weekly) | none | budget-left, no-open-task-of-this-role |

Every preset uses `claude-opus-5-5` (`OFFICE_DEFAULT_MODEL`); presets differ by effort only, never by model (no fable). Every preset's tools are `SHIFT_READ_TOOLS` (Read, Glob, Grep, Agent,
TodoWrite). No preset grants WebFetch or WebSearch, including SEO, because web
tools taint a shift. A human may add them (`OFFICE_OPTIONAL_WEB_TOOLS`) and the
UI will flag them as tainting. No preset lists Bash, Edit or Write, and a test
checks every preset against `shiftToolsRefusal`, `cronError` and `guardError`.

Each prompt has the role's duties, what it delivers, and how **execution work
leaves the shift**, followed by the common `SHIFT_RULES` block:

- **QA**: the exploratory pass (running the suite, clicking through, edge
  cases) and any test writing are filed as worker tasks tagged with the role
  key. A shift cannot run code.
- **DevOps and SEO**: audits (dependency audit, crawl, Lighthouse) run as
  **saved commands a human allowlisted** for the office (the shift command-runs
  phase). The shift requests a run and reads its result. It never runs the
  audit itself or invents a command line. Fixes are worker tasks.
- **Director and Developer**: implementation is a worker task tagged with the
  role that owns it.

### Names

`server/src/office/names.ts` generates each role's name and avatar.
`generateRoleIdentity(officeId, roleKey, theme)` hashes (office id, role key)
with sha256, so the same inputs always give the same identity. The theme
(`OFFICE_THEMES`) picks the pool:

| Theme | Example |
|---|---|
| `pixel-office` (default; `officeTheme` maps an unknown `Office.theme` to it) | `Boss Dana`, `Kit` |
| `starship-bridge` | `Captain Vega`, `Science Officer Lyra` |
| `fantasy-guild` | `Guildmaster Brynn`, `Wren the Seeker` |
| `space-colony` | `Administrator Okafor`, `Dr. Tanaka` |

The given-name pools are disjoint, so the same seed gives different names in
different themes. Each preset key has its own title format and avatar set, and
any other key gets the theme's generic ones. `generateOfficeIdentities(officeId,
keys, theme)` names a whole office: when two roles would share a given name,
the later key steps to the next free one. The result is still deterministic.
A name is generated once, when the role is created, and the human can rename
it later. Nothing re-derives a stored name.

## Office folder

`server/src/office/folder.ts`.

**Validation.** `validateOfficeFolder(path, repos)` follows the shared-space
rule. Both call `validateDedicatedFolder` in `server/src/folder-guard.ts`, and
`validateSpacePath` is now a thin wrapper over it. The rule: the path is
absolute (or `~/…`), it is not `/` or the home directory, and it is neither
inside nor containing any registered repo. Lexical and real paths are both
compared, and a path that does not exist yet resolves through its deepest
existing ancestor, so a symlink cannot smuggle the folder into a repo.

**Default.** `defaultOfficeFolder(workspace, spaces, repos)` checks whether
**every** existing repo of the workspace is a member of one shared space
(`docs/shared-spaces.md`). If so, the office uses `<space folder>/office`
(`OFFICE_SPACE_SUBDIR`), validated like any other path. Otherwise it returns
null and the human picks a folder.

**Scaffold.** `scaffoldOfficeFolder(office, roles, {repos?})` creates:

```
README.md            generated, marker line first
vision.md            human-written
priorities.md        human-decided
roadmap.md
roles/<key>.md       one per role: standing instructions + notes
briefings/
deliverables/
untrusted/README.md  "agents never read this folder unreviewed"
```

It is idempotent. Files are created with `wx`, so an existing file (or even a
dangling symlink) is never overwritten, and an edited `vision.md` or role file
survives every re-run. A directory slot taken by a non-directory or a symlink
throws. `README.md` is regenerated only while its first line is
`OFFICE_README_MARKER` (`<!-- tm:office-folder …`), the same convention as the
shared-memory `CLAUDE.md`. Delete that line to take the file over. Role keys
must match `OFFICE_ROLE_KEY_RE`, so `roles/<key>.md` cannot escape the folder.
With `repos` given, the folder is validated first and nothing is written on a
refusal. The result lists `created`, `kept` and `readmeUpdated`.

## Data model

Migrations 53 and 54. The SQL is shared by both drivers in
`server/src/storage/office-sql.ts` (dialect-neutral, `?` placeholders, like
`workspace-sql.ts`). Storage test: `server/src/storage/office.test.ts`.

**Tables (migration 53)**. All three are FK-less, like `tm_events` and
`tm_workspaces`. Rows refer to each other by id only, so deleting a workspace
never touches an office, and a shift row outlives the role it ran for, because
it is history. Money is `DOUBLE PRECISION` (pg `REAL` is float4). Flags are
`INTEGER` 0/1, like `tm_runs.needs_attention`. Lists and objects are JSON
`TEXT`.

| Table | Columns (beyond the `Office` / `OfficeRole` / `OfficeShift` fields) | Indexes |
|---|---|---|
| `tm_offices` | `workspace_id`, `folder_path`, `autonomy` (default `proposals`), `day_budget_usd` (0), `max_slots` (1), `max_tasks_per_shift` (3), `max_open_tasks` (10), `paused_at`, `paused_reason`, `budget_tripped_on`, `theme`, `timezone`, `enabled` (0), `created_at`, `updated_at` | **unique** `(workspace_id)`: one office per workspace |
| `tm_office_roles` | `office_id`, `preset`, `role_key` (the role's `key`), name/avatar/title/prompt/model/effort, `tools`/`schedules`/`triggers`/`guards` (JSON), `autonomy`, `cap_usd`, `notes_path`, `notes_tainted_at`, `session_id`, `session_tainted` (0), `enabled` (1), `created_at`, `updated_at` | **unique** `(office_id, role_key)` |
| `tm_office_shifts` | `office_id`, `role_id`, `trigger_kind`/`trigger_ref`/`trigger_at` (the `trigger` object), `verdict`, `skip_reason`, `run_id`, `cost_usd`, `tainted`, `taint_sources` (JSON), `brief_id`, `filed_task_ids` (JSON), `started_at`, `ended_at`, `error` | `(office_id, started_at)`, `(role_id, started_at)`, `(run_id)` |

**Task columns (migration 54)**. `tm_tasks.office_id`, `role_id` and
`tainted_at` are all nullable, with an index on `office_id`. On the `Task`
type they are `officeId`, `roleId` and `taintedAt`. They are **create-only**:
`NewTask` carries them, but `updateTask` never writes them, because its column
list is explicit and the storage test checks this. Office-filed tasks use the
new `TaskSource` `'office'`. An office *feature's* cards keep source
`'feature'` and still carry `officeId`.

**Every office task is external.** `isExternalTask` is true when
`officeId != null`, whatever the source. So `effectiveLanding` clamps an
office task to `supervised`, `landingRefusal` refuses raising it, and
`effectivePushPolicy` clamps `agent-pushes`. This holds even for a
source-`'feature'` card. The board search reads such a task as provenance
`office` (`web/src/boardSearch.ts`). decisions.md 2026-11-04 records the
choice; the only exception is the phase-6 opt-in.

**Storage methods** (`Storage` in `server/src/storage/types.ts`, the same in
both drivers):

- Offices: `listOffices`, `getOffice`, `getOfficeByWorkspace`,
  `createOffice` (defaults as above; a second office for the same workspace
  throws the driver's unique violation, `isUniqueViolation`), `updateOffice`
  (`OfficePatch`; `workspaceId` and the pause are not in it), and
  `deleteOffice` (one transaction that also deletes the office's roles and
  shifts).
- **`pauseOffice(id, reason, expectedPaused)`** is the conditional composite
  that owns `paused_at`/`paused_reason`. A string `reason` pauses the office
  and null resumes it. The write lands only while the row's pause state is
  the one the caller saw. Otherwise it returns null and the caller re-reads,
  so a budget trip racing a human's Resume cannot undo either one. Re-pausing
  an office that is already paused (`expectedPaused: true`) replaces the
  reason and keeps the first `paused_at`.
- Roles: `listOfficeRoles(officeId?)`, `getOfficeRole`, `createOfficeRole`
  (a duplicate key in one office throws the unique violation),
  `updateOfficeRole` (every field but `id`/`officeId`, including
  `notesTaintedAt`, `sessionId` and `sessionTainted`), and
  `deleteOfficeRole` (the role's shifts stay).
- Shifts: `appendShift` (`NewOfficeShift`; `startedAt` defaults to now, cost
  starts at 0, and nothing is filed yet), `updateShift` (`OfficeShiftPatch`:
  verdict, skip reason, run id, cost, taint, brief, filed task ids, end time,
  error), `getShift`, and `listShifts(filter)`. The filter takes `officeId`,
  `roleId`, `verdict`, `since` (≥), `until` (<), `open` (no `ended_at`) and
  `limit` (default 500, at most 5000). Results are newest first.
- **`officeSpendSince(officeId, sinceIso, roleId?)`** returns the
  `tm_runs.cost_usd` of every run **started** at or after `sinceIso`. This is
  the same measure as `spendSince`, which backs the `budget.dayUsd` fuse. It
  counts two kinds of run:
  - the office's shift runs: a run linked by `tm_office_shifts.run_id`, or an
    aux run of kind `shift` whose `subject_id` is a shift of the office;
  - the runs of the tasks the office filed, attributed like `taskCostSql`:
    each task's own worker runs, plus the `review`/`compact` aux runs about
    it.

  A run that matches more than one branch is one row, so it is counted once.
  Other tasks, other offices' tasks, and other aux kinds about an office task
  (a chat, for example) are not counted. `roleId` narrows both kinds to one
  role. For the gate's day spend, the caller passes the start of the
  office-local day.
- **`countOpenOfficeTasks(officeId, roleId?)`** counts tasks with that
  `office_id` (and `role_id`) whose status is not in
  `TERMINAL_TASK_STATUSES`. This is the measure for `Office.maxOpenTasks` and
  for the `no-open-task-of-this-role` guard.

## API

_To be filled by the API phase._

## Shifts at run time

_To be filled by the phase that runs shifts (aux kind, prompt, sweep, filing)._

## UI

_To be filled by the UI phase._
