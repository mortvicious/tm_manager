import type { Chat, ChatMode, Repo } from '@tm/shared';
import type { TelegramChatConfig } from '../config.ts';
import type { ChatService } from '../chat/service.ts';
import type { Storage } from '../storage/types.ts';
import { escapeHtml, toReply, type Reply, type ReplyLike } from './api.ts';
import { resolveIn, resolveRepo, short } from './ids.ts';
import type { InlineKeyboardMarkup } from './types.ts';

// The phone half of docs/chat.md. Chat mode is a MODE, not a wizard: it
// survives a restart (`telegram.activeChatId` in tm_config), it is left by
// typing /endchat, and while it is on every non-command message is a chat
// message instead of an offer to file a task.
//
// Buttons live in a `c:` namespace of their own, parsed in bot.ts BEFORE the
// stateless action codec — same reason the `w:` and `k:` namespaces are: a
// button that names a chat which has since been deleted must be refused, not
// fall through to a codec whose buttons stay valid forever.

/** Where the active chat is remembered. Empty = not in chat mode. */
const ACTIVE_KEY = 'telegram.activeChatId';

/** Rows a chat listing prints before it says "and N more". */
const LIST_LIMIT = 20;

/** How many recent turns /chat prints when it shows you where you are. */
const RECENT_TURNS = 3;

export type ChatButtonKind = 'use' | 'new' | 'end' | 'stop' | 'del' | 'mode';

export interface ChatButton {
  kind: ChatButtonKind;
  /** a short id (chat or repo), or 'x' for the kinds that take no target */
  id: string;
}

const CHAT_BUTTON_KINDS: ChatButtonKind[] = ['use', 'new', 'end', 'stop', 'del', 'mode'];

export function encodeChatButton(b: ChatButton): string {
  return `c:${b.kind}:${b.id}`;
}

/** `c:<kind>:<id>`. Deliberately as strict as the action codec's regex — an
 *  unparseable payload is refused rather than guessed at. */
export function parseChatData(data: string): ChatButton | null {
  const m = /^c:([a-z]+):([\w-]{1,48})$/.exec(data);
  if (!m) return null;
  const kind = m[1] as ChatButtonKind;
  return CHAT_BUTTON_KINDS.includes(kind) ? { kind, id: m[2] } : null;
}

// ---- mode state ---------------------------------------------------------

export async function activeChatId(storage: Storage): Promise<string | null> {
  const settings = await storage.getSettings();
  return settings[ACTIVE_KEY] || null;
}

/**
 * The active chat, or null. Self-healing: a remembered chat that has since
 * been deleted in the browser clears the setting rather than making every
 * message fail — the two surfaces share one list and either can delete.
 */
export async function activeChat(storage: Storage): Promise<Chat | null> {
  const id = await activeChatId(storage);
  if (!id) return null;
  const chat = await storage.getChat(id);
  if (!chat) {
    await storage.setSetting(ACTIVE_KEY, '');
    return null;
  }
  return chat;
}

export async function setActiveChat(storage: Storage, id: string | null): Promise<void> {
  await storage.setSetting(ACTIVE_KEY, id ?? '');
}

// ---- rendering ----------------------------------------------------------

const MODE_ICON: Record<ChatMode, string> = { read: '👁', write: '✍️' };

export function chatLine(c: Chat, repoName?: string): string {
  const busy = c.status === 'thinking' ? '⏳ ' : c.status === 'error' ? '⚠ ' : '';
  const repo = repoName ? ` · <i>${escapeHtml(repoName)}</i>` : '';
  return `${busy}${MODE_ICON[c.mode]} <code>${short(c.id)}</code> ${escapeHtml(c.title)}${repo}`;
}

function costLine(c: Chat): string {
  const turns = `${c.turns} turn${c.turns === 1 ? '' : 's'}`;
  return c.costUsd > 0 ? `${turns} · $${c.costUsd.toFixed(2)}` : turns;
}

/**
 * A model reply, as Telegram HTML. Everything is escaped FIRST and markup is
 * added afterwards, so no amount of `<script>` in a reply can become a tag —
 * the only characters that survive as HTML are the ones this function writes.
 *
 * Only two constructs are translated, because only two of them are wrong as
 * plain text: fenced blocks and inline code. `**bold**` arriving as literal
 * asterisks is mildly ugly; a diff arriving with its indentation collapsed is
 * unreadable, which is the difference.
 */
export function renderReply(text: string): string {
  const out: string[] = [];
  // Split on fences first, so a stray backtick inside a code block cannot be
  // read as the start of an inline span.
  const parts = text.split(/```/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // Inside a fence. The first line may be a language tag; it is dropped
      // rather than printed, since Telegram has nothing to do with it.
      const body = parts[i].replace(/^[a-zA-Z0-9_+-]*\n/, '');
      out.push(`<pre>${escapeHtml(body.replace(/\n+$/, ''))}</pre>`);
    } else {
      out.push(
        escapeHtml(parts[i]).replace(/`([^`\n]{1,200})`/g, (_m, code: string) => `<code>${code}</code>`),
      );
    }
  }
  // An ODD number of fences means the reply was cut mid-block (the service
  // truncates at 60k). The split above already closed it; nothing to repair.
  return out.join('');
}

/**
 * May the PHONE run a turn in this chat?
 *
 * `telegram.chat.allowWrite` gates the mode SWITCH, but the switch is not the
 * security boundary — the turn is. A chat put into write mode in the browser
 * (which is always allowed, and documented as such) and left there would
 * otherwise be a fully-armed code-execution surface for anyone holding the
 * unlocked handset, which is the exact case `config.ts` names as the reason
 * the flag exists. So this is checked at the send, not only at the switch.
 *
 * Reading such a chat stays allowed: the transcript is not the danger.
 */
export function phoneMaySend(cfg: TelegramChatConfig, chat: Chat): boolean {
  return chat.mode !== 'write' || cfg.allowWrite;
}

export const WRITE_BLOCKED_REPLY = [
  '\u26a0 This chat is in <b>write</b> mode, and write mode is off for the phone — it could edit files and run commands in the repo. <b>Nothing was sent.</b>',
  '',
  'Switch it with <code>/mode read</code>, or set <code>telegram.chat.allowWrite</code> to <code>true</code> in <code>server/data/config.json</code> and restart.',
].join('\n');

// ---- the surface --------------------------------------------------------

export interface ChatDeps {
  storage: Storage;
  chats: ChatService;
  cfg: TelegramChatConfig;
}

const OFF_REPLY =
  '💬 Chat is switched off for this bot — set <code>telegram.chat.enabled</code> in <code>server/data/config.json</code> and restart.';

function repoKeyboard(repos: Repo[]): InlineKeyboardMarkup {
  const rows = repos
    .slice(0, LIST_LIMIT)
    .map((r) => [{ text: r.name, callback_data: encodeChatButton({ kind: 'new', id: short(r.id) }) }]);
  return { inline_keyboard: rows };
}

function chatKeyboard(c: Chat): InlineKeyboardMarkup {
  const row = [{ text: '✕ Leave chat', callback_data: encodeChatButton({ kind: 'end', id: 'x' }) }];
  if (c.status === 'thinking') {
    row.unshift({ text: '⏹ Stop turn', callback_data: encodeChatButton({ kind: 'stop', id: short(c.id) }) });
  }
  return { inline_keyboard: [row] };
}

async function repoName(storage: Storage, repoId: string): Promise<string | undefined> {
  return (await storage.getRepo(repoId))?.name;
}

/** The header every /chat answer shares: where you are, and on what. */
async function chatHeader(storage: Storage, c: Chat): Promise<string> {
  const repo = await repoName(storage, c.repoId);
  const mode = c.mode === 'write' ? '✍️ write — it can edit files and run commands' : '👁 read-only';
  const lines = [
    `💬 <b>${escapeHtml(c.title)}</b>`,
    `<code>${short(c.id)}</code> · <i>${escapeHtml(repo ?? 'repo gone')}</i> · ${escapeHtml(c.model)} · ${mode}`,
    costLine(c),
  ];
  if (c.status === 'thinking') lines.push(`⏳ answering — one turn at a time`);
  if (c.error) lines.push(`⚠ last turn failed: ${escapeHtml(c.error)}`);
  return lines.join('\n');
}

/** Open a chat in `repo` — reusing the newest one there rather than minting a
 *  second: on a phone "chat with the frontend repo" means one conversation. */
export async function openChat(deps: ChatDeps, repo: Repo, actor: string): Promise<Reply> {
  const all = await deps.storage.listChats(repo.id);
  // When the phone may not run write turns, it does not silently land in a
  // write chat either: the newest chat it can actually USE is the one to
  // resume, and if there is none, a fresh (read) chat beats attaching to a
  // conversation whose every message would be refused.
  const existing = deps.cfg.allowWrite ? all[0] : all.find((c) => c.mode !== 'write');
  if (existing) {
    await setActiveChat(deps.storage, existing.id);
    return {
      html: `${await chatHeader(deps.storage, existing)}\n\nResuming this chat. Just type — /endchat leaves.`,
      keyboard: chatKeyboard(existing),
    };
  }
  const created = await deps.chats.create({ repoId: repo.id }, actor);
  if (!created.ok) return { html: `⚠ ${escapeHtml(created.error)}`, ok: false };
  await setActiveChat(deps.storage, created.value.id);
  return {
    html: `${await chatHeader(deps.storage, created.value)}\n\nChat open. Type anything — /endchat leaves, /chats lists them.`,
    keyboard: chatKeyboard(created.value),
  };
}

/**
 * `/chat` — with a repo, open there; with nothing, show where you are, or ask
 * which repo. The one command that both enters the mode and reports it.
 */
export async function chatCommand(deps: ChatDeps, args: string, actor: string): Promise<Reply> {
  if (!deps.cfg.enabled) return { html: OFF_REPLY, ok: false };
  if (args) {
    const found = await resolveRepo(deps.storage, args.split(/\s+/)[0]);
    if (!found.ok) return { html: escapeHtml(found.error), ok: false };
    return openChat(deps, found.value, actor);
  }
  const current = await activeChat(deps.storage);
  if (current) {
    const recent = await deps.storage.listChatMessages(current.id, RECENT_TURNS * 2);
    const tail = recent
      .map((m) => `${m.role === 'user' ? '🗣' : '🤖'} ${escapeHtml((m.error ?? m.text).slice(0, 300))}`)
      .join('\n\n');
    return {
      html: `${await chatHeader(deps.storage, current)}${tail ? `\n\n${tail}` : ''}\n\nStill open — just type.`,
      keyboard: chatKeyboard(current),
    };
  }
  const repos = await deps.storage.listRepos();
  if (repos.length === 0) return { html: 'No repos registered yet — add one in the web UI first.', ok: false };
  if (repos.length === 1) return openChat(deps, repos[0], actor);
  return { html: '💬 Which repo should the chat run in?', keyboard: repoKeyboard(repos) };
}

/** `/chats` — every chat, with a button to switch to each. */
export async function chatsCommand(deps: ChatDeps): Promise<ReplyLike> {
  if (!deps.cfg.enabled) return { html: OFF_REPLY, ok: false };
  const all = await deps.storage.listChats();
  if (all.length === 0) return '💬 No chats yet. /chat opens one.';
  const repos = new Map((await deps.storage.listRepos()).map((r) => [r.id, r.name]));
  const activeId = await activeChatId(deps.storage);
  const shown = all.slice(0, LIST_LIMIT);
  const lines = shown.map((c) => `${c.id === activeId ? '➡️ ' : ''}${chatLine(c, repos.get(c.repoId))}`);
  const more = all.length > shown.length ? `\n\n…and ${all.length - shown.length} more` : '';
  return {
    html: `<b>Chats</b> (${all.length})\n\n${lines.join('\n')}${more}`,
    keyboard: {
      inline_keyboard: shown
        .filter((c) => c.id !== activeId)
        .slice(0, 8)
        .map((c) => [{ text: `💬 ${c.title.slice(0, 40)}`, callback_data: encodeChatButton({ kind: 'use', id: short(c.id) }) }]),
    },
  };
}

/** `/endchat` — leave the mode. Idempotent and says so either way. */
export async function endChatCommand(deps: ChatDeps): Promise<ReplyLike> {
  const current = await activeChat(deps.storage);
  if (!current) return 'Not in a chat. /chat opens one.';
  await setActiveChat(deps.storage, null);
  return `✅ Left <b>${escapeHtml(current.title)}</b>. It is still there — /chats to come back.`;
}

/**
 * `/mode read|write` — the per-chat tool fence, and the one command in the
 * bot that can turn on a code-execution surface. Refused outright unless
 * `telegram.chat.allowWrite` is set in the config file (docs/chat.md
 * § From the phone): the browser can still do it, because the browser is the
 * laptop the config file lives on.
 */
export async function modeCommand(deps: ChatDeps, args: string, actor: string): Promise<ReplyLike> {
  const current = await activeChat(deps.storage);
  if (!current) return { html: 'Not in a chat. /chat opens one.', ok: false };
  const want = args.trim().toLowerCase();
  if (want !== 'read' && want !== 'write') {
    return {
      html: `Usage: <code>/mode read</code> or <code>/mode write</code> — this chat is <b>${current.mode}</b>.`,
      ok: false,
    };
  }
  if (want === 'write' && !deps.cfg.allowWrite) {
    return {
      html:
        '⚠ Write mode is off for the phone. A write-mode chat can edit files and run commands in the repo, so it is turned on once at the keyboard: set <code>telegram.chat.allowWrite</code> to <code>true</code> in <code>server/data/config.json</code> and restart. The web UI can still switch this chat to write.',
      ok: false,
    };
  }
  if (want === current.mode) return `Already <b>${want}</b>.`;
  const res = await deps.chats.edit(current.id, { mode: want }, actor);
  if (!res.ok) return { html: `⚠ ${escapeHtml(res.error)}`, ok: false };
  return want === 'write'
    ? `✍️ <b>Write mode.</b> This chat can now edit files and run commands in <i>${escapeHtml((await repoName(deps.storage, res.value.repoId)) ?? '?')}</i>.`
    : `👁 <b>Read-only.</b> Edit, Write, NotebookEdit and Bash are off for this chat.`;
}

/** A `c:` button press. Returns what to say; the toast is the caller's. */
export async function handleChatButton(
  deps: ChatDeps,
  b: ChatButton,
  actor: string,
): Promise<{ reply: Reply; toast: string }> {
  const refuse = (html: string, toast = 'Failed') => ({ reply: { html, ok: false }, toast });
  if (!deps.cfg.enabled) return refuse(OFF_REPLY, 'Chat is off');

  if (b.kind === 'end') {
    return { reply: toReply(await endChatCommand(deps)), toast: 'Left' };
  }
  if (b.kind === 'new') {
    const repos = await deps.storage.listRepos();
    const found = resolveIn(b.id, repos, 'repo', (r) => r.name);
    if (!found.ok) return refuse(escapeHtml(found.error), 'Gone');
    return { reply: await openChat(deps, found.value, actor), toast: 'Opened' };
  }
  // The remaining kinds all name a chat.
  const all = await deps.storage.listChats();
  const found = resolveIn(b.id, all, 'chat', (c) => c.title);
  if (!found.ok) return refuse(escapeHtml(found.error), 'Gone');
  const chat = found.value;
  if (b.kind === 'use') {
    await setActiveChat(deps.storage, chat.id);
    // Switching to a write chat is allowed — reading it is harmless — but the
    // refusal it will give on the first message is said NOW rather than
    // discovered by typing into it.
    const note = phoneMaySend(deps.cfg, chat)
      ? 'Switched. Just type — /endchat leaves.'
      : `Switched — read only from here. ${WRITE_BLOCKED_REPLY}`;
    return {
      reply: { html: `${await chatHeader(deps.storage, chat)}\n\n${note}`, keyboard: chatKeyboard(chat) },
      toast: 'Switched',
    };
  }
  if (b.kind === 'stop') {
    const stopped = deps.chats.stop(chat.id);
    return stopped
      ? { reply: { html: `⏹ Stopping <b>${escapeHtml(chat.title)}</b>.` }, toast: 'Stopping' }
      : refuse('That turn already finished.', 'Already done');
  }
  if (b.kind === 'del') {
    const res = await deps.chats.remove(chat.id, actor);
    if (!res.ok) return refuse(escapeHtml(res.error), 'Failed');
    if ((await activeChatId(deps.storage)) === chat.id) await setActiveChat(deps.storage, null);
    return { reply: { html: `🗑 Deleted <b>${escapeHtml(chat.title)}</b>.` }, toast: 'Deleted' };
  }
  // 'mode' — toggle, through the same gate /mode goes through.
  const want: ChatMode = chat.mode === 'write' ? 'read' : 'write';
  if (want === 'write' && !deps.cfg.allowWrite) return refuse('Write mode is off for the phone — see /mode.', 'Not allowed');
  const res = await deps.chats.edit(chat.id, { mode: want }, actor);
  if (!res.ok) return refuse(escapeHtml(res.error), 'Failed');
  return { reply: { html: `${MODE_ICON[want]} <b>${escapeHtml(chat.title)}</b> is now <b>${want}</b>.` }, toast: want };
}
