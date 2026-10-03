import { Fragment, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  EFFORT_LEVELS,
  GROUP_COLOR_COUNT,
  MODEL_OPTIONS,
  REVIEW_BUSY_STATES,
  REVIEW_NOW_FROM,
  groupAncestors,
  groupColorSlot,
  groupLabel,
  type EffortLevel,
  type Proposal,
  type Task,
} from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { DispatchStrip } from './DispatchStrip.tsx';
import { GroupPicker, type GroupChoicePlace } from './GroupPicker.tsx';
import { IconAnalyze, IconChevron, IconMore, IconPlay, IconPublish, IconQueue, IconTerminal, IconX } from './Icons.tsx';
import { useIsMobile } from './Layout.tsx';
import { Markdown } from './Markdown.tsx';
import { PresetPicker, reviewChoiceOf, reviewValueOf, type ReviewChoice } from './PresetPicker.tsx';
import { ReviewerFields, reviewIsOn } from './ReviewerPicker.tsx';
import { RunStatsChips } from './RunMeta.tsx';
import { StatusBadge } from './StatusBadge.tsx';
import { KindBadge, liveReviewRun, runTaskId } from './RunKind.tsx';
import { ReviewPanel } from './ReviewPanel.tsx';
import { QuestionForm } from './QuestionModal.tsx';
import { Sheet, SheetAction } from './Sheet.tsx';
import { exitGhost } from '../motion.ts';

/**
 * One button of the panel's action set. Desktop draws the whole list as one
 * wrapping row, in this order. Phones (docs/mobile.md § Task panel) pin up to
 * three of them in a bar (`MOBILE_PRIMARY`) and put the rest in a ⋯ sheet, with
 * the `destructive` ones apart at the bottom. Both read this one list, so the
 * conditions for offering an action cannot drift between the two.
 */
interface PanelAction {
  id: string;
  label: string;
  /** the bar's shorter wording, where the full label would not fit */
  short?: string;
  icon?: ReactNode;
  /** desktop button class after `btn` (`primary`, `danger`, `queue-btn`) */
  cls?: string;
  title?: string;
  disabled?: boolean;
  /** kills or discards something: bottom of the phone sheet, in red */
  destructive?: boolean;
  onClick: () => void;
}

/**
 * Which actions a phone pins in the bar, best first; at most three. With a live
 * session the terminal outranks starting anything new, which the server would
 * refuse anyway (the `hasLiveSession()` guard).
 */
const mobilePrimary = (live: boolean) =>
  live
    ? ['publish', 'complete', 'release', 'unblock', 'terminal', 'run-now', 'enqueue']
    : ['publish', 'complete', 'release', 'unblock', 'run-now', 'enqueue', 'terminal'];
const MOBILE_BAR_MAX = 3;
/** Same words as the board row (TaskRow), for the same server refusal. */
const LIVE_MSG = 'Previous session is still live — open its terminal or kill it first';

/** How a task's current parent reads in the group picker. */
function placeOfParent(t: Task): GroupChoicePlace {
  if (!t.parentId) return 'ungroup';
  return t.parentId === t.groupId ? 'group' : 'child';
}

/**
 * "at 18:40" for a wake-up still ahead, "now" for one already due — the wake
 * sweep runs on its own cadence, so a passed deadline means "any moment", not
 * "missed" (docs/wake.md).
 */
function fmtWake(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'when the window resets';
  if (at <= Date.now()) return 'now';
  const d = new Date(at);
  const clock = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `at ${clock}` : `at ${d.toLocaleDateString()} ${clock}`;
}

function ProposalCard({ p, onDone }: { p: Proposal; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [optIdx, setOptIdx] = useState(0);
  const act = async (accept: boolean) => {
    setBusy(true);
    try {
      if (accept) await api.acceptProposal(p.id, p.kind === 'solution_options' ? optIdx : undefined);
      else await api.rejectProposal(p.id);
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel" style={{ padding: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <span className="chip">{p.kind}</span>
        <span className="muted" style={{ fontSize: 11 }}>
          {new Date(p.createdAt).toLocaleString()}
        </span>
      </div>
      {p.payload.title && <div style={{ fontWeight: 600 }}>{p.payload.title}</div>}
      {p.payload.description && <div style={{ whiteSpace: 'pre-wrap' }}>{p.payload.description}</div>}
      <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
        {p.payload.rationale}
      </div>
      {p.kind === 'split' && p.payload.subtasks && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          {p.payload.subtasks.map((s, i) => (
            <li key={i}>
              <b>{s.title}</b> — <span className="muted">{s.description}</span>
            </li>
          ))}
        </ul>
      )}
      {p.kind === 'solution_options' && p.payload.options && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {p.payload.options.map((o, i) => (
            <label key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="radio" checked={optIdx === i} onChange={() => setOptIdx(i)} />
              <span>
                <b>{o.label}</b> — {o.approach} <span className="muted">({o.tradeoffs})</span>
              </span>
            </label>
          ))}
        </div>
      )}
      {p.status === 'pending' ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="btn primary" disabled={busy} onClick={() => act(true)}>
            Accept
          </button>
          <button className="btn" disabled={busy} onClick={() => act(false)}>
            Reject
          </button>
        </div>
      ) : (
        <div className="chip" style={{ marginTop: 8 }}>
          {p.status}
        </div>
      )}
    </div>
  );
}

/** The task's line of ancestry, root first — its path to the first parent. */
function GroupPath({ task, tasks, onOpen }: { task: Task; tasks: Task[]; onOpen: (id: string) => void }) {
  const ancestors = groupAncestors(task);
  if (ancestors.length === 0) return null;
  return (
    <div className="group-path">
      {ancestors.map((id) => {
        const a = tasks.find((t) => t.id === id);
        return (
          <span key={id}>
            <button className="crumb" title={a ? 'Open this task' : 'This ancestor no longer exists'} disabled={!a} onClick={() => onOpen(id)}>
              {a ? a.title : `${id.slice(0, 8)}…`}
            </button>
            <span className="sep">/</span>
          </span>
        );
      })}
      <span className="self">{task.title}</span>
    </div>
  );
}

export function TaskSlideOver({
  taskId,
  onClose,
  onOpenTask,
  onOpenTerminal,
}: {
  taskId: string;
  onClose: () => void;
  /** swap the panel to another task (the group breadcrumb) */
  onOpenTask: (id: string) => void;
  onOpenTerminal: (runId: string) => void;
}) {
  const { tasks, repos, runs, proposals, dispatches, refresh, questions, settings } = useApp();
  const task = tasks.find((t) => t.id === taskId);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [repoId, setRepoId] = useState<string>('');
  const [parentId, setParentId] = useState<string>('');
  const [parentPlace, setParentPlace] = useState<GroupChoicePlace>('ungroup');
  const [model, setModel] = useState<string>('');
  const [effort, setEffort] = useState<string>('');
  const [category, setCategory] = useState<string>('');
  const [groupName, setGroupName] = useState<string>('');
  const [groupColor, setGroupColor] = useState<string>('');
  const [review, setReview] = useState<ReviewChoice>('default');
  const [reviewModel, setReviewModel] = useState<string>('');
  const [reviewEffort, setReviewEffort] = useState<string>('');
  const [autoPublish, setAutoPublish] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [followUpMsg, setFollowUpMsg] = useState('');
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  const [resumeSession, setResumeSession] = useState<string | null>(null);
  const [files, setFiles] = useState<{ name: string; size: number; mtime: string }[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const mobile = useIsMobile();
  const [moreOpen, setMoreOpen] = useState(false);
  // Phones fold the settings grid away. A draft is still being written, so it
  // opens with the grid out; anything later is mostly read, not edited.
  const [settingsOpen, setSettingsOpen] = useState(task?.status === 'draft');

  const taskRuns = useMemo(() => runs.filter((r) => r.taskId === taskId), [runs, taskId]);
  // This task's OTHER terminals — its reviewer rounds and resume-gate
  // compactions (docs/design.md § PTY sessions). Never `taskRuns`: an aux run
  // is not the task's agent, so it must not become `latestRun` above.
  const auxRuns = useMemo(
    () => runs.filter((r) => r.mode === 'aux' && runTaskId(r) === taskId).slice(0, 6),
    [runs, taskId],
  );
  const reviewerRun = liveReviewRun(runs, taskId);
  // Changes whenever one of this task's runs gains a session id or ends, which
  // is exactly when resumability can flip.
  const runSig = useMemo(
    () => taskRuns.map((r) => `${r.id}:${r.sessionId ?? ''}:${r.status}`).join('|'),
    [taskRuns],
  );

  // Keyed on id, not the task object: task.updated events must not wipe edits.
  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDescription(task.description ?? '');
      setRepoId(task.repoId ?? '');
      setParentId(task.parentId ?? '');
      setParentPlace(placeOfParent(task));
      setModel(task.model ?? '');
      setEffort(task.effort ?? '');
      setCategory(task.category ?? '');
      setGroupName(task.groupName ?? '');
      setGroupColor(task.groupColor == null ? '' : String(task.groupColor));
      setReview(reviewChoiceOf(task.review));
      setReviewModel(task.reviewModel ?? '');
      setReviewEffort(task.reviewEffort ?? '');
      setAutoPublish(task.autoPublish);
      setFollowUpMsg('');
      setSettingsOpen(task.status === 'draft');
      setMoreOpen(false);
    }
  }, [task?.id]);

  // Deliverable files — refresh when the panel opens and when the task's
  // status changes (a finished run may have just written files).
  useEffect(() => {
    if (!task) return;
    api.taskFiles(task.id).then(setFiles).catch(() => setFiles([]));
  }, [task?.id, task?.status]);

  // Can "Proceed" reopen an earlier agent session? Only the server knows —
  // it also checks the transcript is still on disk. Re-checked when a run
  // starts/ends so the button appears as soon as a session is recorded.
  useEffect(() => {
    if (!task) return;
    let live = true;
    api
      .resumable(task.id)
      .then((r) => live && setResumeSession(r.sessionId))
      .catch(() => live && setResumeSession(null));
    return () => {
      live = false;
    };
  }, [task?.id, runSig]);

  const latestRun = taskRuns[0];
  // the question the agent is waiting on, if any (docs/questions.md)
  const pendingQuestion = useMemo(
    () => [...questions].filter((q) => q.taskId === taskId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null,
    [questions, taskId],
  );
  const taskProposals = useMemo(() => proposals.filter((p) => p.taskId === taskId), [proposals, taskId]);

  if (!task) return null;

  // group identity lives on the ROOT task — the server rejects it elsewhere
  const isRoot = task.id === task.groupId;
  const groupTasks = tasks.filter((t) => t.groupId === task.groupId);
  const groupRoot = groupTasks.find((t) => t.id === task.groupId);
  const slot = groupColorSlot(groupRoot, task.groupId);
  const groupTint = { '--tm-group': `var(--tm-group-${slot})` } as CSSProperties;
  // The parent the panel would save right now — group identity belongs to a
  // root, so the fields below are only sent while the task stays one.
  const parentAfter = parentId || null;
  const rootAfter = isRoot && !parentAfter;
  // "append to the group" and "under its root" share a parent id, so a change
  // of place alone (moving to the group's end) is a change too.
  const regroup = parentId !== (task.parentId ?? '') || (!!parentAfter && parentPlace !== placeOfParent(task));

  const dirty =
    title !== task.title ||
    description !== (task.description ?? '') ||
    repoId !== (task.repoId ?? '') ||
    regroup ||
    model !== (task.model ?? '') ||
    effort !== (task.effort ?? '') ||
    category !== (task.category ?? '') ||
    review !== reviewChoiceOf(task.review) ||
    reviewModel !== (task.reviewModel ?? '') ||
    reviewEffort !== (task.reviewEffort ?? '') ||
    autoPublish !== task.autoPublish ||
    (rootAfter &&
      (groupName !== (task.groupName ?? '') || groupColor !== (task.groupColor == null ? '' : String(task.groupColor))));

  const save = async () => {
    setErr(null);
    try {
      // The group move goes first and on its own route: it positions the task
      // (end of the group) and it is the half that can be refused (a blocked
      // split parent), and a refusal must not leave the other fields half-saved
      // against a group the human did not end up in. It also has to precede
      // the name/colour patch, which only a root may carry.
      if (regroup) {
        const moved = await api.moveTask(
          task.id,
          parentAfter
            ? { place: parentPlace === 'group' ? 'group' : 'child', targetId: parentAfter }
            : { place: 'ungroup' },
        );
        setParentPlace(placeOfParent(moved));
      }
      await api.updateTask(task.id, {
        title,
        description: description || null,
        repoId: repoId || null,
        model: model || null,
        effort: (effort || null) as EffortLevel | null,
        category: category.trim() || null,
        review: reviewValueOf(review),
        // kept while hidden: switching review off must not forget the pick
        reviewModel: reviewModel || null,
        reviewEffort: (reviewEffort || null) as EffortLevel | null,
        autoPublish,
        ...(rootAfter
          ? { groupName: groupName.trim() || null, groupColor: groupColor === '' ? null : Number(groupColor) }
          : {}),
      });
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const action = async (
    a: Parameters<typeof api.taskAction>[1],
  ) => {
    setErr(null);
    try {
      await api.taskAction(task.id, a);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const analyze = async () => {
    setErr(null);
    if (!task.repoId) {
      setErr('Assign a repo before analyzing');
      return;
    }
    try {
      await api.analyze({ repoId: task.repoId, taskIds: [task.id] });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const loadFiles = () => task && api.taskFiles(task.id).then(setFiles).catch(() => {});
  const doUpload = async (fileList: FileList | File[]) => {
    if (!task) return;
    const arr = Array.from(fileList);
    if (arr.length === 0) return;
    setUploading(true);
    setErr(null);
    try {
      await api.uploadTaskFiles(task.id, arr);
      loadFiles();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUploading(false);
    }
  };
  const delFile = async (name: string) => {
    if (!task) return;
    try {
      await api.deleteTaskFile(task.id, name);
      loadFiles();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  // Both follow-up buttons: same busy/error/clear handling, different call.
  const send = async (call: () => Promise<unknown>) => {
    setErr(null);
    setSendingFollowUp(true);
    try {
      await call();
      setFollowUpMsg('');
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSendingFollowUp(false);
    }
  };

  const del = async () => {
    if (!confirm('Delete this task?')) return;
    try {
      await api.deleteTask(task.id);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const reviewBusy = task.reviewState !== null && REVIEW_BUSY_STATES.includes(task.reviewState);
  const actions: PanelAction[] = [];
  const running = task.status === 'running' || task.status === 'waiting';
  // the client mirror of the server's hasLiveSession() guard (see TaskRow):
  // enqueue, add-to-queue, release and run-now are refused while the PTY is up
  const liveSession = taskRuns.some((r) => r.status === 'running');
  if (['draft', 'review', 'blocked', 'failed', 'cancelled'].includes(task.status)) {
    actions.push({
      id: 'enqueue',
      label: 'Enqueue',
      disabled: liveSession,
      title: liveSession ? LIVE_MSG : 'Mark it ready — the orchestrator claims it when a slot frees up',
      onClick: () => action('enqueue'),
    });
  }
  // custom queue (docs/queue.md): runs even with the global queue stopped, one task at a time
  if (['draft', 'review', 'failed', 'cancelled'].includes(task.status) || (task.status === 'queued' && !task.customQueueAt)) {
    actions.push({
      id: 'queue',
      label: 'Add to queue',
      icon: <IconQueue />,
      cls: 'queue-btn',
      disabled: liveSession,
      title: liveSession ? LIVE_MSG : 'Add to the queue — runs one task at a time, independent of the global queue',
      onClick: () => action('queue'),
    });
  }
  if (task.status === 'queued' && task.customQueueAt) {
    actions.push({ id: 'unqueue', label: 'Remove from queue', cls: 'danger', title: 'Take it out of the one-at-a-time queue', onClick: () => action('unqueue') });
  }
  if (['draft', 'queued', 'review', 'failed', 'cancelled'].includes(task.status)) {
    actions.push({
      id: 'run-now',
      label: 'Run now',
      icon: <IconPlay />,
      cls: 'primary',
      disabled: liveSession,
      title: liveSession ? LIVE_MSG : 'Spawn an agent at once, ahead of the queue',
      onClick: () => action('run-now'),
    });
  }
  if (task.status === 'queued' && task.queueHeldAt) {
    actions.push({
      id: 'release',
      label: 'Release',
      cls: 'primary',
      disabled: liveSession,
      title: liveSession ? LIVE_MSG : 'Let the queue take this task again, from the place it kept',
      onClick: () => action('release'),
    });
  }
  if (running) {
    actions.push({
      id: 'undo',
      label: 'Undo start',
      title:
        'Stop this run and put the task back where it was before it started (a queued task keeps its place, held until you Release it). Nothing in the working tree is reverted.',
      onClick: () => action('undo'),
    });
    actions.push({ id: 'cancel', label: 'Cancel', cls: 'danger', destructive: true, title: 'Kill the run and cancel the task', onClick: () => action('cancel') });
  }
  if (task.status === 'queued' && !task.customQueueAt) {
    actions.push({
      id: 'dequeue',
      label: 'Remove from queue',
      cls: 'danger',
      destructive: true,
      title: 'Cancel the task — it leaves the global queue',
      onClick: () => action('cancel'),
    });
  }
  if (task.status === 'review') {
    actions.push({
      id: 'publish',
      label: 'Publish',
      icon: <IconPublish />,
      cls: 'primary',
      title: resumeSession
        ? `Commit and push this work in session ${resumeSession.slice(0, 8)} — the same terminal the agent worked in`
        : 'Commit and push this work (no agent session left to reopen, so the server does it directly)',
      onClick: () => action('publish'),
    });
    actions.push({ id: 'complete', label: 'Mark done', title: 'Close the task without publishing', onClick: () => action('complete') });
  }
  // "Review now" (docs/design.md § Adversarial review): runs the reviewer itself, fresh verdict
  if (task.repoId && REVIEW_NOW_FROM.includes(task.status)) {
    actions.push({
      id: 'review-now',
      label: 'Review now',
      icon: <IconAnalyze />,
      disabled: reviewBusy,
      title: reviewBusy
        ? 'A review round is already queued, running or being fixed'
        : task.status === 'review'
          ? 'Run the adversarial reviewer over the current diff now — blocker/major findings go back to the live session to fix'
          : 'Run the adversarial reviewer over the current diff now — the verdict is recorded, the status stays',
      onClick: async () => {
        setErr(null);
        try {
          // No refresh(): the round can settle (empty/unchanged diff)
          // within ms, and a full list read in flight across that
          // write lands after the WS row and pins a stale `pending`.
          // The `task.updated` broadcasts carry both steps in order.
          await api.reviewNow(task.id);
        } catch (e) {
          setErr((e as Error).message);
        }
      },
    });
  }
  if (['review', 'done', 'failed'].includes(task.status)) {
    actions.push({
      id: 'apply-review',
      label: 'Apply review fixes',
      icon: <IconAnalyze />,
      title: task.reviewSummary
        ? 'Send the review findings back to a worker to fix'
        : 'Adversarially review this task and fix what it finds',
      onClick: async () => {
        setErr(null);
        try {
          await api.applyReview(task.id);
          await refresh();
        } catch (e) {
          setErr((e as Error).message);
        }
      },
    });
  }
  if (task.status === 'blocked') {
    actions.push({ id: 'unblock', label: 'Unblock', title: 'Stop waiting on its split children and let it run', onClick: () => action('unblock') });
  }
  if (latestRun) {
    actions.push({
      id: 'terminal',
      label: 'Open terminal',
      short: 'Terminal',
      icon: <IconTerminal />,
      title: `Attach to session ${latestRun.id.slice(0, 8)}${latestRun.status === 'running' ? '' : ' (ended)'}`,
      onClick: () => onOpenTerminal(latestRun.id),
    });
  }
  if (task.status !== 'running' && latestRun?.status === 'running') {
    actions.push({
      id: 'stop-agent',
      label: 'Stop agent',
      cls: 'danger',
      destructive: true,
      title: "Close the agent's terminal session (task status is unchanged)",
      onClick: async () => {
        setErr(null);
        try {
          await api.stopAgent(task.id);
          await refresh();
        } catch (e) {
          setErr((e as Error).message);
        }
      },
    });
  }
  actions.push({ id: 'analyze', label: 'Analyze', icon: <IconAnalyze />, title: 'A read-only session reads the repo and proposes how to split or solve this task', onClick: analyze });
  actions.push({ id: 'delete', label: 'Delete', cls: 'danger', destructive: true, title: 'Delete the task (asks first)', onClick: del });

  // Phones: the bar takes the best few non-destructive actions, the sheet the rest.
  // disabled actions stay in the sheet, where their reason is printed
  const barIds = mobilePrimary(liveSession)
    .filter((id) => actions.some((a) => a.id === id && !a.destructive && !a.disabled))
    .slice(0, MOBILE_BAR_MAX);
  const bar = barIds.map((id) => actions.find((a) => a.id === id)!);
  const overflow = actions.filter((a) => !barIds.includes(a.id));
  const sheetAct = (a: PanelAction) => (
    <SheetAction
      key={a.id}
      icon={a.icon}
      label={a.label}
      hint={a.title}
      tone={a.destructive ? 'danger' : undefined}
      disabled={a.disabled}
      onClick={() => {
        setMoreOpen(false);
        a.onClick();
      }}
    />
  );

  // the head is the drag handle on a phone; its close button animates the sheet out first
  const head = (close: () => void) => (
    <div className="slideover-head">
      <span className="mono muted">{task.id.slice(0, 8)}</span>
      <StatusBadge
        status={task.status}
        attention={latestRun?.needsAttention && task.status === 'running'}
        question={!!pendingQuestion}
        reviewState={task.reviewState}
        onOpenReviewer={reviewerRun ? () => onOpenTerminal(reviewerRun.id) : undefined}
      />
      {/* phones: the title stays in view while the body scrolls under it */}
      {mobile && <span className="so-title">{task.title}</span>}
      {/* a phone gives the chips their own line only when they say more than "manual" */}
      <span
        className={`so-chips${
          task.source === 'manual' && !task.category && groupTasks.length < 2 && !task.parentId && !task.createdByRun
            ? ' plain'
            : ''
        }`}
      >
        <span className="chip">{task.source}</span>
        {task.category && <span className="chip" style={{ color: 'var(--tm-accent)' }}>{task.category}</span>}
        {groupTasks.length > 1 && (
          <span
            className="chip group-chip"
            style={groupTint}
            title={`task group · ${groupTasks.length} tasks${isRoot ? ' · this is the group root' : ''}`}
          >
            {groupLabel(groupRoot, task.title)} · {groupTasks.length}
          </span>
        )}
        {task.parentId && <span className="chip">subtask</span>}
        {task.createdByRun && (
          <span className="chip" title={`filed by agent run ${task.createdByRun.slice(0, 8)} (depth ${task.spawnDepth})`}>
            agent d{task.spawnDepth}
          </span>
        )}
      </span>
      <span className="spacer" style={{ flex: 1 }} />
      <button className="btn ghost" aria-label="Close" onClick={close}>
        <IconX />
      </button>
    </div>
  );

  const actionBar = (
    <div className="so-bar">
      {bar.map((a, i) => (
        <button
          key={a.id}
          className={`btn${i === 0 ? ' primary' : ''}`}
          disabled={a.disabled}
          onClick={a.onClick}
        >
          {a.icon}
          {a.icon ? ' ' : ''}
          {a.short ?? a.label}
        </button>
      ))}
      <button className="btn so-more" aria-expanded={moreOpen} aria-label="More actions" onClick={() => setMoreOpen(true)}>
        <IconMore />
        {bar.length === 0 && ' Actions'}
      </button>
    </div>
  );

  const body = (
    <>
      <GroupPath task={task} tasks={tasks} onOpen={onOpenTask} />
      {pendingQuestion && (
        <div className="qpanel so-question">
          <label className="label">The agent is asking you</label>
          <QuestionForm question={pendingQuestion} />
        </div>
      )}
      {/* phones: the run's numbers ride at the top, since the action row they sit in is gone */}
      {mobile && latestRun && (
        <div className="so-stats">
          <RunStatsChips run={latestRun} />
        </div>
      )}
      <div>
        <label className="label">Title</label>
        <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <label className="label">Description</label>
        <textarea
          className="field"
          rows={6}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      {mobile && (
        <button
          className="so-settings-toggle"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((v) => !v)}
        >
          <span className={`caret ${settingsOpen ? '' : 'closed'}`}>
            <IconChevron />
          </span>
          <span className="label">Settings</span>
          <span className="so-settings-sum mono">
            {[
              repos.find((r) => r.id === repoId)?.name ?? 'no repo',
              model || 'default model',
              effort || 'default effort',
            ].join(' · ')}
          </span>
        </button>
      )}
      {(!mobile || settingsOpen) && (
        <div className="form-grid">
          <div>
            <label className="label">Repo</label>
            <select className="field" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
              <option value="">— none —</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.role ? ` (${r.role})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Category</label>
            <input
              className="field"
              list="tm-categories-drawer"
              placeholder="UI, Estimator…"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
            <datalist id="tm-categories-drawer">
              {[...new Set(tasks.map((t) => t.category).filter(Boolean))].map((c) => (
                <option key={c as string} value={c as string} />
              ))}
            </datalist>
          </div>
          <div className="wide">
            <label className="label">Group</label>
            <GroupPicker
              tasks={tasks}
              task={task}
              repoId={task.repoId}
              value={parentAfter}
              valuePlace={parentPlace}
              onChange={(id, place) => {
                setParentId(id ?? '');
                setParentPlace(place);
              }}
              repoName={(id) => repos.find((r) => r.id === id)?.name}
            />
            <div className="hint">
              {!regroup
                ? 'Or drag the row on the board: onto a task to group with it, above or below to reorder.'
                : parentAfter
                  ? 'Saving moves this task — and everything under it — to the end of that group.'
                  : 'Saving takes this task out of its group. Its own subtasks come with it.'}
            </div>
          </div>
          {rootAfter && groupTasks.length > 1 && (
            <>
              <div>
                <label className="label">Group name</label>
                <input
                  className="field"
                  placeholder={task.title}
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                />
              </div>
              <div>
                <label className="label">Group colour</label>
                <select
                  className="field group-swatch"
                  style={groupColor === '' ? groupTint : ({ '--tm-group': `var(--tm-group-${groupColor})` } as CSSProperties)}
                  value={groupColor}
                  onChange={(e) => setGroupColor(e.target.value)}
                >
                  <option value="">auto (from group id)</option>
                  {Array.from({ length: GROUP_COLOR_COUNT }, (_, i) => (
                    <option key={i + 1} value={String(i + 1)}>
                      colour {i + 1}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
          <div className="wide">
            <label className="label">Preset</label>
            <PresetPicker
              model={model}
              effort={effort}
              review={review}
              onApply={(p) => {
                setModel(p.model);
                setEffort(p.effort);
                setReview(reviewChoiceOf(p.review));
              }}
            />
          </div>
          <div>
            <label className="label">Adversarial review</label>
            <select className="field" value={review} onChange={(e) => setReview(e.target.value as ReviewChoice)}>
              <option value="default">default (config)</option>
              <option value="on">review this</option>
              <option value="off">skip (small task)</option>
            </select>
          </div>
          <div>
            <label className="label">Auto-publish on end</label>
            <select
              className="field"
              value={autoPublish ? 'on' : 'off'}
              onChange={(e) => setAutoPublish(e.target.value === 'on')}
            >
              <option value="off">off — stop at review</option>
              <option value="on">on — commit &amp; push at the end</option>
            </select>
          </div>
          <div>
            <label className="label">Updated</label>
            <div className="mono muted" style={{ paddingTop: 6 }}>
              {new Date(task.updatedAt).toLocaleString()}
            </div>
          </div>
          <div>
            <label className="label">Model</label>
            <select className="field mono" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">default (config)</option>
              {(model && !MODEL_OPTIONS.includes(model) ? [model, ...MODEL_OPTIONS] : MODEL_OPTIONS).map(
                (m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ),
              )}
            </select>
          </div>
          <div>
            <label className="label">Effort</label>
            <select className="field mono" value={effort} onChange={(e) => setEffort(e.target.value)}>
              <option value="">default (config)</option>
              {EFFORT_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          {reviewIsOn(reviewValueOf(review), settings) && (
            <ReviewerFields
              model={reviewModel}
              effort={reviewEffort}
              onModel={setReviewModel}
              onEffort={setReviewEffort}
              settings={settings}
            />
          )}
        </div>
      )}

      {dirty && (
        <div className="so-save">
          <button className="btn primary" onClick={save}>
            Save changes
          </button>
        </div>
      )}

      {err && <div className="warn-text so-alert">{err}</div>}
      {task.error && (
        <div className="warn-text so-alert" style={{ whiteSpace: 'pre-wrap' }}>
          {task.error}
        </div>
      )}
      {task.wakeAt && (
        <div className="hint so-alert" style={{ color: 'var(--tm-accent)' }}>
          waiting on the 5h usage window — this task's own session resumes automatically{' '}
          {fmtWake(task.wakeAt)}
        </div>
      )}
      {task.status === 'queued' && task.queueHeldAt && (
        <div className="hint so-alert" style={{ color: 'var(--tm-accent)' }}>
          held by Undo start — it keeps its place, but the queue skips it until you Release it (or Run now)
        </div>
      )}
      <div className="so-review">
        <ReviewPanel task={task} />
      </div>
      {task.resultSummary && (
        <div className="so-summary">
          <Markdown label="Worker's summary" text={task.resultSummary} />
        </div>
      )}

      <div className="so-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {actions.map((a) => (
          <Fragment key={a.id}>
            {/* the run's cost/context chips sit just before Analyze, as they always have */}
            {a.id === 'analyze' && latestRun && <RunStatsChips run={latestRun} />}
            <button
              className={`btn${a.cls ? ` ${a.cls}` : ''}`}
              title={a.title}
              disabled={a.disabled}
              onClick={a.onClick}
            >
              {a.icon}
              {a.icon ? ' ' : ''}
              {a.label}
            </button>
          </Fragment>
        ))}
      </div>

      {auxRuns.length > 0 && (
        <div className="aux-runs">
          <div className="section-head">Review &amp; compaction terminals</div>
          {auxRuns.map((r) => (
            <div className="aux-run" key={r.id}>
              <KindBadge kind={r.kind} />
              <span className={r.status === 'running' ? 'aux-run-live' : 'muted'}>
                {r.status === 'running' ? 'live' : r.status === 'killed' ? 'stopped' : r.exitCode === 0 ? 'done' : 'failed'}
              </span>
              <span className="mono muted">{new Date(r.startedAt).toLocaleString()}</span>
              {r.stats && <span className="mono muted">${r.stats.costUsd.toFixed(3)}</span>}
              <button className="btn" onClick={() => onOpenTerminal(r.id)}>
                <IconTerminal /> Terminal
              </button>
            </div>
          ))}
        </div>
      )}

      {(task.status !== 'draft' || latestRun) && (
        <div className="so-followup">
          <label className="label">Follow-up</label>
          <textarea
            className="field"
            rows={3}
            placeholder={
              resumeSession
                ? 'New instruction — continues the agent\'s previous session, which still remembers everything'
                : 'New instruction — re-runs the task with the previous summary as context'
            }
            value={followUpMsg}
            onChange={(e) => setFollowUpMsg(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              className="btn primary"
              disabled={!followUpMsg.trim() || sendingFollowUp}
              onClick={() => send(() => api.followUp(task.id, followUpMsg.trim()))}
            >
              {sendingFollowUp ? 'Sending…' : 'Send follow-up'}
            </button>
            <button
              className="btn"
              disabled={!resumeSession || sendingFollowUp}
              title={
                resumeSession
                  ? `Reopen session ${resumeSession.slice(0, 8)} and carry on — use this when the terminal died mid-task (usage limit, dropped connection). Any text above is sent as the instruction.`
                  : 'No agent session to continue — run the task first, or use Run now for a fresh agent'
              }
              onClick={() => send(() => api.proceed(task.id, followUpMsg.trim() || undefined))}
            >
              <IconPlay /> Proceed
            </button>
            {resumeSession && (
              <span className="mono muted" style={{ fontSize: 11 }}>
                resumes {resumeSession.slice(0, 8)}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="section-head">Files</div>
      <div
        className={`dropzone ${dragOver ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void doUpload(e.dataTransfer.files);
        }}
        onClick={() => document.getElementById(`tm-file-${task.id}`)?.click()}
      >
        {uploading ? 'Uploading…' : 'Drop screenshots or files here, or click to pick'}
        <input
          id={`tm-file-${task.id}`}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files) void doUpload(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {files.length > 0 && (
        <div className="panel">
          {files.map((f) => (
            <div key={f.name} className="task-row" style={{ cursor: 'default' }}>
              <a
                className="title mono"
                style={{ textDecoration: 'none', color: 'inherit', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
                href={`/api/tasks/${task.id}/files/${encodeURIComponent(f.name)}`}
                download={f.name}
              >
                {f.name}
              </a>
              <span className="mono muted">
                {f.size < 1024 ? `${f.size} B` : f.size < 1048576 ? `${(f.size / 1024).toFixed(1)} KB` : `${(f.size / 1048576).toFixed(1)} MB`}
              </span>
              <button
                className="btn ghost"
                title="remove"
                onClick={() => delFile(f.name)}
                style={{ padding: '2px 8px' }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {dispatches.some((d) => d.fromTaskId === task.id || d.toTaskId === task.id) && (
        <>
          <div className="section-head">Dispatches</div>
          <div className="panel" style={{ padding: '6px 10px' }}>
            <DispatchStrip taskId={task.id} direction="both" full onOpenTask={onOpenTask} />
          </div>
        </>
      )}

      {taskProposals.length > 0 && (
        <>
          <div className="section-head">Proposals</div>
          {taskProposals.map((p) => (
            <ProposalCard key={p.id} p={p} onDone={refresh} />
          ))}
        </>
      )}
    </>
  );

  // a phone: a full-height sheet that drags down to close (docs/mobile.md § Task panel)
  if (mobile)
    return (
      <>
        <Sheet
          label={`Task ${task.title}`}
          tall
          className="slideover-sheet sheet-flush"
          bodyClassName="slideover-body"
          onClose={onClose}
          head={(close) => (
            <>
              {head(close)}
              {actionBar}
            </>
          )}
        >
          {body}
        </Sheet>
        {moreOpen && (
          <Sheet label="Task actions" title={task.title} onClose={() => setMoreOpen(false)}>
            {/* what can be done now first; the refused ones follow with their reason */}
            <div className="sheet-actions">
              {[
                ...overflow.filter((a) => !a.destructive && !a.disabled),
                ...overflow.filter((a) => !a.destructive && a.disabled),
              ].map(sheetAct)}
            </div>
            {overflow.some((a) => a.destructive) && (
              <div className="sheet-actions danger-zone">{overflow.filter((a) => a.destructive).map(sheetAct)}</div>
            )}
          </Sheet>
        )}
      </>
    );

  return (
    <>
      <div className="overlay" ref={exitGhost} onClick={onClose} />
      <div className="slideover" ref={exitGhost}>
        {head(onClose)}
        <div className="slideover-body">{body}</div>
      </div>
    </>
  );
}
