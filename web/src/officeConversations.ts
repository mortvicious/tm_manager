// The office conversation list (docs/office.md § Conversation list): the pure
// half, DOM-free so `npm test` runs it under node. One list per office — the
// channel, the group chats and the huddles — sorted by last activity, each
// row with a preview, an unread count and a working marker, all computed
// from data the Office already holds (no new route, no polling):
//
// - group chats: `Chat.lastMessage` / `Chat.messageCount` (migration 67,
//   maintained on tm_chats), kept live by `chat.message` (applyChatMessage)
//   and `chat.updated` (mergeChatUpdate — a row read before a message landed
//   never erases the preview or rewinds the counter);
// - the channel: `OfficeChannelResponse.messages` (oldest first);
// - huddles: each `OfficeHuddleView`'s own transcript.
//
// Unread is per DEVICE (no server state): one localStorage key,
// `tm.office.read`, maps a conversation key to the read marker `{count, at}`.
// A group chat's unread is `messageCount − count` (≥ 0); the channel's and a
// huddle's are the messages newer than `at`. The marker advances (never
// rewinds) through `markRead`, called by the thread when it is read.

import {
  chatPreviewText,
  huddleNextRoleId,
  splitOfficeMessage,
  type Chat,
  type ChatMessage,
  type OfficeChannelResponse,
  type OfficeHuddleView,
  type OfficeRole,
} from '@tm/shared';

export const OFFICE_READ_KEY = 'tm.office.read';
/**
 * Set once this device's baseline is written (`writeBaseline`). A store that a
 * thread's `markRead` created first (the phone opens one sheet before any list
 * loaded) holds only that key; until the baseline lands, unread is not shown.
 */
export const OFFICE_READ_BASELINE_KEY = 'tm.office.read.baseline';
/** At most this many markers are kept; the stalest (by `at`) go first. */
export const OFFICE_READ_MAX = 300;
/** An unread count above this reads `99+`. */
export const UNREAD_CAP = 99;

export type ConversationKind = 'channel' | 'chat' | 'huddle';

/** What a device has read of one conversation. */
export interface ReadMarker {
  /** messages read (group chats count) */
  count: number;
  /** the newest message read (channel and huddles compare times); '' = none */
  at: string;
}
export type ReadMap = Record<string, ReadMarker>;

export interface ConversationPreview {
  /** "You", a role's name, "claude", "server" */
  sender: string;
  text: string;
  /** the text came from an untrusted (tainted) writer */
  tainted: boolean;
}

export interface Conversation {
  key: string;
  kind: ConversationKind;
  /** chat id, huddle id, or the office id for the channel */
  id: string;
  title: string;
  /** whose avatars the row shows (≤ 3) */
  roleIds: string[];
  preview: ConversationPreview | null;
  /** the last activity — the sort key; null = nothing yet */
  lastAt: string | null;
  unread: number;
  /** a turn is running right now (a chat answering, a huddle with a turn owed) */
  working: boolean;
  /** "3 unrouted", "turn 2/4 · open" */
  detail: string | null;
  /** the marker `markRead` writes once this conversation has been read */
  readMark: ReadMarker;
}

export function conversationKey(kind: ConversationKind, id: string): string {
  return `${kind}:${id}`;
}

type RoleLike = Pick<OfficeRole, 'id' | 'name'>;

function roleName(roles: readonly RoleLike[], id: string | null): string | null {
  if (!id) return null;
  return roles.find((r) => r.id === id)?.name ?? 'a deleted role';
}

const later = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : a >= b ? a : b);

// ---- unread maths ----

/** A group chat's unread: messages beyond those read, never negative. */
export function chatUnread(messageCount: number, marker: ReadMarker | undefined): number {
  return Math.max(0, messageCount - (marker?.count ?? 0));
}

/** The channel's / a huddle's unread: messages newer than the newest read. */
export function timeUnread(times: readonly string[], marker: ReadMarker | undefined): number {
  const at = marker?.at ?? '';
  let n = 0;
  for (const t of times) if (t > at) n++;
  return n;
}

/** The badge text: hidden (null) at 0, capped at `99+`. */
export function formatUnread(n: number): string | null {
  if (!(n > 0)) return null;
  return n > UNREAD_CAP ? `${UNREAD_CAP}+` : String(n);
}

// ---- live chat rows ----

/**
 * A `chat.message` frame applied to the chat row it belongs to: the counter
 * and the preview move. A message no newer than the row's `lastMessageAt` is
 * already counted (the list was read after it landed — both are written with
 * the same timestamp), so it is ignored rather than counted twice.
 */
export function applyChatMessage(chat: Chat, m: ChatMessage): Chat {
  if (m.chatId !== chat.id) return chat;
  if (chat.lastMessageAt && m.createdAt <= chat.lastMessageAt) return chat;
  return {
    ...chat,
    lastMessageAt: m.createdAt,
    messageCount: (chat.messageCount ?? 0) + 1,
    lastMessage: {
      text: chatPreviewText(m.text === '' && m.error ? `⚠ ${m.error}` : m.text),
      role: m.role,
      actor: m.actor,
      roleId: m.roleId,
    },
  };
}

/**
 * A `chat.updated` frame merged over the local row. The incoming row wins
 * (status, title, …), except that a row WITHOUT the preview fields (an older
 * server) or with a LOWER `messageCount` than the local one (read before a
 * message the client already applied) keeps the local preview, counter and
 * `lastMessageAt` — a chat.updated after a reply must never clear the preview
 * or rewind the unread maths.
 */
export function mergeChatUpdate(local: Chat | undefined, incoming: Chat): Chat {
  if (!local) return incoming;
  const lacks = incoming.lastMessage === undefined || typeof incoming.messageCount !== 'number';
  if (lacks || incoming.messageCount < (local.messageCount ?? 0)) {
    return {
      ...incoming,
      lastMessage: local.lastMessage ?? null,
      messageCount: local.messageCount ?? 0,
      lastMessageAt: later(local.lastMessageAt, incoming.lastMessageAt),
    };
  }
  return incoming;
}

/** Upsert a merged row into an office's chat list (a new chat goes first). */
export function upsertChat(list: readonly Chat[], incoming: Chat): Chat[] {
  const i = list.findIndex((c) => c.id === incoming.id);
  if (i === -1) return [incoming, ...list];
  const next = list.slice();
  next[i] = mergeChatUpdate(list[i], incoming);
  return next;
}

// ---- read marks ----

/** The channel's read mark: its message count and newest message (the thread and the list agree on it). */
export function channelReadMark(channel: Pick<OfficeChannelResponse, 'messages'> | null): ReadMarker {
  const msgs = channel?.messages ?? [];
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  return { count: msgs.length, at: last?.createdAt ?? '' };
}

/** A huddle's read mark: its transcript length and newest line. */
export function huddleReadMark(h: Pick<OfficeHuddleView, 'entries'>): ReadMarker {
  const last = h.entries.length ? h.entries[h.entries.length - 1] : null;
  return { count: h.entries.length, at: last?.at ?? '' };
}

// ---- rows ----

function chatRow(c: Chat, roles: readonly RoleLike[], read: ReadMap): Conversation {
  const key = conversationKey('chat', c.id);
  const lm = c.lastMessage ?? null;
  const count = c.messageCount ?? 0;
  const lastAt = c.lastMessageAt ?? c.createdAt;
  return {
    key,
    kind: 'chat',
    id: c.id,
    title: c.title,
    roleIds: c.participants.slice(0, 3),
    preview: lm
      ? {
          sender: lm.role === 'user' ? 'You' : (roleName(roles, lm.roleId) ?? 'claude'),
          text: chatPreviewText(lm.text),
          tainted: false,
        }
      : null,
    lastAt,
    unread: chatUnread(count, read[key]),
    working: c.status === 'thinking',
    detail: null,
    readMark: { count, at: c.lastMessageAt ?? '' },
  };
}

function channelRow(officeId: string, channel: OfficeChannelResponse | null, roles: readonly RoleLike[], read: ReadMap): Conversation {
  const key = conversationKey('channel', officeId);
  const msgs = channel?.messages ?? [];
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  const unrouted = msgs.filter((m) => !m.routedAt).length;
  const writers: string[] = [];
  for (let i = msgs.length - 1; i >= 0 && writers.length < 3; i--) {
    const w = msgs[i].fromRoleId;
    if (w && !writers.includes(w)) writers.push(w);
  }
  let preview: ConversationPreview | null = null;
  if (last) {
    const { subject, body } = splitOfficeMessage(last.body);
    preview = {
      sender: last.fromRoleId ? (roleName(roles, last.fromRoleId) ?? 'a deleted role') : 'You',
      text: chatPreviewText(body ? `${subject} — ${body}` : subject),
      tainted: last.taintedAt !== null,
    };
  }
  const times = msgs.map((m) => m.createdAt);
  return {
    key,
    kind: 'channel',
    id: officeId,
    title: 'Channel',
    roleIds: writers,
    preview,
    lastAt: last?.createdAt ?? null,
    unread: timeUnread(times, read[key]),
    // The channel's data carries no live-turn signal: `routingDueAt` is a
    // routing wake that is OWED, not one running, and a Director shift that
    // routes is in the shift log, not here. So the channel never shows the
    // working marker; its pending routing shows as "N unrouted".
    working: false,
    detail: unrouted ? `${unrouted} unrouted` : null,
    readMark: channelReadMark(channel),
  };
}

function huddleRow(h: OfficeHuddleView, roles: readonly RoleLike[], read: ReadMap): Conversation {
  const key = conversationKey('huddle', h.id);
  const last = h.entries.length ? h.entries[h.entries.length - 1] : null;
  return {
    key,
    kind: 'huddle',
    id: h.id,
    title: `Huddle: ${h.subjectLabel}`,
    roleIds: h.roleIds.slice(0, 3),
    preview: last
      ? {
          sender: last.kind === 'server' ? 'server' : last.roleId ? (roleName(roles, last.roleId) ?? 'a deleted role') : 'You',
          text: chatPreviewText(last.text),
          tainted: last.taintedAt !== null,
        }
      : h.decision
        ? { sender: h.status === 'decided' ? 'Decision' : 'Closed', text: chatPreviewText(h.decision), tainted: h.taintedAt !== null }
        : null,
    lastAt: later(last?.at ?? null, h.closedAt) ?? h.createdAt,
    unread: timeUnread(
      h.entries.map((e) => e.at),
      read[key],
    ),
    working: h.status === 'open' && huddleNextRoleId(h) !== null,
    detail: `turn ${h.turns}/${h.maxTurns} · ${h.status}`,
    readMark: huddleReadMark(h),
  };
}

/**
 * The office's one conversation list, newest activity first (a row with no
 * activity last; ties by key, so the order is stable). The channel is always
 * a row, even before its first message.
 */
export function buildConversations(input: {
  officeId: string;
  chats: readonly Chat[] | null;
  channel: OfficeChannelResponse | null;
  huddles: readonly OfficeHuddleView[] | null;
  roles: readonly RoleLike[];
  read: ReadMap;
}): Conversation[] {
  const { roles, read } = input;
  const rows: Conversation[] = [
    channelRow(input.officeId, input.channel, roles, read),
    ...(input.chats ?? []).map((c) => chatRow(c, roles, read)),
    ...(input.huddles ?? []).map((h) => huddleRow(h, roles, read)),
  ];
  return rows.sort((a, b) => {
    if (a.lastAt !== b.lastAt) {
      if (!a.lastAt) return 1;
      if (!b.lastAt) return -1;
      return a.lastAt < b.lastAt ? 1 : -1;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

// ---- the per-device read store ----

/** Parse the stored map; null when the key was never written (a fresh device). */
export function parseReadMap(raw: string | null): ReadMap | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: ReadMap = {};
    for (const [k, m] of Object.entries(v as Record<string, unknown>)) {
      const r = m as Partial<ReadMarker> | null;
      if (r && typeof r.count === 'number' && Number.isFinite(r.count) && typeof r.at === 'string') out[k] = { count: Math.max(0, r.count), at: r.at };
    }
    return out;
  } catch {
    return {};
  }
}

/** A marker only ever moves forward: the larger count, the later time. */
export function advanceMarker(cur: ReadMarker | undefined, next: ReadMarker): ReadMarker {
  if (!cur) return { count: Math.max(0, next.count), at: next.at };
  return { count: Math.max(cur.count, next.count), at: next.at > cur.at ? next.at : cur.at };
}

/** Keep at most `max` markers, dropping the stalest. */
export function pruneReadMap(map: ReadMap, max = OFFICE_READ_MAX): ReadMap {
  const keys = Object.keys(map);
  if (keys.length <= max) return map;
  keys.sort((a, b) => (map[a].at < map[b].at ? 1 : map[a].at > map[b].at ? -1 : 0));
  const out: ReadMap = {};
  for (const k of keys.slice(0, max)) out[k] = map[k];
  return out;
}

/**
 * A fresh device (the key never written) starts with everything it can see
 * marked read, so the first visit is not a wall of old unread counts; from
 * then on new conversations and messages count.
 */
export function baselineReadMap(rows: readonly Conversation[]): ReadMap {
  const out: ReadMap = {};
  for (const r of rows) out[r.key] = r.readMark;
  return out;
}

/** The slice of Web Storage this module touches (a fake in tests). */
export type ReadStorage = Pick<Storage, 'getItem' | 'setItem'>;

const listeners = new Set<() => void>();

/** Same-tab subscribers (another tab hears the `storage` event instead). */
export function onReadChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function defaultStorage(): ReadStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadReadMap(storage: ReadStorage | null = defaultStorage()): ReadMap | null {
  try {
    return parseReadMap(storage?.getItem(OFFICE_READ_KEY) ?? null);
  } catch {
    return {};
  }
}

function save(map: ReadMap, storage: ReadStorage | null): void {
  try {
    storage?.setItem(OFFICE_READ_KEY, JSON.stringify(pruneReadMap(map)));
  } catch {
    // private mode / quota: unread is a nudge, not a record
  }
  for (const l of listeners) l();
}

/**
 * Mark conversation `key` read up to `marker` (advance-only). Called by the
 * thread while it is visible and scrolled to its end. A no-op write is
 * skipped, so calling it on every render is cheap.
 */
export function markRead(key: string, marker: ReadMarker, storage: ReadStorage | null = defaultStorage()): void {
  const map = loadReadMap(storage) ?? {};
  const next = advanceMarker(map[key], marker);
  if (map[key] && map[key].count === next.count && map[key].at === next.at) return;
  save({ ...map, [key]: next }, storage);
}

/**
 * The read markers as unread counts may use them: null until this device's
 * baseline is written, so a conversation with no marker is never counted as
 * all-unread just because another thread marked itself read first.
 */
export function loadBaselinedReadMap(storage: ReadStorage | null = defaultStorage()): ReadMap | null {
  try {
    if (storage?.getItem(OFFICE_READ_BASELINE_KEY) == null) return null;
  } catch {
    return null;
  }
  return loadReadMap(storage) ?? {};
}

/**
 * Write the fresh-device baseline, once per device: every row without a
 * marker gets its current one (a marker a thread already wrote is kept).
 */
export function writeBaseline(rows: readonly Conversation[], storage: ReadStorage | null = defaultStorage()): void {
  try {
    if (!storage || storage.getItem(OFFICE_READ_BASELINE_KEY) != null) return;
    storage.setItem(OFFICE_READ_BASELINE_KEY, '1');
  } catch {
    return;
  }
  const map = loadReadMap(storage) ?? {};
  const base = baselineReadMap(rows);
  for (const k of Object.keys(base)) if (!map[k]) map[k] = base[k];
  save(map, storage);
}
