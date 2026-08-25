# Task Manager

A local control panel that turns a task list into running [Claude Code](https://claude.com/claude-code) agents.

You register local repos, write tasks, and an orchestrator spawns `claude` sessions inside those repo directories. Every run is a real interactive terminal you can open in the browser and type into at any time.

The whole thing binds to `127.0.0.1` and stores its data on your machine. There is no hosted component.

## What it does

- **Board and queue** for tasks scoped to a registered repo, with statuses `draft → queued → running → review → done` plus `blocked`, `failed`, `cancelled`.
- **Real terminals.** Each run is a hidden PTY running interactive `claude`. Attach from the browser (xterm.js over WebSocket), answer a permission prompt, or keep chatting after the run.
- **Completion detection** through Claude Code lifecycle hooks (`Stop`, `SessionEnd`, `Notification`) that call back into token guarded internal routes. First turn end moves the task to `review`, or to `done` if auto-complete is on.
- **Analyze.** A read only headless agent inspects a repo and its open tasks, then files proposals: rewrite, split, new task, or solution options. Accepting a split queues children and blocks the parent.
- **Adversarial review** of each worker's output, with findings fed back to the live session for up to a configurable number of fix rounds.
- **Model routing.** Per task override, a keyword rule, and a usage estimate read from your local transcripts decide between a primary and a fallback model.
- **Agent task API.** Workers can file follow up tasks and target other repos through `/api/agent/*`, authenticated with a per run token.
- **Dashboard** with run and cost tiles, anomaly detection, and a live activity feed backed by an in transaction audit log.
- **Sentry import** (optional): pull unresolved issues into tasks, idempotently.

## Requirements

- Node.js 22.12 or newer (`better-sqlite3` 13 needs 22+, `vite` 7 needs 20.19+ or 22.12+)
- The `claude` CLI installed, authenticated, and on your `PATH`
- macOS or Linux. Native modules (`node-pty`, `better-sqlite3`) build or download prebuilds on install.

## Install and run

```bash
npm install        # postinstall restores node-pty's spawn-helper exec bit
npm run build      # builds the SPA into web/dist
npm start          # http://127.0.0.1:5175
```

For development, `npm run dev` runs the server with `tsx watch` on port 5175 and Vite on port 5173, proxying `/api` and `/ws`.

## First run

1. **Repos**: add an absolute or `~`-prefixed path with a role note such as "backend".
2. **Board** → **New task**: title, description, repo. Leave model and effort on auto.
3. **Run now** for an immediate session, or **Enqueue** and flip the header switch to start the queue. The orchestrator claims tasks up to the concurrency limit (2 by default).

The full user guide is [`docs/handbook.md`](docs/handbook.md), also served in-app at `/handbook`.

## Storage

SQLite by default, at `server/data/taskman.db`. Boot settings live in `server/data/config.json`, which is created on first run:

```json
{
  "port": 5175,
  "storage": {
    "driver": "sqlite",
    "sqlite": { "file": "data/taskman.db" },
    "postgres": { "connectionString": "" }
  }
}
```

Switching `driver` to `postgres` and pasting a connection string uses the Postgres driver instead. All tables carry a fixed `tm_` prefix, so a shared database is safe. The Postgres driver is implemented and reviewed but has not been exercised against a live database yet.

`server/data/` is gitignored. It holds the database, config, and per task artifact files.

## Security

This app spawns processes and exposes an interactive terminal, so treat it as a local code execution surface:

- Fastify listens on `127.0.0.1` only.
- `Host` headers are checked against an allowlist, and WebSocket upgrades validate `Origin`.
- The terminal WebSocket and the internal hook routes require a per boot session token. Agent API calls use a per run token.

Do not put it behind a public reverse proxy or bind it to `0.0.0.0`. See [SECURITY.md](SECURITY.md).

## Layout

npm workspaces monorepo:

```
shared/    TS types shared by both sides, imported as source
server/    Fastify 5, storage drivers, PTY manager, orchestrator, routes
web/       React 19 + Vite SPA
docs/      design.md, decisions.md, handbook.md, progress.md
```

## Docs

- [`docs/handbook.md`](docs/handbook.md) how to use it
- [`docs/design.md`](docs/design.md) architecture and locked decisions
- [`docs/decisions.md`](docs/decisions.md) decision log
- [`docs/agent-api-design.md`](docs/agent-api-design.md) the agent facing API
- [`CONTRIBUTING.md`](CONTRIBUTING.md) how to work on it

## License

[MIT](LICENSE)
