import type { Question, QuestionItem, Task } from '@tm/shared';
import type { QuestionService } from '../questions.ts';
import type { Storage } from '../storage/types.ts';
import { escapeHtml, type Reply } from './api.ts';
import type { FlowStore } from './flows.ts';
import { short } from './ids.ts';
import type { InlineKeyboardButton, InlineKeyboardMarkup } from './types.ts';

// The phone half of docs/questions.md. A worker's AskUserQuestion arrives as
// one message per question, each with its options as buttons; a tap answers
// a single-select question outright, toggles an option of a multi-select one
// (✔ Done commits), and "Other…" opens a flow that takes the next free-text
// message as the answer. The answer is submitted through the SAME
// QuestionService the SPA route uses, so whichever surface is first wins and
// the other is told.
//
// Buttons live in a `q:` namespace parsed in bot.ts BEFORE the stateless
// action codec, like `w:`, `k:` and `c:`: a question is answered or expired
// within hours, and a stale button must be refused, not misread.

export type QuestionButton =
  | { id: string; qi: number; verb: 'pick'; oi: number }
  | { id: string; qi: number; verb: 'other' }
  | { id: string; qi: number; verb: 'done' };

export function encodeQuestionButton(b: QuestionButton): string {
  const tail = b.verb === 'pick' ? String(b.oi) : b.verb === 'other' ? 'o' : 'd';
  return `q:${b.id}:${b.qi}:${tail}`;
}

/** `q:<question id>:<question index>:<option index | o | d>` — 36+8 bytes, under Telegram's 64. */
export function parseQuestionData(data: string): QuestionButton | null {
  const m = /^q:([\w-]{1,48}):(\d{1,2}):(\d{1,2}|o|d)$/.exec(data);
  if (!m) return null;
  const id = m[1];
  const qi = Number(m[2]);
  if (m[3] === 'o') return { id, qi, verb: 'other' };
  if (m[3] === 'd') return { id, qi, verb: 'done' };
  return { id, qi, verb: 'pick', oi: Number(m[3]) };
}

/**
 * Answers collected so far for a multi-question call — a question with three
 * items needs three taps before anything is submitted. In memory: a draft
 * that outlives the process is worth nothing, since the question it belonged
 * to expired with the process (boot sweep, docs/questions.md).
 */
export class QuestionDrafts {
  private readonly drafts = new Map<string, { picked: Map<number, Set<number>>; text: Map<number, string>; at: number }>();

  get(id: string) {
    this.prune();
    let d = this.drafts.get(id);
    if (!d) {
      d = { picked: new Map(), text: new Map(), at: Date.now() };
      this.drafts.set(id, d);
    }
    d.at = Date.now();
    return d;
  }

  clear(id: string): void {
    this.drafts.delete(id);
  }

  private prune(): void {
    const cutoff = Date.now() - 24 * 3_600_000;
    for (const [id, d] of this.drafts) if (d.at < cutoff) this.drafts.delete(id);
  }
}

export interface QuestionDeps {
  storage: Storage;
  questions: QuestionService;
  drafts: QuestionDrafts;
  flows: FlowStore;
  actor: string;
}

const LABEL_MAX = 48;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function itemHtml(q: Question, task: Task | null, qi: number, picked?: Set<number>): string {
  const item = q.questions[qi];
  const title = task ? escapeHtml(task.title) : `task ${short(q.taskId)}`;
  const lines: string[] = [];
  if (qi === 0) lines.push(`❓ <b>${title}</b> asks you:`);
  const header = item.header ? `<b>${escapeHtml(item.header)}</b> — ` : '';
  lines.push(`${q.questions.length > 1 ? `(${qi + 1}/${q.questions.length}) ` : ''}${header}${escapeHtml(item.question)}`);
  lines.push('');
  item.options.forEach((o, i) => {
    const mark = picked?.has(i) ? '✓ ' : '';
    lines.push(`${mark}${i + 1}. <b>${escapeHtml(o.label)}</b>${o.description ? ` — ${escapeHtml(o.description)}` : ''}`);
  });
  if (item.multiSelect) {
    lines.push('');
    lines.push('<i>Pick every option that applies, then ✔ Done.</i>');
  }
  return lines.join('\n');
}

function itemKeyboard(q: Question, qi: number, picked?: Set<number>): InlineKeyboardMarkup {
  const item = q.questions[qi];
  const rows: InlineKeyboardButton[][] = item.options.map((o, oi) => [
    {
      text: `${picked?.has(oi) ? '✓ ' : ''}${oi + 1}. ${clip(o.label, LABEL_MAX)}`,
      callback_data: encodeQuestionButton({ id: q.id, qi, verb: 'pick', oi }),
    },
  ]);
  const tail: InlineKeyboardButton[] = [];
  if (item.multiSelect) tail.push({ text: '✔ Done', callback_data: encodeQuestionButton({ id: q.id, qi, verb: 'done' }) });
  tail.push({ text: '✍️ Other…', callback_data: encodeQuestionButton({ id: q.id, qi, verb: 'other' }) });
  rows.push(tail);
  return { inline_keyboard: rows };
}

/** One message per question item — a keyboard belongs to one message. */
export function questionMessages(q: Question, task: Task | null, drafts?: QuestionDrafts): Reply[] {
  const d = drafts?.get(q.id);
  return q.questions.map((_, qi) => ({
    html: itemHtml(q, task, qi, d?.picked.get(qi)),
    keyboard: itemKeyboard(q, qi, d?.picked.get(qi)),
  }));
}

function summaryHtml(q: Question, task: Task | null): string {
  const title = task ? escapeHtml(task.title) : `task ${short(q.taskId)}`;
  const rows = q.questions.map((item) => {
    const a = q.answers?.[item.question] ?? '—';
    return `• ${escapeHtml(item.header || clip(item.question, 60))}: <b>${escapeHtml(a)}</b>`;
  });
  return [`<b>${title}</b>`, ...rows].join('\n');
}

function settledReply(q: Question, task: Task | null): Reply {
  if (q.status === 'answered') {
    return { html: `✅ Already answered${q.answeredBy ? ` (${escapeHtml(q.answeredBy)})` : ''}:\n${summaryHtml(q, task)}`, ok: false };
  }
  return { html: `⌛ That question has expired${q.note ? ` — ${escapeHtml(q.note)}` : ''}. The agent moved on without it.`, ok: false };
}

/**
 * Submit if every item has an answer in the draft; otherwise say what was
 * noted and re-render the next unanswered item so the keyboard is at hand.
 */
async function tryComplete(deps: QuestionDeps, q: Question, task: Task | null, noted: string): Promise<Reply> {
  const d = deps.drafts.get(q.id);
  const answers: Record<string, string> = {};
  let next = -1;
  q.questions.forEach((item, qi) => {
    const a = d.text.get(qi);
    if (a) answers[item.question] = a;
    else if (next === -1) next = qi;
  });
  if (next !== -1) {
    return {
      html: `${noted}\n\n${itemHtml(q, task, next, d.picked.get(next))}`,
      keyboard: itemKeyboard(q, next, d.picked.get(next)),
    };
  }
  const r = await deps.questions.answer(q.id, answers, deps.actor);
  deps.drafts.clear(q.id);
  if (!r.ok) return { html: `⚠ Could not answer: ${escapeHtml(r.error)}`, ok: false };
  return { html: `✅ Answered — the agent is continuing.\n${summaryHtml(r.question, task)}` };
}

export async function handleQuestionButton(deps: QuestionDeps, b: QuestionButton): Promise<{ reply: Reply; toast: string }> {
  const q = await deps.questions.get(b.id);
  if (!q) return { reply: { html: '⌛ That question is gone (it belonged to a previous run of the server).', ok: false }, toast: 'Gone' };
  const task = await deps.storage.getTask(q.taskId);
  if (q.status !== 'pending') return { reply: settledReply(q, task), toast: q.status === 'answered' ? 'Already answered' : 'Expired' };
  const item: QuestionItem | undefined = q.questions[b.qi];
  if (!item) return { reply: { html: '⚠ Unknown button.', ok: false }, toast: 'Unknown button' };
  const d = deps.drafts.get(q.id);
  const label = item.header || clip(item.question, 60);

  if (b.verb === 'other') {
    // A notification button can land mid-wizard; a half-finished /new must
    // not be silently thrown away by it (review round 1).
    const live = deps.flows.get();
    if (live && live.kind !== 'question') {
      return {
        reply: { html: `Finish or ✕ Cancel the current /${escapeHtml(live.kind)} first, then tap ✍️ Other… again.`, ok: false },
        toast: 'A wizard is open',
      };
    }
    deps.flows.set('question', 'text', { questionId: q.id, questionIndex: b.qi });
    return {
      reply: { html: `✍️ Type your answer to <b>${escapeHtml(label)}</b> — the next message you send is it.` },
      toast: 'Type your answer',
    };
  }
  if (b.verb === 'done') {
    const picked = d.picked.get(b.qi);
    if (!item.multiSelect || !picked || picked.size === 0) {
      return { reply: { html: `Pick at least one option for <b>${escapeHtml(label)}</b> first.`, keyboard: itemKeyboard(q, b.qi, picked), ok: false }, toast: 'Nothing picked' };
    }
    const text = [...picked].sort((a, b2) => a - b2).map((oi) => item.options[oi].label).join(', ');
    d.text.set(b.qi, text);
    return { reply: await tryComplete(deps, q, task, `Noted <b>${escapeHtml(label)}</b>: ${escapeHtml(text)}`), toast: 'Noted' };
  }
  const opt = item.options[b.oi];
  if (!opt) return { reply: { html: '⚠ Unknown option.', ok: false }, toast: 'Unknown option' };
  if (item.multiSelect) {
    let picked = d.picked.get(b.qi);
    if (!picked) {
      picked = new Set();
      d.picked.set(b.qi, picked);
    }
    if (picked.has(b.oi)) picked.delete(b.oi);
    else picked.add(b.oi);
    return {
      reply: { html: itemHtml(q, null, b.qi, picked), keyboard: itemKeyboard(q, b.qi, picked) },
      toast: `${picked.has(b.oi) ? 'Picked' : 'Unpicked'} ${clip(opt.label, LABEL_MAX)}`,
    };
  }
  d.text.set(b.qi, opt.label);
  return { reply: await tryComplete(deps, q, task, `Noted <b>${escapeHtml(label)}</b>: ${escapeHtml(opt.label)}`), toast: 'Noted' };
}

/** The free-text answer an "Other…" press asked for (flows.ts hands it here). */
export async function handleQuestionText(deps: QuestionDeps, questionId: string, qi: number, text: string): Promise<Reply> {
  const q = await deps.questions.get(questionId);
  if (!q) return { html: '⌛ That question is gone.', ok: false };
  const task = await deps.storage.getTask(q.taskId);
  if (q.status !== 'pending') return settledReply(q, task);
  const item = q.questions[qi];
  if (!item) return { html: '⚠ That question has no such part.', ok: false };
  const body = text.trim().slice(0, 4000);
  deps.drafts.get(q.id).text.set(qi, body);
  const label = item.header || clip(item.question, 60);
  return tryComplete(deps, q, task, `Noted <b>${escapeHtml(label)}</b>: ${escapeHtml(body)}`);
}

/** `/questions` — everything the agents are waiting on right now, keyboards included. */
export async function listQuestionsReplies(deps: QuestionDeps): Promise<Reply[]> {
  const pending = await deps.questions.listPending();
  if (pending.length === 0) return [{ html: 'No agent is waiting on you.' }];
  const out: Reply[] = [];
  for (const q of pending.slice().reverse()) {
    const task = await deps.storage.getTask(q.taskId);
    out.push(...questionMessages(q, task, deps.drafts));
  }
  return out;
}

/** What the notifier says when a question settles on the OTHER surface. */
export function settledNotice(q: Question, task: Task | null): string | null {
  if (q.status === 'answered') {
    if (q.answeredBy === 'telegram') return null; // the press already replied
    return `✅ Answered in the browser:\n${summaryHtml(q, task)}`;
  }
  if (q.status === 'expired') {
    const title = task ? escapeHtml(task.title) : `task ${short(q.taskId)}`;
    return `⌛ <b>${title}</b> — its question expired${q.note ? ` (${escapeHtml(q.note)})` : ''}.`;
  }
  return null;
}
