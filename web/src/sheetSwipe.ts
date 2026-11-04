import type { PointerEvent as ReactPointerEvent } from 'react';
import { setDragLock, type DragControls } from 'motion/react';

/**
 * A sideways swipe on a card inside a `<Sheet>` (docs/mobile.md § Sideways
 * gestures inside a sheet): shared by the Review deck and the phone draft
 * triage stack.
 */

/** A press inside a box that scrolls sideways (a diff's long lines) or a field scrolls/types, never swipes the card. */
export function inSideScroller(target: EventTarget | null, stop: Element | null): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== stop; el = el.parentElement) {
    if (el.closest('input, textarea, select')) return true;
    if (el.scrollWidth > el.clientWidth + 1) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
  }
  return false;
}

/** How far (px) or how fast (px/s) a release must go to count as a swipe. */
export const SWIPE_PX = 72;
export const SWIPE_VELOCITY = 400;

/** a fast release decides only once the card has moved this far its own way */
export const FLICK_MIN_PX = 24;

/**
 * Which way a DECIDING release goes (the draft triage stack; the Review
 * deck's swipe only navigates and keeps its plain rule): 1 = the right action, -1 = Cancel, 0 = spring
 * back. Never the opposite of where the card is: a flick counts only in the
 * direction of the offset and past FLICK_MIN_PX, so pulling a half-swipe back
 * fast to abort it, or a twitch, decides nothing.
 */
export function swipeSide(dx: number, v: number): -1 | 0 | 1 {
  const flick = Math.abs(dx) >= FLICK_MIN_PX && Math.sign(v) === Math.sign(dx) && Math.abs(v) > SWIPE_VELOCITY;
  if (dx > 0 && (dx > SWIPE_PX || flick)) return 1;
  if (dx < 0 && (dx < -SWIPE_PX || flick)) return -1;
  return 0;
}

/**
 * Start the card's 'x' drag from a pointerdown. The sheet drags on 'y' and the
 * card on 'x', and motion keeps one lock per axis, so both would follow one
 * finger: a sideways swipe would also tug the sheet down. The first move past
 * motion's 3 px start threshold decides — sideways takes the 'y' lock before
 * the sheet's drag can start (a capture listener runs ahead of motion's own),
 * so only the card moves; downwards leaves it to the sheet, and the card's
 * direction lock keeps it still.
 */
export function startSideSwipe(e: ReactPointerEvent, drag: DragControls): void {
  const x0 = e.clientX;
  const y0 = e.clientY;
  let decided = false;
  let release: (() => void) | null = null;
  const move = (ev: PointerEvent) => {
    if (decided) return;
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    if (Math.hypot(dx, dy) < 3) return;
    decided = true;
    if (Math.abs(dx) > Math.abs(dy)) release = setDragLock('y');
  };
  const end = () => {
    release?.();
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', end, true);
    window.removeEventListener('pointercancel', end, true);
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);
  drag.start(e);
}
