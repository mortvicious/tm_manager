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
const live = new Map<ChildProcess, string>();
const listeners = new Set<() => void>();

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

/** @param label what this child is doing, for the restart refusal message. */
export function registerHeadless(child: ChildProcess, label: string): void {
  live.set(child, label);
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
  let n = 0;
  for (const child of [...live.keys()]) {
    try {
      child.kill('SIGTERM');
      n++;
    } catch {
      // already gone
    }
  }
  return n;
}

/** Labels of the headless agents running right now. */
export function liveHeadless(): string[] {
  return [...live.values()];
}
