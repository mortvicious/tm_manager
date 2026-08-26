import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { GROUP_COLOR_COUNT, type TaskStatus } from '@tm/shared';
import { z } from 'zod';
import { artifactsRoot } from '../config.ts';
import { broadcast } from '../events.ts';
import type { Storage } from '../storage/types.ts';

// Status, error and resultSummary are machine-owned: transitions happen only via
// the action endpoints and internal hook routes, never through a generic PATCH.
// .strict() so a client sending e.g. {status} gets a loud 400, not a silent strip.
const taskBody = z
  .object({
    title: z.string().min(1),
    description: z.string().nullish(),
    repoId: z.string().nullish(),
    parentId: z.string().nullish(),
    priority: z.number().int().optional(),
    source: z.enum(['manual', 'sentry', 'auto']).optional(),
    sourceRef: z.string().nullish(),
    model: z.string().min(1).nullish(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullish(),
    category: z.string().min(1).max(60).nullish(),
    review: z.boolean().nullish(),
    // "allow auto-publish on end": skip the review gate and commit+push when
    // the worker finishes (docs/publish.md)
    autoPublish: z.boolean().optional(),
    // group identity lives on the group's ROOT task (docs/grouping.md); the
    // route rejects both on a task that has a parent.
    groupName: z.string().min(1).max(80).nullish(),
    groupColor: z.number().int().min(1).max(GROUP_COLOR_COUNT).nullish(),
  })
  .strict();

const taskPatch = taskBody.partial().strict();

export function registerTaskRoutes(app: FastifyInstance, storage: Storage) {
  app.get('/api/tasks', async (req) => {
    const q = req.query as { status?: any; repoId?: string; parentId?: string; groupId?: string };
    return storage.listTasks({ status: q.status, repoId: q.repoId, parentId: q.parentId, groupId: q.groupId });
  });

  // Every task in one tree, root first — the group behind a task.
  app.get('/api/tasks/:id/group', async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await storage.getTask(id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    const tasks = await storage.listTasks({ groupId: task.groupId });
    const root = tasks.find((t) => t.id === task.groupId) ?? null;
    return { groupId: task.groupId, name: root?.groupName ?? null, color: root?.groupColor ?? null, tasks };
  });

  app.get('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await storage.getTask(id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    return task;
  });

  app.post('/api/tasks', async (req) => {
    const body = taskBody.parse(req.body);
    const task = await storage.createTask(body, 'human');
    broadcast({ type: 'task.updated', task });
    return task;
  });

  app.patch('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = taskPatch.parse(req.body);
    if (body.parentId === id) return reply.code(400).send({ error: 'a task cannot be its own parent' });
    const cur = await storage.getTask(id);
    if (!cur) return reply.code(404).send({ error: 'task not found' });
    // Naming/colouring is a property of the GROUP, so it is only accepted on
    // the group's root — otherwise two members could claim different names.
    const namesGroup = body.groupName !== undefined || body.groupColor !== undefined;
    const parentAfter = body.parentId === undefined ? cur.parentId : (body.parentId ?? null);
    if (namesGroup && parentAfter) {
      return reply
        .code(400)
        .send({ error: 'only the root task of a group can be named or coloured — patch the root instead' });
    }
    const moving = body.parentId !== undefined && (body.parentId ?? null) !== cur.parentId;
    if (moving && body.parentId) {
      const parent = await storage.getTask(body.parentId);
      if (!parent) return reply.code(400).send({ error: 'parent task not found' });
      if (parent.groupPath.split('/').includes(id)) {
        return reply.code(400).send({ error: 'a task cannot be moved under its own descendant' });
      }
    }
    const task = await storage.updateTask(id, body);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    await storage.appendEvent({
      kind: 'task.edited',
      actor: 'human',
      taskId: id,
      repoId: task.repoId,
      data: { fields: Object.keys(body), ...(moving ? { groupId: task.groupId } : {}) },
    });
    broadcast({ type: 'task.updated', task });
    // A move re-groups the whole subtree; those rows changed too, so clients
    // that are not about to refresh still see the new grouping.
    if (moving) {
      for (const t of await storage.listTasks({ groupId: task.groupId })) {
        if (t.id !== task.id) broadcast({ type: 'task.updated', task: t });
      }
    }
    return task;
  });

  app.delete('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const cur = await storage.getTask(id);
    if (!cur) return reply.code(404).send({ error: 'task not found' });
    if (cur.status === 'running') {
      return reply.code(409).send({ error: 'cancel the running task before deleting it' });
    }
    // Children are promoted to roots of their own groups — capture them before
    // the delete so the re-grouped rows can be broadcast afterwards.
    const orphans = (await storage.listTasks({ parentId: id })).map((t) => t.id);
    await storage.deleteTask(id);
    fs.rmSync(path.join(artifactsRoot, id), { recursive: true, force: true });
    await storage.appendEvent({ kind: 'task.deleted', actor: 'human', taskId: id, data: { title: cur.title } });
    broadcast({ type: 'task.deleted', taskId: id });
    for (const orphanId of orphans) {
      const promoted = await storage.getTask(orphanId);
      if (!promoted) continue;
      for (const t of await storage.listTasks({ groupId: promoted.groupId })) {
        broadcast({ type: 'task.updated', task: t });
      }
    }
    // Deleting the last unresolved card of a phase must not strand its feature.
    if (cur.featureId) await app.orchestrator?.advanceFeature(cur.featureId, 'human');
    return { ok: true };
  });

  // blocked is deliberately NOT enqueueable: split parents leave blocked only
  // via child resolution or the explicit unblock action (design MAJOR-2).
  const enqueueFrom: TaskStatus[] = ['draft', 'failed', 'cancelled', 'review'];

  const enqueue = async (
    id: string,
    from: TaskStatus[],
  ): Promise<{ task: import('@tm/shared').Task } | { code: 404 | 409; error: string }> => {
    const cur = await storage.getTask(id);
    if (!cur) return { code: 404 as const, error: 'task not found' };
    if (!cur.repoId) return { code: 409 as const, error: 'assign a repo before running this task' };
    // Enqueue-from-review while the previous session is alive would make the
    // claim loop double-spawn into the repo (review R3b).
    if (await app.orchestrator?.hasLiveSession(id)) {
      return { code: 409 as const, error: 'previous session is still live — open its terminal or kill it first' };
    }
    const task = await storage.transitionTask(id, from, 'queued', 'human', { error: null });
    if (!task) return { code: 409 as const, error: `cannot enqueue from status '${cur.status}'` };
    broadcast({ type: 'task.updated', task });
    app.orchestrator?.maybeSchedule();
    return { task };
  };

  app.post('/api/tasks/:id/enqueue', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await enqueue(id, enqueueFrom);
    if ('error' in r) return reply.code(r.code).send({ error: r.error });
    return r.task;
  });

  app.post('/api/tasks/:id/retry', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await enqueue(id, ['failed', 'cancelled']);
    if ('error' in r) return reply.code(r.code).send({ error: r.error });
    return r.task;
  });

  app.post('/api/tasks/:id/unblock', async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await storage.transitionTask(id, ['blocked'], 'review', 'human', { error: null });
    if (!task) return reply.code(409).send({ error: 'task is not blocked' });
    broadcast({ type: 'task.updated', task });
    return task;
  });

  app.post('/api/tasks/:id/run-now', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!app.orchestrator) return reply.code(503).send({ error: 'orchestrator not ready' });
    const result = await app.orchestrator.runNow(id);
    if ('error' in result) return reply.code(result.code).send({ error: result.error });
    return result.task;
  });

  // review → done: the only sanctioned human "complete" transition (R13).
  // Completing also closes the task's idle terminal — done means done.
  app.post('/api/tasks/:id/complete', async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await storage.transitionTask(id, ['review'], 'done', 'human');
    if (!task) return reply.code(409).send({ error: 'task is not in review' });
    broadcast({ type: 'task.updated', task });
    await app.orchestrator?.closeTaskSessions(id);
    await app.orchestrator?.resolveCompletion(task); // done child may unblock a split parent
    return task;
  });

  // review → published: commit + push the work, in the agent's own session.
  // Whether it lands is decided by git afterwards, so a "successful" POST can
  // still answer 409 with what is still uncommitted/unpushed.
  app.post('/api/tasks/:id/publish', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!app.orchestrator) return reply.code(503).send({ error: 'orchestrator not ready' });
    const result = await app.orchestrator.publish(id);
    if ('error' in result) return reply.code(result.code).send({ error: result.error });
    return result.task;
  });

  // Follow-up: steer a live agent or respawn with the instruction (drawer field).
  app.post('/api/tasks/:id/follow-up', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ message: z.string().min(1).max(20_000) }).strict().parse(req.body);
    if (!app.orchestrator) return reply.code(503).send({ error: 'orchestrator not ready' });
    const result = await app.orchestrator.followUp(id, body.message);
    if ('error' in result) return reply.code(result.code).send({ error: result.error });
    return result.task;
  });

  // Proceed: continue the task's previous claude session instead of starting a
  // fresh agent — the recovery path for a worker whose terminal died mid-task
  // (usage limit, dropped connection, closed terminal). Optional message; the
  // default is a plain "carry on from where you left off".
  app.post('/api/tasks/:id/proceed', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ message: z.string().max(20_000).nullish() })
      .strict()
      .parse(req.body ?? {});
    if (!app.orchestrator) return reply.code(503).send({ error: 'orchestrator not ready' });
    const result = await app.orchestrator.proceed(id, body.message ?? null);
    if ('error' in result) return reply.code(result.code).send({ error: result.error });
    return result.task;
  });

  // Does this task have a claude session "proceed" could continue?
  app.get('/api/tasks/:id/resumable', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!app.orchestrator) return reply.code(503).send({ error: 'orchestrator not ready' });
    const sessionId = await app.orchestrator.resumableSessionId(id);
    return { resumable: sessionId !== null, sessionId };
  });

  // Deliverable files the agent saved to TM_ARTIFACTS_DIR for this task.
  const taskDir = (id: string) => path.join(artifactsRoot, id);
  const safeEntries = (id: string): { name: string; size: number; mtime: string }[] => {
    const dir = taskDir(id);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => {
        const st = fs.statSync(path.join(dir, d.name));
        return { name: d.name, size: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  };

  app.get('/api/tasks/:id/files', async (req) => {
    const { id } = req.params as { id: string };
    return safeEntries(id);
  });

  // Upload files INTO a task (drag-drop screenshots etc). They land in the same
  // per-task dir the agent reads/writes, so an uploaded image is an input the
  // worker can open. Filenames are sanitized to a basename; collisions get a
  // numeric suffix so nothing is overwritten.
  app.post('/api/tasks/:id/files', async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await storage.getTask(id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    const dir = taskDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const saved: string[] = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const base = path.basename(part.filename || 'upload').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'upload';
      let name = base;
      let n = 1;
      while (fs.existsSync(path.join(dir, name))) {
        const ext = path.extname(base);
        name = `${base.slice(0, base.length - ext.length)}-${n}${ext}`;
        n++;
      }
      await new Promise<void>((resolve, reject) => {
        const ws = fs.createWriteStream(path.join(dir, name));
        part.file.pipe(ws);
        part.file.on('limit', () => reject(new Error(`file too large: ${base}`)));
        ws.on('finish', () => resolve());
        ws.on('error', reject);
      }).catch((e) => {
        try {
          fs.rmSync(path.join(dir, name), { force: true });
        } catch {
          /* ignore */
        }
        throw e;
      });
      saved.push(name);
    }
    if (saved.length === 0) return reply.code(400).send({ error: 'no files in the upload' });
    await storage.appendEvent({
      kind: 'task.edited',
      actor: 'human',
      taskId: id,
      repoId: task.repoId,
      data: { fields: ['files'], uploaded: saved },
    });
    return { ok: true, saved };
  });

  app.delete('/api/tasks/:id/files/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const entry = safeEntries(id).find((f) => f.name === name);
    if (!entry) return reply.code(404).send({ error: 'file not found' });
    fs.rmSync(path.join(taskDir(id), entry.name), { force: true });
    return { ok: true };
  });

  app.get('/api/tasks/:id/files/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    // traversal-proof: the name must exactly match a real directory entry
    const entry = safeEntries(id).find((f) => f.name === name);
    if (!entry) return reply.code(404).send({ error: 'file not found' });
    const full = path.join(taskDir(id), entry.name);
    reply.header('content-disposition', `attachment; filename="${encodeURIComponent(entry.name)}"`);
    return reply.type('application/octet-stream').send(fs.createReadStream(full));
  });

  // Apply adversarial-review fixes to a completed task (old tasks that were
  // never reviewed, or reviewed but not fixed).
  app.post('/api/tasks/:id/apply-review', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!app.orchestrator) return reply.code(503).send({ error: 'orchestrator not ready' });
    const result = await app.orchestrator.applyReviewFixes(id);
    if ('error' in result) return reply.code(result.code).send({ error: result.error });
    return result.task;
  });

  // Explicit session stop without changing task status (kills live/idle PTYs).
  app.post('/api/tasks/:id/stop-agent', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!app.orchestrator) return reply.code(503).send({ error: 'orchestrator not ready' });
    const closed = await app.orchestrator.closeTaskSessions(id);
    if (closed === 0) return reply.code(409).send({ error: 'no live agent session for this task' });
    return { ok: true, closed };
  });

  // Dispatches (docs/dispatch.md): agent-to-agent messages between related
  // tasks. Read for the board/panel; the only human mutation is cancelling one
  // that has not been delivered yet.
  app.get('/api/dispatches', async (req) => {
    const q = req.query as { taskId?: string; status?: any };
    return storage.listDispatches({ taskId: q.taskId, status: q.status });
  });

  app.post('/api/dispatches/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const cancelled = await storage.settleDispatch(id, 'cancelled', 'cancelled by human');
    if (!cancelled) return reply.code(409).send({ error: 'dispatch is not pending' });
    broadcast({ type: 'dispatch.updated', dispatch: cancelled });
    await storage.appendEvent({
      kind: 'task.dispatch',
      actor: 'human',
      taskId: cancelled.toTaskId,
      data: { phase: 'cancelled', dispatchId: id, fromTaskId: cancelled.fromTaskId },
    });
    return cancelled;
  });

  app.post('/api/tasks/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    // Queued tasks can be de-queued without the orchestrator (R12).
    const dequeued = await storage.transitionTask(id, ['queued'], 'cancelled', 'human');
    if (dequeued) {
      broadcast({ type: 'task.updated', task: dequeued });
      await app.orchestrator?.resolveCompletion(dequeued); // cancelled child resolves its parent (F2)
      return dequeued;
    }
    if (!app.orchestrator) return reply.code(503).send({ error: 'orchestrator not ready' });
    const result = await app.orchestrator.cancel(id);
    if ('error' in result) return reply.code(result.code).send({ error: result.error });
    return result.task;
  });
}
