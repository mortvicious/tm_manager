import fs from 'node:fs';
import type { RunActivity, TodoCounts } from '@tm/shared';

/**
 * Live "what is this agent doing right now" line for the Board.
 *
 * Source is the claude session transcript, not the PTY bytes: the terminal
 * stream is Ink re-rendering itself with cursor moves, so any line extracted
 * from it is a guess, while the transcript already carries exactly the two
 * things the terminal prints — the tool the agent just invoked and the text it
 * just said. Tailing it also costs nothing when nothing is running.
 */

const MAX_TEXT = 110;
/** never re-read more than this on a jump (resumed runs share a fat transcript) */
const MAX_CATCHUP = 512 * 1024;

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

const cut = (s: string, n = MAX_TEXT): string =>
  s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;

const baseName = (p: string): string => {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
};

const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname;
  } catch {
    return clean(u);
  }
};

/** Renders one tool call the way the terminal narrates it. */
export function describeTool(name: string, input: unknown): string {
  // mcp__<server>__<tool> reads as the tool alone; the server prefix is noise
  const short = name.startsWith('mcp__') ? name.split('__').slice(2).join('__') || name : name;
  const obj: Record<string, unknown> = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const str = (k: string): string => (typeof obj[k] === 'string' ? (obj[k] as string) : '');

  // `Read` alone beats `Read ` — an absent argument must not leave a dangle
  const withArg = (verb: string, arg: string): string => (arg ? `${verb} ${arg}` : verb);

  switch (short) {
    case 'Bash':
      // the agent writes a human description for every Bash call — that IS the
      // narration line; the raw command is the fallback when it omitted one
      return clean(str('description')) || `$ ${clean(str('command'))}` || short;
    case 'BashOutput':
      return 'Checking background output';
    case 'KillShell':
      return 'Stopping a background shell';
    case 'Read':
      return withArg('Read', baseName(clean(str('file_path'))));
    case 'Write':
      return withArg('Write', baseName(clean(str('file_path'))));
    case 'Edit':
    case 'MultiEdit':
      return withArg('Edit', baseName(clean(str('file_path'))));
    case 'NotebookEdit':
      return withArg('Edit', baseName(clean(str('notebook_path'))));
    case 'Glob':
      return withArg('Glob', clean(str('pattern')));
    case 'Grep':
      return withArg('Grep', clean(str('pattern')));
    case 'Task':
    case 'Agent':
      return `Subagent · ${clean(str('description')) || clean(str('subagent_type')) || 'working'}`;
    case 'WebSearch':
      return withArg('Search', clean(str('query')));
    case 'WebFetch':
      return withArg('Fetch', hostOf(str('url')));
    case 'TodoWrite':
    case 'TaskUpdate':
      return 'Updating the todo list';
    case 'TaskCreate':
      return withArg('Todo ·', clean(str('subject')));
    case 'Skill':
      return withArg('Skill', clean(str('skill')));
    case 'ExitPlanMode':
      return 'Presenting a plan';
    default: {
      const first = Object.values(obj).find((v) => typeof v === 'string' && v.trim() !== '');
      return first ? `${short} ${clean(first as string)}` : short;
    }
  }
}

export interface ParsedActivity {
  text: string;
  kind: 'tool' | 'text';
  at: string | null;
}

/**
 * The activity a single transcript line implies, or null when it implies none
 * (tool results, meta records, sidechain traffic).
 */
export function activityFromLine(line: string): ParsedActivity | null {
  if (!line.trim()) return null;
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return null; // half-written line, or not JSONL at all
  }
  // A subagent's turns are not this session's narration — the parent's own
  // `Subagent · …` line already says a subagent is running (mirrors the
  // isSidechain filter stats.ts uses for context %).
  if (j?.isSidechain === true) return null;
  const msg = j?.message;
  if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) return null;

  // Blocks are in the order the terminal printed them, so the last renderable
  // one is the newest thing on screen.
  let found: ParsedActivity | null = null;
  const at = typeof j.timestamp === 'string' ? j.timestamp : null;
  for (const b of msg.content) {
    if (b?.type === 'tool_use' && typeof b.name === 'string') {
      found = { text: cut(clean(describeTool(b.name, b.input))), kind: 'tool', at };
    } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') {
      found = { text: cut(clean(b.text)), kind: 'text', at };
    }
  }
  return found && found.text ? found : null;
}

type TodoStatus = 'pending' | 'in_progress' | 'completed';
const TODO_STATUSES: readonly string[] = ['pending', 'in_progress', 'completed'];
/** cheap gate before a JSON.parse: only these lines can move a todo list */
const TODO_HINT = /"(?:TodoWrite|TaskCreate|TaskUpdate)"/;

/**
 * The agent's todo list, rebuilt from the transcript (docs/task-progress.md § Todo
 * list). Two shapes exist: the older `TodoWrite` rewrites the WHOLE list on
 * every call (`input.todos[]{content,status}`), the newer task tools build it
 * call by call — `TaskCreate {subject}` (its id comes back in the result:
 * `toolUseResult.task.id`, or "Task #3 created…" in the text) and
 * `TaskUpdate {taskId, status}` (`deleted` drops it). Whichever was touched
 * last is the list. Sidechain lines are a subagent's own list, never this one.
 */
export class TodoTracker {
  private written: TodoStatus[] | null = null;
  private tasks = new Map<string, TodoStatus>();
  /** TaskCreate tool_use ids waiting for the result that names the task */
  private creating = new Set<string>();
  private seq = 0;
  private mode: 'write' | 'tasks' | null = null;
  /** transcript time of the newest call that touched the list */
  lastAt: string | null = null;

  feed(line: string): void {
    const hinted = TODO_HINT.test(line);
    if (!hinted && (this.creating.size === 0 || !line.includes('"tool_result"'))) return;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    if (j?.isSidechain === true) return;
    const msg = j?.message;
    if (!Array.isArray(msg?.content)) return;
    const at = typeof j.timestamp === 'string' ? j.timestamp : null;
    for (const b of msg.content) {
      if (msg.role === 'assistant' && b?.type === 'tool_use') {
        const input = typeof b.input === 'object' && b.input !== null ? b.input : {};
        if (b.name === 'TodoWrite' && Array.isArray(input.todos)) {
          this.written = input.todos
            .map((t: any) => t?.status)
            .filter((st: unknown): st is TodoStatus => typeof st === 'string' && TODO_STATUSES.includes(st));
          this.touch('write', at);
        } else if (b.name === 'TaskCreate' && typeof b.id === 'string') {
          this.creating.add(b.id);
        } else if (b.name === 'TaskUpdate' && input.taskId != null) {
          const id = String(input.taskId);
          if (input.status === 'deleted') this.tasks.delete(id);
          else if (typeof input.status === 'string' && TODO_STATUSES.includes(input.status))
            this.tasks.set(id, input.status as TodoStatus);
          else continue;
          this.touch('tasks', at);
        }
      } else if (msg.role === 'user' && b?.type === 'tool_result' && this.creating.has(b.tool_use_id)) {
        this.creating.delete(b.tool_use_id);
        if (b.is_error === true) continue;
        const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => c?.text ?? '').join(' ') : '';
        const named = j.toolUseResult?.task?.id ?? /Task #(\w+)/.exec(text)?.[1];
        const id = named != null ? String(named) : String(++this.seq);
        const n = Number(id);
        if (Number.isFinite(n)) this.seq = Math.max(this.seq, n);
        if (!this.tasks.has(id)) this.tasks.set(id, 'pending');
        this.touch('tasks', at);
      }
    }
  }

  private touch(mode: 'write' | 'tasks', at: string | null): void {
    this.mode = mode;
    if (at) this.lastAt = at;
  }

  /** The counts, when the list was last touched at or after `sinceIso` (null = any time). */
  counts(sinceIso: string | null): TodoCounts | null {
    if (!this.mode) return null;
    if (sinceIso && (!this.lastAt || Date.parse(this.lastAt) < Date.parse(sinceIso))) return null;
    const list = this.mode === 'write' ? (this.written ?? []) : [...this.tasks.values()];
    if (list.length === 0) return null;
    let done = 0;
    let inProgress = 0;
    for (const st of list) {
      if (st === 'completed') done++;
      else if (st === 'in_progress') inProgress++;
    }
    return { done, inProgress, total: list.length };
  }
}

const sameTodos = (a: TodoCounts | null | undefined, b: TodoCounts | null | undefined): boolean =>
  (a ?? null) === (b ?? null) ||
  (!!a && !!b && a.done === b.done && a.inProgress === b.inProgress && a.total === b.total);

/** the todo pre-scan of a resumed transcript reads at most this much from its end */
const MAX_TODO_SCAN = 64 * 1024 * 1024;
const SCAN_CHUNK = 1024 * 1024;

interface Tail {
  runId: string;
  taskId: string | null;
  path: string;
  /** the run's start: an older todo list belongs to an earlier turn */
  startedAt: string | null;
  offset: number;
  partial: string;
  last: RunActivity | null;
  todos: TodoTracker;
}

export interface WatchedRun {
  runId: string;
  taskId: string | null;
  transcriptPath: string | null;
  startedAt?: string | null;
}

const POLL_MS = 1200;
const RECONCILE_MS = 4000;

/**
 * Tails the transcripts of the currently live runs and emits a line whenever
 * it changes. Self-healing by design: the run list is re-read from storage
 * rather than pushed in, so a dropped SessionStart hook or a restart cannot
 * leave the Board permanently blank.
 */
export class ActivityWatcher {
  private tails = new Map<string, Tail>();
  private timers: NodeJS.Timeout[] = [];
  private polling = false;
  private reconciling = false;

  constructor(
    private opts: {
      /** live, non-idle runs — the only ones with something to narrate */
      liveRuns: () => Promise<WatchedRun[]>;
      /** cheap in-memory gate so an idle server never touches the DB */
      hasLiveSessions: () => boolean;
      emit: (a: RunActivity) => void;
      /**
       * Every NEW assistant transcript line, even when its narration text
       * repeats the previous one (`emit` is change-only). The orchestrator
       * uses the line's own timestamp to retire a needs-attention flag the
       * agent has visibly moved past.
       */
      progressed?: (runId: string, at: string) => void;
    },
  ) {}

  start(): void {
    this.timers.push(setInterval(() => void this.reconcile(), RECONCILE_MS));
    this.timers.push(setInterval(() => void this.poll(), POLL_MS));
    for (const t of this.timers) t.unref();
    void this.reconcile();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Current line per live run — what a freshly loaded page needs. */
  snapshot(): RunActivity[] {
    return [...this.tails.values()].map((t) => t.last).filter((a): a is RunActivity => a !== null);
  }

  private async reconcile(): Promise<void> {
    if (this.reconciling) return;
    if (!this.opts.hasLiveSessions() && this.tails.size === 0) return;
    this.reconciling = true;
    try {
      const live = await this.opts.liveRuns();
      const seen = new Set<string>();
      for (const r of live) {
        seen.add(r.runId);
        if (!r.transcriptPath) continue; // SessionStart hook hasn't landed yet
        const cur = this.tails.get(r.runId);
        if (cur && cur.path === r.transcriptPath) {
          cur.taskId = r.taskId;
          continue;
        }
        this.tails.set(r.runId, {
          runId: r.runId,
          taskId: r.taskId,
          path: r.transcriptPath,
          startedAt: r.startedAt ?? null,
          todos: new TodoTracker(),
          // Start at the tail: a resumed run inherits the whole earlier
          // transcript and only the newest line is interesting.
          offset: -1,
          partial: '',
          last: cur?.last ?? null,
        });
      }
      for (const id of [...this.tails.keys()]) {
        if (!seen.has(id)) this.drop(id);
      }
    } catch {
      // storage hiccup — keep the tails we have and retry next tick
    } finally {
      this.reconciling = false;
    }
  }

  /** Run is over: tell the clients to forget it, so nothing stale lingers. */
  private drop(runId: string): void {
    const t = this.tails.get(runId);
    if (!t) return;
    this.tails.delete(runId);
    if (t.last) {
      this.opts.emit({ runId, taskId: t.taskId, text: null, kind: t.last.kind, at: new Date().toISOString() });
    }
  }

  private async poll(): Promise<void> {
    if (this.polling || this.tails.size === 0) return;
    this.polling = true;
    try {
      for (const tail of [...this.tails.values()]) {
        // the tail may have been dropped by a reconcile while we awaited
        if (!this.tails.has(tail.runId)) continue;
        const parsed = await this.readTail(tail);
        const todos = tail.todos.counts(tail.startedAt);
        const todosMoved = !sameTodos(tail.last?.todos, todos);
        if (!parsed && !todosMoved) continue;
        if (parsed?.at) this.opts.progressed?.(tail.runId, parsed.at);
        // unchanged — no traffic
        if ((!parsed || tail.last?.text === parsed.text) && !todosMoved) continue;
        const base = parsed ?? tail.last;
        if (!base?.text) continue; // nothing to narrate yet; the todos ride on the first line
        const activity: RunActivity = {
          runId: tail.runId,
          taskId: tail.taskId,
          text: base.text,
          kind: base.kind,
          at: parsed ? (parsed.at ?? new Date().toISOString()) : (tail.last?.at ?? new Date().toISOString()),
          todos,
        };
        tail.last = activity;
        this.opts.emit(activity);
      }
    } finally {
      this.polling = false;
    }
  }

  /** Newest activity in the bytes appended since the last read, if any. */
  private async readTail(tail: Tail): Promise<ParsedActivity | null> {
    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(tail.path, 'r');
    } catch {
      return null; // not written yet, or pruned
    }
    try {
      const { size } = await fh.stat();
      // the todo list is built call by call, so a seek past lines must
      // rebuild it from the file instead of feeding only the tail
      let todosUpTo = -1;
      if (tail.offset < 0) {
        // first read: seek near the end rather than replaying the whole file
        tail.offset = Math.max(0, size - MAX_CATCHUP);
        tail.partial = '';
        todosUpTo = size;
      } else if (size < tail.offset) {
        tail.offset = 0; // truncated / replaced underneath us
        tail.partial = '';
        tail.todos = new TodoTracker();
      } else if (size - tail.offset > MAX_CATCHUP) {
        tail.offset = size - MAX_CATCHUP;
        tail.partial = '';
        todosUpTo = size;
      }
      if (todosUpTo >= 0) tail.todos = await scanTodos(fh, todosUpTo);
      if (size === tail.offset) return null;
      const len = size - tail.offset;
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, tail.offset);
      tail.offset += bytesRead;
      const chunk = tail.partial + buf.subarray(0, bytesRead).toString('utf8');
      const lines = chunk.split('\n');
      // the trailing piece may be a half-flushed line; carry it to the next
      // read — unless it has grown past any plausible line (a giant tool
      // result mid-flush), in which case holding it just leaks memory.
      const rest = lines.pop() ?? '';
      tail.partial = rest.length > MAX_CATCHUP ? '' : rest;
      // A seek forward lands mid-line — that fragment is not valid JSON, so
      // activityFromLine drops it on its own; no special case needed.
      let newest: ParsedActivity | null = null;
      for (const line of lines) {
        const a = activityFromLine(line);
        if (a) newest = a;
        // the pre-scan already read these bytes for the todo list
        if (todosUpTo < 0) tail.todos.feed(line);
      }
      return newest;
    } catch {
      return null;
    } finally {
      await fh.close().catch(() => {});
    }
  }
}

/**
 * Rebuilds the todo list from the transcript's first `upTo` bytes (at most
 * the last MAX_TODO_SCAN of them), in chunks: a resumed run inherits the whole
 * session, and a TaskCreate far above the tail still counts.
 */
async function scanTodos(fh: fs.promises.FileHandle, upTo: number): Promise<TodoTracker> {
  const tracker = new TodoTracker();
  let pos = Math.max(0, upTo - MAX_TODO_SCAN);
  let carry = '';
  const buf = Buffer.allocUnsafe(SCAN_CHUNK);
  while (pos < upTo) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(SCAN_CHUNK, upTo - pos), pos);
    if (bytesRead <= 0) break;
    pos += bytesRead;
    const lines = (carry + buf.subarray(0, bytesRead).toString('utf8')).split('\n');
    carry = lines.pop() ?? '';
    if (carry.length > MAX_CATCHUP) carry = '';
    for (const line of lines) tracker.feed(line);
  }
  return tracker;
}
