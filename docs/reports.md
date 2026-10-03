# Reports

Status: **shipped 2026-09-08**.

A **report** is the document you hand to whoever paid for the work: pick several
repos and a date range, and one claude session (an aux terminal) turns the tasks that *finished*
in that window into a short, business-facing markdown document — grouped by
completion date, one bullet per delivered change, in Russian or English.

It is deliberately **not** the Telegram report (`server/src/telegram/report.ts`,
[`telegram.md`](telegram.md) § Reports). That one is an ops status page for the
operator: numbers, runs, tokens, problems, what needs a decision. This one has
no machinery in it at all — no run counts, no costs, no task ids, no file names.
Two audiences, two documents, and the older one was single-scope and
`since`-only, so there was nothing to extend.

| | Telegram `/report` | Reports |
|---|---|---|
| audience | the operator | the client |
| scope | one period / task / feature / group | **several repos** + a date range |
| shape | self-contained HTML, sent as a file | **markdown**, previewed and downloadable |
| written by | deterministic JS aggregation | one claude session (aux terminal, kind `report`) |
| language | Russian summary + English body | **Russian or English**, whole document |

## The surface

`/reports` in the SPA (`web/src/pages/Reports.tsx`), a nav entry like any other
page — not a header button, so the mobile tab bar's More sheet picks it up for
free from `NAV`.

- **Repos** — toggle chips, one or more. This is the point of the feature: a
  backend and a frontend repo are one product to the person reading the report.
- **Period** — `today` · `3 days` · `week` · `month` · `custom`. The presets
  count **back from today inclusive**: "3 days" is today and the two before it,
  because that is what the label promises on a board you opened to see today's
  work. `custom` shows two native date inputs.
- **Language** — `Русский` / `English`, a property of the **artifact**; the SPA
  itself stays English.
- **Title** — optional, defaults to the selected repo names joined.
- **Model** — optional override; defaults to `analysis.model`.

`POST /api/reports` answers **202 with a `pending` row**, like the chat send
route: a claude turn outlives any HTTP timeout, so the page follows the row over
`/ws/events` (`report.updated` / `report.deleted`) instead of holding a request
open. You can leave the page while it writes.

## What goes in

**Delivered tasks only** — `done` and `published`. `failed` and `cancelled` are
in `TERMINAL_TASK_STATUSES` but delivered nothing, and a report of completed
work must not list them; this is the same narrower test `telegram/report.ts`
already uses.

**The completion date comes from the audit log, not from `updated_at`.** The
`task.transition` row that moved the task to `done`/`published` is when the work
actually landed. `updated_at` keeps moving — a title fix, a category label or a
late dispatch note months later would silently re-date delivered work into the
wrong section, and into the wrong report entirely. `updated_at` is the fallback
only for rows old enough to predate their own transition event. A task that
landed twice is dated by the **first** time, so a re-publish does not appear on
two days.

Days are bucketed on **server-local** time (`reports/range.ts`), the same reason
`routes/stats.ts` does its bars in JS: SQL `date()` on UTC splits a Baku evening
across two dates, and the document prints those dates.

Per task the agent is shown title, repo (and role), category, description,
`resultSummary` and the **reviewer's** own summary of the change — an
independent read of the same work, and often the more accurate of the two.
Fields are truncated so the prompt stays a prompt.

Caps: `REPORT_TASK_CAP` (400) tasks per report and `REPORT_MAX_DAYS` (366) days
per window. Over the task cap the **oldest** are dropped and the prompt says so
— a truncation the document does not admit to would be a lie about the period.

## What comes out

**The document shape is assembled by the server; the model only writes prose.**
The agent returns `{ summary, days: [{ date, bullets }] }` against a
`--json-schema`, and `renderMarkdown` builds the heading, the repo line, the
"dates are completion dates" note and the `### DD.MM.YYYY` sections around it.
So a malformed heading cannot reach the file, and — the reason this is worth the
indirection — **an invented date cannot either**: a `date` that is not one of
the days actually gathered is dropped. If nothing survives that filter the
report **fails** rather than emitting a heading with no work under it, which is
worse than an honest failure the human can re-run.

A window that delivered nothing is a legitimate **answer**, not a failure: the
document says so, `taskCount` is 0, and **no agent is spawned at all**.

## Language

`ReportLanguage` is `'ru' | 'en'` and governs the agent's prose *and* the chrome
the server assembles — both string sets live in one record per language in
`server/src/reports/language.ts`, including the labels on the raw records fed to
the model, so an English report is not primed by a Russian input sheet. If the
two halves came from different places, a Russian document could end up under an
English "Repositories:" line. The schema's own field descriptions are in the
target language too, so the model is told what to write in twice.

## The run

One aux terminal of kind `report` (`docs/design.md` § PTY sessions), with a
`tm_runs` row whose `subject_id` is the report. It shows in the runs list, can be
attached and killed there, and is covered by `/killall` and the restart guard like
every other aux session. The prompt is the positional argument, and it ends with
the fenced-JSON result instruction built from the same per-language schema
`--json-schema` used to receive. `parseOutput` reads the `{summary, days}` block
out of the final message. `--permission-mode dontAsk`.

It gets **no built-in tool at all** (`--tools=`), and the denials
`Edit Write NotebookEdit Bash` stay as belt and braces. A report is a pure text
transformation over rows this process already read, and it has no business
touching a repo. `cwd` is the first selected repo, so that it is a real directory
the CLI already trusts. Fable → Opus 5.5 xhigh fallback, same as `review.ts`:
an unavailable model now surfaces as a StopFailure `model_not_found`.

Deleting a report aborts its session through an `AbortController`, and a delete
that lands before the PTY exists stops it at spawn. A Kill in the runs list, or
`/killall`, fails the report with "the report session was stopped".

`MAX_CONCURRENT` is **1**. A report is a rare, human-pressed button, and one at
a time keeps a double-click from paying for the same document twice. It never
takes a worker slot.

Two holes a run with no run row would otherwise leave, both closed:

- **Delete mid-run** — `abortReport(id)` kills the child *before* the row goes,
  so the agent cannot outlive what it was writing into. `settle()` returns false
  when the row is gone and nothing more is said about it.
- **Crash mid-run** — `recoverReportsOnBoot()` fails everything left `pending`
  or `running`, the same hole `chat.recoverOnBoot` closes for a stranded lock.

## Storage

Migration **24**: `tm_reports`, FK-less like `tm_events` and `tm_questions` —
the row records what was delivered in a window and must outlive the repos it
names. `repo_ids` is a JSON array (a report is multi-repo by definition, so
there is no single `repo_id` to hang an FK on). The same migration adds
`tm_tasks_updated_idx`, without which a month-wide report scans the whole table.

Plain CRUD, no composite: unlike a task there is no state machine, and only one
writer ever touches a given row. `reportPatchColumns` lives in `rows.ts` and is
shared verbatim by both drivers so an added field cannot land in one and not the
other.

`TaskFilter` gained two fields, mirrored in both drivers:

- **`updatedUntil`** — the closing bound. `updatedSince` alone answers "since
  when"; a report answers "between".
- **`repoIds`** — disjunctive, and *not* a replacement for `repoId` (the
  single-repo fast path every other caller uses). An **empty array matches
  nothing**: a report over no repos has no scope, and silently widening that to
  "all repos" would put private work into a document that did not ask for it.

## Routes

| | |
|---|---|
| `GET /api/reports` | list, newest first |
| `GET /api/reports/:id` | one |
| `POST /api/reports` | create + start; **202** with the `pending` row |
| `POST /api/reports/:id/regenerate` | re-run over the same repos and window; 409 while one is in flight |
| `DELETE /api/reports/:id` | aborts the agent first, then deletes |
| `GET /api/reports/:id/markdown` | the document as a `.md` download; 409 before it exists |

Every repo id must exist (404 otherwise) — a silently-dropped repo would produce
a document naming fewer repos than the human selected without saying so. The
body is `.strict()`, so an unknown field is a loud 400.

The download filename is slugged to **ASCII**: the title is user text and may be
Cyrillic, which a bare `filename=` header cannot carry.

## Verification

`server/src/reports/` and the route module were driven against a **copy of the
live database** (118 delivered tasks across 3 repos) — 48 checks, all passing:
migration 24 and its columns and index; `repoIds` disjunctive, single-id
equivalent and empty-matches-nothing; `updatedUntil` closing a dead window;
every range preset and six malformed custom ranges (missing end, reversed,
non-date, 31 February, over the cap); `gatherTasks` returning only
`done`/`published`, date-ascending, every day a valid key; the seven route
refusals; the 202 and the row's shape; 404/409 on the read paths; and
`renderMarkdown` dropping an invented date, a blank bullet and a doubled
leading dash while keeping the day order.

Then the real thing, twice, against that copy: a Russian week report (18 tasks,
33 s) and an English 3-day report (14 tasks, 23 s), both `ready`. Both documents
are attached to the task that built this feature.

`npm run typecheck` and `npm run build` pass.
