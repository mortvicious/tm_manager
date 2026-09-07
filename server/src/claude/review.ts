import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Repo, ReviewFinding, ReviewVerdict, Task } from '@tm/shared';
import { registerHeadless } from './headless.ts';

// Adversarial review of a worker's change — exactly how we work: read the diff,
// hunt correctness bugs / regressions / missed edges / security, report findings,
// human decides. Runs on Fable; falls back to Opus 5 xhigh when Fable is
// unavailable on this account (cached after the first detection).
//
// Besides the findings the reviewer writes an overall SUMMARY of the work as it
// stands — what the change does and whether it satisfies the task — because
// the worker's own last message, after a fix round, is only "fixed 1 and 2"
// and the human needs the whole picture in one place (the task panel shows
// the latest round's summary at the top of the review section).

let fableUnavailable = false;

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

const JSON_SCHEMA = JSON.stringify({
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
});

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE') env[k] = v;
  }
  return env;
}

function runClaude(
  cwd: string,
  model: string,
  effort: string | null,
  prompt: string,
  /** what this child is doing, for the restart guard's refusal message */
  label: string,
): Promise<{ envelope: any; err: Error | null; stdout: string }> {
  const args = [
    '-p',
    '--model',
    model,
    ...(effort ? ['--effort', effort] : []),
    '--permission-mode',
    'dontAsk',
    '--disallowedTools',
    'Edit',
    'Write',
    'NotebookEdit',
    'Bash',
    '--output-format',
    'json',
    '--json-schema',
    JSON_SCHEMA,
  ];
  return new Promise((resolve) => {
    const child = execFile(
      'claude',
      args,
      { cwd, timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024, env: cleanEnv() },
      (err, stdout) => {
        let envelope: any = null;
        try {
          envelope = JSON.parse(String(stdout ?? ''));
        } catch {
          /* non-JSON = failure */
        }
        resolve({ envelope, err, stdout: String(stdout ?? '') });
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.write(prompt);
    child.stdin?.end();
    // This reviewer owns no run row (it runs inside the worker's completion
    // path), so the registry is the ONLY thing that knows it is working.
    registerHeadless(child, label);
  });
}

function gitDiff(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    // include untracked-file content too (worker may have created files)
    execFile(
      'bash',
      ['-c', 'git add -N . 2>/dev/null; git diff HEAD'],
      { cwd, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, env: cleanEnv() },
      (_err, stdout) => resolve(String(stdout ?? '')),
    );
  });
}

export interface WorkerDiff {
  /** raw `git diff HEAD` output, untruncated */
  diff: string;
  /** sha256 of that raw output; null when the diff is empty */
  hash: string | null;
}

/**
 * The change a Stop produced, plus its identity. Hashed BEFORE truncation so
 * two diffs that only differ past the 60k prompt cap still compare unequal.
 * The orchestrator calls this once per Stop and passes the diff into
 * `reviewWorkerChange`, so git runs once whether or not the review does.
 */
export async function workerDiff(repo: Repo): Promise<WorkerDiff> {
  const diff = await gitDiff(repo.path);
  if (!diff.trim()) return { diff, hash: null };
  return { diff, hash: createHash('sha256').update(diff).digest('hex') };
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
  diff: string,
  previous: { fixRound: number; findings: ReviewFinding[] } | null,
): string {
  const lines = [
    `You are an adversarial code reviewer for the repo "${repo.name}". A worker agent implemented the task`,
    `below; its change is the uncommitted diff at the end. The human who decides whether this ships will`,
    `read YOUR summary first, so write it for them.`,
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
    `\n--- git diff (the worker's uncommitted change) ---\n${diff}`,
  );
  return lines.join('\n');
}

/**
 * Returns the structured review, or null if there was nothing to review.
 * `rawDiff` comes from `workerDiff()` — the caller already produced it to
 * decide whether this diff is new; re-running git here would cost a second
 * `git add -N` on the same tree.
 */
export async function reviewWorkerChange(
  repo: Repo,
  task: Task,
  reviewModel: string,
  rawDiff: string,
  previous: { fixRound: number; findings: ReviewFinding[] } | null = null,
): Promise<ReviewResult | null> {
  const diff = rawDiff.slice(0, 60_000);
  if (!diff.trim()) return null; // no change to review (e.g. read-only task)

  const prompt = reviewPrompt(repo, task, diff, previous);

  const attempt = async (model: string, effort: string | null) =>
    runClaude(repo.path, model, effort, prompt, `reviewing "${task.title}"`);

  // Fable first (unless already known unavailable); on a model-availability
  // failure, fall back to Opus 5 at xhigh — exactly as specified.
  let model = fableUnavailable ? 'claude-opus-5' : reviewModel;
  let effort: string | null = fableUnavailable ? 'xhigh' : null;
  let res = await attempt(model, effort);

  const modelUnavailable =
    (!res.envelope || res.envelope.is_error) &&
    /model|not.*available|unknown model|unavailable|not.*found|access/i.test(res.stdout + String(res.err?.message ?? ''));
  if (modelUnavailable && model !== 'claude-opus-5') {
    fableUnavailable = true;
    model = 'claude-opus-5';
    effort = 'xhigh';
    res = await attempt(model, effort);
  }

  const failed = (error: string): ReviewResult => ({
    markdown: `_Adversarial review could not run: ${error}._`,
    verdict: 'concerns',
    summary: null,
    findings: [],
    model,
    effort,
    error,
  });
  if (!res.envelope || res.envelope.is_error || !res.envelope.structured_output) {
    const why = res.err?.message ?? (res.envelope?.is_error ? String(res.envelope.result ?? 'reviewer error') : 'no structured output');
    return failed(`model ${model} — ${why.slice(0, 200)}`);
  }
  const parsed = findingsSchema.safeParse(res.envelope.structured_output);
  if (!parsed.success) return failed('unparseable result');

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
