// The office scorecard (docs/office.md § Scorecard) — a PURE fold over rows
// the server already keeps, so the same figures come out of the route, the
// Director's stand-up and the Telegram document, and a fixture test pins them.
//
// "Measuring autonomy": what the office landed, what it cost, and how often a
// human had to step in. Nothing here reads agent text; every figure is a count
// or a sum over server-written rows.

import type { Task, TaskStatus } from './types.ts';
import type { OfficeProposal, OfficeRating, OfficeShift } from './office.ts';

/** A task reads as a bug: Sentry-filed, or a category naming bugs ("bug", "Bugs", "ui-bug"). */
export function isBugTask(t: Pick<Task, 'source' | 'category'>): boolean {
  return t.source === 'sentry' || /\bbugs?\b/i.test(t.category ?? '');
}

/** The window the figures cover: `[since, until)`, ISO. */
export interface OfficeScorecardWindow {
  since: string;
  until: string;
}

/** Days the route and the panel offer (`?days=`); anything else is clamped to 1..90. */
export const OFFICE_SCORECARD_DAYS = [7, 30] as const;
export const OFFICE_SCORECARD_DAYS_MAX = 90;

/** Actors that are the human (the SPA and the phone). */
export const SCORECARD_HUMAN_ACTORS: readonly string[] = ['human', 'telegram'];

/** An audit row, reduced to what the fold reads. */
export interface ScorecardEvent {
  kind: string;
  at: string;
  actor: string;
  taskId: string | null;
  data: Record<string, unknown> | null;
}

export interface OfficeScorecardRows {
  roles: { id: string; key: string; name: string }[];
  /** EVERY task the office filed (`tm_tasks.office_id`), whatever its age — the window applies to the events */
  tasks: Pick<Task, 'id' | 'roleId' | 'source' | 'category' | 'createdAt'>[];
  /**
   * Audit rows in (or around) the window: `task.transition` (landings, human
   * moves), `question.answered`, `approval.decided` on office tasks, and
   * `office.taint-cleared` of this office. Rows outside the window, on a task
   * not in `tasks`, or of another office are ignored.
   */
  events: ScorecardEvent[];
  shifts: Pick<OfficeShift, 'id' | 'roleId' | 'verdict' | 'skipCode' | 'startedAt'>[];
  proposals: Pick<OfficeProposal, 'id' | 'roleId' | 'status' | 'decidedAt'>[];
  ratings: Pick<OfficeRating, 'roleId' | 'value' | 'updatedAt'>[];
  /**
   * Spend in the window (USD) — the SQL `officeSpendSince` sum (shift runs +
   * office tasks' runs), office-wide and per role; precomputed because it is
   * the one figure the database sums.
   */
  spend: { officeUsd: number; byRole: Record<string, number> };
  /** the office this is about — `office.taint-cleared` rows of other offices are skipped */
  officeId: string;
}

export interface OfficeScoreInterventions {
  /** `task.transition` on an office task by a human actor */
  transitions: number;
  /** `question.answered` by a human (an autopilot pick is not) */
  answers: number;
  /** `approval.decided` approved */
  approvals: number;
  /** `approval.decided` rejected */
  rejections: number;
  /** `office.taint-cleared` — a human marked a brief, a message or a role's notes reviewed */
  taintClears: number;
  total: number;
}

export interface OfficeScoreFigures {
  /** office tasks that reached done/published in the window (distinct) */
  landed: number;
  /** office tasks created in the window */
  filed: number;
  /** office tasks reading as a bug (`isBugTask`) created in the window */
  bugsFound: number;
  /** office bug tasks that landed in the window */
  bugsFixed: number;
  proposalsAccepted: number;
  proposalsRejected: number;
  /** shifts that ran in the window */
  shifts: number;
  spentUsd: number;
  /** `spentUsd / landed`; null with nothing landed */
  usdPerLanded: number | null;
  interventions: OfficeScoreInterventions;
  /** skipped shifts by `skipCode` (`guard`, a gate code, a runner refusal; `other` for none) */
  skips: Record<string, number>;
  skipsTotal: number;
  ratings: { up: number; down: number };
}

export interface OfficeRoleScore extends OfficeScoreFigures {
  roleId: string;
  key: string;
  name: string;
}

export interface OfficeScorecard {
  since: string;
  until: string;
  office: OfficeScoreFigures;
  /** one per role, in the order given (a deleted role's rows count office-wide only) */
  roles: OfficeRoleScore[];
}

/** `GET /api/offices/:id/scorecard?days=` */
export interface OfficeScorecardResponse extends OfficeScorecard {
  officeId: string;
  days: number;
  /** when the figures were computed (the route caches them 10 min) */
  computedAt: string;
}

const LANDED: readonly TaskStatus[] = ['done', 'published'];

function emptyFigures(): OfficeScoreFigures {
  return {
    landed: 0,
    filed: 0,
    bugsFound: 0,
    bugsFixed: 0,
    proposalsAccepted: 0,
    proposalsRejected: 0,
    shifts: 0,
    spentUsd: 0,
    usdPerLanded: null,
    interventions: { transitions: 0, answers: 0, approvals: 0, rejections: 0, taintClears: 0, total: 0 },
    skips: {},
    skipsTotal: 0,
    ratings: { up: 0, down: 0 },
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The scorecard for `window`, office-wide and per role. A task's role is its
 * `roleId` (a Director feature card carries the Director's); an event on a
 * task with no role counts office-wide only.
 */
export function officeScorecard(rows: OfficeScorecardRows, window: OfficeScorecardWindow): OfficeScorecard {
  const inWin = (at: string | null | undefined): boolean => !!at && at >= window.since && at < window.until;
  const office = emptyFigures();
  const byRole = new Map<string, OfficeScoreFigures>(rows.roles.map((r) => [r.id, emptyFigures()]));
  /** apply `fn` to the office and to the role's figures, when the role is known */
  const add = (roleId: string | null | undefined, fn: (f: OfficeScoreFigures) => void) => {
    fn(office);
    const r = roleId ? byRole.get(roleId) : undefined;
    if (r) fn(r);
  };
  const tasks = new Map(rows.tasks.map((t) => [t.id, t]));

  for (const t of rows.tasks) {
    if (!inWin(t.createdAt)) continue;
    const bug = isBugTask(t);
    add(t.roleId, (f) => {
      f.filed += 1;
      if (bug) f.bugsFound += 1;
    });
  }

  const landed = new Set<string>();
  const human = new Set(SCORECARD_HUMAN_ACTORS);
  for (const e of rows.events) {
    if (!inWin(e.at)) continue;
    const d = e.data ?? {};
    if (e.kind === 'office.taint-cleared') {
      if (d.officeId !== rows.officeId || !human.has(e.actor)) continue;
      const roleId = typeof d.roleId === 'string' ? d.roleId : null;
      add(roleId, (f) => (f.interventions.taintClears += 1));
      continue;
    }
    const task = e.taskId ? tasks.get(e.taskId) : undefined;
    if (!task) continue;
    if (e.kind === 'task.transition') {
      const to = d.to as TaskStatus | undefined;
      if (to && LANDED.includes(to) && !landed.has(task.id)) {
        landed.add(task.id);
        const bug = isBugTask(task);
        add(task.roleId, (f) => {
          f.landed += 1;
          if (bug) f.bugsFixed += 1;
        });
      }
      if (human.has(e.actor)) add(task.roleId, (f) => (f.interventions.transitions += 1));
    } else if (e.kind === 'question.answered') {
      if (human.has(e.actor)) add(task.roleId, (f) => (f.interventions.answers += 1));
    } else if (e.kind === 'approval.decided') {
      if (!human.has(e.actor)) continue;
      const approved = d.approved === true;
      add(task.roleId, (f) => {
        if (approved) f.interventions.approvals += 1;
        else f.interventions.rejections += 1;
      });
    }
  }

  for (const s of rows.shifts) {
    if (!inWin(s.startedAt)) continue;
    if (s.verdict === 'ran') add(s.roleId, (f) => (f.shifts += 1));
    else {
      const code = s.skipCode || 'other';
      add(s.roleId, (f) => {
        f.skips[code] = (f.skips[code] ?? 0) + 1;
        f.skipsTotal += 1;
      });
    }
  }

  for (const p of rows.proposals) {
    if (!inWin(p.decidedAt)) continue;
    if (p.status === 'accepted') add(p.roleId, (f) => (f.proposalsAccepted += 1));
    else if (p.status === 'rejected') add(p.roleId, (f) => (f.proposalsRejected += 1));
  }

  for (const r of rows.ratings) {
    if (!inWin(r.updatedAt)) continue;
    add(r.roleId, (f) => {
      if (r.value === 1) f.ratings.up += 1;
      else f.ratings.down += 1;
    });
  }

  const finish = (f: OfficeScoreFigures, spent: number) => {
    f.spentUsd = round2(spent);
    f.usdPerLanded = f.landed > 0 ? round2(spent / f.landed) : null;
    const i = f.interventions;
    i.total = i.transitions + i.answers + i.approvals + i.rejections + i.taintClears;
  };
  finish(office, rows.spend.officeUsd);
  const roles: OfficeRoleScore[] = rows.roles.map((r) => {
    const f = byRole.get(r.id)!;
    finish(f, rows.spend.byRole[r.id] ?? 0);
    return { roleId: r.id, key: r.key, name: r.name, ...f };
  });
  return { since: window.since, until: window.until, office, roles };
}

/** Clamp a `?days=` value: an integer 1..`OFFICE_SCORECARD_DAYS_MAX`, default 7. */
export function scorecardDays(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 7;
  return Math.min(OFFICE_SCORECARD_DAYS_MAX, n);
}

/** Skip reasons as one readable line — `guard 3 · budget 1`; `none` when nothing was skipped. */
export function scorecardSkipsLine(skips: Record<string, number>): string {
  const parts = Object.entries(skips)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} ${n}`);
  return parts.length ? parts.join(' · ') : 'none';
}

/** One figure line for a document head — the stand-up's and the Telegram brief's. */
export function scorecardLine(f: OfficeScoreFigures): string {
  const per = f.usdPerLanded === null ? '—' : `$${f.usdPerLanded.toFixed(2)}`;
  return [
    `${f.landed} landed`,
    `bugs ${f.bugsFound} found / ${f.bugsFixed} fixed`,
    `proposals ${f.proposalsAccepted}✓ ${f.proposalsRejected}✗`,
    `$${f.spentUsd.toFixed(2)} spent (${per}/landed)`,
    `${f.interventions.total} human interventions`,
    `skips: ${scorecardSkipsLine(f.skips)}`,
    `👍${f.ratings.up} 👎${f.ratings.down}`,
  ].join(' · ');
}

/**
 * The scorecard as markdown lines (blockquote) — the head of the Director's
 * stand-up file, which is also what /office and the Telegram document render.
 */
export function scorecardMarkdown(card: OfficeScorecard): string[] {
  const out = [`> **Office:** ${scorecardLine(card.office)}`];
  for (const r of card.roles) {
    const quiet = r.landed + r.filed + r.shifts + r.skipsTotal + r.proposalsAccepted + r.proposalsRejected + r.ratings.up + r.ratings.down + r.interventions.total === 0 && r.spentUsd === 0;
    if (!quiet) out.push(`> - **${r.name}** (\`${r.key}\`): ${scorecardLine(r)}`);
  }
  return out;
}
