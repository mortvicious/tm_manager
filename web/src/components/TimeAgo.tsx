import { useEffect, useState } from 'react';

/** Fresh enough to be worth a marker: anything filed in the last day. */
export const NEW_MS = 24 * 60 * 60 * 1000;
/** Past this the row is dimmed — an old task should not look like today's. */
export const STALE_MS = 14 * 24 * 60 * 60 * 1000;

// One shared clock: a board renders dozens of ages and each one owning its own
// interval would be dozens of timers doing the same tick.
const listeners = new Set<(n: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    listeners.add(setNow);
    if (!timer) {
      timer = setInterval(() => {
        const n = Date.now();
        for (const l of listeners) l(n);
      }, 30_000);
    }
    return () => {
      listeners.delete(setNow);
      if (listeners.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return now;
}

/** "now" / "9m" / "5h" / "3d" / "6w" / "2y" — narrow enough to end a task row. */
export function fmtAgo(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (d < 365) return `${w}w`;
  return `${Math.floor(d / 365)}y`;
}

const abs = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
};

/**
 * Age of one timestamp, with both timestamps in the tooltip so a row never
 * hides which of created/updated the number belongs to. Clock skew (a future
 * timestamp) clamps to "now" rather than rendering a negative age.
 */
export function TimeAgo({
  iso,
  field,
  fresh,
  createdAt,
  updatedAt,
}: {
  iso: string;
  /** which timestamp `iso` is — named in the tooltip */
  field: 'created' | 'updated';
  /** filed within NEW_MS — colour is a hint, the tooltip carries the fact */
  fresh?: boolean;
  createdAt: string;
  updatedAt: string;
}) {
  const now = useNow();
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const ms = now - t;
  const stale = ms >= STALE_MS;
  const note = fresh ? ' (new — filed in the last 24 hours)' : stale ? ' (stale)' : '';
  return (
    <span
      className={`age ${fresh ? 'fresh' : ''} ${stale ? 'stale' : ''}`}
      title={`${field} ${fmtAgo(ms)} ago${note}\ncreated ${abs(createdAt)}\nupdated ${abs(updatedAt)}`}
    >
      {fmtAgo(ms)}
    </span>
  );
}

/** Filed within the last day — the "this is new" marker on a row. */
export const isNew = (createdAt: string, now: number) => {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) && now - t < NEW_MS;
};
