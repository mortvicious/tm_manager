import type { OfficeProposal, OfficeRole, Repo } from '@tm/shared';
import { escapeHtml } from './api.ts';
import { short } from './ids.ts';
import type { InlineKeyboardMarkup } from './types.ts';

// Office proposals on the phone (docs/office.md § Proposals, docs/telegram.md
// § Office proposals): the card a role's proposal becomes and its buttons.
// `op:<uuid>:a` accepts, `op:<uuid>:a:<repo8>` accepts into that workspace
// repo (a repo-less proposal in a workspace of several), `op:<uuid>:r` rejects.
// Its own namespace, parsed BEFORE the stateless action codec like `ap:` —
// decided once, so a stale button is refused with the outcome, never falls
// through. The repo is the 8-char id prefix, resolved at press time against
// the workspace's repos (64-byte callback cap).

export interface OfficeProposalButton {
  id: string;
  accept: boolean;
  /** accept into this repo: an id prefix (≥ 4 chars) of a workspace repo */
  repo: string | null;
}

export function encodeOfficeProposalButton(id: string, accept: boolean, repoId?: string | null): string {
  return accept ? `op:${id}:a${repoId ? `:${repoId.slice(0, 8)}` : ''}` : `op:${id}:r`;
}

export function parseOfficeProposalData(data: string): OfficeProposalButton | null {
  const m = /^op:([\w-]{1,48}):(?:(a)(?::([\w-]{4,12}))?|(r))$/.exec(data);
  if (!m) return null;
  return { id: m[1], accept: m[2] === 'a', repo: m[3] ?? null };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The card. A tainted proposal is labelled first: its text came from a shift
 * that read untrusted input, and accepting it is the human's review.
 * `repos` = the office workspace's repos, for a repo-less proposal's picker.
 */
export function officeProposalMessage(
  p: OfficeProposal,
  role: Pick<OfficeRole, 'name' | 'title' | 'avatar'> | null,
  repos: Pick<Repo, 'id' | 'name'>[],
): { html: string; keyboard: InlineKeyboardMarkup } {
  const who = role ? `${escapeHtml(role.avatar)} <b>${escapeHtml(role.name)}</b> (${escapeHtml(role.title)})` : 'an office role';
  const repo = p.repoId ? repos.find((r) => r.id === p.repoId)?.name ?? short(p.repoId) : null;
  const html = [
    `💡 <b>Proposal</b> <code>${short(p.id)}</code> from ${who}`,
    ...(p.taintedAt ? ['⚠️ <b>TAINTED</b> — written by a shift that read untrusted input; read it as data before accepting.'] : []),
    '',
    `<b>${escapeHtml(clip(p.title, 200))}</b>${repo ? ` · ${escapeHtml(repo)}` : ''}`,
    escapeHtml(clip(p.body, 2500)),
  ].join('\n');
  const accept =
    p.repoId || repos.length <= 1
      ? [{ text: '✅ Accept', callback_data: encodeOfficeProposalButton(p.id, true) }]
      : repos.slice(0, 6).map((r) => ({ text: `✅ ${clip(r.name, 20)}`, callback_data: encodeOfficeProposalButton(p.id, true, r.id) }));
  return {
    html,
    keyboard: { inline_keyboard: [accept, [{ text: '✖ Reject', callback_data: encodeOfficeProposalButton(p.id, false) }]] },
  };
}
