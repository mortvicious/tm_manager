// The messenger thread's shared pieces (docs/magma.md § 13, docs/office.md §
// Group chat › The thread, § Channel › The thread, § Huddles › The thread):
// the scroll contract (follow the end only when the reader is there, count
// what arrived above, mark read at the bottom), day pills, task-link cards,
// the avatar, the working row and the jump pill. The group chat
// (OfficeChat.tsx), the channel (OfficeChannel.tsx) and huddles
// (OfficeHuddles.tsx) render their own bubbles over these; the pure layer is
// src/officeThread.ts.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { OfficeRole, Task } from '@tm/shared';
import { openTaskFromAnywhere } from '../nav.ts';
import { countNewSinceOf, resolveTaskRefs, taskRefCandidates } from '../officeThread.ts';
import { useAppSelector } from '../state.tsx';
import { roleHueStyle } from './RoleChip.tsx';
import { StatusBadge } from './StatusBadge.tsx';

/** within this many px of the end counts as "at the bottom" */
const AT_BOTTOM_PX = 24;

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** the element that scrolls the thread: the log itself, or (in a phone Sheet) the sheet's scroller */
function scrollParent(el: HTMLElement): HTMLElement {
  for (let p: HTMLElement | null = el; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') return p;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

export function fullTime(iso: string): string {
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * The scroll contract (§ 13 Jump-to-latest): follow new entries only when the
 * reader was already at the bottom; otherwise leave them where they are and
 * count what arrived since. Reaching the bottom with the document visible
 * calls `onSeen` — the caller marks the conversation read in the per-device
 * store (`markRead`, src/officeConversations.ts; advance-only), so one key
 * drives the list's unread badges and the thread.
 *
 * `entries` is undefined while the transcript loads; `thinking` is the
 * working row (it changes the thread's height).
 */
export function useThreadScroll(
  logRef: React.RefObject<HTMLDivElement | null>,
  entries: readonly { id: string; own: boolean }[] | undefined,
  thinking: boolean,
  onSeen: () => void,
) {
  const scrollerRef = useRef<HTMLElement | null>(null);
  const atBottomRef = useRef(true);
  /** force the next layout to the end (the reader just sent a message) */
  const pinRef = useRef(false);
  const [atBottom, setAtBottom] = useState(true);
  const [far, setFar] = useState(false);
  /** the newest entry id in view when the reader left the bottom */
  const [awayFrom, setAwayFrom] = useState<string | null>(null);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const seenRef = useRef(onSeen);
  seenRef.current = onSeen;

  const newest = entries && entries.length ? entries[entries.length - 1] : null;

  const markSeen = useCallback(() => {
    const es = entriesRef.current;
    if (!es || es.length === 0) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    seenRef.current();
  }, []);

  const measure = useCallback(() => {
    const s = scrollerRef.current;
    if (!s) return;
    const gap = s.scrollHeight - s.scrollTop - s.clientHeight;
    const bottom = gap <= AT_BOTTOM_PX;
    if (bottom !== atBottomRef.current) {
      atBottomRef.current = bottom;
      setAtBottom(bottom);
      const es = entriesRef.current;
      setAwayFrom(bottom ? null : es && es.length ? es[es.length - 1].id : null);
      if (bottom) markSeen();
    }
    setFar(gap > s.clientHeight);
  }, [markSeen]);

  // Find the scroller once the log is in the tree, and follow its scrolling.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const s = scrollParent(el);
    scrollerRef.current = s;
    const target: HTMLElement | Window = s === document.scrollingElement ? window : s;
    target.addEventListener('scroll', measure, { passive: true });
    const onVis = () => {
      if (document.visibilityState === 'visible' && atBottomRef.current) markSeen();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      target.removeEventListener('scroll', measure);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [logRef, measure, markSeen, entries === undefined]);

  // New content: stay on the end if the reader was there (or just sent).
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (!scrollerRef.current) scrollerRef.current = scrollParent(el);
    const s = scrollerRef.current;
    if (atBottomRef.current || pinRef.current) {
      pinRef.current = false;
      s.scrollTop = s.scrollHeight;
      if (!atBottomRef.current) {
        atBottomRef.current = true;
        setAtBottom(true);
        setAwayFrom(null);
      }
      setFar(false);
      markSeen();
    } else {
      const gap = s.scrollHeight - s.scrollTop - s.clientHeight;
      setFar(gap > s.clientHeight);
    }
  }, [logRef, newest?.id, entries?.length, thinking, markSeen]);

  const jump = useCallback(() => {
    const s = scrollerRef.current;
    if (!s) return;
    s.scrollTo({ top: s.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, []);

  const pin = useCallback((on: boolean) => {
    pinRef.current = on;
  }, []);

  const fresh = entries ? countNewSinceOf(entries, awayFrom) : 0;
  // The pill: more than a viewport above the end (§ 13), or anywhere above it
  // once something new arrived — a reader one screen up must still learn of it.
  const showPill = !atBottom && (far || fresh > 0);
  return { showPill, fresh, jump, pin };
}

/** The jump-to-latest pill; render it inside a `position: relative` foot (the composer or `.thread-foot`). */
export function JumpPill({ show, fresh, onJump }: { show: boolean; fresh: number; onJump: () => void }) {
  if (!show) return null;
  return (
    <button type="button" className="thread-jump" onClick={onJump} aria-label={fresh > 0 ? `${fresh} new — jump to latest` : 'Jump to latest'}>
      {fresh > 0 ? `${fresh} new ↓` : '↓'}
    </button>
  );
}

export function DayPill({ label }: { label: string }) {
  return (
    <div className="thread-day" role="separator">
      <span>{label}</span>
    </div>
  );
}

/** `tasks` → id map, cached on the array's identity (src/runIndex.ts' pattern) */
const taskIndexCache = new WeakMap<readonly Task[], Map<string, Task>>();
function taskIndex(tasks: readonly Task[]): Map<string, Task> {
  let m = taskIndexCache.get(tasks);
  if (!m) {
    m = new Map(tasks.map((t) => [t.id.toLowerCase(), t]));
    taskIndexCache.set(tasks, m);
  }
  return m;
}

/**
 * Task-link cards (§ 13): only from references that resolve in the store — a
 * full id or `?task=` link, or an id8 naming exactly one task. The card shows
 * the task's own row data, never text from the message. `lead` is a task the
 * server itself names (a channel route's filed task), shown first.
 */
export const TaskLinks = memo(function TaskLinks({ text, lead }: { text: string; lead?: string | null }) {
  const cands = useMemo(() => {
    const c = taskRefCandidates(text);
    const l = lead?.toLowerCase();
    return l ? { full: [l, ...c.full.filter((x) => x !== l)], short: c.short } : c;
  }, [text, lead]);
  const none = cands.full.length === 0 && cands.short.length === 0;
  // A joined string: a stable value, so a task update elsewhere re-renders nothing here.
  const ids = useAppSelector((s) => (none ? '' : resolveTaskRefs(cands, s.tasks).join(' ')));
  if (!ids) return null;
  return (
    <div className="thread-tasks">
      {ids.split(' ').map((id) => (
        <TaskLinkCard key={id} id={id} />
      ))}
    </div>
  );
});

function TaskLinkCard({ id }: { id: string }) {
  const task = useAppSelector((s) => taskIndex(s.tasks).get(id) ?? null);
  const repo = useAppSelector((s) => (task ? (s.repos.find((r) => r.id === task.repoId)?.name ?? null) : null));
  if (!task) return null;
  return (
    <button type="button" className="thread-task" onClick={() => openTaskFromAnywhere(task.id)} title={`Open task ${task.id.slice(0, 8)}`}>
      <span className="thread-task-title">{task.title}</span>
      <span className="thread-task-meta">
        <StatusBadge status={task.status} reviewState={task.reviewState} checkState={task.checkState} loopState={task.loopState} explain={false} />
        {repo && <span className="chip">{repo}</span>}
      </span>
    </button>
  );
}

export function RoleAvatar({ role }: { role: OfficeRole | null }) {
  return (
    <span className="thread-avatar" aria-hidden="true" style={roleHueStyle(role)}>
      {role?.avatar ?? '?'}
    </span>
  );
}

/** "<role> is answering…" at the end of the thread while a turn is due. */
export function WorkingRow({ role, label }: { role: OfficeRole | null; label: string }) {
  return (
    <div className="thread-group other thread-working">
      <RoleAvatar role={role} />
      <div className="thread-stack">
        <div className="thread-bubble thread-working-bubble">
          {label}
          {/* static on purpose (§ 8): never animated, so not in the calm lists */}
          <span className="thread-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
      </div>
    </div>
  );
}

export function sameRole(a: OfficeRole | null, b: OfficeRole | null): boolean {
  return a === b || (!!a && !!b && a.id === b.id && a.name === b.name && a.avatar === b.avatar && a.title === b.title);
}

/** "Name · Title", or the fallback for a role that is gone */
export function roleDisplayName(role: OfficeRole | null): string {
  return role ? `${role.name}${role.title ? ` · ${role.title}` : ''}` : 'a deleted role';
}
