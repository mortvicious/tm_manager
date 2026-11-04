import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

/**
 * Swipe a phone row (docs/mobile.md § Row swipe): a horizontal swipe from the
 * row body slides the row over and reveals its actions — the trailing side
 * (swipe left) holds the next step, the leading side (swipe right) Hide. The
 * row then STAYS open and a tap on a revealed button acts: nothing fires on
 * release, because the trailing side may hold Publish, which pushes.
 *
 * Pointer events on the row, never the HTML5 drag API (dead on iOS touch):
 * the row is `touch-action: pan-y`, so the browser keeps vertical scrolling
 * (and cancels the pointer when it takes it) while a horizontal move comes to
 * us. A move is ours only once it is clearly horizontal (`SLOP`, `RATIO`); a
 * press on the drag grip (components/TaskDrag.tsx) is never a swipe. One row
 * is open at a time, and a tap anywhere else closes it.
 */

/** width of one revealed button — the touch target, ≥ 44px */
export const SWIPE_ACTION_W = 84;
const SLOP = 10;
/** |dx| must beat |dy| by this much before the move counts as a swipe */
const RATIO = 1.5;
/** past this much of a side's width the release opens it, else it closes */
const OPEN_AT = 0.4;
/** the CSS slide back (theme.css `.swipe-open`); the buttons stay drawn under it */
const SETTLE_MS = 220;

// the one open row, across every board list
let openKey: string | null = null;
const closers = new Map<string, () => void>();
function claimOpen(key: string) {
  if (openKey && openKey !== key) closers.get(openKey)?.();
  openKey = key;
}

export interface SwipeSide {
  /** the buttons, each `SWIPE_ACTION_W` wide */
  count: number;
  render: (close: () => void) => ReactNode;
}

export function useRowSwipe(key: string, lead: SwipeSide | null, trail: SwipeSide | null, enabled: boolean) {
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  // the side whose buttons are drawn: it outlives x = 0 by the slide back
  const [shown, setShown] = useState<'lead' | 'trail' | null>(null);
  const st = useRef<{ id: number; x0: number; y0: number; from: number; locked: boolean } | null>(null);
  // a swipe (or the tap that closed an open row) must not also open the task
  const swallowClick = useRef(false);
  const rowRef = useRef<HTMLElement | null>(null);
  // a swipe on iOS may end with no click at all: the mark must not outlive the gesture
  const swallow = () => {
    swallowClick.current = true;
    setTimeout(() => (swallowClick.current = false), 400);
  };
  const leadW = lead ? lead.count * SWIPE_ACTION_W : 0;
  const trailW = trail ? trail.count * SWIPE_ACTION_W : 0;

  const close = () => setX(0);
  useEffect(() => {
    closers.set(key, close);
    return () => {
      closers.delete(key);
      if (openKey === key) openKey = null;
    };
  }, [key]);
  // open: a press anywhere outside the row closes it (a press inside is the row's own business)
  useEffect(() => {
    if (x === 0 || dragging) return;
    const onDown = (e: PointerEvent) => {
      if (rowRef.current && e.target instanceof Node && rowRef.current.contains(e.target)) return;
      setX(0);
      // that tap only closes the row, as on iOS: its click must not also open what lies under it
      const eat = (c: MouseEvent) => {
        c.stopPropagation();
        c.preventDefault();
      };
      document.addEventListener('click', eat, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', eat, { capture: true }), 400);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [x, dragging]);
  // a side that went away (status changed under an open row) closes it
  useEffect(() => {
    if ((x > 0 && !leadW) || (x < 0 && !trailW)) setX(0);
  }, [x, leadW, trailW]);
  useEffect(() => {
    if (!enabled) setX(0);
  }, [enabled]);
  useEffect(() => {
    if (x === 0 && openKey === key) openKey = null;
  }, [x, key]);
  useEffect(() => {
    if (x > 0) setShown('lead');
    else if (x < 0) setShown('trail');
    else if (!dragging) {
      const t = setTimeout(() => setShown(null), SETTLE_MS);
      return () => clearTimeout(t);
    }
  }, [x, dragging]);

  const clamp = (v: number) => {
    // a little give past the buttons, none toward a side with nothing in it
    const max = leadW ? leadW + 24 : 0;
    const min = trailW ? -(trailW + 24) : 0;
    return Math.max(min, Math.min(max, v));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || (!leadW && !trailW)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if ((e.target as Element).closest('.drag-grip, .swipe-act')) return;
    rowRef.current = e.currentTarget;
    st.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, from: x, locked: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const s = st.current;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x0;
    const dy = e.clientY - s.y0;
    if (!s.locked) {
      if (Math.abs(dy) > SLOP && Math.abs(dy) >= Math.abs(dx)) {
        st.current = null; // a scroll: leave it to the browser
        return;
      }
      if (Math.abs(dx) < SLOP || Math.abs(dx) < Math.abs(dy) * RATIO) return;
      s.locked = true;
      setDragging(true);
      claimOpen(key);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* the pointer is already gone */
      }
    }
    setX(clamp(s.from + dx));
  };
  const end = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const s = st.current;
    if (!s || s.id !== e.pointerId) return;
    st.current = null;
    if (!s.locked) {
      // a plain tap on an open row closes it instead of opening the task
      if (!cancelled && s.from !== 0) {
        swallow();
        setX(0);
      }
      return;
    }
    swallow();
    setDragging(false);
    const v = clamp(s.from + (e.clientX - s.x0));
    if (cancelled) setX(s.from);
    else if (v > 0 && leadW && v >= leadW * OPEN_AT) setX(leadW);
    else if (v < 0 && trailW && -v >= trailW * OPEN_AT) setX(-trailW);
    else setX(0);
  };

  const open = x !== 0 || dragging || shown !== null;
  return {
    /** spread on the row root */
    rowProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e: ReactPointerEvent<HTMLElement>) => end(e, false),
      onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => end(e, true),
      onClickCapture: (e: ReactMouseEvent) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        // a revealed button's own tap is not swallowed
        if ((e.target as Element).closest('.swipe-act')) return;
        e.stopPropagation();
        e.preventDefault();
      },
      style: open ? ({ '--swipe-x': `${x}px` } as CSSProperties) : undefined,
    },
    /** classes for the row root */
    cls: `${enabled && (leadW || trailW) ? 'swipeable' : ''}${open ? ' swipe-open' : ''}${dragging ? ' swiping' : ''}`,
    /** the revealed buttons, rendered inside the row while it is open */
    layer: open ? (
      <>
        {lead && (x > 0 || (x === 0 && shown === 'lead')) && (
          <span className="swipe-act lead" style={{ width: Math.max(leadW, x) }} onClick={(e) => e.stopPropagation()}>
            {lead.render(close)}
          </span>
        )}
        {trail && (x < 0 || (x === 0 && shown === 'trail')) && (
          <span className="swipe-act trail" style={{ width: Math.max(trailW, -x) }} onClick={(e) => e.stopPropagation()}>
            {trail.render(close)}
          </span>
        )}
      </>
    ) : null,
    close,
  };
}
