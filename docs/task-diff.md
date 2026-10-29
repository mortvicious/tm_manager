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
