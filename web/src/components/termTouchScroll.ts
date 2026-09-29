import type { Terminal } from '@xterm/xterm';

/**
 * One-finger touch scrolling for an xterm.js terminal (docs/mobile.md §
 * Terminal scrolling).
 *
 * xterm 6 replaced its native-overflow viewport with VS Code's scrollable
 * element, which listens to `wheel` only: a finger dragged over the terminal on
 * a phone scrolls nothing. This turns a vertical drag into scrolling:
 *
 * - normal buffer (Claude Code's inline TUI, a shell): `term.scrollLines`, so
 *   the scrollback moves exactly as the mouse wheel would move it;
 * - alternate buffer (a full-screen TUI: less, vim, htop): there is no
 *   scrollback to move, so a synthetic `wheel` goes to xterm's own wheel path,
 *   which reports it to the app when it tracks the mouse and otherwise turns it
 *   into arrow keys — the same thing a desktop wheel does there.
 *
 * A tap stays a tap: nothing is prevented until the finger has moved past
 * `SLOP`, so tapping still focuses the terminal and raises the keyboard. A
 * flick keeps coasting and decays, like a native scroller. Two fingers are
 * left alone (pinch zoom belongs to the browser).
 */
const SLOP = 8; // px before a touch counts as a drag
const FRICTION = 0.95; // per 16ms frame
const MIN_VELOCITY = 0.02; // px/ms below which a fling stops

export function attachTouchScroll(term: Terminal, host: HTMLElement): () => void {
  let startY = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0; // px/ms, positive = finger moving down
  let dragging = false;
  let tracking = false;
  let carry = 0; // sub-line remainder, in px
  let raf = 0;

  const lineHeight = () => {
    const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null;
    const h = screen?.clientHeight ?? host.clientHeight;
    return term.rows > 0 && h > 0 ? h / term.rows : 16;
  };

  /** Scrolls by a finger movement of `dy` px (positive = finger down = back in history). */
  const scrollBy = (dy: number) => {
    carry += dy;
    const lh = lineHeight();
    const lines = Math.trunc(carry / lh);
    if (lines === 0) return;
    carry -= lines * lh;
    if (term.buffer.active.type === 'alternate') {
      term.element?.querySelector('.xterm-screen')?.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: -lines,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          bubbles: true,
          cancelable: true,
        }),
      );
    } else {
      term.scrollLines(-lines);
    }
  };

  const stopFling = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  const fling = () => {
    let prev = performance.now();
    const step = (now: number) => {
      const dt = Math.min(now - prev, 64);
      prev = now;
      velocity *= Math.pow(FRICTION, dt / 16);
      if (Math.abs(velocity) < MIN_VELOCITY) {
        raf = 0;
        return;
      }
      scrollBy(velocity * dt);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };

  const onStart = (e: TouchEvent) => {
    stopFling();
    if (e.touches.length !== 1) {
      tracking = false;
      dragging = false;
      return;
    }
    tracking = true;
    dragging = false;
    carry = 0;
    velocity = 0;
    startY = lastY = e.touches[0].clientY;
    lastT = e.timeStamp;
  };

  const onMove = (e: TouchEvent) => {
    if (!tracking || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    if (!dragging) {
      if (Math.abs(y - startY) < SLOP) return;
      dragging = true;
      lastY = y; // no jump by the slop distance
    }
    // the page (and iOS's rubber band) must not scroll along with the terminal
    if (e.cancelable) e.preventDefault();
    const dy = y - lastY;
    const dt = Math.max(e.timeStamp - lastT, 1);
    // smoothed, so one jittery sample does not decide the fling
    velocity = 0.8 * (dy / dt) + 0.2 * velocity;
    lastY = y;
    lastT = e.timeStamp;
    scrollBy(dy);
  };

  const onEnd = (e: TouchEvent) => {
    if (!tracking) return;
    tracking = false;
    if (!dragging) return;
    dragging = false;
    // the drag was a scroll, not a tap: no synthetic click/focus afterwards
    if (e.cancelable) e.preventDefault();
    // a finger that stopped before lifting does not fling
    if (e.timeStamp - lastT < 100) fling();
  };

  const onCancel = () => {
    tracking = false;
    dragging = false;
  };

  // capture + non-passive: this runs before xterm's own handlers and may
  // preventDefault the page scroll
  const opts: AddEventListenerOptions = { capture: true, passive: false };
  host.addEventListener('touchstart', onStart, opts);
  host.addEventListener('touchmove', onMove, opts);
  host.addEventListener('touchend', onEnd, opts);
  host.addEventListener('touchcancel', onCancel, opts);
  return () => {
    stopFling();
    host.removeEventListener('touchstart', onStart, opts);
    host.removeEventListener('touchmove', onMove, opts);
    host.removeEventListener('touchend', onEnd, opts);
    host.removeEventListener('touchcancel', onCancel, opts);
  };
}
