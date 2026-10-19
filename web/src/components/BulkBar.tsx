import { useEffect, useState } from 'react';
import {
  EFFORT_LEVELS,
  MODEL_OPTIONS,
  type BulkAction,
  type BulkRequest,
  type EffortLevel,
  type Task,
} from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';

const ACTIONS: { id: Exclude<BulkAction, 'edit'>; label: string; title: string }[] = [
  { id: 'enqueue', label: 'Enqueue', title: 'Into the global queue (drafts, failed, cancelled, review)' },
  { id: 'queue', label: 'Add to queue', title: 'Into the one-at-a-time custom queue, in the order you ticked them' },
  { id: 'complete', label: 'Mark done', title: 'review → done' },
  { id: 'cancel', label: 'Cancel', title: 'Stop and cancel — a running agent is killed' },
];

/**
 * The board's multi-select bar (docs/inbox.md § Bulk actions). One call to
 * `POST /api/tasks/bulk` per action; the reply is per id, so a refusal names
 * its task and stays selected while everything that went through drops out
 * of the selection.
 */
export function BulkBar({
  ids,
  tasks,
  onSettled,
  onExit,
}: {
  /** selected ids, in the order they were ticked (Add to queue keeps it) */
  ids: string[];
  tasks: Task[];
  /** after a call: the refused ids, which stay selected (the rest drop out) */
  onSettled: (refused: string[]) => void;
  onExit: () => void;
}) {
  const { refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<{ text: string; refused: { title: string; error: string }[] } | null>(null);
  // Cancel kills running agents: a second press confirms, never a browser dialog
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  const n = ids.length;
  const send = async (b: BulkRequest) => {
    if (!b.ids.length || busy) return;
    setBusy(true);
    setReport(null);
    try {
      const r = await api.bulkTasks(b);
      const title = (id: string) => tasks.find((t) => t.id === id)?.title ?? id.slice(0, 8);
      const refused = r.results.filter((x) => !x.ok).map((x) => ({ title: title(x.id), error: x.ok ? '' : x.error }));
      setReport({
        text: `${r.ok} of ${r.results.length} ${verb(b.action)}${refused.length ? `, ${refused.length} refused` : ''}`,
        refused,
      });
      onSettled(r.results.filter((x) => !x.ok).map((x) => x.id));
      await refresh();
    } catch (e) {
      setReport({ text: (e as Error).message, refused: [] });
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

  return (
    <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
      <span className="bulk-count">{n ? `${n} selected` : 'Select tasks'}</span>
      {ACTIONS.map((a) =>
        a.id === 'cancel' ? (
          <button
            key={a.id}
            type="button"
            className={`btn${armed ? ' danger' : ''}`}
            disabled={busy || !n}
            title={a.title}
            onClick={() => (armed ? send({ action: 'cancel', ids }) : setArmed(true))}
          >
            {armed ? `Cancel ${n}?` : a.label}
          </button>
        ) : (
          <button
            key={a.id}
            type="button"
            className="btn"
            disabled={busy || !n}
            title={a.title}
            onClick={() => send({ action: a.id, ids })}
          >
            {a.label}
          </button>
        ),
      )}
      <select
        className="field bulk-select"
        aria-label="Set model"
        disabled={busy || !n}
        value=""
        onChange={(e) =>
          send({ action: 'edit', ids, patch: { model: e.target.value === '-' ? null : e.target.value } })
        }
      >
        <option value="" disabled>
          Model…
        </option>
        <option value="-">auto (router)</option>
        {MODEL_OPTIONS.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <select
        className="field bulk-select"
        aria-label="Set effort"
        disabled={busy || !n}
        value=""
        onChange={(e) =>
          send({
            action: 'edit',
            ids,
            patch: { effort: e.target.value === '-' ? null : (e.target.value as EffortLevel) },
          })
        }
      >
        <option value="" disabled>
          Effort…
        </option>
        <option value="-">default (config)</option>
        {EFFORT_LEVELS.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
      <span className="spacer" />
      <button type="button" className="btn ghost" onClick={onExit}>
        Done selecting
      </button>
      {report && (
        <div className="bulk-report" role="status">
          <span>{report.text}</span>
          {report.refused.map((r, i) => (
            <span key={i} className="warn-text">
              {r.title}: {r.error}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function verb(a: BulkAction): string {
  switch (a) {
    case 'enqueue':
      return 'enqueued';
    case 'queue':
      return 'added to the queue';
    case 'cancel':
      return 'cancelled';
    case 'complete':
      return 'marked done';
    case 'edit':
      return 'updated';
  }
}
