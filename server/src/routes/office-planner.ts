import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  OFFICE_AUTONOMY_LEVELS,
  OFFICE_PLANNER_GOALS,
  OFFICE_PLANNER_MESSAGE_MAX,
  OFFICE_PLANNER_WANTS_MAX,
  isValidTimeZone,
  type OfficeAutonomy,
  type OfficeBlueprint,
  type OfficeBlueprintDiff,
  type OfficePlannerApplyResult,
  type OfficePlannerGoal,
  type OfficePlannerView,
  type OfficePlannerWizard,
} from '@tm/shared';
import type { ChatService } from '../chat/service.ts';
import { broadcast } from '../events.ts';
import {
  applyBlueprint,
  applyPlannerDiff,
  blueprintSchema,
  checkPlannerDiff,
  diffSchema,
  officeFingerprint,
  wizardMessage,
  writePlannerLog,
} from '../office/planner.ts';
import { officeScheduler } from '../office/scheduler.ts';
import type { DirectorWaker } from '../office/docs.ts';
import type { Storage } from '../storage/types.ts';

// The office planner's API (docs/office.md § Office planner). Every write
// speaks for the OWNER — the planner's inputs are trusted because only the
// dashboard can reach them — so every write needs Origin (a worker's curl has
// none). Apply goes through the office routes' own writes (`officeWrites`);
// nothing here writes an office or a role row itself.

async function fromBrowser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.headers.origin) await reply.code(403).send({ error: 'the office planner is used from the dashboard' });
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const wizardBody = z
  .object({
    goals: z.array(z.enum(OFFICE_PLANNER_GOALS as [OfficePlannerGoal, ...OfficePlannerGoal[]])).max(OFFICE_PLANNER_GOALS.length),
    wants: z.string().max(OFFICE_PLANNER_WANTS_MAX),
    autonomy: z.enum(OFFICE_AUTONOMY_LEVELS as [OfficeAutonomy, ...OfficeAutonomy[]]),
    budget: z.object({ amountUsd: z.number().finite().gt(0, 'a budget above $0').max(100_000), per: z.enum(['day', 'month']) }).strict(),
    quietHours: z
      .object({ from: z.string().regex(HHMM, 'HH:MM'), to: z.string().regex(HHMM, 'HH:MM') })
      .strict()
      .refine((q) => q.from !== q.to, 'quiet hours need distinct from/to')
      .nullable(),
    timezone: z.string().trim().min(1).max(64).refine(isValidTimeZone, 'an IANA time zone like Europe/Berlin'),
  })
  .strict();
const planBody = z.object({ wizard: wizardBody }).strict();
const messageBody = z.object({ text: z.string().min(1).max(OFFICE_PLANNER_MESSAGE_MAX) }).strict();
const applyBody = z
  .object({
    blueprint: z.unknown(),
    folderPath: z.string().trim().min(1).max(1024).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    theme: z.string().min(1).max(64).optional(),
    messageId: z.string().min(1).max(100).optional(),
  })
  .strict();
const applyDiffBody = z
  .object({ diff: z.unknown(), baseFingerprint: z.string().regex(/^[0-9a-f]{64}$/), messageId: z.string().min(1).max(100).optional() })
  .strict();

const zodText = (e: z.ZodError) => e.issues.map((i) => `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`).join('; ');

export interface OfficePlannerRouteOptions {
  /** the Director waker a doc change goes through (default: the process-wide scheduler) */
  waker?: () => DirectorWaker | null;
}

export function registerOfficePlannerRoutes(app: FastifyInstance, storage: Storage, chats: ChatService, opts: OfficePlannerRouteOptions = {}) {
  const waker = opts.waker ?? (() => officeScheduler());

  const workspaceOr404 = async (req: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const ws = await storage.getWorkspace(workspaceId);
    if (!ws) {
      await reply.code(404).send({ error: 'workspace not found' });
      return null;
    }
    return ws;
  };

  /** Stamp the proposal's message applied (once) and tell the open views. */
  const markApplied = async (chatId: string | null, messageId: string | undefined) => {
    if (!messageId || !chatId) return;
    const m = await storage.getChatMessage(messageId);
    if (!m || m.chatId !== chatId) return;
    const stamped = await storage.markChatBlueprintApplied(messageId);
    if (stamped) broadcast({ type: 'chat.message', message: stamped });
  };

  app.get('/api/office-planner/:workspaceId', async (req, reply) => {
    const ws = await workspaceOr404(req, reply);
    if (!ws) return reply;
    const chat = await storage.getPlannerChat(ws.id);
    const office = await storage.getOfficeByWorkspace(ws.id);
    const view: OfficePlannerView = {
      workspaceId: ws.id,
      chat,
      messages: chat ? await storage.listChatMessages(chat.id) : [],
      office,
      fingerprint: office ? await officeFingerprint(storage, office) : null,
    };
    return view;
  });

  /** The wizard → the planning turn (202 on acceptance; the reply arrives as `chat.message`). */
  app.post('/api/office-planner/:workspaceId/plan', { preHandler: fromBrowser }, async (req, reply) => {
    const parsed = planBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: `wizard: ${zodText(parsed.error)}` });
    const ws = await workspaceOr404(req, reply);
    if (!ws) return reply;
    if (await storage.getOfficeByWorkspace(ws.id)) {
      return reply.code(409).send({ error: `workspace "${ws.name}" already has an office — ask its assistant instead` });
    }
    const opened = await chats.openPlanner(ws.id, 'human');
    if (!opened.ok) return reply.code(opened.code).send({ error: opened.error });
    const wizard: OfficePlannerWizard = parsed.data.wizard;
    const res = await chats.send(opened.value.id, wizardMessage(wizard), 'human', { wizard });
    if (!res.ok) {
      // A refused wizard turn (Pause all, the day fuse, the chat cap) must not
      // leave an empty planner chat behind: the SPA would read it as a
      // conversation in progress and drop the wizard. Nothing was said in it.
      if ((await storage.listChatMessages(opened.value.id)).length === 0) await chats.remove(opened.value.id, 'human').catch(() => {});
      return reply.code(res.code).send({ error: res.error });
    }
    return reply.code(202).send({ accepted: true, chat: res.value.chat, message: res.value.user });
  });

  /** A message to the assistant — before the office exists or after (202 on acceptance). */
  app.post('/api/office-planner/:workspaceId/messages', { preHandler: fromBrowser }, async (req, reply) => {
    const parsed = messageBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodText(parsed.error) });
    const ws = await workspaceOr404(req, reply);
    if (!ws) return reply;
    const opened = await chats.openPlanner(ws.id, 'human');
    if (!opened.ok) return reply.code(opened.code).send({ error: opened.error });
    const res = await chats.send(opened.value.id, parsed.data.text, 'human');
    if (!res.ok) return reply.code(res.code).send({ error: res.error });
    return reply.code(202).send({ accepted: true, chat: res.value.chat, message: res.value.user });
  });

  app.post('/api/office-planner/:workspaceId/stop', { preHandler: fromBrowser }, async (req, reply) => {
    const ws = await workspaceOr404(req, reply);
    if (!ws) return reply;
    const chat = await storage.getPlannerChat(ws.id);
    return { stopped: chat ? chats.stop(chat.id) : false };
  });

  /** Start over: the conversation goes (the office, if any, stays). */
  app.delete('/api/office-planner/:workspaceId', { preHandler: fromBrowser }, async (req, reply) => {
    const ws = await workspaceOr404(req, reply);
    if (!ws) return reply;
    const chat = await storage.getPlannerChat(ws.id);
    if (!chat) return { ok: true };
    const r = await chats.remove(chat.id, 'human');
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    return { ok: true };
  });

  /**
   * Apply a blueprint: a new DISABLED office with those roles, through the
   * office routes' own create/patch/role writes. Every field passes their
   * validators or nothing is created (400 with the validator's message).
   */
  app.post('/api/office-planner/:workspaceId/apply', { preHandler: fromBrowser }, async (req, reply) => {
    const parsed = applyBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodText(parsed.error) });
    const ws = await workspaceOr404(req, reply);
    if (!ws) return reply;
    if (await storage.getOfficeByWorkspace(ws.id)) return reply.code(409).send({ error: `workspace "${ws.name}" already has an office` });
    const bp = blueprintSchema.safeParse(parsed.data.blueprint);
    if (!bp.success) return reply.code(400).send({ error: `blueprint: ${zodText(bp.error)}` });
    const blueprint = bp.data as OfficeBlueprint;
    const { folderPath, timezone, theme, messageId } = parsed.data;
    const res = await applyBlueprint(
      { storage, waker: waker() },
      { workspaceId: ws.id, ...(folderPath ? { folderPath } : {}), ...(timezone ? { timezone } : {}), ...(theme ? { theme } : {}) },
      blueprint,
    );
    if (!res.ok) return reply.code(res.code).send({ error: res.error });
    const at = new Date().toISOString();
    writePlannerLog(res.office, { at, summary: blueprint.summary, applied: res.applied, blueprint });
    const chat = await storage.getPlannerChat(ws.id);
    await markApplied(chat?.id ?? null, messageId);
    await storage.appendEvent({
      kind: 'office.changed',
      actor: 'human',
      data: { action: 'planner-applied', kind: 'blueprint', officeId: res.office.id, workspaceId: ws.id, applied: res.applied, ...(messageId ? { messageId } : {}) },
    });
    const result: OfficePlannerApplyResult = { office: res.office, roles: res.roles, applied: res.applied, fingerprint: await officeFingerprint(storage, res.office) };
    return reply.code(201).send(result);
  });

  /**
   * Apply a blueprint diff to the existing office: exactly the listed fields
   * change. A diff planned against another state of the office (its
   * fingerprint moved) is refused with 409 — ask the assistant again.
   */
  app.post('/api/office-planner/:workspaceId/apply-diff', { preHandler: fromBrowser }, async (req, reply) => {
    const parsed = applyDiffBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodText(parsed.error) });
    const ws = await workspaceOr404(req, reply);
    if (!ws) return reply;
    const office = await storage.getOfficeByWorkspace(ws.id);
    if (!office) return reply.code(404).send({ error: `workspace "${ws.name}" has no office yet — apply a blueprint first` });
    const dp = diffSchema.safeParse(parsed.data.diff);
    if (!dp.success) return reply.code(400).send({ error: `diff: ${zodText(dp.error)}` });
    const diff = dp.data as OfficeBlueprintDiff;
    if ((await officeFingerprint(storage, office)) !== parsed.data.baseFingerprint) {
      return reply.code(409).send({ error: 'the office changed since the assistant proposed this — ask it again for a fresh diff' });
    }
    const roles = await storage.listOfficeRoles(office.id);
    const bad = checkPlannerDiff(diff, { office, roles });
    if (bad) return reply.code(400).send({ error: bad });
    const res = await applyPlannerDiff({ storage, waker: waker() }, office, diff);
    if (!res.ok) return reply.code(res.code).send({ error: res.error });
    const at = new Date().toISOString();
    writePlannerLog(res.office, { at, summary: diff.summary, applied: res.applied });
    const chat = await storage.getPlannerChat(ws.id);
    await markApplied(chat?.id ?? null, parsed.data.messageId);
    await storage.appendEvent({
      kind: 'office.changed',
      actor: 'human',
      data: { action: 'planner-applied', kind: 'diff', officeId: office.id, workspaceId: ws.id, applied: res.applied, ...(parsed.data.messageId ? { messageId: parsed.data.messageId } : {}) },
    });
    const result: OfficePlannerApplyResult = { office: res.office, roles: res.roles, applied: res.applied, fingerprint: await officeFingerprint(storage, res.office) };
    return result;
  });
}
