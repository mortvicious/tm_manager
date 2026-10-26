# Publishing a task

*Ship the work of a finished task — `git add`, `git commit`, `git push` — from inside the very session that did it.*

## The idea

A worker finishes, the task lands in `review`, and the human reads the summary. Until now the only way forward was **Mark done**, which changes a row in the database and nothing else: the code still sat uncommitted in the repo, and shipping it meant switching to the Repos page (or a terminal) and committing by hand.

**Publish** closes that gap. It commits and pushes the work, and the task lands in a new terminal status — **`published`** — that means *the change is on the remote*, not merely *someone approved it*.

Two things make it more than a commit button:

1. **It happens in the agent's own terminal.** Not a new agent, not a side process — the task's claude session is reopened (`claude --resume`) and asked to commit and push. The commit message is written by the only party that knows what changed, and the git output appears in the terminal the human was already watching.
2. **git decides whether it worked**, not the agent. An agent can say "pushed" and be wrong. Afterwards the server checks the repo itself; the task reaches `published` only if git agrees.

## The button

`review` is the only status Publish is offered from — on the task panel (next to **Mark done**), as a quick action on the task's board row, and on an Inbox review item. All call `POST /api/tasks/:id/publish`.

### The verify gate (2026-10-26)

Publish pushes, and its turn runs the repo's deploy steps. Nothing in the UI can take that back. So it waits for the verdict:

- **While the round is open** (`verifyOpen`: review `pending|reviewing|fixing`, checks `pending|running`) `Orchestrator.publish()` answers **409** with the reason from `publishGateReason` (shared), e.g. `the automatic review is still open — publish once it gives a verdict`. This is for every caller: the SPA, Telegram and the API. Nothing is audited for a refusal at this point, because no publish started. The SPA disables Publish with that reason, and Telegram leaves 🚀 Publish off the task card.
- **Over a settled non-clean verdict** (review `flagged`/`error`, checks `red`/`error`) a human may still publish, but Publish is no longer the primary action. The phone row's glyph becomes the terminal, the panel bar leads with Terminal, and the Inbox leads with Send findings back or Open. Pressing it asks first. `confirmPublish` (`web/src/publish.ts`) shows a `confirm()` that restates the verdict from `publishCaution` (shared): *"Review flagged 2 blockers, 1 major — publish anyway?"* The button reads **Publish anyway**.
- **Over a clean verdict, or with review and checks off**, Publish stays the primary action and does not ask.
- **Auto-publish is unaffected.** `landIfClean` calls `publish()` only when `landingReason` passes, which needs a settled clean verdict, so the gate never fires for it.

## Auto-publish — the top landing tier

**Auto-publish is the `auto-publish` landing tier** (`docs/design.md` § Landing tiers, 2026-10-19), set per repo on the Repos page (**Landing** column) or per task with the **Landing** picker on the new-task form and the task panel (`LandingPicker`; Telegram `/new` and `/edit` have a Landing step). It replaced the per-task **Auto-publish on end** switch; migration 36 carried every `tm_tasks.auto_publish = 1` row of a non-external task into `landing = 'auto-publish'`, and the old column stays, unread. With it, a finished worker does not wait for a human — but only once the server has verified the work:

```
running → (Stop hook) → review → checks → review round (+ fix loops) → landIfClean → publish turn → published
```

**Behaviour change.** It used to bypass the checks AND the adversarial review round (Stop → publish straight away). Now it publishes only when `landingReason` passes — checks `green` or none applied, and a verdict with no blocker/major (`passed`, `skipped`, or review off for the task). Red/error checks or a `flagged`/`error` review leave the task in `review` with nothing pushed, exactly as under `supervised`. It still bypasses the human gate: the task does not wait for **Publish**.

`Orchestrator.landIfClean` (end of `reviewLoop`) audits `task.landing { phase: 'publish' }`, asks `budgetAllows(task, 'auto-publish')` (`docs/token-budget.md`; a refusal goes through `refuseOverBudget`), and calls `publish(taskId, 'orchestrator')`. When git verifies `published`, `settlePublish` stamps `tm_tasks.auto_landed_at` (the **auto-landed** chip) and adds `{landing:'auto-publish'}` to the transition audit. A publish that cannot start writes `auto-publish did not start: …` on the row, unless a refusal (e.g. § Stacked tasks below) already wrote its own reason, and audits `task.landing { phase: 'refused' }`. An external task (Sentry, proposals, filings, anything an agent filed) never resolves to this tier, and raising a tier needs the dashboard (`Origin`) — `docs/design.md` § Landing tiers.

The board shows an **auto-publish** chip on open work whose effective tier is `auto-publish`, so it is visible before the task ever runs.

## The ship gate — the worker does not push a reviewed change

The gate above assumes the worker leaves its change unshipped, but some repos' CLAUDE.md tell every agent to push and deploy on its own. So when the task's change will be verified before it ships (`shipHeldForReview(task, settings, landing)`: review on for the task or globally, OR the `auto-publish` tier — always, since its publish turn is what ships), every worker turn except this publish turn carries a server-injected rule that overrides the repo's CLAUDE.md: no push, no deploy, no production check. Local commits are fine: the reviewer reads the task's commits (by their `Task: <id>` trailer) as well as the working tree. The push **and** the repo's post-push deploy/verify steps then happen here, in the publish turn (step 5 of `PUBLISH_INSTRUCTION`). Tasks with review off on a lower tier get the repo's **push policy** instead (next section). Details: `docs/design.md` § Adversarial review, *Review before ship*.

## Push policy — what a review-off worker is told about `git push`

Without the ship gate a worker used to get NO push rule, so the repo's own CLAUDE.md decided — and on the user's setup (review off, every repo supervised) 148 of 310 questions were "push now?", whose recommended option was often "push all of main", shipping OTHER tasks' commits from the shared checkout. `push_policy` is a per-repo setting (`tm_repos.push_policy`, migration 41; Repos page **Push** column, `PATCH /api/repos/:id { pushPolicy }`), not derived from the landing tier — `supervised` is ambiguous: the human's real flow is often "the agent pushes, I mark it done".

| `pushPolicy` | Rule on every worker turn (not the publish turn) |
| --- | --- |
| `repo-rules` (default) | None — the repo's CLAUDE.md decides. The behaviour before the setting existed. |
| `agent-pushes` | Push without asking ONLY when every commit in `@{u}..HEAD` carries this task's own `Task:` trailer (`git log --format='%h %(trailers:key=Task,valueonly)' @{u}..HEAD`); otherwise — another task's commit, a trailer-less commit, or no upstream — commit locally, do not push, and say so in the summary. Never ask whether to push. Deploy steps the repo ties to a push run only after an allowed push. |
| `publish-turn` | Never push or deploy, never ask; commit locally — shipping is the publish turn's (**Publish**). |

- **The ship gate wins.** When `shipHeldForReview` holds (review on, or the `auto-publish` tier), the gate is the rule whatever the policy; `shipRule()` in `claude/worker.ts` emits exactly one of them.
- **The publish turn is unchanged**: it gets no policy rule (it is the turn that pushes).
- **External tasks** (`isExternalTask`) never get `agent-pushes`: `effectivePushPolicy` resolves it to `repo-rules`, the way a landing tier clamps to `supervised`. `publish-turn` applies to them as to any task.
- **Raising** to `agent-pushes` needs the dashboard (`Origin`, else 403 `push policies are set from the dashboard`), on POST and PATCH alike; `repo-rules` and `publish-turn` add no autonomy and are accepted from anywhere. A change is audited on `repo.changed { pushPolicy: { from, to } }`.
- **Not built: a "may I push?" agent endpoint over `publishPlan`.** `publishPlan`'s `full` also passes commits of APPROVED peers (done/published tasks), which is a wider test than the rule's "only my own trailer"; exposing it would give the agent two answers to one question. The trailer test runs in the agent's own git, needs no round trip, and is what the reviewer already keys on.

## What actually happens

```
POST /api/tasks/:id/publish
  ├─ task must be in `review` and have a repo                     → else 409
  ├─ a resumable claude session exists?
  │    yes → followUp(PUBLISH_INSTRUCTION, mode: 'resume', purpose: 'publish')
  │          → the same session, in the same terminal, runs add/commit/push
  │          → its Stop hook fires → task → review → settlePublish(['review'])
  │    no  → publishRepo(): commit (message written by opus in a `commit` aux terminal) + push,
  │          in-process, then settlePublish(['review'])
  └─ settlePublish → verifyPublished(repo)
       ok    → `published` (+ resolveCompletion: parents and feature phases)
       not ok→ back to `review`, with the reason on `task.error`
```

`PUBLISH_INSTRUCTION` (in `server/src/claude/worker.ts`) is deliberately narrow: stage, commit, push, then (only if the push succeeded) the post-push deploy/verify steps the repo's own CLAUDE.md requires, which the ship gate held back. Then it reports. No code changes, no amend/rebase, no force-push, no branches or PRs, no subagents. A failing step is reported, not worked around. `verifyPublished` checks git only: whether a deploy worked is in the agent's report, not in the status.

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

## Stacked tasks (2026-09-29)

When the custom queue has started a later same-repo task on top of one still
waiting in review, publishing follows queue order (`docs/queue.md` § Stacked
tasks): a task whose unpushed commits sit on top of an unapproved task's is
refused (`publish held: publish in order — …`, written on the task so an
auto-publish shows it), and a task with unapproved work on top of it publishes
*partially* — `publishUpToInstruction` pushes exactly its last commit
(`git push <remote> <sha>:<merge ref>`), stages nothing, and deploys nothing
from the local tree; `settlePublish` then only requires the task's own commits
on the remote. Everything else is the ordinary publish above.

