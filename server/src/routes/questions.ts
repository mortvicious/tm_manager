import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { QuestionService } from '../questions.ts';

// docs/questions.md — the human side. Thin: the rules live in QuestionService,
// which the Telegram bot calls in-process, so the two surfaces cannot disagree
// about what answering a question means.

const answerSchema = z
  .object({
    /** keyed by the question text; one entry per question */
    answers: z.record(z.string(), z.string().min(1).max(4000)),
  })
  .strict();

export function registerQuestionRoutes(app: FastifyInstance, questions: QuestionService) {
  app.get('/api/questions', async (req) => {
    const q = req.query as { status?: string; taskId?: string };
    const status = q.status === 'pending' || q.status === 'answered' || q.status === 'expired' ? q.status : undefined;
    return questions.list({ status, taskId: q.taskId || undefined });
  });

  app.get('/api/questions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = await questions.get(id);
    if (!q) return reply.code(404).send({ error: 'no such question' });
    return q;
  });

  app.post('/api/questions/:id/answer', async (req, reply) => {
    const { id } = req.params as { id: string };
    // The decision is the human's, not the agent's: a worker knows
    // $TM_CALLBACK_URL and could curl its own question shut, audited as
    // `human`. Browsers always send Origin on a POST (the SPA is the only
    // caller here — Telegram answers in-process), curl never does.
    if (!req.headers.origin) {
      return reply.code(403).send({ error: 'answers come from the browser or the phone, not from a script' });
    }
    const body = answerSchema.parse(req.body);
    const r = await questions.answer(id, body.answers, 'human');
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    return r.question;
  });
}
