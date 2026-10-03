import { groupAncestors, type Feature, type Repo, type Task, type TaskStatus } from '@tm/shared';
import { MAX_TASK_ID_CANDIDATES, MIN_TASK_ID_PREFIX, findTaskById, normalizeTaskId } from './taskId.ts';

/**
 * Board search (docs/search.md): ONE query that narrows the board by anything a
 * task carries. A query is a set of TOKENS (structured facets, drawn as chips)
 * plus free TEXT. Tokens of the same kind are OR-ed (`status review` +
 * `status failed`), different kinds AND-ed, and every word of the text must
 * appear somewhere in the task (title, description, summary, ids, repo, group,
 * status, source, category, feature, model, dates). The text also accepts the
 * typed form of every token (`status:review`, `repo:neko`, `created:today`),
 * applied live while typed and folded into chips when the search is committed.
 *
 * Pure on purpose: no React, no DOM, so the rules can be exercised directly.
 */

export type FacetKind =
  | 'repo'
  | 'status'
  | 'state'
  | 'source'
  | 'cat'
  | 'group'
  | 'feature'
  | 'dispatch'
  | 'model'
  | 'id'
  | 'parent'
  | 'created'
  | 'updated';

export const FACET_KINDS: readonly FacetKind[] = [
  'repo',
  'status',
  'state',
  'source',
  'cat',
  'group',
  'feature',
  'dispatch',
  'model',
  'id',
  'parent',
  'created',
  'updated',
];

export interface SearchToken {
  kind: FacetKind;
  value: string;
}

/** Who filed a task, as the board names it. */
export type Provenance = 'human' | 'agent' | 'sentry' | 'analyze' | 'feature';

export const provenanceOf = (t: Task): Provenance => {
  // feature wins over agent: a feature-generated task is the plan's, not a
  // worker's follow-up (its children keep featureId but are still 'agent').
  if (t.source === 'feature') return 'feature';
  if (t.createdByRun) return 'agent';
  if (t.source === 'sentry') return 'sentry';
  if (t.source === 'auto') return 'analyze';
  return 'human';
};

/** Every status, with the words people use for it. Keyed by the type, so a new status cannot be missed. */
const STATUS_WORDS: Record<TaskStatus, string[]> = {
  draft: ['draft', 'drafts', 'inbox'],
  queued: ['queued', 'todo', 'to do', 'next'],
  running: ['running', 'in progress', 'working', 'active'],
  waiting: ['waiting', 'parked', 'subagent'],
  blocked: ['blocked', 'stuck'],
  review: ['review', 'to review', 'needs review'],
  published: ['published', 'shipped', 'pushed'],
  done: ['done', 'finished', 'complete', 'completed', 'closed'],
  failed: ['failed', 'failure', 'broken'],
  cancelled: ['cancelled', 'canceled'],
};
const STATUSES = Object.keys(STATUS_WORDS) as TaskStatus[];

/** Finished statuses: a date next to them means "finished then", i.e. last touched. */
const SETTLED: ReadonlySet<string> = new Set(['review', 'published', 'done', 'failed', 'cancelled']);

/** Live conditions that are badges on the board rather than statuses. */
export type TaskState =
  | 'attention'
  | 'asking'
  | 'auto-review'
  | 'fixing'
  | 'flagged'
  | 'in-queue'
  | 'held'
  | 'waking'
  | 'auto-publish';

const STATE_WORDS: Record<TaskState, { label: string; words: string[] }> = {
  attention: { label: 'needs attention', words: ['attention', 'needs attention', 'permission'] },
  asking: { label: 'asks you', words: ['asks', 'asking', 'question', 'questions'] },
  'auto-review': { label: 'auto-review', words: ['auto-review', 'reviewing', 'in review'] },
  fixing: { label: 'fixing', words: ['fixing', 'fix round'] },
  flagged: { label: 'review flagged', words: ['flagged', 'findings'] },
  'in-queue': { label: 'in my queue', words: ['in-queue', 'my queue', 'custom queue', 'queue'] },
  held: { label: 'held', words: ['held', 'on hold', 'hold'] },
  waking: { label: 'auto wake-up', words: ['waking', 'wake', 'wake-up', 'limit', 'sleeping'] },
  'auto-publish': { label: 'auto-publish', words: ['auto-publish', 'auto publish', 'autopublish'] },
};

const SOURCE_WORDS: Record<Provenance, { label: string; words: string[] }> = {
  human: { label: 'human', words: ['human', 'manual', 'me', 'mine'] },
  agent: { label: 'agent', words: ['agent', 'agents', 'bot'] },
  sentry: { label: 'sentry', words: ['sentry'] },
  analyze: { label: 'analyze', words: ['analyze', 'analysis', 'auto'] },
  feature: { label: 'feature', words: ['feature', 'features', 'plan'] },
};

const DISPATCH_WORDS: Record<'with' | 'pending', { label: string; words: string[] }> = {
  with: { label: 'has dispatches', words: ['dispatch', 'dispatches', 'dispatched', 'any'] },
  pending: { label: 'pending dispatches', words: ['pending dispatch', 'pending dispatches'] },
};

/** What the board knows besides the tasks — everything a facet can name. */
export interface SearchContext {
  tasks: readonly Task[];
  repos: readonly Repo[];
  features: readonly Feature[];
  /** every task tree by root id (Board's groupIndex) */
  groups: ReadonlyMap<string, { id: string; label: string; size: number }>;
  dispatched: { any: ReadonlySet<string>; pending: ReadonlySet<string> };
  attention: (t: Task) => boolean;
  asking: ReadonlySet<string>;
  now: Date;
}

// ---------------------------------------------------------------- dates

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const pad = (n: number) => String(n).padStart(2, '0');
/** A date as `YYYY-MM-DD` in LOCAL time — the board's days are the user's days. */
export const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** `sep`, `sept`, `september` → 0-based month; whole words only (3+ letters). */
function monthOf(word: string): number | null {
  if (word.length < 3) return null;
  const i = MONTH_NAMES.findIndex((m) => m.startsWith(word));
  if (i >= 0) return i;
  return word === 'sept' ? 8 : null;
}

function validDay(y: number, m: number, d: number): string | null {
  const dt = new Date(y, m, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m || dt.getDate() !== d) return null;
  return localDay(dt);
}

/** One calendar day: ISO, `sep 30`, `30 sep`, `sep 30 2026`, a weekday (the latest one). */
function parseDay(s: string, now: Date): string | null {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return validDay(+m[1], +m[2] - 1, +m[3]);
  const today = startOfDay(now);
  // no year: this year's, unless that is still ahead — then last year's
  const dated = (mon: number, day: number, year?: string) => {
    if (year) return validDay(+year, mon, day);
    const iso = validDay(today.getFullYear(), mon, day);
    if (!iso) return null;
    return new Date(today.getFullYear(), mon, day) > today ? validDay(today.getFullYear() - 1, mon, day) : iso;
  };
  m = /^([a-z]+)\.? (\d{1,2})(?:,? (\d{4}))?$/.exec(s);
  if (m && monthOf(m[1]) !== null) return dated(monthOf(m[1])!, +m[2], m[3]);
  m = /^(\d{1,2}) ([a-z]+)\.?(?: (\d{4}))?$/.exec(s);
  if (m && monthOf(m[2]) !== null) return dated(monthOf(m[2])!, +m[1], m[3]);
  const wd = WEEKDAYS.findIndex((w) => s.length >= 3 && w.startsWith(s));
  if (wd >= 0) return localDay(addDays(today, -((today.getDay() - wd + 7) % 7)));
  return null;
}

/** One calendar month: `2026-09`, `september`, `sep 2026`. */
function parseMonth(s: string, now: Date): string | null {
  let m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${pad(+m[2])}`;
  m = /^([a-z]+)(?: (\d{4}))?$/.exec(s);
  if (!m) return null;
  const mon = monthOf(m[1]);
  if (mon === null) return null;
  if (m[2]) return `${m[2]}-${pad(mon + 1)}`;
  const y = mon > now.getMonth() ? now.getFullYear() - 1 : now.getFullYear();
  return `${y}-${pad(mon + 1)}`;
}

/**
 * Plain words → a date expression (the value of a `created`/`updated` token):
 * `today`, `yesterday`, `<N>d` (the last N days, today included), `YYYY-MM-DD`,
 * `YYYY-MM`, `>YYYY-MM-DD` (since that day, inclusive), `<YYYY-MM-DD` (before it).
 */
export function parseDatePhrase(raw: string, now: Date): string | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  if (s === 'today' || s === 'now') return 'today';
  if (s === 'yesterday') return 'yesterday';
  if (/^[<>]\d{4}-\d{2}-\d{2}$/.test(s)) return dateRange(s, now) ? s : null;
  if (/^(this |last |past )?week$/.test(s)) return '7d';
  if (/^(this |last |past )?month$/.test(s)) return '30d';
  if (/^(this |last |past )?year$/.test(s)) return '365d';
  let m = /^(?:last |past )?(\d{1,3}) ?(d|days?)$/.exec(s);
  if (m && +m[1] >= 1 && +m[1] <= 365) return `${+m[1]}d`;
  m = /^(?:last |past )?(\d{1,2}) ?(w|wks?|weeks?)$/.exec(s);
  if (m && +m[1] >= 1 && +m[1] <= 52) return `${+m[1] * 7}d`;
  m = /^(since|after|from|before) (.+)$/.exec(s);
  if (m) {
    const inner = m[2] === 'today' ? localDay(now) : m[2] === 'yesterday' ? localDay(addDays(now, -1)) : parseDay(m[2], now);
    const day = inner ?? (parseMonth(m[2], now) ? `${parseMonth(m[2], now)}-01` : null);
    if (!day) return null;
    if (m[1] === 'before') return `<${day}`;
    // "after sep 1" reads as from the day after; "since"/"from" include it
    return m[1] === 'after' ? `>${localDay(addDays(new Date(`${day}T00:00`), 1))}` : `>${day}`;
  }
  return parseDay(s, now) ?? parseMonth(s, now);
}

/** A date expression → [from, to) in epoch ms (local days), or null if malformed. */
export function dateRange(expr: string, now: Date): { from: number; to: number } | null {
  const today = startOfDay(now);
  if (expr === 'today') return { from: +today, to: +addDays(today, 1) };
  if (expr === 'yesterday') return { from: +addDays(today, -1), to: +today };
  let m = /^(\d{1,3})d$/.exec(expr);
  if (m && +m[1] >= 1) return { from: +addDays(today, 1 - +m[1]), to: Infinity };
  m = /^([<>]?)(\d{4})-(\d{2})-(\d{2})$/.exec(expr);
  if (m) {
    const iso = validDay(+m[2], +m[3] - 1, +m[4]);
    if (!iso) return null;
    const day = new Date(+m[2], +m[3] - 1, +m[4]);
    if (m[1] === '>') return { from: +day, to: Infinity };
    if (m[1] === '<') return { from: -Infinity, to: +day };
    return { from: +day, to: +addDays(day, 1) };
  }
  m = /^(\d{4})-(\d{2})$/.exec(expr);
  if (m && +m[2] >= 1 && +m[2] <= 12) {
    return { from: +new Date(+m[1], +m[2] - 1, 1), to: +new Date(+m[1], +m[2], 1) };
  }
  return null;
}

const shortDay = (iso: string, now: Date) => {
  const [y, mo, d] = iso.split('-').map(Number);
  const s = `${MONTHS[mo - 1][0].toUpperCase()}${MONTHS[mo - 1].slice(1)} ${d}`;
  return y === now.getFullYear() ? s : `${s} ${y}`;
};

/** `today` → "today", `7d` → "last 7 days", `2026-09-30` → "on Sep 30", … */
export function dateLabel(expr: string, now: Date): string {
  if (expr === 'today' || expr === 'yesterday') return expr;
  let m = /^(\d+)d$/.exec(expr);
  if (m) return +m[1] === 1 ? 'today' : `last ${m[1]} days`;
  m = /^([<>]?)(\d{4}-\d{2}-\d{2})$/.exec(expr);
  if (m) return `${m[1] === '>' ? 'since' : m[1] === '<' ? 'before' : 'on'} ${shortDay(m[2], now)}`;
  m = /^(\d{4})-(\d{2})$/.exec(expr);
  if (m) {
    const mon = MONTHS[+m[2] - 1];
    return `in ${mon[0].toUpperCase()}${mon.slice(1)}${+m[1] === now.getFullYear() ? '' : ` ${m[1]}`}`;
  }
  return expr;
}

// ---------------------------------------------------------------- facets

interface FacetOption {
  value: string;
  label: string;
  words: string[];
}

/** The values a listed facet can take right now, with the words that find them. */
function facetOptions(kind: FacetKind, ctx: SearchContext): FacetOption[] {
  switch (kind) {
    case 'repo': {
      const out: FacetOption[] = ctx.repos.map((r) => ({ value: r.id, label: r.name, words: [r.name] }));
      if (ctx.tasks.some((t) => !t.repoId)) out.push({ value: 'none', label: 'no repo', words: ['no repo'] });
      return out;
    }
    case 'status':
      return STATUSES.map((s) => ({ value: s, label: s, words: STATUS_WORDS[s] }));
    case 'state':
      return (Object.keys(STATE_WORDS) as TaskState[]).map((s) => ({ value: s, ...STATE_WORDS[s] }));
    case 'source':
      return (Object.keys(SOURCE_WORDS) as Provenance[]).map((s) => ({ value: s, ...SOURCE_WORDS[s] }));
    case 'dispatch':
      return (Object.keys(DISPATCH_WORDS) as ('with' | 'pending')[]).map((s) => ({ value: s, ...DISPATCH_WORDS[s] }));
    case 'cat': {
      const cats = [...new Set(ctx.tasks.map((t) => t.category).filter((c): c is string => !!c))].sort();
      const out = cats.map((c) => ({ value: c, label: c, words: [c] }));
      if (ctx.tasks.some((t) => !t.category)) out.push({ value: 'none', label: 'uncategorized', words: ['uncategorized'] });
      return out;
    }
    case 'group':
      return [...ctx.groups.values()]
        .filter((g) => g.size > 1)
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((g) => ({ value: g.id, label: g.label, words: [g.label] }));
    case 'feature':
      return ctx.features.map((f) => ({ value: f.id, label: f.title, words: [f.title] }));
    case 'model': {
      const models = [...new Set(ctx.tasks.map((t) => t.model).filter((m): m is string => !!m))].sort();
      const out = models.map((m) => ({ value: m, label: m, words: [m] }));
      if (ctx.tasks.some((t) => !t.model)) out.push({ value: 'default', label: 'default model', words: ['default'] });
      return out;
    }
    default:
      return [];
  }
}

/** Facets whose values are a list (the rest are ids and dates, parsed from what was typed). */
const LISTED: readonly FacetKind[] = ['status', 'state', 'source', 'repo', 'cat', 'group', 'feature', 'dispatch', 'model'];

/**
 * How well a query fragment names a value: 4 exact, 3 prefix, 2 the start of
 * an inner word, 1 anywhere inside (3+ characters), 0 no.
 */
function scoreWords(q: string, words: readonly string[]): number {
  let best = 0;
  for (const raw of words) {
    const w = raw.toLowerCase();
    if (w === q) return 4;
    if (w.startsWith(q)) best = Math.max(best, 3);
    else if (new RegExp(`[\\s\\-_/.:]${escapeRe(q)}`).test(w)) best = Math.max(best, 2);
    else if (q.length >= 3 && w.includes(q)) best = Math.max(best, 1);
  }
  return best;
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Typed keys, `key:value` — the documented syntax and its short forms. */
const KEY_ALIASES: Record<string, FacetKind | 'is'> = {
  repo: 'repo',
  r: 'repo',
  status: 'status',
  s: 'status',
  is: 'is',
  state: 'state',
  source: 'source',
  src: 'source',
  from: 'source',
  by: 'source',
  cat: 'cat',
  category: 'cat',
  group: 'group',
  g: 'group',
  feature: 'feature',
  f: 'feature',
  dispatch: 'dispatch',
  dispatches: 'dispatch',
  model: 'model',
  id: 'id',
  task: 'id',
  parent: 'parent',
  under: 'parent',
  created: 'created',
  filed: 'created',
  updated: 'updated',
  touched: 'updated',
  date: 'updated',
};

const HEX_ID = /^[0-9a-f][0-9a-f-]*$/;

/** The typed value of a known key → a token, or null when it names nothing. */
export function resolveTyped(key: FacetKind | 'is', rawValue: string, ctx: SearchContext): SearchToken | null {
  const value = rawValue.trim().toLowerCase();
  if (!value) return null;
  if (key === 'is') return resolveTyped('status', value, ctx) ?? resolveTyped('state', value, ctx);
  if (key === 'id') {
    const id = normalizeTaskId(value);
    return HEX_ID.test(id) ? { kind: 'id', value: id } : null;
  }
  if (key === 'parent') {
    const hit = findTaskById(ctx.tasks, value);
    if (hit.kind === 'found') return { kind: 'parent', value: hit.task.id };
    const id = normalizeTaskId(value);
    return HEX_ID.test(id) ? { kind: 'parent', value: id } : null;
  }
  if (key === 'created' || key === 'updated') {
    const expr = parseDatePhrase(value, ctx.now);
    return expr ? { kind: key, value: expr } : null;
  }
  let best: FacetOption | null = null;
  let bestScore = 0;
  for (const o of facetOptions(key, ctx)) {
    // an id typed for a group or feature names it too
    const s = Math.max(scoreWords(value, o.words), (key === 'group' || key === 'feature') && o.value.startsWith(value) && value.length >= MIN_TASK_ID_PREFIX ? 3 : 0);
    if (s > bestScore) {
      best = o;
      bestScore = s;
    }
  }
  return best ? { kind: key, value: best.value } : null;
}

// ---------------------------------------------------------------- matching

function stateMatches(state: string, t: Task, ctx: SearchContext): boolean {
  switch (state as TaskState) {
    case 'attention':
      return ctx.attention(t);
    case 'asking':
      return ctx.asking.has(t.id);
    case 'auto-review':
      return t.status === 'review' && (t.reviewState === 'pending' || t.reviewState === 'reviewing');
    case 'fixing':
      return t.reviewState === 'fixing';
    case 'flagged':
      return t.reviewState === 'flagged';
    case 'in-queue':
      return !!t.customQueueAt;
    case 'held':
      return !!t.queueHeldAt;
    case 'waking':
      return !!t.wakeAt;
    case 'auto-publish':
      return t.autoPublish;
    default:
      return false;
  }
}

function tokenMatches(tok: SearchToken, t: Task, ctx: SearchContext, range: { from: number; to: number } | null): boolean {
  switch (tok.kind) {
    case 'repo':
      return tok.value === 'none' ? !t.repoId : t.repoId === tok.value;
    case 'status':
      return t.status === tok.value;
    case 'state':
      return stateMatches(tok.value, t, ctx);
    case 'source':
      return provenanceOf(t) === tok.value;
    case 'cat':
      return tok.value === 'none' ? !t.category : t.category === tok.value;
    case 'group':
      return t.groupId === tok.value;
    case 'feature':
      return t.featureId === tok.value;
    case 'dispatch':
      return (tok.value === 'pending' ? ctx.dispatched.pending : ctx.dispatched.any).has(t.id);
    case 'model':
      return tok.value === 'default' ? !t.model : t.model === tok.value;
    case 'id':
      return t.id.toLowerCase().startsWith(tok.value);
    case 'parent':
      // the whole subtree under that task, at any depth
      return groupAncestors(t).some((a) => a.toLowerCase().startsWith(tok.value));
    case 'created':
    case 'updated': {
      if (!range) return false;
      const at = Date.parse(tok.kind === 'created' ? t.createdAt : t.updatedAt);
      return at >= range.from && at < range.to;
    }
  }
}

/** Every token kind present → OR within it; all kinds → AND. */
function compileTokens(tokens: readonly SearchToken[], ctx: SearchContext): (t: Task) => boolean {
  if (tokens.length === 0) return () => true;
  const byKind = new Map<FacetKind, { tok: SearchToken; range: { from: number; to: number } | null }[]>();
  for (const tok of tokens) {
    const range = tok.kind === 'created' || tok.kind === 'updated' ? dateRange(tok.value, ctx.now) : null;
    const list = byKind.get(tok.kind);
    if (list) list.push({ tok, range });
    else byKind.set(tok.kind, [{ tok, range }]);
  }
  const kinds = [...byKind.values()];
  return (t) => kinds.every((alts) => alts.some(({ tok, range }) => tokenMatches(tok, t, ctx, range)));
}

/** Words of a query: whitespace-separated, `"quoted phrases"` kept whole. Original case. */
export function splitWords(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"?|(\S+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const w = m[1] !== undefined ? m[1].trim() : m[2];
    if (w) out.push(m[1] !== undefined ? `"${w}"` : w);
  }
  return out;
}

const unquote = (w: string) => (w.startsWith('"') && w.endsWith('"') && w.length >= 2 ? w.slice(1, -1) : w);

/** `key:value` with a known key, split; null for anything else (a URL, `12:30`, plain words). */
function typedWord(word: string): { key: FacetKind | 'is'; value: string } | null {
  const m = /^([a-z]+):(.*)$/i.exec(word);
  if (!m) return null;
  const key = KEY_ALIASES[m[1].toLowerCase()];
  return key ? { key, value: unquote(m[2]) } : null;
}

/**
 * The text → typed tokens + plain words (lowercased). A `key:` with no value
 * yet is dropped — someone is mid-typing, the board must not blink empty. A
 * typed value that names nothing stays a plain word, so it honestly matches
 * nothing instead of being silently ignored.
 */
export function parseText(text: string, ctx: SearchContext): { typed: SearchToken[]; words: string[] } {
  const typed: SearchToken[] = [];
  const words: string[] = [];
  for (const w of splitWords(text)) {
    const tw = typedWord(w);
    if (tw) {
      if (!tw.value.trim()) continue;
      const tok = resolveTyped(tw.key, tw.value, ctx);
      if (tok) {
        typed.push(tok);
        continue;
      }
    }
    // `#3f2a…` is how a short id is written; the haystack holds it bare
    const plain = unquote(w).toLowerCase().replace(/^#(?=[0-9a-f])/, '');
    if (plain) words.push(plain);
  }
  return { typed, words };
}

/** Everything free text is matched against, one lowercase string per task. */
export function buildHaystacks(ctx: SearchContext): Map<string, string> {
  const repoName = new Map(ctx.repos.map((r) => [r.id, r.name]));
  const featureTitle = new Map(ctx.features.map((f) => [f.id, f.title]));
  const out = new Map<string, string>();
  for (const t of ctx.tasks) {
    const g = ctx.groups.get(t.groupId);
    out.set(
      t.id,
      [
        t.title,
        t.description,
        t.resultSummary,
        t.id,
        t.parentId,
        g && g.size > 1 ? `${t.groupId} ${g.label}` : null,
        t.repoId ? repoName.get(t.repoId) : null,
        t.status,
        provenanceOf(t),
        t.source,
        t.sourceRef,
        t.category,
        t.featureId ? featureTitle.get(t.featureId) : null,
        t.model,
        t.error,
        localDay(new Date(t.createdAt)),
        localDay(new Date(t.updatedAt)),
      ]
        .filter(Boolean)
        .join('\n')
        .toLowerCase(),
    );
  }
  return out;
}

/** The whole query as one predicate: chips, typed tokens and every word (as a word prefix). */
export function compileQuery(
  tokens: readonly SearchToken[],
  text: string,
  ctx: SearchContext,
  hay: ReadonlyMap<string, string>,
): (t: Task) => boolean {
  const { typed, words } = parseText(text, ctx);
  const byTokens = compileTokens([...tokens, ...typed], ctx);
  if (words.length === 0) return byTokens;
  // Spotlight's rule: a word matches the START of a word ("fail" finds
  // "failed", not "unfailing"), in any script — letters and digits are
  // Unicode classes, so Cyrillic text splits into words the same way.
  const res = words.map((w) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(w)}`, 'u'));
  return (t) => {
    if (!byTokens(t)) return false;
    const h = hay.get(t.id) ?? '';
    return res.every((re) => re.test(h));
  };
}

/** Is anything narrowing the board? */
export const isSearching = (tokens: readonly SearchToken[], text: string) => tokens.length > 0 || text.trim() !== '';

/** Add tokens without duplicates; a single-valued kind (dates) replaces its own. */
export function addTokens(tokens: readonly SearchToken[], add: readonly SearchToken[]): SearchToken[] {
  let out = [...tokens];
  for (const tok of add) {
    if (tok.kind === 'created' || tok.kind === 'updated') out = out.filter((t) => t.kind !== tok.kind);
    if (!out.some((t) => t.kind === tok.kind && t.value === tok.value)) out.push(tok);
  }
  return out;
}

/** Commit: typed `key:value` words that resolve become chips; the rest stays text. */
export function absorbTyped(tokens: readonly SearchToken[], text: string, ctx: SearchContext): { tokens: SearchToken[]; text: string } {
  const keep: string[] = [];
  const add: SearchToken[] = [];
  for (const w of splitWords(text)) {
    const tw = typedWord(w);
    const tok = tw && tw.value.trim() ? resolveTyped(tw.key, tw.value, ctx) : null;
    if (tok) add.push(tok);
    else if (!(tw && !tw.value.trim())) keep.push(w);
  }
  return { tokens: addTokens(tokens, add), text: keep.join(' ') };
}

/** A persisted token is still well-formed (localStorage is untrusted input). */
export function isToken(v: unknown): v is SearchToken {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.value === 'string' && o.value !== '' && FACET_KINDS.includes(o.kind as FacetKind);
}

/**
 * A token whose referent is gone (repo removed, group dissolved, last dispatch
 * pruned) would silently empty the board behind a chip naming nothing, so it
 * reads as absent. Every check waits for data: an empty list at boot means
 * "not loaded yet", not "gone".
 */
export function tokenLive(tok: SearchToken, ctx: SearchContext): boolean {
  switch (tok.kind) {
    case 'repo':
      return tok.value === 'none' || ctx.repos.length === 0 || ctx.repos.some((r) => r.id === tok.value);
    case 'cat':
      return tok.value === 'none' || ctx.tasks.length === 0 || ctx.tasks.some((t) => t.category === tok.value);
    case 'group':
      return ctx.tasks.length === 0 || (ctx.groups.get(tok.value)?.size ?? 0) > 1;
    case 'feature':
      return ctx.features.length === 0 || ctx.features.some((f) => f.id === tok.value);
    case 'dispatch':
      return ctx.dispatched.any.size > 0;
    case 'status':
      return (STATUSES as string[]).includes(tok.value);
    case 'state':
      return tok.value in STATE_WORDS;
    case 'source':
      return tok.value in SOURCE_WORDS;
    case 'created':
    case 'updated':
      return dateRange(tok.value, ctx.now) !== null;
    default:
      return true;
  }
}

const FACET_NAME: Record<FacetKind, string> = {
  repo: 'repo',
  status: 'status',
  state: 'is',
  source: 'source',
  cat: 'category',
  group: 'group',
  feature: 'feature',
  dispatch: 'dispatches',
  model: 'model',
  id: 'id',
  parent: 'under',
  created: 'created',
  updated: 'updated',
};

/** A chip's two halves: the facet ("repo") and what it is set to ("neko-nest"). */
export function tokenLabel(tok: SearchToken, ctx: SearchContext): { facet: string; value: string } {
  const facet = FACET_NAME[tok.kind];
  switch (tok.kind) {
    case 'repo':
      return { facet, value: tok.value === 'none' ? 'no repo' : (ctx.repos.find((r) => r.id === tok.value)?.name ?? 'unknown repo') };
    case 'state':
      return { facet, value: STATE_WORDS[tok.value as TaskState]?.label ?? tok.value };
    case 'cat':
      return { facet, value: tok.value === 'none' ? 'uncategorized' : tok.value };
    case 'group':
      return { facet, value: ctx.groups.get(tok.value)?.label ?? 'group' };
    case 'feature':
      return { facet, value: ctx.features.find((f) => f.id === tok.value)?.title ?? 'feature' };
    case 'dispatch':
      return { facet, value: tok.value === 'pending' ? 'pending' : 'any' };
    case 'model':
      return { facet, value: tok.value === 'default' ? 'default' : tok.value };
    case 'id':
      return { facet, value: `#${tok.value.slice(0, 8)}` };
    case 'parent': {
      const t = ctx.tasks.find((x) => x.id === tok.value);
      return { facet, value: t ? `#${t.id.slice(0, 8)} ${t.title}` : `#${tok.value.slice(0, 8)}` };
    }
    case 'created':
    case 'updated':
      return { facet, value: dateLabel(tok.value, ctx.now) };
    default:
      return { facet, value: tok.value };
  }
}

// ---------------------------------------------------------------- suggestions

export type Suggestion =
  /** go straight to one task (an id was typed) */
  | { key: string; type: 'open'; section: string; task: Task }
  /** keep the text as a search and close */
  | { key: string; type: 'commit'; section: string; text: string; count: number }
  /** add chips; the text becomes `nextText` (the words they came from are consumed) */
  | { key: string; type: 'tokens'; section: string; tokens: SearchToken[]; nextText: string; count: number }
  /** a matching task */
  | { key: string; type: 'task'; section: string; task: Task };

const SECTION: Record<FacetKind, string> = {
  status: 'Status',
  state: 'State',
  source: 'Source',
  repo: 'Repos',
  cat: 'Categories',
  group: 'Groups',
  feature: 'Features',
  dispatch: 'Dispatches',
  model: 'Models',
  id: 'Ids',
  parent: 'Ids',
  created: 'Dates',
  updated: 'Dates',
};

const PER_FACET = 4;
const TASK_HITS = 6;

/** A task's relevance to the words, for the Tasks section (title first). */
function relevance(t: Task, words: readonly string[]): number {
  const title = t.title.toLowerCase();
  let s = 0;
  for (const w of words) {
    if (title.startsWith(w)) s += 6;
    else if (new RegExp(`(^|[^a-z0-9])${escapeRe(w)}`).test(title)) s += 4;
    else if (title.includes(w)) s += 3;
    else if (t.id.startsWith(w)) s += 5;
    else s += 1;
  }
  return s;
}

/**
 * What the search box offers for the current input, in display order:
 * open-by-id → "search for this text" → the smart reading of the whole input
 * → facet values matching it → matching tasks. Every filter offer carries the
 * number of tasks it would leave, and offers that would leave none are dropped.
 */
export function suggest(
  text: string,
  tokens: readonly SearchToken[],
  ctx: SearchContext,
  hay: ReadonlyMap<string, string>,
): Suggestion[] {
  const out: Suggestion[] = [];
  const has = (tok: SearchToken) => tokens.some((t) => t.kind === tok.kind && t.value === tok.value);
  const countFor = (extra: SearchToken[], nextText: string) => {
    const p = compileQuery(addTokens(tokens, extra), nextText, ctx, hay);
    let n = 0;
    for (const t of ctx.tasks) if (p(t)) n++;
    return n;
  };
  const offer = (section: string, extra: SearchToken[], nextText: string) => {
    if (extra.length === 0 || extra.every(has)) return;
    const key = `tok:${extra.map((t) => `${t.kind}=${t.value}`).join('&')}:${nextText}`;
    if (out.some((s) => s.key === key)) return;
    const count = countFor(extra, nextText);
    if (count > 0) out.push({ key, type: 'tokens', section, tokens: extra, nextText, count });
  };

  const trimmed = text.trim();
  const words = splitWords(trimmed);

  // Nothing typed: a menu of the useful starting points, like Finder's.
  if (!trimmed) {
    for (const s of ['attention', 'asking', 'in-queue'] as TaskState[]) offer('Suggested', [{ kind: 'state', value: s }], '');
    for (const s of STATUSES) offer('Status', [{ kind: 'status', value: s }], '');
    offer('Dates', [{ kind: 'created', value: 'today' }], '');
    offer('Dates', [{ kind: 'updated', value: 'today' }], '');
    offer('Dates', [{ kind: 'updated', value: '7d' }], '');
    for (const o of facetOptions('repo', ctx)) offer('Repos', [{ kind: 'repo', value: o.value }], '');
    for (const o of facetOptions('source', ctx)) offer('Source', [{ kind: 'source', value: o.value }], '');
    return out;
  }

  const last = words[words.length - 1] ?? '';
  const rest = words.slice(0, -1).join(' ');

  // `key:` being typed — only that facet, filtered by what follows the colon.
  const tw = typedWord(last);
  if (tw) {
    const q = tw.value.trim().toLowerCase();
    const kinds: FacetKind[] = tw.key === 'is' ? ['status', 'state'] : [tw.key];
    for (const kind of kinds) {
      if (LISTED.includes(kind)) {
        const opts = facetOptions(kind, ctx)
          .map((o) => ({ o, s: q ? scoreWords(q, o.words) : 1 }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s);
        for (const { o } of opts.slice(0, 12)) offer(SECTION[kind], [{ kind, value: o.value }], rest);
      } else if (kind === 'created' || kind === 'updated') {
        const exprs = q ? [parseDatePhrase(q, ctx.now)] : ['today', 'yesterday', '7d', '30d'];
        for (const e of exprs) if (e) offer('Dates', [{ kind, value: e }], rest);
      } else {
        const tok = q ? resolveTyped(kind, q, ctx) : null;
        if (tok) offer('Ids', [tok], rest);
      }
    }
  }

  // An id: open it outright (the rules of Telegram's /task).
  const idq = normalizeTaskId(trimmed);
  const idLike = HEX_ID.test(idq) && idq.length >= MIN_TASK_ID_PREFIX && words.length === 1;
  if (idLike) {
    const hit = findTaskById(ctx.tasks, idq);
    if (hit.kind === 'found') out.push({ key: `open:${hit.task.id}`, type: 'open', section: 'Go to', task: hit.task });
    if (hit.kind === 'ambiguous') {
      for (const t of hit.candidates.slice(0, MAX_TASK_ID_CANDIDATES)) {
        out.push({ key: `open:${t.id}`, type: 'open', section: 'Go to', task: t });
      }
    }
  }

  // The text as typed is a search of its own — Enter keeps it. The smart
  // reading: every word (or date phrase) that names a facet becomes a chip,
  // the rest stays text ("review nest login" → status review, repo neko-nest,
  // "login"); offered only when it reads something. When the literal text
  // finds nothing but the reading does, the reading leads, so Enter takes it.
  const whole = countFor([], trimmed);
  const commit: Suggestion = { key: 'commit', type: 'commit', section: 'Search', text: trimmed, count: whole };
  const read = !tw && words.length >= 2 ? interpret(words, ctx, tokens) : null;
  if (whole > 0) out.push(commit);
  if (read && read.tokens.length > 0) offer('Smart filter', read.tokens, read.leftover.join(' '));
  if (whole === 0) out.push(commit);

  // Facet values for the whole input (multi-word names) and its last word.
  const frags: { q: string; nextText: string }[] = [];
  if (!tw) {
    const wholeQ = unquote(trimmed).toLowerCase();
    frags.push({ q: wholeQ, nextText: '' });
    if (words.length > 1) frags.push({ q: unquote(last).toLowerCase(), nextText: rest });
  }
  for (const { q, nextText } of frags) {
    for (const kind of LISTED) {
      const scored = facetOptions(kind, ctx)
        .map((o) => ({ o, s: scoreWords(q, o.words) }))
        // a single letter names only by prefix
        .filter((x) => x.s >= (q.length < 2 ? 3 : 1))
        .sort((a, b) => b.s - a.s)
        .slice(0, PER_FACET);
      for (const { o } of scored) offer(SECTION[kind], [{ kind, value: o.value }], nextText);
    }
    const expr = parseDatePhrase(q, ctx.now);
    if (expr) {
      offer('Dates', [{ kind: 'created', value: expr }], nextText);
      offer('Dates', [{ kind: 'updated', value: expr }], nextText);
    }
    const id = normalizeTaskId(q);
    if (HEX_ID.test(id) && id.length >= MIN_TASK_ID_PREFIX) {
      offer('Ids', [{ kind: 'id', value: id }], nextText);
      const p = findTaskById(ctx.tasks, id);
      if (p.kind === 'found') offer('Ids', [{ kind: 'parent', value: p.task.id }], nextText);
    }
  }

  // Tasks the whole query finds, best title match first.
  const pred = compileQuery(tokens, trimmed, ctx, hay);
  const { words: plain } = parseText(trimmed, ctx);
  const opened = new Set(out.filter((s) => s.type === 'open').map((s) => (s as { task: Task }).task.id));
  const hits = ctx.tasks
    .filter((t) => !opened.has(t.id) && pred(t))
    .map((t) => ({ t, s: relevance(t, plain) }))
    .sort((a, b) => b.s - a.s || b.t.updatedAt.localeCompare(a.t.updatedAt))
    .slice(0, TASK_HITS);
  for (const { t } of hits) out.push({ key: `task:${t.id}`, type: 'task', section: 'Tasks', task: t });
  return out;
}

/**
 * Read a multi-word input as facets: date phrases of up to three words first
 * (`last 7 days`, `sep 30`), then each word that names a status, state,
 * source, repo or category outright and unambiguously (exact, a prefix of 3+
 * letters, or for a repo/category the start of an inner word: "nest"). A
 * date beside a settled status means "finished then" → `updated`, otherwise
 * "filed then" → `created`.
 */
function interpret(
  words: readonly string[],
  ctx: SearchContext,
  existing: readonly SearchToken[],
): { tokens: SearchToken[]; leftover: string[] } {
  const tokens: SearchToken[] = [];
  const leftover: string[] = [];
  const dates: string[] = [];
  const lower = words.map((w) => unquote(w).toLowerCase());
  for (let i = 0; i < words.length; ) {
    let took = 0;
    for (const n of [3, 2, 1]) {
      if (i + n > words.length || words.slice(i, i + n).some((w) => w.startsWith('"'))) continue;
      const expr = parseDatePhrase(lower.slice(i, i + n).join(' '), ctx.now);
      // a bare number is not a date, and a lone month word is too eager to be
      if (expr && !(n === 1 && /^\d{4}-\d{2}$/.test(expr) && !/^\d/.test(lower[i]))) {
        dates.push(expr);
        took = n;
        break;
      }
    }
    if (!took && !words[i].startsWith('"')) {
      const q = lower[i];
      // the best reading, and only if it is the ONLY one at that strength:
      // "neko" prefixes two repos, so it stays a word
      let best: SearchToken | null = null;
      let bestScore = 0;
      let tied = false;
      for (const kind of ['status', 'state', 'source', 'repo', 'cat'] as FacetKind[]) {
        for (const o of facetOptions(kind, ctx)) {
          const s = scoreWords(q, o.words);
          // a repo or category may be named by an inner word: "nest" → neko-nest
          const strong = s === 4 || (q.length >= 3 && (s === 3 || (s === 2 && (kind === 'repo' || kind === 'cat'))));
          if (!strong) continue;
          if (s > bestScore) {
            best = { kind, value: o.value };
            bestScore = s;
            tied = false;
          } else if (s === bestScore && !(best && best.kind === kind && best.value === o.value)) tied = true;
        }
      }
      if (best && !tied) {
        tokens.push(best);
        took = 1;
      }
    }
    if (!took) {
      leftover.push(words[i]);
      took = 1;
    }
    i += took;
  }
  const statuses = [...existing, ...tokens].filter((t) => t.kind === 'status').map((t) => t.value);
  const field = statuses.length > 0 && statuses.every((s) => SETTLED.has(s)) ? 'updated' : 'created';
  for (const d of dates) tokens.push({ kind: field, value: d });
  return { tokens, leftover };
}
