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

## Scanner

`GET /api/repos/:id/scripts` reads the repo's `package.json` scripts — the root
package plus workspace packages from `workspaces` / `pnpm-workspace.yaml`
(`dir/*` expansion only; this is a directory listing, not a crawl, bounded at 60
packages / 300 scripts). The package manager comes from `packageManager` first,
the lockfile second, and every suggestion is `<pm> run <name>`, which is valid
for pnpm, yarn, npm and bun alike. Script names that would need quoting are
skipped and counted in the returned note.

`kind` is *guessed*: a `dev`/`start`/`serve`/`watch`-shaped name, or a body
mentioning `nodemon`/`vite`/`next dev`/`--watch`, is a service. It is a guess
that the dropdown next to every saved command corrects in one click.

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
| `POST /api/commands` | create (validates the command line and the cwd against the repo) |
| `PATCH /api/commands/:id` | edit (the repo is fixed) |
| `DELETE /api/commands/:id` | delete; a live run detaches |
| `GET /api/repos/:id/scripts` | scanner |
| `POST /api/commands/:id/run` | start · 409 already running / PTY cap · 400 unrunnable |
| `GET /api/command-runs` | runs, newest first |
| `POST /api/command-runs/:runId/stop` | SIGHUP, SIGKILL after 5s |
| `POST /api/command-runs/clear` | drop finished runs from the list |

`command.updated` / `command.deleted` / `command.run` ride `/ws/events`, so a
second tab and the header agree without polling.

## Restart is refused while agents are working

A restart kills every agent, and **two kinds of agent exist**:

- **Interactive workers** — a PTY in the `SessionManager`. Losing one loses the
  session, and boot recovery sweeps its task to `failed`.
- **Headless `claude -p` children** — analysis, adversarial review, feature
  planning/review. They own no PTY, so `sessions.liveCount()` cannot see them,
  and gating only on that number let a restart kill an analysis mid-flight —
  precisely the harm the rule exists to prevent.

`server/src/claude/headless.ts` is the registry for the second kind: every
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
