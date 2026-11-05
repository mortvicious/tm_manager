// Office proposals (docs/office.md § Proposals). A shift proposes an
// improvement — its `proposals` section, or a `tasks` request under
// `proposals` autonomy (filing.ts converts those) — and the SERVER stores it
// as a `tm_office_proposals` row: an Inbox decision with Telegram buttons and
// a Web Push. A human accepts (a task is filed through task-actions.ts) or
// rejects (nothing is filed). First decision wins (`decideProposal` is
// conditional on `pending`), the other caller gets 409.
//
// Both outcomes append ONE line to the role's feedback file through
// `appendRoleFeedback` — never to the role's own notes, which its shift's
// `notes` section replaces whole, so a decision made while a shift runs is
// still there after that shift writes its notes. A rejected TAINTED proposal
// is named there by id only: the feedback file is trusted prompt text, and a
// rejected tainted title is untrusted text no human vouched for. An accepted
// one was read by the human who accepted it, which is also why its task has
// no `tainted_at` (it stays external: source `office` lands supervised).
import { z } from 'zod';
import {
  AGENT_TITLE_MAX,
  EFFORT_LEVELS,
  OFFICE_PROPOSALS_PENDING_MAX,
  OFFICE_PROPOSAL_BODY_MAX,
  OFFICE_PROPOSAL_NOTE_MAX,
  OFFICE_PROPOSAL_TITLE_MAX,
  SHIFT_PROPOSALS_MAX,
  effectiveAutonomy,
  oneLineTitle,
  proposalAcceptStatus,
  type EffortLevel,
  type Office,
  type OfficeProposal,
  type OfficeRole,
  type Task,
} from '@tm/shared';
import type { OrchestratorApi } from '../app-types.ts';
import { withStandingCaps } from '../claude/feature-plan.ts';
import { broadcast } from '../events.ts';
import type { Storage } from '../storage/types.ts';
import { createTask } from '../task-actions.ts';
import { appendRoleFeedback } from './feedback.ts';

// ---------------------------------------------------------------------------
// The section's shape
// ---------------------------------------------------------------------------

export const shiftProposalSchema = z
  .object({
    title: z.string().trim().min(1).max(OFFICE_PROPOSAL_TITLE_MAX),
    body: z.string().trim().min(1).max(OFFICE_PROPOSAL_BODY_MAX),
    repoId: z.string().trim().min(1).max(100).nullish(),
  })
  .strict();

export type ShiftProposalInput = z.infer<typeof shiftProposalSchema>;

export const shiftProposalsSchema = z.array(shiftProposalSchema).max(SHIFT_PROPOSALS_MAX, `at most ${SHIFT_PROPOSALS_MAX} proposals per shift`);

export const SHIFT_PROPOSALS_JSON_SCHEMA: Record<string, unknown> = {
  type: 'array',
  maxItems: SHIFT_PROPOSALS_MAX,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'body'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: OFFICE_PROPOSAL_TITLE_MAX },
      body: { type: 'string', minLength: 1, maxLength: OFFICE_PROPOSAL_BODY_MAX },
      repoId: { type: ['string', 'null'] },
    },
  },
};

export const SHIFT_PROPOSALS_DESCRIBE =
  `improvements you PROPOSE to the human, at most ${SHIFT_PROPOSALS_MAX}: {title (one short line), body (what and why, ` +
  'and how to tell it is done — it becomes the task description if accepted), repoId (from the repo list above, optional)}. ' +
  'Nothing runs until a human accepts one; the decision is written to your feedback file. Use it for changes the human ' +
  'should weigh first (scope, direction, cost); routine work goes in `tasks`.';

// ---------------------------------------------------------------------------
// Creating (a shift's section, or tasks converted under proposals autonomy)
// ---------------------------------------------------------------------------

export interface ProposalRequest {
  title: string;
  body: string;
  repoId: string | null;
  category?: string | null;
  effort?: EffortLevel | null;
}

export interface ProposalCtx {
  office: Office;
  role: OfficeRole;
  shiftId: string;
  tainted: boolean;
  /** the shift's run; default: the shift row's `run_id` */
  runId?: string | null;
  origin: OfficeProposal['origin'];
}

export interface ProposalsCreated {
  created: OfficeProposal[];
  dropped: (ProposalRequest & { reason: string })[];
}

export const proposalDropReasons = {
  pending: (n: number) => `the office already has its maximum of pending proposals (${n})`,
  duplicate: 'duplicate of an earlier proposal in this shift',
  office: 'the office no longer exists',
};

// One creation at a time per office: the pending cap is read and then filled.
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
 * Store a shift's proposals. The office is re-read (a deleted office stores
 * nothing); a repo id outside the workspace is cleared rather than dropped (the
 * human picks the repo on accept), an exact repo NAME is mapped to its id, and
 * the pending cap (`OFFICE_PROPOSALS_PENDING_MAX`) drops the rest. One
 * `office.proposals` audit row says what happened; each row is broadcast as
 * `office-proposal.updated` (the Telegram and push notifiers ping on it).
 */
export async function createShiftProposals(storage: Storage, ctx: ProposalCtx, requests: readonly ProposalRequest[]): Promise<ProposalsCreated> {
  if (!requests.length) return { created: [], dropped: [] };
  return serialized(ctx.office.id, async () => {
    const office = await storage.getOffice(ctx.office.id);
    if (!office) return { created: [], dropped: requests.map((r) => ({ ...r, reason: proposalDropReasons.office })) };
    const workspace = await storage.getWorkspace(office.workspaceId);
    const wsRepos = workspace?.repoIds.length ? (await storage.listRepos()).filter((r) => workspace.repoIds.includes(r.id)) : [];
    const repoOf = (ref: string | null | undefined): string | null => {
      const v = ref?.trim();
      if (wsRepos.length === 1 && !v) return wsRepos[0].id;
      if (!v) return null;
      if (wsRepos.some((w) => w.id === v)) return v;
      const byName = wsRepos.filter((w) => w.name.toLowerCase() === v.toLowerCase());
      return byName.length === 1 ? byName[0].id : wsRepos.length === 1 ? wsRepos[0].id : null;
    };
    const shift = await storage.getShift(ctx.shiftId);
    const runId = ctx.runId ?? shift?.runId ?? null;
    const taintedAt = new Date().toISOString();
    let room = Math.max(0, OFFICE_PROPOSALS_PENDING_MAX - (await storage.countPendingOfficeProposals(office.id)));
    const created: OfficeProposal[] = [];
    const dropped: ProposalsCreated['dropped'] = [];
    const seen = new Set<string>();
    for (const r of requests) {
      const title = oneLineTitle(r.title, AGENT_TITLE_MAX) || r.title.trim().slice(0, AGENT_TITLE_MAX);
      const repoId = repoOf(r.repoId);
      const key = `${repoId ?? ''}\u0000${title.toLowerCase()}`;
      if (seen.has(key)) {
        dropped.push({ ...r, reason: proposalDropReasons.duplicate });
        continue;
      }
      seen.add(key);
      if (room <= 0) {
        dropped.push({ ...r, reason: proposalDropReasons.pending(OFFICE_PROPOSALS_PENDING_MAX) });
        continue;
      }
      room -= 1;
      const p = await storage.appendOfficeProposal({
        officeId: office.id,
        workspaceId: office.workspaceId,
        roleId: ctx.role.id,
        shiftId: ctx.shiftId,
        runId,
        repoId,
        origin: ctx.origin,
        title,
        body: r.body.trim(),
        category: r.category ?? null,
        effort: r.effort && (EFFORT_LEVELS as readonly string[]).includes(r.effort) ? r.effort : null,
        taintedAt: ctx.tainted ? taintedAt : null,
      });
      created.push(p);
    }
    await storage.appendEvent({
      kind: 'office.proposals',
      actor: `office:${ctx.role.key}`,
      runId,
      repoId: created.length === 1 && created[0].repoId ? created[0].repoId : undefined,
      data: {
        officeId: office.id,
        roleId: ctx.role.id,
        shiftId: ctx.shiftId,
        origin: ctx.origin,
        tainted: ctx.tainted,
        created: created.map((p) => p.id),
        // a tainted shift's titles are untrusted: the audit row lists reasons, never them
        dropped: dropped.map((d) => (ctx.tainted ? { reason: d.reason } : { title: d.title, reason: d.reason })),
      },
    });
    for (const p of created) broadcast({ type: 'office-proposal.updated', proposal: p });
    return { created, dropped };
  });
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

export interface ProposalDeps {
  storage: Storage;
  orchestrator?: OrchestratorApi;
}

export type ProposalDecision =
  | { ok: true; proposal: OfficeProposal; task?: Task; feedback: string | null }
  | { ok: false; code: 400 | 404 | 409; error: string };

const id8 = (id: string) => id.slice(0, 8);

const decidedAlready = (p: OfficeProposal) => `already ${p.status}${p.decidedBy ? ` by ${p.decidedBy}` : ''}`;

/** The feedback line a decision appends. A rejected TAINTED proposal is named by id only. */
export function proposalFeedbackLine(
  p: Pick<OfficeProposal, 'id' | 'title' | 'taintedAt'>,
  outcome: { accepted: true; taskId: string; status: string } | { accepted: false; note: string | null },
  actor: string,
): string {
  if (outcome.accepted) {
    return `accepted: proposal ${id8(p.id)} “${p.title}” — filed as task ${id8(outcome.taskId)} (${outcome.status}) by ${actor}`;
  }
  const what = p.taintedAt ? `proposal ${id8(p.id)} (from a tainted shift — title withheld)` : `proposal ${id8(p.id)} “${p.title}”`;
  return `rejected: ${what} by ${actor}${outcome.note ? ` — reason: ${outcome.note}` : ''}`;
}

/** The task description an accept files: who proposed it, who accepted it, the body, the standing caps. */
export function acceptedTaskDescription(role: Pick<OfficeRole, 'name' | 'title'>, p: Pick<OfficeProposal, 'id' | 'shiftId' | 'body'>, actor: string): string {
  return withStandingCaps(
    `_Proposed by **${role.name}** (${role.title}) — office shift ${id8(p.shiftId)}, proposal ${id8(p.id)}; accepted by ${actor}_\n\n${p.body}`,
  );
}

async function feedback(office: Office, role: OfficeRole, line: string): Promise<string | null> {
  try {
    return await appendRoleFeedback(office, role, line);
  } catch (e) {
    console.warn(`[office] proposal feedback for role ${role.key} not written: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Which repo an accept files into: the human's pick, else the proposal's, else
 * the workspace's only repo. It must be in the office's workspace NOW.
 */
async function acceptRepo(storage: Storage, office: Office, p: OfficeProposal, pick: string | undefined): Promise<{ repoId: string } | { error: string }> {
  const workspace = await storage.getWorkspace(office.workspaceId);
  const ids = workspace ? (await storage.listRepos()).filter((r) => workspace.repoIds.includes(r.id)).map((r) => r.id) : [];
  const want = pick?.trim() || p.repoId || (ids.length === 1 ? ids[0] : null);
  if (!want) return { error: ids.length ? 'pick a repo for this proposal (repoId)' : 'the office workspace has no repos' };
  if (!ids.includes(want)) return { error: 'that repo is not in this office’s workspace' };
  return { repoId: want };
}

/**
 * Accept: the conditional write FIRST (so a racing reject or second accept
 * gets 409 and never a second task), then the task. A filing that throws puts
 * the row back to `pending` (only while it filed nothing) and answers 409.
 */
export async function acceptProposal(deps: ProposalDeps, id: string, actor: string, body: { repoId?: string } = {}): Promise<ProposalDecision> {
  const { storage } = deps;
  const cur = await storage.getOfficeProposal(id);
  if (!cur) return { ok: false, code: 404, error: 'no such proposal' };
  if (cur.status !== 'pending') return { ok: false, code: 409, error: decidedAlready(cur) };
  const office = await storage.getOffice(cur.officeId);
  const role = await storage.getOfficeRole(cur.roleId);
  if (!office || !role) return { ok: false, code: 409, error: office ? 'the role that proposed it no longer exists' : 'the office no longer exists' };
  const repo = await acceptRepo(storage, office, cur, body.repoId);
  if ('error' in repo) return { ok: false, code: 400, error: repo.error };
  const settings = await storage.getSettings();
  const status = proposalAcceptStatus(effectiveAutonomy(office, role), { queueStopped: !settings['orchestrator.enabled'] });

  const claimed = await storage.decideProposal(id, 'accepted', actor);
  if (!claimed) {
    const now = await storage.getOfficeProposal(id);
    return { ok: false, code: 409, error: now ? decidedAlready(now) : 'decided elsewhere first' };
  }
  let task: Task;
  try {
    task = await createTask(
      deps,
      {
        title: cur.title,
        description: acceptedTaskDescription(role, cur, actor),
        repoId: repo.repoId,
        status,
        source: 'office',
        category: cur.category,
        effort: cur.effort,
        createdByRun: cur.runId,
        spawnDepth: 1,
        officeId: office.id,
        roleId: role.id,
        // accepting IS the human review: never tainted, whatever the shift was
        taintedAt: null,
      },
      actor,
    );
  } catch (e) {
    const back = await storage.undoOfficeProposalAccept(id);
    if (back) broadcast({ type: 'office-proposal.updated', proposal: back });
    return { ok: false, code: 409, error: `could not file the task: ${(e as Error).message}` };
  }
  const row = (await storage.setProposalFiledTask(id, task.id)) ?? { ...claimed, filedTaskId: task.id };
  const line = await feedback(office, role, proposalFeedbackLine(row, { accepted: true, taskId: task.id, status: task.status }, actor));
  await storage.appendEvent({
    kind: 'office.proposal-decided',
    actor,
    taskId: task.id,
    repoId: task.repoId ?? undefined,
    runId: cur.runId,
    data: { officeId: office.id, roleId: role.id, proposalId: id, shiftId: cur.shiftId, accepted: true, status: task.status, tainted: cur.taintedAt !== null, feedback: line !== null },
  });
  broadcast({ type: 'office-proposal.updated', proposal: row });
  if (task.status === 'queued') deps.orchestrator?.maybeSchedule();
  return { ok: true, proposal: row, task, feedback: line };
}

/** Reject: conditional on `pending`, nothing filed, a feedback line (id only for a tainted proposal). */
export async function rejectProposal(deps: ProposalDeps, id: string, actor: string, note?: string | null): Promise<ProposalDecision> {
  const { storage } = deps;
  const cur = await storage.getOfficeProposal(id);
  if (!cur) return { ok: false, code: 404, error: 'no such proposal' };
  if (cur.status !== 'pending') return { ok: false, code: 409, error: decidedAlready(cur) };
  const reason = note?.replace(/\s+/g, ' ').trim().slice(0, OFFICE_PROPOSAL_NOTE_MAX) || null;
  const row = await storage.decideProposal(id, 'rejected', actor, null, reason);
  if (!row) {
    const now = await storage.getOfficeProposal(id);
    return { ok: false, code: 409, error: now ? decidedAlready(now) : 'decided elsewhere first' };
  }
  const office = await storage.getOffice(row.officeId);
  const role = await storage.getOfficeRole(row.roleId);
  const line = office && role ? await feedback(office, role, proposalFeedbackLine(row, { accepted: false, note: reason }, actor)) : null;
  await storage.appendEvent({
    kind: 'office.proposal-decided',
    actor,
    repoId: row.repoId ?? undefined,
    runId: row.runId,
    data: { officeId: row.officeId, roleId: row.roleId, proposalId: id, shiftId: row.shiftId, accepted: false, tainted: row.taintedAt !== null, feedback: line !== null, ...(reason ? { note: reason } : {}) },
  });
  broadcast({ type: 'office-proposal.updated', proposal: row });
  return { ok: true, proposal: row, feedback: line };
}
