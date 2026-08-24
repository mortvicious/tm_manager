import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { z } from 'zod';
import { expandHome } from '../config.ts';
import { commitRepo, gitStatus, pushRepo } from '../git.ts';
import type { Storage } from '../storage/types.ts';

const repoBody = z
  .object({
    name: z.string().min(1).optional(),
    path: z.string().min(1),
    role: z.string().nullish(),
  })
  .strict();

export function registerRepoRoutes(app: FastifyInstance, storage: Storage) {
  app.get('/api/repos', async () => storage.listRepos());

  app.post('/api/repos', async (req, reply) => {
    const body = repoBody.parse(req.body);
    let abs: string;
    try {
      abs = expandHome(body.path);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      return reply.code(400).send({ error: `Path is not an existing directory: ${abs}` });
    }
    const name = body.name?.trim() || abs.split('/').filter(Boolean).pop() || abs;
    const repo = await storage.createRepo({ name, path: abs, role: body.role ?? null });
    await storage.appendEvent({ kind: 'repo.changed', actor: 'human', repoId: repo.id, data: { action: 'created', name } });
    return repo;
  });

  app.patch('/api/repos/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = repoBody.partial().parse(req.body);
    let abs: string | undefined;
    if (body.path) {
      try {
        abs = expandHome(body.path);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        return reply.code(400).send({ error: `Path is not an existing directory: ${abs}` });
      }
    }
    const repo = await storage.updateRepo(id, { name: body.name, path: abs, role: body.role });
    if (!repo) return reply.code(404).send({ error: 'repo not found' });
    await storage.appendEvent({ kind: 'repo.changed', actor: 'human', repoId: id, data: { action: 'updated' } });
    return repo;
  });

  app.delete('/api/repos/:id', async (req) => {
    const { id } = req.params as { id: string };
    await storage.deleteRepo(id);
    await storage.appendEvent({ kind: 'repo.changed', actor: 'human', repoId: id, data: { action: 'deleted' } });
    return { ok: true };
  });

  app.get('/api/repos/:id/git', async (req, reply) => {
    const { id } = req.params as { id: string };
    const repo = await storage.getRepo(id);
    if (!repo) return reply.code(404).send({ error: 'repo not found' });
    return gitStatus(repo);
  });

  // git add -A + commit; the message is written by claude-opus-5 from the
  // staged diff (user policy). Explicit button, human actor.
  app.post('/api/repos/:id/commit', async (req, reply) => {
    const { id } = req.params as { id: string };
    const repo = await storage.getRepo(id);
    if (!repo) return reply.code(404).send({ error: 'repo not found' });
    const result = await commitRepo(storage, repo);
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    return result;
  });

  app.post('/api/repos/:id/push', async (req, reply) => {
    const { id } = req.params as { id: string };
    const repo = await storage.getRepo(id);
    if (!repo) return reply.code(404).send({ error: 'repo not found' });
    const result = await pushRepo(storage, repo);
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    return result;
  });
}
