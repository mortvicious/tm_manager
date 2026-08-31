import { NOTIFY_CLASSES, type TelegramNotifyConfig } from '../config.ts';
import type { Orchestrator } from '../orchestrator.ts';
import type { Storage } from '../storage/types.ts';
import { escapeHtml } from './api.ts';
import { collectStatus, renderStatus, type GateCounters } from './status.ts';
import type { BotCommandSpec, TelegramMessage } from './types.ts';

// The router. One table, one lookup, no HTTP: a handler calls the same service
// functions the REST routes call (docs/telegram.md § In-process, never HTTP).
// Handlers return the HTML to send — they never touch the network themselves,
// which is what makes them testable without a bot token.

export interface CommandContext {
  storage: Storage;
  orchestrator: Orchestrator;
  counters: GateCounters;
  bootedAt: string;
  /** the LIVE notify config — mutations here take effect immediately */
  notify: TelegramNotifyConfig;
  /** write cfg.notify back to data/config.json; the error text on failure */
  persistNotify(): string | null;
  /** everything after the command word, trimmed; '' when there was none */
  args: string;
  message: TelegramMessage;
}

export interface BotCommand extends BotCommandSpec {
  handler(ctx: CommandContext): Promise<string>;
}

export const COMMANDS: BotCommand[] = [
  {
    command: 'start',
    description: 'What this bot is',
    async handler() {
      return [
        `<b>Task Manager</b> — the phone side of the board running on the Mac.`,
        ``,
        `This bot talks to the server in-process: it can read and steer the queue,`,
        `but it deliberately does not expose a terminal.`,
        ``,
        `Send /status for the current state, /help for the commands.`,
      ].join('\n');
    },
  },
  {
    command: 'help',
    description: 'List the commands',
    async handler() {
      const rows = COMMANDS.map((c) => `/${c.command} — ${escapeHtml(c.description)}`);
      return [`<b>Commands</b>`, ``, ...rows].join('\n');
    },
  },
  {
    command: 'status',
    description: 'Queue, agents, usage, review count',
    async handler(ctx) {
      return renderStatus(await collectStatus(ctx.storage, ctx.orchestrator, ctx.counters, ctx.bootedAt));
    },
  },
  {
    command: 'notify',
    description: 'Show or toggle notification classes',
    async handler(ctx) {
      if (!ctx.args) return renderNotify(ctx.notify);
      const [name, value] = ctx.args.toLowerCase().split(/\s+/, 2);
      const cls = NOTIFY_CLASSES.find((c) => c === name);
      if (!cls) {
        return (
          `Unknown class <code>${escapeHtml(name)}</code>. ` +
          `Usage: <code>/notify &lt;class&gt; [on|off]</code>\n\n` +
          renderNotify(ctx.notify)
        );
      }
      // No value = toggle; explicit on/off wins.
      const next = value === 'on' ? true : value === 'off' ? false : !ctx.notify[cls];
      ctx.notify[cls] = next;
      return `${cls}: <b>${next ? 'on' : 'off'}</b>${persistSuffix(ctx)}`;
    },
  },
  {
    command: 'mute',
    description: 'Mute all notifications',
    async handler(ctx) {
      for (const cls of NOTIFY_CLASSES) ctx.notify[cls] = false;
      return `All notifications <b>muted</b>. /unmute restores them; commands still answer.${persistSuffix(ctx)}`;
    },
  },
  {
    command: 'unmute',
    description: 'Unmute all notifications',
    async handler(ctx) {
      for (const cls of NOTIFY_CLASSES) ctx.notify[cls] = true;
      return `All notifications <b>on</b>.${persistSuffix(ctx)}`;
    },
  },
];

function renderNotify(notify: TelegramNotifyConfig): string {
  const rows = NOTIFY_CLASSES.map((c) => `${notify[c] ? '🔔' : '🔕'} <code>${c}</code> — ${notify[c] ? 'on' : 'off'}`);
  return [
    `<b>Notification classes</b> (<code>/notify &lt;class&gt; [on|off]</code>, /mute, /unmute)`,
    ``,
    ...rows,
  ].join('\n');
}

/** The toggle applied in memory either way; say so when it did not persist. */
function persistSuffix(ctx: CommandContext): string {
  const err = ctx.persistNotify();
  return err ? `\n⚠ Applied for this run, but not saved to config.json: ${escapeHtml(err)}` : '';
}

const BY_NAME = new Map(COMMANDS.map((c) => [c.command, c]));

export function commandSpecs(): BotCommandSpec[] {
  return COMMANDS.map(({ command, description }) => ({ command, description }));
}

export interface ParsedCommand {
  name: string;
  args: string;
  /** the `@bot` a shared chat addressed it to, when it named one */
  to: string | null;
}

/**
 * Telegram sends `/status`, and in a shared chat `/status@my_bot`. Parse both,
 * and only when the text STARTS with the slash — a message merely containing
 * one is free text, which this task does not handle (see docs/telegram.md).
 *
 * The `@bot` part is KEPT, not discarded: `/status@some_other_bot` is a
 * command aimed at a different bot that Telegram delivers to us anyway, and
 * answering it is answering someone else's conversation.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[3] ?? '').trim(), to: m[2] ?? null };
}

export function findCommand(name: string): BotCommand | undefined {
  return BY_NAME.get(name);
}

export function unknownCommandReply(name: string): string {
  return `Unknown command <code>/${escapeHtml(name)}</code>. Send /help for the list.`;
}
