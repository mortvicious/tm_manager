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
 * `full` (the task panel) renders each dispatch as a collapsible entry — one
 * teaser line until chosen, the whole message when open — the same shape as
 * the review rounds above it; the newest starts open.
 */

/** first line of a message, ellipsised, for the collapsed teaser */
function teaser(message: string): string {
  const line = message.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.length > 120 ? `${line.slice(0, 119).trimEnd()}…` : line;
}
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
  // the one entry that is open in `full` mode; null = all collapsed
  const [openId, setOpenId] = useState<string | null | undefined>(undefined);
  const now = useNow();

  const mine = dispatches
    .filter((d) => d.toTaskId === taskId || (direction === 'both' && d.fromTaskId === taskId))
    .filter((d) => !pendingOnly || d.status === 'pending')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  if (mine.length === 0) return null;
  const shown = limit ? mine.slice(0, limit) : mine;
  // undefined = never touched: the newest is open by default
  const open = openId === undefined ? shown[0]?.id ?? null : openId;

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
        const isOpen = full && open === d.id;
        return (
          <div key={d.id} className={`dispatch-row ${d.status} ${d.intent} ${full ? 'full' : ''} ${isOpen ? 'open' : ''}`}>
            {full ? (
              <button
                className="dispatch-toggle"
                aria-expanded={isOpen}
                title={isOpen ? 'collapse' : 'show the whole message'}
                onClick={() => setOpenId(isOpen ? null : d.id)}
              >
                <span className={`caret ${isOpen ? '' : 'closed'}`}>▾</span>
              </button>
            ) : null}
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
            <span className="dispatch-msg" title={full && !isOpen ? d.message : undefined}>
              {full && !isOpen ? teaser(d.message) : d.message}
            </span>
            {d.intent === 'fyi' && (
              <span
                className="dispatch-intent"
                title="FYI — this message never wakes the target session; it is handed over on the next turn that session takes anyway"
              >
                fyi
              </span>
            )}
            <span
              className="dispatch-status"
              title={
                d.note ??
                (d.status === 'pending' && d.intent === 'fyi'
                  ? 'waiting to ride along on the target session\u2019s next turn — it will not start one'
                  : undefined)
              }
            >
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
