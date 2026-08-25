# Task Manager — Handbook

A local control panel that turns your task list into running Claude Code agents. You register repos, write tasks, and the orchestrator spawns `claude` sessions inside those repos — each one a real terminal you can open and type into at any moment.

## Quick start

```bash
npm install        # one time (postinstall fixes node-pty's exec bit)
npm start          # → http://localhost:5175
```

1. **Repos** → add a local path (`~/Development/my-app`) with a role note ("backend", "frontend").
2. **Board** → **+ New task** — title, description, repo. Model/effort overrides are optional; leave them on *auto (router)*.
3. Either **Run now** (immediate) from the task panel, or **Enqueue** and flip the header switch to **Queue running** — the orchestrator picks tasks up automatically, max 2 at a time.

## Where your data lives (persistence)

| Data | Where | Survives restart? |
|---|---|---|
| Tasks, repos, runs, proposals, settings | `server/data/taskman.db` (SQLite, WAL) | ✅ |
| Boot config (port, storage driver) | `server/data/config.json` | ✅ |
| Agent conversation transcripts | `~/.claude/projects/…/*.jsonl` (written by claude itself) | ✅ |
| Terminal scrollback (the visual buffer) | in-memory ring buffer (2 MiB/session) | ❌ by design |
| Live PTY sessions | in-memory | ❌ — boot recovery kills orphans and fails their tasks |

Switching to hosted Postgres (Supabase works — paste its **session** connection string): edit `server/data/config.json`, set `"driver": "postgres"` and the connection string, restart. Tables are created with the `tm_` prefix. *The Postgres driver compiles and is reviewed but hasn't been exercised against a live database yet — try it on a scratch project first.*

## The task lifecycle

```
draft → queued → running → review → done
                    ↓          ↑ (Retry/Enqueue)
                 failed / cancelled
        blocked (split parent, auto-resolves)
```

- **review** — the agent finished its turn (Stop hook fired). Read the result summary, open the terminal to talk to the agent if needed, then **Mark done** (which also closes its terminal) or re-enqueue.
- **done via autoComplete** — flip *Auto-complete tasks* in Config if you want first-turn-end to mean done. Default is review, because an agent's turn can end with a question.
- **blocked** — a parent whose split-children are still working. Resolves to review automatically when every child is done/cancelled; any failed child keeps it blocked with the error shown. **Unblock** is the manual escape.
- **needs attention** (violet badge) — the hidden terminal is waiting on a prompt (permission, trust dialog). Open the terminal and answer it.

## Sessions and terminals

Every run is a real interactive `claude` session in a hidden PTY, spawned in the repo's directory. Open it from the task panel or Queue — history replays, and your keyboard input goes straight to the agent.

After a task completes, its session goes **idle**: still attachable (Queue → *Idle terminals*) so you can review or keep chatting, but it no longer occupies a worker slot. Idle terminals close when you **Mark done**, press **Stop agent** / **Close**, or automatically after 30 minutes unwatched. They never pile up: the session cap evicts the oldest unwatched ones under pressure.

**Stop agent** (task panel) closes the session without touching task status. **Cancel** (running tasks) kills the session *and* cancels the task.

## Model routing

Per task: **override wins** (set at creation or in the task panel). Otherwise:

1. Tasks mentioning browser/e2e/screenshot/UI-testing keywords → **fallback model** (`claude-opus-5`).
2. Session (5h) usage < threshold (85%) → **primary** (`claude-fable-5`); above it → fallback.

The header pill mirrors the CLI's own `/usage` panel: `5h` (current session), `wk` (weekly, all models) and `fable` (the weekly cap scoped to fable-family models), plus where the next task would route. Those percentages are the REAL account figures — the claude CLI caches its last `/usage` fetch in `~/.claude.json` and the server reads it. Nothing local can refresh that cache (there is no `claude usage` subcommand, and `claude -p` runs do not update it), so hover the pill for its age; it refreshes when a Claude Code TUI fetches usage, e.g. when you open `/usage`. A window whose reset time has passed falls back to a local-transcript estimate, shown dimmed with a `~` and measured against the token budgets in Config. Only the session figure drives model routing. A segment turns amber past the usage threshold. Cost chips on runs are estimates from the same transcripts.

`--effort` (low → max) follows the same pattern: config default, per-task override.

## Analyze

**Analyze** (per repo, or per task from its panel) launches a read-only headless agent that inspects the repo and your open tasks, then files proposals:

- **rewrite** — clearer title/description
- **split** — 2–5 concrete subtasks (accepting queues them and blocks the parent)
- **new_task** — something missing but clearly needed
- **solution_options** — alternative approaches with tradeoffs; accepting one appends it to the description

Proposals appear in the task panel with Accept/Reject. One analysis per repo at a time; kill it from the Queue if it's burning too long.

## Features — when one task is too small

A **Feature** is the home for a request that is far too big for one task: a paragraph-to-page description of a whole capability. Write it on the **Features** page (title + markdown request, one repo), then:

1. **Analyze** — a read-only headless agent reads the repo and decomposes the request into *ordered phases* of worker-grade tasks. A second, independent agent then reviews that plan adversarially (missing steps? wrong ordering? tasks too big or too vague? contradicts `CLAUDE.md`?). A **blocker** verdict feeds the findings back into a fresh analysis, up to *Feature plan re-analysis rounds* in Config.
2. **Review the plan** — the feature page shows the request, the analysis summary and considerations, the review verdict with its findings, and the plan as **phase columns of task cards**. Every card is yours to edit before approval: retitle, rewrite, set category/effort/review, exclude it, reorder it, move it to another phase, or add one. Nothing exists as a real task yet — hit **Save plan** to keep your edits.
3. **Approve** — the included cards become real tasks (source `feature`, tagged `feat pN` on the Board). They land as **drafts**: approving does not start anything.
4. **Start** — phase 1 is enqueued and the normal orchestrator takes over; each task runs exactly like any other (worker PTY, hooks, adversarial diff review, your review → done). When every task in a phase is resolved, the next phase enqueues itself.
5. If a task **fails**, the feature **pauses** — it never barrels into the next phase on a half-done one. Retry or cancel the failed task, then **Resume**. When every phase is resolved the feature moves to **review** for a final look, and you mark it done.

**Pause** stops new tasks being handed out (running ones finish). **Cancel feature** cancels its draft/queued tasks and kills its running ones. Design and as-built notes: `docs/features.md`.

## Categories, filtering & grouping

Every task can carry a free-text **category** ("UI", "Estimator", "Auth"…). You set one in the create form or the task panel; **agents assign them too** — the Analyze run labels each task by domain, and workers can categorize tasks they file. The Board header filters by repo, source (human / agent / sentry / analyze / feature), and category, and groups by status, category, or repo.

## Reviewing & fixing

When a worker finishes, its change is adversarially reviewed (Fable, or Opus 5 xhigh fallback) — findings show in the task panel. If it finds blocker/major issues and the worker session is still alive, they are fed back to the worker to fix and re-reviewed automatically (up to *Review→fix rounds* in Config). For **older tasks** that finished before this, or were reviewed but not fixed, the task panel has **Apply review fixes**: it sends the review findings back to a fresh worker (or reviews-then-fixes if the task was never reviewed). Per-task you can force review on, or skip it for trivial tasks, via the **Adversarial review** selector.

## Follow-ups & files

The task panel has a **Follow-up** field: send an instruction to steer a live agent (it goes straight into the session) or to re-run a finished task with the previous summary as context. When a task asks an agent to produce a file (a report, gathered notes, a dataset), the agent saves it to its `TM_ARTIFACTS_DIR` and it appears in the panel's **Files** section for download.

## Config reference

| Setting | Meaning |
|---|---|
| Concurrency | simultaneous worker sessions (2 recommended) |
| Auto-complete | first agent turn-end → done instead of review |
| Model / Effort | defaults for workers and analysis |
| Permission mode | `auto` (everyday) / `acceptEdits` (cautious) / `bypassPermissions` (⚠ no prompts at all; first use shows a one-time dialog — attach and accept) |
| Allowed tools | extra pre-approved tools, e.g. `Bash(git *)` |
| Router | primary/fallback models, usage threshold, 5h / weekly / weekly-fable estimate budgets (fallback only) |
| Feature plan re-analysis rounds | a blocker verdict on a feature's plan feeds the findings into a fresh analysis, up to N rounds (0 = review the plan once, never re-plan) |
| Sentry | org/project/token + target repo; **Sync issues now** pulls unresolved issues (14d) as tasks — idempotent, never duplicates. Token needs `event:read` + `project:read` scopes (a sourcemap-upload token 403s). EU orgs: API base `https://de.sentry.io` |

## Troubleshooting

- **Task failed with "server restarted"** — the server went down mid-run; boot recovery killed the orphaned agent. Hit **Retry**.
- **Task stuck running, no output growth** — open its terminal; it's probably a permission or trust prompt (should also show *needs attention*). Answer it inline. The workspace-trust dialog appears once per repo.
- **`posix_spawnp failed` on task start** — node-pty's `spawn-helper` lost its exec bit; run `npm rebuild` or `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper` (postinstall normally handles this).
- **UI not updating live** — it reconnects automatically (including across server restarts); if a tab predates the current build, reload it once.
- **CLAUDE.md over 40k warning in a worker** — that repo's CLAUDE.md is too big; split details into `docs/` files it references (this was done for neko-nest → `docs/claude-facts.md`).
- **Everything else** — `docs/design.md` (architecture), `docs/decisions.md` (why things are the way they are), `docs/progress.md` (build/review history).
