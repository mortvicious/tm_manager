// The office gate (docs/office.md § Gate and budget): the zero-token checks
// run before a shift is spawned. It gathers the facts from storage and git,
// then asks the pure `officeHardGate` and, only when that passes,
// `evalGuards` (shared/src/office.ts). No claude session, no model call — a
// refused wake costs a few SQL reads and, for `new-commits-since`, one
// `git rev-list` per workspace repo.

import type {
  AppSettings,
  Office,
  OfficeGateCode,
  OfficeGateFacts,
  OfficeGuard,
  OfficeGuardFacts,
  OfficeGuardKind,
  OfficeRole,
  OfficeShift,
  Repo,
  Task,
} from '@tm/shared';
import { TERMINAL_TASK_STATUSES, evalGuards, officeHardGate } from '@tm/shared';
import { run as runCmd } from '../git.ts';
import { EVENT_LIST_MAX } from '../storage/event-sql.ts';
import type { Storage } from '../storage/types.ts';
import { officeZone, settleOfficeBudget } from './budget.ts';

/** What woke the role; a human's `request` skips the guards (never the hard gate). */
export type OfficeGateTrigger = Pick<OfficeShift['trigger'], 'kind'> & Partial<OfficeShift['trigger']>;

export type OfficeGateResult =
  | { ok: true; hard: OfficeGateFacts; facts: OfficeGuardFacts | null }
  | {
      ok: false;
      skip: true;
      reason: string;
      /** a hard-gate code, or `guard` with the failing guard's kind */
      code: OfficeGateCode | 'guard' | 'role-mismatch';
      guard?: OfficeGuardKind;
      hard: OfficeGateFacts | null;
      facts: OfficeGuardFacts | null;
    };

/** Commits on the given repos' branches and remote refs since `sinceIso`; undefined when no repo could be read. */
export type CommitCounter = (repos: readonly Repo[], sinceIso: string) => Promise<number | undefined>;

export interface OfficeGateOptions {
  now?: number;
  settings?: AppSettings;
  countCommits?: CommitCounter;
  /**
   * The hard gate only, like a `request`: the Director's routing pass
   * (docs/office.md § Channel) — routing is owed work a message created, not
   * a cadence its guards were written for.
   */
  skipGuards?: boolean;
}

/**
 * `git rev-list --count --branches --remotes --since=<iso>` per repo, summed.
 * `--branches --remotes` (not `--all`) so a stash or a note is not "new code";
 * worktree branches (`tm/*`) are local branches of the main repo, so a task's
 * unlanded work counts. A repo git cannot read is left out; none readable =
 * undefined, which the guard reads as "cannot tell" and skips (fails closed).
 */
export const gitCommitsSince: CommitCounter = async (repos, sinceIso) => {
  let total = 0;
  let read = 0;
  for (const r of repos) {
    const res = await runCmd(r.path, 'git', ['rev-list', '--count', '--branches', '--remotes', `--since=${sinceIso}`], 15_000);
    const n = Number(res.out.trim().split('\n').pop());
    if (res.code !== 0 || !Number.isInteger(n)) continue;
    total += n;
    read += 1;
  }
  return read > 0 ? total : undefined;
};

/** A task reads as a bug: Sentry-filed, or a category naming bugs ("bug", "Bugs", "ui-bug"). */
export function isBugTask(t: Pick<Task, 'source' | 'category'>): boolean {
  return t.source === 'sentry' || /\bbugs?\b/i.test(t.category ?? '');
}

const BUG_UNCATEGORIZED = 'uncategorized';

export interface OfficeGuardFactsExtra {
  /** open bugs per category (`uncategorized` for none) — the breakdown behind `openBugs` */
  openBugsByCategory?: Record<string, number>;
}

const needsOf = (guards: readonly OfficeGuard[]) => new Set(guards.map((g) => g.kind));

/**
 * The facts the role's guards read — only the ones its guards need (a fact
 * no guard reads costs nothing), or every one with `all`. A fact that cannot
 * be read is left undefined, and `evalGuards` fails that guard closed.
 */
export async function officeGuardFacts(
  storage: Storage,
  office: Office,
  role: OfficeRole,
  opts: {
    now: number;
    spentUsd: number;
    roleSpentUsd: number | null;
    countCommits?: CommitCounter;
    all?: boolean;
  },
): Promise<OfficeGuardFacts & OfficeGuardFactsExtra> {
  const need = needsOf(role.guards);
  const wants = (k: OfficeGuardKind) => opts.all || need.has(k);
  // a huddle turn is not the role's own cadence (docs/office.md § Huddles)
  const lastRan = (await storage.listShifts({ roleId: role.id, verdict: 'ran', limit: 20 })).find((s) => s.trigger.kind !== 'huddle');
  const lastRanShiftAt = lastRan ? Date.parse(lastRan.startedAt) : null;
  const facts: OfficeGuardFacts & OfficeGuardFactsExtra = {
    now: opts.now,
    timezone: officeZone(office),
    lastRanShiftAt,
    lastShiftEndedAt: lastRan?.endedAt ? Date.parse(lastRan.endedAt) : lastRanShiftAt,
    officePaused: !!office.pausedAt,
    officePausedReason: office.pausedReason,
  };
  const officeLeft = office.dayBudgetUsd - opts.spentUsd;
  const roleLeft = role.capUsd !== null && opts.roleSpentUsd !== null ? role.capUsd - opts.roleSpentUsd : Infinity;
  facts.budgetLeftUsd = Math.max(0, Math.min(officeLeft, roleLeft));

  const sinceIso = lastRanShiftAt !== null ? new Date(lastRanShiftAt).toISOString() : null;
  const needCommits = sinceIso && wants('new-commits-since');
  const briefsGuard = role.guards.find((g): g is Extract<OfficeGuard, { kind: 'briefs-since' }> => g.kind === 'briefs-since');
  const needLanded = sinceIso && (wants('tasks-landed-since') || !!briefsGuard?.orTasksLanded || (opts.all && wants('briefs-since')));
  if (sinceIso && wants('briefs-since')) {
    const briefs = await storage.listBriefs({ officeId: office.id, since: sinceIso, limit: 2000 });
    facts.briefsSinceLastShift = briefs.filter((b) => b.roleId !== role.id).length;
  }
  const needBugs = wants('open-bugs-below');
  let repos: Repo[] | null = null;
  if (needCommits || needLanded || needBugs) {
    const ws = await storage.getWorkspace(office.workspaceId);
    if (ws) {
      const inWs = new Set(ws.repoIds);
      repos = (await storage.listRepos()).filter((r) => inWs.has(r.id));
    }
  }
  if (repos) {
    if (needCommits && sinceIso) {
      facts.newCommitsSinceLastShift = repos.length ? await (opts.countCommits ?? gitCommitsSince)(repos, sinceIso) : 0;
    }
    if (needLanded && sinceIso) {
      const rows = await storage.listEvents({
        kind: 'task.transition',
        repoIds: repos.map((r) => r.id),
        since: sinceIso,
        limit: EVENT_LIST_MAX,
      });
      const landed = new Set<string>();
      for (const e of rows) {
        const to = (e.data as { to?: unknown } | null)?.to;
        if (e.taskId && (to === 'done' || to === 'published')) landed.add(e.taskId);
      }
      facts.tasksLandedSinceLastShift = landed.size;
    }
    if (needBugs) {
      const open = (await storage.listTasks({ repoIds: repos.map((r) => r.id) })).filter(
        (t) => !TERMINAL_TASK_STATUSES.includes(t.status) && isBugTask(t),
      );
      const byCat: Record<string, number> = {};
      for (const t of open) {
        const c = t.category?.trim() || BUG_UNCATEGORIZED;
        byCat[c] = (byCat[c] ?? 0) + 1;
      }
      facts.openBugs = open.length;
      facts.openBugsByCategory = byCat;
    }
  }
  if (wants('no-open-task-of-this-role')) {
    facts.openTasksOfRole = await storage.countOpenOfficeTasks(office.id, role.id);
  }
  return facts;
}

/**
 * The hard gate's facts for one role, after settling the office's budget
 * trip (so a crossing pauses the office before anything is judged).
 */
async function officeHardFacts(storage: Storage, office: Office, role: OfficeRole, now: number, given?: AppSettings) {
  const settings = given ?? (await storage.getSettings());
  const budget = await settleOfficeBudget(storage, office, now);
  const o = budget.office;
  const roleSpentUsd = role.capUsd !== null ? await storage.officeSpendSince(o.id, budget.sinceIso, role.id) : null;
  const live = await storage.listShifts({ officeId: o.id, verdict: 'ran', open: true });
  const hard: OfficeGateFacts = {
    officeEnabled: o.enabled,
    roleEnabled: role.enabled,
    officePausedAt: o.pausedAt,
    officePausedReason: o.pausedReason,
    serverPaused: settings['orchestrator.paused'] === true,
    dayBudgetUsd: o.dayBudgetUsd,
    daySpentUsd: budget.spentUsd,
    budgetTrippedOn: o.budgetTrippedOn,
    today: budget.today,
    roleCapUsd: role.capUsd,
    roleSpentTodayUsd: roleSpentUsd ?? 0,
    activeShifts: live.length,
    maxSlots: o.maxSlots,
  };
  return { hard, budget, roleSpentUsd };
}

/**
 * May a saved command a shift of this role asked for run now
 * (docs/office.md § Command runs)? The HARD gate only — off, paused, Pause
 * all, the office day budget, the role cap — with the shift-slot test left
 * out: a command run is not a shift and takes no shift slot (its own limit
 * is one command run per office). Guards are money-saving rules for wakes,
 * not for a run the role already asked for. Null = it may run.
 */
export async function officeCommandGate(
  storage: Storage,
  office: Office,
  role: OfficeRole,
  opts: { now?: number; settings?: AppSettings } = {},
): Promise<{ code: OfficeGateCode | 'role-mismatch'; reason: string; hard: OfficeGateFacts | null } | null> {
  if (role.officeId !== office.id) return { code: 'role-mismatch', reason: 'role is not in this office', hard: null };
  const { hard } = await officeHardFacts(storage, office, role, opts.now ?? Date.now(), opts.settings);
  const refusal = officeHardGate({ ...hard, activeShifts: 0 });
  return refusal ? { ...refusal, hard } : null;
}

/**
 * May this role's shift start now? Settles the office's budget trip first
 * (so a crossing pauses the office before anything is judged), then the hard
 * gate — whose reason always wins over any guard's, since guards are not even
 * evaluated (nor their facts gathered) once it refuses — then the guards,
 * except for a human `request`, which a guard (a money-saving rule for
 * automatic wakes) never skips. Never writes `orchestrator.paused`.
 */
export async function officeGate(
  storage: Storage,
  office: Office,
  role: OfficeRole,
  trigger: OfficeGateTrigger,
  opts: OfficeGateOptions = {},
): Promise<OfficeGateResult> {
  const now = opts.now ?? Date.now();
  if (role.officeId !== office.id) {
    return { ok: false, skip: true, reason: 'role is not in this office', code: 'role-mismatch', hard: null, facts: null };
  }
  const { hard, budget, roleSpentUsd } = await officeHardFacts(storage, office, role, now, opts.settings);
  const o = budget.office;
  const refusal = officeHardGate(hard);
  if (refusal) return { ok: false, skip: true, reason: refusal.reason, code: refusal.code, hard, facts: null };
  if (trigger.kind === 'request' || opts.skipGuards) return { ok: true, hard, facts: null };

  const facts = await officeGuardFacts(storage, o, role, {
    now,
    spentUsd: budget.spentUsd,
    roleSpentUsd,
    countCommits: opts.countCommits,
  });
  const verdict = evalGuards(role.guards, facts);
  if (!verdict.pass) {
    return { ok: false, skip: true, reason: verdict.reason, code: 'guard', guard: verdict.guard, hard, facts };
  }
  return { ok: true, hard, facts };
}
