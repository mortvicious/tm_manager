// Anomaly notifications (docs/push.md § What pings, docs/telegram.md §
// Notifications): the Dashboard's display-only `anomaly.*` thresholds, plus
// the budget fuses tripping, become ONE ping per task per anomaly type per
// episode. This module owns the coalescing memory and the emit; the
// orchestrator's sweep decides what is anomalous (it owns the live sessions).
//
// The memory is the audit log itself: every alert that goes out is an
// `anomaly.notified` row carrying its key, and a boot re-reads the last 30
// days of them, so a restart does not re-ping the same stale review.

import type { AnomalyAlert, AnomalyAlertType, AnomalySeverity } from '@tm/shared';
import { broadcast } from './events.ts';
import type { Storage } from './storage/types.ts';

const MEMORY_DAYS = 30;

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
