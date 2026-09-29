import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BootConfig {
  port: number;
  /**
   * The front door (docs/host.md): a separate process that serves the built
   * SPA and reverse-proxies /api and /ws to `port`, so the page outlives the
   * API it talks to. Distinct from `port` on purpose — the API keeps the port
   * every hook, worker env and `TM_CALLBACK_URL` already points at.
   */
  host: { port: number };
  /**
   * LAN mode: bind every interface so a phone on the same Wi-Fi can open the
   * board (docs/mobile.md). OFF by default — the terminal WS is a
   * code-execution surface and anyone who can reach /api/session gets it.
   * `TM_LAN=1` in the environment forces it on without editing this file.
   */
  lan: { enabled: boolean };
  /**
   * Remote access over the tailnet (docs/remote-access.md): `tailscale serve`
   * forwards `https://<hostname>` to the front door, and the front door's gate
   * (server/src/remote.ts) admits a request that addressed us by that name only
   * when tailscaled stamped an allowlisted `Tailscale-User-Login` on it. OFF by
   * default, and refused at boot together with LAN mode: LAN mode binds every
   * interface with no identity at all, which is exactly what this is not.
   */
  remote: RemoteConfig;
  storage: {
    driver: 'sqlite' | 'postgres';
    sqlite: { file: string };
    postgres: { connectionString: string };
  };
  /**
   * Telegram bot (docs/telegram.md): the phone surface. It lives INSIDE the
   * API process and reaches OUT via long polling, so it needs no inbound port
   * and none of the Host/Origin allowlists apply to it — which is exactly why
   * it is off by default and answers exactly one Telegram user id.
   *
   * The token is a secret, so it lives in this file (like the storage choice)
   * and never in the DB: `tm_config` is dumped by /api/config to any page that
   * can reach the API.
   */
  telegram: TelegramConfig;
}

export interface RemoteConfig {
  enabled: boolean;
  /** The node's MagicDNS name, matched EXACTLY (`tm-m.tail04c8fe.ts.net`). */
  hostname: string;
  /**
   * The front door's DEDICATED loopback listener for `tailscale serve` (opened
   * only when enabled). Every request on it is gated whatever its Host, because
   * serve forwards the client's Host verbatim and a loopback Host would
   * otherwise pass as local. Serve points here, never at `host.port`.
   */
  port: number;
  /** Tailscale logins (as `Tailscale-User-Login` carries them), case-insensitive. */
  allowedLogins: string[];
}

export interface TelegramConfig {
  enabled: boolean;
  /** BotFather token, `<id>:<secret>`. Empty = the bot cannot start. */
  botToken: string;
  /** The ONE Telegram user id allowed to command the bot. 0 = nobody. */
  allowedUserId: number;
  /** getUpdates long-poll seconds, 1..50 (Telegram's cap). */
  pollTimeoutSec: number;
  /** Per-event-class push switches (docs/telegram.md § Notifications). */
  notify: TelegramNotifyConfig;
  /** Daily 24h report (docs/telegram.md § Reports), toggled by /digest. */
  digest: TelegramDigestConfig;
  /** Chat mode from the phone (docs/chat.md § From the phone). */
  chat: TelegramChatConfig;
}

/**
 * Whether the phone may hold a chat, and whether that chat may WRITE.
 *
 * `allowWrite` is a boot-config key and defaults to false for one reason:
 * until chat existed, docs/telegram.md § What the bot does not do could say
 * flatly that the bot reaches no code-execution surface. A write-mode chat is
 * exactly that surface, so turning it on is a decision made once, at the
 * keyboard, in the file that already holds the bot token — not a button on
 * the phone that a stolen unlocked handset could press. With it false the
 * phone can still open and read chats; `/mode write` is refused and says why.
 */
export interface TelegramChatConfig {
  enabled: boolean;
  allowWrite: boolean;
}

/** Chat on, write off — the safe half of the feature, available by default. */
export const DEFAULT_TELEGRAM_CHAT: TelegramChatConfig = { enabled: true, allowWrite: false };

/**
 * The daily digest: the same 24h report `/report` builds, pushed unasked once
 * a day. `hour` is LOCAL wall-clock on the machine running the server — the
 * Mac in docs/future/telegram-bot.md — because "send it at 9" means the hour
 * the human wakes up, not a UTC offset they would have to compute.
 *
 * A sibling of `notify` rather than an eleventh notify class: /mute and
 * /unmute flip every class at once, and muting event pushes for an afternoon
 * must not silently cancel tomorrow's digest.
 */
export interface TelegramDigestConfig {
  enabled: boolean;
  /** 0..23, local time. */
  hour: number;
}

/** Off, 09:00 local — also the fallback for a config missing the block. */
export const DEFAULT_DIGEST: TelegramDigestConfig = { enabled: false, hour: 9 };

/**
 * One boolean per pushed event class. All on by default; flipped by /mute,
 * /unmute and /notify (persisted back into this file, not tm_config — the
 * bot's whole config block stays in the one place, and the toggles must
 * survive a restart with the token they belong to).
 */
export interface TelegramNotifyConfig {
  /** task → review (verdict + findings + action buttons) */
  review: boolean;
  /** a run raised the needs-attention flag (permission prompt etc.) */
  attention: boolean;
  failed: boolean;
  blocked: boolean;
  published: boolean;
  /** proposal created (accept/reject buttons) */
  proposal: boolean;
  /** feature analyzed → proposed (approve button) / paused */
  feature: boolean;
  /** usage window reset + threshold crossings */
  usage: boolean;
  /** the queue drained — nothing queued, nothing running */
  queue: boolean;
  /** the "back online" message after a boot/restart */
  boot: boolean;
}

export const NOTIFY_CLASSES: (keyof TelegramNotifyConfig)[] = [
  'review',
  'attention',
  'failed',
  'blocked',
  'published',
  'proposal',
  'feature',
  'usage',
  'queue',
  'boot',
];

const DEFAULT_CONFIG: BootConfig = {
  port: 5175,
  host: { port: 5176 },
  lan: { enabled: false },
  remote: { enabled: false, hostname: '', port: 5177, allowedLogins: [] },
  storage: {
    driver: 'sqlite',
    sqlite: { file: 'data/taskman.db' },
    postgres: { connectionString: '' },
  },
  telegram: {
    enabled: false,
    botToken: '',
    allowedUserId: 0,
    pollTimeoutSec: 25,
    notify: {
      review: true,
      attention: true,
      failed: true,
      blocked: true,
      published: true,
      proposal: true,
      feature: true,
      usage: true,
      queue: true,
      boot: true,
    },
    digest: { ...DEFAULT_DIGEST },
    chat: { ...DEFAULT_TELEGRAM_CHAT },
  },
};

export const serverRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
export const dataDir = path.join(serverRoot, 'data');
/** Per-task deliverable files: artifacts/<taskId>/ — exposed in the task drawer. */
export const artifactsRoot = path.join(dataDir, 'artifacts');
const configPath = path.join(dataDir, 'config.json');

export function loadBootConfig(): BootConfig {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    return structuredClone(DEFAULT_CONFIG);
  }
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`data/config.json is not valid JSON: ${(e as Error).message}`);
  }
  const driver = raw.storage?.driver ?? 'sqlite';
  if (driver !== 'sqlite' && driver !== 'postgres') {
    throw new Error(`data/config.json: storage.driver must be "sqlite" or "postgres", got "${driver}"`);
  }
  if (raw.port !== undefined && !(Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536)) {
    throw new Error(`data/config.json: port must be an integer in 1..65535`);
  }
  if (raw.lan?.enabled !== undefined && typeof raw.lan.enabled !== 'boolean') {
    throw new Error(`data/config.json: lan.enabled must be a boolean`);
  }
  if (raw.host?.port !== undefined && !(Number.isInteger(raw.host.port) && raw.host.port > 0 && raw.host.port < 65536)) {
    throw new Error(`data/config.json: host.port must be an integer in 1..65535`);
  }
  if (raw.telegram !== undefined && (typeof raw.telegram !== 'object' || raw.telegram === null || Array.isArray(raw.telegram))) {
    throw new Error(`data/config.json: telegram must be an object`);
  }
  const tg = raw.telegram ?? {};
  if (tg.enabled !== undefined && typeof tg.enabled !== 'boolean') {
    throw new Error(`data/config.json: telegram.enabled must be a boolean`);
  }
  if (tg.botToken !== undefined && typeof tg.botToken !== 'string') {
    throw new Error(`data/config.json: telegram.botToken must be a string`);
  }
  if (tg.allowedUserId !== undefined && !(Number.isInteger(tg.allowedUserId) && tg.allowedUserId >= 0)) {
    throw new Error(`data/config.json: telegram.allowedUserId must be a non-negative integer (a Telegram user id)`);
  }
  if (
    tg.pollTimeoutSec !== undefined &&
    !(Number.isInteger(tg.pollTimeoutSec) && tg.pollTimeoutSec >= 1 && tg.pollTimeoutSec <= 50)
  ) {
    // Floor of 1, not 0: a zero-second "long" poll is a busy loop, not a poll.
    throw new Error(`data/config.json: telegram.pollTimeoutSec must be an integer in 1..50 (Telegram's getUpdates cap)`);
  }
  if (tg.notify !== undefined && (typeof tg.notify !== 'object' || tg.notify === null || Array.isArray(tg.notify))) {
    throw new Error(`data/config.json: telegram.notify must be an object`);
  }
  if (tg.digest !== undefined && (typeof tg.digest !== 'object' || tg.digest === null || Array.isArray(tg.digest))) {
    throw new Error(`data/config.json: telegram.digest must be an object`);
  }
  if (tg.digest?.enabled !== undefined && typeof tg.digest.enabled !== 'boolean') {
    throw new Error(`data/config.json: telegram.digest.enabled must be a boolean`);
  }
  if (
    tg.digest?.hour !== undefined &&
    !(Number.isInteger(tg.digest.hour) && tg.digest.hour >= 0 && tg.digest.hour <= 23)
  ) {
    throw new Error(`data/config.json: telegram.digest.hour must be an integer in 0..23 (local wall-clock hour)`);
  }
  if (tg.chat !== undefined && (typeof tg.chat !== 'object' || tg.chat === null || Array.isArray(tg.chat))) {
    throw new Error(`data/config.json: telegram.chat must be an object`);
  }
  for (const key of ['enabled', 'allowWrite'] as const) {
    if (tg.chat?.[key] !== undefined && typeof tg.chat[key] !== 'boolean') {
      throw new Error(`data/config.json: telegram.chat.${key} must be a boolean`);
    }
  }
  for (const cls of NOTIFY_CLASSES) {
    const v = tg.notify?.[cls];
    if (v !== undefined && typeof v !== 'boolean') {
      throw new Error(`data/config.json: telegram.notify.${cls} must be a boolean`);
    }
  }
  const remote = parseRemote(raw.remote);

  // Deliberately NOT fatal: `enabled: true` with a missing token or user id is
  // a half-finished setup, and throwing here would take the whole server down
  // (under the front door, into a respawn loop) over the one subsystem that is
  // optional. server/src/telegram/bot.ts refuses to start and says why.

  // TM_HOST_PORT exists so an isolated copy (and the tests that drive one) can
  // move the front door without editing the file the real install shares.
  const hostPortEnv = process.env.TM_HOST_PORT;
  if (hostPortEnv !== undefined && !/^\d+$/.test(hostPortEnv)) {
    throw new Error(`TM_HOST_PORT must be an integer in 1..65535, got "${hostPortEnv}"`);
  }
  const hostPort = hostPortEnv !== undefined ? Number(hostPortEnv) : (raw.host?.port ?? DEFAULT_CONFIG.host.port);
  if (!(Number.isInteger(hostPort) && hostPort > 0 && hostPort < 65536)) {
    throw new Error(`host port must be an integer in 1..65535, got ${hostPort}`);
  }
  // Shallow-merge so new fields get defaults when the file predates them.
  // The env var can only turn LAN mode ON — `npm run dev:lan` should not need
  // the config file edited, but nothing in the environment may silently
  // disable a setting the file asked for.
  const lanEnabled = raw.lan?.enabled === true || process.env.TM_LAN === '1';
  const port = raw.port ?? DEFAULT_CONFIG.port;
  if (hostPort === port) {
    throw new Error(`host.port (${hostPort}) must differ from the API port (${port})`);
  }
  if (remote.enabled && (remote.port === port || remote.port === hostPort)) {
    throw new Error(`data/config.json: remote.port (${remote.port}) must differ from the API port and host.port`);
  }
  // Fatal, unlike a half-configured bot: LAN mode binds every interface with no
  // identity check, so a "remote access" install that is also in LAN mode would
  // be wide open on the Wi-Fi while its owner believes it is behind the tailnet.
  if (remote.enabled && lanEnabled) {
    throw new Error(
      'data/config.json: remote.enabled and LAN mode (lan.enabled / TM_LAN=1) are mutually exclusive — ' +
        'remote access keeps the loopback bind and goes through `tailscale serve` (docs/remote-access.md)',
    );
  }
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...raw,
    host: { port: hostPort },
    lan: { enabled: lanEnabled },
    remote,
    storage: {
      ...structuredClone(DEFAULT_CONFIG.storage),
      ...(raw.storage ?? {}),
      sqlite: { ...DEFAULT_CONFIG.storage.sqlite, ...(raw.storage?.sqlite ?? {}) },
      postgres: { ...DEFAULT_CONFIG.storage.postgres, ...(raw.storage?.postgres ?? {}) },
    },
    // Spelled out rather than left to `...raw`: a config file written before
    // this block exists would otherwise carry no telegram key at all, and one
    // written with a partial block would drop the missing fields to undefined.
    telegram: {
      ...DEFAULT_CONFIG.telegram,
      ...tg,
      // Nested, so the shallow spread above would take a partial notify block
      // wholesale and drop every unmentioned class to undefined.
      notify: { ...DEFAULT_CONFIG.telegram.notify, ...(tg.notify ?? {}) },
      digest: { ...DEFAULT_CONFIG.telegram.digest, ...(tg.digest ?? {}) },
      chat: { ...DEFAULT_CONFIG.telegram.chat, ...(tg.chat ?? {}) },
    },
  };
}

/**
 * A bare DNS name of two or more labels whose last label is alphabetic: no
 * scheme, port, path, trailing dot, IP literal or wildcard. The gate compares
 * the Host header against this string exactly, so anything looser here would
 * be a name that can never match — or, worse, a pattern someone expected to.
 */
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function parseRemote(r: unknown): RemoteConfig {
  if (r === undefined) return structuredClone(DEFAULT_CONFIG.remote);
  if (typeof r !== 'object' || r === null || Array.isArray(r)) {
    throw new Error(`data/config.json: remote must be an object`);
  }
  const o = r as Record<string, unknown>;
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') {
    throw new Error(`data/config.json: remote.enabled must be a boolean`);
  }
  if (o.hostname !== undefined && typeof o.hostname !== 'string') {
    throw new Error(`data/config.json: remote.hostname must be a string`);
  }
  if (o.port !== undefined && !(Number.isInteger(o.port) && (o.port as number) > 0 && (o.port as number) < 65536)) {
    throw new Error(`data/config.json: remote.port must be an integer in 1..65535`);
  }
  if (o.allowedLogins !== undefined && !(Array.isArray(o.allowedLogins) && o.allowedLogins.every((l) => typeof l === 'string'))) {
    throw new Error(`data/config.json: remote.allowedLogins must be an array of strings`);
  }
  const enabled = o.enabled === true;
  const hostname = ((o.hostname as string | undefined) ?? '').trim().toLowerCase();
  const allowedLogins = ((o.allowedLogins as string[] | undefined) ?? []).map((l) => l.trim().toLowerCase());
  if (hostname !== '' && !DNS_NAME.test(hostname)) {
    throw new Error(
      `data/config.json: remote.hostname must be a bare DNS name like "tm-m.tail04c8fe.ts.net" (no scheme, port or trailing dot), got "${o.hostname}"`,
    );
  }
  if (allowedLogins.some((l) => l === '')) {
    throw new Error(`data/config.json: remote.allowedLogins must not contain empty strings`);
  }
  if (enabled && hostname === '') {
    throw new Error(`data/config.json: remote.enabled needs remote.hostname (the Mac's MagicDNS name)`);
  }
  if (enabled && allowedLogins.length === 0) {
    throw new Error(`data/config.json: remote.enabled needs at least one entry in remote.allowedLogins`);
  }
  const port = (o.port as number | undefined) ?? DEFAULT_CONFIG.remote.port;
  return { enabled, hostname, port, allowedLogins };
}

/**
 * Persist the /mute /unmute /notify toggles. Rewrites ONLY telegram.notify:
 * the file is re-read and patched rather than serialised from the in-memory
 * BootConfig, so a hand-edit made since boot (a new token, a storage change)
 * is never clobbered by a notification toggle.
 */
export function saveTelegramNotify(notify: TelegramNotifyConfig): void {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('data/config.json is not an object');
  }
  raw.telegram = { ...(raw.telegram ?? {}), notify: { ...notify } };
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
}

/**
 * Persist `/digest on|off [hour]`. Rewrites ONLY telegram.digest, for the same
 * reason saveTelegramNotify rewrites only telegram.notify: the file is re-read
 * and patched, so a hand-edit since boot survives a toggle typed on a phone.
 */
export function saveTelegramDigest(digest: TelegramDigestConfig): void {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('data/config.json is not an object');
  }
  raw.telegram = { ...(raw.telegram ?? {}), digest: { ...digest } };
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
}

export function expandHome(p: string): string {
  const home = process.env.HOME;
  if ((p === '~' || p.startsWith('~/')) && !home) {
    throw new Error('cannot expand ~: HOME is not set');
  }
  if (p === '~') return home!;
  if (p.startsWith('~/')) return path.join(home!, p.slice(2));
  if (!path.isAbsolute(p)) {
    // cwd differs between `npm run dev -w server` and `npm start`; relative
    // repo paths would resolve inconsistently, so refuse them.
    throw new Error(`repo path must be absolute or ~-prefixed: ${p}`);
  }
  return path.resolve(p);
}
