// The office group chat (docs/office.md § Group chat): one transcript per
// chat, every role a participant. A message routes to the role it
// @mentions, else to the Director; each reply is that role's persona,
// read-only. A reply from a tainted role context carries a badge. The
// stakeholder's own message can be sent to the office channel as a trusted
// request (two presses) — a role's reply never can. The transcript lives in
// the app store (`chatMessages`, kept current by `chat.message` frames); the
// chat list is this office's, re-read on `chat.updated|deleted`.
import { useCallback, useEffect, useRef, useState } from 'react';
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
} from '@tm/shared';
import { api } from '../api.ts';
import { useArm } from '../arm.ts';
import { onServerEvent, useApp } from '../state.tsx';
import { toastError } from '../toast.ts';
import { Reply } from '../pages/Chat.tsx';
import { IconSend, IconStop } from './Icons.tsx';

function when(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function errText(e: unknown): string {
  return (e as Error)?.message || String(e);
}

/** This office's chats, newest first, following the chat frames. */
function useOfficeChats(officeId: string): { list: Chat[] | null; error: string | null } {
  const [list, setList] = useState<Chat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setList(null);
    api.listOfficeChats(officeId).then(
      (l) => live && (setList(l), setError(null)),
      (e) => live && setError(errText(e)),
    );
    const off = onServerEvent((e) => {
      if (e.type === 'chat.updated' && e.chat.officeId === officeId) {
        setList((cur) => {
          const rest = (cur ?? []).filter((c) => c.id !== e.chat.id);
          const i = (cur ?? []).findIndex((c) => c.id === e.chat.id);
          if (i === -1) return [e.chat, ...rest];
          const next = (cur ?? []).slice();
          next[i] = e.chat;
          return next;
        });
      } else if (e.type === 'chat.deleted') {
        setList((cur) => (cur ? cur.filter((c) => c.id !== e.chatId) : cur));
      }
    });
    return () => {
      live = false;
      off();
    };
  }, [officeId]);
  return { list, error };
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

function ChatPane({ chat, roles }: { chat: Chat; roles: OfficeRole[] }) {
  const { chatMessages, loadChat } = useApp();
  const messages = chatMessages[chat.id];
  const endRef = useRef<HTMLDivElement | null>(null);
  const { armed, press } = useArm();
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    loadChat(chat.id).catch((e) => toastError(e, 'Could not load the chat'));
  }, [chat.id, loadChat]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages?.length, chat.status]);

  const role = (id: string | null) => (id ? (roles.find((r) => r.id === id) ?? null) : null);
  const label = (id: string | null) => {
    const r = role(id);
    return r ? `${r.avatar} ${r.name}` : 'a deleted role';
  };
  const lastAsk = chat.status === 'thinking' && messages ? [...messages].reverse().find((m) => m.role === 'user') : undefined;
  const answering = lastAsk ? label(lastAsk.roleId) : null;

  const toChannel = async (m: ChatMessage) => {
    if (!press(`ch:${m.id}`)) return;
    setBusy(m.id);
    try {
      await api.sendChatToChannel(chat.id, m.id);
    } catch (e) {
      toastError(e, 'Could not send to the channel');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="office-chat-log">
        {messages === undefined ? (
          <div className="muted">Loading…</div>
        ) : messages.length === 0 ? (
          <div className="muted">Nothing yet. Ask the Director, or @mention a role.</div>
        ) : (
          messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="chat-msg user">
                <div className="chat-meta">
                  you → {label(m.roleId)} · {when(m.createdAt)}
                </div>
                <div className="chat-body">
                  <Reply text={m.text} />
                </div>
                <div className="office-chat-actions">
                  {m.channelMessageId ? (
                    <span className="muted">sent to the channel ✓</span>
                  ) : (
                    <button
                      className={`btn ghost office-chat-send${armed === `ch:${m.id}` ? ' danger' : ''}`}
                      disabled={busy === m.id}
                      title="File this message in the office channel as your request — the Director routes it into work"
                      onClick={() => void toChannel(m)}
                    >
                      {armed === `ch:${m.id}` ? 'Send to channel? tap again' : 'Send to channel'}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div key={m.id} className={`chat-msg assistant${m.taintedAt ? ' office-chat-tainted' : ''}`}>
                <div className="chat-meta">
                  {label(m.roleId)} · {when(m.createdAt)}
                  {m.durationMs ? ` · ${Math.round(m.durationMs / 1000)}s` : ''}
                  {m.costUsd > 0 ? ` · $${m.costUsd.toFixed(2)}` : ''}
                  {m.taintedAt && (
                    <span
                      className="chip office-taint"
                      title="Written from a tainted context (the role reads the web or untrusted notes). Shifts never read this reply, and trusted roles see only that it exists."
                    >
                      tainted
                    </span>
                  )}
                </div>
                <div className={`chat-body${m.error ? ' warn-text' : ''}`}>{m.error ? `⚠ ${m.error}` : <Reply text={m.text} />}</div>
              </div>
            ),
          )
        )}
        {answering && <div className="chat-thinking">{answering} is answering…</div>}
        <div ref={endRef} />
      </div>
      <Composer chat={chat} roles={roles} />
    </>
  );
}

function Composer({ chat, roles }: { chat: Chat; roles: OfficeRole[] }) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  /** the mention start the list was dismissed at (Escape) */
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const director = roles.find((r) => isStandupRole(r) && r.enabled) ?? roles.find((r) => isStandupRole(r)) ?? null;

  const at = mentionAtCaret(text, caret);
  const candidates = at ? mentionCandidates(roles, at.query).slice(0, 8) : [];
  const open = candidates.length > 0 && closedAt !== at?.start;
  const target = text.trim() ? officeChatTarget(text, roles, director) : null;

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
    if (!body) return;
    setSending(true);
    setErr(null);
    try {
      await api.sendChatMessage(chat.id, body);
      setText('');
      setCaret(0);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setSending(false);
    }
  };

  const track = (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length);

  return (
    <div className="office-chat-compose">
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
      {err && <div className="warn-text">{err}</div>}
      <div className="chat-composer">
        <textarea
          ref={ref}
          value={text}
          rows={2}
          placeholder={chat.status === 'thinking' ? 'Waiting for the reply…' : 'Message the office — @ to mention a role'}
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
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {chat.status === 'thinking' ? (
          <button className="btn ghost" title="Stop this turn" onClick={() => void api.stopChat(chat.id).catch(() => {})}>
            <IconStop />
          </button>
        ) : (
          <button
            className="btn"
            disabled={!text.trim() || sending || target?.kind === 'unknown' || target?.kind === 'no-director'}
            onClick={() => void send()}
          >
            <IconSend />
          </button>
        )}
      </div>
    </div>
  );
}
