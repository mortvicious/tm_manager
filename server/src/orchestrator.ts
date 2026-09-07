import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  isCodexModel,
  type AppSettings,
  type Dispatch,
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
import { publishRepo, verifyPublished } from './git.ts';
import { killAnalysis } from './claude/analyze.ts';
import { liveHeadless } from './claude/headless.ts';
import { reviewWorkerChange, workerDiff } from './claude/review.ts';
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
import { broadcast } from './events.ts';
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
   * Tasks whose adversarial review round is in flight RIGHT NOW — the
   * single-flight lock behind `reviewCompletedRun`. What other surfaces read
   * is the persisted `task.reviewState`, written at every step of the round.
   */
  private readonly pendingReviews = new Map<string, Promise<void>>();
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
   * sitting in `review`: `deliverDispatches` holds only running/queued/
   * blocked). It is remembered rather than dropped, because that Stop's turn
   * MAY have edited something: the in-flight round is allowed to finish and
   * stamp its hash, then one more pass runs, which the hash gate makes free
   * when nothing changed and a real review when it did.
   */
  private readonly reviewRecheck = new Set<string>();
  /** runs whose turn is a PUBLISH turn (docs/publish.md): their Stop must land
   *  the task in `published`, not in the human review queue. */
  private publishRuns = new Set<string>();
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
   * the queue claims nothing — `review` is not `running`, so without this the
   * next member would start in the gap before the fix round reopens the
   * previous one. Non-members may be held too; the pump ignores them.
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
  /** runs whose rejected banner has already been audited once (see below) */
  private readonly stallSkipsAudited = new Set<string>();

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
      // (review R2).
      if (run.needsAttention) continue;
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
          const task = await this.storage.transitionTask(run.taskId, ['running'], 'failed', 'system', {
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
    const stranded: string[] = [];
    for (const task of await this.storage.listTasks({ status: 'running' })) {
      const runs = await this.storage.listRuns({ taskId: task.id });
      if (runs.some((r) => r.status === 'running')) continue;
      // Ever had a worker? Then work may be sitting uncommitted in the tree and
      // its session is resumable — `review` is where a human picks that up.
      // Never ran at all, and there is nothing to review.
      const everRan = runs.some((r) => r.mode === 'worker');
      const to = everRan ? 'review' : 'failed';
      const moved = await this.storage.transitionTask(task.id, ['running'], to, 'system', {
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
    for (const task of await this.storage.listTasks()) {
      if (task.status === 'review' || task.status === 'done') {
        if (task.reviewState === 'pending' || task.reviewState === 'reviewing') {
          void this.reviewCompletedRun(task.id);
        } else if (task.reviewState === 'fixing') {
          await this.setReviewState(task.id, settledReviewState(task.reviewRounds));
        }
      } else if (task.reviewState === 'pending' || task.reviewState === 'reviewing' || task.reviewState === 'fixing') {
        if (task.status !== 'running') await this.setReviewState(task.id, null);
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
      // Headless agents have no PTY, so liveCount() cannot see them; the
      // restart guard needs them counted (docs/commands.md).
      headless: liveHeadless().length,
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
          // The custom queue (docs/queue.md) is independent of the global
          // switch: it runs while the queue is stopped, one task at a time.
          await this.pumpCustomQueue(cap);
          if (!settings['orchestrator.enabled']) {
            // The queue is stopped, but dispatch delivery is a continuation of
            // sessions that already exist — it runs regardless (user decision
            // 2026-08-27), like a human follow-up would.
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
          // overflow per live creating session, depth cap ≤ 2, so live
          // sessions ≤ cap×3, under the PTY hard cap.
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
   * Custom queue (docs/queue.md): strictly serial, FIFO by the moment the
   * human added each task, and independent of `orchestrator.enabled`. Claims
   * at most ONE task per pass, and only when (a) a worker slot is free,
   * (b) no member is `running` (enforced inside the claim SQL), (c) no member
   * is held between a finished turn and its review/publish follow-on, and
   * (d) the head's repo has no other live session working in it — a run-now
   * or dispatch turn in that repo makes the head WAIT, never skip: the order
   * the human set is the order that runs.
   */
  private async pumpCustomQueue(cap: number): Promise<void> {
    if (this.activeWorkers() >= cap) return;
    if (this.sessions.totalLiveCount() >= MAX_LIVE_SESSIONS) return;
    const head = await this.storage.peekCustomQueue();
    if (!head) return;
    if (await this.customQueueHeld()) return;
    if (head.repoId && (await this.repoBusy(head.repoId))) return;
    const task = await this.storage.claimNextCustomQueuedTask('orchestrator');
    if (!task) return; // a member is running (or the head changed underneath us)
    await this.startWorker(task);
  }

  /** Is any custom-queue MEMBER parked between a finished turn and its follow-on? */
  private async customQueueHeld(): Promise<boolean> {
    const nowMs = Date.now();
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
      return true;
    }
    return false;
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

        // Hold (retry later): mid-turn / about to start / waiting on children.
        if (['running', 'queued', 'blocked'].includes(target.status)) continue;
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
      label: `compact ${task.title.slice(0, 60)}`,
      // Keyed by the task so `cancel()` can stop a compaction it is about to
      // make pointless, instead of paying for another two minutes of it.
      key: task.id,
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
  private async startWorker(
    // Reassigned once, after the resume gate: a compaction can take minutes,
    // and the row must be re-read before anything is spawned against it.
    task: Task,
    followUp?: string,
    resumeFrom?: Run | null,
    purpose: 'work' | 'publish' = 'work',
  ): Promise<boolean> {
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

    const run = await this.storage.createRun({
      taskId: task.id,
      repoId: repo.id,
      mode: 'worker',
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
      const inv = buildWorkerInvocation({
        task: { ...task, model },
        settings,
        runId: run.id,
        token: runToken,
        callbackUrl: this.callbackUrl,
        artifactsDir,
        followUp,
        dispatchNote: fyi.note,
        resumeSessionId: handoff.kind === 'fresh' ? undefined : resumeFrom?.sessionId ?? undefined,
        previousSummary: handoff.previousSummary,
      });
      const session = this.sessions.spawn({
        runId: run.id,
        cmd: inv.cmd,
        args: inv.args,
        cwd: repo.path,
        env: inv.env,
      });
      const withPid = await this.storage.updateRun(run.id, { pid: session.pty.pid });
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
      { error: null },
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
    await this.storage.appendEvent({
      kind: 'task.publish',
      actor,
      taskId,
      repoId: repo.id,
      data: { phase: 'start' },
    });

    const resumeFrom = await this.findResumableRun(taskId, task.repoId);
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
      ? await verifyPublished(repo)
      : { ok: false, reason: 'task has no repo', branch: null, head: null };
    const updated = await this.storage.transitionTask(taskId, from, check.ok ? 'published' : 'review', actor, {
      error: check.ok ? null : `publish did not complete: ${check.reason}`,
    });
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
    const runs = await this.storage.listRuns({ taskId, status: 'running' });
    for (const run of runs) {
      this.sessions.kill(run.id);
      await this.storage.updateRun(run.id, { status: 'killed', endedAt: new Date().toISOString() });
      await this.storage.appendEvent({ kind: 'run.killed', actor, runId: run.id, taskId });
    }
    const task = await this.storage.transitionTask(taskId, ['running', 'queued'], 'cancelled', actor);
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
    let killed = this.sessions.kill(runId);
    if (!killed) {
      // Analyze runs have no PTY session — kill the execFile child (review R4).
      const run = await this.storage.getRun(runId);
      if (run?.mode === 'analyze' && run.status === 'running') {
        killed = killAnalysis(runId);
      }
    }
    if (killed) {
      const run = await this.storage.updateRun(runId, { status: 'killed', endedAt: new Date().toISOString() });
      await this.storage.appendEvent({ kind: 'run.killed', actor, runId, taskId: run?.taskId ?? null });
      if (run?.taskId) {
        const task = await this.storage.transitionTask(run.taskId, ['running'], 'cancelled', actor);
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
  private async handleExit(runId: string, exitCode: number, tail = ''): Promise<void> {
    // Consumed here whatever happens next: this run is over either way.
    const wasPublish = this.publishRuns.delete(runId);
    this.stallSkipsAudited.delete(runId);
    this.forgetAttention(runId);
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
      const to = exitCode === 0 ? 'review' : 'failed';
      const task = await this.storage.transitionTask(run.taskId, ['running'], to, 'system', {
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
   * still saw a non-empty diff and paid for a full headless run that re-read
   * the previous turn's work. The diff is now hashed and the hash stored on
   * the task: an unchanged hash means there is nothing new to judge, so the
   * previous verdict stands, the task simply stays in `review`, and no
   * `claude -p` is spawned. Both skips are recorded as `run.reviewed` rows
   * carrying `skipped`, so the audit trail shows a decision, not a gap.
   */
  async reviewCompletedRun(taskId: string): Promise<void> {
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
    const p = this.reviewLoop(taskId).finally(() => this.pendingReviews.delete(taskId));
    this.pendingReviews.set(taskId, p);
    return p;
  }

  /**
   * One review round, plus one more pass for a Stop that landed while it ran.
   * Never throws: it runs off the Stop-hook path with nobody to catch it.
   */
  private async reviewLoop(taskId: string): Promise<void> {
    try {
      for (;;) {
        this.reviewRecheck.delete(taskId);
        await this.runReviewRound(taskId);
        if (!this.reviewRecheck.has(taskId)) return;
        // Another pass is only worth it while the task is still parked in
        // review. If the round just started a fix round the task is `running`
        // again and its own Stop will come back through here — reviewing a
        // turn that is still mid-flight would read a half-written diff.
        const t = await this.storage.getTask(taskId);
        if (t?.status !== 'review') return;
      }
    } catch (err) {
      console.error('adversarial review failed:', err);
    } finally {
      this.reviewRecheck.delete(taskId);
    }
  }

  /** One pass of the gate: decide from the diff hash, then review or skip. */
  private async runReviewRound(taskId: string): Promise<void> {
    const task = await this.storage.getTask(taskId);
    if (!task || !task.repoId) return;
    // Only a task that is parked (review, or done under autoComplete) has a
    // change to judge; anything else means a human or a newer turn took over
    // between the Stop and this pass.
    if (task.status !== 'review' && task.status !== 'done') return;
    const settings = await this.storage.getSettings();
    // per-task override wins; null falls back to the global setting
    if (!(task.review ?? settings['review.enabled'])) {
      if (task.reviewState === 'pending') await this.setReviewState(taskId, null);
      return;
    }
    const repo = await this.storage.getRepo(task.repoId);
    if (!repo) return;
    await this.setReviewState(taskId, 'reviewing');

    // One git read per Stop, hashed before truncation; the reviewer reuses it.
    const { diff, hash } = await workerDiff(repo);
    if (!hash) {
      // Read-only turn on a clean tree — the old code returned silently here.
      await this.storage.appendEvent({
        kind: 'run.reviewed',
        actor: 'system',
        taskId,
        repoId: repo.id,
        data: { skipped: 'empty-diff', state: 'skipped' },
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
        data: { skipped: 'unchanged-diff', state },
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
      settings['review.model'],
      diff,
      fixRound > 0 && lastRound ? { fixRound, findings: lastRound.findings } : null,
    );
    if (!result) return;

    // work → review → work: hand blocker/major findings back to the SAME live
    // worker session to fix, then it Stops and re-reviews. Bounded rounds so
    // an unfixable finding can't loop forever; minor-only or clean lands in
    // the human review queue as before. Decided BEFORE the row is written so
    // the round, the summary and the state land in one broadcast.
    const actionable = result.findings.filter((f) => f.severity === 'blocker' || f.severity === 'major');
    const maxRounds = settings['review.maxRounds'];
    const current = await this.storage.getTask(taskId);
    const canLoop =
      actionable.length > 0 &&
      fixRound < maxRounds &&
      current?.status === 'review' && // human hasn't taken over
      (await this.hasLiveSession(taskId));
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
      error: result.error,
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
      this.fixRounds.delete(taskId); // loop settled (clean, minors, cap, or human took over)
    }
  }

  /** Persist + broadcast a review-state change; a no-op when it already reads that way. */
  private async setReviewState(taskId: string, state: ReviewState | null): Promise<void> {
    const cur = await this.storage.getTask(taskId);
    if (!cur || cur.reviewState === state) return;
    const updated = await this.storage.updateTask(taskId, { reviewState: state });
    if (updated) broadcast({ type: 'task.updated', task: updated });
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
    const flagged = this.attentionAt.get(runId);
    if (flagged === undefined) return;
    const t = Date.parse(at);
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
  }

  /**
   * A task reached a terminal status — re-evaluate everything that waits on it:
   * its split parent (all-children-resolve semantics) and, when it belongs to a
   * feature, that feature's phase gate. Both are independent: a feature task
   * may also be a split parent.
   */
  async resolveCompletion(child: Task, actor = 'system'): Promise<void> {
    if (child.parentId) {
      const settings = await this.storage.getSettings();
      const parentDone = settings['orchestrator.autoComplete'] ? 'done' : 'review';
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
