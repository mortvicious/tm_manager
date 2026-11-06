// Heavy work slots (docs/memory.md § Heavy work), the server half. ONE global
// FIFO semaphore with `heavy.maxParallel` slots (0 = auto from RAM, shared
// `heavyMaxParallel`), shared by:
//  - repo CHECK runs (`CommandRunner.runCheck`, kind `check`): two `tsc` /
//    `next build` in different repos at once is 3–4 GB on an 8 GB laptop;
//  - agent LEASES (`POST /api/agent/heavy/acquire`, routes/agent-heavy.ts):
//    Lighthouse, Playwright, headless Chrome, full builds an agent starts
//    mid-turn — which the memory fuse cannot stop, since it only holds NEW
//    claims and turns. A lease is also held back while the fuse is tripped.
//
// In memory only: a restart kills every check and every worker turn, so no
// holder survives it. While anything is held the machine is sampled every
// HEAVY_SAMPLE_MS (memory + load), so a lease's release can say whether a
// measurement taken under it is trustworthy (`judgeHeavyPressure`).

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { HeavyKind, HeavyPressure, HeavyPressureAccum, HeavyStatus, HeavyTicket, MemorySample } from '@tm/shared';
import {
  HEAVY_LEASE_MAX_MS,
  HEAVY_PRESSURE_EMPTY,
  HEAVY_TICKET_STALE_MS,
  HEAVY_UNCLAIMED_MS,
  foldHeavySample,
  heavyMaxParallel,
  judgeHeavyPressure,
} from '@tm/shared';
import type { Storage } from './storage/types.ts';

/** Machine sample period while a slot is held. */
export const HEAVY_SAMPLE_MS = 15_000;
/** Housekeeping period: settings re-read, stale tickets, lease expiry. */
const HEAVY_TICK_MS = 5_000;

/** How a ticket left the semaphore. */
export type HeavyEnd = 'released' | 'turn-ended' | 'run-exited' | 'abandoned' | 'unclaimed' | 'expired' | 'aborted';

export interface HeavyAcquire {
  kind: HeavyKind;
  taskId: string | null;
  runId: string | null;
  repoId: string | null;
  label: string;
  actor: string;
  /** agent leases: also wait while the memory fuse is tripped */
  gateOnMemory: boolean;
  /** agent leases must be polled while waiting and picked up once granted (stale rules) */
  polled: boolean;
}

interface Ticket extends HeavyTicket {
  actor: string;
  gateOnMemory: boolean;
  polled: boolean;
  /** last time the agent asked about it */
  seenAt: number;
  /** the agent was told it holds the slot */
  delivered: boolean;
  requestedMs: number;
  grantedMs: number | null;
  acc: HeavyPressureAccum;
  waiters: Array<() => void>;
  /** it did not get a slot at once (a check is audited only then) */
  queued: boolean;
}

/** What `release` hands back (the agent's release response, the audit row). */
export interface HeavyRelease {
  ticket: HeavyTicket;
  end: HeavyEnd;
  waitedMs: number;
  heldMs: number;
  pressure: HeavyPressure | null;
}

export interface HeavyDeps {
  storage: Pick<Storage, 'getSettings' | 'appendEvent'>;
  /** the memory fuse's hold reason (null = clear) */
  memoryHold: () => string | null;
  /** the memory fuse is tripped right now (for the pressure report) */
  fuseTripped?: () => boolean;
  /** one memory reading; throws when unreadable */
  sample?: () => Promise<MemorySample>;
  totalMem?: () => number;
  loadavg?: () => number;
  cpus?: () => number;
  /** start the housekeeping timer (tests drive `tick()` themselves) */
  timers?: boolean;
}

export class HeavySlots {
  private held = new Map<string, Ticket>();
  private queue: Ticket[] = [];
  private max = 1;
  private auto = true;
  private listeners = new Set<() => void>();
  private tickTimer: NodeJS.Timeout | null = null;
  private sampleTimer: NodeJS.Timeout | null = null;
  private sampling = false;

  constructor(private deps: HeavyDeps) {
    const cap = heavyMaxParallel(0, this.totalMem());
    this.max = cap.max;
    this.auto = cap.auto;
    if (deps.timers !== false) {
      this.tickTimer = setInterval(() => void this.tick(), HEAVY_TICK_MS);
      this.tickTimer.unref();
    }
  }

  private totalMem(): number {
    return this.deps.totalMem?.() ?? os.totalmem();
  }

  /** Re-read the setting (async); pumps when the count moved. */
  async refreshSettings(): Promise<void> {
    try {
      const settings = await this.deps.storage.getSettings();
      const cap = heavyMaxParallel(settings['heavy.maxParallel'], this.totalMem());
      const changed = cap.max !== this.max || cap.auto !== this.auto;
      this.max = cap.max;
      this.auto = cap.auto;
      if (changed) {
        this.pump();
        this.changed();
      }
    } catch {
      /* keep the last count */
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* a listener's bug is not ours */
      }
    }
  }

  status(): HeavyStatus {
    return {
      max: this.max,
      auto: this.auto,
      held: [...this.held.values()].map(publicTicket),
      waiting: this.queue.map(publicTicket),
    };
  }

  get(id: string): HeavyTicket | null {
    const t = this.held.get(id) ?? this.queue.find((q) => q.id === id);
    return t ? publicTicket(t) : null;
  }

  /** The 1-based place in the queue, or 0 when held / unknown. */
  position(id: string): number {
    return this.queue.findIndex((q) => q.id === id) + 1;
  }

  /** Tickets (held or waiting) of one worker run. */
  forRun(runId: string): HeavyTicket[] {
    return [...this.held.values(), ...this.queue].filter((t) => t.runId === runId).map(publicTicket);
  }

  /** Enqueue a request; granted at once when a slot is free. */
  acquire(spec: HeavyAcquire): HeavyTicket {
    const now = Date.now();
    const t: Ticket = {
      id: `heavy-${randomUUID()}`,
      kind: spec.kind,
      taskId: spec.taskId,
      runId: spec.runId,
      repoId: spec.repoId,
      label: spec.label.slice(0, 200),
      requestedAt: new Date(now).toISOString(),
      grantedAt: null,
      waitingOn: 'slot',
      actor: spec.actor,
      gateOnMemory: spec.gateOnMemory,
      polled: spec.polled,
      seenAt: now,
      delivered: false,
      requestedMs: now,
      grantedMs: null,
      acc: { ...HEAVY_PRESSURE_EMPTY },
      waiters: [],
      queued: false,
    };
    this.queue.push(t);
    this.pump();
    if (!this.held.has(t.id)) t.queued = true;
    this.changed();
    return publicTicket(t);
  }

  /**
   * Resolves true once the ticket holds a slot, false after `ms` (still
   * waiting) — and false at once for an id that is gone. `deliver` marks an
   * agent lease as picked up when it resolves granted.
   */
  wait(id: string, ms: number, deliver = false): Promise<boolean> {
    const held = this.held.get(id);
    if (held) {
      held.seenAt = Date.now();
      if (deliver) held.delivered = true;
      return Promise.resolve(true);
    }
    const t = this.queue.find((q) => q.id === id);
    if (!t) return Promise.resolve(false);
    t.seenAt = Date.now();
    if (ms <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        const granted = this.held.get(id);
        if (granted) {
          granted.seenAt = Date.now();
          if (deliver) granted.delivered = true;
        }
        resolve(!!granted);
      };
      const timer = setTimeout(() => {
        const at = t.waiters.indexOf(done);
        if (at >= 0) t.waiters.splice(at, 1);
        t.seenAt = Date.now();
        resolve(this.held.has(id));
      }, ms);
      t.waiters.push(done);
    });
  }

  /** Mark a held/waiting agent ticket as seen (a status poll). */
  touch(id: string, deliver = false): void {
    const t = this.held.get(id) ?? this.queue.find((q) => q.id === id);
    if (!t) return;
    t.seenAt = Date.now();
    if (deliver && this.held.has(id)) t.delivered = true;
  }

  /** The pressure report so far for a held ticket (null when not held). */
  pressure(id: string): HeavyPressure | null {
    const t = this.held.get(id);
    return t ? judgeHeavyPressure(t.acc, this.cpus()) : null;
  }

  private cpus(): number {
    return this.deps.cpus?.() ?? os.availableParallelism?.() ?? os.cpus().length;
  }

  /** Drop a ticket, held or waiting. Null when it was already gone. */
  release(id: string, end: HeavyEnd = 'released'): HeavyRelease | null {
    const now = Date.now();
    let t = this.held.get(id);
    if (t) this.held.delete(id);
    else {
      const at = this.queue.findIndex((q) => q.id === id);
      if (at < 0) return null;
      t = this.queue[at];
      this.queue.splice(at, 1);
      for (const w of t.waiters.splice(0)) w();
    }
    const out: HeavyRelease = {
      ticket: publicTicket(t),
      end,
      waitedMs: (t.grantedMs ?? now) - t.requestedMs,
      heldMs: t.grantedMs ? now - t.grantedMs : 0,
      pressure: t.grantedMs ? judgeHeavyPressure(t.acc, this.cpus()) : null,
    };
    this.audit(t, end, out);
    this.pump();
    if (!this.held.size) this.stopSampling();
    this.changed();
    return out;
  }

  /** A worker run's turn ended or its process exited: every ticket of it goes. */
  releaseForRun(runId: string, end: HeavyEnd): HeavyRelease[] {
    const ids = [...this.held.values(), ...this.queue].filter((t) => t.runId === runId).map((t) => t.id);
    return ids.map((id) => this.release(id, end)).filter((r): r is HeavyRelease => !!r);
  }

  /** Grant waiting tickets in FIFO order while a slot is free. A memory-gated
   *  lease at the head steps aside for a check behind it, never the reverse. */
  pump(): void {
    const memory = this.deps.memoryHold();
    let granted = false;
    for (const t of [...this.queue]) {
      if (this.held.size >= this.max) {
        t.waitingOn = t.gateOnMemory && memory ? 'memory' : 'slot';
        continue;
      }
      if (t.gateOnMemory && memory) {
        t.waitingOn = 'memory';
        continue;
      }
      this.queue.splice(this.queue.indexOf(t), 1);
      const now = Date.now();
      t.grantedMs = now;
      t.grantedAt = new Date(now).toISOString();
      t.waitingOn = null;
      t.seenAt = now;
      this.held.set(t.id, t);
      granted = true;
      if (t.polled) this.audit(t, 'granted', null);
      for (const w of t.waiters.splice(0)) w();
    }
    if (granted) {
      this.startSampling();
      void this.sampleNow();
      this.changed();
    }
  }

  /**
   * Housekeeping: settings, the memory fuse's clear (pump), waiting agent
   * tickets nobody polls, granted leases nobody picked up, leases past
   * HEAVY_LEASE_MAX_MS. Public for tests.
   */
  async tick(now = Date.now()): Promise<void> {
    await this.refreshSettings();
    for (const t of [...this.queue]) {
      if (t.polled && now - t.seenAt > HEAVY_TICKET_STALE_MS) this.release(t.id, 'abandoned');
    }
    for (const t of [...this.held.values()]) {
      if (!t.polled || t.grantedMs == null) continue;
      if (!t.delivered && now - Math.max(t.grantedMs, t.seenAt) > HEAVY_UNCLAIMED_MS) this.release(t.id, 'unclaimed');
      else if (now - t.grantedMs > HEAVY_LEASE_MAX_MS) this.release(t.id, 'expired');
    }
    const before = JSON.stringify(this.queue.map((q) => q.waitingOn));
    this.pump();
    if (JSON.stringify(this.queue.map((q) => q.waitingOn)) !== before) this.changed();
  }

  private startSampling(): void {
    if (this.sampleTimer || !this.deps.sample) return;
    this.sampleTimer = setInterval(() => void this.sampleNow(), HEAVY_SAMPLE_MS);
    this.sampleTimer.unref();
  }

  private stopSampling(): void {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.sampleTimer = null;
  }

  /** One machine reading folded into every holder's accumulator. Public for tests. */
  async sampleNow(): Promise<void> {
    if (this.sampling || !this.held.size) return;
    this.sampling = true;
    try {
      let s: MemorySample | null = null;
      try {
        s = this.deps.sample ? await this.deps.sample() : null;
      } catch {
        s = null;
      }
      const load1 = this.deps.loadavg?.() ?? os.loadavg()[0] ?? 0;
      const fuse = this.deps.fuseTripped?.() ?? false;
      const n = this.held.size;
      for (const t of this.held.values()) {
        t.acc = foldHeavySample(t.acc, {
          freePct: s?.freePct ?? null,
          swapPct: s?.swapPct ?? null,
          pressureLevel: s?.pressureLevel ?? null,
          load1,
          fuseTripped: fuse,
          others: n - 1,
        });
      }
    } finally {
      this.sampling = false;
    }
  }

  /** `heavy.lease` audit: agent leases' grant + every end; a check's end only when it had to queue. */
  private audit(t: Ticket, action: HeavyEnd | 'granted', out: HeavyRelease | null): void {
    if (!t.polled && !t.queued) return;
    void this.deps.storage
      .appendEvent({
        kind: 'heavy.lease',
        actor: t.actor,
        taskId: t.taskId,
        runId: t.runId,
        repoId: t.repoId,
        data: {
          action,
          id: t.id,
          kind: t.kind,
          label: t.label,
          ...(out
            ? {
                waitedMs: out.waitedMs,
                heldMs: out.heldMs,
                ...(out.pressure ? { underPressure: out.pressure.underPressure, reasons: out.pressure.reasons } : {}),
              }
            : { waitedMs: (t.grantedMs ?? Date.now()) - t.requestedMs }),
        },
      })
      .catch(() => {});
  }

  /** Shutdown: drop everything, wake every waiter (they see "not granted"). */
  stopAll(): void {
    for (const t of this.queue.splice(0)) for (const w of t.waiters.splice(0)) w();
    this.held.clear();
    this.stopSampling();
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }
}

function publicTicket(t: Ticket): HeavyTicket {
  return {
    id: t.id,
    kind: t.kind,
    taskId: t.taskId,
    runId: t.runId,
    repoId: t.repoId,
    label: t.label,
    requestedAt: t.requestedAt,
    grantedAt: t.grantedAt,
    waitingOn: t.waitingOn,
  };
}

let instance: HeavySlots | null = null;

/** The process's slots (index.ts calls `initHeavy`). */
export function heavy(): HeavySlots | null {
  return instance;
}

export function initHeavy(slots: HeavySlots | null): void {
  instance = slots;
}
