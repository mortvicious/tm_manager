import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { BranchesOverview, Repo } from '@tm/shared';
import { branchesOverview, fetchRepo } from '../branches.ts';
import type { Storage } from '../storage/types.ts';

// Branch tracking (docs/branches.md): what is merged into an essential branch
// and on the remote, versus what exists only in this machine's checkouts.

const scopeQuery = z.object({ repoId: z.string().min(1).optional() });
const fetchBody = z.object({ repoId: z.string().min(1).optional() });

/**
 * A fetch talks to the remote with the user's credentials, so it comes from
 * the dashboard (the shells/spaces rule): a worker's curl sends no Origin.
 */
async function fromBrowser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.headers.origin) {
    await reply.code(403).send({ error: 'fetch is started from the dashboard' });
  }
}

async function scope(storage: Storage, repoId: string | undefined): Promise<Repo[] | null> {
  if (!repoId) return storage.listRepos();
  const repo = await storage.getRepo(repoId);
  return repo ? [repo] : null;
}

export function registerBranchRoutes(app: FastifyInstance, storage: Storage) {
  // Local refs only — no network. The remote side is as fresh as the last
  // fetch, which each repo reports as `fetchedAt`.
  app.get('/api/branches', async (req, reply) => {
    const { repoId } = scopeQuery.parse(req.query ?? {});
    const repos = await scope(storage, repoId);
    if (!repos) return reply.code(404).send({ error: 'repo not found' });
    const overview: BranchesOverview = await branchesOverview(repos, await storage.listTasks());
    return overview;
  });

  // `git fetch --prune` every repo in scope, then the same answer as GET. A
  // failed fetch is reported on its repo (`fetchError`), never as a 5xx: the
  // local state is still worth showing.
  app.post('/api/branches/fetch', { preHandler: fromBrowser }, async (req, reply) => {
    const { repoId } = fetchBody.parse(req.body ?? {});
    const repos = await scope(storage, repoId);
    if (!repos) return reply.code(404).send({ error: 'repo not found' });
    const errors = new Map<string, string | null>();
    await Promise.all(repos.map(async (r) => errors.set(r.id, await fetchRepo(r))));
    const overview: BranchesOverview = await branchesOverview(repos, await storage.listTasks(), errors);
    return overview;
  });
}
