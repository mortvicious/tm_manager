import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Repo, ReviewFinding, ReviewVerdict, Task } from '@tm/shared';
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
 * - `--ignore-submodules=dirty`: a submodule (or an already-tracked gitlink of
 *   the above) whose work tree is merely dirty renders as
 *   `-Subproject commit X` / `+Subproject commit X-dirty` — bytes that change
 *   with every read and nothing the superproject could ever commit. A pointer
 *   moved to a different commit still shows.
 * Without this a turn that wrote nothing reviewed as "nothing implemented"
 * (blocker) round after round.
 */
export const DIFF_EXCLUDES = [':!.claude/worktrees'];
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

async function taskCommits(
  cwd: string,
  scope: ChangeScope,
): Promise<{ commits: { sha: string; parents: string[]; subject: string }[]; attribution: CommitAttribution }> {
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
}

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
  if (!committed.trim() && !uncommitted.trim()) return { diff, commits: list, attribution, hash: null };
  const hash = createHash('sha256');
  for (const c of list) hash.update(`${c.sha}\n`);
  return { diff, commits: list, attribution, hash: hash.update(diff).digest('hex') };
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
}

/**
 * The reviewer's brief. `fixRound` > 0 means the diff already went through a
 * fix round — the previous findings are quoted so the reviewer judges whether
 * they were actually addressed instead of rediscovering them from scratch.
 */
function reviewPrompt(
  repo: Repo,
  task: Task,
  change: WorkerDiff,
  diff: string,
  previous: { fixRound: number; findings: ReviewFinding[] } | null,
): string {
  const lines = [
    `You are an adversarial code reviewer for the repo "${repo.name}". A worker agent implemented the task`,
    `below; its change is the diff at the end — the commits it made for this task${change.commits.length ? ' (listed there)' : ' (none)'}`,
    `plus whatever it left uncommitted. The human who decides whether this ships will read YOUR summary`,
    `first, so write it for them.`,
    `\n# ${task.title}\n${task.description ?? ''}`,
    `\nWorker's own account of what it did (its last message, not necessarily the whole story):\n${task.resultSummary ?? '(none)'}`,
  ];
  if (previous && previous.fixRound > 0) {
    lines.push(
      `\nThis is fix round ${previous.fixRound}: a previous review returned the findings below and the worker`,
      `was told to fix the blocker/major ones. Judge the change AS IT NOW STANDS — say explicitly whether each`,
      `earlier finding is resolved, and do not re-list one that is. A finding that is still open stays a finding.`,
      ...previous.findings.map((f) => `- [${f.severity}] ${f.summary}${f.detail ? ` — ${f.detail}` : ''}`),
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
      ...change.commits.map((c) => `${c.sha.slice(0, 12)} ${c.subject}`),
    );
  }
  lines.push(`\n--- git diff (the task's change) ---\n${diff}`);
  return lines.join('\n');
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
  previous: { fixRound: number; findings: ReviewFinding[] } | null = null,
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
  });
  if (res.status !== 'ok' || !res.value) {
    // The runner's error is already the cause (StopFailure code + text,
    // "timed out after N min", or the exit plus the terminal's last words),
    // never an argv echo — so keep enough of it to read.
    return failed(`model ${model} — ${(res.error ?? 'no result').slice(0, 500)}`);
  }
  const parsed = { data: res.value };

  const { verdict, findings } = parsed.data;
  const summary = parsed.data.summary?.trim() || null;
  const badge = verdict === 'clean' ? '✓ clean' : verdict === 'blocker' ? '⛔ blocker' : '⚠ concerns';
  const lines = [`**Adversarial review** (${model}${effort ? ` ${effort}` : ''}): ${badge}`];
  if (summary) lines.push('', summary, '');
  if (findings.length === 0) {
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
    findings: findings.map((f) => ({ severity: f.severity, summary: f.summary, detail: f.detail ?? null })),
    model,
    effort,
    error: null,
  };
}
