# Workspaces

A **workspace** is a named, scoped view over a set of repos. You use one to look at "the neko repos" or "the backend repos" without the rest of the board in the way. It is a view and nothing more.

- It owns no folder and no ledger. A [shared space](shared-spaces.md) has both, and it changes what a worker sees (`$TM_SHARED_DIR`, `--add-dir`, the prompt block).
- A repo may be in any number of workspaces. A repo is in at most one space.
- Agents have no API for it, and nothing in a worker's prompt, environment or claim order depends on it.

This feature has four phases. **Phase 1** adds the data, the REST API, the live events and the SPA store slice. **Phase 2** adds the editor on the Repos page (§ SPA › Managing them). It also adds the switcher (§ Current workspace). **Phase 3** scopes the Queue page, the Dashboard, the Inbox and the Board (§ Scoped pages). **Phase 4** adds this document's decision sections (§ Why `?ws=`, § What is not scoped) and the end-to-end pass (§ Verification (phase 4, end to end)). Decision log: docs/decisions.md 2026-10-28 (two entries: views not spaces; view scopes, not per-workspace queues).

## Model

`Workspace` (`shared/src/types.ts`):

| field | |
|---|---|
| `id` | uuid |
| `name` | 1–60 chars |
| `slug` | URL key. Matches `WORKSPACE_SLUG_RE` (`^[a-z0-9][a-z0-9-]{0,39}$`), is unique, and is never `all` (`WORKSPACE_RESERVED_SLUG`, kept for the every-repo view) |
| `repoIds` | 1–50 member repos |
| `color` | a group palette slot `1..GROUP_COLOR_COUNT`, or `null` |
| `sortOrder` | position in the switcher. New workspaces go last (max + 1) |
| `createdAt` / `updatedAt` | ISO |

`slugify(name)` and `uniqueWorkspaceSlug(name, taken)` are shared so the server and the SPA derive the same slug.

- **`slugify`** folds accents, turns each other run of non-`[a-z0-9]` into one `-`, trims to 40 chars, and falls back to `workspace` when nothing is left (a name written entirely in Cyrillic, for example). Its result always matches the regex.
- **`uniqueWorkspaceSlug`** adds `-2`, `-3`… (truncating the base to fit) when the slug is taken or is `all`.

## Storage

Migration **49** creates `tm_workspaces`: `id`, `name`, `slug`, `repo_ids` (JSON), `color`, `sort_order`, `created_at`, `updated_at`, plus the unique index `tm_workspaces_slug_idx` on `slug`.

- **Why 49:** the task asked for 48, which approvals had already taken.
- **No foreign keys**, as with `tm_spaces`. The row keeps whatever repo ids it was given, and the route drops the ones no longer in `tm_repos` **on read**. Deleting a repo never has to touch a workspace.

Both drivers run the same SQL from `server/src/storage/workspace-sql.ts`:

- the insert statements (explicit order for the seed, append for a create);
- the list order (`sort_order, name, id`);
- `workspacePatchColumns`;
- `workspaceOrder` (the reorder plan);
- `isUniqueViolation` (`SQLITE_CONSTRAINT_UNIQUE` / pg `23505`).

The Storage methods are `listWorkspaces`, `getWorkspace`, `createWorkspace`, `updateWorkspace`, `deleteWorkspace` and `reorderWorkspaces(ids)`. Storage validates nothing; the route does.

### Seed

When migration 49 is applied, each driver seeds **one workspace per `tm_spaces` row**. This runs in the migration's own transaction, next to the cost and command-owner backfills, and uses the pure `workspaceSeedRows` in `migrations.ts`:

- the space's name and `repo_ids` as they are;
- `color` null;
- `sort_order` 0, 1, … ordered by the space's `created_at`;
- a slug from `uniqueWorkspaceSlug`, unique among the seeded rows.

It runs **once**, because it is tied to the migration being applied and not to the table being empty. A later boot seeds nothing, and a seeded workspace the human deletes stays deleted. Spaces created after the migration get no workspace.

## API (`server/src/routes/workspaces.ts`)

| route | |
|---|---|
| `GET /api/workspaces` | every workspace in switcher order, with `repoIds` filtered to existing repos |
| `POST /api/workspaces` | `{name, slug?, repoIds, color?}` → 201. With no `slug`, `uniqueWorkspaceSlug(name)` is used and never refused |
| `PATCH /api/workspaces/:id` | any of `name`, `slug`, `repoIds`, `color`. **A rename keeps the slug**: only an explicit `slug` changes it |
| `DELETE /api/workspaces/:id` | `{ok:true}`, or 404 |
| `POST /api/workspaces/reorder` | `{ids}`: the listed ids take positions 0..n-1 in that order, and any workspace not listed follows in its current order (so one created mid-drag is not thrown to the top). Returns the new list |

Rules:

- **Every write needs `Origin`**, otherwise 403. This is the `fromBrowser` rule of `routes/spaces.ts`: a worker's curl has no Origin.
- **Slugs.** An explicit slug that fails the regex is 400, and so is `all`. A slug another workspace holds is **409**, including a race caught by the unique index.
- **Repos.** Unknown repo ids are 400 on write. Duplicates are collapsed.
- **Colour.** Outside `1..GROUP_COLOR_COUNT` (and not `null`) is 400.
- **Reorder.** Repeated or unknown ids are 400.
- **Audit.** Every successful write appends a `workspace.changed` row (actor `human`) with `action` set to `created`, `edited` (with `fields`), `reordered` or `deleted`.
- **Events.** Every successful write broadcasts `workspace.updated {workspace}` (the read-filtered row) or `workspace.deleted {workspaceId}`. A reorder re-broadcasts every workspace.

## Scoped stats (`GET /api/stats/overview?repoIds=`)

`/api/stats/overview` takes an optional `repoIds` query parameter, a comma-separated list of repo ids. Without it the endpoint aggregates every repo, and the response is unchanged byte for byte. With it, every figure is restricted to those repos:

- runs by `run.repoId` (the tiles, `perDay`, `perModel` and the `perRepo` run/cost columns);
- task-derived figures by the task's `repoId` (`depth`);
- `task.transition`, `run.attention`, `run.stats-final`, `agent.create` and the `byActor` stream by the event's own `repoId`, else its task's, else its run's. That covers done/failed, overflow claims, attention and agent-filed counts;
- `perRepo` lists only those repos.

A present but EMPTY list (`repoIds=`) matches nothing and returns zeros. It never means "all", which is the same rule as `TaskFilter.repoIds`. Unknown ids simply match nothing. Scoping happens in JS after the reads, so it shares the existing 2000-row cap that storage puts on every event query. For a busy window, `byActor` is therefore the scoped share of the newest 2000 events in the window, which is the same newest-biased sample the unscoped view already uses. `/api/stats/anomalies` is not scoped. `api.statsOverview(days, repoIds?)` in `web/src/api.ts` passes the parameter. Nothing in the SPA uses it yet.

## SPA

- `web/src/api.ts` has `listWorkspaces`, `createWorkspace`, `updateWorkspace`, `deleteWorkspace` and `reorderWorkspaces`.
- `web/src/state.tsx` holds a `workspaces` slice. It loads with the other initial lists and is kept live by the two events: upsert, then re-sort by `sortOrder`, then name. A repo deleted while the page is open stays in a workspace's `repoIds` until the next load, so consumers should intersect with `repos`.

### Managing them (Repos page, `#workspaces`)

`web/src/components/WorkspacesSection.tsx` sits under the repos table on `/repos`. `/repos#workspaces` scrolls to it, because the router does not scroll to a hash and `.main` is the scroller. It reads the store slice, and every write only has to succeed: the `workspace.updated`/`workspace.deleted` broadcast redraws this tab and every other one. The one optimistic bit is the repo checkboxes, which show the set just sent until the PATCH settles.

- **New workspace**: name, colour and repo checkboxes. The slug is previewed as `uniqueWorkspaceSlug(name, taken)`, which is `slugify` plus the suffix the server adds on a clash. No slug is sent, so the server derives exactly that preview. Create stays disabled until a name and at least one repo are set.
- **Per row**: the left rail carries the colour. The row has:
  - **Inline rename** (the name or the pencil; Enter saves, Escape abandons). It sends only `name`, so the slug stays.
  - **Edit slug**, a separate action because old links stop working. It is checked as you type against `WORKSPACE_SLUG_RE` and the reserved `all`, and Save is disabled while that fails.
  - **The GroupHead swatches**: `--tm-group-1..GROUP_COLOR_COUNT`, plus `auto` = null.
  - **Repo checkboxes**. A repo may be in several workspaces. The last ticked repo is disabled, because a workspace needs one.
  - **↑/↓** buttons, which call `reorderWorkspaces` with the swapped full list.
  - **Delete**, behind an inline confirm (`Delete <name>?` / Keep) rather than `confirm()`.
- **Errors**: server refusals (409 duplicate slug, 400) show inline under the row or the form, with the server's message.
- **Phone**: nothing here is an overlay, so there is no `<Sheet>`. The lists wrap, and `.app.mobile` enlarges the swatches and the repo chips. Styles are `.ws-*` in `theme.css`, using tokens only. Glass needs no rule of its own, because the panels pick up its remapped tokens.

Verified (phase 2) against a harness: the real `registerWorkspaceRoutes` and `/ws/events` over a copy of the live DB, serving a scratch build, with other GETs proxied to the live API. The live API predated migration 49 and could not be restarted. Playwright drove two desktop tabs, and tab B followed tab A live through each step: create (preview `/zz-test-ws`), rename (slug kept), a bad slug and the reserved `all` refused client-side, a 409 on `neko` shown inline, a slug change, recolour, unticking a repo down to the last (then disabled), move up, and a delete from a 393 px phone context. It ran at 393 px in Classic and Glass with no horizontal overflow.

## Current workspace (`web/src/workspace.ts`)

The workspace you are looking at is the URL's `?ws=<slug>`, exactly as the open task panel is `?task=<id>` (App.tsx `useOpenTask`). No param means All. There is no React state for it, so a link, a reload and Back all carry it for free.

`useWorkspace()` is the one module every consumer reads:

- `workspace: Workspace | null` is null for All. It is also null while the list has not loaded yet, and for a slug that names nothing.
- `repoIds: ReadonlySet<string> | null` is the workspace's `repoIds`, or null for All. It is not intersected with `repos`: a deleted repo's id matches no task, so it is harmless in a membership test.
- `inScope(task)` / `inScopeRepo(repoId)` are true for everything under All, and **always true for a repo-less item** (`repoId` null).
- `setWorkspace(slug | null)` rewrites `?ws` on the LIVE URL (`window.location`, not the render's), so it composes with `?task=` in either order. Null removes the param. It writes `localStorage` `tm.workspace` (removed for All) and navigates with `replace`. A replaced entry drops the panel's "pushed" history mark (`PANEL_PUSHED`, now exported from `nav.ts`): without that, closing a panel after a switch would go Back to the old scope.
- `wsHref(to)` appends the current `?ws` to an in-app path and keeps the path's own query and hash (`/repos#workspaces` → `/repos?ws=neko#workspaces`).

The rules:

- **Moving between pages keeps the workspace.** Every `NavLink` in `Layout.tsx` (the sidebar, the phone tab bar including the Board FAB, and the More sheet) and the desktop Inbox chip go through `wsHref`. NavLink's active matching reads only the pathname, so highlighting is unchanged. `nav.ts` `openTaskFromAnywhere` (a toast's Open) keeps `?ws` beside `?task=`. Navigation elsewhere in the pages does not carry it yet. Phase 3, where the pages consume the scope, decides which of those links should.
- **A bare launch restores the device's pick.** `applyRememberedWorkspace()` runs in `main.tsx` before the router reads the URL, so nothing renders unscoped first. It applies `tm.workspace` only when the path is `/` or `/board` with an EMPTY query string, which is what the Home Screen app opens (`start_url: "/"`). Any other URL without `?ws` means All, so a push tap (`/?task=<id>`), `/board?task=<id>` and old bookmarks keep meaning All. A reload of a bare `/board` counts as a launch.
- **An unknown slug falls back to All.** `WorkspaceGuard` is mounted once in `Layout`. When the list has loaded (`workspacesLoaded`, a flag added to `state.tsx` because the global `loaded` is set before workspaces arrive) and `?ws` names no workspace, the guard does three things: it shows an info toast (`toastInfo`, new in `toast.ts`, which is a plain notice with no action), it forgets `tm.workspace` if that was the slug, and it removes the param. The slug can be unknown because the workspace was deleted in this tab or another one (the `workspace.deleted` event), or because a link is stale. An empty `?ws=` is dropped without a toast.

### Why `?ws=` and not `/w/:slug/`

The scope is a query parameter, deliberately, not a path prefix:

- **It composes like `?task=`.** Both are independent overlays on whatever page is open, and `setWorkspace` edits only its own param, so a panel can be open in any scope and either can change without touching the other.
- **No route changes.** A prefix would have doubled every route in the router, every `NavLink` match and every hard-coded path (toasts, push `?task=` deep links, Telegram links, the manifest's `start_url`). With a param, an old URL is still valid and simply means All.
- **Deep links mean All.** A link without `?ws` (a push tap, a Telegram link, a bookmark) must show the thing it points at, whatever scope the device last used. Only a BARE `/` or `/board` launch restores `tm.workspace` (§ The rules), because that is what the Home Screen app opens.
- **An unknown slug is not an error page.** It falls back to All with a toast (`WorkspaceGuard`).

### `useWorkspace()` is THE scoping helper

Every view that should follow the workspace reads `useWorkspace()` and nothing else: `inScope(task)` / `inScopeRepo(repoId)` for membership, `repoIds` to pass to a server filter (`buildInbox`'s `repoIds`, `statsOverview`'s `repoIds`), `wsHref` for links. Later views (Timeline, the ⌘K palette, a Review deck) should do the same instead of reading `?ws` or `tm.workspace` themselves. **A repo-less item (`repoId` null: a repo-less chat or report, config/server anomalies, the day fuse) is in every scope**, because it belongs to no repo that could be out of scope.

### Switcher (`web/src/components/WorkspaceSwitcher.tsx`)

- **Desktop**: a compact ghost button in `.header`, before the queue switch. It shows the colour dot and the name ("All repos" with a hollow ring for All). It opens a `.ws-pop` menu: All repos, the workspaces in `sortOrder` with their repo counts and a check on the current one, then **Manage…** → `wsHref('/repos#workspaces')`. Outside press and Escape close it. The task panel's overlay covers the header, so the scope cannot be switched by pointer while a panel is open.
- **Phone**: the `brand-mini` slot is now the switcher, a tappable title (dot + name + chevron) that opens a `<Sheet>` holding the same list as `.sheet-nav` rows, so Glass gives them the More sheet's tiles. Under All it reads `tm_manager`. Below 430 px, where the brand used to be hidden, it stays visible and reads "All repos" instead.
- **Colour**: `--tm-ws: var(--tm-group-<slot>)`, where the slot comes from `groupColorSlot({ groupId: id, groupColor: color })`. That is the explicit colour, or for an uncoloured workspace a stable slot hashed from the id, like groups.
- **Styles**: `.ws-dot`, `.ws-switch`, `.ws-pop`, `.ws-opt` and `.ws-title` in `theme.css`, using tokens only. Glass adds one thing, `.ws-pop` in the shared popover-material rule (`:is(.cmd-pop, .group-picker-pop, .ws-pop)`). Nothing touches `.main`, `.header` or `.app`.

Phase 3 makes the pages consume it (§ Scoped pages).

Verified (phase 2) with Playwright Chromium against the live front door. A scratch build was served from `ctx.route`, `GET /api/workspaces` was faked (the live API predated migration 49), every non-GET was aborted, and `/ws/events` was a mock socket for injecting `workspace.deleted`. Both designs passed 60 checks at desktop 1400 px and phone 393 px:

- picking a workspace sets `?ws` and the memory; Escape and outside press close the menu;
- every sidebar, tab-bar, FAB and More-sheet href carries `?ws`, and navigating keeps it;
- opening a panel gives `?ws=…&task=…`, and closing it keeps `?ws`;
- switching with the panel open keeps `task`, and a later close keeps the NEW scope;
- `Manage…` → `/repos?ws=tm#workspaces`;
- a bare `/` and `/board` restore the memory, while `/queue` and `/board?task=<id>` mean All;
- deleting the current workspace over the socket falls back to All with a toast and clears the memory, and `?ws=nope` does the same;
- the phone header does not overflow at 393 px.

`openTaskFromAnywhere` was checked under tsx: `/queue?ws=neko` produces `/queue?task=<id>&ws=neko`. `npm run typecheck` and `npm run build` pass, with the build going to a scratch outDir.

## Scoped pages

Phase 3 makes pages read `useWorkspace()`. Under All each page behaves exactly as before.

### Queue (`web/src/pages/Queue.tsx`)

- **Active sessions and idle terminals** keep runs where `inScopeRepo(run.repoId)` holds. A repo-less aux run, such as a report or a repo-less chat, stays visible.
- **The custom queue** (`customQueueWaiting(tasks)`) and **the global queue** are filtered with `inScope` only AFTER they are ordered (`compareClaimOrder` over ALL tasks). The rows that remain therefore keep their place in the global run order. A scoped list is always a subsequence of the All list.
- **Hidden rows are counted.** When the scope hides rows from a section, the section ends with a muted line, `n more in other workspaces`. That way a scoped empty queue is not mistaken for an idle orchestrator. The Idle and Queue sections normally disappear when they are empty. They keep their header (count 0) while there are hidden rows, and the empty texts say "in this workspace".
- **Behaviour is unchanged.** No orchestrator call or button behaves differently.

### Dashboard (`web/src/pages/Dashboard.tsx`)

- **Tiles, charts and tables** come from `api.statsOverview(days, [...repoIds])` (§ Scoped stats). These are the tiles, both per-day charts, provenance, per repo and per model. Under All the call is `?days=` alone. The load effect depends on `[days, scopeKey]`, where `scopeKey` is the sorted repo ids. A switch refetches immediately and re-arms the 60 s interval. A sequence ref drops a slow answer that a newer load has overtaken, so the previous scope's numbers cannot land last.
- **Anomalies and the activity feed** are filtered client-side. An item belongs to its own `repoId`, else its task's repo, else its run's repo (from the loaded `tasks`/`runs`). One that names none of these stays visible, because it is repo-less: config, server and the day fuse. One whose task or run is not loaded also stays visible. While scoped, the feed fetches 200 audit rows instead of 60, then keeps the newest 60 in scope.
- **The title** reads `Dashboard · <workspace name>` when scoped.

### Inbox and chips

- **`useInbox()`** (`components/Inbox.tsx`) passes `useWorkspace().repoIds` to `buildInbox` (docs/inbox.md § Workspace scope). Everything that reads it follows the workspace: the Inbox page, the desktop `InboxChip`, the phone header chip, the phone Inbox tab's count and the phone sheet stack. `useInbox(true)` is the unscoped list.
- **The Inbox page** title reads `Inbox · <workspace name>` when scoped. When decisions wait outside the scope it adds a muted `n more in other workspaces` button that switches to All. `n` is the difference of the two `decisions()` counts, so stale drafts are not counted, as on every badge.
- **`QuestionChip`** (desktop ❓) counts only pending questions whose asking task is in scope. A question carries no repo, so it is looked up by `taskId` in the store, and one whose task is not loaded still counts. **`QuestionModal` stays global by design**: an agent blocked on a question is blocked whatever the user is looking at.

### Board (`web/src/pages/Board.tsx`)

- **The scope is applied before the search.** `filtered` keeps `inScope(t) && match(t)`, where `match` is `compileQuery` over the search tokens. Every section built from `filtered` (Active, Drafts, the groupings, Recent, Hidden) follows the workspace, and a repo-less task stays. Group membership, the search context and the drag order still read all tasks, so a group never shrinks because some members are out of scope.
- **It is shown as a view chip.** While scoped, `viewChips` carries `workspace: <name>`. Clearing it calls `setWorkspace(null)`, which goes to All. The scope comes from `?ws` and is never written into `prefs.tokens` or the `tm.board` localStorage state, so **Reset filters** leaves it alone and a reload keeps the saved board exactly as it was.
- **The new-task form defaults to a repo in the workspace.** The board's one-repo filter (`filterRepoId`) wins first. In a workspace the next default is the repo of the last task created from THAT workspace, read from `tm.newTask.repo.<workspaceId>` (written where the global key used to be), else the workspace's first known repo. A remembered repo that has since left the workspace is ignored. The global `tm.newTask.repo` is read and written only under All.

Verified (phase 3) with Playwright against the live front door. A scratch build was served from `ctx.route`, `GET /api/workspaces` was faked (the live API predates migration 49), and every non-GET was aborted. `/api/stats/overview` was proxied, and its `perRepo` was trimmed to the requested `repoIds`, because the live API ignores the parameter. Nine finished tasks across three repos were rewritten to `queued`: six global and three custom. The checks:

- **Queue order.** In `tm` and `neko` scope, the Queue and Global queue rows were exact subsequences of the All order. Active sessions split 1 + 1 over the two live runs, and each section's `n more` added up to the All count.
- **Empty workspace.** A repo set with nothing in it showed `2 / 3 / 10 more in other workspaces` under the three sections.
- **Dashboard requests.** The Dashboard fetched `?days=14`. After a switch to Neko it fetched `?days=14&repoIds=<fe>,<nest>` (per repo 4 → 2 rows, title `Dashboard · Neko`), and back on All it fetched `?days=14` again.
- **Anomalies and feed.** Anomalies went from 59 to 48 findings, which equals the count computed from `/api/stats/anomalies` and the task repos. The feed dropped a TM task's `anomaly.notified` row.

There were no page errors. `npm run typecheck` and `npm run build` pass.

Verified (phase 3, Inbox) the same way: Playwright, a scratch build and a frozen REST snapshot. Synthetic decisions were added to the snapshot: reviews, failures, three questions (one on a task not in the store), a proposal and a feature. The checks ran at 1400 px and 393 px, in Classic and Glass:

| scope | page | Inbox chip / phone tab | ❓ chip | hint |
|---|---|---|---|---|
| All | 13 waiting · 8 stale | 13 | 3 | — |
| Neko | 5 waiting | 5 | 2 | 8 more |
| Task manager | 7 waiting | 7 | 2 | 6 more |
| Empty | nothing waiting | hidden | 1 (the unloaded task's) | 13 more |

Each count equals the shared `buildInbox` run on the snapshot. Pressing the hint drops `?ws` and restores the All counts exactly. There were no page errors, and the phone header does not overflow. A Glass issue that predates this change: at 1400 px the header's pill row wraps and covers the page title, the hint included. It is reachable at 1700 px and wider.

Verified (phase 3, Board) with Playwright at 1400 px and 393 px. A scratch build was served from `ctx.route`, `GET /api/workspaces` was faked with Neko = [neko-vite-new, neko-nest], and every non-GET was aborted. Under All the board rendered rows from other repos (15 on desktop, 11 on phone). On `?ws=neko` it rendered 29 and 22 rows, none outside the workspace, with the `workspace: Neko` chip. With the global key set to task-manager, the new-task default was neko-vite-new (the first repo). With `tm.newTask.repo.ws-neko` = neko-nest it was neko-nest. With that key set to task-manager (no longer in the workspace) it went back to neko-vite-new. Clearing the chip dropped `?ws`, restored the All rows, and the default became the global task-manager. `tm.board` was byte-identical before, across reloads and after. There were no page errors.

## What is not scoped

A workspace changes what the SPA SHOWS and nothing the server DOES (decisions.md 2026-10-28, view scopes):

- **The orchestrator**: one global worker pool, one `orchestrator.concurrency` cap, one enabled switch, one Pause all.
- **Claims and gates**: no claim SQL reads a workspace. `REPO_EXCLUSIVE_GATE`, `repoHasRoom`, `CUSTOM_QUEUE_HEAD_WHERE` and their JS twins are unchanged.
- **The custom queue**: still per repo and global. The Queue page filters what it lists AFTER ordering, so the scoped rows are a subsequence of the real run order.
- **`QuestionModal`**: global by design, since a blocked agent is blocked whatever you are looking at. The ❓ chip count IS scoped.
- **Push-health and other server banners**: global.
- **Telegram and Web Push**: no workspace concept. A push tap's `/?task=` opens under All.
- **`/api/stats/anomalies`**: unscoped on the server. The Dashboard filters it client-side.
- **Agents**: no API, nothing in a prompt, environment or claim order.

## Verification (phase 4, end to end)

These steps re-run the whole feature:

1. On `/repos#workspaces`, create a workspace with one repo. The slug preview equals the created slug.
2. Switch to it in the header. `?ws=<slug>` and `tm.workspace` are set, and every sidebar link carries `?ws`.
3. Check the Inbox (title `· <name>`, scoped count, `n more` hint), the Queue (scoped rows plus `n more in other workspaces`), the Dashboard (the request carries `repoIds=`) and the Board (`workspace: <name>` chip). The new-task form defaults to a repo in the workspace.
4. Full-load `/?task=<id>`: the panel opens under All and `tm.workspace` is kept. Then full-load a bare `/`: it lands on `/board?ws=<slug>`.
5. Delete the workspace while it is current. You get All, the toast "no longer exists — showing all repos", `?ws` dropped and `tm.workspace` cleared.

**Run on 2026-10-28** in Chrome (Claude in Chrome) at desktop width. The live API predated migration 49 and could not be restarted while agents worked, so the harness used the REAL `registerWorkspaceRoutes` over a `.backup` copy of the live DB (the migration seeded `neko` from its space), with a forwarding `/ws/events` and a scratch `vite build`. Other GETs were proxied to the live API and other writes were refused. The steps:

1. Created `E2E TM` → `e2e-tm` (task-manager only) through the form.
2. Switched with the header menu. The links carried `?ws=e2e-tm`.
3. Inbox: `Inbox · E2E TM`, nothing waiting. Queue: one active session (this task) with `1 more in other workspaces`, and an empty global queue with `2 more in other workspaces`. Dashboard: titled `· E2E TM`, both overview requests carried `repoIds=`. The totals were not narrowed, because the live API ignores the parameter, as noted in phase 3. Board: the `workspace: E2E TM` chip. New task: `17 - task-manager`.
4. `/?task=<id>` showed All with the memory kept. A bare `/` went to `/board?ws=e2e-tm`.
5. Deleting the workspace via the inline confirm fell back to All with the toast, `/repos` without `?ws` and the memory cleared. The list was back to `neko`.

No doc inaccuracies and no code defects were found. Not covered: phone width and Glass in this pass (phases 2–3 covered both), and live numbers from a scoped `/api/stats/overview`, which need the API restarted on this code.

## Verification (phase 1)

These checks ran against `app.inject` on a copy of the live SQLite DB, under tsx with nvm node v24:

- **Migration and seed.** The migration applies and seeds the one existing space. A second `migrate()` seeds nothing, and a deleted seeded workspace does not come back.
- **Seed collisions.** A second copy with spaces `neko`, `Neko`, `All` and `Проект` seeded the slugs `neko`, `neko-2`, `all-2` and `workspace`.
- **Routes.** CRUD and reorder work. All four write routes return 403 without Origin. A duplicate slug returns 409 on POST and PATCH, `all` returns 400, and a bad slug, unknown repo, colour 8 or empty name each return 400.
- **Slugs on create and rename.** A derived slug that collides gets a suffix. A rename keeps the slug.
- **Read filtering and side effects.** A ghost repo id is filtered on read but kept in storage. Each write leaves one audit row and the expected broadcasts.

`npm run typecheck` and `npm run build` pass. The pg driver was not run against a live Postgres. It runs the same SQL module, and its seed loop mirrors the SQLite one.

### Scoped stats

These checks ran on the same kind of DB copy:

- **Unchanged without the parameter.** `days=30` with no `repoIds` returned byte-identical JSON before and after the change, with `Date.now` frozen.
- **One repo.** On a 3-day window, scoping to one repo gave runs, cost, done, failed, attention and agent-filed counts that equal a hand-written SQL count. The `perRepo` table had that single row.
- **Two repos.** Two repos together gave the sum of the two single-repo results.
- **Empty list.** `repoIds=` returned zero totals and empty `perRepo`, `perModel`, `depth` and `byActor`.
