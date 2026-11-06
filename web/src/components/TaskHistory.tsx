import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildTaskHistory,
  historyTotals,
  type AuditEvent,
  type Dispatch,
  type HistoryStep,
  type HistoryStepKind,
  type Run,
  type Task,
  type TimelineSegment,
  type TimelineSegmentKind,
} from '@tm/shared';
import { api } from '../api.ts';
import { onTick } from '../clock.ts';
import { byId, historyEvent, historyRun, historySegments, mergeRows, type Rows } from '../taskHistory.ts';
import { onServerEvent, useApp } from '../state.tsx';
import { useIsMobile } from './Layout.tsx';
import { clock, relative, SEGMENT_COLOR, SEGMENT_LABEL, span } from './timeline/format.ts';

/**
 * The task panel's History tab (docs/timeline.md § The History tab): the
 * task's whole life as `buildTaskHistory` steps over `GET /api/tasks/:id/history`,
 * kept live from `event.appended` / `run.*` / `dispatch.updated` without a
 * refetch. Subscribed BEFORE the fetch and buffered until the answer (the
 * `useTimeline` pattern), so no row written while the read is in flight is
 * lost; everything is merged by id, so a row the answer already had is a no-op.
 *
 * The panel's one scroller moves the strip; nothing here scrolls vertically on
 * its own (a nested scroller breaks the phone sheet's drag).
 */

/** an open step's duration grows by this tick */
const TICK_MS = 10_000;

/** the short word on a step's chip */
const KIND_LABEL: Partial<Record<HistoryStepKind, string>> = {
  'stop-failure': 'error',
  'auto-compact': 'compact',
  transient: 'api error',
};

/** the timeline's colour for the steps a segment stands behind; the rest go by tone */
const KIND_SEGMENT: Partial<Record<HistoryStepKind, TimelineSegmentKind>> = {
  queued: 'queued',
  run: 'running',
  fix: 'fixing',
  waiting: 'waiting',
  review: 'review-round',
  checks: 'checks',
  landed: 'landed',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** steps whose `runId` is a terminal worth opening ('created' = the filing agent's run) */
const TERMINAL_KINDS: ReadonlySet<HistoryStepKind> = new Set<HistoryStepKind>(['run', 'fix', 'compact', 'review', 'question', 'created']);

const usd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : '<$0.01');

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1000) return `${Math.round(n / 1000)}k tok`;
  return `${n} tok`;
}

const stepKey = (s: HistoryStep) => `${s.kind}|${s.at}|${s.runId ?? ''}|${s.relatedTaskId ?? ''}`;

/** the step's label with what the panel knows better than the shared builder: turn numbers, the other task's title */
function stepLabel(s: HistoryStep, turn: number | undefined, title: (id: string) => string | undefined): string {
  let label = s.label;
  if (s.kind === 'dispatch' && s.relatedTaskId) {
    const t = title(s.relatedTaskId);
    if (t) label = label.replace(s.relatedTaskId.slice(0, 8), `“${t}”`);
  }
  if (turn !== undefined) label = `${label} · #${turn}`;
  return label;
}

function SegmentBar({ segments, from, to }: { segments: readonly TimelineSegment[]; from: number; to: number }) {
  const width = to - from;
  if (width <= 0) return null;
  const bars = segments.filter((s) => s.kind !== 'failed' && s.kind !== 'cancelled');
  if (!bars.length) return null;
  return (
    <div className="th-bar" role="img" aria-label="Time in each state, oldest on the left">
      {bars.map((s, i) => {
        const a = Math.max(from, Date.parse(s.start));
        const b = s.end === null ? to : Math.min(to, Date.parse(s.end));
        if (b <= a) return null;
        return (
          <span
            key={i}
            className={`th-bar-seg${s.end === null ? ' open' : ''}`}
            style={{ left: `${((a - from) / width) * 100}%`, width: `${((b - a) / width) * 100}%`, ['--k' as string]: SEGMENT_COLOR[s.kind] }}
            title={`${SEGMENT_LABEL[s.kind]} · ${span(b - a)}`}
          />
        );
      })}
    </div>
  );
}

function StepRow({
  step,
  label,
  now,
  mobile,
  open,
  onToggle,
  onOpenTerminal,
  onOpenTask,
}: {
  step: HistoryStep;
  label: string;
  now: number;
  mobile: boolean;
  open: boolean;
  onToggle: () => void;
  onOpenTerminal: (runId: string) => void;
  onOpenTask: (id: string) => void;
}) {
  const at = Date.parse(step.at);
  const live = step.end === null;
  const seg = KIND_SEGMENT[step.kind];
  const point = !live && step.durationMs === 0;
  const dur = step.durationMs !== null && !point ? span(step.durationMs) : live ? 'open' : null;
  const cost = step.costUsd !== null && step.costUsd > 0 ? usd(step.costUsd) : null;
  const tokens = step.tokens ? fmtTokens(step.tokens) : null;
  const when = new Date(at).toLocaleString();
  const terminal = step.runId && TERMINAL_KINDS.has(step.kind) ? step.runId : null;
  const related = step.kind === 'dispatch' && step.relatedTaskId ? step.relatedTaskId : null;
  const style = seg ? { ['--k' as string]: SEGMENT_COLOR[seg] } : undefined;
  const chip = (
    <span className={`th-chip th-tone-${step.tone}${seg ? ' th-seg' : ''}`} style={style}>
      {KIND_LABEL[step.kind] ?? step.kind}
    </span>
  );
  const actions = (terminal || related) && (
    <span className="th-actions">
      {terminal && (
        <button
          type="button"
          className="btn ghost th-btn"
          onClick={(e) => {
            e.stopPropagation();
            onOpenTerminal(terminal);
          }}
          title={step.kind === 'created' ? 'The terminal of the agent run that filed this task' : 'Open this run’s terminal'}
        >
          {step.kind === 'created' ? 'Filer’s terminal' : 'Terminal'}
        </button>
      )}
      {related && (
        <button
          type="button"
          className="btn ghost th-btn"
          onClick={(e) => {
            e.stopPropagation();
            onOpenTask(related);
          }}
        >
          Open task
        </button>
      )}
    </span>
  );
  const figures = [dur && (live ? `${dur}${step.durationMs !== null ? ' · live' : ''}` : dur), cost].filter(Boolean).join(' · ');

  if (mobile) {
    return (
      <li className={`th-step compact${open ? ' open' : ''}${live ? ' live' : ''}`}>
        <button type="button" className="th-row" aria-expanded={open} onClick={onToggle}>
          <time className="th-time" dateTime={step.at}>
            {clock(at, now)}
          </time>
          <span className={`th-dot th-tone-${step.tone}${seg ? ' th-seg' : ''}`} style={style} aria-hidden />
          <span className="th-label">{label}</span>
          {figures && <span className="th-figures">{figures}</span>}
        </button>
        {open && (
          <div className="th-more">
            <div className="th-more-line">
              {chip}
              <span className="muted">
                {relative(at, now)} · {when}
              </span>
            </div>
            {step.detail && <div className="th-detail">{step.detail}</div>}
            <div className="th-meta muted">
              {step.actor && <span>by {step.actor}</span>}
              {tokens && <span>{tokens}</span>}
            </div>
            {actions}
          </div>
        )}
      </li>
    );
  }

  return (
    <li className={`th-step${live ? ' live' : ''}`}>
      <time className="th-time" dateTime={step.at} title={`${when} (${relative(at, now)})`}>
        {clock(at, now)}
      </time>
      {chip}
      <div className="th-main">
        <div className="th-label">{label}</div>
        {(step.detail || step.actor) && (
          <div className="th-detail">
            {step.detail}
            {step.actor && <span className="th-actor"> {step.detail ? '· ' : ''}by {step.actor}</span>}
          </div>
        )}
      </div>
      <div className="th-nums">
        {dur && <span title={live ? 'still open' : undefined}>{live && step.durationMs !== null ? `${dur} · live` : dur}</span>}
        {cost && <span>{cost}</span>}
        {tokens && <span className="muted">{tokens}</span>}
      </div>
      {actions}
    </li>
  );
}

export function TaskHistory({
  task,
  onOpenTerminal,
  onOpenTask,
}: {
  task: Task;
  onOpenTerminal: (runId: string) => void;
  onOpenTask: (id: string) => void;
}) {
  const taskId = task.id;
  const { tasks } = useApp();
  const mobile = useIsMobile();
  const [rows, setRows] = useState<Rows | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    setOpen(new Set());
    // Subscribed BEFORE the fetch: what arrives while it is in flight waits
    // here and is merged after the answer (by id, so a duplicate is a no-op).
    let buffered: { events: AuditEvent[]; runs: Run[]; dispatches: Dispatch[] } | null = { events: [], runs: [], dispatches: [] };
    const off = onServerEvent((e) => {
      let add: { events?: AuditEvent[]; runs?: Run[]; dispatches?: Dispatch[] } | null = null;
      if (e.type === 'event.appended') {
        if (historyEvent(e.event, taskId)) add = { events: [e.event] };
      } else if (e.type === 'run.started' || e.type === 'run.updated' || e.type === 'run.exited') {
        if (historyRun(e.run, taskId)) add = { runs: [e.run] };
      } else if (e.type === 'dispatch.updated') {
        if (e.dispatch.fromTaskId === taskId || e.dispatch.toTaskId === taskId) add = { dispatches: [e.dispatch] };
      }
      if (!add) return;
      if (buffered) {
        buffered.events.push(...(add.events ?? []));
        buffered.runs.push(...(add.runs ?? []));
        buffered.dispatches.push(...(add.dispatches ?? []));
      } else {
        const a = add;
        setRows((r) => (r ? mergeRows(r, a) : r));
        setNow(Date.now());
      }
    });
    api
      .taskHistory(taskId)
      .then((res) => {
        if (cancelled) return;
        const pending = buffered!;
        buffered = null;
        setRows(mergeRows({ events: [...res.events].sort(byId), runs: res.runs, dispatches: res.dispatches, truncated: res.truncated }, pending));
        setNow(Date.now());
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        buffered = null;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      off();
    };
  }, [taskId, nonce]);

  const nowIso = new Date(now).toISOString();

  // The segments are the server's own fold re-run over the merged rows, so a
  // live row moves them exactly as a refetch would (docs/timeline.md § Segments).
  const segments = useMemo(() => (rows ? historySegments(rows, task, nowIso) : []), [rows, task, nowIso]);

  const history = useMemo(() => {
    if (!rows) return null;
    const steps = buildTaskHistory({ task, events: rows.events, runs: rows.runs, segments, dispatches: rows.dispatches, now: nowIso });
    return { steps, totals: historyTotals(steps, rows.runs, nowIso) };
  }, [rows, segments, nowIso, task]);

  const hasOpen = !!history?.steps.some((s) => s.end === null);
  useEffect(() => {
    if (!hasOpen) return;
    // the shared clock (src/clock.ts): one timer for the app, paused while hidden
    return onTick(TICK_MS, () => setNow(Date.now()));
  }, [hasOpen]);

  const titleOf = useCallback((id: string) => tasks.find((t) => t.id === id)?.title, [tasks]);
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (!history || !rows) {
    return (
      <div className="th">
        <div className="th-head muted">{error ? 'Could not read the history.' : 'Reading the history…'}</div>
        {error && (
          <>
            <div className="warn-text">{error}</div>
            <div>
              <button type="button" className="btn ghost th-btn" onClick={() => setNonce((n) => n + 1)}>
                Try again
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  const { steps, totals } = history;
  // the task row's figure is the truth (every run that ever wrote stats); the steps' sum is a hint when they differ
  const costDiffers = Math.abs(totals.costUsd - task.costUsd) >= 0.01;
  const attempts = Math.max(task.attempts, totals.attempts);
  // the bar spans what Wall time measures: the first step to the last end (now while one is open)
  const from = steps.length ? Date.parse(steps[0].at) : Date.parse(task.createdAt);
  // `clock` adds the date to a step not from today: the time column widens for it
  const today = new Date(now).toDateString();
  const dated = steps.some((s) => new Date(s.at).toDateString() !== today);
  const turnNo = new Map<HistoryStep, number>();
  let n = 0;
  for (const s of steps) if (s.kind === 'run' || s.kind === 'fix') turnNo.set(s, ++n);

  return (
    <div className="th">
      <dl className="th-totals">
        <div>
          <dt>Wall time</dt>
          <dd title={`From creation (${new Date(task.createdAt).toLocaleString()}) to the last step, or to now while one is open`}>{span(totals.wallMs)}</dd>
        </div>
        <div>
          <dt>Worked</dt>
          <dd>{span(totals.workedMs)}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd title={costDiffers ? `The task’s total is ${usd(task.costUsd)}; the runs listed here sum to ${usd(totals.costUsd)}.` : undefined}>
            {usd(task.costUsd)}
            {costDiffers && <span className="th-hint"> (steps {usd(totals.costUsd)})</span>}
          </dd>
        </div>
        <div>
          <dt>Attempts</dt>
          <dd>{attempts}</dd>
        </div>
      </dl>
      <SegmentBar segments={segments} from={from} to={from + totals.wallMs} />
      {rows.truncated && <div className="hint td-banner">This task has more history than one read returns: its oldest steps are incomplete.</div>}
      {error && <div className="warn-text">{error}</div>}
      {steps.length === 0 ? (
        <div className="muted">Nothing recorded yet.</div>
      ) : (
        <ol className={`th-steps${mobile ? ' compact' : ''}${dated ? ' dated' : ''}`}>
          {steps.map((s, i) => {
            const key = `${stepKey(s)}|${i}`;
            const k = stepKey(s);
            return (
              <StepRow
                key={key}
                step={s}
                label={stepLabel(s, turnNo.get(s), titleOf)}
                now={now}
                mobile={mobile}
                open={open.has(k)}
                onToggle={() => toggle(k)}
                onOpenTerminal={onOpenTerminal}
                onOpenTask={onOpenTask}
              />
            );
          })}
        </ol>
      )}
    </div>
  );
}
