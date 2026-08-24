import { useState } from 'react';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { IconTerminal } from '../components/Icons.tsx';
import { Elapsed } from '../components/RunMeta.tsx';

export function QueuePage({ onOpenTerminal, onOpenTask }: { onOpenTerminal: (runId: string) => void; onOpenTask: (id: string) => void }) {
  const { runs, tasks, refresh } = useApp();
  const [err, setErr] = useState<string | null>(null);
  const active = runs.filter((r) => r.status === 'running' && !r.idle);
  const idle = runs.filter((r) => r.status === 'running' && r.idle);
  const queued = tasks.filter((t) => t.status === 'queued');
  const taskOf = (taskId: string | null) => tasks.find((t) => t.id === taskId);

  const kill = async (id: string) => {
    if (!confirm('Kill this session?')) return;
    setErr(null);
    try {
      await api.killRun(id);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div>
      <h1 className="page-title">Queue</h1>
      {err && <div className="warn-text" style={{ marginBottom: 10 }}>{err}</div>}

      <div className="section-head">
        Active sessions <span className="count">{active.length}</span>
      </div>
      {active.length === 0 ? (
        <div className="empty panel">No live sessions.</div>
      ) : (
        <div className="panel">
          <table className="tbl">
            <thead>
              <tr>
                <th>Task</th>
                <th>Mode</th>
                <th>Elapsed</th>
                <th>PID</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {active.map((r) => (
                <tr key={r.id}>
                  <td
                    style={{ fontWeight: 600, cursor: r.taskId ? 'pointer' : undefined }}
                    onClick={() => r.taskId && onOpenTask(r.taskId)}
                  >
                    {taskOf(r.taskId)?.title ?? <span className="muted">({r.mode})</span>}
                    {r.needsAttention && (
                      <span className="badge s-attention" style={{ marginLeft: 8 }}>
                        <span className="dot" /> needs attention
                      </span>
                    )}
                  </td>
                  <td>
                    <span className="chip">{r.mode}</span>{' '}
                    {r.model && <span className="chip">{r.model.replace('claude-', '')}</span>}
                  </td>
                  <td>
                    <Elapsed since={r.startedAt} />
                    {r.stats && (
                      <span className="mono muted" style={{ marginLeft: 8 }}>
                        ${r.stats.costUsd.toFixed(3)} · ctx {Math.round(r.stats.contextPct)}%
                      </span>
                    )}
                  </td>
                  <td className="mono muted">{r.pid ?? '—'}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {r.mode === 'worker' && (
                      <>
                        <button className="btn" onClick={() => onOpenTerminal(r.id)}>
                          <IconTerminal /> Terminal
                        </button>{' '}
                      </>
                    )}
                    <button className="btn danger" onClick={() => kill(r.id)}>
                      Kill
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {idle.length > 0 && (
        <>
          <div className="section-head">
            Idle terminals <span className="count">{idle.length}</span>
          </div>
          <div className="panel">
            {idle.map((r) => (
              <div className="task-row" key={r.id} onClick={() => r.taskId && onOpenTask(r.taskId)}>
                <span className="title">{taskOf(r.taskId)?.title ?? `(${r.mode})`}</span>
                {r.stats && (
                  <span className="mono muted">
                    ${r.stats.costUsd.toFixed(3)} · ctx {Math.round(r.stats.contextPct)}%
                  </span>
                )}
                <button
                  className="btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenTerminal(r.id);
                  }}
                >
                  <IconTerminal /> Terminal
                </button>
                <button
                  className="btn danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    kill(r.id);
                  }}
                >
                  Close
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="section-head">
        Queued <span className="count">{queued.length}</span>
      </div>
      {queued.length === 0 ? (
        <div className="empty panel">Queue is empty.</div>
      ) : (
        <div className="panel">
          {queued.map((t) => (
            <div className="task-row" key={t.id} onClick={() => onOpenTask(t.id)}>
              <span className="title">{t.title}</span>
              <span className="mono muted">prio {t.priority}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
