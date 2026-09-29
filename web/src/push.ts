import type { PushDevice, PushKind, PushStatus } from '@tm/shared';

/**
 * Web Push, browser side (docs/push.md). iOS delivers pushes only to a web app
 * added to the Home Screen (16.4+), only over HTTPS (the tailnet name, or
 * localhost), and asks for permission only from a tap — so `subscribe()` must
 * be called straight from a click handler.
 */

export type PushSupport =
  | 'ok'
  /** iOS Safari in a tab: Web Push exists only once it is on the Home Screen */
  | 'needs-install'
  /** plain http on a LAN address: no service worker at all */
  | 'insecure'
  | 'unsupported';

export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return 'insecure';
  const capable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (capable) return 'ok';
  return isIOS() && !isStandalone() ? 'needs-install' : 'unsupported';
}

/** A readable default name for this device in the Settings list. */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Device';
  const browser = isStandalone()
    ? 'Home Screen app'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : '';
  return browser ? `${os} — ${browser}` : os;
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* keep the status */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const pushApi = {
  status: () => req<PushStatus>('GET', '/api/push'),
  register: (subscription: PushSubscriptionJSON, extra: { label?: string; kinds?: PushKind[] } = {}) =>
    req<PushDevice>('POST', '/api/push/devices', { subscription, ...extra }),
  update: (id: string, patch: { label?: string; kinds?: PushKind[] }) =>
    req<PushDevice>('PATCH', `/api/push/devices/${id}`, patch),
  remove: (id: string) => req<{ ok: true }>('DELETE', `/api/push/devices/${id}`),
  test: (id: string) => req<{ ok: boolean; error: string | null }>('POST', `/api/push/devices/${id}/test`),
};

/** Registers /sw.js (idempotent). Null where there is no service worker. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch (e) {
    console.warn('service worker registration failed:', e);
    return null;
  }
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const bin = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/** This browser's live subscription, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'ok') return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/**
 * Permission → service worker → subscription → server. Call from a tap: the
 * permission prompt is the FIRST await, so Safari still sees the gesture.
 * A subscription made for a different VAPID key (the server's key pair was
 * regenerated) is replaced, or the push service would reject every send.
 */
export async function subscribe(publicKey: string, extra: { label?: string; kinds?: PushKind[] } = {}): Promise<PushDevice> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for this app — allow them in the system Settings, then try again.'
        : 'Notification permission was not granted.',
    );
  }
  if (!(await registerServiceWorker())) throw new Error('The service worker could not be registered.');
  // subscribe() needs an ACTIVE worker; a first registration is still installing
  const reg = await navigator.serviceWorker.ready;
  const key = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  return pushApi.register(sub.toJSON(), { label: extra.label ?? deviceLabel(), kinds: extra.kinds });
}

/**
 * Re-sends an existing subscription without label/kinds, so the server keeps
 * both and hands back this device's row. Heals a device the server dropped and
 * keys the browser rotated; null when this browser is not subscribed.
 */
export async function syncSubscription(publicKey: string): Promise<PushDevice | null> {
  const sub = await currentSubscription();
  if (!sub || Notification.permission !== 'granted') return null;
  if (!sameKey(sub.options.applicationServerKey, keyBytes(publicKey))) return null;
  return pushApi.register(sub.toJSON(), {});
}

export async function unsubscribe(deviceId: string | null): Promise<void> {
  const sub = await currentSubscription();
  await sub?.unsubscribe();
  if (deviceId) await pushApi.remove(deviceId).catch(() => {});
}
