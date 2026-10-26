# Inbox, bulk actions and task templates

Autonomy part 5 of 6 (decisions.md 2026-10-19). Parts 1–4 made most work land
on its own. This part makes the gates that are still the human's fast to clear:

- one **Inbox** of everything waiting on you, the same list in the browser and
  on the phone;
- **bulk actions** on the board;
- **task templates** for the prose you would otherwise retype.

## The Inbox

### What is in it

`buildInbox()` in `shared/src/types.ts` builds the list. It is a pure function
over tasks, questions, runs, proposals and features, and it is the only
definition of the list. The SPA's Inbox page and its header chip run it over
the live store. Telegram's `/inbox` (and the 📥 tab of `/tasks`) run it over
storage reads. So the two surfaces always show the same items in the same
order.

The items appear in this order. A task appears once, under its first kind.

| # | kind | what | desktop keys | Telegram buttons |
|---|---|---|---|---|
| 1 | `question` | a task with a pending agent question (`tm_questions`), one item per task | answer inline (`QuestionForm`), `o` | ❓ Answer |
| 2 | `attention` | a `running` task whose live, non-idle run is flagged needs-attention (a dialog in a hidden terminal) | `t` terminal, `o` | ✖ Kill |
| 3 | `review` | a task in `review` whose automatic verify round is **settled** (not `verifyOpen`) | `p` publish, `d` mark done, `f` send findings back (flagged only), `o` | ✅ Done · 🚀 Publish |
| 4 | `failed` | a task that failed in the last `INBOX_FAILED_DAYS` (7) | `r` retry, `p` resume (limit-stopped only), `o` | 🔁 Retry |
| 5 | `blocked` | a blocked split parent, with its subtasks settled / failed | `a` unblock, `o` | ⛔ Unblock |
| 6 | `proposal` | a pending analysis proposal (rewrite, split, new task, options) | `a` accept, `x` reject, `o` | ✅ Accept (only without options) · ✖ Reject |
| 7 | `feature` | a feature plan in `proposed` | `a` approve, `o` opens the plan | ✅ Approve |

- **Questions and attention come first** because each holds a live session,
  which means a worker slot and the repo with it.
- **Review comes next**: it holds a landing, and through the feature gate it
  may hold later phases.
- **Failed and blocked follow**: each holds a retry or a tree.
- **Proposals and plans come last**: they are new work that nobody waits on
  yet.
- Two things are left out on purpose:
  - A `review` task with an open round (`checking`, `auto-review`, `fixing`).
    The machine is still working on it.
  - A `waiting` task.

### Order within a kind

Within a kind, items are sorted by **`unblocks`**: how many open tasks this
decision releases. That count has two parts:

- later-phase tasks of the same feature, which the phase gate holds until this
  phase settles;
- blocked split ancestors. A parent waits on every child, so a failed child of
  a blocked parent ranks above an unrelated failure.

Rows with an `unblocks` count above 0 show **frees n**. Ties break oldest first,
since what has waited longest goes first.

Review has one more tiebreak: a **ready** review comes first. Ready means
`landingReason` holds (checks green or none, review clean or none), so `p`
publishes it with nothing left to read.

### What a review row shows

Everything the decision needs is inline:

- the ready reason;
- the **diff stat**;
- the review headline (`reviewHeadline`);
- one chip per check result: green ✓, red ✗ with the exit code, error ⚠, and
  `re-run` when the flaky guard ran it twice;
- the reviewer's summary and its findings, by severity;
- cost (`Task.costUsd`) and attempts (`Task.attempts`) on the row.

**The diff stat** is `{ files, insertions, deletions }`, kept on each
`ReviewRound` as `diffStat`. It is counted by `diffStat()` in
`claude/review.ts` off the same diff text the reviewer read: the task's
commits plus the uncommitted rest, before truncation.

- Counting it there means no second git read. Specifically, no `git add -N`
  runs against a checkout another task may be working in.
- Files are distinct `diff --git` paths. A file both committed and left
  uncommitted counts once.
- Lines are `+`/`-` lines inside a hunk. The `+++`/`---` file headers and
  `workerDiff`'s own section markers never count; a removed line that itself
  began with `--` does.

The stat exists only where a review ran. A review-off task, or a round from
before this change, has none, and the row simply leaves it out. There is
deliberately no on-demand diff route.

### Desktop: the keyboard

`/inbox` is the page. The selected item is expanded in place, with its actions
as buttons that show their key.

| key | does |
|---|---|
| `j` / `↓`, `k` / `↑` | move |
| `p` | publish (review): primary only when the item is ready. Over a flagged review or red checks it reads **Publish anyway** and asks first, restating the verdict (`docs/publish.md` § The verify gate) |
| `d` | mark done (review): closes the task **without pushing** |
| `f` | send findings back (flagged review): `POST /apply-review`, the same session fixes the blocker/major items. It is the primary on a flagged item |
| `a` | unblock (blocked), accept (proposal without options), approve (feature plan) |
| `r` | retry (failed): `POST /retry`, so the fresh agent gets the `## Previous attempt` block (design.md § Retry with context) |
| `p` (failed) | resume (limit-stopped only): `POST /proceed`, the task's own session (§ Retry or Resume) |
| `x` | reject (proposal) |
| `t` | open the terminal (needs attention) |
| `o` / Enter | open the task panel, or the plan for a feature |

- **When a decision removes its item, the selection stays on the same
  position.** The next item is then under the cursor, so a run of
  `p d p r a` clears a morning.
- **A key never fires twice by accident.** Auto-repeat (`e.repeat`) is
  ignored. After an act its key is dead for 600 ms (`ACT_COOLDOWN_MS`), unless
  you move the cursor with `j`/`k` or the mouse. Holding `d`, or pressing
  `d d`, does not also close the next item.
- **On a review item the primary is never Mark done.** Ready → Publish;
  flagged → Send findings back; red checks or no clean verdict → Open.
- **Keys are ignored** while you type in a field, inside a terminal, or while
  any dialog, sheet, task panel or the search popover is open. `o` opens the
  panel with focus inside it, and **Escape** closes it again (the first Escape
  in a field only leaves the field), so triage carries on without the mouse
  (`docs/design.md` § Desktop dialogs).
- **Enter is ignored** on a focused button, because there it is that button's
  click.
- **A refusal is shown on the item** (a 409's text, for example) and the
  selection stays where it was.
- **An options proposal** shows its options as buttons. `a` is disabled for it,
  because it is a choice.

### Retry or Resume

A failed task is continued in one of two ways, and the SPA names them the same
everywhere (UX review #20, 2026-10-26):

- **Retry** starts a fresh agent, told what the last attempt hit
  (`## Previous attempt`). Pick it when the attempt went wrong.
- **Resume** reopens the agent's own session (`POST /proceed`). Pick it when
  the terminal died mid-task (the usage limit, a dropped connection, a
  restart) and the work so far was right.

The Inbox's failed row always offers Retry. It adds **Resume**, and leads with
it, only when the usage limit stopped the task: `wakeAt` is set, or the error
names the limit (`limitStopped` in `components/Inbox.tsx`, a text test that
only decides whether the button shows; a wrong guess costs a button, and the
server still refuses a task with no session). The task panel, on a failed or
cancelled task, calls Enqueue **Retry** and Run now **Retry now** (the same
server moves, through the queue or ahead of it) and calls the follow-up box's
Proceed **Resume**. A hint under the error says which to pick. Telegram keeps
its `/proceed` command and 💬 Proceed button; they are the same call as Resume.

### Header chip

`InboxChip` (`components/Inbox.tsx`) shows the count, and is hidden at zero.

- It turns attention-coloured while a question or a prompt is in the list.
- On a desktop it sits next to the question chip and opens `/inbox`.
- On a phone the Inbox chip **replaces** the question chip (questions head the
  Inbox anyway). It is the urgent shortcut only (`urgentOnly`): it counts the
  questions and needs-attention items and is hidden while there are none,
  because the **Inbox tab** carries the full count (docs/mobile.md § The
  shell). When agent questions are the only urgent items, a tap reopens the
  question sheet directly (`nudgeQuestions`, the desktop ❓ chip's action).
  Otherwise it opens the sheet stack.
- The Inbox is a **tab** on the phone (Dashboard · Inbox · Board · Queue · More,
  2026-10-26, UX review #12), with the count on its icon, and is in the
  desktop sidebar and the More sheet.

### Phone: a Sheet stack

The chip opens `InboxSheet` (`docs/mobile.md` § Sheets):

1. a tall sheet of rows;
2. a row opens **its own sheet on top** (z-index 36), holding the row's
   metadata, the same detail as the desktop, and the actions as
   `SheetAction`s with hints.

- **After a decision** the item sheet closes and you are back on the list,
  which has already dropped the item.
- **Open and Terminal** close the whole stack first, so two stacks never share
  the screen with the task panel or the terminal drawer. Closing a terminal
  opened from an item brings the stack back on that item (`docs/mobile.md`
  § Returning from a terminal).
- **The `/inbox` route on a phone** shows the same rows inline and the same
  item sheet.
- **Glass:** every sheet is Liquid Glass.

### Telegram `/inbox`

`/inbox [repo]` opens the board's 📥 view (`docs/telegram.md` § The board).
That view's items now come from `buildInbox`, so it matches the SPA's order
and filtering. A review row's detail line joins the check clause, the review
clause and the diff stat. A blocked row adds its subtasks line. The buttons are
the unchanged action codec.

## Bulk actions

On the Board, **Select** (next to search) switches the rows to multi-select:

- a press ticks a row instead of opening it;
- drag is off;
- a sticky bar offers **Enqueue · Add to queue · Mark done · Cancel ·
  Model… · Effort…**.

Selection order is tick order, and **Add to queue** joins the custom queue in
that order (FIFO). **Cancel** arms on the first press (`Cancel n?`) and fires
on the second within 4 s, because it kills running agents and a browser
`confirm()` would block the page; **Mark done** arms the same way (`Mark n
done?`), since it closes reviews without publishing (`src/arm.ts`, `docs/mobile.md`
§ Confirming destructive actions).

A ticked row that a later search or filter hides **stays selected** and is
still acted on, so the count says so: `3 selected (1 hidden by filter)`.

### The route

```
POST /api/tasks/bulk
{ "action": "enqueue" | "queue" | "cancel" | "complete" | "hide" | "unhide" | "edit",
  "ids": ["…"],                      // 1..100, de-duplicated, run in order
  "patch": { "model"?: string|null, "effort"?: EffortLevel|null } }   // edit only
→ 200 { action, results: [{ id, ok: true, task } | { id, ok: false, code, error }], ok, failed }
```

- **It loops over `task-actions.ts`**, one id at a time, calling the same
  function the single-task route calls: `enqueueTask(…, ENQUEUE_FROM)`,
  `queueAddTask`, `cancelTask`, `completeTask`, `setHiddenTask` (hide/unhide,
  `docs/design.md` § Hidden tasks), `editTask`. Actor is `human`.
  There is no second copy of lifecycle logic, so every refusal, broadcast,
  audit row and `maybeSchedule` is the single route's own.
- **A refusal is that id's result** (`{ ok: false, code, error }`), never the
  batch's. A throw becomes a per-id 500.
- **`Origin` is required** (403 without one), like the other human-only routes,
  because a worker's curl carries none. A foreign `Origin` is refused by the
  global hook as everywhere.
- **The body is strict.**
  - `edit` needs a patch.
  - A patch on any other action is a 400.
  - The patch takes only `model` and `effort`.
  - An unknown action is a 400.

In the SPA the bar reports `n of m <verb>, k refused` and lists each refused
task with its reason. The refused ids stay selected and the rest drop out.

## Templates

A template is task **content**: the prose and the done-definition you would
otherwise retype ("Bug fix", "UI change + screenshot", "Refactor, no behaviour
change"). Presets stay as they are and cover only model, effort and review. A
template can name a preset, but it does not replace one.

```ts
interface TaskTemplate {
  id: string;              // t-xxxxxxxx (TASK_TEMPLATE_ID_RE)
  name: string;            // ≤ 32, unique (case-insensitive)
  title: string;           // pattern: "{}" is where the typed title goes; without "{}" it is a prefix
  description: string;     // skeleton ('' = none)
  acceptance: string;      // definition of done ('' = none)
  checks: string[] | null; // repo check names; null = the repo's default (all); [] = none
  preset: string | null;   // a TaskPreset id, built-in or custom
}
```

### Storage and validation

Templates are stored as the `task.templates` setting in `tm_config` (at most
20). They are not a table, for the same reason `presets.custom` is not one:
they are a small, user-owned list that is read whole.

They are edited on **Config → Templates** and saved with the page's Save.

`PUT /api/config` validates the shape with zod and the list with
`taskTemplateProblem`. The Config page shows that same function's message
inline. The rules:

- ids are unique;
- names are unique;
- a title pattern holds at most one `{}`;
- a named preset must exist, among the built-ins or the custom presets as
  saved in **the same body**, falling back to the stored ones.

A preset deleted later leaves the template pointing at nothing. On use, that is
simply "no preset".

### The helpers

All in shared, used by both surfaces:

- **`applyTitlePattern(pattern, typed)`**: `Fix: {}` + `login 500s` →
  `Fix: login 500s`; `Refactor:` + `x` → `Refactor: x`.
- **`applyDescriptionSkeleton(skeleton, typed)`**: the typed text on top, the
  skeleton below it.
- **`templateChecksFor(template, repoCheckNames)`**: check names belong to a
  repo, so only the names that repo has are kept. A template whose names match
  **none** of the repo's checks falls back to `null` (all of them). A template
  written for another repo must never silently switch the checks off. An
  explicit `[]` stays "none".

### New task form

When templates exist, a **Template** row of chips sits above the Title.
Picking one does the following:

- fills the description with the skeleton, below whatever you already typed;
- fills the definition of done when it is empty;
- maps the template's checks onto the chosen repo (again when the repo
  changes);
- applies its preset's model, effort and review.

What the previous template put in, and nobody edited since, is replaced rather
than stacked under the new one. The title field holds what you type, and the
pattern is applied at Create: the field's placeholder shows the pattern, and a
"Files as: …" line shows the result. Every field stays editable, because a
template is a form fill and never a link.

### Telegram `/new`

When templates exist, `/new` asks for one right after the repo
(`w:<seq>:tpl:<id|none>`, resolved again at press time). The flow then runs as
follows:

1. The title prompt shows the pattern, and the typed title is patterned.
2. The description step shows the skeleton. A message goes above the skeleton,
   and **Skip** keeps the skeleton alone.
3. The definition-of-done step shows the template's text. **✓ Keep the
   template's** keeps it, and a message replaces it.
4. A template preset that still exists skips the preset keyboard and goes
   straight to Landing. Otherwise the preset keyboard is offered as usual.
5. The checks are mapped onto the repo at create time.

A seeded `/new <text>` applies the template to the seeded title and body and
goes on to the preset step. The summary names the template and its checks.

## Verification (2026-10-19)

- **Build**: `npm run typecheck` is clean. The SPA was built with `vite build`
  to a scratch outDir, so the live `web/dist` is untouched before review.
- **Bulk and settings routes**: a throwaway Fastify harness ran the task and
  settings routes over a **copy** of the live DB, with a stub orchestrator and
  no boot recovery, and was curled on a scratch port.
  - A missing `Origin` → 403.
  - `edit` of model and effort on 2 tasks plus an unknown id → 2 ok, 1 × 404.
  - `queue` → one ok with its custom-queue mark, one 409 "assign a repo".
  - `enqueue` with a duplicate id → it ran once.
  - `complete` → a review task becomes done, a queued one gets 409 "not in
    review".
  - `cancel` → 2 ok.
  - 400s: an empty `ids`, `edit` without a patch, a patch on another action,
    an unknown action, `patch.status`.
  - `edit {model: null}` → back to the default.
  - `PUT /api/config` accepted a template and rejected: an unknown preset, a
    duplicate name, two `{}` slots, a bad id. A template naming a custom preset
    saved in the same body was accepted.
- **Shared helpers and Telegram**: a throwaway script over the same DB copy.
  - The shared helpers' outputs were checked, and `diffStat` was checked on a
    mixed committed/uncommitted diff whose SQL lines begin with `--`/`++`
    (2 files, +4 −1: hunk lines count, file headers and markers do not).
  - `buildInbox` ran on live data, and `/inbox` rendered through `renderBoard`.
  - `/new` ran end to end with a template: repo → template → title
    `login 500s` → skip description → keep the definition of done → straight
    to Landing with Complex → draft. The result was
    `Fix: login 500s`, with the skeleton, `repro passes`, fable/high/review on,
    and checks `null` (that repo has no `typecheck` check).
  - A seeded `/new` with **No template** went to the preset keyboard.
- **Browser**: Playwright (chromium-1243) against the live API through Vite.
  - Synthetic review, failed and blocked tasks plus templates were injected
    into the GET responses, and every non-GET was aborted (except a stubbed
    bulk reply), so nothing live was mutated.
  - Both designs were checked, at 1440×900 and at 393×852 (touch, iPhone UA).
  - The kinds came out in order, with the ready review first and the failed
    child of the blocked parent (`frees 1`) above the unrelated failure.
  - `j j k` moved the selection, and `a` fired `POST …/complete`; its aborted
    request showed as the item's error.
  - Board Select: 2 rows ticked, drag grips gone, Enqueue reported "1 of 2
    enqueued, 1 refused" with the reason, and the refused task stayed selected.
  - The template filled the form and showed "Files as: Fix: login 500s".
  - On the phone, the chip opened the sheet and a row stacked its sheet on top.
    The header and the page had no horizontal overflow.
- **Not exercised**:
  - The live server, which was not restarted. Until it is, the live API has no
    bulk route and no `task.templates` key.
  - Real round-trips through the bot's API.
  - The Postgres driver: no schema change; `task.templates` is a config row.
  - A real reviewer round writing `diffStat`.
