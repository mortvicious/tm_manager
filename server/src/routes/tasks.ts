import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import type { TaskStatus } from '@tm/shared';
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
  })
  .strict();

const taskPatch = taskBody.partial().strict();

export function registerTaskRoutes(app: FastifyInstance, storage: Storage) {
  app.get('/api/tasks', async (req) => {
    const q = req.query as { status?: any; repoId?: string; parentId?: string };
    return storage.listTasks({ status: q.status, repoId: q.repoId, parentId: q.parentId });
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
    const task = await storage.updateTask(id, body);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    await storage.appendEvent({
      kind: 'task.edited',
      actor: 'human',
      taskId: id,
      repoId: task.repoId,
      data: { fields: Object.keys(body) },
    });
    broadcast({ type: 'task.updated', task });
    return task;
  });

  app.delete('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const cur = await storage.getTask(id);
    if (!cur) return reply.code(404).send({ error: 'task not found' });
    if (cur.status === 'running') {
      return reply.code(409).send({ error: 'cancel the running task before deleting it' });
    }
    await storage.deleteTask(id);
    fs.rmSync(path.join(artifactsRoot, id), { recursive: true, force: true });
    await storage.appendEvent({ kind: 'task.deleted', actor: 'human', taskId: id, data: { title: cur.title } });
    broadcast({ type: 'task.deleted', taskId: id });
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
    await app.orchestrator?.resolveParent(task); // done child may unblock a split parent
    return task;
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

  app.post('/api/tasks/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    // Queued tasks can be de-queued without the orchestrator (R12).
    const dequeued = await storage.transitionTask(id, ['queued'], 'cancelled', 'human');
    if (dequeued) {
      broadcast({ type: 'task.updated', task: dequeued });
      await app.orchestrator?.resolveParent(dequeued); // cancelled child resolves its parent (F2)
      return dequeued;
    }
    if (!app.orchestrator) return reply.code(503).send({ error: 'orchestrator not ready' });
    const result = await app.orchestrator.cancel(id);
    if ('error' in result) return reply.code(result.code).send({ error: result.error });
    return result.task;
  });
}
