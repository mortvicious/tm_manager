import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { EFFORT_LEVELS, MODEL_OPTIONS, type EffortLevel, type Task, type TaskStatus } from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { IconChevron } from '../components/Icons.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { TaskRow } from '../components/TaskRow.tsx';
import { TimeAgo, isNew, useNow } from '../components/TimeAgo.tsx';

const ORDER: TaskStatus[] = ['running', 'queued', 'blocked', 'review', 'draft', 'failed', 'done', 'cancelled'];

/** The "Active" strip: work that is either being done right now or waiting on the human. */
const ACTIVE: TaskStatus[] = ['running', 'review'];

/** Drafts pile up faster than anything else — show a few, rest behind a toggle. */
const DRAFT_LIMIT = 7;
/** "Recent" is a shortcut to whatever was touched last, whatever its status. */
const RECENT_LIMIT = 10;

const byRecency = (key: 'createdAt' | 'updatedAt') => (a: Task, b: Task) => {
  const d = b[key].localeCompare(a[key]);
  // ISO timestamps collide on same-transaction writes; id keeps the order stable.
  return d !== 0 ? d : b.id.localeCompare(a.id);
};

function NewTaskForm({ onCreated }: { onCreated: () => void }) {
  const { repos } = useApp();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [repoId, setRepoId] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [category, setCategory] = useState('');
  const [review, setReview] = useState<'default' | 'on' | 'off'>('default');
  const [err, setErr] = useState<string | null>(null);
  const { tasks } = useApp();
  const knownCategories = [...new Set(tasks.map((t) => t.category).filter(Boolean))] as string[];

  if (!open) {
    return (
      <button className="btn primary" onClick={() => setOpen(true)}>
        + New task
      </button>
    );
  }

  const submit = async () => {
    setErr(null);
    try {
      await api.createTask({
        title,
        description: description || null,
        repoId: repoId || null,
        model: model || null,
        effort: (effort || null) as EffortLevel | null,
        category: category.trim() || null,
        review: review === 'default' ? null : review === 'on',
      });
      setTitle('');
      setDescription('');
      setModel('');
      setEffort('');
      setReview('default');
      setOpen(false);
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="panel" style={{ padding: 14, maxWidth: 640 }}>
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
        <div>
          <label className="label">Model override</label>
          <select className="field mono" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">auto (router)</option>
            {MODEL_OPTIONS.map((m) => (
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
          <select className="field" value={review} onChange={(e) => setReview(e.target.value as 'default' | 'on' | 'off')}>
            <option value="default">default (config)</option>
            <option value="on">review this</option>
            <option value="off">skip (small task)</option>
          </select>
        </div>
      </div>
      {err && <div className="warn-text" style={{ marginTop: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn primary" disabled={!title.trim()} onClick={submit}>
          Create
        </button>
        <button className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

type Provenance = 'all' | 'human' | 'agent' | 'sentry' | 'analyze' | 'feature';
type GroupBy = 'status' | 'category' | 'repo';
type SortKey = 'updated' | 'created' | 'oldest' | 'title';

const SORTS: { key: SortKey; label: string; field: 'createdAt' | 'updatedAt' }[] = [
  { key: 'updated', label: 'sort: last touched', field: 'updatedAt' },
  { key: 'created', label: 'sort: newest filed', field: 'createdAt' },
  { key: 'oldest', label: 'sort: oldest filed', field: 'createdAt' },
  { key: 'title', label: 'sort: title A–Z', field: 'updatedAt' },
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
const DEFAULT_COLLAPSED = ['status:done', 'status:cancelled'];

interface Prefs {
  sort: SortKey;
  focus: boolean;
  collapsed: string[];
  showAllDrafts: boolean;
}

const loadPrefs = (): Prefs => {
  const base: Prefs = { sort: 'updated', focus: false, collapsed: DEFAULT_COLLAPSED, showAllDrafts: false };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return base;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      sort: SORTS.some((s) => s.key === p.sort) ? (p.sort as SortKey) : base.sort,
      focus: typeof p.focus === 'boolean' ? p.focus : base.focus,
      collapsed: Array.isArray(p.collapsed) ? p.collapsed.filter((c): c is string => typeof c === 'string') : base.collapsed,
      showAllDrafts: typeof p.showAllDrafts === 'boolean' ? p.showAllDrafts : base.showAllDrafts,
    };
  } catch {
    // corrupt JSON or storage blocked (private mode) — the board still works
    return base;
  }
};

/**
 * A titled strip of rows that can be folded away. The header is the control:
 * the whole label is the toggle, `action` sits outside it (its own button).
 */
function Section({
  label,
  count,
  accent,
  collapsed,
  onToggle,
  action,
  children,
}: {
  label: string;
  count: number;
  accent?: boolean;
  collapsed: boolean;
  onToggle: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className={`section-head ${accent ? 'accent' : ''}`}>
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
  const { tasks, repos, runs, refresh } = useApp();
  const repoName = (id: string | null) => repos.find((r) => r.id === id)?.name;
  const [filterRepo, setFilterRepo] = useState('all');
  const [filterProv, setFilterProv] = useState<Provenance>('all');
  const [filterCat, setFilterCat] = useState('all');
  const [groupBy, setGroupBy] = useState<GroupBy>('status');
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const { sort, focus, showAllDrafts } = prefs;
  const now = useNow();

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

  const filtered = useMemo(
    () =>
      tasks.filter(
        (t) =>
          (filterRepo === 'all' || t.repoId === filterRepo) &&
          (filterProv === 'all' || provenanceOf(t) === filterProv) &&
          (filterCat === 'all' || (filterCat === 'none' ? !t.category : t.category === filterCat)),
      ),
    [tasks, filterRepo, filterProv, filterCat],
  );

  // children right under their parent within each group
  const withChildren = (list: Task[]): Task[] => {
    const roots = list.filter((t) => !t.parentId || !list.some((x) => x.id === t.parentId));
    const out: Task[] = [];
    for (const r of roots) {
      out.push(r);
      out.push(...list.filter((t) => t.parentId === r.id));
    }
    return out;
  };

  // every list on the page obeys the sort control, so "where new / where old"
  // is one decision the user makes once rather than a per-section rule.
  const ordered = (list: Task[]) => withChildren([...list].sort(comparator(sort)));

  const groups = useMemo(() => {
    const out = new Map<string, Task[]>();
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
    } else {
      for (const r of repos) {
        const list = filtered.filter((t) => t.repoId === r.id);
        if (list.length) out.set(r.name, ordered(list));
      }
      const none = filtered.filter((t) => !t.repoId);
      if (none.length) out.set('no repo', ordered(none));
    }
    return out;
    // `ordered` closes over `sort` and nothing else — listing it is the honest dep
  }, [filtered, groupBy, categories, repos, sort]);

  // running first, then review; sorted inside each — never capped, active work
  // is exactly what must stay visible.
  const active = useMemo(
    () => ACTIVE.flatMap((s) => ordered(filtered.filter((t) => t.status === s))),
    [filtered, sort],
  );

  // Drafts are the inbox — they sit right under the live work now, capped so a
  // long backlog cannot push the rest of the board off screen.
  const drafts = useMemo(
    () => ordered(filtered.filter((t) => t.status === 'draft')),
    [filtered, sort],
  );

  // "Recent" ignores the sort control on purpose: it is the by-definition
  // last-touched shortcut, and it now closes the page instead of opening it.
  const recent = useMemo(() => [...filtered].sort(byRecency('updatedAt')).slice(0, RECENT_LIMIT), [filtered]);

  const attention = (t: Task) =>
    t.status === 'running' && runs.some((r) => r.taskId === t.id && r.needsAttention && r.status === 'running');

  const sortField = SORTS.find((s) => s.key === sort)!.field;

  // one row, shared by the strips and the grouped lists below them
  const row = (t: Task, ctx: GroupBy | 'recent' | 'active' | 'drafts') => {
    // drafts never ran, so their created time is the honest one; recent is a
    // last-touched list; everywhere else the age matches the active sort.
    const field = ctx === 'drafts' ? 'createdAt' : ctx === 'recent' ? 'updatedAt' : sortField;
    const fresh = isNew(t.createdAt, now);
    return (
      <TaskRow key={t.id} task={t} onOpenTask={onOpenTask} onOpenTerminal={onOpenTerminal} fresh={fresh}>
        {!focus && (
          <>
            {t.category && ctx !== 'category' && (
              <span className="chip" style={{ color: 'var(--tm-accent)' }}>{t.category}</span>
            )}
            {t.featureId && (
              <span className="chip" style={{ color: 'var(--tm-accent)' }} title={`feature phase ${(t.featurePhase ?? 0) + 1}`}>
                feat p{(t.featurePhase ?? 0) + 1}
              </span>
            )}
            {t.createdByRun && <span className="chip" title="filed by an agent session">agent</span>}
            {t.source !== 'manual' && t.source !== 'feature' && !t.createdByRun && <span className="chip">{t.source}</span>}
            {repoName(t.repoId) && ctx !== 'repo' && <span className="chip">{repoName(t.repoId)}</span>}
          </>
        )}
        <StatusBadge status={t.status} attention={attention(t)} />
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
    );
  };

  const draftsShown = showAllDrafts ? drafts : drafts.slice(0, DRAFT_LIMIT);

  return (
    <div>
      <h1 className="page-title">
        Board
        <span style={{ flex: 1 }} />
        <button
          className={`btn ${focus ? 'primary' : ''}`}
          aria-pressed={focus}
          title={focus ? 'Show tags, ages and the recent strip again' : 'Essentials only — titles and status, no tags or history'}
          onClick={() => setPrefs((p) => ({ ...p, focus: !p.focus }))}
        >
          {focus ? 'full view' : 'essentials'}
        </button>
      </h1>
      <div className="board-bar">
        <select className="field" value={filterRepo} onChange={(e) => setFilterRepo(e.target.value)}>
          <option value="all">all repos</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <select className="field" value={filterProv} onChange={(e) => setFilterProv(e.target.value as Provenance)}>
          <option value="all">all sources</option>
          <option value="human">human</option>
          <option value="agent">agent</option>
          <option value="sentry">sentry</option>
          <option value="analyze">analyze</option>
          <option value="feature">feature</option>
        </select>
        <select className="field" value={filterCat} onChange={(e) => setFilterCat(e.target.value)}>
          <option value="all">all categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          <option value="none">uncategorized</option>
        </select>
        <select className="field" value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
          <option value="status">group: status</option>
          <option value="category">group: category</option>
          <option value="repo">group: repo</option>
        </select>
        <select className="field" value={sort} onChange={(e) => setPrefs((p) => ({ ...p, sort: e.target.value as SortKey }))}>
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <NewTaskForm onCreated={refresh} />
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
        <Section label="active" count={active.length} accent collapsed={collapsed.has('active')} onToggle={() => toggleFold('active')}>
          <div className="panel">{active.map((t) => row(t, 'active'))}</div>
        </Section>
      )}
      {drafts.length > 0 && (
        <Section
          label="drafts"
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
          <div className="panel">{draftsShown.map((t) => row(t, 'drafts'))}</div>
        </Section>
      )}
      {[...groups.entries()].map(([label, list]) => {
        // Under group: status the strips above ARE the running/review/draft
        // buckets — repeating them verbatim right below would be pure noise.
        // Under the other groupings a task can legitimately appear twice: once
        // pinned at the top, once inside its category/repo.
        if (groupBy === 'status' && ((ACTIVE as string[]).includes(label) || label === 'draft')) return null;
        // essentials mode drops finished history entirely
        if (focus && groupBy === 'status' && (label === 'done' || label === 'cancelled')) return null;
        const id = `${groupBy}:${label}`;
        return (
          <Section key={id} label={label} count={list.length} collapsed={collapsed.has(id)} onToggle={() => toggleFold(id)}>
            <div className="panel">{list.map((t) => row(t, groupBy))}</div>
          </Section>
        );
      })}
      {!focus && recent.length > 0 && (
        <Section label="recent" count={recent.length} collapsed={collapsed.has('recent')} onToggle={() => toggleFold('recent')}>
          <div className="panel">{recent.map((t) => row(t, 'recent'))}</div>
        </Section>
      )}
    </div>
  );
}
