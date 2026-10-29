import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { stateAt, type PredictedSlot, type Task, type TimelineSegment } from '@tm/shared';
import { useApp } from '../../state.tsx';
import type { UseTimeline } from '../../timeline.ts';
import { useWorkspace } from '../../workspace.ts';
import {
  AFTER_COLOR,
  AFTER_LABEL,
  clock,
  OUTCOME_COLOR,
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
import { buildTrackLayout, segmentAt, type TrackBar, type TrackGhost, type TrackRow } from './layout.ts';
import { IconGrip } from '../Icons.tsx';
import { dropClassFor, slotDraggable, TimelineDragGhost, useTimelineDrag, type TimelineDropView, type TimelineGripProps } from './TimelineDrag.tsx';
import { SCRUB_SPEEDS, ScrubChip, useScrub, type Scrub } from './scrub.tsx';

/**
 * The desktop timeline (docs/timeline.md § Tracks): one horizontal track per
 * workspace repo, time left → right. Past bars (coloured by how the stretch
 * ended, its verify round and waits as sub-segments, an idle tail, a landed /
 * failed marker), the NOW line on the hook's tick, and predicted ghosts after
 * it labelled with the ETA and the wait reason — a queued task's ghost has a
 * grip that drags it beside another to reorder the real queue
 * (TimelineDrag.tsx). Zoom hour/day/week (buttons,
 * ctrl/⌘-wheel), pan (drag empty track, horizontal scroll). Geometry is TIME
 * (`layout.ts`, pure); this maps it to px and draws only what intersects the
 * visible window (± half a viewport), so a week of a busy board stays cheap.
 * The time CURSOR (`scrub.ts`): drag the NOW handle or anywhere on the axis to
 * scrub the past — the bars holding T are lit, the rest dimmed, a chip counts
 * them — release returns to live; play/pause replays the view at ×N.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** the zoom presets: how much time one viewport shows */
const ZOOMS = [
  { key: 'hour', label: 'Hour', span: 3 * HOUR },
  { key: 'day', label: 'Day', span: DAY },
  { key: 'week', label: 'Week', span: 7 * DAY },
] as const;
const SPAN_MIN = 30 * MIN;
const SPAN_MAX = 14 * DAY;
/** where NOW sits in the viewport when the view is (re)positioned: the future gets the rest */
const NOW_AT = 0.7;
/** a bar is never narrower than this (px), so a one-minute turn at week zoom is still a target */
const BAR_MIN_PX = 3;
/** below this width a bar or ghost carries no text */
const LABEL_MIN_PX = 56;
/** a draggable ghost is never narrower than its grip */
const GRIP_MIN_PX = 18;
const TICK_STEPS = [5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY];
/** tick labels this close to NOW (px) would sit under its pill */
const NOW_PILL_CLEAR_PX = 56;
/** the narrowest gap between two axis labels (px) */
const TICK_MIN_PX = 76;
/** a keyboard step of the cursor; with Shift ×10 */
const CURSOR_STEP = 5 * MIN;
/** a scrub pushed past the view's left edge steps back this share of a viewport per move */
const EDGE_STEP = 0.02;
/** while playing, the view follows a cursor that leaves the viewport's last fifth */
const FOLLOW_AT = 0.8;

type Hit = { type: 'bar'; bar: TrackBar } | { type: 'marker'; bar: TrackBar } | { type: 'ghost'; ghost: TrackGhost };
interface Hover {
  key: string;
  /** the time under the pointer */
  t: number;
  x: number;
  y: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const vars = (v: Record<string, string | number>) => v as CSSProperties;

interface Tick {
  at: number;
  label: string;
  day: boolean;
}

/** axis ticks over [from, to], aligned to local midnight (DST-safe: each day restarts the count) */
function ticksFor(from: number, to: number, pxPerMs: number): Tick[] {
  const step = TICK_STEPS.find((s) => s * pxPerMs >= TICK_MIN_PX) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const out: Tick[] = [];
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  for (let guard = 0; d.getTime() <= to && guard < 400; guard++) {
    const midnight = d.getTime();
    d.setDate(d.getDate() + 1);
    const next = d.getTime();
    const dayLabel = new Date(midnight).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
    if (step >= DAY) {
      // every n-th day, counted from the epoch's local day so the pick is stable while panning
      const n = Math.round(midnight / DAY);
      if (n % Math.round(step / DAY) === 0 && midnight >= from) out.push({ at: midnight, label: dayLabel, day: true });
      continue;
    }
    for (let t = midnight; t < next; t += step) {
      if (t < from || t > to) continue;
      out.push({ at: t, label: t === midnight ? dayLabel : clock(t, t), day: t === midnight });
    }
  }
  return out;
}

export function TimelineTracks({ tl, names, onOpenTask }: { tl: UseTimeline; names: Lookup; onOpenTask: (id: string) => void }) {
  const { repos } = useApp();
  const { repoIds } = useWorkspace();
  const scopedRepos = useMemo(() => (repoIds ? repos.filter((r) => repoIds.has(r.id)) : repos), [repos, repoIds]);
  const layout = useMemo(
    () => buildTrackLayout({ segments: tl.segments, predicted: tl.predicted, repos: scopedRepos, names, now: tl.now }),
    [tl.segments, tl.predicted, scopedRepos, names, tl.now],
  );
  const hits = useMemo(() => {
    const m = new Map<string, Hit>();
    for (const row of layout.rows) {
      for (const bar of row.bars) {
        m.set(bar.key, { type: 'bar', bar });
        if (bar.marker) m.set(`m:${bar.key}`, { type: 'marker', bar });
      }
      for (const ghost of row.ghosts) m.set(ghost.key, { type: 'ghost', ghost });
    }
    return m;
  }, [layout]);

  const scroller = useRef<HTMLDivElement>(null);
  const labelCell = useRef<HTMLDivElement>(null);
  const [spanMs, setSpanMs] = useState<number>(DAY);
  /** the time area's width (scroller minus the sticky repo column), px */
  const [viewW, setViewW] = useState(0);
  const [labelW, setLabelW] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [hover, setHover] = useState<Hover | null>(null);
  const [panning, setPanning] = useState(false);
  const dnd = useTimelineDrag(tl, 'x');

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      const lw = labelCell.current?.offsetWidth ?? 0;
      setLabelW(lw);
      setViewW(Math.max(0, el.clientWidth - lw));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const t0 = Date.parse(tl.since);
  const pxPerMs = viewW > 0 ? viewW / spanMs : 0;
  // the canvas always fills the viewport, and runs a little past the last thing drawn
  const tEnd = Math.max(layout.lastAt + spanMs * 0.15, t0 + spanMs, tl.now + spanMs * (1 - NOW_AT));
  const totalW = Math.ceil((tEnd - t0) * pxPerMs);
  // stable per scale, so a hover move (which re-renders this) leaves the memoised tracks alone
  const x = useCallback((t: number) => (t - t0) * pxPerMs, [t0, pxPerMs]);

  // ---- scroll position: NOW in view at first, a zoom keeps its anchor ----
  const pending = useRef<{ t: number; viewX: number } | null>(null);
  const positionedFor = useRef<string | null>(null);
  const prevT0 = useRef(t0);
  useLayoutEffect(() => {
    const el = scroller.current;
    const moved = prevT0.current - t0;
    prevT0.current = t0;
    if (!el || pxPerMs <= 0) return;
    let target: number | null = null;
    if (positionedFor.current !== tl.origin) {
      positionedFor.current = tl.origin;
      target = (tl.now - t0) * pxPerMs - viewW * NOW_AT;
    } else if (pending.current) {
      target = (pending.current.t - t0) * pxPerMs - pending.current.viewX;
    } else if (moved !== 0) {
      // the window's start moved (an extension to the left, a capped answer): keep the same time in view
      target = el.scrollLeft + moved * pxPerMs;
    }
    pending.current = null;
    if (target !== null) {
      el.scrollLeft = Math.max(0, target);
      setScrollLeft(el.scrollLeft);
    }
    // now is read at the moment of positioning, on purpose
  }, [tl.origin, t0, spanMs, viewW, pxPerMs]);

  const zoomTo = useCallback(
    (next: number, viewX: number) => {
      const el = scroller.current;
      if (!el || viewW <= 0) return;
      const span = clamp(next, SPAN_MIN, SPAN_MAX);
      pending.current = { t: t0 + (el.scrollLeft + viewX) / (viewW / spanMs), viewX };
      setSpanMs(span);
    },
    [t0, viewW, spanMs],
  );
  /** a preset keeps NOW where it is when NOW is on screen, else the middle */
  const zoomPreset = (span: number) => {
    const el = scroller.current;
    if (!el || pxPerMs <= 0) return;
    const nowX = x(tl.now) - el.scrollLeft;
    zoomTo(span, nowX >= 0 && nowX <= viewW ? nowX : viewW / 2);
  };
  const scrub = useScrub(tl);
  const jumpToNow = () => {
    scrub.live();
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ left: Math.max(0, x(tl.now) - viewW * NOW_AT), behavior: 'smooth' });
  };
  /** play over the visible part: from the viewport's left edge (never before the window, never at NOW) */
  const playFromView = () => {
    const el = scroller.current;
    const left = el && pxPerMs > 0 ? t0 + el.scrollLeft / pxPerMs : t0;
    scrub.play(Math.min(Math.max(t0, left), tl.now - spanMs * 0.05));
  };
  // while playing, the view follows the cursor
  useEffect(() => {
    const el = scroller.current;
    if (!el || !scrub.playing || scrub.at === null || pxPerMs <= 0) return;
    const cx = x(scrub.at) - el.scrollLeft;
    if (cx > viewW * FOLLOW_AT || cx < 0) el.scrollLeft = Math.max(0, x(scrub.at) - viewW * (1 - FOLLOW_AT));
  }, [scrub.at, scrub.playing, x, viewW, pxPerMs]);

  // ctrl/⌘-wheel zooms around the pointer; React's wheel listener is passive, so it cannot preventDefault
  const zoomRef = useRef(zoomTo);
  zoomRef.current = zoomTo;
  const spanRef = useRef(spanMs);
  spanRef.current = spanMs;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const viewX = e.clientX - rect.left - (labelCell.current?.offsetWidth ?? 0);
      const factor = Math.exp(clamp(e.deltaY, -60, 60) * 0.01);
      zoomRef.current(spanRef.current * factor, Math.max(0, viewX));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // scrolling re-renders once a frame
  const frame = useRef(0);
  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (scroller.current) setScrollLeft(scroller.current.scrollLeft);
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // ---- pointer: hover card, click → task, drag on empty track → pan ----
  const pan = useRef<{ id: number; x: number; left: number } | null>(null);
  const scrubbing = useRef<number | null>(null);
  const hitAt = (target: EventTarget | null) => {
    const el = (target as Element | null)?.closest?.('[data-hit]');
    return el ? (el.getAttribute('data-hit') ?? null) : null;
  };
  const timeAt = (clientX: number) => {
    const el = scroller.current!;
    return t0 + (clientX - el.getBoundingClientRect().left - labelW + el.scrollLeft) / pxPerMs;
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // the cursor: its handle, or anywhere on the axis's time area, starts a scrub (touch too)
    const target = e.target as Element;
    if (pxPerMs > 0 && (target.closest('.tlt-cursor-handle') || (target.closest('.tlt-axis') && !target.closest('.tlt-label')))) {
      scrubbing.current = e.pointerId;
      e.currentTarget.setPointerCapture(e.pointerId);
      setHover(null);
      scrub.begin(timeAt(e.clientX));
      e.preventDefault();
      return;
    }
    // touch pans natively; a bar or the repo column is not a handle
    if (e.pointerType === 'touch' || hitAt(e.target) || target.closest('.tlt-label')) return;
    pan.current = { id: e.pointerId, x: e.clientX, left: e.currentTarget.scrollLeft };
    e.currentTarget.setPointerCapture(e.pointerId);
    setPanning(true);
    setHover(null);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (scrubbing.current === e.pointerId) {
      const el = e.currentTarget;
      const viewX = e.clientX - el.getBoundingClientRect().left - labelW;
      if (viewX < 0 && el.scrollLeft > 0) {
        // past the view's left edge: each move steps the cursor back and pans the view under it
        const t = Math.min(scrub.at ?? tl.now, timeAt(el.getBoundingClientRect().left + labelW)) - spanMs * EDGE_STEP;
        el.scrollLeft = Math.max(0, x(t) - viewW * EDGE_STEP);
        scrub.move(t);
      } else {
        // left of the canvas at its very start is before the window: the hook extends it (and the view keeps its place)
        scrub.move(timeAt(e.clientX));
      }
      return;
    }
    if (pan.current) {
      e.currentTarget.scrollLeft = pan.current.left - (e.clientX - pan.current.x);
      return;
    }
    const key = hitAt(e.target);
    setHover(key ? { key, t: timeAt(e.clientX), x: e.clientX, y: e.clientY } : null);
  };
  const endPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (scrubbing.current === e.pointerId) {
      scrubbing.current = null;
      scrub.end();
      return;
    }
    if (!pan.current || pan.current.id !== e.pointerId) return;
    pan.current = null;
    setPanning(false);
  };
  const open = (target: EventTarget | null) => {
    const key = hitAt(target);
    const hit = key ? hits.get(key) : undefined;
    if (!hit) return false;
    const taskId = hit.type === 'ghost' ? hit.ghost.slot.taskId : hit.bar.taskId;
    if (!names.task(taskId)) return false;
    onOpenTask(taskId);
    return true;
  };
  const onClick = (e: ReactMouseEvent) => {
    open(e.target);
  };
  // bars and ghosts are focusable: Enter / Space opens the task like a click
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if ((e.target as Element).closest('.tlt-cursor-handle')) {
      // the cursor handle: arrows step a pinned cursor, Escape / End go back to live
      const stepMs = CURSOR_STEP * (e.shiftKey ? 10 : 1);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const t = Math.min(tl.now, (scrub.at ?? tl.now) + (e.key === 'ArrowLeft' ? -stepMs : stepMs));
        scrub.step(t);
        e.preventDefault();
        // a step that leaves the viewport brings the view along, as playback does
        const el = scroller.current;
        const cx = el && pxPerMs > 0 ? x(t) - el.scrollLeft : 0;
        if (el && (cx < 0 || cx > viewW)) el.scrollLeft = Math.max(0, x(t) - viewW * (1 - FOLLOW_AT));
      } else if (e.key === 'Escape' || e.key === 'End') {
        scrub.live();
        e.preventDefault();
      }
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && open(e.target)) e.preventDefault();
  };

  // ---- the visible window (± half a viewport) ----
  const ready = pxPerMs > 0;
  const visFrom = ready ? t0 + (scrollLeft - viewW * 0.5) / pxPerMs : 0;
  const visTo = ready ? t0 + (scrollLeft + viewW * 1.5) / pxPerMs : 0;
  const ticks = ready ? ticksFor(Math.max(t0, visFrom), visTo, pxPerMs) : [];
  const nowX = x(tl.now);
  const at = useMemo(() => stateAt(tl.segments, tl.now), [tl.segments, tl.now]);
  const hovered = hover ? hits.get(hover.key) : undefined;
  const reading = scrub.reading;
  // a cursor before the canvas (the older rows are on their way) sits at its left edge
  const cursorX = scrub.at === null ? nowX : Math.max(0, x(scrub.at));
  const held = reading?.held ?? null;

  return (
    <div className="tlt">
      <div className="tlt-bar">
        <div className="seg" role="group" aria-label="Zoom">
          {ZOOMS.map((z) => (
            <button
              key={z.key}
              type="button"
              className={`btn ${Math.abs(spanMs - z.span) < MIN ? 'primary' : ''}`}
              aria-pressed={Math.abs(spanMs - z.span) < MIN}
              onClick={() => zoomPreset(z.span)}
            >
              {z.label}
            </button>
          ))}
        </div>
        <button type="button" className={`btn${scrub.at !== null ? ' primary' : ''}`} onClick={jumpToNow} aria-label={scrub.at !== null ? 'Back to live' : 'Scroll to now'}>
          Now
        </button>
        <PlayControls scrub={scrub} onPlay={playFromView} />
        <span className="muted tlt-hint">
          {span(spanMs)} per view · ctrl/⌘-scroll to zoom, drag to pan, drag the axis to scrub, drag a ghost's grip to reorder
        </span>
        {reading ? (
          <ScrubChip chip={reading.chip} loading={reading.outside && tl.extending} />
        ) : (
          <span className="tlt-now-counts muted">
            {at.running.length} running · {at.waiting.length} waiting · {at.checking.length} checks · {at.inReview.length} in review ·{' '}
            {at.queued.length} queued
          </span>
        )}
      </div>
      <Legend />

      <div className="panel tlt-panel">
        <div
          ref={scroller}
          className={`tlt-scroller${panning ? ' panning' : ''}${held ? ' scrubbing' : ''}`}
          onScroll={onScroll}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onPointerLeave={() => !pan.current && setHover(null)}
          onClick={onClick}
          onKeyDown={onKeyDown}
        >
          <div className="tlt-canvas" style={vars({ '--tlt-w': `${totalW}px` })}>
            <div className="tlt-grid" aria-hidden>
              {ticks.map((t) => (
                <span key={t.at} className={`tlt-gridline${t.day ? ' day' : ''}`} style={{ left: x(t.at) }} />
              ))}
            </div>
            <div className="tlt-row tlt-axis">
              <div ref={labelCell} className="tlt-label">
                <span className="muted">{tl.loading ? 'loading…' : `since ${clock(tl.since, tl.now)}`}</span>
              </div>
              <div className="tlt-lanes">
                {ticks.map((t) =>
                  // the NOW pill and the cursor sit on the axis: a label they would cover is left out (its grid line stays)
                  ready && (Math.abs(x(t.at) - nowX) < NOW_PILL_CLEAR_PX || Math.abs(x(t.at) - cursorX) < NOW_PILL_CLEAR_PX) ? null : (
                    <span key={t.at} className={`tlt-tick${t.day ? ' day' : ''}`} style={{ left: x(t.at) }}>
                      {t.label}
                    </span>
                  ),
                )}
                {ready && scrub.at !== null && (
                  <span className="tlt-now-pill past" style={{ left: nowX }}>
                    {tl.live ? 'now' : 'end'}
                  </span>
                )}
                {ready && (
                  // the cursor's handle: NOW itself while live
                  <span
                    className={`tlt-now-pill tlt-cursor-handle${scrub.at !== null ? ' scrub' : ''}`}
                    style={{ left: cursorX }}
                    role="slider"
                    tabIndex={0}
                    aria-label="Time cursor: drag to scrub the past, arrows step, Escape returns to live"
                    aria-valuemin={Date.parse(tl.since)}
                    aria-valuemax={tl.now}
                    aria-valuenow={scrub.at ?? tl.now}
                    aria-valuetext={reading ? reading.chip : `live, ${clock(tl.now, tl.now)}`}
                  >
                    {scrub.at === null ? `${tl.live ? 'now' : 'end'} ${clock(tl.now, tl.now)}` : clock(scrub.at, tl.now)}
                  </span>
                )}
              </div>
            </div>
            {layout.rows.map((row) => (
              <Track
                key={row.key}
                row={row}
                x={x}
                visFrom={visFrom}
                visTo={visTo}
                ready={ready}
                now={tl.now}
                names={names}
                hoverKey={dnd.drag ? null : (hover?.key ?? null)}
                grip={dnd.gripProps}
                drop={dnd.view}
                held={held}
              />
            ))}
            {ready && <span className={`tlt-now${scrub.at !== null ? ' past' : ''}`} style={{ left: `calc(var(--tm-tl-label-w) + ${nowX}px)` }} aria-hidden />}
            {ready && scrub.at !== null && <span className="tlt-cursor" style={{ left: `calc(var(--tm-tl-label-w) + ${cursorX}px)` }} aria-hidden />}
          </div>
        </div>
      </div>

      {hover && hovered && !dnd.drag && (
        <HoverCard hit={hovered} t={hover.t} x={hover.x} y={hover.y} now={tl.now} names={names} workedMs={layout.workedMs} />
      )}

      <TimelineDragGhost drag={dnd.drag} tl={tl} />

      <NotScheduled tl={tl} names={names} onOpenTask={onOpenTask} />
    </div>
  );
}

function PlayControls({ scrub, onPlay }: { scrub: Scrub; onPlay: () => void }) {
  return (
    <>
      <button type="button" className="btn" aria-pressed={scrub.playing} onClick={() => (scrub.playing ? scrub.pause() : onPlay())}>
        {scrub.playing ? 'Pause' : 'Play'}
      </button>
      <div className="seg" role="group" aria-label="Playback speed">
        {SCRUB_SPEEDS.map((s) => (
          <button key={s} type="button" className={`btn ${scrub.speed === s ? 'primary' : ''}`} aria-pressed={scrub.speed === s} onClick={() => scrub.setSpeed(s)}>
            ×{s}
          </button>
        ))}
      </div>
    </>
  );
}

function Legend() {
  const items: [string, string, string?][] = [
    ['running', OUTCOME_COLOR.running],
    ['in review', OUTCOME_COLOR.review],
    ['done', OUTCOME_COLOR.done],
    ['published', OUTCOME_COLOR.published],
    ['failed', OUTCOME_COLOR.failed],
    ['waiting', SEGMENT_COLOR.waiting, 'sub'],
    ['review round', SEGMENT_COLOR['review-round'], 'sub'],
    ['checks', SEGMENT_COLOR.checks, 'sub'],
    ['fixing', SEGMENT_COLOR.fixing, 'sub'],
    ['idle in review', SEGMENT_COLOR['idle-in-review'], 'tail'],
    ['predicted', 'var(--tm-text-muted)', 'ghost'],
  ];
  return (
    <div className="legend tlt-legend">
      {items.map(([label, c, kind]) => (
        <span key={label}>
          <span className={`swatch tlt-swatch${kind ? ` ${kind}` : ''}`} style={vars({ '--c': c })} />
          {label}
        </span>
      ))}
    </div>
  );
}

const Track = memo(function Track({
  row,
  x,
  visFrom,
  visTo,
  ready,
  now,
  names,
  hoverKey,
  grip,
  drop,
  held,
}: {
  row: TrackRow;
  x: (t: number) => number;
  visFrom: number;
  visTo: number;
  ready: boolean;
  now: number;
  names: Lookup;
  hoverKey: string | null;
  grip: (task: Task) => TimelineGripProps;
  drop: TimelineDropView | null;
  /** scrubbing: the segment each task is in at the cursor (null = live, nothing dimmed) */
  held: ReadonlySet<TimelineSegment> | null;
}) {
  const seen = (from: number, to: number) => to >= visFrom && from <= visTo;
  const bars = ready ? row.bars.filter((b) => seen(b.start, b.extentEnd)) : [];
  const ghosts = ready ? row.ghosts.filter((g) => seen(g.start, g.end)) : [];
  const live = row.bars.filter((b) => b.live).length;
  // `n parallel` is the repo's cap; the lanes drawn can exceed it when the data really overlaps
  const meta = [row.cap > 1 ? `${row.cap} parallel` : '', live ? `${live} live` : '', row.ghosts.length ? `${row.ghosts.length} next` : ''].filter(Boolean);
  return (
    <div className={`tlt-row${row.lanes > 1 ? ' multi' : ''}`} style={vars({ '--lanes': row.lanes })}>
      <div className="tlt-label">
        <span className="tlt-repo" title={row.name}>
          {row.name}
        </span>
        <span className="tlt-label-meta muted" title={meta.join(' · ')}>
          {meta.join(' · ')}
        </span>
      </div>
      <div className="tlt-lanes">
        {Array.from({ length: row.lanes - 1 }, (_, i) => (
          <span key={i} className="tlt-lane-rule" style={vars({ '--lane': i + 1 })} aria-hidden />
        ))}
        {bars.map((b) => (
          <BarView key={b.key} b={b} x={x} now={now} names={names} hot={hoverKey === b.key || hoverKey === `m:${b.key}`} at={held ? barHeld(b, held) : null} />
        ))}
        {ghosts.map((g) => (
          <GhostView key={g.key} g={g} x={x} now={now} names={names} hot={hoverKey === g.key} grip={grip} drop={drop} />
        ))}
      </div>
    </div>
  );
});

/** the bar holds the segment its task is in at the cursor (an active part, its idle tail, or the landed marker) */
function barHeld(b: TrackBar, held: ReadonlySet<TimelineSegment>): boolean {
  return b.segs.some((s) => held.has(s)) || b.tail.some((s) => held.has(s)) || (!!b.marker && held.has(b.marker));
}

function BarView({ b, x, now, names, hot, at }: { b: TrackBar; x: (t: number) => number; now: number; names: Lookup; hot: boolean; at: boolean | null }) {
  const scrubClass = at === null ? '' : at ? ' at' : ' dim';
  const left = x(b.start);
  const width = Math.max(BAR_MIN_PX, x(b.end) - left);
  const tail = b.tail.length ? [Date.parse(b.tail[0].start), segmentEnd(b.tail[b.tail.length - 1], now)] : null;
  const clipped = b.segs[0]?.clippedStart;
  return (
    <>
      {tail && (
        <span
          className={`tlt-tail${hot ? ' hot' : ''}${scrubClass}`}
          data-hit={b.key}
          style={vars({ left: `${x(tail[0])}px`, width: `${Math.max(BAR_MIN_PX, x(tail[1]) - x(tail[0]))}px`, '--lane': b.lane })}
        />
      )}
      {b.segs.length > 0 && (
        <span
          className={`tlt-item${b.live ? ' live' : ''}${clipped ? ' clipped' : ''}${hot ? ' hot' : ''}${scrubClass}`}
          data-hit={b.key}
          role="button"
          tabIndex={0}
          aria-label={`${names.title(b.taskId)}: ${b.outcome}, ${clock(b.start, now)} → ${b.live ? 'now' : clock(b.end, now)}`}
          style={vars({ left: `${left}px`, width: `${width}px`, '--lane': b.lane, '--c': OUTCOME_COLOR[b.outcome] })}
        >
          {b.segs.map((s, i) => {
            if (s.kind === 'running') return null;
            const sl = x(Date.parse(s.start)) - left;
            const sw = x(segmentEnd(s, now)) - left - sl;
            if (sw < 1) return null;
            return <span key={i} className="tlt-sub" style={vars({ left: `${sl}px`, width: `${sw}px`, '--k': SEGMENT_COLOR[s.kind] })} />;
          })}
          {width >= LABEL_MIN_PX && <span className="tlt-item-label">{names.title(b.taskId)}</span>}
        </span>
      )}
      {b.marker && (
        <span
          className={`tlt-marker ${b.marker.kind}${hot ? ' hot' : ''}${scrubClass}`}
          data-hit={`m:${b.key}`}
          style={vars({ left: `${x(Date.parse(b.marker.start))}px`, '--lane': b.lane, '--c': OUTCOME_COLOR[b.outcome] })}
        />
      )}
    </>
  );
}

/** ETA first, then why it waited, then the title — a continuation's title is on the live bar beside it */
function ghostLabel(g: TrackGhost, now: number, names: Lookup): string {
  const p = g.slot;
  const continues = p.source === 'running';
  const eta = continues ? `ends ~${clock(g.end, now)}` : `~${clock(g.start, now)} → ${clock(g.end, now)}`;
  const why = p.waits.length ? p.waits[p.waits.length - 1].text : null;
  return [eta, why, continues ? null : names.title(p.taskId)].filter(Boolean).join(' · ');
}

function GhostView({
  g,
  x,
  now,
  names,
  hot,
  grip,
  drop,
}: {
  g: TrackGhost;
  x: (t: number) => number;
  now: number;
  names: Lookup;
  hot: boolean;
  grip: (task: Task) => TimelineGripProps;
  drop: TimelineDropView | null;
}) {
  const task = names.task(g.slot.taskId);
  const draggable = slotDraggable(g.slot, task);
  const left = x(g.start);
  const width = Math.max(draggable ? GRIP_MIN_PX : BAR_MIN_PX, x(g.end) - left);
  return (
    <span
      className={`tlt-ghost${g.slot.source === 'running' ? ' continues' : ''}${draggable ? ' draggable' : ''}${hot ? ' hot' : ''}${dropClassFor(drop, g.slot.taskId)}`}
      data-hit={g.key}
      data-tl-drop={draggable ? g.slot.taskId : undefined}
      role="button"
      tabIndex={0}
      aria-label={`${names.title(g.slot.taskId)}, predicted: ${ghostLabel(g, now, names)}`}
      style={vars({ left: `${left}px`, width: `${width}px`, '--lane': g.lane })}
    >
      {g.slot.after.map((a) => {
        const sl = x(Date.parse(a.start)) - left;
        const sw = x(Date.parse(a.end)) - left - sl;
        return sw < 1 ? null : <span key={a.kind} className="tlt-ghost-after" style={vars({ left: `${sl}px`, width: `${sw}px`, '--k': AFTER_COLOR[a.kind] })} />;
      })}
      {draggable && task && (
        <span className="tl-grip" title="Drag beside another predicted task to reorder the queue" aria-hidden="true" {...grip(task)}>
          <IconGrip />
        </span>
      )}
      {width >= LABEL_MIN_PX && <span className="tlt-item-label">{ghostLabel(g, now, names)}</span>}
    </span>
  );
}

/** a short, human reason off a segment: the error / reason the fold kept, else how it ended */
function segmentReason(data: Record<string, unknown>): string | null {
  for (const k of ['error', 'reason', 'expired', 'stale']) {
    const v = data[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function HoverCard({
  hit,
  t,
  x,
  y,
  now,
  names,
  workedMs,
}: {
  hit: Hit;
  t: number;
  x: number;
  y: number;
  now: number;
  names: Lookup;
  workedMs: Record<string, number>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const gap = 14;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = x + gap + w > window.innerWidth - gap ? Math.max(gap, x - gap - w) : x + gap;
    const top = y + gap + h > window.innerHeight - gap ? Math.max(gap, y - gap - h) : y + gap;
    setPos({ left, top });
  }, [x, y, hit]);

  const taskId = hit.type === 'ghost' ? hit.ghost.slot.taskId : hit.bar.taskId;
  const task = names.task(taskId);
  const worked = workedMs[taskId];
  const lines: [string, string][] = [];
  let kind: string;
  let colour: string;
  if (hit.type === 'ghost') {
    const p = hit.ghost.slot as Extract<PredictedSlot, { scheduled: true }>;
    kind = `predicted · ${SOURCE_LABEL[p.source]}`;
    colour = 'var(--tm-text-muted)';
    lines.push(['when', slotWhen(p, now) ?? '']);
    lines.push([
      'work',
      `${span(Date.parse(p.end) - Date.parse(p.start))}${p.after.map((a) => ` → ${AFTER_LABEL[a.kind]} ${span(Date.parse(a.end) - Date.parse(a.start))}`).join('')} → ${p.lands}`,
    ]);
    if (p.lane !== null) lines.push(['worker', `lane ${p.lane + 1}`]);
    if (worked) lines.push(['worked', `${span(worked)} so far`]);
    for (const w of p.waits) lines.push(['waited', w.text]);
  } else {
    const s = hit.type === 'marker' ? hit.bar.marker! : segmentAt(hit.bar, t, now);
    kind = SEGMENT_LABEL[s.kind];
    colour = SEGMENT_COLOR[s.kind];
    lines.push(['when', `${s.clippedStart ? '… ' : ''}${segmentWhen(s, now)}`]);
    if (s.kind === 'landed' && s.data.status === 'published' && typeof s.data.publishedAt === 'string') {
      lines.push(['published', `${clock(s.data.publishedAt, now)} (${relative(s.data.publishedAt, now)})`]);
    }
    if (hit.bar.segs.length) lines.push(['turn', `${clock(hit.bar.start, now)} → ${hit.bar.live ? 'now' : clock(hit.bar.end, now)}`]);
    if (worked) lines.push(['worked', `${span(worked)}${hit.bar.segs[0]?.clippedStart ? ' in this window' : ''}`]);
    if (s.outcome) lines.push([s.kind === 'failed' || s.kind === 'cancelled' ? 'reason' : 'then', s.outcome]);
    const why = segmentReason(s.data);
    if (why && why !== s.outcome) lines.push(['reason', why]);
  }
  return (
    <div ref={ref} className="tlt-card" role="tooltip" style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}>
      <div className="tlt-card-title">{names.title(taskId)}</div>
      <div className="tlt-card-meta">
        <span className="tlt-card-kind" style={vars({ '--c': colour })}>
          {kind}
        </span>
        <span className="chip">{task?.status ?? 'gone'}</span>
        {task?.repoId && <span className="muted">{names.repo(task.repoId)}</span>}
      </div>
      <dl className="tlt-card-lines">
        {lines.map(([k, v], i) => (
          <div key={i}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {task && <div className="tlt-card-foot muted">click to open</div>}
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

export function NowBlock({ tl, names, onOpenTask }: { tl: UseTimeline; names: Lookup; onOpenTask: (id: string) => void }) {
  const at = useMemo(() => stateAt(tl.segments, tl.now), [tl.segments, tl.now]);
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
      <NotScheduled tl={tl} names={names} onOpenTask={onOpenTask} />
    </>
  );
}

/** what is not scheduled, and the reason it waits */
export function NotScheduled({ tl, names, onOpenTask }: { tl: UseTimeline; names: Lookup; onOpenTask: (id: string) => void }) {
  const waiting = tl.predicted.filter((p) => !p.scheduled);
  if (!waiting.length) return null;
  return (
    <>
      <div className="section-head">
        Not scheduled <span className="count">{waiting.length}</span>
      </div>
      <SlotList slots={waiting} tl={tl} names={names} onOpenTask={onOpenTask} />
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
