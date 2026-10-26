import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { CHECK_DEFAULT_TIMEOUT_SEC, CHECK_TIMEOUT_MAX_SEC, CHECK_TIMEOUT_MIN_SEC } from '@tm/shared';
import type { CheckBaseline, CommandRun, RepoCommand, ScannedScript } from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { fmtAgo, useNow } from './TimeAgo.tsx';
import { IconBolt, IconChevron, IconPlay, IconRefresh, IconStop, IconTerminal, IconTrash, IconX } from './Icons.tsx';
import { useIsMobile } from './Layout.tsx';
import { Sheet } from './Sheet.tsx';

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

/** Human commands first, then the ones agents saved for their tasks (docs/commands.md § Agent-owned commands). */
const humanFirst = (a: RepoCommand, b: RepoCommand) =>
  Number(a.ownerTaskId !== null) - Number(b.ownerTaskId !== null) || byOrder(a, b);

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
          {run.checkTaskId
            ? ` · check of task ${run.checkTaskId.slice(0, 8)}`
            : run.checkBaseline
              ? ' · check baseline'
              : run.startedBy && run.startedBy !== 'human'
              ? ` · ${run.oneShot ? 'one-shot ' : ''}by ${run.startedBy}`
              : ''}
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
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [showAgent, setShowAgent] = useState(false);
  const [repoId, setRepoId] = useState<string | null>(() => readRepoPref());
  const wrapRef = useRef<HTMLSpanElement>(null);
  const { busy, err, setErr, run, stop } = useCommandActions((runId) => {
    setOpen(false);
    onOpenTerminal(runId);
  });

  const running = useMemo(() => commandRuns.filter((r) => r.status === 'running'), [commandRuns]);
  const finished = useMemo(() => commandRuns.filter((r) => r.status !== 'running').slice(0, 5), [commandRuns]);
  const services = running.filter((r) => r.kind === 'service');

  // a phone opens a sheet, which brings its own backdrop and Escape
  useEffect(() => {
    if (!open || mobile) return;
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
  }, [open, mobile]);

  // A remembered repo can be deleted while the popover is shut; and with none
  // remembered, prefer whichever repo already has commands.
  const effectiveRepoId = useMemo(() => {
    if (repoId && repos.some((r) => r.id === repoId)) return repoId;
    return repos.find((r) => commands.some((c) => c.repoId === r.id))?.id ?? repos[0]?.id ?? null;
  }, [repoId, repos, commands]);

  // Human commands on top; the ones agents saved for their own tasks below,
  // folded (docs/commands.md § Agent-owned commands). Archived ones are only
  // in the repo's command panel, where they can be restored.
  const repoCommands = useMemo(
    () => commands.filter((c) => c.repoId === effectiveRepoId && !c.archivedAt).sort(byOrder),
    [commands, effectiveRepoId],
  );
  const humanCommands = repoCommands.filter((c) => !c.ownerTaskId);
  const agentCommands = repoCommands.filter((c) => c.ownerTaskId);
  const agentLive = agentCommands.filter((c) => running.some((r) => r.commandId === c.id)).length;

  const commandRow = (c: RepoCommand) => {
    const live = running.find((r) => r.commandId === c.id);
    return (
      <div className="cmd-run" key={c.id}>
        <span className={`cmd-dot ${live ? 'live' : ''}`} aria-hidden="true" />
        <span className="cmd-run-main">
          <span className="cmd-run-name">{c.name}</span>
          <span className="mono muted cmd-run-sub" title={c.cwd ? `${c.command}\nin ${c.cwd}` : c.command}>
            {c.command}
            {c.cwd ? ` · ${c.cwd}` : ''}
            {c.ownerTaskId ? ` · task ${c.ownerTaskId.slice(0, 8)}` : ''}
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
  };

  const title = running.length
    ? `${running.length} command(s) running: ${running.map((r) => `${r.repoName} · ${r.name}`).join(', ')}`
    : 'Repo commands — dev servers and scripts';

  const content = (
    <>
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
        humanCommands.map(commandRow)
      )}

      {agentCommands.length > 0 && (
        <>
          <button
            className="btn ghost cmd-group-toggle"
            aria-expanded={showAgent}
            title="Commands agents saved for their own tasks — archived once the task lands or they go unused"
            onClick={() => setShowAgent((v) => !v)}
          >
            <span className={`cmd-chev ${showAgent ? 'open' : ''}`} aria-hidden="true">
              <IconChevron />
            </span>
            <span className="label" style={{ margin: 0 }}>
              agent-saved · {agentCommands.length}
              {agentLive > 0 ? ` · ${agentLive} running` : ''}
            </span>
          </button>
          {showAgent && agentCommands.map(commandRow)}
        </>
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
    </>
  );

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

      {open &&
        (mobile ? (
          <Sheet label="Repo commands" onClose={() => setOpen(false)}>
            <div className="cmd-sheet">{content}</div>
          </Sheet>
        ) : (
          <div className="cmd-pop" role="dialog" aria-label="Repo commands">
            {content}
          </div>
        ))}
    </span>
  );
}

const KIND_HINT =
  'service = long-running (dev server, watcher) — those show in the header indicator. ' +
  'check = a one-shot the server runs after every agent turn, before the review (exit 0 = green; docs/checks.md)';

/** The dropdown's three readings: a check is a one-shot with `isCheck` (docs/checks.md). */
type KindPick = RepoCommand['kind'] | 'check';
const kindPick = (c: Pick<RepoCommand, 'kind' | 'isCheck'>): KindPick => (c.isCheck ? 'check' : c.kind);
const kindFields = (k: KindPick): { kind: RepoCommand['kind']; isCheck: boolean } =>
  k === 'check' ? { kind: 'task', isCheck: true } : { kind: k, isCheck: false };

/** A check's timeout field: blank = the default; seconds otherwise. */
function parseTimeout(raw: string): number | null | 'bad' {
  const v = raw.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= CHECK_TIMEOUT_MIN_SEC && n <= CHECK_TIMEOUT_MAX_SEC ? n : 'bad';
}
const TIMEOUT_HINT = `seconds before the check is stopped and counted as "no verdict" (${CHECK_TIMEOUT_MIN_SEC}–${CHECK_TIMEOUT_MAX_SEC}; blank = ${CHECK_DEFAULT_TIMEOUT_SEC})`;

/** A saved check's timeout, edited in place and saved on blur / Enter. */
function CheckTimeout({ c, onError }: { c: RepoCommand; onError: (e: string | null) => void }) {
  const [v, setV] = useState(c.timeoutSec == null ? '' : String(c.timeoutSec));
  useEffect(() => setV(c.timeoutSec == null ? '' : String(c.timeoutSec)), [c.timeoutSec]);
  const save = async () => {
    const t = parseTimeout(v);
    if (t === 'bad') return onError(`timeout: ${TIMEOUT_HINT}`);
    if (t === c.timeoutSec) return;
    onError(null);
    try {
      await api.updateCommand(c.id, { timeoutSec: t });
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <input
      className="field mono cmd-timeout"
      inputMode="numeric"
      placeholder={`${CHECK_DEFAULT_TIMEOUT_SEC}s`}
      title={TIMEOUT_HINT}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void save();
      }}
    />
  );
}

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
  const mobile = useIsMobile();
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const { busy, err, run, stop } = useCommandActions(onOpenTerminal);

  const mine = useMemo(
    () => commands.filter((c) => c.repoId === repoId && !c.archivedAt).sort(humanFirst),
    [commands, repoId],
  );
  const running = commandRuns.filter((r) => r.status === 'running' && r.repoId === repoId);

  const place = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 380;
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    setAt({ top: rect.bottom + 6, left });
  };

  // a phone opens a sheet instead, which brings its own backdrop and Escape
  useEffect(() => {
    if (!at || mobile) return;
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
  }, [at, mobile]);

  const menu = (
    <>
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
    </>
  );

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
      {at &&
        (mobile ? (
          <Sheet label="Repo commands" title="Commands" onClose={() => setAt(null)}>
            <div className="cmd-sheet">{menu}</div>
          </Sheet>
        ) : (
          <div ref={popRef} className="cmd-pop cmd-menu" role="menu" style={{ top: at.top, left: at.left }}>
            {menu}
          </div>
        ))}
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
  const [kind, setKind] = useState<KindPick>('task');
  const [timeout, setTimeoutText] = useState('');
  const [cwd, setCwd] = useState('');
  const [saving, setSaving] = useState(false);
  const [scripts, setScripts] = useState<ScannedScript[] | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [picked, setPicked] = useState<string>('');
  const [showArchived, setShowArchived] = useState(false);

  const all = useMemo(() => commands.filter((c) => c.repoId === repoId), [commands, repoId]);
  const mine = useMemo(() => all.filter((c) => !c.archivedAt).sort(humanFirst), [all]);
  const archived = useMemo(
    () => all.filter((c) => c.archivedAt).sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? '')),
    [all],
  );
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
    const timeoutSec = kind === 'check' ? parseTimeout(timeout) : null;
    if (timeoutSec === 'bad') return setErr(`timeout: ${TIMEOUT_HINT}`);
    setSaving(true);
    setErr(null);
    try {
      await api.createCommand({
        repoId,
        name: name.trim() || line.trim(),
        command: line.trim(),
        ...kindFields(kind),
        timeoutSec,
        cwd: cwd.trim() || null,
      });
      setName('');
      setLine('');
      setCwd('');
      setKind('task');
      setTimeoutText('');
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

  const archive = async (c: RepoCommand) => {
    setErr(null);
    try {
      await api.archiveCommand(c.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const restore = async (c: RepoCommand) => {
    setErr(null);
    try {
      await api.restoreCommand(c.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const setKindOf = async (c: RepoCommand, next: KindPick) => {
    setErr(null);
    try {
      await api.updateCommand(c.id, kindFields(next));
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
              {c.ownerTaskId && (
                <span
                  className="chip"
                  title={`Saved by the agent of task ${c.ownerTaskId} — archived once that task lands or it goes unused. Editing it makes it yours.`}
                >
                  agent · {c.ownerTaskId.slice(0, 8)}
                </span>
              )}
              {c.isCheck && <CheckTimeout c={c} onError={setErr} />}
              <select
                className="field cmd-select"
                value={kindPick(c)}
                title={KIND_HINT}
                onChange={(e) => setKindOf(c, e.target.value as KindPick)}
              >
                <option value="task">one-shot</option>
                <option value="service">service</option>
                <option value="check">check</option>
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
              {!c.isCheck && (
                <button className="btn ghost" title="Archive: hide it from the launcher (restorable below)" onClick={() => archive(c)}>
                  <IconX />
                </button>
              )}
              <button className="btn ghost" title="Delete this command" onClick={() => del(c)}>
                <IconTrash />
              </button>
            </div>
          );
        })
      )}

      {archived.length > 0 && (
        <>
          <button
            className="btn ghost cmd-group-toggle"
            aria-expanded={showArchived}
            title="Commands hidden from the launcher — by the agent-command cleanup or by hand"
            onClick={() => setShowArchived((v) => !v)}
          >
            <span className={`cmd-chev ${showArchived ? 'open' : ''}`} aria-hidden="true">
              <IconChevron />
            </span>
            <span className="label" style={{ margin: 0 }}>
              archived · {archived.length}
            </span>
          </button>
          {showArchived &&
            archived.map((c) => (
              <div className="cmd-row" key={c.id}>
                <span className="cmd-dot" aria-hidden="true" />
                <span className="cmd-run-main">
                  <span className="cmd-run-name">{c.name}</span>
                  <span className="mono muted cmd-run-sub">
                    {c.command}
                    {c.cwd ? ` · ${c.cwd}` : ''}
                    {c.ownerTaskId ? ` · task ${c.ownerTaskId.slice(0, 8)}` : ''}
                  </span>
                </span>
                <button className="btn" title="Bring it back to the launcher — it becomes yours" onClick={() => restore(c)}>
                  <IconRefresh /> Restore
                </button>
                <button className="btn ghost" title="Delete this command" onClick={() => del(c)}>
                  <IconTrash />
                </button>
              </div>
            ))}
        </>
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

        {scripts && <SuggestedChecks repoId={repoId} scripts={scripts} saved={mine} onOpenTerminal={onOpenTerminal} />}

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
          <select className="field cmd-select" value={kind} title={KIND_HINT} onChange={(e) => setKind(e.target.value as KindPick)}>
            <option value="task">one-shot</option>
            <option value="service">service</option>
            <option value="check">check</option>
          </select>
          {kind === 'check' && (
            <input
              className="field mono cmd-timeout"
              inputMode="numeric"
              placeholder={`${CHECK_DEFAULT_TIMEOUT_SEC}s`}
              title={TIMEOUT_HINT}
              value={timeout}
              onChange={(e) => setTimeoutText(e.target.value)}
            />
          )}
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

/** What a scanned script is saved as: a workspace script keeps its package in
 *  the name, so two `dev` scripts from different packages stay distinguishable. */
const scannedName = (s: ScannedScript) => (s.cwd ? `${s.packageName.split('/').pop()} · ${s.name}` : s.name);

const BASELINE_POLL_MS = 2000;

/**
 * The scanner's rule-based check suggestions (docs/checks.md § Suggested
 * checks). One click per check: "Save as check" runs the BASELINE first — the
 * command once on the current tree — and a green one is saved at once; a red
 * or no-verdict one shows its output and is saved only on an explicit "Save
 * anyway". Nothing is ever saved without that click.
 */
function SuggestedChecks({
  repoId,
  scripts,
  saved,
  onOpenTerminal,
}: {
  repoId: string;
  scripts: ScannedScript[];
  saved: RepoCommand[];
  onOpenTerminal?: (runId: string) => void;
}) {
  const { commandRuns } = useApp();
  const [baselines, setBaselines] = useState<Record<string, CheckBaseline>>({});
  /** rows whose `instead` line replaced the script (the side effect is gone) */
  const [instead, setInstead] = useState<Record<string, boolean>>({});
  const [rowErr, setRowErr] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  /** rows whose green baseline should be saved the moment it lands */
  const saveOnGreen = useRef(new Set<string>());

  const rows = useMemo(
    () =>
      scripts
        .filter((s) => s.suggestedCheck)
        .sort((a, b) => Number(b.suggestedCheck!.preselect) - Number(a.suggestedCheck!.preselect)),
    [scripts],
  );

  const lineOf = (s: ScannedScript) => (instead[scriptKey(s)] && s.suggestedCheck?.instead ? s.suggestedCheck.instead : s.suggested);
  const savedAs = (s: ScannedScript) =>
    saved.find((c) => c.isCheck && c.command === lineOf(s) && (c.cwd ?? '') === s.cwd);

  const setOne = <T,>(set: Dispatch<SetStateAction<Record<string, T>>>, key: string, v: NoInfer<T>) =>
    set((cur) => ({ ...cur, [key]: v }));

  const save = async (s: ScannedScript, b: CheckBaseline, acceptRed: boolean) => {
    const key = scriptKey(s);
    setOne(setBusy, key, true);
    setOne(setRowErr, key, null);
    try {
      await api.createCommand({
        repoId,
        name: b.name,
        command: b.command,
        kind: 'task',
        cwd: b.cwd || null,
        isCheck: true,
        timeoutSec: b.timeoutSec,
        baselineId: b.id,
        ...(acceptRed ? { acceptRed: true } : {}),
      });
    } catch (e) {
      setOne(setRowErr, key, (e as Error).message);
    } finally {
      setOne(setBusy, key, false);
    }
  };

  // Poll the running baselines; a green one that was asked to save, saves.
  const runningIds = Object.entries(baselines)
    .filter(([, b]) => b.status === 'running')
    .map(([k, b]) => `${k}=${b.id}`)
    .join(',');
  useEffect(() => {
    if (!runningIds) return;
    const t = setInterval(async () => {
      for (const pair of runningIds.split(',')) {
        const [key, id] = pair.split('=');
        try {
          const b = await api.getBaseline(id);
          if (b.status === 'running') continue;
          setOne(setBaselines, key, b);
          const s = rows.find((r) => scriptKey(r) === key);
          if (s && b.verdict === 'green' && saveOnGreen.current.delete(key)) void save(s, b, false);
        } catch (e) {
          saveOnGreen.current.delete(key);
          setOne(setRowErr, key, (e as Error).message);
          setBaselines((cur) => {
            const next = { ...cur };
            delete next[key];
            return next;
          });
        }
      }
    }, BASELINE_POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningIds]);

  const runBaseline = async (s: ScannedScript) => {
    const key = scriptKey(s);
    const sug = s.suggestedCheck!;
    if (sug.sideEffect && !instead[key]) {
      const ok = confirm(
        `"${s.name}" ${sug.sideEffect}.\n\nA check runs after EVERY agent turn — save it anyway? It runs once now on the current tree first (the baseline).`,
      );
      if (!ok) return;
    }
    setOne(setBusy, key, true);
    setOne(setRowErr, key, null);
    try {
      const b = await api.startBaseline({ repoId, name: scannedName(s), command: lineOf(s), cwd: s.cwd || null });
      saveOnGreen.current.add(key);
      setOne(setBaselines, key, b);
    } catch (e) {
      setOne(setRowErr, key, (e as Error).message);
    } finally {
      setOne(setBusy, key, false);
    }
  };

  const saveAnyway = (s: ScannedScript, b: CheckBaseline) => {
    const why = b.verdict === 'red' ? `exited ${b.exit}` : `gave no verdict (${b.error})`;
    const ok = confirm(
      `The baseline ${why} on the current tree.\n\nSaved like this, every task in this repo gets up to the check fix rounds for a failure that is not its own. Save "${b.name}" as a check anyway?`,
    );
    if (ok) void save(s, b, true);
  };

  if (rows.length === 0) return null;
  return (
    <div className="cmd-suggest">
      <div className="cmd-suggest-head">
        <span className="cmd-run-name">Suggested checks</span>
        <span className="muted cmd-suggest-hint">
          from CI and script names — each runs once on the current tree (baseline) before it is saved
        </span>
      </div>
      {rows.map((s) => {
        const key = scriptKey(s);
        const sug = s.suggestedCheck!;
        const b = baselines[key];
        const usingInstead = !!instead[key] && !!sug.instead;
        const done = savedAs(s);
        const live = b && b.status === 'running' ? commandRuns.find((r) => r.commandId === b.id && r.status === 'running') : null;
        const termId = live?.id ?? b?.runId ?? null;
        return (
          <div className="cmd-suggest-row" key={key}>
            <div className="cmd-suggest-line">
              <span className="cmd-run-main">
                <span className="cmd-run-name">{scannedName(s)}</span>
                <span className="mono muted cmd-run-sub" title={s.script}>
                  {lineOf(s)}
                  {s.cwd ? ` · ${s.cwd}` : ''}
                </span>
              </span>
              <span className="chip">{sug.reason}</span>
              {b && <BaselineChip b={b} />}
              {termId && (
                <button className="btn ghost" title="Open the baseline run's terminal" onClick={() => onOpenTerminal?.(termId)}>
                  <IconTerminal />
                </button>
              )}
              {done ? (
                <span className="chip verdict v-clean">saved as check</span>
              ) : b?.status === 'running' ? (
                <button className="btn" disabled>
                  Baseline…
                </button>
              ) : b && b.verdict !== 'green' ? (
                <>
                  <button className="btn" disabled={busy[key]} onClick={() => runBaseline(s)} title="Run the baseline again">
                    <IconRefresh /> Re-run
                  </button>
                  <button className="btn danger" disabled={busy[key]} onClick={() => saveAnyway(s, b)}>
                    Save anyway
                  </button>
                </>
              ) : b && b.verdict === 'green' ? (
                <button className="btn primary" disabled={busy[key]} onClick={() => save(s, b, false)}>
                  Save as check
                </button>
              ) : (
                <button
                  className={`btn ${sug.preselect || usingInstead ? 'primary' : ''}`}
                  disabled={busy[key]}
                  onClick={() => runBaseline(s)}
                  title="Runs it once on the current tree; a green baseline is saved as a check"
                >
                  Save as check
                </button>
              )}
            </div>
            {sug.sideEffect && !usingInstead && (
              <div className="warn-text">
                {sug.sideEffect}
                {sug.instead ? ' — ' : ''}
                {sug.instead && (
                  <button
                    className="btn ghost cmd-suggest-instead"
                    disabled={!!b && b.status === 'running'}
                    onClick={() => {
                      setOne(setInstead, key, true);
                      setBaselines((cur) => {
                        const next = { ...cur };
                        delete next[key];
                        return next;
                      });
                    }}
                  >
                    use <span className="mono">{sug.instead}</span> instead
                  </button>
                )}
              </div>
            )}
            {b?.status === 'done' && b.verdict !== 'green' && (
              <pre className="check-tail">
                {b.dirty > 0
                  ? `ran on ${b.branch ?? 'HEAD'} with ${b.dirty} uncommitted change(s) — another task's work may be the cause\n\n`
                  : ''}
                {b.error ? `${b.error}\n` : ''}
                {b.tail || '(no output)'}
              </pre>
            )}
            {rowErr[key] && <div className="warn-text">{rowErr[key]}</div>}
          </div>
        );
      })}
    </div>
  );
}

function BaselineChip({ b }: { b: CheckBaseline }) {
  if (b.status === 'running') return <span className="chip verdict v-pending">baseline running</span>;
  const secs = `${Math.max(1, Math.round(b.durationMs / 1000))}s`;
  if (b.verdict === 'green') return <span className="chip verdict v-clean">baseline green · {secs}</span>;
  if (b.verdict === 'red') return <span className="chip verdict v-blocker">baseline red · exit {b.exit}</span>;
  return <span className="chip verdict v-error">baseline: no verdict</span>;
}
