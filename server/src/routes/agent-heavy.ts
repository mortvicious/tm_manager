import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { HeavyTicket, Run } from '@tm/shared';
import { HEAVY_AGENT_KINDS, HEAVY_TICKET_STALE_MS } from '@tm/shared';
import { heavy, type HeavySlots } from '../heavy.ts';
import { memoryHold } from '../memory.ts';

// Heavy work leases for worker agents (docs/memory.md § Heavy work):
//  - POST /api/agent/heavy/acquire          — ask for a slot; long-polls up to waitMs
//  - GET  /api/agent/heavy/:id?waitMs=       — keep waiting / read the lease
//  - POST /api/agent/heavy/:id/release       — done; returns the pressure report
// Same `/api/agent` prefix, so agent.ts's token hook covers them. A run holds
// at most ONE ticket (a second acquire returns the first), and every ticket of
// a run is released when its turn ends or its process exits.

/** Longest single long-poll: under every curl/proxy default, well under the stale rule. */
export const HEAVY_WAIT_MAX_MS = 55_000;
const DEFAULT_WAIT_MS = 50_000;

const acquireBody = z
  .object({
    kind: z.enum(HEAVY_AGENT_KINDS),
    why: z.string().trim().min(1).max(200),
    waitMs: z.number().int().min(0).max(HEAVY_WAIT_MAX_MS).optional(),
  })
  .strict();

function waitOf(q: unknown): number {
  const n = Number((q as { waitMs?: string } | undefined)?.waitMs);
  return Number.isFinite(n) ? Math.max(0, Math.min(HEAVY_WAIT_MAX_MS, Math.floor(n))) : 0;
}

/** The answer to every poll: granted (with pressure so far) or waiting (with place and cause). */
function view(slots: HeavySlots, t: HeavyTicket, reused = false) {
  const s = slots.status();
  if (t.grantedAt) {
    return {
      status: 'granted' as const,
      leaseId: t.id,
      kind: t.kind,
      grantedAt: t.grantedAt,
      slots: { max: s.max, held: s.held.length, waiting: s.waiting.length },
      pressure: slots.pressure(t.id),
      ...(reused ? { reused: true } : {}),
      next: `POST /api/agent/heavy/${t.id}/release when the heavy run is over (the turn's end releases it too)`,
    };
  }
  const position = slots.position(t.id);
  const hold = t.waitingOn === 'memory' ? memoryHold() : null;
  return {
    status: 'waiting' as const,
    leaseId: t.id,
    kind: t.kind,
    position,
    waitingOn: t.waitingOn,
    reason:
      t.waitingOn === 'memory'
        ? `${hold ?? 'memory pressure'}`
        : `all ${s.max} heavy slot${s.max === 1 ? ' is' : 's are'} in use (${s.held.map((h) => `${h.kind}: ${h.label}`).join('; ')})`,
    slots: { max: s.max, held: s.held.length, waiting: s.waiting.length },
    ...(reused ? { reused: true } : {}),
    next: `GET /api/agent/heavy/${t.id}?waitMs=${DEFAULT_WAIT_MS} — poll again within ${Math.round(HEAVY_TICKET_STALE_MS / 1000)} s or the place is given up`,
  };
}

export function registerAgentHeavyRoutes(app: FastifyInstance, authRun: (req: FastifyRequest) => Promise<Run | null>): void {
  const owned = (slots: HeavySlots, id: string, run: Run): HeavyTicket | null => {
    const t = slots.get(id);
    if (!t) return null;
    // the task's own sessions only (a resumed turn is a new run of the same task)
    return t.runId === run.id || (t.taskId != null && t.taskId === run.taskId) ? t : null;
  };

  app.post('/api/agent/heavy/acquire', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    if (run.mode === 'aux' || !run.taskId) return reply.code(409).send({ error: 'heavy leases are for worker turns' });
    const slots = heavy();
    if (!slots) return reply.code(503).send({ error: 'heavy slots are not running' });
    const body = acquireBody.parse(req.body ?? {});
    const existing = slots.forRun(run.id)[0];
    const ticket =
      existing ??
      slots.acquire({
        kind: body.kind,
        taskId: run.taskId,
        runId: run.id,
        repoId: run.repoId,
        label: body.why,
        actor: `agent:${run.id.slice(0, 8)}`,
        gateOnMemory: true,
        polled: true,
      });
    await slots.wait(ticket.id, body.waitMs ?? DEFAULT_WAIT_MS, true);
    const now = slots.get(ticket.id);
    if (!now) return reply.code(410).send({ status: 'gone', error: 'the request was dropped (turn ended or server stopping) — acquire again' });
    return view(slots, now, !!existing);
  });

  app.get('/api/agent/heavy/:id', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    const slots = heavy();
    const { id } = req.params as { id: string };
    if (!slots || !owned(slots, id, run)) {
      return reply.code(404).send({ status: 'gone', error: 'no such lease of yours (released, dropped as stale, or the turn ended) — acquire again' });
    }
    await slots.wait(id, waitOf(req.query), true);
    const now = slots.get(id);
    if (!now) return reply.code(410).send({ status: 'gone', error: 'the request was dropped — acquire again' });
    return view(slots, now);
  });

  app.post('/api/agent/heavy/:id/release', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    const slots = heavy();
    const { id } = req.params as { id: string };
    if (!slots || !owned(slots, id, run)) return reply.code(404).send({ status: 'gone', error: 'no such lease of yours (already released?)' });
    const out = slots.release(id, 'released');
    if (!out) return reply.code(404).send({ status: 'gone', error: 'already released' });
    return {
      status: 'released' as const,
      leaseId: id,
      waitedMs: out.waitedMs,
      heldMs: out.heldMs,
      // null when it was released before a slot was granted
      pressure: out.pressure,
      advice: out.pressure?.underPressure
        ? `The machine was under pressure during this lease (${out.pressure.reasons.join('; ')}): treat timings/scores measured under it as noisy and re-measure under a fresh lease before trusting them.`
        : out.pressure
          ? 'The machine was not under pressure during this lease: its measurements are fair.'
          : 'Released before a slot was granted.',
    };
  });
}
