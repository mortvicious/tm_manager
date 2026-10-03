import { useMemo, useState } from 'react';
import {
  MODEL_OPTIONS,
  REPORT_LANGUAGES,
  REPORT_RANGE_PRESETS,
  type Report,
  type ReportLanguage,
  type ReportRangePreset,
} from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { fmtAgo, useNow } from '../components/TimeAgo.tsx';

/**
 * Reports (docs/reports.md): pick SEVERAL repos and a date range, and a
 * agent session turns the tasks that finished in that window into a concise
 * work-summary document — the one you hand to whoever paid for it — in Russian
 * or English, whichever the picker says.
 *
 * The create call answers 202 with a `pending` row; the document itself lands
 * over `/ws/events`, so nothing here polls and nothing waits on a request.
 */

/** Local `YYYY-MM-DD`, matching the server's own day keys (reports/range.ts). */
function todayKey(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDay(day: string): string {
  const [y, m, d] = day.split('-');
  return `${d}.${m}.${y}`;
}

function NewReportForm() {
  const { repos, settings } = useApp();
  const [selected, setSelected] = useState<string[]>([]);
  const [preset, setPreset] = useState<ReportRangePreset>('week');
  const [language, setLanguage] = useState<ReportLanguage>('ru');
  const [from, setFrom] = useState(todayKey(-6));
  const [to, setTo] = useState(todayKey());
  const [title, setTitle] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  // A custom range is the only one that can be wrong before it is sent; the
  // presets are resolved server-side against the server's clock.
  const rangeBad = preset === 'custom' && (!from || !to || from > to);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.createReport({
        repoIds: selected,
        preset,
        language,
        ...(preset === 'custom' ? { from, to } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(model ? { model } : {}),
      });
      setTitle('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const defaultModel = settings?.['analysis.model'] ?? '';

  return (
    <div className="panel" style={{ padding: 14, maxWidth: 900 }}>
      <div>
        <label className="label">Repos (pick one or more)</label>
        <div className="pick-row">
          {repos.map((r) => (
            <button
              key={r.id}
              className={`btn pick-btn${selected.includes(r.id) ? ' on' : ''}`}
              onClick={() => toggle(r.id)}
            >
              {r.name}
              {r.role ? ` · ${r.role}` : ''}
            </button>
          ))}
          {repos.length > 1 && (
            <button
              className="btn ghost pick-btn"
              onClick={() => setSelected(selected.length === repos.length ? [] : repos.map((r) => r.id))}
            >
              {selected.length === repos.length ? 'Clear' : 'All'}
            </button>
          )}
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <label className="label">Period</label>
        <div className="pick-row">
          {REPORT_RANGE_PRESETS.map((p) => (
            <button
              key={p.value}
              className={`btn pick-btn${preset === p.value ? ' on' : ''}`}
              onClick={() => setPreset(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <label className="label">Language of the document</label>
        <div className="pick-row">
          {REPORT_LANGUAGES.map((l) => (
            <button
              key={l.value}
              className={`btn pick-btn${language === l.value ? ' on' : ''}`}
              onClick={() => setLanguage(l.value)}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      {preset === 'custom' && (
        <div className="form-grid" style={{ marginTop: 12, maxWidth: 460 }}>
          <div>
            <label className="label">From</label>
            <input className="field" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="label">To</label>
            <input className="field" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
      )}

      <div className="form-grid" style={{ marginTop: 12 }}>
        <div>
          <label className="label">Title (optional — defaults to the repo names)</label>
          <input
            className="field"
            placeholder={selected.length ? repos.filter((r) => selected.includes(r.id)).map((r) => r.name).join(' + ') : 'neko'}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Model</label>
          <select className="field" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">default{defaultModel ? ` (${defaultModel})` : ''}</option>
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

      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
        <button className="btn primary" disabled={busy || selected.length === 0 || rangeBad} onClick={submit}>
          {busy ? 'Starting…' : 'Generate report'}
        </button>
        <span className="muted" style={{ fontSize: 'var(--tm-text-xs)' }}>
          {selected.length === 0
            ? 'Pick at least one repo.'
            : rangeBad
              ? 'The start date must not be after the end date.'
              : 'One agent (its own terminal, in Queue → Active sessions) reads the tasks that finished in the window — no repo is touched.'}
        </span>
      </div>
    </div>
  );
}

function ReportCard({ report, onClose }: { report: Report; onClose: () => void }) {
  const { repos } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const names = report.repoIds.map((id) => repos.find((r) => r.id === id)?.name ?? id).join(', ');

  const act = async (fn: () => Promise<unknown>, closeAfter = false) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      if (closeAfter) onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" style={{ padding: 14, marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div className="report-title">{report.title}</div>
        <span className={`chip report-status ${report.status}`}>{report.status}</span>
        <span className="chip">{names}</span>
        <span className="chip">
          {formatDay(report.fromDate)} — {formatDay(report.toDate)}
        </span>
        <span className="chip">{report.taskCount} tasks</span>
        <span className="chip">{report.language}</span>
        {report.model && <span className="chip">{report.model}</span>}
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={onClose}>
          Close
        </button>
      </div>

      {report.error && (
        <div className="warn-text" style={{ marginTop: 10 }}>
          {report.error}
        </div>
      )}
      {err && (
        <div className="warn-text" style={{ marginTop: 10 }}>
          {err}
        </div>
      )}

      {(report.status === 'pending' || report.status === 'running') && (
        <div className="empty" style={{ padding: 'var(--tm-space-5)' }}>
          <div className="big">Writing the document…</div>
          It lands here on its own — you can leave this page.
        </div>
      )}

      {report.markdown && (
        <div style={{ marginTop: 12 }}>
          <Markdown label="Document" text={report.markdown} />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {report.markdown && (
          <a className="btn" href={`/api/reports/${report.id}/markdown`} download>
            Download .md
          </a>
        )}
        <button
          className="btn"
          disabled={busy || report.status === 'pending' || report.status === 'running'}
          onClick={() => act(() => api.regenerateReport(report.id))}
        >
          Re-run
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn danger" disabled={busy} onClick={() => act(() => api.deleteReport(report.id), true)}>
          Delete
        </button>
      </div>
    </div>
  );
}

export function ReportsPage() {
  const { reports, repos } = useApp();
  const now = useNow();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = useMemo(() => reports.find((r) => r.id === openId) ?? null, [reports, openId]);

  return (
    <div>
      <h1 className="page-title">Reports</h1>

      {repos.length === 0 ? (
        <div className="empty panel">
          <div className="big">No repos registered</div>
          A report summarises the work of one or more repos — add a repo first.
        </div>
      ) : (
        <NewReportForm />
      )}

      {open && <ReportCard report={open} onClose={() => setOpenId(null)} />}

      <div className="panel" style={{ marginTop: 16 }}>
        {reports.length === 0 ? (
          <div className="empty">
            <div className="big">No reports yet</div>
            Pick the repos and a period above; the document is written for you.
          </div>
        ) : (
          reports.map((r) => (
            <div key={r.id} className="report-row" onClick={() => setOpenId(r.id === openId ? null : r.id)}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="report-title">{r.title}</div>
                <div className="report-sub">
                  {formatDay(r.fromDate)} — {formatDay(r.toDate)} · {r.repoIds.length} repo
                  {r.repoIds.length === 1 ? '' : 's'} · {r.taskCount} task{r.taskCount === 1 ? '' : 's'} · {r.language}
                  {r.summary ? ` · ${r.summary}` : ''}
                </div>
              </div>
              <span className={`chip report-status ${r.status}`}>{r.status}</span>
              <span className="muted" style={{ fontSize: 'var(--tm-text-xs)', whiteSpace: 'nowrap' }}>
                {fmtAgo(now - Date.parse(r.createdAt))}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
