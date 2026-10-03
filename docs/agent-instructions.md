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

- Tasks you file for one change belong together: **group them** (see
  Grouping tasks). A task that is already carried out or has been replaced:
  **close it** (see Closing tasks) instead of writing "please mark done" in
  your summary.

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

## Grouping tasks

A **group** is one task tree: a root task and everything under it, drawn as one
block on the board. Grouping is not cosmetic. Tasks in one group **run in
order** (the queue takes the group root first, then its members in board order),
and **a group is a coordination channel**: any task may dispatch to a task in its
own group. Group work that belongs together:

- the tasks you file for ONE change (a backend task and its frontend
  follow-up, or the steps of one migration), together with your own task, so
  each agent can dispatch to the others;
- an existing task that your task replaces or continues, so the human reviews
  them side by side.

Do not group unrelated follow-ups just because you filed them, and never use
grouping to jump the queue.

```bash
curl -s -X POST -H "x-tm-token: $TM_TOKEN" -H "content-type: application/json" \
  "$TM_CALLBACK_URL/api/agent/tasks/<id>/move" -d '{"place": "into", "targetId": "<task id>"}'
# → { "task": { "id", "parentId", "groupId", "groupPath" } }
```

`place` is the board's drag and drop:

| place | effect |
|---|---|
| `into` | join the target's group flat (right after the target; a lone target becomes the root of a new group). **The usual choice.** |
| `group` | append to the end of the target's group |
| `child` | become the target's last child, nested under it |
| `before` / `after` | sit beside the target as its sibling (reorders, and joins its group) |
| `ungroup` | leave the group and become a root again (no `targetId`) |

The subtree always moves with the task. Typical flow: file the follow-up with
`POST /api/agent/tasks`, then move it `into` your own task (`taskId` from
`/api/agent/context`). Both the moved task and the target must be **within
your reach** (see Closing tasks). Refusals: 403 out of reach. 409 when the
move would put a task under a `blocked` split parent, which waits on every
child. Use `linkToParent` on create for a split sibling instead. Also 409 when
it would pull a child out from under one. Names and colours of groups stay
the human's.

## Closing tasks that need no run

When a task is **already carried out** (your work or someone else's covered
it), or has been **replaced or made unnecessary**, close it instead of asking
the human to:

```bash
curl -s -X POST -H "x-tm-token: $TM_TOKEN" -H "content-type: application/json" \
  "$TM_CALLBACK_URL/api/agent/tasks/<full task id>/close" -d '{
    "status": "done",
    "reason": "Carried out by 4d6ad9c6 (commit 1a2b3c4): fresh access before saved-search calls"
  }'
# → { "task": { "id", "status" }, "via": "<why it was within your reach>" }
```

- `"status": "done"` means the work already exists, and `"cancelled"` means it
  was replaced or is not needed. `reason` is required: it is the evidence (a
  commit, a task id, the replacing task) and goes into the task's summary and
  the audit log.
- **Only parked tasks**: `draft`, `queued`, `failed`, or `review` with no
  automatic review round open. A `running`/`waiting` task has a live turn and
  is the human's to cancel. A `blocked` split parent is resolved by its
  children. Your own task lands on its own. Never close it.
- **Your reach** is a task you filed, the task that filed yours, your group,
  your repo, a repo of your shared space, or a task that your human-written
  brief names by id. Anything else answers 403. Mention it in your summary for
  the human.
- Be sure before you close. Verify the work is really there (read the code or
  the commit), not only that some other task claims it. Max {{closeRunCap}}
  closes per session.
- List every task you closed or moved in your final summary (id + why).

## Shared space (repos that work on one product)

If `GET /api/agent/context` shows a `sharedSpace`, your repo belongs to a set of
repos (for example a backend and its frontends) that share a knowledge folder,
`$TM_SHARED_DIR`, and a ledger of cross-repo **requests** and **notes**. Other
repos' agents never read your conversation or your `$TM_ARTIFACTS_DIR`, so
this is how they learn anything from you:

- **Read before you plan.** A copy of `INDEX.md` is in your context (the
  folder's `CLAUDE.md`). Before your plan, read the files it points to for your
  task's area, plus your repo's page under `repos/`. Your plan names what you
  read, or says none apply. What other repos shipped, decided or left unpushed
  lives there, not in your repo's history.
- **Knowledge** goes into the folder: `knowledge/<topic>.md`, `repos/<repo>.md`.
  Keep `INDEX.md` current. `README.md`, `REQUESTS.md` and `CLAUDE.md` are
  generated, so do not edit them.
- **Work another repo must do** because of your change or finding is a
  **request**. Write one instead of a report nobody reads. The target repo's
  next agent sees it at the start of its task, checks it and files it:

```bash
curl -s -X POST -H "x-tm-token: $TM_TOKEN" -H "content-type: application/json" \
  "$TM_CALLBACK_URL/api/agent/shared/notes" -d '{
    "kind": "request",
    "to": "<repo name, id or role>",
    "title": "Adopt the new `status` field on GET /v2/orders",
    "body": "<the contract: what changed, exactly what to do, examples, how to verify>",
    "files": ["knowledge/api-contracts.md"]
  }'
```

  A `note` (`"kind": "note"`, `to` optional) is durable knowledge for every
  member. There is a cap of {{sharedNoteRunCap}} per session. A duplicate
  open request answers 409 with the id of the existing one: add to that one
  instead (`POST …/shared/notes/<id>/append {"text": "…"}`).
- **Requests addressed to YOUR repo** are listed at the top of your task. Also
  run `GET /api/agent/shared`. Triage them before you finish, but never
  instead of your task:
  - **Already done here?** Resolve it with the evidence:
    `POST …/shared/notes/<id>/resolve {"status":"done","resolution":"<commit/file/endpoint>"}`.
    Use `"dismissed"` when it is not needed.
  - **Not done?** File it: `POST …/shared/notes/<id>/file {}`. This creates the
    task in YOUR repo and puts it in the serial custom queue. It starts only
    once your task is published, done or cancelled and nothing else in this
    repo is working, even while the global queue is stopped. It still counts toward your
    creation and depth caps. If `agent.allowEnqueue` is off or the agent
    queue is full, it lands as a draft, and the `note` says so. Do not
    implement it inside your current task unless it is squarely in scope.
  - The request closes by itself when that task lands done/published.
- Mention every request you wrote, filed or resolved in your final summary.

## Rules (server-enforced — do not work around refusals)

1. **Max {{taskCreationCap}} tasks per session** (the `agent.taskCreationCap` setting; `GET /api/agent/context` reports `taskCreationCap`/`tasksRemaining`). A 403 means stop creating and finish your turn.
2. **Depth cap**: a task {{maxSpawnDepth}} agent hops from a human (`spawnDepth` in `/api/agent/context`, next to `maxSpawnDepth`) cannot create more.
3. **`enqueue: true` may be honored or downgraded to `draft`** (the response's
   `note` says why: the enqueue setting is off, the queue is stopped, the
   ceiling is reached, or the target is your own repo). A draft means a human
   will review it — that is a SUCCESS, not an error. Never retry to force it.
4. **Same-repo follow-ups always land as drafts** — two agents must never edit
   one working tree at once. (The one exception is filing a shared-space
   request addressed to your repo — see below: that task goes to the serial
   custom queue, which holds it until your task is published, done or
   cancelled.)
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
