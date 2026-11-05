/**
 * Virtual Office (docs/office.md § Data model) — the SQL both drivers run
 * verbatim, so a column added here cannot land in one driver and not the
 * other. Dialect-neutral with `?` placeholders (the pg driver rewrites them;
 * never put a `?` inside a string literal here). Tables are FK-less
 * (migration 53); the task columns `office_id`/`role_id`/`tainted_at` are
 * migration 54 and create-only. Briefs, proposals and wishes are migration 58;
 * messages, huddles and signals migration 60.
 */
import {
  OFFICE_MAX_OPEN_TASKS_DEFAULT,
  OFFICE_MAX_TASKS_PER_SHIFT_DEFAULT,
  TERMINAL_TASK_STATUSES,
  type EffortLevel,
  type Office,
  type OfficeAutonomy,
  type OfficeBrief,
  type OfficeBriefKind,
  type OfficeProposal,
  type OfficeProposalStatus,
  type OfficeWish,
  type OfficeWishStatus,
  type OfficeGuard,
  type OfficeRole,
  type OfficeRoleCommand,
  type OfficeRolePreset,
  type OfficeShift,
  type OfficeShiftCommands,
  type OfficeShiftFiling,
  type OfficeShiftTriggerKind,
  type OfficeTrigger,
  type OfficeHuddle,
  type OfficeHuddleStatus,
  type OfficeMessage,
  type OfficeMessageKind,
  type OfficeSignal,
  type OfficeSignalSource,
  type OfficeSubject,
} from '@tm/shared';

// ---- shapes ----

/** A new office. Everything but the workspace, folder and timezone has a default. */
export interface NewOffice {
  workspaceId: string;
  folderPath: string;
  timezone: string;
  autonomy?: OfficeAutonomy;
  dayBudgetUsd?: number;
  maxSlots?: number;
  maxTasksPerShift?: number;
  maxOpenTasks?: number;
  theme?: string | null;
  enabled?: boolean;
}

/**
 * The editable office fields. `workspaceId` is create-only (one office per
 * workspace), and `pausedAt`/`pausedReason` belong to the conditional
 * `pauseOffice` alone — a plain patch can never un-pause an office it did not
 * see paused.
 */
export type OfficePatch = Partial<
  Pick<
    Office,
    | 'folderPath'
    | 'autonomy'
    | 'dayBudgetUsd'
    | 'maxSlots'
    | 'maxTasksPerShift'
    | 'maxOpenTasks'
    | 'budgetTrippedOn'
    | 'theme'
    | 'timezone'
    | 'enabled'
  >
>;

export interface NewOfficeRole {
  officeId: string;
  preset?: OfficeRolePreset | null;
  key: string;
  name: string;
  avatar: string;
  title: string;
  prompt: string;
  model: string;
  effort?: EffortLevel | null;
  tools: string[];
  autonomy?: OfficeAutonomy | null;
  capUsd?: number | null;
  schedules?: string[];
  triggers?: OfficeTrigger[];
  guards?: OfficeGuard[];
  notesPath: string;
  enabled?: boolean;
  /** default: the creation time */
  armedAt?: string;
}

/** Every role field but its id and office (a role never moves between offices). */
export type OfficeRolePatch = Partial<Omit<OfficeRole, 'id' | 'officeId'>>;

export interface NewOfficeShift {
  officeId: string;
  roleId: string;
  trigger: { kind: OfficeShiftTriggerKind; ref: string | null; at: string };
  verdict: OfficeShift['verdict'];
  skipReason?: string | null;
  /** the gate's code for a skip (`OfficeShift.skipCode`) */
  skipCode?: string | null;
  runId?: string | null;
  tainted?: boolean;
  taintSources?: string[];
  /** default: now */
  startedAt?: string;
  /** a skipped shift is over the moment it is written */
  endedAt?: string | null;
  error?: string | null;
}

/** What a running shift fills in as it goes; the trigger, office and role are fixed. */
export type OfficeShiftPatch = Partial<
  Pick<
    OfficeShift,
    'verdict' | 'skipReason' | 'runId' | 'costUsd' | 'tainted' | 'taintSources' | 'briefId' | 'filedTaskIds' | 'filing' | 'commands' | 'endedAt' | 'error'
  >
>;

export interface OfficeShiftFilter {
  officeId?: string;
  roleId?: string;
  verdict?: OfficeShift['verdict'];
  triggerKind?: OfficeShift['trigger']['kind'];
  /** started at or after (ISO) */
  since?: string;
  /** started strictly before (ISO) */
  until?: string;
  /** shifts with no `ended_at` */
  open?: boolean;
  /** default 500, capped at 5000 */
  limit?: number;
}

// ---- offices ----

export const OFFICE_INSERT_SQL = `INSERT INTO tm_offices (id, workspace_id, folder_path, autonomy, day_budget_usd, max_slots, max_tasks_per_shift, max_open_tasks, paused_at, paused_reason, budget_tripped_on, theme, timezone, enabled, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)`;

export function officeInsertParams(id: string, o: NewOffice, at: string): unknown[] {
  return [
    id,
    o.workspaceId,
    o.folderPath,
    o.autonomy ?? 'proposals',
    o.dayBudgetUsd ?? 0,
    o.maxSlots ?? 1,
    o.maxTasksPerShift ?? OFFICE_MAX_TASKS_PER_SHIFT_DEFAULT,
    o.maxOpenTasks ?? OFFICE_MAX_OPEN_TASKS_DEFAULT,
    o.theme ?? null,
    o.timezone,
    o.enabled ? 1 : 0,
    at,
    at,
  ];
}

export const OFFICE_LIST_SQL = `SELECT * FROM tm_offices ORDER BY created_at ASC, id ASC`;
export const OFFICE_GET_SQL = `SELECT * FROM tm_offices WHERE id = ?`;
export const OFFICE_BY_WORKSPACE_SQL = `SELECT * FROM tm_offices WHERE workspace_id = ?`;
export const OFFICE_DELETE_SQL = `DELETE FROM tm_offices WHERE id = ?`;
/** an office's roles and shifts go with it (FK-less, so by hand) */
export const OFFICE_ROLES_DELETE_SQL = `DELETE FROM tm_office_roles WHERE office_id = ?`;
export const OFFICE_SHIFTS_DELETE_SQL = `DELETE FROM tm_office_shifts WHERE office_id = ?`;

const OFFICE_PATCH_COLUMNS: Record<keyof OfficePatch, [string, (v: any) => unknown]> = {
  folderPath: ['folder_path', (v) => v],
  autonomy: ['autonomy', (v) => v],
  dayBudgetUsd: ['day_budget_usd', (v) => v],
  maxSlots: ['max_slots', (v) => v],
  maxTasksPerShift: ['max_tasks_per_shift', (v) => v],
  maxOpenTasks: ['max_open_tasks', (v) => v],
  budgetTrippedOn: ['budget_tripped_on', (v) => v],
  theme: ['theme', (v) => v],
  timezone: ['timezone', (v) => v],
  enabled: ['enabled', (v) => (v ? 1 : 0)],
};

export function officePatchSql(id: string, p: OfficePatch, at: string): { sql: string; params: unknown[] } | null {
  return patchSql('tm_offices', OFFICE_PATCH_COLUMNS, id, p, at);
}

/**
 * `pauseOffice`'s conditional write: `reason` = pause (stamp `paused_at`),
 * null = resume (clear both). It lands only while the row's pause state is
 * the one the caller saw (`expectedPaused`), so a budget trip racing a
 * human's Resume cannot silently undo either: the loser gets null back and
 * re-reads. Pausing an office already paused (expectedPaused true) replaces
 * the reason but keeps the original `paused_at`.
 */
export function officePauseSql(
  id: string,
  reason: string | null,
  expectedPaused: boolean,
  at: string,
): { sql: string; params: unknown[] } {
  const guard = expectedPaused ? `paused_at IS NOT NULL` : `paused_at IS NULL`;
  if (reason === null) {
    return {
      sql: `UPDATE tm_offices SET paused_at = NULL, paused_reason = NULL, updated_at = ? WHERE id = ? AND ${guard} RETURNING *`,
      params: [at, id],
    };
  }
  return {
    sql: `UPDATE tm_offices SET paused_at = COALESCE(paused_at, ?), paused_reason = ?, updated_at = ? WHERE id = ? AND ${guard} RETURNING *`,
    params: [at, reason, at, id],
  };
}

export function rowToOffice(r: any): Office {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    folderPath: r.folder_path,
    autonomy: r.autonomy,
    dayBudgetUsd: Number(r.day_budget_usd ?? 0) || 0,
    maxSlots: Number(r.max_slots ?? 0),
    maxTasksPerShift: Number(r.max_tasks_per_shift ?? 0),
    maxOpenTasks: Number(r.max_open_tasks ?? 0),
    pausedAt: r.paused_at ?? null,
    pausedReason: r.paused_reason ?? null,
    budgetTrippedOn: r.budget_tripped_on ?? null,
    theme: r.theme ?? null,
    timezone: r.timezone,
    enabled: !!Number(r.enabled),
  };
}

// ---- roles ----

export const OFFICE_ROLE_INSERT_SQL = `INSERT INTO tm_office_roles (id, office_id, preset, role_key, name, avatar, title, prompt, model, effort, tools, autonomy, cap_usd, schedules, triggers, guards, notes_path, notes_tainted_at, session_id, session_tainted, enabled, armed_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?, ?)`;

export function officeRoleInsertParams(id: string, r: NewOfficeRole, at: string): unknown[] {
  return [
    id,
    r.officeId,
    r.preset ?? null,
    r.key,
    r.name,
    r.avatar,
    r.title,
    r.prompt,
    r.model,
    r.effort ?? null,
    JSON.stringify(r.tools),
    r.autonomy ?? null,
    r.capUsd ?? null,
    JSON.stringify(r.schedules ?? []),
    JSON.stringify(r.triggers ?? []),
    JSON.stringify(r.guards ?? []),
    r.notesPath,
    r.enabled === false ? 0 : 1,
    r.armedAt ?? at,
    at,
    at,
  ];
}

export const OFFICE_ROLE_GET_SQL = `SELECT * FROM tm_office_roles WHERE id = ?`;
export const OFFICE_ROLE_DELETE_SQL = `DELETE FROM tm_office_roles WHERE id = ?`;

/** `officeId` null = every office's roles. */
export function officeRoleListSql(officeId?: string | null): { sql: string; params: unknown[] } {
  return officeId
    ? { sql: `SELECT * FROM tm_office_roles WHERE office_id = ? ORDER BY created_at ASC, id ASC`, params: [officeId] }
    : { sql: `SELECT * FROM tm_office_roles ORDER BY office_id ASC, created_at ASC, id ASC`, params: [] };
}

const json = (v: unknown) => JSON.stringify(v);
const ROLE_PATCH_COLUMNS: Record<keyof OfficeRolePatch, [string, (v: any) => unknown]> = {
  preset: ['preset', (v) => v],
  key: ['role_key', (v) => v],
  name: ['name', (v) => v],
  avatar: ['avatar', (v) => v],
  title: ['title', (v) => v],
  prompt: ['prompt', (v) => v],
  model: ['model', (v) => v],
  effort: ['effort', (v) => v],
  tools: ['tools', json],
  autonomy: ['autonomy', (v) => v],
  capUsd: ['cap_usd', (v) => v],
  schedules: ['schedules', json],
  triggers: ['triggers', json],
  guards: ['guards', json],
  commands: ['command_ids', json],
  notesPath: ['notes_path', (v) => v],
  notesTaintedAt: ['notes_tainted_at', (v) => v],
  sessionId: ['session_id', (v) => v],
  sessionTainted: ['session_tainted', (v) => (v ? 1 : 0)],
  enabled: ['enabled', (v) => (v ? 1 : 0)],
  armedAt: ['armed_at', (v) => v],
};

export function officeRolePatchSql(id: string, p: OfficeRolePatch, at: string): { sql: string; params: unknown[] } | null {
  return patchSql('tm_office_roles', ROLE_PATCH_COLUMNS, id, p, at);
}

export function rowToOfficeRole(r: any): OfficeRole {
  return {
    id: r.id,
    officeId: r.office_id,
    preset: r.preset ?? null,
    key: r.role_key,
    name: r.name,
    avatar: r.avatar,
    title: r.title,
    prompt: r.prompt,
    model: r.model,
    effort: r.effort ?? null,
    tools: stringList(r.tools),
    autonomy: r.autonomy ?? null,
    capUsd: r.cap_usd == null ? null : Number(r.cap_usd),
    schedules: stringList(r.schedules),
    triggers: objectList<OfficeTrigger>(r.triggers),
    guards: objectList<OfficeGuard>(r.guards),
    commands: roleCommands(r.command_ids),
    notesPath: r.notes_path,
    notesTaintedAt: r.notes_tainted_at ?? null,
    sessionId: r.session_id ?? null,
    sessionTainted: !!Number(r.session_tainted),
    enabled: !!Number(r.enabled),
    armedAt: r.armed_at ?? r.created_at ?? null,
  };
}

// ---- shifts ----

export const OFFICE_SHIFT_INSERT_SQL = `INSERT INTO tm_office_shifts (id, office_id, role_id, trigger_kind, trigger_ref, trigger_at, verdict, skip_reason, run_id, cost_usd, tainted, taint_sources, brief_id, filed_task_ids, started_at, ended_at, error, skip_code)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, '[]', ?, ?, ?, ?)`;

export function officeShiftInsertParams(id: string, s: NewOfficeShift, at: string): unknown[] {
  return [
    id,
    s.officeId,
    s.roleId,
    s.trigger.kind,
    s.trigger.ref,
    s.trigger.at,
    s.verdict,
    s.skipReason ?? null,
    s.runId ?? null,
    s.tainted ? 1 : 0,
    JSON.stringify(s.taintSources ?? []),
    s.startedAt ?? at,
    s.endedAt ?? null,
    s.error ?? null,
    s.skipCode ?? null,
  ];
}

export const OFFICE_SHIFT_GET_SQL = `SELECT * FROM tm_office_shifts WHERE id = ?`;

const SHIFT_PATCH_COLUMNS: Record<keyof OfficeShiftPatch, [string, (v: any) => unknown]> = {
  verdict: ['verdict', (v) => v],
  skipReason: ['skip_reason', (v) => v],
  runId: ['run_id', (v) => v],
  costUsd: ['cost_usd', (v) => v],
  tainted: ['tainted', (v) => (v ? 1 : 0)],
  taintSources: ['taint_sources', json],
  briefId: ['brief_id', (v) => v],
  filedTaskIds: ['filed_task_ids', json],
  filing: ['filing', (v) => (v == null ? null : JSON.stringify(v))],
  commands: ['commands', (v) => (v == null ? null : JSON.stringify(v))],
  endedAt: ['ended_at', (v) => v],
  error: ['error', (v) => v],
};

/** A shift row has no `updated_at`; the patch writes only what it names. */
export function officeShiftPatchSql(id: string, p: OfficeShiftPatch): { sql: string; params: unknown[] } | null {
  const { sets, params } = patchSets(SHIFT_PATCH_COLUMNS, p);
  if (!sets.length) return null;
  params.push(id);
  return { sql: `UPDATE tm_office_shifts SET ${sets.join(', ')} WHERE id = ? RETURNING *`, params };
}

/** Newest first. */
export function officeShiftListSql(f: OfficeShiftFilter = {}): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const eq = (col: string, v: unknown) => {
    where.push(`${col} = ?`);
    params.push(v);
  };
  if (f.officeId) eq('office_id', f.officeId);
  if (f.roleId) eq('role_id', f.roleId);
  if (f.verdict) eq('verdict', f.verdict);
  if (f.triggerKind) eq('trigger_kind', f.triggerKind);
  if (f.since) {
    where.push(`started_at >= ?`);
    params.push(f.since);
  }
  if (f.until) {
    where.push(`started_at < ?`);
    params.push(f.until);
  }
  if (f.open) where.push(`ended_at IS NULL`);
  const limit = Math.max(1, Math.min(5000, Math.floor(f.limit ?? 500)));
  return {
    sql: `SELECT * FROM tm_office_shifts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC, id DESC LIMIT ${limit}`,
    params,
  };
}

/** The `filing` JSON column; anything unreadable is null (a list is never invented). */
function shiftFiling(v: unknown): OfficeShiftFiling | null {
  if (v == null || v === '') return null;
  try {
    const f = typeof v === 'string' ? JSON.parse(v) : v;
    if (!f || typeof f !== 'object' || typeof f.status !== 'string') return null;
    return {
      status: f.status,
      note: typeof f.note === 'string' ? f.note : null,
      held: Array.isArray(f.held) ? f.held : [],
      dropped: Array.isArray(f.dropped) ? f.dropped : [],
      ...(Array.isArray(f.proposalIds) ? { proposalIds: f.proposalIds.filter((x: unknown) => typeof x === 'string') } : {}),
    };
  } catch {
    return null;
  }
}

/** The role's allowlist column; malformed entries are dropped (an id is never invented). */
function roleCommands(v: unknown): OfficeRoleCommand[] {
  return objectList<OfficeRoleCommand>(v)
    .filter((c) => c && typeof c.commandId === 'string' && c.commandId)
    .map((c) => ({ commandId: c.commandId, external: c.external === true }));
}

/** The `commands` JSON column; anything unreadable is null. */
function shiftCommands(v: unknown): OfficeShiftCommands | null {
  if (v == null || v === '') return null;
  try {
    const c = typeof v === 'string' ? JSON.parse(v) : v;
    if (!c || typeof c !== 'object') return null;
    return {
      requested: Array.isArray(c.requested) ? c.requested : [],
      dropped: Array.isArray(c.dropped) ? c.dropped : [],
      runs: Array.isArray(c.runs) ? c.runs : [],
      wake: c.wake && typeof c.wake === 'object' ? c.wake : null,
    };
  } catch {
    return null;
  }
}

export function rowToOfficeShift(r: any): OfficeShift {
  return {
    id: r.id,
    officeId: r.office_id,
    roleId: r.role_id,
    trigger: { kind: r.trigger_kind, ref: r.trigger_ref ?? null, at: r.trigger_at },
    verdict: r.verdict,
    skipReason: r.skip_reason ?? null,
    skipCode: r.skip_code ?? null,
    runId: r.run_id ?? null,
    costUsd: Number(r.cost_usd ?? 0) || 0,
    tainted: !!Number(r.tainted),
    taintSources: stringList(r.taint_sources),
    briefId: r.brief_id ?? null,
    filedTaskIds: stringList(r.filed_task_ids),
    filing: shiftFiling(r.filing),
    commands: shiftCommands(r.commands),
    startedAt: r.started_at,
    endedAt: r.ended_at ?? null,
    error: r.error ?? null,
  };
}

// ---- briefs, proposals, wishes (migration 58) ----

export interface NewOfficeBrief {
  officeId: string;
  roleId: string;
  shiftId: string;
  kind: OfficeBriefKind;
  path: string;
  summary: string;
  taintedAt?: string | null;
}

export interface OfficeBriefFilter {
  officeId?: string;
  roleId?: string;
  shiftId?: string;
  kind?: OfficeBriefKind;
  /** only rows with no `reviewed_at` */
  unreviewed?: boolean;
  /** created at or after (ISO) */
  since?: string;
  /** default 200, capped at 2000 */
  limit?: number;
}

export interface NewOfficeProposal {
  officeId: string;
  roleId: string;
  shiftId: string;
  title: string;
  body: string;
  repoId?: string | null;
  taintedAt?: string | null;
  /** migration 59 (docs/office.md § Proposals) */
  workspaceId?: string | null;
  runId?: string | null;
  origin?: OfficeProposal['origin'];
  category?: string | null;
  effort?: EffortLevel | null;
}

export interface OfficeProposalFilter {
  officeId?: string;
  roleId?: string;
  shiftId?: string;
  status?: OfficeProposalStatus;
  /** default 200, capped at 2000 */
  limit?: number;
}

export interface NewOfficeWish {
  officeId: string;
  text: string;
  status?: OfficeWishStatus;
}

export type OfficeWishPatch = Partial<Pick<OfficeWish, 'text' | 'status'>>;

export interface OfficeWishFilter {
  officeId?: string;
  status?: OfficeWishStatus;
}

/** What `markReviewed` may stamp; the table name comes from this map, never from the caller. */
export type OfficeReviewable = 'brief' | 'proposal' | 'message';
const REVIEWABLE_TABLES: Record<OfficeReviewable, string> = {
  brief: 'tm_office_briefs',
  proposal: 'tm_office_proposals',
  message: 'tm_office_messages',
};

export const OFFICE_BRIEF_INSERT_SQL = `INSERT INTO tm_office_briefs (id, office_id, role_id, shift_id, kind, path, summary, tainted_at, reviewed_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`;

export function officeBriefInsertParams(id: string, b: NewOfficeBrief, at: string): unknown[] {
  return [id, b.officeId, b.roleId, b.shiftId, b.kind, b.path, b.summary, b.taintedAt ?? null, at];
}

export const OFFICE_BRIEF_GET_SQL = `SELECT * FROM tm_office_briefs WHERE id = ?`;
export const OFFICE_BRIEFS_DELETE_SQL = `DELETE FROM tm_office_briefs WHERE office_id = ?`;

/** Newest first. */
export function officeBriefListSql(f: OfficeBriefFilter = {}): { sql: string; params: unknown[] } {
  const { where, params, eq } = whereBuilder();
  if (f.officeId) eq('office_id', f.officeId);
  if (f.roleId) eq('role_id', f.roleId);
  if (f.shiftId) eq('shift_id', f.shiftId);
  if (f.kind) eq('kind', f.kind);
  if (f.unreviewed) where.push(`reviewed_at IS NULL`);
  if (f.since) {
    where.push(`created_at >= ?`);
    params.push(f.since);
  }
  return {
    sql: `SELECT * FROM tm_office_briefs ${whereSql(where)} ORDER BY created_at DESC, id DESC LIMIT ${listLimit(f.limit)}`,
    params,
  };
}

export function rowToOfficeBrief(r: any): OfficeBrief {
  return {
    id: r.id,
    officeId: r.office_id,
    roleId: r.role_id,
    shiftId: r.shift_id,
    kind: r.kind,
    path: r.path,
    summary: r.summary ?? '',
    taintedAt: r.tainted_at ?? null,
    reviewedAt: r.reviewed_at ?? null,
    createdAt: r.created_at,
  };
}

export const OFFICE_PROPOSAL_INSERT_SQL = `INSERT INTO tm_office_proposals (id, office_id, role_id, shift_id, title, body, repo_id, status, tainted_at, reviewed_at, decided_at, decided_by, filed_task_id, created_at, workspace_id, run_id, origin, category, effort, note)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL)`;

export function officeProposalInsertParams(id: string, p: NewOfficeProposal, at: string): unknown[] {
  return [
    id,
    p.officeId,
    p.roleId,
    p.shiftId,
    p.title,
    p.body,
    p.repoId ?? null,
    p.taintedAt ?? null,
    at,
    p.workspaceId ?? null,
    p.runId ?? null,
    p.origin ?? null,
    p.category ?? null,
    p.effort ?? null,
  ];
}

export const OFFICE_PROPOSAL_GET_SQL = `SELECT * FROM tm_office_proposals WHERE id = ?`;
export const OFFICE_PROPOSALS_DELETE_SQL = `DELETE FROM tm_office_proposals WHERE office_id = ?`;

/** Newest first. */
export function officeProposalListSql(f: OfficeProposalFilter = {}): { sql: string; params: unknown[] } {
  const { where, params, eq } = whereBuilder();
  if (f.officeId) eq('office_id', f.officeId);
  if (f.roleId) eq('role_id', f.roleId);
  if (f.shiftId) eq('shift_id', f.shiftId);
  if (f.status) eq('status', f.status);
  return {
    sql: `SELECT * FROM tm_office_proposals ${whereSql(where)} ORDER BY created_at DESC, id DESC LIMIT ${listLimit(f.limit)}`,
    params,
  };
}

/**
 * `decideProposal`'s conditional write: `pending → accepted|rejected`, landing
 * only while the row is still `pending`, so the second of two racing decisions
 * (the SPA and Telegram) gets no row back and reports a 409. `filedTaskId` may
 * be named up front; an accept that files afterwards records it through
 * `officeProposalFiledSql`.
 */
export function officeProposalDecideSql(
  id: string,
  to: Exclude<OfficeProposalStatus, 'pending'>,
  by: string,
  at: string,
  filedTaskId: string | null = null,
  note: string | null = null,
): { sql: string; params: unknown[] } {
  return {
    sql: `UPDATE tm_office_proposals SET status = ?, decided_at = ?, decided_by = ?, filed_task_id = ?, note = ? WHERE id = ? AND status = 'pending' RETURNING *`,
    params: [to, at, by, filedTaskId, note, id],
  };
}

/** An accept whose task could not be filed goes back to pending — only while it filed nothing. */
export const OFFICE_PROPOSAL_UNDO_ACCEPT_SQL = `UPDATE tm_office_proposals SET status = 'pending', decided_by = NULL, decided_at = NULL
  WHERE id = ? AND status = 'accepted' AND filed_task_id IS NULL RETURNING *`;

export const OFFICE_PROPOSALS_PENDING_COUNT_SQL = `SELECT COUNT(*) AS n FROM tm_office_proposals WHERE office_id = ? AND status = 'pending'`;

/** The task an accept filed, written once: only on an `accepted` row with no task yet. */
export function officeProposalFiledSql(id: string, taskId: string): { sql: string; params: unknown[] } {
  return {
    sql: `UPDATE tm_office_proposals SET filed_task_id = ? WHERE id = ? AND status = 'accepted' AND filed_task_id IS NULL RETURNING *`,
    params: [taskId, id],
  };
}

export function rowToOfficeProposal(r: any): OfficeProposal {
  return {
    id: r.id,
    officeId: r.office_id,
    roleId: r.role_id,
    shiftId: r.shift_id,
    title: r.title,
    body: r.body ?? '',
    repoId: r.repo_id ?? null,
    status: r.status,
    taintedAt: r.tainted_at ?? null,
    decidedAt: r.decided_at ?? null,
    decidedBy: r.decided_by ?? null,
    filedTaskId: r.filed_task_id ?? null,
    reviewedAt: r.reviewed_at ?? null,
    createdAt: r.created_at,
    workspaceId: r.workspace_id ?? null,
    runId: r.run_id ?? null,
    origin: r.origin === 'task' || r.origin === 'proposal' ? r.origin : null,
    category: r.category ?? null,
    effort: (r.effort ?? null) as EffortLevel | null,
    note: r.note ?? null,
  };
}

/**
 * `markReviewed`: stamps `reviewed_at` once — a second call keeps the first
 * time (COALESCE) and still returns the row; null back = no such row.
 */
export function officeMarkReviewedSql(table: OfficeReviewable, id: string, at: string): { sql: string; params: unknown[] } {
  const t = REVIEWABLE_TABLES[table];
  if (!t) throw new Error(`markReviewed: unknown table ${String(table)}`);
  return { sql: `UPDATE ${t} SET reviewed_at = COALESCE(reviewed_at, ?) WHERE id = ? RETURNING *`, params: [at, id] };
}

/**
 * `clearBriefTaint`: a human marked a tainted brief reviewed (docs/office.md §
 * Briefings) — the file moved out of the untrusted storage to `path`, so the
 * row gets the new path, `tainted_at` cleared and `reviewed_at` stamped, in one
 * write that lands only while `tainted_at` still equals what the human read.
 */
export const OFFICE_BRIEF_CLEAR_TAINT_SQL = `UPDATE tm_office_briefs SET tainted_at = NULL, path = ?, reviewed_at = COALESCE(reviewed_at, ?)
  WHERE id = ? AND tainted_at = ? RETURNING *`;

export const OFFICE_WISH_INSERT_SQL = `INSERT INTO tm_office_wishes (id, office_id, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`;

export function officeWishInsertParams(id: string, w: NewOfficeWish, at: string): unknown[] {
  return [id, w.officeId, w.text, w.status ?? 'open', at, at];
}

export const OFFICE_WISH_GET_SQL = `SELECT * FROM tm_office_wishes WHERE id = ?`;
export const OFFICE_WISH_DELETE_SQL = `DELETE FROM tm_office_wishes WHERE id = ?`;
export const OFFICE_WISHES_DELETE_SQL = `DELETE FROM tm_office_wishes WHERE office_id = ?`;

/** Oldest first — a wish list reads top-down in the order it was written. */
export function officeWishListSql(f: OfficeWishFilter = {}): { sql: string; params: unknown[] } {
  const { where, params, eq } = whereBuilder();
  if (f.officeId) eq('office_id', f.officeId);
  if (f.status) eq('status', f.status);
  return { sql: `SELECT * FROM tm_office_wishes ${whereSql(where)} ORDER BY created_at ASC, id ASC`, params };
}

const WISH_PATCH_COLUMNS: Record<keyof OfficeWishPatch, [string, (v: any) => unknown]> = {
  text: ['text', (v) => v],
  status: ['status', (v) => v],
};

export function officeWishPatchSql(id: string, p: OfficeWishPatch, at: string): { sql: string; params: unknown[] } | null {
  return patchSql('tm_office_wishes', WISH_PATCH_COLUMNS, id, p, at);
}

export function rowToOfficeWish(r: any): OfficeWish {
  return {
    id: r.id,
    officeId: r.office_id,
    text: r.text,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---- office features (docs/office.md § Director features) ----

/**
 * The office's Director role — preset `director` (`isStandupRole`), the only
 * role whose shift may file a feature — oldest first. An office feature's cards
 * carry it as `role_id` at approval (features keep no role column).
 */
export const OFFICE_DIRECTOR_ROLE_SQL = `SELECT id FROM tm_office_roles WHERE office_id = ? AND preset = 'director' ORDER BY created_at ASC, id ASC LIMIT 1`;

/** The office's workspace's `repo_ids` (JSON) — no row when the office or its workspace is gone. */
export const OFFICE_WORKSPACE_REPOS_SQL = `SELECT w.repo_ids AS repo_ids FROM tm_offices o JOIN tm_workspaces w ON w.id = o.workspace_id WHERE o.id = ?`;

export const REPO_EXISTS_SQL = `SELECT id FROM tm_repos WHERE id = ?`;

/** `repo_ids` as stored: a JSON array of ids (anything else = none). */
export function parseRepoIds(raw: unknown): string[] {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// ---- messages, huddles, signals (migration 60) ----

export interface NewOfficeMessage {
  officeId: string;
  /** null = the stakeholder (the human) */
  fromRoleId: string | null;
  /** null = the channel */
  toRoleId: string | null;
  kind: OfficeMessageKind;
  subject?: OfficeSubject | null;
  body: string;
  taintedAt?: string | null;
  /**
   * Stored already routed (docs/office.md § Channel): a forward's delivery
   * copy and a Director's own message to a role — nothing left to route, and
   * the `office-message.created` broadcast carries it routed, which is what
   * the `office-message` event trigger waits for.
   */
  routedAt?: string | null;
}

export interface OfficeMessageFilter {
  officeId?: string;
  /** a role id, or null = from the stakeholder */
  fromRoleId?: string | null;
  /** a role id, or null = the channel */
  toRoleId?: string | null;
  kind?: OfficeMessageKind;
  subject?: OfficeSubject;
  /** only rows with no `routed_at` */
  unrouted?: boolean;
  /** created at or after (ISO) */
  since?: string;
  /** default 200, capped at 2000 */
  limit?: number;
}

export const OFFICE_MESSAGE_INSERT_SQL = `INSERT INTO tm_office_messages (id, office_id, from_role_id, to_role_id, kind, subject_kind, subject_id, body, tainted_at, reviewed_at, routed_at, routed_task_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`;

export function officeMessageInsertParams(id: string, m: NewOfficeMessage, at: string): unknown[] {
  return [
    id,
    m.officeId,
    m.fromRoleId ?? null,
    m.toRoleId ?? null,
    m.kind,
    m.subject?.kind ?? null,
    m.subject?.id ?? null,
    m.body,
    m.taintedAt ?? null,
    m.routedAt ?? null,
    at,
  ];
}

export const OFFICE_MESSAGE_GET_SQL = `SELECT * FROM tm_office_messages WHERE id = ?`;
export const OFFICE_MESSAGES_DELETE_SQL = `DELETE FROM tm_office_messages WHERE office_id = ?`;

/** Oldest first — a conversation reads top-down; `since` + `limit` page forward. */
export function officeMessageListSql(f: OfficeMessageFilter = {}): { sql: string; params: unknown[] } {
  const { where, params, eq } = whereBuilder();
  if (f.officeId) eq('office_id', f.officeId);
  if (f.fromRoleId !== undefined) f.fromRoleId === null ? where.push(`from_role_id IS NULL`) : eq('from_role_id', f.fromRoleId);
  if (f.toRoleId !== undefined) f.toRoleId === null ? where.push(`to_role_id IS NULL`) : eq('to_role_id', f.toRoleId);
  if (f.kind) eq('kind', f.kind);
  if (f.subject) {
    eq('subject_kind', f.subject.kind);
    eq('subject_id', f.subject.id);
  }
  if (f.unrouted) where.push(`routed_at IS NULL`);
  if (f.since) {
    where.push(`created_at >= ?`);
    params.push(f.since);
  }
  return {
    sql: `SELECT * FROM tm_office_messages ${whereSql(where)} ORDER BY created_at ASC, id ASC LIMIT ${listLimit(f.limit)}`,
    params,
  };
}

/**
 * `routeMessage`'s conditional write: stamps `routed_at` (and the task the
 * routing filed, if any) only while the message is still unrouted, so two
 * routers racing (a shift's settle and the scheduler) route it once — the
 * loser gets null back.
 */
export function officeMessageRouteSql(id: string, taskId: string | null, at: string): { sql: string; params: unknown[] } {
  return {
    sql: `UPDATE tm_office_messages SET routed_at = ?, routed_task_id = ? WHERE id = ? AND routed_at IS NULL RETURNING *`,
    params: [at, taskId, id],
  };
}

/**
 * `clearMessageTaint`: a human marked a tainted message reviewed (docs/office.md
 * § Channel → Mark reviewed) — `tainted_at` cleared and `reviewed_at` stamped,
 * in one write that lands only while `tainted_at` still equals what the human
 * read. Null back = no such row, or it no longer matches.
 */
export const OFFICE_MESSAGE_CLEAR_TAINT_SQL = `UPDATE tm_office_messages SET tainted_at = NULL, reviewed_at = ?
  WHERE id = ? AND tainted_at = ? RETURNING *`;

export function rowToOfficeMessage(r: any): OfficeMessage {
  return {
    id: r.id,
    officeId: r.office_id,
    fromRoleId: r.from_role_id ?? null,
    toRoleId: r.to_role_id ?? null,
    kind: r.kind,
    subject: r.subject_kind && r.subject_id ? { kind: r.subject_kind, id: r.subject_id } : null,
    body: r.body ?? '',
    taintedAt: r.tainted_at ?? null,
    reviewedAt: r.reviewed_at ?? null,
    routedAt: r.routed_at ?? null,
    routedTaskId: r.routed_task_id ?? null,
    createdAt: r.created_at,
  };
}

export interface NewOfficeHuddle {
  officeId: string;
  subject: OfficeSubject;
  roleIds: string[];
  /** at least 1 (clamped) */
  maxTurns: number;
  taintedAt?: string | null;
}

export interface OfficeHuddleFilter {
  officeId?: string;
  status?: OfficeHuddleStatus;
  subject?: OfficeSubject;
  /** default 200, capped at 2000 */
  limit?: number;
}

export const OFFICE_HUDDLE_INSERT_SQL = `INSERT INTO tm_office_huddles (id, office_id, subject_kind, subject_id, role_ids, turns, max_turns, status, decision, tainted_at, created_at, updated_at, closed_at)
  VALUES (?, ?, ?, ?, ?, 0, ?, 'open', NULL, ?, ?, ?, NULL)`;

export function officeHuddleInsertParams(id: string, h: NewOfficeHuddle, at: string): unknown[] {
  const max = Math.max(1, Math.floor(Number.isFinite(h.maxTurns) ? h.maxTurns : 1));
  return [id, h.officeId, h.subject.kind, h.subject.id, JSON.stringify(h.roleIds ?? []), max, h.taintedAt ?? null, at, at];
}

export const OFFICE_HUDDLE_GET_SQL = `SELECT * FROM tm_office_huddles WHERE id = ?`;
export const OFFICE_HUDDLES_DELETE_SQL = `DELETE FROM tm_office_huddles WHERE office_id = ?`;

/** Newest first. */
export function officeHuddleListSql(f: OfficeHuddleFilter = {}): { sql: string; params: unknown[] } {
  const { where, params, eq } = whereBuilder();
  if (f.officeId) eq('office_id', f.officeId);
  if (f.status) eq('status', f.status);
  if (f.subject) {
    eq('subject_kind', f.subject.kind);
    eq('subject_id', f.subject.id);
  }
  return {
    sql: `SELECT * FROM tm_office_huddles ${whereSql(where)} ORDER BY created_at DESC, id DESC LIMIT ${listLimit(f.limit)}`,
    params,
  };
}

/**
 * `stepHuddle`: takes the next turn — `turns + 1` — only while the huddle is
 * `open` AND `turns < max_turns`, in ONE conditional write, so a huddle can
 * never run past its cap however many roles race for the turn. Null back =
 * refused (closed, spent, or no such row); the caller re-reads.
 */
export function officeHuddleStepSql(id: string, at: string): { sql: string; params: unknown[] } {
  return {
    sql: `UPDATE tm_office_huddles SET turns = turns + 1, updated_at = ? WHERE id = ? AND status = 'open' AND turns < max_turns RETURNING *`,
    params: [at, id],
  };
}

/**
 * `taintHuddle`: stamps `tainted_at` once, while the huddle is open and still
 * trusted (docs/office.md § Huddles: a tainted turn taints the huddle and
 * every turn after it). Null back = already tainted, closed, or no such row.
 */
export function officeHuddleTaintSql(id: string, at: string): { sql: string; params: unknown[] } {
  return {
    sql: `UPDATE tm_office_huddles SET tainted_at = ?, updated_at = ? WHERE id = ? AND status = 'open' AND tainted_at IS NULL RETURNING *`,
    params: [at, at, id],
  };
}

/** `closeHuddle`: `open → decided|expired`, once (null back = already closed or no such row). */
export function officeHuddleCloseSql(
  id: string,
  to: Exclude<OfficeHuddleStatus, 'open'>,
  decision: string | null,
  at: string,
): { sql: string; params: unknown[] } {
  return {
    sql: `UPDATE tm_office_huddles SET status = ?, decision = ?, closed_at = ?, updated_at = ? WHERE id = ? AND status = 'open' RETURNING *`,
    params: [to, decision, at, at, id],
  };
}

export function rowToOfficeHuddle(r: any): OfficeHuddle {
  return {
    id: r.id,
    officeId: r.office_id,
    subject: { kind: r.subject_kind, id: r.subject_id },
    roleIds: stringList(r.role_ids),
    turns: Number(r.turns ?? 0),
    maxTurns: Number(r.max_turns ?? 0),
    status: r.status,
    decision: r.decision ?? null,
    taintedAt: r.tainted_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    closedAt: r.closed_at ?? null,
  };
}

export interface NewOfficeSignal {
  officeId: string;
  source: OfficeSignalSource;
  externalId: string;
  title: string;
  rawText: string;
  url?: string | null;
  /** defaults to now */
  receivedAt?: string;
}

export interface OfficeSignalFilter {
  officeId?: string;
  source?: OfficeSignalSource;
  /** only rows no shift has consumed */
  unconsumed?: boolean;
  /** default 200, capped at 2000 */
  limit?: number;
}

/**
 * `appendSignal`'s insert: a duplicate `(source, external_id)` is a no-op
 * (the unique index of migration 60), and RETURNING gives no row for it, so
 * the driver can tell "new" from "already had it" without a racy pre-read.
 */
export const OFFICE_SIGNAL_INSERT_SQL = `INSERT INTO tm_office_signals (id, office_id, source, external_id, title, raw_text, url, received_at, consumed_shift_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT (source, external_id) DO NOTHING RETURNING *`;

export function officeSignalInsertParams(id: string, s: NewOfficeSignal, at: string): unknown[] {
  return [id, s.officeId, s.source, s.externalId, s.title, s.rawText, s.url ?? null, s.receivedAt ?? at];
}

export const OFFICE_SIGNAL_GET_SQL = `SELECT * FROM tm_office_signals WHERE id = ?`;
export const OFFICE_SIGNAL_BY_EXTERNAL_SQL = `SELECT * FROM tm_office_signals WHERE source = ? AND external_id = ?`;
export const OFFICE_SIGNALS_DELETE_SQL = `DELETE FROM tm_office_signals WHERE office_id = ?`;

/** Oldest first — signals are consumed in arrival order. */
export function officeSignalListSql(f: OfficeSignalFilter = {}): { sql: string; params: unknown[] } {
  const { where, params, eq } = whereBuilder();
  if (f.officeId) eq('office_id', f.officeId);
  if (f.source) eq('source', f.source);
  if (f.unconsumed) where.push(`consumed_shift_id IS NULL`);
  return {
    sql: `SELECT * FROM tm_office_signals ${whereSql(where)} ORDER BY received_at ASC, id ASC LIMIT ${listLimit(f.limit)}`,
    params,
  };
}

/** `consumeSignal`: hands a signal to ONE shift — lands only while unconsumed (null back = taken). */
export function officeSignalConsumeSql(id: string, shiftId: string): { sql: string; params: unknown[] } {
  return {
    sql: `UPDATE tm_office_signals SET consumed_shift_id = ? WHERE id = ? AND consumed_shift_id IS NULL RETURNING *`,
    params: [shiftId, id],
  };
}

export function rowToOfficeSignal(r: any): OfficeSignal {
  return {
    id: r.id,
    officeId: r.office_id,
    source: r.source,
    externalId: r.external_id,
    title: r.title ?? '',
    rawText: r.raw_text ?? '',
    url: r.url ?? null,
    receivedAt: r.received_at,
    consumedShiftId: r.consumed_shift_id ?? null,
  };
}

// ---- roll-ups ----

/**
 * `officeSpendSince`: the `tm_runs.cost_usd` of every run STARTED at or after
 * `?` (like `spendSince`, the `budget.dayUsd` measure) that belongs to the
 * office — its shifts' aux runs (linked by `tm_office_shifts.run_id`, or an
 * aux `shift` run whose subject is the shift) plus the runs of the tasks it
 * filed, attributed the way `taskCostSql` attributes a task (its own worker
 * runs plus the review/compact aux runs about it) and the `plan`/`plan-review`
 * aux runs of the features its Director filed (docs/office.md § Director
 * features). A run matching several branches is still one row, so it is
 * counted once. With `roleId`, only that role's shifts and tasks — and the
 * office's feature planning only when that role is a Director (features keep
 * no role column; only a Director files one).
 */
export function officeSpendSql(officeId: string, sinceIso: string, roleId?: string | null): { sql: string; params: unknown[] } {
  const shiftScope = roleId ? `s.office_id = ? AND s.role_id = ?` : `s.office_id = ?`;
  const taskScope = roleId ? `t.office_id = ? AND t.role_id = ?` : `t.office_id = ?`;
  const featureScope = roleId
    ? `f.office_id = ? AND f.office_id IN (SELECT ro.office_id FROM tm_office_roles ro WHERE ro.id = ? AND ro.preset = 'director')`
    : `f.office_id = ?`;
  const scope = (roleId ? [officeId, roleId] : [officeId]) as unknown[];
  return {
    sql: `SELECT COALESCE(SUM(r.cost_usd), 0) AS s FROM tm_runs r
      WHERE r.started_at >= ?
        AND (r.id IN (SELECT s.run_id FROM tm_office_shifts s WHERE ${shiftScope} AND s.run_id IS NOT NULL)
          OR (r.mode = 'aux' AND r.kind = 'shift' AND r.subject_id IN (SELECT s.id FROM tm_office_shifts s WHERE ${shiftScope}))
          OR r.task_id IN (SELECT t.id FROM tm_tasks t WHERE ${taskScope})
          OR (r.mode = 'aux' AND r.kind IN ('review', 'compact') AND r.subject_id IN (SELECT t.id FROM tm_tasks t WHERE ${taskScope}))
          OR (r.mode = 'aux' AND r.kind IN ('plan', 'plan-review') AND r.subject_id IN (SELECT f.id FROM tm_features f WHERE ${featureScope})))`,
    params: [sinceIso, ...scope, ...scope, ...scope, ...scope, ...scope],
  };
}

const TERMINAL_LIST = TERMINAL_TASK_STATUSES.map((s) => `'${s}'`).join(', ');

/** Tasks the office (or one of its roles) filed that are not in a terminal status (`TERMINAL_TASK_STATUSES`) — `Office.maxOpenTasks`. */
export function officeOpenTasksSql(officeId: string, roleId?: string | null): { sql: string; params: unknown[] } {
  return roleId
    ? {
        sql: `SELECT COUNT(*) AS n FROM tm_tasks WHERE office_id = ? AND role_id = ? AND status NOT IN (${TERMINAL_LIST})`,
        params: [officeId, roleId],
      }
    : { sql: `SELECT COUNT(*) AS n FROM tm_tasks WHERE office_id = ? AND status NOT IN (${TERMINAL_LIST})`, params: [officeId] };
}

// ---- helpers ----

function whereBuilder() {
  const where: string[] = [];
  const params: unknown[] = [];
  const eq = (col: string, v: unknown) => {
    where.push(`${col} = ?`);
    params.push(v);
  };
  return { where, params, eq };
}

const whereSql = (where: string[]) => (where.length ? 'WHERE ' + where.join(' AND ') : '');
const listLimit = (n: number | undefined) => Math.max(1, Math.min(2000, Math.floor(n ?? 200)));

function patchSets<P extends object>(
  columns: Record<keyof P, [string, (v: any) => unknown]>,
  p: P,
): { sets: string[]; params: unknown[] } {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, [col, enc]] of Object.entries(columns) as [keyof P, [string, (v: any) => unknown]][]) {
    const v = p[k];
    if (v === undefined) continue;
    sets.push(`${col} = ?`);
    params.push(enc(v));
  }
  return { sets, params };
}

function patchSql<P extends object>(
  table: string,
  columns: Record<keyof P, [string, (v: any) => unknown]>,
  id: string,
  p: P,
  at: string,
): { sql: string; params: unknown[] } | null {
  const { sets, params } = patchSets(columns, p);
  if (!sets.length) return null;
  sets.push(`updated_at = ?`);
  params.push(at, id);
  return { sql: `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ? RETURNING *`, params };
}

function parse(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function stringList(v: unknown): string[] {
  const a = parse(v);
  return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
}

function objectList<T>(v: unknown): T[] {
  const a = parse(v);
  return Array.isArray(a) ? (a.filter((x) => x && typeof x === 'object') as T[]) : [];
}
