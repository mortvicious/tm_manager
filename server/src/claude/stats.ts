import fs from 'node:fs';
import readline from 'node:readline';
import type { RunStats } from '@tm/shared';

// $/MTok: [input, output, cacheWrite, cacheRead]. Estimates for cost chips —
// unknown models fall back to opus-class pricing.
const PRICING: Record<string, [number, number, number, number]> = {
  'claude-opus-5': [15, 75, 18.75, 1.5],
  'claude-fable-5': [15, 75, 18.75, 1.5],
  'claude-sonnet-5': [3, 15, 3.75, 0.3],
  'claude-haiku-4-5': [1, 5, 1.25, 0.1],
  // Codex runs never populate RunStats (no transcript-parsing hooks — see
  // isCodexModel/buildWorkerInvocation), so this never actually prices
  // anything today; it's here so a future codex transcript parser doesn't
  // silently get billed at opus rates.
  'codex': [0, 0, 0, 0],
};

const CONTEXT_WINDOW = 200_000;

function priceFor(model: string | null): [number, number, number, number] {
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
 * Usage a RESUMED run is responsible for. Both runs share one transcript file,
 * so the raw sums include everything the earlier session spent — subtract the
 * baseline captured at resume time. contextPct is a last-turn measure, not a
 * total, so it passes through untouched.
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
  };
}

/** summarizeTranscript for a run row: applies its resume baseline, if any. */
export async function summarizeRun(
  run: { transcriptPath: string | null; model: string | null; statsBaseline: RunStats | null },
  transcriptPath?: string | null,
): Promise<TranscriptSummary | null> {
  const tp = transcriptPath ?? run.transcriptPath;
  if (!tp) return null;
  const summary = await summarizeTranscript(tp, run.model);
  if (!summary) return null;
  return { ...summary, stats: netStats(summary.stats, run.statsBaseline) };
}

export async function summarizeTranscript(
  transcriptPath: string,
  model: string | null,
): Promise<TranscriptSummary | null> {
  if (!fs.existsSync(transcriptPath)) return null;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let lastTurnTotal = 0;
  let lastAssistantText: string | null = null;
  // One API message spans multiple transcript lines, each repeating the same
  // usage object — sum each message id once (same fix as usage.ts, review R1).
  const seen = new Set<string>();

  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(transcriptPath),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      let j: any;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      const u = j.message?.usage;
      if (u) {
        const msgId: string | undefined = j.message?.id ?? j.requestId;
        if (!msgId || !seen.has(msgId)) {
          if (msgId) seen.add(msgId);
          input += u.input_tokens ?? 0;
          output += u.output_tokens ?? 0;
          cacheRead += u.cache_read_input_tokens ?? 0;
          cacheWrite += u.cache_creation_input_tokens ?? 0;
        }
        // Context %: main chain only — a subagent's window is not this
        // session's (review M4). Include the turn's own output (M5).
        if (j.isSidechain !== true) {
          lastTurnTotal =
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0) +
            (u.output_tokens ?? 0);
        }
      }
      if (j.isSidechain !== true && j.message?.role === 'assistant' && Array.isArray(j.message.content)) {
        const texts = j.message.content
          .filter((c: any) => c.type === 'text' && typeof c.text === 'string')
          .map((c: any) => c.text);
        if (texts.length) lastAssistantText = texts.join('\n');
      }
    }
  } catch {
    return null;
  }

  const [pIn, pOut, pW, pR] = priceFor(model);
  const costUsd =
    (input * pIn + output * pOut + cacheWrite * pW + cacheRead * pR) / 1_000_000;

  return {
    stats: {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costUsd: Math.round(costUsd * 1000) / 1000,
      contextPct: Math.min(100, Math.round((lastTurnTotal / CONTEXT_WINDOW) * 1000) / 10),
    },
    lastAssistantText,
  };
}
