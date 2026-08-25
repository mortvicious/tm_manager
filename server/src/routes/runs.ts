import type { FastifyInstance } from 'fastify';
import type { ActivityWatcher } from '../claude/activity.ts';
import type { Orchestrator } from '../orchestrator.ts';
import type { Storage } from '../storage/types.ts';

export function registerRunRoutes(
  app: FastifyInstance,
  storage: Storage,
  orchestrator: Orchestrator,
  activity: ActivityWatcher,
) {
  app.get('/api/runs', async (req) => {
    const q = req.query as { taskId?: string; status?: any; mode?: any };
    return storage.listRuns({ taskId: q.taskId, status: q.status, mode: q.mode });
  });

  // Current activity line per live run. Live updates arrive over /ws/events;
  // this is the snapshot a fresh page (or a reconnect) starts from, so the
  // Board is never blank until the next tool call happens to fire.
  // A static segment always beats /api/runs/:id in fastify's router, so this
  // can never be swallowed as a run id.
  app.get('/api/runs/activity', async () => activity.snapshot());

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
