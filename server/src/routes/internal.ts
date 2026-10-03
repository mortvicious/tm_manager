import type { ReviewState } from '@tm/shared';
import type { FastifyInstance } from 'fastify';
import { aux } from '../claude/aux.ts';
import { summarizeRun } from '../claude/stats.ts';
import { shipHeldForReview } from '../claude/worker.ts';
import { broadcast } from '../events.ts';
import type { Orchestrator } from '../orchestrator.ts';
import type { SessionManager } from '../pty/session-manager.ts';
import type { Storage } from '../storage/types.ts';
import { hookDecision } from '../questions.ts';

// Lifecycle hook callbacks from inside worker claude sessions. The hook curl
// forwards the hook's stdin JSON (session_id, transcript_path, ...) as body.
/** Total size of `result_summary` after fix-round notes are appended. */
const RESULT_SUMMARY_MAX = 12_000;
const FIX_NOTE_MARK = '\n\n---\n**Fix round ';

/**
 * `original` + a "Fix round N" section. When the whole exceeds the cap, the
 * OLDEST fix notes are dropped (never the original account of the work).
 */
export function appendFixNote(original: string, note: string, round: number): string {
  const [base, ...notes] = original.split(FIX_NOTE_MARK);
  const next = [...notes, `${round}:** ${note}`];
  let out = base + next.map((n) => FIX_NOTE_MARK + n).join('');
  while (out.length > RESULT_SUMMARY_MAX && next.length > 1) {
    next.shift();
    out = base + next.map((n) => FIX_NOTE_MARK + n).join('');
  }
  return out.slice(0, RESULT_SUMMARY_MAX);
}

/**
 * The CLI's own list of this session's background subagents still out, as
 * Stop and SubagentStop payloads carry it (`background_tasks: [{ id, type,
 * status, … }]`, measured on 2.1.266). Only `subagent` entries are
 * children; background shells are read separately (`runningShells`), because
 * a shell has no stop hook and may never end. null when the payload has no
 * such list (an older CLI): the caller falls back to the hook count.
 */
export function runningSubagents(body: unknown): string[] | null {
  return runningBackground(body, 'subagent');
}

/**
 * The same list's still-running background SHELLS (`run_in_background` Bash:
 * `{ id, type: 'shell', status: 'running', command, description }`, measured
 * on the real CLI). They hold a task in `waiting` only for a bounded time —
 * see `Orchestrator.waitDecision`. null when the payload has no list.
 */
export function runningShells(body: unknown): string[] | null {
  return runningBackground(body, 'shell');
}

function runningBackground(body: unknown, kind: 'subagent' | 'shell'): string[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const list = (body as Record<string, unknown>).background_tasks;
  if (!Array.isArray(list)) return null;
  const ids: string[] = [];
  for (const t of list) {
    if (typeof t !== 'object' || t === null) continue;
    const { id, type, status } = t as Record<string, unknown>;
    if (type !== kind || typeof id !== 'string' || !id) continue;
    if (status === 'running' || status === 'pending') ids.push(id);
  }
  return ids;
}

export function registerInternalRoutes(
  app: FastifyInstance,
  storage: Storage,
  sessions: SessionManager,
  orchestrator: Orchestrator,
) {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/internal/')) return;
    const token = String(req.headers['x-tm-token'] ?? '');
    // Per-run token ONLY (agent-API review R5 + impl review F1): the token IS
    // the identity, and the master session token is deliberately NOT accepted —
    // any worker can fetch /api/session, so a master-token branch would let it
    // forge other runs' hooks.
    const run = await storage.getRunByToken(token);
    const m = req.url.match(/^\/api\/internal\/runs\/([^/]+)\//);
    if (!run || !m || run.id !== decodeURIComponent(m[1])) {
      return reply.code(403).send({ error: 'forbidden' });
    }
  });

  const readHookBody = (body: unknown): { sessionId?: string; transcriptPath?: string } => {
    if (typeof body !== 'object' || body === null) return {};
    const b = body as Record<string, unknown>;
    return {
      sessionId: typeof b.session_id === 'string' ? b.session_id : undefined,
      transcriptPath: typeof b.transcript_path === 'string' ? b.transcript_path : undefined,
    };
  };

  /** Persist session identity (+ fresh stats unless skipped); returns the updated run. */
  const recordRunInfo = async (runId: string, body: unknown, opts?: { skipSummarize?: boolean }) => {
    const { sessionId, transcriptPath } = readHookBody(body);
    const run = await storage.getRun(runId);
    if (!run) return null;
    const patch: Parameters<Storage['updateRun']>[1] = {};
    if (sessionId && !run.sessionId) patch.sessionId = sessionId;
    if (transcriptPath && !run.transcriptPath) patch.transcriptPath = transcriptPath;
    const tp = transcriptPath ?? run.transcriptPath;
    let lastAssistantText: string | null = null;
    // A permission-prompt storm fires Notification repeatedly — don't re-read
    // a potentially huge transcript for those (review M3).
    if (tp && !opts?.skipSummarize) {
      // summarizeRun, not summarizeTranscript: a resumed run shares the earlier
      // session's transcript and must report only its own delta.
      const summary = await summarizeRun(run, tp);
      if (summary) {
        patch.stats = summary.stats;
        lastAssistantText = summary.lastAssistantText;
      }
    }
    const updated = Object.keys(patch).length ? await storage.updateRun(runId, patch) : run;
    return { run: updated ?? run, lastAssistantText };
  };

  // First Stop after spawn = the agent finished its turn → task leaves
  // `running`. Later Stops (user chatting in the attached terminal) no-op via
  // the conditional transition.
  //
  // `replayOf` is set when no hook fired at all: a park held by background
  // shells ran out of wait budget (`agent.shellWaitMinutes`) and the
  // orchestrator hands the park's own payload back, stamped with when the
  // park began. The same decision is taken again — it lands the turn unless
  // something still counts — but only for THAT park: nothing about the turn
  // itself is new (no flush sleep, no attention/question sweep, which belong
  // to a real turn end), and the landing accepts `waiting` alone, so a
  // session that started talking meanwhile is never landed under its feet.
  const settleStop = async (id: string, body: unknown, replayOf: number | null): Promise<{ ok: boolean }> => {
    // Stale-hook guard (review R3a): a user chatting in an OLD idle session
    // fires Stops that must never touch the task again — especially not while
    // a NEWER run is working on it.
    if (sessions.isIdle(id)) return { ok: true };
    const preRun = await storage.getRun(id);
    if (preRun?.taskId) {
      const latest = (await storage.listRuns({ taskId: preRun.taskId }))[0];
      if (latest && latest.id !== id) return { ok: true };
    }
    if (replayOf === null) {
      // The final assistant message may not be flushed to the transcript yet
      // when the Stop hook fires — give the writer a moment (observed in test).
      await new Promise((r) => setTimeout(r, 1500));
      // Re-check after the sleep: a kill→retry→claim can complete inside it (M1).
      if (sessions.isIdle(id)) return { ok: true };
      if (preRun?.taskId) {
        const latest = (await storage.listRuns({ taskId: preRun.taskId }))[0];
        if (latest && latest.id !== id) return { ok: true };
      }
    }
    const info = await recordRunInfo(id, body);
    if (!info) return { ok: false };
    const run = info.run;

    if (replayOf !== null) {
      // A flag raised during the park means the session is mid-turn and
      // blocked on a human — its turn end is still to come, as a real Stop.
      if (run.needsAttention) return { ok: true };
    } else {
      if (run.needsAttention) {
        const cleared = await storage.updateRun(id, { needsAttention: false });
        if (cleared) broadcast({ type: 'run.needs-attention', run: cleared });
      }
      // The turn is over, so a question of this run that is still pending was
      // abandoned (Esc in an attached terminal cancels the waiting hook) — the
      // human must not keep being asked (docs/questions.md).
      await orchestrator.questions.expireForRun(id, 'the agent finished its turn without the answer');
    }

    if (run.taskId && run.mode === 'worker') {
      const settings = await storage.getSettings();
      // A publish turn always lands in `review` first; settlePublish below
      // then moves it to `published` if git agrees the work really is pushed.
      const publishRun = orchestrator.isPublishRun(id);
      const pre = await storage.getTask(run.taskId);
      // `waiting` (docs/design.md § Waiting): Stop fires at the end of EVERY
      // turn, including one the agent ends with a background subagent of its
      // own still running — the CLI re-invokes the session when that child
      // returns, so this is a pause inside the work, not its end. Landing it
      // handed a half-done tree to the reviewer ("nothing implemented",
      // blocker, fix round) and told the human "review" about a task whose
      // own summary said it was still waiting. Park it instead: no review, no
      // idling (the session keeps its slot and its repo — it is about to work
      // again), the agent's last words as the summary so the panel says what
      // it waits for. A publish turn is never parked: its Stop is settled by
      // git. The decision is taken AFTER the flush sleep above, so a child
      // that returned during it counts as returned. The payload's own
      // `background_tasks` decides whether children are out whenever the CLI
      // sends it; the hook count is only the fallback (it was fooled by the
      // CLI's helper agents, which stop without ever starting).
      // Background SHELLS hold the park too, each for a bounded time
      // (`waitDecision`): a turn ended "waiting for Lighthouse to finish"
      // was landed, reviewed, and its fix round killed the PTY — and the
      // shell with it — before the agent ever saw the numbers.
      const shellWaitMs = settings['agent.shellWaitMinutes'] * 60_000;
      const wait = !publishRun
        ? orchestrator.waitDecision(id, runningSubagents(body), runningShells(body), shellWaitMs)
        : { children: 0, shells: 0, shellDeadline: null, snapshot: '', stale: false };
      if ((wait.children > 0 && !wait.stale) || wait.shells > 0) {
        if (replayOf !== null) {
          // Still held (a later shell's budget, or a child still out): the
          // same park goes on, now timed to the next deadline if any.
          orchestrator.rearmShellWait(id, replayOf, wait.shellDeadline);
          return { ok: true };
        }
        const parked = await storage.transitionTask(run.taskId, ['running', 'waiting'], 'waiting', 'hook', {
          reviewState: null,
          ...(info.lastAssistantText ? { resultSummary: info.lastAssistantText.slice(0, 4000) } : {}),
        });
        if (parked) {
          const list = (body as { background_tasks?: unknown } | null)?.background_tasks;
          orchestrator.parkedWaiting(id, parked.id, wait.snapshot, wait.shellDeadline, { background_tasks: list });
          await storage.appendEvent({
            kind: 'task.waiting',
            actor: 'hook',
            runId: id,
            taskId: parked.id,
            repoId: parked.repoId,
            data: { children: wait.children, ...(wait.shells > 0 ? { shells: wait.shells } : {}) },
          });
          broadcast({ type: 'task.updated', task: parked });
          broadcast({ type: 'orchestrator.status', status: await orchestrator.status() });
        }
        return { ok: true };
      }
      if (replayOf !== null) {
        // Nothing counts any more. Only for the park that armed the timer —
        // a newer one (a Stop that re-parked meanwhile) has its own.
        if (orchestrator.parkedAt(id) !== replayOf) return { ok: true };
      }
      if (wait.stale) {
        await storage.appendEvent({
          kind: 'task.waiting',
          actor: 'hook',
          runId: id,
          taskId: run.taskId,
          repoId: run.repoId,
          data: { children: wait.children, stale: true },
        });
      }
      // auto-publish overrides auto-complete: the task must pass THROUGH
      // review so the publish turn has something to pick up.
      const to = !publishRun && settings['orchestrator.autoComplete'] && !pre?.autoPublish ? 'done' : 'review';
      // Whether the reviewer WILL look at this landing, decided here so the
      // row that says `review` also says `pending` — a surface that reads the
      // status alone can never mistake an unreviewed change for a reviewed
      // one. Everything else (publish turns, auto-publish, review off) is
      // simply not auto-reviewed: null. The same test decides whether the
      // worker's prompt held the push back for this review (shipHeldForReview).
      const willReview =
        !publishRun && shipHeldForReview({ review: pre?.review ?? null, autoPublish: pre?.autoPublish ?? false }, settings);
      const patch: { resultSummary?: string; reviewState: ReviewState | null } = {
        reviewState: willReview ? 'pending' : null,
      };
      if (info.lastAssistantText) {
        const text = info.lastAssistantText.slice(0, 4000);
        // A fix round's last message is "fixed 1 and 2" — appended under the
        // original account of the work, never in its place, so the summary
        // keeps saying what was built. Bounded: the oldest fix notes give
        // way first, the original stays.
        patch.resultSummary =
          pre?.reviewState === 'fixing' && pre.resultSummary
            ? appendFixNote(pre.resultSummary, text, pre.reviewRounds.length)
            : text;
      }
      // Custom queue (docs/queue.md): the task is about to leave `running`,
      // but a review fix round or the auto-publish turn may reopen it — hold
      // the queue until whichever follow-on runs below has decided. The hold
      // is released on EVERY exit from this block except the hand-off to a
      // follow-on (which releases in its own finally), so a throw anywhere in
      // between cannot leave the queue frozen (review R4); the orchestrator
      // also expires holds on its own as a last resort.
      const taskId = run.taskId;
      orchestrator.holdCustomQueue(taskId);
      const release = () => orchestrator.releaseCustomQueue(taskId);
      let handedOff = false;
      try {
      // `waiting` too: a lost SubagentStop hook (the `stale` case above) or
      // a transcript line the watcher has not polled yet leaves the row
      // parked at the moment the agent's real last turn ends. A replay lands
      // `waiting` only: a session that went back to work is not its to land.
      const task = await storage.transitionTask(
        run.taskId,
        replayOf !== null ? ['waiting'] : ['running', 'waiting'],
        to,
        replayOf !== null ? 'system' : 'hook',
        patch,
      );
      if (task) {
        orchestrator.dropWait(id);
        if (replayOf !== null) {
          // the shell(s) outlived their budget — a decision, not a gap
          await storage.appendEvent({
            kind: 'task.waiting',
            actor: 'system',
            runId: id,
            taskId: task.id,
            repoId: task.repoId,
            data: { expired: 'shell-wait', waitedMs: Date.now() - replayOf },
          });
        }
        broadcast({ type: 'task.updated', task });
        sessions.markIdle(id); // frees the concurrency slot; PTY stays attachable
        const idled = await storage.updateRun(id, { idle: true, needsAttention: false });
        if (idled) {
          broadcast({ type: 'run.exited', run: idled }); // upserts client-side
          // workedMs stops at first idle — chat-idle time is not work (dashboard A3)
          await storage.appendEvent({
            kind: 'run.stats-final',
            actor: 'hook',
            runId: id,
            taskId: idled.taskId,
            repoId: idled.repoId,
            data: {
              workedMs: Date.now() - Date.parse(idled.startedAt),
              costUsd: idled.stats?.costUsd ?? 0,
              tokens: (idled.stats?.inputTokens ?? 0) + (idled.stats?.outputTokens ?? 0),
              contextPct: idled.stats?.contextPct ?? 0,
              model: idled.model,
              mode: idled.mode,
            },
          });
        }
        await orchestrator.resolveCompletion(task, 'hook');
        broadcast({ type: 'orchestrator.status', status: await orchestrator.status() });
        orchestrator.maybeSchedule();
        // All three land off the hook path — the worker's turn is already done
        // and the curl must not wait on git or on another agent.
        handedOff = true;
        if (publishRun) {
          // the agent said it pushed; git decides whether it did
          void orchestrator.settlePublish(run.taskId, ['review'], 'hook').finally(release);
        } else if (task.autoPublish) {
          // "allow auto-publish on end": no human gate, and no adversarial
          // review round either — straight from finished to shipped.
          void orchestrator.publish(run.taskId, 'system').finally(release);
        } else {
          void orchestrator.reviewCompletedRun(run.taskId).finally(release);
        }
      }
      } finally {
        if (!handedOff) release();
      }
    }
    return { ok: true };
  };

  // Aux sessions (review, plan, chat, … — docs/design.md § PTY sessions)
  // share these routes and the per-run token guard, but none of the worker
  // logic below: their hooks go to the aux runner, which decides the result.
  // Checked by the run's mode, never by whether a runner entry exists, so a
  // late hook from an aux session that already settled is swallowed here
  // rather than mistaken for a worker's.
  const auxHook = async (
    id: string,
    event: Parameters<ReturnType<typeof aux>['hook']>[1],
    body: unknown,
  ): Promise<boolean> => {
    const run = await storage.getRun(id);
    if (run?.mode !== 'aux') return false;
    await aux().hook(id, event, body);
    return true;
  };

  app.post('/api/internal/runs/:id/stop', async (req) => {
    const { id } = req.params as { id: string };
    if (await auxHook(id, 'stop', req.body)) return { ok: true };
    return settleStop(id, req.body, null);
  });
  // StopFailure — the API refused the turn (`model_not_found`, rate limit,
  // …). Only aux sessions inject it: it is how an unavailable reviewer model
  // reaches the Fable→Opus fallback now that there is no `-p` envelope.
  app.post('/api/internal/runs/:id/stop-failure', async (req) => {
    const { id } = req.params as { id: string };
    await auxHook(id, 'stop-failure', req.body);
    return { ok: true };
  });
  orchestrator.onShellWaitExpired(async (runId, body, parkedAt) => {
    await settleStop(runId, body, parkedAt);
  });

  // SubagentStart / SubagentStop (docs/design.md § Waiting): the count of a
  // run's own children still out, which is what turns a Stop into a park.
  // Fire-and-forget on the CLI side; `agent_id` is the child's instance id.
  app.post('/api/internal/runs/:id/subagent-start', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { agent_id?: unknown };
    orchestrator.subagentStarted(id, typeof body.agent_id === 'string' && body.agent_id ? body.agent_id : null);
    return { ok: true };
  });
  app.post('/api/internal/runs/:id/subagent-stop', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { agent_id?: unknown };
    await orchestrator.subagentStopped(
      id,
      typeof body.agent_id === 'string' && body.agent_id ? body.agent_id : null,
      runningSubagents(req.body),
    );
    return { ok: true };
  });

  // Session started — record session identity right away (feeds live stats).
  app.post('/api/internal/runs/:id/session-start', async (req) => {
    const { id } = req.params as { id: string };
    if (await auxHook(id, 'session-start', req.body)) return { ok: true };
    await recordRunInfo(id, req.body, { skipSummarize: true });
    return { ok: true };
  });

  // Session ended (process exiting) — final stats snapshot; PTY exit handling
  // in the orchestrator covers status transitions.
  app.post('/api/internal/runs/:id/session-end', async (req) => {
    const { id } = req.params as { id: string };
    if (await auxHook(id, 'session-end', req.body)) return { ok: true };
    await recordRunInfo(id, req.body);
    return { ok: true };
  });

  // PreToolUse hook on AskUserQuestion (docs/questions.md): the agent's
  // question, carried to the human. The hook POSTs its stdin (tool_input +
  // tool_use_id) and holds for up to `waitMs`; the answer comes back as the
  // hook's decision JSON, and a still-pending question answers `pending` so the
  // hook's loop re-sends the same body — idempotent on tool_use_id, so the
  // re-send finds its row rather than filing a second question.
  app.post('/api/internal/runs/:id/question', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await storage.getRun(id);
    if (!run) return reply.code(404).send({ error: 'no such run' });
    // An idle (finished) or dead run cannot be asking anything — a stale hook.
    if (run.status !== 'running' || run.idle) {
      return reply.code(409).send({ error: 'run is not working' });
    }
    const asked = await orchestrator.questions.ask(run, req.body);
    if ('error' in asked) return reply.code(400).send({ error: asked.error });
    const { waitMs } = req.query as { waitMs?: string };
    const q = (await orchestrator.questions.wait(asked.question.id, Number(waitMs) || 0)) ?? asked.question;
    if (q.status === 'pending') return { pending: true, id: q.id };
    return hookDecision(q);
  });

  // Notification hook: permission prompt / idle in a hidden terminal.
  app.post('/api/internal/runs/:id/needs-attention', async (req) => {
    const { id } = req.params as { id: string };
    if (await auxHook(id, 'notification', req.body)) return { ok: true };
    // Completed-idle sessions fire ~60s idle-prompt notifications forever —
    // those are noise, not "needs attention" (user report + review M3).
    if (sessions.isIdle(id)) return { ok: true };
    await recordRunInfo(id, req.body, { skipSummarize: true });
    const run = await storage.getRun(id);
    if (run && run.status === 'running' && !run.idle && !run.needsAttention) {
      const updated = await storage.updateRun(id, { needsAttention: true });
      if (updated) {
        // Stamped BEFORE the row is announced: the activity watcher may report
        // the very next transcript line within a second, and the tracker has
        // to know the flag's time to tell "answered" from "still catching up".
        orchestrator.attentionFlagged(id);
        await storage.appendEvent({ kind: 'run.attention', actor: 'hook', runId: id, taskId: updated.taskId });
        broadcast({ type: 'run.needs-attention', run: updated });
      }
    }
    return { ok: true };
  });
}
