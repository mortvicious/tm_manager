import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OFFICE_PROPOSAL_NOTE_MAX, type OfficeProposalDecided, type OfficeProposalStatus } from '@tm/shared';
import type { OrchestratorApi } from '../app-types.ts';
import { acceptProposal, rejectProposal, type ProposalDecision } from '../office/proposals.ts';
import type { Storage } from '../storage/types.ts';

// Office proposals (docs/office.md § Proposals). A decision acts as `human`,
// so it must come from the dashboard: no Origin → 403 (a worker's or a
// shift's curl has none). Telegram decides in-process as `telegram`. First
// decision wins; the second gets 409.

const STATUSES: OfficeProposalStatus[] = ['pending', 'accepted', 'rejected'];

const acceptBody = z.object({ repoId: z.string().trim().min(1).max(100).optional() }).strict();
const rejectBody = z.object({ note: z.string().max(OFFICE_PROPOSAL_NOTE_MAX * 4).optional() }).strict();

export function registerOfficeProposalRoutes(
  app: FastifyInstance,
  storage: Storage,
  orchestrator: () => OrchestratorApi | undefined = () => undefined,
): void {
  app.get('/api/office-proposals', async (req, reply) => {
    const q = req.query as { status?: string; officeId?: string; limit?: string };
    if (q.status && !STATUSES.includes(q.status as OfficeProposalStatus)) return reply.code(400).send({ error: 'bad status' });
    return storage.listOfficeProposals({
      status: q.status as OfficeProposalStatus | undefined,
      officeId: q.officeId || undefined,
      limit: q.limit ? Number(q.limit) || undefined : undefined,
    });
  });

  app.get('/api/office-proposals/:id', async (req, reply) => {
    const p = await storage.getOfficeProposal((req.params as { id: string }).id);
    return p ?? reply.code(404).send({ error: 'no such proposal' });
  });

  const answer = (r: ProposalDecision): OfficeProposalDecided | { error: string } =>
    r.ok ? { proposal: r.proposal, task: r.task ?? null } : { error: r.error };

  for (const verb of ['accept', 'reject'] as const) {
    app.post(`/api/office-proposals/:id/${verb}`, async (req, reply) => {
      if (!req.headers.origin) {
        return reply.code(403).send({ error: 'proposals are decided from the dashboard or the phone, not from a script' });
      }
      const { id } = req.params as { id: string };
      const deps = { storage, orchestrator: orchestrator() };
      const r =
        verb === 'accept'
          ? await acceptProposal(deps, id, 'human', acceptBody.parse(req.body ?? {}))
          : await rejectProposal(deps, id, 'human', rejectBody.parse(req.body ?? {}).note);
      if (!r.ok) return reply.code(r.code).send({ error: r.error });
      return answer(r);
    });
  }
}
