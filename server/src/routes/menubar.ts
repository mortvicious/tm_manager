import type { FastifyInstance } from 'fastify';
import { buildMenubarSummary, type MemorySample, type MenubarSummary, type OrchestratorStatus } from '@tm/shared';
import { sampleSystemMemory } from '../memory.ts';
import { loadInboxSources } from '../inbox-input.ts';
import type { Storage } from '../storage/types.ts';

/** What the route needs from the orchestrator (a stub in the test). */
export interface MenubarStatusSource {
  status(): Promise<OrchestratorStatus> | OrchestratorStatus;
}

/** Concurrent polls (several menus, a fast open-menu poll) share one read. */
const COALESCE_MS = 1000;
/** The fuse samples only while armed; with it off, the menu still shows free/swap from one `sysctl` per 15 s. */
const SAMPLE_MS = 15_000;

/**
 * `GET /api/menubar` — TM Bar's summary (docs/menubar.md): queue/pause, the
 * running + waiting tasks, the Inbox count (the shared `buildInbox`) and the
 * memory fuse in one read-only GET. Same guards as every API GET (Host
 * allowlist; no Origin needed for a GET). No new data: everything here is
 * already readable through /api/orchestrator, /api/tasks and friends.
 */
export function registerMenubarRoutes(
  app: FastifyInstance,
  storage: Storage,
  orch: MenubarStatusSource,
  sampler: () => Promise<MemorySample> = sampleSystemMemory,
) {
  let cached: { at: number; value: Promise<MenubarSummary> } | null = null;
  let sample: { at: number; value: MemorySample | null } | null = null;
  const ownSample = async (now: number): Promise<MemorySample | null> => {
    if (sample && now - sample.at < SAMPLE_MS) return sample.value;
    // a failed reading is an absent one, never a failed summary
    const value = await sampler().catch(() => null);
    sample = { at: now, value };
    return value;
  };
  app.get('/api/menubar', async () => {
    const now = Date.now();
    if (cached && now - cached.at < COALESCE_MS) return cached.value;
    const value = (async () => {
      const [status, src] = await Promise.all([orch.status(), loadInboxSources(storage)]);
      const memorySample = status.memory && !status.memory.sample ? await ownSample(now) : null;
      return buildMenubarSummary({
        memorySample,
        status,
        tasks: src.tasks,
        repos: src.repos,
        live: src.live,
        inbox: {
          questions: src.questions,
          approvals: src.approvals,
          proposals: src.proposals,
          features: src.features,
          jobs: src.jobs,
          jobRuns: src.jobRuns,
          officeProposals: src.officeProposals,
          officeRoles: src.officeRoles,
          staleDraftDays: src.staleDraftDays,
        },
        now,
      });
    })();
    cached = { at: now, value };
    // a failed read is never served to the next poll
    value.catch(() => {
      if (cached?.value === value) cached = null;
    });
    return value;
  });
}
