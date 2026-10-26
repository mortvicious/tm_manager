import { useState, type MouseEvent } from 'react';
import type { CheckState, LoopState, ReviewState, TaskStatus } from '@tm/shared';
import { ExplainSheet, explainTitle, type Explanation } from './Explain.tsx';
import { useIsMobile } from './Layout.tsx';

const cls: Partial<Record<TaskStatus, string>> = {
  running: 's-running',
  waiting: 's-waiting',
  queued: 's-queued',
  published: 's-published',
  done: 's-done',
  review: 's-review',
  blocked: 's-blocked',
  failed: 's-failed',
};

export interface BadgeInput {
  status: TaskStatus;
  attention?: boolean;
  /** the agent is waiting on an answer to its question (docs/questions.md) */
  question?: boolean;
  reviewState?: ReviewState | null;
  checkState?: CheckState | null;
  /** a loop task's state (docs/loops.md): between iterations it is `running` with no session */
  loopState?: LoopState | null;
}

export interface BadgeReading extends Explanation {
  label: string;
  cls: string;
  /** auto-review: the reviewer's terminal is what the badge opens while it is live */
  reviewer?: boolean;
}

/** The plain statuses: what each one means and what the human can do with it. */
const PLAIN: Record<TaskStatus, { what: string; todo?: string }> = {
  draft: { what: 'Not queued yet — nothing runs until you say so.', todo: 'Enqueue it, Add to queue, or Run now.' },
  queued: { what: 'In the queue, waiting for a worker slot and for its repo to be free.', todo: 'Run now jumps the queue.' },
  running: { what: 'An agent is working on it in its own terminal.', todo: 'Open the terminal to watch or type into it.' },
  waiting: {
    what: 'The agent ended its turn with a background subagent or shell still running. It resumes on its own when that returns; a shell holds it only for a limited time.',
    todo: 'Nothing to do — it is not waiting on you. If only a shell holds it and the agent no longer needs it, Stop waiting lands it now.',
  },
  blocked: { what: 'Split into child tasks; it waits for them to finish.', todo: 'Unblock it to run it anyway.' },
  review: { what: 'The agent finished its turn; the change waits for you.', todo: 'Read the summary, then Publish, Mark done or Follow up.' },
  published: { what: 'Committed and pushed by the agent that did the work.' },
  done: { what: 'Closed without a push from the task manager.' },
  failed: { what: 'The run ended with an error — the reason is in the task panel.', todo: 'Retry or Resume it.' },
  cancelled: { what: 'Cancelled.', todo: 'Retry starts it again.' },
};

/**
 * What the pill says, and why (docs/mobile.md § Tap to explain). Synthetic
 * readings sit on top of the real status, all derived from server-owned fields
 * rather than being statuses of their own (docs/design.md § Adversarial
 * review): `auto-review` while a task parked in `review` is still being read
 * by the adversarial reviewer, and `fixing` while it is `running` on that
 * reviewer's findings. The repo checks (docs/checks.md) add `checking` (due or
 * running, before the reviewer) and `checks red` (the fix loop ended with a
 * failing check); a `running` task fixing red checks reads `fixing checks`. A
 * loop task between iterations (docs/loops.md) reads `loop checks` / `next
 * iteration`. `asks you` and `needs attention` come first, from the live run.
 *
 * One switch for the badge, its tooltip, its phone sheet and the task sheet's
 * "what's happening" strip, so the three can never disagree.
 */
export function badgeReading({ status, attention, question, reviewState, checkState, loopState }: BadgeInput): BadgeReading {
  const r = (label: string, c: string, what: string, todo?: string, reviewer?: boolean): BadgeReading => ({
    label,
    cls: c,
    title: label,
    what,
    todo,
    reviewer,
  });
  if (question)
    return r('asks you', 's-attention', 'The agent asked you a question and is waiting for the answer.', 'Answer it — the question sheet, or the Inbox.');
  if (attention)
    return r(
      'needs attention',
      's-attention',
      'The agent is stopped at a prompt in its terminal (a permission dialog, usually) and cannot go on by itself.',
      'Open the terminal and answer the prompt.',
    );
  if (status === 'review' && (checkState === 'pending' || checkState === 'running'))
    return r('checking', 's-checking', 'The server is running the repo checks on this change.', 'Nothing to do yet — the review follows.');
  if (status === 'review' && checkState === 'red')
    return r(
      'checks red',
      's-checksred',
      'A repo check still fails and the fix rounds ended.',
      'The failing output is in the task panel: Follow up with a fix, or Review now.',
    );
  if (status === 'review' && (reviewState === 'pending' || reviewState === 'reviewing'))
    return r('auto-review', 's-autoreview', 'The adversarial reviewer is reading this change.', 'Nothing to do yet — the verdict lands here.', true);
  if (status === 'running' && loopState === 'checking')
    return r('loop checks', 's-checking', 'A loop iteration ended — the server is committing its leftovers and running the checks.');
  if (status === 'running' && loopState === 'next')
    return r('next iteration', 's-running s-loopnext', 'The next loop iteration starts as soon as a worker slot is free.');
  if (status === 'running' && (checkState === 'red' || checkState === 'running'))
    return r('fixing checks', 's-running s-fixing', 'The agent is fixing a failing repo check.', 'Nothing to do — the checks re-run when it stops.');
  if (status === 'running' && reviewState === 'fixing')
    return r('fixing', 's-running s-fixing', "The agent is fixing the adversarial reviewer's findings.", 'Nothing to do — it lands in review again.');
  // the label stays the plain status; the explanation knows the verdict
  if (status === 'review') {
    if (checkState === 'error')
      return r('review', cls.review!, 'A repo check could not run (a timeout or a spawn failure) — that is not a red.', 'Look at the check output in the task panel.');
    if (reviewState === 'passed')
      return r('review', cls.review!, 'The review is clean — the change is ready to ship.', 'Publish it, or Mark done to close without pushing.');
    if (reviewState === 'flagged')
      return r('review', cls.review!, 'The reviewer flagged issues in this change.', 'Read the findings in the task panel: Follow up to fix them, or publish over them.');
    if (reviewState === 'error')
      return r('review', cls.review!, 'The adversarial review could not run.', 'Review now to try again.');
  }
  const p = PLAIN[status];
  return r(status, cls[status] ?? '', p.what, p.todo);
}

/**
 * Status pill. On a desktop its explanation is the tooltip; on a phone a tap
 * opens it in a sheet (`explain={false}` gives the tap back to the row, e.g.
 * in select mode). While the reviewer's terminal is live the auto-review pill
 * opens it — on a phone through the sheet's action.
 */
export function StatusBadge({
  onOpenReviewer,
  explain = true,
  ...input
}: BadgeInput & {
  /** set while the reviewer's terminal is live: the auto-review badge opens it */
  onOpenReviewer?: () => void;
  explain?: boolean;
}) {
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const b = badgeReading(input);
  const link = b.reviewer ? onOpenReviewer : undefined;
  const body = (
    <>
      <span className="dot" /> {b.label}
      {link ? ' ↗' : ''}
    </>
  );
  if (mobile && explain) {
    return (
      <>
        <button
          type="button"
          className={`badge ${b.cls} badge-tap`}
          aria-label={`${b.label} — what does this mean?`}
          onClick={(e: MouseEvent) => {
            e.stopPropagation();
            setOpen(true);
          }}
        >
          {body}
        </button>
        {open && (
          <ExplainSheet
            explain={b}
            lead={
              <span className={`badge ${b.cls}`}>
                <span className="dot" /> {b.label}
              </span>
            }
            action={link ? { label: "Open the reviewer's terminal", run: link } : undefined}
            onClose={() => setOpen(false)}
          />
        )}
      </>
    );
  }
  if (link) {
    return (
      <button
        type="button"
        className={`badge ${b.cls} badge-link`}
        title={`${b.what} — open its terminal`}
        onClick={(e) => {
          e.stopPropagation();
          link();
        }}
      >
        {body}
      </button>
    );
  }
  return (
    <span className={`badge ${b.cls}`} title={explainTitle(b)}>
      {body}
    </span>
  );
}

/** The phone task sheet's one line under the head: what is happening, what you can do. */
export function BadgeStrip(input: BadgeInput) {
  const b = badgeReading(input);
  return (
    <div className="so-explain">
      <span className="so-explain-what">{b.what}</span>
      {b.todo && <span className="so-explain-todo">{b.todo}</span>}
    </div>
  );
}
