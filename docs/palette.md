# The ⌘K palette

A global "go to" box: from any page, jump to a task, a page, a repo, a
workspace, a feature or a chat without reaching for the sidebar, run a task's
actions, and run the global commands. Phase 1 of the feature *Review deck,
global ⌘K palette, agent-draft triage* shipped the navigation; phase 2 added
the task actions (§ Task actions), the global commands (§ Global actions) and
the quick create (§ Quick create), all on the same entry model (§ Entries).

- `web/src/palette.ts` is pure: the entry model, the fuzzy scorer, the ranking,
  the entry builder and the MRU.
- `web/src/components/Palette.tsx` is the UI: the hotkey, the overlay and the
  keyboard. It is mounted once in `App.tsx`, beside `QuestionModal`.

## Opening it

- **⌘K** on a Mac, **Ctrl K** elsewhere, works on every page. Pressing it again
  while the palette is open closes it.
- The hotkey is ignored in three cases:
  - **inside a terminal** (`.xterm`): a terminal owns every key typed into it,
    so ⌘K in an attached terminal does nothing;
  - **while the board search popover is open** (`.bs-pop`): its field has the
    keys;
  - **while an agent's question (`.qmodal`) or an image lightbox is up**: both
    sit above everything, so a palette opened under them could not be seen.
- **On a phone** use the **search button** in the header, beside the
  connection dot, or **Search & jump…**, the first tile of the More sheet. Both
  call `openPalette()`, which dispatches the window event `tm-palette`.

## Shape

- **Desktop**: the board search's Spotlight panel (`.pal-root` > `.overlay.pal-overlay` + `.pal-pop`).
  - It uses the same geometry and z-order as the board search (37/38): above
    the task panel, under an agent's question.
  - The lines reuse the board search's option classes (`bs-field`, `bs-opt`,
    `bs-section`, `bs-foot`…).
  - Focus is `useDialogFocus`: it moves into the field (`data-autofocus`), Tab
    wraps inside the panel, and on close it goes back where it came from.
  - The exit animation is `exitGhost`: in Glass, `.pal-root.tm-exit .pal-pop`
    fades out like the board search.
- **Phone**: a tall `<Sheet>` (`.pal-sheet`). Its field and list are its
  children, so they live in the library's scroller. **Done** is in the head,
  and the sheet's own Escape and drag close it.
- **Modal**: `aria-modal="true"`, on both the panel and the sheet. That is what
  makes the keys underneath go inert:
  - the Inbox and Review deck read `keyIsOurs`, which bails while any
    `[aria-modal="true"]` exists, so j/k/Enter do nothing while the palette is
    open;
  - the Board's N bails the same way;
  - the task panel's Escape (`topmostDialog`) leaves the key to the palette.
- **Styles**: `--tm-*` tokens only (`theme.css` § the ⌘K palette's lines).
  `glass.css` has three additions: `.pal-pop` joins `.bs-pop`'s material rule,
  its exit joins the board search's, and `.pal-btn` joins the header's
  conn-dot capsule.

## Keys

| Key | What it does |
| --- | --- |
| ⌘K / Ctrl K | Opens the palette, or closes it if open |
| type | Filters as you type; the best line is selected (in a text step it is the text) |
| ↑ / ↓ | Moves the selection, wrapping at both ends |
| ↵ | Runs the selected line; a line with a confirm arms on the first ↵ and runs on the second |
| Tab / → | On a task line: that task's actions (→ only with the caret at the end of the field) |
| Esc | In a step: back to where it came from. In the list: closes the palette |
| ← / Backspace | On an empty field in a step: back |

A click or tap on a line opens it too. Each line's `onMouseDown` is
`preventDefault`-ed, so the field keeps focus, and on a phone the keyboard
stays up through the tap.

## Entries

```ts
interface PaletteEntry {
  id: string;            // stable MRU key: task:<id>, page:/board, workspace:<id>, repo:<id>, feature:<id>, chat:<id>
  section: 'action' | 'task' | 'page' | 'workspace' | 'repo' | 'feature' | 'chat';
  title: string;
  subtitle?: string;     // muted; matched with a lower weight
  keywords?: string[];   // matched but never shown
  hint?: string;         // right-aligned mono (a task's id8)
  task?: Task;           // a task line's row, for its StatusBadge
  pinned?: boolean;      // listed first on an empty query
  idHit?: boolean;       // a task named by its id
  disabled?: boolean;    // listed, muted, ↵ does nothing; the subtitle says why
  confirm?: string;      // two-press arm: the question the title turns into
  armKey?: string;       // the arm's key (a task action's: `<taskId>:<actionId>`)
  keepOpen?: boolean;    // a step into a sub-list or an input: the palette stays open
  page?: string;         // the page an "Open …" action opens (dedupes the page line)
  run(): void | Promise<boolean | void>; // a promise is awaited; `false` = refused, stay open
}
```

Sections are `context` (one task's actions, labelled *This task · <title> ·
<id8>*) · `action` (global commands) · `task` · `page` · `workspace` · `repo` ·
`feature` · `chat`.

`buildEntries(sources, effects)` turns the app state into entries. The effects
are injected (`openTask`, `go`, `setWorkspace`, `searchBoard`), so the builder
and the ranking stay pure. Actions come in through `sources.actions`, built by
`taskActionEntries` and `globalActionEntries` (both pure, in `palette.ts`).

**Picking a line** (`pick` in `Palette.tsx`): a disabled line does nothing; a
line with `confirm` arms first (`useArm`, src/arm.ts — 4 s, one armed line at a
time, typing disarms); a `keepOpen` line runs and the palette stays; anything
else runs and, if `run` returned a promise, the palette waits for it — the
line shows `…` meanwhile — and closes unless it resolved `false`. So **a
refusal keeps the palette open on the line**, with the reason in the shared
toast (`toastError`). Only navigation lines and global commands go into the
MRU, never a task action.

## Sources

Everything comes from `useApp()`. Scope comes from `useWorkspace()`, THE scoping
helper (docs/workspaces.md): tasks, repos, features and chats follow the current
workspace, and a repo-less item is in every scope.

- **Tasks.** Hidden tasks are left out of the title search. Each line shows:
  - its status badge (`StatusBadge`, `explain={false}`);
  - its repo, as the subtitle;
  - its id8, as the hint.

  A single-word query that looks like an id (hex and dashes, at least
  `MIN_TASK_ID_PREFIX` = 4 characters, `normalizeTaskId` decoration stripped)
  is matched against every task's id first (`idHits`). An exact full id wins
  alone; otherwise up to 6 prefix hits are listed, newest first. An id hit is
  listed even when the task is hidden or outside the workspace, because typing
  an id is a deliberate pick, and it leads the list, so typing an id8 and
  pressing ↵ jumps to that task.

  Opening a task goes through App's `setOpenTask`, the same `?task=` write as
  `openTaskFromAnywhere`. It keeps `?ws=` (and every other param) because it
  edits the live URL, and it also marks the history entry the panel pushed, so
  Back closes the panel as it does after a board click.
- **Pages.** The sidebar's `NAV` list (exported from `Layout.tsx`) plus
  `EXTRA_PAGES`, the pages the sidebar does not list: `/inbox/deck` (Review
  deck) and `/inbox/drafts` (Draft triage). A page is offered only while the
  router knows its path. `App.tsx` builds its `<Routes>` once and hands the same
  element to the palette, which reads it with `createRoutesFromChildren` +
  `matchRoutes`, so a page that has not shipped yet is skipped rather than
  offered as a dead link. (`/inbox/drafts` shipped with the draft triage view,
  docs/inbox.md § Draft triage.)

  Pages navigate with `wsHref`. In Glass on a phone, Features and Chat are left
  out of the menus, but the palette still lists them: their routes stay
  (docs/glass.md § Hidden in Glass).
- **Workspaces.** **All repos**, then every workspace, the current one marked.
  Picking one calls `useWorkspace().setWorkspace(slug | null)`, which replaces
  `?ws=` on the current page and remembers the pick on this device.
- **Repos.** Each repo, with its path as the subtitle. Picking one opens the
  Repos page.
- **Features.** Each feature, subtitled with its repo and status; picking one
  opens `/features/:id`.
- **Chats.** Each chat, subtitled with its repo; picking one opens `/chat/:id`.

## Steps

The palette is a small stack of steps (`Mode` in `Palette.tsx`). The list
above is `search`; every other step was pushed from it and pops back on Esc,
on ← / Backspace with an empty field, or on the **‹** button that replaces the
search icon (the phone's way back). A pushed step keeps the query and selection
of the one below, so going back restores them.

| Step | Pushed by | The field is | The lines are |
| --- | --- | --- | --- |
| `actions` | Tab / → / the **›** button on a task line | a filter | that task's actions (§ Task actions) |
| `follow-up` | **Follow-up…** | the message | one *Send follow-up* / *Resume its session* line |
| `new-title` | **New task…** | the title | one *Next: pick a repo* line |
| `new-repo` | ↵ on a title | a filter | the repos to file into (§ Quick create) |
| `workspaces` | **Switch workspace…** | a filter | *All repos* and every workspace |

The heading of a step's list (and the phone sheet's title) names it. The
desktop footer's key hints follow the step (↵ *run* / *send* / *next*, Esc
*back* / *close*).

## Task actions

- **Where they come from**: `buildTaskActions(task, ctx)` in
  `web/src/taskActions.ts`, the ONE offer rule the task panel draws. The
  palette keeps only `PALETTE_TASK_ACTION_IDS` — `run-now` (Retry now),
  `queue` (Add to queue), `enqueue` (Retry), `complete` (Mark done),
  `publish` / `mark-published`, `review-now`, `cancel` / `dequeue` / `unqueue`,
  `hide` / `unhide`, `terminal` — in the builder's order, and adds
  **Follow-up…** before *Open terminal*. Undo start, Release, Stop agent,
  Apply review fixes, Unblock, Analyze and Delete stay on the panel.
- **Same words, same rules**: the label, the disabled state (with the
  builder's `title` as the subtitle — that is the reason a refused line gives),
  the arm question (`confirm`, its "click again" read as "press ↵ again" on a
  desktop) and the arm key (`<taskId>:<actionId>`, the panel's scheme) are the
  builder's. **Publish** and **Mark published** keep their window confirm
  (`confirmPublish` / `confirmMarkPublished`) inside the builder's `onClick`;
  answering no keeps the palette open on the line.
- **The context the palette passes**: the task's worker runs from the store,
  `orch.shellWaits`, the resumable session (`GET /api/tasks/:id/resumable`,
  re-read when the task's runs change — wording only), and an
  `onOpenTerminal` that goes to App's (below). Analyze and Delete are no-ops,
  since they are not offered.
- **Knowing the answer**: the builder's `onClick` returns its promise (the
  panel ignores it), and the palette's `toastError` in the ctx flags a refusal,
  since `runTaskAction` toasts rather than throws. Success → the usual
  "done" toast and the palette closes.
- **When they lead**: with a task panel open (`?task=` in the URL) the open
  task's actions are the `context` section, first on an empty query and, with
  a query, first after an id hit. On any task line — searched, recent, or an
  id hit — **Tab**, **→** (caret at the end) or the **›** button opens the
  `actions` step for that task instead.
- **Open terminal** calls App's `onOpenTerminal(runId, taskId)`, which follows
  the panel's own rule: an open panel closes first unless the drawer is docked
  beside it, and comes back when the terminal closes.
- **Follow-up…** is offered when the panel offers its follow-up box (the task
  is not a draft, or it has a run). Its step sends through the panel's routes:
  `api.followUp(id, message)`, or `api.proceed(id, message?)` for a failed task
  the usage limit stopped (`limitStopped` from `components/Inbox.tsx`: `wakeAt`
  set, or an error naming the limit) — there the message is optional and the
  line reads *Resume its session*. A refusal keeps the step and the text.

## Global actions

`globalActionEntries` — the `action` section:

- **New task…** (pinned) — § Quick create.
- **Pause all** / **Continue (n)** (pinned) — the header `PauseButton`'s calls
  (`api.orchestratorAction('pause' | 'continue')`, then `setOrch(await
  api.orchestrator())`) and its two-press arm (key `global:pause` /
  `global:continue`).
- **Switch workspace…** — the `workspaces` step; a pick is
  `useWorkspace().setWorkspace`, as the workspace lines in the search list.
- **Open Inbox**, **Open Review deck**, **Open Draft triage**, **Open
  Timeline** — each only while the router knows the path, through `wsHref`.
  With a query the matching page line is dropped (`page`), so "inbox" is not
  listed twice; an empty query lists the pages and leaves these to a search.
- On `/board` (the original version) **Search the board…** stays the first
  pinned line.

All mutations are same-origin `fetch`es from the SPA, so the routes that
require `Origin` (pause/continue, publish, mark-published…) accept them.

## Quick create

**New task…** files a draft in the current workspace in two steps:

1. **Title** — the field is the title; ↵ goes on (an empty title cannot).
2. **Repo** — the in-scope repos, the default first and marked *default*. The
   default is the New task form's memory: localStorage `tm.newTask.repo.<workspaceId>`
   (`tm.newTask.repo` in All), the key `pages/Board.tsx` writes — read here
   by its own copy of the key, Board.tsx is not edited — when that repo is
   still known and in scope, else the workspace's first known repo. In All a
   **No repo** line comes last (the form allows a repo-less draft); inside a
   workspace every line is one of its repos.

↵ on a repo runs `api.createTask({ title, repoId })` (a draft, the server's
default), writes the pick back to the same key like the form does, and opens
the new task's panel (`?task=`, keeping `?ws=`). A refusal keeps the repo step
open with the toast.

## Ranking

- **Empty query**: the pinned entries, then up to 6 **recent tasks**, then
  every page in sidebar order. Recent tasks are those in the MRU first, then by
  `updatedAt` desc.
- **With a query**, every word of it must match the title, a keyword or the
  subtitle, weighted 1, 0.8 and 0.6. Each word scores in coarse tiers
  (`scoreWord`):

  | Match | Score |
  | --- | --- |
  | prefix of the text | 100 |
  | start of a word | 80 |
  | substring | 60 |
  | subsequence | 1–30 |

  A subsequence scores for word starts and runs and loses for gaps. One spread
  wider than four times the word is not a match: `fail` must not find "fix all
  icons". An entry whose words average 36 or more is **strong**; anything else
  is **weak**.
- **Within a section** entries sort by tier (strong first), then by MRU
  position, then by the builder's order (`updatedAt` desc for tasks; features
  and chats by their last activity). So a title fragment that matches several
  tasks lists the one you opened most recently first.
- **Sections** sort by their best line's tier, then by their best score (so
  `neko` lists the workspace *Neko*, a title prefix, above tasks whose repo
  merely contains it), then in the fixed order
  action · task · page · workspace · repo · feature · chat. An id hit leads
  everything.
- **Caps**: 8 tasks, 14 pages, 6 workspaces, 6 actions, 20 lines of one
  task's actions, 5 of everything else.
- **One task's actions** keep the builder's (the panel's) order within a tier;
  the MRU does not reorder them. A step's list (`rankSubList`) shows every line
  in the builder's order on an empty field and ranks them with a query.

### The MRU

- Stored in localStorage `tm.palette.recent`: entry ids, newest first, at most
  30.
- **Validated on read**: anything but an array of short strings reads as empty,
  so a corrupt value costs the ranking, never the palette.
- **Failures ignored**: a full or unavailable storage (private mode, quota) just
  forgets.
- **What goes in**: every pick in the palette, plus **every task opened
  anywhere**. The palette, though closed, watches `?task=` and records each task
  the panel opens: a board row, a push tap, a deep link. "Recently opened" means
  opened, not only opened from here.
- **When it is read**: once per open, so what you pick now ranks from the next
  open.

## The board

The Board's own search used to open on ⌘K. It now opens on `/` only, and ⌘K
is the global palette. `Board.tsx` is frozen (docs/board-versions.md), so the
whole split lives outside it:

- **`useSearchHotkey`** (`components/BoardSearch.tsx`) handles only `/`, and
  only when the focus is not in a text field. It also listens for the window
  event `tm-board-search` (`BOARD_SEARCH_EVENT`) and opens the search on it.
- **`SearchTrigger`**'s key hint reads `/`.
- **On `/board`** the palette's first entry is **Search the board…**, pinned
  on an empty query and found by "search", "filter", "find" or "board". Picking
  it closes the palette and dispatches `tm-board-search`, so the Board opens its
  own search through its existing `openSearch`, with no change to `Board.tsx`.
- **No double open**: the palette ignores ⌘K while `.bs-pop` is open, and
  `useSearchHotkey` ignores `/` while the palette is open (`.pal-pop`,
  `.pal-sheet`).

**Why ⌘K went to the palette:** ⌘K is the platform convention for "go to
anything" (Slack, Linear, GitHub), and the palette is the one surface that
exists on every page. `/` is the web convention for "search this page", so the
board search keeps a key of its own, and its filters stay one entry away
through **Search the board…**.

## Verification

- `npm run typecheck` and `npm run build` are clean.
- Checked in Chrome against a Vite dev server from this worktree, over the
  live API (Glass):
  - on several pages: ⌘K opens; typing an id8 + ↵ opens the task; a title
    fragment ranks a recently opened task first; a workspace pick rewrites
    `?ws=`; Escape closes;
  - on `/board`: `/` opens the board search, and ⌘K opens the palette with a
    working **Search the board…**;
  - ⌘K inside a terminal does nothing (a stand-in `.xterm` element, so no
    agent's PTY got the key); Ctrl K works too;
  - the Inbox's j/k do nothing while the palette is open;
  - at phone width in the iframe harness: the header button opens the sheet,
    and so does the More sheet's tile.

### Phase 2 (actions)

- `npm run typecheck` and `npm run build` are clean.
- Played in headless Chromium (playwright-core) over this worktree's build at
  1400×900 and as an iPhone (393×852). API GETs came from the live front door;
  EVERY non-GET was intercepted, recorded and answered with a fake, so nothing
  touched the live server. Tasks were real rows with patched statuses:
  - a review panel with a flagged verdict: ⌘K lists *This task · …* first;
    ↵ on **Publish anyway** shows the window confirm, declining keeps the
    palette open with no request, accepting POSTs `/publish` and closes;
  - a running panel: ↵ on **Cancel** turns it into *Cancel? press ↵ again*
    with no request, the second ↵ POSTs `/cancel`;
  - no panel: a draft's id8, **Tab** → its actions; **Run now** answered 409
    keeps the palette open with the toast, the second try POSTs and closes;
    **→** drills the same way, Esc goes back to the search with the query kept;
  - **Follow-up…** on a limit-stopped failed task POSTs `/proceed` with the
    message; on a review task POSTs `/follow-up`;
  - **Pause all** → second ↵ → `/api/orchestrator/pause`, the header reads
    *Continue (2)*; **Continue (2)** → second ↵ → `/continue`, the header
    reads *Pause all*;
  - **New task…** under `?ws=neko`: the repo step's first line is a neko repo
    marked default; ↵ POSTs `/api/tasks` with that repo and the URL becomes
    `?ws=neko&task=<new id>`; **Switch workspace…** → *All repos* drops `?ws=`;
  - phone: the sheet's **›** on a task line opens its actions (title = the
    task), **‹** goes back with the query kept.
