// The memory fuse (docs/memory.md), the pure half: a sample of the machine's
// memory, the two limits from settings, and the hysteresis that turns a
// stream of samples into a tripped / clear state that does not flap. The
// sampler (server/src/memory.ts) feeds `stepMemoryFuse` every 15 s; every
// gate that starts AUTOMATIC work asks the resulting state. No I/O here.

import type { AppSettings } from './types.ts';

/** One reading of the machine's memory. */
export interface MemorySample {
  /** ISO time of the reading */
  at: string;
  /** free memory, % of physical (macOS: `kern.memorystatus_level`, what `memory_pressure` prints) */
  freePct: number;
  /** swap in use, MiB (0 when the machine has none) */
  swapUsedMb: number;
  /** swap allocated, MiB — macOS grows it on demand, so the % moves with it */
  swapTotalMb: number;
  /** swapUsedMb / swapTotalMb as %, 0 when no swap is allocated */
  swapPct: number;
  /** macOS `kern.memorystatus_vm_pressure_level` (1 normal, 2 warn, 4 critical); null elsewhere. Shown, never gated on. */
  pressureLevel: number | null;
}

/** The two limits; 0 = that half of the fuse is off. */
export interface MemoryLimits {
  minFreePct: number;
  maxSwapPct: number;
}

/** What the sampler holds, and what `OrchestratorStatus.memory` carries. */
export interface MemoryFuseState {
  /** the latest reading; null before the first or when the machine cannot be read */
  sample: MemorySample | null;
  /** the limits the state was last judged against */
  limits: MemoryLimits;
  /** true = nothing new AUTOMATIC starts (claims, wakes, verify rounds, jobs, shifts) */
  tripped: boolean;
  /** ISO start of the current episode (null while clear) — the alert's coalescing key */
  since: string | null;
  /** readable cause while tripped, e.g. "memory pressure: 7% free (minimum 10%)" */
  reason: string | null;
  /** consecutive breaching samples while clear (trips at MEMORY_TRIP_SAMPLES) */
  breaches: number;
  /** consecutive clear samples while tripped (clears at MEMORY_CLEAR_SAMPLES) */
  clears: number;
  /** the last sampling error, if the last reading failed */
  error: string | null;
}

/** Sampler period. */
export const MEMORY_SAMPLE_MS = 15_000;
/** Consecutive breaching samples before the fuse trips (≈ 15–30 s): one tsc spike is not an episode. */
export const MEMORY_TRIP_SAMPLES = 2;
/** Consecutive clear samples before it clears again (≈ 45 s). */
export const MEMORY_CLEAR_SAMPLES = 3;
/** Clear means this many percentage points INSIDE each limit, not merely back over the line. */
export const MEMORY_CLEAR_MARGIN_PCT = 5;

export const MEMORY_FUSE_IDLE: MemoryFuseState = {
  sample: null,
  limits: { minFreePct: 0, maxSwapPct: 0 },
  tripped: false,
  since: null,
  reason: null,
  breaches: 0,
  clears: 0,
  error: null,
};

/** A limit from settings: anything not a finite number in (0, 100) is off (0). */
function pct(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 100 ? n : 0;
}

export function memoryLimits(settings: Partial<Pick<AppSettings, 'memory.minFreePct' | 'memory.maxSwapPct'>>): MemoryLimits {
  return { minFreePct: pct(settings['memory.minFreePct']), maxSwapPct: pct(settings['memory.maxSwapPct']) };
}

export function memoryFuseOn(l: MemoryLimits): boolean {
  return l.minFreePct > 0 || l.maxSwapPct > 0;
}

const gb = (mb: number) => (mb / 1024).toFixed(1);

/**
 * Why this sample breaches the limits, or null when it does not. `margin`
 * tightens both limits (the clearing test): free must be ≥ min + margin and
 * swap ≤ max − margin to count as clear.
 */
export function memoryBreach(s: MemorySample, l: MemoryLimits, margin = 0): string | null {
  const parts: string[] = [];
  if (l.minFreePct > 0 && s.freePct < l.minFreePct + margin) {
    parts.push(`${Math.round(s.freePct)}% free (minimum ${l.minFreePct}%)`);
  }
  if (l.maxSwapPct > 0 && s.swapTotalMb > 0 && s.swapPct > l.maxSwapPct - margin) {
    parts.push(`swap ${Math.round(s.swapPct)}% used (${gb(s.swapUsedMb)} of ${gb(s.swapTotalMb)} GB, maximum ${l.maxSwapPct}%)`);
  }
  return parts.length ? `memory pressure: ${parts.join(', ')}` : null;
}

/**
 * The next state after one sample (null = the machine could not be read).
 *
 * Clear → tripped after MEMORY_TRIP_SAMPLES consecutive breaching samples.
 * Tripped → clear after MEMORY_CLEAR_SAMPLES consecutive samples that are
 * MEMORY_CLEAR_MARGIN_PCT inside both limits; a sample between the line and
 * the margin neither clears nor counts towards clearing. An unreadable
 * sample fails OPEN: it never trips and counts as clear, so a broken sampler
 * cannot hold the queue forever. Both limits 0 (off) → clear at once.
 */
export function stepMemoryFuse(
  prev: MemoryFuseState,
  sample: MemorySample | null,
  limits: MemoryLimits,
  error: string | null = null,
): MemoryFuseState {
  const base = { ...prev, sample, limits, error: sample ? null : error };
  if (!memoryFuseOn(limits)) return { ...base, tripped: false, since: null, reason: null, breaches: 0, clears: 0 };
  if (!prev.tripped) {
    const why = sample ? memoryBreach(sample, limits) : null;
    if (!why) return { ...base, breaches: 0, clears: 0, reason: null };
    const breaches = prev.breaches + 1;
    if (breaches < MEMORY_TRIP_SAMPLES) return { ...base, breaches, clears: 0, reason: null };
    return { ...base, tripped: true, since: sample!.at, reason: why, breaches: 0, clears: 0 };
  }
  const strict = sample ? memoryBreach(sample, limits) : null;
  const banded = sample ? memoryBreach(sample, limits, MEMORY_CLEAR_MARGIN_PCT) : null;
  if (banded) return { ...base, clears: 0, reason: strict ?? prev.reason };
  const clears = prev.clears + 1;
  if (clears < MEMORY_CLEAR_SAMPLES) return { ...base, clears };
  return { ...base, tripped: false, since: null, reason: null, breaches: 0, clears: 0 };
}

/**
 * The hold reason every surface shows (board, predicted schedule, refusals),
 * or null when the fuse does not hold. Re-reads the limits so turning the
 * fuse off releases the hold before the next sample.
 */
export function memoryHoldReason(
  state: Pick<MemoryFuseState, 'tripped' | 'reason'> | null | undefined,
  settings?: Partial<Pick<AppSettings, 'memory.minFreePct' | 'memory.maxSwapPct'>>,
): string | null {
  if (!state?.tripped) return null;
  if (settings && !memoryFuseOn(memoryLimits(settings))) return null;
  return `${state.reason ?? 'memory pressure'} — new automatic work waits until it clears`;
}

/** Parse macOS `sysctl -n vm.swapusage`: "total = 4096.00M  used = 2791.75M  free = 1304.25M  (encrypted)". */
export function parseSwapUsage(line: string): { totalMb: number; usedMb: number } | null {
  const num = (key: string): number | null => {
    const m = new RegExp(`${key}\\s*=\\s*([\\d.]+)([KMGT])?`, 'i').exec(line);
    if (!m) return null;
    const unit = (m[2] ?? 'M').toUpperCase();
    const mul = unit === 'K' ? 1 / 1024 : unit === 'G' ? 1024 : unit === 'T' ? 1024 * 1024 : 1;
    return Number(m[1]) * mul;
  };
  const totalMb = num('total');
  const usedMb = num('used');
  return totalMb === null || usedMb === null ? null : { totalMb, usedMb };
}
