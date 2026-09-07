import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AppSettings } from '@tm/shared';
import { serverRoot } from '../config.ts';
import { syncSentryIssues } from '../sentry.ts';
import type { Storage } from '../storage/types.ts';

const settingsSchema = z
  .object({
    'orchestrator.enabled': z.boolean(),
    'orchestrator.concurrency': z.number().int().min(1).max(10),
    'orchestrator.autoComplete': z.boolean(),
    'agent.model': z.string().min(1),
    'agent.effort': z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    'analysis.model': z.string().min(1),
    'orchestrator.model': z.string().min(1),
    'agent.allowEnqueue': z.boolean(),
    'agent.taskCreationCap': z.number().int().min(1).max(100),
    'board.groupColors': z.boolean(),
    'review.enabled': z.boolean(),
    'review.model': z.string().min(1),
    'review.maxRounds': z.number().int().min(0).max(5),
    'feature.analysisMaxRounds': z.number().int().min(0).max(5),
    'anomaly.longRunMin': z.number().int().min(5),
    'anomaly.costUsd': z.number().min(0.5),
    'anomaly.staleReviewHours': z.number().int().min(1),
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
    'sentry.authToken': z.string(),
    'sentry.org': z.string(),
    'sentry.project': z.string(),
    'sentry.apiBase': z.string(),
    'sentry.repoId': z.string(),
    'sentry.categoryTag': z.string(),
  })
  .partial()
  .strict();

export function registerSettingsRoutes(app: FastifyInstance, storage: Storage) {
  app.get('/api/config', async () => storage.getSettings());

  app.put('/api/config', async (req) => {
    // Whole body validated before any write — no half-applied configs.
    const body = settingsSchema.parse(req.body);
    for (const [key, value] of Object.entries(body)) {
      await storage.setSetting(key as keyof AppSettings, value as never);
    }
    const keys = Object.keys(body);
    if (keys.length) {
      // keys only — never values (sentry.authToken must not enter the log)
      await storage.appendEvent({ kind: 'config.changed', actor: 'human', data: { keys } });
    }
    return storage.getSettings();
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
