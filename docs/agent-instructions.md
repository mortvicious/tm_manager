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
    "message": "Backend shipped. The contract: GET /v2/orders now returns { items: [...] } — <exact shapes, examples, how to verify>. Implement your side against it."
  }'
# → { "dispatch": { "id", "toTask", "status" }, "note" }
```

`status: "delivered"` means the target session was resumed with your message.
`status: "pending"` means the target agent is mid-turn — delivery is automatic
the moment it is free. **Do not wait for a pending dispatch**: mention it in
your final summary and finish your turn. (You can check one you sent with
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
9. **Dispatch caps**: 5 per session, 8 lifetime between any two tasks (both
   directions) — a 403 means stop dispatching and finish; the human reconciles.
   Dispatches to a target that can never receive (deleted, no repo) fail with
   the reason in `note`; that is an answer, not something to retry.
