// Board version "Swimlanes" (docs/board-versions.md § Swimlanes): a 2-D table
// with one lane per group (or repo, or feature, per device) and one column per
// stage — Queued · Working · Review · Stuck · Landed. Across a lane you see how
// far a group has got (the header's landed/total and per-status bar); down a
// column, the whole review pile or the whole queue. A click on a card opens the
// ordinary task panel; the card's relations button focuses its neighbourhood
// through the shared focus layer. There is no drag: a stage is a status, which
// is never set by dragging (reordering stays in Original). The layout is the
// pure `layoutSwimlanes` (shared), memoised; everything reads `useApp()`, which
// `/ws/events` keeps current — no polling.

import { useMemo, useState, type CSSProperties } from 'react';
import {
  SWIMLANE_CELL_CAP,
  SWIMLANE_STAGES,
  layoutSwimlanes,
  type Run,
  type SwimlaneCard,
  type SwimlaneLaneBy,
  type SwimlaneLane,
  type Task,
  type TaskStatus,
} from '@tm/shared';
import type { BoardVersionProps } from '../../boardVersions.ts';
import { BoardFocusCard, BoardFocusProvider, BoardFocusScope, useBoardFocus, useBoardTasks } from '../../boardFocus.tsx';
import { BoardVersionsControl } from '../../components/BoardVersions.tsx';
import { BoardNewTask } from '../../components/BoardNewTask.tsx';
import { useIsMobile } from '../../components/Layout.tsx';
import { liveReviewRun } from '../../components/RunKind.tsx';
import { StatusBadge } from '../../components/StatusBadge.tsx';
import { ProgressPct } from '../../components/TaskProgress.tsx';
import { useNow } from '../../components/TimeAgo.tsx';
import { publishBusy, usePendingActions } from '../../pending.ts';
import { useApp } from '../../state.tsx';
import { RoleChip } from '../../components/RoleChip.tsx';

interface Prefs {
  laneBy: SwimlaneLaneBy;
  showAll: boolean;
}
const PREFS_KEY = 'tm.swimlanes';

function readPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return { laneBy: p.laneBy === 'repo' || p.laneBy === 'feature' ? p.laneBy : 'group', showAll: p.showAll === true };
  } catch {
    return { laneBy: 'group', showAll: false };
  }
}

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

const laneVar = (slot: number | null) => (slot ? `var(--tm-group-${slot})` : 'var(--tm-border-strong)');

const LANE_BY: { id: SwimlaneLaneBy; label: string; head: string }[] = [
  { id: 'group', label: 'group', head: 'Group' },
  { id: 'repo', label: 'repo', head: 'Repo' },
  { id: 'feature', label: 'feature', head: 'Feature' },
];

/** What a card reads beside the task row: the live run's activity, attention, a question, a review terminal. */
function useLive() {
  const { runs, activity, questions, orch } = useApp();
  const pendingActs = usePendingActions();
  return useMemo(() => {
    const running = new Map<string, Run>();
    for (const r of runs) if (r.taskId && r.status === 'running' && !running.has(r.taskId)) running.set(r.taskId, r);
    const asking = new Set(questions.map((q) => q.taskId));
    return {
      line: (t: Task) => {
        const r = running.get(t.id);
        return r ? activity[r.id]?.text ?? null : null;
      },
      attention: (t: Task) => t.status === 'running' && !!running.get(t.id)?.needsAttention,
      asking: (t: Task) => asking.has(t.id),
      busy: (t: Task) => publishBusy(t, runs, orch, pendingActs.get(t.id)),
      reviewer: (t: Task) => liveReviewRun(runs, t.id),
    };
  }, [runs, activity, questions, orch, pendingActs]);
}

type Live = ReturnType<typeof useLive>;

function Card({
  task,
  card,
  lane,
  live,
  multiRepo,
  repoName,
  onOpenTask,
  onOpenTerminal,
}: {
  task: Task;
  card: SwimlaneCard;
  lane: SwimlaneLane;
  live: Live;
  multiRepo: boolean;
  repoName: Map<string, string>;
  onOpenTask: (id: string) => void;
  onOpenTerminal: (runId: string) => void;
}) {
  const { focusedId, itemProps, toggle } = useBoardFocus();
  const line = live.line(task);
  const rv = live.reviewer(task);
  const focused = focusedId === task.id;
  return (
    <div
      className="sl-card"
      tabIndex={-1}
      data-child={card.depth > 0 ? '' : undefined}
      style={{ '--sl-depth': Math.min(card.depth, 3) } as CSSProperties}
      data-status={task.status}
      {...itemProps(task.id)}
    >
      <button type="button" className="sl-card-open" onClick={() => onOpenTask(task.id)} title="Open the task">
        <span className="sl-card-title">{task.title}</span>
        {line && (
          <span className="sl-card-live">
            <span className="live-dot" aria-hidden="true" />
            <span className="what">{line}</span>
          </span>
        )}
      </button>
      <span className="sl-card-meta">
        <StatusBadge
          status={task.status}
          attention={live.attention(task)}
          question={live.asking(task)}
          reviewState={task.reviewState}
          checkState={task.checkState}
          loopState={task.loopState}
          paused={!!task.pausedTurn}
          busy={live.busy(task)}
          explain={false}
          onOpenReviewer={rv ? () => onOpenTerminal(rv.id) : undefined}
        />
        {multiRepo && task.repoId && task.repoId !== lane.repoId && <span className="chip">{repoName.get(task.repoId) ?? 'repo'}</span>}
        <RoleChip task={task} />
        {task.createdByRun && (
          <span className="chip" title="filed by an agent session">
            agent
          </span>
        )}
        <ProgressPct task={task} />
        <button
          type="button"
          className="sl-rel"
          aria-pressed={focused}
          aria-label={focused ? 'Clear the relations focus' : `Show the relations of ${task.title}`}
          title={focused ? 'Clear focus (Esc)' : 'Show relations'}
          onClick={() => toggle(task.id)}
        >
          <span aria-hidden="true">⌁</span>
        </button>
      </span>
    </div>
  );
}

function LaneRow({
  lane,
  byTask,
  live,
  multiRepo,
  repoName,
  folded,
  onFold,
  onOpenTask,
  onOpenTerminal,
}: {
  lane: SwimlaneLane;
  byTask: Map<string, Task>;
  live: Live;
  multiRepo: boolean;
  repoName: Map<string, string>;
  folded: boolean;
  onFold: () => void;
  onOpenTask: (id: string) => void;
  onOpenTerminal: (runId: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  return (
    <div className="sl-lane" role="row" data-folded={folded ? '' : undefined} style={{ '--sl-g': laneVar(lane.colorSlot) } as CSSProperties}>
      <div className="sl-lhead" role="rowheader">
        <button type="button" className="sl-lname" aria-expanded={!folded} title={folded ? 'Unfold this lane' : 'Fold this lane'} onClick={onFold}>
          {lane.label}
        </button>
        <span className="sl-lsub">
          {lane.landed}/{lane.total} landed
          {lane.sub ? ` · ${lane.sub}` : ''}
        </span>
        <span className="sl-prog" role="img" aria-label={lane.segments.map((s) => `${s.count} ${s.status}`).join(', ')}>
          {lane.segments.map((s) => (
            <i key={s.status} style={{ flex: s.count, background: STATUS_COLOR[s.status] }} title={`${s.count} ${s.status}`} />
          ))}
        </span>
      </div>
      {SWIMLANE_STAGES.map((st) => {
        const cards = lane.cells[st.id];
        if (folded)
          return (
            <div key={st.id} className="sl-cell" role="cell">
              {cards.length > 0 && <span className="sl-count">{cards.length}</span>}
            </div>
          );
        const unfolded = open.has(st.id);
        const shown = unfolded ? cards : cards.slice(0, SWIMLANE_CELL_CAP);
        return (
          <div key={st.id} className="sl-cell" role="cell">
            {shown.map((c) => {
              const t = byTask.get(c.id);
              return t ? (
                <Card key={c.id} task={t} card={c} lane={lane} live={live} multiRepo={multiRepo} repoName={repoName} onOpenTask={onOpenTask} onOpenTerminal={onOpenTerminal} />
              ) : null;
            })}
            {cards.length > SWIMLANE_CELL_CAP && (
              <button
                type="button"
                className="btn ghost sl-more"
                onClick={() =>
                  setOpen((s) => {
                    const n = new Set(s);
                    if (n.has(st.id)) n.delete(st.id);
                    else n.add(st.id);
                    return n;
                  })
                }
              >
                {unfolded ? 'show fewer' : `+${cards.length - SWIMLANE_CELL_CAP} more`}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SwimlanesBody({ prefs, onOpenTask, onOpenTerminal }: { prefs: Prefs; onOpenTask: (id: string) => void; onOpenTerminal: (runId: string) => void }) {
  const { tasks } = useBoardFocus();
  const { repos, features, tasks: everyTask } = useApp();
  const live = useLive();
  // a hidden or out-of-scope group root still names (and colours) its lane
  const rootOf = useMemo(() => {
    const m = new Map(everyTask.filter((t) => t.id === t.groupId).map((t) => [t.id, t]));
    return (id: string) => m.get(id);
  }, [everyTask]);
  // the recent-landed cut-off moves with the 30 s clock, not on every render
  const now = useNow();
  const layout = useMemo(
    () => layoutSwimlanes({ tasks, laneBy: prefs.laneBy, repos, features, showAll: prefs.showAll, now, rootOf }),
    [tasks, prefs.laneBy, prefs.showAll, repos, features, now, rootOf],
  );
  const byTask = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const repoName = useMemo(() => new Map(repos.map((r) => [r.id, r.name])), [repos]);
  const multiRepo = useMemo(() => new Set(tasks.map((t) => t.repoId)).size > 1, [tasks]);
  // folding is per lane key and per session
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const fold = (id: string) =>
    setFolded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <BoardFocusScope className="sl-scope">
      {!layout.lanes.length ? (
        <p className="bf-empty sl-empty">{prefs.showAll ? 'No tasks in this workspace.' : 'Nothing live and nothing landed in the last 3 days. Pick All to see everything.'}</p>
      ) : (
        <div className="sl-wrap">
          <div className="sl-grid" role="table" aria-label="Tasks by lane and stage">
            <div className="sl-lane sl-headrow" role="row">
              <div className="sl-hcell sl-hcorner" role="columnheader">
                {LANE_BY.find((l) => l.id === prefs.laneBy)!.head}
              </div>
              {SWIMLANE_STAGES.map((st) => (
                <div key={st.id} className="sl-hcell" role="columnheader">
                  {st.label}
                  <span className="sl-hn">{layout.stageCounts[st.id]}</span>
                </div>
              ))}
            </div>
            {layout.lanes.map((lane) => (
              <LaneRow
                key={lane.id}
                lane={lane}
                byTask={byTask}
                live={live}
                multiRepo={multiRepo}
                repoName={repoName}
                folded={folded.has(lane.id)}
                onFold={() => fold(lane.id)}
                onOpenTask={onOpenTask}
                onOpenTerminal={onOpenTerminal}
              />
            ))}
          </div>
        </div>
      )}
    </BoardFocusScope>
  );
}

export default function Swimlanes({ onOpenTask, onOpenTerminal }: BoardVersionProps) {
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
    <div className="board sl-board">
      <div className="board-head">
        <h1 className="page-title">Board</h1>
        <div className="board-tools">
          <div className="rm-seg" role="radiogroup" aria-label="Lanes">
            <span className="rm-seg-label">Lanes</span>
            {LANE_BY.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={prefs.laneBy === m.id} className={prefs.laneBy === m.id ? 'on' : ''} onClick={() => setPrefs({ laneBy: m.id })}>
                {m.label}
              </button>
            ))}
          </div>
          <div className="rm-seg" role="radiogroup" aria-label="Landed tasks">
            {([false, true] as const).map((all) => (
              <button
                key={String(all)}
                type="button"
                role="radio"
                aria-checked={prefs.showAll === all}
                className={prefs.showAll === all ? 'on' : ''}
                title={all ? 'Every landed task' : 'Landed in the last 3 days only'}
                onClick={() => setPrefs({ showAll: all })}
              >
                {all ? 'All' : mobile ? 'Recent' : 'Hide finished'}
              </button>
            ))}
          </div>
          <BoardVersionsControl />
          <BoardNewTask />
        </div>
      </div>
      <BoardFocusProvider tasks={tasks}>
        <SwimlanesBody prefs={prefs} onOpenTask={onOpenTask} onOpenTerminal={onOpenTerminal} />
        <BoardFocusCard onOpenTask={onOpenTask} />
      </BoardFocusProvider>
    </div>
  );
}
