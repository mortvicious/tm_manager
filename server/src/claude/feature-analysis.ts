import { createHash, randomUUID } from 'node:crypto';
import type { Feature, FeaturePlan, FeatureReview, PlanFinding, PlanReviewRound, Repo, RunStats } from '@tm/shared';
import { broadcast } from '../events.ts';
import type { Storage } from '../storage/types.ts';
import { READ_ONLY_TOOLS, acceptJson, aux, resultInstruction, withModelFallback, type AuxOutcome } from './aux.ts';
import {
  PLAN_FIX_JSON_SCHEMA,
  PLAN_FIX_REVIEW_JSON_SCHEMA,
  buildPlanFixPrompt,
  buildPlanFixReviewPrompt,
  mergePlanFixRound,
  planFixAcceptor,
  planFixReviewSchema,
} from './plan-fix.ts';
import {
  PLAN_JSON_SCHEMA,
  PLAN_REVIEW_JSON_SCHEMA,
  buildPlanPrompt,
  buildPlanReviewPrompt,
  planReviewSchema,
  planSchema,
  toStoredPlan,
} from './feature-plan.ts';

// The Feature pipeline: one planning session decomposes the request into
// ordered phases, a SECOND independent session reviews that plan
// adversarially, and a blocker verdict feeds back into a bounded re-analysis —
// the work→review→work loop of orchestrator.ts, applied to planning instead of
// diffs. Each call is its own read-only aux TERMINAL (kinds `plan` and
// `plan-review`, subject = the feature — docs/design.md § PTY sessions),
// attachable from the runs list; the result is the fenced JSON block at the
// end of its final message, validated by the same zod schemas.
//
// Tool policy is the one the `-p` calls had, unchanged: `dontAsk`, and
// Edit/Write/NotebookEdit denied. Bash was never in this role's denial list
// (unlike analysis/review), so under `dontAsk` it runs only what the repo's
// own allow rules permit — kept as is rather than silently changed.
const PLAN_DISALLOWED = ['Edit', 'Write', 'NotebookEdit'];
const PLAN_TOOLS = [...READ_ONLY_TOOLS, 'Bash'];

/** Fable → Opus 5.5 xhigh on `model_not_found` only — the shared `withModelFallback`. */
async function runWithFallback<T>(opts: {
  kind: 'plan' | 'plan-review';
  feature: Feature;
  repo: Repo;
  model: string;
  prompt: string;
  jsonSchema: object | string;
  schema: Parameters<typeof acceptJson<T>>[0];
  timeoutMs: number;
  label: string;
  signal: AbortSignal;
}): Promise<AuxOutcome<T> & { model: string }> {
  const once = (model: string, effort: string | null) =>
    aux().run<T>({
      kind: opts.kind,
      subjectId: opts.feature.id,
      repoId: opts.repo.id,
      label: opts.label,
      cwd: opts.repo.path,
      model,
      effort,
      prompt: opts.prompt + '\n' + resultInstruction(opts.jsonSchema),
      tools: PLAN_TOOLS,
      disallowedTools: PLAN_DISALLOWED,
      permission: 'dontAsk',
      lean: true,
      timeoutMs: opts.timeoutMs,
      accept: acceptJson<T>(opts.schema),
      signal: opts.signal,
    });
  const { res, model } = await withModelFallback({ model: opts.model, effort: null }, 'xhigh', once);
  return { ...res, model };
}

function addStats(a: RunStats, b: RunStats | null): RunStats {
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: Math.round((a.costUsd + b.costUsd) * 1000) / 1000,
    contextPct: 0,
    contextTokens: 0,
  };
}

function outcomeError(res: AuxOutcome<unknown>, what: string): string {
  return `${what}: ${(res.error ?? 'no result').slice(0, 300)}`;
}

export interface FeatureAnalyzeDeps {
  storage: Storage;
}

/**
 * A plan review round calls for a re-plan when its verdict is `blocker` OR any
 * finding is blocker/major — the verdict scale (clean|minor|blocker) does not
 * line up with the severities, and a reviewer returned `minor` over four majors
 * (feature 0e323bef round 2), which ended the loop with them unfixed. Same rule
 * as the diff review: blocker/major go back to the planner, minors do not.
 */
export function needsReplan(round: PlanReviewRound): boolean {
  return round.verdict === 'blocker' || round.findings.some((f) => f.severity === 'blocker' || f.severity === 'major');
}

/** The findings a re-plan must resolve: blocker/major only (all of them when the verdict alone blocked). */
export function mustFix(round: PlanReviewRound): PlanReviewRound['findings'] {
  const serious = round.findings.filter((f) => f.severity === 'blocker' || f.severity === 'major');
  return serious.length ? serious : round.findings;
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
  opts?: { note?: string | null; fresh?: boolean },
): Promise<void> {
  const { storage } = deps;
  const settings = await storage.getSettings();
  const model = settings['analysis.model'];
  const maxRounds = Math.max(0, settings['feature.analysisMaxRounds']);

  void (async () => {
    const startedAt = Date.now();
    let stats: RunStats = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      contextPct: 0,
      contextTokens: 0,
    };
    // Every session of the pipeline gets this signal. The feature leaving
    // `analyzing` under us (cancelled, re-analyzed from another request) ends
    // the one in flight instead of paying for a plan nobody will read.
    const ctl = new AbortController();
    const watch = setInterval(() => {
      void storage.getFeature(feature.id).then((cur) => {
        if (!cur || cur.status !== 'analyzing') ctl.abort();
      });
    }, 5_000);
    const aborted = async () => {
      if (ctl.signal.aborted) return true;
      const cur = await storage.getFeature(feature.id);
      return !cur || cur.status !== 'analyzing';
    };
    const fail = async (message: string) => {
      const failed = await storage.transitionFeature(feature.id, ['analyzing'], 'failed', 'analyze', {
        error: message.slice(0, 1000),
      });
      if (failed) broadcast({ type: 'feature.updated', feature: failed });
    };
    /** A Kill on one of the pipeline's terminals is a stop of the whole analysis. */
    const stoppedByKill = async (res: AuxOutcome<unknown>) => {
      if (res.status !== 'aborted' || ctl.signal.aborted) return false;
      await fail('analysis stopped (a planning terminal was killed)');
      return true;
    };

    try {
      const openTasks = (await storage.listTasks({ repoId: repo.id }))
        .filter((t) => ['draft', 'queued', 'running', 'waiting', 'review', 'blocked', 'failed'].includes(t.status))
        .filter((t) => t.featureId !== feature.id)
        .slice(0, 60)
        .map((t) => ({ id: t.id, title: t.title, status: t.status }));

      let plan: FeaturePlan | null = null;
      let rounds: PlanReviewRound[] = feature.review?.rounds ?? [];
      // A Re-analyze over a plan whose LAST review blocked it is the next round
      // of that loop, not a fresh start: the blocked plan and its findings go
      // into the first prompt, exactly as an automatic re-analysis round would.
      const lastRound = rounds.at(-1);
      const requestHash = createHash('sha256').update(feature.request).digest('hex').slice(0, 16);
      // Set = the next round is a FIX round over this plan for these findings.
      let previous: { plan: FeaturePlan; findings: PlanFinding[] } | null =
        !opts?.fresh &&
        feature.analysis &&
        lastRound &&
        needsReplan(lastRound) &&
        // the request was rewritten since that round: its findings are about another request — plan anew
        (lastRound.requestHash === undefined || lastRound.requestHash === requestHash)
          ? { plan: feature.analysis, findings: mustFix(lastRound) }
          : null;
      // Review rounds are numbered across Re-analyze runs (the list is appended to).
      const roundBase = rounds.length;
      // Set when a LATER round fails and the earlier plan is proposed instead:
      // the page must say so rather than show a blocked plan as the outcome.
      let laterRoundError: string | null = null;
      // round 0 is the first attempt; up to maxRounds RE-analyses follow it.
      for (let round = 0; round <= maxRounds; round++) {
        if (await aborted()) return;
        if (Date.now() - startedAt > PIPELINE_BUDGET_MS) {
          if (plan) {
            // keep the plan we have rather than throwing it away
            laterRoundError = `re-analysis stopped: the pipeline exceeded its time budget`;
            break;
          }
          return void (await fail('analysis exceeded its time budget'));
        }

        let roundResult: PlanReviewRound;
        let reviewRunId: string | null = null;
        let planRunId: string | null = null;
        if (previous) {
          // ---- FIX round: edit the plan for the numbered findings, review those + the edits ----
          const base = previous.plan;
          const handedOver = previous.findings;
          const fixRes = await runWithFallback({
            kind: 'plan',
            feature,
            repo,
            model,
            prompt: buildPlanFixPrompt({
              repoName: repo.name,
              repoPath: repo.path,
              title: feature.title,
              request: feature.request,
              plan: base,
              findings: handedOver,
              note: round === 0 ? (opts?.note ?? null) : null,
            }),
            jsonSchema: PLAN_FIX_JSON_SCHEMA,
            schema: planFixAcceptor(base, () => randomUUID()),
            timeoutMs: CALL_TIMEOUT_MS,
            label: `plan fix: ${feature.title}`,
            signal: ctl.signal,
          });
          stats = addStats(stats, fixRes.stats);
          planRunId = fixRes.runId || null;
          if (await stoppedByKill(fixRes)) return;
          if (await aborted()) return;
          if (fixRes.status !== 'ok' || !fixRes.value) {
            plan = plan ?? base;
            laterRoundError = `plan fix round ${rounds.length + 1} failed: ${outcomeError(fixRes, 'plan fix failed')}`;
            break;
          }
          const { fix, applied } = fixRes.value;
          plan = applied.plan;
          const withPlan = await storage.updateFeature(
            feature.id,
            { analysis: plan, analysisRounds: round + 1, error: null },
            'analyze',
          );
          if (withPlan) broadcast({ type: 'feature.updated', feature: withPlan });

          const reviewRes = await runWithFallback({
            kind: 'plan-review',
            feature,
            repo,
            model: settings['review.model'],
            prompt: buildPlanFixReviewPrompt({
              repoName: repo.name,
              title: feature.title,
              request: feature.request,
              plan,
              findings: handedOver,
              notes: fix.notes,
              log: applied.log,
              changed: applied.changed,
              labels: applied.labels,
            }),
            jsonSchema: PLAN_FIX_REVIEW_JSON_SCHEMA,
            schema: planFixReviewSchema,
            label: `plan fix review: ${feature.title}`,
            timeoutMs: CALL_TIMEOUT_MS,
            signal: ctl.signal,
          });
          stats = addStats(stats, reviewRes.stats);
          reviewRunId = reviewRes.runId || null;
          if (await stoppedByKill(reviewRes)) return;
          if (await aborted()) return;
          const meta = { round: roundBase + round + 1, model: reviewRes.model, at: new Date().toISOString(), edits: applied.log };
          roundResult =
            reviewRes.status === 'ok' && reviewRes.value
              ? mergePlanFixRound(handedOver, reviewRes.value, meta)
              : {
                  // An unreviewed fix resolves nothing: the handed-over findings stay open.
                  ...meta,
                  mode: 'fix',
                  verdict: handedOver.some((f) => f.severity === 'blocker') ? 'blocker' : 'minor',
                  findings: [
                    ...handedOver,
                    {
                      severity: 'minor',
                      summary: 'The fix-round review could not run — these edits are UNREVIEWED.',
                      detail: outcomeError(reviewRes, 'plan review'),
                    },
                  ],
                };
        } else {
          // ---- FULL round: write the whole plan, review the whole plan ----
          const planRes = await runWithFallback({
            kind: 'plan',
            feature,
            repo,
            model,
            prompt: buildPlanPrompt({
              repoName: repo.name,
              repoPath: repo.path,
              repoRole: repo.role,
              title: feature.title,
              request: feature.request,
              openTasks,
              note: opts?.note ?? null,
            }),
            jsonSchema: PLAN_JSON_SCHEMA,
            schema: planSchema,
            timeoutMs: CALL_TIMEOUT_MS,
            label: `plan: ${feature.title}`,
            signal: ctl.signal,
          });
          stats = addStats(stats, planRes.stats);
          planRunId = planRes.runId || null;
          if (await stoppedByKill(planRes)) return;
          if (await aborted()) return;
          if (planRes.status !== 'ok' || !planRes.value) {
            if (plan) {
              // a later round failed; the earlier plan still stands — but say so
              laterRoundError = `re-analysis round ${rounds.length + 1} failed: ${outcomeError(planRes, 'plan analysis failed')}`;
              break;
            }
            return void (await fail(outcomeError(planRes, 'plan analysis failed')));
          }
          plan = toStoredPlan(planRes.value, () => randomUUID());

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
            kind: 'plan-review',
            feature,
            repo,
            model: settings['review.model'],
            prompt: buildPlanReviewPrompt({
              repoName: repo.name,
              title: feature.title,
              request: feature.request,
              plan,
            }),
            jsonSchema: PLAN_REVIEW_JSON_SCHEMA,
            schema: planReviewSchema,
            label: `plan review: ${feature.title}`,
            timeoutMs: CALL_TIMEOUT_MS,
            signal: ctl.signal,
          });
          stats = addStats(stats, reviewRes.stats);
          reviewRunId = reviewRes.runId || null;
          if (await stoppedByKill(reviewRes)) return;
          if (await aborted()) return;

          const reviewParsed = reviewRes.status === 'ok' && reviewRes.value ? { data: reviewRes.value } : null;
          if (reviewParsed) {
            roundResult = {
              round: roundBase + round + 1,
              verdict: reviewParsed.data.verdict,
              findings: reviewParsed.data.findings.map((f) => ({
                severity: f.severity,
                summary: f.summary,
                detail: f.detail ?? null,
              })),
              model: reviewRes.model,
              at: new Date().toISOString(),
              mode: 'full',
            };
          } else {
            // A review that could not run must never look like a clean verdict.
            roundResult = {
              round: roundBase + round + 1,
              verdict: 'minor',
              findings: [
                {
                  severity: 'minor',
                  summary: 'The adversarial plan review could not run — this plan is UNREVIEWED.',
                  detail: outcomeError(reviewRes, 'plan review'),
                },
              ],
              model: reviewRes.model,
              at: new Date().toISOString(),
              mode: 'full',
            };
          }
        }
        roundResult = { ...roundResult, requestHash };
        rounds = [...rounds, roundResult];
        const review: FeatureReview = { rounds };
        const withReview = await storage.updateFeature(feature.id, { review }, 'analyze');
        if (withReview) broadcast({ type: 'feature.updated', feature: withReview });

        await storage.appendEvent({
          kind: 'feature.analyzed',
          actor: 'analyze',
          runId: reviewRunId || planRunId,
          repoId: repo.id,
          data: {
            featureId: feature.id,
            costUsd: stats.costUsd,
            round: roundBase + round + 1,
            verdict: roundResult.verdict,
            findings: roundResult.findings.length,
            mode: roundResult.mode,
            ...(roundResult.resolutions
              ? { resolved: roundResult.resolutions.filter((r) => r.status === 'resolved').length, handedOver: roundResult.resolutions.length }
              : {}),
            phases: plan.phases.length,
            tasks: plan.phases.reduce((n, p) => n + p.tasks.length, 0),
          },
        });

        if (!needsReplan(roundResult)) break;
        if (round >= maxRounds) break; // bounded, mirroring review.maxRounds
        previous = { plan, findings: mustFix(roundResult) };
      }

      if (!plan) return void (await fail('analysis produced no plan'));
      const last = rounds.at(-1);
      const proposed = await storage.transitionFeature(feature.id, ['analyzing'], 'proposed', 'analyze', {
        error: laterRoundError
          ? `${laterRoundError} — showing the previous plan${last && needsReplan(last) ? ', which its review left with blocker/major findings' : ''}. Re-analyze to continue from that review.`.slice(0, 1000)
          : null,
      });
      if (proposed) broadcast({ type: 'feature.updated', feature: proposed });
    } catch (err) {
      console.error('feature analysis failed:', err);
      await fail(`analysis crashed: ${(err as Error).message}`).catch(() => {});
    } finally {
      clearInterval(watch);
    }
  })();
}
