import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  GROUP_COLOR_COUNT,
  WORKSPACE_RESERVED_SLUG,
  WORKSPACE_SLUG_RE,
  uniqueWorkspaceSlug,
  type Workspace,
} from '@tm/shared';
import { broadcast } from '../events.ts';
import type { Storage } from '../storage/types.ts';
import { isUniqueViolation } from '../storage/workspace-sql.ts';

// Workspaces (docs/workspaces.md): named, scoped views over a set of repos.
// Data only — a workspace changes what the dashboard shows, never what a
// worker sees, so there is no agent side.

const fields = {
  name: z.string().trim().min(1).max(60),
  slug: z.string().trim().min(1).max(40),
  repoIds: z.array(z.string().min(1)).min(1).max(50),
  color: z.number().int().min(1).max(GROUP_COLOR_COUNT).nullable(),
};

const createBody = z
  .object({ name: fields.name, slug: fields.slug.optional(), repoIds: fields.repoIds, color: fields.color.default(null) })
  .strict();

const patchBody = z
  .object({
    name: fields.name.optional(),
    slug: fields.slug.optional(),
    repoIds: fields.repoIds.optional(),
    color: fields.color.optional(),
  })
  .strict();

const reorderBody = z.object({ ids: z.array(z.string().min(1)).max(500) }).strict();

/**
 * Every write here acts as `human`, so it must come from the browser (the
 * shared-spaces rule, routes/spaces.ts): browsers always send Origin on these
 * methods; a worker's curl does not unless told to.
 */
async function fromBrowser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.headers.origin) {
    await reply.code(403).send({ error: 'workspace edits come from the dashboard' });
  }
}

/** Why an explicit slug cannot be used, or null. Uniqueness is the caller's (409, not 400). */
function slugRefusal(slug: string): string | null {
  if (slug === WORKSPACE_RESERVED_SLUG) return `"${WORKSPACE_RESERVED_SLUG}" is reserved for the every-repo view`;
  if (!WORKSPACE_SLUG_RE.test(slug)) return 'slug must be 1–40 of a-z, 0-9 and "-", starting with a letter or digit';
  return null;
}

export function registerWorkspaceRoutes(app: FastifyInstance, storage: Storage) {
  const repoIdSet = async () => new Set((await storage.listRepos()).map((r) => r.id));

  /** Ids of repos that were deleted since are dropped on READ — the row keeps them. */
  const visible = (w: Workspace, repos: Set<string>): Workspace => ({ ...w, repoIds: w.repoIds.filter((id) => repos.has(id)) });

  /** Unique, de-duplicated, all existing — or the error. */
  const checkRepos = async (ids: string[]): Promise<{ ids: string[] } | { error: string }> => {
    const repos = await repoIdSet();
    const unknown = ids.filter((id) => !repos.has(id));
    if (unknown.length) return { error: `unknown repo id(s): ${[...new Set(unknown)].join(', ')}` };
    return { ids: [...new Set(ids)] };
  };

  const announce = async (w: Workspace): Promise<Workspace> => {
    const shown = visible(w, await repoIdSet());
    broadcast({ type: 'workspace.updated', workspace: shown });
    return shown;
  };

  app.get('/api/workspaces', async () => {
    const repos = await repoIdSet();
    return (await storage.listWorkspaces()).map((w) => visible(w, repos));
  });

  app.post('/api/workspaces', { preHandler: fromBrowser }, async (req, reply) => {
    const body = createBody.parse(req.body);
    const repos = await checkRepos(body.repoIds);
    if ('error' in repos) return reply.code(400).send({ error: repos.error });
    const taken = new Set((await storage.listWorkspaces()).map((w) => w.slug));
    let slug: string;
    if (body.slug !== undefined) {
      const bad = slugRefusal(body.slug);
      if (bad) return reply.code(400).send({ error: bad });
      if (taken.has(body.slug)) return reply.code(409).send({ error: `slug "${body.slug}" is already used by another workspace` });
      slug = body.slug;
    } else {
      // A derived slug is never refused: it takes a numeric suffix instead.
      slug = uniqueWorkspaceSlug(body.name, taken);
    }
    let w: Workspace;
    try {
      w = await storage.createWorkspace({ name: body.name, slug, repoIds: repos.ids, color: body.color });
    } catch (e) {
      if (isUniqueViolation(e)) return reply.code(409).send({ error: `slug "${slug}" is already used by another workspace` });
      throw e;
    }
    await storage.appendEvent({
      kind: 'workspace.changed',
      actor: 'human',
      data: { action: 'created', workspaceId: w.id, name: w.name, slug: w.slug, repoIds: w.repoIds },
    });
    return reply.code(201).send(await announce(w));
  });

  /** A rename keeps the slug: only an explicit `slug` moves it. */
  app.patch('/api/workspaces/:id', { preHandler: fromBrowser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = patchBody.parse(req.body);
    const cur = await storage.getWorkspace(id);
    if (!cur) return reply.code(404).send({ error: 'workspace not found' });
    if (body.repoIds !== undefined) {
      const repos = await checkRepos(body.repoIds);
      if ('error' in repos) return reply.code(400).send({ error: repos.error });
      body.repoIds = repos.ids;
    }
    if (body.slug !== undefined && body.slug !== cur.slug) {
      const bad = slugRefusal(body.slug);
      if (bad) return reply.code(400).send({ error: bad });
      if ((await storage.listWorkspaces()).some((w) => w.id !== id && w.slug === body.slug)) {
        return reply.code(409).send({ error: `slug "${body.slug}" is already used by another workspace` });
      }
    }
    let w: Workspace | null;
    try {
      w = await storage.updateWorkspace(id, body);
    } catch (e) {
      if (isUniqueViolation(e)) return reply.code(409).send({ error: `slug "${body.slug}" is already used by another workspace` });
      throw e;
    }
    if (!w) return reply.code(404).send({ error: 'workspace not found' });
    await storage.appendEvent({
      kind: 'workspace.changed',
      actor: 'human',
      data: { action: 'edited', workspaceId: id, fields: Object.keys(body) },
    });
    return announce(w);
  });

  app.delete('/api/workspaces/:id', { preHandler: fromBrowser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const cur = await storage.getWorkspace(id);
    if (!cur || !(await storage.deleteWorkspace(id))) return reply.code(404).send({ error: 'workspace not found' });
    await storage.appendEvent({
      kind: 'workspace.changed',
      actor: 'human',
      data: { action: 'deleted', workspaceId: id, name: cur.name, slug: cur.slug },
    });
    broadcast({ type: 'workspace.deleted', workspaceId: id });
    return { ok: true };
  });

  /**
   * The switcher's order: `ids` first, in that order, then any workspace not
   * listed in its current order. Every workspace is re-broadcast, since every
   * `sortOrder` may have moved.
   */
  app.post('/api/workspaces/reorder', { preHandler: fromBrowser }, async (req, reply) => {
    const { ids } = reorderBody.parse(req.body);
    if (new Set(ids).size !== ids.length) return reply.code(400).send({ error: 'ids must not repeat' });
    const known = new Set((await storage.listWorkspaces()).map((w) => w.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) return reply.code(400).send({ error: `unknown workspace id(s): ${unknown.join(', ')}` });
    const list = await storage.reorderWorkspaces(ids);
    await storage.appendEvent({ kind: 'workspace.changed', actor: 'human', data: { action: 'reordered', ids: list.map((w) => w.id) } });
    const repos = await repoIdSet();
    const shown = list.map((w) => visible(w, repos));
    for (const w of shown) broadcast({ type: 'workspace.updated', workspace: w });
    return shown;
  });
}
