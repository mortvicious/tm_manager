# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local web app ("task manager") that collects tasks for registered repos and automates them by spawning Claude Code agents (`claude` CLI) in each repo's directory. Every worker run is a hidden but fully interactive PTY terminal, attachable from the browser via xterm.js over WebSocket. Full design: `docs/design.md`; decision log: `docs/decisions.md`.

## Commands

- `npm install` — installs all workspaces (shared, server, web)
- `npm run dev` — server (tsx watch, http://127.0.0.1:5175) + Vite dev server (http://localhost:5173, proxies /api and /ws)
- `npm run build` — builds the SPA (`web/dist`); the server has no build step
- `npm start` — production mode: tsx runs the server, which serves `web/dist` at http://localhost:5175

No test framework yet. Verify with curl against the REST API and the flows in `docs/design.md` § Verification.

## Architecture (big picture)

npm-workspaces monorepo: `shared/` (TS types imported as source by both sides — REST entities and WS protocol), `server/` (Fastify 5), `web/` (React 19 + Vite SPA).

- **Storage** (`server/src/storage/`): one `Storage` interface, two drivers — SQLite (better-sqlite3, default) and Postgres (`pg`, Supabase-compatible). Driver chosen in `server/data/config.json` (file, not DB — the DB choice can't live in the DB). All tables share the fixed `tm_` prefix and dialect-neutral SQL with `?` placeholders (pg driver rewrites to `$n`; never put `?` inside SQL string literals). Multi-step mutations are first-class composite methods (`claimNextQueuedTask`, `acceptProposal`, `resolveChildCompletion`) implemented transactionally per driver — there is deliberately NO generic `transaction(fn)`: better-sqlite3 transactions are sync-only and an async facade would commit before awaited work runs.
- **PTY sessions** (`server/src/pty/session-manager.ts`): in-memory map of runId → node-pty process + 2MiB ring buffer + attached WS clients. Spawn always uses an args array (never a shell string) with cwd = target repo path.
- **Completion detection** (`server/src/claude/worker.ts`): workers run interactive `claude` with lifecycle hooks injected via `--settings` inline JSON; Stop/SessionEnd/Notification hooks curl back to token-guarded `/api/internal/runs/:id/*` routes. First Stop → task `review` (or `done` if autoComplete). Notification hook → "needs attention" badge (permission prompts in hidden terminals would otherwise deadlock silently).
- **Orchestrator** (`server/src/orchestrator.ts`): single-process, event-driven claim loop, max 2 concurrent workers. Boot recovery kills orphaned `claude` pids (after verifying the command line) before failing their tasks.
- **Security**: server binds 127.0.0.1 only; WS upgrades validate Origin and require the per-boot session token. Never weaken these.

## Rules

- Visual changes must resolve to the `--tm-*` tokens defined in `docs/tm-design-tokens.html` (mirrored in `web/src/theme.css`). No hardcoded colors/spacing/fonts outside that token layer (xterm.js needs concrete values — take them from the sheet's terminal tokens).

- Document all work in `docs/` — updating docs is an exit criterion of every phase/change.
- Worker prompts must include the standing caps: max 3 subagents per session; orchestrator concurrency stays at 2.
- Adversarial review of each phase before moving to the next (max 3 agents at a time).
- Agent model is `claude-opus-5`; analysis runs headless (`claude -p`) with write tools disallowed.
