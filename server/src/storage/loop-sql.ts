// Loop tasks (docs/loops.md) — SQL shared verbatim by both drivers.

import type { LoopStep } from './types.ts';

/**
 * Set by `transitionTask` on any move out of `running`/`waiting` that does not
 * write `loop_state` itself: an in-flight loop state (`iterating`, `checking`,
 * `next`) must never outlive the `running` it describes, or the pump would
 * start an iteration on a cancelled task. Keep the list in step with
 * LOOP_IN_FLIGHT_STATES (shared).
 */
export const LOOP_LEAVES_RUNNING_SQL =
  "loop_state = CASE WHEN loop_state IN ('iterating', 'checking', 'next') THEN 'paused' ELSE loop_state END";

/**
 * The SET list and values of a `stepLoop` patch (keys present only), ending
 * with `updated_at = ?` — the caller appends that value, then the id and the
 * `from` states.
 */
export function loopStepSets(patch: LoopStep): { sets: string[]; vals: unknown[] } {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if ('loopState' in patch) {
    sets.push('loop_state = ?');
    vals.push(patch.loopState ?? null);
  }
  if ('loopIteration' in patch) {
    sets.push('loop_iteration = ?');
    vals.push(patch.loopIteration ?? 0);
  }
  if ('loopHistory' in patch) {
    sets.push('loop_history = ?');
    vals.push(JSON.stringify(patch.loopHistory ?? []));
  }
  if ('checkResults' in patch) {
    sets.push('check_results = ?');
    vals.push(JSON.stringify(patch.checkResults ?? []));
  }
  if ('checkDiffHash' in patch) {
    sets.push('check_diff_hash = ?');
    vals.push(patch.checkDiffHash ?? null);
  }
  sets.push('updated_at = ?');
  return { sets, vals };
}

/**
 * `UPDATE … WHERE` of `stepLoop`: a `running` loop task whose `loop_state` is
 * one of `from` (`null` in `from` matches NULL). Placeholders are `?`.
 */
export function stepLoopSql(sets: string[], from: (string | null)[]): string {
  const named = from.filter((s): s is string => s !== null);
  const conds = [
    ...(named.length ? [`loop_state IN (${named.map(() => '?').join(', ')})`] : []),
    ...(from.includes(null) ? ['loop_state IS NULL'] : []),
  ];
  return `UPDATE tm_tasks SET ${sets.join(', ')} WHERE id = ? AND kind = 'loop' AND status = 'running' AND (${conds.join(' OR ') || '1 = 0'}) RETURNING *`;
}
