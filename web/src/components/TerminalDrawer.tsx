import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, MouseEvent as ReactMouseEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalServerMsg } from '@tm/shared';
import { useApp } from '../state.tsx';
import { IconArrowDown, IconChevron, IconSend, IconX } from './Icons.tsx';
import { useIsMobile } from './Layout.tsx';
import { attachTouchScroll } from './termTouchScroll.ts';

export const b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
export const bytesToB64 = (bytes: Uint8Array): string => {
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

/**
 * The keys a phone soft keyboard does not have, in the order they are shown:
 * what steering an interactive `claude` takes most, first. Enter and the digits
 * answer its pickers (permission prompts, AskUserQuestion drawn in the PTY)
 * without opening the keyboard at all.
 */
const KEY_ROW: { label: string; seq: string; title: string }[] = [
  { label: 'Esc', seq: '\x1b', title: 'Escape — interrupt the agent' },
  { label: '\u23ce', seq: '\r', title: 'Enter — submit, or confirm the highlighted choice' },
  { label: '\u2191', seq: '\x1b[A', title: 'Up' },
  { label: '\u2193', seq: '\x1b[B', title: 'Down' },
  { label: '1', seq: '1', title: 'Pick option 1' },
  { label: '2', seq: '2', title: 'Pick option 2' },
  { label: '3', seq: '3', title: 'Pick option 3' },
  { label: 'Tab', seq: '\t', title: 'Tab — accept the completion' },
  { label: '\u21e7Tab', seq: '\x1b[Z', title: 'Shift+Tab — cycle the permission mode' },
  { label: '^C', seq: '\x03', title: 'Ctrl-C — clear the input (twice exits)' },
  { label: '\u2190', seq: '\x1b[D', title: 'Left' },
  { label: '\u2192', seq: '\x1b[C', title: 'Right' },
];

/** Phones pick their own terminal font size (A−/A+), remembered per browser. */
const FONT_KEY = 'tm.term.mobileFont';
const DESKTOP_FONT = 12.5;
const MOBILE_FONT = { min: 8, max: 16, default: 11 };
const loadMobileFont = (): number => {
  try {
    const n = Number(localStorage.getItem(FONT_KEY));
    return Number.isFinite(n) && n >= MOBILE_FONT.min && n <= MOBILE_FONT.max ? n : MOBILE_FONT.default;
  } catch {
    return MOBILE_FONT.default;
  }
};
/**
 * The gap between the pasted message and its Enter. Sent back to back, the two
 * frames can reach the TUI in one read. It would then parse "text\r" as one
 * paste, with the \r inside it as a newline rather than a submit.
 */
const SUBMIT_DELAY_MS = 120;

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
  const { token, runs, tasks, commandRuns, shells, activity, settings } = useApp();
  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Set by the xterm effect; lets expand/resize refit without re-running it.
  const refitRef = useRef<(() => void) | null>(null);
  // The debounced twin, for sources that fire in bursts (the keyboard animating).
  const scheduleRefitRef = useRef<(() => void) | null>(null);
  // Same escape hatch as refitRef: the key row sends through the ONE input path
  // the keyboard already uses, rather than opening a second socket.
  const sendRef = useRef<((d: string) => void) | null>(null);
  const focusRef = useRef<(() => void) | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState('');
  const [mobileFont, setMobileFont] = useState(loadMobileFont);
  const [status, setStatus] = useState<'connecting' | 'live' | 'closed'>('connecting');
  const [compact, setCompact] = useState(false);
  const mobile = useIsMobile();
  // The size a terminal built right now should have. Read by the xterm effect
  // (which does not re-run on it) so a phone's terminal is born at the phone
  // size, not built at the desktop size and resized: that would be a second
  // SIGWINCH and a second full redraw.
  const fontRef = useRef(DESKTOP_FONT);
  fontRef.current = mobile ? mobileFont : DESKTOP_FONT;
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

  // Same for a half-typed message: it was written for the session it was typed in.
  useEffect(() => setDraft(''), [runId]);

  // Click outside the expanded drawer → close / compact per setting. mousedown,
  // not click, so drag-selects that end outside the drawer don't count. A phone
  // terminal fills the screen, so its only "outside" is a sheet or the question
  // modal drawn over it, and tapping those must not fold it away.
  useEffect(() => {
    if (compact || clickOutside === 'nothing' || mobile) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        if (clickOutside === 'close') onClose();
        else setCompact(true);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [compact, clickOutside, onClose, mobile]);

  useEffect(() => {
    if (!hostRef.current || !token) return;
    // Guards handlers of a socket the cleanup already closed (StrictMode, R2).
    let disposed = false;

    // Colors from docs/tm-design-tokens.html (--tm-terminal-bg / -text);
    // xterm needs concrete values, not CSS variables.
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: fontRef.current,
      theme: { background: '#0a0c0e', foreground: '#d2f5ec', cursor: '#2dd4bf' },
      scrollback: 8000,
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    // xterm 6 scrolls on wheel only; a finger on a phone needs this
    const detachTouch = attachTouchScroll(term, hostRef.current);

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
    termRef.current = term;

    const dataSub = term.onData(send);

    window.addEventListener('resize', refit);
    // Anything that changes the body's box without a window resize (the phone
    // keyboard shrinking the visual viewport, the key row or compose bar
    // mounting) refits here. Debounced: the PTY gets a SIGWINCH per resize
    // message, each one a full TUI redraw, and the iOS keyboard animates
    // through a dozen heights on its way up. A timer, not rAF: rAF never fires
    // in a hidden tab, and the size must still be right when it is shown.
    let pending: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefit = () => {
      clearTimeout(pending);
      pending = setTimeout(refit, 60);
    };
    scheduleRefitRef.current = scheduleRefit;
    const ro = new ResizeObserver(scheduleRefit);
    ro.observe(hostRef.current);

    // StrictMode double-mount safe: everything opened here is disposed here.
    return () => {
      disposed = true;
      refitRef.current = null;
      sendRef.current = null;
      focusRef.current = null;
      termRef.current = null;
      scheduleRefitRef.current = null;
      clearTimeout(pending);
      ro.disconnect();
      window.removeEventListener('resize', refit);
      dataSub.dispose();
      detachTouch();
      ws.close();
      term.dispose();
    };
  }, [runId, token, setCtrlOn]);

  // Phones choose the font. It applies to the live terminal (the xterm effect
  // above always builds it at the desktop size) and refits, which also tells
  // the PTY its new column count.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const size = mobile ? mobileFont : DESKTOP_FONT;
    if (term.options.fontSize === size) return;
    term.options.fontSize = size;
    // the body did not change size, so the observer stays quiet: refit here,
    // a tick later so xterm has re-measured its cell
    const id = setTimeout(() => refitRef.current?.(), 30);
    return () => clearTimeout(id);
  }, [mobile, mobileFont, runId, token]);

  const bumpFont = (d: number) =>
    setMobileFont((cur) => {
      const next = Math.min(MOBILE_FONT.max, Math.max(MOBILE_FONT.min, cur + d));
      try {
        localStorage.setItem(FONT_KEY, String(next));
      } catch {
        // storage blocked: the size just lasts this page
      }
      return next;
    });

  // The phone keyboard does not resize the layout viewport on iOS; it covers
  // it. Only `visualViewport` knows what is left. The full-screen terminal
  // tracks that box, so the prompt and the compose bar stay above the keys.
  useEffect(() => {
    const vv = window.visualViewport;
    const el = rootRef.current;
    if (!mobile || compact || !vv || !el) return;
    const apply = () => {
      el.style.setProperty('--tm-vv-h', `${vv.height}px`);
      el.style.setProperty('--tm-vv-top', `${vv.offsetTop}px`);
      // the observer would catch the body shrinking too, but it runs on the
      // rendering loop, and this must not wait for one (shared debounce: one send)
      scheduleRefitRef.current?.();
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    // rotation and browsers that resize the layout viewport for the keyboard
    window.addEventListener('resize', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
      el.style.removeProperty('--tm-vv-h');
      el.style.removeProperty('--tm-vv-top');
    };
  }, [mobile, compact]);

  // Compact-bar identity: an agent run resolves to its task, a command run to
  // its saved definition; either may be gone (finished, pruned) — degrade to id.
  const run = runs.find((r) => r.id === runId) ?? null;
  const cmdRun = run ? null : commandRuns.find((r) => r.id === runId) ?? null;
  const shell = run || cmdRun ? null : shells.find((s) => s.id === runId) ?? null;
  const task = run?.taskId ? tasks.find((t) => t.id === run.taskId) ?? null : null;
  // Aux sessions (review, plan, chat, …) carry their own label.
  const name =
    task?.title ??
    (run?.mode === 'aux' && run.label ? run.label : null) ??
    (cmdRun
      ? `${cmdRun.name} — ${cmdRun.repoName}`
      : shell
        ? `${shell.title} — ${shell.repoName}`
        : `session ${runId.slice(0, 8)}`);
  // An idle run's PTY is still 'running' but the agent is done — not green.
  const live = run
    ? run.status === 'running' && !run.idle
    : cmdRun
      ? cmdRun.status === 'running'
      : shell
        ? shell.status === 'running' && status === 'live'
        : status === 'live';
  const inReview = task?.status === 'review';
  const dotClass = inReview ? 'review' : live ? 'running' : 'off';
  const activityLine =
    activity[runId]?.text ??
    (cmdRun ? cmdRun.command : shell ? shell.cwd : status === 'closed' ? 'session ended' : 'no recent activity');

  // Keeps focus (and therefore the soft keyboard) on the terminal: a tap that
  // moves focus to the button would dismiss the keyboard on every keypress.
  const holdFocus = (e: ReactMouseEvent) => e.preventDefault();

  // A key goes straight down the socket and needs no focus. `holdFocus` leaves
  // the keyboard exactly as it was, and focusing xterm here would pop the
  // keyboard open over a picker you meant to answer with one tap.
  const pressKey = (seq: string) => sendRef.current?.(seq);

  // Sticky Ctrl is the exception: the key it modifies comes from the keyboard.
  // It still leaves a focused compose box alone, because pulling focus into
  // xterm would send the next letters typed there to the PTY.
  const keepFocus = () => {
    if (document.activeElement !== composeRef.current) focusRef.current?.();
  };

  /**
   * The compose bar: a real text field, so the phone's autocorrect, dictation
   * and paste all work, which they do not in xterm's hidden textarea. The text
   * goes in through xterm's own paste path, so it gets bracketed paste when the
   * app asked for it, exactly like a desktop paste. Enter follows as its own
   * frame. An empty send is a bare Enter.
   */
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const term = termRef.current;
    if (!term || status !== 'live') return;
    // a message is not "the next key": an armed Ctrl must not eat it
    setCtrlOn(false);
    const text = draft.replace(/\s+$/, '');
    // this socket's sender, not whatever sendRef holds 120ms from now: a switch
    // to another terminal in between must not send it the Enter
    const send = sendRef.current;
    if (text) {
      term.paste(text);
      setTimeout(() => send?.('\r'), SUBMIT_DELAY_MS);
    } else {
      send?.('\r');
    }
    setDraft('');
    term.scrollToBottom();
  };

  const full = mobile && !compact;

  return (
    <div className={`term-drawer ${compact ? 'compact' : ''} ${full ? 'full' : ''}`} ref={rootRef}>
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
        <span className="term-name">{name}</span>
        <span className={`badge ${status === 'live' ? 's-running' : ''}`}>
          <span className="dot" /> {status}
        </span>
        <span style={{ flex: 1 }} />
        {mobile && (
          <span className="term-font" role="group" aria-label="Text size">
            <button
              className="btn ghost"
              aria-label="Smaller text"
              disabled={mobileFont <= MOBILE_FONT.min}
              onMouseDown={holdFocus}
              onClick={() => bumpFont(-1)}
            >
              A−
            </button>
            <button
              className="btn ghost"
              aria-label="Larger text"
              disabled={mobileFont >= MOBILE_FONT.max}
              onMouseDown={holdFocus}
              onClick={() => bumpFont(1)}
            >
              A+
            </button>
          </span>
        )}
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
      <div className="term-body" ref={hostRef} />
      {mobile && (
        /* Phones only: a soft keyboard has no Esc, Tab, Ctrl or arrows, which is
           exactly what an interactive `claude` needs. It sits under the
           terminal, next to the thumb and the keyboard, and scrolls sideways so
           a narrow phone clips nothing. */
        <div className="term-keys" role="group" aria-label="Terminal keys">
          <button
            type="button"
            className={`term-key ${ctrl ? 'on' : ''}`}
            title="Ctrl — applies to the next key, then clears"
            aria-pressed={ctrl}
            onMouseDown={holdFocus}
            onClick={() => {
              setCtrlOn(!ctrlRef.current);
              keepFocus();
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
              aria-label={k.title}
              onMouseDown={holdFocus}
              onClick={() => pressKey(k.seq)}
            >
              {k.label}
            </button>
          ))}
          <button
            type="button"
            className="term-key"
            title="Jump to the live end of the output"
            aria-label="Jump to the live end of the output"
            onMouseDown={holdFocus}
            onClick={() => termRef.current?.scrollToBottom()}
          >
            <IconArrowDown />
          </button>
        </div>
      )}
      {mobile && (
        <form className="term-compose" onSubmit={submit}>
          <textarea
            ref={composeRef}
            className="field"
            rows={1}
            value={draft}
            placeholder={status === 'live' ? 'Message… (Send = type + Enter)' : 'not connected'}
            enterKeyHint="send"
            aria-label="Message to the terminal"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, as in any phone chat; a hardware Shift+Enter still breaks the line
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
            }}
          />
          <button
            type="submit"
            className="btn primary"
            aria-label={draft.trim() ? 'Send' : 'Press Enter'}
            disabled={status !== 'live'}
            onMouseDown={holdFocus}
          >
            {draft.trim() ? <IconSend /> : '\u23ce'}
          </button>
        </form>
      )}
    </div>
  );
}
