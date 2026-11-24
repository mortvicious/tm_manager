// The messenger thread's pure layer (docs/magma.md § 13 Messenger chat
// anatomy, docs/office.md § Group chat › The thread): sender grouping, day
// separators, task references and the jump pill's count — for the group
// chat, the channel and huddles alike (`buildThreadOf` + the entry views). DOM-free so
// `npm test` covers it (officeThread.test.ts); OfficeChat.tsx renders it.
import type { ChatMessage, OfficeHuddleEntry, OfficeMessage, Task } from '@tm/shared';

/** consecutive messages from one sender within this window share a header (§ 13) */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** The stakeholder's own messages sit on the right: the SPA's and the phone's. */
export function isOwnMessage(m: Pick<ChatMessage, 'role' | 'actor'>): boolean {
  return m.role === 'user' || m.actor === 'human' || m.actor === 'telegram';
}

/** who wrote it, for grouping: the actor, and in an office chat the role too */
export function senderKey(m: Pick<ChatMessage, 'role' | 'actor' | 'roleId'>): string {
  // The stakeholder is one sender whichever role a message was routed to, and
  // whether it came from the SPA or the phone.
  if (isOwnMessage(m)) return 'own';
  return `${m.actor}|${m.roleId ?? ''}`;
}

/** local calendar day `YYYY-MM-DD` of an instant */
export function dayKey(at: Date): string {
  const y = at.getFullYear();
  const mo = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

function startOfDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate());
}

/** whole local days between two instants' calendar days (DST-safe: rounded) */
function daysBetween(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86_400_000);
}

/**
 * The day pill's text (§ 13): "Today", "Yesterday", the weekday within the
 * last 6 days, else "7 Nov 2026". A future day (clock skew) reads as a date.
 */
export function dayLabel(at: Date, now: Date): string {
  const ago = daysBetween(at, now);
  if (ago === 0) return 'Today';
  if (ago === 1) return 'Yesterday';
  if (ago > 1 && ago <= 6) return at.toLocaleDateString('en-GB', { weekday: 'long' });
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** `hh:mm`, local — the group's timestamp */
export function timeLabel(at: Date): string {
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** What the generic thread builder needs to know about one entry. */
export interface ThreadEntryView {
  id: string;
  /** ISO instant */
  at: string;
  /** grouping key: consecutive entries of one sender within the window share a header */
  sender: string;
  /** the stakeholder's own entry (right side) */
  own: boolean;
  /** a server line (huddle `server` notes): a centred row, never a bubble, ends any group */
  system?: boolean;
}

export type ThreadOfItem<T> =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'system'; key: string; entry: T }
  | {
      kind: 'group';
      /** the first entry's id: stable while the group grows */
      key: string;
      own: boolean;
      sender: string;
      messages: T[];
    };

/**
 * The thread as rows, for any entry type (chat messages, channel messages,
 * huddle lines): a day pill before each local day's first entry, and runs of
 * one sender within `windowMs` of the PREVIOUS entry (a long conversation
 * keeps one header as long as nobody pauses for 5 minutes). A day separator
 * or a system line always ends a group. Input order is kept.
 */
export function buildThreadOf<T>(
  entries: readonly T[],
  view: (e: T) => ThreadEntryView,
  now: Date,
  windowMs: number = GROUP_WINDOW_MS,
): ThreadOfItem<T>[] {
  const out: ThreadOfItem<T>[] = [];
  let day: string | null = null;
  let group: Extract<ThreadOfItem<T>, { kind: 'group' }> | null = null;
  let lastAt = 0;
  let lastSender = '';
  for (const e of entries) {
    const v = view(e);
    const at = new Date(v.at);
    const k = dayKey(at);
    if (k !== day) {
      day = k;
      out.push({ kind: 'day', key: `day:${k}`, label: dayLabel(at, now) });
      group = null;
    }
    const t = at.getTime();
    if (v.system) {
      out.push({ kind: 'system', key: v.id, entry: e });
      group = null;
    } else if (group && v.sender === lastSender && t - lastAt <= windowMs && t >= lastAt) {
      group.messages.push(e);
    } else {
      group = { kind: 'group', key: v.id, own: v.own, sender: v.sender, messages: [e] };
      out.push(group);
    }
    lastAt = t;
    lastSender = v.system ? '' : v.sender;
  }
  return out;
}

export type ThreadItem =
  | { kind: 'day'; key: string; label: string }
  | {
      kind: 'group';
      /** the first message's id: stable while the group grows */
      key: string;
      own: boolean;
      actor: string;
      roleId: string | null;
      messages: ChatMessage[];
    };

/** The group chat's thread: `buildThreadOf` over chat messages, grouped by `senderKey`. */
export function buildThread(
  messages: readonly ChatMessage[],
  now: Date,
  windowMs: number = GROUP_WINDOW_MS,
): ThreadItem[] {
  const items = buildThreadOf(messages, (m) => ({ id: m.id, at: m.createdAt, sender: senderKey(m), own: isOwnMessage(m) }), now, windowMs);
  return items.map((it) =>
    it.kind === 'group'
      ? { kind: 'group', key: it.key, own: it.own, actor: it.messages[0].actor, roleId: it.messages[0].roleId, messages: it.messages }
      : (it as Extract<ThreadItem, { kind: 'day' }>),
  );
}

/** A channel message as a thread entry: the writer is the sender, the stakeholder (no role) is own. */
export function channelEntryView(m: Pick<OfficeMessage, 'id' | 'createdAt' | 'fromRoleId'>): ThreadEntryView {
  return { id: m.id, at: m.createdAt, sender: m.fromRoleId ?? 'own', own: m.fromRoleId === null };
}

/**
 * A huddle line as a thread entry: a server note is a system row; a line with
 * no role is the stakeholder's (the opening question); else the role speaking.
 */
export function huddleEntryView(e: Pick<OfficeHuddleEntry, 'messageId' | 'at' | 'roleId' | 'kind'>): ThreadEntryView {
  if (e.kind === 'server') return { id: e.messageId, at: e.at, sender: 'server', own: false, system: true };
  return { id: e.messageId, at: e.at, sender: e.roleId ?? 'own', own: e.roleId === null };
}

/**
 * The jump pill's "N new": messages that arrived after `sinceId` (the newest
 * one the reader had in view when they left the bottom). The reader's own
 * messages do not count — they just typed them. An unknown id (the transcript
 * was replaced) counts nothing rather than everything.
 */
export function countNewSince(messages: readonly ChatMessage[], sinceId: string | null): number {
  return countNewSinceOf(
    messages.map((m) => ({ id: m.id, own: isOwnMessage(m) })),
    sinceId,
  );
}

/** `countNewSince` over any entries already reduced to id + own. */
export function countNewSinceOf(entries: readonly { id: string; own: boolean }[], sinceId: string | null): number {
  if (sinceId === null) return 0;
  const i = entries.findIndex((m) => m.id === sinceId);
  if (i === -1) return 0;
  let n = 0;
  for (let j = i + 1; j < entries.length; j++) if (!entries[j].own) n++;
  return n;
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SHORT_RE = /(?<![0-9a-f-])[0-9a-f]{8}(?![0-9a-f-])/gi;

/**
 * Candidate task references in a message's text (§ 13 Task-link card): every
 * full uuid (a bare id, a `Task:` trailer, a `?task=<uuid>` link) and every
 * standalone 8-hex short id. Only candidates — `resolveTaskRefs` keeps the
 * ones the store knows. Lower-cased, de-duplicated, in order of appearance.
 */
export function taskRefCandidates(text: string): { full: string[]; short: string[] } {
  const full: string[] = [];
  for (const m of text.matchAll(UUID_RE)) {
    const id = m[0].toLowerCase();
    if (!full.includes(id)) full.push(id);
  }
  // Strip the uuids first so their first segment is not read as a short id.
  const rest = text.replace(UUID_RE, ' ');
  const short: string[] = [];
  for (const m of rest.matchAll(SHORT_RE)) {
    const id = m[0].toLowerCase();
    // all digits is a number (a date, a count), not an id8
    if (/^[0-9]+$/.test(id)) continue;
    if (!short.includes(id)) short.push(id);
  }
  return { full, short };
}

/**
 * The task ids a message links to, resolved against the store: a full id that
 * exists, and a short id naming EXACTLY one task (none or an ambiguous prefix
 * stays plain text). At most `max`, de-duplicated, in order of appearance.
 */
export function resolveTaskRefs(
  cands: { full: string[]; short: string[] },
  tasks: readonly Pick<Task, 'id'>[],
  max = 3,
): string[] {
  const out: string[] = [];
  if (cands.full.length === 0 && cands.short.length === 0) return out;
  const ids = new Set(tasks.map((t) => t.id.toLowerCase()));
  for (const id of cands.full) {
    if (out.length >= max) return out;
    if (ids.has(id) && !out.includes(id)) out.push(id);
  }
  for (const s of cands.short) {
    if (out.length >= max) return out;
    let hit: string | null = null;
    let n = 0;
    for (const t of tasks) {
      if (t.id.toLowerCase().startsWith(s)) {
        hit = t.id.toLowerCase();
        if (++n > 1) break;
      }
    }
    if (n === 1 && hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}
