import { stateAt, type PredictedSlot, type TimelineSegment } from '@tm/shared';
import type { UseTimeline } from '../../timeline.ts';
import {
  AFTER_LABEL,
  clock,
  pastTracks,
  SEGMENT_COLOR,
  SEGMENT_LABEL,
  segmentWhen,
  slotWhen,
  SOURCE_LABEL,
  span,
  type Lookup,
} from './format.ts';

/**
 * The desktop timeline (docs/timeline.md § SPA). For now a token-styled list
 * per task — past segments, NOW, predicted slots with ETA and reason — over
 * the `useTimeline` seam; the track layout replaces the body, not the data.
 */
export function TimelineTracks({ tl, names, onOpenTask }: { tl: UseTimeline; names: Lookup; onOpenTask: (id: string) => void }) {
  const tracks = pastTracks(tl.segments);
  return (
    <div className="tl-tracks">
      <div className="section-head">
        Past <span className="count">{tracks.length}</span>
        <span className="muted tl-head-note">since {clock(tl.since, tl.now)}</span>
      </div>
      {tracks.length === 0 ? (
        <div className="panel tl-empty muted">{tl.loading ? 'Loading…' : 'Nothing happened in this window.'}</div>
      ) : (
        <div className="panel">
          {tracks.map(([taskId, segs]) => (
            <div key={taskId} className="tl-track">
              <TaskHead taskId={taskId} repoId={segs[0].repoId} names={names} onOpenTask={onOpenTask} />
              <div className="tl-segs">
                {segs.map((s, i) => (
                  <SegmentChip key={`${s.start}-${i}`} s={s} now={tl.now} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <NowBlock tl={tl} names={names} onOpenTask={onOpenTask} />

      <PredictedSections tl={tl} names={names} onOpenTask={onOpenTask} />
    </div>
  );
}

function TaskHead({
  taskId,
  repoId,
  names,
  onOpenTask,
}: {
  taskId: string;
  repoId: string | null;
  names: Lookup;
  onOpenTask: (id: string) => void;
}) {
  const repo = names.repo(repoId);
  const known = !!names.task(taskId);
  return (
    <div className="tl-task-head">
      {known ? (
        <button type="button" className="tl-task-title" onClick={() => onOpenTask(taskId)}>
          {names.title(taskId)}
        </button>
      ) : (
        <span className="tl-task-title muted">{names.title(taskId)}</span>
      )}
      {repo && <span className="chip">{repo}</span>}
    </div>
  );
}

function SegmentChip({ s, now }: { s: TimelineSegment; now: number }) {
  return (
    <span className={`tl-seg${s.end === null ? ' open' : ''}`} style={{ borderColor: SEGMENT_COLOR[s.kind] }} title={s.outcome ?? undefined}>
      <span className="tl-dot" style={{ background: SEGMENT_COLOR[s.kind] }} />
      {SEGMENT_LABEL[s.kind]}
      <span className="muted">
        {s.clippedStart ? '… ' : ''}
        {segmentWhen(s, now)}
        {s.outcome ? ` · ${s.outcome}` : ''}
      </span>
    </span>
  );
}

export function NowBlock({ tl, names, onOpenTask }: { tl: UseTimeline; names: Lookup; onOpenTask: (id: string) => void }) {
  const at = stateAt(tl.segments, tl.now);
  const rows: [string, string[]][] = [
    ['running', at.running],
    ['waiting', at.waiting],
    ['checks', at.checking],
    ['in review', at.inReview],
    ['queued', at.queued],
  ];
  return (
    <>
      <div className="section-head accent tl-now-head">
        Now <span className="count">{clock(tl.now, tl.now)}</span>
        {!tl.live && <span className="muted tl-head-note">window ended {clock(tl.until, tl.now)}</span>}
      </div>
      <div className="panel tl-now">
        {rows.map(([label, ids]) => (
          <div key={label} className="tl-now-row">
            <span className="tl-now-label">{label}</span>
            <span className="count">{ids.length}</span>
            <span className="tl-now-tasks">
              {ids.slice(0, 6).map((id) => (
                <button type="button" key={id} className="tl-link" onClick={() => onOpenTask(id)}>
                  {names.title(id)}
                </button>
              ))}
              {ids.length > 6 && <span className="muted">+{ids.length - 6}</span>}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/** rows per predicted list; the rest is a count */
const SLOTS_MAX = 50;

function SlotList({ slots, tl, names, onOpenTask }: { slots: PredictedSlot[]; tl: UseTimeline; names: Lookup; onOpenTask: (id: string) => void }) {
  return (
    <div className="panel">
      {slots.slice(0, SLOTS_MAX).map((p) => (
        <SlotRow key={p.taskId} p={p} tl={tl} names={names} onOpenTask={onOpenTask} />
      ))}
      {slots.length > SLOTS_MAX && <div className="tl-empty muted">+{slots.length - SLOTS_MAX} more</div>}
    </div>
  );
}

/** the future: scheduled slots by start, then what is not scheduled and why */
export function PredictedSections({ tl, names, onOpenTask }: { tl: UseTimeline; names: Lookup; onOpenTask: (id: string) => void }) {
  const scheduled = tl.predicted.filter((p) => p.scheduled);
  const waiting = tl.predicted.filter((p) => !p.scheduled);
  return (
    <>
      <div className="section-head">
        Predicted <span className="count">{scheduled.length}</span>
        {!tl.baseline && <span className="muted tl-head-note">no duration baseline — default lengths</span>}
      </div>
      {scheduled.length === 0 ? (
        <div className="panel tl-empty muted">Nothing is predicted to run.</div>
      ) : (
        <SlotList slots={scheduled} tl={tl} names={names} onOpenTask={onOpenTask} />
      )}
      {waiting.length > 0 && (
        <>
          <div className="section-head">
            Not scheduled <span className="count">{waiting.length}</span>
          </div>
          <SlotList slots={waiting} tl={tl} names={names} onOpenTask={onOpenTask} />
        </>
      )}
    </>
  );
}

function SlotRow({ p, tl, names, onOpenTask }: { p: PredictedSlot; tl: UseTimeline; names: Lookup; onOpenTask: (id: string) => void }) {
  const when = slotWhen(p, tl.now);
  const reason = p.waits.length ? p.waits[p.waits.length - 1].text : null;
  return (
    <div className="tl-track">
      <TaskHead taskId={p.taskId} repoId={p.repoId} names={names} onOpenTask={onOpenTask} />
      <div className="tl-slot-line">
        {p.scheduled ? (
          <>
            <span className="tl-seg predicted">
              <span className="tl-dot" />
              {SOURCE_LABEL[p.source]}
              {p.lane !== null && <span className="muted">lane {p.lane + 1}</span>}
            </span>
            <span>{when}</span>
            <span className="muted">
              work {span(Date.parse(p.end) - Date.parse(p.start))}
              {p.after.map((a) => ` → ${AFTER_LABEL[a.kind]} ${span(Date.parse(a.end) - Date.parse(a.start))}`).join('')}
              {` → ${p.lands}`}
            </span>
          </>
        ) : (
          <span className="tl-seg waits">not scheduled</span>
        )}
        {reason && (
          <span className="tl-reason" title={p.waits.map((w) => w.text).join('\n')}>
            {p.scheduled ? 'waited: ' : ''}
            {reason}
          </span>
        )}
      </div>
    </div>
  );
}
