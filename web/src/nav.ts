/**
 * Navigation for code outside the router (the event handler in state.tsx, a
 * toast's action): it posts the URL as a window event and `PushBridge`, which
 * holds `navigate`, follows it — the same hop a tapped push notification
 * takes through the service worker's `tm-navigate` message.
 */
export const NAVIGATE_EVENT = 'tm-navigate';

export function navigateFromAnywhere(url: string): void {
  window.dispatchEvent(new CustomEvent<string>(NAVIGATE_EVENT, { detail: url }));
}

/** `?task=<id>` IS the open panel (App.tsx useOpenTask), over the page you are on. */
export function openTaskFromAnywhere(taskId: string): void {
  navigateFromAnywhere(`${window.location.pathname}?task=${encodeURIComponent(taskId)}`);
}
