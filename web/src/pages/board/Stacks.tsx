// Board version "Stacks" (docs/board-versions.md § Stacks): the board sorted
// by what needs the human — Needs you · Working · Up next · Drafts · Landed ·
// Stopped. A group is ONE stack card in the section of its most urgent member
// ("now: X waits for your review"), with a pip per member in run order and
// landed/total; a click unfolds it in place, members on one coloured rail.
// Flat mode is the same sections with a group dot + name on each row. The
// sections and stacks are the pure `buildStacks` (shared) over `buildInbox`,
// so "needs you" means exactly what the Inbox means. Rows are the board's own
// `TaskRow` (live line, quick actions, progress); each carries a relations
// button for the shared focus layer, and a click on the row opens the panel.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  buildInbox,
  buildStacks,
  type StackGroup,
  type StackItem,
  type StackMember,
  type StackSection,
  type StackSectionId,
  type Task,
  type TaskStatus,
  heavyWaitLabel,
} from '@tm/shared';
import type { BoardVersionProps } from '../../boardVersions.ts';
import { BoardFocusCard, BoardFocusProvider, BoardFocusScope, useBoardFocus, useBoardTasks } from '../../boardFocus.tsx';
import { BoardVersionsControl } from '../../components/BoardVersions.tsx';
import { BoardNewTask } from '../../components/BoardNewTask.tsx';
import { IconChevron, IconRelations } from '../../components/Icons.tsx';
import { useIsMobile } from '../../components/Layout.tsx';
import { liveReviewRun } from '../../components/RunKind.tsx';
import { StatusBadge, badgeReading } from '../../components/StatusBadge.tsx';
import { TaskRow } from '../../components/TaskRow.tsx';
import { ProgressPct } from '../../components/TaskProgress.tsx';
import { publishBusy, usePendingActions } from '../../pending.ts';
import { useApp } from '../../state.tsx';

type Mode = 'stacks' | 'flat';
interface Prefs {
  mode: Mode;
  /** the folded sections the human opened (Landed and Stopped start folded) */
  open: StackSectionId[];
}
const PREFS_KEY = 'tm.stacks';
const FOLDED: StackSectionId[] = ['landed', 'stopped'];
/** rows a folded section shows once opened; "show more" adds as many again */
const RECENT = 20;
/** pips drawn before a "+n" (a feature plan can hold 80+ tasks) */
const MAX_PIPS = { desktop: 40, phone: 24 };

function readPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return {
      mode: p.mode === 'flat' ? 'flat' : 'stacks',
      open: Array.isArray(p.open) ? p.open.filter((s): s is StackSectionId => FOLDED.includes(s as StackSectionId)) : [],
    };
  } catch {
    return { mode: 'stacks', open: [] };
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
/** pips still to come are hollow; landed, working and everything else settled are filled */
const HOLLOW: TaskStatus[] = ['draft', 'queued', 'blocked'];

const groupVar = (slot: number) => `var(--tm-group-${slot})`;

/** The live inputs every badge on the board reads, built once per render pass. */
function useBadgeInputs() {
  const { runs, questions, orch } = useApp();
  const pendingActs = usePendingActions();
  const asking = useMemo(() => new Set(questions.map((q) => q.taskId)), [questions]);
  const attentive = useMemo(
    () => new Set(runs.filter((r) => r.needsAttention && r.status === 'running' && r.taskId).map((r) => r.taskId!)),
    [runs],
  );
  return (t: Task) => ({
    status: t.status,
    attention: t.status === 'running' && attentive.has(t.id),
    question: asking.has(t.id),
    reviewState: t.reviewState,
    checkState: t.checkState,
    loopState: t.loopState,
    paused: !!t.pausedTurn,
    busy: publishBusy(t, runs, orch, pendingActs.get(t.id)),
    heavyWait: heavyWaitLabel(orch.heavy, t.id),
  });
}
type BadgeInputsOf = ReturnType<typeof useBadgeInputs>;

/** The "now:" line's words for a stack's most urgent member. */
function nowWords(m: StackMember, label: string): string {
  switch (m.need) {
    case 'question':
      return 'asks you a question';
    case 'approval':
      return 'waits for your approval';
    case 'attention':
      return 'needs your attention';
    case 'review':
      return 'waits for your review';
    case 'failed':
      return 'failed';
  }
  const t = m.task;
  if (t.pausedTurn) return 'is paused';
  switch (t.status) {
    case 'running':
    case 'waiting':
    case 'review':
      if (label === 'auto-review') return 'is being reviewed';
      if (label === 'loop checks') return 'is running loop checks';
      if (label === 'next iteration') return 'waits for its next iteration';
      return `is ${label}`;
    case 'queued':
      return t.queueHeldAt ? 'is held' : 'is next';
    case 'blocked':
      return 'waits on its subtasks';
    case 'draft':
      return 'is a draft';
    case 'done':
      return 'landed';
    case 'published':
      return 'is published';
    case 'cancelled':
      return 'was cancelled';
    case 'failed':
      return 'failed';
  }
}

function Row({
  member,
  group,
  depth = 0,
  multiRepo,
  badge,
  onOpenTask,
  onOpenTerminal,
}: {
  member: StackMember;
  /** flat mode: the task's group, drawn as a dot + name */
  group?: { label: string; slot: number } | null;
  depth?: number;
  multiRepo: boolean;
  badge: BadgeInputsOf;
  onOpenTask: (id: string) => void;
  onOpenTerminal: (runId: string) => void;
}) {
  const t = member.task;
  const { runs, repos } = useApp();
  const { itemProps, toggle, focusedId } = useBoardFocus();
  const rv = liveReviewRun(runs, t.id);
  const repo = multiRepo && t.repoId ? repos.find((r) => r.id === t.repoId)?.name : null;
  return (
    <div className="st-row" {...itemProps(t.id)}>
      <TaskRow task={t} onOpenTask={onOpenTask} onOpenTerminal={onOpenTerminal} depth={depth} progress>
        {group && (
          <span className="st-gname" style={{ '--g': groupVar(group.slot) } as CSSProperties} title={`Group: ${group.label}`}>
            <i className="st-gdot" aria-hidden="true" />
            {group.label}
          </span>
        )}
        {repo && <span className="chip">{repo}</span>}
        <StatusBadge {...badge(t)} onOpenReviewer={rv ? () => onOpenTerminal(rv.id) : undefined} />
        <ProgressPct task={t} />
        <button
          type="button"
          className="btn ghost quick st-focus"
          aria-pressed={focusedId === t.id}
          aria-label={focusedId === t.id ? 'Hide relations' : 'Show relations'}
          title={focusedId === t.id ? 'Hide relations' : 'Show relations — parent, subtasks, filer, dispatch partners'}
          onClick={(e) => {
            e.stopPropagation();
            toggle(t.id);
          }}
        >
          <IconRelations />
        </button>
      </TaskRow>
    </div>
  );
}

function Stack({
  stack,
  open,
  onToggle,
  multiRepo,
  badge,
  onOpenTask,
  onOpenTerminal,
}: {
  stack: StackGroup;
  open: boolean;
  onToggle: () => void;
  multiRepo: boolean;
  badge: BadgeInputsOf;
  onOpenTask: (id: string) => void;
  onOpenTerminal: (runId: string) => void;
}) {
  const mobile = useIsMobile();
  const { stateOf, focusedId } = useBoardFocus();
  const now = stack.now;
  const more = stack.members.length - 1;
  // folded, the card stands in for its members in the focus layer: lit when
  // any member is, dimmed otherwise; unfolded, each row carries its own state
  const folded = focusedId
    ? stack.members.some((m) => stateOf(m.task.id) === 'focused')
      ? 'focused'
      : stack.members.some((m) => stateOf(m.task.id) === 'related')
        ? 'related'
        : 'dimmed'
    : undefined;
  const pips = stack.members.slice(0, MAX_PIPS[mobile ? 'phone' : 'desktop']);
  return (
    <div
      className={`st-stack${open ? ' open' : ''}`}
      style={{ '--g': groupVar(stack.slot) } as CSSProperties}
      data-focus={!open ? folded : undefined}
    >
      <div className="st-card">
        <button type="button" className="st-head" aria-expanded={open} onClick={onToggle}>
          <span className="st-caret" aria-hidden="true">
            <IconChevron />
          </span>
          <span className="st-head-text">
            <span className="st-name">{stack.label}</span>
            <span className="st-now">
              now: <em>{now.task.title}</em> {nowWords(now, badgeReading(badge(now.task)).label)}
              {more > 0 && ` · ${more} more`}
            </span>
          </span>
          <span className="st-pips" aria-label={`${stack.members.length} tasks in run order`}>
            {pips.map((m) => (
              <i
                key={m.task.id}
                className={HOLLOW.includes(m.task.status) ? 'hollow' : undefined}
                style={{ '--c': STATUS_COLOR[m.task.status] } as CSSProperties}
                title={`${m.task.title} — ${m.task.status}`}
              />
            ))}
            {pips.length < stack.members.length && <span className="st-pips-more">+{stack.members.length - pips.length}</span>}
          </span>
          <span className="st-frac" title={`${stack.landed} of ${stack.members.length} landed`}>
            {stack.landed}/{stack.members.length}
          </span>
        </button>
        {open && (
          <div className="st-kids">
            {stack.members.map((m) => (
              <Row
                key={m.task.id}
                member={m}
                depth={m.depth}
                multiRepo={multiRepo}
                badge={badge}
                onOpenTask={onOpenTask}
                onOpenTerminal={onOpenTerminal}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Sections({
  sections,
  mode,
  prefs,
  setPrefs,
  onOpenTask,
  onOpenTerminal,
}: {
  sections: StackSection[];
  mode: Mode;
  prefs: Prefs;
  setPrefs: (patch: Partial<Prefs>) => void;
  onOpenTask: (id: string) => void;
  onOpenTerminal: (runId: string) => void;
}) {
  const { tasks, focusedId } = useBoardFocus();
  const badge = useBadgeInputs();
  const [openStacks, setOpenStacks] = useState<ReadonlySet<string>>(new Set());
  const [limits, setLimits] = useState<Partial<Record<StackSectionId, number>>>({});
  const multiRepo = useMemo(() => new Set(tasks.map((t) => t.repoId)).size > 1, [tasks]);
  const toggleStack = (groupId: string) =>
    setOpenStacks((s) => {
      const next = new Set(s);
      if (!next.delete(groupId)) next.add(groupId);
      return next;
    });

  // A task focused from the relations card may sit in a folded stack or a
  // folded section: unfold the way to it, then bring it into view.
  const scrollTo = useRef<string | null>(null);
  useEffect(() => {
    if (!focusedId) return;
    for (const s of sections) {
      const at = s.items.findIndex((i) =>
        i.kind === 'stack' ? i.members.some((m) => m.task.id === focusedId) : i.member.task.id === focusedId,
      );
      if (at < 0) continue;
      const item = s.items[at];
      if (FOLDED.includes(s.id) && !prefs.open.includes(s.id)) setPrefs({ open: [...prefs.open, s.id] });
      if (FOLDED.includes(s.id) && at >= (limits[s.id] ?? RECENT)) setLimits((l) => ({ ...l, [s.id]: at + 1 }));
      if (item.kind === 'stack' && !openStacks.has(item.groupId)) setOpenStacks((o) => new Set(o).add(item.groupId));
      scrollTo.current = focusedId;
      break;
    }
    // only a NEW focus unfolds; folding a stack by hand afterwards is respected
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedId]);
  useEffect(() => {
    const id = scrollTo.current;
    if (!id) return;
    const el = document.querySelector(`.st-list [data-focus-id="${CSS.escape(id)}"]`);
    if (!el) return;
    scrollTo.current = null;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  if (!sections.length) return <p className="st-empty">No tasks in this workspace.</p>;
  return (
    <div className="st-list">
      {sections.map((s) => {
        const foldable = FOLDED.includes(s.id);
        const shown = !foldable || prefs.open.includes(s.id);
        const limit = foldable ? (limits[s.id] ?? RECENT) : Infinity;
        const items: StackItem[] = s.items.slice(0, limit);
        const count = (
          <span className="st-sec-n" title={`${s.tasks} task${s.tasks === 1 ? '' : 's'}`}>
            {s.items.length}
          </span>
        );
        return (
          <section key={s.id} className={`st-section st-${s.id}`} aria-label={s.label}>
            {foldable ? (
              <button
                type="button"
                className="st-sec st-sec-fold"
                aria-expanded={shown}
                onClick={() => setPrefs({ open: shown ? prefs.open.filter((x) => x !== s.id) : [...prefs.open, s.id] })}
              >
                <span className="st-caret" aria-hidden="true">
                  <IconChevron />
                </span>
                {s.label}
                {count}
              </button>
            ) : (
              <h2 className="st-sec">
                {s.label}
                {count}
              </h2>
            )}
            {shown &&
              items.map((i) =>
                i.kind === 'stack' ? (
                  <Stack
                    key={i.key}
                    stack={i}
                    open={openStacks.has(i.groupId)}
                    onToggle={() => toggleStack(i.groupId)}
                    multiRepo={multiRepo}
                    badge={badge}
                    onOpenTask={onOpenTask}
                    onOpenTerminal={onOpenTerminal}
                  />
                ) : (
                  <Row
                    key={i.key}
                    member={i.member}
                    group={mode === 'flat' ? i.group : null}
                    multiRepo={multiRepo}
                    badge={badge}
                    onOpenTask={onOpenTask}
                    onOpenTerminal={onOpenTerminal}
                  />
                ),
              )}
            {shown && s.items.length > limit && (
              <button type="button" className="btn ghost st-more" onClick={() => setLimits((l) => ({ ...l, [s.id]: limit + RECENT }))}>
                Show {Math.min(RECENT, s.items.length - limit)} more of {s.items.length - limit}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

function StacksBody({ prefs, setPrefs, onOpenTask, onOpenTerminal }: { prefs: Prefs; setPrefs: (p: Partial<Prefs>) => void } & BoardVersionProps) {
  const { tasks } = useBoardFocus();
  const { questions, approvals, runs, proposals, features } = useApp();
  // the inbox over the board's own set: scope and hidden already applied
  const inbox = useMemo(
    () => buildInbox({ tasks: [...tasks], questions, approvals, runs, proposals, features }),
    [tasks, questions, approvals, runs, proposals, features],
  );
  const sections = useMemo(() => buildStacks({ tasks, inbox, mode: prefs.mode }), [tasks, inbox, prefs.mode]);
  return (
    <BoardFocusScope className="st-scope">
      <Sections
        sections={sections}
        mode={prefs.mode}
        prefs={prefs}
        setPrefs={setPrefs}
        onOpenTask={onOpenTask}
        onOpenTerminal={onOpenTerminal}
      />
    </BoardFocusScope>
  );
}

export default function Stacks({ onOpenTask, onOpenTerminal }: BoardVersionProps) {
  const tasks = useBoardTasks();
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
    <div className="board st-board">
      <div className="board-head">
        <h1 className="page-title">Board</h1>
        <div className="board-tools">
          <div className="rm-seg" role="radiogroup" aria-label="Grouping">
            {(['stacks', 'flat'] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={prefs.mode === m} className={prefs.mode === m ? 'on' : ''} onClick={() => setPrefs({ mode: m })}>
                {m === 'stacks' ? 'Stacks' : 'Flat'}
              </button>
            ))}
          </div>
          <BoardVersionsControl />
          <BoardNewTask />
        </div>
      </div>
      <BoardFocusProvider tasks={tasks}>
        <StacksBody prefs={prefs} setPrefs={setPrefs} onOpenTask={onOpenTask} onOpenTerminal={onOpenTerminal} />
        <BoardFocusCard onOpenTask={onOpenTask} />
      </BoardFocusProvider>
    </div>
  );
}
