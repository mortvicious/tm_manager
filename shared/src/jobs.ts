// Scheduled jobs (docs/jobs.md): an instruction + a due time (+ an optional
// simple repeat) that the server fires by itself as an aux `claude` terminal
// (kind `job`) when the system is quiet. Jobs are NOT tasks: own table, own
// queue switch (`jobs.enabled`, independent of `orchestrator.enabled`), never a
// worker slot, never the repo. Everything here is pure — the server's sweep and
// the SPA's "overdue — 4 tasks active" line read the same rule.

export type JobStatus = 'scheduled' | 'running' | 'paused' | 'done' | 'cancelled';
/** `failed` = the run never finished (restart, kill); `error` = it ended without a valid result */
export type JobVerdict = 'ok' | 'attention' | 'failed' | 'error';
export type JobSource = 'agent' | 'human' | 'telegram';
export type JobFindingSeverity = 'info' | 'warn' | 'critical';

/** What the filer did, snapshotted at create time so a later task delete loses nothing. */
export interface JobContext {
  taskId?: string | null;
  taskTitle?: string | null;
  brief?: string | null;
  resultSummary?: string | null;
  /** the filer's trailer commits (sha + subject) */
  commits?: { sha: string; subject: string }[];
  notes?: string | null;
}

export interface Job {
  id: string;
  repoId: string;
  title: string;
  instructions: string;
  context: JobContext | null;
  source: JobSource;
  createdByRun: string | null;
  createdByTask: string | null;
  status: JobStatus;
  /** null once done/cancelled */
  nextRunAt: string | null;
  /** null = one-shot */
  repeatEveryMs: number | null;
  repeatUntil: string | null;
  maxRuns: number | null;
  runsCount: number;
  model: string | null;
  effort: string | null;
  lastRunId: string | null;
  lastVerdict: JobVerdict | null;
  lastSummary: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobFinding {
  severity: JobFindingSeverity;
  text: string;
  evidence?: string | null;
}

/** One firing of a job. `runId` is its aux `tm_runs` row (mode 'aux', kind 'job', subject = job id). */
export interface JobRun {
  id: string;
  jobId: string;
  runId: string | null;
  /** 1-based */
  runNumber: number;
  startedAt: string;
  endedAt: string | null;
  verdict: JobVerdict | null;
  summary: string | null;
  findings: JobFinding[];
  followUpTaskIds: string[];
  /** relative to the server's data dir: artifacts/jobs/<jobId>/<id>.md */
  reportPath: string | null;
  error: string | null;
  acknowledgedAt: string | null;
  /** human | orchestrator | telegram */
  firedBy: string;
  /** from the aux run row, filled on read */
  costUsd?: number | null;
}

export interface JobsSettings {
  enabled: boolean;
  /** fire only while running+waiting tasks (all repos) < this; 0 = no threshold */
  maxActiveTasks: number;
  /** job aux runs at once */
  concurrency: number;
  timeoutMinutes: number;
  model: string;
  effort: string;
}

export const JOB_TITLE_MAX = 80;
export const JOB_INSTRUCTIONS_MAX = 20_000;
export const JOB_MIN_DELAY_MS = 10 * 60_000;
export const JOB_MAX_HORIZON_MS = 180 * 86_400_000;
export const JOB_MIN_EVERY_MS = 3_600_000;
export const JOB_MAX_RUNS = 100;
/** agent caps (routes/agent-jobs.ts) */
export const JOB_AGENT_PER_SESSION = 5;
export const JOB_REPO_SCHEDULED_CAP = 50;
/** follow-up drafts the server files per run */
export const JOB_FOLLOWUP_CAP = 3;
export const JOB_CONCURRENCY_MAX = 3;
export const JOB_MAX_ACTIVE_TASKS_MAX = 10;
/** an `overloaded`/`server_error` run is fired again after this, once */
export const JOB_TRANSIENT_RETRY_MS = 2 * 60_000;

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

/**
 * `"7d"`, `"36h"`, `"90m"`, `"2w"`, `"1d12h"` → milliseconds; null on anything
 * else (no bare numbers: a unit-less "7" is ambiguous, so it is refused).
 */
export function parseDuration(text: string): number | null {
  const s = text.trim().toLowerCase().replace(/\s+/g, '');
  if (!s || !/^(\d+(\.\d+)?(min|m|h|d|w))+$/.test(s)) return null;
  let total = 0;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(min|m|h|d|w)/g)) total += Number(m[1]) * UNIT_MS[m[2]];
  return Number.isFinite(total) && total > 0 ? Math.round(total) : null;
}

/** 90 min → "1h30m", 7 d → "7d" — the inverse of parseDuration, for display */
export function formatDuration(ms: number): string {
  if (!(ms > 0)) return '0m';
  const parts: string[] = [];
  let left = Math.round(ms / 60_000);
  const w = Math.floor(left / 10_080);
  if (w && left % 10_080 === 0) return `${w}w`;
  const d = Math.floor(left / 1440);
  left -= d * 1440;
  const h = Math.floor(left / 60);
  left -= h * 60;
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (left) parts.push(`${left}m`);
  return parts.join('') || '0m';
}

/** a relative time for people: `2d`, `1d 5h`, `3h`, `40m` — one or two units, never `1d23h59m` */
export function roughDuration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  const rest = h - d * 24;
  return d >= 3 || !rest ? `${Math.round(h / 24)}d` : `${d}d ${rest}h`;
}

export interface JobScheduleInput {
  runAt?: string | null;
  delay?: string | null;
  repeat?: { every: string; until?: string | null; maxRuns?: number | null } | null;
}

export interface JobSchedule {
  nextRunAt: string;
  repeatEveryMs: number | null;
  repeatUntil: string | null;
  maxRuns: number | null;
}

/**
 * Validate a schedule and resolve it to absolute times. `minDelayMs` is the
 * agent's 10-minute floor; a human may schedule sooner (0). Returns the reason
 * on refusal — the routes answer it verbatim.
 */
export function resolveSchedule(
  input: JobScheduleInput,
  now: number,
  opts: { minDelayMs?: number } = {},
): JobSchedule | { error: string } {
  const minDelay = opts.minDelayMs ?? 0;
  if (input.runAt && input.delay) return { error: 'give runAt or delay, not both' };
  let at: number;
  if (input.delay) {
    const ms = parseDuration(input.delay);
    if (ms == null) return { error: `delay "${input.delay}" is not a duration like 7d, 36h, 90m` };
    at = now + ms;
  } else if (input.runAt) {
    at = Date.parse(input.runAt);
    if (!Number.isFinite(at)) return { error: `runAt "${input.runAt}" is not a date` };
  } else {
    return { error: 'runAt or delay is required' };
  }
  if (at - now < minDelay - 1000) return { error: `the first run must be at least ${formatDuration(minDelay)} away` };
  if (at - now > JOB_MAX_HORIZON_MS) return { error: 'the first run must be within 180 days' };
  let repeatEveryMs: number | null = null;
  let repeatUntil: string | null = null;
  let maxRuns: number | null = null;
  if (input.repeat) {
    const every = parseDuration(input.repeat.every ?? '');
    if (every == null) return { error: `repeat.every "${input.repeat.every}" is not a duration like 1d, 12h` };
    if (every < JOB_MIN_EVERY_MS) return { error: 'repeat.every must be at least 1h' };
    repeatEveryMs = every;
    if (input.repeat.until) {
      const until = Date.parse(input.repeat.until);
      if (!Number.isFinite(until)) return { error: `repeat.until "${input.repeat.until}" is not a date` };
      if (until < at) return { error: 'repeat.until is before the first run' };
      if (until - now > JOB_MAX_HORIZON_MS) return { error: 'repeat.until must be within 180 days' };
      repeatUntil = new Date(until).toISOString();
    }
    if (input.repeat.maxRuns != null) {
      const n = input.repeat.maxRuns;
      if (!Number.isInteger(n) || n < 1 || n > JOB_MAX_RUNS) return { error: `repeat.maxRuns must be 1..${JOB_MAX_RUNS}` };
      maxRuns = n;
    }
  }
  return { nextRunAt: new Date(at).toISOString(), repeatEveryMs, repeatUntil, maxRuns };
}

/**
 * Where a job goes after a run that started at `firedAt` for the slot
 * `scheduledAt`: the next slot keeps the cadence (`scheduledAt + every`), but
 * never in the past — a job that missed several slots fires ONCE and then
 * schedules `now + every` (no catch-up storm). null = the job is done.
 * `runsCount` is the count INCLUDING the run that just finished.
 */
export function nextRunAfter(
  job: Pick<Job, 'repeatEveryMs' | 'repeatUntil' | 'maxRuns'>,
  runsCount: number,
  scheduledAt: number,
  now: number,
): string | null {
  if (!job.repeatEveryMs) return null;
  if (job.maxRuns != null && runsCount >= job.maxRuns) return null;
  let next = scheduledAt + job.repeatEveryMs;
  if (!(next > now)) next = now + job.repeatEveryMs;
  if (job.repeatUntil && next > Date.parse(job.repeatUntil)) return null;
  return new Date(next).toISOString();
}

/** `budget` is the server's own (the day fuse), never returned by jobsDue */
export type JobsHold = 'off' | 'paused' | 'busy' | 'concurrency' | 'budget';

export interface JobsDueInput {
  now: number;
  /** running + waiting tasks, all repos */
  activeTasks: number;
  liveJobRuns: number;
  settings: Pick<JobsSettings, 'enabled' | 'maxActiveTasks' | 'concurrency'>;
  paused: boolean;
}

export interface JobsDueResult {
  /** what to fire now, oldest due first */
  fire: Job[];
  /** every due job, oldest first (fired or not) */
  due: Job[];
  /** why the rest of `due` does not fire; null when nothing holds them */
  hold: JobsHold | null;
}

export function isJobDue(job: Pick<Job, 'status' | 'nextRunAt'>, now: number): boolean {
  return job.status === 'scheduled' && !!job.nextRunAt && Date.parse(job.nextRunAt) <= now;
}

function dueOrder(a: Job, b: Job): number {
  return Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/**
 * THE firing rule: due (`scheduled`, `nextRunAt <= now`) AND the switch on AND
 * not paused AND running+waiting tasks < `maxActiveTasks` (0 = no threshold)
 * AND live job runs < `concurrency` → the oldest due first. Budget is the
 * server's own per-fire check (`budgetAllows(…, 'job')`), not here.
 */
export function jobsDue(jobs: Job[], input: JobsDueInput): JobsDueResult {
  const due = jobs.filter((j) => isJobDue(j, input.now)).sort(dueOrder);
  if (!due.length) return { fire: [], due, hold: null };
  let hold: JobsHold | null = null;
  if (input.paused) hold = 'paused';
  else if (!input.settings.enabled) hold = 'off';
  else if (input.settings.maxActiveTasks > 0 && input.activeTasks >= input.settings.maxActiveTasks) hold = 'busy';
  if (hold) return { fire: [], due, hold };
  const room = Math.max(0, input.settings.concurrency - input.liveJobRuns);
  const fire = due.slice(0, room);
  return { fire, due, hold: fire.length < due.length ? 'concurrency' : null };
}

/** "overdue by 2h — 4 tasks active" — the UI's reading of a hold */
export function jobHoldText(hold: JobsHold | null, input: { activeTasks: number; maxActiveTasks: number }): string | null {
  switch (hold) {
    case 'off':
      return 'jobs queue is off';
    case 'paused':
      return 'Pause all is on';
    case 'busy':
      return `${input.activeTasks} task${input.activeTasks === 1 ? '' : 's'} active (fires below ${input.maxActiveTasks})`;
    case 'concurrency':
      return 'another job is running';
    case 'budget':
      return 'the day budget is spent';
    default:
      return null;
  }
}

/** Refusal for a human "Run now": bypasses the switch and the threshold, never Pause all or the concurrency cap. */
export function runNowRefusal(
  job: Pick<Job, 'status'>,
  input: Pick<JobsDueInput, 'liveJobRuns' | 'paused'> & { concurrency: number },
): string | null {
  if (job.status === 'running') return 'job is already running';
  if (job.status === 'cancelled') return 'job is cancelled';
  if (input.paused) return 'Pause all is on — Continue first';
  if (input.liveJobRuns >= input.concurrency) return `job concurrency (${input.concurrency}) is full`;
  return null;
}

/**
 * an attention/error run the human has not acknowledged — the Inbox `job` kind.
 * `failed` (interrupted by a restart or a kill) is not: the job is due again.
 */
export function jobRunNeedsHuman(r: Pick<JobRun, 'verdict' | 'acknowledgedAt'>): boolean {
  return !r.acknowledgedAt && (r.verdict === 'attention' || r.verdict === 'error');
}
