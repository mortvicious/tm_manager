/**
 * The remote-access gate (docs/remote-access.md § Phase 1).
 *
 * `tailscale serve` terminates HTTPS for the node's MagicDNS name on the
 * tailnet interface and forwards to the front door on loopback, keeping the
 * ORIGINAL Host (port-less) and stamping `Tailscale-User-Login` with the
 * connecting peer's identity — after stripping any copy the client sent. A
 * request from a TAGGED node (this Mac included) carries no identity at all.
 * So the whole decision is: did the request address us by the remote name, and
 * if so, did tailscaled vouch for a login on the allowlist?
 *
 * Pure functions over headers + the TCP peer, so the front door stays boring
 * and this file can be exercised without a tailnet.
 *
 * What this is NOT a defence against: a local process sending the same headers
 * to 127.0.0.1:5176. It already has full loopback access to everything the
 * gate protects, so a forged header buys it nothing.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { dataDir, type RemoteConfig } from './config.ts';

export type RemoteVerdict =
  /** Host is not the remote name: the ordinary loopback/LAN rules apply. */
  | { kind: 'local' }
  | { kind: 'deny'; reason: string }
  /** Admitted, as this (lowercased) login. */
  | { kind: 'allow'; login: string };

/**
 * The name part of a Host header when it addressed us as `hostname` on 443 —
 * port-less (what serve forwards) or an explicit `:443`. `isAllowedHost` reads
 * a port-less Host as port 80, which is why the remote name needs its own rule.
 * EXACT and case-insensitive; never a `.ts.net` suffix test, which would admit
 * every tailnet's names and every Funnel.
 */
export function isRemoteHost(host: string | undefined, hostname: string): boolean {
  if (!host || !hostname) return false;
  const m = /^([^:[\]]+)(?::(\d+))?$/.exec(host);
  if (!m) return false;
  if (m[2] !== undefined && m[2] !== '443') return false;
  return m[1].toLowerCase() === hostname.toLowerCase();
}

/** serve connects from loopback; the front door never binds anything else in remote mode. */
export function isLoopbackPeer(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** The header as a plain string. Node joins repeats of most headers with ", ", which then matches nothing here. */
function single(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * The gate. `upgrade` is a WebSocket upgrade, which browsers always send with
 * an Origin; for plain HTTP only a state-changing method must carry one (a
 * top-level navigation has none), but a PRESENT foreign Origin is refused on
 * every method — there is no cross-origin reader this name should serve.
 */
export function checkRemote(
  headers: IncomingHttpHeaders,
  peer: string | undefined,
  method: string | undefined,
  upgrade: boolean,
  cfg: RemoteConfig,
): RemoteVerdict {
  if (!isRemoteHost(single(headers.host), cfg.hostname)) return { kind: 'local' };
  if (!cfg.enabled) return { kind: 'deny', reason: 'remote access is disabled' };
  if (!isLoopbackPeer(peer)) return { kind: 'deny', reason: 'remote requests must arrive through tailscale serve' };

  const login = single(headers['tailscale-user-login'])?.trim().toLowerCase();
  if (!login) return { kind: 'deny', reason: 'no tailnet identity' };
  if (!cfg.allowedLogins.includes(login)) return { kind: 'deny', reason: 'login not allowed' };

  const origin = headers.origin;
  const expected = `https://${cfg.hostname}`;
  const needsOrigin = upgrade || (method !== 'GET' && method !== 'HEAD');
  if (origin === undefined) {
    if (needsOrigin) return { kind: 'deny', reason: 'missing origin' };
  } else if (typeof origin !== 'string' || origin.toLowerCase() !== expected) {
    return { kind: 'deny', reason: 'forbidden origin' };
  }
  return { kind: 'allow', login };
}

/**
 * Every `tailscale-*` header, stripped before anything is proxied: the API
 * must never see (or start trusting) identity it cannot verify itself. Done for
 * LOCAL requests too, so a header a local client sent is not forwarded either.
 */
export function stripTailscaleHeaders(headers: IncomingHttpHeaders): void {
  for (const k of Object.keys(headers)) {
    if (k.startsWith('tailscale-')) delete headers[k];
  }
}

// ------------------------------------------------------ audit hand-off token
//
// The front door has no storage, so the first sign-in of each login is handed
// to the API (`POST /api/host/remote-login`), which writes the `tm_events` row.
// That route must not be callable by the remote client the front door proxies
// for, so it takes a secret the front door mints at boot into a 0600 file in
// data/ — a file rather than the child's env so an ADOPTED API (one the front
// door did not spawn) can read it too. A local process can read it as well;
// like a forged Tailscale header, that buys nothing loopback does not already.

const hostTokenFile = path.join(dataDir, 'host.token');

/** Front door, at boot: a fresh secret every boot, readable by this user only. */
export function mintHostToken(): string {
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(hostTokenFile, token + '\n', { mode: 0o600 });
  fs.chmodSync(hostTokenFile, 0o600); // `mode` only applies when the file is created
  return token;
}

/** API: does this header carry the current front door's secret? Read per call — the front door restarts on its own schedule. */
export function isHostToken(candidate: string | undefined): boolean {
  if (!candidate) return false;
  let token: string;
  try {
    token = fs.readFileSync(hostTokenFile, 'utf8').trim();
  } catch {
    return false;
  }
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return token.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
