import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalServerMsg } from '@tm/shared';
import { useApp } from '../state.tsx';
import { IconX } from './Icons.tsx';

const b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

export function TerminalDrawer({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { token } = useApp();
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'live' | 'closed'>('connecting');

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
    fit.fit(); // initial fit so the terminal fills the drawer before history arrives (R4)

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/terminal/${runId}?token=${token}`);
    const encoder = new TextEncoder();

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
          requestAnimationFrame(() => {
            if (disposed) return;
            fit.fit();
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
            }
          });
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

    const dataSub = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: bytesToB64(encoder.encode(d)) }));
      }
    });

    const onResize = () => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    window.addEventListener('resize', onResize);

    // StrictMode double-mount safe: everything opened here is disposed here.
    return () => {
      disposed = true;
      window.removeEventListener('resize', onResize);
      dataSub.dispose();
      ws.close();
      term.dispose();
    };
  }, [runId, token]);

  return (
    <div className="term-drawer">
      <div className="term-head">
        <span>session {runId.slice(0, 8)}</span>
        <span className={`badge ${status === 'live' ? 's-running' : ''}`}>
          <span className="dot" /> {status}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={onClose}>
          <IconX />
        </button>
      </div>
      <div className="term-body" ref={hostRef} />
    </div>
  );
}
