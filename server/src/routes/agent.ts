import type { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AppSettings, Run } from '@tm/shared';
import { DEFAULT_SETTINGS } from '@tm/shared';
import { serverRoot } from '../config.ts';
import { broadcast } from '../events.ts';
import { onEvent } from '../events.ts';
import type { Storage } from '../storage/types.ts';
import type { Orchestrator } from '../orchestrator.ts';

// Agent-facing API (docs/agent-api-design.md, review-hardened R1–R11).
// Auth: the per-run token from the worker's env. The token IS the identity —
// caps and attribution key off the authenticated run, never a client-sent id.
//
// Honesty note (design review): these caps are cooperative guardrails for
// steered-but-honest agents. A malicious process with a shell on this host was
// never containable; the guards exist so that the DOCUMENTED path an injected
// agent follows always lands in front of a human.

const createBody = z
  .object({
    title: z.string().min(1).max(300),
    description: z.string().max(20_000).nullish(),
    repo: z.string().min(1),
    enqueue: z.boolean().optional(),
    linkToParent: z.boolean().optional(),
    category: z.string().min(1).max(60).optional(),
    review: z.boolean().optional(),
  })
  .strict();

const QUEUED_AGENT_CEILING = 10;

// Dispatch caps (docs/dispatch.md). Per-run bounds one turn's chatter; the
// per-pair cap bounds A⇄B ping-pong across resumed turns (each resume is a NEW
// run, so a per-run cap alone would never terminate an echo loop).
const DISPATCH_RUN_CAP = 5;
const DISPATCH_PAIR_CAP = 8;

const dispatchBody = z
  .object({
    task: z.string().min(1),
    message: z.string().min(1).max(20_000),
  })
  .strict();

/** Per-run creation cap: `agent.taskCreationCap`, sanitised (a hand-edited or
 *  legacy config row must not disable the guard or make it unreachable). */
function perRunCap(settings: AppSettings): number {
  const raw = settings['agent.taskCreationCap'] as unknown;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SETTINGS['agent.taskCreationCap'];
  return Math.min(100, Math.max(1, Math.floor(raw)));
}

export function registerAgentRoutes(app: FastifyInstance, storage: Storage, orchestrator: Orchestrator) {
  const authRun = async (req: FastifyRequest): Promise<Run | null> => {
    const token = String(req.headers['x-tm-token'] ?? '');
    if (!token) return null;
    const run = await storage.getRunByToken(token);
    // Idle sessions may still file/read (the human is chatting in them);
    // exited runs may not.
    return run && run.status === 'running' ? run : null;
  };

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/agent/')) return;
    if (!(await authRun(req))) return reply.code(403).send({ error: 'forbidden' });
  });

  app.get('/api/agent/context', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    const repos = await storage.listRepos();
    const task = run.taskId ? await storage.getTask(run.taskId) : null;
    const repo = run.repoId ? await storage.getRepo(run.repoId) : null;
    const cap = perRunCap(await storage.getSettings());
    const filed = await storage.countTasksCreatedByRun(run.id);
    const dispatched = await storage.countDispatchesByRun(run.id);
    // the task whose session filed THIS task — the natural dispatch-back address
    const creatorRun = task?.createdByRun ? await storage.getRun(task.createdByRun) : null;
    return {
      taskId: run.taskId,
      repoId: run.repoId,
      repoRole: repo?.role ?? null,
      spawnDepth: task?.spawnDepth ?? 0,
      taskCreationCap: cap,
      tasksCreated: filed,
      tasksRemaining: Math.max(0, cap - filed),
      dispatchCap: DISPATCH_RUN_CAP,
      dispatchesSent: dispatched,
      dispatchesRemaining: Math.max(0, DISPATCH_RUN_CAP - dispatched),
      filedByTaskId: creatorRun?.taskId ?? null,
      repos: repos.map((r) => ({ id: r.id, name: r.name, role: r.role })),
    };
  });

  // The sheet is static markdown with one live value: the current cap. Keeping
  // the placeholder server-side means the doc can never drift from the setting.
  app.get('/api/agent/instructions', async (_req, reply) => {
    const p = path.resolve(serverRoot, '../docs/agent-instructions.md');
    if (!fs.existsSync(p)) return reply.code(404).send({ error: 'instructions not found' });
    const cap = perRunCap(await storage.getSettings());
    const md = fs.readFileSync(p, 'utf8').replaceAll('{{taskCreationCap}}', String(cap));
    return reply.type('text/markdown').send(md);
  });

  app.post('/api/agent/tasks', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    const body = createBody.parse(req.body);
    const callerTask = run.taskId ? await storage.getTask(run.taskId) : null;

    // Depth cap (R4): agents two hops from human intent may not create more.
    const depth = (callerTask?.spawnDepth ?? 0) + 1;
    if (depth > 2) {
      return reply
        .code(403)
        .send({ error: 'depth limit: this task is already 2 hops from a human — do not create tasks; finish your turn' });
    }

    // Per-run cap (R8-adjacent): hard stop, do not retry.
    const settings = await storage.getSettings();
    const cap = perRunCap(settings);
    if ((await storage.countTasksCreatedByRun(run.id)) >= cap) {
      return reply
        .code(403)
        .send({ error: `task creation cap (${cap}) reached for this session — stop creating tasks and finish your turn` });
    }

    // Repo resolution: id → exact name → unique role (case-insensitive
    // equality, never substring). Ambiguity → 400 with candidates.
    const repos = await storage.listRepos();
    const needle = body.repo.trim().toLowerCase();
    let target = repos.find((r) => r.id === body.repo);
    if (!target) target = repos.find((r) => r.name.toLowerCase() === needle);
    if (!target) {
      const byRole = repos.filter((r) => (r.role ?? '').toLowerCase() === needle);
      if (byRole.length > 1) {
        return reply.code(400).send({
          error: `role "${body.repo}" is ambiguous — use a repo id`,
          candidates: byRole.map((r) => ({ id: r.id, name: r.name })),
        });
      }
      target = byRole[0];
    }
    if (!target) {
      return reply.code(404).send({
        error: `no repo matches "${body.repo}" — GET /api/agent/context lists repos`,
      });
    }

    // Enqueue gating (R6): needs the explicit opt-in setting AND the queue on;
    // same-repo creations are ALWAYS drafts (two agents must not edit one
    // working tree); global ceiling degrades to draft (R8), never a retry-bait 4xx.
    let status: 'draft' | 'queued' = 'draft';
    let note: string | null = null;
    if (body.enqueue) {
      if (!settings['agent.allowEnqueue']) {
        note = 'enqueue disabled (agent.allowEnqueue is off) — created as draft for human review';
      } else if (!settings['orchestrator.enabled']) {
        note = 'queue is stopped — created as draft';
      } else if (target.id === run.repoId) {
        note = 'same-repo follow-ups are always drafts (no concurrent edits to one working tree)';
      } else if ((await storage.countQueuedAgentTasks()) >= QUEUED_AGENT_CEILING) {
        note = `agent queue ceiling (${QUEUED_AGENT_CEILING}) reached — created as draft`;
      } else {
        status = 'queued';
      }
    }

    // linkToParent (R2): only for split-children adding a sibling under a
    // parent that is genuinely blocked, and only when the sibling will run.
    let parentId: string | null = null;
    if (body.linkToParent) {
      const resolvedParentId = callerTask?.parentId ?? callerTask?.id ?? null;
      const parent = resolvedParentId ? await storage.getTask(resolvedParentId) : null;
      if (!parent || parent.status !== 'blocked') {
        return reply
          .code(400)
          .send({ error: 'linkToParent requires a currently-blocked parent (split siblings only) — omit it' });
      }
      if (status !== 'queued') {
        return reply
          .code(400)
          .send({ error: `linkToParent requires enqueue to be honored (${note ?? 'enqueue not requested'}) — omit it` });
      }
      parentId = parent.id;
    }

    const actor = `agent:${run.id.slice(0, 8)}`;
    const task = await storage.createTask(
      {
        title: body.title,
        description: body.description ?? null,
        repoId: target.id,
        parentId,
        status,
        source: 'auto',
        category: body.category ?? null,
        review: body.review ?? null,
        createdByRun: run.id,
        spawnDepth: depth,
        // priority deliberately not settable (R11): agent tasks are always 0
      },
      actor,
    );
    await storage.appendEvent({
      kind: 'agent.create',
      actor,
      taskId: task.id,
      runId: run.id,
      repoId: target.id,
      data: { requestedEnqueue: !!body.enqueue, effectiveStatus: status, note },
    });
    broadcast({ type: 'task.updated', task });
    if (status === 'queued') orchestrator.maybeSchedule(); // R9
    return { task: { id: task.id, status: task.status, repo: target.name }, note };
  });

  // Categorize: agents invent and fill domain labels ("UI", "Estimator").
  // Allowed for the run's OWN task and tasks it created; metadata only —
  // never overwrites a human-set category with a different one silently
  // (last write wins, but every change is audited).
  app.post('/api/agent/tasks/:id/category', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    const { id } = req.params as { id: string };
    const body = z.object({ category: z.string().min(1).max(60) }).strict().parse(req.body);
    const task = await storage.getTask(id);
    if (!task || (task.id !== run.taskId && task.createdByRun !== run.id)) {
      return reply.code(404).send({ error: 'not found' });
    }
    const updated = await storage.updateTask(id, { category: body.category });
    if (!updated) return reply.code(404).send({ error: 'not found' });
    await storage.appendEvent({
      kind: 'task.edited',
      actor: `agent:${run.id.slice(0, 8)}`,
      taskId: id,
      repoId: updated.repoId,
      data: { fields: ['category'], category: body.category },
    });
    broadcast({ type: 'task.updated', task: updated });
    return { ok: true, category: updated.category };
  });

  // Dispatch (docs/dispatch.md): hand a message to a RELATED task's existing
  // agent session instead of creating a new task. Delivery reopens that task's
  // own claude session (`--resume`) — a pending dispatch just means the target
  // is busy and will get it when its session is free.
  app.post('/api/agent/dispatch', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    const body = dispatchBody.parse(req.body);
    const callerTask = run.taskId ? await storage.getTask(run.taskId) : null;
    if (!callerTask) {
      return reply.code(400).send({ error: 'this session has no task — only task workers can dispatch' });
    }
    const target = await storage.getTask(body.task);
    if (!target) {
      return reply.code(404).send({ error: 'no task with that id — dispatch targets are addressed by exact task id' });
    }
    if (target.id === callerTask.id) {
      return reply.code(400).send({ error: 'that is your own task — do the work in this session instead' });
    }

    // Relationship gate: dispatch reaches only sessions this task is already
    // coordinating with — tasks it filed (any of its runs), the task that
    // filed it, or its own task tree. Everything else needs a human.
    let related = target.createdByRun === run.id || target.groupId === callerTask.groupId;
    if (!related && target.createdByRun) {
      const targetCreator = await storage.getRun(target.createdByRun);
      related = targetCreator?.taskId === callerTask.id;
    }
    if (!related && callerTask.createdByRun) {
      const myCreator = await storage.getRun(callerTask.createdByRun);
      related = myCreator?.taskId === target.id;
    }
    if (!related) {
      return reply.code(403).send({
        error:
          'not a related task — you may dispatch only to tasks you created, the task that created yours, or tasks in your own group; file a task instead',
      });
    }

    // Caps: hard stops, do not retry.
    if ((await storage.countDispatchesByRun(run.id)) >= DISPATCH_RUN_CAP) {
      return reply.code(403).send({
        error: `dispatch cap (${DISPATCH_RUN_CAP}) reached for this session — stop dispatching and finish your turn`,
      });
    }
    if ((await storage.countDispatchesBetween(callerTask.id, target.id)) >= DISPATCH_PAIR_CAP) {
      return reply.code(403).send({
        error: `dispatch cap (${DISPATCH_PAIR_CAP}) between these two tasks reached — finish your turn and leave the rest to the human`,
      });
    }

    const actor = `agent:${run.id.slice(0, 8)}`;
    const dispatch = await storage.createDispatch({
      fromTaskId: callerTask.id,
      fromRunId: run.id,
      toTaskId: target.id,
      message: body.message,
    });
    broadcast({ type: 'dispatch.updated', dispatch });
    await storage.appendEvent({
      kind: 'task.dispatch',
      actor,
      taskId: target.id,
      runId: run.id,
      repoId: target.repoId,
      data: { phase: 'created', dispatchId: dispatch.id, fromTaskId: callerTask.id, chars: body.message.length },
    });
    // Immediate attempt (delivers right away when the target session is free —
    // even with the queue stopped); otherwise it stays pending and the
    // orchestrator retries on its ticks.
    await orchestrator.deliverDispatches();
    const fresh = (await storage.getDispatch(dispatch.id)) ?? dispatch;
    return {
      dispatch: { id: fresh.id, toTask: target.id, status: fresh.status },
      note:
        fresh.status === 'delivered'
          ? 'delivered — the target session has been resumed with your message'
          : fresh.status === 'pending'
            ? 'queued — the target session is busy; it is delivered automatically when that agent is free. Do not wait for it: note it in your summary and finish your turn.'
            : fresh.note,
    };
  });

  // Poll a dispatch this run sent.
  app.get('/api/agent/dispatches/:id', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    const { id } = req.params as { id: string };
    const d = await storage.getDispatch(id);
    if (!d || d.fromRunId !== run.id) return reply.code(404).send({ error: 'not found' });
    return { id: d.id, status: d.status, note: d.note, deliveredAt: d.deliveredAt };
  });

  // Read-only sibling context: the feature this run's task belongs to. Agents
  // do NOT create or mutate features in v1 (that is the autonomy doc's intake
  // question) — this exists so a worker can see the phases around it.
  app.get('/api/agent/features/:id', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    const { id } = req.params as { id: string };
    const own = run.taskId ? await storage.getTask(run.taskId) : null;
    if (!own?.featureId || own.featureId !== id) {
      return reply.code(404).send({ error: 'not found — you may only read the feature your task belongs to' });
    }
    const feature = await storage.getFeature(id);
    if (!feature) return reply.code(404).send({ error: 'not found' });
    const tasks = await storage.listTasks({ featureId: id });
    return {
      id: feature.id,
      title: feature.title,
      request: feature.request,
      status: feature.status,
      summary: feature.analysis?.summary ?? null,
      considerations: feature.analysis?.considerations ?? [],
      yourPhase: own.featurePhase,
      phases: (feature.analysis?.phases ?? []).map((p, i) => ({ index: i, title: p.title, goal: p.goal })),
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        phase: t.featurePhase,
        status: t.status,
        isYours: t.id === own.id,
      })),
    };
  });

  // Poll a task this run created (R7) — optional long-poll via waitMs.
  app.get('/api/agent/tasks/:id', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    const { id } = req.params as { id: string };
    const { waitMs } = req.query as { waitMs?: string };
    let task = await storage.getTask(id);
    if (!task || task.createdByRun !== run.id) return reply.code(404).send({ error: 'not found' });

    const terminal = () => ['review', 'published', 'done', 'failed', 'cancelled'].includes(task!.status);
    const wait = Math.min(Number(waitMs) || 0, 60_000);
    if (wait > 0 && !terminal()) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          off();
          resolve();
        }, wait);
        const off = onEvent((e) => {
          if (e.type === 'task.updated' && e.task.id === id) {
            task = e.task;
            if (terminal()) {
              clearTimeout(timer);
              off();
              resolve();
            }
          }
        });
      });
    }
    return {
      id: task.id,
      status: task.status,
      resultSummary: task.resultSummary,
      error: task.error,
    };
  });
}
