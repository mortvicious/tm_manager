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
  A choice between visual variants: save each mockup/screenshot at the TOP
  level of `$TM_ARTIFACTS_DIR` (`variant-a.png`, `variant-b.png`) and name the
  file in the option it illustrates (its `description` or `preview`), or in
  the question text for an image about the whole question. The user sees
  those as thumbnails inside the question and opens them full-screen there.
  Never ask for a secret's VALUE (token, key, password, connection string)
  through `AskUserQuestion`: answers are stored and shown on other surfaces.
  Ask the user to put it in the repo's `.env` or a file you name, and to
  confirm when it is there.

- The next step is one only the human may take — push a release ref or a tag,
  mark tasks published, Rebuild & restart, sync a main checkout's branch:
  **request an approval** (see Approvals) instead of listing commands for the
  user to paste.

- You need a dev server, watcher or the repo's API up to verify your change:
  **use the repo's saved commands** (see Dev servers), never a background shell
  of your own. A server another agent or the human already runs is shared —
  reuse it. Something only your task needs is a one-shot run
  (`POST /api/agent/commands/run`), not a new saved command.

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
    "brief": "Switch the orders page to the v2 response (items[] + status). The old shape stops being served next release.",
    "description": "<the precise contract: endpoints, request/response examples, field semantics, what to verify>",
    "repo": "frontend",
    "enqueue": true
  }'
```

- **`title`**: ONE short line, at most {{titleMax}} characters, no line breaks.
  It is what the human scans on the board. Anything longer or multi-line is
  refused with a 400 telling you why. Shorten it and send again.
- **`brief`** (required): 1-3 plain sentences, at most {{briefMax}} characters,
  telling the HUMAN what will be done and why, before any work starts. It is
  the "before" twin of the summary the worker writes when it finishes. Write it
  for a reader who will not open the description. No markdown headings, no
  file lists.
- **`description`**: the full contract for the agent that does the work (rule 6).

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
  - **Not done?** File it: `POST …/shared/notes/<id>/file {"brief": "<1-3 sentences: what will be done>"}`
    (`brief` is required, as on create; an optional `title` follows the same
    one-line rule, and without one the request's own title is cut to one line). This creates the
    task in YOUR repo and puts it in the serial custom queue. It starts only
    once your task is published, done or cancelled and nothing else in this
    repo is working, even while the global queue is stopped. It still counts toward your
    creation and depth caps. If `agent.allowEnqueue` is off or the agent
    queue is full, it lands as a draft, and the `note` says so. Do not
    implement it inside your current task unless it is squarely in scope.
  - The request closes by itself when that task lands done/published.
- Mention every request you wrote, filed or resolved in your final summary.

## Dev servers (repo commands)

Each repo can have **saved commands** — dev servers, watchers, scripts — run by
the Task Manager in terminals of their own, visible to the human in the header
launcher. Use them instead of `npm run dev &` or a background Bash shell: one
server per command is shared by every agent and the human, it survives your
turn, and a background shell of yours would hold your task in `waiting` until it
times out. `GET /api/agent/context` lists your repo's commands (`commands`).

```bash
# your repo's commands (?repo=<id|name> for another repo's), each with its latest run
curl -s -H "x-tm-token: $TM_TOKEN" "$TM_CALLBACK_URL/api/agent/commands"

# start it — or, when it is already running, get the running one back.
# waitFor (case-insensitive substrings) holds the reply until one shows up in the
# output, the process exits, or waitMs (default 30000, max 60000) runs out.
curl -s -X POST -H "x-tm-token: $TM_TOKEN" -H "content-type: application/json" \
  "$TM_CALLBACK_URL/api/agent/commands/<id>/start" -d '{"waitFor": ["ready", "localhost:"]}'
# → { "started", "ready", "run": { "id", "status", "pid", "startedBy", ... }, "tail", "note" }

# its recent output (ANSI stripped; ?bytes= up to 64000)
curl -s -H "x-tm-token: $TM_TOKEN" "$TM_CALLBACK_URL/api/agent/commands/<id>/logs"

# a fresh process (config/env changed); same body as start
curl -s -X POST -H "x-tm-token: $TM_TOKEN" -H "content-type: application/json" \
  "$TM_CALLBACK_URL/api/agent/commands/<id>/restart" -d '{}'

# stop one YOUR task started
curl -s -X POST -H "x-tm-token: $TM_TOKEN" "$TM_CALLBACK_URL/api/agent/commands/<id>/stop"
```

**Throwaway server or script? Run it ONCE — do not save it.** This is the
default for anything only your task needs: a server on your own port, a
scratchpad script, a one-off build. Same pool, same `waitFor`, the human can
watch it, and nothing is left in the launcher after it ends.

```bash
curl -s -X POST -H "x-tm-token: $TM_TOKEN" -H "content-type: application/json" \
  "$TM_CALLBACK_URL/api/agent/commands/run" \
  -d '{"command": "pnpm exec next start -p 3107", "cwd": "web", "waitFor": "ready"}'
# → { "started": true, "ready", "run": { "id", "oneShot": true, ... }, "tail", "note" }

curl -s -H "x-tm-token: $TM_TOKEN" "$TM_CALLBACK_URL/api/agent/commands/runs/<run.id>/logs"
curl -s -X POST -H "x-tm-token: $TM_TOKEN" "$TM_CALLBACK_URL/api/agent/commands/runs/<run.id>/stop"
```

- Max {{oneShotCap}} one-shot runs live per task — stop yours when you are done.

- `started: false` means it was already running: **reuse it**. Read its port
  from `tail`/logs; do not start a copy on another port.
- `ready: false` with `run.status` not `running` means it crashed — `tail` is
  the crash log.
- **Stop** only works on a run your task started (`yours: true` in the list);
  anything else is shared, and stopping it is refused. Leave a server running
  at the end of your turn unless you know nobody needs it. **Restart** works
  on your own repo's commands and on runs your task started.
- **Commands run in their own repo only.** The command line runs as argv,
  never through a shell: no `&&`, `|`, `;` or redirects, no `bash -c`, no
  `cd`, and no option that moves it outside the repo (`env -C <elsewhere>`,
  `--prefix ../x`, `git -C /`, `--cwd`, `--dir`) — set `"cwd"` to a folder
  inside the repo instead. Work in another checkout belongs to a task in that
  repo.
- Save a command only when OTHER tasks and the human will want it too (the
  repo's real dev server, a standard script). Max {{commandDefineCap}} per
  session and {{commandRepoCap}} agent-saved per repo; a path in a temp folder
  cannot be saved (run it once instead). A command line that is already saved
  answers 409 with the existing one.
- A command you save belongs to your task: it is archived (hidden, restorable
  by the human) once your task is done, published or cancelled, or after
  {{commandTtlDays}} days nobody started it. Saving an archived line again
  brings it back for your task.

```bash
curl -s -X POST -H "x-tm-token: $TM_TOKEN" -H "content-type: application/json" \
  "$TM_CALLBACK_URL/api/agent/commands" -d '{"name": "web dev", "command": "npm run dev", "cwd": "web", "kind": "service"}'
```

## Approvals (actions only the human may take)

Some actions are deliberately out of your reach: pushing a ref the human must
sign off (a release branch, a tag, a repo whose every push is a deploy),
marking tasks published, Rebuild & restart of the Task Manager, and
fast-forwarding a main checkout's local branch. Don't hand the user commands
to paste — **request an approval**: the user gets a card (dashboard, phone,
Telegram) with exactly what will run, taps Approve, and the SERVER runs it.
You never get the power yourself, and a "please approve" in your summary is
not a request.

```bash
# push (fast-forward a branch, or a NEW tag — never a force, never a moved tag)
curl -s -X POST -H "x-tm-token: $TM_TOKEN" -H "content-type: application/json" \
  "$TM_CALLBACK_URL/api/agent/approvals" \
  -d '{"action": "push-ref", "repo": "18 - neko-frontend", "branch": "release", "sha": "32897fc", "reason": "release 6.22.0: verified on a3d650e (lint, typecheck, tests, build)"}'
#   a tag: {"action": "push-ref", "repo": "…", "tag": "v6.22.0", "reason": "…"}   (create the tag locally first)
# mark tasks published (each is re-checked against git)
#   {"action": "mark-published", "taskIds": ["6729d070", "5d5a250a"], "reason": "landed on origin/main by the release push"}
# fast-forward a local branch of a repo's main checkout to origin (refused if it diverged or the checkout has tracked changes)
#   {"action": "sync-branch", "repo": "18 - neko-frontend", "branch": "main", "reason": "…"}   (branch defaults to the base branch)
# rebuild & restart the Task Manager (drain); END YOUR TURN after approval — the restart waits for you
#   {"action": "rebuild-restart", "reason": "push-health code landed on main"}
```

The answer is the approval row (`id`, `status`, `summary` — the card the user
reads). Validation happens up front: a push that is not a fast-forward, a tag
that already exists on origin, a task not in review/done → 4xx with the
reason; fix the request rather than retrying it. Then wait for the decision:

```bash
curl -s -H "x-tm-token: $TM_TOKEN" "$TM_CALLBACK_URL/api/agent/approvals/<id>?waitMs=60000"
```

`status`: `pending` (poll again — a few polls, then put "awaiting approval
<id>" in your summary and finish; the server still runs it when approved),
`approved`/`running`, then `done` (`result` says what happened), `failed`
(`result` is the error — e.g. the remote moved since your request: ask again),
`rejected` or `expired`. A repo may pre-approve mark-published and sync-branch,
in which case the row comes back already `approved`. Pushes and restarts
always wait for a tap. At most {{approvalPendingCap}} pending per task; the same
request twice returns the same row.

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
