import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { contextWindowFor, type RunStats } from '@tm/shared';

// $/MTok: [input, output, cacheWrite5m, cacheWrite1h, cacheRead]. Estimates
// for cost chips — unknown models fall back to opus-class pricing. A cache
// write bills by its TTL: 5-minute writes at 1.25× input, 1-hour writes at 2×
// input. Worker sessions write only 1h cache, subagents only 5m (measured
// over 30 days, docs/token-budget.md § Cost accounting).
// priceFor PREFIX-matches in insertion order, so 'claude-opus-5' also prices
// 'claude-opus-5-5' at the same opus rates (they are the same tier). If a
// point release is ever priced differently, its row must go ABOVE the shorter
// id or the shorter one wins the match.
const PRICING: Record<string, [number, number, number, number, number]> = {
  'claude-opus-5': [15, 75, 18.75, 30, 1.5],
  'claude-fable-5': [15, 75, 18.75, 30, 1.5],
  'claude-sonnet-5': [3, 15, 3.75, 6, 0.3],
  'claude-haiku-4-5': [1, 5, 1.25, 2, 0.1],
  // Codex runs never populate RunStats (no transcript-parsing hooks — see
  // isCodexModel/buildWorkerInvocation), so this never actually prices
  // anything today; it's here so a future codex transcript parser doesn't
  // silently get billed at opus rates.
  'codex': [0, 0, 0, 0, 0],
};

function priceFor(model: string | null): [number, number, number, number, number] {
  if (model) {
    for (const [k, v] of Object.entries(PRICING)) {
      if (model.startsWith(k)) return v;
    }
  }
  return PRICING['claude-opus-5'];
}

export interface TranscriptSummary {
  stats: RunStats;
  /** last assistant text output, for task.resultSummary */
  lastAssistantText: string | null;
}

/**
 * Usage a RESUMED run is responsible for, by subtraction — the FALLBACK for a
 * caller with no run window (see summarizeRun). Both runs share one transcript
 * file, so the raw sums include everything the earlier session spent.
 * contextPct/contextTokens are a last-turn measure, not a total, so they pass
 * through untouched.
 */
export function netStats(raw: RunStats, baseline: RunStats | null): RunStats {
  if (!baseline) return raw;
  const pos = (n: number) => (n > 0 ? n : 0);
  return {
    inputTokens: pos(raw.inputTokens - baseline.inputTokens),
    outputTokens: pos(raw.outputTokens - baseline.outputTokens),
    cacheReadTokens: pos(raw.cacheReadTokens - baseline.cacheReadTokens),
    cacheWriteTokens: pos(raw.cacheWriteTokens - baseline.cacheWriteTokens),
    costUsd: Math.round(pos(raw.costUsd - baseline.costUsd) * 1000) / 1000,
    contextPct: raw.contextPct,
    contextTokens: raw.contextTokens,
    subagentCostUsd:
      Math.round(pos((raw.subagentCostUsd ?? 0) - (baseline.subagentCostUsd ?? 0)) * 1000) / 1000,
  };
}

/**
 * summarizeTranscript for a run row. Attributes usage by TIMESTAMP — the
 * messages written between the run's `startedAt` and `endedAt` (open while it
 * is live) — rather than by subtracting `statsBaseline`: baselines written
 * before subagent files were counted exclude them, so subtraction would hand a
 * resumed run the whole session's earlier subagent spend, and baselines priced
 * at the old cache-write rate would hand it a re-pricing delta. Runs on one
 * session never overlap in time (a resume never shares a session id with a
 * live process), and on 40 resumed runs the window reproduced the
 * subtraction's tokens exactly. The baseline is only a fallback for a row with
 * no parsable `startedAt`.
 */
export async function summarizeRun(
  run: {
    transcriptPath: string | null;
    model: string | null;
    statsBaseline: RunStats | null;
    startedAt?: string | null;
    endedAt?: string | null;
  },
  transcriptPath?: string | null,
): Promise<TranscriptSummary | null> {
  const tp = transcriptPath ?? run.transcriptPath;
  if (!tp) return null;
  const since = run.startedAt ? Date.parse(run.startedAt) : NaN;
  if (Number.isFinite(since)) {
    const until = run.endedAt ? Date.parse(run.endedAt) : NaN;
    return summarizeTranscript(tp, run.model, {
      since,
      until: Number.isFinite(until) ? until : Infinity,
    });
  }
  const summary = await summarizeTranscript(tp, run.model);
  if (!summary) return null;
  return { ...summary, stats: netStats(summary.stats, run.statsBaseline) };
}

/** One API message's usage, as the transcript recorded it. */
interface Usage {
  id: string | null;
  /** epoch ms; NaN when the line carried none */
  ts: number;
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

interface ParsedFile {
  key: string;
  messages: Usage[];
  /** main chain only: the last turn's context total, its model, its text */
  lastTurnTotal: number;
  lastTurnModel: string | null;
  lastAssistantText: string | null;
}

// Parsed files by path, keyed on mtime+size like usage.ts: the 20 s live
// refresh re-summarises every running run, and a finished subagent file never
// changes again. Bounded so a long-lived server does not keep every session
// it ever read.
const fileCache = new Map<string, ParsedFile>();
const FILE_CACHE_MAX = 400;

async function parseFile(file: string, sidechainFile: boolean): Promise<ParsedFile | null> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = fileCache.get(file);
  if (hit && hit.key === key) {
    // Re-insert so eviction drops the least recently used file.
    fileCache.delete(file);
    fileCache.set(file, hit);
    return hit;
  }

  // One API message spans several transcript lines, each repeating its usage
  // — count each message id once (review R1). The repeats are NOT identical:
  // output_tokens grows across a streamed message's lines (482 of 6965 repeats
  // measured, never shrinking), so keep the largest reading of each field,
  // not the first.
  const byId = new Map<string, Usage>();
  const messages: Usage[] = [];
  let lastTurnTotal = 0;
  let lastTurnModel: string | null = null;
  let lastAssistantText: string | null = null;
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      let j: any;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      const m = j.message;
      const side = sidechainFile || j.isSidechain === true;
      // A compaction writes no usage line of its own, so without this the
      // context would read the PRE-compaction size until the next assistant
      // message — and a run cut right after one (an auto-compaction, then a
      // kill) would send the resume gate compacting it a second time.
      if (!side && j.subtype === 'compact_boundary') {
        const post = Number(j.compactMetadata?.postTokens);
        if (Number.isFinite(post) && post > 0) lastTurnTotal = post;
        continue;
      }
      const u = m?.usage;
      if (u) {
        const cc = u.cache_creation;
        const total = u.cache_creation_input_tokens ?? 0;
        // Lines without the TTL split (older CLIs) bill the whole write at
        // the 5m rate, which is what every write was priced at before.
        const w1h = Math.min(total, typeof cc?.ephemeral_1h_input_tokens === 'number' ? cc.ephemeral_1h_input_tokens : 0);
        const rec: Usage = {
          id: typeof m.id === 'string' ? m.id : typeof j.requestId === 'string' ? j.requestId : null,
          ts: typeof j.timestamp === 'string' ? Date.parse(j.timestamp) : NaN,
          model: typeof m.model === 'string' ? m.model : null,
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite5m: total - w1h,
          cacheWrite1h: w1h,
        };
        const prev = rec.id ? byId.get(rec.id) : undefined;
        if (prev) {
          prev.input = Math.max(prev.input, rec.input);
          prev.output = Math.max(prev.output, rec.output);
          prev.cacheRead = Math.max(prev.cacheRead, rec.cacheRead);
          prev.cacheWrite5m = Math.max(prev.cacheWrite5m, rec.cacheWrite5m);
          prev.cacheWrite1h = Math.max(prev.cacheWrite1h, rec.cacheWrite1h);
        } else {
          if (rec.id) byId.set(rec.id, rec);
          messages.push(rec);
        }
        // Context: main chain only — a subagent's window is not this
        // session's (review M4). Include the turn's own output (M5). A
        // '<synthetic>' message (the CLI's own error/limit notice, all-zero
        // usage) is no turn: letting it win would read a 400k session as
        // empty at the resume gate.
        if (!side && rec.model !== '<synthetic>') {
          lastTurnTotal = rec.input + rec.cacheRead + total + rec.output;
          if (rec.model) lastTurnModel = rec.model;
        }
      }
      if (!side && m?.role === 'assistant' && Array.isArray(m.content)) {
        const texts = m.content
          .filter((c: any) => c.type === 'text' && typeof c.text === 'string')
          .map((c: any) => c.text);
        if (texts.length) lastAssistantText = texts.join('\n');
      }
    }
  } catch {
    return null;
  }

  const parsed: ParsedFile = { key, messages, lastTurnTotal, lastTurnModel, lastAssistantText };
  fileCache.delete(file);
  fileCache.set(file, parsed);
  while (fileCache.size > FILE_CACHE_MAX) {
    const oldest = fileCache.keys().next().value;
    if (oldest === undefined) break;
    fileCache.delete(oldest);
  }
  return parsed;
}

/**
 * The subagent transcripts of the session whose main transcript is
 * `transcriptPath`: `<dir>/<sessionId>/subagents/agent-<id>.jsonl`. Nested
 * subagents land in the same flat folder. Shared with usage.ts.
 */
export function subagentTranscripts(transcriptPath: string): string[] {
  const dir = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, '.jsonl'), 'subagents');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export interface UsageWindow {
  /** epoch ms, inclusive */
  since: number;
  /** epoch ms, inclusive; Infinity while the run is live */
  until: number;
}

/**
 * Usage and cost of a session: the main transcript plus every subagent
 * transcript, each message priced at ITS OWN model (`message.model`, else the
 * run's — subagents run opus, fable, sonnet or haiku whatever the parent is).
 * With `window`, only messages stamped inside it count (summarizeRun). The context
 * figures and `lastAssistantText` always come from the main chain's LAST turn,
 * window or not: they describe the session as it stands.
 */
export async function summarizeTranscript(
  transcriptPath: string,
  model: string | null,
  window?: UsageWindow,
): Promise<TranscriptSummary | null> {
  if (!fs.existsSync(transcriptPath)) return null;
  const main = await parseFile(transcriptPath, false);
  if (!main) return null;
  const subs: ParsedFile[] = [];
  for (const f of subagentTranscripts(transcriptPath)) {
    const p = await parseFile(f, true);
    if (p) subs.push(p);
  }

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let subagentCost = 0;
  const seen = new Set<string>();
  const add = (msgs: Usage[], sub: boolean) => {
    for (const r of msgs) {
      if (r.id) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
      }
      // A line without a timestamp cannot be placed in a window, and
      // counting it in every window would bill it once per run of the
      // session (none were found in any transcript on disk).
      if (window && !(r.ts >= window.since && r.ts <= window.until)) continue;
      // '<synthetic>' and friends are not a priced model — use the run's.
      const m = r.model && (r.model.startsWith('claude-') || r.model.startsWith('codex')) ? r.model : model;
      const [pIn, pOut, pW5, pW1, pR] = priceFor(m);
      const c =
        (r.input * pIn + r.output * pOut + r.cacheWrite5m * pW5 + r.cacheWrite1h * pW1 + r.cacheRead * pR) /
        1_000_000;
      input += r.input;
      output += r.output;
      cacheRead += r.cacheRead;
      cacheWrite += r.cacheWrite5m + r.cacheWrite1h;
      cost += c;
      if (sub) subagentCost += c;
    }
  };
  add(main.messages, false);
  for (const s of subs) add(s.messages, true);

  const ctxModel = main.lastTurnModel ?? model;
  return {
    stats: {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costUsd: Math.round(cost * 1000) / 1000,
      contextPct: Math.min(100, Math.round((main.lastTurnTotal / contextWindowFor(ctxModel)) * 1000) / 10),
      // The same measure without the divisor or the clamp — the resume gate
      // compares against a token cap.
      contextTokens: main.lastTurnTotal,
      subagentCostUsd: Math.round(subagentCost * 1000) / 1000,
    },
    lastAssistantText: main.lastAssistantText,
  };
}
