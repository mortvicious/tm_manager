/**
 * HTML reports (docs/telegram.md § Reports).
 *
 * Long content does not belong in a chat. `/report` builds ONE self-contained
 * `.html` file and sends it with `sendDocument`: Telegram renders it in its own
 * in-app viewer, and the same file opens in any browser.
 *
 * NOTHING LEAVES THE MACHINE except that upload. Telegraph was considered and
 * rejected (docs/future/telegram-bot.md § Reports, user decision 2026-09-01):
 * a Telegraph page is a public URL and these reports carry private work detail
 * — task titles, repo names, error text, an agent's result summaries. So the
 * document has zero external assets: no fonts, no scripts, no images, no
 * stylesheets. Every visual value below is a literal resolved from the
 * `--tm-*` dark theme in docs/tm-design-tokens.html, because a report opened
 * offline on a phone cannot fetch a token sheet.
 *
 * The chat message alongside the file carries the Russian summary, so the gist
 * is readable without opening anything.
 */
import type {
  AuditEvent,
  Dispatch,
  Feature,
  FeaturePlan,
  FeaturePlanPhase,
  FeaturePlanTask,
  PlanReviewRound,
  Proposal,
  Repo,
  Run,
  Task,
  TaskStatus,
  UsageSnapshot,
  UsageWindow,
} from '@tm/shared';
import { TERMINAL_TASK_STATUSES, groupLabel, isGroupRoot } from '@tm/shared';
import type { Storage } from '../storage/types.ts';
import { usageSnapshot } from '../claude/usage.ts';
import { escapeHtml } from './api.ts';
import { type Resolved, resolveFeature, resolveTask, short } from './ids.ts';

/** A resolved scope: the entity is already fetched, so rendering cannot 404. */
export type ReportScope =
  | { kind: 'period'; hours: number }
  | { kind: 'task'; task: Task }
  | { kind: 'feature'; feature: Feature }
  | { kind: 'group'; root: Task; groupId: string };

export interface ReportDocument {
  filename: string;
  html: string;
  /** Telegram-HTML, ready to be a caption or a message. */
  summary: string;
  /** The same Russian lines, unescaped, for a caller composing its own lede. */
  lines: string[];
}

/**
 * A period longer than this is not a report, it is an export — and every read
 * below is unpaginated. The `/report 7d` in the spec is well inside it.
 */
const MAX_PERIOD_HOURS = 24 * 31;
/** `listEvents` is hard-capped at 2000 by both drivers; ask for all of it. */
const EVENT_LIMIT = 2000;
/**
 * Entity scopes fetch events per task. A group or feature that large is a
 * pathological input, and a truncated report beats an unbounded query loop.
 */
const SCOPE_TASK_CAP = 200;
const NO_WINDOW: UsageWindow = { pct: 0, source: 'estimate', resetsAt: null, tokens: null, budget: null };
/** What a report shows when the usage scan itself failed — see collectReport. */
const EMPTY_USAGE: UsageSnapshot = {
  pct: 0,
  threshold: 0,
  routedModel: '',
  fiveHour: NO_WINDOW,
  week: NO_WINDOW,
  weekFable: NO_WINDOW,
  accountAgeMs: null,
};

/** Enough of an agent's summary to be a paragraph, not a wall. */
const SUMMARY_CHARS = 700;
const ERROR_CHARS = 400;
const DISPATCH_GIST_CHARS = 160;

// ---------------------------------------------------------------- scope ----

/**
 * `24h` · `7d` · `task <id>` · `feature <id>` · `group <id>`; empty = 24h.
 *
 * Ids are the same short prefixes every other command takes (docs/telegram.md
 * § Short ids) — nobody retypes a uuid on a phone.
 */
export async function resolveReportScope(storage: Storage, args: string): Promise<Resolved<ReportScope>> {
  const raw = args.trim();
  if (!raw) return { ok: true, value: { kind: 'period', hours: 24 } };
  const [word, ...rest] = raw.split(/\s+/);
  const key = word.toLowerCase();
  const id = rest.join(' ').trim();

  const period = /^(\d{1,4})([hd])$/.exec(key);
  if (period) {
    const n = Number(period[1]);
    const hours = period[2] === 'd' ? n * 24 : n;
    if (hours < 1 || hours > MAX_PERIOD_HOURS) {
      return { ok: false, error: `period must be between 1h and ${MAX_PERIOD_HOURS / 24}d` };
    }
    return { ok: true, value: { kind: 'period', hours } };
  }

  if (key === 'task' || key === 'feature' || key === 'group') {
    if (!id) return { ok: false, error: `usage: /report ${key} <id>` };
    if (key === 'feature') {
      const f = await resolveFeature(storage, id);
      return f.ok ? { ok: true, value: { kind: 'feature', feature: f.value } } : f;
    }
    const t = await resolveTask(storage, id);
    if (!t.ok) return t;
    if (key === 'task') return { ok: true, value: { kind: 'task', task: t.value } };
    // A group id IS its root task's id, so any member resolves the group —
    // typing the id of the task you happen to be looking at is the point.
    const root = isGroupRoot(t.value) ? t.value : await storage.getTask(t.value.groupId);
    return { ok: true, value: { kind: 'group', root: root ?? t.value, groupId: t.value.groupId } };
  }

  return { ok: false, error: `unknown report scope "${word}" — try 24h, 7d, task <id>, feature <id>, group <id>` };
}

// ----------------------------------------------------------- collection ----

interface ReviewRoll {
  rounds: number;
  verdicts: Map<string, number>;
  findings: number;
  /** tasks that took more than one round — the work→review→work loop */
  fixRounds: { taskId: string; title: string; rounds: number }[];
  /** Stops whose diff was unchanged (or empty), so no reviewer ran at all. */
  skipped: number;
}

interface PhaseRoll {
  index: number;
  title: string;
  goal: string;
  total: number;
  finished: number;
  running: number;
  failed: number;
  /**
   * The PLANNED tasks, read out of the analysis JSON. Before approval there
   * are no `tm_tasks` rows at all — that is the whole point of the gate — so
   * this is the only place a phase's work is written down, and the screen
   * where a human is asked to approve it sight-unseen is exactly where it has
   * to be readable.
   */
  planned: FeaturePlanTask[];
  /** whether any `tm_tasks` row exists for this phase yet */
  live: boolean;
}

/**
 * A feature's plan, for a `/report feature <id>`. The document's whole subject
 * when the feature is still `proposed`: no tasks exist, so every task-shaped
 * section below is empty and the plan is the only content there is.
 */
interface PlanBrief {
  feature: Feature;
  plan: FeaturePlan;
  rounds: PlanReviewRound[];
  /** `tm_tasks` rows that exist for this feature (0 until it is approved) */
  taskCount: number;
  plannedCount: number;
}

interface ReportData {
  scope: ReportScope;
  heading: string;
  subheading: string;
  generatedAt: Date;
  windowFrom: Date | null;
  tasks: Task[];
  repos: Map<string, Repo>;
  events: AuditEvent[];
  eventsTruncated: boolean;
  tasksTruncated: boolean;
  dispatches: Dispatch[];
  runs: Run[];
  usage: UsageSnapshot;
  reviews: ReviewRoll;
  planRounds: { feature: Feature; verdict: string; findings: number; round: number }[];
  publishes: number;
  failures: Task[];
  blocked: Task[];
  queued: Task[];
  customQueued: Task[];
  drafts: Task[];
  inReview: Task[];
  phases: { feature: Feature; phases: PhaseRoll[] }[];
  /** feature scope only — see PlanBrief */
  plan: PlanBrief | null;
  pendingProposals: Proposal[];
  awaitingApproval: Feature[];
  attention: { run: Run; task: Task | null }[];
  titles: Map<string, string>;
}

export async function collectReport(storage: Storage, scope: ReportScope): Promise<ReportData> {
  const generatedAt = new Date();
  const windowFrom = scope.kind === 'period' ? new Date(generatedAt.getTime() - scope.hours * 3_600_000) : null;

  const repoList = await storage.listRepos();
  const repos = new Map(repoList.map((r) => [r.id, r]));

  // --- the task set the report is ABOUT -------------------------------------
  let tasks: Task[];
  if (scope.kind === 'period') tasks = await storage.listTasks({ updatedSince: windowFrom!.toISOString() });
  else if (scope.kind === 'task') tasks = [scope.task];
  else if (scope.kind === 'feature') tasks = await storage.listTasks({ featureId: scope.feature.id });
  else tasks = await storage.listTasks({ groupId: scope.groupId });
  tasks = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const tasksTruncated = tasks.length > SCOPE_TASK_CAP;
  if (tasksTruncated) tasks = tasks.slice(0, SCOPE_TASK_CAP);
  const taskIds = new Set(tasks.map((t) => t.id));

  // --- events, dispatches, runs --------------------------------------------
  let events: AuditEvent[];
  let eventsTruncated = false;
  let dispatches: Dispatch[];
  let runs: Run[];
  if (scope.kind === 'period') {
    const since = windowFrom!.toISOString();
    events = await storage.listEvents({ since, limit: EVENT_LIMIT });
    eventsTruncated = events.length >= EVENT_LIMIT;
    dispatches = await storage.listDispatches({ since });
    runs = await storage.listRuns({ since });
  } else {
    // Per task rather than one windowed sweep: an entity scope has no window,
    // and its whole history is the point ("/report task <id>" = its full run
    // history). Bounded by SCOPE_TASK_CAP above.
    events = [];
    dispatches = [];
    runs = [];
    const seenDispatch = new Set<string>();
    for (const t of tasks) {
      events.push(...(await storage.listEvents({ taskId: t.id, limit: 200 })));
      runs.push(...(await storage.listRuns({ taskId: t.id })));
      for (const d of await storage.listDispatches({ taskId: t.id })) {
        if (!seenDispatch.has(d.id)) {
          seenDispatch.add(d.id);
          dispatches.push(d);
        }
      }
    }
    events.sort((a, b) => b.id.localeCompare(a.id));
    dispatches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  // --- titles for anything referenced by id but outside the scope ----------
  const titles = new Map<string, string>(tasks.map((t) => [t.id, t.title]));
  for (const d of dispatches) {
    for (const id of [d.fromTaskId, d.toTaskId]) {
      if (!titles.has(id)) titles.set(id, (await storage.getTask(id))?.title ?? '(deleted task)');
    }
  }

  // --- reviews: the verdict and the finding count live only in the audit row
  // (orchestrator.ts writes `run.reviewed` with { verdict, findings }); the
  // task keeps just the markdown. Fix rounds are not persisted as a number
  // anywhere, so the count of rounds for one task IS the count of its rows —
  // minus the rows that carry `skipped`, which record a review that did NOT
  // run (unchanged or empty diff) and are counted on their own line.
  const allReviewed = events.filter((e) => e.kind === 'run.reviewed');
  const reviewed = allReviewed.filter((e) => !e.data?.skipped);
  const perTask = new Map<string, number>();
  const reviews: ReviewRoll = {
    rounds: reviewed.length,
    verdicts: new Map(),
    findings: 0,
    fixRounds: [],
    skipped: allReviewed.length - reviewed.length,
  };
  for (const e of reviewed) {
    const verdict = typeof e.data?.verdict === 'string' ? e.data.verdict : 'unknown';
    reviews.verdicts.set(verdict, (reviews.verdicts.get(verdict) ?? 0) + 1);
    if (typeof e.data?.findings === 'number') reviews.findings += e.data.findings;
    if (e.taskId) perTask.set(e.taskId, (perTask.get(e.taskId) ?? 0) + 1);
  }
  for (const [taskId, rounds] of perTask) {
    if (rounds > 1) reviews.fixRounds.push({ taskId, title: titles.get(taskId) ?? short(taskId), rounds });
  }
  reviews.fixRounds.sort((a, b) => b.rounds - a.rounds);

  // --- feature plan reviews (structured, unlike code review) ----------------
  const featureIds = new Set(tasks.map((t) => t.featureId).filter((id): id is string => !!id));
  if (scope.kind === 'feature') featureIds.add(scope.feature.id);
  const scopedFeatures: Feature[] = [];
  for (const id of featureIds) {
    const f = await storage.getFeature(id);
    if (f) scopedFeatures.push(f);
  }
  const planRounds = scopedFeatures.flatMap((feature) =>
    (feature.review?.rounds ?? [])
      .filter((r) => !windowFrom || r.at >= windowFrom.toISOString())
      .map((r) => ({ feature, verdict: r.verdict, findings: r.findings.length, round: r.round })),
  );

  // A publish is what `verifyPublished()` concluded, not what an agent said —
  // so the count comes from the landing event, never from a status guess.
  const publishes = events.filter((e) => e.kind === 'task.publish' && e.data?.phase === 'published').length;

  // --- current state: "next steps" and "problems" --------------------------
  // For a PERIOD report this is the whole board — "what is waiting" is the
  // question a daily digest answers. For an entity scope it is that entity's
  // own work and nothing else: `/report task abc` that lists three unrelated
  // proposals and expands two unrelated feature plans is not a report about
  // `abc`, and the Russian caption (the line read on a lock screen) would be
  // asserting them of it.
  //
  // Every source below is gated on this ONE flag rather than each re-deriving
  // the rule, because the sources that were missed were exactly the ones that
  // derived it themselves.
  const wholeBoard = scope.kind === 'period';
  const board = wholeBoard ? await storage.listTasks() : tasks;
  const byStatus = (s: TaskStatus) => board.filter((t) => t.status === s);
  const queued = byStatus('queued');
  const customQueued = board
    .filter((t) => t.customQueueAt && !TERMINAL_TASK_STATUSES.includes(t.status))
    .sort((a, b) => (a.customQueueAt ?? '').localeCompare(b.customQueueAt ?? ''));
  const drafts = byStatus('draft');
  const inReview = byStatus('review');
  const failures = tasks.filter((t) => t.status === 'failed');
  const blocked = byStatus('blocked');

  const pendingProposals = (await storage.listProposals({ status: 'pending' })).filter(
    (p) => wholeBoard || (!!p.taskId && taskIds.has(p.taskId)),
  );
  // `featureIds` is every feature the scope's tasks belong to, plus the scoped
  // feature itself — so this one predicate covers the task, group and feature
  // scopes alike.
  const awaitingApproval = (await storage.listFeatures({ status: 'proposed' })).filter(
    (f) => wholeBoard || featureIds.has(f.id),
  );

  const liveRuns = await storage.listRuns({ status: 'running' });
  const attention: { run: Run; task: Task | null }[] = [];
  for (const r of liveRuns) {
    if (!r.needsAttention) continue;
    if (!wholeBoard && (!r.taskId || !taskIds.has(r.taskId))) continue;
    attention.push({ run: r, task: r.taskId ? await storage.getTask(r.taskId) : null });
  }

  // --- feature phase roll-up ------------------------------------------------
  const phaseFeatures =
    scope.kind === 'feature'
      ? scopedFeatures.filter((f) => f.id === scope.feature.id)
      : [
          ...scopedFeatures,
          // The install-wide sweep is a PERIOD-report thing only. `proposed`
          // belongs in it as much as `running` does — a feature awaiting
          // approval has no tasks and so reaches the report through no other
          // path, yet it is the one item in "next steps" that cannot move
          // without the human. But sweeping it into `/report task <id>` puts
          // an unrelated feature's phases, goals and planned titles into a
          // document about one task.
          ...(wholeBoard
            ? (await storage.listFeatures()).filter(
                (f) =>
                  (f.status === 'running' || f.status === 'approved' || f.status === 'proposed') &&
                  !featureIds.has(f.id),
              )
            : []),
        ];
  const phases: { feature: Feature; phases: PhaseRoll[] }[] = [];
  let plan: PlanBrief | null = null;
  for (const feature of phaseFeatures) {
    const analysis = feature.analysis;
    if (!analysis?.phases.length) continue;
    const featureTasks = await storage.listTasks({ featureId: feature.id });
    phases.push({ feature, phases: analysis.phases.map((ph, i) => rollPhase(ph, i, featureTasks)) });
    // The freshly-read row, not `scope.feature`: the caller's copy can predate
    // the analysis that is the point of the report.
    if (scope.kind === 'feature' && feature.id === scope.feature.id) {
      plan = {
        feature,
        plan: analysis,
        rounds: feature.review?.rounds ?? [],
        taskCount: featureTasks.length,
        plannedCount: analysis.phases.reduce((a, ph) => a + ph.tasks.filter((t) => !t.excluded).length, 0),
      };
    }
  }

  // Usage is one section of five, and it is the only one that reads outside the
  // database (transcripts, the CLI's caches). A scan that fails must cost that
  // section, not the report — an empty snapshot renders as 0% rather than
  // turning `/report` into an error message.
  const usage = await usageSnapshot(storage).catch((e) => {
    console.warn('telegram: report could not read usage:', e instanceof Error ? e.message : String(e));
    return EMPTY_USAGE;
  });

  return {
    scope,
    heading: scopeHeading(scope),
    subheading: scopeSubheading(scope, repos),
    generatedAt,
    windowFrom,
    tasks,
    repos,
    events,
    eventsTruncated,
    tasksTruncated,
    dispatches,
    runs,
    usage,
    reviews,
    planRounds,
    publishes,
    failures,
    blocked,
    queued,
    customQueued,
    drafts,
    inReview,
    phases,
    plan,
    pendingProposals,
    awaitingApproval,
    attention,
    titles,
  };
}

function rollPhase(phase: FeaturePlanPhase, index: number, featureTasks: Task[]): PhaseRoll {
  const mine = featureTasks.filter((t) => t.featurePhase === index);
  const planned = phase.tasks.filter((t) => !t.excluded);
  return {
    index,
    title: phase.title,
    goal: phase.goal,
    total: mine.length || planned.length,
    finished: mine.filter((t) => t.status === 'done' || t.status === 'published').length,
    running: mine.filter((t) => t.status === 'running').length,
    failed: mine.filter((t) => t.status === 'failed').length,
    planned,
    live: mine.length > 0,
  };
}

function scopeHeading(scope: ReportScope): string {
  if (scope.kind === 'period') return periodLabel(scope.hours);
  if (scope.kind === 'task') return scope.task.title;
  if (scope.kind === 'feature') return scope.feature.title;
  return groupLabel(scope.root, 'group');
}

function scopeSubheading(scope: ReportScope, repos: Map<string, Repo>): string {
  const repoOf = (id: string | null) => (id && repos.get(id)?.name) || 'no repo';
  if (scope.kind === 'period') return 'Task manager activity report';
  if (scope.kind === 'task') return `Task ${short(scope.task.id)} · ${repoOf(scope.task.repoId)} · ${scope.task.status}`;
  if (scope.kind === 'feature') {
    return `Feature ${short(scope.feature.id)} · ${repoOf(scope.feature.repoId)} · ${scope.feature.status}`;
  }
  return `Group ${short(scope.groupId)} · ${scope.root.status}`;
}

function periodLabel(hours: number): string {
  // 24h stays "24h": it is what the command is called, what the digest is, and
  // "Last 1d" reads like a rounding error next to it.
  if (hours % 24 === 0 && hours >= 48) return `Last ${hours / 24}d`;
  return `Last ${hours}h`;
}

// -------------------------------------------------------- Russian summary ----

/**
 * Russian plural agreement — 1 задача / 2 задачи / 5 задач. Worth the twelve
 * lines: the summary is the part read at a glance on a lock screen, and
 * "5 задача" is the kind of wrongness that makes a report feel machine-made.
 */
function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}
const nOf = (n: number, one: string, few: string, many: string) => `${n} ${plural(n, one, few, many)}`;

const RU_STATUS: Record<TaskStatus, string> = {
  draft: 'черновик',
  queued: 'в очереди',
  running: 'в работе',
  waiting: 'ждёт субагентов',
  blocked: 'заблокировано',
  review: 'на ревью',
  published: 'опубликовано',
  done: 'готово',
  failed: 'упало',
  cancelled: 'отменено',
};

const RU_FEATURE_STATUS: Record<string, string> = {
  draft: 'черновик',
  analyzing: 'анализируется',
  proposed: 'ждёт утверждения',
  approved: 'утверждена',
  running: 'выполняется',
  paused: 'на паузе',
  review: 'на ревью',
  done: 'готова',
  failed: 'упала',
  cancelled: 'отменена',
};

const RU_SCOPE: Record<ReportScope['kind'], string> = {
  period: 'период',
  task: 'задача',
  feature: 'фича',
  group: 'группа',
};

/**
 * КРАТКОЕ РЕЗЮМЕ ПО-РУССКИ — 3 to 6 lines, the top of the document AND the
 * message that carries the file. What happened, and what needs a decision.
 *
 * Returned as plain lines; the caller escapes for whichever surface it is.
 */
export function summaryLines(d: ReportData): string[] {
  const lines: string[] = [];
  const scopeWord =
    d.scope.kind === 'period'
      ? `За ${d.scope.hours >= 24 && d.scope.hours % 24 === 0 ? nOf(d.scope.hours / 24, 'сутки', 'суток', 'суток') : nOf(d.scope.hours, 'час', 'часа', 'часов')}`
      : `${RU_SCOPE[d.scope.kind][0].toUpperCase()}${RU_SCOPE[d.scope.kind].slice(1)} «${d.heading}»`;

  const counts = countByStatus(d.tasks);
  const breakdown = [...counts.entries()]
    .map(([status, n]) => `${RU_STATUS[status]} ${n}`)
    .join(', ');
  // A `proposed` feature has no task rows by design, so "задач не затронуто"
  // would describe the approval gate as if it were an empty week.
  const brief = d.plan;
  lines.push(
    d.tasks.length
      ? `${scopeWord}: затронуто ${nOf(d.tasks.length, 'задача', 'задачи', 'задач')} (${breakdown}).`
      : brief
        ? `${scopeWord}: план — ${nOf(brief.plan.phases.length, 'фаза', 'фазы', 'фаз')}, ` +
          `${nOf(brief.plannedCount, 'задача', 'задачи', 'задач')}; статус ${RU_FEATURE_STATUS[brief.feature.status] ?? brief.feature.status}, задачи ещё не созданы.`
        : `${scopeWord}: задач не затронуто.`,
  );
  if (brief?.plan.summary) lines.push(truncate(prose(brief.plan.summary, 240), 240));

  const activity: string[] = [];
  if (d.dispatches.length) activity.push(`${nOf(d.dispatches.length, 'диспатч', 'диспатча', 'диспатчей')} между агентами`);
  if (d.reviews.rounds) {
    const split = [...d.reviews.verdicts.entries()].map(([v, n]) => `${ruVerdict(v)} ${n}`).join(', ');
    activity.push(`${nOf(d.reviews.rounds, 'раунд', 'раунда', 'раундов')} ревью (${split}), ${nOf(d.reviews.findings, 'замечание', 'замечания', 'замечаний')}`);
  }
  if (d.reviews.skipped) {
    activity.push(`${d.reviews.skipped} ревью пропущено (диф не менялся)`);
  }
  if (d.planRounds.length) {
    const last = d.planRounds[d.planRounds.length - 1];
    activity.push(
      `${nOf(d.planRounds.length, 'ревью плана', 'ревью плана', 'ревью планов')}` +
        ` (последний вердикт: ${ruVerdict(last.verdict)}, ${nOf(last.findings, 'замечание', 'замечания', 'замечаний')})`,
    );
  }
  if (activity.length) lines.push(`Активность: ${activity.join('; ')}.`);

  const outcome: string[] = [];
  if (d.publishes) outcome.push(`опубликовано ${nOf(d.publishes, 'задача', 'задачи', 'задач')}`);
  if (d.failures.length) outcome.push(`упало ${nOf(d.failures.length, 'задача', 'задачи', 'задач')}`);
  if (d.blocked.length) outcome.push(`заблокировано ${nOf(d.blocked.length, 'задача', 'задачи', 'задач')}`);
  if (outcome.length) lines.push(`Итог: ${outcome.join(', ')}.`);

  const decisions: string[] = [];
  if (d.inReview.length) decisions.push(`${nOf(d.inReview.length, 'задача', 'задачи', 'задач')} на ревью`);
  if (d.pendingProposals.length) decisions.push(`${nOf(d.pendingProposals.length, 'предложение', 'предложения', 'предложений')}`);
  if (d.awaitingApproval.length) decisions.push(`${nOf(d.awaitingApproval.length, 'фича', 'фичи', 'фич')} ждёт утверждения`);
  if (d.attention.length) decisions.push(`${nOf(d.attention.length, 'агент', 'агента', 'агентов')} просит внимания`);
  lines.push(
    decisions.length
      ? `Требует решения: ${decisions.join(', ')}.`
      : 'Решений от человека сейчас не требуется.',
  );

  const waiting: string[] = [];
  if (d.queued.length) waiting.push(`в очереди ${d.queued.length}`);
  if (d.customQueued.length) waiting.push(`в своей очереди ${d.customQueued.length}`);
  if (d.drafts.length) waiting.push(`черновиков ${d.drafts.length}`);
  if (waiting.length) lines.push(`Дальше: ${waiting.join(', ')}.`);

  lines.push(
    `Расход: 5ч ${d.usage.fiveHour.pct}%, неделя ${d.usage.week.pct}%, неделя fable ${d.usage.weekFable.pct}%.`,
  );

  // The spec asks for 3–6 lines. Everything above is ordered most-important
  // first, so the trim drops the least important, and the floor pads with the
  // one fact that is always true rather than inventing a second sentence.
  while (lines.length > 6) lines.splice(lines.length - 2, 1);
  if (lines.length < 3) lines.push(`Отчёт собран ${formatLocal(d.generatedAt)}.`);
  return lines;
}

function ruVerdict(v: string): string {
  return v === 'clean' ? 'чисто' : v === 'concerns' || v === 'minor' ? 'замечания' : v === 'blocker' ? 'блокер' : v;
}

function countByStatus(tasks: Task[]): Map<TaskStatus, number> {
  const out = new Map<TaskStatus, number>();
  for (const t of tasks) out.set(t.status, (out.get(t.status) ?? 0) + 1);
  return new Map([...out.entries()].sort((a, b) => b[1] - a[1]));
}

// ------------------------------------------------------------- rendering ----

const esc = escapeHtml;

function formatLocal(d: Date): string {
  // Local wall clock, like status.ts: the reader is standing next to the Mac's
  // timezone, not reasoning about UTC offsets.
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function truncate(s: string, max: number): string {
  const flat = s.trim();
  return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}…`;
}

/**
 * An agent writes its result summary as markdown, and this document renders
 * text, not markdown — dumping the source verbatim puts `## The fix` and
 * `**bold**` on the page as literal characters. The spec asks for "a
 * one-paragraph result summary", so that is what this produces: prose, the
 * leading paragraphs, with the markup removed rather than displayed.
 *
 * A markdown RENDERER is deliberately not what this is. Turning an agent's
 * text into markup would mean deciding what to do with the HTML it may
 * contain, and the one thing a report must never do is let task text become
 * elements. Stripping is the direction that cannot go wrong.
 */
function prose(md: string, max: number): string {
  const cleaned = md
    .replace(/```[\s\S]*?```/g, ' ')       // fenced code — never a summary's point
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')     // headings keep their words, lose the hashes
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '• ')    // list markers become a bullet character
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<!\w)[*_]([^*_\n]+)[*_](?!\w)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')  // links keep their label, drop the target
    .replace(/[ \t]+/g, ' ');

  // Paragraphs, joined until the budget runs out — one is usually the whole
  // answer, but a summary whose first line is "Done." says nothing alone.
  const paras = cleaned
    .split(/\n\s*\n/)
    .map((x) => x.replace(/\n/g, ' ').trim())
    .filter(Boolean);
  const out: string[] = [];
  let len = 0;
  for (const para of paras) {
    if (out.length && len + para.length > max) break;
    out.push(para);
    len += para.length + 2;
    if (len >= max * 0.6) break;
  }
  return truncate(out.join('\n\n') || cleaned.trim(), max);
}

const REVIEW_BADGES: [RegExp, string][] = [
  [/✓\s*clean/i, 'clean'],
  [/⛔\s*blocker/i, 'blocker'],
  [/⚠\s*concerns/i, 'concerns'],
];

/**
 * The review verdict for one task. The audit row is authoritative (it is the
 * structured one); `review_summary` is markdown and only its badge line can be
 * read back, so it is the fallback for a review older than the event window.
 */
function verdictFor(task: Task, events: AuditEvent[]): string | null {
  // A `skipped` row carries no verdict — the one it deferred to is older, so
  // look past it rather than falling through to the markdown badge.
  const row = events.find(
    (e) => e.kind === 'run.reviewed' && e.taskId === task.id && typeof e.data?.verdict === 'string',
  );
  if (row) return String(row.data!.verdict);
  const last = task.reviewRounds[task.reviewRounds.length - 1];
  if (last) return last.verdict;
  if (!task.reviewSummary) return null;
  for (const [re, verdict] of REVIEW_BADGES) if (re.test(task.reviewSummary)) return verdict;
  return null;
}

const VERDICT_CLASS: Record<string, string> = { clean: 'ok', minor: 'warn', concerns: 'warn', blocker: 'bad' };

function statusClass(s: TaskStatus): string {
  return s === 'failed' || s === 'cancelled'
    ? 'bad'
    : s === 'review' || s === 'blocked'
      ? 'warn'
      : s === 'done' || s === 'published'
        ? 'ok'
        : s === 'running' || s === 'waiting'
          ? 'live'
          : 'mute';
}

/**
 * Every value here is a literal from the dark `--tm-*` set in
 * docs/tm-design-tokens.html — declared once as custom properties so the sheet
 * stays the source of truth even though the file cannot link to it. No
 * @font-face and no webfont names: `--tm-font-body` is "Inter", system-ui and
 * an offline phone would fall through to the second entry anyway, so the
 * report asks for the fallback directly rather than pretending.
 */
const REPORT_CSS = `
:root{
  --tm-bg:#0c0e10; --tm-bg-raised:#141619; --tm-bg-overlay:#1d2024; --tm-bg-inset:#08090b;
  --tm-border:#2c3036; --tm-border-strong:#464b52;
  --tm-text:#f1f2f4; --tm-text-muted:#9aa0a6; --tm-text-faint:#6b7178;
  --tm-accent:#2dd4bf; --tm-accent-strong:#14b8a6; --tm-accent-subtle:#0f3d38; --tm-accent-contrast:#06251f;
  --tm-ok:#4ade80; --tm-warn:#f5b83d; --tm-bad:#f4645f; --tm-info:#60a5fa; --tm-live:#2dd4bf;
  --tm-space-1:4px; --tm-space-2:8px; --tm-space-3:12px; --tm-space-4:16px;
  --tm-space-5:24px; --tm-space-6:32px; --tm-space-7:48px;
  --tm-radius-sm:4px; --tm-radius-md:8px; --tm-radius-lg:12px; --tm-radius-pill:999px;
  --tm-text-xs:0.75rem; --tm-text-sm:0.8125rem; --tm-text-md:0.9375rem;
  --tm-text-lg:1.125rem; --tm-text-xl:1.5rem; --tm-text-2xl:2.125rem;
  --tm-font-body:system-ui,-apple-system,"Segoe UI",sans-serif;
  --tm-font-mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  --tm-shadow-sm:0 1px 2px rgba(0,0,0,.5);
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; padding:var(--tm-space-4) var(--tm-space-4) var(--tm-space-7);
  background:var(--tm-bg); color:var(--tm-text);
  font-family:var(--tm-font-body); font-size:var(--tm-text-md); line-height:1.55;
}
main{max-width:52rem; margin:0 auto}
header{border-bottom:1px solid var(--tm-border); padding-bottom:var(--tm-space-4); margin-bottom:var(--tm-space-5)}
h1{font-size:var(--tm-text-xl); line-height:1.25; margin:0 0 var(--tm-space-1)}
.sub{color:var(--tm-text-muted); font-size:var(--tm-text-sm); margin:0}
.sub code{font-family:var(--tm-font-mono); font-size:var(--tm-text-xs)}
h2{
  font-size:var(--tm-text-lg); margin:var(--tm-space-6) 0 var(--tm-space-3);
  padding-bottom:var(--tm-space-2); border-bottom:1px solid var(--tm-border);
}
h3{font-size:var(--tm-text-md); color:var(--tm-text-muted); margin:var(--tm-space-4) 0 var(--tm-space-2);
   text-transform:uppercase; letter-spacing:.06em; font-size:var(--tm-text-xs)}
p{margin:0 0 var(--tm-space-2)}
.lede{
  background:var(--tm-accent-subtle); border:1px solid var(--tm-accent-strong);
  border-radius:var(--tm-radius-lg); padding:var(--tm-space-4);
  margin:0 0 var(--tm-space-5);
}
.lede h2{border:0; margin:0 0 var(--tm-space-2); font-size:var(--tm-text-md); color:var(--tm-accent)}
.lede p{margin:0 0 var(--tm-space-1); color:var(--tm-text)}
.lede p:last-child{margin-bottom:0}
.grid{display:grid; grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr)); gap:var(--tm-space-2)}
.stat{background:var(--tm-bg-raised); border:1px solid var(--tm-border);
      border-radius:var(--tm-radius-md); padding:var(--tm-space-3)}
.stat .n{font-size:var(--tm-text-xl); font-weight:600; line-height:1.1}
.stat .k{color:var(--tm-text-muted); font-size:var(--tm-text-xs); text-transform:uppercase; letter-spacing:.05em}
.card{background:var(--tm-bg-raised); border:1px solid var(--tm-border);
      border-radius:var(--tm-radius-md); padding:var(--tm-space-3);
      margin-bottom:var(--tm-space-2); box-shadow:var(--tm-shadow-sm)}
.card.bad{border-left:3px solid var(--tm-bad)}
.card.warn{border-left:3px solid var(--tm-warn)}
.card h4{margin:0 0 var(--tm-space-1); font-size:var(--tm-text-md); font-weight:600; line-height:1.35}
.card .meta{color:var(--tm-text-muted); font-size:var(--tm-text-xs); margin:0 0 var(--tm-space-2)}
.card .body{color:var(--tm-text); font-size:var(--tm-text-sm); white-space:pre-wrap; overflow-wrap:anywhere}
.pill{display:inline-block; padding:1px var(--tm-space-2); border-radius:var(--tm-radius-pill);
      font-size:var(--tm-text-xs); border:1px solid var(--tm-border-strong); color:var(--tm-text-muted);
      background:var(--tm-bg-overlay); white-space:nowrap}
.pill.ok{color:var(--tm-ok); border-color:var(--tm-ok)}
.pill.warn{color:var(--tm-warn); border-color:var(--tm-warn)}
.pill.bad{color:var(--tm-bad); border-color:var(--tm-bad)}
.pill.live{color:var(--tm-live); border-color:var(--tm-live)}
.pill.mute{color:var(--tm-text-faint)}
code{font-family:var(--tm-font-mono); font-size:var(--tm-text-xs); color:var(--tm-text-muted)}
ul{margin:0; padding-left:var(--tm-space-5)}
li{margin-bottom:var(--tm-space-1)}
.empty{color:var(--tm-text-faint); font-style:italic}
.bar{height:6px; background:var(--tm-bg-inset); border-radius:var(--tm-radius-pill);
     overflow:hidden; margin-top:var(--tm-space-1)}
.bar span{display:block; height:100%; background:var(--tm-accent)}
.bar span.warn{background:var(--tm-warn)}
.bar span.bad{background:var(--tm-bad)}
footer{margin-top:var(--tm-space-7); padding-top:var(--tm-space-3);
       border-top:1px solid var(--tm-border); color:var(--tm-text-faint); font-size:var(--tm-text-xs)}
@media (max-width:420px){
  body{padding:var(--tm-space-3) var(--tm-space-3) var(--tm-space-6)}
  h1{font-size:var(--tm-text-lg)}
}
`;

const pill = (text: string, cls = '') => `<span class="pill${cls ? ` ${cls}` : ''}">${esc(text)}</span>`;
const stat = (n: number | string, k: string) => `<div class="stat"><div class="n">${esc(String(n))}</div><div class="k">${esc(k)}</div></div>`;
const empty = (what: string) => `<p class="empty">${esc(what)}</p>`;

/** A feature scope whose plan has produced no task rows yet. */
function planNotApproved(d: ReportData): boolean {
  return !!d.plan && d.plan.taskCount === 0;
}

function repoName(d: ReportData, repoId: string | null): string {
  return (repoId && d.repos.get(repoId)?.name) || 'no repo';
}

function usageBar(label: string, w: UsageWindow): string {
  const cls = w.pct >= 90 ? 'bad' : w.pct >= 70 ? 'warn' : '';
  const resets = w.resetsAt ? ` · resets ${formatLocal(new Date(w.resetsAt))}` : '';
  return (
    `<div class="stat"><div class="n">${w.pct}%</div>` +
    `<div class="k">${esc(label)} · ${esc(w.source)}${esc(resets)}</div>` +
    `<div class="bar"><span class="${cls}" style="width:${Math.max(0, Math.min(100, w.pct))}%"></span></div></div>`
  );
}

/** 1) The Russian summary, at the very top of the document. */
function renderLede(lines: string[]): string {
  return (
    `<section class="lede"><h2>Краткое резюме</h2>` +
    lines.map((l) => `<p>${esc(l)}</p>`).join('') +
    `</section>`
  );
}

/**
 * The plan, for a feature scope. Placed between the Russian summary and
 * Numbers because on a `proposed` feature it is the ONLY content the document
 * has: no `tm_tasks` rows exist yet, so Numbers, Work done and Problems are
 * all legitimately empty, and a human is being asked to approve work they
 * cannot otherwise see. Rendering a phase count and calling it a plan is how
 * the approval screen ends up saying less than the chat message it replaced.
 */
function renderPlan(d: ReportData): string {
  const b = d.plan;
  if (!b) return '';
  const out: string[] = ['<h2>Plan</h2>'];

  const awaiting = b.feature.status === 'proposed';
  const meta = [
    pill(b.feature.status, b.feature.status === 'failed' ? 'bad' : awaiting ? 'warn' : 'mute'),
    pill(`${b.plan.phases.length} phase(s)`),
    pill(`${b.plannedCount} planned task(s)`),
    b.taskCount ? pill(`${b.taskCount} created`) : pill('not approved — no task rows yet', 'warn'),
    `<code>${esc(short(b.feature.id))}</code>`,
  ].join(' ');
  out.push(`<p class="meta">${meta}</p>`);

  if (b.plan.summary) out.push(`<div class="card"><div class="body">${esc(prose(b.plan.summary, SUMMARY_CHARS))}</div></div>`);

  if (b.plan.considerations.length) {
    out.push('<h3>Considerations</h3>');
    out.push(`<ul>${b.plan.considerations.map((c) => `<li>${esc(prose(c, 400))}</li>`).join('')}</ul>`);
  }

  if (b.rounds.length) {
    out.push('<h3>Plan review</h3>');
    out.push(
      b.rounds
        .map(
          (r) =>
            `<div class="card${r.verdict === 'blocker' ? ' bad' : r.verdict === 'minor' ? ' warn' : ''}">` +
            `<h4>Round ${r.round} ${pill(r.verdict, VERDICT_CLASS[r.verdict] ?? '')}</h4>` +
            `<p class="meta">${esc(r.model)} · <code>${esc(formatLocal(new Date(r.at)))}</code></p>` +
            (r.findings.length
              ? `<ul>${r.findings
                  .map(
                    (f) =>
                      `<li>${pill(f.severity, f.severity === 'blocker' ? 'bad' : f.severity === 'major' ? 'warn' : 'mute')} ` +
                      `<b>${esc(truncate(f.summary, 200))}</b>` +
                      `${f.detail ? `<br><span class="body">${esc(prose(f.detail, 400))}</span>` : ''}</li>`,
                  )
                  .join('')}</ul>`
              : '<p class="empty">No findings.</p>') +
            `</div>`,
        )
        .join(''),
    );
  }

  out.push('<h3>Phases</h3>');
  const roll = d.phases.find((x) => x.feature.id === b.feature.id)?.phases ?? [];
  out.push(
    b.plan.phases
      .map((ph, i) => {
        const r = roll[i];
        const progress = r && r.live ? ` ${pill(`${r.finished}/${r.total} done`, r.failed ? 'bad' : 'mute')}` : '';
        const tasks = ph.tasks.filter((t) => !t.excluded);
        return (
          `<div class="card"><h4>Phase ${i + 1} — ${esc(ph.title)}</h4>` +
          `<p class="meta">${pill(`${tasks.length} task(s)`)}${progress}</p>` +
          (ph.goal ? `<div class="body">${esc(prose(ph.goal, 400))}</div>` : '') +
          (tasks.length
            ? `<ul>${tasks
                .map(
                  (t) =>
                    `<li><b>${esc(truncate(t.title, 140))}</b>` +
                    `${t.category ? ` ${pill(t.category)}` : ''}${t.effort ? ` ${pill(t.effort)}` : ''}` +
                    `${t.description ? `<br><span class="body">${esc(prose(t.description, 320))}</span>` : ''}` +
                    `${t.exitCriteria?.length ? `<br><span class="body">Exit: ${esc(t.exitCriteria.map((c) => truncate(c, 160)).join(' · '))}</span>` : ''}</li>`,
                )
                .join('')}</ul>`
            : '<p class="empty">No tasks in this phase.</p>') +
          `</div>`
        );
      })
      .join(''),
  );

  if (awaiting) out.push('<p class="empty">Nothing below exists yet — approving this plan is what creates the tasks.</p>');
  return out.join('');
}

/** 2) Numbers. */
function renderNumbers(d: ReportData): string {
  const counts = countByStatus(d.tasks);
  const out: string[] = ['<h2>Numbers</h2>'];

  out.push('<h3>Tasks touched</h3>');
  out.push(
    counts.size
      ? `<div class="grid">${[...counts.entries()].map(([s, n]) => stat(n, s)).join('')}</div>`
      : empty(planNotApproved(d) ? 'No task rows exist yet — see Plan above; approving it is what creates them.' : 'No tasks in scope.'),
  );

  out.push('<h3>Outcomes</h3>');
  out.push(
    `<div class="grid">${[
      stat(d.publishes, 'publishes'),
      stat(d.failures.length, 'failures'),
      stat(d.dispatches.length, 'dispatches'),
      stat(d.reviews.rounds, 'review rounds'),
      stat(d.reviews.findings, 'findings'),
      stat(d.reviews.skipped, 'reviews skipped'),
      stat(d.runs.length, 'runs'),
    ].join('')}</div>`,
  );

  out.push('<h3>Dispatches</h3>');
  out.push(
    d.dispatches.length
      ? `<ul>${d.dispatches
          .map((x) => {
            const from = d.titles.get(x.fromTaskId) ?? short(x.fromTaskId);
            const to = d.titles.get(x.toTaskId) ?? short(x.toTaskId);
            const note = x.note ? ` — ${truncate(x.note, 120)}` : '';
            return (
              `<li>${pill(x.status, x.status === 'failed' ? 'bad' : x.status === 'delivered' ? 'ok' : 'warn')} ` +
              `<b>${esc(truncate(from, 60))}</b> → <b>${esc(truncate(to, 60))}</b>${esc(note)}<br>` +
              `<span class="body">${esc(prose(x.message, DISPATCH_GIST_CHARS))}</span></li>`
            );
          })
          .join('')}</ul>`
      : empty('No agent-to-agent dispatches.'),
  );

  out.push('<h3>Reviews</h3>');
  const verdictSplit = [...d.reviews.verdicts.entries()]
    .map(([v, n]) => pill(`${v} ${n}`, VERDICT_CLASS[v] ?? ''))
    .join(' ');
  const fix = d.reviews.fixRounds.length
    ? `<ul>${d.reviews.fixRounds
        .map((f) => `<li><b>${esc(truncate(f.title, 70))}</b> — ${f.rounds} rounds <code>${esc(short(f.taskId))}</code></li>`)
        .join('')}</ul>`
    : '<p class="empty">Every review passed in one round.</p>';
  const skipNote = d.reviews.skipped
    ? `<p class="empty">${d.reviews.skipped} Stop(s) reviewed nothing — the diff was unchanged since the last verdict, so no reviewer was spawned.</p>`
    : '';
  out.push(
    d.reviews.rounds
      ? `<p>${d.reviews.rounds} adversarial round(s), ${d.reviews.findings} finding(s). ${verdictSplit}</p>${fix}${skipNote}`
      : `${empty('No adversarial code reviews ran.')}${skipNote}`,
  );
  if (d.planRounds.length) {
    out.push(
      `<p>Plan reviews: ${d.planRounds
        .map((r) => `${esc(truncate(r.feature.title, 40))} r${r.round} ${pill(r.verdict, VERDICT_CLASS[r.verdict] ?? '')} ${r.findings} finding(s)`)
        .join(' · ')}</p>`,
    );
  }

  out.push('<h3>Usage</h3>');
  out.push(
    `<div class="grid">${usageBar('5h window', d.usage.fiveHour)}${usageBar('week', d.usage.week)}${usageBar('week (fable)', d.usage.weekFable)}</div>`,
  );
  return out.join('');
}

/** 3) Work done — one card per task that actually moved. */
function renderWork(d: ReportData): string {
  const worked = d.tasks.filter(
    (t) => t.resultSummary || t.status === 'failed' || TERMINAL_TASK_STATUSES.includes(t.status) || t.status === 'review',
  );
  if (!worked.length) {
    return `<h2>Work done</h2>${empty(
      planNotApproved(d) ? 'Nothing yet — this plan is awaiting approval.' : 'Nothing finished in this scope.',
    )}`;
  }
  const cards = worked
    .map((t) => {
      const verdict = verdictFor(t, d.events);
      const bits = [
        pill(t.status, statusClass(t.status)),
        pill(repoName(d, t.repoId)),
        verdict ? pill(`review: ${verdict}`, VERDICT_CLASS[verdict] ?? '') : '',
        t.category ? pill(t.category) : '',
        `<code>${esc(short(t.id))}</code>`,
        `<code>${esc(formatLocal(new Date(t.updatedAt)))}</code>`,
      ].filter(Boolean);
      const body = t.resultSummary
        ? `<div class="body">${esc(prose(t.resultSummary, SUMMARY_CHARS))}</div>`
        : t.error
          ? `<div class="body">${esc(prose(t.error, ERROR_CHARS))}</div>`
          : '<p class="empty">No result summary.</p>';
      return `<div class="card"><h4>${esc(t.title)}</h4><p class="meta">${bits.join(' ')}</p>${body}</div>`;
    })
    .join('');
  return `<h2>Work done</h2>${cards}`;
}

/** 4) Next steps — what is waiting, and what the human has to decide. */
function renderNext(d: ReportData): string {
  const out: string[] = ['<h2>Next steps</h2>'];
  const list = (label: string, tasks: Task[], note?: (t: Task) => string) =>
    out.push(
      `<h3>${esc(label)} (${tasks.length})</h3>` +
        (tasks.length
          ? `<ul>${tasks
              .slice(0, 30)
              .map(
                (t) =>
                  `<li><b>${esc(truncate(t.title, 90))}</b> ${pill(repoName(d, t.repoId))}` +
                  `${note ? ` ${esc(note(t))}` : ''} <code>${esc(short(t.id))}</code></li>`,
              )
              .join('')}${tasks.length > 30 ? `<li class="empty">and ${tasks.length - 30} more</li>` : ''}</ul>`
          : empty('none')),
    );

  list('Queued', d.queued);
  if (d.customQueued.length) list('Custom queue', d.customQueued);
  list('In review — waiting on you', d.inReview);
  list('Drafts', d.drafts);

  out.push('<h3>Feature phases</h3>');
  // The feature the Plan section already rendered in full is skipped here:
  // repeating its phases, goals and task titles half a screen later is noise,
  // and the roll-up adds nothing the card above did not already say.
  const rollups = d.phases.filter((x) => x.feature.id !== d.plan?.feature.id);
  out.push(
    rollups.length
      ? rollups
          .map(
            ({ feature, phases }) =>
              `<div class="card"><h4>${esc(feature.title)}</h4>` +
              `<p class="meta">${pill(feature.status, feature.status === 'failed' ? 'bad' : 'mute')} <code>${esc(short(feature.id))}</code></p>` +
              `<ul>${phases
                .map(
                  (p) =>
                    `<li>Phase ${p.index + 1} — <b>${esc(p.title)}</b>: ` +
                    // A phase with no task rows has no progress to report, and
                    // "0/3 done" reads like three tasks that failed to start.
                    // Before approval the honest line is what it is FOR.
                    (p.live
                      ? `${p.finished}/${p.total} done${p.running ? `, ${p.running} running` : ''}${p.failed ? `, ${p.failed} failed` : ''}`
                      : `${p.total} task(s) planned, not created yet`) +
                    (p.goal ? `<br><span class="body">${esc(prose(p.goal, 240))}</span>` : '') +
                    // The titles too when nothing exists yet: a digest naming a
                    // feature awaiting approval should say what it would do,
                    // not just how many phases it would take.
                    (!p.live && p.planned.length
                      ? `<br><span class="body">${esc(p.planned.map((t) => truncate(t.title, 80)).join(' · '))}</span>`
                      : '') +
                    `</li>`,
                )
                .join('')}</ul></div>`,
          )
          .join('')
      : empty(d.plan ? 'See Plan above.' : 'No features in flight.'),
  );

  out.push('<h3>Decisions awaiting you</h3>');
  const decisions: string[] = [];
  for (const p of d.pendingProposals) {
    decisions.push(
      `<li>Proposal ${pill(p.kind)} — ${esc(truncate(p.payload.title ?? p.payload.rationale, 120))} <code>${esc(short(p.id))}</code></li>`,
    );
  }
  for (const f of d.awaitingApproval) {
    const phases = f.analysis?.phases.length ?? 0;
    decisions.push(
      `<li>Feature awaiting approval — <b>${esc(f.title)}</b>, ${phases} phase(s) <code>${esc(short(f.id))}</code></li>`,
    );
  }
  for (const { run, task } of d.attention) {
    decisions.push(
      `<li>${pill('needs attention', 'warn')} <b>${esc(task?.title ?? '(no task)')}</b> — run <code>${esc(short(run.id))}</code> is waiting on a prompt</li>`,
    );
  }
  out.push(decisions.length ? `<ul>${decisions.join('')}</ul>` : empty('Nothing is waiting on a decision.'));
  return out.join('');
}

/** 5) Problems. */
function renderProblems(d: ReportData): string {
  const out: string[] = ['<h2>Problems</h2>'];
  const failedDispatches = d.dispatches.filter((x) => x.status === 'failed');
  if (!d.failures.length && !d.blocked.length && !failedDispatches.length) {
    return `${out[0]}${empty('No failures, no blocked parents, no failed dispatches.')}`;
  }

  if (d.failures.length) {
    out.push('<h3>Failed tasks</h3>');
    out.push(
      d.failures
        .map(
          (t) =>
            `<div class="card bad"><h4>${esc(t.title)}</h4>` +
            `<p class="meta">${pill(repoName(d, t.repoId))} <code>${esc(short(t.id))}</code> <code>${esc(formatLocal(new Date(t.updatedAt)))}</code></p>` +
            `<div class="body">${esc(t.error ? prose(t.error, ERROR_CHARS) : 'No error recorded.')}</div></div>`,
        )
        .join(''),
    );
  }
  if (d.blocked.length) {
    out.push('<h3>Blocked parents</h3>');
    out.push(
      `<ul>${d.blocked
        .map(
          (t) =>
            `<li><b>${esc(truncate(t.title, 90))}</b> ${pill(repoName(d, t.repoId))} — waiting on its children` +
            ` <code>${esc(short(t.id))}</code></li>`,
        )
        .join('')}</ul>`,
    );
  }
  if (failedDispatches.length) {
    out.push('<h3>Dispatch failures</h3>');
    out.push(
      `<ul>${failedDispatches
        .map((x) => {
          const to = d.titles.get(x.toTaskId) ?? short(x.toTaskId);
          return `<li>→ <b>${esc(truncate(to, 70))}</b>: ${esc(x.note ? truncate(x.note, 160) : 'no reason recorded')}</li>`;
        })
        .join('')}</ul>`,
    );
  }
  return out.join('');
}

/**
 * The whole document. One file, one `<style>`, no `<script>`, no `src=` — a
 * report opened on a plane looks the same as one opened online, and nothing in
 * it can phone home.
 */
export function renderReportHtml(d: ReportData, lines: string[]): string {
  const span = d.windowFrom
    ? `${formatLocal(d.windowFrom)} → ${formatLocal(d.generatedAt)}`
    : `all time · generated ${formatLocal(d.generatedAt)}`;
  const caveats: string[] = [];
  if (d.eventsTruncated) caveats.push(`Only the newest ${EVENT_LIMIT} audit rows were read; review counts are a floor.`);
  if (d.tasksTruncated) caveats.push(`Only the ${SCOPE_TASK_CAP} most recently updated tasks are covered.`);

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`${d.heading} — task manager report`)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<main>
<header>
<h1>${esc(d.heading)}</h1>
<p class="sub">${esc(d.subheading)}</p>
<p class="sub"><code>${esc(span)}</code></p>
</header>
${renderLede(lines)}
${renderPlan(d)}
${renderNumbers(d)}
${renderWork(d)}
${renderNext(d)}
${renderProblems(d)}
${caveats.length ? `<footer>${caveats.map((c) => esc(c)).join('<br>')}</footer>` : ''}
<footer>Generated locally by the task manager. This file is self-contained and was never published anywhere.</footer>
</main>
</body>
</html>`;
}

// ----------------------------------------------------------------- entry ----

function scopeSlug(scope: ReportScope): string {
  if (scope.kind === 'period') return periodLabel(scope.hours).toLowerCase().replace(/\s+/g, '');
  if (scope.kind === 'task') return `task-${short(scope.task.id)}`;
  if (scope.kind === 'feature') return `feature-${short(scope.feature.id)}`;
  return `group-${short(scope.groupId)}`;
}

/**
 * Collect, summarise, render. The one entry point — `/report`, `/digest` and
 * the feature-plan notification all go through here so there is exactly one
 * report shape in the product.
 */
export async function buildReport(storage: Storage, scope: ReportScope): Promise<ReportDocument> {
  const data = await collectReport(storage, scope);
  const lines = summaryLines(data);
  const stamp = formatLocal(data.generatedAt).replace(/[: ]/g, '-');
  return {
    filename: `tm-report-${scopeSlug(scope)}-${stamp}.html`,
    html: renderReportHtml(data, lines),
    summary: `<b>${esc(data.heading)}</b>\n${lines.map((l) => esc(l)).join('\n')}`,
    lines,
  };
}
