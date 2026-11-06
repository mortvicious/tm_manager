// Worker concurrency vs the machine's RAM (docs/memory.md § Concurrency from
// RAM, decisions.md 2026-11-06). The pure half: the suggested
// `orchestrator.concurrency` for a given amount of physical memory and the
// warnings the Config page and Telegram `/status` show when the saved value —
// plus chats and jobs, which are claude sessions too — goes above it. The
// suggestion is only a DEFAULT: the server serves it for an unsaved key
// (`server/src/machine.ts`), a saved value always wins, and nothing here
// writes a setting. No I/O.

import type { AppSettings } from './types.ts';

const GIB = 1024 ** 3;

/** `chat.concurrency` / `jobs.concurrency` defaults — the stack the suggestion already allows for. */
const BASELINE_CHAT = 2;
const BASELINE_JOBS = 1;

/**
 * Suggested worker concurrency for this much physical memory: 2 up to 8 GB,
 * 3 up to 24 GB (16/24 GB Macs), 4 above. Measured 2026-11-06 on an 8 GB Mac
 * at 4: one dev server (2.6 GB), one `tsc` (1.7 GB) and five `claude`
 * (≈ 250 MB each) swapped it to 4.9/6 GB. The half-GiB slack covers a Mac
 * that reports its size a little over or under.
 */
export function suggestedConcurrency(totalMemBytes: number): number {
  const gib = totalMemBytes / GIB;
  if (!Number.isFinite(gib) || gib <= 0) return 2;
  return gib <= 8.5 ? 2 : gib <= 24.5 ? 3 : 4;
}

/** `OrchestratorStatus.machine`: what the server knows of the machine it runs on. */
export interface MachineInfo {
  totalMemBytes: number;
  /** `suggestedConcurrency(totalMemBytes)` — the default an unsaved `orchestrator.concurrency` takes */
  suggestedConcurrency: number;
}

export interface ConcurrencyAdvice {
  /** physical memory, whole GB, for the message */
  totalGb: number;
  suggested: number;
  workers: number;
  /** workers above the suggestion */
  over: boolean;
  /** claude sessions at once at the caps: workers + chat turns + job runs (jobs only while enabled) */
  sessions: number;
  /** the session count the suggestion allows for: suggested workers + the default chat and job caps */
  sessionsSuggested: number;
  /** sessions above `sessionsSuggested` */
  stacked: boolean;
  /** readable lines, empty when nothing is above the suggestion */
  warnings: string[];
}

export type CapacitySettings = Pick<AppSettings, 'orchestrator.concurrency' | 'chat.concurrency' | 'jobs.concurrency' | 'jobs.enabled'>;

const int = (v: unknown, fallback: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * The warning text for these settings on this machine. `over`: workers above
 * the suggestion. `stacked`: workers + chat turns + job runs above the
 * suggestion plus the default chat/job caps — chats and jobs are claude
 * sessions that take no worker slot, so raising them stacks on top.
 */
export function concurrencyAdvice(settings: Partial<CapacitySettings>, totalMemBytes: number): ConcurrencyAdvice {
  const suggested = suggestedConcurrency(totalMemBytes);
  const totalGb = Math.max(1, Math.round(totalMemBytes / GIB));
  const workers = int(settings['orchestrator.concurrency'], suggested);
  const chats = int(settings['chat.concurrency'], BASELINE_CHAT);
  const jobs = settings['jobs.enabled'] === false ? 0 : int(settings['jobs.concurrency'], BASELINE_JOBS);
  const sessions = workers + chats + jobs;
  const sessionsSuggested = suggested + BASELINE_CHAT + BASELINE_JOBS;
  const over = workers > suggested;
  const stacked = sessions > sessionsSuggested;
  const warnings: string[] = [];
  if (over) {
    warnings.push(
      `${workers} workers is above the ${suggested} this Mac's ${totalGb} GB suggests: one build, tsc or dev server per agent can swap it and freeze the machine.`,
    );
  }
  if (stacked) {
    const parts = [`Chats (${chats})`, ...(jobs ? [`jobs (${jobs})`] : [])].join(' and ');
    warnings.push(
      `${parts} stack on top of the workers: up to ${sessions} claude sessions at once, above the ${sessionsSuggested} this Mac's ${totalGb} GB holds comfortably.`,
    );
  }
  return { totalGb, suggested, workers, over, sessions, sessionsSuggested, stacked, warnings };
}
