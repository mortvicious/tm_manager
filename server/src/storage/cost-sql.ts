// Cost roll-up SQL shared VERBATIM by both drivers (docs/token-budget.md §
// Fuses) — dialect-neutral like feature-sql.ts and queue-sql.ts: no `?`
// placeholders, fixed `tm_` prefix. It reads `tm_runs.cost_usd` (migration
// 33), never the stats JSON, because JSON extraction differs per dialect.

/**
 * A task's cost: its own worker runs, plus the aux sessions ABOUT it — review
 * and compact, whose `task_id` is NULL on purpose (docs/design.md § PTY
 * sessions) and whose `subject_id` is the task. `idExpr` is the SQL
 * expression for the task id (a column, never a value). JS twin of the
 * attribution: `runTaskId` in shared/src/types.ts.
 */
export const taskCostSql = (idExpr: string) =>
  `COALESCE((SELECT SUM(r.cost_usd) FROM tm_runs r
      WHERE r.task_id = ${idExpr}
         OR (r.subject_id = ${idExpr} AND r.mode = 'aux' AND r.kind IN ('review', 'compact'))), 0)`;

/** `tm_runs.cost_usd` for a run's stats: the stats' own figure, null when there are none yet. */
export function runCost(stats: { costUsd?: number } | null | undefined): number | null {
  const c = stats?.costUsd;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}
