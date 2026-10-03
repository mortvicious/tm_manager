import {
  REVIEW_BUSY_STATES,
  REVIEW_NOW_FROM,
  TERMINAL_TASK_STATUSES,
  customQueueHoldsRepo,
  customQueueWaiting,
  matchTaskPreset,
  taskPresets,
  type Feature,
  type Proposal,
  type Question,
  type Repo,
  type Run,
  type RunActivity,
  type Task,
  type TaskStatus,
} from '@tm/shared';
import type { Orchestrator } from '../orchestrator.ts';
import type { Storage } from '../storage/types.ts';
import { encodeAction, type ButtonAction } from './actions.ts';
import { MAX_MESSAGE_CHARS, escapeHtml, type Reply } from './api.ts';
import { short } from './ids.ts';
import { reviewClause } from './notifications.ts';
import { formatClock } from './status.ts';
import type { InlineKeyboardButton, InlineKeyboardMarkup, ReplyKeyboardMarkup } from './types.ts';

// The phone dashboard (docs/telegram.md § The board): `/tasks` is ONE message
// that redraws itself in place — filter tabs, repo chips, one button per row,
// ‹ › pages — and a task opened from it is a card that redraws itself too.
//
// Everything here is a READ. Rendering takes the in-process services (storage,
// Orchestrator.status(), the activity watcher's snapshot) and returns a Reply;
// it never touches the network, the PTY or HTTP. Navigation (`l:`) is therefore
// never audited — only the mutations behind the action codec are, as before.
//
// The `l:` wire carries 8-character short ids resolved through ids.ts, never
// full uuids: a card button also carries the board state to go back to, and
// Telegram caps callback_data at 64 bytes.

// ---- task vocabulary shared with commands.ts ------------------------------

export const STATUS_ICON: Record<TaskStatus, string> = {
  draft: '📝',
  queued: '⏳',
  running: '⚙️',
  waiting: '⏸',
  blocked: '⛔',
  review: '📋',
  published: '🚀',
  done: '✅',
  failed: '❌',
  cancelled: '🚫',
};

export const TASK_STATUSES = Object.keys(STATUS_ICON) as TaskStatus[];

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);

/** One line on where the adversarial review stands (docs/design.md § Adversarial review). */
export function reviewStateLine(t: Task): string | null {
  switch (t.reviewState) {
    case 'pending':
    case 'reviewing':
      return '🔍 <b>auto-review</b> in progress';
    case 'fixing':
      return `🔧 <b>fixing</b> review findings (round ${t.reviewRounds.length})`;
    case 'passed':
    case 'flagged':
    case 'error':
    case 'skipped': {
      const clause = reviewClause(t);
      return clause ? `<b>Review</b> · ${escapeHtml(clause)}` : null;
    }
    default:
      return null;
  }
}

/**
 * Where a custom-queue member stands. The ordinal comes from the SHARED
 * `customQueueWaiting()` the SPA board's `queue #n` chip uses, so `/task` and the
 * browser cannot tell the same task a different number — the mark survives
 * into `running`/`review`/`blocked` (whether or not it still holds its repo's
 * place — `customQueueHoldsRepo`), and counting those would inflate every
 * position by however many were in flight.
 */
export async function queueLine(storage: Storage, t: Task): Promise<string> {
  const added = ` · added ${escapeHtml(formatClock(t.customQueueAt!))}`;
  if (t.status === 'running') return `➕ holding the custom queue's single slot${added}`;
  if (customQueueHoldsRepo(t)) {
    const why = t.status === 'review' ? 'its automatic review is open' : `it is ${escapeHtml(t.status)}`;
    return `➕ in the custom queue — holding its repo's place while ${why}${added}`;
  }
  if (t.status === 'review') return `➕ in the custom queue — done here, waiting for you; the queue moved on${added}`;
  const waiting = customQueueWaiting(await storage.listTasks());
  const at = waiting.findIndex((m) => m.id === t.id) + 1;
  if (at === 0) return `➕ in the custom queue${added}`;
  const held = t.queueHeldAt ? ' · ⏸ held (Undo start) until you Release it' : '';
  return `➕ custom queue <b>#${at}</b> of ${waiting.length} waiting${held}${added}`;
}

/**
 * The buttons a task's CURRENT status makes possible — never a button whose
 * action would immediately answer "cannot do that from status X".
 *
 * Built with `encodeAction`, never with the wire strings written out: that is
 * what actually enforces "a button here cannot exist without a case in
 * `runButtonAction`". Spelling `t:done:` by hand compiles fine and then fails
 * at PRESS time as "Unknown button" if a `WIRE` entry is ever renamed —
 * `notifications.ts` has always used the codec for exactly this reason.
 */
export function taskActionKeyboard(t: Task): InlineKeyboardMarkup | undefined {
  const b: InlineKeyboardButton[] = [];
  const add = (text: string, kind: ButtonAction['kind']) =>
    b.push({ text, callback_data: encodeAction({ kind, id: t.id } as ButtonAction) });
  if (t.status === 'review') {
    add('✅ Done', 'task.done');
    add('🚀 Publish', 'task.publish');
    add('💬 Proceed', 'task.proceed');
  }
  if (t.status === 'blocked') add('⛔ Unblock', 'task.unblock');
  // "Review now": hidden while a round is queued/running/being fixed, as the SPA disables it
  if (t.repoId && REVIEW_NOW_FROM.includes(t.status) && !(t.reviewState && REVIEW_BUSY_STATES.includes(t.reviewState))) {
    add('🔍 Review', 'task.review');
  }
  if (['draft', 'failed', 'cancelled', 'review'].includes(t.status)) {
    add('⏳ Queue', 'task.enqueue');
    add('▶ Run now', 'task.run');
  }
  if (t.status === 'running' || t.status === 'waiting') add('↩ Undo start', 'task.undo');
  if (t.status === 'queued' && t.queueHeldAt) add('▶ Release', 'task.release');
  if (t.status === 'queued' || t.status === 'running') add('🚫 Cancel', 'task.cancel');
  if (t.customQueueAt) add('➖ Leave queue', 'task.queueRemove');
  else if (['draft', 'failed', 'cancelled', 'review', 'queued'].includes(t.status)) {
    add('➕ Custom queue', 'task.queueAdd');
  }
  if (b.length === 0) return undefined;
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < b.length; i += 2) rows.push(b.slice(i, i + 2));
  return { inline_keyboard: rows };
}

// ---- the `l:` codec -------------------------------------------------------

/**
 * `in` inbox · `op` every open task (`/tasks <repo>`, `/tasks open`) · `s` the
 * last `/tasks <text>` search · one code per status. `ru` is the LIVE view —
 * running AND waiting, the two statuses with a session behind them.
 */
export type BoardView = 'in' | 'op' | 's' | 'dr' | 'qu' | 'ru' | 'wa' | 'bl' | 're' | 'pu' | 'do' | 'fa' | 'ca';

export const STATUS_VIEW: Record<TaskStatus, BoardView> = {
  draft: 'dr',
  queued: 'qu',
  running: 'ru',
  waiting: 'wa',
  blocked: 'bl',
  review: 're',
  published: 'pu',
  done: 'do',
  failed: 'fa',
  cancelled: 'ca',
};

const VIEW_META: Record<BoardView, { icon: string; title: string }> = {
  in: { icon: '📥', title: 'Inbox' },
  op: { icon: '📂', title: 'Open tasks' },
  s: { icon: '🔎', title: 'Search' },
  ru: { icon: '🏃', title: 'Now running' },
  re: { icon: '👀', title: 'Review' },
  qu: { icon: '⏳', title: 'Queued' },
  dr: { icon: '📝', title: 'Draft' },
  fa: { icon: '⚠', title: 'Failed' },
  wa: { icon: '⏸', title: 'Waiting' },
  bl: { icon: '⛔', title: 'Blocked' },
  pu: { icon: '🚀', title: 'Published' },
  do: { icon: '✅', title: 'Done' },
  ca: { icon: '🚫', title: 'Cancelled' },
};

/** The top row, in this order. */
const TABS: BoardView[] = ['in', 'ru', 're', 'qu', 'dr', 'fa'];

const VIEWS = new Set<string>(Object.keys(VIEW_META));

export interface BoardState {
  view: BoardView;
  /** 8-character repo id prefix, null = every repo */
  repo: string | null;
  page: number;
}

export const INBOX: BoardState = { view: 'in', repo: null, page: 0 };

export type ListButton =
  /** redraw the board at `state`; `refresh` marks the board's own 🔄 */
  | { kind: 'board'; state: BoardState; refresh: boolean }
  /** open (or, `refresh`, redraw) one task's card; `back` is where ◀ goes */
  | { kind: 'card'; task: string; back: BoardState; refresh: boolean }
  /** send the task's open question(s) with their answer buttons */
  | { kind: 'ask'; task: string }
  /** send one pending proposal in full with its decision buttons */
  | { kind: 'proposal'; id: string }
  /** send a proposed feature's plan report with its approve button */
  | { kind: 'feature'; id: string }
  /** the page counter — answered silently */
  | { kind: 'noop' };

/** Telegram's hard cap on callback_data, in BYTES. */
const MAX_CALLBACK_BYTES = 64;

const stateWire = (s: BoardState) => `${s.view}:${s.repo ? short(s.repo) : '-'}:${s.page}`;

export function encodeList(b: ListButton): string {
  let out: string;
  switch (b.kind) {
    case 'board':
      out = `l:${b.refresh ? 'f' : 'v'}:${stateWire(b.state)}`;
      break;
    case 'card':
      out = `l:${b.refresh ? 'r' : 'o'}:${short(b.task)}:${stateWire(b.back)}`;
      break;
    case 'ask':
      out = `l:a:${short(b.task)}`;
      break;
    case 'proposal':
      out = `l:p:${short(b.id)}`;
      break;
    case 'feature':
      out = `l:e:${short(b.id)}`;
      break;
    case 'noop':
      out = 'l:x';
      break;
  }
  // A throw at RENDER time beats a button Telegram refuses the whole message for.
  if (Buffer.byteLength(out) > MAX_CALLBACK_BYTES) throw new Error(`callback_data over 64 bytes: ${out}`);
  return out;
}

const ID = '([0-9a-z-]{4,36})';
const STATE = '([a-z]{1,2}):([0-9a-z-]{4,36}|-):(\\d{1,3})';
const BOARD_RE = new RegExp(`^l:(v|f):${STATE}$`);
const CARD_RE = new RegExp(`^l:(o|r):${ID}:${STATE}$`);
const ONE_RE = new RegExp(`^l:(a|p|e):${ID}$`);

function parseState(view: string, repo: string, page: string): BoardState | null {
  if (!VIEWS.has(view)) return null;
  return { view: view as BoardView, repo: repo === '-' ? null : repo, page: Number(page) };
}

/**
 * Null for anything that is not a well-formed `l:` button — including an id
 * shorter than ids.ts would resolve. Parsed in bot.ts BEFORE the action codec.
 */
export function parseListData(data: string): ListButton | null {
  if (data === 'l:x') return { kind: 'noop' };
  let m = BOARD_RE.exec(data);
  if (m) {
    const state = parseState(m[2], m[3], m[4]);
    return state ? { kind: 'board', state, refresh: m[1] === 'f' } : null;
  }
  m = CARD_RE.exec(data);
  if (m) {
    const back = parseState(m[3], m[4], m[5]);
    return back ? { kind: 'card', task: m[2], back, refresh: m[1] === 'r' } : null;
  }
  m = ONE_RE.exec(data);
  if (m) {
    if (m[1] === 'a') return { kind: 'ask', task: m[2] };
    if (m[1] === 'p') return { kind: 'proposal', id: m[2] };
    return { kind: 'feature', id: m[2] };
  }
  return null;
}

/**
 * Which surface a pressed message is, read off its own keyboard: a board
 * carries its 🔄 (`l:f:`), a card carries ITS 🔄 (`l:r:`). An action pressed on
 * either redraws that message; anything else (a notification, `/kill`) is not
 * ours to redraw.
 */
export type MessageContext =
  | { kind: 'board'; state: BoardState }
  | { kind: 'card'; task: string; back: BoardState };

export function messageContext(markup: InlineKeyboardMarkup | undefined): MessageContext | null {
  for (const row of markup?.inline_keyboard ?? []) {
    for (const b of row) {
      const parsed = typeof b.callback_data === 'string' ? parseListData(b.callback_data) : null;
      if (parsed?.kind === 'board' && parsed.refresh) return { kind: 'board', state: parsed.state };
      if (parsed?.kind === 'card' && parsed.refresh) return { kind: 'card', task: parsed.task, back: parsed.back };
    }
  }
  return null;
}

// ---- the bottom keyboard --------------------------------------------------

/** Label → the command it types. Exact match only, so prose never trips it. */
const SHORTCUTS: Record<string, string> = {
  '📥 Tasks': '/tasks',
  '👀 Review': '/tasks review',
  '🏃 Now': '/now',
  '❓ Questions': '/questions',
  '📊 Status': '/status',
};

export function shortcutCommand(text: string): string | null {
  return SHORTCUTS[text.trim()] ?? null;
}

export function bottomKeyboard(): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: '📥 Tasks' }, { text: '👀 Review' }, { text: '🏃 Now' }],
      [{ text: '❓ Questions' }, { text: '📊 Status' }],
    ],
    is_persistent: true,
    resize_keyboard: true,
  };
}

// ---- data -----------------------------------------------------------------

/** The activity watcher's read side — `ActivityWatcher` satisfies it. */
export interface ActivitySource {
  snapshot(): RunActivity[];
}

/** Bot-lifetime memory. One user, so one remembered search. */
export class BoardMemory {
  search: string | null = null;
}

export interface BoardDeps {
  storage: Storage;
  orchestrator: Orchestrator;
  activity: ActivitySource | null;
  memory: BoardMemory;
}

/** Rows per page. Keyboard stays far under Telegram's 100 buttons. */
export const PAGE_SIZE = 8;
/** A failure older than this has left the inbox; the ⚠ tab still lists it. */
const INBOX_FAILED_DAYS = 7;

interface Snapshot {
  tasks: Task[];
  repos: Repo[];
  live: Run[];
  questions: Question[];
  proposals: Proposal[];
  features: Feature[];
  /** task ids with a pending question */
  asking: Set<string>;
  /** task ids whose live run is flagged needs-attention (Board.tsx's rule) */
  attention: Set<string>;
  liveByTask: Map<string, Run>;
  activity: Map<string, RunActivity>;
}

async function load(deps: BoardDeps): Promise<Snapshot> {
  const [tasks, repos, live, questions, proposals, features] = await Promise.all([
    deps.storage.listTasks(),
    deps.storage.listRepos(),
    deps.storage.listRuns({ status: 'running' }),
    deps.storage.listQuestions({ status: 'pending' }),
    deps.storage.listProposals({ status: 'pending' }),
    deps.storage.listFeatures({ status: 'proposed' }),
  ]);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const liveByTask = new Map<string, Run>();
  for (const r of live) {
    if (!r.taskId) continue;
    const prev = liveByTask.get(r.taskId);
    // the worker is the run a phone wants to watch or kill; an analysis run
    // on the same task only stands in when there is no worker
    const worker = r.mode === 'worker';
    const better =
      !prev ||
      (worker && prev.mode !== 'worker') ||
      (worker === (prev.mode === 'worker') && r.startedAt > prev.startedAt);
    if (better) liveByTask.set(r.taskId, r);
  }
  const attention = new Set<string>();
  for (const r of live) {
    if (!r.taskId || r.idle || !r.needsAttention) continue;
    if (byId.get(r.taskId)?.status === 'running') attention.add(r.taskId);
  }
  let activity = new Map<string, RunActivity>();
  try {
    activity = new Map((deps.activity?.snapshot() ?? []).map((a) => [a.runId, a]));
  } catch {
    // a watcher hiccup costs the narration line, never the board
  }
  return {
    tasks,
    repos,
    live,
    questions,
    proposals,
    features,
    asking: new Set(questions.map((q) => q.taskId)),
    attention,
    liveByTask,
    activity,
  };
}

/** The repo a state's chip names, or null when unset, gone or ambiguous. */
function chipRepo(snap: Snapshot, state: BoardState): Repo | null {
  if (!state.repo) return null;
  const hits = snap.repos.filter((r) => r.id.toLowerCase().startsWith(state.repo!.toLowerCase()));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Status icon + the markers the SPA's StatusBadge would show, all at once
 * (a row has room for more than one badge): ❓ asks you · 🔔 needs attention ·
 * 🔍 auto-review · 🔧 fixing · 🚩 review flagged · ➕ custom queue.
 */
export function taskMarks(t: Task, sig: { asking: Set<string>; attention: Set<string> }): string {
  let m = STATUS_ICON[t.status];
  if (sig.asking.has(t.id)) m += '❓';
  if (sig.attention.has(t.id)) m += '🔔';
  if (t.status === 'review' && (t.reviewState === 'pending' || t.reviewState === 'reviewing')) m += '🔍';
  if (t.reviewState === 'fixing') m += '🔧';
  if (t.reviewState === 'flagged') m += '🚩';
  if (t.customQueueAt) m += '➕';
  return m;
}

export function formatElapsed(fromIso: string, now = Date.now()): string {
  const ms = now - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '0m';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${String(min % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "🛠 Edit x.ts" / "💬 narration", or null before the transcript has a line. */
function activityLine(a: RunActivity | undefined, max: number): string | null {
  if (!a?.text) return null;
  return `${a.kind === 'tool' ? '🛠' : '💬'} ${escapeHtml(clip(a.text.replace(/\s+/g, ' ').trim(), max))}`;
}

function statsLine(r: Run): string {
  const parts = [`⏱ ${formatElapsed(r.startedAt)}`];
  if (r.stats) {
    parts.push(`ctx ${Math.round(r.stats.contextPct)}%`, `$${r.stats.costUsd.toFixed(2)}`);
  }
  return parts.join(' · ');
}

// ---- items ----------------------------------------------------------------

interface Item {
  /** HTML lines for the message body, `n.` is prefixed by the renderer */
  lines: (max: number) => string[];
  /** the row's first button (label gets `n.`) and its action buttons */
  open: { label: string; data: string } | null;
  actions: InlineKeyboardButton[];
}

const act = (text: string, a: ButtonAction): InlineKeyboardButton => ({ text, callback_data: encodeAction(a) });

function taskItem(snap: Snapshot, t: Task, state: BoardState, detail: (max: number) => string[] = () => []): Item {
  const repo = snap.repos.find((r) => r.id === t.repoId);
  const marks = taskMarks(t, snap);
  return {
    lines: (max) => [
      `${marks} <b>${escapeHtml(clip(t.title, max))}</b> <code>${short(t.id)}</code>${repo ? ` · <i>${escapeHtml(clip(repo.name, 24))}</i>` : ''}`,
      ...detail(max).map((l) => `    ${l}`),
    ],
    open: { label: `${marks} ${t.title}`, data: encodeList({ kind: 'card', task: t.id, back: state, refresh: false }) },
    actions: [],
  };
}

/** The live block: what the agent is doing, for how long, at what cost. */
function liveDetail(snap: Snapshot, t: Task): (max: number) => string[] {
  return (max) => {
    const run = snap.liveByTask.get(t.id);
    if (!run) return [t.status === 'waiting' ? '⏸ waiting · no live run row' : 'no live run row'];
    const out: string[] = [];
    const line = activityLine(snap.activity.get(run.id), max + 40);
    if (line) out.push(line);
    out.push(`${t.status === 'waiting' ? '⏸ waiting on background work · ' : ''}${statsLine(run)}`);
    return out;
  };
}

function inboxItems(snap: Snapshot, state: BoardState, inRepo: (id: string | null) => boolean): Item[] {
  const items: Item[] = [];
  const seen = new Set<string>();
  const tasks = snap.tasks.filter((t) => inRepo(t.repoId));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const newest = (a: Task, b: Task) => b.updatedAt.localeCompare(a.updatedAt);

  // 1. open questions — one row per task, however many it asks
  const asked = new Map<string, Question[]>();
  for (const q of snap.questions) {
    if (!byId.has(q.taskId)) continue;
    asked.set(q.taskId, [...(asked.get(q.taskId) ?? []), q]);
  }
  for (const [taskId, qs] of asked) {
    const t = byId.get(taskId)!;
    seen.add(t.id);
    const it = taskItem(snap, t, state, (max) => {
      const first = qs[0].questions[0];
      const more = qs.reduce((n, q) => n + q.questions.length, 0) - 1;
      return first ? [`asks: “${escapeHtml(clip(first.question, max + 40))}”${more > 0 ? ` (+${more})` : ''}`] : [];
    });
    it.actions.push({ text: '❓ Answer', callback_data: encodeList({ kind: 'ask', task: t.id }) });
    items.push(it);
  }
  // 2. needs-attention runs
  for (const t of tasks.filter((x) => snap.attention.has(x.id) && !seen.has(x.id)).sort(newest)) {
    seen.add(t.id);
    const it = taskItem(snap, t, state, liveDetail(snap, t));
    const run = snap.liveByTask.get(t.id);
    if (run) it.actions.push(act('✖ Kill', { kind: 'run.kill', id: run.id }));
    items.push(it);
  }
  // 3. review — flagged verdicts first
  const flaggedFirst = (a: Task, b: Task) =>
    Number(b.reviewState === 'flagged') - Number(a.reviewState === 'flagged') || newest(a, b);
  for (const t of tasks.filter((x) => x.status === 'review' && !seen.has(x.id)).sort(flaggedFirst)) {
    seen.add(t.id);
    const it = taskItem(snap, t, state, () => {
      const r = reviewClause(t);
      return r ? [escapeHtml(r)] : [];
    });
    it.actions.push(act('✅ Done', { kind: 'task.done', id: t.id }), act('🚀 Publish', { kind: 'task.publish', id: t.id }));
    items.push(it);
  }
  // 4. blocked
  for (const t of tasks.filter((x) => x.status === 'blocked' && !seen.has(x.id)).sort(newest)) {
    seen.add(t.id);
    const it = taskItem(snap, t, state, (max) => (t.error ? [`⚠ ${escapeHtml(clip(t.error, max + 40))}`] : []));
    it.actions.push(act('⛔ Unblock', { kind: 'task.unblock', id: t.id }));
    items.push(it);
  }
  // 5. recent failures
  const since = new Date(Date.now() - INBOX_FAILED_DAYS * 86_400_000).toISOString();
  for (const t of tasks.filter((x) => x.status === 'failed' && x.updatedAt >= since && !seen.has(x.id)).sort(newest)) {
    seen.add(t.id);
    const it = taskItem(snap, t, state, (max) => (t.error ? [`⚠ ${escapeHtml(clip(t.error, max + 40))}`] : []));
    it.actions.push(act('🔁 Retry', { kind: 'task.retry', id: t.id }));
    items.push(it);
  }
  // 6. pending proposals
  for (const p of snap.proposals.filter((x) => inRepo(x.repoId))) {
    const what = p.payload.title ?? p.payload.rationale;
    const n = p.payload.options?.length ?? 0;
    items.push({
      lines: (max) => [
        `💡 <b>${escapeHtml(clip(what, max))}</b> <code>${short(p.id)}</code> · ${escapeHtml(p.kind)}${n ? ` · ${n} options` : ''}`,
      ],
      open: { label: `💡 ${what}`, data: encodeList({ kind: 'proposal', id: p.id }) },
      // An options proposal is a CHOICE — accepted from its full message only.
      actions: [
        ...(n ? [] : [act('✅ Accept', { kind: 'proposal.accept', id: p.id })]),
        act('✖ Reject', { kind: 'proposal.reject', id: p.id }),
      ],
    });
  }
  // 7. proposed features
  for (const f of snap.features.filter((x) => inRepo(x.repoId))) {
    const phases = f.analysis?.phases.length ?? 0;
    const count = f.analysis?.phases.reduce((a, ph) => a + ph.tasks.filter((c) => !c.excluded).length, 0) ?? 0;
    items.push({
      lines: (max) => [
        `🧩 <b>${escapeHtml(clip(f.title, max))}</b> <code>${short(f.id)}</code> · ${phases} phase(s), ${count} task(s)`,
      ],
      open: { label: `🧩 ${f.title}`, data: encodeList({ kind: 'feature', id: f.id }) },
      actions: [act('✅ Approve', { kind: 'feature.approve', id: f.id })],
    });
  }
  return items;
}

function viewTasks(snap: Snapshot, view: BoardView, search: string | null): Task[] {
  const newest = (a: Task, b: Task) => b.updatedAt.localeCompare(a.updatedAt);
  switch (view) {
    case 'in':
      return [];
    case 'op':
      return snap.tasks.filter((t) => !TERMINAL_TASK_STATUSES.includes(t.status)).sort(newest);
    case 's': {
      if (!search) return [];
      const q = search.toLowerCase();
      return snap.tasks.filter((t) => t.title.toLowerCase().includes(q)).sort(newest);
    }
    case 'ru':
      return snap.tasks.filter((t) => t.status === 'running' || t.status === 'waiting').sort(newest);
    default: {
      const status = TASK_STATUSES.find((s) => STATUS_VIEW[s] === view)!;
      return snap.tasks.filter((t) => t.status === status).sort(newest);
    }
  }
}

function itemsFor(snap: Snapshot, state: BoardState, search: string | null): Item[] {
  const repo = chipRepo(snap, state);
  const inRepo = (id: string | null) => !repo || id === repo.id;
  if (state.view === 'in') return inboxItems(snap, state, inRepo);
  return viewTasks(snap, state.view, search)
    .filter((t) => inRepo(t.repoId))
    .map((t) => {
      if (state.view !== 'ru') return taskItem(snap, t, state);
      const it = taskItem(snap, t, state, liveDetail(snap, t));
      const run = snap.liveByTask.get(t.id);
      if (run) it.actions.push(act('✖ Kill', { kind: 'run.kill', id: run.id }));
      if (snap.asking.has(t.id)) it.actions.push({ text: '❓ Answer', callback_data: encodeList({ kind: 'ask', task: t.id }) });
      return it;
    });
}

// ---- rendering ------------------------------------------------------------

/** Button text Telegram would truncate anyway — cut it where we choose. */
const label = (s: string, n = 30) => clip(s.replace(/\s+/g, ' ').trim(), n);

/** Try the body at shrinking clip widths until the message fits one edit. */
function fit(render: (max: number) => string): string {
  for (const max of [80, 40, 16]) {
    const html = render(max);
    if (html.length <= MAX_MESSAGE_CHARS) return html;
  }
  return render(0);
}

export async function renderBoard(deps: BoardDeps, want: BoardState): Promise<Reply> {
  const snap = await load(deps);
  const repo = chipRepo(snap, want);
  // A chip whose repo is gone (or now ambiguous) is dropped, not honoured.
  const base: BoardState = { view: want.view, repo: repo ? short(repo.id) : null, page: 0 };
  const search = deps.memory.search;
  const all = itemsFor(snap, base, search);
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const state: BoardState = { ...base, page: Math.min(Math.max(0, want.page), pages - 1) };
  const items = itemsFor(snap, state, search).slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
  const meta = VIEW_META[state.view];

  const head: string[] = [
    `<b>${meta.icon} ${meta.title}</b>${repo ? ` · <i>${escapeHtml(repo.name)}</i>` : ''} · ${all.length}` +
      (pages > 1 ? ` · page ${state.page + 1}/${pages}` : ''),
  ];
  if (state.view === 'ru') {
    const st = await deps.orchestrator.status();
    head.push(
      `workers ${st.running}/${st.concurrency} · queue ${st.enabled ? 'on' : 'off'}` +
        (st.aux ? ` · ${st.aux} aux` : ''),
    );
  }
  if (state.view === 's') head.push(search ? `title contains “${escapeHtml(clip(search, 60))}”` : '');

  const empty =
    state.view === 'in'
      ? 'Nothing needs you right now.'
      : state.view === 'ru'
        ? 'Nothing is running.'
        : state.view === 's'
          ? search
            ? `No task title contains “${escapeHtml(clip(search, 60))}”.`
            : 'That search is gone (the server restarted) — send <code>/tasks &lt;text&gt;</code> again.'
          : 'Nothing here.';
  const first = state.page * PAGE_SIZE + 1;
  const html = fit((max) =>
    [
      ...head.filter(Boolean),
      '',
      items.length === 0
        ? empty
        : items
            .map((it, i) => {
              const [l0, ...rest] = max > 0 ? it.lines(max) : it.lines(8).slice(0, 1);
              return [`${first + i}. ${l0}`, ...rest].join('\n');
            })
            .join('\n'),
    ].join('\n'),
  );

  const rows: InlineKeyboardButton[][] = [];
  const counts = new Map<BoardView, number>();
  const inRepo = (id: string | null) => !repo || id === repo.id;
  for (const v of TABS) {
    counts.set(v, v === 'in' ? inboxItems(snap, state, inRepo).length : viewTasks(snap, v, null).filter((t) => inRepo(t.repoId)).length);
  }
  rows.push(
    TABS.map((v) => ({
      text: `${v === state.view ? '•' : ''}${VIEW_META[v].icon}${counts.get(v) ? counts.get(v) : ''}`,
      callback_data: encodeList({ kind: 'board', state: { view: v, repo: state.repo, page: 0 }, refresh: false }),
    })),
  );

  // Repo chips: the repos with open work, busiest first, capped at two rows.
  const open = snap.tasks.filter((t) => !TERMINAL_TASK_STATUSES.includes(t.status));
  const load_ = (id: string) => open.filter((t) => t.repoId === id).length;
  let chips = snap.repos
    .filter((r) => load_(r.id) > 0)
    .sort((a, b) => load_(b.id) - load_(a.id) || a.name.localeCompare(b.name))
    .slice(0, 5);
  if (repo && !chips.some((r) => r.id === repo.id)) chips = [repo, ...chips.slice(0, 4)];
  if (chips.length > 1 || repo) {
    const chipButtons: InlineKeyboardButton[] = [
      {
        text: `${repo ? '' : '•'}🌐 all`,
        callback_data: encodeList({ kind: 'board', state: { view: state.view, repo: null, page: 0 }, refresh: false }),
      },
      ...chips.map((r) => ({
        text: `${repo?.id === r.id ? '•' : ''}${label(r.name, 16)}`,
        callback_data: encodeList({ kind: 'board', state: { view: state.view, repo: r.id, page: 0 }, refresh: false }),
      })),
    ];
    for (let i = 0; i < chipButtons.length; i += 3) rows.push(chipButtons.slice(i, i + 3));
  }

  items.forEach((it, i) => {
    const row: InlineKeyboardButton[] = [];
    if (it.open) row.push({ text: label(`${first + i}. ${it.open.label}`, it.actions.length ? 22 : 40), callback_data: it.open.data });
    row.push(...it.actions);
    rows.push(row);
  });

  const refresh = { text: '🔄', callback_data: encodeList({ kind: 'board', state, refresh: true }) };
  if (pages > 1) {
    const to = (page: number) => encodeList({ kind: 'board', state: { ...state, page }, refresh: false });
    rows.push([
      { text: '‹', callback_data: to((state.page - 1 + pages) % pages) },
      { text: `${state.page + 1}/${pages}`, callback_data: encodeList({ kind: 'noop' }) },
      { text: '›', callback_data: to((state.page + 1) % pages) },
      refresh,
    ]);
  } else {
    rows.push([{ ...refresh, text: '🔄 Refresh' }]);
  }
  return { html, keyboard: { inline_keyboard: rows } };
}

/**
 * One task in full, with the buttons its CURRENT status allows plus ◀ back to
 * the board it was opened from and 🔄. Clipped so it stays ONE message — an
 * edit cannot be chunked (the redraw falls back to a fresh send if it ever
 * does not fit).
 */
export async function renderCard(deps: BoardDeps, t: Task, back: BoardState): Promise<Reply> {
  const [repo, live, questions] = await Promise.all([
    t.repoId ? deps.storage.getRepo(t.repoId) : Promise.resolve(null),
    deps.storage.listRuns({ taskId: t.id, status: 'running' }),
    deps.storage.listQuestions({ status: 'pending', taskId: t.id }),
  ]);
  const run =
    live.sort((a, b) => Number(b.mode === 'worker') - Number(a.mode === 'worker') || b.startedAt.localeCompare(a.startedAt))[0] ??
    null;
  const sig = {
    asking: new Set(questions.length ? [t.id] : []),
    attention: new Set(run && !run.idle && run.needsAttention && t.status === 'running' ? [t.id] : []),
  };
  let activity: RunActivity | undefined;
  try {
    activity = run ? deps.activity?.snapshot().find((a) => a.runId === run.id) : undefined;
  } catch {
    activity = undefined;
  }
  const presets = taskPresets(await deps.storage.getSettings().catch(() => null));
  const preset = matchTaskPreset({ model: t.model, effort: t.effort, review: t.review }, presets);
  const queue = t.customQueueAt ? await queueLine(deps.storage, t) : null;
  // Escaping can grow a clipped field up to 5x, so the free-text fields shrink
  // until the card is one editable message.
  const build = (k: number) => {
    const lines = [
      `${taskMarks(t, sig)} <b>${escapeHtml(clip(t.title, Math.round(300 * k)))}</b>`,
      `<code>${short(t.id)}</code> · ${escapeHtml(t.status)}${repo ? ` · ${escapeHtml(repo.name)}` : ''}${t.category ? ` · ${escapeHtml(t.category)}` : ''}`,
    ];
    if (questions.length) lines.push(`❓ <b>asks you</b> — ${questions.length === 1 ? 'a question is' : `${questions.length} questions are`} waiting`);
    if (sig.attention.size) lines.push('🔔 <b>needs attention</b> — a prompt is open in its terminal');
    if (run) {
      const a = activityLine(activity, 160);
      lines.push(`${a ? `${a}\n` : ''}${statsLine(run)}`);
    }
    lines.push(``);
    if (t.description) lines.push(escapeHtml(clip(t.description, Math.round(1200 * k))), ``);
    lines.push(
      `model <code>${escapeHtml(t.model ?? 'default')}</code> · effort <code>${escapeHtml(t.effort ?? 'default')}</code> · ` +
        `review <code>${t.review === null ? 'default' : t.review ? 'on' : 'off'}</code> · ` +
        // who reviews it — omitted only when review is explicitly off for the task
        (t.review === false
          ? ''
          : `reviewer <code>${escapeHtml(t.reviewModel ?? 'default')}${t.reviewEffort ? ` ${escapeHtml(t.reviewEffort)}` : ''}</code> · `) +
        `auto-publish <code>${t.autoPublish ? 'on' : 'off'}</code>` +
        (preset ? ` (${escapeHtml(preset.label)})` : ''),
    );
    if (queue) lines.push(queue);
    if (t.featureId) lines.push(`🧩 feature <code>${short(t.featureId)}</code> · phase ${(t.featurePhase ?? 0) + 1}`);
    if (t.resultSummary) lines.push(``, `<b>Result</b>`, escapeHtml(clip(t.resultSummary, Math.round(1000 * k))));
    const review = reviewStateLine(t);
    if (review) lines.push(``, review);
    const last = t.reviewRounds[t.reviewRounds.length - 1];
    if (last?.summary) lines.push(escapeHtml(clip(last.summary, Math.round(800 * k))));
    else if (t.reviewSummary) lines.push(escapeHtml(clip(t.reviewSummary, Math.round(800 * k))));
    if (t.error) lines.push(``, `⚠ ${escapeHtml(clip(t.error, Math.round(500 * k)))}`);
    lines.push(``, `Updated ${escapeHtml(formatClock(t.updatedAt))}`);
    return lines.join('\n');
  };
  const html = [1, 0.5, 0.2].map(build).find((h) => h.length <= MAX_MESSAGE_CHARS) ?? build(0.05);

  const rows = [...(taskActionKeyboard(t)?.inline_keyboard ?? [])];
  const extra: InlineKeyboardButton[] = [];
  if (questions.length) extra.push({ text: '❓ Answer', callback_data: encodeList({ kind: 'ask', task: t.id }) });
  if (run) extra.push(act('✖ Kill run', { kind: 'run.kill', id: run.id }));
  if (extra.length) rows.push(extra);
  const meta = VIEW_META[back.view];
  rows.push([
    { text: `◀ ${meta.icon} ${meta.title}`, callback_data: encodeList({ kind: 'board', state: back, refresh: false }) },
    { text: '🔄 Refresh', callback_data: encodeList({ kind: 'card', task: t.id, back, refresh: true }) },
  ]);
  return { html, keyboard: { inline_keyboard: rows } };
}
