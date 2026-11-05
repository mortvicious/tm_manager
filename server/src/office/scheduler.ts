// The office scheduler (docs/office.md § Scheduler and states): a one-minute
// tick, modelled on the digest's (`telegram/digest.ts`), that wakes each
// office role on its cron schedules — through the gate, never around it.
//
// Two facts per role decide whether a slot is owed, both persisted so a
// restart or a Mac asleep for six hours changes nothing:
//
// - **lastSlot** — `trigger.at` of the role's newest CRON shift row, ran OR
//   skipped (`tm_office_shifts`). A skip consumes its slot, or the same slot
//   would be judged again every minute.
// - **armedAt** — `tm_office_roles.armed_at`: when the schedule started
//   counting (created, enabled, schedules changed, office enabled or
//   re-zoned). Slots before it were never owed.
//
// `dueSlots` turns those into AT MOST ONE wake per role: the latest due slot,
// however many were missed. Each wake goes through `officeGate`:
//
// - a refusal (guard, hard gate, a runner refusal no retry would fix) appends a
//   shift row with verdict `skipped` and an `office.shift-skipped` audit row —
//   coalesced, one per role per reason class per hour;
// - a busy slot (`slots`, or the runner's per-office / overall ceiling) is a
//   DEFERRAL, not a skip: no row, the slot stays owed and is retried next
//   minute (one coalesced `office.shift-deferred` row);
// - a pass starts the shift (`ShiftRunner.start`), whose row records trigger
//   `cron` with the schedule as `ref` and the slot as `at`.
//
// Shutdown waits for nothing: a live shift is an aux run, ended by
// `aux().stopAll()` and closed by the runner's boot recovery.
import type { AppSettings, Office, OfficeRole, OfficeRoleStateEntry, OfficeStates, ServerEvent } from '@tm/shared';
import { OFFICE_WAKE_NOTE_MAX, dueSlots, formatOfficeTime, nextRoleSlot, officeDayStart, roleState, type OfficeDueWake } from '@tm/shared';
import { broadcast as defaultBroadcast } from '../events.ts';
import type { Storage } from '../storage/types.ts';
import { officeZone } from './budget.ts';
import { officeGate, type CommitCounter } from './gate.ts';
import type { ShiftStart, ShiftTriggerInput } from './shift.ts';
import { checkOfficeDocs } from './docs.ts';

/** One minute: the cron grid's own resolution. */
export const OFFICE_TICK_MS = 60_000;
/** Skip / deferral audit rows: one per role per reason class per this window. */
export const OFFICE_SKIP_COALESCE_MS = 60 * 60_000;

/** Refusals that mean "not now", never "not this slot": the slot stays owed. */
const DEFER_CODES = new Set<string>(['slots', 'office-busy', 'busy', 'paused']);

/** What the scheduler needs of the shift runner. */
export interface ShiftStarter {
  start(office: Office, role: OfficeRole, trigger: ShiftTriggerInput): Promise<ShiftStart>;
}

export interface OfficeSchedulerDeps {
  storage: Storage;
  shifts: () => ShiftStarter;
  /** injected clock (tests); default `Date.now` */
  now?: () => number;
  /** the `new-commits-since` guard's git read (tests) */
  countCommits?: CommitCounter;
  broadcast?: (m: ServerEvent) => void;
  log?: (line: string) => void;
}

export interface OfficeTickReport {
  woken: { officeId: string; roleId: string; shiftId: string; at: string; missed: number }[];
  skipped: { officeId: string; roleId: string; shiftId: string; code: string; reason: string }[];
  deferred: { officeId: string; roleId: string; code: string; reason: string }[];
}

export type OfficeWakeResult =
  | { ok: true; shiftId: string }
  | { ok: false; status: 404 | 409; error: string; code?: string };

const iso = (ms: number) => new Date(ms).toISOString();

/** The newest cron slot the role was judged on (ran or skipped), or null. */
export async function lastCronSlot(storage: Storage, roleId: string): Promise<number | null> {
  let best: number | null = null;
  for (const s of await storage.listShifts({ roleId, triggerKind: 'cron', limit: 5 })) {
    const t = Date.parse(s.trigger.at);
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best;
}

/** `armedAt` as ms; an unreadable value arms NOW (a past slot is never invented). */
export function roleArmedAt(role: Pick<OfficeRole, 'armedAt'>, now: number): number {
  const t = role.armedAt ? Date.parse(role.armedAt) : NaN;
  return Number.isFinite(t) ? t : now;
}

/**
 * Every role's card line (docs/office.md § Role states) from the latest
 * facts: the office row, Pause all, today's spend (office and role), the live
 * shifts, and each role's newest shift — a guard skip with nothing run since
 * is `guarded (skip: …)`. Reads only; never settles the budget.
 */
export async function officeStates(storage: Storage, officeId: string, now = Date.now(), settings?: AppSettings): Promise<OfficeStates | null> {
  const office = await storage.getOffice(officeId);
  if (!office) return null;
  const tz = officeZone(office);
  const roles = await storage.listOfficeRoles(office.id);
  const serverPaused = (settings ?? (await storage.getSettings()))['orchestrator.paused'] === true;
  const sinceIso = iso(officeDayStart(now, tz));
  const officeSpent = await storage.officeSpendSince(office.id, sinceIso);
  const live = await storage.listShifts({ officeId: office.id, verdict: 'ran', open: true });
  // pending proposals per role (docs/office.md § Proposals) — what `waiting-for-you` counts so far
  const waiting = new Map<string, number>();
  for (const p of await storage.listOfficeProposals({ officeId: office.id, status: 'pending' })) {
    waiting.set(p.roleId, (waiting.get(p.roleId) ?? 0) + 1);
  }
  const states: OfficeRoleStateEntry[] = [];
  for (const role of roles) {
    const roleSpent = await storage.officeSpendSince(office.id, sinceIso, role.id);
    const onShift = live.find((s) => s.roleId === role.id) ?? null;
    const [latest] = await storage.listShifts({ roleId: role.id, limit: 1 });
    const lastGuardSkip = latest && latest.verdict === 'skipped' && latest.skipCode === 'guard' ? latest.skipReason : null;
    const status = roleState(role, {
      now,
      office: { ...office, timezone: tz },
      serverPaused,
      onShift: !!onShift,
      shiftLabel: onShift ? `on shift since ${formatOfficeTime(Date.parse(onShift.startedAt), now, tz)} (${onShift.trigger.kind})` : null,
      inHuddle: false,
      // pending proposals; a role's questions / approvals reach the human in a later phase
      waitingForYou: waiting.get(role.id) ?? 0,
      officeSpentTodayUsd: officeSpent,
      roleSpentTodayUsd: roleSpent,
      lastGuardSkip,
    });
    const next = nextRoleSlot(role, now, tz);
    states.push({ roleId: role.id, ...status, nextSlotAt: next === null ? null : iso(next), spentTodayUsd: roleSpent });
  }
  return { officeId: office.id, at: iso(now), spentTodayUsd: officeSpent, states };
}

export class OfficeScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<OfficeTickReport> | null = null;
  private stopped = false;
  /** coalescing key → when its last audit row was written (ms, the injected clock) */
  private coalesced = new Map<string, number>();
  /** rows suppressed per key since its last written row */
  private suppressed = new Map<string, number>();
  /** officeId → the states last broadcast (sans `at`) */
  private lastStates = new Map<string, string>();

  constructor(private deps: OfficeSchedulerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(line: string): void {
    (this.deps.log ?? console.log)(line);
  }

  private send(m: ServerEvent): void {
    (this.deps.broadcast ?? defaultBroadcast)(m);
  }

  /** Ticks every minute from now on (the first one right away: a catch-up after boot). */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const run = () => {
      this.tick().catch((e) => console.warn('office scheduler: tick failed:', (e as Error).message));
    };
    this.timer = setInterval(run, OFFICE_TICK_MS);
    this.timer.unref?.();
    run();
  }

  /** Shutdown: no new tick, nothing awaited (live shifts are aux runs, covered by stopAll). */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over every office; single-flight (a slow pass is joined, never doubled). */
  tick(): Promise<OfficeTickReport> {
    if (this.inFlight) return this.inFlight;
    const p = this.runTick(this.now()).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = p;
    return p;
  }

  private async runTick(now: number): Promise<OfficeTickReport> {
    const { storage } = this.deps;
    const report: OfficeTickReport = { woken: [], skipped: [], deferred: [] };
    this.pruneCoalesced(now);
    for (const office of await storage.listOffices()) {
      if (this.stopped) break;
      try {
        // vision.md / priorities.md hand edits, and a Director wake still owed (docs/office.md § Wishes and vision)
        await checkOfficeDocs({ storage, waker: this }, office).catch((e) =>
          console.warn(`office ${office.id}: doc check failed:`, (e as Error).message),
        );
        if (office.enabled) await this.wakeDue(office, now, report);
        await this.publishStates(office.id, now);
      } catch (e) {
        console.warn(`office ${office.id}: scheduler pass failed:`, (e as Error).message);
      }
    }
    return report;
  }

  private async wakeDue(office: Office, now: number, report: OfficeTickReport): Promise<void> {
    const { storage } = this.deps;
    const tz = officeZone(office);
    const due: { role: OfficeRole; wake: OfficeDueWake }[] = [];
    for (const role of await storage.listOfficeRoles(office.id)) {
      if (!role.enabled || !role.schedules.length) continue;
      const last = await lastCronSlot(storage, role.id);
      for (const wake of dueSlots(role, last, roleArmedAt(role, now), now, tz)) due.push({ role, wake });
    }
    // the longest-owed slot first, so a busy office cannot starve one role
    due.sort((a, b) => a.wake.at - b.wake.at);
    for (const d of due) {
      if (this.stopped) return;
      await this.judge(office.id, d.role, d.wake, now, report);
    }
  }

  private async judge(officeId: string, givenRole: OfficeRole, wake: OfficeDueWake, now: number, report: OfficeTickReport): Promise<void> {
    const { storage } = this.deps;
    // fresh rows: an earlier wake in this pass may have started a shift or tripped the budget
    const office = await storage.getOffice(officeId);
    const role = await storage.getOfficeRole(givenRole.id);
    if (!office || !office.enabled || !role || role.officeId !== officeId) return;
    const trigger: ShiftTriggerInput = { kind: 'cron', ref: wake.schedule, at: iso(wake.at) };
    const gate = await officeGate(storage, office, role, trigger, { now, countCommits: this.deps.countCommits });
    if (!gate.ok) {
      if (DEFER_CODES.has(gate.code)) return this.defer(office, role, wake, gate.code, gate.reason, now, report);
      return this.skip(office, role, wake, gate.code, gate.reason, gate.guard ?? null, now, report);
    }
    const res = await this.deps.shifts().start(office, role, trigger);
    if (!res.ok) {
      if (DEFER_CODES.has(res.code)) return this.defer(office, role, wake, res.code, res.reason, now, report);
      return this.skip(office, role, wake, res.code, res.reason, null, now, report);
    }
    res.done.catch(() => {});
    report.woken.push({ officeId, roleId: role.id, shiftId: res.shiftId, at: trigger.at!, missed: wake.missed });
    if (wake.missed > 1) {
      this.log(`office ${officeId}: ${role.key} woke once for ${wake.missed} missed slot(s) of \`${wake.schedule}\` since ${iso(wake.firstMissedAt)}`);
    }
  }

  private async skip(
    office: Office,
    role: OfficeRole,
    wake: OfficeDueWake,
    code: string,
    reason: string,
    guard: string | null,
    now: number,
    report: OfficeTickReport,
  ): Promise<void> {
    const at = iso(now);
    const shift = await this.deps.storage.appendShift({
      officeId: office.id,
      roleId: role.id,
      trigger: { kind: 'cron', ref: wake.schedule, at: iso(wake.at) },
      verdict: 'skipped',
      skipReason: reason,
      skipCode: code,
      startedAt: at,
      endedAt: at,
    });
    report.skipped.push({ officeId: office.id, roleId: role.id, shiftId: shift.id, code, reason });
    await this.coalescedEvent('office.shift-skipped', office, role, code, guard, reason, now, {
      shiftId: shift.id,
      schedule: wake.schedule,
      slot: iso(wake.at),
      missed: wake.missed,
    });
  }

  private async defer(
    office: Office,
    role: OfficeRole,
    wake: OfficeDueWake,
    code: string,
    reason: string,
    now: number,
    report: OfficeTickReport,
  ): Promise<void> {
    report.deferred.push({ officeId: office.id, roleId: role.id, code, reason });
    await this.coalescedEvent('office.shift-deferred', office, role, code, null, reason, now, {
      schedule: wake.schedule,
      slot: iso(wake.at),
    });
  }

  /**
   * One audit row per role per reason CLASS (the code, plus the guard's kind)
   * per hour. The class, not the text: a cooldown's "last shift 20 min ago"
   * reads differently every minute and would defeat a text key. Remembered in
   * memory, and on a miss (a fresh process) looked up in the last hour of
   * rows, so a restart does not write a second one. The next written row
   * carries how many were folded into the previous one (`suppressed`).
   */
  async coalescedEvent(
    kind: 'office.shift-skipped' | 'office.shift-deferred',
    office: Office,
    role: OfficeRole,
    code: string,
    guard: string | null,
    reason: string,
    now: number,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const { storage } = this.deps;
    const cls = guard ? `${code}:${guard}` : code;
    const key = `${kind}\u0000${role.id}\u0000${cls}`;
    let last = this.coalesced.get(key);
    if (last === undefined) {
      const rows = await storage.listEvents({ kind, since: iso(now - OFFICE_SKIP_COALESCE_MS), limit: 500 });
      const hit = rows.find((e) => {
        const d = (e.data ?? {}) as { roleId?: unknown; reasonClass?: unknown };
        return d.roleId === role.id && d.reasonClass === cls;
      });
      if (hit) {
        const t = Date.parse(hit.at);
        last = Number.isFinite(t) && t <= now ? t : now;
        this.coalesced.set(key, last);
      }
    }
    if (last !== undefined && now - last < OFFICE_SKIP_COALESCE_MS) {
      this.suppressed.set(key, (this.suppressed.get(key) ?? 0) + 1);
      return;
    }
    const suppressed = this.suppressed.get(key) ?? 0;
    this.suppressed.delete(key);
    this.coalesced.set(key, now);
    await storage.appendEvent({
      kind,
      actor: 'system',
      data: {
        officeId: office.id,
        workspaceId: office.workspaceId,
        roleId: role.id,
        roleKey: role.key,
        code,
        ...(guard ? { guard } : {}),
        reasonClass: cls,
        reason,
        ...extra,
        ...(suppressed ? { suppressed } : {}),
      },
    });
  }

  private pruneCoalesced(now: number): void {
    for (const [k, t] of this.coalesced) {
      if (now - t >= OFFICE_SKIP_COALESCE_MS && !this.suppressed.has(k)) this.coalesced.delete(k);
    }
  }

  /** The office's role states, broadcast in `office.updated` when they changed since the last broadcast. */
  async publishStates(officeId: string, now = this.now(), force = false): Promise<OfficeStates | null> {
    const states = await officeStates(this.deps.storage, officeId, now);
    if (!states) {
      this.lastStates.delete(officeId);
      return null;
    }
    const key = JSON.stringify([states.spentTodayUsd, states.states]);
    if (force || this.lastStates.get(officeId) !== key) {
      const office = await this.deps.storage.getOffice(officeId);
      if (office) {
        this.lastStates.set(officeId, key);
        this.send({ type: 'office.updated', office, states });
      }
    }
    return states;
  }

  /**
   * Wake now (`POST /api/offices/:id/roles/:roleId/wake`): a stakeholder
   * request. It still passes the HARD gate (office on and not paused, Pause
   * all, budget, role cap, slots) but no guard — cooldown included — and the
   * note goes to the shift as trusted text. A refusal is the caller's answer
   * (409 with the reason); no shift row is written for it.
   */
  async wake(
    officeId: string,
    roleId: string,
    note: string | null,
    actor = 'human',
    opts: { ref?: string; data?: Record<string, unknown> } = {},
  ): Promise<OfficeWakeResult> {
    const { storage } = this.deps;
    const office = await storage.getOffice(officeId);
    if (!office) return { ok: false, status: 404, error: 'office not found' };
    const role = await storage.getOfficeRole(roleId);
    if (!role || role.officeId !== office.id) return { ok: false, status: 404, error: 'role not found in this office' };
    const now = this.now();
    const text = note?.trim() ? note.trim().slice(0, OFFICE_WAKE_NOTE_MAX) : null;
    // `ref`: who asked (Wake now), or what did — `wish:<id>` / `re-plan:<doc>` (docs.ts)
    const trigger: ShiftTriggerInput = { kind: 'request', ref: opts.ref ?? actor, at: iso(now), note: text };
    const gate = await officeGate(storage, office, role, trigger, { now });
    if (!gate.ok) return { ok: false, status: 409, error: gate.reason, code: gate.code };
    const res = await this.deps.shifts().start(office, role, trigger);
    if (!res.ok) return { ok: false, status: 409, error: res.reason, code: res.code };
    res.done.catch(() => {});
    await storage.appendEvent({
      kind: 'office.wake',
      actor,
      data: {
        officeId: office.id,
        workspaceId: office.workspaceId,
        roleId: role.id,
        roleKey: role.key,
        shiftId: res.shiftId,
        note: text,
        ...(opts.ref ? { ref: opts.ref } : {}),
        ...(opts.data ?? {}),
      },
    });
    await this.publishStates(office.id, now).catch(() => null);
    return { ok: true, shiftId: res.shiftId };
  }
}

let instance: OfficeScheduler | null = null;

/** Boot wiring (index.ts). */
export function initOfficeScheduler(s: OfficeScheduler): void {
  instance = s;
}

/** The process-wide scheduler, or null before boot wiring (route tests). */
export function officeScheduler(): OfficeScheduler | null {
  return instance;
}
