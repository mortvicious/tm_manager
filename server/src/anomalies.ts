// Anomaly notifications (docs/push.md § What pings, docs/telegram.md §
// Notifications): the `anomaly.*` thresholds (shared with the Dashboard), plus
// the budget fuses tripping, become ONE ping per task per anomaly type per
// episode. This module owns the coalescing memory and the emit; the
// orchestrator's sweep decides what is anomalous (it owns the live sessions).
//
// The memory is the audit log itself: every alert that goes out is an
// `anomaly.notified` row carrying its key, and a boot re-reads the last 30
// days of them, so a restart does not re-ping the same stale review.

import type { AnomalyAlert, AnomalyAlertType, AnomalySeverity, Task } from '@tm/shared';
import { broadcast } from './events.ts';
import type { Storage } from './storage/types.ts';

const MEMORY_DAYS = 30;

// The expensive-task line (docs/token-budget.md § The expensive-task alert).
// A fixed $10 sat under the median task of every repo but one and made 126 of
// 146 tasks "critical"; the line is now each repo's own history.
/** baseline window: tasks updated in the last 30 days */
export const COST_LINE_WINDOW_MS = 30 * 24 * 3600_000;
/** a repo needs this many costed tasks in the window for its own p90 */
export const COST_LINE_MIN_TASKS = 10;
/** the adaptive line never goes below this — it would self-normalise otherwise */
export const COST_LINE_FLOOR_USD = 10;

export interface CostLine {
  /** the line a task's roll-up is compared to */
  usd: number;
  /**
   * `fixed` = `anomaly.taskCostUsd` > 0; `repo` = this repo's p90; `global` =
   * the all-repo p90 (the repo has fewer than COST_LINE_MIN_TASKS); `floor` =
   * the p90 it would have been is under COST_LINE_FLOOR_USD
   */
  source: 'fixed' | 'repo' | 'global' | 'floor';
  /** the p90 the line came from (null for `fixed`, or no costed task at all) */
  p90: number | null;
  /** costed tasks the p90 was taken over */
  n: number;
}

/** Nearest-rank 90th percentile; null for no samples. */
export function p90(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.9 * sorted.length) - 1];
}

/**
 * The cost line for a task in `repoId`, over `tasks` (the baseline — the
 * caller passes the last COST_LINE_WINDOW_MS of rows). Pure. Only tasks that
 * cost something count: a draft at $0 says nothing about what work costs.
 */
export function costLine(
  repoId: string | null,
  tasks: Pick<Task, 'repoId' | 'costUsd'>[],
  fixedUsd = 0,
): CostLine {
  if (fixedUsd > 0) return { usd: fixedUsd, source: 'fixed', p90: null, n: 0 };
  const costed = tasks.filter((t) => t.costUsd > 0);
  const own = repoId ? costed.filter((t) => t.repoId === repoId) : [];
  const pool = own.length >= COST_LINE_MIN_TASKS ? own : costed;
  const p = p90(pool.map((t) => t.costUsd));
  const source = pool === own ? 'repo' : 'global';
  if (p === null || p < COST_LINE_FLOOR_USD) return { usd: COST_LINE_FLOOR_USD, source: 'floor', p90: p, n: pool.length };
  return { usd: p, source, p90: p, n: pool.length };
}

/**
 * The `cost-high` verdict for one task: null under the line, `warn` above it,
 * `critical` above 2× it. The message states the baseline ("$118, 1.3× this
 * repo's p90 ($92)").
 */
export function costVerdict(costUsd: number, line: CostLine): { severity: 'warn' | 'critical'; message: string } | null {
  if (!(line.usd > 0) || !(costUsd > line.usd)) return null;
  const ratio = costUsd / line.usd;
  const usd = (v: number) => `$${v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 0 : 2)}`;
  const base =
    line.source === 'fixed'
      ? `the ${usd(line.usd)} threshold`
      : line.source === 'repo'
        ? `this repo's p90 (${usd(line.usd)})`
        : line.source === 'global'
          ? `the all-repo p90 (${usd(line.usd)}; this repo has under ${COST_LINE_MIN_TASKS} tasks in 30 days)`
          : `the ${usd(line.usd)} floor (p90 ${line.p90 === null ? 'n/a' : usd(line.p90)})`;
  return {
    severity: ratio > 2 ? 'critical' : 'warn',
    message: `has cost $${costUsd.toFixed(2)}, ${ratio.toFixed(1)}× ${base}`,
  };
}

export class AnomalyAlerts {
  private sent = new Set<string>();
  private primed: Promise<void>;

  constructor(private storage: Storage) {
    this.primed = this.prime();
  }

  private async prime(): Promise<void> {
    try {
      const since = new Date(Date.now() - MEMORY_DAYS * 24 * 3600_000).toISOString();
      const rows = await this.storage.listEvents({ kind: 'anomaly.notified', since, limit: 2000 });
      for (const e of rows) {
        const key = (e.data as { key?: unknown } | null)?.key;
        if (typeof key === 'string') this.sent.add(key);
      }
    } catch (err) {
      console.error('anomaly alerts: could not read the notified log (pings may repeat once):', err);
    }
  }

  /** Whether this key already went out (in this boot or the last 30 days). */
  async has(key: string): Promise<boolean> {
    await this.primed;
    return this.sent.has(key);
  }

  /**
   * Emit an alert unless its key already went out. Marked BEFORE the audit
   * write and the broadcast, so two sweeps racing cannot both send it.
   */
  async emit(a: {
    type: AnomalyAlertType;
    severity: AnomalySeverity;
    message: string;
    key: string;
    taskId?: string | null;
    runId?: string | null;
    data?: Record<string, unknown>;
  }): Promise<boolean> {
    await this.primed;
    if (this.sent.has(a.key)) return false;
    this.sent.add(a.key);
    const alert: AnomalyAlert = {
      type: a.type,
      severity: a.severity,
      message: a.message,
      key: a.key,
      taskId: a.taskId ?? null,
      runId: a.runId ?? null,
    };
    try {
      await this.storage.appendEvent({
        kind: 'anomaly.notified',
        actor: 'system',
        taskId: alert.taskId ?? undefined,
        runId: alert.runId ?? undefined,
        data: { type: a.type, key: a.key, severity: a.severity, message: a.message, ...(a.data ?? {}) },
      });
    } catch (err) {
      console.error('anomaly alerts: audit write failed (sending anyway):', err);
    }
    broadcast({ type: 'anomaly.raised', alert });
    return true;
  }
}
