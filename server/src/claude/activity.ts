import fs from 'node:fs';
import type { RunActivity } from '@tm/shared';

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
      return 'Updating the todo list';
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

interface Tail {
  runId: string;
  taskId: string | null;
  path: string;
  offset: number;
  partial: string;
  last: RunActivity | null;
}

export interface WatchedRun {
  runId: string;
  taskId: string | null;
  transcriptPath: string | null;
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
        if (!parsed) continue;
        if (tail.last?.text === parsed.text) continue; // unchanged — no traffic
        const activity: RunActivity = {
          runId: tail.runId,
          taskId: tail.taskId,
          text: parsed.text,
          kind: parsed.kind,
          at: parsed.at ?? new Date().toISOString(),
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
      if (tail.offset < 0) {
        // first read: seek near the end rather than replaying the whole file
        tail.offset = Math.max(0, size - MAX_CATCHUP);
        tail.partial = '';
      } else if (size < tail.offset) {
        tail.offset = 0; // truncated / replaced underneath us
        tail.partial = '';
      } else if (size - tail.offset > MAX_CATCHUP) {
        tail.offset = size - MAX_CATCHUP;
        tail.partial = '';
      }
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
      }
      return newest;
    } catch {
      return null;
    } finally {
      await fh.close().catch(() => {});
    }
  }
}
