import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion, useDragControls, useReducedMotion, type PanInfo } from 'motion/react';
import { CHECK_BUSY_STATES, REVIEW_BUSY_STATES, publishGateReason, type InboxItem, type Task } from '@tm/shared';
import { api } from '../api.ts';
import { useArm } from '../arm.ts';
import { useActRunner, useInbox, useInboxActs, type InboxAct, type InboxNav } from '../components/Inbox.tsx';
import { useIsMobile } from '../components/Layout.tsx';
import { IconMore, IconX } from '../components/Icons.tsx';
import { ReviewDeckCard, type ReviewItem } from '../components/ReviewDeckCard.tsx';
import { Sheet, SheetAction } from '../components/Sheet.tsx';
import { runTaskAction } from '../pending.ts';
import { markPublishedOffered } from '../publish.ts';
import { useApp } from '../state.tsx';
import { toastInfo } from '../toast.ts';
import { useWorkspace } from '../workspace.ts';
import { SWIPE_PX, SWIPE_VELOCITY, inSideScroller, startSideSwipe } from '../sheetSwipe.ts';
import { ACT_COOLDOWN_MS, keyIsOurs } from './Inbox.tsx';

/**
 * The Review deck (docs/inbox.md § Review deck): the Inbox's settled-review
 * items, one card at a time, decided from the keyboard. Membership and order
 * are `buildInbox`'s (through `useInbox`, so workspace-scoped) — never a
 * second ordering — and every act that the Inbox also offers is the Inbox's
 * own (`useInboxActs`), so its confirms and primary rules are the same.
 * A decided card leaves the list and the cursor stays on the same POSITION.
 * Phone: a swipe card stack in a Sheet (`PhoneDeck`).
 */

type DeckKey = 'p' | 'm' | 'd' | 's' | 'f' | 'r' | 'x' | 'o';

interface DeckAct extends Omit<InboxAct, 'key'> {
  key: DeckKey;
  /** the press only arms it (two-press cancel): no cooldown, nothing runs */
  arming?: boolean;
}

/** What a card's act list reads from the surface that draws it. */
interface DeckUi {
  /** the `useArm` key currently armed */
  armed: string | null;
  press: (key: string) => boolean;
  openFollowUp: () => void;
  again: string;
}

const isReview = (i: InboxItem): i is ReviewItem => i.kind === 'review';

/** The deck's list: the Inbox's own items, filtered — never re-sorted. */
function useReviewItems(all = false): ReviewItem[] {
  const items = useInbox(all);
  return useMemo(() => items.filter(isReview), [items]);
}

/** A round or the checks are busy: "Review now" waits (TaskSlideOver's `reviewBusy`). */
function reviewBusy(t: Task): boolean {
  return (
    (t.reviewState !== null && REVIEW_BUSY_STATES.includes(t.reviewState)) ||
    (t.status === 'review' && t.checkState !== null && CHECK_BUSY_STATES.includes(t.checkState))
  );
}

function useDeckActs(nav: InboxNav) {
  const actsFor = useInboxActs(nav);
  const { refresh } = useApp();
  return useCallback(
    (item: ReviewItem, ui: DeckUi): DeckAct[] => {
      const t = item.task;
      const base = actsFor(item);
      const of = (k: InboxAct['key']) => base.find((a) => a.key === k);
      const out: DeckAct[] = [];
      // the Inbox's `f` (flagged only) is the deck's `s`; its `p` is Mark
      // published when the agent already pushed, which the deck keys `m`
      const findings = of('f');
      if (findings) out.push({ ...findings, key: 's' });
      const publish = of('p');
      const shipped = markPublishedOffered(t);
      const gate = publishGateReason(t);
      if (publish && shipped) {
        out.push({ key: 'p', label: 'Publish', hint: 'already pushed — m', disabled: true, run: () => undefined });
        out.push({ ...publish, key: 'm' });
      } else if (publish) {
        out.push({ ...publish, key: 'p', disabled: publish.disabled || !!gate, hint: gate ?? publish.hint, tone: gate ? undefined : publish.tone });
      }
      const done = of('d');
      if (done) out.push({ ...done, key: 'd' });
      out.push({ key: 'f', label: 'Follow up', hint: 'a message to the same session (Enter sends, Escape closes)', run: ui.openFollowUp });
      const busy = reviewBusy(t);
      out.push({
        key: 'r',
        label: 'Review now',
        hint: busy ? 'a review round or the checks are already running' : 'run the adversarial reviewer over the current diff',
        disabled: busy || !t.repoId,
        // no refresh(): the round's own task.updated broadcasts carry it (see TaskSlideOver)
        run: () => runTaskAction(t, 'review', () => api.reviewNow(t.id)),
      });
      const armKey = `cancel:${t.id}`;
      const armed = ui.armed === armKey;
      out.push({
        key: 'x',
        label: armed ? `Cancel? ${ui.again}` : 'Cancel',
        hint: 'close it as cancelled (asks for a second press)',
        tone: 'danger',
        arming: !armed,
        confirm: () => ui.press(armKey),
        run: () => runTaskAction(t, 'cancel', () => api.taskAction(t.id, 'cancel')).then((r) => (r === undefined ? undefined : refresh())),
      });
      const open = of('o');
      if (open) out.push({ ...open, key: 'o' });
      return out;
    },
    [actsFor, refresh],
  );
}

export function ReviewDeckPage({
  onOpenTask,
  onOpenTerminal,
  covered = false,
}: InboxNav & {
  /** a task panel or terminal is over the page: the phone's sheet steps aside and comes back on the same card */
  covered?: boolean;
}) {
  const mobile = useIsMobile();
  const items = useReviewItems();
  const everywhere = useReviewItems(true);
  const { workspace, setWorkspace, wsHref } = useWorkspace();
  const elsewhere = workspace ? everywhere.length - items.length : 0;
  const nav = useMemo(() => ({ onOpenTask, onOpenTerminal }), [onOpenTask, onOpenTerminal]);
  const [index, setIndex] = useState(0);

  return (
    <div className="inbox-page deck-page">
      <h1 className="page-title">
        Review deck
        {workspace && <span className="inbox-ws">· {workspace.name}</span>}
        <span className="inbox-count">
          {items.length ? (mobile ? `${items.length} to review` : `${index + 1} of ${items.length}`) : 'nothing to review'}
          {elsewhere > 0 && (
            <>
              {' · '}
              <button type="button" className="inbox-elsewhere" title="Switch to All" onClick={() => setWorkspace(null)}>
                {elsewhere} more in other workspaces
              </button>
            </>
          )}
        </span>
        <span style={{ flex: 1 }} />
        <Link className="btn ghost deck-back" to={wsHref('/inbox')}>
          Inbox
        </Link>
      </h1>
      {mobile ? (
        <PhoneDeck items={items} nav={nav} covered={covered} />
      ) : !items.length ? (
        <div className="inbox-empty">
          Nothing to review. <Link to={wsHref('/inbox')}>Back to the Inbox</Link>
        </div>
      ) : (
        <DeskDeck items={items} nav={nav} onIndex={setIndex} />
      )}
    </div>
  );
}

const HELP: [string, string][] = [
  ['j / ↓', 'next card'],
  ['k / ↑', 'previous card'],
  ['p', 'publish (asks first over a flagged review or red checks)'],
  ['m', 'mark published — the agent already pushed'],
  ['d', 'mark done — closes without pushing'],
  ['s', 'send the findings back (flagged only)'],
  ['f', 'follow up — a message to the same session'],
  ['r', 'review now'],
  ['x', 'cancel (press twice)'],
  ['o', 'open the task panel'],
  ['?', 'this help'],
];

function DeskDeck({ items, nav, onIndex }: { items: ReviewItem[]; nav: InboxNav; onIndex: (i: number) => void }) {
  const deckActs = useDeckActs(nav);
  const { busy, run, labelOf } = useActRunner();
  const { armed, press, disarm } = useArm();
  const [selId, setSelId] = useState<string | null>(null);
  const [followFor, setFollowFor] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const lastIndex = useRef(0);
  // The card under the cursor, or — when it just left the list — whatever now sits at its position.
  let index = items.findIndex((i) => i.task.id === selId);
  if (index < 0) index = Math.min(lastIndex.current, items.length - 1);
  const sel = index >= 0 ? items[index] : null;
  lastIndex.current = Math.max(0, index);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (sel && sel.task.id !== selId) setSelId(sel.task.id);
  }, [sel, selId]);
  useEffect(() => onIndex(Math.max(0, index)), [index, onIndex]);
  // a new card starts at its top, with nothing armed and no follow-up open
  useEffect(() => {
    cardRef.current?.scrollIntoView({ block: 'nearest' });
    disarm();
    setFollowFor(null);
  }, [sel?.task.id]);

  const selTaskId = sel?.task.id ?? null;
  const ui: DeckUi = { armed, press, openFollowUp: () => setFollowFor(selTaskId), again: 'press x again' };
  const acts = sel ? deckActs(sel, ui) : [];

  const state = useRef({ items, index, sel, acts, run });
  state.current = { items, index, sel, acts, run };
  useEffect(() => {
    // as DeskList (pages/Inbox.tsx): auto-repeat is ignored and an act's key
    // is dead for ACT_COOLDOWN_MS after it fired, or until the cursor moves,
    // so a double press never decides the card that slid under the cursor
    let cooldown: { key: string; until: number } | null = null;
    const onMove = () => {
      cooldown = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (!keyIsOurs(e)) return;
      const { items, index, sel, acts, run } = state.current;
      if (e.key === '?') {
        e.preventDefault();
        setHelp((h) => !h);
        return;
      }
      if (e.key === 'Escape') {
        setHelp(false);
        return;
      }
      const k = e.key;
      if (k === 'j' || k === 'ArrowDown' || k === 'k' || k === 'ArrowUp') {
        if (!items.length) return;
        e.preventDefault();
        cooldown = null;
        const next = Math.max(0, Math.min(items.length - 1, index + (k === 'j' || k === 'ArrowDown' ? 1 : -1)));
        setSelId(items[next].task.id);
        return;
      }
      if (!sel) return;
      const act = acts.find((a) => a.key === k);
      if (!act) return;
      e.preventDefault();
      if (e.repeat || (cooldown?.key === k && Date.now() < cooldown.until)) return;
      // a disabled act says why instead of doing nothing (the button's title is not seen from the keyboard)
      if (act.disabled) {
        if (act.hint) toastInfo(`deck:${k}`, `${act.label}: ${act.hint}`);
        return;
      }
      if (!act.arming) cooldown = { key: k, until: Date.now() + ACT_COOLDOWN_MS };
      void run(sel.task.id, act);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousemove', onMove);
    };
  }, []);

  if (!sel) return null;
  const go = (d: number) => setSelId(items[Math.max(0, Math.min(items.length - 1, index + d))].task.id);
  return (
    <div className="deck">
      <div className="inbox-keys">
        <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>p</kbd> publish · <kbd>m</kbd> mark published · <kbd>d</kbd> done · <kbd>s</kbd> send
        findings · <kbd>f</kbd> follow up · <kbd>r</kbd> review now · <kbd>x</kbd> cancel · <kbd>o</kbd> open · <kbd>?</kbd> help
      </div>
      <div className="panel deck-card" ref={cardRef} aria-label={`Review ${index + 1} of ${items.length}`}>
        <div className="deck-nav">
          <button type="button" className="btn ghost" disabled={index === 0} onClick={() => go(-1)} title="previous (k)">
            ‹
          </button>
          <span className="deck-pos">
            {index + 1} of {items.length}
          </span>
          <button type="button" className="btn ghost" disabled={index >= items.length - 1} onClick={() => go(1)} title="next (j)">
            ›
          </button>
        </div>
        <DeckActs acts={acts} itemId={sel.task.id} busy={busy} run={run} labelOf={labelOf} />
        {followFor === sel.task.id && <FollowUp task={sel.task} run={run} onClose={() => setFollowFor(null)} />}
        <ReviewDeckCard key={sel.task.id} item={sel} onOpenTerminal={nav.onOpenTerminal} diff />
      </div>
      {help && (
        <div className="panel deck-help" role="dialog" aria-label="Review deck keys">
          <div className="deck-help-head">
            <span className="label">Keys</span>
            <button type="button" className="btn ghost" onClick={() => setHelp(false)}>
              Close <kbd>?</kbd>
            </button>
          </div>
          <dl>
            {HELP.map(([k, what]) => (
              <div key={k}>
                <dt>
                  <kbd>{k}</kbd>
                </dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

type Runner = ReturnType<typeof useActRunner>;

function DeckActs({
  acts,
  itemId,
  busy,
  run,
  labelOf,
  keys = true,
}: {
  acts: DeckAct[];
  itemId: string;
  busy: Runner['busy'];
  run: Runner['run'];
  labelOf: Runner['labelOf'];
  keys?: boolean;
}) {
  return (
    <div className="inbox-acts">
      {acts.map((a) => (
        <button
          key={a.key}
          type="button"
          className={`btn${a.tone === 'primary' ? ' primary' : a.tone === 'danger' ? ' danger' : ''}`}
          disabled={a.disabled || busy !== null}
          title={a.hint}
          onClick={() => void run(itemId, a)}
        >
          {labelOf(itemId, a)}
          {keys && <kbd>{a.key}</kbd>}
        </button>
      ))}
    </div>
  );
}

/** The inline follow-up: Enter sends to the task's own session, Escape closes. */
function FollowUp({ task, run, onClose }: { task: Task; run: Runner['run']; onClose: () => void }) {
  const { refresh } = useApp();
  const [text, setText] = useState('');
  const send = () => {
    const message = text.trim();
    if (!message) return;
    void run(task.id, { key: 'f', label: 'Follow up', run: () => api.followUp(task.id, message).then(() => refresh()) }, onClose);
  };
  return (
    <div className="deck-follow">
      <input
        className="field"
        autoFocus
        value={text}
        placeholder="Follow up in the same session — Enter sends, Escape closes"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <button type="button" className="btn primary" disabled={!text.trim()} onClick={send}>
        Send
      </button>
    </div>
  );
}

/**
 * Phone (docs/inbox.md § Review deck › Phone): the deck is a card stack in a
 * tall `<Sheet>`. A horizontal swipe on the card moves next/prev and never
 * decides anything; the decisions are the big buttons pinned to the bottom of
 * the sheet's own scroller (no nested scroller, so the sheet's drag-from-the-top
 * still works). Closing the sheet goes back to the Inbox.
 *
 * `covered` (a task panel or terminal is open over the page) takes the sheet
 * off the screen without closing it: the cursor lives here, in the page, so
 * closing the panel or terminal brings the sheet back on the same card
 * (docs/mobile.md § Returning from a terminal).
 */
function PhoneDeck({ items, nav, covered }: { items: ReviewItem[]; nav: InboxNav; covered: boolean }) {
  const navigate = useNavigate();
  const { wsHref } = useWorkspace();
  const deckActs = useDeckActs(nav);
  const { busy, run, labelOf } = useActRunner();
  const { armed, press, disarm } = useArm();
  const [selId, setSelId] = useState<string | null>(null);
  const [follow, setFollow] = useState(false);
  const [more, setMore] = useState(false);
  // +1 = the card came in from the right (moved next), -1 from the left
  const [dir, setDir] = useState(0);
  const lastIndex = useRef(0);
  let index = items.findIndex((i) => i.task.id === selId);
  if (index < 0) index = Math.min(lastIndex.current, items.length - 1);
  const sel = index >= 0 ? items[index] : null;
  lastIndex.current = Math.max(0, index);
  const reduced = useReducedMotion();
  const drag = useDragControls();
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (sel && sel.task.id !== selId) setSelId(sel.task.id);
  }, [sel, selId]);
  // a new card starts at the top, with nothing armed and no follow-up or ⋯ open
  useEffect(() => {
    disarm();
    setFollow(false);
    setMore(false);
    cardRef.current?.closest('.react-modal-sheet-content-scroller')?.scrollTo({ top: 0 });
  }, [sel?.task.id]);

  const go = (d: number) => {
    const next = Math.max(0, Math.min(items.length - 1, index + d));
    if (next === index) return;
    setDir(d);
    setSelId(items[next].task.id);
  };

  // the gesture start is shared with the draft triage stack (src/sheetSwipe.ts)
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || items.length < 2 || inSideScroller(e.target, cardRef.current)) return;
    startSideSwipe(e, drag);
  };
  const onDragEnd = (_: unknown, info: PanInfo) => {
    const { x } = info.offset;
    const v = info.velocity.x;
    if (x < -SWIPE_PX || v < -SWIPE_VELOCITY) go(1);
    else if (x > SWIPE_PX || v > SWIPE_VELOCITY) go(-1);
  };

  const close = () => navigate(wsHref('/inbox'));
  if (covered) return null;

  const ui: DeckUi = { armed, press, openFollowUp: () => setFollow(true), again: 'tap again' };
  // the disabled "Publish — already pushed" is the desktop's pointer to `m`; here Mark published stands alone
  const acts = sel
    ? deckActs(sel, ui).filter((a) => !(a.key === 'p' && a.disabled && markPublishedOffered(sel.task)))
    : [];
  // the useInboxActs primary rule: Send findings back (flagged), Publish /
  // Mark published (ready), else Open — whichever it toned primary
  const primary =
    acts.find((a) => a.tone === 'primary' && (a.key === 's' || a.key === 'p' || a.key === 'm' || a.key === 'o')) ??
    acts.find((a) => a.key === 'p' || a.key === 'm') ??
    acts.find((a) => a.key === 'o');
  const doneAct = acts.find((a) => a.key === 'd');
  const followAct = acts.find((a) => a.key === 'f');
  const rest = acts.filter((a) => a !== primary && a !== doneAct && a !== followAct);
  const big = (a: DeckAct | undefined, cls: string) =>
    a && (
      <button
        type="button"
        className={`btn deck-bar-btn ${cls}${a.tone === 'primary' ? ' primary' : ''}`}
        disabled={a.disabled || busy !== null}
        onClick={() => sel && void run(sel.task.id, a)}
      >
        {labelOf(sel?.task.id ?? '', a)}
      </button>
    );

  return (
    <>
      <Sheet
        label="Review deck"
        tall
        className="deck-sheet"
        bodyClassName="sheet-body deck-sheet-body"
        onClose={close}
        head={(closeSheet) => (
          <div className="deck-sheet-head">
            <button type="button" className="btn ghost" aria-label="Previous card" disabled={index <= 0} onClick={() => go(-1)}>
              ‹
            </button>
            <span className="deck-sheet-title">
              {sel ? (
                <>
                  Review <span className="deck-pos">{index + 1} of {items.length}</span>
                </>
              ) : (
                'Review deck'
              )}
            </span>
            <button
              type="button"
              className="btn ghost"
              aria-label="Next card"
              disabled={index >= items.length - 1}
              onClick={() => go(1)}
            >
              ›
            </button>
            <button type="button" className="btn ghost" aria-label="Close" onClick={closeSheet}>
              <IconX />
            </button>
          </div>
        )}
      >
        {!sel ? (
          <div className="inbox-empty">
            Nothing to review. <Link to={wsHref('/inbox')}>Back to the Inbox</Link>
          </div>
        ) : (
          <>
            <motion.div
              key={sel.task.id}
              ref={cardRef}
              className="panel deck-card deck-swipe"
              aria-label={`Review ${index + 1} of ${items.length}`}
              drag="x"
              dragListener={false}
              dragControls={drag}
              dragDirectionLock
              dragSnapToOrigin
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.6}
              onPointerDown={onPointerDown}
              onDragEnd={onDragEnd}
              initial={reduced || !dir ? false : { x: dir * 48, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <ReviewDeckCard item={sel} onOpenTerminal={nav.onOpenTerminal} diff="folded" />
            </motion.div>
            <div className="deck-bar">
              {follow && <FollowUp task={sel.task} run={run} onClose={() => setFollow(false)} />}
              {big(primary, 'deck-bar-primary')}
              <div className="deck-bar-row">
                {big(doneAct, '')}
                {followAct && (
                  <button
                    type="button"
                    className="btn deck-bar-btn"
                    aria-expanded={follow}
                    disabled={busy !== null}
                    onClick={() => setFollow((v) => !v)}
                  >
                    Follow up
                  </button>
                )}
                <button
                  type="button"
                  className="btn deck-bar-btn deck-bar-more"
                  aria-label="More actions"
                  disabled={!rest.length}
                  onClick={() => setMore(true)}
                >
                  <IconMore />
                </button>
              </div>
            </div>
          </>
        )}
      </Sheet>
      {more && sel && (
        <Sheet label={`More — ${sel.task.title}`} title={sel.task.title} onClose={() => setMore(false)} zIndex={36}>
          <div className="inbox-sheet-acts">
            {rest.map((a) => (
              <SheetAction
                key={a.key}
                label={labelOf(sel.task.id, a)}
                hint={a.hint}
                tone={a.tone}
                disabled={a.disabled || busy !== null}
                // the arming press of Cancel keeps the sheet open for the second tap
                onClick={() => void run(sel.task.id, a, () => setMore(false))}
              />
            ))}
          </div>
        </Sheet>
      )}
    </>
  );
}
