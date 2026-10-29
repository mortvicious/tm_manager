# Task diff — the task's own change, per file

`GET /api/tasks/:id/diff` serves the change the adversarial reviewer reads
(`docs/design.md` § Adversarial review) split per file, for the task panel's
Diff tab (feature *Task panel tabs + per-task history*, phase 1). It is a
read: it never writes to git, never re-creates a worktree and needs no
`Origin`.

## Where it reads

`Orchestrator.taskChange(taskId)` takes the reviewer's own scope,
`changeScope(task, repo)` — the rules are not copied — and adjusts only what
the reviewer never meets:

| Task | cwd | Commits | Uncommitted | `scope.kind` |
|---|---|---|---|---|
| checkout task | `repo.path` | trailer, else base..HEAD when it worked alone | while no later task worked in the checkout | `trailer` / `base-range` / `none` |
| live worktree task | its worktree | fork..HEAD (`branchRange`) | yes | `branch-range` |
| evicted / removed worktree (dir missing, not published) | `repo.path` | trailer only (the eviction WIP commit carries it) | no | `trailer` / `none`, `evicted: true` |
| published worktree task | worktree if still there, else `repo.path` | trailer (the squash) | no | `landed` |
| never ran (no `baseSha`) | — | trailer, if any | no — the checkout's dirty tree is not its | `none`, no files |

It deliberately does NOT call `taskRepo()`, which re-creates an evicted
worktree (`ensureWorktree`) — a GET must not run worktree setup. `changeScope`
itself may still `git fetch` the base branch when `refs/remotes/origin/<base>`
is missing, exactly as it does for a review.

## How it reads (`taskChangeRead`, `server/src/claude/review.ts`)

The non-mutating sibling of `workerDiff`; `workerDiff`, `gitDiff`, `DIFF_CMD`
and the review hash are untouched.

- Commits: `taskCommits` and `committedDiff` as they are (`git log`, tree-to-tree
  `git diff A B` / `git show` — none of them touches the index).
- The tree: `git diff-index -p -M --no-color --ignore-submodules=dirty HEAD -- . <DIFF_EXCLUDES>`.
  **Not** porcelain `git diff HEAD`: measured on git 2.52, it refreshes a
  stat-dirty index and writes `.git/index` even with `GIT_OPTIONAL_LOCKS=0`.
  The plumbing compares contents and leaves the index alone (`-M` because it
  does not read `diff.renames`).
- Untracked files: `git ls-files --others --exclude-standard -z -- . <excludes>`,
  then `git diff --no-index --no-color -- /dev/null <file>` per file (exit 1 is
  normal), 8 at a time, at most `UNTRACKED_DIFF_CAP` (200) files and within a
  6 s budget — one spawn costs 45–120 ms under tsx, so 200 files could hold the
  panel for 20 s. What is not read (past the cap or the budget, bigger than
  800 KB, a nested repo `dir/`) is still LISTED, without a patch, and sets
  `untrackedCapped`. An empty new file is listed with no section.
- No `git add -N`, ever. Every command is argv (never a shell) with
  `GIT_OPTIONAL_LOCKS=0`.

## The response (`TaskDiffResponse`, `shared/src/diff.ts`)

```ts
{
  taskId, readAt,
  scope: { kind, baseSha, branch, includeUncommitted, attribution, evicted },
  commits: [{ sha, subject }],
  files: [{ path, oldPath?, status, insertions, deletions, binary,
            sections: [{ source: 'committed' | 'uncommitted' | 'commit:<sha12>', patch, truncated }] }],
  stat: { files, insertions, deletions },
  truncated, untrackedCapped,
}
```

`splitDiffFiles(text)` (pure, shared) parses `diff --git` sections — new,
deleted, renamed, copied, binary; quoted and space-containing paths — and the
module's own markers (`--- committed (…) ---`, `### commit <sha12>`,
`--- uncommitted (…) ---`) as section sources. Hunk bodies are walked by their
`@@` counts, so a removed line that reads like a marker stays a deletion. A
file in several sources is one entry with one section per source; its counts
add up like `diffStat`. `capDiffFiles` then cuts patches only — about 400 KB
per file (all its sections), 4 MB per response, at a line end — and every
file stays listed with its full counts.

## The route

`GET /api/tasks/:id/diff` (`routes/tasks.ts`): 404 unknown task, 409 when the
repo row or folder is gone, 503 before the orchestrator is up. Single-flight
per task id plus a 5 s cache keyed by `task.updatedAt` (counted from the end
of the read; a failed read is not cached), so several tabs share one set of
git processes. Client: `api.taskDiff(id)`.

## The Diff tab (`web/src/components/TaskDiff.tsx`)

Phase 2 of the feature: the task panel's `diff` tab (`docs/mobile.md` § Task
panel tabs) renders this response. It is never a tab default; a click or
`?tab=diff` opens it.

- **Fetching.** `api.taskDiff(id)` when the tab mounts (inactive tabs unmount,
  so coming back reads again — the route's 5 s cache absorbs it). While open it
  reads again when the task row's `updatedAt` moves or one of the task's runs
  exits (`run.exited`), at most once per 5 s: an event inside the window
  schedules ONE read at its end. **Refresh** reads at once. A response for an
  older request or another task (breadcrumb swap) is dropped; a failed refresh
  keeps the last good list under an error line.
- **Header.** The scope in plain words (`scopeLine`): `3 commits (by Task
  trailer) + uncommitted`, `2 commits since its base 1a2b3c4d`, `branch
  tm/ab12cd34 since its fork from origin/staging` (base = `Task.worktreeBase`,
  else the repo's `baseBranch`), `landed squash on staging`, `evicted worktree:
  committed work only — 1 commit (by Task trailer)`, `uncommitted changes only —
  no commits attributed`, `no change yet`. `+ uncommitted` is said only when an
  uncommitted or untracked file is actually listed. Then the attribution, the
  `stat` (files, +/−), `readAt` as an age (absolute time in the tooltip) and
  the commits, oldest first (short sha + subject).
- **Banners.** `truncated` → a banner that patches were cut at the caps while
  every file stays listed with full counts; `untrackedCapped` → a note that
  some untracked files are listed without a patch.
- **File list.** One row per file: status letter (A/M/D/R/C), `oldPath → path`
  for a rename/copy, `+n −m` (or `binary`), `cut` when one of its patches was
  truncated. A tap expands the file; its patch is RENDERED only while expanded.
  Each section is labelled `committed` / `uncommitted` / `commit <sha7>`;
  added/deleted/hunk-header lines take `--tm-diff-add|del|hunk-fg|bg`, git's
  file headers are faint. A binary file or one with no section (an empty new
  file, an untracked file past the cap) says so instead. Desktop has **Expand
  all / Collapse all**; the phone has compact rows.
- **Text only.** Each line is a React text child of a `<span>` in a `<pre>` —
  never markdown, never `innerHTML`; the patch is untrusted repo bytes.
- **One scroller.** `.td-patch` is `white-space: pre` with `overflow-x: auto`
  and `overflow-y: hidden`: a long line scrolls sideways inside its block,
  while vertically the panel's own scroller moves everything (a nested
  vertical scroller would break the phone sheet's drag-from-the-top).
- **Tokens.** `--tm-diff-add-fg/bg`, `--tm-diff-del-fg/bg`,
  `--tm-diff-hunk-fg/bg` in all four theme blocks (Classic dark/light, Glass
  dark/light) of `theme.css` and the token sheet (`docs/tm-design-tokens.html`,
  with a sample under Color); the patch font is `--tm-font-mono`.

## Verification

`server/src/task-diff.test.ts` (real git in a temp dir): a trailer commit +
tracked edit + untracked and empty files are listed with the right status,
counts and sources; `.git/index` bytes and mtime are unchanged over a
stat-dirty tree; `.claude/worktrees` / `.worktrees` never appear; the
untracked cap lists every file; `splitDiffFiles` on rename, binary, deleted
and multi-commit input; `capDiffFiles` per-file and total caps. Checked
through the inject harness on a DB copy: unknown → 404, a draft → `none`, a
live worktree task → `branch-range` with its uncommitted and untracked files,
a published worktree task → `landed`, an evicted one → `evicted: true` with its
directory not re-created, three parallel requests served from one read, and
the live worktree's index unchanged.

The Diff tab (phase 2) was checked in Playwright Chromium over a scratch
build, desktop 1440×900 and phone 393×852, Classic and Glass, with every
non-GET aborted and the diff answered by the real `taskChange` over a DB copy
(the live API predated the route): a checkout trailer task (36 files, 1
commit), a live worktree task with tracked and untracked changes (`branch …
since its fork from origin/main + uncommitted`), a landed one, a draft (`no
change yet`), an evicted one, and a large diff built by the real
`taskChangeRead` over a temp repo with a 600 KB file (banner, `cut` row, binary
note). In every case commits/files matched the response, every `.td-patch`
was `pre` with `overflow-x: auto; overflow-y: hidden`, no element in the tab
scrolled vertically, and each patch line was a text-only `<span>`. Committing
in the worktree with the tab open then pressing Refresh moved the list from
`+ uncommitted` to the new commit, and `.git/index` was unchanged by every read.
