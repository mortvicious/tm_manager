import { useMemo, useState } from 'react';
import { useIsMobile } from '../components/Layout.tsx';
import { TimelineStream } from '../components/timeline/TimelineStream.tsx';
import { TimelineTracks } from '../components/timeline/TimelineTracks.tsx';
import { lookup } from '../components/timeline/format.ts';
import { useApp } from '../state.tsx';
import { useTimeline } from '../timeline.ts';

const HOUR = 3600_000;
const RANGES = [
  { key: '6h', label: '6 h', ms: 6 * HOUR },
  { key: '24h', label: '24 h', ms: 24 * HOUR },
  { key: '3d', label: '3 d', ms: 72 * HOUR },
  { key: '7d', label: '7 d', ms: 168 * HOUR },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

/**
 * `/timeline` (docs/timeline.md § SPA): the past of the current workspace,
 * NOW, and the predicted future. The data is `useTimeline`; this page picks
 * the window and the shape — tracks on a desktop, one stream on a phone.
 */
export function TimelinePage({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const mobile = useIsMobile();
  const { repos } = useApp();
  const [range, setRange] = useState<RangeKey>('24h');
  // a live window: its start is fixed when the range is picked, its end is NOW
  const since = useMemo(() => new Date(Date.now() - RANGES.find((r) => r.key === range)!.ms).toISOString(), [range]);
  const tl = useTimeline({ since });
  const names = useMemo(() => lookup(tl.tasks, repos), [tl.tasks, repos]);

  return (
    <div className="tl-page">
      <h1 className="page-title">Timeline</h1>
      <div className="tl-toolbar">
        <div className="seg" role="group" aria-label="Window">
          {RANGES.map((r) => (
            <button key={r.key} type="button" className={`btn ${range === r.key ? 'primary' : ''}`} aria-pressed={range === r.key} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
        {tl.loading && <span className="muted">loading…</span>}
        {tl.truncated && <span className="muted">too many rows — the window starts later than asked</span>}
        {tl.error && (
          <span className="tl-error">
            {tl.error}{' '}
            <button type="button" className="btn" onClick={tl.reload}>
              Retry
            </button>
          </span>
        )}
      </div>
      {mobile ? <TimelineStream tl={tl} names={names} onOpenTask={onOpenTask} /> : <TimelineTracks tl={tl} names={names} onOpenTask={onOpenTask} />}
    </div>
  );
}
