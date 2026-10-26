import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  CUSTOM_PRESET_ID_RE,
  CUSTOM_PRESET_LABEL_MAX,
  CUSTOM_PRESET_MAX,
  CUSTOM_PRESET_MODEL_RE,
  GROUP_COLOR_COUNT,
  TASK_TEMPLATE_ID_RE,
  TASK_TEMPLATE_MAX,
  TASK_TEMPLATE_NAME_MAX,
  customPresetProblem,
  taskPresets,
  taskTemplateProblem,
  type AppSettings,
} from '@tm/shared';
import { saveSentryAuthToken, serverRoot } from '../config.ts';
import { LEGACY_TOKEN_KEY, sentryTokenStatus, syncSentryIssues } from '../sentry.ts';
import type { Storage } from '../storage/types.ts';

// Shape per entry here; the list-level rules (unique ids/names, no repeated
// model+effort+review) live in `customPresetProblem`, shared with the Config page.
const customPresetsSchema = z
  .array(
    z
      .object({
        id: z.string().regex(CUSTOM_PRESET_ID_RE),
        label: z.string().trim().min(1).max(CUSTOM_PRESET_LABEL_MAX),
        model: z.string().regex(CUSTOM_PRESET_MODEL_RE),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
        review: z.boolean().nullable(),
        color: z.number().int().min(1).max(GROUP_COLOR_COUNT),
      })
      .strict(),
  )
  .max(CUSTOM_PRESET_MAX)
  .superRefine((list, ctx) => {
    const problem = customPresetProblem(list);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

// Shape per entry; the list rules (unique ids/names, a preset that exists)
// are `taskTemplateProblem`, run in the PUT handler because a template's preset
// may be a custom one saved in the same body (docs/inbox.md § Templates).
const taskTemplatesSchema = z
  .array(
    z
      .object({
        id: z.string().regex(TASK_TEMPLATE_ID_RE),
        name: z.string().trim().min(1).max(TASK_TEMPLATE_NAME_MAX),
        title: z.string().max(200),
        description: z.string().max(8000),
        acceptance: z.string().max(4000),
        checks: z.array(z.string().trim().min(1).max(80)).max(30).nullable(),
        preset: z.string().min(1).max(40).nullable(),
      })
      .strict(),
  )
  .max(TASK_TEMPLATE_MAX);

const settingsSchema = z
  .object({
    'orchestrator.enabled': z.boolean(),
    'orchestrator.concurrency': z.number().int().min(1).max(10),
    'agent.model': z.string().min(1),
    'agent.effort': z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    'analysis.model': z.string().min(1),
    'orchestrator.model': z.string().min(1),
    'agent.allowEnqueue': z.boolean(),
    'agent.taskCreationCap': z.number().int().min(1).max(100),
    'agent.maxSpawnDepth': z.number().int().min(1).max(50),
    'board.groupColors': z.boolean(),
    'presets.custom': customPresetsSchema,
    'task.templates': taskTemplatesSchema,
    'review.enabled': z.boolean(),
    'review.model': z.string().min(1),
    'review.maxRounds': z.number().int().min(0).max(5),
    'checks.maxRounds': z.number().int().min(0).max(10),
    'feature.analysisMaxRounds': z.number().int().min(0).max(5),
    'anomaly.longRunMin': z.number().int().min(5),
    'anomaly.costUsd': z.number().min(0.5),
    // 0 = adaptive (the repo's 30-day p90, floor $10); a fixed line keeps the per-run floor.
    'anomaly.taskCostUsd': z.number().max(100_000).refine((v) => v === 0 || v >= 0.5, 'must be 0 (adaptive) or at least 0.5'),
    'anomaly.staleReviewHours': z.number().int().min(1),
    'inbox.staleDraftDays': z.number().int().min(1).max(365),
    // Budget fuses (docs/token-budget.md § Fuses): 0 — or null — is off.
    'budget.taskUsd': z.number().min(0).max(10_000).nullable().transform((v) => v ?? 0),
    'budget.dayUsd': z.number().min(0).max(100_000).nullable().transform((v) => v ?? 0),
    'budget.runMinutes': z.number().int().min(0).max(7 * 24 * 60).nullable().transform((v) => v ?? 0),
    'router.enabled': z.boolean(),
    'router.primaryModel': z.string().min(1),
    'router.fallbackModel': z.string().min(1),
    'router.usageThresholdPct': z.number().min(1).max(100),
    'router.budget5hTokens': z.number().int().min(10_000),
    'router.budgetWeekTokens': z.number().int().min(10_000),
    'router.budgetWeekFableTokens': z.number().int().min(10_000),
    // Chat (docs/chat.md). `telegram.activeChatId` is deliberately NOT here —
    // it is bot state, like the update offset and the digest keys.
    'chat.model': z.string().min(1),
    'chat.effort': z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    'chat.concurrency': z.number().int().min(1).max(5),
    'agent.permissionMode': z.enum(['acceptEdits', 'auto', 'bypassPermissions']),
    'agent.allowedTools': z.array(z.string()),
    'agent.resumeSessions': z.boolean(),
    // 0 = off (every resume is a plain `--resume`). Upper bound is the largest
    // context window the CLI offers, so a cap above it could only mean "never",
    // which 0 already says. No lower band is rejected: a deliberately tiny cap
    // ("always compact first") is a legitimate choice, and the number field in
    // the UI would have no way to express a hole in the range.
    'agent.resumeContextCap': z.number().int().min(0).max(1_000_000),
    // 0 = the CLI's default; otherwise the CLI's own accepted band.
    'agent.autoCompactWindow': z.union([z.literal(0), z.number().int().min(100_000).max(1_000_000)]),
    // 0 = shells never hold a task. Four hours is past any build or test run
    // worth waiting on; beyond it the knob could only mean "forever", which
    // is the dev-server trap the bound exists to prevent.
    'agent.shellWaitMinutes': z.number().int().min(0).max(240),
    'agent.autoWake': z.boolean(),
    // Up to an hour of slack past the reset. The window is 5h, so a longer
    // grace could outlive the capacity it waits for.
    'agent.autoWakeGraceSec': z.number().int().min(0).max(3_600),
    // 0 = keep finished terminals forever (bounded by MAX_LIVE_SESSIONS); a
    // week is the practical upper bound for a local tool.
    'pty.sessionTtlMinutes': z.number().int().min(0).max(10_080),
    'terminal.clickOutside': z.enum(['close', 'compact', 'nothing']),
    'pty.scrollbackBytes': z
      .number()
      .int()
      .min(64 * 1024)
      .max(16 * 1024 * 1024),
    'sentry.dsn': z.string(),
    'sentry.org': z.string(),
    'sentry.project': z.string(),
    'sentry.apiBase': z.string(),
    'sentry.repoId': z.string(),
    'sentry.categoryTag': z.string(),
  })
  .partial()
  .strict();

/**
 * The settings as /api/config may show them. The Sentry token moved to
 * data/config.json at boot (migrateSentryToken); this strip is the belt to
 * that: a row the migration could not delete must still never be served.
 */
async function publicSettings(storage: Storage): Promise<AppSettings> {
  const s = (await storage.getSettings()) as unknown as Record<string, unknown>;
  delete s[LEGACY_TOKEN_KEY];
  return s as unknown as AppSettings;
}

const tokenBody = z.object({ token: z.string().max(500) }).strict();

export function registerSettingsRoutes(app: FastifyInstance, storage: Storage) {
  app.get('/api/config', async () => publicSettings(storage));

  // Set / not set + last 4 — the value never leaves the server (SECURITY.md § Secrets).
  app.get('/api/sentry/token', async () => sentryTokenStatus());

  // Written only when the page sends a new value; '' clears. A browser's write
  // only (Origin), like a landing tier: a worker must not swap the token the
  // issue sync authenticates with.
  app.put('/api/sentry/token', async (req, reply) => {
    if (!req.headers.origin) return reply.code(403).send({ error: 'the Sentry token is set from the dashboard' });
    const { token } = tokenBody.parse(req.body);
    saveSentryAuthToken(token);
    await storage.appendEvent({ kind: 'config.changed', actor: 'human', data: { keys: [LEGACY_TOKEN_KEY], file: 'data/config.json' } });
    return sentryTokenStatus();
  });

  app.put('/api/config', async (req, reply) => {
    // Whole body validated before any write — no half-applied configs.
    const body = settingsSchema.parse(req.body);
    if (body['task.templates']) {
      const custom = body['presets.custom'] ?? (await storage.getSettings())['presets.custom'];
      const problem = taskTemplateProblem(body['task.templates'], taskPresets({ 'presets.custom': custom }));
      if (problem) return reply.code(400).send({ error: problem });
    }
    for (const [key, value] of Object.entries(body)) {
      await storage.setSetting(key as keyof AppSettings, value as never);
    }
    const keys = Object.keys(body);
    if (keys.length) {
      // keys only — never values
      await storage.appendEvent({ kind: 'config.changed', actor: 'human', data: { keys } });
    }
    return publicSettings(storage);
  });

  app.post('/api/sentry/sync', async (req, reply) => {
    try {
      return await syncSentryIssues(storage);
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // Handbook markdown, rendered by the SPA's Handbook page.
  app.get('/api/handbook', async (_req, reply) => {
    const p = path.resolve(serverRoot, '../docs/handbook.md');
    if (!fs.existsSync(p)) return reply.code(404).send({ error: 'handbook not found' });
    return { markdown: fs.readFileSync(p, 'utf8') };
  });
}
