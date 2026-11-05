// Shift task filing (docs/office.md § Filing, decisions.md 2026-11-05 — open
// decision 5). A shift's `tasks` result section names work for the office's
// workspace repos; the SERVER files it, through `task-actions.ts` like every
// other creation, as source `office` with the office, the role, the shift's
// run (`created_by_run`) and — for a tainted shift — `tainted_at`.
//
// What a filing becomes is `filingStatus(effectiveAutonomy, tainted,
// {queueStopped: !orchestrator.enabled})`: proposals → nothing filed (the
// requests are HELD on the shift row for the proposals card), tainted → draft,
// stopped queue → draft with the agents' 'queue is stopped' note, else queued.
// `agent.allowEnqueue` is deliberately NOT read: it governs worker filings
// through /api/agent/tasks, and an office is governed by its own Origin-gated
// opt-ins (enabled with a required budget, the autonomy level). The same-repo
// draft rule does not apply either: a shift owns no checkout.
//
// The office's caps are its own: `maxTasksPerShift` (≤ 15) and
// `maxOpenTasks` (non-terminal office tasks, `countOpenOfficeTasks`). The
// agent ceiling never counts office tasks (`countQueuedAgentTasks` has
// `office_id IS NULL`), so neither side pushes the other into drafts. Whatever
// a cap or a bad repo id leaves out is DROPPED and listed, with its reason, on
// the shift row (`OfficeShift.filing`).
import { z } from 'zod';
import {
  AGENT_TITLE_MAX,
  EFFORT_LEVELS,
  OFFICE_MAX_TASKS_PER_SHIFT_MAX,
  OFFICE_PROPOSALS_NOTE,
  OFFICE_QUEUE_STOPPED_NOTE,
  OFFICE_TAINTED_NOTE,
  effectiveAutonomy,
  filingStatus,
  oneLineTitle,
  type EffortLevel,
  type Office,
  type OfficeAutonomy,
  type OfficeRole,
  type OfficeShiftFiling,
  type ShiftTaskRequest,
  type Task,
} from '@tm/shared';
import type { OrchestratorApi } from '../app-types.ts';
import { withStandingCaps } from '../claude/feature-plan.ts';
import type { Storage } from '../storage/types.ts';
import { createTask } from '../task-actions.ts';

// ---------------------------------------------------------------------------
// The section's shape
// ---------------------------------------------------------------------------

/**
 * How many tasks the RESULT may list. Wider than any office's cap on purpose:
 * a list over the cap is not a validation error (that would type a correction
 * into the session) — the excess is dropped and listed on the shift row.
 */
export const SHIFT_TASKS_MAX_ITEMS = 30;
export const SHIFT_TASK_DESCRIPTION_MAX = 20_000;
export const SHIFT_TASK_CATEGORY_MAX = 60;

export const shiftTaskSchema = z
  .object({
    repoId: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(SHIFT_TASK_DESCRIPTION_MAX),
    category: z.string().trim().min(1).max(SHIFT_TASK_CATEGORY_MAX).nullish(),
    effort: z.enum(EFFORT_LEVELS as [EffortLevel, ...EffortLevel[]]).nullish(),
  })
  .strict();

export type ShiftTaskInput = z.infer<typeof shiftTaskSchema>;

export const shiftTasksSchema = z.array(shiftTaskSchema).max(SHIFT_TASKS_MAX_ITEMS);

/** The JSON-schema twin of `shiftTasksSchema`, shown to the model. */
export const SHIFT_TASKS_JSON_SCHEMA: Record<string, unknown> = {
  type: 'array',
  maxItems: SHIFT_TASKS_MAX_ITEMS,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['repoId', 'title', 'description'],
    properties: {
      repoId: { type: 'string', minLength: 1 },
      title: { type: 'string', minLength: 1, maxLength: 200 },
      description: { type: 'string', minLength: 1, maxLength: SHIFT_TASK_DESCRIPTION_MAX },
      category: { type: ['string', 'null'], maxLength: SHIFT_TASK_CATEGORY_MAX },
      effort: { type: ['string', 'null'], enum: [...EFFORT_LEVELS, null] },
    },
  },
};

export const SHIFT_TASKS_DESCRIBE =
  'work for a WORKER agent to do in one of your workspace repos (code, tests, a QA pass, a fix): ' +
  '{repoId (from the repo list above), title (one short line), description (what to do and how to tell it is done), ' +
  'category (a short domain label, optional), effort (low|medium|high|xhigh|max, optional)}. ' +
  'The server files them — queued, as drafts, or held as proposals, depending on the office — and caps how many ' +
  'one shift may file (8 by default); extras are dropped and listed on your shift. Never ask for work you could not ' +
  'describe precisely, and never file a duplicate of an open task.';

/** One request as stored: trimmed, the title one line. */
export function normalizeShiftTask(t: ShiftTaskInput): ShiftTaskRequest {
  return {
    repoId: t.repoId.trim(),
    title: oneLineTitle(t.title, AGENT_TITLE_MAX) || t.title.trim().slice(0, AGENT_TITLE_MAX),
    description: t.description.trim(),
    category: t.category?.trim() || null,
    effort: t.effort ?? null,
  };
}

// ---------------------------------------------------------------------------
// The plan (pure)
// ---------------------------------------------------------------------------

export interface ShiftFilingInput {
  requests: readonly ShiftTaskRequest[];
  /** the office workspace's repos; a request for any other repo is dropped */
  workspaceRepoIds: readonly string[];
  autonomy: OfficeAutonomy;
  tainted: boolean;
  queueStopped: boolean;
  maxTasksPerShift: number;
  maxOpenTasks: number;
  /** the office's non-terminal tasks right now (`countOpenOfficeTasks`) */
  openTasks: number;
}

export interface ShiftFilingPlan extends OfficeShiftFiling {
  /** the requests to file, at `status` */
  file: ShiftTaskRequest[];
}

const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(Number.isFinite(v) ? v : lo)));

export const dropReasons = {
  repo: 'repo is not in this office’s workspace',
  duplicate: 'duplicate of an earlier task in this shift',
  perShift: (n: number) => `over the per-shift cap (maxTasksPerShift ${n})`,
  open: (n: number) => `the office already has its maximum of open tasks (maxOpenTasks ${n})`,
};

/**
 * What a shift's requests become. Order: a request for a repo outside the
 * workspace (or a repeat of one already listed) is dropped first; the per-shift
 * cap then keeps the first N; under proposals autonomy those are HELD (no task
 * exists, so the open-task cap does not apply); otherwise the open-task cap
 * keeps as many as the office has room for. Every drop carries its reason.
 */
export function planShiftFiling(i: ShiftFilingInput): ShiftFilingPlan {
  const status = filingStatus(i.autonomy, i.tainted, { queueStopped: i.queueStopped });
  const note =
    status === 'proposal' ? OFFICE_PROPOSALS_NOTE : status === 'queued' ? null : i.tainted ? OFFICE_TAINTED_NOTE : OFFICE_QUEUE_STOPPED_NOTE;
  const perShift = clampInt(i.maxTasksPerShift, 1, OFFICE_MAX_TASKS_PER_SHIFT_MAX);
  const repos = new Set(i.workspaceRepoIds);
  const seen = new Set<string>();
  const dropped: OfficeShiftFiling['dropped'] = [];
  const kept: ShiftTaskRequest[] = [];
  for (const r of i.requests) {
    if (!repos.has(r.repoId)) {
      dropped.push({ ...r, reason: dropReasons.repo });
      continue;
    }
    const key = `${r.repoId}\u0000${r.title.toLowerCase()}`;
    if (seen.has(key)) {
      dropped.push({ ...r, reason: dropReasons.duplicate });
      continue;
    }
    seen.add(key);
    if (kept.length >= perShift) {
      dropped.push({ ...r, reason: dropReasons.perShift(perShift) });
      continue;
    }
    kept.push(r);
  }
  if (status === 'proposal') return { status, note, held: kept, dropped, file: [] };
  const maxOpen = Math.max(0, Math.floor(Number.isFinite(i.maxOpenTasks) ? i.maxOpenTasks : 0));
  const room = Math.max(0, maxOpen - Math.max(0, i.openTasks));
  const file = kept.slice(0, room);
  for (const r of kept.slice(room)) dropped.push({ ...r, reason: dropReasons.open(maxOpen) });
  return { status, note, held: [], dropped, file };
}

// ---------------------------------------------------------------------------
// Filing (the server side)
// ---------------------------------------------------------------------------

export interface ShiftFilingDeps {
  storage: Storage;
  /** kicked once when anything was filed `queued` (optional exactly as in `TaskActionDeps`) */
  orchestrator?: OrchestratorApi;
}

export interface ShiftFilingCtx {
  office: Office;
  role: OfficeRole;
  shiftId: string;
  tainted: boolean;
  now: Date;
  /** the shift's run; default: the shift row's `run_id` */
  runId?: string | null;
}

export interface ShiftFilingResult {
  filed: Task[];
  filing: OfficeShiftFiling;
}

/** The audit actor of an office filing. */
export const officeActor = (role: Pick<OfficeRole, 'key'>) => `office:${role.key}`;

/** The worker-facing description: who filed it, the shift's words, the standing caps. */
export function officeTaskDescription(role: Pick<OfficeRole, 'name' | 'title'>, shiftId: string, description: string): string {
  return withStandingCaps(`_Filed by **${role.name}** (${role.title}) — office shift ${shiftId.slice(0, 8)}_\n\n${description}`);
}

// One filing at a time per office: the open-task cap is read and then filled,
// and two shifts settling together must not both see the same room.
const officeChains = new Map<string, Promise<unknown>>();

function serialized<T>(officeId: string, fn: () => Promise<T>): Promise<T> {
  const prev = officeChains.get(officeId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  officeChains.set(officeId, tail);
  void tail.then(() => {
    if (officeChains.get(officeId) === tail) officeChains.delete(officeId);
  });
  return next;
}

/**
 * File a shift's `tasks` section. The office and role are RE-READ (a human
 * may have lowered the autonomy or a cap while the shift ran); a deleted
 * office files nothing. The shift row gets the filed ids (appended) and the
 * `filing` record; one `office.filing` audit row says what happened.
 */
export async function fileShiftTasks(
  deps: ShiftFilingDeps,
  ctx: ShiftFilingCtx,
  input: readonly ShiftTaskInput[],
): Promise<ShiftFilingResult> {
  return serialized(ctx.office.id, async () => {
    const { storage } = deps;
    const requests = input.map(normalizeShiftTask);
    const office = await storage.getOffice(ctx.office.id);
    const role = (await storage.getOfficeRole(ctx.role.id)) ?? ctx.role;
    const autonomy = effectiveAutonomy(office ?? ctx.office, role);
    const settings = await storage.getSettings();
    const workspace = office ? await storage.getWorkspace(office.workspaceId) : null;
    // the prompt lists each repo's id; a request naming the repo instead (exact, case-insensitive) is mapped to it
    const wsRepos = workspace?.repoIds.length ? (await storage.listRepos()).filter((r) => workspace.repoIds.includes(r.id)) : [];
    for (const r of requests) {
      if (wsRepos.some((w) => w.id === r.repoId)) continue;
      const byName = wsRepos.filter((w) => w.name.toLowerCase() === r.repoId.toLowerCase());
      if (byName.length === 1) r.repoId = byName[0].id;
    }
    const plan = office
      ? planShiftFiling({
          requests,
          workspaceRepoIds: workspace?.repoIds ?? [],
          autonomy,
          tainted: ctx.tainted,
          queueStopped: !settings['orchestrator.enabled'],
          maxTasksPerShift: office.maxTasksPerShift,
          maxOpenTasks: office.maxOpenTasks,
          openTasks: autonomy === 'proposals' ? 0 : await storage.countOpenOfficeTasks(office.id),
        })
      : {
          status: filingStatus(autonomy, ctx.tainted, { queueStopped: !settings['orchestrator.enabled'] }),
          note: null,
          held: [],
          dropped: requests.map((r) => ({ ...r, reason: 'the office no longer exists' })),
          file: [],
        };

    const shift = await storage.getShift(ctx.shiftId);
    const runId = ctx.runId ?? shift?.runId ?? null;
    const actor = officeActor(role);
    const taintedAt = ctx.tainted ? ctx.now.toISOString() : null;
    const filed: Task[] = [];
    const dropped = [...plan.dropped];
    for (const r of plan.file) {
      try {
        filed.push(
          await createTask(
            deps,
            {
              title: r.title,
              description: officeTaskDescription(role, ctx.shiftId, r.description),
              repoId: r.repoId,
              status: plan.status === 'queued' ? 'queued' : 'draft',
              source: 'office',
              category: r.category,
              effort: r.effort,
              createdByRun: runId,
              spawnDepth: 1,
              officeId: ctx.office.id,
              roleId: role.id,
              taintedAt,
            },
            actor,
          ),
        );
      } catch (e) {
        dropped.push({ ...r, reason: `could not be filed: ${(e as Error).message}` });
      }
    }
    const filing: OfficeShiftFiling = { status: plan.status, note: plan.note, held: plan.held, dropped };
    const ids = filed.map((t) => t.id);
    await storage.updateShift(ctx.shiftId, { filedTaskIds: [...(shift?.filedTaskIds ?? []), ...ids], filing });
    await storage.appendEvent({
      kind: 'office.filing',
      actor,
      runId,
      data: {
        officeId: ctx.office.id,
        roleId: role.id,
        shiftId: ctx.shiftId,
        status: plan.status,
        note: plan.note,
        tainted: ctx.tainted,
        filed: ids,
        held: plan.held.length,
        dropped: dropped.map((d) => ({ repoId: d.repoId, title: d.title, reason: d.reason })),
      },
    });
    if (filed.some((t) => t.status === 'queued')) deps.orchestrator?.maybeSchedule();
    return { filed, filing };
  });
}
