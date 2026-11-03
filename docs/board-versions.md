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

**Registry** — `web/src/boardVersions.ts`, `BOARD_VERSIONS: { id, label, component }[]` in menu order. Only implemented versions are listed; today that is `original` alone (its `component` is `null`: `BoardRoute` mounts `<BoardPage/>` itself, never through `lazy`). A version task adds ONE entry:

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

