import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MODEL_OPTIONS } from '@tm/shared';
import { broadcast } from '../events.ts';
import { resolveRange } from '../reports/range.ts';
import { abortReport, generateReport } from '../reports/service.ts';
import type { Storage } from '../storage/types.ts';

const createBody = z
  .object({
    /** Several repos is the point of the feature — at least one is required. */
    repoIds: z.array(z.string().min(1)).min(1),
    preset: z.enum(['today', '3d', 'week', 'month', 'custom']),
    /** the language the DOCUMENT is written in; the SPA stays English. */
    language: z.enum(['ru', 'en']).default('ru'),
    /** Only meaningful for `custom`; `YYYY-MM-DD`. */
    from: z.string().optional(),
    to: z.string().optional(),
    title: z.string().max(200).optional(),
    model: z.string().optional(),
  })
  .strict();

export function registerReportRoutes(app: FastifyInstance, storage: Storage) {
  app.get('/api/reports', async () => storage.listReports());

  app.get('/api/reports/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const report = await storage.getReport(id);
    if (!report) return reply.code(404).send({ error: 'report not found' });
    return report;
  });

  /**
   * Create and start writing. Answers **202 with the row**, like the chat send
   * route: the claude pass outlives any HTTP timeout, so the SPA follows the
   * report over `/ws/events` rather than holding a request open for it.
   */
  app.post('/api/reports', async (req, reply) => {
    const body = createBody.parse(req.body);

    const range = resolveRange(body.preset, body.from, body.to);
    if (!range.ok) return reply.code(400).send({ error: range.error });

    if (body.model && !MODEL_OPTIONS.includes(body.model)) {
      return reply.code(400).send({ error: `unknown model: ${body.model}` });
    }

    // Every id must exist. A silently-dropped repo would produce a document
    // that names fewer repos than the human selected without saying so.
    const all = await storage.listRepos();
    const repos = body.repoIds.map((id) => all.find((r) => r.id === id));
    const missing = body.repoIds.filter((_, i) => !repos[i]);
    if (missing.length > 0) return reply.code(404).send({ error: `repo not found: ${missing.join(', ')}` });

    // De-duplicate while keeping the human's order — the repo line prints in it.
    const repoIds = [...new Set(body.repoIds)];

    const title = body.title?.trim() || repos.map((r) => r!.name).join(' + ');
    const report = await storage.createReport(
      {
        title,
        repoIds,
        fromDate: range.range.fromDate,
        toDate: range.range.toDate,
        preset: body.preset,
        language: body.language,
        model: body.model ?? null,
      },
      'human',
    );
    broadcast({ type: 'report.updated', report });
    // Fired, not awaited (see above). Its own catch settles the row, so a
    // rejection here would be a second report of the same failure.
    void generateReport(storage, report.id);
    return reply.code(202).send(report);
  });

  /**
   * Re-run an existing report over the same repos and window. The previous
   * document is deliberately NOT cleared: if the re-run fails you keep the last
   * good version rather than being left with an error and nothing to hand over.
   */
  app.post('/api/reports/:id/regenerate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const report = await storage.getReport(id);
    if (!report) return reply.code(404).send({ error: 'report not found' });
    if (report.status === 'running' || report.status === 'pending') {
      return reply.code(409).send({ error: 'this report is already being written' });
    }
    const reset = await storage.updateReport(id, { status: 'pending', error: null });
    if (reset) broadcast({ type: 'report.updated', report: reset });
    void generateReport(storage, id);
    return reply.code(202).send(reset ?? report);
  });

  app.delete('/api/reports/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    // Stop the agent BEFORE the row goes, so the run cannot outlive what it
    // was writing into and keep burning tokens for a document nobody holds.
    abortReport(id);
    const ok = await storage.deleteReport(id);
    if (!ok) return reply.code(404).send({ error: 'report not found' });
    broadcast({ type: 'report.deleted', reportId: id });
    return { ok: true };
  });

  /** The document itself, as a downloadable file. */
  app.get('/api/reports/:id/markdown', async (req, reply) => {
    const { id } = req.params as { id: string };
    const report = await storage.getReport(id);
    if (!report) return reply.code(404).send({ error: 'report not found' });
    if (!report.markdown) return reply.code(409).send({ error: 'this report has no document yet' });
    // ASCII-only filename: the title is user text and may be Cyrillic, which
    // a bare `filename=` header cannot carry.
    const slug =
      report.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'report';
    const name = `${slug}-${report.fromDate}_${report.toDate}.md`;
    reply.header('content-disposition', `attachment; filename="${name}"`);
    return reply.type('text/markdown; charset=utf-8').send(report.markdown);
  });
}
