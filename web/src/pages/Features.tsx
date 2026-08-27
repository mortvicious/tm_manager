import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { FeatureBadge } from '../components/FeatureBadge.tsx';

/**
 * Features list + intake. A Feature is the home for a request too big to be one
 * task: write it here, let the analysis decompose it, approve the plan on the
 * feature page (docs/features.md).
 */
function NewFeatureForm({ onCreated }: { onCreated: (id: string) => void }) {
  const { repos } = useApp();
  const [open, setOpen] = useState(false);
  const [repoId, setRepoId] = useState('');
  const [title, setTitle] = useState('');
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) {
    return (
      <button className="btn primary" disabled={repos.length === 0} onClick={() => setOpen(true)}>
        + New feature
      </button>
    );
  }

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const f = await api.createFeature({ repoId: repoId || repos[0].id, title, request });
      setTitle('');
      setRequest('');
      setOpen(false);
      onCreated(f.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" style={{ padding: 14, maxWidth: 820 }}>
      <div className="form-grid">
        <div>
          <label className="label">Repo</label>
          <select className="field" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.role ? ` (${r.role})` : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Title</label>
          <input
            className="field"
            autoFocus
            placeholder="Per-run worker containers"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="wide">
          <label className="label">The request (markdown — a paragraph to a page)</label>
          <textarea
            className="field"
            rows={10}
            placeholder="Describe the whole capability you want. The analysis reads the repo and decomposes it into ordered phases of tasks; you approve the plan before anything runs."
            value={request}
            onChange={(e) => setRequest(e.target.value)}
          />
        </div>
      </div>
      {err && (
        <div className="warn-text" style={{ marginTop: 8 }}>
          {err}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn primary" disabled={busy || !title.trim() || !request.trim()} onClick={submit}>
          {busy ? 'Creating…' : 'Create feature'}
        </button>
        <button className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function FeaturesPage() {
  const { features, repos, tasks, refresh } = useApp();
  const [filterRepo, setFilterRepo] = useState('all');
  const repoName = (id: string | null) => repos.find((r) => r.id === id)?.name ?? '—';

  const rows = useMemo(
    () => features.filter((f) => filterRepo === 'all' || f.repoId === filterRepo),
    [features, filterRepo],
  );

  const counts = (featureId: string) => {
    const list = tasks.filter((t) => t.featureId === featureId);
    const done = list.filter((t) => ['published', 'done', 'cancelled'].includes(t.status)).length;
    return { total: list.length, done };
  };

  return (
    <div>
      <h1 className="page-title">
        Features
        <span style={{ flex: 1 }} />
        <select className="field" style={{ width: 160 }} value={filterRepo} onChange={(e) => setFilterRepo(e.target.value)}>
          <option value="all">all repos</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </h1>

      <NewFeatureForm onCreated={() => refresh()} />

      {repos.length === 0 && (
        <div className="empty panel" style={{ marginTop: 20 }}>
          <div className="big">No repos registered</div>
          A feature belongs to one repo — add a repo first.
        </div>
      )}

      {repos.length > 0 && rows.length === 0 && (
        <div className="empty panel" style={{ marginTop: 20 }}>
          <div className="big">No features yet</div>
          Write a big request here instead of squeezing it into one task.
        </div>
      )}

      {rows.length > 0 && (
        <div className="panel" style={{ marginTop: 20 }}>
          <table className="tbl stack-tbl">
            <thead>
              <tr>
                <th>Feature</th>
                <th>Repo</th>
                <th>Status</th>
                <th>Phases</th>
                <th>Tasks</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => {
                const c = counts(f.id);
                return (
                  <tr key={f.id}>
                    <td data-label="Feature" style={{ fontWeight: 600 }}>
                      <Link to={`/features/${f.id}`}>{f.title}</Link>
                    </td>
                    <td className="muted" data-label="Repo">
                      {repoName(f.repoId)}
                    </td>
                    <td data-label="Status">
                      <FeatureBadge status={f.status} />
                    </td>
                    <td className="mono" data-label="Phases">
                      {f.analysis?.phases.length ?? '—'}
                    </td>
                    <td className="mono" data-label="Tasks">
                      {c.total ? `${c.done}/${c.total}` : '—'}
                    </td>
                    <td className="muted mono" data-label="Updated" style={{ fontSize: 'var(--tm-text-xs)' }}>
                      {new Date(f.updatedAt).toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
