import { useState } from 'react';
import { customQueueWaiting, queuePauseHolds, type Repo, type Task } from '@tm/shared';
import { api } from '../api.ts';
import { useArm } from '../arm.ts';
import { useIsMobile } from './Layout.tsx';
import { useApp } from '../state.tsx';
import { toastError } from '../toast.ts';

export interface QueuePauseRow {
  repo: Repo;
  paused: boolean;
  /** members working right now (running/waiting) */
  working: number;
  /** members still waiting their turn */
  waiting: number;
  /** turns that repo's Continue owes (suspended by its pause) */
  owed: number;
}

/**
 * One row per repo whose custom queue has something in it (a member working
 * or waiting) or is paused (docs/queue.md § Pausing a repo's queue).
 */
export function queuePauseRows(tasks: Task[], repos: Repo[], pausedRepos: readonly string[]): QueuePauseRow[] {
  const waiting = customQueueWaiting(tasks);
  return repos.flatMap((repo) => {
    const paused = pausedRepos.includes(repo.id);
    const mine = (t: Task) => t.repoId === repo.id;
    const row: QueuePauseRow = {
      repo,
      paused,
      working: tasks.filter((t) => mine(t) && !!t.customQueueAt && (t.status === 'running' || t.status === 'waiting'))
        .length,
      waiting: waiting.filter(mine).length,
      owed: tasks.filter((t) => mine(t) && !!t.pausedTurn && queuePauseHolds(t, pausedRepos)).length,
    };
    return paused || row.working || row.waiting ? [row] : [];
  });
}

/**
 * Pause / Continue for each repo's custom queue: Pause all scoped to one
 * repo's queue (docs/queue.md § Pausing a repo's queue). Pause suspends the
 * members' live turns so their OWN sessions resume on Continue and starts no
 * member there; nothing is cancelled and nobody loses their place. Both
 * directions take a second press, like Pause all.
 */
export function QueuePauses({ rows }: { rows: QueuePauseRow[] }) {
  const { setOrch } = useApp();
  const mobile = useIsMobile();
  const arm = useArm();
  const [busy, setBusy] = useState<string | null>(null);
  if (rows.length === 0) return null;
  const again = mobile ? 'tap' : 'click';
  const press = async (row: QueuePauseRow) => {
    const verb = row.paused ? 'continue' : 'pause';
    if (busy || !arm.press(`${verb}:${row.repo.id}`)) return;
    setBusy(row.repo.id);
    try {
      await api.queuePauseAction(row.repo.id, verb);
      setOrch(await api.orchestrator());
    } catch (e) {
      toastError(e, row.paused ? 'Continue queue' : 'Pause queue');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="panel queue-pauses">
      {rows.map((row) => {
        const verb = row.paused ? 'continue' : 'pause';
        const armed = arm.armed === `${verb}:${row.repo.id}`;
        const parts = [
          row.paused ? 'paused' : null,
          row.owed ? `${row.owed} to resume` : null,
          row.working ? `${row.working} working` : null,
          row.waiting ? `${row.waiting} waiting` : null,
        ].filter(Boolean);
        return (
          <div className="queue-pause-row" key={row.repo.id}>
            <span className="name">{row.repo.name}</span>
            <span className={`mono ${row.paused ? 'paused-note' : 'muted'}`}>{parts.join(' · ')}</span>
            <button
              type="button"
              className={`btn ghost pause-all${row.paused ? ' paused' : ''}${armed ? ' armed' : ''}`}
              aria-pressed={row.paused}
              disabled={busy !== null}
              title={
                row.paused
                  ? `${row.repo.name}'s queue is paused — no member starts there.${row.owed ? ` Continue resumes ${row.owed} suspended task(s) in their own sessions,` : ' Continue'} then the queue picks up where it was.`
                  : `Pause ${row.repo.name}'s queue — suspend its members' live turns (each resumable in its own session) and start no member there until Continue. Nothing is cancelled; other repos keep running.`
              }
              onClick={() => press(row)}
            >
              {busy === row.repo.id
                ? row.paused
                  ? 'Continuing…'
                  : 'Pausing…'
                : armed
                  ? `${row.paused ? 'Continue' : 'Pause'}? ${again} again`
                  : row.paused
                    ? `▶ Continue${row.owed ? ` (${row.owed})` : ''}`
                    : '⏸ Pause'}
            </button>
          </div>
        );
      })}
    </div>
  );
}
