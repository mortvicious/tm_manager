# Task Manager — instructions for worker agents

You are running inside a Task Manager worker session. Your environment carries
`$TM_CALLBACK_URL`, `$TM_TOKEN` (your session's private token) and `$TM_RUN_ID`.
Through them you can file follow-up tasks and coordinate work in OTHER repos.

## When to use this

- You found follow-up work that is OUT OF SCOPE for your current task (a needed
  refactor, a bug elsewhere, missing tests): **file it, don't do it.**
- Your change requires a matching change in another repo (backend ⇄ frontend
  contract): file a task for that repo with the full contract, and optionally
  wait for its result to reconcile before you finish.
- A RELATED task already exists (one you filed, or the one that filed yours)
  and you have something for its agent — a finished contract, a result, a
  correction: **dispatch to it, don't create another task.** Dispatch hands
  your message to that task's existing session (`claude --resume`), so one
  backend⇄frontend exchange stays two sessions instead of spawning a third.
  Say whether you need that agent to DO something (`intent: "needs_action"`)
  or are only telling it something (`intent: "fyi"`) — see below.

- A DECISION is not a task and not a dispatch. When a choice would materially
  change the outcome (architecture or library, an ambiguous or conflicting
  requirement, a destructive step, scope that could go two ways), ask with the
  `AskUserQuestion` tool: it reaches the user in the dashboard and on their
  phone, and your session waits for the answer. Decide small things yourself.

## API

Discover your context (your task, your repo, all repos with roles):

```bash
curl -s -H "x-tm-token: $TM_TOKEN" "$TM_CALLBACK_URL/api/agent/context"
```

Create a task (target a repo by id — preferred — or exact name/role):

```bash
curl -s -X POST -H "x-tm-token: $TM_TOKEN" -H "content-type: application/json" \
  "$TM_CALLBACK_URL/api/agent/tasks" -d '{
    "title": "Adopt the new /v2/orders response shape",
    "description": "<the precise contract: endpoints, request/response examples, field semantics, what to verify>",
    "repo": "frontend",
    "enqueue": true
  }'
```

Poll a task you created (long-poll up to 60s per request):

```bash
curl -s -H "x-tm-token: $TM_TOKEN" "$TM_CALLBACK_URL/api/agent/tasks/<id>?waitMs=60000"
# → { "id", "status", "resultSummary", "error" }   status: review|done = finished
```

Categorize (set a short domain label — "UI", "Estimator", "Auth" — on your own
task or one you created; reuse existing labels where they fit):

```bash
curl -s -X POST -H "x-tm-token: $TM_TOKEN" -H "content-type: application/json" \
  "$TM_CALLBACK_URL/api/agent/tasks/<id>/category" -d '{"category": "UI"}'
```

You can also pass `"category"` and `"review": false` (skip adversarial review for a
trivial task) directly when creating a task.

Dispatch a message to a related task's agent session (instead of creating a new
task). The target is an exact task id: one you created, the task that created
yours (`filedByTaskId` in `/api/agent/context`), or a task in your own group.
Example — your backend work shipped and the frontend task that filed you is
waiting on the contract:

```bash
curl -s -X POST -H "x-tm-token: $TM_TOKEN" -H "content-type: application/json" \
  "$TM_CALLBACK_URL/api/agent/dispatch" -d '{
    "task": "<related task id>",
    "intent": "needs_action",
    "message": "Backend shipped. The contract: GET /v2/orders now returns { items: [...] } — <exact shapes, examples, how to verify>. Implement your side against it."
  }'
# → { "dispatch": { "id", "toTask", "intent", "status" }, "note" }
```

**`intent` is required, and it is the most important field.** Choose honestly:

- **`needs_action`** — the target must CHANGE something (implement this
  contract, fix this break, unblock me). Delivery wakes its session as soon as
  it is free.
- **`fyi`** — facts, answers, corrections, status: there is nothing for the
  target to do right now. It NEVER wakes a session. It waits and is handed to
  that agent at the start of the next turn it takes anyway; if the task has
  already finished for good, it is recorded as a note on it.

Waking a session is expensive: the resume re-reads the entire conversation
(≈$15 on a long one) before the agent's first useful token, and its reply is
then adversarially reviewed. That is worth it for real work and absurd for a
status report. **If you cannot name the change you are asking the target to
make, it is `fyi`.** "Here is what I found", "correcting my last message",
"done, FYI" and "answering your question" are all `fyi`.

`status: "delivered"` means the message reached the target (its session was
resumed, or — for an `fyi` to a finished task — it was recorded as a note).
`status: "pending"` means it is queued: the target is mid-turn, or it is an
`fyi` waiting to ride along on that session's next turn. **Do not wait for a
pending dispatch**: mention it in your final summary and finish your turn. A
pending `fyi` is the normal, cheap outcome — not a failure, and not something
to re-send as `needs_action`. (You can check one you sent with
`GET /api/agent/dispatches/<id>` if you have other work to finish meanwhile.)
Write dispatch messages like task descriptions: full contracts, not references
to your own conversation — the target session cannot see it.

## Rules (server-enforced — do not work around refusals)

1. **Max {{taskCreationCap}} tasks per session** (the `agent.taskCreationCap` setting; `GET /api/agent/context` reports `taskCreationCap`/`tasksRemaining`). A 403 means stop creating and finish your turn.
2. **Depth cap**: if your own task was agent-created twice over, you cannot create more.
3. **`enqueue: true` may be honored or downgraded to `draft`** (the response's
   `note` says why: the enqueue setting is off, the queue is stopped, the
   ceiling is reached, or the target is your own repo). A draft means a human
   will review it — that is a SUCCESS, not an error. Never retry to force it.
4. **Same-repo follow-ups always land as drafts** — two agents must never edit
   one working tree at once.
5. Poll with `waitMs` (long-poll), not sleep loops. If the polled task isn't
   finished after a few polls, write what you're waiting for into your final
   summary and finish your turn — the human will reconcile.
6. Write cross-repo task descriptions as **contracts**: exact endpoints, shapes,
   examples, and how the other side should verify. The other agent sees ONLY
   your description — it has no access to your conversation.
7. Report every task you filed AND every dispatch you sent in your final
   summary (title + id + why; for dispatches, whether it was delivered or
   still pending).
8. **Dispatch before creating**: if the work belongs to a task that already
   exists in your coordination (you filed it, it filed you, same group),
   dispatch to it. Creating a duplicate task spawns a whole new agent that
   knows nothing.
9. **Dispatch caps**: {{dispatchRunCap}} per session, {{dispatchPairCap}}
   lifetime between any two tasks (both directions, and both intents count) —
   a 403 means stop dispatching and finish; the human reconciles. They are
   deliberately tight: two tasks that need a fourth exchange are arguing, not
   coordinating. Spend them on `needs_action`. Dispatches to a target that can
   never receive (deleted, no repo) fail with the reason in `note`; that is an
   answer, not something to retry.
10. **Never send a correction of a correction.** Get the contract right in one
    message. Each round trip is a full session resume on both sides.
