import { useSyncExternalStore } from 'react';

/**
 * The one feedback surface for an action that failed (docs/mobile.md § Action
 * errors). Panel, row, board, inbox and queue `catch`es all land here instead
 * of in a line inside the body, which on a phone was off-screen whenever you
 * were scrolled away from it. The text is the server's own reason — a 409
 * ("publish held: …") is the server explaining itself, never something to
 * paraphrase.
 *
 * A module store rather than a context: a `catch` deep in a component, or in a
 * callback that outlives it, can report without threading a prop through.
 */
export interface Toast {
  id: number;
  text: string;
  /** what was being attempted ("Publish"), shown before the reason */
  title: string | null;
  /** bumped when the same text is reported again, restarting its timer */
  seq: number;
}

/** errors are read, not glanced at: long enough for a two-line 409 reason */
export const TOAST_MS = 9000;
const MAX = 3;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** The readable text of whatever a `catch` caught. */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return typeof e === 'string' ? e : String(e);
}

/**
 * Report a failed action. The same text again (a double tap, a retry that
 * failed the same way) restarts the existing toast instead of stacking a copy;
 * past three, the oldest goes.
 */
export function toastError(e: unknown, title: string | null = null): void {
  const text = errorText(e);
  if (!text) return;
  const same = toasts.find((t) => t.text === text && t.title === title);
  if (same) {
    toasts = toasts.map((t) => (t === same ? { ...t, seq: t.seq + 1 } : t));
  } else {
    toasts = [...toasts, { id: nextId++, text, title, seq: 0 }].slice(-MAX);
  }
  emit();
}

export function dismissToast(id: number): void {
  const left = toasts.filter((t) => t.id !== id);
  if (left.length === toasts.length) return;
  toasts = left;
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, () => toasts);
}
