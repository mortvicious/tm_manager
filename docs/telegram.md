# Telegram bot — the task manager from a phone

Status: **tasks 1–3 of 6 landed** (bot module + notifications + full command coverage). The full design and the report shape live in [`future/telegram-bot.md`](future/telegram-bot.md); the setup workbook (BotFather → token → your user id → enable → verify, plus the Mac-as-a-server checklist) is task 6 and is not written yet.

Shipped so far: long polling, the config block, the single-user gate, the boot/shutdown lifecycle, the audit trail, push notifications off the `broadcast()` event bus with inline action buttons, and — since task 3 — **the whole day-to-day loop**: creating and editing tasks with agent presets or explicit model/effort/review/auto-publish, the full task lifecycle (`/enqueue` `/run` `/cancel` `/retry` `/unblock` `/complete` `/publish` `/proceed`), the custom queue, proposals, feature intake and approval, the orchestrator switch and `/kill` — driven by inline keyboards and reply-to conversations. The red button (`/killall` `/restart`) and reports are tasks 4–5.

That is **not** the whole web UI, and the difference is deliberate — see § What the bot does not do.

## Why

The Mac is the only machine that can run `claude` — it holds the Keychain auth, the repos and the transcripts. Everything else about a phone workflow is a reachability problem, and Telegram's `getUpdates` solves it the cheap way: it is an HTTPS request **this** machine makes outward, which Telegram holds open until something arrives. No inbound port, no public address, no certificate, no EC2. A message typed on the phone is queued in under a second; messages sent while the Mac is asleep wait on Telegram's side (24h) and drain on wake.

The cost is that the bot is an entry point none of the existing defences cover. `server/src/net.ts` guards the HTTP surface by `Host` and `Origin`; a Telegram update arrives over a socket this process opened, so none of that applies. The single-user gate below is the whole of the authorization model, which is why it is the first thing in the module.

## Architecture

`server/src/telegram/`, inside the API process. It registers no route and binds no port.

| file | what it owns |
|---|---|
| `types.ts` | the slice of the Bot API this server reads — deliberately partial |
| `api.ts` | transport: `TelegramApi` on global `fetch`, `escapeHtml`, `chunkMessage`, inline keyboards, `answerCallbackQuery`, `TelegramApiError` |
| `bot.ts` | the loop, the gate (messages AND button presses), backoff, the offset, the audit trail |
| `commands.ts` | the router: one table of `{ command, description, handler }` |
| `status.ts` | `/status` — collects from the service layer, renders the HTML |
| `actions.ts` | the shared action layer: one function per action + the button codec — buttons and commands, never two implementations |
| `flows.ts` | the conversational half: the single flow store, its steps, its wizard keyboards and the terminal writes |
| `ids.ts` | short-id resolution (prefix match, ambiguity refused) |
| `notifications.ts` | the push half: `broadcast()` subscriber, coalescing, transition memory, the usage watcher |

One file outside the module belongs to it: **`server/src/task-actions.ts`**. The task lifecycle moves (create, edit, enqueue/retry, queue add/remove, unblock, complete, cancel) used to live inline in `routes/tasks.ts` with `actor: 'human'` welded in. They now live there, parameterised by actor, and BOTH call them — the route passing `'human'`, `telegram/actions.ts` passing `'telegram'`. The return shape is the orchestrator's `ActionResult` (`{ task }` or `{ error, code }`), so a route can `reply.code(r.code)` and the bot can turn the same value into a chat line without either inventing its own errors.

Constructed in `server/src/index.ts` after the routes are registered, started after `listen()`, stopped (awaited) in `stop()` and on the restart path.

### In-process, never HTTP

A handler calls the same functions the REST routes call — `Orchestrator.status()`, `usageSnapshot()`, `storage.listTasks()` — never `fetch` against this server's own API. Two reasons: a self-call would have to satisfy the `Host`/`Origin` allowlists and the session token, and two paths to one number is how the phone and the browser start disagreeing. Where a route had the assembly inline, it moved into a service function and the route now calls it too — `GET /api/usage` is the first of these (the body moved to `usageSnapshot()` in `server/src/claude/usage.ts`).

The bot never touches a PTY. The terminal WebSocket is the code-execution surface and the bot deliberately does not expose it.

### The loop

1. `getMe` — the one call that tells a wrong token apart from a network outage. Retried with backoff; a 401/404 stops the bot with a log line naming the config key, because a wrong token never becomes right.
2. `setMyCommands` from the router table, best-effort.
3. The offset is read from `tm_config` (`telegram.updateOffset`).
4. **Boot drain**: everything Telegram queued while the server was down, fetched with `timeout: 0` so the count is known *before* the "back online" message that reports it.
5. **Poll**: `getUpdates` with `timeout = telegram.pollTimeoutSec`, `allowed_updates: ['message', 'callback_query']`.

The offset is advanced and persisted **before** a batch is handled. An update that crashes a handler is therefore lost rather than redelivered — for an action bot, running half of something twice is the worse failure.

### Boot discard

An action typed six hours ago must not fire because the server came back. Every update whose message `date` predates **this process** is dropped and counted, and the count is what the "back online" message reports. The cutoff is process start (`Date.now() - process.uptime()*1000`), not bot start, so a message typed while the server was still booting survives. An update carrying no usable timestamp is treated as stale — conservative on purpose.

A **button press** (`callback_query`) carries no timestamp of its own, and the message it hangs off can be days old — a button on an old notification. The rule splits by where it arrives: in the **boot drain** a callback is stale (a press from before the restart must not fire an action now), while in the **live poll loop** it is fresh by construction — it was pressed just now, whatever the age of the message under it.

The same rule lives in the poll loop, not only in the drain. When the drain gives up (three consecutive errors, or its 50-pass cap), it **breaks rather than returns**: the offset write, the discard accounting, the "back online" message and the dispatch of whatever it did fetch all still happen. Returning early there would have confirmed already-fetched updates to Telegram and then dropped them, which is the one way to lose a message outright. Anything the drain never reached arrives through the poll loop and is counted separately — `/status` shows it as `(+N stale since)`, because the boot message has already gone out with the first number.

### One broken update must not cost the next one

Every path inside `dispatch()` guards itself — `cmd.handler`, `handleFlowText`, `handleFlowButton`, `runButtonAction` are each wrapped — but "every path guards itself" is a claim that has to stay true as paths are added, and it stopped being true once: the `task.proceed` button branch shipped calling `storage.getTask()` and `resumableSessionId()` bare. Neither `pollLoop` nor `bootDrain` wrapped `dispatch`, so a `SQLITE_BUSY` while the owner tapped 💬 Proceed propagated out to `start()`'s `.catch`, which only logs. `running` stayed true, nothing restarted the loop, and **the bot went silent until the next server restart, with no message to the phone**.

The guard now also lives at the loop (`safeDispatch`), where it covers the paths that do not exist yet: a throw is logged, audited as `{ command: null, ok: false, error }`, and answered with a message rather than swallowed. The offset has already been advanced and persisted by then, so the update is not retried — losing one update is the cost, and it is the cheap one. The branch that caused it is wrapped too, so its answer names the actual failure instead of the generic one.

### Backoff and shutdown

Network errors back off exponentially, 1s → 60s with ±20% jitter, and a 429 honours `retry_after` up to 5 minutes. A 409 adds a hint — it means a second process is polling the same token, or a webhook is still set. Logged on the first failure and then every tenth, so an overnight outage is a handful of lines.

**Only Telegram can declare a fatal error.** Stopping the bot until the next server restart is reserved for a 401/404 that arrived as a real `{ ok: false, error_code }` envelope — the token is wrong, revoked, or the bot was deleted, and no amount of retrying fixes that. A bare HTTP status is explicitly *not* enough: a captive portal, a corporate proxy or a CDN error page answers 401 or 404 with an HTML body, and on an unattended Mac that would be a silent unrecoverable death on a hotel Wi-Fi login screen — diagnosed in the log as a bad token. `TelegramApiError.fromTelegram` is the flag that keeps the two apart; anything without it backs off like any other network error and recovers when the network does.

`stop()` aborts the in-flight poll through an `AbortController`, waits up to 3s for the loop, flushes the pending rejection summary and writes a `telegram.bot` stop event — all before `storage.close()`, which is why `index.ts` awaits it.

`pollTimeoutSec` is floored at 1 both in config validation and at use: a zero-second "long" poll is a busy loop that never yields to a timer. A poll that returns empty in under 250ms also pauses, in case something upstream is not honouring `timeout` at all.

## Config

`server/data/config.json` — the file that already holds the storage choice. **Not** the DB: `tm_config` is dumped by `GET /api/config` to anything that can reach the API, and a bot token is a credential.

```json
{
  "telegram": {
    "enabled": false,
    "botToken": "",
    "allowedUserId": 0,
    "pollTimeoutSec": 25,
    "notify": {
      "review": true, "attention": true, "failed": true, "blocked": true,
      "published": true, "proposal": true, "feature": true,
      "usage": true, "queue": true, "boot": true
    }
  }
}
```

| key | meaning |
|---|---|
| `enabled` | off by default; the bot is opt-in |
| `botToken` | BotFather's `<id>:<secret>`; the shape is checked before it can reach `fetch`, whose URL-parse error would otherwise quote the token into the log |
| `allowedUserId` | the ONE Telegram user id the bot answers |
| `pollTimeoutSec` | `getUpdates` long-poll seconds, 1..50 |
| `notify.*` | one boolean per pushed event class (see § Notifications); all on by default. Flipped by `/notify` `/mute` `/unmute`, which write ONLY this subtree back to the file — a hand-edit made since boot is never clobbered by a toggle |

Validated on load. Type errors throw (`telegram.pollTimeoutSec must be an integer in 1..50`); `enabled: true` with a missing token or user id does **not** — that would take the whole server down, and under the front door into a respawn loop, over the one subsystem that is optional. The bot refuses to start and says which key is missing.

A config file written before this block exists gets the defaults; the block is merged field by field, so a partial one does too.

**Boot log**, always one line:

```
telegram: bot disabled (data/config.json telegram.enabled)
telegram: bot enabled, answering user id 123456789 only
telegram: connected as @your_bot
telegram: enabled but telegram.botToken is empty — bot NOT started (docs/telegram.md)
```

### One piece of bot state in the DB

`tm_config` key `telegram.updateOffset` — the polling cursor, which has to survive a restart or every pending update replays. It is bot state, not a knob: it is deliberately absent from the `PUT /api/config` schema, and the settings page only sends keys it changed, so nothing in the UI can clobber it.

## Notifications

`notifications.ts` subscribes to the same in-process `broadcast()` bus that `/ws/events` fans out to browsers (`server/src/events.ts` — `onEvent()`), started after the boot drain so the "back online" message is the first thing the phone hears, stopped with the bot. The bus is **live-only**: events fired while the bot is down are not replayed — the boot message plus `/status` are the catch-up story.

### Event → message

| bus event | condition | class | message (buttons) |
|---|---|---|---|
| `task.updated` | status became `review`, and **no adversarial round is in flight** (see below) | `review` | 📋 title `id8` is in **review**, plus the task's `error` when set (⚠ the failed-publish reason) or else its `resultSummary` (**Mark done / Publish / Proceed**) |
| `event.appended` (`run.reviewed`) | task still in `review` at flush | `review` | the same message carrying the verdict + findings count from the audit row (**Mark done / Publish / Proceed**) |
| `run.needs-attention` | task still `running` at flush | `attention` | ✋ title **needs attention** — the agent is waiting on a prompt |
| `task.updated` | status became `failed` | `failed` | ❌ title **failed**: the task's `error` |
| `task.updated` | status became `blocked` | `blocked` | ⛔ title is **blocked** (waiting on its subtasks) |
| `task.updated` | status became `published` | `published` | 🚀 title was **published** — committed and pushed |
| `proposal.created` | status `pending` (accept/reject re-broadcast the same event as an upsert — filtered) | `proposal` | 💡 **Proposal** (kind · counts): title + rationale; a `solution_options` proposal additionally renders EVERY option in full — label, approach, tradeoffs (**Accept / Reject**, or **one accept button per option** + Reject) |
| `feature.updated` | status became `proposed` | `feature` | 🧩 Feature title analyzed — phases/tasks, last plan-review verdict + findings, plan summary (**Approve & start**) |
| `feature.updated` | status became `paused` | `feature` | ⏸ Feature title was **paused**: the error |
| `task.updated` / `run.exited` | nothing `queued`, nothing `running`, and there HAD been work since the last drain | `queue` | 🏁 **Queue drained** (+ review count) |
| *(usage watcher, 60s poll of `usageSnapshot()`)* | a window's known `resetsAt` passed | `usage` | 🔄 the window reset (was N%) |
| *(usage watcher)* | pct crossed 50 / 80 / 95 upward | `usage` | 📈 window crossed N% — now M% (+ resetsAt) |
| *(bot lifecycle, not the bus)* | boot drain finished | `boot` | the "back online" message with the discarded-updates count |

### Coalesce, then re-check

Every task-scoped notification waits **5s** and then **re-reads the entity from storage**; only what is *still true* is sent, as one message per task. That one rule does three jobs:

- **Bursts collapse.** One mutation often emits several broadcasts; a task gets at most one message per 5s window.
- **The review-fix loop stays quiet, on ground truth.** The Stop hook moves the task to `review` and only then fires the adversarial reviewer, which takes minutes — so the entry ping alone would arrive verdict-less (or worse, wearing the PREVIOUS round's badge), and every fix-round re-entry would ping again. The orchestrator therefore tracks in-flight rounds (`isReviewPending()`, set synchronously when `reviewCompletedRun` is fired, cleared in its `finally`), and the notifier **defers** the entry ping while one is pending — re-checking every minute, up to 30 times, so a round that dies without a verdict still produces a late ping rather than none. The round's normal endings need no retry: the verdict arrives as `run.reviewed` and prompt-flushes the parked record, and a fix round moves the task back to `running`, which the flush re-check turns into silence. Ground truth rather than predicting from `review.enabled` on purpose: entry paths that never run a review (a worker that exited 0 before its Stop hook, a split parent rolling up, a failed publish landing) must ping immediately, not be silenced forever. The stale-badge fallback (parsing `reviewSummary`) is gone for the same reason — a leftover "✓ clean" next to live Publish buttons invites shipping on the previous round's verdict.
- **Mute is honoured late.** The class switches are read at flush time, so `/mute` also silences what was already in flight.

Transition detection is a last-seen-status memory primed from storage at start — without priming, the first broadcast about a pre-existing task (a title edit on something sitting in `review` since before boot) would read as a transition and ping the phone about old news. Same-status broadcasts are content edits and stay silent. The queue-drained check arms itself when it sees queued/running work and fires once per drain, not once per event; the usage watcher compares consecutive snapshots, so thresholds re-arm automatically when a window resets.

### Buttons

Inline keyboards ride the **last** chunk of a message. `callback_data` is a `<ns>:<verb>:<id>` string — `p:acc:<n>:<id>` for the option-choosing accept, the one action that carries a parameter (Telegram caps the whole thing at 64 bytes); codec and dispatch table live together in `actions.ts` so a button cannot be added to one without the other, and an option segment on any other verb parses as null rather than being guessed about.

A `solution_options` proposal is a **choice, not a confirmation**: storage resolves an index-less accept as option 0 and appends that option's approach to the task description as the chosen one. So the notification renders every option in full, the keyboard offers one accept button per option (never a bare Accept), and the action layer refuses an index-less accept on any proposal that has options — from a button *or* from a future command — with "pick one with its own button". The confirmation names the chosen option. A press is gated exactly like a message — the presser's id must be the allowlisted one, and, when the carrying message survived Telegram's 48h window, its chat must be the owner's private chat; anything else is dropped in silence and counted. The press is answered with a toast (`answerCallbackQuery`), audited as `telegram.command` (`command: 'button:<kind>'`) **before** the answers, and confirmed with a message.

The actions behind the buttons are the same in-process moves the REST routes make, with `actor: 'telegram'`: **Mark done** = `review → done` (+ close sessions, resolve the parent/feature), **Publish** = the task's own session commits and pushes (landing decided by git, so the `published`/`review` outcome arrives as its own notification), **Proceed** = resume the task's previous claude session, **Accept/Reject** = the proposal decision, **Approve & start** = feature `proposed → approved → running` in one tap — the visual plan check already happened when the analysis report was read.

## Security posture

- **Exactly one allowlisted user, in their own private chat.** `from.id === allowedUserId && chat.id === allowedUserId && chat.type === 'private'`. A group message is refused even when the owner sent it: everyone else in that group would otherwise read the answers.
- **Everything else is dropped in silence and counted** (`/status` shows the totals). Never answered — an answer is a confirmation that the bot exists and is alive.
- **One exception, because setup needs it**: `/start` from a stranger replies `Not allowed. Your Telegram user id is <N>.` Finding your own user id is otherwise a third-party bot's job. It is fenced on three sides, and each fence is load-bearing:
  - **private chats only.** Group privacy mode still delivers slash commands to a bot, and anyone can add a bot to a group — without this, a stranger turns the server into something that posts unsolicited into arbitrary groups.
  - **never to the owner.** The owner typing `/start` in a group lands in the same branch (the chat is not private), and the reply would publish the owner's own user id — the one value the whole gate rests on — to everyone in that group.
  - **throttled** to one reply per id per hour, with a table capped at 200 ids, so it cannot become an echo service or a memory leak. Once the table is full `/status` renders the distinct count as `200+`.
- **Turn off BotFather's "Groups" permission** (`/setjoingroups` → Disable) when you create the bot. The code refuses group traffic, but not being addable to a group at all is the cheaper half of the same guarantee. The workbook (task 6) makes this a numbered step.
- A command addressed to another bot (`/status@some_other_bot`) is ignored rather than answered.
- **Free text does nothing on its own.** A bare message becomes a draft only after an explicit confirm button, and even then only a `draft` — see § Free text.
- **The bot never pipes chat text into a PTY.** Steering an agent goes through follow-up/Proceed, which respawns or resumes the claude session with the text in the *prompt*; `/proceed <id> <text>` is that path, not a write to a terminal. The terminal WebSocket remains the code-execution surface and the bot still does not expose it.
- **Every action is audited** — see below.
- The bot does not block a server restart. It is not an agent; `restart-check` does not count it.

## Audit

`tm_events` rows, always `actor: 'telegram'`.

| kind | when |
|---|---|
| `telegram.command` | a command handled for the owner: `{ command, ok, args }`; `{ command, known: false }` for an unknown one; `{ command, ok: false, error }` when the handler threw; `{ command: null, ignored }` for a non-text or free-text message the owner sent; `{ command: 'button:<kind>', target, ok }` for an action button; `{ command: 'button:flow:<kind>:<step>', value, ok }` for a wizard press; `{ command: 'flow:<kind>:<step>', ok }` for a typed flow answer |
| `telegram.rejected` | a **summary** of dropped updates: `{ dropped, totalSinceBoot, distinctUsers }` |
| `telegram.bot` | `{ event: 'started', username, discardedAtBoot, bootMessageSent, offset }` / `{ event: 'stopped', offset, reason }`, where `reason` is `shutdown` or `fatal` — a bot that stopped itself on a bad token still writes its row |

Rejections are summarised rather than logged one row each: otherwise anyone who knows the bot's name could write to `tm_events` at will. The first rejection after boot goes through immediately — "someone found the bot" is not news that waits ten minutes — and the rest are batched at one row per ten minutes, plus a flush on shutdown.

A command is audited **before** its answer is sent: the row records that the server acted, which stays true even if Telegram then refuses to deliver.

`ok` is the **write's** outcome, not "the handler returned" — on a flow row and on a command row alike. A refused edit or a refused on-create queue move still produces a perfectly good sentence to send (`⚠ …`), and an earlier version reported those as `ok: true` with a "Created"/"OK" toast — an audit trail recording a success that did not happen. The toast, the message and the row now all come from the same `StepResult.ok`.

Commands were the last surface where this was not true: `dispatch()` distinguished only "threw" from "returned", so `/enqueue` on a running task answered `⚠ cannot enqueue from status 'running'` and audited `ok: true`, while the identical refusal pressed as ⏳ Queue audited `ok: false`. Handlers now return a `Reply` carrying `ok` (`say()` propagates `ActionOutcome.ok`), so querying `tm_events` for "did `/publish` publish?" gives the same answer whether the owner typed or tapped.

The `telegram.command` row is only the *transport* half. The action itself writes the domain rows it always wrote — `task.created`, `task.transition`, `task.edited`, `task.queue`, `proposal.decided`, `orchestrator.toggle`, `run.killed` — with `actor: 'telegram'`, because the bot calls the same service functions the routes do. Nothing the bot can reach is audited only as "a Telegram command happened".

## Messages

HTML parse mode. Everything interpolated goes through `escapeHtml` (`& < > "` — the last one matters inside an `href`; `'` is safe to omit only because every attribute here is double-quoted). `sendMessage` chunks at Telegram's 4096-character limit, preferring a newline boundary; a hard cut backs off rather than bisect an entity or a tag.

Each chunk is parsed by Telegram independently, so a tag pair may not span one. Rather than make that a rule callers have to remember, the chunker **closes any tag left open at a cut and reopens it** (attributes and all) at the head of the next chunk — a report with a 6000-character line would otherwise come back `Unmatched start tag` and be lost entirely. What chunking does not preserve: trailing whitespace on a chunk, and the newline it was broken at.

Link previews are disabled: a repo path or URL in a status line should not become a card.

## Commands

Registered with `setMyCommands`, so they autocomplete in the client. The tables below are the whole surface; `/help` renders the list from the same array the router looks up, so the two cannot drift.

### Orientation

| command | answers |
|---|---|
| `/start` | what the bot is |
| `/help` | the command list, generated from the router table |
| `/status` | queue on/off, agents `n/m` (+ headless), the three usage windows with `resetsAt`, queued (and custom-queued) count, tasks in review, needs-attention runs, uptime, and the discarded/rejected update counters |
| `/repos` | every registered repo — short id, name, open-task count, path |
| `/tasks [status\|repo]` | no argument = the **open** tasks (everything not `published`/`done`/`failed`/`cancelled`), newest first. An argument that is a task status filters by it; anything else resolves as a repo (by name, then by id prefix). A `➕` marks a custom-queue member |
| `/task <id>` | one task in full: status, repo, category, description, the resolved model/effort/review/auto-publish (naming the preset when they match one), its custom-queue standing, feature and phase, result summary, review summary, error — plus the buttons its **current status** makes possible |
| `/queue` | the custom queue: the **waiting** members numbered `#1…#n` in the order they will run, then — listed apart, because they have no position left — any member that is running, in review or blocked and so still holds its repo's place |
| `/features` | every feature: status, repo, phase/task counts, error |
| `/proposals` | pending agent proposals with their ids and rationale |
| `/kill` | with no argument, the live runs and their ids, one **✖ kill** button each |

### Tasks

| command | does |
|---|---|
| `/new [text]` | the creation flow: repo picker → title → description (skippable) → **preset** (Small / Routine / Complex / Codex, or ⚙ Custom → model → effort → review) → auto-publish → **On create: 📝 draft / ⏳ queue / ➕ custom queue / ▶ run now**. With text after the command the first line seeds the title and the rest the description, and those two steps are skipped |
| `/edit <id>` | field picker → the new value. Title, description and category are typed (send `-` as the category to clear it); repo, model, effort, review and auto-publish are keyboards. One field per `/edit`. **Repo is on that list deliberately**: a task can arrive repo-less (the REST body allows it, and agents and proposals create them that way), every run path then refuses with "assign a repo before running this task", and without this field the phone had no way to act on that refusal |
| `/enqueue <id>` | into the global queue (`draft`/`failed`/`cancelled`/`review` → `queued`) |
| `/run <id>` | run now, jumping the queue |
| `/cancel <id>` | de-queue, or kill the session and cancel |
| `/retry <id>` | re-queue a `failed`/`cancelled` task |
| `/unblock <id>` | `blocked` → `review` |
| `/complete <id>` | `review` → `done`, closing the task's terminals |
| `/publish <id>` | commit and push in the task's OWN session (`docs/publish.md`); the landing status arrives later as its own notification, decided by git |
| `/proceed <id> [text]` | steer the task with an instruction. **Without text the bot asks for it** rather than resuming with the generic "carry on" — the reason to reach for `/proceed` from a phone is that you have something specific to say. Whether a claude session survives decides *which* move runs, never whether the instruction is collected: with one it resumes that session, without one it starts a **fresh worker carrying the message** (`followUp` mode `auto`, the web drawer's "Send follow-up" behaviour) and the prompt says so up front. `/run` is not the fallback — it spawns off the task description and would throw the typed instruction away |
| `/queue add\|remove <id>` | the serial custom queue (`docs/queue.md`), independent of `/on` `/off` |

### Proposals, features, orchestrator

| command | does |
|---|---|
| `/accept <id> [option]` | accept a proposal. The option number is **1-based**, matching the listing; an options proposal refuses an index-less accept (see § Buttons) |
| `/reject <id>` | reject a proposal |
| `/feature [text]` | the feature intake: the long request (typed, or given after the command) → repo picker → the feature is created and the headless analysis starts immediately. The plan comes back through the notification path with an **Approve & start** button |
| `/approve <id>` | the same approve-and-start as that button, by id |
| `/on` / `/off` | start / stop picking tasks. `/off` is the soft one: live sessions keep running (`/kill` ends one) |
| `/kill <run id>` | kill a live run |

### Bot

| command | answers |
|---|---|
| `/notify` | the event classes with their on/off state; `/notify <class> [on\|off]` sets one (no value = toggle) |
| `/mute` / `/unmute` | all classes off / on — commands still answer while muted |

The toggles mutate the live config **and** persist to `data/config.json`; when the write fails, the reply says so and the toggle still holds until restart.

Task 4 adds `/killall` and `/restart`; task 5 adds `/report` and `/digest`.

### What the bot does not do

The SPA can issue roughly 38 distinct mutating endpoints; the bot reaches 17. What is missing is missing on purpose, and it falls into four groups:

- **Needs a keyboard and a screen.** Registering or editing a repo (an absolute filesystem path typed correctly), the six repo-command endpoints (`docs/commands.md` — saved command lines, also argv-tokenised), `PUT /api/config` (the settings page), and editing a feature's plan card by card before approval. These are laptop jobs; getting them wrong on a phone is worse than not having them.
- **Is the terminal, or reaches it.** The PTY WebSocket is the code-execution surface and the bot deliberately does not expose it — that is the security posture, not an omission. `stop-agent` and task file upload/download sit next to it and stay off too.
- **Belongs to a later task.** `/killall`, `/restart` (task 4), `/report`, `/digest` (task 5).
- **Has no phone-shaped use yet.** Deleting a task, `POST /api/analyze`, cancelling a dispatch, per-repo git commit/push, sentry sync, group name/colour, and six of the nine feature verbs (`pause` `resume` `cancel` `complete` `start` and re-analyse — `/feature` and `/approve` cover intake and the decision, which are the two a phone actually wants).

If one of these turns out to matter in daily use, it is a small addition: the action layer and the flow engine are already there.

### Short ids

Nobody types 36 characters on a phone, so **every `<id>` above accepts a prefix** — the 8-character form `/tasks` and `/task` print. The rules are strict in both directions on purpose, because guessing here means running the wrong agent in the wrong repo:

- an exact id always wins outright;
- a prefix shorter than **4** characters is refused as too short rather than resolved;
- a prefix matching more than one row is an **error naming the candidates** (up to six, then "and N more"), never a pick;
- case is ignored and a leading `#` is stripped;
- `/kill` resolves against **live runs only** — a finished run cannot be killed, so matching a week of exited rows would turn every short id into an ambiguity error for no reachable outcome;
- repos additionally resolve by exact name (`/tasks alpha`), because nobody remembers a repo uuid either.

## Conversations

Anything that needs free text is a reply-to conversation; anything that is a choice is an inline keyboard. Both live in `flows.ts` so a flow's steps, its buttons and its terminal write cannot drift apart.

**Exactly one flow at a time.** The gate allows exactly one user, so "the active flow" is unambiguous, and a second half-finished `/new` is a way to file a task into the wrong repo rather than a feature. Any slash command except `/help` and `/status` drops a flow in progress and **says so** (`(dropped the unfinished /new)`) — typing `/status` mid-`/new` is a person changing their mind, not the title of a task, and an abandoned flow that vanishes silently is a surprise later.

The note fires whenever a drop happened, **including when the command started a new flow** — `/edit` on top of a half-finished `/new` is precisely the case that needs saying, since the reply otherwise looks like nothing was lost. `/help` and `/status` are the exception because they drop nothing.

The other exception is a pending **draft offer**: it is a proposal the bot made about a stray message, not work the human was part-way through, and it created nothing — so it goes quietly rather than putting a line of noise in front of every command typed after a stray message.

**Ten-minute timeout**, checked on read rather than driven by a timer: a flow left alone past it is gone and the next message starts fresh. Every step taken refreshes it.

**In memory only.** A restart loses a half-typed task, which is the right trade — the alternative is a table of dangling intentions that fire hours later, exactly what the boot-discard rule exists to prevent.

**Wizard buttons live in their own `w:` namespace** (`w:<seq>:<step>:<value>`), parsed by `parseFlowData` before the action codec ever sees the payload. That separation is load-bearing: the action buttons in `actions.ts` are stateless and stay valid forever (a Publish button on a week-old notification still means one thing), while a "pick this repo" button is meaningless without the flow it belonged to. A wizard press is checked against the step the flow is **actually on**; a press for a step already passed, or for a flow that ended, is answered `That step is no longer active` rather than replayed.

`<seq>` is a monotonic **flow-instance** number, and it is there because the step name alone is not identity. `/edit taskA` → tap Model → change your mind with `/edit taskB` → tap Model → then scroll up and tap taskA's keyboard: a name-only check ("is the flow on `value` with field `model`?") says yes, and **taskB** gets patched from a keyboard rendered under taskA's prompt. The instance number makes that press stale. It never resets, so a button from a cleared flow stays stale rather than becoming valid again; the worst-case payload is 50 bytes against Telegram's 64.

✕ Cancel is the one press exempt from the check — it is idempotent, writes nothing, and "the Cancel button on the message above no longer works" is a worse surprise than cancelling something already gone. Every flow keyboard carries it.

**Typing at a button step re-prompts** (`Use the buttons above, or ✕ Cancel to start over`) instead of writing what was typed into a field it was never meant for.

The 💬 **Proceed** button — on a `/task` card and on a review notification — opens the same conversation `/proceed <id>` opens, rather than resuming with the generic "carry on". A button that resumed blind would undo, one tap at a time, the rule the command spends fifteen lines enforcing; it also gets the same `resumableSessionId()` pre-check and the same refusal.

### The custom-queue position

`/task` and `/queue` derive their ordinal from `customQueueWaiting()` in `shared/src/types.ts` — the **same function** the board's `queue #n` chip uses, which is why it moved out of `web/src/components/QueueMark.tsx` and into `shared/`. Before that they were two filters and they disagreed: `transitionTask` clears `custom_queue_at` only on a terminal status, so a `running`, `review` or `blocked` member keeps its mark (by design — it still holds its repo's working tree, `docs/queue.md`), and counting those inflated every bot-side position by however many were in flight. With one member in review and two queued, the phone said `#3 of 3` where the board said `queue #2`.

So the count is **waiting members only**, and a member that is not waiting is not given a number at all: `/task` says it holds the queue's single slot (`running`) or that it is holding its repo's place (`review`/`blocked`), and `/queue` lists it under a separate heading.

### Free text

A message that is not a command and does not answer a live flow **never becomes a task on its own**. It comes back as a preview — first line as the title, the rest as the description — with **✅ Create draft** / **✕ Discard**. Only the confirm creates anything, and what it creates is a `draft`: "I was thinking out loud" and "queue this" look identical in a chat window, so the gate is a tap rather than a heuristic. With more than one repo registered the confirm asks which one; with exactly one it uses it. The reply names the new id so `/edit` and `/enqueue` follow naturally.

A **second thought sent while the first is still waiting on its button replaces the offer** rather than being swallowed for the rest of the timeout. This is the one place the "a flow is waiting for a button" rule gives way, and it should: the headline behaviour of the surface is "send a thought, get a draft offer", and a superseded offer had created nothing — which is the whole point of the confirm gate. Discarding an offer explicitly still works, and both are one tap.

### Agent parameters

The `/new` flow offers the same `TASK_PRESETS` the web form does (`shared/src/types.ts`, one source for both surfaces) — Small, Routine, Complex, Codex (free) — each resolving model + effort + review in one tap. ⚙ Custom asks for the three separately, each with a `default (config)` option that writes `null` and falls back to the `agent.model` / `agent.effort` / `review.enabled` settings, exactly as the web dropdowns' "default (config)" does.

`➕` means the **custom** queue everywhere in the bot — the marker on a queued row in `/tasks`, the `/task` standing line, `taskActionKeyboard`'s buttons and now `/new`'s on-create step, where the global option wears `⏳` instead. `/new` previously offered `➕ Add to queue` for the *global* queue, which is the one that stops when `/off` is set: the opposite of what the symbol promises next to a serial queue that ignores it. `/new` can now reach the custom queue at all, which it could not before — it took a follow-up `/queue add`.

**Auto-publish is always its own step**, on both the preset and the custom path. Presets do not carry it (the web ones do not either), and it is the one parameter that decides whether work reaches `origin` without a human looking, so it is asked rather than defaulted silently.

The model picker is a shortlist (`MODEL_OPTIONS` plus `codex-free`) even though the column accepts any string: a typo'd model id does not fail here, it fails at spawn time, hours later.

## Verification

No test framework in this repo, so the module is verified by driving it against a stubbed global `fetch` — no token, no network, real SQLite through the real driver. 38 assertions:

- boot drain discards a pre-boot update, answers a fresh one, and the "back online" message reports the count;
- a stranger's `hello` and `/status` get **no** reply; their `/start` gets exactly one, disclosing only their id; the second `/start` is throttled;
- the owner messaging from a group is refused;
- `/status` renders the live numbers; an unknown command is answered;
- the audit trail is `actor: 'telegram'` throughout, commands are one row each, rejections are summaries, lifecycle is recorded;
- the offset is persisted to `tm_config`;
- the chunker respects 4096, drops nothing but trailing whitespace and the break newline, never bisects an entity, closes and reopens a tag pair across a cut, and terminates fast on a 5000-character single word;
- a stranger's `/start` in a **group** gets no reply, and neither does the owner's `/start` in a group;
- a command addressed to another bot is ignored;
- `escapeHtml` covers all four characters;
- `stop()` called twice neither hangs nor double-writes;
- a captive portal's non-JSON 401 keeps the bot retrying and it recovers when the stub starts answering properly, while a real `{ok:false, error_code:401}` envelope stops the loop, writes a `reason: 'fatal'` lifecycle row, and writes no `started` row;
- a disabled bot, and one with a malformed token, make no API call at all;
- an existing `config.json` with no `telegram` block loads with the defaults.

The harness itself is attached to the task as `telegram-harness.mts`; run it with `npx tsx`.

Task 2 (notifications) adds a second harness, `telegram-notify-harness.mts` (43 assertions, real SQLite through the real driver, real `broadcast()`): a burst of broadcasts for one task coalesces into one message; the review message carries the verdict + findings count from the `run.reviewed` audit row and the three action buttons; titles, errors and rationales are HTML-escaped; a task that left `review` before the flush stays silent; a class muted inside the 5s window is honoured; a content edit on a primed same-status task is not a transition; a pending proposal is announced exactly once despite the accept/reject upsert re-broadcast; queue-drained fires once work settles and does not repeat without new work; the entry ping is deferred while a review round is in flight and arrives with the real verdict once it settles; a failed publish landing carries the `publish did not complete` reason and never a stale badge or the old result summary; the button codec round-trips (with and without an option index) and rejects garbage, including an option segment on the wrong verb; an options proposal renders every option and gets one accept button per option and no bare Accept, an index-less accept is refused while an explicit one lands the CHOSEN option in the task description; `completeTask` moves `review → done` with `actor: 'telegram'` in the audit trail and refuses anything else; reject/accept proposal outcomes; `/mute` `/unmute` `/notify` toggles (including the unknown class and the persist-failure reply); a keyboard rides only the last chunk of a long message.

Task 3 (full command coverage) adds a third, `telegram-commands-harness.mts` (226 assertions), which drives the **real `TelegramBot`** — so the gate, the router, the flow store and the callback dispatch are all exercised — against a stubbed `fetch`, real SQLite and a stub orchestrator (spawning `claude` from a test is not a test):

- short ids: an exact id, a unique prefix, an ambiguous one refused with its candidates listed, a two-character prefix refused as too short, no match, case and `#` tolerated;
- the two button codecs stay disjoint — a `w:` payload is invisible to `parseActionData` and a `t:` payload to `parseFlowData`, and the new action buttons round-trip;
- `/repos`, `/tasks` (default hides terminal tasks, by status, by repo name, junk argument explained), `/task` (detail escaped; the keyboard matches the status — done/publish/proceed in `review`, queue/run on a draft);
- `/new` end to end on the preset path (Routine → auto-publish off → **Add to queue**: queued, `customQueueAt` null, params from the preset) and on the custom path (model → effort → review → auto-publish on → **Save as draft**), plus the seeded `/new <text>` form skipping straight to the presets;
- a wizard button for a finished flow, and one for the wrong step, are refused rather than replayed; ✕ Cancel ends a flow and says so when there is nothing to end; a command drops an unfinished flow with the note, while `/status` does not;
- free text creates nothing until the confirm, splits title from description, asks which repo when there are two, and Discard leaves no row;
- `/edit` writes a typed title, a keyboard-chosen model and auto-publish, is audited as `task.edited` with `actor: 'telegram'`, and re-prompts instead of writing text typed at a button step;
- every lifecycle command's happy path and its refusal: `/enqueue` `/cancel` `/retry` `/complete` (refused off `review`) `/run` `/publish` `/unblock` `/proceed` (with and without text), plus the repo-less and live-session guards;
- `/queue add` marks membership and queues, `/queue remove` drops the mark and cancels the waiting member, both audited as `task.queue`;
- `/on` `/off` toggle once and say so when already there; `/kill` lists live runs, kills one, and refuses a dead one;
- proposals: listing, escape, `/reject`, an index-less accept on an options proposal refused, an explicit `/accept <id> 2` landing option B's approach in the task description;
- features: listing, `/approve` refused off `proposed`, `/feature` asking for the repo (with and without text after the command);
- the flow timeout is ten minutes and is enforced on read;
- `/proceed` with no resumable session refused up front, pointing at `/run`, starting no flow and resuming nothing — so the next message is still free text;
- a second free-text message replaces a pending draft offer, and confirming creates the newer text once while the superseded one leaves no row;
- an automatic cascade stays actor-less (so `'system'`) on both `/complete` and `/queue remove`, while the move that triggered it is still `'telegram'`;
- `/task` prints the FIFO ordinal (`#1 of 1`) and still says when the task was added;
- a cross-flow command names the flow it dropped and still starts the new one, while `/status` drops nothing and a pending draft offer goes quietly;
- `/proceed <id> <text>` reaches the orchestrator with its newlines intact;
- `/task`'s ordinal is computed against the shared `customQueueWaiting()` and matches what the board would print, excluding an in-review member that still holds its mark; that member reports holding its place and gets no number;
- every button `/task` emits parses back through `parseActionData` and carries the right task id — the check that a hand-written wire string would fail;
- the 💬 Proceed button opens the conversation instead of resuming blind, resumes nothing on the press, sends the typed instruction, and gets the same no-session refusal as the command (after which the next message is free text again, i.e. no flow was left dangling);
- a write refused mid-flow (task deleted under an `/edit`, a live session refusing `/new`'s queue move) is toasted `Failed` and audited `ok: false` — while the task the create step made still exists;
- `/new` offers `⏳ Queue` and a separate `➕ Custom queue`, and the latter lands the mark;
- `/edit` assigns a repo, turning "assign a repo before running this task" from a dead end into a two-tap fix that then queues;
- a command that fails still names the flow it dropped;
- a 340-character single line becomes a 300-character title plus a 40-character description — the remainder, not the whole text again;
- `/cancel` leaves the cascade actor-less for a queued task *and* for a running one;
- a Proceed press whose storage call throws is answered rather than vanishing, and the poll loop keeps serving afterwards — driven by making `getTask` throw `SQLITE_BUSY` mid-press. Against the pre-fix code this check fails with `telegram: loop crashed` and every later assertion sees a dead bot, which is what it is there to catch;
- `safeDispatch` swallows a throw from ANY dispatch path (driven by making `dispatch` itself throw), reports it and audits `ok: false`, leaving the loop running;
- refused commands (`/enqueue` `/publish` `/retry` `/run` `/complete` on a settled task) audit `ok: false` while a successful one still audits `ok: true`; `killRun`'s own not-live guard is driven directly;
- a command that genuinely THROWS (`listRepos` raising `SQLITE_BUSY` under `/repos`) reports the failure, still names the flow it dropped, audits `ok: false`, and leaves the loop serving;
- the Proceed button audits `ok: true` when it opens the conversation and `ok: false` when there is nothing to resume, and names the flow it dropped;
- an over-long category is refused, writes nothing, audits `ok: false`, and leaves the flow open so a shorter one lands;
- a wizard press from an EARLIER flow instance is refused and patches neither task, while the current instance's button still works, and every rendered wizard button carries an instance number;
- `/proceed` with no resumable session still collects the instruction and routes it to `followUp` in `auto` mode rather than resuming or discarding it — in both the flow and the one-shot form;
- `/kill`'s listing offers a working kill button per live run;
- the audit trail: the bot's rows include DOMAIN kinds (`task.created`, `task.transition`) and not merely transport rows, every `telegram.*` kind is attributed to the bot, and other actors exist in the same table so that check is not tautological.

Task 1's harness had been broken since task 2 added `telegram.notify` to the config (its literal predated the field, so the loop crashed on `cfg.notify.boot` before the first message went out) — the literal is fixed and its 38 assertions pass again.

**Not verified**: a real BotFather token against the real Bot API — that is the workbook's job (task 6), and it needs a human with a phone. The usage watcher's threshold/reset comparisons are reviewed but not driven by the harness (`usageSnapshot()` reads real transcripts and CLI caches). `/feature` is driven only as far as the repo picker: pressing it starts a real headless `claude -p` analysis, which a smoke test must not do.
