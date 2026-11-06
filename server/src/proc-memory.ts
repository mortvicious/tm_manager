// Memory per run (docs/memory.md § Memory per run), the sampler half. Every
// PROC_MEMORY_SAMPLE_MS the orchestrator hands `sampleProcMemory` the live
// session roots of every pool; this module reads ONE process table, folds it
// into trees (pure `foldTrees`, shared), keeps each root's peak, steps the
// `memory-high` episode and tells the caller which `tm_runs` peaks to write.
//
// macOS: `top -l 1 -stats pid,ppid,mem,command` — MEM is the physical
// footprint (compressed and swapped pages included), the number Activity
// Monitor and the memory dialog show; RSS undercounts a swapping tree and
// double-counts shared libraries. ≈ 0.2 s of system CPU per call, every 30 s.
// Elsewhere: `ps -axo pid=,ppid=,rss=,comm=` (RSS).

import { execFile } from 'node:child_process';
import os from 'node:os';
import type { AppSettings, MemorySample, MemTreeRoot, ProcEntry, ProcMemorySnapshot } from '@tm/shared';
import { PEAK_WRITE_STEP_MB, PROC_MEMORY_IDLE, foldTrees, memoryHighLimits, parsePsRss, parseTopMem, stepMemoryHigh } from '@tm/shared';
import { sampleSystemMemory } from './memory.ts';

export type ProcTableReader = () => Promise<{ procs: ProcEntry[]; method: 'footprint' | 'rss' }>;
export type SystemReader = () => Promise<MemorySample>;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/** The machine's process table, one call. */
export async function readProcTable(): Promise<{ procs: ProcEntry[]; method: 'footprint' | 'rss' }> {
  if (process.platform === 'darwin') {
    try {
      const procs = parseTopMem(await run('top', ['-l', '1', '-stats', 'pid,ppid,mem,command']));
      if (procs.length > 0) return { procs, method: 'footprint' };
    } catch {
      /* fall back to ps */
    }
  }
  return { procs: parsePsRss(await run('ps', ['-axo', 'pid=,ppid=,rss=,comm='])), method: 'rss' };
}

let readTable: ProcTableReader = readProcTable;
let readSystem: SystemReader = sampleSystemMemory;
let snapshot: ProcMemorySnapshot = PROC_MEMORY_IDLE;
/** root id → the most its tree measured (this process's lifetime) */
const peaks = new Map<string, number>();
/** run id → the peak last written to `tm_runs.peak_mem_mb` */
const written = new Map<string, number>();
/** root id → its run id, to flush a peak when the root goes away */
const runOf = new Map<string, string>();

export type MemoryHighChange = 'opened' | 'closed' | null;

export interface ProcMemoryResult {
  snapshot: ProcMemorySnapshot;
  change: MemoryHighChange;
  /** peaks to store on `tm_runs` (grew by PEAK_WRITE_STEP_MB, or the root just ended) */
  writes: { runId: string; peakMb: number }[];
}

/**
 * One sample. Never throws: an unreadable table keeps the previous trees with
 * `error` set (the episode is not stepped — no reading is not a calm reading),
 * an unreadable system sample leaves `system` null.
 */
export async function sampleProcMemory(
  roots: MemTreeRoot[],
  settings: Partial<Pick<AppSettings, 'anomaly.memoryTreeGb' | 'anomaly.memoryPressure'>>,
): Promise<ProcMemoryResult> {
  const at = new Date().toISOString();
  const [tableR, systemR] = await Promise.allSettled([readTable(), readSystem()]);
  const system = systemR.status === 'fulfilled' ? systemR.value : null;
  if (tableR.status === 'rejected') {
    const e = tableR.reason;
    snapshot = { ...snapshot, at, system, error: e instanceof Error ? e.message : String(e) };
    return { snapshot, change: null, writes: [] };
  }
  const trees = foldTrees(tableR.value.procs, roots, peaks);
  const writes: ProcMemoryResult['writes'] = [];
  const live = new Set<string>();
  for (const t of trees) {
    live.add(t.id);
    peaks.set(t.id, t.peakMb);
    if (!t.runId) continue;
    runOf.set(t.id, t.runId);
    const last = written.get(t.runId);
    if (last === undefined || t.peakMb - last >= PEAK_WRITE_STEP_MB) {
      written.set(t.runId, t.peakMb);
      writes.push({ runId: t.runId, peakMb: t.peakMb });
    }
  }
  // a root that is gone: flush the rest of its peak, then forget it
  for (const id of [...peaks.keys()]) {
    if (live.has(id)) continue;
    const runId = runOf.get(id);
    const peak = peaks.get(id)!;
    if (runId && peak > (written.get(runId) ?? 0)) writes.push({ runId, peakMb: peak });
    peaks.delete(id);
    runOf.delete(id);
    if (runId) written.delete(runId);
  }
  const prevHigh = snapshot.memoryHigh;
  const memoryHigh = stepMemoryHigh(prevHigh, system, trees, memoryHighLimits(settings), at);
  snapshot = {
    at,
    method: tableR.value.method,
    system,
    physMb: os.totalmem() / (1024 * 1024),
    trees,
    totalMb: trees.reduce((s, t) => s + t.mb, 0),
    memoryHigh,
    error: null,
  };
  const change: MemoryHighChange = !prevHigh.high && memoryHigh.high ? 'opened' : prevHigh.high && !memoryHigh.high ? 'closed' : null;
  return { snapshot, change, writes };
}

/** The latest snapshot (OrchestratorStatus.procMemory). */
export function procMemoryState(): ProcMemorySnapshot {
  return snapshot;
}

/** Tests: replace the readers (null = the real ones) and reset all state. */
export function setProcMemoryReaders(table: ProcTableReader | null, system: SystemReader | null = null): void {
  readTable = table ?? readProcTable;
  readSystem = system ?? sampleSystemMemory;
  snapshot = PROC_MEMORY_IDLE;
  peaks.clear();
  written.clear();
  runOf.clear();
}
