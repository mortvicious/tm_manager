# Repo commands — dev servers and scripts, run from the app

Registering a repo already tells the app where agents work. It did not let you
*do* anything in that directory yourself: starting `pnpm start:dev` in
neko-vite, or `yarn start:dev` in neko-nest, meant another terminal window
outside the tool, and nothing in the app knew whether a dev server was up.

A **command** is a saved command line belonging to one repo. It runs in a real
PTY — the same machinery as an agent session — so it is attachable from the
browser, its output scrolls back, and a dev server stays alive in the
background with a live indicator in the header.

## Model

`tm_commands` (migration 13) is the definition; a *run* is deliberately not
persisted.

| column | meaning |
|---|---|
| `repo_id` | owner, NOT NULL — a command line means nothing without its directory. Deleting the repo deletes its commands (tasks are only detached; commands are not) |
| `name` | label in the launcher |
| `command` | the command line as typed |
| `kind` | `task` = one-shot (prints, exits) · `service` = long-running (dev server, watcher) — services are what the header counts |
| `cwd` | subdirectory of the repo, relative and validated to stay inside it; null = repo root |
| `sort_order` | launcher order (`sort` alone reads as a keyword in too many dialects) |
| `is_check` | a CHECK (migration 34): run by the server after every worker turn, before the review, as part of the task's definition of done — `docs/checks.md` |
| `timeout_sec` | a check's wall-clock limit (NULL = 600 s, 10–3600); past it the check is stopped and counts as "no verdict", never red |
| `owner_task_id` | the task whose AGENT saved it (migration 45; backfilled from the `command.changed` audit rows); NULL = a human's, or adopted by one — never touched by the cleanup (§ Agent-owned commands) |
| `archived_at` | hidden from the launcher and the agent list, restorable from the repo's command panel; NULL = live |
| `last_run_at` | last start by anyone (`CommandRunner.start`, `touchCommandRun` — no `updated_at`, no broadcast); what "unused for N days" reads |

**Runs live in memory only** (`CommandRun`, `server/src/commands/runner.ts`). A
PTY dies with the server, so a persisted "running" row could only ever be a lie
after a restart — and `tm_runs` has one meaning that must not blur: an agent.
Boot recovery kills orphaned pids and fails their tasks by reading exactly that
table. The last 25 finished runs are kept for the launcher's history strip.

## Execution

- **No shell, ever.** The stored text is tokenized (`commands/parse.ts`) and
  spawned as an argv array, the same rule the worker spawn follows. An
  *unquoted* shell operator (`| & ; < > \` $(`) is therefore rejected at the API
  boundary with a message naming the alternative — it would otherwise become a
  literal argument that silently does nothing. Quoted and escaped operators are
  kept, because `node -e 'a > b'` passes a literal `>` to a real shell too.
- **The binary is resolved up front**: an explicit path as written, else every
  `node_modules/.bin` from the working directory up to the repo root (so a
  repo-local `vite` works with no global install), else `PATH`. A missing binary
  is a 400 with a readable reason instead of a terminal that flashes ENOENT and
  vanishes.
- **One live run per definition.** A second start answers 409 rather than
  racing two dev servers onto one port.
- **Its own PTY pool.** `CommandRunner` gets a second `SessionManager`
  instance, never the orchestrator's: a dev server is alive for hours, and
  sharing the pool would let it consume `liveCount()` (the concurrency
  accounting) and the `MAX_LIVE_SESSIONS` cap that agent spawns are checked
  against. `/ws/terminal/:id` looks the id up in both pools; command ids are
  `cmd-`-prefixed, so they never collide with a run id.
- **Shutdown and restart kill them deliberately** (`stopAll()`), so ports are
  released instead of being held by a process parented to a dead server.

## Checks

A command marked **check** (the third value of the kind dropdown, `isCheck` on
the API) is part of every task's definition of done in that repo: after each
worker turn the server runs the task's checks here, as ordinary attachable runs
in this pool (`CommandRunner.runCheck`, tagged `CommandRun.checkTaskId`, shown
as `check of task <id8>`), and red ones go back to the worker. A check's
baseline runs there too (`CommandRun.checkBaseline`, owned by no task). The full loop is
`docs/checks.md`. Rules at this layer: a check is a one-shot (`kind: 'task'`;
service + check is a 400), check names are unique per repo (409 — tasks pick
checks by name), the timeout is 10–3600 s, and a check runs with `CI=1` so a
test runner does not sit in watch mode. A run of the same definition already
live (a human pressed it) is waited out before the check starts. Agents cannot
mark checks: `/api/agent/commands` does not take the flag.

## Scanner

`GET /api/repos/:id/scripts` reads the repo's `package.json` scripts — the root
package plus workspace packages from `workspaces` / `pnpm-workspace.yaml`
(`dir/*` expansion only; this is a directory listing, not a crawl, bounded at 60
packages / 300 scripts). The package manager comes from `packageManager` first,
the lockfile second, and every suggestion is `<pm> run <name>`, which is valid
for pnpm, yarn, npm and bun alike. Script names that would need quoting are
skipped and counted in the returned note.

`kind` is *guessed*: a `dev`/`start`/`serve`/`watch`-shaped name, or a body
mentioning `nodemon`/`vite` (not `vitest`, not `vite build`)/`next dev`/
`--watch`, is a service. It is a guess that the dropdown next to every saved
command corrects in one click.

Each entry also carries `suggestedCheck`: the rule-based check suggestion (in
CI, or named typecheck/lint/test/build), with side effects (`--fix`, `--write`,
`-u`, builds into served output) flagged, never pre-selected, and with a safer
`instead` line when one is known. The drawer lists these under **Suggested
checks**, and *Save as check* runs a baseline before anything is saved. Both are
in `docs/checks.md` § Suggested checks / § Baseline.

## UI

- **Header launcher** (`components/Commands.tsx`): a bolt button that grows a
  pulsing dot and a count while anything is running — the "is my dev server
  up?" state. Its popover lists what is running (age, open terminal, stop),
  then a repo picker and that repo's commands to run.
- **Repos page**: the row carries one **Actions** cluster — a commands dropdown,
  *Analyze*, *Remove* — so the row reads as `git | actions` instead of three
  columns drifting apart on a wide screen. The dropdown lists every command with
  run/stop/terminal and opens the full drawer (scanner + add + kind + delete)
  behind *Add / manage commands…*. It is positioned `fixed` from the button's
  rect, because the table is a horizontal scroll container (`.tbl-scroll`, which
  is what keeps a wide row from scrolling the whole page) and would clip an
  absolutely positioned popover.
- A **one-shot** command opens its terminal on start — its output is the point.
  A **service** does not; it reports from the header instead.
- Deleting a definition whose run is still live detaches the run rather than
  killing it: a dev server you are browsing must not die because its shortcut
  was tidied away.

## API

| route | |
|---|---|
| `GET /api/commands[?repoId=]` | definitions |
| `POST /api/commands` | create (validates the command line and the cwd against the repo; `isCheck`, `timeoutSec`, `baselineId` + `acceptRed` — `docs/checks.md`) |
| `PATCH /api/commands/:id` | edit (the repo is fixed) |
| `DELETE /api/commands/:id` | delete; a live run detaches |
| `GET /api/repos/:id/scripts` | scanner (+ `suggestedCheck` per script) |
| `POST /api/commands/baseline` | a check's baseline: run a line once on the current tree before saving it · Origin · 202 (`docs/checks.md` § Baseline) |
| `GET /api/commands/baseline/:id` | the baseline's result (polled) · 404 after a restart |
| `POST /api/commands/:id/run` | start · 409 already running / PTY cap · 400 unrunnable |
| `GET /api/command-runs` | runs, newest first |
| `POST /api/command-runs/:runId/stop` | SIGHUP, SIGKILL after 5s |
| `POST /api/command-runs/clear` | drop finished runs from the list |

`command.updated` / `command.deleted` / `command.run` ride `/ws/events`, so a
second tab and the header agree without polling.

## Agent API

Workers use the same commands instead of dev servers in background shells of
their own (`server/src/routes/agent-commands.ts`, token-authenticated like the
rest of `/api/agent/*`; the worker-facing how-to is `docs/agent-instructions.md`
§ Dev servers, and a clause in the standing rules points there). A private
`npm run dev &` is invisible to the human, fights the next agent for the port,
dies with the session, and — being a background shell — holds the turn in
`waiting` for `agent.shellWaitMinutes`. A saved command run is one process per
definition, shared by everyone, in the commands pool, outliving the turn.

| route | |
|---|---|
| `GET /api/agent/commands[?repo=<id\|name>]` | definitions + latest run each (`yours` = this task may stop it); default = caller's repo |
| `POST /api/agent/commands` | save one in the caller's repo, owned by the caller's task (kind defaults to `service`); same validation as the human route PLUS the argv directory rule and no temp-folder paths; same command line + cwd already saved → 409 with it (an ARCHIVED agent twin is revived for the caller instead); caps `AGENT_COMMAND_DEFINE_CAP` (3) per run and `AGENT_COMMANDS_PER_REPO_CAP` (20) live agent-owned per repo |
| `POST /api/agent/commands/run` | **one-shot**: an unsaved command line in the same pool (§ One-shot runs); `{command, cwd?, name?, kind?, waitFor?, waitMs?}` |
| `GET /api/agent/commands/runs/:runId/logs[?bytes=]` | tail of any run in the pool by run id (how a one-shot is read) |
| `POST /api/agent/commands/runs/:runId/stop` | stop a run by id — only one the caller's TASK started |
| `POST /api/agent/commands/:id/start` | **start or reuse**: already running → `started: false` and that run, not 409 |
| `POST /api/agent/commands/:id/restart` | stop, wait for the exit (≤ 8s), start; caller's own repo or a run its task started |
| `POST /api/agent/commands/:id/stop` | only a run the caller's TASK started (`ownerTaskId`), else 403 |
| `GET /api/agent/commands/:id/logs[?bytes=]` | ANSI-stripped tail of the latest run (default 8000, max 64000) |

- **Start/restart can wait for readiness**: `{waitFor: string | string[], waitMs}`
  (case-insensitive substrings, `waitMs` default 30s when `waitFor` is given,
  max 60s) holds the reply until a needle appears in the last 256k of output,
  the process exits, or time runs out — so a reused server whose ready line
  was printed an hour ago answers at once. The reply carries `ready`, the run
  and a 4000-byte `tail`; a dead run plus `ready: false` is a crash and the
  tail is its log. Substrings, not regexes: an agent-supplied regex would run
  in the API's event loop.
- **Ownership** is `CommandRun.ownerTaskId` (+ `startedBy`, the audit actor),
  set by `CommandRunner.start`. It names the task, not the run, so a later turn
  of the same task may still stop what an earlier turn started. A restart keeps
  the previous run's owner: restarting a human's server never gives the agent
  the right to stop it. Humans stop anything from the UI, as before; the
  launcher shows `by agent:<run8>` on an agent's run.
- **Reach**: list/start/logs work on any registered repo's commands (a
  frontend agent may need the backend's API up). Restart and define are the
  caller's own repo; stop is the caller's own runs.
- **Lifetime**: an agent's server is NOT stopped when its task ends — it is
  shared, and the next agent will want it. The commands pool's own cap
  (`MAX_LIVE_SESSIONS`, 10) bounds the pile; the human sees it in the header.
  Its DEFINITION is another matter: see § Agent-owned commands.
- **Races**: `start()` checks and claims synchronously, so of two agents
  starting one command in the same tick one gets the run and the other reuses
  it; the route turns the loser's "already running" into that reuse.
- Audit: `command.run` (`started` with `ownerTaskId`, `stop-requested`,
  `restart-requested`) and `command.changed` rows carry `agent:<run8>` and the
  task id. `GET /api/agent/context` lists the caller's repo's commands with a
  `running` flag.

## Agent-owned commands

Measured before this existed (autonomy-round analysis 663c5006, feasibility
§ 10): 98 agent-saved commands in one repo from 59 tasks, 86 of them naming a
task-specific path (a session scratchpad script, or `env -C "<repo>-<task
worktree>"`), so the exact-text dedupe never matched and the launcher listed 99
services. The per-run cap resets on every resume, retry and boot. So a
definition an agent saves now has an owner and a life span
(`server/src/commands/cleanup.ts`, decisions.md 2026-10-26):

- **Owner** = `tm_commands.owner_task_id`, the task of the run that saved it.
  Pre-45 rows were backfilled once, in the migration's transaction
  (`commandOwnerBackfill`, both drivers): the agent `created` audit row of the
  same repo, name and command line nearest the row's `created_at` (≤ 60 s). No
  match stays unowned — the safe side.
- **Archived, never deleted**, when the owner is `done`/`published`/
  `cancelled` or gone, or when nobody started it for `commands.agentTtlDays`
  (default 7; 0 = owner rule only; measured from `last_run_at`, else
  `created_at`). `failed` is not an end (it gets retried). Never a check, never
  a human's, never while a run of it is live (the next pass gets it). Each
  archive is a `command.changed {action: 'archived', commandId, reason:
  owner-done|owner-published|owner-cancelled|owner-gone|unused}` row by
  `system`. The sweep runs at boot, every 10 min, and 5 s after any
  `task.transition` into done/published/cancelled (coalesced, single-flight).
- **Archived** = out of the launcher, the agent list and `/api/agent/context`;
  start/restart by id answer 409 (logs still read). Saving the same line again
  REVIVES the archived row for the new task (`action: 'revived'`) instead of
  minting a twin. A human-archived unowned command is not the agent's to revive.
- **Humans adopt**: `POST /api/commands/:id/restore` clears both `archived_at`
  and the owner; any human PATCH other than `sortOrder` clears the owner
  (`adopted: true` on its audit row). `POST /api/commands/:id/archive` hides any
  non-check command by hand (`reason: 'human'`).
- **Directory rule** (`directoryEscape`, `commands/parse.ts`), on define AND
  one-shot: the `cwd` field was already kept inside the repo, but the argv could
  leave it. Refused: a directory option (`-C`, `--chdir`, `--cwd`, `--dir`,
  `--directory`, `--prefix`, `--work-tree`, `--git-dir`, `=` and attached forms,
  whatever the tool) whose value resolves OUTSIDE the repo; `cd`/`pushd`; a
  shell with `-c`; `env -S`. Every token is scanned, so a wrapper's nested
  command is covered; `grep -C 3` or `pnpm --dir web` pass. Fails closed: a
  tool's own `--dir` pointing at an outside output folder is refused too.
- **Temp paths** (`tempPathIn`) are refused on SAVE only — `/tmp`,
  `/private/tmp`, `/var/folders`, `os.tmpdir()`: a scratchpad script dies with
  its session and the saved button would not. That line is a one-shot.
- Human commands are untouched by all of this, including the directory rule.

**UI**: the header launcher lists the repo's human commands first and folds
the agent-saved ones under an `agent-saved · n` toggle (with a running count).
The Repos command panel sorts human first, chips agent rows `agent · <task8>`,
offers Archive on every non-check row, and lists archived rows under a fold
with Restore. Config → Board has the TTL.

## One-shot runs

`POST /api/agent/commands/run` is the default for a throwaway server or
script: same tokenizer, `cwd` check and directory rule, same pool (so the
human can attach it and the pool cap holds), NOTHING written to `tm_commands`
(`CommandRunner.startOneShot`: a synthetic definition, `commandId: null`,
`CommandRun.oneShot`). Owned by the caller's task (stop rights), at most
`AGENT_ONE_SHOT_TASK_CAP` (3) live per task, readiness via the same
`waitFor`/`waitMs`. In memory like every run: once it ends and is trimmed from
the last 25, nothing is left. Its audit row is `command.run {action: 'started',
oneShot: true}`. The launcher shows it in `running` as `one-shot by
agent:<run8>`.

## Restart is refused while agents are working

A restart kills every agent, and **two kinds of agent exist**:

- **Interactive workers** — a PTY in the `SessionManager`. Losing one loses the
  session, and boot recovery sweeps its task to `failed`.
- **Aux sessions** — review, plan, plan-review, analysis, compact, report,
  chat, commit. Since 2026-09-24 each is an interactive PTY of its own, in a
  THIRD pool (`claude/aux.ts`, `docs/design.md` § PTY sessions). They take no
  worker slot, so `sessions.liveCount()` cannot see them, and gating only on
  that number would let a restart kill a review mid-flight — precisely the harm
  the rule exists to prevent. The runner's `liveLabels()` is their count, and
  `OrchestratorStatus.aux` / the restart check's `aux` field carry it (both were
  `headless`); a forced restart calls `aux().stopAll()`.

*History, the headless era:* `server/src/claude/headless.ts` was the registry for the second kind: every
headless spawn registers its child with a label (`analysis of neko-vite`,
`reviewing "…"`, `feature planning: …`), and it deregisters on `exit` or
`error`. It is keyed by the child process rather than a run id on purpose — a
feature analysis runs several children under one run row, and the adversarial
reviewer has no run row at all, so a run-id key would have missed it.
`OrchestratorStatus.headless` carries the count to the UI, and the registry
notifies on every change so the header follows without polling (a headless agent
starts and ends with no PTY event to piggyback on).

`POST /api/server/restart` answers **409** while `running > 0` **or**
`headless > 0`, naming what is working; the header button says *Agents working*
and is disabled, with both counts in its tooltip and `+n` on the running pill.
`{"force": true}` is the deliberate override (curl, or a UI that asked twice),
and it signals the headless children on the way out so a forced restart does not
leave `claude -p` processes burning tokens for a server that is gone — the same
courtesy shutdown already extends to dev servers. Running commands are never a
reason to refuse: they are simply stopped first, and the confirm says how many.

Deliberately *not* counted: the one-shot `claude` that writes a commit message
(`git.ts`). It holds no run row, destroys no agent work, and is a few seconds of
a button the user just pressed.

Two latent bugs on that path were fixed at the same time, both proven in a live
instance:

1. The self-restart used `require('node:child_process')` in an ESM module and
   threw `require is not defined` — the old process exited and **nothing ever
   came back**.
2. With that fixed it respawned `process.argv`, which under `tsx` is already
   rewritten to `[node, /abs/index.ts]`: a bare node that died on the first type
   annotation. The respawn now carries `process.execArgv` (tsx's `--require` /
   `--import`), which is empty and harmless for a plain `node file.js`.
3. `orchestrator.status` was broadcast on toggle and on exit but never on
   *spawn*, so the header's `running n/2` — and therefore the new guard — stayed
   stale for a whole session. `startWorker` broadcasts it now.
