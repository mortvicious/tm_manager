// The slice of the Telegram Bot API this server actually reads. Deliberately
// partial: every field the bot does not use is a field that cannot break it
// when Telegram adds, renames or omits one. Anything unmodelled arrives as
// `unknown` on TelegramUpdate and is ignored by the router.

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  /** 'private' is the only type this bot serves — see the gate in bot.ts. */
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  /** unix SECONDS, not ms — the boot-discard comparison depends on it. */
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}

/** An inline-keyboard button press. Routed since task 2 (notifications). */
export interface TelegramCallbackQuery {
  id: string;
  from?: TelegramUser;
  /** the message the button was attached to; absent when it aged out (>48h) */
  message?: TelegramMessage;
  /** the button's callback_data — the action string the notifier attached */
  data?: string;
}

export interface InlineKeyboardButton {
  text: string;
  /** <=64 bytes by Telegram's rule; the action codec in bot.ts stays short */
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  /**
   * Requested (`allowed_updates: ['message', 'callback_query']`) and routed to
   * the button handler. Note it carries no time of its own: the `message` it
   * hangs off can be days old (a button pressed on an old notification), which
   * is why updateTimestamp() refuses to date it — the boot filter treats it as
   * stale (a press from before the restart must not fire), while the live poll
   * loop treats it as fresh (it was pressed just now, whatever the message's
   * age).
   */
  callback_query?: TelegramCallbackQuery;
}

/** Every Bot API response is this envelope — `ok` decides which half is set. */
export interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export interface BotCommandSpec {
  command: string;
  description: string;
}
