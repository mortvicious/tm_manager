import { APPROVAL_LABELS, type Approval, type Task } from '@tm/shared';
import { escapeHtml } from './api.ts';
import { short } from './ids.ts';
import type { InlineKeyboardMarkup } from './types.ts';

// Approvals on the phone (docs/approvals.md § Telegram): the card an agent's
// request becomes, and its two buttons. `ap:<uuid>:y|n` is its own namespace,
// parsed BEFORE the stateless action codec like `q:` — a request is decided
// once, and a stale button must be refused with the outcome, never fall through.

export interface ApprovalButton {
  id: string;
  approve: boolean;
}

export function encodeApprovalButton(id: string, approve: boolean): string {
  return `ap:${id}:${approve ? 'y' : 'n'}`;
}

export function parseApprovalData(data: string): ApprovalButton | null {
  const m = /^ap:([\w-]{1,48}):([yn])$/.exec(data);
  return m ? { id: m[1], approve: m[2] === 'y' } : null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function approvalMessage(a: Approval, task: Task | null): { html: string; keyboard: InlineKeyboardMarkup } {
  const who = task ? `<b>${escapeHtml(clip(task.title, 80))}</b> <code>${short(task.id)}</code>` : `run <code>${short(a.runId)}</code>`;
  const html = [
    `🔐 <b>Approve: ${escapeHtml(APPROVAL_LABELS[a.action])}</b>`,
    `asked by ${who}`,
    '',
    `<pre>${escapeHtml(clip(a.summary, 2500))}</pre>`,
    `<i>why:</i> ${escapeHtml(clip(a.reason, 600))}`,
  ].join('\n');
  return {
    html,
    keyboard: {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: encodeApprovalButton(a.id, true) },
          { text: '✖ Reject', callback_data: encodeApprovalButton(a.id, false) },
        ],
      ],
    },
  };
}

/** The outcome line, once a request settles; null while it is still in flight. */
export function approvalNotice(a: Approval): string | null {
  const what = `${escapeHtml(APPROVAL_LABELS[a.action])} <code>${short(a.id)}</code>`;
  const body = a.result ? `\n<pre>${escapeHtml(clip(a.result, 1500))}</pre>` : '';
  switch (a.status) {
    case 'done':
      return `✅ ${what} done${a.decidedBy === 'auto-approve' ? ' (pre-approved)' : ''}${body}`;
    case 'failed':
      return `⚠ ${what} failed${body}`;
    case 'rejected':
      return `✖ ${what} rejected by ${escapeHtml(a.decidedBy ?? '—')}`;
    case 'expired':
      return `⌛ ${what} expired${body}`;
    default:
      return null;
  }
}
