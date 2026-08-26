# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local web app ("task manager") that collects tasks for registered repos and automates them by spawning Claude Code agents (`claude` CLI) in each repo's directory. Every worker run is a hidden but fully interactive PTY terminal, attachable from the browser via xterm.js over WebSocket. Full design: `docs/design.md`; decision log: `docs/decisions.md`.

## Commands

- `npm install` — installs all workspaces (shared, server, web)
- `npm run dev` — server (tsx watch, http://127.0.0.1:5175) + Vite dev server (http://localhost:5173, proxies /api and /ws)
- `npm run build` — builds the SPA (`web/dist`); the server has no build step
- `npm start` — production mode: tsx runs the server, which serves `web/dist` at http://localhost:5175
- `npm run typecheck` — tsc --noEmit over both server and web (CI runs this plus `npm run build`)

No test framework yet. Verify with curl against the REST API and the flows in `docs/design.md` § Verification.

## Architecture (big picture)

npm-workspaces monorepo: `shared/` (TS types imported as source by both sides — REST entities and WS protocol), `server/` (Fastify 5), `web/` (React 19 + Vite SPA).

- **Storage** (`server/src/storage/`): one `Storage` interface, two drivers — SQLite (better-sqlite3, default) and Postgres (`pg`, Supabase-compatible). Driver chosen in `server/data/config.json` (file, not DB — the DB choice can't live in the DB). All tables share the fixed `tm_` prefix and dialect-neutral SQL with `?` placeholders (pg driver rewrites to `$n`; never put `?` inside SQL string literals). Multi-step mutations are first-class composite methods (`claimNextQueuedTask`, `acceptProposal`, `resolveChildCompletion`) implemented transactionally per driver — there is deliberately NO generic `transaction(fn)`: better-sqlite3 transactions are sync-only and an async facade would commit before awaited work runs.
- **PTY sessions** (`server/src/pty/session-manager.ts`): in-memory map of runId → node-pty process + 2MiB ring buffer + attached WS clients. Spawn always uses an args array (never a shell string) with cwd = target repo path.
- **Completion detection** (`server/src/claude/worker.ts`): workers run interactive `claude` with lifecycle hooks injected via `--settings` inline JSON; Stop/SessionEnd/Notification hooks curl back to token-guarded `/api/internal/runs/:id/*` routes. First Stop → task `review` (or `done` if autoComplete). Notification hook → "needs attention" badge (permission prompts in hidden terminals would otherwise deadlock silently).
- **Features** (`docs/features.md`): a per-repo big request that a headless planning run decomposes into ordered phases of tasks, a second headless run reviews adversarially (bounded re-analysis rounds), and the human approves visually before any `tm_tasks` row exists. Execution is the normal orchestrator plus one claim-eligibility gate (`storage/feature-sql.ts`, shared verbatim by both drivers and mirrored by a JS twin — edit them together). Standing caps are injected into every generated task description server-side.
- **Repo commands** (`server/src/commands/`, `docs/commands.md`): saved per-repo command lines (dev servers, scripts) run in a SECOND `SessionManager` pool so a long-lived dev server never touches agent concurrency or the PTY cap. Command text is tokenized and spawned as argv (never a shell; unquoted shell operators are rejected at the API). Runs are in-memory only — `tm_runs` means "agent", and boot recovery treats it that way. Restarting the server is refused while any agent session is working.
- **Publish** (`docs/publish.md`): a task in `review` is shipped by reopening ITS OWN claude session (`claude --resume`) and telling it to `git add`/`commit`/`push` — same terminal, no new agent; a per-task `auto_publish` flag runs that turn automatically at the end of the work, bypassing both the human review gate and the adversarial review round. The landing status is decided by `verifyPublished()` reading git afterwards (clean tree, upstream exists, nothing ahead), never by what the agent reported — anything else drops the task back to `review` with the reason. `published` is terminal: keep `TERMINAL_TASK_STATUSES` (shared), `feature-sql.ts` and its JS twin in lockstep.
- **Dispatch** (`docs/dispatch.md`): agent-to-agent messages between RELATED tasks (one it filed, the one that filed it, own group) — `POST /api/agent/dispatch` queues a message that the orchestrator delivers by resuming the target task's OWN claude session (`followUp` → `claude --resume`), so a backend⇄frontend exchange stays two sessions instead of minting new tasks. `tm_dispatches` is FK-less like `tm_events`; delivery holds while the target is busy, never starts a never-ran draft (enqueue-gate bypass), and runs even with the queue stopped. Caps: 5/run, 8 lifetime per task pair (both directions — the guard that ends ping-pong).
- **Orchestrator** (`server/src/orchestrator.ts`): single-process, event-driven claim loop, max 2 concurrent workers. Boot recovery kills orphaned `claude` pids (after verifying the command line) before failing their tasks.
- **Security**: server binds 127.0.0.1 only; WS upgrades validate Origin and require the per-boot session token. Never weaken these.

## Rules

- Visual changes must resolve to the `--tm-*` tokens defined in `docs/tm-design-tokens.html` (mirrored in `web/src/theme.css`). No hardcoded colors/spacing/fonts outside that token layer (xterm.js needs concrete values — take them from the sheet's terminal tokens).

- Document all work in `docs/` — updating docs is an exit criterion of every phase/change.
- Worker prompts must include the standing caps: max 3 subagents per session; orchestrator concurrency stays at 2.
- Adversarial review of each phase before moving to the next (max 3 agents at a time).
- Agent model is `claude-opus-5`; analysis runs headless (`claude -p`) with write tools disallowed.
