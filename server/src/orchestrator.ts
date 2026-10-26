import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CHECK_BUSY_STATES,
  LOOP_CONTINUABLE_STATES,
  effectiveLanding,
  isCodexModel,
  landingReason,
  verifyOpen,
  runTaskId,
  REVIEW_NOW_FROM,
  type AppSettings,
  type CheckResult,
  type CheckState,
  type Dispatch,
  type LoopIteration,
  type LoopState,
  type LandingTier,
  type Repo,
  type ReviewRound,
  type ReviewState,
  type Run,
  type Task,
  type TaskStatus,
} from '@tm/shared';
import type { ActionResult, OrchestratorApi } from './app-types.ts';
import {
  DEFAULT_PROCEED,
  PUBLISH_INSTRUCTION,
  publishUpToInstruction,
  buildDispatchNote,
  buildDispatchTurn,
  buildWorkerInvocation,
} from './claude/worker.ts';
import {
  abortAllCompactions,
  abortCompaction,
  changedFiles,
  compactFocus,
  compactSession,
  freshHandoff,
} from './claude/compact.ts';
import {
  classifyStopFailure,
  stopFailureError,
  TRANSIENT_BACKOFF_MS,
  TRANSIENT_CONTINUE,
  TRANSIENT_SUBMIT_CHECK_MS,
  TYPE_ENTER_DELAY_MS,
} from './claude/transient.ts';
import {
  handoffCommit,
  hasTaskCommit,
  publishRepo,
  pushUpTo,
  unpushedCommits,
  verifyPublished,
  type PublishCheck,
} from './git.ts';
import { aux } from './claude/aux.ts';
import { headAt, readHeadBase, reviewWorkerChange, workerDiff, type ChangeScope } from './claude/review.ts';
import { summarizeRun, summarizeTranscript, type TranscriptSummary } from './claude/stats.ts';
import { liveWindow, readAccountUsage } from './claude/account-usage.ts';
import {
  LIVE_TAIL_STRICT_CHARS,
  assessLimitStall,
  resolveWakeAt,
  type AccountView,
  type StallVerdict,
} from './claude/limit.ts';
import { needsFallbackModel, sessionUsagePct } from './claude/usage.ts';
import { sharedPromptBlock, spaceForRepo, validateSpacePath, writeFolderDocs, writeSharedMemory } from './spaces/service.ts';
import { broadcast } from './events.ts';
import { AnomalyAlerts } from './anomalies.ts';
import { checkFixMessage, checksVerdict, definitionOfDone, runChecks, selectChecks } from './checks.ts';
import type { CommandRunner } from './commands/runner.ts';
import {
  loopMetric,
  loopNote,
  loopResultBlock,
  loopStop,
  loopStopText,
  maxIterations,
  noProgress,
  noProgressStreak,
  parseLoopResult,
  readLedger,
} from './loop.ts';
import {
  broadcastTaskCost,
  budgetAllows,
  loopBudget,
  localDayKey,
  runMinutesCap,
  type BudgetTurn,
  type BudgetVerdict,
} from './budget.ts';
import { MAX_LIVE_SESSIONS, pidLooksLikeOurs, type SessionManager } from './pty/session-manager.ts';
import { artifactsRoot } from './config.ts';
import type { Storage } from './storage/types.ts';
import { QuestionService } from './questions.ts';

/** Upper bound on how long a custom-queue hold may outlive its follow-on (docs/queue.md). */
const CUSTOM_QUEUE_HOLD_TTL_MS = 30 * 60_000;

/**
 * Statuses after which an `fyi` dispatch is recorded as a note instead of
 * waiting for a resume that is never coming (docs/dispatch.md § Intent).
 *
 * Deliberately NOT `TERMINAL_TASK_STATUSES`: that set also contains `failed`,
 * and a failed task is the one terminal-looking status a human routinely
 * retries or proceeds — an `fyi` should still be there waiting when it does.
 */
const DISPATCH_TERMINAL_STATUSES: TaskStatus[] = ['done', 'published', 'cancelled'];

/**
 * The only statuses an auto wake-up acts on (docs/wake.md) — an allow-list,
 * not an exclusion list, so a task that moved on under a human's hand loses
 * its pending wake-up by default rather than by enumeration.
 *
 * `failed` is IN, deliberately: a turn cut short by the usage limit is exactly
 * what lands there, and reopening it is the whole point. `queued` and `draft`
 * are OUT even though `followUp` would accept them — a retried or re-enqueued
 * task belongs to the claim loop now, and waking it would jump that queue.
 *
 * `running` is OUT because a wake could never have worked from it: `followUp`
 * refuses a running task, whether its session is live and busy ("the agent is
 * still working") or gone ("marked running but has no live session"). A live
 * stall is therefore ENDED at park time — the run is killed and the task moved
 * to `review` — rather than parked where nothing could resume it (review R1).
 */
const WAKE_RESUMABLE_STATUSES: TaskStatus[] = ['review', 'failed'];

/** `tm_runs.label` of a worker run that is a publish turn. */
const PUBLISH_RUN_LABEL = 'publish';

/**
 * The actor of an automatic landing (docs/design.md § Landing tiers): an
 * on-green `review → done` and the publish an auto-publish tier starts. Kept
 * apart from 'system' so the audit log tells a landing from a sweep.
 */
const LANDING_ACTOR = 'orchestrator';

/**
 * Tasks whose work has not been approved yet (docs/queue.md § Stacked tasks):
 * their unpushed commits must not ride along on another task's publish.
 * `queued`/`draft` are here for a task an Undo start put back (review round
 * 2): its hand-off commit is unfinished work. done/published work may ride
 * along; failed/cancelled leftovers are outside the rule (there is no way to
 * approve them short of a retry, and they rode along before this rule too).
 */
const UNAPPROVED_STATUSES: TaskStatus[] = ['review', 'running', 'waiting', 'blocked', 'queued', 'draft'];

type PublishPlan =
  | { kind: 'full' }
  | { kind: 'refuse'; reason: string }
  | {
      kind: 'partial';
      /** this task's last unpushed commit; null = its commits are all pushed already */
      upTo: string | null;
      remote: string;
      mergeRef: string;
      upstream: string;
    };

/**
 * How long a live session must have written nothing to its transcript before a
 * banner at the end of its terminal is read as a stall rather than as work in
 * progress. The transcript is the right clock: it advances on every assistant
 * message and tool result, and unlike the terminal it is not rewritten by
 * cursor redraws, so a session that is thinking is never mistaken for a stuck
 * one and a stuck one goes quiet immediately.
 */
const STALL_QUIET_MS = 2 * 60_000;

/** What the resume gate decided for one spawn (docs/token-budget.md § The fourth). */
/** One turn's automatic resumes after transient API errors (docs/design.md § Transient API errors). */
interface TransientRetry {
  /** the run whose StopFailure armed this resume */
  runId: string;
  /** resumes this turn has used, INCLUDING the one armed */
  attempts: number;
  code: string;
  timer: NodeJS.Timeout | null;
}

interface ResumeHandoff {
  /**
   * `abort` is not a handoff at all: WE stopped the compaction (`/killall`, a
   * forced restart, the task being cancelled underneath it), so the turn must
   * not happen. It is a separate kind rather than a flavour of `fresh` because
   * the answer to a failed compaction is to spawn an agent, and spawning one
   * seconds after an emergency stop said everything was dead is precisely the
   * outcome this distinction prevents.
   */
  kind: 'resume' | 'compact' | 'fresh' | 'abort';
  /** the richer `Previous run summary` a declined resume hands the new session */
  previousSummary?: string;
  /** extra `run.started` fields explaining the decision */
  detail?: Record<string, unknown>;
}

/**
 * The state a settled review loop reads as, from the latest round the task
 * received: `passed` when nothing blocker/major is open, `flagged` when
 * something is, `error` when the reviewer could not run, `skipped` when the
 * task was never really reviewed.
 */
/** Bytes in a transcript, or null when there is none to read. */
function fileSize(p: string | null | undefined): number | null {
  if (!p) return null;
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

export function settledReviewState(rounds: ReviewRound[]): ReviewState {
  const last = rounds[rounds.length - 1];
  if (!last) return 'skipped';
  if (last.error) return 'error';
  return last.findings.some((f) => f.severity === 'blocker' || f.severity === 'major') ? 'flagged' : 'passed';
}

export class Orchestrator implements OrchestratorApi {
  private scheduling = false;
  private rescheduleRequested = false;
  /**
   * Per-task FIX-round budget for the work→review→work loop (bounded by
   * `review.maxRounds`). Distinct from `task.reviewRounds`, which is the
   * persisted history of every review the task received: this counter is
   * reset whenever the loop settles or a human re-arms it (applyReviewFixes).
   */
  private fixRounds = new Map<string, number>();
  /**
   * Per-task CHECK-fix loop (docs/checks.md), bounded by `checks.maxRounds`:
   * how many fix turns red checks have asked for, and the change hash the last
   * red was measured on — the no-progress guard (a fix turn that left the
   * hash unchanged and the checks still red ends the loop at once). In memory
   * like `fixRounds`: a restart starts a fresh budget.
   */
  private checkLoops = new Map<string, { round: number; hash: string }>();
  /** The commands pool's runner — checks run there (docs/checks.md). Wired by index.ts. */
  private commandRunner: CommandRunner | null = null;
  /**
   * Tasks whose adversarial review round is in flight RIGHT NOW — the
   * single-flight lock behind `reviewCompletedRun`. What other surfaces read
   * is the persisted `task.reviewState`, written at every step of the round.
   */
  private readonly pendingReviews = new Map<string, Promise<void>>();
  /**
   * Who asked for the "Review now" round in flight (taskId → actor). Set with
   * the `pendingReviews` lock by `reviewNow` and cleared with it, so it reads
   * true exactly while a REQUESTED round runs — the Telegram notifier asks it
   * whether a settle on a non-`review` status is worth a ping. In memory
   * only: a requested round a restart re-runs is recorded without requester.
   */
  private readonly requestedReviews = new Map<string, string>();
  /**
   * When each live run's needs-attention flag was raised (ms since epoch).
   * The flag is cleared the moment the transcript shows an assistant line
   * NEWER than this — the prompt was answered and the agent moved on — so a
   * run does not read "needs attention" for the rest of its turn after a
   * human clicked Yes in the terminal (docs/design.md § Completion detection).
   */
  private readonly attentionAt = new Map<string, number>();
  /**
   * A Stop landed for a task whose review round was STILL RUNNING. A round
   * takes minutes and only stamps `review_diff_hash` when it returns, so the
   * late Stop would read a null/stale hash and spawn a second reviewer over
   * the same diff — the duplicate this whole gate exists to prevent, on the
   * very path that produces it most (a dispatch delivery resumes a task
   * sitting in `review`: `deliverDispatches` holds only running/waiting/
   * queued/blocked). It is remembered rather than dropped, because that Stop's turn
   * MAY have edited something: the in-flight round is allowed to finish and
   * stamp its hash, then one more pass runs, which the hash gate makes free
   * when nothing changed and a real review when it did.
   */
  private readonly reviewRecheck = new Set<string>();
  /** runs whose turn is a PUBLISH turn (docs/publish.md): their Stop must land
   *  the task in `published`, not in the human review queue. */
  private publishRuns = new Set<string>();
  /**
   * Tasks whose publish was started by the auto-publish landing tier
   * (`landIfClean`), so `settlePublish` stamps `autoLandedAt` on success. Set
   * and cleared by `publish()` itself on EVERY call (a human Publish after a
   * failed automatic one is the human's), consumed by `settlePublish`. Memory
   * only: a restart is refused while the publish turn works.
   */
  private readonly autoPublishing = new Set<string>();
  /** single-flight guard for dispatch delivery (docs/dispatch.md) — the route
   *  and the scheduler may both ask for a sweep at once. */
  private deliveringDispatches = false;
  /**
   * Tasks currently inside `startWorker`'s resume gate (docs/token-budget.md
   * § The fourth) — marked `running`, no run row yet, a compaction possibly
   * minutes from returning. Two things need to know about them: shutdown, so
   * it can wait rather than close storage under the settle; and the
   * concurrency count, because a compacting task is on its way to a PTY and a
   * slot that ignores it lets a third worker in.
   */
  private readonly gatesInFlight = new Set<string>();
  /**
   * Dispatch turns fired but not yet spawned: taskId → repoId. The delivery
   * loop no longer awaits `followUp` (a resume gate could hold the scheduler
   * for ten minutes), so this is what stops the next pass redelivering the
   * same dispatch, starting a second turn in the same repo, or over-filling
   * the worker slots.
   */
  private readonly dispatchTurnsInFlight = new Map<string, string | null>();
  /**
   * Custom queue (docs/queue.md): tasks whose turn just ended and whose
   * follow-on (adversarial review round, auto-publish turn) has not decided yet
   * whether to resume them. While a MEMBER of the custom queue is held here
   * the queue claims nothing in ITS repo (other repos run on) — `review` is
   * not `running`, so without this the next same-repo member would start in
   * the gap before the fix round reopens the previous one. Non-members may be held too; the pump ignores them.
   * Value = when the hold was taken: a hold only counts while its task is a
   * member sitting in `review` (the one status a follow-on reopens from) and
   * is younger than CUSTOM_QUEUE_HOLD_TTL_MS — a leaked hold (route threw,
   * request aborted) expires with a logged warning instead of freezing the
   * queue until the next restart (review R4).
   */
  private customQueueHold = new Map<string, number>();
  /**
   * Auto wake-up (docs/wake.md): taskId → the ms at which the 5h usage window
   * this task is waiting on reopens. A mirror of `tm_tasks.wake_at`, kept in
   * memory so the sweep costs nothing while nothing is parked, and rebuilt
   * from the rows in `recoverOnBoot()`.
   */
  private readonly wakeDueAt = new Map<string, number>();
  /** single-flight for the wake sweep — a pass can outlive its own interval */
  private wakeSweeping = false;
  /** Anomaly notifications (docs/push.md § What pings): coalescing memory + emit. */
  private readonly alerts: AnomalyAlerts;
  /** single-flight for the anomaly/budget sweep */
  private anomalySweeping = false;
  /**
   * `budget.runMinutes` (docs/token-budget.md § Fuses): runs the fuse has
   * flagged once — never again for the same run — and the subset whose
   * needs-attention flag is STILL the fuse's (not a prompt's). The latter is
   * what lets a real permission prompt on an over-time run raise its own
   * attention (internal route) instead of hiding behind the fuse's flag.
   */
  private readonly overtimeRaised = new Set<string>();
  private readonly overtimeFlags = new Set<string>();
  /**
   * `waiting` (docs/design.md § Waiting): the subagents each live run has
   * launched and not yet seen return, from the SubagentStart/SubagentStop
   * hooks. Keyed by `agent_id`; a hook that carried none is counted in `anon`
   * so two id-less children do not collapse into one. `returned` is every id
   * whose SubagentStop has been seen, kept until the run ends: a Stop payload
   * captured before a child's stop hook landed must not count it again.
   * Consulted by the Stop route: a turn that ends with children still out is a
   * wait, not a landing. When a hook payload carries the CLI's own
   * `background_tasks` list, that list REPLACES the count (see `waitDecision`).
   */
  private readonly childrenInFlight = new Map<string, { ids: Set<string>; anon: number; returned: Set<string> }>();
  /**
   * Runs whose task is parked `waiting` right now: runId → the task, the
   * children snapshot the park was decided on, and when. Cleared by
   * `endWait` — the last child's stop (the CLI is about to re-invoke the
   * session) or a transcript line newer than the park (it already did, or a
   * human typed into the attached terminal). On the hook-count fallback only:
   * a Stop that arrives while the entry is STILL here with the same snapshot
   * means neither happened through our channels, so that turn is landed the
   * ordinary way rather than parked again — a lost SubagentStop hook must not
   * hold a task forever.
   *
   * `timer` is armed when background SHELLS helped hold the park: a shell has
   * no stop hook and a dev server never exits, so at the earliest shell's
   * deadline the Stop is replayed (`replay`, the park's own payload) through
   * the route's handler, which lands the turn unless something still counts.
   */
  private readonly waitingRuns = new Map<
    string,
    { taskId: string; snapshot: string; at: number; timer: NodeJS.Timeout | null; replay: unknown }
  >();
  /**
   * Background shells each live run has been seen waiting on: runId → shell
   * id → when a Stop first listed it running. The wait budget
   * (`agent.shellWaitMinutes`) is counted from here, NOT from each Stop, so a
   * dev server cannot re-earn a fresh budget every turn. Cleared at run end.
   */
  private readonly shellsSeen = new Map<string, Map<string, number>>();
  /** the Stop route's replay, called when a shell wait runs out (see above) */
  private shellWaitHandler: ((runId: string, body: unknown, parkedAt: number) => Promise<void>) | null = null;
  /** runs whose rejected banner has already been audited once (see below) */
  private readonly stallSkipsAudited = new Set<string>();
  /**
   * Transient-error resumes (docs/design.md § Transient API errors), by TASK:
   * the count belongs to the turn, and a `--resume` fallback continues that
   * turn in a new run. Cleared when the turn ends for real (a Stop), when any
   * turn this path did not start spawns, and when the path gives up. In
   * memory on purpose: a restart fails a `running` task anyway.
   */
  private readonly transientRetries = new Map<string, TransientRetry>();
  /** tasks whose spawn in flight IS a transient resume (so `startWorker` keeps the count) */
  private readonly transientResuming = new Set<string>();

  /**
   * Questions a worker handed to the human (docs/questions.md). Owned here so
   * every path that ends a run — exit, kill, cancel, boot recovery — expires
   * what that run was still waiting on; a harness that builds an orchestrator
   * without one gets a service of its own over the same storage.
   */
  readonly questions: QuestionService;

  constructor(
    private storage: Storage,
    private sessions: SessionManager,
    private callbackUrl: string,
    questions?: QuestionService,
  ) {
    this.questions = questions ?? new QuestionService(storage);
    this.sessions.onExit((info) => {
      // The terminal's own bytes are the ONLY place a usage-limit banner
      // appears — the CLI prints it as chrome, never as an assistant message,
      // so it reaches neither the transcript nor `lastAssistantText`. Read it
      // here, while the session is certainly still in the map.
      const tail = this.sessionTail(info.runId);
      void this.handleExit(info.runId, info.exitCode, tail);
    });
    // Safety tick: event-driven scheduling with a slow fallback.
    setInterval(() => this.maybeSchedule(), 10_000).unref();
    // Live stats: refresh cost/tokens/ctx% of ACTIVE worker runs mid-run so
    // the UI updates in real time, not only at Stop/exit.
    setInterval(() => {
      void this.refreshLiveStats();
    }, 20_000).unref();
    // Auto wake-up (docs/wake.md): park turns that ended against the 5h usage
    // limit, and reopen their own sessions once the window resets. Its own
    // cadence rather than a rider on the 10s claim tick — it reads terminal
    // buffers and the account cache, and nothing about it is urgent to the
    // second.
    setInterval(() => {
      void this.wakeSweep();
    }, 30_000).unref();
    // Anomaly notifications + the per-turn wall-clock fuse. A minute is the
    // resolution every threshold here is stated in.
    this.alerts = new AnomalyAlerts(storage);
    setInterval(() => {
      void this.anomalySweep();
    }, 60_000).unref();
  }

  // ---- budget fuses (docs/token-budget.md § Fuses) -------------------------

  /**
   * The one gate every AUTOMATIC turn and every claim asks (named in
   * docs/token-budget.md § Fuses): `claim` measures today's spend against
   * `budget.dayUsd`, every other kind the task's roll-up against
   * `budget.taskUsd`. Human clicks (Proceed, Run now, Retry, Follow-up,
   * Apply fixes, Publish) never call it.
   */
  setCommandRunner(runner: CommandRunner): void {
    this.commandRunner = runner;
  }

  /**
   * Will the repo checks run on this task's landing (docs/checks.md)? Asked by
   * the Stop hook, which marks `checkState: 'pending'` in the same write that
   * parks the task. Never for a publish turn (the route asks only for work
   * turns), nor without the commands pool. Every landing tier passes through
   * the checks — the auto-publish tier's publish turn waits for green.
   */
  async checksDue(task: Pick<Task, 'repoId' | 'checks'>): Promise<boolean> {
    if (!this.commandRunner || !task.repoId) return false;
    return selectChecks(await this.storage.listCommands(task.repoId), task).length > 0;
  }

  budgetAllows(task: Pick<Task, 'id'> | null, kind: BudgetTurn, settings?: AppSettings): Promise<BudgetVerdict> {
    return budgetAllows(this.storage, task, kind, settings);
  }

  /**
   * An automatic turn was refused by `budget.taskUsd`: the reason goes on the
   * row (`error`), a `task.budget` audit row records it, and one `anomaly`
   * ping per task per cap goes out. A task caught mid-turn (`running` /
   * `waiting` — the later transient-resume path) lands in `review`; one that
   * is already parked keeps its status, since parked IS where it lands.
   */
  private async refuseOverBudget(
    taskId: string,
    kind: BudgetTurn,
    v: Extract<BudgetVerdict, { ok: false }>,
  ): Promise<void> {
    const task = await this.storage.getTask(taskId);
    if (!task) return;
    // Keep whatever the row already said (a wake-parked task's own failure,
    // say) under the budget reason rather than overwrite it; a repeat refusal
    // replaces only the previous budget line.
    const earlier = !task.error
      ? null
      : task.error.startsWith('budget:')
        ? (task.error.split('\n\nEarlier: ')[1] ?? null)
        : task.error;
    const error = earlier ? `${v.reason}\n\nEarlier: ${earlier}` : v.reason;
    const updated =
      task.status === 'running' || task.status === 'waiting'
        ? await this.storage.transitionTask(taskId, [task.status], 'review', 'system', { error })
        : await this.storage.updateTask(taskId, { error });
    if (updated) broadcast({ type: 'task.updated', task: updated });
    await this.storage.appendEvent({
      kind: 'task.budget',
      actor: 'system',
      taskId,
      repoId: task.repoId,
      data: { fuse: v.fuse, refused: kind, spentUsd: v.spentUsd, capUsd: v.capUsd },
    });
    await this.alerts.emit({
      type: 'task-budget',
      severity: 'warn',
      message: `over its $${v.capUsd.toFixed(2)} budget ($${v.spentUsd.toFixed(2)} spent) — automatic turns stopped`,
      key: `task-budget:${taskId}:${v.capUsd}`,
      taskId,
    });
  }

  /** The day fuse holds: one audit row + one ping per server-local day. */
  private async dayBudgetReached(v: Extract<BudgetVerdict, { ok: false }>): Promise<void> {
    const day = localDayKey();
    const sent = await this.alerts.emit({
      type: 'day-budget',
      severity: 'critical',
      message: v.reason,
      key: `day-budget:${day}`,
      data: { spentUsd: v.spentUsd, capUsd: v.capUsd },
    });
    if (sent) {
      await this.storage.appendEvent({
        kind: 'task.budget',
        actor: 'system',
        data: { fuse: v.fuse, refused: 'claim', day, spentUsd: v.spentUsd, capUsd: v.capUsd },
      });
    }
  }

  /** Is this run's needs-attention flag the run-minutes fuse's, not a prompt's? Taking it hands the flag to the prompt. */
  takeOvertimeFlag(runId: string): boolean {
    return this.overtimeFlags.delete(runId);
  }

  /**
   * "Blocked on a HUMAN": the run's needs-attention flag is set AND it is not
   * the `budget.runMinutes` fuse's. Every rule that reads the flag as "a
   * prompt is waiting, the session will speak again" must ask this instead of
   * `run.needsAttention` — the fuse's flag means only "this turn is long", and
   * the session may never speak again (a shell-held park expiring, a turn the
   * usage limit cut short). Review round 1 of the fuses.
   */
  promptAttention(run: Pick<Run, 'id' | 'needsAttention'>): boolean {
    return run.needsAttention && !this.overtimeFlags.has(run.id);
  }

  /**
   * Every minute: the `budget.runMinutes` fuse, then the `anomaly.*`
   * thresholds as notifications (the Dashboard computes the same rules on
   * request, routes/stats.ts). Never throws into its timer.
   */
  private async anomalySweep(): Promise<void> {
    if (this.anomalySweeping) return;
    this.anomalySweeping = true;
    try {
      const settings = await this.storage.getSettings();
      const nowMs = Date.now();
      const live = (await this.storage.listRuns({ status: 'running', mode: 'worker' })).filter((r) => {
        const s = this.sessions.get(r.id);
        return !r.idle && s !== undefined && s.exit === null && !s.idle;
      });
      const capMin = runMinutesCap(settings);
      const longRunMin = settings['anomaly.longRunMin'];
      for (const run of live) {
        const ageMin = (nowMs - Date.parse(run.startedAt)) / 60_000;
        if (!Number.isFinite(ageMin)) continue;
        if (capMin && ageMin >= capMin) await this.raiseOvertime(run, capMin);
        if (run.taskId && longRunMin > 0 && ageMin > longRunMin) {
          await this.alerts.emit({
            type: 'long-run',
            severity: 'warn',
            message: `running ${Math.round(ageMin)} min (over the ${longRunMin} min threshold)`,
            key: `long-run:${run.id}`,
            taskId: run.taskId,
            runId: run.id,
          });
        }
      }

      // Cost and stale review read the task rows. Cost only for tasks with a
      // run started in the last 24h or still live — the Dashboard's
      // recent-or-live rule — so the first boot does not ping every expensive
      // task in history; stale review only for a stay that crossed the
      // threshold in the last day, for the same reason.
      const costCap = settings['anomaly.costUsd'];
      const staleMs = settings['anomaly.staleReviewHours'] * 3600_000;
      const recent = new Set<string>();
      for (const r of await this.storage.listRuns({ since: new Date(nowMs - 24 * 3600_000).toISOString() })) {
        const id = runTaskId(r);
        if (id) recent.add(id);
      }
      for (const r of live) if (r.taskId) recent.add(r.taskId);
      for (const id of recent) {
        const t = await this.storage.getTask(id);
        if (!t || !(costCap > 0) || t.costUsd <= costCap) continue;
        await this.alerts.emit({
          type: 'cost-high',
          severity: 'critical',
          message: `has cost $${t.costUsd.toFixed(2)}, over the $${costCap} threshold`,
          key: `cost-high:${t.id}`,
          taskId: t.id,
        });
      }
      if (staleMs > 0) {
        for (const t of await this.storage.listTasks({ status: 'review' })) {
          const age = nowMs - Date.parse(t.updatedAt);
          if (!(age > staleMs) || age > staleMs + 24 * 3600_000) continue;
          await this.alerts.emit({
            type: 'stale-review',
            severity: 'info',
            message: `in review for ${Math.round(age / 3600_000)}h — waiting on you`,
            key: `stale-review:${t.id}:${t.updatedAt}`,
            taskId: t.id,
          });
        }
      }
    } catch (err) {
      console.error('orchestrator anomaly sweep error:', err);
    } finally {
      this.anomalySweeping = false;
    }
  }

  /**
   * `budget.runMinutes`: flag the run needs-attention and say why — never
   * kill it. Deliberately NOT stamped in `attentionAt`, so the agent's own
   * progress does not clear it (an over-time turn is still progressing); Stop
   * and exit clear it as they clear any flag. A run already flagged by a
   * prompt is left alone this minute and tried again on the next.
   */
  private async raiseOvertime(run: Run, minutes: number): Promise<void> {
    if (this.overtimeRaised.has(run.id) || run.needsAttention) return;
    this.overtimeRaised.add(run.id);
    const updated = await this.storage.updateRun(run.id, { needsAttention: true });
    if (!updated) return;
    this.overtimeFlags.add(run.id);
    await this.storage.appendEvent({
      kind: 'run.attention',
      actor: 'system',
      runId: run.id,
      taskId: run.taskId,
      repoId: run.repoId,
      data: { reason: 'run-minutes', minutes },
    });
    broadcast({ type: 'run.needs-attention', run: updated, reason: 'run-minutes', minutes });
  }

  /** Recent bytes of a run's terminal, ANSI and all; '' when there is none. */
  private sessionTail(runId: string, bytes = 16_000): string {
    try {
      const buf = this.sessions.get(runId)?.buffer.snapshot();
      if (!buf) return '';
      return buf.subarray(Math.max(0, buf.length - bytes)).toString('utf8');
    } catch {
      return '';
    }
  }

  /**
   * Auto wake-up (docs/wake.md), both halves: park turns that ended against
   * the account's 5h usage window, then reopen the ones whose window has
   * reopened. Never throws into its timer.
   */
  private async wakeSweep(): Promise<void> {
    if (this.wakeSweeping) return;
    this.wakeSweeping = true;
    try {
      const settings = await this.storage.getSettings();
      if (!settings['agent.autoWake']) return;
      await this.parkStalledSessions(settings);
      await this.wakeDue(settings);
    } catch (err) {
      console.error('orchestrator wake sweep error:', err);
    } finally {
      this.wakeSweeping = false;
    }
  }

  /** The account's own live 5h window, or null when the CLI cache is unusable. */
  private accountWindow(): AccountView | null {
    const w = liveWindow(readAccountUsage()?.session);
    return w ? { percent: w.percent, resetsAt: w.resetsAt } : null;
  }

  /**
   * Records that a task's turn ended against the usage limit rather than
   * against its work, and when the window reopens.
   *
   * The status the turn already landed in is deliberately NOT rewritten.
   * `review` and `failed` are both statuses `proceed()` resumes from, so
   * neither blocks the wake-up, and flattening one into the other would hide
   * a real exit code behind a guess about what caused it. `error` is left
   * alone for the same reason — the wait is carried by `wake_at`, which the
   * UI renders on its own, so nothing true is overwritten by it.
   */
  private async parkForUsageLimit(
    task: Task,
    verdict: Extract<StallVerdict, { stalled: true }>,
    settings: AppSettings,
  ): Promise<void> {
    // The account's own `resets_at` is the better clock when the CLI printed a
    // banner with no time in it (or one we could not place in this window).
    const wakeAt = resolveWakeAt(verdict.notice, verdict.accountResetsAt, settings['agent.autoWakeGraceSec']);
    const patched = await this.storage.updateTask(task.id, { wakeAt });
    if (!patched) return;
    this.wakeDueAt.set(task.id, Date.parse(wakeAt));
    await this.storage.appendEvent({
      kind: 'task.wake',
      actor: 'system',
      taskId: task.id,
      repoId: patched.repoId,
      data: {
        action: 'parked',
        wakeAt,
        status: patched.status,
        statedResetsAt: verdict.notice.resetsAt,
        accountResetsAt: verdict.accountResetsAt,
        accountPct: verdict.accountPct,
        evidence: verdict.notice.evidence,
      },
    });
    broadcast({ type: 'task.updated', task: patched });
  }

  /**
   * A banner that did not park anything is still a decision. Recorded only
   * when one was actually seen, so ordinary turns write nothing.
   */
  private async auditStallSkip(
    task: Task,
    verdict: Extract<StallVerdict, { stalled: false }>,
    runId?: string,
  ): Promise<void> {
    if (!verdict.sawBanner) return;
    // The stall sweep re-reads the same terminal every thirty seconds. One row
    // per run says what was decided; a row per sweep would say it 120 times an
    // hour and bury everything else in the log.
    if (runId) {
      if (this.stallSkipsAudited.has(runId)) return;
      this.stallSkipsAudited.add(runId);
    }
    await this.storage.appendEvent({
      kind: 'task.wake',
      actor: 'system',
      taskId: task.id,
      repoId: task.repoId,
      data: { action: 'skipped', reason: verdict.reason, status: task.status },
    });
  }

  /** ms since a run's transcript last grew; Infinity when there is none to read. */
  private transcriptQuietMs(run: Run, now: number): number {
    if (!run.transcriptPath) return Number.POSITIVE_INFINITY;
    try {
      return now - fs.statSync(run.transcriptPath).mtimeMs;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  /**
   * The half of detection that has no exit to hang off: a turn that hits the
   * limit does not always die. The CLI prints the banner and drops back to its
   * prompt with the PTY alive — either still `running` with no Stop hook at
   * all, or settled into `review` by a Stop hook that fired over a turn which
   * did no work. Both shapes keep a live session, which is what this reads.
   *
   * There is deliberately no `isIdle` test. `markIdle()` is called in the
   * stop-hook route AFTER the task has been transitioned out of `running`, so
   * "running and idle" is a state that cannot exist, and gating on it made
   * this function unreachable (review R1). Quiet is measured on the
   * transcript instead, which is the thing that actually stops moving.
   */
  private async parkStalledSessions(settings: AppSettings): Promise<void> {
    const now = Date.now();
    // Driven from the RUNS, not the tasks: a stall by definition still holds a
    // live PTY, and live PTYs are capped at MAX_LIVE_SESSIONS. Sweeping tasks
    // instead would mean re-reading every `failed` row the database has ever
    // accumulated, every thirty seconds, to find at most ten candidates.
    const live = await this.storage.listRuns({ status: 'running', mode: 'worker' });
    for (const run of live) {
      if (!run.taskId || !this.sessions.get(run.id)) continue;
      // A publish turn is settled against git by settlePublish(), and
      // `proceed()` would resume it with the wrong instruction entirely.
      if (this.publishRuns.has(run.id)) continue;
      // Blocked on a HUMAN, not on the account (docs/wake.md): a session at a
      // permission prompt writes nothing to its transcript for as long as it
      // waits, so it passes the quiet test forever — and the hunk it is
      // previewing may be a file that quotes a banner. The run row already
      // says so; killing it would throw away the answer it is waiting for
      // (review R2). The budget.runMinutes fuse's flag is NOT that: an
      // over-time turn the account then cut short must still be parked.
      if (this.promptAttention(run)) continue;
      const task = await this.storage.getTask(run.taskId);
      if (!task || task.wakeAt) continue;
      if (task.status !== 'running' && !WAKE_RESUMABLE_STATUSES.includes(task.status)) continue;
      // A task inside the resume gate or a fired dispatch turn is `running`
      // with a NEWER turn on the way — this session is not the live one.
      if (this.gatesInFlight.has(task.id) || this.dispatchTurnsInFlight.has(task.id)) continue;
      const latest = (await this.storage.listRuns({ taskId: task.id }))[0];
      if (latest && latest.id !== run.id) continue;
      // Only a task still marked `running` can be mid-thought; one already in
      // review/failed has finished by definition and needs no quiet test.
      const live = task.status === 'running';
      if (live && this.transcriptQuietMs(run, now) < STALL_QUIET_MS) continue;
      // Acting on a live task means KILLING its PTY, so the banner has to be
      // the last thing that terminal printed — not merely on the last
      // screenful, which a previewed file could be.
      const verdict = assessLimitStall(this.sessionTail(run.id), this.accountWindow(), now, {
        maxCharsAfter: live ? LIVE_TAIL_STRICT_CHARS : undefined,
      });
      if (!verdict.stalled) {
        await this.auditStallSkip(task, verdict, run.id);
        continue;
      }
      // A live stall must be ENDED, not parked in place: nothing resumes a
      // `running` task. Killing its PTY is safe precisely because the session
      // is resumable from disk — that is what the wake-up then does.
      let parked: Task | null = task;
      if (live) {
        parked = await this.endStalledRun(task, run);
        if (!parked) continue;
      }
      this.stallSkipsAudited.delete(run.id);
      await this.parkForUsageLimit(parked, verdict, settings);
    }
  }

  /**
   * Ends a session the account has stopped: mark the run `killed` FIRST (which
   * is what makes `handleExit` leave the task alone when the PTY dies), kill
   * it, then move the task to `review` — the same landing a clean exit gets,
   * and the one status this stall can be resumed from.
   */
  private async endStalledRun(task: Task, run: Run): Promise<Task | null> {
    await this.storage.updateRun(run.id, { status: 'killed', endedAt: new Date().toISOString() });
    this.sessions.kill(run.id);
    await this.storage.appendEvent({
      kind: 'run.killed',
      actor: 'system',
      runId: run.id,
      taskId: task.id,
      data: { reason: 'usage-limit-stall' },
    });
    const moved = await this.storage.transitionTask(task.id, ['running'], 'review', 'system', {
      error: 'the 5h usage window ran out mid-turn — this session is waiting to be resumed',
    });
    if (moved) broadcast({ type: 'task.updated', task: moved });
    return moved;
  }

  /**
   * Resumes parked tasks whose window has reopened — one per pass, because a
   * reset frees every one of them at the same instant and the concurrency cap
   * is the only thing that should decide how many run.
   */
  private async wakeDue(settings: AppSettings): Promise<void> {
    const now = Date.now();
    const due = [...this.wakeDueAt.entries()].filter(([, at]) => at <= now).sort((a, b) => a[1] - b[1]);
    for (const [taskId] of due) {
      // The row is the truth and the map is only a cache of it: anything that
      // started a turn cleared `wake_at` in `startWorker`, which is what makes
      // a human clicking Proceed cancel the pending wake-up for free.
      const task = await this.storage.getTask(taskId);
      if (!task || !task.wakeAt) {
        this.wakeDueAt.delete(taskId);
        continue;
      }
      const at = Date.parse(task.wakeAt);
      if (Number.isFinite(at) && at > now) {
        this.wakeDueAt.set(taskId, at);
        continue;
      }
      if (!WAKE_RESUMABLE_STATUSES.includes(task.status)) {
        await this.clearWake(taskId);
        continue;
      }
      // The global switch means the human stopped the machine; only the custom
      // queue is deliberately independent of it (docs/queue.md). Either way the
      // mark stays, so the task wakes the moment the switch comes back.
      if (!settings['orchestrator.enabled'] && !task.customQueueAt) continue;
      if (this.activeWorkers() >= settings['orchestrator.concurrency']) return;
      // budget.taskUsd: a wake-up is an automatic turn. Refused, the mark is
      // cleared (the window reopening changes nothing about the budget) and
      // the task stays parked for a human Proceed.
      const verdict = await this.budgetAllows(task, 'wake', settings);
      if (!verdict.ok) {
        await this.clearWake(taskId);
        await this.storage.appendEvent({
          kind: 'task.wake',
          actor: 'system',
          taskId,
          repoId: task.repoId,
          data: { action: 'refused', reason: 'budget', wakeAt: task.wakeAt },
        });
        await this.refuseOverBudget(taskId, 'wake', verdict);
        continue;
      }
      // Cleared BEFORE the resume, not after: `startWorker` clears it too, but
      // a resume that fails for a reason of its own must not leave a mark that
      // fires again every thirty seconds forever.
      await this.clearWake(taskId);
      await this.storage.appendEvent({
        kind: 'task.wake',
        actor: 'system',
        taskId,
        repoId: task.repoId,
        data: { action: 'resumed', wakeAt: task.wakeAt, status: task.status },
      });
      const res = await this.proceed(taskId, null, 'system');
      if ('error' in res) {
        // Not resumable (still working, or no session left on disk). Recorded
        // once and left to the human — retrying a 409 every thirty seconds is
        // how an audit log stops being readable.
        await this.storage.appendEvent({
          kind: 'task.wake',
          actor: 'system',
          taskId,
          repoId: task.repoId,
          data: { action: 'failed', error: res.error, code: res.code },
        });
      }
      return;
    }
  }

  /**
   * Rebuilds the in-memory wake schedule from the rows. Only the statuses a
   * parked task can be sitting in are scanned — `review` and `failed`, where a
   * cut-short turn lands and where a killed stall is put. A mark left on any
   * other status is inert, and the first turn the task runs clears it.
   */
  private async reloadWakes(): Promise<void> {
    this.wakeDueAt.clear();
    for (const status of WAKE_RESUMABLE_STATUSES) {
      for (const task of await this.storage.listTasks({ status })) {
        if (!task.wakeAt) continue;
        const at = Date.parse(task.wakeAt);
        // A wake whose time passed while the server was down is due now, not
        // dropped: the window it waited for has certainly reopened.
        this.wakeDueAt.set(task.id, Number.isFinite(at) ? at : Date.now());
      }
    }
    if (this.wakeDueAt.size) console.log(`auto wake-up: ${this.wakeDueAt.size} task(s) waiting on the usage window`);
  }

  /**
   * Stamps `Task.baseSha/baseRef/baseAt` when the row has none. At the first
   * spawn (`atSpawn`, no worker run yet) that is HEAD now. A task that already
   * ran without one (created before migration 29) gets HEAD as it stood at
   * its first run's start instead — never HEAD now, which would hide
   * everything it committed. Retries and fix rounds find it set and keep it.
   * Best effort: no git, no base, and the reviewer falls back to trailers.
   */
  private async ensureBase(task: Task, repo: Repo, atSpawn: boolean): Promise<Task> {
    if (task.baseSha) return task;
    try {
      const runs = await this.storage.listRuns({ taskId: task.id, mode: 'worker' });
      const first = runs[runs.length - 1]; // newest first
      let base: Pick<Task, 'baseSha' | 'baseRef' | 'baseAt'> | null = null;
      if (first) {
        const sha = await headAt(repo.path, first.startedAt);
        if (sha) base = { baseSha: sha, baseRef: null, baseAt: first.startedAt };
      } else if (atSpawn) {
        const head = await readHeadBase(repo.path);
        if (head) base = { baseSha: head.sha, baseRef: head.ref, baseAt: new Date().toISOString() };
      }
      if (!base) return task;
      return (await this.storage.updateTask(task.id, base)) ?? task;
    } catch (err) {
      console.error(`task ${task.id}: could not record its base:`, err);
      return task;
    }
  }

  /**
   * What `workerDiff` needs to find this task's commits. The window ends at
   * the task's last landing (its latest transition out of running/waiting —
   * the Stop that produced the change under review), or now while it still
   * runs, so a Review now days later never counts a LATER task's commits.
   * `soleWorker`: no other task's worker run overlapped the window in this
   * repo, which is what makes base..HEAD safe to attribute.
   * `includeUncommitted`: no other task's worker started here after the
   * window, so the working tree can still be this task's.
   */
  private async changeScope(task: Task, repo: Repo): Promise<ChangeScope> {
    const now = new Date().toISOString();
    let until = now;
    if (task.status !== 'running' && task.status !== 'waiting') {
      const landings = (await this.storage.listEvents({ taskId: task.id, kind: 'task.transition', limit: 2000 }))
        .filter((e) => e.data?.from === 'running' || e.data?.from === 'waiting')
        .map((e) => e.at)
        .sort();
      if (landings.length) until = landings[landings.length - 1];
    }
    const others = (await this.storage.listRuns({ repoId: repo.id, mode: 'worker' })).filter((r) => r.taskId !== task.id);
    const from = task.baseAt;
    const soleWorker =
      !!task.baseSha && !!from && !others.some((r) => r.startedAt <= until && (r.endedAt ?? now) >= from);
    // The working tree is this task's leftovers only until someone else
    // works in the checkout after it: a Review now of an older task must
    // not judge a later task's uncommitted edits as its own.
    const includeUncommitted = !others.some((r) => r.startedAt > until);
    return { taskId: task.id, baseSha: task.baseSha, until, soleWorker, includeUncommitted };
  }

  /** Drops a pending wake-up, in the row and in the map. */
  private async clearWake(taskId: string): Promise<void> {
    this.wakeDueAt.delete(taskId);
    const patched = await this.storage.updateTask(taskId, { wakeAt: null });
    if (patched) broadcast({ type: 'task.updated', task: patched });
  }

  private async refreshLiveStats(): Promise<void> {
    try {
      const running = await this.storage.listRuns({ status: 'running', mode: 'worker' });
      for (const run of running) {
        if (run.idle || !run.transcriptPath) continue;
        const s = this.sessions.get(run.id);
        if (!s || s.exit !== null) continue;
        const summary = await summarizeRun(run);
        if (summary) {
          const updated = await this.storage.updateRun(run.id, { stats: summary.stats });
          if (updated) broadcast({ type: 'run.updated', run: updated });
          await broadcastTaskCost(this.storage, updated);
        }
      }
    } catch {
      // stats refresh must never break the scheduler
    }
  }

  /**
   * Boot recovery (design M4): runs marked `running` in the DB have no PTY
   * after a restart. Kill their orphaned pids (only after verifying the
   * command line still looks like ours) and fail their tasks — never leave
   * unsupervised agents editing repos, never retry into a half-edited repo.
   */
  async recoverOnBoot(): Promise<void> {
    // Also sweep recently-ended rows: cancel() marks a run killed up to ~5s
    // before its process actually dies; a crash in that window leaves a live
    // claude pid under a non-running row (review M8).
    const all = await this.storage.listRuns();
    // No hook survives a restart: a question still pending was being waited
    // on by a process this boot is about to kill (or that died with the last
    // one), so it can never be collected — expire it before the human answers
    // into the void (docs/questions.md).
    const staleQuestions = await this.questions.expireAll('the server restarted').catch(() => []);
    if (staleQuestions.length) console.log(`questions: expired ${staleQuestions.length} left pending by the last process`);
    const recentCutoff = Date.now() - 2 * 60_000;
    // Sweep only deaths we never OBSERVED (exitCode null): killed rows and
    // prior-boot recoveries. Normally-exited pids are long free and may be
    // reused by the user's own claude sessions — never signal those (review R2).
    const orphans = all.filter(
      (r) =>
        r.status === 'running' ||
        (r.pid != null && r.exitCode == null && r.endedAt != null && Date.parse(r.endedAt) > recentCutoff),
    );
    for (const run of orphans) {
      // Across a restart, pid reuse is realistic — only kill pids whose
      // command is actually claude (strict pattern, review M8).
      // `codex exec` workers (the Codex preset) are ours as well.
      if (run.pid && pidLooksLikeOurs(run.pid, /claude|codex/)) {
        try {
          process.kill(run.pid, 'SIGTERM');
        } catch {
          // already gone
        }
      }
      if (run.status === 'running') {
        await this.storage.updateRun(run.id, {
          status: 'exited',
          needsAttention: false,
          endedAt: new Date().toISOString(),
        });
        if (run.taskId && run.mode === 'worker') {
          // Conditional: an idle-completed run's task sits in review — must
          // not be clobbered to failed (review M8).
          const task = await this.storage.transitionTask(run.taskId, ['running', 'waiting'], 'failed', 'system', {
            error: 'server restarted while the worker was running',
            reviewState: null, // a fix round that died with the server is not "fixing"
          });
          if (task) await this.resolveCompletion(task, 'system');
        }
      }
    }
    // A task can be `running` with NO run row at all: the resume gate marks it
    // running and then spends up to ten minutes compacting before `createRun`
    // (docs/token-budget.md § The fourth). A crash, a SIGKILL from the front
    // door, or a `stop()` that closed storage under the abort path leaves it
    // there — and the run sweep above cannot see it, because it sweeps
    // `tm_runs`. Nothing else frees that state either: `followUp` answers
    // "marked running but has no live session", and enqueue/retry refuse a
    // running task, so only Cancel would. Re-read AFTER the loop above, which
    // has already moved the tasks whose runs it failed.
    // `waiting` is swept the same way: it is a live session between two of
    // its own turns, and no session survives a restart.
    const stranded: string[] = [];
    const live = [
      ...(await this.storage.listTasks({ status: 'running' })),
      ...(await this.storage.listTasks({ status: 'waiting' })),
    ];
    for (const task of live) {
      const runs = await this.storage.listRuns({ taskId: task.id });
      if (runs.some((r) => r.status === 'running')) continue;
      // A loop between iterations has no run row by design (docs/loops.md).
      // `next` is a decision already taken — the pump starts the iteration;
      // `checking` lost its checks with the process — paused for a human.
      if (task.kind === 'loop' && task.status === 'running' && task.loopState === 'next') continue;
      if (task.kind === 'loop' && task.status === 'running' && task.loopState === 'checking') {
        const paused = await this.storage.transitionTask(task.id, ['running'], 'review', 'system', {
          loopState: 'paused',
          reviewState: null,
          error: `server restarted while the loop was checking iteration ${task.loopIteration} — Continue goes on`,
        });
        if (paused) {
          stranded.push(task.id);
          broadcast({ type: 'task.updated', task: paused });
        }
        continue;
      }
      // Ever had a worker? Then work may be sitting uncommitted in the tree and
      // its session is resumable — `review` is where a human picks that up.
      // Never ran at all, and there is nothing to review.
      const everRan = runs.some((r) => r.mode === 'worker');
      const to = everRan ? 'review' : 'failed';
      const moved = await this.storage.transitionTask(task.id, ['running', 'waiting'], to, 'system', {
        error: 'server stopped before this task had a live agent — nothing was running at boot',
        reviewState: null,
      });
      if (moved) {
        stranded.push(task.id);
        broadcast({ type: 'task.updated', task: moved });
        if (!everRan) await this.resolveCompletion(moved, 'system');
      }
    }
    // Pending wake-ups outlive the process because they live in the row, not
    // in the map (docs/wake.md). Rebuilt AFTER the stranded sweep above, which
    // is what moves a parked-but-`running` task into a status a resume accepts.
    await this.reloadWakes();
    // A reviewer that died with the server left its task `review` + pending/
    // reviewing — a badge that would say "auto-review" forever. The diff is
    // still in the tree, so the review is simply re-run (free when the hash
    // says it was already judged). `fixing` on a task that is no longer
    // running is the same stranded state from the other side: the fix round
    // never Stopped, so the previous verdict is the latest word.
    //
    // `pending|reviewing` is a decision already taken — by the Stop hook
    // (`willReview`) or by a human's "Review now" — so it is re-run as one
    // (`forced`: no `review.enabled` re-check, and the wider REVIEW_NOW_FROM
    // status set a requested round accepts). A requested round cleared the
    // row's diff hash when it was asked for, which is what makes the re-run
    // a real review rather than an unchanged-diff skip.
    for (const task of await this.storage.listTasks()) {
      if (REVIEW_NOW_FROM.includes(task.status)) {
        if (task.reviewState === 'pending' || task.reviewState === 'reviewing') {
          void this.reviewCompletedRun(task.id, true);
        } else if (task.reviewState === 'fixing') {
          await this.setReviewState(task.id, settledReviewState(task.reviewRounds));
        }
      } else if (task.reviewState === 'pending' || task.reviewState === 'reviewing' || task.reviewState === 'fixing') {
        if (task.status !== 'running') await this.setReviewState(task.id, null);
      }
      // Checks left due or mid-run (docs/checks.md): re-run in the same loop,
      // ahead of the review (single-flight, so a task already started above
      // is simply joined). Elsewhere the mark is stale.
      if (task.checkState && CHECK_BUSY_STATES.includes(task.checkState)) {
        if (task.status !== 'review') await this.setCheckState(task.id, null);
        else if (!this.pendingReviews.has(task.id)) void this.reviewCompletedRun(task.id);
      }
    }
    if (orphans.length || stranded.length) {
      await this.storage.appendEvent({
        kind: 'boot.recovery',
        actor: 'system',
        data: { swept: orphans.length, strandedTasks: stranded.length },
      });
      console.log(
        `boot recovery: swept ${orphans.length} run(s)` +
          (stranded.length ? `, freed ${stranded.length} task(s) stuck 'running' with no run` : ''),
      );
    }
  }

  async status() {
    const settings = await this.storage.getSettings();
    return {
      enabled: settings['orchestrator.enabled'],
      // live non-idle sessions — DB run rows stay 'running' while a completed
      // session idles, which would overstate the count (review M2)
      running: this.sessions.liveCount(),
      concurrency: settings['orchestrator.concurrency'],
      // Aux sessions (review, plan, chat, …) live in their own PTY pool, so
      // liveCount() cannot see them — by design, they take no worker slot —
      // but the restart guard and the header need them counted.
      aux: aux().liveCount(),
    };
  }

  async setEnabled(enabled: boolean, actor = 'human'): Promise<void> {
    await this.storage.setSetting('orchestrator.enabled', enabled);
    await this.storage.appendEvent({ kind: 'orchestrator.toggle', actor, data: { enabled } });
    broadcast({ type: 'orchestrator.status', status: await this.status() });
    if (enabled) this.maybeSchedule();
  }

  /** Claim queued tasks while below the concurrency cap (event-driven, single-flight). */
  maybeSchedule(): void {
    if (this.scheduling) {
      // A wakeup arriving mid-loop must not be dropped (review F7).
      this.rescheduleRequested = true;
      return;
    }
    this.scheduling = true;
    void (async () => {
      try {
        do {
          this.rescheduleRequested = false;
          const settings = await this.storage.getSettings();
          const cap = settings['orchestrator.concurrency'];
          // `budget.dayUsd` (docs/token-budget.md § Fuses): past today's cap
          // nothing new is CLAIMED — custom queue, global or overflow. Turns
          // already running finish; dispatch delivery (a continuation, gated
          // per task by budget.taskUsd) still runs.
          const day = await this.budgetAllows(null, 'claim', settings);
          if (!day.ok) await this.dayBudgetReached(day);
          // The custom queue (docs/queue.md) is independent of the global
          // switch: it runs while the queue is stopped, one task per repo.
          if (day.ok) await this.pumpCustomQueue(cap);
          // Loop iterations due (docs/loops.md): a task already running, so
          // the queue switch does not stop it; the day budget does.
          if (day.ok) await this.pumpLoops(cap);
          if (!settings['orchestrator.enabled'] || !day.ok) {
            // The queue is stopped (or the day's budget is spent), but dispatch
            // delivery is a continuation of sessions that already exist — it
            // runs regardless (user decision 2026-08-27), like a human
            // follow-up would.
            await this.deliverDispatches();
            return;
          }
          while (this.activeWorkers() < cap) {
            const task = await this.storage.claimNextQueuedTask('orchestrator');
            if (!task) break;
            const started = await this.startWorker(task);
            if (!started) break; // claim resolved to failed; don't spin
          }
          // Overflow claim credit (agent-API review R1): a task filed by a
          // LIVE worker may start even at cap — otherwise two pollers waiting
          // on their own queued children deadlock the queue. Bounded: one
          // overflow per live creating session along a chain of at most
          // `agent.maxSpawnDepth` hops (default 6, docs/shared-spaces.md §
          // Depth), and — the bound that actually holds at any depth — never
          // past the PTY hard cap (the check right below).
          while (true) {
            // Never overflow into the PTY hard cap: at concurrency >= 4 the
            // cap x3 bound exceeds MAX_LIVE_SESSIONS and spawns would fail
            // terminal tasks over a transient condition (impl review F3).
            if (this.sessions.totalLiveCount() >= MAX_LIVE_SESSIONS - 1) break;
            const eligible = await this.overflowEligibleRunIds();
            if (eligible.length === 0) break;
            const task = await this.storage.claimNextAgentChildTask(eligible, 'orchestrator');
            if (!task) break;
            const started = await this.startWorker(task);
            if (!started) break;
          }
          // Dispatch delivery rides the same ticks as claiming: every task
          // that finishes a turn calls maybeSchedule, so a target going idle
          // gets its queued dispatches without a dedicated pump.
          await this.deliverDispatches();
        } while (this.rescheduleRequested);
      } catch (err) {
        console.error('orchestrator schedule error:', err);
      } finally {
        this.scheduling = false;
      }
    })();
  }

  /**
   * Worker slots in use for SCHEDULING purposes: live PTYs plus the turns that
   * are certain to become one but have not spawned yet (a resume gate mid
   * compaction, a dispatch turn already fired). Deliberately not what
   * `status()` reports — that stays the honest live-PTY count the UI shows.
   * A task can be in both sets, so they are unioned rather than added.
   */
  private activeWorkers(): number {
    const pending = new Set([...this.gatesInFlight, ...this.dispatchTurnsInFlight.keys()]);
    return this.sessions.liveCount() + pending.size;
  }

  /**
   * Shutdown: stop every in-flight resume gate and wait (briefly) for each to
   * finish settling its task. Without this, `stop()` closes storage while a
   * compaction's abort path is still writing `running → review`, the write
   * throws, and the task is stranded `running` with no run row — a state only
   * Cancel can leave, since `followUp`, enqueue and retry all refuse it.
   * `recoverOnBoot` sweeps that state anyway (a SIGKILL or a crash cannot be
   * drained), but the graceful path should not need recovering from.
   */
  async drainResumeGates(timeoutMs = 5_000): Promise<number> {
    const n = this.gatesInFlight.size;
    if (n === 0) return 0;
    abortAllCompactions();
    const deadline = Date.now() + timeoutMs;
    while (this.gatesInFlight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return n;
  }

  /**
   * Stacked tasks (docs/queue.md § Stacked tasks): the queue is about to start
   * a task in this repo while the task that last worked here may still wait
   * for the human in `review` with its edits uncommitted. Commit them under
   * THAT task's trailer first, so the next task starts on a clean tree and its
   * review and publish see only its own change. false = do not start anything
   * in this repo this pass (a review round still open, or the commit failed —
   * the reason goes on the earlier task, once).
   */
  private async handOffCheckout(repoId: string): Promise<boolean> {
    const owner = await this.treeOwner(repoId);
    if (!owner) return true;
    // Still working (or inside a resume gate): its tree is not finished — wait.
    if (owner.status === 'running' || owner.status === 'waiting') return false;
    // An open verify round (review or checks) is still reading this tree.
    if (verifyOpen(owner)) return false;
    // Any other status commits: `review` waiting for the human, and just as
    // much a task an Undo start put back in `queued`/`draft` (review round 2 —
    // its half-finished edits must not become the next task's), or a
    // failed/cancelled one whose leftovers would otherwise read as the next
    // task's in its review.
    const repo = await this.storage.getRepo(repoId);
    if (!repo) return true;
    const res = await handoffCommit(repo, owner);
    if (!res.ok) {
      const error = `hand-off commit failed, so the next queued task in this repo waits: ${res.error}`;
      if (owner.error !== error) {
        const patched = await this.storage.updateTask(owner.id, { error });
        if (patched) broadcast({ type: 'task.updated', task: patched });
        console.warn(`task ${owner.id}: ${error}`);
      }
      return false;
    }
    if (res.sha) {
      await this.storage.appendEvent({
        kind: 'repo.changed',
        actor: 'orchestrator',
        taskId: owner.id,
        repoId,
        data: { action: 'handoff-commit', sha: res.sha },
      });
      if (owner.error?.startsWith('hand-off commit failed')) {
        const patched = await this.storage.updateTask(owner.id, { error: null });
        if (patched) broadcast({ type: 'task.updated', task: patched });
      }
    }
    return true;
  }

  /** The task whose worker ran last in this repo — whose edits the working tree holds. */
  private async treeOwner(repoId: string): Promise<Task | null> {
    const runs = await this.storage.listRuns({ repoId, mode: 'worker' });
    let newest: (typeof runs)[number] | null = null;
    for (const r of runs) {
      if (!r.taskId || r.label === PUBLISH_RUN_LABEL) continue; // a publish turn edits nothing
      if (!newest || r.startedAt > newest.startedAt) newest = r;
    }
    return newest?.taskId ? this.storage.getTask(newest.taskId) : null;
  }

  /**
   * Publish in order (docs/queue.md § Stacked tasks). Reads the unpushed
   * commits' `Task:` trailers against the repo's UNAPPROVED tasks (review,
   * running, waiting, blocked — done/published work may ride along, failed/
   * cancelled leftovers are outside this rule):
   *  - `refuse`: an unapproved task's commits sit before this task's work (its
   *    last commit, or the working tree when this task owns it) — a push would
   *    ship them;
   *  - `partial`: unapproved work sits ON TOP (later commits, or a tree a later
   *    task owns) — push exactly this task's last commit and stage nothing;
   *  - `full`: the ordinary publish (commit the tree, push the branch).
   */
  private async publishPlan(task: Task, repo: Repo): Promise<PublishPlan> {
    const u = await unpushedCommits(repo);
    if (!u) return { kind: 'full' };
    const peers = new Map(
      (await this.storage.listTasks({ repoId: repo.id }))
        .filter((t) => t.id !== task.id && UNAPPROVED_STATUSES.includes(t.status))
        .map((t) => [t.id, t] as const),
    );
    const blockerOf = (taskIds: string[]): Task | undefined =>
      taskIds.includes(task.id) ? undefined : taskIds.map((id) => peers.get(id)).find((t) => !!t);
    const owner = await this.treeOwner(repo.id);
    const ownsTree = owner?.id === task.id;
    let lastOwn = -1;
    u.commits.forEach((c, i) => {
      if (c.taskIds.includes(task.id)) lastOwn = i;
    });
    const horizon = ownsTree ? u.commits.length - 1 : lastOwn;
    for (let i = 0; i <= horizon; i++) {
      const b = blockerOf(u.commits[i].taskIds);
      if (b) {
        const next =
          b.status === 'review'
            ? `Publish or Mark done "${b.title}" first`
            : b.status === 'queued' || b.status === 'draft'
              ? `"${b.title}" was stopped part-way (Undo start): run it to review (Release / Run now), then Publish or Mark done it first`
              : `wait for "${b.title}" to reach review, then Publish or Mark done it first`;
        return {
          kind: 'refuse',
          reason: `publish in order — "${b.title}" (${b.status}) has unpushed commits under this task's work, and pushing would ship them before you approved them. ${next}`,
        };
      }
    }
    const laterBlocked = u.commits.slice(horizon + 1).some((c) => !!blockerOf(c.taskIds));
    const treeBlocked = !ownsTree && !!owner && peers.has(owner.id);
    if (!laterBlocked && !treeBlocked) return { kind: 'full' };
    if (!u.upstream || !u.remote || !u.mergeRef) {
      return {
        kind: 'refuse',
        reason: 'later unapproved work sits on top of this task, and publishing only this task needs a branch with an upstream — push the branch once (git push -u) or publish the later task first',
      };
    }
    if (lastOwn < 0 && !(await hasTaskCommit(repo, task.id))) {
      return {
        kind: 'refuse',
        reason: `this task has no commits of its own, and the working tree belongs to "${owner?.title ?? 'a later task'}" — there is nothing to publish separately`,
      };
    }
    return {
      kind: 'partial',
      upTo: lastOwn >= 0 ? u.commits[lastOwn].sha : null,
      remote: u.remote,
      mergeRef: u.mergeRef,
      upstream: u.upstream,
    };
  }

  /**
   * Custom queue (docs/queue.md): serial PER REPO, parallel across repos
   * (decisions.md 2026-10-22), FIFO by the moment the human added each task,
   * and independent of `orchestrator.enabled`. Walks the queue one head per
   * repo — oldest member first — while a worker slot is free, and claims a
   * head only when (a) no other member of its repo holds it (enforced inside
   * the claim SQL), (b) no member of its repo is held between a finished turn
   * and its review/publish follow-on, and (c) its repo has no other live
   * session working in it — a run-now or dispatch turn in that repo makes the
   * head WAIT, never skip to a later member of the same repo: the order the
   * human set is the order that runs. Any of these only takes THAT repo out
   * of the pass; members of other repos go ahead. A member an agent filed
   * (shared ledger) is additionally skipped inside the head SQL while its
   * filer is unresolved or any task in the repo is working or mid-review —
   * the filer idles in `review` with a dirty tree, which (c) alone does not
   * see (storage/queue-sql.ts).
   */
  private async pumpCustomQueue(cap: number): Promise<void> {
    // Repos out of this pass: held across a follow-on gap, busy, or just
    // claimed (its member is `running` now, so the SQL would skip it anyway).
    const skip = await this.customQueueHeldRepos();
    while (this.activeWorkers() < cap && this.sessions.totalLiveCount() < MAX_LIVE_SESSIONS) {
      const head = await this.storage.peekCustomQueue([...skip]);
      if (!head?.repoId) return;
      skip.add(head.repoId);
      if (await this.repoBusy(head.repoId)) continue;
      if (!(await this.handOffCheckout(head.repoId))) continue;
      const task = await this.storage.claimCustomQueuedTask(head.id, 'orchestrator');
      if (!task) continue; // its repo got held (or the row changed) underneath us
      await this.startWorker(task);
    }
  }

  /**
   * Repos whose custom-queue MEMBER is parked between a finished turn and its
   * follow-on — only those repos wait; the rest of the queue runs on.
   */
  private async customQueueHeldRepos(): Promise<Set<string>> {
    const nowMs = Date.now();
    const repos = new Set<string>();
    for (const [id, since] of this.customQueueHold) {
      const t = await this.storage.getTask(id);
      // Deleted, not a member, or already past the gap (running again, shipped,
      // done): nothing to wait for — drop the entry rather than keep reading it.
      if (!t || !t.customQueueAt || t.status !== 'review') {
        this.customQueueHold.delete(id);
        continue;
      }
      if (nowMs - since > CUSTOM_QUEUE_HOLD_TTL_MS) {
        console.warn(`custom queue: hold on task ${id} expired after ${CUSTOM_QUEUE_HOLD_TTL_MS / 60_000} min — releasing`);
        this.customQueueHold.delete(id);
        continue;
      }
      if (t.repoId) repos.add(t.repoId);
    }
    return repos;
  }

  /** Park a task whose turn just ended until its follow-on has resolved (see customQueueHold). */
  holdCustomQueue(taskId: string): void {
    this.customQueueHold.set(taskId, Date.now());
  }

  releaseCustomQueue(taskId: string): void {
    if (!this.customQueueHold.delete(taskId)) return;
    this.maybeSchedule(); // the queue may have been waiting on exactly this
  }

  /** Live non-idle creator runs with no currently-running created task (R1:
   *  one overflow credit per live creating session). */
  private async overflowEligibleRunIds(): Promise<string[]> {
    const liveRuns = (await this.storage.listRuns({ status: 'running', mode: 'worker' })).filter((r) => {
      const s = this.sessions.get(r.id);
      return s !== undefined && s.exit === null && !s.idle;
    });
    if (liveRuns.length === 0) return [];
    const runningTasks = await this.storage.listTasks({ status: 'running' });
    const consumed = new Set(runningTasks.map((t) => t.createdByRun).filter(Boolean));
    return liveRuns.map((r) => r.id).filter((id) => !consumed.has(id));
  }

  /**
   * Shared space (docs/shared-spaces.md): the folder every turn of a member
   * repo gets as $TM_SHARED_DIR, plus the turn's block of open requests for
   * the repo — all of them on a fresh session, only the ones newer than the
   * resumed run's start on a resume, none on the publish turn. Best-effort by
   * design: a ledger hiccup must never fail a spawn.
   */
  private async sharedContext(
    task: Task,
    purpose: 'work' | 'publish',
    resumed: Run | null,
  ): Promise<{ dir: string; note?: string } | undefined> {
    try {
      const space = await spaceForRepo(this.storage, task.repoId);
      if (!space) return undefined;
      // Re-checked per spawn: a repo registered or moved after the space was
      // created could now sit inside the folder (or contain it), and
      // --add-dir would then open another checkout to this agent.
      const overlap = validateSpacePath(space.path, await this.storage.listRepos());
      if ('error' in overlap) {
        console.error(`shared space "${space.name}" skipped for this turn: ${overlap.error}`);
        return undefined;
      }
      // A folder deleted by hand comes back with its generated README, so
      // an agent is never pointed at an empty directory with no conventions.
      if (!fs.existsSync(path.join(space.path, 'README.md'))) await writeFolderDocs(this.storage, space);
      // Every spawn refreshes the folder's CLAUDE.md from INDEX.md (agents
      // edit the map between turns); the CLI loads it at session start, the
      // publish turn included.
      else await writeSharedMemory(this.storage, space);
      if (purpose === 'publish') return { dir: space.path };
      const note = await sharedPromptBlock(
        { storage: this.storage },
        task,
        space,
        resumed ? { since: resumed.startedAt } : {},
      );
      return { dir: space.path, note };
    } catch (e) {
      console.error('shared space context failed (spawning without it):', e);
      return undefined;
    }
  }

  /** Any live non-idle worker session currently editing this repo? */
  private async repoBusy(repoId: string): Promise<boolean> {
    const running = await this.storage.listRuns({ status: 'running', mode: 'worker' });
    return running.some((r) => {
      if (r.repoId !== repoId) return false;
      const s = this.sessions.get(r.id);
      return s !== undefined && s.exit === null && !s.idle;
    });
  }

  /**
   * Dispatch delivery (docs/dispatch.md): reopen each target task's own claude
   * session (the normal followUp/resume machinery) with the messages other
   * task sessions queued for it. All pending dispatches for one target go out
   * in ONE resumed turn, oldest first. A target that cannot take a turn right
   * now — mid-turn, queued, blocked, its repo busy, or the concurrency cap
   * reached — is simply held for a later tick; only a target that can never
   * receive (deleted, repo-less) settles as failed. Rides maybeSchedule, so
   * every finished turn is also a delivery opportunity.
   *
   * Only `needs_action` dispatches get a target this far (docs/dispatch.md
   * § Intent). An `fyi` never starts a turn: it stays pending until some
   * OTHER reason resumes the session, and `followUp` picks it up there. The
   * one thing this loop does for `fyi` is settle it against a target that has
   * gone terminal — no session will ever open again, so it is recorded as a
   * note on the task instead of waiting forever.
   */
  async deliverDispatches(): Promise<void> {
    if (this.deliveringDispatches) return;
    this.deliveringDispatches = true;
    try {
      // Deliberately NOT gated on orchestrator.enabled (user decision
      // 2026-08-27): a dispatch continues an existing conversation, exactly
      // like a human follow-up, so it goes out even while the queue is stopped.
      const settings = await this.storage.getSettings();
      const pending = await this.storage.listDispatches({ status: 'pending' });
      if (pending.length === 0) return;

      // newest-first from storage → reverse for oldest-first, grouped by target
      const byTarget = new Map<string, Dispatch[]>();
      for (const d of [...pending].reverse()) {
        const list = byTarget.get(d.toTaskId);
        if (list) list.push(d);
        else byTarget.set(d.toTaskId, [d]);
      }

      for (const [taskId, list] of byTarget) {
        const settle = async (items: Dispatch[], status: 'delivered' | 'failed', note: string | null) => {
          for (const d of items) {
            const updated = await this.storage.settleDispatch(d.id, status, note);
            if (!updated) continue;
            broadcast({ type: 'dispatch.updated', dispatch: updated });
            await this.storage.appendEvent({
              kind: 'task.dispatch',
              actor: 'orchestrator',
              taskId: updated.toTaskId,
              data: { phase: status, dispatchId: d.id, fromTaskId: updated.fromTaskId, note },
            });
          }
        };

        const target = await this.storage.getTask(taskId);
        if (!target) {
          await settle(list, 'failed', 'target task no longer exists');
          continue;
        }
        if (!target.repoId) {
          await settle(list, 'failed', 'target task has no repo');
          continue;
        }

        // `fyi` to a task that has finished for good: no session is ever going
        // to be resumed for it, so waiting is waiting forever. Record it as a
        // note on the task and settle. Done BEFORE the hold checks below —
        // writing a note needs no agent, no repo lock and no concurrency slot.
        // (`needs_action` deliberately keeps resuming a terminal target: a
        // finished task can still be asked to change something, and followUp
        // has always allowed done/published/cancelled.)
        const actionable = list.filter((d) => d.intent === 'needs_action');
        if (DISPATCH_TERMINAL_STATUSES.includes(target.status)) {
          const fyi = list.filter((d) => d.intent === 'fyi');
          if (fyi.length > 0) {
            await settle(fyi, 'delivered', `recorded as a note — target task is '${target.status}', no session resumed`);
          }
        }
        // The whole point of the intent split: an `fyi` never wakes a session.
        // With nothing actionable there is no turn to start, so this target is
        // simply left alone — `followUp` picks its backlog up whenever some
        // other reason opens that session. (A `needs_action` still resumes a
        // terminal target: followUp has always allowed done/published/cancelled,
        // and a finished task can still be asked to change something.)
        if (actionable.length === 0) continue;

        // Hold (retry later): mid-turn / between its own turns / about to
        // start / waiting on children. `waiting` in particular: its session
        // is live and about to be re-invoked by its own subagent, and a resume
        // would kill that session and lose the child's result.
        if (['running', 'waiting', 'queued', 'blocked'].includes(target.status)) continue;
        // A turn we already fired for this target has not spawned yet (it may
        // be compacting). Its status is still whatever it was, so without this
        // the next pass would deliver the same backlog a second time.
        if (this.dispatchTurnsInFlight.has(taskId)) continue;
        const targetRuns = await this.storage.listRuns({ taskId, mode: 'worker' });
        // A draft that never ran must NOT be started by a dispatch — that
        // would let an agent bypass the enqueue gate (file a draft, dispatch
        // to it). It becomes deliverable once a human/queue runs it.
        if (target.status === 'draft' && targetRuns.length === 0) continue;
        const busy = targetRuns.some((r) => {
          const s = this.sessions.get(r.id);
          return s !== undefined && s.exit === null && !s.idle;
        });
        if (busy) continue;
        // Never resume an agent into a repo another agent is actively editing —
        // including by a turn we fired that has not spawned its PTY yet.
        if (await this.repoBusy(target.repoId)) continue;
        if (target.repoId && [...this.dispatchTurnsInFlight.values()].includes(target.repoId)) continue;
        // Delivery starts a real agent turn — it respects worker concurrency.
        // `activeWorkers()` rather than the raw PTY count, so turns already
        // fired but not yet spawned still occupy their slot.
        if (this.activeWorkers() >= settings['orchestrator.concurrency']) break;
        // budget.taskUsd: waking the target is an automatic turn. Refused, the
        // messages fail with the reason (they stay readable on the dispatch
        // rows) rather than being retried every pass; a human Follow-up on
        // the target still works.
        const verdict = await this.budgetAllows(target, 'dispatch', settings);
        if (!verdict.ok) {
          await settle(actionable, 'failed', verdict.reason);
          await this.refuseOverBudget(taskId, 'dispatch', verdict);
          continue;
        }

        const items: { fromTitle: string; fromTaskId: string; message: string }[] = [];
        for (const d of actionable) {
          const from = await this.storage.getTask(d.fromTaskId);
          items.push({ fromTitle: from?.title ?? '(deleted task)', fromTaskId: d.fromTaskId, message: d.message });
        }
        // Any `fyi` still pending for this target is NOT in `items`: followUp
        // drains it into the same prompt ahead of this block (the "prepended
        // to that turn's dispatch backlog" rule) and settles it there.
        // NOT awaited. `followUp` can now sit inside a resume gate for minutes
        // (docs/token-budget.md § The fourth), and this loop runs inside
        // `maybeSchedule`'s single-flight pass — awaiting it would stop the
        // claim loop, `pumpCustomQueue` and every other delivery for that long.
        // The target is held in `dispatchTurnsInFlight` instead, which is what
        // the guards at the top of this loop and `activeWorkers()` read, so
        // releasing the scheduler does not mean releasing the target.
        this.dispatchTurnsInFlight.set(taskId, target.repoId);
        void this.followUp(taskId, buildDispatchTurn(items), 'dispatch')
          .then(async (res) => {
            // Raced with a claim or a human action — hold, and let the next
            // pass retry. Same decision as before, just later.
            if ('error' in res) return;
            await settle(actionable, 'delivered', null);
          })
          .catch((err) => console.error('dispatch delivery turn failed:', err))
          // Releases the target, and deliberately does NOT wake the scheduler.
          // A turn that was ABORTED (shutdown, `/killall`) parks its task back
          // in `review`, which makes it deliverable again — waking a pass right
          // here would re-deliver it and start a new compaction seconds after
          // an emergency stop, the exact loop round 1 closed. The 10s safety
          // tick, and every real event, still retry.
          .finally(() => this.dispatchTurnsInFlight.delete(taskId));
      }
    } catch (err) {
      // delivery must never take the scheduler down with it
      console.error('dispatch delivery failed:', err);
    } finally {
      this.deliveringDispatches = false;
    }
  }

  /**
   * Model routing (user rule 2026-08-24): explicit task.model always wins;
   * tool/browser-testing tasks get the fallback model (Opus); otherwise the
   * primary (Fable) while 5h/session usage < threshold, then the fallback.
   * The percentage is the account's own when the CLI cached a live one, else
   * our transcript estimate.
   */
  private async resolveModel(task: Task, settings: AppSettings): Promise<string> {
    if (task.model) return task.model;
    if (!settings['router.enabled']) return settings['agent.model'];
    if (needsFallbackModel(task.title, task.description)) return settings['router.fallbackModel'];
    const pct = await sessionUsagePct(settings['router.budget5hTokens']);
    return pct < settings['router.usageThresholdPct']
      ? settings['router.primaryModel']
      : settings['router.fallbackModel'];
  }

  /**
   * The most recent worker run of this task whose claude session can still be
   * continued with `claude --resume`. Requires (a) a recorded session id,
   * (b) the same repo — sessions live under their project directory, so
   * resuming from elsewhere would not find them, and (c) the transcript still
   * on disk, so a deleted/pruned session degrades to a fresh spawn instead of
   * a `claude` that exits immediately and fails the task.
   */
  private async findResumableRun(taskId: string, repoId: string): Promise<Run | null> {
    const runs = await this.storage.listRuns({ taskId }); // newest first
    for (const r of runs) {
      if (r.mode !== 'worker' || !r.sessionId) continue;
      if (r.repoId && r.repoId !== repoId) continue;
      if (!r.transcriptPath || !fs.existsSync(r.transcriptPath)) continue;
      return r;
    }
    return null;
  }

  /** Wait (briefly) for a killed PTY to actually die before reusing its claude
   *  session — resuming while the old process still holds it can fail. */
  private async waitForSessionExit(runId: string, timeoutMs = 5000): Promise<void> {
    const s = this.sessions.get(runId);
    if (!s) return;
    const deadline = Date.now() + timeoutMs;
    while (s.exit === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * The `fyi` dispatch backlog waiting on one task (docs/dispatch.md § Intent),
   * as a prompt block plus the settle that goes with it.
   *
   * Split in two halves deliberately: the note has to be READ before the spawn
   * (it goes into the prompt) and SETTLED only after the spawn succeeded — a
   * worker that never started showed the agent nothing, so its messages must
   * stay `pending` for the next attempt.
   */
  private async pendingFyiDispatches(
    taskId: string,
  ): Promise<{ note: string | undefined; settle: () => Promise<void> }> {
    const pending = (await this.storage.listDispatches({ toTaskId: taskId, status: 'pending' }))
      .filter((d) => d.intent === 'fyi')
      .reverse(); // storage is newest-first; the turn reads them oldest-first
    if (pending.length === 0) return { note: undefined, settle: async () => {} };

    const items: { fromTitle: string; fromTaskId: string; message: string }[] = [];
    for (const d of pending) {
      const from = await this.storage.getTask(d.fromTaskId);
      items.push({ fromTitle: from?.title ?? '(deleted task)', fromTaskId: d.fromTaskId, message: d.message });
    }
    return {
      note: buildDispatchNote(items),
      settle: async () => {
        for (const d of pending) {
          const updated = await this.storage.settleDispatch(
            d.id,
            'delivered',
            // "turn", not "resume": this also covers a fresh spawn with no
            // session on disk, and the note has to be true in both cases.
            'handed over on the target\u2019s next turn, which started for another reason',
          );
          if (!updated) continue; // raced with a human cancel — settleDispatch is conditional
          broadcast({ type: 'dispatch.updated', dispatch: updated });
          await this.storage.appendEvent({
            kind: 'task.dispatch',
            actor: 'orchestrator',
            taskId: updated.toTaskId,
            data: {
              phase: 'delivered',
              dispatchId: d.id,
              fromTaskId: updated.fromTaskId,
              intent: 'fyi',
              rideAlong: true,
            },
          });
        }
      },
    };
  }

  /**
   * The resume gate (docs/token-budget.md § The fourth). A worker session that
   * has grown past `agent.resumeContextCap` is about to be `--resume`d: the CLI
   * re-writes the entire conversation to cache TWICE before the follow-up turn
   * says a word (measured 395k + 398k tokens, ~$15), and every later turn of
   * that run re-reads it. Most of those bytes are stale tool output, not
   * knowledge.
   *
   * Fires ONLY here — between turns, on an idle session the caller has already
   * killed — never mid-run: a session doing good work at 300k is left alone
   * until the moment it would otherwise be re-bought.
   *
   * Preference order, and why:
   *  - `resume`  — under the cap, or the gate is off. Unchanged behaviour.
   *  - `compact` — over the cap: `/compact <focus>` costs ONE cache-write of
   *    the conversation instead of two, and leaves the session at ~10k so the
   *    rest of the run is cheap. The session keeps its identity, so nothing
   *    downstream (sessionId, statsBaseline, the PTY resume) changes.
   *  - `fresh`   — compaction failed. A cold start with a rich handoff is
   *    still better than re-buying half a megabyte of stale context.
   *
   * The publish turn is the one exception to that last step: it commits work it
   * must already know about, and the existing no-session path for publish is
   * `publishRepo` in-process, not "a new agent guesses a commit message". So a
   * failed compaction there falls back to the plain resume and pays the old
   * price rather than handing the commit to a stranger.
   */
  private async resumeHandoff(
    task: Task,
    repo: Repo,
    resumeFrom: Run | null,
    prev: TranscriptSummary | null,
    settings: AppSettings,
    model: string,
    followUp: string | undefined,
    purpose: 'work' | 'publish',
  ): Promise<ResumeHandoff> {
    if (!resumeFrom?.sessionId || !resumeFrom.transcriptPath) return { kind: 'fresh' };
    // Codex runs never carry a sessionId (see buildWorkerInvocation), so this
    // is unreachable today — but `/compact` is a claude slash command and must
    // never be aimed at another CLI if that ever changes.
    if (isCodexModel(model)) return { kind: 'resume' };

    const cap = settings['agent.resumeContextCap'];
    const ctx = prev?.stats.contextTokens ?? 0;
    // ctx === 0 means the transcript told us nothing (unparseable, or no usage
    // record yet). Unknown is not "over the cap": stay with the old behaviour.
    if (!(cap > 0) || ctx <= cap) return { kind: 'resume' };

    const result = await compactSession({
      cwd: repo.path,
      sessionId: resumeFrom.sessionId,
      transcriptPath: resumeFrom.transcriptPath,
      model,
      focus: compactFocus(task.title, followUp, purpose),
      label: `compact: ${task.title.slice(0, 60)}`,
      // Keyed by the task so `cancel()` can stop a compaction it is about to
      // make pointless, instead of paying for another two minutes of it.
      key: task.id,
      repoId: repo.id,
    });
    if (result.outcome === 'aborted') {
      return { kind: 'abort', detail: { compactAborted: result.reason ?? 'stopped', cap } };
    }
    if (result.ok) {
      return {
        kind: 'compact',
        detail: { compactedFrom: result.preTokens, compactedTo: result.postTokens, cap },
      };
    }
    if (purpose === 'publish') {
      return { kind: 'resume', detail: { compactError: result.reason ?? 'unknown', cap } };
    }
    const files = await changedFiles(repo.path).catch(() => [] as string[]);
    return {
      kind: 'fresh',
      previousSummary: freshHandoff({
        lastAssistantText: prev?.lastAssistantText ?? null,
        fallbackSummary: task.resultSummary,
        files,
        reason: `${Math.round(ctx / 1000)}k tokens of context, over the ${Math.round(cap / 1000)}k cap, and it could not be compacted`,
      }),
      detail: { compactError: result.reason ?? 'unknown', cap, handoffFiles: files.length },
    };
  }

  /** Spawns the PTY for a task already in `running`. Reverts the claim on failure.
   *  `purpose: 'publish'` marks the run as the commit-and-push turn so its Stop
   *  is settled against git instead of parking the task in review. */
  /**
   * The `Previous attempt` block of a fresh start (docs/design.md § Retry with
   * context): what the task's last session left behind — how it ended, its
   * closing words, the row's summary, the repo checks' verdict and the files
   * dirty in the tree — so Retry stops being amnesiac. Built by the resume
   * gate's own `freshHandoff`. undefined when the task never had a session.
   */
  private async retryContext(task: Task, repoPath: string): Promise<string | undefined> {
    const prev = (await this.storage.listRuns({ taskId: task.id })).find((r) => r.mode === 'worker');
    if (!prev) return undefined;
    const transcript =
      prev.transcriptPath && fs.existsSync(prev.transcriptPath)
        ? await summarizeTranscript(prev.transcriptPath, prev.model).catch(() => null)
        : null;
    // Retry and Run now clear `error` from the row as they start the task
    // again; the `task.retry` row they write keeps it for here — only when it
    // is newer than that attempt, or it belongs to an older one.
    const retried = (await this.storage.listEvents({ kind: 'task.retry', taskId: task.id, limit: 1 }))[0];
    const fromRetry = retried && retried.at >= prev.startedAt ? retried.data : null;
    const error = task.error ?? (typeof fromRetry?.previousError === 'string' ? fromRetry.previousError : null);
    const ended = typeof fromRetry?.from === 'string' ? ` and ended '${fromRetry.from}'` : '';
    const files = await changedFiles(repoPath).catch(() => [] as string[]);
    return freshHandoff({
      intro:
        `This task has been attempted before (${task.attempts} session${task.attempts === 1 ? '' : 's'} so far${ended}).` +
        ' That attempt is over: you are a NEW agent session with none of its context, starting on the working tree it left.' +
        ' Below is what it left behind — read it, then decide from the files themselves what to keep and what to redo.',
      reason: 'retry',
      error,
      lastAssistantText: transcript?.lastAssistantText ?? null,
      fallbackSummary: task.resultSummary,
      checks: task.checkResults,
      files,
    });
  }

  private async startWorker(
    // Reassigned once, after the resume gate: a compaction can take minutes,
    // and the row must be re-read before anything is spawned against it.
    task: Task,
    followUp?: string,
    resumeFrom?: Run | null,
    purpose: 'work' | 'publish' = 'work',
  ): Promise<boolean> {
    // Any turn the transient-error path did not start ends that path: a human
    // Proceed during the back-off, a fresh claim (docs/design.md § Transient
    // API errors). Its own `--resume` keeps the count — two per turn.
    if (!this.transientResuming.has(task.id)) this.dropTransient(task.id);
    // Claim-loop twin of the runNow guard (review R3b): a task enqueued from
    // review may still have its previous session alive.
    if (await this.hasLiveSession(task.id)) {
      const reverted = await this.storage.transitionTask(task.id, ['running'], 'review', 'orchestrator', {
        error: 'previous session is still live — kill it before re-running',
      });
      if (reverted) broadcast({ type: 'task.updated', task: reverted });
      return false;
    }
    const repo = task.repoId ? await this.storage.getRepo(task.repoId) : null;
    if (!repo) {
      const reverted = await this.storage.transitionTask(task.id, ['running'], 'failed', 'orchestrator', {
        error: 'task has no repo',
      });
      if (reverted) broadcast({ type: 'task.updated', task: reverted });
      return false;
    }
    const settings = await this.storage.getSettings();
    const model = await this.resolveModel(task, settings);
    // Per-run token (agent-API review R5): hook callbacks and agent API calls
    // authenticate as THIS run — attribution is server-derived, not client-asserted.
    const runToken = randomBytes(24).toString('hex');
    // Resumed runs append to the SAME transcript, so snapshot its cumulative
    // totals now and report only what this run adds on top (no double billing).
    // Captured BEFORE the resume gate below, on purpose: a compaction is itself
    // a paid turn on this transcript, and the run that decided to compact is
    // the one that should carry its cost.
    const prev =
      resumeFrom?.transcriptPath && fs.existsSync(resumeFrom.transcriptPath)
        ? await summarizeTranscript(resumeFrom.transcriptPath, resumeFrom.model)
        : null;
    // Guarded, and guarded HERE rather than inside: this runs before the run
    // row exists, so an exception escaping it would leave the task `running`
    // with no run, no PTY and no error to explain either. Falling back to
    // `resume` means the worst case of a broken gate is the old cost, not a
    // stuck task.
    // Registered for the whole gate window — the compaction AND the settlement
    // that follows it — so shutdown can wait for it and the scheduler counts it
    // as a worker on its way. Removed in the `finally` below, on every exit.
    // Registered for the whole gate window — the compaction AND the settlement
    // that follows it — so shutdown can wait for it and the scheduler counts it
    // as a worker on its way. Removed in the `finally`, on every exit.
    this.gatesInFlight.add(task.id);
    let handoff: ResumeHandoff;
    let still: Task | null;
    try {
      handoff = await this.resumeHandoff(
        task,
        repo,
        resumeFrom ?? null,
        prev,
        settings,
        model,
        followUp,
        purpose,
      ).catch((e): ResumeHandoff => {
        console.error('resume gate failed, resuming as before:', e);
        return { kind: 'resume', detail: { handoffError: String((e as Error)?.message ?? e).slice(0, 200) } };
      });

      // Everything from here on assumes the world did not move while the gate
      // ran. Before the gate existed that assumption cost nothing — the
      // distance from `followUp`'s transition to `running` down to the spawn
      // was a few milliseconds. A compaction makes it up to ten minutes, which
      // is long enough for a human to cancel the task, for `/killall` to
      // declare the machine idle, or for a forced restart to be halfway
      // through closing storage. So the two things that changed have to be
      // re-checked before a run row exists, not after a PTY is already editing
      // the repo.
      if (handoff.kind === 'abort') {
        // We stopped the compaction ourselves. Park the task where a human can
        // pick it up again — the same place the live-session guard above parks
        // one — and spawn nothing. Guarded, because the commonest reason we
        // stopped it is a shutdown, and storage may already be closing: a
        // failure to record this is not a reason to throw out of startWorker,
        // and `recoverOnBoot` sweeps exactly this state on the way back up.
        try {
          const reverted = await this.storage.transitionTask(task.id, ['running'], 'review', 'orchestrator', {
            error: 'stopped while compacting the previous session before resuming it — follow up again to retry',
          });
          if (reverted) broadcast({ type: 'task.updated', task: reverted });
          await this.storage.appendEvent({
            kind: 'schedule.spawn-fail',
            actor: 'orchestrator',
            taskId: task.id,
            repoId: repo.id,
            data: { reason: 'resume gate aborted', ...(handoff.detail ?? {}) },
          });
        } catch (e) {
          console.error('could not park an aborted resume gate (storage closing?):', e);
        }
        return false;
      }
      // Re-read rather than trust the `task` we were handed: `cancel()` (and
      // anything else that moves a task) writes to storage, not to this
      // closure. Broadcasting the stale object would also flip the UI back to
      // `running` for a task the human just cancelled.
      still = await this.storage.getTask(task.id);
      if (!still || still.status !== 'running') {
        await this.storage.appendEvent({
          kind: 'schedule.spawn-fail',
          actor: 'orchestrator',
          taskId: task.id,
          repoId: repo.id,
          data: { reason: `task left 'running' while the resume gate ran (now '${still?.status ?? 'deleted'}')` },
        });
        if (still) broadcast({ type: 'task.updated', task: still });
        return false;
      }
    } finally {
      this.gatesInFlight.delete(task.id);
    }
    task = still;
    // A loop task's fresh start with no instruction of its own IS an
    // iteration (docs/loops.md): numbered and stepped to `iterating` here,
    // the one funnel every start goes through (claim, Run now, Retry, the
    // custom queue, the loop pump). Its prompt carries the ledger instead of
    // the retry context.
    const loopTurn = task.kind === 'loop' && !followUp && !resumeFrom && purpose === 'work';
    if (loopTurn) {
      const began = await this.beginLoopIteration(task);
      if (!began) return false;
      task = began;
    }
    // Retry with context (docs/design.md § Retry with context): a fresh start
    // with no instruction of its own, of a task that already had a session.
    // Read BEFORE createRun, while "the newest worker run" is still the last
    // attempt's.
    const retryContext =
      !loopTurn && !followUp && !resumeFrom && purpose === 'work'
        ? await this.retryContext(task, repo.path).catch((e) => {
            console.error('retry context failed, starting without it:', e);
            return undefined;
          })
        : undefined;
    // The task's base, once: its first worker spawn (docs/design.md
    // § Adversarial review, "What the reviewer reads"). Before createRun, so
    // "no worker run yet" still means first.
    task = await this.ensureBase(task, repo, true);

    const run = await this.storage.createRun({
      taskId: task.id,
      repoId: repo.id,
      mode: 'worker',
      // Persisted mark of a publish turn: it edits nothing, so it never makes
      // its task the owner of the working tree (`treeOwner`, docs/queue.md §
      // Stacked tasks) — `publishRuns` is in memory and gone by settle time.
      label: purpose === 'publish' ? PUBLISH_RUN_LABEL : null,
      model,
      effort: task.effort ?? settings['agent.effort'],
      runToken,
      // A fresh session writes its OWN transcript, so it inherits neither the
      // lineage nor the baseline — subtracting the old session's totals from a
      // file it never wrote would zero out this run's real usage.
      resumedFrom: handoff.kind === 'fresh' ? null : resumeFrom?.id ?? null,
      statsBaseline: handoff.kind === 'fresh' ? null : prev?.stats ?? null,
    });
    if (purpose === 'publish') this.publishRuns.add(run.id);
    try {
      const artifactsDir = path.join(artifactsRoot, task.id);
      fs.mkdirSync(artifactsDir, { recursive: true });
      // `fyi` dispatch backlog (docs/dispatch.md § Intent). Drained HERE, not
      // in followUp: every turn this task takes — a fresh claim, Run now,
      // Retry, a custom-queue claim, a resume, publish — goes through
      // startWorker, and the instruction sheet promises delivery on "the next
      // turn it takes anyway". Draining one layer up would have missed the
      // four callers that spawn without a follow-up (review round 1, major).
      const fyi = await this.pendingFyiDispatches(task.id);
      const resumeSessionId = handoff.kind === 'fresh' ? undefined : resumeFrom?.sessionId ?? undefined;
      const shared = await this.sharedContext(task, purpose, resumeSessionId ? resumeFrom ?? null : null);
      // Definition of done (docs/checks.md): the acceptance text plus the
      // checks the Stop will run — a fresh prompt only, never the publish turn.
      const checksForPrompt = selectChecks(await this.storage.listCommands(repo.id), task);
      // A loop iteration's block carries the acceptance text and the checks itself.
      const doneNote =
        resumeSessionId || purpose === 'publish' || loopTurn ? null : definitionOfDone(task.acceptance, checksForPrompt);
      const loop =
        loopTurn && !resumeSessionId
          ? {
              note: loopNote({ task, n: task.loopIteration, ledger: readLedger(artifactsDir), checks: checksForPrompt }),
              result: loopResultBlock(),
            }
          : undefined;
      const inv = buildWorkerInvocation({
        task: { ...task, model },
        settings,
        runId: run.id,
        token: runToken,
        callbackUrl: this.callbackUrl,
        artifactsDir,
        followUp,
        dispatchNote: fyi.note,
        shared,
        doneNote: doneNote ?? undefined,
        landing: effectiveLanding(task, repo),
        resumeSessionId,
        previousSummary: handoff.previousSummary ?? retryContext,
        loop,
      });
      const session = this.sessions.spawn({
        runId: run.id,
        cmd: inv.cmd,
        args: inv.args,
        cwd: repo.path,
        env: inv.env,
      });
      const withPid = await this.storage.updateRun(run.id, { pid: session.pty.pid });
      // A new claude session is a new attempt (`tm_tasks.attempts`); a resume
      // of any kind is the same attempt carrying on. Counted once the PTY
      // exists, so a spawn that threw is not an attempt.
      // A loop's later iterations are fresh sessions by design, not re-attempts.
      if (!resumeSessionId && !(loopTurn && task.loopIteration > 1)) {
        task = (await this.storage.bumpTaskAttempts(task.id)) ?? task;
      }
      await this.storage.appendEvent({
        kind: 'run.started',
        actor: 'orchestrator',
        taskId: task.id,
        runId: run.id,
        repoId: repo.id,
        data: {
          model,
          effort: task.effort ?? settings['agent.effort'],
          resumedFrom: handoff.kind === 'fresh' ? null : resumeFrom?.id ?? null,
          sessionId: handoff.kind === 'fresh' ? null : resumeFrom?.sessionId ?? null,
          // Which path the resume gate took, so the saving can be measured
          // against costUsd per run (docs/token-budget.md § The fourth).
          handoff: handoff.kind,
          ...(loopTurn ? { loopIteration: task.loopIteration } : {}),
          ...(resumeFrom ? { contextTokens: prev?.stats.contextTokens ?? 0 } : {}),
          ...(handoff.detail ?? {}),
        },
      });
      broadcast({ type: 'run.started', run: withPid ?? run });
      // A turn started, so nothing is waiting on the usage window any more —
      // whoever started it (the waker, a human hitting Proceed, a dispatch)
      // has settled the wait. `startWorker` is the single funnel every turn
      // goes through, which is why the clear lives here and nowhere else.
      if (task.wakeAt) await this.clearWake(task.id);
      broadcast({ type: 'task.updated', task });
      // The status was only broadcast on toggle and on EXIT, so the header's
      // "running n/2" (and the restart guard that reads it) stayed stale for a
      // whole session after a spawn.
      broadcast({ type: 'orchestrator.status', status: await this.status() });
      // Settled only now: the agent has a live session and the note is in the
      // prompt it was spawned with. A spawn that threw above leaves every
      // `fyi` pending for the next turn. Its own try/catch on purpose —
      // bookkeeping must never fail a worker that is already running.
      try {
        await fyi.settle();
      } catch (e) {
        console.error('settling fyi dispatches failed:', e);
      }
      return true;
    } catch (err) {
      this.publishRuns.delete(run.id);
      await this.storage.updateRun(run.id, { status: 'exited', endedAt: new Date().toISOString() });
      // Transient capacity exhaustion reverts to queued; anything else fails
      // terminally (no-auto-retry decision; impl review F3 carve-out).
      await this.storage.appendEvent({
        kind: 'schedule.spawn-fail',
        actor: 'orchestrator',
        taskId: task.id,
        runId: run.id,
        data: { error: (err as Error).message.slice(0, 300) },
      });
      if ((err as Error).message.includes('session cap reached')) {
        if (loopTurn) {
          // The iteration never started: step it back to `next` (same number)
          // and let the loop pump retry it when a PTY frees up.
          const back = await this.storage.stepLoop(task.id, ['iterating'], {
            loopState: 'next',
            loopIteration: Math.max(0, task.loopIteration - 1),
          });
          if (back) {
            broadcast({ type: 'task.updated', task: back });
            return false;
          }
        }
        const requeued = await this.storage.transitionTask(task.id, ['running'], 'queued', 'orchestrator');
        if (requeued) broadcast({ type: 'task.updated', task: requeued });
        return false;
      }
      const failed = await this.storage.transitionTask(task.id, ['running'], 'failed', 'orchestrator', {
        error: `spawn failed: ${(err as Error).message}`,
      });
      if (failed) {
        broadcast({ type: 'task.updated', task: failed });
        await this.resolveCompletion(failed, 'orchestrator');
      }
      return false;
    }
  }

  /** True when a PTY for this task is still alive (live or idle post-Stop).
   *  Checks ALL runs — cancel/kill mark rows `killed` before the process
   *  actually dies, so the sessions map is the source of truth (review R4). */
  async hasLiveSession(taskId: string): Promise<boolean> {
    const runs = await this.storage.listRuns({ taskId });
    return runs.some((r) => {
      const s = this.sessions.get(r.id);
      return s !== undefined && s.exit === null;
    });
  }

  /**
   * Human/loop follow-up. A session that has FINISHED its turn (idle) sits at
   * the claude prompt where PTY-injected text does not reliably submit, so we
   * always respawn.
   *
   * The respawn CONTINUES the previous claude session (`claude --resume`) when
   * one is still on disk — the terminal-user habit of reopening a session and
   * typing "proceed". That keeps everything the agent already learned instead
   * of restarting a fresh agent from the task text plus a summary. Falls back
   * to a fresh session when nothing is resumable, unless mode is 'resume'
   * (the explicit Proceed button), which reports the reason instead.
   *
   * Resumes are only SOME of the turns a task takes, which is why the `fyi`
   * dispatch backlog is drained one layer down in `startWorker` and not here
   * (docs/dispatch.md § Intent) — the claim loop, pumpCustomQueue and runNow
   * never come through this function.
   */
  async followUp(
    taskId: string,
    message: string,
    actor = 'human',
    mode: 'auto' | 'resume' | 'fresh' = 'auto',
    purpose: 'work' | 'publish' = 'work',
  ): Promise<ActionResult> {
    const cur = await this.storage.getTask(taskId);
    if (!cur) return { error: 'task not found', code: 404 };
    if (!cur.repoId) return { error: 'assign a repo first', code: 409 };

    const runs = await this.storage.listRuns({ taskId });
    const liveRun = runs.find((r) => {
      const s = this.sessions.get(r.id);
      return s !== undefined && s.exit === null;
    });
    if (liveRun && !this.sessions.isIdle(liveRun.id)) {
      // still working — a follow-up mid-turn would interleave; make them wait.
      return { error: 'the agent is still working — wait for it to finish (review), then follow up', code: 409 };
    }
    if (cur.kind === 'loop' && cur.status === 'running' && (cur.loopState === 'checking' || cur.loopState === 'next')) {
      // between two iterations (docs/loops.md): there is no session to talk
      // to, and the next iteration is about to start from the ledger
      return { error: 'the loop is between iterations — wait for the next one, or cancel it', code: 409 };
    }

    const settings = await this.storage.getSettings();
    const wantResume = mode === 'resume' || (mode === 'auto' && settings['agent.resumeSessions']);
    const resumeFrom = wantResume ? await this.findResumableRun(taskId, cur.repoId) : null;
    if (mode === 'resume' && !resumeFrom) {
      return {
        error: 'no resumable agent session for this task — use Run now to start a fresh agent',
        code: 409,
      };
    }

    if (liveRun) {
      // Idle session: retire it so the respawn below starts clean, and wait for
      // the process to ACTUALLY die. Two reasons: `--resume` on a session
      // another process still holds fails, and startWorker's live-session guard
      // would otherwise see the dying PTY and refuse its own respawn.
      this.sessions.kill(liveRun.id);
      await this.waitForSessionExit(liveRun.id);
      await this.storage.updateRun(liveRun.id, { status: 'killed', endedAt: new Date().toISOString() });
    }

    // Respawn with the follow-up threaded into the prompt.
    if (cur.status === 'running' && !liveRun) {
      return { error: 'task is marked running but has no live session — retry it', code: 409 };
    }
    const task = await this.storage.transitionTask(
      taskId,
      // 'running' included: we may have just killed an idle session whose task
      // was left in 'running' (e.g. a failed live-injection). 'published' too:
      // shipping a task does not end the conversation with its agent.
      ['draft', 'queued', 'running', 'review', 'published', 'done', 'failed', 'cancelled'],
      'running',
      actor,
      {
        error: null,
        // A loop iteration cut short mid-turn (a usage-limit park, a budget
        // refusal, a crash) that is RESUMED in its own session finishes as
        // that iteration (docs/loops.md): its Stop goes back to the loop.
        ...(cur.kind === 'loop' &&
        cur.loopState === 'paused' &&
        resumeFrom &&
        purpose === 'work' &&
        cur.loopIteration > 0 &&
        cur.loopHistory.at(-1)?.n !== cur.loopIteration
          ? { loopState: 'iterating' as const }
          : {}),
      },
    );
    if (!task) return { error: `cannot follow up from status '${cur.status}'`, code: 409 };
    broadcast({ type: 'task.updated', task });
    await this.storage.appendEvent({
      kind: 'task.follow-up',
      actor,
      taskId,
      data: {
        delivery: resumeFrom ? 'resume' : 'respawn',
        resumedFrom: resumeFrom?.id ?? null,
        purpose,
        chars: message.length,
      },
    });
    // The `fyi` backlog is drained by startWorker, which every spawn goes
    // through — see pendingFyiDispatches().
    const ok = await this.startWorker(task, message, resumeFrom, purpose);
    if (!ok) {
      const latest = await this.storage.getTask(taskId);
      return { error: latest?.error ?? 'failed to start worker', code: 500 };
    }
    return { task: (await this.storage.getTask(taskId))! };
  }

  /**
   * "Proceed": reopen the task's previous claude session and carry on — the
   * recovery path for a worker whose terminal died mid-task (usage limit hit,
   * network drop, TTL eviction, server restart). Unlike Run now it never
   * starts a fresh agent: without a resumable session it refuses and says so.
   */
  async proceed(taskId: string, message?: string | null, actor = 'human'): Promise<ActionResult> {
    return this.followUp(taskId, message?.trim() || DEFAULT_PROCEED, actor, 'resume');
  }

  /** Whether "proceed" would find a session to continue (drives the UI button). */
  async resumableSessionId(taskId: string): Promise<string | null> {
    const task = await this.storage.getTask(taskId);
    if (!task?.repoId) return null;
    return (await this.findResumableRun(taskId, task.repoId))?.sessionId ?? null;
  }

  /** Is this run the publish turn? (Drives the Stop hook's landing status.) */
  isPublishRun(runId: string): boolean {
    return this.publishRuns.has(runId);
  }

  /**
   * "Publish": ship the work of a task sitting in `review`.
   *
   * The commit and the push are made BY THE AGENT, in the same session — the
   * same terminal — that did the work: we reopen its claude session
   * (`claude --resume`) and hand it PUBLISH_INSTRUCTION, so the commit message
   * is written by the only party that knows what changed and the git output
   * shows up where the human was already watching. When no session is left to
   * reopen (transcript pruned, or a task from before this flow existed) we fall
   * back to committing and pushing in-process rather than stranding the task.
   *
   * Either way the landing status is decided by `verifyPublished`, never by
   * the agent's own account of what it did.
   */
  async publish(taskId: string, actor = 'human'): Promise<ActionResult> {
    const task = await this.storage.getTask(taskId);
    if (!task) return { error: 'task not found', code: 404 };
    if (!task.repoId) return { error: 'assign a repo before publishing this task', code: 409 };
    const repo = await this.storage.getRepo(task.repoId);
    if (!repo) return { error: 'task has no repo', code: 409 };
    if (task.status !== 'review') {
      return { error: `cannot publish from status '${task.status}' — publish is offered on a task in review`, code: 409 };
    }
    if (actor === LANDING_ACTOR) this.autoPublishing.add(taskId);
    else this.autoPublishing.delete(taskId);
    await this.storage.appendEvent({
      kind: 'task.publish',
      actor,
      taskId,
      repoId: repo.id,
      data: { phase: 'start' },
    });

    // Publish in order (docs/queue.md § Stacked tasks). A refusal is written
    // on the task because auto-publish discards this result.
    const plan = await this.publishPlan(task, repo);
    if (plan.kind === 'refuse') {
      const patched = await this.storage.updateTask(taskId, { error: `publish held: ${plan.reason}` });
      if (patched) broadcast({ type: 'task.updated', task: patched });
      await this.storage.appendEvent({
        kind: 'task.publish',
        actor,
        taskId,
        repoId: repo.id,
        data: { phase: 'refused', reason: plan.reason.slice(0, 300) },
      });
      return { error: plan.reason, code: 409 };
    }
    const resumeFrom = await this.findResumableRun(taskId, task.repoId);
    if (plan.kind === 'partial') {
      // Its commits are already on the remote: nothing to push, git decides.
      if (!plan.upTo) {
        const settled = await this.settlePublish(taskId, ['review'], actor, 'direct');
        if (!settled) return { error: 'task left review while publishing — check its status', code: 409 };
        if (settled.status !== 'published') return { error: settled.error ?? 'publish did not complete', code: 409 };
        return { task: settled };
      }
      if (resumeFrom) {
        return this.followUp(
          taskId,
          publishUpToInstruction({ sha: plan.upTo, remote: plan.remote, mergeRef: plan.mergeRef }),
          actor,
          'resume',
          'publish',
        );
      }
      if (await this.hasLiveSession(taskId)) {
        return { error: 'the agent session is still live — wait for it to finish, then publish', code: 409 };
      }
      const pushed = await pushUpTo(repo, plan.remote, plan.upTo, plan.mergeRef);
      if (!pushed.ok) {
        const patched = await this.storage.updateTask(taskId, { error: `publish failed: ${pushed.error}` });
        if (patched) broadcast({ type: 'task.updated', task: patched });
        return { error: pushed.error, code: pushed.code };
      }
      const settled = await this.settlePublish(taskId, ['review'], actor, 'direct');
      if (!settled) return { error: 'task left review while publishing — check its status', code: 409 };
      if (settled.status !== 'published') return { error: settled.error ?? 'publish did not complete', code: 409 };
      return { task: settled };
    }

    if (resumeFrom) return this.followUp(taskId, PUBLISH_INSTRUCTION, actor, 'resume', 'publish');

    // Fallback path. A session we cannot resume may still be ALIVE (it has no
    // session id yet); running git under a working agent would commit a
    // half-finished tree, so refuse rather than race it.
    if (await this.hasLiveSession(taskId)) {
      return { error: 'the agent session is still live — wait for it to finish, then publish', code: 409 };
    }
    const res = await publishRepo(this.storage, repo, actor);
    if (!res.ok) {
      const patched = await this.storage.updateTask(taskId, { error: `publish failed: ${res.error}` });
      if (patched) broadcast({ type: 'task.updated', task: patched });
      await this.storage.appendEvent({
        kind: 'task.publish',
        actor,
        taskId,
        repoId: repo.id,
        data: { phase: 'failed', delivery: 'direct', error: res.error.slice(0, 300) },
      });
      return { error: res.error, code: res.code };
    }
    const settled = await this.settlePublish(taskId, ['review'], actor, 'direct');
    if (!settled) return { error: 'task left review while publishing — check its status', code: 409 };
    if (settled.status !== 'published') return { error: settled.error ?? 'publish did not complete', code: 409 };
    return { task: settled };
  }

  /**
   * Decide what a publish attempt actually achieved, from git rather than from
   * the agent: everything committed and pushed → `published`; anything left →
   * back to `review` with the reason on the task, so the human sees exactly
   * what is missing instead of a task that claims to be shipped.
   */
  /**
   * Is this task shipped? The whole-tree test (`verifyPublished`) for an
   * ordinary publish; for a STACKED one (docs/queue.md § Stacked tasks, the
   * same plan `publish` used, recomputed from git) only this task's own
   * commits must be on the remote — the later tasks' work above them, and the
   * tree they own, stay local on purpose.
   */
  private async publishedCheck(task: Task, repo: Repo): Promise<PublishCheck> {
    const plan = await this.publishPlan(task, repo);
    if (plan.kind !== 'partial') {
      const full = await verifyPublished(repo);
      // A refusal can only mean something moved underneath the turn; say so
      // rather than report the tree state the plan would have avoided.
      return plan.kind === 'refuse' && !full.ok ? { ...full, reason: plan.reason } : full;
    }
    if (plan.upTo) {
      return { ok: false, reason: `this task's commits up to ${plan.upTo.slice(0, 8)} are not on ${plan.upstream} yet`, branch: null, head: plan.upTo.slice(0, 8) };
    }
    return { ok: true, reason: null, branch: plan.upstream, head: null };
  }

  async settlePublish(
    taskId: string,
    from: TaskStatus[],
    actor: string,
    delivery: 'session' | 'direct' = 'session',
  ): Promise<Task | null> {
    const task = await this.storage.getTask(taskId);
    if (!task) return null;
    const repo = task.repoId ? await this.storage.getRepo(task.repoId) : null;
    const check = repo
      ? await this.publishedCheck(task, repo)
      : { ok: false, reason: 'task has no repo', branch: null, head: null };
    // An auto-publish landing (`landIfClean`) is stamped when it actually lands.
    const auto = this.autoPublishing.delete(taskId);
    const updated = await this.storage.transitionTask(
      taskId,
      from,
      check.ok ? 'published' : 'review',
      actor,
      {
        error: check.ok ? null : `publish did not complete: ${check.reason}`,
        ...(check.ok && auto ? { autoLandedAt: new Date().toISOString() } : {}),
      },
      auto ? { landing: 'auto-publish' } : undefined,
    );
    if (!updated) return null;
    broadcast({ type: 'task.updated', task: updated });
    await this.storage.appendEvent({
      kind: 'task.publish',
      actor,
      taskId,
      repoId: repo?.id ?? null,
      data: {
        phase: check.ok ? 'published' : 'incomplete',
        delivery,
        reason: check.reason,
        branch: check.branch,
        head: check.head,
      },
    });
    if (check.ok) await this.resolveCompletion(updated, actor);
    return updated;
  }

  /**
   * "Apply review fixes" for an OLD task — one that finished before the
   * review-fix loop existed, or was reviewed but never fixed. Respawns a
   * worker (or steers a still-live session) with the review findings; the
   * result is then re-reviewed by the normal loop.
   */
  async applyReviewFixes(taskId: string, actor = 'human'): Promise<ActionResult> {
    const task = await this.storage.getTask(taskId);
    if (!task) return { error: 'task not found', code: 404 };
    if (!task.repoId) return { error: 'assign a repo first', code: 409 };
    this.fixRounds.delete(taskId); // fresh loop budget for this attempt
    const message = task.reviewSummary
      ? [
          `A prior adversarial review of your change to this task found the issues below. Apply the fixes`,
          `for the blocker/major items (and quick minors), verify, then finish. Your fix will be re-reviewed.`,
          ``,
          task.reviewSummary,
        ].join('\n')
      : [
          `Re-examine your previous change for this task adversarially — hunt correctness bugs, regressions,`,
          `missed edge cases, and anything that doesn't fully satisfy the task — then fix what you find and`,
          `finish. Your change will be adversarially reviewed afterward.`,
        ].join('\n');
    const res = await this.followUp(taskId, message, actor);
    if (!('error' in res)) await this.setReviewState(taskId, 'fixing');
    return res;
  }

  async runNow(taskId: string, actor = 'human'): Promise<ActionResult> {
    const cur = await this.storage.getTask(taskId);
    if (!cur) return { error: 'task not found', code: 404 };
    if (!cur.repoId) return { error: 'assign a repo before running this task', code: 409 };
    // Never spawn a second agent into a repo whose previous session is still
    // alive — normal after Phase 4, where Stop → review keeps the PTY open (F3).
    if (await this.hasLiveSession(taskId)) {
      return { error: 'previous session is still live — open its terminal or kill it first', code: 409 };
    }
    const task = await this.storage.transitionTask(
      taskId,
      ['draft', 'queued', 'review', 'failed', 'cancelled'],
      'running',
      actor,
      { error: null },
    );
    if (!task) return { error: `cannot run from status '${cur.status}'`, code: 409 };
    // The error this clears is what the fresh prompt's `Previous attempt`
    // block reports (retryContext) — kept here, since the row loses it.
    if (cur.error || cur.status === 'failed' || cur.status === 'cancelled') {
      await this.storage.appendEvent({
        kind: 'task.retry',
        actor,
        taskId,
        repoId: cur.repoId,
        data: { via: 'run-now', from: cur.status, previousError: cur.error },
      });
    }
    broadcast({ type: 'task.updated', task });
    const ok = await this.startWorker(task);
    if (!ok) {
      const latest = await this.storage.getTask(taskId);
      return { error: latest?.error ?? 'failed to start worker', code: 500 };
    }
    return { task: (await this.storage.getTask(taskId))! };
  }

  async cancel(taskId: string, actor = 'human'): Promise<ActionResult> {
    // A resume gate compacting this task's session has no run row yet (the row
    // is created after it returns), so killing runs would miss it entirely and
    // it would keep paying for a summary of work nobody wants. startWorker
    // re-checks the status afterwards either way — this is about the money and
    // the minutes, not the correctness.
    abortCompaction(taskId);
    this.dropTransient(taskId); // a pending transient-error resume must not outlive the cancel
    const runs = await this.storage.listRuns({ taskId, status: 'running' });
    for (const run of runs) {
      this.sessions.kill(run.id);
      await this.storage.updateRun(run.id, { status: 'killed', endedAt: new Date().toISOString() });
      await this.storage.appendEvent({ kind: 'run.killed', actor, runId: run.id, taskId });
    }
    const task = await this.storage.transitionTask(taskId, ['running', 'waiting', 'queued'], 'cancelled', actor);
    if (!task) return { error: 'task is not running or queued', code: 409 };
    broadcast({ type: 'task.updated', task });
    // cancelled counts as resolved for split parents (review F2).
    //
    // No actor, so the cascade stays 'system': the caller cancelled THIS task;
    // the parent's unblock and the feature's next phase are consequences the
    // orchestrator draws on its own. `task-actions.ts` de-queues a `queued`
    // task without going through here and already omits the actor for exactly
    // this reason — forwarding it here made one command (`/cancel`, or the
    // web's Cancel) attribute the same automatic follow-on two different ways
    // depending on whether the task happened to be running.
    await this.resolveCompletion(task);
    this.maybeSchedule();
    return { task };
  }

  /**
   * "Undo start" (docs/queue.md § Undo start): stop a running turn WITHOUT
   * cancelling or failing the task — kill its session exactly as `cancel()`
   * does, then put the task back in the status it had before the turn started
   * (`statusBeforeStart`). Back in `queued` it keeps its place (sort key and
   * custom-queue mark are untouched) but is HELD: every claim skips a row with
   * `queue_held_at` set, or the queue would start it again on the very next
   * pass. The working tree is left as the killed turn left it — nothing is
   * reverted — and the next start is a fresh session.
   */
  async undoStart(taskId: string, actor = 'human'): Promise<ActionResult> {
    const cur = await this.storage.getTask(taskId);
    if (!cur) return { error: 'task not found', code: 404 };
    if (cur.status !== 'running' && cur.status !== 'waiting') {
      return { error: 'task is not running', code: 409 };
    }
    const to = await this.statusBeforeStart(taskId);
    abortCompaction(taskId); // same reason as cancel(): a gate has no run row yet
    this.dropTransient(taskId);
    const runs = await this.storage.listRuns({ taskId, status: 'running' });
    for (const run of runs) {
      // Marked `killed` right behind the kill, so handleExit's stale-exit guard
      // leaves the task to the transition below instead of failing it.
      this.sessions.kill(run.id);
      await this.storage.updateRun(run.id, { status: 'killed', endedAt: new Date().toISOString() });
      await this.storage.appendEvent({ kind: 'run.killed', actor, runId: run.id, taskId });
    }
    const task = await this.storage.transitionTask(taskId, ['running', 'waiting'], to, actor, {
      error: null,
      // `fixing` described the turn that just died; any other verdict belongs
      // to the status we are returning to and stays.
      ...(cur.reviewState === 'fixing' ? { reviewState: null } : {}),
      queueHeldAt: to === 'queued' ? new Date().toISOString() : null,
    });
    if (!task) {
      const now = await this.storage.getTask(taskId);
      return { error: `task is no longer running (now '${now?.status ?? 'deleted'}')`, code: 409 };
    }
    this.fixRounds.delete(taskId);
    this.checkLoops.delete(taskId);
    await this.storage.appendEvent({
      kind: 'task.undo',
      actor,
      taskId,
      repoId: task.repoId,
      data: { action: 'undo', from: cur.status, to, held: to === 'queued', killedRuns: runs.map((r) => r.id) },
    });
    broadcast({ type: 'task.updated', task });
    // No resolveCompletion: the task goes back to where it already was — a
    // parent or feature phase saw that status before this turn and nothing
    // about it is newly settled. The queue may move on to the next item.
    this.maybeSchedule();
    return { task };
  }

  /**
   * The status a task had before its current turn began: the `from` of its
   * newest transition INTO `running` that did not come from `running`/`waiting`
   * (a wait ending, or a follow-up into a live turn, is the same turn). The
   * claim composites write that row too. A terminal status is fine to return
   * to — a follow-up on a done task undoes back to done — but never `running`
   * or `waiting`; with no usable row the task goes back to the queue, held.
   */
  private async statusBeforeStart(taskId: string): Promise<TaskStatus> {
    const rows = await this.storage.listEvents({ taskId, kind: 'task.transition', limit: 500 });
    for (const e of rows) {
      const from = e.data?.from as TaskStatus | null | undefined;
      if (e.data?.to !== 'running' || !from) continue;
      if (from === 'running' || from === 'waiting') continue;
      return from;
    }
    return 'queued';
  }

  /** Completing a task closes its terminals — idle sessions must not pile up
   *  waiting for TTL eviction (user request 2026-08-24). */
  async closeTaskSessions(taskId: string, actor = 'human'): Promise<number> {
    const runs = await this.storage.listRuns({ taskId });
    let closed = 0;
    for (const run of runs) {
      const s = this.sessions.get(run.id);
      if (s && s.exit === null) {
        if (await this.killRun(run.id, actor)) closed++;
      }
    }
    return closed;
  }

  async killRun(runId: string, actor = 'human'): Promise<boolean> {
    // An aux session (review, plan, chat, …) lives in the aux pool and is
    // settled by its runner: stopping it resolves the caller's pending result
    // as `aborted`, and the runner closes the row as `killed` itself. Its
    // `taskId` is always null, so no task is ever cancelled from here.
    if (aux().isLive(runId)) {
      const killed = aux().abort(runId);
      if (killed) {
        await this.storage.appendEvent({ kind: 'run.killed', actor, runId });
        // So the caller (the kill route) answers with the closed row. Bounded
        // by the runner's own exit wait, which never hangs.
        await aux().whenDone(runId);
      }
      return killed;
    }
    const killed = this.sessions.kill(runId);
    if (killed) {
      const run = await this.storage.updateRun(runId, { status: 'killed', endedAt: new Date().toISOString() });
      await this.storage.appendEvent({ kind: 'run.killed', actor, runId, taskId: run?.taskId ?? null });
      if (run?.taskId) {
        const task = await this.storage.transitionTask(run.taskId, ['running', 'waiting'], 'cancelled', actor);
        if (task) {
          broadcast({ type: 'task.updated', task });
          await this.resolveCompletion(task); // 'system', same rule as cancel()
        }
      }
    }
    return killed;
  }

  /** PTY exited. Hook-driven completion (Phase 4) usually resolved the task already.
   *  `tail` is the terminal's last bytes, captured by the caller at exit — the
   *  only surface a usage-limit banner ever reaches (docs/wake.md). */
  // ---- transient API errors (docs/design.md § Transient API errors) ----

  /**
   * A worker turn the API ended (the CLI's StopFailure hook, which fires
   * INSTEAD of Stop). Classified by the CLI's own `error` code, never text:
   * `overloaded`/`server_error` are resumed in the SAME session after a
   * back-off (30 s, then 2 min; two per turn), `rate_limit` is left to the
   * wake path (claude/limit.ts), and anything else — or a third transient in
   * one turn — fails the turn with the reason. This is the same agent carrying
   * on, never a fresh one on a half-edited tree, which is why it does not
   * reopen the 2026-08-24 "no auto-retry" decision.
   */
  async onStopFailure(runId: string, body: unknown): Promise<void> {
    const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const code = typeof b.error === 'string' && b.error ? b.error : 'unknown';
    const details =
      typeof b.error_details === 'string' && b.error_details.trim() ? b.error_details.trim().slice(0, 300) : null;
    const run = await this.storage.getRun(runId);
    if (!run?.taskId || run.mode !== 'worker' || run.status !== 'running') return;
    // The Stop route's stale-hook guards: a human chatting in an old idle
    // session, or a newer run already working on the task.
    if (this.sessions.isIdle(runId)) return;
    const latest = (await this.storage.listRuns({ taskId: run.taskId }))[0];
    if (latest && latest.id !== runId) return;
    const task = await this.storage.getTask(run.taskId);
    if (!task || (task.status !== 'running' && task.status !== 'waiting')) return;

    const cls = classifyStopFailure(code);
    const prev = this.transientRetries.get(task.id);
    const used = prev?.attempts ?? 0;
    const action =
      cls === 'usage-limit'
        ? 'left-to-wake'
        : cls === 'fatal'
          ? 'failed'
          : used >= TRANSIENT_BACKOFF_MS.length
            ? 'exhausted'
            : 'resume';
    await this.storage.appendEvent({
      kind: 'run.stop-failure',
      actor: 'hook',
      runId,
      taskId: task.id,
      repoId: task.repoId,
      data: { code, details, action, resumesUsed: used },
    });
    if (action === 'left-to-wake') return;
    if (action === 'failed' || action === 'exhausted') {
      await this.failTurn(task.id, runId, stopFailureError(code, details, action === 'exhausted' ? 'exhausted' : 'fatal', used));
      return;
    }
    if (prev?.timer) clearTimeout(prev.timer);
    const entry: TransientRetry = { runId, attempts: used + 1, code, timer: null };
    this.transientRetries.set(task.id, entry);
    this.armTransient(task.id, entry, TRANSIENT_BACKOFF_MS[used]);
  }

  /** Forgets a task's transient-resume state: the turn ended for real, or something else took the task. */
  dropTransient(taskId: string): void {
    const e = this.transientRetries.get(taskId);
    if (e?.timer) clearTimeout(e.timer);
    this.transientRetries.delete(taskId);
  }

  /** True while this run's turn waits out a transient-error back-off (its idle-prompt notification is noise). */
  transientBackingOff(runId: string): boolean {
    for (const e of this.transientRetries.values()) if (e.runId === runId && e.timer) return true;
    return false;
  }

  private armTransient(taskId: string, entry: TransientRetry, delayMs: number): void {
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.fireTransient(taskId, entry).catch((e) => console.error('transient resume failed:', e));
    }, delayMs);
    entry.timer.unref();
  }

  private auditTransient(taskId: string, entry: TransientRetry, data: Record<string, unknown>): Promise<unknown> {
    return this.storage.appendEvent({
      kind: 'run.transient-retry',
      actor: 'system',
      runId: entry.runId,
      taskId,
      data: { attempt: entry.attempts, code: entry.code, ...data },
    });
  }

  /** The back-off ran out: resume the turn, unless the world moved on meanwhile. */
  private async fireTransient(taskId: string, entry: TransientRetry): Promise<void> {
    if (this.transientRetries.get(taskId) !== entry) return;
    const giveUp = async (reason: string) => {
      this.dropTransient(taskId);
      await this.auditTransient(taskId, entry, { action: 'skipped', reason });
    };
    const task = await this.storage.getTask(taskId);
    const run = await this.storage.getRun(entry.runId);
    if (!task || !run) return giveUp('task or run is gone');
    // Proceed spawned a newer run, or Cancel / Kill / Undo marked this one
    // `killed`: whoever did that already decided what the task becomes.
    const latest = (await this.storage.listRuns({ taskId }))[0];
    if (latest?.id !== run.id || run.status === 'killed') return giveUp('superseded');
    const s = this.sessions.get(run.id);
    const live = s !== undefined && s.exit === null;
    const inTurn = task.status === 'running' || task.status === 'waiting';
    // A terminal that died during the back-off was landed by handleExit
    // (`review` on a clean exit, `failed` otherwise); that landing is where
    // `--resume` picks the turn up again.
    const gone = !live && (task.status === 'review' || task.status === 'failed');
    if (!(live && inTurn) && !gone) {
      return giveUp(`task is '${task.status}'${live ? ' and its session is not in a turn' : ''}`);
    }
    const settings = await this.storage.getSettings();
    const verdict = await this.budgetAllows(task, 'transient-resume', settings);
    if (!verdict.ok) {
      this.dropTransient(taskId);
      await this.auditTransient(taskId, entry, { action: 'refused', reason: 'budget' });
      // The terminal sits at its prompt: mark it idle, which is what lets
      // Proceed retire it later (followUp refuses a session mid-turn).
      if (live) await this.idleSession(run.id);
      await this.refuseOverBudget(taskId, 'transient-resume', verdict);
      return;
    }
    if (live) {
      // The cheap resume: same process, same cache, no re-read of the
      // conversation. Checked afterwards, because text typed into a prompt is
      // the one delivery that has failed silently before (decisions.md
      // 2026-08-24, follow-up injection).
      const before = fileSize(run.transcriptPath);
      this.sessions.input(run.id, Buffer.from(TRANSIENT_CONTINUE));
      setTimeout(() => this.sessions.input(run.id, Buffer.from('\r')), TYPE_ENTER_DELAY_MS).unref();
      await this.auditTransient(taskId, entry, { action: 'resumed', delivery: 'typed' });
      setTimeout(() => {
        this.checkTypedResume(taskId, entry, before).catch((e) => console.error('transient resume check failed:', e));
      }, TRANSIENT_SUBMIT_CHECK_MS).unref();
      return;
    }
    // Under the concurrency cap like the wake path: the slot this turn held
    // went free when its terminal died, and may have been claimed since.
    if (this.activeWorkers() >= settings['orchestrator.concurrency']) {
      this.armTransient(taskId, entry, 30_000);
      return;
    }
    await this.resumeTransient(taskId, entry, 'session-gone');
  }

  /** `continue` was typed: if the transcript did not move, it never submitted — resume instead. */
  private async checkTypedResume(taskId: string, entry: TransientRetry, before: number | null): Promise<void> {
    // A new StopFailure (a new entry), a Stop (dropped) or a human now owns it.
    if (this.transientRetries.get(taskId) !== entry || entry.timer) return;
    if (before === null) return; // nothing to measure against: trust the keystrokes
    const run = await this.storage.getRun(entry.runId);
    const s = this.sessions.get(entry.runId);
    if (!run || run.status !== 'running' || !s || s.exit !== null || this.sessions.isIdle(entry.runId)) return;
    const after = fileSize(run.transcriptPath);
    if (after !== null && after > before) return; // the turn took
    const task = await this.storage.getTask(taskId);
    if (!task || (task.status !== 'running' && task.status !== 'waiting')) return;
    await this.resumeTransient(taskId, entry, 'typed-not-submitted');
  }

  /** The `--resume` delivery: the same claude session in a new process, via followUp. */
  private async resumeTransient(taskId: string, entry: TransientRetry, why: string): Promise<void> {
    // A publish turn stays one: git, not the exit, decides how it lands.
    const purpose = this.publishRuns.has(entry.runId) ? 'publish' : 'work';
    const s = this.sessions.get(entry.runId);
    if (s && s.exit === null) {
      // Retire the live terminal the way every deliberate kill does: `killed`
      // FIRST, so its exit never lands the task, then idle, which is what
      // followUp needs to replace it rather than refuse.
      await this.storage.updateRun(entry.runId, { status: 'killed', endedAt: new Date().toISOString() });
      await this.idleSession(entry.runId);
    }
    this.transientResuming.add(taskId);
    let res: ActionResult;
    try {
      res = await this.followUp(taskId, TRANSIENT_CONTINUE, 'system', 'resume', purpose);
    } finally {
      this.transientResuming.delete(taskId);
    }
    if ('error' in res) {
      await this.auditTransient(taskId, entry, { action: 'failed', delivery: 'resume', why, error: res.error });
      // Nothing resumable (no transcript on disk, a `waiting` row followUp
      // does not take): end the turn with the reason rather than leave a
      // `running` row over a session we already retired.
      await this.failTurn(
        taskId,
        entry.runId,
        `API error (${entry.code}) — the automatic resume could not start: ${res.error}`,
      );
      return;
    }
    await this.auditTransient(taskId, entry, { action: 'resumed', delivery: 'resume', why });
  }

  /**
   * Ends a turn the API stopped and nothing will resume: the reason on the
   * row, the task `failed` (Proceed resumes the session, Retry starts fresh
   * with what it left — both accept `failed`), the terminal ended so Retry is
   * not refused for a live session. Task first, PTY second: handleExit then
   * finds nothing in `running` to land and just records the exit.
   */
  private async failTurn(taskId: string, runId: string, error: string): Promise<void> {
    this.dropTransient(taskId);
    if (this.publishRuns.has(runId)) {
      // a publish turn is settled by git when its terminal ends (handleExit → settlePublish)
      this.sessions.kill(runId);
      return;
    }
    const failed = await this.storage.transitionTask(taskId, ['running', 'waiting'], 'failed', 'system', {
      error,
      reviewState: null,
    });
    this.sessions.kill(runId);
    if (failed) {
      broadcast({ type: 'task.updated', task: failed });
      await this.resolveCompletion(failed, 'system');
    }
  }

  /** Marks a live session idle (the Stop route's bookkeeping): it frees the slot and lets followUp retire it. */
  private async idleSession(runId: string): Promise<void> {
    this.sessions.markIdle(runId);
    const idled = await this.storage.updateRun(runId, { idle: true });
    if (idled) broadcast({ type: 'run.exited', run: idled });
  }

  private async handleExit(runId: string, exitCode: number, tail = ''): Promise<void> {
    // Consumed here whatever happens next: this run is over either way.
    const wasPublish = this.publishRuns.delete(runId);
    this.stallSkipsAudited.delete(runId);
    this.forgetAttention(runId);
    this.childrenInFlight.delete(runId);
    this.dropWait(runId);
    this.shellsSeen.delete(runId);
    // Nothing will collect an answer for this run any more — stop asking the
    // human (docs/questions.md). Before the row is touched, so a consumer that
    // reacts to `run.exited` never sees a live question under a dead run.
    await this.questions.expireForRun(runId, 'the agent session ended').catch((e) => {
      console.warn('questions: expire on exit failed:', e instanceof Error ? e.message : e);
    });
    const run = await this.storage.getRun(runId);
    if (!run) return;
    if (run.status === 'running') {
      await this.storage.updateRun(runId, {
        status: 'exited',
        exitCode,
        needsAttention: false,
        endedAt: new Date().toISOString(),
      });
    }
    // Final stats/summary snapshot — backstop for anything the Stop-hook parse
    // missed (transcript flush lag).
    const forStats = await this.storage.getRun(runId);
    if (forStats?.transcriptPath) {
      const summary = await summarizeRun(forStats);
      if (summary) {
        await this.storage.updateRun(runId, { stats: summary.stats });
        await broadcastTaskCost(this.storage, forStats);
        if (forStats.taskId && summary.lastAssistantText) {
          const t = await this.storage.getTask(forStats.taskId);
          if (t && !t.resultSummary && ['review', 'published', 'done'].includes(t.status)) {
            const patched = await this.storage.updateTask(t.id, {
              resultSummary: summary.lastAssistantText.slice(0, 4000),
            });
            if (patched) broadcast({ type: 'task.updated', task: patched });
          }
        }
      }
    }
    const updated = await this.storage.getRun(runId);
    if (updated) {
      // stats-final at exit (idle-time already excluded when the idle-path
      // event fired first; appendEvent here is a backstop for non-idle exits)
      const already = await this.storage.listEvents({ kind: 'run.stats-final', limit: 5, taskId: updated.taskId ?? undefined });
      if (!already.some((e) => e.runId === runId)) {
        await this.storage.appendEvent({
          kind: 'run.stats-final',
          actor: 'system',
          runId,
          taskId: updated.taskId,
          repoId: updated.repoId,
          data: {
            workedMs: Date.parse(updated.endedAt ?? new Date().toISOString()) - Date.parse(updated.startedAt),
            costUsd: updated.stats?.costUsd ?? 0,
            tokens: (updated.stats?.inputTokens ?? 0) + (updated.stats?.outputTokens ?? 0),
            contextPct: updated.stats?.contextPct ?? 0,
            model: updated.model,
            mode: updated.mode,
            exitCode,
          },
        });
      }
      broadcast({ type: 'run.exited', run: updated });
    }

    if (run.taskId && run.mode === 'worker') {
      // Stale-exit guard (twin of the Stop-hook guard): a follow-up/proceed
      // kills the previous session and immediately spawns a newer run for the
      // same task. That old PTY's death must never flip the task the NEWER run
      // is working on (it would read as "failed" mid-work). A run explicitly
      // marked `killed` is covered by the same rule even before its successor
      // exists: whoever killed it (cancel, killRun, follow-up, proceed) already
      // decided what the task should become.
      const fresh = await this.storage.getRun(runId);
      const latest = (await this.storage.listRuns({ taskId: run.taskId }))[0];
      if (fresh?.status === 'killed' || (latest && latest.id !== runId)) {
        broadcast({ type: 'orchestrator.status', status: await this.status() });
        this.maybeSchedule();
        return;
      }
      // A loop iteration whose session the loop itself closed at its Stop
      // (docs/loops.md): the task is between iterations, not finished.
      const owner = await this.storage.getTask(run.taskId);
      if (owner?.kind === 'loop' && owner.status === 'running' && (owner.loopState === 'checking' || owner.loopState === 'next')) {
        broadcast({ type: 'orchestrator.status', status: await this.status() });
        this.maybeSchedule();
        return;
      }
      // A publish turn that died is settled by git, not by its exit code: it
      // may well have pushed before the terminal went away. `published` when
      // it did, `review` (with the reason) when it did not — never `failed`,
      // which would bury work that is already merged-in-progress.
      if (wasPublish) {
        await this.settlePublish(run.taskId, ['running'], 'system');
        broadcast({ type: 'orchestrator.status', status: await this.status() });
        this.maybeSchedule();
        return;
      }
      // Exit before any Stop hook: nonzero → failed; zero → review (someone
      // ended the session deliberately; a human should look).
      // `waiting` too: the session that was going to be re-invoked is gone.
      const to = exitCode === 0 ? 'review' : 'failed';
      const task = await this.storage.transitionTask(run.taskId, ['running', 'waiting'], to, 'system', {
        error: exitCode === 0 ? null : `worker exited with code ${exitCode} before finishing`,
        // no Stop, so no reviewer runs for this landing — and a fix round that
        // died mid-turn is not "fixing" any more either
        reviewState: null,
      });
      if (task) {
        broadcast({ type: 'task.updated', task });
        // A turn the account cut short is parked for the window's reset rather
        // than left for a human to notice (docs/wake.md). Read from the tail
        // captured at exit: by now the session may already have been disposed.
        const settings = await this.storage.getSettings();
        if (settings['agent.autoWake']) {
          const verdict = assessLimitStall(tail, this.accountWindow());
          if (verdict.stalled) await this.parkForUsageLimit(task, verdict, settings);
          else await this.auditStallSkip(task, verdict);
        }
        await this.resolveCompletion(task, 'system');
      }
    }
    broadcast({ type: 'orchestrator.status', status: await this.status() });
    this.maybeSchedule();
  }

  /**
   * Adversarial review of a completed worker's change (Fable → Opus xhigh
   * fallback). Runs async off the Stop-hook path; attaches findings to the
   * task and broadcasts. Never throws into the caller.
   *
   * REVIEWS EACH DIFF ONCE. The reviewer reads `git diff HEAD`, which carries
   * every uncommitted change in the repo — so a Stop that changed no code (a
   * dispatch reply, an answered question, a follow-up turn that only talked)
   * still saw a non-empty diff and paid for a full review session that re-read
   * the previous turn's work. The diff is now hashed and the hash stored on
   * the task: an unchanged hash means there is nothing new to judge, so the
   * previous verdict stands, the task simply stays in `review`, and no
   * `claude -p` is spawned. Both skips are recorded as `run.reviewed` rows
   * carrying `skipped`, so the audit trail shows a decision, not a gap.
   */
  async reviewCompletedRun(taskId: string, forced = false): Promise<void> {
    // SINGLE-FLIGHT PER TASK. Two Stops for one task can overlap (see
    // `reviewRecheck`), and the second must not start its own reviewer while
    // the first is still deciding what the hash should be. The overlapping
    // caller is handed the IN-FLIGHT promise rather than a resolved one: the
    // stop-hook route releases its custom-queue hold in a `.finally` on what
    // this returns (docs/queue.md), and that hold has to outlive the round
    // that is actually running, not the call that merely joined it.
    const inFlight = this.pendingReviews.get(taskId);
    if (inFlight) {
      this.reviewRecheck.add(taskId);
      return inFlight;
    }
    // Registered synchronously on call (the hook route fires this void,
    // milliseconds after the running → review transition), cleared however the
    // round ends. What other surfaces read is the persisted `reviewState`.
    const p = this.reviewLoop(taskId, forced).finally(() => this.pendingReviews.delete(taskId));
    this.pendingReviews.set(taskId, p);
    return p;
  }

  /**
   * "Review now" (POST /api/tasks/:id/review, Telegram /review): run the
   * adversarial reviewer on demand over the task's CURRENT diff. The same
   * round as the automatic one — same lock, state steps, round history and
   * `run.reviewed` rows — with three differences: the unchanged-diff gate is
   * bypassed (the human asked for a fresh verdict; done by clearing
   * `review_diff_hash` in the same write that marks `pending`, so a restart
   * mid-round re-runs it for real too), `review.enabled` is not consulted,
   * and `blocked`/`failed` are accepted. Findings go back to the worker only
   * where the automatic round would send them — `review` with a live
   * session, under a fresh `review.maxRounds` budget; anywhere else the
   * verdict is recorded and the status is left alone.
   */
  async reviewNow(taskId: string, actor = 'human'): Promise<ActionResult> {
    const task = await this.storage.getTask(taskId);
    if (!task) return { error: 'task not found', code: 404 };
    if (!task.repoId) return { error: 'assign a repo first — there is nothing to diff', code: 409 };
    if (!REVIEW_NOW_FROM.includes(task.status)) {
      return {
        error: `cannot review a task in '${task.status}' — only ${REVIEW_NOW_FROM.join('/')} tasks have a change to judge`,
        code: 409,
      };
    }
    if (!(await this.storage.getRepo(task.repoId))) return { error: 'repo not found', code: 409 };
    // Synchronous from the lock check to its registration: two presses cannot
    // both get past here.
    if (this.pendingReviews.has(taskId)) return { error: 'review already in progress', code: 409 };
    this.fixRounds.delete(taskId); // a requested round starts a fresh fix-loop budget
    this.requestedReviews.set(taskId, actor);
    const marked = this.storage.updateTask(taskId, { reviewState: 'pending', reviewDiffHash: null });
    const p = marked
      .then(async (row) => {
        if (!row) return;
        broadcast({ type: 'task.updated', task: row });
        await this.storage.appendEvent({
          kind: 'task.review-requested',
          actor,
          taskId,
          repoId: row.repoId,
          data: { status: row.status, previousState: task.reviewState, previousHash: task.reviewDiffHash },
        });
        await this.reviewLoop(taskId, true);
      })
      .catch((err) => console.error('requested review failed:', err))
      .finally(() => {
        this.pendingReviews.delete(taskId);
        this.requestedReviews.delete(taskId);
      });
    this.pendingReviews.set(taskId, p);
    const updated = await marked;
    if (!updated) return { error: 'task not found', code: 404 };
    return { task: updated };
  }

  /** Is a "Review now" round for this task in flight right now? */
  isRequestedReview(taskId: string): boolean {
    return this.requestedReviews.has(taskId);
  }

  /**
   * One review round, plus one more pass for a Stop that landed while it ran.
   * Never throws: it runs off the Stop-hook path with nobody to catch it.
   */
  private async reviewLoop(taskId: string, forced = false): Promise<void> {
    try {
      for (let pass = 0; ; pass++) {
        this.reviewRecheck.delete(taskId);
        // Checks come first (docs/checks.md): cheap and deterministic, so a
        // reviewer never spends a session on a change that does not build.
        // False = no review this pass (a fix turn was sent, or red landed).
        const review = await this.runCheckStage(taskId);
        // only the first pass is the forced one; a recheck is a Stop's pass
        if (review) await this.runReviewRound(taskId, forced && pass === 0);
        if (!this.reviewRecheck.has(taskId)) {
          // The verify round has settled (or handed a fix turn back, which
          // the gate reads as not-in-review): the tier decides the rest.
          await this.landIfClean(taskId);
          return;
        }
        // Another pass is only worth it while the task is still parked in
        // review. If the round just started a fix round the task is `running`
        // again and its own Stop will come back through here — reviewing a
        // turn that is still mid-flight would read a half-written diff.
        const t = await this.storage.getTask(taskId);
        if (t?.status !== 'review') return;
      }
    } catch (err) {
      console.error('adversarial review failed:', err);
      // A throw mid-round (storage, git) would otherwise strand the row on
      // pending/reviewing until the next boot — a badge that says "reviewing"
      // forever and a disabled "Review now" button. Nothing was judged.
      try {
        const t = await this.storage.getTask(taskId);
        if (t?.reviewState === 'pending' || t?.reviewState === 'reviewing') await this.setReviewState(taskId, 'error');
        if (t?.checkState && CHECK_BUSY_STATES.includes(t.checkState)) await this.setCheckState(taskId, 'error');
      } catch {
        // boot recovery is the last resort
      }
    } finally {
      this.reviewRecheck.delete(taskId);
    }
  }

  /**
   * Landing tiers (docs/design.md § Landing tiers): the end of every settled
   * verify round. A task still in `review` whose effective tier is above
   * `supervised` and whose row passes `landingReason` (checks green or none,
   * verdict without blocker/major) lands on its own, audited with the reason
   * on the `task.transition` row:
   * - `on-green` → `done` (local commits only), stamped `autoLandedAt`, its
   *   terminals closed like a human Mark done, and the split parent / feature
   *   phase re-evaluated — which is what lets phases flow without a click.
   * - `auto-publish` → the publish turn (`publish(…, LANDING_ACTOR)`), gated
   *   by `budgetAllows(…, 'auto-publish')`; `settlePublish` stamps the stamp
   *   and git decides `published` exactly as for a human click.
   * Anything else — supervised, an external task (clamped by
   * `effectiveLanding`), red/error checks, a flagged or failed verdict, a fix
   * turn under way — stays where it is, which is today's `review`.
   */
  private async landIfClean(taskId: string): Promise<void> {
    const task = await this.storage.getTask(taskId);
    if (!task || task.status !== 'review' || !task.repoId) return;
    const repo = await this.storage.getRepo(task.repoId);
    if (!repo) return;
    const tier: LandingTier = effectiveLanding(task, repo);
    if (tier === 'supervised') return;
    const reason = landingReason(task);
    if (!reason) return;
    if (tier === 'on-green') {
      const done = await this.storage.transitionTask(
        taskId,
        ['review'],
        'done',
        LANDING_ACTOR,
        { autoLandedAt: new Date().toISOString() },
        { landing: tier, reason },
      );
      if (!done) return; // a human or a newer turn took it in between
      broadcast({ type: 'task.updated', task: done });
      await this.closeTaskSessions(taskId, LANDING_ACTOR);
      await this.resolveCompletion(done, LANDING_ACTOR);
      return;
    }
    const verdict = await this.budgetAllows(task, 'auto-publish');
    if (!verdict.ok) {
      await this.refuseOverBudget(taskId, 'auto-publish', verdict);
      return;
    }
    await this.storage.appendEvent({
      kind: 'task.landing',
      actor: LANDING_ACTOR,
      taskId,
      repoId: repo.id,
      data: { landing: tier, reason, phase: 'publish' },
    });
    const res = await this.publish(taskId, LANDING_ACTOR);
    if ('error' in res) {
      this.autoPublishing.delete(taskId);
      // A refusal already wrote its reason on the row; anything else would be
      // a silent stop, and the auto-publish chip promised a push.
      const cur = await this.storage.getTask(taskId);
      if (cur?.status === 'review' && !cur.error) {
        const patched = await this.storage.updateTask(taskId, { error: `auto-publish did not start: ${res.error}` });
        if (patched) broadcast({ type: 'task.updated', task: patched });
      }
      await this.storage.appendEvent({
        kind: 'task.landing',
        actor: LANDING_ACTOR,
        taskId,
        repoId: repo.id,
        data: { landing: tier, phase: 'refused', error: res.error.slice(0, 300) },
      });
    }
  }

  /**
   * One pass of the gate: decide from the diff hash, then review or skip.
   * `forced` = a review was explicitly decided (a "Review now" request, or a
   * pending/reviewing row boot recovery found): `review.enabled` is not
   * re-checked and REVIEW_NOW_FROM is the accepted status set.
   */
  private async runReviewRound(taskId: string, forced = false): Promise<void> {
    const task = await this.storage.getTask(taskId);
    if (!task || !task.repoId) return;
    // Only a task that is parked (review, or done — a human's Mark done
    // racing the round) has a change to judge; anything else means a human or a newer turn took over
    // between the Stop and this pass. A requested round also accepts
    // blocked/failed. A pending/reviewing mark left on a status this pass
    // will not review is released back to the last verdict, or it would read
    // "auto-review" (and disable Review now) until the next boot.
    const from: TaskStatus[] = forced ? REVIEW_NOW_FROM : ['review', 'done'];
    if (!from.includes(task.status)) {
      if (task.reviewState === 'pending' || task.reviewState === 'reviewing') {
        await this.setReviewState(taskId, task.reviewRounds.length ? settledReviewState(task.reviewRounds) : null);
      }
      return;
    }
    const requestedBy = forced ? (this.requestedReviews.get(taskId) ?? null) : null;
    const settings = await this.storage.getSettings();
    // per-task override wins; null falls back to the global setting
    if (!forced && !(task.review ?? settings['review.enabled'])) {
      if (task.reviewState === 'pending') await this.setReviewState(taskId, null);
      return;
    }
    const repo = await this.storage.getRepo(task.repoId);
    if (!repo) {
      // repo row deleted under a parked task: nothing can be diffed
      if (task.reviewState === 'pending') {
        await this.setReviewState(taskId, task.reviewRounds.length ? settledReviewState(task.reviewRounds) : null);
      }
      return;
    }
    await this.setReviewState(taskId, 'reviewing');

    // One git read per round, hashed before truncation; the reviewer reuses
    // it. The change is the TASK's — its commits plus the uncommitted rest —
    // not merely the working tree (docs/design.md § Adversarial review).
    const scoped = await this.ensureBase(task, repo, false);
    const change = await workerDiff(repo, await this.changeScope(scoped, repo));
    const { hash } = change;
    if (!hash) {
      // This task changed nothing: no commits of its own, a clean tree.
      await this.storage.appendEvent({
        kind: 'run.reviewed',
        actor: 'system',
        taskId,
        repoId: repo.id,
        data: {
          skipped: 'empty-diff',
          state: 'skipped',
          base: scoped.baseSha,
          ...(requestedBy ? { requestedBy } : {}),
        },
      });
      this.fixRounds.delete(taskId);
      await this.setReviewState(taskId, 'skipped');
      return;
    }
    if (hash === task.reviewDiffHash) {
      // Nothing changed since the last review: its verdict still holds and
      // the task is already in `review`. Skip the spawn, settle the loop on
      // the verdict that round produced.
      const state = settledReviewState(task.reviewRounds);
      await this.storage.appendEvent({
        kind: 'run.reviewed',
        actor: 'system',
        taskId,
        repoId: repo.id,
        data: { skipped: 'unchanged-diff', state, ...(requestedBy ? { requestedBy } : {}) },
      });
      this.fixRounds.delete(taskId);
      await this.setReviewState(taskId, state);
      return;
    }

    const fixRound = this.fixRounds.get(taskId) ?? 0;
    const lastRound = task.reviewRounds[task.reviewRounds.length - 1] ?? null;
    const result = await reviewWorkerChange(
      repo,
      task,
      // per-task reviewer wins; null falls back to the global setting
      { model: task.reviewModel ?? settings['review.model'], effort: task.reviewEffort ?? null },
      change,
      fixRound > 0 && lastRound ? { fixRound, findings: lastRound.findings } : null,
    );
    if (!result) {
      // nothing survived truncation to judge — settle rather than strand `reviewing`
      await this.setReviewState(taskId, 'skipped');
      return;
    }

    // work → review → work: hand blocker/major findings back to the SAME live
    // worker session to fix, then it Stops and re-reviews. Bounded rounds so
    // an unfixable finding can't loop forever; minor-only or clean lands in
    // the human review queue as before. Decided BEFORE the row is written so
    // the round, the summary and the state land in one broadcast.
    const actionable = result.findings.filter((f) => f.severity === 'blocker' || f.severity === 'major');
    const maxRounds = settings['review.maxRounds'];
    const current = await this.storage.getTask(taskId);
    let canLoop =
      actionable.length > 0 &&
      fixRound < maxRounds &&
      current?.status === 'review' && // human hasn't taken over
      (await this.hasLiveSession(taskId));
    // budget.taskUsd: the fix round is an automatic turn. Refused, the
    // findings stand (`flagged`) and the reason goes on the row — the human
    // can still Apply fixes, which is a click and never gated.
    let overBudget: Extract<BudgetVerdict, { ok: false }> | null = null;
    if (canLoop) {
      const verdict = await this.budgetAllows({ id: taskId }, 'fix-round', settings);
      if (!verdict.ok) {
        overBudget = verdict;
        canLoop = false;
      }
    }
    const round: ReviewRound = {
      round: task.reviewRounds.length + 1,
      at: new Date().toISOString(),
      model: result.model,
      effort: result.effort,
      verdict: result.verdict,
      summary: result.summary,
      findings: result.findings,
      fixRound,
      diffHash: hash,
      diffStat: change.stat,
      error: result.error,
      requestedBy,
    };
    const state: ReviewState = canLoop
      ? 'fixing'
      : result.error
        ? 'error'
        : actionable.length > 0
          ? 'flagged'
          : 'passed';
    const updated = await this.storage.updateTask(taskId, {
      reviewSummary: result.markdown,
      reviewDiffHash: hash,
      reviewRounds: [...task.reviewRounds, round],
      reviewState: state,
    });
    if (updated) broadcast({ type: 'task.updated', task: updated });
    await this.storage.appendEvent({
      kind: 'run.reviewed',
      actor: 'system',
      taskId,
      repoId: repo.id,
      data: {
        model: result.model,
        verdict: result.verdict,
        findings: result.findings.length,
        actionable: actionable.length,
        round: round.round,
        fixRound,
        state,
        commits: change.commits.length,
        attribution: change.attribution,
        ...(requestedBy ? { requestedBy } : {}),
      },
    });

    if (canLoop) {
      this.fixRounds.set(taskId, fixRound + 1);
      const msg = [
        `Adversarial review (round ${fixRound + 1}) found ${actionable.length} issue(s) to fix before this task is done:`,
        ...actionable.map((f) => `- [${f.severity}] ${f.summary}${f.detail ? ` — ${f.detail}` : ''}`),
        `Fix the blocker/major items above (address minors if quick), then finish. Your fix will be re-reviewed.`,
      ].join('\n');
      await this.storage.appendEvent({
        kind: 'task.follow-up',
        actor: 'system',
        taskId,
        repoId: repo.id,
        data: { reason: 'adversarial-review', round: fixRound + 1, actionable: actionable.length },
      });
      const res = await this.followUp(taskId, msg, 'system'); // reactivates the idle session → running
      if ('error' in res) {
        // The session went away between the liveness check and the resume:
        // the findings stand, nobody is fixing them.
        this.fixRounds.delete(taskId);
        await this.setReviewState(taskId, 'flagged');
      }
    } else {
      this.fixRounds.delete(taskId); // loop settled (clean, minors, cap, budget, or human took over)
      if (overBudget) await this.refuseOverBudget(taskId, 'fix-round', overBudget);
    }
  }

  /**
   * The check stage of the verify loop (docs/checks.md), run at the top of
   * every review pass. Acts only on a row whose `checkState` says checks are
   * due (`pending`, set by the Stop hook in the same write that parked the
   * task; or `running`, left by a crash). Returns whether the review round
   * should run this pass:
   *  - no checks due / none apply any more / empty diff → true (today's path)
   *  - green → true; the reviewer reads the results from the row as evidence
   *  - error (a check timed out or could not start) → true: no verdict is not
   *    a red, the reviewer is told
   *  - red → the failure is typed into the worker's own session (followUp),
   *    false; the next Stop comes back through here. Once the loop is spent —
   *    `checks.maxRounds`, the budget fuse, no progress, no live session, or a
   *    human took over — the task stays in `review` with `checkState: 'red'`
   *    and the reviewer is skipped (audited), false.
   */
  private async runCheckStage(taskId: string): Promise<boolean> {
    const task = await this.storage.getTask(taskId);
    if (!task?.checkState || !CHECK_BUSY_STATES.includes(task.checkState)) return true;
    if (task.status !== 'review') {
      // A human or a newer turn took the task between the Stop and here; the
      // next Stop marks the checks again. The review round releases its own.
      this.checkLoops.delete(taskId);
      await this.setCheckState(taskId, null);
      return true;
    }
    const repo = task.repoId ? await this.storage.getRepo(task.repoId) : null;
    const runner = this.commandRunner;
    const checks = repo && runner ? selectChecks(await this.storage.listCommands(repo.id), task) : [];
    if (!repo || !runner || !checks.length) {
      // the checks were removed (or deselected) between the Stop and now
      this.checkLoops.delete(taskId);
      await this.settleChecks(taskId, null);
      return true;
    }
    const scoped = await this.ensureBase(task, repo, false);
    const change = await workerDiff(repo, await this.changeScope(scoped, repo));
    const audit = (data: Record<string, unknown>) =>
      this.storage.appendEvent({ kind: 'task.checked', actor: 'system', taskId, repoId: repo.id, data });
    if (!change.hash) {
      // The task changed nothing: there is nothing of its own to verify (the
      // review round skips it as empty-diff too).
      this.checkLoops.delete(taskId);
      await audit({ skipped: 'empty-diff' });
      await this.settleChecks(taskId, null);
      return true;
    }
    const names = checks.map((c) => c.name).sort().join('\n');
    if (
      change.hash === task.checkDiffHash &&
      task.checkResults.length > 0 &&
      checksVerdict(task.checkResults) === 'green' &&
      task.checkResults.map((r) => r.name).sort().join('\n') === names
    ) {
      // A talk-only turn (dispatch reply, answered question): the same change
      // already passed the same checks.
      this.checkLoops.delete(taskId);
      await audit({ skipped: 'unchanged-diff', state: 'green' });
      await this.settleChecks(taskId, 'green');
      return true;
    }

    await this.setCheckState(taskId, 'running');
    const results = await runChecks(runner, repo, checks, taskId, async () => {
      const t = await this.storage.getTask(taskId);
      return t?.status !== 'review';
    });
    if (!results) {
      // taken over mid-run: no verdict belongs to anyone
      this.checkLoops.delete(taskId);
      await audit({ skipped: 'taken-over' });
      const t = await this.storage.getTask(taskId);
      if (t && t.status !== 'review') await this.setCheckState(taskId, null);
      return true;
    }
    const verdict = checksVerdict(results);
    const settings = await this.storage.getSettings();
    const maxRounds = settings['checks.maxRounds'];
    const loop = this.checkLoops.get(taskId);
    const round = loop?.round ?? 0;
    let stop: 'no-progress' | 'max-rounds' | 'taken-over' | 'no-session' | 'budget' | null = null;
    let overBudget: Extract<BudgetVerdict, { ok: false }> | null = null;
    if (verdict === 'red') {
      if (loop && loop.hash === change.hash) stop = 'no-progress';
      else if (round >= maxRounds) stop = 'max-rounds';
      else if ((await this.storage.getTask(taskId))?.status !== 'review') stop = 'taken-over';
      else if (!(await this.hasLiveSession(taskId))) stop = 'no-session';
      else {
        const v = await this.budgetAllows({ id: taskId }, 'check-round', settings);
        if (!v.ok) {
          overBudget = v;
          stop = 'budget';
        }
      }
    }
    const cur = await this.storage.getTask(taskId);
    // Red never reaches the reviewer: a fix turn is coming (whose own Stop
    // marks the review again), or the loop is spent and the change does not
    // pass its own definition of done.
    const dropReview = verdict === 'red' && cur?.reviewState === 'pending';
    const updated = await this.storage.updateTask(taskId, {
      // A fix turn about to be sent keeps reading `running` until the task
      // is `running` again: `review` + red for the seconds the resume takes
      // would read as a landing to every surface (the review ping included).
      checkState: verdict === 'red' && !stop ? 'running' : verdict,
      checkResults: results,
      checkDiffHash: change.hash,
      ...(dropReview ? { reviewState: null } : {}),
    });
    if (updated) broadcast({ type: 'task.updated', task: updated });
    await audit({
      state: verdict,
      round,
      ...(stop ? { stop } : {}),
      results: results.map((r) => ({
        name: r.name,
        outcome: r.outcome,
        exit: r.exit,
        durationMs: r.durationMs,
        retried: r.retried,
        ...(r.error ? { error: r.error } : {}),
      })),
    });

    if (verdict !== 'red') {
      this.checkLoops.delete(taskId);
      return true;
    }
    if (!stop) {
      this.checkLoops.set(taskId, { round: round + 1, hash: change.hash });
      await this.storage.appendEvent({
        kind: 'task.follow-up',
        actor: 'system',
        taskId,
        repoId: repo.id,
        data: { reason: 'checks', round: round + 1, red: results.filter((r) => r.outcome === 'red').map((r) => r.name) },
      });
      const res = await this.followUp(taskId, checkFixMessage(results, round + 1, maxRounds), 'system');
      // the verdict the fix turn is working on (and what its Stop reads to append, not replace, the summary)
      // (only over the `running` written above: a Stop that already marked `pending` wins)
      if ((await this.storage.getTask(taskId))?.checkState === 'running') await this.setCheckState(taskId, 'red');
      if (!('error' in res)) return false;
      // the session went away between the liveness check and the resume
      stop = 'no-session';
    }
    this.checkLoops.delete(taskId);
    if (dropReview) {
      await this.storage.appendEvent({
        kind: 'run.reviewed',
        actor: 'system',
        taskId,
        repoId: repo.id,
        data: { skipped: 'checks-red', state: null, stop },
      });
    }
    if (overBudget) await this.refuseOverBudget(taskId, 'check-round', overBudget);
    return false;
  }

  /**
   * Settle the check stage WITHOUT a red/error verdict — green, or nothing to
   * check (empty diff, checks gone) — writing `state`. Landing is not decided
   * here: the review round runs next on every tier, and `landIfClean` reads
   * both verdicts after it (docs/design.md § Landing tiers).
   */
  private async settleChecks(taskId: string, state: 'green' | null): Promise<void> {
    await this.setCheckState(taskId, state);
  }

  /** Persist + broadcast a check-state change; a no-op when it already reads that way. */
  private async setCheckState(taskId: string, state: CheckState | null): Promise<void> {
    const cur = await this.storage.getTask(taskId);
    if (!cur || cur.checkState === state) return;
    const updated = await this.storage.updateTask(taskId, { checkState: state });
    if (updated) broadcast({ type: 'task.updated', task: updated });
  }

  /** Persist + broadcast a review-state change; a no-op when it already reads that way. */
  private async setReviewState(taskId: string, state: ReviewState | null): Promise<void> {
    const cur = await this.storage.getTask(taskId);
    if (!cur || cur.reviewState === state) return;
    const updated = await this.storage.updateTask(taskId, { reviewState: state });
    if (updated) broadcast({ type: 'task.updated', task: updated });
  }

  // ---- loop tasks (docs/loops.md) -------------------------------------------

  /**
   * Is this Stop the end of a loop iteration? Then the Stop route hands it to
   * `loopIterationStopped` instead of landing it: between iterations the task
   * stays `running` (no new TaskStatus). Not the publish turn, and not a turn
   * after the loop ended (a review fix round, a follow-up) — those land as
   * any task's do.
   */
  isLoopIterationStop(task: Task | null, publishRun: boolean): boolean {
    return (
      !!task &&
      !publishRun &&
      task.kind === 'loop' &&
      task.loopState === 'iterating' &&
      (task.status === 'running' || task.status === 'waiting')
    );
  }

  /**
   * The iteration's turn is over (from the Stop route). Steps the loop to
   * `checking` — conditionally, so a cancel that won the race keeps the task
   * — closes the iteration's session (each iteration is a FRESH one, and a
   * live PTY would hold a worker slot) and settles the rest off the hook path.
   */
  async loopIterationStopped(runId: string, taskId: string, lastText: string | null): Promise<void> {
    const cur = await this.storage.getTask(taskId);
    if (!cur || cur.kind !== 'loop' || cur.loopState !== 'iterating') return;
    const stepped =
      cur.status === 'waiting'
        ? await this.storage.transitionTask(taskId, ['waiting'], 'running', 'hook', { loopState: 'checking' })
        : await this.storage.stepLoop(taskId, ['iterating'], { loopState: 'checking' });
    if (!stepped) return;
    this.dropWait(runId);
    broadcast({ type: 'task.updated', task: stepped });
    const idled = await this.storage.updateRun(runId, { idle: true, needsAttention: false });
    if (idled) broadcast({ type: 'run.exited', run: idled });
    // handleExit leaves the task alone while the loop is `checking`/`next`.
    this.sessions.kill(runId);
    await this.waitForSessionExit(runId);
    broadcast({ type: 'orchestrator.status', status: await this.status() });
    void this.settleLoopIteration(taskId, runId, lastText);
  }

  /** Loops whose iteration end is being settled RIGHT NOW — single-flight per task. */
  private loopSettling = new Set<string>();

  /**
   * After an iteration: commit what it left, run the checks, measure the
   * change, record the iteration, then either queue the next one (`next`,
   * started by `pumpLoops` when a worker slot frees) or END the loop, which
   * lands `review` like a Stop and hands it to the one review round.
   */
  private async settleLoopIteration(taskId: string, runId: string, lastText: string | null): Promise<void> {
    if (this.loopSettling.has(taskId)) return;
    this.loopSettling.add(taskId);
    let task: Task | null = null;
    try {
      task = await this.storage.getTask(taskId);
      if (!task || task.status !== 'running' || task.loopState !== 'checking') return;
      const repo = task.repoId ? await this.storage.getRepo(task.repoId) : null;
      if (!repo) {
        await this.endLoop(task, 'error', null, lastText, 'the task has no repo');
        return;
      }
      const n = task.loopIteration;
      const result = parseLoopResult(lastText);
      const humanNeeded = await this.loopNeededHuman(runId, taskId);
      // Leftovers first: the next iteration must start from a clean tree, and
      // the checks and the hash below then read exactly what was committed.
      const handoff = await handoffCommit(repo, task, {
        subject: `Loop ${n}`,
        body: `Uncommitted work loop iteration ${n} left in the checkout, committed locally by the task manager so the next iteration starts from a clean tree. Not pushed.`,
      });
      if (!handoff.ok) {
        await this.endLoop(task, 'error', null, lastText, `could not commit what iteration ${n} left: ${handoff.error}`);
        return;
      }
      const runner = this.commandRunner;
      const checks = runner ? selectChecks(await this.storage.listCommands(repo.id), task) : [];
      let results: CheckResult[] = [];
      if (checks.length && runner) {
        const ran = await runChecks(runner, repo, checks, taskId, async () => {
          const t = await this.storage.getTask(taskId);
          return t?.status !== 'running' || t.loopState !== 'checking';
        });
        if (!ran) {
          // cancelled (or otherwise taken) mid-check: no verdict belongs to anyone
          await this.storage.appendEvent({ kind: 'task.loop', actor: 'system', taskId, repoId: repo.id, data: { phase: 'taken-over', n } });
          return;
        }
        results = ran;
      }
      const verdict = results.length ? checksVerdict(results) : null;
      const scoped = await this.ensureBase(task, repo, false);
      const change = await workerDiff(repo, await this.changeScope(scoped, repo));
      const measured = loopMetric(results.length ? results : null);
      const np = noProgress(task.loopHistory.at(-1), { diffHash: change.hash, ...measured });
      const budget = await this.budgetAllows(task, 'loop-iteration');
      const fresh = (await this.storage.getTask(taskId)) ?? task;
      const entry: LoopIteration = {
        n,
        runId,
        endedAt: new Date().toISOString(),
        goalMet: result.goalMet,
        note: result.note,
        checkState: verdict,
        checks: results.map((r) => ({ name: r.name, outcome: r.outcome })),
        ...measured,
        diffHash: change.hash,
        handoff: !!handoff.sha,
        noProgress: np,
        costUsd: fresh.costUsd,
        stop: null,
      };
      const history = [...task.loopHistory, entry];
      const max = maxIterations(task);
      entry.stop = loopStop({
        n,
        max,
        goalMet: result.goalMet,
        checkState: verdict,
        humanNeeded: !!humanNeeded,
        budgetOk: budget.ok,
        streak: noProgressStreak(history),
      });
      const stepped = await this.storage.stepLoop(taskId, ['checking'], {
        loopHistory: history,
        checkResults: results,
        checkDiffHash: change.hash,
        ...(entry.stop ? {} : { loopState: 'next' as const }),
      });
      if (!stepped) return; // cancelled meanwhile
      await this.storage.appendEvent({
        kind: 'task.loop',
        actor: 'system',
        taskId,
        runId,
        repoId: repo.id,
        data: {
          phase: 'ended',
          n,
          goalMet: entry.goalMet,
          checks: verdict,
          metric: entry.metric,
          metricSource: entry.metricSource,
          noProgress: np,
          handoff: handoff.sha,
          costUsd: entry.costUsd,
          stop: entry.stop,
          ...(humanNeeded ? { humanNeeded } : {}),
          ...(!budget.ok ? { fuse: budget.fuse } : {}),
        },
      });
      broadcast({ type: 'task.updated', task: stepped });
      if (!entry.stop) {
        this.maybeSchedule();
        return;
      }
      await this.endLoop(stepped, entry.stop, verdict, lastText, !budget.ok ? budget.reason : null);
    } catch (e) {
      console.error(`loop ${taskId}: settling an iteration failed:`, e);
      const t = await this.storage.getTask(taskId).catch(() => null);
      if (t && t.status === 'running' && t.loopState === 'checking') {
        await this.endLoop(t, 'error', null, lastText, `settling the iteration failed: ${(e as Error)?.message ?? e}`).catch(
          () => {},
        );
      }
    } finally {
      this.loopSettling.delete(taskId);
    }
  }

  /**
   * Did a human have to step into this iteration? A question it asked
   * (docs/questions.md) or a permission prompt it raised (`run.attention`
   * from the Notification hook — never the run-minutes fuse's flag, which is
   * not a prompt). Read from rows, so it survives the run's in-memory state.
   */
  private async loopNeededHuman(runId: string, taskId: string): Promise<'question' | 'attention' | null> {
    if ((await this.storage.listQuestions({ runId })).length) return 'question';
    const flags = await this.storage.listEvents({ kind: 'run.attention', taskId, limit: 50 });
    return flags.some((e) => e.runId === runId && e.actor === 'hook') ? 'attention' : null;
  }

  /**
   * End the loop: land `review` in ONE conditional transition that also says
   * how it ended (`loop_state`), where its checks stand (the last
   * iteration's verdict — the check stage then has nothing to re-run) and
   * whether the one review round will read it. Red never reaches the reviewer
   * (docs/checks.md); a `paused` loop is not reviewed either — it is not over.
   * The landing tier then decides in `landIfClean`, and `landingReason`
   * refuses any loop that did not end `met`.
   */
  private async endLoop(
    task: Task,
    stop: LoopState,
    verdict: CheckState | null,
    lastText: string | null,
    detail: string | null,
  ): Promise<void> {
    const settings = await this.storage.getSettings();
    const n = task.loopIteration;
    const max = maxIterations(task);
    const willReview = stop !== 'paused' && stop !== 'error' && verdict !== 'red' && (task.review ?? settings['review.enabled']);
    const text = loopStopText(stop, n, max) + (detail ? ` — ${detail}` : '');
    this.holdCustomQueue(task.id);
    const release = () => this.releaseCustomQueue(task.id);
    let handedOff = false;
    try {
      const landed = await this.storage.transitionTask(
        task.id,
        ['running'],
        'review',
        'orchestrator',
        {
          loopState: stop,
          checkState: verdict,
          reviewState: willReview ? 'pending' : null,
          error: stop === 'met' ? null : text,
          ...(lastText ? { resultSummary: lastText.slice(0, 4000) } : {}),
        },
        { loop: { stop, iterations: n } },
      );
      if (!landed) return;
      if (verdict === 'red' && stop !== 'paused') {
        await this.storage.appendEvent({
          kind: 'run.reviewed',
          actor: 'system',
          taskId: task.id,
          repoId: task.repoId,
          data: { skipped: 'checks-red', state: null, stop: `loop-${stop}` },
        });
      }
      broadcast({ type: 'task.updated', task: landed });
      await this.resolveCompletion(landed, 'orchestrator');
      broadcast({ type: 'orchestrator.status', status: await this.status() });
      this.maybeSchedule();
      handedOff = true;
      // The one review round, over every commit the loop made, then the tier.
      // Not through the review loop when no review is due: `runReviewRound`
      // reads the task's review SETTING, not `reviewState`, and would review
      // a red or paused end anyway (measured) — the tier alone decides there.
      void (willReview ? this.reviewCompletedRun(task.id) : this.landIfClean(task.id)).finally(release);
    } finally {
      if (!handedOff) release();
    }
  }

  /**
   * Start the iteration a scheduling pass found due (`next`), while a worker
   * slot is free — every iteration is a worker run and counts toward
   * `orchestrator.concurrency`. Runs before the global claim and regardless
   * of the queue switch (the task is already running), but not past the day
   * budget; the loop's own budget is re-asked here.
   */
  private async pumpLoops(cap: number): Promise<void> {
    const due = (await this.storage.listTasks({ status: 'running' }))
      .filter((t) => t.kind === 'loop' && t.loopState === 'next' && !this.loopSettling.has(t.id))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const task of due) {
      if (this.activeWorkers() >= cap) return;
      const v = await this.budgetAllows(task, 'loop-iteration');
      if (!v.ok) {
        await this.endLoop(task, 'budget', task.loopHistory.at(-1)?.checkState ?? null, null, v.reason);
        continue;
      }
      await this.startWorker(task);
    }
  }

  /**
   * Number and step the iteration `startWorker` is about to spawn. From
   * `next` it is the loop going on (n + 1); from anything else it is a fresh
   * start of the loop — a first claim, Run now, Retry — so the count and the
   * history restart (the ledger file and the task's cost do not).
   */
  private async beginLoopIteration(task: Task): Promise<Task | null> {
    const continuing = task.loopState === 'next';
    const n = continuing ? task.loopIteration + 1 : 1;
    const from: (LoopState | null)[] = continuing
      ? ['next']
      : [null, 'iterating', 'checking', 'met', 'max-iterations', 'budget', 'no-progress', 'paused', 'error'];
    const stepped = await this.storage.stepLoop(task.id, from, {
      loopState: 'iterating',
      loopIteration: n,
      ...(continuing ? {} : { loopHistory: [], checkResults: [], checkDiffHash: null }),
    });
    if (!stepped) return null;
    await this.storage.appendEvent({
      kind: 'task.loop',
      actor: 'orchestrator',
      taskId: task.id,
      repoId: task.repoId,
      data: { phase: 'started', n, max: maxIterations(task), ...(continuing ? {} : { fresh: true }) },
    });
    return stepped;
  }

  /**
   * "Continue" (POST /api/tasks/:id/loop/continue): a loop that stopped short
   * — iterations, budget, no progress, paused, error — goes on from where it
   * stood, numbering on. The ceilings are not bypassed: the human raises
   * them first (PATCH, from the dashboard). The task goes back to `running` in
   * `next`; the next scheduling pass starts the iteration.
   */
  async continueLoop(taskId: string, actor = 'human'): Promise<ActionResult> {
    const t = await this.storage.getTask(taskId);
    if (!t) return { error: 'task not found', code: 404 };
    if (t.kind !== 'loop') return { error: 'not a loop task', code: 409 };
    if (!['review', 'failed', 'cancelled'].includes(t.status) || !t.loopState || !LOOP_CONTINUABLE_STATES.includes(t.loopState)) {
      return { error: 'nothing to continue — the loop is running, finished (goal met) or never started', code: 409 };
    }
    if (verifyOpen(t)) return { error: 'the review round is still open — wait for its verdict', code: 409 };
    const max = maxIterations(t);
    if (t.loopIteration >= max) return { error: `all ${max} iterations are used — raise maxIterations first`, code: 409 };
    const cap = loopBudget(t);
    if (cap && t.costUsd >= cap) {
      return { error: `the loop has cost $${t.costUsd.toFixed(2)} of its $${cap.toFixed(2)} budget — raise it first`, code: 409 };
    }
    const runs = await this.storage.listRuns({ taskId });
    if (runs.some((r) => this.sessions.get(r.id)?.exit === null && !this.sessions.isIdle(r.id))) {
      return { error: 'the agent is still working', code: 409 };
    }
    // an idle terminal of the last turn: the next iteration is a fresh session
    for (const r of runs) {
      if (this.sessions.get(r.id)?.exit === null) {
        this.sessions.kill(r.id);
        await this.storage.updateRun(r.id, { status: 'killed', endedAt: new Date().toISOString() });
        await this.waitForSessionExit(r.id);
      }
    }
    const task = await this.storage.transitionTask(
      taskId,
      ['review', 'failed', 'cancelled'],
      'running',
      actor,
      { loopState: 'next', error: null, reviewState: null, checkState: null },
      { loop: 'continue' },
    );
    if (!task) return { error: 'the task moved meanwhile', code: 409 };
    await this.storage.appendEvent({
      kind: 'task.loop',
      actor,
      taskId,
      repoId: task.repoId,
      data: { phase: 'continued', from: t.loopState, n: t.loopIteration },
    });
    broadcast({ type: 'task.updated', task });
    this.maybeSchedule();
    return { task };
  }

  // ---- needs-attention lifecycle -------------------------------------------

  /** The Notification hook raised the flag on this run: remember when. */
  attentionFlagged(runId: string): void {
    this.attentionAt.set(runId, Date.now());
  }

  /**
   * The transcript grew an assistant line stamped `at` — from the activity
   * watcher, which tails every live run. Newer than the flag means the
   * prompt was answered (approved: the tool ran and the agent went on;
   * denied: the agent was told and went on), so the flag is stale. An older
   * line is the one that CAUSED the prompt, still being caught up on.
   */
  async attentionProgress(runId: string, at: string): Promise<void> {
    const t = Date.parse(at);
    // Same test for a parked wait: a line newer than the park means the
    // session is talking again — re-invoked by its child, or a human typed
    // into the attached terminal. The Stop's own last line is older.
    const waiting = this.waitingRuns.get(runId);
    if (waiting && Number.isFinite(t) && t > waiting.at) await this.endWait(runId, 'transcript-progress');
    const flagged = this.attentionAt.get(runId);
    if (flagged === undefined) return;
    if (!Number.isFinite(t) || t <= flagged) return;
    this.attentionAt.delete(runId);
    const run = await this.storage.getRun(runId);
    if (!run || !run.needsAttention) return;
    const cleared = await this.storage.updateRun(runId, { needsAttention: false });
    if (!cleared) return;
    await this.storage.appendEvent({
      kind: 'run.attention',
      actor: 'system',
      runId,
      taskId: cleared.taskId,
      data: { cleared: 'agent-resumed' },
    });
    broadcast({ type: 'run.needs-attention', run: cleared });
  }

  /** The run is over one way or another — forget its flag time. */
  private forgetAttention(runId: string): void {
    this.attentionAt.delete(runId);
    this.overtimeRaised.delete(runId);
    this.overtimeFlags.delete(runId);
  }

  // ---- waiting lifecycle (docs/design.md § Waiting) ------------------------

  private children(runId: string): { ids: Set<string>; anon: number; returned: Set<string> } {
    let c = this.childrenInFlight.get(runId);
    if (!c) {
      c = { ids: new Set<string>(), anon: 0, returned: new Set<string>() };
      this.childrenInFlight.set(runId, c);
    }
    return c;
  }

  /**
   * The CLI's list of still-running background subagents replaces the hook
   * count, less any id whose SubagentStop has already been seen. `anon` goes
   * too: an id-less start is exactly what the list now accounts for.
   */
  private reconcileChildren(runId: string, running: string[]): void {
    const c = this.children(runId);
    c.ids = new Set(running.filter((id) => !c.returned.has(id)));
    c.anon = 0;
  }

  /** SubagentStart hook: one more child of this run is out. */
  subagentStarted(runId: string, agentId: string | null): void {
    const c = this.children(runId);
    if (agentId) {
      c.ids.add(agentId);
      // a child continued after it returned (SendMessage) is out again
      c.returned.delete(agentId);
    } else c.anon++;
  }

  /**
   * SubagentStop hook: a child returned. When it was the last one the CLI is
   * about to re-invoke the session with its result, so a task parked
   * `waiting` on it goes back to `running` here rather than a poll later.
   * `stillRunning` is the payload's own `background_tasks` (running
   * subagents; it still lists the child that is stopping), null when the CLI
   * sent none.
   */
  async subagentStopped(runId: string, agentId: string | null, stillRunning: string[] | null): Promise<void> {
    const c = this.children(runId);
    if (agentId) {
      c.returned.add(agentId);
      // An id we never saw start is NOT one of our children: the CLI fires
      // SubagentStop for its own helper agents (`agent_type: ''`, no
      // SubagentStart — measured on 2.1.266). Letting it stand for "any one
      // child" erased the live Explore agent the task was waiting on, and the
      // next Stop landed a half-done tree in review.
      c.ids.delete(agentId);
    } else if (c.anon > 0) c.anon--;
    if (stillRunning) this.reconcileChildren(runId, stillRunning);
    // Not while shells also hold the park: the last CHILD returning says
    // nothing about them (and a helper agent's stop, which fires at any time,
    // would otherwise flip an idle session to `running` and drop the shell
    // timer with it). The CLI re-invoking the session is seen anyway, as a
    // newer transcript line.
    if (this.pendingChildren(runId) === 0 && !this.waitingRuns.get(runId)?.timer) {
      await this.endWait(runId, 'children-done');
    }
  }

  /** How many subagents this run has launched and not yet seen return. */
  pendingChildren(runId: string): number {
    const c = this.childrenInFlight.get(runId);
    return c ? c.ids.size + c.anon : 0;
  }

  /**
   * The Stop route's question: should this turn's end park the task rather
   * than land it? Yes when children are still out — unless the task is
   * ALREADY parked on exactly this set of children, which means the previous
   * wait never ended through either channel (the child's stop hook or a newer
   * transcript line) and yet the agent produced a Stop: most likely a lost
   * hook, and re-parking would hold the task forever. That turn lands the
   * ordinary way and the decision is audited as `stale`.
   *
   * `stillRunning` is the Stop payload's `background_tasks` (running
   * subagents), null when the CLI sent none. When present it is the answer —
   * the CLI's own ledger at the moment the turn ended, not a count rebuilt
   * from fire-and-forget hooks — and `stale` never applies: that guard exists
   * for a LOST hook, and a turn that ends twice in a row on the same live
   * child ("Launched." then "Waiting for the Explore agent…", seconds apart,
   * before the watcher polls either line) is the ordinary case, not one.
   *
   * `shells` is the same payload's running background shells (null without
   * a list). A shell the agent ended its turn to wait for re-invokes the
   * session when it exits, exactly like a child — landing that turn is what
   * handed a half-finished task to the reviewer, whose fix round then killed
   * the PTY and the shell with it. But a shell has no stop hook and a dev
   * server never exits, so each one counts only for `shellWaitMs` from the
   * first Stop that listed it; `shellDeadline` is the earliest moment one
   * still counting stops counting (null when none does), for the park's timer.
   */
  waitDecision(
    runId: string,
    stillRunning: string[] | null,
    shells: string[] | null = null,
    shellWaitMs = 0,
  ): { children: number; shells: number; shellDeadline: number | null; snapshot: string; stale: boolean } {
    if (stillRunning) this.reconcileChildren(runId, stillRunning);
    const c = this.childrenInFlight.get(runId);
    const ids = c ? [...c.ids].sort() : [];
    const snapshot = `${ids.join(',')}|${c?.anon ?? 0}`;
    const children = this.pendingChildren(runId);
    const stale = !stillRunning && children > 0 && this.waitingRuns.get(runId)?.snapshot === snapshot;
    let counted = 0;
    let shellDeadline: number | null = null;
    if (shells?.length) {
      const now = Date.now();
      let seen = this.shellsSeen.get(runId);
      if (!seen) {
        seen = new Map<string, number>();
        this.shellsSeen.set(runId, seen);
      }
      for (const id of shells) {
        if (!seen.has(id)) seen.set(id, now);
        const deadline = seen.get(id)! + shellWaitMs;
        if (deadline <= now) continue;
        counted++;
        if (shellDeadline === null || deadline < shellDeadline) shellDeadline = deadline;
      }
    }
    return { children, shells: counted, shellDeadline, snapshot, stale };
  }

  /**
   * The Stop route parked the task: remember on what, and since when. With a
   * `shellDeadline`, the Stop's `replay` payload is handed back to the route
   * at that moment so the turn can land if nothing counts any more.
   */
  parkedWaiting(runId: string, taskId: string, snapshot: string, shellDeadline: number | null = null, replay: unknown = null): void {
    this.dropWait(runId);
    const entry = { taskId, snapshot, at: Date.now(), timer: null as NodeJS.Timeout | null, replay };
    this.waitingRuns.set(runId, entry);
    if (shellDeadline !== null) this.armShellWait(runId, entry, shellDeadline);
  }

  /**
   * A replayed Stop found shells (or children) that still count: keep the
   * SAME park — its `at` is what a newer transcript line is measured against —
   * and wait for the next deadline instead.
   */
  rearmShellWait(runId: string, parkedAt: number, shellDeadline: number | null): void {
    const w = this.waitingRuns.get(runId);
    if (!w || w.at !== parkedAt) return;
    if (w.timer) clearTimeout(w.timer);
    w.timer = null;
    if (shellDeadline !== null) this.armShellWait(runId, w, shellDeadline);
  }

  private armShellWait(runId: string, w: { at: number; timer: NodeJS.Timeout | null; replay: unknown }, deadline: number): void {
    // +1s so the replay's own `deadline <= now` test cannot land on the near
    // side of the boundary and re-arm for a zero-length wait.
    w.timer = setTimeout(() => {
      if (this.waitingRuns.get(runId) !== w) return;
      // `timer` stays set (spent) through the replay: it is also the "shells
      // hold this park" mark `subagentStopped` reads.
      const handler = this.shellWaitHandler;
      if (!handler) return;
      handler(runId, w.replay, w.at).catch((e) => console.error('[waiting] shell-wait replay failed:', e));
    }, Math.max(0, deadline - Date.now()) + 1000);
    w.timer.unref();
  }

  /** Registered once by the Stop route (routes/internal.ts). */
  onShellWaitExpired(handler: (runId: string, body: unknown, parkedAt: number) => Promise<void>): void {
    this.shellWaitHandler = handler;
  }

  /** When this run's current park began, or null when it is not parked. */
  parkedAt(runId: string): number | null {
    return this.waitingRuns.get(runId)?.at ?? null;
  }

  /** Forget a park without touching the task: the turn landed, or the run is over. */
  dropWait(runId: string): void {
    const w = this.waitingRuns.get(runId);
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    this.waitingRuns.delete(runId);
  }

  /**
   * `waiting → running`: the wait is over. Conditional, so a task a human
   * cancelled or a run that exited meanwhile is left as it is.
   */
  private async endWait(runId: string, resumed: 'children-done' | 'transcript-progress'): Promise<void> {
    const w = this.waitingRuns.get(runId);
    if (!w) return;
    this.dropWait(runId);
    const task = await this.storage.transitionTask(w.taskId, ['waiting'], 'running', 'system');
    if (!task) return;
    await this.storage.appendEvent({
      kind: 'task.waiting',
      actor: 'system',
      runId,
      taskId: task.id,
      repoId: task.repoId,
      data: { resumed, waitedMs: Date.now() - w.at },
    });
    broadcast({ type: 'task.updated', task });
  }

  /**
   * `review → running` when a HUMAN starts a turn in the task's live, idle
   * session (the `UserPromptSubmit` hook — docs/design.md § Worker invocation
   * + completion detection). Every turn the server starts goes through
   * `followUp`, which retires the idle PTY and moves the task itself, and the
   * one text the server types into a live PTY (transient `continue`) is typed
   * only into a non-idle session of a `running`/`waiting` task — so an IDLE
   * session submitting a prompt is someone at the attached terminal. A no-op
   * unless this run is the task's newest run and the task sits in `review`
   * with its verify round settled (not a loop): an open review round or check
   * stage owns the status. The session is un-idled with the move, so it takes
   * a slot again and the next Stop lands through the normal path (the Stop
   * route drops a Stop from an idle session). Review/check states are left as
   * they are, exactly as a follow-up leaves them; the diff hash decides at
   * that Stop whether anything is re-reviewed.
   */
  async promptInLiveSession(runId: string): Promise<boolean> {
    if (!this.sessions.isIdle(runId) || this.sessions.get(runId)?.exit !== null) return false;
    const run = await this.storage.getRun(runId);
    if (!run?.taskId || run.mode !== 'worker' || run.status !== 'running') return false;
    const latest = (await this.storage.listRuns({ taskId: run.taskId }))[0];
    if (latest && latest.id !== runId) return false;
    const cur = await this.storage.getTask(run.taskId);
    if (!cur || cur.status !== 'review' || cur.kind === 'loop' || verifyOpen(cur)) return false;
    // read synchronously right before the conditional write: a Review now
    // takes this lock before it marks the row `pending`
    if (this.pendingReviews.has(cur.id) || !this.sessions.isIdle(runId)) return false;
    const task = await this.storage.transitionTask(cur.id, ['review'], 'running', 'human', {}, {
      reason: 'prompt in live session',
      runId,
    });
    if (!task) return false;
    this.sessions.markActive(runId);
    const active = await this.storage.updateRun(runId, { idle: false });
    if (active) broadcast({ type: 'run.updated', run: active });
    broadcast({ type: 'task.updated', task });
    if (task.wakeAt) await this.clearWake(task.id);
    return true;
  }

  /**
   * A task reached a terminal status — re-evaluate everything that waits on it:
   * its split parent (all-children-resolve semantics) and, when it belongs to a
   * feature, that feature's phase gate. Both are independent: a feature task
   * may also be a split parent.
   */
  async resolveCompletion(child: Task, actor = 'system'): Promise<void> {
    if (child.parentId) {
      // A split parent whose children all resolved lands by ITS OWN tier
      // (docs/design.md § Landing tiers): a parent has no change of its own to
      // check or review, so a tier above supervised means `done` (never a
      // publish — the children carry the commits).
      const parentRow = await this.storage.getTask(child.parentId);
      const parentRepo = parentRow?.repoId ? await this.storage.getRepo(parentRow.repoId) : null;
      const parentDone = parentRow && effectiveLanding(parentRow, parentRepo) !== 'supervised' ? 'done' : 'review';
      const parent = await this.storage.resolveChildCompletion(child.id, parentDone, actor);
      if (parent) broadcast({ type: 'task.updated', task: parent });
    }
    if (child.featureId) await this.advanceFeature(child.featureId, actor);
  }

  /**
   * Feature phase pump. Idempotent and safe to call from anywhere: the storage
   * composite decides whether to pause (a task failed), enqueue the lowest
   * unresolved phase, or roll the feature up to `review`.
   */
  async advanceFeature(featureId: string, actor = 'system'): Promise<void> {
    try {
      const res = await this.storage.resolveFeatureCompletion(featureId, actor);
      if (!res) return;
      broadcast({ type: 'feature.updated', feature: res.feature });
      for (const task of res.tasks) broadcast({ type: 'task.updated', task });
      if (res.action === 'phase-started') this.maybeSchedule();
    } catch (err) {
      // A feature must never take the scheduler down with it.
      console.error('feature advance failed:', err);
    }
  }
}
