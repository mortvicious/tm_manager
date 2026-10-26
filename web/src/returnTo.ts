/**
 * Where closing the terminal drawer takes you back to (docs/mobile.md
 * § Returning from a terminal): the task panel or Inbox item the terminal was
 * opened from, which had to close so the drawer could have the screen.
 * `sheet` = the phone's header-chip Inbox sheet, not the /inbox page.
 */
export type ReturnTo = { kind: 'task'; id: string } | { kind: 'inbox'; key: string; sheet: boolean };

/** An Inbox item to reopen; the nonce makes the same key twice a second signal. */
export interface InboxReturn {
  key: string;
  sheet: boolean;
  nonce: number;
}
