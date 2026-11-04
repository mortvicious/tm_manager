import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  EFFORT_LEVELS,
  MODEL_OPTIONS,
  formatDuration,
  isJobDue,
  jobHoldText,
  jobRunNeedsHuman,
  roughDuration,
  type Job,
  type JobRun,
  type JobScheduleInput,
} from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { useIsMobile } from '../components/Layout.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { fmtAgo, useNow } from '../components/TimeAgo.tsx';
import { useWorkspace } from '../workspace.ts';

/**
 * Scheduled jobs (docs/jobs.md): a deferred check — "look at the error rates
 * in 7 days" — in its own queue. The server fires a due job by itself as a
 * read-only-ish aux terminal once fewer than `jobs.maxActiveTasks` tasks are
 * running or waiting; each run ends in a verdict, findings and a report.
 *
 * `?job=<id>` opens the detail (Inbox, push and Telegram links land there);
 * a phone gets the detail and the new-job form as `<Sheet>`s.
 */

type Props = { onOpenTask: (id: string) => void; onOpenTerminal: (runId: string) => void };

const SECTION_ORDER = ['due', 'running', 'scheduled', 'paused', 'finished'] as const;
type Section = (typeof SECTION_ORDER)[number];
const SECTION_LABEL: Record<Section, string> = {
  due: 'Due',
  running: 'Running',
  scheduled: 'Scheduled',
  paused: 'Paused',
  finished: 'Done & cancelled',
};

function sectionOf(j: Job, now: number): Section {
  if (j.status === 'running') return 'running';
  if (j.status === 'paused') return 'paused';
  if (j.status === 'done' || j.status === 'cancelled') return 'finished';
  return isJobDue(j, now) ? 'due' : 'scheduled';
}

function when(iso: string | null, now: number): string {
  if (!iso) return '—';
  const d = Date.parse(iso) - now;
  const rel = Math.abs(d) < 60_000 ? 'now' : d > 0 ? `in ${roughDuration(d)}` : `${roughDuration(-d)} overdue`;
  return `${rel} · ${new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
}

function repeatText(j: Pick<Job, 'repeatEveryMs' | 'maxRuns' | 'repeatUntil' | 'runsCount'>): string | null {
  if (!j.repeatEveryMs) return null;
  const parts = [`every ${formatDuration(j.repeatEveryMs)}`];
  if (j.maxRuns) parts.push(`${j.runsCount}/${j.maxRuns} runs`);
  if (j.repeatUntil) parts.push(`until ${new Date(j.repeatUntil).toLocaleDateString()}`);
  return parts.join(' · ');
}

export function VerdictChip({ verdict }: { verdict: Job['lastVerdict'] }) {
  if (!verdict) return null;
  return <span className={`chip job-verdict ${verdict}`}>{verdict}</span>;
}

/** run-at / delay / repeat fields; empty = the server's own default (none for create) */
function ScheduleFields({ value, onChange }: { value: ScheduleDraft; onChange: (v: ScheduleDraft) => void }) {
  const set = (p: Partial<ScheduleDraft>) => onChange({ ...value, ...p });
  return (
    <div className="form-grid job-schedule">
      <div>
        <label className="label">When</label>
        <div className="pick-row">
          <button className={`btn pick-btn${value.mode === 'delay' ? ' on' : ''}`} onClick={() => set({ mode: 'delay' })}>
            After a delay
          </button>
          <button className={`btn pick-btn${value.mode === 'at' ? ' on' : ''}`} onClick={() => set({ mode: 'at' })}>
            At a time
          </button>
        </div>
      </div>
      <div>
        {value.mode === 'delay' ? (
          <>
            <label className="label">Delay (e.g. 3d, 12h, 1w 2d)</label>
            <input className="field" value={value.delay} placeholder="3d" onChange={(e) => set({ delay: e.target.value })} />
          </>
        ) : (
          <>
            <label className="label">Run at</label>
            <input className="field" type="datetime-local" value={value.runAt} onChange={(e) => set({ runAt: e.target.value })} />
          </>
        )}
      </div>
      <div>
        <label className="label">Repeat every (optional, ≥ 1h)</label>
        <input className="field" value={value.every} placeholder="one-shot" onChange={(e) => set({ every: e.target.value })} />
      </div>
      {value.every.trim() && (
        <>
          <div>
            <label className="label">Max runs (optional)</label>
            <input
              className="field"
              type="number"
              min={1}
              max={100}
              value={value.maxRuns}
              onChange={(e) => set({ maxRuns: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Until (optional)</label>
            <input className="field" type="date" value={value.until} onChange={(e) => set({ until: e.target.value })} />
          </div>
        </>
      )}
    </div>
  );
}

interface ScheduleDraft {
  mode: 'delay' | 'at';
  delay: string;
  runAt: string;
  every: string;
  maxRuns: string;
  until: string;
}

const EMPTY_SCHEDULE: ScheduleDraft = { mode: 'delay', delay: '3d', runAt: '', every: '', maxRuns: '', until: '' };

/** `datetime-local` value of an ISO time, in local time */
function localInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function scheduleInput(s: ScheduleDraft): JobScheduleInput {
  const every = s.every.trim();
  return {
    ...(s.mode === 'delay' ? { delay: s.delay.trim() || null } : { runAt: s.runAt ? new Date(s.runAt).toISOString() : null }),
    repeat: every
      ? {
          every,
          maxRuns: s.maxRuns ? Number(s.maxRuns) : null,
          until: s.until ? new Date(`${s.until}T23:59:59`).toISOString() : null,
        }
      : null,
  };
}

function scheduleOf(j: Job): ScheduleDraft {
  return {
    mode: 'at',
    delay: '',
    runAt: localInput(j.nextRunAt),
    every: j.repeatEveryMs ? formatDuration(j.repeatEveryMs) : '',
    maxRuns: j.maxRuns ? String(j.maxRuns) : '',
    until: j.repeatUntil ? localInput(j.repeatUntil).slice(0, 10) : '',
  };
}

function NewJobForm({ onDone }: { onDone: (job: Job | null) => void }) {
  const { repos, settings } = useApp();
  const { repoIds } = useWorkspace();
  const inScope = repos.filter((r) => !repoIds || repoIds.has(r.id));
  const [repoId, setRepoId] = useState(inScope[0]?.id ?? repos[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [schedule, setSchedule] = useState<ScheduleDraft>(EMPTY_SCHEDULE);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const job = await api.createJob({ repoId, title: title.trim(), instructions, model: model || null, ...scheduleInput(schedule) });
      onDone(job);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="job-form">
      <div className="form-grid">
        <div>
          <label className="label">Repo (the run's working directory)</label>
          <select className="field" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Title</label>
          <input className="field" value={title} maxLength={80} placeholder="Check signup error rate" onChange={(e) => setTitle(e.target.value)} />
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <label className="label">What to check, and what counts as a problem</label>
        <textarea
          className="field"
          rows={6}
          value={instructions}
          placeholder="Read the last 7 days of Sentry issues for the signup flow; anything above 1% of sessions is a problem."
          onChange={(e) => setInstructions(e.target.value)}
        />
      </div>
      <div style={{ marginTop: 12 }}>
        <ScheduleFields value={schedule} onChange={setSchedule} />
      </div>
      <div className="form-grid" style={{ marginTop: 12 }}>
        <div>
          <label className="label">Model</label>
          <select className="field" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">default ({String(settings?.['jobs.model'] ?? '')})</option>
            {MODEL_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </div>
      {err && (
        <div className="warn-text" style={{ marginTop: 8 }}>
          {err}
        </div>
      )}
      <div className="job-actions">
        <button className="btn primary" disabled={busy || !repoId || !title.trim() || !instructions.trim()} onClick={submit}>
          {busy ? 'Scheduling…' : 'Schedule job'}
        </button>
        <button className="btn ghost" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function RunReport({ jobId, runId }: { jobId: string; runId: string }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.jobReport(jobId, runId).then(setText, (e: Error) => setErr(e.message));
  }, [jobId, runId]);
  if (err) return <div className="warn-text">{err}</div>;
  if (text === null) return <div className="muted">Loading…</div>;
  return <Markdown label="Job report" text={text} />;
}

function RunRow({ job, run, onOpenTask, onOpenTerminal }: { job: Job; run: JobRun } & Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const now = useNow();
  return (
    <div className="job-run">
      <div className="job-run-head" onClick={() => setOpen(!open)}>
        <span className="job-run-n">#{run.runNumber}</span>
        {run.endedAt ? <VerdictChip verdict={run.verdict} /> : <span className="chip job-verdict running">running</span>}
        <span className="job-run-sum">{run.summary ?? run.error ?? (run.endedAt ? '' : 'working…')}</span>
        <span className="muted job-run-meta">
          {run.costUsd != null ? `$${run.costUsd.toFixed(2)} · ` : ''}
          {fmtAgo(now - Date.parse(run.startedAt))}
        </span>
      </div>
      {open && (
        <div className="job-run-body">
          {run.findings.length > 0 && (
            <ul className="job-findings">
              {run.findings.map((f, i) => (
                <li key={i} className={`job-finding ${f.severity}`}>
                  <span className="chip">{f.severity}</span> {f.text}
                  {f.evidence && <div className="muted job-evidence">{f.evidence}</div>}
                </li>
              ))}
            </ul>
          )}
          {run.followUpTaskIds.length > 0 && (
            <div className="job-followups">
              Follow-up drafts:{' '}
              {run.followUpTaskIds.map((id) => (
                <button key={id} className="btn ghost sm" onClick={() => onOpenTask(id)}>
                  {id.slice(0, 8)}
                </button>
              ))}
            </div>
          )}
          {run.reportPath && <RunReport jobId={job.id} runId={run.id} />}
          <div className="job-actions">
            {run.runId && (
              <button className="btn sm" onClick={() => onOpenTerminal(run.runId!)}>
                Terminal
              </button>
            )}
            {jobRunNeedsHuman(run) && (
              <button
                className="btn sm"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  api.ackJob(job.id, run.id).finally(() => setBusy(false));
                }}
              >
                Acknowledge
              </button>
            )}
            <span className="muted">fired by {run.firedBy}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function JobDetail({ job, onClose, onOpenTask, onOpenTerminal }: { job: Job; onClose: () => void } & Props) {
  const { repos, jobRuns } = useApp();
  const now = useNow();
  const [runs, setRuns] = useState<JobRun[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(job.title);
  const [instructions, setInstructions] = useState(job.instructions);
  const [schedule, setSchedule] = useState<ScheduleDraft>(() => scheduleOf(job));
  const [model, setModel] = useState(job.model ?? '');
  const [effort, setEffort] = useState(job.effort ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // re-read the history when the job moves (a run started or settled)
  useEffect(() => {
    let live = true;
    api.getJob(job.id).then((r) => live && setRuns(r.runs), (e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [job.id, job.updatedAt, job.status]);

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      after?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    act(
      () =>
        api.updateJob(job.id, {
          title: title.trim(),
          instructions,
          model: model || null,
          effort: effort || null,
          // only a changed schedule is sent: resending it would re-plan the job
          ...(JSON.stringify(schedule) !== JSON.stringify(scheduleOf(job)) ? { schedule: scheduleInput(schedule) } : {}),
        }),
      () => setEditing(false),
    );

  const repo = repos.find((r) => r.id === job.repoId);
  const live = job.status === 'scheduled' || job.status === 'paused';
  const open = jobRuns.filter((r) => r.jobId === job.id);
  const ctx = job.context;

  return (
    <div className="job-detail">
      <div className="job-detail-head">
        <div className="job-detail-title">{job.title}</div>
        <span className={`chip job-status ${job.status}`}>{job.status}</span>
        <VerdictChip verdict={job.lastVerdict} />
      </div>
      <div className="job-sub">
        {repo?.name ?? job.repoId} · {job.status === 'scheduled' || job.status === 'paused' ? `next ${when(job.nextRunAt, now)}` : job.status}
        {repeatText(job) ? ` · ${repeatText(job)}` : ''} · {job.runsCount} run{job.runsCount === 1 ? '' : 's'} · by {job.source}
        {job.model ? ` · ${job.model}` : ''}
      </div>
      {ctx?.taskId && (
        <div className="job-sub">
          Scheduled by task{' '}
          <button className="btn ghost sm" onClick={() => onOpenTask(ctx.taskId!)}>
            {ctx.taskTitle ?? ctx.taskId.slice(0, 8)}
          </button>
        </div>
      )}
      {err && <div className="warn-text">{err}</div>}

      <div className="job-actions">
        <button className="btn primary" disabled={busy || job.status === 'running' || job.status === 'cancelled'} onClick={() => act(() => api.runJob(job.id))}>
          Run now
        </button>
        {job.status === 'paused' ? (
          <button className="btn" disabled={busy} onClick={() => act(() => api.resumeJob(job.id))}>
            Resume
          </button>
        ) : (
          <button className="btn" disabled={busy || job.status !== 'scheduled'} onClick={() => act(() => api.pauseJob(job.id))}>
            Pause
          </button>
        )}
        <button className="btn" disabled={busy || job.status === 'running'} onClick={() => setEditing(!editing)}>
          {editing ? 'Stop editing' : 'Edit'}
        </button>
        {open.length > 0 && (
          <button className="btn" disabled={busy} onClick={() => act(() => api.ackJob(job.id, null))}>
            Acknowledge all
          </button>
        )}
        <span style={{ flex: 1 }} />
        {live && (
          <button className="btn" disabled={busy} onClick={() => act(() => api.cancelJob(job.id))}>
            Cancel job
          </button>
        )}
        <button className="btn danger" disabled={busy} onClick={() => act(() => api.deleteJob(job.id), onClose)}>
          Delete
        </button>
      </div>

      {editing ? (
        <div className="job-form">
          <label className="label">Title</label>
          <input className="field" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
          <label className="label" style={{ marginTop: 10 }}>
            Instructions
          </label>
          <textarea className="field" rows={8} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          <div style={{ marginTop: 10 }}>
            <ScheduleFields value={schedule} onChange={setSchedule} />
          </div>
          <div className="form-grid" style={{ marginTop: 10 }}>
            <div>
              <label className="label">Model</label>
              <select className="field" value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">default</option>
                {MODEL_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Effort</label>
              <select className="field" value={effort} onChange={(e) => setEffort(e.target.value)}>
                <option value="">default</option>
                {EFFORT_LEVELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="job-actions">
            <button className="btn primary" disabled={busy || !title.trim() || !instructions.trim()} onClick={save}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="job-instructions">
          <Markdown label="Instructions" text={job.instructions} />
          {ctx?.notes && <div className="muted job-notes">{ctx.notes}</div>}
        </div>
      )}

      <div className="job-runs-title">Runs</div>
      {runs === null ? (
        <div className="muted">Loading…</div>
      ) : runs.length === 0 ? (
        <div className="muted">Not fired yet.</div>
      ) : (
        runs.map((r) => <RunRow key={r.id} job={job} run={r} onOpenTask={onOpenTask} onOpenTerminal={onOpenTerminal} />)
      )}
    </div>
  );
}

export function JobRow({ job, now, onClick, extra }: { job: Job; now: number; onClick: () => void; extra?: ReactNode }) {
  const { repos } = useApp();
  const repo = repos.find((r) => r.id === job.repoId);
  const rep = repeatText(job);
  return (
    <div className="job-row" onClick={onClick}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="job-title">{job.title}</div>
        <div className="job-sub">
          {repo?.name ?? job.repoId}
          {job.status === 'scheduled' || job.status === 'paused' ? ` · ${when(job.nextRunAt, now)}` : ''}
          {rep ? ` · ${rep}` : ''}
          {job.lastSummary ? ` · ${job.lastSummary}` : ''}
        </div>
        {extra}
      </div>
      <VerdictChip verdict={job.lastVerdict} />
      {job.status === 'running' && <span className="chip job-status running">running</span>}
    </div>
  );
}

export function JobsPage({ onOpenTask, onOpenTerminal }: Props) {
  const { jobs, orch } = useApp();
  const { repoIds } = useWorkspace();
  const mobile = useIsMobile();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const openId = params.get('job');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const status = orch.jobs;

  const setOpen = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('job', id);
    else next.delete('job');
    setParams(next, { replace: !!id === !!openId });
  };

  const scoped = useMemo(() => jobs.filter((j) => !repoIds || repoIds.has(j.repoId)), [jobs, repoIds]);
  const sections = useMemo(() => {
    const by = new Map<Section, Job[]>();
    for (const j of scoped) {
      const s = sectionOf(j, now);
      by.set(s, [...(by.get(s) ?? []), j]);
    }
    for (const [s, list] of by) {
      if (s === 'finished') list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      else list.sort((a, b) => (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''));
    }
    return by;
  }, [scoped, now]);
  const open = openId ? (jobs.find((j) => j.id === openId) ?? null) : null;
  const hold = status?.hold ? jobHoldText(status.hold, status) : null;

  const toggle = async () => {
    if (!status) return;
    setBusy(true);
    setErr(null);
    try {
      await api.toggleJobs(!status.enabled);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const detail = open && (
    <JobDetail key={open.id} job={open} onClose={() => setOpen(null)} onOpenTask={onOpenTask} onOpenTerminal={onOpenTerminal} />
  );
  const form = <NewJobForm onDone={(j) => (setCreating(false), j && setOpen(j.id))} />;

  return (
    <div>
      <h1 className="page-title">Jobs</h1>

      <div className="panel job-switch">
        <div className="job-switch-toggle">
          <span
            className={`switch ${status?.enabled ? 'on' : ''}`}
            role="switch"
            aria-checked={!!status?.enabled}
            aria-disabled={busy || !status}
            tabIndex={0}
            onClick={() => !busy && void toggle()}
            onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), !busy && void toggle())}
          >
            <span className="track">
              <span className="knob" />
            </span>
          </span>
          <span>{status?.enabled ? 'Jobs queue on' : 'Jobs queue off'}</span>
        </div>
        <span className="muted job-switch-text">
          {status
            ? `Fires when ${status.maxActiveTasks ? `fewer than ${status.maxActiveTasks}` : 'any number of'} tasks are active (now ${status.activeTasks})` +
              (status.running ? ` · ${status.running} running` : '') +
              (status.due ? ` · ${status.due} due${hold ? ` — waiting: ${hold}` : ''}` : '')
            : 'Loading…'}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={() => setCreating(true)}>
          New job
        </button>
      </div>
      {err && <div className="warn-text">{err}</div>}

      {creating && !mobile && <div className="panel job-panel">{form}</div>}
      {creating && mobile && (
        <Sheet label="New job" title="New job" onClose={() => setCreating(false)} disableDrag tall>
          {form}
        </Sheet>
      )}

      {open && !mobile && (
        <div className="panel job-panel">
          <div className="job-close">
            <button className="btn ghost" onClick={() => setOpen(null)}>
              Close
            </button>
          </div>
          {detail}
        </div>
      )}
      {open && mobile && (
        <Sheet label={open.title} onClose={() => setOpen(null)} tall>
          {detail}
        </Sheet>
      )}

      {scoped.length === 0 ? (
        <div className="empty panel" style={{ marginTop: 16 }}>
          <div className="big">No scheduled jobs</div>
          A job is a check that must happen later — "read the error rates in 7 days". Agents schedule them when they ship; you can
          too.
        </div>
      ) : (
        SECTION_ORDER.filter((s) => sections.get(s)?.length).map((s) => (
          <div key={s} className="panel job-section">
            <div className="job-section-title">
              {SECTION_LABEL[s]} <span className="muted">{sections.get(s)!.length}</span>
            </div>
            {sections.get(s)!.map((j) => (
              <JobRow
                key={j.id}
                job={j}
                now={now}
                onClick={() => setOpen(j.id === openId ? null : j.id)}
                extra={s === 'due' && hold ? <div className="job-hold">overdue — {hold}</div> : undefined}
              />
            ))}
          </div>
        ))
      )}
    </div>
  );
}
