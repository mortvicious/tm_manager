import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { liveWindow, readAccountUsage } from './account-usage.ts';

// Estimates subscription usage from local claude session transcripts:
// tokens recorded in ~/.claude/projects/**/*.jsonl, summed over the three
// windows the subscription actually meters — trailing 5h, trailing 7d, and
// trailing 7d restricted to fable-family models. The CLI exposes no official
// account-usage API, so these are ESTIMATES; each window is measured against a
// user-tunable budget in Config (router.budget*Tokens). Cached for 2 minutes.
//
// A week of transcripts is far too much to re-read on every poll, so parsed
// files are cached per path and only re-read when mtime/size changes. Each
// file collapses to minute buckets, which keeps the cache small (<= 10080
// buckets per file) while staying precise enough for a rolling 5h cutoff.

const MINUTE_MS = 60_000;
const WINDOW_5H_MS = 5 * 60 * 60 * 1000;
const WINDOW_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MS = 2 * 60 * 1000;

const FABLE_RE = /fable/i;

/** [minute epoch, tokens, fable tokens] — fable tokens are a subset of tokens. */
type Bucket = [number, number, number];

interface CachedFile {
  /** identity of the bytes we parsed; a change forces a re-read */
  key: string;
  buckets: Bucket[];
}

export interface UsageEstimate {
  fiveHourTokens: number;
  weekTokens: number;
  weekFableTokens: number;
}

const fileCache = new Map<string, CachedFile>();
let cache: { at: number; value: UsageEstimate } | null = null;
// The orchestrator's claim loop and the header pill both call in; a scan in
// flight is shared rather than duplicated.
let inflight: Promise<UsageEstimate> | null = null;

/** Parse one transcript into minute buckets, dropping anything before `cutoff`. */
async function bucketsForFile(fp: string, cutoff: number, fallbackTs: number): Promise<Bucket[]> {
  const byMinute = new Map<number, Bucket>();
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
        const ts = j.timestamp ? Date.parse(j.timestamp) : fallbackTs;
        if (!Number.isFinite(ts) || ts < cutoff) continue;
        const u = j.message?.usage;
        if (!u) continue;
        const msgId: string | undefined = j.message?.id ?? j.requestId;
        if (msgId) {
          if (seen.has(msgId)) continue;
          seen.add(msgId);
        }
        // NOTE: input_tokens is exclusive of cache reads/writes (verified),
        // so input+output undercounts limit-weighted consumption — the
        // tunable budgets absorb the calibration.
        const tokens = (u.output_tokens ?? 0) + (u.input_tokens ?? 0);
        if (!tokens) continue;
        const model: string = typeof j.message?.model === 'string' ? j.message.model : '';
        const minute = Math.floor(ts / MINUTE_MS);
        const b = byMinute.get(minute);
        if (b) {
          b[1] += tokens;
          if (FABLE_RE.test(model)) b[2] += tokens;
        } else {
          byMinute.set(minute, [minute, tokens, FABLE_RE.test(model) ? tokens : 0]);
        }
      } catch {
        // partial/corrupt line
      }
    }
  } catch {
    // unreadable file
  }
  return [...byMinute.values()];
}

async function scanTranscripts(): Promise<UsageEstimate> {
  const projectsDir = path.join(process.env.HOME ?? '', '.claude', 'projects');
  const now = Date.now();
  const weekCutoff = now - WINDOW_WEEK_MS;
  const fiveHourCutoff = now - WINDOW_5H_MS;
  const totals: UsageEstimate = { fiveHourTokens: 0, weekTokens: 0, weekFableTokens: 0 };
  const alive = new Set<string>();

  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch {
    fileCache.clear();
    return totals;
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
      if (stat.mtimeMs < weekCutoff) continue;
      alive.add(fp);

      const key = `${stat.mtimeMs}:${stat.size}`;
      let entry = fileCache.get(fp);
      if (!entry || entry.key !== key) {
        entry = { key, buckets: await bucketsForFile(fp, weekCutoff, stat.mtimeMs) };
        fileCache.set(fp, entry);
      }
      for (const [minute, tokens, fableTokens] of entry.buckets) {
        // Cached buckets outlive the moving cutoff — re-filter on every scan.
        const ts = minute * MINUTE_MS;
        if (ts < weekCutoff) continue;
        totals.weekTokens += tokens;
        totals.weekFableTokens += fableTokens;
        if (ts >= fiveHourCutoff) totals.fiveHourTokens += tokens;
      }
    }
  }

  // Forget files that were deleted or have aged out of the week window.
  for (const fp of fileCache.keys()) {
    if (!alive.has(fp)) fileCache.delete(fp);
  }
  return totals;
}

export async function estimateUsage(): Promise<UsageEstimate> {
  if (cache && Date.now() - cache.at <= CACHE_MS) return cache.value;
  if (inflight) return inflight;
  inflight = scanTranscripts()
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function estimateUsagePct(budgetTokens: number): Promise<number> {
  const { fiveHourTokens } = await estimateUsage();
  return pctOf(fiveHourTokens, budgetTokens);
}

/**
 * The session/5h figure the router keys on: the account's own number when the
 * CLI has a non-expired one cached, else the local-transcript estimate.
 */
export async function sessionUsagePct(budgetTokens: number): Promise<number> {
  const live = liveWindow(readAccountUsage()?.session);
  if (live) return live.percent;
  return estimateUsagePct(budgetTokens);
}

export function pctOf(tokens: number, budgetTokens: number): number {
  if (budgetTokens <= 0) return 0;
  return Math.min(100, (tokens / budgetTokens) * 100);
}

// Tool/browser-testing tasks route to the fallback model (user rule 2026-08-24).
// \b anchors: "browserslist" or "monochrome" must not route to the fallback (review F11).
const OPUS_KEYWORDS =
  /\b(browser|playwright|puppeteer|selenium|cypress|webdriver|e2e|end-to-end|screenshot|ui.?tests?|integration.?tests?|chrome|devtools)\b/i;

export function needsFallbackModel(title: string, description: string | null): boolean {
  return OPUS_KEYWORDS.test(`${title} ${description ?? ''}`);
}
