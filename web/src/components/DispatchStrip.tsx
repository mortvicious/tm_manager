import { useState, type MouseEvent } from 'react';
import type { Dispatch } from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { fmtAgo, useNow } from './TimeAgo.tsx';

/**
 * Compact list of the dispatches touching one task (docs/dispatch.md):
 * agent-to-agent messages delivered by resuming the target's own session.
 * `direction 'in'` (the board strip) shows only what was sent TO this task;
 * `'both'` (the task panel) shows sent and received, direction-marked.
 * `full` renders whole messages instead of one ellipsised line.
 */
export function DispatchStrip({
  taskId,
  direction = 'in',
  full = false,
  limit,
  pendingOnly = false,
  onOpenTask,
}: {
  taskId: string;
  direction?: 'in' | 'both';
  full?: boolean;
  /** cap the rows shown (board compactness); a "+n more" hint carries the rest */
  limit?: number;
  /** essentials mode: only what still needs to happen */
  pendingOnly?: boolean;
  onOpenTask?: (id: string) => void;
}) {
  const { dispatches, tasks, refresh } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const now = useNow();

  const mine = dispatches
    .filter((d) => d.toTaskId === taskId || (direction === 'both' && d.fromTaskId === taskId))
    .filter((d) => !pendingOnly || d.status === 'pending')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  if (mine.length === 0) return null;
  const shown = limit ? mine.slice(0, limit) : mine;

  const titleOf = (id: string) => tasks.find((t) => t.id === id)?.title ?? `${id.slice(0, 8)}… (deleted)`;

  const cancel = async (e: MouseEvent, d: Dispatch) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(d.id);
    try {
      await api.cancelDispatch(d.id);
      await refresh();
    } catch {
      // already settled — the refresh below the WS event will show it
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dispatch-strip" onClick={(e) => e.stopPropagation()}>
      {shown.map((d) => {
        const incoming = d.toTaskId === taskId;
        const peer = incoming ? d.fromTaskId : d.toTaskId;
        return (
          <div key={d.id} className={`dispatch-row ${d.status} ${full ? 'full' : ''}`}>
            <span className="dispatch-dir" title={incoming ? 'dispatched to this task' : 'dispatched by this task'}>
              {incoming ? '⇠' : '⇢'}
            </span>
            <button
              className="dispatch-peer"
              title={onOpenTask ? 'Open the other task' : titleOf(peer)}
              disabled={!onOpenTask}
              onClick={() => onOpenTask?.(peer)}
            >
              {titleOf(peer)}
            </button>
            <span className="dispatch-msg" title={full ? undefined : d.message}>
              {d.message}
            </span>
            <span className="dispatch-status" title={d.note ?? undefined}>
              {d.status}
            </span>
            <span
              className="age"
              title={`sent ${new Date(d.createdAt).toLocaleString()}${d.deliveredAt ? `\ndelivered ${new Date(d.deliveredAt).toLocaleString()}` : ''}`}
            >
              {fmtAgo(now - Date.parse(d.deliveredAt ?? d.createdAt))}
            </span>
            {d.status === 'pending' && (
              <button
                className="dispatch-cancel"
                title="Cancel this dispatch before it is delivered"
                disabled={busy === d.id}
                onClick={(e) => cancel(e, d)}
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
      {limit !== undefined && mine.length > shown.length && (
        <div className="dispatch-more">+{mine.length - shown.length} more in the task panel</div>
      )}
    </div>
  );
}
