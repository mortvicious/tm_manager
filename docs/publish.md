# Publishing a task

*Ship the work of a finished task — `git add`, `git commit`, `git push` — from inside the very session that did it.*

## The idea

A worker finishes, the task lands in `review`, and the human reads the summary. Until now the only way forward was **Mark done**, which changes a row in the database and nothing else: the code still sat uncommitted in the repo, and shipping it meant switching to the Repos page (or a terminal) and committing by hand.

**Publish** closes that gap. It commits and pushes the work, and the task lands in a new terminal status — **`published`** — that means *the change is on the remote*, not merely *someone approved it*.

Two things make it more than a commit button:

1. **It happens in the agent's own terminal.** Not a new agent, not a side process — the task's claude session is reopened (`claude --resume`) and asked to commit and push. The commit message is written by the only party that knows what changed, and the git output appears in the terminal the human was already watching.
2. **git decides whether it worked**, not the agent. An agent can say "pushed" and be wrong. Afterwards the server checks the repo itself; the task reaches `published` only if git agrees.

## The button

`review` is the only status Publish is offered from — on the task panel (next to **Mark done**) and as a quick action on the task's board row. Both call `POST /api/tasks/:id/publish`.

## Auto-publish on end

The new-task form (and the task panel) carries **Auto-publish on end**. With it on, a finished worker never stops for a human:

```
running → (Stop hook) → review → publish turn → published
```

It bypasses **both** gates on purpose — that is what "no gate between finishing and shipping" means:

- **the human review queue** — the task does not wait for **Mark done**;
- **the adversarial review round** — no reviewer agent runs, and no work→review→work loop.

It also overrides `orchestrator.autoComplete`: an auto-publishing task always passes *through* `review` (so the publish turn has something to pick up) rather than jumping straight to `done`.

Auto-publish is per task, stored on the row (`tm_tasks.auto_publish`), and shown on the board as a blue **auto-publish** chip so it is visible before the task ever runs.

## What actually happens

```
POST /api/tasks/:id/publish
  ├─ task must be in `review` and have a repo                     → else 409
  ├─ a resumable claude session exists?
  │    yes → followUp(PUBLISH_INSTRUCTION, mode: 'resume', purpose: 'publish')
  │          → the same session, in the same terminal, runs add/commit/push
  │          → its Stop hook fires → task → review → settlePublish(['review'])
  │    no  → publishRepo(): commit (message written headless by opus) + push,
  │          in-process, then settlePublish(['review'])
  └─ settlePublish → verifyPublished(repo)
       ok    → `published` (+ resolveCompletion: parents and feature phases)
       not ok→ back to `review`, with the reason on `task.error`
```

`PUBLISH_INSTRUCTION` (in `server/src/claude/worker.ts`) is deliberately narrow: stage, commit, push, report. No code changes, no amend/rebase, no force-push, no branches or PRs, no subagents. A failing step is reported, not worked around.

### `verifyPublished` — the ground truth

`server/src/git.ts`. In order, the first thing that fails is the reason:

| check | failure reason |
|---|---|
| is a git repo | `not a git repository` |
| `HEAD` resolves | `the branch has no commits yet` |
| `git status --porcelain` empty | `N uncommitted change(s) still in the working tree` |
| `@{upstream}` resolves | `the branch has no upstream — nothing was pushed` |
| `git rev-list --count @{upstream}..HEAD` is 0 | `N commit(s) not pushed to <upstream>` |

A clean tree with nothing ahead is *published* even when this turn committed nothing — everything that exists is on the remote, which is what the status claims.

### The fallback path

If no claude session can be reopened (transcript pruned, or a task filed before this flow existed) the server commits and pushes in-process — `publishRepo`, the same `commitRepo`/`pushRepo` the Repos page uses, with a clean tree treated as a non-error so local commits still get pushed. Without this, such a task could never be published at all. It refuses while a session is still live, so git never runs over a half-written tree.

## The `published` status

`published` is **terminal**, alongside `done`:

- it resolves a split parent (`resolveChildCompletion`) and settles a feature phase (`FEATURE_CLAIM_GATE` and its JS twin `isFeatureTaskBlocking` — edited together, as always);
- `TERMINAL_TASK_STATUSES` in `shared/src/types.ts` is the single list both drivers read;
- the agent-API task poll counts it as terminal;
- the dashboard counts it as a completion (`done` plus a push);
- the board gives it its own section, folded away with the other history and hidden in essentials mode; its badge uses `--tm-status-published` (blue — distinct from `done`'s green, because "shipped" and "accepted" are different claims).

It is not re-enqueueable and not re-completable (`complete` stays `review → done`) — but a **follow-up** may still be sent to a published task: shipping the work does not end the conversation with its agent.

## Failure modes, and what they look like

| what happened | result |
|---|---|
| push rejected (remote moved on) | task back in `review`, `error` = `publish did not complete: 1 commit(s) not pushed to origin/main` |
| agent left a file untracked | back in `review`, `error` names the uncommitted count |
| no remote configured | back in `review`, `error` = `the branch has no upstream — nothing was pushed` |
| publish terminal died mid-push | settled from git, not from the exit code — `published` if the push landed, else `review`. Never `failed`: the work exists |
| someone killed the publish run | the kill wins, exactly like any other run: the task is `cancelled` |
| publish run's session is still working | 409 — wait for it to finish |

## Audit trail

Every attempt writes `task.publish` events: `phase: 'start'`, then `'published'` / `'incomplete'` / `'failed'` with the delivery (`session` or `direct`), the reason, the branch and the short HEAD. The commit and push themselves also write the usual `repo.changed` events.
