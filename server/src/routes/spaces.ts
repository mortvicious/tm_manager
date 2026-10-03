import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { OrchestratorApi } from '../app-types.ts';
import {
  createNote,
  createSpace,
  deleteNote,
  deleteSpace,
  FILE_VIEW_MAX,
  fileRequest,
  importSeed,
  listNotes,
  listSpaceFiles,
  NOTE_BODY_MAX,
  NOTE_TITLE_MAX,
  patchNote,
  resolveSpaceFile,
  updateSpace,
  writeFolderDocs,
} from '../spaces/service.ts';
import type { Storage } from '../storage/types.ts';

// The human side of shared spaces (docs/shared-spaces.md) — the dashboard's
// Shared page. The agent side is routes/agent-shared.ts; both call the same
// service.

const spaceBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    path: z.string().trim().min(1).max(1000),
    repoIds: z.array(z.string().min(1)).min(1).max(50),
  })
  .strict();

const noteBody = z
  .object({
    kind: z.enum(['request', 'note']),
    title: z.string().min(1).max(NOTE_TITLE_MAX),
    body: z.string().max(NOTE_BODY_MAX).default(''),
    toRepoId: z.string().min(1).nullable().default(null),
    /** A human may write on behalf of a repo (e.g. "nest says"); null = the human. */
    fromRepoId: z.string().min(1).nullable().default(null),
    files: z.array(z.string().min(1).max(500)).max(20).optional(),
  })
  .strict();

const notePatch = z
  .object({
    title: z.string().min(1).max(NOTE_TITLE_MAX).optional(),
    body: z.string().max(NOTE_BODY_MAX).optional(),
    toRepoId: z.string().min(1).nullable().optional(),
    // `filed` is only ever reached by filing — a status without a task is a lie.
    status: z.enum(['open', 'done', 'dismissed']).optional(),
    resolution: z.string().max(4000).nullable().optional(),
    files: z.array(z.string().min(1).max(500)).max(20).optional(),
  })
  .strict();

const TEXT_EXT = /\.(md|markdown|txt|json|jsonl|ya?ml|csv|tsv|sql|log|diff|patch|ts|tsx|js|jsx|mjs|cjs|css|scss|html?|xml|sh|env\.example|toml|ini)$/i;

/**
 * Every write here acts as `human`, so it must come from the browser (the
 * questions route's rule, docs/questions.md): a worker knows $TM_CALLBACK_URL
 * and could otherwise file with `{placement:'queue'}` past the creation and
 * depth caps that the agent path (`/api/agent/shared/...`) enforces. Browsers
 * always send Origin on these methods; curl does not unless told to.
 */
async function fromBrowser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.headers.origin) {
    await reply.code(403).send({ error: 'shared-space edits come from the dashboard — agents use /api/agent/shared' });
  }
}

export function registerSpaceRoutes(app: FastifyInstance, storage: Storage, orchestrator?: OrchestratorApi) {
  const deps = { storage, orchestrator };

  app.get('/api/spaces', async () => storage.listSpaces());

  app.post('/api/spaces', { preHandler: fromBrowser }, async (req, reply) => {
    const body = spaceBody.parse(req.body);
    const r = await createSpace(deps, body, 'human');
    if ('error' in r) return reply.code(r.code).send({ error: r.error });
    return reply.code(201).send(r);
  });

  app.patch('/api/spaces/:id', { preHandler: fromBrowser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await updateSpace(deps, id, spaceBody.partial().parse(req.body), 'human');
    if ('error' in r) return reply.code(r.code).send({ error: r.error });
    return r.space;
  });

  /** Deletes the row and its ledger; the folder on disk is left alone. */
  app.delete('/api/spaces/:id', { preHandler: fromBrowser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await deleteSpace(deps, id, 'human'))) return reply.code(404).send({ error: 'space not found' });
    return { ok: true };
  });

  /** Import `<folder>/.tm/import.json` now (creation does this once by itself). */
  app.post('/api/spaces/:id/import', { preHandler: fromBrowser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const space = await storage.getSpace(id);
    if (!space) return reply.code(404).send({ error: 'space not found' });
    const r = await importSeed(deps, space, 'human');
    await writeFolderDocs(storage, space);
    if (r.error && r.imported === 0) return reply.code(400).send(r);
    return r;
  });

  /** Every space's ledger in one read — the SPA holds it in state and follows it over /ws/events. */
  app.get('/api/shared-notes', async () => listNotes(deps, { limit: 2000 }));

  app.get('/api/spaces/:id/notes', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await storage.getSpace(id))) return reply.code(404).send({ error: 'space not found' });
    return listNotes(deps, { spaceId: id, limit: 2000 });
  });

  app.post('/api/spaces/:id/notes', { preHandler: fromBrowser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const space = await storage.getSpace(id);
    if (!space) return reply.code(404).send({ error: 'space not found' });
    const body = noteBody.parse(req.body);
    if (body.fromRepoId && !space.repoIds.includes(body.fromRepoId)) {
      return reply.code(400).send({ error: 'the author repo is not a member of this space' });
    }
    const r = await createNote(
      deps,
      space,
      { kind: body.kind, title: body.title, body: body.body, toRepoId: body.toRepoId, files: body.files },
      { actor: 'human', fromRepoId: body.fromRepoId, fromTaskId: null },
    );
    if ('error' in r) return reply.code(r.code).send({ error: r.error });
    return reply.code(201).send(r.note);
  });

  app.patch('/api/shared-notes/:id', { preHandler: fromBrowser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await patchNote(deps, id, notePatch.parse(req.body), 'human');
    if ('error' in r) return reply.code(r.code).send({ error: r.error });
    return r.note;
  });

  app.delete('/api/shared-notes/:id', { preHandler: fromBrowser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await deleteNote(deps, id, 'human'))) return reply.code(404).send({ error: 'note not found' });
    return { ok: true };
  });

  /** File a request as a task in the addressed repo: a draft, or straight into the custom queue. */
  app.post('/api/shared-notes/:id/file', { preHandler: fromBrowser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { placement } = z
      .object({ placement: z.enum(['queue', 'draft']).default('draft') })
      .strict()
      .parse(req.body ?? {});
    const r = await fileRequest(deps, id, { actor: 'human', placement });
    if ('error' in r) return reply.code(r.code).send({ error: r.error });
    return r;
  });

  app.get('/api/spaces/:id/files', async (req, reply) => {
    const { id } = req.params as { id: string };
    const space = await storage.getSpace(id);
    if (!space) return reply.code(404).send({ error: 'space not found' });
    return listSpaceFiles(space);
  });

  /**
   * One file, by path relative to the folder. Text is served inline as
   * text/plain (the page renders it); anything else downloads. The path must
   * resolve — symlinks included — to a regular file INSIDE the folder.
   */
  app.get('/api/spaces/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rel = String((req.query as { path?: string }).path ?? '');
    const space = await storage.getSpace(id);
    if (!space) return reply.code(404).send({ error: 'space not found' });
    const abs = resolveSpaceFile(space, rel);
    if (!abs) return reply.code(404).send({ error: 'no such file in this space' });
    const size = fs.statSync(abs).size;
    const name = path.basename(abs);
    if (TEXT_EXT.test(name) || !path.extname(name)) {
      if (size > FILE_VIEW_MAX) return reply.code(413).send({ error: 'file is too large to view here — open the folder' });
      return reply
        .header('content-type', 'text/plain; charset=utf-8')
        .header('x-content-type-options', 'nosniff')
        .send(fs.readFileSync(abs, 'utf8'));
    }
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${name.replace(/[^\w.\- ]+/g, '_')}"`)
      .send(fs.createReadStream(abs));
  });
}
