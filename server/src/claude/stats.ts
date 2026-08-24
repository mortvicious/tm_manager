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
