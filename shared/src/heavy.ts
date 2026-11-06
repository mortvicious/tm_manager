// Heavy work (docs/memory.md § Heavy work, docs/checks.md § One check at a
// time), the pure half. Repo checks (`tsc`, `next build`, test suites) and the
// browser automation agents run mid-turn (Lighthouse, Playwright, headless
// Chrome, `next build`/`next start` probes) share ONE global set of slots,
// `heavy.maxParallel`. The server half is `server/src/heavy.ts`; this file holds
// the types `OrchestratorStatus.heavy` carries, the slot count, the pressure
// verdict a lease hands back, and the badge text. No I/O here.

import type { AppSettings } from './types.ts';

/** What a slot is held for. `check` = a repo check run by the server; the rest come from an agent's lease. */
export type HeavyKind = 'check' | 'lighthouse' | 'playwright' | 'browser' | 'build' | 'other';
/** The kinds an agent may name in `POST /api/agent/heavy/acquire`. */
export const HEAVY_AGENT_KINDS = ['lighthouse', 'playwright', 'browser', 'build', 'other'] as const;
export type HeavyAgentKind = (typeof HEAVY_AGENT_KINDS)[number];

/** Upper bound of `heavy.maxParallel` (0 = auto). */
export const HEAVY_MAX_PARALLEL = 4;
/** A granted agent lease is released on its own after this long (the turn usually ends first). */
export const HEAVY_LEASE_MAX_MS = 60 * 60_000;
/** A waiting agent ticket nobody polled for this long is dropped (the agent gave up or died). */
export const HEAVY_TICKET_STALE_MS = 90_000;
/** A granted lease the agent never learned about (no poll after the grant) is released after this long. */
export const HEAVY_UNCLAIMED_MS = 120_000;

/** One slot holder or waiter, as the SPA and the agent see it. */
export interface HeavyTicket {
  id: string;
  kind: HeavyKind;
  /** the task it works for: a check's task, the agent's task; null for a baseline or an office command */
  taskId: string | null;
  /** the worker run that took an agent lease (released when that run's turn ends); null for a check */
  runId: string | null;
  repoId: string | null;
  /** check name, or the agent's `why` */
  label: string;
  requestedAt: string;
  /** null while waiting */
  grantedAt: string | null;
  /** while waiting: a slot, or (agent leases only) the memory fuse */
  waitingOn: 'slot' | 'memory' | null;
}

/** `OrchestratorStatus.heavy`. */
export interface HeavyStatus {
  /** the slot count in force */
  max: number;
  /** true when `heavy.maxParallel` is 0 and `max` came from the machine's RAM */
  auto: boolean;
  held: HeavyTicket[];
  /** FIFO order */
  waiting: HeavyTicket[];
}

export const HEAVY_IDLE: HeavyStatus = { max: 1, auto: true, held: [], waiting: [] };

const GIB = 1024 ** 3;

/**
 * The slot count: the setting when it is 1..HEAVY_MAX_PARALLEL, else (0 = auto)
 * from physical memory — 1 up to 8 GB, 2 up to 16 GB, 3 above. A `tsc` of a
 * real project is ~1.7 GB and a Lighthouse pass ~1.5 GB, so an 8 GB laptop
 * that runs two at once swaps (measured 2026-11-06).
 */
export function heavyMaxParallel(setting: number | undefined, totalMemBytes: number): { max: number; auto: boolean } {
  const n = Math.floor(Number(setting ?? 0));
  if (Number.isFinite(n) && n >= 1) return { max: Math.min(n, HEAVY_MAX_PARALLEL), auto: false };
  // 8.5 / 16.5: a "8 GB" Mac reports 8 GiB exactly; leave room for rounding.
  const gib = totalMemBytes / GIB;
  return { max: gib <= 8.5 ? 1 : gib <= 16.5 ? 2 : 3, auto: true };
}

export function heavySettingOf(settings: Partial<Pick<AppSettings, 'heavy.maxParallel'>>): number {
  return Number(settings['heavy.maxParallel'] ?? 0) || 0;
}

/** What the server saw of the machine while a lease was held. */
export interface HeavyPressureAccum {
  samples: number;
  minFreePct: number | null;
  maxSwapPct: number | null;
  /** macOS `kern.memorystatus_vm_pressure_level` (1 normal, 2 warn, 4 critical) */
  maxPressureLevel: number | null;
  /** highest 1-minute load average */
  peakLoad1: number;
  /** the memory fuse was tripped at some sample */
  fuseTripped: boolean;
  /** most OTHER heavy holders seen at once (0 = it had the machine to itself) */
  overlapped: number;
}

export const HEAVY_PRESSURE_EMPTY: HeavyPressureAccum = {
  samples: 0,
  minFreePct: null,
  maxSwapPct: null,
  maxPressureLevel: null,
  peakLoad1: 0,
  fuseTripped: false,
  overlapped: 0,
};

/** The report a lease's release (or poll) returns: was this a fair measurement? */
export interface HeavyPressure extends HeavyPressureAccum {
  cpus: number;
  /** true = numbers measured during the lease are suspect; re-measure */
  underPressure: boolean;
  /** why, readable; empty when clear */
  reasons: string[];
}

/** Free memory below this % (macOS `kern.memorystatus_level`) counts as pressure for a measurement. */
export const HEAVY_PRESSURE_FREE_PCT = 15;
/** 1-minute load above this many × the core count counts as a saturated machine. */
export const HEAVY_PRESSURE_LOAD_FACTOR = 1.5;

/**
 * Judges a lease's samples. Any of: the memory fuse tripped, macOS pressure at
 * warn or worse, free memory under HEAVY_PRESSURE_FREE_PCT, load above
 * HEAVY_PRESSURE_LOAD_FACTOR × cores, or another heavy job running at the same
 * time. No samples at all is not pressure (nothing seen), but says so.
 */
export function judgeHeavyPressure(acc: HeavyPressureAccum, cpus: number): HeavyPressure {
  const reasons: string[] = [];
  if (acc.fuseTripped) reasons.push('the memory fuse was tripped');
  if (acc.maxPressureLevel != null && acc.maxPressureLevel >= 2) {
    reasons.push(`macOS memory pressure reached ${acc.maxPressureLevel >= 4 ? 'critical' : 'warn'}`);
  }
  if (acc.minFreePct != null && acc.minFreePct < HEAVY_PRESSURE_FREE_PCT) {
    reasons.push(`free memory fell to ${Math.round(acc.minFreePct)}%`);
  }
  const cores = Math.max(1, cpus);
  if (acc.peakLoad1 > cores * HEAVY_PRESSURE_LOAD_FACTOR) {
    reasons.push(`load average reached ${acc.peakLoad1.toFixed(1)} on ${cores} cores`);
  }
  if (acc.overlapped > 0) reasons.push(`${acc.overlapped} other heavy job${acc.overlapped === 1 ? '' : 's'} ran at the same time`);
  return { ...acc, cpus: cores, underPressure: reasons.length > 0, reasons };
}

/** Folds one sample into the accumulator. */
export function foldHeavySample(
  acc: HeavyPressureAccum,
  s: { freePct: number | null; swapPct: number | null; pressureLevel: number | null; load1: number; fuseTripped: boolean; others: number },
): HeavyPressureAccum {
  const min = (a: number | null, b: number | null) => (b == null ? a : a == null ? b : Math.min(a, b));
  const max = (a: number | null, b: number | null) => (b == null ? a : a == null ? b : Math.max(a, b));
  return {
    samples: acc.samples + 1,
    minFreePct: min(acc.minFreePct, s.freePct),
    maxSwapPct: max(acc.maxSwapPct, s.swapPct),
    maxPressureLevel: max(acc.maxPressureLevel, s.pressureLevel),
    peakLoad1: Math.max(acc.peakLoad1, s.load1),
    fuseTripped: acc.fuseTripped || s.fuseTripped,
    overlapped: Math.max(acc.overlapped, s.others),
  };
}

/**
 * The badge/panel line for a task that is queued behind the heavy slots, or
 * null: `waiting for a check slot` (a check of it), `waiting for a heavy slot`
 * (its agent's lease), with `(memory pressure)` when the fuse is what holds it.
 */
export function heavyWaitLabel(status: Pick<HeavyStatus, 'waiting'> | null | undefined, taskId: string): string | null {
  const t = status?.waiting.find((w) => w.taskId === taskId);
  if (!t) return null;
  const base = t.kind === 'check' ? 'waiting for a check slot' : 'waiting for a heavy slot';
  return t.waitingOn === 'memory' ? `${base} (memory pressure)` : base;
}
