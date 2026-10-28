import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import {
  GROUP_COLOR_COUNT,
  WORKSPACE_RESERVED_SLUG,
  WORKSPACE_SLUG_RE,
  uniqueWorkspaceSlug,
  type Repo,
  type Workspace,
} from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { IconCheck, IconPencil, IconX } from './Icons.tsx';

// Workspaces section of the Repos page (docs/workspaces.md § Managing them):
// named views over repo sets. Everything is inline — no overlay, so nothing
// here needs a <Sheet> on a phone. The list is the `workspaces` store slice,
// which follows `workspace.updated`/`workspace.deleted`, so a write only has
// to succeed: the broadcast redraws this tab and every other one.

/** Client-side twin of the server's slug refusal (400), shown before a round trip. */
function slugProblem(slug: string): string | null {
  if (slug === WORKSPACE_RESERVED_SLUG) return `"${WORKSPACE_RESERVED_SLUG}" is reserved for the every-repo view`;
  if (!WORKSPACE_SLUG_RE.test(slug)) return 'slug: 1–40 of a-z, 0-9 and "-", starting with a letter or digit';
  return null;
}

const groupVar = (slot: number | null): CSSProperties =>
  ({ '--tm-group': slot == null ? 'var(--tm-border-strong)' : `var(--tm-group-${slot})` }) as CSSProperties;

/** The GroupHead swatch row: one dot per palette slot, plus `auto` = null. */
function Swatches({ color, disabled, onPick }: { color: number | null; disabled?: boolean; onPick: (slot: number | null) => void }) {
  return (
    <span className="group-swatches" role="radiogroup" aria-label="Workspace colour">
      {Array.from({ length: GROUP_COLOR_COUNT }, (_, i) => i + 1).map((slot) => (
        <button
          key={slot}
          type="button"
          role="radio"
          aria-checked={color === slot}
          aria-label={`colour ${slot}`}
          title={`colour ${slot}`}
          className={`group-swatch-dot ${color === slot ? 'on' : ''}`}
          style={groupVar(slot)}
          disabled={disabled}
          onClick={() => onPick(slot)}
        />
      ))}
      <button
        type="button"
        role="radio"
        aria-checked={color == null}
        className={`group-swatch-auto ${color == null ? 'on' : ''}`}
        title="no colour"
        disabled={disabled}
        onClick={() => onPick(null)}
      >
        auto
      </button>
    </span>
  );
}

/** Checkbox list of repos. The last ticked repo cannot be unticked: a workspace needs one. */
function RepoPicks({ repos, picked, disabled, onToggle }: { repos: Repo[]; picked: string[]; disabled?: boolean; onToggle: (id: string) => void }) {
  return (
    <div className="ws-repos" role="group" aria-label="Repos in this workspace">
      {repos.map((r) => {
        const on = picked.includes(r.id);
        const last = on && picked.length === 1;
        return (
          <label key={r.id} className={`ws-repo ${on ? 'on' : ''}`} title={last ? 'a workspace needs at least one repo' : r.path}>
            <input type="checkbox" checked={on} disabled={disabled || last} onChange={() => onToggle(r.id)} />
            <span>{r.name}</span>
          </label>
        );
      })}
    </div>
  );
}

function NewWorkspace({ repos, workspaces }: { repos: Repo[]; workspaces: Workspace[] }) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [color, setColor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The slug the server derives when none is sent: slugify + a numeric suffix on a clash.
  const slug = name.trim() ? uniqueWorkspaceSlug(name.trim(), workspaces.map((w) => w.slug)) : null;
  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.createWorkspace({ name: name.trim(), repoIds: picked, color });
      setName('');
      setPicked([]);
      setColor(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const ready = !!name.trim() && picked.length > 0 && !busy;
  return (
    <div className="panel ws-new">
      <div className="ws-new-head">
        <div className="ws-new-name">
          <label className="label" htmlFor="ws-new-name">
            New workspace
          </label>
          <input
            id="ws-new-name"
            className="field"
            placeholder="neko"
            maxLength={60}
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ready && void create()}
          />
          <span className="mono muted ws-slug-preview">{slug ? `/${slug}` : 'slug follows the name'}</span>
        </div>
        <Swatches color={color} disabled={busy} onPick={setColor} />
      </div>
      {repos.length === 0 ? (
        <div className="muted">Register a repo first.</div>
      ) : (
        // Unlike an existing workspace, the new form may untick down to zero.
        <div className="ws-repos" role="group" aria-label="Repos for the new workspace">
          {repos.map((r) => (
            <label key={r.id} className={`ws-repo ${picked.includes(r.id) ? 'on' : ''}`} title={r.path}>
              <input type="checkbox" checked={picked.includes(r.id)} disabled={busy} onChange={() => toggle(r.id)} />
              <span>{r.name}</span>
            </label>
          ))}
        </div>
      )}
      <div className="ws-new-foot">
        <button className="btn primary" disabled={!ready} onClick={() => void create()}>
          {busy ? 'Creating…' : 'Create workspace'}
        </button>
        {!err && name.trim() && picked.length === 0 && <span className="muted">pick at least one repo</span>}
        {err && <span className="warn-text">{err}</span>}
      </div>
    </div>
  );
}

function WorkspaceRow({
  ws,
  repos,
  index,
  total,
  onMove,
}: {
  ws: Workspace;
  repos: Repo[];
  index: number;
  total: number;
  onMove: (delta: -1 | 1) => Promise<void>;
}) {
  const [editing, setEditing] = useState<'name' | 'slug' | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** the repo set just sent, shown until the write settles (the broadcast then carries it) */
  const [sending, setSending] = useState<string[] | null>(null);
  // A deleted repo's id may linger in the slice until the next load (phase 1 note).
  const picked = (sending ?? ws.repoIds).filter((id) => repos.some((r) => r.id === id));

  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
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

  const start = (what: 'name' | 'slug') => {
    setDraft(what === 'name' ? ws.name : ws.slug);
    setErr(null);
    setConfirmDelete(false);
    setEditing(what);
  };
  const draftProblem = editing === 'slug' ? slugProblem(draft.trim()) : editing === 'name' && !draft.trim() ? 'name is required' : null;
  const commit = async () => {
    const v = draft.trim();
    if (draftProblem) return setErr(draftProblem);
    if (editing === 'name' ? v === ws.name : v === ws.slug) return setEditing(null);
    const ok = await run(() => api.updateWorkspace(ws.id, editing === 'name' ? { name: v } : { slug: v }));
    if (ok) setEditing(null);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void commit();
    else if (e.key === 'Escape') {
      setEditing(null);
      setErr(null);
    }
  };
  const toggleRepo = (id: string) => {
    const next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
    if (!next.length) return;
    setSending(next);
    void run(() => api.updateWorkspace(ws.id, { repoIds: next })).finally(() => setSending(null));
  };

  return (
    <li className="ws-row" style={groupVar(ws.color)} data-workspace={ws.slug}>
      <div className="ws-row-head">
        {editing ? (
          <span className="ws-edit">
            <input
              className={`field ${editing === 'slug' ? 'mono' : ''}`}
              autoFocus
              aria-label={editing === 'name' ? 'Workspace name' : 'Workspace slug'}
              maxLength={editing === 'name' ? 60 : 40}
              spellCheck={false}
              value={draft}
              disabled={busy}
              onChange={(e) => {
                setDraft(e.target.value);
                setErr(null);
              }}
              onKeyDown={onKey}
            />
            <button className="btn ghost ws-icon" title="Save (Enter)" aria-label="Save" disabled={busy || !!draftProblem} onClick={() => void commit()}>
              <IconCheck />
            </button>
            <button
              className="btn ghost ws-icon"
              title="Cancel (Escape)"
              aria-label="Cancel"
              disabled={busy}
              onClick={() => {
                setEditing(null);
                setErr(null);
              }}
            >
              <IconX />
            </button>
          </span>
        ) : (
          <span className="ws-id">
            <button className="ws-name" title="Rename (the slug stays)" onClick={() => start('name')}>
              {ws.name}
            </button>
            <button className="btn ghost ws-icon" title="Rename (the slug stays)" aria-label="Rename" onClick={() => start('name')}>
              <IconPencil />
            </button>
            <span className="mono muted ws-slug">/{ws.slug}</span>
            <button className="btn ghost ws-slug-edit" title="Change the URL slug — old links stop working" onClick={() => start('slug')}>
              edit slug
            </button>
          </span>
        )}
        <span className="ws-row-actions">
          <button className="btn ghost ws-icon" title="Move up" aria-label="Move up" disabled={busy || index === 0} onClick={() => void run(() => onMove(-1))}>
            ↑
          </button>
          <button
            className="btn ghost ws-icon"
            title="Move down"
            aria-label="Move down"
            disabled={busy || index === total - 1}
            onClick={() => void run(() => onMove(1))}
          >
            ↓
          </button>
          {confirmDelete ? (
            <>
              <button className="btn danger" disabled={busy} onClick={() => void run(() => api.deleteWorkspace(ws.id))}>
                Delete {ws.name}?
              </button>
              <button className="btn ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </>
          ) : (
            <button className="btn danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          )}
        </span>
      </div>
      <Swatches color={ws.color} disabled={busy} onPick={(slot) => slot !== ws.color && void run(() => api.updateWorkspace(ws.id, { color: slot }))} />
      <RepoPicks repos={repos} picked={picked} disabled={busy} onToggle={toggleRepo} />
      {(err || (editing === 'slug' && draftProblem)) && <div className="warn-text">{err ?? draftProblem}</div>}
    </li>
  );
}

export function WorkspacesSection() {
  const { repos, workspaces } = useApp();
  const move = (i: number, delta: -1 | 1) => {
    const ids = workspaces.map((w) => w.id);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return Promise.resolve();
    [ids[i], ids[j]] = [ids[j], ids[i]];
    return api.reorderWorkspaces(ids).then(() => undefined);
  };
  return (
    <section id="workspaces" className="ws-section">
      <h2 className="section-head">
        Workspaces <span className="count">{workspaces.length}</span>
      </h2>
      <p className="muted ws-hint">Named views over a set of repos. A repo may sit in several; nothing a worker sees changes.</p>
      <NewWorkspace repos={repos} workspaces={workspaces} />
      {workspaces.length > 0 && (
        <ol className="panel ws-list">
          {workspaces.map((w, i) => (
            <WorkspaceRow key={w.id} ws={w} repos={repos} index={i} total={workspaces.length} onMove={(d) => move(i, d)} />
          ))}
        </ol>
      )}
    </section>
  );
}
