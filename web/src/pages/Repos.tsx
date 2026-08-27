import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { RepoCommandsMenu, RepoCommandsPanel } from '../components/Commands.tsx';
import { IconAnalyze, IconPencil } from '../components/Icons.tsx';

/** Home-relative path — the prefix is the same on every row, so it is noise. */
const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');

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
    <div className="git-cell" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
        <span className="chip">{git.branch}</span>
        {git.dirty > 0 && (
          <span className="chip" style={{ color: 'var(--tm-status-review)' }} title={`${git.dirty} uncommitted change(s)`}>
            {git.dirty}
          </span>
        )}
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

/** Inline per-repo preview URL (what the mobile emulator frames), rendered as
 *  the third line of the repo cell under name/path. It READS as a plain line of
 *  text — same mono/muted voice as the path above it — and only becomes an
 *  input once the pencil is clicked, so a row of repos is three lines of
 *  identity rather than three lines with a form field wedged in.
 *  Saves on blur/Enter; the server normalises "localhost:5173" and rejects
 *  non-http. Escape leaves without saving. */
function PreviewCell({ repoId, value, onSaved }: { repoId: string; value: string | null; onSaved: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A refresh elsewhere (or another tab) may change the stored value. Never
  // stomp what is being typed — only resync while the field is closed.
  useEffect(() => {
    if (!editing) setDraft(value ?? '');
  }, [value, editing]);
  /** Escape must not save; the blur it causes has to know that. */
  const cancelled = useRef(false);
  const save = async () => {
    if (draft.trim() === (value ?? '')) {
      setEditing(false);
      setErr(null);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // Show what was STORED, not what was typed — the server normalises
      // "localhost:5173" into a full URL.
      const saved = await api.updateRepo(repoId, { previewUrl: draft.trim() || null });
      setDraft(saved.previewUrl ?? '');
      setEditing(false);
      await onSaved();
    } catch (e) {
      // Stay open on failure: closing would hide both the bad value and why.
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const open = () => {
    cancelled.current = false;
    setDraft(value ?? '');
    setErr(null);
    setEditing(true);
  };
  return (
    <div className="repo-url">
      {editing ? (
        <input
          className="field mono repo-url-input"
          placeholder="localhost:5173"
          aria-label="Dev URL"
          autoFocus
          value={draft}
          disabled={busy}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (cancelled.current) {
              cancelled.current = false;
              setDraft(value ?? '');
              setErr(null);
              setEditing(false);
              return;
            }
            void save();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              cancelled.current = true;
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      ) : (
        <span className="repo-url-line">
          {value ? (
            <span className="mono muted repo-path" title={value}>
              {value}
            </span>
          ) : (
            <span className="muted repo-url-empty">no dev URL</span>
          )}
          <button
            type="button"
            className="btn ghost repo-url-edit"
            title="Edit the dev-server URL framed by the mobile emulator"
            aria-label="Edit dev URL"
            onClick={open}
          >
            <IconPencil />
          </button>
        </span>
      )}
      {err && <span className="warn-text repo-url-err">{err}</span>}
    </div>
  );
}

export function ReposPage({ onOpenTerminal }: { onOpenTerminal?: (runId: string) => void }) {
  const { repos, tasks, refresh } = useApp();
  /** repo whose command drawer is open — one at a time, like a details row */
  const [openCommands, setOpenCommands] = useState<string | null>(null);
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
        <div className="repo-add-grid">
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
        <div className="panel tbl-scroll">
          <table className="tbl repos-tbl stack-tbl">
            <thead>
              <tr>
                <th>Repo</th>
                <th>Role</th>
                <th>Tasks</th>
                <th>Git</th>
                <th title="Commands, analysis and repo removal">Actions</th>
              </tr>
            </thead>
            <tbody>
              {repos.map((r) => {
                const expanded = openCommands === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr className={expanded ? 'repo-open' : ''}>
                      {/* Name / path / dev URL in ONE cell: all three identify the
                          repo, and stacking them keeps every other column on one
                          line. The URL stays editable in place. */}
                      <td>
                        <div className="repo-id">
                          <span className="repo-name">{r.name}</span>
                          <span className="mono muted repo-path" title={r.path}>
                            {shortPath(r.path)}
                          </span>
                          <PreviewCell repoId={r.id} value={r.previewUrl} onSaved={refresh} />
                        </div>
                      </td>
                      <td data-label="Role">
                        {r.role ? <span className="chip">{r.role}</span> : <span className="muted">—</span>}
                      </td>
                      <td className="mono" data-label="Tasks">
                        {count(r.id)}
                      </td>
                      <td data-label="Git">
                        <GitCell repoId={r.id} />
                      </td>
                      {/* One actions cluster: commands (behind their own menu),
                          then the two repo-level buttons. */}
                      <td className="row-actions-cell">
                        <span className="repo-actions">
                          <RepoCommandsMenu
                            repoId={r.id}
                            onManage={() => setOpenCommands(expanded ? null : r.id)}
                            onOpenTerminal={onOpenTerminal}
                          />
                          <button className="btn" disabled={analyzing === r.id} onClick={() => analyze(r.id)}>
                            <IconAnalyze /> {analyzing === r.id ? 'Starting…' : 'Analyze'}
                          </button>
                          <button className="btn danger" onClick={() => del(r.id)}>
                            Remove
                          </button>
                        </span>
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="repo-open">
                        <td colSpan={5} className="repo-cmd-cell">
                          <RepoCommandsPanel repoId={r.id} onOpenTerminal={onOpenTerminal} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
