# Approvals — human-only actions an agent can request

Some actions are kept away from agents on purpose. A push to a repo where every
push is a deploy (neko D458) is one. So are Mark published (an Origin-gated
route), Rebuild & restart (an agent cannot restart the server it runs on), and
moving a main checkout's branch. Before this, an agent finished by listing
commands for the human to paste. On 2026-10-28 that meant three `git push`
lines, a bulk Mark published, a Rebuild & restart and a `merge --ff-only`, all
done by hand.

An **approval** moves the legwork to the agent and keeps the decision with the
human:

1. The agent **requests** an action: `POST /api/agent/approvals` with its run
   token. The server validates the request and **describes** it in `summary`:
   exact refs, the commit range, the task list. That text is what the human
   reads.
2. The human **approves or rejects** it with one tap. In the SPA it is an Inbox
   item (kind `approval`, listed right after questions). On Telegram it is a
   🔐 card with ✅/✖ buttons (`ap:<id>:y|n`, parsed before the action codec).
   Web Push sends a banner (kind `approval`, tag `approval-<id>`) that opens
   `/inbox`.
3. The **server** runs exactly what the row says, then records the outcome
   (`done`/`failed` + `result`). The agent long-polls
   `GET /api/agent/approvals/:id?waitMs=60000`.

The agent never holds the power itself. Every guard that kept these actions
human stays where it was, and this adds no new way around one. The decision
route (`POST /api/approvals/:id/approve|reject`) requires `Origin`, like
answering a question: a worker's curl sends none. The trust model is the same
as `/api/questions/:id/answer`, Mark published and the landing-tier routes. The
agent sheet tells agents never to work around a refusal, and every decision is
an audit row.

Code: `server/src/approvals.ts` (the service and the four executors),
`server/src/routes/approvals.ts`, `server/src/storage/approval-sql.ts` (SQL
shared by both drivers), `server/src/telegram/approvals.ts`. Table
`tm_approvals` (migration 48), FK-less like `tm_questions`.

## Actions

| action | request body | validated at request | re-checked at run |
|---|---|---|---|
| `push-ref` | `repo` (name/id; default the caller's), `branch` + `sha` (any rev), **or** `tag` (must exist locally) | ref name valid. Branch: origin's tip is an ancestor of `sha` (fetched if missing), else 409 "not a fast-forward". Tag: absent on origin, else 409 (a published tag is never moved). Same sha already on origin → 409. | `pushHealth.refusal` (a held repo pushes nothing). `ls-remote` again: origin's ref must still equal `expectedOld`, else `failed` "moved since the request". Then `git push --porcelain origin <sha>:<ref>` with **no force flag**, prompt-free (`gitNetEnv`). A failure is classified into push health. |
| `mark-published` | `taskIds` (full or 8+ char prefixes, ≤ 50) | each resolves to one task in `review`/`done` | `Orchestrator.markPublished(id, <decider>)` per task, which re-reads git (`shippedState`). `done` if any succeeded, with per-task lines in `result`. |
| `sync-branch` | `repo`, `branch` (default: the base branch, `defaultBranch`) | local branch exists. Fetch. Not ahead of origin (diverged → 409). Behind > 0. Not checked out in ANOTHER worktree. | Under `withRepoLock`: fetch, re-count, then `merge --ff-only` in the checkout (refused on tracked changes) or `update-ref` with the old value when not checked out. Paths are compared by realpath: git prints `/private/var/…` on macOS. |
| `rebuild-restart` | `drainMinutes?` (≤ 120) | the API runs under the front door (`TM_SUPERVISED`) | POSTs the front door's `/host/rebuild-restart` with `{drain: true}` (loopback, no Origin, like `requestHostRestart`). `done` = the job started. The drain finishes once no agent is working, so **the requesting agent must end its turn**. |

## Lifecycle

`pending → approved → running → done | failed`, or `pending → rejected`. Every
step is a conditional write (`decideApproval` only from `pending`,
`stepApproval` from named statuses), so a tap in the SPA and one on Telegram
can never both approve. The second one gets 409 "already approved by …".

- **Idempotent request**: the same action with the same params, pending for the
  same task, returns the existing row (200 instead of 201).
- **Cap**: at most `APPROVAL_PENDING_CAP` (5) pending rows per task.
- **A pending row outlives its run.** The human may approve after the agent's
  turn ended, and the server still runs it. Stale requests fail safely at run
  time: the remote moved, the branch diverged, or git no longer agrees.
- **Boot**: a row left `approved`/`running` by a restart is set to `expired` and
  **never re-run**, because it may have half-happened. `pending` rows survive a
  restart.
- **Audit**: `approval.requested` (actor `agent:<run8>`), `approval.decided`
  (`human` / `telegram` / `auto-approve`), and `approval.finished`.
- **WS**: `approval.updated` carries the row on every change. The SPA keeps the
  pending set. The outcome is a toast: sticky on `done`, an error toast on
  `failed`.

## Auto-approve

`tm_repos.auto_approve` (JSON array, migration 48) lists the actions a repo
runs on the agent's word alone. Only `APPROVAL_AUTO_ACTIONS` qualify:
`mark-published` and `sync-branch`. Both re-read git and neither can ship code
or stop the server. A push and a restart **always** wait for a tap; storage
drops anything else on write and on read.

A `mark-published` request is pre-approved only when every task names a repo
and EVERY repo it touches pre-approves it. Turning an action on needs `Origin`
(PATCH `/api/repos/:id` with `autoApprove`, 403 `AUTO_APPROVE_FROM_BROWSER`).
Turning it off works from anywhere. The Repos page has an **Auto-approve**
column with four choices: always ask, mark published, sync branch, or both.

A pre-approved request is decided as soon as it is written. Telegram and Web
Push wait 1.5 s and re-read the row, so the human gets the outcome instead of a
card to ignore.

## Surfaces

- **Inbox**: `buildInbox` (shared) lists pending approvals after questions,
  oldest first, one item per request. Acts: **Approve** (`a`, primary; for a
  push it asks `window.confirm` restating the summary first), **Reject** (`x`)
  and Open (the requesting task). The detail shows the summary and the reason.
  The header chip and phone tab count approvals like any other decision.
- **Telegram**: the notifier sends a 🔐 card per pending request (no
  coalescing, no notify flag, the same rule as questions) and an outcome line
  when it settles. The 📥 board view lists approvals with the same two buttons.
- **Web Push**: kind `approval` (default on). Migration 48 adds it to every
  device that already receives `question`. A request triggers a banner, and so
  does a `failed` run (tag `approvalfail-<id>`, which the stale sweep leaves
  alone). `PushBridge` closes `approval-*` banners for requests decided
  elsewhere.

## What it deliberately does not do

- No force push, no moving a pushed tag, no deleting a ref.
- No pushing to a repo whose push health fails (the hold in
  docs/parallel.md § Push health applies to approved pushes too).
- No auto-approving a push or a restart, ever.
- No generic "run this command" action. Each action is a fixed executor with
  its own validation.
