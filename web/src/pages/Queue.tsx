import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { compareClaimOrder, type Run } from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { IconTerminal } from '../components/Icons.tsx';
import { Elapsed } from '../components/RunMeta.tsx';
import { TaskRow } from '../components/TaskRow.tsx';
import { customQueueWaiting } from '../components/QueueMark.tsx';
import { KindBadge, runLink, runTitle } from '../components/RunKind.tsx';

export function QueuePage({ onOpenTerminal, onOpenTask }: { onOpenTerminal: (runId: string) => void; onOpenTask: (id: string) => void }) {
  const { runs, tasks, refresh } = useApp();
  const [err, setErr] = useState<string | null>(null);
  const active = runs.filter((r) => r.status === 'running' && !r.idle);
  const idle = runs.filter((r) => r.status === 'running' && r.idle);
  // Custom queue (docs/queue.md) first, in run order; the rest is the global queue.
  const custom = customQueueWaiting(tasks);
  // listed in the order the orchestrator claims them (docs/grouping.md § Order)
  const queued = tasks
    .filter((t) => t.status === 'queued' && !t.customQueueAt)
    .sort(compareClaimOrder(new Map(tasks.map((t) => [t.id, t]))));
  const navigate = useNavigate();
  // Workers and aux sessions (review, plan, chat, …) side by side: every one
  // is a terminal, told apart by its kind badge (docs/design.md § PTY sessions).
  const open = (r: Run) => {
    const link = runLink(r);
    if (!link) return;
    if ('taskId' in link) onOpenTask(link.taskId);
    else navigate(link.path);
  };

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
          <table className="tbl stack-tbl">
            <thead>
              <tr>
                <th>Task</th>
                <th>Kind</th>
                <th>Elapsed</th>
                <th>PID</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {active.map((r) => (
                <tr key={r.id}>
                  <td
                    data-label="Task"
                    style={{ fontWeight: 600, cursor: runLink(r) ? 'pointer' : undefined }}
                    onClick={() => open(r)}
                  >
                    {runTitle(r, tasks)}
                    {r.needsAttention && (
                      <span className="badge s-attention" style={{ marginLeft: 8 }}>
                        <span className="dot" /> needs attention
                      </span>
                    )}
                  </td>
                  <td data-label="Kind">
                    <KindBadge kind={r.kind} />{' '}
                    {r.model && <span className="chip">{r.model.replace('claude-', '')}</span>}
                  </td>
                  <td data-label="Elapsed">
                    <Elapsed since={r.startedAt} />
                    {r.stats && (
                      <span className="mono muted" style={{ marginLeft: 8 }}>
                        ${r.stats.costUsd.toFixed(3)} · ctx {Math.round(r.stats.contextPct)}%
                      </span>
                    )}
                  </td>
                  <td className="mono muted" data-label="PID">
                    {r.pid ?? '—'}
                  </td>
                  <td className="row-actions-cell" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn" onClick={() => onOpenTerminal(r.id)}>
                      <IconTerminal /> Terminal
                    </button>{' '}
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
              <div className="task-row" key={r.id} onClick={() => open(r)}>
                <span className="title">{runTitle(r, tasks)}</span>
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

      {custom.length > 0 && (
        <>
          <div className="section-head">
            Queue <span className="count">{custom.length}</span>
            <span className="muted" style={{ marginLeft: 8, fontWeight: 400 }}>
              one task at a time, runs even while the global queue is stopped
            </span>
          </div>
          <div className="panel">
            {custom.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                onOpenTask={onOpenTask}
                onOpenTerminal={onOpenTerminal}
                depth={t.parentId ? 1 : 0}
              />
            ))}
          </div>
        </>
      )}

      <div className="section-head">
        Global queue <span className="count">{queued.length}</span>
      </div>
      {queued.length === 0 ? (
        <div className="empty panel">Global queue is empty.</div>
      ) : (
        <div className="panel">
          {queued.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              onOpenTask={onOpenTask}
              onOpenTerminal={onOpenTerminal}
              depth={t.parentId ? 1 : 0}
            >
              <span className="mono muted">prio {t.priority}</span>
            </TaskRow>
          ))}
        </div>
      )}
    </div>
  );
}
