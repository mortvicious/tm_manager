import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Feature, FeaturePlan, FeatureReview, PlanReviewRound, Repo, RunStats } from '@tm/shared';
import { broadcast } from '../events.ts';
import type { Storage } from '../storage/types.ts';
import { trackHeadlessChild } from './analyze.ts';
import {
  PLAN_JSON_SCHEMA,
  PLAN_REVIEW_JSON_SCHEMA,
  buildPlanPrompt,
  buildPlanReviewPrompt,
  planReviewSchema,
  planSchema,
  toStoredPlan,
} from './feature-plan.ts';

// The Feature pipeline: one headless planning run decomposes the request into
// ordered phases, a SECOND independent headless run reviews that plan
// adversarially, and a blocker verdict feeds back into a bounded re-analysis —
// the work→review→work loop of orchestrator.ts, applied to planning instead of
// diffs. Both calls are read-only `claude -p` (analyze.ts idioms: dontAsk,
// write tools disallowed, --json-schema, envelope parsing, 64MiB buffer).

// Same env hygiene as PTY workers / analyze.ts: strip inherited session markers.
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE') env[k] = v;
  }
  return env;
}

interface HeadlessResult {
  envelope: any;
  err: Error | null;
  stdout: string;
}

function runHeadless(opts: {
  cwd: string;
  model: string;
  effort: string | null;
  prompt: string;
  jsonSchema: string;
  runId: string;
  timeoutMs: number;
  /** what this child is doing, for the restart guard's refusal message */
  label: string;
}): Promise<HeadlessResult> {
  const args = [
    '-p',
    '--model',
    opts.model,
    ...(opts.effort ? ['--effort', opts.effort] : []),
    '--permission-mode',
    'dontAsk',
    '--disallowedTools',
    'Edit',
    'Write',
    'NotebookEdit',
    '--output-format',
    'json',
    '--json-schema',
    opts.jsonSchema,
  ];
  return new Promise((resolve) => {
    const child = execFile(
      'claude',
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024, env: cleanEnv() },
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
    // EPIPE when claude exits before draining stdin would otherwise be an
    // unhandled 'error' event → process crash (analyze.ts review R1).
    child.stdin?.on('error', () => {});
    child.stdin?.write(opts.prompt);
    child.stdin?.end();
    // One run row, several child processes — the Kill button always points at
    // whichever one is currently burning.
    trackHeadlessChild(opts.runId, child, opts.label);
  });
}

/** Fable → Opus 5 xhigh fallback, mirroring review.ts (cached per process). */
let fableUnavailable = false;

async function runWithFallback(opts: {
  cwd: string;
  model: string;
  prompt: string;
  jsonSchema: string;
  runId: string;
  timeoutMs: number;
  label: string;
}): Promise<HeadlessResult & { model: string }> {
  let model = fableUnavailable && /fable/i.test(opts.model) ? 'claude-opus-5' : opts.model;
  let effort: string | null = model === 'claude-opus-5' && model !== opts.model ? 'xhigh' : null;
  let res = await runHeadless({ ...opts, model, effort });
  const modelUnavailable =
    (!res.envelope || res.envelope.is_error) &&
    /model|not.*available|unknown model|unavailable|not.*found|access/i.test(
      res.stdout + String(res.err?.message ?? ''),
    );
  if (modelUnavailable && model !== 'claude-opus-5') {
    fableUnavailable = true;
    model = 'claude-opus-5';
    effort = 'xhigh';
    res = await runHeadless({ ...opts, model, effort });
  }
  return { ...res, model };
}

function usageOf(envelope: any): RunStats {
  const u = envelope?.usage ?? {};
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    costUsd: envelope?.total_cost_usd ?? 0,
    contextPct: 0,
  };
}

function addStats(a: RunStats, b: RunStats): RunStats {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: Math.round((a.costUsd + b.costUsd) * 1000) / 1000,
    contextPct: 0,
  };
}

function envelopeError(res: HeadlessResult, what: string): string {
  if (!res.envelope) return `${what}: no JSON envelope (${(res.err?.message ?? 'unknown error').slice(0, 200)})`;
  if (res.envelope.is_error) return `${what}: ${String(res.envelope.result ?? 'error').slice(0, 300)}`;
  return `${what}: no structured output`;
}

export interface FeatureAnalyzeDeps {
  storage: Storage;
}

/** Total wall clock for the whole (possibly multi-round) pipeline. */
const PIPELINE_BUDGET_MS = 40 * 60_000;
const CALL_TIMEOUT_MS = 12 * 60_000;

/**
 * Fire-and-forget plan pipeline for a feature already transitioned to
 * `analyzing`. Ends with the feature in `proposed` (plan ready for the human)
 * or `failed` (error recorded). Never throws into the caller.
 */
export async function startFeatureAnalysis(
  deps: FeatureAnalyzeDeps,
  feature: Feature,
  repo: Repo,
  opts?: { note?: string | null },
): Promise<{ runId: string }> {
  const { storage } = deps;
  const settings = await storage.getSettings();
  const model = settings['analysis.model'];
  const maxRounds = Math.max(0, settings['feature.analysisMaxRounds']);
  const run = await storage.createRun({
    repoId: repo.id,
    mode: 'analyze',
    model,
    effort: settings['agent.effort'],
  });

  void (async () => {
    const startedAt = Date.now();
    let stats: RunStats = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      contextPct: 0,
    };
    const finishRun = async (exitCode: number, sessionId?: string | null) => {
      await storage
        .updateRun(run.id, {
          status: 'exited',
          exitCode,
          endedAt: new Date().toISOString(),
          sessionId: sessionId ?? null,
          stats,
        })
        .catch(() => {});
    };
    /** Stop conditions: a user Kill on the run row, or the feature leaving
     *  `analyzing` under us (cancelled / re-analyzed from another request). */
    const aborted = async () => {
      if ((await storage.getRun(run.id))?.status === 'killed') return true;
      const cur = await storage.getFeature(feature.id);
      return !cur || cur.status !== 'analyzing';
    };
    const fail = async (message: string) => {
      const failed = await storage.transitionFeature(feature.id, ['analyzing'], 'failed', 'analyze', {
        error: message.slice(0, 1000),
      });
      if (failed) broadcast({ type: 'feature.updated', feature: failed });
      await finishRun(1);
    };

    try {
      const openTasks = (await storage.listTasks({ repoId: repo.id }))
        .filter((t) => ['draft', 'queued', 'running', 'review', 'blocked', 'failed'].includes(t.status))
        .filter((t) => t.featureId !== feature.id)
        .slice(0, 60)
        .map((t) => ({ id: t.id, title: t.title, status: t.status }));

      let plan: FeaturePlan | null = null;
      let rounds: PlanReviewRound[] = feature.review?.rounds ?? [];
      let previous: {
        plan: FeaturePlan;
        findings: { severity: string; summary: string; detail: string | null }[];
      } | null = null;
      let sessionId: string | null = null;
      // round 0 is the first attempt; up to maxRounds RE-analyses follow it.
      for (let round = 0; round <= maxRounds; round++) {
        if (await aborted()) return void (await finishRun(1));
        if (Date.now() - startedAt > PIPELINE_BUDGET_MS) {
          if (plan) break; // keep the plan we have rather than throwing it away
          return void (await fail('analysis exceeded its time budget'));
        }

        const planRes = await runWithFallback({
          cwd: repo.path,
          model,
          prompt: buildPlanPrompt({
            repoName: repo.name,
            repoPath: repo.path,
            repoRole: repo.role,
            title: feature.title,
            request: feature.request,
            openTasks,
            note: opts?.note ?? null,
            previous,
          }),
          jsonSchema: PLAN_JSON_SCHEMA,
          runId: run.id,
          timeoutMs: CALL_TIMEOUT_MS,
          label: `feature planning: ${feature.title}`,
        });
        stats = addStats(stats, usageOf(planRes.envelope));
        sessionId = planRes.envelope?.session_id ?? sessionId;
        if (await aborted()) return void (await finishRun(1));
        if (!planRes.envelope || planRes.envelope.is_error || !planRes.envelope.structured_output) {
          if (plan) break; // a later round failed; the earlier plan still stands
          return void (await fail(envelopeError(planRes, 'plan analysis failed')));
        }
        const parsed = planSchema.safeParse(planRes.envelope.structured_output);
        if (!parsed.success) {
          if (plan) break;
          return void (await fail(`plan analysis returned invalid output: ${parsed.error.message.slice(0, 400)}`));
        }
        plan = toStoredPlan(parsed.data, () => randomUUID());

        // Persist the fresh plan immediately: a crash mid-review must not lose
        // a good plan, and the page shows progress round by round.
        const withPlan = await storage.updateFeature(
          feature.id,
          { analysis: plan, analysisRounds: round + 1, error: null },
          'analyze',
        );
        if (withPlan) broadcast({ type: 'feature.updated', feature: withPlan });

        // ---- adversarial pass over THIS plan ----
        const reviewRes = await runWithFallback({
          cwd: repo.path,
          model: settings['review.model'],
          prompt: buildPlanReviewPrompt({
            repoName: repo.name,
            title: feature.title,
            request: feature.request,
            plan,
          }),
          jsonSchema: PLAN_REVIEW_JSON_SCHEMA,
          runId: run.id,
          label: `plan review: ${feature.title}`,
          timeoutMs: CALL_TIMEOUT_MS,
        });
        stats = addStats(stats, usageOf(reviewRes.envelope));
        if (await aborted()) return void (await finishRun(1));

        let roundResult: PlanReviewRound;
        const reviewParsed =
          reviewRes.envelope && !reviewRes.envelope.is_error && reviewRes.envelope.structured_output
            ? planReviewSchema.safeParse(reviewRes.envelope.structured_output)
            : null;
        if (reviewParsed?.success) {
          roundResult = {
            round: round + 1,
            verdict: reviewParsed.data.verdict,
            findings: reviewParsed.data.findings.map((f) => ({
              severity: f.severity,
              summary: f.summary,
              detail: f.detail ?? null,
            })),
            model: reviewRes.model,
            at: new Date().toISOString(),
          };
        } else {
          // A review that could not run must never look like a clean verdict.
          roundResult = {
            round: round + 1,
            verdict: 'minor',
            findings: [
              {
                severity: 'minor',
                summary: 'The adversarial plan review could not run — this plan is UNREVIEWED.',
                detail: envelopeError(reviewRes, 'plan review'),
              },
            ],
            model: reviewRes.model,
            at: new Date().toISOString(),
          };
        }
        rounds = [...rounds, roundResult];
        const review: FeatureReview = { rounds };
        const withReview = await storage.updateFeature(feature.id, { review }, 'analyze');
        if (withReview) broadcast({ type: 'feature.updated', feature: withReview });

        await storage.appendEvent({
          kind: 'feature.analyzed',
          actor: 'analyze',
          runId: run.id,
          repoId: repo.id,
          data: {
            featureId: feature.id,
            round: round + 1,
            verdict: roundResult.verdict,
            findings: roundResult.findings.length,
            phases: plan.phases.length,
            tasks: plan.phases.reduce((n, p) => n + p.tasks.length, 0),
          },
        });

        if (roundResult.verdict !== 'blocker') break;
        if (round >= maxRounds) break; // bounded, mirroring review.maxRounds
        previous = { plan, findings: roundResult.findings };
      }

      if (!plan) return void (await fail('analysis produced no plan'));
      const proposed = await storage.transitionFeature(feature.id, ['analyzing'], 'proposed', 'analyze', {
        error: null,
      });
      if (proposed) broadcast({ type: 'feature.updated', feature: proposed });
      await finishRun(0, sessionId);
    } catch (err) {
      console.error('feature analysis failed:', err);
      await fail(`analysis crashed: ${(err as Error).message}`).catch(() => {});
    }
  })();

  return { runId: run.id };
}
