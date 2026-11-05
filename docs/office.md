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
the Storage methods in both drivers, and `server/src/storage/office.test.ts`;
and the gate and day budget (§ Gate and budget): `server/src/office/gate.ts`,
`server/src/office/budget.ts`, the office branch of `budgetAllows`, and
`server/src/office/gate.test.ts`; and the REST API (§ API): `server/src/routes/offices.ts`, its
types at the end of `shared/src/office.ts`, and `server/src/routes/offices.test.ts`; and the shift runner (§ Shifts at run time): `server/src/office/shift.ts`,
`shift-result.ts`, `feedback.ts` and `server/src/office/shift.test.ts`; and the
scheduler (§ Scheduler and states): `server/src/office/scheduler.ts`, migration 57
and `server/src/office/scheduler.test.ts`.

## Concepts

| Thing | What it is |
|---|---|
| `Office` | One per workspace. Has a knowledge folder (`folderPath`, outside every repo), an autonomy level, a day budget (`dayBudgetUsd`, per office-local day; 0 means nothing runs), shift concurrency (`maxSlots`), filing caps (`maxTasksPerShift`, `maxOpenTasks`), a pause (`pausedAt`/`pausedReason`), `budgetTrippedOn` (the local day the budget tripped), a `theme` and a `timezone` (IANA). Schedules, quiet hours and the budget day are all read in that zone. |
| `OfficeRole` | A standing role. Has a kebab `key` (`OFFICE_ROLE_KEY_RE`), a name, avatar and title, its human-written `prompt`, model and effort, and `tools` (always a subset of `SHIFT_TOOL_ALLOWLIST`). It can override autonomy (`autonomy`) and set a per-day cap (`capUsd`). It wakes on `schedules` (5-field cron) and `triggers`, and pre-run `guards` can skip a wake. `notesPath` is its notes file and `notesTaintedAt` marks notes written by a tainted shift. `sessionId` is the session it resumes, and `sessionTainted` marks that session as tainted. |
| `OfficeShift` | One wake: its `trigger` (`cron`/`event`/`signal`/`request`, a `ref`, and `at` = the slot or event time), a `verdict` of `ran` or `skipped` with a readable `skipReason`, the aux run, cost, the taint and its sources (`kind:ref` strings), the brief, the tasks filed, and the times and error. |
| Trigger | `{kind:'event', event}` is something this server did (`OFFICE_EVENT_NAMES`: task-landed, task-failed, review-flagged, checks-red, job-attention), so it is trusted. `{kind:'signal', source}` comes from outside (a webhook, an alert), so it is untrusted. `{kind:'command-done'}` (opt-in) wakes the role once after the saved commands one of its shifts asked for have run (§ Command runs). |
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
## Gate and budget

Code: `server/src/office/gate.ts` (the gate), `server/src/office/budget.ts`
(the office day budget), the office branch of `budgetAllows` in
`server/src/budget.ts`, and `server/src/office/gate.test.ts`. decisions.md
2026-11-05 records why the office switches gate office work only.

### The gate: zero-token checks before a shift spawns

`officeGate(storage, office, role, trigger, {now?, settings?, countCommits?})`
is what a later phase calls before it spawns a shift. It never starts a
session or calls a model. It returns `{ok: true, hard, facts}` or
`{ok: false, skip: true, reason, code, guard?, hard, facts}`. The caller
records a refusal as a `skipped` shift with `reason` as its `skipReason`.

1. **Settle the budget** (below), so a crossing pauses the office before
   anything is judged.
2. **Hard gate.** It gathers `OfficeGateFacts` and calls `officeHardGate`.
   - Day spend: `officeSpendSince(office, <office-local midnight>)`.
   - Role spend: the same narrowed to the role, read only when the role has
     a `capUsd`.
   - Live shifts: `ran` shifts with no `ended_at`.
   - Server pause: the `orchestrator.paused` setting.
   - The office's own pause and `budgetTrippedOn`.

   A refusal returns at once with `code` set to the hard-gate code. **Guards
   are not evaluated, and their facts are not gathered**, so the hard reason
   always wins. A role whose `officeId` is another office's is refused with
   `role-mismatch`.
3. **A human `request` skips the guards.** Guards save money on automatic
   wakes, and a human who asks for a shift has already decided. The hard gate
   still applies to a request.
4. **Guards.** `officeGuardFacts` reads only the facts the role's guards
   need, then calls `evalGuards`. A failure returns `code: 'guard'` and the
   guard's kind.

| Fact | Source |
|---|---|
| `lastRanShiftAt` / `lastShiftEndedAt` | the role's newest `ran` shift |
| `newCommitsSinceLastShift` | `git rev-list --count --branches --remotes --since=<last ran shift>` per workspace repo, summed (`gitCommitsSince`, through `git.ts` `run`). `--branches` includes the `tm/*` worktree branches; stashes and notes are excluded. A repo git cannot read is left out; if none can be read the fact is undefined. |
| `tasksLandedSinceLastShift` | distinct tasks with a `task.transition` to `done`/`published` in the workspace repos since then |
| `openBugs` (+ `openBugsByCategory`) | non-terminal tasks in the workspace repos that read as bugs (`isBugTask`: source `sentry`, or a category containing the word "bug"/"bugs"), counted per category (`uncategorized` for none) |
| `openTasksOfRole` | `countOpenOfficeTasks(office, role)` |
| `budgetLeftUsd` | the lower of office budget − day spend and role cap − role spend, floored at 0 |
| `officePaused` / reason | the row after the budget settle |

A missing workspace, or a repo set no git command could read, leaves the
fact undefined. The guard then fails closed ("cannot tell …").

### The office day budget

`settleOfficeBudget(storage, office, now)` is idempotent and safe to race. It
is called by the gate, by the office branch of `budgetAllows`, and once a
minute for every office (`settleAllOfficeBudgets`, an orchestrator interval;
this is the clock that clears a trip at midnight). The day is the office's
local calendar day: `officeDay`, with `officeDayStart`/`nextOfficeDayStart`
in `shared/src/office.ts`. When midnight falls in a DST gap, the day starts at
its first wall minute that exists.

- **Trip.** When `dayBudgetUsd > 0`, today's spend ≥ it, and the office has
  not tripped today: `budget_tripped_on` is set to today, then the office is
  paused with reason `OFFICE_OVER_BUDGET_REASON` (`over budget until
  midnight`). The pause goes through the conditional `pauseOffice(…, false)`,
  so callers that cross together write **one** `office.paused` audit row
  (`actor: system`, data `{officeId, workspaceId, reason, trigger:
  'day-budget', day, spentUsd, budgetUsd}`), plus an `office.updated`
  broadcast. If the office is already paused by a human, only the trip mark
  is written. Their pause and its reason stay, and no row is written.
- **Clear.** When today's spend is under the budget, `budget_tripped_on` is
  cleared and a pause carrying exactly `OFFICE_OVER_BUDGET_REASON` is lifted
  (one `office.resumed` row with `reason: 'midnight' | 'under budget'`). This
  happens after the office's next local midnight, or the same day if the
  human raised the budget. A human's pause is never lifted. If the office is
  already over budget again on the new day, the trip moves to today and the
  pause stays, with no extra rows.
- **A $0 budget never trips.** It means "nothing runs", which the hard gate
  and the fuse refuse without calling it an overrun.

**The office fuse in `budgetAllows`.** For a task with `officeId`, every
per-task automatic kind first settles the office, then refuses while the
office is paused (any reason; fuse `office.paused`) or its day is spent or
tripped (fuse `office.dayBudgetUsd`). The reason starts with `budget:`, so
`refuseOverBudget` treats it like the task fuse: the reason goes on the row,
a `task.budget` row is written, and one ping goes out. Tasks without an
office are unchanged, and a human click never goes through `budgetAllows`.
`docs/token-budget.md` § Fuses lists the office fuse beside the others.

**What it never touches.** `orchestrator.paused`, `orchestrator.enabled`,
`budget.dayUsd` and the global or custom queue are never written by this
code. Office spend still counts toward the global day fuse, since that
measures every run. `budgetAllows(null, 'claim')` has no task, so claims
are not gated here. § Claim share's `OFFICE_CLAIM_GATE` holds them instead.
It reads the pause and the `budget_tripped_on` that the trip writes, so the
minute sweep is also what holds an over-budget office's queued tasks.

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
| `command-output` | the shift read the output of an allowlisted command marked `external` (§ Command runs). A local command's output never taints. |
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
| `guarded` | the latest due wake was skipped by a guard and no shift has run since | `skip: <skip reason> · next 09:00` |
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
  **saved commands a human allowlisted** for the role (§ Command runs). The
  shift requests a run and its next shift reads the result. It never runs the
  audit itself or invents a command line. Fixes are worker tasks. Both presets
  ship with an **empty** allowlist, and their prompts say what to ask the human
  to allow (DevOps: a dependency audit, lint/typecheck/test scripts, a config
  validator; SEO: a Lighthouse run, a sitemap or link crawl, a metadata lint,
  with anything that fetches a public URL marked external).
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

The `untrusted/` slot is not hard-coded: the scaffold, the README table and
`archiveRoleNotes` resolve it through `untrustedPath` (§ Isolation).

It is idempotent. Files are created with `wx`, so an existing file (or even a
dangling symlink) is never overwritten, and an edited `vision.md` or role file
survives every re-run. A directory slot taken by a non-directory or a symlink
throws. `README.md` is regenerated only while its first line is
`OFFICE_README_MARKER` (`<!-- tm:office-folder …`), the same convention as the
shared-memory `CLAUDE.md`. Delete that line to take the file over. Role keys
must match `OFFICE_ROLE_KEY_RE`, so `roles/<key>.md` cannot escape the folder.
With `repos` given, the folder is validated first and nothing is written on a
refusal. The result lists `created`, `kept` and `readmeUpdated`.

## Isolation

`server/src/office/isolation.ts`. Untrusted text (web pages, outside signals,
command output, archived notes) and the notes a tainted shift wrote must never
reach a **trusted** shift's context (§ The taint model). A trusted shift runs
with `cwd` = the office folder, so the question was whether the CLI's own
`permissions.deny` can wall off part of its cwd, or whether untrusted storage
has to live outside it.

**The resolvers.** Two functions are the only place the layout is known:

- `untrustedPath(office, relPath)` — the absolute path of `relPath` inside the
  untrusted storage (`''` = its root). Refuses an absolute or climbing
  (`..`) `relPath` and a relative office folder. Notes, deliverables, briefs,
  the roadmap, messages and the scaffold reach untrusted storage only through
  it — never a literal `untrusted/`.
- `trustedShiftDenies(office, taintedPaths)` — the `permissions.deny` list a
  trusted shift's `--settings` carries: `Read(//<root>/untrusted/**)` plus one
  rule per tainted path (relative to the office folder; a file exactly, a
  directory with `/**`). Every target is denied on its lexical **and** real
  path, so a symlinked office folder is covered either way. A tainted path
  outside the folder, the folder itself, or a path holding a character a rule
  would read as syntax (`* ? [ ] { } ( ) \ !`, control characters —
  `denyRuleRefusal`) **throws**: the shift must not spawn rather than run with
  a rule that silently matches nothing. `validateOfficeFolder` refuses such a
  folder up front, so only a folder renamed behind the server's back reaches
  the throw.

The shift runner (§ Shifts at run time) writes a tainted shift's notes and
deliverables to their `untrustedPath` twin, so they sit under the storage
rule. Notes a tainted shift touched any other way stay where they are; a
trusted shift is spawned with a rule for each such `roles/<key>.md` (every
other role with `notesTaintedAt` set), and that rule is what keeps them out. The rules bind the read-family tools only (measured below). A shift
has no Bash (`SHIFT_TOOL_ALLOWLIST`), and that is what makes them enough. A
worker session has Bash, so a deny rule could not protect a worker. See
**Known exposure** below.

**The measurement** (2026-11-05, task 589d8bff, Claude Code **2.1.318**). A
temp office folder held `untrusted/page.md` (canary `CANARY-UNTRUSTED-…`),
`roles/scout.md` standing in for tainted notes (canary `CANARY-TAINTED-NOTES-…`),
a trusted `roles/director.md` and `vision.md`, and a git repo beside it with
`a.txt`. Each attempt was a separate session spawned the way an aux shift is:
`cwd` = the office folder, `--add-dir=<repo>`, `--permission-mode dontAsk`,
`--tools=Read,Glob,Grep,Agent,TodoWrite` (`READ_ONLY_TOOLS`),
`--disallowedTools=Edit,Write,NotebookEdit,Bash` (`READ_ONLY_DISALLOWED`), and

```json
{"permissions":{"deny":[
  "Read(//<office>/untrusted/**)",
  "Read(//<office>/roles/scout.md)"]}}
```

as `--settings`. The sessions ran under `-p --output-format stream-json`, so
every tool result could be checked for the canary bytes. `-p` and the
interactive PTY share the permission engine and the @-mention expansion, and
the no-deny control below shows the expansion happening under `-p`. The
model was `sonnet`, and enforcement is client-side.

| Attempt | Result with the deny rules |
|---|---|
| Read `untrusted/page.md`, `roles/scout.md` | `File is in a directory that is denied by your permission settings.` — `director.md` and the repo's `a.txt` read normally |
| Grep `CANARY\|OK-` with no path | only `roles/director.md:1:…`; the denied files are skipped silently |
| Grep with path `untrusted` / `roles/scout.md` | `Permission to read <abs path> has been denied.` |
| Glob `**/*` / `untrusted/**` | `roles/director.md`, `vision.md` / `No files found`: even the denied files' **names** are hidden |
| `@untrusted/page.md`, `@roles/scout.md` in the prompt | not expanded, while `@roles/director.md` was |
| Agent (general-purpose subagent) told to Read both | the subagent got the same denial |
| `UNTRUSTED/page.md`, `Untrusted/PAGE.md`, `roles/SCOUT.md` (APFS is case-insensitive) | denied |
| `roles/../untrusted/page.md`, `./untrusted/./page.md`, `<repo>/../office/untrusted/page.md` | denied |
| `roles/link.md` → symlink to `../untrusted/page.md` (Read, and Grep over `roles`) | denied / no match |
| rules written with the `/tmp` alias while the files are read under `/private/tmp` | denied |
| an office folder whose path contains spaces (`…/my office/untrusted/**`) | denied |

The canary appeared in **no** tool result or reply in any of these runs. As a
control, the same five base attempts **without** the deny rules leaked both
canaries through Read, Grep, the @-mention and the subagent, and Glob listed
`untrusted/page.md` and `roles/scout.md`.

**Decision** (decisions.md 2026-11-05): the deny holds, so untrusted storage
stays **inside** the office folder as `untrusted/`. Moving it to a sibling
`<folder>.untrusted/` was the fallback and was not needed. If a later CLI
breaks one of the rows above, the fix is a change to `untrustedPath` alone.
Re-run the measurement when the CLI's permission handling changes. The
harness is in the task's artifacts (`isolation-probe.sh`).

**Known exposure, out of this section's reach.** When the office uses the
default `<space folder>/office`, every WORKER in the space's member repos gets
`--add-dir=<space folder>` and Bash, so it can read `office/untrusted/` (and
tainted notes) directly. Read-deny rules cannot close that, because Bash
`cat` ignores them. A sibling `<folder>.untrusted/` would not close it
either, since it would still sit inside the space folder. It is tracked as
follow-up task 21ee2d45.

## Data model

Migrations 53 and 54 (and 57, § Scheduler and states: `tm_office_roles.armed_at`,
`tm_office_shifts.skip_code`). The SQL is shared by both drivers in
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
| `tm_offices` | `workspace_id`, `folder_path`, `autonomy` (default `proposals`), `day_budget_usd` (0), `max_slots` (1), `max_tasks_per_shift` (8), `max_open_tasks` (12) — the insert's defaults, migration 55 (§ Filing), `paused_at`, `paused_reason`, `budget_tripped_on`, `theme`, `timezone`, `enabled` (0), `created_at`, `updated_at` | **unique** `(workspace_id)`: one office per workspace |
| `tm_office_roles` | `office_id`, `preset`, `role_key` (the role's `key`), name/avatar/title/prompt/model/effort, `tools`/`schedules`/`triggers`/`guards` (JSON), `command_ids` (JSON `OfficeRoleCommand[]`, migration 56 — § Command runs), `autonomy`, `cap_usd`, `notes_path`, `notes_tainted_at`, `session_id`, `session_tainted` (0), `enabled` (1), `created_at`, `updated_at` | **unique** `(office_id, role_key)` |
| `tm_office_shifts` | `office_id`, `role_id`, `trigger_kind`/`trigger_ref`/`trigger_at` (the `trigger` object), `verdict`, `skip_reason`, `run_id`, `cost_usd`, `tainted`, `taint_sources` (JSON), `brief_id`, `filed_task_ids` (JSON), `filing` (JSON `OfficeShiftFiling`, migration 55 — § Filing), `commands` (JSON `OfficeShiftCommands`, migration 56 — § Command runs), `started_at`, `ended_at`, `error` | `(office_id, started_at)`, `(role_id, started_at)`, `(run_id)` |

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
  verdict, skip reason, run id, cost, taint, brief, filed task ids, filing, end time,
  error), `getShift`, and `listShifts(filter)`. The filter takes `officeId`,
  `roleId`, `verdict`, `triggerKind`, `since` (≥), `until` (<), `open` (no `ended_at`) and
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

`server/src/routes/offices.ts`, registered in `index.ts`. Request and response
types are at the end of `shared/src/office.ts` (`OfficeDetail`,
`OfficeCreateBody`/`Result`, `OfficePatchBody`, `OfficeRoleCreateBody`,
`OfficeRolePatchBody`, `OfficeRoleWriteResult`). Test:
`server/src/routes/offices.test.ts` (Fastify inject over a temp SQLite DB).

| Route | What it does |
|---|---|
| `GET /api/offices` | every office (`Office[]`) |
| `GET /api/offices/:id` | `{ office, roles, shifts }`: roles oldest first, the newest `OFFICE_DETAIL_SHIFTS` (50) shifts |
| `POST /api/offices` | create from the presets (below) → 201 `{ office, roles, scaffold }` |
| `PATCH /api/offices/:id` | edit the office → the `Office` |
| `POST /api/offices/:id/roles` | add a role → 201 `OfficeRoleWriteResult` |
| `PATCH /api/offices/:id/roles/:roleId` | edit a role → `OfficeRoleWriteResult` |
| `DELETE /api/offices/:id/roles/:roleId` | remove a role → `{ ok: true }` |
| `POST /api/offices/:id/roles/:roleId/reset-notes` | reset the role's notes file → `OfficeRoleWriteResult` |
| `PUT /api/offices/:id/roles/:roleId/commands` | replace the role's command allowlist (§ Command runs) → `OfficeRoleWriteResult` |
| `POST /api/offices/:id/roles/:roleId/wake` | Wake now, `{ note? }` → 202 `{ shiftId }`; 409 `{ error, code }` with the hard-gate or runner reason (§ Scheduler and states) |
| `GET /api/offices/:id/states` | every role's state → `OfficeStates` (§ Scheduler and states) |

**Every write needs `Origin`** (403 `office edits come from the dashboard`
otherwise). Every write acts as `human`, and a worker's `curl` sends no
`Origin` — the shared-spaces and workspaces rule. Raising autonomy is one of
those writes, so it is Origin-gated like everything else here, and the audit
row records it (`autonomy: { from, to, raised }`). Every successful write
appends one `office.changed` row (`actor: 'human'`, `data.action` =
`created | edited | role-created | role-edited | role-deleted |
role-notes-reset`, with the office, workspace and role ids and the fields
touched) and broadcasts `office.updated`. After a role write that event also
carries `roles`, the office's full role list. Nothing in these rows is
secret, so nothing is stripped.

**Create** (`{ workspaceId, folderPath?, theme?, timezone? }`):

- The workspace must exist (400). A second office for a workspace is 409:
  checked first, and the unique index catches a race.
- `timezone` defaults to the server's zone and must be a valid IANA name
  (`isValidTimeZone`, 400). `theme` is one of `OFFICE_THEMES` (default
  `pixel-office`).
- Folder: a given `folderPath` passes `validateOfficeFolder` (outside every
  repo, § Office folder; 400 with the reason). Without one, the default is
  `defaultOfficeFolder`, i.e. `<space folder>/office` when every repo of the
  workspace is in one shared space. With no such space it is 400 and the
  human must pick a folder. A folder another office already uses is 409,
  because two offices must not share notes.
- The office row is written **disabled** (`enabled: false`, day budget 0,
  autonomy `proposals`). Then the five presets become roles in
  `OFFICE_ROLE_PRESETS` order (`roleFromPreset`), with names and avatars
  from `generateOfficeIdentities` in the office's theme, and notes at
  `roles/<key>.md`. Then the folder is scaffolded. It is all or nothing: if a
  role insert or the scaffold throws, the office is deleted again (with its
  roles) and the answer is 400.

**PATCH office** (`OfficePatchBody`, strict: an unknown field is 400):

- Fields: `folderPath`, `autonomy`, `dayBudgetUsd` (0…100000), `maxSlots`
  (1…`CONCURRENCY_MAX`), `maxTasksPerShift` (1…15), `maxOpenTasks` (1…200),
  `theme`, `timezone`, `enabled`, `paused`.
- **An enabled office needs `dayBudgetUsd > 0`.** Enabling without one, in
  the same body or already stored, is 409 `set a day budget above $0
  (dayBudgetUsd) before enabling the office`. Zeroing the budget of an
  enabled office is 409 too.
- A new `folderPath` is validated, must not be another office's, and is
  scaffolded (with the current roles) BEFORE the row moves. The old folder
  is left as it is.
- `paused: true | false` goes through the conditional `pauseOffice`
  (reason `OFFICE_HUMAN_PAUSE_REASON`, "paused by a human"). If the state
  moved in between, for example a budget trip, the answer is 409 and the
  caller reloads. The budget sweep lifts only its own pause
  (§ The office day budget), never this one. A human Resume over a budget
  pause clears the pause, but `budget_tripped_on` still keeps the gate and
  the claim gate shut for the rest of that local day.
- `workspaceId` is create-only. The pause columns are only reachable
  through `paused`.

**Roles.** Shapes are zod (strict). The content rules are checked by
`checkRoleFields` and come back as one readable sentence (400):

- `schedules[]`: each one must parse (`cronError`). The message is
  `schedule "61 * * * *": minute: 61 is outside 0-59`. Duplicates are
  dropped.
- `guards[]`: a known `kind` (`OFFICE_GUARD_KINDS`) and `guardError` clean.
  For example `guards[0]: cooldown needs minutes > 0` or
  `guards[0]: unknown guard kind "moon-phase" (one of: …)`. Each guard is
  rebuilt from its known fields only, so stray keys never reach the row.
- `triggers[]`: `{ kind: 'event', event ∈ OFFICE_EVENT_NAMES, repoId? }` or
  `{ kind: 'signal', source }`. Anything else is refused with its index.
- `model` must be one of `MODEL_OPTIONS`. `effort` is one of `EFFORT_LEVELS`
  or null. `autonomy` is one of the levels or null (= the office's).
  `capUsd` is ≥ 0 or null.
- `tools` must be a subset of `SHIFT_TOOL_ALLOWLIST` (`shiftToolsRefusal`).
  **Bash, Edit, Write and NotebookEdit** (`SHIFT_FORBIDDEN_TOOLS`) get their
  own message (`shiftForbiddenToolsMessage`): *"Bash cannot be given to a
  role: shifts never execute or edit. Work that needs a command run or a
  file changed is filed as a worker task, or run as a saved command a human
  allowlisted for this office."* Any other unknown tool gets the allowlist.
- **WebFetch / WebSearch are allowed but flagged.** Every role write answers
  `{ role, taintingTools, warning? }`. `taintingTools` lists the role's web
  tools, and `warning` says that a shift using one is tainted (§ The taint
  model). A role-edited audit row lists `addedTools`.

Create (`POST …/roles`) takes `{ preset?, key?, …fields }`:

- A `preset` fills every field it has, and a given field overrides it.
  Without a preset, `key`, `title` and `prompt` are required.
- `key` defaults to the preset's. It must match `OFFICE_ROLE_KEY_RE` (400)
  and be unique in the office (409), so a second QA needs a key such as
  `qa-mobile`.
- `name`/`avatar` default to `generateRoleIdentity` for (office, key,
  theme), stepping the salt past a name another role already wears.
- `notesPath` is `roles/<key>.md`. The folder is re-scaffolded, which writes
  the new role file and refreshes the README's role list.

PATCH (`…/roles/:roleId`) takes any of the fields; `key`, and so the notes
path, is create-only. Renaming to another role's name is 409. DELETE removes
the row and refreshes the README. The role's notes file and its shifts stay,
because they are history. A role id from another office is 404.

**Notes of a new role.** A role's notes are trusted input to its shifts, so a
role never inherits a notes file it did not write. Before a role is created,
and for every role when an office takes a folder (create, or PATCH
`folderPath` to a new one), `archiveRoleNotes` (`folder.ts`) moves any
`roles/<key>.md` that is already there into
`untrusted/archived-notes/<key>-<timestamp>.md`. A symlink is moved as the
link itself. Then the scaffold writes a fresh skeleton. This covers three
cases: a deleted role's file (DELETE keeps it as history, and it may have
been written by a tainted shift), a folder reused from an earlier office, and
notes someone left in the default `<space>/office`. `untrusted/` is the
folder agents never read unreviewed (§ Office folder), so the old text stays
available to a human and never reaches a shift as trusted notes. The moves
are listed in `scaffold.archived` on create and as `archivedNotes` on the
`office.changed` row. Other files (vision, priorities, roadmap) are the
humans' and stay where they are. If the move fails on a role create, the
role row is removed again and the answer is 400.

**reset-notes** rewrites `roles/<key>.md` to its fresh skeleton (the role's
standing instructions plus an empty Notes section; `resetRoleNotes` in
`folder.ts`) and clears `notesTaintedAt`. The file is written to a temp file
and renamed over the old one, so a symlink there is replaced, never followed.
`roles/` itself must resolve inside the folder. The audit row records
`wasTainted`. This is how a human clears notes a tainted shift wrote, since
§ The taint model keeps tainted notes out of trusted shifts.

## Shifts at run time

`server/src/office/shift.ts` (the runner), `shift-result.ts` (the result
registry), `feedback.ts` (the feedback file). Test: `server/src/office/shift.test.ts`,
which drives a real `AuxRunner` over a fake `SessionManager`, so it checks the
real argv and hook handling without spawning claude.

The runner spawns a shift and records it. It does not decide when a role
wakes: the gate (§ Gate and budget) and the scheduler do that.
`ShiftRunner.start(office, role, trigger)` resolves once the shift row exists,
or with a refusal (`{ok: false, code, reason}`). Its `done` promise resolves
after the session has ended and its result has been applied.

### The terminal

A shift is an interactive aux terminal (`claude/aux.ts`, docs/design.md § PTY
sessions) with these settings:

- **Run row.** Kind `shift`, with `subject_id` = the shift id, `label` = the
  role's name, `repo_id` NULL, and `task_id` NULL like every aux row. It is
  attachable from the runs list.
- **Folder access.** `cwd` is the office folder, and every workspace repo that
  exists on disk is passed as `--add-dir=<repo>`. These are new `AuxSpec`
  fields: `addDirs`, and `permissionsDeny`, which is merged into the injected
  `--settings` as `permissions.deny`.
- **Tools.** `--tools=` is the role's own `tools`, which are always a subset of
  `SHIFT_TOOL_ALLOWLIST` (§ Tools).
- **Denials.** `--disallowedTools=Edit,Write,NotebookEdit,Bash` is
  `READ_ONLY_DISALLOWED` verbatim, under `--permission-mode dontAsk`.
- **Lean.** `lean` is on (no chrome, no bundled skills).
- **Deadline.** 30 min (`SHIFT_TIMEOUT_MS`).
- **Model.** The role's model and effort, through `withModelFallback`.

A shift never executes or edits. Execution work leaves it as a filed worker
task (the `tasks` section, § Filing) or a run of an allowlisted saved command
(the `commands` section, § Command runs).

**Refusals.** The runner refuses to spawn in these cases, whatever the caller
says:

| Code | When |
|---|---|
| `tools` | the role's STORED tools fail `shiftToolsRefusal`. A role row edited around the API's write check still never reaches a spawn. No shift row is written. |
| `paused` | Pause all is on, or the server is shutting down |
| `folder` | the office folder is missing, or it fails `validateOfficeFolder` against the current repos (re-checked every spawn, like a shared space), or the isolation resolvers throw (§ Taint, before spawn) |
| `office-busy` | a shift of this office is live (`SHIFT_MAX_PER_OFFICE` = 1) |
| `busy` | 2 shifts are live across all offices (`SHIFT_MAX_TOTAL`) |
| `role` | the role belongs to another office, or the office or role row no longer exists |

The concurrency slot is taken synchronously, before the first await, so two
starts in the same tick cannot both pass. After taking it, `start` re-reads the office and
role rows. The STORED rows decide the tools, the taint and the resume, never
the caller's copy: a role object held across an earlier shift would carry a
stale session taint. A shift is never a worker slot and
never holds a repo.

**Stopping.** These paths stop a shift like any other aux kind:

- **/killall, the runs list's Kill, and a forced restart.** These go through
  `aux()`. The row ends with `stopped`.
- **The restart guard.** `aux().liveLabels()` covers shifts. `shift` is in
  `PAUSE_HELD_AUX_KINDS`, because the runner starts no shift while paused,
  so a drain may wait on one.
- **Pause all.** `Orchestrator.pauseAll` calls `ShiftRunner.suspendAll()`, and
  the row ends with `suspended by Pause all`.
- **Shutdown.** `stop()` leaves the open rows alone, and `recoverOnBoot()`
  closes every `ran` row with no `ended_at` (`interrupted by restart`). An
  open row counts as a live shift for the gate, so a crash must not hold the
  office's slot forever.

An abort that lands while the spawn is still being recorded is no longer lost.
`AuxRunner.start` re-checks the signal after attaching its listener; before
this, such a session ran on to its own deadline. Jobs have the same window.

### Taint, before spawn

The taint is decided before the session exists, with `shiftTaint`. Its inputs:

- the trigger (`signal` taints);
- the **granted** tools, because use is unknown before the run (fails closed):
  a role with WebFetch or WebSearch is always tainted, with `web-tool:WebFetch`;
- the role's notes (tainted while `notesTaintedAt` is set);
- the resumed session (tainted while `sessionTainted` is set).

The shift row stores `tainted` and `taintSources` (`taintLabel` strings,
`kind:ref`) from the start.

**Isolation** (§ Isolation). A **trusted** shift's spawn carries
`trustedShiftDenies(office, taintedPaths)` as `--settings` `permissions.deny`.
That is the untrusted storage on both its lexical and real path, plus the
`roles/<key>.md` of every OTHER role with `notesTaintedAt` set, so the shift
fails closed. A tainted shift gets no denies, because its context is already
tainted. A tainted shift's files go to `untrustedPath(office, <own path>)`.

The runner never builds an untrusted path itself. Both resolvers come from
`isolation.ts` (`SHIFT_ISOLATION`, injectable only so a test can watch the
calls). They are computed before the shift row is written. A folder that no
rule can match exactly makes them throw, and that is a `folder` refusal: no
row is written and nothing is spawned.

### Resume

`--resume role.sessionId` is passed only when both of these hold:

- `mayResume(role, shiftTainted)` holds. So there is a session, and a trusted
  shift never resumes a tainted one.
- The role's newest shift run in that session ended under
  `agent.resumeContextCap`, read from that run's `stats.contextTokens`.

A cap of 0 or less means no cap, like the worker resume gate. An unknown size
(no such run, or no stats) is not treated as small, so the shift starts fresh.
The reason a session was not resumed is on the `office.shift` audit row
(`freshReason`).

After the run:

- The session id the run reports becomes the role's `sessionId`, with
  `sessionTainted` = this shift's taint. A fresh trusted shift therefore
  replaces a tainted session with a trusted one.
- A tainted shift that resumes a TRUSTED session marks the session tainted
  **before** it spawns. A crash mid-shift must not leave injected text in a
  session the row still calls trusted.
- A resumed shift that failed without reporting any session drops the id, so
  the next shift starts fresh instead of failing on the same `--resume`
  forever.

### The prompt

In order:

1. The role's identity and the trigger. An outside signal is named as
   untrusted data.
2. The role's prompt.
3. The office folder and the workspace repos, each with its `repoId` (what
   the `tasks` section names).
4. `vision.md` and `priorities.md` inline, up to 16 KB each.
5. The role's notes inline.
6. The role's **feedback file** (trusted, the last 50 entries).
7. The office's last 10 shifts, as a fenced ```` ```json ```` block of DATA:
   server-known fields only (role, times, trigger kind, verdict, skip reason,
   cost, filed task ids and statuses, files written). A tainted shift appears
   as its `taintedDigest` line.
8. The section guide.
9. `resultInstruction(schema)`.

A resumed session gets the whole prompt again: it is a new shift, and notes
and feedback may have changed since the last one.

### The result: a section registry

`shift-result.ts`. Each section is a key of the result object, registered with
`registerShiftSection`. A section has four parts:

- a zod `schema`;
- its JSON-schema twin, which the prompt shows;
- a one-line `describe`;
- `apply(value, ctx)`.

The whole result is a strict object with every section optional, so `{}` is
"nothing to record". An unknown key, a schema miss or a missing block makes
`acceptJson` fail, and the standard correction is typed into the same session,
at most twice (`AuxRunner`'s `maxRetries`). After that the shift fails with
`invalid result: …`.

Sections are applied in registration order. A section that throws is
recorded, and the others still run.

Every write goes through `writeOfficeFile`, which:

- creates the parents;
- checks that each parent resolves inside the folder;
- writes a temp file and renames it over the target, so a symlink is
  replaced, never followed;
- refuses the server-owned files: `roles/*.feedback.md`, `README.md`, and the
  untrusted storage's own README.

| Section | Value | What the server does |
|---|---|---|
| `notes` | markdown, ≤ 24,000 chars, not empty | **replaces** `roles/<key>.md` whole |
| `deliverables` | ≤ 10 of `{path, markdown}` (≤ 100,000 chars each); `path` is `deliverables/<name>.md`, up to three subfolders, plain segments with no leading dot, each path at most once | writes each file (an existing one is replaced); the path is re-checked at the write |
| `tasks` | ≤ 30 of `{repoId, title, description, category?, effort?}` | files worker tasks, holds them (proposals) or drops them past a cap — § Filing |

A **tainted** shift's notes and deliverables go to
`untrustedPath(office, <their own path>)` instead, for example
`untrusted/roles/<key>.md` and `untrusted/deliverables/…`, and its notes set
the role's `notesTaintedAt`. The trusted `roles/<key>.md` is left as it was.

While `notesTaintedAt` is set, the next shift reads the newest notes, which
are the untrusted twin (or the trusted file if there is no twin). That shift
is tainted (`tainted-notes`). A human clears this with reset-notes (§ API).

`commands` is registered by § Command runs; a later phase registers briefs. The section context also
carries the shift's `runId` and the orchestrator (to kick the scheduler after a
queued filing).

### Notes vs feedback

Two files per role, with two owners. This split is what keeps an update from
being lost:

- **`roles/<key>.md` is the ROLE's.** Only its own shift's `notes` section
  writes it (and reset-notes), and that write replaces the whole file.
- **`roles/<key>.feedback.md` is the SERVER's.** It holds proposal decisions,
  ratings and taint clears. It is written only by
  `appendRoleFeedback(office, role, line)`, which:
  - serializes the writes per file in-process;
  - opens with `O_APPEND | O_CREAT | O_NOFOLLOW` and never rewrites, so a
    planted symlink fails the write;
  - folds each entry into one line, `- <ISO time> — <text>`, capped at 2,000
    characters;
  - writes a header when it creates the file.

No shift section can target the feedback file. A line appended while a shift
runs survives that shift's notes replacement, and it appears in the next
shift's prompt (`readRoleFeedback`, last 50 entries).

A role re-created under an old key does not get the old notes
(`archiveRoleNotes`). The feedback file stays where it is, because it is
server-written and trusted.

### What is recorded

**The shift row** gets `verdict: 'ran'`, the trigger, `runId` (the last
attempt's, set as soon as the PTY is spawned), `costUsd` (every attempt,
including a model fallback), `tainted`, `taintSources`, `endedAt` and
`error`, plus `filedTaskIds` and `filing` from the `tasks` section (§ Filing).
`error` is null on success, the aux error otherwise, `stopped`, or
`suspended by Pause all`. It is `result partly applied — …` when a section
failed.

**The audit row** is `office.shift`: status, code, error, cost, taint,
`resumed`, `freshReason`, the sections with the files they wrote (and, for
`tasks`, the `taskIds` filed), and `files`. The history block reads the files back from it.

**The broadcast** is `office.updated` with the roles.

### Filing

`server/src/office/filing.ts` (registered as the `tasks` section in
`shift-result.ts`), tests in `filing.test.ts` and `shift.test.ts`;
decisions.md 2026-11-05 (open decision 5). A shift asks for work in the
result's `tasks` section: a list of `{repoId, title, description, category?,
effort?}` (`shiftTasksSchema`, at most 30 items). `repoId` is the id the prompt
lists; an exact (case-insensitive) repo NAME of the workspace is mapped to it. Execution work the brief names as shift
work — an exploratory QA pass, writing tests — is filed here as an ordinary
worker task tagged with the role, so it runs with normal worker tools, the
review, the checks and the landing tiers. The shift itself never executes.

**The server files them** (`fileShiftTasks`) through `task-actions.ts`
`createTask`, like every other creation, as source `office` with `office_id`,
`role_id`, `created_by_run` = the shift's run, `spawn_depth` 1, the category and
effort asked for, and `tainted_at` when the shift is tainted. The description
gets a `Filed by <role> — office shift <id8>` line on top and the standing caps
at the end (`withStandingCaps`). Every office task is external, so it lands
supervised (§ Data model). The audit actor is `office:<role key>`.

**Status.** `filingStatus(effectiveAutonomy(office, role), tainted,
{queueStopped: !orchestrator.enabled})`, with the office and role RE-READ at
filing time (a human may lower the autonomy while the shift runs):

| Case | Filed as | Note on the shift row |
|---|---|---|
| `proposals` autonomy | nothing — the requests are **held** on the shift row until the proposals card converts them | `proposals autonomy — nothing filed; held for the proposals card` |
| tainted shift | `draft`, `tainted_at` set | `tainted shift — created as draft for human review` |
| global queue stopped (`orchestrator.enabled` off) | `draft` | `queue is stopped — created as draft` (the agents' own words) |
| otherwise (`auto-run`, `autonomous`) | `queued` (the scheduler is kicked) | — |

- **`agent.allowEnqueue` is NOT consulted.** It governs worker filings through
  `/api/agent/tasks`. An office's filings are governed by its own
  Origin-gated opt-ins: it starts disabled, it cannot be enabled without a
  day budget, and its autonomy level decides whether anything is queued.
- **The stopped queue IS honoured**: queue off means drafts, exactly as for
  agents.
- **No same-repo draft rule**: a shift owns no checkout, so there is no
  working tree two agents could share.

**Caps** (the office's own, never the agent ceiling):

- `maxTasksPerShift` — default 8, at most 15 (a stored value above 15 is
  clamped). The first N valid requests are kept.
- `maxOpenTasks` — default 12: the office's tasks not in a terminal status
  (`countOpenOfficeTasks`). Only the room left is filed. Held proposals do not
  count (no task exists). Filings of one office are serialized in-process, so
  two shifts settling together cannot both see the same room.
- Requests for a repo outside the office workspace, and a repeat of a title in
  the same shift, are dropped first.

Everything left out is **dropped and listed** on the shift row with its reason
(`OfficeShift.filing.dropped`). A list over the cap is never a validation error
— that would type a correction into the session.

**Decoupled from the agent ceiling.** `countQueuedAgentTasks`
(`QUEUED_AGENT_CEILING`, the 10 queued agent filings past which an agent's
filing becomes a draft) counts `office_id IS NULL` only, in both drivers. Office
tasks carry `created_by_run`, so without that a busy office would turn real
workers' filings into drafts. Agent filings never count against the office caps
either. The agent route's gate is `agentEnqueueGate` (`routes/agent-caps.ts`).

**On the shift row** (migration 55): `filed_task_ids` gets the filed ids
(appended), and `filing` (JSON `OfficeShiftFiling`; null = no tasks asked for)
records the status, the note, the `held` requests and the `dropped` ones. One
`office.filing` audit row per shift lists the filed ids, the held count and the
drops. Held and dropped entries are the shift's own text: for a tainted shift
they are untrusted, so a trusted reader gets them only through
`taintedDigest`, which copies no titles.

## Command runs

A shift never executes anything. The **only** thing that runs on an office's
behalf is a **saved repo command a human put on the role's allowlist**
(decisions.md 2026-11-05). This is the path for DevOps checks (a dependency
audit, a config lint) and SEO audits (Lighthouse, a crawl). Anything that needs
an edit or an ad-hoc shell is filed as a worker task (§ Filing). Code:
`server/src/office/commands.ts`; tests: `server/src/office/commands.test.ts`.

**The allowlist** is `OfficeRole.commands` — `[{commandId, external}]`, column
`tm_office_roles.command_ids` (migration 56), at most
`OFFICE_ROLE_COMMANDS_MAX` (20). Only `PUT /api/offices/:id/roles/:roleId/commands`
(`{commands: [...]}`, the whole list replaced) writes it. It needs `Origin`
(403 otherwise, so an agent's `curl` cannot set it) and leaves an
`office.changed` row with `action: 'role-commands'`, the named entries and the
added/removed ids. A role `PATCH` cannot carry `commands` (strict body → 400),
and no shift section writes it. Each entry must pass `allowlistCheck`, otherwise
the route answers 400 naming the entry:

- the command exists (a saved `tm_commands` row, not a one-shot),
- it is **not a check** (checks belong to the verify loop),
- it is **not archived**,
- it is **human-owned** (`owner_task_id` null; an agent-saved definition is refused),
- it is **one-shot** (`kind: 'task'`; a `service` never exits and would only ever time out),
- its repo is in the office's **workspace**.

An id listed twice is refused too. `external: true` says the command reads the
outside world (Lighthouse against a public URL). Its output is untrusted.

**The `commands` section.** A shift asks for runs in its result:
`commands: [{commandId, why}]`, at most `SHIFT_COMMANDS_MAX` (3). The prompt
lists the role's runnable allowlist under *Saved commands you may request*:
id, name, repo and command line, with a note on external ones. With an empty
allowlist it says so and tells the role to name in its notes what the human
should allow. The section's `apply` re-reads the role row and splits the
requests with `planShiftCommands` against the **current** allowlist. An id not
on it is **dropped** (`reason: "not on the role's allowlist"`), and so is a
repeat. Neither is ever run. Everything lands on the shift row
(`tm_office_shifts.commands`, JSON `OfficeShiftCommands`: `requested`,
`dropped`, `runs`, `wake`).

**The runs** start only after the shift has **settled**: its row is closed and
the session is gone. `ShiftRunner.settle` hands the shift to
`OfficeCommandRuns.runShift`, and `ShiftOutcome.commandRuns` is the promise of
the finished record. Each office's runs form one promise chain, so there is
**at most one command run per office at a time**. A shift's runs go one after
another. Before each run the service:

1. re-reads the office and the role. A role or office that is gone, an entry
   since removed from the allowlist, or a definition that no longer passes
   `allowlistCheck` (made a check, archived, deleted, moved) is **skipped**
   with the reason. `external` is read from the current entry.
2. asks `officeCommandGate`: the hard gate (`officeHardGate`) over the same
   facts as `officeGate`, settling the budget trip first, but **without the
   shift-slot test**, because a command run takes no shift slot. **Pause all**,
   an **office pause** (a human's or the budget trip's), the **office day budget**,
   the **role cap**, and an office or role that is off all skip the run. Guards
   are not consulted: they are money-saving rules for wakes, and a run costs no
   tokens.

A skip is `status: 'skipped'` with the reason on the row, plus an
`office.command` audit row (`action: 'skipped'`, `reason`, `code`). Nothing is
spawned.

A run that passes goes through `CommandRunner.runCheck` with target
`{ officeShiftId }`: the **COMMANDS pool**, argv only (`parseCommandLine` +
`resolveBin`, never a shell), `CI=1`, a **10 min** deadline
(`OFFICE_COMMAND_TIMEOUT_MS`), actor `office:<role key>`, **zero tokens** (no
claude is spawned). It is an ordinary attachable run (`CommandRun.officeShiftId`).
If a human's run of the same definition is live, the run waits for it, within
the same deadline. The row gets `exitCode` and `status: 'done'` when the
process exited, or `status: 'error'` with the reason when there was no verdict
(timed out, stopped). It also gets the **last 200 lines, ANSI stripped**
(`OFFICE_COMMAND_TAIL_LINES`, ≤ 30k characters), the duration and the
CommandRunner run id. One `office.command` audit row (`action: 'ran'`) records
it. Pause all does not kill a run already started (the commands pool is not a
worker); the next run of the chain is skipped by the gate.

**The report**: `deliverables/runs/<office-local date>-<role key>-<command slug>.md`
(`commandReportRel`; a second run on the same day replaces it). It holds the
repo, the command line, the times, the result and the output tail in a fence
the output cannot close (`fenceFor`). It never contains the shift's own `why`,
because a tainted shift's words must not reach a trusted file. A **local**
command's report is written at that path: its output is trusted, the same
trust check output already gets in `checkFixMessage`. An **external** one's
goes to `untrustedPath` of that path (`untrusted/deliverables/runs/…`), which
a trusted shift's `permissions.deny` keeps out.

**The next shift.** `ShiftRunner.plan` reads the role's previous `ran` shift.
Its runs go into the prompt as a fenced data block (*Command runs from your
last shift*: per run, the name, the outcome, the report path and the tail in a
fence it cannot close, marked as data and never instructions). `why` is left
out here too. Every **external** run that produced output (`done` or `error`
with a process) adds taint source `command-output:<command name>`
(`commandOutputTaint` → `shiftTaint`), so that shift files drafts only, writes
to the untrusted twin, and may not resume a trusted session. A local run never
taints. Only the next shift gets the block. A run still pending when that shift
starts is listed as not run yet, and the shift after it does not see it.

**The `command-done` trigger** (`{kind: 'command-done'}` in `triggers`,
opt-in, no preset has it) wakes the same role **once** after its runs finish,
and only when at least one run actually ran. It goes through `officeGate` with
the trigger `event`/`command-done`, so the hard gate **and the guards** apply.
A role with a `cooldown` guard will see that wake skipped, because its last
shift ended minutes earlier. A refusal (gate, guard, or `ShiftRunner.start`
refusing, for example another shift of the office being live) is written as a
`skipped` shift row with the reason and an `office.shift` audit row. The
record's `wake` holds the started shift's id or the skip reason. A shift
started by this trigger **never chains another** wake, so a role that asks for
commands every shift cannot loop.

**Restart.** Shutdown stops the chain (`OfficeCommandRuns.stop`, before
`commandRunner.stopAll`). Boot (`recoverOnBoot`) closes what was left:
`pending` becomes `skipped` and `running` becomes `error`, both with
`interrupted by restart`. A run is never re-run at boot, because the moment
it was asked for has passed.

## Scheduler and states

`server/src/office/scheduler.ts`, test `scheduler.test.ts` (temp SQLite, an
injected clock, a fake shift starter). Modelled on the daily digest
(`telegram/digest.ts`): `OfficeScheduler` ticks every minute
(`OFFICE_TICK_MS`), single-flight, and is started by `index.ts` after the
server listens (a shift's hooks curl back to it) and after the shift runner's
boot recovery. Shutdown calls `stop()` before `shiftRunner.stop()` and waits for
nothing: a live shift is an aux run, ended by `aux().stopAll()` and closed by
the runner's boot recovery.

### Whether a slot is owed

Two persisted facts per role, so a restart or a Mac asleep for hours changes
nothing:

- **lastSlot**: `trigger.at` of the role's newest **cron** shift row, ran or
  skipped (`lastCronSlot`, `listShifts({ roleId, triggerKind: 'cron' })`).
- **armedAt**: `tm_office_roles.armed_at` (migration 57, `OfficeRole.armedAt`),
  when the schedule started counting. It is set on create, and re-set to now when
  a role is turned on or its schedules change (`roleRearms`, role PATCH), and for
  every role of an office that is turned on or re-zoned (office PATCH). Rows from
  before migration 57 were back-filled with their creation time. An unreadable
  value arms now (`roleArmedAt`), so a past slot is never invented.

Each tick, for every **enabled** office and enabled role with schedules,
`dueSlots(role, lastSlot, armedAt, now, tz)` gives at most one wake: the latest
due slot. Six hours asleep is one wake per role, not one per missed slot (the
test sleeps an hourly and a quarter-hourly role through 6 and 24 slots). Wakes in
one office are judged oldest slot first, so a busy office cannot starve a role.
A disabled office is not woken at all, and nothing is written for it.

### What happens to a due wake

Each wake goes through `officeGate(…, { kind: 'cron', ref: <schedule>, at: <slot> })`
on fresh office and role rows, then `ShiftRunner.start`:

| Outcome | Rows written |
|---|---|
| **pass** | the runner's shift row: trigger `cron`, `ref` = the schedule, `at` = the slot |
| **skip**: a guard (`code: 'guard'`), a hard-gate refusal other than `slots` (office paused, Pause all, day budget, role cap…), or a runner refusal no retry fixes (`tools`, `folder`, `role`) | a shift row with verdict `skipped`, `skip_reason`, `skip_code` (migration 57), started and ended now; plus an `office.shift-skipped` event (coalesced, below). The slot is consumed. |
| **defer**: the hard gate's `slots`, or the runner's `office-busy` / `busy` / `paused` | no shift row: the slot stays owed and is tried again next minute (once free, it runs with the original slot as `at`). One coalesced `office.shift-deferred` event. |

Deferral exists because a role whose slot falls while another role of the same
office is on shift (1 live shift per office) would otherwise lose that slot.

**Coalescing.** An `office.shift-skipped` / `office.shift-deferred` row is
written at most once per role per reason class per hour
(`OFFICE_SKIP_COALESCE_MS`). The class is the code plus the guard's kind
(`guard:cooldown`, `office-paused`), not the reason text, because a cooldown's
"last shift 20 min ago" reads differently every minute. The map is in memory,
and on a miss (a fresh process) the last hour of rows is searched by `roleId` +
`reasonClass`, so a restart does not write a second row. The next row written
for a key carries `suppressed`, the number of skips folded into the previous
one. Event data: `officeId`, `workspaceId`, `roleId`, `roleKey`, `code`,
`guard?`, `reasonClass`, `reason`, `schedule`, `slot`, and for a skip `shiftId`
and `missed`. The shift rows themselves are never coalesced: there is one per
judged slot.

### Wake now

`POST /api/offices/:id/roles/:roleId/wake` `{ note? }` (≤ `OFFICE_WAKE_NOTE_MAX`
= 4000 chars). It needs Origin (403 without, like every office write) →
`OfficeScheduler.wake`. It is a stakeholder request, so the trigger is
`{ kind: 'request', ref: 'human' }`. It still passes the **hard gate**: 409
`{ error, code }` with its reason (`office paused: holiday`, `office-paused`), and
the same for a runner refusal (`a shift of this office is already running`). It
skips the guards, cooldown included. The note is **trusted** text (a human typed
it in the dashboard). It goes into the shift prompt as a `## The request` block
(`ShiftTriggerInput.note`) and never taints the shift. A refusal writes no shift
row. A start answers 202 `{ shiftId }` and appends an `office.wake` event
(actor `human`, with the note). 404 for an unknown office or role.

### States

`officeStates(storage, officeId, now)` gives `OfficeStates`
(`{ officeId, at, states: OfficeRoleStateEntry[] }`, each entry = `roleState`'s
`{ state, detail }` + `roleId` + `nextSlotAt`). It reads the latest facts and
writes nothing (the budget is not settled):

- the office row and Pause all;
- today's spend, office-wide and per role;
- the live (open, ran) shifts, which give `on-shift` with `on shift since 14:02 (cron)`;
- each role's newest shift. A `skipped` one with `skip_code = 'guard'` is the
  `lastGuardSkip`, so the state reads `guarded` with `skip: quiet hours (22:00–07:00) · next 09:00`.
  Hard-gate skips are not "guarded": the `paused` / `over-budget` / `off-duty`
  states already say why.

Otherwise the state is `scheduled` with `next 09:00`. `waitingForYou` and
`inHuddle` are 0/false until the phases that bring proposals cards and huddles.

`GET /api/offices/:id/states` returns them (404 for an unknown office). They are
broadcast in `office.updated` (`states`): by the scheduler after each tick, only
for an office whose states changed since its last broadcast; by every office
route's `announce`; and by the shift runner when a shift ends.

## Role-tagged work

A task a shift filed carries `role_id` (§ Filing). Its worker is an ordinary
worker, but it should know who asked and what that role already knows.

**The role block** (`Orchestrator.officeContext` beside `sharedContext()` in
`startWorker`; text from `roleContextBlock` in `server/src/office/role-context.ts`;
`buildWorkerInvocation`'s `officeNote`). A FRESH session of a task with a
`roleId` starts with:

```
## Office role: <name> — <title>
This task was filed by the office role "<name>". …
### Role brief
<the role's prompt>
### Role notes (roles/<key>.md)
<the notes file, read like a shift reads it: realpath-checked, ≤ 96 KB>
```

It goes above the shared-space block, at the very top of the prompt.

- **Notes and taint.** Untainted notes (`notesTaintedAt` null) are always
  inlined. Tainted notes are inlined only when the task itself is tainted
  (`Task.taintedAt` set): such a task already carries untrusted input, so the
  notes add no new exposure. It reads the untrusted twin first, as the shift
  runner does. An untainted task of a role with tainted notes gets the
  `ROLE_NOTES_WITHHELD` line instead ("withheld … a human has not reviewed
  them"). Neither the trusted file nor the twin is inlined.
- **Never on a resume.** The session already read it. The same goes for the
  first resume after a gate compaction, unlike the definition of done: the
  role is context, not a rule the compact summary must preserve.
  `compactPreserve`/`postCompactRules` are deliberately unchanged, so the block
  is never duplicated into compaction focus or post-compact context.
- **Never on the publish turn**, fresh or resumed (`purpose === 'publish'`, and
  `buildWorkerPrompt`'s `isPublishTurn` as a second belt).
- **Best-effort**, like the shared space. A missing role or office, or a read
  error, spawns without the block (logged).

Tests: `server/src/office/role-context.test.ts`.

**In the SPA.** A `RoleChip` (avatar + name) shows on `TaskRow`, the task panel
head, the four board versions and the timeline hover card. The board search
takes `role:<name>`. The roles come from the store's `offices` slice, which
follows `office.updated`. Details are in docs/board-versions.md § What shipped
→ Role chip.

## UI

_To be filled by the UI phase._
