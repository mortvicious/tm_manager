import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { LANDING_TIERS, PUSH_POLICIES, type LandingTier, type PushPolicy } from '@tm/shared';
import { z } from 'zod';
import { expandHome } from '../config.ts';
import { commitRepo, gitStatus, pushRepo } from '../git.ts';
import { spaceConflictForRepo } from '../spaces/service.ts';
import type { Storage } from '../storage/types.ts';

const repoBody = z
  .object({
    name: z.string().min(1).optional(),
    path: z.string().min(1),
    role: z.string().nullish(),
    // dev-server URL framed by the mobile emulator; '' / null clears it
    previewUrl: z.string().nullish(),
    // how far this repo's tasks land on their own (docs/design.md § Landing tiers)
    landing: z.enum(LANDING_TIERS as [LandingTier, ...LandingTier[]]).optional(),
    // what worker turns are told about `git push` (docs/publish.md § Push policy)
    pushPolicy: z.enum(PUSH_POLICIES as [PushPolicy, ...PushPolicy[]]).optional(),
  })
  .strict();

/**
 * Raising a landing tier lets work reach `done` (or the remote) with no human
 * in between, so it is the dashboard's to set, never a worker's curl (the
 * questions/spaces rule: browsers always send Origin, curl does not unless
 * told to). Lowering back to supervised is always allowed.
 */
export function landingNeedsBrowser(landing: LandingTier | null | undefined, origin: string | undefined): boolean {
  return !!landing && landing !== 'supervised' && !origin;
}
export const LANDING_FROM_BROWSER = 'landing tiers are set from the dashboard';

/**
 * The same rule for the push policy (docs/publish.md § Push policy):
 * `agent-pushes` lets a worker push with nobody asked, so only the dashboard
 * sets it. `repo-rules` and `publish-turn` never add autonomy (the latter
 * takes it away) and are allowed from anywhere.
 */
export function pushPolicyNeedsBrowser(policy: PushPolicy | null | undefined, origin: string | undefined): boolean {
  return policy === 'agent-pushes' && !origin;
}
export const PUSH_POLICY_FROM_BROWSER = 'push policies are set from the dashboard';

/** The emulator puts this string straight into an iframe `src`, so the scheme
 *  is pinned to http/https here — the one place every write passes through. */
function normalizePreviewUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  // An explicit `scheme://` is taken at its word (so ftp:// is rejected, not
  // silently rewritten); anything else is tried as written and then as a bare
  // host, because "localhost:5173" is what people actually type and it parses
  // as a bogus "localhost:" scheme.
  const explicit = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  const url = explicit ? parseHttpUrl(trimmed) : parseHttpUrl(trimmed) ?? parseHttpUrl(`http://${trimmed}`);
  if (!url) throw new Error(`Preview URL must be an http(s) address, got: ${trimmed}`);
  return url.toString();
}

function parseHttpUrl(candidate: string): URL | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

export function registerRepoRoutes(app: FastifyInstance, storage: Storage) {
  app.get('/api/repos', async () => storage.listRepos());

  app.post('/api/repos', async (req, reply) => {
    const body = repoBody.parse(req.body);
    if (landingNeedsBrowser(body.landing, req.headers.origin)) return reply.code(403).send({ error: LANDING_FROM_BROWSER });
    if (pushPolicyNeedsBrowser(body.pushPolicy, req.headers.origin)) return reply.code(403).send({ error: PUSH_POLICY_FROM_BROWSER });
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
    const clash = await spaceConflictForRepo(storage, { name, path: abs });
    if (clash) return reply.code(400).send({ error: clash });
    let previewUrl: string | null;
    try {
      previewUrl = normalizePreviewUrl(body.previewUrl);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const repo = await storage.createRepo({ name, path: abs, role: body.role ?? null, previewUrl, landing: body.landing, pushPolicy: body.pushPolicy });
    await storage.appendEvent({
      kind: 'repo.changed',
      actor: 'human',
      repoId: repo.id,
      data: { action: 'created', name, landing: repo.landing, pushPolicy: repo.pushPolicy },
    });
    return repo;
  });

  app.patch('/api/repos/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = repoBody.partial().parse(req.body);
    if (landingNeedsBrowser(body.landing, req.headers.origin)) return reply.code(403).send({ error: LANDING_FROM_BROWSER });
    if (pushPolicyNeedsBrowser(body.pushPolicy, req.headers.origin)) return reply.code(403).send({ error: PUSH_POLICY_FROM_BROWSER });
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
      const clash = await spaceConflictForRepo(storage, { name: body.name ?? 'this repo', path: abs });
      if (clash) return reply.code(400).send({ error: clash });
    }
    let previewUrl: string | null | undefined;
    if ('previewUrl' in body) {
      try {
        previewUrl = normalizePreviewUrl(body.previewUrl);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    }
    const before = body.landing || body.pushPolicy ? await storage.getRepo(id) : null;
    const repo = await storage.updateRepo(id, {
      name: body.name,
      path: abs,
      role: body.role,
      previewUrl,
      landing: body.landing,
      pushPolicy: body.pushPolicy,
    });
    if (!repo) return reply.code(404).send({ error: 'repo not found' });
    await storage.appendEvent({
      kind: 'repo.changed',
      actor: 'human',
      repoId: id,
      data: {
        action: 'updated',
        ...(before && before.landing !== repo.landing ? { landing: { from: before.landing, to: repo.landing } } : {}),
        ...(before && before.pushPolicy !== repo.pushPolicy ? { pushPolicy: { from: before.pushPolicy, to: repo.pushPolicy } } : {}),
      },
    });
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

  // git add -A + commit; the message is written by claude-opus-5-5 from the
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
