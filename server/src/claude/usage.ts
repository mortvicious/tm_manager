import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// Estimates subscription usage from local claude session transcripts:
// tokens recorded in ~/.claude/projects/**/*.jsonl over the trailing 5 hours,
// as a percentage of a configurable budget. The CLI exposes no official
// account-usage API, so this is an ESTIMATE — the budget is user-tunable in
// Config (router.budget5hTokens). Cached for 2 minutes.

const WINDOW_MS = 5 * 60 * 60 * 1000;
const CACHE_MS = 2 * 60 * 1000;

let cache: { at: number; tokens: number } | null = null;

async function tokensInWindow(): Promise<number> {
  const projectsDir = path.join(process.env.HOME ?? '', '.claude', 'projects');
  const cutoff = Date.now() - WINDOW_MS;
  let total = 0;

  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch {
    return 0;
  }

  for (const dir of dirs) {
    const full = path.join(projectsDir, dir);
    let files: string[] = [];
    try {
      files = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      const fp = path.join(full, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fp);
      } catch {
        continue;
      }
      // Skip files untouched since the window started.
      if (stat.mtimeMs < cutoff) continue;

      try {
        const rl = readline.createInterface({ input: fs.createReadStream(fp), crlfDelay: Infinity });
        // One API message spans multiple transcript lines (thinking/text/tool_use
        // blocks), each repeating the SAME usage object — count each id once
        // or the estimate inflates 2-4x (review F1).
        const seen = new Set<string>();
        for await (const line of rl) {
          if (!line.includes('"usage"')) continue;
          try {
            const j = JSON.parse(line);
            const ts = j.timestamp ? Date.parse(j.timestamp) : stat.mtimeMs;
            if (ts < cutoff) continue;
            const u = j.message?.usage;
            if (!u) continue;
            const msgId: string | undefined = j.message?.id ?? j.requestId;
            if (msgId) {
              if (seen.has(msgId)) continue;
              seen.add(msgId);
            }
            // NOTE: input_tokens is exclusive of cache reads/writes (verified),
            // so input+output undercounts limit-weighted consumption — the
            // tunable router.budget5hTokens absorbs the calibration.
            total += (u.output_tokens ?? 0) + (u.input_tokens ?? 0);
          } catch {
            // partial/corrupt line
          }
        }
      } catch {
        // unreadable file
      }
    }
  }
  return total;
}

export async function estimateUsagePct(budgetTokens: number): Promise<number> {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    cache = { at: Date.now(), tokens: await tokensInWindow() };
  }
  if (budgetTokens <= 0) return 0;
  return Math.min(100, (cache.tokens / budgetTokens) * 100);
}

// Tool/browser-testing tasks route to the fallback model (user rule 2026-08-24).
// \b anchors: "browserslist" or "monochrome" must not route to the fallback (review F11).
const OPUS_KEYWORDS =
  /\b(browser|playwright|puppeteer|selenium|cypress|webdriver|e2e|end-to-end|screenshot|ui.?tests?|integration.?tests?|chrome|devtools)\b/i;

export function needsFallbackModel(title: string, description: string | null): boolean {
  return OPUS_KEYWORDS.test(`${title} ${description ?? ''}`);
}
