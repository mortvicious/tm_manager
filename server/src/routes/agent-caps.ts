import { z } from 'zod';
import type { AppSettings } from '@tm/shared';
import { AGENT_BRIEF_MAX, agentTitleProblem, DEFAULT_SETTINGS } from '@tm/shared';

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

/**
 * The title an agent files a task under: one short line (docs/agent-api-design.md
 * § Title and brief). Refused rather than clipped, so the agent rewrites it.
 */
export const agentTitle = z
  .string()
  .trim()
  .superRefine((t, ctx) => {
    const problem = agentTitleProblem(t);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

/** The filer's before-work summary for the human (`Task.brief`). Required. */
export const agentBrief = z
  .string({ error: 'brief is required — 1-3 plain sentences telling the human what will be done' })
  .trim()
  .min(1, 'brief is empty — 1-3 plain sentences telling the human what will be done')
  .max(AGENT_BRIEF_MAX, `brief is longer than ${AGENT_BRIEF_MAX} chars — it is a summary, the details go in "description"`);
