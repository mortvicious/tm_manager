import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, Dispatch, Run, Task, TaskStatus } from '@tm/shared';
import type { ActionResult, OrchestratorApi } from './app-types.ts';
import { DEFAULT_PROCEED, PUBLISH_INSTRUCTION, buildDispatchTurn, buildWorkerInvocation } from './claude/worker.ts';
import { publishRepo, verifyPublished } from './git.ts';
import { killAnalysis } from './claude/analyze.ts';
import { liveHeadless } from './claude/headless.ts';
import { reviewWorkerChange } from './claude/review.ts';
import { summarizeRun, summarizeTranscript } from './claude/stats.ts';
import { needsFallbackModel, sessionUsagePct } from './claude/usage.ts';
import { broadcast } from './events.ts';
import { MAX_LIVE_SESSIONS, pidLooksLikeOurs, type SessionManager } from './pty/session-manager.ts';
import { artifactsRoot } from './config.ts';
import type { Storage } from './storage/types.ts';

/** Upper bound on how long a custom-queue hold may outlive its follow-on (docs/queue.md). */
const CUSTOM_QUEUE_HOLD_TTL_MS = 30 * 60_000;

export class Orchestrator implements OrchestratorApi {
  private scheduling = false;
  private rescheduleRequested = false;
  /** per-task adversarial-review round counter (work→review→work loop). */
  private reviewRounds = new Map<string, number>();
  /**
   * Tasks whose adversarial review round is in flight RIGHT NOW. The Telegram
   * notifier consults this to hold its bare "in review" ping while a verdict
   * is still minutes away — the alternative (predicting from settings) would
   * silence entry paths that never run a review (docs/telegram.md).
   */
  private readonly pendingReviews = new Set<string>();
  /** runs whose turn is a PUBLISH turn (docs/publish.md): their Stop must land
   *  the task in `published`, not in the human review queue. */
  private publishRuns = new Set<string>();
  /** single-flight guard for dispatch delivery (docs/dispatch.md) — the route
   *  and the scheduler may both ask for a sweep at once. */
  private deliveringDispatches = false;
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

  constructor(
    private storage: Storage,
    private sessions: SessionManager,
    private callbackUrl: string,
  ) {
    this.sessions.onExit((info) => {
      void this.handleExit(info.runId, info.exitCode);
    });
    // Safety tick: event-driven scheduling with a slow fallback.
    setInterval(() => this.maybeSchedule(), 10_000).unref();
    // Live stats: refresh cost/tokens/ctx% of ACTIVE worker runs mid-run so
    // the UI updates in real time, not only at Stop/exit.
    setInterval(() => {
      void this.refreshLiveStats();
    }, 20_000).unref();
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
          });
          if (task) await this.resolveCompletion(task, 'system');
        }
      }
    }
    if (orphans.length) {
      await this.storage.appendEvent({
        kind: 'boot.recovery',
        actor: 'system',
        data: { swept: orphans.length },
      });
      console.log(`boot recovery: swept ${orphans.length} run(s)`);
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

  private activeWorkers(): number {
    return this.sessions.liveCount();
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
        const settle = async (status: 'delivered' | 'failed', note: string | null) => {
          for (const d of list) {
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
          await settle('failed', 'target task no longer exists');
          continue;
        }
        if (!target.repoId) {
          await settle('failed', 'target task has no repo');
          continue;
        }
        // Hold (retry later): mid-turn / about to start / waiting on children.
        if (['running', 'queued', 'blocked'].includes(target.status)) continue;
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
        // Never resume an agent into a repo another agent is actively editing.
        if (await this.repoBusy(target.repoId)) continue;
        // Delivery starts a real agent turn — it respects worker concurrency.
        if (this.sessions.liveCount() >= settings['orchestrator.concurrency']) break;

        const items: { fromTitle: string; fromTaskId: string; message: string }[] = [];
        for (const d of list) {
          const from = await this.storage.getTask(d.fromTaskId);
          items.push({ fromTitle: from?.title ?? '(deleted task)', fromTaskId: d.fromTaskId, message: d.message });
        }
        const res = await this.followUp(taskId, buildDispatchTurn(items), 'dispatch');
        if ('error' in res) continue; // raced with a claim/human action — hold and retry
        await settle('delivered', null);
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

  /** Spawns the PTY for a task already in `running`. Reverts the claim on failure.
   *  `purpose: 'publish'` marks the run as the commit-and-push turn so its Stop
   *  is settled against git instead of parking the task in review. */
  private async startWorker(
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
    const baseline =
      resumeFrom?.transcriptPath && fs.existsSync(resumeFrom.transcriptPath)
        ? (await summarizeTranscript(resumeFrom.transcriptPath, resumeFrom.model))?.stats ?? null
        : null;
    const run = await this.storage.createRun({
      taskId: task.id,
      repoId: repo.id,
      mode: 'worker',
      model,
      effort: task.effort ?? settings['agent.effort'],
      runToken,
      resumedFrom: resumeFrom?.id ?? null,
      statsBaseline: baseline,
    });
    if (purpose === 'publish') this.publishRuns.add(run.id);
    try {
      const artifactsDir = path.join(artifactsRoot, task.id);
      fs.mkdirSync(artifactsDir, { recursive: true });
      const inv = buildWorkerInvocation({
        task: { ...task, model },
        settings,
        runId: run.id,
        token: runToken,
        callbackUrl: this.callbackUrl,
        artifactsDir,
        followUp,
        resumeSessionId: resumeFrom?.sessionId ?? undefined,
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
          resumedFrom: resumeFrom?.id ?? null,
          sessionId: resumeFrom?.sessionId ?? null,
        },
      });
      broadcast({ type: 'run.started', run: withPid ?? run });
      broadcast({ type: 'task.updated', task });
      // The status was only broadcast on toggle and on EXIT, so the header's
      // "running n/2" (and the restart guard that reads it) stayed stale for a
      // whole session after a spawn.
      broadcast({ type: 'orchestrator.status', status: await this.status() });
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
    this.reviewRounds.delete(taskId); // fresh loop budget for this attempt
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
    return this.followUp(taskId, message, actor);
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

  /** PTY exited. Hook-driven completion (Phase 4) usually resolved the task already. */
  private async handleExit(runId: string, exitCode: number): Promise<void> {
    // Consumed here whatever happens next: this run is over either way.
    const wasPublish = this.publishRuns.delete(runId);
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
      });
      if (task) {
        broadcast({ type: 'task.updated', task });
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
   */
  async reviewCompletedRun(taskId: string): Promise<void> {
    // Set synchronously on call (the hook route fires this void, milliseconds
    // after the running → review transition), cleared however the round ends.
    this.pendingReviews.add(taskId);
    try {
      const task = await this.storage.getTask(taskId);
      if (!task || !task.repoId) return;
      const settings = await this.storage.getSettings();
      // per-task override wins; null falls back to the global setting
      if (!(task.review ?? settings['review.enabled'])) return;
      const repo = await this.storage.getRepo(task.repoId);
      if (!repo) return;
      const result = await reviewWorkerChange(repo, task, settings['review.model']);
      if (!result) return;
      const updated = await this.storage.updateTask(taskId, { reviewSummary: result.markdown });
      if (updated) broadcast({ type: 'task.updated', task: updated });
      await this.storage.appendEvent({
        kind: 'run.reviewed',
        actor: 'system',
        taskId,
        repoId: repo.id,
        data: { model: result.model, verdict: result.verdict, findings: result.findings.length },
      });

      // work → review → work: hand blocker/major findings back to the SAME live
      // worker session to fix, then it Stops and re-reviews. Bounded rounds so
      // an unfixable finding can't loop forever; minor-only or clean lands in
      // the human review queue as before.
      const actionable = result.findings.filter((f) => f.severity === 'blocker' || f.severity === 'major');
      const maxRounds = settings['review.maxRounds'];
      const round = this.reviewRounds.get(taskId) ?? 0;
      const current = await this.storage.getTask(taskId);
      const canLoop =
        actionable.length > 0 &&
        round < maxRounds &&
        current?.status === 'review' && // human hasn't taken over
        (await this.hasLiveSession(taskId));

      if (canLoop) {
        this.reviewRounds.set(taskId, round + 1);
        const msg = [
          `Adversarial review (round ${round + 1}) found ${actionable.length} issue(s) to fix before this task is done:`,
          ...actionable.map((f) => `- [${f.severity}] ${f.summary}${f.detail ? ` — ${f.detail}` : ''}`),
          `Fix the blocker/major items above (address minors if quick), then finish. Your fix will be re-reviewed.`,
        ].join('\n');
        await this.storage.appendEvent({
          kind: 'task.follow-up',
          actor: 'system',
          taskId,
          repoId: repo.id,
          data: { reason: 'adversarial-review', round: round + 1, actionable: actionable.length },
        });
        await this.followUp(taskId, msg, 'system'); // reactivates the idle session → running
      } else {
        this.reviewRounds.delete(taskId); // loop settled (clean, minors, cap, or human took over)
      }
    } catch (err) {
      console.error('adversarial review failed:', err);
    } finally {
      this.pendingReviews.delete(taskId);
    }
  }

  /** Is an adversarial review round in flight for this task right now? */
  isReviewPending(taskId: string): boolean {
    return this.pendingReviews.has(taskId);
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
