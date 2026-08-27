// Entities and wire protocol shared between server and web.

export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'blocked'
  | 'review'
  /** committed and pushed by the agent that did the work (docs/publish.md) */
  | 'published'
  | 'done'
  | 'failed'
  | 'cancelled';

/**
 * Statuses that end a task's life. `published` joins `done` here: everything
 * that waits on a task (a split parent, a feature phase gate) must treat a
 * pushed task as settled, not as still-open work.
 */
export const TERMINAL_TASK_STATUSES: TaskStatus[] = ['published', 'done', 'failed', 'cancelled'];

export type TaskSource = 'manual' | 'sentry' | 'auto' | 'feature';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// Dropdown suggestions; agent.model / task.model accept any model id string.
export const MODEL_OPTIONS = ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];

/**
 * One-click bundles of the three per-task overrides (model / effort /
 * adversarial review), offered on the new-task form and the task panel so the
 * common cases are one click instead of three dropdowns.
 *
 * `review: null` means "leave it to the `review.enabled` setting" — the same
 * value the dropdown's "default (config)" option writes.
 */
export interface TaskPreset {
  id: 'small' | 'routine' | 'complex';
  label: string;
  /** what the preset resolves to, shown next to the label */
  hint: string;
  model: string;
  effort: EffortLevel;
  review: boolean | null;
}

export const TASK_PRESETS: TaskPreset[] = [
  // Small and Routine both skip adversarial review — the work is short enough
  // that a review round costs more than it catches. Only Complex pins it on.
  // The hint spells out review only when it is ON; "no review" is the norm for
  // the two cheap presets and would just be noise on every button.
  {
    id: 'small',
    label: 'Small',
    hint: 'opus 5 · medium',
    model: 'claude-opus-5',
    effort: 'medium',
    review: false,
  },
  {
    id: 'routine',
    label: 'Routine',
    hint: 'opus 5 · high',
    model: 'claude-opus-5',
    effort: 'high',
    review: false,
  },
  {
    id: 'complex',
    label: 'Complex',
    hint: 'fable 5 · high · review',
    model: 'claude-fable-5',
    effort: 'high',
    review: true,
  },
];

/** The preset a set of override values corresponds to, or undefined ("custom"). */
export function matchTaskPreset(v: {
  model: string | null;
  effort: EffortLevel | null;
  review: boolean | null;
}): TaskPreset | undefined {
  return TASK_PRESETS.find((p) => p.model === v.model && p.effort === v.effort && p.review === v.review);
}

export interface Repo {
  id: string;
  name: string;
  path: string; // absolute; ~ expanded on insert
  role: string | null; // free note: "backend", "frontend", ...
  /** dev-server URL framed by the mobile emulator window (http/https only; null = no preview) */
  previewUrl: string | null;
  createdAt: string;
}

/**
 * A saved shell command a repo can run on demand ("pnpm start:dev"), stored
 * per repo and executed in a real PTY exactly like an agent session.
 * `service` = long-running (dev server, watcher) — those are what the header
 * running-indicator counts; `task` = runs, prints, exits.
 */
export type CommandKind = 'task' | 'service';

export interface RepoCommand {
  id: string;
  repoId: string;
  /** human label shown in the launcher */
  name: string;
  /** the command line; parsed into argv server-side, NEVER handed to a shell */
  command: string;
  kind: CommandKind;
  /** subdirectory of the repo to run in (relative, inside the repo); null = repo root */
  cwd: string | null;
  /** launcher order within the repo, ascending */
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type CommandRunStatus = 'running' | 'exited' | 'killed';

/**
 * One execution of a RepoCommand. Deliberately in-memory only (never a
 * `tm_runs` row): a PTY dies with the server, so a persisted "running" command
 * could only ever be a lie after a restart — and boot recovery must keep
 * treating every `tm_runs` row as an agent.
 */
export interface CommandRun {
  /** also the PTY session id — attach at /ws/terminal/:id */
  id: string;
  /** null once the definition was edited/deleted while the run was alive */
  commandId: string | null;
  repoId: string | null;
  /** snapshotted so a finished run still renders after its repo/command is gone */
  repoName: string;
  name: string;
  command: string;
  kind: CommandKind;
  cwd: string;
  status: CommandRunStatus;
  pid: number | null;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
}

/** One `package.json` script the repo scanner found. */
export interface ScannedScript {
  /** script name as written in package.json */
  name: string;
  /** its body, for the tooltip */
  script: string;
  /** package directory relative to the repo root ('' = root) */
  cwd: string;
  /** package.json `name` of the workspace the script belongs to */
  packageName: string;
  /** ready-to-save command line, e.g. "pnpm run start:dev" */
  suggested: string;
  /** guessed from the script name/body — a dev server is a `service` */
  kind: CommandKind;
}

export interface RepoScripts {
  /** pnpm / yarn / npm / bun, detected from packageManager or the lockfile */
  packageManager: string;
  scripts: ScannedScript[];
  /** why the list is empty / partial (no package.json, unreadable, capped) */
  note: string | null;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  repoId: string | null;
  parentId: string | null;
  /**
   * Root ancestor of this task's tree — the task GROUP id. A task with no
   * parent is its own group (`groupId === id`), so this is never null and
   * every task belongs to exactly one group.
   */
  groupId: string;
  /**
   * Materialized path to the first parent: ancestor ids root-first, slash
   * delimited with a leading AND trailing slash. `'/'` for a root task,
   * `'/rootId/'` for its child, `'/rootId/midId/'` for a grandchild.
   */
  groupPath: string;
  /**
   * Human name for the group this task ROOTS. Meaningful only on a root
   * (`id === groupId`); null falls back to the root task's title. Cleared
   * automatically when a task stops being a root.
   */
  groupName: string | null;
  /**
   * Colour slot (1..GROUP_COLOR_COUNT) for the group this task ROOTS, same
   * root-only rule as `groupName`. null = the slot derived from `groupId`.
   */
  groupColor: number | null;
  status: TaskStatus;
  source: TaskSource;
  sourceRef: string | null;
  priority: number;
  /** per-task overrides; null falls back to agent.model / agent.effort settings */
  model: string | null;
  effort: EffortLevel | null;
  /** domain label ("UI", "Estimator") — agents create and fill these */
  category: string | null;
  /** run id of the agent that filed this task (null = human-created) */
  createdByRun: string | null;
  /** distance from human intent: human 0, agent-filed = creator's depth + 1 (cap 2) */
  spawnDepth: number;
  /** the Feature this task was generated from (null = standalone task) */
  featureId: string | null;
  /** 0-based phase index inside that feature; phases run in order */
  featurePhase: number | null;
  resultSummary: string | null;
  /** per-task adversarial review override: null = use review.enabled setting */
  review: boolean | null;
  /**
   * Skip the human review gate: when the worker finishes, the same agent
   * session commits and pushes the work and the task lands in `published`
   * (docs/publish.md). Also skips the adversarial review round — the point of
   * the flag is "no gate between finishing and shipping".
   */
  autoPublish: boolean;
  /** adversarial review of the worker's change (Fable, or Opus xhigh fallback) */
  reviewSummary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** How many distinct colours the board can tint groups with (`--tm-group-1..N`). */
export const GROUP_COLOR_COUNT = 7;

/**
 * The colour slot a group is drawn in: the root's explicit `groupColor` when
 * set, otherwise a stable slot hashed from the group id (FNV-1a) so the same
 * group keeps the same colour across reloads and machines without storing it.
 */
export function groupColorSlot(root: Pick<Task, 'groupId' | 'groupColor'> | undefined, groupId?: string): number {
  const explicit = root?.groupColor;
  if (explicit != null && Number.isInteger(explicit) && explicit >= 1 && explicit <= GROUP_COLOR_COUNT) return explicit;
  const id = root?.groupId ?? groupId ?? '';
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % GROUP_COLOR_COUNT) + 1;
}

/** Ancestor ids of a task, root first (empty for a root task). */
export function groupAncestors(t: Pick<Task, 'groupPath'>): string[] {
  return t.groupPath.split('/').filter(Boolean);
}

/** How deep a task sits under its group root (0 = the root itself). */
export function groupDepth(t: Pick<Task, 'groupPath'>): number {
  return groupAncestors(t).length;
}

/** Does this task root its own group? Only a root carries `groupName`. */
export function isGroupRoot(t: Pick<Task, 'id' | 'groupId'>): boolean {
  return t.id === t.groupId;
}

/** Display name of the group `root` heads — its explicit name, else its title. */
export function groupLabel(root: Pick<Task, 'title' | 'groupName'> | undefined, fallback = 'group'): string {
  if (!root) return fallback;
  return root.groupName?.trim() || root.title;
}

export type RunMode = 'worker' | 'analyze';
export type RunStatus = 'running' | 'exited' | 'killed';

/** Usage figures parsed from the claude session transcript (filled by hooks/exit). */
export interface RunStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** share of the model's context window used by the last turn, 0..100 */
  contextPct: number;
}

export interface Run {
  id: string;
  taskId: string | null;
  repoId: string | null;
  mode: RunMode;
  status: RunStatus;
  pid: number | null;
  exitCode: number | null;
  needsAttention: boolean;
  /** task completed; PTY kept attachable but no longer counts as working */
  idle: boolean;
  model: string | null;
  effort: EffortLevel | null;
  sessionId: string | null;
  transcriptPath: string | null;
  stats: RunStats | null;
  /** run whose claude session this run CONTINUED (`claude --resume`); null = fresh session */
  resumedFrom: string | null;
  /** cumulative transcript totals at the moment this run resumed — subtracted
   *  from the raw transcript sums so a resumed run reports only its OWN usage */
  statsBaseline: RunStats | null;
  startedAt: string;
  endedAt: string | null;
}

/** Where a usage figure came from. `account` = the real plan utilization the
 *  claude CLI last fetched (same numbers as its `/usage` panel); `estimate` =
 *  our own tally of local transcripts, used when the account figure is missing
 *  or its window has already reset. */
export type UsageSource = 'account' | 'estimate';

/** One rate-limit window of the subscription usage shown in the header. */
export interface UsageWindow {
  /** 0..100, one decimal */
  pct: number;
  source: UsageSource;
  /** ISO time the window rolls over — account source only */
  resetsAt: string | null;
  /** tokens counted and the budget behind them — estimate source only */
  tokens: number | null;
  budget: number | null;
}

/** Header usage pill payload: the three metered windows plus current routing. */
export interface UsageSnapshot {
  /** the session/5h percentage — the figure the router threshold compares against */
  pct: number;
  threshold: number;
  routedModel: string;
  fiveHour: UsageWindow;
  week: UsageWindow;
  /** the weekly window scoped to fable-family models (their own weekly cap) */
  weekFable: UsageWindow;
  /** age of the CLI's account-usage cache, or null when none was usable */
  accountAgeMs: number | null;
}

// ---- Dispatches (docs/dispatch.md) ----

export type DispatchStatus = 'pending' | 'delivered' | 'failed' | 'cancelled';

/**
 * A message from one task's agent session to a RELATED task's agent session,
 * delivered by reopening the target's own claude session (`claude --resume`) —
 * no new task row, no fresh agent. The cheap coordination primitive: "backend
 * shipped, here's the contract, implement" goes to the frontend task's
 * existing agent instead of spawning task number three.
 *
 * `pending` until the target session is free (the orchestrator delivers on its
 * scheduling ticks); `delivered` once the resumed turn was actually started.
 * No FK constraints — like audit events, a dispatch outlives task deletion
 * (delivery to a deleted target settles it as `failed`).
 */
export interface Dispatch {
  id: string;
  /** task whose session sent it */
  fromTaskId: string;
  /** run that sent it (attribution; caps key off this) */
  fromRunId: string | null;
  /** task whose session receives it */
  toTaskId: string;
  message: string;
  status: DispatchStatus;
  /** why it failed / was downgraded — delivery details for the human */
  note: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export type ProposalKind = 'rewrite' | 'split' | 'new_task' | 'solution_options';
export type ProposalStatus = 'pending' | 'accepted' | 'rejected';

export interface ProposalSubtask {
  title: string;
  description: string;
}

export interface ProposalOption {
  label: string;
  approach: string;
  tradeoffs: string;
}

export interface ProposalPayload {
  title?: string;
  description?: string;
  rationale: string;
  subtasks?: ProposalSubtask[];
  options?: ProposalOption[];
}

export interface Proposal {
  id: string;
  runId: string | null;
  repoId: string | null;
  taskId: string | null; // null = proposes a brand-new task
  kind: ProposalKind;
  payload: ProposalPayload;
  status: ProposalStatus;
  createdAt: string;
}

/** What a click outside the terminal drawer does. */
export type TerminalClickOutside = 'close' | 'compact' | 'nothing';

// Runtime-tunable settings stored in tm_config (JSON values under these keys).
export interface AppSettings {
  'orchestrator.enabled': boolean;
  'orchestrator.concurrency': number;
  'orchestrator.autoComplete': boolean;
  /** WORKER model — the heavy implementation work (user policy 2026-08-24: opus) */
  'agent.model': string;
  'agent.effort': EffortLevel;
  /** analysis agent model (task triage/restructuring — fable) */
  'analysis.model': string;
  /** orchestrator-level reasoning (review/coordination agents — fable) */
  'orchestrator.model': string;
  /** Model routing: primary while estimated usage < threshold, else fallback.
   *  Tasks matching router.opusKeywords (tool/browser testing) always get the fallback. */
  'router.enabled': boolean;
  'router.primaryModel': string;
  'router.fallbackModel': string;
  'router.usageThresholdPct': number;
  /** trailing-5h token budget the usage % is estimated against (local transcripts) */
  'router.budget5hTokens': number;
  /** trailing-7d token budget behind the weekly usage ESTIMATE (fallback only) */
  'router.budgetWeekTokens': number;
  /** trailing-7d token budget for the fable weekly ESTIMATE (fallback only) */
  'router.budgetWeekFableTokens': number;
  'agent.permissionMode': 'acceptEdits' | 'auto' | 'bypassPermissions';
  'agent.allowedTools': string[];
  /** honor agents' enqueue:true (cross-repo coordination); OFF = agent tasks land as drafts */
  'agent.allowEnqueue': boolean;
  /** max follow-up tasks ONE worker session may file via the agent API (403 after) */
  'agent.taskCreationCap': number;
  /** tint each task group with its own colour on the Board */
  'board.groupColors': boolean;
  /** run an adversarial review of each worker's change before it lands in review */
  'review.enabled': boolean;
  /** reviewer model; falls back to Opus 5 xhigh when unavailable */
  'review.model': string;
  /** max work→review→work rounds before a task lands in the human review queue */
  'review.maxRounds': number;
  /** max feature-plan re-analysis rounds after a blocker verdict (mirrors review.maxRounds) */
  'feature.analysisMaxRounds': number;
  'anomaly.longRunMin': number;
  'anomaly.costUsd': number;
  'anomaly.staleReviewHours': number;
  'pty.scrollbackBytes': number;
  /** how long a finished (idle) or exited PTY stays attachable, in minutes; 0 = forever */
  'pty.sessionTtlMinutes': number;
  /** click outside the open terminal drawer: compact to a footer bar, close it, or ignore */
  'terminal.clickOutside': TerminalClickOutside;
  /** follow-ups continue the previous claude session (`--resume`) when one is
   *  still on disk, instead of respawning a fresh agent that lost its context */
  'agent.resumeSessions': boolean;
  'sentry.dsn': string;
  'sentry.authToken': string;
  'sentry.org': string;
  'sentry.project': string;
  /** EU-residency orgs use https://de.sentry.io */
  'sentry.apiBase': string;
  /** repo new sentry tasks are assigned to */
  'sentry.repoId': string;
  /** Sentry tag key whose value becomes the task category (blank = use issue level) */
  'sentry.categoryTag': string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  'orchestrator.enabled': false,
  'orchestrator.concurrency': 2,
  'orchestrator.autoComplete': false,
  // Role split (user policy 2026-08-24): opus does the heavy work, fable
  // tells it what to do and reviews.
  'agent.model': 'claude-opus-5',
  'agent.effort': 'high',
  'analysis.model': 'claude-fable-5',
  'orchestrator.model': 'claude-fable-5',
  // usage-based routing is superseded by the role split; keep it available
  // but off by default (task.model overrides always win either way)
  'router.enabled': false,
  'router.primaryModel': 'claude-fable-5',
  'router.fallbackModel': 'claude-opus-5',
  'router.usageThresholdPct': 85,
  'router.budget5hTokens': 2_000_000,
  // No official account API, so every budget here is a calibration knob, not a
  // published limit. Seeded at 10 saturated 5h sessions per week, a quarter of
  // that for fable — same undercounting metric as the 5h figure, so retune both
  // together if you recalibrate.
  'router.budgetWeekTokens': 20_000_000,
  'router.budgetWeekFableTokens': 5_000_000,
  // auto is the everyday mode (user decision 2026-08-24); acceptEdits is the
  // conservative fallback, bypassPermissions the loud red switch.
  'agent.permissionMode': 'auto',
  'agent.allowEnqueue': false,
  'agent.taskCreationCap': 15,
  'agent.allowedTools': [],
  'board.groupColors': true,
  'review.enabled': true,
  'review.model': 'claude-fable-5',
  'review.maxRounds': 2,
  'feature.analysisMaxRounds': 2,
  'anomaly.longRunMin': 30,
  'anomaly.costUsd': 10,
  'anomaly.staleReviewHours': 72,
  'pty.scrollbackBytes': 2 * 1024 * 1024,
  // 0 = never evict on age (user request 2026-08-25); the MAX_LIVE_SESSIONS
  // eviction still reclaims the oldest unwatched session under cap pressure.
  'pty.sessionTtlMinutes': 30,
  'terminal.clickOutside': 'compact',
  'agent.resumeSessions': true,
  'sentry.dsn': '',
  'sentry.authToken': '',
  'sentry.org': '',
  'sentry.project': '',
  'sentry.apiBase': 'https://sentry.io',
  'sentry.repoId': '',
  'sentry.categoryTag': '',
};

// ---- Features (big request → analysis → reviewed plan → approved tasks) ----

export type FeatureStatus =
  | 'draft'
  | 'analyzing'
  | 'proposed'
  | 'approved'
  | 'running'
  | 'paused'
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled';

/** One planned task card. Nothing exists as a tm_tasks row until approval. */
export interface FeaturePlanTask {
  /** stable client-side id so edits/reorders survive re-renders (not a task id) */
  id: string;
  title: string;
  description: string;
  category?: string | null;
  effort?: EffortLevel | null;
  /** per-task adversarial review override, mirrors Task.review */
  review?: boolean | null;
  exitCriteria: string[];
  /** excluded from approval (card toggled off) */
  excluded?: boolean;
}

export interface FeaturePlanPhase {
  title: string;
  goal: string;
  tasks: FeaturePlanTask[];
}

export interface FeaturePlan {
  summary: string;
  considerations: string[];
  phases: FeaturePlanPhase[];
}

export type PlanVerdict = 'clean' | 'minor' | 'blocker';

export interface PlanFinding {
  severity: 'blocker' | 'major' | 'minor';
  summary: string;
  detail: string | null;
}

/** One adversarial pass over one generated plan. */
export interface PlanReviewRound {
  round: number;
  verdict: PlanVerdict;
  findings: PlanFinding[];
  model: string;
  at: string;
}

export interface FeatureReview {
  rounds: PlanReviewRound[];
}

export interface Feature {
  id: string;
  repoId: string | null;
  title: string;
  /** the big request, markdown */
  request: string;
  status: FeatureStatus;
  /** latest (possibly user-edited) plan; null until the first analysis lands */
  analysis: FeaturePlan | null;
  /** adversarial plan-review rounds, newest last */
  review: FeatureReview | null;
  /** how many analysis rounds have run (bounded by feature.analysisMaxRounds) */
  analysisRounds: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---- Audit log ("nothing untraced") ----

export type AuditKind =
  | 'task.created'
  | 'task.transition'
  | 'task.edited'
  | 'task.follow-up'
  | 'task.dispatch'
  | 'task.publish'
  | 'run.reviewed'
  | 'task.deleted'
  | 'run.started'
  | 'run.killed'
  | 'run.attention'
  | 'run.stats-final'
  | 'proposal.created'
  | 'proposal.decided'
  | 'feature.created'
  | 'feature.transition'
  | 'feature.edited'
  | 'feature.analyzed'
  | 'repo.changed'
  | 'command.changed'
  | 'command.run'
  | 'config.changed'
  | 'orchestrator.toggle'
  | 'schedule.overflow-claim'
  | 'schedule.spawn-fail'
  | 'boot.recovery'
  | 'agent.create'
  | 'sentry.sync';

/** actor: human | hook | orchestrator | system | analyze | agent:<runId8> */
export interface AuditEvent {
  id: string; // time-sortable (ms hex prefix + random)
  at: string;
  kind: AuditKind;
  actor: string;
  taskId: string | null;
  runId: string | null;
  repoId: string | null;
  data: Record<string, unknown> | null;
}

// Deliberately untraced: terminal keystrokes/output (privacy + volume — the
// agent side is already in claude transcripts) and page views (not actions).

export interface StatsOverview {
  totals: {
    workedMs: number;
    costUsd: number;
    tokens: number;
    runs: number;
    tasksDone: number;
    tasksFailed: number;
    avgCtxPct: number;
    maxCtxPct: number;
    attentionEvents: number;
    agentFiledTasks: number;
    overflowClaims: number;
  };
  perDay: { date: string; workerRuns: number; analyzeRuns: number; workedMs: number; costUsd: number; done: number; failed: number }[];
  perRepo: { repoId: string; name: string; runs: number; costUsd: number; done: number; failed: number }[];
  perModel: { model: string; runs: number; costUsd: number; tokens: number }[];
  depth: { depth: number; count: number }[];
  byActor: { actor: string; events: number }[];
}

export type AnomalySeverity = 'info' | 'warn' | 'critical';

export interface Anomaly {
  severity: AnomalySeverity;
  kind: string;
  message: string;
  taskId?: string;
  runId?: string;
  at?: string;
}

// ---- WebSocket protocol ----

// /ws/terminal/:runId
export type TerminalServerMsg =
  | { type: 'history'; data: string } // base64 of raw ring buffer
  | { type: 'data'; data: string } // base64 chunk
  | { type: 'exit'; code: number | null };

export type TerminalClientMsg =
  | { type: 'input'; data: string } // base64
  | { type: 'resize'; cols: number; rows: number };

// /ws/events
export interface OrchestratorStatus {
  enabled: boolean;
  /** live non-idle worker PTYs — the concurrency numerator */
  running: number;
  concurrency: number;
  /**
   * Headless `claude -p` agents alive right now (analysis, adversarial review,
   * feature planning). They own no PTY, so they are invisible to `running` —
   * but a restart kills them just the same, which is why the restart guard
   * counts them too. A server predating this field simply omits it.
   */
  headless: number;
}

/**
 * What a live agent is doing right now, in one line — the last thing that
 * showed up in its terminal (a tool call or its own narration), lifted out of
 * the session transcript so the Board can be eyeballed without attaching.
 */
export interface RunActivity {
  runId: string;
  taskId: string | null;
  /** one-line description; null means "no longer live" — drop the entry */
  text: string | null;
  /** 'tool' = an action it took, 'text' = something it said */
  kind: 'tool' | 'text';
  /** ISO time the line was produced */
  at: string;
}

export type ServerEvent =
  | { type: 'task.updated'; task: Task }
  | { type: 'task.deleted'; taskId: string }
  | { type: 'run.started'; run: Run }
  | { type: 'run.updated'; run: Run }
  | { type: 'run.exited'; run: Run }
  | { type: 'run.needs-attention'; run: Run }
  | { type: 'run.activity'; activity: RunActivity }
  | { type: 'proposal.created'; proposal: Proposal }
  | { type: 'dispatch.updated'; dispatch: Dispatch }
  | { type: 'feature.updated'; feature: Feature }
  | { type: 'feature.deleted'; featureId: string }
  | { type: 'event.appended'; event: AuditEvent }
  | { type: 'command.updated'; command: RepoCommand }
  | { type: 'command.deleted'; commandId: string }
  | { type: 'command.run'; run: CommandRun }
  | { type: 'orchestrator.status'; status: OrchestratorStatus };

/**
 * What the front door (docs/host.md) reports about the API it is proxying.
 * The front door is a SEPARATE process from the API: it serves the page and
 * supervises the server, so it is the one thing still answering when the API
 * is down — which is exactly when the UI needs to offer to start it.
 */
export interface HostStatus {
  api: {
    up: boolean;
    /** false when the API was already listening and got adopted — we can proxy
     *  to it and ask it to restart itself, but we cannot respawn it. */
    managed: boolean;
    pid: number | null;
    port: number;
    bootedAt: string | null;
    /** how many times the supervisor has brought it back since ITS boot */
    restarts: number;
    desired: 'up' | 'down';
    lastExit: { code: number | null; signal: string | null; at: string } | null;
    lastError: string | null;
  };
  host: { port: number; dev: boolean; spaBuilt: boolean };
}
