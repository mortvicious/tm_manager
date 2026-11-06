// Event triggers (docs/office.md § Event triggers): an office role subscribed
// to a server event (`{kind:'event', event}` in `OfficeRole.triggers`) is woken
// when this server records it — a task landed, a bug filed, a deploy done, an
// office message, … — never by polling: the service listens IN-PROCESS on the
// event bus (`onEvent`) for the audit rows the storage drivers already
// broadcast (`event.appended`: `task.transition`, `task.created`,
// `run.reviewed`, `task.checked`) and the live broadcasts (`command.run`,
// `job-run.updated`, `office-message.created`).
//
// - **Routing**: an event about a repo goes to every ENABLED office whose
//   workspace contains the repo, and in it to every enabled role with a
//   matching trigger (`roleWantsEvent`; a `repoId`-scoped trigger matches only
//   its repo). An office message goes to its own office: the addressee, or —
//   for the channel — every subscribed role but the writer.
// - **Debounce**: per role, ≥ `OFFICE_EVENT_DEBOUNCE_MS` (2 min). The first
//   event opens a bucket due 2 min later (and never sooner than 2 min after
//   the role's last event wake); everything until then joins it, so a burst is
//   ONE wake carrying every ref (≤ `OFFICE_EVENT_REFS_MAX`, the rest counted).
// - **Gate**: the wake goes through `officeGate` WITH the guards, like cron. A
//   refusal is a `skipped` shift row + the scheduler's coalesced
//   `office.shift-skipped` audit row; a busy slot (`slots`, `office-busy`,
//   `busy`, `paused`) defers the bucket a minute (it keeps collecting), up to
//   an hour, then it is skipped.
// - **Payloads** are server facts (`OfficeEventRef`): ids, statuses, human-set
//   names, and the title only of a task whose text is neither tainted nor
//   outside input (`officeEventTitle`). A message's body is never carried.
//
// Buckets live in memory: a restart drops a pending wake (the events stay in
// the audit log, and the `tasks-landed-since` guard of a cron shift still
// sees them).
import {
  OFFICE_EVENT_DEBOUNCE_MS,
  OFFICE_EVENT_REFS_MAX,
  TERMINAL_TASK_STATUSES,
  isDeployCommandName,
  officeEventRefId,
  officeEventTitle,
  officeEventTriggerRef,
  roleWantsEvent,
  type AuditEvent,
  type CommandRun,
  type JobRun,
  type Office,
  type OfficeEventName,
  type OfficeEventRef,
  type OfficeMessage,
  type OfficeRole,
  type ServerEvent,
  type Task,
} from '@tm/shared';
import { onEvent } from '../events.ts';
import type { Storage } from '../storage/types.ts';
import { isBugTask, officeGate, type CommitCounter } from './gate.ts';
import type { ShiftStarter } from './scheduler.ts';
import type { ShiftTriggerInput } from './shift.ts';

/** A deferred bucket is retried this often … */
export const OFFICE_EVENT_RETRY_MS = 60_000;
/** … for at most this long, then skipped. */
export const OFFICE_EVENT_DEFER_MAX_MS = 60 * 60_000;
/** A broadcast seen twice (a run's status re-sent) is one event: ids are remembered this long. */
const SEEN_TTL_MS = 6 * 60 * 60_000;

const DEFER_CODES = new Set<string>(['slots', 'office-busy', 'busy', 'paused', 'memory']);
const LANDED = new Set<string>(['done', 'published']);

/** The scheduler's coalesced skip row (`OfficeScheduler.coalescedEvent`). */
export type CoalescedAudit = (
  kind: 'office.shift-skipped' | 'office.shift-deferred',
  office: Office,
  role: OfficeRole,
  code: string,
  guard: string | null,
  reason: string,
  now: number,
  extra: Record<string, unknown>,
) => Promise<void>;

export interface OfficeEventTriggersDeps {
  storage: Storage;
  shifts: () => ShiftStarter;
  /** the scheduler's coalescing audit writer (one row per role per reason class per hour) */
  audit?: CoalescedAudit;
  now?: () => number;
  countCommits?: CommitCounter;
  /** tests: no timers, `flush()` is called by hand */
  manual?: boolean;
  log?: (line: string) => void;
}

interface Bucket {
  officeId: string;
  roleId: string;
  refs: OfficeEventRef[];
  keys: Set<string>;
  dropped: number;
  firstAt: number;
  dueAt: number;
  deferredSince: number | null;
}

export interface OfficeEventFlushReport {
  woken: { officeId: string; roleId: string; shiftId: string; refs: number }[];
  skipped: { officeId: string; roleId: string; code: string; reason: string }[];
  deferred: { officeId: string; roleId: string; code: string }[];
}

const iso = (ms: number) => new Date(ms).toISOString();

export class OfficeEventTriggers {
  private buckets = new Map<string, Bucket>();
  /** roleId → its last event wake (ms) */
  private lastWake = new Map<string, number>();
  /** `event:id` → when seen; a re-broadcast is not a second event */
  private seen = new Map<string, number>();
  private off: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = Infinity;
  private flushing: Promise<OfficeEventFlushReport> | null = null;
  private pending = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(private deps: OfficeEventTriggersDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  start(): void {
    if (this.off) return;
    this.stopped = false;
    this.off = onEvent((e) => this.handle(e));
    this.track(this.primeBugs());
  }

  stop(): void {
    this.stopped = true;
    this.off?.();
    this.off = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = Infinity;
  }

  /** Feed one bus event (what the `onEvent` listener does). Never throws. */
  handle(e: ServerEvent): void {
    this.track(this.ingest(e));
  }

  private track(work: Promise<unknown>): void {
    const p = work.catch((err) => console.warn('office event triggers:', (err as Error).message));
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  /** Tests: wait until every event handed in so far is routed. */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  /** What is waiting, per role (tests, diagnostics). */
  queued(): { officeId: string; roleId: string; refs: OfficeEventRef[]; dropped: number; dueAt: string }[] {
    return [...this.buckets.values()].map((b) => ({ officeId: b.officeId, roleId: b.roleId, refs: [...b.refs], dropped: b.dropped, dueAt: iso(b.dueAt) }));
  }

  // ---- reading events ----

  private async ingest(e: ServerEvent): Promise<void> {
    if (this.stopped) return;
    switch (e.type) {
      case 'event.appended':
        return this.fromAudit(e.event);
      case 'command.run':
        return this.fromCommandRun(e.run);
      case 'job-run.updated':
        return this.fromJobRun(e.run);
      case 'office-message.created':
        return this.fromMessage(e.message);
      default:
        return;
    }
  }

  /**
   * Whether each open task reads as a bug (`isBugTask`), so a later category
   * edit fires `bug-filed` only when it TURNS the task into a bug. Primed from
   * the open tasks at start (after a restart a task already a bug never
   * re-fires), then kept by the created/edited handlers; a task not in the
   * map (terminal at start) never fires.
   */
  private isBug = new Map<string, boolean>();

  private async primeBugs(): Promise<void> {
    for (const t of await this.deps.storage.listTasks({})) {
      if (!TERMINAL_TASK_STATUSES.includes(t.status) && !this.isBug.has(t.id)) this.isBug.set(t.id, isBugTask(t));
    }
  }

  private async fromAudit(ev: AuditEvent): Promise<void> {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    if (!ev.taskId) return;
    const want: OfficeEventName[] = [];
    if (ev.kind === 'task.transition') {
      const from = typeof d.from === 'string' ? d.from : null;
      const to = typeof d.to === 'string' ? d.to : null;
      if (!to) return;
      // done → published is the same landing, but it IS the deploy
      if (LANDED.has(to) && !(from && LANDED.has(from))) want.push('task-landed');
      if (to === 'published' && from !== 'published') want.push('deploy-done');
      if (to === 'failed' && from !== 'failed') want.push('task-failed');
    } else if (ev.kind === 'task.created' || ev.kind === 'task.edited') {
      // a category edit (analysis, the agent category route, a human edit) can make a task a bug
      if (ev.kind === 'task.edited' && !(Array.isArray(d.fields) && d.fields.includes('category'))) return;
      const task = await this.deps.storage.getTask(ev.taskId);
      if (!task) return;
      const was = this.isBug.get(task.id);
      const now = isBugTask(task);
      if (was !== true) this.isBug.set(task.id, now);
      // created as a bug, or an open task that was not one and now is — once per task
      if (now && (ev.kind === 'task.created' ? was !== true : was === false)) {
        await this.route(this.taskRef('bug-filed', ev.at, ev.repoId ?? task.repoId, task.id, task), task, `bug-filed:${task.id}`);
      }
      return;
    } else if (ev.kind === 'run.reviewed') {
      if (d.state === 'flagged') want.push('review-flagged');
    } else if (ev.kind === 'task.checked') {
      // a SETTLED red: the fix loop stopped (a red with a fix turn coming is not news)
      if (d.state === 'red' && typeof d.stop === 'string') want.push('checks-red');
    }
    if (!want.length) return;
    const task = await this.deps.storage.getTask(ev.taskId);
    const repoId = ev.repoId ?? task?.repoId ?? null;
    for (const event of want) {
      // keyed by the audit row: the same task landing again later is a new event
      await this.route(this.taskRef(event, ev.at, repoId, ev.taskId, task), task, `${event}:${ev.id}`);
    }
  }

  private taskRef(event: OfficeEventName, at: string, repoId: string | null, taskId: string, task: Task | null): OfficeEventRef {
    return {
      event,
      at,
      repoId,
      taskId,
      title: task ? officeEventTitle(task) : null,
      ...(task ? { status: task.status } : {}),
      ...(task?.taintedAt ? { tainted: true } : {}),
    };
  }

  private async fromCommandRun(run: CommandRun): Promise<void> {
    if (run.status !== 'exited' || run.exitCode !== 0) return;
    // a human-SAVED command only: no check, baseline, office run or one-shot
    if (!run.commandId || !run.repoId || run.checkTaskId || run.checkBaseline || run.officeShiftId || run.oneShot) return;
    if (!isDeployCommandName(run.name)) return;
    const cmd = await this.deps.storage.getCommand(run.commandId);
    if (!cmd || cmd.ownerTaskId !== null || !isDeployCommandName(cmd.name)) return;
    await this.route({ event: 'deploy-done', at: run.endedAt ?? iso(this.now()), repoId: run.repoId, commandRunId: run.id, commandName: cmd.name, status: 'exited 0' }, null);
  }

  private async fromJobRun(run: JobRun): Promise<void> {
    if (run.verdict !== 'attention' || !run.endedAt) return;
    const job = await this.deps.storage.getJob(run.jobId);
    if (!job) return;
    await this.route({ event: 'job-attention', at: run.endedAt, repoId: job.repoId, jobId: job.id, jobRunId: run.id, status: 'attention' }, null);
  }

  private async fromMessage(m: OfficeMessage): Promise<void> {
    // an unrouted message waits for the Director (docs/office.md § Channel): only
    // a DELIVERED one — a forward's copy, a Director's own message — reaches a role
    if (!m.routedAt) return;
    // a huddle's transcript line is the huddle's, not a message to anyone (docs/office.md § Huddles)
    if (m.subject?.kind === 'huddle' && m.toRoleId === null) return;
    const { storage } = this.deps;
    const from = m.fromRoleId ? await storage.getOfficeRole(m.fromRoleId) : null;
    const ref: OfficeEventRef = {
      event: 'office-message',
      at: m.createdAt,
      repoId: null,
      messageId: m.id,
      messageKind: m.kind,
      fromRoleKey: from?.key ?? null,
      ...(m.taintedAt ? { tainted: true } : {}),
    };
    if (!this.firstSighting(`office-message:${m.id}`)) return;
    const office = await storage.getOffice(m.officeId);
    if (!office?.enabled) return;
    for (const role of await storage.listOfficeRoles(office.id)) {
      if (!role.enabled || role.id === m.fromRoleId) continue;
      if (m.toRoleId && role.id !== m.toRoleId) continue;
      if (roleWantsEvent(role, 'office-message', null)) this.enqueue(office, role, ref);
    }
  }

  /** `true` the first time this key is seen (a re-broadcast of the same run is not a second event). */
  private firstSighting(key: string): boolean {
    const now = this.now();
    for (const [k, t] of this.seen) if (now - t > SEEN_TTL_MS) this.seen.delete(k);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    return true;
  }

  /** Every enabled office whose workspace holds the repo; every subscribed role in it. */
  private async route(ref: OfficeEventRef, task: Task | null, seenKey = `${ref.event}:${officeEventRefId(ref)}`): Promise<void> {
    if (!ref.repoId || !this.firstSighting(seenKey)) return;
    const { storage } = this.deps;
    for (const office of await storage.listOffices()) {
      if (!office.enabled) continue;
      const ws = await storage.getWorkspace(office.workspaceId);
      if (!ws || !ws.repoIds.includes(ref.repoId)) continue;
      for (const role of await storage.listOfficeRoles(office.id)) {
        if (!role.enabled || !roleWantsEvent(role, ref.event, ref.repoId)) continue;
        // a role is not woken by the bug it filed itself
        if (ref.event === 'bug-filed' && task?.roleId === role.id) continue;
        this.enqueue(office, role, ref);
      }
    }
  }

  // ---- debounce ----

  private enqueue(office: Office, role: OfficeRole, ref: OfficeEventRef): void {
    if (this.stopped) return;
    const now = this.now();
    let b = this.buckets.get(role.id);
    if (!b) {
      const last = this.lastWake.get(role.id);
      b = {
        officeId: office.id,
        roleId: role.id,
        refs: [],
        keys: new Set(),
        dropped: 0,
        firstAt: now,
        dueAt: Math.max(now + OFFICE_EVENT_DEBOUNCE_MS, last !== undefined ? last + OFFICE_EVENT_DEBOUNCE_MS : 0),
        deferredSince: null,
      };
      this.buckets.set(role.id, b);
    }
    const key = `${ref.event}:${officeEventRefId(ref)}`;
    if (b.keys.has(key)) return;
    b.keys.add(key);
    if (b.refs.length < OFFICE_EVENT_REFS_MAX) b.refs.push(ref);
    else b.dropped += 1;
    this.arm();
  }

  private arm(): void {
    if (this.deps.manual || this.stopped) return;
    let next = Infinity;
    for (const b of this.buckets.values()) next = Math.min(next, b.dueAt);
    if (next === Infinity || next >= this.timerAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = next;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerAt = Infinity;
      this.flush()
        .catch((e) => console.warn('office event triggers: flush failed:', (e as Error).message))
        .finally(() => this.arm());
    }, Math.max(0, next - this.now()));
    this.timer.unref?.();
  }

  /** Wake every role whose bucket is due. Single-flight. */
  flush(): Promise<OfficeEventFlushReport> {
    if (this.flushing) return this.flushing;
    const p = this.runFlush().finally(() => {
      this.flushing = null;
    });
    this.flushing = p;
    return p;
  }

  private async runFlush(): Promise<OfficeEventFlushReport> {
    const report: OfficeEventFlushReport = { woken: [], skipped: [], deferred: [] };
    const now = this.now();
    const due = [...this.buckets.values()].filter((b) => b.dueAt <= now).sort((a, b) => a.firstAt - b.firstAt);
    for (const b of due) {
      if (this.stopped) break;
      try {
        await this.wake(b, now, report);
      } catch (e) {
        this.buckets.delete(b.roleId);
        console.warn(`office event wake for role ${b.roleId} failed:`, (e as Error).message);
      }
    }
    return report;
  }

  private async wake(b: Bucket, now: number, report: OfficeEventFlushReport): Promise<void> {
    const { storage } = this.deps;
    const office = await storage.getOffice(b.officeId);
    const role = await storage.getOfficeRole(b.roleId);
    // the role or its subscription may have gone since: the refs it no longer wants are dropped
    const refs = role ? b.refs.filter((r) => roleWantsEvent(role, r.event, r.repoId)) : [];
    if (!office || !office.enabled || !role || !role.enabled || role.officeId !== office.id || !refs.length) {
      this.buckets.delete(b.roleId);
      return;
    }
    const trigger: ShiftTriggerInput = {
      kind: 'event',
      ref: officeEventTriggerRef(refs, b.dropped),
      at: refs[0].at,
      events: refs,
      eventsDropped: b.dropped,
    };
    const gate = await officeGate(storage, office, role, trigger, { now, countCommits: this.deps.countCommits });
    if (!gate.ok) return this.refused(b, office, role, trigger, gate.code, gate.reason, gate.guard ?? null, now, report);
    const res = await this.deps.shifts().start(office, role, trigger);
    if (!res.ok) return this.refused(b, office, role, trigger, res.code, res.reason, null, now, report);
    res.done.catch(() => {});
    this.buckets.delete(b.roleId);
    this.lastWake.set(role.id, now);
    report.woken.push({ officeId: office.id, roleId: role.id, shiftId: res.shiftId, refs: refs.length + b.dropped });
    (this.deps.log ?? console.log)(`office ${office.id}: ${role.key} woke on ${refs.length + b.dropped} event(s): ${trigger.ref}`);
  }

  private async refused(
    b: Bucket,
    office: Office,
    role: OfficeRole,
    trigger: ShiftTriggerInput,
    code: string,
    reason: string,
    guard: string | null,
    now: number,
    report: OfficeEventFlushReport,
  ): Promise<void> {
    const extra = { trigger: 'event', ref: trigger.ref, events: (trigger.events?.length ?? 0) + (trigger.eventsDropped ?? 0) };
    if (DEFER_CODES.has(code)) {
      b.deferredSince ??= now;
      if (now - b.deferredSince < OFFICE_EVENT_DEFER_MAX_MS) {
        b.dueAt = now + OFFICE_EVENT_RETRY_MS;
        report.deferred.push({ officeId: office.id, roleId: role.id, code });
        await this.audit('office.shift-deferred', office, role, code, null, reason, now, extra);
        return;
      }
      reason = `still refused after ${Math.round(OFFICE_EVENT_DEFER_MAX_MS / 60_000)} min: ${reason}`;
    }
    this.buckets.delete(b.roleId);
    const at = iso(now);
    const shift = await this.deps.storage.appendShift({
      officeId: office.id,
      roleId: role.id,
      trigger: { kind: 'event', ref: trigger.ref ?? null, at: trigger.at ?? at },
      verdict: 'skipped',
      skipReason: reason,
      skipCode: code,
      startedAt: at,
      endedAt: at,
    });
    report.skipped.push({ officeId: office.id, roleId: role.id, code, reason });
    await this.audit('office.shift-skipped', office, role, code, guard, reason, now, { ...extra, shiftId: shift.id });
  }

  private async audit(...args: Parameters<CoalescedAudit>): Promise<void> {
    if (this.deps.audit) return this.deps.audit(...args);
    const [kind, office, role, code, guard, reason, , extra] = args;
    await this.deps.storage.appendEvent({
      kind,
      actor: 'system',
      data: { officeId: office.id, workspaceId: office.workspaceId, roleId: role.id, roleKey: role.key, code, ...(guard ? { guard } : {}), reason, ...extra },
    });
  }
}

let instance: OfficeEventTriggers | null = null;

/** Boot wiring (index.ts). */
export function initOfficeEventTriggers(t: OfficeEventTriggers): void {
  instance = t;
}

/** The process-wide event triggers, or null before boot wiring. */
export function officeEventTriggers(): OfficeEventTriggers | null {
  return instance;
}
