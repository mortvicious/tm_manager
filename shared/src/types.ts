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
export type ReviewState = 'pending' | 'reviewing' | 'fixing' | 'passed' | 'flagged' | 'skipped' | 'error';

export type ReviewVerdict = 'clean' | 'concerns' | 'blocker';

export interface ReviewFinding {
  severity: 'blocker' | 'major' | 'minor';
  summary: string;
  detail: string | null;
}

/** One adversarial review of a task's diff (docs/design.md § Adversarial review). */
export interface ReviewRound {
  /** 1-based, in the order the task received them */
  round: number;
  /** ISO time the verdict landed */
  at: string;
  model: string;
  effort: string | null;
  verdict: ReviewVerdict;
  /** the reviewer's overall reading of the work as it stands */
  summary: string | null;
  findings: ReviewFinding[];
  /** 0 = the original change; n = the n-th fix round the reviewer sent back */
  fixRound: number;
  /** sha256 of the diff this round judged */
  diffHash: string | null;
  /** set when the reviewer could not run — `verdict` is then `concerns` by convention */
  error: string | null;
}

/** States in which the reviewer has finished with the current change. */
export const SETTLED_REVIEW_STATES: ReviewState[] = ['passed', 'flagged', 'skipped', 'error'];

export const TERMINAL_TASK_STATUSES: TaskStatus[] = ['published', 'done', 'failed', 'cancelled'];

export type TaskSource = 'manual' | 'sentry' | 'auto' | 'feature';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// Dropdown suggestions; agent.model / task.model accept any model id string.
// Claude-only on purpose: these back the CONFIG-level model settings
// (agent/analysis/orchestrator/review/router.*), which all run through
// `claude -p` or the hooked worker session — never offer a codex id here, only
// a per-task override (TASK_PRESETS 'codexFree') opts a single task in.
export const MODEL_OPTIONS = [
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
];

/**
 * A task whose `model` names the OpenAI Codex CLI instead of a Claude model —
 * `buildWorkerInvocation` (server/src/claude/worker.ts) branches on this to
 * spawn `codex exec` instead of `claude`. Any `codex...` id counts, so a task
 * can pin a specific Codex model (`codex-o4-mini`) without a second field.
 */
export function isCodexModel(model: string | null | undefined): boolean {
  return !!model && model.startsWith('codex');
}

/**
 * One-click bundles of the three per-task overrides (model / effort /
 * adversarial review), offered on the new-task form and the task panel so the
 * common cases are one click instead of three dropdowns.
 *
 * `review: null` means "leave it to the `review.enabled` setting" — the same
 * value the dropdown's "default (config)" option writes.
 */
export interface TaskPreset {
  id: 'small' | 'routine' | 'complex' | 'codexFree';
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
    hint: 'fable 5.1 · high · review',
    model: 'claude-fable-5-1',
    effort: 'high',
    review: true,
  },
  // Runs `codex exec` (OpenAI Codex CLI) instead of `claude` — see
  // isCodexModel/buildWorkerInvocation. "free" = ChatGPT-account auth, not an
  // OPENAI_API_KEY, so it costs nothing beyond the plan the user already pays
  // for; review defaults ON because this path has no adversarial-review model
  // parity checks yet and no completion hooks (exit code only).
  {
    id: 'codexFree',
    label: 'Codex (free)',
    hint: 'codex · free tier · review',
    model: 'codex-free',
    effort: 'medium',
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
 * A plain interactive shell in a repo's directory (docs/terminals.md) — the
 * user's login shell in a real PTY, nothing else: no claude, no task, no saved
 * command. Like CommandRun it is in-memory only (never a `tm_runs` row) and
 * lives in its OWN SessionManager pool, so it never counts against agent
 * concurrency. Kept in the list after its shell exits until the user closes it.
 */
export type ShellSessionStatus = 'running' | 'exited' | 'killed';

export interface ShellSession {
  /** also the PTY session id — attach at /ws/terminal/:id */
  id: string;
  repoId: string;
  /** snapshotted so the tab still renders after the repo is gone */
  repoName: string;
  /** "zsh 2": the shell's basename + the lowest number free in this repo */
  title: string;
  /** 1-based, unique among this repo's open shells */
  index: number;
  cwd: string;
  /** absolute path of the shell binary */
  shell: string;
  status: ShellSessionStatus;
  pid: number | null;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
}

/** Open shells (any repo, live or exited-but-not-closed) the server keeps at once. */
export const MAX_SHELL_SESSIONS = 10;

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
  /**
   * Membership in the custom queue (docs/queue.md): set when a human clicks
   * "Add to queue", ISO time of that click = FIFO position. The custom queue
   * runs independently of the global `orchestrator.enabled` switch, strictly
   * ONE task at a time — so one repo works at once and tasks from the same
   * repo wait. null = not in the custom queue (the global queue, if ever).
   */
  customQueueAt: string | null;
  /** adversarial review of the worker's change (Fable, or Opus xhigh fallback) */
  reviewSummary: string | null;
  /**
   * sha256 of the `git diff HEAD` that produced `reviewSummary`. A later Stop
   * whose diff hashes identically changed no code (a dispatch reply, a
   * question answered, a follow-up that only talked), so the reviewer is
   * skipped and the previous verdict stands. null = never reviewed.
   */
  reviewDiffHash: string | null;
  /**
   * Where the adversarial review of the CURRENT change stands (docs/design.md
   * § Adversarial review). Written in the same row write as the status it
   * qualifies, so no surface can see `review` without knowing whether the
   * reviewer has spoken yet:
   *  - `pending`   the Stop landed, the reviewer has not started
   *  - `reviewing` the headless reviewer is reading the diff
   *  - `fixing`    findings were handed back; the task is `running` on them
   *  - `passed`    latest round has no blocker/major finding
   *  - `flagged`   latest round has blocker/major findings and the loop ended
   *  - `skipped`   nothing to review (clean tree)
   *  - `error`     the reviewer could not run
   *  - null        this change was not auto-reviewed (disabled, publish, ...)
   */
  reviewState: ReviewState | null;
  /** every real review this task received, oldest first (skips are audit-only) */
  reviewRounds: ReviewRound[];
  /**
   * ISO time the 5h usage window this task is waiting on resets. Set when a
   * turn ended against the account limit rather than against the work, and
   * the orchestrator resumes the task's OWN claude session at it, clearing
   * the field (docs/wake.md). null = not waiting on usage.
   */
  wakeAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Custom queue (docs/queue.md): statuses in which a member still owns its
 * repo's working tree, so the next same-repo member must wait. Twin of the
 * in-flight predicate in server/src/storage/queue-sql.ts — edit together.
 */
export const CUSTOM_QUEUE_IN_FLIGHT_STATUSES: readonly TaskStatus[] = ['running', 'review', 'blocked'];

/**
 * Members of the custom queue (docs/queue.md) that are still WAITING, in the
 * order they will run: FIFO by the moment each was added. `transitionTask`
 * clears `custom_queue_at` only on a terminal status, so a `running`, `review`
 * or `blocked` member keeps its mark — by design, it still holds its repo's
 * place — but it is no longer waiting and must not be counted in the position.
 *
 * Shared rather than duplicated: the board's `queue #n` chip and the Telegram
 * bot's `/task` and `/queue` both derive their ordinal from this, so the two
 * surfaces cannot tell the same task a different number.
 */
export function customQueueWaiting(tasks: Task[]): Task[] {
  return tasks
    .filter((t) => t.status === 'queued' && !!t.customQueueAt)
    .sort((a, b) => a.customQueueAt!.localeCompare(b.customQueueAt!) || a.createdAt.localeCompare(b.createdAt));
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
  /**
   * Raw last-turn context total in tokens (input + cache read + cache write +
   * output of the last main-chain message). `contextPct` divides this by a
   * fixed 200k and clamps at 100, which pins every real worker session — they
   * run on a 1M window and reach 400–500k — at "100%". The resume gate
   * (`agent.resumeContextCap`, docs/token-budget.md) needs the number, not the
   * clamp. Absent on run rows written before this field existed; read `?? 0`.
   */
  contextTokens: number;
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

// ---- Questions (docs/questions.md) ----

export type QuestionStatus = 'pending' | 'answered' | 'expired';

export interface QuestionOption {
  label: string;
  description: string;
}

/** One question of an AskUserQuestion call — the CLI's own shape, kept verbatim
 *  so the answered input can be handed back to the tool unchanged. */
export interface QuestionItem {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/**
 * A decision a worker agent handed to the human (docs/questions.md): the
 * agent's `AskUserQuestion` call, intercepted by a PreToolUse hook and parked
 * here while the session waits inside that hook. Answered from the SPA or
 * from Telegram — whichever comes first — and handed back to the tool as its
 * `answers`. No FK constraints, like dispatches: the row is the audit trail of
 * what was asked and what was decided, and it outlives the task.
 */
export interface Question {
  id: string;
  taskId: string;
  runId: string;
  /** the CLI's `tool_use_id` — what makes a re-sent hook request idempotent */
  toolUseId: string | null;
  status: QuestionStatus;
  questions: QuestionItem[];
  /** keyed by the question TEXT, as the CLI expects; multi-select joins labels with ", " */
  answers: Record<string, string> | null;
  /** actor vocabulary of tm_events: human | telegram */
  answeredBy: string | null;
  /** why an `expired` row expired (run ended, cancelled, restart) */
  note: string | null;
  createdAt: string;
  answeredAt: string | null;
}

// ---- Dispatches (docs/dispatch.md) ----

export type DispatchStatus = 'pending' | 'delivered' | 'failed' | 'cancelled';

/**
 * What the sender is asking for — the field that decides whether delivery may
 * WAKE a session (docs/dispatch.md § Intent, token audit 2026-08-31..09-01).
 *
 * - `needs_action`: the target must change something. Delivery resumes its
 *   session as soon as it is free, exactly as dispatch has always worked.
 * - `fyi`: facts, answers, corrections — nothing for the target to do right
 *   now. It NEVER starts a turn of its own. It waits and rides along at the
 *   start of the target's next resume for a real reason (review round,
 *   Proceed, a `needs_action` dispatch, publish); if the target is already
 *   terminal it is recorded as a note on the task and no session is opened.
 *
 * A resume re-writes the whole conversation to cache before the agent's first
 * useful token (~$15 on a 400k session) and its reply then Stops into an
 * adversarial review — far too much for a status report.
 */
export type DispatchIntent = 'needs_action' | 'fyi';

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
  /** whether delivery may wake an idle session (`fyi` may not) */
  intent: DispatchIntent;
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
  /**
   * max work→review→work rounds before a task lands in the human review queue.
   * Default 1: every extra round resumes a warm 300–500k-token session, and
   * the token audit found round 2+ almost never actionable (docs/design.md).
   */
  'review.maxRounds': number;
  /** max feature-plan re-analysis rounds after a blocker verdict (plan review, not diff review — independent of review.maxRounds) */
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
  /**
   * Last-turn context (tokens) above which resuming a session compacts it
   * first (`claude -p --resume <id> "/compact <focus>"`) instead of re-writing
   * the whole conversation to cache twice. 0 disables the gate — every resume
   * is a plain `--resume`, the behaviour before docs/token-budget.md § The
   * fourth. Applies ONLY when an idle session is about to be resumed, never
   * mid-run.
   */
  'agent.resumeContextCap': number;
  /** a turn that ended against the 5h usage limit is resumed automatically
   *  when the window resets, in its own session (docs/wake.md) */
  'agent.autoWake': boolean;
  /** seconds to wait past the window's reset time before resuming — the
   *  account's `resets_at` is the boundary, not a promise of capacity at it */
  'agent.autoWakeGraceSec': number;
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
  /**
   * Telegram long-polling cursor (docs/telegram.md) — bot STATE, not a knob.
   * It lives here because tm_config is the only key/value table there is, and
   * the offset has to survive a restart or every pending update replays.
   * Deliberately absent from the PUT /api/config schema: the settings page
   * sends only keys it changed, so nothing in the UI can clobber it.
   */
  'telegram.updateOffset': number;
  /**
   * Local calendar day (YYYY-MM-DD) the daily digest last went out. Bot state,
   * so it lives here and not in config.json: it changes once a day on its own,
   * and rewriting the file that holds the bot token on a timer is not a trade
   * worth making. Empty = never sent.
   *
   * It is a DAY and not a timestamp because that is what makes the digest both
   * idempotent across a restart and catch-up-capable after the Mac slept
   * through the configured hour.
   *
   * Deliberately absent from the PUT /api/config schema, like the offset above.
   */
  'telegram.digestSentOn': string;
  /**
   * ISO instant at which the digest's current (`enabled`, `hour`) pairing
   * became active. A slot only counts if the digest was already armed with
   * that hour when the slot arrived — which is what makes re-timing the digest
   * from a phone neither skip a day nor fire twice in one.
   *
   * Persisted rather than reset at boot: re-arming on every restart would
   * cancel a catch-up that was owed for an hour the machine slept through.
   * Deliberately absent from the PUT /api/config schema, like the two above.
   */
  'telegram.digestArmedAt': string;
  /**
   * The chat (docs/chat.md) the phone is currently talking to — bot STATE, and
   * the reason it is persisted rather than held in memory next to the flows:
   * chat mode is not a ten-minute wizard, it is a mode you leave on. If a
   * restart silently dropped it, the next thing typed would stop being a chat
   * message and start being an offer to file a task, which is exactly the
   * surprise the explicit /endchat exists to avoid. Empty = not in chat mode.
   * Deliberately absent from the PUT /api/config schema, like the keys above.
   */
  'telegram.activeChatId': string;
  /** Default model for a new chat. Its own key rather than a borrow of
   *  `agent.model`: a chat is a conversation, not a task, and wanting the
   *  cheap model for one and the heavy model for the other is the normal case. */
  'chat.model': string;
  'chat.effort': EffortLevel;
  /** Concurrent chat turns across ALL chats. Chats are serial per chat by
   *  construction; this is the second fence, against opening six chats and
   *  sending to all of them. Separate from `orchestrator.concurrency` on
   *  purpose — a chat turn owns no task and must not eat a worker slot. */
  'chat.concurrency': number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  'orchestrator.enabled': false,
  'orchestrator.concurrency': 2,
  'orchestrator.autoComplete': false,
  // Role split (user policy 2026-08-24): opus does the heavy work, fable
  // tells it what to do and reviews.
  'agent.model': 'claude-opus-5',
  'agent.effort': 'high',
  'analysis.model': 'claude-fable-5-1',
  'orchestrator.model': 'claude-fable-5-1',
  // usage-based routing is superseded by the role split; keep it available
  // but off by default (task.model overrides always win either way)
  'router.enabled': false,
  'router.primaryModel': 'claude-fable-5-1',
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
  'review.model': 'claude-fable-5-1',
  'review.maxRounds': 1,
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
  // 300k: the user's own measurement is that good work still comes out of a
  // ~300k session, so the cap sits where quality is not yet in question and
  // only the re-write cost is.
  'agent.resumeContextCap': 300_000,
  'agent.autoWake': true,
  // A minute past the stated reset: the boundary is the account's, and a
  // resume that arrives a second early buys nothing but a second stall.
  'agent.autoWakeGraceSec': 60,
  'sentry.dsn': '',
  'sentry.authToken': '',
  'sentry.org': '',
  'sentry.project': '',
  'sentry.apiBase': 'https://sentry.io',
  'sentry.repoId': '',
  'sentry.categoryTag': '',
  'telegram.updateOffset': 0,
  'telegram.digestSentOn': '',
  'telegram.digestArmedAt': '',
  'telegram.activeChatId': '',
  'chat.model': 'claude-opus-5',
  'chat.effort': 'high',
  'chat.concurrency': 2,
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
  /** custom queue membership changed by a human (docs/queue.md) */
  | 'task.queue'
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
  | 'shell.session'
  | 'config.changed'
  | 'orchestrator.toggle'
  | 'schedule.overflow-claim'
  | 'schedule.spawn-fail'
  | 'boot.recovery'
  | 'agent.create'
  /** an agent closed a parked task as done/cancelled without a run (docs/agent-api-design.md § Close and move) */
  | 'agent.close'
  | 'sentry.sync'
  /** a tailnet login passed the front door's remote gate for the first time this front-door boot (docs/remote-access.md) */
  | 'remote.login'
  /** a command the Telegram bot handled for the allowlisted owner */
  | 'telegram.command'
  /** periodic SUMMARY of updates the single-user gate dropped — deliberately
   *  not one row per update, or anyone who knows the bot's name could write to
   *  this table at will (docs/telegram.md) */
  | 'telegram.rejected'
  /** bot lifecycle: started (with the boot-discard count) / stopped */
  | 'telegram.bot'
  /** the red button fired: the exact run ids / task ids / feature ids it took
   *  down, so "what killed my session?" has one row to read (docs/telegram.md) */
  | 'telegram.killall'
  /** a restart the bot asked the front door for, with the guard's verdict */
  | 'telegram.restart'
  /** a chat was opened / renamed / retargeted / deleted (docs/chat.md) */
  | 'chat.created'
  | 'chat.edited'
  | 'chat.deleted'
  /** one chat turn: the prompt went out and the reply (or the failure) landed */
  | 'chat.turn'
  /** a turn parked on the 5h usage window, or resumed when it reopened (docs/wake.md) */
  | 'task.wake'
  /** a worker's AskUserQuestion reached the human / was answered / expired (docs/questions.md) */
  | 'question.asked'
  | 'question.answered'
  | 'question.expired';

/** actor: human | hook | orchestrator | system | analyze | telegram | remote | agent:<runId8> */
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

// ---- Chat (docs/chat.md) ----

/**
 * What a chat turn may do in the repo it is pointed at. `read` is the default
 * and the one a new chat gets: the same `--disallowedTools Edit Write
 * NotebookEdit Bash` the analysis and review runs use, so a chat cannot change
 * a working tree an agent may be mid-task in. `write` is the "same as sitting
 * in the terminal" mode and is opted into per chat.
 */
export type ChatMode = 'read' | 'write';
export const CHAT_MODES: ChatMode[] = ['read', 'write'];


/**
 * `thinking` is held for exactly one turn and is what makes a chat serial —
 * two surfaces sending at once must not put two `claude -p` children on one
 * session id. `error` is a turn that failed; the chat is still usable and the
 * next send clears it.
 */
export type ChatStatus = 'idle' | 'thinking' | 'error';

/**
 * A free-form conversation with claude in a repo's working directory —
 * the terminal you would have opened yourself, held open across surfaces
 * (docs/chat.md). Every turn is a headless `claude -p --resume <sessionId>`
 * run, which is what lets the phone and the browser take turns in ONE
 * conversation instead of each getting their own.
 */
export interface Chat {
  id: string;
  repoId: string;
  title: string;
  model: string;
  effort: EffortLevel | null;
  mode: ChatMode;
  /** claude's own session id, captured from the first turn's result envelope;
   *  null until that turn lands, which is why turn one carries no `--resume` */
  sessionId: string | null;
  status: ChatStatus;
  /** why the last turn failed; cleared when the next one starts */
  error: string | null;
  /**
   * The pid of the turn running right now, and null whenever one is not.
   *
   * Persisted rather than kept in memory because it is needed by the process
   * AFTER this one: a chat turn owns no `tm_runs` row, so boot recovery's pid
   * sweep cannot see it, and the child is spawned detached — a crash leaves it
   * alive, still editing the repo in write mode. Without this column the next
   * boot would clear the lock and the next message would put a SECOND
   * `--resume` on the same session id alongside the orphan.
   */
  pid: number | null;
  /** completed turns (a failed turn does not count) */
  turns: number;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
  /** last message in either direction — the list's sort key */
  lastMessageAt: string | null;
}

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  chatId: string;
  role: ChatRole;
  text: string;
  /** who sent it: 'human' from the SPA, 'telegram' from the phone, 'claude'
   *  for a reply — the same actor vocabulary tm_events uses */
  actor: string;
  /** set on an assistant message that is the record of a FAILED turn */
  error: string | null;
  costUsd: number;
  durationMs: number | null;
  createdAt: string;
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
  | { type: 'shell.session'; session: ShellSession }
  | { type: 'shell.closed'; id: string }
  | { type: 'chat.updated'; chat: Chat }
  | { type: 'chat.deleted'; chatId: string }
  | { type: 'chat.message'; message: ChatMessage }
  | { type: 'question.updated'; question: Question }
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

// ---- Web Push (docs/push.md) ----

/** What a Home Screen device can be pinged about; chosen per device. */
export type PushKind =
  | 'question'
  | 'attention'
  | 'review'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'published'
  | 'started'
  | 'proposal'
  | 'feature'
  | 'chat'
  | 'report'
  | 'queue';

/** The one list every surface renders (SPA toggles, server validation, defaults). */
export const PUSH_KINDS: { kind: PushKind; label: string; hint: string; default: boolean }[] = [
  { kind: 'question', label: 'Questions', hint: 'an agent asks you something (AskUserQuestion)', default: true },
  { kind: 'attention', label: 'Needs attention', hint: 'an agent is stuck on a prompt in its hidden terminal', default: true },
  { kind: 'review', label: 'Ready for review', hint: 'a task landed in review, with the reviewer’s verdict', default: true },
  { kind: 'done', label: 'Done', hint: 'a task finished straight to done (auto-complete)', default: true },
  { kind: 'failed', label: 'Failed', hint: 'a task failed', default: true },
  { kind: 'blocked', label: 'Blocked', hint: 'a task is waiting on its subtasks', default: true },
  { kind: 'published', label: 'Published', hint: 'a task was committed and pushed', default: true },
  { kind: 'started', label: 'Started', hint: 'an agent picked a task up', default: false },
  { kind: 'proposal', label: 'Proposals', hint: 'an agent proposed a split or follow-up', default: true },
  { kind: 'feature', label: 'Features', hint: 'a feature plan is ready to approve, or a feature paused', default: true },
  { kind: 'chat', label: 'Chat replies', hint: 'claude answered in a chat', default: true },
  { kind: 'report', label: 'Reports', hint: 'a client report finished or failed', default: true },
  { kind: 'queue', label: 'Queue drained', hint: 'nothing queued, nothing running', default: true },
];

export const DEFAULT_PUSH_KINDS: PushKind[] = PUSH_KINDS.filter((k) => k.default).map((k) => k.kind);

/** A subscribed browser, as the SPA sees it — never the keys. */
export interface PushDevice {
  id: string;
  /** the push service's host (web.push.apple.com, fcm.googleapis.com, …) */
  service: string;
  /** "iPhone", "Mac — Safari"… — set by the SPA at subscribe time, editable */
  label: string;
  kinds: PushKind[];
  createdAt: string;
  lastOkAt: string | null;
  lastError: string | null;
  /** consecutive failed sends; reset by a success */
  failCount: number;
}

export interface PushStatus {
  enabled: boolean;
  /** base64url VAPID public key — the SPA's applicationServerKey; null when disabled */
  publicKey: string | null;
  devices: PushDevice[];
}

/** The JSON inside every push message; public/sw.js renders it. */
export interface PushMessage {
  title: string;
  body: string;
  /** same tag replaces the earlier notification (one per task / question) */
  tag: string;
  /** in-app path the click opens, e.g. `/?task=<id>` */
  url: string;
  kind: PushKind | 'test';
}
