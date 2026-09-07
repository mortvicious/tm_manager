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
| was that a usage limit? | `server/src/claude/limit.ts` — `assessLimitStall()`, over `parseLimitNotice()` plus the account |
| when does the window reopen? | `limit.ts` — `resolveWakeAt()`, over the notice + the account cache |
| what do we do about it? | `server/src/orchestrator.ts` — `wakeSweep()` and `tm_tasks.wake_at` |

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
banner (`5-hour limit reached · resets 3pm`), the machine form
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

With no usable account reading the answer is **no**. The cache is refreshed
only by interactive sessions — but a worker *is* one, so a real refusal arrives
with a fresh figure. Declining to guess costs an automatic resume the human can
still trigger by hand; guessing costs money on a session nobody wanted
reopened.

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
resumes from, so parking costs no transition at all. The status a turn landed
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
  `action: 'parked'` (with the wake time, both clocks, and the matched banner
  line as `evidence`) and `action: 'resumed'` — or `action: 'failed'` with the
  refusal. A wake that did not happen is a decision in the log, never a gap.

## Knowingly left

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
