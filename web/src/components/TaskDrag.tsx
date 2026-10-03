import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { groupAncestors, groupLabel, type Task } from '@tm/shared';

// Board drag and drop (docs/grouping.md § Drag and drop). Pointer events, not
// the HTML5 drag API: that one never fires for touch on iOS, and the board is
// used from a phone. A drag starts on a row's grip only, so scrolling, clicking
// a row and selecting text all behave exactly as before.
//
// Targets are found by hit-testing (`elementFromPoint`) against two data
// attributes, so nothing but the grip needs a handler:
//   [data-drop-task=<id>]   a row — top band = before, bottom band = after,
//                           middle = into (join its group)
//   [data-drop-group=<id>]  a group header — append to that group

/** What the pointer is over during a drag. `group` is a group header. */
export type DropZone = 'before' | 'after' | 'into' | 'group';

export interface DropOver {
  targetId: string;
  zone: DropZone;
  /** why the server would refuse this drop, or null when it would take it */
  refusal: string | null;
}

export interface DragState {
  task: Task;
  x: number;
  y: number;
  over: DropOver | null;
}

/** Fraction of a row's height that reads as "beside" rather than "into". */
const EDGE = 0.3;
/** Pixels the pointer must travel before a press on the grip becomes a drag. */
const SLOP = 4;
/** Distance from the scroll container's edge that auto-scrolls, and the speed. */
const SCROLL_EDGE = 48;
const SCROLL_STEP = 14;

/** The parent a drop would give `moving` — the server's `moveTask` resolution. */
export function dropParent(place: DropZone, target: Task): string | null {
  if (place === 'before' || place === 'after') return target.parentId;
  if (place === 'into') return target.parentId ?? target.id;
  return target.groupId;
}

/**
 * The same refusals `reparentRefusal` answers on the server, so a drop the
 * server would 400/409 is drawn as refused instead of being sent.
 */
export function moveRefusal(tasks: Task[], moving: Task, parentId: string | null): string | null {
  if (parentId === moving.parentId) return null;
  // parentId === moving.id is what dropping beside (or into) one of its own
  // children resolves to, so both read as the same thing to the human
  if (parentId === moving.id) return 'a task cannot move inside its own subtree';
  if (parentId) {
    const parent = tasks.find((t) => t.id === parentId);
    if (!parent) return 'parent task not found';
    if (groupAncestors(parent).includes(moving.id)) return 'a task cannot move inside its own subtree';
  }
  if (moving.parentId && tasks.find((t) => t.id === moving.parentId)?.status === 'blocked') {
    return 'its parent is blocked waiting on its split children';
  }
  return null;
}

/** One line under the ghost, saying what letting go will do. */
export function dropHint(tasks: Task[], drag: DragState): string {
  const over = drag.over;
  if (!over) return 'drop on a task or a group header';
  if (over.refusal) return over.refusal;
  const target = tasks.find((t) => t.id === over.targetId);
  if (!target) return '';
  const root = tasks.find((t) => t.id === target.groupId);
  const name = `“${groupLabel(root, target.title)}”`;
  const title = `“${target.title}”`;
  switch (over.zone) {
    case 'before':
      return `move above ${title}`;
    case 'after':
      return `move below ${title}`;
    case 'group':
      return `append to group ${name}`;
    case 'into': {
      const lone = !target.parentId && !tasks.some((t) => t.parentId === target.id);
      return lone ? `start a group with ${title}` : `join group ${name}`;
    }
  }
}

function scrollParent(el: HTMLElement | null): HTMLElement {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/**
 * Drag state plus the props for a row's grip. `onDrop` gets only drops the
 * client-side mirror would accept; the server still has the last word.
 */
export function useTaskDrag(tasks: Task[], onDrop: (moving: Task, zone: DropZone, targetId: string) => void) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const press = useRef<{
    task: Task;
    x0: number;
    y0: number;
    x: number;
    y: number;
    active: boolean;
    scroller: HTMLElement;
  } | null>(null);
  // read by the pointer handlers and the scroll loop, which outlive a render
  const latest = useRef({ tasks, onDrop });
  latest.current = { tasks, onDrop };

  const locate = (x: number, y: number, moving: Task): DropOver | null => {
    const list = latest.current.tasks;
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const head = el?.closest<HTMLElement>('[data-drop-group]');
    if (head?.dataset.dropGroup) {
      const target = list.find((t) => t.id === head.dataset.dropGroup);
      if (!target) return null;
      const refusal =
        target.id === moving.id ? 'it already roots this group' : moveRefusal(list, moving, dropParent('group', target));
      return { targetId: target.id, zone: 'group', refusal };
    }
    const row = el?.closest<HTMLElement>('[data-drop-task]');
    const id = row?.dataset.dropTask;
    if (!row || !id || id === moving.id) return null;
    const target = list.find((t) => t.id === id);
    if (!target) return null;
    const r = row.getBoundingClientRect();
    const f = r.height > 0 ? (y - r.top) / r.height : 0.5;
    const zone: DropZone = f < EDGE ? 'before' : f > 1 - EDGE ? 'after' : 'into';
    if (zone === 'after') {
      // The line under a parent whose children are drawn right below it reads
      // as "first child", not "after the whole subtree" — resolve it as the
      // row the pointer is visually above.
      const rows = [...(row.closest('.panel') ?? document).querySelectorAll<HTMLElement>('[data-drop-task]')];
      const nextId = rows[rows.indexOf(row) + 1]?.dataset.dropTask;
      const next = nextId ? list.find((t) => t.id === nextId) : undefined;
      if (next && next.parentId === target.id) {
        if (next.id === moving.id) return null; // already right there
        return { targetId: next.id, zone: 'before', refusal: moveRefusal(list, moving, dropParent('before', next)) };
      }
    }
    return { targetId: id, zone, refusal: moveRefusal(list, moving, dropParent(zone, target)) };
  };

  const cancel = () => {
    press.current = null;
    setDrag(null);
  };

  // Escape abandons the drag; the grip keeps pointer capture, but with no
  // press recorded its move/up handlers do nothing.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKey);
    // Auto-scroll while the pointer rests near an edge of the scrolling pane —
    // a touch drag cannot scroll the page any other way.
    let frame = requestAnimationFrame(function tick() {
      const p = press.current;
      if (p?.active) {
        const box = p.scroller.getBoundingClientRect();
        const top = Math.max(box.top, 0);
        const bottom = Math.min(box.bottom, window.innerHeight);
        const dy = p.y < top + SCROLL_EDGE ? -SCROLL_STEP : p.y > bottom - SCROLL_EDGE ? SCROLL_STEP : 0;
        if (dy !== 0) {
          const before = p.scroller.scrollTop;
          p.scroller.scrollTop += dy;
          if (p.scroller.scrollTop !== before) {
            setDrag({ task: p.task, x: p.x, y: p.y, over: locate(p.x, p.y, p.task) });
          }
        }
      }
      frame = requestAnimationFrame(tick);
    });
    return () => {
      window.removeEventListener('keydown', onKey);
      cancelAnimationFrame(frame);
    };
    // locate/cancel read refs only, so the drag's start is the only dependency
  }, [dragging]);

  const gripProps = (task: Task) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      press.current = {
        task,
        x0: e.clientX,
        y0: e.clientY,
        x: e.clientX,
        y: e.clientY,
        active: false,
        scroller: scrollParent(e.currentTarget),
      };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const p = press.current;
      if (!p) return;
      p.x = e.clientX;
      p.y = e.clientY;
      if (!p.active) {
        if (Math.hypot(p.x - p.x0, p.y - p.y0) < SLOP) return;
        p.active = true;
      }
      setDrag({ task: p.task, x: p.x, y: p.y, over: locate(p.x, p.y, p.task) });
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      const p = press.current;
      press.current = null;
      setDrag(null);
      if (!p?.active) return;
      const over = locate(e.clientX, e.clientY, p.task);
      if (over && !over.refusal) latest.current.onDrop(p.task, over.zone, over.targetId);
    },
    onPointerCancel: cancel,
    onLostPointerCapture: () => {
      if (press.current) cancel();
    },
    // the grip sits inside the row, whose click opens the task
    onClick: (e: ReactMouseEvent<HTMLElement>) => e.stopPropagation(),
  });

  /** The class a row or group header carries while the pointer is over it. */
  const dropClass = (id: string, kind: 'task' | 'group'): string => {
    if (!drag) return '';
    if (kind === 'task' && drag.task.id === id) return 'dragging';
    const o = drag.over;
    if (!o || o.targetId !== id || (kind === 'group') !== (o.zone === 'group')) return '';
    return o.refusal ? 'drop-refused' : `drop-${o.zone}`;
  };

  return { drag, gripProps, dropClass };
}

/** The title that follows the pointer, with what letting go will do. */
export function DragGhost({ drag, tasks }: { drag: DragState | null; tasks: Task[] }) {
  if (!drag) return null;
  return (
    <div
      className={`drag-ghost ${drag.over?.refusal ? 'refused' : ''}`}
      style={{ left: drag.x, top: drag.y }}
      aria-hidden="true"
    >
      <span className="title">{drag.task.title}</span>
      <span className="hint">{dropHint(tasks, drag)}</span>
    </div>
  );
}
