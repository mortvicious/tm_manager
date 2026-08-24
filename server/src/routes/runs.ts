import type { FastifyInstance } from 'fastify';
import type { Orchestrator } from '../orchestrator.ts';
import type { Storage } from '../storage/types.ts';

export function registerRunRoutes(app: FastifyInstance, storage: Storage, orchestrator: Orchestrator) {
  app.get('/api/runs', async (req) => {
    const q = req.query as { taskId?: string; status?: any; mode?: any };
    return storage.listRuns({ taskId: q.taskId, status: q.status, mode: q.mode });
  });

  app.get('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await storage.getRun(id);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    return run;
  });

  app.post('/api/runs/:id/kill', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await storage.getRun(id);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    if (run.status !== 'running') return reply.code(409).send({ error: 'run is not live' });
    const killed = await orchestrator.killRun(id);
    if (!killed) return reply.code(409).send({ error: 'session already gone' });
    return storage.getRun(id);
  });
}
