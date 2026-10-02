# Terminals — plain shells per repo

User request (2026-10-02): "PTY needed for each repo — not current Claude active
sessions, pure terminal. Add terminal tab with repo selection with number of PTYs
that user can create."

The **Terminal** page (`/terminals`, nav item *Terminal*) opens the user's own
login shell in a repo's directory, as many as needed, each a real PTY attachable
like every other session. No claude, no task, no saved command: this is the
terminal you would otherwise open in another app and `cd` into the repo.

## Model

- `ShellSession` (`shared/src/types.ts`): `id` (`sh-<uuid>`, also the PTY id),
  `repoId`, `repoName` (snapshot), `title` (`zsh 2`), `index`, `cwd`, `shell`,
  `status` (`running|exited|killed`), `pid`, `exitCode`, `startedAt`, `endedAt`.
- **In memory only**, like command runs: a PTY dies with the server, so a
  persisted "running" shell could only ever be a lie after a restart, and
  `tm_runs` keeps meaning "a claude session".
- An entry **outlives its shell's exit**: `exit` in the shell leaves the tab with
  its scrollback and an `exited` label until the user closes it.
- `index` is the lowest number free among that repo's open shells, so closing
  `zsh 2` and opening another gives `zsh 2` again.
- Cap: `MAX_SHELL_SESSIONS` = 10 open entries across all repos, live or exited.
  It equals the pool's own `MAX_LIVE_SESSIONS`, so the pool's cap error never
  reaches the user. A request for more than fits is refused whole (409), never
  half done. One click opens 1–4 (the page's count picker).

## Execution (`server/src/shells/runner.ts`)

- A **fourth** `SessionManager` pool (after agents, repo commands and aux), for
  the reason commands have their own: a shell is open for hours and must never
  touch agent concurrency or the agents' spawn cap.
- The binary is `resolveLoginShell()`: `$SHELL` if it is an absolute executable,
  else the passwd entry's shell, else `/bin/zsh` (macOS) / `/bin/bash`, else
  `/bin/sh`. Spawned as argv `[shell, '-l']` with `cwd = repo.path` — a login
  shell, because a server started by launchd inherits a bare `PATH` and the
  profile is where the real one comes from. Nothing user-typed is ever part of
  the argv.
- Env: the server's own env (minus the `CLAUDE_CODE_*` markers every pool strips)
  plus `TERM=xterm-256color` and `TERM_PROGRAM=task-manager`.
- Close = `SessionManager.kill` (SIGHUP, SIGKILL after 5s) + `dispose` (scrollback
  dropped, attached sockets closed) + `shell.closed` broadcast. The exit that
  lands afterwards finds no entry and is ignored.
- An exited shell nobody is watching has its PTY buffer dropped by the pool's
  normal TTL GC (`pty.sessionTtlMinutes`); the entry stays, and attaching shows
  "terminal no longer available" (WS close 4404). A live shell is never idle, so
  the TTL never touches it.

## Lifecycle against the rest of the server

- **Restart / shutdown**: `shellRunner.stopAll()` beside `commandRunner.stopAll()`
  on SIGINT/SIGTERM and on the restart route. Shells never block a restart (they
  are not agents); `GET /api/server/restart-check` reports `shells` like
  `services`, the header's restart confirm names them, and Telegram `/restart`
  lists "shell terminals that will be closed".
- **`/killall`** does not touch them, like repo commands: it is the emergency
  stop for agents spending tokens.
- **Audit**: one `shell.session` event per open request (`action: 'opened'`,
  count, shell, cwd, ids) and per close (`action: 'closed'`, `wasRunning`).
  A shell exiting by itself is a broadcast only, not an audit row.

## API

| Route | |
|---|---|
| `GET /api/shells` | every open entry, oldest first |
| `POST /api/shells` `{repoId, count?: 1..10}` | opens `count` shells → `ShellSession[]`; 404 unknown repo, 400 missing directory, 409 over the cap |
| `DELETE /api/shells/:id` | kills (if live) and forgets; 404 unknown |

POST and DELETE **require `Origin`** (403 without): they act as `human` in the
audit, and a worker's curl carries no Origin (the questions/spaces rule). Attach
is the ordinary `/ws/terminal/:id?token=` with its Origin + session-token check.
Events on `/ws/events`: `shell.session {session}` (open/exit) and
`shell.closed {id}`.

## UI (`web/src/pages/Terminals.tsx`, `components/ShellPane.tsx`)

- Bar: repo picker (remembered in `tm.terminals.repo`; each option shows how many
  shells it has open), count picker (1 up to what still fits, max 4), **New
  terminal / Open N terminals**, `n/10 open`, and a **tabs | grid** layout toggle
  (desktop, `tm.terminals.layout`).
- Tabs: one per shell of the selected repo — live dot, title, `exited`/`killed`
  label, × close (confirms when the shell is still running).
- Desktop panes are `ShellPane`: the drawer's WS protocol without its chrome. In
  tab mode every pane stays mounted (hidden, socket open), so switching is instant
  and never replays scrollback; a hidden pane measures 0 wide and skips refits
  (fitting it would resize the PTY to 2×1). Each pane has *open in drawer*.
- **Phones** get no embedded pane: tapping a tab (or opening a single shell)
  opens the full-screen terminal drawer, which has the key row (Esc/Tab/Ctrl/
  arrows) and the compose bar a soft keyboard lacks (`docs/mobile.md` § The
  terminal). The page is under *More*.
- The drawer names a shell `zsh 2 — <repo>` and shows its cwd as the activity line.
- Shells whose repo was deleted while open are listed under *repo removed* and
  open in the drawer.

One PTY has one size: a shell shown in a pane and in the drawer at once takes the
size of whichever resized last, as any multi-viewer session does.

## Security

A shell is remote code execution by design, exactly like repo commands and the
agent terminals: same Host/Origin allowlist, same per-boot WS token, same
loopback-only bind. Over the tailnet (`docs/remote-access.md`) it is reachable to
an allowlisted login like every other surface; it adds no new path.

## Verification (2026-10-02)

- `npm run typecheck`; `vite build` to a scratch outDir (the live front door
  serves `web/dist`).
- A harness driving `ShellRunner` + `registerShellRoutes` (Fastify `inject`) on a
  real pool: 403 without Origin, 404/400 for unknown repo / missing dir, open 3 →
  `zsh 1..3` running; typing `echo HELLO_$((40+2)); pwd` through `attach`/`input`
  returned `HELLO_42` and the repo path; 8 more → 409 "only 7 more"; close →
  `shell.closed`, second close 404, reopen reuses `zsh 2`; `exit 3` → `exited`
  code 3; `stopAll` → `killed`; audit `opened,closed,opened`.
- **Not exercised**: the page in a browser (no browser in this session) and the
  live server (not restarted).
