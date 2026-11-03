import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Run, TaskStatus } from '@tm/shared';
import { dependencyCycle } from '@tm/shared';
import { broadcast } from '../events.ts';
import type { Orchestrator } from '../orchestrator.ts';
import type { Storage } from '../storage/types.ts';
import { DEPENDS_ON_EDITABLE, DEPENDS_ON_MAX, dependsOnRefusal, edgeIndex, waitRefusal, waitTargetStuck, WAIT_MAX_MS } from '../task-wait.ts';
import { OUT_OF_REACH, reachOf } from './agent-tasks.ts';

// Task waits and declared dependencies for worker agents (docs/task-waits.md):
//  - GET  /api/agent/tasks                 — the active tasks an agent may name
//  - POST /api/agent/wait                  — park my task until another settles
//  - DELETE /api/agent/wait                — withdraw that before ending the turn
//  - POST /api/agent/tasks/:id/depends-on  — a not-yet-started task waits for others
// Same `/api/agent` prefix, so agent.ts's token hook covers them.

const LIST_STATUSES: TaskStatus[] = ['draft', 'queued', 'running', 'waiting', 'review', 'blocked'];

const waitBody = z
  .object({
    task: z.string().min(1),
    // what you need from it — shown to the human and handed back at resume
    reason: z.string().trim().max(2000).nullish(),
  })
  .strict();

const dependsBody = z.object({ dependsOn: z.array(z.string().min(1)).max(DEPENDS_ON_MAX) }).strict();

export function registerAgentWaitRoutes(
  app: FastifyInstance,
  storage: Storage,
  orchestrator: Orchestrator,
  authRun: (req: FastifyRequest) => Promise<Run | null>,
): void {
  app.get('/api/agent/tasks', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    const q = z.object({ repo: z.string().min(1).optional() }).parse(req.query);
    const repos = await storage.listRepos();
    const repoName = new Map(repos.map((r) => [r.id, r.name]));
    const repoId = q.repo ? (repos.find((r) => r.id === q.repo || r.name.toLowerCase() === q.repo!.toLowerCase())?.id ?? null) : null;
    if (q.repo && !repoId) return reply.code(404).send({ error: `no repo matches "${q.repo}"` });
    const rows = (await storage.listTasks(repoId ? { repoId } : undefined))
      .filter((t) => LIST_STATUSES.includes(t.status) && t.id !== run.taskId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 200);
    return {
      tasks: rows.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        repo: t.repoId ? (repoName.get(t.repoId) ?? t.repoId) : null,
        brief: t.brief,
        featureId: t.featureId,
        featurePhase: t.featurePhase,
        groupId: t.groupId,
        branch: t.branch,
        dependsOn: t.dependsOn,
        waitFor: t.waitFor ? t.waitFor.taskId : null,
      })),
    };
  });

  app.post('/api/agent/wait', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    const body = waitBody.parse(req.body);
    const own = run.taskId ? await storage.getTask(run.taskId) : null;
    const target = await storage.getTask(body.task);
    const base = waitRefusal(own, target, { publishTurn: orchestrator.isPublishRun(run.id), cycle: false });
    if (base) return reply.code(base.code).send({ error: base.error });
    if (!(await reachOf(storage, run, own, target!))) return reply.code(403).send({ error: OUT_OF_REACH });
    const settings = await storage.getSettings();
    const feature = target!.featureId ? await storage.getFeature(target!.featureId) : null;
    const stuck = waitTargetStuck(own!, target!, {
      queueEnabled: settings['orchestrator.enabled'],
      targetFeatureStatus: feature?.status ?? null,
    });
    // LAST await: from the index read to requestWait below the code is
    // synchronous, so a concurrent request on the other side either sees this
    // one in pendingWaitEdges or is seen by it — never neither (review round 1)
    const byId = await edgeIndex(storage, () => orchestrator.pendingWaitEdges());
    const refusal = waitRefusal(own, target, {
      publishTurn: orchestrator.isPublishRun(run.id),
      cycle: dependencyCycle(own!.id, [target!.id], byId),
      stuck,
    });
    if (refusal) return reply.code(refusal.code).send({ error: refusal.error });
    const wait = {
      taskId: target!.id,
      title: target!.title,
      since: new Date().toISOString(),
      reason: body.reason?.trim() || null,
      runId: run.id,
    };
    orchestrator.requestWait(run.id, own!.id, wait);
    await storage.appendEvent({
      kind: 'task.wait',
      actor: `agent:${run.id.slice(0, 8)}`,
      runId: run.id,
      taskId: own!.id,
      repoId: own!.repoId,
      data: { phase: 'requested', on: target!.id, title: target!.title, status: target!.status, reason: wait.reason },
    });
    const inWorktree = !!own!.workdir;
    return {
      wait: { task: target!.id, title: target!.title, status: target!.status },
      note:
        `Recorded. ${inWorktree ? '' : 'Commit your work in progress now (with your Task trailer): other tasks may work in this checkout while you wait. '}` +
        `Then END YOUR TURN with a short note of where you stopped. Your task parks as blocked (no worker slot, no review) and this ` +
        `same session is resumed with instructions when "${target!.title}" lands, is cancelled, or after ${WAIT_MAX_MS / 3_600_000} h. ` +
        `Changed your mind before ending the turn? DELETE /api/agent/wait.`,
    };
  });

  app.delete('/api/agent/wait', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    const had = orchestrator.cancelWaitRequest(run.id);
    if (had && run.taskId) {
      await storage.appendEvent({
        kind: 'task.wait',
        actor: `agent:${run.id.slice(0, 8)}`,
        runId: run.id,
        taskId: run.taskId,
        repoId: run.repoId,
        data: { phase: 'withdrawn' },
      });
    }
    return { withdrawn: had };
  });

  app.post('/api/agent/tasks/:id/depends-on', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    const { id } = req.params as { id: string };
    const body = dependsBody.parse(req.body);
    const own = run.taskId ? await storage.getTask(run.taskId) : null;
    const target = await storage.getTask(id);
    if (!target) return reply.code(404).send({ error: 'task not found' });
    if (own && target.id === own.id) {
      return reply.code(400).send({ error: 'your own task is already running — to wait for another task use POST /api/agent/wait' });
    }
    if (!(await reachOf(storage, run, own, target))) return reply.code(403).send({ error: OUT_OF_REACH });
    if (!DEPENDS_ON_EDITABLE.includes(target.status)) {
      return reply.code(409).send({ error: `dependencies apply before a task starts — "${target.title}" is ${target.status}` });
    }
    const refusal = dependsOnRefusal(target.id, body.dependsOn, await edgeIndex(storage, () => orchestrator.pendingWaitEdges()));
    if (refusal) return reply.code(400).send({ error: refusal });
    const task = await storage.setTaskDependsOn(target.id, body.dependsOn, `agent:${run.id.slice(0, 8)}`);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    broadcast({ type: 'task.updated', task });
    orchestrator.maybeSchedule(); // an emptied list may make it claimable
    return { task: { id: task.id, status: task.status, dependsOn: task.dependsOn } };
  });
}
