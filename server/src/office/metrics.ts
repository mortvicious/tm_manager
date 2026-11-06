// Product metrics (docs/office.md § Product metrics, phase 6): a number an
// office watches over time — a conversion rate, a p95, a bundle size — read
// from a HUMAN-saved one-shot repo command that prints `TM_METRIC=<n>`.
//
// - **Definition**: `tm_office_metrics` (migration 65), written only through
//   the Origin-gated routes (`routes/office-metrics.ts`) after
//   `checkMetricInput`: the command passes the same rule as a role's command
//   allowlist (`allowlistCheck`: saved, non-check, non-archived, human-owned,
//   one-shot, a repo of the office's workspace), the cron parses, and
//   threshold op and value come together.
// - **Runs**: the scheduler's minute tick calls `onTick` per office; every
//   due metric (`metricDue`: the first cron slot after its last run — one run
//   however many slots a sleep missed) is run DETACHED, one at a time per
//   office, behind `officeCommandGate`, through `CommandRunner.runCheck` (the
//   commands pool, argv only, CI=1, 10 min) — zero tokens, never a claude.
//   The LAST `TM_METRIC=<n>` in the output is the value (`lastTmMetric`, the
//   loop tasks' convention); none, a timeout or a spawn failure is
//   `last_error`, and the anchor moves either way, so a broken command is
//   tried once per slot, not every minute.
// - **Crossing**: `recordOfficeMetricRun` writes the point and the side in one
//   transaction; ok / unmeasured → breach is a conditional UPDATE, so exactly
//   ONE run per crossing gets `crossed`. That run files ONE `tm_office_signals`
//   row, source `metric`, with server-built text (`metricSignalText` — the
//   metric's own definition and the number, never the command's output), and
//   hands it to the signal service, which wakes the metric's role if it
//   subscribes to `signal: metric`. Such a wake is untainted
//   (`officeSignalRefTrusted`). Staying in breach files nothing; a value back
//   on the ok side re-arms it.
import { z } from 'zod';
import {
  OFFICE_COMMAND_TAIL_CHARS,
  OFFICE_COMMAND_TAIL_LINES,
  OFFICE_COMMAND_TIMEOUT_MS,
  OFFICE_METRICS_MAX,
  OFFICE_METRIC_BETTER,
  OFFICE_METRIC_NAME_MAX,
  OFFICE_METRIC_POINTS_SHOWN,
  OFFICE_METRIC_THRESHOLD_OPS,
  OFFICE_METRIC_UNIT_MAX,
  cronError,
  lastTmMetric,
  metricDue,
  metricSignalText,
  type Office,
  type OfficeMetric,
  type OfficeMetricWithPoints,
  type OfficeSignal,
  type ServerEvent,
} from '@tm/shared';
import type { CommandRunner } from '../commands/runner.ts';
import { broadcast as defaultBroadcast } from '../events.ts';
import type { NewOfficeMetric, OfficeMetricPatch } from '../storage/metric-sql.ts';
import type { Storage } from '../storage/types.ts';
import { officeZone } from './budget.ts';
import { allowlistCheck } from './commands.ts';
import { officeCommandGate } from './gate.ts';
import type { OfficeSignals } from './signals.ts';

// ---------------------------------------------------------------------------
// Validation (the routes and the run-time re-check)
// ---------------------------------------------------------------------------

const finite = z.number().refine(Number.isFinite, 'must be a finite number');

export const metricBodySchema = z
  .object({
    roleId: z.string().trim().min(1).max(100),
    commandId: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(OFFICE_METRIC_NAME_MAX),
    unit: z.string().trim().max(OFFICE_METRIC_UNIT_MAX).optional(),
    better: z.enum(OFFICE_METRIC_BETTER as [string, ...string[]]).optional(),
    schedule: z.string().trim().min(1).max(200),
    thresholdOp: z.enum(OFFICE_METRIC_THRESHOLD_OPS as [string, ...string[]]).nullable().optional(),
    thresholdValue: finite.nullable().optional(),
  })
  .strict();

export const metricPatchSchema = metricBodySchema.partial().strict();

export type MetricCheck = { ok: true; value: NewOfficeMetric } | { ok: false; error: string };

const zodError = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');

/**
 * Validate a create body (`existing` null) or an edit merged over the stored
 * definition (`existing` set) — the WHOLE result is checked either way, so an
 * edit cannot keep a command that has since become a check or been archived.
 */
export async function checkMetricInput(storage: Storage, office: Office, raw: unknown, existing: OfficeMetric | null): Promise<MetricCheck> {
  const parsed = (existing ? metricPatchSchema : metricBodySchema).safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: `metric: ${zodError(parsed.error)}` };
  const b = parsed.data;
  const merged = {
    roleId: b.roleId ?? existing?.roleId ?? '',
    commandId: b.commandId ?? existing?.commandId ?? '',
    name: b.name ?? existing?.name ?? '',
    unit: b.unit ?? existing?.unit ?? '',
    better: (b.better ?? existing?.better ?? 'up') as NewOfficeMetric['better'],
    schedule: b.schedule ?? existing?.schedule ?? '',
    thresholdOp: (b.thresholdOp !== undefined ? b.thresholdOp : (existing?.thresholdOp ?? null)) as NewOfficeMetric['thresholdOp'],
    thresholdValue: b.thresholdValue !== undefined ? b.thresholdValue : (existing?.thresholdValue ?? null),
  };
  // an edit naming only one half of the threshold must still come out whole
  if ((merged.thresholdOp === null) !== (merged.thresholdValue === null)) {
    return { ok: false, error: 'metric: thresholdOp and thresholdValue come together (both set, or both null)' };
  }
  const cron = cronError(merged.schedule);
  if (cron) return { ok: false, error: `metric: schedule: ${cron}` };
  const role = await storage.getOfficeRole(merged.roleId);
  if (!role || role.officeId !== office.id) return { ok: false, error: 'metric: roleId is not a role of this office' };
  const cmd = await allowlistCheck(storage, office, merged.commandId);
  if ('error' in cmd) return { ok: false, error: `metric: ${cmd.error}` };
  return { ok: true, value: { officeId: office.id, ...merged, repoId: cmd.repo.id } };
}

/** The patch an edit writes: only the fields that differ from the stored row. */
export function metricPatch(next: NewOfficeMetric, prev: OfficeMetric): OfficeMetricPatch {
  const out: OfficeMetricPatch = {};
  for (const k of ['roleId', 'repoId', 'commandId', 'name', 'unit', 'better', 'schedule', 'thresholdOp', 'thresholdValue'] as const) {
    if (next[k] !== prev[k]) (out as Record<string, unknown>)[k] = next[k];
  }
  return out;
}

/** Create a metric (the office's cap applies); the routes' write. */
export async function createMetric(storage: Storage, office: Office, raw: unknown): Promise<{ ok: true; metric: OfficeMetric } | { ok: false; code: 400 | 409; error: string }> {
  const checked = await checkMetricInput(storage, office, raw, null);
  if (!checked.ok) return { ok: false, code: 400, error: checked.error };
  if ((await storage.listOfficeMetrics({ officeId: office.id })).length >= OFFICE_METRICS_MAX) {
    return { ok: false, code: 409, error: `an office measures at most ${OFFICE_METRICS_MAX} metrics` };
  }
  return { ok: true, metric: await storage.createOfficeMetric(checked.value) };
}

/** A metric with its newest points (oldest first) — what the API and the broadcast carry. */
export async function withPoints(storage: Storage, m: OfficeMetric): Promise<OfficeMetricWithPoints> {
  return { ...m, points: await storage.listOfficeMetricPoints(m.id, OFFICE_METRIC_POINTS_SHOWN) };
}

/** A metric signal's unique key: one row per (metric, breach start). */
export const metricSignalExternalId = (metricId: string, breachedAt: string) => `${metricId}@${breachedAt}`;

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export interface OfficeMetricsDeps {
  storage: Storage;
  /** the COMMANDS pool's runner; null = metrics cannot run (each run records the error) */
  runner: () => Pick<CommandRunner, 'runCheck'> | null;
  /** the signal service that wakes the metric's role on a crossing */
  signals?: () => Pick<OfficeSignals, 'metricSignals'> | null;
  now?: () => number;
  broadcast?: (m: ServerEvent) => void;
  log?: (line: string) => void;
}

export type MetricRunOutcome =
  | { ran: true; metric: OfficeMetric; value: number | null; error: string | null; crossed: boolean; signal: OfficeSignal | null }
  | { ran: false; reason: string; code: string };

export class OfficeMetrics {
  /** one metric run per office at a time: each office's runs are one promise chain */
  private chains = new Map<string, Promise<unknown>>();
  /** metric ids queued or running (a due metric is never queued twice) */
  private queued = new Set<string>();
  private stopping = false;

  constructor(private deps: OfficeMetricsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private send(m: ServerEvent): void {
    (this.deps.broadcast ?? defaultBroadcast)(m);
  }

  stop(): void {
    this.stopping = true;
  }

  /** Tests: wait for every queued run. */
  async settled(): Promise<void> {
    while (this.chains.size) await Promise.allSettled([...this.chains.values()]);
  }

  /**
   * The scheduler's per-office step (every minute): queue each due metric of
   * an ENABLED office. Never awaits a run — a 10-minute command must not hold
   * the tick. A refusal by the gate leaves the slot owed (retried next tick).
   */
  async onTick(office: Office, now = this.now()): Promise<string[]> {
    if (this.stopping || !office.enabled) return [];
    const tz = officeZone(office);
    const due = (await this.deps.storage.listOfficeMetrics({ officeId: office.id })).filter((m) => !this.queued.has(m.id) && metricDue(m, now, tz));
    for (const m of due) void this.enqueue(office.id, m.id, true);
    return due.map((m) => m.id);
  }

  /**
   * A human's Run now (the route): the same run, out of schedule and without
   * the office gate (a human click, zero tokens) — a crossing it finds still
   * wakes the role only through the gate.
   */
  runNow(officeId: string, metricId: string): Promise<MetricRunOutcome> {
    if (this.queued.has(metricId)) return Promise.resolve({ ran: false, reason: 'this metric is already running', code: 'busy' });
    return this.enqueue(officeId, metricId, false);
  }

  private enqueue(officeId: string, metricId: string, gated: boolean): Promise<MetricRunOutcome> {
    this.queued.add(metricId);
    const prev = this.chains.get(officeId) ?? Promise.resolve();
    const next = prev
      .then(() => this.runOne(metricId, gated))
      .catch((e): MetricRunOutcome => {
        console.warn(`office metric ${metricId}:`, (e as Error).message);
        return { ran: false, reason: (e as Error).message, code: 'error' };
      })
      .finally(() => this.queued.delete(metricId));
    this.chains.set(officeId, next);
    void next.finally(() => {
      if (this.chains.get(officeId) === next) this.chains.delete(officeId);
    });
    return next;
  }

  /** One run: re-read, gate, measure, record, and on a crossing the ONE signal. */
  private async runOne(metricId: string, gated: boolean): Promise<MetricRunOutcome> {
    const { storage } = this.deps;
    if (this.stopping) return { ran: false, reason: 'server shutting down', code: 'stopping' };
    const metric = await storage.getOfficeMetric(metricId);
    if (!metric) return { ran: false, reason: 'the metric no longer exists', code: 'gone' };
    const office = await storage.getOffice(metric.officeId);
    const role = await storage.getOfficeRole(metric.roleId);
    if (!office || !role || role.officeId !== office.id) return { ran: false, reason: 'the office or role no longer exists', code: 'gone' };
    if (gated) {
      if (!office.enabled) return { ran: false, reason: 'the office is off', code: 'disabled' };
      const refusal = await officeCommandGate(storage, office, role, { now: this.now() });
      if (refusal) return { ran: false, reason: refusal.reason, code: refusal.code };
    }

    const startedAt = new Date(this.now()).toISOString();
    // the definition as it stands NOW: a command may have become a check or been archived since
    const check = await allowlistCheck(storage, office, metric.commandId);
    let value: number | null = null;
    let error: string | null = null;
    let runId: string | null = null;
    if ('error' in check) error = check.error;
    else {
      const runner = this.deps.runner();
      if (!runner) error = 'the command runner is not available';
      else {
        const res = await runner.runCheck(check.command, check.repo, { officeMetricId: metric.id }, () => this.stopping, `office-metric:${role.key}`, {
          timeoutMs: OFFICE_COMMAND_TIMEOUT_MS,
          tailLines: OFFICE_COMMAND_TAIL_LINES,
          tailChars: OFFICE_COMMAND_TAIL_CHARS,
        });
        runId = res.runId;
        if (res.error !== null) error = res.error;
        else {
          // the number decides, not the exit code: a script may print it and exit 1 to say "bad"
          value = lastTmMetric(res.tail);
          if (value === null) error = `exit ${res.exit ?? '?'}: no TM_METRIC=<number> in the output`;
        }
      }
    }
    if (this.stopping && value === null) return { ran: false, reason: 'server shutting down', code: 'stopping' };

    const at = new Date(this.now()).toISOString();
    const rec = await storage.recordOfficeMetricRun(
      metric.id,
      value === null ? { at, value: null, error: error ?? 'no value', runId } : { at, value, runId },
    );
    if (!rec) return { ran: false, reason: 'the metric was deleted while it ran', code: 'gone' };
    const audit = (kind: 'office.metric', data: Record<string, unknown>) =>
      storage.appendEvent({
        kind,
        actor: 'system',
        repoId: metric.repoId,
        data: { officeId: office.id, workspaceId: office.workspaceId, roleId: role.id, metricId: metric.id, name: metric.name, ...data },
      });

    let signal: OfficeSignal | null = null;
    if (value === null) {
      // once per distinct error, not once per slot
      if (metric.lastError !== error) await audit('office.metric', { action: 'error', error, runId, startedAt });
    } else if (rec.crossed) {
      const breachedAt = rec.metric.breachedAt ?? at;
      const text = metricSignalText(rec.metric, value, at, rec.previousValue);
      const appended = await storage.appendSignal({
        officeId: office.id,
        source: 'metric',
        externalId: metricSignalExternalId(metric.id, breachedAt),
        title: text.title,
        rawText: text.rawText,
        url: null,
        receivedAt: at,
      });
      signal = appended.signal;
      await audit('office.metric', { action: 'breach', value, threshold: { op: rec.metric.thresholdOp, value: rec.metric.thresholdValue }, signalId: signal.id, runId });
      if (appended.created) {
        const woke = await this.deps.signals?.()?.metricSignals(office, role.id).catch(() => false);
        (this.deps.log ?? console.log)(`office ${office.id}: metric "${metric.name}" breached (${value}); ${woke ? `${role.key} to wake` : 'no subscribed role to wake'}`);
      }
    } else if (rec.previousSide === 'breach' && rec.metric.lastSide === 'ok') {
      await audit('office.metric', { action: 'recovered', value, runId });
    }
    try {
      this.send({ type: 'office-metric.updated', metric: await withPoints(storage, rec.metric) });
    } catch {
      // the row is the truth; the next read catches up
    }
    return { ran: true, metric: rec.metric, value, error: value === null ? error : null, crossed: rec.crossed, signal };
  }
}

let instance: OfficeMetrics | null = null;

/** Boot wiring (index.ts). */
export function initOfficeMetrics(m: OfficeMetrics): void {
  instance = m;
}

/** The process-wide metric runner, or null before boot wiring. */
export function officeMetrics(): OfficeMetrics | null {
  return instance;
}
