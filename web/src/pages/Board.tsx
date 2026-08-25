import { useMemo, useState } from 'react';
import { EFFORT_LEVELS, MODEL_OPTIONS, type EffortLevel, type Task, type TaskStatus } from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { TaskRow } from '../components/TaskRow.tsx';

const ORDER: TaskStatus[] = ['running', 'queued', 'blocked', 'review', 'draft', 'failed', 'done', 'cancelled'];

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

const provenanceOf = (t: Task): Exclude<Provenance, 'all'> => {
  // feature wins over agent: a feature-generated task is the plan's, not a
  // worker's follow-up (its children keep featureId but are still 'agent').
  if (t.source === 'feature') return 'feature';
  if (t.createdByRun) return 'agent';
  if (t.source === 'sentry') return 'sentry';
  if (t.source === 'auto') return 'analyze';
  return 'human';
};

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

  const groups = useMemo(() => {
    const out = new Map<string, Task[]>();
    if (groupBy === 'status') {
      for (const s of ORDER) {
        const list = filtered.filter((t) => t.status === s);
        if (list.length) out.set(s, withChildren(list));
      }
    } else if (groupBy === 'category') {
      for (const c of categories) {
        const list = filtered.filter((t) => t.category === c);
        if (list.length) out.set(c, withChildren(list));
      }
      const none = filtered.filter((t) => !t.category);
      if (none.length) out.set('uncategorized', withChildren(none));
    } else {
      for (const r of repos) {
        const list = filtered.filter((t) => t.repoId === r.id);
        if (list.length) out.set(r.name, withChildren(list));
      }
      const none = filtered.filter((t) => !t.repoId);
      if (none.length) out.set('no repo', withChildren(none));
    }
    return out;
  }, [filtered, groupBy, categories, repos]);

  const attention = (t: Task) =>
    t.status === 'running' && runs.some((r) => r.taskId === t.id && r.needsAttention && r.status === 'running');

  return (
    <div>
      <h1 className="page-title">
        Board
        <span style={{ flex: 1 }} />
        <select className="field" style={{ width: 150 }} value={filterRepo} onChange={(e) => setFilterRepo(e.target.value)}>
          <option value="all">all repos</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <select className="field" style={{ width: 135 }} value={filterProv} onChange={(e) => setFilterProv(e.target.value as Provenance)}>
          <option value="all">all sources</option>
          <option value="human">human</option>
          <option value="agent">agent</option>
          <option value="sentry">sentry</option>
          <option value="analyze">analyze</option>
          <option value="feature">feature</option>
        </select>
        <select className="field" style={{ width: 160 }} value={filterCat} onChange={(e) => setFilterCat(e.target.value)}>
          <option value="all">all categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          <option value="none">uncategorized</option>
        </select>
        <select className="field" style={{ width: 165 }} value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
          <option value="status">group: status</option>
          <option value="category">group: category</option>
          <option value="repo">group: repo</option>
        </select>
      </h1>
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
      {[...groups.entries()].map(([label, list]) => (
        <div key={label}>
          <div className="section-head">
            {label} <span className="count">{list.length}</span>
          </div>
          <div className="panel">
            {list.map((t) => (
              <TaskRow key={t.id} task={t} onOpenTask={onOpenTask} onOpenTerminal={onOpenTerminal}>
                {t.category && groupBy !== 'category' && (
                  <span className="chip" style={{ color: 'var(--tm-accent)' }}>{t.category}</span>
                )}
                {t.featureId && (
                  <span className="chip" style={{ color: 'var(--tm-accent)' }} title={`feature phase ${(t.featurePhase ?? 0) + 1}`}>
                    feat p{(t.featurePhase ?? 0) + 1}
                  </span>
                )}
                {t.createdByRun && <span className="chip" title="filed by an agent session">agent</span>}
                {t.source !== 'manual' && t.source !== 'feature' && !t.createdByRun && <span className="chip">{t.source}</span>}
                {repoName(t.repoId) && groupBy !== 'repo' && <span className="chip">{repoName(t.repoId)}</span>}
                <StatusBadge status={t.status} attention={attention(t)} />
              </TaskRow>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
