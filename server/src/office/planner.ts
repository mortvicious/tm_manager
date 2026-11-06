// The office planner (docs/office.md § Office planner): the owner's assistant
// that designs an office before it exists and tunes it afterwards. It is not a
// role: it never takes a shift, never files tasks, never wakes on its own.
// Each turn is a chat aux terminal of the workspace's planner chat
// (ChatService); this module decides what the planner READS, what it may
// PROPOSE, and how a proposal is APPLIED:
//
// - trusted only: the prompt is the owner's words plus a snapshot of
//   server-known fields (settings, role definitions, states, shift verdicts,
//   spend, the human-edited vision/priorities, the server-written
//   planner.md). Never a note, brief, signal, message body or a shift's error
//   text — and the whole office folder is denied to its tools;
// - read-only: `READ_ONLY_TOOLS` (no web tools), the read-only denials,
//   `dontAsk`, cwd = a scratch dir outside every checkout, `--add-dir` per workspace repo;
// - a proposal is a blueprint (no office yet) or a diff with the fingerprint
//   of the office state the planner was shown; checked by the SAME validators
//   the office routes run (at accept time, so a bad cron is corrected in the
//   session, and again at Apply), and applied only through `officeWrites` —
//   never a second path into storage.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  CONCURRENCY_MAX,
  EFFORT_LEVELS,
  MODEL_OPTIONS,
  OFFICE_AUTONOMY_LEVELS,
  OFFICE_BLUEPRINT_DOC_MAX,
  OFFICE_BLUEPRINT_ROLES_MAX,
  OFFICE_BLUEPRINT_ROLE_FIELDS,
  OFFICE_EVENT_NAMES,
  OFFICE_GUARD_KINDS,
  OFFICE_MAX_OPEN_TASKS_MAX,
  OFFICE_MAX_TASKS_PER_SHIFT_MAX,
  OFFICE_PLANNER_GOAL_LABELS,
  OFFICE_PLANNER_LOG_ENTRIES,
  OFFICE_ROLE_KEY_RE,
  OFFICE_ROLE_PRESETS,
  OFFICE_SIGNAL_SOURCES,
  SHIFT_READ_TOOLS,
  SHIFT_TOOL_ALLOWLIST,
  SHIFT_WEB_TOOLS,
  blueprintAsDiff,
  isEmptyBlueprintDiff,
  plannerFingerprintInput,
  wizardDayBudget,
  type Chat,
  type ChatMessage,
  type Office,
  type OfficeAutonomy,
  type OfficeBlueprint,
  type OfficeBlueprintDiff,
  type OfficeBlueprintRole,
  type OfficePlannerProposal,
  type OfficePlannerWizard,
  type OfficeRole,
  type OfficeRolePreset,
} from '@tm/shared';
import { READ_ONLY_TOOLS, extractJson, type AuxAccept } from '../claude/aux.ts';
import { CONVERSATIONAL_REPLY_RULE } from '../claude/reply-style.ts';
import { officeWriteBodies, officeWrites, checkRoleFields, type OfficeWriteOut } from '../routes/offices.ts';
import type { Storage } from '../storage/types.ts';
import { readOfficeDoc, saveOfficeDoc, type DirectorWaker } from './docs.ts';
import { plannerDenies } from './isolation.ts';
import { OFFICE_PRESETS } from './presets.ts';
import { officeStates } from './scheduler.ts';
import { writeOfficeFile } from './shift-result.ts';
import { readOfficeText } from './shift.ts';
import { officeRepos } from './chat.ts';

/** The server-written planner log in the office folder (only Apply writes it). */
export const PLANNER_LOG_REL = 'planner.md';
const PLANNER_LOG_READ_MAX = 24_000;
/** Earlier messages a FRESH planner session is shown (newest kept)… */
const FRESH_TRANSCRIPT_MESSAGES = 30;
/** …and at most this many characters of them. */
const FRESH_TRANSCRIPT_CHARS = 40_000;
/** Recent shifts the snapshot lists. */
const SNAPSHOT_SHIFTS = 30;
/** A role prompt in the snapshot is clipped here. */
const SNAPSHOT_PROMPT_CHARS = 1_500;
/** A doc in the snapshot is clipped here. */
const SNAPSHOT_DOC_CHARS = 6_000;
/** The model every planner turn runs on (the agent model; CLAUDE.md § Rules). */
export const PLANNER_MODEL = 'claude-opus-5-5';

/** Planner proposals never carry a web tool's schema or a write tool (the session stays trusted and read-only). */
export const PLANNER_DISALLOWED_EXTRA: readonly string[] = SHIFT_WEB_TOOLS;

// ---------------------------------------------------------------------------
// Shapes (zod): what the planner may return. Content rules — cron parses,
// guards/triggers well-formed, tools allowed, model offered — are the office
// routes' own `checkRoleFields`, run by `checkPlannerDiff`.
// ---------------------------------------------------------------------------

const autonomy = z.enum(OFFICE_AUTONOMY_LEVELS as [OfficeAutonomy, ...OfficeAutonomy[]]);
const money = z.number().finite().min(0).max(100_000);
const settingsShape = {
  maxSlots: z.number().int().min(1).max(CONCURRENCY_MAX),
  dayBudgetUsd: money,
  maxTasksPerShift: z.number().int().min(1).max(OFFICE_MAX_TASKS_PER_SHIFT_MAX),
  maxOpenTasks: z.number().int().min(1).max(OFFICE_MAX_OPEN_TASKS_MAX),
  autonomy,
};
const guardShape = z
  .object({ kind: z.enum(OFFICE_GUARD_KINDS as [string, ...string[]]) })
  .passthrough()
  .describe('a guard: {"kind": …} plus its fields (see the prompt)');
const triggerShape = z
  .object({ kind: z.enum(['event', 'signal', 'command-done']) })
  .passthrough()
  .describe('a trigger: {"kind": "event", "event": …} | {"kind": "signal", "source": …} | {"kind": "command-done"}');
const roleFieldShape = {
  title: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(20_000),
  model: z.string().min(1),
  effort: z.enum(EFFORT_LEVELS as [string, ...string[]]).nullable(),
  tools: z.array(z.string()).max(20),
  schedules: z.array(z.string()).max(10).describe('5-field cron lines in the office time zone'),
  guards: z.array(guardShape).max(10),
  triggers: z.array(triggerShape).max(10),
  capUsd: money.nullable(),
  autonomy: autonomy.nullable().describe('null = the office autonomy'),
};
const why = z.string().trim().max(300);
const roleShape = z
  .object({
    key: z.string().trim().min(1).max(40),
    preset: z.enum(OFFICE_ROLE_PRESETS as [string, ...string[]]).nullable(),
    why,
    ...roleFieldShape,
  })
  .strict();
const roleEditShape = z
  .object({ key: z.string().trim().min(1).max(40), why: why.optional(), ...z.object(roleFieldShape).partial().shape })
  .strict();
const costShape = z.object({ dailyUsd: money, derivation: z.string().trim().min(1).max(2_000) }).strict();
const doc = z.string().max(OFFICE_BLUEPRINT_DOC_MAX);

export const blueprintSchema = z
  .object({
    summary: z.string().trim().min(1).max(2_000),
    office: z.object(settingsShape).strict(),
    roles: z.array(roleShape).min(1).max(OFFICE_BLUEPRINT_ROLES_MAX),
    vision: doc,
    priorities: doc,
    wins: z.array(z.string().trim().min(1).max(400)).min(3).max(6),
    avoid: z.array(z.string().trim().min(1).max(400)).max(6),
    cost: costShape,
  })
  .strict();

export const diffSchema = z
  .object({
    summary: z.string().trim().min(1).max(2_000),
    office: z.object(settingsShape).partial().strict().optional(),
    addRoles: z.array(roleShape).max(OFFICE_BLUEPRINT_ROLES_MAX).optional(),
    editRoles: z.array(roleEditShape).max(OFFICE_BLUEPRINT_ROLES_MAX * 2).optional(),
    removeRoles: z.array(z.string().trim().min(1).max(40)).max(OFFICE_BLUEPRINT_ROLES_MAX * 2).optional(),
    vision: doc.optional(),
    priorities: doc.optional(),
    cost: costShape.optional(),
  })
  .strict();

const blueprintReply = z.object({ blueprint: blueprintSchema }).strict();
const diffReply = z.object({ diff: diffSchema }).strict();

const issues = (e: z.ZodError): string => e.issues.map((i) => `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`).join('; ');

// ---------------------------------------------------------------------------
// Validation — the routes' own validators over every field
// ---------------------------------------------------------------------------

/** The role list the presets create (what a new office starts with). */
export function presetRoles(): { key: string; preset: OfficeRolePreset }[] {
  return OFFICE_ROLE_PRESETS.map((p) => ({ key: OFFICE_PRESETS[p].key, preset: p }));
}

const roleFieldsOf = (r: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of OFFICE_BLUEPRINT_ROLE_FIELDS) if (r[k] !== undefined) out[k] = r[k];
  return out;
};

/**
 * Is this diff appliable to an office with `cur`? The route bodies' zod
 * shapes, then `checkRoleFields` (cron, guards, triggers, tools, model) and
 * the key rules, field by field. The first refusal wins, as the route's would.
 */
export function checkPlannerDiff(
  diff: OfficeBlueprintDiff,
  cur: { office: Pick<Office, 'enabled' | 'dayBudgetUsd'> | null; roles: readonly { key: string; preset?: string | null }[] },
): string | null {
  const shape = diffSchema.safeParse(diff);
  if (!shape.success) return issues(shape.error);
  if (diff.office && Object.keys(diff.office).length) {
    const p = officeWriteBodies.officePatchBody.safeParse(diff.office);
    if (!p.success) return `office: ${issues(p.error)}`;
    const budget = diff.office.dayBudgetUsd ?? cur.office?.dayBudgetUsd ?? 0;
    if (cur.office?.enabled && !(budget > 0)) return 'office: an enabled office needs a day budget above $0: disable it first';
  }
  const keys = new Set(cur.roles.map((r) => r.key));
  const removed = new Set<string>();
  for (const key of diff.removeRoles ?? []) {
    if (!keys.has(key)) return `removeRoles: this office has no role "${key}"`;
    if (removed.has(key)) return `removeRoles: "${key}" listed twice`;
    removed.add(key);
  }
  const edited = new Set<string>();
  for (const e of diff.editRoles ?? []) {
    if (!keys.has(e.key)) return `editRoles: this office has no role "${e.key}"`;
    if (removed.has(e.key)) return `editRoles: "${e.key}" is also removed`;
    if (edited.has(e.key)) return `editRoles: "${e.key}" listed twice`;
    edited.add(e.key);
    const p = officeWriteBodies.rolePatchBody.safeParse(roleFieldsOf(e as Record<string, unknown>));
    if (!p.success) return `role "${e.key}": ${issues(p.error)}`;
    const c = checkRoleFields(p.data);
    if ('error' in c) return `role "${e.key}": ${c.error}`;
  }
  const added = new Set<string>();
  for (const a of diff.addRoles ?? []) {
    if (!OFFICE_ROLE_KEY_RE.test(a.key)) {
      return `role "${a.key}": key must be lowercase letters and digits in dash-separated words (like "qa" or "release-notes")`;
    }
    if (keys.has(a.key) && !removed.has(a.key)) return `addRoles: this office already has a role with key "${a.key}"`;
    if (added.has(a.key)) return `addRoles: "${a.key}" listed twice`;
    added.add(a.key);
    const p = officeWriteBodies.roleCreateBody.safeParse({ key: a.key, preset: a.preset, ...roleFieldsOf(a as unknown as Record<string, unknown>) });
    if (!p.success) return `role "${a.key}": ${issues(p.error)}`;
    const { key: _k, preset: _p, ...fields } = p.data;
    const c = checkRoleFields(fields);
    if ('error' in c) return `role "${a.key}": ${c.error}`;
  }
  return null;
}

/** Is this blueprint appliable as a new office (presets kept by their own key, the rest custom)? */
export function checkBlueprint(b: OfficeBlueprint): string | null {
  const shape = blueprintSchema.safeParse(b);
  if (!shape.success) return issues(shape.error);
  const presetKey = new Map<string, OfficeRolePreset>(presetRoles().map((r) => [r.key, r.preset]));
  const seenPresets = new Set<string>();
  for (const r of b.roles) {
    if (r.preset) {
      const want = OFFICE_PRESETS[r.preset].key;
      if (r.key !== want) return `role "${r.key}": a kept ${r.preset} preset keeps its key "${want}"`;
      if (seenPresets.has(r.preset)) return `role "${r.key}": the ${r.preset} preset is listed twice`;
      seenPresets.add(r.preset);
    } else if (presetKey.has(r.key)) {
      return `role "${r.key}": that key is the ${presetKey.get(r.key)} preset's — set "preset": "${presetKey.get(r.key)}", or pick another key`;
    }
  }
  return checkPlannerDiff(blueprintAsDiff(b, presetRoles()), { office: null, roles: presetRoles() });
}

// ---------------------------------------------------------------------------
// Fingerprint — what makes a diff stale
// ---------------------------------------------------------------------------

/** sha256 of the office's plannable state (`plannerFingerprintInput`): settings, roles, the two docs. */
export async function officeFingerprint(storage: Storage, office: Office): Promise<string> {
  const roles = await storage.listOfficeRoles(office.id);
  const sha = (name: 'vision.md' | 'priorities.md') => {
    const d = readOfficeDoc(office, name);
    return d.exists ? d.sha256 : null;
  };
  return createHash('sha256')
    .update(plannerFingerprintInput(office, roles, { vision: sha('vision.md'), priorities: sha('priorities.md') }))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Apply — only through the office routes' writes
// ---------------------------------------------------------------------------

export type PlannerApplyOutcome =
  | { ok: true; office: Office; roles: OfficeRole[]; applied: string[] }
  | { ok: false; code: number; error: string; applied: string[] };

const errorOf = (r: OfficeWriteOut): string => {
  const b = r.body as { error?: unknown } | null;
  return typeof b?.error === 'string' ? b.error : `refused (${r.code})`;
};
const ok2xx = (r: OfficeWriteOut) => r.code >= 200 && r.code < 300;

export interface PlannerApplyDeps {
  storage: Storage;
  /** the Director waker a doc change goes through (null in tests) */
  waker?: DirectorWaker | null;
}

/**
 * Run a CHECKED diff against `office` through the office writes, in the order
 * least likely to be refused half-way: office settings, removals, edits,
 * additions, then the docs. A refusal stops the run and names what already
 * ran (only a race between the check and the write can cause one).
 */
export async function applyPlannerDiff(deps: PlannerApplyDeps, office: Office, diff: OfficeBlueprintDiff): Promise<PlannerApplyOutcome> {
  const { storage } = deps;
  const w = officeWrites(storage);
  const applied: string[] = [];
  const stop = (r: OfficeWriteOut, what: string): PlannerApplyOutcome => ({
    ok: false,
    code: r.code,
    error: `${what}: ${errorOf(r)}${applied.length ? ` (already applied: ${applied.join('; ')})` : ''}`,
    applied,
  });
  if (diff.office && Object.keys(diff.office).length) {
    const r = await w.patchOffice(office.id, officeWriteBodies.officePatchBody.parse(diff.office));
    if (!ok2xx(r)) return stop(r, 'office settings');
    applied.push(`office: ${Object.keys(diff.office).join(', ')}`);
  }
  const byKey = async () => new Map((await storage.listOfficeRoles(office.id)).map((r) => [r.key, r]));
  let roles = await byKey();
  for (const key of diff.removeRoles ?? []) {
    const role = roles.get(key);
    if (!role) return stop({ code: 409, body: { error: `role "${key}" is gone` } }, `remove ${key}`);
    const r = await w.deleteRole(office.id, role.id);
    if (!ok2xx(r)) return stop(r, `remove ${key}`);
    applied.push(`removed ${key}`);
  }
  roles = await byKey();
  for (const e of diff.editRoles ?? []) {
    const role = roles.get(e.key);
    if (!role) return stop({ code: 409, body: { error: `role "${e.key}" is gone` } }, `edit ${e.key}`);
    const fields = roleFieldsOf(e as Record<string, unknown>);
    if (!Object.keys(fields).length) continue;
    const r = await w.patchRole(office.id, role.id, officeWriteBodies.rolePatchBody.parse(fields));
    if (!ok2xx(r)) return stop(r, `edit ${e.key}`);
    applied.push(`edited ${e.key}: ${Object.keys(fields).join(', ')}`);
  }
  for (const a of diff.addRoles ?? []) {
    const r = await w.createRole(
      office.id,
      officeWriteBodies.roleCreateBody.parse({ key: a.key, preset: a.preset, ...roleFieldsOf(a as unknown as Record<string, unknown>) }),
    );
    if (!ok2xx(r)) return stop(r, `add ${a.key}`);
    applied.push(`added ${a.key}`);
  }
  for (const name of ['vision.md', 'priorities.md'] as const) {
    const content = name === 'vision.md' ? diff.vision : diff.priorities;
    if (content === undefined) continue;
    const fresh = (await storage.getOffice(office.id)) ?? office;
    await saveOfficeDoc({ storage, waker: deps.waker ?? null }, fresh, name, content, { actor: 'human' });
    applied.push(`wrote ${name}`);
  }
  const fresh = (await storage.getOffice(office.id)) ?? office;
  return { ok: true, office: fresh, roles: await storage.listOfficeRoles(office.id), applied };
}

export interface PlannerCreateInput {
  workspaceId: string;
  folderPath?: string;
  timezone?: string;
  theme?: string;
}

/**
 * A blueprint → a new, DISABLED office: checked first (nothing is created for
 * a refused blueprint), then the office route's own create (presets, folder
 * rule, one office per workspace), then the blueprint as a diff over the
 * presets. A refusal after the create removes the office again — all or
 * nothing, like the create route's own scaffold failure.
 */
export async function applyBlueprint(deps: PlannerApplyDeps, input: PlannerCreateInput, b: OfficeBlueprint): Promise<PlannerApplyOutcome> {
  const bad = checkBlueprint(b);
  if (bad) return { ok: false, code: 400, error: bad, applied: [] };
  const w = officeWrites(deps.storage);
  const created = await w.createOffice(officeWriteBodies.createBody.parse(input));
  if (!ok2xx(created)) return { ok: false, code: created.code, error: errorOf(created), applied: [] };
  const { office, roles } = created.body as { office: Office; roles: OfficeRole[] };
  const res = await applyPlannerDiff(deps, office, blueprintAsDiff(b, roles));
  if (!res.ok) {
    await deps.storage.deleteOffice(office.id).catch(() => {});
    return { ...res, error: `${res.error} — the office was not created` };
  }
  return { ...res, applied: ['created the office', ...res.applied] };
}

/** Append what Apply did to `planner.md` (newest last, `OFFICE_PLANNER_LOG_ENTRIES` kept). Best effort. */
export function writePlannerLog(office: Office, entry: { at: string; summary: string; applied: string[]; blueprint?: OfficeBlueprint }): void {
  try {
    const cur = readOfficeText(office, PLANNER_LOG_REL, PLANNER_LOG_READ_MAX * 4) ?? '';
    const parts = cur.split(/\n(?=## Applied )/).filter((p) => p.startsWith('## Applied '));
    const lines = [`## Applied ${entry.at}`, '', entry.summary.trim(), ''];
    if (entry.blueprint) {
      const b = entry.blueprint;
      lines.push('First wins:', ...b.wins.map((x) => `- ${x}`), '');
      if (b.avoid.length) lines.push('Not for this office:', ...b.avoid.map((x) => `- ${x}`), '');
      lines.push(`Estimated cost: $${b.cost.dailyUsd.toFixed(2)}/day — ${b.cost.derivation}`, '');
    }
    lines.push('Changes:', ...entry.applied.map((x) => `- ${x}`), '');
    const kept = [...parts, lines.join('\n')].slice(-OFFICE_PLANNER_LOG_ENTRIES);
    const head = '# Office planner log\n\nWritten by the Task Manager when the owner applies a planner blueprint or diff (docs/office.md § Office planner). Do not edit — it is rewritten.\n';
    writeOfficeFile(office, PLANNER_LOG_REL, `${head}\n${kept.join('\n').trimEnd()}\n`);
  } catch (e) {
    console.warn(`office ${office.id}: planner.md not written:`, (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

/** What a planner turn returned: the prose, and its proposal if it made one. */
export interface PlannerReply {
  text: string;
  proposal: OfficePlannerProposal | null;
}

export interface PlannerTurnPlan {
  mode: 'blueprint' | 'diff';
  prompt: string;
  cwd: string;
  addDirs: string[];
  /** `permissions.deny`: the whole office folder (empty before one exists) */
  denies: string[];
  /** `--tools`: READ_ONLY_TOOLS — no web tool, no write tool */
  tools: string[];
  resumeSessionId: string | null;
  baselineTranscript: string | null;
  appendSystemPrompt: string;
  label: string;
  accept: (text: string) => AuxAccept<PlannerReply>;
}

/** The prose of a reply without its trailing ```json proposal. */
export function replyProse(text: string): string {
  const i = text.lastIndexOf('```json');
  return (i >= 0 ? text.slice(0, i) : text).trim();
}

/** The wizard's answers as the owner's first message (what the transcript shows). */
export function wizardMessage(w: OfficePlannerWizard): string {
  const lines = [
    'Plan an office for this workspace.',
    `- Goals: ${w.goals.length ? w.goals.map((g) => OFFICE_PLANNER_GOAL_LABELS[g]).join(', ') : '(none ticked)'}`,
    `- Hands-off: ${w.autonomy}`,
    `- Budget: $${w.budget.amountUsd} per ${w.budget.per} (≈ $${wizardDayBudget(w).toFixed(2)}/day)`,
    `- Quiet hours: ${w.quietHours ? `${w.quietHours.from}–${w.quietHours.to}` : 'none'} · time zone ${w.timezone}`,
  ];
  if (w.wants.trim()) lines.push('', w.wants.trim());
  return lines.join('\n');
}

const json = (v: unknown) => JSON.stringify(v, null, 1);

/** The vocabulary the validators accept, so a blueprint passes them first time. */
function referenceBlock(): string[] {
  return [
    '## What a role may hold (the server validates every field)',
    '',
    `- model: one of ${MODEL_OPTIONS.join(', ')}; effort: ${EFFORT_LEVELS.join(' | ')} or null.`,
    `- tools: a subset of ${SHIFT_TOOL_ALLOWLIST.join(', ')}. Prefer ${SHIFT_READ_TOOLS.join(', ')}: ${SHIFT_WEB_TOOLS.join(' and ')} read the open internet, which TAINTS every shift that uses them (drafts only). Never Bash, Edit, Write or NotebookEdit — they are refused.`,
    '- schedules: 5-field cron lines (minute hour day-of-month month day-of-week) read in the office time zone, like "0 9 * * 1-5".',
    `- guards (all must pass for a scheduled/event wake): ${OFFICE_GUARD_KINDS.join(', ')}. Fields: open-bugs-below {"n": int}, budget-left {"minUsd"?: number}, quiet-hours {"from": "HH:MM", "to": "HH:MM"}, cooldown {"minutes": int}, briefs-since {"orTasksLanded"?: bool}; the rest have no fields.`,
    `- triggers: {"kind":"event","event": one of ${OFFICE_EVENT_NAMES.join(', ')}} | {"kind":"signal","source": one of ${OFFICE_SIGNAL_SOURCES.join(', ')}} (signals taint the shift) | {"kind":"command-done"}.`,
    '- capUsd: the role\'s own day cap in USD or null; autonomy: proposals | auto-run | autonomous, or null for the office\'s.',
    `- office: maxSlots 1–${CONCURRENCY_MAX}, dayBudgetUsd > 0, maxTasksPerShift 1–${OFFICE_MAX_TASKS_PER_SHIFT_MAX}, maxOpenTasks 1–${OFFICE_MAX_OPEN_TASKS_MAX}, autonomy proposals | auto-run | autonomous.`,
    '- A role key is lowercase words joined by dashes ("qa", "release-notes"). Presets keep their own key.',
    '',
    '## The presets',
    '',
    ...OFFICE_ROLE_PRESETS.map((p) => {
      const d = OFFICE_PRESETS[p];
      return `- ${p} (key "${d.key}"): ${d.title} — ${d.summary}. Default schedules ${json(d.schedules)}, effort ${d.effort}.`;
    }),
  ];
}

/** The office as the planner may see it: server-known fields only, never a note, brief, signal or message text. */
async function officeSnapshot(storage: Storage, office: Office): Promise<string[]> {
  const roles = await storage.listOfficeRoles(office.id);
  const states = await officeStates(storage, office.id).catch(() => null);
  const since7 = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const shifts = (await storage.listShifts({ officeId: office.id, limit: SNAPSHOT_SHIFTS })).filter((s) => s.startedAt >= since7);
  const keyOf = new Map(roles.map((r) => [r.id, r.key]));
  const roleRows = await Promise.all(
    roles.map(async (r) => {
      const st = states?.states.find((s) => s.roleId === r.id);
      return {
        key: r.key,
        preset: r.preset,
        name: r.name,
        title: r.title,
        enabled: r.enabled,
        model: r.model,
        effort: r.effort,
        tools: r.tools,
        schedules: r.schedules,
        guards: r.guards,
        triggers: r.triggers,
        capUsd: r.capUsd,
        autonomy: r.autonomy,
        allowlistedCommands: r.commands.length,
        notesTainted: r.notesTaintedAt !== null,
        state: st?.state ?? null,
        nextShiftAt: st?.nextSlotAt ?? null,
        spentTodayUsd: st?.spentTodayUsd ?? null,
        spent7dUsd: Math.round((await storage.officeSpendSince(office.id, since7, r.id)) * 100) / 100,
        openTasks: await storage.countOpenOfficeTasks(office.id, r.id),
        prompt: r.prompt.length > SNAPSHOT_PROMPT_CHARS ? `${r.prompt.slice(0, SNAPSHOT_PROMPT_CHARS)}…` : r.prompt,
      };
    }),
  );
  // a shift's verdict and the server's own skip reason — never its error text or output (a tainted shift wrote those)
  const shiftRows = shifts.map((s) => ({
    role: keyOf.get(s.roleId) ?? '(deleted role)',
    trigger: s.trigger.kind,
    at: s.startedAt,
    verdict: s.verdict,
    skipCode: s.skipCode,
    skipReason: s.verdict === 'skipped' ? s.skipReason : null,
    costUsd: s.costUsd,
    tainted: s.tainted,
    filedTasks: s.filedTaskIds.length,
  }));
  const settings = {
    enabled: office.enabled,
    paused: office.pausedAt ? (office.pausedReason ?? 'paused') : null,
    timezone: office.timezone,
    autonomy: office.autonomy,
    dayBudgetUsd: office.dayBudgetUsd,
    maxSlots: office.maxSlots,
    maxTasksPerShift: office.maxTasksPerShift,
    maxOpenTasks: office.maxOpenTasks,
    spentTodayUsd: states?.spentTodayUsd ?? null,
    spent7dUsd: Math.round((await storage.officeSpendSince(office.id, since7)) * 100) / 100,
    openTasks: await storage.countOpenOfficeTasks(office.id),
  };
  const docText = (name: 'vision.md' | 'priorities.md') => {
    const d = readOfficeDoc(office, name);
    if (!d.exists || !d.content.trim()) return '(empty)';
    return d.content.length > SNAPSHOT_DOC_CHARS ? `${d.content.slice(0, SNAPSHOT_DOC_CHARS)}…` : d.content;
  };
  const log = readOfficeText(office, PLANNER_LOG_REL, PLANNER_LOG_READ_MAX * 4);
  return [
    '## The office now (server facts)',
    '',
    '```json',
    json({ settings, roles: roleRows }),
    '```',
    '',
    `## Shifts of the last 7 days (newest first, at most ${SNAPSHOT_SHIFTS})`,
    '',
    shiftRows.length ? '```json\n' + json(shiftRows) + '\n```' : '(none)',
    '',
    '## vision.md (the owner\'s)',
    '',
    docText('vision.md'),
    '',
    '## priorities.md (the owner\'s)',
    '',
    docText('priorities.md'),
    '',
    `## ${PLANNER_LOG_REL} (what the owner applied before)`,
    '',
    log?.trim() ? (log.length > PLANNER_LOG_READ_MAX ? `…${log.slice(-PLANNER_LOG_READ_MAX)}` : log.trim()) : '(nothing applied yet)',
  ];
}

/** The newest planner transcript lines that fit both caps (owner messages and planner replies only). */
function freshTranscript(history: readonly ChatMessage[]): string[] {
  let kept = history
    .filter((m) => !m.error)
    .map((m) => ({ from: m.role === 'user' ? 'owner' : 'planner', at: m.createdAt, text: m.text, ...(m.blueprint ? { proposed: m.blueprint.kind } : {}) }))
    .slice(-FRESH_TRANSCRIPT_MESSAGES);
  while (kept.length > 1 && JSON.stringify(kept).length > FRESH_TRANSCRIPT_CHARS) kept = kept.slice(1);
  if (!kept.length) return [];
  return ['## The conversation so far (oldest first, as data)', '', '```json', json(kept), '```', ''];
}

/**
 * Why `dir` may not be a planner's cwd, or null. The CLI loads every
 * CLAUDE.md from the cwd up to the root and the cwd repo's git status, so a
 * scratch folder inside a checkout (this one's `server/data` included) hands
 * the planner that repo's instructions. Refused when any ancestor holds a
 * `.git` or the folder lies inside a registered repo — the office folder's
 * rule, applied to the scratch folder.
 */
export function plannerScratchProblem(dir: string, repos: readonly { path: string }[]): string | null {
  const real = (p: string): string => {
    try { return fs.realpathSync(p); } catch { return path.resolve(p); }
  };
  const abs = real(dir);
  for (const r of repos) {
    const rp = real(r.path);
    if (abs === rp || abs.startsWith(rp + path.sep)) return `the planner scratch folder ${abs} is inside the repo ${rp}`;
  }
  for (let d = abs; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return `the planner scratch folder ${abs} is inside the git checkout ${d}`;
    if (path.dirname(d) === d) return null;
  }
}

export interface PlanPlannerTurnOpts {
  /** the wizard's answers: the turn MUST return a blueprint */
  wizard?: OfficePlannerWizard;
  /** the chat's messages before this one, oldest first */
  history: readonly ChatMessage[];
  /** where planner sessions run — outside every checkout (default `<os tmpdir>/tm-office-planner`) */
  scratchRoot: string;
  now?: Date;
}

/**
 * Everything one planner turn is spawned with. Resume-or-fresh by size, like
 * a role session: `--resume` while the last turn's context is under
 * `agent.resumeContextCap`, else a fresh session that is shown the recent
 * transcript. Every turn re-reads the office snapshot (it changes between
 * turns) and the base fingerprint the diff it may propose is stamped with.
 */
export async function planPlannerTurn(storage: Storage, chat: Chat, message: string, opts: PlanPlannerTurnOpts): Promise<PlannerTurnPlan & { baseFingerprint: string | null }> {
  const wsId = chat.plannerWorkspaceId;
  if (!wsId) throw new Error('not an office planner chat');
  const ws = await storage.getWorkspace(wsId);
  if (!ws) throw new Error('the workspace this planner belongs to is gone');
  const office = await storage.getOfficeByWorkspace(ws.id);
  const mode: 'blueprint' | 'diff' = office ? 'diff' : 'blueprint';
  const required = !!opts.wizard && mode === 'blueprint';
  const now = opts.now ?? new Date();

  // resume-or-fresh
  const settings = await storage.getSettings();
  const cap = Number(settings['agent.resumeContextCap']) || 300_000;
  const last = chat.sessionId ? (await storage.listRuns({ kind: 'chat', subjectId: chat.id })).find((r) => r.transcriptPath) : undefined;
  const lastTokens = last?.stats?.contextTokens;
  const resume = !!chat.sessionId && typeof lastTokens === 'number' && lastTokens > 0 && lastTokens < cap;

  // where it runs: a scratch dir (never the office folder), the repos as add-dirs
  const repos = office
    ? await officeRepos(storage, office)
    : (await storage.listRepos())
        .filter((r) => ws.repoIds.includes(r.id) && fs.statSync(r.path, { throwIfNoEntry: false })?.isDirectory())
        .map((r) => ({ id: r.id, name: r.name, path: r.path }));
  const cwd = path.join(opts.scratchRoot, ws.id);
  fs.mkdirSync(cwd, { recursive: true });
  const outside = plannerScratchProblem(cwd, await storage.listRepos());
  if (outside) throw new Error(outside);
  const denies = office ? plannerDenies(office) : [];
  const baseFingerprint = office ? await officeFingerprint(storage, office) : null;
  const curRoles = office ? (await storage.listOfficeRoles(office.id)).map((r) => ({ key: r.key, preset: r.preset })) : presetRoles();

  const schema = mode === 'blueprint' ? z.toJSONSchema(blueprintReply) : z.toJSONSchema(diffReply);
  const lines: string[] = [
    `You are the OFFICE PLANNER of the workspace "${ws.name}" — the owner's assistant for its Virtual Office (standing roles that wake on schedules, run one read-only shift and file the work they find as tasks).`,
    'You are not a role: you never take a shift, file a task or change anything yourself. You advise, and you PROPOSE; the owner applies a proposal with one click, and nothing changes without it.',
    `Now: ${now.toISOString()}.`,
    '',
    '## Where you are',
    '',
    `Read-only: Read, Glob, Grep (and Agent for a read-only subagent). Your working directory is a scratch folder. The workspace's repos are readable at:`,
    ...(repos.length ? repos.map((r) => `- ${r.name}: ${r.path}`) : ['- (none on disk)']),
    'Ground what you say in them: stack, size, tests, CI, deploy, Sentry/GitHub presence — read before you recommend. The office folder is NOT readable to you; the snapshot below is everything about the office you need.',
    '',
  ];
  if (mode === 'blueprint') {
    lines.push(
      '## The job',
      '',
      'There is no office yet. Design one for these repos: how big (slots, day budget, caps, autonomy), which roles — presets to keep or drop and custom roles — each with its prompt, model/effort, tools, schedules, guards, triggers, cap and a one-line "why"; a draft vision.md and priorities.md; 3–6 concrete first wins for THESE repos and what it should not try; and an estimated daily cost with how you derived it (shifts per day × a typical shift\'s cost per effort).',
      'Respect the owner\'s budget and quiet hours (a quiet-hours guard on every scheduled role) and their time zone. A preset left out of `roles` is dropped.',
      '',
    );
    if (opts.wizard) {
      const w = opts.wizard;
      lines.push(
        '## The owner\'s answers',
        '',
        '```json',
        json({ ...w, dayBudgetUsd: wizardDayBudget(w) }),
        '```',
        '',
      );
    }
  } else {
    lines.push(
      '## The job',
      '',
      'The office exists. Answer the owner\'s question about it. When something SHOULD change (a role added or dropped, a schedule, a budget, a guard, the docs), propose a blueprint DIFF that changes exactly those fields — an edit lists only the fields it changes. Explain a skip from the shift verdicts and guards below, not from guesses.',
      '',
      ...(await officeSnapshot(storage, office!)),
      '',
    );
  }
  lines.push(...referenceBlock(), '');
  if (!resume) lines.push(...freshTranscript(opts.history));
  lines.push('## The owner\'s message', '', message, '');
  if (required) {
    lines.push(
      '## How to return your result',
      '',
      'END your final message with ONE fenced ```json code block that validates against the JSON Schema below — a short prose answer before it, nothing after it.',
      '',
      '```json',
      JSON.stringify(schema),
      '```',
    );
  } else {
    lines.push(
      '## Proposing',
      '',
      mode === 'blueprint'
        ? 'If (and only if) you propose an office or a revised one, END your message with ONE fenced ```json block {"blueprint": …} that validates against the schema below. Answering a question needs no block.'
        : 'If (and only if) something should change, END your message with ONE fenced ```json block {"diff": …} that validates against the schema below. Answering a question needs no block. Never use a ```json fence for anything else.',
      '',
      '```json',
      JSON.stringify(schema),
      '```',
    );
  }

  const accept = (text: string): AuxAccept<PlannerReply> => {
    const raw = extractJson(text);
    if (raw === null || typeof raw !== 'object') {
      return required ? { ok: false, error: 'no ```json block with {"blueprint": …} found at the end of your message' } : { ok: true, value: { text: text.trim(), proposal: null } };
    }
    if (mode === 'blueprint') {
      const p = blueprintReply.safeParse(raw);
      if (!p.success) return { ok: false, error: issues(p.error) };
      const bad = checkBlueprint(p.data.blueprint as OfficeBlueprint);
      if (bad) return { ok: false, error: bad };
      return { ok: true, value: { text: replyProse(text), proposal: { kind: 'blueprint', blueprint: p.data.blueprint as OfficeBlueprint } } };
    }
    const p = diffReply.safeParse(raw);
    if (!p.success) return { ok: false, error: issues(p.error) };
    const d = p.data.diff as OfficeBlueprintDiff;
    if (isEmptyBlueprintDiff(d)) return { ok: true, value: { text: replyProse(text), proposal: null } };
    const bad = checkPlannerDiff(d, { office, roles: curRoles });
    if (bad) return { ok: false, error: bad };
    return { ok: true, value: { text: replyProse(text), proposal: { kind: 'diff', diff: d, baseFingerprint: baseFingerprint! } } };
  };

  return {
    mode,
    prompt: lines.filter((l, i) => !(l === '' && lines[i - 1] === '')).join('\n'),
    cwd,
    addDirs: repos.map((r) => r.path),
    denies,
    tools: [...READ_ONLY_TOOLS],
    resumeSessionId: resume ? chat.sessionId : null,
    baselineTranscript: resume ? (last?.transcriptPath ?? null) : null,
    appendSystemPrompt: CONVERSATIONAL_REPLY_RULE,
    label: `office planner: ${ws.name.slice(0, 60)}`,
    baseFingerprint,
    accept,
  };
}

/** A role of a blueprint, as the SPA's cards show it (exported for tests). */
export type { OfficeBlueprintRole };
