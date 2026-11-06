import type { FastifyInstance } from 'fastify';
import type { OfficeMetricWithPoints } from '@tm/shared';
import { broadcast } from '../events.ts';
import { checkMetricInput, createMetric, metricPatch, officeMetrics, withPoints } from '../office/metrics.ts';
import type { Storage } from '../storage/types.ts';

// Product metrics (docs/office.md § Product metrics). A metric makes the
// server run a saved command on a schedule and can wake a role, so every
// write needs Origin (a worker's or a shift's curl has none) — 403 otherwise.
// Reads are open like the rest of /api/offices.

const NO_ORIGIN = 'metrics are defined from the dashboard, not from a script';

export function registerOfficeMetricRoutes(app: FastifyInstance, storage: Storage): void {
  const audit = (officeId: string, workspaceId: string, data: Record<string, unknown>) =>
    storage.appendEvent({ kind: 'office.metric-changed', actor: 'human', data: { officeId, workspaceId, ...data } });

  app.get<{ Params: { id: string } }>('/api/offices/:id/metrics', async (req, reply) => {
    const office = await storage.getOffice(req.params.id);
    if (!office) return reply.code(404).send({ error: 'office not found' });
    const out: OfficeMetricWithPoints[] = [];
    for (const m of await storage.listOfficeMetrics({ officeId: office.id })) out.push(await withPoints(storage, m));
    return out;
  });

  app.post<{ Params: { id: string } }>('/api/offices/:id/metrics', async (req, reply) => {
    if (!req.headers.origin) return reply.code(403).send({ error: NO_ORIGIN });
    const office = await storage.getOffice(req.params.id);
    if (!office) return reply.code(404).send({ error: 'office not found' });
    const r = await createMetric(storage, office, req.body);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    await audit(office.id, office.workspaceId, { action: 'created', metricId: r.metric.id, name: r.metric.name, commandId: r.metric.commandId, roleId: r.metric.roleId });
    const full = await withPoints(storage, r.metric);
    broadcast({ type: 'office-metric.updated', metric: full });
    return reply.code(201).send(full);
  });

  app.patch<{ Params: { id: string; metricId: string } }>('/api/offices/:id/metrics/:metricId', async (req, reply) => {
    if (!req.headers.origin) return reply.code(403).send({ error: NO_ORIGIN });
    const office = await storage.getOffice(req.params.id);
    const prev = await storage.getOfficeMetric(req.params.metricId);
    if (!office || !prev || prev.officeId !== office.id) return reply.code(404).send({ error: 'metric not found in this office' });
    const checked = await checkMetricInput(storage, office, req.body, prev);
    if (!checked.ok) return reply.code(400).send({ error: checked.error });
    const patch = metricPatch(checked.value, prev);
    const next = Object.keys(patch).length ? await storage.updateOfficeMetric(prev.id, patch) : prev;
    if (!next) return reply.code(404).send({ error: 'metric not found in this office' });
    if (Object.keys(patch).length) await audit(office.id, office.workspaceId, { action: 'updated', metricId: prev.id, name: next.name, fields: Object.keys(patch) });
    const full = await withPoints(storage, next);
    broadcast({ type: 'office-metric.updated', metric: full });
    return full;
  });

  app.delete<{ Params: { id: string; metricId: string } }>('/api/offices/:id/metrics/:metricId', async (req, reply) => {
    if (!req.headers.origin) return reply.code(403).send({ error: NO_ORIGIN });
    const office = await storage.getOffice(req.params.id);
    const prev = await storage.getOfficeMetric(req.params.metricId);
    if (!office || !prev || prev.officeId !== office.id) return reply.code(404).send({ error: 'metric not found in this office' });
    await storage.deleteOfficeMetric(prev.id);
    await audit(office.id, office.workspaceId, { action: 'deleted', metricId: prev.id, name: prev.name });
    broadcast({ type: 'office-metric.deleted', officeId: office.id, metricId: prev.id });
    return { ok: true };
  });

  /** Run now: measure once, out of schedule (zero tokens); answers when the run is done (≤ 10 min). */
  app.post<{ Params: { id: string; metricId: string } }>('/api/offices/:id/metrics/:metricId/run', async (req, reply) => {
    if (!req.headers.origin) return reply.code(403).send({ error: NO_ORIGIN });
    const office = await storage.getOffice(req.params.id);
    const prev = await storage.getOfficeMetric(req.params.metricId);
    if (!office || !prev || prev.officeId !== office.id) return reply.code(404).send({ error: 'metric not found in this office' });
    const runner = officeMetrics();
    if (!runner) return reply.code(503).send({ error: 'the metric runner is not available' });
    const r = await runner.runNow(office.id, prev.id);
    if (!r.ran) return reply.code(r.code === 'gone' ? 404 : 409).send({ error: r.reason });
    return { metric: await withPoints(storage, r.metric), value: r.value, error: r.error, crossed: r.crossed };
  });
}
