import type { Chat, Feature, Repo, Task, Workspace } from '@tm/shared';
import type { TaskAction } from './taskActions.ts';
import { MIN_TASK_ID_PREFIX, normalizeTaskId } from './taskId.ts';

/**
 * The ⌘K palette's pure core (docs/palette.md): the entry model, a fuzzy
 * scorer, the ranking and the MRU. No React, no DOM but localStorage — the
 * overlay (components/Palette.tsx) feeds it the app state and the effects.
 */

/**
 * What a palette line is about. `context` = one task's actions (the open
 * panel's, or the task Tab/→ drilled into); `action` = the global commands.
 */
export type PaletteSection = 'context' | 'action' | 'task' | 'page' | 'workspace' | 'repo' | 'feature' | 'chat';

export interface PaletteEntry {
  /** stable across renders and sessions: the MRU key (`task:<id>`, `page:/board`) */
  id: string;
  section: PaletteSection;
  title: string;
  /** muted second reading (repo, path, status) — matched with a lower weight */
  subtitle?: string;
  /** words that should find it without being shown (an alias, a role) */
  keywords?: string[];
  /** right-aligned mono hint (a task's id8) */
  hint?: string;
  /** a task line's row, for its status badge */
  task?: Task;
  /** shown first on an empty query (the board's "Search the board…") */
  pinned?: boolean;
  /** a task found by its id: listed even outside the workspace, and first */
  idHit?: boolean;
  /** offered but refused for now: listed, muted, the subtitle says why; ↵ does nothing */
  disabled?: boolean;
  /**
   * Two-press arm (src/arm.ts): the first ↵ swaps the title for this question,
   * a second ↵ on the same line within 4 s runs it. `armKey` is the arm's key —
   * a task action's is the panel's own scheme, `<taskId>:<actionId>`.
   */
  confirm?: string;
  armKey?: string;
  /** a step into a sub-list or an input (Follow-up…, New task…): the palette stays open */
  keepOpen?: boolean;
  /** the page this action opens: its plain page line is dropped while a query lists both */
  page?: string;
  /**
   * What the pick does. A promise is awaited: `false` (a refusal, already
   * toasted) keeps the palette open on the line; anything else closes it.
   */
  run(): void | Promise<boolean | void>;
}

export const SECTION_LABEL: Record<PaletteSection, string> = {
  context: 'This task',
  action: 'Actions',
  task: 'Tasks',
  page: 'Pages',
  workspace: 'Workspaces',
  repo: 'Repos',
  feature: 'Features',
  chat: 'Chats',
};

/** sections in a tie, and the empty query's order */
const SECTION_ORDER: PaletteSection[] = ['context', 'action', 'task', 'page', 'workspace', 'repo', 'feature', 'chat'];

/** lines per section with a query; tasks get more, they are what is looked for */
const SECTION_CAP: Record<PaletteSection, number> = {
  context: 20,
  action: 6,
  task: 8,
  page: 14,
  workspace: 6,
  repo: 5,
  feature: 5,
  chat: 5,
};

/** recent tasks on an empty query */
export const EMPTY_RECENT_TASKS = 6;

// ── fuzzy scorer ────────────────────────────────────────────────────────────

/**
 * How well one query word matches `text` (both any case), or null. The tiers
 * are coarse on purpose — ranking reads them before recency (rankEntries):
 *   prefix of the text 100 · start of a word 80 · substring 60 ·
 *   subsequence 1..30 (word starts and runs score, gaps cost).
 * A subsequence spread wider than four times the word is not a match: `fail`
 * must not find "fix all icons".
 */
export function scoreWord(word: string, text: string): number | null {
  const w = word.toLowerCase();
  const s = text.toLowerCase();
  if (!w) return 0;
  if (s.startsWith(w)) return 100;
  const at = s.indexOf(w);
  if (at > 0) return isWordStart(s, at) || wordStartAt(s, w) ? 80 : 60;
  if (w.length < 2) return null;
  let score = 0;
  let from = 0;
  let first = -1;
  let prev = -2;
  for (const ch of w) {
    const i = s.indexOf(ch, from);
    if (i < 0) return null;
    if (first < 0) first = i;
    if (i === prev + 1) score += 3;
    if (isWordStart(s, i)) score += 4;
    score += 1;
    prev = i;
    from = i + 1;
  }
  const span = prev - first + 1;
  if (span > w.length * 4) return null;
  return Math.max(1, Math.min(30, score - (span - w.length)));
}

function isWordStart(s: string, i: number): boolean {
  if (i === 0) return true;
  const before = s[i - 1];
  return !/[a-z0-9]/.test(before);
}

/** a later occurrence of `w` that starts a word (indexOf found a mid-word one first) */
function wordStartAt(s: string, w: string): boolean {
  for (let i = s.indexOf(w, 1); i >= 0; i = s.indexOf(w, i + 1)) if (isWordStart(s, i)) return true;
  return false;
}

/**
 * An entry against a whole query: every word must match the title, a keyword
 * or the subtitle (weights 1 · 0.8 · 0.6); the entry scores the sum. null = no
 * match. An empty query scores 0.
 */
export function scoreEntry(entry: Pick<PaletteEntry, 'title' | 'subtitle' | 'keywords'>, query: string): number | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  let total = 0;
  for (const w of words) {
    let best: number | null = null;
    const take = (s: number | null, weight: number) => {
      if (s !== null && (best === null || s * weight > best)) best = s * weight;
    };
    take(scoreWord(w, entry.title), 1);
    for (const k of entry.keywords ?? []) take(scoreWord(w, k), 0.8);
    if (entry.subtitle) take(scoreWord(w, entry.subtitle), 0.6);
    if (best === null) return null;
    total += best;
  }
  return total;
}

/** strong (a prefix/word/substring on every word) vs weak (some word only a subsequence) */
function tier(score: number, words: number): 0 | 1 {
  return words > 0 && score / words >= 36 ? 0 : 1;
}

// ── ranking ─────────────────────────────────────────────────────────────────

export interface RankedSection {
  section: PaletteSection;
  entries: PaletteEntry[];
}

/**
 * The palette's list. An empty query: the open task's actions (`context`),
 * the pinned entries, then the recent tasks (MRU first, then `updatedAt` desc
 * — the caller hands tasks in that order), then every page. A query: the
 * entries that match, per section ordered by tier, then MRU position, then the
 * caller's order (`updatedAt` desc for tasks), and sections by their best
 * tier, then their best score, then SECTION_ORDER. A task found by its id
 * (`idHit`) leads everything; the open task's matching actions come next.
 */
export function rankEntries(entries: readonly PaletteEntry[], query: string, recent: readonly string[]): RankedSection[] {
  const mru = new Map(recent.map((id, i) => [id, i]));
  // not in the MRU sorts after every entry that is, in the caller's order
  const mruPos = (e: PaletteEntry) => mru.get(e.id) ?? recent.length;
  const q = query.trim();

  if (!q) {
    const context = entries.filter((e) => e.section === 'context');
    const pinned = entries.filter((e) => e.pinned && e.section !== 'context');
    const tasks = stable(
      entries.filter((e) => e.section === 'task' && !e.idHit),
      (a, b) => mruPos(a) - mruPos(b),
    ).slice(0, EMPTY_RECENT_TASKS);
    const pages = entries.filter((e) => e.section === 'page');
    const out: RankedSection[] = [];
    if (context.length) out.push({ section: 'context', entries: context });
    if (pinned.length) out.push({ section: 'action', entries: pinned });
    if (tasks.length) out.push({ section: 'task', entries: tasks });
    if (pages.length) out.push({ section: 'page', entries: pages });
    return out;
  }

  const words = q.split(/\s+/).length;
  const scored: { e: PaletteEntry; t: number; s: number; i: number }[] = [];
  entries.forEach((e, i) => {
    if (e.idHit) {
      scored.push({ e, t: -1, s: Number.POSITIVE_INFINITY, i });
      return;
    }
    const s = scoreEntry(e, q);
    if (s !== null) scored.push({ e, t: tier(s, words), s, i });
  });

  const by = new Map<PaletteSection, typeof scored>();
  for (const s of scored) {
    const list = by.get(s.e.section) ?? [];
    list.push(s);
    by.set(s.e.section, list);
  }
  const sections: { section: PaletteSection; best: number; top: number; list: typeof scored }[] = [];
  for (const [section, list] of by) {
    // one task's actions keep the builder's order (the panel's); only the tier moves them
    list.sort((a, b) => a.t - b.t || (section === 'context' ? 0 : mruPos(a.e) - mruPos(b.e)) || a.i - b.i);
    const top = Math.max(...list.map((x) => x.s));
    sections.push({ section, best: list[0].t, top, list: list.slice(0, SECTION_CAP[section]) });
  }
  // a title that IS the query (the workspace "Neko") beats tasks whose repo merely contains it
  // an id hit, then the open task's actions, lead whatever they score
  const lead = (x: (typeof sections)[number]) => (x.best < 0 ? 0 : x.section === 'context' ? 1 : 2);
  sections.sort(
    (a, b) =>
      lead(a) - lead(b) ||
      a.best - b.best ||
      b.top - a.top ||
      SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section),
  );
  return sections.map((s) => ({ section: s.section, entries: s.list.map((x) => x.e) }));
}

/** Array.prototype.sort is stable; a copy keeps the caller's array alone */
function stable<T>(xs: T[], cmp: (a: T, b: T) => number): T[] {
  return [...xs].sort(cmp);
}

/** the ranked sections flattened: the keyboard's ↑/↓ walk this */
export function flatEntries(sections: readonly RankedSection[]): PaletteEntry[] {
  return sections.flatMap((s) => s.entries);
}

// ── MRU ─────────────────────────────────────────────────────────────────────

export const PALETTE_RECENT_KEY = 'tm.palette.recent';
const RECENT_MAX = 30;

/** localStorage is untrusted input: anything but an array of short strings reads as empty */
export function readRecent(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PALETTE_RECENT_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200).slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** move `id` to the front; a full or unavailable storage is ignored */
export function pushRecent(id: string): void {
  try {
    const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX);
    localStorage.setItem(PALETTE_RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private mode, quota: the palette still works, it just forgets */
  }
}

// ── sources ─────────────────────────────────────────────────────────────────

export interface PalettePage {
  to: string;
  label: string;
  keywords?: string[];
}

/**
 * Pages the sidebar does not list but the palette should reach. Each is
 * offered only while the router knows its path (`hasRoute`), so a page that
 * has not shipped yet is skipped rather than a dead link.
 */
export const EXTRA_PAGES: PalettePage[] = [
  { to: '/inbox/deck', label: 'Review deck', keywords: ['inbox', 'reviews', 'deck'] },
  { to: '/inbox/drafts', label: 'Draft triage', keywords: ['inbox', 'agent', 'drafts', 'stale'] },
];

export interface PaletteSources {
  tasks: readonly Task[];
  repos: readonly Repo[];
  features: readonly Feature[];
  chats: readonly Chat[];
  workspaces: readonly Workspace[];
  pages: readonly PalettePage[];
  /** the current workspace's slug (null = All) */
  currentWorkspace: string | null;
  inScopeRepo(repoId: string | null): boolean;
  hasRoute(path: string): boolean;
  query: string;
  /** on /board: the "Search the board…" entry */
  onBoard: boolean;
  /**
   * Built by the caller and listed as they are: the global commands
   * (`globalActionEntries`) and the open panel's task actions
   * (`taskActionEntries`). An action with a `page` drops that page's plain
   * line while a query is typed, so "inbox" is not listed twice.
   */
  actions?: readonly PaletteEntry[];
}

export interface PaletteEffects {
  openTask(id: string): void;
  go(path: string): void;
  setWorkspace(slug: string | null): void;
  searchBoard(): void;
}

export const id8 = (id: string) => id.slice(0, 8);

/**
 * Every navigation entry for the current state. Tasks, features, chats and
 * repos follow the workspace (a repo-less item is in every scope); a task
 * named by its id is found anywhere, hidden or out of scope, because an id is
 * a deliberate pick. Tasks come out `updatedAt` desc — the ranking's last key.
 */
export function buildEntries(src: PaletteSources, fx: PaletteEffects): PaletteEntry[] {
  const repoName = new Map(src.repos.map((r) => [r.id, r.name]));
  const out: PaletteEntry[] = [];

  if (src.onBoard) {
    out.push({
      id: 'action:board-search',
      section: 'action',
      title: 'Search the board…',
      subtitle: 'filters, sort and grouping',
      keywords: ['find', 'filter', 'board'],
      hint: '/',
      pinned: true,
      run: fx.searchBoard,
    });
  }

  const actions = src.actions ?? [];
  out.push(...actions);
  // with a query the "Open Inbox" action stands in for the Inbox page line;
  // an empty query lists the pages and leaves the open-actions to a search
  const covered = new Set(src.query.trim() ? actions.flatMap((a) => (a.page ? [a.page] : [])) : []);

  const hits = idHits(src.tasks, src.query);
  const hitIds = new Set(hits.map((t) => t.id));
  const taskEntry = (t: Task, idHit: boolean): PaletteEntry => ({
    id: `task:${t.id}`,
    section: 'task',
    title: t.title || '(untitled)',
    subtitle: t.repoId ? (repoName.get(t.repoId) ?? undefined) : undefined,
    hint: id8(t.id),
    task: t,
    idHit,
    run: () => fx.openTask(t.id),
  });
  for (const t of hits) out.push(taskEntry(t, true));
  const tasks = src.tasks
    .filter((t) => !t.hiddenAt && src.inScopeRepo(t.repoId) && !hitIds.has(t.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const t of tasks) out.push(taskEntry(t, false));

  const seen = new Set<string>();
  for (const p of [...src.pages, ...EXTRA_PAGES]) {
    if (seen.has(p.to) || covered.has(p.to) || !src.hasRoute(p.to)) continue;
    seen.add(p.to);
    out.push({
      id: `page:${p.to}`,
      section: 'page',
      title: p.label,
      subtitle: p.to,
      keywords: p.keywords,
      run: () => fx.go(p.to),
    });
  }

  out.push({
    id: 'workspace:',
    section: 'workspace',
    title: 'All repos',
    subtitle: src.currentWorkspace === null ? 'current workspace' : 'workspace · every repo',
    keywords: ['all', 'workspace'],
    run: () => fx.setWorkspace(null),
  });
  for (const w of src.workspaces) {
    const n = w.repoIds.length;
    out.push({
      id: `workspace:${w.id}`,
      section: 'workspace',
      title: w.name,
      subtitle: `${w.slug === src.currentWorkspace ? 'current workspace' : 'workspace'} · ${n} repo${n === 1 ? '' : 's'}`,
      keywords: [w.slug, 'workspace'],
      run: () => fx.setWorkspace(w.slug),
    });
  }

  for (const r of src.repos) {
    if (!src.inScopeRepo(r.id)) continue;
    out.push({
      id: `repo:${r.id}`,
      section: 'repo',
      title: r.name,
      subtitle: r.path,
      keywords: ['repo'],
      run: () => fx.go('/repos'),
    });
  }

  for (const f of [...src.features].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    if (!src.inScopeRepo(f.repoId)) continue;
    const repo = f.repoId ? repoName.get(f.repoId) : undefined;
    out.push({
      id: `feature:${f.id}`,
      section: 'feature',
      title: f.title || '(untitled feature)',
      subtitle: [repo, f.status].filter(Boolean).join(' · '),
      keywords: ['feature'],
      hint: id8(f.id),
      run: () => fx.go(`/features/${encodeURIComponent(f.id)}`),
    });
  }

  const chatAt = (c: Chat) => c.lastMessageAt ?? c.updatedAt;
  for (const c of [...src.chats].sort((a, b) => chatAt(b).localeCompare(chatAt(a)))) {
    // an office group chat lives on /office, not /chat (docs/office.md § Group chat)
    if (c.officeId || c.plannerWorkspaceId || !src.inScopeRepo(c.repoId)) continue;
    out.push({
      id: `chat:${c.id}`,
      section: 'chat',
      title: c.title || '(untitled chat)',
      subtitle: repoName.get(c.repoId),
      keywords: ['chat'],
      run: () => fx.go(`/chat/${encodeURIComponent(c.id)}`),
    });
  }

  return out;
}

// ── actions ─────────────────────────────────────────────────────────────────

/**
 * The task panel's actions the palette offers (docs/palette.md § Task
 * actions), by `buildTaskActions` id: run-now (Retry now), queue, enqueue
 * (Retry), complete, publish, mark-published, review-now, the three cancels,
 * hide/unhide and the terminal. The rest (undo, release, delete, analyze…)
 * stay on the panel.
 */
export const PALETTE_TASK_ACTION_IDS: readonly string[] = [
  'run-now',
  'queue',
  'enqueue',
  'complete',
  'publish',
  'mark-published',
  'review-now',
  'cancel',
  'dequeue',
  'unqueue',
  'hide',
  'unhide',
  'terminal',
];

export interface TaskActionEffects {
  /** press one builder action (the palette awaits it, then closes unless refused) */
  run(a: TaskAction): Promise<boolean | void>;
  /** "Follow-up…": the palette's message step; null = not offered */
  followUp: (() => void) | null;
  /** the follow-up line's subtitle (what ↵ will do with the message) */
  followUpHint?: string;
  /** the arm question's ending in place of the builder's "click/tap again" (a desktop's ↵) */
  again?: string;
}

/**
 * One task's palette actions, in the builder's (the panel's) order, filtered
 * to PALETTE_TASK_ACTION_IDS, with Follow-up… before the terminal. Labels,
 * disabled reasons (`title`) and arm questions (`confirm`) are the builder's,
 * so the palette and the panel cannot drift.
 */
export function taskActionEntries(task: Task, actions: readonly TaskAction[], fx: TaskActionEffects): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  const followUp = (): PaletteEntry | null =>
    fx.followUp && {
      id: `taskaction:${task.id}:follow-up`,
      section: 'context',
      title: 'Follow-up…',
      subtitle: fx.followUpHint ?? 'a new instruction to its session',
      keywords: ['follow', 'message', 'instruct', 'resume', 'proceed', 'continue'],
      keepOpen: true,
      run: fx.followUp,
    };
  for (const a of actions) {
    if (!PALETTE_TASK_ACTION_IDS.includes(a.id)) continue;
    if (a.id === 'terminal') {
      const f = followUp();
      if (f) out.push(f);
    }
    out.push({
      id: `taskaction:${task.id}:${a.id}`,
      section: 'context',
      title: a.label,
      subtitle: a.title,
      keywords: a.short ? [a.short] : undefined,
      disabled: a.disabled,
      confirm: a.confirm && fx.again ? a.confirm.replace(/\b(click|tap) again$/, fx.again) : a.confirm,
      armKey: a.confirm ? `${task.id}:${a.id}` : undefined,
      run: () => fx.run(a),
    });
  }
  if (!actions.some((a) => a.id === 'terminal')) {
    const f = followUp();
    if (f) out.push(f);
  }
  return out;
}

export interface GlobalActionSources {
  /** `OrchestratorStatus.paused` / `.pausedTasks` */
  paused: boolean;
  pausedTasks: number;
  /** the arm question's "tap" vs "click" */
  mobile: boolean;
  /** the current workspace's name (null = All repos) */
  workspaceName: string | null;
  hasRoute(path: string): boolean;
}

export interface GlobalActionEffects {
  newTask(): void;
  /** Pause all / Continue: resolves false on a refusal (toasted) */
  pauseOrContinue(): Promise<boolean>;
  switchWorkspace(): void;
  go(path: string): void;
}

/** the "Open …" commands and the page each opens */
export const OPEN_ACTIONS: readonly { page: string; title: string; keywords: string[] }[] = [
  { page: '/inbox', title: 'Open Inbox', keywords: ['inbox', 'decisions', 'waiting'] },
  { page: '/inbox/deck', title: 'Open Review deck', keywords: ['deck', 'reviews', 'inbox'] },
  { page: '/inbox/drafts', title: 'Open Draft triage', keywords: ['triage', 'drafts', 'agent', 'stale'] },
  { page: '/timeline', title: 'Open Timeline', keywords: ['timeline', 'schedule', 'history'] },
];

/**
 * The global commands (docs/palette.md § Global actions). New task… and
 * Pause all / Continue are pinned (listed on an empty query); the rest are
 * found by typing. Pause/Continue arm like the header's PauseButton.
 */
export function globalActionEntries(src: GlobalActionSources, fx: GlobalActionEffects): PaletteEntry[] {
  const again = src.mobile ? 'tap again' : 'press ↵ again';
  const verb = src.paused ? 'continue' : 'pause';
  const out: PaletteEntry[] = [
    {
      id: 'action:new-task',
      section: 'action',
      title: 'New task…',
      subtitle: src.workspaceName ? `a draft in ${src.workspaceName}` : 'a draft',
      keywords: ['create', 'add', 'draft', 'task'],
      pinned: true,
      keepOpen: true,
      run: fx.newTask,
    },
    {
      id: 'action:pause',
      section: 'action',
      title: src.paused ? `Continue${src.pausedTasks ? ` (${src.pausedTasks})` : ''}` : 'Pause all',
      subtitle: src.paused
        ? 'resume the suspended turns in their own sessions, then the queues'
        : 'suspend every live agent turn and start nothing until Continue',
      keywords: ['pause', 'continue', 'resume', 'stop', 'hold'],
      pinned: true,
      confirm: `${src.paused ? 'Continue' : 'Pause all'}? ${again}`,
      armKey: `global:${verb}`,
      run: fx.pauseOrContinue,
    },
    {
      id: 'action:workspace',
      section: 'action',
      title: 'Switch workspace…',
      subtitle: src.workspaceName ? `now ${src.workspaceName}` : 'now All repos',
      keywords: ['workspace', 'scope', 'switch'],
      keepOpen: true,
      run: fx.switchWorkspace,
    },
  ];
  for (const o of OPEN_ACTIONS) {
    if (!src.hasRoute(o.page)) continue;
    out.push({
      id: `action:open:${o.page}`,
      section: 'action',
      title: o.title,
      subtitle: o.page,
      keywords: ['open', 'go', ...o.keywords],
      page: o.page,
      run: () => fx.go(o.page),
    });
  }
  return out;
}

/**
 * A sub-list's lines (a task's actions, the workspaces, the repos to file
 * into): every line in the builder's order on an empty query, else ranked.
 */
export function rankSubList(entries: readonly PaletteEntry[], query: string): RankedSection[] {
  if (!query.trim()) return entries.length ? [{ section: entries[0].section, entries: [...entries] }] : [];
  return rankEntries(entries, query, []);
}

/**
 * Tasks the query names by id: the full id, or a prefix of at least
 * MIN_TASK_ID_PREFIX characters (the 8-char id8 everywhere in the UI is one),
 * the rules `findTaskById` uses. Only a single-word query that looks like an
 * id (hex and dashes) is read as one, so a title word is never an id hit.
 */
export function idHits(tasks: readonly Task[], query: string): Task[] {
  const q = normalizeTaskId(query);
  if (!/^[0-9a-f-]+$/.test(q) || q.length < MIN_TASK_ID_PREFIX) return [];
  const exact = tasks.find((t) => t.id.toLowerCase() === q);
  if (exact) return [exact];
  return tasks
    .filter((t) => t.id.toLowerCase().startsWith(q))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);
}

// ── open from anywhere ──────────────────────────────────────────────────────

/** window event: open the palette (the phone header's search button, the More sheet) */
export const PALETTE_OPEN_EVENT = 'tm-palette';
/** window event the board search listens for: the palette's "Search the board…" */
export const BOARD_SEARCH_EVENT = 'tm-board-search';

export function openPalette(): void {
  window.dispatchEvent(new Event(PALETTE_OPEN_EVENT));
}
