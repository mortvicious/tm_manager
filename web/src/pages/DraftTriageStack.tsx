import { useState, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { animate, motion, useDragControls, useMotionValue, useReducedMotion, useTransform, type PanInfo } from 'motion/react';
import type { BulkAction, Task, TriageDraft } from '@tm/shared';
import { api } from '../api.ts';
import { useArm } from '../arm.ts';
import { CANCEL_STALE_REASON } from '../components/Inbox.tsx';
import { IconX } from '../components/Icons.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { SWIPE_PX, inSideScroller, startSideSwipe, swipeSide } from '../sheetSwipe.ts';
import { useApp } from '../state.tsx';
import { errorText, toastError } from '../toast.ts';

/**
 * Phone draft triage (docs/inbox.md § Draft triage › Phone): one group's
 * drafts (or every draft, "Triage all") as a card stack in a tall `<Sheet>`,
 * oldest first. A swipe right is the toggle's action (Keep by default, or Add
 * to queue / Enqueue), a swipe left is Cancel with the triage reason; the big
 * buttons under the card mirror both plus Hide and Skip. Every decision is ONE
 * `POST /api/tasks/bulk` for that one id: a refusal flies the card back with
 * the server's reason on it. Nothing advances on its own — the next card
 * comes up only because the human decided (or skipped) this one.
 */

export type RightAction = Extract<BulkAction, 'keep' | 'queue' | 'enqueue'>;
type CardAction = RightAction | 'cancel' | 'hide';

export const RIGHT_ACTIONS: { id: RightAction; label: string }[] = [
  { id: 'keep', label: 'Keep' },
  { id: 'queue', label: 'Add to queue' },
  { id: 'enqueue', label: 'Enqueue' },
];

const DONE_TEXT: Record<CardAction, string> = {
  keep: 'Kept',
  queue: 'Added to queue',
  enqueue: 'Enqueued',
  cancel: 'Cancelled',
  hide: 'Hidden',
};

const actionLabel = (a: CardAction) =>
  a === 'cancel' ? 'Cancel' : a === 'hide' ? 'Hide' : (RIGHT_ACTIONS.find((r) => r.id === a)?.label ?? a);

/** The description without the server-injected caps block, cut for the card. */
function excerpt(text: string): string {
  const cut = text.split('<!-- tm:')[0].trim();
  return cut.length > 360 ? `${cut.slice(0, 360).trimEnd()}…` : cut;
}

export function DraftTriageStack({
  title,
  drafts,
  right,
  onRight,
  repoName,
  filerOf,
  onOpenTask,
  covered,
  onClose,
}: {
  title: string;
  /** the stack's members, live (oldest first): a decided card leaves through `decided`, not through this list */
  drafts: TriageDraft[];
  right: RightAction;
  onRight: (a: RightAction) => void;
  repoName: (id: string | null) => string;
  filerOf: (t: Task) => Task | null;
  onOpenTask: (id: string) => void;
  /** a task panel is over the page: step aside, come back on the same card */
  covered: boolean;
  onClose: () => void;
}) {
  // A Kept draft is still a member (and a hidden one is with "show hidden"):
  // what was decided here leaves the stack by id, and Skip only moves it back.
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const left = drafts.filter((d) => !decided.has(d.task.id) && !skipped.has(d.task.id));
  const total = drafts.filter((d) => !decided.has(d.task.id)).length;
  const cur = left[0] ?? null;
  const { refresh } = useApp();
  /**
   * The last decision's result, inside the sheet: a global toast would sit
   * over the pinned bar and eat the next tap. Undo only where a server
   * inverse exists (Hide → unhide); Keep/queue/enqueue/cancel have none
   * back to `draft`.
   */
  const [last, setLast] = useState<{ text: string; undo?: () => void } | null>(null);

  if (covered) return null;
  const decide = (id: string) => setDecided((s) => new Set(s).add(id));
  const undecide = (id: string) =>
    setDecided((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });

  return (
    <Sheet
      label={`Draft triage — ${title}`}
      tall
      className="deck-sheet"
      bodyClassName="sheet-body deck-sheet-body"
      onClose={onClose}
      head={(closeSheet) => (
        <div className="deck-sheet-head">
          <span className="deck-sheet-title">
            {title}
            {cur && <span className="deck-pos"> · {total === 1 ? '1 left' : `${total} left`}</span>}
          </span>
          <button type="button" className="btn ghost" aria-label="Close" onClick={closeSheet}>
            <IconX />
          </button>
        </div>
      )}
    >
      <div className="seg triage-right-seg" role="group" aria-label="Swipe right does">
        <span className="triage-right-label">swipe right →</span>
        {RIGHT_ACTIONS.map((a) => (
          <button
            key={a.id}
            type="button"
            aria-pressed={right === a.id}
            className={`btn${right === a.id ? ' primary' : ''}`}
            onClick={() => onRight(a.id)}
          >
            {a.label}
          </button>
        ))}
      </div>
      {last && (
        <div className="triage-last" role="status">
          <span className="triage-last-text">{last.text}</span>
          {last.undo && (
            <button type="button" className="btn ghost" onClick={last.undo}>
              Undo
            </button>
          )}
        </div>
      )}
      {cur ? (
        <DraftCard
          key={cur.task.id}
          draft={cur}
          right={right}
          repoName={repoName}
          filer={filerOf(cur.task)}
          onOpenTask={onOpenTask}
          onDecided={(action) => {
            decide(cur.task.id);
            const t = cur.task;
            setLast({
              text: `${DONE_TEXT[action]} “${t.title}”`,
              // the one decision here with a server inverse back to where it was
              undo:
                action === 'hide'
                  ? () => {
                      setLast(null);
                      api
                        .bulkTasks({ action: 'unhide', ids: [t.id] })
                        .then((r) => {
                          const x = r.results[0];
                          if (x && !x.ok) throw new Error(x.error);
                          undecide(t.id);
                          void refresh();
                        })
                        .catch((e) => toastError(e, 'Unhide'));
                    }
                  : undefined,
            });
          }}
          onSkip={() => setSkipped((s) => new Set(s).add(cur.task.id))}
        />
      ) : (
        <div className="inbox-empty triage-stack-empty">
          {skipped.size > 0 && drafts.some((d) => skipped.has(d.task.id) && !decided.has(d.task.id)) ? (
            <>
              <div>Nothing left but what you skipped.</div>
              <button type="button" className="btn deck-bar-btn" onClick={() => setSkipped(new Set())}>
                Go through the skipped again
              </button>
            </>
          ) : (
            <div>All drafts here are triaged.</div>
          )}
        </div>
      )}
    </Sheet>
  );
}

function DraftCard({
  draft,
  right,
  repoName,
  filer,
  onOpenTask,
  onDecided,
  onSkip,
}: {
  draft: TriageDraft;
  right: RightAction;
  repoName: (id: string | null) => string;
  filer: Task | null;
  onOpenTask: (id: string) => void;
  onDecided: (a: CardAction) => void;
  onSkip: () => void;
}) {
  const { refresh } = useApp();
  const t = draft.task;
  const [busy, setBusy] = useState<CardAction | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const arm = useArm();
  const reduced = useReducedMotion();
  const drag = useDragControls();
  const x = useMotionValue(0);
  const rightHint = useTransform(x, [0, SWIPE_PX], [0, 1]);
  const leftHint = useTransform(x, [-SWIPE_PX, 0], [1, 0]);
  const cardRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);

  /** One bulk call for this id; the card is already on its way out in `dir` (or still, from a button). */
  const run = async (action: CardAction, dir: -1 | 0 | 1) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(action);
    setRefused(null);
    arm.disarm();
    const w = cardRef.current?.offsetWidth ?? 360;
    const fly = dir && !reduced ? animate(x, dir * w * 1.3, { duration: 0.22, ease: 'easeIn' }) : null;
    let error: string | null = null;
    try {
      const r = await api.bulkTasks({ action, ids: [t.id], ...(action === 'cancel' ? { reason: CANCEL_STALE_REASON } : {}) });
      const res = r.results.find((y) => y.id === t.id);
      if (!res) error = 'no result for this draft';
      else if (!res.ok) error = res.error ?? 'refused';
    } catch (e) {
      error = errorText(e) || 'request failed';
    }
    if (error) {
      fly?.stop();
      animate(x, 0, reduced ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 34 });
      setRefused(`${actionLabel(action)}: ${error}`);
      setBusy(null);
      inFlight.current = false;
      return;
    }
    await fly;
    onDecided(action);
    void refresh();
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || inFlight.current || inSideScroller(e.target, cardRef.current)) return;
    startSideSwipe(e, drag);
  };
  const onDragEnd = (_: unknown, info: PanInfo) => {
    const side = swipeSide(info.offset.x, info.velocity.x);
    if (side === 1) void run(right, 1);
    else if (side === -1) void run('cancel', -1);
    else animate(x, 0, { type: 'spring', stiffness: 500, damping: 34 });
  };

  const rightLabel = actionLabel(right);
  const cancelArmed = arm.armed === 'cancel';
  const body = excerpt(t.description ?? '');

  return (
    <>
      <motion.div
        ref={cardRef}
        className="panel deck-card deck-swipe triage-card"
        aria-label={`Draft: ${t.title}`}
        style={{ x }}
        drag="x"
        dragListener={false}
        dragControls={drag}
        dragDirectionLock
        dragMomentum={false}
        onPointerDown={onPointerDown}
        onDragEnd={onDragEnd}
        initial={reduced ? false : { opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
      >
        <motion.span className="triage-swipe-hint triage-swipe-right" style={{ opacity: rightHint }} aria-hidden>
          {rightLabel}
        </motion.span>
        <motion.span className="triage-swipe-hint triage-swipe-left" style={{ opacity: leftHint }} aria-hidden>
          Cancel
        </motion.span>
        <button type="button" className="triage-card-title" title="open the task" onClick={() => onOpenTask(t.id)}>
          {t.title}
        </button>
        <div className="triage-card-meta">
          <span className="inbox-repo">{repoName(t.repoId)}</span>
          <span className="triage-age" title={`filed ${new Date(t.createdAt).toLocaleString()}`}>
            {draft.ageDays}d old
          </span>
          {draft.stale && <span className="chip triage-stale">stale</span>}
          {draft.kept && <span className="chip">kept</span>}
          {t.hiddenAt && <span className="chip">hidden</span>}
        </div>
        <div className="triage-card-filer">
          <span className="label">filed by</span>
          {filer ? (
            <>
              <button type="button" className="triage-filer" onClick={() => onOpenTask(filer.id)}>
                {filer.title}
              </button>
              <StatusBadge
                status={filer.status}
                reviewState={filer.reviewState}
                checkState={filer.checkState}
                loopState={filer.loopState}
                paused={!!filer.pausedTurn}
                explain={false}
              />
            </>
          ) : (
            <span className="muted">{t.createdByRun ? 'a run no longer known' : (t.source ?? 'unknown')}</span>
          )}
        </div>
        {body ? <p className="triage-card-desc">{body}</p> : <p className="triage-card-desc muted">No description.</p>}
        {refused && (
          <div className="triage-refused" role="alert">
            {refused}
          </div>
        )}
      </motion.div>
      <div className="deck-bar">
        <div className="deck-bar-row">
          <button
            type="button"
            className={`btn deck-bar-btn${cancelArmed ? ' danger' : ''}`}
            disabled={busy !== null}
            title={`cancel, recorded as “${CANCEL_STALE_REASON}” (tap twice; a left swipe is one gesture)`}
            onClick={() => {
              if (arm.press('cancel')) void run('cancel', -1);
            }}
          >
            {busy === 'cancel' ? '…' : cancelArmed ? 'Cancel? tap again' : '← Cancel'}
          </button>
          <button type="button" className="btn deck-bar-btn primary" disabled={busy !== null} onClick={() => void run(right, 1)}>
            {busy === right ? '…' : `${rightLabel} →`}
          </button>
        </div>
        <div className="deck-bar-row">
          <button
            type="button"
            className="btn deck-bar-btn"
            disabled={busy !== null || !!t.hiddenAt}
            title={t.hiddenAt ? 'already hidden' : 'hide from the board — Board › Hidden brings it back'}
            onClick={() => void run('hide', 0)}
          >
            {busy === 'hide' ? '…' : 'Hide'}
          </button>
          <button type="button" className="btn deck-bar-btn" disabled={busy !== null} onClick={onSkip}>
            Skip
          </button>
        </div>
      </div>
    </>
  );
}
