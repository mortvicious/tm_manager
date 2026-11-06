// The office scorecard's I/O half (docs/office.md § Scorecard): read the rows
// the pure `officeScorecard` folds, plus the route's 10-minute cache.

import {
  officeScorecard,
  type AuditEvent,
  type Office,
  type OfficeProposal,
  type OfficeScorecard,
  type OfficeScorecardResponse,
  type OfficeScorecardRows,
  type OfficeScorecardWindow,
} from '@tm/shared';
import { EVENT_LIST_MAX } from '../storage/event-sql.ts';
import type { Storage } from '../storage/types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** task ids per `IN (…)` list — far under SQLite's variable limit */
const TASK_ID_CHUNK = 500;

const toScorecardEvent = (e: AuditEvent) => ({ kind: e.kind, at: e.at, actor: e.actor, taskId: e.taskId ?? null, data: (e.data as Record<string, unknown> | null) ?? null });

/** Every row `officeScorecard` reads for `office` over `window` (the window's end is "now": spend is summed since its start). */
export async function scorecardRows(storage: Storage, office: Office, window: OfficeScorecardWindow): Promise<OfficeScorecardRows> {
  const roles = await storage.listOfficeRoles(office.id);
  const tasks = await storage.listTasks({ officeId: office.id });
  const ids = tasks.map((t) => t.id);
  const events: AuditEvent[] = [];
  for (let i = 0; i < ids.length; i += TASK_ID_CHUNK) {
    events.push(
      ...(await storage.listEvents({
        kinds: ['task.transition', 'question.answered', 'approval.decided'],
        taskIds: ids.slice(i, i + TASK_ID_CHUNK),
        since: window.since,
        until: window.until,
        limit: EVENT_LIST_MAX,
      })),
    );
  }
  for (const e of await storage.listEvents({ kind: 'office.taint-cleared', since: window.since, until: window.until, limit: EVENT_LIST_MAX })) {
    if ((e.data as { officeId?: unknown } | null)?.officeId === office.id) events.push(e);
  }
  const shifts = await storage.listShifts({ officeId: office.id, since: window.since, until: window.until, limit: 5000 });
  const proposals: OfficeProposal[] = [
    ...(await storage.listOfficeProposals({ officeId: office.id, status: 'accepted', limit: 2000 })),
    ...(await storage.listOfficeProposals({ officeId: office.id, status: 'rejected', limit: 2000 })),
  ];
  const ratings = await storage.listOfficeRatings({ officeId: office.id, limit: 2000 });
  const byRole: Record<string, number> = {};
  for (const r of roles) byRole[r.id] = await storage.officeSpendSince(office.id, window.since, r.id);
  return {
    officeId: office.id,
    roles: roles.map((r) => ({ id: r.id, key: r.key, name: r.name })),
    tasks,
    events: events.map(toScorecardEvent),
    shifts,
    proposals,
    ratings,
    spend: { officeUsd: await storage.officeSpendSince(office.id, window.since), byRole },
  };
}

/** The scorecard of the last `days` days up to `now`. */
export async function computeScorecard(storage: Storage, office: Office, days: number, now: Date): Promise<OfficeScorecardResponse> {
  const window = { since: new Date(now.getTime() - days * DAY_MS).toISOString(), until: new Date(now.getTime() + 1).toISOString() };
  const card: OfficeScorecard = officeScorecard(await scorecardRows(storage, office, window), window);
  return { ...card, until: now.toISOString(), officeId: office.id, days, computedAt: now.toISOString() };
}

/** The scorecard since an instant (the stand-up's window) up to `now`. */
export async function scorecardSince(storage: Storage, office: Office, sinceIso: string, now: Date): Promise<OfficeScorecard> {
  const window = { since: sinceIso, until: new Date(now.getTime() + 1).toISOString() };
  const card = officeScorecard(await scorecardRows(storage, office, window), window);
  return { ...card, until: now.toISOString() };
}

export const SCORECARD_CACHE_MS = 10 * 60 * 1000;

/**
 * The route's cache: per (office, days), 10 minutes, one computation in
 * flight per key. A changed office is not invalidated on purpose — the figures
 * are a 7/30-day read, ten minutes stale is fine and the read is not cheap.
 */
export class ScorecardCache {
  private entries = new Map<string, { at: number; value: Promise<OfficeScorecardResponse> }>();
  constructor(private readonly ttlMs = SCORECARD_CACHE_MS, private readonly clock: () => number = Date.now) {}

  get(key: string, compute: () => Promise<OfficeScorecardResponse>): Promise<OfficeScorecardResponse> {
    const now = this.clock();
    const hit = this.entries.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.value;
    const value = compute();
    this.entries.set(key, { at: now, value });
    // a failure is never cached
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }

  /** drop an office's entries (deleted office) */
  forget(officeId: string): void {
    for (const k of this.entries.keys()) if (k.startsWith(`${officeId}:`)) this.entries.delete(k);
  }
}
