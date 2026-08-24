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

## Rules (server-enforced — do not work around refusals)

1. **Max 5 tasks per session.** A 403 means stop creating and finish your turn.
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
7. Report every task you filed in your final summary (title + id + why).
