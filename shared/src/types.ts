// Entities and wire protocol shared between server and web.

export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'blocked'
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled';

export type TaskSource = 'manual' | 'sentry' | 'auto';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// Dropdown suggestions; agent.model / task.model accept any model id string.
export const MODEL_OPTIONS = ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];

export interface Repo {
  id: string;
  name: string;
  path: string; // absolute; ~ expanded on insert
  role: string | null; // free note: "backend", "frontend", ...
  createdAt: string;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  repoId: string | null;
  parentId: string | null;
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
  resultSummary: string | null;
  /** per-task adversarial review override: null = use review.enabled setting */
  review: boolean | null;
  /** adversarial review of the worker's change (Fable, or Opus xhigh fallback) */
  reviewSummary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
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
  startedAt: string;
  endedAt: string | null;
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
  'agent.permissionMode': 'acceptEdits' | 'auto' | 'bypassPermissions';
  'agent.allowedTools': string[];
  /** honor agents' enqueue:true (cross-repo coordination); OFF = agent tasks land as drafts */
  'agent.allowEnqueue': boolean;
  /** run an adversarial review of each worker's change before it lands in review */
  'review.enabled': boolean;
  /** reviewer model; falls back to Opus 5 xhigh when unavailable */
  'review.model': string;
  /** max work→review→work rounds before a task lands in the human review queue */
  'review.maxRounds': number;
  'anomaly.longRunMin': number;
  'anomaly.costUsd': number;
  'anomaly.staleReviewHours': number;
  'pty.scrollbackBytes': number;
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
  // auto is the everyday mode (user decision 2026-08-24); acceptEdits is the
  // conservative fallback, bypassPermissions the loud red switch.
  'agent.permissionMode': 'auto',
  'agent.allowEnqueue': false,
  'agent.allowedTools': [],
  'review.enabled': true,
  'review.model': 'claude-fable-5',
  'review.maxRounds': 2,
  'anomaly.longRunMin': 30,
  'anomaly.costUsd': 10,
  'anomaly.staleReviewHours': 72,
  'pty.scrollbackBytes': 2 * 1024 * 1024,
  'sentry.dsn': '',
  'sentry.authToken': '',
  'sentry.org': '',
  'sentry.project': '',
  'sentry.apiBase': 'https://sentry.io',
  'sentry.repoId': '',
  'sentry.categoryTag': '',
};

// ---- Audit log ("nothing untraced") ----

export type AuditKind =
  | 'task.created'
  | 'task.transition'
  | 'task.edited'
  | 'task.follow-up'
  | 'run.reviewed'
  | 'task.deleted'
  | 'run.started'
  | 'run.killed'
  | 'run.attention'
  | 'run.stats-final'
  | 'proposal.created'
  | 'proposal.decided'
  | 'repo.changed'
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
  running: number;
  concurrency: number;
}

export type ServerEvent =
  | { type: 'task.updated'; task: Task }
  | { type: 'task.deleted'; taskId: string }
  | { type: 'run.started'; run: Run }
  | { type: 'run.updated'; run: Run }
  | { type: 'run.exited'; run: Run }
  | { type: 'run.needs-attention'; run: Run }
  | { type: 'proposal.created'; proposal: Proposal }
  | { type: 'event.appended'; event: AuditEvent }
  | { type: 'orchestrator.status'; status: OrchestratorStatus };
