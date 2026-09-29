/*
 * Task Manager service worker — Web Push ONLY (docs/push.md).
 *
 * Deliberately no `fetch` handler and no cache: every page load goes to the
 * network, so a stale shell can never outlive a deploy, and /api and /ws are
 * never touched (docs/remote-access.md). Served from web/public at /sw.js with
 * `no-cache`, so a changed worker is picked up on the next visit.
 *
 * The payload is the server's PushMessage JSON: { title, body, tag, url, kind }.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let msg = null;
  try {
    msg = event.data ? event.data.json() : null;
  } catch {
    msg = null;
  }
  // iOS revokes the subscription of a worker that receives a push and shows
  // nothing, so even an unreadable payload draws a notification.
  const title = (msg && msg.title) || 'Task Manager';
  const options = {
    body: (msg && msg.body) || '',
    tag: (msg && msg.tag) || undefined,
    // a replaced notification (same tag) should still buzz: it is news
    renotify: !!(msg && msg.tag),
    icon: '/android-chrome-192x192.png',
    badge: '/favicon-32x32.png',
    data: { url: (msg && msg.url) || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || '/';
  // same-origin paths only: the payload is ours, but a URL is still a URL
  const url = new URL(raw, self.location.origin);
  const target = url.origin === self.location.origin ? url.pathname + url.search + url.hash : '/';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = wins.find((w) => w.focused) || wins[0];
      if (win) {
        // An open app keeps its state (open terminal, scroll): the SPA routes
        // itself (web/src/push.ts, PushBridge) instead of reloading.
        try {
          await win.focus();
        } catch {
          // focus can be refused; the message still routes it
        }
        win.postMessage({ type: 'tm-navigate', url: target });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});

// The browser rotated the subscription (Chrome/Firefox; Safari does not fire
// this): subscribe again with the same key and tell the server which endpoint
// the new one replaces, so the device keeps its label and kinds.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      const key = old && old.options && old.options.applicationServerKey;
      if (!key) return;
      const sub = event.newSubscription || (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
      await fetch('/api/push/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), replaces: old.endpoint }),
      });
    })().catch(() => {}),
  );
});
