import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BackgroundShell } from '@tm/shared';
import { api } from '../api.ts';
import { useArm } from '../arm.ts';
import { useApp } from '../state.tsx';
import { toastError } from '../toast.ts';
import { IconEye, IconStop, IconX } from './Icons.tsx';
import { useIsMobile } from './Layout.tsx';
import { Sheet } from './Sheet.tsx';
import { useNow } from './TimeAgo.tsx';

/**
 * Agents' background shells (docs/terminals.md § Background shells): the
 * `run_in_background` / timeout-backgrounded Bash commands of live worker
 * runs, as the server last saw them. Watch opens the output file the CLI
 * reported, read-only; Kill signals that one shell's process group. Used by
 * the /terminals page (every task) and the task panel (`taskId`: that task's).
 */
export function BackgroundShellList({
  taskId,
  onOpenTask,
}: {
  /** only this task's shells (the task panel) */
  taskId?: string;
  onOpenTask?: (id: string) => void;
}) {
  const { backgroundShells, repos } = useApp();
  const mobile = useIsMobile();
  const arm = useArm();
  const now = useNow();
  const [watching, setWatching] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shells = useMemo(
    () => (taskId ? backgroundShells.filter((s) => s.taskId === taskId) : backgroundShells),
    [backgroundShells, taskId],
  );
  const running = shells.filter((s) => s.state === 'running');
  const keyOf = (s: BackgroundShell) => `${s.runId}:${s.shellId}`;
  const watched = shells.find((s) => keyOf(s) === watching) ?? null;
  const again = mobile ? 'tap again' : 'click again';

  // the watched shell left the list (its run ended): close the viewer
  useEffect(() => {
    if (watching && !watched) setWatching(null);
  }, [watching, watched]);

  const kill = async (s: BackgroundShell) => {
    if (!arm.press(`kill:${keyOf(s)}`)) return;
    try {
      await api.killBackgroundShell(s.runId, s.shellId);
    } catch (e) {
      toastError(e, 'Kill');
    }
  };

  const killAll = async () => {
    if (!arm.press('kill-all') || busy) return;
    setBusy(true);
    try {
      const r = await api.killAllBackgroundShells(taskId);
      if (!r.killed.length && r.missed.length) toastError(new Error(r.missed[0].reason), 'Kill all');
    } catch (e) {
      toastError(e, 'Kill all');
    }
    setBusy(false);
  };

  if (!shells.length) {
    return taskId ? null : (
      <div className="empty panel">
        <div className="big">No agent shells</div>
        Background commands an agent starts (a dev server, a long test run, a command its Bash timeout moved to the
        background) show up here once its turn ends — to watch or to kill.
      </div>
    );
  }

  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? 'repo removed';

  const row = (s: BackgroundShell) => {
    const k = keyOf(s);
    const killArmed = arm.armed === `kill:${k}`;
    const started = Date.parse(s.startedAt);
    const isWatched = watching === k;
    return (
      <div key={k} className={`bgsh-row${isWatched ? ' on' : ''}`}>
        <div className="bgsh-main">
          <span
            className={`cmd-dot${s.state === 'running' ? ' live' : s.state === 'killed' ? ' bad' : ''}`}
            aria-hidden="true"
          />
          <span className="bgsh-cmd mono" title={s.command}>
            {s.description || s.command || s.shellId}
          </span>
          {s.holdsWait && (
            <span className="chip bgsh-holds" title="This shell keeps the task in waiting (docs/design.md § Waiting)">
              holds waiting
            </span>
          )}
          <span className={`chip bgsh-state s-${s.state}`}>{s.state}</span>
        </div>
        {s.description && s.command && (
          <div className="bgsh-sub mono" title={s.command}>
            {s.command}
          </div>
        )}
        <div className="bgsh-foot">
          <div className="bgsh-meta">
            {!taskId && (
              <>
                {onOpenTask ? (
                  <button className="bgsh-task" onClick={() => onOpenTask(s.taskId)} title="Open the task">
                    {s.taskTitle || s.taskId.slice(0, 8)}
                  </button>
                ) : (
                  <span>{s.taskTitle}</span>
                )}
                <span className="bgsh-sep"> · </span>
                <span>{repoName(s.repoId)}</span>
                <span className="bgsh-sep"> · </span>
              </>
            )}
            <span
              className="mono"
              title={`${s.startedKnown ? 'started' : 'first seen'} ${new Date(started).toLocaleString()}${s.pid ? ` · pid ${s.pid}` : ''} · id ${s.shellId}`}
            >
              {s.startedKnown ? '' : '≥ '}
              {new Date(started).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
              {s.state === 'running' ? ` · ${fmtElapsed(now - started)}` : ''}
            </span>
          </div>
          <div className="bgsh-actions">
            {s.hasOutput && (
              <button
                className={`btn ghost${isWatched ? ' on' : ''}`}
                aria-pressed={isWatched}
                onClick={() => setWatching(isWatched ? null : k)}
              >
                <IconEye /> {isWatched ? 'Hide' : 'Watch'}
              </button>
            )}
            {s.state === 'running' && (
              <button
                className={`btn${killArmed ? ' danger armed' : ' ghost'}`}
                aria-live="polite"
                title="SIGTERM this shell and everything it started. The agent's session keeps running."
                onClick={() => void kill(s)}
              >
                <IconStop /> {killArmed ? `Kill? ${again}` : 'Kill'}
              </button>
            )}
          </div>
        </div>
        {isWatched && !mobile && <ShellOutput shell={s} />}
      </div>
    );
  };

  return (
    <div className={`bgsh${taskId ? ' in-task' : ''}`}>
      <div className="bgsh-head">
        {taskId ? (
          <div className="section-head">Background shells</div>
        ) : (
          <span className="bgsh-count">
            {running.length} running
            {shells.length > running.length ? ` · ${shells.length - running.length} finished` : ''}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {running.length > 0 && (
          <button
            className={`btn${arm.armed === 'kill-all' ? ' danger armed' : ' ghost'}`}
            aria-live="polite"
            disabled={busy}
            title="Kill every running background shell listed here. Agent sessions, repo commands and your own terminals are never touched."
            onClick={() => void killAll()}
          >
            <IconStop /> {arm.armed === 'kill-all' ? `Kill ${running.length}? ${again}` : 'Kill all'}
          </button>
        )}
      </div>
      <div className="bgsh-list">{shells.map(row)}</div>
      {mobile && watched && (
        <Sheet
          label={`Output of ${watched.description || watched.command}`}
          tall
          bodyClassName="sheet-body bgsh-sheet"
          onClose={() => setWatching(null)}
          head={(close) => (
            <div className="bgsh-sheet-head">
              <span className={`cmd-dot${watched.state === 'running' ? ' live' : ''}`} aria-hidden="true" />
              <span className="mono bgsh-cmd">{watched.description || watched.command}</span>
              <button className="btn ghost" aria-label="Close" onClick={close}>
                <IconX />
              </button>
            </div>
          )}
        >
          <ShellOutput shell={watched} inSheet />
        </Sheet>
      )}
    </div>
  );
}

/** "<1m" / "12m" / "1h 05m" / "2d 3h" */
function fmtElapsed(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** what the viewer keeps — the end of a long output is the part that matters */
const KEEP_CHARS = 400_000;
const POLL_MS = 1_000;

// CSI / OSC / single-char escapes: the viewer is plain text, not a terminal
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/** Plain text as a terminal would leave it: escapes dropped, a `\r` overwrites its line (progress bars). */
function plain(raw: string): string {
  return raw
    .replace(ANSI, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => (l.includes('\r') ? l.slice(l.lastIndexOf('\r') + 1) : l))
    .join('\n');
}

/**
 * The live tail of one shell's output file, read-only: the last 64 KiB first,
 * then every new byte once a second while the shell runs (and one more read
 * after it stops). Sticks to the bottom unless the reader scrolled up.
 */
function ShellOutput({ shell, inSheet }: { shell: BackgroundShell; inSheet?: boolean }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [size, setSize] = useState(0);
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const live = shell.state === 'running';
  const liveRef = useRef(live);
  liveRef.current = live;

  useEffect(() => {
    let next: number | undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finalRead = false;
    setText('');
    setErr(null);
    const tick = async () => {
      try {
        const r = await api.backgroundShellOutput(shell.runId, shell.shellId, next);
        if (stopped) return;
        setErr(null);
        setSize(r.size);
        if (r.reset) setText('');
        if (r.text) setText((cur) => (cur + r.text).slice(-KEEP_CHARS));
        next = r.next;
        // more than one read's worth waiting: fetch it straight away
        if (r.next < r.size) {
          timer = setTimeout(() => void tick(), 0);
          return;
        }
      } catch (e) {
        if (stopped) return;
        setErr((e as Error).message);
      }
      if (!liveRef.current) {
        if (finalRead) return;
        finalRead = true;
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [shell.runId, shell.shellId]);

  const shown = useMemo(() => plain(text), [text]);

  // In a sheet the library's scroller scrolls (a nested one would break its
  // drag-from-the-top), so stick to ITS bottom; elsewhere the <pre> scrolls.
  const scroller = (): HTMLElement | null => (inSheet ? scrollParent(box.current) : box.current);
  useEffect(() => {
    const el = scroller();
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inSheet]);
  useLayoutEffect(() => {
    const el = scroller();
    if (el && stick.current) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, inSheet]);

  return (
    <div className={`bgsh-out${inSheet ? ' in-sheet' : ''}`}>
      <div className="bgsh-out-meta mono">
        <span>{fmtBytes(size)}</span>
        {live ? <span className="bgsh-live">live</span> : <span>{shell.state}</span>}
        {err && <span className="bgsh-err">{err}</span>}
      </div>
      <pre ref={box} className="bgsh-pre mono" tabIndex={0} aria-label="Shell output">
        {shown || (err ? '' : 'No output yet.')}
      </pre>
    </div>
  );
}

/** the nearest ancestor that scrolls vertically */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll') return p;
  }
  return null;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}
