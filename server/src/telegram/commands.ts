import {
  CUSTOM_QUEUE_IN_FLIGHT_STATUSES,
  TERMINAL_TASK_STATUSES,
  customQueueWaiting,
  matchTaskPreset,
  type Feature,
  type Proposal,
  type Task,
  type TaskStatus,
} from '@tm/shared';
import { NOTIFY_CLASSES, type TelegramNotifyConfig } from '../config.ts';
import type { Orchestrator } from '../orchestrator.ts';
import type { Storage } from '../storage/types.ts';
import {
  acceptProposal,
  approveFeature,
  cancelTask,
  completeTask,
  encodeAction,
  enqueueTask,
  followUpTask,
  killRun,
  proceedTask,
  publishTask,
  queueAdd,
  queueRemove,
  rejectProposal,
  retryTask,
  runNowTask,
  setQueueEnabled,
  unblockTask,
  type ActionOutcome,
  type ButtonAction,
} from './actions.ts';
import { escapeHtml, type Reply, type ReplyLike } from './api.ts';
import { FlowStore, startEdit, startFeature, startNew, startProceed } from './flows.ts';
import { resolveFeature, resolveLiveRun, resolveProposal, resolveRepo, resolveTask, short } from './ids.ts';
import { collectStatus, formatClock, renderStatus, type GateCounters } from './status.ts';
import type { BotCommandSpec, TelegramMessage } from './types.ts';

// The router. One table, one lookup, no HTTP: a handler calls the same service
// functions the REST routes call (docs/telegram.md § In-process, never HTTP).
// Handlers return what to send — they never touch the network themselves,
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
  /** the single conversational flow (docs/telegram.md § Conversations) */
  flows: FlowStore;
  /** what the audit trail records — always 'telegram' in production */
  actor: string;
  /** everything after the command word, trimmed; '' when there was none */
  args: string;
  message: TelegramMessage;
}

export interface BotCommand extends BotCommandSpec {
  handler(ctx: CommandContext): Promise<ReplyLike>;
}

// ---- rendering ----------------------------------------------------------

const STATUS_ICON: Record<TaskStatus, string> = {
  draft: '📝',
  queued: '⏳',
  running: '⚙️',
  blocked: '⛔',
  review: '📋',
  published: '🚀',
  done: '✅',
  failed: '❌',
  cancelled: '🚫',
};

const FEATURE_ICON: Record<string, string> = {
  draft: '📝',
  analyzing: '🔎',
  proposed: '🧩',
  approved: '👍',
  running: '⚙️',
  paused: '⏸',
  review: '📋',
  done: '✅',
  failed: '❌',
  cancelled: '🚫',
};

/** How many rows a list command prints before it says "and N more". */
const LIST_LIMIT = 30;

function taskLine(t: Task, repoName?: string): string {
  const mark = t.customQueueAt ? '➕' : '';
  const repo = repoName ? ` · <i>${escapeHtml(repoName)}</i>` : '';
  return `${STATUS_ICON[t.status]}${mark} <code>${short(t.id)}</code> ${escapeHtml(t.title)}${repo}`;
}

function listOf(items: string[], empty: string): string {
  if (items.length === 0) return empty;
  const shown = items.slice(0, LIST_LIMIT);
  const more = items.length > shown.length ? `\n\n…and ${items.length - shown.length} more` : '';
  return shown.join('\n') + more;
}

/**
 * The action layer speaks plain text; a chat message wants it escaped — and
 * the audit row wants to know whether the write actually happened. Returning a
 * `Reply` rather than a string is what carries `ok` all the way to
 * `tm_events`; a bare string would be audited `ok: true` however loudly the
 * sentence says otherwise.
 */
function say(r: ActionOutcome): Reply {
  return { html: `${r.ok ? '✅' : '⚠'} ${escapeHtml(r.text)}`, ok: r.ok };
}

const TASK_STATUSES = Object.keys(STATUS_ICON) as TaskStatus[];

// ---- id-taking commands -------------------------------------------------

/**
 * Every lifecycle command has the same shape: resolve a short id, run one
 * action, answer with its sentence. Sharing it means an ambiguity error reads
 * the same everywhere and a new command cannot forget the resolution rules.
 */
function taskCommand(
  command: string,
  description: string,
  run: (ctx: CommandContext, task: Task) => Promise<ActionOutcome>,
): BotCommand {
  return {
    command,
    description,
    async handler(ctx) {
      if (!ctx.args) return `Usage: <code>/${command} &lt;task id&gt;</code> — see /tasks for the ids.`;
      const found = await resolveTask(ctx.storage, ctx.args.split(/\s+/)[0]);
      if (!found.ok) return escapeHtml(found.error);
      return say(await run(ctx, found.value));
    },
  };
}

const deps = (ctx: CommandContext) => ({ storage: ctx.storage, orchestrator: ctx.orchestrator });

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
      return [
        `<b>Commands</b>`,
        ``,
        ...rows,
        ``,
        `<i>Ids are short: the first 4+ characters of the one /tasks prints is enough.</i>`,
      ].join('\n');
    },
  },
  {
    command: 'status',
    description: 'Queue, agents, usage, review count',
    async handler(ctx) {
      return renderStatus(await collectStatus(ctx.storage, ctx.orchestrator, ctx.counters, ctx.bootedAt));
    },
  },

  // ---- orientation ------------------------------------------------------
  {
    command: 'repos',
    description: 'Registered repos',
    async handler(ctx) {
      const [repos, tasks] = await Promise.all([ctx.storage.listRepos(), ctx.storage.listTasks()]);
      const rows = repos.map((r) => {
        const open = tasks.filter((t) => t.repoId === r.id && !TERMINAL_TASK_STATUSES.includes(t.status)).length;
        return (
          `<code>${short(r.id)}</code> <b>${escapeHtml(r.name)}</b> — ${open} open\n` +
          `  <i>${escapeHtml(r.path)}</i>`
        );
      });
      return [`<b>Repos</b>`, ``, listOf(rows, 'No repos are registered yet.')].join('\n');
    },
  },
  {
    command: 'tasks',
    description: 'List tasks — /tasks [status|repo]',
    async handler(ctx) {
      const repos = await ctx.storage.listRepos();
      const name = (id: string | null) => repos.find((r) => r.id === id)?.name;
      const arg = ctx.args.trim().toLowerCase();
      let tasks: Task[];
      let head: string;
      if (!arg) {
        // The default is "what is live", not "everything": a board with a
        // year of done rows would answer a question nobody asked.
        tasks = (await ctx.storage.listTasks()).filter((t) => !TERMINAL_TASK_STATUSES.includes(t.status));
        head = '<b>Open tasks</b>';
      } else if ((TASK_STATUSES as string[]).includes(arg)) {
        tasks = await ctx.storage.listTasks({ status: arg as TaskStatus });
        head = `<b>Tasks — ${escapeHtml(arg)}</b>`;
      } else {
        const repo = await resolveRepo(ctx.storage, arg);
        if (!repo.ok) {
          return (
            escapeHtml(repo.error) +
            `\n\nOr use a status: <code>${TASK_STATUSES.join('</code> <code>')}</code>`
          );
        }
        tasks = await ctx.storage.listTasks({ repoId: repo.value.id });
        head = `<b>Tasks — ${escapeHtml(repo.value.name)}</b>`;
      }
      // Newest first: on a phone the thing you just filed is what you want.
      tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return [head, ``, listOf(tasks.map((t) => taskLine(t, name(t.repoId))), 'Nothing here.')].join('\n');
    },
  },
  {
    command: 'task',
    description: 'One task in full — /task <id>',
    async handler(ctx) {
      if (!ctx.args) return 'Usage: <code>/task &lt;id&gt;</code>';
      const found = await resolveTask(ctx.storage, ctx.args.split(/\s+/)[0]);
      if (!found.ok) return escapeHtml(found.error);
      const t = found.value;
      const repo = t.repoId ? await ctx.storage.getRepo(t.repoId) : null;
      const preset = matchTaskPreset({ model: t.model, effort: t.effort, review: t.review });
      const lines = [
        `${STATUS_ICON[t.status]} <b>${escapeHtml(t.title)}</b>`,
        `<code>${short(t.id)}</code> · ${escapeHtml(t.status)}${repo ? ` · ${escapeHtml(repo.name)}` : ''}${t.category ? ` · ${escapeHtml(t.category)}` : ''}`,
        ``,
      ];
      if (t.description) lines.push(escapeHtml(t.description), ``);
      lines.push(
        `model <code>${escapeHtml(t.model ?? 'default')}</code> · effort <code>${escapeHtml(t.effort ?? 'default')}</code> · ` +
          `review <code>${t.review === null ? 'default' : t.review ? 'on' : 'off'}</code> · ` +
          `auto-publish <code>${t.autoPublish ? 'on' : 'off'}</code>` +
          (preset ? ` (${escapeHtml(preset.label)})` : ''),
      );
      if (t.customQueueAt) lines.push(await queueLine(ctx, t));
      if (t.featureId) lines.push(`🧩 feature <code>${short(t.featureId)}</code> · phase ${(t.featurePhase ?? 0) + 1}`);
      if (t.resultSummary) lines.push(``, `<b>Result</b>`, escapeHtml(t.resultSummary));
      if (t.reviewSummary) lines.push(``, `<b>Review</b>`, escapeHtml(t.reviewSummary));
      if (t.error) lines.push(``, `⚠ ${escapeHtml(t.error)}`);
      lines.push(``, `Updated ${escapeHtml(formatClock(t.updatedAt))}`);
      return { html: lines.join('\n'), keyboard: taskActionKeyboard(t) };
    },
  },

  // ---- creating and editing --------------------------------------------
  {
    command: 'new',
    description: 'New task — repo, title, settings, then draft/queue/run',
    async handler(ctx) {
      return startNew({ ...deps(ctx), actor: ctx.actor }, ctx.flows, ctx.args);
    },
  },
  {
    command: 'edit',
    description: 'Edit a task — /edit <id>',
    async handler(ctx) {
      if (!ctx.args) return 'Usage: <code>/edit &lt;task id&gt;</code>';
      const found = await resolveTask(ctx.storage, ctx.args.split(/\s+/)[0]);
      if (!found.ok) return escapeHtml(found.error);
      return startEdit(ctx.flows, found.value.id, found.value.title);
    },
  },

  // ---- lifecycle --------------------------------------------------------
  taskCommand('enqueue', 'Queue a task — /enqueue <id>', (ctx, t) => enqueueTask(deps(ctx), t.id, ctx.actor)),
  taskCommand('run', 'Run a task now — /run <id>', (ctx, t) => runNowTask(deps(ctx), t.id, ctx.actor)),
  taskCommand('cancel', 'Cancel a task — /cancel <id>', (ctx, t) => cancelTask(deps(ctx), t.id, ctx.actor)),
  taskCommand('retry', 'Retry a failed task — /retry <id>', (ctx, t) => retryTask(deps(ctx), t.id, ctx.actor)),
  taskCommand('unblock', 'Unblock a task — /unblock <id>', (ctx, t) => unblockTask(deps(ctx), t.id, ctx.actor)),
  taskCommand('complete', 'Mark a reviewed task done — /complete <id>', (ctx, t) =>
    completeTask(deps(ctx), t.id, ctx.actor),
  ),
  taskCommand('publish', 'Commit and push a reviewed task — /publish <id>', (ctx, t) =>
    publishTask(deps(ctx), t.id, ctx.actor),
  ),
  {
    command: 'proceed',
    description: 'Continue a task’s own session — /proceed <id> [text]',
    async handler(ctx) {
      if (!ctx.args) return 'Usage: <code>/proceed &lt;task id&gt; [what to do next]</code>';
      // Split ONCE, on the first run of whitespace: re-joining `split(/\s+/)`
      // would flatten the newlines and indentation out of a multi-line
      // instruction before it ever reached the agent's prompt, while the
      // no-text flow path passes what was typed through verbatim. Two ways of
      // doing the same thing must not disagree about the text.
      const m = /^(\S+)\s*([\s\S]*)$/.exec(ctx.args);
      const idArg = m?.[1] ?? ctx.args;
      const found = await resolveTask(ctx.storage, idArg);
      if (!found.ok) return escapeHtml(found.error);
      const message = (m?.[2] ?? '').trim();
      // No text: ask for it rather than resuming with the generic "carry on" —
      // on a phone the reason you reach for /proceed is that you have something
      // specific to say.
      // Whether a session can be resumed decides WHICH move runs, never whether
      // the instruction is collected. `proceed` (mode 'resume') refuses when
      // nothing is resumable; the web drawer's follow-up field passes 'auto',
      // which spawns a fresh worker CARRYING the message. Refusing here left
      // the phone with no way to instruct such a task at all — `/run` starts an
      // agent off the description and throws the typed instruction away.
      const resumable = (await ctx.orchestrator.resumableSessionId(found.value.id)) !== null;
      if (!message) return startProceed(ctx.flows, found.value.id, found.value.title, resumable);
      return say(
        resumable
          ? await proceedTask(deps(ctx), found.value.id, ctx.actor, message)
          : await followUpTask(deps(ctx), found.value.id, message, ctx.actor),
      );
    },
  },
  {
    command: 'queue',
    description: 'Custom queue — /queue [add|remove <id>]',
    async handler(ctx) {
      const [verb, ...rest] = ctx.args.split(/\s+/).filter(Boolean);
      if (!verb) {
        const all = await ctx.storage.listTasks();
        const repos = await ctx.storage.listRepos();
        const name = (id: string | null) => repos.find((r) => r.id === id)?.name;
        // The same two-part split the board makes: `queue #n` is only ever
        // shown for a member that is still WAITING, while a member that is
        // running, in review or blocked keeps its mark because it still holds
        // its repo's place — it has no position left to report.
        const waiting = customQueueWaiting(all);
        const inFlight = all
          .filter((t) => t.customQueueAt && CUSTOM_QUEUE_IN_FLIGHT_STATUSES.includes(t.status))
          .sort((a, b) => (a.customQueueAt ?? '').localeCompare(b.customQueueAt ?? ''));
        const out = [`<b>Custom queue</b> — serial, one task at a time, independent of /on /off`, ``];
        out.push(listOf(waiting.map((t, i) => `<b>#${i + 1}</b> ${taskLine(t, name(t.repoId))}`), 'Nothing waiting.'));
        if (inFlight.length) {
          out.push(``, `<b>Holding a place</b> (not waiting — they own their repo's tree)`, ``);
          out.push(listOf(inFlight.map((t) => taskLine(t, name(t.repoId))), ''));
        }
        out.push(``, `<code>/queue add &lt;id&gt;</code> · <code>/queue remove &lt;id&gt;</code>`);
        return out.join('\n');
      }
      const v = verb.toLowerCase();
      if (v !== 'add' && v !== 'remove') return 'Usage: <code>/queue [add|remove &lt;id&gt;]</code>';
      if (rest.length === 0) return `Usage: <code>/queue ${v} &lt;task id&gt;</code>`;
      const found = await resolveTask(ctx.storage, rest[0]);
      if (!found.ok) return escapeHtml(found.error);
      return say(
        v === 'add'
          ? await queueAdd(deps(ctx), found.value.id, ctx.actor)
          : await queueRemove(deps(ctx), found.value.id, ctx.actor),
      );
    },
  },

  // ---- proposals & features --------------------------------------------
  {
    command: 'proposals',
    description: 'Pending agent proposals',
    async handler(ctx) {
      const pending = await ctx.storage.listProposals({ status: 'pending' });
      const rows = pending.map((p) => proposalLine(p));
      return [
        `<b>Pending proposals</b>`,
        ``,
        listOf(rows, 'Nothing pending.'),
        ...(pending.length ? [``, `<code>/accept &lt;id&gt; [option]</code> · <code>/reject &lt;id&gt;</code>`] : []),
      ].join('\n');
    },
  },
  {
    command: 'accept',
    description: 'Accept a proposal — /accept <id> [option]',
    async handler(ctx) {
      const [idArg, optArg] = ctx.args.split(/\s+/).filter(Boolean);
      if (!idArg) return 'Usage: <code>/accept &lt;proposal id&gt; [option number]</code>';
      const found = await resolveProposal(ctx.storage, idArg);
      if (!found.ok) return escapeHtml(found.error);
      // 1-based on the wire (the listing numbers them from 1), 0-based inside.
      const option = optArg === undefined ? undefined : Number(optArg) - 1;
      if (option !== undefined && (!Number.isInteger(option) || option < 0)) {
        return 'The option must be a number — the listing numbers them from 1.';
      }
      return say(await acceptProposal(deps(ctx), found.value.id, ctx.actor, option));
    },
  },
  {
    command: 'reject',
    description: 'Reject a proposal — /reject <id>',
    async handler(ctx) {
      if (!ctx.args) return 'Usage: <code>/reject &lt;proposal id&gt;</code>';
      const found = await resolveProposal(ctx.storage, ctx.args.split(/\s+/)[0]);
      if (!found.ok) return escapeHtml(found.error);
      return say(await rejectProposal(deps(ctx), found.value.id, ctx.actor));
    },
  },
  {
    command: 'feature',
    description: 'New feature from a long request — /feature [text]',
    async handler(ctx) {
      return startFeature({ ...deps(ctx), actor: ctx.actor }, ctx.flows, ctx.args);
    },
  },
  {
    command: 'features',
    description: 'List features',
    async handler(ctx) {
      const [features, repos] = await Promise.all([ctx.storage.listFeatures(), ctx.storage.listRepos()]);
      features.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const rows = features.map((f) => featureLine(f, repos.find((r) => r.id === f.repoId)?.name));
      return [
        `<b>Features</b>`,
        ``,
        listOf(rows, 'No features yet — /feature starts one.'),
        ...(features.length ? [``, `<code>/approve &lt;id&gt;</code> approves a proposed plan and starts it.`] : []),
      ].join('\n');
    },
  },
  {
    command: 'approve',
    description: 'Approve a proposed feature and start it — /approve <id>',
    async handler(ctx) {
      if (!ctx.args) return 'Usage: <code>/approve &lt;feature id&gt;</code>';
      const found = await resolveFeature(ctx.storage, ctx.args.split(/\s+/)[0]);
      if (!found.ok) return escapeHtml(found.error);
      return say(await approveFeature(deps(ctx), found.value.id, ctx.actor));
    },
  },

  // ---- orchestrator -----------------------------------------------------
  {
    command: 'on',
    description: 'Start picking tasks',
    async handler(ctx) {
      return say(await setQueueEnabled(deps(ctx), true, ctx.actor));
    },
  },
  {
    command: 'off',
    description: 'Stop picking tasks (live sessions keep running)',
    async handler(ctx) {
      return say(await setQueueEnabled(deps(ctx), false, ctx.actor));
    },
  },
  {
    command: 'kill',
    description: 'Kill a live run — /kill <run id>',
    async handler(ctx) {
      if (!ctx.args) {
        // Queried only on the listing path — with an id, `resolveLiveRun`
        // fetches the same rows and this one went unused.
        const runs = await ctx.storage.listRuns({ status: 'running' });
        const rows = await Promise.all(
          runs.map(async (r) => {
            const t = r.taskId ? await ctx.storage.getTask(r.taskId) : null;
            return `<code>${short(r.id)}</code> ${escapeHtml(r.mode)} — ${escapeHtml(t?.title ?? 'no task')}`;
          }),
        );
        const html = [
          `<b>Live runs</b>`,
          ``,
          listOf(rows, 'Nothing is running.'),
          ``,
          `<code>/kill &lt;run id&gt;</code>`,
        ].join('\n');
        // One button per run, so the listing is actionable without retyping an
        // id — `run.kill` was already in the codec with nothing emitting it.
        if (runs.length === 0) return html;
        return {
          html,
          keyboard: {
            inline_keyboard: runs
              .slice(0, LIST_LIMIT)
              .map((r) => [
                { text: `✖ kill ${short(r.id)}`, callback_data: encodeAction({ kind: 'run.kill', id: r.id }) },
              ]),
          },
        };
      }
      const found = await resolveLiveRun(ctx.storage, ctx.args.split(/\s+/)[0]);
      if (!found.ok) return escapeHtml(found.error);
      return say(await killRun(deps(ctx), found.value.id, ctx.actor));
    },
  },

  // ---- bot ---------------------------------------------------------------
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

/**
 * Where a custom-queue member stands. The ordinal comes from the SHARED
 * `customQueueWaiting()` the board's `queue #n` chip uses, so `/task` and the
 * browser cannot tell the same task a different number — the mark survives
 * into `running`/`review`/`blocked` (the member still holds its repo's place),
 * and counting those would inflate every position by however many were in
 * flight.
 */
async function queueLine(ctx: CommandContext, t: Task): Promise<string> {
  const added = ` · added ${escapeHtml(formatClock(t.customQueueAt!))}`;
  if (t.status === 'running') return `➕ holding the custom queue's single slot${added}`;
  if (CUSTOM_QUEUE_IN_FLIGHT_STATUSES.includes(t.status)) {
    return `➕ in the custom queue — holding its repo's place while it is ${escapeHtml(t.status)}${added}`;
  }
  const waiting = customQueueWaiting(await ctx.storage.listTasks());
  const at = waiting.findIndex((m) => m.id === t.id) + 1;
  if (at === 0) return `➕ in the custom queue${added}`;
  return `➕ custom queue <b>#${at}</b> of ${waiting.length} waiting${added}`;
}

/**
 * The buttons a task's CURRENT status makes possible — never a button whose
 * action would immediately answer "cannot do that from status X".
 *
 * Built with `encodeAction`, never with the wire strings written out: that is
 * what actually enforces "a button here cannot exist without a case in
 * `runButtonAction`". Spelling `t:done:` by hand compiles fine and then fails
 * at PRESS time as "Unknown button" if a `WIRE` entry is ever renamed —
 * `notifications.ts` has always used the codec for exactly this reason.
 */
function taskActionKeyboard(t: Task) {
  const b: { text: string; callback_data: string }[] = [];
  const add = (text: string, kind: ButtonAction['kind']) =>
    b.push({ text, callback_data: encodeAction({ kind, id: t.id } as ButtonAction) });
  if (t.status === 'review') {
    add('✅ Done', 'task.done');
    add('🚀 Publish', 'task.publish');
    add('💬 Proceed', 'task.proceed');
  }
  if (t.status === 'blocked') add('⛔ Unblock', 'task.unblock');
  if (['draft', 'failed', 'cancelled', 'review'].includes(t.status)) {
    add('⏳ Queue', 'task.enqueue');
    add('▶ Run now', 'task.run');
  }
  if (t.status === 'queued' || t.status === 'running') add('🚫 Cancel', 'task.cancel');
  if (t.customQueueAt) add('➖ Leave queue', 'task.queueRemove');
  else if (['draft', 'failed', 'cancelled', 'review', 'queued'].includes(t.status)) {
    add('➕ Custom queue', 'task.queueAdd');
  }
  if (b.length === 0) return undefined;
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < b.length; i += 2) rows.push(b.slice(i, i + 2));
  return { inline_keyboard: rows };
}

function proposalLine(p: Proposal): string {
  const n = p.payload.options?.length ?? 0;
  const opts = n ? ` · ${n} options` : '';
  return (
    `💡 <code>${short(p.id)}</code> <b>${escapeHtml(p.payload.title ?? p.kind)}</b> (${escapeHtml(p.kind)}${opts})\n` +
    `  ${escapeHtml(p.payload.rationale.slice(0, 200))}`
  );
}

function featureLine(f: Feature, repoName?: string): string {
  const phases = f.analysis?.phases.length ?? 0;
  const tasks = f.analysis?.phases.reduce((n, ph) => n + ph.tasks.filter((c) => !c.excluded).length, 0) ?? 0;
  const plan = phases ? ` · ${phases} phase(s), ${tasks} task(s)` : '';
  return (
    `${FEATURE_ICON[f.status] ?? '•'} <code>${short(f.id)}</code> <b>${escapeHtml(f.title)}</b>` +
    `${repoName ? ` · <i>${escapeHtml(repoName)}</i>` : ''}\n  ${escapeHtml(f.status)}${plan}` +
    (f.error ? `\n  ⚠ ${escapeHtml(f.error)}` : '')
  );
}

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
 * one is free text, which goes to the conversational layer instead.
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
