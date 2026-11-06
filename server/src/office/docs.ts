// Wishes and vision (docs/office.md § Wishes and vision). The human steers the
// office through three things the Director plans from:
//
// - `vision.md` and `priorities.md` — edited on /office (`PUT
//   /api/offices/:id/docs/:name`, the server writes the file) or by hand in
//   the folder. Both are the HUMAN's files and trusted. A change — a save
//   whose content hash differs, or a hand edit the scheduler tick notices by
//   hashing both files every minute — is one `office.vision-changed` row and
//   ONE Director shift with trigger `request` and ref `re-plan:<doc>`.
// - wishes (`tm_office_wishes`) — a human's standing requests; a new one wakes
//   the Director with ref `wish:<id>`.
//
// The re-plan shift reads vision, priorities, roadmap and the open wishes
// (shift.ts) and returns two sections registered here: `roadmap` (the server
// writes roadmap.md — a TAINTED shift's goes to `untrusted/` and is never
// read back) and `wishUpdates` (status moves; refused from a tainted shift).
//
// The last-seen hash of each doc is the newest `office.vision-changed` row
// (cached in memory), so a restart neither re-wakes for an old edit nor misses
// one made while the server was down. A doc never seen before gets one
// `source: 'baseline'` row and no wake. Saves and tick checks of one office
// are serialized, so a save the tick reads half-way can never wake twice.
//
// A wake refused only because a slot is busy (the office's one shift slot,
// the runner's ceiling, Pause all) is PENDING: the tick retries it each minute
// until it starts or is refused for good (office off or paused, budget, no
// Director). One pending wake per office; in memory, so a restart drops it —
// the next Director shift reads the same docs and wishes anyway.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  OFFICE_EDITABLE_DOCS,
  OFFICE_ROADMAP_MAX_CHARS,
  OFFICE_WISHES_OPEN_MAX,
  OFFICE_WISH_TEXT_MAX,
  REPLAN_REF_PREFIX,
  SHIFT_WISH_UPDATES_MAX,
  WISH_REF_PREFIX,
  isStandupRole,
  type Office,
  type OfficeDirectorWake,
  type OfficeDocView,
  type OfficeEditableDoc,
  type OfficeReadableDoc,
  type OfficeRole,
  type OfficeWish,
  type OfficeWishStatus,
} from '@tm/shared';
import { broadcast } from '../events.ts';
import { isInside, realPathDeep } from '../folder-guard.ts';
import { EVENT_LIST_MAX } from '../storage/event-sql.ts';
import type { Storage } from '../storage/types.ts';
import { officeRel, registerShiftSection, writeOfficeFile } from './shift-result.ts';
import type { OfficeWakeResult } from './scheduler.ts';

/** What this module needs of the scheduler: Wake now with a ref of its own. */
export interface DirectorWaker {
  wake(officeId: string, roleId: string, note: string | null, actor?: string, opts?: { ref?: string; data?: Record<string, unknown> }): Promise<OfficeWakeResult>;
}

export interface OfficeDocsDeps {
  storage: Storage;
  /** null: no scheduler (route tests) — the change is recorded, the wake refused */
  waker: DirectorWaker | null;
}

/** Refusals that mean "not now": the wake stays pending and the tick retries it. */
const PENDING_CODES = new Set(['slots', 'office-busy', 'busy', 'paused', 'server-paused', 'memory']);

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// Reading a doc
// ---------------------------------------------------------------------------

/**
 * A doc of the office folder, whole. Missing, not a regular file, or
 * resolving outside the folder → empty and `exists: false` (a symlink out of
 * the folder is never followed).
 */
export function readOfficeDoc(office: Pick<Office, 'folderPath'>, name: OfficeReadableDoc): OfficeDocView {
  const empty: OfficeDocView = { name, content: '', sha256: sha256(''), exists: false };
  try {
    const root = realPathDeep(path.resolve(office.folderPath));
    const real = fs.realpathSync(path.join(path.resolve(office.folderPath), name));
    if (!isInside(real, root) || !fs.statSync(real).isFile()) return empty;
    const content = fs.readFileSync(real, 'utf8');
    return { name, content, sha256: sha256(content), exists: true };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Per-office serialization and the last-seen hashes
// ---------------------------------------------------------------------------

const chains = new Map<string, Promise<unknown>>();

function serialized<T>(officeId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(officeId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  chains.set(officeId, tail);
  void tail.then(() => {
    if (chains.get(officeId) === tail) chains.delete(officeId);
  });
  return next;
}

/** `${officeId}\0${doc}` → the sha256 last recorded */
const known = new Map<string, string>();
/** officeId → the Director wake still owed (ref) */
const pending = new Map<string, string>();

const key = (officeId: string, name: string) => `${officeId}\u0000${name}`;

/** Test hook: forget every cached hash and pending wake. */
export function resetOfficeDocsMemory(): void {
  known.clear();
  pending.clear();
}

/** The office's pending Director wake (its ref), if any — the tick retries it. */
export function pendingDirectorWake(officeId: string): string | null {
  return pending.get(officeId) ?? null;
}

/** The last recorded hash: memory, else the newest `office.vision-changed` row; undefined = never seen. */
async function lastHash(storage: Storage, officeId: string, name: OfficeEditableDoc): Promise<string | undefined> {
  const k = key(officeId, name);
  const hit = known.get(k);
  if (hit !== undefined) return hit;
  const rows = await storage.listEvents({ kind: 'office.vision-changed', limit: EVENT_LIST_MAX });
  for (const e of rows) {
    const d = (e.data ?? {}) as { officeId?: unknown; name?: unknown; sha256?: unknown };
    if (d.officeId === officeId && d.name === name && typeof d.sha256 === 'string') {
      known.set(k, d.sha256);
      return d.sha256;
    }
  }
  return undefined;
}

async function recordChange(
  storage: Storage,
  office: Office,
  name: OfficeEditableDoc,
  source: 'dashboard' | 'hand-edit' | 'baseline',
  before: string | null,
  doc: OfficeDocView,
  actor: string,
): Promise<void> {
  known.set(key(office.id, name), doc.sha256);
  await storage.appendEvent({
    kind: 'office.vision-changed',
    actor,
    data: {
      officeId: office.id,
      workspaceId: office.workspaceId,
      name,
      source,
      sha256Before: before,
      sha256: doc.sha256,
      chars: doc.content.length,
    },
  });
}

// ---------------------------------------------------------------------------
// Waking the Director
// ---------------------------------------------------------------------------

/** The office's Director: the enabled stand-up role first, else any. */
export async function directorRole(storage: Storage, officeId: string): Promise<OfficeRole | null> {
  const roles = (await storage.listOfficeRoles(officeId)).filter((r) => isStandupRole(r));
  return roles.find((r) => r.enabled) ?? roles[0] ?? null;
}

/**
 * Wake the Director with a `request` (hard gate, no guards). A refusal for a
 * busy slot leaves the wake pending for the tick; anything else drops it.
 */
export async function wakeDirector(deps: OfficeDocsDeps, office: Office, ref: string, actor: string, data: Record<string, unknown> = {}): Promise<OfficeDirectorWake> {
  const role = await directorRole(deps.storage, office.id);
  if (!role) {
    pending.delete(office.id);
    return { ok: false, error: 'this office has no Director role', code: 'role', pending: false };
  }
  if (!deps.waker) return { ok: false, error: 'the office scheduler is not running', code: 'scheduler', pending: false };
  const r = await deps.waker.wake(office.id, role.id, null, actor, { ref, data: { reason: ref, ...data } });
  if (r.ok) {
    pending.delete(office.id);
    return { ok: true, shiftId: r.shiftId };
  }
  const keep = r.status === 409 && !!r.code && PENDING_CODES.has(r.code);
  if (keep) pending.set(office.id, ref);
  else pending.delete(office.id);
  return { ok: false, error: r.error, ...(r.code ? { code: r.code } : {}), pending: keep };
}

// ---------------------------------------------------------------------------
// Saving a doc (the route) and noticing hand edits (the tick)
// ---------------------------------------------------------------------------

export class OfficeDocConflict extends Error {}

export interface OfficeDocSaved {
  doc: OfficeDocView;
  changed: boolean;
  wake: OfficeDirectorWake | null;
}

/**
 * Write vision.md / priorities.md for a human. `baseSha256` (the version the
 * editor loaded) that no longer matches the file → `OfficeDocConflict`
 * (409). Identical content → nothing recorded, nobody woken.
 */
export function saveOfficeDoc(
  deps: OfficeDocsDeps,
  office: Office,
  name: OfficeEditableDoc,
  content: string,
  opts: { baseSha256?: string; actor?: string } = {},
): Promise<OfficeDocSaved> {
  const actor = opts.actor ?? 'human';
  return serialized(office.id, async () => {
    const cur = readOfficeDoc(office, name);
    if (opts.baseSha256 && opts.baseSha256 !== cur.sha256) {
      throw new OfficeDocConflict(`${name} changed since you opened it — reload and re-apply your edit`);
    }
    const body = content.length && !content.endsWith('\n') ? `${content}\n` : content;
    if (body === cur.content && cur.exists) {
      known.set(key(office.id, name), cur.sha256);
      return { doc: cur, changed: false, wake: null };
    }
    writeOfficeFile(office, officeRel(office, name), body);
    const doc = readOfficeDoc(office, name);
    if (doc.sha256 === cur.sha256) return { doc, changed: false, wake: null };
    await recordChange(deps.storage, office, name, 'dashboard', cur.exists ? cur.sha256 : null, doc, actor);
    const wake = await wakeDirector(deps, office, `${REPLAN_REF_PREFIX}${name}`, actor, { doc: name, source: 'dashboard' });
    broadcast({ type: 'office.updated', office });
    return { doc, changed: true, wake };
  });
}

export interface OfficeDocsCheck {
  /** docs whose hand edit was noticed this pass */
  changed: OfficeEditableDoc[];
  /** docs seen for the first time (a baseline row, no wake) */
  baselined: OfficeEditableDoc[];
  wake: OfficeDirectorWake | null;
}

/**
 * The tick's pass over one office: hash both docs against the last recorded
 * hashes — a difference is a hand edit (`source: 'hand-edit'`, actor `human`:
 * nobody else writes these files) and wakes the Director ONCE for all of
 * them; otherwise a pending wake is retried.
 */
export function checkOfficeDocs(deps: OfficeDocsDeps, office: Office): Promise<OfficeDocsCheck> {
  return serialized(office.id, async () => {
    const out: OfficeDocsCheck = { changed: [], baselined: [], wake: null };
    for (const name of OFFICE_EDITABLE_DOCS) {
      const doc = readOfficeDoc(office, name);
      const last = await lastHash(deps.storage, office.id, name);
      if (last === undefined) {
        await recordChange(deps.storage, office, name, 'baseline', null, doc, 'system');
        out.baselined.push(name);
      } else if (last !== doc.sha256) {
        await recordChange(deps.storage, office, name, 'hand-edit', last, doc, 'human');
        out.changed.push(name);
      }
    }
    if (out.changed.length) {
      out.wake = await wakeDirector(deps, office, `${REPLAN_REF_PREFIX}${out.changed.join('+')}`, 'human', { docs: out.changed, source: 'hand-edit' });
      broadcast({ type: 'office.updated', office });
    } else {
      const owed = pending.get(office.id);
      if (owed && office.enabled) out.wake = await wakeDirector(deps, office, owed, 'system', { retry: true });
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Wishes
// ---------------------------------------------------------------------------

export class OfficeWishRefused extends Error {}

/** Store a human's wish and wake the Director (`wish:<id>`). */
export async function createOfficeWish(
  deps: OfficeDocsDeps,
  office: Office,
  text: string,
  actor = 'human',
): Promise<{ wish: OfficeWish; wake: OfficeDirectorWake }> {
  const t = text.trim().slice(0, OFFICE_WISH_TEXT_MAX);
  if (!t) throw new OfficeWishRefused('a wish needs some text');
  const open = await deps.storage.listWishes({ officeId: office.id, status: 'open' });
  if (open.length >= OFFICE_WISHES_OPEN_MAX) {
    throw new OfficeWishRefused(`the office already has ${OFFICE_WISHES_OPEN_MAX} open wishes — mark some done or dropped first`);
  }
  const wish = await deps.storage.createWish({ officeId: office.id, text: t });
  await deps.storage.appendEvent({
    kind: 'office.wish',
    actor,
    data: { officeId: office.id, workspaceId: office.workspaceId, wishId: wish.id, change: 'created', chars: t.length },
  });
  broadcast({ type: 'office-wish.updated', wish });
  const wake = await wakeDirector(deps, office, `${WISH_REF_PREFIX}${wish.id}`, actor, { wishId: wish.id });
  return { wish, wake };
}

/** The wishes a Director plans from: open and planned, oldest first. */
export async function plannableWishes(storage: Storage, officeId: string): Promise<OfficeWish[]> {
  const [open, planned] = await Promise.all([
    storage.listWishes({ officeId, status: 'open' }),
    storage.listWishes({ officeId, status: 'planned' }),
  ]);
  return [...open, ...planned].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** The prompt's reason line for a re-plan trigger ref. */
export function replanReason(ref: string): string {
  if (ref.startsWith(WISH_REF_PREFIX)) return `a human added a wish (\`${ref.slice(WISH_REF_PREFIX.length)}\`)`;
  const docs = ref.slice(REPLAN_REF_PREFIX.length).split('+').filter(Boolean);
  return `the human changed ${docs.map((d) => `\`${d}\``).join(' and ') || 'the vision'}`;
}

// ---------------------------------------------------------------------------
// Sections: roadmap, wishUpdates (Director only)
// ---------------------------------------------------------------------------

export const ROADMAP_REL = 'roadmap.md';

registerShiftSection<string>({
  key: 'roadmap',
  describe:
    `Director only: the COMPLETE new \`roadmap.md\` (markdown, at most ${OFFICE_ROADMAP_MAX_CHARS} characters) — ` +
    'the plan from the vision, priorities and wishes. It replaces the file whole; omit the section to keep it.',
  schema: z
    .string()
    .max(OFFICE_ROADMAP_MAX_CHARS, `roadmap must be at most ${OFFICE_ROADMAP_MAX_CHARS} characters`)
    .refine((s) => s.trim().length > 0, 'roadmap must not be empty (omit the section to keep it)'),
  jsonSchema: { type: 'string', minLength: 1, maxLength: OFFICE_ROADMAP_MAX_CHARS },
  async apply(value, ctx) {
    if (!isStandupRole(ctx.role)) throw new Error('only the Director writes the roadmap');
    // a tainted shift's roadmap is kept for a human to read, never used: it lands in untrusted/
    const rel = ctx.tainted ? officeRel(ctx.office, ctx.untrustedPath(ROADMAP_REL)) : ROADMAP_REL;
    writeOfficeFile(ctx.office, rel, value.endsWith('\n') ? value : `${value}\n`);
    return { section: 'roadmap', files: [rel], tainted: ctx.tainted };
  },
});

const WISH_STATUSES = ['open', 'planned', 'done', 'dropped'] as const satisfies readonly OfficeWishStatus[];

export interface ShiftWishUpdate {
  id: string;
  status: OfficeWishStatus;
}

registerShiftSection<ShiftWishUpdate[]>({
  key: 'wishUpdates',
  describe:
    `Director only: wish status changes, at most ${SHIFT_WISH_UPDATES_MAX} of {id, status}: \`planned\` once the roadmap ` +
    'or a filed task covers it, `done` once delivered, `dropped` only when the vision rules it out (say why in your brief), `open` to reopen.',
  schema: z
    .array(z.object({ id: z.string().trim().min(1).max(100), status: z.enum(WISH_STATUSES) }).strict())
    .max(SHIFT_WISH_UPDATES_MAX)
    .refine((l) => new Set(l.map((u) => u.id)).size === l.length, 'each wish id at most once'),
  jsonSchema: {
    type: 'array',
    maxItems: SHIFT_WISH_UPDATES_MAX,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'status'],
      properties: { id: { type: 'string', minLength: 1 }, status: { type: 'string', enum: [...WISH_STATUSES] } },
    },
  },
  async apply(value, ctx) {
    if (!isStandupRole(ctx.role)) throw new Error('only the Director updates wishes');
    // wish statuses are the human's ledger: untrusted text may not move them
    if (ctx.tainted) throw new Error('a tainted shift cannot change wish statuses');
    const moved: { id: string; from: OfficeWishStatus; to: OfficeWishStatus }[] = [];
    const errors: string[] = [];
    for (const u of value) {
      const wish = await ctx.storage.getWish(u.id);
      if (!wish || wish.officeId !== ctx.office.id) {
        errors.push(`wish ${u.id}: not a wish of this office`);
        continue;
      }
      if (wish.status === u.status) continue;
      const row = await ctx.storage.updateWish(wish.id, { status: u.status });
      if (!row) {
        errors.push(`wish ${u.id}: gone`);
        continue;
      }
      moved.push({ id: wish.id, from: wish.status, to: u.status });
      broadcast({ type: 'office-wish.updated', wish: row });
    }
    if (moved.length || errors.length) {
      await ctx.storage.appendEvent({
        kind: 'office.wishes',
        actor: 'system',
        runId: ctx.runId ?? null,
        data: { officeId: ctx.office.id, roleId: ctx.role.id, shiftId: ctx.shiftId, updates: moved, ...(errors.length ? { errors } : {}) },
      });
    }
    if (!moved.length && errors.length) throw new Error(errors.join('; '));
    return { section: 'wishUpdates', files: [], tainted: ctx.tainted, ...(errors.length ? { errors } : {}) };
  },
});
