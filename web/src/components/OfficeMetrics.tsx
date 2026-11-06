// Product metrics on /office (docs/office.md § Product metrics): every metric
// of the office with its sparkline (the panel), and a role's own metrics with
// the definition form (the role editor). A metric is a human-saved one-shot
// command the server runs on a cron with zero tokens; the number it prints as
// `TM_METRIC=<n>` is a point. Live: `office-metric.updated|deleted`.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  OFFICE_METRICS_MAX,
  OFFICE_METRIC_NAME_MAX,
  OFFICE_METRIC_UNIT_MAX,
  cronError,
  formatMetricValue,
  formatOfficeTime,
  metricThresholdText,
  nextCronSlot,
  roleSignalSources,
  type Office,
  type OfficeMetricBetter,
  type OfficeMetricInput,
  type OfficeMetricThresholdOp,
  type OfficeMetricWithPoints,
  type OfficeRole,
  type RepoCommand,
} from '@tm/shared';
import { api } from '../api.ts';
import { useArm } from '../arm.ts';
import { onServerEvent, useApp } from '../state.tsx';
import { toastError } from '../toast.ts';
import { useNow } from './TimeAgo.tsx';

/** The office's metrics, oldest first, kept live. */
export function useOfficeMetrics(officeId: string): { metrics: OfficeMetricWithPoints[] | null; error: string | null } {
  const [metrics, setMetrics] = useState<OfficeMetricWithPoints[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setMetrics(null);
    api.listOfficeMetrics(officeId).then(
      (l) => live && setMetrics(l),
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    const off = onServerEvent((e) => {
      if (e.type === 'office-metric.updated' && e.metric.officeId === officeId) {
        const m = e.metric;
        setMetrics((cur) => {
          const list = cur ?? [];
          return list.some((x) => x.id === m.id) ? list.map((x) => (x.id === m.id ? m : x)) : [...list, m];
        });
      } else if (e.type === 'office-metric.deleted' && e.officeId === officeId) {
        setMetrics((cur) => (cur ?? []).filter((x) => x.id !== e.metricId));
      }
    });
    return () => {
      live = false;
      off();
    };
  }, [officeId]);
  return { metrics, error };
}

/**
 * The metric's points as a polyline, the threshold as a dashed line, the last
 * point coloured by its side. Nothing to draw below two points.
 */
export function MetricSparkline({ metric, width = 120, height = 28 }: { metric: OfficeMetricWithPoints; width?: number; height?: number }) {
  const vals = metric.points.map((p) => p.value);
  if (vals.length < 2) return <span className="muted office-metric-nochart">{vals.length ? 'one point so far' : 'no points yet'}</span>;
  const withT = metric.thresholdValue !== null ? [...vals, metric.thresholdValue] : vals;
  const lo = Math.min(...withT);
  const hi = Math.max(...withT);
  const span = hi - lo || 1;
  const pad = 2;
  const y = (v: number) => (hi === lo ? height / 2 : pad + (1 - (v - lo) / span) * (height - 2 * pad));
  const xy = vals.map((v, i) => [pad + (i * (width - 2 * pad)) / (vals.length - 1), y(v)]);
  const last = xy[xy.length - 1];
  const label = `${metric.name}: ${vals.map((v) => formatMetricValue(v, metric.unit)).join(' → ')}`;
  return (
    <svg className={`office-metric-spark${metric.lastSide === 'breach' ? ' breach' : ''}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <title>{label}</title>
      {metric.thresholdValue !== null && <line className="threshold" x1={0} x2={width} y1={y(metric.thresholdValue)} y2={y(metric.thresholdValue)} />}
      <polyline points={xy.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ')} />
      <circle cx={last[0]} cy={last[1]} r={2.2} />
    </svg>
  );
}

function SideChip({ metric }: { metric: OfficeMetricWithPoints }) {
  if (metric.lastSide === 'breach') return <span className="chip office-metric-side breach">breach</span>;
  if (metric.lastSide === 'ok') return <span className="chip office-metric-side ok">ok</span>;
  return null;
}

function MetricLine({ office, metric, role, children }: { office: Office; metric: OfficeMetricWithPoints; role?: OfficeRole | null; children?: ReactNode }) {
  const now = useNow();
  const [running, setRunning] = useState(false);
  let next: number | null = null;
  try {
    next = nextCronSlot(metric.schedule, metric.lastRunAt ? Date.parse(metric.lastRunAt) : Date.parse(metric.createdAt), office.timezone);
  } catch {
    next = null;
  }
  const threshold = metricThresholdText(metric);
  const run = async () => {
    setRunning(true);
    try {
      const r = await api.runOfficeMetric(office.id, metric.id);
      if (r.error) toastError(new Error(r.error), `Measure ${metric.name}`);
    } catch (e) {
      toastError(e, `Measure ${metric.name}`);
    } finally {
      setRunning(false);
    }
  };
  return (
    <div className="office-metric">
      <div className="office-metric-head">
        {role && (
          <span className="office-avatar" aria-hidden>
            {role.avatar}
          </span>
        )}
        <span className="office-metric-name">{metric.name}</span>
        <span className="office-metric-value mono">{metric.lastValue === null ? '—' : formatMetricValue(metric.lastValue, metric.unit)}</span>
        <SideChip metric={metric} />
        <span style={{ flex: 1 }} />
        <MetricSparkline metric={metric} />
      </div>
      <div className="muted office-metric-meta">
        {threshold ? `breach when ${threshold}` : 'no threshold'} · better {metric.better} · <span className="mono">{metric.schedule}</span>
        {next !== null && !Number.isNaN(next) ? ` · next ${formatOfficeTime(next, now, office.timezone)}` : ''}
        {metric.lastAt ? ` · measured ${formatOfficeTime(Date.parse(metric.lastAt), now, office.timezone)}` : ''}
        {metric.breachedAt ? ` · in breach since ${formatOfficeTime(Date.parse(metric.breachedAt), now, office.timezone)}` : ''}
      </div>
      {metric.lastError && <div className="warn-text office-metric-meta">last run: {metric.lastError}</div>}
      <div className="office-actions">
        <button className="btn ghost" disabled={running} onClick={() => void run()}>
          {running ? 'Measuring…' : 'Measure now'}
        </button>
        {children}
      </div>
    </div>
  );
}

/** Every metric of the office (the /office panel). */
export function OfficeMetricsPanel({ office, roles }: { office: Office; roles: OfficeRole[] }) {
  const { metrics, error } = useOfficeMetrics(office.id);
  const byId = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);
  return (
    <div className="office-metrics">
      <div className="office-section-title">
        Product metrics <span className="muted">{metrics?.length ?? ''}</span>
      </div>
      {error && <div className="warn-text office-pad">{error}</div>}
      {metrics && metrics.length === 0 && (
        <div className="muted office-pad">No metrics yet — add one in a role's editor (a saved command that prints TM_METRIC=&lt;number&gt;).</div>
      )}
      {metrics?.map((m) => <MetricLine key={m.id} office={office} metric={m} role={byId.get(m.roleId) ?? null} />)}
    </div>
  );
}

/** The saved commands a metric may run — the server's `allowlistCheck`, read off the client's list. */
function measurable(c: RepoCommand, repoIds: readonly string[]): boolean {
  return !c.isCheck && !c.archivedAt && c.ownerTaskId === null && c.kind !== 'service' && repoIds.includes(c.repoId);
}

interface Draft {
  commandId: string;
  name: string;
  unit: string;
  better: OfficeMetricBetter;
  schedule: string;
  thresholdOp: OfficeMetricThresholdOp | '';
  thresholdValue: string;
}

const blankDraft = (): Draft => ({ commandId: '', name: '', unit: '', better: 'up', schedule: '0 9 * * *', thresholdOp: '', thresholdValue: '' });
const draftOf = (m: OfficeMetricWithPoints): Draft => ({
  commandId: m.commandId,
  name: m.name,
  unit: m.unit,
  better: m.better,
  schedule: m.schedule,
  thresholdOp: m.thresholdOp ?? '',
  thresholdValue: m.thresholdValue === null ? '' : String(m.thresholdValue),
});

function MetricForm({
  office,
  role,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  office: Office;
  role: OfficeRole;
  initial: Draft;
  submitLabel: string;
  onSubmit: (b: OfficeMetricInput) => Promise<void>;
  onCancel: () => void;
}) {
  const { commands, repos, workspaces } = useApp();
  const repoIds = workspaces.find((w) => w.id === office.workspaceId)?.repoIds ?? [];
  const eligible = commands.filter((c) => measurable(c, repoIds));
  const [d, setD] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<Draft>) => setD((cur) => ({ ...cur, ...p }));
  const tv = d.thresholdValue.trim() === '' ? null : Number(d.thresholdValue);
  const problems = [
    ...(!d.commandId ? ['pick a saved command'] : []),
    ...(!d.name.trim() ? ['name the metric'] : []),
    ...(cronError(d.schedule.trim()) ? [`schedule: ${cronError(d.schedule.trim())}`] : []),
    ...(d.thresholdOp !== '' && (tv === null || !Number.isFinite(tv)) ? ['the threshold needs a number'] : []),
    ...(d.thresholdOp === '' && tv !== null ? ['pick below / above for the threshold, or clear the number'] : []),
  ];
  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? id.slice(0, 8);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSubmit({
        roleId: role.id,
        commandId: d.commandId,
        name: d.name.trim(),
        unit: d.unit.trim(),
        better: d.better,
        schedule: d.schedule.trim(),
        thresholdOp: d.thresholdOp === '' ? null : d.thresholdOp,
        thresholdValue: d.thresholdOp === '' ? null : tv,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const stale = d.commandId !== '' && !eligible.some((c) => c.id === d.commandId);
  return (
    <div className="office-metric-form">
      <div className="form-grid">
        <div>
          <label className="label">Saved command (prints TM_METRIC=&lt;number&gt;)</label>
          <select className="field" value={d.commandId} onChange={(e) => set({ commandId: e.target.value })}>
            <option value="">pick a command…</option>
            {stale && <option value={d.commandId}>no longer eligible</option>}
            {eligible.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {repoName(c.repoId)}
              </option>
            ))}
          </select>
          {eligible.length === 0 && <div className="muted office-hint">No eligible commands: one-shot, saved by a human, not a check, in this workspace's repos.</div>}
        </div>
        <div>
          <label className="label">Name</label>
          <input className="field" value={d.name} maxLength={OFFICE_METRIC_NAME_MAX} placeholder="signup conversion" onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div>
          <label className="label">Unit</label>
          <input className="field" value={d.unit} maxLength={OFFICE_METRIC_UNIT_MAX} placeholder="%" onChange={(e) => set({ unit: e.target.value })} />
        </div>
        <div>
          <label className="label">Better</label>
          <select className="field" value={d.better} onChange={(e) => set({ better: e.target.value as OfficeMetricBetter })}>
            <option value="up">up</option>
            <option value="down">down</option>
          </select>
        </div>
        <div>
          <label className="label">Schedule (cron, {office.timezone})</label>
          <input className="field mono" value={d.schedule} onChange={(e) => set({ schedule: e.target.value })} />
        </div>
        <div>
          <label className="label">Breach when the value is</label>
          <div className="office-list-edit">
            <select className="field" value={d.thresholdOp} onChange={(e) => set({ thresholdOp: e.target.value as Draft['thresholdOp'] })}>
              <option value="">no threshold</option>
              <option value="below">below</option>
              <option value="above">above</option>
            </select>
            <input
              className="field"
              type="number"
              step="any"
              value={d.thresholdValue}
              disabled={d.thresholdOp === ''}
              onChange={(e) => set({ thresholdValue: e.target.value })}
            />
          </div>
        </div>
      </div>
      {(problems[0] || err) && <div className="warn-text office-gap">{err ?? problems[0]}</div>}
      <div className="office-actions office-gap">
        <button className="btn primary" disabled={busy || problems.length > 0} onClick={() => void submit()}>
          {submitLabel}
        </button>
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The role editor's section: this role's metrics, saved on their own (not by Save role). */
export function RoleMetrics({ office, role }: { office: Office; role: OfficeRole }) {
  const { metrics } = useOfficeMetrics(office.id);
  const arm = useArm();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const mine = (metrics ?? []).filter((m) => m.roleId === role.id);
  const subscribed = roleSignalSources(role).includes('metric');
  const full = (metrics?.length ?? 0) >= OFFICE_METRICS_MAX;
  const del = async (m: OfficeMetricWithPoints) => {
    try {
      await api.deleteOfficeMetric(office.id, m.id);
    } catch (e) {
      toastError(e, `Delete ${m.name}`);
    }
  };
  return (
    <div className="office-role-metrics">
      {!subscribed && mine.some((m) => m.thresholdOp !== null) && (
        <div className="muted office-hint">
          A crossing files a metric signal, but this role wakes on it only with a trigger "signal: metric" (Triggers above).
        </div>
      )}
      {metrics === null && <div className="muted">Loading…</div>}
      {metrics && mine.length === 0 && !adding && <div className="muted">No metrics for this role.</div>}
      {mine.map((m) =>
        editing === m.id ? (
          <MetricForm
            key={m.id}
            office={office}
            role={role}
            initial={draftOf(m)}
            submitLabel="Save metric"
            onCancel={() => setEditing(null)}
            onSubmit={async (b) => {
              await api.updateOfficeMetric(office.id, m.id, b);
              setEditing(null);
            }}
          />
        ) : (
          <MetricLine key={m.id} office={office} metric={m}>
            <button className="btn ghost" onClick={() => setEditing(m.id)}>
              Edit
            </button>
            <button className="btn ghost danger" onClick={() => arm.press(`del:${m.id}`) && void del(m)}>
              {arm.armed === `del:${m.id}` ? 'Delete? tap again' : 'Delete'}
            </button>
          </MetricLine>
        ),
      )}
      {adding ? (
        <MetricForm
          office={office}
          role={role}
          initial={blankDraft()}
          submitLabel="Add metric"
          onCancel={() => setAdding(false)}
          onSubmit={async (b) => {
            await api.createOfficeMetric(office.id, b);
            setAdding(false);
          }}
        />
      ) : (
        <button className="btn" disabled={full} title={full ? `at most ${OFFICE_METRICS_MAX} metrics per office` : undefined} onClick={() => setAdding(true)}>
          Add metric
        </button>
      )}
    </div>
  );
}
