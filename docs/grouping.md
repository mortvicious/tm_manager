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
- `POST /api/tasks` accepts `parentId`, inheriting the group from that row.
  There is no self/descendant check to make — a task that does not exist yet has
  neither — and a parent id that names no row is caught by the foreign key
  (`400 referenced entity does not exist`), not by a check of its own.
- `PATCH /api/tasks/:id` accepts `groupName` (1..80) and `groupColor` (1..7),
  **only on a group root** — 400 otherwise, naming the root as the fix. It also
  400s a `parentId` that points at a missing task or at one of this task's own
  descendants.
- `POST /api/tasks/:id/move` `{ place, targetId? }` — one board drop or picker
  choice, resolved server-side (`moveTask` in `task-actions.ts`) into a parent
  and a position, then written by the storage composite `moveTask` in ONE
  transaction (re-parent + key + `task.moved` audit row). See § Drag and drop
  for the places. Refusals: 404 unknown task; 400 unknown place, missing
  `targetId`, a target that does not exist, dropping a task onto itself, and a
  parent that is the task or under it; **409 moving a task out from under a
  `blocked` parent** (below). Every changed row is broadcast — the moved subtree,
  the whole destination group, and a renumbered sibling set.
- **A blocked split parent keeps its children.** `blocked` resolves when the
  LAST child lands, so pulling a child out could leave its parent waiting on
  nothing, forever. Both the move and a `PATCH parentId` refuse that with 409
  (`reparentRefusal`, shared so the two cannot disagree); reordering children
  *under* the blocked parent, and adding one, are still allowed.
- `POST /api/agent/tasks/:id/move` — the same move for a worker agent
  (token auth, `docs/agent-api-design.md` § Close and move). Both ends must be
  within the agent's reach, and it additionally refuses to put a task under a
  `blocked` split parent, to mix trust in one group, or to grow a group past 40
  members (§ Agent filings). How agents are told to group is in
  `docs/agent-instructions.md` § Grouping tasks.
- A re-parent broadcasts `task.updated` for every row in the destination group
  (the moved subtree changed too), and a delete broadcasts the promoted
  subtrees, so a second browser tab regroups without a refresh.

Tasks are still created exactly as before — a split, an agent `linkToParent`
follow-up, the **Group** picker or a manual `parentId` all inherit the group
automatically.

### Where a group comes from

Grouping is *derived*: a group only exists once some task has a `parent_id`.
The producers are an accepted **split** proposal, an agent calling the task API
with `linkToParent` (which the server only honours for a split sibling under a
currently-blocked parent), the board's **drag and drop** and the **Group**
picker in the UI (below), and a hand-written `parentId` on `POST/PATCH
/api/tasks` or a `POST /api/tasks/:id/move`. Since 2026-11-07 every
non-human filing carries a group decision too — see § Agent filings; a
feature's cards form one group under its first card. Nothing *implies* a group: on an install where none
of those has ever run, every task is its own root and the board correctly
renders a flat list — the group blocks, breadcrumb, colours and `group: task
group` mode all work, they simply have nothing to draw. That was the state of
the live database on 2026-08-26 (76 tasks, 0 with a parent); the machinery was
verified live even then, a parent/child pair created through the API grouping
correctly (`group_id` = the root, child `group_path` = `/rootId/`).

Until 2026-09-08 the UI was not one of those producers — a group could only be
made by an agent or by hand-writing JSON at the API, which is why a board could
look as though the feature were missing.

## On the Board

- **Nesting at any depth.** `ordered()` builds the visible tree — children under
  the deepest ancestor *present in that same list*, indented per level
  (`--tm-depth`) — and keeps all roots of one group adjacent, which is what lets
  a group render as one block. A corrupt parent chain cannot hang it (`seen` set).
- **Group blocks.** Any group with more than one task draws as a block with a
  rounded **rail** in the group's colour down its left edge (`.task-group::before`,
  inset clear of a fresh row's accent edge) and a slim **caption** on top
  (`components/GroupHead.tsx`) — no header band, no rule under it, sentence-case
  body type, the first row tucked right under it: a fold caret, the group name
  (or the root's title) in the group's colour, the count as plain figures —
  `3`, or `1/15` when the section shows only part of the group — and a pencil
  that appears on hover. (Until 2026-10-26 this was a full-width tinted
  uppercase band with its own borders and a count pill, which on a one-row
  block doubled its height.)
  - **Fold.** The caret shrinks the block to its caption, which then reads a
    status summary of the hidden rows (`2 running · 1 review`). The fold state is
    `grp:<groupId>` in the board's saved `collapsed` list, so it survives a
    reload and applies to that group in every section it appears in.
  - **Rename.** The pencil (or a double-click on the name) turns the caption into
    an inline name field with the seven colour swatches and `auto` beside it:
    Enter saves, Escape abandons, an empty name clears it back to the root's
    title, and a swatch saves at once. Both write the ROOT row (`PATCH
    groupName|groupColor`), the only row the server lets carry them. A refusal
    shows above the board and the field stays open with the text intact.
  - **Filter.** A single click on the name still filters the board to the group
    (a `group` chip in the Board search, `docs/search.md`, replacing any other
    group chip).
  - **Drop target.** A task dropped on the caption is appended to the group.
- **Inside a group the order is always the manual one** (§ Order), whatever the
  sort control says; the sort decides where each group and each lone task sits.
  **`sort: queue order`** sorts those by position too, which is the order the
  queue claims in.
- **A `group` facet in the Board search** (type the group's name, or
  `group:<name>`) and a fourth grouping mode, **`group: task group`** —
  one section per tree, biggest first, with everything else under `ungrouped`.
  In that mode the in-panel block headers are suppressed (the section header
  already names the group) and the section header carries the group's colour.
- **`recent`** stays flat — it is a lookup list, not a worklist — so members of a
  group carry a coloured group chip there instead of a block.
- **The task panel** shows the path to the first parent as a breadcrumb of
  ancestor titles (each one opens that task), a group chip with the group's size,
  and — on a root — the **Group name** and **Group colour** fields.
- **Choosing a group** (`components/GroupPicker.tsx`). The task panel and the
  new-task form both carry a **Group** picker. It replaced a flat `<select>` of
  every task title, which never said which titles were groups and stopped being
  usable past a few dozen tasks. The picker is one search box over:
  - `No group`;
  - every group of two or more (colour dot, size, repo; groups in the task's own
    repo first) as **append to "‹group›"**, expandable (caret, or →/←) to
    **under "‹member›"** for nesting under one specific member. A search that
    matches only a member opens its group so the match is visible;
  - lone tasks as **start a group with "‹task›"** — the first 12, the rest
    behind the search.

  ↑/↓ move, Enter picks, Escape closes. The candidate list drops this task and
  **every task under it** (`groupAncestors(t).includes(task.id)`, the
  client-side twin of the server's 400); a rejection that still arrives (a stale
  list, a blocked parent) surfaces verbatim in the panel error.
  - **The panel** regroups through `POST /move` (`group` for append, `child` for
    under a member, `ungroup` for none), sent BEFORE the `PATCH` of the other
    fields: the move is the half that can be refused, and it must land first
    because group identity is only accepted on a root. A place change alone
    (`under` the root → `append`, i.e. to the group's end) counts as an edit.
  - Group identity is only sent while the task **stays** a root (`rootAfter`).
    The **Group name**/**Group colour** fields hide as soon as a group is
    picked, which is also the truth: demotion clears both columns.
  - **The new-task form** sends the choice as `parentId` on `POST`. A new row
    takes the global max key, so append and under-the-root are the same write:
    the task lands at the end of that group.

## Agent filings

**Every task a non-human creator files has an explicit group decision**:
joined, new, or ungrouped with a reason, audited on its create (decisions.md
2026-11-07). Humans may still create ungrouped tasks; nothing changes for them
(the human `POST /api/tasks` still ignores a `groupName`). The point is the
Stacks view (`docs/board-versions.md` § Stacks), which works when work arrives
in logical groups instead of a pile of unrelated single rows.

No new table and no "Ungrouped" pseudo-task: **join** = parent under the
group's ROOT (flat, at the end of its run order — a new row takes the global
max key), **new** = the task becomes a root carrying `group_name`,
**ungrouped** = its own root, on purpose. Code: `server/src/group-filing.ts`
(the decisions), `shared/src/group-filing.ts` (vocabulary, `normalizeGroupName`,
`pickNamedGroup`), `server/src/storage/group-filing-sql.ts` (shared verbatim by
both drivers: the name-dedup read, the trust walk, `featureCardGroup`,
`RESOLVING_CHILDREN_SQL` — JS twin `isSplitChild` in shared). `NewTask.rootGroupName` writes the name of a `new`
group (deliberately not `groupName`, which the human body carries) and
`NewTask.groupDecision` lands on the `task.created` row as `data.group`.

### The agent API

`POST /api/agent/tasks` takes `group`, exactly one form (a body with two is a
400):

- `{"join": "<task id or group id>"}` — the group of that task, flat under its
  root. A finished group is allowed (follow-up work on landed work); Stacks then
  lifts that stack out of Landed, which is correct.
- `{"new": "<name ≤ 80>"}` — this task is the root of a new named group; later
  filings join it by id. **Name dedup**: when an OPEN group (≥ 1 non-terminal
  member) whose root is in the caller's reach (below, plus the target repo) has
  the same name after normalising case, whitespace and punctuation, the task
  JOINS it instead (`joinedExisting: true` in the response and the audit) —
  unless `forceNew: true`. Finished groups are never matched, so a follow-up to
  landed work starts fresh. Fuzzy matching is the agent's job: it sees
  `GET /api/agent/groups`. The match runs INSIDE the create's transaction
  (`Storage.createTaskInNamedGroup`): better-sqlite3 runs one transaction at a
  time on its one connection, and the pg driver takes
  `pg_advisory_xact_lock(hashtext('tm-group-name:<key>'))` first, so two agents
  racing on one name never mint two groups. Among several matches the oldest
  root wins, so racers converge.
- `{"ungrouped": "<one-line why>"}` — standalone; the why is audited on
  `agent.create`. A run filing a SECOND ungrouped task in the same repo gets a
  note suggesting `new` + moving the first; never a refusal.
- **Omitted** — the instructions say it is required, but the server never
  refuses for it (a 400 burns a turn and breaks agents with stale
  instructions). The deterministic default, audited as
  `group: {defaulted: <rule>}` and explained in the response `note`:
  1. `previous-filing` — the group of this run's previous filing in the same
     repo, when that filing was grouped (a lone unnamed root was ungrouped on
     purpose and is skipped);
  2. `own-group` — the caller's own group, when it has ≥ 2 members and a name;
  3. `ungrouped`.
  Each candidate must pass the join checks below; one that fails falls through.
- `linkToParent` is itself the decision (`joined`, `via: 'linkToParent'`); a
  `group` beside it may only name that same group (400 otherwise).

The response carries `task.groupId`, `group: {decision, groupId, name,
joinedExisting?, defaulted?}` and the `note` (the enqueue note and the group
note joined by ` · `). After the fact, `POST /api/agent/tasks/:id/move` still
groups what an agent filed — e.g. the first was filed ungrouped and the second
shows they belong together.

**Discovery.** `GET /api/agent/groups?repo=&q=&limit=` lists OPEN groups (a
tree of ≥ 2 tasks or a named root, with ≥ 1 non-terminal member) touching the
caller's reach: `{id, name, named, repos, members, open, rootStatus,
lastActivity, joinRefusal}`, most recently active first (`joinRefusal` null =
joinable, else the reason a join would get). `?repo=` outside reach is 403.
`/api/agent/context` carries the caller's own `group` (same shape) and the top
10 `openGroups` in its repo.

### Edge cases

1. **Really one task** → `ungrouped` + why. Stacks shows it as a plain row, as
   before.
2. **The same logical group already exists** → discovery + name dedup above.
3. **The matching group is finished** → dedup ignores it; an explicit `join`
   by id is allowed.
4. **The root is a `blocked` split parent** (no `waitFor`) → 409 suggesting
   `new`, for a join and for every default rule (they fall through). A split
   sibling goes under it only through the existing `linkToParent` rule; this
   is the same refusal as the agent move route's.
5. **Reach and taint.** Membership widens reach — dispatch accepts "own group"
   (`routes/agent.ts`) and `reachOf` "your group" (close, move, wait,
   depends-on in `agent-tasks.ts`/`agent-waits.ts`); those are the only two
   places "same group" grants something (grep of `groupId ===`). So:
   - a `join` targets only groups whose ROOT is in the caller's repo, its
     shared space's repos or any of its workspaces' repos (`reachRepoIds`) —
     plus the caller's own group, and a group holding a task this run filed;
     else 403;
   - **trust never mixes**. A task is untrusted when it, or any task up its
     filing chain (`created_by_run → tm_runs.task_id`, walked by
     `untrustedWalk`, bounded at 64 hops), has `tainted_at` (a tainted office
     shift's, a signal-driven one's, a tainted feature's) or is `source`
     `sentry`/`job`. Taint is NOT copied onto agent filings (`tainted_at`
     keeps its office meaning), which is why the walk exists. An untrusted
     filer never joins a group holding trusted tasks, and a trusted filer
     never joins one holding untrusted tasks. Such a join is not refused: the
     task is filed ungrouped and the response says why
     (`downgraded` in the audit). Name dedup and the defaults skip such groups.
   - `POST /api/agent/tasks/:id/move` enforces the same (409 "would mix
     trust"), or an agent could file ungrouped and move it in afterwards.
6. **Claim order.** Members sort under the group ROOT's key
   (`MANUAL_CLAIM_ORDER`), so joining moves a task to its group's place in the
   queue. Agent filings are drafts or priority 0 and same-repo filings always
   drafts, so this matters only for an enqueued cross-repo filing — and that
   is the intended order (the group runs together). Agent joins stop at
   **40 members** (`AGENT_GROUP_MAX_MEMBERS`, the Stacks pip cap): 409
   suggesting `new`; the agent move refuses past it too.
7. **Naming.** Only a root names a group. An agent names a group only by
   creating it with `new`; there is no agent rename, so a human-named group is
   never renamed by an agent, and a human rename (PATCH `groupName`) always
   wins — a later dedup reads the new name.
8. **Root deleted** → the group splits (existing behaviour, § Invariants).
   Root cancelled → still the root; nothing to do.
9. **Cross-repo** → allowed (trees already span repos). A workspace-scoped
   Stacks shows the in-scope members.

### Other non-human creators

The same rule, decided server-side (every one audited on `task.created` as
`data.group`, with `by`):

- **Split proposals** — already children of the parent; unchanged.
- **Feature approval** — the cards form ONE group named after the feature: the
  first card is the root and carries the feature's title as `group_name`,
  every later card joins it flat in plan order (`featureCardGroup`, both
  drivers' `approveFeature`). Claim order is unchanged (root first, members by
  their increasing keys) and the phase gate still decides eligibility. One
  consequence handled with it: the other cards are CHILDREN of the first one,
  so a split of that card would wait on (and fail with) every one of them —
  later-phase cards cannot even run until its phase closes, a deadlock. So a
  plan card of the parent's own feature (`source = 'feature'`, same
  `feature_id`) is a group member, never a split piece: `resolveChildCompletion`
  (both drivers) counts only `RESOLVING_CHILDREN_SQL`, and its JS twin
  `isSplitChild` (shared) is what the Inbox's blocked-kind child count,
  `reparentRefusal` (a human may still move a card out of a blocked first
  card) and `linkToParent` (a card's worker is no split sibling → 400) read.
  Split pieces are `source: 'auto'` (`acceptProposal`) or an agent's
  linkToParent sibling. Features approved before this change keep their lone
  roots (no backfill).
- **Job follow-ups** (`source: 'job'`, `fileJobFollowUp` in `jobs.ts`) — one
  group per job: the group of the job's previous follow-up while it is open
  (found by `source_ref`, so a human rename does not break it), else the open
  `Job: <title>` group (name dedup, untrusted members only), else a new one.
- **Office filing** (`fileShiftTasks`, also the Director's channel `task`
  route) — one group per role per office day, `<role name>: <YYYY-MM-DD>` in
  the office's timezone (name dedup joins a same-day shift's open group of the
  same trust). A `tasks` item may name `group: "<task id>"` to join that group
  instead, under the same reach (the office's workspace repos) and trust rules
  (the shift's taint); a refused one files into the shift group with the
  reason as `downgraded`. Proposals accepted by a human follow the human rule.
- **Shared-note file** (`/api/agent/shared/notes/:id/file` → `fileRequest`) —
  joins the REQUESTING task's group (`note.fromTaskId`) when reach and trust
  allow, else ungrouped with `reason: 'shared request <id>'` and the refusal as
  `downgraded`. The dashboard's human filing is unchanged. The custom-queue
  hold keys off the filer (`created_by_run`), not the group, so it is
  unaffected.
- **Sentry** — ungrouped by default, `reason: 'one task per Sentry issue'`:
  issues are independent and a `Sentry: <project>` group would gather
  unrelated fixes into one run order.

### Decided, not built

- Stacks does **not** gather ungrouped rows into a folded "Ungrouped" stack:
  they stay rows (`docs/board-versions.md` § Stacks unchanged).
- No strict `agent.requireGroup` setting: an omission is defaulted and
  explained, never refused. The audit's `defaulted` marks every such filing,
  so a human can spot agents that skip the decision.

## Order

`tm_tasks.sort_order` (migration 26, `DOUBLE PRECISION`: Postgres `REAL` is
float4 and runs out of midpoints within a handful of drags) is a task's manual
position **among its siblings**: the tasks sharing its parent, or all root tasks.
Only its rank among siblings means anything.

- **New rows** take the global `MAX(sort_order) + 1` (`NEXT_SORT_ORDER_SQL`,
  a subquery in the INSERT in both drivers), so a new task is last, within its
  group and among roots.
- **The backfill** ranks existing rows by `created_at` (id breaks a tie), so
  every sibling set keeps the order it had until something is dragged.
- **A move** writes one key: the midpoint between the two neighbours at the drop
  point (`keyNextTo`, shared by both drivers), or the neighbour ±1 at either end.
  Only when the gap cannot be split any more (or two keys tie) is the sibling
  set renumbered 1..n in its new order. Measured: 80 alternating drops into the
  same slot renumbered once. A pure reorder does not touch `updated_at`: it is
  not an edit of the task, and `last touched` / the recent strip / report
  windows must not treat it as one.
- **The claim order follows it.** The global claim orders by `priority DESC`,
  then **the group's root key** (then group id, so two tied groups never
  interleave), root before members, then the task's own key, then `created_at`
  (`MANUAL_CLAIM_ORDER` in `storage/group.ts`, with a JS twin
  `compareClaimOrder` in shared that the Queue page lists the global queue by). A group therefore runs in its
  root's slot, members in their drawn order: what `sort: queue order` shows is
  what the queue claims. Exact for a flat group — which is what dragging makes;
  members nested deeper compare by their own key within the group rather than
  depth-first. `priority` still wins (no UI sets it; agents' tasks are always 0).
  The custom queue keeps its own FIFO (`custom_queue_at`) and the agent-child
  claim its `created_at` order — both are explicit queues of their own.
- `GET /api/tasks` orders by `priority DESC, sort_order, created_at`. The board
  re-sorts client-side regardless: a task's position path (keys from its root
  down to it) compared element-wise is depth-first tree order.

## Drag and drop

Every board row except the flat `recent` list has a grip (six dots, on hover;
always shown on touch). A drag starts on the grip only — clicking a row, scrolling
and selecting text are untouched — and uses pointer events, not the HTML5 drag
API, which never fires for touch on iOS (`components/TaskDrag.tsx`). What the
drop will do is drawn before letting go: a line on a row's edge for before/after,
the whole row or header lit for into/append, a red outline plus the reason for a
drop the server would refuse, and a ghost under the pointer saying it in words
(`move above "Bravo"`, `join group "Payments"`, `start a group with "Alpha"`).
Escape abandons the drag; the pane auto-scrolls near its top and bottom edges.

**On touch a drag needs a hold.** The board is mostly scrolled, and a flick that
started on the 22px grip used to become a regroup. Now a touch (`pointerType
'touch'`) arms only after the grip is held still for 350 ms (`HOLD_MS`); a
finger that moves 8px first (`TOUCH_SLOP`) is a scroll, left to the browser,
since on a coarse pointer the grip is `touch-action: manipulation` instead of
`none`. Arming lifts the ghost under the finger (`.drag-ghost.lifted`, plus a
10 ms vibration where the browser has one) and from then on a non-passive
`touchmove` on the grip — only there, so the board's scrolling stays passive —
stops the page from scrolling under the drag. A mouse still starts after 4px.

**Every drop can be undone.** Before a drop is sent the board reads where the
task is now (`undoMove`: after its previous sibling, else before the next one,
else its old parent's only child, else a root) and, once the move goes
through, shows an **Undo move** toast (`toastUndo`, `docs/mobile.md` § Action
errors) that replays that place through the same route. Order and parent come
back exactly; the key is a fresh midpoint, and the subtree moves back with it.

| Drop | `place` | Result |
|---|---|---|
| top 30% of a row | `before` | a sibling of the target, just above it — the target's parent becomes the task's parent, so dropping beside a group member joins that group, and beside a root makes (or keeps) the task a root |
| bottom 30% of a row | `after` | the same, just below it. Directly under a parent whose children are drawn right below it, the line reads as "first child", so it resolves as `before` that first child |
| middle of a row | `into` | **join the target's group flat**: right after the target when it has a parent; as its last child when it is a root (a lone target starts a group) |
| a group header | `group` | last child of the group's root — append |
| (picker) | `child` | last child of that exact task, at any depth |
| (picker) | `ungroup` | a root, keeping its key |

The dragged task's own subtree always moves with it (a group dropped into
another becomes a nested subtree there, not flattened — flattening would
re-parent its children, and a blocked split parent resolves only through its own
children). The client mirrors the server's refusals (`moveRefusal`) to draw
them; the server still decides. A reorder among ROOTS under any sort other than
`queue order` would be invisible, so that drop switches the sort to `queue
order`. Reordering inside a group needs no switch — groups are always in manual
order.


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
