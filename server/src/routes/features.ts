import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Feature, FeatureStatus } from '@tm/shared';
import { startFeatureAnalysis } from '../claude/feature-analysis.ts';
import { broadcast } from '../events.ts';
import type { Storage } from '../storage/types.ts';

// Feature interface (docs/features.md): a big request → headless analysis →
// adversarial plan review → visually approved tasks. Status is machine-owned
// here exactly as it is for tasks: it moves only through the action endpoints,
// never through a generic PATCH (.strict() bodies give a loud 400 instead of a
// silent strip).

const createBody = z
  .object({
    repoId: z.string().min(1),
    title: z.string().min(1).max(300),
    request: z.string().min(1).max(200_000),
  })
  .strict();

const patchBody = z
  .object({
    title: z.string().min(1).max(300),
    request: z.string().min(1).max(200_000),
  })
  .partial()
  .strict();

// The stored (user-editable) plan shape — the analysis schema plus the card id
// and the exclude toggle the approval surface adds.
const planCardSchema = z
  .object({
    id: z.string().min(1).max(64),
    title: z.string().min(1).max(300),
    description: z.string().max(20_000),
    category: z.string().max(60).nullish(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullish(),
    review: z.boolean().nullish(),
    exitCriteria: z.array(z.string().max(600)).max(12),
    excluded: z.boolean().optional(),
  })
  .strict();

const planBody = z
  .object({
    analysis: z
      .object({
        summary: z.string().max(8000),
        considerations: z.array(z.string().max(2000)).max(20),
        phases: z
          .array(
            z
              .object({
                title: z.string().min(1).max(200),
                goal: z.string().max(2000),
                tasks: z.array(planCardSchema).max(20),
              })
              .strict(),
          )
          .max(10),
      })
      .strict(),
  })
  .strict();

const analyzeBody = z.object({ note: z.string().max(8000).nullish() }).strict();

/** Statuses a plain content edit / (re-)analysis may start from. */
const EDITABLE: FeatureStatus[] = ['draft', 'proposed', 'failed'];

export function registerFeatureRoutes(app: FastifyInstance, storage: Storage) {
  const push = (feature: Feature) => broadcast({ type: 'feature.updated', feature });

  app.get('/api/features', async (req) => {
    const q = req.query as { repoId?: string; status?: FeatureStatus };
    return storage.listFeatures({ repoId: q.repoId, status: q.status });
  });

  app.get('/api/features/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const feature = await storage.getFeature(id);
    if (!feature) return reply.code(404).send({ error: 'feature not found' });
    const tasks = await storage.listTasks({ featureId: id });
    return { feature, tasks };
  });

  app.post('/api/features', async (req, reply) => {
    const body = createBody.parse(req.body);
    const repo = await storage.getRepo(body.repoId);
    if (!repo) return reply.code(404).send({ error: 'repo not found' });
    const feature = await storage.createFeature(body, 'human');
    push(feature);
    return feature;
  });

  app.patch('/api/features/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = patchBody.parse(req.body);
    const cur = await storage.getFeature(id);
    if (!cur) return reply.code(404).send({ error: 'feature not found' });
    if (!EDITABLE.includes(cur.status)) {
      return reply.code(409).send({ error: `cannot edit the request of a '${cur.status}' feature` });
    }
    const feature = await storage.updateFeature(id, body, 'human');
    if (!feature) return reply.code(404).send({ error: 'feature not found' });
    push(feature);
    return feature;
  });

  // Pre-approval card edits: retitle/rewrite/exclude/reorder/move between
  // phases. Nothing exists as a task row yet, so this is a plain JSON write.
  app.patch('/api/features/:id/plan', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = planBody.parse(req.body);
    const cur = await storage.getFeature(id);
    if (!cur) return reply.code(404).send({ error: 'feature not found' });
    if (cur.status !== 'proposed') {
      return reply.code(409).send({ error: `the plan is only editable while the feature is 'proposed' (it is '${cur.status}')` });
    }
    const ids = body.analysis.phases.flatMap((p) => p.tasks.map((t) => t.id));
    if (new Set(ids).size !== ids.length) return reply.code(400).send({ error: 'duplicate card ids in the plan' });
    const feature = await storage.updateFeature(
      id,
      {
        analysis: {
          ...body.analysis,
          phases: body.analysis.phases.map((p) => ({
            ...p,
            tasks: p.tasks.map((t) => ({
              ...t,
              category: t.category ?? null,
              effort: t.effort ?? null,
              review: t.review ?? null,
            })),
          })),
        },
      },
      'human',
    );
    if (!feature) return reply.code(404).send({ error: 'feature not found' });
    push(feature);
    return feature;
  });

  app.delete('/api/features/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const cur = await storage.getFeature(id);
    if (!cur) return reply.code(404).send({ error: 'feature not found' });
    const ok = await storage.deleteFeature(id);
    if (!ok) {
      return reply
        .code(409)
        .send({ error: 'this feature already owns tasks — cancel it (and delete its tasks) before deleting it' });
    }
    await storage.appendEvent({
      kind: 'feature.edited',
      actor: 'human',
      repoId: cur.repoId,
      data: { featureId: id, deleted: true, title: cur.title },
    });
    broadcast({ type: 'feature.deleted', featureId: id });
    return { ok: true };
  });

  app.post('/api/features/:id/analyze', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = analyzeBody.parse(req.body ?? {});
    const cur = await storage.getFeature(id);
    if (!cur) return reply.code(404).send({ error: 'feature not found' });
    if (!cur.repoId) return reply.code(409).send({ error: 'this feature has no repo (it was removed) — re-create it' });
    const repo = await storage.getRepo(cur.repoId);
    if (!repo) return reply.code(409).send({ error: 'repo not found' });
    if (!cur.request.trim()) return reply.code(409).send({ error: 'write the request first' });
    // The status transition IS the lock: a second click finds 'analyzing' and
    // gets a 409 instead of burning a second headless session.
    const feature = await storage.transitionFeature(id, EDITABLE, 'analyzing', 'human', { error: null });
    if (!feature) return reply.code(409).send({ error: `cannot analyze from status '${cur.status}'` });
    push(feature);
    try {
      const { runId } = await startFeatureAnalysis({ storage }, feature, repo, { note: body.note ?? null });
      return { runId, feature };
    } catch (e) {
      const reverted = await storage.transitionFeature(id, ['analyzing'], 'failed', 'system', {
        error: `could not start the analysis: ${(e as Error).message}`,
      });
      if (reverted) push(reverted);
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  app.post('/api/features/:id/approve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const cur = await storage.getFeature(id);
    if (!cur) return reply.code(404).send({ error: 'feature not found' });
    if (cur.status !== 'proposed') return reply.code(409).send({ error: `cannot approve from status '${cur.status}'` });
    if (!cur.repoId) return reply.code(409).send({ error: 'this feature has no repo (it was removed)' });
    const result = await storage.approveFeature(id, 'human');
    if (!result) {
      return reply.code(409).send({ error: 'nothing to approve — the plan has no included tasks' });
    }
    push(result.feature);
    for (const task of result.tasks) broadcast({ type: 'task.updated', task });
    return result;
  });

  /** approved → running: the first phase is enqueued by the feature resolver. */
  app.post('/api/features/:id/start', async (req, reply) => {
    const { id } = req.params as { id: string };
    const cur = await storage.getFeature(id);
    if (!cur) return reply.code(404).send({ error: 'feature not found' });
    const feature = await storage.transitionFeature(id, ['approved'], 'running', 'human', { error: null });
    if (!feature) return reply.code(409).send({ error: `cannot start from status '${cur.status}'` });
    push(feature);
    await app.orchestrator?.advanceFeature(id, 'human');
    return (await storage.getFeature(id)) ?? feature;
  });

  app.post('/api/features/:id/pause', async (req, reply) => {
    const { id } = req.params as { id: string };
    const cur = await storage.getFeature(id);
    if (!cur) return reply.code(404).send({ error: 'feature not found' });
    // Running tasks keep running (killing mid-edit is the dangerous move); the
    // claim gate simply stops handing out new ones while paused.
    const feature = await storage.transitionFeature(id, ['running'], 'paused', 'human');
    if (!feature) return reply.code(409).send({ error: `cannot pause from status '${cur.status}'` });
    push(feature);
    return feature;
  });

  app.post('/api/features/:id/resume', async (req, reply) => {
    const { id } = req.params as { id: string };
    const cur = await storage.getFeature(id);
    if (!cur) return reply.code(404).send({ error: 'feature not found' });
    const tasks = await storage.listTasks({ featureId: id });
    const failed = tasks.filter((t) => t.status === 'failed');
    if (failed.length > 0) {
      // Resuming with a failed task would re-pause instantly (the resolver
      // pauses on any failure) — say so instead of no-oping.
      return reply.code(409).send({
        error: `retry or cancel the ${failed.length} failed task(s) first: ${failed.map((t) => t.title).slice(0, 3).join('; ')}`,
      });
    }
    const feature = await storage.transitionFeature(id, ['paused'], 'running', 'human', { error: null });
    if (!feature) return reply.code(409).send({ error: `cannot resume from status '${cur.status}'` });
    push(feature);
    await app.orchestrator?.advanceFeature(id, 'human');
    return (await storage.getFeature(id)) ?? feature;
  });

  app.post('/api/features/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const cur = await storage.getFeature(id);
    if (!cur) return reply.code(404).send({ error: 'feature not found' });
    const result = await storage.cancelFeature(id, 'human');
    if (!result) return reply.code(409).send({ error: `cannot cancel from status '${cur.status}'` });
    push(result.feature);
    for (const task of result.tasks) broadcast({ type: 'task.updated', task });
    // Running tasks own live PTYs — only the orchestrator may kill those.
    for (const taskId of result.runningTaskIds) {
      await app.orchestrator?.cancel(taskId, 'human');
    }
    return result;
  });

  // review → done, the twin of the task complete route.
  app.post('/api/features/:id/complete', async (req, reply) => {
    const { id } = req.params as { id: string };
    const cur = await storage.getFeature(id);
    if (!cur) return reply.code(404).send({ error: 'feature not found' });
    const feature = await storage.transitionFeature(id, ['review'], 'done', 'human', { error: null });
    if (!feature) return reply.code(409).send({ error: `cannot complete from status '${cur.status}'` });
    push(feature);
    return feature;
  });
}
