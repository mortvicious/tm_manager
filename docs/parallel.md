# Parallel same-repo tasks

Task 902c7df1 (design decided in task 83aadfc9). Until this change one repo ran
one task at a time (`docs/queue.md` § Same-repo exclusivity): every worker
edited the human's checkout, so a second one would have shared the tree, the
index and the reviewer's diff. A repo can now opt into **`delivery: 'pr'`**
with a **`parallel`** cap of 2–3: each task gets its own git worktree, works on
its own branch, and the server lands it itself. `delivery: 'direct'` (the
default) and `parallel: 1` behave exactly as before — every gate below reduces
to the old one at cap 1.

The target setup is 3–4 projects with 6–8 agents, 2 per repo, so the global
`orchestrator.concurrency` is now a real setting up to **10** (default still 2,
`CONCURRENCY_MAX`). The worker pool's PTY cap stays 10 live non-idle sessions.

## Delivery (per repo)

| column (migration 46) | meaning |
| --- | --- |
| `tm_repos.delivery` | `direct` (today's behaviour) or `pr` |
| `tm_repos.parallel` | 1..`PARALLEL_MAX` (3); read as 1 unless `delivery = 'pr'` |
| `tm_repos.worktree_setup` | optional setup command line (argv, never a shell), run in a new worktree |
| `tm_repos.worktree_copy` | ignored-file patterns copied into a new worktree (default `.env*`, `.claude/settings.local.json`) |
| `tm_repos.base_branch` (migration 47) | the branch worktrees fork from, PRs target and lands push to; null = the remote default (§ Base branch) |

Set on the Repos page (**Parallel** column → `direct · 1` / `pr · N`, plus a
"worktree setup…" toggle). Switching to `pr` is refused unless the repo has a
GitHub `origin`, a resolvable base branch (`origin/<base_branch>`, else
`origin/HEAD`, else `origin/main|master`) and an authenticated `gh` (`prDeliveryRefusal`).
`parallel > 1`, `pr` and a setup command need `Origin` (403 otherwise) — a
worker's curl cannot raise its own repo's concurrency or plant a command the
server will run. `direct` with `parallel > 1` is a 400; switching back to
`direct` resets `parallel` to 1. A repo may not be registered inside another
repo's `<path>.worktrees` folder.

## The worktree

`server/src/worktrees.ts`. A task's worktree is
**`<repo path>.worktrees/<task8>`** (a sibling of the repo, never inside it) on
branch **`tm/<task8>`**, forked from a freshly fetched `origin/<base>` (§ Base branch;
the fork's base is recorded in `tm_tasks.worktree_base`).
`tm_tasks.workdir`/`branch` are written BEFORE any git step, so the gate counts
the task as a worktree holder from its first second and a crash mid-create
leaves a directory the module recognises. Creation, removal and pruning run
under a per-repo waiting mutex (`withRepoLock('wt:<repoId>')`). Two tasks of
one repo sharing an 8-char id prefix get 13-char names instead (a clash would
otherwise clear the other task's tree). A finished setup leaves a
`tm-setup-done` marker in the worktree's own git dir (never in the tree); a
directory without it — a failed setup command, a crash mid-clone — gets the
setup again on the next turn instead of running on half-installed deps.

Who gets one (`wantsWorktree`): a task with a `workdir` already, or a task in
a `pr` repo with no earlier worker session. A task that started in the
checkout before the repo switched to `pr` finishes there (its session is filed
under the checkout's cwd) and holds the repo exclusively, as before.

**Dependencies** (user's call: clone + install). Only IGNORED files are ever
copied (`git ls-files --others --ignored --exclude-standard --directory`), so
nothing copied can be committed or pushed:

- `worktree_copy` patterns (default `.env*`, `.claude/settings.local.json`);
- every `node_modules` up to depth 3, cloned with APFS clonefile
  (`cp -c -R`; Linux `cp -R --reflink=auto`) — measured: 225 MB in 2 s with no
  free-space change, since blocks are shared until written;
- then the setup command (`CI=1`, 15 min, log in the task's artifacts dir) —
  only when configured AND NOT (something was cloned AND the lockfiles are
  identical to the checkout's). A failed setup fails the turn with the reason.

**Resume by workdir.** The claude CLI files sessions per cwd
(`~/.claude/projects/<cwd with every non-alphanumeric → '->`, realpath'd), so
the path must be stable: the spawn, compaction, retry context and the resume
lookup all use `taskWorkdir(task, repo)` (= `workdir ?? repo.path`), and
`findResumableRun` skips any session filed under another directory
(`sessionBelongsTo`) — resuming a checkout session from a worktree would be a
silent miss, not a resume.

Everything that reads "the task's tree" reads the worktree: the review diff
(`taskRepo()` hands `{...repo, path: workdir}` to the reviewer, the check
stage and loop iterations), the change scope (`merge-base HEAD
origin/<default>..HEAD` in the worktree — `branchRange` — instead of the
trailer search over every ref, which after a rebase or a land would also list
the old copies on `origin/tm/…` and an earlier squash; a published task's
change is its squash commit, found by the trailer in the checkout),
one-shot agent commands, and `ensureBase`. The tree-owner / stacked-task
hand-off ignores worktree tasks — they never share the checkout.

**Ship rule.** Every worker turn of a worktree task carries
`worktreeShipRule(branch)`, which outranks the ship gate and the publish turn:
commit on `tm/<task8>` with the trailer, never push, never open a PR, never
switch branches. The server does all three.

## Base branch

Task dcdff30e. "The default branch" everywhere in this doc is **the repo's
base branch**: `defaultBranch(repo, cwd)` in `worktrees.ts` returns
`origin/<tm_repos.base_branch>` when the repo names one, else the remote's own
default (`remoteDefaultBranch`: `origin/HEAD`, else `origin/main|master`).
That ONE resolver feeds the fork, the PR's `--base`, the land's rebase,
squash and fast-forward push, `landedCheck`, `fastForwardCheckout`, the
review's `changeScope` and `prDeliveryRefusal`.

Why: GitHub's default branch is not always the line the work happens on.
neko-nest develops and deploys on `staging` (a push to it IS the production
deploy) while `main` sat 446 commits behind, five months stale. Forking from
`origin/HEAD` put every task on a tree without the code it was about, and a
land would have squashed all of staging's history into one commit on `main`.
Fixing that with `git remote set-head origin staging` in the checkout works,
but it is local state a `git remote set-head -a` silently undoes; the
setting is on the row, visible on the Repos page.

Set on the Repos page (**worktree setup…** → *base branch*; empty = the
remote default; `origin/` is stripped). `PATCH /api/repos/:id {baseBranch}`:
any change — set or cleared — needs `Origin` (it moves where lands push, which
for some repos is a deploy); a name must be a plain ref (`validBaseBranchName`:
no leading `-`, no `..`) and `origin/<name>` must exist after a fetch (400
otherwise); POST refuses it like the other delivery fields; audited in
`repo.changed`.

**Moving existing work onto a changed base** (`retargetWorktree`). Each
worktree task records the base its branch was forked from or last moved onto
(`tm_tasks.worktree_base`, migration 47; a row from before it reads as the
remote default, which is what it was forked from). When it differs from the
repo's base, the branch is moved **before the next turn** (`startWorker` →
`ensureWorktree(…, { retarget: true })`) **and before a land**
(`publishWorktree`), never under a reviewer or a check run:

1. under the `wt:` lock, fetch both bases, abort a half-done rebase, commit
   leftovers under the trailer;
2. `git rebase --onto origin/<new> <upstream>`, where upstream is the
   branch's fork point off the OLD base, or off the NEW one when the branch
   already sits on it (an agent moved it by hand), whichever is newer — so
   only the task's own commits move: an old base that is an ancestor of the
   new one (main ⊂ staging) contributes nothing, and a diverged old base's
   commits are left behind;
3. `worktree_base` written, `task.worktree { action: 'retargeted', from, to,
   commits }`; an open/draft PR gets its branch re-pushed (lease) and
   `gh pr edit --base <new>` (`task.pr { action: 'retargeted' }`);
4. the turn's prompt carries a note that the tree moved (through the
   `dispatchNote` context slot), so a resumed session re-reads files.

A conflict is aborted (branch untouched, `worktree_base` unchanged, audited
`retarget-failed` with the files) and the turn fails, or the land is refused,
with the files and the exact `git rebase --onto …` to run by hand in the
worktree; the next turn tries again. A task that never runs again before its
land is moved by the land itself.

**What it does not do**: commits that exist only on the human's LOCAL base
branch (not pushed) are invisible to a fork from `origin/<base>`; a branch an
agent moved onto the local tip carries them, and its squash will include them.
Push the base branch first (or accept that).

## The gate

`repoHasRoom` in `storage/queue-sql.ts` (both drivers verbatim) with the JS
twin `repoHasRoom(holders, repo)` in shared — **edit them together**:

- room = no holder with `workdir IS NULL` AND `count(holders) < cap`;
- cap = `CASE WHEN delivery = 'pr' AND parallel BETWEEN 2 AND 3 THEN parallel
  ELSE 1 END` (`repoCapSql` / `repoParallelCap`).

At cap 1 that is exactly the old `NOT EXISTS`. It wraps the old holder
predicate in `REPO_EXCLUSIVE_GATE` (global + overflow claims) and in the custom
queue's `CUSTOM_QUEUE_HEAD_WHERE` (member/paused clause and the agent-filed
any-task clause; the filer clause is unchanged — a filing still waits for its
filer). Twins that moved with it: `repoBusy` (dispatch delivery, the custom
queue pump), the pump's per-pass skip set (a repo is skipped after one claim
only at cap 1), `customQueueHeldRepos`, `/api/stats` held repos, and the SPA
`customQueueBlocker`.

## Commands and checks

Checks are exclusive per (command, cwd) instead of per command
(`runningCheckIn`), so two worktree tasks verify in parallel; a check runs in
the task's worktree. Saved dev servers still run in the checkout (they are the
human's), and an agent's one-shot run runs in its own worktree.

## The PR (a record)

`land.ts` `syncPr`, called at the top of every verify round (`reviewLoop`) and
from `landIfClean`: once the branch has a commit of its own it is pushed
(`--force-with-lease`) and a **draft** PR opened (`gh pr create --draft`;
`tm_tasks.pr_number/pr_url/pr_state`); later rounds re-push; once the checks
are green and the review clean (`landingReason`) it is marked ready. Never
fatal — a failure is a `task.pr` audit row. A publish of a task that never got
a PR opens it first. The PR is where a human can read the change on GitHub; it
is never merged through GitHub.

Surfaces: a branch/PR chip on board rows and in the task panel (a real link),
a 🌿 line on the Telegram card.

## Land

Publish of a worktree task (`publishWorktree`, from `review`, or `done` if a
human moved it there), serialised per repo (`land:<repoId>`), refused while
the session is working. The task is marked landing (`landing`) and its idle
terminal killed (run marked `killed` first, so the exit path never cancels a
task a prompt just moved): until the land returns `followUp` (so dispatch
delivery too) refuses it, `startWorker` puts any other start back in `review`,
a prompt typed into the terminal moves nothing, the eviction skips it, and the
restart guard (`restart-check`, so Rebuild & restart's drain) waits for it. A rebase a crash left
half-done is aborted before anything else.

1. leftovers committed under the trailer;
2. fetch + rebase onto `origin/<default>` — a conflict is aborted and handed
   to the task's session (§ Conflicts);
3. squash to ONE commit (`reset --soft` onto the fork point): title, the
   result summary, `Squashed from n commit(s) on tm/… (PR url)`, `Task:`
   trailer;
4. the checks again, only if the squashed tree differs from the one the verify
   round judged (origin moved underneath), or it is the tree an earlier land
   found red (`landRedTree` — the rebased tree stays in the worktree, so it
   would otherwise look judged) — red holds the land, moves a `done` task back
   to `review`, and re-enters the verify loop on the rebased change
   (`check_state: 'pending'`);
5. `push --force-with-lease` of the task branch (the PR head becomes the
   squash commit), then a plain fast-forward push of `HEAD:<default>`;
   rejected (someone landed first) → fetch and go again from 2, 3 times.

Because the PR head equals the new default-branch tip, GitHub marks the PR
**merged**. Shipped detection is git, never the PR (`landedCheck`, used by
`shippedState` and `publishedCheck`): a commit with the task's trailer on
`origin/<default>`, AND what the task has now — its worktree's HEAD, else its
branch — landed too (reachable from `origin/<default>`, or no newer than the
newest landed trailer commit, which is how a merge done on GitHub reads), AND
no tracked change in the worktree (untracked files — a check's output — do not
count). A trailer alone is not enough: a follow-up after a land adds
commits the old squash does not contain, and calling that shipped would let
the cleanup delete them.

**Landing tiers.** Auto-publish lands as above once the verify round is
clean. **On-green does not park a worktree task in `done`**: its change is on
its branch, not the default branch, and `done` would let dependents and the
next feature phase fork without it — so it stays in `review` with the PR
marked ready (`task.landing { phase: 'held' }`), for Publish. Supervised is
unchanged. After the land: the main checkout is
fast-forwarded only when it is on the default branch with no tracked change
(`fastForwardCheckout`), the terminals close, `confirmMerged` polls `gh pr
view` (6 × 5 s), and only then is the remote branch deleted (deleting it first
would make GitHub read the PR as closed), with the worktree and local branch.

Branch protection that refuses a direct push to the default branch makes the
land fail with the push's reason; such a repo should stay `direct`.

## Conflicts

A rebase conflict resumes the task's OWN session in its worktree
(`followUp(…, 'resume')`, `landConflictMessage`: fetch, rebase, resolve keeping
both intents, run the checks, commit, no merge, no push), bounded by
`CONFLICT_MAX_ROUNDS` (2) and, for an automatic land, `budgetAllows(task,
'conflict-round')` (a human's Publish is never refused by a fuse). Its Stop
runs the ordinary verify round (the diff hash decides whether the review runs
again), and `landIfClean` re-publishes as the actor who started the land
(`landAfterConflict`) once the row is landable. The re-land keeps the round
count (`relanding`), so the bound holds for a human-asked land too; only a
fresh Publish starts it over. The re-arm survives the resolving turn's own
automatic follow-ups (check and review fix turns, transient resumes, a wake,
Continue after Pause) but a human's different turn (a follow-up, Proceed), a
fresh start (Retry, a claim) or a cancel drops it, so a land never runs later
without someone asking. Spent → the task stays where
it is with `land held: …` and the worktree path, for the human.

## Cleanup

`worktreeSweep` every 5 min and at boot (user's call: terminal + idle eviction):

- `published` → worktree, local branch and remote branch removed;
- `cancelled` → PR closed, leftovers WIP-committed to the branch, worktree
  removed, local branch KEPT (refs only — a retry continues on it); delete
  removes the branch too;
- idle `review`/`failed`/`done` older than `worktrees.idleEvictDays`
  (default 3, 0 = never) → **evicted**: leftovers WIP-committed to the branch,
  the directory removed, `worktree_evicted_at` stamped. Never while a session
  is live, a turn is starting, the task is landing, the verify round is open, a
  pause marker is set, a review is pending, a PR sync runs or an agent one-shot
  run of the task is live — re-checked on a FRESH row under the `wt:` lock
  (the sweep's snapshot is seconds old), and `ensureWorktree`'s lock-free fast
  path steps aside while an eviction is removing the directory. The next turn re-creates it at the SAME path from the
  branch (`ensureWorktree`), so the session resumes;
- at boot `pruneOrphans`, only for `pr` repos or repos that had worktree
  tasks, rows read inside the lock: `git worktree prune`; then only entries
  named like ours (`<8 hex>`, `<8 hex>-<4 hex>`) that are linked worktrees of
  THIS repo and that no unpublished task owns; and `tm/<that name>` branches
  with no task row (`branch -d` only — an unmerged orphan stays for a human).
  Anything else in the folder — a human's own worktree, a file — is never
  touched.

Directory removal refuses anything outside `<repo>.worktrees/`.

## Known limits

- Creating a worktree (fetch, clone, setup command — up to 15 min when the
  lockfile differs) runs inside `startWorker`, which the single-flight
  scheduling pass awaits: a slow setup delays other claims in that pass.
- Checks re-run during a land hold that repo's `land:` lock; other repos are
  not affected.
- A remote branch whose merge was never confirmed (or whose PR never opened)
  is not retried by the sweep; `git push origin --delete tm/…` by hand.
- `dispatchTurnsInFlight` still holds one dispatch turn per repo.

## Verification (2026-10-27)

`npm run typecheck`, `npm run build`, and two tsx harnesses on scratch git
repos with a bare origin, a fake `gh` and a fake `claude` (fresh SQLite DB):

- module walk (31/31): separate worktrees, node_modules cloned + `.env`
  copied and still ignored, draft PR → ready, squash land = one commit with
  the trailer, PR head == main, `landedCheck`, checkout fast-forward, conflict
  aborted cleanly, land after resolution without a needless re-check, evict →
  re-create at the same path with the WIP, moved main → checks re-run → red
  pushes nothing, removal of branch + remote branch, orphan prune;
- after the adversarial review's fixes (shipped needs the tip landed, prune
  only touches our own worktrees, eviction re-checks under the lock, on-green
  holds in review, red re-check never skipped, bounded human re-lands, land
  vs turn exclusion, branch-range review scope, cancel keeps leftovers, setup
  marker), both walks re-run, plus targeted checks — see the decision entry;
- orchestrator walk (13/13): the real claim gate runs A and B of a `pr · 2`
  repo together in separate worktrees while a third waits and a `direct` repo
  runs exactly one; claude spawned with cwd = each worktree; a checkout-filed
  session is not resumed from the worktree; publish A → squash land →
  `published` with PR #7 merged and the worktree removed; publish B →
  conflict → B's own session resumed with the rebase instruction, land
  re-armed.
