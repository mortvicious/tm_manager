import type { Approval, ApprovalAction, ApprovalStatus, Repo } from '@tm/shared';
import { APPROVAL_AUTO_ACTIONS } from '@tm/shared';

// Approvals (docs/approvals.md): the SQL both drivers run, `?` and all (the pg
// driver rewrites the placeholders). Every status change is CONDITIONAL on the
// statuses it may leave, so a tap in the SPA and one in Telegram can never both
// approve, and a restart's sweep never overwrites a finished row.

export interface NewApproval {
  taskId: string | null;
  runId: string;
  repoId: string | null;
  action: ApprovalAction;
  params: Approval['params'];
  summary: string;
  reason: string;
}

export interface ApprovalFilter {
  status?: ApprovalStatus;
  taskId?: string;
}

export const APPROVAL_INSERT_SQL = `INSERT INTO tm_approvals (id, task_id, run_id, repo_id, action, params, summary, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`;

export function approvalInsertParams(id: string, a: NewApproval, at: string): unknown[] {
  return [id, a.taskId, a.runId, a.repoId, a.action, JSON.stringify(a.params), a.summary, a.reason, at];
}

export function approvalListSql(f?: ApprovalFilter): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f?.status) {
    where.push(`status = ?`);
    params.push(f.status);
  }
  if (f?.taskId) {
    where.push(`task_id = ?`);
    params.push(f.taskId);
  }
  return {
    sql: `SELECT * FROM tm_approvals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT 500`,
    params,
  };
}

/**
 * pending → approved|rejected, once. `decided_at`/`decided_by` are written
 * here and nowhere else.
 */
export const APPROVAL_DECIDE_SQL = `UPDATE tm_approvals SET status = ?, decided_by = ?, decided_at = ?, result = COALESCE(?, result) WHERE id = ? AND status = 'pending' RETURNING *`;

/**
 * A status step from one of `from` (approved → running → done|failed, or a
 * sweep to expired). `finished_at` is stamped on every step into a final status.
 */
export function approvalStepSql(from: ApprovalStatus[], to: ApprovalStatus, result: string | null, at: string, id: string): { sql: string; params: unknown[] } {
  const final = to === 'done' || to === 'failed' || to === 'expired' || to === 'rejected';
  return {
    sql: `UPDATE tm_approvals SET status = ?, result = COALESCE(?, result)${final ? ', finished_at = ?' : ''} WHERE id = ? AND status IN (${from.map(() => '?').join(', ')}) RETURNING *`,
    params: [to, result, ...(final ? [at] : []), id, ...from],
  };
}

/** Every row in one of `from` → `expired` with `note` (the boot sweep). */
export function approvalExpireSql(from: ApprovalStatus[], note: string, at: string): { sql: string; params: unknown[] } {
  return {
    sql: `UPDATE tm_approvals SET status = 'expired', result = ?, finished_at = ? WHERE status IN (${from.map(() => '?').join(', ')}) RETURNING *`,
    params: [note, at, ...from],
  };
}

export const REPO_AUTO_APPROVE_SQL = `UPDATE tm_repos SET auto_approve = ? WHERE id = ?`;

/** The column value for a repo's pre-approved actions: only the auto-approvable ones, deduped; null = none. */
export function autoApproveValue(list: readonly ApprovalAction[] | null | undefined): string | null {
  const keep = APPROVAL_AUTO_ACTIONS.filter((a) => list?.includes(a));
  return keep.length ? JSON.stringify(keep) : null;
}

/** Read side: anything unknown (hand-edited row) or not auto-approvable reads as not pre-approved. */
export function autoApproveList(v: unknown): Repo['autoApprove'] {
  if (typeof v !== 'string' || !v) return [];
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? APPROVAL_AUTO_ACTIONS.filter((a) => arr.includes(a)) : [];
  } catch {
    return [];
  }
}

export function rowToApproval(r: any): Approval {
  let params: Approval['params'];
  try {
    params = JSON.parse(r.params);
  } catch {
    params = { action: 'rebuild-restart', drainMinutes: null };
  }
  return {
    id: r.id,
    taskId: r.task_id ?? null,
    runId: r.run_id,
    repoId: r.repo_id ?? null,
    action: r.action,
    params,
    summary: r.summary,
    reason: r.reason,
    status: r.status,
    decidedBy: r.decided_by ?? null,
    result: r.result ?? null,
    createdAt: r.created_at,
    decidedAt: r.decided_at ?? null,
    finishedAt: r.finished_at ?? null,
  };
}
