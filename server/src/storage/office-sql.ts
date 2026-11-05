/**
 * Virtual Office (docs/office.md § Data model) — the SQL both drivers run
 * verbatim, so a column added here cannot land in one driver and not the
 * other. Dialect-neutral with `?` placeholders (the pg driver rewrites them;
 * never put a `?` inside a string literal here). Tables are FK-less
 * (migration 53); the task columns `office_id`/`role_id`/`tainted_at` are
 * migration 54 and create-only.
 */
import {
  OFFICE_MAX_OPEN_TASKS_DEFAULT,
  OFFICE_MAX_TASKS_PER_SHIFT_DEFAULT,
  TERMINAL_TASK_STATUSES,
  type EffortLevel,
  type Office,
  type OfficeAutonomy,
  type OfficeGuard,
  type OfficeRole,
  type OfficeRolePreset,
  type OfficeShift,
  type OfficeShiftFiling,
  type OfficeShiftTriggerKind,
  type OfficeTrigger,
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
}

/** Every role field but its id and office (a role never moves between offices). */
export type OfficeRolePatch = Partial<Omit<OfficeRole, 'id' | 'officeId'>>;

export interface NewOfficeShift {
  officeId: string;
  roleId: string;
  trigger: { kind: OfficeShiftTriggerKind; ref: string | null; at: string };
  verdict: OfficeShift['verdict'];
  skipReason?: string | null;
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
    'verdict' | 'skipReason' | 'runId' | 'costUsd' | 'tainted' | 'taintSources' | 'briefId' | 'filedTaskIds' | 'filing' | 'endedAt' | 'error'
  >
>;

export interface OfficeShiftFilter {
  officeId?: string;
  roleId?: string;
  verdict?: OfficeShift['verdict'];
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

export const OFFICE_ROLE_INSERT_SQL = `INSERT INTO tm_office_roles (id, office_id, preset, role_key, name, avatar, title, prompt, model, effort, tools, autonomy, cap_usd, schedules, triggers, guards, notes_path, notes_tainted_at, session_id, session_tainted, enabled, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?)`;

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
  notesPath: ['notes_path', (v) => v],
  notesTaintedAt: ['notes_tainted_at', (v) => v],
  sessionId: ['session_id', (v) => v],
  sessionTainted: ['session_tainted', (v) => (v ? 1 : 0)],
  enabled: ['enabled', (v) => (v ? 1 : 0)],
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
    notesPath: r.notes_path,
    notesTaintedAt: r.notes_tainted_at ?? null,
    sessionId: r.session_id ?? null,
    sessionTainted: !!Number(r.session_tainted),
    enabled: !!Number(r.enabled),
  };
}

// ---- shifts ----

export const OFFICE_SHIFT_INSERT_SQL = `INSERT INTO tm_office_shifts (id, office_id, role_id, trigger_kind, trigger_ref, trigger_at, verdict, skip_reason, run_id, cost_usd, tainted, taint_sources, brief_id, filed_task_ids, started_at, ended_at, error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, '[]', ?, ?, ?)`;

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
    runId: r.run_id ?? null,
    costUsd: Number(r.cost_usd ?? 0) || 0,
    tainted: !!Number(r.tainted),
    taintSources: stringList(r.taint_sources),
    briefId: r.brief_id ?? null,
    filedTaskIds: stringList(r.filed_task_ids),
    filing: shiftFiling(r.filing),
    startedAt: r.started_at,
    endedAt: r.ended_at ?? null,
    error: r.error ?? null,
  };
}

// ---- roll-ups ----

/**
 * `officeSpendSince`: the `tm_runs.cost_usd` of every run STARTED at or after
 * `?` (like `spendSince`, the `budget.dayUsd` measure) that belongs to the
 * office — its shifts' aux runs (linked by `tm_office_shifts.run_id`, or an
 * aux `shift` run whose subject is the shift) plus the runs of the tasks it
 * filed, attributed the way `taskCostSql` attributes a task (its own worker
 * runs plus the review/compact aux runs about it). A run matching several
 * branches is still one row, so it is counted once. With `roleId`, only that
 * role's shifts and tasks.
 */
export function officeSpendSql(officeId: string, sinceIso: string, roleId?: string | null): { sql: string; params: unknown[] } {
  const shiftScope = roleId ? `s.office_id = ? AND s.role_id = ?` : `s.office_id = ?`;
  const taskScope = roleId ? `t.office_id = ? AND t.role_id = ?` : `t.office_id = ?`;
  const scope = (roleId ? [officeId, roleId] : [officeId]) as unknown[];
  return {
    sql: `SELECT COALESCE(SUM(r.cost_usd), 0) AS s FROM tm_runs r
      WHERE r.started_at >= ?
        AND (r.id IN (SELECT s.run_id FROM tm_office_shifts s WHERE ${shiftScope} AND s.run_id IS NOT NULL)
          OR (r.mode = 'aux' AND r.kind = 'shift' AND r.subject_id IN (SELECT s.id FROM tm_office_shifts s WHERE ${shiftScope}))
          OR r.task_id IN (SELECT t.id FROM tm_tasks t WHERE ${taskScope})
          OR (r.mode = 'aux' AND r.kind IN ('review', 'compact') AND r.subject_id IN (SELECT t.id FROM tm_tasks t WHERE ${taskScope})))`,
    params: [sinceIso, ...scope, ...scope, ...scope, ...scope],
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
