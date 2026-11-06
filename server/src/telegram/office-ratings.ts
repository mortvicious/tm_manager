import { ratingEmoji, type OfficeRatingSubjectKind, type OfficeRatingValue } from '@tm/shared';
import { rateOfficeSubject } from '../office/ratings.ts';
import type { Storage } from '../storage/types.ts';
import type { InlineKeyboardButton } from './types.ts';

// Stakeholder ratings on the phone (docs/office.md § Ratings, docs/telegram.md
// § Office ratings): 👍/👎 under a briefing document and a proposal card.
// `rt:<b|p|t|m>:<uuid>:<u|d>` — its own namespace, parsed BEFORE the stateless
// action codec like `op:`. A press rates in-process as `telegram` (no
// comment: it keeps a comment given on the dashboard); pressing the same
// button again changes nothing. The bot audits every press as a
// `telegram.command` row; a change is also the service's `office.rated` row.

export interface OfficeRatingButton {
  kind: OfficeRatingSubjectKind;
  id: string;
  value: OfficeRatingValue;
}

const KIND_CODE: Record<OfficeRatingSubjectKind, string> = { brief: 'b', proposal: 'p', task: 't', message: 'm' };
const CODE_KIND: Record<string, OfficeRatingSubjectKind> = { b: 'brief', p: 'proposal', t: 'task', m: 'message' };

export function encodeOfficeRatingButton(kind: OfficeRatingSubjectKind, id: string, value: OfficeRatingValue): string {
  return `rt:${KIND_CODE[kind]}:${id}:${value === 1 ? 'u' : 'd'}`;
}

export function parseOfficeRatingData(data: string): OfficeRatingButton | null {
  const m = /^rt:([bptm]):([\w-]{1,48}):([ud])$/.exec(data);
  if (!m) return null;
  return { kind: CODE_KIND[m[1]], id: m[2], value: m[3] === 'u' ? 1 : -1 };
}

/** The 👍 / 👎 row a notification carries. */
export function officeRatingRow(kind: OfficeRatingSubjectKind, id: string): InlineKeyboardButton[] {
  return [
    { text: '👍', callback_data: encodeOfficeRatingButton(kind, id, 1) },
    { text: '👎', callback_data: encodeOfficeRatingButton(kind, id, -1) },
  ];
}

/** Run a press. `toast` is the callback answer. */
export async function runOfficeRatingButton(
  storage: Storage,
  button: OfficeRatingButton,
  actor: string,
): Promise<{ ok: boolean; changed: boolean; toast: string }> {
  const r = await rateOfficeSubject(storage, { kind: button.kind, id: button.id, value: button.value }, actor);
  if (!r.ok) return { ok: false, changed: false, toast: r.code === 404 ? 'Gone' : r.error.slice(0, 180) };
  return {
    ok: true,
    changed: r.changed,
    toast: r.changed ? `${ratingEmoji(button.value)} saved — the role reads it next shift` : `${ratingEmoji(button.value)} already`,
  };
}
