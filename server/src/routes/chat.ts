import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CHAT_MODES, EFFORT_LEVELS } from '@tm/shared';
import type { ChatService } from '../chat/service.ts';

// docs/chat.md. Thin: every rule lives in ChatService, because the Telegram
// bot calls that service in-process and the two surfaces must not be able to
// disagree about what a chat is allowed to do.

const createSchema = z
  .object({
    repoId: z.string().min(1),
    title: z.string().max(200).optional(),
    model: z.string().min(1).optional(),
    effort: z.enum(EFFORT_LEVELS as [string, ...string[]]).nullable().optional(),
    mode: z.enum(CHAT_MODES as [string, ...string[]]).optional(),
  })
  .strict();

const patchSchema = z
  .object({
    title: z.string().max(200).optional(),
    model: z.string().min(1).optional(),
    effort: z.enum(EFFORT_LEVELS as [string, ...string[]]).nullable().optional(),
    mode: z.enum(CHAT_MODES as [string, ...string[]]).optional(),
  })
  .strict();

const messageSchema = z.object({ text: z.string().min(1).max(32_000) }).strict();

export function registerChatRoutes(app: FastifyInstance, chats: ChatService) {
  app.get('/api/chats', async (req) => {
    const q = req.query as { repoId?: string };
    return chats.list(q.repoId || undefined);
  });

  app.get('/api/chats/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const chat = await chats.get(id);
    if (!chat) return reply.code(404).send({ error: 'no such chat' });
    return { chat, messages: await chats.messages(id) };
  });

  app.post('/api/chats', async (req, reply) => {
    const body = createSchema.parse(req.body);
    const res = await chats.create(body as Parameters<ChatService['create']>[0], 'human');
    if (!res.ok) return reply.code(res.code).send({ error: res.error });
    return res.value;
  });

  app.patch('/api/chats/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = patchSchema.parse(req.body);
    const res = await chats.edit(id, body as Parameters<ChatService['edit']>[1], 'human');
    if (!res.ok) return reply.code(res.code).send({ error: res.error });
    return res.value;
  });

  app.delete('/api/chats/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const res = await chats.remove(id, 'human');
    if (!res.ok) return reply.code(res.code).send({ error: res.error });
    return { ok: true };
  });

  /**
   * Answers on ACCEPTANCE, not on the reply: a turn runs for tens of seconds
   * to minutes, which is longer than any sane HTTP timeout. `ChatService.send`
   * resolves once the lock is taken, so every refusal (`404` gone, `409`
   * already answering, `429` over the concurrency cap, `400` bad text) is a
   * real status code, and the reply itself arrives over `/ws/events` as the
   * same `chat.message` frame a turn started from the phone produces.
   */
  app.post('/api/chats/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text } = messageSchema.parse(req.body);
    const res = await chats.send(id, text, 'human');
    if (!res.ok) return reply.code(res.code).send({ error: res.error });
    return reply.code(202).send({ accepted: true, message: res.value.user });
  });

  app.post('/api/chats/:id/stop', async (req, reply) => {
    const { id } = req.params as { id: string };
    const chat = await chats.get(id);
    if (!chat) return reply.code(404).send({ error: 'no such chat' });
    return { stopped: chats.stop(id) };
  });
}
