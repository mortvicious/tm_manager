// Entities and wire protocol shared between server and web.

export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'running'
  /**
   * The agent ended its turn with work of its own still in flight — a
   * background subagent it launched — so the session is NOT finished: the CLI
   * re-invokes it when that child returns. Its PTY stays live and non-idle
   * (it keeps its worker slot and its repo), nothing is reviewed, and the task
   * returns to `running` on the child's stop or the next transcript line
   * (docs/design.md § Waiting).
   */
  | 'waiting'
  | 'blocked'
  | 'review'
  /** committed and pushed by the agent that did the work (docs/publish.md) */
  | 'published'
  | 'done'
  | 'failed'
  | 'cancelled';

export type ReviewState = 'pending' | 'reviewing' | 'fixing' | 'passed' | 'flagged' | 'skipped' | 'error';

export type ReviewVerdict = 'clean' | 'concerns' | 'blocker';

/**
 * Where the repo checks of the CURRENT change stand (docs/checks.md). Like
 * `ReviewState`, a qualifier on the row, never a status:
 *  - `pending`  the Stop landed, the checks have not started
 *  - `running`  the checks are running in the commands pool
 *  - `green`    every selected check exited 0
 *  - `red`      a check failed and the fix loop ended (or is fixing: `running` task)
 *  - `error`    a check could not give a verdict (timed out, could not start)
 *  - null       no checks apply to this change (none configured, publish, auto-publish)
 */
export type CheckState = 'pending' | 'running' | 'green' | 'red' | 'error';

/** States in which the checks of the current change are still to come or in flight. */
export const CHECK_BUSY_STATES: CheckState[] = ['pending', 'running'];

/** One check's latest result (docs/checks.md), as stored in `tm_tasks.check_results`. */
export interface CheckResult {
  /** the check command's name — what `Task.checks` selects by */
  name: string;
  /** the command line that ran */
  command: string;
  /** process exit code; null = no exit to report (timed out, could not start) */
  exit: number | null;
  durationMs: number;
  /** green | red | error, per check */
  outcome: 'green' | 'red' | 'error';
  /** why an `error` (timeout, spawn failure); null otherwise */
  error: string | null;
  /** a red that was re-run once before it counted (flaky guard); `flaky` = the re-run was green */
  retried: boolean;
  /** last ~80 lines of the output, ANSI stripped */
  tail: string;
  /** the commands-pool run id (attachable while its PTY is kept) */
  runId: string | null;
}

export interface ReviewFinding {
  severity: 'blocker' | 'major' | 'minor';
  summary: string;
  detail: string | null;
}

/**
 * A fix round's verdict on one finding the previous round sent back
 * (docs/design.md § Adversarial review — convergent fix rounds). Only
 * blocker/major findings are carried into a fix round, so only they get one.
 */
export interface ReviewResolution {
  severity: 'blocker' | 'major';
  summary: string;
  /** `unresolved` also when the reviewer did not say — an open finding is never dropped by omission */
  status: 'resolved' | 'unresolved';
  note: string | null;
}

/** Files touched and lines added/removed by a change — counted off the reviewed diff text. */
export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
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
  /** size of that diff (docs/inbox.md); absent on rounds recorded before it was kept */
  diffStat?: DiffStat;
  /** set when the reviewer could not run — `verdict` is then `concerns` by convention */
  error: string | null;
  /** fix rounds only: what became of each blocker/major finding the previous round sent back */
  resolutions?: ReviewResolution[];
  /** per-file digest of the reviewed diff (`fileDigests`), so the next round can be told what changed since */
  files?: Record<string, string>;
  /** the task's commit shas this round saw, oldest first */
  commits?: string[];
  /** who asked for this round with "Review now" (`human` | `telegram`); null/absent
   *  for the automatic round after a Stop, and for a requested round that a
   *  restart re-ran (the requester lives in memory only) */
  requestedBy?: string | null;
}

/** States in which the reviewer has finished with the current change. */
export const SETTLED_REVIEW_STATES: ReviewState[] = ['passed', 'flagged', 'skipped', 'error'];

/**
 * Statuses "Review now" accepts (docs/design.md § Adversarial review): a task
 * that is parked with a change to judge. Never `running`/`waiting` (the diff is
 * half-written), `queued`/`draft` (no work yet) or `cancelled`/`published`.
 */
export const REVIEW_NOW_FROM: TaskStatus[] = ['review', 'done', 'blocked', 'failed'];

/** Review states in which a round is queued, running, or being fixed — "Review now" is refused/disabled. */
export const REVIEW_BUSY_STATES: ReviewState[] = ['pending', 'reviewing', 'fixing'];

/**
 * Statuses that end a task's life. `published` joins `done` here: everything
 * that waits on a task (a split parent, a feature phase gate) must treat a
 * pushed task as settled, not as still-open work.
 */
export const TERMINAL_TASK_STATUSES: TaskStatus[] = ['published', 'done', 'failed', 'cancelled'];

export type TaskSource = 'manual' | 'sentry' | 'auto' | 'feature';

/**
 * How far a finished task may go without a human (docs/design.md § Landing
 * tiers). A repo setting (`Repo.landing`), overridable per task
 * (`Task.landing`, null = the repo's):
 * - `supervised`: the task stops in `review` for the human (the default).
 * - `on-green`: after the checks and the review round, a task whose checks are
 *   green (or none apply) and whose final verdict has no blocker/major
 *   finding moves `review → done` on its own. Local commits only: the human
 *   publishes.
 * - `auto-publish`: the same gate, and then the task's own session publishes
 *   (docs/publish.md) — `review → published`.
 * An external task (`isExternalTask`) never resolves above `supervised`.
 */
export type LandingTier = 'supervised' | 'on-green' | 'auto-publish';
export const LANDING_TIERS: LandingTier[] = ['supervised', 'on-green', 'auto-publish'];

/**
 * A task whose text came from outside the human's own words — a Sentry
 * import, a proposal/analysis result, a shared-space filing, anything an agent
 * filed — and any FUTURE source (schedules, intake): only `manual` and
 * `feature` (a plan the human approved) are the human's. Such a task can never
 * land above `supervised` — the prompt-injection line. `createdByRun` is the
 * belt to the source's braces: a row an agent run created is external whatever
 * its source says. `source` is immutable after create (routes/tasks.ts).
 */
export function isExternalTask(t: Pick<Task, 'source' | 'createdByRun'>): boolean {
  return (t.source !== 'manual' && t.source !== 'feature') || t.createdByRun !== null;
}

/**
 * The landing gate (docs/design.md § Landing tiers), read off the row once
 * the verify round has settled: checks green or none applied, AND a verdict
 * with no blocker/major finding — `passed`, `skipped` (the task changed
 * nothing to judge) or no review at all (review off for this task). Returns
 * the reason the task may land ("checks green, review clean"), or null when
 * it may not: red/error checks, a flagged or failed review, or a round still
 * open. Pure, and status-blind so the notifiers can quote the reason off a
 * row that has already landed; the orchestrator also requires `review`. The
 * tier is a separate question (`effectiveLanding`).
 */
export function landingReason(
  t: Pick<Task, 'reviewState' | 'checkState' | 'checkResults'> & Partial<Pick<Task, 'kind' | 'loopState'>>,
): string | null {
  // A loop task (docs/loops.md) lands on its own only when its goal was met:
  // a loop that ran out of iterations, budget or progress has green checks
  // and a clean review of an UNFINISHED goal, which is a human's call.
  if (t.kind === 'loop' && t.loopState !== 'met') return null;
  const checks =
    t.checkState === 'green'
      ? `checks green${t.checkResults.length ? ` (${t.checkResults.length})` : ''}`
      : t.checkState === null
        ? 'no checks'
        : null;
  const review =
    t.reviewState === 'passed'
      ? 'review clean'
      : t.reviewState === 'skipped'
        ? 'nothing to review'
        : t.reviewState === null
          ? 'review off'
          : null;
  return checks && review ? `${checks}, ${review}` : null;
}

/** The tier a task actually lands with: its override, else its repo's, clamped to `supervised` for an external task. */
export function effectiveLanding(
  t: Pick<Task, 'source' | 'createdByRun' | 'landing'>,
  repo: Pick<Repo, 'landing'> | null | undefined,
): LandingTier {
  if (isExternalTask(t)) return 'supervised';
  return t.landing ?? repo?.landing ?? 'supervised';
}

/**
 * What a worker turn is told about `git push` when the server is NOT holding
 * the ship for a review (docs/publish.md § Push policy). A repo setting
 * (`Repo.pushPolicy`), no per-task override:
 * - `repo-rules`: no rule — the repo's own CLAUDE.md decides (the default,
 *   and the behaviour before the setting existed).
 * - `agent-pushes`: push without asking, but ONLY when every commit in
 *   `@{u}..HEAD` carries this task's own `Task:` trailer; otherwise commit
 *   locally and say so. Never ask whether to push.
 * - `publish-turn`: never push or deploy; shipping is the publish turn's.
 * `shipHeldForReview` outranks every policy (the ship gate is the rule then),
 * and the publish turn gets none of them. An external task (`isExternalTask`)
 * never gets `agent-pushes`: it resolves to `repo-rules`, like a landing tier
 * clamps to `supervised`.
 */
export type PrState = 'draft' | 'open' | 'merged' | 'closed';

export type PushPolicy = 'repo-rules' | 'agent-pushes' | 'publish-turn';
export const PUSH_POLICIES: PushPolicy[] = ['repo-rules', 'agent-pushes', 'publish-turn'];

/** The push policy a task's worker turns get: its repo's, with `agent-pushes` clamped to `repo-rules` for an external task. */
export function effectivePushPolicy(
  t: Pick<Task, 'source' | 'createdByRun'>,
  repo: Pick<Repo, 'pushPolicy'> | null | undefined,
): PushPolicy {
  const policy = repo?.pushPolicy ?? 'repo-rules';
  return policy === 'agent-pushes' && isExternalTask(t) ? 'repo-rules' : policy;
}

/**
 * Question autopilot (docs/questions.md § Autopilot): a repo opts in with a
 * number of minutes (`Repo.questionAutopilotMinutes`, null = off, the
 * default). A worker's question that has waited that long on a live run gets
 * its one "(Recommended)" option picked by the server, if the question passes
 * every eligibility rule. Never below this floor.
 */
export const QUESTION_AUTOPILOT_MIN_MINUTES = 10;
/** the ceiling: a week, the hook's own timeout */
export const QUESTION_AUTOPILOT_MAX_MINUTES = 10_080;
/** the `answeredBy` / audit actor of an autopilot pick */
export const AUTOPILOT_ACTOR = 'autopilot';

/** Whole minutes an answered question waited (`answeredAt − createdAt`), or null — the "N" of every "auto-picked after N min". */
export function questionWaitedMinutes(q: Pick<Question, 'createdAt' | 'answeredAt'>): number | null {
  if (!q.answeredAt) return null;
  const ms = Date.parse(q.answeredAt) - Date.parse(q.createdAt);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms / 60_000) : null;
}

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
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
];

/**
 * Context window of a model, by prefix like the server's `priceFor`. Every
 * current model but Haiku 4.5 runs a 1M window by default (the CLI's model
 * config docs; autocompact near 967k); Haiku 4.5 keeps 200k. An unknown id
 * gets 1M, the window of everything this app offers (`MODEL_OPTIONS`). When
 * an autocompact window is configured for the session, pass it to
 * `contextPctOf` instead — the CLI's own status line divides by that.
 */
const CONTEXT_WINDOWS: [prefix: string, tokens: number][] = [
  ['claude-haiku-4-5', 200_000],
  ['claude-opus-5', 1_000_000],
  ['claude-fable-5', 1_000_000],
  ['claude-sonnet-5', 1_000_000],
];
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

export function contextWindowFor(model: string | null | undefined): number {
  if (model) {
    for (const [prefix, tokens] of CONTEXT_WINDOWS) {
      if (model.startsWith(prefix)) return tokens;
    }
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * The value a worker turn passes as `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, or null
 * for none (the CLI's default): the setting raised to the resume cap (a lower
 * window would compact a session the gate just chose to resume as-is),
 * clamped to the CLI's accepted 100k..1M, and dropped when it would not be
 * below the model's own window — the CLI takes the minimum anyway.
 */
export function autoCompactWindowFor(
  settings: Pick<AppSettings, 'agent.autoCompactWindow' | 'agent.resumeContextCap'>,
  model: string | null | undefined,
): number | null {
  const w = settings['agent.autoCompactWindow'];
  if (!(w > 0)) return null;
  const cap = settings['agent.resumeContextCap'];
  const v = Math.min(1_000_000, Math.max(100_000, w, cap > 0 ? cap : 0));
  return v < contextWindowFor(model) ? v : null;
}

/**
 * The run's context share, 0..100, for display and the `context-high`
 * anomaly: recomputed from `contextTokens` against the model's window
 * whenever the row has the raw figure (rows before it carry only the old
 * 200k-clamped `contextPct`, returned as stored).
 */
export function contextPctOf(
  stats: Pick<RunStats, 'contextPct' | 'contextTokens'> | null | undefined,
  model: string | null | undefined,
  window?: number,
): number {
  if (!stats) return 0;
  if (typeof stats.contextTokens === 'number' && stats.contextTokens > 0) {
    const w = window && window > 0 ? window : contextWindowFor(model);
    return Math.min(100, Math.round((stats.contextTokens / w) * 1000) / 10);
  }
  return stats.contextPct ?? 0;
}

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
  /** a built-in's fixed id, or a custom preset's `CUSTOM_PRESET_ID_RE` id */
  id: string;
  label: string;
  /** what the preset resolves to, shown next to the label */
  hint: string;
  model: string;
  effort: EffortLevel;
  review: boolean | null;
  /** custom presets only: the group palette slot (1..GROUP_COLOR_COUNT) it is drawn with */
  color?: number;
  /** true on a preset from `presets.custom` — the built-ins leave it unset */
  custom?: boolean;
}

export const TASK_PRESETS: TaskPreset[] = [
  // Small and Routine both skip adversarial review — the work is short enough
  // that a review round costs more than it catches. Only Complex pins it on.
  // The hint spells out review only when it is ON; "no review" is the norm for
  // the two cheap presets and would just be noise on every button.
  {
    id: 'small',
    label: 'Small',
    hint: 'opus 5.5 · medium',
    model: 'claude-opus-5-5',
    effort: 'medium',
    review: false,
  },
  {
    id: 'routine',
    label: 'Routine',
    hint: 'opus 5.5 · high',
    model: 'claude-opus-5-5',
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

/**
 * A preset the user made on the Config page (`presets.custom`, docs/handbook.md
 * § Quick start, Custom presets). Same three values as a built-in plus a colour slot; the
 * hint is derived (`presetHint`), never stored, so it cannot disagree with the
 * values it describes.
 */
export interface CustomTaskPreset {
  /** `CUSTOM_PRESET_ID_RE` — short enough for a Telegram `w:` callback, and never a built-in id */
  id: string;
  label: string;
  model: string;
  effort: EffortLevel;
  review: boolean | null;
  /** group palette slot, 1..GROUP_COLOR_COUNT */
  color: number;
}

export const CUSTOM_PRESET_MAX = 12;
export const CUSTOM_PRESET_LABEL_MAX = 24;
export const CUSTOM_PRESET_ID_RE = /^p-[a-z0-9]{4,16}$/;
/** a model id is argv to `claude --model`, so no whitespace and nothing exotic */
export const CUSTOM_PRESET_MODEL_RE = /^[A-Za-z0-9][\w.:-]{0,63}$/;

/** "opus 5.5 · high · review" — the built-ins' hint format, derived for a custom preset. */
export function presetHint(p: { model: string; effort: EffortLevel; review: boolean | null }): string {
  const bare = p.model.replace(/^claude-/, '');
  const dash = bare.indexOf('-');
  const model = dash < 0 ? bare : `${bare.slice(0, dash)} ${bare.slice(dash + 1).replace(/-/g, '.')}`;
  // Review is written only when ON, as on the built-ins (docs/decisions.md 2026-08-26).
  return `${model} · ${p.effort}${p.review ? ' · review' : ''}`;
}

/**
 * Every preset offered: the built-ins first, then the user's own in their saved
 * order. Built-ins first also makes them win `matchTaskPreset`'s first-match —
 * moot in practice, since `customPresetProblem` refuses a custom preset whose
 * values repeat any other preset's.
 */
export function taskPresets(settings: { 'presets.custom'?: CustomTaskPreset[] } | null | undefined): TaskPreset[] {
  const custom = settings?.['presets.custom'];
  if (!Array.isArray(custom) || !custom.length) return TASK_PRESETS;
  return [
    ...TASK_PRESETS,
    ...custom.map((c) => ({
      id: c.id,
      label: c.label,
      hint: presetHint(c),
      model: c.model,
      effort: c.effort,
      review: c.review,
      color: c.color,
      custom: true,
    })),
  ];
}

/**
 * Why a `presets.custom` list cannot be saved, or null when it can. Shared so
 * the server (settings route) and the Config page (inline, before Save) apply
 * one rule set. Checks the per-entry shape as well, because the Config page
 * calls it on raw form state.
 */
export function customPresetProblem(list: CustomTaskPreset[]): string | null {
  if (list.length > CUSTOM_PRESET_MAX) return `at most ${CUSTOM_PRESET_MAX} custom presets`;
  const ids = new Set<string>();
  const labels = new Map<string, string>(TASK_PRESETS.map((p) => [p.label.toLowerCase(), p.label]));
  const values = new Map<string, string>(
    TASK_PRESETS.map((p) => [`${p.model}|${p.effort}|${p.review}`, p.label]),
  );
  for (const c of list) {
    const label = c.label.trim();
    const name = label || '(unnamed)';
    if (!CUSTOM_PRESET_ID_RE.test(c.id)) return `preset "${name}": invalid id`;
    if (ids.has(c.id)) return `preset "${name}": duplicate id`;
    ids.add(c.id);
    if (!label) return 'every preset needs a name';
    if (label.length > CUSTOM_PRESET_LABEL_MAX) return `preset "${label}": name is over ${CUSTOM_PRESET_LABEL_MAX} characters`;
    const taken = labels.get(label.toLowerCase());
    if (taken) return `preset "${label}": the name "${taken}" is already used`;
    labels.set(label.toLowerCase(), label);
    if (!CUSTOM_PRESET_MODEL_RE.test(c.model)) return `preset "${label}": invalid model id`;
    if (!EFFORT_LEVELS.includes(c.effort)) return `preset "${label}": invalid effort`;
    if (c.review !== null && typeof c.review !== 'boolean') return `preset "${label}": invalid review value`;
    if (!Number.isInteger(c.color) || c.color < 1 || c.color > GROUP_COLOR_COUNT) return `preset "${label}": invalid colour`;
    // The highlighted button and the board chip are computed by matching these
    // three values, so a repeat could never be the one that lights up.
    const key = `${c.model}|${c.effort}|${c.review}`;
    const same = values.get(key);
    if (same) return `preset "${label}": same model, effort and review as "${same}"`;
    values.set(key, label);
  }
  return null;
}

/** The preset a set of override values corresponds to, or undefined ("custom"). */
export function matchTaskPreset(
  v: {
    model: string | null;
    effort: EffortLevel | null;
    review: boolean | null;
  },
  presets: TaskPreset[] = TASK_PRESETS,
): TaskPreset | undefined {
  return presets.find((p) => p.model === v.model && p.effort === v.effort && p.review === v.review);
}

export interface Repo {
  id: string;
  name: string;
  path: string; // absolute; ~ expanded on insert
  role: string | null; // free note: "backend", "frontend", ...
  /** dev-server URL framed by the mobile emulator window (http/https only; null = no preview) */
  previewUrl: string | null;
  /** how far this repo's tasks land on their own (docs/design.md § Landing tiers); a task may override */
  landing: LandingTier;
  /** what worker turns are told about `git push` when no review holds the ship (docs/publish.md § Push policy) */
  pushPolicy: PushPolicy;
  /** question autopilot: minutes a worker's question waits before its Recommended option is picked; null = off (docs/questions.md § Autopilot) */
  questionAutopilotMinutes: number | null;
  /**
   * Parallel same-repo tasks (docs/parallel.md): how many of this repo's tasks
   * may hold it at once, 1..PARALLEL_MAX. Above 1 only with `delivery: 'pr'`
   * (each task in its own worktree); `direct` always resolves to 1
   * (`repoParallelCap`).
   */
  parallel: number;
  /** `direct` = today (the agent works in the checkout); `pr` = a worktree + branch per task, draft PR, local squash + ff land */
  delivery: RepoDelivery;
  /** argv line run in a new worktree after the dependency clone (e.g. `npm install`); null = none */
  worktreeSetup: string | null;
  /** untracked/ignored files copied into a new worktree (basename or path globs); null = WORKTREE_COPY_DEFAULTS */
  worktreeCopy: string[] | null;
  /**
   * The branch `pr` delivery forks worktrees from, opens PRs against and lands
   * onto (`origin/<baseBranch>`); null = the remote default (`origin/HEAD`, else
   * origin/main|master). For a repo whose real line is not GitHub's default —
   * neko-nest lives on `staging` (docs/parallel.md § Base branch).
   */
  baseBranch: string | null;
  /** approval actions this repo pre-approves — a subset of APPROVAL_AUTO_ACTIONS (docs/approvals.md § Auto-approve) */
  autoApprove: ApprovalAction[];
  createdAt: string;
}

/** docs/parallel.md § Delivery */
export type RepoDelivery = 'direct' | 'pr';
export const REPO_DELIVERIES: RepoDelivery[] = ['direct', 'pr'];
/** the highest per-repo parallel cap (still bounded by `orchestrator.concurrency`) */
export const PARALLEL_MAX = 3;
/** the global worker cap's ceiling (decisions.md 2026-10-27: 6-8 agents across repos; the validator already allowed 10) */
export const CONCURRENCY_MAX = 10;
export const WORKTREE_COPY_DEFAULTS: readonly string[] = ['.env*', '.claude/settings.local.json'];

/**
 * How many of a repo's tasks may hold it at once — the SQL gates' cap
 * (`repoCapSql` in queue-sql.ts) in JS: `parallel` only for a `pr` repo,
 * whose tasks each work in their own worktree; a `direct` repo is always 1.
 * JS twin: predictSchedule (shared/src/schedule.ts) — the schedule simulator; edit together.
 */
export function repoParallelCap(repo: Pick<Repo, 'parallel' | 'delivery'> | null | undefined): number {
  if (!repo || repo.delivery !== 'pr') return 1;
  return Math.max(1, Math.min(PARALLEL_MAX, Math.floor(repo.parallel) || 1));
}

/**
 * Whether one more task may hold a repo whose current holders are `holders`
 * (the candidate excluded) — the JS twin of `repoHasRoom` in queue-sql.ts.
 * A holder working in the main checkout (no `workdir`) keeps the repo
 * exclusive whatever the cap, so a `direct` repo, or a pr repo's task that
 * started before the switch, behaves exactly as before.
 * JS twin: predictSchedule (shared/src/schedule.ts) — the schedule simulator; edit together.
 */
export function repoHasRoom(
  holders: readonly Pick<Task, 'workdir'>[],
  repo: Pick<Repo, 'parallel' | 'delivery'> | null | undefined,
): boolean {
  if (holders.some((h) => !h.workdir)) return false;
  return holders.length < repoParallelCap(repo);
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
  /**
   * A CHECK (docs/checks.md): run by the server after every worker turn, before
   * the review round, as part of the task's definition of done. Exit 0 = green.
   */
  isCheck: boolean;
  /** a check's wall-clock limit in seconds; null = CHECK_DEFAULT_TIMEOUT_SEC. Past it the check is `error`, not red */
  timeoutSec: number | null;
  /**
   * The task whose AGENT saved it (docs/commands.md § Agent-owned commands);
   * null = a human's (or adopted by one), never touched by the cleanup.
   */
  ownerTaskId: string | null;
  /** ISO time the cleanup (or a human) archived it: hidden from the launcher, restorable. null = live */
  archivedAt: string | null;
  /** ISO time it was last started, by anyone; null = never since migration 45 */
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Agent-owned saved commands one repo may hold (archived ones not counted). */
export const AGENT_COMMANDS_PER_REPO_CAP = 20;

/** A check with no timeout of its own gets this many seconds. */
export const CHECK_DEFAULT_TIMEOUT_SEC = 600;
/** Bounds of a check's own timeout, in seconds. */
export const CHECK_TIMEOUT_MIN_SEC = 10;
export const CHECK_TIMEOUT_MAX_SEC = 3600;

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
  /** audit actor that started it: 'human', or `agent:<run8>` via /api/agent/commands */
  startedBy: string;
  /** the task whose agent started it (any turn of that task may stop it); null when a human did */
  ownerTaskId: string | null;
  /** set when the server ran it as a CHECK of this task's change (docs/checks.md); null otherwise */
  checkTaskId: string | null;
  /** true when it ran as a check's BASELINE — once on the current tree before
   *  the check is saved (docs/checks.md § Baseline); owned by no task */
  checkBaseline?: boolean;
  /** true for an agent's ONE-SHOT run (POST /api/agent/commands/run): an
   *  unsaved command line, so `commandId` is null from the start */
  oneShot?: boolean;
}

/**
 * The scanner's rule-based check suggestion (docs/checks.md § Suggested
 * checks). Nothing is ever saved from it automatically.
 */
export interface CheckSuggestion {
  /** why it is suggested: "in CI", "named test", … */
  reason: string;
  /** what the script would change besides giving a verdict (`--fix`, a build
   *  into served output, …); null = none known. Set ⇒ never pre-selected. */
  sideEffect: string | null;
  /** a safer command to use instead, when one is known */
  instead: string | null;
  /** in CI and without side effects — the scan list leads with these */
  preselect: boolean;
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
  /** set when the script looks like a check (in CI, or named typecheck/lint/test/build) */
  suggestedCheck: CheckSuggestion | null;
}

/** A check's baseline: one run on the current tree before it is saved. */
export type BaselineVerdict = 'green' | 'red' | 'error';

export interface CheckBaseline {
  id: string;
  repoId: string;
  name: string;
  command: string;
  /** package dir relative to the repo root ('' = root) */
  cwd: string;
  timeoutSec: number | null;
  status: 'running' | 'done';
  /** null while running */
  verdict: BaselineVerdict | null;
  exit: number | null;
  /** no verdict: timeout, could not start, stopped */
  error: string | null;
  durationMs: number;
  /** last lines of the output (what a red would hand every task) */
  tail: string;
  /** the attachable command run (commands pool); null if it never started */
  runId: string | null;
  /** the tree it ran on: branch and uncommitted-change count at start */
  branch: string | null;
  dirty: number;
  startedAt: string;
  endedAt: string | null;
}

export interface RepoScripts {
  /** pnpm / yarn / npm / bun, detected from packageManager or the lockfile */
  packageManager: string;
  scripts: ScannedScript[];
  /** why the list is empty / partial (no package.json, unreadable, capped) */
  note: string | null;
}

/** docs/loops.md: a plain task, or a goal iterated in fresh sessions. */
export type TaskKind = 'task' | 'loop';
export const TASK_KINDS: readonly TaskKind[] = ['task', 'loop'];
export const LOOP_DEFAULT_MAX_ITERATIONS = 5;
/** the API's bound on maxIterations — a typo of 500 must not mean 500 sessions */
export const LOOP_MAX_ITERATIONS_LIMIT = 30;
/** consecutive no-progress iterations that end a loop */
export const LOOP_NO_PROGRESS_LIMIT = 2;

/**
 * Where a loop task stands (`tm_tasks.loop_state`, docs/loops.md). There is
 * deliberately NO new TaskStatus: between iterations the task stays
 * `running`, and the board reads these as synthetic badges.
 *  - `iterating`  an iteration's worker session is live
 *  - `checking`   that session ended; the server is committing leftovers,
 *                 running the checks and deciding whether to go on
 *  - `next`       another iteration is due and waits for a worker slot
 * The rest are ENDS — the task then lands `review` like any Stop:
 *  - `met`             checks green and the agent says the goal is met
 *  - `max-iterations`  ran out of iterations
 *  - `budget`          `loopBudgetUsd` (or `budget.taskUsd`) reached
 *  - `no-progress`     LOOP_NO_PROGRESS_LIMIT iterations changed nothing measurable
 *  - `paused`          an iteration asked a question / raised needs-attention,
 *                      or the server restarted mid-iteration — Continue resumes
 *  - `error`           the iteration could not be judged (checks/git failed)
 */
export type LoopState =
  | 'iterating'
  | 'checking'
  | 'next'
  | 'met'
  | 'max-iterations'
  | 'budget'
  | 'no-progress'
  | 'paused'
  | 'error';
export const LOOP_IN_FLIGHT_STATES: readonly LoopState[] = ['iterating', 'checking', 'next'];
/** an ended loop the human may Continue (`met` is finished; the rest stopped short) */
export const LOOP_CONTINUABLE_STATES: readonly LoopState[] = ['max-iterations', 'budget', 'no-progress', 'paused', 'error'];

export function loopInFlight(t: Pick<Task, 'kind' | 'loopState'>): boolean {
  return t.kind === 'loop' && t.loopState !== null && LOOP_IN_FLIGHT_STATES.includes(t.loopState);
}

/** One ended iteration of a loop task (`Task.loopHistory`). */
export interface LoopIteration {
  n: number;
  /** the worker run this iteration was */
  runId: string;
  endedAt: string;
  /** the agent's structured result; null = it gave none (counts as not met) */
  goalMet: boolean | null;
  /** the agent's one-line progress note (or the start of its last message) */
  note: string | null;
  /** the checks' verdict after this iteration; null = no checks apply */
  checkState: 'green' | 'red' | 'error' | null;
  /** per check: name + outcome (the latest iteration's full tails are on `checkResults` at the end) */
  checks: { name: string; outcome: CheckResult['outcome'] }[];
  /**
   * The progress metric: the last `TM_METRIC=<number>` a check printed, else
   * the count of green checks (`metricSource`). Drawn as the card sparkline;
   * a TM_METRIC that did not move counts as no progress.
   */
  metric: number | null;
  metricSource: 'tm-metric' | 'green-count' | null;
  /** `workerDiff` hash after the iteration (commits + uncommitted); unchanged = no progress */
  diffHash: string | null;
  /** the server committed what the agent left uncommitted (`handoffCommit`) */
  handoff: boolean;
  /** this iteration changed nothing measurable (diff hash, or TM_METRIC, unchanged) */
  noProgress: boolean;
  /** the task's cost roll-up when the iteration ended */
  costUsd: number;
  /** why the loop stopped after this iteration (an end state), or null when it went on */
  stop: LoopState | null;
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
  /**
   * Manual position (docs/grouping.md § Order). Siblings — a group's members
   * under one parent, or the root tasks — are ordered by it, and it is the
   * global claim's tiebreaker after `priority`, so the board's queue order IS
   * the run order. Only its rank among siblings means anything; new rows take
   * the global max + 1 (the end), and a drag writes a midpoint.
   */
  sortOrder: number;
  /** per-task overrides; null falls back to agent.model / agent.effort settings */
  model: string | null;
  effort: EffortLevel | null;
  /** domain label ("UI", "Estimator") — agents create and fill these */
  category: string | null;
  /** run id of the agent that filed this task (null = human-created) */
  createdByRun: string | null;
  /** distance from human intent: human 0, agent-filed = creator's depth + 1 (cap: agent.maxSpawnDepth) */
  spawnDepth: number;
  /** the Feature this task was generated from (null = standalone task) */
  featureId: string | null;
  /** 0-based phase index inside that feature; phases run in order */
  featurePhase: number | null;
  /**
   * Agent-filed tasks only: the filer's one-paragraph "what will be done",
   * written BEFORE any work, for the human (resultSummary is the after-work
   * twin). Null on human/feature/proposal tasks.
   */
  brief: string | null;
  resultSummary: string | null;
  /** per-task adversarial review override: null = use review.enabled setting */
  review: boolean | null;
  /**
   * Who reviews this task's change: null = the global review.model setting.
   * Fable still falls back to Opus 5 when unavailable; the round records what ran.
   */
  reviewModel: string | null;
  /** reviewer --effort; null = the reviewer's default (none, xhigh on the Opus fallback) */
  reviewEffort: EffortLevel | null;
  /**
   * Landing tier override (docs/design.md § Landing tiers): null = the repo's
   * `landing`. Resolve with `effectiveLanding`, which clamps an external task
   * to `supervised` whatever is stored here.
   */
  landing: LandingTier | null;
  /**
   * When the ORCHESTRATOR landed this task (`on-green` → done, `auto-publish`
   * → published) rather than a human; null otherwise. Cleared by any move to a
   * status other than done/published, so it only ever describes the current
   * landing (the card's `auto-landed` chip).
   */
  autoLandedAt: string | null;
  /**
   * Observed publish (docs/publish.md § Observed publish): the task's newest
   * commit, seen on a remote (`taskShipped`) when its work turn landed in
   * `review` — the agent pushed it itself. Offers "Mark published" on a
   * supervised task; null when not seen. Cleared by any move to a status other
   * than review/done/published, like `autoLandedAt`.
   */
  shippedSha: string | null;
  /** when `shippedSha` was observed */
  shippedAt: string | null;
  /**
   * The task's own git worktree (docs/parallel.md), set at its first spawn in
   * a `delivery: 'pr'` repo — the cwd of every turn, review and check of the
   * task, kept after an eviction (the directory is re-created at the same
   * path, so `--resume` still finds the session). null = the repo checkout.
   */
  workdir: string | null;
  /** the worktree's branch, `tm/<task8>` */
  branch: string | null;
  /** the server-opened PR (a record, not the merge mechanism) */
  prNumber: number | null;
  prUrl: string | null;
  /** `draft` | `open` | `merged` | `closed`, as last written by the server */
  prState: PrState | null;
  /** when the idle sweep removed the worktree directory (branch kept; re-created on the next turn) */
  worktreeEvictedAt: string | null;
  /**
   * The base branch (no remote, e.g. `staging`) the worktree was forked from or
   * last moved onto. A repo whose base changed since moves the branch before the
   * next turn or land (`retargetWorktree`); null = forked before this was
   * recorded, read as the remote default.
   */
  worktreeBase: string | null;
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
   * Where this task's change starts (docs/design.md § Adversarial review,
   * "What the reviewer reads"): the repo's HEAD sha and branch when the
   * task's FIRST worker run spawned, and when. Written once and never moved —
   * retries, fix rounds and follow-ups keep it. The reviewer diffs the task's
   * own commits (found by their `Task: <id>` trailer, or base..HEAD when no
   * other task worked in the repo meanwhile) plus the uncommitted rest. null =
   * never ran (a task from before migration 29 gets one derived at its next
   * review from its first run's start time).
   */
  baseSha: string | null;
  /** branch at `baseSha` (`HEAD` when detached) */
  baseRef: string | null;
  /** ISO time the base was taken — the start of the task's commit window */
  baseAt: string | null;
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
  /**
   * ISO time an "Undo start" (docs/queue.md § Undo start) put this task back
   * into `queued`. It keeps its place, but no claim takes it: the global, agent
   * and custom queues all skip it until Release, Run now, Enqueue or Add to
   * queue. Only meaningful in `queued`, and every status transition clears it.
   * null = not held.
   */
  queueHeldAt: string | null;
  /**
   * The turn "Pause all" owes this task (docs/pause.md): set when a pause
   * suspended its live turn (or deferred an automatic one), and read by
   * Continue, which resumes the task's OWN claude session. A marked task holds
   * its repo (queue-sql `heldBy` / `REPO_EXCLUSIVE_GATE`), and every status
   * transition clears it — a human who moved the task took it over.
   * null = nothing owed.
   */
  pausedTurn: PausedTurn | null;
  /**
   * ISO time the human hid this task (docs/design.md § Hidden tasks): the
   * board leaves it out of every section but its own dimmed "Hidden" one, and
   * the Telegram Drafts tab skips it. Board-only — no claim reads it. Refused
   * on a working task, and every status transition clears it, so a task that
   * moves on is visible again. null = visible.
   */
  hiddenAt: string | null;
  /**
   * ISO time a "Keep" on its Inbox stale-draft row expires (docs/inbox.md §
   * Stale drafts, migration 44): until then the draft is out of the stale
   * list but still on the board. Set only on a `draft`; every status
   * transition clears it. null = never kept.
   */
  inboxKeptUntil: string | null;
  /**
   * What this task has cost so far, in USD (docs/token-budget.md § Fuses):
   * the sum of `RunStats.costUsd` over its worker runs AND the aux runs about
   * it (subject = this task: review, compact). Kept on the row by the storage
   * layer whenever a run's stats are written (`tm_tasks.cost_usd`, migration
   * 33), so every surface that reads a task reads the same number; it is what
   * `budget.taskUsd` is measured against.
   */
  costUsd: number;
  /**
   * How many FRESH worker sessions this task has had (`tm_tasks.attempts`,
   * migration 35): bumped by every spawn that starts a new claude session —
   * a first claim, Retry, Run now, a fresh follow-up — and never by a resume
   * (Proceed, a fix round, publish, a transient-error resume). 0 = never ran.
   */
  attempts: number;
  /**
   * The definition of done in the human's words (docs/checks.md): injected
   * into the worker's fresh prompt and handed to the reviewer. null = none.
   */
  acceptance: string | null;
  /**
   * Which of the repo's checks apply, by name. null = all of them; [] = none
   * (an explicit opt-out). A name no longer matching a check is ignored.
   */
  checks: string[] | null;
  /** where the checks of the current change stand; see `CheckState` */
  checkState: CheckState | null;
  /** the latest check results, one per check that ran (empty = none yet) */
  checkResults: CheckResult[];
  /** the change hash (`workerDiff`) the latest checks ran over; a Stop with the same hash and green checks does not re-run them */
  checkDiffHash: string | null;
  /**
   * `task` (one worker session, then review) or `loop` (docs/loops.md): a
   * goal worked in FRESH sessions, one per iteration, over a server-fed
   * progress ledger, until the checks are green and the agent says the goal
   * is met — or iterations, budget or progress run out. Create-only.
   */
  kind: TaskKind;
  /** the loop's goal (required for `kind: 'loop'`, null otherwise) */
  loopGoal: string | null;
  /** iterations at most (loop only; default LOOP_DEFAULT_MAX_ITERATIONS) */
  loopMaxIterations: number | null;
  /** the loop's own USD ceiling against `costUsd` (loop only, required) — read by `budgetAllows` */
  loopBudgetUsd: number | null;
  /** iterations STARTED so far (0 = never ran); the n of the current or last one */
  loopIteration: number;
  /** where the loop stands — see `LoopState`; null = not started (or not a loop) */
  loopState: LoopState | null;
  /** one entry per iteration that ended, oldest first */
  loopHistory: LoopIteration[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Custom queue (docs/queue.md): statuses in which a member still owns its
 * repo's working tree, so the next same-repo member must wait. `review` is
 * NOT here: a member parked in review holds its repo only while an automatic
 * review round is open on it (`customQueueHoldsRepo`). Twin of the in-flight
 * predicate in server/src/storage/queue-sql.ts — edit together.
 */
/**
 * Same-repo exclusivity in the GLOBAL claim (docs/queue.md § Same-repo
 * exclusivity): a queued task is not claimed while another task in its repo is
 * working (`running`/`waiting`) or in `review` with an automatic review round
 * still open. Unlike the custom queue, `blocked` does NOT hold the repo — a
 * split parent waits on children that live in that same repo. JS twin of
 * `REPO_EXCLUSIVE_GATE` in server/src/storage/queue-sql.ts — edit together.
 * JS twin: predictSchedule (shared/src/schedule.ts) — the schedule simulator; edit together.
 */
export function holdsRepoForClaim(t: Pick<Task, 'status' | 'reviewState' | 'checkState' | 'pausedTurn'>): boolean {
  if (t.status === 'running' || t.status === 'waiting') return true;
  // a turn Pause all owes this task (docs/pause.md) — Continue resumes it here
  if (t.pausedTurn) return true;
  return verifyOpen(t);
}

/**
 * A task parked in `review` whose automatic verify round is still open: its
 * review round (`REVIEW_BUSY_STATES`) or its repo checks (`CHECK_BUSY_STATES`,
 * docs/checks.md — they read the checkout, so nobody else may edit it). The
 * `review_state … OR check_state …` clause of the SQL twins in
 * server/src/storage/queue-sql.ts — edit together.
 * JS twin: predictSchedule (shared/src/schedule.ts) — the schedule simulator; edit together.
 */
export function verifyOpen(t: Pick<Task, 'status' | 'reviewState' | 'checkState'>): boolean {
  if (t.status !== 'review') return false;
  return (!!t.reviewState && REVIEW_BUSY_STATES.includes(t.reviewState)) || (!!t.checkState && CHECK_BUSY_STATES.includes(t.checkState));
}

/**
 * Why Publish is refused right now (docs/publish.md § The verify gate): the
 * automatic review round or the repo checks are still open, so no verdict
 * exists yet. `Orchestrator.publish()` answers 409 with it for every caller
 * (web, Telegram, the API); the SPA takes Publish out of the primary slot on
 * the same test. Null = no gate.
 */
export function publishGateReason(t: Pick<Task, 'status' | 'reviewState' | 'checkState'>): string | null {
  if (!verifyOpen(t)) return null;
  const checks = !!t.checkState && CHECK_BUSY_STATES.includes(t.checkState);
  return checks
    ? 'the repo checks are still due or running — publish once they give a verdict'
    : 'the automatic review is still open — publish once it gives a verdict';
}

/**
 * The SETTLED verdict a human publishes over (docs/publish.md § The verify
 * gate): a flagged or failed review, red checks or checks with no verdict, in
 * words for the confirm ("review flagged 2 blockers, 1 major · checks red:
 * lint"). Null when the verdict is clean, off, or still open (that is
 * `publishGateReason`'s). Never consulted by auto-publish, which only runs on
 * a clean `landingReason`.
 */
export function publishCaution(
  t: Pick<Task, 'status' | 'reviewState' | 'checkState' | 'checkResults' | 'reviewRounds'>,
): string | null {
  if (verifyOpen(t)) return null;
  const parts: string[] = [];
  if (t.checkState === 'red' || t.checkState === 'error') {
    const names = t.checkResults.filter((c) => c.outcome === t.checkState).map((c) => c.name);
    const what = t.checkState === 'red' ? 'checks red' : 'checks gave no verdict';
    parts.push(names.length ? `${what}: ${names.join(', ')}` : what);
  }
  if (t.reviewState === 'flagged') {
    const last = t.reviewRounds[t.reviewRounds.length - 1];
    const n = (s: ReviewFinding['severity']) => last?.findings.filter((f) => f.severity === s).length ?? 0;
    const counts = [
      n('blocker') && `${n('blocker')} blocker${n('blocker') === 1 ? '' : 's'}`,
      n('major') && `${n('major')} major`,
    ].filter(Boolean);
    parts.push(counts.length ? `review flagged ${counts.join(', ')}` : 'review flagged issues');
  } else if (t.reviewState === 'error') {
    parts.push('the review could not run');
  }
  return parts.length ? parts.join(' · ') : null;
}

/** The task a run's cost belongs to: its own task, or the task an aux review/compact session was about. */
export function runTaskId(r: Pick<Run, 'taskId' | 'kind' | 'subjectId'>): string | null {
  if (r.taskId) return r.taskId;
  return r.kind === 'review' || r.kind === 'compact' ? r.subjectId : null;
}

export const CUSTOM_QUEUE_IN_FLIGHT_STATUSES: readonly TaskStatus[] = ['running', 'waiting', 'blocked'];

/**
 * Whether this task still holds its repo's place in the custom queue
 * (docs/queue.md § When the next member starts): working, parked on its
 * subagents, blocked on a split, or in `review` with an automatic review round
 * still open (`REVIEW_BUSY_STATES`). A task whose review has settled — or that
 * was never going to be reviewed — sits in `review` for the human without
 * stopping the queue. JS twin of `CUSTOM_QUEUE_HELD_BY` in
 * server/src/storage/queue-sql.ts — edit together.
 * JS twin: predictSchedule (shared/src/schedule.ts) — the schedule simulator; edit together.
 */
export function customQueueHoldsRepo(t: Pick<Task, 'status' | 'reviewState' | 'checkState' | 'pausedTurn'>): boolean {
  if (CUSTOM_QUEUE_IN_FLIGHT_STATUSES.includes(t.status)) return true;
  if (t.pausedTurn) return true; // Continue owes it a turn here (docs/pause.md)
  return verifyOpen(t);
}

/**
 * Members of the custom queue (docs/queue.md) that are still WAITING, in the
 * order they will run: FIFO by the moment each was added. `transitionTask`
 * clears `custom_queue_at` only on a terminal status, so a `running`, `review`
 * or `blocked` member keeps its mark (whether it still holds its repo is
 * `customQueueHoldsRepo`), but it is no longer waiting and must not be counted
 * in the position. A member held by Undo start IS still waiting and keeps its
 * number; the claim skips it.
 *
 * Shared rather than duplicated: the board's `queue #n` chip and the Telegram
 * bot's `/task` and `/queue` both derive their ordinal from this, so the two
 * surfaces cannot tell the same task a different number.
 *
 * "Added" is only the starting value: a reorder (`POST /api/tasks/:id/queue-move`,
 * docs/queue.md § Reordering) rewrites `customQueueAt` itself, so this sort and
 * CUSTOM_QUEUE_HEAD_ORDER (server/src/storage/queue-sql.ts) follow it unchanged.
 * Read the column as a sort key, never as a time to show.
 * JS twin: predictSchedule (shared/src/schedule.ts) — the schedule simulator; edit together.
 */
export function customQueueWaiting(tasks: Task[]): Task[] {
  return tasks
    .filter((t) => t.status === 'queued' && !!t.customQueueAt)
    .sort((a, b) => a.customQueueAt!.localeCompare(b.customQueueAt!) || a.createdAt.localeCompare(b.createdAt));
}

/** How many distinct colours the board can tint groups with (`--tm-group-1..N`). */
/**
 * Where `POST /api/tasks/:id/move` puts a task relative to its target
 * (docs/grouping.md § Drag and drop): beside it, joined to its group flat,
 * as its last child, at the end of its group, or out of any group.
 */
export const TASK_MOVE_PLACES = ['before', 'after', 'into', 'child', 'group', 'ungroup'] as const;
export type TaskMovePlace = (typeof TASK_MOVE_PLACES)[number];

/**
 * The global claim's order as a comparator — the JS twin of
 * `MANUAL_CLAIM_ORDER` (server/src/storage/group.ts); edit them together.
 * priority first, then the group's root key (then group id), root before its
 * members, then the task's own key, then creation. `byId` must hold the roots.
 * JS twin: predictSchedule (shared/src/schedule.ts) — the schedule simulator; edit together.
 */
export function compareClaimOrder(byId: ReadonlyMap<string, Task>) {
  return (a: Task, b: Task): number => {
    const rootKey = (t: Task) => byId.get(t.groupId)?.sortOrder ?? t.sortOrder;
    return (
      b.priority - a.priority ||
      rootKey(a) - rootKey(b) ||
      (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0) ||
      Number(!!a.parentId) - Number(!!b.parentId) ||
      a.sortOrder - b.sortOrder ||
      a.createdAt.localeCompare(b.createdAt)
    );
  };
}

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

/**
 * Titles an agent or a model writes are ONE short line (docs/agent-api-design.md
 * § Title and brief): details belong in the description, the plan in `brief`.
 */
export const AGENT_TITLE_MAX = 80;
/** `Task.brief`: a few sentences, not a second description. */
export const AGENT_BRIEF_MAX = 400;

/** Why an agent-sent title is refused (the agent rewrites it), or null. */
export function agentTitleProblem(title: string): string | null {
  const t = title.trim();
  if (!t) return 'title is empty';
  if (/[\r\n]/.test(t)) return 'title must be ONE line — details go in "description", the plan in "brief"';
  if (t.length > AGENT_TITLE_MAX) {
    return `title is ${t.length} chars — keep it to one short line of at most ${AGENT_TITLE_MAX}; details go in "description"`;
  }
  return null;
}

/**
 * A model-written title nobody can be asked to rewrite (analysis proposals,
 * feature-plan cards, a request note's title): its first non-empty line,
 * whitespace collapsed, clipped at a word boundary with an ellipsis.
 */
export function oneLineTitle(raw: string, max = AGENT_TITLE_MAX): string {
  const first = raw.split(/[\r\n]+/).find((l) => l.trim()) ?? '';
  const line = first.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  const head = space > max * 0.6 ? cut.slice(0, space) : cut;
  return head.replace(/[\s,;:.\-–—]+$/, '') + '…';
}

/**
 * `worker` = a task's agent (the only mode that ever moves a task). `aux` =
 * every other claude this server spawns — each one a real, attachable PTY
 * terminal told apart by `kind` (docs/design.md § PTY sessions). There is no
 * headless mode any more; the legacy `analyze` rows were migrated to `aux`.
 */
export type RunMode = 'worker' | 'aux';
/** What a run's terminal is doing. Workers are always `worker`. */
export type RunKind =
  | 'worker'
  | 'review'
  | 'plan'
  | 'plan-review'
  | 'analysis'
  | 'compact'
  | 'report'
  | 'chat'
  | 'commit';
export const AUX_RUN_KINDS: readonly Exclude<RunKind, 'worker'>[] = [
  'review',
  'plan',
  'plan-review',
  'analysis',
  'compact',
  'report',
  'chat',
  'commit',
];
export type RunStatus = 'running' | 'exited' | 'killed';

/** Usage figures parsed from the claude session transcript (filled by hooks/exit). */
export interface RunStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /**
   * share of the model's context window used by the last turn, 0..100. Rows
   * written before the per-model window divided by a fixed 200k and clamp at
   * 100 — display through `contextPctOf`, which recomputes from
   * `contextTokens` where the row has it.
   */
  contextPct: number;
  /**
   * Raw last-turn context total in tokens (input + cache read + cache write +
   * output of the last main-chain message), unclamped. The resume gate
   * (`agent.resumeContextCap`, docs/token-budget.md) needs the number, not the
   * percentage. Absent on run rows written before this field existed; read
   * `?? 0`.
   */
  contextTokens: number;
  /**
   * The part of `costUsd` spent by the session's subagents (their own
   * transcripts under `<session>/subagents/`), already included in `costUsd`.
   * Absent on rows summarised before subagents were counted.
   */
  subagentCostUsd?: number;
}

export interface Run {
  id: string;
  taskId: string | null;
  repoId: string | null;
  mode: RunMode;
  kind: RunKind;
  /**
   * What an aux session is about, by kind: the task (review, compact), the
   * feature (plan, plan-review), the chat, the report, or the repo (analysis,
   * commit). `taskId` stays null for every aux run on purpose — it means
   * "this task's agent" everywhere it is read.
   */
  subjectId: string | null;
  /** runs-list label of an aux session ("review: <task title>"); on a WORKER row, 'publish' marks a publish turn (docs/queue.md § Stacked tasks) */
  label: string | null;
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
  /** the CLI's own per-option mockup text (markdown/ASCII, single-select
   *  only); shown under the option. Images the agent wants seen are task
   *  files NAMED in this, the label/description or the question text —
   *  resolved by `referencedFileNames` (docs/questions.md § Images) */
  preview?: string;
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
  /** actor vocabulary of tm_events: human | telegram | autopilot (the server picked the Recommended option) */
  answeredBy: string | null;
  /** why an `expired` row expired (run ended, cancelled, restart) */
  note: string | null;
  createdAt: string;
  answeredAt: string | null;
}

// ---- Approvals (docs/approvals.md) ----

/**
 * Human-only actions an agent may REQUEST (docs/approvals.md). The agent never
 * gets the power: the request is a row the human approves with one tap, and
 * then the SERVER runs exactly what the row says — so "the owner approves that
 * exact push" (neko D458) holds with the agent doing the legwork.
 */
export type ApprovalAction = 'push-ref' | 'mark-published' | 'rebuild-restart' | 'sync-branch';
export const APPROVAL_ACTIONS: ApprovalAction[] = ['push-ref', 'mark-published', 'rebuild-restart', 'sync-branch'];
/**
 * The only actions a repo may pre-approve (`Repo.autoApprove`): both re-read
 * git and can neither publish code nor stop the server. A push and a restart
 * always wait for a tap.
 */
export const APPROVAL_AUTO_ACTIONS: ApprovalAction[] = ['mark-published', 'sync-branch'];
/** the `decidedBy` / audit actor of a pre-approved request */
export const AUTO_APPROVE_ACTOR = 'auto-approve';
/** pending requests one task may hold at once */
export const APPROVAL_PENDING_CAP = 5;
/** task ids one mark-published request may name */
export const APPROVAL_MARK_MAX = 50;

export const APPROVAL_LABELS: Record<ApprovalAction, string> = {
  'push-ref': 'Push',
  'mark-published': 'Mark published',
  'rebuild-restart': 'Rebuild & restart',
  'sync-branch': 'Sync local branch',
};

/**
 * pending → approved → running → done | failed, or pending → rejected.
 * `expired`: the server refused to run it any more (the remote moved, a
 * restart cut it mid-run).
 */
export type ApprovalStatus = 'pending' | 'approved' | 'running' | 'done' | 'failed' | 'rejected' | 'expired';

export type ApprovalParams =
  | {
      action: 'push-ref';
      /** full sha of what is pushed (a commit, or an annotated tag object for a tag) */
      sha: string;
      /** `refs/heads/<branch>` or `refs/tags/<tag>` */
      ref: string;
      /** the remote ref's sha when the request was made; null = it does not exist yet. The push refuses if it moved. */
      expectedOld: string | null;
      /** commits `expectedOld..sha` (or reachable, for a new ref — capped) */
      commits: number;
    }
  | { action: 'mark-published'; taskIds: string[] }
  | { action: 'rebuild-restart'; drainMinutes: number | null }
  | {
      action: 'sync-branch';
      branch: string;
      /** commits origin has that the local branch lacks, at request time */
      behind: number;
    };

export interface Approval {
  id: string;
  /** the requesting task (null when the run had none) */
  taskId: string | null;
  runId: string;
  /** the repo the action acts on — may differ from the requester's (a release push) */
  repoId: string | null;
  action: ApprovalAction;
  params: ApprovalParams;
  /** what the human approves, in words and exact refs — the card's body */
  summary: string;
  /** the agent's why */
  reason: string;
  status: ApprovalStatus;
  /** human | telegram | auto-approve */
  decidedBy: string | null;
  /** the outcome in words (the error on `failed`) */
  result: string | null;
  createdAt: string;
  decidedAt: string | null;
  finishedAt: string | null;
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

/**
 * What Continue does for a task Pause all touched (docs/pause.md):
 *  - `resume`  — its turn was cut short (or never spawned): reopen its own
 *    session with `message` (a follow-up that never reached the agent) or,
 *    without one, the "you were paused, carry on" proceed.
 *  - `publish` — its publish turn was cut short: Publish again (git decides).
 *  - `land`    — its landing tier would have auto-published: re-run it.
 */
export interface PausedTurn {
  at: string;
  kind: 'resume' | 'publish' | 'land';
  message?: string | null;
  purpose?: 'work' | 'publish';
  /** the publish was the auto-publish tier's (re-issued as the orchestrator) */
  auto?: boolean;
}

// Runtime-tunable settings stored in tm_config (JSON values under these keys).
export interface AppSettings {
  'orchestrator.enabled': boolean;
  /**
   * Pause all (docs/pause.md): nothing automatic starts and live worker turns
   * are suspended until Continue. Machine state like `orchestrator.enabled` —
   * changed only through /api/orchestrator/pause|continue, never PUT /api/config.
   */
  'orchestrator.paused': boolean;
  'orchestrator.concurrency': number;
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
  /**
   * how many agent hops from a human a task may be and still file tasks: a
   * human's task is depth 0, a task it filed 1, … (default 6, 1..10;
   * docs/shared-spaces.md § Depth)
   */
  'agent.maxSpawnDepth': number;
  /** tint each task group with its own colour on the Board */
  'board.groupColors': boolean;
  /** the user's own task presets, after the built-in `TASK_PRESETS` (docs/handbook.md § Quick start, Custom presets) */
  'presets.custom': CustomTaskPreset[];
  /** task content templates, picked on the new-task form and Telegram /new (docs/inbox.md § Templates) */
  'task.templates': TaskTemplate[];
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
  /**
   * max check→fix→check rounds (docs/checks.md): how many times red checks are
   * typed back into the worker's live session before the task lands in review
   * with `checkState: 'red'`. 0 = run the checks, never ask for a fix.
   */
  'checks.maxRounds': number;
  /** max feature-plan re-analysis rounds after a blocker verdict (plan review, not diff review — independent of review.maxRounds) */
  'feature.analysisMaxRounds': number;
  /** a live worker turn older than this is an anomaly: Dashboard + one `anomaly` notification per turn */
  'anomaly.longRunMin': number;
  /** a single RUN costing more than this is an anomaly — the Dashboard's per-run rule only (the per-TASK alert is `anomaly.taskCostUsd`) */
  'anomaly.costUsd': number;
  /**
   * a TASK whose roll-up (`Task.costUsd`) passes this line is an anomaly: one
   * `cost-high` notification (warn), a second one (critical) past 2× the line.
   * 0 = adaptive, the default: the p90 of the repo's task roll-ups over the
   * last 30 days (the all-repo p90 below 10 tasks), never under $10
   * (docs/token-budget.md § The expensive-task alert). An alert, not a control
   * — `budget.taskUsd` is the control.
   */
  'anomaly.taskCostUsd': number;
  /** a task sitting in review this long is an anomaly: Dashboard + one notification per stay in review */
  'anomaly.staleReviewHours': number;
  /**
   * An agent-filed draft older than this many days is listed last in the
   * Inbox as a stale draft (keep / hide / cancel), and a Keep takes it out
   * of that list for this many days again (docs/inbox.md § Stale drafts).
   */
  'inbox.staleDraftDays': number;
  /**
   * An agent-saved repo command not started for this many days is archived
   * (hidden from the launcher, restorable), like one whose owner task landed
   * (docs/commands.md § Agent-owned commands). 0 = only the owner rule.
   */
  'commands.agentTtlDays': number;
  /**
   * A worktree task idle this many days in review/failed/done has its
   * directory evicted (leftovers WIP-committed to its branch, re-created at
   * the same path on the next turn — docs/parallel.md § Cleanup). 0 = never.
   */
  'worktrees.idleEvictDays': number;
  /**
   * Budget fuses (docs/token-budget.md § Fuses). 0 = off, the default for all three.
   * `budget.taskUsd`: no AUTOMATIC turn (review fix round, dispatch wake, auto
   * wake-up, later check/transient rounds) starts once the task's `costUsd`
   * is at or over it; a human click is never blocked.
   */
  'budget.taskUsd': number;
  /** the orchestrator stops CLAIMING (global, overflow and custom queue) once today's spend (server-local day) reaches this; running turns finish */
  'budget.dayUsd': number;
  /** wall clock per worker turn, in minutes: past it the run is flagged needs-attention and you are pinged — never killed */
  'budget.runMinutes': number;
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
  /**
   * The CLI's autocompact window for worker WORK turns, passed as
   * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (docs/token-budget.md § The fifth).
   * Opus' 1M window puts the CLI's own threshold near 967k, so a long fresh
   * session never compacts and every later turn re-reads all of it. 0 = the
   * CLI's default. Never on the publish turn; raised to at least
   * `agent.resumeContextCap` at spawn (`autoCompactWindowFor`) so the focused
   * resume gate still owns every resume.
   */
  'agent.autoCompactWindow': number;
  /**
   * How long a background SHELL (`run_in_background` Bash) may hold its task
   * in `waiting` (docs/design.md § Waiting), counted from the first Stop that
   * saw it running. A shell the agent ended its turn to wait for (a test
   * suite, a Lighthouse pass) re-invokes the session when it exits; one left
   * running on purpose (a dev server) never does, and the two look the same
   * at the Stop — so the wait is bounded, and past it the turn lands the
   * ordinary way. 0 = shells never hold a task (subagents only).
   */
  'agent.shellWaitMinutes': number;
  /** a turn that ended against the 5h usage limit is resumed automatically
   *  when the window resets, in its own session (docs/wake.md) */
  'agent.autoWake': boolean;
  /** seconds to wait past the window's reset time before resuming — the
   *  account's `resets_at` is the boundary, not a promise of capacity at it */
  'agent.autoWakeGraceSec': number;
  'sentry.dsn': string;
  // sentry.authToken is NOT a setting: it lives in server/data/config.json
  // (a secret — /api/config is readable by every worker). See SentryTokenStatus.
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
  'orchestrator.paused': false,
  'orchestrator.concurrency': 2,
  // Role split (user policy 2026-08-24): opus does the heavy work, fable
  // tells it what to do and reviews.
  'agent.model': 'claude-opus-5-5',
  'agent.effort': 'high',
  'analysis.model': 'claude-fable-5-1',
  'orchestrator.model': 'claude-fable-5-1',
  // usage-based routing is superseded by the role split; keep it available
  // but off by default (task.model overrides always win either way)
  'router.enabled': false,
  'router.primaryModel': 'claude-fable-5-1',
  'router.fallbackModel': 'claude-opus-5-5',
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
  'agent.maxSpawnDepth': 6,
  'agent.allowedTools': [],
  'board.groupColors': true,
  'presets.custom': [],
  'task.templates': [],
  'review.enabled': true,
  'review.model': 'claude-fable-5-1',
  'review.maxRounds': 1,
  'checks.maxRounds': 3,
  'feature.analysisMaxRounds': 2,
  'anomaly.longRunMin': 30,
  'anomaly.costUsd': 10,
  'anomaly.taskCostUsd': 0,
  'anomaly.staleReviewHours': 72,
  'inbox.staleDraftDays': 14,
  'commands.agentTtlDays': 7,
  'worktrees.idleEvictDays': 3,
  'budget.taskUsd': 0,
  'budget.dayUsd': 0,
  'budget.runMinutes': 0,
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
  // 300k, the same line as the resume cap: ~300k is where good work is known
  // to come out of a session (token-budget.md § The fourth), so the ceiling
  // sits AT the known-good size rather than below it (the old 150k draft) —
  // one context ceiling for a session, in-run and at resume.
  'agent.autoCompactWindow': 300_000,
  // 30: long enough for a full test suite or a 20-run Lighthouse pass (the
  // incident that added it took 10), short enough that a dev server left
  // running holds a worker slot for half an hour at most.
  'agent.shellWaitMinutes': 30,
  'agent.autoWake': true,
  // A minute past the stated reset: the boundary is the account's, and a
  // resume that arrives a second early buys nothing but a second stall.
  'agent.autoWakeGraceSec': 60,
  'sentry.dsn': '',
  'sentry.org': '',
  'sentry.project': '',
  'sentry.apiBase': 'https://sentry.io',
  'sentry.repoId': '',
  'sentry.categoryTag': '',
  'telegram.updateOffset': 0,
  'telegram.digestSentOn': '',
  'telegram.digestArmedAt': '',
  'telegram.activeChatId': '',
  'chat.model': 'claude-opus-5-5',
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

/**
 * Does this task still hold its feature phase open? The JS twin of the
 * lower-phase predicate inside FEATURE_CLAIM_GATE
 * (server/src/storage/feature-sql.ts, which re-exports it for both drivers'
 * `resolveFeatureProgress`). Settled = `published`/`done`/`cancelled`;
 * `failed` blocks on purpose (it pauses the feature rather than advancing it);
 * a draft a worker filed inside the feature (source not 'feature') is a
 * human-triage item, not phase work, and never blocks. Edit together with the
 * SQL, or not at all.
 * JS twin: predictSchedule (shared/src/schedule.ts) reads it for the phase gate.
 */
export function isFeatureTaskBlocking(t: { status: string; source: string }): boolean {
  if (t.status === 'published' || t.status === 'done' || t.status === 'cancelled') return false;
  if (t.status === 'draft' && t.source !== 'feature') return false;
  return true;
}

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
  | 'task.moved'
  /** custom queue membership changed by a human (docs/queue.md) */
  | 'task.queue'
  /**
   * "Undo start" stopped a running turn and put the task back where it was
   * (docs/queue.md § Undo start), or a human released that hold. `data.action`
   * is 'undo' | 'release'.
   */
  | 'task.undo'
  /** a human hid / unhid the task (docs/design.md § Hidden tasks) */
  | 'task.hidden'
  | 'task.unhidden'
  /** a human kept a stale draft off the Inbox's stale list for N days (docs/inbox.md § Stale drafts); data `{ until, days }` */
  | 'task.kept'
  | 'task.follow-up'
  | 'task.dispatch'
  | 'task.publish'
  /** the agent's own push was seen at a landing (docs/publish.md § Observed publish) */
  | 'task.shipped'
  /** a task worktree was created / re-created / evicted / removed (docs/parallel.md); data `{ action, dir, branch?, … }` */
  | 'task.worktree'
  /** the server pushed the task branch / opened, updated or readied its PR (docs/parallel.md § The PR) */
  | 'task.pr'
  /** a `pr` repo's push preflight changed (docs/parallel.md § Push health); data `{ ok, kind?, step?, error?, base?, localAhead? }` */
  | 'repo.push-health'
  /** a worktree task's local squash + fast-forward land, or the reason it stopped (docs/parallel.md § Land) */
  | 'task.land'
  | 'task.landing'
  | 'run.reviewed'
  /** the repo checks ran over a task's change, or were skipped with a reason (docs/checks.md) */
  | 'task.checked'
  /** a loop task's iteration started, ended (goalMet, checks, metric, stop) or was continued (docs/loops.md) */
  | 'task.loop'
  /** a human/the bot asked for an on-demand adversarial review ("Review now") */
  | 'task.review-requested'
  | 'task.deleted'
  | 'run.started'
  | 'run.killed'
  | 'run.attention'
  | 'run.stats-final'
  /** a worker turn ended on an API error (the CLI's StopFailure hook): the code and what the server did about it (docs/design.md § Transient API errors) */
  | 'run.stop-failure'
  /** one automatic resume of a worker turn that a transient API error cut short (typed `continue`, or `--resume`) */
  | 'run.transient-retry'
  /** a worker session compacted itself mid-run (agent.autoCompactWindow; docs/token-budget.md § The fifth) */
  | 'run.auto-compact'
  /** a failed/cancelled task was started again (Retry / Run now): the error the previous attempt ended on, which the fresh prompt carries */
  | 'task.retry'
  | 'proposal.created'
  | 'proposal.decided'
  | 'feature.created'
  | 'feature.transition'
  | 'feature.edited'
  | 'feature.analyzed'
  | 'repo.changed'
  /** orphan worktree directories / `tm/*` branches removed (docs/parallel.md § Cleanup) */
  | 'repo.worktrees-pruned'
  | 'command.changed'
  | 'command.run'
  | 'shell.session'
  | 'shell.killed'
  | 'config.changed'
  | 'orchestrator.toggle'
  /** Pause all on/off, and the turns it suspended (docs/pause.md) */
  | 'orchestrator.pause'
  | 'schedule.overflow-claim'
  | 'schedule.spawn-fail'
  | 'boot.recovery'
  /** the API is on its way out, and why (docs/host.md § Restart causes) */
  | 'server.stopping'
  /** the API booted, with the previous process's stop cause (`unknown` = crash, SIGKILL, reboot) */
  | 'server.started'
  | 'agent.create'
  /** an agent closed a parked task as done/cancelled without a run (docs/agent-api-design.md § Close and move) */
  | 'agent.close'
  | 'sentry.sync'
  /** a work-summary document was generated, re-run or deleted (docs/reports.md) */
  | 'report.changed'
  /** a shared space was created / edited / deleted, or a shared request/note changed (docs/shared-spaces.md) */
  | 'space.changed'
  /** a workspace (a named, scoped view over a set of repos) was created / edited / reordered / deleted (docs/workspaces.md) */
  | 'workspace.changed'
  /** a tailnet login passed the front door's remote gate for the first time this front-door boot (docs/remote-access.md) */
  | 'remote.login'
  | 'shared-note.changed'
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
  /** Continue resumed (or could not resume) a turn Pause all owed (docs/pause.md) */
  | 'task.paused'
  /** a turn ended with the agent's own background children still running, or that wait ended (docs/design.md § Waiting) */
  | 'task.waiting'
  /** a worker's AskUserQuestion reached the human / was answered / skipped by the autopilot / expired (docs/questions.md) */
  | 'question.asked'
  | 'question.answered'
  | 'question.autopilot'
  | 'question.expired'
  | 'approval.requested'
  | 'approval.decided'
  | 'approval.finished'
  /** an automatic turn was refused, or claiming stopped for the day, by a budget fuse (docs/token-budget.md § Fuses) */
  | 'task.budget'
  /** an anomaly notification went out — also the coalescing memory, so a restart does not re-ping (docs/push.md § What pings) */
  | 'anomaly.notified';

/** actor: human | hook | orchestrator | system | analyze | telegram | remote | autopilot | agent:<runId8> */
/**
 * `GET|PUT /api/sentry/token`: whether the Sentry auth token is set, and its
 * last 4 characters to recognise it by — never the value (it lives in
 * server/data/config.json, SECURITY.md § Secrets).
 */
export interface SentryTokenStatus {
  set: boolean;
  last4: string | null;
}

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

/**
 * The anomalies that are NOTIFIED (push kind `anomaly`, Telegram class
 * `anomaly`), one per task per type per episode — docs/push.md § What pings.
 */
export type AnomalyAlertType = 'long-run' | 'cost-high' | 'stale-review' | 'task-budget' | 'day-budget' | 'push-failed';

/** How every surface (push, Telegram) names an alert type — one record so they cannot drift. */
export const ANOMALY_ALERT_LABELS: Record<AnomalyAlertType, { icon: string; label: string }> = {
  'long-run': { icon: '🐢', label: 'Long run' },
  'cost-high': { icon: '💸', label: 'Expensive task' },
  'stale-review': { icon: '🕰', label: 'Stale review' },
  'task-budget': { icon: '🧯', label: 'Task budget reached' },
  'day-budget': { icon: '🧯', label: 'Day budget reached' },
  'push-failed': { icon: '⛔', label: 'Push to origin fails' },
};

export interface AnomalyAlert {
  type: AnomalyAlertType;
  severity: AnomalySeverity;
  /** one line, plain text */
  message: string;
  taskId: string | null;
  runId: string | null;
  /** the coalescing key — the same key never notifies twice */
  key: string;
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
  /**
   * Pause all is on (docs/pause.md): nothing automatic starts, live turns were
   * suspended. A server predating it omits it.
   */
  paused?: boolean;
  /** tasks Continue will resume (`Task.pausedTurn` set) */
  pausedTasks?: number;
  /** live non-idle worker PTYs — the concurrency numerator */
  running: number;
  concurrency: number;
  /**
   * Aux sessions alive right now — review, plan, plan-review, analysis,
   * compact, report, chat, commit terminals (docs/design.md § PTY sessions).
   * They live in their own PTY pool and take no worker slot, so they are
   * invisible to `running` — but a restart kills them just the same, which is
   * why the restart guard counts them too. Was `headless` before every such
   * run became a terminal; a server predating this field omits it.
   */
  aux: number;
  /**
   * Tasks parked in `waiting` by background shells alone — no subagent of
   * theirs still out — which a human may land now with Stop waiting
   * (`POST /api/tasks/:id/stop-waiting`, docs/design.md § Waiting). In
   * memory, so a server predating it omits it.
   */
  shellWaits?: string[];
  /**
   * Push preflight of every `delivery: 'pr'` repo (docs/parallel.md § Push
   * health): in memory, refreshed every 5 min and by every push the server
   * makes. A failing repo starts no new task and lands nothing until it
   * passes again. A server predating it omits it.
   */
  pushHealth?: RepoPushHealth[];
}

/** What a failed git network command says about its cause (`classifyGitFailure`). */
export type GitFailureKind = 'auth' | 'protected' | 'race' | 'network' | 'other';

/** One `pr` repo's push preflight — docs/parallel.md § Push health. */
export interface RepoPushHealth {
  repoId: string;
  repoName: string;
  /** ls-remote AND `push --dry-run` succeeded (or the last real push did) */
  ok: boolean;
  kind?: GitFailureKind;
  /** the git output's last lines, when failing */
  error?: string;
  /** which step failed: the base lookup, the read, or the write */
  step?: 'base' | 'ls-remote' | 'push' | 'fetch' | 'pr-sync' | 'land';
  checkedAt: string;
  /** when the current failure began (unset while ok) */
  failingSince?: string;
  /** `origin/<base>` */
  base?: string;
  /**
   * Commits on the LOCAL base branch that `origin/<base>` lacks: new worktrees
   * fork from origin, so they start without them (docs/parallel.md § Base branch).
   */
  localAhead?: number;
}

/**
 * An agent's background shell (docs/terminals.md § Background shells): a
 * `type: 'shell'` entry of a live worker run's latest Stop/SubagentStop
 * `background_tasks`, kept in memory until the run ends and broadcast as
 * `background-shells`. `state` is the server's own observation of the
 * process (a sweep every few seconds while one may be running); `cliStatus`
 * is what the CLI last said, at the end of a turn.
 */
export interface BackgroundShell {
  runId: string;
  taskId: string;
  taskTitle: string;
  repoId: string;
  /** the CLI's id (`background_tasks[].id`, the Bash result's `backgroundTaskId`) */
  shellId: string;
  command: string;
  description: string | null;
  cliStatus: string;
  state: 'running' | 'exited' | 'killed';
  pid: number | null;
  /** launch time from the transcript; when `startedKnown` is false, when a Stop first listed it */
  startedAt: string;
  startedKnown: boolean;
  /** it currently counts toward the task's `waiting` park (docs/design.md § Waiting) */
  holdsWait: boolean;
  /** the CLI reported an output file for it — the viewer can open it */
  hasOutput: boolean;
}

/** One read of a background shell's output file (`GET …/output?from=`). */
export interface BackgroundShellOutput {
  text: string;
  /** byte offset `text` starts at */
  from: number;
  /** byte offset to ask for next */
  next: number;
  /** the file's size at the read */
  size: number;
  /** the file shrank under the reader: drop what was shown and start over */
  reset: boolean;
}

/** `POST …/kill` and `POST /api/background-shells/kill-all`. */
export interface BackgroundShellKillResult {
  killed: { runId: string; shellId: string }[];
  missed: { runId: string; shellId: string; reason: string }[];
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
  /**
   * the agent's latest todo list in THIS run (TodoWrite, or TaskCreate/
   * TaskUpdate), counted — the board's work % (docs/task-progress.md); absent or
   * null when the run keeps none
   */
  todos?: import('./progress.ts').TodoCounts | null;
}

/**
 * Reports (docs/reports.md): a work-summary document over SEVERAL repos and a
 * date range, written by one headless claude pass over the task rows that
 * finished in the window. Unlike the Telegram report (`telegram/report.ts`),
 * which is an ops status page for the operator, this is the document you hand
 * to whoever paid for the work: Russian prose, grouped by completion DATE, one
 * concise business-language bullet per task, no run/token/cost machinery.
 */
export type ReportStatus = 'pending' | 'running' | 'ready' | 'failed';

/**
 * The presets behind the range picker. `custom` is the explicit from/to pair;
 * every other value is resolved server-side against the server's own clock so
 * "today" means the operator's today, not UTC's.
 */
export type ReportRangePreset = 'today' | '3d' | 'week' | 'month' | 'custom';

/**
 * The language the DOCUMENT is written in. It governs the agent's prose AND
 * the headings the server assembles around it, so a report is never half
 * Russian and half English. The SPA itself stays English — this is a property
 * of the artifact, not of the app.
 */
export type ReportLanguage = 'ru' | 'en';

export const REPORT_LANGUAGES: { value: ReportLanguage; label: string }[] = [
  { value: 'ru', label: 'Русский' },
  { value: 'en', label: 'English' },
];

export const REPORT_RANGE_PRESETS: { value: ReportRangePreset; label: string; days: number | null }[] = [
  { value: 'today', label: 'Today', days: 1 },
  { value: '3d', label: '3 days', days: 3 },
  { value: 'week', label: 'Week', days: 7 },
  { value: 'month', label: 'Month', days: 30 },
  { value: 'custom', label: 'Custom', days: null },
];

/** Widest window a single report may cover — past this it is an export, not a report. */
export const REPORT_MAX_DAYS = 366;

/** How many finished tasks one report will summarise before it starts dropping the oldest. */
export const REPORT_TASK_CAP = 400;

export interface Report {
  id: string;
  /** Document heading; defaults to the repo names joined, editable at creation. */
  title: string;
  /** Repos in scope — ALWAYS at least one; the picker allows several. */
  repoIds: string[];
  /**
   * Inclusive local calendar day bounds, `YYYY-MM-DD`. Stored as plain days
   * rather than instants because that is what the document prints and what the
   * human picked; the service widens them to local-midnight instants to query.
   */
  fromDate: string;
  toDate: string;
  preset: ReportRangePreset;
  language: ReportLanguage;
  status: ReportStatus;
  /** The finished document, Russian markdown. Null until the run lands. */
  markdown: string | null;
  /** One-line Russian gist, shown in the list without opening the document. */
  summary: string | null;
  /** How many finished tasks went in — the denominator behind the document. */
  taskCount: number;
  /** Model that wrote it, so a thin report can be re-run on a better one. */
  model: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A workspace (docs/workspaces.md): a named, scoped VIEW over a set of repos —
 * nothing more. Unlike a shared space it owns no folder and no ledger, a repo
 * may sit in any number of workspaces, and nothing a worker sees changes.
 * `repoIds` is filtered on read to repos that still exist.
 */
export interface Workspace {
  id: string;
  name: string;
  /** URL key: `WORKSPACE_SLUG_RE`, unique, never `WORKSPACE_RESERVED_SLUG`. A rename keeps it. */
  slug: string;
  repoIds: string[];
  /** group palette slot, 1..GROUP_COLOR_COUNT; null = uncoloured */
  color: number | null;
  /** position in the switcher (ascending; ties by name) */
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export const WORKSPACE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The slug the "every repo" view answers to, so no workspace may take it. */
export const WORKSPACE_RESERVED_SLUG = 'all';
const WORKSPACE_SLUG_MAX = 40;

/**
 * A name's slug — always matches `WORKSPACE_SLUG_RE`: accents folded, every
 * other run of non-[a-z0-9] a single `-`, at most 40 chars, and `workspace`
 * when nothing is left (a name in Cyrillic, say). It may still be the
 * reserved `all` or taken; `uniqueWorkspaceSlug` settles those.
 */
export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, WORKSPACE_SLUG_MAX)
    .replace(/-+$/, '');
  return s || 'workspace';
}

/**
 * `slugify(name)`, or `<slug>-2`, `-3`… (truncated to fit 40) when it is
 * reserved or already in `taken`.
 */
export function uniqueWorkspaceSlug(name: string, taken: ReadonlySet<string> | readonly string[]): string {
  const set = taken instanceof Set ? taken : new Set(taken as readonly string[]);
  const base = slugify(name);
  const free = (s: string) => s !== WORKSPACE_RESERVED_SLUG && !set.has(s);
  if (free(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const s = base.slice(0, WORKSPACE_SLUG_MAX - suffix.length).replace(/-+$/, '') + suffix;
    if (free(s)) return s;
  }
}

/**
 * A shared space (docs/shared-spaces.md): a set of repos that work on one
 * product and share one persistent knowledge folder plus a ledger of
 * cross-repo requests and notes. A repo belongs to at most ONE space, so a
 * worker has exactly one `$TM_SHARED_DIR`.
 */
export interface Space {
  id: string;
  name: string;
  /** Absolute folder on disk (outside every repo) — the knowledge base agents and humans read. */
  path: string;
  /** Member repos; at least one. */
  repoIds: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * `request` — work a repo still has to do because of another repo's change or
 * finding (`toRepoId` required, never the author's own repo). `note` — durable
 * knowledge for every member (`toRepoId` null, or a repo it mainly concerns).
 */
export type SharedNoteKind = 'request' | 'note';
export const SHARED_NOTE_KINDS: SharedNoteKind[] = ['request', 'note'];

/**
 * open → filed (a task exists for it) → done; dismissed = withdrawn / not
 * needed / archived note. A `filed` request whose task is cancelled or deleted
 * reopens; one whose task lands done/published resolves (reconciled on read).
 */
export type SharedNoteStatus = 'open' | 'filed' | 'done' | 'dismissed';
export const SHARED_NOTE_STATUSES: SharedNoteStatus[] = ['open', 'filed', 'done', 'dismissed'];
/**
 * A `filed` request whose task sits in one of these waits on a HUMAN: a draft
 * nobody enqueued, or a failed run nobody retried. It stays `filed` (the task
 * still owns it — reopening would invite a duplicate filing beside a retry),
 * so the Shared page and Telegram `/shared` flag it as "needs you" instead.
 */
export const SHARED_FILING_STALLED: readonly TaskStatus[] = ['draft', 'failed'];

export interface SharedNote {
  id: string;
  spaceId: string;
  kind: SharedNoteKind;
  title: string;
  /** Markdown; a self-contained contract for a request. */
  body: string;
  /** Author repo (null = written by a human). */
  fromRepoId: string | null;
  /** Author task (agent-written notes). */
  fromTaskId: string | null;
  toRepoId: string | null;
  status: SharedNoteStatus;
  /** The task filed for a request (`filed`/`done`). */
  taskId: string | null;
  /** How it was resolved or why it was dismissed. */
  resolution: string | null;
  /** Paths RELATIVE to the space folder that the note refers to. */
  files: string[];
  /** 'human' | 'telegram' | 'agent:<runId8>' | 'import' */
  actor: string;
  createdAt: string;
  updatedAt: string;
}

/** A file in a space folder, as listed by the Shared page. */
export interface SpaceFile {
  /** Relative to the space folder, `/`-separated. */
  path: string;
  size: number;
  mtime: string;
}

/**
 * Task files the panel previews (thumbnail + lightbox), by lower-case extension
 * → the Content-Type `GET /api/tasks/:id/files/:name?inline=1` serves them as.
 * Everything else is a download only (docs/handbook.md § Follow-ups & files).
 * HEIC is left out: only Safari decodes it, so Chrome would show a broken tile.
 */
export const IMAGE_PREVIEW_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

/** The preview Content-Type for a file name, or null when it is not an image we preview. */
export function imagePreviewType(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(IMAGE_PREVIEW_TYPES, ext) ? IMAGE_PREVIEW_TYPES[ext] : null;
}

/** a file-name character: a name preceded or followed by one is part of a longer name */
const NAME_CHAR = /[\p{L}\p{N}_-]/u;

/**
 * The file names out of `names` that `text` mentions, in order of first
 * mention (docs/questions.md § Images). A mention is the exact name standing
 * on its own — bare, in backticks, in a markdown `![](…)`, or at the end of a
 * path (`$TM_ARTIFACTS_DIR/a.png`) — so `a.png` is not found inside
 * `data.png`, `a.png.bak` or `a.png2`. A name only found inside a longer
 * mentioned name (`a.png` within `mock a.png`) is dropped.
 */
export function referencedFileNames(text: string, names: readonly string[]): string[] {
  if (!text) return [];
  const standsAlone = (at: number, end: number) => {
    const before = at > 0 ? text[at - 1] : '';
    const after = text[end] ?? '';
    return (
      !(before && (NAME_CHAR.test(before) || before === '.')) &&
      !(after && (NAME_CHAR.test(after) || (after === '.' && NAME_CHAR.test(text[end + 1] ?? ''))))
    );
  };
  // longest first, so every mention of a longer name is covered before a
  // shorter name inside it is looked at
  const covered: [number, number][] = [];
  const first = new Map<string, number>();
  for (const name of [...new Set(names)].filter(Boolean).sort((x, y) => y.length - x.length)) {
    const mine: [number, number][] = [];
    for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
      const end = at + name.length;
      if (!standsAlone(at, end) || covered.some(([s, e]) => s <= at && end <= e)) continue;
      mine.push([at, end]);
      if (!first.has(name)) first.set(name, at);
    }
    covered.push(...mine);
  }
  return [...first].sort((x, y) => x[1] - y[1]).map(([name]) => name);
}

export type ServerEvent =
  | { type: 'task.updated'; task: Task }
  | { type: 'task.deleted'; taskId: string }
  | { type: 'run.started'; run: Run }
  | { type: 'run.updated'; run: Run }
  | { type: 'run.exited'; run: Run }
  | {
      type: 'run.needs-attention';
      run: Run;
      /** set when the flag was raised by the `budget.runMinutes` fuse rather than by a prompt; the ping says so */
      reason?: 'run-minutes';
      /** with reason 'run-minutes': the cap that was crossed */
      minutes?: number;
    }
  | { type: 'anomaly.raised'; alert: AnomalyAlert }
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
  | { type: 'approval.updated'; approval: Approval }
  | { type: 'report.updated'; report: Report }
  | { type: 'report.deleted'; reportId: string }
  | { type: 'space.updated'; space: Space }
  | { type: 'space.deleted'; spaceId: string }
  | { type: 'workspace.updated'; workspace: Workspace }
  | { type: 'workspace.deleted'; workspaceId: string }
  | { type: 'shared-note.updated'; note: SharedNote }
  | { type: 'shared-note.deleted'; noteId: string }
  | { type: 'background-shells'; shells: BackgroundShell[] }
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
  host: {
    port: number;
    dev: boolean;
    spaBuilt: boolean;
    /** `web/dist/build.json`'s id — what a page loaded NOW would run; null when
     *  unbuilt, or in dev where Vite serves source (absent on an older host). */
    buildId?: string | null;
    /** host.ts (or a module it imports) changed since this front door booted:
     *  Rebuild & restart cannot reload it, a full `npm start` restart can. */
    stale?: boolean;
  };
  /** The Rebuild & restart job (absent on a front door that predates it). */
  rebuild?: RebuildJob;
}

/**
 * Rebuild & restart (docs/host.md § Rebuild & restart): one job at a time in
 * the FRONT DOOR's lifetime — it outlives the API it restarts.
 */
export type RebuildState =
  | 'idle'
  | 'draining'
  | 'building'
  | 'typechecking'
  | 'restarting'
  | 'continuing'
  | 'done'
  | 'failed';

/**
 * What a draining job still waits for (docs/host.md § Drain): the restart
 * check's own counts, plus the aux sessions a pause does NOT finish — chats,
 * reports, feature plans and analyses are human-started and not pause-aware,
 * so the drain names them instead of waiting on them silently.
 */
export interface RebuildWaitingFor {
  /** live worker turns (they finish on their own under the drain's pause) */
  running: number;
  /** every live aux session's label */
  aux: string[];
  /** the subset of `aux` the pause will not end: stop them, or force */
  notPauseAware: string[];
}

export interface RebuildJob {
  state: RebuildState;
  startedAt: string | null;
  finishedAt: string | null;
  /** human words for where it is ("Building the web app…") */
  step: string | null;
  error: string | null;
  /** machine reason on a refusal or failure: `not_quiet` when an agent started
   *  mid-job, `build`, `typecheck`, `restart`, `timeout`; drain mode adds
   *  `drain_timeout`, `cancelled`, `pause` (the pause call failed) */
  reason: string | null;
  /** last lines of the failing (or last) step's output */
  logTail: string;
  /** the id of the build this job produced (null in dev or before the build) */
  buildId: string | null;
  /** host.ts changed since the front door booted — needs a full restart */
  hostStale: boolean;
  /** dev mode: no build, Vite serves source */
  dev: boolean;
  /** the API's bootedAt before and after the restart */
  bootedBefore: string | null;
  bootedAfter: string | null;
  /** drain mode: pause (without suspending), let live work finish, then restart */
  drain: boolean;
  /** when a drain gives up (ISO); null when not draining */
  drainDeadline: string | null;
  /** the drain's latest restart-check reading; null when not draining */
  waitingFor: RebuildWaitingFor | null;
  /** the job set `orchestrator.paused` itself (it was not paused before), so it — and only it — presses Continue */
  pausedByJob: boolean;
  /** after the restart: true = the job pressed Continue, false = left paused (not its pause, or Continue failed), null = n/a */
  continued: boolean | null;
}

// ---- Web Push (docs/push.md) ----

/** What a Home Screen device can be pinged about; chosen per device. */
export type PushKind =
  | 'question'
  | 'approval'
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
  | 'queue'
  | 'anomaly';

/** The one list every surface renders (SPA toggles, server validation, defaults). */
export const PUSH_KINDS: { kind: PushKind; label: string; hint: string; default: boolean }[] = [
  { kind: 'question', label: 'Questions', hint: 'an agent asks you something (AskUserQuestion)', default: true },
  { kind: 'approval', label: 'Approvals', hint: 'an agent asks you to approve a push, a restart, mark published…', default: true },
  { kind: 'attention', label: 'Needs attention', hint: 'an agent is stuck on a prompt in its hidden terminal', default: true },
  { kind: 'review', label: 'Ready for review', hint: 'a task landed in review, with the reviewer’s verdict', default: true },
  { kind: 'done', label: 'Done', hint: 'a task the orchestrator landed on its own (on-green: checks green, review clean)', default: true },
  { kind: 'failed', label: 'Failed', hint: 'a task failed', default: true },
  { kind: 'blocked', label: 'Blocked', hint: 'a task is waiting on its subtasks', default: true },
  { kind: 'published', label: 'Published', hint: 'a task was committed and pushed', default: true },
  { kind: 'started', label: 'Started', hint: 'an agent picked a task up', default: false },
  { kind: 'proposal', label: 'Proposals', hint: 'an agent proposed a split or follow-up', default: true },
  { kind: 'feature', label: 'Features', hint: 'a feature plan is ready to approve, or a feature paused', default: true },
  { kind: 'chat', label: 'Chat replies', hint: 'claude answered in a chat', default: true },
  { kind: 'report', label: 'Reports', hint: 'a client report finished or failed', default: true },
  { kind: 'queue', label: 'Queue drained', hint: 'nothing queued, nothing running', default: true },
  {
    kind: 'anomaly',
    label: 'Anomalies',
    hint: 'a long run, an expensive task, a stale review, or a budget fuse tripped',
    default: true,
  },
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

// ---- Inbox (docs/inbox.md) --------------------------------------------------

export type InboxKind = 'question' | 'approval' | 'attention' | 'review' | 'failed' | 'blocked' | 'proposal' | 'feature' | 'stale-draft';

/**
 * The order the kinds are listed in — by how much one decision unblocks: a
 * question or a permission prompt holds a LIVE session (its slot and its
 * repo), an approval holds the agent waiting on it, a review holds a landing (and any later feature phase), a failure
 * holds a retry, a blocked split parent its tree; proposals and planned
 * features are new work nobody waits on yet; a stale agent draft is backlog
 * hygiene — last, because nothing at all waits on it.
 */
export const INBOX_KINDS: InboxKind[] = ['question', 'approval', 'attention', 'review', 'failed', 'blocked', 'proposal', 'feature', 'stale-draft'];

/** A `failed` task older than this has been seen and left alone — it drops out of the inbox (the board still lists it). */
export const INBOX_FAILED_DAYS = 7;

/** At most this many stale drafts are listed; the rest is a count (`total`) the surfaces show as "N more". */
export const INBOX_STALE_DRAFT_CAP = 10;

/**
 * An agent-filed draft nobody has triaged (docs/inbox.md § Stale drafts): filed
 * by an agent or an outside source (`isExternalTask`), still `draft`, not
 * hidden, created more than `days` ago (`createdAt`, never `updatedAt` — a hide
 * toggle or an edit moves that), and not kept within the last window
 * (`inboxKeptUntil` in the past or unset). The JS rule IS the rule — no SQL twin.
 */
export function isStaleDraft(t: Task, now: number, days: number): boolean {
  if (t.status !== 'draft' || t.hiddenAt || !isExternalTask(t)) return false;
  if (Date.parse(t.createdAt) > now - days * 86_400_000) return false;
  return !t.inboxKeptUntil || Date.parse(t.inboxKeptUntil) <= now;
}

interface InboxBase {
  /** stable list key: `<kind>:<id>` */
  key: string;
  /**
   * open tasks this decision releases besides the item itself: later-phase
   * tasks of its feature (the phase gate waits on it) plus blocked split
   * ancestors (a parent waits on every child). The within-kind sort key.
   */
  unblocks: number;
}

export type InboxItem =
  | (InboxBase & { kind: 'question'; task: Task; questions: Question[] })
  | (InboxBase & { kind: 'approval'; approval: Approval; task: Task | null })
  | (InboxBase & { kind: 'attention'; task: Task; run: Run })
  | (InboxBase & {
      kind: 'review';
      task: Task;
      /** `landingReason` — non-null means checks green/none AND review clean/none: one keystroke lands it */
      ready: string | null;
    })
  | (InboxBase & { kind: 'failed'; task: Task })
  | (InboxBase & { kind: 'blocked'; task: Task; children: { total: number; open: number; failed: number } })
  | (InboxBase & { kind: 'proposal'; proposal: Proposal; task: Task | null })
  | (InboxBase & { kind: 'feature'; feature: Feature })
  | (InboxBase & {
      kind: 'stale-draft';
      task: Task;
      /** whole days since it was filed */
      ageDays: number;
      /** every stale draft the input holds; only the oldest `INBOX_STALE_DRAFT_CAP` are items — the rest is "N more" */
      total: number;
    });

export interface InboxInput {
  tasks: Task[];
  /** pending ones are used; others are ignored */
  questions: Question[];
  /** pending ones are used (optional: older callers pass none) */
  approvals?: Approval[];
  /** live runs; a `running` task's non-idle run flagged needsAttention is an item */
  runs: Run[];
  /** pending ones are used */
  proposals: Proposal[];
  /** `proposed` ones are used */
  features: Feature[];
  now?: number;
  /** `inbox.staleDraftDays`; the default when omitted */
  staleDraftDays?: number;
  /**
   * The current workspace's repos (docs/workspaces.md): only items whose repo
   * is in the set are emitted; an item with no repo is always in scope.
   * `unblocks` still counts every task. Absent/null = every repo.
   */
  repoIds?: ReadonlySet<string> | null;
}

/** The repo an inbox item belongs to, or null (repo-less: in every scope). */
export function inboxItemRepoId(item: InboxItem): string | null {
  if (item.kind === 'proposal') return item.proposal.repoId ?? item.task?.repoId ?? null;
  if (item.kind === 'approval') return item.approval.repoId ?? item.task?.repoId ?? null;
  if (item.kind === 'feature') return item.feature.repoId ?? null;
  return item.task.repoId ?? null;
}

/**
 * Everything waiting on the human, in decision order (docs/inbox.md). Pure and
 * shared, so the SPA's Inbox page, its header chip and Telegram's `/inbox`
 * board view list the same items in the same order. A task appears once, under
 * its most urgent kind. Not in it: a `review` task whose automatic verify round
 * is still open (`verifyOpen` — the machine is not done with it yet), and a
 * `waiting` task (background work, nobody's decision).
 */
export function buildInbox(input: InboxInput): InboxItem[] {
  const now = input.now ?? Date.now();
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const open = (t: Task) => !TERMINAL_TASK_STATUSES.includes(t.status);
  const unblocks = (t: Task): number => {
    let n = 0;
    if (t.featureId != null && t.featurePhase != null) {
      for (const o of input.tasks) {
        if (o.featureId === t.featureId && (o.featurePhase ?? 0) > t.featurePhase && open(o)) n++;
      }
    }
    for (const id of groupAncestors(t)) if (byId.get(id)?.status === 'blocked') n++;
    return n;
  };
  const oldest = (a: Task, b: Task) => a.updatedAt.localeCompare(b.updatedAt);
  const byWeight = (a: { unblocks: number; at: string }, b: { unblocks: number; at: string }) =>
    b.unblocks - a.unblocks || a.at.localeCompare(b.at);
  const seen = new Set<string>();
  const scope = input.repoIds ?? null;
  const inScope = (repoId: string | null | undefined) => !scope || repoId == null || scope.has(repoId);
  const out: InboxItem[] = [];

  // questions — one item per task, however many it asks
  const asked = new Map<string, Question[]>();
  for (const q of input.questions) {
    if (q.status !== 'pending' || !byId.has(q.taskId)) continue;
    asked.set(q.taskId, [...(asked.get(q.taskId) ?? []), q]);
  }
  const questions = [...asked].map(([taskId, qs]) => {
    const task = byId.get(taskId)!;
    const sorted = [...qs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { task, qs: sorted, unblocks: unblocks(task), at: sorted[0].createdAt };
  });
  for (const q of questions.sort(byWeight)) {
    seen.add(q.task.id);
    out.push({ kind: 'question', key: `question:${q.task.id}`, task: q.task, questions: q.qs, unblocks: q.unblocks });
  }

  // approvals — oldest first; one item per request (each is its own decision)
  for (const a of [...(input.approvals ?? [])].filter((a) => a.status === 'pending').sort((x, y) => x.createdAt.localeCompare(y.createdAt))) {
    out.push({ kind: 'approval', key: `approval:${a.id}`, approval: a, task: a.taskId ? byId.get(a.taskId) ?? null : null, unblocks: 0 });
  }

  // permission prompts / needs-attention on a live worker
  const attention: { task: Task; run: Run; unblocks: number; at: string }[] = [];
  for (const r of input.runs) {
    if (r.status !== 'running' || r.idle || !r.needsAttention || !r.taskId) continue;
    const task = byId.get(r.taskId);
    if (!task || task.status !== 'running' || seen.has(task.id)) continue;
    seen.add(task.id);
    attention.push({ task, run: r, unblocks: unblocks(task), at: r.startedAt });
  }
  for (const a of attention.sort(byWeight)) {
    out.push({ kind: 'attention', key: `attention:${a.task.id}`, task: a.task, run: a.run, unblocks: a.unblocks });
  }

  const taskKind = <K extends 'review' | 'failed' | 'blocked'>(
    kind: K,
    match: (t: Task) => boolean,
    extra: (t: Task) => Omit<Extract<InboxItem, { kind: K }>, 'kind' | 'key' | 'task' | 'unblocks'>,
    first?: (t: Task) => boolean,
  ) => {
    const rows = input.tasks
      .filter((t) => !seen.has(t.id) && match(t))
      .map((t) => ({ t, unblocks: unblocks(t), at: t.updatedAt }))
      .sort(
        (a, b) =>
          b.unblocks - a.unblocks || (first ? Number(first(b.t)) - Number(first(a.t)) : 0) || oldest(a.t, b.t),
      );
    for (const r of rows) {
      seen.add(r.t.id);
      out.push({ kind, key: `${kind}:${r.t.id}`, task: r.t, unblocks: r.unblocks, ...extra(r.t) } as InboxItem);
    }
  };

  // review — a ready one (one keystroke lands it) ahead of one that needs reading
  taskKind(
    'review',
    // a task Pause all suspended is not waiting on the human (docs/pause.md)
    (t) => t.status === 'review' && !verifyOpen(t) && !t.pausedTurn,
    (t) => ({ ready: landingReason(t) }),
    (t) => landingReason(t) !== null,
  );
  // recent failures
  const since = new Date(now - INBOX_FAILED_DAYS * 86_400_000).toISOString();
  taskKind('failed', (t) => t.status === 'failed' && t.updatedAt >= since, () => ({}));
  // blocked split parents
  taskKind(
    'blocked',
    (t) => t.status === 'blocked',
    (t) => {
      const kids = input.tasks.filter((c) => c.parentId === t.id);
      return {
        children: {
          total: kids.length,
          open: kids.filter(open).length,
          failed: kids.filter((c) => c.status === 'failed').length,
        },
      };
    },
  );

  // proposals — oldest first
  for (const p of [...input.proposals].filter((p) => p.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    out.push({ kind: 'proposal', key: `proposal:${p.id}`, proposal: p, task: p.taskId ? byId.get(p.taskId) ?? null : null, unblocks: 0 });
  }
  // planned features waiting for approval
  for (const f of [...input.features].filter((f) => f.status === 'proposed').sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    out.push({ kind: 'feature', key: `feature:${f.id}`, feature: f, unblocks: 0 });
  }
  // stale agent drafts — oldest filed first, capped (never auto-cancelled or auto-hidden: a surface, not a sweep)
  const days = input.staleDraftDays ?? DEFAULT_SETTINGS['inbox.staleDraftDays'];
  const stale = input.tasks
    .filter((t) => !seen.has(t.id) && isStaleDraft(t, now, days) && inScope(t.repoId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const t of stale.slice(0, INBOX_STALE_DRAFT_CAP)) {
    const ageDays = Math.floor((now - Date.parse(t.createdAt)) / 86_400_000);
    out.push({ kind: 'stale-draft', key: `stale-draft:${t.id}`, task: t, ageDays, total: stale.length, unblocks: 0 });
  }
  // the workspace scope: every weight above was counted over ALL tasks; stale drafts are already scoped (cap + total)
  return scope ? out.filter((i) => inScope(inboxItemRepoId(i))) : out;
}

// ---- Bulk actions (docs/inbox.md § Bulk actions) ----------------------------

export type BulkAction = 'enqueue' | 'queue' | 'cancel' | 'complete' | 'hide' | 'unhide' | 'edit' | 'keep';
export const BULK_ACTIONS: BulkAction[] = ['enqueue', 'queue', 'cancel', 'complete', 'hide', 'unhide', 'edit', 'keep'];
/** ids per bulk call */
export const BULK_MAX = 100;

export interface BulkRequest {
  action: BulkAction;
  ids: string[];
  /** `edit` only: the per-task overrides it sets (null = back to the default) */
  patch?: { model?: string | null; effort?: EffortLevel | null };
  /** `cancel` only: recorded on each `task.transition` audit row (e.g. "stale draft triage") */
  reason?: string;
}

/** One id's outcome; a refusal is reported here, never fatal to the batch. */
export type BulkResult = { id: string; ok: true; task: Task } | { id: string; ok: false; code: number; error: string };

export interface BulkResponse {
  action: BulkAction;
  results: BulkResult[];
  ok: number;
  failed: number;
}

// ---- Task content templates (docs/inbox.md § Templates) ---------------------

/**
 * Reusable task CONTENT ("Bug fix", "UI change + screenshot"), stored as the
 * `task.templates` setting. A template fills the form; it is never a live link
 * — editing it later changes no task. Model/effort/review stay the job of
 * presets: a template only names one (`preset`).
 */
export interface TaskTemplate {
  /** `TASK_TEMPLATE_ID_RE` — short enough for a Telegram `w:` callback */
  id: string;
  name: string;
  /** title pattern: `{}` is where the typed title goes; without `{}` it is a prefix */
  title: string;
  /** description skeleton ('' = none) */
  description: string;
  /** definition of done ('' = none) */
  acceptance: string;
  /** repo check names to run; null = the repo's default (all) */
  checks: string[] | null;
  /** a `TaskPreset` id (built-in or custom); null = none */
  preset: string | null;
}

export const TASK_TEMPLATE_MAX = 20;
export const TASK_TEMPLATE_NAME_MAX = 32;
export const TASK_TEMPLATE_ID_RE = /^t-[a-z0-9]{4,16}$/;

/** The title a template's pattern makes of what was typed. Empty typed text leaves the pattern's fixed part. */
export function applyTitlePattern(pattern: string, typed: string): string {
  const t = typed.trim();
  if (!pattern.trim()) return t;
  if (pattern.includes('{}')) return pattern.replace('{}', t).replace(/\s+/g, ' ').trim();
  return t ? `${pattern.trimEnd()} ${t}` : pattern.trim();
}

/** The description a skeleton makes of what was typed: the typed text on top, the skeleton below it. */
export function applyDescriptionSkeleton(skeleton: string, typed: string): string {
  const t = typed.trim();
  const s = skeleton.trim();
  return [t, s].filter(Boolean).join('\n\n');
}

/**
 * The checks a template selects IN ONE REPO: check names belong to a repo, so
 * only the names that repo actually has are kept. A template whose names match
 * none of the repo's checks falls back to null (all of them) — a template
 * written for another repo must never silently switch the checks off.
 */
export function templateChecksFor(template: Pick<TaskTemplate, 'checks'>, repoCheckNames: string[]): string[] | null {
  if (template.checks == null) return null;
  if (!template.checks.length) return [];
  const kept = template.checks.filter((n) => repoCheckNames.includes(n));
  return kept.length ? kept : null;
}

/** Why a `task.templates` list cannot be saved, or null. Shared by the settings route and the Config page. */
export function taskTemplateProblem(list: TaskTemplate[], presets: TaskPreset[] = TASK_PRESETS): string | null {
  if (list.length > TASK_TEMPLATE_MAX) return `at most ${TASK_TEMPLATE_MAX} templates`;
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const t of list) {
    const name = t.name.trim();
    const label = name || '(unnamed)';
    if (!TASK_TEMPLATE_ID_RE.test(t.id)) return `template "${label}": invalid id`;
    if (ids.has(t.id)) return `template "${label}": duplicate id`;
    ids.add(t.id);
    if (!name) return 'every template needs a name';
    if (name.length > TASK_TEMPLATE_NAME_MAX) return `template "${name}": name is over ${TASK_TEMPLATE_NAME_MAX} characters`;
    if (names.has(name.toLowerCase())) return `template "${name}": the name is already used`;
    names.add(name.toLowerCase());
    if (t.title.length > 200) return `template "${name}": title pattern is over 200 characters`;
    if ((t.title.match(/\{\}/g) ?? []).length > 1) return `template "${name}": the title pattern may hold one {} slot`;
    if (t.description.length > 8000) return `template "${name}": description is over 8000 characters`;
    if (t.acceptance.length > 4000) return `template "${name}": definition of done is over 4000 characters`;
    if (t.checks != null && (!Array.isArray(t.checks) || t.checks.some((c) => typeof c !== 'string' || !c.trim())))
      return `template "${name}": invalid checks`;
    if (t.preset != null && !presets.some((p) => p.id === t.preset)) return `template "${name}": unknown preset`;
  }
  return null;
}

// Approximate progress % of a live task (docs/task-progress.md)
export * from './progress.ts';
export * from './schedule.ts';

// Timeline past segments (docs/timeline.md)
export * from './timeline.ts';
