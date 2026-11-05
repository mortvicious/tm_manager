// A shift's structured result is a SECTION REGISTRY (docs/office.md § Shifts
// at run time → The result): each section is a key of the result object with
// its own zod schema, its JSON-schema twin (what the prompt shows) and an
// `apply(value, ctx)` that does the section's server-side work. The result
// object is strict — an unknown key is a validation error, so the standard
// correction is typed into the session (aux.ts, ≤2) instead of a section
// being silently dropped. Every section is optional: a shift that found
// nothing returns `{}`.
//
// This module registers `notes`, `deliverables` and `tasks` (filing.ts);
// later phases register theirs (command runs, briefs) with `registerShiftSection`.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Office, OfficeRole } from '@tm/shared';
import { isInside, realPathDeep } from '../folder-guard.ts';
import type { OrchestratorApi } from '../app-types.ts';
import type { Storage } from '../storage/types.ts';
import { SHIFT_TASKS_DESCRIBE, SHIFT_TASKS_JSON_SCHEMA, fileShiftTasks, shiftTasksSchema, type ShiftTaskInput } from './filing.ts';
import { untrustedPath } from './isolation.ts';

export interface ShiftSectionCtx {
  storage: Storage;
  office: Office;
  role: OfficeRole;
  shiftId: string;
  /** the shift's taint (decided before spawn); a tainted shift's files go to `untrustedPath` */
  tainted: boolean;
  now: Date;
  /**
   * Where a TAINTED shift's file goes instead of `rel` (folder-relative or
   * absolute inside the folder) — the shift-isolation card's `untrustedPath`,
   * never a path hard-coded here.
   */
  untrustedPath: (rel: string) => string;
  /** the shift's run (`created_by_run` of what it files); default: the shift row's */
  runId?: string | null;
  /** kicked when a section filed queued work (`tasks`) */
  orchestrator?: OrchestratorApi;
}

export interface ShiftSectionApplied {
  section: string;
  /** folder-relative paths the section wrote, as the server observed them */
  files: string[];
  tainted: boolean;
  /** tasks the section filed (`tasks`) */
  taskIds?: string[];
  /** parts of the section that failed while the rest applied (one bad file of several) */
  errors?: string[];
}

export interface ShiftSection<T> {
  key: string;
  /** one line for the prompt: what the section is for and what the server does with it */
  describe: string;
  schema: z.ZodType<T>;
  /** the JSON-schema twin of `schema`, shown to the model by `resultInstruction` */
  jsonSchema: Record<string, unknown>;
  apply(value: T, ctx: ShiftSectionCtx): Promise<ShiftSectionApplied>;
}

const registry = new Map<string, ShiftSection<unknown>>();

/** Add a section. A second section under the same key is a programming error. */
export function registerShiftSection<T>(section: ShiftSection<T>): void {
  if (!/^[a-z][a-zA-Z0-9]*$/.test(section.key)) throw new Error(`shift section: bad key "${section.key}"`);
  if (registry.has(section.key)) throw new Error(`shift section "${section.key}" is already registered`);
  registry.set(section.key, section as ShiftSection<unknown>);
}

/** Registered sections, in registration order. */
export function shiftSections(): ShiftSection<unknown>[] {
  return [...registry.values()];
}

export type ShiftResult = Record<string, unknown>;

/** The zod validator of a whole result: every section optional, unknown keys refused. */
export function shiftResultSchema(): z.ZodType<ShiftResult> {
  const shape: Record<string, z.ZodType> = {};
  for (const s of registry.values()) shape[s.key] = s.schema.optional();
  return z.object(shape).strict() as unknown as z.ZodType<ShiftResult>;
}

/** The JSON schema the prompt shows (`resultInstruction`). */
export function shiftResultJsonSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const s of registry.values()) properties[s.key] = s.jsonSchema;
  return { type: 'object', additionalProperties: false, properties };
}

/** The prompt's bullet list of sections. */
export function shiftSectionGuide(): string {
  return shiftSections()
    .map((s) => `- \`${s.key}\`: ${s.describe}`)
    .join('\n');
}

export interface ShiftApplyOutcome {
  applied: ShiftSectionApplied[];
  errors: { section: string; error: string }[];
}

/**
 * Apply every section present in a validated result, in registration order.
 * A section that throws is recorded and the others still run — one bad
 * deliverable path must not cost the role its notes.
 */
export async function applyShiftResult(result: ShiftResult, ctx: ShiftSectionCtx): Promise<ShiftApplyOutcome> {
  const out: ShiftApplyOutcome = { applied: [], errors: [] };
  for (const s of registry.values()) {
    if (result[s.key] === undefined) continue;
    try {
      out.applied.push(await s.apply(result[s.key], ctx));
    } catch (e) {
      out.errors.push({ section: s.key, error: (e as Error).message });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writing into the office folder
// ---------------------------------------------------------------------------

/** One path segment a section may write: no leading dot (so no `.`, `..` or hidden files). */
const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

/** Server-owned files no section may write, whatever path it names. */
export function isProtectedOfficePath(office: Pick<Office, 'folderPath'>, rel: string): boolean {
  if (/^roles\/[^/]+\.feedback\.md$/.test(rel) || rel === 'README.md') return true;
  return rel === path.relative(path.resolve(office.folderPath), untrustedPath(office, 'README.md'));
}

/** `rel` (or an absolute path inside the folder) as a checked folder-relative path. */
export function officeRel(office: Pick<Office, 'folderPath'>, p: string): string {
  const root = path.resolve(office.folderPath);
  const rel = path.isAbsolute(p) ? path.relative(root, path.resolve(p)) : p;
  const parts = rel.split('/');
  if (!rel || parts.some((s) => !SEGMENT_RE.test(s))) throw new Error(`office folder: refused path "${p}"`);
  return parts.join('/');
}

/**
 * Write `body` at `rel` inside the office folder: parents created, every
 * parent checked to resolve inside the folder, written to a temp file and
 * renamed over the target — a symlink there is replaced, never followed.
 * Returns the folder-relative path.
 */
export function writeOfficeFile(office: Pick<Office, 'folderPath'>, p: string, body: string): string {
  if (!path.isAbsolute(office.folderPath)) throw new Error('office folder: path must be absolute');
  const rel = officeRel(office, p);
  if (isProtectedOfficePath(office, rel)) throw new Error(`office folder: ${rel} is written by the server only`);
  const root = path.resolve(office.folderPath);
  const abs = path.join(root, rel);
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  if (!isInside(realPathDeep(dir), realPathDeep(root))) throw new Error(`office folder: ${path.dirname(rel)}/ points outside the folder`);
  const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(tmp, body, { flag: 'wx' });
  try {
    fs.renameSync(tmp, abs);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return rel;
}

/** Where a section's file lands: its own path, or the untrusted twin for a tainted shift. */
function target(ctx: ShiftSectionCtx, rel: string): string {
  return ctx.tainted ? officeRel(ctx.office, ctx.untrustedPath(rel)) : rel;
}

// ---------------------------------------------------------------------------
// notes — the role's own file, replaced whole
// ---------------------------------------------------------------------------

/** A role's notes file (create-only `roles/<key>.md`; the key is kebab, so it cannot escape). */
export function roleNotesRel(role: Pick<OfficeRole, 'key'>): string {
  return `roles/${role.key}.md`;
}

/** Notes cap: the whole file, in characters. */
export const SHIFT_NOTES_MAX_CHARS = 24_000;

registerShiftSection<string>({
  key: 'notes',
  describe:
    `the COMPLETE new text of your notes file \`roles/<your key>.md\` (markdown, at most ${SHIFT_NOTES_MAX_CHARS} characters). ` +
    'It REPLACES the file whole, so carry over what still matters. Omit the section to leave your notes as they are.',
  schema: z
    .string()
    .max(SHIFT_NOTES_MAX_CHARS, `notes must be at most ${SHIFT_NOTES_MAX_CHARS} characters`)
    .refine((s) => s.trim().length > 0, 'notes must not be empty (omit the section to keep your notes)'),
  jsonSchema: { type: 'string', minLength: 1, maxLength: SHIFT_NOTES_MAX_CHARS },
  async apply(value, ctx) {
    const rel = target(ctx, roleNotesRel(ctx.role));
    const body = value.endsWith('\n') ? value : `${value}\n`;
    writeOfficeFile(ctx.office, rel, body);
    if (ctx.tainted) {
      await ctx.storage.updateOfficeRole(ctx.role.id, { notesTaintedAt: ctx.now.toISOString() });
    }
    return { section: 'notes', files: [rel], tainted: ctx.tainted };
  },
});

// ---------------------------------------------------------------------------
// deliverables — documents under deliverables/
// ---------------------------------------------------------------------------

export const SHIFT_DELIVERABLES_MAX = 10;
export const SHIFT_DELIVERABLE_MAX_CHARS = 100_000;

/** `deliverables/<name>.md`, up to three subfolders deep, every segment plain. */
export function isDeliverablePath(p: string): boolean {
  const parts = p.split('/');
  if (parts.length < 2 || parts.length > 5 || parts[0] !== 'deliverables') return false;
  if (!parts.slice(1).every((s) => SEGMENT_RE.test(s))) return false;
  return /\.md$/.test(parts[parts.length - 1]);
}

export interface ShiftDeliverable {
  path: string;
  markdown: string;
}

registerShiftSection<ShiftDeliverable[]>({
  key: 'deliverables',
  describe:
    `documents you produced: up to ${SHIFT_DELIVERABLES_MAX} of {path, markdown}, path \`deliverables/<name>.md\` ` +
    '(letters, digits, `.` `_` `-`; subfolders allowed). An existing file at that path is replaced.',
  schema: z
    .array(
      z
        .object({
          path: z
            .string()
            .max(200)
            .refine(isDeliverablePath, 'path must be deliverables/<name>.md (letters, digits, . _ -; no leading dot, no ..)'),
          markdown: z.string().min(1).max(SHIFT_DELIVERABLE_MAX_CHARS),
        })
        .strict(),
    )
    .max(SHIFT_DELIVERABLES_MAX)
    .refine((list) => new Set(list.map((d) => d.path)).size === list.length, 'each deliverable path at most once'),
  jsonSchema: {
    type: 'array',
    maxItems: SHIFT_DELIVERABLES_MAX,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'markdown'],
      properties: {
        path: { type: 'string', pattern: '^deliverables/([A-Za-z0-9_-][A-Za-z0-9._-]*/){0,3}[A-Za-z0-9_-][A-Za-z0-9._-]*\\.md$' },
        markdown: { type: 'string', minLength: 1, maxLength: SHIFT_DELIVERABLE_MAX_CHARS },
      },
    },
  },
  async apply(value, ctx) {
    const files: string[] = [];
    const errors: string[] = [];
    for (const d of value) {
      try {
        // re-checked here: the value was validated, but this is the write
        if (!isDeliverablePath(d.path)) throw new Error(`refused deliverable path "${d.path}"`);
        const rel = target(ctx, d.path);
        writeOfficeFile(ctx.office, rel, d.markdown.endsWith('\n') ? d.markdown : `${d.markdown}\n`);
        files.push(rel);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    if (!files.length && errors.length) throw new Error(errors.join('; '));
    return { section: 'deliverables', files, tainted: ctx.tainted, ...(errors.length ? { errors } : {}) };
  },
});

// ---------------------------------------------------------------------------
// tasks — worker tasks the server files (docs/office.md § Filing)
// ---------------------------------------------------------------------------

registerShiftSection<ShiftTaskInput[]>({
  key: 'tasks',
  describe: SHIFT_TASKS_DESCRIBE,
  schema: shiftTasksSchema,
  jsonSchema: SHIFT_TASKS_JSON_SCHEMA,
  async apply(value, ctx) {
    const { filed } = await fileShiftTasks(
      { storage: ctx.storage, orchestrator: ctx.orchestrator },
      { office: ctx.office, role: ctx.role, shiftId: ctx.shiftId, tainted: ctx.tainted, now: ctx.now, runId: ctx.runId },
      value,
    );
    // held and dropped requests are on the shift row (`filing`), not section errors: a cap is not a failure
    return { section: 'tasks', files: [], tainted: ctx.tainted, taskIds: filed.map((t) => t.id) };
  },
});
