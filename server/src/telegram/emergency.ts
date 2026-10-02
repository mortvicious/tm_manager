import crypto from 'node:crypto';
import http from 'node:http';
import { onHeadlessRunExit } from '../claude/analyze.ts';
import { liveHeadless, stopAllHeadless } from '../claude/headless.ts';
import { broadcast, onEvent } from '../events.ts';
import { cancelTask as svcCancelTask } from '../task-actions.ts';
import type { ActionDeps } from './actions.ts';
import { escapeHtml } from './api.ts';
import { short } from './ids.ts';
import type { InlineKeyboardMarkup } from './types.ts';

// The red button (docs/telegram.md § Emergency controls): /killall, /restart,
// their two-step confirm, the rate limit that fences them, and the follow-up
// that waits for the processes to be ACTUALLY gone rather than merely signalled.
//
// The whole point of this module is that a destructive move on a phone is one
// mis-tap away from a scroll gesture, so nothing here fires on a single press:
// a command ARMS a nonce-carrying window and only the button belonging to that
// window executes. Consuming the nonce is what makes a replayed or duplicated
// update harmless — see § A stale or duplicated update in the docs.

/** How long an armed confirm stays pressable. The spec's number. */
export const CONFIRM_WINDOW_MS = 60_000;
/** How long the follow-up waits for the killed processes to actually exit. */
export const KILL_WATCH_MS = 60_000;
/** Minimum gap between two EXECUTIONS of the same destructive command. */
export const DESTRUCTIVE_COOLDOWN_MS = 60_000;
/** …and a ceiling across all of them, so a stuck finger cannot loop. */
export const DESTRUCTIVE_BURST = 5;
export const DESTRUCTIVE_WINDOW_MS = 10 * 60_000;

/** What a confirm window is FOR. The wire form never carries this — the store
 *  does — so a Confirm button cannot be re-pointed at a different action. */
export type ConfirmKind = 'killall' | 'restart' | 'restart-force';

export interface Confirm {
  kind: ConfirmKind;
  /** the only thing on the wire; consumed by the press that spends it */
  nonce: string;
  openedAt: number;
  expiresAt: number;
}

export const CONFIRM_LABEL: Record<ConfirmKind, string> = {
  killall: '/killall',
  restart: '/restart',
  'restart-force': '/restart (force)',
};

/**
 * At most ONE window, ever. Not a map keyed by nonce: "rate-limited to one
 * confirm window at a time" is the spec's wording and a single slot is the
 * only shape that cannot drift from it. Expiry is checked lazily on read, the
 * same rule FlowStore uses — a timer that fires into a dead process would be
 * a second source of truth about whether the window is still open.
 *
 * Deliberately NOT the flow store: a command drops the live flow, and a
 * `/killall` whose confirm evaporated because the owner typed `/status` while
 * reading the list would be a red button that quietly stops working.
 */
export class ConfirmStore {
  private open: Confirm | null = null;

  /** The live window, or null. Expires it in passing. */
  peek(now = Date.now()): Confirm | null {
    if (this.open && this.open.expiresAt <= now) this.open = null;
    return this.open;
  }

  /** Arm a window. Refused — with the blocker — while one is already open. */
  arm(kind: ConfirmKind, now = Date.now()): { ok: true; confirm: Confirm } | { ok: false; busy: Confirm } {
    const live = this.peek(now);
    if (live) return { ok: false, busy: live };
    const confirm: Confirm = {
      kind,
      nonce: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
      openedAt: now,
      expiresAt: now + CONFIRM_WINDOW_MS,
    };
    this.open = confirm;
    return { ok: true, confirm };
  }

  /**
   * Spend the window. CONSUMING, and that is the load-bearing property: the
   * second delivery of a duplicated update, or a double-tap that Telegram
   * turns into two callback_query updates, finds nothing and is refused.
   */
  take(nonce: string, now = Date.now()): Confirm | null {
    const live = this.peek(now);
    if (!live || live.nonce !== nonce) return null;
    this.open = null;
    return live;
  }

  clear(): void {
    this.open = null;
  }
}

// ---- the confirm button codec ------------------------------------------
//
// Its own `k:` namespace, disjoint from the action codec (`t:`/`p:`/`f:`/`r:`,
// whose parse is a lookup in a wire map that has no `k:go`) and from the
// wizard's `w:`. Parsed BEFORE the action codec in bot.ts for the same reason
// the wizard is: these buttons expire, and an expired one must be REFUSED
// rather than fall through to something that still means what it says.

const CONFIRM_RE = /^k:(go|no):([\w-]{1,48})$/;

export interface ConfirmButton {
  verb: 'go' | 'no';
  nonce: string;
}

export function encodeConfirm(verb: 'go' | 'no', nonce: string): string {
  return `k:${verb}:${nonce}`;
}

export function parseConfirmData(data: string): ConfirmButton | null {
  const m = CONFIRM_RE.exec(data);
  return m ? { verb: m[1] as 'go' | 'no', nonce: m[2] } : null;
}

/** Confirm / Cancel, the only two buttons an armed window ever renders. */
export function confirmKeyboard(confirm: Confirm, goLabel: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: goLabel, callback_data: encodeConfirm('go', confirm.nonce) },
        { text: '✕ Cancel', callback_data: encodeConfirm('no', confirm.nonce) },
      ],
    ],
  };
}

export const WINDOW_NOTE = `<i>Expires in ${Math.round(
  CONFIRM_WINDOW_MS / 1000,
)}s. One confirm window at a time.</i>`;

// ---- the rate limit -----------------------------------------------------

/**
 * Two fences, because they catch different mistakes. The per-command cooldown
 * catches "did that work? let me do it again" — the human retry, which on a
 * red button is exactly the press that kills the session the first one spawned
 * in its place. The burst cap catches everything else, including a client that
 * keeps redelivering.
 *
 * In memory, like the confirm window: a restart is not a rate limit the owner
 * is trying to evade, and persisting it would mean the first `/killall` after
 * a crash is the one that gets refused.
 */
export class RateLimiter {
  private readonly lastRun = new Map<string, number>();
  private recent: number[] = [];

  check(command: string, now = Date.now()): { ok: true } | { ok: false; error: string } {
    const last = this.lastRun.get(command);
    if (last !== undefined && now - last < DESTRUCTIVE_COOLDOWN_MS) {
      const wait = Math.ceil((DESTRUCTIVE_COOLDOWN_MS - (now - last)) / 1000);
      return { ok: false, error: `${command} ran ${Math.round((now - last) / 1000)}s ago — wait ${wait}s.` };
    }
    const live = this.recent.filter((t) => now - t < DESTRUCTIVE_WINDOW_MS);
    if (live.length >= DESTRUCTIVE_BURST) {
      const wait = Math.ceil((DESTRUCTIVE_WINDOW_MS - (now - live[0])) / 1000);
      return {
        ok: false,
        error: `${DESTRUCTIVE_BURST} destructive commands in the last ${Math.round(
          DESTRUCTIVE_WINDOW_MS / 60_000,
        )} minutes — wait ${wait}s.`,
      };
    }
    return { ok: true };
  }

  /** Called when a command actually EXECUTES, not when it is armed: an armed
   *  window the owner cancelled destroyed nothing and must not cost a slot. */
  record(command: string, now = Date.now()): void {
    this.lastRun.set(command, now);
    this.recent = this.recent.filter((t) => now - t < DESTRUCTIVE_WINDOW_MS);
    this.recent.push(now);
  }
}

// ---- what /killall is about to do ---------------------------------------

export interface KillTarget {
  runId: string;
  mode: string;
  taskId: string | null;
  title: string;
}

export interface KillAllSurvey {
  queueEnabled: boolean;
  runs: KillTarget[];
  queued: { id: string; title: string }[];
  features: { id: string; title: string }[];
  /** pending agent-to-agent messages — the one path the queue switch misses */
  dispatches: { id: string; toTaskId: string; toTitle: string }[];
  headless: string[];
  /** true when there is nothing to stop — do not burn a confirm window */
  quiet: boolean;
}

/** Read-only: exactly what the confirm message lists, gathered before anything
 *  is touched so the human confirms a description of the real state. */
export async function surveyKillAll(deps: ActionDeps): Promise<KillAllSurvey> {
  const status = await deps.orchestrator.status();
  const runRows = await deps.storage.listRuns({ status: 'running' });
  const runs: KillTarget[] = [];
  for (const r of runRows) {
    const t = r.taskId ? await deps.storage.getTask(r.taskId) : null;
    runs.push({ runId: r.id, mode: r.mode, taskId: r.taskId, title: t?.title ?? 'no task' });
  }
  const queued = (await deps.storage.listTasks({ status: 'queued' })).map((t) => ({ id: t.id, title: t.title }));
  const features = (await deps.storage.listFeatures({ status: 'running' })).map((f) => ({ id: f.id, title: f.title }));
  const dispatches: { id: string; toTaskId: string; toTitle: string }[] = [];
  for (const d of await deps.storage.listDispatches({ status: 'pending' })) {
    const t = await deps.storage.getTask(d.toTaskId);
    dispatches.push({ id: d.id, toTaskId: d.toTaskId, toTitle: t?.title ?? '(deleted task)' });
  }
  const headless = liveHeadless();
  return {
    queueEnabled: status.enabled,
    runs,
    queued,
    features,
    dispatches,
    headless,
    quiet:
      !status.enabled &&
      runs.length === 0 &&
      queued.length === 0 &&
      features.length === 0 &&
      dispatches.length === 0 &&
      headless.length === 0,
  };
}

export interface KillAllReport {
  queueWasEnabled: boolean;
  killed: KillTarget[];
  killFailed: { target: KillTarget; reason: string }[];
  cancelled: { id: string; title: string }[];
  cancelFailed: { id: string; title: string; reason: string }[];
  paused: { id: string; title: string }[];
  pauseFailed: { id: string; title: string }[];
  dispatchesCancelled: { id: string; toTaskId: string; toTitle: string }[];
  headlessStopped: string[];
  /** the re-sweep found work a cascade had created while we were killing */
  resweptSomething: boolean;
  /** what was ALREADY quiet, so the answer says so instead of staying silent */
  idle: string[];
}

/**
 * The red button itself. Ordered, and the order is the argument:
 *
 * 1. stop the queue, so nothing new is claimed while we work;
 * 2. pause running features FIRST — killing a task cascades through
 *    `resolveCompletion`, and a running feature answers that cascade by
 *    enqueuing its next phase, which would re-fill the queue behind us;
 * 3. cancel what is queued (both queues: a custom-queue member also sits in
 *    `queued`, and the custom queue runs even while the global switch is off);
 * 4. kill the live runs — ALL modes, not just `worker` like the web button:
 *    the phone's `/kill` listing already shows every mode and a red button
 *    that leaves an analysis burning tokens is a half-button;
 * 5. stop the headless `claude -p` children that own no run row at all
 *    (plan reviews, adversarial rounds) — the same call the restart path makes;
 * 6. sweep once more, because 4 and 5 both have exit handlers that write.
 *
 * Two passes, not a loop: a fixed bound cannot spin, and anything a SECOND
 * cascade creates is caught by the queue being stopped rather than by us.
 */
export async function executeKillAll(deps: ActionDeps, actor: string): Promise<KillAllReport> {
  // Re-surveyed HERE, not reused from the one the confirm message rendered: up
  // to 60 seconds pass between arming and pressing, and the report must
  // describe what actually happened rather than what was predicted.
  const before = await surveyKillAll(deps);
  const report: KillAllReport = {
    queueWasEnabled: before.queueEnabled,
    killed: [],
    killFailed: [],
    cancelled: [],
    cancelFailed: [],
    paused: [],
    pauseFailed: [],
    dispatchesCancelled: [],
    headlessStopped: [],
    resweptSomething: false,
    idle: [],
  };

  if (before.queueEnabled) await deps.orchestrator.setEnabled(false, actor);

  const sweep = async (): Promise<number> => {
    let acted = 0;

    // FIRST, and before anything is killed. Dispatch delivery is the one path
    // deliberately exempt from the `orchestrator.enabled` switch
    // (docs/dispatch.md): it runs on every scheduling pass including the
    // `!enabled` branch and the 10s safety tick, its hold list is
    // running/queued/blocked — so a `cancelled` target is NOT held — and
    // `followUp` accepts `cancelled`. Leaving a pending dispatch would
    // therefore have the machine we just emptied resume the very task we
    // killed, minutes later, with the "all sessions have exited" message
    // already sent. Stopping the queue does not stop this; deleting the cause
    // does.
    for (const d of await deps.storage.listDispatches({ status: 'pending' })) {
      const settled = await deps.storage.settleDispatch(d.id, 'cancelled', 'cancelled by /killall');
      if (!settled) continue; // it was delivered or failed between list and settle
      broadcast({ type: 'dispatch.updated', dispatch: settled });
      const t = await deps.storage.getTask(d.toTaskId);
      await deps.storage.appendEvent({
        kind: 'task.dispatch',
        actor,
        taskId: settled.toTaskId,
        data: { phase: 'cancelled', dispatchId: settled.id, fromTaskId: settled.fromTaskId, by: 'killall' },
      });
      report.dispatchesCancelled.push({ id: settled.id, toTaskId: settled.toTaskId, toTitle: t?.title ?? '(deleted task)' });
      acted++;
    }

    for (const f of await deps.storage.listFeatures({ status: 'running' })) {
      const paused = await deps.storage.transitionFeature(f.id, ['running'], 'paused', actor);
      if (paused) {
        broadcast({ type: 'feature.updated', feature: paused });
        report.paused.push({ id: f.id, title: f.title });
        acted++;
      } else {
        // It moved under us between the list and the transition; the claim gate
        // is what actually stops it, so this is reportable, not fatal.
        report.pauseFailed.push({ id: f.id, title: f.title });
      }
    }

    for (const t of await deps.storage.listTasks({ status: 'queued' })) {
      const r = await svcCancelTask(deps, t.id, actor);
      if ('error' in r) report.cancelFailed.push({ id: t.id, title: t.title, reason: r.error });
      else {
        report.cancelled.push({ id: t.id, title: t.title });
        acted++;
      }
    }

    for (const r of await deps.storage.listRuns({ status: 'running' })) {
      const t = r.taskId ? await deps.storage.getTask(r.taskId) : null;
      const target: KillTarget = { runId: r.id, mode: r.mode, taskId: r.taskId, title: t?.title ?? 'no task' };
      const killed = await deps.orchestrator.killRun(r.id, actor);
      if (killed) {
        report.killed.push(target);
        acted++;
      } else {
        report.killFailed.push({ target, reason: 'session already gone' });
      }
    }

    return acted;
  };

  await sweep();
  // After the run rows, so an `analyze` run is killed through `killRun` (which
  // updates its row and its task) rather than losing its child underneath it.
  const headlessBefore = liveHeadless();
  if (headlessBefore.length > 0) {
    stopAllHeadless();
    report.headlessStopped = headlessBefore;
  }
  report.resweptSomething = (await sweep()) > 0;

  if (!before.queueEnabled) report.idle.push('the queue was already stopped');
  if (before.runs.length === 0) report.idle.push('no live runs');
  if (before.queued.length === 0) report.idle.push('nothing was queued');
  if (before.features.length === 0) report.idle.push('no feature was running');
  if (before.dispatches.length === 0) report.idle.push('no dispatch was pending');
  if (before.headless.length === 0) report.idle.push('no headless agents');

  return report;
}

// ---- rendering ----------------------------------------------------------

const bullet = (s: string) => `• ${s}`;

/** The survey is a PREVIEW, so it is capped like every other listing in the
 *  bot — but it says the cap does not limit what gets killed, because a human
 *  confirming a truncated list must not think the tail is spared. */
const PREVIEW_LIMIT = 20;

function preview(lines: string[]): string {
  if (lines.length <= PREVIEW_LIMIT) return lines.join('\n');
  return (
    lines.slice(0, PREVIEW_LIMIT).join('\n') +
    `\n   <i>…and ${lines.length - PREVIEW_LIMIT} more — all of them</i>`
  );
}

export function renderKillAllSurvey(s: KillAllSurvey): string {
  const out = [`🛑 <b>/killall</b> — this will:`, ``];
  out.push(bullet(s.queueEnabled ? 'stop the queue' : 'stop the queue <i>(already stopped)</i>'));
  out.push(
    bullet(
      s.runs.length === 0
        ? 'kill live runs <i>(none)</i>'
        : `kill ${s.runs.length} live run(s):\n` +
            preview(s.runs.map((r) => `   <code>${short(r.runId)}</code> ${escapeHtml(r.mode)} — ${escapeHtml(r.title)}`)),
    ),
  );
  out.push(
    bullet(
      s.queued.length === 0
        ? 'cancel queued tasks <i>(none)</i>'
        : `cancel ${s.queued.length} queued task(s):\n` +
            preview(s.queued.map((t) => `   <code>${short(t.id)}</code> ${escapeHtml(t.title)}`)),
    ),
  );
  out.push(
    bullet(
      s.features.length === 0
        ? 'pause running features <i>(none)</i>'
        : `pause ${s.features.length} running feature(s):\n` +
            preview(s.features.map((f) => `   <code>${short(f.id)}</code> ${escapeHtml(f.title)}`)),
    ),
  );
  out.push(
    bullet(
      s.dispatches.length === 0
        ? 'cancel pending dispatches <i>(none)</i>'
        : `cancel ${s.dispatches.length} pending dispatch(es):\n` +
            preview(s.dispatches.map((d) => `   → <code>${short(d.toTaskId)}</code> ${escapeHtml(d.toTitle)}`)),
    ),
  );
  out.push(
    bullet(
      s.headless.length === 0
        ? 'stop headless agents <i>(none)</i>'
        : `stop ${s.headless.length} headless agent(s): ${escapeHtml(s.headless.join(', '))}`,
    ),
  );
  return out.join('\n');
}

/** Exactly what happened — run ids and titles, per the spec, plus what was
 *  already idle so a quiet answer is never mistaken for a failed one. */
export function renderKillAllReport(r: KillAllReport): string {
  const out: string[] = ['🛑 <b>/killall</b> done.', ''];
  if (r.queueWasEnabled) out.push(bullet('queue stopped'));
  if (r.killed.length > 0) {
    out.push(bullet(`killed ${r.killed.length} run(s):`));
    for (const k of r.killed) out.push(`   <code>${short(k.runId)}</code> ${escapeHtml(k.mode)} — ${escapeHtml(k.title)}`);
  }
  if (r.killFailed.length > 0) {
    out.push(bullet(`${r.killFailed.length} run(s) could not be killed:`));
    for (const f of r.killFailed) out.push(`   <code>${short(f.target.runId)}</code> — ${escapeHtml(f.reason)}`);
  }
  if (r.cancelled.length > 0) {
    out.push(bullet(`cancelled ${r.cancelled.length} queued task(s):`));
    for (const c of r.cancelled) out.push(`   <code>${short(c.id)}</code> ${escapeHtml(c.title)}`);
  }
  if (r.cancelFailed.length > 0) {
    out.push(bullet(`${r.cancelFailed.length} queued task(s) refused:`));
    for (const c of r.cancelFailed) out.push(`   <code>${short(c.id)}</code> — ${escapeHtml(c.reason)}`);
  }
  if (r.paused.length > 0) {
    out.push(bullet(`paused ${r.paused.length} feature(s):`));
    for (const f of r.paused) out.push(`   <code>${short(f.id)}</code> ${escapeHtml(f.title)}`);
  }
  if (r.pauseFailed.length > 0) {
    out.push(bullet(`${r.pauseFailed.length} feature(s) had already moved on`));
  }
  if (r.dispatchesCancelled.length > 0) {
    out.push(bullet(`cancelled ${r.dispatchesCancelled.length} pending dispatch(es):`));
    for (const d of r.dispatchesCancelled) {
      out.push(`   → <code>${short(d.toTaskId)}</code> ${escapeHtml(d.toTitle)}`);
    }
  }
  if (r.headlessStopped.length > 0) {
    out.push(bullet(`stopped ${r.headlessStopped.length} headless agent(s): ${escapeHtml(r.headlessStopped.join(', '))}`));
  }
  if (r.resweptSomething) {
    out.push(bullet('<i>a cascade re-queued work while this ran; the second pass caught it</i>'));
  }
  if (r.idle.length > 0) out.push(bullet(`already idle: ${escapeHtml(r.idle.join(', '))}`));
  return out.join('\n');
}

// ---- "the kills have actually completed" --------------------------------

/**
 * A kill is a SIGNAL. `killRun` returning true means the pty was told to go,
 * the run row says `killed` and the task says `cancelled` — none of which is
 * the process being gone. The proof is `run.exited`, broadcast from the
 * orchestrator's `handleExit` when node-pty reports the child dead, and this
 * watcher is the only thing in the bot that waits for it.
 *
 * Armed BEFORE the kills are issued, because a fast exit beats an `await`: the
 * watcher collects every exit it sees from the moment it is armed and
 * `expect()` subtracts the ones that already landed.
 */
export class KillWatcher {
  private unsubscribe: (() => void) | null = null;
  private unsubscribeHeadless: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly seen = new Set<string>();
  private pending = new Map<string, KillTarget>();
  private armed = false;
  /** how many kills this follow-up is about, for the "n/m exited" line */
  private total = 0;

  constructor(private readonly send: (html: string) => Promise<void>) {}

  /** Start listening. A second arm settles the follow-up already in flight
   *  rather than dropping it: the rate limit makes an overlap unlikely, not
   *  impossible, and a silently abandoned watch is a message the owner was
   *  promised and never gets. */
  arm(): void {
    if (this.armed && this.pending.size > 0) void this.finish(false);
    this.disarm();
    this.seen.clear();
    this.pending.clear();
    this.armed = true;
    this.unsubscribe = onEvent((e) => {
      if (e.type !== 'run.exited') return;
      this.sawExit(e.run.id);
    });
    // A headless `analyze` run has no PTY, so it never reaches the bus — and
    // `/killall` kills every mode, so waiting only on `run.exited` would report
    // every killed analysis as a 60-second straggler that had in fact died
    // immediately. This is the same process-exit fact, from the one place that
    // knows it (claude/analyze.ts).
    this.unsubscribeHeadless = onHeadlessRunExit((runId) => this.sawExit(runId));
  }

  /** Both signals mean the same thing: that run's process is gone. */
  private sawExit(runId: string): void {
    this.seen.add(runId);
    // `run.exited` has two emitters (the PTY exit and the Stop-hook idle path
    // in routes/internal.ts), so the same id can arrive twice — `delete`
    // returning false is what keeps the second one from re-announcing.
    if (this.pending.delete(runId) && this.pending.size === 0) void this.finish(true);
  }

  /** Name the runs whose exits this follow-up is about. */
  expect(targets: KillTarget[], timeoutMs = KILL_WATCH_MS): void {
    if (!this.armed) return;
    if (targets.length === 0) {
      // Nothing was killed — the report already said so; a follow-up would be
      // a second message saying nothing.
      this.disarm();
      return;
    }
    this.total = targets.length;
    this.pending = new Map(targets.filter((t) => !this.seen.has(t.runId)).map((t) => [t.runId, t]));
    if (this.pending.size === 0) {
      // Every one of them exited between the arm and here — the fast path the
      // `seen` set exists for.
      void this.finish(true);
      return;
    }
    this.timer = setTimeout(() => void this.finish(false), timeoutMs);
    // Never hold the process open for a follow-up message.
    this.timer.unref?.();
  }

  private async finish(complete: boolean): Promise<void> {
    if (!this.armed) return;
    const total = this.total;
    const stragglers = [...this.pending.values()];
    this.disarm();
    const html = complete
      ? `☠️ All ${total} killed session(s) have exited.`
      : [
          `⚠️ ${total - stragglers.length}/${total} killed session(s) have exited.`,
          `Still no exit after ${Math.round(KILL_WATCH_MS / 1000)}s:`,
          ...stragglers.map((t) => `   <code>${short(t.runId)}</code> ${escapeHtml(t.mode)} — ${escapeHtml(t.title)}`),
          `<i>Their rows already read <code>killed</code>; check /kill or the terminal.</i>`,
        ].join('\n');
    await this.send(html).catch(() => {});
  }

  /** Called by the bot's shutdown; also the end of every follow-up. */
  disarm(): void {
    this.armed = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeHeadless?.();
    this.unsubscribeHeadless = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  stop(): void {
    this.disarm();
    this.seen.clear();
  }
}

// ---- /restart -----------------------------------------------------------

/** GET /api/server/restart-check's body. `error` is the guard's REASON. */
export interface RestartCheck {
  blocked: boolean;
  error: string | null;
  running: number;
  headless: number;
  services: number;
  /** open shell terminals (docs/terminals.md) — like services, killed but never blocking */
  shells?: number;
}

/**
 * What index.ts hands the bot so `/restart` can honour the guard without a
 * second copy of it. `restartCheck` is the SAME closure the route calls — the
 * bot must not restate "are agents working?", which is the rule host.ts
 * already follows by forwarding the route verbatim.
 */
export interface BotHooks {
  restartCheck(): Promise<RestartCheck>;
  /** the front door's port (config `host.port`) — the process to ask */
  hostPort: number;
  /** TM_SUPERVISED=1: a front door really is watching this pid */
  supervised: boolean;
}

export type RestartResult =
  | { ok: true; detail: string }
  | { ok: false; blocked: boolean; error: string };

/**
 * POST /host/restart on the FRONT DOOR — a different process, so this is not
 * the forbidden self-call: there is no in-process function that can restart a
 * process from inside itself and still be supervised.
 *
 * Two header rules, both copied from what host.ts does in the other direction:
 * `Host` must be the loopback origin of the port being called (the front
 * door's DNS-rebinding guard), and `Origin` must be ABSENT — the guard only
 * judges an Origin that is present, and inventing one would put this call
 * under a rule written for browsers.
 */
export function requestHostRestart(hostPort: number, force: boolean, timeoutMs = 8000): Promise<RestartResult> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ force });
    let settled = false;
    const done = (r: RestartResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const req = http.request(
      {
        host: '127.0.0.1',
        port: hostPort,
        path: '/host/restart',
        method: 'POST',
        headers: {
          host: `127.0.0.1:${hostPort}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let parsed: any = null;
          try {
            parsed = JSON.parse(body);
          } catch {
            /* a non-JSON body is reported as the status alone */
          }
          if (res.statusCode === 200) return done({ ok: true, detail: 'the front door restarted the API.' });
          if (res.statusCode === 409) {
            return done({ ok: false, blocked: true, error: String(parsed?.error ?? 'the restart guard refused') });
          }
          done({
            ok: false,
            blocked: false,
            error: String(parsed?.error ?? `the front door answered ${res.statusCode ?? '(no status)'}`),
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', (e) => {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ECONNREFUSED') {
        return done({
          ok: false,
          blocked: false,
          error:
            'the front door is not listening — this API was started on its own (npm run start:api). ' +
            'Restart it from the terminal, or run it under the front door (npm start).',
        });
      }
      // Anything else happened AFTER the request went out, and the ordinary
      // cause is the front door killing this very process mid-response. That
      // is the SUCCESS path: the answer we would have read died with us.
      done({ ok: true, detail: 'the front door took this process down; the boot message will confirm it came back.' });
    });
    req.end(payload);
  });
}

export function renderRestartCheck(check: RestartCheck): string {
  const lines = [`running agent sessions: <b>${check.running}</b>`, `headless agents: <b>${check.headless}</b>`];
  // Dev servers do not block a restart, but they DO die with it — the phone is
  // the one surface where that is invisible unless it is said.
  if (check.services > 0) lines.push(`repo commands that will be stopped: <b>${check.services}</b>`);
  if ((check.shells ?? 0) > 0) lines.push(`shell terminals that will be closed: <b>${check.shells}</b>`);
  return lines.map(bullet).join('\n');
}
