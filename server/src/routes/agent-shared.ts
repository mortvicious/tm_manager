import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Repo, Run, SharedNote, Space } from '@tm/shared';
import type { Orchestrator } from '../orchestrator.ts';
import {
  createNote,
  fileRequest,
  listNotes,
  NOTE_BODY_MAX,
  NOTE_TITLE_MAX,
  patchNote,
  reconcileFiled,
  spaceForRepo,
} from '../spaces/service.ts';
import type { Storage } from '../storage/types.ts';
import { maxSpawnDepth, perRunCap, QUEUED_AGENT_CEILING } from './agent-caps.ts';

// The agent side of shared spaces (docs/shared-spaces.md). Everything is scoped
// to the space of the CALLER's repo — the token is the identity, so an agent
// can neither read nor write another space's ledger.

/** Notes one worker session may write — a spam guard, not a budget. */
export const SHARED_NOTE_RUN_CAP = 10;

const noteBody = z
  .object({
    kind: z.enum(['request', 'note']),
    title: z.string().min(1).max(NOTE_TITLE_MAX),
    body: z.string().max(NOTE_BODY_MAX).default(''),
    /** repo id, exact name or role — a member of the caller's space */
    to: z.string().min(1).nullish(),
    files: z.array(z.string().min(1).max(500)).max(20).optional(),
  })
  .strict();

const resolveBody = z
  .object({
    status: z.enum(['done', 'dismissed']),
    resolution: z.string().min(1).max(4000),
  })
  .strict();

const appendBody = z.object({ text: z.string().min(1).max(4000) }).strict();

const fileBody = z
  .object({
    title: z.string().min(1).max(300).optional(),
    description: z.string().max(NOTE_BODY_MAX).optional(),
    category: z.string().min(1).max(60).optional(),
  })
  .strict();

export function registerAgentSharedRoutes(
  app: FastifyInstance,
  storage: Storage,
  orchestrator: Orchestrator,
  authRun: (req: FastifyRequest) => Promise<Run | null>,
) {
  const deps = { storage, orchestrator };

  /** The caller's run, repo and space — or the reply it should get instead. */
  const ctx = async (req: FastifyRequest) => {
    const run = await authRun(req);
    if (!run) return { ok: false as const, code: 403, error: 'forbidden' };
    const space = await spaceForRepo(storage, run.repoId);
    if (!space || !run.repoId) {
      return { ok: false as const, code: 404, error: 'your repo is not in a shared space — there is no ledger to read or write' };
    }
    const repos = (await storage.listRepos()).filter((r) => space.repoIds.includes(r.id));
    return { ok: true as const, run, space, repos, repoId: run.repoId };
  };

  const brief = (n: SharedNote, repos: Repo[]) => {
    const name = (id: string | null) => (id ? repos.find((r) => r.id === id)?.name ?? id : null);
    return {
      id: n.id,
      kind: n.kind,
      title: n.title,
      from: name(n.fromRepoId) ?? 'human',
      to: name(n.toRepoId),
      status: n.status,
      taskId: n.taskId,
      files: n.files,
      createdAt: n.createdAt,
    };
  };
  const full = (n: SharedNote, repos: Repo[]) => ({ ...brief(n, repos), body: n.body, resolution: n.resolution, fromTaskId: n.fromTaskId });
  const inSpace = async (id: string, space: Space) => {
    const n = await storage.getSharedNote(id);
    return n && n.spaceId === space.id ? n : null;
  };

  app.get('/api/agent/shared', async (req, reply) => {
    const c = await ctx(req);
    if (!c.ok) return reply.code(c.code).send({ error: c.error });
    const { space, repos, repoId } = c;
    const forYou = await listNotes(deps, { spaceId: space.id, kind: 'request', status: ['open', 'filed'], toRepoId: repoId, oldestFirst: true });
    const mine = (await listNotes(deps, { spaceId: space.id, kind: 'request', status: ['open', 'filed'], oldestFirst: true })).filter(
      (n) => n.fromRepoId === repoId,
    );
    const notes = await listNotes(deps, { spaceId: space.id, kind: 'note', status: ['open'], limit: 100 });
    return {
      space: { id: space.id, name: space.name, path: space.path, repos: repos.map((r) => ({ id: r.id, name: r.name, role: r.role })) },
      requestsForYourRepo: forYou.map((n) => full(n, repos)),
      yourReposOpenAsks: mine.map((n) => brief(n, repos)),
      notes: notes.map((n) => brief(n, repos)),
      howTo: [
        'POST /api/agent/shared/notes {kind:"request"|"note", to, title, body, files?} — write one (a request needs `to`: the repo that must act, never your own)',
        'POST /api/agent/shared/notes/<id>/file {} — file a task in YOUR repo for a request addressed to it (joins the custom queue; starts once your task is published, done or cancelled)',
        'POST /api/agent/shared/notes/<id>/resolve {status:"done"|"dismissed", resolution} — with the evidence',
        'POST /api/agent/shared/notes/<id>/append {text} — add to an existing request/note instead of opening a duplicate',
        `Knowledge files: ${space.path} ($TM_SHARED_DIR) — keep INDEX.md current; REQUESTS.md is generated.`,
      ],
    };
  });

  app.get('/api/agent/shared/notes', async (req, reply) => {
    const c = await ctx(req);
    if (!c.ok) return reply.code(c.code).send({ error: c.error });
    const q = req.query as { status?: string; kind?: string };
    const picked = (q.status ?? '').split(',').filter((s) => ['open', 'filed', 'done', 'dismissed'].includes(s)) as SharedNote['status'][];
    const status: SharedNote['status'][] = picked.length ? picked : ['open', 'filed'];
    const kind = q.kind === 'request' || q.kind === 'note' ? q.kind : undefined;
    const notes = await listNotes(deps, { spaceId: c.space.id, status, kind, limit: 200 });
    return notes.map((n) => brief(n, c.repos));
  });

  app.get('/api/agent/shared/notes/:id', async (req, reply) => {
    const c = await ctx(req);
    if (!c.ok) return reply.code(c.code).send({ error: c.error });
    const n = await inSpace((req.params as { id: string }).id, c.space);
    if (!n) return reply.code(404).send({ error: 'no such note in your space' });
    const [fresh] = await reconcileFiled(deps, [n]);
    return full(fresh, c.repos);
  });

  app.post('/api/agent/shared/notes', async (req, reply) => {
    const c = await ctx(req);
    if (!c.ok) return reply.code(c.code).send({ error: c.error });
    const body = noteBody.parse(req.body);
    const actor = `agent:${c.run.id.slice(0, 8)}`;
    const written = (await storage.listSharedNotes({ spaceId: c.space.id, createdAfter: c.run.startedAt, limit: 2000 })).filter(
      (n) => n.actor === actor,
    ).length;
    if (written >= SHARED_NOTE_RUN_CAP) {
      return reply.code(403).send({ error: `shared note cap (${SHARED_NOTE_RUN_CAP}) reached for this session — finish your turn` });
    }
    let toRepoId: string | null = null;
    if (body.to) {
      const needle = body.to.toLowerCase();
      const byRole = c.repos.filter((r) => (r.role ?? '').toLowerCase() === needle);
      const target =
        c.repos.find((r) => r.id === body.to) ??
        c.repos.find((r) => r.name.toLowerCase() === needle) ??
        (byRole.length === 1 ? byRole[0] : undefined);
      if (!target) {
        return reply.code(400).send({
          error: `"${body.to}" is not a repo of this space${byRole.length > 1 ? ' (ambiguous role — use the id)' : ''}`,
          members: c.repos.map((r) => ({ id: r.id, name: r.name, role: r.role })),
        });
      }
      toRepoId = target.id;
    }
    const r = await createNote(
      deps,
      c.space,
      { kind: body.kind, title: body.title, body: body.body, toRepoId, files: body.files },
      { actor, fromRepoId: c.repoId, fromTaskId: c.run.taskId },
    );
    if ('error' in r) return reply.code(r.code).send({ error: r.error });
    return reply.code(201).send(full(r.note, c.repos));
  });

  app.post('/api/agent/shared/notes/:id/append', async (req, reply) => {
    const c = await ctx(req);
    if (!c.ok) return reply.code(c.code).send({ error: c.error });
    const n = await inSpace((req.params as { id: string }).id, c.space);
    if (!n) return reply.code(404).send({ error: 'no such note in your space' });
    const { text } = appendBody.parse(req.body);
    const me = c.repos.find((r) => r.id === c.repoId)?.name ?? 'an agent';
    const body = `${n.body}\n\n**Update from ${me} (${new Date().toISOString().slice(0, 10)}${c.run.taskId ? `, task ${c.run.taskId}` : ''}):** ${text}`;
    if (body.length > NOTE_BODY_MAX) return reply.code(400).send({ error: 'the note is full — write a new one that references it' });
    const r = await patchNote(deps, n.id, { body }, `agent:${c.run.id.slice(0, 8)}`, { audit: { action: 'appended' } });
    if ('error' in r) return reply.code(r.code).send({ error: r.error });
    return full(r.note, c.repos);
  });

  app.post('/api/agent/shared/notes/:id/resolve', async (req, reply) => {
    const c = await ctx(req);
    if (!c.ok) return reply.code(c.code).send({ error: c.error });
    const n = await inSpace((req.params as { id: string }).id, c.space);
    if (!n) return reply.code(404).send({ error: 'no such note in your space' });
    // The repo that must act decides it is done; the repo that asked may
    // withdraw. A third member has no say over somebody else's request.
    if (n.toRepoId !== c.repoId && n.fromRepoId !== c.repoId) {
      return reply.code(403).send({ error: 'only the addressed repo or the author repo may resolve this — append to it instead' });
    }
    const body = resolveBody.parse(req.body);
    const r = await patchNote(
      deps,
      n.id,
      { status: body.status, resolution: body.resolution },
      `agent:${c.run.id.slice(0, 8)}`,
      { fromStatus: ['open', 'filed'], audit: { action: 'resolved', byTask: c.run.taskId } },
    );
    if ('error' in r) return reply.code(r.code).send({ error: r.error });
    return full(r.note, c.repos);
  });

  /**
   * Pick up a request addressed to the caller's repo and file it as a task
   * there. This is the one agent path that files work into its OWN repo
   * without the same-repo draft rule: the task goes to the custom queue, where
   * an agent-created member waits for this caller's task to be resolved and
   * for the repo to have no working or mid-review task (storage/queue-sql.ts,
   * docs/shared-spaces.md § Filing). The depth and
   * per-session caps still apply, and `agent.allowEnqueue` off or the agent
   * queue ceiling still degrade it to a draft.
   */
  app.post('/api/agent/shared/notes/:id/file', async (req, reply) => {
    const c = await ctx(req);
    if (!c.ok) return reply.code(c.code).send({ error: c.error });
    const n = await inSpace((req.params as { id: string }).id, c.space);
    if (!n) return reply.code(404).send({ error: 'no such request in your space' });
    if (n.kind !== 'request') return reply.code(400).send({ error: 'only requests can be filed — a note is knowledge, not work' });
    if (n.toRepoId !== c.repoId) {
      return reply.code(403).send({ error: 'you can only file requests addressed to your own repo — the addressed repo picks it up' });
    }
    const body = fileBody.parse(req.body ?? {});
    const settings = await storage.getSettings();
    const callerTask = c.run.taskId ? await storage.getTask(c.run.taskId) : null;
    const maxDepth = maxSpawnDepth(settings);
    const depth = (callerTask?.spawnDepth ?? 0) + 1;
    if (depth > maxDepth) {
      return reply.code(403).send({
        error: `depth limit: this task is already ${maxDepth} hops from a human — leave the request open for the next task; finish your turn`,
      });
    }
    const cap = perRunCap(settings);
    if ((await storage.countTasksCreatedByRun(c.run.id)) >= cap) {
      return reply.code(403).send({ error: `task creation cap (${cap}) reached for this session — leave the request open` });
    }
    let placement: 'queue' | 'draft' = 'queue';
    let placementNote: string | null = null;
    if (!settings['agent.allowEnqueue']) {
      placement = 'draft';
      placementNote = 'enqueue disabled (agent.allowEnqueue is off) — filed as a draft for human review';
    } else if ((await storage.countQueuedAgentTasks()) >= QUEUED_AGENT_CEILING) {
      placement = 'draft';
      placementNote = `agent queue ceiling (${QUEUED_AGENT_CEILING}) reached — filed as a draft`;
    }
    const actor = `agent:${c.run.id.slice(0, 8)}`;
    const r = await fileRequest(deps, n.id, {
      actor,
      placement,
      placementNote,
      title: body.title,
      description: body.description,
      category: body.category ?? null,
      createdByRun: c.run.id,
      spawnDepth: depth,
    });
    if ('error' in r) return reply.code(r.code).send({ error: r.error });
    await storage.appendEvent({
      kind: 'agent.create',
      actor,
      taskId: r.task.id,
      runId: c.run.id,
      repoId: c.repoId,
      data: { fromSharedRequest: n.id, effectiveStatus: r.task.status, customQueue: !!r.task.customQueueAt, note: r.placementNote },
    });
    return {
      task: { id: r.task.id, status: r.task.status, customQueue: !!r.task.customQueueAt },
      request: brief(r.note, c.repos),
      note: r.placementNote,
    };
  });
}
