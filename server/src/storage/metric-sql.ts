import type { OfficeMetric, OfficeMetricBetter, OfficeMetricPoint, OfficeMetricSide, OfficeMetricThresholdOp } from '@tm/shared';
import { OFFICE_METRIC_POINTS_KEPT } from '@tm/shared';

// Product metrics (docs/office.md § Product metrics, migration 65), SQL shared
// verbatim by both drivers (`?` placeholders; the pg driver rewrites them).
// The crossing is ONE conditional UPDATE (`OFFICE_METRIC_BREACH_SQL`): only a
// row not already in breach moves to breach, so two racing runs, a retry or a
// restart can never file a second signal for the same crossing.

export interface NewOfficeMetric {
  officeId: string;
  roleId: string;
  repoId: string;
  commandId: string;
  name: string;
  unit: string;
  better: OfficeMetricBetter;
  schedule: string;
  thresholdOp: OfficeMetricThresholdOp | null;
  thresholdValue: number | null;
}

/** A definition edit. Changing the command or the threshold re-arms the crossing (`last_side` → null). */
export type OfficeMetricPatch = Partial<Omit<NewOfficeMetric, 'officeId'>>;

export interface OfficeMetricFilter {
  officeId?: string;
  roleId?: string;
}

/** One run's outcome: a value (a point) or the reason there is none. */
export type OfficeMetricRun =
  | { at: string; value: number; runId: string | null }
  | { at: string; value: null; error: string; runId: string | null };

export interface OfficeMetricRunResult {
  metric: OfficeMetric;
  /** true only for the run that moved the row from ok / unmeasured into breach */
  crossed: boolean;
  /** the side before this run */
  previousSide: OfficeMetricSide | null;
  /** the value before this run */
  previousValue: number | null;
}

const COLS =
  'id, office_id, role_id, repo_id, command_id, name, unit, better, schedule, threshold_op, threshold_value, last_value, last_at, last_side, breached_at, last_run_at, last_error, created_at, updated_at';

export const OFFICE_METRIC_INSERT_SQL = `INSERT INTO tm_office_metrics (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`;

export function officeMetricInsertParams(id: string, m: NewOfficeMetric, at: string): unknown[] {
  return [id, m.officeId, m.roleId, m.repoId, m.commandId, m.name, m.unit, m.better, m.schedule, m.thresholdOp, m.thresholdValue, at, at];
}

export const OFFICE_METRIC_GET_SQL = `SELECT * FROM tm_office_metrics WHERE id = ?`;
export const OFFICE_METRIC_DELETE_SQL = `DELETE FROM tm_office_metrics WHERE id = ?`;
export const OFFICE_METRIC_POINTS_DELETE_SQL = `DELETE FROM tm_office_metric_points WHERE metric_id = ?`;
/** `deleteOffice`: points first (they key on the metric), then the metrics. */
export const OFFICE_METRICS_POINTS_DELETE_FOR_OFFICE_SQL = `DELETE FROM tm_office_metric_points WHERE metric_id IN (SELECT id FROM tm_office_metrics WHERE office_id = ?)`;
export const OFFICE_METRICS_DELETE_SQL = `DELETE FROM tm_office_metrics WHERE office_id = ?`;

export function officeMetricListSql(f: OfficeMetricFilter = {}): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.officeId) {
    where.push('office_id = ?');
    params.push(f.officeId);
  }
  if (f.roleId) {
    where.push('role_id = ?');
    params.push(f.roleId);
  }
  return {
    sql: `SELECT * FROM tm_office_metrics ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC, id ASC`,
    params,
  };
}

/**
 * The definition edit; null = nothing to write. A changed command or
 * threshold resets the crossing state, so the next breach under the NEW
 * definition signals again (and a value under the old one never counts).
 */
export function officeMetricPatchSql(id: string, patch: OfficeMetricPatch, prev: OfficeMetric, at: string): { sql: string; params: unknown[] } | null {
  const map: [keyof OfficeMetricPatch, string][] = [
    ['roleId', 'role_id'],
    ['repoId', 'repo_id'],
    ['commandId', 'command_id'],
    ['name', 'name'],
    ['unit', 'unit'],
    ['better', 'better'],
    ['schedule', 'schedule'],
    ['thresholdOp', 'threshold_op'],
    ['thresholdValue', 'threshold_value'],
  ];
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, col] of map) {
    if (patch[k] === undefined) continue;
    sets.push(`${col} = ?`);
    params.push(patch[k]);
  }
  if (!sets.length) return null;
  const rearm =
    (patch.commandId !== undefined && patch.commandId !== prev.commandId) ||
    (patch.thresholdOp !== undefined && patch.thresholdOp !== prev.thresholdOp) ||
    (patch.thresholdValue !== undefined && patch.thresholdValue !== prev.thresholdValue);
  if (rearm) sets.push('last_side = NULL', 'breached_at = NULL');
  sets.push('updated_at = ?');
  params.push(at, id);
  return { sql: `UPDATE tm_office_metrics SET ${sets.join(', ')} WHERE id = ?`, params };
}

// ---- a run ----

export const OFFICE_METRIC_POINT_INSERT_SQL = `INSERT INTO tm_office_metric_points (metric_id, at, value, run_id) VALUES (?, ?, ?, ?)`;
/** Keep the newest `OFFICE_METRIC_POINTS_KEPT` points (`at < NULL` deletes nothing while there are fewer). */
export const OFFICE_METRIC_POINTS_PRUNE_SQL = `DELETE FROM tm_office_metric_points WHERE metric_id = ? AND at < (
  SELECT at FROM tm_office_metric_points WHERE metric_id = ? ORDER BY at DESC LIMIT 1 OFFSET ${OFFICE_METRIC_POINTS_KEPT - 1})`;
export const officeMetricPruneParams = (metricId: string): unknown[] => [metricId, metricId];

/** A run with a value: the value, its time, the anchor, and no error. */
export const OFFICE_METRIC_VALUE_SQL = `UPDATE tm_office_metrics SET last_value = ?, last_at = ?, last_run_at = ?, last_error = NULL WHERE id = ?`;
/** A run without a value: the anchor and the reason; the value and the side stand. */
export const OFFICE_METRIC_ERROR_SQL = `UPDATE tm_office_metrics SET last_run_at = ?, last_error = ? WHERE id = ?`;
/** ok / unmeasured → breach, exactly once per crossing (changes = 1 only for that run). */
export const OFFICE_METRIC_BREACH_SQL = `UPDATE tm_office_metrics SET last_side = 'breach', breached_at = ? WHERE id = ? AND (last_side IS NULL OR last_side <> 'breach')`;
/** Back on the ok side: re-armed. */
export const OFFICE_METRIC_OK_SQL = `UPDATE tm_office_metrics SET last_side = 'ok', breached_at = NULL WHERE id = ?`;
/** No threshold: no side. */
export const OFFICE_METRIC_NO_SIDE_SQL = `UPDATE tm_office_metrics SET last_side = NULL, breached_at = NULL WHERE id = ?`;

/** Newest `limit` points, returned oldest first. */
export function officeMetricPointsSql(metricId: string, limit: number): { sql: string; params: unknown[] } {
  const n = Math.max(1, Math.min(OFFICE_METRIC_POINTS_KEPT, Math.floor(limit)));
  return { sql: `SELECT * FROM tm_office_metric_points WHERE metric_id = ? ORDER BY at DESC LIMIT ${n}`, params: [metricId] };
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function rowToOfficeMetric(r: any): OfficeMetric {
  return {
    id: r.id,
    officeId: r.office_id,
    roleId: r.role_id,
    repoId: r.repo_id,
    commandId: r.command_id,
    name: r.name,
    unit: r.unit ?? '',
    better: r.better === 'down' ? 'down' : 'up',
    schedule: r.schedule,
    thresholdOp: r.threshold_op === 'below' || r.threshold_op === 'above' ? r.threshold_op : null,
    thresholdValue: num(r.threshold_value),
    lastValue: num(r.last_value),
    lastAt: r.last_at ?? null,
    lastSide: r.last_side === 'ok' || r.last_side === 'breach' ? r.last_side : null,
    breachedAt: r.breached_at ?? null,
    lastRunAt: r.last_run_at ?? null,
    lastError: r.last_error ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function rowToOfficeMetricPoint(r: any): OfficeMetricPoint {
  return { metricId: r.metric_id, at: r.at, value: Number(r.value), runId: r.run_id ?? null };
}
