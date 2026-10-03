# Shared spaces — one knowledge base for repos that work on one product

A **shared space** is a set of registered repos that belong to one product,
for example neko: `3 - neko-nest` (backend), `4 - neko-vite-new` (frontend)
and `18 - neko-frontend` (the Next.js migration). The repos in a space share
two things:

- **A knowledge folder** on disk, outside every repo. Workers get it as
  `$TM_SHARED_DIR`, and you open it in Finder or VS Code.
- **A ledger** (`tm_shared_notes`) of cross-repo **requests** ("repo B must do
  X because of my change") and **notes** (durable knowledge for every member).

## Why

Every worker runs in its own working tree. It cannot see another repo's
conversation or `$TM_ARTIFACTS_DIR`. Before spaces, the failure looked like
this:

1. next finds a bug while migrating.
2. nest fixes it and writes a report into its own artifacts.
3. Nobody reads that report. The follow-up for vite or next is never filed,
   because the task that would file it had run out of depth or was not
   related, and dispatch only reaches related tasks.
4. The work is forgotten and half-implemented.

Spaces make the hand-over durable and pull-based. nest writes a **request**
addressed to the repo that must act. The next agent that works in that repo,
on any task, sees it at the start of its turn. That agent checks whether the
work is already done, then resolves the request or files it as a task.

## Model

| | |
|---|---|
| `tm_spaces` (migration 30) | `id, name, path, repo_ids (JSON), created_at, updated_at`. A repo is in **at most one** space, so a worker has exactly one `$TM_SHARED_DIR` (409 otherwise). "Outside every repo" is enforced from both sides: registering or moving a repo into (or around) a space folder is a 400 (`spaceConflictForRepo`), and `sharedContext` re-validates at every spawn, sharing nothing on that turn if the folder now overlaps a repo. A deleted repo's id stays in `repo_ids` and is filtered on read (FK-less). |
| `tm_shared_notes` (migration 30, FK-less) | `kind request\|note`, `title`, `body` (markdown ≤ 20k), `from_repo_id`, `from_task_id`, `to_repo_id`, `status`, `task_id`, `resolution`, `files` (JSON, paths relative to the folder), `actor`. |
| Request lifecycle | `open` → `filed` (a task exists) → `done`, or `dismissed` at any point. **The task is the truth for `filed`**: `reconcileFiled` runs on every read (list, prompt, Telegram). When the task lands `done`/`published` the request becomes `done`. When the task is `cancelled` or deleted the request goes back to `open`, with the reason in `resolution`. A `failed` task (or a draft nobody enqueued) keeps the request `filed`, because the task is retried or enqueued, not abandoned, and reopening would invite a duplicate filing. Both wait on a human, so the Shared page and Telegram `/shared` flag them **needs you** (`SHARED_FILING_STALLED`). |
| Notes | `open` means active, `dismissed` means archived. `to_repo_id` is optional ("about"). |

Mutations go through `server/src/spaces/service.ts`, which is called in-process
by the SPA routes (`routes/spaces.ts`, actor `human`), the agent API
(`routes/agent-shared.ts`, actor `agent:<run8>`) and Telegram `/shared`
(read-only). There is no second copy of this logic. Each change is a
`shared-note.changed` / `space.changed` audit row and a
`shared-note.updated|deleted` / `space.updated|deleted` WS event.

**Filing is single-winner.** `open → filed` is a conditional write
(`updateSharedNote(id, patch, ['open'])`). Two agents triaging the same
request at once cannot both file it; the second one gets 409 with the task id.

**Duplicates.** An open/filed request to the same repo with the same title
(case-insensitive) answers 409 with the existing id. Agents append to it
instead (`POST …/append`).

## The folder

| Path | What | Who writes |
|---|---|---|
| `README.md` | Conventions, member repos, API cheat-sheet. **Rewritten** on every space change. | the server |
| `REQUESTS.md` | The ledger mirrored as markdown: open requests grouped by target repo, active notes, and the last 30 resolved. Rewritten on every note change. | the server |
| `CLAUDE.md` | **Generated** from `INDEX.md` on every agent start: the working rules ("read before you plan", "write knowledge here, requests through the API") plus a copy of `INDEX.md` (≤ 16k chars). Workers load it as memory. A `CLAUDE.md` without the `tm:shared-memory` marker line is the user's and is never overwritten. | the server |
| `INDEX.md` | The map. Start here. | agents, humans |
| `knowledge/<topic>.md` | Durable, deduplicated facts (contracts, data model, migration status, gotchas). | agents, humans |
| `repos/<repo>.md` | Per repo: what it owns, current state, what the others must know. | agents, humans |
| `archive/` | Original per-task outputs, copied for history. | — |
| `.tm/import.json` | Seed file: imported into the ledger **once** (on space creation, or the Shared page's *Import seed*), then renamed to `.tm/import.imported-<ts>.json`. | humans, tooling |

The seed format is `{ "version": 1, "items": [{ "kind", "from", "to", "title", "body", "files", "sourceTaskIds" }] }`.
`from`/`to` are a member repo's id, exact name, or unambiguous role. An item
that does not resolve is skipped and counted, never guessed. A self-addressed
request is also skipped.

**Path rules** (`validateSpacePath`). The path must be absolute or start with
`~/`. It must not be `/` or `$HOME`. It must be **neither inside nor
containing** any registered repo:

- Inside a repo, it would be committed into that repo's history.
- Containing a repo, `--add-dir` would hand every worker write access to whole
  working trees.

The folder is created if missing. Deleting a space deletes its row and its
ledger, **never the folder**.

**Reading files from the SPA** (`GET /api/spaces/:id/file?path=`). The path is
normalised (`safeRelative`, no `..`, no absolute paths). Then **both** sides
are `realpath`-ed and the file must be inside the root, so a symlink that
escapes is a 404. Only regular files are served:

- Text extensions and extension-less files are served inline as `text/plain`
  with `nosniff`, up to 5 MB.
- Everything else is served as an `attachment`.
- The listing skips `.git`, `node_modules` and symlinks, and caps at 2000
  files.
- The SPA renders `.md` with `Markdown safe`, which escapes raw HTML and keeps
  only http(s)/relative/anchor/mailto links. Anything can be copied into this
  folder, unlike agent output from our own server.

## What a worker gets

The orchestrator does this in `startWorker` → `sharedContext()`, the single
funnel every turn goes through, the same place the `fyi` dispatch note is
drained.

- **`TM_SHARED_DIR`** in the PTY env, and **`--add-dir=<folder>`** on the claude
  argv, so writing knowledge there is not an out-of-workspace edit. The `=`
  form is deliberate: `--add-dir` is variadic and would otherwise swallow the
  prompt. Both are also set on the publish turn.
- **The map in context, not just its address.** The PTY env also carries
  `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, which makes the CLI load
  `CLAUDE.md` from `--add-dir` folders as memory. The server writes that file
  (`writeSharedMemory`) with the rules and a copy of `INDEX.md`, refreshed on
  every spawn from `sharedContext()`, since agents edit the map between
  turns. The shared folder is a worker's only `--add-dir`, so no other
  directory's memory comes in.
  - Measured on CLI 2.1.280. With the variable, a codeword in an add-dir
    `CLAUDE.md` reached the model, both in `-p` and in an interactive PTY
    under the workers' permission mode (`auto`), with no dialog. Without the
    variable it did not.
  - `@INDEX.md` imports inside that file were **not** followed, whether
    relative, `./` or absolute. That is why the map is copied in rather than
    imported.
  - Codex workers get no `--add-dir`, so no memory. The prompt block tells the
    agent to open `INDEX.md` if it does not see the copy.
- **A prompt block** (`sharedPromptBlock`). It is never concatenated onto
  `followUp` and never on the publish turn.
  - **Fresh session**: the block **leads the prompt**, above `# Task:`.
    Before 2026-09-28 it sat between the task description and the standing
    rules. A neko-frontend agent (task d474e1e1) read past its "Start with
    INDEX.md", went straight to the code, and missed that the fallback it
    needed had already shipped in another task and that F57 was still
    unpushed. The block now says:
    - read before you plan;
    - **Step 1, before your plan**: read the files `INDEX.md` points to for
      this task's area, plus this repo's page (`repos/<name>.md`, matched by
      `repoPage`);
    - the plan must name the shared files read, or say none apply;
    - a subagent's brief must include `$TM_SHARED_DIR`.

    Then come the rule "write what others need here" and up to 10 **open**
    requests addressed to this repo, oldest first, with the rest counted. The
    block also carries the triage rule: before you finish, never instead of
    your task, and never implemented inside it unless it is in scope. Resolve
    with evidence, or file.
  - **Resumed session**: only open requests **updated after the resumed run
    started**, meaning new, reopened (by reconcile or a human) or appended. The
    session already read the rest. There is no block at all when nothing
    qualifies, so a follow-up or fix round pays nothing. The cut is applied
    after the reconcile and on `updated_at`. The first version cut on
    `created_at` in SQL, and a reopened request, which keeps its creation
    date, never reached a resumed session (review round 2).
  - The list is read with `open` **and** `filed` and then filtered to `open`,
    so a request whose filed task was cancelled reopens and is offered here
    without anyone opening the Shared page first.
  - Any error builds no block and logs. A ledger problem never fails a spawn.

## Filing (the depth rule and the custom queue)

`POST /api/agent/shared/notes/:id/file` is the one agent path that files work
into the agent's **own** repo without the same-repo draft rule:

- It is only allowed for a `request` whose `to` is the caller's repo (403
  otherwise). The author repo cannot file on the target's behalf.
- The task is created as a draft with the request body plus provenance (the
  request id, the folder, the files, and how to resolve the request if it is
  already done). It is then moved into the **custom queue** (`queueAddTask`,
  docs/queue.md). That queue is strictly serial and runs even while the global
  queue is stopped.
- **An agent-filed member waits for its filer and for live work.** The head
  SQL (`CUSTOM_QUEUE_HEAD_WHERE`, `storage/queue-sql.ts`) skips a member with
  `created_by_run` set while either of these holds:
  - **Its filer is unresolved.** The filer is the task behind
    `created_by_run`, in the same repo. Unresolved means `running`,
    `waiting`, `blocked`, `review` **with its automatic review round still
    open** (`pending|reviewing|fixing`), **or `failed`**. `repoBusy` alone is
    not enough: at its Stop the filer is idle and parked in `review` while its
    review round runs (review round 1). A filer that failed after filing may
    have left its edits; a retry or a cancel resolves it.
    *Changed 2026-09-28* (docs/queue.md § When the next member starts): a
    filer whose review has SETTLED and that only waits for the human in
    `review` no longer holds the filing. The filed task then starts on top of
    the filer's tree — the reviewer still scopes each task to its own
    `Task:`-trailer commits, but an uncommitted filer diff is no longer read
    once the filed task has worked in the checkout.
  - **Any task in the repo is working or mid-review.** Working means
    `running`/`waiting`, including a turn inside the resume gate with no PTY
    yet. Mid-review means `review` with `review_state`
    `pending|reviewing|fixing`, whose findings are about to be typed back
    into a session in that checkout.
- **Finished work that only waits for you in `review` does NOT hold a filing.**
  Round 1's first fix held on every unresolved task in the repo. Without
  auto-publish a review column stays full for days, so a filed request would
  never have run on its own (review round 2). Other tasks' review items are
  the same exposure every human-added member and the global queue already
  accept.
- This hold is why skipping the draft rule is safe. The board's queue chip
  names the task a filing waits for (`customQueueBlocker`, the JS twin), and
  Run now still overrides.
- **What still applies:**
  - the per-session creation cap (`agent.taskCreationCap`)
  - the depth cap (below)
  - `agent.allowEnqueue` off → a draft, with a `note` saying so
  - the agent queue ceiling (10 queued agent-created tasks) → a draft
- Humans file from the Shared page as a draft or straight into the custom
  queue.

**Depth** (`agent.maxSpawnDepth`, default **6**, 1..50 — the ceiling was 10 until 2026-09-30, raised at the user's request for 20 — on the Config page) is
how many agent hops from a human a task may be and still file tasks. A
human's task is depth 0. It used to be a hard-coded 2, and that was one reason
follow-ups went unfiled. It is global **on purpose**. The user's answer was
"disable task managers restriction that disallows "2 steps from human", make
it at least 6 steps from human or give some sort of popup-windows for me to
allow/disallow". That is the task manager's own restriction, not a
shared-space one. Set it back to 2 on the Config page to restore the old
guard. The refusal is still 403, as it was. It applies to `POST /api/agent/tasks` and to filing
alike, and it is templated into the instruction sheet (`{{maxSpawnDepth}}`).
It is also reported by `GET /api/agent/context`, which now carries
`maxSpawnDepth` and `sharedSpace`.

- The overflow-claim bound is no longer "depth ≤ 2 ⇒ cap×3". What holds at any
  depth is the explicit PTY-hard-cap check right below it.
- The `max-depth` anomaly fires at the configured cap.

## Out of scope (for now)

- **Aux sessions** (chat, analysis, feature planning, review) do not get the
  space. A chat in a member repo can still read the folder by path.
- **Codex workers** get `TM_SHARED_DIR` and the block, but no `--add-dir`. The
  `codex exec` sandbox keeps writes in the repo, so a Codex worker uses the
  API for requests and cannot edit the folder's files.
- Changing a space's path does not move the folder's files. A path change
  **repoints**. It is refused (409, "move the folder first") while the old
  folder still holds content of yours (anything but the generated
  `README.md`, `REQUESTS.md`, `.tm`) and the new one holds none. So agents
  are never pointed at an empty folder while the knowledge stays behind.
  `mv` it, then change the path.

## APIs

Agent (token-guarded like the rest of `/api/agent/*`, scoped to the caller's
space; a repo in no space answers 404):

| Route | |
|---|---|
| `GET /api/agent/shared` | the space and its members, requests to your repo (full), your repo's open asks, active notes, a how-to |
| `GET /api/agent/shared/notes?status=&kind=` | briefs (default `open,filed`) |
| `GET /api/agent/shared/notes/:id` | one note in full (reconciled) |
| `POST /api/agent/shared/notes` | `{kind, title, body, to?, files?}`. `to` is a member id, name or role. A request needs `to`, and it must not be your own repo. The cap is **10 per session**. |
| `POST /api/agent/shared/notes/:id/append` | `{text}`: a dated update from your repo/task, from any member |
| `POST /api/agent/shared/notes/:id/resolve` | `{status: done\|dismissed, resolution}`. Only the addressed repo or the author repo may do this, and only from `open\|filed`. |
| `POST /api/agent/shared/notes/:id/file` | see *Filing* |

Human (the SPA's **Shared** page, `web/src/pages/Shared.tsx`). Every write
here acts as `human`, so it needs an `Origin` header (403 without one), like
the questions answer route. Otherwise a worker's curl could file with
`{placement:'queue'}` past the creation and depth caps that the agent path
enforces (review round 2):

| Route | |
|---|---|
| `GET/POST /api/spaces`, `PATCH/DELETE /api/spaces/:id` | Create imports the seed. Delete keeps the folder. |
| `POST /api/spaces/:id/import` | import `.tm/import.json` now |
| `GET /api/shared-notes`, `GET/POST /api/spaces/:id/notes` | Create may name a member as the author (`fromRepoId`). |
| `PATCH/DELETE /api/shared-notes/:id` | Status is `open\|done\|dismissed` only. `filed` is reached only by filing, and reopening detaches the task. |
| `POST /api/shared-notes/:id/file` | `{placement: draft\|queue}` |
| `GET /api/spaces/:id/files`, `GET /api/spaces/:id/file?path=` | the folder browser |

Telegram: `/shared` lists the open and filed requests per space (read-only).

## Verification (2026-09-28)

These checks ran against an isolated API instance: a copy of the tree, a fresh
SQLite DB, port 5195, and a stub `claude` on `PATH` that records its
argv/env. Fake `running` run rows supplied the agent tokens.

- **Space creation.** The path guards gave 400 (inside a repo, containing a
  repo, relative) and 409 (a repo already in a space). The seed import brought
  in 2 of 4 items: a bad target and a self-request were skipped, and a
  `../etc/passwd` file entry was dropped. The seed file was renamed afterwards,
  and `README.md`/`REQUESTS.md` were written.
- **Agent writes and reads.** A duplicate request → 409 with the id. A
  self-request, a missing `to`, an absolute file or an unknown repo → 400. No
  token → 403. The 11th note in a session → 403.
- **Filing.**
  - The author repo trying to file → 403. Filing a note → 400.
  - With `allowEnqueue` off → a draft, with a note. Filing twice → 409.
  - With it on → `queued` in the custom queue, which the pump claimed and
    spawned.
  - The stub saw `TM_SHARED_DIR`, `--add-dir=<folder>` and the block.
  - **The filer hold (after review round 1).** The global queue was stopped.
    The filer was a global task in `next`, and the request was filed with its
    token. Each step waited one scheduler tick (12 s). The filed task stayed
    `queued` with 0 spawns while the filer was `running`, and while it was
    idle in `review` (the reported bug). It also stayed queued once the filer
    was `published` but another `next` task was `blocked`. With the repo
    clear it was claimed (`claim: custom-queue`) and spawned once. Meanwhile
    a human member in `vite` ran straight away. A human-added `next` member
    still ran beside a non-member in `review`, which is the unchanged
    member-only rule.
- **Depth.** 6 → 403 on both `/tasks` and `/file`; 5 → allowed.
- **Reconcile.** The filed task `done` → request `done`. The task `cancelled`
  → request `open` with the reason. A fresh prompt then lists it again.
- **Resolve.** A third repo → 403. The target → done. Resolving again → 409.
- **Resume.** A request created after the resumed run started appears under
  "New requests…". A second resume with nothing new has no block.
- **File serving.** `../`, absolute, `a/../../x` and an escaping symlink →
  404. `.md` → `text/plain`, `.png` → attachment.
- **Human edits.** `status: filed` → 400. A request with `to: null` → 400.
  Reopening clears the task. Deleting a space keeps the folder and drops the
  ledger.
- `npm run typecheck` and `vite build` pass.

**Review round 2 (same harness, fresh DB each time):**

- **Narrowed hold.** Each step waited one 10 s scheduler tick. The filed task
  stayed `queued` with 0 spawns while its filer was `running`, in
  `review`/`passed` and idle, or `failed`. With the filer published it stayed
  queued while another task in the repo was `review`/`reviewing` or
  `running`. It was claimed and spawned once when that task was only
  `blocked`. A second filing ran with an unrelated old `review`/`passed` item
  in the repo, the case that used to starve.
- **Reopened request on resume.** The request was filed as a draft, then the
  resumed run started, then the draft was deleted, then a follow-up turn ran
  (a real `--resume`). The block "New, reopened or updated requests…" listed
  the reopened request. An old open request untouched since the run started
  was not listed.
- **Overlap.** Registering a repo inside the space folder → 400 naming the
  space. A repo containing the folder → 400. Moving an existing repo into it
  → 400.
- **Path change.** With `INDEX.md` and `knowledge/` in the old folder, a
  repoint to an empty folder → 409 "move the folder … first". After `mv` it
  succeeded. On a folder holding only the generated files, the repoint
  succeeds as before.
- **Origin.** Without `Origin`, POST note, PATCH note, POST file and DELETE
  space → 403. GETs still answer. With `Origin`, PATCH works.
- **Browser click-through** (Chrome, the SPA via Vite on 127.0.0.1 against the
  test API). Worked: the Shared page's request list and expanded rows, the
  **needs you** flags on a failed and a draft filing, the Notes and Files
  tabs, `REQUESTS.md` rendered in the viewer, a note created through the form
  (Origin passes), and the space edit form. The Board's queue chip on a held
  filing read `waiting for "<filer>" (running)`, then `(review)` once the
  filer was parked. No console errors.
- **Telegram `/shared`** (handler run in-process against the test DB): the
  failed and draft filings carry ⚠️ and "needs you: retry or cancel /
  enqueue its task".
- **Postgres.** A throwaway local PostgreSQL 18 cluster in the scratchpad, on
  the same API with `driver: postgres`. Migration 30 created both tables.
  Everything below behaved as on SQLite:
  - space create with seed import (2 imported, the bad target skipped)
  - one space per repo → 409, and a duplicate title → 409
  - agent `GET /shared` and note create
  - filing into the custom queue (`queued`, marked), and filing twice → 409
  - the filer hold through the pg peek/claim (held while the filer was
    running and in review; claimed once it was published)
  - reconcile to `done`, a human dismiss, and the file list
  - space delete (the transaction dropped the notes, the folder was kept)

**"The agent skipped the shared space" (2026-09-28, after the space went live):**

- **Diagnosis, from the live data.** Task d474e1e1's first prompt (from its
  session transcript) held the block at character 6039 of 10040, after the
  task description. The mechanics worked; the placement and wording did not.
- **Real CLI, CLI 2.1.280, Haiku.**
  - `-p` with an add-dir `CLAUDE.md` holding a codeword: reported with
    `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, `NONE` without it.
  - `@INDEX.md`, `@./INDEX.md` and an absolute `@` import in that file were
    not followed.
  - An interactive PTY in a trusted repo with `--permission-mode auto`, the
    live workers' mode, reported the codeword, with no dialog on screen.
- **Isolated server with the stub.**
  - The fresh prompt's first line is `## Shared space "neko" (…): read before
    you plan`, above `# Task:`. It carries "Step 1, before your plan", the
    repo page (`repos/neko-frontend.md` for `18 - neko-frontend`,
    `repos/nest.md` for `3 - neko-nest`) and the open request.
  - The env carries `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` next to
    `--add-dir=<folder>`.
  - `CLAUDE.md` was written at space creation with the `INDEX.md` copy.
    After a line was appended to `INDEX.md`, the next spawn refreshed it.
  - A `CLAUDE.md` replaced by a user's own (no marker) was left untouched by
    the next spawn.
- **The neko folder.** Its `CLAUDE.md` was generated from the live repos and
  space (12.6k chars, the whole `INDEX.md` under the 16k cap). Each member
  maps to its own page: `repos/neko-nest.md`, `repos/neko-vite-new.md`,
  `repos/neko-frontend.md`.

## Setting up neko

The last two weeks of task outputs from the three neko repos were
consolidated into `~/Development/neko-shared/`: `INDEX.md`, `knowledge/`,
`repos/`, `archive/`, and `.tm/import.json` holding the open cross-repo items.
The migration runs on the next API restart, which is refused while agents
work. After it:

1. Open **Shared**, then **New space**.
2. Name it `neko`, with path `~/Development/neko-shared`.
3. Pick `3 - neko-nest`, `4 - neko-vite-new` and `18 - neko-frontend`.

Creating the space imports the seed. From then on every worker in those
repos starts with the folder and its repo's open requests.
