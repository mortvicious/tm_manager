# Telegram bot — the task manager from a phone

Status: **shipped 2026-09-03** — all six tasks landed (bot module, notifications, full command coverage, the red button, reports, this workbook). Original design and report shape: [`future/telegram-bot.md`](future/telegram-bot.md). **Start at § Connect** — everything after it is how the thing works, not how to turn it on.

What it is: long polling on `fetch` inside the API process, a one-user gate, the whole day-to-day loop (create/edit tasks with agent presets, `/enqueue` `/run` `/cancel` `/retry` `/unblock` `/complete` `/publish` `/proceed`, the custom queue, proposals, features, the orchestrator switch, `/kill`), the red button (`/killall` `/restart`), push notifications with inline action buttons, HTML reports (`/report`, the daily `/digest`) sent as documents, and — since 2026-09-05 — **chat mode** (`/chat` `/chats` `/endchat` `/mode`), a free-form conversation with claude inside one of your repos ([`chat.md`](chat.md)).

That is **not** the whole web UI, and the difference is deliberate — see § What the bot does not do.

## Connect

One-time setup, about fifteen minutes. Steps 1–5 get the bot answering on your phone; step 6 is what keeps it answering after you close the laptop and walk away.

This chapter was exercised rather than written from memory: the boot lines are real output from a real server on an isolated port and database, the replies, buttons and command list are asserted against the real bot code, and the Mac checklist was run on this machine. The one thing nobody could automate is the BotFather dialogue in step 1, which needs a human with a phone. § Verification says exactly what was driven and what was not.

### 1. Create the bot with @BotFather

In Telegram, search for **@BotFather** (the one with the blue verified check — there are impostors) and send `/start`, then:

1. **`/newbot`**.
2. **Name** — the display name at the top of the chat. Anything: `Task Manager`. Changeable later with `/setname`.
3. **Username** — globally unique and must end in `bot`: `faig_taskmanager_bot`. Not changeable later; pick one you can live with.
4. BotFather answers with the **token**, of the form `8000000000:AAH…` — an id, a colon, and a ~35-character secret. Copy it now.

The token *is* the bot. Anyone holding it can read every message sent to it and post as it. It goes in `server/data/config.json` (git-ignored — `.gitignore` line 4 is `server/data/`, and `config.json` is not tracked) and nowhere else: never in `tm_config`, because `GET /api/config` dumps that table wholesale. If it ever leaks, `/revoke` in BotFather mints a new one and kills the old; paste the new one in and restart.

**Then `/setprivacy` → pick your bot → Enable.** Enabled is the default, and the point is to leave it that way. With privacy mode *Disabled*, a bot added to any group receives every message posted in that group — a firehose of other people's text arriving at your server. This bot has no use for it: `chat.type === 'private'` is part of the authorization gate, so group traffic is dropped on arrival regardless. Keeping privacy Enabled means Telegram never sends what the server would only throw away. It is a second lock on a door that is already locked, not the lock itself.

Optional: `/setdescription`, `/setabouttext`, `/setuserpic`. **Do not use `/setcommands`** — the server calls `setMyCommands` with the live list on every boot (all 37 of them, straight from `commandSpecs()`), so anything typed into BotFather is overwritten within a second of the next restart.

### 2. Find your own Telegram user id

The gate keys on your numeric user id, not your `@handle`. The bot will tell you what it is — you do not need a third-party lookup bot for this.

Set the token with a **placeholder** id of `1` (any non-zero number; `0` is special and makes the bot refuse to start at all, because nobody would be allowed to use it):

```json
"telegram": { "enabled": true, "botToken": "8000000000:AAH…", "allowedUserId": 1 }
```

(Three keys are enough for this round — the full block, with the fields you will want later, is in step 3.)

Restart, open your bot in Telegram, and send **`/start`**. It answers:

> Not allowed. Your Telegram user id is `424242`.
> If this bot is yours, put that number in `server/data/config.json` as `telegram.allowedUserId` and restart the server.

That number is what goes in the config.

Two things about that reply, because both look like malfunctions:

- **Only `/start` gets it, and only in a private chat.** Every other message from a non-allowlisted id — `hello`, `/status`, anything — is dropped in silence and counted, never answered. If your first message was not `/start` and nothing came back, the gate is working. Send `/start`.
- **At most one reply per id per hour** (`STRANGER_REPLY_COOLDOWN_MS`), so a stranger cannot make the bot chatter. If you re-send `/start` after a failed edit and get nothing, wait or check the log rather than assuming the token broke.

### 3. Put the token and the id into `server/data/config.json`

The whole block, with the fields you actually have to set at the top:

```json
{
  "port": 5175,
  "host": { "port": 5176 },
  "storage": { "driver": "sqlite", "sqlite": { "file": "data/taskman.db" } },
  "telegram": {
    "enabled": true,
    "botToken": "8000000000:AAH…",
    "allowedUserId": 424242,
    "pollTimeoutSec": 25,
    "notify": {
      "review": true, "attention": true, "failed": true, "blocked": true,
      "published": true, "proposal": true, "feature": true,
      "usage": true, "queue": true, "boot": true
    },
    "digest": { "enabled": false, "hour": 9 },
    "chat": { "enabled": true, "allowWrite": false }
  }
}
```

Only the first three telegram keys need typing. Everything else has a default and a missing `telegram` block loads as "disabled" rather than erroring — the file on disk before this feature shipped had no `telegram` key at all and kept booting fine. Full field table and validation rules: § Config.

`notify` and `digest` are the two subtrees the server writes back to this file itself, when you use `/mute`, `/notify` or `/digest` from the phone. Each rewrite re-reads the file and patches only its own subtree, so a hand-edit you made since boot is not clobbered.

### 4. Restart, read the boot line, say hello

Restart the server (`npm start`, or the ⟳ button in the web header, or `/restart` once the bot is up). The last line of the startup output tells you whether the bot is running, and it is worth reading rather than assuming — all five of these were produced by a real server on an isolated port:

```
telegram: bot disabled (data/config.json telegram.enabled)
telegram: enabled but telegram.botToken is empty — bot NOT started (docs/telegram.md)
telegram: telegram.botToken is not in BotFather's `<id>:<secret>` form — bot NOT started (docs/telegram.md)
telegram: enabled but telegram.allowedUserId is 0 — bot NOT started; nobody would be allowed to use it
telegram: bot enabled, answering user id 424242 only
```

The last one is the one you want, and it is followed a moment later — after the `getMe` handshake actually succeeds — by:

```
telegram: connected as @faig_taskmanager_bot
```

Those two lines are separate on purpose. The first says the config parsed; the second says Telegram accepted the token. If you see the first and not the second, the token is wrong, and the reason arrives on its own line (§ 7).

The bot never blocks the server: a misconfigured bot warns and returns, and the API is up and serving either way. Nothing here can stop the board from working.

Now, on the phone:

- **`/start`** — a two-line description of what the bot is, ending in a pointer to `/status`.
- **`/status`** — the live state. Real output from a running instance:

```
Task Manager

Queue: running · agents 0/2
Usage: 5h 13.5% (est.) | week 21.3% (est.) | fable 10.4% (est.)

Queued: 0
In review: 0

Up since 21:03 · 0 update(s) discarded at boot
Rejected: 4 update(s) from 1 other id(s)
```

That last line is the gate's counter. A non-zero `Rejected` is normal for a bot with a guessable username — it means somebody messaged it and got nothing, which is the design.

If notifications are on (`notify.boot`, default true), a restart also pushes a **back online** message naming how many updates from before the restart were discarded. Actions you typed hours ago do not fire on boot; the message tells you how many were dropped so you know what to resend.

### 5. Verify the whole loop from the phone

Do this once, end to end, before trusting it. It is five taps and it exercises every layer: the gate, the wizard, the orchestrator, the event bus, the notifier, and the audit trail.

1. **`/new`** — the bot asks which repo, and gives you a button per registered repo.
2. Tap a repo. It asks for a **title**; type one line.
3. It asks for a **description**; type one, or tap **⏭ Skip**.
4. Tap a **preset** — Small / Routine / Complex / **Codex (free)** / Custom, the same `TASK_PRESETS` the web board offers; Custom walks you through model, effort, review and auto-publish one at a time. Then answer the **auto-publish** question.
5. Tap **▶ Run now** — or **⏳ Queue** to let the orchestrator pick it up, **➕ Custom queue (serial, ignores /off)** for the strictly-serial queue, or **📝 Save as draft**.

Then wait. When the agent stops, the task lands in `review` and the bot pushes:

```
📋 Workbook smoke task 5636069e is in review.
```

with three buttons: **✅ Mark done**, **🚀 Publish**, **💬 Proceed**. When an adversarial review actually ran, the same line carries its verdict — `… is in review · ✓ clean — 0 finding(s).`, or `⛔ blocker` with the count. A turn that changed nothing is **not** re-reviewed (`decisions.md`, 2026-09-03: the diff hash is the whole test), and in that case the ping arrives bare, as above, rather than re-showing a stale verdict next to a live Publish button.

**Tap ✅ Mark done.** The task moves to `done`, and the row in `tm_events` carries `actor: 'telegram'` — check it in the web UI's task drawer, or:

```bash
curl -s 'http://127.0.0.1:5175/api/events?limit=50' | jq '[.[] | select(.actor=="telegram")]'
```

If all of that worked, the loop is real. `/task <id>` prints any task in full with a keyboard matching its status, and ids are short — the first 4+ characters of what `/tasks` prints is enough.

### 6. The Mac as a server

The bot removes the reachability problem. It does not remove the fact that a MacBook is not a server, and every item below is an operational limit rather than something code can fix.

**Sleep.** Three levers, and the common mistake is expecting one to do another's job:

- **`caffeinate -i <command>`** holds a `PreventUserIdleSystemSleep` assertion for as long as `<command>` runs, and only for that. It stops *idle* sleep. It does not stop lid-close sleep, and `caffeinate -s` (prevent sleep outright) is only honoured on AC power. Check it is actually held with `pmset -g assertions` — a live one shows up as `pid N(caffeinate): … PreventUserIdleSystemSleep`.
- **`sudo pmset -c sleep 0`** is the durable version for AC power: never idle-sleep while plugged in, with no wrapper process to keep alive. Check with `pmset -g custom`.
- **Lid closed is a separate question.** Clamshell with no external display sleeps regardless of either of the above. `sudo pmset -a disablesleep 1` is the usual answer, with two caveats worth knowing before you rely on it: it is a blunt instrument (sleep off entirely, including the low-battery kind), and **it is undocumented** — `disablesleep` is not in `man pmset` on macOS 26, so check it actually took with `pmset -g | grep -i SleepDisabled` rather than assuming. The arrangement that needs no undocumented flag is **lid open, on the charger**, which is what this document recommends. Add heat and battery wear to the ledger either way if an Air runs 24/7.

**Keep it running: a `launchd` agent.** Nothing supervises the front door — `host.ts` supervises the API child, but a dead front door, a crash, or a reboot brings nothing back. `KeepAlive` fixes both. Save as `~/Library/LaunchAgents/com.taskmanager.server.plist`, replacing `YOU`, the repo path, and the node path:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.taskmanager.server</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
    <string>/Users/YOU/.nvm/versions/node/v24.15.0/bin/npm</string>
    <string>start</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/YOU/Development/17 - task-manager</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/YOU/.nvm/versions/node/v24.15.0/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>/Users/YOU</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>StandardOutPath</key>
  <string>/Users/YOU/Library/Logs/task-manager.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOU/Library/Logs/task-manager.err.log</string>

  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
```

```bash
plutil -lint ~/Library/LaunchAgents/com.taskmanager.server.plist   # catches typos before launchd does
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.taskmanager.server.plist
launchctl print gui/$UID/com.taskmanager.server | head -20         # state, runs, last exit code
launchctl bootout gui/$UID/com.taskmanager.server                  # stop and unload
```

Four details that are not decoration:

- **`caffeinate -i` wraps `npm`, not the other way round.** The assertion lasts exactly as long as the server process, so a stopped server stops holding the machine awake.
- **The absolute node path is mandatory.** `launchd` does not read your shell profile, so an nvm-managed `npm` is simply not on the default `PATH`; `which npm` gives you the right string. It goes in `ProgramArguments` *and* in `PATH`, because the server spawns `claude` and `git` as children.
- **`KeepAlive: { SuccessfulExit: false }`**, not `KeepAlive: true` — restart after a crash, stay down after a clean exit — so a deliberate shutdown is not immediately undone by the thing that is supposed to be keeping the server up. `ThrottleInterval` 30 keeps a boot-loop from spinning.
- **`ProcessType: Interactive`** keeps macOS from throttling it as a background batch job.

**Turn off automatic macOS updates.** System Settings → General → Software Update → the ⓘ next to Automatic Updates → turn off *Install macOS updates* (and *Install Security Responses* if you want no surprise reboots at all). Verify with `defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates` — you want `0`. This machine reads `1` at the time of writing, which is exactly the configuration that produces the next item.

**A reboot needs a human, and that is not fixable from here.** With FileVault on (`fdesetup status` — `FileVault is On.` on this machine), auto-login is unavailable by design. An update reboot leaves the Mac sitting at the FileVault unlock screen: no user session, no unlocked Keychain, no `claude` auth, no `launchd` *user* agent — `gui/$UID` does not exist until somebody logs in. `KeepAlive` cannot help, because nothing is running to be kept alive. Moving the job to a **LaunchDaemon** in `/Library/LaunchDaemons` does not rescue this: a daemon does start before login, but it runs as `root` with no user session and no unlocked login Keychain, which is where `claude`'s auth lives — and on an encrypted volume it cannot start at all until the disk is unlocked, which is the same wall.

The practical shape of this: **"the bot stopped answering" is the signal, and walking to the machine is the fix.** Nothing on the phone can unlock a FileVault volume. `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` removes the Keychain dependency for the workers, but not the need to boot into a session, so it narrows the failure and does not close it. Turning FileVault off would allow auto-login and close it completely — at the cost of an unencrypted disk holding every repo you work on. That trade is yours; this document does not recommend it.

**Rehearsing on an isolated instance.** If you want to try the setup without touching your live install: `data/config.json` and `data/` are pinned to the checkout directory (`serverRoot` comes from the module's own path), so a second instance means a second copy of the repo — a `git worktree`, a clone, or a plain `cp -R`. Give it its own ports and its own database:

```json
{
  "port": 5199,
  "host": { "port": 5198 },
  "storage": { "driver": "sqlite", "sqlite": { "file": "data/taskman-isolated.db" } },
  "telegram": { "enabled": false }
}
```

`port` and `host.port` must differ from each other and from the real install's 5175/5176; `TM_HOST_PORT` can move the front door without editing the shared file. **Keep `telegram.enabled: false` there, or give the copy its own BotFather token** — two processes polling one token is the 409 in § 7.

### 7. Troubleshooting

| Symptom | What it means | Fix |
|---|---|---|
| Log repeats `getUpdates failed: … 409 … — another process is polling this bot token (a second server, or a webhook still set)` | **Two pollers, one token.** Telegram gives `getUpdates` to one consumer at a time. Usually a second copy of the server (an isolated instance, a `tsx watch` that did not die, a stale `npm start` in another terminal), or a webhook left over from an experiment. | `pgrep -fl "server/src/index.ts"` and kill the extra. For a webhook: `curl "https://api.telegram.org/bot<token>/deleteWebhook"`. Give any second instance its own token, or `telegram.enabled: false`. The bot backs off and retries, so it heals itself once the other poller stops. |
| Log says `bot enabled, answering user id N only`, but **nothing you send is answered** | **Wrong id in the allowlist.** The gate wants `from.id === chat.id === telegram.allowedUserId` in a **private** chat. A mistyped digit, your `@handle` instead of the number, or a group chat all land here. | Send **`/start`** (the one command a stranger gets an answer to) and read the id it quotes back; put that in `telegram.allowedUserId`; restart. Check `/status`'s `Rejected: N update(s) from K other id(s)` — a climbing count with silence is this exact fault. |
| Commands answer, but **no notifications ever arrive** | **A muted class.** `/mute` sets all ten classes off; `/notify <class> off` sets one. Muting is read at *flush* time, so it also silences messages already in the 5s coalescing window. | `/notify` with no argument lists all ten with their state; `/notify review on` re-enables one, `/unmute` re-enables everything. Note `digest` is deliberately *not* a notify class — `/mute` does not cancel tomorrow's digest. |
| `telegram: … refused by Telegram (getMe: Unauthorized). The token … is wrong, revoked, or belongs to a deleted bot — the bot is stopping until the server restarts.` | A real Telegram `401`/`404` envelope. The token is wrong, was `/revoke`d, or the bot was deleted. This is the one error the bot treats as **fatal**: it stops rather than hammering a token that will never work. | Re-copy the token from BotFather (`/mybots` → your bot → API Token), paste it in, **restart** — a fatal stop does not retry on its own. |
| Boot line: `telegram.botToken` is not in BotFather's `<id>:<secret>` form — bot NOT started | The string does not match `/^\d+:[A-Za-z0-9_-]{20,}$/` — almost always a partial copy, a stray space, or smart quotes from a notes app. No API call is made at all. | Paste the token again, plain text, no surrounding whitespace. |
| `enabled but telegram.allowedUserId is 0 — bot NOT started` | The default. `0` means nobody is allowed, so the bot refuses to start rather than run a bot no one can use. | Use the step-2 placeholder (`1`), find your id, put it in. |
| Nothing in the log about telegram at all, or `bot disabled (data/config.json telegram.enabled)` | `telegram.enabled` is `false` (the default), or the whole `telegram` block is missing — the file loads with defaults rather than erroring, by design. | Set `"enabled": true` and restart. |
| The server refuses to boot with `data/config.json: telegram.…` | A validation error, thrown at load with the exact key and the exact rule. | Read the message — it names the field and the constraint. Full table in § Config. |
| Messages typed while the Mac was asleep **never arrive** | Telegram holds unfetched updates for **24 hours**. Older than that and they are gone on Telegram's side. Anything *newer* than 24h but older than the last restart is discarded on purpose — see § Boot discard. | The back-online message reports how many were discarded. Resend what still matters. |
| The bot answers, but every action fails or `/status` errors | The bot is fine and the server underneath is not — the bot calls service functions in-process, so a broken storage or orchestrator shows up here. | Look at the server log, not the bot. `/restart` from the phone still works — it honours the agents-working guard and, when the guard refuses, offers a **⚠️ Restart ANYWAY (force)** button rather than making you choose blind. |
| Everything was working; now the phone gets nothing and the Mac is unreachable | Most likely a reboot sitting at the FileVault screen. | Walk to the machine and log in. See § 6. |

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

The bot never touches a PTY, and `/chat` did not change that: a chat turn is its own aux terminal since 2026-09-24, but the phone reads its reply from the Stop hook, never from the terminal ([`chat.md`](chat.md) § Turns are terminals). The terminal WebSocket is still not exposed. What a **write-mode** chat does expose is the ability to edit files and run commands in a repo, which is why that half is gated on `telegram.chat.allowWrite` in the config file — see § What the bot does not do.

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
    },
    "digest": { "enabled": false, "hour": 9 },
    "chat": { "enabled": true, "allowWrite": false }
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
| `digest.enabled` | the daily 24h report (§ Reports); off by default. Flipped by `/digest on\|off`, which writes only `telegram.digest` back, same rule as `notify` |
| `digest.hour` | 0..23, **local wall clock on this machine**. "Send it at 9" means the hour the owner wakes up, not a UTC offset they have to compute |
| `chat.enabled` | chat mode from the phone ([`chat.md`](chat.md)); **on** by default — a read-only chat is the safe half of the feature |
| `chat.allowWrite` | whether the phone may **use** a `write` chat — one that can edit files and run commands. **Off** by default, and there is no way to turn it on from the phone: that is the point (§ What the bot does not do). Checked at every send, not just at `/mode`, so a chat switched to write in the browser is still refused from the phone. The web UI can always do it |

`digest` is a sibling of `notify`, not an eleventh notify class, because `/mute` flips every class at once and muting event pushes for an afternoon must not silently cancel tomorrow's digest.

Validated on load. Type errors throw (`telegram.pollTimeoutSec must be an integer in 1..50`); `enabled: true` with a missing token or user id does **not** — that would take the whole server down, and under the front door into a respawn loop, over the one subsystem that is optional. The bot refuses to start and says which key is missing.

A config file written before this block exists gets the defaults; the block is merged field by field, so a partial one does too.

**Boot log**, always one line:

```
telegram: bot disabled (data/config.json telegram.enabled)
telegram: bot enabled, answering user id 123456789 only
telegram: connected as @your_bot
telegram: enabled but telegram.botToken is empty — bot NOT started (docs/telegram.md)
```

### Three pieces of bot state in the DB

`tm_config` key `telegram.updateOffset` — the polling cursor, which has to survive a restart or every pending update replays.

`tm_config` key `telegram.digestSentOn` — the local calendar **day** the daily digest last went out (§ Reports). A day and not a timestamp, so a restart cannot re-send and a slept-through hour can still catch up.

`tm_config` key `telegram.digestArmedAt` — the **instant** the digest's current (`enabled`, `hour`) pairing became active. The two together are what let the digest be re-timed from a phone without skipping a day or firing twice; neither alone is enough (§ Reports).

All three are bot state, not knobs: they are deliberately absent from the `PUT /api/config` schema, and the settings page only sends keys it changed, so nothing in the UI can clobber them. Secrets stay in `config.json`; state that changes on its own stays here, because rewriting the file that holds the bot token on a timer is not a trade worth making.

## Notifications

`notifications.ts` subscribes to the same in-process `broadcast()` bus that `/ws/events` fans out to browsers (`server/src/events.ts` — `onEvent()`), started after the boot drain so the "back online" message is the first thing the phone hears, stopped with the bot. The bus is **live-only**: events fired while the bot is down are not replayed — the boot message plus `/status` are the catch-up story.

### Event → message

| bus event | condition | class | message (buttons) |
|---|---|---|---|
| `task.updated` | status became `review` with a **settled** `reviewState` (`passed`/`flagged`/`skipped`/`error`/null), or the state settled on a task already in `review` (see below) | `review` | 📋 title `id8` is in **review** · ✓ reviewed by <model> — clean / ⚠ review flagged N issue(s) / bare when the change was never auto-reviewed; then the task's `error` when set (⚠ the failed-publish reason), else the reviewer's overall **summary** of the work, else the worker's `resultSummary` — clipped to 1500 chars (**Mark done / Publish / Proceed**) |
| `task.updated` | a **requested** review (`/review`, 🔍, the SPA's Review now) settled on a task NOT in `review` (`done`/`failed`/`blocked`) — asked of the orchestrator at the settling broadcast, so an automatic round on an autoComplete `done` task stays silent | `review` | 🔍 title `id8` (status) was reviewed · verdict; then the reviewer's summary. No buttons — the status was deliberately left alone |
| `run.needs-attention` | the event carries a RAISED flag, and at flush the run is still `running`, not idle and still flagged | `attention` | ✋ title **needs attention** — the agent is waiting on a prompt |
| `question.updated` | status `pending` — sent at once, NOT coalesced and NOT gated by the notify flags: an agent is blocked on it ([`questions.md`](questions.md)) | — | ❓ title **asks you**: one message per question with the options as buttons (`q:` namespace), `✔ Done` on multi-select, `✍️ Other…` for free text; answered in the browser → ✅ summary; expired → ⌛ with the reason |
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
- **The review-fix loop stays quiet, on the row.** The Stop hook moves the task to `review` and only then fires the adversarial reviewer, which takes minutes — so the entry ping alone would arrive verdict-less (or worse, wearing the PREVIOUS round's badge), and every fix-round re-entry would ping again. The task row now says where the review stands (`reviewState`, written in the same row write as the status — `docs/design.md` § Adversarial review), and the notifier keeps a last-seen review-state memory next to its status memory: an entry into `review` that reads `pending`/`reviewing` is **not announced**, and the `task.updated` that settles the state (on an unchanged status) is what marks the ping. One verdict per change, whatever the number of bounces: `review`+pending → `running`+fixing → `review`+pending → `review`+flagged is one message. No polling and no retry budget any more — a reviewer that dies with the server leaves `pending`/`reviewing` behind, which boot recovery re-runs, and the settling update pings as usual. Entry paths that never run a review (a worker that exited 0 before its Stop hook, a split parent rolling up, a failed publish landing) carry a null state and ping immediately, bare. The verdict clause is built from the row (`reviewClause`: latest round's model and findings) rather than from the `run.reviewed` audit event, and only for a state the reviewer settled on THIS change — a publish landing or a re-run with review off shows no badge, because a leftover "✓ clean" next to live Publish buttons invites shipping on the previous round's verdict.
- **Needs attention is re-read against the live run.** `run.needs-attention` is broadcast for the CLEAR as well as the raise (Stop, and now the agent moving past an answered prompt — `docs/design.md` § Worker invocation), so the notifier marks only an event whose run carries `needsAttention: true`, and at flush re-reads that run: still `running`, not idle, still flagged, or nothing is sent. A prompt answered inside the 5s window is no longer reported as if it were still waiting, and one answered a minute ago no longer shows in `/status` or the reports either, because the flag itself is gone.
- **Mute is honoured late.** The class switches are read at flush time, so `/mute` also silences what was already in flight.

Transition detection is a last-seen-status (and last-seen-review-state) memory primed from storage at start — without priming, the first broadcast about a pre-existing task (a title edit on something sitting in `review` since before boot) would read as a transition and ping the phone about old news. Same-status broadcasts are content edits and stay silent. The queue-drained check arms itself when it sees queued/running work and fires once per drain, not once per event; the usage watcher compares consecutive snapshots, so thresholds re-arm automatically when a window resets.

### Buttons

Inline keyboards ride the **last** chunk of a message. `callback_data` is a `<ns>:<verb>:<id>` string — `p:acc:<n>:<id>` for the option-choosing accept, the one action that carries a parameter (Telegram caps the whole thing at 64 bytes); codec and dispatch table live together in `actions.ts` so a button cannot be added to one without the other, and an option segment on any other verb parses as null rather than being guessed about.

A `solution_options` proposal is a **choice, not a confirmation**: storage resolves an index-less accept as option 0 and appends that option's approach to the task description as the chosen one. So the notification renders every option in full, the keyboard offers one accept button per option (never a bare Accept), and the action layer refuses an index-less accept on any proposal that has options — from a button *or* from a future command — with "pick one with its own button". The confirmation names the chosen option. A press is gated exactly like a message — the presser's id must be the allowlisted one, and, when the carrying message survived Telegram's 48h window, its chat must be the owner's private chat; anything else is dropped in silence and counted. The press is answered with a toast (`answerCallbackQuery`), audited as `telegram.command` (`command: 'button:<kind>'`) **before** the answers, and then — **on a board or a card**, recognised by the 🔄 button its own keyboard carries (`l:f:` for a board, `l:r:` for a card) — the SAME message is redrawn with the new row and the keyboard its new status allows, the outcome (`✅ …` / `⚠ …`) riding the toast instead of a second message. Anywhere else (a notification, a `/kill` listing) it is confirmed with a message as before, and when **every** action button on the pressed message targets the one id that just succeeded (a review ping, a proposal, a feature plan) that message's keyboard is swapped for what the new status allows, or removed — so an old ping never offers a Publish the task is past. A keyboard naming several things is left alone.

The actions behind the buttons are the same in-process moves the REST routes make, with `actor: 'telegram'`: **Mark done** = `review → done` (+ close sessions, resolve the parent/feature), **Publish** = the task's own session commits and pushes (landing decided by git, so the `published`/`review` outcome arrives as its own notification), **Proceed** = resume the task's previous claude session, **🔍 Review** (on a `/task` card for a `review`/`done`/`blocked`/`failed` task with a repo, hidden while a round is pending/reviewing/fixing) = run the adversarial reviewer now, **Accept/Reject** = the proposal decision, **Approve & start** = feature `proposed → approved → running` in one tap — the visual plan check already happened when the analysis report was read.

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
- **The destructive commands are two-step, nonce-gated and rate-limited** — § Emergency controls. Nothing there is a new authorization surface: a confirm button is an ordinary `callback_query` and goes through the same single-user gate as everything else, which is why a stranger holding a leaked nonce still gets silence.

## Audit

`tm_events` rows, always `actor: 'telegram'`.

| kind | when |
|---|---|
| `telegram.command` | a command handled for the owner: `{ command, ok, args }`; `{ command, known: false }` for an unknown one; `{ command, ok: false, error }` when the handler threw; `{ command: null, ignored }` for a non-text or free-text message the owner sent; `{ command: 'button:<kind>', target, ok }` for an action button; `{ command: 'button:flow:<kind>:<step>', value, ok }` for a wizard press; `{ command: 'flow:<kind>:<step>', ok }` for a typed flow answer; `{ command: 'button:confirm:<kind>', ok }` for a spent confirm window (`cancelled: true` when it was the Cancel half) and `{ command: 'button:confirm', ok: false, error }` for one that had already expired |
| `telegram.rejected` | a **summary** of dropped updates: `{ dropped, totalSinceBoot, distinctUsers }` |
| `telegram.killall` | the red button fired: `{ queueWasEnabled, killed[{runId, taskId, mode, title}], killFailed, cancelled, cancelFailed, paused, dispatchesCancelled, headlessStopped, resweptSomething, idle }`. Each cancelled dispatch additionally writes its own `task.dispatch` row (`{ phase: 'cancelled', by: 'killall' }`) against the TARGET task, the same shape `POST /api/dispatches/:id/cancel` writes |
| `telegram.restart` | a restart asked of the front door: `{ force, hostPort, supervised }`, written **before** the request, because the answer can arrive after this process is gone |
| `telegram.bot` | `{ event: 'started', username, discardedAtBoot, bootMessageSent, offset }` / `{ event: 'stopped', offset, reason }`, where `reason` is `shutdown` or `fatal` — a bot that stopped itself on a bad token still writes its row; `{ event: 'digest', day, hour }` when the daily report went out (§ Reports) |

Rejections are summarised rather than logged one row each: otherwise anyone who knows the bot's name could write to `tm_events` at will. The first rejection after boot goes through immediately — "someone found the bot" is not news that waits ten minutes — and the rest are batched at one row per ten minutes, plus a flush on shutdown.

Board navigation — a tab, a repo chip, a page, opening a card, 🔄, opening a question/proposal/plan from a row — writes **no** row (§ The board): those are reads. The action buttons on a board or card are ordinary `button:<kind>` rows.

A command is audited **before** its answer is sent: the row records that the server acted, which stays true even if Telegram then refuses to deliver.

`ok` is the **write's** outcome, not "the handler returned" — on a flow row and on a command row alike. A refused edit or a refused on-create queue move still produces a perfectly good sentence to send (`⚠ …`), and an earlier version reported those as `ok: true` with a "Created"/"OK" toast — an audit trail recording a success that did not happen. The toast, the message and the row now all come from the same `StepResult.ok`.

Commands were the last surface where this was not true: `dispatch()` distinguished only "threw" from "returned", so `/enqueue` on a running task answered `⚠ cannot enqueue from status 'running'` and audited `ok: true`, while the identical refusal pressed as ⏳ Queue audited `ok: false`. Handlers now return a `Reply` carrying `ok` (`say()` propagates `ActionOutcome.ok`), so querying `tm_events` for "did `/publish` publish?" gives the same answer whether the owner typed or tapped.

The `telegram.command` row is only the *transport* half. The action itself writes the domain rows it always wrote — `task.created`, `task.transition`, `task.edited`, `task.queue`, `proposal.decided`, `orchestrator.toggle`, `run.killed` — with `actor: 'telegram'`, because the bot calls the same service functions the routes do. Nothing the bot can reach is audited only as "a Telegram command happened".

## Messages

HTML parse mode. Everything interpolated goes through `escapeHtml` (`& < > "` — the last one matters inside an `href`; `'` is safe to omit only because every attribute here is double-quoted). `sendMessage` chunks at Telegram's 4096-character limit, preferring a newline boundary; a hard cut backs off rather than bisect an entity or a tag.

Each chunk is parsed by Telegram independently, so a tag pair may not span one. Rather than make that a rule callers have to remember, the chunker **closes any tag left open at a cut and reopens it** (attributes and all) at the head of the next chunk — a report with a 6000-character line would otherwise come back `Unmatched start tag` and be lost entirely. What chunking does not preserve: trailing whitespace on a chunk, and the newline it was broken at.

Link previews are disabled: a repo path or URL in a status line should not become a card.

**Edits are not chunked.** The board and the card redraw an existing message with `editMessageText` (`editMessageReplyMarkup` swaps only the buttons), both on the same `call()` path as `sendMessage`. One message has to stay one message, so the renderers clip themselves to fit (retrying at narrower widths, because escaping can grow a clipped field fivefold), and the redraw **falls back to a fresh send** whenever the edit cannot happen: the pressed message aged past 48h (Telegram then delivers an inaccessible stub with `date: 0`), the text would not fit, or Telegram refuses the edit for any other reason. The one refusal that is NOT a fallback is `message is not modified` — a 🔄 on a board where nothing moved — which is the redraw having nothing to do.

## Commands

Registered with `setMyCommands`, so they autocomplete in the client. The tables below are the whole surface; `/help` renders the list from the same array the router looks up, so the two cannot drift.

### Orientation

| command | answers |
|---|---|
| `/start` | what the bot is — and it hands out the persistent bottom keyboard (§ The board) |
| `/help` | the command list, generated from the router table |
| `/status` | queue on/off, agents `n/m` (+ aux sessions), the three usage windows with `resetsAt`, queued (and custom-queued) count, tasks in review, needs-attention runs, uptime, and the discarded/rejected update counters |
| `/repos` | every registered repo — short id, name, open-task count, path |
| `/shared` | per shared space (`docs/shared-spaces.md`): its folder and the open/filed cross-repo requests, oldest first (≤ 20 each), `from → to` and the filed task's short id and status; a filing whose task is `failed` or a `draft` gets ⚠️ and a "needs you" line (`SHARED_FILING_STALLED`). Read-only — the ledger is managed on the dashboard's Shared page |
| `/tasks [inbox\|open\|status\|repo\|text]` | **the board** — one message that redraws itself in place (§ The board). No argument = the triage **inbox**; `open` = every open task; a task status = that tab (`running` is the live tab, which also holds `waiting`); a repo (by name, then id prefix) = its open tasks with that repo chip on; **anything else is a case-insensitive title search** |
| `/now` | the live tab of the board: each running/waiting task with its last activity line (tool call or narration), elapsed time, context % and cost, and its ✖ kill / ❓ answer buttons |
| `/task <id>` | one task as a **card**: status with its markers, repo, category, description, the resolved model/effort/review/auto-publish (naming the preset when they match one), its custom-queue standing, feature and phase, result summary, review summary, error, and — when a session is live — its activity line and stats. Buttons: what its **current status** makes possible, ❓ Answer / ✖ Kill run when they apply, then ◀ back and 🔄. Long fields are clipped so the card stays one editable message |
| `/queue` | the custom queue: the **waiting** members numbered `#1…#n` in the order they will run, then — listed apart, because they have no position left — any member that is running, waiting, blocked or in an open auto-review and so still holds its repo's place (a member whose review settled is the human's and is not listed; a member held by Undo start is marked ⏸ held) |
| `/features` | every feature: status, repo, phase/task counts, error |
| `/proposals` | pending agent proposals with their ids and rationale |
| `/kill` | with no argument, the live runs and their ids, one **✖ kill** button each |

### Tasks

| command | does |
|---|---|
| `/new [text]` | the creation flow: repo picker → title → description (skippable) → **preset** (Small / Routine / Complex / Codex, or ⚙ Custom → model → effort → review → reviewer model, skipped when review is off) → auto-publish → **On create: 📝 draft / ⏳ queue / ➕ custom queue / ▶ run now**. With text after the command the first line seeds the title and the rest the description, and those two steps are skipped |
| `/edit <id>` | field picker → the new value. Title, description and category are typed (send `-` as the category to clear it); repo, model, effort, review, reviewer model and auto-publish are keyboards. One field per `/edit`. **Repo is on that list deliberately**: a task can arrive repo-less (the REST body allows it, and agents and proposals create them that way), every run path then refuses with "assign a repo before running this task", and without this field the phone had no way to act on that refusal |
| `/enqueue <id>` | into the global queue (`draft`/`failed`/`cancelled`/`review` → `queued`) |
| `/run <id>` | run now, jumping the queue |
| `/questions` | everything the agents are waiting on you to decide, with the option buttons again ([`questions.md`](questions.md)) |
| `/cancel <id>` | de-queue, or kill the session and cancel |
| `/undo <id>` | Undo start: stop a running task and put it back where it was before the turn — a queued task keeps its place, held (`docs/queue.md` § Undo start); the card shows ↩ Undo start on a running/waiting task |
| `/release <id>` | let the queue take a task Undo start held; the card shows ▶ Release on a held task |
| `/retry <id>` | re-queue a `failed`/`cancelled` task |
| `/unblock <id>` | `blocked` → `review` |
| `/review <id>` | run the adversarial reviewer NOW over the task's current diff (`review`/`done`/`blocked`/`failed`; the unchanged-diff gate is bypassed, `review already in progress` while a round runs — `docs/design.md` § Adversarial review). Replies at once; the verdict arrives as the review ping (a task in `review`), or as a 🔍 verdict line for one parked elsewhere, whose status is left alone |
| `/complete <id>` | `review` → `done`, closing the task's terminals |
| `/publish <id>` | commit and push in the task's OWN session (`docs/publish.md`); the landing status arrives later as its own notification, decided by git |
| `/proceed <id> [text]` | steer the task with an instruction. **Without text the bot asks for it** rather than resuming with the generic "carry on" — the reason to reach for `/proceed` from a phone is that you have something specific to say. Whether a claude session survives decides *which* move runs, never whether the instruction is collected: with one it resumes that session, without one it starts a **fresh worker carrying the message** (`followUp` mode `auto`, the web drawer's "Send follow-up" behaviour) and the prompt says so up front. `/run` is not the fallback — it spawns off the task description and would throw the typed instruction away |
| `/queue add\|remove <id>` | the serial custom queue (`docs/queue.md`), independent of `/on` `/off` |

### Proposals, features, orchestrator

| command | does |
|---|---|
| `/accept <id> [option]` | accept a proposal. The option number is **1-based**, matching the listing; an options proposal refuses an index-less accept (see § Buttons) |
| `/reject <id>` | reject a proposal |
| `/feature [text]` | the feature intake: the long request (typed, or given after the command) → repo picker → the feature is created and the planning session starts immediately. The plan comes back through the notification path with an **Approve & start** button |
| `/approve <id>` | the same approve-and-start as that button, by id |
| `/on` / `/off` | start / stop picking tasks. `/off` is the soft one: live sessions keep running, and it says **how many** (`/kill` ends one, `/killall` ends all) |
| `/kill <run id>` | kill a live run |
| `/killall` | the red button — see § Emergency controls |
| `/restart` | restart the server through the front door — see § Emergency controls |

### Bot

| command | answers |
|---|---|
| `/notify` | the event classes with their on/off state; `/notify <class> [on\|off]` sets one (no value = toggle) |
| `/mute` / `/unmute` | all classes off / on — commands still answer while muted |
| `/report` | an HTML report as a file — `/report [24h\|7d\|task <id>\|feature <id>\|group <id>]`, empty = 24h (§ Reports) |
| `/digest` | the daily 24h report — `/digest on\|off [hour]`; no argument reports the current state |

The toggles mutate the live config **and** persist to `data/config.json`; when the write fails, the reply says so and the toggle still holds until restart.

### What the bot does not do

The SPA can issue roughly 38 distinct mutating endpoints; the bot reaches 19. What is missing is missing on purpose, and it falls into three groups:

- **Needs a keyboard and a screen.** Registering or editing a repo (an absolute filesystem path typed correctly), the six repo-command endpoints (`docs/commands.md` — saved command lines, also argv-tokenised), `PUT /api/config` (the settings page), and editing a feature's plan card by card before approval. These are laptop jobs; getting them wrong on a phone is worse than not having them.
- **Is the terminal, or reaches it.** The PTY WebSocket is the code-execution surface and the bot deliberately does not expose it — that is the security posture, not an omission. `stop-agent` and task file upload/download sit next to it and stay off too. **Amended 2026-09-05 by `/chat`** ([`chat.md`](chat.md)): a chat is a headless `claude -p --resume` conversation in a repo, and in `write` mode it can edit files and run commands — a code-execution surface by any honest reading. It is therefore off by default from the phone and turned on once, at the keyboard, with `telegram.chat.allowWrite` in the config file that already holds the bot token. Read-only chats need no opt-in. **The flag is enforced at the send, not only at `/mode`** — otherwise a chat switched to write in the browser and left there would be a fully-armed surface for an unlocked handset that never typed `/mode` at all — and `/chat` will not silently resume a write chat the phone may not use. The agents' own terminals are still not exposed.
- **Has no phone-shaped use yet.** Deleting a task, `POST /api/analyze`, cancelling a dispatch, per-repo git commit/push, sentry sync, group name/colour, and six of the nine feature verbs (`pause` `resume` `cancel` `complete` `start` and re-analyse — `/feature` and `/approve` cover intake and the decision, which are the two a phone actually wants).

If one of these turns out to matter in daily use, it is a small addition: the action layer and the flow engine are already there.

### Emergency controls

Two commands can destroy work, so neither of them fires on a single press.

| command | does |
|---|---|
| `/off` | **the soft stop.** Stops picking new tasks; live sessions keep running, and the reply says how many so "it's off" is never mistaken for "it's quiet". `/on` resumes |
| `/kill <run id>` | one session |
| `/killall` | **the red button.** Stop the queue → pause running features → cancel queued tasks → kill every live run (workers AND aux sessions) → stop any aux session still live. Behind a 60-second confirm |
| `/restart` | restart the server through the front door, honouring `restart-check`. Behind a confirm; **force** is a second, separately labelled one |

#### What `/killall` does, in that order

The order is the argument:

1. **stop the queue**, so nothing new is claimed while the rest runs;
2. **cancel every pending dispatch, before anything is killed.** This is the leg that is easy to miss and the only one the queue switch cannot cover: dispatch delivery is *deliberately* exempt from `orchestrator.enabled` (`docs/dispatch.md`), it runs on every scheduling pass including the `!enabled` branch and the unconditional 10s safety tick, its hold list is `running`/`queued`/`blocked` — so a **`cancelled` target is not held** — and `followUp` accepts `cancelled`. Leave one pending and the sequence is: `/killall` kills task B's run and marks B `cancelled`; ten seconds later delivery finds B unheld, not busy, under concurrency, and resumes it with a fresh `claude` PTY. The machine the owner just emptied is running an agent again, and `☠️ All N killed session(s) have exited` has already gone out. The two-pass sweep cannot save this — kill exit handlers fire long after `sweep()` returns — so the fix is to remove the *cause* rather than to catch the effect;
3. **pause running features** — killing a task cascades through `resolveCompletion`, and a *running* feature answers that cascade by enqueuing its next phase, which would re-fill the queue behind us;
4. **cancel what is queued** — both queues: a custom-queue member also sits in `queued` (`docs/queue.md`), and the custom queue runs even while the global switch is off, so leaving it would leave the one queue `/off` cannot stop;
5. **kill every live run — all modes**, not just `worker` like the web button. The phone's `/kill` listing already shows every mode, and a red button that leaves an analysis burning tokens is a half-button;
6. **stop every aux session still live** (review, plan, chat, report, …) — the same `aux().stopAll()` the restart path calls. Most were already killed in step 5 as run rows; this catches one spawned in between, and the report lists only what THIS step stopped (`headlessStopped` keeps its field name in the audit row);
7. **sweep 2–5 once more**, because 5 and 6 both have exit handlers that write, and a Stop hook already in flight can still file a dispatch. Two passes, not a loop: a fixed bound cannot spin. What stops a *third* round is that every source of new work is now shut — the queue switch for claims, and leg 2 for the one path that switch does not cover. The report says when the re-sweep found something.

The reply is exactly what happened — run ids with their task titles, cancelled task titles, paused feature titles, cancelled dispatches (named by the task they would have resumed), headless labels — **and what was already idle**, so a short answer is never mistaken for a failed one.

The state is **re-surveyed at the press**, not reused from the list the confirm message rendered: up to sixty seconds pass in between, and the report has to describe what actually happened rather than what was predicted. The confirm message's lists are capped at 20 rows like every other listing in the bot, and the cap says so — `…and N more — all of them` — because a human confirming a truncated list must not think the tail is spared.

#### The confirm window

A destructive command does not act; it **arms a window**: one nonce, 60 seconds, and a Confirm/Cancel keyboard. There is at most **one** window in the whole bot — a `/restart` typed while a `/killall` confirm is open is refused and told which one is open and how long it has left. Both live in memory, in a store deliberately separate from the conversational flow store: a command *drops* the live flow, and a `/killall` whose confirm evaporated because the owner typed `/status` while reading the list would be a red button that quietly stops working.

Pressing Confirm **consumes** the window, and that single fact answers the two things worth probing:

- **A stale or duplicated update cannot fire a kill twice.** Telegram redelivers an update whose offset was not advanced, and a double-tap can arrive as two `callback_query` updates. The second one finds an empty store and is answered `⌛ That confirm has expired, was already used, …`. The offset is persisted *before* the update is handled, so a redelivery is unlikely; the consuming `take()` is what makes it harmless when it happens anyway.
- **A server restart mid-confirm loses the window, in both directions.** It lives in memory, so it dies with the process — and the boot drain treats a `callback_query` as undatable and therefore stale (`§ Boot discard`), so a Confirm pressed *before* a restart is discarded rather than replayed into the new process. Two independent guards, and the harness drives the second one by pressing a pre-restart nonce against a freshly constructed bot.

The nonce is also the only thing on the wire: the window's **kind** is held server-side, so a captured `k:go:<nonce>` cannot be re-pointed at a different action, and a nonce armed for `/killall` cannot fire a `/restart`. Confirm buttons live in their own `k:` namespace, parsed *before* the stateless action codec for the same reason wizard buttons are — these expire, and an expired one must be refused rather than fall through to something that still means what it says. (`t:`/`p:`/`f:`/`r:` parse by lookup in a wire map that has no `k:` entry, so the three codecs cannot collide; there is a comment on that map saying so.)

Cancelling costs nothing: it destroyed nothing, so it burns no rate-limit slot.

#### The rate limit

Two fences, because they catch different mistakes:

- **60s between two executions of the same destructive command.** This is the human-retry fence — "did that work? let me do it again" is, on a red button, exactly the press that kills the session the first one spawned in its place.
- **5 destructive executions per 10 minutes**, across all of them, for everything else.

Checked when the window is **armed**, recorded when it **executes**. Refusing at the press would mean the owner read a list of what was about to die, tapped Confirm, and got a cooldown notice instead — the worst possible moment to be told no. A `/killall` on an already-quiet machine answers `Nothing to stop` and arms nothing, so it neither spends the one window nor starts a cooldown.

The counters are in memory, like the window: a restart is not a limit the owner is trying to evade, and persisting it would mean the first `/killall` after a crash is the one that gets refused.

#### "Killed" is a signal; "exited" is the follow-up

`killRun()` returning true means the process was *told* to go, the run row reads `killed` and the task reads `cancelled` — none of which is the process being gone. The proof is a real exit, and `KillWatcher` is the only thing in the bot that waits for one.

There are **two** exit signals, because there are two kinds of run:

- a **PTY** run announces itself on the event bus — `run.exited`, broadcast from `Orchestrator.handleExit` when node-pty reports the child dead (and again, for the idle Stop-hook path, from `routes/internal.ts`; the watcher tolerates the same id twice);
- *(until 2026-09-24)* a **headless `analyze`** run had no PTY and therefore nothing on the bus at all. Since then every aux session is a PTY and broadcasts `run.exited` like a worker, so `onHeadlessRunExit` is gone and the bus is the whole signal. The history: `killAnalysis()` SIGTERMs an `execFile` child and broadcasts nothing; the run row is updated by whatever awaited the child, which is not the same fact and is not an event. Since `/killall` kills every mode, waiting only on the bus meant every killed analysis was reported as a 60-second straggler that had in fact died instantly. `claude/analyze.ts` now exports **`onHeadlessRunExit()`**, fired from the one place that already knows — `trackHeadlessChild`'s own `child.on('exit')` handler, the single chokepoint for both `/analyze` and feature-plan children. The watcher subscribes to both. So `/killall` sends **two** messages: the report of what was signalled, then `☠️ All N killed session(s) have exited` once they actually have. After 60 seconds it stops waiting and names the stragglers instead of claiming a clean sweep.

The watcher is armed **before** the kills go out, not after: a pty can exit inside the same tick that signalled it, and an exit landing before the watcher was listening would leave the follow-up waiting for an event that had already happened. It collects every exit it sees from the moment it is armed and subtracts the ones that already landed.

#### `/restart`

`/restart` calls the **same `restartGuard` closure** the REST route calls — handed to the bot by `index.ts`, never restated. Three surfaces (the header button, the front door, the phone) must give one answer to "are agents working?", and two copies of that rule is how two answers drift; `docs/host.md` makes the same point about `/host/stop|restart` forwarding the check verbatim.

- **Guard clear** → a plain confirm, then the restart.
- **Guard blocked** → the reason is reported *verbatim*, with the numbers behind it (running sessions, aux sessions, and the repo commands that will be stopped even though they do not block), a pointer at `/killall` as the clean way to empty the machine, and a button labelled **⚠️ Restart ANYWAY (force)**. Force is only ever reachable through a window armed as `restart-force` — i.e. after the guard has already refused once and the owner pressed a button that says what it does.

Execution is `POST /host/restart` on the **front door** (`docs/host.md`). That is not the forbidden self-call: the front door is a different process, and there is no in-process function that can restart a process from inside itself and still be supervised afterwards. Two header rules, both mirroring what `host.ts` does in the other direction — `Host` must be the loopback origin of the port being called (its DNS-rebinding guard) and `Origin` must be **absent**, because that guard only judges an Origin that is present and inventing one would put this call under a rule written for browsers.

The "restarting now" message is sent **before** the request, because the front door answers by killing this process. Three outcomes:

- `200` → done; the boot notice is the confirmation.
- `409` → the front door's own guard refused; its reason is shown.
- a socket error **after** the request went out → the ordinary case, and a **success**: the answer we would have read died with us. Only `ECONNREFUSED`, which happens at connect time, is reported as a failure — with the real cause, that this API was started on its own (`npm run start:api`) and has no front door to ask.

`TM_SUPERVISED` is recorded in the audit row but does not change behaviour: an unsupervised API can still have a front door that adopted it (`api.managed === false`), which forwards to `POST /api/server/restart` and works, so warning on the flag would be misleading.

### Short ids

Nobody types 36 characters on a phone, so **every `<id>` above accepts a prefix** — the 8-character form `/tasks` and `/task` print. The rules are strict in both directions on purpose, because guessing here means running the wrong agent in the wrong repo:

- an exact id always wins outright;
- a prefix shorter than **4** characters is refused as too short rather than resolved;
- a prefix matching more than one row is an **error naming the candidates** (up to six, then "and N more"), never a pick;
- case is ignored and a leading `#` is stripped;
- `/kill` resolves against **live runs only** — a finished run cannot be killed, so matching a week of exited rows would turn every short id into an ambiguity error for no reachable outcome;
- repos additionally resolve by exact name (`/tasks alpha`), because nobody remembers a repo uuid either;
- board buttons (`l:`) carry the 8-character form and resolve through the same rules at press time — a stale or ambiguous one is a toast, never a pick (§ The board).

## The board

`/tasks` (and `/now`, and the 📥 / 👀 / 🏃 bottom-keyboard buttons) is a phone dashboard: **one message that redraws itself in place** (`telegram/board.ts`). Every read goes through in-process services — storage, `Orchestrator.status()`, the activity watcher's `snapshot()` — never HTTP and never the PTY.

**Layout.** Top row: six filter tabs — 📥 inbox · 🏃 running · 👀 review · ⏳ queued · 📝 draft · ⚠ failed — each with its count, the active one marked `•`. Second row(s): repo chips (🌐 all plus up to five repos with open work, busiest first), shown when there is more than one repo to choose from. Then one row per item on the page — its **number and title open it**, action buttons beside it — then `‹ n/N › 🔄` when there is more than one page (8 rows per page), or `🔄 Refresh`. A 40-button page is the worst case, far under Telegram's 100.

**The inbox** is triage order, each group with its own buttons:

| # | what | buttons |
|---|---|---|
| 1 | tasks with an open question ❓ | ❓ Answer (sends the question with its option buttons) |
| 2 | running tasks whose run needs attention 🔔 | ✖ Kill |
| 3 | tasks in review — `flagged` verdicts 🚩 first | ✅ Done · 🚀 Publish |
| 4 | blocked tasks | ⛔ Unblock |
| 5 | failed tasks updated in the last **7 days** (older ones stay on the ⚠ tab) | 🔁 Retry |
| 6 | pending proposals | ✅ Accept (only when the proposal has **no** options) · ✖ Reject; the title sends the proposal in full, with one accept per option |
| 7 | proposed features | ✅ Approve; the title sends the plan report |

A task appears once, in its first group.

**Markers**, mirroring the SPA's `StatusBadge` (a row has room for several at once): the status icon, then ❓ asks you · 🔔 needs attention (a live, non-idle run flagged on a `running` task — the Board page's rule) · 🔍 auto-review (`review` + `pending`/`reviewing`) · 🔧 fixing · 🚩 review flagged · ➕ custom queue. The card spells the first two out.

**The live tab** (🏃, and `/now`) heads with `workers n/m · queue on|off · k aux` and gives each running or waiting task its last `RunActivity` line (🛠 a tool call, 💬 narration), `⏱ elapsed · ctx % · $cost` from the run's `RunStats`, and ✖ Kill / ❓ Answer. Stats are what the orchestrator's 20s refresh last wrote; there is no polling — press 🔄.

**Cards.** A row opens the task's card IN the same message, with ◀ back to exactly the board state it came from (tab, repo chip, page) and 🔄. An action on the card redraws the card (§ Buttons). `/task <id>` sends a card whose ◀ goes to the inbox.

**Search.** `/tasks <text>` that is neither a status nor a repo is a case-insensitive title search. The text cannot ride a 64-byte button, so the bot remembers the last search in memory (one user, one search) and the search view's pages and chips re-read it; after a restart that view says to search again.

**The `l:` namespace.** `l:v:<view>:<repo>:<page>` navigate · `l:f:…` the board's own 🔄 · `l:o:<task>:<view>:<repo>:<page>` open a card · `l:r:…` the card's own 🔄 · `l:a:<task>` send its questions · `l:p:<id>` a proposal · `l:e:<id>` a feature plan · `l:x` the page counter (answered silently). Parsed in `bot.ts` after `w:` `k:` `c:` `q:` and **before** the action codec, built only through `encodeList` (which throws on anything over 64 bytes). Ids are the **8-character short form**, resolved through `ids.ts` at press time — so a press on a task that is gone toasts `no task starts with …` and redraws the board it came from, an id prefix shared by two tasks toasts the ambiguity and opens neither, and a malformed `l:` string (an id under 4 characters, an unknown view, a 4-digit page) parses as nothing and falls through to "Unknown button". A repo chip whose repo is gone is dropped; a page past the end clamps to the last.

**Navigation is not audited.** A tab, a chip, a page, a card, a 🔄, opening a question/proposal/plan — none writes a `telegram.command` row; they are reads, and a row per tap would bury the mutations. The action buttons on the board and the card are the ordinary action codec and are audited exactly as before. A typed `/tasks` or `/now` is a command and is audited as one, as every command is.

**The bottom keyboard.** `/start` sends a persistent reply keyboard — `📥 Tasks · 👀 Review · 🏃 Now` / `❓ Questions · 📊 Status`. Its buttons send their label as text; `bot.ts` maps the **exact** labels to `/tasks`, `/tasks review`, `/now`, `/questions`, `/status` before parsing, so they behave (and are audited) as those commands, winning over a flow or chat mode just as a typed command does. Anything else — including a label with more text around it — stays free text.

**Not done**: the review ping is not edited into its final state when the task later moves on by some other path (that would need the notifier to remember message ids per task); the keyboard retirement above covers a press on the ping itself.

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

The `/new` flow offers the same presets the web form does (`taskPresets(settings)` in `shared/src/types.ts`, one source for both surfaces) — Small, Routine, Complex, Codex (free), then the user's custom presets from Config → Presets (`presets.custom`, read from storage when the keyboard is drawn and again when a button is pressed, so a preset deleted in between is refused as `Unknown preset` rather than applied from a stale copy; custom ids are `p-xxxxxxxx`, well inside the `w:` value slot and never the literal `custom`) — each resolving model + effort + review in one tap. The `/task` card's preset label matches against the same list. ⚙ Custom asks for the three separately, each with a `default (config)` option that writes `null` and falls back to the `agent.model` / `agent.effort` / `review.enabled` settings, exactly as the web dropdowns' "default (config)" does. After review, Custom asks for the **reviewer model** (`w:<seq>:rmodel:<index>`), unless review was set to `off`, since nobody would review. `default (config)` writes `reviewModel: null`, which means the global `review.model`. Presets never set a reviewer, so a preset-built task keeps `null` and `matchTaskPreset` still labels it. `/edit` offers the same keyboard as `Reviewer model`. The `/task` card prints `reviewer <model>` (plus the reviewer effort when one is set) on the model/effort line, except when review is off for the task. The reviewer effort is web/REST only, because the phone flow is already long enough.

`➕` means the **custom** queue everywhere in the bot — the marker on a queued row in `/tasks`, the `/task` standing line, `taskActionKeyboard`'s buttons and now `/new`'s on-create step, where the global option wears `⏳` instead. `/new` previously offered `➕ Add to queue` for the *global* queue, which is the one that stops when `/off` is set: the opposite of what the symbol promises next to a serial queue that ignores it. `/new` can now reach the custom queue at all, which it could not before — it took a follow-up `/queue add`.

**Auto-publish is always its own step**, on both the preset and the custom path. Presets do not carry it (the web ones do not either), and it is the one parameter that decides whether work reaches `origin` without a human looking, so it is asked rather than defaulted silently.

The model picker is a shortlist (`MODEL_OPTIONS` plus `codex-free`) even though the column accepts any string: a typo'd model id does not fail here, it fails at spawn time, hours later. The reviewer picker is `MODEL_OPTIONS` alone, because the reviewer is always `claude -p` and a Codex id cannot review.

## Reports

Long content is not a chat message. `/report` builds ONE self-contained `.html` file and sends it with `sendDocument`: Telegram renders it in its own in-app viewer, and the same file opens in any browser, offline, forever. `server/src/telegram/report.ts` is the only generator — `/report`, the daily digest and the feature-plan notification all call it, so there is exactly one report shape in the product.

### Nothing leaves the machine

**Telegraph was considered and rejected** (`docs/future/telegram-bot.md` § Reports, user decision 2026-09-01). A Telegraph page is a public URL, and these reports carry private work detail: task titles, repo names, error text, agents' result summaries, a week of what this machine was asked to do. Nothing leaves except the Telegram file upload itself.

That decision buys something back: the markup is no longer constrained to Telegraph's tag subset, so the report is full HTML and CSS. It also imposes a rule the generator is built around — **zero external assets**. No `<script>`, no `<link>`, no `<img>`/`<iframe>`, no `@import`, no `@font-face`, no `url()`. Every visual value is a literal resolved from the dark `--tm-*` set in `docs/tm-design-tokens.html`, declared as custom properties at the top of the inline `<style>` so the sheet stays the source of visual truth even though the file cannot link to it. `--tm-font-body` names "Inter" first and `system-ui` second; a report opened on a plane would fall through to the second entry anyway, so it asks for the fallback directly rather than pretending. A `<meta name="viewport">` and one `max-width` are the whole responsive story: it is read on a phone.

A URL that appears inside an agent's result summary is escaped **text** and fetches nothing. The rule is about positions the renderer would fetch from, not about the characters `http`.

### Escaping

Everything interpolated goes through the same `escapeHtml` the chat messages use, including the `<title>`. No task text ever reaches an attribute, and `"` is escaped regardless, so a title cannot break out of one. A summary written as markdown by an agent is turned into **prose** — headings lose their hashes, `**bold**` loses its asterisks, links keep their label and drop their target — rather than rendered as markdown: rendering it would mean deciding what to do with HTML an agent wrote, and stripping is the direction that cannot go wrong. It is also what the spec asks for, "a one-paragraph result summary", instead of `## The fix` printed literally on the page.

### Shape

Top to bottom, always, in this order:

1. **Краткое резюме по-русски** — 3 to 6 lines: what happened in the period and what needs a decision. It is first in the document *and* it is the message that carries the file, so the gist is readable without opening anything. Russian plural agreement is done properly (`1 задача` / `2 задачи` / `5 задач`); this is the part read at a glance on a lock screen and "5 задача" is the kind of wrongness that makes a report feel machine-made.
2. **Numbers** — tasks touched by status; **dispatches** (count, and one line each on what they were about); **reviews** (adversarial rounds, the verdict split, the finding count, and which tasks took more than one fix round); publishes; failures; usage consumed per window with `resetsAt`.
3. **Work done** — one card per task that moved: title, repo, a one-paragraph result summary, the review verdict.
4. **Next steps** — queued, custom-queued, in review, drafts; the next phase of every feature in flight; and everything waiting on the human (pending proposals, features awaiting approval, needs-attention runs).
5. **Problems** — failed tasks with their error, blocked parents, dispatch failures with the reason.

For a **feature scope** one more section is inserted between the Russian summary and Numbers: **Plan** — the analysis summary, the considerations, every plan-review round with its findings and their detail, and each phase with its goal and its planned tasks (title, description, effort/category, exit criteria).

It is there because a `proposed` feature has **no `tm_tasks` rows at all** — that is the whole point of the approval gate — so Numbers, Work done and Problems are all legitimately empty and the plan is the only content the document has. A report that answered "2 phase(s)" on the screen where a human is asked to approve work sight-unseen would say strictly less than the plain chat message it replaced. Those empty sections say why they are empty ("No task rows exist yet — see Plan above; approving it is what creates them") rather than "No tasks in scope", and the Russian summary says `план — 2 фазы, 2 задачи; статус ждёт утверждения` instead of `задач не затронуто`.

The Next-steps roll-up skips the feature the Plan section already rendered in full and points at it instead, so nothing is printed twice on one page.

A feature awaiting approval also reaches **period** reports now: `proposed` joins `running` and `approved` in the phase roll-up, where a phase with no rows reads `N task(s) planned, not created yet` — with its goal and the titles it would create — rather than `0/N done`, which reads like N tasks that failed to start.

### Scopes

| scope | covers |
|---|---|
| `/report` or `/report 24h` | the last 24 hours |
| `/report 7d` | the last 7 days |
| `/report <n>h` / `<n>d` | any window up to 31d — longer is an export, not a report, and every read here is unpaginated |
| `/report task <id>` | one task and its full run history |
| `/report feature <id>` | one feature: phases, plan-review rounds, roll-up |
| `/report group <id>` | one group |

Ids are the same short prefixes every other command takes (§ Short ids). A **group scope resolves from any member**, not just the root — typing the id of the task you happen to be looking at is the point.

For a period report, "next steps" is the whole board, because that is the question a daily digest answers. For an entity scope it is that entity's own work and **nothing else** — queued/draft/review tasks, pending proposals (by `taskId`), features awaiting approval, needs-attention runs and the feature phase roll-up are all gated on the same single flag, rather than each source deriving the rule for itself. `/report task abc` that lists three unrelated proposals and expands two unrelated feature plans is not a report about `abc`, and its Russian caption — the line read on a lock screen — would be asserting them of it. A scope with nothing pending says so ("Nothing is waiting on a decision", `Решений от человека сейчас не требуется`) rather than borrowing the board's.

### Where the numbers come from

Two of them are not where you would look first:

- **The review verdict split is a tally over `run.reviewed` audit rows** — one per round, structured, in the window. Since 2026-09-06 every real round is also persisted on the task (`tm_tasks.review_rounds`, `docs/design.md` § Adversarial review), so `verdictFor` reads the latest persisted round for a task whose audit row is older than the window before it falls back to parsing the badge out of the `review_summary` markdown.
- **Fix rounds** — the loop BUDGET counter lives in orchestrator memory, bounded by `review.maxRounds` (default 1); the history lives on the task. One `run.reviewed` row is written per round, so the count of rows for one task *is* its round count — **minus the rows carrying `skipped`**, which record a review that did NOT run (`'unchanged-diff'` when the diff hashes the same as the last verdict's, `'empty-diff'` on a clean tree — `docs/design.md` § Adversarial review). Those rows have no `verdict` and no `findings`, so the report excludes them from the round count and the verdict split and reports them on their own "reviews skipped" line; `verdictFor` looks past a verdict-less row to the real one rather than falling through to badge-parsing.
- **A publish is what `verifyPublished()` concluded**, so the count comes from the `task.publish` event with `phase: 'published'` — never from a task's current status and never from what an agent reported (`docs/publish.md`).

`listEvents` is hard-capped at 2000 rows by both drivers. A period long enough to hit it says so in the report's footer rather than quietly under-counting; an entity scope reads events per task instead, bounded at 200 tasks.

Three filters were added to storage for this and exist in **both** drivers: `TaskFilter.updatedSince`, `DispatchFilter.since`, `RunFilter.since`. A period report asks the DB for its window rather than reading every row and filtering in JS, so the cost of a 24h report does not grow with the age of the install.

### The file and the caption

The document goes out as one `sendDocument` with the Russian summary as its **caption** — one notification, file and gist together, not a message followed by a file. Telegram caps a caption at 1024 characters and refuses the whole upload past it, so an over-long summary is handed back by `api.ts` as `overflow` and sent as its own (chunked) message rather than truncated: the summary is the part that has to arrive whole. If the upload fails outright, the caption still goes out as a plain message.

`sendDocument` is the one Telegram call that is not JSON. It builds a `FormData` with a `Blob` — both globals on Node 22, which is what this module's "no new dependency" rule protects — and deliberately sets **no** `content-type` header, because `fetch` writes the one with the boundary it generated and a hand-written header loses it. It shares `request()` with `call()`, so the timeout, the abort wiring and the token redaction are written once.

Filenames are `tm-report-<scope>-<local timestamp>.html`, sanitised: Telegram shows the name verbatim and it lands on the phone's disk, so anything path-like or invisible is stripped.

### The daily digest

`/digest on` sends the 24h report every day at `digest.hour` local. The whole difficulty is deciding, for one calendar day, whether its slot is still owed — and the machine is a MacBook, so it sleeps, restarts, and has its settings changed from a phone mid-day. That rests on **two** facts, kept apart because they answer different questions and change at different times:

| state (`tm_config`) | means | changes when |
|---|---|---|
| `telegram.digestSentOn` | the last local day a digest actually WENT OUT | only on a successful send |
| `telegram.digestArmedAt` | the instant the current (`enabled`, `hour`) pairing became active | the digest is enabled/disabled, or the hour changes |

A slot fires iff it has been reached, its day is unsent, **and** the digest was already armed with that hour when the slot arrived.

One combined "day marker" was tried first and is the wrong shape, twice over: its meaning depends on the hour in force when it was written, so re-timing the digest from a phone skipped a day or fired twice. `armedAt` has no such dependency — it is a timestamp, compared against whichever slot is being judged. What the pair buys:

- **A restart must not re-send.** `sentOn` says today: silent, however often the API restarts.
- **A slept-through hour must still send.** Armed days ago, slot reached, day unsent → it catches up at 14:00 rather than skipping silently. `armedAt` is *persisted* for this reason: re-arming on every boot would cancel a catch-up that was owed.
- **`/digest on 21` at 14:00 sends TONIGHT.** Armed at 14:00, tonight's slot is 21:00, and 14:00 is before it — which is exactly what the reply promises.
- **`/digest on` at 22:00 with `hour: 9` waits for tomorrow**, rather than firing a minute later for a day the owner watched happen. Lowering the hour past "now" (`/digest on 9` at 10:00) is the same rule and the same answer.
- **Re-timing after the day already went out never produces a second digest**: `sentOn` is already today.
- **A late first boot behaves like a late enable**: booting at 07:00 with `hour: 23` still sends that night; at 22:00 with `hour: 9` it does not fire for that morning.

The day is recorded **only after a successful send**, which is why the digest calls a variant of the upload that throws rather than the one that logs and moves on: a Telegram outage at 09:00 has to retry at 09:01, not consume the day. The tick is a 60-second `unref`'d interval owned by the bot and cleared in `stop()`; a send already in flight is never re-entered.

`/digest` re-arms the scheduler **at the moment it mutates the config**, and takes its `next one today` / `next one tomorrow` line **from the scheduler**, not from the clock. The clock alone cannot know whether today already went out or whether the digest was armed in time, and a promise of "today" that then does not happen is worse than no promise. The tick also re-arms on any change it notices, so a config edited behind the command's back is still honoured. A context with no scheduler at all (a harness) falls back to comparing the clock to the hour rather than throwing.

The block is **normalised in the bot's constructor** (`cfg.digest ??= DEFAULT_DIGEST`, in place, so the scheduler and `/digest` share one live object) and `digest.start()` is wrapped: `loadBootConfig()` always merges the defaults in, but a config built by hand has no `digest` key, and the scheduler reads `digest.hour` at start. This is the same rule the missing-token branch follows — the most optional subsystem in the module must not be able to take the poll loop down with it.

Each digest writes a `telegram.bot` audit row with `event: 'digest'`.

### The feature-plan message uses this

When a feature reaches `proposed`, the notification is now the **feature report** — the same document `/report feature <id>` produces — with the approve button on it and the plan's phases, goals and review rounds inside the file instead of ten chunked messages. Its caption is the existing headline (phases, tasks, plan-review verdict) plus the Russian summary. A report that cannot be built falls back to the message that existed before, because a failed render must not cost the notification.

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

Task 4 (the red button) adds a fourth, `telegram-redbutton-harness.mts` (127 assertions, real `TelegramBot`, real SQLite, a stub orchestrator, and a **real loopback HTTP server standing in for the front door** so the `Host`/`Origin` rules on `/host/restart` are actually exercised rather than asserted):

- the `k:` confirm codec round-trips and stays disjoint from both the action codec and the wizard codec, in both directions, and refuses garbage;
- `ConfirmStore`: one window at a time, the first `take()` spends it and the **second finds nothing**, a wrong nonce never spends the open window, a window expires on read at 60s and an expired nonce is refused;
- `RateLimiter`: the per-command cooldown bites and lifts, a different command is not fenced by it, the 5-per-10-minutes burst cap bites across different commands and lifts when the window rolls off;
- `/killall` on a quiet machine says `Nothing to stop` and arms **no** window (so it spends neither the slot nor the cooldown);
- on a busy one it lists the live run by id *and* task title, the queued task it will cancel, the feature it will pause, and the 60s expiry, with a Confirm and a Cancel;
- a second `/killall` — **and a `/restart`** — while a window is open is refused and names the command it belongs to;
- **a non-allowlisted press of a valid nonce gets no reply, no toast, kills nothing, and leaves the owner's window armed**;
- the owner's press kills the run, cancels the running *and* the queued task, pauses the feature, stops the queue, and reports each by id and title — all with `actor: 'telegram'`;
- **a replayed confirm is refused and kills nothing a second time**, and the *identical update delivered twice in one batch* kills exactly once;
- a `/killall` inside the cooldown is refused and arms no window; Cancel touches nothing and burns no cooldown;
- **a window armed before a "restart" (a freshly constructed bot, i.e. a new in-memory store) is refused afterwards** and the task it would have cancelled is untouched;
- `/restart` reports the guard reason verbatim with its numbers, offers a force button that says force, and points at `/killall`; forcing sends `force: true` with a loopback `Host` and **no** `Origin`; an unblocked `/restart` sends `force: false`; a 409 is reported; a socket death after the request is treated as the restart happening; a missing front door is named rather than guessed at;
- the follow-up: the report is sent with no "have exited" claim, the `☠️ All N … have exited` message lands **only** once a real `run.exited` is broadcast, exactly once, and a repeated exit event does not re-announce;
- a killed **`analyze`** run is confirmed by `onHeadlessRunExit` rather than the bus (driven through `trackHeadlessChild` with a stub child), so it settles the follow-up instead of being reported as a 60s straggler — and the check proves the message did *not* come from the event bus;
- a **pending dispatch** is surveyed (named by the task it would have resumed), listed in the confirm, cancelled with a `killall` note, audited as `task.dispatch` with `actor: 'telegram'` against the target task, and leaves nothing pending to re-spawn the task just killed;
- `/off` keeps its old wording (the task-3 assertion still passes) and adds the live count, both when it toggles and when it was already stopped;
- `executeKillAll` over a quiet machine reports the idle legs and finds nothing on the re-sweep;
- the audit trail: `telegram.killall` carries the killed run ids / cancelled / paused, `telegram.restart` carries the force flag, a confirmed press audits `ok: true`, an expired one `ok: false`, a cancel is marked `cancelled`, a rate-limited command audits `ok: false`, and the underlying `run.killed` / `feature.transition` / `orchestrator.toggle` rows are attributed to `telegram` too — queried WITHOUT the actor filter, with other actors present, so the check is not tautological.

The two fixes from adversarial review round 1 were **mutation-checked**: deleting the headless subscription kills 2 assertions, deleting the dispatch leg kills 7. Tasks 1–3's harnesses (38, 43 and 226 assertions) all still pass unchanged, which is the regression check on the `setQueueEnabled` wording change and the new callback branch.

Task 5 (reports) adds a fifth, `telegram-report-harness.mts` (117 assertions), on a **temporary** SQLite database seeded with known fixtures — a published task, a failed one, a task in review reviewed twice, a blocked parent with a child, a queued task, a draft, a two-phase feature with a plan-review round, two dispatches (one delivered, one failed), a pending proposal and a needs-attention run — so every number below is checked against a known answer rather than against whatever the install happens to contain:

- **self-containment**, asserted on the 24h, task and feature documents alike: a full document with `charset` and a mobile viewport, exactly one stylesheet, and **no** `<script>` `<link>` `<img>` `<iframe>` `@import` `@font-face` or `url()` — plus the dark `--tm-*` values present as literals;
- the Russian summary is above every other section, the five sections are present and in spec order, the summary is 3–6 lines, fits a caption, and is one chat chunk;
- the numbers: publishes count only the `phase: 'published'` event and **not** the failed attempt beside it, findings are summed across rounds (0+3+2=5), the verdict split is rendered, a task reviewed twice is reported as 2 fix rounds while one reviewed once is not listed at all, each dispatch carries one line on what it was about and a failed one carries its reason;
- markdown becomes prose: bold markers gone, a heading keeps its words and loses its hashes, a link keeps its label and **drops its target**;
- Next steps carries the queued and draft tasks, the phase roll-up (`1/1 done`), and all three decision sources (pending proposal, feature awaiting approval, needs-attention run); Problems carries the failed task's error and the blocked parent;
- **the approval screen**, against a second fixture that is `proposed` with zero task rows — the exact state the feature-plan notification fires in: the Plan section sits under the Russian summary and above Numbers and carries the plan summary, both considerations, both phase goals, the planned task titles, a task's description and every exit criterion, both review rounds and a finding's detail text, while an `excluded` task is not offered as planned work; the empty sections explain themselves; the Russian summary names the plan and its status rather than calling it an empty period; the Next-steps roll-up defers to the Plan section instead of repeating it; and **the caption the notifier actually composes** (headline + the same lines) fits 1024 characters and still carries the plan summary the old plain message carried;
- a period report shows an unapproved feature as `task(s) planned, not created yet` with its goal and titles, while a phase that does have rows still reports real progress;
- **an entity scope reports on the entity and not on the install**: with unrelated pending proposals (one on another task, one attached to no task at all) and an unrelated feature awaiting approval all present in the database, `/report task <id>` keeps its OWN proposal and excludes the others, excludes the unrelated feature along with its phases, goals and planned task titles, and its Russian caption neither counts the foreign proposals nor claims a feature is awaiting approval; a group with nothing pending says so in both languages; a feature scope keeps its own approval decision; and the **period** report still lists all of them, so the gate is a scope rule and not a blanket filter. Each of the three leaks is mutation-checked separately (7, 5 and 5 assertions);
- **every document is checked for tag balance** (`div` `ul` `li` `p` `h2` `h3` `h4` `span` `b` `code` `section`). The report is built by string concatenation, so a forgotten closing tag is a real and invisible failure mode — an unclosed `<div>` nests the next card inside the previous one and renders without erroring. This caught exactly that bug in the review-round and phase cards;
- **Russian plural agreement**: 1 задача / 2 задачи / 5 задач / 11 задач (the teens exception) / 21 задача;
- scopes: `24h` `7d` and the default resolve, seven malformed ones are refused with a reason, a bare id is refused (the noun is required), a task and a feature resolve from a short prefix, **a group resolves from any member and covers the whole tree and nothing outside it**, and 24h is labelled `24h` rather than `1d`;
- the window filter is real, not decorative: a task aged to 9 days old is out of a 24h report and inside a 30d one;
- escaping, against a task whose title is `<img src=x onerror=alert(1)> & "q" </style><script>` and whose summary is `</style></head><body>pwned` — no tag injected, no `on*=` attribute, still exactly one `</style>`, escaped rather than dropped, caption included;
- `sendDocument` against a stubbed `fetch`: multipart `FormData`, **no** `content-type` header (so `fetch` writes the boundary), the chat id and filename carried, a short caption attached as HTML, an over-long one **not** attached but handed back whole as `overflow`, `../../etc/passwd` sanitised to `etc-passwd.html`, and a refused upload rejecting rather than resolving quietly;
- the digest decision table: nothing before the hour, one report at it, never twice however often it ticks, a slept-through hour caught up later the same day, nothing at all while disabled — and **a failed send rejects, does not consume the day, announces nothing, and is retried the next minute**;
- **which day the first digest lands on, in every direction**: `/digest on 21` at 14:00 lands at 21:00 **that same day**; `/digest on` at 22:00 waits for the next morning; **lowering** the hour past "now" (`/digest on 9` at 10:00) also waits, rather than firing within the minute; re-timing *after* the day already went out never produces a second digest, and the new hour takes effect the day after; a config changed behind the command's back is noticed by the tick and behaves identically; and the boot cases mirror the enable cases (07:00 with `hour: 23` sends that night, 22:00 with `hour: 9` does not), while a **restart keeps the persisted arming instant** so a 14:00 restart still catches up the 09:00 it slept through, and a restart after a send does not re-send;
- **`nextRun` never lies** — a property over 720 states (`hour` × clock × enabled × sent-today × arming instant) asserting `nextRun(now) === 'today'` **iff** playing the rest of the day out through `tick()` actually sends. The round-3 defect was a *disagreement* between the reply and the scheduler, and two examples would not have stopped the third; restoring the clock-only reply fails this property in one line of output;
- the `/digest` handler re-arms the scheduler at the moment it mutates the config, takes its day from the scheduler (the same hour renders "today" or "tomorrow" depending on what the scheduler reports), refuses an out-of-range hour, promises nothing when turned off, and still renders in a context with **no** scheduler at all;
- a `TelegramConfig` with **no `digest` block at all** is normalised in the constructor to the documented default, in place, with the scheduler and `/digest` sharing the one object. Task 3's harness builds exactly such a config, so its 226 checks are the regression test for the startup path itself.

Task 6 (the workbook) verifies the § Connect chapter itself, because a setup document whose quoted strings do not match the code is worse than no document. Two halves:

**A real server, on its own port and its own database.** A second copy of the tree (`server/` + `shared/`, the real `node_modules`, a fresh `server/data/`) booted on `port: 5199` / `host.port: 5198` against `data/taskman-isolated.db`, never touching the live install's 5175/5176 or `taskman.db`. Every boot line quoted in § 4 and § 7 was **produced by that server**, not copied from source: all four misconfiguration lines (`bot disabled (data/config.json telegram.enabled)`, `telegram.botToken is empty`, the malformed-token line, `allowedUserId is 0 — bot NOT started`), the healthy `bot enabled, answering user id N only`, and — with a well-formed but invalid token — the live `getMe` handshake failing against the **real** `api.telegram.org` and stopping the loop with `refused by Telegram (getMe: Unauthorized)`. The instance also served `/api/health`, and under the front door (`host.ts`) answered `/host/status` and proxied `/api/health`, so the isolated-instance recipe in § 6 is a recipe that was run. The Bot API's own error shapes were checked directly over HTTPS: a malformed token gives `{"ok":false,"error_code":404,"description":"Not Found"}`, a well-formed invalid one `{"ok":false,"error_code":401,"description":"Unauthorized"}` — which is why 401/404 is what `TelegramApiError.fatal` keys on.

**The real bot, walked through the workbook's own steps** — `telegram-workbook-harness.mts` (73 assertions, attached to the task), driving the real `TelegramBot` against a stubbed `fetch`, a real SQLite database through the real driver, and a stub orchestrator:

- step 2: a non-allowlisted `/start` gets **exactly one** reply, that reply **quotes the caller's own numeric id**, it leaks neither the owner's id nor any task/queue detail, the same stranger's second `/start`, their `/status` and their free text get **nothing**, and the owner is not notified — so the id-discovery trick in § 2 is the behaviour, not a hope. The reply is quoted in § 2 verbatim from this run;
- step 4: `setMyCommands` is called at boot and its payload is exactly `commandSpecs()`, all 37 entries, `/start` `/help` `/status` `/new` `/tasks` `/task` `/report` `/killall` among them (the four `/chat` verbs were added in 2026-09-05 and are asserted by that feature's own harness — see [`chat.md`](chat.md) § Verification); the boot message goes to the owner and to nobody else; `/start` and `/status` answer, and the `/status` block printed in § 4 is that run's real output;
- step 5, the whole loop in order: `/new` → repo picker → title → skip description → preset → auto-publish → **▶️ Run now**; the task exists, sits in the repo that was picked, reached the orchestrator as `runNow` with `actor: 'telegram'`, and is audited `task.created` / `telegram`. The worker's landing is then simulated by transitioning it to `review` and broadcasting on the **real** event bus: the review ping arrives past the 5s coalescing window carrying **✅ Mark done / 🚀 Publish / 💬 Proceed**, the Mark-done payload parses back through `parseActionData` to *this* task's id, pressing it moves the task to `done`, and that is audited `task.transition → done` with `actor: 'telegram'`. The audit check is not tautological: the same task's event list also holds non-telegram rows;
- every one of the 33 commands the § Connect chapter and the § Commands tables name is checked to exist in `commandSpecs()` — the check that catches a documented command that was renamed or never shipped.

**The Mac-as-a-server checklist was executed, not recited.** `caffeinate`'s flags are quoted from its own man page on this machine (`-i` = idle only; `-s` "valid only when system is running on AC power"; a wrapped utility holds the assertion for the utility's lifetime); a live assertion was read back with `pmset -g assertions` (`pid N(caffeinate): … PreventUserIdleSystemSleep`); the AC/battery split in § 6 matches this machine's actual `pmset -g custom` (`sleep 0` on AC, `sleep 1` on battery). The launchd plist was **linted, loaded, run and unloaded**: `plutil -lint` passes, `launchctl bootstrap gui/$UID` starts it, `launchctl print` shows `runs = 1` / `last exit code = 0`, `caffeinate -i` really did exec the wrapped program, `KeepAlive: { SuccessfulExit: false }` correctly did **not** respawn it after a clean exit, and `launchctl bootout` removed it (a throwaway `Label` was used and the agent is gone — nothing was installed on this machine). `fdesetup status` reports `FileVault is On.` and `defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates` reports `1`, which is precisely the reboot-into-the-FileVault-screen configuration § 6 warns about — the caveat is live here, not hypothetical. That `server/data/` is git-ignored and `config.json` untracked was checked with `git check-ignore` and `git ls-files`.


The board (§ The board) is verified by `telegram-board-harness.mts` (**97 assertions**, attached to its task), driving the real `TelegramBot` against a stubbed `fetch` that records `sendMessage`, `editMessageText`, `editMessageReplyMarkup` and `sendDocument`, a real SQLite database, a stub orchestrator and a stub activity snapshot:

- the `l:` codec: every button kind round-trips through short ids, the longest wire is under 40 bytes and never carries a uuid; an id under 4 characters, an unknown view, a 4-digit page and trailing segments do not parse; `l:` is disjoint from the action, `w:`, `c:`, `q:` and `k:` codecs in both directions; a board is recognised by its 🔄, a card by its 🔄 (not its ◀), a notification keyboard by neither;
- `/tasks` is ONE message: the six tabs in order with the active one marked, repo chips, triage order question → attention → flagged review → review → blocked → failed → proposals, the proposed feature on page 2 numbered `9.`, a 10-day-old failure and the drafts absent, each row's action buttons (❓ Answer, ✖ Kill on the right run, ✅ Done / 🚀 Publish, ⛔ Unblock, 🔁 Retry, Accept only on the option-less proposal, Approve), the ❓ 🔔 🚩 markers, escaped titles;
- a tab tap edits the SAME message and sends nothing; 12 drafts page as 8 + 4 with `‹ 1/2 › 🔄`; page 99 clamps; a repo chip filters; the page counter answers silently; a 🔄 answered `message is not modified` sends no copy; **none of it writes a `telegram.command` row**;
- a card opened from a filtered page carries ◀ back to that exact state; ⏳ Queue on the card moves the task, redraws the same message with `queued` and 🚫 Cancel (Queue gone), keeps ◀ / 🔄, toasts `✅ …`, and is audited once; pressing it again toasts `⚠ …`, redraws, and audits `ok: false`; a card whose escaped fields would pass 4096 characters shrinks into one edit;
- a stale id toasts `no task starts with` and redraws the board; two tasks sharing an 8-character prefix toast `matches 2 tasks` and open neither; a 3-character `l:` id is "Unknown button";
- ❓ Answer sends the question with its `q:` buttons; 💡 sends an options proposal in full with one accept per option; 🧩 sends the plan document with Approve;
- ✖ Reject in the inbox rejects and redraws the inbox without the row;
- `/now`: `workers 1/2 · queue on`, `🛠 Edit server/src/x.ts`, `⏱ 1h 15m · ctx 43% · $1.23`, ✖ Kill and ❓ Answer; Kill from it kills the run and redraws without the button;
- `/tasks review`, `/tasks beta` (repo), `/tasks SHIP` (search, case-insensitive), a search with no hit, and a search lost to a restart;
- Done on a review ping keeps its ✅ message and removes the ping's keyboard; a keyboard naming two tasks is left alone;
- a refused edit falls back to a fresh send; a `date: 0` message is sent fresh without an edit attempt;
- `/start` carries the persistent keyboard; `🏃 Now` and `👀 Review` run their commands and are audited as `tasks` + `review`;
- every keyboard produced in the run is ≤ 100 buttons with every `callback_data` ≤ 64 bytes and every text ≤ 4096.

Re-running the task-3 commands harness after this change: its `/tasks` checks (flat list, junk-argument help) and "every `/task` button parses through the action codec" (the card now also carries `l:` ◀ / 🔄) fail **by design**. Its other failures (the default model, `claude-fable-5`) and the notify and red-button harnesses' failures (review-message wording, `tm_dispatches.intent`) predate this change — those harnesses have drifted from later schema and wording work.

**Not verified**: **a real BotFather token against the real Bot API.** Task 6 could not close this one and did not pretend to: creating a bot requires a human in the Telegram app talking to @BotFather, and no token exists on this machine — `server/data/config.json` has no `telegram` block and no environment variable carries one. What is verified instead is that every string the workbook quotes is either produced by a real server (the boot lines) or asserted against the real bot code (the replies, the buttons, the command list), so the instructions cannot drift from the implementation; what remains unobserved is Telegram's own transport, the BotFather dialogue, and the **409 two-poller collision** — the 409 hint text in § 7 is quoted from `bot.ts`, and the fatal 401/404 beside it was produced against the real API. The rest, unchanged from the earlier tasks: the usage watcher's threshold/reset comparisons are reviewed but not driven by the harness (`usageSnapshot()` reads real transcripts and CLI caches). `/feature` is driven only as far as the repo picker: pressing it starts a real headless `claude -p` analysis, which a smoke test must not do. `/restart` is driven against a **stand-in** front door, not the real `host.ts` — a test that actually restarted the server would take the harness with it; what is verified is the request this process sends (path, headers, `force`) and how it reads each answer. `stopAllHeadless()` is exercised only through the no-op path: a test process has no headless `claude -p` children, and spawning one to kill it would be spawning `claude` from a test. The report's **usage** numbers are rendered but not asserted against a known value — `usageSnapshot()` reads real transcripts and CLI caches, so the harness checks that each window is present and labelled, not what it says. The rendered report was also read at phone width in a browser, which is how the raw-markdown defect in the result summaries was found; that part is an eye, not an assertion.
