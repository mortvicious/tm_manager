import { useEffect, useRef, useState } from 'react';
import { useTaskNeighbours } from '../boardOrder.ts';
import { useApp } from '../state.tsx';

/** a release past this many px steps to the neighbour */
const STEP_AT = 56;
const SLOP = 8;

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * Previous / next in the phone task panel (docs/mobile.md § Panel prev/next):
 * a strip at the top of the panel sheet that names the neighbours in the
 * board section the task was opened from. Swipe it left for the next task,
 * right for the previous one, or tap either side. Shown only while the legacy
 * Board is under the panel and the section holds more than this task.
 *
 * The strip is the ONLY swipe zone. The sheet follows a finger from anywhere
 * (react-modal-sheet's drag, a native listener on its container), so the strip
 * stops `pointerdown`/`touchstart` from reaching it — natively, because React's
 * own listener sits at the root, after the container — and handles its
 * gesture with native listeners too. The body keeps its vertical scroll, its
 * horizontal tab strip and its terminal; the grip and the head still drag the
 * sheet down.
 */
export function PanelNav({ taskId, onOpenTask }: { taskId: string; onOpenTask: (id: string) => void }) {
  const n = useTaskNeighbours(taskId);
  const { tasks } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const [dx, setDx] = useState(0);
  // the latest neighbours, for the native listeners bound once per strip
  const cur = useRef(n);
  cur.current = n;
  const open = useRef(onOpenTask);
  open.current = onOpenTask;
  const shown = !!n;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let start: { id: number; x: number; y: number; locked: boolean } | null = null;
    // a swipe that began on one of the buttons must not also press it
    let swiped = 0;
    const stop = (e: Event) => e.stopPropagation();
    const eatClick = (e: MouseEvent) => {
      if (Date.now() - swiped > 400) return;
      e.stopPropagation();
      e.preventDefault();
    };
    const down = (e: PointerEvent) => {
      e.stopPropagation();
      start = { id: e.pointerId, x: e.clientX, y: e.clientY, locked: false };
    };
    const move = (e: PointerEvent) => {
      if (!start || start.id !== e.pointerId) return;
      const d = e.clientX - start.x;
      if (!start.locked) {
        if (Math.abs(d) < SLOP || Math.abs(d) < Math.abs(e.clientY - start.y)) return;
        start.locked = true;
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* gone */
        }
      }
      // a step with nowhere to go gives a little, then stops
      const nb = cur.current;
      const room = (d < 0 && nb?.next) || (d > 0 && nb?.prev);
      if (!reducedMotion()) setDx(room ? d * 0.5 : Math.sign(d) * Math.min(Math.abs(d) * 0.2, 16));
    };
    const up = (e: PointerEvent, cancelled: boolean) => {
      if (!start || start.id !== e.pointerId) return;
      const d = e.clientX - start.x;
      const locked = start.locked;
      start = null;
      setDx(0);
      if (!locked) return;
      swiped = Date.now();
      if (cancelled) return;
      const nb = cur.current;
      const to = d <= -STEP_AT ? nb?.next : d >= STEP_AT ? nb?.prev : null;
      if (to) open.current(to);
    };
    const onUp = (e: PointerEvent) => up(e, false);
    const onCancel = (e: PointerEvent) => up(e, true);
    el.addEventListener('pointerdown', down);
    el.addEventListener('click', eatClick, true);
    el.addEventListener('touchstart', stop, { passive: true });
    el.addEventListener('mousedown', stop);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('click', eatClick, true);
      el.removeEventListener('touchstart', stop);
      el.removeEventListener('mousedown', stop);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
    };
  }, [shown]);

  if (!n) return null;
  const title = (id: string | null) => (id ? (tasks.find((t) => t.id === id)?.title ?? 'task') : '');
  return (
    <div className="panel-nav" ref={ref} role="navigation" aria-label={`${n.label}: task ${n.index + 1} of ${n.count}`}>
      <div className="pn-track" style={dx ? { transform: `translateX(${dx}px)` } : undefined}>
        <button
          type="button"
          className="pn-btn prev"
          aria-disabled={!n.prev}
          aria-label={n.prev ? `Previous: ${title(n.prev)}` : 'No previous task'}
          onClick={() => n.prev && onOpenTask(n.prev)}
        >
          <span aria-hidden="true">‹</span>
          <span className="pn-title">{title(n.prev)}</span>
        </button>
        <span className="pn-pos">
          {n.label} · {n.index + 1}/{n.count}
        </span>
        <button
          type="button"
          className="pn-btn next"
          aria-disabled={!n.next}
          aria-label={n.next ? `Next: ${title(n.next)}` : 'No next task'}
          onClick={() => n.next && onOpenTask(n.next)}
        >
          <span className="pn-title">{title(n.next)}</span>
          <span aria-hidden="true">›</span>
        </button>
      </div>
    </div>
  );
}
