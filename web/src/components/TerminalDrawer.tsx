import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalServerMsg } from '@tm/shared';
import { useApp } from '../state.tsx';
import { IconChevron, IconX } from './Icons.tsx';
import { useIsMobile } from './Layout.tsx';

const b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/**
 * The bytes a sticky Ctrl produces. A control character is the letter's code
 * with bit 6 cleared: `c & 0x1f` — so 'c' (0x63) and 'C' (0x43) both give 0x03.
 * The range covers `@ A-Z [ \ ] ^ _` and `a-z`; `?` is the odd one out (DEL).
 * Anything else (a digit, an escape sequence, a paste) passes through untouched.
 */
const withCtrl = (d: string): string => {
  if (d.length !== 1) return d;
  const c = d.charCodeAt(0);
  if (c === 63) return '\x7f';
  if ((c >= 64 && c <= 95) || (c >= 97 && c <= 122)) return String.fromCharCode(c & 0x1f);
  return d;
};

/** The keys a phone soft keyboard does not have, in the order they are shown. */
const KEY_ROW: { label: string; seq: string; title: string }[] = [
  { label: 'Esc', seq: '\x1b', title: 'Escape — interrupt the agent' },
  { label: 'Tab', seq: '\t', title: 'Tab — accept the completion' },
  { label: '\u2191', seq: '\x1b[A', title: 'Up' },
  { label: '\u2193', seq: '\x1b[B', title: 'Down' },
  { label: '\u2190', seq: '\x1b[D', title: 'Left' },
  { label: '\u2192', seq: '\x1b[C', title: 'Right' },
];

export function TerminalDrawer({
  runId,
  expandSignal = 0,
  onClose,
}: {
  runId: string;
  /** bumped by the app each time something asks to open a terminal — re-expands a compacted drawer */
  expandSignal?: number;
  onClose: () => void;
}) {
  const { token, runs, tasks, commandRuns, activity, settings } = useApp();
  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Set by the xterm effect; lets expand/resize refit without re-running it.
  const refitRef = useRef<(() => void) | null>(null);
  // Same escape hatch as refitRef: the key row sends through the ONE input path
  // the keyboard already uses, rather than opening a second socket.
  const sendRef = useRef<((d: string) => void) | null>(null);
  const focusRef = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<'connecting' | 'live' | 'closed'>('connecting');
  const [compact, setCompact] = useState(false);
  const mobile = useIsMobile();
  // Sticky Ctrl is read inside the xterm effect (which must not re-run on every
  // toggle), so it lives in a ref; the useState copy only paints the on/off pip.
  const ctrlRef = useRef(false);
  const [ctrl, setCtrl] = useState(false);
  // Stable identity: touches a ref and a setState, both stable across renders.
  const setCtrlOn = useCallback((on: boolean) => {
    ctrlRef.current = on;
    setCtrl(on);
  }, []);

  const clickOutside = settings?.['terminal.clickOutside'] ?? 'compact';

  const expand = () => {
    setCompact(false);
    // refit after the body is visible again — while compacted it measures 0×0
    requestAnimationFrame(() => refitRef.current?.());
  };

  // Any request to open a terminal (this one or another) starts expanded.
  useEffect(() => {
    setCompact(false);
    requestAnimationFrame(() => refitRef.current?.());
  }, [runId, expandSignal]);

  // The key row is a sibling of .term-body, so mounting or unmounting it changes
  // the terminal's height without a window resize — refit or the PTY keeps the
  // old row count. rAF so the measure happens after the row has laid out.
  useEffect(() => {
    const id = requestAnimationFrame(() => refitRef.current?.());
    return () => cancelAnimationFrame(id);
  }, [mobile, compact]);

  // A modifier armed on a terminal you can no longer see would fire on whatever
  // you type next in the one you open after it.
  useEffect(() => {
    if (!mobile || compact) setCtrlOn(false);
  }, [mobile, compact, runId, setCtrlOn]);

  // Click outside the expanded drawer → close / compact per setting. mousedown,
  // not click, so drag-selects that end outside the drawer don't count.
  useEffect(() => {
    if (compact || clickOutside === 'nothing') return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        if (clickOutside === 'close') onClose();
        else setCompact(true);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [compact, clickOutside, onClose]);

  useEffect(() => {
    if (!hostRef.current || !token) return;
    // Guards handlers of a socket the cleanup already closed (StrictMode, R2).
    let disposed = false;

    // Colors from docs/tm-design-tokens.html (--tm-terminal-bg / -text);
    // xterm needs concrete values, not CSS variables.
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 12.5,
      theme: { background: '#0a0c0e', foreground: '#d2f5ec', cursor: '#2dd4bf' },
      scrollback: 8000,
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/terminal/${runId}?token=${token}`);
    const encoder = new TextEncoder();

    const refit = () => {
      // While compacted the body is display:none and measures 0 wide — fitting
      // then would shrink the PTY to 2×1 cells; expand() refits instead.
      if (disposed || !hostRef.current || hostRef.current.clientWidth === 0) return;
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    refitRef.current = refit;
    fit.fit(); // initial fit so the terminal fills the drawer before history arrives (R4)

    const writeChunked = (bytes: Uint8Array) => {
      // 64KiB slices keep a 2MiB history replay from janking one frame.
      for (let i = 0; i < bytes.length; i += 65536) {
        term.write(bytes.subarray(i, i + 65536));
      }
    };

    ws.onopen = () => {
      if (!disposed) setStatus('live');
    };
    ws.onmessage = (ev) => {
      if (disposed) return;
      let msg: TerminalServerMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      try {
        if (msg.type === 'history') {
          writeChunked(b64ToBytes(msg.data));
          // resize AFTER replay: SIGWINCH forces a clean redraw over any seam artifacts
          requestAnimationFrame(refit);
        } else if (msg.type === 'data') {
          writeChunked(b64ToBytes(msg.data));
        } else if (msg.type === 'exit') {
          term.write(`\r\n\x1b[2m[session exited${msg.code === null ? '' : ` with code ${msg.code}`}]\x1b[0m\r\n`);
          setStatus('closed');
        }
      } catch {
        // malformed frame (bad base64 etc.) — drop it rather than crash the drawer (R5)
      }
    };
    ws.onclose = () => {
      if (!disposed) setStatus('closed');
    };

    // The single input path. Everything typed — soft keyboard, hardware keyboard
    // or the mobile key row — arrives here, so the sticky Ctrl is applied once.
    const send = (d: string) => {
      let out = d;
      if (ctrlRef.current) {
        out = withCtrl(d);
        // One keypress and Ctrl is spent, mapped or not — a modifier that can
        // stay armed after a key is a modifier you cannot see is stuck.
        setCtrlOn(false);
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: bytesToB64(encoder.encode(out)) }));
      }
    };
    sendRef.current = send;
    focusRef.current = () => term.focus();

    const dataSub = term.onData(send);

    window.addEventListener('resize', refit);

    // StrictMode double-mount safe: everything opened here is disposed here.
    return () => {
      disposed = true;
      refitRef.current = null;
      sendRef.current = null;
      focusRef.current = null;
      window.removeEventListener('resize', refit);
      dataSub.dispose();
      ws.close();
      term.dispose();
    };
  }, [runId, token, setCtrlOn]);

  // Compact-bar identity: an agent run resolves to its task, a command run to
  // its saved definition; either may be gone (finished, pruned) — degrade to id.
  const run = runs.find((r) => r.id === runId) ?? null;
  const cmdRun = run ? null : commandRuns.find((r) => r.id === runId) ?? null;
  const task = run?.taskId ? tasks.find((t) => t.id === run.taskId) ?? null : null;
  const name = task?.title ?? (cmdRun ? `${cmdRun.name} — ${cmdRun.repoName}` : `session ${runId.slice(0, 8)}`);
  // An idle run's PTY is still 'running' but the agent is done — not green.
  const live = run ? run.status === 'running' && !run.idle : cmdRun ? cmdRun.status === 'running' : status === 'live';
  const inReview = task?.status === 'review';
  const dotClass = inReview ? 'review' : live ? 'running' : 'off';
  const activityLine =
    activity[runId]?.text ?? (cmdRun ? cmdRun.command : status === 'closed' ? 'session ended' : 'no recent activity');

  // Keeps focus (and therefore the soft keyboard) on the terminal: a tap that
  // moves focus to the button would dismiss the keyboard on every keypress.
  const holdFocus = (e: ReactMouseEvent) => e.preventDefault();

  const pressKey = (seq: string) => {
    sendRef.current?.(seq);
    focusRef.current?.();
  };

  return (
    <div className={`term-drawer ${compact ? 'compact' : ''}`} ref={rootRef}>
      {compact && (
        <div className="term-compact" onClick={expand} title="Expand terminal">
          <span className={`term-compact-dot ${dotClass}`} />
          <span className="term-compact-text">
            <span className="term-compact-name">{name}</span>
            <span className="term-compact-activity">{activityLine}</span>
          </span>
          <span style={{ flex: 1 }} />
          <button
            className="btn ghost"
            title="Expand terminal"
            onClick={(e) => {
              e.stopPropagation();
              expand();
            }}
          >
            <span className="term-chevron up">
              <IconChevron />
            </span>
          </button>
        </div>
      )}
      <div className="term-head">
        <span>{name}</span>
        <span className={`badge ${status === 'live' ? 's-running' : ''}`}>
          <span className="dot" /> {status}
        </span>
        <span style={{ flex: 1 }} />
        <button
          className="btn ghost"
          title="Compact terminal"
          onClick={() => setCompact(true)}
        >
          <span className="term-chevron">
            <IconChevron />
          </span>
        </button>
        <button className="btn ghost" title="Close terminal" onClick={onClose}>
          <IconX />
        </button>
      </div>
      {mobile && (
        /* Phones only: a soft keyboard has no Esc, Tab, Ctrl or arrows, which is
           exactly what an interactive `claude` needs. Scrolls sideways so a
           narrow phone clips nothing. */
        <div className="term-keys" role="group" aria-label="Terminal keys">
          <button
            type="button"
            className={`term-key ${ctrl ? 'on' : ''}`}
            title="Ctrl — applies to the next key, then clears"
            aria-pressed={ctrl}
            onMouseDown={holdFocus}
            onClick={() => {
              setCtrlOn(!ctrlRef.current);
              focusRef.current?.();
            }}
          >
            Ctrl
          </button>
          {KEY_ROW.map((k) => (
            <button
              type="button"
              key={k.label}
              className="term-key"
              title={k.title}
              onMouseDown={holdFocus}
              onClick={() => pressKey(k.seq)}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
      <div className="term-body" ref={hostRef} />
    </div>
  );
}
