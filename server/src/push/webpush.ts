import crypto from 'node:crypto';

/**
 * Web Push on `node:crypto` alone (docs/push.md § Protocol): RFC 8291 message
 * encryption (aes128gcm, RFC 8188) and RFC 8292 VAPID. No dependency: the whole
 * protocol is one ECDH, three HKDFs, one AES-GCM and one ES256 signature.
 */

export interface VapidKeys {
  /** base64url, 65-byte uncompressed P-256 point (the SPA's applicationServerKey). */
  publicKey: string;
  /** base64url, 32-byte private scalar. */
  privateKey: string;
}

/** What `PushSubscription.toJSON()` hands the SPA, and what we store. */
export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type Urgency = 'very-low' | 'low' | 'normal' | 'high';

export interface SendResult {
  /** HTTP status from the push service, 0 when the request itself failed. */
  status: number;
  ok: boolean;
  /** 404/410 (or Apple's BadDeviceToken): the subscription is dead and must be dropped. */
  gone: boolean;
  error?: string;
}

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), unb64u(jwk.x!), unb64u(jwk.y!)]);
  return { publicKey: b64u(pub), privateKey: jwk.d! };
}

/** Throws unless the pair is a well-formed P-256 key pair that belongs together. */
export function vapidPrivateKeyObject(keys: VapidKeys): crypto.KeyObject {
  const pub = unb64u(keys.publicKey);
  const d = unb64u(keys.privateKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point');
  if (d.length !== 32) throw new Error('VAPID private key must be 32 bytes');
  // createPrivateKey keeps whatever x/y it is given, so a hand-edited pair
  // that does not belong together would sign JWTs no push service verifies
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  if (!ecdh.getPublicKey().equals(pub)) throw new Error('VAPID public key does not match the private key');
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)), d: b64u(d) },
    format: 'jwk',
  });
}

/**
 * RFC 8291 § 3.4 / RFC 8188: one record, `rs` 4096, padding delimiter 0x02.
 * `salt` and `asPrivate` are injectable only so a test can replay the RFC's
 * Appendix A vector; production always takes fresh random ones.
 */
export function encryptPayload(
  target: PushTarget,
  plaintext: Buffer,
  fixed?: { salt: Buffer; asPrivate: Buffer },
): Buffer {
  const uaPublic = unb64u(target.keys.p256dh);
  const authSecret = unb64u(target.keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('subscription p256dh is not a P-256 point');
  if (authSecret.length !== 16) throw new Error('subscription auth secret must be 16 bytes');

  const ecdh = crypto.createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = fixed?.salt ?? crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** RFC 8292 JWT, cached per push-service origin until an hour before expiry. */
export class Vapid {
  private readonly key: crypto.KeyObject;
  private readonly cache = new Map<string, { jwt: string; exp: number }>();

  constructor(
    private readonly keys: VapidKeys,
    private readonly subject: string,
  ) {
    this.key = vapidPrivateKeyObject(keys);
  }

  get publicKey(): string {
    return this.keys.publicKey;
  }

  authorization(endpoint: string): string {
    const aud = new URL(endpoint).origin;
    const nowSec = Math.floor(Date.now() / 1000);
    let hit = this.cache.get(aud);
    if (!hit || hit.exp - nowSec < 3600) {
      // 12h: RFC 8292 caps exp at 24h, and Apple rejects one further out
      const exp = nowSec + 12 * 3600;
      const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
      const claims = b64u(Buffer.from(JSON.stringify({ aud, exp, sub: this.subject })));
      const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: this.key, dsaEncoding: 'ieee-p1363' });
      hit = { jwt: `${head}.${claims}.${b64u(sig)}`, exp };
      this.cache.set(aud, hit);
    }
    return `vapid t=${hit.jwt}, k=${this.keys.publicKey}`;
  }
}

/**
 * Push services a subscription may point at. The server POSTs to whatever
 * endpoint a subscription names, so an arbitrary https URL would make this
 * process a request forwarder; the browser vendors' services are the only
 * endpoints a real PushManager ever hands out.
 */
const PUSH_HOSTS = [
  /\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /\.push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/,
];

export function endpointAllowed(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  return PUSH_HOSTS.some((re) => re.test(u.hostname));
}

export async function sendPush(
  vapid: Vapid,
  target: PushTarget,
  payload: unknown,
  opts: { ttlSec: number; urgency: Urgency; topic?: string },
): Promise<SendResult> {
  if (!endpointAllowed(target.endpoint)) {
    return { status: 0, ok: false, gone: true, error: 'endpoint is not a known push service' };
  }
  let body: Buffer;
  try {
    body = encryptPayload(target, Buffer.from(JSON.stringify(payload)));
  } catch (e) {
    // malformed keys never get better: treat as a dead subscription
    return { status: 0, ok: false, gone: true, error: (e as Error).message };
  }
  const headers: Record<string, string> = {
    authorization: vapid.authorization(target.endpoint),
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(opts.ttlSec),
    urgency: opts.urgency,
  };
  // RFC 8030 § 5.4: a newer message with the same topic replaces an undelivered one
  if (opts.topic) headers.topic = opts.topic;
  try {
    const res = await fetch(target.endpoint, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const ok = res.status >= 200 && res.status < 300;
    const text = ok ? '' : (await res.text().catch(() => '')).slice(0, 300);
    return {
      status: res.status,
      ok,
      // 404/410 per RFC 8030; Apple answers a token it never issued (or one
      // for another key) with 400 BadDeviceToken, which never gets better either
      gone: res.status === 404 || res.status === 410 || (res.status === 400 && text.includes('BadDeviceToken')),
      error: ok ? undefined : `HTTP ${res.status}${text ? `: ${text}` : ''}`,
    };
  } catch (e) {
    return { status: 0, ok: false, gone: false, error: (e as Error).message };
  }
}
