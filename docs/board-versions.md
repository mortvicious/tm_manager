# Board versions: alternatives to the current grouping

Mockups: `docs/board-versions/*.html` (open in a browser; `v1-current.html` approximates today's board). They are interactive: click nodes in B, stacks in C, and hover stations in D. All four mockups use the same 17-task sample board and the literal dark `--tm-*` tokens. Screenshots are in the design task's artifacts (task 10e66e3d).

## What the board has to show

There are more relations between tasks than the board draws today:

| relation | field | drawn today |
|---|---|---|
| tree (split parent → subtasks) | `parentId`, `groupId`, `groupPath` | indent `└` + group rail/head |
| run order among siblings | `sortOrder`, `priority`, `customQueueAt` | only under sort = queue order |
| filed by an agent | `createdByRun`, `spawnDepth` | an `agent` chip, but not *by whom* |
| dispatch between sessions | `tm_dispatches` from → to, intent | a `⇢ n pending` chip plus a strip under the receiver |
| feature phase | `featureId`, `featurePhase` | a `feat pN` chip |
| repo / category | `repoId`, `category` | chips, or the groupBy option |

## Why the current view is hard on the eye

- **A group is cut into pieces by status.** The status buckets come first (Active / Queued / Drafts / ...), and a group is only drawn inside a bucket. So one group appears as 3–4 fragments, and you cannot see in one place how far it has got. The `groupBy: group` option fixes the fragmentation, but then you lose the status ordering.
- **Indentation carries only one relation.** The tree is the only thing the layout shows. "Filed by" and dispatch are chips on a row, so you have to read them.
- **Every row carries the same weight.** A 6-task group and a lone typo fix take the same visual space per row. Nothing summarises a group when it is open.

## The four alternatives

| | idea | best at | cost / risk | phone |
|---|---|---|---|---|
| **A · Swimlanes** (`variant-a-swimlanes.png`) | 2-D table: rows = group (or repo/feature), columns = stage | where each group stands, and the whole review pile at once | wide; empty cells on sparse boards; drag maps to stage changes we don't allow | stage columns scroll sideways, lane names pinned |
| **B · Relation map** (`variant-b-relation-map*.png`) | graph: group bands, tree left→right, dashed = filed by agent, dotted = dispatch; click focuses a neighbourhood | "why does this exist / what is it waiting on", agent chains | heaviest to build (layout, edges); weakest for a quick scan | a per-task "neighbours" sheet, not a canvas |
| **C · Stacks** (`variant-c-stacks.png`, `-phone.png`) | grouping as a flag (Stacks / Flat); a group is one stack card with its most urgent member ("now: X waits for your review") + run-order pips; sections are "Needs you / Working / Up next / Drafts / Landed" | daily triage; closest to today; cheapest to build | sorting by urgency is new; there is less detail until you unfold a stack | native: same list, stacks unfold in place |
| **D · Metro lines** (`variant-d-metro.png`) | each group is a line, its tasks are stations in run order; solid = done, dashed = to come; branches for sub-subtasks | reading progress and order "by shape" at a glance; the most distinctive | titles get truncated; many ungrouped tasks make the "local" line long | lines run vertically (a timetable) |

**Decision (2026-11-03, the user):** build all four as switchable board versions next to the frozen original, and give every version B's focus interaction (click a task's relations: parent, children, filer, dispatch partners highlighted, the rest dimmed). Recommended order: Stacks first (the cheapest, and the closest to daily use), then Swimlanes, Metro and Relation map.

## Versions control

The Board (`web/src/pages/Board.tsx`) stays frozen and is listed as **Original**. Each alternative is a separate page component, registered in one list and picked per device. Every version reads the same store slices and respects the workspace scope (`useWorkspace()`). A click on a task opens the ordinary task panel. Relations for the focus layer come from ONE shared pure helper, so the four versions cannot disagree about what is related.

| version id | label | mockup |
|---|---|---|
| `original` | Original | the current board |
| `stacks` | Stacks | `board-versions/c-stacks.html` |
| `swimlanes` | Swimlanes | `board-versions/a-swimlanes.html` |
| `relation-map` | Relation map | `board-versions/b-relation-map.html` |
| `metro` | Metro | `board-versions/d-metro.html` |

### What shipped (task 894c2360) — how a version plugs in

**Registry** — `web/src/boardVersions.ts`, `BOARD_VERSIONS: { id, label, component }[]` in menu order. Only implemented versions are listed (`original` first; its `component` is `null`: `BoardRoute` mounts `<BoardPage/>` itself, never through `lazy`). A version task adds ONE entry:

```ts
{ id: 'stacks', label: 'Stacks', component: lazy(() => import('./pages/board/Stacks.tsx')) }
```

The module's default export is the page and takes `BoardVersionProps` (`onOpenTask`, `onOpenTerminal` — the same props as `BoardPage`). In a dev build (`import.meta.env.DEV`) a `dev-focus` placeholder ("Focus test (dev)", `pages/board/DevFocusBoard.tsx`) is listed too, so the control and the focus layer can be tried; Vite drops the branch and its chunk from a production build, where it is never listed.

**Per-device choice** — localStorage `tm.boardVersion`, the `tm.design` pattern of `appearance.ts`: a module store read through `useSyncExternalStore` (`useBoardVersion()` → the `BoardVersion` entry), written by `setBoardVersion(id)` (same tab: listeners; other tabs: the `storage` event; blocked storage: this tab keeps the pick in memory). An unknown or unlisted value reads as `original`, so a device whose pick a later build drops falls back without a migration.

**Routing** — `/board` renders `web/src/pages/BoardRoute.tsx`: `<BoardPage/>` for `original`, the chosen version (inside `<Suspense>`) otherwise. Deep links need nothing per version: `?task=` and `?tab=` belong to App (`useOpenTask`, `usePanelTab`, the global `TaskSlideOver`), `?ws=` to `useWorkspace()`, and switching versions never touches the URL. A version opens a task with its `onOpenTask` prop, as the board does.

**The control** — hidden entirely while `BOARD_VERSIONS.length === 1` (`BOARD_VERSIONS_SWITCHABLE`), so production renders exactly as before.
- Desktop: `<BoardVersionsControl/>` (`components/BoardVersions.tsx`), a compact `version: <label>` select styled like the board's group/sort selects. On the original board it sits in the board head's tools, after *essentials*, through Board's one new prop `headSlot` — the single edit to the frozen file (decisions.md 2026-11-03). A version renders the same component in its own head. It renders nothing on a phone.
- Phone (and Settings on the desktop): a **Board version** row in Settings → Appearance (`<BoardVersionsSetting/>`), per device like Design, outside the page's Save.

**Relations helper** — `shared/src/task-relations.ts` (pure, exported from `@tm/shared`, tests in `server/src/task-relations.test.ts`):
- `buildRelationIndex({ tasks, dispatches?, runs? })` → `{ neighbourhood(id), filerOf(id) }`; `taskNeighbourhood(input, id)` is the one-shot form.
- `neighbourhood(id)` → `{ taskId, relations: { kind, taskId, dispatches? }[], ids: Set<string> }`, or `null` for a task not in the list. Relations are ordered by `TASK_RELATION_KINDS` (`parent`, `child`, `sibling-in-group`, `filed-by`, `filed`, `dispatch-in`, `dispatch-out`), then by the order of `tasks`; `ids` holds every related task once (a parent that is also the filer is two relations, one id). Headings: `TASK_RELATION_LABELS`.
- `parent`/`child` read `parentId`; `sibling-in-group` = the same parent (so the same group); a root's siblings are none. `filed-by`/`filed` map `createdByRun` through `runs` (`Run.taskId`; an aux run has none and relates nothing) — the SPA already holds every run in `useApp().runs`, so no new field was needed. Dispatches give one relation per partner and direction, carrying every dispatch between them oldest first; a self-dispatch is dropped.
- Only tasks IN the list relate: pass the board's own set (`useBoardTasks()` — workspace scope applied, hidden tasks left out), and a partner outside it simply does not appear.

**Focus layer** — `web/src/boardFocus.tsx` + the `bf-*` rules at the end of `theme.css` (tokens only; the card gets the Glass popover material in `glass.css`). A version:

```tsx
const tasks = useBoardTasks();
<BoardFocusProvider tasks={tasks}>
  <BoardFocusScope>{/* the canvas; every task element: */}
    <button {...focus.itemProps(t.id)} onClick={() => focus.toggle(t.id)}>…</button>
  </BoardFocusScope>
  <BoardFocusCard onOpenTask={onOpenTask} />
</BoardFocusProvider>
```

- `useBoardFocus()` → `{ focusedId, neighbourhood, index, tasks, focus(id|null), toggle(id), clear(), stateOf(id), itemProps(id) }`. `itemProps` sets `data-focus-id` and, while something is focused, `data-focus="focused|related|dimmed"`; the CSS rings the focused task, outlines the related ones and dims the rest inside `.bf-scope[data-focus-active]`. Edges or extra marks a version draws can key off `stateOf`.
- Clearing: Esc (not from a field, a dialog, or while the task panel is open — the panel's Esc closes it first; keyboard focus inside the card returns to the task), a click in the scope that lands on no task, no control and not the card, or `toggle` on the focused task. A focused task that leaves the set (hidden, out of scope, deleted) clears itself.
- `<BoardFocusCard>` lists the relations by kind, with status badges and a dispatch note (`2× · 1 pending`). A relation refocuses that task; **Open** opens the ordinary task panel. Desktop: a card fixed to the viewport's lower right (z-index under the task panel), so it suits any layout. Phone: a `<Sheet>`, whose Open clears the focus so the sheet gives way to the panel.
- Keyboard: task elements should be buttons (Enter/Space toggles), the card's rows are buttons, the card title is `aria-live`.
- Whether a click on a task focuses or opens is the version's call. The relation-map mockup focuses on click and opens from the card; a list-like version may focus from a dedicated affordance instead.
- The original board does NOT get the layer (frozen).


## Relation map

Shipped in task 17b1af28 as registry id `relation-map` ("Relation map" in Versions). Files: `web/src/pages/board/RelationMap.tsx` (the view), `shared/src/relation-map.ts` (the pure layout, `layoutRelationMap` + `cullRelationMap`, pinned by `server/src/relation-map.test.ts`), and the `rm-*` rules at the end of `theme.css`. It needed no Glass rule of its own: nodes, bands and the list read the remapped tokens, and the focus card already has the Glass popover material.

**Desktop: the canvas.**
- **Bands.** There is one band per group with two or more tasks on the map, in queue order (the root's `sortOrder`) and tinted with the group's colour (`groupColorSlot`). A group whose root is not on the map still gets a band, labelled "Group". Single tasks go in a final **Ungrouped** band, where a filed task sits one column right of its filer, as in the mockup.
- **Tree.** Inside a band the tree reads left to right: a parent, then its subtasks ordered by `sortOrder`. In **depth** mode (the default) it is a tidy tree: leaves take rows and each parent is centred vertically over its children. **Phase** (`featurePhase`, "no phase" first) and **status** (draft · queued · running · review · blocked · landed · stopped) modes place the column by that key, compacted to the columns in use, and give every task its own row in tree order, because a parent and its child can share a column there. Those two modes have sticky column headers. The column mode and the live/all pick are stored per device in `tm.relationMap`.
- **Edges.**
  - **Subtask:** solid, in the group colour.
  - **Filed by an agent:** dashed and muted, drawn from `RelationIndex.filerOf`, the shared helper's `createdByRun` → `Run.taskId`. They cross bands when the filer sits elsewhere.
  - **Dispatch:** dotted accent with an arrowhead, one edge per direction for each task pair (its tooltip gives the count). It is animated while any dispatch on the edge is `pending` (the animation stops under `prefers-reduced-motion`); a delivered, failed or cancelled one is drawn at 45 %.
  - An edge whose target is not further right loops out to the right, as in the mockup.
- **Focus.** Focus is the main interaction and comes from the shared layer: a click toggles focus (`itemProps` + `toggle`). The ring, the outline on related tasks and the dimming are the layer's own. The map also dims every edge not touching the focused task to 12 %. The relations card navigates, and focusing a task that is off screen scrolls it into view smoothly. **A double-click, ⌘/Ctrl+Enter or the card's Open** opens the ordinary task panel.
- **Pan.** Drag empty canvas with a mouse; the click that ends a drag is swallowed so it does not clear the focus. Scrolling and trackpads work natively. There is no zoom (the brief made it optional).
- **Live vs all.** *live* (the default) shows:
  - every group that still has a live member, in full so its tree stays intact;
  - every live single task;
  - a landed single task one filed-by or dispatch hop from a live task.

  *all* shows the whole board set (`useBoardTasks()`: workspace scope, not hidden). The focus card lists relations against the whole set either way.
- **Performance.** The layout is memoised on (tasks shown, relation index, dispatches, column mode) and costs O(n log n). The canvas renders only the bands, nodes and edges inside the viewport plus one 400 px chunk of margin each way, and the viewport is snapped to that grid, so scrolling re-renders only when it crosses a chunk line. Measured on the live board's *all* set (a canvas about 59,000 px tall), about 30 nodes are mounted at any scroll position.
- **Live updates.** The map reads `useApp()` tasks, runs and dispatches, which `/ws/events` keeps current. There is no polling.

**Phone: no canvas.** The view is a list of the same bands, with rows in tree pre-order (`order`), indented by depth with an elbow mark. Each row carries its status badge, a dashed `filed` mark, a dotted `⇢` dispatch mark (filled while pending) and the progress %. Tapping a row focuses it, which opens the focus layer's **neighbours `<Sheet>`**. Its relations are navigable, and its Open clears the focus and opens the task panel. The column modes are desktop-only; *live/all* stays.

**Departures from the mockup.**
- A click focuses and opening is a double-click or the card, as the mockup implies; the standing "a click opens the panel" rule yields here to the brief's "focus is the main interaction".
- The side card is the shared `BoardFocusCard`, at the lower right, rather than the mockup's top-right card. It also lists siblings in the group, which the shared helper reports and the mockup did not.
- The node has no hover lift (no `transform`). It shows the repo chip only when the map spans more than one repo, not when the repo differs from a default.
- The *live/all* filter is new. The mockup's 17-task sample had no need for it, but the real board's landed history (about 900 tasks) would bury the live work.

## Swimlanes

Shipped in task c8eca7cd as registry id `swimlanes` ("Swimlanes" in Versions). Files: `web/src/pages/board/Swimlanes.tsx` (the view), `shared/src/swimlanes.ts` (the pure layout, `layoutSwimlanes` + `swimlaneStage`, pinned by `server/src/swimlanes.test.ts`), and the `sl-*` rules at the end of `theme.css`. It needs no Glass rule of its own: the cells, cards and pinned headers read the remapped tokens (the header row layers the inset token over `--tm-bg-raised`, so it stays opaque where Glass makes the inset translucent), and the focus card already has the Glass popover material.

**The table.** A CSS grid: the lane-name column, then one column per stage (`SWIMLANE_STAGES`):

| column | statuses |
|---|---|
| Queued | draft, queued |
| Working | running, waiting |
| Review | review |
| Stuck | failed, blocked |
| Landed | done, published |

`cancelled` is in no column and in no count, as in the mockup. The column header shows how many cards it holds after the finished filter. Every card's badge is the board's own `StatusBadge` with the same inputs as a board row (attention, question, review/check/loop state, paused, publishing), so *auto-review*, *checking*, *checks red* and *fixing* read correctly inside Review and Working, and a live reviewer badge opens its terminal.

**Lanes** — by **group** (the default), **repo** or **feature**, a per-device pick stored with the finished filter in `tm.swimlanes`.
- **Group:** one lane per group with two or more tasks on the board. A single task joins the shared **Ungrouped** lane at the bottom. The lane is named by `groupLabel` of its root and coloured by `groupColorSlot`. A root that is not on the board (hidden, out of the workspace, or cancelled) still names and colours its lane, through the `rootOf` lookup over every task.
- **Repo:** lanes are sorted by repo name, with **No repo** last.
- **Feature:** a single-task feature is still a lane, and **No feature** comes last.
- **Order:** lanes with live work come first, by their first task's queue order (repo lanes by name). Lanes whose every task has landed follow, newest first.
- **Lane header:** the name (a button that folds the lane: its cells show only counts; per session), a colour rail, `landed/total landed` (plus ` · feature` for a group that belongs to one), and a segmented status bar, one `flex: n` segment per status in the mockup's order (done, published, review, running, waiting, queued, draft, failed, blocked). The header counts EVERY member, whatever the filter hides.

**Cards.** Each card shows:
- the title, clamped to 3 lines;
- the live line (the running worker run's activity, as on a board row);
- the badge;
- a repo chip, when the board spans repos and the card's repo differs from the lane's (the group root's repo, the feature's repo, none for the loose lane);
- the `agent` chip (`createdByRun`);
- `~%` (`ProgressPct`);
- a relations button `⌁`.

Inside a cell, cards keep the tree's pre-order (groups by queue key, siblings by `sortOrder`). A child sits right under its parent, indented by the number of its ancestors in the SAME cell (capped at 3), with an elbow mark. A cell shows `SWIMLANE_CELL_CAP` (30) cards, then a `+n more` button that unfolds that cell.

**Hide finished / All.** *Hide finished* (the default) keeps a landed task only while it was updated in the last 3 days (`SWIMLANE_RECENT_MS`) and drops a lane left with nothing to show. *All* shows every task on the board set (`useBoardTasks()`: the workspace scope applied, hidden tasks left out).

**Clicks.** A click on a card opens the ordinary task panel (`onOpenTask`). The **relations button** toggles the shared focus layer (`itemProps` on the card, `toggle` on the button):
- the focused card is ringed, related cards are outlined, and the rest is dimmed;
- the relations card sits at the lower right on the desktop and is the neighbours `<Sheet>` on a phone;
- Esc or a click on empty table space clears it.

There is **no drag**: a column is a status, which is never set by dragging, and reordering stays in Original.

**Phone.** The lane-name column (116 px) stays pinned (`position: sticky; left: 0`). The five stage columns (220 px each) scroll sideways inside the table and snap one column at a time past the pinned names (`scroll-snap-type: x mandatory`, `scroll-padding-left` = the name column). The Lanes and Recent/All controls stay in the head, and the version pick is in Settings → Appearance as for every version.

**Live.** Everything reads `useApp()` (tasks, runs, activity, questions, features), which `/ws/events` keeps current, so there is no polling. The recent-landed cut-off moves with the shared 30-second `useNow()` clock.

**Departures from the mockup.**
- **A click opens the task.** Focus comes from a dedicated relations button on every card, the affordance the contract allows a list-like version. The mockup has no focus interaction, and the standing rule says a click opens the panel.
- **Hide finished is a time window** (3 days) rather than "no landed cards". The column would otherwise always be empty, and *All* on the real board (hundreds of landed tasks) needs the per-cell cap.
- **The header row is sticky on the desktop.** On a phone it scrolls away with the page, because the table is the horizontal scroller there.
- **Lanes fold** from the lane name (the mockup's `.lane.collapsed`). The mockup's per-card repo rule ("differs from `tm`") became "differs from the lane's repo, when the board spans repos".
