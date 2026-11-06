// Office group chat (docs/office.md § Group chat): the pure half, shared by
// the server (routing a turn, building its transcript and the shift block)
// and the SPA (the @-autocomplete and the "answers: …" hint). No I/O.

import type { ChatMessage } from './types.ts';
import type { OfficeRole } from './office.ts';

type RoleLike = Pick<OfficeRole, 'id' | 'key' | 'name' | 'preset'>;

/** `@name` at the start or after whitespace/punctuation — never inside `a@b.c`. */
const MENTION_RE = /(^|[\s([{,;:!?"'])@([\p{L}\p{N}][\p{L}\p{N}_.-]*)/gu;

/** The @-mentions in `text`, in order, without the `@` (trailing `.`/`-` dropped). */
export function mentionTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const t = m[2].replace(/[._-]+$/u, '');
    if (t) out.push(t);
  }
  return out;
}

/** A role a token names: its key, its whole name, or its name's first word (case-insensitive); `director` = the Director. */
export function roleForToken<R extends RoleLike>(token: string, roles: readonly R[]): R | null {
  const t = token.toLowerCase();
  const exact = roles.find((r) => r.key.toLowerCase() === t || r.name.toLowerCase() === t);
  if (exact) return exact;
  const first = roles.filter((r) => r.name.toLowerCase().split(/\s+/)[0] === t);
  if (first.length === 1) return first[0];
  if (t === 'director') return roles.find((r) => r.preset === 'director') ?? null;
  return null;
}

export type OfficeChatTarget<R> =
  | { kind: 'role'; role: R; mentioned: boolean }
  | { kind: 'unknown'; token: string }
  | { kind: 'no-director' };

/**
 * Who answers a stakeholder message: the FIRST @mention that names a role;
 * no mention → the Director (who is always present). A mention that names
 * nobody is refused rather than silently sent to the Director — a typo in a
 * name must not put words in the wrong persona's mouth.
 */
export function officeChatTarget<R extends RoleLike>(text: string, roles: readonly R[], director: R | null): OfficeChatTarget<R> {
  const tokens = mentionTokens(text);
  for (const tok of tokens) {
    const r = roleForToken(tok, roles);
    if (r) return { kind: 'role', role: r, mentioned: true };
  }
  if (tokens.length) return { kind: 'unknown', token: tokens[0] };
  return director ? { kind: 'role', role: director, mentioned: false } : { kind: 'no-director' };
}

/** The @-token the caret is in (autocomplete): its start index and the typed part, or null. */
export function mentionAtCaret(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s([{,;:!?"'])@([\p{L}\p{N}_.-]*)$/u.exec(before);
  if (!m) return null;
  return { start: before.length - m[2].length - 1, query: m[2] };
}

/** Roles whose name or key starts with `query` (case-insensitive), name order. */
export function mentionCandidates<R extends RoleLike>(roles: readonly R[], query: string): R[] {
  const q = query.toLowerCase();
  return roles
    .filter((r) => !q || r.name.toLowerCase().startsWith(q) || r.key.toLowerCase().startsWith(q) || r.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The token to insert for a role: its name's first word when that is unambiguous, else its key. */
export function mentionTokenFor<R extends RoleLike>(role: R, roles: readonly R[]): string {
  const first = role.name.split(/\s+/)[0];
  return /^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(first) && roleForToken(first, roles)?.id === role.id ? first : role.key;
}

/** One transcript line a model reads (a chat turn's "chat so far", a shift's chat block). */
export interface OfficeChatLine {
  at: string;
  /** `stakeholder`, or the role's name */
  from: string;
  /** stakeholder lines: the role it was addressed to */
  to?: string;
  text?: string;
  /** a tainted reply shown to a TRUSTED reader: its text is withheld */
  withheld?: 'tainted';
}

/** The stakeholder wrote it (trusted), as opposed to a role's reply. */
export function isStakeholderChatMessage(m: Pick<ChatMessage, 'role'>): boolean {
  return m.role === 'user';
}

/**
 * The chat so far as a TURN reads it. Failed turns are dropped. A tainted
 * reply's text reaches only a turn that is itself tainted; a trusted turn
 * sees that it exists and who wrote it, never its words — so a trusted
 * persona cannot repeat (launder) them into an untainted reply.
 */
export function officeChatTranscript(
  messages: readonly ChatMessage[],
  roleName: (id: string | null) => string,
  opts: { tainted: boolean },
): OfficeChatLine[] {
  const out: OfficeChatLine[] = [];
  for (const m of messages) {
    if (m.error) continue;
    if (isStakeholderChatMessage(m)) {
      out.push({ at: m.createdAt, from: 'stakeholder', ...(m.roleId ? { to: roleName(m.roleId) } : {}), text: m.text });
      continue;
    }
    if (m.taintedAt && !opts.tainted) out.push({ at: m.createdAt, from: roleName(m.roleId), withheld: 'tainted' });
    else out.push({ at: m.createdAt, from: roleName(m.roleId), text: m.text });
  }
  return out;
}

/**
 * The ONLY chat a SHIFT reads (docs/office.md § Group chat): the
 * stakeholder's messages addressed to this role and this role's own
 * UNTAINTED replies. A tainted reply is not shown at all — not even withheld
 * — and only counted; nothing else of the chat ever reaches a shift prompt.
 */
export function officeChatShiftLines(
  messages: readonly ChatMessage[],
  roleId: string,
  roleName: (id: string | null) => string,
): { lines: OfficeChatLine[]; taintedDropped: number } {
  const lines: OfficeChatLine[] = [];
  let taintedDropped = 0;
  for (const m of messages) {
    if (m.error || m.roleId !== roleId) continue;
    if (isStakeholderChatMessage(m)) {
      lines.push({ at: m.createdAt, from: 'stakeholder', to: roleName(m.roleId), text: m.text });
    } else if (m.taintedAt) {
      taintedDropped++;
    } else {
      lines.push({ at: m.createdAt, from: roleName(m.roleId), text: m.text });
    }
  }
  return { lines, taintedDropped };
}
