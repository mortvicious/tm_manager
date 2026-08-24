import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { Repo, Task } from '@tm/shared';

// Adversarial review of a worker's change — exactly how we work: read the diff,
// hunt correctness bugs / regressions / missed edges / security, report findings,
// human decides. Runs on Fable; falls back to Opus 5 xhigh when Fable is
// unavailable on this account (cached after the first detection).

let fableUnavailable = false;

const findingsSchema = z.object({
  verdict: z.enum(['clean', 'concerns', 'blocker']),
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
  required: ['verdict', 'findings'],
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

export interface ReviewResult {
  markdown: string;
  verdict: 'clean' | 'concerns' | 'blocker';
  findings: { severity: 'blocker' | 'major' | 'minor'; summary: string; detail?: string | null }[];
  model: string;
}

/** Returns the structured review, or null if there was nothing to review. */
export async function reviewWorkerChange(repo: Repo, task: Task, reviewModel: string): Promise<ReviewResult | null> {
  const diff = (await gitDiff(repo.path)).slice(0, 60_000);
  if (!diff.trim()) return null; // no change to review (e.g. read-only task)

  const prompt = [
    `You are an adversarial code reviewer. A worker agent just implemented this task in the repo "${repo.name}":`,
    `\n# ${task.title}\n${task.description ?? ''}`,
    `\nWorker's own summary of what it did:\n${task.resultSummary ?? '(none)'}`,
    `\nReview ITS CHANGE below adversarially — hunt real correctness bugs, regressions, missed edge cases,`,
    `security issues, and anything that doesn't actually satisfy the task. Read files in the repo for context`,
    `as needed. Do NOT rubber-stamp; if it's genuinely fine, say so with verdict "clean". Return findings via`,
    `the structured schema (severity blocker/major/minor), most severe first.`,
    `\n--- git diff (the worker's uncommitted change) ---\n${diff}`,
  ].join('\n');

  const attempt = async (model: string, effort: string | null) => runClaude(repo.path, model, effort, prompt);

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

  if (!res.envelope || res.envelope.is_error || !res.envelope.structured_output) {
    return { markdown: `_Adversarial review could not run (model ${model})._`, verdict: 'concerns', findings: [], model };
  }
  const parsed = findingsSchema.safeParse(res.envelope.structured_output);
  if (!parsed.success) {
    return { markdown: `_Adversarial review returned an unparseable result._`, verdict: 'concerns', findings: [], model };
  }

  const { verdict, findings } = parsed.data;
  const badge = verdict === 'clean' ? '✓ clean' : verdict === 'blocker' ? '⛔ blocker' : '⚠ concerns';
  const lines = [`**Adversarial review** (${model}${effort ? ` ${effort}` : ''}): ${badge}`];
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
    findings: findings.map((f) => ({ severity: f.severity, summary: f.summary, detail: f.detail ?? null })),
    model,
  };
}
