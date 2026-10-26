import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CommandRun, Repo, RepoCommand, Run } from '@tm/shared';
import { AGENT_COMMANDS_PER_REPO_CAP } from '@tm/shared';
import { broadcast } from '../events.ts';
import { directoryEscape, parseCommandLine, resolveCommandCwd, tempPathIn } from '../commands/parse.ts';
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
//
// Ownership of DEFINITIONS (docs/commands.md § Agent-owned commands): a
// command an agent saves belongs to its task (`owner_task_id`), at most
// AGENT_COMMANDS_PER_REPO_CAP live ones per repo, and is archived by
// commands/cleanup.ts once that task lands or it goes unused. A throwaway line
// is not saved at all: POST /api/agent/commands/run is the one-shot form.

/** Command definitions one worker session may add — a spam guard, not a budget. */
export const AGENT_COMMAND_DEFINE_CAP = 3;
/** Live one-shot runs one TASK may hold at once (the pool's own cap is 10 for everything). */
export const AGENT_ONE_SHOT_TASK_CAP = 3;
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

const runBody = z
  .object({
    command: z.string().min(1).max(500),
    cwd: z.string().max(200).nullish(),
    name: z.string().min(1).max(80).optional(),
    kind: z.enum(['task', 'service']).optional(),
    waitFor: startBody.shape.waitFor,
    waitMs: startBody.shape.waitMs,
  })
  .strict();

/**
 * Parses an agent's command line and proves it runs inside `repo`: the `cwd`
 * field (resolveCommandCwd) AND the argv (directoryEscape — `env -C`,
 * `--prefix`, `bash -c`). Returns the error message, or the parsed parts.
 */
function vetAgentLine(repo: Repo, text: string, cwdRaw: string): { error: string } | { argv: string[] } {
  try {
    const cwdAbs = resolveCommandCwd(repo.path, cwdRaw);
    const argv = parseCommandLine(text);
    const escape = directoryEscape(argv, cwdAbs, repo.path);
    return escape ? { error: escape } : { argv };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

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
          ...(r.oneShot ? { oneShot: true } : {}),
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
      /** the task whose agent saved it; null = a human's */
      ownerTaskId: c.ownerTaskId,
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

  const archivedRefusal = (c: RepoCommand) =>
    `"${c.name}" is archived — save the same command line again (POST /api/agent/commands) to take it over, or run it once with POST /api/agent/commands/run`;

  /** A run of the commands pool by id, for the one-shot logs/stop routes. */
  const targetRun = async (req: FastifyRequest) => {
    const run = await authRun(req);
    if (!run) return { ok: false as const, code: 403, error: 'forbidden' };
    const { runId } = req.params as { runId: string };
    const cmdRun = runner.get(runId);
    if (!cmdRun) return { ok: false as const, code: 404, error: 'run not found (finished runs are kept for a while, then dropped)' };
    return { ok: true as const, run, cmdRun };
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
    // archived (docs/commands.md § Agent-owned commands) = out of the agent's view
    const commands = (await storage.listCommands(repoId)).filter((c) => !c.archivedAt);
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
    const vet = vetAgentLine(repo, text, cwdRaw);
    if ('error' in vet) return reply.code(400).send({ error: vet.error });
    // A scratchpad script dies with its session: saving a shortcut to it
    // leaves a broken button behind. That is a one-shot run, not a definition.
    const temp = tempPathIn(vet.argv);
    if (temp) {
      return reply.code(400).send({
        error: `"${temp}" is in a temp folder, so a saved command would outlive it — run it once with POST /api/agent/commands/run instead`,
      });
    }
    const all = await storage.listCommands(repo.id);
    // One definition per command line: a second agent asking for the same
    // server gets the existing one, never a twin that would fight for its port.
    const same = all.filter((c) => c.command === text && c.cwd === cwd);
    const twin = same.find((c) => !c.archivedAt) ?? same.find((c) => c.ownerTaskId) ?? same[0];
    if (twin && !twin.archivedAt) {
      return reply.code(409).send({ error: `already saved as "${twin.name}" — start that one`, command: commandBrief(twin, repo, run) });
    }
    if (twin && !twin.ownerTaskId) {
      // a human archived their own command: not the agent's to bring back
      return reply.code(409).send({
        error: `"${twin.name}" was archived by a human — run it once with POST /api/agent/commands/run instead`,
      });
    }
    const owned = all.filter((c) => c.ownerTaskId && !c.archivedAt).length;
    if (owned >= AGENT_COMMANDS_PER_REPO_CAP) {
      return reply.code(403).send({
        error: `this repo already holds ${owned} agent-saved commands (cap ${AGENT_COMMANDS_PER_REPO_CAP}) — start one that exists, or run yours once with POST /api/agent/commands/run`,
      });
    }
    let command: RepoCommand;
    if (twin) {
      // An archived agent command of the same line: revived for THIS task
      // rather than duplicated, so its id, order and history carry on.
      const revived = await storage.updateCommand(twin.id, { archivedAt: null, ownerTaskId: run.taskId, name: body.name.trim() });
      if (!revived) return reply.code(409).send({ error: 'that command was deleted meanwhile — try again' });
      command = revived;
    } else {
      command = await storage.createCommand({
        repoId: repo.id,
        name: body.name.trim(),
        command: text,
        kind: body.kind ?? 'service',
        cwd,
        ownerTaskId: run.taskId,
      });
    }
    defined.set(run.id, used + 1);
    await storage.appendEvent({
      kind: 'command.changed',
      actor: actorOf(run),
      repoId: repo.id,
      taskId: run.taskId,
      data: { action: twin ? 'revived' : 'created', commandId: command.id, name: command.name, command: command.command },
    });
    broadcast({ type: 'command.updated', command });
    return { command: commandBrief(command, repo, run), ...(twin ? { note: 'an archived copy of this command was revived for your task' } : {}) };
  });

  // One-shot (docs/commands.md § One-shot runs): an unsaved command line in the
  // shared pool — the default for a throwaway server or script. Same argv and
  // directory rules as a definition, nothing written to tm_commands; the run
  // is in memory like every command run and is owned by the caller's task.
  app.post('/api/agent/commands/run', async (req, reply) => {
    const run = await authRun(req);
    if (!run) return reply.code(403).send({ error: 'forbidden' });
    const body = runBody.parse(req.body ?? {});
    const repo = run.repoId ? await storage.getRepo(run.repoId) : null;
    if (!repo) return reply.code(400).send({ error: 'your run has no repo to run a command in' });
    const cwdRaw = (body.cwd ?? '').trim();
    const text = body.command.trim();
    const vet = vetAgentLine(repo, text, cwdRaw);
    if ('error' in vet) return reply.code(400).send({ error: vet.error });
    const mine = runner.running().filter((r) => r.oneShot && r.ownerTaskId !== null && r.ownerTaskId === run.taskId);
    if (mine.length >= AGENT_ONE_SHOT_TASK_CAP) {
      return reply.code(409).send({
        error: `your task already has ${mine.length} one-shot runs live (cap ${AGENT_ONE_SHOT_TASK_CAP}) — stop one with POST /api/agent/commands/runs/<id>/stop`,
        runs: mine.map((r) => runBrief(r)),
      });
    }
    let live: CommandRun;
    try {
      live = await runner.startOneShot(
        {
          name: body.name?.trim() || text.slice(0, 80),
          command: text,
          kind: body.kind ?? 'service',
          cwd: cwdRaw === '' || cwdRaw === '.' ? null : cwdRaw,
        },
        repo,
        actorOf(run),
        run.taskId,
      );
    } catch (e) {
      const { code, error } = startError(e);
      return reply.code(code).send({ error });
    }
    const out = await settle(live.id, { waitFor: body.waitFor, waitMs: body.waitMs });
    return {
      started: true,
      ...out,
      note: 'one-shot: not saved, nothing left in the launcher once it ends — stop it with POST /api/agent/commands/runs/<run.id>/stop when you are done',
    };
  });

  app.get('/api/agent/commands/runs/:runId/logs', async (req, reply) => {
    const t = await targetRun(req);
    if (!t.ok) return reply.code(t.code).send({ error: t.error });
    const { bytes } = req.query as { bytes?: string };
    const n = Math.min(LOGS_MAX_BYTES, Math.max(1, Number.parseInt(bytes ?? '', 10) || TAIL_BYTES * 2));
    const tail = runner.tail(t.cmdRun.id, n);
    return { run: runBrief(t.cmdRun), tail: tail ?? '', note: tail === null ? 'the terminal of this run is gone' : undefined };
  });

  app.post('/api/agent/commands/runs/:runId/stop', async (req, reply) => {
    const t = await targetRun(req);
    if (!t.ok) return reply.code(t.code).send({ error: t.error });
    const live = t.cmdRun;
    if (live.status !== 'running') return reply.code(409).send({ error: `"${live.name}" is not running` });
    if (!t.run.taskId || live.ownerTaskId !== t.run.taskId) {
      return reply.code(403).send({ error: `"${live.name}" was started by ${live.startedBy}, not by your task — leave it running` });
    }
    if (!runner.stop(live.id)) return reply.code(409).send({ error: `"${live.name}" is not running` });
    await storage.appendEvent({
      kind: 'command.run',
      actor: actorOf(t.run),
      repoId: live.repoId,
      taskId: t.run.taskId,
      data: { action: 'stop-requested', name: live.name, ...(live.oneShot ? { oneShot: true } : {}) },
    });
    const exited = await runner.waitForExit(live.id, RESTART_EXIT_MS);
    return { ok: true, exited, run: runBrief(runner.get(live.id)) };
  });

  // Start-or-reuse. A command that is already running is NOT an error here:
  // it is the shared server the caller should use, so it answers with that run.
  app.post('/api/agent/commands/:id/start', async (req, reply) => {
    const t = await target(req);
    if (!t.ok) return reply.code(t.code).send({ error: t.error });
    const opts = startBody.parse(req.body ?? {});
    let live = runner.runningFor(t.command.id);
    let started = false;
    if (!live && t.command.archivedAt) return reply.code(409).send({ error: archivedRefusal(t.command) });
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
    if (t.command.archivedAt) return reply.code(409).send({ error: archivedRefusal(t.command) });
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
