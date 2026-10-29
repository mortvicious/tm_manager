import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { segmentAt, stateAt, TIMELINE_MAX_DAYS, type TimelineSegment, type TimelineStateAt } from '@tm/shared';
import type { UseTimeline } from '../../timeline.ts';
import { clock } from './format.ts';

/**
 * The time cursor both timeline views share (docs/timeline.md § Scrub and
 * playback). `at === null` is LIVE: the cursor is NOW. A drag scrubs the
 * past and returns to live on release; a playback session (play, pause, or a
 * keyboard step) PINS the cursor, so it stays where it was left until NOW is
 * pressed or the playback reaches NOW. What the cursor reads is the shared
 * `stateAt` over the hook's segments — the same buckets the live counts use.
 */

export const SCRUB_SPEEDS = [1, 10, 60, 600] as const;
export type ScrubSpeed = (typeof SCRUB_SPEEDS)[number];

const DAY = 24 * 3600_000;

export interface ScrubReading {
  at: number;
  state: TimelineStateAt;
  /** the segment each task is in at T, for the buckets drawn (running/waiting/checks/review/landed) */
  held: ReadonlySet<TimelineSegment>;
  /** '14:20 — 2 running, 1 in review, 5 landed' */
  chip: string;
  /** T is before the loaded window: the older rows are being fetched */
  outside: boolean;
}

export interface Scrub {
  /** epoch ms of the cursor; null = live (NOW) */
  at: number | null;
  dragging: boolean;
  playing: boolean;
  /** the cursor is pinned (playback playing or paused, or a keyboard step) */
  pinned: boolean;
  speed: ScrubSpeed;
  /** the earliest instant the cursor may reach (TIMELINE_MAX_DAYS back) */
  floor: number;
  begin(t: number): void;
  move(t: number): void;
  end(): void;
  /** move a pinned cursor (keyboard): pins it if it was not */
  step(t: number): void;
  /** play from `from` — or from the pinned cursor when a session is paused */
  play(from: number): void;
  pause(): void;
  setSpeed(s: ScrubSpeed): void;
  live(): void;
  /** the reading at the cursor; null while live */
  reading: ScrubReading | null;
}

/** the buckets a scrub highlights and counts, in chip order */
const CHIP: [keyof TimelineStateAt, string][] = [
  ['running', 'running'],
  ['waiting', 'waiting'],
  ['checking', 'checking'],
  ['inReview', 'in review'],
  ['landed', 'landed'],
];

export function chipText(at: number, state: TimelineStateAt, now: number): string {
  const parts = CHIP.filter(([k]) => state[k].length > 0).map(([k, l]) => `${state[k].length} ${l}`);
  return `${clock(at, now)} — ${parts.join(', ') || 'nothing live'}`;
}

export function useScrub(tl: UseTimeline): Scrub {
  const [at, setAt] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [speed, setSpeed] = useState<ScrubSpeed>(60);
  const atRef = useRef<number | null>(null);
  const pinnedRef = useRef(false);
  const ensure = useRef(tl.ensureCovered);
  ensure.current = tl.ensureCovered;

  const floor = tl.now - TIMELINE_MAX_DAYS * DAY + 60_000;
  const floorRef = useRef(floor);
  floorRef.current = floor;

  /** clamp to [floor, real NOW] and ask the hook to cover it (a no-op inside the window) */
  const put = useCallback((t: number) => {
    if (!Number.isFinite(t)) return;
    const v = Math.min(Date.now(), Math.max(floorRef.current, t));
    atRef.current = v;
    setAt(v);
    ensure.current(v);
  }, []);

  const live = useCallback(() => {
    atRef.current = null;
    pinnedRef.current = false;
    setAt(null);
    setDragging(false);
    setPlaying(false);
    setPinned(false);
  }, []);

  const begin = useCallback(
    (t: number) => {
      setDragging(true);
      put(t);
    },
    [put],
  );
  const move = useCallback((t: number) => put(t), [put]);
  const end = useCallback(() => {
    setDragging(false);
    // a drag is a look; a pinned session keeps the point it was dragged to
    if (!pinnedRef.current) live();
  }, [live]);
  const step = useCallback(
    (t: number) => {
      pinnedRef.current = true;
      setPinned(true);
      setPlaying(false);
      put(t);
    },
    [put],
  );
  const play = useCallback(
    (from: number) => {
      const start = pinnedRef.current && atRef.current !== null ? atRef.current : from;
      pinnedRef.current = true;
      setPinned(true);
      put(start);
      setPlaying(true);
    },
    [put],
  );
  const pause = useCallback(() => setPlaying(false), []);

  // playback: real elapsed time × speed per frame, stopping at NOW (→ live)
  const speedRef = useRef(speed);
  speedRef.current = speed;
  useEffect(() => {
    if (!playing || dragging) return;
    let raf = 0;
    let last = performance.now();
    const tick = (frameAt: number) => {
      const dt = frameAt - last;
      last = frameAt;
      const cur = atRef.current;
      if (cur === null) return;
      const next = cur + dt * speedRef.current;
      if (next >= Date.now()) {
        live();
        return;
      }
      put(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, dragging, put, live]);

  // a new window (range or workspace) starts live
  useEffect(() => live(), [tl.origin, live]);

  const sinceMs = Date.parse(tl.since);
  const state = useMemo(() => (at === null ? null : stateAt(tl.segments, at)), [tl.segments, at]);
  // the held segments, kept by identity while the set is the same, so memoised rows do not re-render every frame
  const heldRef = useRef<{ sig: string; set: ReadonlySet<TimelineSegment> }>({ sig: '', set: new Set() });
  const held = useMemo(() => {
    if (at === null || !state) return heldRef.current.set;
    const ids = CHIP.flatMap(([k]) => state[k]);
    const segs: TimelineSegment[] = [];
    for (const id of ids) {
      const s = segmentAt(tl.segments[id] ?? [], at);
      if (s) segs.push(s);
    }
    const sig = segs.map((s) => `${s.taskId}|${s.start}|${s.kind}`).join(',');
    if (sig !== heldRef.current.sig || segs.some((s) => !heldRef.current.set.has(s))) heldRef.current = { sig, set: new Set(segs) };
    return heldRef.current.set;
  }, [tl.segments, at, state]);

  const reading = useMemo<ScrubReading | null>(
    () => (at === null || !state ? null : { at, state, held, chip: chipText(at, state, tl.now), outside: at < sinceMs }),
    [at, state, held, tl.now, sinceMs],
  );

  return { at, dragging, playing, pinned, speed, floor, begin, move, end, step, play, pause, setSpeed, live, reading };
}

/** what the cursor reads at T; shared by both views */
export function ScrubChip({ chip, loading }: { chip: string; loading: boolean }) {
  return (
    <span className="tl-scrub-chip" role="status" aria-live="polite">
      {chip}
      {loading && <span className="muted"> · loading earlier…</span>}
    </span>
  );
}
