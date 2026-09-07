# Dispatch — agent-to-agent messages without new tasks

## Why

Cross-repo coordination used to have exactly one primitive: *create a task*.
That works for the first hop (frontend agent files a backend task with the
contract), but every subsequent exchange spawned another agent from scratch:
"backend shipped, now implement your side" became task number three, run by a
session that knows nothing the frontend session already learned. One
conversation between two repos could fan out into a pile of tasks.

**Dispatch** is the second primitive: hand a message to a RELATED task's
*existing* agent session. Delivery reopens that task's own claude session
(`claude --resume`, the same machinery as Proceed/Publish), so the exchange
stays two sessions total — the frontend agent that started with the design and
the backend agent that built the endpoint — however many rounds it takes.

The motivating scenario:

1. Task "Fix UI to new design" (frontend) runs; a piece of data is missing from
   the API. It **creates** a backend task carrying the exact contract, notes
   what it is waiting on, and finishes its turn.
2. The backend task runs and ships the field. Instead of creating a
   "frontend: adopt the new field" task, it **dispatches back** to the frontend
   task: *"backend shipped, here's the contract, implement"*.
3. The frontend task's session — which still remembers the design, the file it
   left the TODO in, everything — is resumed with that message and finishes the
   job.

## Data model

Migration 15, table `tm_dispatches`: `id, from_task_id, from_run_id,
to_task_id, message, status, note, created_at, delivered_at`, plus `intent`
(migration 18). No foreign keys on purpose (like `tm_events`): a dispatch
outlives the deletion of either task; delivery to a deleted target settles it
as `failed` with the reason.

`intent` is `NOT NULL DEFAULT 'needs_action'` — the one form of NOT NULL that
`ALTER TABLE ... ADD COLUMN` accepts in both dialects, and the default that
makes every pre-existing row keep exactly the behaviour it was created under.

Statuses: `pending` (queued, target busy) → `delivered` | `failed` |
`cancelled`. Settling is a conditional `WHERE status = 'pending'` update
(`settleDispatch`), so the delivery loop, the human cancel route and a racing
tick can never settle one dispatch twice.

## Agent API

- `POST /api/agent/dispatch` `{ task: "<exact task id>", intent, message }` —
  auth is the per-run token, same as the rest of the agent API. `intent` is
  **required** (see § Intent).
- `GET /api/agent/dispatches/:id` — poll one this run sent.
- `GET /api/agent/context` reports `dispatchCap` / `dispatchesSent` /
  `dispatchesRemaining` and `filedByTaskId` (the task whose session filed
  yours — the natural dispatch-back address; the delivered message also carries
  the sender's full task id for the same reason).

**Relationship gate** — a session may dispatch only to tasks it is already
coordinating with: a task any run of its task filed, the task that filed its
task, or a task in its own group (parent/children/siblings share `group_id`).
Anything else answers 403 with "file a task instead": dispatch extends an
existing coordination, it never starts one with a stranger.

**Caps** (server-enforced, like the task-creation caps): 2 dispatches per run,
and 3 lifetime between any two tasks counted in BOTH directions. The pair cap
is the one that actually terminates A⇄B echo loops — every delivery creates a
*new* run on the target, so a per-run cap alone would reset each round.

Both were lowered (from 5 and 8) by the token audit of 2026-08-31..09-01,
`docs/token-budget.md`: the two auth tasks `0cb8555a ⇄ a5d9442a` spent their
whole allowance of 8 on status reports and corrections of corrections, one of
which produced *zero code change* for ~$23. Three exchanges is enough to hand
over a contract; past that the pair is arguing, and a human should be looking.
Both intents count against both caps — an `fyi` is cheaper, not free, and the
ping-pong guard has to bound the conversation, not just its expensive half.

## Intent

Every dispatch declares what it wants, and that decides whether delivery may
**wake** a session:

| intent | meaning | delivery |
| --- | --- | --- |
| `needs_action` | the target must change something | resumes its session as soon as it is free — unchanged behaviour, including a target sitting in `review` |
| `fyi` | facts, answers, corrections; nothing to do right now | **never starts a turn** |

The reason is measured, not stylistic. A delivery resumes the target's claude
session, and a resume re-writes the WHOLE conversation to cache twice — 395k +
398k tokens on a 400k session, ≈$15 — before the agent's first useful token.
The reply then Stops, which lands in the adversarial reviewer, possibly for
another fix round. That is the correct price for "implement your side against
this contract" and an absurd one for "FYI, I renamed the field".

A pending `fyi` waits for a resume that was going to happen anyway — a review
round, Proceed, a `needs_action` dispatch, publish, an unblock — and is
prepended to that turn ahead of any `needs_action` block. It is context the
turn did not exist for, and `buildDispatchNote` (`claude/worker.ts`) says so in
as many words, so the agent does not treat it as a fresh instruction and
manufacture the wake-up this split just removed.

If the target is already `done`, `published` or `cancelled`, no session is ever
opening again: the `fyi` is settled `delivered` with the reason as its note and
recorded as a `task.dispatch` event on the task — a note, not a run. That check
runs BEFORE the hold checks below, since writing a note needs no agent, no repo
lock and no concurrency slot. `failed` is deliberately NOT in that set (it is in
`TERMINAL_TASK_STATUSES`, which is why this list is its own constant): a failed
task is the one terminal-looking status a human routinely retries, and the
`fyi` should still be waiting when they do.

## Delivery

`Orchestrator.deliverDispatches()` — single-flight, riding `maybeSchedule()`
(every finished turn, every 10s safety tick) plus an immediate attempt right in
the dispatch route so a free target gets the message synchronously.

Per target, all pending `needs_action` dispatches are delivered as ONE resumed
turn (`buildDispatchTurn`, oldest first), through the normal `followUp()` path
— which resumes the target's previous session when one is on disk and falls
back to a respawn-with-summary otherwise. A target whose pending dispatches are
ALL `fyi` is skipped outright: no `followUp`, no run, nothing to hold.

**That `followUp` is fired, not awaited** (2026-09-05). It used to be awaited,
and that was fine while the wait was bounded by `waitForSessionExit` (5s) plus a
synchronous spawn. The resume gate (`docs/token-budget.md` § The fourth) can put
a ten-minute compaction inside it, and this loop runs inside `maybeSchedule()`'s
single-flight pass — so awaiting would stop the claim loop, `pumpCustomQueue()`
and every other delivery for that long, with the 10s tick only able to set
`rescheduleRequested`. The target is instead held in `dispatchTurnsInFlight`
(taskId → repoId) for the whole turn-start, which is what the redelivery guard,
the "no second turn in this repo" guard and `activeWorkers()` read; the dispatch
is settled from the promise's result exactly as before, just later. The
completion handler deliberately does NOT wake the scheduler: an ABORTED turn
(shutdown, `/killall`) parks its task back in `review`, and waking a pass right
there would re-deliver it and start a fresh compaction seconds after an
emergency stop.

The ride-along is implemented in **`startWorker()`**, not in the delivery loop
and not in `followUp` — `startWorker` is the single funnel EVERY turn goes
through. `followUp` covers only the resumes (Proceed, publish, a review round,
an unblock, dispatch delivery); the claim loop, `pumpCustomQueue()` and
`runNow()` call `startWorker` directly with no follow-up at all. Draining one
layer up therefore missed Enqueue, Retry, Run now and a custom-queue claim,
which is exactly how an `fyi` could ride out a whole turn unseen and only
surface on a later Proceed, after the work it should have informed (review
round 1, major). `pendingFyiDispatches(taskId)` returns the block and the
settle that goes with it: read BEFORE the spawn (it has to be in the prompt),
settled only AFTER the spawn succeeded — a worker that never started showed the
agent nothing, so its messages stay `pending` for the next attempt. The settle
carries its own `try`/`catch`, because bookkeeping must never fail a worker
that is already running.

One consequence worth naming: a task that has never run can hold a pending
`fyi` (delivery refuses to start a never-ran draft — see below), and the first
turn a human or the queue gives it now carries that message. That is the rule
working, not an exception to it: the `fyi` still did not start anything.

The backlog travels as its own `dispatchNote` option on `buildWorkerInvocation`
and is deliberately NOT concatenated onto `followUp`: the publish turn is
recognised by `followUp === PUBLISH_INSTRUCTION` (strict identity), so
appending to that string would silently demote every publish turn to an
ordinary one. It is also placed FIRST in the prompt and never last — the last
thing a resumed agent reads has to stay the instruction it must act on.

Delivery holds (stays `pending`, retried on later ticks) while the target:

- is `running`, `queued`, or `blocked`;
- has a live non-idle session, or any agent is live in its repo (never two
  agents editing one working tree);
- would exceed `orchestrator.concurrency` (delivery is a real agent turn).

It settles `failed` immediately only when the target can never receive: task
deleted, or no repo. (An `fyi` to a `done`/`published`/`cancelled` target
settles `delivered`-as-a-note instead — see § Intent.) Two deliberate policy
decisions:

- **A draft that never ran is not deliverable.** Delivering would *start* it —
  which would let an agent bypass the enqueue gate by filing a draft and
  dispatching to it. It becomes deliverable after a human (or the queue) runs
  it once.
- **Delivery ignores the `orchestrator.enabled` toggle** (user decision
  2026-08-27). A dispatch continues a conversation that already exists —
  exactly like a human follow-up, which also works with the queue stopped. The
  queue toggle keeps meaning "claim no new tasks".

## Human surface

- `GET /api/dispatches?taskId=&status=` and `POST /api/dispatches/:id/cancel`
  (pending only) in `routes/tasks.ts`; `dispatch.updated` on `/ws/events`;
  audit kind `task.dispatch` (created/delivered/failed/cancelled phases).
- **Board**: incoming dispatches render as a compact accented strip under the
  receiving task's row (direction glyph, sender link, one-line message, pulsing
  `pending` / muted `delivered` / red `failed`, age, ✕ to cancel a pending
  one) — capped at 3 rows, essentials mode shows pending only. An `fyi` row
  carries an `fyi` chip and drops the pulse on its `pending` label: it is not
  waiting on anybody, so it must not read as something that is due. The sender row
  carries an accented `⇢ n pending` chip while its dispatches wait. A
  `dispatches: any / has dispatches / pending dispatches` filter joins the
  board bar whenever any dispatch exists.
- **Task panel**: a *Dispatches* section shows both directions as
  collapsible entries — direction, peer, intent, status, age and the first
  line of the message on one row; the whole message (pre-wrapped) when the
  row is opened. The newest starts open, one is open at a time — the same
  shape as the review rounds above it (`docs/design.md` § Adversarial
  review), so the panel reads as one list of things that happened to the
  task rather than a wall of message text.

All styling resolves to existing `--tm-*` tokens (`--tm-accent`,
`--tm-status-failed`, borders/text scale) — no new tokens were needed.

## Worker prompting

`STANDING_RULES` and `RESUME_REMINDER` (`claude/worker.ts`, documented in full
in `docs/worker-prompt.md`) tell every worker
to dispatch to an existing related task instead of creating a duplicate;
`docs/agent-instructions.md` (served at `/api/agent/instructions`) carries the
curl how-to, the "write contracts, not references to your own conversation"
rule, the `intent` choice, and the caps — the cap numbers are substituted from
`DISPATCH_RUN_CAP`/`DISPATCH_PAIR_CAP` at request time (`{{dispatchRunCap}}` /
`{{dispatchPairCap}}`, the same trick `{{taskCreationCap}}` already used), so
the sheet cannot drift from the constants again.
