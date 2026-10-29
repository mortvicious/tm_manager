import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { planQueueDrop, queueDropMovable, type PredictedSlot, type QueueDropPlan, type QueueDropSide, type Task } from '@tm/shared';
import { api } from '../../api.ts';
import type { UseTimeline } from '../../timeline.ts';
import { toastError } from '../../toast.ts';
import { HOLD_MS, scrollParent, SCROLL_EDGE, SCROLL_STEP, SLOP, TOUCH_SLOP } from '../TaskDrag.tsx';
import { clock, relative } from './format.ts';

// Dragging the predicted future (docs/timeline.md § Drag the future): a
// predicted point of a QUEUED task is dragged by its grip — pointer events
// with the board's gesture (TaskDrag.tsx: a mouse arms after SLOP px, a touch
// after a HOLD_MS hold, a flick before that is the browser's scroll) — and
// dropped beside another one. The drop is mapped to the real mutation by the
// shared `planQueueDrop` (queue-move in the custom queue, /move between
// siblings or group roots in the global one; cross-priority and cross-queue
// refused), laid over the prediction through `applyOptimistic` at once, and
// reconciled by the server's `task.updated` rows — or rolled back with a
// toast when the server refuses.
//
// Targets are found by hit-testing `[data-tl-drop=<taskId>]` (ghosts on the
// tracks, rows in the stream); the half of the target the pointer is in, on
// the view's time axis, is the side: earlier half = before, later = after.

/** a predicted point that can be dragged (and dropped beside): a queued task's slot, not a running one's remainder */
export function slotDraggable(p: PredictedSlot, task: Task | undefined): boolean {
  return p.scheduled && p.source !== 'running' && queueDropMovable(task);
}

export interface TimelineDropOver {
  targetId: string;
  side: QueueDropSide;
  plan: QueueDropPlan;
}

export interface TimelineDragState {
  task: Task;
  x: number;
  y: number;
  over: TimelineDropOver | null;
  touch: boolean;
}

/** the classes the views draw, changing only when the target does (the memoised tracks keep their memo while the pointer moves) */
export interface TimelineDropView {
  movingId: string;
  targetId: string | null;
  side: QueueDropSide | null;
  refused: boolean;
}

export function dropClassFor(view: TimelineDropView | null, taskId: string): string {
  if (!view) return '';
  if (view.movingId === taskId) return ' tl-dragging';
  if (view.targetId !== taskId) return '';
  return view.refused ? ' tl-drop-refused' : ` tl-drop-${view.side}`;
}

/**
 * The confirmed move normally arrives as `task.updated` first, which drops the
 * patch by itself; this is the backstop for an answer that wrote nothing (the
 * order was already that) or rows the server did not rewrite (the client
 * renumbered a set the server only had to midpoint).
 */
const RECONCILE_MS = 4000;
/** the ghost's widest (the board's `.drag-ghost` max-width) and its offset from the pointer, px */
const GHOST_MAX_PX = 320;
const GHOST_GAP_PX = 12;

export function useTimelineDrag(tl: UseTimeline, axis: 'x' | 'y') {
  const [drag, setDrag] = useState<TimelineDragState | null>(null);
  const press = useRef<{
    task: Task;
    x0: number;
    y0: number;
    x: number;
    y: number;
    active: boolean;
    scroller: HTMLElement;
    touch: boolean;
    hold: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  // the handlers and the scroll loop outlive a render: read the latest through a ref
  const latest = useRef(tl);
  latest.current = tl;

  const locate = (x: number, y: number, moving: Task): TimelineDropOver | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const hit = el?.closest<HTMLElement>('[data-tl-drop]');
    const id = hit?.dataset.tlDrop;
    if (!hit || !id || id === moving.id) return null;
    const r = hit.getBoundingClientRect();
    const side: QueueDropSide = axis === 'x' ? (x < r.left + r.width / 2 ? 'before' : 'after') : y < r.top + r.height / 2 ? 'before' : 'after';
    return { targetId: id, side, plan: planQueueDrop(latest.current.tasks, moving.id, id, side) };
  };

  const commit = (moving: Task, over: TimelineDropOver) => {
    const plan = over.plan;
    if ('refusal' in plan) {
      // the ghost said so while hovering; on a phone the finger covered it
      toastError(plan.refusal, 'Reorder');
      return;
    }
    const undo = latest.current.applyOptimistic({ tasks: plan.patch });
    const { call } = plan;
    const sent =
      call.kind === 'queue-move'
        ? api.queueMoveTask(call.id, { place: call.place, targetId: call.targetId })
        : api.moveTask(call.id, { place: call.place, targetId: call.targetId });
    sent.then(
      () => setTimeout(undo, RECONCILE_MS),
      (e: unknown) => {
        undo();
        toastError(e, 'Reorder');
      },
    );
  };

  const cancel = () => {
    if (press.current?.hold) clearTimeout(press.current.hold);
    press.current = null;
    setDrag(null);
  };
  useEffect(
    () => () => {
      if (press.current?.hold) clearTimeout(press.current.hold);
    },
    [],
  );

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKey);
    // auto-scroll along the view's axis while the pointer rests near an edge
    let frame = requestAnimationFrame(function tick() {
      const p = press.current;
      if (p?.active) {
        const box = p.scroller.getBoundingClientRect();
        let moved = false;
        if (axis === 'y') {
          const top = Math.max(box.top, 0);
          const bottom = Math.min(box.bottom, window.innerHeight);
          const dy = p.y < top + SCROLL_EDGE ? -SCROLL_STEP : p.y > bottom - SCROLL_EDGE ? SCROLL_STEP : 0;
          if (dy) {
            const before = p.scroller.scrollTop;
            p.scroller.scrollTop += dy;
            moved = p.scroller.scrollTop !== before;
          }
        } else {
          const dx = p.x < box.left + SCROLL_EDGE ? -SCROLL_STEP : p.x > box.right - SCROLL_EDGE ? SCROLL_STEP : 0;
          if (dx) {
            const before = p.scroller.scrollLeft;
            p.scroller.scrollLeft += dx;
            moved = p.scroller.scrollLeft !== before;
          }
        }
        if (moved) setDrag({ task: p.task, x: p.x, y: p.y, over: locate(p.x, p.y, p.task), touch: p.touch });
      }
      frame = requestAnimationFrame(tick);
    });
    return () => {
      window.removeEventListener('keydown', onKey);
      cancelAnimationFrame(frame);
    };
    // locate/cancel read refs only
  }, [dragging, axis]);

  // an armed touch drag must not scroll the page: a native non-passive touchmove on the grip only
  const gripRef = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const onMove = (ev: TouchEvent) => {
      if (press.current?.active && ev.cancelable) ev.preventDefault();
    };
    el.addEventListener('touchmove', onMove, { passive: false });
    return () => el.removeEventListener('touchmove', onMove);
  }, []);

  // Every handler stops propagation: the grip sits inside a ghost / row whose
  // own handlers (the tracks' pan and hover card, the stream's long press,
  // both views' click-to-open) must not see the drag.
  const gripProps = useCallback(
    (task: Task) => ({
      ref: gripRef,
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        if (press.current?.hold) clearTimeout(press.current.hold);
        const touch = e.pointerType === 'touch';
        const el = e.currentTarget;
        const p: NonNullable<typeof press.current> = {
          task,
          x0: e.clientX,
          y0: e.clientY,
          x: e.clientX,
          y: e.clientY,
          active: false,
          scroller: axis === 'x' ? (el.closest<HTMLElement>('.tlt-scroller') ?? scrollParent(el)) : scrollParent(el),
          touch,
          hold: null,
        };
        if (touch) {
          p.hold = setTimeout(() => {
            if (press.current !== p) return;
            p.hold = null;
            p.active = true;
            navigator.vibrate?.(10);
            setDrag({ task: p.task, x: p.x, y: p.y, over: null, touch: true });
          }, HOLD_MS);
        }
        press.current = p;
      },
      onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
        e.stopPropagation();
        const p = press.current;
        if (!p) return;
        p.x = e.clientX;
        p.y = e.clientY;
        if (!p.active) {
          const moved = Math.hypot(p.x - p.x0, p.y - p.y0);
          if (p.touch) {
            if (moved >= TOUCH_SLOP) cancel();
            return;
          }
          if (moved < SLOP) return;
          p.active = true;
        }
        setDrag({ task: p.task, x: p.x, y: p.y, over: locate(p.x, p.y, p.task), touch: p.touch });
      },
      onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
        e.stopPropagation();
        const p = press.current;
        if (p?.hold) clearTimeout(p.hold);
        press.current = null;
        setDrag(null);
        if (!p?.active) return;
        const over = locate(e.clientX, e.clientY, p.task);
        if (over) commit(p.task, over);
      },
      onPointerCancel: cancel,
      onLostPointerCapture: () => {
        if (press.current) cancel();
      },
      onClick: (e: ReactMouseEvent<HTMLElement>) => e.stopPropagation(),
      onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
        // the stream row's long-press explain lives on the context menu too
        e.stopPropagation();
        e.preventDefault();
      },
    }),
    // locate/commit/cancel read refs only
    [gripRef, axis],
  );

  const over = drag?.over ?? null;
  const viewKey = drag ? `${drag.task.id}|${over?.targetId ?? ''}|${over?.side ?? ''}|${over && 'refusal' in over.plan ? 1 : 0}` : '';
  const view = useMemo<TimelineDropView | null>(
    () =>
      drag
        ? { movingId: drag.task.id, targetId: over?.targetId ?? null, side: over?.side ?? null, refused: !!over && 'refusal' in over.plan }
        : null,
    // viewKey is the whole reading
    [viewKey],
  );

  return { drag, gripProps, view };
}

export type TimelineGripProps = ReturnType<ReturnType<typeof useTimelineDrag>['gripProps']>;

/** "starts 14:05 (in 12m)" for a slot, else why it would not start */
function etaOf(p: PredictedSlot | undefined, now: number): string {
  if (!p) return 'not predicted';
  if (!p.scheduled) return 'not scheduled';
  return `starts ${clock(p.start, now)} (${relative(p.start, now)})`;
}

/**
 * The title under the pointer: what letting go will do and the ETA the drop
 * would give — the whole prediction re-run with the drop's patch (`preview`),
 * once per target, not per pixel.
 */
export function TimelineDragGhost({ drag, tl }: { drag: TimelineDragState | null; tl: UseTimeline }) {
  const over = drag?.over ?? null;
  const plan = over?.plan;
  const key = drag && over ? `${drag.task.id}|${over.targetId}|${over.side}` : '';
  const eta = useMemo(() => {
    if (!drag || !plan || 'refusal' in plan) return null;
    const next = tl.preview({ tasks: plan.patch }).find((p) => p.taskId === drag.task.id);
    const cur = tl.predicted.find((p) => p.taskId === drag.task.id);
    const was = cur?.scheduled ? ` · was ${clock(cur.start, tl.now)}` : '';
    return `${etaOf(next, tl.now)}${next?.scheduled && cur?.scheduled && next.start === cur.start ? ' · unchanged' : was}`;
    // key stands for drag + plan; the prediction inputs move with tl
  }, [key, tl.preview, tl.predicted, tl.now]);
  if (!drag) return null;
  const refusal = plan && 'refusal' in plan ? plan.refusal : null;
  const hint = !over ? 'drop beside another queued task' : refusal ?? (plan && 'hint' in plan ? plan.hint : '');
  // kept on screen: right of the pointer, else left of it, else against the left edge (a phone)
  const w = Math.min(GHOST_MAX_PX, window.innerWidth - 2 * GHOST_GAP_PX);
  const left =
    drag.x + GHOST_GAP_PX + w <= window.innerWidth ? drag.x + GHOST_GAP_PX : Math.max(GHOST_GAP_PX, drag.x - GHOST_GAP_PX - w);
  return (
    <div
      className={`drag-ghost tl-drag-ghost${refusal ? ' refused' : ''}${drag.touch ? ' lifted' : ''}`}
      style={{ left, top: drag.y, maxWidth: w }}
      aria-hidden="true"
    >
      <span className="title">{drag.task.title}</span>
      <span className="hint">{hint}</span>
      {eta && <span className="eta">{eta}</span>}
    </div>
  );
}
