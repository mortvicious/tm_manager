import type { CommandKind, CommandReap, CommandRun, Task } from '@tm/shared';
import { DEFAULT_SETTINGS, verifyOpen } from '@tm/shared';
import type { Storage } from '../storage/types.ts';
import type { CommandRunner } from './runner.ts';

/**
 * Idle agent servers (docs/commands.md § Idle agent servers). A dev server an
 * agent starts through /api/agent/commands outlives its task by design — the
 * next task in the repo reuses it — but nothing ever stopped one, and a
 * `nest start --watch` alone held 2.6 GB on an 8 GB laptop.
 *
 * The rule, per LIVE run with an owner task (`ownerTaskId`), never a human's:
 *  - a run is IN USE while any task that used it (the owner, plus every task
 *    whose agent started-or-reused, restarted or read its logs) is `running`
 *    or `waiting`, or sits in `review` with its verify round open (a check may
 *    be hitting the server), or while a terminal is attached to it (a human
 *    watching);
 *  - otherwise it is IDLE from the later of the first sweep that saw it so
 *    and its last use; past `commands.idleStopMinutes` (0 = never) it is
 *    stopped, audited `command.reaped`.
 * Checks, baselines and office-shift runs are exempt: they end by themselves.
 *
 * And a CAP: at most `commands.agentServersPerRepo` (0 = none) live
 * agent-started SERVICE runs per repo. A new start past it evicts the
 * longest-idle run nobody uses (reason `cap`); with every one in use it is
 * refused. Admission is serialized per repo, so two starts cannot both pass.
 */

/** How often the idle rule is evaluated. The window is minutes, so a minute of slack is fine. */
const SWEEP_EVERY_MS = 60_000;
/** Evicting for the cap waits this long for the process to go (SIGKILL after 5s). */
const EVICT_EXIT_MS = 8_000;

/** Runs the reaper may ever touch: agent-started, not a check/baseline/office run. */
export function reapable(r: CommandRun): boolean {
  return !!r.ownerTaskId && !r.checkTaskId && !r.checkBaseline && !r.officeShiftId;
}

/** Does this task (a user of a run) still need it? Deleted = no. */
export function taskNeedsServer(t: Pick<Task, 'status' | 'reviewState' | 'checkState'> | null): boolean {
  if (!t) return false;
  return t.status === 'running' || t.status === 'waiting' || verifyOpen(t);
}

/**
 * When a not-in-use run's idleness began: the later of the reaper's mark and
 * its last use. Pure.
 */
export function idleFrom(idleSince: string | null | undefined, lastUseMs: number, now: number): number {
  const mark = idleSince ? Date.parse(idleSince) : now;
  return Math.max(Number.isFinite(mark) ? mark : now, lastUseMs);
}

export class CapRefusal extends Error {
  constructor(
    message: string,
    readonly live: CommandRun[],
  ) {
    super(message);
  }
}

export class IdleServerReaper {
  private timer: NodeJS.Timeout | null = null;
  private sweeping: Promise<number> | null = null;
  /** per-repo admission chain (the cap) */
  private admitting = new Map<string, Promise<unknown>>();

  constructor(
    private storage: Storage,
    private runner: CommandRunner,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.sweep().catch(() => {}), SWEEP_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass; returns how many runs it stopped. Single-flight. */
  sweep(now = Date.now()): Promise<number> {
    if (!this.sweeping) {
      this.sweeping = this.pass(now).finally(() => {
        this.sweeping = null;
      });
    }
    return this.sweeping;
  }

  private async settings(): Promise<{ windowMin: number; cap: number }> {
    const s = await this.storage.getSettings();
    const num = (k: 'commands.idleStopMinutes' | 'commands.agentServersPerRepo') => {
      const v = Number(s[k] ?? DEFAULT_SETTINGS[k]);
      return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
    };
    return { windowMin: num('commands.idleStopMinutes'), cap: num('commands.agentServersPerRepo') };
  }

  /** In use = a user task still needs it, or a terminal is attached. */
  private async inUse(run: CommandRun, cache: Map<string, Task | null>): Promise<boolean> {
    if (this.runner.watchers(run.id) > 0) return true;
    for (const u of this.runner.usersOf(run.id)) {
      if (!cache.has(u.taskId)) cache.set(u.taskId, await this.storage.getTask(u.taskId));
      if (taskNeedsServer(cache.get(u.taskId)!)) return true;
    }
    return false;
  }

  private lastUse(run: CommandRun): number {
    const at = this.runner.usersOf(run.id).map((u) => u.at);
    return at.length ? Math.max(...at) : Date.parse(run.startedAt);
  }

  private async pass(now: number): Promise<number> {
    const { windowMin } = await this.settings();
    const cache = new Map<string, Task | null>();
    let n = 0;
    for (const run of this.runner.running().filter(reapable)) {
      if (await this.inUse(run, cache)) {
        this.runner.setIdleSince(run.id, null);
        continue;
      }
      const fresh = this.runner.get(run.id);
      if (!fresh || fresh.status !== 'running') continue;
      if (!fresh.idleSince) this.runner.setIdleSince(run.id, new Date(now).toISOString());
      const from = idleFrom(this.runner.get(run.id)?.idleSince, this.lastUse(run), now);
      if (windowMin <= 0 || now - from < windowMin * 60_000) continue;
      if (await this.reap(run, 'idle', now - from, cache)) n++;
    }
    return n;
  }

  private async reap(run: CommandRun, reason: CommandReap['reason'], idleMs: number, cache: Map<string, Task | null>): Promise<boolean> {
    const idleMinutes = Math.max(0, Math.floor(idleMs / 60_000));
    const users = this.runner.usersOf(run.id).map((u) => u.taskId);
    if (!this.runner.reap(run.id, { at: new Date().toISOString(), reason, idleMinutes })) return false;
    const owner = run.ownerTaskId ? (cache.get(run.ownerTaskId) ?? null) : null;
    await this.storage
      .appendEvent({
        kind: 'command.reaped',
        actor: 'system',
        repoId: run.repoId,
        taskId: run.ownerTaskId,
        data: {
          runId: run.id,
          commandId: run.commandId,
          name: run.name,
          command: run.command,
          kind: run.kind,
          reason,
          idleMinutes,
          ownerStatus: owner?.status ?? null,
          users,
          ...(run.oneShot ? { oneShot: true } : {}),
        },
      })
      .catch(() => {});
    return true;
  }

  /**
   * Start a NEW agent run in `repoId` under the cap (a reuse never comes
   * here). Serialized per repo; throws CapRefusal when every live
   * agent-started server of the repo is in use. Only `service` runs count.
   */
  admit<T>(repoId: string, kind: CommandKind, start: () => Promise<T>): Promise<T> {
    const prev = this.admitting.get(repoId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      if (kind === 'service') await this.makeRoom(repoId);
      return start();
    });
    const tail = next.catch(() => {});
    this.admitting.set(repoId, tail);
    void tail.then(() => {
      if (this.admitting.get(repoId) === tail) this.admitting.delete(repoId);
    });
    return next;
  }

  private liveServers(repoId: string): CommandRun[] {
    return this.runner.running().filter((r) => reapable(r) && r.kind === 'service' && r.repoId === repoId);
  }

  private async makeRoom(repoId: string): Promise<void> {
    const { cap } = await this.settings();
    if (cap <= 0) return;
    const cache = new Map<string, Task | null>();
    let live = this.liveServers(repoId);
    while (live.length >= cap) {
      const now = Date.now();
      const idle: Array<{ run: CommandRun; from: number }> = [];
      for (const r of live) {
        // not yet marked by a sweep → idle since its last use, so the order is stable
        if (!(await this.inUse(r, cache))) {
          idle.push({ run: r, from: r.idleSince ? idleFrom(r.idleSince, this.lastUse(r), now) : this.lastUse(r) });
        }
      }
      idle.sort((a, b) => a.from - b.from);
      const victim = idle[0];
      if (!victim) {
        throw new CapRefusal(
          `this repo already has ${live.length} agent-started servers running, all in use by live tasks (cap commands.agentServersPerRepo = ${cap}) — reuse one of them (GET /api/agent/commands lists them), or stop one your task started`,
          live,
        );
      }
      if (await this.reap(victim.run, 'cap', now - victim.from, cache)) {
        await this.runner.waitForExit(victim.run.id, EVICT_EXIT_MS);
      }
      // a process that ignores SIGHUP and SIGKILL stays `running` and keeps counting
      const after = this.liveServers(repoId);
      if (after.length >= live.length) {
        throw new CapRefusal(
          `this repo is at its cap of ${cap} agent-started servers and "${victim.run.name}" did not exit when stopped — try again shortly`,
          after,
        );
      }
      live = after;
    }
  }
}
