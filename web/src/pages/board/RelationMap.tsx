// Board version "Relation map" (docs/board-versions.md § Relation map): the
// task graph. One soft band per group, the tree left to right inside it, and
// the relations the original board cannot show drawn as edges — subtask
// (solid, group colour), filed by an agent (dashed) and dispatch (dotted
// accent, animated while pending). Focus is the main interaction: a click
// lights up the neighbourhood through the shared focus layer and its card; a
// double-click (or the card's Open) opens the task panel. The layout is the
// pure `layoutRelationMap` (shared), memoised; the canvas renders only what is
// in view. On a phone there is no canvas: a list whose rows open the focus
// card's neighbours sheet.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import {
  RM_HEAD_H,
  RM_NODE_H,
  RM_NODE_W,
  TERMINAL_TASK_STATUSES,
  UNGROUPED_BAND,
  cullRelationMap,
  layoutRelationMap,
  type RelationMapColumns,
  type RelationMapEdge,
  type RelationMapLayout,
  type Task,
  type TaskStatus,
} from '@tm/shared';
import type { BoardVersionProps } from '../../boardVersions.ts';
import { BoardFocusCard, BoardFocusProvider, BoardFocusScope, useBoardFocus, useBoardTasks } from '../../boardFocus.tsx';
import { BoardVersionsControl } from '../../components/BoardVersions.tsx';
import { useIsMobile } from '../../components/Layout.tsx';
import { StatusBadge } from '../../components/StatusBadge.tsx';
import { ProgressPct } from '../../components/TaskProgress.tsx';
import { useApp } from '../../state.tsx';

type Scope = 'live' | 'all';
interface Prefs {
  columns: RelationMapColumns;
  scope: Scope;
}
const PREFS_KEY = 'tm.relationMap';

function readPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return {
      columns: p.columns === 'phase' || p.columns === 'status' ? p.columns : 'depth',
      scope: p.scope === 'all' ? 'all' : 'live',
    };
  } catch {
    return { columns: 'depth', scope: 'live' };
  }
}

const isLive = (t: Task) => !TERMINAL_TASK_STATUSES.includes(t.status);

const STATUS_COLOR: Record<TaskStatus, string> = {
  draft: 'var(--tm-text-faint)',
  queued: 'var(--tm-status-queued)',
  running: 'var(--tm-status-running)',
  waiting: 'var(--tm-status-running)',
  review: 'var(--tm-status-review)',
  blocked: 'var(--tm-status-attention)',
  done: 'var(--tm-status-done)',
  published: 'var(--tm-status-published)',
  failed: 'var(--tm-status-failed)',
  cancelled: 'var(--tm-text-faint)',
};

const groupVar = (slot: number | null | undefined) => (slot ? `var(--tm-group-${slot})` : 'var(--tm-text-faint)');

/**
 * What the canvas draws. `all`: every task on the board. `live`: every group
 * with a live member (whole, so its tree stays intact), live single tasks, and
 * a landed single task one filed/dispatch hop from a live task shown. The
 * focus card still lists relations to tasks outside this set.
 */
function useShownTasks(scope: Scope): Task[] {
  const { tasks, index } = useBoardFocus();
  const { dispatches } = useApp();
  return useMemo(() => {
    if (scope === 'all') return [...tasks];
    const size = new Map<string, number>();
    const liveGroups = new Set<string>();
    for (const t of tasks) {
      size.set(t.groupId, (size.get(t.groupId) ?? 0) + 1);
      if (isLive(t)) liveGroups.add(t.groupId);
    }
    const shown = new Set(tasks.filter((t) => liveGroups.has(t.groupId)).map((t) => t.id));
    const live = new Set(tasks.filter(isLive).map((t) => t.id));
    const hop = new Set<string>();
    for (const t of tasks) {
      const f = index.filerOf(t.id);
      if (f && live.has(t.id)) hop.add(f);
      if (f && live.has(f)) hop.add(t.id);
    }
    for (const d of dispatches) {
      if (live.has(d.fromTaskId)) hop.add(d.toTaskId);
      if (live.has(d.toTaskId)) hop.add(d.fromTaskId);
    }
    return tasks.filter((t) => shown.has(t.id) || (hop.has(t.id) && (size.get(t.groupId) ?? 0) < 2));
  }, [tasks, index, dispatches, scope]);
}

function useLayout(shown: Task[], columns: RelationMapColumns): RelationMapLayout {
  const { index } = useBoardFocus();
  const { dispatches } = useApp();
  return useMemo(
    () => layoutRelationMap({ tasks: shown, filerOf: index.filerOf, dispatches, columns }),
    [shown, index, dispatches, columns],
  );
}

// ── desktop canvas ───────────────────────────────────────────────────────────

/** The viewport is snapped to this grid (plus one chunk of margin each way), so scrolling re-renders only when it crosses a line. */
const CHUNK = 400;

interface View {
  x: number;
  y: number;
  width: number;
  height: number;
}

function snapView(el: HTMLElement): View {
  const x = Math.max(0, Math.floor(el.scrollLeft / CHUNK) * CHUNK - CHUNK);
  const y = Math.max(0, Math.floor(el.scrollTop / CHUNK) * CHUNK - CHUNK);
  return { x, y, width: Math.ceil(el.clientWidth / CHUNK) * CHUNK + 3 * CHUNK, height: Math.ceil(el.clientHeight / CHUNK) * CHUNK + 3 * CHUNK };
}

function Canvas({ layout, columns, onOpenTask, multiRepo }: { layout: RelationMapLayout; columns: RelationMapColumns; onOpenTask: (id: string) => void; multiRepo: boolean }) {
  const { tasks, focusedId, itemProps, toggle } = useBoardFocus();
  const { repos } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, width: 2400, height: 1600 });
  const frame = useRef(0);

  const measure = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      const next = snapView(el);
      setView((v) => (v.x === next.x && v.y === next.y && v.width === next.width && v.height === next.height ? v : next));
    });
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setView(snapView(el));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [measure]);

  // drag on empty canvas pans it; the click that ends a drag is swallowed so it
  // does not clear the focus
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean; id: number } | null>(null);
  const dragged = useRef(false);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragged.current = false;
    if (e.button !== 0 || e.pointerType === 'touch') return;
    if ((e.target as Element).closest('[data-focus-id], button, a, input, select')) return;
    const el = ref.current!;
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false, id: e.pointerId };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    if (!d.moved) {
      d.moved = true;
      ref.current!.setPointerCapture(e.pointerId);
    }
    ref.current!.scrollLeft = d.left - dx;
    ref.current!.scrollTop = d.top - dy;
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    dragged.current = d.moved;
    drag.current = null;
  };

  // a focus moved from the card to a task out of view scrolls it into view
  useEffect(() => {
    const el = ref.current;
    const n = focusedId ? layout.byId.get(focusedId) : undefined;
    if (!el || !n) return;
    const inView = n.x >= el.scrollLeft && n.x + RM_NODE_W <= el.scrollLeft + el.clientWidth && n.y >= el.scrollTop && n.y + RM_NODE_H <= el.scrollTop + el.clientHeight;
    if (!inView) el.scrollTo({ left: n.x - el.clientWidth / 2 + RM_NODE_W / 2, top: n.y - el.clientHeight / 2 + RM_NODE_H / 2, behavior: 'smooth' });
    // only on a focus change, not on every relayout
  }, [focusedId]);

  const byTask = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const repoName = useMemo(() => new Map(repos.map((r) => [r.id, r.name])), [repos]);
  const seen = useMemo(() => cullRelationMap(layout, view), [layout, view]);
  const hi = (e: RelationMapEdge) => (focusedId && (e.from === focusedId || e.to === focusedId) ? '' : undefined);

  return (
    <div
      ref={ref}
      className="rm-canvas"
      onScroll={measure}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClickCapture={(e) => {
        if (!dragged.current) return;
        dragged.current = false;
        e.stopPropagation();
      }}
    >
      {!layout.nodes.length && <p className="bf-empty rm-empty">No tasks to map in this workspace.</p>}
      {layout.columns.length > 0 && (
        <div className="rm-cols" style={{ width: layout.width }} aria-hidden="true">
          {layout.columns.map((c) => (
            <span key={c.label} className="rm-col" style={{ left: c.x, width: RM_NODE_W, height: RM_HEAD_H }}>
              {c.label}
            </span>
          ))}
        </div>
      )}
      <div className="rm-stage" style={{ width: layout.width, height: layout.height }} data-columns={columns}>
        {seen.bands.map((b) => (
          <div key={b.id} className="rm-band" style={{ top: b.y, height: b.height, '--rm-g': groupVar(b.colorSlot) } as CSSProperties}>
            <b>{b.label}</b>
            <span>
              {b.count} task{b.count === 1 ? '' : 's'}
            </span>
          </div>
        ))}
        <svg className="rm-edges" width={layout.width} height={layout.height} aria-hidden="true">
          <defs>
            <marker id="rm-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" className="rm-arrow" />
            </marker>
          </defs>
          {seen.edges.map((e) => (
            <path
              key={e.key}
              d={e.d}
              className={`rm-edge rm-edge-${e.kind}${e.pending ? ' pending' : ''}`}
              data-hi={hi(e)}
              style={e.kind === 'subtask' ? { stroke: groupVar(e.colorSlot) } : undefined}
              markerEnd={e.kind === 'dispatch' ? 'url(#rm-arrow)' : undefined}
            >
              {e.kind === 'dispatch' && <title>{`${e.count} dispatch${e.count === 1 ? '' : 'es'}${e.pending ? ' · pending' : ''}`}</title>}
            </path>
          ))}
        </svg>
        {seen.nodes.map((n) => {
          const t = byTask.get(n.id);
          if (!t) return null;
          return (
            <button
              key={n.id}
              type="button"
              className="rm-node"
              style={{ left: n.x, top: n.y, width: RM_NODE_W, height: RM_NODE_H, '--rm-c': STATUS_COLOR[t.status] } as CSSProperties}
              aria-pressed={n.id === focusedId}
              title="Click to focus · double-click to open"
              {...itemProps(n.id)}
              onClick={() => toggle(n.id)}
              onDoubleClick={() => onOpenTask(n.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  onOpenTask(n.id);
                }
              }}
            >
              <span className="rm-node-title">{t.title}</span>
              <span className="rm-node-meta">
                <StatusBadge status={t.status} reviewState={t.reviewState} checkState={t.checkState} loopState={t.loopState} explain={false} />
                {multiRepo && t.repoId && <span className="chip">{repoName.get(t.repoId) ?? 'repo'}</span>}
                <ProgressPct task={t} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── phone list ───────────────────────────────────────────────────────────────

function PhoneList({ layout }: { layout: RelationMapLayout }) {
  const { tasks, focusedId, itemProps, toggle } = useBoardFocus();
  const byTask = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  // what each row carries beside its subtree: filed by an agent, dispatches
  const marks = useMemo(() => {
    const m = new Map<string, { filed: boolean; dispatch: boolean; pending: boolean }>();
    const get = (id: string) => m.get(id) ?? (m.set(id, { filed: false, dispatch: false, pending: false }), m.get(id)!);
    for (const e of layout.edges) {
      if (e.kind === 'filed') get(e.to).filed = true;
      if (e.kind === 'dispatch') for (const id of [e.from, e.to]) {
        get(id).dispatch = true;
        if (e.pending) get(id).pending = true;
      }
    }
    return m;
  }, [layout]);
  const rows = useMemo(() => [...layout.nodes].sort((a, b) => a.order - b.order), [layout]);

  if (!rows.length) return <p className="bf-empty rm-empty">No tasks to map in this workspace.</p>;
  return (
    <div className="rm-list">
      {layout.bands.map((b) => (
        <section key={b.id} className="rm-list-band" style={{ '--rm-g': groupVar(b.colorSlot) } as CSSProperties}>
          <h2 className="rm-list-head">
            <span>{b.label}</span>
            <span className="rm-list-count">{b.count}</span>
          </h2>
          <ul>
            {rows
              .filter((n) => n.bandId === b.id)
              .map((n) => {
                const t = byTask.get(n.id);
                if (!t) return null;
                const mk = marks.get(n.id);
                return (
                  <li key={n.id} style={{ '--rm-depth': Math.min(n.depth, 4) } as CSSProperties}>
                    <button
                      type="button"
                      className="rm-row"
                      style={{ '--rm-c': STATUS_COLOR[t.status] } as CSSProperties}
                      aria-pressed={n.id === focusedId}
                      {...itemProps(n.id)}
                      onClick={() => toggle(n.id)}
                    >
                      <span className="rm-row-title">
                        {n.depth > 0 && b.id !== UNGROUPED_BAND && <span className="rm-row-elbow" aria-hidden="true">└</span>}
                        {t.title}
                      </span>
                      <span className="rm-row-meta">
                        <StatusBadge status={t.status} reviewState={t.reviewState} checkState={t.checkState} loopState={t.loopState} explain={false} />
                        {mk?.filed && <span className="rm-mark rm-mark-filed" title="filed by an agent">filed</span>}
                        {mk?.dispatch && (
                          <span className={`rm-mark rm-mark-dispatch${mk.pending ? ' pending' : ''}`} title={mk.pending ? 'dispatch pending' : 'dispatches'}>
                            ⇢
                          </span>
                        )}
                        <ProgressPct task={t} />
                      </span>
                    </button>
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

const COLUMN_MODES: { id: RelationMapColumns; label: string }[] = [
  { id: 'depth', label: 'depth' },
  { id: 'phase', label: 'phase' },
  { id: 'status', label: 'status' },
];

function RelationMapBody({ prefs, onOpenTask }: { prefs: Prefs; onOpenTask: (id: string) => void }) {
  const mobile = useIsMobile();
  const shown = useShownTasks(prefs.scope);
  // the phone list keeps the tree order whatever the desktop's column mode
  const layout = useLayout(shown, mobile ? 'depth' : prefs.columns);
  const multiRepo = useMemo(() => new Set(shown.map((t) => t.repoId)).size > 1, [shown]);
  return (
    <BoardFocusScope className="rm-scope">
      {mobile ? <PhoneList layout={layout} /> : <Canvas layout={layout} columns={prefs.columns} onOpenTask={onOpenTask} multiRepo={multiRepo} />}
    </BoardFocusScope>
  );
}

export default function RelationMap({ onOpenTask }: BoardVersionProps) {
  const tasks = useBoardTasks();
  const mobile = useIsMobile();
  const [prefs, setPrefsState] = useState<Prefs>(readPrefs);
  const setPrefs = (patch: Partial<Prefs>) =>
    setPrefsState((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        // private mode: the pick lasts the session
      }
      return next;
    });

  return (
    <div className="board rm-board">
      <div className="board-head">
        <h1 className="page-title">Board</h1>
        <div className="board-tools">
          {!mobile && (
            <div className="rm-legend" aria-label="Edges">
              <span>
                <i className="rm-lg-subtask" />
                subtask
              </span>
              <span>
                <i className="rm-lg-filed" />
                filed by agent
              </span>
              <span>
                <i className="rm-lg-dispatch" />
                dispatch
              </span>
            </div>
          )}
          {!mobile && (
            <div className="rm-seg" role="radiogroup" aria-label="Columns">
              <span className="rm-seg-label">Columns</span>
              {COLUMN_MODES.map((m) => (
                <button key={m.id} type="button" role="radio" aria-checked={prefs.columns === m.id} className={prefs.columns === m.id ? 'on' : ''} onClick={() => setPrefs({ columns: m.id })}>
                  {m.label}
                </button>
              ))}
            </div>
          )}
          <div className="rm-seg" role="radiogroup" aria-label="Show">
            {(['live', 'all'] as const).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={prefs.scope === s} className={prefs.scope === s ? 'on' : ''} onClick={() => setPrefs({ scope: s })}>
                {s === 'live' ? 'live' : 'all'}
              </button>
            ))}
          </div>
          <BoardVersionsControl />
        </div>
      </div>
      <BoardFocusProvider tasks={tasks}>
        <RelationMapBody prefs={prefs} onOpenTask={onOpenTask} />
        <BoardFocusCard onOpenTask={onOpenTask} />
      </BoardFocusProvider>
    </div>
  );
}
