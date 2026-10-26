import { useSyncExternalStore } from 'react';

/**
 * The desktop terminal drawer's geometry, remembered per browser
 * (docs/design.md § Terminal drawer, UX review #18):
 * - its height when it sits at the bottom (drag its top edge), `tm.term.height`;
 * - its width when docked right (drag its left edge), `tm.term.width`;
 * - where it sits, `tm.term.dock`: `bottom`, or `right` — honoured only on a
 *   window of DOCK_MIN_PX or more, where it docks right of the task panel so a
 *   task and its live terminal read side by side.
 * Sizes are pixels, written to `--tm-term-h` / `--tm-term-w` on <html> while a
 * drawer is open so `.main` can make room for it (theme.css); with no drawer
 * the stylesheet defaults stand. Phones never read any of this.
 */
export type TermDock = 'bottom' | 'right';
export const DOCK_MIN_PX = 1600;

const H_KEY = 'tm.term.height';
const W_KEY = 'tm.term.width';
const DOCK_KEY = 'tm.term.dock';

const readPref = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writePref = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode / quota */
  }
};

/** the drawer never shrinks below a usable terminal, nor buries the page */
export function clampHeight(px: number): number {
  return Math.round(Math.min(Math.max(px, 160), Math.max(160, window.innerHeight - 120)));
}
/** docked: never narrower than a readable terminal, never more than half the window */
export function clampWidth(px: number): number {
  return Math.round(Math.min(Math.max(px, 420), Math.max(420, window.innerWidth * 0.5)));
}

const savedNumber = (key: string): number | null => {
  const n = Number(readPref(key));
  return readPref(key) !== null && Number.isFinite(n) && n > 0 ? n : null;
};
/** null = the stylesheet's default (46vh tall / min(720px, 38vw) wide) */
export const savedHeight = () => savedNumber(H_KEY);
export const savedWidth = () => savedNumber(W_KEY);
export const saveHeight = (px: number | null) => writePref(H_KEY, px === null ? null : String(px));
export const saveWidth = (px: number | null) => writePref(W_KEY, px === null ? null : String(px));

// ---- the dock preference + the wide-window query, as one external store ----

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let dock: TermDock = readPref(DOCK_KEY) === 'right' ? 'right' : 'bottom';

export function setTermDock(next: TermDock) {
  dock = next;
  writePref(DOCK_KEY, next);
  emit();
}

const wideQuery = typeof window !== 'undefined' ? window.matchMedia?.(`(min-width: ${DOCK_MIN_PX}px)`) : undefined;
wideQuery?.addEventListener?.('change', emit);

function subscribe(l: () => void) {
  listeners.add(l);
  // another tab moved the drawer
  const onStorage = (e: StorageEvent) => {
    if (e.key !== DOCK_KEY) return;
    dock = e.newValue === 'right' ? 'right' : 'bottom';
    l();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', onStorage);
  };
}

/** `canDock`: the window is wide enough; `docked`: it is, and the user chose right */
export function useTermDock(): { dock: TermDock; canDock: boolean; docked: boolean } {
  const d = useSyncExternalStore(subscribe, () => dock);
  const canDock = useSyncExternalStore(subscribe, () => !!wideQuery?.matches);
  return { dock: d, canDock, docked: canDock && d === 'right' };
}
