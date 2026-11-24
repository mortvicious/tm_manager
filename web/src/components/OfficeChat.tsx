// The office group chat (docs/office.md § Group chat): one transcript per
// chat, every role a participant. A message routes to the role it
// @mentions, else to the Director; each reply is that role's persona,
// read-only. A reply from a tainted role context carries a badge. The
// stakeholder's own message can be sent to the office channel as a trusted
// request (two presses) — a role's reply never can. The transcript lives in
// the app store (`chatMessages`, kept current by `chat.message` frames); the
// chat list is this office's (`useOfficeChats`, kept live from the chat
// frames). `ChatPane` is also the conversation list's thread
// (OfficeConversations.tsx, docs/office.md § Conversation list). The thread
// is a messenger (docs/magma.md § 13): bubbles grouped by sender, day pills,
// task-link cards, a jump-to-latest pill and a docked composer; its pure
// layer is src/officeThread.ts, the read marks src/officeConversations.ts.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  isStandupRole,
  mentionAtCaret,
  mentionCandidates,
  mentionTokenFor,
  officeChatTarget,
  type Chat,
  type ChatMessage,
  type Office,
  type OfficeRole,
  type Task,
} from '@tm/shared';
import { api } from '../api.ts';
import { useArm } from '../arm.ts';
import { useClock } from '../clock.ts';
import { openTaskFromAnywhere } from '../nav.ts';
import { conversationKey, markRead } from '../officeConversations.ts';
import {
  buildThread,
  countNewSince,
  dayKey,
  resolveTaskRefs,
  taskRefCandidates,
  timeLabel,
  type ThreadItem,
} from '../officeThread.ts';
import { useApp, useAppSelector } from '../state.tsx';
import { useOfficeChats } from './officeConversationHooks.ts';
import { toastError } from '../toast.ts';
import { Reply } from '../pages/Chat.tsx';
import { IconSend, IconStop } from './Icons.tsx';
import { useIsMobile } from './Layout.tsx';
import { StatusBadge } from './StatusBadge.tsx';

function errText(e: unknown): string {
  return (e as Error)?.message || String(e);
}

export function OfficeChat({ office, roles, inSheet }: { office: Office; roles: OfficeRole[]; inSheet: boolean }) {
  const { list, error } = useOfficeChats(office.id);
  const [picked, setPicked] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const chat = list?.find((c) => c.id === picked) ?? list?.[0] ?? null;

  const create = async () => {
    setCreating(true);
    try {
      const c = await api.createOfficeChat(office.id);
      setPicked(c.id);
    } catch (e) {
      toastError(e, 'Could not open a chat');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className={`office-chat${inSheet ? ' in-sheet' : ''}`}>
      {!inSheet && <div className="office-section-title">Group chat</div>}
      <div className="office-chat-head">
        {list && list.length > 1 && (
          <select value={chat?.id ?? ''} onChange={(e) => setPicked(e.target.value)} aria-label="Office chat">
            {list.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title} · {new Date(c.lastMessageAt ?? c.createdAt).toLocaleDateString()}
              </option>
            ))}
          </select>
        )}
        <span className="office-hint muted">
          @mention a role to ask them; no mention goes to the Director. Read-only — roles answer, they do not act.
        </span>
        <button className="btn ghost" disabled={creating} onClick={() => void create()}>
          New chat
        </button>
      </div>
      {error && <div className="warn-text office-pad">{error}</div>}
      {list === null && !error ? (
        <div className="muted office-pad">Loading…</div>
      ) : !chat ? (
        <div className="office-pad">
          <button className="btn" disabled={creating} onClick={() => void create()}>
            Start the office chat
          </button>
        </div>
      ) : (
        <ChatPane key={chat.id} chat={chat} roles={roles} />
      )}
    </div>
  );
}

// ---- the messenger thread (docs/magma.md § 13, docs/office.md § Group chat › The thread) ----

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

function fullTime(iso: string): string {
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function turnMeta(m: ChatMessage): string {
  const parts: string[] = [];
  if (m.durationMs) parts.push(`${Math.round(m.durationMs / 1000)}s`);
  if (m.costUsd > 0) parts.push(`$${m.costUsd.toFixed(2)}`);
  return parts.join(' · ');
}

/**
 * The scroll contract (§ 13 Jump-to-latest): follow new messages only when the
 * reader was already at the bottom; otherwise leave them where they are and
 * count what arrived since. Reaching the bottom with the document visible
 * marks the thread read in the conversation list's per-device store
 * (`markRead(conversationKey('chat', id), {count, at})`, src/officeConversations.ts —
 * one key drives the list's unread badges and this thread; advance-only).
 */
function useThreadScroll(
  chatId: string,
  /** the chat row's maintained count (`Chat.messageCount`) — the list counts unread by it */
  messageCount: number,
  logRef: React.RefObject<HTMLDivElement | null>,
  messages: ChatMessage[] | undefined,
  thinking: boolean,
) {
  const scrollerRef = useRef<HTMLElement | null>(null);
  const atBottomRef = useRef(true);
  /** force the next layout to the end (the reader just sent a message) */
  const pinRef = useRef(false);
  const [atBottom, setAtBottom] = useState(true);
  const [far, setFar] = useState(false);
  /** the newest message id in view when the reader left the bottom */
  const [awayFrom, setAwayFrom] = useState<string | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const countRef = useRef(messageCount);
  countRef.current = messageCount;

  const newest = messages && messages.length ? messages[messages.length - 1] : null;

  const markSeen = useCallback(() => {
    const ms = messagesRef.current;
    if (!ms || ms.length === 0) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    // The loaded transcript is the whole chat, so its length is a floor for a
    // count a `chat.updated` frame has not caught up with yet.
    markRead(conversationKey('chat', chatId), { count: Math.max(countRef.current, ms.length), at: ms[ms.length - 1].createdAt });
  }, [chatId]);

  const measure = useCallback(() => {
    const s = scrollerRef.current;
    if (!s) return;
    const gap = s.scrollHeight - s.scrollTop - s.clientHeight;
    const bottom = gap <= AT_BOTTOM_PX;
    if (bottom !== atBottomRef.current) {
      atBottomRef.current = bottom;
      setAtBottom(bottom);
      const ms = messagesRef.current;
      setAwayFrom(bottom ? null : ms && ms.length ? ms[ms.length - 1].id : null);
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
  }, [logRef, measure, markSeen, messages === undefined]);

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
  }, [logRef, newest?.id, messages?.length, thinking, markSeen]);

  const jump = useCallback(() => {
    const s = scrollerRef.current;
    if (!s) return;
    s.scrollTo({ top: s.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, []);

  const pin = useCallback((on: boolean) => {
    pinRef.current = on;
  }, []);

  const fresh = messages ? countNewSince(messages, awayFrom) : 0;
  // The pill: more than a viewport above the end (§ 13), or anywhere above it
  // once something new arrived — a reader one screen up must still learn of it.
  const showPill = !atBottom && (far || fresh > 0);
  return { showPill, fresh, jump, pin };
}

/** `tasks` → id set / id map, cached on the array's identity (src/runIndex.ts' pattern) */
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
 * the task's own row data, never text from the message.
 */
const TaskLinks = memo(function TaskLinks({ text }: { text: string }) {
  const cands = useMemo(() => taskRefCandidates(text), [text]);
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

function RoleAvatar({ role }: { role: OfficeRole | null }) {
  return (
    <span className="thread-avatar" aria-hidden="true">
      {role?.avatar ?? '?'}
    </span>
  );
}

function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.text === b.text &&
      a.error === b.error &&
      a.taintedAt === b.taintedAt &&
      a.channelMessageId === b.channelMessageId &&
      a.costUsd === b.costUsd &&
      a.durationMs === b.durationMs &&
      a.roleId === b.roleId &&
      a.createdAt === b.createdAt)
  );
}

function sameRole(a: OfficeRole | null, b: OfficeRole | null): boolean {
  return a === b || (!!a && !!b && a.id === b.id && a.name === b.name && a.avatar === b.avatar && a.title === b.title);
}

interface GroupProps {
  group: Extract<ThreadItem, { kind: 'group' }>;
  /** the role that wrote a left-side group */
  role: OfficeRole | null;
  /** own groups: who each message went to */
  roleById: (id: string | null) => OfficeRole | null;
  /** the armed `ch:<id>` key when it is one of this group's messages, else null */
  armed: string | null;
  /** the message id whose channel send is in flight when it is in this group */
  busy: string | null;
  onChannel: (m: ChatMessage) => void;
}

/**
 * One sender's run of bubbles. Memoised on the group's messages (id + the
 * fields that can change), its role and its own armed/busy state, so a new
 * message re-renders only the group it joins, not the whole thread.
 */
const ThreadGroup = memo(
  function ThreadGroup({ group, role, roleById, armed, busy, onChannel }: GroupProps) {
    const last = group.messages[group.messages.length - 1];
    const meta = group.own ? '' : turnMeta(last);
    const name = group.own ? 'You' : role ? `${role.name}${role.title ? ` · ${role.title}` : ''}` : 'a deleted role';
    return (
      <div className={`thread-group ${group.own ? 'own' : 'other'}`} role="group" aria-label={`${name}, ${fullTime(group.messages[0].createdAt)}`}>
        {!group.own && <RoleAvatar role={role} />}
        <div className="thread-stack">
          {!group.own && <div className="thread-sender">{name}</div>}
          {group.messages.map((m) => (
            <div key={m.id} className="thread-item">
              <div
                className={`thread-bubble${m.taintedAt ? ' tainted' : ''}${m.error ? ' errored' : ''}`}
                title={fullTime(m.createdAt)}
              >
                <span className="sr-only">{fullTime(m.createdAt)}: </span>
                {m.error ? <span className="muted">The turn failed.</span> : <Reply text={m.text} />}
                {!m.error && <TaskLinks text={m.text} />}
                {m.taintedAt && (
                  <div className="thread-bubble-meta">
                    <span
                      className="chip office-taint"
                      title="Written from a tainted context (the role reads the web or untrusted notes). Shifts never read this reply, and trusted roles see only that it exists."
                    >
                      tainted
                    </span>
                  </div>
                )}
              </div>
              {m.error && <div className="warn-text thread-error">⚠ {m.error}</div>}
              {group.own && (
                <div className="thread-own-meta">
                  <span className="muted">→ {roleById(m.roleId) ? `${roleById(m.roleId)!.avatar} ${roleById(m.roleId)!.name}` : 'a deleted role'}</span>
                  {m.channelMessageId ? (
                    <span className="muted">sent to the channel ✓</span>
                  ) : (
                    <button
                      className={`btn ghost office-chat-send${armed === `ch:${m.id}` ? ' danger' : ''}`}
                      disabled={busy === m.id}
                      title="File this message in the office channel as your request — the Director routes it into work"
                      onClick={() => onChannel(m)}
                    >
                      {armed === `ch:${m.id}` ? 'Send to channel? tap again' : 'Send to channel'}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          <time className="thread-time" dateTime={last.createdAt} title={fullTime(last.createdAt)}>
            {timeLabel(new Date(last.createdAt))}
            {meta && ` · ${meta}`}
          </time>
        </div>
      </div>
    );
  },
  (a, b) =>
    a.group.key === b.group.key &&
    a.group.own === b.group.own &&
    a.group.messages.length === b.group.messages.length &&
    a.group.messages.every((m, i) => sameMessage(m, b.group.messages[i])) &&
    sameRole(a.role, b.role) &&
    a.armed === b.armed &&
    a.busy === b.busy &&
    // own groups read every message's target role through roleById
    (!a.group.own || a.roleById === b.roleById) &&
    a.onChannel === b.onChannel,
);

/** One chat's transcript + composer. `endSlot` renders after the last message (the read sentinel). */
export function ChatPane({ chat, roles, endSlot }: { chat: Chat; roles: OfficeRole[]; endSlot?: ReactNode }) {
  const { chatMessages, loadChat } = useApp();
  const messages = chatMessages[chat.id];
  const logRef = useRef<HTMLDivElement | null>(null);
  const { armed, press } = useArm();
  const pressRef = useRef(press);
  pressRef.current = press;
  const [busy, setBusy] = useState<string | null>(null);
  const thinking = chat.status === 'thinking';
  // day pills read "Today"/"Yesterday": re-derive when the day can turn
  const minute = useClock(60_000);
  const today = dayKey(new Date(minute));

  useEffect(() => {
    loadChat(chat.id).catch((e) => toastError(e, 'Could not load the chat'));
  }, [chat.id, loadChat]);

  const { showPill, fresh, jump, pin } = useThreadScroll(chat.id, chat.messageCount, logRef, messages, thinking);

  // `today` is in the deps on purpose: the labels change when the day turns
  const items = useMemo(() => buildThread(messages ?? [], new Date()), [messages, today]);

  const roleById = useMemo(() => {
    const byId = new Map(roles.map((r) => [r.id, r]));
    return (id: string | null) => (id ? (byId.get(id) ?? null) : null);
  }, [roles]);

  const lastAsk = thinking && messages ? [...messages].reverse().find((m) => m.role === 'user') : undefined;
  const answering = lastAsk ? roleById(lastAsk.roleId) : null;

  const toChannel = useCallback(
    async (m: ChatMessage) => {
      if (!pressRef.current(`ch:${m.id}`)) return;
      setBusy(m.id);
      try {
        await api.sendChatToChannel(chat.id, m.id);
      } catch (e) {
        toastError(e, 'Could not send to the channel');
      } finally {
        setBusy(null);
      }
    },
    [chat.id],
  );
  const onChannel = useCallback((m: ChatMessage) => void toChannel(m), [toChannel]);

  return (
    <>
      <div className="office-chat-log thread-log" ref={logRef} role="log" aria-live="polite" aria-relevant="additions">
        {messages === undefined ? (
          <div className="muted">Loading…</div>
        ) : messages.length === 0 ? (
          <div className="muted">Nothing yet. Ask the Director, or @mention a role.</div>
        ) : (
          items.map((it) =>
            it.kind === 'day' ? (
              <div key={it.key} className="thread-day" role="separator">
                <span>{it.label}</span>
              </div>
            ) : (
              <ThreadGroup
                key={it.key}
                group={it}
                role={it.own ? null : roleById(it.roleId)}
                roleById={roleById}
                armed={armed && it.messages.some((m) => armed === `ch:${m.id}`) ? armed : null}
                busy={busy && it.messages.some((m) => m.id === busy) ? busy : null}
                onChannel={onChannel}
              />
            ),
          )
        )}
        {thinking && (
          <div className="thread-group other thread-working">
            <RoleAvatar role={answering} />
            <div className="thread-stack">
              <div className="thread-bubble thread-working-bubble">
                {answering ? `${answering.name} is answering…` : 'Thinking…'}
                {/* static on purpose (§ 8): never animated, so not in the calm lists */}
                <span className="thread-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            </div>
          </div>
        )}
        {endSlot}
      </div>
      <Composer chat={chat} roles={roles} onSend={pin}>
        {showPill && (
          <button type="button" className="thread-jump" onClick={jump} aria-label={fresh > 0 ? `${fresh} new — jump to latest` : 'Jump to latest'}>
            {fresh > 0 ? `${fresh} new ↓` : '↓'}
          </button>
        )}
      </Composer>
    </>
  );
}

/** the textarea grows with its text, 1–6 lines (§ 13 Composer); max-height in CSS */
function autoGrow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  const cs = getComputedStyle(el);
  const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  el.style.height = `${el.scrollHeight + border}px`;
}

function Composer({
  chat,
  roles,
  onSend,
  children,
}: {
  chat: Chat;
  roles: OfficeRole[];
  /** called as a send starts: the thread pins itself to the end for the reply */
  onSend: (on: boolean) => void;
  /** the jump pill, which floats just above the composer */
  children?: React.ReactNode;
}) {
  const mobile = useIsMobile();
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  /** the mention start the list was dismissed at (Escape) */
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const director = roles.find((r) => isStandupRole(r) && r.enabled) ?? roles.find((r) => isStandupRole(r)) ?? null;
  const thinking = chat.status === 'thinking';

  const at = mentionAtCaret(text, caret);
  const candidates = at ? mentionCandidates(roles, at.query).slice(0, 8) : [];
  const open = candidates.length > 0 && closedAt !== at?.start;
  const target = text.trim() ? officeChatTarget(text, roles, director) : null;
  const blocked = target?.kind === 'unknown' || target?.kind === 'no-director';

  useLayoutEffect(() => autoGrow(ref.current), [text]);

  const pick = useCallback(
    (r: OfficeRole) => {
      if (!at) return;
      const token = `@${mentionTokenFor(r, roles)} `;
      const next = text.slice(0, at.start) + token + text.slice(caret);
      const pos = at.start + token.length;
      setText(next);
      setSel(0);
      requestAnimationFrame(() => {
        const el = ref.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(pos, pos);
        setCaret(pos);
      });
    },
    [at, caret, roles, text],
  );

  const send = async () => {
    const body = text.trim();
    if (!body || sending || thinking || blocked) return;
    setSending(true);
    setErr(null);
    onSend(true);
    try {
      await api.sendChatMessage(chat.id, body);
      setText('');
      setCaret(0);
    } catch (e) {
      onSend(false);
      setErr(errText(e));
    } finally {
      setSending(false);
    }
  };

  const track = (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length);

  return (
    <div className="office-chat-compose thread-compose">
      {children}
      {open && (
        <div className="office-chat-mentions" role="listbox" aria-label="Roles">
          {candidates.map((r, i) => (
            <button
              key={r.id}
              role="option"
              aria-selected={i === sel % candidates.length}
              className={`office-chat-mention${i === sel % candidates.length ? ' active' : ''}`}
              // keep the textarea's focus (and the phone keyboard) on a tap
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(r)}
            >
              <span>
                {r.avatar} {r.name}
              </span>
              <span className="muted">{r.title}</span>
            </button>
          ))}
        </div>
      )}
      {target && (
        <div className="office-hint muted office-chat-target">
          {target.kind === 'role'
            ? `answers: ${target.role.avatar} ${target.role.name}${target.mentioned ? '' : ' (the Director — no @mention)'}`
            : target.kind === 'unknown'
              ? `no role @${target.token} in this office`
              : 'no Director in this office — @mention a role'}
        </div>
      )}
      {err && <div className="warn-text office-chat-target">{err}</div>}
      <div className="chat-composer">
        <textarea
          ref={ref}
          value={text}
          rows={1}
          aria-label="Message the office"
          placeholder={thinking ? 'Waiting for the reply…' : 'Message the office — @ to mention a role'}
          onChange={(e) => {
            setText(e.target.value);
            track(e.target);
            setSel(0);
          }}
          onSelect={(e) => track(e.currentTarget)}
          onKeyDown={(e) => {
            if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setSel((s) => (s + (e.key === 'ArrowDown' ? 1 : candidates.length - 1)) % candidates.length);
              return;
            }
            if (open && (e.key === 'Enter' || e.key === 'Tab')) {
              e.preventDefault();
              pick(candidates[sel % candidates.length]);
              return;
            }
            if (open && e.key === 'Escape') {
              e.preventDefault();
              setClosedAt(at?.start ?? null);
              return;
            }
            // Enter sends, Shift+Enter is a newline; on a phone Return is a
            // newline and the button sends (§ 13). An IME composition's Enter
            // commits the composition, never sends.
            if (e.key === 'Enter' && !e.shiftKey && !mobile && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {thinking ? (
          <button className="btn ghost thread-send" title="Stop this turn" aria-label="Stop this turn" onClick={() => void api.stopChat(chat.id).catch(() => {})}>
            <IconStop />
          </button>
        ) : (
          <button className="btn thread-send" aria-label="Send" disabled={!text.trim() || sending || blocked} onClick={() => void send()}>
            <IconSend />
          </button>
        )}
      </div>
    </div>
  );
}
