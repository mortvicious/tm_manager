import type { AppSettings } from '@tm/shared';
import { DEFAULT_SETTINGS } from '@tm/shared';

// The agent API's caps, shared by routes/agent.ts and routes/agent-shared.ts
// (its own module so neither route file imports the other).

/** Agent-created tasks that may sit `queued` at once before new ones degrade to drafts (R8). */
export const QUEUED_AGENT_CEILING = 10;

/**
 * Depth cap (R4, raised and made a setting by docs/shared-spaces.md § Depth):
 * how many agent hops from a human a task may be and still file tasks.
 * Sanitised like the creation cap — a hand-edited row must not disable it.
 */
export function maxSpawnDepth(settings: AppSettings): number {
  const raw = settings['agent.maxSpawnDepth'] as unknown;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SETTINGS['agent.maxSpawnDepth'];
  return Math.min(50, Math.max(1, Math.floor(raw)));
}

/** Per-run creation cap: `agent.taskCreationCap`, sanitised (a hand-edited or
 *  legacy config row must not disable the guard or make it unreachable). */
export function perRunCap(settings: AppSettings): number {
  const raw = settings['agent.taskCreationCap'] as unknown;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SETTINGS['agent.taskCreationCap'];
  return Math.min(100, Math.max(1, Math.floor(raw)));
}
