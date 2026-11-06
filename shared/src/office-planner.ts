// The office planner (docs/office.md § Office planner): a wizard plus a
// read-only Claude session that designs an office before it exists and
// advises on it afterwards. It is the owner's assistant — never a role, never
// a shift, never wakes on its own. What it proposes is a BLUEPRINT (a whole
// office, before one exists) or a blueprint DIFF (exact changes to the
// office as it was when the planner looked), and nothing changes until the
// owner presses Apply — which goes through the office routes' own validators.
//
// Pure: types, the wizard's vocabulary, and the blueprint → diff mapping the
// server's Apply and the SPA's preview share.

import type { EffortLevel } from './types.ts';
import { OFFICE_DOC_MAX_CHARS, type Office, type OfficeAutonomy, type OfficeGuard, type OfficeRole, type OfficeRolePreset, type OfficeTrigger } from './office.ts';

/** The wizard's checkboxes — what the owner wants from the office. */
export type OfficePlannerGoal = 'ship-features' | 'keep-tested' | 'seo-content' | 'ops-uptime' | 'research';
export const OFFICE_PLANNER_GOALS: readonly OfficePlannerGoal[] = ['ship-features', 'keep-tested', 'seo-content', 'ops-uptime', 'research'];
export const OFFICE_PLANNER_GOAL_LABELS: Readonly<Record<OfficePlannerGoal, string>> = {
  'ship-features': 'Ship features',
  'keep-tested': 'Keep it tested',
  'seo-content': 'SEO / content',
  'ops-uptime': 'Ops / uptime',
  research: 'Research',
};

/** The wizard's free text is clipped here. */
export const OFFICE_PLANNER_WANTS_MAX = 4_000;
/** A message to the assistant is clipped here. */
export const OFFICE_PLANNER_MESSAGE_MAX = 8_000;
/** Roles one blueprint may hold. */
export const OFFICE_BLUEPRINT_ROLES_MAX = 12;
/** A blueprint's vision/priorities draft (the docs' own cap). */
export const OFFICE_BLUEPRINT_DOC_MAX = OFFICE_DOC_MAX_CHARS;
/** `planner.md` keeps this many applied entries (newest last). */
export const OFFICE_PLANNER_LOG_ENTRIES = 20;

/** The wizard's answers (step 1, no tokens). */
export interface OfficePlannerWizard {
  goals: OfficePlannerGoal[];
  /** what the owner wants, in their words */
  wants: string;
  /** how hands-off */
  autonomy: OfficeAutonomy;
  /** the $ appetite; `month` is divided by 30 for the day budget */
  budget: { amountUsd: number; per: 'day' | 'month' };
  /** when nothing should wake (office-local HH:MM), or none */
  quietHours: { from: string; to: string } | null;
  /** IANA zone the office will run in */
  timezone: string;
}

/** The wizard's appetite as a day budget (USD, cents). */
export function wizardDayBudget(w: Pick<OfficePlannerWizard, 'budget'>): number {
  const day = w.budget.per === 'month' ? w.budget.amountUsd / 30 : w.budget.amountUsd;
  return Math.round(Math.max(0, day) * 100) / 100;
}

/** The office-level numbers a blueprint sets. */
export interface OfficeBlueprintSettings {
  maxSlots: number;
  dayBudgetUsd: number;
  maxTasksPerShift: number;
  maxOpenTasks: number;
  autonomy: OfficeAutonomy;
}
export const OFFICE_BLUEPRINT_SETTING_KEYS: readonly (keyof OfficeBlueprintSettings)[] = [
  'maxSlots',
  'dayBudgetUsd',
  'maxTasksPerShift',
  'maxOpenTasks',
  'autonomy',
];

/** The role fields a blueprint may set (identity — name, avatar — is the server's). */
export interface OfficeBlueprintRoleFields {
  title: string;
  prompt: string;
  model: string;
  effort: EffortLevel | null;
  tools: string[];
  schedules: string[];
  guards: OfficeGuard[];
  triggers: OfficeTrigger[];
  capUsd: number | null;
  autonomy: OfficeAutonomy | null;
}
export const OFFICE_BLUEPRINT_ROLE_FIELDS: readonly (keyof OfficeBlueprintRoleFields)[] = [
  'title',
  'prompt',
  'model',
  'effort',
  'tools',
  'schedules',
  'guards',
  'triggers',
  'capUsd',
  'autonomy',
];

/** One role of a blueprint: a kept preset (its own key) or a custom role. */
export interface OfficeBlueprintRole extends OfficeBlueprintRoleFields {
  key: string;
  /** the preset this role is (keeps the preset's key), or null = custom */
  preset: OfficeRolePreset | null;
  /** one line: why this office needs it */
  why: string;
}

/** A whole office, before one exists. */
export interface OfficeBlueprint {
  summary: string;
  office: OfficeBlueprintSettings;
  /** every role the office should have; a preset left out is dropped */
  roles: OfficeBlueprintRole[];
  /** drafts of vision.md / priorities.md ('' = leave the scaffold's) */
  vision: string;
  priorities: string;
  /** 3–6 concrete first wins for these repos */
  wins: string[];
  /** what this office should not try */
  avoid: string[];
  cost: { dailyUsd: number; derivation: string };
}

/** A partial edit of an existing role: only the listed fields change. */
export type OfficeBlueprintRoleEdit = { key: string; why?: string } & Partial<OfficeBlueprintRoleFields>;

/** Exact changes to an existing office (or, at creation, to the presets). */
export interface OfficeBlueprintDiff {
  summary: string;
  office?: Partial<OfficeBlueprintSettings>;
  addRoles?: OfficeBlueprintRole[];
  editRoles?: OfficeBlueprintRoleEdit[];
  /** role keys */
  removeRoles?: string[];
  vision?: string;
  priorities?: string;
  cost?: { dailyUsd: number; derivation: string };
}

/**
 * What a planner reply carried, stored on the chat message: a blueprint
 * (before the office exists) or a diff against the office state whose
 * fingerprint the server computed when it showed the planner that state.
 */
export type OfficePlannerProposal =
  | { kind: 'blueprint'; blueprint: OfficeBlueprint }
  | { kind: 'diff'; diff: OfficeBlueprintDiff; baseFingerprint: string };

/** `GET /api/office-planner/:workspaceId` */
export interface OfficePlannerView {
  workspaceId: string;
  /** null until the first message */
  chat: import('./types.ts').Chat | null;
  messages: import('./types.ts').ChatMessage[];
  office: Office | null;
  /** the office's CURRENT fingerprint (null without an office) — a diff on another base is stale */
  fingerprint: string | null;
}

/** `POST /api/office-planner/:workspaceId/apply` */
export interface OfficePlannerApplyResult {
  office: Office;
  roles: OfficeRole[];
  /** the steps that ran, in order, as sentences */
  applied: string[];
  fingerprint: string;
}

/** A diff with nothing in it. */
export function isEmptyBlueprintDiff(d: OfficeBlueprintDiff): boolean {
  return (
    !(d.office && Object.keys(d.office).length) &&
    !d.addRoles?.length &&
    !d.editRoles?.length &&
    !d.removeRoles?.length &&
    d.vision === undefined &&
    d.priorities === undefined
  );
}

const roleFieldsOf = (r: OfficeBlueprintRoleFields): OfficeBlueprintRoleFields => {
  const out = {} as Record<string, unknown>;
  for (const k of OFFICE_BLUEPRINT_ROLE_FIELDS) out[k] = r[k];
  return out as unknown as OfficeBlueprintRoleFields;
};

/**
 * A blueprint as the diff Apply runs against the office it just created from
 * the presets: presets the blueprint leaves out are removed, the ones it keeps
 * get every field it sets, the rest are added. `existing` = the created
 * office's roles (key + preset).
 */
export function blueprintAsDiff(
  b: OfficeBlueprint,
  existing: readonly Pick<OfficeRole, 'key' | 'preset'>[],
): OfficeBlueprintDiff {
  const keys = new Set(existing.map((r) => r.key));
  const wanted = new Set(b.roles.map((r) => r.key));
  return {
    summary: b.summary,
    office: { ...b.office },
    removeRoles: existing.filter((r) => !wanted.has(r.key)).map((r) => r.key),
    editRoles: b.roles.filter((r) => keys.has(r.key)).map((r) => ({ key: r.key, why: r.why, ...roleFieldsOf(r) })),
    addRoles: b.roles.filter((r) => !keys.has(r.key)).map((r) => ({ ...r })),
    ...(b.vision.trim() ? { vision: b.vision } : {}),
    ...(b.priorities.trim() ? { priorities: b.priorities } : {}),
  };
}

/** The fields an edit actually changes against `cur` (a field equal to the current value is not a change). */
export function roleEditChanges(edit: OfficeBlueprintRoleEdit, cur: Pick<OfficeRole, keyof OfficeBlueprintRoleFields>): (keyof OfficeBlueprintRoleFields)[] {
  return OFFICE_BLUEPRINT_ROLE_FIELDS.filter((k) => edit[k] !== undefined && JSON.stringify(edit[k]) !== JSON.stringify(cur[k]));
}

/**
 * The canonical text of everything a diff can touch, which the server hashes
 * into the office's fingerprint: the office settings, every role's
 * plannable fields (by key, sorted), and the two docs' hashes. A shift's
 * notes, a budget trip or a pause are NOT in it — they do not make a diff
 * stale.
 */
export function plannerFingerprintInput(
  office: Pick<Office, keyof OfficeBlueprintSettings | 'timezone'>,
  roles: readonly Pick<OfficeRole, 'key' | 'preset' | 'enabled' | keyof OfficeBlueprintRoleFields>[],
  docs: { vision: string | null; priorities: string | null },
): string {
  const settings: Record<string, unknown> = { timezone: office.timezone };
  for (const k of OFFICE_BLUEPRINT_SETTING_KEYS) settings[k] = office[k];
  const rs = [...roles]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((r) => ({ key: r.key, preset: r.preset, enabled: r.enabled, ...roleFieldsOf(r) }));
  return JSON.stringify({ settings, roles: rs, docs });
}
