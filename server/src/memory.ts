// The memory fuse (docs/memory.md), the sampler half. Every MEMORY_SAMPLE_MS
// the orchestrator calls `sampleMemory(settings)`; the reading is folded into
// one process-wide cached state by the pure `stepMemoryFuse` (shared), and
// every gate that starts AUTOMATIC work reads `memoryHold()` — synchronous,
// no I/O on the claim path. A human click never asks.
//
// macOS: ONE `sysctl -n kern.memorystatus_level vm.swapusage
// kern.memorystatus_vm_pressure_level` (≈ 10 ms, argv, no shell) —
// `kern.memorystatus_level` is the "System-wide memory free percentage" that
// `memory_pressure` prints. Linux: /proc/meminfo (MemAvailable, Swap*).
// Elsewhere: os.freemem(), no swap.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import type { AppSettings, MemoryFuseState, MemorySample } from '@tm/shared';
import { MEMORY_FUSE_IDLE, memoryFuseOn, memoryHoldReason, memoryLimits, parseSwapUsage, stepMemoryFuse } from '@tm/shared';

export type MemorySampler = () => Promise<MemorySample>;

let state: MemoryFuseState = MEMORY_FUSE_IDLE;
let sampler: MemorySampler = sampleSystemMemory;

function sysctl(names: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('sysctl', ['-n', ...names], { timeout: 5_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/** One reading of this machine's memory; throws when it cannot be read. */
export async function sampleSystemMemory(): Promise<MemorySample> {
  const at = new Date().toISOString();
  if (process.platform === 'darwin') {
    const lines = (await sysctl(['kern.memorystatus_level', 'vm.swapusage', 'kern.memorystatus_vm_pressure_level'])).split('\n');
    const freePct = Number(lines[0]);
    const swap = parseSwapUsage(lines[1] ?? '');
    const level = Number(lines[2]);
    if (!Number.isFinite(freePct) || !swap) throw new Error(`unreadable sysctl output: ${lines.slice(0, 2).join(' | ').slice(0, 200)}`);
    return {
      at,
      freePct,
      swapUsedMb: swap.usedMb,
      swapTotalMb: swap.totalMb,
      swapPct: swap.totalMb > 0 ? (swap.usedMb / swap.totalMb) * 100 : 0,
      pressureLevel: Number.isFinite(level) ? level : null,
    };
  }
  if (process.platform === 'linux') {
    const info = await readFile('/proc/meminfo', 'utf8');
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(info)?.[1] ?? NaN);
    const total = kb('MemTotal');
    const avail = kb('MemAvailable');
    const swapTotal = kb('SwapTotal');
    const swapFree = kb('SwapFree');
    if (!(total > 0) || !Number.isFinite(avail)) throw new Error('unreadable /proc/meminfo');
    const swapTotalMb = Number.isFinite(swapTotal) ? swapTotal / 1024 : 0;
    const swapUsedMb = Number.isFinite(swapFree) ? swapTotalMb - swapFree / 1024 : 0;
    return {
      at,
      freePct: (avail / total) * 100,
      swapUsedMb,
      swapTotalMb,
      swapPct: swapTotalMb > 0 ? (swapUsedMb / swapTotalMb) * 100 : 0,
      pressureLevel: null,
    };
  }
  return { at, freePct: (os.freemem() / os.totalmem()) * 100, swapUsedMb: 0, swapTotalMb: 0, swapPct: 0, pressureLevel: null };
}

/** What the last sample transition was, for the caller's alert / audit / reschedule. */
export type MemoryChange = 'tripped' | 'cleared' | null;

/**
 * Take one sample and fold it into the cached state. With the fuse off no
 * sample is taken at all (the state resets to clear). Never throws: an
 * unreadable machine fails open (see `stepMemoryFuse`).
 */
export async function sampleMemory(settings: Pick<AppSettings, 'memory.minFreePct' | 'memory.maxSwapPct'>): Promise<{ state: MemoryFuseState; change: MemoryChange }> {
  const limits = memoryLimits(settings);
  const prev = state;
  if (!memoryFuseOn(limits)) {
    state = stepMemoryFuse(prev, null, limits);
  } else {
    let sample: MemorySample | null = null;
    let error: string | null = null;
    try {
      sample = await sampler();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    state = stepMemoryFuse(prev, sample, limits, error);
  }
  const change: MemoryChange = !prev.tripped && state.tripped ? 'tripped' : prev.tripped && !state.tripped ? 'cleared' : null;
  return { state, change };
}

/** The cached state (OrchestratorStatus.memory). */
export function memoryState(): MemoryFuseState {
  return state;
}

/**
 * The fuse's hold reason, or null when automatic work may start. Synchronous
 * and I/O-free on purpose — every claim and gate asks it. Passing settings
 * releases the hold the moment the fuse is turned off.
 */
export function memoryHold(settings?: Partial<Pick<AppSettings, 'memory.minFreePct' | 'memory.maxSwapPct'>>): string | null {
  return memoryHoldReason(state, settings);
}

/** Tests: replace the sampler (null = the real one) and reset the cached state. */
export function setMemorySampler(fn: MemorySampler | null): void {
  sampler = fn ?? sampleSystemMemory;
  state = MEMORY_FUSE_IDLE;
}
