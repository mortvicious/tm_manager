/**
 * How THIS DEVICE looks (docs/glass.md): the design layer, `classic` (the
 * original sheet) or `glass` (the iOS Liquid Glass layer in glass.css), and
 * the colour scheme, `light`/`dark` pinned or following the system.
 *
 * Both live in localStorage, never in tm_config, so the phone can run Glass
 * while the desktop stays Classic. index.html carries an inline twin of
 * `resolve()` so the first paint is already right: keep the keys, the defaults
 * and the attribute names in step with it.
 */
import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

export type Design = 'classic' | 'glass';
export type SchemePref = 'system' | 'light' | 'dark';
export type Scheme = 'light' | 'dark';

export interface Look {
  design: Design;
  /** What was picked. `system` = nothing stored. */
  pref: SchemePref;
  /** What is on screen. */
  scheme: Scheme;
}

const DESIGN_KEY = 'tm.design';
/** The original theme toggle's key: an explicit light/dark pick. Unset = follow the system. */
const SCHEME_KEY = 'tm.theme';

const systemLight =
  typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

/** This tab's picks, so a pick applies even when storage refuses it (blocked, full). */
const picked = new Map<string, string | null>();

function stored(key: string): string | null {
  if (picked.has(key)) return picked.get(key) ?? null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null) {
  picked.set(key, value);
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // the pick still applies, from `picked`, until reload
  }
}

function resolve(): Look {
  const design: Design = stored(DESIGN_KEY) === 'classic' ? 'classic' : 'glass';
  const raw = stored(SCHEME_KEY);
  const pref: SchemePref = raw === 'light' || raw === 'dark' ? raw : 'system';
  // no media query support reads as dark, the old default
  const scheme: Scheme = pref === 'system' ? (systemLight?.matches ? 'light' : 'dark') : pref;
  return { design, pref, scheme };
}

let look = resolve();
const listeners = new Set<() => void>();

function paint(l: Look) {
  const root = document.documentElement;
  root.dataset.design = l.design;
  root.dataset.theme = l.scheme;
}

function same(a: Look, b: Look) {
  return a.design === b.design && a.pref === b.pref && a.scheme === b.scheme;
}

function refresh(animate: boolean) {
  const next = resolve();
  if (same(next, look)) return;
  const commit = () => {
    // re-read: a view transition runs this a frame later, after any newer pick
    const now = resolve();
    if (same(now, look)) return;
    look = now;
    paint(now);
    // flushed inside the transition so its "after" snapshot includes React's
    // re-render (Glass drops nav entries), not only the attribute change
    flushSync(() => listeners.forEach((fn) => fn()));
  };
  // A switch that involves Glass repaints every surface at once: cross-fade it
  // (View Transitions, Safari 18+) unless motion is reduced. A Classic-only
  // scheme flip stays as it always was.
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const glass = look.design === 'glass' || next.design === 'glass';
  if (animate && glass && doc.startViewTransition && !still && document.visibilityState === 'visible') {
    doc.startViewTransition(commit);
  } else {
    commit();
  }
}

export function setDesign(d: Design) {
  store(DESIGN_KEY, d);
  refresh(true);
}

/** `system` clears the pin, so the device follows the OS again. */
export function setSchemePref(p: SchemePref) {
  store(SCHEME_KEY, p === 'system' ? null : p);
  refresh(true);
}

/** The header button: flips what is on screen and pins it. Only an explicit pick is ever stored (R9). */
export function toggleScheme() {
  // resolve(), not `look`: a pick still inside its view transition counts
  setSchemePref(resolve().scheme === 'dark' ? 'light' : 'dark');
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useLook(): Look {
  return useSyncExternalStore(subscribe, () => look);
}

// Follow the system live, and pick up another tab's choice.
systemLight?.addEventListener('change', () => refresh(true));
window.addEventListener('storage', (e) => {
  if (e.key !== null && e.key !== DESIGN_KEY && e.key !== SCHEME_KEY) return;
  // another tab wrote storage, so storage is the truth again
  if (e.key === null) picked.clear();
  else picked.delete(e.key);
  refresh(false);
});
paint(look);
