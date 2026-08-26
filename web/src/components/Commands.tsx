import { useEffect, useMemo, useRef, useState } from 'react';
import type { CommandRun, RepoCommand, ScannedScript } from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { fmtAgo, useNow } from './TimeAgo.tsx';
import { IconBolt, IconChevron, IconPlay, IconRefresh, IconStop, IconTerminal, IconTrash, IconX } from './Icons.tsx';

/** Which repo the launcher was last pointed at — a preference, not state. */
const STORE_KEY = 'tm.commands.repo';

const readRepoPref = (): string | null => {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
};

const writeRepoPref = (id: string) => {
  try {
    localStorage.setItem(STORE_KEY, id);
  } catch {
    /* private mode / quota — the launcher just won't remember */
  }
};

const byOrder = (a: RepoCommand, b: RepoCommand) =>
  a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt);

/** Run/stop plumbing shared by the header launcher and the Repos editor.
 *  Every state change arrives back over `/ws/events`, so nothing refetches. */
function useCommandActions(onOpenTerminal?: (runId: string) => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (c: RepoCommand) => {
    setBusy(c.id);
    setErr(null);
    try {
      const started = await api.runCommand(c.id);
      // A one-shot command prints and exits — its output IS the point, so its
      // terminal opens. A service is meant to stay in the background; the
      // header indicator is where it reports from.
      if (c.kind === 'task') onOpenTerminal?.(started.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const stop = async (runId: string) => {
    setBusy(runId);
    setErr(null);
    try {
      await api.stopCommandRun(runId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return { busy, err, setErr, run, stop };
}

function RunRow({
  run,
  busy,
  onStop,
  onOpenTerminal,
}: {
  run: CommandRun;
  busy: boolean;
  onStop: (runId: string) => void;
  onOpenTerminal: (runId: string) => void;
}) {
  const now = useNow();
  const live = run.status === 'running';
  const since = Date.parse(live ? run.startedAt : (run.endedAt ?? run.startedAt));
  return (
    <div className="cmd-run">
      <span className={`cmd-dot ${live ? 'live' : run.exitCode === 0 ? 'ok' : 'bad'}`} aria-hidden="true" />
      <span className="cmd-run-main">
        <span className="cmd-run-name">{run.name}</span>
        <span className="mono muted cmd-run-sub" title={`${run.command}\n${run.cwd}`}>
          {run.repoName} · {run.command}
        </span>
      </span>
      <span className="mono muted cmd-run-age">
        {live
          ? `up ${fmtAgo(now - since)}`
          : run.status === 'killed'
            ? 'stopped'
            : `exit ${run.exitCode ?? '?'}`}
      </span>
      <button className="btn ghost" title="Open this command's terminal" onClick={() => onOpenTerminal(run.id)}>
        <IconTerminal />
      </button>
      {live && (
        <button className="btn ghost" title="Stop it" disabled={busy} onClick={() => onStop(run.id)}>
          <IconStop />
        </button>
      )}
    </div>
  );
}

/** Header button + popover: what is running, and one click to run anything. */
export function CommandsLauncher({ onOpenTerminal }: { onOpenTerminal: (runId: string) => void }) {
  const { repos, commands, commandRuns } = useApp();
  const [open, setOpen] = useState(false);
  const [repoId, setRepoId] = useState<string | null>(() => readRepoPref());
  const wrapRef = useRef<HTMLSpanElement>(null);
  const { busy, err, setErr, run, stop } = useCommandActions((runId) => {
    setOpen(false);
    onOpenTerminal(runId);
  });

  const running = useMemo(() => commandRuns.filter((r) => r.status === 'running'), [commandRuns]);
  const finished = useMemo(() => commandRuns.filter((r) => r.status !== 'running').slice(0, 5), [commandRuns]);
  const services = running.filter((r) => r.kind === 'service');

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // A remembered repo can be deleted while the popover is shut; and with none
  // remembered, prefer whichever repo already has commands.
  const effectiveRepoId = useMemo(() => {
    if (repoId && repos.some((r) => r.id === repoId)) return repoId;
    return repos.find((r) => commands.some((c) => c.repoId === r.id))?.id ?? repos[0]?.id ?? null;
  }, [repoId, repos, commands]);

  const repoCommands = useMemo(
    () => commands.filter((c) => c.repoId === effectiveRepoId).sort(byOrder),
    [commands, effectiveRepoId],
  );

  const title = running.length
    ? `${running.length} command(s) running: ${running.map((r) => `${r.repoName} · ${r.name}`).join(', ')}`
    : 'Repo commands — dev servers and scripts';

  return (
    <span className="cmd-wrap" ref={wrapRef}>
      <button
        className={`btn ghost cmd-launch ${open ? 'on' : ''}`}
        title={title}
        aria-pressed={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <IconBolt />
        {running.length > 0 && (
          <>
            <span className="cmd-dot live" aria-hidden="true" />
            <span className="mono">
              {running.length}
              {services.length > 0 && services.length !== running.length ? ` (${services.length} dev)` : ''}
            </span>
          </>
        )}
      </button>

      {open && (
        <div className="cmd-pop" role="dialog" aria-label="Repo commands">
          <div className="cmd-pop-head">
            <span className="label" style={{ margin: 0 }}>
              running
            </span>
            <span style={{ flex: 1 }} />
            {finished.length > 0 && (
              <button
                className="btn ghost"
                title="Clear finished runs from this list"
                onClick={() => api.clearCommandRuns().catch(() => {})}
              >
                clear
              </button>
            )}
            <button className="btn ghost" title="Close" onClick={() => setOpen(false)}>
              <IconX />
            </button>
          </div>

          {running.length === 0 ? (
            <div className="cmd-empty">Nothing running.</div>
          ) : (
            running.map((r) => (
              <RunRow
                key={r.id}
                run={r}
                busy={busy === r.id}
                onStop={stop}
                onOpenTerminal={(id) => {
                  setOpen(false);
                  onOpenTerminal(id);
                }}
              />
            ))
          )}

          <div className="cmd-pop-head" style={{ marginTop: 'var(--tm-space-2)' }}>
            <span className="label" style={{ margin: 0 }}>
              run
            </span>
            <select
              className="field cmd-select"
              value={effectiveRepoId ?? ''}
              disabled={repos.length === 0}
              onChange={(e) => {
                setRepoId(e.target.value);
                writeRepoPref(e.target.value);
                setErr(null);
              }}
            >
              {repos.length === 0 && <option value="">no repos</option>}
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>

          {repoCommands.length === 0 ? (
            <div className="cmd-empty">
              No commands saved for this repo — add them on the <b>Repos</b> page (its scanner lists every{' '}
              <span className="mono">package.json</span> script).
            </div>
          ) : (
            repoCommands.map((c) => {
              const live = running.find((r) => r.commandId === c.id);
              return (
                <div className="cmd-run" key={c.id}>
                  <span className={`cmd-dot ${live ? 'live' : ''}`} aria-hidden="true" />
                  <span className="cmd-run-main">
                    <span className="cmd-run-name">{c.name}</span>
                    <span className="mono muted cmd-run-sub" title={c.cwd ? `${c.command}\nin ${c.cwd}` : c.command}>
                      {c.command}
                      {c.cwd ? ` · ${c.cwd}` : ''}
                    </span>
                  </span>
                  {c.kind === 'service' && <span className="chip">dev</span>}
                  {live ? (
                    <button className="btn ghost" title="Stop it" disabled={busy === live.id} onClick={() => stop(live.id)}>
                      <IconStop />
                    </button>
                  ) : (
                    <button className="btn ghost" title="Run it" disabled={busy === c.id} onClick={() => run(c)}>
                      <IconPlay />
                    </button>
                  )}
                </div>
              );
            })
          )}

          {finished.length > 0 && (
            <>
              <div className="cmd-pop-head" style={{ marginTop: 'var(--tm-space-2)' }}>
                <span className="label" style={{ margin: 0 }}>
                  finished
                </span>
              </div>
              {finished.map((r) => (
                <RunRow
                  key={r.id}
                  run={r}
                  busy={false}
                  onStop={stop}
                  onOpenTerminal={(id) => {
                    setOpen(false);
                    onOpenTerminal(id);
                  }}
                />
              ))}
            </>
          )}

          {err && <div className="warn-text cmd-err">{err}</div>}
        </div>
      )}
    </span>
  );
}

const KIND_HINT = 'service = long-running (dev server, watcher) — those show in the header indicator';

/**
 * The repo row's command dropdown: every saved command, one click to run or
 * stop, and a way into the full editor. Positioned `fixed` from the button's
 * rect on purpose — the repos table is a horizontal scroll container, and an
 * absolutely positioned popover inside one is clipped by it.
 */
export function RepoCommandsMenu({
  repoId,
  onManage,
  onOpenTerminal,
}: {
  repoId: string;
  onManage: () => void;
  onOpenTerminal?: (runId: string) => void;
}) {
  const { commands, commandRuns } = useApp();
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const { busy, err, run, stop } = useCommandActions(onOpenTerminal);

  const mine = useMemo(() => commands.filter((c) => c.repoId === repoId).sort(byOrder), [commands, repoId]);
  const running = commandRuns.filter((r) => r.status === 'running' && r.repoId === repoId);

  const place = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 380;
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    setAt({ top: rect.bottom + 6, left });
  };

  useEffect(() => {
    if (!at) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !btnRef.current?.contains(t)) setAt(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAt(null);
    };
    // The menu is anchored to a rect, so it must not linger somewhere stale.
    const close = () => setAt(null);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [at]);

  return (
    <>
      <button
        ref={btnRef}
        className={`btn ${at ? 'primary' : ''}`}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        title={mine.length === 0 ? 'No commands yet — add one' : `${mine.length} command(s) for this repo`}
        onClick={() => (at ? setAt(null) : place())}
      >
        <IconBolt /> {mine.length === 0 ? 'Add' : mine.length}
        {running.length > 0 && <span className="cmd-dot live" aria-label={`${running.length} running`} />}
        <IconChevron />
      </button>
      {at && (
        <div ref={popRef} className="cmd-pop cmd-menu" role="menu" style={{ top: at.top, left: at.left }}>
          {mine.length === 0 ? (
            <div className="cmd-empty">No commands saved for this repo yet.</div>
          ) : (
            mine.map((c) => {
              const live = running.find((r) => r.commandId === c.id);
              return (
                <div className="cmd-run" key={c.id}>
                  <span className={`cmd-dot ${live ? 'live' : ''}`} aria-hidden="true" />
                  <span className="cmd-run-main">
                    <span className="cmd-run-name">{c.name}</span>
                    <span className="mono muted cmd-run-sub" title={c.cwd ? `${c.command}\nin ${c.cwd}` : c.command}>
                      {c.command}
                      {c.cwd ? ` · ${c.cwd}` : ''}
                    </span>
                  </span>
                  {c.kind === 'service' && <span className="chip">dev</span>}
                  {live ? (
                    <>
                      <button
                        className="btn ghost"
                        title="Open its terminal"
                        onClick={() => {
                          setAt(null);
                          onOpenTerminal?.(live.id);
                        }}
                      >
                        <IconTerminal />
                      </button>
                      <button className="btn ghost" title="Stop it" disabled={busy === live.id} onClick={() => stop(live.id)}>
                        <IconStop />
                      </button>
                    </>
                  ) : (
                    <button className="btn ghost" title="Run it" disabled={busy === c.id} onClick={() => run(c)}>
                      <IconPlay />
                    </button>
                  )}
                </div>
              );
            })
          )}
          {err && <div className="warn-text cmd-err">{err}</div>}
          <div className="cmd-menu-foot">
            <button
              className="btn"
              onClick={() => {
                setAt(null);
                onManage();
              }}
            >
              <IconRefresh /> Add / manage commands…
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** Per-repo command editor + package.json script scanner (Repos page). */
export function RepoCommandsPanel({
  repoId,
  onOpenTerminal,
}: {
  repoId: string;
  onOpenTerminal?: (runId: string) => void;
}) {
  const { commands, commandRuns } = useApp();
  const { busy, err, setErr, run, stop } = useCommandActions(onOpenTerminal);
  const [name, setName] = useState('');
  const [line, setLine] = useState('');
  const [kind, setKind] = useState<RepoCommand['kind']>('task');
  const [cwd, setCwd] = useState('');
  const [saving, setSaving] = useState(false);
  const [scripts, setScripts] = useState<ScannedScript[] | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [picked, setPicked] = useState<string>('');

  const mine = useMemo(() => commands.filter((c) => c.repoId === repoId).sort(byOrder), [commands, repoId]);
  const running = commandRuns.filter((r) => r.status === 'running');

  const scan = async () => {
    setScanning(true);
    setErr(null);
    try {
      const res = await api.repoScripts(repoId);
      setScripts(res.scripts);
      setScanNote(res.note ?? `${res.scripts.length} script(s) · ${res.packageManager}`);
      setPicked(res.scripts[0] ? scriptKey(res.scripts[0]) : '');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setScanning(false);
    }
  };

  const addScanned = async () => {
    const s = scripts?.find((x) => scriptKey(x) === picked);
    if (!s) return;
    setSaving(true);
    setErr(null);
    try {
      await api.createCommand({
        repoId,
        // A workspace script keeps its package in the name, so two `dev`
        // scripts from different packages stay distinguishable.
        name: s.cwd ? `${s.packageName.split('/').pop()} · ${s.name}` : s.name,
        command: s.suggested,
        kind: s.kind,
        cwd: s.cwd || null,
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const add = async () => {
    setSaving(true);
    setErr(null);
    try {
      await api.createCommand({
        repoId,
        name: name.trim() || line.trim(),
        command: line.trim(),
        kind,
        cwd: cwd.trim() || null,
      });
      setName('');
      setLine('');
      setCwd('');
      setKind('task');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const del = async (c: RepoCommand) => {
    if (!confirm(`Delete the command "${c.name}"? A run of it that is still live keeps running.`)) return;
    setErr(null);
    try {
      await api.deleteCommand(c.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const setKindOf = async (c: RepoCommand, next: RepoCommand['kind']) => {
    setErr(null);
    try {
      await api.updateCommand(c.id, { kind: next });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="cmd-panel">
      {mine.length === 0 ? (
        <div className="cmd-empty">No commands yet — scan the repo's scripts below, or write one by hand.</div>
      ) : (
        mine.map((c) => {
          const live = running.find((r) => r.commandId === c.id);
          return (
            <div className="cmd-row" key={c.id}>
              <span className={`cmd-dot ${live ? 'live' : ''}`} aria-hidden="true" />
              <span className="cmd-run-main">
                <span className="cmd-run-name">{c.name}</span>
                <span className="mono muted cmd-run-sub">
                  {c.command}
                  {c.cwd ? ` · ${c.cwd}` : ''}
                </span>
              </span>
              <select
                className="field cmd-select"
                value={c.kind}
                title={KIND_HINT}
                onChange={(e) => setKindOf(c, e.target.value as RepoCommand['kind'])}
              >
                <option value="task">one-shot</option>
                <option value="service">service</option>
              </select>
              {live ? (
                <button className="btn" disabled={busy === live.id} onClick={() => stop(live.id)}>
                  <IconStop /> Stop
                </button>
              ) : (
                <button className="btn" disabled={busy === c.id} onClick={() => run(c)}>
                  <IconPlay /> Run
                </button>
              )}
              <button
                className="btn ghost"
                title="Open this command's terminal"
                disabled={!live}
                onClick={() => live && onOpenTerminal?.(live.id)}
              >
                <IconTerminal />
              </button>
              <button className="btn ghost" title="Delete this command" onClick={() => del(c)}>
                <IconTrash />
              </button>
            </div>
          );
        })
      )}

      <div className="cmd-add">
        <div className="cmd-scan">
          <button className="btn" disabled={scanning} onClick={scan} title="Read every package.json script in this repo">
            <IconRefresh /> {scanning ? 'Scanning…' : scripts ? 'Rescan scripts' : 'Scan scripts'}
          </button>
          {scripts && scripts.length > 0 && (
            <>
              <select className="field cmd-script-select" value={picked} onChange={(e) => setPicked(e.target.value)}>
                {scripts.map((s) => (
                  <option key={scriptKey(s)} value={scriptKey(s)}>
                    {s.cwd ? `${s.packageName} · ` : ''}
                    {s.name} — {s.script.length > 60 ? `${s.script.slice(0, 60)}…` : s.script}
                  </option>
                ))}
              </select>
              <button className="btn primary" disabled={saving || !picked} onClick={addScanned}>
                Add
              </button>
            </>
          )}
          {scanNote && <span className="muted mono">{scanNote}</span>}
        </div>

        <div className="cmd-form">
          <input className="field" placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            className="field mono"
            placeholder="pnpm run start:dev"
            spellCheck={false}
            value={line}
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && line.trim()) void add();
            }}
          />
          <input
            className="field mono"
            placeholder="subdir (optional)"
            spellCheck={false}
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
          />
          <select className="field cmd-select" value={kind} title={KIND_HINT} onChange={(e) => setKind(e.target.value as RepoCommand['kind'])}>
            <option value="task">one-shot</option>
            <option value="service">service</option>
          </select>
          <button className="btn primary" disabled={saving || !line.trim()} onClick={add}>
            Add command
          </button>
        </div>
      </div>

      {err && <div className="warn-text cmd-err">{err}</div>}
    </div>
  );
}

const scriptKey = (s: ScannedScript) => `${s.cwd}|${s.name}`;
