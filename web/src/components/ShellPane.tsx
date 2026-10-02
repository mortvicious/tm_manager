import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalServerMsg } from '@tm/shared';
import { useApp } from '../state.tsx';
import { b64ToBytes, bytesToB64 } from './TerminalDrawer.tsx';
import { attachTouchScroll } from './termTouchScroll.ts';

export type PaneStatus = 'connecting' | 'live' | 'closed' | 'gone';

/**
 * An embedded terminal for the Terminal page (docs/terminals.md): the same
 * `/ws/terminal/:id` protocol as TerminalDrawer, without the drawer's chrome
 * (compact bar, phone key row, compose box). Phones open shells in the drawer
 * instead, because that is where those live; several of these can be mounted
 * at once (the grid), each with its own socket — the server fans one PTY out
 * to every attached client.
 */
export function ShellPane({
  shellId,
  focus = false,
  onStatus,
}: {
  shellId: string;
  /** take keyboard focus when mounted / when this becomes true */
  focus?: boolean;
  onStatus?: (s: PaneStatus) => void;
}) {
  const { token } = useApp();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [status, setStatus] = useState<PaneStatus>('connecting');
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useEffect(() => onStatusRef.current?.(status), [status]);

  useEffect(() => {
    if (!hostRef.current || !token) return;
    let disposed = false;
    setStatus('connecting');

    // Colors from docs/tm-design-tokens.html (--tm-terminal-bg / -text), as in
    // TerminalDrawer: xterm needs concrete values, not CSS variables.
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
    const detachTouch = attachTouchScroll(term, hostRef.current);
    termRef.current = term;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/terminal/${shellId}?token=${token}`);
    const encoder = new TextEncoder();

    const refit = () => {
      // A hidden pane (display:none tab) measures 0 — fitting then would
      // shrink the PTY to 2×1 and every other viewer with it.
      if (disposed || !hostRef.current || hostRef.current.clientWidth === 0) return;
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    // Initial fit so history replays at the pane's width — guarded like
    // refit(): a hidden tab would otherwise replay it at 2 columns.
    if (hostRef.current.clientWidth > 0) fit.fit();

    const writeChunked = (bytes: Uint8Array) => {
      for (let i = 0; i < bytes.length; i += 65536) term.write(bytes.subarray(i, i + 65536));
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
          // resize AFTER replay: the shell redraws its prompt at the real size
          requestAnimationFrame(refit);
        } else if (msg.type === 'data') {
          writeChunked(b64ToBytes(msg.data));
        } else if (msg.type === 'exit') {
          term.write(`\r\n\x1b[2m[shell exited${msg.code === null ? '' : ` with code ${msg.code}`}]\x1b[0m\r\n`);
          setStatus('closed');
        }
      } catch {
        // malformed frame — drop it rather than crash the page
      }
    };
    ws.onclose = (ev) => {
      if (disposed) return;
      // 4404: the server no longer holds this PTY (its scrollback outlived the
      // session TTL after the shell exited). Nothing to reconnect to.
      if (ev.code === 4404) {
        term.write('\r\n\x1b[2m[terminal no longer available]\x1b[0m\r\n');
        setStatus('gone');
      } else setStatus('closed');
    };

    const dataSub = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: bytesToB64(encoder.encode(d)) }));
      }
    });

    // Debounced like the drawer: each resize message is a SIGWINCH and a full
    // redraw of whatever runs in the shell. A timer, not rAF, so a hidden
    // browser tab still ends up at the right size.
    let pending: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefit = () => {
      clearTimeout(pending);
      pending = setTimeout(refit, 60);
    };
    const ro = new ResizeObserver(scheduleRefit);
    ro.observe(hostRef.current);
    window.addEventListener('resize', scheduleRefit);

    return () => {
      disposed = true;
      termRef.current = null;
      clearTimeout(pending);
      ro.disconnect();
      window.removeEventListener('resize', scheduleRefit);
      dataSub.dispose();
      detachTouch();
      ws.close();
      term.dispose();
    };
  }, [shellId, token]);

  useEffect(() => {
    if (focus) termRef.current?.focus();
  }, [focus, shellId]);

  return <div className="shell-pane-body" ref={hostRef} onMouseDown={() => termRef.current?.focus()} />;
}
