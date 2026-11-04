import type { Job, JobContext, JobFinding, JobRun, JobSource, JobStatus, JobVerdict } from '@tm/shared';

// Scheduled jobs (docs/jobs.md): the SQL both drivers run, `?` and all (the pg
// driver rewrites the placeholders). Every status change that can race — the
// sweep's claim against a human's Run now, a pause against a fire — is
// CONDITIONAL on the statuses it may leave, so there is no generic transaction.

export interface NewJob {
  repoId: string;
  title: string;
  instructions: string;
  context: JobContext | null;
  source: JobSource;
  createdByRun: string | null;
  createdByTask: string | null;
  nextRunAt: string;
  repeatEveryMs: number | null;
  repeatUntil: string | null;
  maxRuns: number | null;
  model: string | null;
  effort: string | null;
}

/** the human-editable fields (PATCH /api/jobs/:id); schedule fields come resolved */
export interface JobPatch {
  title?: string;
  instructions?: string;
  repoId?: string;
  nextRunAt?: string | null;
  repeatEveryMs?: number | null;
  repeatUntil?: string | null;
  maxRuns?: number | null;
  model?: string | null;
  effort?: string | null;
}

export interface JobFilter {
  repoId?: string;
  status?: JobStatus[];
  createdByTask?: string;
  createdByRun?: string;
}

export const JOB_INSERT_SQL = `INSERT INTO tm_jobs (id, repo_id, title, instructions, context, source, created_by_run, created_by_task, status, next_run_at, repeat_every_ms, repeat_until, max_runs, runs_count, model, effort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, 0, ?, ?, ?, ?)`;

export function jobInsertParams(id: string, j: NewJob, at: string): unknown[] {
  return [
    id,
    j.repoId,
    j.title,
    j.instructions,
    j.context ? JSON.stringify(j.context) : null,
    j.source,
    j.createdByRun,
    j.createdByTask,
    j.nextRunAt,
    j.repeatEveryMs,
    j.repeatUntil,
    j.maxRuns,
    j.model,
    j.effort,
    at,
    at,
  ];
}

export function jobListSql(f?: JobFilter): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f?.repoId) {
    where.push(`repo_id = ?`);
    params.push(f.repoId);
  }
  if (f?.status) {
    if (!f.status.length) where.push(`1 = 0`);
    else {
      where.push(`status IN (${f.status.map(() => '?').join(', ')})`);
      params.push(...f.status);
    }
  }
  if (f?.createdByTask) {
    where.push(`created_by_task = ?`);
    params.push(f.createdByTask);
  }
  if (f?.createdByRun) {
    where.push(`created_by_run = ?`);
    params.push(f.createdByRun);
  }
  return {
    sql: `SELECT * FROM tm_jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT 1000`,
    params,
  };
}

const PATCH_COLUMNS: Record<keyof JobPatch, string> = {
  title: 'title',
  instructions: 'instructions',
  repoId: 'repo_id',
  nextRunAt: 'next_run_at',
  repeatEveryMs: 'repeat_every_ms',
  repeatUntil: 'repeat_until',
  maxRuns: 'max_runs',
  model: 'model',
  effort: 'effort',
};

/** A field edit; never touches status (the conditional steps below own it). */
export function jobPatchSql(id: string, p: JobPatch, at: string): { sql: string; params: unknown[] } | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, col] of Object.entries(PATCH_COLUMNS) as [keyof JobPatch, string][]) {
    if (p[k] === undefined) continue;
    sets.push(`${col} = ?`);
    params.push(p[k]);
  }
  if (!sets.length) return null;
  sets.push(`updated_at = ?`);
  params.push(at, id);
  return { sql: `UPDATE tm_jobs SET ${sets.join(', ')} WHERE id = ? RETURNING *`, params };
}

/**
 * `scheduled → running`, only while still due — the sweep's claim. A human's
 * Run now passes `force` and may also start a `paused` or `done` job (never a
 * cancelled or running one). Single winner: the loser reads null.
 */
export function jobClaimSql(id: string, now: string, force: boolean): { sql: string; params: unknown[] } {
  return force
    ? {
        sql: `UPDATE tm_jobs SET status = 'running', updated_at = ? WHERE id = ? AND status IN ('scheduled', 'paused', 'done') RETURNING *`,
        params: [now, id],
      }
    : {
        sql: `UPDATE tm_jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'scheduled' AND next_run_at IS NOT NULL AND next_run_at <= ? RETURNING *`,
        params: [now, id, now],
      };
}

/**
 * A status step from one of `from`. `nextRunAt` undefined leaves the column;
 * `last` (after a run) writes the last_* columns and bumps runs_count.
 */
export function jobStepSql(
  id: string,
  from: JobStatus[],
  to: JobStatus,
  at: string,
  opts: {
    nextRunAt?: string | null;
    last?: { runId: string | null; verdict: JobVerdict; summary: string | null; at: string; counted: boolean };
  } = {},
): { sql: string; params: unknown[] } {
  const sets = [`status = ?`, `updated_at = ?`];
  const params: unknown[] = [to, at];
  if (opts.nextRunAt !== undefined) {
    sets.push(`next_run_at = ?`);
    params.push(opts.nextRunAt);
  }
  if (opts.last) {
    sets.push(`last_run_id = ?`, `last_verdict = ?`, `last_summary = ?`, `last_run_at = ?`);
    params.push(opts.last.runId, opts.last.verdict, opts.last.summary, opts.last.at);
    if (opts.last.counted) sets.push(`runs_count = runs_count + 1`);
  }
  params.push(id, ...from);
  return {
    sql: `UPDATE tm_jobs SET ${sets.join(', ')} WHERE id = ? AND status IN (${from.map(() => '?').join(', ')}) RETURNING *`,
    params,
  };
}

export const JOB_SCHEDULED_COUNT_SQL = `SELECT COUNT(*) AS n FROM tm_jobs WHERE repo_id = ? AND status IN ('scheduled', 'running', 'paused')`;
export const JOB_DELETE_SQL = `DELETE FROM tm_jobs WHERE id = ?`;
export const JOB_RUNS_DELETE_SQL = `DELETE FROM tm_job_runs WHERE job_id = ?`;

export const JOB_RUN_INSERT_SQL = `INSERT INTO tm_job_runs (id, job_id, run_id, run_number, fired_by, started_at) VALUES (?, ?, ?, ?, ?, ?)`;

export interface JobRunFinish {
  verdict: JobVerdict;
  summary: string | null;
  findings: JobFinding[];
  followUpTaskIds: string[];
  reportPath: string | null;
  error: string | null;
}

/** open → finished, once (`ended_at IS NULL`) */
export const JOB_RUN_FINISH_SQL = `UPDATE tm_job_runs SET ended_at = ?, verdict = ?, summary = ?, findings = ?, follow_ups = ?, report_path = ?, error = ? WHERE id = ? AND ended_at IS NULL RETURNING *`;

export function jobRunFinishParams(id: string, f: JobRunFinish, at: string): unknown[] {
  return [at, f.verdict, f.summary, JSON.stringify(f.findings), JSON.stringify(f.followUpTaskIds), f.reportPath, f.error, id];
}

export const JOB_RUN_SET_RUN_ID_SQL = `UPDATE tm_job_runs SET run_id = ? WHERE id = ?`;
export const JOB_RUN_ACK_SQL = `UPDATE tm_job_runs SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL RETURNING *`;
/** acknowledge every open attention/error run of a job (the job page's one button) */
export const JOB_RUNS_ACK_ALL_SQL = `UPDATE tm_job_runs SET acknowledged_at = ? WHERE job_id = ? AND acknowledged_at IS NULL AND verdict IN ('attention', 'error') RETURNING *`;
export const JOB_RUNS_FOR_JOB_SQL = `SELECT * FROM tm_job_runs WHERE job_id = ? ORDER BY started_at DESC, id DESC LIMIT 200`;
/** the Inbox `job` kind: attention/error runs not yet acknowledged */
export const JOB_RUNS_OPEN_SQL = `SELECT * FROM tm_job_runs WHERE acknowledged_at IS NULL AND verdict IN ('attention', 'error') ORDER BY ended_at DESC LIMIT 200`;
/** boot: a run left open by a crash */
export const JOB_RUNS_UNFINISHED_SQL = `SELECT * FROM tm_job_runs WHERE ended_at IS NULL`;

function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

export function rowToJob(r: any): Job {
  return {
    id: r.id,
    repoId: r.repo_id,
    title: r.title,
    instructions: r.instructions,
    context: json<JobContext | null>(r.context, null),
    source: r.source,
    createdByRun: r.created_by_run ?? null,
    createdByTask: r.created_by_task ?? null,
    status: r.status,
    nextRunAt: r.next_run_at ?? null,
    repeatEveryMs: num(r.repeat_every_ms),
    repeatUntil: r.repeat_until ?? null,
    maxRuns: num(r.max_runs),
    runsCount: Number(r.runs_count ?? 0),
    model: r.model ?? null,
    effort: r.effort ?? null,
    lastRunId: r.last_run_id ?? null,
    lastVerdict: r.last_verdict ?? null,
    lastSummary: r.last_summary ?? null,
    lastRunAt: r.last_run_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function rowToJobRun(r: any): JobRun {
  return {
    id: r.id,
    jobId: r.job_id,
    runId: r.run_id ?? null,
    runNumber: Number(r.run_number),
    startedAt: r.started_at,
    endedAt: r.ended_at ?? null,
    verdict: r.verdict ?? null,
    summary: r.summary ?? null,
    findings: json<JobFinding[]>(r.findings, []),
    followUpTaskIds: json<string[]>(r.follow_ups, []),
    reportPath: r.report_path ?? null,
    error: r.error ?? null,
    acknowledgedAt: r.acknowledged_at ?? null,
    firedBy: r.fired_by,
  };
}
