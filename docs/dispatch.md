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
to_task_id, message, status, note, created_at, delivered_at`. No foreign keys
on purpose (like `tm_events`): a dispatch outlives the deletion of either task;
delivery to a deleted target settles it as `failed` with the reason.

Statuses: `pending` (queued, target busy) → `delivered` | `failed` |
`cancelled`. Settling is a conditional `WHERE status = 'pending'` update
(`settleDispatch`), so the delivery loop, the human cancel route and a racing
tick can never settle one dispatch twice.

## Agent API

- `POST /api/agent/dispatch` `{ task: "<exact task id>", message }` — auth is
  the per-run token, same as the rest of the agent API.
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

**Caps** (server-enforced, like the task-creation caps): 5 dispatches per run,
and 8 lifetime between any two tasks counted in BOTH directions. The pair cap
is the one that actually terminates A⇄B echo loops — every delivery creates a
*new* run on the target, so a per-run cap alone would reset each round.

## Delivery

`Orchestrator.deliverDispatches()` — single-flight, riding `maybeSchedule()`
(every finished turn, every 10s safety tick) plus an immediate attempt right in
the dispatch route so a free target gets the message synchronously.

Per target, all pending dispatches are delivered as ONE resumed turn
(`buildDispatchTurn`, oldest first), through the normal `followUp()` path —
which resumes the target's previous session when one is on disk and falls back
to a respawn-with-summary otherwise. Delivery holds (stays `pending`, retried
on later ticks) while the target:

- is `running`, `queued`, or `blocked`;
- has a live non-idle session, or any agent is live in its repo (never two
  agents editing one working tree);
- would exceed `orchestrator.concurrency` (delivery is a real agent turn).

It settles `failed` immediately only when the target can never receive: task
deleted, or no repo. Two deliberate policy decisions:

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
  one) — capped at 3 rows, essentials mode shows pending only. The sender row
  carries an accented `⇢ n pending` chip while its dispatches wait. A
  `dispatches: any / has dispatches / pending dispatches` filter joins the
  board bar whenever any dispatch exists.
- **Task panel**: a *Dispatches* section shows both directions with full
  message text.

All styling resolves to existing `--tm-*` tokens (`--tm-accent`,
`--tm-status-failed`, borders/text scale) — no new tokens were needed.

## Worker prompting

`STANDING_RULES` and `RESUME_REMINDER` (`claude/worker.ts`) tell every worker
to dispatch to an existing related task instead of creating a duplicate;
`docs/agent-instructions.md` (served at `/api/agent/instructions`) carries the
curl how-to, the "write contracts, not references to your own conversation"
rule, and the caps.
