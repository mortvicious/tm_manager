import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Run, Task, TaskStatus } from '@tm/shared';
import { broadcast } from '../events.ts';
import type { Orchestrator } from '../orchestrator.ts';
import { spaceForRepo } from '../spaces/service.ts';
import type { Storage } from '../storage/types.ts';
import { MOVE_PLACES, moveTask } from '../task-actions.ts';

// Agent housekeeping on OTHER tasks (docs/agent-api-design.md § Close and
// move): close a parked task as done/cancelled, and group/reorder tasks the
// way the board's drag and drop does. Same token auth as the rest of
// /api/agent/* (the onRequest hook in agent.ts covers this prefix).

/** Closes per session — a hard stop like the creation cap, never retried. */
export const AGENT_CLOSE_RUN_CAP = 20;

// Parked statuses only. running/waiting have a live turn (the human cancels
// those); blocked is a split parent its children resolve; terminal is final.
const CLOSE_FROM: TaskStatus[] = ['draft', 'queued', 'failed', 'review'];

const closeBody = z
  .object({
    status: z.enum(['done', 'cancelled']),
    // Required: a task closed without a run must say why on the row and in the log.
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

const moveBody = z.object({ place: z.enum(MOVE_PLACES), targetId: z.string().min(1).nullish() }).strict();

/**
 * Why `target` is within this run's reach, or null. The same relationships
 * dispatch accepts (filed by me, filed me, my group) widened to the task
 * tree's natural owners: my repo and my shared space's repos — plus a task my
 * HUMAN-written brief names by id, which is how "mark d944970f done" in a
 * manual task authorises a worker in another repo.
 */
async function reachOf(storage: Storage, run: Run, own: Task | null, target: Task): Promise<string | null> {
  if (own && target.id === own.id) return 'own task';
  if (target.createdByRun === run.id) return 'filed by you';
  if (own) {
    if (target.groupId === own.groupId) return 'your group';
    if (target.createdByRun) {
      const creator = await storage.getRun(target.createdByRun);
      if (creator?.taskId === own.id) return 'filed by you';
    }
    if (own.createdByRun) {
      const myCreator = await storage.getRun(own.createdByRun);
      if (myCreator?.taskId === target.id) return 'filed your task';
    }
  }
  if (target.repoId && target.repoId === run.repoId) return 'your repo';
  if (target.repoId) {
    const space = await spaceForRepo(storage, run.repoId);
    if (space?.repoIds.includes(target.repoId)) return 'your shared space';
  }
  // Only a brief a person wrote: an agent-filed, feature-generated or Sentry
  // description is model/external text and must not widen anyone's reach.
  if (own?.description && own.source === 'manual' && !own.createdByRun && !own.featureId) {
    const short = target.id.slice(0, 8).toLowerCase();
    if (new RegExp(`(?<![0-9a-f])${short}(?![0-9a-f])`, 'i').test(own.description)) return 'named in your brief';
  }
  return null;
}

const OUT_OF_REACH =
  'not within your reach — you may touch tasks you filed, the task that filed yours, your group, your repo, your shared space, or a task your human-written brief names by id';

export function registerAgentTaskRoutes(
  app: FastifyInstance,
  storage: Storage,
  orchestrator: Orchestrator,
  authRun: (req: FastifyRequest) => Promise<Run | null>,
) {
  // Close a parked task without running it: `done` = already carried out
  // elsewhere, `cancelled` = replaced / not needed. Never a live turn.
  app.post('/api/agent/tasks/:id/close', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    const { id } = req.params as { id: string };
    const body = closeBody.parse(req.body);
    const own = run.taskId ? await storage.getTask(run.taskId) : null;
    const target = await storage.getTask(id);
    if (!target) return reply.code(404).send({ error: 'no task with that id — address it by its exact full id' });
    if (own && target.id === own.id) {
      return reply.code(400).send({ error: 'that is your own task — finish your turn instead; it lands on its own' });
    }
    const via = await reachOf(storage, run, own, target);
    if (!via) return reply.code(403).send({ error: OUT_OF_REACH });
    if (!CLOSE_FROM.includes(target.status)) {
      return reply.code(409).send({
        error: `cannot close a '${target.status}' task — only draft, queued, failed or review; a running task is the human's to cancel`,
      });
    }
    if (target.reviewState === 'pending' || target.reviewState === 'reviewing' || target.reviewState === 'fixing') {
      return reply.code(409).send({ error: 'its automatic review round is still open — leave it to land first' });
    }

    const actor = `agent:${run.id.slice(0, 8)}`;
    const closedByRun = (await storage.listEvents({ kind: 'agent.close', actor, limit: 2000 })).filter(
      (e) => e.runId === run.id,
    ).length;
    if (closedByRun >= AGENT_CLOSE_RUN_CAP) {
      return reply.code(403).send({
        error: `close cap (${AGENT_CLOSE_RUN_CAP}) reached for this session — stop closing tasks and list the rest in your summary`,
      });
    }

    // The reason goes on the row only when it carries no result of its own —
    // a reviewed task's summary is the record of real work and stays.
    const patch: { error?: null; resultSummary?: string } = {};
    if (body.status === 'done') patch.error = null;
    if (!target.resultSummary) {
      patch.resultSummary = `Closed as ${body.status} by an agent without a run: ${body.reason}`;
    }
    const task = await storage.transitionTask(id, [target.status], body.status, actor, patch);
    if (!task) return reply.code(409).send({ error: 'its status changed meanwhile — read it again before deciding' });
    broadcast({ type: 'task.updated', task });
    await storage.appendEvent({
      kind: 'agent.close',
      actor,
      taskId: task.id,
      runId: run.id,
      repoId: task.repoId,
      data: { from: target.status, to: body.status, reason: body.reason, via },
    });
    // An idle session left over from a review/failed turn has nothing more to do.
    await orchestrator.closeTaskSessions(task.id, actor);
    // A closed child may unblock its split parent / advance its feature — as
    // 'system', exactly like completeTask and cancelTask.
    await orchestrator.resolveCompletion(task);
    orchestrator.maybeSchedule();
    return { task: { id: task.id, status: task.status }, via };
  });

  // Group / reorder: the board's one-drop move (docs/grouping.md § Drag and
  // drop), with BOTH ends within reach.
  app.post('/api/agent/tasks/:id/move', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    const { id } = req.params as { id: string };
    const body = moveBody.parse(req.body);
    const own = run.taskId ? await storage.getTask(run.taskId) : null;
    const task = await storage.getTask(id);
    if (!task) return reply.code(404).send({ error: 'no task with that id — address it by its exact full id' });
    if (!(await reachOf(storage, run, own, task))) return reply.code(403).send({ error: OUT_OF_REACH });
    if (body.targetId) {
      const target = await storage.getTask(body.targetId);
      if (!target) return reply.code(400).send({ error: 'target task not found' });
      if (!(await reachOf(storage, run, own, target))) return reply.code(403).send({ error: `target ${OUT_OF_REACH}` });
      // The parent moveTask will resolve (its own place table). A blocked split
      // parent resolves only when its LAST child lands, so a draft an agent
      // hangs under it could hold it forever — the human board may, an agent
      // may not (its sanctioned path is linkToParent, which requires a run).
      const parentId =
        body.place === 'before' || body.place === 'after'
          ? target.parentId
          : body.place === 'into'
            ? (target.parentId ?? target.id)
            : body.place === 'child'
              ? target.id
              : body.place === 'group'
                ? target.groupId
                : null;
      if (parentId && parentId !== task.parentId) {
        const parent = parentId === target.id ? target : await storage.getTask(parentId);
        if (parent?.status === 'blocked') {
          return reply.code(409).send({
            error: 'that would put it under a blocked split parent, which waits on every child — agents may not add to one',
          });
        }
      }
    }
    const r = await moveTask({ storage, orchestrator }, id, body, `agent:${run.id.slice(0, 8)}`);
    if ('error' in r) return reply.code(r.code).send({ error: r.error });
    return {
      task: { id: r.task.id, parentId: r.task.parentId, groupId: r.task.groupId, groupPath: r.task.groupPath },
    };
  });
}
