import type { PushDevice, PushKind, PushMessage, PushStatus } from '@tm/shared';
import { savePushVapid, type PushConfig } from '../config.ts';
import type { PushDeviceRecord, Storage } from '../storage/types.ts';
import { generateVapidKeys, sendPush, Vapid, type Urgency } from './webpush.ts';

/**
 * Web Push delivery (docs/push.md): owns the VAPID identity and fans a message
 * out to every device that asked for its kind. The notifier decides WHAT to
 * say; this decides WHO hears it and forgets devices the push service killed.
 */

const TITLE_MAX = 120;
/** Apple caps the payload at 4 KiB; the body is the only part that can grow. */
const BODY_MAX = 900;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function publicDevice(d: PushDeviceRecord): PushDevice {
  return {
    id: d.id,
    service: d.service,
    label: d.label,
    kinds: d.kinds,
    createdAt: d.createdAt,
    lastOkAt: d.lastOkAt,
    lastError: d.lastError,
    failCount: d.failCount,
  };
}

/**
 * RFC 8030 § 5.4 `Topic`: at most 32 characters of the base64url alphabet. A
 * newer message with the same topic replaces one the push service still holds
 * for an offline phone, so a task that went review → published while the
 * phone was off delivers one ping, not both.
 */
export function pushTopic(tag: string): string {
  return tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
}

export class PushService {
  readonly vapid: Vapid | null;

  constructor(
    private readonly storage: Storage,
    cfg: PushConfig,
  ) {
    if (!cfg.enabled) {
      this.vapid = null;
      return;
    }
    let keys = { publicKey: cfg.vapidPublicKey, privateKey: cfg.vapidPrivateKey };
    if (!keys.publicKey) {
      // First boot with push on: mint the identity once and keep it. Every
      // subscription is bound to this public key, so regenerating it later
      // would silently orphan every device — which is why it is written back.
      keys = generateVapidKeys();
      savePushVapid(keys.publicKey, keys.privateKey);
      cfg.vapidPublicKey = keys.publicKey;
      cfg.vapidPrivateKey = keys.privateKey;
      console.log('push: generated a VAPID key pair into data/config.json');
    }
    this.vapid = new Vapid(keys, cfg.subject);
  }

  get enabled(): boolean {
    return this.vapid !== null;
  }

  async status(): Promise<PushStatus> {
    return {
      enabled: this.enabled,
      publicKey: this.vapid?.publicKey ?? null,
      devices: (await this.storage.listPushDevices()).map(publicDevice),
    };
  }

  /** Every device that wants `kind`. Never throws: a failed push is logged on its row. */
  async deliver(
    kind: PushKind,
    msg: Omit<PushMessage, 'kind'>,
    opts: { urgency?: Urgency; ttlSec?: number } = {},
  ): Promise<void> {
    if (!this.vapid) return;
    let devices: PushDeviceRecord[];
    try {
      devices = (await this.storage.listPushDevices()).filter((d) => d.kinds.includes(kind));
    } catch (e) {
      console.warn('push: could not list devices:', e instanceof Error ? e.message : e);
      return;
    }
    await Promise.all(devices.map((d) => this.sendTo(d, { ...msg, kind }, opts)));
  }

  /** The Settings "Send test" button — one device, whatever its kinds. */
  async test(id: string): Promise<{ ok: boolean; error: string | null } | null> {
    if (!this.vapid) return { ok: false, error: 'push is disabled in data/config.json' };
    const d = (await this.storage.listPushDevices()).find((x) => x.id === id);
    if (!d) return null;
    const error = await this.sendTo(
      d,
      { kind: 'test', title: 'Task Manager', body: 'Notifications work on this device.', tag: 'test', url: '/config' },
      { urgency: 'high', ttlSec: 300 },
    );
    return { ok: error === null, error };
  }

  /** Returns the error, or null on success. */
  private async sendTo(
    d: PushDeviceRecord,
    msg: PushMessage,
    opts: { urgency?: Urgency; ttlSec?: number },
  ): Promise<string | null> {
    const payload: PushMessage = { ...msg, title: clip(msg.title, TITLE_MAX), body: clip(msg.body, BODY_MAX) };
    const res = await sendPush(this.vapid!, { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, payload, {
      ttlSec: opts.ttlSec ?? 24 * 3600,
      urgency: opts.urgency ?? 'normal',
      topic: pushTopic(msg.tag) || undefined,
    });
    try {
      if (res.gone) {
        // 404/410: the browser dropped the subscription (permission revoked,
        // app removed from the Home Screen). It never comes back — forget it.
        await this.storage.deletePushDevice(d.id);
        console.log(`push: dropped device ${d.label || d.id.slice(0, 8)} (${res.error ?? `HTTP ${res.status}`})`);
      } else {
        await this.storage.recordPushResult(d.id, res.ok ? null : (res.error ?? 'send failed'));
      }
    } catch (e) {
      console.warn('push: could not record a send result:', e instanceof Error ? e.message : e);
    }
    if (!res.ok && !res.gone) console.warn(`push: send to ${d.service} failed: ${res.error}`);
    return res.ok ? null : (res.error ?? 'send failed');
  }
}
