import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { checkEvidence } from '../checks.ts';
import type { DiffStat, Repo, ReviewFinding, ReviewResolution, ReviewVerdict, Task, TaskDiffFile } from '@tm/shared';
import { DIFF_FILE_PATCH_CAP, UNTRACKED_DIFF_CAP, capDiffFiles, diffFilesStat, splitDiffFiles } from '@tm/shared';
import {
  READ_ONLY_DISALLOWED,
  READ_ONLY_TOOLS,
  acceptJson,
  aux,
  resultInstruction,
  withModelFallback,
  type AuxOutcome,
} from './aux.ts';

// Adversarial review of a worker's change — exactly how we work: read the diff,
// hunt correctness bugs / regressions / missed edges / security, report findings,
// human decides. Runs on the task's reviewer (task.reviewModel, else the global
// review.model — Fable by default); falls back to FALLBACK_MODEL at xhigh when
// that model is unavailable on this account (StopFailure `model_not_found`,
// and nothing else — a timeout or any other failure is recorded as itself).
// Only a FABLE failure is cached: a per-task choice of another model must
// never be silently swapped for Opus. The fallback is `withModelFallback`
// (aux.ts), shared with feature analysis and reports.
//
// Besides the findings the reviewer writes an overall SUMMARY of the work as it
// stands — what the change does and whether it satisfies the task — because
// the worker's own last message, after a fix round, is only "fixed 1 and 2"
// and the human needs the whole picture in one place (the task panel shows
// the latest round's summary at the top of the review section).

const findingsSchema = z.object({
  verdict: z.enum(['clean', 'concerns', 'blocker']),
  summary: z.string().nullish(),
  findings: z
    .array(
      z.object({
        severity: z.enum(['blocker', 'major', 'minor']),
        summary: z.string(),
        detail: z.string().nullish(),
      }),
    )
    .max(30),
  // fix rounds only: one entry per numbered earlier finding (docs/design.md § Adversarial review)
  previous: z
    .array(
      z.object({
        id: z.number().int(),
        status: z.enum(['resolved', 'unresolved']),
        note: z.string().nullish(),
      }),
    )
    .max(30)
    .nullish(),
});

const JSON_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['clean', 'concerns', 'blocker'] },
    summary: {
      type: 'string',
      description:
        'Overall review of the work as it stands, 2-5 sentences for the human who decides: what the change does, whether it satisfies the task, and what is left. Not a list of the findings.',
    },
    findings: {
      type: 'array',
      maxItems: 30,
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          summary: { type: 'string' },
          detail: { type: ['string', 'null'] },
        },
        required: ['severity', 'summary'],
      },
    },
    previous: {
      type: 'array',
      maxItems: 30,
      description:
        'Fix rounds only: one entry per numbered earlier finding — whether the change as it now stands resolves it.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          status: { type: 'string', enum: ['resolved', 'unresolved'] },
          note: { type: ['string', 'null'] },
        },
        required: ['id', 'status'],
      },
    },
  },
  required: ['verdict', 'summary', 'findings'],
};

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE') env[k] = v;
  }
  return env;
}

function runReviewer(
  repo: Repo,
  task: Task,
  model: string,
  effort: string | null,
  prompt: string,
): Promise<AuxOutcome<z.infer<typeof findingsSchema>>> {
  // A terminal of its own (kind `review`, subject = the task), attachable
  // from the auto-review badge. Read-only exactly as the `-p` reviewer was:
  // `dontAsk` + the same denials; the tools list only trims schemas.
  return aux().run({
    kind: 'review',
    subjectId: task.id,
    repoId: repo.id,
    label: `review: ${task.title}`,
    cwd: repo.path,
    model,
    effort,
    prompt: prompt + '\n' + resultInstruction(JSON_SCHEMA),
    tools: READ_ONLY_TOOLS,
    disallowedTools: READ_ONLY_DISALLOWED,
    permission: 'dontAsk',
    lean: true,
    timeoutMs: 10 * 60_000,
    accept: acceptJson(findingsSchema),
  });
}

/**
 * Paths and states that are never the worker's change, excluded from the diff
 * (and therefore from its hash — the "reviewed once" gate is only as good as
 * the diff's signal):
 * - `.claude/worktrees/`: the CLI's own worktree directory. It is a nested git
 *   repo, so `git add -N .` records it as a gitlink and every diff shows
 *   `+Subproject commit …` for it.
 * - `.worktrees/`: the same, made by hand — a repo's CLAUDE.md that tells its
 *   agents to work in "their own worktree" gets one nested in the checkout
 *   (neko-frontend task 27fbfba5).
 * - `--ignore-submodules=dirty`: a submodule (or an already-tracked gitlink of
 *   the above) whose work tree is merely dirty renders as
 *   `-Subproject commit X` / `+Subproject commit X-dirty` — bytes that change
 *   with every read and nothing the superproject could ever commit. A pointer
 *   moved to a different commit still shows.
 * Without this a turn that wrote nothing reviewed as "nothing implemented"
 * (blocker) round after round.
 */
export const DIFF_EXCLUDES = [':!.claude/worktrees', ':!.worktrees'];
const DIFF_CMD = `git add -N -- . ${DIFF_EXCLUDES.map((e) => `'${e}'`).join(' ')} 2>/dev/null; git diff HEAD --ignore-submodules=dirty -- . ${DIFF_EXCLUDES.map((e) => `'${e}'`).join(' ')}`;

function gitDiff(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    // include untracked-file content too (worker may have created files)
    execFile(
      'bash',
      ['-c', DIFF_CMD],
      { cwd, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, env: cleanEnv() },
      (_err, stdout) => resolve(String(stdout ?? '')),
    );
  });
}

/** stdout of a git command (argv, never a shell); null when git failed. */
function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, env: cleanEnv() },
      (err, stdout) => resolve(err ? null : String(stdout ?? '')),
    );
  });
}

/** git's well-known empty tree: the "parent" of a root commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * The repo's HEAD sha and branch right now — a task's base, taken when its
 * first worker run spawns (`Task.baseSha`). null when cwd is not a git repo
 * or has no commit yet.
 */
export async function readHeadBase(cwd: string): Promise<{ sha: string; ref: string } | null> {
  const sha = (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']))?.trim();
  if (!sha) return null;
  const ref = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() || 'HEAD';
  return { sha, ref };
}

/**
 * The commit HEAD's first-parent line stood on at `at` — the base of a task
 * that ran before bases were recorded (migration 29), taken from its first
 * run's start time. Committer dates, so only as good as the repo's clock.
 */
export async function headAt(cwd: string, at: string): Promise<string | null> {
  return (await git(cwd, ['rev-list', '-1', '--first-parent', `--before=${at}`, 'HEAD']))?.trim() || null;
}

export interface TaskCommit {
  sha: string;
  subject: string;
}

/**
 * Which commits are this task's, and how that was decided:
 * - `trailer`: commits on ANY ref (worktree branches included) whose message
 *   carries `Task: <id>` — the worker prompt asks for it on every commit;
 * - `base`: none carry it, and no other task's worker ran in the repo during
 *   the task's window, so base..HEAD inside the window is this task's;
 * - `none`: no commits attributed (clean, uncommitted-only, or ambiguous).
 */
export type CommitAttribution = 'trailer' | 'base' | 'none';

export interface ChangeScope {
  taskId: string;
  /** the task's base (Task.baseSha); null = none known, trailer only */
  baseSha: string | null;
  /** ISO end of the task's work window: its last landing, or now while it runs */
  until: string;
  /** no other task's worker run overlapped [baseAt, until] in this repo */
  soleWorker: boolean;
  /**
   * read the uncommitted `git diff HEAD` as part of the change — false once
   * another task's worker has started in this checkout after the window
   */
  includeUncommitted: boolean;
  /**
   * a live worktree task (docs/parallel.md): its change is exactly
   * `baseSha..HEAD` in its own tree — the trailer search over every ref would
   * also list the pre-rebase copies on `origin/tm/…` and an earlier squash
   */
  branchRange?: boolean;
}

const LOG_FORMAT = '--format=%H%x09%P%x09%s';

function parseLog(out: string | null): { sha: string; parents: string[]; subject: string }[] {
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, parents = '', ...subject] = line.split('\t');
      return { sha, parents: parents.split(' ').filter(Boolean), subject: subject.join('\t') };
    });
}

export async function taskCommits(
  cwd: string,
  scope: ChangeScope,
): Promise<{ commits: { sha: string; parents: string[]; subject: string }[]; attribution: CommitAttribution }> {
  if (scope.branchRange && scope.baseSha) {
    const own = parseLog(await git(cwd, ['log', '--no-merges', '--topo-order', '--reverse', LOG_FORMAT, `${scope.baseSha}..HEAD`]));
    return own.length ? { commits: own, attribution: 'base' } : { commits: [], attribution: 'none' };
  }
  // --all covers every ref and every linked worktree's HEAD, so work on a
  // worktree branch counts before it is merged. Merge commits are left out:
  // the commits they bring in are listed themselves, and a merge's own diff
  // is ambiguous.
  const tagged = parseLog(
    await git(cwd, ['log', '--all', '--no-merges', '--topo-order', '--reverse', '-F', `--grep=Task: ${scope.taskId}`, LOG_FORMAT]),
  );
  if (tagged.length) return { commits: tagged, attribution: 'trailer' };
  if (!scope.baseSha || !scope.soleWorker) return { commits: [], attribution: 'none' };
  // Fallback for a commit without the trailer (a pre-trailer task, or an
  // agent that forgot): safe only when nobody else worked in the repo in
  // the window, and bounded by the window's end so a LATER task's commits
  // never land in a Review now of this one.
  const ranged = parseLog(
    await git(cwd, ['log', '--no-merges', '--topo-order', '--reverse', `--until=${scope.until}`, LOG_FORMAT, `${scope.baseSha}..HEAD`]),
  );
  return ranged.length ? { commits: ranged, attribution: 'base' } : { commits: [], attribution: 'none' };
}

/**
 * The committed half of the change. A linear run of commits (each the
 * parent of the next — the usual case) is ONE net diff from the first one's
 * parent to the last, so the reviewer judges the result, not every
 * intermediate state; anything else (commits spread over branches) is each
 * commit's own patch in order.
 */
async function committedDiff(cwd: string, commits: { sha: string; parents: string[] }[]): Promise<string> {
  const scoped = ['--no-color', '--ignore-submodules=dirty', '--', '.', ...DIFF_EXCLUDES];
  const linear = commits.every((c, i) => c.parents.length <= 1 && (i === 0 || c.parents[0] === commits[i - 1].sha));
  if (linear) {
    const from = commits[0].parents[0] ?? EMPTY_TREE;
    return (await git(cwd, ['diff', from, commits[commits.length - 1].sha, ...scoped])) ?? '';
  }
  const parts: string[] = [];
  for (const c of commits) {
    const patch = await git(cwd, ['show', '--format=', c.sha, ...scoped]);
    parts.push(`### commit ${c.sha.slice(0, 12)}\n${patch ?? '(could not read this commit)\n'}`);
  }
  return parts.join('\n');
}

export interface WorkerDiff {
  /**
   * what the reviewer reads, untruncated: the task's committed diff, then the
   * uncommitted `git diff HEAD` — or, with no commits, exactly the raw
   * uncommitted diff (so a hash taken before commits were read still matches)
   */
  diff: string;
  /** the task's commits, oldest first */
  commits: TaskCommit[];
  attribution: CommitAttribution;
  /** sha256 of the commit list + `diff`; null when the task changed nothing */
  hash: string | null;
  /** files / +lines / -lines of `diff` (docs/inbox.md § Review rows) */
  stat: DiffStat;
}

/**
 * Counted off the diff text the reviewer reads, so no second git read: a file
 * is a distinct `diff --git` path (one touched by a commit AND left
 * uncommitted counts once), a line is a `+`/`-` line INSIDE a hunk — so the
 * `+++`/`---` file headers and this module's own `--- committed …` markers
 * never count, and a removed line that itself began with `--` still does.
 */
export function diffStat(diff: string): DiffStat {
  const files = new Set<string>();
  let insertions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      const m = / b\/(.*)$/.exec(line);
      files.add(m ? m[1] : line);
    } else if (line.startsWith('@@')) inHunk = true;
    else if (!inHunk) continue;
    else if (line.startsWith('+')) insertions++;
    else if (line.startsWith('-')) deletions++;
    else if (!line.startsWith(' ') && !line.startsWith('\\')) inHunk = false; // a marker or `### commit` line ends it
  }
  return { files: files.size, insertions, deletions };
}

/**
 * One short digest per file of the reviewed diff, so a fix round can be told
 * which files moved since the round it answers (docs/design.md § Adversarial
 * review). A file's digest covers every section the diff has for it — each
 * commit's and the uncommitted one — so a new fix commit touching it, or an
 * edit left uncommitted, changes it, and a file the fix never touched keeps
 * it. `index` lines are left out: the same content shown by `git show` and
 * by `git diff HEAD` carries different blob ranges.
 */
export function fileDigests(diff: string): Record<string, string> {
  const parts = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.*)$/.exec(line);
      const file = m ? m[1] : line;
      current = parts.get(file) ?? [];
      parts.set(file, current);
      current.push('\0');
      continue;
    }
    // this module's own section markers end a file's section
    if (line.startsWith('### commit ') || /^--- (committed|uncommitted) /.test(line)) {
      current = null;
      continue;
    }
    if (current && !line.startsWith('index ')) current.push(line);
  }
  const out: Record<string, string> = {};
  for (const [file, lines] of parts) {
    out[file] = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
  }
  return out;
}

/** What a fix round is told about the round it answers. */
export interface PreviousReview {
  /** the fix round this review is (1 = the first re-review) */
  fixRound: number;
  /** that round's number in `task.reviewRounds` */
  round: number;
  /** its BLOCKER/MAJOR findings only — minors are never carried into a fix round */
  findings: ReviewFinding[];
  /** its `fileDigests`, null on a round recorded before they were kept */
  files: Record<string, string> | null;
  /** the commit shas it saw, null likewise */
  commits: string[] | null;
}

/** Minor findings a fix round may add — informational, nobody is asked to fix them. */
export const FIX_ROUND_MAX_MINORS = 3;

/**
 * The change THIS task made, plus its identity: its commits (by trailer on
 * any ref, else base..HEAD when it worked alone) and whatever is still
 * uncommitted. Hashed BEFORE truncation so two changes that only differ past
 * the 60k prompt cap still compare unequal; the commit shas are in the hash,
 * so a turn that only talked hashes the same and a new commit does not. The
 * orchestrator calls this once per round and passes it into
 * `reviewWorkerChange`, so git runs once whether or not the review does.
 */
export async function workerDiff(repo: Repo, scope: ChangeScope): Promise<WorkerDiff> {
  const { commits, attribution } = await taskCommits(repo.path, scope);
  const uncommitted = scope.includeUncommitted ? await gitDiff(repo.path) : '';
  const list = commits.map((c) => ({ sha: c.sha, subject: c.subject }));
  let diff = uncommitted;
  const committed = commits.length ? await committedDiff(repo.path, commits) : '';
  if (commits.length) {
    diff = [
      `--- committed (${commits.length} commit${commits.length === 1 ? '' : 's'}) ---`,
      committed.trim() ? committed : '(the commits change nothing outside the excluded paths)\n',
      `--- uncommitted (git diff HEAD) ---`,
      uncommitted.trim()
        ? uncommitted
        : scope.includeUncommitted
          ? '(none)\n'
          : '(not read: another task has worked in this checkout since)\n',
    ].join('\n');
  }
  // Commits whose only content is excluded noise changed nothing either.
  if (!committed.trim() && !uncommitted.trim()) {
    return { diff, commits: list, attribution, hash: null, stat: { files: 0, insertions: 0, deletions: 0 } };
  }
  const hash = createHash('sha256');
  for (const c of list) hash.update(`${c.sha}\n`);
  return { diff, commits: list, attribution, hash: hash.update(diff).digest('hex'), stat: diffStat(diff) };
}

/**
 * A read-only git command for `taskChangeRead`: argv, never a shell, and
 * `GIT_OPTIONAL_LOCKS=0` so `git diff HEAD` never refreshes (rewrites) the
 * index the way a plain read may. `ok` lists the exit codes that still mean
 * success (`git diff --no-index` exits 1 when the files differ).
 */
function gitRead(cwd: string, args: string[], ok: number[] = [0]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, env: { ...cleanEnv(), GIT_OPTIONAL_LOCKS: '0' } },
      (err, stdout) => {
        const code = err ? (err as { code?: unknown }).code : 0;
        resolve(typeof code === 'number' && ok.includes(code) ? String(stdout ?? '') : null);
      },
    );
  });
}

/** an untracked file bigger than this is listed without reading it */
const UNTRACKED_READ_MAX = 2 * DIFF_FILE_PATCH_CAP;
/**
 * wall-clock budget for the untracked reads: one `git diff --no-index` per
 * file costs 45–120 ms under tsx (measured), so 200 of them could hold the
 * panel for 20 s; what is not read in time is listed without a patch
 */
const UNTRACKED_READ_BUDGET_MS = 6_000;

export interface TaskChangeRead {
  commits: TaskCommit[];
  attribution: CommitAttribution;
  /** complete list; patches cut to the caps */
  files: TaskDiffFile[];
  stat: DiffStat;
  truncated: boolean;
  untrackedCapped: boolean;
}

/**
 * The same change `workerDiff` hands the reviewer — the task's commits
 * (`taskCommits`, `committedDiff`, unchanged) and, when the scope includes it,
 * the uncommitted tree — but split per file for the task panel and WITHOUT
 * writing to git: no `git add -N` (which is what makes `workerDiff` show
 * untracked files and is a write to the index), the tree read by
 * `git diff-index` (the porcelain rewrites a stat-dirty index); untracked files are read one
 * by one with `git diff --no-index /dev/null <file>` instead, at most
 * `UNTRACKED_DIFF_CAP` of them within `UNTRACKED_READ_BUDGET_MS` (the rest
 * listed without a patch, `untrackedCapped`). The
 * reviewer's diff and hash are untouched by this (docs/task-diff.md).
 */
export async function taskChangeRead(repo: Repo, scope: ChangeScope): Promise<TaskChangeRead> {
  const cwd = repo.path;
  const { commits, attribution } = await taskCommits(cwd, scope);
  const parts: string[] = [];
  if (commits.length) {
    parts.push(`--- committed (${commits.length} commit${commits.length === 1 ? '' : 's'}) ---`, await committedDiff(cwd, commits), '');
  }
  const listedOnly: TaskDiffFile[] = [];
  let untrackedCapped = false;
  if (scope.includeUncommitted) {
    parts.push('--- uncommitted (git diff HEAD) ---');
    // `git diff-index`, not porcelain `git diff HEAD`: the porcelain refreshes
    // a stat-dirty index and WRITES it, GIT_OPTIONAL_LOCKS=0 or not (measured,
    // git 2.52); the plumbing compares contents and leaves the index alone.
    // `-M` because plumbing does not read diff.renames.
    parts.push(
      (await gitRead(cwd, ['diff-index', '-p', '-M', '--no-color', '--ignore-submodules=dirty', 'HEAD', '--', '.', ...DIFF_EXCLUDES])) ?? '',
    );
    const others = ((await gitRead(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ...DIFF_EXCLUDES])) ?? '')
      .split('\0')
      .filter(Boolean);
    untrackedCapped = others.length > UNTRACKED_DIFF_CAP;
    const patches: string[] = new Array(Math.min(others.length, UNTRACKED_DIFF_CAP)).fill('');
    let next = 0;
    const deadline = Date.now() + UNTRACKED_READ_BUDGET_MS;
    const worker = async () => {
      while (next < patches.length) {
        const i = next++;
        const file = others[i];
        if (Date.now() > deadline) {
          untrackedCapped = true;
          listedOnly.push(untrackedListed(file, true));
          continue;
        }
        let st: fs.Stats | null = null;
        try {
          st = fs.lstatSync(path.join(cwd, file));
        } catch {
          st = null;
        }
        if (!st || st.isDirectory() || st.size > UNTRACKED_READ_MAX) {
          // a nested repo (`dir/`), a vanished file, or one too big to read
          listedOnly.push(untrackedListed(file, !!st && !st.isDirectory()));
          continue;
        }
        const patch = await gitRead(cwd, ['diff', '--no-index', '--no-color', '--', '/dev/null', file], [0, 1]);
        if (patch === null) listedOnly.push(untrackedListed(file, true));
        else if (!patch.trim()) listedOnly.push(untrackedListed(file, false)); // an empty file: no diff text, still a new file
        else patches[i] = patch;
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, patches.length) }, worker));
    parts.push(...patches.filter(Boolean));
    for (const file of others.slice(UNTRACKED_DIFF_CAP)) listedOnly.push(untrackedListed(file, true));
  }
  const parsed = splitDiffFiles(parts.join('\n'));
  const seen = new Set(parsed.map((f) => f.path));
  const unread = listedOnly.filter((f) => !seen.has(f.path)).sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const all = [...parsed, ...unread];
  const capped = capDiffFiles(all);
  return {
    commits: commits.map((c) => ({ sha: c.sha, subject: c.subject })),
    attribution,
    files: capped.files,
    stat: diffFilesStat(capped.files),
    truncated: capped.truncated || untrackedCapped,
    untrackedCapped,
  };
}

/** An untracked file listed without its content; `cut` = it has content that was not read. */
function untrackedListed(file: string, cut: boolean): TaskDiffFile {
  return {
    path: file.replace(/\/$/, ''),
    status: 'added',
    insertions: 0,
    deletions: 0,
    binary: false,
    sections: cut ? [{ source: 'uncommitted', patch: '', truncated: true }] : [],
  };
}

export interface ReviewResult {
  markdown: string;
  verdict: ReviewVerdict;
  /** the reviewer's overall reading of the work; null when it could not run */
  summary: string | null;
  findings: ReviewFinding[];
  model: string;
  effort: string | null;
  /** why the reviewer produced no verdict of its own (the verdict is then `concerns`) */
  error: string | null;
  /** fix rounds only: the earlier blocker/major findings, each resolved or not */
  resolutions: ReviewResolution[] | null;
}

const findingLine = (f: ReviewFinding): string => `[${f.severity}] ${f.summary}${f.detail ? ` — ${f.detail}` : ''}`;

/**
 * The reviewer's brief. With `previous` this is a fix round, and it converges
 * (docs/design.md § Adversarial review): only the previous round's
 * blocker/major findings are quoted, numbered, for a resolved/unresolved
 * verdict each; `findings` is for NEW issues only, with minors capped; and the
 * reviewer is told which files and commits changed since that round, over
 * the full diff, which it still gets because the fix can break earlier code.
 */
function reviewPrompt(
  repo: Repo,
  task: Task,
  change: WorkerDiff,
  diff: string,
  previous: PreviousReview | null,
): string {
  const lines = [
    `You are an adversarial code reviewer for the repo "${repo.name}". A worker agent implemented the task`,
    `below; its change is the diff at the end — the commits it made for this task${change.commits.length ? ' (listed there)' : ' (none)'}`,
    `plus whatever it left uncommitted. The human who decides whether this ships will read YOUR summary`,
    `first, so write it for them.`,
    `\n# ${task.title}\n${task.description ?? ''}`,
    `\nWorker's own account of what it did (its last message, not necessarily the whole story):\n${task.resultSummary ?? '(none)'}`,
  ];
  // The human's definition of done (docs/checks.md): what "satisfies the task" means here.
  if (task.acceptance?.trim()) {
    lines.push(`\n## Acceptance criteria (the definition of done — judge the change against these)\n${task.acceptance.trim()}`);
  }
  // Evidence, not claims: the checks the SERVER ran on exactly this change.
  // Results measured on another change (a later edit, a Review now) are left out.
  const evidence = task.checkDiffHash && task.checkDiffHash === change.hash ? checkEvidence(task) : null;
  if (evidence) {
    lines.push(
      `\n${evidence}`,
      `A green check is evidence the code builds/passes, not that the task is done — still judge the diff. A check`,
      `that was weakened, skipped or deleted in the diff to turn green is a blocker.`,
    );
  }
  if (previous) {
    lines.push(
      `\nThis is fix round ${previous.fixRound}. Review round ${previous.round} sent the blocker/major findings below back`,
      `to the worker, which was told to fix exactly those and nothing else (minor findings are not carried forward):`,
      ...previous.findings.map((f, i) => `${i + 1}. ${findingLine(f)}`),
      ``,
      changedSince(previous, change),
      `\nJudge the change AS IT NOW STANDS:`,
      `- "previous": one entry per numbered finding above — {"id": <number>, "status": "resolved" | "unresolved",`,
      `  "note": one line why}. A numbered finding you do not mark resolved counts as still open.`,
      `- "findings": NEW issues only — a blocker/major the fix introduced, or one round ${previous.round} missed, plus at`,
      `  most ${FIX_ROUND_MAX_MINORS} minors (informational: nobody will be asked to fix them). Never re-list a numbered finding`,
      `  in "findings" — its "previous" entry already says whether it is open.`,
    );
  }
  lines.push(
    `\nReview the change adversarially — hunt real correctness bugs, regressions, missed edge cases, security`,
    `issues, and anything that does not actually satisfy the task. Read files in the repo for context as needed.`,
    `Do NOT rubber-stamp; if it is genuinely fine, say so with verdict "clean".`,
    `\nReturn the structured schema:`,
    `- "summary": an overall review of the work as it stands, 2-5 sentences — what the change does, whether`,
    `  it satisfies the task, what (if anything) is left. This is the human's summary of the work, not a`,
    `  restatement of the findings.`,
    `- "verdict": "clean" (nothing actionable), "concerns" (minor findings only), "blocker" (a blocker/major`,
    `  finding that must be fixed before this ships).`,
    `- "findings": severity blocker/major/minor, most severe first. Blocker = wrong or unsafe; major = the`,
    `  task is not satisfied or a real bug; minor = worth noting, would not stop shipping.`,
  );
  if (change.commits.length) {
    lines.push(
      `\n--- this task's commits, oldest first (${
        change.attribution === 'trailer'
          ? 'found by their `Task: ` trailer'
          : 'base..HEAD: no other task worked in this repo meanwhile'
      }) ---`,
      ...change.commits.map(
        (c) =>
          `${c.sha.slice(0, 12)} ${c.subject}${
            previous?.commits && !previous.commits.includes(c.sha) ? `  (new since round ${previous.round})` : ''
          }`,
      ),
    );
  }
  lines.push(`\n--- git diff (the task's change) ---\n${diff}`);
  return lines.join('\n');
}

/**
 * The fix-round reviewer's map of the delta: which files' diff moved since the
 * round it answers. A hint over the full diff, never a replacement for it.
 */
function changedSince(previous: PreviousReview, change: WorkerDiff): string {
  if (!previous.files) {
    return `Which files changed since round ${previous.round} is not known (that round predates the record) — review the whole diff.`;
  }
  const now = fileDigests(change.diff);
  const changed = Object.keys(now).filter((f) => previous.files![f] !== now[f]);
  const dropped = Object.keys(previous.files).filter((f) => !(f in now));
  if (!changed.length && !dropped.length) {
    return `No file's diff changed since round ${previous.round} — only the commit list did. Judge the numbered findings against the diff as it stands.`;
  }
  const out = [
    `Changed since round ${previous.round} (the fix): ${changed.length ? changed.join(', ') : '(no file added or edited)'}.`,
  ];
  if (dropped.length) out.push(`No longer part of the change: ${dropped.join(', ')}.`);
  out.push(
    `Everything else in the diff below is what round ${previous.round} already reviewed. Focus on the changed files, but the`,
    `full diff is there on purpose: judge how the fix interacts with the rest of the change.`,
  );
  return out.join('\n');
}

/**
 * A fix round's findings, merged on the server so the gate cannot be argued
 * away: every numbered earlier finding the reviewer did not mark resolved is
 * a finding again (its original severity and text, plus the reviewer's note),
 * so is one it marked resolved but listed again (the duplicate is dropped), new
 * blocker/major findings stand, and at most FIX_ROUND_MAX_MINORS minors ride
 * along. The verdict is derived from the merged list, since that is what the
 * review state is (`settledReviewState`).
 */
function mergeFixRound(
  previous: PreviousReview,
  reported: { severity: ReviewFinding['severity']; summary: string; detail?: string | null }[],
  statuses: { id: number; status: 'resolved' | 'unresolved'; note?: string | null }[] | null | undefined,
): { findings: ReviewFinding[]; resolutions: ReviewResolution[]; verdict: ReviewVerdict } {
  const key = (summary: string) => summary.trim().toLowerCase();
  const relisted = new Set(reported.map((f) => key(f.summary)));
  const resolutions: ReviewResolution[] = previous.findings.map((f, i) => {
    const said = statuses?.find((s) => s.id === i + 1);
    // "resolved" but listed again as a finding contradicts itself: it stays open
    const again = relisted.has(key(f.summary));
    return {
      severity: f.severity === 'blocker' ? 'blocker' : 'major',
      summary: f.summary,
      status: said?.status === 'resolved' && !again ? 'resolved' : 'unresolved',
      note:
        said?.note?.trim() ||
        (said ? null : again ? 'listed again as a finding' : 'the reviewer did not say whether this was resolved'),
    };
  });
  const open: ReviewFinding[] = previous.findings
    .map((f, i) => ({ f, r: resolutions[i] }))
    .filter(({ r }) => r.status === 'unresolved')
    .map(({ f, r }) => ({
      severity: f.severity,
      summary: f.summary,
      detail: [f.detail, r.note ? `Still open: ${r.note}` : null].filter(Boolean).join(' — ') || null,
    }));
  const earlier = new Set(previous.findings.map((f) => key(f.summary)));
  const fresh = reported
    .filter((f) => !earlier.has(key(f.summary)))
    .map((f) => ({ severity: f.severity, summary: f.summary, detail: f.detail ?? null }));
  const rank = { blocker: 0, major: 1, minor: 2 } as const;
  const actionable = fresh.filter((f) => f.severity !== 'minor').sort((a, b) => rank[a.severity] - rank[b.severity]);
  const minors = fresh.filter((f) => f.severity === 'minor').slice(0, FIX_ROUND_MAX_MINORS);
  const findings = [...open, ...actionable, ...minors];
  const verdict: ReviewVerdict =
    open.length || actionable.length ? 'blocker' : minors.length ? 'concerns' : 'clean';
  return { findings, resolutions, verdict };
}

/**
 * Returns the structured review, or null if there was nothing to review.
 * `change` comes from `workerDiff()` — the caller already produced it to
 * decide whether this diff is new; re-running git here would cost a second
 * `git add -N` on the same tree.
 */
export async function reviewWorkerChange(
  repo: Repo,
  task: Task,
  /** the RESOLVED reviewer: task.reviewModel ?? review.model, task.reviewEffort */
  reviewer: { model: string; effort: string | null },
  change: WorkerDiff,
  previous: PreviousReview | null = null,
): Promise<ReviewResult | null> {
  const diff = change.diff.slice(0, 60_000);
  if (!diff.trim()) return null; // no change to review (e.g. read-only task)

  const prompt = reviewPrompt(repo, task, change, diff, previous);

  // The requested reviewer first (a Fable request goes straight to Opus once
  // Fable is known unavailable); on `model_not_found` only, fall back to
  // FALLBACK_MODEL at xhigh — or the task's own reviewer effort when it set one.
  // `model`/`effort` are what ACTUALLY ran, which the round records.
  const { res, model, effort } = await withModelFallback(reviewer, reviewer.effort ?? 'xhigh', (m, e) =>
    runReviewer(repo, task, m, e, prompt),
  );

  const failed = (error: string): ReviewResult => ({
    markdown: `_Adversarial review could not run: ${error}._`,
    verdict: 'concerns',
    summary: null,
    findings: [],
    model,
    effort,
    error,
    resolutions: null,
  });
  if (res.status !== 'ok' || !res.value) {
    // The runner's error is already the cause (StopFailure code + text,
    // "timed out after N min", or the exit plus the terminal's last words),
    // never an argv echo — so keep enough of it to read.
    return failed(`model ${model} — ${(res.error ?? 'no result').slice(0, 500)}`);
  }
  const parsed = { data: res.value };

  const summary = parsed.data.summary?.trim() || null;
  const merged = previous ? mergeFixRound(previous, parsed.data.findings, parsed.data.previous) : null;
  const verdict = merged?.verdict ?? parsed.data.verdict;
  const findings: ReviewFinding[] =
    merged?.findings ??
    parsed.data.findings.map((f) => ({ severity: f.severity, summary: f.summary, detail: f.detail ?? null }));
  const badge = verdict === 'clean' ? '✓ clean' : verdict === 'blocker' ? '⛔ blocker' : '⚠ concerns';
  const lines = [`**Adversarial review** (${model}${effort ? ` ${effort}` : ''}): ${badge}`];
  if (summary) lines.push('', summary, '');
  if (merged && previous) {
    lines.push(`Findings from round ${previous.round}:`);
    for (const r of merged.resolutions) {
      lines.push(
        `- ${r.status === 'resolved' ? '✓ resolved' : '✗ still open'}: **[${r.severity}]** ${r.summary}${r.note ? ` — ${r.note}` : ''}`,
      );
    }
    const fresh = findings.slice(merged.resolutions.filter((r) => r.status === 'unresolved').length);
    lines.push('', fresh.length ? 'New findings:' : 'No new issues found.');
    for (const f of fresh) lines.push(`- **[${f.severity}]** ${f.summary}${f.detail ? ` — ${f.detail}` : ''}`);
  } else if (findings.length === 0) {
    lines.push('No issues found.');
  } else {
    for (const f of findings) {
      lines.push(`- **[${f.severity}]** ${f.summary}${f.detail ? ` — ${f.detail}` : ''}`);
    }
  }
  return {
    markdown: lines.join('\n'),
    verdict,
    summary,
    findings,
    model,
    effort,
    error: null,
    resolutions: merged?.resolutions ?? null,
  };
}
