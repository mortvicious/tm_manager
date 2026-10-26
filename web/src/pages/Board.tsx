import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  EFFORT_LEVELS,
  MODEL_OPTIONS,
  applyDescriptionSkeleton,
  applyTitlePattern,
  effectiveLanding,
  groupColorSlot,
  groupLabel,
  matchTaskPreset,
  templateChecksFor,
  type EffortLevel,
  type LandingTier,
  type Task,
  type TaskStatus,
  type TaskTemplate,
} from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { toastError, toastUndo } from '../toast.ts';
import {
  absorbTyped,
  buildHaystacks,
  compileQuery,
  isSearching,
  isToken,
  tokenLive,
  type SearchContext,
  type SearchToken,
} from '../boardSearch.ts';
import { SearchChips, SearchPanel, SearchTrigger, useSearchHotkey } from '../components/BoardSearch.tsx';
import { BulkBar } from '../components/BulkBar.tsx';
import { DispatchStrip } from '../components/DispatchStrip.tsx';
import { DoneFields } from '../components/DoneFields.tsx';
import { LoopChip, LoopFields, loopInput } from '../components/LoopPanel.tsx';
import { GroupHead } from '../components/GroupHead.tsx';
import { GroupPicker } from '../components/GroupPicker.tsx';
import { LandingPicker } from '../components/LandingPicker.tsx';
import { IconChevron, IconPlus } from '../components/Icons.tsx';
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
import { TaskAttemptsChip, TaskCostChip } from '../components/RunMeta.tsx';
import { FullSheet } from '../components/Sheet.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { Explainable } from '../components/Explain.tsx';
import { verdictChip } from '../components/ReviewPanel.tsx';
import { DragGhost, undoMove, useTaskDrag, type DropZone } from '../components/TaskDrag.tsx';
import { TaskRow } from '../components/TaskRow.tsx';
import { ProgressPct } from '../components/TaskProgress.tsx';
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
const MOBILE_CHIP_ORDER = ['verdict', 'checkerror', 'autolanded', 'loop', 'repo', 'cost', 'attempts', 'dispatch', 'group', 'category', 'feature', 'landing', 'agent', 'source', 'preset', 'reviewer'];

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

/** The repo the last task filed from this browser went to (docs/mobile.md § New task). */
const LAST_REPO_KEY = 'tm.newTask.repo';
const loadLastRepo = (): string => {
  try {
    return localStorage.getItem(LAST_REPO_KEY) ?? '';
  } catch {
    return '';
  }
};

function NewTaskForm({
  onCreated,
  mobile = false,
  filterRepoId = null,
}: {
  onCreated: () => void;
  mobile?: boolean;
  /** the board's search narrowed to exactly one repo: the repo a new task most likely means */
  filterRepoId?: string | null;
}) {
  const { repos, settings, commands } = useApp();
  const presets = useTaskPresets();
  const templates = settings?.['task.templates'] ?? [];
  // the content template picked (docs/inbox.md § Templates) — a form fill, never a link
  const [templateId, setTemplateId] = useState('');
  const template = templates.find((t) => t.id === templateId) ?? null;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [checks, setChecks] = useState<string[] | null>(null);
  const [repoId, setRepoId] = useState('');
  const [parentId, setParentId] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [category, setCategory] = useState('');
  const [review, setReview] = useState<ReviewChoice>('default');
  const [reviewModel, setReviewModel] = useState('');
  const [reviewEffort, setReviewEffort] = useState('');
  const [landing, setLanding] = useState<LandingTier | null>(null);
  // loop task (docs/loops.md): goal + limits; `kind` is create-only
  const [isLoop, setIsLoop] = useState(false);
  const [loopGoal, setLoopGoal] = useState('');
  const [loopMaxIt, setLoopMaxIt] = useState('');
  const [loopBudget, setLoopBudget] = useState('');
  const reviewOn = reviewIsOn(reviewValueOf(review), settings);
  const [start, setStart] = useState<StartMode>('draft');
  // phones fold everything after Repo away, like the task panel's Settings
  const [moreOpen, setMoreOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { tasks } = useApp();
  const knownCategories = [...new Set(tasks.map((t) => t.category).filter(Boolean))] as string[];

  const checkNames = (repo: string) => commands.filter((c) => c.repoId === repo && c.isCheck).map((c) => c.name);
  const pickRepo = (id: string) => {
    setRepoId(id);
    // check names belong to a repo: another repo starts from "all"
    // (or from the template's pick, mapped onto THAT repo's checks)
    setChecks(template && id ? templateChecksFor(template, checkNames(id)) : null);
    // never leave "Run now" lit on a task that has nowhere to run
    if (!id) setStart('draft');
  };

  // An open form with no repo starts from the board's one-repo filter, else
  // the repo the last task went to — re-picking it every time was the phone's
  // slowest step. Re-run when the repos arrive (a click can beat the first
  // load); a repo picked in this kept draft, "none" included, is left alone.
  const repoTouched = useRef(false);
  useEffect(() => {
    if (!open || repoId || repoTouched.current) return;
    const known = (id: string | null) => !!id && repos.some((r) => r.id === id);
    const last = loadLastRepo();
    const next = known(filterRepoId) ? filterRepoId! : known(last) ? last : '';
    if (next) pickRepo(next);
    // pickRepo is a fresh closure every render; these are what decide the default
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repoId, repos, filterRepoId]);
  const openForm = () => setOpen(true);

  // Phones: a compact toolbar button, and the form opens as a full-screen
  // sheet instead of pushing every list down by a screen and a half.
  const opener = mobile ? (
    <button className="btn primary new-task-btn" aria-expanded={open} onClick={openForm}>
      <IconPlus /> New
    </button>
  ) : (
    <button className="btn primary" onClick={openForm}>
      + New task
    </button>
  );
  if (!open) return opener;

  // Queue and Run need somewhere to run; without a repo the row would be
  // created and then 409 on the second call, so the control is not offered.
  const canStart = !!repoId;
  const effectiveStart: StartMode = canStart ? start : 'draft';
  // the title the pattern makes of what is typed — what Create files
  const finalTitle = applyTitlePattern(template?.title ?? '', title);

  // A template fills the fields; what the previous template put there (and
  // nobody edited since) is replaced rather than stacked under the new one.
  const pickTemplate = (next: TaskTemplate | null) => {
    setTemplateId(next?.id ?? '');
    if (!next) return;
    const prevDesc = template?.description.trim() ?? '';
    const base = prevDesc && description.trim() === prevDesc ? '' : description;
    setDescription(applyDescriptionSkeleton(next.description, base));
    if (next.acceptance.trim() && (!acceptance.trim() || acceptance.trim() === template?.acceptance.trim())) {
      setAcceptance(next.acceptance.trim());
    }
    if (repoId) setChecks(templateChecksFor(next, checkNames(repoId)));
    const preset = next.preset ? presets.find((p) => p.id === next.preset) : undefined;
    if (preset) {
      setModel(preset.model);
      setEffort(preset.effort);
      setReview(reviewChoiceOf(preset.review));
    }
  };

  const submit = async () => {
    // Two round-trips now, so a double click is a real duplicate risk.
    if (busy) return;
    const loop = isLoop ? loopInput(loopGoal, loopMaxIt, loopBudget) : null;
    if (typeof loop === 'string') {
      setErr(loop);
      return;
    }
    if (loop && !repoId) {
      setErr('a loop task needs a repo');
      return;
    }
    setBusy(true);
    setErr(null);
    let task: Task;
    try {
      task = await api.createTask({
        ...(loop ? { kind: 'loop' as const, ...loop } : {}),
        title: finalTitle,
        description: description || null,
        acceptance: acceptance.trim() || null,
        // a pick only means something in the repo it was made in
        checks: repoId ? checks : null,
        repoId: repoId || null,
        parentId: parentId || null,
        model: model || null,
        effort: (effort || null) as EffortLevel | null,
        category: category.trim() || null,
        review: reviewValueOf(review),
        // a hidden reviewer (review off for this task) is not filed
        reviewModel: (reviewOn && reviewModel) || null,
        reviewEffort: ((reviewOn && reviewEffort) || null) as EffortLevel | null,
        landing,
      });
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
      return;
    }
    // The row exists from here on: clear the fields before anything else can
    // fail, so a second Create cannot file the same task twice.
    repoTouched.current = false;
    if (repoId) {
      try {
        localStorage.setItem(LAST_REPO_KEY, repoId);
      } catch {
        /* private mode: the default just stays the filter's */
      }
    }
    setTitle('');
    setDescription('');
    setAcceptance('');
    setChecks(null);
    setTemplateId('');
    setParentId('');
    setModel('');
    setEffort('');
    setReview('default');
    setReviewModel('');
    setReviewEffort('');
    setLanding(null);
    setIsLoop(false);
    setLoopGoal('');
    setLoopMaxIt('');
    setLoopBudget('');
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

  const startRow = (
    <>
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
    </>
  );
  const createBtn = (
    <button className="btn primary" disabled={busy || !title.trim()} onClick={submit}>
      {effectiveStart === 'run' ? 'Create & run' : effectiveStart === 'queue' ? 'Create & queue' : 'Create'}
    </button>
  );
  // what the folded options hold, so a template's or preset's fill is not invisible
  const moreSummary = [
    category.trim(),
    isLoop && 'loop',
    parentId && 'grouped',
    model || 'auto model',
    effort || 'default effort',
    review !== 'default' && `review ${review}`,
    landing,
  ]
    .filter(Boolean)
    .join(' · ');

  const form = (
    <div className={`panel new-task-panel${mobile ? ' in-sheet' : ''}`} style={mobile ? undefined : { padding: 14, maxWidth: 640 }}>
      <div className="form-grid">
        {templates.length > 0 && (
          <div className="wide">
            <label className="label">Template</label>
            <div className="template-row">
              <button
                type="button"
                className={`btn pick-btn${!template ? ' on' : ''}`}
                aria-pressed={!template}
                onClick={() => pickTemplate(null)}
              >
                none
              </button>
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`btn pick-btn${template?.id === t.id ? ' on' : ''}`}
                  aria-pressed={template?.id === t.id}
                  title={[t.title && `title: ${t.title}`, t.preset && `preset: ${t.preset}`].filter(Boolean).join(' · ') || undefined}
                  onClick={() => pickTemplate(t)}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="wide">
          <label className="label">Title</label>
          <input
            className="field"
            autoFocus
            placeholder={template?.title.trim() ? `pattern: ${template.title.includes('{}') ? template.title : `${template.title.trim()} {}`}` : undefined}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          {template?.title.trim() && title.trim() && <div className="hint">Files as: {finalTitle}</div>}
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
              repoTouched.current = true;
              pickRepo(e.target.value);
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
        {mobile && (
          <button
            type="button"
            className="so-settings-toggle wide"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
          >
            <span className={`caret ${moreOpen ? '' : 'closed'}`}>
              <IconChevron />
            </span>
            <span className="label">More options</span>
            <span className="so-settings-sum mono">{moreSummary}</span>
          </button>
        )}
        {(!mobile || moreOpen) && (
          <>
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
              <label className="done-check" title="iterate on a goal in fresh agent sessions over a progress ledger until the checks are green and the goal is met (docs/loops.md)">
                <input type="checkbox" checked={isLoop} onChange={(e) => setIsLoop(e.target.checked)} /> Loop task — iterate
                toward a goal in fresh sessions
              </label>
            </div>
            {isLoop && (
              <LoopFields
                goal={loopGoal}
                maxIterations={loopMaxIt}
                budgetUsd={loopBudget}
                onGoal={setLoopGoal}
                onMaxIterations={setLoopMaxIt}
                onBudgetUsd={setLoopBudget}
              />
            )}
            <DoneFields
              repoId={repoId || null}
              acceptance={acceptance}
              checks={checks}
              onAcceptance={setAcceptance}
              onChecks={setChecks}
            />
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
            {/* a task made here is the human's own (source manual) — never external */}
            <LandingPicker value={landing} onChange={setLanding} repo={repos.find((r) => r.id === repoId)} external={false} />
          </>
        )}
        {!mobile && <div className="wide">{startRow}</div>}
      </div>
      {!mobile && (
        <>
          {err && <div className="warn-text" style={{ marginTop: 8 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            {createBtn}
            <button className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
  if (!mobile) return form;
  return (
    <>
      {opener}
      <FullSheet label="New task" title="New task" onClose={() => setOpen(false)}>
        {form}
        {/* On create + Create ride the bottom edge from anywhere in the form;
            the sheet's × is the cancel */}
        <div className="new-task-foot">
          {startRow}
          {!canStart && <div className="hint">Queue and Run now need a repo.</div>}
          {err && <div className="warn-text">{err}</div>}
          {createBtn}
        </div>
      </FullSheet>
    </>
  );
}

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

const PREFS_KEY = 'tm.board';
/** Terminal buckets start folded away — they are history, not work. */
const DEFAULT_COLLAPSED = HISTORY.map((s) => `status:${s}`);

const GROUP_BYS: GroupBy[] = ['status', 'category', 'repo', 'group'];

interface Prefs {
  sort: SortKey;
  focus: boolean;
  collapsed: string[];
  showAllDrafts: boolean;
  /* the search (docs/search.md) — kept across reloads (a phone reloads a
     home-screen app often); tokens naming something gone read as absent at
     render, see BoardPage */
  tokens: SearchToken[];
  text: string;
  groupBy: GroupBy;
}

const BASE_FILTERS: Pick<Prefs, 'tokens' | 'text' | 'groupBy'> = { tokens: [], text: '', groupBy: 'status' };

/**
 * The single-valued filters the board kept before the search (`repo`, `prov`,
 * `cat`, `group`, `dispatch`, each `'all'` when off) become tokens, so an
 * upgrade keeps what the board was narrowed to.
 */
function legacyTokens(p: Record<string, unknown>): SearchToken[] {
  const out: SearchToken[] = [];
  const take = (field: string, kind: SearchToken['kind']) => {
    const v = p[field];
    if (typeof v === 'string' && v && v !== 'all') out.push({ kind, value: v });
  };
  take('repo', 'repo');
  take('prov', 'source');
  take('cat', 'cat');
  take('group', 'group');
  take('dispatch', 'dispatch');
  return out;
}

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
    const p = JSON.parse(raw) as Partial<Prefs> & Record<string, unknown>;
    return {
      sort: SORTS.some((s) => s.key === p.sort) ? (p.sort as SortKey) : base.sort,
      focus: typeof p.focus === 'boolean' ? p.focus : base.focus,
      collapsed: Array.isArray(p.collapsed) ? p.collapsed.filter((c): c is string => typeof c === 'string') : base.collapsed,
      showAllDrafts: typeof p.showAllDrafts === 'boolean' ? p.showAllDrafts : base.showAllDrafts,
      tokens: Array.isArray(p.tokens) ? p.tokens.filter(isToken) : legacyTokens(p),
      text: typeof p.text === 'string' ? p.text : base.text,
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
  dim,
  collapsed,
  onToggle,
  action,
  children,
}: {
  label: string;
  count: number;
  accent?: boolean;
  /** the Hidden section: rows drawn dimmed (docs/design.md § Hidden tasks) */
  dim?: boolean;
  /** group colour for the header (`--tm-group`); absent = the neutral header */
  tint?: CSSProperties;
  collapsed: boolean;
  onToggle: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={dim ? 'section-dim' : undefined}>
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
  const { tasks, repos, runs, settings, refresh, dispatches, questions, features, loaded, connected } = useApp();
  // default ON so the board is coloured before /api/config answers, matching
  // DEFAULT_SETTINGS['board.groupColors']
  const groupColors = settings?.['board.groupColors'] ?? true;
  const repoName = (id: string | null) => repos.find((r) => r.id === id)?.name;
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const { sort, focus, showAllDrafts, groupBy, text: searchText } = prefs;
  const mobile = useIsMobile();
  const presets = useTaskPresets();
  const [searchOpen, setSearchOpen] = useState(false);
  // board multi-select (docs/inbox.md § Bulk actions); insertion order = tick order
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const toggleSelected = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const exitSelect = () => {
    setSelecting(false);
    setSelected([]);
  };
  // a deleted task leaves the selection
  useEffect(() => {
    setSelected((cur) => {
      const next = cur.filter((id) => tasks.some((t) => t.id === id));
      return next.length === cur.length ? cur : next;
    });
  }, [tasks]);
  const now = useNow();
  const setPref = <K extends keyof Prefs>(k: K, v: Prefs[K]) => setPrefs((p) => ({ ...p, [k]: v }));
  const setGroupBy = (v: GroupBy) => setPref('groupBy', v);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // storage blocked — preferences just stay per-session
    }
  }, [prefs]);

  const savedFolds = useMemo(() => new Set(prefs.collapsed), [prefs.collapsed]);

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

  const attention = useCallback(
    (t: Task) => t.status === 'running' && runs.some((r) => r.taskId === t.id && r.needsAttention && r.status === 'running'),
    [runs],
  );
  // the slice is the pending set (docs/questions.md)
  const asking = useMemo(() => new Set(questions.map((q) => q.taskId)), [questions]);

  // The search (docs/search.md). Dates are judged against the minute clock, so
  // "today" rolls over at midnight without a reload.
  const searchCtx = useMemo<SearchContext>(
    () => ({ tasks, repos, features, groups: groupIndex, dispatched: dispatchTouched, attention, asking, now: new Date(now) }),
    [tasks, repos, features, groupIndex, dispatchTouched, attention, asking, now],
  );
  const haystacks = useMemo(() => buildHaystacks(searchCtx), [searchCtx]);
  // A persisted token can outlive what it names (repo removed, group
  // dissolved, last dispatch pruned); it would silently empty the board
  // behind a chip naming nothing, so it reads as absent.
  const tokens = useMemo(() => prefs.tokens.filter((t) => tokenLive(t, searchCtx)), [prefs.tokens, searchCtx]);
  const searching = isSearching(tokens, searchText);
  // a phone narrowed to one repo does not need that repo's name on every row
  const repoTokens = tokens.filter((t) => t.kind === 'repo');
  const oneRepo = repoTokens.length === 1;
  // the repo a new task defaults to when the board is narrowed to one
  const filterRepoId = oneRepo && repoTokens[0].value !== 'none' ? repoTokens[0].value : null;
  const filtered = useMemo(() => {
    const match = compileQuery(tokens, searchText, searchCtx, haystacks);
    return tasks.filter(match);
  }, [tasks, tokens, searchText, searchCtx, haystacks]);
  const setSearch = (next: { tokens: SearchToken[]; text: string }) => setPrefs((p) => ({ ...p, ...next }));
  const openSearch = useCallback(() => setSearchOpen(true), []);
  // closing folds typed `key:value` words into chips — the committed form
  const closeSearch = () => {
    setSearchOpen(false);
    setPrefs((p) => ({ ...p, ...absorbTyped(p.tokens, p.text, searchCtx) }));
  };
  useSearchHotkey(openSearch, !searchOpen);
  /** A tree's group chip filters the board to that group, replacing any other group. */
  const filterToGroup = (id: string) =>
    setPrefs((p) => ({ ...p, tokens: [...p.tokens.filter((t) => t.kind !== 'group'), { kind: 'group', value: id }] }));
  // While searching every section and group block shows OPEN — a match folded
  // away is a match not found. Folding then is per-search and forgotten after.
  const [searchFolds, setSearchFolds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!searching) setSearchFolds(new Set());
  }, [searching]);
  const collapsed = searching ? searchFolds : savedFolds;
  const toggleFold = (id: string) => {
    const flip = (from: Iterable<string>) => {
      const next = new Set(from);
      if (!next.delete(id)) next.add(id);
      return next;
    };
    if (searching) setSearchFolds((prev) => flip(prev));
    else setPrefs((p) => ({ ...p, collapsed: [...flip(p.collapsed)] }));
  };

  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  // Hidden tasks (docs/design.md § Hidden tasks) leave every other section —
  // Active, Drafts, the groupings and Recent — for a dimmed one of their own.
  const visible = useMemo(() => filtered.filter((t) => !t.hiddenAt), [filtered]);
  // a ticked row a later search or filter hides stays selected, and the bar says so
  const filteredIds = useMemo(() => new Set(filtered.map((t) => t.id)), [filtered]);
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
        const list = visible.filter((t) => t.status === s);
        if (list.length) out.set(s, ordered(list));
      }
    } else if (groupBy === 'category') {
      for (const c of categories) {
        const list = visible.filter((t) => t.category === c);
        if (list.length) out.set(c, ordered(list));
      }
      const none = visible.filter((t) => !t.category);
      if (none.length) out.set('uncategorized', ordered(none));
    } else if (groupBy === 'group') {
      // One section per task tree, biggest first — the trees ARE the sections
      // here, so the in-panel group headers are suppressed below.
      // keyed by group id, not label: two groups may share a title, and the
      // key is also the fold-state id
      for (const g of [...namedGroups].sort((a, b) => b.size - a.size || a.label.localeCompare(b.label))) {
        const list = visible.filter((t) => t.groupId === g.id);
        if (list.length) out.set(g.id, ordered(list));
      }
      const single = visible.filter((t) => (groupIndex.get(t.groupId)?.size ?? 1) <= 1);
      if (single.length) out.set('ungrouped', ordered(single));
    } else {
      for (const r of repos) {
        const list = visible.filter((t) => t.repoId === r.id);
        if (list.length) out.set(r.name, ordered(list));
      }
      const none = visible.filter((t) => !t.repoId);
      if (none.length) out.set('no repo', ordered(none));
    }
    return out;
    // `ordered` closes over `sort` and `byPosition` — listing them is the honest dep
  }, [visible, groupBy, categories, repos, sort, byPosition, namedGroups, groupIndex]);

  // running first, then review; sorted inside each — never capped, active work
  // is exactly what must stay visible.
  const active = useMemo(
    () => ACTIVE.flatMap((s) => ordered(visible.filter((t) => t.status === s))),
    [visible, sort, byPosition],
  );

  // Drafts are the inbox — they sit right under the live work now, capped so a
  // long backlog cannot push the rest of the board off screen.
  const drafts = useMemo(
    () => ordered(visible.filter((t) => t.status === 'draft')),
    [visible, sort, byPosition],
  );

  const hiddenRows = useMemo(() => ordered(filtered.filter((t) => t.hiddenAt)), [filtered, sort, byPosition]);

  // "Recent" ignores the sort control on purpose: it is the by-definition
  // last-touched shortcut, and it now closes the page instead of opening it.
  // Flat by design — it is a lookup list, so no nesting and no group blocks.
  const recent = useMemo(
    () => [...visible].sort(byRecency('updatedAt')).slice(0, RECENT_LIMIT).map((task) => ({ task, depth: 0 })),
    [visible],
  );

  const sortField = SORTS.find((s) => s.key === sort)!.field;

  // Drag and drop (docs/grouping.md § Drag and drop). The server resolves the
  // drop; the WS broadcast and the refresh both land the result.
  // Refusals (a child leaving a blocked split parent…) go to the shared toast,
  // not a banner at the top of a board you may be scrolled far down.
  const onDrop = (moving: Task, zone: DropZone, targetId: string) => {
    const target = byId.get(targetId);
    // Reordering among roots is only visible in queue order — switch to it
    // rather than let the drop look like it did nothing.
    if ((zone === 'before' || zone === 'after') && target && !target.parentId && sort !== 'manual') {
      setPrefs((p) => ({ ...p, sort: 'manual' }));
    }
    // where it is now, read before the move: a drop is one gesture, so it gets an Undo
    const back = undoMove(tasks, moving);
    api
      .moveTask(moving.id, { place: zone, targetId })
      .then(() => {
        toastUndo('move', `Moved “${moving.title}”`, () => {
          api
            .moveTask(moving.id, back)
            .then(() => refresh())
            .catch((e) => toastError(e, 'Undo move'));
        });
        return refresh();
      })
      .catch((e) => toastError(e, 'Move'));
  };
  const { drag, gripProps, dropClass } = useTaskDrag(tasks, onDrop);

  const patchGroup = async (rootId: string, patch: { groupName?: string | null; groupColor?: number | null }) => {
    try {
      await api.updateTask(rootId, patch);
      await refresh();
    } catch (e) {
      toastError(e, 'Group edit');
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
    ctx: GroupBy | 'recent' | 'active' | 'drafts' | 'hidden',
    g: { label: string; size: number } | undefined,
    pendingOut: number,
  ) => {
    const repo = repoName(t.repoId);
    const all: [id: string, node: ReactNode][] = [];
    // a review row answers "ship it or fix it?" without being opened
    const verdict = verdictChip(t);
    if (verdict) {
      all.push([
        'verdict',
        <Explainable key="verdict" className={`chip verdict ${verdict.cls}`} explain={verdict} off={selecting}>
          {verdict.text}
        </Explainable>,
      ]);
    }
    if (t.status === 'review' && t.checkState === 'error') {
      all.push([
        'checkerror',
        <Explainable
          key="checkerror"
          className="chip verdict v-error"
          explain={{
            title: 'check error',
            what: 'A repo check could not run (a timeout or a spawn failure) — that is not a red.',
            todo: 'Look at the check output in the task panel.',
          }}
          off={selecting}
        >
          check error
        </Explainable>,
      ]);
    }
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
    // the landing tier (docs/design.md § Landing tiers): only the open work
    // that will land without a human says so; a landing that happened says
    // `auto-landed` instead
    const landing = effectiveLanding(t, repos.find((r) => r.id === t.repoId));
    if (t.autoLandedAt && (t.status === 'done' || t.status === 'published')) {
      all.push([
        'autolanded',
        <Explainable
          key="autolanded"
          className="chip chip-done"
          explain={{
            title: 'auto-landed',
            what: `Landed by the orchestrator (${landing === 'auto-publish' ? 'auto-publish' : 'on-green'}): checks green, review clean — no human click.${t.status === 'published' && landing !== 'auto-publish' ? ' The agent had already pushed it, so it landed published.' : ''}`,
          }}
          off={selecting}
        >
          auto-landed
        </Explainable>,
      ]);
    } else if (t.shippedSha && (t.status === 'review' || t.status === 'done')) {
      // observed publish (docs/publish.md § Observed publish)
      all.push([
        'pushed',
        <Explainable
          key="pushed"
          className="chip chip-published"
          explain={{
            title: 'pushed',
            what: `The agent already pushed this task's commits (${t.shippedSha.slice(0, 8)} is on the remote). Mark published records it — nothing new is pushed.`,
          }}
          off={selecting}
        >
          pushed
        </Explainable>,
      ]);
    } else if (landing !== 'supervised' && t.status !== 'done' && t.status !== 'published' && t.status !== 'cancelled') {
      all.push([
        'landing',
        <Explainable
          key="landing"
          className={`chip ${landing === 'auto-publish' ? 'chip-published' : 'chip-done'}`}
          explain={{
            title: landing,
            what:
              landing === 'auto-publish'
                ? 'Commits and pushes on its own once the checks are green and the review is clean.'
                : 'Moves to done on its own once the checks are green and the review is clean.',
          }}
          off={selecting}
        >
          {landing}
        </Explainable>,
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
    if (repo && ctx !== 'repo' && !(mobile && oneRepo)) {
      all.push(['repo', <span key="repo" className="chip">{repo}</span>]);
    }
    // loop task (docs/loops.md): iteration counter + the check metric's sparkline
    if (t.kind === 'loop') all.push(['loop', <LoopChip key="loop" task={t} />]);
    // the task's cost so far (worker turns + its reviews/compactions)
    if (t.costUsd >= 0.01) all.push(['cost', <TaskCostChip key="cost" costUsd={t.costUsd} />]);
    // a re-attempt (Retry / Run now / a fresh follow-up) is worth a glance
    if (t.attempts >= 2) all.push(['attempts', <TaskAttemptsChip key="attempts" attempts={t.attempts} quiet />]);
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
  const row = (t: Task, ctx: GroupBy | 'recent' | 'active' | 'drafts' | 'hidden', depth = 0) => {
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
        // `recent` is a flat lookup list — nothing to drop beside or into there;
        // while selecting, a press ticks the row, so nothing drags either
        grip={ctx === 'recent' || selecting ? undefined : gripProps(t)}
        dropClass={ctx === 'recent' || selecting ? undefined : dropClass(t.id, 'task')}
        select={selecting ? { on: selected.includes(t.id), toggle: () => toggleSelected(t.id) } : undefined}
        progress
      >
        {!focus && rowChips(t, ctx, g, pendingOut)}
        <StatusBadge
          status={t.status}
          attention={attention(t)}
          question={asking.has(t.id)}
          reviewState={t.reviewState}
          checkState={t.checkState}
          loopState={t.loopState}
          paused={!!t.pausedTurn}
          explain={!selecting}
          onOpenReviewer={(() => {
            const rv = liveReviewRun(runs, t.id);
            return rv ? () => onOpenTerminal(rv.id) : undefined;
          })()}
        />
        <ProgressPct task={t} />
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
  const renderRows = (rows: Row[], ctx: GroupBy | 'recent' | 'active' | 'drafts' | 'hidden', heads = true) =>
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
            onFilter={() => filterToGroup(g.id)}
            onRename={(groupName) => patchGroup(g.id, { groupName })}
            onColor={(groupColor) => patchGroup(g.id, { groupColor }).catch(() => {})}
          />
          {!folded && <div className="task-group-rows">{b.rows.map((r) => row(r.task, ctx, r.depth))}</div>}
        </div>
      );
    });

  // a search shows every match: a capped strip would hide some of them
  const draftsShown = showAllDrafts || searching ? drafts : drafts.slice(0, DRAFT_LIMIT);

  // The view controls, written once: the search panel's foot on a desktop,
  // its View section on a phone (docs/search.md).
  const groupBySelect = (
    <select className="field" aria-label="Group by" value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
      <option value="status">group: status</option>
      <option value="category">group: category</option>
      <option value="repo">group: repo</option>
      <option value="group">group: task group</option>
    </select>
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
  const viewControls = (
    <>
      {groupBySelect}
      {sortSelect}
      {mobile && (
        <div className="sheet-field-row">
          <span className="muted">Rows</span>
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
      )}
    </>
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

  // What the closed search narrows by stays on screen as chips; a grouping
  // other than the default is one too, since its control is behind the search.
  const viewChips: { id: string; label: string; clear: () => void }[] = [];
  if (groupBy !== 'status') {
    viewChips.push({
      id: 'groupBy',
      label: `group: ${groupBy === 'group' ? 'task group' : groupBy}`,
      clear: () => setGroupBy('status'),
    });
  }
  const canReset = prefs.tokens.length > 0 || searchText !== '' || groupBy !== 'status';
  const resetFilters = () => setPrefs((p) => ({ ...p, ...BASE_FILTERS }));
  const trigger = (
    <SearchTrigger
      tokens={tokens}
      text={searchText}
      ctx={searchCtx}
      mobile={mobile}
      expanded={searchOpen}
      onOpen={openSearch}
    />
  );
  const chips = (
    <SearchChips
      tokens={tokens}
      text={searchText}
      ctx={searchCtx}
      extra={viewChips}
      shown={filtered.length}
      total={tasks.length}
      onChange={setSearch}
    />
  );

  const selectToggle = (
    <button
      type="button"
      className={`btn ghost select-toggle${selecting ? ' on' : ''}`}
      aria-pressed={selecting}
      title="Select several tasks and act on them at once"
      onClick={() => (selecting ? exitSelect() : setSelecting(true))}
    >
      {selecting ? 'Selecting' : 'Select'}
    </button>
  );

  return (
    <div className="board">
      {mobile ? (
        <>
          {/* Glass gives the phone board a large title like every other page; Classic hides it */}
          <h1 className="page-title glass-only">Board</h1>
          <div className="board-toolbar">
            {trigger}
            {selectToggle}
            <NewTaskForm onCreated={refresh} mobile filterRepoId={filterRepoId} />
          </div>
          {chips}
        </>
      ) : (
        <>
          <h1 className="page-title">
            Board
            <span style={{ flex: 1 }} />
            {trigger}
            {selectToggle}
            {focusToggle}
          </h1>
          {chips}
        </>
      )}
      {selecting && (
        <BulkBar
          ids={selected}
          hidden={selected.filter((id) => !filteredIds.has(id)).length}
          tasks={tasks}
          onSettled={setSelected}
          onExit={exitSelect}
        />
      )}
      {searchOpen && (
        <SearchPanel
          tokens={tokens}
          text={searchText}
          ctx={searchCtx}
          hay={haystacks}
          mobile={mobile}
          shown={filtered.length}
          total={tasks.length}
          view={viewControls}
          canReset={canReset}
          onReset={resetFilters}
          onChange={setSearch}
          onClose={closeSearch}
          onOpenTask={onOpenTask}
        />
      )}
      {!mobile && <NewTaskForm onCreated={refresh} filterRepoId={filterRepoId} />}
      <DragGhost drag={drag} tasks={tasks} />
      {/* An empty list before the first successful load means "never heard
          from the server", not "no tasks" (docs/mobile.md § Server offline). */}
      {tasks.length === 0 && !loaded && (
        <div className="empty panel" style={{ marginTop: 20 }}>
          <div className="big">{connected ? 'Loading…' : "Can't reach the server"}</div>
          {connected ? null : 'Tasks will appear once it answers — retrying.'}
        </div>
      )}
      {tasks.length === 0 && loaded && (
        <div className="empty panel" style={{ marginTop: 20 }}>
          <div className="big">No tasks yet</div>
          Add a repo, then create your first task.
        </div>
      )}
      {filtered.length === 0 && tasks.length > 0 && (
        <div className="empty panel" style={{ marginTop: 20 }}>
          <div className="big">Nothing matches</div>
          <button className="btn" onClick={resetFilters}>
            Clear the search
          </button>
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
            drafts.length > DRAFT_LIMIT &&
            !searching && (
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
        if (focus && !searching && groupBy === 'status' && (HISTORY as string[]).includes(label)) return null;
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
      {/* parked out of the way: last, dimmed, and dropped in essentials mode */}
      {(!focus || searching) && hiddenRows.length > 0 && (
        <Section label="Hidden" count={hiddenRows.length} dim collapsed={collapsed.has('hidden')} onToggle={() => toggleFold('hidden')}>
          <div className="panel">{renderRows(hiddenRows, 'hidden')}</div>
        </Section>
      )}
      {/* a lookup list — while searching the sections above ARE the lookup */}
      {!focus && !searching && recent.length > 0 && (
        <Section label="Recent" count={recent.length} collapsed={collapsed.has('recent')} onToggle={() => toggleFold('recent')}>
          <div className="panel">{recent.map((r) => row(r.task, 'recent'))}</div>
        </Section>
      )}
    </div>
  );
}
