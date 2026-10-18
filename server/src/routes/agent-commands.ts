import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CommandRun, Repo, RepoCommand, Run } from '@tm/shared';
import { broadcast } from '../events.ts';
import { parseCommandLine, resolveCommandCwd } from '../commands/parse.ts';
import type { CommandRunner } from '../commands/runner.ts';
import type { Storage } from '../storage/types.ts';

// The agent side of repo commands (docs/commands.md § Agent API). A worker
// that needs a dev server uses the repo's SAVED command, run in the commands
// pool, instead of a background shell of its own: one server per command,
// shared by every agent and the human, visible in the header launcher, and
// never holding the agent's own turn in `waiting` (agent.shellWaitMinutes).
//
// Reach: list / start / logs work on any registered repo's commands (a
// frontend agent may need the backend's API up). Restart needs the caller's
// own repo or a run its task started; stop needs a run its task started —
// a server someone else started is shared, and stopping it under them is
// exactly the surprise this API exists to prevent.

/** Command definitions one worker session may add — a spam guard, not a budget. */
export const AGENT_COMMAND_DEFINE_CAP = 3;
/** Longest a start/restart may hold the request waiting for a ready line. */
const WAIT_MAX_MS = 60_000;
/** Output returned with a start/restart, and the default for /logs. */
const TAIL_BYTES = 4_000;
const LOGS_MAX_BYTES = 64_000;
/** How far back a ready line is searched — a reused server printed it long ago. */
const READY_SCAN_BYTES = 256_000;
/** Stop → exit, bounded: SessionManager.kill escalates to SIGKILL after 5s. */
const RESTART_EXIT_MS = 8_000;

const defineBody = z
  .object({
    name: z.string().min(1).max(80),
    command: z.string().min(1).max(500),
    kind: z.enum(['task', 'service']).optional(),
    cwd: z.string().max(200).nullish(),
  })
  .strict();

const startBody = z
  .object({
    /** case-insensitive substrings; the request returns once any appears in the output */
    waitFor: z.union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(1).max(5)]).optional(),
    waitMs: z.number().int().min(0).max(WAIT_MAX_MS).optional(),
  })
  .strict();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function registerAgentCommandRoutes(
  app: FastifyInstance,
  storage: Storage,
  runner: CommandRunner,
  authRun: (req: FastifyRequest) => Promise<Run | null>,
) {
  /** Definitions added per worker run (in memory: a run does not outlive the process). */
  const defined = new Map<string, number>();
  const actorOf = (run: Run) => `agent:${run.id.slice(0, 8)}`;

  const runBrief = (r: CommandRun | undefined) =>
    r
      ? {
          id: r.id,
          status: r.status,
          pid: r.pid,
          exitCode: r.exitCode,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
          startedBy: r.startedBy,
          ownerTaskId: r.ownerTaskId,
        }
      : null;

  const commandBrief = (c: RepoCommand, repo: Repo | undefined, run: Run) => {
    const latest = runner.latestFor(c.id);
    return {
      id: c.id,
      repoId: c.repoId,
      repoName: repo?.name ?? null,
      name: c.name,
      command: c.command,
      kind: c.kind,
      cwd: c.cwd,
      run: runBrief(latest),
      /** stop rights: only a run THIS task's agent started */
      yours: !!latest && latest.ownerTaskId !== null && latest.ownerTaskId === run.taskId,
    };
  };

  /** Resolves the caller and the command named in the URL, or the reply to send. */
  const target = async (req: FastifyRequest) => {
    const run = await authRun(req);
    if (!run) return { ok: false as const, code: 403, error: 'forbidden' };
    const { id } = req.params as { id: string };
    const command = await storage.getCommand(id);
    if (!command) return { ok: false as const, code: 404, error: 'command not found — list them with GET /api/agent/commands' };
    const repo = await storage.getRepo(command.repoId);
    if (!repo) return { ok: false as const, code: 404, error: 'repo not found' };
    return { ok: true as const, run, command, repo };
  };

  /**
   * Holds the request until a ready line shows up, the process exits, or the
   * wait runs out — so an agent need not write its own poll loop. A finished
   * process is reported as such: its tail is then the crash log.
   */
  const settle = async (runId: string, opts: z.infer<typeof startBody>) => {
    const needles = (Array.isArray(opts.waitFor) ? opts.waitFor : opts.waitFor ? [opts.waitFor] : []).map((n) =>
      n.toLowerCase(),
    );
    const waitMs = opts.waitMs ?? (needles.length ? 30_000 : 0);
    const deadline = Date.now() + waitMs;
    let ready: boolean | null = needles.length ? false : null;
    for (;;) {
      const live = runner.get(runId)?.status === 'running';
      if (needles.length) {
        const out = (runner.tail(runId, READY_SCAN_BYTES) ?? '').toLowerCase();
        if (needles.some((n) => out.includes(n))) {
          ready = true;
          break;
        }
      }
      if (!live || Date.now() >= deadline) break;
      await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
    }
    const run = runner.get(runId);
    return { run: runBrief(run), ready, tail: runner.tail(runId, TAIL_BYTES) ?? '' };
  };

  const startError = (e: unknown) => {
    const err = e as Error & { conflict?: true };
    const conflict = err.conflict === true || /session cap reached/.test(err.message);
    return { code: conflict ? 409 : 400, error: err.message };
  };

  app.get('/api/agent/commands', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    const { repo: wanted } = req.query as { repo?: string };
    const repos = await storage.listRepos();
    let repoId: string | null = run.repoId;
    if (wanted) {
      const hit = repos.find((r) => r.id === wanted) ?? repos.find((r) => r.name === wanted);
      if (!hit) return reply.code(404).send({ error: `no repo "${wanted}" — ids and names are in GET /api/agent/context` });
      repoId = hit.id;
    }
    if (!repoId) return reply.code(400).send({ error: 'your run has no repo — pass ?repo=<id|name>' });
    const commands = await storage.listCommands(repoId);
    const repo = repos.find((r) => r.id === repoId);
    return { repoId, commands: commands.map((c) => commandBrief(c, repo, run)) };
  });

  app.post('/api/agent/commands', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    const body = defineBody.parse(req.body);
    const repo = run.repoId ? await storage.getRepo(run.repoId) : null;
    if (!repo) return reply.code(400).send({ error: 'your run has no repo to save a command in' });
    const used = defined.get(run.id) ?? 0;
    if (used >= AGENT_COMMAND_DEFINE_CAP) {
      return reply.code(403).send({
        error: `command definition cap (${AGENT_COMMAND_DEFINE_CAP}) reached for this session — use the commands that exist`,
      });
    }
    const cwdRaw = (body.cwd ?? '').trim();
    const cwd = cwdRaw === '' || cwdRaw === '.' ? null : cwdRaw;
    const text = body.command.trim();
    try {
      resolveCommandCwd(repo.path, cwdRaw);
      parseCommandLine(text);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    // One definition per command line: a second agent asking for the same
    // server gets the existing one, never a twin that would fight for its port.
    const twin = (await storage.listCommands(repo.id)).find((c) => c.command === text && c.cwd === cwd);
    if (twin) {
      return reply.code(409).send({ error: `already saved as "${twin.name}" — start that one`, command: commandBrief(twin, repo, run) });
    }
    const command = await storage.createCommand({
      repoId: repo.id,
      name: body.name.trim(),
      command: text,
      kind: body.kind ?? 'service',
      cwd,
    });
    defined.set(run.id, used + 1);
    await storage.appendEvent({
      kind: 'command.changed',
      actor: actorOf(run),
      repoId: repo.id,
      taskId: run.taskId,
      data: { action: 'created', name: command.name, command: command.command },
    });
    broadcast({ type: 'command.updated', command });
    return { command: commandBrief(command, repo, run) };
  });

  // Start-or-reuse. A command that is already running is NOT an error here:
  // it is the shared server the caller should use, so it answers with that run.
  app.post('/api/agent/commands/:id/start', async (req, reply) => {
    const t = await target(req);
    if (!t.ok) return reply.code(t.code).send({ error: t.error });
    const opts = startBody.parse(req.body ?? {});
    let live = runner.runningFor(t.command.id);
    let started = false;
    if (!live) {
      try {
        live = await runner.start(t.command, t.repo, actorOf(t.run), t.run.taskId);
        started = true;
      } catch (e) {
        // lost a same-tick race to another starter: that run is the shared one
        live = runner.runningFor(t.command.id);
        if (!live) {
          const { code, error } = startError(e);
          return reply.code(code).send({ error });
        }
      }
    }
    const out = await settle(live.id, opts);
    return {
      started,
      ...out,
      note: started
        ? 'started in the shared commands pool — it keeps running after your turn; stop it only if nobody needs it'
        : `already running (started by ${live.startedBy}) — reuse it, do not start a second copy`,
    };
  });

  app.post('/api/agent/commands/:id/stop', async (req, reply) => {
    const t = await target(req);
    if (!t.ok) return reply.code(t.code).send({ error: t.error });
    const live = runner.runningFor(t.command.id);
    if (!live) return reply.code(409).send({ error: `"${t.command.name}" is not running` });
    if (!t.run.taskId || live.ownerTaskId !== t.run.taskId) {
      return reply.code(403).send({
        error: `"${t.command.name}" was started by ${live.startedBy}, not by your task — it is shared; leave it running (restart it if you need a fresh process)`,
      });
    }
    if (!runner.stop(live.id)) return reply.code(409).send({ error: `"${t.command.name}" is not running` });
    await storage.appendEvent({
      kind: 'command.run',
      actor: actorOf(t.run),
      repoId: live.repoId,
      taskId: t.run.taskId,
      data: { action: 'stop-requested', name: live.name },
    });
    const exited = await runner.waitForExit(live.id, RESTART_EXIT_MS);
    return { ok: true, exited, run: runBrief(runner.get(live.id)) };
  });

  // Stop, wait for the exit, start again — for a server that must re-read
  // config or env. Ownership carries over, so restarting a human's server
  // never hands the agent the right to stop it.
  app.post('/api/agent/commands/:id/restart', async (req, reply) => {
    const t = await target(req);
    if (!t.ok) return reply.code(t.code).send({ error: t.error });
    const opts = startBody.parse(req.body ?? {});
    const live = runner.runningFor(t.command.id);
    const owned = !!live && !!t.run.taskId && live.ownerTaskId === t.run.taskId;
    if (t.command.repoId !== t.run.repoId && !owned) {
      return reply.code(403).send({ error: `"${t.command.name}" belongs to another repo — you may start it, not restart it` });
    }
    let owner: string | null = t.run.taskId;
    if (live) {
      owner = live.ownerTaskId;
      await storage.appendEvent({
        kind: 'command.run',
        actor: actorOf(t.run),
        repoId: live.repoId,
        taskId: t.run.taskId,
        data: { action: 'restart-requested', name: live.name },
      });
      runner.stop(live.id);
      if (!(await runner.waitForExit(live.id, RESTART_EXIT_MS))) {
        return reply.code(409).send({ error: `"${t.command.name}" did not exit within ${RESTART_EXIT_MS / 1000}s` });
      }
    }
    let next: CommandRun;
    try {
      next = await runner.start(t.command, t.repo, actorOf(t.run), owner);
    } catch (e) {
      // someone else started it in the gap — that run is the shared one
      const other = runner.runningFor(t.command.id);
      if (!other) {
        const { code, error } = startError(e);
        return reply.code(code).send({ error });
      }
      next = other;
    }
    return { restarted: true, ...(await settle(next.id, opts)) };
  });

  app.get('/api/agent/commands/:id/logs', async (req, reply) => {
    const t = await target(req);
    if (!t.ok) return reply.code(t.code).send({ error: t.error });
    const { bytes } = req.query as { bytes?: string };
    const n = Math.min(LOGS_MAX_BYTES, Math.max(1, Number.parseInt(bytes ?? '', 10) || TAIL_BYTES * 2));
    const latest = runner.latestFor(t.command.id);
    if (!latest) return reply.code(404).send({ error: `"${t.command.name}" has not run since the server started` });
    const tail = runner.tail(latest.id, n);
    return { run: runBrief(latest), tail: tail ?? '', note: tail === null ? 'the terminal of this run is gone' : undefined };
  });
}
