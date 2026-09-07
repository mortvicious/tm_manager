import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CHAT_MODES, MODEL_OPTIONS, type Chat, type ChatMessage, type ChatMode } from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { IconChat, IconSend, IconStop, IconX } from '../components/Icons.tsx';

// docs/chat.md — the browser half. The same chats the phone sees, over the
// same REST surface, kept live by the `chat.*` frames on /ws/events. It is a
// transcript and not a terminal on purpose: a chat turn is a headless
// `claude -p --resume` run, so there is no PTY to attach to and nothing that
// would render usefully on a phone if there were.

function when(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * A reply, as blocks. Fenced code keeps its whitespace (a diff with collapsed
 * indentation is unreadable); everything else is plain text with its line
 * breaks preserved. Deliberately NOT a markdown renderer: no HTML is ever
 * constructed from model output, so there is nothing here to inject into.
 */
function Reply({ text }: { text: string }) {
  const blocks = useMemo(() => text.split(/```/), [text]);
  return (
    <>
      {blocks.map((b, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="chat-code">
            {b.replace(/^[a-zA-Z0-9_+-]*\n/, '').replace(/\n+$/, '')}
          </pre>
        ) : (
          b && (
            <span key={i} className="chat-text">
              {b}
            </span>
          )
        ),
      )}
    </>
  );
}

function Bubble({ m }: { m: ChatMessage }) {
  if (m.error) {
    return (
      <div className="chat-msg assistant">
        <div className="chat-meta">claude · {when(m.createdAt)}</div>
        <div className="chat-body warn-text">⚠ {m.error}</div>
      </div>
    );
  }
  return (
    <div className={`chat-msg ${m.role}`}>
      <div className="chat-meta">
        {m.role === 'user' ? (m.actor === 'telegram' ? 'you · telegram' : 'you') : 'claude'} · {when(m.createdAt)}
        {m.durationMs ? ` · ${Math.round(m.durationMs / 1000)}s` : ''}
        {m.costUsd > 0 ? ` · $${m.costUsd.toFixed(2)}` : ''}
      </div>
      <div className="chat-body">
        <Reply text={m.text} />
      </div>
    </div>
  );
}

function NewChat({ onCreated }: { onCreated: (c: Chat) => void }) {
  const { repos, settings } = useApp();
  const [repoId, setRepoId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    if (!repoId) return;
    setBusy(true);
    setErr(null);
    try {
      onCreated(await api.createChat({ repoId, model: settings?.['chat.model'] }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel chat-new">
      <div className="section-head">New chat</div>
      {repos.length === 0 ? (
        <div className="empty">Register a repo first — a chat runs in one.</div>
      ) : (
        <div className="chat-new-row">
          <select value={repoId} onChange={(e) => setRepoId(e.target.value)}>
            <option value="">Pick a repo…</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button className="btn" disabled={!repoId || busy} onClick={() => void create()}>
            Open
          </button>
        </div>
      )}
      {err && <div className="warn-text">{err}</div>}
    </div>
  );
}

export function ChatPage() {
  const { chats, chatMessages, loadChat, repos } = useApp();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  const chat = chats.find((c) => c.id === id) ?? null;
  const messages = id ? chatMessages[id] : undefined;
  const repoName = (repoId: string) => repos.find((r) => r.id === repoId)?.name ?? '(repo gone)';

  // Load on open, and again whenever the selected chat changes.
  useEffect(() => {
    if (!id) return;
    loadChat(id).catch((e) => setErr((e as Error).message));
  }, [id, loadChat]);

  // Follow the tail. `messages?.length` rather than the array: a new object
  // identity from an unrelated state update must not yank the scroll.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages?.length, chat?.status]);

  const send = useCallback(async () => {
    const body = text.trim();
    if (!body || !id) return;
    setSending(true);
    setErr(null);
    try {
      await api.sendChatMessage(id, body);
      setText('');
      // The 202 carries the stored user message, but the broadcast delivers
      // it too — and the broadcast is the one path both surfaces share, so
      // this side just waits for it rather than keeping a second copy.
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSending(false);
    }
  }, [id, text]);

  const remove = async () => {
    if (!chat || !confirm(`Delete “${chat.title}” and its transcript?`)) return;
    try {
      await api.deleteChat(chat.id);
      navigate('/chat');
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const setMode = async (mode: ChatMode) => {
    if (!chat) return;
    try {
      await api.updateChat(chat.id, { mode });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const setModel = async (model: string) => {
    if (!chat) return;
    try {
      await api.updateChat(chat.id, { model });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="chat-page">
      <div className="chat-list">
        <h1 className="page-title">
          <IconChat /> Chat
        </h1>
        <NewChat onCreated={(c) => navigate(`/chat/${c.id}`)} />
        <div className="section-head">
          Conversations <span className="count">{chats.length}</span>
        </div>
        {chats.length === 0 ? (
          <div className="empty panel">No chats yet.</div>
        ) : (
          <div className="panel chat-index">
            {chats.map((c) => (
              <button
                key={c.id}
                className={`chat-index-row ${c.id === id ? 'active' : ''}`}
                onClick={() => navigate(`/chat/${c.id}`)}
              >
                <span className="chat-index-title">{c.title}</span>
                <span className="chat-index-meta">
                  {repoName(c.repoId)}
                  {c.status === 'thinking' ? ' · thinking…' : c.status === 'error' ? ' · failed' : ''}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="chat-pane panel">
        {!chat ? (
          <div className="empty">
            {id ? 'That chat is gone.' : 'Pick a conversation, or open a new one.'}
          </div>
        ) : (
          <>
            <div className="chat-head">
              <div>
                <div className="chat-title">{chat.title}</div>
                <div className="chat-sub">
                  {repoName(chat.repoId)} · {chat.turns} turn{chat.turns === 1 ? '' : 's'}
                  {chat.costUsd > 0 ? ` · $${chat.costUsd.toFixed(2)}` : ''}
                </div>
              </div>
              <div className="chat-head-actions">
                <select
                  value={chat.model}
                  disabled={chat.status === 'thinking'}
                  onChange={(e) => void setModel(e.target.value)}
                >
                  {MODEL_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <select
                  value={chat.mode}
                  disabled={chat.status === 'thinking'}
                  onChange={(e) => void setMode(e.target.value as ChatMode)}
                  title="read-only cannot edit files or run commands"
                >
                  {CHAT_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m === 'read' ? 'read-only' : 'write'}
                    </option>
                  ))}
                </select>
                {chat.status === 'thinking' && (
                  <button className="btn ghost" onClick={() => void api.stopChat(chat.id).catch(() => {})}>
                    <IconStop /> Stop
                  </button>
                )}
                <button className="btn ghost" onClick={() => void remove()} title="Delete this chat">
                  <IconX />
                </button>
              </div>
            </div>

            {chat.mode === 'write' && (
              <div className="chat-mode-note">
                ✍️ Write mode — this chat runs with permissions skipped: it can edit files and run commands in{' '}
                {repoName(chat.repoId)}.
              </div>
            )}

            <div className="chat-log">
              {messages === undefined ? (
                <div className="empty">Loading…</div>
              ) : messages.length === 0 ? (
                <div className="empty">Nothing yet. Say something.</div>
              ) : (
                messages.map((m) => <Bubble key={m.id} m={m} />)
              )}
              {chat.status === 'thinking' && <div className="chat-thinking">claude is thinking…</div>}
              <div ref={endRef} />
            </div>

            {err && <div className="warn-text">{err}</div>}

            <div className="chat-composer">
              <textarea
                value={text}
                rows={2}
                placeholder={chat.status === 'thinking' ? 'Waiting for the reply…' : 'Message claude…'}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends, Shift+Enter is a newline — the convention
                  // every chat window on this phone already uses.
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <button
                className="btn"
                disabled={!text.trim() || sending || chat.status === 'thinking'}
                onClick={() => void send()}
              >
                <IconSend />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
