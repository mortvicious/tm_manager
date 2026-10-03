import { useEffect, useMemo, useState } from 'react';
import { SHARED_FILING_STALLED, type Repo, type SharedNote, type SharedNoteKind, type Space, type SpaceFile } from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { fmtAgo, useNow } from '../components/TimeAgo.tsx';

/**
 * Shared spaces (docs/shared-spaces.md): a set of repos that share one
 * knowledge folder and one ledger of cross-repo requests and notes. Workers in
 * a member repo read the folder as $TM_SHARED_DIR and see the open requests
 * addressed to their repo at the start of every task; this page is the
 * human's view of the same thing — and the one place to set a space up.
 */

type Tab = 'requests' | 'notes' | 'files';
type Filter = 'active' | 'resolved' | 'all';

const repoName = (repos: Repo[], id: string | null, fallback = 'you') =>
  id ? repos.find((r) => r.id === id)?.name ?? id.slice(0, 8) : fallback;

function useAct() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, act, setErr };
}

function RepoPicker({ repos, selected, onChange }: { repos: Repo[]; selected: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div className="pick-row">
      {repos.map((r) => (
        <button
          key={r.id}
          className={`btn pick-btn${selected.includes(r.id) ? ' on' : ''}`}
          onClick={() => onChange(selected.includes(r.id) ? selected.filter((x) => x !== r.id) : [...selected, r.id])}
        >
          {r.name}
          {r.role ? ` · ${r.role}` : ''}
        </button>
      ))}
    </div>
  );
}

function SpaceForm({ space, onDone }: { space?: Space; onDone: (msg?: string) => void }) {
  const { repos, spaces } = useApp();
  const [name, setName] = useState(space?.name ?? '');
  const [path, setPath] = useState(space?.path ?? '~/Development/');
  // A deleted repo's id lingers in `repoIds` (FK-less); saving it back would be refused.
  const [selected, setSelected] = useState<string[]>((space?.repoIds ?? []).filter((id) => repos.some((r) => r.id === id)));
  const { busy, err, act } = useAct();
  // A repo can be in one space: show which ones are taken instead of letting the server refuse.
  const taken = new Map(spaces.filter((s) => s.id !== space?.id).flatMap((s) => s.repoIds.map((id) => [id, s.name] as const)));
  const free = repos.filter((r) => !taken.has(r.id));

  const submit = () =>
    act(async () => {
      if (space) {
        await api.updateSpace(space.id, { name, path, repoIds: selected });
        onDone();
      } else {
        const r = await api.createSpace({ name, path, repoIds: selected });
        onDone(
          r.imported || r.importError
            ? `Imported ${r.imported} item(s) from .tm/import.json${r.importError ? ` — ${r.importError}` : ''}.`
            : undefined,
        );
      }
    });

  return (
    <div className="panel shared-form">
      <div className="form-grid">
        <div>
          <label className="label">Name</label>
          <input className="field" value={name} placeholder="neko" onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label">Folder (outside every repo; created if missing)</label>
          <input className="field mono" value={path} onChange={(e) => setPath(e.target.value)} />
        </div>
      </div>
      <div className="shared-gap">
        <label className="label">Member repos</label>
        <RepoPicker repos={free} selected={selected} onChange={setSelected} />
        {taken.size > 0 && (
          <div className="muted shared-small shared-gap-sm">
            In another space: {repos.filter((r) => taken.has(r.id)).map((r) => `${r.name} (${taken.get(r.id)})`).join(', ')}
          </div>
        )}
      </div>
      {err && <div className="warn-text shared-gap-sm">{err}</div>}
      <div className="shared-actions">
        <button className="btn primary" disabled={busy || !name.trim() || !path.trim() || selected.length === 0} onClick={submit}>
          {space ? 'Save' : 'Create space'}
        </button>
        <button className="btn ghost" onClick={() => onDone()}>
          Cancel
        </button>
        {!space && (
          <span className="muted shared-small">
            A <span className="mono">.tm/import.json</span> already in the folder is imported into the ledger once.
          </span>
        )}
      </div>
    </div>
  );
}

function NewNoteForm({ space, members, onDone }: { space: Space; members: Repo[]; onDone: () => void }) {
  const [kind, setKind] = useState<SharedNoteKind>('request');
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const { busy, err, act } = useAct();
  const needsTo = kind === 'request';

  return (
    <div className="panel shared-form">
      <div className="pick-row">
        {(['request', 'note'] as const).map((k) => (
          <button key={k} className={`btn pick-btn${kind === k ? ' on' : ''}`} onClick={() => setKind(k)}>
            {k === 'request' ? 'Request — a repo must do something' : 'Note — knowledge for everyone'}
          </button>
        ))}
      </div>
      <div className="form-grid shared-gap">
        <div>
          <label className="label">From</label>
          <select className="field" value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">me</option>
            {members.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">{needsTo ? 'To (the repo that must act)' : 'About (optional)'}</label>
          <select className="field" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">{needsTo ? 'pick a repo' : 'everyone'}</option>
            {members
              .filter((r) => !needsTo || r.id !== from)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
          </select>
        </div>
      </div>
      <div className="shared-gap">
        <label className="label">Title</label>
        <input className="field" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="shared-gap">
        <label className="label">{needsTo ? 'Contract — what changed, what exactly to do, how to verify' : 'Body (markdown)'}</label>
        <textarea className="field shared-textarea" value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      {err && <div className="warn-text shared-gap-sm">{err}</div>}
      <div className="shared-actions">
        <button
          className="btn primary"
          disabled={busy || !title.trim() || (needsTo && (!to || !body.trim()))}
          onClick={async () => {
            const ok = await act(() =>
              api.createSharedNote(space.id, { kind, title, body, toRepoId: to || null, fromRepoId: from || null }),
            );
            if (ok) onDone();
          }}
        >
          Add {kind}
        </button>
        <button className="btn ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function NoteRow({
  note,
  repos,
  open,
  onToggle,
  onOpenTask,
  onOpenFile,
}: {
  note: SharedNote;
  repos: Repo[];
  open: boolean;
  onToggle: () => void;
  onOpenTask: (id: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const now = useNow();
  const { tasks } = useApp();
  const { busy, err, act } = useAct();
  const [resolution, setResolution] = useState('');
  const active = note.status === 'open' || note.status === 'filed';
  const filedTask = note.status === 'filed' && note.taskId ? tasks.find((t) => t.id === note.taskId) : undefined;
  const stalled = !!filedTask && SHARED_FILING_STALLED.includes(filedTask.status);
  const resolve = (status: 'done' | 'dismissed' | 'open') =>
    act(() => api.updateSharedNote(note.id, { status, ...(resolution.trim() ? { resolution: resolution.trim() } : {}) }));

  return (
    <div className="shared-row-wrap">
      <div className="report-row" onClick={onToggle}>
        <div className="shared-row-main">
          <div className="report-title">{note.title}</div>
          <div className="report-sub">
            {repoName(repos, note.fromRepoId)} → {note.toRepoId ? repoName(repos, note.toRepoId) : 'everyone'}
            {note.taskId ? ` · task ${note.taskId.slice(0, 8)}${filedTask ? ` (${filedTask.status})` : ''}` : ''}
            {stalled && <span className="warn-text"> · needs you: {filedTask!.status === 'draft' ? 'enqueue' : 'retry or cancel'} its task</span>}
            {note.files.length ? ` · ${note.files.length} file${note.files.length === 1 ? '' : 's'}` : ''}
          </div>
        </div>
        <span className={`chip shared-status ${note.status}`}>{note.kind === 'note' && note.status === 'dismissed' ? 'archived' : note.status}</span>
        <span className="muted shared-small shared-nowrap">{fmtAgo(now - Date.parse(note.createdAt))}</span>
      </div>
      {open && (
        <div className="shared-detail">
          {note.body ? <Markdown label={note.kind === 'request' ? 'Contract' : 'Note'} text={note.body} safe /> : null}
          {note.files.length > 0 && (
            <div className="pick-row shared-gap-sm">
              {note.files.map((f) => (
                <button key={f} className="btn ghost mono shared-small" onClick={() => onOpenFile(f)}>
                  {f}
                </button>
              ))}
            </div>
          )}
          {note.resolution && <div className="muted shared-gap-sm">Resolution: {note.resolution}</div>}
          {err && <div className="warn-text shared-gap-sm">{err}</div>}
          <div className="shared-actions">
            {note.taskId && (
              <button className="btn" onClick={() => onOpenTask(note.taskId!)}>
                Open task
              </button>
            )}
            {note.kind === 'request' && note.status === 'open' && (
              <>
                <button className="btn primary" disabled={busy} onClick={() => act(() => api.fileSharedNote(note.id, 'queue'))}>
                  File → custom queue
                </button>
                <button className="btn" disabled={busy} onClick={() => act(() => api.fileSharedNote(note.id, 'draft'))}>
                  File as draft
                </button>
              </>
            )}
            {active && (
              <>
                <input
                  className="field shared-resolution"
                  placeholder="resolution (optional)"
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                />
                {note.kind === 'request' && (
                  <button className="btn" disabled={busy} onClick={() => resolve('done')}>
                    Done
                  </button>
                )}
                <button className="btn" disabled={busy} onClick={() => resolve('dismissed')}>
                  {note.kind === 'request' ? 'Dismiss' : 'Archive'}
                </button>
              </>
            )}
            {!active && (
              <button className="btn" disabled={busy} onClick={() => resolve('open')}>
                Reopen
              </button>
            )}
            <span className="shared-spacer" />
            <button className="btn danger" disabled={busy} onClick={() => act(() => api.deleteSharedNote(note.id))}>
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FilesTab({ space, openPath, setOpenPath }: { space: Space; openPath: string | null; setOpenPath: (p: string | null) => void }) {
  const [list, setList] = useState<{ files: SpaceFile[]; truncated: boolean } | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = () =>
    api
      .spaceFiles(space.id)
      .then(setList)
      .catch((e) => setErr((e as Error).message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space.id, space.path]);
  useEffect(() => {
    setText(null);
    if (!openPath) return;
    api
      .spaceFileText(space.id, openPath)
      .then(setText)
      .catch((e) => setText(`(${(e as Error).message})`));
  }, [space.id, openPath]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const files = list?.files ?? [];
    return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
  }, [list, filter]);

  const href = (p: string) => `/api/spaces/${space.id}/file?path=${encodeURIComponent(p)}`;

  return (
    <div className="shared-files">
      <div className="panel shared-file-list">
        <div className="shared-actions shared-pad">
          <input className="field" placeholder="filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="btn ghost" onClick={load}>
            Reload
          </button>
        </div>
        {err && <div className="warn-text shared-pad">{err}</div>}
        {list && list.files.length === 0 && <div className="empty">The folder is empty.</div>}
        {shown.map((f) => (
          <div
            key={f.path}
            className={`shared-file${openPath === f.path ? ' on' : ''}`}
            onClick={() => setOpenPath(f.path)}
            title={`${f.size} bytes · ${f.mtime}`}
          >
            <span className="mono">{f.path}</span>
          </div>
        ))}
        {list?.truncated && <div className="muted shared-small shared-pad">List truncated — open the folder for the rest.</div>}
      </div>
      <div className="shared-file-view">
        {!openPath ? (
          <div className="empty panel">Pick a file.</div>
        ) : text === null ? (
          <div className="empty panel">Loading…</div>
        ) : /\.(md|markdown)$/i.test(openPath) ? (
          <Markdown label={openPath} text={text} safe />
        ) : /\.(txt|json|jsonl|ya?ml|csv|tsv|sql|log|diff|patch|ts|tsx|js|jsx|mjs|cjs|css|scss|html?|xml|sh|toml|ini)$/i.test(openPath) ||
          !/\.[^/]+$/.test(openPath) ? (
          <div className="panel shared-pad">
            <div className="label">{openPath}</div>
            <pre className="mono shared-pre">{text}</pre>
          </div>
        ) : (
          <div className="panel shared-pad">
            <a className="btn" href={href(openPath)} download>
              Download {openPath}
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

export function SharedPage({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const { spaces, sharedNotes, repos } = useApp();
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState<Tab>('requests');
  const [filter, setFilter] = useState<Filter>('active');
  const [openId, setOpenId] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const { busy, err, act, setErr } = useAct();
  const [msg, setMsg] = useState<string | null>(null);

  const space = spaces.find((s) => s.id === spaceId) ?? spaces[0] ?? null;
  const members = useMemo(() => (space ? repos.filter((r) => space.repoIds.includes(r.id)) : []), [space, repos]);
  const notes = useMemo(() => (space ? sharedNotes.filter((n) => n.spaceId === space.id) : []), [space, sharedNotes]);
  const kindNotes = notes.filter((n) => n.kind === (tab === 'notes' ? 'note' : 'request'));
  const visible = kindNotes
    .filter((n) =>
      filter === 'all' ? true : filter === 'active' ? n.status === 'open' || n.status === 'filed' : n.status === 'done' || n.status === 'dismissed',
    )
    .sort((a, b) => (filter === 'active' ? a.createdAt.localeCompare(b.createdAt) : b.updatedAt.localeCompare(a.updatedAt)));
  const openCount = (kind: SharedNoteKind) => notes.filter((n) => n.kind === kind && (n.status === 'open' || n.status === 'filed')).length;

  // Requests read best grouped by who has to act.
  const groups = useMemo(() => {
    if (tab !== 'requests') return [{ key: 'all', label: '', items: visible }];
    const keys = [...new Set(visible.map((n) => n.toRepoId ?? ''))];
    return keys.map((k) => ({ key: k, label: `→ ${repoName(repos, k || null, 'everyone')}`, items: visible.filter((n) => (n.toRepoId ?? '') === k) }));
  }, [tab, visible, repos]);

  if (creating || (!space && spaces.length === 0)) {
    return (
      <div>
        <h1 className="page-title">Shared</h1>
        {!creating && (
          <div className="empty panel shared-intro">
            <div className="big">No shared space yet</div>
            A shared space is a set of repos that work on one product — say a backend and its two frontends. They share one knowledge
            folder and a ledger of cross-repo requests, so a fix one repo makes and another must follow up on is written down once and
            picked up by the next agent that works there.
            <div className="shared-gap">
              <button className="btn primary" onClick={() => setCreating(true)}>
                New space
              </button>
            </div>
          </div>
        )}
        {creating && (
          <SpaceForm
            onDone={(m) => {
              setCreating(false);
              setMsg(m ?? null);
            }}
          />
        )}
      </div>
    );
  }
  if (!space) return null;

  return (
    <div>
      <h1 className="page-title">Shared</h1>

      <div className="pick-row">
        {spaces.map((s) => (
          <button
            key={s.id}
            className={`btn pick-btn${s.id === space.id ? ' on' : ''}`}
            onClick={() => {
              setSpaceId(s.id);
              setOpenId(null);
              setOpenPath(null);
              setEditing(false);
            }}
          >
            {s.name}
          </button>
        ))}
        <button className="btn ghost pick-btn" onClick={() => setCreating(true)}>
          + New space
        </button>
      </div>

      {editing ? (
        <SpaceForm space={space} onDone={() => setEditing(false)} />
      ) : (
        <div className="panel shared-form">
          <div className="shared-actions shared-head">
            <span className="report-title">{space.name}</span>
            {members.map((r) => (
              <span key={r.id} className="chip">
                {r.name}
              </span>
            ))}
          </div>
          <div className="shared-actions">
            <span className="mono shared-path">{space.path}</span>
            <button className="btn ghost" onClick={() => navigator.clipboard?.writeText(space.path).then(() => setMsg('Path copied.'))}>
              Copy path
            </button>
            <a className="btn ghost" href={`vscode://file${space.path}`}>
              Open in VS Code
            </a>
            <span className="shared-spacer" />
            <button
              className="btn ghost"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const r = await api.importSpaceSeed(space.id);
                  setMsg(r.imported || r.skipped || r.error ? `Imported ${r.imported}, skipped ${r.skipped}${r.error ? ` — ${r.error}` : ''}.` : 'No .tm/import.json in the folder.');
                })
              }
            >
              Import seed
            </button>
            <button className="btn ghost" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              className="btn danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Delete space "${space.name}" and its ledger? The folder on disk stays.`)) {
                  setErr(null);
                  act(() => api.deleteSpace(space.id));
                }
              }}
            >
              Delete
            </button>
          </div>
          {(err || msg) && <div className={`${err ? 'warn-text' : 'muted'} shared-gap-sm`}>{err ?? msg}</div>}
        </div>
      )}

      <div className="pick-row shared-gap">
        <button className={`btn pick-btn${tab === 'requests' ? ' on' : ''}`} onClick={() => setTab('requests')}>
          Requests{openCount('request') ? ` (${openCount('request')})` : ''}
        </button>
        <button className={`btn pick-btn${tab === 'notes' ? ' on' : ''}`} onClick={() => setTab('notes')}>
          Notes{openCount('note') ? ` (${openCount('note')})` : ''}
        </button>
        <button className={`btn pick-btn${tab === 'files' ? ' on' : ''}`} onClick={() => setTab('files')}>
          Files
        </button>
        {tab !== 'files' && (
          <>
            <span className="shared-spacer" />
            {(['active', 'resolved', 'all'] as const).map((f) => (
              <button key={f} className={`btn ghost pick-btn${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
                {f === 'active' ? (tab === 'notes' ? 'Active' : 'Open') : f === 'resolved' ? (tab === 'notes' ? 'Archived' : 'Resolved') : 'All'}
              </button>
            ))}
            <button className="btn" onClick={() => setAdding((a) => !a)}>
              + Add
            </button>
          </>
        )}
      </div>

      {adding && tab !== 'files' && <NewNoteForm space={space} members={members} onDone={() => setAdding(false)} />}

      {tab === 'files' ? (
        <FilesTab space={space} openPath={openPath} setOpenPath={setOpenPath} />
      ) : (
        <div className="panel shared-gap">
          {visible.length === 0 ? (
            <div className="empty">
              <div className="big">{tab === 'requests' ? 'No requests here' : 'No notes here'}</div>
              {tab === 'requests'
                ? 'Agents write a request when their change needs another repo to follow up; the addressed repo’s next agent picks it up.'
                : 'Durable knowledge every agent in the space should know.'}
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.key}>
                {g.label && <div className="label shared-group">{g.label} ({g.items.length})</div>}
                {g.items.map((n) => (
                  <NoteRow
                    key={n.id}
                    note={n}
                    repos={repos}
                    open={openId === n.id}
                    onToggle={() => setOpenId(openId === n.id ? null : n.id)}
                    onOpenTask={onOpenTask}
                    onOpenFile={(p) => {
                      setOpenPath(p);
                      setTab('files');
                    }}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
