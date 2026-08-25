import fs from 'node:fs';
import path from 'node:path';

// Real plan utilization, as shown by the CLI's own `/usage` panel (session /
// weekly all-models / weekly scoped-model). The CLI caches its last fetch in
// ~/.claude.json under `cachedUsageUtilization`; there is no CLI subcommand or
// public API to fetch it ourselves, and headless (`claude -p`) runs do NOT
// refresh the cache — only interactive sessions do. So these figures are real
// but as-of `fetchedAt`, and a window whose `resets_at` has passed is reported
// expired rather than shown as a stale percentage.

export type AccountWindowKind = 'session' | 'weekly' | 'weeklyFable';

export interface AccountWindow {
  /** 0..100, as reported by the account */
  percent: number;
  /** ISO time the window rolls over, when the CLI recorded one */
  resetsAt: string | null;
  /** true once resetsAt is in the past — the percentage no longer describes now */
  expired: boolean;
}

export interface AccountUsage {
  fetchedAt: string;
  ageMs: number;
  session: AccountWindow | null;
  weekly: AccountWindow | null;
  weeklyFable: AccountWindow | null;
}

const CACHE_MS = 30 * 1000;
const FABLE_RE = /fable/i;

let cache: { at: number; key: string; value: AccountUsage | null } | null = null;

function configPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, '.claude.json') : path.join(process.env.HOME ?? '', '.claude.json');
}

function toWindow(percent: unknown, resetsAt: unknown, now: number): AccountWindow | null {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  const iso = typeof resetsAt === 'string' ? resetsAt : null;
  const resetMs = iso ? Date.parse(iso) : NaN;
  return {
    percent: Math.max(0, Math.min(100, percent)),
    resetsAt: iso,
    // No reset time recorded → can't prove it is still current; treat as live
    // (the cache age is surfaced separately) rather than silently dropping it.
    expired: Number.isFinite(resetMs) ? resetMs <= now : false,
  };
}

function parse(raw: string, now: number): AccountUsage | null {
  let j: any;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  const c = j?.cachedUsageUtilization;
  const fetchedAtMs = typeof c?.fetchedAtMs === 'number' ? c.fetchedAtMs : NaN;
  const u = c?.utilization;
  if (!u || !Number.isFinite(fetchedAtMs)) return null;

  let session: AccountWindow | null = null;
  let weekly: AccountWindow | null = null;
  let weeklyFable: AccountWindow | null = null;

  // Preferred shape: the same `limits` array the /usage panel renders.
  if (Array.isArray(u.limits)) {
    for (const l of u.limits) {
      const w = toWindow(l?.percent, l?.resets_at, now);
      if (!w) continue;
      if (l.kind === 'session') session = w;
      else if (l.kind === 'weekly_all') weekly = w;
      else if (l.kind === 'weekly_scoped' && FABLE_RE.test(l?.scope?.model?.display_name ?? '')) weeklyFable = w;
    }
  }
  // Fallback to the flat per-window keys if `limits` is missing or partial.
  session ??= toWindow(u.five_hour?.utilization, u.five_hour?.resets_at, now);
  weekly ??= toWindow(u.seven_day?.utilization, u.seven_day?.resets_at, now);

  if (!session && !weekly && !weeklyFable) return null;
  return {
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    ageMs: Math.max(0, now - fetchedAtMs),
    session,
    weekly,
    weeklyFable,
  };
}

/** Reads the CLI's cached account utilization; null when unavailable. */
export function readAccountUsage(): AccountUsage | null {
  const now = Date.now();
  const fp = configPath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(fp);
  } catch {
    cache = null;
    return null;
  }
  // The CLI rewrites this file constantly for unrelated state, so key the cache
  // on mtime/size AND a short TTL — `expired`/`ageMs` are time-dependent.
  const key = `${stat.mtimeMs}:${stat.size}`;
  if (cache && cache.key === key && now - cache.at <= CACHE_MS) return cache.value;
  let value: AccountUsage | null = null;
  try {
    value = parse(fs.readFileSync(fp, 'utf8'), now);
  } catch {
    value = null;
  }
  cache = { at: now, key, value };
  return value;
}

/** A window is usable only if it exists and its reset time hasn't passed. */
export function liveWindow(w: AccountWindow | null | undefined): AccountWindow | null {
  return w && !w.expired ? w : null;
}
