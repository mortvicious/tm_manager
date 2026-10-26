// The CLI's Notification hook fires for far more than prompts. Its input is
// `{ hook_event_name, message, title?, notification_type }`, and the CLI's own
// `notification_type` — never the message text — decides whether anybody has
// to look (docs/design.md § Completion detection, decisions.md 2026-10-26).
//
// This is a DENY-list on purpose: the type list already differs between the
// hooks docs and the binary (2.1.280), so an allow-list would silently drop a
// future real prompt type — the hidden deadlock the hook exists to prevent.
// An unknown or missing type still raises the flag.

/** Notification types that are not a prompt anybody has to answer. */
export const NON_PROMPT_NOTIFICATIONS = {
  exact: [
    'idle_prompt', // the ~60 s "Claude is waiting for your input"
    'auth_success',
    'agent_completed',
    'elicitation_complete',
    'elicitation_response',
    'push_notification',
    'model_refusal_fallback',
    'plugin_notification',
  ],
  prefixes: ['quota_auto_resume_', 'computer_use_'],
} as const;

/** Longest notification message kept in a `run.attention` audit row. */
export const ATTENTION_MESSAGE_MAX = 300;

export interface HookNotification {
  /** The CLI's `notification_type`; null when the payload carried none. */
  type: string | null;
  message: string | null;
}

export function readNotification(body: unknown): HookNotification {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const type = typeof b.notification_type === 'string' && b.notification_type ? b.notification_type : null;
  const message = typeof b.message === 'string' ? b.message : null;
  return { type, message };
}

export function isNonPromptNotification(type: string | null): boolean {
  if (!type) return false;
  if ((NON_PROMPT_NOTIFICATIONS.exact as readonly string[]).includes(type)) return true;
  return NON_PROMPT_NOTIFICATIONS.prefixes.some((p) => type.startsWith(p));
}

/** The CLI's idle notice: by type, or — only when the payload has no type
 *  (an older CLI) — by its text. */
export function isIdleNotification(n: HookNotification): boolean {
  if (n.type) return n.type === 'idle_prompt';
  return !!n.message && /waiting for your input/i.test(n.message);
}

/** `run.attention` audit data, so the flags can be grouped by kind afterwards. */
export function attentionData(n: HookNotification): { type: string | null; message: string | null } {
  const message =
    n.message && n.message.length > ATTENTION_MESSAGE_MAX ? `${n.message.slice(0, ATTENTION_MESSAGE_MAX)}…` : n.message;
  return { type: n.type, message };
}
