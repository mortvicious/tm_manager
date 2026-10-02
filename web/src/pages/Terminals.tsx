import { useEffect, useMemo, useState } from 'react';
import { MAX_SHELL_SESSIONS, type ShellSession } from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { IconExternal, IconPlus, IconShell, IconX } from '../components/Icons.tsx';
import { useIsMobile } from '../components/Layout.tsx';
import { ShellPane } from '../components/ShellPane.tsx';

/** Preferences, not state: which repo and layout the page was last left on. */
const REPO_KEY = 'tm.terminals.repo';
const LAYOUT_KEY = 'tm.terminals.layout';
/** How many shells one click may open. */
const MAX_PER_CLICK = 4;

type LayoutMode = 'tabs' | 'grid';

const readPref = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writePref = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / quota — the page just won't remember */
  }
};

/**
 * Plain shells per repo (docs/terminals.md): pick a repo, open as many
 * terminals in its directory as you need, close them when done. Nothing here
 * involves claude — these are the user's own login shells.
 */
export function TerminalsPage({ onOpenTerminal }: { onOpenTerminal: (runId: string) => void }) {
  const { repos, shells } = useApp();
  const mobile = useIsMobile();
  const [repoPref, setRepoPref] = useState<string | null>(() => readPref(REPO_KEY));
  const [layout, setLayout] = useState<LayoutMode>(() => (readPref(LAYOUT_KEY) === 'grid' ? 'grid' : 'tabs'));
  const [count, setCount] = useState(1);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // A remembered repo can be deleted; with none remembered, prefer one that
  // already has shells open.
  const repoId = useMemo(() => {
    if (repoPref && repos.some((r) => r.id === repoPref)) return repoPref;
    return repos.find((r) => shells.some((s) => s.repoId === r.id))?.id ?? repos[0]?.id ?? null;
  }, [repoPref, repos, shells]);

  const repoShells = useMemo(() => shells.filter((s) => s.repoId === repoId), [shells, repoId]);
  const perRepo = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of shells) m.set(s.repoId, (m.get(s.repoId) ?? 0) + 1);
    return m;
  }, [shells]);
  // Shells whose repo was deleted while they were open: still closable here.
  const orphans = useMemo(() => shells.filter((s) => !repos.some((r) => r.id === s.repoId)), [shells, repos]);

  const free = MAX_SHELL_SESSIONS - shells.length;
  const maxCount = Math.max(1, Math.min(MAX_PER_CLICK, free));
  const active = repoShells.find((s) => s.id === activeId) ?? repoShells[0] ?? null;

  // The count picker never offers more than fits.
  useEffect(() => {
    if (count > maxCount) setCount(maxCount);
  }, [count, maxCount]);

  const pickRepo = (id: string) => {
    setRepoPref(id);
    writePref(REPO_KEY, id);
    setErr(null);
  };

  const pickLayout = (m: LayoutMode) => {
    setLayout(m);
    writePref(LAYOUT_KEY, m);
  };

  const open = async () => {
    if (!repoId || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const opened = await api.openShells(repoId, count);
      if (opened[0]) {
        setActiveId(opened[0].id);
        // A phone has no room for an embedded pane: straight into the drawer.
        if (mobile && opened.length === 1) onOpenTerminal(opened[0].id);
      }
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };

  const close = async (s: ShellSession) => {
    if (s.status === 'running' && !confirm(`Close ${s.title}? The shell and anything still running in it is killed.`)) return;
    setErr(null);
    try {
      await api.closeShell(s.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (repos.length === 0) {
    return (
      <div>
        <h1 className="page-title">Terminal</h1>
        <div className="empty panel">
          <div className="big">No repos yet</div>
          Register a repo on the Repos page — a terminal opens in its directory.
        </div>
      </div>
    );
  }

  // A tab with no embedded pane to show (phone, a removed repo's shell)
  // opens the drawer instead.
  const tab = (s: ShellSession, embedded: boolean) => (
    <div key={s.id} className={`shell-tab${embedded && !mobile && layout === 'tabs' && s.id === active?.id ? ' on' : ''}`}>
      <button
        className="shell-tab-main"
        title={`${s.shell} -l in ${s.cwd}`}
        onClick={() => (mobile || !embedded ? onOpenTerminal(s.id) : setActiveId(s.id))}
      >
        <span className={`cmd-dot${s.status === 'running' ? ' live' : ''}`} aria-hidden="true" />
        <span className="mono">{s.title}</span>
        {s.status !== 'running' && <span className="shell-tab-state">{s.status}</span>}
      </button>
      <button className="shell-tab-x" title={`Close ${s.title}`} aria-label={`Close ${s.title}`} onClick={() => void close(s)}>
        <IconX />
      </button>
    </div>
  );

  return (
    <div className="shells-page">
      <h1 className="page-title">Terminal</h1>

      <div className="shell-bar">
        <select
          className="field shell-repo"
          value={repoId ?? ''}
          aria-label="Repository"
          onChange={(e) => pickRepo(e.target.value)}
        >
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
              {perRepo.get(r.id) ? ` (${perRepo.get(r.id)})` : ''}
            </option>
          ))}
        </select>
        <select
          className="field shell-count"
          value={count}
          aria-label="How many terminals to open"
          disabled={free <= 0}
          onChange={(e) => setCount(Number(e.target.value))}
        >
          {Array.from({ length: maxCount }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button className="btn primary" disabled={busy || free <= 0 || !repoId} onClick={() => void open()}>
          <IconPlus /> {count === 1 ? 'New terminal' : `Open ${count} terminals`}
        </button>
        <span className="shell-cap mono" title="Open terminals across all repos, live or exited">
          {shells.length}/{MAX_SHELL_SESSIONS} open
        </span>
        <span style={{ flex: 1 }} />
        {!mobile && (
          <div className="shell-layout" role="group" aria-label="Layout">
            {(['tabs', 'grid'] as const).map((m) => (
              <button key={m} className={`btn ghost${layout === m ? ' on' : ''}`} aria-pressed={layout === m} onClick={() => pickLayout(m)}>
                {m}
              </button>
            ))}
          </div>
        )}
      </div>
      {err && <div className="shell-err">{err}</div>}

      {repoShells.length === 0 ? (
        <div className="empty panel">
          <div className="big">
            <IconShell /> No terminals in this repo
          </div>
          A terminal is your own login shell, opened in the repo's directory — not an agent.
        </div>
      ) : (
        <>
          <div className="shell-tabs">{repoShells.map((s) => tab(s, true))}</div>
          {mobile ? (
            <div className="shell-hint">Tap a terminal to open it.</div>
          ) : (
            <div className={`shell-panes ${layout}`}>
              {/* Every pane stays mounted in tab mode (hidden, socket open), so
                  switching tabs is instant and never replays the scrollback. */}
              {repoShells.map((s) => (
                <div key={s.id} className={`shell-pane${layout === 'tabs' && s.id !== active?.id ? ' hidden' : ''}`}>
                  <div className="shell-pane-head mono">
                    <span className={`cmd-dot${s.status === 'running' ? ' live' : ''}`} aria-hidden="true" />
                    <span>{s.title}</span>
                    <span className="shell-pane-cwd">{s.cwd}</span>
                    <span style={{ flex: 1 }} />
                    <button className="btn ghost" title="Open in the terminal drawer" onClick={() => onOpenTerminal(s.id)}>
                      <IconExternal />
                    </button>
                    {layout === 'grid' && (
                      <button className="btn ghost" title={`Close ${s.title}`} onClick={() => void close(s)}>
                        <IconX />
                      </button>
                    )}
                  </div>
                  <ShellPane shellId={s.id} focus={layout === 'tabs' && s.id === active?.id} />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {orphans.length > 0 && (
        <div className="shell-orphans">
          <span className="label">repo removed</span>
          <div className="shell-tabs">{orphans.map((s) => tab(s, false))}</div>
        </div>
      )}
    </div>
  );
}
