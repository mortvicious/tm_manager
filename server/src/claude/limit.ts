/**
 * Recognising "the account ran out of 5h window", and deciding when to come
 * back (docs/wake.md).
 *
 * A turn that ends against the usage limit is not a failed turn: nothing is
 * wrong with the work, the repo or the prompt, and the SAME claude session is
 * still resumable. The only thing missing is capacity, which returns at a
 * known wall-clock time. This module is the one place that decides both
 * questions — "was that a usage limit?" and "when does it come back?" — so
 * neither answer can drift between the exit path and the stall sweep.
 *
 * The CLI states the limit in several shapes depending on surface and version
 * (interactive banner, headless `result` text, the raw API error), so the
 * matcher is deliberately a set of patterns over plain text rather than a
 * parse of any one envelope. Text we cannot pin a time to still counts as a
 * limit — the caller falls back to the account's own `resets_at`, and to
 * now + 5h as the last resort. The failure we care about is missing a stall,
 * not being an hour late to it.
 */

/** A 5h window is never longer than 5h, which bounds every reset we accept. */
const WINDOW_MS = 5 * 60 * 60 * 1000;
/** Slack for a banner whose stated reset has just passed (clock skew, lag). */
const PAST_SLACK_MS = 10 * 60 * 1000;

export interface LimitNotice {
  /** ISO time the window reopens, when the notice stated one */
  resetsAt: string | null;
  /** the matched fragment, for the audit row — never the whole buffer */
  evidence: string;
  /** characters of output that followed it. A real refusal is the last thing
   *  the terminal shows; text an agent merely printed is followed by more. */
  charsAfter: number;
}

/** The account's own view of the 5h window — `liveWindow(...session)`. */
export interface AccountView {
  /** 0..100, as the CLI's `/usage` panel reports it */
  percent: number;
  resetsAt: string | null;
}

/**
 * How close to the end of the terminal a banner must sit to be a live refusal
 * rather than something the session printed and carried on past. Generous,
 * because the CLI redraws its prompt box and status line after the
 * banner — the discrimination that matters is "the last screenful" versus
 * "somewhere in the scrollback".
 */
const LIVE_TAIL_CHARS = 4_000;

/**
 * The same test for a session that is still marked `running`, where acting on
 * it means KILLING a live PTY. A refusal is the last thing such a terminal
 * ever printed, so there is no reason to be generous, and being wrong here is
 * expensive in a way that being wrong about an already-dead run is not.
 */
export const LIVE_TAIL_STRICT_CHARS = 400;

/**
 * The CLI's permission prompt, which is the other reason a live session sits
 * silent. It is not a stall the account can fix: the agent is waiting for a
 * human, and the previewed hunk above the prompt may itself be a file quoting
 * a banner (this repo has several). `run.needsAttention` is the primary guard;
 * this catches the window before the Notification hook has landed.
 */
const PROMPT_MARKERS: RegExp[] = [
  /\bdo you want to\b/i,
  /\bwould you like to\b/i,
  /❯\s*\d[.)]/,
  /\b\d[.)]\s*yes,\s*(?:and|don'?t)\b/i,
  /\bno,\s*(?:and\s*)?tell claude\b/i,
];

/** How much of the end of the terminal the prompt test looks at. */
const PROMPT_SCAN_CHARS = 1_500;

/**
 * Account utilisation at or above which the window is taken to be spent. Not
 * 100: the CLI's cached figure is written when it last fetched `/usage`, so at
 * the moment of a refusal it may still read the value from just before the
 * final turn.
 */
const ACCOUNT_EXHAUSTED_PCT = 90;

/**
 * Why a banner did NOT park a task. Recorded rather than dropped: a wake-up
 * that did not happen should be a decision in the log, never a gap.
 */
export type StallSkip =
  | 'no-banner'
  | 'banner-not-live'
  | 'awaiting-permission'
  | 'account-not-exhausted'
  | 'no-account-data';

export type StallVerdict =
  | { stalled: true; notice: LimitNotice; accountPct: number; accountResetsAt: string | null }
  | { stalled: false; sawBanner: boolean; reason: StallSkip };

/**
 * Phrases that mean "this turn stopped because the account is out", each
 * anchored on `limit` so ordinary prose about usage cannot match. `overloaded`
 * and plain 429s are deliberately NOT here: they are transient server-side
 * conditions that a retry fixes, not a window with a reset time.
 */
const LIMIT_PATTERNS: RegExp[] = [
  /\b(?:claude\s+(?:ai\s+)?)?usage\s+limit\s+reached\b/i,
  /\b\d+\s*-?\s*hour\s+limit\s+reached\b/i,
  /\bweekly\s+limit\s+reached\b/i,
  /\byou(?:'ve| have)\s+(?:reached|hit)\s+your\s+(?:usage|rate)\s+limit\b/i,
  /"type"\s*:\s*"rate_limit_error"/i,
];

/** `...reached|1764950400` — the CLI's machine-readable form (epoch seconds). */
const EPOCH_RE = /limit\s+reached\s*\|\s*(\d{9,13})/i;

/**
 * `resets 3pm`, `resets at 3:30 PM (UTC)`, `will reset at 15:00`. The zone
 * group is optional and only ever UTC — the CLI prints local time otherwise.
 */
const CLOCK_RE =
  /\bresets?\b(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(?\s*(utc|gmt)\s*\)?)?/i;

/**
 * Removes CSI colour/cursor sequences. This runs BEFORE matching, not only on
 * the evidence: the banner arrives colourised, and `\x1b[31m5-hour limit` has
 * no word boundary between the `m` of the escape and the `5` — the patterns
 * would silently never fire on the one surface they exist for.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

/** Trims a match to a short, loggable fragment of its own line. */
function evidenceAt(text: string, index: number): string {
  const from = text.lastIndexOf('\n', index) + 1;
  const to = text.indexOf('\n', index);
  return text
    .slice(from, to === -1 ? text.length : to)
    // Box drawing and padding would make the audit row unreadable and are
    // never part of the meaning.
    .replace(/[│┃|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Resolves a stated clock time to the one instant inside the window it can
 * mean. A 5h window's reset is always in (now, now + 5h], so today's,
 * tomorrow's and yesterday's occurrence are tried and only a candidate that
 * lands in that range (plus a little slack for one that just passed) is
 * accepted. Anything else is a time we misread, and a wrong wake time is
 * worse than none — the caller has better fallbacks.
 */
function resolveClock(
  hour: number,
  minute: number,
  meridiem: string | null,
  utc: boolean,
  now: number,
): number | null {
  let h = hour;
  if (meridiem) {
    if (h < 1 || h > 12) return null;
    const pm = meridiem.toLowerCase() === 'pm';
    h = (h % 12) + (pm ? 12 : 0);
  } else if (h > 23) {
    return null;
  }
  if (minute > 59) return null;
  const base = new Date(now);
  for (const dayShift of [0, 1, -1]) {
    const d = new Date(now);
    if (utc) {
      d.setUTCHours(h, minute, 0, 0);
      d.setUTCDate(base.getUTCDate() + dayShift);
    } else {
      d.setHours(h, minute, 0, 0);
      d.setDate(base.getDate() + dayShift);
    }
    const t = d.getTime();
    if (t > now - PAST_SLACK_MS && t <= now + WINDOW_MS) return t;
  }
  return null;
}

/**
 * Scans text for a usage-limit notice. Returns null when there is none —
 * which is the common case, so callers may run this over a whole terminal
 * buffer without gating it on anything else.
 */
export function parseLimitNotice(raw: string | null | undefined, now = Date.now()): LimitNotice | null {
  if (!raw) return null;
  // Every index below refers to the stripped copy, so matching, the evidence
  // line and the reset-time window all agree on one coordinate system.
  const text = stripAnsi(raw);
  let hit: { index: number } | null = null;
  for (const re of LIMIT_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      // The LAST occurrence is the live one: a terminal buffer can hold the
      // banner from an earlier, already-reset window further up.
      const all = [...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))];
      const last = all[all.length - 1] ?? m;
      if (!hit || last.index! > hit.index) hit = { index: last.index! };
    }
  }
  if (!hit) return null;

  const evidence = evidenceAt(text, hit.index);
  const charsAfter = text.length - hit.index;
  // Search for the reset time near the notice, not across the whole buffer —
  // an unrelated "resets" line elsewhere must not become this one's deadline.
  const near = text.slice(hit.index, hit.index + 400);

  const epoch = EPOCH_RE.exec(near);
  if (epoch) {
    const n = Number(epoch[1]);
    const ms = n > 1e12 ? n : n * 1000;
    // Trust it only if it describes a window that is actually ahead of us.
    if (ms > now - PAST_SLACK_MS && ms <= now + WINDOW_MS + PAST_SLACK_MS) {
      return { resetsAt: new Date(ms).toISOString(), evidence, charsAfter };
    }
  }

  const clock = CLOCK_RE.exec(near);
  if (clock) {
    const t = resolveClock(
      Number(clock[1]),
      clock[2] ? Number(clock[2]) : 0,
      clock[3] ?? null,
      !!clock[4],
      now,
    );
    if (t != null) return { resetsAt: new Date(t).toISOString(), evidence, charsAfter };
  }
  return { resetsAt: null, evidence, charsAfter };
}

/**
 * The whole decision: is this terminal showing a live refusal by the account?
 *
 * Matching the banner is NOT enough on its own, and that is the point. Those
 * bytes are whatever the terminal displayed — a `cat` of a file, a Write-tool
 * preview, an assistant message quoting one. This repo's own `docs/wake.md`
 * contains literal matches, so an agent editing it and then dying would
 * otherwise park itself and be resumed hours later at the cost of a full
 * context re-buy, for a task nobody asked to reopen.
 *
 * Two independent things must therefore agree:
 *
 *  1. **position** — the banner is inside the last `LIVE_TAIL_CHARS` of the
 *     terminal. A refusal ends the turn, so nothing follows it; printed text
 *     is followed by the rest of the output that printed it.
 *  2. **the account** — its own live 5h window reads at least
 *     `ACCOUNT_EXHAUSTED_PCT`. This is the corroboration that cannot be forged
 *     by anything a repo contains.
 *
 * With no usable account reading the answer is no. The CLI's cache is only
 * refreshed by interactive sessions, but a worker IS one, so a real refusal
 * arrives with a fresh figure; refusing to guess when it is missing costs an
 * automatic resume the human can still trigger by hand, while guessing costs
 * money on a session nobody wanted reopened.
 */
export function assessLimitStall(
  tail: string | null | undefined,
  account: AccountView | null,
  now = Date.now(),
  opts: { maxCharsAfter?: number } = {},
): StallVerdict {
  const notice = parseLimitNotice(tail, now);
  if (!notice) return { stalled: false, sawBanner: false, reason: 'no-banner' };
  const window = opts.maxCharsAfter ?? LIVE_TAIL_CHARS;
  if (notice.charsAfter > window) return { stalled: false, sawBanner: true, reason: 'banner-not-live' };
  // A terminal showing a permission prompt is waiting for a HUMAN, and the
  // hunk it is previewing may be a file that quotes a banner. Killing that
  // session would throw away an answer the agent is still waiting for.
  if (looksLikePermissionPrompt(tail)) return { stalled: false, sawBanner: true, reason: 'awaiting-permission' };
  if (!account) return { stalled: false, sawBanner: true, reason: 'no-account-data' };
  if (account.percent < ACCOUNT_EXHAUSTED_PCT) {
    return { stalled: false, sawBanner: true, reason: 'account-not-exhausted' };
  }
  return { stalled: true, notice, accountPct: account.percent, accountResetsAt: account.resetsAt };
}

/**
 * Whether the end of a terminal is showing the CLI's permission prompt. Used
 * to refuse a stall verdict, never to produce one, so a false positive here
 * only costs an automatic resume the human can still trigger by hand.
 */
export function looksLikePermissionPrompt(tail: string | null | undefined): boolean {
  if (!tail) return false;
  const end = stripAnsi(tail).slice(-PROMPT_SCAN_CHARS);
  return PROMPT_MARKERS.some((re) => re.test(end));
}

/**
 * The instant to come back at: what the notice said, what the account says,
 * else a whole window from now. `graceSec` is added on top — the reset time
 * is a boundary, and arriving exactly on it buys another immediate refusal.
 *
 * When both sources name a time, the LATER one wins. A premature wake is not
 * free: a resume re-writes the whole conversation to cache before the turn
 * says a word (docs/token-budget.md § The fourth), so paying that twice to
 * save a few minutes is the wrong trade. Waiting longer only costs waiting.
 *
 * The result is always at least `graceSec` in the future, so a caller can
 * never schedule a wake in the past and spin on it.
 */
export function resolveWakeAt(
  notice: LimitNotice | null,
  accountResetsAt: string | null | undefined,
  graceSec: number,
  now = Date.now(),
): string {
  const grace = Math.max(0, graceSec) * 1000;
  const candidates: number[] = [];
  const stated = notice?.resetsAt ? Date.parse(notice.resetsAt) : NaN;
  if (Number.isFinite(stated)) candidates.push(stated);
  const account = accountResetsAt ? Date.parse(accountResetsAt) : NaN;
  // An account reset already in the past describes a window that has since
  // rolled over; it is not a deadline to wait for.
  if (Number.isFinite(account) && account > now) candidates.push(account);
  // Nothing stated a time: a full window is the only honest upper bound, and
  // it is also the cap — a stray weekly-window timestamp must not park a task
  // for days when the thing it waits on reopens in at most five hours.
  const target = candidates.length ? Math.max(...candidates) : now + WINDOW_MS;
  const capped = Math.min(Math.max(target, now), now + WINDOW_MS);
  return new Date(capped + grace).toISOString();
}

export const WAKE_WINDOW_MS = WINDOW_MS;
