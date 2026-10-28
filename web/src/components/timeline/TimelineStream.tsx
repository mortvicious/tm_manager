import type { TimelineSegment } from '@tm/shared';
import type { UseTimeline } from '../../timeline.ts';
import { NowBlock, PredictedSections } from './TimelineTracks.tsx';
import { SEGMENT_COLOR, SEGMENT_LABEL, segmentWhen, type Lookup } from './format.ts';

/** the newest past rows a phone shows above NOW */
const PAST_MAX = 60;

/**
 * The phone timeline (docs/timeline.md § SPA): one vertical stream — the past
 * oldest → newest above NOW, then the predicted slots and what waits, over
 * the same `useTimeline` seam as the desktop. A later phase turns it into
 * repo rails; the data does not change.
 */
export function TimelineStream({ tl, names, onOpenTask }: { tl: UseTimeline; names: Lookup; onOpenTask: (id: string) => void }) {
  const past: TimelineSegment[] = Object.values(tl.segments)
    .flat()
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const shown = past.slice(-PAST_MAX);
  return (
    <div className="tl-stream">
      <div className="section-head">
        Past <span className="count">{past.length}</span>
        {past.length > shown.length && <span className="muted tl-head-note">newest {shown.length}</span>}
      </div>
      {shown.length === 0 ? (
        <div className="panel tl-empty muted">{tl.loading ? 'Loading…' : 'Nothing happened in this window.'}</div>
      ) : (
        <div className="panel">
          {shown.map((s, i) => {
            const known = !!names.task(s.taskId);
            return (
              <div key={`${s.taskId}-${s.start}-${i}`} className="tl-stream-row" style={{ borderLeftColor: SEGMENT_COLOR[s.kind] }}>
                <button
                  type="button"
                  className="tl-task-title"
                  disabled={!known}
                  onClick={() => onOpenTask(s.taskId)}
                >
                  {names.title(s.taskId)}
                </button>
                <span className="tl-stream-meta">
                  {SEGMENT_LABEL[s.kind]} · {segmentWhen(s, tl.now)}
                  {s.outcome ? ` · ${s.outcome}` : ''}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <NowBlock tl={tl} names={names} onOpenTask={onOpenTask} />

      <PredictedSections tl={tl} names={names} onOpenTask={onOpenTask} />
    </div>
  );
}
