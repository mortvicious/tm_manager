import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { IconAnalyze } from '../components/Icons.tsx';

type Git = { isRepo: boolean; branch: string | null; dirty: number; ahead: number };

function GitCell({ repoId }: { repoId: string }) {
  const [git, setGit] = useState<Git | null>(null);
  const [busy, setBusy] = useState<'commit' | 'push' | null>(null);
  const [msg, setMsg] = useState<{ text: string; err: boolean } | null>(null);
  const refresh = () => api.gitStatus(repoId).then(setGit).catch(() => setGit({ isRepo: false, branch: null, dirty: 0, ahead: 0 }));
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId]);
  if (!git) return <span className="muted mono">…</span>;
  if (!git.isRepo) return <span className="muted mono">not a git repo</span>;
  const commit = async () => {
    setBusy('commit');
    setMsg(null);
    try {
      const r = await api.gitCommit(repoId);
      setMsg({ text: r.message.split('\n')[0], err: false });
      await refresh();
    } catch (e) {
      setMsg({ text: (e as Error).message, err: true });
    } finally {
      setBusy(null);
    }
  };
  const push = async () => {
    setBusy('push');
    setMsg(null);
    try {
      await api.gitPush(repoId);
      setMsg({ text: 'pushed', err: false });
      await refresh();
    } catch (e) {
      setMsg({ text: (e as Error).message, err: true });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
        <span className="chip">{git.branch}</span>
        {git.dirty > 0 && <span className="chip" style={{ color: 'var(--tm-status-review)' }}>{git.dirty} changed</span>}
        {git.ahead > 0 && <span className="chip" style={{ color: 'var(--tm-accent)' }}>↑{git.ahead}</span>}
        <button className="btn" disabled={busy !== null || git.dirty === 0} onClick={commit} title="git add -A + commit (message written by Opus 5)">
          {busy === 'commit' ? 'Committing…' : 'Commit'}
        </button>
        <button className="btn" disabled={busy !== null || git.ahead === 0} onClick={push} title="git push">
          {busy === 'push' ? 'Pushing…' : 'Push'}
        </button>
      </span>
      {msg && (
        <span className={msg.err ? 'warn-text' : 'muted'} style={{ fontSize: 'var(--tm-text-xs)', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {msg.text}
        </span>
      )}
    </div>
  );
}

/** Inline per-repo preview URL (what the mobile emulator frames). Saves on
 *  blur/Enter; the server normalises "localhost:5173" and rejects non-http. */
function PreviewCell({ repoId, value, onSaved }: { repoId: string; value: string | null; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState(value ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A refresh elsewhere (or another tab) may change the stored value.
  useEffect(() => {
    setDraft(value ?? '');
  }, [value]);
  const save = async () => {
    if (draft.trim() === (value ?? '')) return;
    setBusy(true);
    setErr(null);
    try {
      // Show what was STORED, not what was typed — the server normalises
      // "localhost:5173" into a full URL.
      const saved = await api.updateRepo(repoId, { previewUrl: draft.trim() || null });
      setDraft(saved.previewUrl ?? '');
      await onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 190 }}>
      <input
        className="field mono"
        style={{ fontSize: 'var(--tm-text-xs)', padding: '5px 8px' }}
        placeholder="localhost:5173"
        value={draft}
        disabled={busy}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setDraft(value ?? '');
        }}
      />
      {err && (
        <span className="warn-text" style={{ fontSize: 'var(--tm-text-xs)' }}>
          {err}
        </span>
      )}
    </div>
  );
}

export function ReposPage() {
  const { repos, tasks, refresh } = useApp();
  const [path, setPath] = useState('');
  const [role, setRole] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState<string | null>(null);

  const add = async () => {
    setErr(null);
    try {
      await api.createRepo({ path, role: role || null, previewUrl: previewUrl || null });
      setPath('');
      setRole('');
      setPreviewUrl('');
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const del = async (id: string) => {
    if (!confirm('Remove this repo? Its tasks keep existing without a repo.')) return;
    setErr(null);
    try {
      await api.deleteRepo(id);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const analyze = async (id: string) => {
    setErr(null);
    setAnalyzing(id);
    try {
      await api.analyze({ repoId: id });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setAnalyzing(null);
    }
  };

  const count = (id: string) => tasks.filter((t) => t.repoId === id).length;

  return (
    <div>
      <h1 className="page-title">Repos</h1>
      <div className="panel" style={{ padding: 14, maxWidth: 720, marginBottom: 18 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.2fr auto', gap: 10, alignItems: 'end' }}>
          <div>
            <label className="label">Local path</label>
            <input
              className="field mono"
              placeholder="~/Development/3 - neko-nest"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Role / note</label>
            <input
              className="field"
              placeholder="backend"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Dev URL (emulator)</label>
            <input
              className="field mono"
              placeholder="localhost:5173"
              value={previewUrl}
              spellCheck={false}
              onChange={(e) => setPreviewUrl(e.target.value)}
            />
          </div>
          <button className="btn primary" disabled={!path.trim()} onClick={add}>
            Add repo
          </button>
        </div>
        {err && <div className="warn-text" style={{ marginTop: 8 }}>{err}</div>}
      </div>

      {repos.length === 0 ? (
        <div className="empty panel">
          <div className="big">No repos registered</div>
          Add local project paths so tasks know where agents should run.
        </div>
      ) : (
        <div className="panel">
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Path</th>
                <th>Role</th>
                <th title="Dev-server URL framed by the mobile emulator">Dev URL</th>
                <th>Tasks</th>
                <th>Git</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {repos.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600 }}>{r.name}</td>
                  <td className="mono muted">{r.path.replace(/^\/Users\/[^/]+/, '~')}</td>
                  <td>{r.role ? <span className="chip">{r.role}</span> : <span className="muted">—</span>}</td>
                  <td>
                    <PreviewCell repoId={r.id} value={r.previewUrl} onSaved={refresh} />
                  </td>
                  <td className="mono">{count(r.id)}</td>
                  <td>
                    <GitCell repoId={r.id} />
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn" disabled={analyzing === r.id} onClick={() => analyze(r.id)}>
                      <IconAnalyze /> {analyzing === r.id ? 'Starting…' : 'Analyze'}
                    </button>{' '}
                    <button className="btn danger" onClick={() => del(r.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
