import type {
  BotCommandSpec,
  InlineKeyboardMarkup,
  TelegramMessage,
  TelegramResponse,
  TelegramUpdate,
  TelegramUser,
} from './types.ts';

// The Bot API client: global `fetch`, no dependency (the same call the repo
// already makes to Sentry). Everything here is transport — who is allowed to
// talk to it lives in bot.ts, what it says lives in commands.ts.

const API_ROOT = 'https://api.telegram.org';

/** Telegram's hard per-message limit. Not a guess; sending more is a 400. */
export const MAX_MESSAGE_CHARS = 4096;

/**
 * A Bot API call that came back `ok: false`, or an HTTP status Telegram itself
 * produced. Separated from a network error on purpose: `fatal` marks the ones
 * where retrying forever is pure noise (a wrong token never becomes right).
 */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    /** seconds Telegram asked us to wait (429), if it said. */
    readonly retryAfter: number | null = null,
    /**
     * True only when TELEGRAM said this — a well-formed `{ ok: false, ... }`
     * envelope. A bare HTTP status is not enough: a captive portal, a
     * corporate proxy or a CDN error page happily answers 401 or 404 with
     * HTML, and that is a transient network condition, not a bad token.
     */
    readonly fromTelegram: boolean = false,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }

  /**
   * 401 = bad token, 404 = the token was revoked/deleted. Neither self-heals,
   * so the bot stops rather than retry forever — which is exactly why the
   * envelope check is load-bearing. Classifying an intercepting proxy's 401
   * HTML page as fatal would kill the bot on an unattended Mac for the
   * duration of a hotel Wi-Fi login, and tell the human to check their token.
   */
  get fatal(): boolean {
    return this.fromTelegram && (this.code === 401 || this.code === 404);
  }
}

/**
 * `& < >` are the only characters Telegram's HTML parse mode treats as markup
 * in text nodes; `"` matters inside an attribute value (href). Escaping all
 * four is the one rule that makes arbitrary strings — task titles, error
 * messages, a stranger's username — safe to interpolate.
 *
 * `'` is deliberately NOT escaped, which is safe only while every attribute
 * this module emits is double-quoted. Callers building an attribute with
 * single quotes must escape it themselves.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Longest entity worth considering: `&#1234567;` and friends. */
const ENTITY_WINDOW = 12;
/** Longest tag worth considering: `<a href="…">` with a real URL in it. */
const TAG_WINDOW = 256;
/** Head room kept back per chunk for the closing tags a cut may have to add. */
const CLOSER_RESERVE = 128;

/**
 * True when cutting at `i` would land inside an HTML entity or a tag, i.e.
 * would produce two halves that neither parse. Chunking escaped text without
 * this check turns `&amp;` into `&am` + `p;` and a 400 from Telegram.
 *
 * Both the backward and the forward scan are windowed. Unbounded ones looked
 * fine and were not: `lastIndexOf('&')` walks to the start of the string on
 * text that has no entity at all, once per candidate cut, and a lone `&`
 * thousands of characters back paired with a distant `;` reports markup where
 * there is none.
 */
function insideMarkup(s: string, i: number): boolean {
  const openers: [string, string, number][] = [
    ['&', ';', ENTITY_WINDOW],
    ['<', '>', TAG_WINDOW],
  ];
  for (const [open, close, window] of openers) {
    const start = s.lastIndexOf(open, i - 1);
    if (start < Math.max(0, i - window)) continue;
    const end = s.indexOf(close, start);
    // No closer within the window either: an unpaired `&` or `<`, not markup.
    if (end >= i && end - start <= window) return true;
  }
  return false;
}

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g;
const tagName = (openTag: string) => /^<\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(openTag)?.[1].toLowerCase() ?? '';

/**
 * The open tags left dangling at the end of `html`, innermost last, kept as
 * their FULL opening text so attributes (`<a href="…">`) survive a reopen.
 * Telegram's HTML subset has no void elements, so every `<x>` needs an `</x>`.
 */
function danglingTags(html: string): string[] {
  const stack: string[] = [];
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(html); m; m = TAG_RE.exec(html)) {
    if (m[1]) {
      const name = m[2].toLowerCase();
      for (let i = stack.length - 1; i >= 0; i--) {
        if (tagName(stack[i]) === name) {
          stack.splice(i, 1);
          break;
        }
      }
    } else {
      stack.push(m[0]);
    }
  }
  return stack;
}

const closersFor = (open: string[]) =>
  open
    .map((t) => `</${tagName(t)}>`)
    .reverse()
    .join('');

/**
 * Split a message into <=4096-char pieces, preferring a newline boundary so a
 * chunk break reads as a paragraph break.
 *
 * Each piece is parsed by Telegram independently, so a tag pair may not span
 * one: a cut that lands inside `<b>…</b>` closes the tag at the end of the
 * chunk and REOPENS it at the start of the next. Without that, any line longer
 * than 4096 characters — a report, an agent's output — comes back "Unmatched
 * start tag" and the whole message is lost.
 *
 * Not preserved: trailing whitespace on a chunk, and the newline a chunk was
 * broken at. Everything else survives.
 */
export function chunkMessage(text: string, max = MAX_MESSAGE_CHARS): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  /** tags to reopen at the head of the next chunk */
  let carry: string[] = [];
  while (rest.length) {
    const prefix = carry.join('');
    if (prefix.length + rest.length <= max) {
      out.push(prefix + rest);
      break;
    }
    // Room for the body, once the reopened tags and the closers are paid for.
    const room = Math.max(64, max - prefix.length - CLOSER_RESERVE);
    let cut = rest.lastIndexOf('\n', room);
    if (cut <= 0) cut = rest.lastIndexOf(' ', room);
    if (cut <= 0) cut = room;
    const candidate = cut;
    while (cut > 1 && insideMarkup(rest, cut)) cut--;
    // `cut === 1` means the back-off walked the whole candidate away (a single
    // 4096-character "tag"). Take the original cut rather than emit one
    // character per iteration: pathological input ships, it does not hang.
    if (cut <= 1) cut = candidate > 1 ? candidate : room;

    let piece = prefix + rest.slice(0, cut).trimEnd();
    let open = danglingTags(piece);
    // Deep nesting can still overrun the reserve; give the closers their room
    // back out of the body rather than send a message Telegram will refuse.
    if (piece.length + closersFor(open).length > max) {
      cut = Math.max(1, cut - closersFor(open).length);
      while (cut > 1 && insideMarkup(rest, cut)) cut--;
      piece = prefix + rest.slice(0, cut).trimEnd();
      open = danglingTags(piece);
    }
    out.push(piece + closersFor(open));
    carry = open;
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  return out;
}

/**
 * What a command handler or a flow step hands back: the HTML to send, and
 * optionally the inline keyboard that rides its last chunk. A bare string is
 * the common case and stays legal everywhere a `Reply` is accepted.
 */
export interface Reply {
  html: string;
  keyboard?: InlineKeyboardMarkup;
  /**
   * Whether the WRITE behind this reply succeeded. Absent means "nothing was
   * written, or it worked" — the audit trail reads `ok !== false`. A refusal
   * ("cannot enqueue from status 'running'") is a perfectly good sentence to
   * send AND a failed action, and conflating the two is how `tm_events` ends up
   * answering "did /publish publish?" differently depending on whether the
   * owner typed the command or tapped the button.
   */
  ok?: boolean;
}

export type ReplyLike = string | Reply;

export function toReply(r: ReplyLike): Reply {
  return typeof r === 'string' ? { html: r } : r;
}

export interface CallOptions {
  /** per-request ceiling; the long poll passes its own, much larger. */
  timeoutMs?: number;
  /** aborted by TelegramBot.stop() so shutdown does not wait out a long poll. */
  signal?: AbortSignal;
}

export class TelegramApi {
  constructor(private readonly token: string) {}

  /**
   * The token is a credential and it is IN THE URL, so it turns up inside
   * `TypeError: Failed to parse URL from https://api.telegram.org/bot<token>/…`
   * — which every failure path then logs. Every message this class produces
   * goes through here first.
   */
  redact(s: string): string {
    return this.token ? s.split(this.token).join('<bot-token>') : s;
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> {
    const { timeoutMs = 20_000, signal } = opts;
    // Composed by hand rather than with AbortSignal.any(): one controller that
    // both the timeout and the caller's stop signal can trip is easier to
    // reason about than two signals with different abort reasons.
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal) {
      if (signal.aborted) ac.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let body: TelegramResponse<T>;
    let status = 0;
    try {
      const res = await fetch(`${API_ROOT}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: ac.signal,
      });
      status = res.status;
      // Reading the body is INSIDE the abort scope on purpose. `fetch` resolves
      // as soon as the headers land; tearing the timeout down here left a
      // half-sent body from a stalled proxy able to wedge the poll loop
      // forever, past both the per-call timeout and stop().
      try {
        body = (await res.json()) as TelegramResponse<T>;
      } catch {
        // A non-JSON body means a proxy or an outage answered, not Telegram —
        // so `fromTelegram` stays false and this backs off like any other
        // network error, however authoritative the status code looks.
        throw new TelegramApiError(
          `${method}: HTTP ${status} with a non-JSON body (an intercepting proxy or outage, not Telegram)`,
          status,
        );
      }
    } catch (e) {
      if (e instanceof TelegramApiError) throw e;
      throw new TelegramApiError(this.redact(e instanceof Error ? e.message : String(e)), status || null);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (!body.ok) {
      throw new TelegramApiError(
        this.redact(`${method}: ${body.description ?? `HTTP ${status}`}`),
        body.error_code ?? status,
        body.parameters?.retry_after ?? null,
        // A parsed `ok: false` envelope: Telegram itself is the one refusing.
        true,
      );
    }
    return body.result as T;
  }

  getMe(opts?: CallOptions): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe', {}, opts);
  }

  getUpdates(
    params: { offset: number; limit?: number; timeout: number; allowed_updates?: string[] },
    opts?: CallOptions,
  ): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>('getUpdates', params, opts);
  }

  setMyCommands(commands: BotCommandSpec[], opts?: CallOptions): Promise<boolean> {
    return this.call<boolean>('setMyCommands', { commands }, opts);
  }

  /**
   * Send `html`, chunked. Sequential on purpose: parallel sends arrive out of
   * order, and a 5-part report read backwards is worse than a slow one.
   * `link_preview_options` is off because a bare repo path or URL in a status
   * line should not turn into a card.
   *
   * `keyboard` (inline buttons) rides the LAST chunk: buttons under a message
   * that continues below them read as belonging to the wrong text.
   */
  async sendMessage(
    chatId: number,
    html: string,
    opts?: CallOptions,
    keyboard?: InlineKeyboardMarkup,
  ): Promise<TelegramMessage[]> {
    const sent: TelegramMessage[] = [];
    const parts = chunkMessage(html).filter((p) => p.trim());
    for (let i = 0; i < parts.length; i++) {
      sent.push(
        await this.call<TelegramMessage>(
          'sendMessage',
          {
            chat_id: chatId,
            text: parts[i],
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            ...(keyboard && i === parts.length - 1 ? { reply_markup: keyboard } : {}),
          },
          opts,
        ),
      );
    }
    return sent;
  }

  /**
   * Settle a button press (stops the client's spinner). `text` shows as a
   * small toast; empty settles silently. Best-effort at every call site — a
   * failed toast must never fail the action it acknowledges.
   */
  answerCallbackQuery(callbackQueryId: string, text?: string, opts?: CallOptions): Promise<boolean> {
    return this.call<boolean>(
      'answerCallbackQuery',
      { callback_query_id: callbackQueryId, ...(text ? { text: text.slice(0, 200) } : {}) },
      opts,
    );
  }
}
