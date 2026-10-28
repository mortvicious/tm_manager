import type { FastifyInstance, FastifyRequest } from 'fastify';
import { APPROVAL_WAIT_CAP_MS, type ApprovalService } from '../approvals.ts';
import type { Storage } from '../storage/types.ts';

// docs/approvals.md. Two sides, both thin — the rules live in ApprovalService,
// which the Telegram bot calls in-process too:
//  - the AGENT requests (`/api/agent/approvals`, run token) and polls its row;
//  - the HUMAN decides (`/api/approvals/:id/approve|reject`), browser only.
//    A worker knows $TM_CALLBACK_URL and could otherwise approve its own push;
//    browsers always send Origin on a POST, curl never does.

const STATUSES = ['pending', 'approved', 'running', 'done', 'failed', 'rejected', 'expired'] as const;

export function registerApprovalRoutes(app: FastifyInstance, storage: Storage, approvals: ApprovalService) {
  const authRun = async (req: FastifyRequest) => {
    const token = String(req.headers['x-tm-token'] ?? '');
    if (!token) return null;
    const run = await storage.getRunByToken(token);
    return run && run.status === 'running' ? run : null;
  };

  // ---- agent ----

  app.post('/api/agent/approvals', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'invalid or expired run token' });
    const r = await approvals.request(run, req.body);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    return reply.code(r.reused ? 200 : 201).send(r.approval);
  });

  app.get('/api/agent/approvals/:id', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'invalid or expired run token' });
    const { id } = req.params as { id: string };
    const { waitMs } = req.query as { waitMs?: string };
    const a = await approvals.wait(id, Math.min(Number(waitMs) || 0, APPROVAL_WAIT_CAP_MS));
    // an agent reads its own task's requests only
    if (!a || (a.taskId ?? null) !== (run.taskId ?? null)) return reply.code(404).send({ error: 'no such approval' });
    return a;
  });

  // ---- human ----

  app.get('/api/approvals', async (req) => {
    const q = req.query as { status?: string; taskId?: string };
    const status = STATUSES.find((s) => s === q.status);
    return approvals.list({ status, taskId: q.taskId || undefined });
  });

  app.get('/api/approvals/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = await approvals.get(id);
    if (!a) return reply.code(404).send({ error: 'no such approval' });
    return a;
  });

  for (const verb of ['approve', 'reject'] as const) {
    app.post(`/api/approvals/:id/${verb}`, async (req, reply) => {
      if (!req.headers.origin) {
        return reply.code(403).send({ error: 'approvals are decided from the browser or the phone, not from a script' });
      }
      const { id } = req.params as { id: string };
      const note = typeof (req.body as { note?: unknown } | undefined)?.note === 'string' ? (req.body as { note: string }).note : undefined;
      const r = await approvals.decide(id, verb === 'approve', 'human', note);
      if (!r.ok) return reply.code(r.code).send({ error: r.error });
      return r.approval;
    });
  }
}
