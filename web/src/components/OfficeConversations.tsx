// The office conversation list (docs/office.md § Conversation list): ONE list
// of the office's channel, group chats and huddles, newest activity first —
// avatars, title, last-message preview, relative time, unread count and a
// working marker — beside the selected conversation's thread. The threads
// are the existing views (ChatPane, OfficeChannel, HuddleRow) with their own
// composers; the messenger thread, the phone push navigation and per-design
// styling are later cards (docs/magma.md § 13). Everything here is computed
// by the pure `buildConversations` over data the Office already follows; the
// read markers are per device (`tm.office.read`) and advance when the
// thread's end is on screen in a visible tab (`ReadSentinel` → `markRead`).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Office, OfficeRole } from '@tm/shared';
import { api } from '../api.ts';
import {
  buildConversations,
  conversationKey,
  formatUnread,
  markRead,
  writeBaseline,
  type Conversation,
  type ReadMarker,
} from '../officeConversations.ts';
import { toastError } from '../toast.ts';
import { ChatPane } from './OfficeChat.tsx';
import { OfficeChannel, useChannel } from './OfficeChannel.tsx';
import { HuddleRow, OpenForm, useHuddles } from './OfficeHuddles.tsx';
import { useOfficeChats, useReadMap } from './officeConversationHooks.ts';
import { RoleAvatars } from './RoleChip.tsx';
import { fmtAgo, useNow } from './TimeAgo.tsx';

const NEW_HUDDLE = 'new-huddle';

const FALLBACK_GLYPH: Record<Conversation['kind'], string> = { channel: '#', chat: '💬', huddle: '⧉' };

const EMPTY_PREVIEW: Record<Conversation['kind'], string> = {
  channel: 'No messages yet',
  chat: 'Nothing yet — ask the Director',
  huddle: 'Nothing said yet',
};

/** Whether `el` is inside the window and every scrolling ancestor's box. */
function onScreen(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight) return false;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy !== 'auto' && oy !== 'scroll' && oy !== 'hidden') continue;
    const b = p.getBoundingClientRect();
    // a 2px slack: a sentinel flush with the bottom edge counts as seen
    if (r.top > b.bottom + 2 || r.bottom < b.top - 2) return false;
  }
  return true;
}

/**
 * The end of a thread. While it is on screen in a visible tab, `onSeen`
 * runs — on entering view, on the tab becoming visible, and whenever
 * `version` (the thread's newest message) changes, measured a frame later so
 * a message that pushed the end out of view is not marked read.
 */
function ReadSentinel({ onSeen, version }: { onSeen: () => void; version: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const seen = useRef(onSeen);
  seen.current = onSeen;
  const check = () => {
    const el = ref.current;
    if (el && document.visibilityState === 'visible' && onScreen(el)) seen.current();
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) check();
    });
    io.observe(el);
    document.addEventListener('visibilitychange', check);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
  useEffect(() => {
    const raf = requestAnimationFrame(check);
    return () => cancelAnimationFrame(raf);
  }, [version]);
  return <div ref={ref} className="office-conv-sentinel" aria-hidden="true" />;
}

function Row({ row, roles, active, now, onPick }: { row: Conversation; roles: OfficeRole[]; active: boolean; now: number; onPick: () => void }) {
  const badge = formatUnread(row.unread);
  const t = row.lastAt ? Date.parse(row.lastAt) : NaN;
  return (
    <li>
      <button className={`office-conv-row${active ? ' active' : ''}`} aria-current={active ? 'true' : undefined} onClick={onPick}>
        <RoleAvatars roleIds={row.roleIds} roles={roles} fallback={FALLBACK_GLYPH[row.kind]} />
        <span className="office-conv-main">
          <span className="office-conv-top">
            <span className="office-conv-title">{row.title}</span>
            {Number.isFinite(t) && (
              <time className="office-conv-time" dateTime={row.lastAt!} title={new Date(t).toLocaleString()}>
                {fmtAgo(now - t)}
              </time>
            )}
          </span>
          <span className="office-conv-bottom">
            <span className={`office-conv-preview${row.preview?.tainted ? ' tainted' : ''}`}>
              {row.preview ? (
                <>
                  <span className="office-conv-sender">{row.preview.sender}:</span> {row.preview.text}
                </>
              ) : (
                EMPTY_PREVIEW[row.kind]
              )}
            </span>
            {row.working && (
              <span className="office-conv-working" title="answering now">
                <span className="sr-only">working</span>
              </span>
            )}
            {badge && (
              <span className="office-conv-unread" aria-label={`${row.unread} unread`}>
                {badge}
              </span>
            )}
          </span>
          {(row.detail || row.preview?.tainted) && (
            <span className="office-conv-detail">
              {row.detail}
              {row.preview?.tainted && <span className="chip office-taint">untrusted</span>}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

export function OfficeConversations({ office, roles, onOpenTask }: { office: Office; roles: OfficeRole[]; onOpenTask: (id: string) => void }) {
  const now = useNow();
  const chats = useOfficeChats(office.id);
  const channel = useChannel(office.id);
  const huddles = useHuddles(office.id);
  const read = useReadMap();
  const [picked, setPicked] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const rows = useMemo(
    () =>
      buildConversations({
        officeId: office.id,
        chats: chats.list,
        channel: channel.channel,
        huddles: huddles.huddles,
        roles,
        read: read ?? {},
      }),
    [office.id, chats.list, channel.channel, huddles.huddles, roles, read],
  );
  const loaded = chats.list !== null && channel.channel !== null && huddles.huddles !== null;
  // a fresh device starts with everything it can see read (written once all three are in)
  useEffect(() => {
    if (read === null && loaded) writeBaseline(rows);
  }, [read, loaded, rows]);
  const shown = read === null ? rows.map((r) => ({ ...r, unread: 0 })) : rows;

  // Nothing is open until a row is picked: opening a thread marks it read, so
  // a default pick would clear an unread count nobody looked at.
  const selected = picked === NEW_HUDDLE || picked === null ? null : (shown.find((r) => r.key === picked) ?? null);

  const create = async () => {
    setCreating(true);
    try {
      const c = await api.createOfficeChat(office.id);
      setPicked(conversationKey('chat', c.id));
    } catch (e) {
      toastError(e, 'Could not open a chat');
    } finally {
      setCreating(false);
    }
  };

  const sentinel = (row: Conversation) => {
    const mark: ReadMarker = row.readMark;
    return <ReadSentinel key={row.key} version={`${mark.count}|${mark.at}`} onSeen={() => markRead(row.key, mark)} />;
  };

  const thread = () => {
    if (picked === NEW_HUDDLE) {
      return (
        <OpenForm
          office={office}
          roles={roles}
          onOpened={() => {
            huddles.reload();
            setPicked(null);
          }}
        />
      );
    }
    if (!selected) {
      return (
        <div className="muted office-pad">
          {picked === null ? 'Pick a conversation — the channel, a group chat or a huddle.' : 'This conversation is gone.'}
        </div>
      );
    }
    if (selected.kind === 'channel') {
      return <OfficeChannel office={office} roles={roles} inSheet onOpenTask={onOpenTask} source={channel} endSlot={sentinel(selected)} />;
    }
    if (selected.kind === 'chat') {
      const c = chats.list?.find((x) => x.id === selected.id);
      if (!c) return null;
      return (
        <div className="office-chat">
          <div className="office-chat-head">
            <span className="office-hint muted">
              @mention a role to ask them; no mention goes to the Director. Read-only — roles answer, they do not act.
            </span>
          </div>
          <ChatPane key={c.id} chat={c} roles={roles} endSlot={sentinel(selected)} />
        </div>
      );
    }
    const h = huddles.huddles?.find((x) => x.id === selected.id);
    if (!h) return null;
    return (
      <div className="office-huddles">
        <HuddleRow key={h.id} office={office} huddle={h} roles={roles} now={now} onOpenTask={onOpenTask} onChanged={huddles.reload} defaultOpen />
        {sentinel(selected)}
      </div>
    );
  };

  const errors = [chats.error, channel.error, huddles.error].filter(Boolean);
  return (
    <div className="office-conv">
      <div className="office-section-title office-conv-title-bar">
        <span>
          Conversations <span className="muted">{rows.length}</span>
        </span>
        <span className="office-conv-actions">
          <button className="btn ghost" disabled={creating} onClick={() => void create()}>
            New chat
          </button>
          <button className={`btn ghost${picked === NEW_HUDDLE ? ' active' : ''}`} onClick={() => setPicked(NEW_HUDDLE)}>
            Open a huddle
          </button>
        </span>
      </div>
      {errors.length > 0 && <div className="warn-text office-pad">{errors.join(' · ')}</div>}
      <div className="office-conv-body">
        <ul className="office-conv-list" aria-label="Office conversations">
          {shown.map((r) => (
            <Row key={r.key} row={r} roles={roles} active={picked !== NEW_HUDDLE && selected?.key === r.key} now={now} onPick={() => setPicked(r.key)} />
          ))}
        </ul>
        <div className="office-conv-thread">
          {selected && picked !== NEW_HUDDLE && (
            <div className="office-conv-thread-head">
              <RoleAvatars roleIds={selected.roleIds} roles={roles} fallback={FALLBACK_GLYPH[selected.kind]} />
              <span className="office-conv-title">{selected.title}</span>
              {selected.detail && <span className="muted">{selected.detail}</span>}
            </div>
          )}
          {thread()}
        </div>
      </div>
    </div>
  );
}
