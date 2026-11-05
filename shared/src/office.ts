// Virtual Office (docs/office.md): a workspace's standing ROLES (a PM, a QA,
// a researcher…) that wake on a cron schedule, an event or a signal, run one
// read-only SHIFT as an aux `claude` terminal, and file the work they find as
// ordinary tasks. Everything in this module is pure — types, cron, catch-up,
// guards, the hard gate, autonomy → filing status and the taint model — so the
// server's sweep, the SPA's role cards and the tests read ONE rule. No I/O:
// facts come in precomputed, time comes in as epoch ms, zones go through Intl.

import type { EffortLevel, Task } from './types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * How far an office's filings go on their own (docs/office.md § Autonomy):
 * `proposals` files no task at all (a proposal the human turns into one),
 * `auto-run` and `autonomous` file `queued` tasks — unless the shift is tainted
 * or the global queue is stopped, which always means `draft` (`filingStatus`).
 */
export type OfficeAutonomy = 'proposals' | 'auto-run' | 'autonomous';
export const OFFICE_AUTONOMY_LEVELS: readonly OfficeAutonomy[] = ['proposals', 'auto-run', 'autonomous'];

/** Built-in role templates; their content (prompt, tools, schedule, guards) is `server/src/office/presets.ts` (docs/office.md § Presets). */
export type OfficeRolePreset = 'director' | 'developer' | 'devops' | 'qa' | 'seo';
export const OFFICE_ROLE_PRESETS: readonly OfficeRolePreset[] = ['director', 'developer', 'devops', 'qa', 'seo'];

/** A role key: a kebab slug, unique per office, used in folder names (`roles/<key>.md`). */
export const OFFICE_ROLE_KEY_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const OFFICE_ROLE_KEY_MAX = 40;

export interface Office {
  id: string;
  /** the workspace (docs/workspaces.md) whose repos this office works on */
  workspaceId: string;
  /** the office's knowledge folder, outside every repo (roles' notes, briefs, artifacts) */
  folderPath: string;
  autonomy: OfficeAutonomy;
  /** spend ceiling per office-local day (`officeDay`), over every shift; 0 = nothing runs */
  dayBudgetUsd: number;
  /** shifts live at once in this office */
  maxSlots: number;
  /** tasks one shift may file (`OFFICE_MAX_TASKS_PER_SHIFT_DEFAULT`, at most `OFFICE_MAX_TASKS_PER_SHIFT_MAX`) */
  maxTasksPerShift: number;
  /** open (not terminal) tasks the office may have filed at once (`OFFICE_MAX_OPEN_TASKS_DEFAULT`) */
  maxOpenTasks: number;
  pausedAt: string | null;
  pausedReason: string | null;
  /** the office-local day (`YYYY-MM-DD`) the day budget tripped on; null = not tripped */
  budgetTrippedOn: string | null;
  /** visual theme of the office page; free id, the SPA falls back to its default */
  theme: string | null;
  /** IANA zone the schedules, quiet hours and the budget day are read in */
  timezone: string;
  enabled: boolean;
}

/** Events a role can wake on (docs/office.md § Triggers); later phases may add kinds. */
export type OfficeEventName = 'task-landed' | 'task-failed' | 'review-flagged' | 'checks-red' | 'job-attention';
export const OFFICE_EVENT_NAMES: readonly OfficeEventName[] = [
  'task-landed',
  'task-failed',
  'review-flagged',
  'checks-red',
  'job-attention',
];

/**
 * A non-cron wake. `event` = something this server did (trusted); `signal` =
 * something from OUTSIDE (a webhook, an alert) — every shift a signal starts
 * is tainted (`shiftTaint`).
 */
export type OfficeTrigger =
  | { kind: 'event'; event: OfficeEventName; repoId?: string | null }
  | { kind: 'signal'; source: string }
  /**
   * Opt-in (docs/office.md § Command runs): wake this role ONCE after the
   * saved commands one of its shifts asked for have run, through the gate and
   * guards. A shift this trigger started never chains another.
   */
  | { kind: 'command-done' };

/** The `trigger.ref` of a shift a `command-done` trigger started (its kind is `event`). */
export const OFFICE_COMMAND_DONE_REF = 'command-done';

/** Pre-run guards (docs/office.md § Guards): a failing guard SKIPS a due shift with a readable reason. */
export type OfficeGuard =
  | { kind: 'new-commits-since' }
  | { kind: 'tasks-landed-since' }
  | { kind: 'open-bugs-below'; n: number }
  | { kind: 'budget-left'; minUsd?: number }
  | { kind: 'office-not-paused' }
  | { kind: 'quiet-hours'; from: string; to: string }
  | { kind: 'no-open-task-of-this-role' }
  | { kind: 'cooldown'; minutes: number };
export type OfficeGuardKind = OfficeGuard['kind'];
export const OFFICE_GUARD_KINDS: readonly OfficeGuardKind[] = [
  'new-commits-since',
  'tasks-landed-since',
  'open-bugs-below',
  'budget-left',
  'office-not-paused',
  'quiet-hours',
  'no-open-task-of-this-role',
  'cooldown',
];

export interface OfficeRole {
  id: string;
  officeId: string;
  preset: OfficeRolePreset | null;
  /** kebab slug (`OFFICE_ROLE_KEY_RE`), unique per office */
  key: string;
  name: string;
  /** emoji or image id */
  avatar: string;
  title: string;
  /** the role's standing instructions (human-written) */
  prompt: string;
  model: string;
  effort: EffortLevel | null;
  /** ALWAYS a subset of `SHIFT_TOOL_ALLOWLIST` (`shiftToolsRefusal`) */
  tools: string[];
  /** null = the office's (`effectiveAutonomy`) */
  autonomy: OfficeAutonomy | null;
  /** spend ceiling per office-local day for this role; null = only the office's budget */
  capUsd: number | null;
  /** 5-field cron expressions, read in the office's timezone */
  schedules: string[];
  triggers: OfficeTrigger[];
  guards: OfficeGuard[];
  /**
   * The saved commands a shift of this role may ask the server to run
   * (docs/office.md § Command runs) — set by a human only
   * (`PUT /api/offices/:id/roles/:roleId/commands`, Origin), never by a role
   * edit or an agent. Empty = the role can run nothing.
   */
  commands: OfficeRoleCommand[];
  /** the role's own notes file in the office folder */
  notesPath: string;
  /** set when a tainted shift wrote the notes; cleared only by a human */
  notesTaintedAt: string | null;
  /** the claude session shifts resume; null = next shift starts fresh */
  sessionId: string | null;
  /** a tainted shift ran in this session (`mayResume`) */
  sessionTainted: boolean;
  enabled: boolean;
  /**
   * When the schedule started counting (`dueSlots`' `armedAt`): created,
   * enabled, schedules changed, or its office enabled (`roleRearms`). Null
   * only on a row read before migration 57 — the creation time stands in.
   */
  armedAt: string | null;
}

export type OfficeShiftTriggerKind = 'cron' | 'event' | 'signal' | 'request';

export interface OfficeShift {
  id: string;
  officeId: string;
  roleId: string;
  trigger: {
    kind: OfficeShiftTriggerKind;
    /** the cron expression, event name, signal source or requester */
    ref: string | null;
    /** the slot / event time the shift answers (for cron: the slot, which `dueSlots` reads back) */
    at: string;
  };
  verdict: 'ran' | 'skipped';
  /** readable line from `evalGuards` / `officeHardGate` when skipped */
  skipReason: string | null;
  /** why it was skipped, as a code: `guard`, an `OfficeGateCode`, or a runner refusal (`tools`, `folder`, `role`) */
  skipCode: string | null;
  runId: string | null;
  costUsd: number;
  tainted: boolean;
  /** `taintLabel` strings (`kind:ref`) */
  taintSources: string[];
  briefId: string | null;
  filedTaskIds: string[];
  /** what the `tasks` section became (docs/office.md § Filing); null = the shift asked for no tasks */
  filing: OfficeShiftFiling | null;
  /** what the `commands` section became (docs/office.md § Command runs); null = the shift asked for none */
  commands: OfficeShiftCommands | null;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

export type OfficeRoleState =
  | 'off-duty'
  | 'scheduled'
  | 'guarded'
  | 'on-shift'
  | 'in-huddle'
  | 'waiting-for-you'
  | 'over-budget'
  | 'paused';
export const OFFICE_ROLE_STATES: readonly OfficeRoleState[] = [
  'off-duty',
  'scheduled',
  'guarded',
  'on-shift',
  'in-huddle',
  'waiting-for-you',
  'over-budget',
  'paused',
];

/** A role's state plus the human line under it on its card. */
export interface OfficeRoleStatus {
  state: OfficeRoleState;
  detail: string;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * The read-only tools a shift may hold — the server's `READ_ONLY_TOOLS`
 * (`server/src/claude/aux.ts`; a test keeps them equal) plus the web tools.
 * NEVER Bash, Edit, Write or NotebookEdit: a shift never executes or edits;
 * execution is a filed worker task or a saved-command run.
 */
export const SHIFT_READ_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'Agent', 'TodoWrite'];
/** Tools that read the open internet: using one taints the shift. */
export const SHIFT_WEB_TOOLS: readonly string[] = ['WebFetch', 'WebSearch'];
export const SHIFT_TOOL_ALLOWLIST: readonly string[] = [...SHIFT_READ_TOOLS, ...SHIFT_WEB_TOOLS];

/** Tools a role may never list: they execute or edit, which a shift never does. */
export const SHIFT_FORBIDDEN_TOOLS: readonly string[] = ['Bash', 'Edit', 'Write', 'NotebookEdit'];

/** The readable refusal for a role listing a `SHIFT_FORBIDDEN_TOOLS` tool (docs/office.md § API). */
export function shiftForbiddenToolsMessage(tools: readonly string[]): string {
  return `${tools.join(', ')} cannot be given to a role: shifts never execute or edit. Work that needs a command run or a file changed is filed as a worker task, or run as a saved command a human allowlisted for this office.`;
}

/** Why a role's tool list is refused, or null. */
export function shiftToolsRefusal(tools: readonly string[]): string | null {
  const forbidden = [...new Set(tools.filter((t) => SHIFT_FORBIDDEN_TOOLS.includes(t)))];
  if (forbidden.length) return shiftForbiddenToolsMessage(forbidden);
  const bad = tools.filter((t) => !SHIFT_TOOL_ALLOWLIST.includes(t));
  if (bad.length) return `not a shift tool: ${bad.join(', ')} (allowed: ${SHIFT_TOOL_ALLOWLIST.join(', ')})`;
  return null;
}

// ---------------------------------------------------------------------------
// Time zones (Intl only)
// ---------------------------------------------------------------------------

interface WallTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  dow: number; // 0 = Sunday
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** The wall clock in `tz` at `ms` (truncated to the minute). Throws RangeError on an unknown zone. */
function wallAt(ms: number, tz: string): WallTime {
  const parts = formatter(tz).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour') % 24;
  const minute = get('minute');
  return { year, month, day, hour, minute, dow: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/** local − UTC at instant `ms`, in ms */
function offsetAt(ms: number, tz: string): number {
  const w = wallAt(ms, tz);
  const floored = Math.floor(ms / 60_000) * 60_000;
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - floored;
}

/**
 * The FIRST instant whose wall clock in `tz` reads y-mo-d h:mi, or null when
 * that wall time does not exist (the spring-forward gap). A wall time that
 * occurs twice (fall back) resolves to the earlier one.
 */
function wallToInstant(y: number, mo: number, d: number, h: number, mi: number, tz: string): number | null {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const day = 86_400_000;
  const offsets = new Set([offsetAt(wall - day, tz), offsetAt(wall, tz), offsetAt(wall + day, tz)]);
  let best: number | null = null;
  for (const o of offsets) {
    const c = wall - o;
    const w = wallAt(c, tz);
    if (w.year === y && w.month === mo && w.day === d && w.hour === h && w.minute === mi) {
      if (best === null || c < best) best = c;
    }
  }
  return best;
}

/** The office-local calendar day of `ms` as `YYYY-MM-DD` (the budget day). */
export function officeDay(ms: number, tz: string): string {
  const w = wallAt(ms, tz);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

/**
 * The first instant of the office-local calendar day y-mo-d (normalised, so
 * day 32 is the 1st of the next month). Midnight itself can fall in a DST gap
 * in a few zones; the day then starts at its first wall minute that exists.
 */
function dayStartInstant(y: number, mo: number, d: number, tz: string): number {
  const n = new Date(Date.UTC(y, mo - 1, d));
  const [yy, mm, dd] = [n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate()];
  for (let m = 0; m < 24 * 60; m += 1) {
    const t = wallToInstant(yy, mm, dd, Math.floor(m / 60), m % 60, tz);
    if (t !== null) return t;
  }
  return n.getTime(); // unreachable: no zone skips a whole day's minutes
}

/** Local midnight of the office day `ms` falls in (`officeDay`), as epoch ms — the budget day's start. */
export function officeDayStart(ms: number, tz: string): number {
  const w = wallAt(ms, tz);
  return dayStartInstant(w.year, w.month, w.day, tz);
}

/** The NEXT office-local midnight after `ms` — when a day-budget trip clears. */
export function nextOfficeDayStart(ms: number, tz: string): number {
  const w = wallAt(ms, tz);
  return dayStartInstant(w.year, w.month, w.day + 1, tz);
}

/** The pause reason the day-budget trip writes; only a pause with this reason is lifted at midnight. */
export const OFFICE_OVER_BUDGET_REASON = 'over budget until midnight';

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad2 = (n: number) => String(n).padStart(2, '0');

/** `14:00` today, `Tue 09:00` within a week, else `2026-12-01 09:00` — in the office's zone. */
export function formatOfficeTime(ms: number, now: number, tz: string): string {
  const w = wallAt(ms, tz);
  const n = wallAt(now, tz);
  const hm = `${pad2(w.hour)}:${pad2(w.minute)}`;
  const dayW = Date.UTC(w.year, w.month - 1, w.day);
  const dayN = Date.UTC(n.year, n.month - 1, n.day);
  if (dayW === dayN) return hm;
  if (dayW > dayN && dayW - dayN < 7 * 86_400_000) return `${DOW_SHORT[w.dow]} ${hm}`;
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)} ${hm}`;
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

export interface CronSpec {
  source: string;
  minutes: number[];
  hours: number[];
  doms: number[];
  months: number[];
  /** 0 = Sunday (7 is folded into 0) */
  dows: number[];
  /** the field starts with `*` — Vixie semantics: dom and dow are OR-ed only when NEITHER is a star */
  domStar: boolean;
  dowStar: boolean;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const CRON_MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

interface FieldDef {
  name: string;
  min: number;
  max: number;
  names?: string[];
  namesBase?: number;
}
const FIELDS: FieldDef[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES, namesBase: 1 },
  { name: 'day of week', min: 0, max: 7, names: DOW_NAMES, namesBase: 0 },
];

function parseValue(raw: string, f: FieldDef): number {
  const lower = raw.toLowerCase();
  if (f.names) {
    const i = f.names.indexOf(lower);
    if (i >= 0) return i + (f.namesBase ?? 0);
  }
  if (!/^\d+$/.test(raw)) throw new Error(`${f.name}: "${raw}" is not a number`);
  const n = Number(raw);
  if (n < f.min || n > f.max) throw new Error(`${f.name}: ${n} is outside ${f.min}-${f.max}`);
  return n;
}

function parseField(text: string, f: FieldDef): number[] {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    if (!part) throw new Error(`${f.name}: empty list item`);
    const [rangePart, stepPart, extra] = part.split('/');
    if (extra !== undefined) throw new Error(`${f.name}: "${part}" has two steps`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) throw new Error(`${f.name}: bad step "${stepPart}"`);
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = f.min;
      hi = f.max;
    } else if (rangePart.includes('-')) {
      const [a, b, more] = rangePart.split('-');
      if (more !== undefined || !a || !b) throw new Error(`${f.name}: bad range "${rangePart}"`);
      lo = parseValue(a, f);
      hi = parseValue(b, f);
      if (lo > hi) throw new Error(`${f.name}: range "${rangePart}" runs backwards`);
    } else {
      lo = parseValue(rangePart, f);
      // `a/s` = from a to the field's end in steps of s
      hi = stepPart !== undefined ? f.max : lo;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/** Parse a 5-field cron expression (minute hour dom month dow) or a macro. Throws a readable Error. */
export function parseCron(expr: string): CronSpec {
  const source = String(expr ?? '').trim();
  const expanded = CRON_MACROS[source.toLowerCase()] ?? source;
  const fields = expanded.split(/\s+/).filter(Boolean);
  if (fields.length !== 5) throw new Error(`cron needs 5 fields (minute hour day month weekday), got ${fields.length}`);
  const [minutes, hours, doms, months, rawDows] = fields.map((t, i) => parseField(t, FIELDS[i]));
  const dows = [...new Set(rawDows.map((d) => d % 7))].sort((a, b) => a - b);
  return {
    source,
    minutes,
    hours,
    doms,
    months,
    dows,
    domStar: fields[2].startsWith('*'),
    dowStar: fields[4].startsWith('*'),
  };
}

/** The parse error of a cron expression, or null when it is valid. */
export function cronError(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function dayMatches(spec: CronSpec, month: number, dom: number, dow: number): boolean {
  if (!spec.months.includes(month)) return false;
  const domOk = spec.doms.includes(dom);
  const dowOk = spec.dows.includes(dow);
  if (spec.domStar && spec.dowStar) return true;
  if (spec.domStar) return dowOk;
  if (spec.dowStar) return domOk;
  return domOk || dowOk;
}

/** 8 years covers Feb 29 across a skipped leap year (2096 → 2104). */
const CRON_SEARCH_DAYS = 8 * 366;

/**
 * The first slot STRICTLY after `after` (epoch ms or Date), read in `tz`, or
 * null when the expression never fires (`0 0 30 2 *`). A slot in a DST gap
 * (a wall time that does not exist that day) is skipped; a wall time that
 * occurs twice fires once, at its first occurrence.
 */
export function nextCronSlot(expr: string | CronSpec, after: number | Date, tz: string): number | null {
  const spec = typeof expr === 'string' ? parseCron(expr) : expr;
  const afterMs = typeof after === 'number' ? after : after.getTime();
  const start = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  const s = wallAt(start, tz);
  for (let i = 0; i < CRON_SEARCH_DAYS; i++) {
    const date = new Date(Date.UTC(s.year, s.month - 1, s.day + i));
    const y = date.getUTCFullYear();
    const mo = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    if (!dayMatches(spec, mo, d, date.getUTCDay())) continue;
    for (const h of spec.hours) {
      if (i === 0 && h < s.hour) continue;
      for (const mi of spec.minutes) {
        if (i === 0 && h === s.hour && mi < s.minute) continue;
        const at = wallToInstant(y, mo, d, h, mi, tz);
        if (at !== null && at >= start) return at;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Catch-up: at most one wake per role
// ---------------------------------------------------------------------------

export interface OfficeDueWake {
  roleId: string;
  /** the schedule whose slot this is */
  schedule: string;
  /** the LATEST due slot — what the shift's `trigger.at` records */
  at: number;
  /** the earliest slot this wake stands for */
  firstMissedAt: number;
  /** due slots collapsed into this one wake (counted up to `CATCH_UP_SCAN_MAX`) */
  missed: number;
}

export const CATCH_UP_SCAN_MAX = 500;

/**
 * The latest slot ≤ `now`, given `first`, a due slot (≤ now). Binary search over
 * whole minutes on the monotone test "the next slot after t is ≤ now": ~22
 * `nextCronSlot` calls for any gap, however many slots it holds.
 */
function latestSlotUpTo(spec: CronSpec, first: number, now: number, tz: string): number {
  let lo = Math.floor(first / 60_000) - 1; // next slot after lo is `first` ≤ now
  let hi = Math.floor(now / 60_000); // next slot after hi is > now
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const n = nextCronSlot(spec, mid * 60_000, tz);
    if (n !== null && n <= now) lo = mid;
    else hi = mid;
  }
  return nextCronSlot(spec, lo * 60_000, tz) ?? first;
}

/**
 * The role's due cron wake, as an array of AT MOST ONE element (so callers can
 * concat across roles). A laptop asleep through five slots wakes the role ONCE,
 * at the latest of them — never once per missed slot.
 *
 * `lastShiftAt` = `trigger.at` of the role's last CRON shift, ran or skipped (a
 * guard skip consumes its slot, or it would be re-judged every sweep);
 * `armedAt` = when the schedule started counting (role created/enabled, office
 * enabled) — slots before it never fire. Bad expressions are skipped here;
 * they are refused on write (`cronError`).
 */
export function dueSlots(
  role: Pick<OfficeRole, 'id' | 'schedules' | 'enabled'>,
  lastShiftAt: number | null,
  armedAt: number,
  now: number,
  tz: string,
): OfficeDueWake[] {
  if (!role.enabled || armedAt > now) return [];
  const from = Math.max(lastShiftAt ?? -Infinity, armedAt);
  let best: OfficeDueWake | null = null;
  for (const schedule of role.schedules) {
    try {
      const spec = parseCron(schedule);
      const first = nextCronSlot(spec, from, tz);
      if (first === null || first > now) continue;
      // the latest due slot, found independently of the count: a capped forward
      // scan would report an old slot and the next sweep would wake the role again
      const last = latestSlotUpTo(spec, first, now, tz);
      let missed = 1;
      for (let s = first; missed < CATCH_UP_SCAN_MAX; missed++) {
        const n = nextCronSlot(spec, s, tz);
        if (n === null || n > now) break;
        s = n;
      }
      if (!best || last > best.at) {
        best = { roleId: role.id, schedule, at: last, firstMissedAt: first, missed };
      }
    } catch {
      continue;
    }
  }
  return best ? [best] : [];
}

/** The role's next cron slot after `after`, over all its schedules, or null. */
export function nextRoleSlot(role: Pick<OfficeRole, 'schedules'>, after: number, tz: string): number | null {
  let best: number | null = null;
  for (const s of role.schedules) {
    try {
      const n = nextCronSlot(s, after, tz);
      if (n !== null && (best === null || n < best)) best = n;
    } catch {
      continue;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Everything the guards read, computed by the caller (no I/O here). A fact a
 * guard needs that is missing (undefined) fails that guard CLOSED — a guard
 * exists to save money, so "cannot tell" skips.
 */
export interface OfficeGuardFacts {
  now: number;
  timezone: string;
  /** when the role's last RAN shift started; null = never ran */
  lastRanShiftAt: number | null;
  /** commits on the workspace's repos since `lastRanShiftAt` */
  newCommitsSinceLastShift?: number;
  /** tasks that landed (done/published) in the workspace since `lastRanShiftAt` */
  tasksLandedSinceLastShift?: number;
  openBugs?: number;
  /** what is left of today's budget (office and role cap, whichever is lower) */
  budgetLeftUsd?: number;
  officePaused?: boolean;
  officePausedReason?: string | null;
  /** open (not terminal) tasks this role filed */
  openTasksOfRole?: number;
  /** when the role's last ran shift ENDED (falls back to `lastRanShiftAt`) */
  lastShiftEndedAt?: number | null;
}

export type GuardVerdict =
  | { pass: true }
  | { pass: false; skip: true; reason: string; guard: OfficeGuardKind };

const usd = (n: number) => `$${n.toFixed(2)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Whether the office-local time of `now` falls in [from, to) (wrapping midnight when from > to; from == to = never). */
export function inQuietHours(from: string, to: string, now: number, tz: string): boolean {
  const f = HHMM_RE.exec(from);
  const t = HHMM_RE.exec(to);
  if (!f || !t) return false;
  const a = Number(f[1]) * 60 + Number(f[2]);
  const b = Number(t[1]) * 60 + Number(t[2]);
  if (a === b) return false;
  const w = wallAt(now, tz);
  const m = w.hour * 60 + w.minute;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

/** Why a guard is malformed, or null. */
export function guardError(g: OfficeGuard): string | null {
  switch (g.kind) {
    case 'open-bugs-below':
      return Number.isInteger(g.n) && g.n >= 1 ? null : 'open-bugs-below needs a whole n ≥ 1';
    case 'budget-left':
      return g.minUsd === undefined || (Number.isFinite(g.minUsd) && g.minUsd >= 0) ? null : 'budget-left needs minUsd ≥ 0';
    case 'quiet-hours':
      return HHMM_RE.test(g.from) && HHMM_RE.test(g.to) && g.from !== g.to ? null : 'quiet-hours needs from/to as distinct HH:MM';
    case 'cooldown':
      return Number.isFinite(g.minutes) && g.minutes > 0 ? null : 'cooldown needs minutes > 0';
    case 'new-commits-since':
    case 'tasks-landed-since':
    case 'office-not-paused':
    case 'no-open-task-of-this-role':
      return null;
    default:
      return `unknown guard ${(g as { kind: string }).kind}`;
  }
}

/** The guard as a phrase for a role card ("only after new code"). */
export function describeGuard(g: OfficeGuard): string {
  switch (g.kind) {
    case 'new-commits-since':
      return 'only after new code';
    case 'tasks-landed-since':
      return 'only after a task landed';
    case 'open-bugs-below':
      return `only while fewer than ${g.n} bugs are open`;
    case 'budget-left':
      return g.minUsd ? `only with ${usd(g.minUsd)} of budget left` : 'only with budget left';
    case 'office-not-paused':
      return 'not while the office is paused';
    case 'quiet-hours':
      return `not ${g.from}–${g.to}`;
    case 'no-open-task-of-this-role':
      return 'not while one of its tasks is open';
    case 'cooldown':
      return `at most every ${g.minutes} min`;
  }
}

function judge(g: OfficeGuard, f: OfficeGuardFacts): string | null {
  const unknown = (what: string) => `cannot tell ${what} — skipped to be safe`;
  switch (g.kind) {
    case 'new-commits-since':
      if (f.lastRanShiftAt === null) return null;
      if (f.newCommitsSinceLastShift === undefined) return unknown('whether there is new code');
      return f.newCommitsSinceLastShift > 0 ? null : 'no new code since the last shift';
    case 'tasks-landed-since':
      if (f.lastRanShiftAt === null) return null;
      if (f.tasksLandedSinceLastShift === undefined) return unknown('whether a task landed');
      return f.tasksLandedSinceLastShift > 0 ? null : 'no task landed since the last shift';
    case 'open-bugs-below':
      if (f.openBugs === undefined) return unknown('the open bug count');
      return f.openBugs < g.n ? null : `${plural(f.openBugs, 'open bug')} — runs only below ${g.n}`;
    case 'budget-left': {
      if (f.budgetLeftUsd === undefined) return unknown('the budget left');
      const min = g.minUsd ?? 0;
      if (f.budgetLeftUsd <= 0) return "today's budget is spent";
      return f.budgetLeftUsd >= min ? null : `only ${usd(f.budgetLeftUsd)} of today's budget left (needs ${usd(min)})`;
    }
    case 'office-not-paused':
      if (f.officePaused === undefined) return unknown('whether the office is paused');
      return f.officePaused ? `office paused${f.officePausedReason ? `: ${f.officePausedReason}` : ''}` : null;
    case 'quiet-hours':
      return inQuietHours(g.from, g.to, f.now, f.timezone) ? `quiet hours (${g.from}–${g.to})` : null;
    case 'no-open-task-of-this-role':
      if (f.openTasksOfRole === undefined) return unknown('its open tasks');
      return f.openTasksOfRole > 0 ? `already has ${plural(f.openTasksOfRole, 'open task')} of its own` : null;
    case 'cooldown': {
      const last = f.lastShiftEndedAt ?? f.lastRanShiftAt;
      if (last === null || last === undefined) return null;
      const ago = f.now - last;
      if (ago >= g.minutes * 60_000) return null;
      return `cooling down — last shift ${Math.max(0, Math.floor(ago / 60_000))} min ago (cooldown ${g.minutes} min)`;
    }
    default:
      return `unknown guard ${(g as { kind: string }).kind}`;
  }
}

/** The first failing guard as a skip with a human reason, else pass. Malformed guards skip. */
export function evalGuards(guards: readonly OfficeGuard[], facts: OfficeGuardFacts): GuardVerdict {
  for (const g of guards) {
    const bad = guardError(g);
    const reason = bad ? `misconfigured guard: ${bad}` : judge(g, facts);
    if (reason) return { pass: false, skip: true, reason, guard: g.kind };
  }
  return { pass: true };
}

// ---------------------------------------------------------------------------
// The hard gate (not configurable, unlike guards)
// ---------------------------------------------------------------------------

export interface OfficeGateFacts {
  officeEnabled: boolean;
  roleEnabled: boolean;
  officePausedAt: string | null;
  officePausedReason: string | null;
  /** Pause all (docs/pause.md) */
  serverPaused: boolean;
  dayBudgetUsd: number;
  daySpentUsd: number;
  /** `Office.budgetTrippedOn` and today's office-local day (`officeDay`) */
  budgetTrippedOn?: string | null;
  today?: string;
  roleCapUsd: number | null;
  roleSpentTodayUsd: number;
  activeShifts: number;
  maxSlots: number;
}

export type OfficeGateCode =
  | 'office-disabled'
  | 'role-disabled'
  | 'office-paused'
  | 'server-paused'
  | 'day-budget'
  | 'role-cap'
  | 'slots';

export interface OfficeGateRefusal {
  code: OfficeGateCode;
  reason: string;
}

/** The first hard reason a shift may not start now, or null when it may. */
export function officeHardGate(f: OfficeGateFacts): OfficeGateRefusal | null {
  if (!f.officeEnabled) return { code: 'office-disabled', reason: 'office is off' };
  if (!f.roleEnabled) return { code: 'role-disabled', reason: 'role is off' };
  if (f.officePausedAt) {
    return { code: 'office-paused', reason: `office paused${f.officePausedReason ? `: ${f.officePausedReason}` : ''}` };
  }
  if (f.serverPaused) return { code: 'server-paused', reason: 'everything is paused (Pause all)' };
  const tripped = !!f.budgetTrippedOn && !!f.today && f.budgetTrippedOn === f.today;
  if (tripped || !(f.daySpentUsd < f.dayBudgetUsd)) {
    return { code: 'day-budget', reason: `office day budget spent (${usd(f.daySpentUsd)} of ${usd(f.dayBudgetUsd)})` };
  }
  if (f.roleCapUsd !== null && !(f.roleSpentTodayUsd < f.roleCapUsd)) {
    return { code: 'role-cap', reason: `role cap spent today (${usd(f.roleSpentTodayUsd)} of ${usd(f.roleCapUsd)})` };
  }
  if (f.activeShifts >= f.maxSlots) {
    return { code: 'slots', reason: `all ${plural(f.maxSlots, 'shift slot')} busy` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The claim share (docs/office.md § Claim share, decisions.md 2026-11-04)
// ---------------------------------------------------------------------------

/** What the claim share reads of an office row. */
export type OfficeClaimFacts = Pick<Office, 'id' | 'enabled' | 'pausedAt' | 'budgetTrippedOn' | 'timezone' | 'maxSlots'>;

/**
 * Whether the office's day budget tripped on its CURRENT office-local day.
 * An unreadable zone fails closed (a trip with no readable "today" counts).
 */
export function officeBudgetTrippedToday(o: Pick<Office, 'budgetTrippedOn' | 'timezone'>, now: number): boolean {
  if (!o.budgetTrippedOn) return false;
  try {
    return o.budgetTrippedOn === officeDay(now, o.timezone);
  } catch {
    return true;
  }
}

/**
 * The ids of the offices whose budget tripped today, comma-joined: the ONE
 * value `OFFICE_CLAIM_GATE` binds (server/src/storage/queue-sql.ts). The SQL
 * cannot read an office-local day (SQLite has no zones), so the driver reads
 * the tripped rows, asks this, and binds the answer.
 */
export function officeTrippedParam(offices: readonly Pick<Office, 'id' | 'budgetTrippedOn' | 'timezone'>[], now: number): string {
  return offices.filter((o) => officeBudgetTrippedToday(o, now)).map((o) => o.id).join(',');
}

/**
 * Why the queued office task `task` may not be CLAIMED now, or null when it
 * may — a task with no `officeId` always may. An office task is claimable
 * only while its office exists, is enabled, is not paused, has not tripped
 * its day budget today, and has fewer `running`/`waiting` tasks than
 * `maxSlots` (the office's slot share, not first come first served —
 * decisions.md 2026-11-04). A missing office fails closed.
 * JS twin of `OFFICE_CLAIM_GATE` in server/src/storage/queue-sql.ts — edit together.
 * JS twin: predictSchedule (shared/src/schedule.ts) — the schedule simulator; edit together.
 */
export function officeClaimRefusal(
  task: Pick<Task, 'id' | 'officeId'>,
  tasks: readonly Pick<Task, 'id' | 'officeId' | 'status'>[],
  office: OfficeClaimFacts | null | undefined,
  now: number,
): string | null {
  if (task.officeId == null) return null;
  if (!office || office.id !== task.officeId) return 'office not found';
  if (!office.enabled) return 'office is off';
  if (office.pausedAt) return 'office paused';
  if (officeBudgetTrippedToday(office, now)) return 'office day budget spent';
  const live = tasks.filter((o) => o.officeId === task.officeId && o.id !== task.id && (o.status === 'running' || o.status === 'waiting'));
  if (live.length >= office.maxSlots) return `office slot share ${live.length}/${office.maxSlots}`;
  return null;
}

/** `officeClaimRefusal(...) === null`. JS twin of `OFFICE_CLAIM_GATE` — edit together. */
export function officeHasSlot(
  task: Pick<Task, 'id' | 'officeId'>,
  tasks: readonly Pick<Task, 'id' | 'officeId' | 'status'>[],
  office: OfficeClaimFacts | null | undefined,
  now: number,
): boolean {
  return officeClaimRefusal(task, tasks, office, now) === null;
}

// ---------------------------------------------------------------------------
// Autonomy → filing status
// ---------------------------------------------------------------------------

export function effectiveAutonomy(
  office: Pick<Office, 'autonomy'>,
  role: Pick<OfficeRole, 'autonomy'>,
): OfficeAutonomy {
  return role.autonomy ?? office.autonomy;
}

/** What a shift's filing becomes: no task (a proposal), a draft, or a queued task. */
export type OfficeFilingStatus = 'proposal' | 'draft' | 'queued';

/**
 * `proposals` → a proposal, never a task. A tainted shift → ALWAYS `draft` (a
 * human reads it before anything runs). A stopped global queue → `draft`.
 * Only a trusted shift under auto-run/autonomous with the queue on → `queued`.
 */
export function filingStatus(
  autonomy: OfficeAutonomy,
  tainted: boolean,
  opts: { queueStopped: boolean },
): OfficeFilingStatus {
  if (autonomy === 'proposals') return 'proposal';
  if (tainted) return 'draft';
  if (opts.queueStopped) return 'draft';
  if (autonomy === 'auto-run' || autonomy === 'autonomous') return 'queued';
  return 'draft';
}

// ---------------------------------------------------------------------------
// Filing caps and the shift row's record (docs/office.md § Filing)
// ---------------------------------------------------------------------------

/** Office filing caps (decisions.md 2026-11-05, open decision 5) — the office's own, never the agent ceiling. */
export const OFFICE_MAX_TASKS_PER_SHIFT_DEFAULT = 8;
export const OFFICE_MAX_TASKS_PER_SHIFT_MAX = 15;
export const OFFICE_MAX_OPEN_TASKS_DEFAULT = 12;
export const OFFICE_MAX_OPEN_TASKS_MAX = 200;

/** The note a stopped global queue puts on a filing — the same words an agent's filing gets. */
export const OFFICE_QUEUE_STOPPED_NOTE = 'queue is stopped — created as draft';
export const OFFICE_TAINTED_NOTE = 'tainted shift — created as draft for human review';
export const OFFICE_PROPOSALS_NOTE = 'proposals autonomy — nothing filed; held for the proposals card';

/** One task a shift asked for (the `tasks` result section). Agent text: a tainted shift's is untrusted. */
export interface ShiftTaskRequest {
  repoId: string;
  title: string;
  description: string;
  category: string | null;
  effort: EffortLevel | null;
}

/**
 * What a shift's `tasks` section became, on the shift row. `filed` ids are
 * `OfficeShift.filedTaskIds`; this is the rest: the status they were filed
 * at, why not `queued`, the requests HELD under proposals autonomy (no task
 * exists until the proposals card converts one) and the ones DROPPED, each
 * with its reason (a cap, a repo outside the workspace).
 */
export interface OfficeShiftFiling {
  status: OfficeFilingStatus;
  note: string | null;
  held: ShiftTaskRequest[];
  dropped: (ShiftTaskRequest & { reason: string })[];
}

// ---------------------------------------------------------------------------
// Command runs (docs/office.md § Command runs, decisions.md 2026-11-05)
// ---------------------------------------------------------------------------

/**
 * One entry of a role's command allowlist. `external` = the command reads the
 * outside world (Lighthouse against a public URL, a crawl): its output is
 * taint source `command-output` and its report goes to `untrustedPath`. A
 * local command's output is trusted, like the check output a worker's fix
 * message already carries.
 */
export interface OfficeRoleCommand {
  commandId: string;
  external: boolean;
}

/** Allowlist entries per role. */
export const OFFICE_ROLE_COMMANDS_MAX = 20;
/** Command runs one shift may ask for (the `commands` section). */
export const SHIFT_COMMANDS_MAX = 3;
/** A command run's own deadline. */
export const OFFICE_COMMAND_TIMEOUT_MS = 10 * 60_000;
/** Output lines kept per run (ANSI stripped), on the shift row and in the report. */
export const OFFICE_COMMAND_TAIL_LINES = 200;
/** …and at most this many characters of them. */
export const OFFICE_COMMAND_TAIL_CHARS = 30_000;

/** One run the shift asked for (the `commands` section). `why` is agent text: a tainted shift's is untrusted. */
export interface ShiftCommandRequest {
  commandId: string;
  why: string;
}

export type OfficeCommandRunStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

/**
 * A command run as the server recorded it. `done` = the process exited
 * (`exitCode` is its code, 0 or not); `error` = no verdict (timeout, could
 * not start, stopped) with `reason`; `skipped` = never started (`reason`: the
 * hard gate's line, or the allowlist / definition re-check at run time).
 */
export interface OfficeShiftCommandRun {
  commandId: string;
  /** snapshotted at run time ('' while pending) */
  name: string;
  repoId: string | null;
  external: boolean;
  status: OfficeCommandRunStatus;
  exitCode: number | null;
  /** the last `OFFICE_COMMAND_TAIL_LINES` lines, ANSI stripped */
  tail: string;
  reason: string | null;
  /** folder-relative report path (`deliverables/runs/…`, or its untrusted twin) */
  reportPath: string | null;
  /** the CommandRunner run (attachable while it lives) */
  runId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
}

/** What a shift's `commands` section became, on the shift row. */
export interface OfficeShiftCommands {
  requested: ShiftCommandRequest[];
  /** requests never run: not on the role's allowlist, or a repeat */
  dropped: (ShiftCommandRequest & { reason: string })[];
  runs: OfficeShiftCommandRun[];
  /** the `command-done` wake after the runs: the shift it started, or why it did not */
  wake: { shiftId: string | null; skipReason: string | null } | null;
}

/** A run whose output exists: a process ran (exited, timed out or was stopped). */
export function commandRunHasOutput(r: Pick<OfficeShiftCommandRun, 'status' | 'runId'>): boolean {
  return (r.status === 'done' || r.status === 'error') && r.runId !== null;
}

/**
 * The `command-output` taint refs the NEXT shift of the role inherits from
 * these runs: every external run that produced output (a skipped one read
 * nothing). Local output never taints.
 */
export function commandOutputTaint(runs: readonly OfficeShiftCommandRun[]): string[] {
  return [...new Set(runs.filter((r) => r.external && commandRunHasOutput(r)).map((r) => r.name || r.commandId))];
}

// ---------------------------------------------------------------------------
// Taint
// ---------------------------------------------------------------------------

/**
 * Where untrusted text can enter a shift (docs/office.md § The taint model):
 * an outside `signal`, a `web-tool`, a saved command's `command-output`, notes
 * a tainted shift wrote (`tainted-notes`), an artifact a tainted shift wrote
 * (`tainted-artifact`), or a resumed session a tainted shift ran in.
 */
export type TaintSourceKind =
  | 'signal'
  | 'web-tool'
  | 'command-output'
  | 'tainted-notes'
  | 'tainted-artifact'
  | 'tainted-session';
export const TAINT_SOURCE_KINDS: readonly TaintSourceKind[] = [
  'signal',
  'web-tool',
  'command-output',
  'tainted-notes',
  'tainted-artifact',
  'tainted-session',
];

export interface TaintSource {
  kind: TaintSourceKind;
  ref: string;
}

/** `kind:ref`, the form stored in `OfficeShift.taintSources`. */
export function taintLabel(s: TaintSource): string {
  return `${s.kind}:${s.ref}`;
}

export interface ShiftTaintInputs {
  trigger: { kind: OfficeShiftTriggerKind; ref?: string | null };
  /** tools the shift USED; pass the GRANTED set when use is unknown (fails closed) */
  tools: readonly string[];
  /** saved commands whose output the shift read */
  commandOutputs?: readonly string[];
  /** the role's notes file and whether a tainted shift wrote it */
  notes?: { path: string; tainted: boolean } | null;
  /** office artifacts the shift read */
  artifacts?: readonly { path: string; tainted: boolean }[];
  /** the session the shift resumes, if any */
  session?: { id: string; tainted: boolean } | null;
}

export function shiftTaint(inputs: ShiftTaintInputs): { tainted: boolean; sources: TaintSource[] } {
  const sources: TaintSource[] = [];
  const seen = new Set<string>();
  const add = (s: TaintSource) => {
    const k = taintLabel(s);
    if (!seen.has(k)) {
      seen.add(k);
      sources.push(s);
    }
  };
  if (inputs.trigger.kind === 'signal') add({ kind: 'signal', ref: inputs.trigger.ref || 'signal' });
  for (const t of inputs.tools) if (SHIFT_WEB_TOOLS.includes(t)) add({ kind: 'web-tool', ref: t });
  for (const c of inputs.commandOutputs ?? []) add({ kind: 'command-output', ref: c });
  if (inputs.notes?.tainted) add({ kind: 'tainted-notes', ref: inputs.notes.path });
  for (const a of inputs.artifacts ?? []) if (a.tainted) add({ kind: 'tainted-artifact', ref: a.path });
  if (inputs.session?.tainted) add({ kind: 'tainted-session', ref: inputs.session.id });
  return { tainted: sources.length > 0, sources };
}

/** A tainted shift's artifact as the server stores it; only some fields are server-known. */
export interface OfficeShiftArtifact {
  shiftId: string;
  /** human-set (the role row), not agent text */
  roleName: string;
  startedAt: string;
  endedAt: string | null;
  costUsd: number;
  /** status is the server's row; `title` is agent text and is dropped */
  filedTasks: readonly { id: string; status: string; title?: string }[];
  /** files the shift wrote (paths as the server observed them) */
  files: readonly string[];
  /** agent text — never copied into a digest */
  summary?: string;
  body?: string;
  [extra: string]: unknown;
}

/** What may be shown to a TRUSTED reader (a later trusted shift, a brief) about a tainted artifact. */
export interface TaintedDigest {
  shiftId: string;
  roleName: string;
  startedAt: string;
  endedAt: string | null;
  costUsd: number;
  filedTasks: { id: string; status: string }[];
  files: string[];
  /** one line assembled from the fields above */
  line: string;
}

const SAFE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const SAFE_STATUS_RE = /^[a-z][a-z-]{0,31}$/;
/** paths without spaces or punctuation that could carry a sentence */
const SAFE_PATH_RE = /^[A-Za-z0-9._/@+-]{1,200}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * The server-known facts of a tainted artifact, rebuilt field by field — never
 * a spread of the input, never `summary`/`body`/titles. Paths, ids and statuses
 * that do not look like paths, ids and statuses (e.g. a "path" carrying a
 * sentence) are replaced, since an agent picked them.
 */
export function taintedDigest(a: OfficeShiftArtifact): TaintedDigest {
  const id = (s: unknown) => (typeof s === 'string' && SAFE_ID_RE.test(s) ? s : '(id withheld)');
  const iso = (s: unknown) => (typeof s === 'string' && ISO_RE.test(s) ? s : '(time withheld)');
  const filedTasks = (Array.isArray(a.filedTasks) ? a.filedTasks : []).map((t) => ({
    id: id(t?.id),
    status: typeof t?.status === 'string' && SAFE_STATUS_RE.test(t.status) ? t.status : 'unknown',
  }));
  const files = (Array.isArray(a.files) ? a.files : []).map((p) =>
    typeof p === 'string' && SAFE_PATH_RE.test(p) && !p.split('/').includes('..') ? p : '(path withheld)',
  );
  const costUsd = typeof a.costUsd === 'number' && Number.isFinite(a.costUsd) ? a.costUsd : 0;
  const roleName = typeof a.roleName === 'string' ? a.roleName.replace(/[\r\n]+/g, ' ').slice(0, 80) : 'role';
  const startedAt = iso(a.startedAt);
  const endedAt = a.endedAt === null ? null : iso(a.endedAt);
  const tasks = filedTasks.length ? filedTasks.map((t) => `${t.id} (${t.status})`).join(', ') : 'none';
  const line =
    `${roleName} shift ${id(a.shiftId)} at ${startedAt} (untrusted input, content withheld): ` +
    `cost ${usd(costUsd)}; filed ${tasks}; wrote ${files.length ? files.join(', ') : 'no files'}`;
  return { shiftId: id(a.shiftId), roleName, startedAt, endedAt, costUsd, filedTasks, files, line };
}

/**
 * Whether a shift may `--resume` the role's session. Never when there is none,
 * and never a TRUSTED shift over a TAINTED session (the injected text would sit
 * in its context). A tainted shift may resume either (and taints the session).
 */
export function mayResume(role: Pick<OfficeRole, 'sessionId' | 'sessionTainted'>, shiftTainted: boolean): boolean {
  if (!role.sessionId) return false;
  if (role.sessionTainted && !shiftTainted) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Role state
// ---------------------------------------------------------------------------

export interface OfficeRoleStateFacts {
  now: number;
  office: Pick<Office, 'enabled' | 'pausedAt' | 'pausedReason' | 'dayBudgetUsd' | 'timezone' | 'budgetTrippedOn'>;
  serverPaused: boolean;
  /** a shift of this role is live */
  onShift: boolean;
  /** what the live shift is doing, for the detail line */
  shiftLabel?: string | null;
  inHuddle: boolean;
  /** questions / proposals / approvals of this role waiting on the human */
  waitingForYou: number;
  officeSpentTodayUsd: number;
  roleSpentTodayUsd: number;
  /** the reason the role's latest due wake was skipped by a guard, when no shift ran since */
  lastGuardSkip?: string | null;
}

/**
 * The state shown on a role's card, by precedence: paused › off (office/role off) › waiting-for-you ›
 * in-huddle › on-shift › over-budget › guarded › scheduled › off-duty.
 */
export function roleState(role: OfficeRole, f: OfficeRoleStateFacts): OfficeRoleStatus {
  const tz = f.office.timezone;
  if (f.office.pausedAt) return { state: 'paused', detail: `office paused${f.office.pausedReason ? `: ${f.office.pausedReason}` : ''}` };
  if (f.serverPaused) return { state: 'paused', detail: 'everything is paused (Pause all)' };
  if (!f.office.enabled) return { state: 'off-duty', detail: 'office is off' };
  if (!role.enabled) return { state: 'off-duty', detail: 'role is off' };
  if (f.waitingForYou > 0) {
    return { state: 'waiting-for-you', detail: `${plural(f.waitingForYou, 'item')} waiting on you` };
  }
  if (f.inHuddle) return { state: 'in-huddle', detail: 'in a huddle' };
  if (f.onShift) return { state: 'on-shift', detail: f.shiftLabel || 'on shift' };
  const today = officeDay(f.now, tz);
  if ((f.office.budgetTrippedOn && f.office.budgetTrippedOn === today) || !(f.officeSpentTodayUsd < f.office.dayBudgetUsd)) {
    return { state: 'over-budget', detail: `office spent ${usd(f.officeSpentTodayUsd)} of ${usd(f.office.dayBudgetUsd)} today` };
  }
  if (role.capUsd !== null && !(f.roleSpentTodayUsd < role.capUsd)) {
    return { state: 'over-budget', detail: `role spent ${usd(f.roleSpentTodayUsd)} of its ${usd(role.capUsd)} cap today` };
  }
  const next = nextRoleSlot(role, f.now, tz);
  const nextLine = next !== null ? `next ${formatOfficeTime(next, f.now, tz)}` : null;
  if (f.lastGuardSkip) {
    const skip = `skip: ${f.lastGuardSkip}`;
    return { state: 'guarded', detail: nextLine ? `${skip} · ${nextLine}` : skip };
  }
  if (nextLine) return { state: 'scheduled', detail: nextLine };
  if (role.triggers.length) {
    const on = role.triggers
      .map((t) => (t.kind === 'event' ? t.event : t.kind === 'signal' ? `signal ${t.source}` : 'its command runs finishing'))
      .join(', ');
    return { state: 'off-duty', detail: `on call: wakes on ${on}` };
  }
  return { state: 'off-duty', detail: 'no schedule' };
}

/** One role's card line, as the scheduler computes it (docs/office.md § Scheduler and states). */
export interface OfficeRoleStateEntry extends OfficeRoleStatus {
  roleId: string;
  /** the role's next cron slot (ISO), or null when it has none */
  nextSlotAt: string | null;
  /** what the role spent on its office-local today (`officeSpendSince` with the role), the /office page's "today" column */
  spentTodayUsd: number;
}

/** `GET /api/offices/:id/states`, and `states` on `office.updated` */
export interface OfficeStates {
  officeId: string;
  /** when they were computed (ISO) */
  at: string;
  /** what the whole office spent on its office-local today, against `dayBudgetUsd` */
  spentTodayUsd: number;
  states: OfficeRoleStateEntry[];
}

/**
 * Whether a role write re-arms its schedule (`armedAt` = now): it was off and
 * is turned on, or its schedules changed. A slot from before that moment was
 * never owed — turning a role on at 10:00 must not fire its 09:00 slot.
 */
export function roleRearms(cur: Pick<OfficeRole, 'enabled' | 'schedules'>, patch: Partial<Pick<OfficeRole, 'enabled' | 'schedules'>>): boolean {
  if (patch.enabled === true && !cur.enabled) return true;
  if (patch.schedules !== undefined) {
    const a = [...patch.schedules].map((x) => x.trim()).sort();
    const b = [...cur.schedules].map((x) => x.trim()).sort();
    if (a.length !== b.length || a.some((x, i) => x !== b[i])) return true;
  }
  return false;
}

/** `POST /api/offices/:id/roles/:roleId/wake` */
export interface OfficeWakeBody {
  /** the requester's words, handed to the shift as TRUSTED text */
  note?: string;
}
export const OFFICE_WAKE_NOTE_MAX = 4000;

// ---------------------------------------------------------------------------
// REST API (/api/offices — docs/office.md § API)
// ---------------------------------------------------------------------------

/** `GET /api/offices/:id` */
export interface OfficeDetail {
  office: Office;
  roles: OfficeRole[];
  /** newest first, at most `OFFICE_DETAIL_SHIFTS` */
  shifts: OfficeShift[];
}
export const OFFICE_DETAIL_SHIFTS = 50;

/** `POST /api/offices` */
export interface OfficeCreateBody {
  workspaceId: string;
  /** default: `<shared space folder>/office` when every repo of the workspace is in one space; else required */
  folderPath?: string;
  /** an `OFFICE_THEMES` id (server); default `pixel-office` */
  theme?: string;
  /** an IANA zone; default the server's */
  timezone?: string;
}

/** `POST /api/offices` → 201 */
export interface OfficeCreateResult extends Omit<OfficeDetail, 'shifts'> {
  /** what the folder scaffold created / left alone (relative paths) */
  scaffold: { created: string[]; kept: string[]; archived: string[] };
  // `archived`: role notes already in the folder, moved to `untrusted/archived-notes/` (never inherited as trusted)
}

/** `PATCH /api/offices/:id` — every field optional. `enabled: true` needs `dayBudgetUsd > 0`. */
export interface OfficePatchBody {
  folderPath?: string;
  autonomy?: OfficeAutonomy;
  dayBudgetUsd?: number;
  maxSlots?: number;
  maxTasksPerShift?: number;
  maxOpenTasks?: number;
  theme?: string;
  timezone?: string;
  enabled?: boolean;
  /** true pauses (reason `OFFICE_HUMAN_PAUSE_REASON`), false resumes */
  paused?: boolean;
}
export const OFFICE_HUMAN_PAUSE_REASON = 'paused by a human';

/** The editable role fields, as the API takes them. */
export interface OfficeRoleFields {
  name: string;
  avatar: string;
  title: string;
  prompt: string;
  model: string;
  effort: EffortLevel | null;
  tools: string[];
  autonomy: OfficeAutonomy | null;
  capUsd: number | null;
  schedules: string[];
  triggers: OfficeTrigger[];
  guards: OfficeGuard[];
  enabled: boolean;
}

/**
 * `POST /api/offices/:id/roles`: a `preset` fills every field it has; any
 * field given overrides it. Without a preset, `key`, `title`, `prompt` are
 * required. `name`/`avatar` default to the generated identity.
 */
export type OfficeRoleCreateBody = Partial<OfficeRoleFields> & { key?: string; preset?: OfficeRolePreset | null };

/** `PUT /api/offices/:id/roles/:roleId/commands` — the whole allowlist, replaced. */
export interface OfficeRoleCommandsBody {
  commands: OfficeRoleCommand[];
}

/** `PATCH /api/offices/:id/roles/:roleId` — `key` (and so the notes path) is create-only; `commands` has its own route. */
export type OfficeRolePatchBody = Partial<OfficeRoleFields>;

/** Every role write's answer. `taintingTools` = the role's web tools: a shift using one is tainted. */
export interface OfficeRoleWriteResult {
  role: OfficeRole;
  taintingTools: string[];
  /** set when `taintingTools` is not empty */
  warning?: string;
}

/**
 * `GET /api/offices/:id/roles/:roleId/notes-review` — the notes Mark notes
 * reviewed would vouch for: the file the role's next shift reads while
 * `notesTaintedAt` is set (the untrusted twin when it exists, `promotes`;
 * else `roles/<key>.md`), and the sha256 of exactly this `text`.
 */
export interface OfficeNotesReview {
  /** folder-relative */
  path: string;
  /** true = the twin `untrusted/roles/<key>.md`, copied over `roles/<key>.md` on review */
  promotes: boolean;
  /** null = no notes file */
  text: string | null;
  sha256: string | null;
  modifiedAt: string | null;
  notesTaintedAt: string | null;
}

/** `POST …/notes-reviewed` — the version reviewed, as GET …/notes-review returned it; any mismatch is a 409. */
export interface OfficeNotesReviewedBody {
  notesTaintedAt: string;
  sha256: string | null;
}

// ---------------------------------------------------------------------------
// Briefings, proposals, wishes (docs/office.md § Data model, phase 3)
// ---------------------------------------------------------------------------

/** `standup` = a role's routine shift report; `brief` = a Director's briefing to the human. */
export type OfficeBriefKind = 'standup' | 'brief';

/** A markdown deliverable a shift wrote (`tm_office_briefs`); the text lives in the office folder at `path`. */
export interface OfficeBrief {
  id: string;
  officeId: string;
  roleId: string;
  shiftId: string;
  kind: OfficeBriefKind;
  /** office-folder-relative path of the markdown file */
  path: string;
  /** one short line for lists and pings */
  summary: string;
  /** set when the writing shift was tainted — the text is untrusted until reviewed */
  taintedAt: string | null;
  /** set by a human's Mark reviewed (`markReviewed('brief', id)`) */
  reviewedAt: string | null;
  createdAt: string;
}

export type OfficeProposalStatus = 'pending' | 'accepted' | 'rejected';

/**
 * A task a shift wants filed, held for a human's decision (`tm_office_proposals`).
 * `repoId` null = the office decides at accept time (a cross-repo idea). Decided
 * only through the conditional `decideProposal` (pending → accepted|rejected).
 */
export interface OfficeProposal {
  id: string;
  officeId: string;
  roleId: string;
  shiftId: string;
  title: string;
  body: string;
  repoId: string | null;
  status: OfficeProposalStatus;
  taintedAt: string | null;
  decidedAt: string | null;
  /** the actor that decided (`human`, `telegram`) */
  decidedBy: string | null;
  /** the task an accept filed */
  filedTaskId: string | null;
  /** set by `markReviewed('proposal', id)` — a tainted proposal's text read by a human */
  reviewedAt: string | null;
  createdAt: string;
}

export type OfficeWishStatus = 'open' | 'planned' | 'done' | 'dropped';

/** A human's standing wish for the office's vision (`tm_office_wishes`); the Director plans from the open ones. */
export interface OfficeWish {
  id: string;
  officeId: string;
  text: string;
  status: OfficeWishStatus;
  createdAt: string;
  updatedAt: string;
}
