# Design: Agent Task API + cross-repo coordination

Status: **IMPLEMENTED 2026-08-24** — design approved by adversarial review with 11 required changes (R1–R11), all applied: overflow claim credit, restricted linkToParent (blocked parents + honored enqueue only), conditional failed-branch, depth inheritance through splits, per-run tokens (the token IS the identity for hooks + agent API), enqueue behind `agent.allowEnqueue` (default OFF) + same-repo-always-draft, read scoping + waitMs long-poll, global queued-agent ceiling (10) with draft degradation, maybeSchedule wake, Board/slide-over provenance chips, priority pinned 0.

**Honesty note (from the review): these caps are cooperative guardrails for steered-but-honest agents, not a containment boundary** — a malicious process with a shell on this host could always hit the public loopback API; the guards ensure the documented path an injected agent follows always lands in front of a human.

Verified live: a sonnet worker fetched /api/agent/instructions and filed a task — landed as draft, createdByRun set, spawnDepth 1.

## Problem

Workers are currently leaf executors: they can only work on the task they were given. Two capabilities are missing:

1. **Agents creating tasks.** A worker that discovers follow-up work (a refactor it shouldn't do mid-task, a bug in an adjacent module, a missing test suite) has nowhere to put it except its final summary, where it dies.
2. **Cross-repo coordination.** A backend worker in `neko-nest` that changes an API contract needs the matching frontend change in `neko-vite-new`. Today a human must read the summary and file the frontend task by hand. The backend agent should be able to file — and optionally wait on — a frontend task, so front and back can coordinate an interface change end-to-end.

## Design

### 1. Agent-facing HTTP API (`/api/agent/*`)

Workers already carry `TM_CALLBACK_URL`, `TM_TOKEN`, `TM_RUN_ID` in their PTY env. Reuse exactly that auth (x-tm-token header, loopback-only, same guard as `/api/internal/*`). Every agent request carries `TM_RUN_ID` so the server attributes writes to the calling run and derives its task/repo.

```
GET  /api/agent/context          → { taskId, repoId, repoRole, repos: [{id, name, role}] }
POST /api/agent/tasks            → create task
     { title, description, repo: "<id|name|role>",       # "frontend" resolves by role
       enqueue?: boolean,                                 # false → draft (default), true → queued
       linkToParent?: boolean }                           # true → parentId = caller's task
GET  /api/agent/tasks/:id        → { id, status, resultSummary, error }   # poll a task you created
```

- `repo` resolves id → exact name → unique role. Ambiguous role (two "frontend" repos) → 400 listing candidates.
- Created tasks get `source: 'auto'`, and a new column `created_by_run` for attribution (shown in the UI as an "agent" chip with the creating task's title).
- `linkToParent: true` makes it a **sibling-child**: `parentId = caller's task.parentId ?? caller's taskId` — a worker's follow-ups block ITS parent, not itself (a task must never become its own dependency). It also joins the caller's **task group** (`group_id`/`group_path` are derived from the parent row on insert, `docs/grouping.md`), so the follow-up shows up in the same block on the Board.

### 2. Coordination model: async handoff via tasks (v1)

No direct PTY-to-PTY channel in v1. The coordination primitive is: **create → poll → read resultSummary**.

Backend worker flow for an API contract change:
1. Implements the backend side; writes the contract (endpoint, shapes, examples) precisely.
2. `POST /api/agent/tasks { repo: "frontend", enqueue: true, title: "Adopt new /v2/orders contract", description: <contract> }`.
3. Optionally polls `GET /api/agent/tasks/:id` (with sleep between polls) until `review`/`done`/`failed`, reads `resultSummary`, and reconciles (e.g. the frontend agent reports a field it also needs → backend adds it before finishing its own turn).

Why not live bidirectional chat between sessions: two agents talking through PTY injection interleaves with human keystrokes, has no turn-taking discipline, no record on the task, and both sessions burn tokens waiting on each other. The task object already provides an inspectable, durable, human-supervisable mailbox. (A `messages` channel can be layered later if genuinely needed.)

Concurrency note: with concurrency 2, a backend worker polling while its frontend task waits for a slot could deadlock IF the poller held a slot forever. It doesn't: the backend agent should file-and-finish (default guidance), or poll bounded (its turn eventually ends → its Stop hook frees the slot even mid-poll is irrelevant since polling happens inside its turn — bounded by instruction to poll max N times). Reviewer: scrutinize this.

### 3. Loop and flood guards

- **Per-run creation cap**: `agent.taskCreationCap` tasks per run (default 15, settable 1–100 in Config; 403 with a stop-and-finish message after). The served instruction sheet interpolates the live value and `GET /api/agent/context` reports `taskCreationCap`/`tasksCreated`/`tasksRemaining`. The global queued-agent ceiling (10) is unchanged and independent: past it, honored enqueues degrade to drafts rather than 403s, so a large per-run cap can never flood the queue.
- **Depth cap**: `spawn_depth` column; a created task's depth = creator's depth + 1; depth > 2 → 400. Human-created tasks are depth 0.
- **Enqueue rights**: `enqueue: true` requires the orchestrator to be enabled; otherwise task lands as `draft` with a note (never silently queue work the human hasn't turned the queue on for).
- All agent-created tasks are visible on the Board immediately (`task.updated` events) — nothing happens silently.

### 4. Worker instructions (how claudes learn this)

- New file `docs/agent-instructions.md` — the canonical instruction sheet with the exact curl commands (using `$TM_CALLBACK_URL`, `$TM_TOKEN`, `$TM_RUN_ID` env vars), the coordination flow, and the rules (caps, when to file vs. do it yourself, contract-writing guidance for cross-repo handoffs).
- The worker prompt's STANDING_RULES gains ~4 lines: "You can file follow-up tasks and coordinate cross-repo work via the Task Manager API — read $TM_CALLBACK_URL/api/agent/instructions if needed" + the one-line create example. Full sheet served at `GET /api/agent/instructions` (text/markdown, token-guarded) so the prompt stays small and the instructions version with the server.
- Project CLAUDE.md files can mention it, but must not need to — instructions travel with the spawn env.

### 5. Schema

Migration 4: `ALTER TABLE tm_tasks ADD COLUMN created_by_run TEXT`, `ADD COLUMN spawn_depth INTEGER NOT NULL DEFAULT 0`.

**Post-implementation notes (impl review):** children enqueued while the queue was on freeze if the queue is disabled before claim — same behavior as all queued work, the poller gives up per instructions rule 5. A human enqueueing an agent-filed same-repo draft while its creator is still live can put two agents in one tree — wait for the creator to finish. `orchestrator.model` is reserved for upcoming review/coordination agents (dashboard round).

### Out of scope (explicitly)

- PTY-to-PTY message injection.
- Agents editing/cancelling/completing tasks (they create and read only; state transitions stay human/machine-owned as today).
- Cross-machine coordination.

## Review questions for the adversarial pass

1. Deadlock/starvation: poll-while-holding-a-slot scenarios with concurrency 2; parent-blocking interactions with `linkToParent`; a frontend task that itself files a backend task (depth 2) — trace the worst case.
2. Loop guards sufficient? (task → run → task → run …) Does depth propagate correctly through split-children created via proposals?
3. Security: is x-tm-token + loopback enough for an endpoint that CREATES work which spawns full-permission agents? Prompt injection: a malicious dependency's README read by the backend agent convinces it to file a task "run rm -rf" for the frontend repo — mitigations (human draft-by-default? enqueue allowed only when...?).
4. `linkToParent` semantics: sibling-vs-child choice; what blocks what; can it wedge resolveChildCompletion?
5. API shape: is repo-by-role resolution a footgun? Should poll have long-poll/timeout instead of client sleeps?
6. Anything that breaks existing invariants (transitionTask ownership, claim loop, idle sessions)?
