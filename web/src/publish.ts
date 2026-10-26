import { publishCaution, publishGateReason, type Task } from '@tm/shared';

/**
 * Publish and the verify gate (docs/publish.md § The verify gate). Publish is
 * the one irreversible tap in the core loop: it pushes, and the publish turn
 * runs the repo's deploy steps. So it is the primary action only over a
 * verdict that lets it ship — never while the review or checks are still open
 * (the server refuses then too) and never over a flagged review or red checks,
 * where it stays reachable behind `confirmPublish`.
 */

/** Publish may sit in the primary slot (row glyph, panel bar, Inbox). */
export function publishIsPrimary(task: Task): boolean {
  return task.status === 'review' && !!task.repoId && !publishGateReason(task) && !publishCaution(task);
}

/**
 * Ask before publishing over a settled non-clean verdict, restating it. True =
 * go ahead (no caution, or the human confirmed). A clean publish never asks.
 */
export function confirmPublish(task: Task): boolean {
  const caution = publishCaution(task);
  if (!caution) return true;
  return confirm(
    `${caution[0].toUpperCase()}${caution.slice(1)} — publish anyway?\n\n` +
      `“${task.title}” will be committed and pushed, and the repo's deploy steps run. This cannot be undone from here.`,
  );
}
