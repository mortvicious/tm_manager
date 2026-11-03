// The focus layer every board version shares (docs/board-versions.md
// § Versions control): focusing a task lights up its neighbourhood (the shared
// pure `buildRelationIndex`) and dims the rest, with a card listing the
// relations by kind — a `<Sheet>` on a phone. Esc, a click on empty space or a
// second click on the same task clears it. The original Board does NOT get it
// (frozen, decisions.md 2026-10-29).
//
// A version wraps its page in <BoardFocusProvider tasks={useBoardTasks()}>,
// its canvas in <BoardFocusScope>, spreads `itemProps(id)` on every task
// element (the CSS keys off `data-focus`), calls `toggle(id)` on a click and
// renders <BoardFocusCard onOpenTask> once.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  TASK_RELATION_KINDS,
  TASK_RELATION_LABELS,
  buildRelationIndex,
  type RelationIndex,
  type Task,
  type TaskNeighbourhood,
  type TaskRelation,
  type TaskRelationKind,
} from '@tm/shared';
import { useIsMobile } from './components/Layout.tsx';
import { Sheet } from './components/Sheet.tsx';
import { StatusBadge } from './components/StatusBadge.tsx';
import { useApp } from './state.tsx';
import { useWorkspace } from './workspace.ts';

export type FocusState = 'focused' | 'related' | 'dimmed';

export interface BoardFocus {
  /** null when nothing is focused, or the focused task left the board's set */
  focusedId: string | null;
  neighbourhood: TaskNeighbourhood | null;
  index: RelationIndex;
  /** the board's set, as given to the provider */
  tasks: readonly Task[];
  focus: (id: string | null) => void;
  /** focus, or clear when it is the focused task already */
  toggle: (id: string) => void;
  clear: () => void;
  /** null while nothing is focused */
  stateOf: (id: string) => FocusState | null;
  /** spread on a task element: the hook for the CSS, the click-away test and Esc's return of keyboard focus */
  itemProps: (id: string) => { 'data-focus-id': string; 'data-focus'?: FocusState };
}

const Ctx = createContext<BoardFocus | null>(null);

/** The tasks a board version shows: workspace scope applied, hidden tasks left out, as on the board. */
export function useBoardTasks(): Task[] {
  const { tasks } = useApp();
  const { inScope } = useWorkspace();
  return useMemo(() => tasks.filter((t) => inScope(t) && !t.hiddenAt), [tasks, inScope]);
}

export function BoardFocusProvider({ tasks, children }: { tasks: readonly Task[]; children: ReactNode }) {
  const { runs, dispatches } = useApp();
  const [picked, setPicked] = useState<string | null>(null);
  const index = useMemo(() => buildRelationIndex({ tasks, runs, dispatches }), [tasks, runs, dispatches]);
  const neighbourhood = useMemo(() => (picked ? index.neighbourhood(picked) : null), [index, picked]);
  const focusedId = neighbourhood ? picked : null;

  const focus = useCallback((id: string | null) => setPicked(id), []);
  const clear = useCallback(() => setPicked(null), []);
  const toggle = useCallback((id: string) => setPicked((cur) => (cur === id ? null : id)), []);

  const value = useMemo<BoardFocus>(() => {
    const stateOf = (id: string): FocusState | null =>
      !neighbourhood ? null : id === focusedId ? 'focused' : neighbourhood.ids.has(id) ? 'related' : 'dimmed';
    return {
      focusedId,
      neighbourhood,
      index,
      tasks,
      focus,
      toggle,
      clear,
      stateOf,
      itemProps: (id) => {
        const s = stateOf(id);
        return s ? { 'data-focus-id': id, 'data-focus': s } : { 'data-focus-id': id };
      },
    };
  }, [focusedId, neighbourhood, index, tasks, focus, toggle, clear]);

  // Esc clears — unless it belongs to something else: a field, a dialog, or
  // the task panel (open while `?task=` is in the URL), which closes first.
  useEffect(() => {
    if (!focusedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [aria-modal="true"]')) return;
      if (new URLSearchParams(window.location.search).has('task')) return;
      const inCard = el?.closest('.bf-card');
      setPicked(null);
      // keyboard focus left inside the closing card goes back to the task it was about
      if (inCard) document.querySelector<HTMLElement>(`[data-focus-id="${CSS.escape(focusedId)}"]`)?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [focusedId]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBoardFocus(): BoardFocus {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBoardFocus outside <BoardFocusProvider>');
  return v;
}

/**
 * The canvas: carries `data-focus-active` for the dimming CSS and clears the
 * focus on a click that lands on no task and not in the card.
 */
export function BoardFocusScope({ className, children }: { className?: string; children: ReactNode }) {
  const { focusedId, clear } = useBoardFocus();
  return (
    <div
      className={`bf-scope${className ? ` ${className}` : ''}`}
      data-focus-active={focusedId ? '' : undefined}
      onClick={(e) => {
        if (!focusedId) return;
        const el = e.target instanceof Element ? e.target : null;
        if (el?.closest('[data-focus-id], .bf-card, button, a, input, select, textarea')) return;
        clear();
      }}
    >
      {children}
    </div>
  );
}

function groupByKind(relations: TaskRelation[]): [TaskRelationKind, TaskRelation[]][] {
  return TASK_RELATION_KINDS.map((k) => [k, relations.filter((r) => r.kind === k)] as [TaskRelationKind, TaskRelation[]]).filter(
    ([, list]) => list.length > 0,
  );
}

function dispatchNote(r: TaskRelation): string | null {
  const ds = r.dispatches;
  if (!ds?.length) return null;
  const last = ds[ds.length - 1];
  const pending = ds.filter((d) => d.status === 'pending').length;
  const count = ds.length > 1 ? `${ds.length}× · ` : '';
  return pending ? `${count}${pending} pending` : `${count}${last.status}`;
}

function RelationList({ n, byId, onPick }: { n: TaskNeighbourhood; byId: Map<string, Task>; onPick: (id: string) => void }) {
  const groups = groupByKind(n.relations);
  if (!groups.length) return <p className="bf-empty">No relations on this board.</p>;
  return (
    <>
      {groups.map(([kind, list]) => (
        <section key={kind} className="bf-kind" data-kind={kind}>
          <h4>{TASK_RELATION_LABELS[kind]}</h4>
          <ul>
            {list.map((r) => {
              const t = byId.get(r.taskId);
              if (!t) return null;
              const note = dispatchNote(r);
              return (
                <li key={`${kind}:${r.taskId}`}>
                  <button type="button" className="bf-rel" title="Focus this task" onClick={() => onPick(r.taskId)}>
                    <span className="bf-rel-title">{t.title}</span>
                    <span className="bf-rel-meta">
                      {note && <span className="bf-rel-note">{note}</span>}
                      <StatusBadge status={t.status} reviewState={t.reviewState} checkState={t.checkState} loopState={t.loopState} explain={false} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}

/**
 * The relations of the focused task, by kind: a side card on the desktop (fixed
 * to the viewport's lower right, so it fits any version's layout) and a
 * `<Sheet>` on a phone. A relation refocuses; Open opens the ordinary task panel.
 */
export function BoardFocusCard({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const { focusedId, neighbourhood, tasks, focus, clear } = useBoardFocus();
  const mobile = useIsMobile();
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const task = focusedId ? byId.get(focusedId) : undefined;
  if (!task || !neighbourhood) return null;

  const badge = (
    <StatusBadge status={task.status} reviewState={task.reviewState} checkState={task.checkState} loopState={task.loopState} explain={false} />
  );
  const count = neighbourhood.ids.size;
  const summary = `${count} related task${count === 1 ? '' : 's'}`;

  if (mobile) {
    return (
      <Sheet label={`Relations of ${task.title}`} title={task.title} onClose={clear} className="bf-sheet">
        <div className="bf-card bf-card-sheet">
          <div className="bf-head-row">
            {badge}
            <span className="bf-summary">{summary}</span>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                // the sheet gives way to the task panel
                clear();
                onOpenTask(task.id);
              }}
            >
              Open
            </button>
          </div>
          <RelationList n={neighbourhood} byId={byId} onPick={focus} />
        </div>
      </Sheet>
    );
  }

  return (
    <aside className="bf-card" aria-label={`Relations of ${task.title}`}>
      <div className="bf-head">
        <h3 aria-live="polite">{task.title}</h3>
        <button type="button" className="btn ghost bf-close" aria-label="Clear focus (Esc)" title="Clear focus (Esc)" onClick={clear}>
          ×
        </button>
      </div>
      <div className="bf-head-row">
        {badge}
        <span className="bf-summary">{summary}</span>
        <button type="button" className="btn" onClick={() => onOpenTask(task.id)}>
          Open
        </button>
      </div>
      <RelationList n={neighbourhood} byId={byId} onPick={focus} />
    </aside>
  );
}
