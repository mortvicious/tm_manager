import type { ChildProcess } from 'node:child_process';

/**
 * Every live headless `claude -p` child — analysis, adversarial review, feature
 * planning. These never enter a `SessionManager` (they have no PTY), so the
 * PTY-based "is an agent working?" count cannot see them, yet a restart kills
 * them exactly the same: an in-flight analysis dies, and boot recovery sweeps
 * its run row. This registry is that missing half of the answer.
 *
 * Keyed by the child process, not a run id: a feature-analysis pipeline runs
 * several children under ONE run row, and `review.ts` has no run row at all.
 */
interface Entry {
  label: string;
  /**
   * True for a child spawned `detached` (its own process-group leader) —
   * today only a chat turn (docs/chat.md). Signalling such a child alone is
   * not enough: the tools it spawns inherit its stdout, and one surviving
   * grandchild holds the pipe open forever. These are signalled as `-pid`.
   */
  group: boolean;
}

const live = new Map<ChildProcess, Entry>();
const listeners = new Set<() => void>();

/**
 * When `stopAllHeadless` last swept. A child that was killed by that sweep did
 * not FAIL — it was aborted, and the difference matters to anything that reacts
 * to a failure by doing more work: the resume gate answers a failed compaction
 * by spawning an agent, which after a `/killall` or a forced restart would be a
 * live worker starting seconds after the emergency stop reported everything
 * dead. Compared against a start time rather than exposed as a flag, so a child
 * that began AFTER the sweep is not tarred by it.
 */
let lastStopAll = 0;

/** Did a global headless stop happen at or after `since` (epoch ms)? */
export function headlessStoppedSince(since: number): boolean {
  return lastStopAll >= since;
}

/** Notified whenever the live set changes, so the UI's agent count can follow. */
export function onHeadlessChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function notify(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      // a broken listener must not break the spawn path
    }
  }
}

/**
 * @param label what this child is doing, for the restart refusal message.
 * @param opts  `group: true` for a child spawned `detached`, so shutdown
 *              signals its whole process group rather than the leader alone.
 */
export function registerHeadless(child: ChildProcess, label: string, opts: { group?: boolean } = {}): void {
  live.set(child, { label, group: !!opts.group });
  const done = () => {
    if (live.delete(child)) notify();
  };
  // 'error' covers a child that never spawned (no 'exit' follows it).
  child.on('exit', done);
  child.on('error', done);
  // Already dead by the time we registered (synchronous spawn failure).
  if (child.exitCode !== null || child.signalCode !== null) done();
  else notify();
}

/**
 * Shutdown / forced restart: signal every live headless child, so a server that
 * is going away does not leave `claude -p` processes burning tokens for nobody.
 * SIGTERM only — the escalation timers of a process that is about to exit are
 * worthless, and boot recovery kills whatever survived (after checking the pid
 * really is a claude).
 */
export function stopAllHeadless(): number {
  lastStopAll = Date.now();
  let n = 0;
  for (const [child, entry] of [...live.entries()]) {
    try {
      // A detached child is a group leader; `-pid` reaches the tools it
      // started. Signalling the leader alone would leave a Bash grandchild
      // running (and holding the reply pipe) through /killall and shutdown.
      if (entry.group && child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
      n++;
    } catch {
      // The group may already be gone; fall back to the child itself before
      // giving up, so a race between exit and signal is not a missed kill.
      try {
        child.kill('SIGTERM');
        n++;
      } catch {
        // already reaped
      }
    }
  }
  return n;
}

/** Labels of the headless agents running right now. */
export function liveHeadless(): string[] {
  return [...live.values()].map((e) => e.label);
}
