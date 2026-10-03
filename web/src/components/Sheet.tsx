import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Sheet as ModalSheet, type SheetTweenConfig } from 'react-modal-sheet';
import { exitGhost } from '../motion.ts';
import { IconX } from './Icons.tsx';

/** Where sheets mount: inside `.app`, so `.app.mobile` rules still reach them. */
const sheetHost = () => document.querySelector('.app') ?? document.body;

/**
 * Open sheets, newest last. Escape closes only the top one: the task panel and
 * its actions sheet are both sheets, and one key press must not shut both.
 */
const openSheets: symbol[] = [];

/** How long a parent may take to unmount a sheet that finished closing. */
const ZOMBIE_MS = 400;

/**
 * The open/close tween, read from the token layer (`--tm-sheet-dur`,
 * `--tm-sheet-ease` in theme.css) so a design can retune it without touching
 * JS. Motion takes a cubic-bezier as four numbers, so anything else (a
 * `linear()` curve, a missing token) falls back to the library's own curve.
 */
function sheetTween(): SheetTweenConfig {
  const css = getComputedStyle(document.documentElement);
  const dur = css.getPropertyValue('--tm-sheet-dur').trim();
  const ms = dur.endsWith('ms') ? parseFloat(dur) : dur.endsWith('s') ? parseFloat(dur) * 1000 : NaN;
  const m = /^cubic-bezier\(([^)]+)\)$/.exec(css.getPropertyValue('--tm-sheet-ease').trim());
  const bez = m?.[1].split(',').map(Number);
  return {
    duration: Number.isFinite(ms) ? ms / 1000 : 0.2,
    ease: bez && bez.length === 4 && bez.every(Number.isFinite) ? (bez as [number, number, number, number]) : 'easeOut',
  };
}

/**
 * The mobile bottom sheet (docs/mobile.md § Sheets), built on react-modal-sheet
 * like neko-frontend's: it follows a finger from ANYWHERE on it while its
 * content is scrolled to the top (the library watches its own scroller's
 * scrollTop to tell "scroll the list" from "drag the sheet"), and from the
 * header always. Released past the threshold or flicked, it closes.
 *
 * Mounted means open. The parent renders `{open && <Sheet …/>}` exactly as
 * before; the sheet animates itself in, and every way out it owns — backdrop
 * tap, drag, Escape, a header close button via `head(close)` — animates out
 * FIRST and only then calls `onClose`. A parent that unmounts it directly (an
 * action that closes and acts) gets no library exit; Glass covers that with
 * `exitGhost` on the wrapper, Classic just disappears as it always did.
 *
 * Portalled into `.app`, not `document.body`, because every mobile rule is
 * keyed off `.app.mobile` (field sizes, tap targets). React still bubbles
 * synthetic events up the COMPONENT tree through a portal, and a sheet opened
 * from a task row sits inside that row's click-to-open handler, so clicks stop
 * at the sheet.
 */
export function Sheet({
  label,
  title,
  head,
  onClose,
  children,
  className,
  bodyClassName = 'sheet-body',
  tall,
  zIndex = 35,
}: {
  /** accessible name of the dialog */
  label: string;
  /** optional heading line under the grip */
  title?: ReactNode;
  /** a custom header under the grip (replaces `title`); `close` animates out first */
  head?: ReactNode | ((close: () => void) => ReactNode);
  onClose: () => void;
  children: ReactNode;
  /** extra class on the sheet itself (the library's container) */
  className?: string;
  /** class of the box that holds `children` inside the library's scroller */
  bodyClassName?: string;
  /** full height (the library's `default` detent) instead of hugging the content */
  tall?: boolean;
  /** stacking: sheets 35, the agent's question above them */
  zIndex?: number;
}) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [tween] = useState(sheetTween);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const zombie = useRef<ReturnType<typeof setTimeout>>(undefined);
  // set once the library has played the exit itself, so no ghost replays it
  const exited = useRef(false);

  // a state change to animate from: mounted closed, opened on the next commit
  useEffect(() => {
    setOpen(true);
    return () => clearTimeout(zombie.current);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  // The exit has played. A parent that does not unmount us (its onClose refused,
  // or did something else) would leave a sheet that is closed with no state
  // change left to bring it back, so after a beat it opens again.
  const closed = useCallback(() => {
    exited.current = true;
    onCloseRef.current();
    clearTimeout(zombie.current);
    zombie.current = setTimeout(() => {
      exited.current = false;
      setOpen(true);
    }, ZOMBIE_MS);
  }, []);

  // a hardware keyboard on a tablet has an Escape
  useEffect(() => {
    const me = Symbol('sheet');
    openSheets.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && openSheets[openSheets.length - 1] === me) close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      openSheets.splice(openSheets.indexOf(me), 1);
    };
  }, [close]);

  // The wrapper is the library's mount point and the exit ghost's subject. The
  // ghost is only for a parent that unmounts an OPEN sheet; after the library's
  // own exit there is nothing on screen left to animate.
  const hostRef = useCallback((node: HTMLDivElement | null) => {
    setHost(node);
    const ghost = exitGhost(node);
    return () => {
      if (!exited.current) ghost?.();
    };
  }, []);

  const header = typeof head === 'function' ? head(close) : head;
  return createPortal(
    <div className="sheet-root" ref={hostRef} onClick={(e) => e.stopPropagation()}>
      {host && (
        <ModalSheet
          isOpen={open}
          onClose={close}
          onCloseEnd={closed}
          detent={tall ? 'default' : 'content'}
          mountPoint={host}
          tweenConfig={tween}
          unstyled
          style={{ zIndex }}
        >
          <ModalSheet.Container
            className={`more-sheet${tall ? ' sheet-tall' : ''} ${className ?? ''}`}
            role="dialog"
            aria-modal="true"
            aria-label={label}
          >
            <ModalSheet.Header className="sheet-head">
              <div className="sheet-grip" />
              {header ?? (title && <div className="sheet-title">{title}</div>)}
            </ModalSheet.Header>
            <ModalSheet.Content className="sheet-content">
              <div className={bodyClassName}>{children}</div>
            </ModalSheet.Content>
          </ModalSheet.Container>
          <ModalSheet.Backdrop className="overlay sheet-overlay" onTap={close} />
        </ModalSheet>
      )}
    </div>,
    sheetHost(),
  );
}

/**
 * A full-height sheet for a form too long to hug its content (New task): a
 * header with a close button, the form scrolling under it. Still a sheet, so
 * it drags down from the header, or from anywhere while the form is at its top.
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
  return (
    <Sheet
      label={label}
      tall
      className="full-sheet"
      bodyClassName="full-sheet-body"
      onClose={onClose}
      head={(close) => (
        <div className="full-sheet-head">
          <span className="full-sheet-title">{title}</span>
          <button className="btn ghost" aria-label="Close" onClick={close}>
            <IconX />
          </button>
        </div>
      )}
    >
      {children}
    </Sheet>
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
