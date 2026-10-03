import {
  SHARED_FILING_STALLED,
  TERMINAL_TASK_STATUSES,
  customQueueHoldsRepo,
  customQueueWaiting,
  type Feature,
  type Proposal,
  type Task,
  type TaskStatus,
} from '@tm/shared';
import { NOTIFY_CLASSES, type TelegramDigestConfig, type TelegramNotifyConfig } from '../config.ts';
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
  releaseTask,
  retryTask,
  reviewTask,
  runNowTask,
  setQueueEnabled,
  unblockTask,
  undoTask,
  type ActionOutcome,
  type ButtonAction,
} from './actions.ts';
import { escapeHtml, type Reply, type ReplyLike } from './api.ts';
import {
  BoardMemory,
  INBOX,
  STATUS_ICON,
  STATUS_VIEW,
  TASK_STATUSES,
  bottomKeyboard,
  clip,
  renderBoard,
  renderCard,
  type ActivitySource,
  type BoardDeps,
  type BoardState,
} from './board.ts';
import { listQuestionsReplies, type QuestionDeps } from './questions.ts';
import type { DigestControl } from './digest.ts';
import { buildReport, resolveReportScope } from './report.ts';
import {
  ConfirmStore,
  RateLimiter,
  WINDOW_NOTE,
  CONFIRM_LABEL,
  confirmKeyboard,
  renderKillAllSurvey,
  renderRestartCheck,
  surveyKillAll,
  type BotHooks,
} from './emergency.ts';
import { listNotes } from '../spaces/service.ts';
import { chatCommand, chatsCommand, endChatCommand, modeCommand, type ChatDeps } from './chat.ts';
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
  /** the LIVE digest config — /digest mutates it in place (§ Reports) */
  digest: TelegramDigestConfig;
  /** the running scheduler, so /digest can re-arm and say truthfully when the
   *  next one lands. Null in a context with no scheduler (a harness); the
   *  reply then falls back to comparing the clock to the hour. */
  digestControl: DigestControl | null;
  /** write cfg.digest back to data/config.json; the error text on failure */
  persistDigest(): string | null;
  /** the single conversational flow (docs/telegram.md § Conversations) */
  flows: FlowStore;
  /** the ONE open confirm window for a destructive command (§ Emergency) */
  confirms: ConfirmStore;
  /** the fence in front of /killall and /restart */
  limiter: RateLimiter;
  /** what index.ts wired in: the restart guard and the front door's port.
   *  Null in a context that has no server around it (a harness) — /restart
   *  then says so rather than pretending. */
  hooks: BotHooks | null;
  /** the chat surface (docs/chat.md). Null in a context built without one —
   *  /chat then says so rather than throwing. */
  chatDeps: ChatDeps | null;
  /** the question surface (docs/questions.md). Null in a context built
   *  without one — /questions then says so rather than throwing. */
  questions: QuestionDeps | null;
  /** what the audit trail records — always 'telegram' in production */
  actor: string;
  /** everything after the command word, trimmed; '' when there was none */
  args: string;
  message: TelegramMessage;
  /** the board's live inputs (docs/telegram.md § The board): the activity
   *  watcher's snapshot and the remembered search. Absent in a hand-built
   *  context — the board then renders without narration. */
  board?: { activity: ActivitySource | null; memory: BoardMemory };
}

export interface BotCommand extends BotCommandSpec {
  handler(ctx: CommandContext): Promise<ReplyLike>;
}

// ---- rendering ----------------------------------------------------------

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

/** A context built without a board (a harness) still renders one — just with no narration or memory. */
const boardDeps = (ctx: CommandContext): BoardDeps => {
  ctx.board ??= { activity: null, memory: new BoardMemory() };
  return { storage: ctx.storage, orchestrator: ctx.orchestrator, ...ctx.board };
};

export const COMMANDS: BotCommand[] = [
  {
    command: 'start',
    description: 'What this bot is',
    async handler() {
      const html = [
        `<b>Task Manager</b> — the phone side of the board running on the Mac.`,
        ``,
        `This bot talks to the server in-process: it reads and steers the queue,`,
        `and /chat holds a conversation with claude inside one of your repos.`,
        `It still does not expose the agents' terminals — those stay on the Mac.`,
        ``,
        `Send /status for the current state, /tasks for the board, /help for the commands.`,
        `The buttons under the text box are shortcuts to the same commands.`,
      ].join('\n');
      // The persistent bottom keyboard rides /start: Telegram keeps it until
      // it is replaced, so one delivery is enough.
      return { html, replyKeyboard: bottomKeyboard() };
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
    command: 'questions',
    description: 'What the agents are waiting on you to decide',
    async handler(ctx) {
      if (!ctx.questions) return 'Questions are unavailable on this bot.';
      const replies = await listQuestionsReplies(ctx.questions);
      // One keyboard per message: the first goes back as the reply, the rest
      // are sent by the caller through `extra`.
      const [first, ...rest] = replies;
      return { ...first, extra: rest };
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
    // docs/shared-spaces.md — read-only; the ledger is managed on the Shared page
    command: 'shared',
    description: 'Open cross-repo requests in shared spaces',
    async handler(ctx) {
      const [spaces, repos] = await Promise.all([ctx.storage.listSpaces(), ctx.storage.listRepos()]);
      if (spaces.length === 0) return 'No shared space yet — set one up on the dashboard\'s Shared page.';
      const name = (id: string | null) => (id ? repos.find((r) => r.id === id)?.name ?? short(id) : 'you');
      const out: string[] = [];
      for (const s of spaces) {
        const open = await listNotes({ storage: ctx.storage }, { spaceId: s.id, kind: 'request', status: ['open', 'filed'], oldestFirst: true });
        const shown = open.slice(0, 20);
        // A filing whose task is a draft or failed waits on you (SHARED_FILING_STALLED).
        const taskStatus = new Map<string, TaskStatus>();
        for (const n of shown) {
          if (n.status !== 'filed' || !n.taskId) continue;
          const t = await ctx.storage.getTask(n.taskId);
          if (t) taskStatus.set(n.id, t.status);
        }
        const rows = shown.map((n) => {
          const ts = taskStatus.get(n.id);
          const stalled = ts !== undefined && SHARED_FILING_STALLED.includes(ts);
          return (
            `${stalled ? '⚠️' : n.status === 'filed' ? '📋' : '•'} <code>${short(n.id)}</code> ${escapeHtml(n.title)}\n` +
            `  <i>${escapeHtml(name(n.fromRepoId))} → ${escapeHtml(name(n.toRepoId))}${n.taskId ? ` · task ${short(n.taskId)}${ts ? ` (${ts})` : ''}` : ''}</i>` +
            (stalled ? `\n  <b>needs you:</b> ${ts === 'draft' ? 'enqueue' : 'retry or cancel'} its task` : '')
          );
        });
        if (open.length > rows.length) rows.push(`…and ${open.length - rows.length} more on the Shared page.`);
        out.push(`<b>${escapeHtml(s.name)}</b> — ${open.length} open`, `<i>${escapeHtml(s.path)}</i>`, listOf(rows, 'Nothing open.'), '');
      }
      return out.join('\n').trim();
    },
  },
  {
    command: 'tasks',
    description: 'The task board — /tasks [inbox|open|status|repo|text]',
    async handler(ctx) {
      const raw = ctx.args.trim();
      const arg = raw.toLowerCase();
      const board = boardDeps(ctx);
      let state: BoardState;
      if (!arg || arg === 'inbox') state = INBOX;
      else if (arg === 'open') state = { view: 'op', repo: null, page: 0 };
      else if ((TASK_STATUSES as string[]).includes(arg)) {
        state = { view: STATUS_VIEW[arg as TaskStatus], repo: null, page: 0 };
      } else {
        const repo = await resolveRepo(ctx.storage, raw);
        if (repo.ok) state = { view: 'op', repo: short(repo.value.id), page: 0 };
        else {
          // Neither a status nor a repo: a title search. Remembered in memory
          // (one user, one search) because the text cannot ride a 64-byte
          // button — the pages and chips of a search re-read it from here.
          board.memory.search = clip(raw, 100);
          state = { view: 's', repo: null, page: 0 };
        }
      }
      return renderBoard(board, state);
    },
  },
  {
    command: 'now',
    description: 'What the agents are doing right now',
    async handler(ctx) {
      return renderBoard(boardDeps(ctx), { view: 'ru', repo: null, page: 0 });
    },
  },
  {
    command: 'task',
    description: 'One task in full — /task <id>',
    async handler(ctx) {
      if (!ctx.args) return 'Usage: <code>/task &lt;id&gt;</code>';
      const found = await resolveTask(ctx.storage, ctx.args.split(/\s+/)[0]);
      if (!found.ok) return escapeHtml(found.error);
      return renderCard(boardDeps(ctx), found.value, INBOX);
    },
  },
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
  taskCommand('undo', 'Stop a running task and put it back where it was — /undo <id>', (ctx, t) =>
    undoTask(deps(ctx), t.id, ctx.actor),
  ),
  taskCommand('release', 'Let the queue take a task Undo held — /release <id>', (ctx, t) =>
    releaseTask(deps(ctx), t.id, ctx.actor),
  ),
  taskCommand('retry', 'Retry a failed task — /retry <id>', (ctx, t) => retryTask(deps(ctx), t.id, ctx.actor)),
  taskCommand('unblock', 'Unblock a task — /unblock <id>', (ctx, t) => unblockTask(deps(ctx), t.id, ctx.actor)),
  taskCommand('review', 'Run the adversarial reviewer now — /review <id>', (ctx, t) =>
    reviewTask(deps(ctx), t.id, ctx.actor),
  ),
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
    command: 'chat',
    description: 'Chat with claude in a repo (docs/chat.md)',
    async handler(ctx) {
      if (!ctx.chatDeps) return { html: 'Chat is unavailable on this server.', ok: false };
      return chatCommand(ctx.chatDeps, ctx.args, ctx.actor);
    },
  },
  {
    command: 'chats',
    description: 'List the chats',
    async handler(ctx) {
      if (!ctx.chatDeps) return { html: 'Chat is unavailable on this server.', ok: false };
      return chatsCommand(ctx.chatDeps);
    },
  },
  {
    command: 'endchat',
    description: 'Leave chat mode',
    async handler(ctx) {
      if (!ctx.chatDeps) return { html: 'Chat is unavailable on this server.', ok: false };
      return endChatCommand(ctx.chatDeps);
    },
  },
  {
    command: 'mode',
    description: 'This chat: read-only or write',
    async handler(ctx) {
      if (!ctx.chatDeps) return { html: 'Chat is unavailable on this server.', ok: false };
      return modeCommand(ctx.chatDeps, ctx.args, ctx.actor);
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
        // shown for a member that is still WAITING (a held one says so),
        // while a member that is running, blocked or in an open auto-review
        // keeps its mark because it still holds its repo's place — it has no
        // position left to report. A member whose review settled is listed
        // nowhere: it is the human's now, and the queue has moved on.
        const waiting = customQueueWaiting(all);
        const inFlight = all
          .filter((t) => t.customQueueAt && customQueueHoldsRepo(t))
          .sort((a, b) => (a.customQueueAt ?? '').localeCompare(b.customQueueAt ?? ''));
        const out = [`<b>Custom queue</b> — serial, one task at a time, independent of /on /off`, ``];
        out.push(listOf(waiting.map((t, i) => `<b>#${i + 1}</b> ${t.queueHeldAt ? '⏸ held · ' : ''}${taskLine(t, name(t.repoId))}`), 'Nothing waiting.'));
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
    command: 'killall',
    description: '🛑 Stop everything — kill runs, cancel the queue, pause features',
    async handler(ctx) {
      // Rate-limited BEFORE the window is armed: refusing at the press would
      // mean the owner read a list of what was about to die, tapped Confirm,
      // and got a cooldown notice instead — the worst moment to be told no.
      const allowed = ctx.limiter.check('/killall');
      if (!allowed.ok) return { html: `⏳ ${escapeHtml(allowed.error)}`, ok: false };
      const open = ctx.confirms.peek();
      if (open) {
        return {
          html:
            `⏳ A <b>${escapeHtml(CONFIRM_LABEL[open.kind])}</b> confirm is already open ` +
            `(${Math.max(0, Math.ceil((open.expiresAt - Date.now()) / 1000))}s left). ` +
            `Answer it, or wait for it to expire.`,
          ok: false,
        };
      }
      const survey = await surveyKillAll(deps(ctx));
      if (survey.quiet) {
        // Nothing to kill is an answer, not a confirm. Arming a window here
        // would spend the one slot on a no-op and start the cooldown.
        return 'Nothing to stop — the queue is off, nothing is running, nothing is queued.';
      }
      const armed = ctx.confirms.arm('killall');
      if (!armed.ok) return { html: '⏳ A confirm window just opened elsewhere — try again.', ok: false };
      return {
        html: [renderKillAllSurvey(survey), '', WINDOW_NOTE].join('\n'),
        keyboard: confirmKeyboard(armed.confirm, '🛑 Confirm KILL ALL'),
      };
    },
  },
  {
    command: 'restart',
    description: 'Restart the server through the front door (honours the guard)',
    async handler(ctx) {
      if (!ctx.hooks) {
        return { html: '⚠ Restart is not available in this process (no front door wired).', ok: false };
      }
      const allowed = ctx.limiter.check('/restart');
      if (!allowed.ok) return { html: `⏳ ${escapeHtml(allowed.error)}`, ok: false };
      const open = ctx.confirms.peek();
      if (open) {
        return {
          html:
            `⏳ A <b>${escapeHtml(CONFIRM_LABEL[open.kind])}</b> confirm is already open ` +
            `(${Math.max(0, Math.ceil((open.expiresAt - Date.now()) / 1000))}s left). ` +
            `Answer it, or wait for it to expire.`,
          ok: false,
        };
      }
      // The SAME guard the route and the front door use — never a second copy
      // of "are agents working?" (docs/host.md).
      const check = await ctx.hooks.restartCheck();
      const armed = ctx.confirms.arm(check.blocked ? 'restart-force' : 'restart');
      if (!armed.ok) return { html: '⏳ A confirm window just opened elsewhere — try again.', ok: false };
      if (check.blocked) {
        return {
          html: [
            `⛔ <b>Restart refused</b> — ${escapeHtml(check.error ?? 'agents are working')}`,
            ``,
            renderRestartCheck(check),
            ``,
            `Forcing it kills every session mid-run; boot recovery sweeps them to <code>failed</code>.`,
            `<b>/killall</b> is the clean way to empty the machine first.`,
            ``,
            WINDOW_NOTE,
          ].join('\n'),
          keyboard: confirmKeyboard(armed.confirm, '⚠️ Restart ANYWAY (force)'),
          // The guard refused: the command performed nothing.
          ok: false,
        };
      }
      return {
        html: [
          `🔄 <b>Restart the server?</b>`,
          ``,
          `Nothing is working — the guard is clear.`,
          renderRestartCheck(check),
          ``,
          `The front door (port ${ctx.hooks.hostPort}) will stop this process and start it again.`,
          ``,
          WINDOW_NOTE,
        ].join('\n'),
        keyboard: confirmKeyboard(armed.confirm, '🔄 Confirm restart'),
      };
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
  {
    command: 'report',
    description: 'HTML report — /report 24h|7d|task <id>|feature <id>|group <id>',
    async handler(ctx) {
      const scope = await resolveReportScope(ctx.storage, ctx.args);
      if (!scope.ok) return { html: `⚠ ${escapeHtml(scope.error)}`, ok: false };
      const doc = await buildReport(ctx.storage, scope.value);
      // The summary is the message; the file is the detail. If the summary is
      // too long to be a caption, api.ts sends it as its own message rather
      // than truncating it — the gist must survive either way.
      return { html: doc.summary, document: doc };
    },
  },
  {
    command: 'digest',
    description: 'Daily 24h report — /digest on|off [hour]',
    async handler(ctx) {
      const [verb, hourArg] = ctx.args.toLowerCase().split(/\s+/).filter(Boolean);
      if (!verb) return renderDigest(ctx.digest, ctx.digestControl);
      if (verb !== 'on' && verb !== 'off') {
        return {
          html: `Usage: <code>/digest on|off [hour]</code>\n\n${renderDigest(ctx.digest, ctx.digestControl)}`,
          ok: false,
        };
      }
      if (hourArg !== undefined) {
        const hour = Number(hourArg);
        if (!/^\d{1,2}$/.test(hourArg) || !Number.isInteger(hour) || hour < 0 || hour > 23) {
          return { html: `⚠ hour must be an integer in 0..23 (local time), got <code>${escapeHtml(hourArg)}</code>`, ok: false };
        }
        ctx.digest.hour = hour;
      }
      ctx.digest.enabled = verb === 'on';
      // Re-arm BEFORE rendering: the reply's "today"/"tomorrow" is read back
      // out of the scheduler, so the scheduler has to have seen the change.
      await ctx.digestControl?.rearm();
      return `${renderDigest(ctx.digest, ctx.digestControl)}${persistDigestSuffix(ctx)}`;
    },
  },
];

/** The digest's own state line — shared by `/digest` with and without args. */
function renderDigest(d: TelegramDigestConfig, control: DigestControl | null, now = new Date()): string {
  const at = `${String(d.hour).padStart(2, '0')}:00 local`;
  // Say WHICH day the next one is, not just the hour: "lands at 23:00" typed
  // at 07:00 and "lands at 09:00" typed at 22:00 are the same sentence and
  // fifteen hours apart. The answer comes from the SCHEDULER, which knows
  // whether today already went out and whether it was armed in time — the
  // clock alone cannot tell, and a promise of "today" that then does not
  // happen is worse than no promise.
  const when = control ? control.nextRun(now) : now.getHours() < d.hour ? 'today' : 'tomorrow';
  return d.enabled
    ? `Daily digest: <b>on</b> — the 24h report lands at <b>${at}</b>, next one <b>${when}</b>.\nTurn it off with <code>/digest off</code>.`
    : `Daily digest: <b>off</b>.\nTurn it on with <code>/digest on</code>, or <code>/digest on 9</code> to pick the hour (currently ${at}).`;
}

function persistDigestSuffix(ctx: CommandContext): string {
  const err = ctx.persistDigest();
  return err ? `\n⚠ Applied for this run, but not saved to config.json: ${escapeHtml(err)}` : '';
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
