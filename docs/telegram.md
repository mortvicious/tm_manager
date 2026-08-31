# Telegram bot — the task manager from a phone

Status: **tasks 1–2 of 6 landed** (bot module + notifications). The full design, the command table and the report shape live in [`future/telegram-bot.md`](future/telegram-bot.md); the setup workbook (BotFather → token → your user id → enable → verify, plus the Mac-as-a-server checklist) is task 6 and is not written yet.

Shipped so far: long polling, the config block, the single-user gate, the in-process command router with `/start` `/help` `/status` `/notify` `/mute` `/unmute`, the boot/shutdown lifecycle, the audit trail, and push notifications off the `broadcast()` event bus with inline action buttons. The rest of the commands, the red button and reports are tasks 3–5.

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
| `actions.ts` | the shared action layer: one function per action (complete/publish/proceed/accept/reject/approve) + the button codec — buttons today, the task-3 commands tomorrow, never two implementations |
| `notifications.ts` | the push half: `broadcast()` subscriber, coalescing, transition memory, the usage watcher |

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
- **Free text does nothing.** "A bare message becomes a draft task" stays behind an explicit confirm (task 3).
- **Every action is audited** — see below.
- The bot does not block a server restart. It is not an agent; `restart-check` does not count it.

## Audit

`tm_events` rows, always `actor: 'telegram'`.

| kind | when |
|---|---|
| `telegram.command` | a command handled for the owner: `{ command, ok, args }`; `{ command, known: false }` for an unknown one; `{ command, ok: false, error }` when the handler threw; `{ command: null, ignored }` for a non-text or free-text message the owner sent; `{ command: 'button:<kind>', target, ok }` for a button press |
| `telegram.rejected` | a **summary** of dropped updates: `{ dropped, totalSinceBoot, distinctUsers }` |
| `telegram.bot` | `{ event: 'started', username, discardedAtBoot, bootMessageSent, offset }` / `{ event: 'stopped', offset, reason }`, where `reason` is `shutdown` or `fatal` — a bot that stopped itself on a bad token still writes its row |

Rejections are summarised rather than logged one row each: otherwise anyone who knows the bot's name could write to `tm_events` at will. The first rejection after boot goes through immediately — "someone found the bot" is not news that waits ten minutes — and the rest are batched at one row per ten minutes, plus a flush on shutdown.

A command is audited **before** its answer is sent: the row records that the server acted, which stays true even if Telegram then refuses to deliver.

## Messages

HTML parse mode. Everything interpolated goes through `escapeHtml` (`& < > "` — the last one matters inside an `href`; `'` is safe to omit only because every attribute here is double-quoted). `sendMessage` chunks at Telegram's 4096-character limit, preferring a newline boundary; a hard cut backs off rather than bisect an entity or a tag.

Each chunk is parsed by Telegram independently, so a tag pair may not span one. Rather than make that a rule callers have to remember, the chunker **closes any tag left open at a cut and reopens it** (attributes and all) at the head of the next chunk — a report with a 6000-character line would otherwise come back `Unmatched start tag` and be lost entirely. What chunking does not preserve: trailing whitespace on a chunk, and the newline it was broken at.

Link previews are disabled: a repo path or URL in a status line should not become a card.

## Commands

Registered with `setMyCommands`, so they autocomplete in the client.

| command | answers |
|---|---|
| `/start` | what the bot is |
| `/help` | the command list, generated from the router table |
| `/status` | queue on/off, agents `n/m` (+ headless), the three usage windows with `resetsAt`, queued (and custom-queued) count, tasks in review, needs-attention runs, uptime, and the discarded/rejected update counters |
| `/notify` | the event classes with their on/off state; `/notify <class> [on\|off]` sets one (no value = toggle) |
| `/mute` / `/unmute` | all classes off / on — commands still answer while muted |

The toggles mutate the live config **and** persist to `data/config.json`; when the write fails, the reply says so and the toggle still holds until restart.

Tasks 3–5 add the rest of the command table, `/killall`, and reports.

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

**Not verified**: a real BotFather token against the real Bot API — that is the workbook's job (task 6), and it needs a human with a phone. The usage watcher's threshold/reset comparisons are reviewed but not driven by the harness (`usageSnapshot()` reads real transcripts and CLI caches).
