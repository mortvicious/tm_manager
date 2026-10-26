# Auto wake-up — a turn the usage window cut short comes back on its own

## The gap this closes

The 5h usage window runs out mid-turn. The CLI prints its banner, the turn
stops, and the task lands wherever the exit put it — `review` on a clean exit,
`failed` on a dirty one, or nothing at all when the PTY stays alive and the
agent simply sits at its prompt. Nothing in the product knew *why*. The window
reopened four hours later and the task was still sitting there, because the
only thing that ever reopened a session was a human noticing and clicking
**Proceed**.

That button was already the right mechanism — `proceed()` reopens the task's
OWN claude session (`claude --resume`), which is the whole point: the work in
progress, the files already read, the plan already made are all still there.
What was missing was the trigger. This feature supplies it.

**One sentence: a turn stopped by the account, not by its work, is recorded
with the time the window reopens, and resumed in its own session at that
time.**

## The three questions, and where each is answered

| question | answer lives in |
|---|---|
| was that a usage limit? | the CLI's StopFailure `rate_limit` code when the run got one (`Orchestrator.rateLimitStop()`); else `server/src/claude/limit.ts` — `assessLimitStall()`, over `parseLimitNotice()` plus the account |
| when does the window reopen? | `limit.ts` — `resolveWakeAt()`, over the code's `error_details` or the notice + the account cache |
| what do we do about it? | `server/src/orchestrator.ts` — `wakeSweep()` and `tm_tasks.wake_at` |

### The CLI continues first

Since 2.1.234 the CLI resumes an interactive session on its own when a
claude.ai usage limit resets (`autoContinueAtUsageLimit`, default **on**,
readable from user/`--settings`/managed settings; GrowthBook gate
`tengu_marble_heron`, missing = on). Measured in the 2.1.280 bundle and its
docs (`interactive-mode.md` § Wait for a usage limit to reset), not in a live
session:

- it arms on the API-error message of a `rate_limit` that carries quota
  limits, only in an interactive, subscription-billed, non-overage session —
  a worker PTY qualifies; `dontAsk`, `--dangerously-skip-permissions` and
  injected hooks do not disable it;
- it fires at the reset plus a random **30–90 s**, by queueing a meta prompt
  with the fixed text "Your claude.ai usage limit has reset. Continue the task
  you were working on…" — a normal turn, so UserPromptSubmit and Stop fire as
  usual;
- it re-arms at most twice; it does not arm for a reset more than 24 h away (a
  weekly limit); a machine that slept more than 30 min across the reset goes
  **stale** and waits for Enter; **exiting the process cancels it**, and
  `--resume` does not re-arm it;
- it reports through the Notification hook as `quota_auto_resume_fired`,
  `_stale` and `_disabled` (the last only for a wait already armed).

So killing the PTY at park time — what the live-stall path did — is exactly
what cancels a resume that was going to happen anyway, in the same session, a
minute after the reset. The server therefore **leaves a live session to the
CLI** and keeps its own wake as the backstop:

- **left to the CLI** (`leaveToCli`): a live run with the `rate_limit` code
  *and a stated reset* that the streak cap does not stop. Nothing is killed and
  the status is unchanged; `wake_at` = reset + 90 s (the latest the CLI's
  jitter can fire) so the panel says when, and a `task.wake` `left-to-cli` row
  records it with the deadline. `wakeDue()` holds off on such a task
  (`cliWaitFor`), so a due mark never `proceed()`s into a session the CLI is
  driving, and a `running` row never loses its mark to the status test.
- **the CLI continued** (`cliContinued`): its continuation prompt reaching the
  `/prompt` route (`isCliAutoContinuePrompt`), its `quota_auto_resume_fired`
  notification, or the transcript growing past the refusal — whichever comes
  first — clears `wake_at` and writes `task.wake` `cli-resumed` with `via`.
  That prompt into an idle `review` session moves it to `running` as
  `system` (reason `cli auto-continue after usage limit`), not as `human`.
- **the server takes over** (`settleCliWaits` → `takeover`): the CLI said
  `_stale`/`_disabled` (`cli-abandoned` row), or the reset + 90 s + 3 min
  passed with the transcript still quiet. The sweep then ends and parks the
  session the server's way below; with the reset already past, the wake is
  due one grace from now.

A run that ends while left to the CLI drops the wait; a `wake_at` left on a
`review`/`failed` row is then the server's own wake, which is also what a
restart gets (the PTY is gone, so the CLI's wait is too). A CLI
continuation counts toward the streak cap like a server wake.

Not left to the CLI: a code with **no** stated reset (a weekly date, a message
we cannot place) — the CLI does not arm past 24 h, and we could not say when to
take over — and anything at the streak cap. Those park as below. The cost of
leaving: a live session keeps its worker slot and its repo until the reset,
which is moot while the account itself is out.

Rejected: `"autoContinueAtUsageLimit": false` in the worker `--settings`, to
keep one resume path. The CLI's continuation is the cheaper one — the same PTY,
no `--resume` re-buying the conversation — and the task asked that a session
the CLI will resume is not killed.

### Detection, first: the CLI's own `rate_limit` code

Workers inject a `StopFailure` hook (`docs/design.md` § Transient API errors),
and the CLI reports a turn the usage window refused as `error: 'rate_limit'` —
classified `usage-limit` by `classifyStopFailure()` and, before 2026-10-26,
simply left for this path to find. `onStopFailure` now **remembers it per run**
(`rateLimitStops`, in memory, with the hook's time and `error_details`).

That code is the strongest evidence there is: it is the CLI's own field on the
hook payload, and unlike terminal bytes nothing a repo contains — a `cat`, a
Write preview, an assistant quoting this file — can produce it. So when a run
has one, `assessLimitStall(…, { cliRateLimit })` **does not ask the position
test or the account veto** below; it still asks the permission-prompt test,
which only ever refuses. The reset time is read from `error_details` or the payload's
`last_assistant_message` — for a plan limit that IS the banner, `You've hit
your session limit · resets 3pm (Europe/Berlin)` — (`statedResetAt()`: the
epoch form, then a clock), else from a banner in the
last screenful (4k — one further up may be an earlier window's), and
`resolveWakeAt()` adds the account's clock when there is one and falls back to
a whole window. The `task.wake` `parked` row carries `basis: 'cli-code'` and
the code as `evidence`.

The code describes the session only until the session moves on: once the
transcript has grown more than 30 s (`RATE_LIMIT_SETTLE_MS`, the CLI writes the
refusal itself) past the hook, a human typed into it or a turn ran, and the
code is dropped — the banner rules apply again. It is also consumed by the
park and at run end (`handleExit`, where the exit path reads it too). The
quiet test, the `needsAttention` skip and every other sweep guard still apply.

`rate_limit` is not only the window: a server-side 429 ("Request rejected
(429)") and "Usage credits required for 1M context" report the same code, and
neither reopens at a reset. `rateLimitIsWindow()` deny-lists those two
messages (an unknown message is still the window, which is what the code says);
the `run.stop-failure` row records `message` and `window`.

A banner **without** the code still needs all of the evidence below. That is
deliberate: the code is the only thing that changed the forgery argument.

Why it had to be the code and not the account: the account reading was
supposed to be the corroboration, but the CLI writes `cachedUsageUtilization`
into `~/.claude.json` only on the `/usage` panel's fetch, which workers never
open — on the machine this was built on the key was absent, every window read
`source: "estimate"`, and all 7 `task.wake` decisions ever recorded were
`skipped: no-account-data`. Tasks sat 795 min after a `rate_limit` until a
human typed Proceed (decisions.md 2026-10-26).

### Detection: the terminal is the only witness

The limit banner is **chrome, not content**. The CLI renders it when the API
refuses; it is not an assistant message, so it never reaches the transcript
JSONL and therefore never reaches `lastAssistantText`, `RunStats`, or anything
else built from a transcript. The only place those bytes exist is the PTY's
own ring buffer.

So `Orchestrator.sessionTail(runId)` reads the last 16k of
`SessionManager.get(runId)?.buffer` — the first server-side read of a ring
buffer in the product; until now it only ever fed the WebSocket replay frame.
On exit the tail is captured **in the `onExit` callback**, before `handleExit`
runs, because a finished session can be disposed out from under us.

`parseLimitNotice()` strips ANSI first and matches after. That ordering is
load-bearing rather than cosmetic: the banner arrives colourised, and
`\x1b[31m5-hour limit reached` has no word boundary between the `m` that ends
the escape and the `5` that starts the message — anchored patterns would have
silently never fired on the one surface they exist for. (This was caught by
the verification script, not by review.)

The patterns are a set over plain text, not a parse of one envelope, because
the CLI states the limit differently by surface and version: the interactive
banner (`You've hit your session limit · resets 3pm (Europe/Berlin)` since
~2.1.2xx — session/weekly/model limits; the older `5-hour limit reached ·
resets 3pm`, which no pattern but its own matched until 2026-10-26), the machine form
(`Claude AI usage limit reached|1764950400`), prose (`Your limit will reset at
15:45`), and the raw `rate_limit_error`. `overloaded_error` and bare 429s are
deliberately **not** limit notices: they are transient and a retry fixes them,
so they have no reset time to wait for.

When several banners are in the buffer, the **last** one wins: a scrollback can
hold the banner from a window that has since reset.

### Matching the banner is not enough, and that is the point

Those bytes are whatever the terminal *displayed*. A `cat` of a file, a Write
preview, an assistant quoting a banner — all of it lands in the same buffer.
The paragraphs you are reading contain literal matches, so an agent editing
this very file and then dying would park itself and be resumed hours later at
the cost of a full context re-buy, for a task nobody asked to reopen. (An
earlier draft of this feature claimed the word `limit` was enough of an anchor
to prevent that. It is not: the quoted text contains the anchor. Adversarial
review R1 caught it.)

So `assessLimitStall()` requires **three things to agree**:

1. **position** — the banner sits inside the last **4000 characters** of the
   terminal, or the last **400** when the task is still `running` and acting on
   it means killing a live PTY. A refusal ends the turn, so nothing follows it;
   text that was merely printed is followed by the rest of the output that
   printed it.
2. **not a prompt** — the end of the terminal is not showing the CLI's
   permission dialog (`looksLikePermissionPrompt()`). A session at a prompt is
   waiting for a *human*, and the hunk it is previewing may be a file quoting a
   banner.
3. **the account** — its own live 5h window (`liveWindow(readAccountUsage()
   ?.session)`) reads at least **90%**. Not 100, because the CLI's cached
   figure is written when it last fetched `/usage` and may still hold the value
   from just before the final turn.

None of these is sufficient alone, and the account least of all: this feature
only matters when the window really is near-spent, so ≥90% is the *normal*
reading whenever this code can fire. It is a veto, not evidence.

With no usable account reading the answer is **no** — for a banner. The
original premise here ("the cache is refreshed only by interactive sessions,
but a worker *is* one, so a real refusal arrives with a fresh figure") was
false: the cache is written only by the `/usage` panel, so in practice there
is no reading and this branch vetoes every banner. It is kept for a banner
without the CLI's code, where declining to guess is still right; a real
refusal now arrives with the code instead (§ Detection, first).

A banner that was seen and rejected is written to the log as a `task.wake`
`action: 'skipped'` row carrying the reason (`banner-not-live`,
`awaiting-permission`, `account-not-exhausted`, `no-account-data`) — **once per
run**, not once per sweep. A wake-up that did not happen is a decision, not a
gap.

### The reset time: two clocks, and the later one wins

`resolveWakeAt()` takes what the notice said and what the account's own cache
says (`readAccountUsage()` via `usageSnapshot().fiveHour.resetsAt`) and picks
**the later**, plus `agent.autoWakeGraceSec` (default 60s).

Later, not sooner, because a premature wake is not free. A resume re-writes the
whole conversation to cache before the turn says a word
(`docs/token-budget.md` § The fourth) — on a large session that is real money,
and a resume that arrives one minute early pays it for a second refusal.
Waiting longer only costs waiting.

Both clocks are then bounded by the window itself: a stated time that cannot be
placed inside `(now, now + 5h]` is discarded rather than trusted (a misread
"3pm" is worse than no time at all), and the final answer is capped at
`now + 5h` so a stray weekly-window timestamp can never park a task for days.
With no usable clock at all the fallback is a full window from now — the only
honest upper bound.

### The state: one nullable column, no new status

`tm_tasks.wake_at` (migration 21, `Task.wakeAt`) is the whole state. There is
deliberately **no** new `TaskStatus`:

- a new member ripples through `TERMINAL_TASK_STATUSES`, every
  `transitionTask(from[])` array, `feature-sql.ts` and its JS twin,
  `queue-sql.ts`, the badges, and both Telegram renderers — a large edit to
  express "still `review`, and also waiting";
- and it would be a lie about where the work is. A task cut short at 70% *is*
  in review with a half-finished change in the tree. That the machine intends
  to reopen it is a schedule, not a status.

`review` and `failed` are also precisely the two statuses `proceed()` already
resumes from, so parking costs no transition at all.

(`waiting`, added 2026-09-07 — `docs/design.md` § Waiting — is the one real
status since, and it passes the second test where a wake does not: a session
with its own subagent still out is NOT in review, and every consumer that keys
off `review` would act on a turn that is not over. It paid the full ripple
listed above.) The status a turn landed
in is never rewritten by the parker, and neither is `error`: flattening `failed`
into `review` would hide a real nonzero exit behind a guess about its cause.

## The sweep

A third `.unref()`'d interval in the orchestrator's constructor, every 30s,
single-flighted by `wakeSweeping`. Its own cadence rather than a rider on the
10s claim tick, because it reads terminal buffers and the account cache and
nothing about it is urgent to the second. Gated whole on `agent.autoWake`.

**`parkStalledSessions()`** is the half with no exit to hang off: a turn that
hits the limit does not always die. The CLI prints the banner and drops back to
its prompt with the PTY alive — either still `running` with no Stop hook at
all, or settled into `review` by a Stop hook that fired over a turn which did
no work. Both shapes keep a live session, which is what this reads.

It is driven **from the runs, not the tasks**: a stall by definition still
holds a live PTY, and those are capped at `MAX_LIVE_SESSIONS`. Sweeping tasks
instead would mean re-reading every `failed` row the database has ever
accumulated, every thirty seconds, to find at most ten candidates.

There is deliberately **no `isIdle` test**, and an earlier draft that had one
could never fire. `markIdle()` has exactly one caller — the stop-hook route —
and it runs *after* the task has been transitioned out of `running`, so
"`running` and idle" is a state that cannot exist (adversarial review R1).
Quiet is measured on the **transcript** instead: `transcriptQuietMs()` reads
its mtime, and a `running` task whose transcript has moved inside
`STALL_QUIET_MS` (2 min) is thinking, not stuck. The transcript is the right
clock because it advances on every assistant message and tool result and,
unlike the terminal, is not rewritten by cursor redraws. A task already in
`review`/`failed` has finished by definition and needs no quiet test.

**A run flagged `needsAttention` is skipped outright.** That flag exists
because hidden terminals prompt (`docs/design.md` § Completion detection), and
a session waiting at a permission dialog is silent *by design*: it wrote its
assistant turn, then stopped, and it redraws nothing. It would pass the quiet
test forever. The run row already records that it is blocked on a human, so the
sweep believes it; killing that PTY would throw away the answer the agent is
waiting for, and `handleExit` would clear the flag on the way out, so nobody
would even know it had been asked (adversarial review R2). The prompt test in
`assessLimitStall()` covers the window before the Notification hook has landed.

That makes a FALSE flag expensive: it blocks the wake as surely as a real
prompt. The flag is therefore raised only for a prompt — the CLI's idle notice
(`idle_prompt`, which used to fire 60 s into every `waiting` park) and the other
non-prompt notification types are dropped at the route by their
`notification_type` (`docs/design.md` § Completion detection, decisions.md
2026-10-26).

Also skipped: publish runs (settled against git), tasks inside the resume gate
or a fired dispatch turn, and any run that is no longer its task's newest — all
of them have a different turn on the way.

**A live stall is ended, not parked in place.** Nothing resumes a `running`
task: `followUp` refuses it whether the session is live and busy ("the agent is
still working") or gone ("marked running but has no live session"). So
`endStalledRun()` marks the run `killed` **first** — which is what makes
`handleExit` leave the task alone when the PTY dies — kills it, audits a
`run.killed` row with `reason: 'usage-limit-stall'`, and transitions the task
to `review` with the reason in `error`. That is the same landing a clean exit
gets, and the one status this stall can be resumed from. Killing the PTY is
safe precisely because the session is resumable from disk; that is what the
wake-up then does.

**`wakeDue()`** resumes what is due, **one per pass**: a reset frees every
parked task at the same instant, and the concurrency cap should be the only
thing deciding how many run at once. Per task, in order:

- the **row is the truth, the map is a cache**. `wake_at` gone or moved → the
  map is corrected and nothing happens. This is what makes a human clicking
  Proceed cancel the pending wake-up for free: `startWorker` clears `wake_at`
  on every spawn, and `startWorker` is the single funnel every turn goes
  through (claim loop, `followUp`, `pumpCustomQueue`, `runNow`, dispatch).
- **status allow-list**, `WAKE_RESUMABLE_STATUSES = review | failed`. Anything
  else clears the mark: a task that was published, cancelled, retried or
  re-enqueued under a human's hand belongs to someone else now. `queued` is
  excluded even though `followUp` would accept it — waking it would jump the
  claim queue it was just put into — and `running` is excluded because a wake
  could never have worked from it, which is why a live stall is moved to
  `review` at park time rather than parked where it sits.
- the **global switch** stops the waker, except for custom-queue members, which
  are independent of it by design (`docs/queue.md`). The mark stays, so the task
  wakes the moment the switch comes back.
- the **concurrency cap** defers rather than over-fills, and the pass returns.
- then `proceed(taskId, null, 'system')` — the same call the button makes, so
  there is exactly one resume path in the product.

The mark is cleared **before** the resume, not after. `startWorker` clears it
too, but a resume that refuses for a reason of its own (no session left on
disk, the agent is genuinely working) must not leave a mark that fires again in
thirty seconds forever. A refusal is audited once and left to the human;
retrying a 409 every thirty seconds is how an audit log stops being readable.

### The streak cap: three wakes in a row, then the human

A WEEKLY limit's banner names a date (`resets Oct 30 …`), which `CLOCK_RE` does
not read and `resolveWakeAt()` could not honour anyway (it caps at one 5h
window). Parked on the code alone, such a task would be woken into the same
refusal every five hours for days. So `parkForUsageLimit()` first counts the
task's **consecutive** wakes (`consecutiveWakes()`): `task.wake` `resumed` rows
newer than its newest `task.transition` by anyone but the machine — a Stop
hook landing (`hook`), a human's Proceed/Retry, a Telegram press. The waker's
own resume and the stall's landing are `system` transitions, so a wake that
walks straight back into the limit never resets the count, and a turn that
lands normally always does.

At **3** (`WAKE_STREAK_CAP`) the task is not parked: no `wake_at`, the reason
goes in `error` ("…after 3 automatic wake-ups in a row — likely the weekly
limit…; Proceed resumes this session once the limit has reset"), and a
`task.wake` `action: 'handed-off'`, `reason: 'wake-cap'` row is written. A live
stall is still ended into `review` first, so it shows up in the inbox like any
other landing. Applies to both bases (code and banner) and both paths (sweep
and exit). A run whose stall was decided — parked or handed off — is not
re-assessed by later sweeps (`stallSettled`), since a `review` task can keep
its PTY and a handed-off one has no `wake_at` to skip it by.

## Crash recovery

The schedule survives a restart because it lives in the column, not the map.
`recoverOnBoot()` calls `reloadWakes()` **after** the stranded-task sweep — that
sweep is what moves any task left `running` into a status a resume accepts, and
`reloadWakes()` only scans `review`/`failed`.
A wake whose time passed while the server was down is due now, not dropped: the
window it was waiting for has certainly reopened.

## Settings

| key | default | meaning |
|---|---|---|
| `agent.autoWake` | `true` | the feature, whole. OFF = a spent window leaves the task where it landed, exactly as before. |
| `agent.autoWakeGraceSec` | `60` | extra wait past the stated reset. The account's boundary is not a promise of capacity at it. |

Both are in the **Agent** panel of `/config`, next to the resume-gate knobs
they interact with.

## What the human sees

- the task panel shows `waiting on the 5h usage window — this task's own
  session resumes automatically at 18:40` while `wake_at` is set;
- two `tm_events` rows per cycle, kind **`task.wake`**, actor `system`:
  `action: 'parked'` (with the wake time, both clocks, `basis` —
  `cli-code` or `banner` — the code's details or the matched banner line as
  `evidence`, and `wakesSoFar`) and `action: 'resumed'` — or `action:
  'failed'` with the refusal, or `action: 'handed-off'` when the streak cap
  hands the task back. A wake that did not happen is a decision in the log,
  never a gap.

## Knowingly left

- **The account reading is still the CLI's `/usage` cache.** A worker
  `statusLine` command writing the documented `rate_limits.five_hour`
  payload to a file would give `readAccountUsage()` a real source (and fix the
  usage pill and the router's `sessionUsagePct`, which run on estimates
  too). Not done here: it needs one real payload captured first, and
  `--settings` would override a repo's own `statusLine` for workers. With the
  code as the evidence the wake no longer depends on it.
- **The code and the CLI waits live in memory.** A restart between the
  StopFailure and the sweep loses the code; boot recovery then lands the task
  as before and a human Proceed resumes it. A restart during a CLI wait keeps
  `wake_at`, and the server wakes it.
- **"The CLI continued" is partly inferred**: the continuation prompt and the
  `_fired` notification are read from the bundle, not yet seen in a live
  worker. The transcript backstop assumes the CLI writes nothing to the
  transcript while it merely waits; if it ever does, the wait is recorded as
  `cli-resumed` early and a CLI that then fails to continue leaves the task as
  before this change (no worse).
- **A 429 `rate_limit` is not retried** like `overloaded`; it is only kept out
  of the wake path.

- **Publish turns are not parked.** A publish turn that dies is settled against
  git by `settlePublish()`, and `proceed()` would resume it as a work turn with
  the wrong instruction. It lands in `review` with its reason, as before.
- **Headless runs are not parked** (analyze, adversarial review, compaction,
  chat). They own no task lifecycle and each holds its own child's stdout;
  detection there would be a second, differently-shaped mechanism.
- **No pre-claim gate.** The claim loop does not refuse to start work at 100%;
  it starts, hits the banner, and parks. Refusing up front would need the
  percentage to be *sufficient* evidence on its own, and a stale cache would
  then stall the machine while capacity was actually available. Here it is only
  ever a **veto** on evidence the terminal already supplied — which is a much
  weaker thing to ask of it, and safe in the direction it fails.
- **No Telegram push.** The `task.wake` rows are there and the notifier already
  subscribes to `event.appended`; a phone message on park/resume is a small
  follow-on, not part of this.
