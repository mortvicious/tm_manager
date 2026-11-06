// The machine the API runs on (docs/memory.md § Concurrency from RAM). Its
// RAM decides the DEFAULT worker concurrency: both storage drivers overlay
// `machineDefaults()` on DEFAULT_SETTINGS in `getSettings()`, so an unsaved
// `orchestrator.concurrency` reads as the suggestion for this machine while a
// saved row always wins. Nothing here writes a setting — the server never
// changes the user's value, and an agent cannot (PUT /api/config needs Origin
// to change it).

import os from 'node:os';
import { suggestedConcurrency, type AppSettings, type MachineInfo } from '@tm/shared';

let override: number | null = null;

/** Tests only: pretend the machine has this many bytes (null = the real `os.totalmem()`). */
export function overrideTotalMem(bytes: number | null): void {
  override = bytes;
}

export function totalMemBytes(): number {
  return override ?? os.totalmem();
}

export function machineInfo(): MachineInfo {
  const total = totalMemBytes();
  return { totalMemBytes: total, suggestedConcurrency: suggestedConcurrency(total) };
}

/** Defaults that depend on the machine, laid over DEFAULT_SETTINGS by both drivers' `getSettings()`. */
export function machineDefaults(): Partial<AppSettings> {
  return { 'orchestrator.concurrency': suggestedConcurrency(totalMemBytes()) };
}
