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

## Stacks

Shipped in task 61d20bcc as registry id `stacks` ("Stacks" in Versions, listed right after Original). Files: `web/src/pages/board/Stacks.tsx` (the view), `shared/src/stacks.ts` (the pure model, `buildStacks` + `stackSectionOf`, pinned by `server/src/stacks.test.ts`), the `st-*` rules at the end of `theme.css`, and `IconRelations` in `components/Icons.tsx`. It needs no Glass rule of its own: cards, rows and pips read the remapped tokens, and the focus card already has the Glass popover material.

**Sections, by what needs the human.** The order is **Needs you · Working · Up next · Drafts · Landed · Stopped**. Empty sections are left out, and a header counts its items (its tooltip gives the task count).
- **Needs you** is not a second definition. It is `buildInbox` over the board's own set (`useBoardTasks()`: workspace scope applied, hidden tasks left out), read for its `question`, `approval`, `attention`, `review` and `failed` items, in the inbox's decision order. So a review whose verify round is still open, a review Pause all suspended, and a failure older than the inbox's 7 days are NOT here, exactly as on the Inbox.
- **Working:** `running`/`waiting`, plus a `review` still in its automatic round (`verifyOpen`).
- **Up next:** `queued` and `blocked` (split parents), plus a paused `review`.
- **Drafts:** `draft`.
- **Landed:** `done`/`published`.
- **Stopped:** `cancelled`, and a `failed` that has aged out of the inbox.
- Order within a section:
  - Needs you: the inbox's order.
  - Working, Up next and Drafts: queue order, the claim's own (priority, the group root's `sortOrder`, the task's).
  - Landed and Stopped: newest first.
- **Landed and Stopped start folded** and show the 20 most recent items once opened, with "Show 20 more". Which of the two are open is stored per device.

**A group is one stack.**
- Any `groupId` with two or more tasks on the board is ONE card. It sits in the section of its most urgent member, so a group never splits across sections.
- **Most urgent** is decided in this order:
  1. the earliest section;
  2. the inbox position;
  3. a runnable member before the blocked split parent waiting on it;
  4. run order.
- **The card shows:**
  - the group's name (`groupLabel`; a group whose root is off the board takes its first member's title) and its colour (`groupColorSlot` → `--tm-group-n`, as a tinted border and a gradient);
  - a **now:** line: that member's title and its state in words (asks you a question · waits for your approval · needs your attention · waits for your review · failed · is running/fixing/checking… from `badgeReading` · is being reviewed · is next/held · waits on its subtasks · is a draft · landed · …), plus "· N more";
  - **one pip per member in run order** (the tree in pre-order, siblings by `sortOrder`), in that member's status colour. Hollow means still to come (draft, queued, blocked); filled means landed, working or otherwise settled. Pips are capped at 40 (24 on a phone), with "+n";
  - **landed/total**.
- Folded, the card draws two paper edges below it.
- **Unfold in place:** a click on the head (a button, `aria-expanded`) unfolds the card. Every member then sits on one rail in the group colour, indented by its depth in the tree (`TaskRow`'s own nesting elbow). Unfolded stacks are remembered for the session, not stored.

**Stacks / Flat** is a toggle in the head (the `rm-seg` segmented control), stored per device with the open sections in localStorage `tm.stacks`. Flat uses the same sections with every task as its own row. A task whose group has two or more members on the board carries a dot in the group colour and the group's name.

**Rows are the original's.** Each row is `TaskRow`, the same component the original board renders, so the live line, the progress bar, the terminal button and the quick actions (run, publish, queue, mark done, the phone's ⋯ sheet) are identical. Inside it sit `StatusBadge` (fed the same inputs the board feeds it: attention, question, review/check/loop state, paused, publish busy, the live reviewer's terminal) and `ProgressPct`. When the board spans more than one repo, a row also gets a repo chip. A click on a row opens the ordinary task panel.

**Focus.**
- Every row ends with a **relations** button (`IconRelations`, `aria-pressed`). The button toggles the shared focus layer, which rings the task, outlines its relations, dims the rest and shows the relations card (a `<Sheet>` on a phone). The `itemProps` sit on the row's wrapper.
- A **folded** stack stands in for its members: it is lit when any member is focused or related, and dimmed otherwise.
- Focusing a task from the card unfolds the way to it (its stack, a folded section, past the 20-row limit) and scrolls it into view. Unfolding happens only when the focus changes, so folding by hand afterwards is respected.

**Live updates.** The view reads `useApp()` tasks, runs, questions, approvals, proposals and features, which `/ws/events` keeps current. `buildInbox` and `buildStacks` are memoised on them. There is no polling.

**Verified** at 1280 px and at 390 px (phone, `.app.mobile`), in Classic and Glass, on the live board's data. Original was checked as unchanged with Versions set back to it. The screenshots are in the task's artifacts.

**Departures from the mockup.**
- **A sixth section, Stopped (folded).** The mockup's five sections have no place for a cancelled task, or for a failure the inbox no longer lists. Putting those under Landed would misreport them.
- **A row click opens the panel, and focus has its own button.** This is the list-like option the version contract allows. The mockup had no focus at all, and the original board's habit is that a click opens the task.
- **Approvals count as Needs you**, because the inbox lists them. A review in its automatic round, or a paused one, does not.
- **Blocked split parents stay on the rail.** The mockup hid them, but the parent is the tree's root, a real task with its own actions, and the indentation needs it. Its pip is hollow.
- **On a phone the pips take their own line under the "now:" text**, and landed/total stays top right. With the mockup's layout a long group name was cut to a few letters next to a large feature's pips.
- **Pips are capped (+n).** One real feature plan holds 85 tasks.

## Metro

Shipped in task 9eeb6286 as registry id `metro` ("Metro" in Versions). Files: `web/src/pages/board/Metro.tsx` (the view), `shared/src/metro.ts` (the pure layout, `layoutMetro` + `metroRows`, pinned by `server/src/metro.test.ts`), and the `mt-*` rules at the end of `theme.css`. It needed no Glass rule of its own: every colour is a remapped token read through CSS variables (a line's `--mt-c` is `--tm-group-<slot>`, a station's `--mt-s` its status token). The live/all switch reuses Relation map's `rm-seg` control.

**Lines.**
- **One per group.** A line is a group with two or more tasks shown, in its colour (`groupColorSlot`). Lines run in the queue order of their roots: priority, then the root's key.
- **Run order.** Stations are the members in run order, sorted by `compareClaimOrder` (the JS twin of `MANUAL_CLAIM_ORDER`), so a line reads the way the queue claims it.
- **Origin.** A `blocked` split parent is the line's origin: a small dot in the line colour with no label, since the line's name already says it. It is NOT a station. Any other root is the first station.
- **Branches.** The root's children are the main stations. Every deeper descendant branches off below its top-level station, in run order. A branch drops straight down from its station to its lane, so lanes are chosen right to left: each branch takes the lane below every branch that starts inside its span. No drop ever crosses another branch's rail or station, and a later branch sits nearer the main line. A member whose parent is not shown (hidden, or out of the workspace) hangs off the root level.
- **Rails.** The rail is solid (6 px) up to the last station that has started (running, waiting, review, blocked, done, published or failed), then dashed (3 px, 70 %). Each branch has its own split. Rails stop short of each station, so a hollow station stays hollow on a translucent surface.
- **Local stops.** Single tasks (a group of one on the board) sit on a dotted **Local stops** line in run order. It is capped at 16 stations on the desktop and 8 on a phone, with a **+N more** / **show fewer** toggle.
- **The name column** gives the group's name and `landed/count` (`· split` when the line has an origin). It is sticky while the map scrolls sideways.

**Stations.**
- done/published: filled.
- running/waiting: filled, with a pulsing ring. The pulse is static under `prefers-reduced-motion`.
- review: amber with a centre dot.
- queued: hollow. draft: dashed hollow.
- failed: red with an ×. cancelled: faint with an ×.
- blocked: violet with pause bars. This applies to a split parent that is not a line's root.

Labels are two lines of up to 19 characters, the second ellipsised. The full title is in the hover card.

**Interaction (desktop).**
- **Hover card.** Hover or keyboard focus shows a card: title, status badge, repo, progress %, cost and a hint.
- **Click** (or Enter/Space) opens the ordinary task panel.
- **Focus.** The **⌖ knob** at a station's upper right toggles the shared focus layer. It shows on hover, on keyboard focus and on the focused station; the keyboard equivalent is **R**. The focused station gets an accent ring and related stations a dashed one. The layer dims the rest, and every rail dims to 22 % while something is focused. The relations card navigates, and a refocus scrolls the station into view.
- Esc or a click on empty map clears the focus (the layer's own rules).

**Phone: a timetable.** There is no map. Each line is a full-width card with the line running down the left: one row per station, branch stations indented under their station with an elbow off the main rail, and the origin as a first row marked `origin · split`. A tap on a row opens the task panel. Its **⌖** button (a 44 px target) focuses the task, which opens the focus layer's neighbours `<Sheet>`. The station key is desktop-only; *live/all* stays.

**Live vs all.** *live* (the default, stored per device in `tm.metro`) shows every group with a live member, whole so the line keeps its shape, plus every live single task. *all* shows the whole board set (`useBoardTasks()`: workspace scope, not hidden). The view reads `useApp()` tasks, runs and dispatches, which `/ws/events` keeps current, so there is no polling. The layout is memoised on the shown set, and each line row is `content-visibility: auto` with its intrinsic size, so off-screen lines cost no layout. Measured on the live board: *all* is 41 lines and about 380 stations, with no page errors.

**Departures from the mockup.**
- **The ⌖ knob / R is new.** The mockup had a click open the panel and no focus. The brief keeps the click and adds the required focus layer as a dedicated affordance, as the version contract allows a list-like view to do.
- **Origin only on split lines.** The mockup drew an origin dot on every line. Here it exists only for a `blocked` split parent, which the brief makes the origin. Elsewhere the root is the first station and has no rail before it.
- **Branches use lanes.** The mockup placed branch stations at 0.9 × spacing per branch, so adjacent branches overlapped. Here each branch's stations sit on whole slots right of their station, in lanes no other branch's drop crosses.
- **More stations count as started.** The mockup's solid stretch counted only done/published/running/waiting/review. Here failed and blocked count too, since they ran. Cancelled and blocked got glyphs, which the mockup's sample did not need.
- **Run order uses the claim comparator.** Lines and stations follow `compareClaimOrder` (priority first) rather than the sample's insertion order.
- **The hover card drops the live narration line**, which the sample's data carried and `Task` does not. It adds progress % instead.
- **The *live/all* filter and the local-stops cap are new**, for the real board's landed history.
- **The phone stacks its cards vertically** (one line per screen-width card) rather than paging them sideways, so the timetable scrolls like every other phone list.
