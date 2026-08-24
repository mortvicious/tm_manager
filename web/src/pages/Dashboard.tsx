import { useEffect, useMemo, useRef, useState } from 'react';
import type { Anomaly, AuditEvent, StatsOverview } from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';

const fmtDuration = (ms: number) => {
  const h = Math.floor(ms / 3600_000);
  const m = Math.round((ms % 3600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

const fmtDay = (date: string) => date.slice(5).replace('-', '/');

/** Stacked worker/analyze bars. 2 series → legend + hover titles; direct label
 *  only on the busiest day (selective labeling per dataviz specs). */
function AgentsPerDay({ perDay }: { perDay: StatsOverview['perDay'] }) {
  const W = 440;
  const H = 120;
  const pad = { top: 14, bottom: 18, left: 4, right: 4 };
  const max = Math.max(1, ...perDay.map((d) => d.workerRuns + d.analyzeRuns));
  const bw = (W - pad.left - pad.right) / perDay.length;
  const busiest = perDay.reduce((a, b) => (b.workerRuns + b.analyzeRuns > a.workerRuns + a.analyzeRuns ? b : a), perDay[0]);
  return (
    <>
      <div className="legend">
        <span>
          <span className="swatch" style={{ background: 'var(--tm-chart-worker)' }} />
          workers
        </span>
        <span>
          <span className="swatch" style={{ background: 'var(--tm-chart-analyze)' }} />
          analysis
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} role="img" aria-label="Agent runs per day">
        {perDay.map((d, i) => {
          const total = d.workerRuns + d.analyzeRuns;
          const x = pad.left + i * bw + 1;
          const w = Math.max(2, bw - 4);
          const scale = (H - pad.top - pad.bottom) / max;
          const wh = d.workerRuns * scale;
          const ah = d.analyzeRuns * scale;
          const yTop = H - pad.bottom - wh - ah;
          return (
            <g key={d.date}>
              <title>{`${d.date}: ${d.workerRuns} worker, ${d.analyzeRuns} analysis`}</title>
              {ah > 0 && (
                <rect x={x} y={yTop} width={w} height={Math.max(1, ah - (wh > 0 ? 1 : 0))} rx={2} fill="var(--tm-chart-analyze)" />
              )}
              {wh > 0 && <rect x={x} y={H - pad.bottom - wh} width={w} height={wh} rx={2} fill="var(--tm-chart-worker)" />}
              {total > 0 && d === busiest && (
                <text x={x + w / 2} y={yTop - 4} textAnchor="middle" fontSize={9} fill="var(--tm-text-muted)" fontFamily="var(--tm-font-mono)">
                  {total}
                </text>
              )}
              {(i === 0 || i === perDay.length - 1 || i === Math.floor(perDay.length / 2)) && (
                <text x={x + w / 2} y={H - 5} textAnchor="middle" fontSize={8.5} fill="var(--tm-text-faint)" fontFamily="var(--tm-font-mono)">
                  {fmtDay(d.date)}
                </text>
              )}
            </g>
          );
        })}
        <line x1={pad.left} x2={W - pad.right} y1={H - pad.bottom} y2={H - pad.bottom} stroke="var(--tm-border)" strokeWidth={1} />
      </svg>
    </>
  );
}

/** Single-series cost bars — magnitude, one hue, no legend. */
function CostPerDay({ perDay }: { perDay: StatsOverview['perDay'] }) {
  const W = 440;
  const H = 120;
  const pad = { top: 14, bottom: 18, left: 4, right: 4 };
  const max = Math.max(0.01, ...perDay.map((d) => d.costUsd));
  const bw = (W - pad.left - pad.right) / perDay.length;
  const peak = perDay.reduce((a, b) => (b.costUsd > a.costUsd ? b : a), perDay[0]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} role="img" aria-label="Estimated cost per day">
      {perDay.map((d, i) => {
        const x = pad.left + i * bw + 1;
        const w = Math.max(2, bw - 4);
        const h = (d.costUsd / max) * (H - pad.top - pad.bottom);
        return (
          <g key={d.date}>
            <title>{`${d.date}: $${d.costUsd.toFixed(2)}`}</title>
            {h > 0.5 && <rect x={x} y={H - pad.bottom - h} width={w} height={h} rx={2} fill="var(--tm-chart-worker)" />}
            {d === peak && d.costUsd > 0 && (
              <text x={x + w / 2} y={H - pad.bottom - h - 4} textAnchor="middle" fontSize={9} fill="var(--tm-text-muted)" fontFamily="var(--tm-font-mono)">
                ${d.costUsd.toFixed(0)}
              </text>
            )}
            {(i === 0 || i === perDay.length - 1) && (
              <text x={x + w / 2} y={H - 5} textAnchor="middle" fontSize={8.5} fill="var(--tm-text-faint)" fontFamily="var(--tm-font-mono)">
                {fmtDay(d.date)}
              </text>
            )}
          </g>
        );
      })}
      <line x1={pad.left} x2={W - pad.right} y1={H - pad.bottom} y2={H - pad.bottom} stroke="var(--tm-border)" strokeWidth={1} />
    </svg>
  );
}

const KIND_LABEL: Record<string, string> = {
  'task.created': 'created task',
  'task.transition': 'moved task',
  'task.edited': 'edited task',
  'task.deleted': 'deleted task',
  'run.started': 'started agent',
  'run.killed': 'killed session',
  'run.attention': 'needs attention',
  'run.stats-final': 'session finished',
  'proposal.created': 'filed proposal',
  'proposal.decided': 'decided proposal',
  'repo.changed': 'changed repos',
  'config.changed': 'changed config',
  'orchestrator.toggle': 'toggled queue',
  'schedule.overflow-claim': 'overflow claim',
  'schedule.spawn-fail': 'spawn failed',
  'boot.recovery': 'boot recovery',
  'agent.create': 'agent filed task',
  'sentry.sync': 'sentry sync',
};

function describeEvent(e: AuditEvent, taskTitle: (id: string | null) => string | null): string {
  const base = KIND_LABEL[e.kind] ?? e.kind;
  const title = taskTitle(e.taskId);
  const d = (e.data ?? {}) as Record<string, unknown>;
  if (e.kind === 'task.transition') return `${d.from ?? '?'} → ${d.to ?? '?'}${title ? ` · ${title}` : ''}`;
  if (e.kind === 'config.changed') return `${base}: ${(d.keys as string[])?.join(', ') ?? ''}`;
  if (e.kind === 'sentry.sync') return `${base}: ${d.created ?? 0} new of ${d.fetched ?? 0}`;
  return title ? `${base} · ${title}` : base;
}

export function DashboardPage({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const { tasks, auditEvents } = useApp();
  const [overview, setOverview] = useState<StatsOverview | null>(null);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [feed, setFeed] = useState<AuditEvent[]>([]);
  const [days, setDays] = useState(14);
  const lastFetch = useRef(0);

  const load = async () => {
    lastFetch.current = Date.now();
    const [o, a, f] = await Promise.all([api.statsOverview(days), api.anomalies(), api.events(60)]);
    setOverview(o);
    setAnomalies(a);
    setFeed(f);
  };

  useEffect(() => {
    load().catch(() => {});
    // 60s visible-page interval; run.updated is deliberately NOT a trigger
    // (dashboard review A4) — live events below cover the rest.
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load().catch(() => {});
    }, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  // Throttled refetch on meaningful live events (≥15s apart). Depends on the
  // NEWEST event id, not array length — the cap-200 buffer keeps length
  // constant once full and would freeze the trigger (dashboard impl R3).
  const lastEventId = auditEvents[auditEvents.length - 1]?.id;
  useEffect(() => {
    if (!lastEventId) return;
    if (Date.now() - lastFetch.current > 15_000) load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEventId]);

  const mergedFeed = useMemo(() => {
    const seen = new Set(feed.map((e) => e.id));
    return [...auditEvents.filter((e) => !seen.has(e.id)).reverse(), ...feed].slice(0, 60);
  }, [feed, auditEvents]);

  const taskTitle = (id: string | null) => tasks.find((t) => t.id === id)?.title?.slice(0, 48) ?? null;

  if (!overview) return <div className="muted">Loading…</div>;
  const t = overview.totals;

  return (
    <div>
      <h1 className="page-title">
        Dashboard
        <span style={{ flex: 1 }} />
        <select className="field mono" style={{ width: 110 }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>7 days</option>
          <option value={14}>14 days</option>
          <option value={30}>30 days</option>
        </select>
      </h1>

      <div className="tiles">
        <div className="tile">
          <div className="label">Worked</div>
          <div className="value">{fmtDuration(t.workedMs)}</div>
          <div className="sub">{t.runs} runs</div>
        </div>
        <div className="tile">
          <div className="label">Cost</div>
          <div className="value">${t.costUsd.toFixed(2)}</div>
          <div className="sub">est. · {Math.round(t.tokens / 1000)}k tokens</div>
        </div>
        <div className="tile">
          <div className="label">Done / failed</div>
          <div className="value">
            {t.tasksDone}
            <span className="muted" style={{ fontSize: '0.6em' }}> / {t.tasksFailed}</span>
          </div>
          <div className="sub">{t.agentFiledTasks} agent-filed</div>
        </div>
        <div className="tile">
          <div className="label">Context</div>
          <div className="value">{t.avgCtxPct.toFixed(0)}%</div>
          <div className="sub">max {t.maxCtxPct.toFixed(0)}%</div>
        </div>
        <div className="tile">
          <div className="label">Attention</div>
          <div className="value">{t.attentionEvents}</div>
          <div className="sub">{t.overflowClaims} overflow claims</div>
        </div>
      </div>

      <div className="dash-grid">
        <div className="chart-card">
          <h3>Agents per day</h3>
          <div className="chart-sub">worker + analysis runs started</div>
          <div className="chart-body">
            <AgentsPerDay perDay={overview.perDay} />
          </div>
        </div>
        <div className="chart-card">
          <h3>Cost per day</h3>
          <div className="chart-sub">estimated from transcripts</div>
          <div className="chart-body">
            <CostPerDay perDay={overview.perDay} />
          </div>
        </div>

        <div className="chart-card">
          <h3>Anomalies</h3>
          <div className="chart-sub">{anomalies.length === 0 ? 'watching for stuck runs, cost spikes, stale reviews' : `${anomalies.length} finding(s)`}</div>
          {anomalies.length === 0 && (
            <div className="empty" style={{ padding: 'var(--tm-space-5)', margin: 'auto 0' }}>
              <div className="big">All clear</div>
              nothing needs your attention
            </div>
          )}
          {anomalies.slice(0, 12).map((a, i) => (
            <div className="anomaly-row" key={i} onClick={() => a.taskId && onOpenTask(a.taskId)}>
              <span className={`sev sev-${a.severity}`}>{a.severity}</span>
              <span style={{ minWidth: 0 }}>
                {a.message}
                {a.taskId && <span className="muted"> · {taskTitle(a.taskId) ?? a.taskId.slice(0, 8)}</span>}
              </span>
            </div>
          ))}
        </div>

        <div className="chart-card">
          <h3>Provenance & depth</h3>
          <div className="chart-sub">who files the work, how deep agent chains go</div>
          {overview.depth.map((d) => (
            <div key={d.depth} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
              <span className="mono muted" style={{ width: 58 }}>
                depth {d.depth}
              </span>
              <div
                style={{
                  height: 12,
                  borderRadius: 3,
                  background: 'var(--tm-chart-worker)',
                  width: `${Math.max(2, (d.count / Math.max(1, ...overview.depth.map((x) => x.count))) * 70)}%`,
                }}
              />
              <span className="mono muted">{d.count}</span>
            </div>
          ))}
          <div style={{ marginTop: 12 }}>
            {overview.byActor.slice(0, 6).map((a) => (
              <div key={a.actor} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                <span className="mono" style={{ color: 'var(--tm-accent)' }}>{a.actor}</span>
                <span className="mono muted">{a.events} events</span>
              </div>
            ))}
          </div>
        </div>

        <div className="chart-card">
          <h3>Per repo</h3>
          <div className="chart-sub">runs · cost · outcomes in the window</div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Repo</th>
                <th>Runs</th>
                <th>Cost</th>
                <th>Done</th>
                <th>Failed</th>
              </tr>
            </thead>
            <tbody>
              {overview.perRepo.map((r) => (
                <tr key={r.repoId}>
                  <td>{r.name}</td>
                  <td className="mono">{r.runs}</td>
                  <td className="mono">${r.costUsd.toFixed(2)}</td>
                  <td className="mono">{r.done}</td>
                  <td className="mono">{r.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="chart-card">
          <h3>Per model</h3>
          <div className="chart-sub">where the tokens go</div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Model</th>
                <th>Runs</th>
                <th>Cost</th>
                <th>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {overview.perModel.map((m) => (
                <tr key={m.model}>
                  <td className="mono">{m.model.replace('claude-', '')}</td>
                  <td className="mono">{m.runs}</td>
                  <td className="mono">${m.costUsd.toFixed(2)}</td>
                  <td className="mono">{Math.round(m.tokens / 1000)}k</td>
                </tr>
              ))}
              {overview.perModel.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">no runs in the window</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="chart-card" style={{ gridColumn: '1 / -1' }}>
          <h3>Activity</h3>
          <div className="chart-sub">the audit log — every mutation, with its actor (nothing untraced)</div>
          {mergedFeed.map((e) => (
            <div className="feed-row" key={e.id}>
              <span className="when">{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
              <span className="actor" title={e.actor}>{e.actor}</span>
              <span className="what">{describeEvent(e, taskTitle)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
