import type { Task } from '@tm/shared';
import { markPublishedOffered, publishIsPrimary } from './publish.ts';

/**
 * The next step (docs/mobile.md § Next step): what the HUMAN should do with a
 * task, named on the phone row's one primary button ("Publish", "Answer",
 * "Retry", "Findings"…). Read off the same signals `badgeReading` reads, in
 * its order — a question first, then a terminal prompt, then a publish under
 * way — so the pill and the button never disagree: a row never says
 * "auto-review" beside "Publish", and a row that reads "publishing" offers
 * nothing (the press is in flight). The `buildInbox` kinds that are about one
 * task (question, attention, settled review, failed) are exactly the steps
 * here that are not `run`.
 *
 * `null` = nothing waits on the human; the row falls back to its terminal
 * glyph (a working task) or to nothing.
 */
export type NextStepKind = 'answer' | 'prompt' | 'publish' | 'findings' | 'retry' | 'run';

export interface NextStep {
  kind: NextStepKind;
  /** the button's text — one or two words */
  label: string;
  /** the longer reading, for `aria-label`/title */
  title: string;
}

export interface NextStepSignals {
  /** a pending question from its agent (docs/questions.md) */
  question: boolean;
  /** its live run is stopped at a terminal prompt (needs attention) */
  attention: boolean;
  /** a run row of the task is still `running` — the server refuses run/retry then */
  live: boolean;
  /** a publish is under way (`publishBusy`) or any action is in flight */
  busy: boolean;
}

/** `state:ready` (docs/search.md) and the Now strip's "to publish": Publish may take the primary slot. */
export function readyToShip(task: Task): boolean {
  return publishIsPrimary(task);
}

export function nextStep(task: Task, s: NextStepSignals): NextStep | null {
  if (s.question) return { kind: 'answer', label: 'Answer', title: 'The agent asked you a question — answer it' };
  if (s.attention) return { kind: 'prompt', label: 'Respond', title: 'Stopped at a prompt in its terminal — open it and answer' };
  if (s.busy) return null;
  if (task.status === 'review') {
    if (publishIsPrimary(task)) {
      return markPublishedOffered(task)
        ? { kind: 'publish', label: 'Mark published', title: 'The agent already pushed it — record it as published' }
        : { kind: 'publish', label: 'Publish', title: "Clean verdict — commit and push this work in the agent's own terminal" };
    }
    // an open review round or checks run: nothing to do yet (the pill says which)
    const open =
      task.reviewState === 'pending' ||
      task.reviewState === 'reviewing' ||
      task.checkState === 'pending' ||
      task.checkState === 'running';
    if (open) return null;
    if (task.reviewState === 'flagged' || task.checkState === 'red')
      return { kind: 'findings', label: 'Findings', title: task.checkState === 'red' ? 'A repo check still fails — read the output' : 'The reviewer flagged issues — read the findings' };
    if (task.reviewState === 'error' || task.checkState === 'error')
      return { kind: 'findings', label: 'Details', title: 'The review or a check could not run — see why' };
    return null;
  }
  if (!task.repoId || s.live) return null;
  // one vocabulary with the panel (docs/inbox.md § Retry or Resume): Retry is a fresh agent through the queue
  if (task.status === 'failed' || task.status === 'cancelled')
    return { kind: 'retry', label: 'Retry', title: 'A fresh agent through the queue, told what the last attempt hit' };
  // a draft waits on the human; a queued task waits on the queue (its Run now stays the row's play glyph)
  if (task.status === 'draft') return { kind: 'run', label: 'Run now', title: 'Spawn an agent at once, ahead of the queue' };
  return null;
}
