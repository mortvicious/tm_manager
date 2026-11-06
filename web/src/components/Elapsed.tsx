import type { Run, Task } from '@tm/shared';
import type { PendingAction } from '../pending.ts';
import { useNow } from './TimeAgo.tsx';
import { useClock } from '../clock.ts';
import { runsOfTask } from '../runIndex.ts';

/**
 * Live elapsed time on a row (docs/mobile.md § Live timers): how long the
 * thing under way has been under way, from a time the client was TOLD —
 * the press's `since` (src/pending.ts) or the run's `startedAt` — never a
 * guess at how far along it is (that is the progress %, docs/task-progress.md).
 *
 * `fine` (seconds, a per-second tick) is for what should settle in seconds
 * to minutes: an action in flight, the agent's publish turn. A working turn
 * reads in minutes off the board's shared 30 s clock (`useNow`).
 */
export interface ElapsedSource {
  since: number;
  fine: boolean;
  /** what is being timed, for the tooltip */
  what: string;
}

export function elapsedSource(
  task: Pick<Task, 'id' | 'status'>,
  runs: readonly Pick<Run, 'taskId' | 'mode' | 'status' | 'label' | 'idle' | 'startedAt'>[],
  pending: PendingAction | null | undefined,
): ElapsedSource | null {
  if (pending) return { since: pending.since, fine: true, what: pending.verb.replace(/…$/, '') };
  if (task.status !== 'running' && task.status !== 'waiting') return null;
  // runs are started_at DESC: the first live worker run is the turn under way
  const run = runsOfTask(runs, task.id).find((r) => r.mode !== 'aux' && r.status === 'running');
  const since = run ? Date.parse(run.startedAt) : NaN;
  if (!run || !Number.isFinite(since)) return null;
  if (run.label === 'publish' && !run.idle) return { since, fine: true, what: 'Publish turn' };
  return { since, fine: false, what: task.status === 'waiting' ? 'This turn (waiting on a subagent or shell)' : 'This turn' };
}

/** "0:42" / "12:05" / "1:02:09" */
export function fmtClock(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "<1m" / "12m" / "1h 05m" / "2d 3h" */
export function fmtElapsed(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function Elapsed({ source }: { source: ElapsedSource }) {
  // the shared clock's 1 s period, subscribed only while a fine timer is on screen
  const second = useClock(1000, source.fine);
  const minute = useNow();
  // the coarse clock can be up to 30 s behind a fresh `since`: never read negative
  const ms = Math.max(0, (source.fine ? second : Math.max(minute, source.since)) - source.since);
  const text = source.fine ? fmtClock(ms) : fmtElapsed(ms);
  return (
    <span className="elapsed" title={`${source.what} — ${fmtElapsed(ms)} so far (since ${new Date(source.since).toLocaleTimeString()})`}>
      {text}
    </span>
  );
}
