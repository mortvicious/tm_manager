# Task groups

A **group** is one task tree: a task, everything split out of it, everything
split out of *those*, at any depth. Parent/child links already existed (a split
proposal blocks the parent and queues children; an agent can file a sibling with
`linkToParent`), but nothing made the tree addressable — a child knew its parent
and no more, so the board could nest exactly one level and nothing could be
filtered, named or coloured as a unit.

Every task now carries **where it sits in its tree**, which turns that tree into
a first-class thing: filterable, nameable, colourable, and drawn as one block on
the Board.

## Data model (migration 12)

`tm_tasks` gains four columns:

| column | meaning |
|---|---|
| `group_id` | id of the **root ancestor** — the group id. A task with no parent is its own group (`group_id = id`), so this is never null and every task is in exactly one group. |
| `group_path` | the **path to the first parent**: ancestor ids root-first, `/`-delimited with a leading and trailing slash. `'/'` for a root, `'/rootId/'` for its child, `'/rootId/midId/'` for a grandchild. |
| `group_name` | optional human name for the group. **Root row only.** |
| `group_color` | optional colour slot 1..7 for the group. **Root row only.** |

`groupAncestors()` / `groupDepth()` / `isGroupRoot()` / `groupLabel()` /
`groupColorSlot()` in `shared/src/types.ts` are the only readers of the format;
nothing else parses the path by hand.

**Why denormalized and not a recursive CTE.** The board needs a task's whole
tree in one query, and the query has to run on both drivers: better-sqlite3 is
sync-only (so the composite mutations are hand-written per driver) and Postgres
is a second dialect to keep in step. A `group_id` column answers "the whole
tree" with an indexed equality; the path answers "the ancestors" and
"the subtree" (a `LIKE` prefix range) without a join. The cost is bookkeeping on
three write paths, which is exactly what `server/src/storage/group.ts` holds —
shared verbatim by both drivers, the same arrangement `feature-sql.ts` uses.

**Why the name lives on the root row and not in a `tm_task_groups` table.** A
group has no identity of its own — it *is* whatever hangs off the root task, it
is created and destroyed implicitly by parenting, and it has exactly one row
that always exists for as long as the group does. A side table would need the
same create/promote/delete choreography plus its own FK and cleanup, to store
two nullable columns. The trade is documented rather than hidden: a group whose
root is deleted loses its name (its children become roots of their own groups),
which is the honest outcome — the group it named no longer exists.

## Invariants

Maintained by **both** drivers, on every write path:

- **insert** — `group_id`/`group_path` are derived from the parent row:
  root → `(id, '/')`; child → `(parent.group_id, parent.group_path + parent.id + '/')`.
- **re-parent** (`updateTask` with a changed `parentId`) — the task AND its whole
  subtree move: descendants are re-based in one statement
  (`MOVE_SUBTREE_SQL`, keeping the tail of their path below the moved node), then
  the node itself is placed under the new parent. Rejected with a thrown error
  when the new parent is the task itself or one of its descendants (the route
  answers 400 before it gets that far). The whole thing is one transaction, so a
  rejected move leaves nothing half-written.
- **demotion** — a task that gains a parent stops being a root, so its
  `group_name`/`group_color` are cleared. Two members of one group can never
  claim different names.
- **delete** — orphaned children are promoted to roots of their own groups,
  carrying their own descendants with them (`parent_id = NULL` was already the
  behaviour; the group columns now follow it). Deleting a middle node therefore
  *splits* a group.

**Backfill.** Migration 12 fills the columns generation by generation (8 bounded
sweeps, then "anything still null becomes its own root") rather than with a
recursive CTE: nothing before this migration rejected a 2-cycle (`A.parent = B`,
`B.parent = A`), and `WITH RECURSIVE` over a cycle does not terminate. Real
trees are 1–2 deep, so the sweep count is slack, not a limit on new rows.

## API

- `GET /api/tasks?groupId=<rootId>` — every task in one tree.
- `GET /api/tasks/:id/group` — `{ groupId, name, color, tasks }` for the group
  behind any member.
- `PATCH /api/tasks/:id` accepts `groupName` (1..80) and `groupColor` (1..7),
  **only on a group root** — 400 otherwise, naming the root as the fix. It also
  400s a `parentId` that points at a missing task or at one of this task's own
  descendants.
- A re-parent broadcasts `task.updated` for every row in the destination group
  (the moved subtree changed too), and a delete broadcasts the promoted
  subtrees, so a second browser tab regroups without a refresh.

Tasks are still created exactly as before — a split, an agent `linkToParent`
follow-up or a manual `parentId` all inherit the group automatically.

### Why a board can show no groups at all

Grouping is *derived*: a group only exists once some task has a `parent_id`.
Nothing in the UI sets one — the three producers are an accepted **split**
proposal, an agent calling the task API with `linkToParent` (which the server
only honours for a split sibling under a currently-blocked parent), and a
hand-written `parentId` on `POST/PATCH /api/tasks`. Feature-generated tasks are
phase-ordered, not parented. So on an install where no split has ever been
accepted, every task is its own root and the board correctly renders a flat
list — the group blocks, breadcrumb, colours and `group: task group` mode all
work, they simply have nothing to draw. Checked on the live database
(2026-08-26): 76 tasks, 0 with a parent. A parent/child pair created through the
API on that same server grouped correctly (`group_id` = the root, child
`group_path` = `/rootId/`), so the machinery is live, not missing.

## On the Board

- **Nesting at any depth.** `ordered()` builds the visible tree — children under
  the deepest ancestor *present in that same list*, indented per level
  (`--tm-depth`) — and keeps all roots of one group adjacent, which is what lets
  a group render as one block. A corrupt parent chain cannot hang it (`seen` set).
- **Group blocks.** Any group with more than one task draws as a bordered block
  with a header: the group name (or the root's title), how many of its tasks are
  in *this* section, and `of N` when the section shows only part of it. The
  header is a button that filters the board to that group.
- **`all groups` filter** and a fourth grouping mode, **`group: task group`** —
  one section per tree, biggest first, with everything else under `ungrouped`.
  In that mode the in-panel block headers are suppressed (the section header
  already names the group) and the section header carries the group's colour.
- **`recent`** stays flat — it is a lookup list, not a worklist — so members of a
  group carry a coloured group chip there instead of a block.
- **The task panel** shows the path to the first parent as a breadcrumb of
  ancestor titles (each one opens that task), a group chip with the group's size,
  and — on a root — the **Group name** and **Group colour** fields.

## Colours

Seven group hues live in the token sheet (`--tm-group-1..7`, violet / blue /
amber / pink / green / orange / lime, each swapping to its `-7` shade in the
light theme) plus `--tm-group-tint`, the percentage a group surface carries.
Nothing outside the token layer names a colour: a block sets `--tm-group` to
one slot token and every rule reads `var(--tm-group, <neutral fallback>)`.

A group's slot is `groupColorSlot()`: the root's explicit `group_color` when set,
otherwise a slot hashed (FNV-1a) from the group id — so an unnamed, untouched
group still has a stable colour across reloads and machines with nothing stored.
The deliberate omissions are teal (the accent — a group must not read as
"active") and red (failure).

**`board.groupColors`** (Config → Board, default on) turns the tinting off: with
it off no `--tm-group` is set, every fallback resolves to the neutral border
tokens, and the blocks/headers/counts stay exactly where they are. Grouping is
structure; colour is only how it is drawn.
