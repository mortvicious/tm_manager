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
  ├─ verify round open (publishGateReason)                         → 409
  ├─ taskShipped: the agent already pushed this task's commits?
  │    yes → settlePublish(['review'], 'observed') — no turn (§ Observed publish)
  ├─ publishPlan: refuse / partial (§ Stacked tasks) / full
  ├─ a resumable claude session exists?
  │    yes → followUp(PUBLISH_INSTRUCTION, mode: 'resume', purpose: 'publish')
  │          → the same session, in the same terminal, runs add/commit/push
  │          → its Stop hook fires → task → review → settlePublish(['review'])
  │    no  → publishRepo(): commit (message written by opus in a `commit` aux terminal) + push,
  │          in-process, then settlePublish(['review'])
  └─ settlePublish → taskShipped (task-scoped), else verifyPublished(repo)
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

Since 2026-10-26 `publishedCheck` asks the task-scoped `taskShipped` FIRST and falls back to this whole-repo test only when it says no (§ Observed publish). The whole-tree test failed 7 of 9 settles on ANOTHER task's uncommitted files in the shared checkout.

### The fallback path

If no claude session can be reopened (transcript pruned, or a task filed before this flow existed) the server commits and pushes in-process — `publishRepo`, the same `commitRepo`/`pushRepo` the Repos page uses, with a clean tree treated as a non-error so local commits still get pushed. Without this, such a task could never be published at all. It refuses while a session is still live, so git never runs over a half-written tree.

## Observed publish (2026-10-26)

Workers push from inside their own turn far more often than anyone presses Publish. Over 30 days 176 tasks ran `git push` themselves, and only 1 task ever reached `published`. A sample of 40 done tasks found 20 whose commits were all on a remote already. So the server now **recognises work the agent already pushed** instead of resuming a session to push nothing. Source: autonomy-round analysis 663c5006, feasibility § 5b; task d19f0017.

### `taskShipped(repo, scope, ownsTree)` — `server/src/git.ts`

This test is task-scoped, where `verifyPublished` is whole-repo.

1. **The task's commits** are the reviewer's own attribution (`taskCommits` in `claude/review.ts`): the `Task: <id>` trailer on any ref (`git log --all`, merges excluded). Without a trailer, it falls back to `base..HEAD` bounded by the task's last landing, and only while it was the repo's sole worker (`Orchestrator.changeScope`). No commits found → **not shipped**. A task that changed nothing has nothing to publish.
2. **Each commit must be on a remote.** It must be reachable from `@{upstream}` or from ANY remote-tracking ref (`--remotes`). Several remotes count, e.g. neko's `staging`. It is one walk: `git rev-list <shas> --not --remotes [@{upstream}]`, and any of the task's shas in the output is unpushed.
3. **Uncommitted changes count only when the task owns the tree** (`treeOwner`: the newest non-publish worker run in the repo is this task's). A later task's dirty files are not this one's.

**There is no fetch.** The agent's own `git push` updates the tracking ref it pushed to, so the ref is current for exactly the push we are looking for. A commit pushed from ANOTHER clone reads as unpushed until the next fetch. That errs towards "not shipped", which is the safe side.

**Risks, and how each one falls:**
- **A missing or rewritten trailer.** The rule is prompt-only (`commitTrailerRule`). The result is the base-range fallback, else "no commits found", which means not shipped. The normal publish turn runs then, as before.
- **A rebase or squash before the push.** The pushed commit lacks the trailer, or the pre-rebase commit still sits on a local ref. Either way the check says not shipped. It never says shipped wrongly.
- **A foreign dirty tree.** Ignored unless this task owns the tree.

### Where it is used

- **`publish()`**: after the verify gate and before the plan, a shipped task settles straight to `published` (`settlePublish(…, 'observed')`) with no turn and no push. An unpushed one takes the normal path: the plan, then the publish turn.
- **`settlePublish` → `publishedCheck`**: `taskShipped` first, then the old whole-repo / stacked test. After a publish turn, another task's dirty files no longer hold this one back.
- **The landing (`landIfClean`, end of every settled verify round, and `deferLanding` while paused)**: `observeShipped` records the task's newest commit as `tm_tasks.shipped_sha` + `shipped_at` (migration 43, `Task.shippedSha/shippedAt`) and audits `task.shipped { sha, ref, commits, attribution, pushedBeforeReview, reviewState }` once per sha. It is never run while `verifyOpen`. Then the tier decides:
  - **on-green** lands **`published`** instead of `done` when shipped. on-green itself never pushes, so `published` is simply the honest status. The landing is stamped `autoLandedAt`, and the transition audit carries `observed: true, sha` next to `{landing, reason}`. A `task.publish { phase: 'published', delivery: 'observed' }` row is written too.
  - **supervised** never moves: the human approves. The row carries `shipped_sha`, and the board, task panel, Inbox and Telegram card offer **Mark published** in the publish slot. The board and panel show a `pushed` chip.
  - **auto-publish** goes through `publish()`, which settles observed.
- **`pushedBeforeReview`**: the flag is true when `shipHeldForReview` held, meaning the worker was told not to push and pushed anyway. Such a worker is reviewed exactly like any other. Observation happens only AFTER the round and changes nothing in it. A flagged verdict still keeps on-green from landing.

### Mark published

`POST /api/tasks/:id/mark-published` (`Orchestrator.markPublished`; Telegram 🚀 Mark published, `t:mpub`).

- **Who may call it**: the route needs `Origin`, so a worker cannot close its own task as `human`.
- **From `review` or `done`**: `done` covers a task someone marked done before the push was noticed.
- **Refused while the verify round is open**: `publishGateReason`, 409.
- **git is re-read**: `taskShipped` is evaluated live. The stored sha only decides whether the button is offered, and an unpushed task gets a 409 with the reason.
- **What it writes**: a conditional `transitionTask(…, 'published', actor, …, { observed: true, sha })` plus a `task.publish { delivery: 'observed' }` row. From `review` it also closes the terminals and runs `resolveCompletion`, as Mark done does.
- **Over a flagged review or red checks**: the SPA asks first (`confirmMarkPublished`), because the push already happened and this only records it.

`shipped_sha` describes the CURRENT landing. `transitionTask` clears it on any move to a status other than review/done/published (a follow-up, a retry, a cancel), and `observeShipped` clears a stale one the next time it looks.

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

Every attempt writes `task.publish` events: `phase: 'start'`, then `'published'` / `'incomplete'` / `'failed'` with the delivery (`session`, `direct`, or `observed` — already pushed by the agent, no turn), the reason, the branch and the short HEAD. A landing that sees the agent's own push writes `task.shipped` (§ Observed publish). The commit and push themselves also write the usual `repo.changed` events.

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

