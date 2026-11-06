import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OFFICE_RATING_COMMENT_MAX, OFFICE_RATING_SUBJECT_KINDS, type OfficeRatingResult } from '@tm/shared';
import { rateOfficeSubject } from '../office/ratings.ts';
import type { Storage } from '../storage/types.ts';

// Stakeholder ratings (docs/office.md § Ratings). A rating speaks for the
// stakeholder (`human`) and writes the role's feedback file, so it must come
// from the dashboard: no Origin → 403 (a worker's or a shift's curl has none).
// Telegram rates in-process as `telegram`.

const rateBody = z
  .object({
    kind: z.enum(OFFICE_RATING_SUBJECT_KINDS),
    id: z.string().trim().min(1).max(100),
    value: z.union([z.literal(1), z.literal(-1)]),
    comment: z.string().max(OFFICE_RATING_COMMENT_MAX * 4).nullable().optional(),
  })
  .strict();

const listQuery = z
  .object({
    officeId: z.string().min(1).max(100).optional(),
    kind: z.enum(OFFICE_RATING_SUBJECT_KINDS).optional(),
    /** comma-separated subject ids */
    ids: z.string().max(20_000).optional(),
    limit: z.coerce.number().int().min(1).max(2000).optional(),
  })
  .strict();

export function registerOfficeRatingRoutes(app: FastifyInstance, storage: Storage): void {
  app.get('/api/office-ratings', async (req, reply) => {
    const q = listQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: `ratings: ${q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` });
    const ids = q.data.ids === undefined ? undefined : q.data.ids.split(',').map((s) => s.trim()).filter(Boolean);
    return storage.listOfficeRatings({ officeId: q.data.officeId, subjectKind: q.data.kind, subjectIds: ids, limit: q.data.limit });
  });

  app.post('/api/office-ratings', async (req, reply) => {
    if (!req.headers.origin) {
      return reply.code(403).send({ error: 'ratings are given from the dashboard or the phone, not from a script' });
    }
    const parsed = rateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: `rating: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` });
    }
    const r = await rateOfficeSubject(storage, parsed.data, 'human');
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    const out: OfficeRatingResult = { rating: r.rating, changed: r.changed };
    return out;
  });
}
