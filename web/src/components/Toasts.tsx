import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { exitGhost } from '../motion.ts';
import { dismissToast, TOAST_MS, UNDO_MS, useToasts, type Toast } from '../toast.ts';
import { IconX } from './Icons.tsx';

/**
 * The toast host (docs/mobile.md § Action errors): one stack, bottom of the
 * screen, above the tab bar on a phone and above any open sheet or panel, so a
 * refused action is read where the eye already is — not in a line at the top
 * of a panel you scrolled away from.
 *
 * Portalled into `.app` like <Sheet>: the phone's `--tm-tabbar-clear` and the
 * Glass type scale are defined there, not on `body`.
 */
export function Toasts() {
  const toasts = useToasts();
  const [host, setHost] = useState<Element | null>(null);
  // `.app` is committed by the time effects run; at first render it may not be
  useEffect(() => setHost(document.querySelector('.app') ?? document.body), []);
  if (!host) return null;
  return createPortal(
    <div className="toasts">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>,
    host,
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  // Hover (desktop) or a finger on it (phone) holds the timer: an error is
  // read, and a long 409 reason should not vanish mid-sentence.
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held || toast.sticky) return;
    const t = setTimeout(() => dismissToast(toast.id), toast.tone === 'info' ? UNDO_MS : TOAST_MS);
    return () => clearTimeout(t);
  }, [toast.id, toast.seq, held, toast.sticky]);
  return (
    <div
      className={`toast${toast.tone === 'info' ? ' info' : ''}`}
      ref={exitGhost}
      role={toast.tone === 'info' ? 'status' : 'alert'}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
    >
      <span className="toast-dot" aria-hidden="true" />
      <span className="toast-text">
        {toast.title && <b>{toast.title} failed: </b>}
        {toast.text}
      </span>
      {toast.action && (
        <button
          type="button"
          className="btn ghost toast-act"
          onClick={() => {
            dismissToast(toast.id);
            toast.action!.run();
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button type="button" className="btn ghost toast-x" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
        <IconX />
      </button>
    </div>
  );
}
