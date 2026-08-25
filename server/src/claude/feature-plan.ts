import { z } from 'zod';
import type { Feature, FeaturePlan, FeaturePlanTask } from '@tm/shared';

// Pure plan layer for the Feature interface: the structured-output contract,
// the prompts, and the server-side text injection. No child_process here — the
// storage drivers import `buildFeatureTaskDescription` at approval time, and a
// runner module (feature-analysis.ts) owns the actual `claude -p` calls.

export const planTaskSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(20_000),
  category: z.string().min(1).max(60).nullish(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullish(),
  review: z.boolean().nullish(),
  exitCriteria: z.array(z.string().min(1).max(600)).max(12).nullish(),
});

export const planSchema = z.object({
  summary: z.string().min(1).max(8000),
  considerations: z.array(z.string().min(1).max(2000)).max(20),
  phases: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        goal: z.string().min(1).max(2000),
        tasks: z.array(planTaskSchema).min(1).max(12),
      }),
    )
    .min(1)
    .max(8),
});

export const planReviewSchema = z.object({
  verdict: z.enum(['clean', 'minor', 'blocker']),
  findings: z
    .array(
      z.object({
        severity: z.enum(['blocker', 'major', 'minor']),
        summary: z.string().min(1).max(2000),
        detail: z.string().max(4000).nullish(),
      }),
    )
    .max(30),
});

// Hand-written JSON Schemas for --json-schema (kept in sync with the zod shapes
// above — same discipline as analyze.ts).
export const PLAN_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    summary: { type: 'string' },
    considerations: { type: 'array', maxItems: 20, items: { type: 'string' } },
    phases: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          goal: { type: 'string' },
          tasks: {
            type: 'array',
            maxItems: 12,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                category: { type: ['string', 'null'] },
                effort: { type: ['string', 'null'], enum: ['low', 'medium', 'high', 'xhigh', 'max', null] },
                review: { type: ['boolean', 'null'] },
                exitCriteria: { type: ['array', 'null'], maxItems: 12, items: { type: 'string' } },
              },
              required: ['title', 'description', 'exitCriteria'],
            },
          },
        },
        required: ['title', 'goal', 'tasks'],
      },
    },
  },
  required: ['summary', 'considerations', 'phases'],
});

export const PLAN_REVIEW_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['clean', 'minor', 'blocker'] },
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

/**
 * Standing caps appended to EVERY generated task description at approval time.
 * Project rule (CLAUDE.md): never trust the plan to include them — the server
 * injects them. Kept as a marker-delimited block so re-approving or editing a
 * card can never stack two copies.
 */
export const CAPS_MARKER = '<!-- tm:standing-caps -->';

const CAPS_BLOCK = [
  CAPS_MARKER,
  '## Standing caps (server-injected)',
  '',
  '- Max 3 subagents in this session; avoid parallel agent fan-outs.',
  '- Orchestrator concurrency stays at 2 — do not raise it.',
  '- Documenting the work in `docs/` is an exit criterion of this task, not an optional extra.',
].join('\n');

/** Strips any previously injected caps block (idempotent re-injection). */
export function stripStandingCaps(description: string): string {
  const i = description.indexOf(CAPS_MARKER);
  return (i === -1 ? description : description.slice(0, i)).trimEnd();
}

/**
 * The worker-facing description of one planned card: the plan's body, its exit
 * criteria, then the standing caps. Idempotent — safe to call on a description
 * that already carries a caps block.
 */
export function buildFeatureTaskDescription(
  t: Pick<FeaturePlanTask, 'description' | 'exitCriteria'>,
  ctx: { featureTitle: string; phaseTitle: string; phaseIndex: number; phaseCount: number },
): string {
  const criteria = (t.exitCriteria ?? []).map((c) => String(c).trim()).filter(Boolean);
  return [
    `_Feature: **${ctx.featureTitle}** — phase ${ctx.phaseIndex + 1}/${ctx.phaseCount}: ${ctx.phaseTitle}_`,
    '',
    stripStandingCaps(t.description ?? ''),
    criteria.length ? `\n## Exit criteria\n${criteria.map((c) => `- ${c}`).join('\n')}` : '',
    '',
    CAPS_BLOCK,
  ]
    .join('\n')
    .trim();
}

/** Normalizes a validated model plan into the stored shape (stable card ids). */
export function toStoredPlan(raw: z.infer<typeof planSchema>, idFor: (phase: number, index: number) => string): FeaturePlan {
  return {
    summary: raw.summary,
    considerations: raw.considerations,
    phases: raw.phases.map((p, pi) => ({
      title: p.title,
      goal: p.goal,
      tasks: p.tasks.map((t, ti) => ({
        id: idFor(pi, ti),
        title: t.title,
        description: t.description,
        category: t.category ?? null,
        effort: t.effort ?? null,
        review: t.review ?? null,
        exitCriteria: t.exitCriteria ?? [],
        excluded: false,
      })),
    })),
  };
}

export function buildPlanPrompt(opts: {
  repoName: string;
  repoPath: string;
  repoRole: string | null;
  title: string;
  request: string;
  openTasks: { id: string; title: string; status: string }[];
  /** user note appended on a manual re-analyze */
  note?: string | null;
  /** previous plan + blocking findings, for a bounded re-analysis round */
  previous?: { plan: FeaturePlan; findings: { severity: string; summary: string; detail: string | null }[] } | null;
}): string {
  const lines = [
    `You are the planning agent of a task manager. You decompose ONE big request into an ordered,`,
    `phased plan of concrete implementation tasks that other Claude Code worker agents will execute`,
    `one at a time in this repository.`,
    ``,
    `Repo: "${opts.repoName}" at ${opts.repoPath}${opts.repoRole ? ` (role: ${opts.repoRole})` : ''}.`,
    `Feature title: ${opts.title}`,
    ``,
    `--- the request ---`,
    opts.request,
    `--- end of request ---`,
    ``,
    `Existing open tasks in this repo (avoid duplicating them):`,
    opts.openTasks.length ? JSON.stringify(opts.openTasks, null, 2) : '(none)',
    ``,
    `Explore the repository READ-ONLY first — read CLAUDE.md, docs/, and the code the request touches.`,
    `Ground every phase and task in what actually exists; never invent files or subsystems.`,
    ``,
    `Produce:`,
    `- "summary": one paragraph restating the intent as you understand it.`,
    `- "considerations": risks, decisions you took, and alternatives you rejected (short bullets).`,
    `- "phases": 2-6 ORDERED phases. A phase may only depend on earlier phases: every task in phase N`,
    `  must be implementable when all of phases 0..N-1 are finished and nothing else. Put work that`,
    `  can proceed independently in the SAME phase.`,
    `- Each phase has 1-6 tasks. A task is one worker session's worth of work: a single coherent`,
    `  change, with a full worker-grade "description" (what to change, where, how to verify) and`,
    `  "exitCriteria" (concrete, checkable statements). Not a vague theme, not a whole subsystem.`,
    `- Optional per-task "category" (a short domain label, reusing labels the repo already uses),`,
    `  "effort" (low|medium|high|xhigh|max) and "review" (false only for genuinely trivial tasks).`,
    ``,
    `Rules: do NOT write any files — this is analysis only. Do not spawn more than 3 subagents.`,
    `Do not include boilerplate about subagent caps or docs updates in the descriptions; the server`,
    `appends those. Return via the structured output schema.`,
  ];
  if (opts.note) {
    lines.push(``, `Additional instruction from the user for this round:`, opts.note);
  }
  if (opts.previous) {
    lines.push(
      ``,
      `This is a RE-ANALYSIS. Your previous plan was reviewed adversarially and BLOCKED. Previous plan:`,
      JSON.stringify(
        {
          summary: opts.previous.plan.summary,
          phases: opts.previous.plan.phases.map((p) => ({
            title: p.title,
            goal: p.goal,
            tasks: p.tasks.map((t) => t.title),
          })),
        },
        null,
        2,
      ),
      ``,
      `Findings you must resolve (produce a full new plan, not a diff):`,
      ...opts.previous.findings.map((f) => `- [${f.severity}] ${f.summary}${f.detail ? ` — ${f.detail}` : ''}`),
    );
  }
  return lines.join('\n');
}

export function buildPlanReviewPrompt(opts: {
  repoName: string;
  title: string;
  request: string;
  plan: FeaturePlan;
}): string {
  return [
    `You are an adversarial PLAN reviewer. A planning agent decomposed the user request below into a`,
    `phased task plan for the repo "${opts.repoName}". Review the PLAN, not any code change.`,
    ``,
    `--- the request ---`,
    opts.title,
    ``,
    opts.request,
    `--- end of request ---`,
    ``,
    `--- the proposed plan ---`,
    JSON.stringify(opts.plan, null, 2),
    `--- end of plan ---`,
    ``,
    `Read the repository (CLAUDE.md, docs/, the relevant code) as needed and hunt for real problems:`,
    `- missing steps: something the request needs that no task covers`,
    `- wrong ordering: a task in phase N that cannot run until work in a LATER phase exists`,
    `- tasks that are too big for one worker session, or too vague to act on`,
    `- tasks that contradict the repo's own rules (CLAUDE.md, docs/decisions.md) or existing design`,
    `- invented files, subsystems or APIs that do not exist in this repo`,
    `- duplicated work already covered by an existing open task`,
    ``,
    `Verdict: "blocker" if the plan cannot be approved as-is (ordering broken, a required step absent),`,
    `"minor" if it is workable with nits, "clean" if it is genuinely good. Do NOT rubber-stamp, and do`,
    `not invent problems to look thorough. Do not write any files. Do not spawn more than 3 subagents.`,
    `Return findings via the structured schema, most severe first.`,
  ].join('\n');
}

/**
 * The cards a feature would materialise on approval: every non-excluded task,
 * in phase order, with its worker-facing description already built (standing
 * caps injected). Used by BOTH storage drivers so approval is identical on
 * SQLite and Postgres.
 */
export function planCards(feature: Feature): { phase: number; card: FeaturePlanTask; description: string }[] {
  const plan = feature.analysis;
  if (!plan) return [];
  const out: { phase: number; card: FeaturePlanTask; description: string }[] = [];
  plan.phases.forEach((p, pi) => {
    for (const card of p.tasks) {
      if (card.excluded) continue;
      if (!card.title?.trim()) continue;
      out.push({
        phase: pi,
        card,
        description: buildFeatureTaskDescription(card, {
          featureTitle: feature.title,
          phaseTitle: p.title,
          phaseIndex: pi,
          phaseCount: plan.phases.length,
        }),
      });
    }
  });
  return out;
}
