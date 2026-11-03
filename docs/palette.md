# The ⌘K palette

A global "go to" box: from any page, jump to a task, a page, a repo, a
workspace, a feature or a chat without reaching for the sidebar. Phase 1 of the
feature *Review deck, global ⌘K palette, agent-draft triage* ships only
navigation. Actions (the task panel's `buildTaskActions` list, global commands)
come later and use the same entry model (§ Entries).

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
| type | Filters as you type; the best line is selected |
| ↑ / ↓ | Moves the selection, wrapping at both ends |
| ↵ | Opens the selected line and closes the palette |
| Esc | Closes the palette |

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
  run(): void;
}
```

`buildEntries(sources, effects)` turns the app state into entries. The effects
are injected (`openTask`, `go`, `setWorkspace`, `searchBoard`), so the builder
and the ranking stay pure. A later action is one more entry in the `action`
section with its own `run`.

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
  deck) and `/inbox/drafts` (Agent drafts). A page is offered only while the
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
- **Caps**: 8 tasks, 14 pages, 6 workspaces, 5 of everything else.

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
