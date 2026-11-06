import { useSyncExternalStore } from 'react';

/**
 * ONE clock for the whole SPA (docs/spa-performance.md § Shared clock).
 *
 * Every ticking thing on screen (row ages, live elapsed timers, the timeline's
 * NOW, the history tab's open steps) subscribes here with the period it needs
 * instead of owning a `setInterval`. There is one `setTimeout` at a time, armed
 * for the next boundary of the shortest period anyone is subscribed to, and
 * every subscriber of a period is told in the same task — so one tick is one
 * React render pass, not one per row.
 *
 * Paused while the document is hidden (a minimised or fully covered window, a
 * background tab, the PWA in the app switcher): nothing ticks, and on the way
 * back every period ticks at once so no age is shown stale.
 *
 * Boundaries are aligned to the wall clock (`now - now % period`), so two
 * components on the same period always agree, and a subscriber that mounts
 * between ticks reads the period's last tick — at most one period old, the
 * same staleness a per-component interval had.
 */

type Listener = () => void;

interface Period {
  listeners: Set<Listener>;
  /** the value handed to readers: Date.now() at the period's last tick */
  now: number;
  /** wall-clock bucket of the last tick (`floor(now / ms)`) */
  bucket: number;
}

const periods = new Map<number, Period>();
let timer: ReturnType<typeof setTimeout> | null = null;

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

function arm(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (periods.size === 0 || hidden()) return;
  const now = Date.now();
  let next = Infinity;
  for (const ms of periods.keys()) next = Math.min(next, (Math.floor(now / ms) + 1) * ms);
  // +5 ms so the timer never fires a hair before the boundary it was armed for
  timer = setTimeout(fire, Math.max(0, next - now) + 5);
}

function fire(force = false): void {
  timer = null;
  const now = Date.now();
  const due: Listener[] = [];
  for (const [ms, p] of periods) {
    const bucket = Math.floor(now / ms);
    if (!force && bucket === p.bucket) continue;
    p.bucket = bucket;
    p.now = now;
    due.push(...p.listeners);
  }
  for (const l of due) l();
  arm();
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (hidden()) arm(); // clears the timer
    else fire(true);
  });
}

function periodOf(ms: number): Period {
  let p = periods.get(ms);
  if (!p) {
    const now = Date.now();
    p = { listeners: new Set(), now, bucket: Math.floor(now / ms) };
    periods.set(ms, p);
  }
  return p;
}

function subscribe(ms: number, l: Listener): () => void {
  const fresh = !periods.has(ms);
  periodOf(ms).listeners.add(l);
  if (fresh) arm();
  return () => {
    const p = periods.get(ms);
    if (!p) return;
    p.listeners.delete(l);
    if (p.listeners.size === 0) {
      periods.delete(ms);
      arm();
    }
  };
}

// Stable subscribe/getSnapshot pairs per period, so useSyncExternalStore does
// not resubscribe on every render.
const hooks = new Map<number, { sub: (l: Listener) => () => void; get: () => number }>();
// What a period nobody is subscribed to reads (a first render). Cached, because
// getSnapshot must return the same value on consecutive calls; a stale seed is
// harmless — subscribing creates the period with a fresh `now`, and
// useSyncExternalStore re-renders when the snapshot moved under it.
const seeds = new Map<number, number>();
function seed(ms: number): number {
  let s = seeds.get(ms);
  if (s === undefined) {
    s = Date.now();
    seeds.set(ms, s);
  }
  return s;
}
function hooksFor(ms: number) {
  let h = hooks.get(ms);
  if (!h) {
    h = {
      sub: (l) => {
        seeds.delete(ms);
        return subscribe(ms, l);
      },
      get: () => periods.get(ms)?.now ?? seed(ms),
    };
    hooks.set(ms, h);
  }
  return h;
}

const OFF = { sub: () => () => {}, get: () => 0 };

/**
 * `Date.now()` as of the last tick of a `ms` period, re-rendering the caller on
 * every tick. `ms <= 0` (or `on === false`) is "no clock": the hook returns the
 * time of its first read and never re-renders the caller.
 */
export function useClock(ms: number, on = true): number {
  const h = on && ms > 0 ? hooksFor(ms) : OFF;
  const v = useSyncExternalStore(h.sub, h.get, h.get);
  return h === OFF ? frozenNow() : v;
}

// `useClock(…, false)` still has to return a plausible "now" for a caller that
// renders with it (an Elapsed whose fine clock is off falls back to the coarse
// one). Re-read on every call: no subscription, so nothing re-renders on it.
const frozenNow = () => Date.now();

/**
 * The same clock outside a render: `fn` runs on every tick of a `ms` period
 * (and once when a hidden document comes back). Returns the unsubscribe —
 * the shape a `useEffect` cleanup wants.
 */
export function onTick(ms: number, fn: () => void): () => void {
  return subscribe(ms, fn);
}

/** test seam: the number of live periods and whether a timer is armed */
export function clockState(): { periods: number[]; armed: boolean } {
  return { periods: [...periods.keys()].sort((a, b) => a - b), armed: timer !== null };
}
