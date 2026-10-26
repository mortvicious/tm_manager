import { useEffect, useRef, type RefObject } from 'react';

/**
 * Focus for a desktop dialog that is not a <Sheet> (the task panel, the
 * question modal; docs/design.md § Desktop dialogs). Phones never get here: a
 * sheet brings its own focus handling.
 * - on open (and whenever `key` changes) focus moves into the dialog: its
 *   `[data-autofocus]` element if one is there, else the dialog itself;
 * - Tab and Shift+Tab wrap inside it, so Tab never walks the page behind;
 * - on close focus goes back where it came from: the element that had it,
 *   else `fallback()` (the board row of the task), else nowhere.
 * Only a Tab that starts inside the dialog is wrapped: a docked terminal or a
 * portalled lightbox beside it keeps its own keys.
 */
export function useDialogFocus(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  key?: string,
  fallback?: () => HTMLElement | null,
) {
  // where focus was before the dialog opened; kept across `key` changes and
  // across StrictMode's dev re-run (by then focus is already inside)
  const opener = useRef<HTMLElement | null>(null);
  // read at close time: the panel may have swapped tasks since it opened
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  useEffect(() => {
    if (!active) return;
    const el = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!el || !ref.current?.contains(el)) opener.current = el;
    return () => {
      const before = opener.current;
      // after React has removed the dialog: deferred so the next dialog (or a
      // task swap) gets to claim focus first
      setTimeout(() => {
        const now = document.activeElement;
        if (now && now !== document.body && now.isConnected) return;
        const back = before && before !== document.body && before.isConnected ? before : fallbackRef.current?.() ?? null;
        back?.focus({ preventScroll: true });
      }, 0);
    };
  }, [ref, active]);

  useEffect(() => {
    const node = ref.current;
    if (!active || !node) return;
    // a field already focused inside it (a swap from the breadcrumb) keeps it
    if (!node.contains(document.activeElement)) {
      const first = node.querySelector<HTMLElement>('[data-autofocus]');
      (first ?? node).focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented) return;
      const items = focusables(node);
      if (items.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === node)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    node.addEventListener('keydown', onKey);
    return () => node.removeEventListener('keydown', onKey);
  }, [ref, active, key]);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest('[hidden], [inert]') && el.getClientRects().length > 0,
  );
}

/**
 * Is `node` the topmost layer an Escape should reach? Not while an image
 * lightbox or another modal dialog (a question, the search popover, a sheet)
 * is open — those are above it and own the key. Exit ghosts (`.tm-exit`) are
 * clones of a dialog already gone.
 */
export function topmostDialog(node: HTMLElement): boolean {
  if (document.querySelector('.yarl__root')) return false;
  const modals = document.querySelectorAll('[aria-modal="true"]:not(.tm-exit)');
  return [...modals].every((m) => m === node);
}
