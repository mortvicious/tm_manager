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

The Board (`web/src/pages/Board.tsx`) stays frozen and is listed as **Original**. Each alternative is a separate page component, registered in one list and picked per device under the `tm.boardVersion` key (`original | stacks | swimlanes | relation-map | metro`; an unknown or unregistered value reads as `original`). This clones the `tm.design` pattern in `web/src/appearance.ts`. The switch is a **Versions** control: a compact menu on the board route on the desktop, and a segmented row in the board's view controls or settings on a phone. Every version reads the same store slices and respects the workspace scope (`useWorkspace()`). A click on a task opens the ordinary task panel. Relations for the focus layer come from ONE shared pure helper (parent, children, filer via `createdByRun`, dispatch partners), so the four versions cannot disagree about what is related.

| version id | label | mockup |
|---|---|---|
| `original` | Original | the current board |
| `stacks` | Stacks | `board-versions/c-stacks.html` |
| `swimlanes` | Swimlanes | `board-versions/a-swimlanes.html` |
| `relation-map` | Relation map | `board-versions/b-relation-map.html` |
| `metro` | Metro | `board-versions/d-metro.html` |
