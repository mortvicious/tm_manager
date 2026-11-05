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
types at the end of `shared/src/office.ts`, and `server/src/routes/offices.test.ts`.

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

Tainted notes stay where they are (`roles/<key>.md`); the rule is what keeps
them out. The rules bind the read-family tools only (measured below). A shift
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
  (1…`CONCURRENCY_MAX`), `maxTasksPerShift` (1…20), `maxOpenTasks` (1…200),
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

_To be filled by the phase that runs shifts (aux kind, prompt, sweep, filing)._

## UI

_To be filled by the UI phase._
