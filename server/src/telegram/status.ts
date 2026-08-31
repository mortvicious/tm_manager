import { usageSnapshot } from '../claude/usage.ts';
import type { UsageWindow } from '@tm/shared';
import type { Orchestrator } from '../orchestrator.ts';
import type { Storage } from '../storage/types.ts';
import { escapeHtml } from './api.ts';

// /status — the one screen that answers "what is the machine doing right now"
// without opening the laptop. Every number here comes from the SAME in-process
// service the web UI reads (`Orchestrator.status()`, `usageSnapshot()`,
// `storage.listTasks`), never from an HTTP call back into this server: a self
// call would have to pass the Host/Origin allowlists, and two paths to one
// number is how the phone and the browser start disagreeing.

/** Counters the bot keeps in memory — traffic it refused, not work it did. */
export interface GateCounters {
  /** updates dropped at boot for predating it (docs/telegram.md) */
  discardedAtBoot: number;
  /** the same rule applied AFTER the boot message already reported a count —
   *  a backlog the drain did not reach, arriving through the poll loop */
  discardedLate: number;
  /** updates from a user or chat that is not the allowlisted owner */
  rejected: number;
  /** distinct foreign user ids seen since boot */
  rejectedUsers: number;
  /** true once the distinct-id table is full: `rejectedUsers` is now a floor */
  rejectedUsersCapped: boolean;
}

export interface BotStatusData {
  enabled: boolean;
  running: number;
  concurrency: number;
  headless: number;
  queued: number;
  customQueued: number;
  review: number;
  needsAttentionRuns: number;
  usage: { fiveHour: UsageWindow; week: UsageWindow; weekFable: UsageWindow };
  counters: GateCounters;
  bootedAt: string;
}

export async function collectStatus(
  storage: Storage,
  orchestrator: Orchestrator,
  counters: GateCounters,
  bootedAt: string,
): Promise<BotStatusData> {
  const [orch, usage, queuedTasks, reviewTasks, runs] = await Promise.all([
    orchestrator.status(),
    usageSnapshot(storage),
    storage.listTasks({ status: 'queued' }),
    storage.listTasks({ status: 'review' }),
    storage.listRuns({ status: 'running' }),
  ]);
  return {
    enabled: orch.enabled,
    running: orch.running,
    concurrency: orch.concurrency,
    headless: orch.headless,
    // Same split the Queue page makes: a task carrying the custom-queue mark
    // is waiting in the serial queue, not in the global one (docs/queue.md).
    queued: queuedTasks.filter((t) => !t.customQueueAt).length,
    customQueued: queuedTasks.filter((t) => t.customQueueAt).length,
    review: reviewTasks.length,
    needsAttentionRuns: runs.filter((r) => r.needsAttention).length,
    usage: { fiveHour: usage.fiveHour, week: usage.week, weekFable: usage.weekFable },
    counters,
    bootedAt,
  };
}

/** "12.3% · resets 18:40" — resetsAt only exists on the account source. */
function renderWindow(label: string, w: UsageWindow): string {
  const pct = `${w.pct.toFixed(1)}%`;
  const suffix = w.resetsAt ? ` · resets ${formatClock(w.resetsAt)}` : w.source === 'estimate' ? ' (est.)' : '';
  return `${escapeHtml(label)} ${pct}${escapeHtml(suffix)}`;
}

/** Local wall clock, because the human reading it is in that timezone. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

export function renderStatus(s: BotStatusData): string {
  const lines = [
    `<b>Task Manager</b>`,
    ``,
    `Queue: <b>${s.enabled ? 'running' : 'stopped'}</b> · agents ${s.running}/${s.concurrency}` +
      (s.headless > 0 ? ` · ${s.headless} headless` : ''),
    `Usage: ${renderWindow('5h', s.usage.fiveHour)} | ${renderWindow('week', s.usage.week)} | ${renderWindow('fable', s.usage.weekFable)}`,
    ``,
    `Queued: <b>${s.queued}</b>` + (s.customQueued > 0 ? ` (+${s.customQueued} in the custom queue)` : ''),
    `In review: <b>${s.review}</b>`,
  ];
  if (s.needsAttentionRuns > 0) lines.push(`Needs attention: <b>${s.needsAttentionRuns}</b> run(s)`);
  const late = s.counters.discardedLate > 0 ? ` (+${s.counters.discardedLate} stale since)` : '';
  const users = `${s.counters.rejectedUsers}${s.counters.rejectedUsersCapped ? '+' : ''}`;
  lines.push(
    ``,
    `Up since ${escapeHtml(formatClock(s.bootedAt))} · ${s.counters.discardedAtBoot} update(s) discarded at boot${late}`,
    `Rejected: ${s.counters.rejected} update(s) from ${users} other id(s)`,
  );
  return lines.join('\n');
}
