import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  JOB_AGENT_PER_SESSION,
  JOB_INSTRUCTIONS_MAX,
  JOB_MIN_DELAY_MS,
  JOB_REPO_SCHEDULED_CAP,
  JOB_TITLE_MAX,
  type Job,
  type Run,
} from '@tm/shared';
import { filerContext, type JobService } from '../jobs.ts';
import type { Storage } from '../storage/types.ts';

// Scheduled jobs for worker agents (docs/jobs.md § Agent API):
//  - POST   /api/agent/jobs      — schedule a later check ("look at the error rates in 7 days")
//  - GET    /api/agent/jobs      — the caller's repo's jobs
//  - GET    /api/agent/jobs/:id
//  - DELETE /api/agent/jobs/:id  — only a job the caller's TASK created
// Same `/api/agent` prefix, so agent.ts's token hook covers them. Only a
// WORKER may schedule: a job run (an aux session) scheduling more jobs would
// be a loop nobody started.

const createBody = z
  .object({
    title: z.string().min(1).max(JOB_TITLE_MAX * 2),
    instructions: z.string().min(1).max(JOB_INSTRUCTIONS_MAX),
    repo: z.string().min(1).nullish(),
    runAt: z.string().max(40).nullish(),
    delay: z.string().max(20).nullish(),
    repeat: z
      .object({ every: z.string().min(1).max(20), until: z.string().max(40).nullish(), maxRuns: z.number().int().nullish() })
      .strict()
      .nullish(),
    // free notes for the run; the filer's id/title/brief/summary/commits are added by the server
    context: z.string().max(4000).nullish(),
  })
  .strict();

/** what an agent reads back — the instructions are its own, the context snapshot is not echoed */
function view(j: Job) {
  return {
    id: j.id,
    title: j.title,
    status: j.status,
    repoId: j.repoId,
    nextRunAt: j.nextRunAt,
    repeatEveryMs: j.repeatEveryMs,
    repeatUntil: j.repeatUntil,
    maxRuns: j.maxRuns,
    runsCount: j.runsCount,
    lastVerdict: j.lastVerdict,
    lastSummary: j.lastSummary,
    createdByTask: j.createdByTask,
  };
}

export function registerAgentJobRoutes(app: FastifyInstance, storage: Storage, jobs: JobService) {
  const authRun = async (req: FastifyRequest): Promise<Run | null> => {
    const token = String(req.headers['x-tm-token'] ?? '');
    if (!token) return null;
    const run = await storage.getRunByToken(token);
    return run && run.status === 'running' ? run : null;
  };

  app.post('/api/agent/jobs', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    if (run.mode !== 'worker' || !run.taskId) return reply.code(403).send({ error: 'only a worker task may schedule jobs' });
    const body = createBody.parse(req.body ?? {});
    const repos = await storage.listRepos();
    const want = body.repo?.trim();
    const repo = want ? repos.find((r) => r.id === want || r.name.toLowerCase() === want.toLowerCase()) : repos.find((r) => r.id === run.repoId);
    if (!repo) return reply.code(404).send({ error: want ? `no repo matches "${want}" — GET /api/agent/context lists repos` : 'your run has no repo' });
    // a job runs Bash in its repo's checkout: an agent schedules only in its OWN
    // repo (SECURITY.md § Scheduled jobs); another repo's check is a shared-space
    // request or a question to the human
    if (repo.id !== run.repoId) return reply.code(403).send({ error: 'an agent may schedule jobs only in its own repo — ask the human (or file a shared-space request) for a check in another repo' });
    const mine = await storage.listJobs({ createdByRun: run.id });
    if (mine.length >= JOB_AGENT_PER_SESSION) {
      return reply.code(403).send({ error: `job cap reached: ${JOB_AGENT_PER_SESSION} jobs per session` });
    }
    if ((await storage.countLiveJobs(repo.id)) >= JOB_REPO_SCHEDULED_CAP) {
      return reply.code(409).send({ error: `repo ${repo.name} already has ${JOB_REPO_SCHEDULED_CAP} live jobs — ask the human to prune /jobs` });
    }
    const context = await filerContext(storage, run.taskId, body.context ?? null);
    const r = await jobs.create(
      {
        title: body.title,
        instructions: body.instructions,
        repoId: repo.id,
        runAt: body.runAt,
        delay: body.delay,
        repeat: body.repeat ?? null,
        context,
      },
      { source: 'agent', actor: `agent:${run.id}`, runId: run.id, taskId: run.taskId, minDelayMs: JOB_MIN_DELAY_MS },
    );
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    reply.code(201);
    return {
      job: view(r.value),
      note: `scheduled — fires at ${r.value.nextRunAt} or later, once fewer than the configured number of tasks are active. The human sees it on /jobs; its findings come back as a verdict and, if needed, follow-up drafts. Do not file a task for this check as well.`,
    };
  });

  app.get('/api/agent/jobs', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    if (!run.repoId) return [];
    return (await storage.listJobs({ repoId: run.repoId })).map(view);
  });

  app.get('/api/agent/jobs/:id', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    const job = await storage.getJob((req.params as { id: string }).id);
    if (!job || (job.repoId !== run.repoId && job.createdByTask !== run.taskId)) return reply.code(404).send({ error: 'job not found' });
    return view(job);
  });

  app.delete('/api/agent/jobs/:id', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    const job = await storage.getJob((req.params as { id: string }).id);
    if (!job) return reply.code(404).send({ error: 'job not found' });
    if (!run.taskId || job.createdByTask !== run.taskId) return reply.code(403).send({ error: 'only the task that scheduled a job may delete it' });
    if (job.status === 'running') return reply.code(409).send({ error: 'the job is running right now' });
    const r = await jobs.remove(job.id, `agent:${run.id}`);
    return r.ok ? { ok: true } : reply.code(r.code).send({ error: r.error });
  });
}
