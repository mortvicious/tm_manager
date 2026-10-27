# Branches — what is merged, what is only here

The **Branches** page (`/branches`, under *More* on a phone) answers one question per
registered repo: **which work is already in an essential branch and on the remote, and
which exists only on this machine and still awaits merging?** Worktrees are the main
reason to ask. Parallel tasks each get one, and a human makes their own, so work is
spread over several checkouts and branches that nobody looks at together.

Everything is read from git on request. Nothing is stored and nothing polls.

## What it shows

Per repo:

- **Essential branches**: the remote's default branch (`<remote>/HEAD`), plus
  any of `main master staging stage develop development dev production prod
  release` (`DEFAULT_ESSENTIAL_BRANCHES`, shared) that exist locally or on the
  remote. Each one shows:
  - **in sync** with `<remote>/<name>`;
  - **N not pushed**: local commits the remote copy lacks, with the list;
  - **N behind**: remote commits not pulled, as of the last fetch;
  - **not on remote** or **only on remote**;
  - **uncommitted** files when it is checked out somewhere.
- **Awaiting merge**: every other local branch that still has commits in no essential
  branch (local or remote), plus every branch whose worktree has uncommitted files, plus
  detached worktrees. Each row shows:
  - **N commits not merged**, with the list;
  - **local only — not pushed**, **N not pushed**, or **pushed to `<remote>/<branch>`**;
  - **built on N unpushed commits**: essential-branch commits under the branch that are
    not on the remote, e.g. a branch cut from a local `main` that is ahead of `origin`.
    That work is "only here" too, but it belongs to the essential branch, so it is not
    counted as the branch's own;
  - the worktree it is checked out in (or *branch only*);
  - the task it belongs to, which opens the task panel;
  - uncommitted counts.
- **Merged** (collapsed): branches whose every commit is in an essential branch. A row
  names where, and says **local** when only the local essential branch has the work
  (merged, but the essential branch is not pushed yet).
- Worktrees whose directory is gone (`prunable`), with the `git worktree prune` hint.

The top line totals the scope: branches awaiting merge, essential commits not pushed,
and checkouts with uncommitted files.

## How "merged" is decided (`server/src/branches.ts`)

A branch's **pending** commits are `git log <branch> --not <every essential ref>`, where
the essential refs are both the local and the remote copy of each essential branch.
None pending → merged by ancestry, and `for-each-ref --contains` lists which refs.

Pending commits can still be landed under other shas. Each pending commit is checked
against each essential ref and is **covered** when:

- **same patch**: `git cherry <essential> <branch>` marks it `-` (a rebase or
  cherry-pick); or
- **squash**: the essential ref has a commit carrying one of the commit's `Task: <id>`
  trailers that is **no older** than the commit. This is the server's squash land (the
  trailer every worker commit carries). A commit made AFTER that land is new work,
  which is the same rule `landedCheck` uses.

A branch is merged into a ref when that ref covers every pending commit. A branch whose
commits are covered piecewise by different refs is merged too, listing those refs. A
branch with more than 200 pending commits is not checked for landings, because it is
some other line of history and the cost would be unbounded.

**Only here** is counted against the remote:

- `pendingLocalOnly` is the pending commits on no remote ref (`--not --remotes=<remote>`);
- `inheritedUnpushed` is `(commits on no remote) − (own commits on no remote)`, i.e.
  essential-branch work the branch sits on that was never pushed.

The remote is `origin`, else the repo's only remote.

The task link comes from the `Task:` trailers, else from a `tm/<id8>` branch name that
matches exactly one task.

## Freshness and cost

`GET /api/branches[?repoId=]` reads local refs only, with no network. The remote side is
therefore as fresh as the last `git fetch`. Each repo reports that time (`FETCH_HEAD`'s
mtime), and the page flags it after a day.

`POST /api/branches/fetch {repoId?}` runs `git fetch --prune <remote>` per repo
(60s timeout, `GIT_TERMINAL_PROMPT=0` so a credential prompt fails instead of hanging,
one fetch per repo at a time), then answers like GET. A failed fetch is that repo's
`fetchError`, never a 5xx: the local picture is still right. It requires `Origin`,
because it uses the user's credentials and a worker's curl has none. That is the
shells/spaces rule.

Every git call is a process spawn (200–300ms each on a busy machine), so independent
calls run together, a local and a remote copy at the same sha are read once, all trailer
lookups against a ref are one `git log`, and at most 60 non-essential branches per repo
are read, newest first. A checked-out branch is always read; the rest are reported as
`truncated`. A big repo takes a few seconds. The page loads on open, on Refresh, and
when the tab returns after a minute. It never fetches on its own.

## Not done (deliberately)

- **No per-repo essential list.** The default list plus the remote's default covers
  `main`/`staging`/`develop`-style setups. A custom name (`qa`, `uat`) needs a setting,
  which can follow if it is ever asked for.
- **No actions.** No merge, push, delete or prune buttons. The page is a ledger. Landing
  stays with the task flow (publish), and deleting work stays a human decision in a
  terminal.
- **No PR state.** Merged means in git, never "a PR says so", the same principle as
  `verifyPublished`.
