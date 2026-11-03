// Board version "Metro" (docs/board-versions.md § Metro): every group is a
// line in its colour and its tasks are stations in run order, so progress
// reads by shape — solid up to the last station that has started, dashed
// after it. A `blocked` split parent is the line's origin; deeper subtasks
// branch off below their station; single tasks are the "Local stops". The
// layout is the pure `layoutMetro` (shared), memoised. A click opens the task
// panel; the ⌖ knob (or R) focuses the task through the shared focus layer.
// On a phone the lines run vertically: a timetable, one card per line.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import {
  TERMINAL_TASK_STATUSES,
  layoutMetro,
  metroRows,
  type MetroLayout,
  type MetroLine,
  type MetroRow,
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
const PREFS_KEY = 'tm.metro';

function readScope(): Scope {
  try {
    return (JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as { scope?: string }).scope === 'all' ? 'all' : 'live';
  } catch {
    return 'live';
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

const groupVar = (slot: number | null) => (slot ? `var(--tm-group-${slot})` : 'var(--tm-text-faint)');

/** Local stops shown before "+N more". */
const LOCAL_CAP_DESKTOP = 16;
const LOCAL_CAP_PHONE = 8;

/** live: every group with a live member (whole, so the line keeps its shape) and every live single task. */
function useShownTasks(scope: Scope): Task[] {
  const { tasks } = useBoardFocus();
  return useMemo(() => {
    if (scope === 'all') return [...tasks];
    const liveGroups = new Set(tasks.filter(isLive).map((t) => t.groupId));
    return tasks.filter((t) => liveGroups.has(t.groupId));
  }, [tasks, scope]);
}

/** Two label lines of at most `max` characters, the second ellipsised (the mockup's rule). */
function twoLines(title: string, max: number): [string, string] {
  let l1 = '';
  let l2 = '';
  for (const w of title.split(/\s+/).filter(Boolean)) {
    if (!l2 && (l1 ? `${l1} ${w}` : w).length <= max) l1 = l1 ? `${l1} ${w}` : w;
    else l2 = l2 ? `${l2} ${w}` : w;
  }
  if (!l1) {
    // one long word
    l1 = l2.slice(0, max);
    l2 = l2.slice(max);
  }
  if (l2.length > max) l2 = `${l2.slice(0, max - 1)}…`;
  return [l1, l2];
}

function stationKeys(e: KeyboardEvent, open: () => void, relate: () => void) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    open();
  } else if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    relate();
  }
}

/** The station glyph: done/published filled, running/waiting pulsing, review amber with a centre dot, queued hollow, draft dashed hollow, failed red ×. */
function StationMark({ status, cx, cy, r = 9, origin = false }: { status: TaskStatus; cx: number; cy: number; r?: number; origin?: boolean }) {
  if (origin) return <circle className="mt-origin" cx={cx} cy={cy} r={6} />;
  const hollow = status === 'queued' || status === 'draft';
  const k = r * 0.45;
  return (
    <>
      {(status === 'running' || status === 'waiting') && <circle className="mt-pulse" cx={cx} cy={cy} r={r} />}
      <circle className={`mt-dot${hollow ? ' hollow' : ''}${status === 'draft' ? ' draft' : ''}`} cx={cx} cy={cy} r={r} />
      {(status === 'failed' || status === 'cancelled') && (
        <path className="mt-cut" d={`M${cx - k},${cy - k}L${cx + k},${cy + k}M${cx + k},${cy - k}L${cx - k},${cy + k}`} />
      )}
      {status === 'review' && <circle className="mt-core" cx={cx} cy={cy} r={r / 3} />}
      {status === 'blocked' && <path className="mt-cut" d={`M${cx - k / 2},${cy - k}V${cy + k}M${cx + k / 2},${cy - k}V${cy + k}`} />}
    </>
  );
}

// ── desktop map ──────────────────────────────────────────────────────────────

const SX = 150; // station spacing
const X0 = 76; // first station's x (the origin sits 50 left of it)
const Y0 = 30; // the main line's y inside a line's svg
const LANE = 70; // a branch lane's height
const R = 9;
const LABEL_W = 19; // characters per label line

const sx = (slot: number) => X0 + slot * SX;
const laneY = (lane: number) => Y0 + lane * LANE;
const lineHeight = (lanes: number) => laneY(lanes) + 52;
const lineWidth = (maxSlot: number) => sx(maxSlot) + SX / 2 + 20;
/** a row's size while `content-visibility` skips it: the 200px name column + its svg */
const intrinsic = (maxSlot: number, lanes: number) => `${200 + lineWidth(maxSlot)}px ${lineHeight(lanes)}px`;

interface Tip {
  id: string;
  left: number;
  top: number;
}

/** One station on the map: click/Enter opens the panel, the ⌖ knob or R focuses it. */
function Station({
  t,
  x,
  y,
  origin = false,
  label = true,
  onOpenTask,
  onTip,
}: {
  t: Task;
  x: number;
  y: number;
  origin?: boolean;
  label?: boolean;
  onOpenTask: (id: string) => void;
  onTip: (id: string, el: SVGGElement | null) => void;
}) {
  const { itemProps, toggle } = useBoardFocus();
  const [l1, l2] = useMemo(() => twoLines(t.title, LABEL_W), [t.title]);
  const faint = t.status === 'draft' || t.status === 'queued' || t.status === 'cancelled';
  return (
    <g
      className={`mt-st${origin ? ' mt-st-origin' : ''}`}
      style={{ '--mt-s': STATUS_COLOR[t.status] } as CSSProperties}
      role="button"
      tabIndex={0}
      aria-label={`${t.title} — ${t.status}${origin ? ' (split parent)' : ''}. Enter opens, R shows relations`}
      {...itemProps(t.id)}
      onClick={() => onOpenTask(t.id)}
      onKeyDown={(e) => stationKeys(e, () => onOpenTask(t.id), () => toggle(t.id))}
      onMouseEnter={(e) => onTip(t.id, e.currentTarget)}
      onMouseLeave={() => onTip(t.id, null)}
      onFocus={(e) => onTip(t.id, e.currentTarget)}
      onBlur={() => onTip(t.id, null)}
    >
      {/* the whole station and its label take the pointer, not only the painted dot */}
      <rect className="mt-hit" x={x - (origin ? 16 : SX / 2 - 6)} y={y - 16} width={origin ? 32 : SX - 12} height={label ? 62 : 32} />
      <circle className="mt-halo" cx={x} cy={y} r={origin ? 11 : 15} />
      <StationMark status={t.status} cx={x} cy={y} origin={origin} />
      {label && (
        <text className={`mt-lbl${faint ? ' faint' : ''}`} x={x} y={y + 27} textAnchor="middle">
          <tspan x={x}>{l1}</tspan>
          {l2 && (
            <tspan x={x} dy={14}>
              {l2}
            </tspan>
          )}
        </text>
      )}
      <g
        className="mt-rel"
        aria-hidden="true"
        onClick={(e) => {
          e.stopPropagation();
          toggle(t.id);
        }}
      >
        <title>Relations</title>
        <circle cx={x + 13} cy={y - 13} r={8} />
        <path d={`M${x + 10},${y - 11}L${x + 16},${y - 15}`} />
        <circle className="mt-rel-node" cx={x + 10} cy={y - 11} r={1.8} />
        <circle className="mt-rel-node" cx={x + 16} cy={y - 15} r={1.8} />
      </g>
    </g>
  );
}

const railClass = (solid: boolean) => `mt-rail ${solid ? 'solid' : 'dashed'}`;

function LineSvg({ line, byTask, onOpenTask, onTip }: { line: MetroLine; byTask: Map<string, Task>; onOpenTask: (id: string) => void; onTip: (id: string, el: SVGGElement | null) => void }) {
  const width = lineWidth(line.maxSlot);
  const height = lineHeight(line.lanes);
  const origin = line.originId ? byTask.get(line.originId) : undefined;
  const ox = X0 - 50;
  const rails: ReactNode[] = [];
  if (origin && line.main.length) rails.push(<line key="o" className={railClass(line.lastStarted >= 0)} x1={ox + 6} y1={Y0} x2={sx(0) - R - 3} y2={Y0} />);
  for (let i = 1; i < line.main.length; i++) {
    rails.push(<line key={`m${i}`} className={railClass(i <= line.lastStarted)} x1={sx(i - 1) + R + 3} y1={Y0} x2={sx(i) - R - 3} y2={Y0} />);
  }
  for (const b of line.branches) {
    const fx = sx(b.fromSlot);
    const by = laneY(b.lane);
    const firstX = sx(b.stations[0].slot);
    rails.push(
      <path
        key={`b${b.fromId}`}
        className={railClass(b.lastStarted >= 0)}
        d={`M${fx},${Y0 + R + 3} V${by - 22} Q${fx},${by} ${fx + 22},${by} H${firstX - R - 3}`}
      />,
    );
    for (let j = 1; j < b.stations.length; j++) {
      rails.push(
        <line key={`b${b.fromId}:${j}`} className={railClass(j <= b.lastStarted)} x1={sx(b.stations[j - 1].slot) + R + 3} y1={by} x2={sx(b.stations[j].slot) - R - 3} y2={by} />,
      );
    }
  }
  return (
    <svg className="mt-svg" width={width} height={height}>
      <g aria-hidden="true">{rails}</g>
      {origin && <Station t={origin} x={ox} y={Y0} origin label={false} onOpenTask={onOpenTask} onTip={onTip} />}
      {line.branches.flatMap((b) =>
        b.stations.map((s) => {
          const t = byTask.get(s.id);
          return t ? <Station key={s.id} t={t} x={sx(s.slot)} y={laneY(b.lane)} onOpenTask={onOpenTask} onTip={onTip} /> : null;
        }),
      )}
      {line.main.map((s) => {
        const t = byTask.get(s.id);
        return t ? <Station key={s.id} t={t} x={sx(s.slot)} y={Y0} onOpenTask={onOpenTask} onTip={onTip} /> : null;
      })}
    </svg>
  );
}

function LocalSvg({ ids, byTask, onOpenTask, onTip }: { ids: string[]; byTask: Map<string, Task>; onOpenTask: (id: string) => void; onTip: (id: string, el: SVGGElement | null) => void }) {
  const last = Math.max(0, ids.length - 1);
  return (
    <svg className="mt-svg" width={lineWidth(last)} height={lineHeight(0)}>
      <line className="mt-rail local" x1={sx(0) - 40} y1={Y0} x2={sx(last) + 40} y2={Y0} aria-hidden="true" />
      {ids.map((id, i) => {
        const t = byTask.get(id);
        return t ? <Station key={id} t={t} x={sx(i)} y={Y0} onOpenTask={onOpenTask} onTip={onTip} /> : null;
      })}
    </svg>
  );
}

function TipCard({ t }: { t: Task }) {
  const { repos } = useApp();
  const repo = t.repoId ? repos.find((r) => r.id === t.repoId)?.name : undefined;
  return (
    <>
      <b className="mt-tip-title">{t.title}</b>
      <span className="mt-tip-meta">
        <StatusBadge status={t.status} reviewState={t.reviewState} checkState={t.checkState} loopState={t.loopState} explain={false} />
        {repo && <span className="chip">{repo}</span>}
        <ProgressPct task={t} />
      </span>
      {t.costUsd > 0 && <span className="mt-tip-cost">${t.costUsd.toFixed(2)}</span>}
      <span className="mt-tip-hint">click opens · ⌖ or R: relations</span>
    </>
  );
}

const TIP_W = 260;

function MetroMap({ layout, onOpenTask }: { layout: MetroLayout; onOpenTask: (id: string) => void }) {
  const { tasks, focusedId } = useBoardFocus();
  const byTask = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const mapRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [allLocal, setAllLocal] = useState(false);

  const onTip = (id: string, el: SVGGElement | null) => {
    if (!el) {
      setTip((cur) => (cur?.id === id ? null : cur));
      return;
    }
    const map = mapRef.current;
    const inner = innerRef.current;
    if (!map || !inner) return;
    const ir = inner.getBoundingClientRect();
    const b = el.querySelector('.mt-halo')?.getBoundingClientRect() ?? el.getBoundingClientRect();
    const mr = map.getBoundingClientRect();
    const right = b.right + 8 + TIP_W <= mr.right;
    setTip({ id, left: right ? b.right - ir.left + 8 : b.left - ir.left - 8 - TIP_W, top: b.top - ir.top - 6 });
  };

  // a focus moved from the relations card to a station out of view brings it into view
  useEffect(() => {
    if (!focusedId) return;
    mapRef.current
      ?.querySelector(`[data-focus-id="${CSS.escape(focusedId)}"] .mt-halo`)
      ?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [focusedId]);

  const local = allLocal ? layout.local : layout.local.slice(0, LOCAL_CAP_DESKTOP);
  const more = layout.local.length - LOCAL_CAP_DESKTOP;
  const tipTask = tip ? byTask.get(tip.id) : undefined;

  return (
    <div ref={mapRef} className="mt-map">
      <div ref={innerRef} className="mt-inner">
        {layout.lines.map((line) => (
          <div key={line.id} className="mt-line" style={{ '--mt-c': groupVar(line.colorSlot), containIntrinsicSize: intrinsic(line.maxSlot, line.lanes) } as CSSProperties}>
            <div className="mt-name">
              <b title={line.label}>{line.label}</b>
              <span>
                {line.landed}/{line.count} landed{line.originId ? ' · split' : ''}
              </span>
            </div>
            <LineSvg line={line} byTask={byTask} onOpenTask={onOpenTask} onTip={onTip} />
          </div>
        ))}
        {layout.local.length > 0 && (
          <div className="mt-line mt-local" style={{ '--mt-c': groupVar(null), containIntrinsicSize: intrinsic(Math.max(0, local.length - 1), 0) } as CSSProperties}>
            <div className="mt-name">
              <b>Local stops</b>
              <span>ungrouped · {layout.local.length}</span>
              {more > 0 && (
                <button type="button" className="btn ghost mt-more" onClick={() => setAllLocal((v) => !v)}>
                  {allLocal ? 'show fewer' : `+${more} more`}
                </button>
              )}
            </div>
            <LocalSvg ids={local} byTask={byTask} onOpenTask={onOpenTask} onTip={onTip} />
          </div>
        )}
        {tip && tipTask && (
          <div className="mt-tip" style={{ left: tip.left, top: tip.top, width: TIP_W }} role="tooltip">
            <TipCard t={tipTask} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── phone timetable ──────────────────────────────────────────────────────────

type RailStyle = MetroRow['railUp'] | 'dotted';

function Rails({ up, down, x }: { up: RailStyle; down: RailStyle; x: 'main' | 'branch' }) {
  return (
    <>
      {up && <span className={`mt-trail up ${up} ${x}`} />}
      {down && <span className={`mt-trail down ${down} ${x}`} />}
    </>
  );
}

function TimetableRow({
  t,
  rails,
  branch,
  elbow,
  origin = false,
  onOpenTask,
}: {
  t: Task;
  rails: ReactNode;
  branch: boolean;
  elbow: MetroRow['branchUp'];
  origin?: boolean;
  onOpenTask: (id: string) => void;
}) {
  const { itemProps, toggle, focusedId } = useBoardFocus();
  return (
    <li className={`mt-row${branch ? ' branch' : ''}`} style={{ '--mt-s': STATUS_COLOR[t.status] } as CSSProperties} {...itemProps(t.id)}>
      <button type="button" className="mt-row-open" onClick={() => onOpenTask(t.id)}>
        <span className="mt-row-rail" aria-hidden="true">
          {rails}
          {elbow && <span className={`mt-elbow ${elbow}`} />}
          <svg className="mt-row-mark" width="22" height="22" viewBox="0 0 22 22">
            <StationMark status={t.status} cx={11} cy={11} r={8} origin={origin} />
          </svg>
        </span>
        <span className="mt-row-text">
          <span className="mt-row-title">{t.title}</span>
          <span className="mt-row-meta">
            {origin && <span className="mt-row-origin">origin · split</span>}
            <StatusBadge status={t.status} reviewState={t.reviewState} checkState={t.checkState} loopState={t.loopState} explain={false} />
            <ProgressPct task={t} />
          </span>
        </span>
      </button>
      <button
        type="button"
        className="mt-row-rel"
        aria-label={`Relations of ${t.title}`}
        aria-pressed={focusedId === t.id}
        onClick={() => toggle(t.id)}
      >
        ⌖
      </button>
    </li>
  );
}

function Timetable({ layout, onOpenTask }: { layout: MetroLayout; onOpenTask: (id: string) => void }) {
  const { tasks } = useBoardFocus();
  const byTask = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const [allLocal, setAllLocal] = useState(false);
  const local = allLocal ? layout.local : layout.local.slice(0, LOCAL_CAP_PHONE);
  const more = layout.local.length - LOCAL_CAP_PHONE;

  return (
    <div className="mt-tt">
      {layout.lines.map((line) => {
        const origin = line.originId ? byTask.get(line.originId) : undefined;
        const rows = metroRows(line);
        return (
          <section key={line.id} className="mt-card" style={{ '--mt-c': groupVar(line.colorSlot) } as CSSProperties}>
            <h2 className="mt-card-head">
              <span className="mt-card-name">{line.label}</span>
              <span className="mt-card-sub">
                {line.landed}/{line.count} landed{line.originId ? ' · split' : ''}
              </span>
            </h2>
            <ol>
              {origin && (
                <TimetableRow
                  t={origin}
                  origin
                  branch={false}
                  elbow={null}
                  rails={<Rails up={null} down={rows.length ? (line.lastStarted >= 0 ? 'solid' : 'dashed') : null} x="main" />}
                  onOpenTask={onOpenTask}
                />
              )}
              {rows.map((r, i) => {
                const t = byTask.get(r.id);
                if (!t) return null;
                // a branch's first station draws the elbow off the main rail instead of a rail above
                const first = r.branchOf != null && rows[i - 1]?.branchOf == null;
                return (
                  <TimetableRow
                    key={r.id}
                    t={t}
                    branch={r.branchOf != null}
                    elbow={first ? r.branchUp : null}
                    rails={
                      <>
                        <Rails up={r.railUp} down={r.railDown} x="main" />
                        {r.branchOf != null && <Rails up={first ? null : r.branchUp} down={r.branchDown} x="branch" />}
                      </>
                    }
                    onOpenTask={onOpenTask}
                  />
                );
              })}
            </ol>
          </section>
        );
      })}
      {layout.local.length > 0 && (
        <section className="mt-card mt-local" style={{ '--mt-c': groupVar(null) } as CSSProperties}>
          <h2 className="mt-card-head">
            <span className="mt-card-name">Local stops</span>
            <span className="mt-card-sub">ungrouped · {layout.local.length}</span>
          </h2>
          <ol>
            {local.map((id, i) => {
              const t = byTask.get(id);
              if (!t) return null;
              return (
                <TimetableRow
                  key={id}
                  t={t}
                  branch={false}
                  elbow={null}
                  rails={<Rails up={i > 0 ? 'dotted' : null} down={i < local.length - 1 ? 'dotted' : null} x="main" />}
                  onOpenTask={onOpenTask}
                />
              );
            })}
          </ol>
          {more > 0 && (
            <button type="button" className="btn ghost mt-more" onClick={() => setAllLocal((v) => !v)}>
              {allLocal ? 'show fewer' : `+${more} more`}
            </button>
          )}
        </section>
      )}
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

const KEY: { status: TaskStatus; label: string }[] = [
  { status: 'running', label: 'working' },
  { status: 'review', label: 'review' },
  { status: 'done', label: 'landed' },
  { status: 'queued', label: 'next' },
  { status: 'draft', label: 'draft' },
  { status: 'failed', label: 'failed' },
];

function MetroBody({ scope, onOpenTask }: { scope: Scope; onOpenTask: (id: string) => void }) {
  const mobile = useIsMobile();
  const { tasks } = useBoardFocus();
  const shown = useShownTasks(scope);
  const layout = useMemo(() => layoutMetro(shown), [shown]);
  const empty = !layout.lines.length && !layout.local.length;
  return (
    <BoardFocusScope className="mt-scope">
      {empty ? (
        <p className="bf-empty mt-empty">
          {scope === 'live' && tasks.length ? 'Nothing live in this workspace — switch to all to see landed lines.' : 'No tasks in this workspace.'}
        </p>
      ) : mobile ? (
        <Timetable layout={layout} onOpenTask={onOpenTask} />
      ) : (
        <MetroMap layout={layout} onOpenTask={onOpenTask} />
      )}
    </BoardFocusScope>
  );
}

export default function Metro({ onOpenTask }: BoardVersionProps) {
  const tasks = useBoardTasks();
  const mobile = useIsMobile();
  const [scope, setScopeState] = useState<Scope>(readScope);
  const setScope = (s: Scope) => {
    setScopeState(s);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: s }));
    } catch {
      // private mode: the pick lasts the session
    }
  };

  return (
    <div className="board mt-board">
      <div className="board-head">
        <h1 className="page-title">Board</h1>
        <div className="board-tools">
          {!mobile && (
            <div className="mt-key" aria-label="Stations">
              {KEY.map((k) => (
                <span key={k.status} style={{ '--mt-s': STATUS_COLOR[k.status] } as CSSProperties}>
                  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                    <StationMark status={k.status} cx={8} cy={8} r={5.5} />
                  </svg>
                  {k.label}
                </span>
              ))}
            </div>
          )}
          <div className="rm-seg" role="radiogroup" aria-label="Show">
            {(['live', 'all'] as const).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={scope === s} className={scope === s ? 'on' : ''} onClick={() => setScope(s)}>
                {s}
              </button>
            ))}
          </div>
          <BoardVersionsControl />
        </div>
      </div>
      <BoardFocusProvider tasks={tasks}>
        <MetroBody scope={scope} onOpenTask={onOpenTask} />
        <BoardFocusCard onOpenTask={onOpenTask} />
      </BoardFocusProvider>
    </div>
  );
}
