import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { JOB_INSTRUCTIONS_MAX, JOB_TITLE_MAX, type Job, type JobRun } from '@tm/shared';
import { jobReportFile, type JobService } from '../jobs.ts';
import type { Orchestrator } from '../orchestrator.ts';
import type { Storage } from '../storage/types.ts';

// Scheduled jobs, the human side (docs/jobs.md § Human API). Every write acts
// as `human`, so it must come from the browser: browsers always send Origin on
// these methods, a worker's curl does not.

async function fromBrowser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.headers.origin) {
    await reply.code(403).send({ error: 'job edits come from the dashboard' });
  }
}

const repeat = z
  .object({
    every: z.string().min(1).max(20),
    until: z.string().max(40).nullish(),
    maxRuns: z.number().int().nullish(),
  })
  .strict();

const schedule = {
  runAt: z.string().max(40).nullish(),
  delay: z.string().max(20).nullish(),
  repeat: repeat.nullish(),
};

const createBody = z
  .object({
    title: z.string().min(1).max(JOB_TITLE_MAX * 2),
    instructions: z.string().min(1).max(JOB_INSTRUCTIONS_MAX),
    repoId: z.string().min(1),
    notes: z.string().max(4000).nullish(),
    model: z.string().max(60).nullish(),
    effort: z.string().max(20).nullish(),
    ...schedule,
  })
  .strict();

const patchBody = z
  .object({
    title: z.string().min(1).max(JOB_TITLE_MAX * 2).optional(),
    instructions: z.string().min(1).max(JOB_INSTRUCTIONS_MAX).optional(),
    repoId: z.string().min(1).optional(),
    model: z.string().max(60).nullable().optional(),
    effort: z.string().max(20).nullable().optional(),
    schedule: z.object(schedule).strict().nullish(),
  })
  .strict();

const ackBody = z.object({ runId: z.string().min(1).nullish() }).strict();
const toggleBody = z.object({ enabled: z.boolean() }).strict();

export function registerJobRoutes(app: FastifyInstance, storage: Storage, jobs: JobService, _orchestrator: Orchestrator) {
  /** a run's cost lives on its aux run row */
  const withCost = async (runs: JobRun[]): Promise<JobRun[]> =>
    Promise.all(runs.map(async (r) => ({ ...r, costUsd: r.runId ? (await storage.getRun(r.runId))?.stats?.costUsd ?? null : null })));

  const send = <T>(reply: FastifyReply, r: { ok: true; value: T } | { ok: false; code: number; error: string }) =>
    r.ok ? r.value : reply.code(r.code).send({ error: r.error });

  app.get('/api/jobs', async (req) => {
    const q = req.query as { repoId?: string; task?: string };
    return storage.listJobs({ repoId: q.repoId || undefined, createdByTask: q.task || undefined });
  });

  /** attention/error runs not acknowledged — the Inbox `job` kind */
  app.get('/api/job-runs/open', async () => storage.listOpenJobRuns());

  app.get('/api/jobs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = await storage.getJob(id);
    if (!job) return reply.code(404).send({ error: 'job not found' });
    return { job, runs: await withCost(await storage.listJobRuns(id)) };
  });

  app.get('/api/jobs/:id/runs/:runId/report', async (req, reply) => {
    const { id, runId } = req.params as { id: string; runId: string };
    const run = await storage.getJobRun(runId);
    if (!run || run.jobId !== id || !run.reportPath) return reply.code(404).send({ error: 'no report for this run' });
    const file = jobReportFile(run.reportPath);
    if (!file || !fs.existsSync(file)) return reply.code(404).send({ error: 'report file is gone' });
    return reply.type('text/markdown; charset=utf-8').send(fs.readFileSync(file, 'utf8'));
  });

  app.post('/api/jobs', { preHandler: fromBrowser }, async (req, reply) => {
    const b = createBody.parse(req.body ?? {});
    const r = await jobs.create(
      { ...b, context: b.notes ? { notes: b.notes } : null },
      { source: 'human', actor: 'human' },
    );
    if (r.ok) reply.code(201);
    return send<Job>(reply, r);
  });

  app.patch('/api/jobs/:id', { preHandler: fromBrowser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = patchBody.parse(req.body ?? {});
    return send(reply, await jobs.update(id, { ...b, schedule: b.schedule ?? undefined }, 'human'));
  });

  app.delete('/api/jobs/:id', { preHandler: fromBrowser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return send(reply, await jobs.remove(id, 'human'));
  });

  app.post('/api/jobs/:id/run', { preHandler: fromBrowser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await jobs.runNow(id, 'human');
    if (r.ok) reply.code(202);
    return send(reply, r);
  });
  app.post('/api/jobs/:id/pause', { preHandler: fromBrowser }, async (req, reply) =>
    send(reply, await jobs.pause((req.params as { id: string }).id, 'human')),
  );
  app.post('/api/jobs/:id/resume', { preHandler: fromBrowser }, async (req, reply) =>
    send(reply, await jobs.resume((req.params as { id: string }).id, 'human')),
  );
  app.post('/api/jobs/:id/cancel', { preHandler: fromBrowser }, async (req, reply) =>
    send(reply, await jobs.cancel((req.params as { id: string }).id, 'human')),
  );
  app.post('/api/jobs/:id/ack', { preHandler: fromBrowser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { runId } = ackBody.parse(req.body ?? {});
    return send(reply, await jobs.acknowledge(id, runId ?? null));
  });

  app.post('/api/jobs/toggle', { preHandler: fromBrowser }, async (req) => {
    const { enabled } = toggleBody.parse(req.body ?? {});
    await jobs.setEnabled(enabled, 'human');
    return { enabled, status: jobs.status() };
  });
}
