// The `feature` shift section (docs/office.md § Director features): a
// Director's shift may file ONE big cross-repo request per shift as a feature.
// The server creates the `tm_features` row — `office_id`, `repo_id` = the
// workspace's first repo (a listing key only: every card names its own repo),
// `tainted_at` from the shift — and runs the ordinary plan / plan-review
// pipeline (claude/feature-analysis.ts), which for an office feature plans
// from the office folder over every workspace repo. Nothing becomes a task
// until a human approves the plan; a tainted feature's cards are then held as
// drafts by the phase pump until a human queues them.
import { z } from 'zod';
import { isStandupRole, oneLineTitle, type Feature, type FeatureStatus } from '@tm/shared';
import { startFeatureAnalysis } from '../claude/feature-analysis.ts';
import { broadcast } from '../events.ts';
import type { Storage } from '../storage/types.ts';
import { officeWorkspaceRepos } from './feature-context.ts';
import { officeActor } from './filing.ts';
import { registerShiftSection, type ShiftSectionCtx } from './shift-result.ts';
import { memoryHold } from '../memory.ts';

export const OFFICE_FEATURE_TITLE_MAX = 200;
export const OFFICE_FEATURE_REQUEST_MAX = 20_000;
/** An office's features not yet done or cancelled, at most — a Director cannot pile up plans nobody reads. */
export const OFFICE_OPEN_FEATURES_MAX = 3;
const CLOSED: FeatureStatus[] = ['done', 'cancelled'];

export interface ShiftFeatureInput {
  title: string;
  request: string;
}

export const shiftFeatureSchema = z
  .object({
    title: z
      .string()
      .max(OFFICE_FEATURE_TITLE_MAX, `title must be at most ${OFFICE_FEATURE_TITLE_MAX} characters`)
      .transform((t) => oneLineTitle(t))
      .refine((t) => t.length > 0, 'title must not be empty'),
    request: z
      .string()
      .max(OFFICE_FEATURE_REQUEST_MAX, `request must be at most ${OFFICE_FEATURE_REQUEST_MAX} characters`)
      .refine((s) => s.trim().length > 0, 'request must not be empty'),
  })
  .strict();

export const SHIFT_FEATURE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'request'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: OFFICE_FEATURE_TITLE_MAX },
    request: { type: 'string', minLength: 1, maxLength: OFFICE_FEATURE_REQUEST_MAX },
  },
};

export const SHIFT_FEATURE_DESCRIBE =
  'at most ONE per shift: {title, request} — a big request spanning the workspace that is too large for a few tasks ' +
  '(markdown: the goal, why now, what done looks like). The server plans it into ordered phases of tasks across the ' +
  "workspace's repos, an adversarial review checks the plan, and a HUMAN approves it before any task exists. " +
  `Use it rarely; small work goes in \`tasks\`. At most ${OFFICE_OPEN_FEATURES_MAX} of the office's features may be open.`;

/** The open-feature cap's refusal for this office, or null while there is room (also Ask the Director's pre-check). */
export async function officeFeatureCapRefusal(storage: Storage, officeId: string): Promise<string | null> {
  const open = (await storage.listFeatures()).filter((f) => f.officeId === officeId && !CLOSED.includes(f.status));
  if (open.length < OFFICE_OPEN_FEATURES_MAX) return null;
  return `the office already has ${open.length} open features (at most ${OFFICE_OPEN_FEATURES_MAX}) — a human must finish or cancel one first`;
}

export interface FiledOfficeFeature {
  feature: Feature;
  /** false: left a draft with the reason in `error` (the office is paused) */
  analyzing: boolean;
}

/**
 * File a Director's feature: create the row, then start the pipeline unless
 * the office is paused (a budget trip during the shift) — then it stays a
 * draft with the reason, for a human to Analyze. Throws on a refusal (not a
 * Director, no workspace repo, the open-feature cap), which the registry
 * records as the section's error.
 */
export async function fileOfficeFeature(storage: Storage, ctx: Pick<ShiftSectionCtx, 'office' | 'role' | 'shiftId' | 'tainted' | 'now' | 'runId'>, input: ShiftFeatureInput): Promise<FiledOfficeFeature> {
  const { office, role } = ctx;
  if (!isStandupRole(role)) throw new Error('only the Director may file a feature');
  const ws = await officeWorkspaceRepos(storage, office);
  if (!ws?.repos.length) throw new Error("the office's workspace has no repos to plan in");
  const full = await officeFeatureCapRefusal(storage, office.id);
  if (full) throw new Error(full);
  const actor = officeActor(role);
  const created = await storage.createFeature(
    {
      repoId: ws.repos[0].id,
      title: input.title,
      request: input.request,
      officeId: office.id,
      taintedAt: ctx.tainted ? ctx.now.toISOString() : null,
    },
    actor,
  );
  broadcast({ type: 'feature.updated', feature: created });
  const fresh = await storage.getOffice(office.id);
  let feature = created;
  let analyzing = false;
  // the memory fuse (docs/memory.md): no automatic planning session under memory pressure
  const memHold = memoryHold(await storage.getSettings());
  if (fresh && fresh.pausedAt === null && fresh.enabled && !memHold) {
    const moved = await storage.transitionFeature(created.id, ['draft'], 'analyzing', actor, { error: null });
    if (moved) {
      feature = moved;
      broadcast({ type: 'feature.updated', feature });
      await startFeatureAnalysis({ storage }, feature, ws.repos[0]);
      analyzing = true;
    }
  } else {
    const why = !fresh
      ? 'the office no longer exists'
      : fresh.pausedAt
        ? `the office is paused (${fresh.pausedReason ?? 'by a human'})`
        : !fresh.enabled
          ? 'the office is off'
          : (memHold ?? 'the memory fuse holds automatic work');
    feature = (await storage.updateFeature(created.id, { error: `not analyzed: ${why} — press Analyze to plan it` }, actor)) ?? created;
    broadcast({ type: 'feature.updated', feature });
  }
  await storage.appendEvent({
    kind: 'office.feature',
    actor,
    runId: ctx.runId ?? null,
    repoId: feature.repoId,
    data: {
      officeId: office.id,
      roleId: role.id,
      shiftId: ctx.shiftId,
      featureId: feature.id,
      title: feature.title,
      tainted: ctx.tainted,
      analyzing,
      repoIds: ws.repos.map((r) => r.id),
    },
  });
  return { feature, analyzing };
}

registerShiftSection<ShiftFeatureInput>({
  key: 'feature',
  describe: SHIFT_FEATURE_DESCRIBE,
  schema: shiftFeatureSchema as unknown as z.ZodType<ShiftFeatureInput>,
  jsonSchema: SHIFT_FEATURE_JSON_SCHEMA,
  availableTo: (role) => isStandupRole(role),
  async apply(value, ctx) {
    try {
      const { feature } = await fileOfficeFeature(ctx.storage, ctx, value);
      return { section: 'feature', files: [], tainted: ctx.tainted, featureId: feature.id };
    } catch (e) {
      await ctx.storage
        .appendEvent({
          kind: 'office.feature',
          actor: officeActor(ctx.role),
          runId: ctx.runId ?? null,
          data: { officeId: ctx.office.id, roleId: ctx.role.id, shiftId: ctx.shiftId, title: value.title, dropped: (e as Error).message },
        })
        .catch(() => undefined);
      throw e;
    }
  },
});
