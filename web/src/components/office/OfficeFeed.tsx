// The office view's history feed (docs/office.md § The view → Feed): theme
// agnostic — every skin shows this same list beside its floor. Rows come
// newest first from `layoutOffice(...).feed`; selecting one lights its roles
// and its hand-off edge on the floor, its link opens the thing behind it.
import type { OfficeFeedItem, OfficeRole } from '@tm/shared';
import { fmtAgo, useNow } from '../TimeAgo.tsx';

type Props = {
  items: readonly OfficeFeedItem[];
  roles: readonly OfficeRole[];
  selectedId: string | null;
  onSelect: (item: OfficeFeedItem | null) => void;
  onOpenTask: (id: string) => void;
  onOpenTerminal: (runId: string) => void;
  onOpenBrief: (id: string) => void;
};

export function OfficeFeed({ items, roles, selectedId, onSelect, onOpenTask, onOpenTerminal, onOpenBrief }: Props) {
  const now = useNow();
  const roleById = new Map(roles.map((r) => [r.id, r]));
  if (items.length === 0) return <div className="muted ov-feed-empty">Nothing has happened in this office yet.</div>;
  return (
    <ol className="ov-feed" aria-label="Office history">
      {items.map((f) => {
        const who = f.roleIds.map((id) => roleById.get(id)).find((r) => r);
        const t = Date.parse(f.at);
        const link = feedLink(f, { onOpenTask, onOpenTerminal, onOpenBrief });
        const selected = f.id === selectedId;
        return (
          <li key={f.id} className={`ov-feed-row tone-${f.tone}${selected ? ' selected' : ''}`}>
            <button
              type="button"
              className="ov-feed-main"
              aria-pressed={selected}
              title={new Date(t).toLocaleString()}
              onClick={() => onSelect(selected ? null : f)}
            >
              <span className="ov-feed-who" aria-hidden>
                {who?.avatar ?? (f.kind === 'event' ? '•' : '🚪')}
              </span>
              <span className="ov-feed-text">
                {f.tainted && <span className="chip office-taint">untrusted</span>} {f.text}
              </span>
              <span className="ov-feed-age">{Number.isFinite(t) ? fmtAgo(Math.max(0, now - t)) : ''}</span>
            </button>
            {link && (
              <button type="button" className="btn ghost ov-feed-link" onClick={link.run}>
                {link.label}
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function feedLink(
  f: OfficeFeedItem,
  h: { onOpenTask: (id: string) => void; onOpenTerminal: (runId: string) => void; onOpenBrief: (id: string) => void },
): { label: string; run: () => void } | null {
  const ref = f.ref;
  if (!ref) return null;
  if (ref.kind === 'task') return { label: 'Task', run: () => h.onOpenTask(ref.id) };
  if (ref.kind === 'brief') return { label: 'Brief', run: () => h.onOpenBrief(ref.id) };
  if (ref.runId) {
    const runId = ref.runId;
    return { label: 'Terminal', run: () => h.onOpenTerminal(runId) };
  }
  return null;
}
