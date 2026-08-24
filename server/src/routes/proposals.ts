import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { startAnalysis } from '../claude/analyze.ts';
import { broadcast } from '../events.ts';
import type { Storage } from '../storage/types.ts';

const analyzeBody = z
  .object({
    repoId: z.string().min(1),
    taskIds: z.array(z.string()).optional(),
  })
  .strict();

export function registerProposalRoutes(app: FastifyInstance, storage: Storage) {
  app.post('/api/analyze', async (req, reply) => {
    const body = analyzeBody.parse(req.body);
    const repo = await storage.getRepo(body.repoId);
    if (!repo) return reply.code(404).send({ error: 'repo not found' });

    // One analyze per repo at a time — a double-click must not burn two
    // headless sessions (final review F4).
    const live = await storage.listRuns({ mode: 'analyze', status: 'running' });
    if (live.some((r) => r.repoId === repo.id)) {
      return reply.code(409).send({ error: 'an analysis is already running for this repo' });
    }

    // Analyzable set: open tasks of this repo (or the explicit selection).
    let tasks = (await storage.listTasks({ repoId: repo.id })).filter((t) =>
      ['draft', 'queued', 'review', 'blocked', 'failed'].includes(t.status),
    );
    if (body.taskIds?.length) {
      const wanted = new Set(body.taskIds);
      tasks = tasks.filter((t) => wanted.has(t.id));
      // An explicit selection that matches nothing analyzable would silently
      // waste a run (all non-new_task proposals get dropped) — refuse (M4).
      if (tasks.length === 0) {
        return reply.code(409).send({ error: 'selected tasks are not analyzable (done/cancelled/running)' });
      }
    }
    return startAnalysis({ storage }, repo, tasks);
  });

  app.get('/api/proposals', async (req) => {
    const q = req.query as { status?: any; taskId?: string; repoId?: string };
    return storage.listProposals({ status: q.status, taskId: q.taskId, repoId: q.repoId });
  });

  app.post('/api/proposals/:id/accept', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { chosenOptionIndex?: number };
    const result = await storage.acceptProposal(
      id,
      'human',
      typeof body.chosenOptionIndex === 'number' ? body.chosenOptionIndex : undefined,
    );
    if (!result) return reply.code(409).send({ error: 'proposal not found or not pending' });
    for (const task of result.tasks) broadcast({ type: 'task.updated', task });
    broadcast({ type: 'proposal.created', proposal: result.proposal }); // upserted client-side
    // split-accept queues children — wake the scheduler
    app.orchestrator?.maybeSchedule();
    return result;
  });

  app.post('/api/proposals/:id/reject', async (req, reply) => {
    const { id } = req.params as { id: string };
    const proposal = await storage.rejectProposal(id);
    if (!proposal) return reply.code(404).send({ error: 'proposal not found' });
    if (proposal.status !== 'rejected') {
      // WHERE status='pending' no-oped — it was already accepted/rejected (M3)
      return reply.code(409).send({ error: `proposal is already ${proposal.status}` });
    }
    await storage.appendEvent({
      kind: 'proposal.decided',
      actor: 'human',
      taskId: proposal.taskId,
      repoId: proposal.repoId,
      data: { proposalId: id, kind: proposal.kind, decision: 'rejected' },
    });
    broadcast({ type: 'proposal.created', proposal });
    return proposal;
  });
}
