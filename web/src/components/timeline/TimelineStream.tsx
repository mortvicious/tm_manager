import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import {
  repoParallelCap,
  stateAt,
  type PredictedSlot,
  type Repo,
  type TimelineSegment,
  type TimelineSegmentKind,
} from '@tm/shared';
import { useApp } from '../../state.tsx';
import type { UseTimeline } from '../../timeline.ts';
import { Sheet, SheetAction } from '../Sheet.tsx';
import {
  AFTER_LABEL,
  clock,
  relative,
  SEGMENT_COLOR,
  SEGMENT_LABEL,
  segmentEnd,
  segmentWhen,
  slotWhen,
  SOURCE_LABEL,
  span,
  type Lookup,
} from './format.ts';

/** the newest past rows a phone shows above NOW */
const PAST_MAX = 60;
/** predicted rows (scheduled, then not scheduled) shown below NOW; the rest is a count */
const FUTURE_MAX = 50;
/** a press held this long explains the row instead of opening the task */
const LONG_PRESS_MS = 480;
/** a finger that moved this far is scrolling, not pressing */
const LONG_PRESS_SLOP = 10;
/** the repo hues: the group palette (`--tm-group-1..7`), one per repo by its place in the repo list */
const RAIL_HUES = 7;

/** the stretches that hold a worker slot of a parallel repo (what a lane is) */
const LANE_KINDS: ReadonlySet<TimelineSegmentKind> = new Set(['running', 'waiting', 'fixing', 'checks', 'review-round']);

/** one line per segment kind for the explain sheet */
const SEGMENT_WHAT: Record<TimelineSegmentKind, string> = {
  queued: 'Waiting in the queue for a worker slot and its repo.',
  running: 'A worker session was working on it.',
  waiting: 'The turn ended with a background subagent or shell still out; the session kept its slot.',
  'review-round': 'The adversarial reviewer read the change.',
  checks: "The repo's checks ran over the change.",
  fixing: 'A fix turn: findings or a red check went back into the same session.',
  'idle-in-review': 'Done working, waiting in review for the human (or the landing tier).',
  landed: 'Landed: done or published.',
  failed: 'The task failed here.',
  cancelled: 'The task was cancelled here.',
};

/**
 * The phone timeline (docs/timeline.md § Phone stream): one vertical stream
 * of compact task rows — the past oldest → newest above a sticky NOW divider,
 * then the predicted order with ETA and wait reason. Each row's left edge is
 * its repo's rail (one hue per repo); a parallel repo's rail is split into its
 * lanes with the row's own lane lit. Opens scrolled to NOW; a tap opens the
 * task, a long press — or a tap on the reason — explains the row in a Sheet.
 */
export function TimelineStream({ tl, names, onOpenTask }: { tl: UseTimeline; names: Lookup; onOpenTask: (id: string) => void }) {
  const { repos, loaded } = useApp();
  const [explain, setExplain] = useState<Explained | null>(null);

  const past = useMemo(
    () =>
      Object.values(tl.segments)
        .flat()
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.taskId.localeCompare(b.taskId)),
    [tl.segments],
  );
  const shown = past.slice(-PAST_MAX);
  const scheduled = tl.predicted.filter((p) => p.scheduled);
  const unscheduled = tl.predicted.filter((p) => !p.scheduled);
  const scheduledShown = scheduled.slice(0, FUTURE_MAX);
  const unscheduledShown = unscheduled.slice(0, Math.max(0, FUTURE_MAX - scheduledShown.length));

  const rails = useMemo(() => railsOf(repos), [repos]);
  const lanes = useMemo(() => assignLanes(past, tl.predicted, rails, tl.now), [past, tl.predicted, rails, tl.now]);
  const legend = useMemo(() => {
    const ids = new Set<string>();
    for (const s of shown) if (s.repoId) ids.add(s.repoId);
    for (const p of [...scheduledShown, ...unscheduledShown]) if (p.repoId) ids.add(p.repoId);
    return [...ids].filter((id) => rails.has(id)).sort((a, b) => rails.get(a)!.index - rails.get(b)!.index);
  }, [shown, scheduledShown, unscheduledShown, rails]);

  // open scrolled to NOW: once, after the first answer and the board's first
  // load (the predicted rows below NOW come from it), on the in-flow anchor —
  // the divider itself is sticky, so its box is wherever it is stuck. A
  // reload (the socket's first connect refetches) keeps the rows on screen,
  // so it does not hold the scroll back.
  const anchor = useRef<HTMLDivElement>(null);
  const answered = useRef(false);
  const scrolled = useRef(false);
  if (!tl.loading) answered.current = true;
  useLayoutEffect(() => {
    if (scrolled.current || !answered.current || !loaded || !anchor.current) return;
    scrolled.current = true;
    anchor.current.scrollIntoView({ block: 'center' });
  }, [tl.loading, loaded]);

  const at = stateAt(tl.segments, tl.now);
  const nowParts: [number, string][] = [
    [at.running.length, 'running'],
    [at.waiting.length, 'waiting'],
    [at.checking.length, 'checks'],
    [at.inReview.length, 'in review'],
    [at.queued.length, 'queued'],
  ];
  const nowLine = nowParts.filter(([n]) => n > 0).map(([n, l]) => `${n} ${l}`).join(' · ') || 'nothing live';

  const rail = (repoId: string | null, lane: number | null) => <Rail rail={repoId ? rails.get(repoId) : undefined} lane={lane} />;

  return (
    <div className="tl-stream">
      {legend.length > 0 && (
        <div className="tl-legend" aria-label="Repo rails">
          {legend.map((id) => (
            <span key={id} className="tl-legend-item" style={railStyle(rails.get(id)!)}>
              <span className="tl-legend-swatch" />
              {rails.get(id)!.name}
              {rails.get(id)!.cap > 1 && <span className="muted">×{rails.get(id)!.cap}</span>}
            </span>
          ))}
        </div>
      )}

      <div className="section-head">
        Past <span className="count">{past.length}</span>
        {past.length > shown.length && <span className="muted tl-head-note">newest {shown.length}</span>}
      </div>
      {shown.length === 0 ? (
        <div className="panel tl-empty muted">{tl.loading ? 'Loading…' : 'Nothing happened in this window.'}</div>
      ) : (
        <div className="panel tl-srows">
          {shown.map((s, i) => (
            <StreamRow
              key={`${s.taskId}-${s.start}-${s.kind}-${i}`}
              rail={rail(s.repoId, lanes.get(segKey(s)) ?? null)}
              title={names.title(s.taskId)}
              known={!!names.task(s.taskId)}
              onOpen={() => onOpenTask(s.taskId)}
              onExplain={() => setExplain({ kind: 'past', s })}
              meta={
                <>
                  <span className="tl-dot" style={{ background: SEGMENT_COLOR[s.kind] }} />
                  {SEGMENT_LABEL[s.kind]} · {s.clippedStart ? '… ' : ''}
                  {segmentWhen(s, tl.now)}
                  {s.outcome ? ` · ${s.outcome}` : ''}
                </>
              }
              repo={names.repo(s.repoId)}
              open={s.end === null}
            />
          ))}
        </div>
      )}

      <div ref={anchor} className="tl-now-anchor" aria-hidden="true" />
      <button
        type="button"
        className="tl-now-divider"
        aria-label={`Now ${clock(tl.now, tl.now)}: ${nowLine}. Scroll to now`}
        onClick={() => anchor.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
      >
        <span className="tl-now-tag">Now</span>
        <span className="tl-now-clock">{clock(tl.now, tl.now)}</span>
        <span className="tl-now-summary">{tl.live ? nowLine : `window ended ${clock(tl.until, tl.now)}`}</span>
      </button>

      <div className="section-head">
        Predicted <span className="count">{scheduled.length}</span>
        {!tl.baseline && <span className="muted tl-head-note">default lengths</span>}
      </div>
      {scheduled.length === 0 ? (
        <div className="panel tl-empty muted">Nothing is predicted to run.</div>
      ) : (
        <div className="panel tl-srows">
          {scheduledShown.map((p) => (
            <SlotStreamRow key={p.taskId} p={p} tl={tl} names={names} rail={rail(p.repoId, lanes.get(p.taskId) ?? null)} onOpenTask={onOpenTask} onExplain={() => setExplain({ kind: 'slot', p })} />
          ))}
          {scheduled.length > scheduledShown.length && <div className="tl-empty muted">+{scheduled.length - scheduledShown.length} more</div>}
        </div>
      )}
      {unscheduled.length > 0 && (
        <>
          <div className="section-head">
            Not scheduled <span className="count">{unscheduled.length}</span>
          </div>
          <div className="panel tl-srows">
            {unscheduledShown.map((p) => (
              <SlotStreamRow key={p.taskId} p={p} tl={tl} names={names} rail={rail(p.repoId, null)} onOpenTask={onOpenTask} onExplain={() => setExplain({ kind: 'slot', p })} />
            ))}
            {unscheduled.length > unscheduledShown.length && <div className="tl-empty muted">+{unscheduled.length - unscheduledShown.length} more</div>}
          </div>
        </>
      )}

      {explain && (
        <ExplainRowSheet
          explained={explain}
          tl={tl}
          names={names}
          lane={explain.kind === 'past' ? (lanes.get(segKey(explain.s)) ?? null) : (lanes.get(explain.p.taskId) ?? null)}
          onOpenTask={onOpenTask}
          onClose={() => setExplain(null)}
        />
      )}
    </div>
  );
}

// ---- rows -------------------------------------------------------------------

function SlotStreamRow({
  p,
  tl,
  names,
  rail,
  onOpenTask,
  onExplain,
}: {
  p: PredictedSlot;
  tl: UseTimeline;
  names: Lookup;
  rail: ReactNode;
  onOpenTask: (id: string) => void;
  onExplain: () => void;
}) {
  const reason = p.waits.length ? p.waits[p.waits.length - 1].text : null;
  return (
    <StreamRow
      rail={rail}
      title={names.title(p.taskId)}
      known={!!names.task(p.taskId)}
      onOpen={() => onOpenTask(p.taskId)}
      onExplain={onExplain}
      repo={names.repo(p.repoId)}
      predicted
      meta={
        p.scheduled ? (
          <>
            <span className="tl-dot" />
            {SOURCE_LABEL[p.source]} · {slotEta(p, tl.now)}
          </>
        ) : (
          <>not scheduled</>
        )
      }
      reason={
        reason && (
          <button
            type="button"
            className="tl-reason-tap"
            aria-label={`Why: ${reason}`}
            onClick={(e) => {
              e.stopPropagation();
              onExplain();
            }}
          >
            {p.scheduled ? 'waited: ' : ''}
            {reason}
          </button>
        )
      }
    />
  );
}

/**
 * One compact row: the rail, the title, one mono meta line, and a reason
 * button on predicted rows. The row itself is the tap target (a `div` with
 * the button role, since the reason inside it is a real button).
 */
function StreamRow({
  rail,
  title,
  known,
  onOpen,
  onExplain,
  meta,
  repo,
  reason,
  open = false,
  predicted = false,
}: {
  rail: ReactNode;
  title: string;
  known: boolean;
  onOpen: () => void;
  onExplain: () => void;
  meta: ReactNode;
  repo: string | null;
  reason?: ReactNode;
  open?: boolean;
  predicted?: boolean;
}) {
  const press = useLongPress(onExplain);
  return (
    <div
      role="button"
      tabIndex={0}
      className={`tl-srow${open ? ' open' : ''}${predicted ? ' predicted' : ''}${known ? '' : ' gone'}`}
      aria-label={known ? `${title} — open the task` : `${title} — explain`}
      {...press.handlers}
      onClick={() => {
        if (press.consumed()) return;
        // a gone task has no panel to open: the tap explains instead
        if (known) onOpen();
        else onExplain();
      }}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (known) onOpen();
          else onExplain();
        }
      }}
    >
      {rail}
      <span className="tl-srow-body">
        <span className="tl-srow-title">{title}</span>
        <span className="tl-srow-meta">
          <span className="tl-srow-what">{meta}</span>
          {repo && <span className="tl-srow-repo">{repo}</span>}
        </span>
        {reason}
      </span>
    </div>
  );
}

/** "starts 14:05 (in 12m) · ~38m", a running one "ends 14:43 (in 12m)" */
function slotEta(p: PredictedSlot, now: number): string {
  if (!p.scheduled) return '';
  const last = p.after.length ? p.after[p.after.length - 1].end : p.end;
  const total = span(Date.parse(last) - Date.parse(p.start));
  return p.source === 'running' ? `ends ${clock(last, now)} (${relative(last, now)})` : `${clock(p.start, now)} (${relative(p.start, now)}) · ~${total}`;
}

// ---- rails ------------------------------------------------------------------

interface RailInfo {
  index: number;
  name: string;
  /** the repo's parallel cap (1 = one rail, no lanes) */
  cap: number;
}

function railsOf(repos: readonly Repo[]): Map<string, RailInfo> {
  return new Map(repos.map((r, index) => [r.id, { index, name: r.name, cap: repoParallelCap(r) }]));
}

function railStyle(r: RailInfo): CSSProperties {
  return { '--tl-rail': `var(--tm-group-${(r.index % RAIL_HUES) + 1})` } as CSSProperties;
}

/** the left edge: the repo's hue; a parallel repo draws one thin stripe per lane, the row's own lit */
function Rail({ rail, lane }: { rail: RailInfo | undefined; lane: number | null }) {
  if (!rail) {
    return (
      <span className="tl-rail none" aria-hidden="true">
        <span className="tl-lane solo" />
      </span>
    );
  }
  if (rail.cap <= 1) {
    return (
      <span className="tl-rail" style={railStyle(rail)} aria-hidden="true">
        <span className="tl-lane solo on" />
      </span>
    );
  }
  return (
    <span className="tl-rail" style={railStyle(rail)} aria-label={lane === null ? undefined : `lane ${lane + 1} of ${rail.cap}`}>
      {Array.from({ length: rail.cap }, (_, i) => (
        <span key={i} className={`tl-lane${i === lane ? ' on' : ''}`} />
      ))}
    </span>
  );
}

const segKey = (s: TimelineSegment) => `${s.taskId}|${s.start}|${s.kind}`;

/**
 * Which lane of a parallel repo each row sits in. A lane is a worker slot of
 * the repo, so only the stretches that hold one (`LANE_KINDS`, every scheduled
 * slot) take a lane; one pass in start order over past and predicted together,
 * a task keeping its lane while its stretches touch (a running segment and its
 * predicted remainder are one stretch), else the lowest free lane. A display
 * reading: the simulator's `lane` is the global worker lane, not this.
 */
function assignLanes(past: readonly TimelineSegment[], predicted: readonly PredictedSlot[], rails: ReadonlyMap<string, RailInfo>, now: number): Map<string, number> {
  interface Span {
    key: string;
    taskId: string;
    repoId: string;
    start: number;
    end: number;
  }
  const byRepo = new Map<string, Span[]>();
  const add = (sp: Span) => {
    if ((rails.get(sp.repoId)?.cap ?? 1) <= 1) return;
    let list = byRepo.get(sp.repoId);
    if (!list) byRepo.set(sp.repoId, (list = []));
    list.push(sp);
  };
  for (const s of past) {
    if (!s.repoId || !LANE_KINDS.has(s.kind)) continue;
    add({ key: segKey(s), taskId: s.taskId, repoId: s.repoId, start: Date.parse(s.start), end: segmentEnd(s, now) });
  }
  for (const p of predicted) {
    if (!p.scheduled || !p.repoId) continue;
    const last = p.after.length ? p.after[p.after.length - 1].end : p.end;
    add({ key: p.taskId, taskId: p.taskId, repoId: p.repoId, start: Date.parse(p.start), end: Date.parse(last) });
  }
  const out = new Map<string, number>();
  for (const [repoId, list] of byRepo) {
    const cap = rails.get(repoId)!.cap;
    list.sort((a, b) => a.start - b.start || a.taskId.localeCompare(b.taskId));
    const holder: ({ taskId: string; end: number } | null)[] = Array.from({ length: cap }, () => null);
    for (const sp of list) {
      let lane = holder.findIndex((h) => h?.taskId === sp.taskId && h.end >= sp.start);
      if (lane < 0) lane = holder.findIndex((h) => !h || h.end <= sp.start);
      // over the cap (a human's Run now, a stale row): share the lane that frees first
      if (lane < 0) lane = holder.reduce((best, h, i) => (h!.end < holder[best]!.end ? i : best), 0);
      const prev = holder[lane];
      holder[lane] = { taskId: sp.taskId, end: prev?.taskId === sp.taskId ? Math.max(prev.end, sp.end) : sp.end };
      out.set(sp.key, lane);
    }
  }
  return out;
}

// ---- long press -------------------------------------------------------------

/** a held press fires `onLong` once and swallows the click that follows it */
function useLongPress(onLong: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  };
  return {
    consumed() {
      const f = fired.current;
      fired.current = false;
      return f;
    },
    handlers: {
      onPointerDown(e: PointerEvent) {
        if (e.button !== 0) return;
        // a press on the reason button is the button's own tap
        if ((e.target as HTMLElement).closest('.tl-reason-tap')) return;
        fired.current = false;
        origin.current = { x: e.clientX, y: e.clientY };
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          fired.current = true;
          onLong();
        }, LONG_PRESS_MS);
      },
      onPointerMove(e: PointerEvent) {
        const o = origin.current;
        if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > LONG_PRESS_SLOP) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onPointerLeave: cancel,
      // the OS's own long-press menu (a desktop right click explains too)
      onContextMenu(e: MouseEvent) {
        e.preventDefault();
        if (!fired.current) {
          cancel();
          fired.current = true;
          onLong();
        }
      },
    },
  };
}

// ---- the explain sheet ------------------------------------------------------

type Explained = { kind: 'past'; s: TimelineSegment } | { kind: 'slot'; p: PredictedSlot };

/**
 * docs/mobile.md § Tap to explain, for a timeline row: what the row is, why a
 * predicted one waits (every reason, oldest first) and its predicted plan.
 * Plain blocks in the Sheet's own body — the library's scroller is the only
 * scroller, so drag-from-the-top keeps working.
 */
function ExplainRowSheet({
  explained,
  tl,
  names,
  lane,
  onOpenTask,
  onClose,
}: {
  explained: Explained;
  tl: UseTimeline;
  names: Lookup;
  lane: number | null;
  onOpenTask: (id: string) => void;
  onClose: () => void;
}) {
  const taskId = explained.kind === 'past' ? explained.s.taskId : explained.p.taskId;
  const repoId = explained.kind === 'past' ? explained.s.repoId : explained.p.repoId;
  const known = !!names.task(taskId);
  const repo = names.repo(repoId);
  const title = names.title(taskId);
  const where = [repo, lane !== null ? `lane ${lane + 1}` : null].filter(Boolean).join(' · ');
  return (
    <Sheet label={`${title} — explained`} title={title} onClose={onClose} zIndex={38}>
      <div className="explain tl-explain">
        {explained.kind === 'past' ? (
          <>
            <div className="explain-lead">
              <span className="tl-seg" style={{ borderColor: SEGMENT_COLOR[explained.s.kind] }}>
                <span className="tl-dot" style={{ background: SEGMENT_COLOR[explained.s.kind] }} />
                {SEGMENT_LABEL[explained.s.kind]}
              </span>
              {where && <span className="muted">{where}</span>}
            </div>
            <p className="explain-what">{SEGMENT_WHAT[explained.s.kind]}</p>
            <dl className="tl-explain-facts">
              <dt>When</dt>
              <dd>
                {explained.s.clippedStart ? 'before the window … ' : ''}
                {segmentWhen(explained.s, tl.now)}
              </dd>
              {explained.s.outcome && (
                <>
                  <dt>{explained.s.end === null ? 'So far' : 'Ended'}</dt>
                  <dd>{explained.s.outcome}</dd>
                </>
              )}
            </dl>
          </>
        ) : (
          <SlotExplain p={explained.p} tl={tl} where={where} />
        )}
      </div>
      {known && (
        <div className="explain-acts">
          <SheetAction
            label="Open the task"
            tone="primary"
            onClick={() => {
              onClose();
              onOpenTask(taskId);
            }}
          />
        </div>
      )}
    </Sheet>
  );
}

function SlotExplain({ p, tl, where }: { p: PredictedSlot; tl: UseTimeline; where: string }) {
  const own = p.repoId ? tl.baseline?.byRepo[p.repoId] : undefined;
  const all = tl.baseline?.all;
  return (
    <>
      <div className="explain-lead">
        <span className={`tl-seg ${p.scheduled ? 'predicted' : 'waits'}`}>
          <span className="tl-dot" />
          {p.scheduled ? SOURCE_LABEL[p.source] : 'not scheduled'}
        </span>
        {where && <span className="muted">{where}</span>}
      </div>
      {p.scheduled ? (
        <>
          <p className="explain-what">{slotWhen(p, tl.now)}</p>
          <dl className="tl-explain-facts">
            <dt>Work</dt>
            <dd>{span(Date.parse(p.end) - Date.parse(p.start))}</dd>
            {p.after.map((a) => (
              <FactPair key={a.kind} term={AFTER_LABEL[a.kind]} value={`${clock(a.start, tl.now)} · ${span(Date.parse(a.end) - Date.parse(a.start))}`} />
            ))}
            <dt>Lands</dt>
            <dd>{p.lands}</dd>
          </dl>
        </>
      ) : (
        <p className="explain-what">The simulation found no start for it in the predicted future.</p>
      )}
      {p.waits.length > 0 && (
        <>
          <div className="tl-explain-head">{p.scheduled ? 'What held it back' : 'What it waits for'}</div>
          <ol className="tl-explain-waits">
            {p.waits.map((w, i) => (
              <li key={i} className={!p.scheduled && i === p.waits.length - 1 ? 'last' : undefined}>
                {w.text}
              </li>
            ))}
          </ol>
        </>
      )}
      <p className="explain-todo">
        {own
          ? `Lengths are this repo's medians over ${own.n} landed tasks — a prediction, not a promise.`
          : all
            ? `Lengths are the all-repo medians over ${all.n} landed tasks — a prediction, not a promise.`
            : 'No duration baseline yet, so default lengths — a prediction, not a promise.'}
      </p>
    </>
  );
}

function FactPair({ term, value }: { term: string; value: string }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{value}</dd>
    </>
  );
}
