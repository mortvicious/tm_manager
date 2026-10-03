import { Fragment, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  EFFORT_LEVELS,
  MODEL_OPTIONS,
  groupColorSlot,
  groupLabel,
  matchTaskPreset,
  type EffortLevel,
  type Task,
  type TaskStatus,
} from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { DispatchStrip } from '../components/DispatchStrip.tsx';
import { GroupHead } from '../components/GroupHead.tsx';
import { GroupPicker } from '../components/GroupPicker.tsx';
import { IconChevron, IconFilter, IconPlus, IconX } from '../components/Icons.tsx';
import { useIsMobile } from '../components/Layout.tsx';
import {
  PresetChip,
  PresetPicker,
  reviewChoiceOf,
  reviewValueOf,
  useTaskPresets,
  type ReviewChoice,
} from '../components/PresetPicker.tsx';
import { ReviewerChip, ReviewerFields, globalReviewModel, reviewIsOn } from '../components/ReviewerPicker.tsx';
import { liveReviewRun } from '../components/RunKind.tsx';
import { FullSheet, Sheet } from '../components/Sheet.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { DragGhost, useTaskDrag, type DropZone } from '../components/TaskDrag.tsx';
import { TaskRow } from '../components/TaskRow.tsx';
import { TimeAgo, isNew, useNow } from '../components/TimeAgo.tsx';

const ORDER: TaskStatus[] = [
  'running',
  'waiting',
  'queued',
  'blocked',
  'review',
  'draft',
  'failed',
  'published',
  'done',
  'cancelled',
];

/** Finished work — folded away by default and hidden in essentials mode. */
const HISTORY: TaskStatus[] = ['published', 'done', 'cancelled'];

/** The "Active" strip: work that is either being done right now or waiting on the human. */
const ACTIVE: TaskStatus[] = ['running', 'waiting', 'review'];

/** Drafts pile up faster than anything else — show a few, rest behind a toggle. */
const DRAFT_LIMIT = 7;
/** "Recent" is a shortcut to whatever was touched last, whatever its status. */
const RECENT_LIMIT = 10;

/** Phones: how many tags a row keeps, and which win (docs/mobile.md § Rows). */
const MOBILE_CHIPS = 2;
const MOBILE_CHIP_ORDER = ['repo', 'dispatch', 'group', 'category', 'feature', 'autopub', 'agent', 'source', 'preset', 'reviewer'];

const byRecency = (key: 'createdAt' | 'updatedAt') => (a: Task, b: Task) => {
  const d = b[key].localeCompare(a[key]);
  // ISO timestamps collide on same-transaction writes; id keeps the order stable.
  return d !== 0 ? d : b.id.localeCompare(a.id);
};

/**
 * What happens to the task the moment it is created. 'draft' is the historical
 * behaviour (file it, decide later); the other two run the exact same action
 * endpoints the board rows already expose, one POST after the create.
 */
type StartMode = 'draft' | 'queue' | 'run';

const START_MODES: { id: StartMode; label: string; hint: string; title: string }[] = [
  { id: 'draft', label: 'Draft', hint: 'file only', title: 'Create it and leave it in drafts' },
  {
    id: 'queue',
    label: 'Queue',
    hint: 'next free slot',
    title: 'Create it and mark it ready — the orchestrator claims it when a slot frees up',
  },
  {
    id: 'run',
    label: 'Run now',
    hint: 'spawn at once',
    title: 'Create it and spawn an agent immediately, ahead of the queue',
  },
];

function NewTaskForm({ onCreated, mobile = false }: { onCreated: () => void; mobile?: boolean }) {
  const { repos, settings } = useApp();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [repoId, setRepoId] = useState('');
  const [parentId, setParentId] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [category, setCategory] = useState('');
  const [review, setReview] = useState<ReviewChoice>('default');
  const [reviewModel, setReviewModel] = useState('');
  const [reviewEffort, setReviewEffort] = useState('');
  const [autoPublish, setAutoPublish] = useState(false);
  const reviewOn = reviewIsOn(reviewValueOf(review), settings);
  const [start, setStart] = useState<StartMode>('draft');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { tasks } = useApp();
  const knownCategories = [...new Set(tasks.map((t) => t.category).filter(Boolean))] as string[];

  // Phones: a compact toolbar button, and the form opens as a full-screen
  // sheet instead of pushing every list down by a screen and a half.
  const opener = mobile ? (
    <button className="btn primary new-task-btn" aria-expanded={open} onClick={() => setOpen(true)}>
      <IconPlus /> New
    </button>
  ) : (
    <button className="btn primary" onClick={() => setOpen(true)}>
      + New task
    </button>
  );
  if (!open) return opener;

  // Queue and Run need somewhere to run; without a repo the row would be
  // created and then 409 on the second call, so the control is not offered.
  const canStart = !!repoId;
  const effectiveStart: StartMode = canStart ? start : 'draft';

  const submit = async () => {
    // Two round-trips now, so a double click is a real duplicate risk.
    if (busy) return;
    setBusy(true);
    setErr(null);
    let task: Task;
    try {
      task = await api.createTask({
        title,
        description: description || null,
        repoId: repoId || null,
        parentId: parentId || null,
        model: model || null,
        effort: (effort || null) as EffortLevel | null,
        category: category.trim() || null,
        review: reviewValueOf(review),
        // a hidden reviewer (review off for this task) is not filed
        reviewModel: (reviewOn && reviewModel) || null,
        reviewEffort: ((reviewOn && reviewEffort) || null) as EffortLevel | null,
        autoPublish,
      });
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
      return;
    }
    // The row exists from here on: clear the fields before anything else can
    // fail, so a second Create cannot file the same task twice.
    setTitle('');
    setDescription('');
    setParentId('');
    setModel('');
    setEffort('');
    setReview('default');
    setReviewModel('');
    setReviewEffort('');
    setAutoPublish(false);
    if (effectiveStart !== 'draft') {
      try {
        await api.taskAction(task.id, effectiveStart === 'run' ? 'run-now' : 'enqueue');
      } catch (e) {
        // Created, but not started — say exactly that and stay open so the
        // message is readable; the draft is already on the board behind it.
        setErr(
          `Created as a draft, but could not ${effectiveStart === 'run' ? 'run' : 'queue'} it: ${(e as Error).message}`,
        );
        setBusy(false);
        onCreated();
        return;
      }
    }
    setBusy(false);
    setOpen(false);
    onCreated();
  };

  const form = (
    <div className="panel new-task-panel" style={{ padding: 14, maxWidth: 640 }}>
      <div className="form-grid">
        <div className="wide">
          <label className="label">Title</label>
          <input className="field" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="wide">
          <label className="label">Description</label>
          <textarea className="field" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <label className="label">Repo</label>
          <select
            className="field"
            value={repoId}
            onChange={(e) => {
              setRepoId(e.target.value);
              // never leave "Run now" lit on a task that has nowhere to run
              if (!e.target.value) setStart('draft');
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
            list="tm-categories"
            placeholder="UI, Estimator… (optional)"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
          <datalist id="tm-categories">
            {knownCategories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
        <div className="wide">
          <label className="label">Group</label>
          {/* a new row takes the global max key, so any choice lands at the END
              of its group — "append" and "under the root" are the same write */}
          <GroupPicker
            tasks={tasks}
            repoId={repoId || null}
            value={parentId || null}
            onChange={(id) => setParentId(id ?? '')}
            repoName={(id) => repos.find((r) => r.id === id)?.name}
          />
        </div>
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
          <label className="label">Model override</label>
          <select className="field mono" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">auto (router)</option>
            {/* a preset can set a model the list does not offer (codex-free, a custom preset's id) */}
            {(model && !MODEL_OPTIONS.includes(model) ? [model, ...MODEL_OPTIONS] : MODEL_OPTIONS).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Effort override</label>
          <select className="field mono" value={effort} onChange={(e) => setEffort(e.target.value)}>
            <option value="">default (config)</option>
            {EFFORT_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Adversarial review</label>
          <select className="field" value={review} onChange={(e) => setReview(e.target.value as ReviewChoice)}>
            <option value="default">default (config)</option>
            <option value="on">review this</option>
            <option value="off">skip (small task)</option>
          </select>
        </div>
        {reviewOn && (
          <ReviewerFields
            model={reviewModel}
            effort={reviewEffort}
            onModel={setReviewModel}
            onEffort={setReviewEffort}
            settings={settings}
          />
        )}
        <div className="wide">
          <label className="label">Auto-publish on end</label>
          <select
            className="field"
            value={autoPublish ? 'on' : 'off'}
            onChange={(e) => setAutoPublish(e.target.value === 'on')}
          >
            <option value="off">off — stop at review, publish by hand</option>
            <option value="on">on — commit &amp; push when the agent finishes</option>
          </select>
          <div className="hint">
            {autoPublish
              ? 'Bypasses both gates: no adversarial review round and no human review — the agent commits and pushes in its own terminal, then the task lands in published.'
              : 'The agent stops at review; the Publish button ships it.'}
          </div>
        </div>
        <div className="wide">
          <label className="label">On create</label>
          <div className="start-row">
            {START_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`btn start-btn${effectiveStart === m.id ? ' on' : ''}`}
                aria-pressed={effectiveStart === m.id}
                disabled={m.id !== 'draft' && !canStart}
                title={m.id !== 'draft' && !canStart ? 'Pick a repo first — a task needs one to run' : m.title}
                onClick={() => setStart(m.id)}
              >
                {m.label}
                <span className="start-hint">{m.hint}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      {err && <div className="warn-text" style={{ marginTop: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn primary" disabled={busy || !title.trim()} onClick={submit}>
          {effectiveStart === 'run' ? 'Create & run' : effectiveStart === 'queue' ? 'Create & queue' : 'Create'}
        </button>
        <button className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
  if (!mobile) return form;
  return (
    <>
      {opener}
      <FullSheet label="New task" title="New task" onClose={() => setOpen(false)}>
        {form}
      </FullSheet>
    </>
  );
}

type Provenance = 'all' | 'human' | 'agent' | 'sentry' | 'analyze' | 'feature';
type GroupBy = 'status' | 'category' | 'repo' | 'group';
type SortKey = 'updated' | 'created' | 'oldest' | 'title' | 'manual';

const SORTS: { key: SortKey; label: string; field: 'createdAt' | 'updatedAt' }[] = [
  { key: 'updated', label: 'sort: last touched', field: 'updatedAt' },
  { key: 'created', label: 'sort: newest filed', field: 'createdAt' },
  { key: 'oldest', label: 'sort: oldest filed', field: 'createdAt' },
  { key: 'title', label: 'sort: title A–Z', field: 'updatedAt' },
  // the manual position a drag writes — also the order the queue claims in
  { key: 'manual', label: 'sort: queue order', field: 'updatedAt' },
];

const comparator = (sort: SortKey) => {
  // ids break every tie: ISO timestamps collide on same-transaction writes and
  // two tasks can share a title, and a jittering order re-renders as noise.
  if (sort === 'title') return (a: Task, b: Task) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  if (sort === 'oldest') return (a: Task, b: Task) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  return byRecency(sort === 'created' ? 'createdAt' : 'updatedAt');
};

const provenanceOf = (t: Task): Exclude<Provenance, 'all'> => {
  // feature wins over agent: a feature-generated task is the plan's, not a
  // worker's follow-up (its children keep featureId but are still 'agent').
  if (t.source === 'feature') return 'feature';
  if (t.createdByRun) return 'agent';
  if (t.source === 'sentry') return 'sentry';
  if (t.source === 'auto') return 'analyze';
  return 'human';
};

const PREFS_KEY = 'tm.board';
/** Terminal buckets start folded away — they are history, not work. */
const DEFAULT_COLLAPSED = HISTORY.map((s) => `status:${s}`);

type DispatchFilter = 'all' | 'with' | 'pending';
const PROVENANCES: Provenance[] = ['all', 'human', 'agent', 'sentry', 'analyze', 'feature'];
const GROUP_BYS: GroupBy[] = ['status', 'category', 'repo', 'group'];
const DISPATCH_FILTERS: DispatchFilter[] = ['all', 'with', 'pending'];

interface Prefs {
  sort: SortKey;
  focus: boolean;
  collapsed: string[];
  showAllDrafts: boolean;
  /* filters — kept across reloads (a phone reloads a home-screen app often);
     ids that no longer exist fall back to 'all' at render, see BoardPage */
  repo: string;
  prov: Provenance;
  cat: string;
  group: string;
  dispatch: DispatchFilter;
  groupBy: GroupBy;
}

const BASE_FILTERS = {
  repo: 'all',
  prov: 'all',
  cat: 'all',
  group: 'all',
  dispatch: 'all',
  groupBy: 'status',
} as const satisfies Pick<Prefs, 'repo' | 'prov' | 'cat' | 'group' | 'dispatch' | 'groupBy'>;

const str = (v: unknown, fallback: string) => (typeof v === 'string' && v ? v : fallback);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

const loadPrefs = (): Prefs => {
  const base: Prefs = {
    sort: 'updated',
    focus: false,
    collapsed: DEFAULT_COLLAPSED,
    showAllDrafts: false,
    ...BASE_FILTERS,
  };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return base;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      sort: SORTS.some((s) => s.key === p.sort) ? (p.sort as SortKey) : base.sort,
      focus: typeof p.focus === 'boolean' ? p.focus : base.focus,
      collapsed: Array.isArray(p.collapsed) ? p.collapsed.filter((c): c is string => typeof c === 'string') : base.collapsed,
      showAllDrafts: typeof p.showAllDrafts === 'boolean' ? p.showAllDrafts : base.showAllDrafts,
      repo: str(p.repo, base.repo),
      prov: oneOf(p.prov, PROVENANCES, base.prov),
      cat: str(p.cat, base.cat),
      group: str(p.group, base.group),
      dispatch: oneOf(p.dispatch, DISPATCH_FILTERS, base.dispatch),
      groupBy: oneOf(p.groupBy, GROUP_BYS, base.groupBy),
    };
  } catch {
    // corrupt JSON or storage blocked (private mode) — the board still works
    return base;
  }
};

/** One rendered line: the task plus how deep it sits in the visible tree. */
interface Row {
  task: Task;
  depth: number;
}

/** Consecutive rows of the same group — the tree ordering keeps them together. */
function blocksOf(rows: Row[]): { groupId: string; rows: Row[] }[] {
  const out: { groupId: string; rows: Row[] }[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.groupId === r.task.groupId) last.rows.push(r);
    else out.push({ groupId: r.task.groupId, rows: [r] });
  }
  return out;
}

/**
 * A titled strip of rows that can be folded away. The header is the control:
 * the whole label is the toggle, `action` sits outside it (its own button).
 */
function Section({
  label,
  count,
  accent,
  tint,
  collapsed,
  onToggle,
  action,
  children,
}: {
  label: string;
  count: number;
  accent?: boolean;
  /** group colour for the header (`--tm-group`); absent = the neutral header */
  tint?: CSSProperties;
  collapsed: boolean;
  onToggle: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className={`section-head ${accent ? 'accent' : ''} ${tint ? 'group-tint' : ''}`} style={tint}>
        <button className="section-fold" aria-expanded={!collapsed} onClick={onToggle}>
          <span className={`caret ${collapsed ? 'closed' : ''}`}>
            <IconChevron />
          </span>
          {label} <span className="count">{count}</span>
        </button>
        {!collapsed && action}
      </div>
      {!collapsed && children}
    </div>
  );
}

export function BoardPage({
  onOpenTask,
  onOpenTerminal,
}: {
  onOpenTask: (id: string) => void;
  onOpenTerminal: (runId: string) => void;
}) {
  const { tasks, repos, runs, settings, refresh, dispatches, questions } = useApp();
  // default ON so the board is coloured before /api/config answers, matching
  // DEFAULT_SETTINGS['board.groupColors']
  const groupColors = settings?.['board.groupColors'] ?? true;
  const repoName = (id: string | null) => repos.find((r) => r.id === id)?.name;
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const { sort, focus, showAllDrafts, groupBy, prov: filterProv } = prefs;
  const mobile = useIsMobile();
  const presets = useTaskPresets();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const now = useNow();
  const setPref = <K extends keyof Prefs>(k: K, v: Prefs[K]) => setPrefs((p) => ({ ...p, [k]: v }));
  const setFilterRepo = (v: string) => setPref('repo', v);
  const setFilterProv = (v: Provenance) => setPref('prov', v);
  const setFilterCat = (v: string) => setPref('cat', v);
  const setFilterGroup = (v: string) => setPref('group', v);
  const setFilterDispatch = (v: DispatchFilter) => setPref('dispatch', v);
  const setGroupBy = (v: GroupBy) => setPref('groupBy', v);
  // A persisted filter can outlive what it names (repo removed, group
  // dissolved, last dispatch pruned). Its select would then be hidden or
  // blank while it silently empties the board, so it reads as 'all'. The
  // checks wait for data: an empty list at boot means "not loaded yet".
  const filterRepo =
    prefs.repo === 'all' || repos.length === 0 || repos.some((r) => r.id === prefs.repo) ? prefs.repo : 'all';
  const filterCat =
    prefs.cat === 'all' || prefs.cat === 'none' || tasks.length === 0 || tasks.some((t) => t.category === prefs.cat)
      ? prefs.cat
      : 'all';
  const filterGroup =
    prefs.group === 'all' || tasks.length === 0 || tasks.some((t) => t.groupId === prefs.group && t.id !== prefs.group)
      ? prefs.group
      : 'all';
  const filterDispatch: DispatchFilter = dispatches.length === 0 ? 'all' : prefs.dispatch;

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // storage blocked — preferences just stay per-session
    }
  }, [prefs]);

  const collapsed = useMemo(() => new Set(prefs.collapsed), [prefs.collapsed]);
  const toggleFold = (id: string) =>
    setPrefs((p) => {
      const next = new Set(p.collapsed);
      if (!next.delete(id)) next.add(id);
      return { ...p, collapsed: [...next] };
    });

  const categories = useMemo(
    () => [...new Set(tasks.map((t) => t.category).filter(Boolean))].sort() as string[],
    [tasks],
  );

  // Tasks touched by dispatches (docs/dispatch.md) — either side counts, so
  // the filter surfaces the whole conversation, not just the receiving end.
  const dispatchTouched = useMemo(() => {
    const any = new Set<string>();
    const pending = new Set<string>();
    for (const d of dispatches) {
      any.add(d.fromTaskId).add(d.toTaskId);
      if (d.status === 'pending') pending.add(d.fromTaskId).add(d.toTaskId);
    }
    return { any, pending };
  }, [dispatches]);

  const filtered = useMemo(
    () =>
      tasks.filter(
        (t) =>
          (filterRepo === 'all' || t.repoId === filterRepo) &&
          (filterProv === 'all' || provenanceOf(t) === filterProv) &&
          (filterCat === 'all' || (filterCat === 'none' ? !t.category : t.category === filterCat)) &&
          (filterGroup === 'all' || t.groupId === filterGroup) &&
          (filterDispatch === 'all' ||
            (filterDispatch === 'with' ? dispatchTouched.any.has(t.id) : dispatchTouched.pending.has(t.id))),
      ),
    [tasks, filterRepo, filterProv, filterCat, filterGroup, filterDispatch, dispatchTouched],
  );

  // Every task tree on the board, keyed by root id: the name/colour to draw it
  // with and its FULL size, so a section showing part of a group can say so.
  // Built from all tasks, never the filtered set — a group does not shrink
  // because a filter hides some of its members.
  const groupIndex = useMemo(() => {
    const out = new Map<string, { id: string; label: string; size: number; slot: number }>();
    const roots = new Map(tasks.filter((t) => t.id === t.groupId).map((t) => [t.id, t]));
    for (const t of tasks) {
      const cur = out.get(t.groupId);
      if (cur) {
        cur.size++;
        continue;
      }
      const root = roots.get(t.groupId);
      out.set(t.groupId, {
        id: t.groupId,
        // A group whose root is gone (deleted mid-tree) is still a group; fall
        // back to this member's title rather than rendering "group".
        label: groupLabel(root ?? (t.id === t.groupId ? t : undefined), t.title),
        size: 1,
        slot: groupColorSlot(root, t.groupId),
      });
    }
    return out;
  }, [tasks]);

  /** Groups worth offering as a filter / a section: anything with a real tree. */
  const namedGroups = useMemo(
    () => [...groupIndex.values()].filter((g) => g.size > 1).sort((a, b) => a.label.localeCompare(b.label)),
    [groupIndex],
  );

  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  // Manual position (docs/grouping.md § Order): the keys from a task's group
  // root down to it. Compared element-wise that is depth-first tree order —
  // how a group's members ALWAYS read, whatever the sort, and how the groups
  // themselves read under `sort: queue order`, which is the claim order.
  const byPosition = useMemo(() => {
    const paths = new Map<string, number[]>();
    const pathOf = (t: Task): number[] => {
      const hit = paths.get(t.id);
      if (hit) return hit;
      const out: number[] = [];
      const seen = new Set<string>(); // a corrupt parent chain must not hang the board
      for (let n: Task | undefined = t; n && !seen.has(n.id); n = n.parentId ? byId.get(n.parentId) : undefined) {
        seen.add(n.id);
        out.push(n.sortOrder);
      }
      out.reverse();
      paths.set(t.id, out);
      return out;
    };
    return (a: Task, b: Task) => {
      const pa = pathOf(a);
      const pb = pathOf(b);
      for (let i = 0; i < Math.min(pa.length, pb.length); i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
      return pa.length - pb.length || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    };
  }, [byId]);

  // Children under their parent at any depth, and all roots of one group kept
  // adjacent — that adjacency is what lets a group render as one block below.
  // Inside a group the order is always the manual one; the sort control only
  // decides where each group (and each lone task) sits.
  const ordered = (list: Task[]): Row[] => {
    const sorted = [...list].sort(sort === 'manual' ? byPosition : comparator(sort));
    const present = new Set(sorted.map((t) => t.id));
    const childrenOf = new Map<string, Task[]>();
    const roots: Task[] = [];
    for (const t of sorted) {
      if (t.parentId && present.has(t.parentId)) {
        const kids = childrenOf.get(t.parentId);
        if (kids) kids.push(t);
        else childrenOf.set(t.parentId, [t]);
      } else roots.push(t);
    }
    const rootsByGroup = new Map<string, Task[]>();
    for (const r of roots) {
      const cur = rootsByGroup.get(r.groupId);
      if (cur) cur.push(r);
      else rootsByGroup.set(r.groupId, [r]);
    }
    for (const kids of childrenOf.values()) kids.sort(byPosition);
    for (const tops of rootsByGroup.values()) tops.sort(byPosition);
    const out: Row[] = [];
    const seen = new Set<string>(); // a corrupt parent chain must not hang the board
    const walk = (t: Task, depth: number) => {
      if (seen.has(t.id)) return;
      seen.add(t.id);
      out.push({ task: t, depth });
      for (const c of childrenOf.get(t.id) ?? []) walk(c, depth + 1);
    };
    for (const r of roots) for (const sibling of rootsByGroup.get(r.groupId) ?? []) walk(sibling, 0);
    return out;
  };

  const groups = useMemo(() => {
    const out = new Map<string, Row[]>();
    if (groupBy === 'status') {
      for (const s of ORDER) {
        const list = filtered.filter((t) => t.status === s);
        if (list.length) out.set(s, ordered(list));
      }
    } else if (groupBy === 'category') {
      for (const c of categories) {
        const list = filtered.filter((t) => t.category === c);
        if (list.length) out.set(c, ordered(list));
      }
      const none = filtered.filter((t) => !t.category);
      if (none.length) out.set('uncategorized', ordered(none));
    } else if (groupBy === 'group') {
      // One section per task tree, biggest first — the trees ARE the sections
      // here, so the in-panel group headers are suppressed below.
      // keyed by group id, not label: two groups may share a title, and the
      // key is also the fold-state id
      for (const g of [...namedGroups].sort((a, b) => b.size - a.size || a.label.localeCompare(b.label))) {
        const list = filtered.filter((t) => t.groupId === g.id);
        if (list.length) out.set(g.id, ordered(list));
      }
      const single = filtered.filter((t) => (groupIndex.get(t.groupId)?.size ?? 1) <= 1);
      if (single.length) out.set('ungrouped', ordered(single));
    } else {
      for (const r of repos) {
        const list = filtered.filter((t) => t.repoId === r.id);
        if (list.length) out.set(r.name, ordered(list));
      }
      const none = filtered.filter((t) => !t.repoId);
      if (none.length) out.set('no repo', ordered(none));
    }
    return out;
    // `ordered` closes over `sort` and `byPosition` — listing them is the honest dep
  }, [filtered, groupBy, categories, repos, sort, byPosition, namedGroups, groupIndex]);

  // running first, then review; sorted inside each — never capped, active work
  // is exactly what must stay visible.
  const active = useMemo(
    () => ACTIVE.flatMap((s) => ordered(filtered.filter((t) => t.status === s))),
    [filtered, sort, byPosition],
  );

  // Drafts are the inbox — they sit right under the live work now, capped so a
  // long backlog cannot push the rest of the board off screen.
  const drafts = useMemo(
    () => ordered(filtered.filter((t) => t.status === 'draft')),
    [filtered, sort, byPosition],
  );

  // "Recent" ignores the sort control on purpose: it is the by-definition
  // last-touched shortcut, and it now closes the page instead of opening it.
  // Flat by design — it is a lookup list, so no nesting and no group blocks.
  const recent = useMemo(
    () => [...filtered].sort(byRecency('updatedAt')).slice(0, RECENT_LIMIT).map((task) => ({ task, depth: 0 })),
    [filtered],
  );

  const attention = (t: Task) =>
    t.status === 'running' && runs.some((r) => r.taskId === t.id && r.needsAttention && r.status === 'running');
  // the slice is the pending set (docs/questions.md)
  const asking = useMemo(() => new Set(questions.map((q) => q.taskId)), [questions]);

  const sortField = SORTS.find((s) => s.key === sort)!.field;

  // Drag and drop (docs/grouping.md § Drag and drop). The server resolves the
  // drop; the WS broadcast and the refresh both land the result.
  const [boardErr, setBoardErr] = useState<string | null>(null);
  const report = (e: unknown) => setBoardErr(e instanceof Error ? e.message : String(e));
  const onDrop = (moving: Task, zone: DropZone, targetId: string) => {
    const target = byId.get(targetId);
    // Reordering among roots is only visible in queue order — switch to it
    // rather than let the drop look like it did nothing.
    if ((zone === 'before' || zone === 'after') && target && !target.parentId && sort !== 'manual') {
      setPrefs((p) => ({ ...p, sort: 'manual' }));
    }
    setBoardErr(null);
    api
      .moveTask(moving.id, { place: zone, targetId })
      .then(() => refresh())
      .catch(report);
  };
  const { drag, gripProps, dropClass } = useTaskDrag(tasks, onDrop);

  const patchGroup = async (rootId: string, patch: { groupName?: string | null; groupColor?: number | null }) => {
    setBoardErr(null);
    try {
      await api.updateTask(rootId, patch);
      await refresh();
    } catch (e) {
      report(e);
      throw e;
    }
  };

  // Colour a group carries wherever it is drawn — `--tm-group` resolves the
  // slot token; with board.groupColors off nothing is set and every rule falls
  // back to the neutral border tokens.
  const groupStyle = (groupId: string): CSSProperties | undefined =>
    groupColors ? ({ '--tm-group': `var(--tm-group-${groupIndex.get(groupId)?.slot ?? 1})` } as CSSProperties) : undefined;

  /**
   * A row's tags, in the desktop order. Phones show the two that say the most
   * about WHERE and WHAT (repo, pending dispatches, group, category…) and fold
   * the rest into "+n". The row opens the task, and the panel has them all.
   */
  const rowChips = (
    t: Task,
    ctx: GroupBy | 'recent' | 'active' | 'drafts',
    g: { label: string; size: number } | undefined,
    pendingOut: number,
  ) => {
    const repo = repoName(t.repoId);
    const all: [id: string, node: ReactNode][] = [];
    // flat lists have no group header above them, so the tag carries it
    if (ctx === 'recent' && g && g.size > 1) {
      all.push([
        'group',
        <span key="group" className="chip group-chip" style={groupStyle(t.groupId)} title={`group · ${g.size} tasks`}>
          {g.label}
        </span>,
      ]);
    }
    // Only chips that will actually draw go in the list: the "+n" counts them.
    // PresetChip / ReviewerChip render null on these same conditions.
    if (matchTaskPreset({ model: t.model, effort: t.effort, review: t.review }, presets)) {
      all.push(['preset', <PresetChip key="preset" model={t.model} effort={t.effort} review={t.review} />]);
    }
    if (reviewIsOn(t.review, settings) && t.reviewModel && t.reviewModel !== globalReviewModel(settings)) {
      all.push(['reviewer', <ReviewerChip key="reviewer" reviewModel={t.reviewModel} settings={settings} />]);
    }
    if (t.category && ctx !== 'category') {
      all.push([
        'category',
        <span key="category" className="chip" style={{ color: 'var(--tm-accent)' }}>
          {t.category}
        </span>,
      ]);
    }
    if (t.featureId) {
      all.push([
        'feature',
        <span key="feature" className="chip" style={{ color: 'var(--tm-accent)' }} title={`feature phase ${(t.featurePhase ?? 0) + 1}`}>
          feat p{(t.featurePhase ?? 0) + 1}
        </span>,
      ]);
    }
    if (t.autoPublish) {
      all.push([
        'autopub',
        <span
          key="autopub"
          className="chip"
          style={{ color: 'var(--tm-status-published)' }}
          title="auto-publish on end — the agent commits and pushes when it finishes, skipping review"
        >
          auto-publish
        </span>,
      ]);
    }
    if (pendingOut > 0) {
      all.push([
        'dispatch',
        <span
          key="dispatch"
          className="chip dispatch-chip"
          title={`${pendingOut} dispatch${pendingOut === 1 ? '' : 'es'} sent by this task, awaiting delivery`}
        >
          ⇢ {pendingOut} pending
        </span>,
      ]);
    }
    if (t.createdByRun) {
      all.push([
        'agent',
        <span key="agent" className="chip" title="filed by an agent session">
          agent
        </span>,
      ]);
    }
    if (t.source !== 'manual' && t.source !== 'feature' && !t.createdByRun) {
      all.push(['source', <span key="source" className="chip">{t.source}</span>]);
    }
    // a phone filtered to one repo does not need that repo's name on every row
    if (repo && ctx !== 'repo' && !(mobile && filterRepo !== 'all')) {
      all.push(['repo', <span key="repo" className="chip">{repo}</span>]);
    }
    if (!mobile) return all.map(([, node]) => node);
    const rank = (id: string) => {
      const i = MOBILE_CHIP_ORDER.indexOf(id);
      return i === -1 ? MOBILE_CHIP_ORDER.length : i;
    };
    const ranked = [...all].sort((a, b) => rank(a[0]) - rank(b[0]));
    const shown = ranked.slice(0, MOBILE_CHIPS);
    const hidden = ranked.length - shown.length;
    return (
      <>
        {shown.map(([, node]) => node)}
        {hidden > 0 && (
          <span className="chip more-chip" title={`${hidden} more tag${hidden === 1 ? '' : 's'} — open the task`}>
            +{hidden}
          </span>
        )}
      </>
    );
  };

  // one row, shared by the strips and the grouped lists below them
  const row = (t: Task, ctx: GroupBy | 'recent' | 'active' | 'drafts', depth = 0) => {
    // drafts never ran, so their created time is the honest one; recent is a
    // last-touched list; everywhere else the age matches the active sort.
    const field = ctx === 'drafts' ? 'createdAt' : ctx === 'recent' ? 'updatedAt' : sortField;
    const fresh = isNew(t.createdAt, now);
    const g = groupIndex.get(t.groupId);
    const pendingOut = dispatches.filter((d) => d.fromTaskId === t.id && d.status === 'pending').length;
    const hasIncoming = dispatches.some((d) => d.toTaskId === t.id);
    return (
      <Fragment key={t.id}>
      <TaskRow
        task={t}
        onOpenTask={onOpenTask}
        onOpenTerminal={onOpenTerminal}
        fresh={fresh}
        depth={depth}
        // `recent` is a flat lookup list — nothing to drop beside or into there
        grip={ctx === 'recent' ? undefined : gripProps(t)}
        dropClass={ctx === 'recent' ? undefined : dropClass(t.id, 'task')}
      >
        {!focus && rowChips(t, ctx, g, pendingOut)}
        <StatusBadge
          status={t.status}
          attention={attention(t)}
          question={asking.has(t.id)}
          reviewState={t.reviewState}
          onOpenReviewer={(() => {
            const rv = liveReviewRun(runs, t.id);
            return rv ? () => onOpenTerminal(rv.id) : undefined;
          })()}
        />
        {!focus && (
          <TimeAgo
            iso={t[field]}
            field={field === 'createdAt' ? 'created' : 'updated'}
            fresh={fresh}
            createdAt={t.createdAt}
            updatedAt={t.updatedAt}
          />
        )}
      </TaskRow>
      {/* incoming dispatches, compact under the receiving row; essentials
          mode keeps only what still needs to happen */}
      {hasIncoming && (
        <DispatchStrip taskId={t.id} limit={3} pendingOnly={focus} onOpenTask={onOpenTask} />
      )}
      </Fragment>
    );
  };

  /**
   * Rows of one panel, with every group of more than one task wrapped in its own
   * block. `heads: false` is for the `group: group` sections, where the
   * section header already names the group.
   */
  const renderRows = (rows: Row[], ctx: GroupBy | 'recent' | 'active' | 'drafts', heads = true) =>
    blocksOf(rows).map((b) => {
      const g = groupIndex.get(b.groupId);
      if (!heads || !g || g.size < 2) return b.rows.map((r) => row(r.task, ctx, r.depth));
      const root = byId.get(g.id);
      const foldId = `grp:${g.id}`;
      const folded = collapsed.has(foldId);
      return (
        <div className={`task-group ${folded ? 'folded' : ''}`} key={b.groupId} style={groupStyle(b.groupId)}>
          <GroupHead
            groupId={g.id}
            label={g.label}
            name={root?.groupName ?? null}
            color={root?.groupColor ?? null}
            shown={b.rows.length}
            size={g.size}
            members={b.rows.map((r) => r.task)}
            collapsed={folded}
            dropClass={dropClass(g.id, 'group')}
            onToggle={() => toggleFold(foldId)}
            onFilter={() => setFilterGroup(g.id)}
            onRename={(groupName) => patchGroup(g.id, { groupName })}
            onColor={(groupColor) => patchGroup(g.id, { groupColor }).catch(() => {})}
          />
          {!folded && <div className="task-group-rows">{b.rows.map((r) => row(r.task, ctx, r.depth))}</div>}
        </div>
      );
    });

  const draftsShown = showAllDrafts ? drafts : drafts.slice(0, DRAFT_LIMIT);

  // The filter controls, written once: desktop lays them out in the bar,
  // phones stack them in the Filters sheet.
  const filterSelects = (
    <>
      <select className="field" aria-label="Repo" value={filterRepo} onChange={(e) => setFilterRepo(e.target.value)}>
        <option value="all">all repos</option>
        {repos.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      <select className="field" aria-label="Source" value={filterProv} onChange={(e) => setFilterProv(e.target.value as Provenance)}>
        <option value="all">all sources</option>
        <option value="human">human</option>
        <option value="agent">agent</option>
        <option value="sentry">sentry</option>
        <option value="analyze">analyze</option>
        <option value="feature">feature</option>
      </select>
      <select className="field" aria-label="Category" value={filterCat} onChange={(e) => setFilterCat(e.target.value)}>
        <option value="all">all categories</option>
        {categories.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
        <option value="none">uncategorized</option>
      </select>
      {dispatches.length > 0 && (
        <select
          className="field"
          aria-label="Dispatches"
          value={filterDispatch}
          onChange={(e) => setFilterDispatch(e.target.value as DispatchFilter)}
        >
          <option value="all">dispatches: any</option>
          <option value="with">has dispatches</option>
          <option value="pending">pending dispatches</option>
        </select>
      )}
      {namedGroups.length > 0 && (
        <select className="field" aria-label="Task group" value={filterGroup} onChange={(e) => setFilterGroup(e.target.value)}>
          <option value="all">all groups</option>
          {namedGroups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label} ({g.size})
            </option>
          ))}
        </select>
      )}
      <select className="field" aria-label="Group by" value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
        <option value="status">group: status</option>
        <option value="category">group: category</option>
        <option value="repo">group: repo</option>
        <option value="group">group: task group</option>
      </select>
    </>
  );
  const sortSelect = (
    <select
      className="field"
      aria-label="Sort"
      value={sort}
      onChange={(e) => setPrefs((p) => ({ ...p, sort: e.target.value as SortKey }))}
    >
      {SORTS.map((s) => (
        <option key={s.key} value={s.key}>
          {s.label}
        </option>
      ))}
    </select>
  );
  const focusToggle = (
    <button
      className={`btn ${focus ? 'primary' : ''}`}
      aria-pressed={focus}
      title={focus ? 'Show tags, ages and the recent strip again' : 'Essentials only — titles and status, no tags or history'}
      onClick={() => setPrefs((p) => ({ ...p, focus: !p.focus }))}
    >
      {focus ? 'full view' : 'essentials'}
    </button>
  );

  // Phones: what the sheet hides must still be visible, so every filter that
  // is narrowing the board prints as a chip that clears it.
  const activeFilters: { id: string; label: string; clear: () => void }[] = [];
  if (filterRepo !== 'all') {
    activeFilters.push({ id: 'repo', label: repoName(filterRepo) ?? 'repo', clear: () => setFilterRepo('all') });
  }
  if (filterProv !== 'all') activeFilters.push({ id: 'prov', label: filterProv, clear: () => setFilterProv('all') });
  if (filterCat !== 'all') {
    activeFilters.push({ id: 'cat', label: filterCat === 'none' ? 'uncategorized' : filterCat, clear: () => setFilterCat('all') });
  }
  if (filterGroup !== 'all') {
    activeFilters.push({
      id: 'group',
      label: groupIndex.get(filterGroup)?.label ?? 'group',
      clear: () => setFilterGroup('all'),
    });
  }
  if (filterDispatch !== 'all') {
    activeFilters.push({
      id: 'dispatch',
      label: filterDispatch === 'with' ? 'has dispatches' : 'pending dispatches',
      clear: () => setFilterDispatch('all'),
    });
  }
  if (groupBy !== 'status') {
    activeFilters.push({
      id: 'groupBy',
      label: `group: ${groupBy === 'group' ? 'task group' : groupBy}`,
      clear: () => setGroupBy('status'),
    });
  }
  const resetFilters = () => setPrefs((p) => ({ ...p, ...BASE_FILTERS }));

  return (
    <div className="board">
      {mobile ? (
        <>
          {/* Glass gives the phone board a large title like every other page; Classic hides it */}
          <h1 className="page-title glass-only">Board</h1>
          <div className="board-toolbar">
            <button
              className={`btn filters-btn ${activeFilters.length > 0 ? 'on' : ''}`}
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen(true)}
            >
              <IconFilter /> Filters
              {activeFilters.length > 0 && <span className="count">{activeFilters.length}</span>}
            </button>
            {sortSelect}
            <NewTaskForm onCreated={refresh} mobile />
          </div>
          {activeFilters.length > 0 && (
            <div className="filter-chips">
              {activeFilters.map((f) => (
                <button key={f.id} className="chip filter-chip" title="Clear this filter" onClick={f.clear}>
                  {f.label}
                  <IconX />
                </button>
              ))}
            </div>
          )}
          {filtersOpen && (
            <Sheet label="Filters" title="Filters & view" onClose={() => setFiltersOpen(false)}>
              <div className="sheet-fields">
                {filterSelects}
                <div className="sheet-field-row">
                  <span className="muted">View</span>
                  <span className="seg" role="group" aria-label="View">
                    <button
                      className={`btn ${focus ? '' : 'primary'}`}
                      aria-pressed={!focus}
                      onClick={() => setPrefs((p) => ({ ...p, focus: false }))}
                    >
                      full
                    </button>
                    <button
                      className={`btn ${focus ? 'primary' : ''}`}
                      aria-pressed={focus}
                      title="Titles and status only: no tags, ages or history"
                      onClick={() => setPrefs((p) => ({ ...p, focus: true }))}
                    >
                      essentials
                    </button>
                  </span>
                </div>
              </div>
              <div className="sheet-buttons">
                <button className="btn" disabled={activeFilters.length === 0} onClick={resetFilters}>
                  Reset
                </button>
                <button className="btn primary" onClick={() => setFiltersOpen(false)}>
                  Done
                </button>
              </div>
            </Sheet>
          )}
        </>
      ) : (
        <>
          <h1 className="page-title">
            Board
            <span style={{ flex: 1 }} />
            {focusToggle}
          </h1>
          <div className="board-bar">
            {filterSelects}
            {sortSelect}
          </div>
        </>
      )}
      {boardErr && (
        <div className="board-err warn-text" role="alert">
          <span>{boardErr}</span>
          <button className="btn ghost" onClick={() => setBoardErr(null)}>
            dismiss
          </button>
        </div>
      )}
      {!mobile && <NewTaskForm onCreated={refresh} />}
      <DragGhost drag={drag} tasks={tasks} />
      {tasks.length === 0 && (
        <div className="empty panel" style={{ marginTop: 20 }}>
          <div className="big">No tasks yet</div>
          Add a repo, then create your first task.
        </div>
      )}
      {filtered.length === 0 && tasks.length > 0 && (
        <div className="empty panel" style={{ marginTop: 20 }}>
          <div className="big">Nothing matches</div>
          adjust the filters above
        </div>
      )}
      {active.length > 0 && (
        <Section label="Active" count={active.length} accent collapsed={collapsed.has('active')} onToggle={() => toggleFold('active')}>
          <div className="panel">{renderRows(active, 'active')}</div>
        </Section>
      )}
      {drafts.length > 0 && (
        <Section
          label="Drafts"
          count={drafts.length}
          collapsed={collapsed.has('drafts')}
          onToggle={() => toggleFold('drafts')}
          action={
            drafts.length > DRAFT_LIMIT && (
              <button
                className="btn ghost section-toggle"
                aria-expanded={showAllDrafts}
                onClick={() => setPrefs((p) => ({ ...p, showAllDrafts: !p.showAllDrafts }))}
              >
                {showAllDrafts ? `show ${DRAFT_LIMIT}` : `show all ${drafts.length}`}
              </button>
            )
          }
        >
          <div className="panel">{renderRows(draftsShown, 'drafts')}</div>
        </Section>
      )}
      {[...groups.entries()].map(([label, list]) => {
        // Under group: status the strips above ARE the running/review/draft
        // buckets — repeating them verbatim right below would be pure noise.
        // Under the other groupings a task can legitimately appear twice: once
        // pinned at the top, once inside its category/repo.
        if (groupBy === 'status' && ((ACTIVE as string[]).includes(label) || label === 'draft')) return null;
        // essentials mode drops finished history entirely
        if (focus && groupBy === 'status' && (HISTORY as string[]).includes(label)) return null;
        const id = `${groupBy}:${label}`;
        // under `group: task group` the key is the group id — show its name
        const heading = groupBy === 'group' ? (groupIndex.get(label)?.label ?? label) : label;
        return (
          <Section
            key={id}
            label={heading}
            count={list.length}
            tint={groupBy === 'group' && groupIndex.has(label) ? groupStyle(label) : undefined}
            collapsed={collapsed.has(id)}
            onToggle={() => toggleFold(id)}
          >
            <div className="panel">{renderRows(list, groupBy, groupBy !== 'group')}</div>
          </Section>
        );
      })}
      {!focus && recent.length > 0 && (
        <Section label="Recent" count={recent.length} collapsed={collapsed.has('recent')} onToggle={() => toggleFold('recent')}>
          <div className="panel">{recent.map((r) => row(r.task, 'recent'))}</div>
        </Section>
      )}
    </div>
  );
}
