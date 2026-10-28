/**
 * Navigation for code outside the router (the event handler in state.tsx, a
 * toast's action): it posts the URL as a window event and `PushBridge`, which
 * holds `navigate`, follows it — the same hop a tapped push notification
 * takes through the service worker's `tm-navigate` message.
 */
export const NAVIGATE_EVENT = 'tm-navigate';

/** history-state mark on an entry the task panel pushed: closing it is Back (App.tsx useOpenTask) */
export const PANEL_PUSHED = 'tmTaskPanel';

export function navigateFromAnywhere(url: string): void {
  window.dispatchEvent(new CustomEvent<string>(NAVIGATE_EVENT, { detail: url }));
}

/**
 * `?task=<id>` IS the open panel (App.tsx useOpenTask), over the page you are
 * on — and in the workspace you are in: `?ws=` rides along (docs/workspaces.md
 * § Current workspace).
 */
export function openTaskFromAnywhere(taskId: string): void {
  const q = new URLSearchParams({ task: taskId });
  const ws = new URLSearchParams(window.location.search).get('ws');
  if (ws) q.set('ws', ws);
  navigateFromAnywhere(`${window.location.pathname}?${q}`);
}
