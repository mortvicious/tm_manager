# Chat — the terminal you would have opened yourself

Status: **shipped 2026-09-05.** A free-form conversation with claude inside one of your repos, held open across the browser and the phone. `/chat` on Telegram, the **Chat** page in the web UI, one transcript behind both.

## Why

The task manager was very good at work you could describe in advance. You wrote a task, an agent took it, a reviewer read the diff, you approved. What it had no answer for was the other half of the day: *"what actually changed in this file last week"*, *"does this endpoint still return the old shape"*, *"remind me why we did it this way"*. None of those are tasks. Filing one costs a queue slot, a fresh session, an adversarial review round and a status the board has to carry — for a question whose answer is three sentences.

The thing that answers those questions is a terminal with `claude` open in the repo. You had one on the laptop. You had nothing on the phone, and nothing that survived closing the laptop lid.

**A chat is that terminal, made durable and made portable.** It lives in a repo, it remembers, and either surface can pick it up where the other left off.

## What it is

A chat is a row in `tm_chats` pointing at a repo, and a transcript in `tm_chat_messages`. Every turn is **its own terminal**: an aux session of kind `chat` in the aux PTY pool (`docs/design.md` § PTY sessions):

```
claude [--resume <sessionId>] --model <model> [--effort <effort>] --settings <hooks> \
       (--permission-mode dontAsk --disallowedTools=Edit,Write,NotebookEdit,Bash,AskUserQuestion,EnterPlanMode,ExitPlanMode
        | --dangerously-skip-permissions --disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode) \
       -- <message>
```

`cwd` is the repo's path. The session id reported by the SessionStart hook is stored on the chat. That id is the conversation: turn one runs fresh because there is nothing to resume yet, and every turn after it carries `--resume`. The turn has a `tm_runs` row (`mode aux`, `kind chat`, `subject_id` = the chat). It shows in the runs list with a Terminal button, so a turn can be watched and typed into from the browser. The restart guard names it (`1 aux session(s) (chat: …)`), and `/killall` and shutdown end it with `aux().stopAll()`.

### Turns are terminals (and why the phone does not care)

This section used to be "Why not a PTY", and it rejected the PTY for two reasons. Both are answered now, and neither answer needs the phone to see a terminal:

- **Telegram cannot consume a PTY.** It does not have to. The reply is the Stop hook's `last_assistant_message`, which is the same final text the `-p` envelope returned as `result`. So the phone and the chat page read the same string they always did, and neither ever sees an xterm byte. The terminal is an extra window onto the turn for the browser. It is not the channel the reply travels on.
- **A live PTY and a `--resume` turn cannot share one session id.** They never do. The PTY lives for exactly one turn. It is ended once the Stop lands, and the turn's `done` resolves only after the process has exited. The next message's `--resume` is behind the same `beginChatTurn` lock as before, so there is never a second process on the session. After that point the terminal is a read-only replay of the ring buffer, until the pool's TTL disposes it.

**Two things changed.**
- **The message is now the positional argument (after `--`) rather than stdin**, because the interactive CLI reads its first prompt from argv. It is visible in `ps` to the same OS user, which is the same exposure the workers' task descriptions always had. `--` keeps a message that starts with `-` a prompt, and this was measured with `-- Remember the word…`.
- **The interactive CLI offers tools `-p` did not**: a question dialog, and plan-mode approval. A turn sent from the phone has nobody at the terminal, so those tools would hold the chat's lock until the timeout. They are denied in both modes.

One mechanism, two renderers. The browser gets a transcript with a composer; the phone gets messages. Neither is a terminal emulator, and neither needs to be: what you wanted from the terminal was the conversation, not the escape codes.

## Serial, and why that is in SQL

A chat answers **one turn at a time**. Two surfaces are pointed at the same conversation, and two `claude --resume` processes on one session id is a corrupted conversation, not a race you can retry.

The lock is `tm_chats.status`, and it is taken by `beginChatTurn` — a single conditional `UPDATE … WHERE id = ? AND status IN ('idle','error') RETURNING *`. A chat already `thinking` returns null and its caller refuses with a 409. It is a first-class composite storage method for the same reason every other one is: there is deliberately no generic `transaction(fn)` in this codebase (`storage/types.ts`).

Everything past the lock must reach `finishChatTurn` — and "everything" has to mean it, because a chat left `thinking` refuses every future message until the next boot sweep. There are **two** windows, and each has its own guard:

- **Between the lock and the spawn**, `send()` still writes the user's message and may rename the chat. A dropped Postgres connection or a `SQLITE_BUSY` there used to reject `send()` outright, with the lock held and no child in existence to settle it: a 500 to the caller *and* a dead chat. That block now releases the lock and returns the 500 instead of throwing.
- **After the turn**, `completeTurn` wraps its bookkeeping for the same reason.

Both releases are themselves `.catch()`-ed: a failure while releasing the lock must not become a second exception on top of the first.

### Crash recovery kills before it clears

A lock stranded by a crash is cleared at boot by `ChatService.recoverOnBoot()` — but clearing it is only half of the job, and the dangerous half on its own.

A chat turn owns no `tm_runs` row, so the orchestrator's boot pid sweep cannot see its child, and the child is spawned detached. A `kill -9`, an OOM or the front door's SIGKILL escalation therefore leaves it **running** — in write mode, still editing the repo. Release the lock without killing it and the next message spawns a second `claude --resume` on the same session id *alongside the orphan*: precisely the two-children-one-session corruption the lock exists to prevent, arrived at by way of the recovery.

So the turn's pid is persisted on the row (`tm_chats.pid`, migration 20, written right after the spawn and cleared by `finishChatTurn`), and boot recovery kills it — as a **process group**, and behind the same command-line check the orchestrator's sweep uses, because across a restart pid reuse is realistic and signalling a stranger is worse than missing an orphan:

```
chat: cleared 1 turn(s) stranded by the last restart, killed 1 orphaned claude process(es)
```

The pid write is fire-and-forget: a failed write must not take down a turn that has already spawned, and the cost is only that recovery could not kill that one — which is never worse than having no column at all.

That command-line check, `pidLooksLikeOurs`, had to be fixed to match the **basename** of `ps -o comm=` rather than the whole string. On macOS `comm` is a full path, so the old whole-string test meant any binary that merely *lived* under a directory with a matching name read as "ours" — the chat recovery harness reproduced it by killing an unrelated process purely because the scratch path was `/private/tmp/claude-501/…`. Basenames still match every real case (`claude`, `claude.exe`, `node`, `bash`), so the change only ever narrows what may be signalled. The orchestrator's own sweep shares the helper and gets the same fix.

Shutdown and `/killall` reach a chat turn through the aux runner (`aux().stopAll()`), which ends its PTY. (Before 2026-09-24 this was the headless registry signalling `-pid` for detached children. A PTY's claude is its own session leader, so the terminal's hang-up reaches the tools it started as well.)

A second fence, `chat.concurrency` (default 2), bounds turns across **all** chats — a chat is serial on its own, and this is what stops six open chats from all running at once. It is deliberately not `orchestrator.concurrency`: a chat turn owns no task and must never take a worker slot. It is a *fence*, not a lock: it is counted before the per-chat lock is taken, so two requests landing in the same millisecond could both pass it. That is deliberate — the invariant that must hold absolutely is one turn per **session**, and that one is a single conditional UPDATE. Making the global count exact would mean serialising every chat behind one row for a limit whose only job is to stop a human from opening six tabs.

## Stopping a turn, and the grandchild problem

`POST /api/chats/:id/stop` (the ⏹ button, `c:stop` on the phone) aborts the turn's aux session, and so does Kill in the runs list. Either way the turn records `stopped`. The runner ends the PTY: SIGHUP to the terminal's session, then SIGKILL 5 s later. The turn settles `aborted` and the lock is released. This was measured with a Kill mid-essay: the chat read `stopped`, the row was `killed`, and the next message was accepted.

*History (the headless era, kept for the reasoning):* the stop signalled the **process group**, and that detail was the difference between a stop that works and one that only appears to.

A turn's `claude` spawns children of its own — a `Bash` tool call is one — and they inherit its stdout. The reply is read to EOF on that pipe. Kill the `claude` alone and a surviving grandchild holds the pipe open: nothing ever reports the exit, the lock is never released, and the chat is unusable. So the child is spawned `detached` (its own group leader) and `killGroup` signals `-pid`; SIGTERM, then SIGKILL five seconds later if it is still the same child, matching `SessionManager.kill()`.

The same escalation is the turn's real timeout. `TURN_TIMEOUT_MS` is fifteen minutes and it is enforced by our own watchdog rather than by the spawn's, because a timeout that signals only the child is the kill a live grandchild survives. A stop is recorded as `stopped` on the chat and on the assistant message — not as the raw command line, which is what a signalled child otherwise reports.

That was also why this one module used `spawn` where the rest of the headless code used `execFile`. The PTY made both points moot: there is no pipe to hold open, and the turn's deadline (`TURN_TIMEOUT_MS`, still fifteen minutes) is the aux runner's own timer.

## Read and write

Every chat has a **mode**, and it is `read` by default:

| mode | argv | what a turn may do |
|---|---|---|
| `read` | `--permission-mode dontAsk --disallowedTools Edit Write NotebookEdit Bash` | the same fence `analyze.ts` and `review.ts` pass, so "read-only" means one thing in this codebase |
| `write` | `--dangerously-skip-permissions` | the full tool surface: it can edit files and run commands in the repo |

Read-only is the default because a chat points at a working tree an agent may be mid-task in, and "have a look at this" should not be able to change it. Write mode is the "same as sitting in the terminal" mode and is opted into per chat.

**Why write mode is not `dontAsk`**, which is the natural thing to reach for and is wrong: a turn sent from the phone has nobody at its terminal to answer a permission prompt, and `dontAsk` does not mean "do not need to ask" — it means *deny anything that would ask*. In a repo with no allow rules Edit, Write and Bash all prompt. Measured against the real CLI, a `dontAsk` write turn told to create a file answered

> I need permission to create the file. Claude Code is running in "don't ask mode", which means I can't proceed without your explicit approval.

and wrote nothing: a write mode that cannot write. So write mode skips permissions outright, which is the only honest reading of "the same as sitting in the terminal" anyway.

There is deliberately **no setting between the two.** `acceptEdits` looks like a useful middle — "may change files, may not run commands" — and is not one: measured in `-p`, it happily ran `echo MANGO > probe-bash.txt`. Shipping it as the narrower option would have been a distinction that does not exist. The lever is `read` vs `write`, and write is gated per chat, warned in the UI, and gated again for the phone.

Mode, model and effort are read at the **start** of a turn, so changing them mid-turn is refused with a 409 rather than half-applied to a child already running on the old settings.

## From the phone

`/chat` is a **mode**, not a wizard. It survives a restart (`telegram.activeChatId` in `tm_config`, deliberately absent from `PUT /api/config` like the other bot-state keys), and you leave it by typing `/endchat`. That is the whole reason it is persisted rather than held in memory next to the conversational flows: a flow that evaporates costs you a re-typed title, but a chat mode that silently evaporated would turn your next message back into an offer to file a task.

| command | does |
|---|---|
| `/chat` | where you are, and the last few turns. With no active chat: opens one (asking which repo, if there is more than one) |
| `/chat <repo>` | open — or resume — the chat in that repo |
| `/chats` | every chat, with a button to switch |
| `/endchat` | leave the mode. The chat stays |
| `/mode read\|write` | this chat's tool fence |

While chat mode is on, **plain text is a chat message.** It is checked only when no conversational flow is live: a half-finished `/new` is answering a question it asked, and a mode must not steal that answer. Outside chat mode nothing changes — free text still becomes the explicit "file this as a draft?" confirm it always did.

Buttons live in a **`c:` namespace**, parsed in `bot.ts` before the stateless action codec, for the same reason the `w:` and `k:` namespaces are: they name a chat that either surface can delete, and a stale one must be *refused* rather than fall through to a codec whose buttons stay valid forever. A remembered chat that was deleted in the browser clears the setting on the next read instead of failing every message.

A turn takes tens of seconds, so the bot holds the **typing indicator** for the whole turn (Telegram clears it after ~5s) and sends the reply when it lands. Replies are escaped first and marked up second — fenced blocks become `<pre>`, inline backticks become `<code>`, and nothing else — so no amount of HTML in a model reply can become a tag. `**bold**` arriving as literal asterisks is mildly ugly; a diff arriving with its indentation collapsed is unreadable, and that is the difference the two translated constructs are chosen on.

### The security posture, and how it changed

`docs/telegram.md` § What the bot does not do used to say flatly that the bot reaches no code-execution surface: the PTY WebSocket was deliberately not exposed, and that was the posture, not an omission.

**A write-mode chat is a code-execution surface, so turning it on from the phone is a decision made once, at the keyboard.** `telegram.chat.allowWrite` lives in `server/data/config.json` — the file that already holds the bot token — and defaults to `false`. The web UI can always switch a chat to write, because the web UI is the laptop that file lives on.

**The flag is enforced at the send, not only at the switch**, and that distinction is the whole flag. Gating `/mode write` alone would leave the obvious hole open: switch a chat to write in the browser (allowed, and documented as such), leave it, and an unlocked handset can type `run rm -rf …` into a fully-armed surface without ever touching `/mode`. So:

- **`sendToChat` refuses** before anything is stored or spawned when the chat is `write` and `allowWrite` is false (`phoneMaySend`);
- **`/chat` does not silently land you there**: with the flag off it resumes the newest chat the phone can actually *use*, and opens a fresh read chat rather than attaching to a write one;
- **`c:use` may still switch to a write chat** — reading a transcript is not the danger — but says up front that messages will be refused, instead of letting you find out by typing.

Reading stays open throughout; only the turn is blocked.

`telegram.chat.enabled` (default `true`) turns the whole surface off.

The agents' terminals are still not exposed. That has not changed.

## The API

| route | |
|---|---|
| `GET /api/chats[?repoId=]` | newest activity first |
| `GET /api/chats/:id` | `{ chat, messages }` — the whole transcript |
| `POST /api/chats` | `{ repoId, title?, model?, effort?, mode? }` |
| `PATCH /api/chats/:id` | `{ title?, model?, effort?, mode? }` — 409 mid-turn for all but the title |
| `DELETE /api/chats/:id` | the chat and its transcript, transactionally (there is no FK to cascade) |
| `POST /api/chats/:id/messages` | `{ text }` → **202 on acceptance** |
| `POST /api/chats/:id/stop` | cut the live turn short |

`POST …/messages` answering 202 rather than the reply is the load-bearing choice. A turn runs for minutes, which is longer than any sane HTTP timeout — so `ChatService.send` is **two phases**: it resolves once the message is validated, the concurrency fence passed, the lock taken and the user's message stored, and hands back a `done` promise for the reply. Every refusal (404 gone, 409 already answering, 429 over the cap, 400 empty) is therefore a real status code, and the reply arrives over `/ws/events` as a `chat.message` — the same frame a turn started from the phone produces. Collapsing the two phases into one promise would have forced the route to *guess* when a refusal had stopped being possible, and that guess is different on SQLite and on Postgres.

The same two phases are what keep the **Telegram bot responsive**. Its update loop handles one update at a time; awaiting the reply there would make the bot deaf for the minutes a turn takes — no `/endchat`, no `/status`, and in particular no ⏹ Stop for the very turn you were waiting on. `sendToChat` awaits the acceptance and lets the reply (and the typing indicator that runs with it) land on its own.

Three new `ServerEvent` arms: `chat.updated`, `chat.message`, `chat.deleted`. One turn produces exactly four frames, in this order:

```
chat.updated:thinking | chat.message:user | chat.message:assistant | chat.updated:idle
```

Audit rows: `chat.created`, `chat.edited`, `chat.deleted` and one `chat.turn` per turn carrying model, mode, whether it resumed, duration, cost and either the reply length or the error.

## Storage

Migration **19**, two tables, both drivers, dialect-neutral:

- `tm_chats` — repo, title, model, effort, mode, `session_id`, `status`, `error`, `pid` (migration **20** — see § Crash recovery), `turns`, `cost_usd`, timestamps and `last_message_at` (the list's sort key; a brand-new chat falls back to `created_at` via `COALESCE`, or it would sink to the bottom the moment it was opened).
- `tm_chat_messages` — chat, role, text, actor, error, cost, duration. Its `id` is the time-sortable `eventId()`, so `ORDER BY id` **is** send order and the browser can splice a live frame into a fetched transcript without a timestamp tiebreak.

FK-less, like `tm_events` and `tm_dispatches`; `deleteChat` removes both in one transaction.

`finishChatTurn` writes `session_id = COALESCE(?, session_id)`: a failed turn — or one whose envelope carried no id — must not erase the id the conversation is on. The session id is kept even from a failure, because claude has already created that session and dropping it would silently start a second conversation inside one chat.

## What it is not

- **Not an agent.** It has no task, no run row, no review round, no publish turn. If a chat turns up something worth doing, file a task.
- **Not the agents' terminal.** The PTY WebSocket is still not exposed to the phone.
- **Not a markdown renderer.** Both surfaces show fenced code as code and everything else as text with its line breaks kept. No HTML is ever constructed from model output on either side.
- **Not shared with `agent.model`.** `chat.model` / `chat.effort` are their own settings: wanting the cheap model for questions and the heavy one for work is the normal case. There is no `chat.permissionMode` — see § Read and write for why that knob was measured and dropped.

## Verification

**2026-09-24, turns as terminals.** Run against the real CLI (2.1.280, Haiku 4.5) on an isolated copy with its own SQLite, port 5185 and a scratch repo:
- Turn 1 (`-- Remember the word PAPAYA…`) replied `OK` and stored the session id.
- Turn 2 resumed that session and answered `PAPAYA`. Its cost was the turn's own delta ($0.004 against $0.039), from the previous turn's transcript used as the baseline.
- A chat pointed at a model that does not exist failed in 4 s with `model_not_found: …` (StopFailure), not after the 15-minute deadline.
- Kill in the runs list mid-essay recorded `stopped` and closed the row as `killed`.
- A SIGKILL of the server mid-turn left no claude behind; boot recovery cleared the lock.

Driven against an isolated copy of the repo (own SQLite DB, port 5411, a scratch git repo, and a fake `claude` on `PATH` recording the exact argv, stdin and cwd of every spawn — this repo's own server was never touched):

- migration 19 applies to a live DB and both tables land with their columns;
- **turn one spawns with no `--resume`; turn two carries `--resume sess-aaa`**, both with `cwd` = the repo and the prompt on stdin; `read` mode carries `--disallowedTools Edit Write NotebookEdit Bash` and `write` mode drops it;
- the session id, cost, duration and turn count are recorded, and the first message renames an unnamed chat;
- refusals: a second send to a thinking chat **409**, a third concurrent turn **429** naming the cap, a mid-turn model/mode edit **409** (a title edit still 200), unknown model / unknown mode / unknown field / empty text **400**, missing repo and missing chat **404**;
- `stop` on a turn whose child had spawned a grandchild released the lock **within one second** and recorded `stopped` — the same case took the full timeout before the process group was introduced, which is how the bug was found;
- a chat seeded `thinking` with the server down is cleared at the next boot (`chat: cleared 1 turn(s) stranded by the last restart`) and accepts messages again;
- `DELETE` removed the chat and all four of its messages, and answered 404 the second time;
- the restart guard names a live chat turn: `1 headless agent(s) (chat: …) still working` (now `1 aux session(s) (chat: …)`);
- against a 30-second turn, `send()` **returned in 3ms**, the lock was held while the caller was already free, `stop()` reached the still-running turn, `done` resolved strictly afterwards as `stopped`, and the lock was released — the property the Telegram loop depends on;
- over a real `/ws/events` socket, one turn produced exactly `chat.updated:thinking | chat.message:user | chat.message:assistant | chat.updated:idle`;
- a 30-assertion `tsx` harness over the Telegram surface: the `c:` codec parses its own payloads and **rejects `t:`/`w:`/`k:` ones, and all three of those codecs reject `c:`**; replies escape `<b>`, `&` and `"`, turn fences into `<pre>` and backticks into `<code>`, and close an unterminated fence; `/chat` refused when disabled, opening by repo name, reporting where you are, refusing an unknown repo; `/chats` marking the active chat; `/mode write` **refused without `telegram.chat.allowWrite` and allowed with it**, from both the command and the button; a button naming a missing chat refused rather than guessed; `/endchat` idempotent; and deleting the active chat clearing the mode on the next read.
- `npm run typecheck` + `npm run build` clean.

### Review round 2 — the other side of the lock

One major: `send()` took the lock and then wrote the user's message and the auto-rename **outside any try/catch**, so a storage failure in that window escaped without ever reaching `finishChatTurn`. The route answered 500 and the chat stayed `thinking` — unusable until the next boot sweep, for a turn that had not even spawned. The invariant was stated in both the code and this document and enforced only on the far side of the spawn.

Fixed by guarding that block, and verified by **fault injection** rather than by inspection — a 14-assertion harness that makes one storage call throw:

- `appendChatMessage` throwing `SQLITE_BUSY` → `send()` returns a 500 carrying the cause, the lock is **released**, no pid is left behind, and the very next message is accepted and completes normally;
- the auto-rename (`updateChat`) throwing `ECONNRESET` → the same, on the second of the two calls in that window;
- `finishChatTurn` *also* failing while releasing → `send()` still resolves with its 500 rather than rejecting, so a double fault cannot become an unhandled rejection.

The bug was confirmed to be real before it was fixed: with the guard removed, the same harness rejects out of `send()` and leaves `{ title: 'insert fails', status: 'thinking' }` in the database.

### Review round 1 — three majors, all fixed and re-verified

The first review found three, and the first two were things the argv-recording fake `claude` structurally could not show. They were re-checked against the **real** CLI in a scratch git repo.

1. **Write mode could not write.** Reproduced exactly: `--permission-mode dontAsk` with no disallow list, told to create a file, answered *"Claude Code is running in 'don't ask mode' … I can't proceed without your explicit approval"* and left the directory unchanged. After the fix, `--dangerously-skip-permissions` created `probe-write.txt` containing `BANANA` **and** ran `git status --short`, with no first-use dialog in `-p`. Read mode was checked the same way and correctly refused: *"both the Write and Edit tools are disabled for this session"*, no file. `acceptEdits` was measured too, which is why no middle setting shipped: it ran `echo MANGO > probe-bash.txt`. Per-mode argv re-asserted end to end — write `[--dangerously-skip-permissions]`, read `[--permission-mode] [dontAsk] [--disallowedTools] …`.
2. **The phone could execute in an already-write chat.** A 14-assertion harness over the exact scenario: a chat created in write mode "from the browser", then `phoneMaySend` false with the flag off and true with it on; `/chat` **not** resuming that chat and opening a read one instead; with only a write chat present and the flag off, a fresh read chat rather than an attachment; with the flag on, the newest chat resumed whatever its mode; `c:use` still switching but warning up front; and the same chat still fully usable from the API.
3. **An orphaned child survived a crash.** `tm_chats.pid` is written mid-turn (asserted against the DB while a turn ran) and cleared afterwards. End to end: a chat seeded `thinking` with a live detached process named `claude` as its pid → `chat: cleared 1 turn(s) stranded by the last restart, killed 1 orphaned claude process(es)`, the process gone, the lock released, the pid nulled. The pid-reuse guard is tested against **real live processes**: a real `claude.exe` still matches `/claude/`, and this harness's own `node` no longer matches patterns that appear only in its path — the false positive the basename fix removes, which the scratch path `/private/tmp/claude-501/…` had been triggering.

**Not exercised:** the Postgres driver (the same `?`-placeholder SQL as SQLite, character for character, but this install has no live connection string), and a real Telegram round trip (no bot token in the isolated config — the handlers were driven directly, which is what they are written to allow).
