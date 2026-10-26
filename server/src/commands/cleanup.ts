import type { RepoCommand, TaskStatus } from '@tm/shared';
import { DEFAULT_SETTINGS } from '@tm/shared';
import { broadcast, onEvent } from '../events.ts';
import type { Storage } from '../storage/types.ts';
import type { CommandRunner } from './runner.ts';

/**
 * Agent-owned saved commands are tidied away once nobody needs them
 * (docs/commands.md § Agent-owned commands). An agent saves a dev server for
 * ITS task — `next start -p 3108` against its own worktree, a scratch script —
 * and nothing ever removed one, so one repo's launcher reached 99 services.
 *
 * The rule, per command with an owner task, never a human's:
 *  - the owner landed (done / published / cancelled) or no longer exists, or
 *  - it was not started for `commands.agentTtlDays` (0 = this rule off)
 *  → ARCHIVED: hidden from the launcher and the agent list, restorable from
 *    the repo's command panel. Never deleted, never a check, never while a run
 *    of it is live (that run keeps its definition until it exits; the next
 *    sweep gets it). `failed` is not terminal here: a failed task is retried.
 */
export const OWNER_DONE_STATUSES: readonly TaskStatus[] = ['done', 'published', 'cancelled'];

/** Periodic pass; the owner-landed case is also caught right after the transition. */
const SWEEP_EVERY_MS = 10 * 60_000;
/** Coalesces a burst of landings (a feature phase, a bulk cancel) into one pass. */
const AFTER_TRANSITION_MS = 5_000;
const DAY_MS = 24 * 60 * 60_000;

export type ArchiveReason = 'owner-done' | 'owner-published' | 'owner-cancelled' | 'owner-gone' | 'unused';

/** Why `c` should be archived now, or null. Pure apart from the owner lookup. */
export async function archiveReason(
  c: RepoCommand,
  ownerStatus: (taskId: string) => Promise<TaskStatus | null>,
  ttlDays: number,
  now: number,
): Promise<ArchiveReason | null> {
  if (!c.ownerTaskId || c.archivedAt || c.isCheck) return null;
  const status = await ownerStatus(c.ownerTaskId);
  if (status === null) return 'owner-gone';
  if (OWNER_DONE_STATUSES.includes(status)) return `owner-${status}` as ArchiveReason;
  if (ttlDays > 0) {
    const used = Date.parse(c.lastRunAt ?? c.createdAt);
    if (Number.isFinite(used) && now - used > ttlDays * DAY_MS) return 'unused';
  }
  return null;
}

export class AgentCommandCleanup {
  private sweeping: Promise<number> | null = null;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private off: (() => void) | null = null;

  constructor(
    private storage: Storage,
    private runner: CommandRunner,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.sweep().catch(() => {}), SWEEP_EVERY_MS);
    this.timer.unref();
    this.off = onEvent((e) => {
      if (e.type !== 'event.appended' || e.event.kind !== 'task.transition') return;
      const to = (e.event.data as { to?: TaskStatus } | null)?.to;
      if (!to || !OWNER_DONE_STATUSES.includes(to)) return;
      if (this.soon) return;
      this.soon = setTimeout(() => {
        this.soon = null;
        void this.sweep().catch(() => {});
      }, AFTER_TRANSITION_MS);
      this.soon.unref();
    });
    void this.sweep().catch(() => {});
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.soon) clearTimeout(this.soon);
    this.off?.();
    this.timer = this.soon = null;
    this.off = null;
  }

  /** One pass; returns how many commands it archived. Single-flight: a call during a pass queues one more. */
  sweep(): Promise<number> {
    if (this.sweeping) {
      this.again = true;
      return this.sweeping;
    }
    this.sweeping = (async () => {
      let n = 0;
      try {
        do {
          this.again = false;
          n += await this.pass();
        } while (this.again);
      } finally {
        this.sweeping = null;
      }
      return n;
    })();
    return this.sweeping;
  }

  private async pass(): Promise<number> {
    const settings = await this.storage.getSettings();
    const ttl = Number(settings['commands.agentTtlDays'] ?? DEFAULT_SETTINGS['commands.agentTtlDays']);
    const owners = new Map<string, TaskStatus | null>();
    const ownerStatus = async (id: string) => {
      if (!owners.has(id)) owners.set(id, (await this.storage.getTask(id))?.status ?? null);
      return owners.get(id)!;
    };
    const now = Date.now();
    let n = 0;
    for (const c of await this.storage.listCommands()) {
      if (this.runner.runningFor(c.id)) continue;
      const reason = await archiveReason(c, ownerStatus, Number.isFinite(ttl) ? ttl : 0, now);
      if (!reason) continue;
      // re-read: a human may have restored (adopted) or deleted it meanwhile
      const fresh = await this.storage.getCommand(c.id);
      if (!fresh || fresh.archivedAt || fresh.ownerTaskId !== c.ownerTaskId || this.runner.runningFor(c.id)) continue;
      const archived = await this.storage.updateCommand(c.id, { archivedAt: new Date().toISOString() });
      if (!archived) continue;
      n++;
      await this.storage.appendEvent({
        kind: 'command.changed',
        actor: 'system',
        repoId: c.repoId,
        taskId: c.ownerTaskId,
        data: { action: 'archived', commandId: c.id, name: c.name, command: c.command, reason, lastRunAt: c.lastRunAt },
      });
      broadcast({ type: 'command.updated', command: archived });
    }
    return n;
  }
}
