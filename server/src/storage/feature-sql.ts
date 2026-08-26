// Phase-gating SQL fragments shared VERBATIM by both drivers, so SQLite and
// Postgres can never disagree about when a feature task is claimable.
// Constraints: dialect-neutral, no `?` placeholders (the pg driver rewrites
// those positionally), and every table carries the fixed `tm_` prefix.

/**
 * Base claim gate. A task with no feature is unaffected. A feature task is
 * claimable only while its feature is RUNNING and every task in a LOWER phase
 * of that feature is settled (`published`/`done`/`cancelled`) — `failed` blocks on purpose,
 * because a failed task pauses the feature rather than advancing it. A DRAFT
 * that a worker filed inside the feature (source 'auto', never auto-queued) is
 * exempt: it is a human-triage item, not phase work, and would otherwise wedge
 * the phase forever. Must stay in lockstep with `isFeatureTaskBlocking` below.
 * Expects the candidate row to be aliased `t`.
 */
export const FEATURE_CLAIM_GATE = `(
  t.feature_id IS NULL
  OR (
    EXISTS (SELECT 1 FROM tm_features f WHERE f.id = t.feature_id AND f.status = 'running')
    AND NOT EXISTS (
      SELECT 1 FROM tm_tasks lo
      WHERE lo.feature_id = t.feature_id
        AND lo.feature_phase < t.feature_phase
        AND lo.status NOT IN ('published', 'done', 'cancelled')
        AND (lo.status <> 'draft' OR lo.source = 'feature')
    )
  )
)`;

/**
 * Overflow-claim gate (agent-API review R1: a task filed by a LIVE worker may
 * start even at the concurrency cap). Deliberately weaker than the base gate:
 * the creating session is mid-turn and blocked on this child, so applying the
 * full phase gate would deadlock it — e.g. the moment a sibling failure pauses
 * the feature. Only a cancelled feature stops its children from starting.
 * Expects the candidate row to be aliased `t`.
 */
export const FEATURE_OVERFLOW_GATE = `(
  t.feature_id IS NULL
  OR NOT EXISTS (SELECT 1 FROM tm_features f WHERE f.id = t.feature_id AND f.status = 'cancelled')
)`;

/**
 * JS twin of the lower-phase predicate inside FEATURE_CLAIM_GATE. Both express
 * one policy — "does this task still hold its phase open?" — so they are edited
 * together or not at all.
 */
export function isFeatureTaskBlocking(t: { status: string; source: string }): boolean {
  if (t.status === 'published' || t.status === 'done' || t.status === 'cancelled') return false;
  if (t.status === 'draft' && t.source !== 'feature') return false;
  return true;
}
