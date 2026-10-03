import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconX } from './Icons.tsx';

/** Where sheets mount: inside `.app`, so `.app.mobile` rules still reach them. */
const sheetHost = () => document.querySelector('.app') ?? document.body;

/** Escape closes; the page behind stops scrolling while it is up. */
function useModalChrome(onClose: () => void) {
  // a hardware keyboard on a tablet has an Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
}

/**
 * The mobile bottom sheet (docs/mobile.md § Sheets): the More menu, the board's
 * filters, a row's actions and the task panel's overflow all open one of these.
 *
 * It is portalled into `.app`, not `document.body`, because every mobile rule is
 * keyed off `.app.mobile` (field sizes, tap targets). Out there a sheet would
 * lose them. The portal also escapes whatever it was declared inside, so a
 * transformed or clipping ancestor cannot trap a fixed element. React still
 * bubbles synthetic events up the COMPONENT tree through a portal, and a sheet
 * opened from a task row sits inside that row's click-to-open handler, so
 * clicks stop at the sheet.
 */
export function Sheet({
  label,
  title,
  onClose,
  children,
  className,
}: {
  /** accessible name of the dialog */
  label: string;
  /** optional heading line under the grip */
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  useModalChrome(onClose);
  return createPortal(
    <div className="sheet-root" onClick={(e) => e.stopPropagation()}>
      <div className="overlay sheet-overlay" onClick={onClose} />
      <div className={`more-sheet ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={label}>
        <div className="sheet-grip" />
        {title && <div className="sheet-title">{title}</div>}
        {children}
      </div>
    </div>,
    sheetHost(),
  );
}

/**
 * A whole-screen sheet for a form too long for a bottom sheet (New task). It
 * has a header with a close button and a body that scrolls on its own.
 */
export function FullSheet({
  label,
  title,
  onClose,
  children,
}: {
  label: string;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useModalChrome(onClose);
  return createPortal(
    <div className="full-sheet" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
      <div className="full-sheet-head">
        <span className="full-sheet-title">{title}</span>
        <button className="btn ghost" aria-label="Close" onClick={onClose}>
          <IconX />
        </button>
      </div>
      <div className="full-sheet-body">{children}</div>
    </div>,
    sheetHost(),
  );
}

/**
 * One full-width action in a sheet. The explanation that a desktop row keeps in
 * a hover tooltip is printed under the label, because a phone cannot hover. That
 * matters most for a DISABLED action, whose only answer to "why not?" lived in
 * that tooltip.
 */
export function SheetAction({
  icon,
  label,
  hint,
  tone,
  disabled,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  hint?: string;
  tone?: 'primary' | 'danger';
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`sheet-action ${tone ?? ''}`} disabled={disabled} onClick={onClick}>
      <span className="sheet-action-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="sheet-action-text">
        <span className="sheet-action-label">{label}</span>
        {hint && <span className="sheet-action-hint">{hint}</span>}
      </span>
    </button>
  );
}
