import { z } from 'zod';
import type { AppSettings } from '@tm/shared';
import { AGENT_BRIEF_MAX, agentTitleProblem, DEFAULT_SETTINGS } from '@tm/shared';
import type { Storage } from '../storage/types.ts';

// The agent API's caps, shared by routes/agent.ts and routes/agent-shared.ts
// (its own module so neither route file imports the other).

/** Agent-created tasks that may sit `queued` at once before new ones degrade to drafts (R8). */
export const QUEUED_AGENT_CEILING = 10;

/**
 * Enqueue gating of `POST /api/agent/tasks` (R6/R8): the explicit opt-in
 * setting AND the queue on; same-repo creations are ALWAYS drafts (two agents
 * must not edit one working tree); the global ceiling degrades to a draft,
 * never a retry-bait 4xx. The ceiling counts AGENT filings only —
 * `countQueuedAgentTasks` leaves office tasks out (docs/office.md § Filing),
 * so a busy office never pushes a worker's filing down to a draft.
 */
export async function agentEnqueueGate(
  storage: Pick<Storage, 'countQueuedAgentTasks'>,
  settings: AppSettings,
  o: { enqueue: boolean; targetRepoId: string; runRepoId: string | null },
): Promise<{ status: 'draft' | 'queued'; note: string | null }> {
  if (!o.enqueue) return { status: 'draft', note: null };
  if (!settings['agent.allowEnqueue']) {
    return { status: 'draft', note: 'enqueue disabled (agent.allowEnqueue is off) — created as draft for human review' };
  }
  if (!settings['orchestrator.enabled']) return { status: 'draft', note: 'queue is stopped — created as draft' };
  if (o.targetRepoId === o.runRepoId) {
    return { status: 'draft', note: 'same-repo follow-ups are always drafts (no concurrent edits to one working tree)' };
  }
  if ((await storage.countQueuedAgentTasks()) >= QUEUED_AGENT_CEILING) {
    return { status: 'draft', note: `agent queue ceiling (${QUEUED_AGENT_CEILING}) reached — created as draft` };
  }
  return { status: 'queued', note: null };
}

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
