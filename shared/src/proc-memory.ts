// Memory per run (docs/memory.md § Memory per run), the pure half. Every
// PROC_MEMORY_SAMPLE_MS the server reads ONE process table (macOS `top -l 1
// -stats pid,ppid,mem,command` = the physical footprint the memory dialog
// shows; elsewhere `ps` RSS), folds it into one TREE per live session root
// (a worker's or aux run's claude pid, a repo command, a terminal shell, the
// API itself) and steps the `memory-high` episode. The server half is
// `server/src/proc-memory.ts`. No I/O here.

import type { MemorySample } from './memory.ts';
import type { AppSettings } from './types.ts';

/** Sampler period. */
export const PROC_MEMORY_SAMPLE_MS = 30_000;
/** Consecutive high samples before a `memory-high` episode opens (≈ 30–60 s). */
export const MEMORY_HIGH_TRIP_SAMPLES = 2;
/** Consecutive calm samples before it closes (≈ 90 s). */
export const MEMORY_HIGH_CLEAR_SAMPLES = 3;
/** Calm = every tree under this share of the line (and macOS pressure back to normal). */
export const MEMORY_HIGH_CLEAR_RATIO = 0.9;
/** A run's stored peak is rewritten only when it grew by at least this much (MiB) — not a write every 30 s. */
export const PEAK_WRITE_STEP_MB = 32;

/** One row of the process table. */
export interface ProcEntry {
  pid: number;
  ppid: number;
  /** footprint (macOS) or RSS, MiB */
  mb: number;
  /** short command name ('' when unknown) */
  comm: string;
}

/** Which pool a tree's root belongs to. `server` = the API process alone (its children are the other roots). */
export type MemTreeKind = 'worker' | 'aux' | 'command' | 'shell' | 'server';

/** A live session whose process tree is measured. */
export interface MemTreeRoot {
  /** worker/aux: the run id; command: the command run id; shell: `sh-…`; server: 'api' */
  id: string;
  kind: MemTreeKind;
  pid: number;
  /** readable name: the task title, the aux label, the command name, the shell's repo */
  label: string;
  taskId: string | null;
  repoId: string | null;
  /** the `tm_runs` row the peak is stored on (worker and aux runs only) */
  runId: string | null;
  /** aux kind (review, plan, chat, …) or 'check' for a check run; null otherwise */
  sub: string | null;
}

/** One measured tree. */
export interface MemTree extends MemTreeRoot {
  /** the whole tree now, MiB */
  mb: number;
  /** the most this root's tree has measured since it started (this process's sampling), MiB */
  peakMb: number;
  /** processes in the tree */
  procs: number;
  /** the biggest single process in it (often a `tsc` or `node` a worker started) */
  biggest: { pid: number; comm: string; mb: number } | null;
}

/** The `memory-high` episode: system pressure, or one tree above the line. */
export interface MemoryHighState {
  high: boolean;
  /** ISO start of the open episode — the alert's coalescing key */
  since: string | null;
  /** readable cause while high */
  reason: string | null;
  /** 'critical' when macOS reports critical pressure, else 'warn' */
  severity: 'warn' | 'critical';
  breaches: number;
  clears: number;
}

export const MEMORY_HIGH_IDLE: MemoryHighState = { high: false, since: null, reason: null, severity: 'warn', breaches: 0, clears: 0 };

/** What `OrchestratorStatus.procMemory` carries. */
export interface ProcMemorySnapshot {
  /** ISO time of the sample; null before the first */
  at: string | null;
  /** how the per-process number was read: macOS footprint (`top`) or RSS (`ps`) */
  method: 'footprint' | 'rss' | null;
  /** the machine: free %, swap, macOS pressure level (read every sample, fuse on or off) */
  system: MemorySample | null;
  /** physical memory, MiB */
  physMb: number;
  /** every live tree, biggest first */
  trees: MemTree[];
  /** sum of the trees (the task manager's own footprint, as far as it can be attributed) */
  totalMb: number;
  memoryHigh: MemoryHighState;
  /** the last sampling error (the previous trees are kept) */
  error: string | null;
}

export const PROC_MEMORY_IDLE: ProcMemorySnapshot = {
  at: null,
  method: null,
  system: null,
  physMb: 0,
  trees: [],
  totalMb: 0,
  memoryHigh: MEMORY_HIGH_IDLE,
  error: null,
};

const UNIT_MB: Record<string, number> = { B: 1 / (1024 * 1024), K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 };

/**
 * Parse `top -l 1 -stats pid,ppid,mem,command` (macOS). The header block is
 * skipped by shape: a process line is `pid ppid <n><unit>[+-] command…`.
 */
export function parseTopMem(stdout: string): ProcEntry[] {
  const out: ProcEntry[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)([BKMGT])[+-]?(?:\s+(.*?))?\s*$/.exec(line);
    if (!m) continue;
    const mb = Number(m[3]) * UNIT_MB[m[4]];
    if (!Number.isFinite(mb)) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), mb, comm: m[5] ?? '' });
  }
  return out;
}

/** Parse `ps -axo pid=,ppid=,rss=,comm=` (RSS in KiB). */
export function parsePsRss(stdout: string): ProcEntry[] {
  const out: ProcEntry[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)(?:\s+(.*?))?\s*$/.exec(line);
    if (!m) continue;
    const comm = (m[4] ?? '').split('/').pop() ?? '';
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), mb: Number(m[3]) / 1024, comm });
  }
  return out;
}

/**
 * Fold the process table into one tree per root: the root and every
 * descendant, stopping at another root (each process is billed once). A
 * `server` root counts the API process ALONE — its children are the other
 * roots, and a child nobody claims (an orphan the API started) is not its
 * memory to report as "the server". A root whose pid is not in the table
 * (exited between the pool read and the sample) is left out.
 */
export function foldTrees(
  procs: ProcEntry[],
  roots: MemTreeRoot[],
  peaks: ReadonlyMap<string, number> = new Map(),
): MemTree[] {
  const byPid = new Map<number, ProcEntry>();
  const children = new Map<number, number[]>();
  for (const p of procs) {
    byPid.set(p.pid, p);
    if (p.pid === p.ppid) continue;
    const list = children.get(p.ppid);
    if (list) list.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  const rootPids = new Set(roots.map((r) => r.pid));
  const out: MemTree[] = [];
  for (const r of roots) {
    const top = byPid.get(r.pid);
    if (!top) continue;
    let mb = 0;
    let n = 0;
    let biggest: MemTree['biggest'] = null;
    const seen = new Set<number>();
    const stack = [r.pid];
    while (stack.length) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const p = byPid.get(pid);
      if (!p) continue;
      mb += p.mb;
      n++;
      if (!biggest || p.mb > biggest.mb) biggest = { pid, comm: p.comm, mb: p.mb };
      if (r.kind === 'server') continue;
      for (const c of children.get(pid) ?? []) if (!rootPids.has(c)) stack.push(c);
    }
    out.push({ ...r, mb, procs: n, biggest, peakMb: Math.max(mb, peaks.get(r.id) ?? 0) });
  }
  return out.sort((a, b) => b.mb - a.mb);
}

/** The two halves of the alert, from settings. */
export interface MemoryHighLimits {
  /** a tree above this many MiB is an anomaly; 0 = that half is off */
  treeMb: number;
  /** system pressure (macOS kernel level warn+, elsewhere < 10 % free) is an anomaly */
  pressure: boolean;
}

export function memoryHighLimits(settings: Partial<Pick<AppSettings, 'anomaly.memoryTreeGb' | 'anomaly.memoryPressure'>>): MemoryHighLimits {
  const gb = Number(settings['anomaly.memoryTreeGb']);
  return {
    treeMb: Number.isFinite(gb) && gb > 0 ? gb * 1024 : 0,
    pressure: settings['anomaly.memoryPressure'] !== false,
  };
}

/** Free % under which a machine with no kernel pressure level (Linux, …) counts as under pressure. */
export const MEMORY_HIGH_FALLBACK_FREE_PCT = 10;

/** "1.7 GB" / "640 MB". */
export function formatMb(mb: number): string {
  if (!Number.isFinite(mb)) return '—';
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

const PRESSURE_NAME: Record<number, string> = { 1: 'normal', 2: 'warn', 4: 'critical' };

/** macOS pressure level as a word ('normal', 'warn', 'critical'), or null. */
export function pressureName(level: number | null | undefined): string | null {
  if (level == null) return null;
  return PRESSURE_NAME[level] ?? `level ${level}`;
}

function underPressure(s: MemorySample | null): boolean {
  if (!s) return false;
  return s.pressureLevel != null ? s.pressureLevel >= 2 : s.freePct < MEMORY_HIGH_FALLBACK_FREE_PCT;
}

/**
 * Why this sample is high, or null. `ratio` scales the tree line (the
 * clearing test uses MEMORY_HIGH_CLEAR_RATIO); system pressure has no band —
 * the kernel level is already coarse.
 */
export function memoryHighBreach(
  system: MemorySample | null,
  trees: MemTree[],
  limits: MemoryHighLimits,
  ratio = 1,
): string | null {
  const parts: string[] = [];
  if (limits.pressure && underPressure(system)) {
    const s = system!;
    const lvl = pressureName(s.pressureLevel);
    parts.push(
      `system memory pressure${lvl ? ` ${lvl}` : ''} (${Math.round(s.freePct)}% free` +
        (s.swapTotalMb > 0 ? `, swap ${formatMb(s.swapUsedMb)} of ${formatMb(s.swapTotalMb)}` : '') +
        ')',
    );
  }
  if (limits.treeMb > 0) {
    const big = trees.filter((t) => t.mb > limits.treeMb * ratio);
    if (big.length) {
      parts.push(
        big
          .slice(0, 3)
          .map((t) => `${t.label} ${formatMb(t.mb)}`)
          .join(', ') + ` above ${formatMb(limits.treeMb)}`,
      );
    }
  }
  return parts.length ? parts.join('; ') : null;
}

/**
 * The next episode state after one sample. Opens after
 * MEMORY_HIGH_TRIP_SAMPLES consecutive high samples, closes after
 * MEMORY_HIGH_CLEAR_SAMPLES consecutive calm ones (trees under 90 % of the
 * line, pressure normal). A sample in the band neither closes nor counts.
 * Both halves off → closed at once.
 */
export function stepMemoryHigh(
  prev: MemoryHighState,
  system: MemorySample | null,
  trees: MemTree[],
  limits: MemoryHighLimits,
  at: string,
): MemoryHighState {
  if (!limits.pressure && limits.treeMb <= 0) return MEMORY_HIGH_IDLE;
  const severity: MemoryHighState['severity'] = limits.pressure && system?.pressureLevel != null && system.pressureLevel >= 4 ? 'critical' : 'warn';
  if (!prev.high) {
    const why = memoryHighBreach(system, trees, limits);
    if (!why) return { ...MEMORY_HIGH_IDLE };
    const breaches = prev.breaches + 1;
    if (breaches < MEMORY_HIGH_TRIP_SAMPLES) return { ...MEMORY_HIGH_IDLE, breaches };
    return { high: true, since: at, reason: why, severity, breaches: 0, clears: 0 };
  }
  const strict = memoryHighBreach(system, trees, limits);
  const banded = memoryHighBreach(system, trees, limits, MEMORY_HIGH_CLEAR_RATIO);
  if (banded) {
    return { ...prev, clears: 0, reason: strict ?? prev.reason, severity: prev.severity === 'critical' ? 'critical' : severity };
  }
  const clears = prev.clears + 1;
  if (clears < MEMORY_HIGH_CLEAR_SAMPLES) return { ...prev, clears };
  return { ...MEMORY_HIGH_IDLE };
}
