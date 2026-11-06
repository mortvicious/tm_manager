import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_SETTINGS,
  EFFORT_LEVELS,
  JOB_FOLLOWUP_CAP,
  JOB_INSTRUCTIONS_MAX,
  JOB_TITLE_MAX,
  JOB_TRANSIENT_RETRY_MS,
  MODEL_OPTIONS,
  isJobDue,
  jobsDue,
  nextRunAfter,
  resolveSchedule,
  runNowRefusal,
  type AppSettings,
  type EffortLevel,
  type Job,
  type JobContext,
  type JobFinding,
  type JobRun,
  type JobScheduleInput,
  type JobSource,
  type JobVerdict,
  type JobsHold,
  type OrchestratorStatus,
  type Repo,
} from '@tm/shared';
import { acceptJson, aux, readableTail, resultInstruction, withModelFallback, type AuxOutcome } from './claude/aux.ts';
import { artifactsRoot } from './config.ts';
import { broadcast } from './events.ts';
import { run as git } from './git.ts';
import { redactSecrets } from './secrets.ts';
import type { JobPatch } from './storage/job-sql.ts';
import type { NewTask, Storage } from './storage/types.ts';
import { createTask, createTaskInNamedGroup } from './task-actions.ts';
import { reachRepoIds, serverJoin, type FilerContext } from './group-filing.ts';
import { GROUP_NAME_MAX, TERMINAL_TASK_STATUSES, type Task } from '@tm/shared';
import type { BudgetVerdict } from './budget.ts';
import { memoryHold } from './memory.ts';

// Scheduled jobs (docs/jobs.md): an instruction + a due time (+ an optional
// simple repeat) the server fires by itself as an aux `claude` terminal (kind
// `job`, subject = the job id, task_id NULL like every aux run) when the
// system is quiet. A job run is NEVER a worker: it takes no slot and no repo,
// it only observes. The firing rule is the pure `jobsDue` in shared.

/** The structured result every job run ends with (validated by acceptJson, ≤2 typed corrections). */
const resultSchema = z.object({
  verdict: z.enum(['ok', 'attention']),
  summary: z.string().min(1).max(4000),
  findings: z
    .array(
      z.object({
        severity: z.enum(['info', 'warn', 'critical']),
        text: z.string().min(1).max(2000),
        evidence: z.string().max(4000).nullish(),
      }),
    )
    .max(50)
    .default([]),
  followUps: z
    .array(
      z.object({
        title: z.string().min(1).max(JOB_TITLE_MAX),
        brief: z.string().max(400).default(''),
        description: z.string().min(1).max(20_000),
        repo: z.string().max(200).nullish(),
      }),
    )
    .max(10)
    .default([]),
});
type JobResult = z.infer<typeof resultSchema>;

const RESULT_JSON_SCHEMA = {
  type: 'object',
  required: ['verdict', 'summary', 'findings', 'followUps'],
  properties: {
    verdict: { enum: ['ok', 'attention'], description: 'ok = all clear; attention = the human should look' },
    summary: { type: 'string', description: '2-5 sentences for the human' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'text'],
        properties: {
          severity: { enum: ['info', 'warn', 'critical'] },
          text: { type: 'string' },
          evidence: { type: 'string', description: 'a log line, a metric, a link' },
        },
      },
    },
    followUps: {
      type: 'array',
      maxItems: JOB_FOLLOWUP_CAP,
      description: 'work to do about it — filed as DRAFT tasks by the server; [] when none',
      items: {
        type: 'object',
        required: ['title', 'description'],
        properties: {
          title: { type: 'string', maxLength: JOB_TITLE_MAX },
          brief: { type: 'string', maxLength: 400 },
          description: { type: 'string', description: 'the full task contract' },
          repo: { type: 'string', description: 'repo id or name; omit for this job’s repo' },
        },
      },
    },
  },
};

/**
 * Edit tools are denied; Bash is allowed (logs, alarms, error rates need `aws`,
 * `gh`, `curl`, the repo's scripts) — so the run uses `bypass`, like a `write`
 * chat: `dontAsk` would deny every Bash call that prompts. Nobody sits at the
 * terminal, so the dialog tools are denied too. SECURITY.md § Scheduled jobs.
 */
export const JOB_DISALLOWED = ['Edit', 'Write', 'NotebookEdit', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];

/**
 * An AGENT-filed job never runs more permissively than the workers do
 * (`agent.permissionMode`, read at fire time), or a restricted worker could
 * launder Bash through a job ten minutes later: `bypassPermissions` → bypass,
 * `auto` → the same classifier-gated `auto`, `acceptEdits` → `dontAsk` (Bash
 * would prompt there, and nobody is at the terminal). A human's job (browser
 * or Telegram) keeps bypass. SECURITY.md § Scheduled jobs.
 */
export function jobPermission(job: Pick<Job, 'source' | 'createdByRun'>, s: AppSettings): 'bypass' | 'auto' | 'dontAsk' {
  if (job.source !== 'agent' && !job.createdByRun) return 'bypass';
  const mode = s['agent.permissionMode'] ?? DEFAULT_SETTINGS['agent.permissionMode'];
  if (mode === 'bypassPermissions') return 'bypass';
  if (mode === 'auto') return 'auto';
  return 'dontAsk';
}

export interface JobCreateInput extends JobScheduleInput {
  title: string;
  instructions: string;
  repoId: string;
  context?: JobContext | null;
  model?: string | null;
  effort?: string | null;
}

export type JobResultOr<T> = { ok: true; value: T } | { ok: false; code: 400 | 403 | 404 | 409; error: string };

export interface JobServiceDeps {
  storage: Storage;
  isPaused: (settings?: AppSettings) => Promise<boolean>;
  budget: (settings: AppSettings) => Promise<BudgetVerdict>;
}

type Settled = { kind: 'result'; result: JobResult; text: string | null } | { kind: 'error'; error: string } | { kind: 'failed'; error: string } | { kind: 'retry'; error: string };

export function jobsSettings(s: AppSettings) {
  return {
    enabled: s['jobs.enabled'] ?? DEFAULT_SETTINGS['jobs.enabled'],
    maxActiveTasks: s['jobs.maxActiveTasks'] ?? DEFAULT_SETTINGS['jobs.maxActiveTasks'],
    concurrency: s['jobs.concurrency'] ?? DEFAULT_SETTINGS['jobs.concurrency'],
    timeoutMinutes: s['jobs.timeoutMinutes'] ?? DEFAULT_SETTINGS['jobs.timeoutMinutes'],
    model: s['jobs.model'] ?? DEFAULT_SETTINGS['jobs.model'],
    effort: (s['jobs.effort'] ?? DEFAULT_SETTINGS['jobs.effort']) as EffortLevel,
  };
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** validate a model/effort pick: null = the setting's default */
export function modelRefusal(model: string | null | undefined, effort: string | null | undefined): string | null {
  if (model != null && model !== '' && !MODEL_OPTIONS.includes(model)) return `model must be one of ${MODEL_OPTIONS.join(', ')}`;
  if (effort != null && effort !== '' && !EFFORT_LEVELS.includes(effort as EffortLevel)) return `effort must be one of ${EFFORT_LEVELS.join(', ')}`;
  return null;
}

/** where a run leaves its job: advance the schedule, or (Run now) keep the slot / back to paused */
type RunAfter = 'advance' | 'keep' | 'paused';

export class JobService {
  /** job id → the AbortController of its live run */
  private live = new Map<string, AbortController>();
  /** job ids Pause all aborted: back to `scheduled`, due again on Continue, not counted */
  private suspending = new Set<string>();
  /** job ids already retried once after an overloaded/server_error StopFailure */
  private transientRetried = new Set<string>();
  private stopping = false;
  private sweeping = false;
  private timer: NodeJS.Timeout | null = null;
  private lastStatus: NonNullable<OrchestratorStatus['jobs']> = {
    enabled: true,
    due: 0,
    overdue: 0,
    running: 0,
    hold: null,
    activeTasks: 0,
    maxActiveTasks: DEFAULT_SETTINGS['jobs.maxActiveTasks'],
  };
  private statusListeners: (() => void)[] = [];

  constructor(private deps: JobServiceDeps) {}

  start(): void {
    this.timer = setInterval(() => void this.sweep(), 30_000);
    this.timer.unref();
    void this.sweep();
  }

  /** shutdown: outcomes after this leave the rows to boot recovery */
  stop(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }

  onStatus(l: () => void): void {
    this.statusListeners.push(l);
  }

  status(): NonNullable<OrchestratorStatus['jobs']> {
    return { ...this.lastStatus, running: this.live.size };
  }

  liveCount(): number {
    return this.live.size;
  }

  // ---- create / edit ----

  async create(
    input: JobCreateInput,
    by: { source: JobSource; actor: string; runId?: string | null; taskId?: string | null; minDelayMs?: number },
  ): Promise<JobResultOr<Job>> {
    const title = oneLine(input.title ?? '');
    if (!title) return { ok: false, code: 400, error: 'title is required' };
    if (title.length > JOB_TITLE_MAX) return { ok: false, code: 400, error: `title must be ≤ ${JOB_TITLE_MAX} chars` };
    const instructions = (input.instructions ?? '').trim();
    if (!instructions) return { ok: false, code: 400, error: 'instructions are required' };
    if (instructions.length > JOB_INSTRUCTIONS_MAX) return { ok: false, code: 400, error: `instructions must be ≤ ${JOB_INSTRUCTIONS_MAX} chars` };
    const repo = await this.deps.storage.getRepo(input.repoId);
    if (!repo) return { ok: false, code: 404, error: 'repo not found' };
    const bad = modelRefusal(input.model, input.effort);
    if (bad) return { ok: false, code: 400, error: bad };
    const sched = resolveSchedule(input, Date.now(), { minDelayMs: by.minDelayMs ?? 0 });
    if ('error' in sched) return { ok: false, code: 400, error: sched.error };
    const job = await this.deps.storage.createJob({
      repoId: repo.id,
      title,
      instructions,
      context: input.context ?? null,
      source: by.source,
      createdByRun: by.runId ?? null,
      createdByTask: by.taskId ?? null,
      ...sched,
      model: input.model || null,
      effort: input.effort || null,
    });
    await this.audit('job.created', by.actor, job, {
      title: redactSecrets(job.title),
      source: job.source,
      nextRunAt: job.nextRunAt,
      repeatEveryMs: job.repeatEveryMs,
    });
    this.changed(job);
    return { ok: true, value: job };
  }

  /**
   * A human edit: content, repo, model, and/or a new schedule. A new schedule
   * moves a scheduled or paused job (a paused one stays paused) and brings a
   * `done` one back to `scheduled`; a cancelled job keeps its status.
   */
  async update(
    id: string,
    patch: { title?: string; instructions?: string; repoId?: string; model?: string | null; effort?: string | null; schedule?: JobScheduleInput | null },
    actor: string,
  ): Promise<JobResultOr<Job>> {
    const cur = await this.deps.storage.getJob(id);
    if (!cur) return { ok: false, code: 404, error: 'job not found' };
    const p: JobPatch = {};
    if (patch.title !== undefined) {
      const t = oneLine(patch.title);
      if (!t || t.length > JOB_TITLE_MAX) return { ok: false, code: 400, error: `title must be 1..${JOB_TITLE_MAX} chars` };
      p.title = t;
    }
    if (patch.instructions !== undefined) {
      const t = patch.instructions.trim();
      if (!t || t.length > JOB_INSTRUCTIONS_MAX) return { ok: false, code: 400, error: 'instructions are required' };
      p.instructions = t;
    }
    if (patch.repoId !== undefined) {
      if (!(await this.deps.storage.getRepo(patch.repoId))) return { ok: false, code: 404, error: 'repo not found' };
      p.repoId = patch.repoId;
    }
    const bad = modelRefusal(patch.model, patch.effort);
    if (bad) return { ok: false, code: 400, error: bad };
    if (patch.model !== undefined) p.model = patch.model || null;
    if (patch.effort !== undefined) p.effort = patch.effort || null;
    if (patch.schedule) {
      const s = resolveSchedule(patch.schedule, Date.now());
      if ('error' in s) return { ok: false, code: 400, error: s.error };
      Object.assign(p, s);
    }
    let job = await this.deps.storage.updateJob(id, p);
    if (!job) return { ok: false, code: 404, error: 'job not found' };
    // a new schedule on a finished job brings it back
    if (patch.schedule && job.status === 'done') job = (await this.deps.storage.stepJob(id, ['done'], 'scheduled')) ?? job;
    await this.audit('job.updated', actor, job, { keys: Object.keys(p) });
    this.changed(job);
    return { ok: true, value: job };
  }

  async pause(id: string, actor: string): Promise<JobResultOr<Job>> {
    const job = await this.deps.storage.stepJob(id, ['scheduled'], 'paused');
    if (!job) return this.refusal(id, 'only a scheduled job can be paused');
    await this.audit('job.paused', actor, job);
    this.changed(job);
    return { ok: true, value: job };
  }

  async resume(id: string, actor: string): Promise<JobResultOr<Job>> {
    const cur = await this.deps.storage.getJob(id);
    if (!cur) return { ok: false, code: 404, error: 'job not found' };
    // a slot that passed while paused fires once, now-ish — never a storm
    const next = cur.nextRunAt && Date.parse(cur.nextRunAt) > Date.now() ? cur.nextRunAt : new Date().toISOString();
    const job = await this.deps.storage.stepJob(id, ['paused'], 'scheduled', { nextRunAt: next });
    if (!job) return this.refusal(id, 'only a paused job can be resumed');
    await this.audit('job.resumed', actor, job);
    this.changed(job);
    void this.sweep();
    return { ok: true, value: job };
  }

  async cancel(id: string, actor: string): Promise<JobResultOr<Job>> {
    const job = await this.deps.storage.stepJob(id, ['scheduled', 'paused', 'done'], 'cancelled', { nextRunAt: null });
    if (!job) return this.refusal(id, 'a running job is stopped first (Kill its terminal)');
    await this.audit('job.cancelled', actor, job);
    this.changed(job);
    return { ok: true, value: job };
  }

  async remove(id: string, actor: string): Promise<JobResultOr<{ id: string }>> {
    const cur = await this.deps.storage.getJob(id);
    if (!cur) return { ok: false, code: 404, error: 'job not found' };
    this.live.get(id)?.abort();
    if (!(await this.deps.storage.deleteJob(id))) return { ok: false, code: 404, error: 'job not found' };
    fs.rmSync(path.join(artifactsRoot, 'jobs', id), { recursive: true, force: true });
    await this.audit('job.deleted', actor, cur, { title: redactSecrets(cur.title) });
    broadcast({ type: 'job.deleted', jobId: id });
    void this.refreshStatus();
    return { ok: true, value: { id } };
  }

  async acknowledge(jobId: string, runId: string | null): Promise<JobResultOr<JobRun[]>> {
    const runs = runId ? [await this.deps.storage.acknowledgeJobRun(runId)].filter((r): r is JobRun => !!r && r.jobId === jobId) : await this.deps.storage.acknowledgeJobRuns(jobId);
    for (const r of runs) broadcast({ type: 'job-run.updated', run: r });
    return { ok: true, value: runs };
  }

  async setEnabled(enabled: boolean, actor: string): Promise<void> {
    await this.deps.storage.setSetting('jobs.enabled', enabled);
    await this.deps.storage.appendEvent({ kind: 'jobs.toggle', actor, data: { enabled } });
    broadcast({ type: 'jobs.toggle', enabled });
    await this.refreshStatus();
    if (enabled) void this.sweep();
  }

  /** Run now (human): bypasses the switch and the threshold — never Pause all or the concurrency cap. */
  async runNow(id: string, actor: string): Promise<JobResultOr<Job>> {
    const cur = await this.deps.storage.getJob(id);
    if (!cur) return { ok: false, code: 404, error: 'job not found' };
    const settings = await this.deps.storage.getSettings();
    const js = jobsSettings(settings);
    const refused = runNowRefusal(cur, { liveJobRuns: this.live.size, paused: await this.deps.isPaused(settings), concurrency: js.concurrency });
    if (refused) return { ok: false, code: 409, error: refused };
    // An extra run: a paused job goes back to paused, a scheduled one keeps
    // its slot when it is not due yet (Run now on "check in 7 days" must not
    // eat the 7-day check); a due or done one advances as a normal run.
    const after: RunAfter = cur.status === 'paused' ? 'paused' : cur.status === 'scheduled' && !isJobDue(cur, Date.now()) ? 'keep' : 'advance';
    const claimed = await this.deps.storage.claimDueJob(id, new Date().toISOString(), true);
    if (!claimed) return this.refusal(id, 'job is not runnable');
    void this.execute(claimed, actor, cur.nextRunAt && after === 'advance' ? Math.min(Date.parse(cur.nextRunAt), Date.now()) : Date.now(), after);
    return { ok: true, value: claimed };
  }

  // ---- the sweep ----

  /** every 30 s and at the top of maybeSchedule: fire what `jobsDue` says, oldest due first */
  async sweep(): Promise<void> {
    if (this.sweeping || this.stopping) return;
    this.sweeping = true;
    try {
      const { storage } = this.deps;
      const settings = await storage.getSettings();
      const js = jobsSettings(settings);
      const [jobs, activeTasks, paused] = await Promise.all([
        storage.listJobs({ status: ['scheduled'] }),
        this.activeTasks(),
        this.deps.isPaused(settings),
      ]);
      const now = Date.now();
      const r = jobsDue(jobs, { now, activeTasks, liveJobRuns: this.live.size, settings: js, paused });
      let fired = 0;
      let budgetHold = false;
      // the memory fuse (docs/memory.md): due jobs stay due until it clears
      const memoryHeld = r.fire.length > 0 && memoryHold(settings) !== null;
      for (const job of memoryHeld ? [] : r.fire) {
        const verdict = await this.deps.budget(settings);
        if (!verdict.ok) {
          budgetHold = true;
          break;
        }
        const claimed = await storage.claimDueJob(job.id, new Date().toISOString());
        if (!claimed) continue;
        fired++;
        void this.execute(claimed, 'orchestrator', Date.parse(job.nextRunAt!), 'advance');
      }
      this.setStatus({
        enabled: js.enabled,
        due: r.due.length,
        overdue: r.due.length - fired,
        running: this.live.size,
        hold: memoryHeld ? 'memory' : budgetHold ? 'budget' : r.due.length - fired > 0 ? r.hold : null,
        activeTasks,
        maxActiveTasks: js.maxActiveTasks,
      });
    } catch (e) {
      console.error('[jobs] sweep failed:', (e as Error).message);
    } finally {
      this.sweeping = false;
    }
  }

  private async activeTasks(): Promise<number> {
    const [running, waiting] = await Promise.all([
      this.deps.storage.listTasks({ status: 'running' }),
      this.deps.storage.listTasks({ status: 'waiting' }),
    ]);
    return running.length + waiting.length;
  }

  private async refreshStatus(): Promise<void> {
    const settings = await this.deps.storage.getSettings();
    const js = jobsSettings(settings);
    const [jobs, activeTasks, paused] = await Promise.all([this.deps.storage.listJobs({ status: ['scheduled'] }), this.activeTasks(), this.deps.isPaused(settings)]);
    const r = jobsDue(jobs, { now: Date.now(), activeTasks, liveJobRuns: this.live.size, settings: js, paused });
    this.setStatus({ enabled: js.enabled, due: r.due.length, overdue: r.due.length - r.fire.length, running: this.live.size, hold: r.hold, activeTasks, maxActiveTasks: js.maxActiveTasks });
  }

  private setStatus(s: NonNullable<OrchestratorStatus['jobs']>): void {
    const prev = JSON.stringify(this.lastStatus);
    this.lastStatus = s;
    if (JSON.stringify(s) !== prev) for (const l of this.statusListeners) l();
  }

  // ---- Pause all / boot ----

  /**
   * Pause all suspends a live job run: the run is recorded `failed`
   * ("suspended by Pause all", not counted) and the job goes back to
   * `scheduled`, due now — it fires again after Continue.
   */
  suspendAll(): string[] {
    const ids = [...this.live.keys()];
    for (const id of ids) {
      this.suspending.add(id);
      this.live.get(id)?.abort();
    }
    return ids;
  }

  /** boot: a run left open by a crash is failed; its job is due again (once) */
  async recoverOnBoot(): Promise<number> {
    const { storage } = this.deps;
    const open = await storage.listUnfinishedJobRuns();
    for (const r of open) {
      await storage.finishJobRun(r.id, { verdict: 'failed', summary: null, findings: [], followUpTaskIds: [], reportPath: null, error: 'interrupted by restart' });
    }
    const now = new Date().toISOString();
    let n = 0;
    for (const j of await storage.listJobs({ status: ['running'] })) {
      const back = await storage.stepJob(j.id, ['running'], 'scheduled', { nextRunAt: now });
      if (back) {
        n++;
        await this.audit('job.updated', 'system', back, { recovered: 'interrupted by restart' });
      }
    }
    return n;
  }

  // ---- one run ----

  private async execute(job: Job, firedBy: string, scheduledAt: number, after: RunAfter): Promise<void> {
    const { storage } = this.deps;
    const ctl = new AbortController();
    this.live.set(job.id, ctl);
    this.setStatus({ ...this.lastStatus, running: this.live.size });
    let jr: JobRun | null = null;
    let auxRunId: string | null = null;
    try {
      jr = await storage.createJobRun({ jobId: job.id, runNumber: job.runsCount + 1, firedBy });
      await this.audit('job.fired', firedBy, job, { jobRunId: jr.id, runNumber: jr.runNumber });
      this.changed(job);
      broadcast({ type: 'job-run.updated', run: jr });

      const repo = await storage.getRepo(job.repoId);
      let settled: Settled;
      if (!repo || !fs.existsSync(repo.path)) {
        settled = { kind: 'error', error: repo ? `repo path ${repo.path} does not exist` : 'the job’s repo is gone' };
      } else {
        const settings = await storage.getSettings();
        const js = jobsSettings(settings);
        const previous = job.runsCount ? (await storage.listJobRuns(job.id)).find((r) => r.endedAt && r.verdict && r.id !== jr!.id) ?? null : null;
        const prompt = jobPrompt(job, repo, jr.runNumber, previous) + '\n' + resultInstruction(RESULT_JSON_SCHEMA);
        const thisRun = jr;
        const { res } = await withModelFallback(
          { model: job.model || js.model, effort: job.effort || js.effort },
          'xhigh',
          (model, effort) =>
            aux().run<JobResult>(
              {
                kind: 'job',
                subjectId: job.id,
                repoId: repo.id,
                label: `job: ${job.title}`,
                cwd: repo.path,
                model,
                effort: effort ?? undefined,
                prompt,
                tools: null,
                disallowedTools: JOB_DISALLOWED,
                permission: jobPermission(job, settings),
                lean: true,
                timeoutMs: js.timeoutMinutes * 60_000,
                accept: acceptJson(resultSchema),
                signal: ctl.signal,
              },
              (runId) => {
                auxRunId = runId;
                void storage.setJobRunRunId(thisRun.id, runId);
              },
            ),
          () => !ctl.signal.aborted,
        );
        if (res.runId) auxRunId = res.runId;
        settled = this.read(job, res);
      }
      await this.settle(job, jr, auxRunId, settled, scheduledAt, after);
    } catch (e) {
      if (jr) await this.settle(job, jr, auxRunId, { kind: 'error', error: clip(String((e as Error)?.message ?? e), 400) }, scheduledAt, after).catch(() => {});
      else {
        // the run row never existed: put the job back so it is not stuck `running`
        await storage.stepJob(job.id, ['running'], 'scheduled').catch(() => null);
      }
    } finally {
      this.live.delete(job.id);
      this.suspending.delete(job.id);
      void this.refreshStatus();
      if (!this.stopping) setTimeout(() => void this.sweep(), 1000).unref();
    }
  }

  private read(job: Job, res: AuxOutcome<JobResult>): Settled {
    if (res.status === 'ok' && res.value) {
      this.transientRetried.delete(job.id);
      return { kind: 'result', result: res.value, text: res.text };
    }
    if (res.status === 'aborted') return { kind: 'failed', error: 'the job’s session was stopped — the job is paused until Resume or Run now' };
    if (res.status === 'timeout') return { kind: 'error', error: `timed out (${res.error ?? 'no result'})` };
    if ((res.code === 'overloaded' || res.code === 'server_error') && !this.transientRetried.has(job.id)) {
      this.transientRetried.add(job.id);
      return { kind: 'retry', error: `${res.code}: ${res.error ?? ''}`.trim() };
    }
    this.transientRetried.delete(job.id);
    return { kind: 'error', error: clip(res.error ? readableTail(res.error, 400) || res.error : 'no output', 400) };
  }

  private async settle(job: Job, jr: JobRun, auxRunId: string | null, s: Settled, scheduledAt: number, after: RunAfter): Promise<void> {
    const { storage } = this.deps;
    // shutting down: leave the rows for recoverOnBoot (it fails the run, re-arms the job)
    if (this.stopping) return;
    // deleted mid-run: nothing to write (and no report dir to re-create)
    if (!(await storage.getJob(job.id))) return;
    const suspended = this.suspending.has(job.id);
    const at = new Date().toISOString();
    let verdict: JobVerdict;
    let summary: string | null = null;
    let findings: JobFinding[] = [];
    let error: string | null = null;
    let followUpTaskIds: string[] = [];
    let reportPath: string | null = null;
    if (suspended) {
      verdict = 'failed';
      error = 'suspended by Pause all — due again after Continue';
    } else if (s.kind === 'result') {
      verdict = s.result.verdict;
      summary = s.result.summary;
      findings = s.result.findings.map((f) => ({ severity: f.severity, text: f.text, evidence: f.evidence ?? null }));
      followUpTaskIds = await this.fileFollowUps(job, jr, s.result.followUps);
    } else {
      verdict = s.kind === 'failed' ? 'failed' : 'error';
      error = s.kind === 'retry' ? `${s.error} — retried once in 2 min` : s.error;
    }
    try {
      reportPath = writeReport(job, jr, { verdict, summary, findings, error, followUpTaskIds, text: s.kind === 'result' ? s.text : null });
    } catch {
      reportPath = null;
    }
    const finished = await storage.finishJobRun(jr.id, { verdict, summary, findings, followUpTaskIds, reportPath, error });
    // where the job goes next
    let next: Job | null;
    if (suspended) {
      next = await storage.stepJob(job.id, ['running'], 'scheduled', { nextRunAt: at, last: { runId: auxRunId, verdict, summary: error, at, counted: false } });
    } else if (s.kind === 'failed') {
      // stopped by a human (Kill, /killall, a forced restart): it waits for one
      next = await storage.stepJob(job.id, ['running'], 'paused', { last: { runId: auxRunId, verdict, summary: error, at, counted: false } });
    } else if (s.kind === 'retry') {
      next = await storage.stepJob(job.id, ['running'], 'scheduled', {
        nextRunAt: new Date(Date.now() + JOB_TRANSIENT_RETRY_MS).toISOString(),
        last: { runId: auxRunId, verdict, summary: error, at, counted: false },
      });
    } else if (after !== 'advance') {
      // Run now on a paused job or on a scheduled one before its slot: an extra run, the slot stands
      next = await storage.stepJob(job.id, ['running'], after === 'paused' ? 'paused' : 'scheduled', {
        last: { runId: auxRunId, verdict, summary: summary ?? error, at, counted: true },
      });
    } else {
      const runs = job.runsCount + 1;
      const nextAt = nextRunAfter(job, runs, scheduledAt, Date.now());
      next = await storage.stepJob(job.id, ['running'], nextAt ? 'scheduled' : 'done', {
        nextRunAt: nextAt,
        last: { runId: auxRunId, verdict, summary: summary ?? error, at, counted: true },
      });
    }
    await this.audit('job.finished', 'orchestrator', next ?? job, {
      jobRunId: jr.id,
      runId: auxRunId,
      verdict,
      error: error ? redactSecrets(error) : null,
      followUps: followUpTaskIds.length,
      suspended: suspended || undefined,
      retry: s.kind === 'retry' || undefined,
    });
    if (finished) broadcast({ type: 'job-run.updated', run: finished });
    if (next) this.changed(next);
  }

  /** The server, not the agent, files follow-ups — as drafts, source `job` (external: landing clamps to supervised), ≤ 3 per run. */
  private async fileFollowUps(job: Job, jr: JobRun, list: JobResult['followUps']): Promise<string[]> {
    const { storage } = this.deps;
    const ids: string[] = [];
    const repos = await storage.listRepos();
    for (const f of list.slice(0, JOB_FOLLOWUP_CAP)) {
      const repo: Repo | undefined = f.repo ? repos.find((r) => r.id === f.repo || r.name === f.repo) : repos.find((r) => r.id === job.repoId);
      const target = repo ?? repos.find((r) => r.id === job.repoId);
      if (!target) continue;
      try {
        const input: NewTask = {
          title: clip(oneLine(f.title), JOB_TITLE_MAX),
          brief: f.brief || null,
          description: `${f.description}\n\n---\nFiled by scheduled job “${job.title}” (run ${jr.runNumber}, /jobs?job=${job.id}).`,
          repoId: target.id,
          source: 'job',
          sourceRef: job.id,
          status: 'draft',
        };
        const task = await fileJobFollowUp(storage, job, input);
        ids.push(task.id);
      } catch (e) {
        console.error('[jobs] follow-up draft failed:', (e as Error).message);
      }
    }
    return ids;
  }

  private async refusal(id: string, why: string): Promise<{ ok: false; code: 404 | 409; error: string }> {
    const cur = await this.deps.storage.getJob(id);
    return cur ? { ok: false, code: 409, error: `${why} (it is ${cur.status})` } : { ok: false, code: 404, error: 'job not found' };
  }

  private changed(job: Job): void {
    broadcast({ type: 'job.updated', job });
    void this.refreshStatus().catch(() => {});
  }

  private async audit(kind: Parameters<Storage['appendEvent']>[0]['kind'], actor: string, job: Job, data: Record<string, unknown> = {}): Promise<void> {
    await this.deps.storage
      .appendEvent({ kind, actor, repoId: job.repoId, taskId: null, data: { jobId: job.id, ...data } })
      .catch((e) => console.error('[jobs] audit failed:', (e as Error).message));
  }

  /** is this job due right now (for the routes' readings) */
  isDue(job: Job): boolean {
    return isJobDue(job, Date.now());
  }
}

/** The context a job filed by a worker carries: the filer's id/title/brief/summary + its trailer commits. */
export async function filerContext(storage: Storage, taskId: string, notes?: string | null): Promise<JobContext | null> {
  const task = await storage.getTask(taskId);
  if (!task) return notes ? { notes } : null;
  const repo = task.repoId ? await storage.getRepo(task.repoId) : null;
  let commits: { sha: string; subject: string }[] = [];
  if (repo && fs.existsSync(repo.path)) {
    const { out, code } = await git(repo.path, 'git', ['log', '--all', '-F', `--grep=Task: ${task.id}`, '--format=%H%x09%s', '-n', '20'], 10_000);
    if (code === 0) {
      commits = out
        .split('\n')
        .map((l) => l.split('\t'))
        .filter(([sha]) => /^[0-9a-f]{40}$/.test(sha ?? ''))
        .map(([sha, subject]) => ({ sha, subject: subject ?? '' }));
    }
  }
  return {
    taskId: task.id,
    taskTitle: task.title,
    brief: task.brief ?? null,
    resultSummary: task.resultSummary ? clip(task.resultSummary, 4000) : null,
    commits,
    notes: notes ?? null,
  };
}

/** The job run's prompt — a fresh session every time, never `--resume`. */
export function jobPrompt(job: Job, repo: Repo, runNumber: number, previous: JobRun | null): string {
  const c = job.context;
  const lines = [
    `# Scheduled job: ${job.title}`,
    '',
    `You are running a scheduled check that was set up earlier${job.source === 'agent' ? ' by an agent after it shipped some work' : ''}. Repo: ${repo.name} (${repo.path}).`,
    job.repeatEveryMs ? `This is run ${runNumber}${job.maxRuns ? ` of at most ${job.maxRuns}` : ''} of a repeating job.` : '',
    '',
    '## Instructions',
    '',
    job.instructions,
  ];
  if (c && (c.taskId || c.notes || c.commits?.length)) {
    lines.push('', '## Context (snapshot taken when the job was created)', '');
    if (c.taskId) lines.push(`- Filed by task ${c.taskId}${c.taskTitle ? ` — “${c.taskTitle}”` : ''}`);
    if (c.brief) lines.push(`- Its brief: ${c.brief}`);
    if (c.resultSummary) lines.push('', 'What it reported when it finished:', '', c.resultSummary);
    if (c.commits?.length) {
      lines.push('', 'Its commits (find more with `git log --all --grep "Task: <id>"`):');
      for (const cm of c.commits) lines.push(`- ${cm.sha.slice(0, 12)} ${cm.subject}`);
    }
    if (c.notes) lines.push('', 'Notes:', '', c.notes);
  }
  if (previous) {
    lines.push('', `## Previous run (${previous.runNumber}, ${previous.verdict})`, '', previous.summary ?? previous.error ?? '(no summary)');
  }
  lines.push(
    '',
    '## Rules',
    '',
    '- OBSERVE ONLY. Read code, logs, metrics, alarms, dashboards, error rates (Bash is available: aws, gh, curl, the repo’s own scripts). Never change code, config, infrastructure or data — no commits, no deploys, no writes to any remote system. Anything that should change is a follow-up (below), filed as a draft for the human.',
    '- Nobody is at this terminal: do not ask questions; decide, and say what you assumed.',
    '- Up to 3 subagents per session, one at a time, and no parallel agent fan-outs. Never change the orchestrator’s concurrency.',
    '- verdict `ok` = all clear, nothing for the human; `attention` = the human should look (a regression, an alarm, an error rate up, the thing the instructions asked about is not true). If you could not check what was asked (no access, a tool missing), that is `attention` — say what was missing.',
    `- Follow-ups: at most ${JOB_FOLLOWUP_CAP}, only for concrete work; [] when none. The server files them as drafts.`,
  );
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

function writeReport(
  job: Job,
  jr: JobRun,
  r: { verdict: JobVerdict; summary: string | null; findings: JobFinding[]; error: string | null; followUpTaskIds: string[]; text: string | null },
): string {
  const dir = path.join(artifactsRoot, 'jobs', job.id);
  fs.mkdirSync(dir, { recursive: true });
  const rel = path.join('artifacts', 'jobs', job.id, `${jr.id}.md`);
  const md = [
    `# ${job.title} — run ${jr.runNumber}`,
    '',
    `- Verdict: **${r.verdict}**`,
    `- Started: ${jr.startedAt}`,
    `- Finished: ${new Date().toISOString()}`,
    '',
    r.summary ? `## Summary\n\n${r.summary}\n` : '',
    r.error ? `## Error\n\n${r.error}\n` : '',
    r.findings.length ? `## Findings\n\n${r.findings.map((f) => `- **${f.severity}** ${f.text}${f.evidence ? `\n  - evidence: ${f.evidence}` : ''}`).join('\n')}\n` : '',
    r.followUpTaskIds.length ? `## Follow-up drafts\n\n${r.followUpTaskIds.map((id) => `- ${id}`).join('\n')}\n` : '',
    r.text ? `## The agent’s final message\n\n${r.text}\n` : '',
  ]
    .filter(Boolean)
    .join('\n');
  fs.writeFileSync(path.join(dir, `${jr.id}.md`), redactSecrets(md));
  return rel;
}

/** a report path from the row, resolved under the artifacts dir only (never a request path) */
export function jobReportFile(reportPath: string): string | null {
  const abs = path.resolve(path.dirname(artifactsRoot), reportPath);
  return abs.startsWith(path.join(artifactsRoot, 'jobs') + path.sep) ? abs : null;
}

/**
 * One group per job (docs/grouping.md § Agent filings → Job follow-ups): a
 * follow-up joins the group of this job's previous follow-up while that group
 * is open (a human may have renamed it), else the open `Job: <title>` group,
 * else starts it. Job follow-ups are untrusted (source `job`), so they only
 * ever join groups of untrusted members.
 */
export async function fileJobFollowUp(storage: Storage, job: Job, input: NewTask): Promise<Task> {
  const ctx: FilerContext = { runId: null, filer: null, reach: await reachRepoIds(storage, job.repoId), untrusted: true };
  const prev = (await storage.listTasks({ repoIds: [...new Set([job.repoId, input.repoId ?? job.repoId])] }))
    .filter((t) => t.source === 'job' && t.sourceRef === job.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (prev) {
    const members = await storage.listTasks({ groupId: prev.groupId });
    if (members.length >= 2 || members.find((m) => m.id === prev.groupId)?.groupName) {
      if (members.some((m) => !TERMINAL_TASK_STATUSES.includes(m.status))) {
        const j = await serverJoin(storage, ctx, prev.groupId);
        if ('rootId' in j) {
          return createTask({ storage }, { ...input, parentId: j.rootId, groupDecision: { decision: 'joined', by: 'job' } }, 'job');
        }
      }
    }
  }
  const name = clip(`Job: ${oneLine(job.title)}`, GROUP_NAME_MAX);
  const { task } = await createTaskInNamedGroup({ storage }, { ...input, groupDecision: { decision: 'new', by: 'job' } }, 'job', {
    name,
    repoIds: [...new Set([...ctx.reach, input.repoId ?? job.repoId])],
    filerUntrusted: true,
  });
  return task;
}
