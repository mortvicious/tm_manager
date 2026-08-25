import type { FastifyInstance } from 'fastify';
import { summarizeRun } from '../claude/stats.ts';
import { broadcast } from '../events.ts';
import type { Orchestrator } from '../orchestrator.ts';
import type { SessionManager } from '../pty/session-manager.ts';
import type { Storage } from '../storage/types.ts';

// Lifecycle hook callbacks from inside worker claude sessions. The hook curl
// forwards the hook's stdin JSON (session_id, transcript_path, ...) as body.
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
  app.post('/api/internal/runs/:id/stop', async (req) => {
    const { id } = req.params as { id: string };
    // Stale-hook guard (review R3a): a user chatting in an OLD idle session
    // fires Stops that must never touch the task again — especially not while
    // a NEWER run is working on it.
    if (sessions.isIdle(id)) return { ok: true };
    const preRun = await storage.getRun(id);
    if (preRun?.taskId) {
      const latest = (await storage.listRuns({ taskId: preRun.taskId }))[0];
      if (latest && latest.id !== id) return { ok: true };
    }
    // The final assistant message may not be flushed to the transcript yet
    // when the Stop hook fires — give the writer a moment (observed in test).
    await new Promise((r) => setTimeout(r, 1500));
    // Re-check after the sleep: a kill→retry→claim can complete inside it (M1).
    if (sessions.isIdle(id)) return { ok: true };
    if (preRun?.taskId) {
      const latest = (await storage.listRuns({ taskId: preRun.taskId }))[0];
      if (latest && latest.id !== id) return { ok: true };
    }
    const info = await recordRunInfo(id, req.body);
    if (!info) return { ok: false };
    const run = info.run;

    if (run.needsAttention) {
      const cleared = await storage.updateRun(id, { needsAttention: false });
      if (cleared) broadcast({ type: 'run.needs-attention', run: cleared });
    }

    if (run.taskId && run.mode === 'worker') {
      const settings = await storage.getSettings();
      const to = settings['orchestrator.autoComplete'] ? 'done' : 'review';
      const patch = info.lastAssistantText ? { resultSummary: info.lastAssistantText.slice(0, 4000) } : undefined;
      const task = await storage.transitionTask(run.taskId, ['running'], to, 'hook', patch);
      if (task) {
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
        // Adversarial review of the change, off the hook path (don't block the
        // curl; the worker's turn is already done).
        void orchestrator.reviewCompletedRun(run.taskId);
      }
    }
    return { ok: true };
  });

  // Session started — record session identity right away (feeds live stats).
  app.post('/api/internal/runs/:id/session-start', async (req) => {
    const { id } = req.params as { id: string };
    await recordRunInfo(id, req.body, { skipSummarize: true });
    return { ok: true };
  });

  // Session ended (process exiting) — final stats snapshot; PTY exit handling
  // in the orchestrator covers status transitions.
  app.post('/api/internal/runs/:id/session-end', async (req) => {
    const { id } = req.params as { id: string };
    await recordRunInfo(id, req.body);
    return { ok: true };
  });

  // Notification hook: permission prompt / idle in a hidden terminal.
  app.post('/api/internal/runs/:id/needs-attention', async (req) => {
    const { id } = req.params as { id: string };
    // Completed-idle sessions fire ~60s idle-prompt notifications forever —
    // those are noise, not "needs attention" (user report + review M3).
    if (sessions.isIdle(id)) return { ok: true };
    await recordRunInfo(id, req.body, { skipSummarize: true });
    const run = await storage.getRun(id);
    if (run && run.status === 'running' && !run.idle && !run.needsAttention) {
      const updated = await storage.updateRun(id, { needsAttention: true });
      if (updated) {
        await storage.appendEvent({ kind: 'run.attention', actor: 'hook', runId: id, taskId: updated.taskId });
        broadcast({ type: 'run.needs-attention', run: updated });
      }
    }
    return { ok: true };
  });
}
