import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Orchestrator } from '../orchestrator.ts';

/**
 * Agents' background shells (docs/terminals.md § Background shells): list,
 * watch the output file read-only, kill. A kill acts as `human` and can land
 * a task's `waiting` park, so it must come from the dashboard — a worker's
 * curl sends no Origin (the shells/questions rule).
 */
async function fromBrowser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.headers.origin) {
    await reply.code(403).send({ error: 'background shells are killed from the dashboard' });
  }
}

const killAllBody = z.object({ taskId: z.string().min(1).optional() }).strict();
const outputQuery = z.object({
  from: z.coerce.number().int().min(0).optional(),
});

export function registerBackgroundShellRoutes(app: FastifyInstance, orchestrator: Orchestrator) {
  const shells = orchestrator.backgroundShells;

  app.get('/api/background-shells', async () => shells.list());

  app.get('/api/background-shells/:runId/:shellId/output', async (req, reply) => {
    const { runId, shellId } = req.params as {
      runId: string;
      shellId: string;
    };
    const { from } = outputQuery.parse(req.query ?? {});
    const r = await shells.output(runId, shellId, from ?? null);
    if ('error' in r) return reply.code(r.code).send({ error: r.error });
    return r;
  });

  app.post('/api/background-shells/:runId/:shellId/kill', { preHandler: fromBrowser }, async (req, reply) => {
    const { runId, shellId } = req.params as {
      runId: string;
      shellId: string;
    };
    const r = await shells.kill([{ runId, shellId }], 'human');
    if (!r.killed.length) return reply.code(409).send({ error: r.missed[0]?.reason ?? 'nothing to kill' });
    return r;
  });

  // Every running shell of every live worker run — or of one task's runs.
  // Agent PTYs, repo commands and login shells are never in reach: only a
  // verified direct child of a run's claude process is signalled.
  app.post('/api/background-shells/kill-all', { preHandler: fromBrowser }, async (req) => {
    const { taskId } = killAllBody.parse(req.body ?? {});
    const all = await shells.list();
    const runIds = new Set(
      all.filter((s) => s.state === 'running' && (!taskId || s.taskId === taskId)).map((s) => s.runId),
    );
    return shells.kill(
      [...runIds].map((runId) => ({ runId, shellId: null })),
      'human',
    );
  });
}
