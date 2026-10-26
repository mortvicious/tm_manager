import { useSyncExternalStore } from 'react';
import type { RebuildJob } from '@tm/shared';
import { api } from './api.ts';
import { toastError } from './toast.ts';

/**
 * Rebuild & restart, the page's side (docs/host.md § Rebuild & restart).
 *
 * A module store rather than component state: on a phone the button lives in
 * the More sheet, which unmounts when it closes, and the job it started must
 * still be followed to its end — that is what reloads this tab.
 */

declare const __TM_BUILD_ID__: string;
/** The build this page is running (web/vite.config.ts); `dev` under Vite. */
export const BUILD_ID: string = __TM_BUILD_ID__;

interface RebuildState {
  /** the latest reading of the job this tab is following, if any */
  job: RebuildJob | null;
  /** this tab pressed the button and the job has not ended: it reloads on `done` */
  mine: boolean;
  /** the failure the human closed (its finishedAt), so it does not come back */
  dismissed: string | null;
}

let state: RebuildState = { job: null, mine: false, dismissed: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<RebuildState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};

export const rebuildRunning = (j: RebuildJob | null | undefined) =>
  !!j &&
  (j.state === 'draining' ||
    j.state === 'building' ||
    j.state === 'typechecking' ||
    j.state === 'restarting' ||
    j.state === 'continuing');

let polling = false;

/** Follow the job until it ends. The API restarts under it, but this asks the
 *  front door, which stays up — a failed read is a blip, retried. */
async function follow(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      let job: RebuildJob;
      try {
        job = await api.hostRebuildJob();
      } catch {
        continue;
      }
      set({ job });
      if (job.state === 'done') {
        // Onto the new build (or, in dev, the new server) at once.
        location.reload();
        return;
      }
      if (job.state === 'failed' || job.state === 'idle') {
        // `idle`: the front door itself restarted mid-job and forgot it.
        set({ mine: false });
        if (job.state === 'failed') toastError(job.error ?? 'failed', 'Rebuild & restart');
        return;
      }
    }
  } finally {
    polling = false;
  }
}

/**
 * Press: 202 → follow it here; a 409 (`in_progress`) throws. The button always
 * asks for a DRAIN (docs/host.md § Drain): quiet, it is the old one-press job
 * plus a pause the job lifts itself; busy, it waits for the live turns instead
 * of refusing.
 */
export async function startRebuild(): Promise<void> {
  const r = await api.hostRebuild({ drain: true });
  set({ job: r.rebuild ?? null, mine: true, dismissed: null });
  void follow();
}

/** Give up a drain: the job releases the pause it set and ends `cancelled`. */
export async function cancelRebuildDrain(): Promise<void> {
  const r = await api.hostRebuildCancel();
  set({ job: r.rebuild ?? state.job });
}

export function dismissRebuildFailure(finishedAt: string | null): void {
  set({ dismissed: finishedAt });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useRebuild(): RebuildState {
  return useSyncExternalStore(subscribe, () => state);
}
