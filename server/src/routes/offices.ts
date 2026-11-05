import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CONCURRENCY_MAX,
  EFFORT_LEVELS,
  MODEL_OPTIONS,
  OFFICE_AUTONOMY_LEVELS,
  OFFICE_DETAIL_SHIFTS,
  OFFICE_EVENT_NAMES,
  OFFICE_GUARD_KINDS,
  OFFICE_HUMAN_PAUSE_REASON,
  OFFICE_ROLE_COMMANDS_MAX,
  OFFICE_ROLE_KEY_MAX,
  OFFICE_ROLE_KEY_RE,
  OFFICE_ROLE_PRESETS,
  SHIFT_WEB_TOOLS,
  cronError,
  guardError,
  isValidTimeZone,
  OFFICE_MAX_OPEN_TASKS_MAX,
  OFFICE_MAX_TASKS_PER_SHIFT_MAX,
  OFFICE_WAKE_NOTE_MAX,
  roleRearms,
  shiftToolsRefusal,
  type Office,
  type OfficeAutonomy,
  type OfficeCreateResult,
  type OfficeDetail,
  type OfficeEventName,
  type OfficeGuard,
  type OfficeRole,
  type OfficeRoleFields,
  type OfficeNotesReview,
  type OfficeRoleWriteResult,
  type OfficeTrigger,
  OFFICE_DOC_MAX_CHARS,
  OFFICE_WISH_TEXT_MAX,
  isOfficeEditableDoc,
  isOfficeReadableDoc,
  type OfficeDocPutResult,
  type OfficeWishCreateResult,
} from '@tm/shared';
import { broadcast } from '../events.ts';
import { archiveRoleNotes, defaultOfficeFolder, resetRoleNotes, scaffoldOfficeFolder, validateOfficeFolder } from '../office/folder.ts';
import { DEFAULT_OFFICE_THEME, OFFICE_THEMES, generateOfficeIdentities, generateRoleIdentity } from '../office/names.ts';
import { allowlistCheck } from '../office/commands.ts';
import { briefView, markBriefReviewed } from '../office/briefs.ts';
import { untrustedPath } from '../office/isolation.ts';
import { readOfficeText } from '../office/shift.ts';
import { OfficeDocConflict, OfficeWishRefused, createOfficeWish, readOfficeDoc, saveOfficeDoc } from '../office/docs.ts';
import { SHIFT_NOTES_MAX_CHARS, officeRel, roleNotesRel, writeOfficeFile } from '../office/shift-result.ts';
import { roleFromPreset } from '../office/presets.ts';
import { officeScheduler, officeStates, type OfficeScheduler } from '../office/scheduler.ts';
import type { NewOfficeRole, OfficePatch, OfficeRolePatch } from '../storage/office-sql.ts';
import type { Storage } from '../storage/types.ts';
import { isUniqueViolation } from '../storage/workspace-sql.ts';

// Virtual Office REST API (docs/office.md § API). Offices are created from the
// presets and start DISABLED; enabling needs a day budget. Every write acts as
// `human`, so every write needs Origin (a worker's curl has none — the
// shared-spaces rule), leaves an `office.changed` row and broadcasts
// `office.updated`. Nothing here is secret, so nothing is stripped.

/** Every write here acts as `human`: it must come from the dashboard. */
async function fromBrowser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.headers.origin) {
    await reply.code(403).send({ error: 'office edits come from the dashboard' });
  }
}

const money = z.number().finite().min(0).max(100_000);
const theme = z.enum(OFFICE_THEMES as [string, ...string[]]);
const timezone = z.string().trim().min(1).max(64);
const folderPath = z.string().trim().min(1).max(1024);

const createBody = z
  .object({ workspaceId: z.string().min(1), folderPath: folderPath.optional(), theme: theme.optional(), timezone: timezone.optional() })
  .strict();

const officePatchBody = z
  .object({
    folderPath: folderPath.optional(),
    autonomy: z.enum(OFFICE_AUTONOMY_LEVELS as [OfficeAutonomy, ...OfficeAutonomy[]]).optional(),
    dayBudgetUsd: money.optional(),
    maxSlots: z.number().int().min(1).max(CONCURRENCY_MAX).optional(),
    maxTasksPerShift: z.number().int().min(1).max(OFFICE_MAX_TASKS_PER_SHIFT_MAX).optional(),
    maxOpenTasks: z.number().int().min(1).max(OFFICE_MAX_OPEN_TASKS_MAX).optional(),
    theme: theme.optional(),
    timezone: timezone.optional(),
    enabled: z.boolean().optional(),
    paused: z.boolean().optional(),
  })
  .strict();

/**
 * The SHAPE of a role's fields. Content rules (cron parses, guards and
 * triggers well-formed, tools allowed, model offered) are `roleFieldsError`,
 * so a refusal reads as a sentence rather than a zod path.
 */
const roleFields = {
  name: z.string().trim().min(1).max(80),
  avatar: z.string().trim().min(1).max(16),
  title: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(20_000),
  model: z.string().min(1),
  effort: z.enum(EFFORT_LEVELS as [string, ...string[]]).nullable(),
  tools: z.array(z.string()).max(20),
  autonomy: z.enum(OFFICE_AUTONOMY_LEVELS as [OfficeAutonomy, ...OfficeAutonomy[]]).nullable(),
  capUsd: money.nullable(),
  schedules: z.array(z.string()).max(10),
  triggers: z.array(z.unknown()).max(10),
  guards: z.array(z.unknown()).max(10),
  enabled: z.boolean(),
};
const roleFieldsPartial = z.object(roleFields).partial();
const roleCreateBody = roleFieldsPartial
  .extend({
    key: z.string().trim().min(1).max(OFFICE_ROLE_KEY_MAX).optional(),
    preset: z.enum(OFFICE_ROLE_PRESETS as [string, ...string[]]).nullable().optional(),
  })
  .strict();
const rolePatchBody = roleFieldsPartial.strict();
const wishBody = z.object({ text: z.string().trim().min(1, 'a wish needs some text').max(OFFICE_WISH_TEXT_MAX) }).strict();
const wishPatchBody = z
  .object({
    text: z.string().trim().min(1).max(OFFICE_WISH_TEXT_MAX).optional(),
    status: z.enum(['open', 'planned', 'done', 'dropped']).optional(),
  })
  .strict()
  .refine((b) => b.text !== undefined || b.status !== undefined, 'nothing to change: send text or status');
const docPutBody = z
  .object({
    content: z.string().max(OFFICE_DOC_MAX_CHARS, `at most ${OFFICE_DOC_MAX_CHARS} characters`),
    baseSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict();
const wakeBody = z.object({ note: z.string().max(OFFICE_WAKE_NOTE_MAX).optional() }).strict();
type RoleInput = z.infer<typeof roleFieldsPartial>;

/** `PUT …/roles/:roleId/commands`: the whole allowlist (docs/office.md § Command runs). */
/** `POST …/notes-reviewed`: the version the human read, as GET …/notes-review showed it. */
const notesReviewedBody = z
  .object({ notesTaintedAt: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable() })
  .strict();

/** `POST /api/office-briefs/:id/reviewed`: the version the human read (docs/office.md § Briefings). */
const briefReviewedBody = z.object({ taintedAt: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const briefListQuery = z.object({
  roleId: z.string().min(1).optional(),
  kind: z.enum(['brief', 'standup']).optional(),
  unreviewed: z.enum(['1', 'true']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const roleCommandsBody = z
  .object({
    commands: z
      .array(z.object({ commandId: z.string().trim().min(1).max(200), external: z.boolean() }).strict())
      .max(OFFICE_ROLE_COMMANDS_MAX),
  })
  .strict();

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A guard rebuilt from known fields only, or why it is malformed. */
export function parseGuard(raw: unknown, i: number): { guard: OfficeGuard } | { error: string } {
  const at = `guards[${i}]`;
  if (!raw || typeof raw !== 'object') return { error: `${at}: a guard is an object with a "kind"` };
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  if (typeof kind !== 'string' || !OFFICE_GUARD_KINDS.includes(kind as OfficeGuard['kind'])) {
    return { error: `${at}: unknown guard kind ${JSON.stringify(kind)} (one of: ${OFFICE_GUARD_KINDS.join(', ')})` };
  }
  let g: OfficeGuard;
  switch (kind as OfficeGuard['kind']) {
    case 'open-bugs-below':
      g = { kind: 'open-bugs-below', n: r.n as number };
      break;
    case 'budget-left':
      g = r.minUsd === undefined ? { kind: 'budget-left' } : { kind: 'budget-left', minUsd: r.minUsd as number };
      break;
    case 'quiet-hours':
      g = { kind: 'quiet-hours', from: r.from as string, to: r.to as string };
      if (typeof g.from !== 'string' || typeof g.to !== 'string' || !HHMM.test(g.from) || !HHMM.test(g.to)) {
        return { error: `${at}: quiet-hours needs from/to as distinct HH:MM` };
      }
      break;
    case 'cooldown':
      g = { kind: 'cooldown', minutes: r.minutes as number };
      break;
    case 'briefs-since':
      g = r.orTasksLanded === undefined ? { kind: 'briefs-since' } : { kind: 'briefs-since', orTasksLanded: r.orTasksLanded as boolean };
      break;
    default:
      g = { kind } as OfficeGuard;
  }
  // `guardError` reads numbers with Number.isFinite/isInteger, so a string "5" is refused there
  const bad = guardError(g);
  return bad ? { error: `${at}: ${bad}` } : { guard: g };
}

/** A trigger rebuilt from known fields only, or why it is malformed. */
export function parseTrigger(raw: unknown, i: number): { trigger: OfficeTrigger } | { error: string } {
  const at = `triggers[${i}]`;
  if (!raw || typeof raw !== 'object') return { error: `${at}: a trigger is an object with a "kind"` };
  const r = raw as Record<string, unknown>;
  if (r.kind === 'event') {
    if (typeof r.event !== 'string' || !OFFICE_EVENT_NAMES.includes(r.event as never)) {
      return { error: `${at}: unknown event ${JSON.stringify(r.event)} (one of: ${OFFICE_EVENT_NAMES.join(', ')})` };
    }
    if (r.repoId !== undefined && r.repoId !== null && (typeof r.repoId !== 'string' || !r.repoId)) {
      return { error: `${at}: repoId must be a repo id or null` };
    }
    return { trigger: { kind: 'event', event: r.event as OfficeEventName, ...(r.repoId !== undefined ? { repoId: r.repoId as string | null } : {}) } };
  }
  if (r.kind === 'signal') {
    if (typeof r.source !== 'string' || !r.source.trim() || r.source.length > 100) {
      return { error: `${at}: a signal trigger needs a source name (1–100 characters)` };
    }
    return { trigger: { kind: 'signal', source: r.source.trim() } };
  }
  if (r.kind === 'command-done') return { trigger: { kind: 'command-done' } };
  return { error: `${at}: unknown trigger kind ${JSON.stringify(r.kind)} (event, signal or command-done)` };
}

/**
 * Validate and normalise the content of role fields (in place on a copy):
 * cron, guards, triggers, tools, model. The first refusal wins.
 */
export function checkRoleFields(input: RoleInput): { fields: Partial<OfficeRoleFields> } | { error: string } {
  const out: Partial<OfficeRoleFields> = { ...(input as Partial<OfficeRoleFields>) };
  if (input.model !== undefined && !MODEL_OPTIONS.includes(input.model)) {
    return { error: `model "${input.model}" is not offered (one of: ${MODEL_OPTIONS.join(', ')})` };
  }
  if (input.tools !== undefined) {
    const tools = [...new Set(input.tools)];
    const bad = shiftToolsRefusal(tools);
    if (bad) return { error: bad };
    out.tools = tools;
  }
  if (input.schedules !== undefined) {
    const schedules = input.schedules.map((s) => s.trim());
    for (const s of schedules) {
      const bad = cronError(s);
      if (bad) return { error: `schedule "${s}": ${bad}` };
    }
    out.schedules = [...new Set(schedules)];
  }
  if (input.guards !== undefined) {
    const guards: OfficeGuard[] = [];
    for (const [i, g] of input.guards.entries()) {
      const p = parseGuard(g, i);
      if ('error' in p) return p;
      guards.push(p.guard);
    }
    out.guards = guards;
  }
  if (input.triggers !== undefined) {
    const triggers: OfficeTrigger[] = [];
    for (const [i, t] of input.triggers.entries()) {
      const p = parseTrigger(t, i);
      if ('error' in p) return p;
      triggers.push(p.trigger);
    }
    out.triggers = triggers;
  }
  return { fields: out };
}

const taintingOf = (role: Pick<OfficeRole, 'tools'>): string[] => role.tools.filter((t) => SHIFT_WEB_TOOLS.includes(t));

function roleResult(role: OfficeRole): OfficeRoleWriteResult {
  const taintingTools = taintingOf(role);
  return taintingTools.length
    ? {
        role,
        taintingTools,
        warning: `${taintingTools.join(' and ')} read the open internet: every shift of this role that uses ${taintingTools.length > 1 ? 'one' : 'it'} is tainted (drafts only, digest-only to later shifts).`,
      }
    : { role, taintingTools };
}

const AUTONOMY_RANK: Record<OfficeAutonomy, number> = { proposals: 0, 'auto-run': 1, autonomous: 2 };

export interface OfficeRouteOptions {
  /** Wake now's scheduler (default: the process-wide one, `initOfficeScheduler`) */
  scheduler?: () => Pick<OfficeScheduler, 'wake'> | null;
}

export function registerOfficeRoutes(app: FastifyInstance, storage: Storage, opts: OfficeRouteOptions = {}) {
  const audit = (data: Record<string, unknown>) => storage.appendEvent({ kind: 'office.changed', actor: 'human', data });
  const scheduler = opts.scheduler ?? officeScheduler;

  /** The role states after an edit (docs/office.md § Scheduler and states); best effort — the row is the truth. */
  const statesOf = async (office: Office) => (await officeStates(storage, office.id).catch(() => null)) ?? undefined;

  const announce = async (office: Office, withRoles = false): Promise<OfficeRole[] | undefined> => {
    if (!withRoles) {
      broadcast({ type: 'office.updated', office, states: await statesOf(office) });
      return undefined;
    }
    const roles = await storage.listOfficeRoles(office.id);
    broadcast({ type: 'office.updated', office, roles, states: await statesOf(office) });
    return roles;
  };

  /** Re-scaffold after a role change (new role file, README's role list). Best effort: the row is the truth. */
  const rescaffold = async (office: Office) => {
    try {
      scaffoldOfficeFolder(office, await storage.listOfficeRoles(office.id), { repos: await storage.listRepos() });
    } catch (e) {
      console.warn(`office ${office.id}: folder scaffold failed:`, (e as Error).message);
    }
  };

  /** Another office already using this folder (two offices must not share notes). */
  const folderTakenBy = async (p: string, selfId: string | null) =>
    (await storage.listOffices()).find((o) => o.id !== selfId && o.folderPath === p) ?? null;

  app.get('/api/offices', async () => storage.listOffices());

  app.get('/api/offices/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const office = await storage.getOffice(id);
    if (!office) return reply.code(404).send({ error: 'office not found' });
    const detail: OfficeDetail = {
      office,
      roles: await storage.listOfficeRoles(id),
      shifts: await storage.listShifts({ officeId: id, limit: OFFICE_DETAIL_SHIFTS }),
    };
    return detail;
  });

  // Briefings (docs/office.md § Briefings): the list is rows only (newest
  // first); one brief's text comes from its file through GET /api/office-briefs/:id.
  app.get('/api/offices/:id/briefs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = briefListQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: `briefs: ${q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` });
    if (!(await storage.getOffice(id))) return reply.code(404).send({ error: 'office not found' });
    return storage.listBriefs({ officeId: id, roleId: q.data.roleId, kind: q.data.kind, unreviewed: !!q.data.unreviewed, limit: q.data.limit ?? 100 });
  });

  app.get('/api/office-briefs/:briefId', async (req, reply) => {
    const { briefId } = req.params as { briefId: string };
    const brief = await storage.getBrief(briefId);
    if (!brief) return reply.code(404).send({ error: 'brief not found' });
    const v = await briefView(storage, brief);
    if (!v) return reply.code(404).send({ error: 'office not found' });
    return v.view;
  });

  // Mark reviewed on a TAINTED brief: the file leaves the untrusted storage,
  // `tainted_at` clears, `office.taint-cleared` is audited — only for the
  // version the human read (its `taintedAt` + the file's sha256, else 409).
  app.post('/api/office-briefs/:briefId/reviewed', { preHandler: fromBrowser }, async (req, reply) => {
    const parsed = briefReviewedBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: `reviewed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` });
    }
    const { briefId } = req.params as { briefId: string };
    const r = await markBriefReviewed(storage, briefId, parsed.data, 'human');
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r.brief;
  });

  app.get('/api/offices/:id/states', async (req, reply) => {
    const { id } = req.params as { id: string };
    const states = await officeStates(storage, id);
    if (!states) return reply.code(404).send({ error: 'office not found' });
    return states;
  });

  app.post('/api/offices', { preHandler: fromBrowser }, async (req, reply) => {
    const body = createBody.parse(req.body);
    const ws = await storage.getWorkspace(body.workspaceId);
    if (!ws) return reply.code(400).send({ error: `unknown workspace id: ${body.workspaceId}` });
    if (await storage.getOfficeByWorkspace(ws.id)) {
      return reply.code(409).send({ error: `workspace "${ws.name}" already has an office` });
    }
    const tz = body.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!isValidTimeZone(tz)) return reply.code(400).send({ error: `unknown time zone "${tz}" (an IANA name like Europe/Berlin)` });

    const repos = await storage.listRepos();
    let folder: string;
    if (body.folderPath !== undefined) {
      const v = validateOfficeFolder(body.folderPath, repos);
      if ('error' in v) return reply.code(400).send({ error: `folderPath: ${v.error}` });
      folder = v.path;
    } else {
      const d = defaultOfficeFolder(ws, await storage.listSpaces(), repos);
      if (!d) {
        return reply
          .code(400)
          .send({ error: `the repos of "${ws.name}" do not share one shared space, so there is no default folder: pick one (folderPath)` });
      }
      if ('error' in d) return reply.code(400).send({ error: `default folder: ${d.error}` });
      folder = d.path;
    }
    const taken = await folderTakenBy(folder, null);
    if (taken) return reply.code(409).send({ error: `folder ${folder} is already the folder of another office` });

    let office: Office;
    try {
      office = await storage.createOffice({
        workspaceId: ws.id,
        folderPath: folder,
        timezone: tz,
        theme: body.theme ?? DEFAULT_OFFICE_THEME,
        enabled: false,
      });
    } catch (e) {
      if (isUniqueViolation(e)) return reply.code(409).send({ error: `workspace "${ws.name}" already has an office` });
      throw e;
    }

    let roles: OfficeRole[] = [];
    let scaffold;
    const archived: string[] = [];
    try {
      const ids = generateOfficeIdentities(
        office.id,
        OFFICE_ROLE_PRESETS.map((p) => roleFromPreset(p).key),
        office.theme,
      );
      for (const preset of OFFICE_ROLE_PRESETS) {
        const draft = roleFromPreset(preset);
        const who = ids[draft.key]!;
        roles.push(
          await storage.createOfficeRole({
            ...draft,
            officeId: office.id,
            name: who.name,
            avatar: who.avatar,
            notesPath: `roles/${draft.key}.md`,
          }),
        );
      }
      // notes already in the folder are not these roles' (§ API → Notes of a new role)
      for (const r of roles) {
        const moved = archiveRoleNotes(office, r.key);
        if (moved) archived.push(moved);
      }
      scaffold = scaffoldOfficeFolder(office, roles, { repos });
    } catch (e) {
      // all or nothing: an office whose folder could not be laid out is not created
      await storage.deleteOffice(office.id).catch(() => {});
      return reply.code(400).send({ error: `could not create the office: ${(e as Error).message}` });
    }

    await audit({
      action: 'created',
      officeId: office.id,
      workspaceId: ws.id,
      folderPath: office.folderPath,
      theme: office.theme,
      timezone: office.timezone,
      roles: roles.map((r) => ({ id: r.id, key: r.key, name: r.name })),
      ...(archived.length ? { archivedNotes: archived } : {}),
    });
    await announce(office, true);
    const result: OfficeCreateResult = { office, roles, scaffold: { created: scaffold.created, kept: scaffold.kept, archived } };
    return reply.code(201).send(result);
  });

  app.patch('/api/offices/:id', { preHandler: fromBrowser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = officePatchBody.parse(req.body);
    const cur = await storage.getOffice(id);
    if (!cur) return reply.code(404).send({ error: 'office not found' });

    const enabled = body.enabled ?? cur.enabled;
    const budget = body.dayBudgetUsd ?? cur.dayBudgetUsd;
    if (enabled && !(budget > 0)) {
      return reply.code(409).send({
        error: body.enabled
          ? 'set a day budget above $0 (dayBudgetUsd) before enabling the office'
          : 'an enabled office needs a day budget above $0: disable it first',
      });
    }
    if (body.timezone !== undefined && !isValidTimeZone(body.timezone)) {
      return reply.code(400).send({ error: `unknown time zone "${body.timezone}" (an IANA name like Europe/Berlin)` });
    }

    const { paused, ...rest } = body;
    const patch: OfficePatch = { ...rest };
    const archivedNotes: string[] = [];
    if (body.folderPath !== undefined) {
      const repos = await storage.listRepos();
      const v = validateOfficeFolder(body.folderPath, repos);
      if ('error' in v) return reply.code(400).send({ error: `folderPath: ${v.error}` });
      if (v.path !== cur.folderPath) {
        if (await folderTakenBy(v.path, id)) return reply.code(409).send({ error: `folder ${v.path} is already the folder of another office` });
        try {
          const roles = await storage.listOfficeRoles(id);
          // the new folder's notes are not these roles' (§ API → Notes of a new role)
          for (const r of roles) {
            const moved = archiveRoleNotes({ folderPath: v.path }, r.key);
            if (moved) archivedNotes.push(moved);
          }
          scaffoldOfficeFolder({ ...cur, folderPath: v.path }, roles, { repos });
        } catch (e) {
          return reply.code(400).send({ error: `folderPath: ${(e as Error).message}` });
        }
      }
      patch.folderPath = v.path;
    }

    let office = (await storage.updateOffice(id, patch)) ?? null;
    if (!office) return reply.code(404).send({ error: 'office not found' });
    // Turned on, or re-zoned: every role's schedule counts from now — a slot
    // from while it was off (or read in the old zone) was never owed.
    if ((body.enabled === true && !cur.enabled) || (body.timezone !== undefined && body.timezone !== cur.timezone)) {
      const armedAt = new Date().toISOString();
      for (const r of await storage.listOfficeRoles(id)) await storage.updateOfficeRole(r.id, { armedAt });
    }
    let pauseChanged = false;
    if (paused !== undefined && paused !== Boolean(office.pausedAt)) {
      const next = await storage.pauseOffice(id, paused ? OFFICE_HUMAN_PAUSE_REASON : null, !paused);
      if (!next) return reply.code(409).send({ error: 'the office was paused or resumed meanwhile: reload and try again' });
      office = next;
      pauseChanged = true;
    }

    const fields = Object.keys(body);
    const autonomyRaised = body.autonomy !== undefined && AUTONOMY_RANK[body.autonomy] > AUTONOMY_RANK[cur.autonomy];
    await audit({
      action: 'edited',
      officeId: id,
      workspaceId: office.workspaceId,
      fields,
      ...(body.autonomy !== undefined && body.autonomy !== cur.autonomy ? { autonomy: { from: cur.autonomy, to: body.autonomy, raised: autonomyRaised } } : {}),
      ...(body.enabled !== undefined && body.enabled !== cur.enabled ? { enabled: body.enabled } : {}),
      ...(body.dayBudgetUsd !== undefined && body.dayBudgetUsd !== cur.dayBudgetUsd ? { dayBudgetUsd: { from: cur.dayBudgetUsd, to: body.dayBudgetUsd } } : {}),
      ...(pauseChanged ? { paused } : {}),
      ...(archivedNotes.length ? { archivedNotes } : {}),
    });
    await announce(office);
    return office;
  });

  /** The office and role behind `:id`/`:roleId`, or the reply already sent. */
  const loadRole = async (req: FastifyRequest, reply: FastifyReply): Promise<{ office: Office; role: OfficeRole } | null> => {
    const { id, roleId } = req.params as { id: string; roleId: string };
    const office = await storage.getOffice(id);
    if (!office) {
      await reply.code(404).send({ error: 'office not found' });
      return null;
    }
    const role = await storage.getOfficeRole(roleId);
    if (!role || role.officeId !== id) {
      await reply.code(404).send({ error: 'role not found in this office' });
      return null;
    }
    return { office, role };
  };

  app.post('/api/offices/:id/roles', { preHandler: fromBrowser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = roleCreateBody.parse(req.body);
    const office = await storage.getOffice(id);
    if (!office) return reply.code(404).send({ error: 'office not found' });

    const preset = body.preset ? roleFromPreset(body.preset as (typeof OFFICE_ROLE_PRESETS)[number]) : null;
    const key = body.key ?? preset?.key;
    if (!key) return reply.code(400).send({ error: 'a role without a preset needs a key' });
    if (!OFFICE_ROLE_KEY_RE.test(key)) {
      return reply.code(400).send({ error: `key "${key}" must be lowercase letters and digits in dash-separated words (like "qa" or "release-notes")` });
    }
    const { key: _k, preset: _p, ...input } = body;
    const checked = checkRoleFields(input);
    if ('error' in checked) return reply.code(400).send({ error: checked.error });
    const f = checked.fields;
    const title = f.title ?? preset?.title;
    const prompt = f.prompt ?? preset?.prompt;
    if (!title || !prompt) return reply.code(400).send({ error: 'a role without a preset needs a title and a prompt' });
    const roles = await storage.listOfficeRoles(id);
    if (roles.some((r) => r.key === key)) return reply.code(409).send({ error: `this office already has a role with key "${key}"` });

    // a generated identity whose given name no other role of the office wears
    let who = generateRoleIdentity(office.id, key, office.theme);
    for (let salt = 1; salt < 32 && roles.some((r) => r.name === who.name); salt++) who = generateRoleIdentity(office.id, key, office.theme, salt);

    const draft: NewOfficeRole = {
      officeId: id,
      preset: preset?.preset ?? null,
      key,
      name: f.name ?? who.name,
      avatar: f.avatar ?? who.avatar,
      title,
      prompt,
      model: f.model ?? preset?.model ?? 'claude-opus-5-5',
      effort: f.effort !== undefined ? (f.effort as OfficeRole['effort']) : (preset?.effort ?? null),
      tools: f.tools ?? preset?.tools ?? [],
      autonomy: f.autonomy ?? null,
      capUsd: f.capUsd ?? null,
      schedules: f.schedules ?? preset?.schedules ?? [],
      triggers: f.triggers ?? preset?.triggers ?? [],
      guards: f.guards ?? preset?.guards ?? [],
      notesPath: `roles/${key}.md`,
      enabled: f.enabled ?? true,
    };
    let role: OfficeRole;
    try {
      role = await storage.createOfficeRole(draft);
    } catch (e) {
      if (isUniqueViolation(e)) return reply.code(409).send({ error: `this office already has a role with key "${key}"` });
      throw e;
    }
    // a deleted role's notes (maybe written by a tainted shift) must not become this role's trusted notes
    let archivedNotes: string | null;
    try {
      archivedNotes = archiveRoleNotes(office, role.key);
    } catch (e) {
      await storage.deleteOfficeRole(role.id).catch(() => {});
      return reply.code(400).send({ error: `could not prepare the role's notes: ${(e as Error).message}` });
    }
    await rescaffold(office);
    await audit({
      action: 'role-created',
      ...(archivedNotes ? { archivedNotes } : {}),
      officeId: id,
      workspaceId: office.workspaceId,
      roleId: role.id,
      key: role.key,
      preset: role.preset,
      tools: role.tools,
      autonomy: role.autonomy,
    });
    await announce(office, true);
    return reply.code(201).send(roleResult(role));
  });

  app.patch('/api/offices/:id/roles/:roleId', { preHandler: fromBrowser }, async (req, reply) => {
    const body = rolePatchBody.parse(req.body);
    const found = await loadRole(req, reply);
    if (!found) return reply;
    const { office, role: cur } = found;
    const checked = checkRoleFields(body);
    if ('error' in checked) return reply.code(400).send({ error: checked.error });
    const f = checked.fields;
    if (f.name !== undefined && f.name !== cur.name) {
      const clash = (await storage.listOfficeRoles(office.id)).find((r) => r.id !== cur.id && r.name === f.name);
      if (clash) return reply.code(409).send({ error: `another role of this office is already called "${f.name}"` });
    }
    const patch: OfficeRolePatch = { ...(f as OfficeRolePatch) };
    if (roleRearms(cur, f)) patch.armedAt = new Date().toISOString();
    const role = await storage.updateOfficeRole(cur.id, patch);
    if (!role) return reply.code(404).send({ error: 'role not found in this office' });
    if ((f.name !== undefined && f.name !== cur.name) || (f.title !== undefined && f.title !== cur.title)) await rescaffold(office);
    const raised =
      f.autonomy !== undefined &&
      AUTONOMY_RANK[f.autonomy ?? office.autonomy] > AUTONOMY_RANK[cur.autonomy ?? office.autonomy];
    const addedTools = role.tools.filter((t) => !cur.tools.includes(t));
    await audit({
      action: 'role-edited',
      officeId: office.id,
      workspaceId: office.workspaceId,
      roleId: role.id,
      key: role.key,
      fields: Object.keys(body),
      ...(addedTools.length ? { addedTools } : {}),
      ...(f.autonomy !== undefined && f.autonomy !== cur.autonomy ? { autonomy: { from: cur.autonomy, to: f.autonomy, raised } } : {}),
    });
    await announce(office, true);
    return roleResult(role);
  });

  // The role's command allowlist (docs/office.md § Command runs): the ONLY
  // way a shift's request can make anything execute. Origin-gated like every
  // write here — an agent's curl has no Origin, so no agent can set it — and
  // a role PATCH cannot carry it (`rolePatchBody` is strict).
  app.put('/api/offices/:id/roles/:roleId/commands', { preHandler: fromBrowser }, async (req, reply) => {
    const parsed = roleCommandsBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: `commands: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` });
    }
    const found = await loadRole(req, reply);
    if (!found) return reply;
    const { office, role: cur } = found;
    const seen = new Set<string>();
    const named: { commandId: string; name: string; external: boolean }[] = [];
    for (const [i, c] of parsed.data.commands.entries()) {
      if (seen.has(c.commandId)) return reply.code(400).send({ error: `commands[${i}]: listed twice` });
      seen.add(c.commandId);
      const check = await allowlistCheck(storage, office, c.commandId);
      if ('error' in check) return reply.code(400).send({ error: `commands[${i}]: ${check.error}` });
      named.push({ commandId: c.commandId, name: check.command.name, external: c.external });
    }
    const commands = parsed.data.commands.map((c) => ({ commandId: c.commandId, external: c.external }));
    const role = await storage.updateOfficeRole(cur.id, { commands });
    if (!role) return reply.code(404).send({ error: 'role not found in this office' });
    const before = new Set(cur.commands.map((c) => c.commandId));
    await audit({
      action: 'role-commands',
      officeId: office.id,
      workspaceId: office.workspaceId,
      roleId: role.id,
      key: role.key,
      commands: named,
      added: named.filter((c) => !before.has(c.commandId)).map((c) => c.commandId),
      removed: cur.commands.filter((c) => !seen.has(c.commandId)).map((c) => c.commandId),
    });
    await announce(office, true);
    return roleResult(role);
  });

  app.delete('/api/offices/:id/roles/:roleId', { preHandler: fromBrowser }, async (req, reply) => {
    const found = await loadRole(req, reply);
    if (!found) return reply;
    const { office, role } = found;
    if (!(await storage.deleteOfficeRole(role.id))) return reply.code(404).send({ error: 'role not found in this office' });
    // the notes file stays (history); the README's role list drops it
    await rescaffold(office);
    await audit({ action: 'role-deleted', officeId: office.id, workspaceId: office.workspaceId, roleId: role.id, key: role.key, name: role.name });
    await announce(office, true);
    return { ok: true };
  });

  app.post('/api/offices/:id/roles/:roleId/reset-notes', { preHandler: fromBrowser }, async (req, reply) => {
    const found = await loadRole(req, reply);
    if (!found) return reply;
    const { office, role: cur } = found;
    let rel: string;
    try {
      rel = resetRoleNotes(office, cur);
    } catch (e) {
      return reply.code(400).send({ error: `could not reset the notes: ${(e as Error).message}` });
    }
    const role = (await storage.updateOfficeRole(cur.id, { notesTaintedAt: null })) ?? cur;
    await audit({
      action: 'role-notes-reset',
      officeId: office.id,
      workspaceId: office.workspaceId,
      roleId: role.id,
      key: role.key,
      notesPath: rel,
      wasTainted: cur.notesTaintedAt !== null,
    });
    await announce(office, true);
    return roleResult(role);
  });

  // The notes a human is asked to review (docs/office.md § The /office page):
  // the file the role's next shift would read while `notesTaintedAt` is set —
  // the untrusted twin `untrusted/roles/<key>.md` when it exists, else
  // `roles/<key>.md` — with the sha256 of exactly this text. Mark notes
  // reviewed must name that sha (and the `notesTaintedAt` shown), so it can
  // only vouch for the version the human actually read.
  const notesUnderReview = (office: Office, role: OfficeRole) => {
    const twin = officeRel(office, untrustedPath(office, roleNotesRel(role)));
    // readOfficeText refuses a file that resolves outside the folder (a symlink)
    const twinText = readOfficeText(office, twin, SHIFT_NOTES_MAX_CHARS * 4);
    const rel = twinText !== null ? twin : roleNotesRel(role);
    const text = twinText ?? readOfficeText(office, rel, SHIFT_NOTES_MAX_CHARS * 4);
    let modifiedAt: string | null = null;
    if (text !== null) {
      try {
        modifiedAt = fs.statSync(path.join(path.resolve(office.folderPath), rel)).mtime.toISOString();
      } catch {
        // gone between the read and the stat: the sha still names what was read
      }
    }
    return {
      path: rel,
      promotes: twinText !== null,
      text,
      sha256: text === null ? null : createHash('sha256').update(text).digest('hex'),
      modifiedAt,
    };
  };

  app.get('/api/offices/:id/roles/:roleId/notes-review', async (req, reply) => {
    const found = await loadRole(req, reply);
    if (!found) return reply;
    const { office, role } = found;
    const review: OfficeNotesReview = { ...notesUnderReview(office, role), notesTaintedAt: role.notesTaintedAt };
    return review;
  });

  // Mark notes reviewed (docs/office.md § The /office page): a human read the
  // notes a tainted shift wrote and vouches for them. A tainted shift writes
  // its notes to the untrusted twin (`untrusted/roles/<key>.md`), which is
  // what the next shift reads while `notesTaintedAt` is set — so the twin is
  // PROMOTED over `roles/<key>.md` (temp file + rename, `writeOfficeFile`)
  // and removed, and only then is the flag cleared: the next shift reads the
  // reviewed text as trusted. No twin (it was never written, or is gone) →
  // `roles/<key>.md` is what was read, and only the flag clears. A tainted
  // SESSION stays tainted (`mayResume`): nobody can review a conversation.
  // The body names the version reviewed (`notesTaintedAt` + `sha256` from
  // GET …/notes-review): a shift that rewrote the twin since re-stamps the
  // flag and changes the sha, so either mismatch is a 409 ("read them
  // again") — the promoted text is exactly the text whose sha was checked.
  // A shift of the role still open → 409 too: it may be about to rewrite it.
  app.post('/api/offices/:id/roles/:roleId/notes-reviewed', { preHandler: fromBrowser }, async (req, reply) => {
    const parsed = notesReviewedBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: `notes-reviewed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` });
    }
    const found = await loadRole(req, reply);
    if (!found) return reply;
    const { office, role: cur } = found;
    if (cur.notesTaintedAt === null) return reply.code(409).send({ error: 'these notes are not marked tainted' });
    if (parsed.data.notesTaintedAt !== cur.notesTaintedAt) {
      return reply.code(409).send({ error: 'a shift rewrote these notes after you opened them — read them again' });
    }
    const open = await storage.listShifts({ roleId: cur.id, open: true, limit: 1 });
    if (open.length > 0) return reply.code(409).send({ error: 'a shift of this role is running and may rewrite its notes — wait for it to end' });
    const review = notesUnderReview(office, cur);
    if (review.sha256 !== parsed.data.sha256) {
      return reply.code(409).send({ error: 'these notes changed after you opened them — read them again' });
    }
    let promotedFrom: string | null = null;
    if (review.promotes && review.text !== null) {
      try {
        writeOfficeFile(office, roleNotesRel(cur), review.text);
      } catch (e) {
        return reply.code(400).send({ error: `could not promote the reviewed notes: ${(e as Error).message}` });
      }
      promotedFrom = review.path;
      try {
        fs.rmSync(path.join(path.resolve(office.folderPath), review.path), { force: true });
      } catch (e) {
        // harmless: the twin is read only while the flag is set
        console.warn(`office ${office.id}: could not remove ${review.path}:`, (e as Error).message);
      }
    }
    const role = await storage.updateOfficeRole(cur.id, { notesTaintedAt: null });
    if (!role) return reply.code(404).send({ error: 'role not found in this office' });
    await storage.appendEvent({
      kind: 'office.taint-cleared',
      actor: 'human',
      data: {
        officeId: office.id,
        workspaceId: office.workspaceId,
        roleId: role.id,
        key: role.key,
        notesPath: role.notesPath,
        promotedFrom,
        sha256: review.sha256,
        taintedAt: cur.notesTaintedAt,
      },
    });
    await announce(office, true);
    return roleResult(role);
  });

  // Wake now (docs/office.md § Scheduler and states): a stakeholder request —
  // the hard gate still applies (409 with its reason), guards and cooldown do
  // not; the note reaches the shift as trusted text.
  app.post('/api/offices/:id/roles/:roleId/wake', { preHandler: fromBrowser }, async (req, reply) => {
    const body = wakeBody.parse(req.body ?? {});
    const { id, roleId } = req.params as { id: string; roleId: string };
    const s = scheduler();
    if (!s) return reply.code(503).send({ error: 'the office scheduler is not running' });
    const r = await s.wake(id, roleId, body.note ?? null, 'human');
    if (!r.ok) return reply.code(r.status).send({ error: r.error, ...(r.code ? { code: r.code } : {}) });
    return reply.code(202).send({ shiftId: r.shiftId });
  });
  // Wishes and vision (docs/office.md § Wishes and vision): a wish wakes the
  // Director (`request`, ref `wish:<id>`; hard gate, no guards); a doc save
  // whose content changed wakes it for a re-plan (`re-plan:<doc>`). A wake
  // refused for a busy slot stays pending — the scheduler tick retries it.
  app.get('/api/offices/:id/wishes', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await storage.getOffice(id))) return reply.code(404).send({ error: 'office not found' });
    return storage.listWishes({ officeId: id });
  });

  app.post('/api/offices/:id/wishes', { preHandler: fromBrowser }, async (req, reply) => {
    const body = wishBody.parse(req.body ?? {});
    const { id } = req.params as { id: string };
    const office = await storage.getOffice(id);
    if (!office) return reply.code(404).send({ error: 'office not found' });
    try {
      const r: OfficeWishCreateResult = await createOfficeWish({ storage, waker: scheduler() }, office, body.text, 'human');
      return reply.code(201).send(r);
    } catch (e) {
      if (e instanceof OfficeWishRefused) return reply.code(409).send({ error: e.message });
      throw e;
    }
  });

  app.patch('/api/office-wishes/:wishId', { preHandler: fromBrowser }, async (req, reply) => {
    const body = wishPatchBody.parse(req.body ?? {});
    const { wishId } = req.params as { wishId: string };
    const cur = await storage.getWish(wishId);
    if (!cur) return reply.code(404).send({ error: 'wish not found' });
    const wish = await storage.updateWish(wishId, body);
    if (!wish) return reply.code(404).send({ error: 'wish not found' });
    await storage.appendEvent({
      kind: 'office.wish',
      actor: 'human',
      data: { officeId: wish.officeId, wishId: wish.id, change: 'edited', ...(body.status ? { from: cur.status, to: body.status } : {}), textChanged: body.text !== undefined },
    });
    broadcast({ type: 'office-wish.updated', wish });
    return wish;
  });

  app.get('/api/offices/:id/docs/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    if (!isOfficeReadableDoc(name)) return reply.code(404).send({ error: 'unknown office doc — vision.md, priorities.md or roadmap.md' });
    const office = await storage.getOffice(id);
    if (!office) return reply.code(404).send({ error: 'office not found' });
    return readOfficeDoc(office, name);
  });

  app.put('/api/offices/:id/docs/:name', { preHandler: fromBrowser }, async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    if (!isOfficeEditableDoc(name)) return reply.code(404).send({ error: 'only vision.md and priorities.md are edited here (the Director writes roadmap.md)' });
    const body = docPutBody.parse(req.body ?? {});
    const office = await storage.getOffice(id);
    if (!office) return reply.code(404).send({ error: 'office not found' });
    try {
      const r: OfficeDocPutResult = await saveOfficeDoc({ storage, waker: scheduler() }, office, name, body.content, {
        baseSha256: body.baseSha256,
        actor: 'human',
      });
      return r;
    } catch (e) {
      if (e instanceof OfficeDocConflict) return reply.code(409).send({ error: e.message });
      return reply.code(400).send({ error: `could not write ${name}: ${(e as Error).message}` });
    }
  });
}
