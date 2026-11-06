// TM Bar's one read (docs/menubar.md): `GET /api/menubar` folds the
// orchestrator's status, the live tasks and the Inbox into a small summary the
// native menu-bar app decodes. Pure, so the route and its test share it, and so
// the Inbox count is THE shared `buildInbox` — never a Swift re-implementation.

import {
  buildInbox,
  type InboxInput,
  type InboxItem,
  type OrchestratorStatus,
  type Repo,
  type Run,
  type Task,
} from './types.ts';
import type { MemorySample } from './memory.ts';

export interface MenubarTask {
  id: string;
  title: string;
  repoName: string | null;
  status: 'running' | 'waiting';
  /** the live worker run's start (ISO); null when no live worker run is known */
  startedAt: string | null;
  /** its live run is flagged needs-attention (a prompt in the hidden terminal) */
  needsAttention: boolean;
  /** a pending question (docs/questions.md) */
  asking: boolean;
}

export interface MenubarSummary {
  at: string;
  queue: {
    /** `orchestrator.enabled` — the global queue switch */
    enabled: boolean;
    /** Pause all (docs/pause.md) */
    paused: boolean;
    /** tasks Pause all suspended (`paused_turn` markers) — what Continue resumes */
    pausedTasks: number;
    /** live non-idle worker PTYs (`OrchestratorStatus.running`) */
    running: number;
    concurrency: number;
    /** live aux terminals (reviews, plans, chats…) */
    aux: number;
  };
  /** running + waiting tasks, longest-running first */
  tasks: MenubarTask[];
  inbox: {
    /** what the SPA's Inbox chip shows: every item but stale drafts */
    total: number;
    /** question items (one per asking task) */
    questions: number;
    /** total − questions: approvals, attention, reviews, failed, … */
    needsYou: number;
    /** any question or needs-attention item — the chip's urgent tint */
    urgent: boolean;
  };
  /** the memory fuse (docs/memory.md) + this Mac's free/swap reading (the
   *  fuse's own sample when armed, else a 15 s cached `sampleSystemMemory`);
   *  null when the server reports no fuse */
  memory: {
    freePct: number | null;
    swapPct: number | null;
    swapUsedMb: number | null;
    swapTotalMb: number | null;
    /** 1 normal, 2 warn, 4 critical (macOS) */
    pressureLevel: number | null;
    /** either limit is set */
    armed: boolean;
    tripped: boolean;
    reason: string | null;
    /** non-null while the fuse is holding new work */
    hold: string | null;
  } | null;
  heavy: { max: number; held: number; waiting: number } | null;
}

export interface MenubarInput {
  status: OrchestratorStatus;
  tasks: Task[];
  repos: Repo[];
  /** live (`running`) runs, worker and aux */
  live: Run[];
  inbox: Omit<InboxInput, 'tasks' | 'runs' | 'repoIds' | 'workspaceId' | 'now'>;
  /** a reading for when the fuse is off (it samples only while armed) */
  memorySample?: MemorySample | null;
  now?: number;
}

/** The SPA chip's count rule (`decisions()` in web/src/components/Inbox.tsx). */
export function menubarInboxCounts(items: InboxItem[]): MenubarSummary['inbox'] {
  const decisions = items.filter((i) => i.kind !== 'stale-draft');
  const questions = decisions.filter((i) => i.kind === 'question').length;
  return {
    total: decisions.length,
    questions,
    needsYou: decisions.length - questions,
    urgent: decisions.some((i) => i.kind === 'question' || i.kind === 'attention'),
  };
}

export function buildMenubarSummary(input: MenubarInput): MenubarSummary {
  const now = input.now ?? Date.now();
  const { status } = input;
  const repoName = new Map(input.repos.map((r) => [r.id, r.name]));
  // newest live worker run per task: the one whose clock the menu shows
  const worker = new Map<string, Run>();
  for (const r of input.live) {
    if (!r.taskId || r.mode !== 'worker') continue;
    const prev = worker.get(r.taskId);
    if (!prev || r.startedAt > prev.startedAt) worker.set(r.taskId, r);
  }
  const asking = new Set(input.inbox.questions.filter((q) => q.status === 'pending').map((q) => q.taskId));
  const tasks: MenubarTask[] = input.tasks
    .filter((t): t is Task & { status: 'running' | 'waiting' } => t.status === 'running' || t.status === 'waiting')
    .map((t) => {
      const run = worker.get(t.id);
      return {
        id: t.id,
        title: t.title,
        repoName: t.repoId ? (repoName.get(t.repoId) ?? null) : null,
        status: t.status,
        startedAt: run?.startedAt ?? null,
        needsAttention: !!run && !run.idle && !!run.needsAttention,
        asking: asking.has(t.id),
      };
    })
    .sort((a, b) => (a.startedAt ?? '￿').localeCompare(b.startedAt ?? '￿'));

  const items = buildInbox({ ...input.inbox, tasks: input.tasks, runs: input.live, now });
  const mem = status.memory;
  const sample = mem?.sample ?? input.memorySample ?? null;
  return {
    at: new Date(now).toISOString(),
    queue: {
      enabled: status.enabled,
      paused: !!status.paused,
      pausedTasks: status.pausedTasks ?? 0,
      running: status.running,
      concurrency: status.concurrency,
      aux: status.aux,
    },
    tasks,
    inbox: menubarInboxCounts(items),
    memory: mem
      ? {
          freePct: sample?.freePct ?? null,
          swapPct: sample?.swapPct ?? null,
          swapUsedMb: sample?.swapUsedMb ?? null,
          swapTotalMb: sample?.swapTotalMb ?? null,
          pressureLevel: sample?.pressureLevel ?? null,
          armed: mem.limits.minFreePct > 0 || mem.limits.maxSwapPct > 0,
          tripped: mem.tripped,
          reason: mem.reason,
          hold: mem.hold,
        }
      : null,
    heavy: status.heavy
      ? { max: status.heavy.max, held: status.heavy.held.length, waiting: status.heavy.waiting.length }
      : null,
  };
}
