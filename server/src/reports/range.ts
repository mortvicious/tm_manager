import { REPORT_MAX_DAYS, REPORT_RANGE_PRESETS, type ReportRangePreset } from '@tm/shared';

/**
 * Date handling for reports (docs/reports.md).
 *
 * A report's bounds are LOCAL CALENDAR DAYS, not instants: the human picked
 * "today" and the document prints "24.08.2026", so a UTC window would put a
 * Baku evening's work in the next day's section — the same reason
 * `routes/stats.ts` buckets its bars in JS on server-local time rather than
 * with SQL `date()`. Everything here works in the server's own zone and only
 * widens to instants at the edge, where the storage query needs them.
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` for a Date, in server-local time. Twin of stats.ts `dayKey`. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` of an ISO instant, in server-local time. */
export function dayKeyOf(iso: string): string {
  return dayKey(new Date(iso));
}

/** Local midnight that OPENS the given day. */
export function startOfDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/** The last instant of the given day — inclusive upper bound. */
export function endOfDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}

/** `24.08.2026` — how the document prints a day. */
export function formatDay(day: string): string {
  const [y, m, d] = day.split('-');
  return `${d}.${m}.${y}`;
}

/**
 * A `YYYY-MM-DD` that is a real day. `new Date('2026-02-31')` does not throw,
 * it rolls over into March — so the round trip through `dayKey` is the test.
 */
export function isValidDay(day: string): boolean {
  if (!DAY_RE.test(day)) return false;
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

export interface ResolvedRange {
  fromDate: string;
  toDate: string;
  /** ISO instants for the storage query — local midnight to local end-of-day. */
  since: string;
  until: string;
  days: number;
}

/**
 * Turn a preset (or an explicit pair) into the window the report covers.
 * A preset counts BACK from today INCLUSIVE — "3 days" is today and the two
 * before it, not today minus three — because that is what the label promises
 * on a board where today's work is the reason you opened the picker.
 */
export function resolveRange(
  preset: ReportRangePreset,
  from: string | undefined,
  to: string | undefined,
  now = new Date(),
): { ok: true; range: ResolvedRange } | { ok: false; error: string } {
  let fromDate: string;
  let toDate: string;

  if (preset === 'custom') {
    if (!from || !to) return { ok: false, error: 'from and to are required for a custom range' };
    if (!isValidDay(from) || !isValidDay(to)) return { ok: false, error: 'from and to must be YYYY-MM-DD dates' };
    if (from > to) return { ok: false, error: 'from must not be after to' };
    fromDate = from;
    toDate = to;
  } else {
    const spec = REPORT_RANGE_PRESETS.find((p) => p.value === preset);
    if (!spec || spec.days === null) return { ok: false, error: `unknown range preset: ${preset}` };
    toDate = dayKey(now);
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (spec.days - 1));
    fromDate = dayKey(start);
  }

  const since = startOfDay(fromDate);
  const until = endOfDay(toDate);
  // Inclusive day count, computed from the local midnights rather than by
  // dividing the millisecond span: a DST shift makes one of those days 23 or
  // 25 hours long and the division would be off by one across it.
  const days = Math.round((startOfDay(toDate).getTime() - since.getTime()) / 86_400_000) + 1;
  if (days > REPORT_MAX_DAYS) {
    return { ok: false, error: `range too wide: ${days} days (max ${REPORT_MAX_DAYS})` };
  }

  return { ok: true, range: { fromDate, toDate, since: since.toISOString(), until: until.toISOString(), days } };
}
