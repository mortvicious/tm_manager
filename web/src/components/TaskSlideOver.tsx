import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import {
  EFFORT_LEVELS,
  GROUP_COLOR_COUNT,
  MODEL_OPTIONS,
  REVIEW_BUSY_STATES,
  CHECK_BUSY_STATES,
  REVIEW_NOW_FROM,
  groupAncestors,
  groupColorSlot,
  groupLabel,
  imagePreviewType,
  isExternalTask,
  publishCaution,
  publishGateReason,
  type EffortLevel,
  type LandingTier,
  type Proposal,
  type Task,
} from '@tm/shared';
import { api } from '../api.ts';
import { topmostDialog, useDialogFocus } from '../dialogFocus.ts';
import { confirmMarkPublished, confirmPublish, markPublishedLabel, markPublishedOffered, publishIsPrimary } from '../publish.ts';
import { useApp } from '../state.tsx';
import { DispatchStrip } from './DispatchStrip.tsx';
import { TaskDiff } from './TaskDiff.tsx';
import { TaskHistory } from './TaskHistory.tsx';
import { GroupPicker, type GroupChoicePlace } from './GroupPicker.tsx';
import { IconAnalyze, IconChevron, IconMore, IconPlay, IconPublish, IconQueue, IconStop, IconTerminal, IconX } from './Icons.tsx';
import { ImageLightbox, type LightboxImage } from './ImageLightbox.tsx';
import { useIsMobile } from './Layout.tsx';
import { Markdown } from './Markdown.tsx';
import { PresetPicker, reviewChoiceOf, reviewValueOf, type ReviewChoice } from './PresetPicker.tsx';
import { ReviewerFields, reviewIsOn } from './ReviewerPicker.tsx';
import { TaskStatsLine } from './RunMeta.tsx';
import { BadgeStrip, StatusBadge } from './StatusBadge.tsx';
import { KindBadge, liveReviewRun, runTaskId } from './RunKind.tsx';
import { ReviewPanel } from './ReviewPanel.tsx';
import { ChecksPanel } from './ChecksPanel.tsx';
import { LoopPanel } from './LoopPanel.tsx';
import { DoneFields } from './DoneFields.tsx';
import { LandingPicker } from './LandingPicker.tsx';
import { QuestionForm } from './QuestionModal.tsx';
import { Sheet, SheetAction } from './Sheet.tsx';
import { toastError } from '../toast.ts';
import { ACTION_TITLE, publishBusy, runTaskAction, usePendingAction, type TaskActionId } from '../pending.ts';
import { useArm } from '../arm.ts';
import { exitGhost } from '../motion.ts';
import { BackgroundShellList } from './BackgroundShells.tsx';
import {
  PANEL_TAB_LABEL,
  offeredTabs,
  panelBucket,
  pickTab,
  readTabMemory,
  rememberTab,
  tabByKey,
  type PanelBucket,
  type PanelTab,
} from '../panelTabs.ts';

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
  /**
   * Two-press arm (src/arm.ts): the first press only swaps the label for this
   * question, a second press within 4 s runs `onClick`. For what kills a run.
   */
  confirm?: string;
  onClick: () => void;
  /** the task action it runs — while one is in flight (src/pending.ts) the
   *  pressed button says so ("Publishing…") and the others wait */
  act?: TaskActionId;
}

/**
 * Which actions a phone pins in the bar, best first; at most three. With a live
 * session the terminal outranks starting anything new, which the server would
 * refuse anyway (the `hasLiveSession()` guard).
 */
const mobilePrimary = (live: boolean, publishHeld: boolean) =>
  // A review whose verdict is open, flagged or red (docs/publish.md § The verify
  // gate) leads with its terminal — Publish moves to ⋯, and Mark done never
  // takes the primary slot over a verdict nobody accepted.
  publishHeld
    ? ['terminal', 'complete', 'release', 'unblock', 'run-now', 'enqueue']
    : live
      ? ['stop-waiting', 'publish', 'complete', 'release', 'unblock', 'terminal', 'run-now', 'enqueue']
      : ['publish', 'complete', 'release', 'unblock', 'run-now', 'enqueue', 'terminal'];
const MOBILE_BAR_MAX = 3;
/** Same words as the board row (TaskRow), for the same server refusal. */
const LIVE_MSG = 'Previous session is still live — open its terminal or kill it first';

/** How a task's current parent reads in the group picker. */
function placeOfParent(t: Task): GroupChoicePlace {
  if (!t.parentId) return 'ungroup';
  return t.parentId === t.groupId ? 'group' : 'child';
}

/** The panel's editable fields, as the form holds them. */
interface EditFields {
  title: string;
  description: string;
  acceptance: string;
  checks: string[] | null;
  repoId: string;
  parentId: string;
  parentPlace: GroupChoicePlace;
  model: string;
  effort: string;
  category: string;
  groupName: string;
  groupColor: string;
  review: ReviewChoice;
  reviewModel: string;
  reviewEffort: string;
  landing: LandingTier | null;
}

/** What the form shows for a task with nothing edited. */
function fieldsOf(t: Task): EditFields {
  return {
    title: t.title,
    description: t.description ?? '',
    acceptance: t.acceptance ?? '',
    checks: t.checks,
    repoId: t.repoId ?? '',
    parentId: t.parentId ?? '',
    parentPlace: placeOfParent(t),
    model: t.model ?? '',
    effort: t.effort ?? '',
    category: t.category ?? '',
    groupName: t.groupName ?? '',
    groupColor: t.groupColor == null ? '' : String(t.groupColor),
    review: reviewChoiceOf(t.review),
    reviewModel: t.reviewModel ?? '',
    reviewEffort: t.reviewEffort ?? '',
    landing: t.landing,
  };
}

/**
 * Unsaved edits and follow-up text per task, kept when the panel closes
 * (docs/mobile.md § Drafts survive a close): a stray click beside the panel, a
 * swipe down the sheet, or a trip to the terminal must never cost typed text.
 * Only the fields that DIFFER from the task at close are kept, so reopening
 * never reverts a change made elsewhere meanwhile. Memory only — a reload is a
 * deliberate act; Save, Send and Discard clear the entry.
 */
const panelDrafts = new Map<string, { fields: Partial<EditFields>; followUp: string }>();

function stashDraft(id: string, fields: EditFields, base: EditFields, followUp: string) {
  const changed: Partial<EditFields> = {};
  for (const k of Object.keys(fields) as (keyof EditFields)[]) {
    if (JSON.stringify(fields[k]) !== JSON.stringify(base[k])) (changed as Record<string, unknown>)[k] = fields[k];
  }
  if (Object.keys(changed).length || followUp.trim()) panelDrafts.set(id, { fields: changed, followUp });
  else panelDrafts.delete(id);
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
            <span className="sep" aria-hidden="true">›</span>
          </span>
        );
      })}
      <span className="self">{task.title}</span>
    </div>
  );
}

/**
 * A phone's tab strip scrolls sideways: keep the active tab in it (History, the
 * last one, is where failed/cancelled open). Only the strip moves —
 * scrollIntoView would scroll the panel's own scroller (or the sheet) too.
 */
function revealTab(btn: HTMLElement | null | undefined): void {
  const strip = btn?.parentElement;
  if (!btn || !strip || strip.scrollWidth <= strip.clientWidth) return;
  const left = btn.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft;
  if (left < strip.scrollLeft) strip.scrollLeft = left;
  else if (left + btn.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = left + btn.offsetWidth - strip.clientWidth;
}

export function TaskSlideOver({
  taskId,
  onClose,
  onOpenTask,
  onOpenTerminal,
  urlTab,
  onUrlTab,
}: {
  taskId: string;
  onClose: () => void;
  /** swap the panel to another task (the group breadcrumb) */
  onOpenTask: (id: string) => void;
  onOpenTerminal: (runId: string) => void;
  /** `?tab=` as the URL has it (App.tsx usePanelTab) — unvalidated */
  urlTab: string | null;
  /** replace `?tab=` (null drops it); never a new history entry */
  onUrlTab: (tab: PanelTab | null) => void;
}) {
  const { tasks, repos, runs, proposals, dispatches, refresh, questions, settings, orch } = useApp();
  const task = tasks.find((t) => t.id === taskId);
  // an action pressed on ANY surface is in flight (src/pending.ts)
  const pend = usePendingAction(taskId);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [checks, setChecks] = useState<string[] | null>(null);
  const [repoId, setRepoId] = useState<string>('');
  const [parentId, setParentId] = useState<string>('');
  const [parentPlace, setParentPlace] = useState<GroupChoicePlace>('ungroup');
  const [model, setModel] = useState<string>('');
  const [effort, setEffort] = useState<string>('');
  const [category, setCategory] = useState<string>('');
  const [groupName, setGroupName] = useState<string>('');
  const [groupColor, setGroupColor] = useState<string>('');
  // the head's short id copies the full one ("copied" for a moment) — the
  // value the Board's find-by-id field and Telegram's /task take
  const [idCopied, setIdCopied] = useState(false);
  useEffect(() => {
    if (!idCopied) return;
    const t = setTimeout(() => setIdCopied(false), 1500);
    return () => clearTimeout(t);
  }, [idCopied]);
  const [review, setReview] = useState<ReviewChoice>('default');
  const [reviewModel, setReviewModel] = useState<string>('');
  const [reviewEffort, setReviewEffort] = useState<string>('');
  const [landing, setLanding] = useState<LandingTier | null>(null);
  const [followUpMsg, setFollowUpMsg] = useState('');
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  const [resumeSession, setResumeSession] = useState<string | null>(null);
  const [files, setFiles] = useState<{ name: string; size: number; mtime: string }[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  // index into `images` shown in the lightbox, -1 = closed
  const [preview, setPreview] = useState(-1);
  const mobile = useIsMobile();
  const [moreOpen, setMoreOpen] = useState(false);
  // one armed button at a time across the panel: run-killing actions and file ✕
  const arm = useArm();
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

  const setFields = (f: EditFields) => {
    setTitle(f.title);
    setDescription(f.description);
    setAcceptance(f.acceptance);
    setChecks(f.checks);
    setRepoId(f.repoId);
    setParentId(f.parentId);
    setParentPlace(f.parentPlace);
    setModel(f.model);
    setEffort(f.effort);
    setCategory(f.category);
    setGroupName(f.groupName);
    setGroupColor(f.groupColor);
    setReview(f.review);
    setReviewModel(f.reviewModel);
    setReviewEffort(f.reviewEffort);
    setLanding(f.landing);
  };
  // the task the form's state was last loaded for — until the load effect has
  // run, the state still holds the previous task's (or the initial empty) values
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  // the last committed form, read by the load effect's cleanup to stash a draft
  const latest = useRef<{ id: string; fields: EditFields; base: EditFields; followUp: string } | null>(null);
  // set by Delete: a deleted task's draft is not kept
  const dropDraft = useRef(false);

  // Keyed on id, not the task object: task.updated events must not wipe edits.
  // A draft kept from an earlier close is laid over the task's values; the
  // cleanup (close, or the breadcrumb swapping tasks) keeps this one's.
  useEffect(() => {
    if (!task) return;
    const id = task.id;
    const kept = panelDrafts.get(id);
    setFields({ ...fieldsOf(task), ...kept?.fields });
    setFollowUpMsg(kept?.followUp ?? '');
    setLoadedFor(id);
    setSettingsOpen(task.status === 'draft');
    setMoreOpen(false);
    dropDraft.current = false;
    return () => {
      const l = latest.current;
      if (dropDraft.current) panelDrafts.delete(id);
      else if (l && l.id === id) stashDraft(id, l.fields, l.base, l.followUp);
    };
  }, [task?.id]);
  const fields: EditFields = {
    title,
    description,
    acceptance,
    checks,
    repoId,
    parentId,
    parentPlace,
    model,
    effort,
    category,
    groupName,
    groupColor,
    review,
    reviewModel,
    reviewEffort,
    landing,
  };
  // Declared after the load effect, so on a task swap its cleanup still reads
  // the OLD task's form; it only records a form that belongs to `task`.
  useEffect(() => {
    latest.current =
      task && loadedFor === task.id ? { id: task.id, fields, base: fieldsOf(task), followUp: followUpMsg } : null;
  });

  // Deliverable files — refresh when the panel opens and when the task's
  // status changes (a finished run may have just written files).
  useEffect(() => {
    if (!task) return;
    api.taskFiles(task.id).then(setFiles).catch(() => setFiles([]));
  }, [task?.id, task?.status]);
  useEffect(() => setPreview(-1), [task?.id]);

  // The files the lightbox can show, in list order. `v` is the mtime, so a
  // file replaced under the same name is a new URL past the browser cache.
  const images = useMemo<(LightboxImage & { file: string })[]>(() => {
    if (!task) return [];
    return files
      .filter((f) => imagePreviewType(f.name))
      .map((f) => {
        const url = `/api/tasks/${task.id}/files/${encodeURIComponent(f.name)}`;
        return { file: f.name, name: f.name, src: `${url}?inline=1&v=${encodeURIComponent(f.mtime)}`, download: url };
      });
  }, [task?.id, files]);

  // Can "Resume" (POST /proceed) reopen an earlier agent session? Only the
  // server knows — it also checks the transcript is still on disk. Re-checked when a run
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

  // The tab (panelTabs.ts, docs/mobile.md § Task panel tabs): the human's click
  // in THIS open of the panel, else `?tab=`, else the state bucket's
  // remembered pick, else its default. A breadcrumb swap is a new open: the
  // click is keyed on the task, and useOpenTask drops `tab` from the URL.
  const offered = useMemo(offeredTabs, []);
  const bucket: PanelBucket = task ? panelBucket(task, !!pendingQuestion) : 'idle';
  const [clicked, setClicked] = useState<{ id: string; tab: PanelTab } | null>(null);
  const clickedTab = clicked?.id === taskId ? clicked.tab : null;
  const tabMemory = useMemo(readTabMemory, [bucket, clickedTab]);
  const tab = pickTab({ clicked: clickedTab, url: urlTab, remembered: tabMemory[bucket], bucket, offered });
  // The bucket moved under an open panel (running → review): with no click
  // since it opened, the tab follows the new bucket — so a `?tab=` that came
  // with the URL (a link, a reload) steps aside, or it would pin the old tab.
  const seenBucket = useRef<{ id: string; bucket: PanelBucket } | null>(null);
  useEffect(() => {
    if (!task) return;
    const prev = seenBucket.current;
    seenBucket.current = { id: task.id, bucket };
    if (prev?.id === task.id && prev.bucket !== bucket && !clickedTab && urlTab !== null) onUrlTab(null);
  });
  const tabRefs = useRef<Partial<Record<PanelTab, HTMLButtonElement | null>>>({});
  useEffect(() => revealTab(tabRefs.current[tab]), [tab]);
  const chooseTab = (t: PanelTab) => {
    setClicked({ id: taskId, tab: t });
    rememberTab(bucket, t);
    onUrlTab(t);
  };
  // roving focus (WAI-ARIA tabs, automatic activation): arrows/Home/End select and focus
  const onTabKey = (e: ReactKeyboardEvent) => {
    const next = tabByKey(e.key, tab, offered);
    if (!next) return;
    e.preventDefault();
    chooseTab(next);
    tabRefs.current[next]?.focus();
  };

  // Desktop: a real modal dialog (UX review #5, docs/design.md § Desktop
  // dialogs) — focus moves in, Tab stays in, Escape closes, and focus returns
  // to the row it was opened from. A phone's Sheet does all of this itself.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelNode = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    const ghost = exitGhost(node);
    return () => {
      panelRef.current = null;
      ghost?.();
    };
  }, []);
  const dialog = !mobile && !!task;
  useDialogFocus(panelRef, dialog, taskId, () =>
    document.querySelector<HTMLElement>(`.task-row[data-task-row="${CSS.escape(taskId)}"]`),
  );
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!dialog) return;
    // Bubble phase on window, like <Sheet>: the lightbox marks the key
    // (preventDefault), the question modal and the search popover stop it,
    // and topmostDialog covers whatever is above without doing either.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      const node = panelRef.current;
      if (!node || !topmostDialog(node)) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      // a terminal's Escape is the agent's interrupt key
      if (t?.closest('.xterm')) return;
      // the first Escape leaves a field, the second closes (an edit is never
      // one stray key from gone — though drafts survive a close anyway)
      if (t && node.contains(t) && isTextField(t)) {
        t.blur();
        node.focus({ preventScroll: true });
        return;
      }
      closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog]);

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
    acceptance !== (task.acceptance ?? '') ||
    JSON.stringify(checks) !== JSON.stringify(task.checks) ||
    repoId !== (task.repoId ?? '') ||
    regroup ||
    model !== (task.model ?? '') ||
    effort !== (task.effort ?? '') ||
    category !== (task.category ?? '') ||
    review !== reviewChoiceOf(task.review) ||
    reviewModel !== (task.reviewModel ?? '') ||
    reviewEffort !== (task.reviewEffort ?? '') ||
    landing !== task.landing ||
    (rootAfter &&
      (groupName !== (task.groupName ?? '') || groupColor !== (task.groupColor == null ? '' : String(task.groupColor))));

  const save = async () => {
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
        acceptance: acceptance.trim() || null,
        checks,
        repoId: repoId || null,
        model: model || null,
        effort: (effort || null) as EffortLevel | null,
        category: category.trim() || null,
        review: reviewValueOf(review),
        // kept while hidden: switching review off must not forget the pick
        reviewModel: reviewModel || null,
        reviewEffort: (reviewEffort || null) as EffortLevel | null,
        // only when changed: an external task carrying a pre-tier value must
        // stay editable (the server refuses raising it, never leaving it)
        ...(landing !== task.landing ? { landing } : {}),
        ...(rootAfter
          ? { groupName: groupName.trim() || null, groupColor: groupColor === '' ? null : Number(groupColor) }
          : {}),
      });
      await refresh();
      panelDrafts.delete(task.id);
    } catch (e) {
      toastError(e, 'Save');
    }
  };

  // back to the task as it is, and nothing kept for the next open
  const discard = () => {
    setFields(fieldsOf(task));
    panelDrafts.delete(task.id);
  };

  // Every task action: in flight on every surface until the server answers,
  // then a confirmation toast, or the refusal (docs/mobile.md § Action feedback)
  const track = async (a: TaskActionId, call: () => Promise<unknown>, then = true) => {
    try {
      const r = await runTaskAction(task, a, call);
      if (r !== undefined && then) await refresh();
    } catch (e) {
      toastError(e, ACTION_TITLE[a]);
    }
  };
  const action = (a: Parameters<typeof api.taskAction>[1]) => track(a, () => api.taskAction(task.id, a));

  const analyze = async () => {
    if (!task.repoId) {
      toastError('Assign a repo before analyzing');
      return;
    }
    try {
      await api.analyze({ repoId: task.repoId, taskIds: [task.id] });
    } catch (e) {
      toastError(e);
    }
  };

  const loadFiles = () => task && api.taskFiles(task.id).then(setFiles).catch(() => {});
  const doUpload = async (fileList: FileList | File[]) => {
    if (!task) return;
    const arr = Array.from(fileList);
    if (arr.length === 0) return;
    setUploading(true);
    try {
      await api.uploadTaskFiles(task.id, arr);
      loadFiles();
    } catch (e) {
      toastError(e, 'Upload');
    } finally {
      setUploading(false);
    }
  };
  const delFile = async (name: string) => {
    if (!task) return;
    // an agent's deliverable is gone for good: the ✕ arms, a second press deletes
    if (!arm.press(`${task.id}:file:${name}`)) return;
    try {
      await api.deleteTaskFile(task.id, name);
      loadFiles();
    } catch (e) {
      toastError(e);
    }
  };

  // Both follow-up buttons: same busy/error/clear handling, different call.
  const send = async (call: () => Promise<unknown>) => {
    setSendingFollowUp(true);
    try {
      await call();
      setFollowUpMsg('');
      await refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setSendingFollowUp(false);
    }
  };

  const del = async () => {
    if (!confirm('Delete this task?')) return;
    try {
      await api.deleteTask(task.id);
      dropDraft.current = true;
      onClose();
    } catch (e) {
      toastError(e);
    }
  };

  // the repo checks run inside the same round lock (docs/checks.md), so "Review now" waits for them too
  const reviewBusy =
    (task.reviewState !== null && REVIEW_BUSY_STATES.includes(task.reviewState)) ||
    (task.status === 'review' && task.checkState !== null && CHECK_BUSY_STATES.includes(task.checkState));
  const publishGate = publishGateReason(task);
  const actions: PanelAction[] = [];
  const again = mobile ? 'tap again' : 'click again';
  const running = task.status === 'running' || task.status === 'waiting';
  // the client mirror of the server's hasLiveSession() guard (see TaskRow):
  // enqueue, add-to-queue, release and run-now are refused while the PTY is up
  const liveSession = taskRuns.some((r) => r.status === 'running');
  // A failed/cancelled task speaks one vocabulary (docs/inbox.md § Retry or
  // Resume): Retry / Retry now start a FRESH agent, Resume (the follow-up box)
  // reopens the same session. The server move is the same as Enqueue/Run now.
  const retryable = task.status === 'failed' || task.status === 'cancelled';
  if (['draft', 'review', 'blocked', 'failed', 'cancelled'].includes(task.status)) {
    actions.push({
      id: 'enqueue',
      label: retryable ? 'Retry' : 'Enqueue',
      disabled: liveSession,
      title: liveSession
        ? LIVE_MSG
        : retryable
          ? 'A fresh agent through the queue, told what the last attempt hit'
          : 'Mark it ready — the orchestrator claims it when a slot frees up',
      onClick: () => action(retryable ? 'retry' : 'enqueue'),
    });
  }
  // custom queue (docs/queue.md): runs even with the global queue stopped, one task per repo
  if (['draft', 'review', 'failed', 'cancelled'].includes(task.status) || (task.status === 'queued' && !task.customQueueAt)) {
    actions.push({
      id: 'queue',
      label: 'Add to queue',
      icon: <IconQueue />,
      cls: 'queue-btn',
      disabled: liveSession,
      title: liveSession ? LIVE_MSG : 'Add to the queue — runs one task per repo, independent of the global queue',
      onClick: () => action('queue'),
    });
  }
  if (task.status === 'queued' && task.customQueueAt) {
    // a WAITING member leaves the custom queue cancelled (docs/queue.md), so it is named for that
    actions.push({
      id: 'unqueue',
      label: 'Cancel task',
      cls: 'danger',
      destructive: true,
      title: 'Take it out of the one-at-a-time queue and cancel it (asks for a second press)',
      confirm: `Cancel task? ${again}`,
      onClick: () => action('unqueue'),
    });
  }
  if (['draft', 'queued', 'review', 'failed', 'cancelled'].includes(task.status)) {
    actions.push({
      id: 'run-now',
      label: retryable ? 'Retry now' : 'Run now',
      icon: <IconPlay />,
      cls: 'primary',
      disabled: liveSession,
      title: liveSession
        ? LIVE_MSG
        : retryable
          ? 'A fresh agent at once, ahead of the queue, told what the last attempt hit'
          : 'Spawn an agent at once, ahead of the queue',
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
  // Stop waiting (docs/design.md § Waiting): offered only while background
  // shells alone hold the park — a subagent's park ends on its own.
  if (task.status === 'waiting' && orch.shellWaits?.includes(task.id)) {
    actions.push({
      id: 'stop-waiting',
      label: 'Stop waiting',
      icon: <IconStop />,
      cls: 'primary',
      title:
        'Only background shells keep this task waiting. Land the turn now — review and queue go on as if the shells had exited — and kill those shells. Asks for a second press.',
      confirm: `Stop waiting? ${again}`,
      onClick: () => action('stop-waiting'),
    });
  }
  if (running) {
    actions.push({
      id: 'undo',
      label: 'Undo start',
      title:
        'Stop this run and put the task back where it was before it started (a queued task keeps its place, held until you Release it). Nothing in the working tree is reverted. Asks for a second press.',
      confirm: `Undo start? ${again}`,
      onClick: () => action('undo'),
    });
    actions.push({
      id: 'cancel',
      label: 'Cancel',
      cls: 'danger',
      destructive: true,
      title: 'Kill the run and cancel the task (asks for a second press)',
      confirm: `Cancel? ${again}`,
      onClick: () => action('cancel'),
    });
  }
  // out of the GLOBAL queue the server move is a plain cancel, and it says so
  if (task.status === 'queued' && !task.customQueueAt) {
    actions.push({
      id: 'dequeue',
      label: 'Cancel task',
      cls: 'danger',
      destructive: true,
      title: 'Cancel the task — it leaves the global queue (asks for a second press)',
      confirm: `Cancel task? ${again}`,
      onClick: () => action('cancel'),
    });
  }
  // Observed publish (docs/publish.md § Observed publish): the agent already
  // pushed it, so the publish slot records that — no turn, nothing pushed.
  if (markPublishedOffered(task)) {
    const caution = publishCaution(task);
    actions.push({
      id: 'mark-published',
      label: caution && task.status === 'review' ? 'Mark published anyway' : 'Mark published',
      short: 'Published',
      icon: <IconPublish />,
      cls: task.status === 'review' && publishIsPrimary(task) ? 'primary' : undefined,
      title: `${caution && task.status === 'review' ? `${caution} — asks first. ` : ''}${markPublishedLabel(task)}`,
      onClick: () => {
        if (task.status !== 'review' || confirmMarkPublished(task)) void action('mark-published');
      },
    });
  }
  if (task.status === 'review' && !markPublishedOffered(task)) {
    const caution = publishCaution(task);
    actions.push({
      id: 'publish',
      label: caution ? 'Publish anyway' : 'Publish',
      short: 'Publish',
      icon: <IconPublish />,
      cls: publishIsPrimary(task) ? 'primary' : undefined,
      disabled: !!publishGate,
      title: publishGate
        ? `Publish waits: ${publishGate}`
        : `${caution ? `${caution} — asks first. ` : ''}${
            resumeSession
              ? `Commit and push this work in session ${resumeSession.slice(0, 8)} — the same terminal the agent worked in`
              : 'Commit and push this work (no agent session left to reopen, so the server does it directly)'
          }`,
      onClick: () => {
        if (confirmPublish(task)) void action('publish');
      },
    });
  }
  if (task.status === 'review') {
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
      // No refresh(): the round can settle (empty/unchanged diff) within
      // ms, and a full list read in flight across that write lands after
      // the WS row and pins a stale `pending`. The `task.updated`
      // broadcasts carry both steps in order.
      onClick: () => void track('review', () => api.reviewNow(task.id), false),
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
      onClick: () => void track('apply-review', () => api.applyReview(task.id)),
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
      title: "Close the agent's terminal session (task status is unchanged; asks for a second press)",
      confirm: `Stop agent? ${again}`,
      onClick: () => void track('stop-agent', () => api.stopAgent(task.id)),
    });
  }
  // Hidden tasks (docs/design.md § Hidden tasks): a working task stays visible.
  if (task.hiddenAt) {
    actions.push({ id: 'unhide', label: 'Unhide', title: 'Back to its usual section on the board', onClick: () => action('unhide') });
  } else if (task.status !== 'running' && task.status !== 'waiting') {
    actions.push({ id: 'hide', label: 'Hide', title: 'Move into the dimmed Hidden section — out of Drafts and the rest of the board until you unhide it or its status changes', onClick: () => action('hide') });
  }
  actions.push({ id: 'analyze', label: 'Analyze', icon: <IconAnalyze />, title: 'A read-only session reads the repo and proposes how to split or solve this task', onClick: analyze });
  actions.push({ id: 'delete', label: 'Delete', cls: 'danger', destructive: true, title: 'Delete the task (asks first)', onClick: del });

  // which task action each button runs, for the in-flight state
  const ACT_OF: Record<string, TaskActionId> = {
    enqueue: retryable ? 'retry' : 'enqueue',
    queue: 'queue',
    unqueue: 'unqueue',
    'run-now': 'run-now',
    release: 'release',
    'stop-waiting': 'stop-waiting',
    undo: 'undo',
    cancel: 'cancel',
    dequeue: 'cancel',
    'mark-published': 'mark-published',
    publish: 'publish',
    complete: 'complete',
    'review-now': 'review',
    'apply-review': 'apply-review',
    unblock: 'unblock',
    'stop-agent': 'stop-agent',
    hide: 'hide',
    unhide: 'unhide',
  };
  for (const a of actions) a.act = ACT_OF[a.id];
  /** the pressed one reads "Publishing…"; every other task action waits for it */
  const inFlight = (a: PanelAction) => !!pend && !!a.act && pend.action === a.act;
  const held = (a: PanelAction) => !!a.disabled || (!!pend && !!a.act);

  const armKey = (a: PanelAction) => `${task.id}:${a.id}`;
  const isArmed = (a: PanelAction) => !!a.confirm && arm.armed === armKey(a);
  const labelOf = (a: PanelAction) => (inFlight(a) ? pend!.verb : isArmed(a) ? a.confirm! : a.label);
  /** true when this press runs the action; a `confirm` action's first press only arms it */
  const fires = (a: PanelAction) => !a.confirm || arm.press(armKey(a));

  // Phones: the bar takes the best few non-destructive actions, the sheet the rest.
  // disabled actions stay in the sheet, where their reason is printed
  const publishHeld = task.status === 'review' && !publishIsPrimary(task);
  const barIds = mobilePrimary(liveSession, publishHeld)
    .filter((id) => actions.some((a) => a.id === id && !a.destructive && !a.disabled))
    .slice(0, MOBILE_BAR_MAX);
  const bar = barIds.map((id) => actions.find((a) => a.id === id)!);
  const overflow = actions.filter((a) => !barIds.includes(a.id));
  const sheetAct = (a: PanelAction) => (
    <SheetAction
      key={a.id}
      icon={a.icon}
      label={labelOf(a)}
      hint={a.title}
      tone={a.destructive || isArmed(a) ? 'danger' : undefined}
      disabled={held(a)}
      onClick={() => {
        // the arming press keeps the sheet open, so the second lands on the same row
        if (!fires(a)) return;
        setMoreOpen(false);
        a.onClick();
      }}
    />
  );

  // The head is the drag handle on a phone; its close button animates the
  // sheet out first. Two lines on both (docs/design.md § Task panel head):
  // where it stands + what it is, then ONE quiet line of where it comes from —
  // facts as text with separators, colour only where it carries meaning.
  const repoName = task.repoId ? repos.find((r) => r.id === task.repoId)?.name ?? null : null;
  const landedFlag = !!task.autoLandedAt && (task.status === 'done' || task.status === 'published');
  const pushedFlag = !!task.shippedSha && (task.status === 'review' || task.status === 'done');
  const busy = publishBusy(task, taskRuns, orch, pend);
  const head = (close: () => void) => (
    <div className="slideover-head">
      <div className="so-line">
        <StatusBadge
          status={task.status}
          attention={latestRun?.needsAttention && task.status === 'running'}
          question={!!pendingQuestion}
          reviewState={task.reviewState}
          checkState={task.checkState}
          loopState={task.loopState}
          paused={!!task.pausedTurn}
          busy={busy}
          onOpenReviewer={reviewerRun ? () => onOpenTerminal(reviewerRun.id) : undefined}
        />
        {/* the title stays in view on every tab and while the body scrolls under it */}
        <span className="so-title" title={task.title}>
          {task.title}
        </span>
        <button className="btn ghost so-close" aria-label="Close" onClick={close}>
          <IconX />
        </button>
      </div>
      <div className="so-meta">
        <button
          type="button"
          className="so-id mono"
          title={`${task.id} — click to copy`}
          onClick={() =>
            navigator.clipboard
              ?.writeText(task.id)
              .then(() => setIdCopied(true))
              .catch(() => {})
          }
        >
          {idCopied ? 'copied' : task.id.slice(0, 8)}
        </button>
        {repoName && (
          <span className="so-meta-item" title="repo">
            {repoName}
          </span>
        )}
        {task.category && (
          <span className="so-meta-item so-cat" title="category">
            {task.category}
          </span>
        )}
        {groupTasks.length > 1 && (
          <span
            className="so-meta-item so-group"
            style={groupTint}
            title={`task group “${groupLabel(groupRoot, task.title)}” · ${groupTasks.length} tasks${isRoot ? ' · this is the group root' : ''}`}
          >
            <span className="so-gdot" aria-hidden="true" />
            <span className="so-glabel">{isRoot ? 'group root' : groupLabel(groupRoot, task.title)}</span>
            <span className="so-gcount mono">{groupTasks.length}</span>
          </span>
        )}
        {task.branch && (
          // parallel same-repo tasks (docs/parallel.md): branch + the PR the server keeps as the record
          <span
            className={`so-meta-item so-branch mono${task.prState === 'merged' ? ' merged' : ''}`}
            title={`own worktree ${task.workdir ?? ''} on ${task.branch}${task.worktreeEvictedAt && task.status !== 'published' ? ' — folder evicted while idle, re-created on the next turn' : ''}`}
          >
            {task.branch}
            {task.prUrl && (
              <>
                <span className="so-sep" aria-hidden="true">
                  ·
                </span>
                <a href={task.prUrl} target="_blank" rel="noreferrer">
                  PR #{task.prNumber}
                </a>
                {task.prState && task.prState !== 'open' ? ` ${task.prState}` : ''}
              </>
            )}
          </span>
        )}
        {task.createdByRun && (
          <span className="so-meta-item" title={`filed by agent run ${task.createdByRun.slice(0, 8)} (depth ${task.spawnDepth})`}>
            agent d{task.spawnDepth}
          </span>
        )}
        {/* "manual" is every task you type yourself — only another source is news */}
        {task.source !== 'manual' && (
          <span className="so-meta-item" title="where this task came from">
            {task.source}
          </span>
        )}
        {landedFlag && (
          <span
            className="so-flag"
            style={{ '--so-flag': 'var(--tm-status-done)' } as CSSProperties}
            title={`landed by the orchestrator ${new Date(task.autoLandedAt!).toLocaleString()}: checks green, review clean`}
          >
            auto-landed
          </span>
        )}
        {pushedFlag && (
          <span
            className="so-flag"
            style={{ '--so-flag': 'var(--tm-status-published)' } as CSSProperties}
            title={`the agent already pushed ${task.shippedSha!.slice(0, 8)}${task.shippedAt ? ` (seen ${new Date(task.shippedAt).toLocaleString()})` : ''} — Mark published records it`}
          >
            pushed
          </span>
        )}
      </div>
    </div>
  );

  const actionBar = (
    <div className="so-bar">
      {bar.map((a, i) => (
        <button
          key={a.id}
          className={`btn${i === 0 && !(publishHeld && a.id === 'complete') ? ' primary' : ''}${inFlight(a) ? ' in-flight' : ''}`}
          disabled={held(a)}
          aria-busy={inFlight(a) || undefined}
          onClick={() => fires(a) && a.onClick()}
        >
          {a.icon}
          {a.icon ? ' ' : ''}
          {inFlight(a) ? pend!.verb : isArmed(a) ? a.confirm : (a.short ?? a.label)}
        </button>
      ))}
      <button className="btn so-more" aria-expanded={moreOpen} aria-label="More actions" onClick={() => setMoreOpen(true)}>
        <IconMore />
        {bar.length === 0 && ' Actions'}
      </button>
    </div>
  );

  // Above the tabs, on every tab (docs/mobile.md § Task panel tabs): where the
  // task stands, what went wrong, and the question waiting on you — in reading
  // order, which is also the phone's.
  const above = (
    <>
      {/* a phone cannot hover the badge: what is happening, what you can do
          (docs/mobile.md § Tap to explain) */}
      {mobile && (
        <BadgeStrip
          status={task.status}
          attention={latestRun?.needsAttention && task.status === 'running'}
          question={!!pendingQuestion}
          reviewState={task.reviewState}
          checkState={task.checkState}
          loopState={task.loopState}
          paused={!!task.pausedTurn}
          busy={busy}
        />
      )}
      <GroupPath task={task} tasks={tasks} onOpen={onOpenTask} />
      {/* the numbers: read, never acted on — one quiet line, not chips beside the actions */}
      <TaskStatsLine costUsd={task.costUsd} attempts={task.attempts} run={latestRun ?? null} />
      {task.error && (
        <div className="warn-text so-alert" style={{ whiteSpace: 'pre-wrap' }}>
          {task.error}
        </div>
      )}
      {retryable && (
        <div className="hint so-alert">
          {resumeSession
            ? 'Retry starts a fresh agent that is told what this attempt hit; Resume (under Follow-up, on the Terminal tab) reopens this agent\'s own session — pick it when the terminal died mid-task, e.g. on the usage limit.'
            : 'Retry starts a fresh agent that is told what this attempt hit — there is no earlier session to resume.'}
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
      {pendingQuestion && (
        <div className="qpanel so-question">
          <label className="label">The agent is asking you</label>
          <QuestionForm question={pendingQuestion} />
        </div>
      )}
    </>
  );

  // Desktop: the whole action list as one wrapping row, pinned under the head
  // — actions only; the numbers moved to the stats line. A phone's bar + ⋯
  // sheet ARE this row there.
  const deskActions = (
    <div className="so-actions">
      {actions.map((a) => (
        <button
          key={a.id}
          className={`btn${isArmed(a) ? ' danger armed' : a.cls ? ` ${a.cls}` : ''}${inFlight(a) ? ' in-flight' : ''}`}
          title={a.title}
          disabled={held(a)}
          aria-busy={inFlight(a) || undefined}
          aria-live={a.confirm ? 'polite' : undefined}
          onClick={() => fires(a) && a.onClick()}
        >
          {a.icon}
          {a.icon ? ' ' : ''}
          {labelOf(a)}
        </button>
      ))}
    </div>
  );

  const overview = (
    <>
      <div>
        <label className="label">Title</label>
        <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      {/* agent-filed tasks: the filer's before-work summary (the worker's summary is the after-work twin) */}
      {task.brief && (
        <div className="so-brief">
          <Markdown label="Agent's brief" text={task.brief} />
        </div>
      )}
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
          <DoneFields
            repoId={repoId || null}
            acceptance={acceptance}
            checks={checks}
            onAcceptance={setAcceptance}
            onChecks={setChecks}
          />
          <div>
            <label className="label">Repo</label>
            <select
              className="field"
              value={repoId}
              onChange={(e) => {
                setRepoId(e.target.value);
                // check names belong to a repo: another repo starts from "all"
                setChecks(e.target.value === (task.repoId ?? '') ? task.checks : null);
              }}
            >
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
          <LandingPicker
            value={landing}
            onChange={setLanding}
            repo={repos.find((r) => r.id === repoId)}
            external={isExternalTask(task)}
          />
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
          {files.map((f) => {
            // an image opens the lightbox; anything else stays a download
            const img = images.findIndex((im) => im.file === f.name);
            return (
              <div key={f.name} className="task-row" style={{ cursor: 'default' }}>
                {img >= 0 ? (
                  <>
                    <button className="file-thumb" title={`Preview ${f.name}`} aria-label={`Preview ${f.name}`} onClick={() => setPreview(img)}>
                      <img src={images[img].src} alt="" loading="lazy" decoding="async" />
                    </button>
                    <button className="title mono file-name" title={`Preview ${f.name}`} onClick={() => setPreview(img)}>
                      {f.name}
                    </button>
                  </>
                ) : (
                  <a
                    className="title mono"
                    style={{ textDecoration: 'none', color: 'inherit', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
                    href={`/api/tasks/${task.id}/files/${encodeURIComponent(f.name)}`}
                    download={f.name}
                  >
                    {f.name}
                  </a>
                )}
                <span className="mono muted">
                  {f.size < 1024 ? `${f.size} B` : f.size < 1048576 ? `${(f.size / 1024).toFixed(1)} KB` : `${(f.size / 1048576).toFixed(1)} MB`}
                </span>
                <button
                  className={`btn ghost${arm.armed === `${task.id}:file:${f.name}` ? ' danger' : ''}`}
                  title="Delete this file (asks for a second press)"
                  aria-label={`Delete ${f.name}`}
                  onClick={() => delFile(f.name)}
                  style={{ padding: '2px 8px' }}
                >
                  {arm.armed === `${task.id}:file:${f.name}` ? `Delete? ${again}` : '✕'}
                </button>
              </div>
            );
          })}
        </div>
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

  // `.so-empty` shows only while nothing else in the tab rendered (theme.css)
  const reviewTab = (
    <>
      <LoopPanel task={task} onError={toastError} />
      <ChecksPanel task={task} onOpenTerminal={onOpenTerminal} />
      <div className="so-review">
        <ReviewPanel task={task} />
      </div>
      {task.resultSummary && (
        <div className="so-summary">
          <Markdown label="Worker's summary" text={task.resultSummary} />
        </div>
      )}
      <div className="so-empty muted">No loop, checks, review or summary for this task yet.</div>
    </>
  );

  const terminalTab = (
    <>
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

      {/* the agent's background shells (docs/terminals.md § Background shells); renders nothing when none */}
      <BackgroundShellList taskId={task.id} />

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
                  : `No agent session to continue — run the task first, or use ${retryable ? 'Retry' : 'Run now'} for a fresh agent`
              }
              onClick={() => send(() => api.proceed(task.id, followUpMsg.trim() || undefined))}
            >
              <IconPlay /> Resume
            </button>
            {resumeSession && (
              <span className="mono muted" style={{ fontSize: 11 }}>
                resumes {resumeSession.slice(0, 8)}
              </span>
            )}
          </div>
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
      <div className="so-empty muted">Nothing has run for this task yet.</div>
    </>
  );

  const tabStrip = (
    <div className="so-tabs" role="tablist" aria-label="Task sections" onKeyDown={onTabKey}>
      {offered.map((t) => (
        <button
          key={t}
          ref={(node) => {
            // a phone sheet mounts its content after the effects ran: reveal on attach too
            if (node && t === tab && tabRefs.current[t] !== node) revealTab(node);
            tabRefs.current[t] = node;
          }}
          type="button"
          role="tab"
          id={`so-tab-${t}`}
          className="so-tab"
          aria-selected={t === tab}
          aria-controls={t === tab ? 'so-tabpanel' : undefined}
          tabIndex={t === tab ? 0 : -1}
          onClick={() => chooseTab(t)}
        >
          {PANEL_TAB_LABEL[t]}
        </button>
      ))}
    </div>
  );

  // only the active tab is mounted; edit state lives up here, so nothing is lost
  const tabPanel = (
    <div className="so-tabpanel" role="tabpanel" id="so-tabpanel" aria-labelledby={`so-tab-${tab}`}>
      {tab === 'review' ? (
        reviewTab
      ) : tab === 'terminal' ? (
        terminalTab
      ) : tab === 'diff' ? (
        <TaskDiff task={task} repo={repos.find((r) => r.id === task.repoId)} />
      ) : tab === 'history' ? (
        <TaskHistory task={task} onOpenTerminal={onOpenTerminal} onOpenTask={onOpenTask} />
      ) : (
        overview
      )}
    </div>
  );

  // outside the tab content: an edit made on Overview saves from any tab
  const saveBar = dirty && (
    <div className="so-save">
      <button className="btn ghost" onClick={discard} title="Back to the saved values">
        Discard
      </button>
      <button className="btn primary" onClick={save}>
        Save changes
      </button>
    </div>
  );

  // Beside the panel, never inside it: React bubbles the lightbox's portal
  // events up the component tree, so inside the sheet a swipe through the
  // photos would also drag the sheet.
  const lightbox = <ImageLightbox images={images} index={preview} onIndex={setPreview} onClose={() => setPreview(-1)} />;

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
          {above}
          {tabStrip}
          {tabPanel}
          {saveBar}
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
        {lightbox}
      </>
    );

  return (
    <>
      <div className="overlay" ref={exitGhost} onClick={onClose} />
      <div className="slideover" ref={panelNode} role="dialog" aria-modal="true" aria-label={task.title} tabIndex={-1}>
        {head(onClose)}
        {deskActions}
        <div className="slideover-body">
          {above}
          {tabStrip}
          {tabPanel}
        </div>
        {saveBar}
      </div>
      {lightbox}
    </>
  );
}

const TEXT_INPUTS = new Set(['text', 'search', 'url', 'email', 'number', 'password', 'tel', 'date', 'datetime-local', 'time']);
function isTextField(el: HTMLElement): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return TEXT_INPUTS.has(el.type);
  return el.isContentEditable;
}
