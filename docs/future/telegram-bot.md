# Telegram bot — working with the task manager from a phone

Status: **planned, tasks filed 2026-08-31** (task group "Telegram bot" in the `17 - task-manager` repo). Analysis written 2026-08-31 (Claude, conversation with user). Supersedes the cloud half of [`autonomy-cloud-shadow.md`](autonomy-cloud-shadow.md): no server and no `claude` in the cloud.

## The decision

User's proposal: an existing EC2 serving a few DB-backed endpoints (add/remove/start/stop), the MacBook (under `caffeinate`) as the real server polling that DB every 20–30 minutes, and a Telegram bot as the mobile surface.

Verdict: **right instinct, wrong middle.** Keep the Mac as the only machine that runs `claude` — it holds the Keychain auth, the repos and the transcripts that feed the usage pill, and moving any of that is the expensive part. But drop the EC2, the DB inbox and the 30-minute poll: the bot can run *inside* the task-manager server process and reach outward.

- **Telegram long polling is outbound.** `getUpdates` is an HTTPS request the Mac makes and Telegram holds open until a message arrives. No inbound port, no public address, no EC2. A task typed on the phone is queued in under a second instead of up to 30 minutes later. Messages sent while the Mac is asleep wait on Telegram's side (24h unfetched retention) and drain on wake.
- **The DB inbox is unnecessary — and worse.** The orchestrator's 10s safety tick already runs `claimNextQueuedTask` as plain SQL, so a cloud-Postgres storage would pick up an externally inserted `queued` row within 10s *today*, no poller needed. But the pg driver is untested, Supabase free tier pauses after ~a week idle (taking the whole storage down, not just the inbox), and every storage call would pay a network round trip. SQLite stays local; Telegram is the inbox.
- **The EC2 earns nothing essential.** Its only possible roles — an inbox durable beyond 24h, or a "the Mac is dead" alert — are optional and cheaper as a Supabase table + cron if ever needed. Leave it alone.

### Tailscale — not now

Tailscale would give the full web UI (the mobile shell + terminal) from anywhere. **Not needed to start**: the bot covers dispatch, steering (follow-up/Proceed), approvals, status and reports; the terminal is the one thing it deliberately does not expose. Revisit only when the bot is in daily use and a real "I need the terminal from the phone" moment happens. When it does, the one code change is in `server/src/net.ts`: Tailscale addresses are `100.64.0.0/10` (CGNAT) and MagicDNS names end in `.ts.net`, neither in the current "private" allowlist (RFC1918 + link-local + `*.local`), so `TM_LAN=1` alone would 403 a phone on the tailnet. Add both behind the same opt-in; the DNS-rebinding guard stays intact.

### The Mac as a server — operational limits (not code)

- `caffeinate -i` prevents *idle* sleep only. Lid-closed on battery still sleeps; clamshell without an external display needs power plus `pmset disablesleep 1`, or the lid open on a charger. Heat and battery wear if a MacBook Air runs 24/7.
- Nothing supervises the front door (`docs/host.md`) — it supervises the API child, but a dead front door or a reboot brings nothing back. A `launchd` agent with `KeepAlive` fixes both.
- **A reboot needs a human.** With FileVault on, auto-login is unavailable: a macOS update reboot leaves the Mac at the FileVault screen — no session, no unlocked Keychain, no `claude` auth. Disable automatic macOS updates; "the bot stopped answering" is the signal, walking to the machine is the fix. (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` removes the Keychain dependency for workers, but the machine still has to boot into a session.)

## Bot design

### Security posture

The bot is a new entry point that the network allowlists do not protect, so:

- **Exactly one allowlisted Telegram user id** (`telegram.allowedUserId`). Anyone can message a bot by name; every update from another id is dropped silently and counted, never answered.
- **Secrets in `server/data/config.json`** (`telegram.botToken`), the file that already holds the storage choice — never in the DB, never in the repo.
- **Never pipe chat text into a PTY.** The terminal WebSocket is the code-execution surface; the bot only calls the existing action paths in-process (the same service functions the routes use — not HTTP, so the `Host`/`Origin`/token allowlists are untouched). Steering an agent goes through follow-up/Proceed, which respawns with the text in the prompt.
- **Every bot action is audited** as a `tm_events` row with `actor: 'telegram'`.
- Long polling with a persisted `offset`; on boot, drain and **discard** updates older than the boot (an action typed six hours ago must not fire on restart) — say so in the "back online" message.

### Commands — the whole app, not a subset

Every action the web UI can take has a bot form. Inline keyboards for anything that is a choice or a confirmation; a reply-to conversation for anything that needs free text.

| area | commands |
|---|---|
| orientation | `/start`, `/help`, `/status` (orchestrator on/off, running n/m, usage windows with `resetsAt`, queue length, review count), `/repos`, `/tasks [status\|repo]`, `/task <id>` |
| tasks | `/new` (repo picker → title → description → **preset** Small/Routine/Complex or explicit model/effort/review/auto-publish → On create: draft/queue/run-now), `/edit <id>` (title, description, category, model, effort, review, auto-publish), `/enqueue`, `/run`, `/cancel`, `/retry`, `/unblock`, `/complete`, `/publish`, `/proceed <id> <text>` (follow-up), `/queue add\|remove <id>` (custom queue) |
| proposals & features | accept/reject buttons on proposal notifications; `/feature` (long message → Feature; analysis + plan-review come back as a report; **approve** button = `POST /features/:id/approve` + start), `/features` |
| orchestrator | `/on` / `/off` (start/stop picking), `/kill <runId>`, `/restart` (via the front door, honouring the restart-check guard) |
| **red button** | `/killall` → `stop-and-kill` + cancel queued + pause running features. Two-step: inline **confirm** button that expires in 60s, then the bot answers with exactly what it killed. Rate-limited to one confirm window at a time. `/off` is the soft version (stop picking, sessions continue). |
| reports | `/report [24h\|7d\|task <id>\|feature <id>\|group <id>]`, `/digest on\|off` (daily) |
| bot | `/mute`, `/unmute`, `/notify` (toggle event classes) |

Long free text without a command = "create a draft task in the default repo" only after an explicit confirm — never silently.

### Notifications — the half that makes a phone workflow real

Subscribe to the existing `broadcast()` event bus and push:

- task → `review` (with the adversarial-review verdict + findings count, and **Mark done / Publish / Proceed** buttons), `needs attention`, `failed`, `published`, `blocked`;
- proposal created (accept/reject buttons); feature analyzed/proposed (report + approve button), feature paused;
- usage window reset (`resetsAt` passed) and threshold crossings; queue drained; server booted / restarted (with the discarded-updates count).

Coalesce bursts (one message per task per 5s), respect Telegram's 4096-char cap by chunking, escape HTML-mode text properly, and let each event class be muted in config.

### Reports — long text as HTML, readable in Telegram

Anything longer than a few lines is not a chat message; it is a **self-contained HTML report** sent with `sendDocument` — the `.html` file opens in Telegram itself (in-app viewer / built-in browser) and in any browser. Inline CSS resolved from the `--tm-*` token values, dark default, zero external assets, mobile viewport. The chat message alongside the file carries the Russian summary lines, so the gist is readable without opening anything.

**Telegraph was considered and rejected (2026-09-01, user decision): Telegraph pages are public URLs, and these reports contain private work detail.** Nothing leaves the machine except the Telegram file upload itself. The upside of dropping it: the markup is no longer constrained to Telegraph's tag subset — full HTML/CSS is available.

Report shape, top to bottom:

1. **Краткое резюме по-русски** — 3–6 lines: what happened in the period, anything needing a decision.
2. **Numbers**: tasks touched by status, **dispatches made** (`tm_dispatches`: count + one line each on what they were about), **reviews made** (adversarial rounds, verdict split, findings count, fix rounds), publishes, failures, usage consumed per window.
3. **Work done** — per task, concise: title, repo, one-paragraph result summary, review verdict.
4. **Next steps** — what is queued/draft/in review, the next feature phases, anything the human must decide (proposals pending, features awaiting approval, needs-attention runs).
5. **Problems** — failed tasks with the error, blocked parents, dispatch failures.

Scopes: period (`24h`/`7d`), one task (its full run history), one feature (phases + roll-up), one group. A daily digest reuses the period report.

## Task group (filed as drafts, run in order)

1. **Bot module** — `server/src/telegram/`: long polling on `fetch` (no new dependency), config schema, single-user gate, in-process command router, `/start /help /status`, boot/shutdown, audit events, `docs/telegram.md` skeleton.
2. **Notifications** — event-bus subscriber, coalescing, chunking, mute config, action buttons.
3. **Full command coverage** — every action in the table, conversational flows, inline keyboards, preset/agent-param selection.
4. **Red button** — `/killall` with confirm window, `/off`, `/restart`, what-was-killed answer, rate limit, audit.
5. **Reports** — HTML generator, `sendDocument` (no Telegraph — public), `/report` scopes, daily digest.
6. **Workbook** — `docs/telegram.md`: BotFather → token → find your user id → config → enable → verify; `setMyCommands`; privacy mode; the Mac-as-server checklist (`caffeinate`/`pmset`, `launchd` KeepAlive, FileVault caveat); troubleshooting; `decisions.md` entry.
