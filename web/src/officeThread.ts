// The messenger thread's pure layer (docs/magma.md § 13 Messenger chat
// anatomy, docs/office.md § Group chat › The thread): sender grouping, day
// separators, task references and the jump pill's count. DOM-free so
// `npm test` covers it (officeThread.test.ts); OfficeChat.tsx renders it.
import type { ChatMessage, Task } from '@tm/shared';

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

/**
 * The thread as rows: a day pill before each local day's first message, and
 * runs of one sender within `windowMs` of the PREVIOUS message (a long
 * conversation keeps one header as long as nobody pauses for 5 minutes). A
 * day separator always ends a group. Input order is kept — the store holds the
 * transcript in arrival order, which is the server's `createdAt` order.
 */
export function buildThread(
  messages: readonly ChatMessage[],
  now: Date,
  windowMs: number = GROUP_WINDOW_MS,
): ThreadItem[] {
  const out: ThreadItem[] = [];
  let day: string | null = null;
  let group: Extract<ThreadItem, { kind: 'group' }> | null = null;
  let lastAt = 0;
  let lastSender = '';
  for (const m of messages) {
    const at = new Date(m.createdAt);
    const k = dayKey(at);
    if (k !== day) {
      day = k;
      out.push({ kind: 'day', key: `day:${k}`, label: dayLabel(at, now) });
      group = null;
    }
    const sender = senderKey(m);
    const t = at.getTime();
    if (group && sender === lastSender && t - lastAt <= windowMs && t >= lastAt) {
      group.messages.push(m);
    } else {
      group = { kind: 'group', key: m.id, own: isOwnMessage(m), actor: m.actor, roleId: m.roleId, messages: [m] };
      out.push(group);
    }
    lastAt = t;
    lastSender = sender;
  }
  return out;
}

/**
 * The jump pill's "N new": messages that arrived after `sinceId` (the newest
 * one the reader had in view when they left the bottom). The reader's own
 * messages do not count — they just typed them. An unknown id (the transcript
 * was replaced) counts nothing rather than everything.
 */
export function countNewSince(messages: readonly ChatMessage[], sinceId: string | null): number {
  if (sinceId === null) return 0;
  const i = messages.findIndex((m) => m.id === sinceId);
  if (i === -1) return 0;
  let n = 0;
  for (let j = i + 1; j < messages.length; j++) if (!isOwnMessage(messages[j])) n++;
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
