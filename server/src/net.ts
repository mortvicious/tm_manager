import { networkInterfaces } from 'node:os';

/**
 * Which hosts count as "this machine or the local network".
 *
 * The server binds loopback by default and that stays the shipped default —
 * the terminal WS is a code-execution surface. LAN mode (docs/mobile.md) is an
 * explicit opt-in for reaching the board from a phone on the same Wi-Fi, and
 * when it is on these predicates are what widens the Host/Origin allowlists.
 * Nothing outside RFC1918 + loopback + link-local + mDNS ever passes.
 */

/** Set once at boot from the config/env, before `listen`. */
let lanEnabled = false;

export function setLanEnabled(on: boolean): void {
  lanEnabled = on;
}

export function isLanEnabled(): boolean {
  return lanEnabled;
}

/** Accepts `::1` bare or bracketed — a Host header brackets it, `URL.hostname` too. */
function isLoopback(hostname: string): boolean {
  const h = stripBrackets(hostname);
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** `[::1]` -> `::1`, lowercased. Everything below compares against bare names. */
function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/** Private IPv4, link-local, or an mDNS name — never a routable address. */
export function isPrivateHostname(hostname: string): boolean {
  const h = stripBrackets(hostname);
  if (isLoopback(h)) return true;
  if (h.endsWith('.local')) return true; // Bonjour: faigs-macbook-air.local
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((p) => Number(p) > 255)) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local (self-assigned Wi-Fi)
  return false;
}

/** A host the browser is allowed to have addressed us as (DNS-rebinding guard). */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  // `host` is `name` or `name:port`; an IPv6 literal keeps its brackets.
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host);
  if (!m) return false;
  const name = m[1];
  const p = m[2] === undefined ? 80 : Number(m[2]);
  if (p !== port) return false;
  return lanEnabled ? isPrivateHostname(name) : isLoopback(name);
}

/** An Origin the page may have been served from. Loopback always; LAN when on. */
export function isAllowedOriginHost(origin: string | undefined): boolean {
  if (!origin) return false;
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  return lanEnabled ? isPrivateHostname(hostname) : isLoopback(hostname);
}

/** The private IPv4 addresses this machine answers on — for the boot banner. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (isPrivateHostname(ni.address)) out.push(ni.address);
    }
  }
  return out;
}
