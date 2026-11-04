// The office day budget (docs/office.md § Gate and budget). An office's
// spend is counted per OFFICE-LOCAL day (`officeDayStart` in its timezone).
// When it reaches `dayBudgetUsd` the OFFICE is paused — `budget_tripped_on`
// = that day, pause reason `OFFICE_OVER_BUDGET_REASON`, one `office.paused`
// audit row, an `office.updated` broadcast — and the next local midnight
// clears it. Nothing here touches `orchestrator.paused` or the global queue:
// the office switches gate office-originated work only (decisions.md
// 2026-11-04, amending 2026-10-28).

import type { Office } from '@tm/shared';
import { OFFICE_OVER_BUDGET_REASON, isValidTimeZone, officeDay, officeDayStart } from '@tm/shared';
import { broadcast } from '../events.ts';
import type { Storage } from '../storage/types.ts';

/** The office's zone, or UTC when the stored one is unusable (a zone is validated on write; never throw from a gate). */
export function officeZone(office: Pick<Office, 'timezone'>): string {
  return isValidTimeZone(office.timezone) ? office.timezone : 'UTC';
}

export interface OfficeDay {
  /** office-local `YYYY-MM-DD` */
  today: string;
  /** ISO of the office-local midnight that started it */
  sinceIso: string;
}

export function officeDayOf(office: Pick<Office, 'timezone'>, now: number): OfficeDay {
  const tz = officeZone(office);
  return { today: officeDay(now, tz), sinceIso: new Date(officeDayStart(now, tz)).toISOString() };
}

export interface OfficeBudgetState {
  /** the office row after any trip / clear this call wrote */
  office: Office;
  today: string;
  sinceIso: string;
  spentUsd: number;
  /** what this call changed */
  changed: 'tripped' | 'cleared' | null;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Bring the office's budget trip in line with today's spend, then report it.
 * Idempotent and safe to race: the pause goes through the conditional
 * `pauseOffice`, so two callers crossing the line together write ONE
 * `office.paused` row, and a human's own pause (any other reason) is never
 * replaced or lifted.
 *
 * - **Trip**: `dayBudgetUsd > 0`, spend ≥ it, not yet tripped today →
 *   `budget_tripped_on = today`, then pause (only if not already paused).
 * - **Clear**: spend is under the budget for TODAY — the office-local
 *   midnight passed, or the human raised the budget — → `budget_tripped_on`
 *   null, and a pause carrying `OFFICE_OVER_BUDGET_REASON` is lifted (one
 *   `office.resumed` row).
 *
 * A $0 budget never trips: it means "nothing runs", which the hard gate and
 * `officeBudgetVerdict` already refuse without calling it a budget overrun.
 */
export async function settleOfficeBudget(storage: Storage, office: Office, now = Date.now()): Promise<OfficeBudgetState> {
  const { today, sinceIso } = officeDayOf(office, now);
  const spentUsd = await storage.officeSpendSince(office.id, sinceIso);
  let cur = office;
  let changed: OfficeBudgetState['changed'] = null;
  const over = cur.dayBudgetUsd > 0 && !(spentUsd < cur.dayBudgetUsd);

  // Under the line today (a new office day, or the human raised the budget):
  // the trip mark goes, and so does a pause the trip itself wrote. Still over
  // on a new day = the trip below just moves to today; the pause stays put.
  if (!over && cur.budgetTrippedOn) {
    cur = (await storage.updateOffice(cur.id, { budgetTrippedOn: null })) ?? cur;
  }
  if (!over && cur.pausedAt && cur.pausedReason === OFFICE_OVER_BUDGET_REASON) {
    const lifted = await storage.pauseOffice(cur.id, null, true);
    if (lifted) {
      cur = lifted;
      changed = 'cleared';
      await storage.appendEvent({
        kind: 'office.resumed',
        actor: 'system',
        data: {
          officeId: cur.id,
          workspaceId: cur.workspaceId,
          reason: office.budgetTrippedOn && office.budgetTrippedOn !== today ? 'midnight' : 'under budget',
          day: today,
          trippedOn: office.budgetTrippedOn,
          spentUsd,
          budgetUsd: cur.dayBudgetUsd,
        },
      });
    }
  }

  if (over && cur.budgetTrippedOn !== today) {
    cur = (await storage.updateOffice(cur.id, { budgetTrippedOn: today })) ?? cur;
    if (!cur.pausedAt) {
      const paused = await storage.pauseOffice(cur.id, OFFICE_OVER_BUDGET_REASON, false);
      if (paused) {
        cur = paused;
        changed = 'tripped';
        await storage.appendEvent({
          kind: 'office.paused',
          actor: 'system',
          data: {
            officeId: cur.id,
            workspaceId: cur.workspaceId,
            reason: OFFICE_OVER_BUDGET_REASON,
            trigger: 'day-budget',
            day: today,
            spentUsd,
            budgetUsd: cur.dayBudgetUsd,
          },
        });
      } else {
        // lost the conditional write (a racing settle or a human got there first): read what won
        cur = (await storage.getOffice(cur.id)) ?? cur;
      }
    }
    // a pause someone else holds stays theirs; the trip mark alone keeps the gate shut
    changed ??= 'tripped';
  }

  if (cur !== office) broadcast({ type: 'office.updated', office: cur });
  return { office: cur, today, sinceIso, spentUsd, changed };
}

/** Every office's trip / midnight clear, from the orchestrator's minute sweep. Never throws. */
export async function settleAllOfficeBudgets(storage: Storage, now = Date.now()): Promise<void> {
  let offices: Office[];
  try {
    offices = await storage.listOffices();
  } catch (e) {
    console.error('office budget sweep failed:', e);
    return;
  }
  for (const o of offices) {
    try {
      await settleOfficeBudget(storage, o, now);
    } catch (e) {
      console.error(`office budget sweep failed for ${o.id}:`, e);
    }
  }
}

export type OfficeBudgetRefusal = { fuse: 'office.paused' | 'office.dayBudgetUsd'; spentUsd: number; capUsd: number; reason: string };

/**
 * May an AUTOMATIC turn on a task this office filed start? Settles the trip
 * first (so the turn that would cross the line is the one that trips it), then
 * refuses while the office is paused — any reason — or its day is spent.
 */
export async function officeBudgetVerdict(
  storage: Storage,
  office: Office,
  now = Date.now(),
  what = 'turn',
): Promise<OfficeBudgetRefusal | null> {
  const s = await settleOfficeBudget(storage, office, now);
  const o = s.office;
  if (o.pausedAt) {
    return {
      fuse: 'office.paused',
      spentUsd: s.spentUsd,
      capUsd: o.dayBudgetUsd,
      reason: `budget: this task's office is paused${o.pausedReason ? ` (${o.pausedReason})` : ''} — the automatic ${what} was not started. Proceed, Follow-up or Retry still work.`,
    };
  }
  if (o.budgetTrippedOn === s.today || !(s.spentUsd < o.dayBudgetUsd)) {
    return {
      fuse: 'office.dayBudgetUsd',
      spentUsd: s.spentUsd,
      capUsd: o.dayBudgetUsd,
      reason: `budget: this task's office has spent ${usd(s.spentUsd)} of its ${usd(o.dayBudgetUsd)} day budget — the automatic ${what} was not started (the office's day resets at its local midnight). Proceed, Follow-up or Retry still work.`,
    };
  }
  return null;
}
