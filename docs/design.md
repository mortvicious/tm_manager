# Task Manager — Local Claude Agent Orchestrator

## Context

Greenfield internal tool (started from an empty directory). A local web app to collect tasks for the user's projects (repos registered by local path + role note) and automate their implementation by spawning Claude Code agents (`claude` CLI, opus) inside the target repo directories — each run is a hidden but fully interactive PTY terminal, attachable from the browser. Reference aesthetic: "Foreman"-like open-source tool. Design validated by an adversarial review pass (3 blockers + 7 majors found and folded in below).

Environment verified: Node v24.15, `claude` CLI 2.1.241 (`--settings` inline JSON, `--permission-mode`, `--json-schema`, hooks all confirmed), `claude-opus-5` valid model id.

## Locked decisions

- Node + TypeScript server (Fastify 5), React 19 + Vite SPA, npm-workspaces monorepo
- Storage: SQLite (better-sqlite3) default ↔ PostgreSQL (`pg`, works with a Supabase connection string — free tier confirmed) via `server/data/config.json` driver switch; **fixed** `tm_` table prefix in both dialects (identical SQL strings; payloads TEXT in both)
- Worker sessions: full interactive `claude` in node-pty; completion via lifecycle hooks
- Concurrency: **2 worker sessions max** (user-mandated default); each worker instructed (prompt template) to spawn **max 3 subagents** — no CLI flag exists for this, so it's a standing instruction in every worker prompt
- Sentry: stub only (source enum + `source_ref` + config fields + "create from Sentry ref" manual form; no API pull)
- First `Stop` hook → task goes to **`review`** by default (config toggle `orchestrator.autoComplete` → `done`), because turn-end ≠ task-done (agent may have asked a question)
- No auto-retry (dangerous on half-edited repos) — manual Retry button only. No tsup: prod runs `tsx` directly; only the SPA gets a build.
- Project rules: document all work in `docs/` (per-phase updates are an exit criterion), `CLAUDE.md` at root, `.claude/settings.local.json` with concise output style

## Structure

```
package.json            npm workspaces: shared/, server/, web/
CLAUDE.md               project rules, commands, architecture pointers
.claude/settings.local.json   concise output style
docs/                   design.md, decisions.md, per-phase notes
shared/src/types.ts     entities + REST/WS protocol types (imported as TS source)
server/src/
  index.ts              bootstrap: config → storage → fastify(127.0.0.1) → orchestrator
  config.ts             loads/creates server/data/config.json (storage driver choice lives here, not in DB)
  storage/{types,sqlite,postgres,migrations}.ts
  pty/session-manager.ts
  claude/worker.ts      claude invocation builder (args array, hooks settings JSON)
  claude/analyze.ts     headless -p runner + proposal apply
  claude/feature-plan.ts      feature plan contract: zod + json-schema, prompts, standing-caps injection (pure)
  claude/feature-analysis.ts  feature pipeline: plan run → adversarial plan review → bounded re-analysis
  storage/feature-sql.ts      phase-gating SQL fragment shared verbatim by both drivers (+ its JS twin)
  orchestrator.ts
  routes/…  ws/{terminal,events}.ts
  data/                 taskman.db, config.json (gitignored)
web/src/                pages, components, theme.css, api.ts, ws.ts
```

Deps (minimal): fastify, @fastify/websocket, @fastify/static, better-sqlite3 ^13, pg ^8, node-pty ^1.1, zod (pick ONE major — v4 — used in both shared/ and server/), react 19, react-router-dom 7, @xterm/xterm ^6 + addon-fit, tsx, concurrently.

## Data model (all tables `tm_`-prefixed, both dialects)

- `tm_config(key PK, value TEXT)` — runtime-tunable settings as JSON values
- `tm_repos(id, name, path /*absolute, ~ expanded*/, role /*"backend"/"frontend" note*/, created_at)`
- `tm_tasks(id, title, description, repo_id, parent_id, status, source /*manual|sentry|auto*/, source_ref, priority, result_summary, error, created_at, updated_at)`
  - status: `draft | queued | running | blocked | review | done | failed | cancelled`
  - source: `manual | sentry | auto | feature`
- `tm_runs(id, task_id, repo_id, mode /*worker|analyze*/, status /*running|exited|killed*/, pid, exit_code, started_at, ended_at)`
- `tm_proposals(id, run_id, repo_id, task_id, kind /*rewrite|split|new_task|solution_options*/, payload TEXT/*JSON*/, status /*pending|accepted|rejected*/, created_at)`
- `tm_features(id, repo_id /*nullable: repo deletion detaches*/, title, request TEXT, status /*draft|analyzing|proposed|approved|running|paused|review|done|failed|cancelled*/, analysis TEXT/*JSON plan*/, review TEXT/*JSON review rounds*/, analysis_rounds, error, created_at, updated_at)` — a big request decomposed into ordered phases of tasks (`docs/features.md`); `tm_tasks` carries `feature_id` + `feature_phase` and the `feature` source value
- `tm_migrations`

Scrollback is NOT stored in DB (in-memory ring buffer per session).

## Storage adapter

`config.json`: `{ "storage": { "driver": "sqlite" | "postgres", "sqlite": {"file": "data/taskman.db"}, "postgres": {"connectionString": "postgres://…"} } }` — switching = edit driver + paste conn string. No configurable prefix (hardcoded `tm_`).

Interface: async CRUD methods per entity **plus first-class composite methods instead of a generic `transaction(fn)`** (better-sqlite3's `.transaction()` is sync-only; an async facade would commit before awaited work runs — adversarial-review blocker B1):
- `claimNextQueuedTask()` — `UPDATE … SET status='running' WHERE id=(SELECT id FROM tm_tasks WHERE status='queued' ORDER BY priority DESC, created_at LIMIT 1) RETURNING *`; in better-sqlite3 run via `stmt.get()` (`.run()` discards RETURNING). If PTY spawn then throws → revert task to `queued`.
- `acceptProposal(id, chosenOption?)` — atomic per driver (sync `db.transaction()` / pg `BEGIN..COMMIT` on one client): rewrite→patch task; split→create `queued` children (`source:'auto'`, `parent_id`) + parent→`blocked`; new_task→`draft` task; solution_options→append chosen approach to description.
- `approveFeature(id)` / `resolveFeatureCompletion(featureId)` / `cancelFeature(id)` — the Feature composites: materialise the approved plan as `draft` tasks (standing caps injected server-side), then pump phases (pause on any failure, enqueue the lowest unresolved phase, roll up to `review` when nothing is left). Phase eligibility is one shared SQL fragment spliced into `claimNextQueuedTask` in both drivers, with a JS twin used by the pump — see `storage/feature-sql.ts`.
- `resolveChildCompletion(childId)` — recompute parent: all children done (cancelled counts as resolved) → parent `queued`-again? No: parent → `review`; any failed → parent stays `blocked` with error surfaced. Manual **Unblock** / **Fail parent** actions exist in UI (review finding M5 — no dead-end states).

Both drivers share SQL strings with `?` placeholders; pg driver rewrites to `$n` once per statement (comment the "no `?` in string literals" constraint).

## PTY sessions (`session-manager.ts`)

`Map<runId, Session{pty, ringBuffer(2MiB raw bytes), clients:Set<WS>, cols:120, rows:32, exit?}>`
- Spawn with **args array** (never a shell string — quoting hazard m8): `pty.spawn('claude', args, {cwd: repo.path, env: {...process.env, TERM:'xterm-256color', TM_RUN_ID, TM_TOKEN, TM_CALLBACK_URL}})`
- onData → ring buffer + fanout; onExit → finalize run, notify orchestrator, broadcast exit; exited sessions kept 30 min, cap 10 live PTYs (LRU-kill exited)
- Attach: send `{type:'history', data: base64}` first, then live frames. Client decodes base64 → `Uint8Array` → `xterm.write()` in 64KiB chunks (string decode corrupts UTF-8 — m2); fit/resize AFTER history replay (SIGWINCH redraw self-heals seam artifacts)
- Input/resize/kill (SIGHUP → SIGKILL after 5s)

**Security (blocker B3):** Fastify listens on `127.0.0.1` only; WS upgrade validates `Origin` against the app's own origin; `/ws/terminal/:runId` requires the per-boot session token (query param). Internal routes token-guarded, localhost-only.

## Worker invocation + completion detection

Interactive session (hard requirement: real usable terminal), completion via hooks injected with `--settings '<json>'`:

- `Stop` hook + `SessionEnd` hook + **`Notification` hook** (blocker B2: fires on permission prompts/idle → task gets `needs attention — attach` badge instead of silently deadlocking) — each: `curl -s --max-time 5 -X POST -H "x-tm-token: $TM_TOKEN" "$TM_CALLBACK_URL/…" || true` (`|| true` so a flaky curl can't block stopping; callback URL injected via env, never hardcoded port)
- Args: `--model claude-opus-5 --permission-mode acceptEdits --settings <hooksJson> <prompt>`; prompt = title + description + standing instructions (max 3 subagents; summarize when finished)
- Config `agent.permissionMode`: `acceptEdits` (default) | `bypassPermissions` (`--dangerously-skip-permissions`, red warning; NOTE: shows a one-time interactive acceptance dialog — attach to accept, documented) + optional `agent.allowedTools` list (e.g. `Bash(git *)`, `Bash(npm *)`) as middle ground
- Status machine: first `Stop` after spawn → `review` (or `done` if autoComplete); later Stops no-op; exit-before-Stop nonzero → `failed`; kill → `cancelled`. Run terminal at SessionEnd/exit.
- Known first-run friction: per-repo workspace-trust dialog appears in the hidden terminal → visible via Notification hook/attach; happens once per repo.

## Orchestrator

Singleton; `orchestrator.enabled` persisted in `tm_config`. Event-driven `maybeSchedule()` (on start/enqueue/exit/stop-hook + 10s safety tick): claim tasks while activeWorkers < 2. Boot recovery (M4): for each `running` run row, verify pid's command line is `claude`, kill it, then mark task `failed('server restarted')` — never leave orphaned agents editing repos. Start/Stop = stop picking new tasks (live sessions continue); separate "Stop & kill all". Untouched by Features except for claim eligibility: a task with `feature_id` is claimable only while its feature is `running` and every task in a lower phase is resolved. `resolveCompletion(task)` (formerly `resolveParent`) re-evaluates both the split parent and the feature phase gate whenever a task reaches a terminal status.

## Analyze

Headless, per repo/task selection: `execFile('claude', ['-p','--model','claude-opus-5','--permission-mode','dontAsk','--disallowedTools','Edit','Write','Bash','--output-format','json','--json-schema',schema], {cwd: repo.path, maxBuffer: 64*1024*1024, timeout: 10*60_000})`, prompt via stdin (repo role/path + open tasks JSON + instructions). NOT plan mode (fights json-schema output — M2); read-only enforced via disallowed tools. **Phase 6 step 1 = a cheap spike to capture the exact `-p` JSON result envelope** (`{type:"result", result, is_error,…}`) — parse the envelope, not raw stdout. Proposals validated with zod → `tm_proposals` rows → UI accept/reject (accept paths in Storage composites above). Trust dialog is skipped in `-p` mode (verified), so Analyze never stalls.

**Feature analysis** reuses the same envelope, `dontAsk` + disallowed write tools, and zod validation, but runs the loop shape of the diff review instead: a plan run decomposes the request into phases, a SECOND independent run reviews that plan adversarially, and a `blocker` verdict folds the findings into a re-analysis, bounded by `feature.analysisMaxRounds` (default 2). One run row spans the whole pipeline; each child registers with `trackHeadlessChild` so Kill always reaches the live process. Full design + as-built notes: `docs/features.md`.

## API

REST `/api`: repos CRUD; tasks CRUD + `/enqueue|run-now|cancel|retry|unblock`; runs list + `/kill`; `/analyze {repoId, taskIds?}`; proposals list + `/accept|reject`; features CRUD + `/analyze|plan|approve|start|pause|resume|cancel|complete`; config get/put; orchestrator get + `/start|stop|stop-and-kill`; `/usage` (session + weekly + weekly-fable windows, each `{pct,source,resetsAt,tokens,budget}` — real account figures from the CLI's `~/.claude.json` cache, local-transcript estimate as fallback); internal `/internal/runs/:id/{stop,session-end,needs-attention}`; `/health`.
WS: `/ws/terminal/:runId?token=…` (history/data/exit ↔ input/resize, base64-in-JSON) and `/ws/events` (task.updated, run.started/exited, run.needs-attention, proposal.created, feature.updated/deleted, orchestrator.status) — frontend fully event-driven, no polling.

## Frontend

Sidebar (Board, Queue, Features, Repos, Config) + header (prominent Start/Stop switch, `running N/2`, usage pill `5h % · wk % · fable % · routed model`, server uptime/restart, theme toggle). Board: status columns, cards with per-row quick actions (terminal glyph before the title → attaches to the task's live/most-recent run; run-now + mark-as-ready after the status badge — the check means **mark done** (`complete`) on a task in review, `enqueue` elsewhere — disabled with a reason when the server would reject them, including the client mirror of `hasLiveSession()` — `components/TaskRow.tsx`, shared with Queue's queued list), source chip/repo tag/parent indent/needs-attention badge → TaskSlideOver (edit, proposals accept/reject, Enqueue/Run now/Open terminal/Analyze/Unblock). Queue: active runs (elapsed, Open terminal, Kill) + queued list. Features: list + intake form per repo, then a Feature page — request, analysis summary/considerations, adversarial plan-review verdict, and the plan as horizontal **phase columns of editable task cards** (edit/exclude/reorder/move/add pre-approval, Save plan → Approve). After approval the same columns become the execution dashboard: cards are the real tasks, live over `/ws/events`, current phase highlighted. Repos: path+role table, add form with server-side path validation, per-repo Analyze. Config: Storage / Agent (permission mode with warning, allowedTools) / Orchestrator / Sentry-stub groups. TerminalDrawer: xterm + fit, **StrictMode-safe effect cleanup (close WS + `terminal.dispose()`)**. Theme: CSS variables `:root` (light) + `[data-theme="dark"]`, localStorage + `prefers-color-scheme` default; 13–14px system font, ui-monospace for paths, 1px borders, subtle radii.

## Commands

- `npm run dev` — concurrently: `tsx watch server` (127.0.0.1:5175) + `vite` (5173, proxy `/api` + `/ws` with `ws:true`)
- `npm run build` — `vite build` (SPA only)
- `npm start` — `tsx server/src/index.ts` serving `web/dist` at `http://localhost:5175`

## Phases (docs/ update = exit criterion of every phase)

1. **Skeleton**: workspaces, CLAUDE.md, `.claude/settings.local.json` (concise), docs/ skeleton, shared types, config loader, SQLite driver + migrations, repos/tasks REST. Test: curl.
2. **UI shell**: sidebar/header/theme, Repos + Board(list) + task CRUD — usable plain tracker.
3. **PTY + terminal**: session manager, WS terminal (Origin+token), TerminalDrawer — test with `zsh` first, then manual `claude` via Run now. (Riskiest subsystem, de-risked early; verify keychain auth from PTY here.)
4. **Completion detection**: hooks settings injection, internal routes incl. needs-attention, status machine, `/ws/events`. Test Stop-on-interrupt behavior and bypass-permissions first-use dialog here.
5. **Orchestrator**: start/stop, claim loop (concurrency 2), parent/child blocking + unblock actions, boot recovery with orphan-pid kill, Queue page.
6. **Analyze + proposals**: envelope spike → runner → proposals UI → accept transactions.
7. **Postgres driver** (test against Supabase conn string) 
8. **Polish**: board columns, slide-over, Config groups, Sentry stub form, empty states.

## Execution workflow (user-mandated)

Max 3 agents per step: main session orchestrates and implements; after each phase, one adversarial-review agent checks the diff against this plan before moving on.

## Verification

- Phase-by-phase: curl the REST API; spawn a `zsh` PTY and type into it from the browser; run a real task against a scratch repo (e.g. "add a comment to README") and watch Stop→review transition; click Analyze on a repo with 2–3 seeded tasks and accept a split; flip config.json to a Supabase connection string and re-run migrations.
- End-to-end: register `~/Development/3 - neko-nest` + `4 - neko-vite-new`, create a small real task, Start the queue, observe the hidden terminal, attach mid-run, confirm review status + result summary.
