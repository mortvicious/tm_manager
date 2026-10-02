import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MAX_SHELL_SESSIONS } from '@tm/shared';
import { ShellConflict, type ShellRunner } from '../shells/runner.ts';
import type { Storage } from '../storage/types.ts';

const openBody = z
  .object({
    repoId: z.string().min(1),
    count: z.number().int().min(1).max(MAX_SHELL_SESSIONS).optional(),
  })
  .strict();

/**
 * A shell is a code-execution surface, and these routes act as `human`, so
 * they must come from the dashboard (the questions/spaces rule): a worker
 * knows $TM_CALLBACK_URL, and its curl sends no Origin. A worker gains nothing
 * it lacks — it already has Bash — but the audit row must not lie about who
 * opened the shell. Browsers always send Origin on POST/DELETE.
 */
async function fromBrowser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.headers.origin) {
    await reply.code(403).send({ error: 'terminals are opened from the dashboard' });
  }
}

export function registerShellRoutes(app: FastifyInstance, storage: Storage, runner: ShellRunner) {
  app.get('/api/shells', async () => runner.list());

  app.post('/api/shells', { preHandler: fromBrowser }, async (req, reply) => {
    const { repoId, count = 1 } = openBody.parse(req.body ?? {});
    const repo = await storage.getRepo(repoId);
    if (!repo) return reply.code(404).send({ error: 'repo not found' });
    try {
      return await runner.open(repo, count, 'human');
    } catch (e) {
      const err = e as Error;
      // The cap is "close one and retry", not "this repo is broken".
      const conflict = err instanceof ShellConflict || /session cap reached/.test(err.message);
      return reply.code(conflict ? 409 : 400).send({ error: err.message });
    }
  });

  app.delete('/api/shells/:id', { preHandler: fromBrowser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await runner.close(id, 'human'))) return reply.code(404).send({ error: 'no such terminal' });
    return { ok: true };
  });
}
