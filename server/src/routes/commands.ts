import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CHECK_TIMEOUT_MAX_SEC, CHECK_TIMEOUT_MIN_SEC } from '@tm/shared';
import { broadcast } from '../events.ts';
import { parseCommandLine, resolveCommandCwd } from '../commands/parse.ts';
import { CheckBaselines } from '../commands/baseline.ts';
import type { CommandRunner } from '../commands/runner.ts';
import { scanRepoScripts } from '../commands/scan.ts';
import type { Storage } from '../storage/types.ts';

const commandBody = z
  .object({
    repoId: z.string().min(1),
    name: z.string().min(1).max(80),
    command: z.string().min(1).max(500),
    kind: z.enum(['task', 'service']).optional(),
    // '' / null = repo root
    cwd: z.string().max(200).nullish(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    // a CHECK runs after every worker turn as part of the definition of done
    // (docs/checks.md); timeoutSec null = CHECK_DEFAULT_TIMEOUT_SEC
    isCheck: z.boolean().optional(),
    timeoutSec: z.number().int().min(CHECK_TIMEOUT_MIN_SEC).max(CHECK_TIMEOUT_MAX_SEC).nullish(),
  })
  .strict();

/** POST /api/commands only: the baseline the check was saved over
 *  (docs/checks.md § Baseline), and the human's yes to a red one. */
const createBody = commandBody
  .extend({
    baselineId: z.string().min(1).max(80).optional(),
    acceptRed: z.boolean().optional(),
  })
  .strict();

const baselineBody = z
  .object({
    repoId: z.string().min(1),
    name: z.string().min(1).max(80),
    command: z.string().min(1).max(500),
    cwd: z.string().max(200).nullish(),
    timeoutSec: z.number().int().min(CHECK_TIMEOUT_MIN_SEC).max(CHECK_TIMEOUT_MAX_SEC).nullish(),
  })
  .strict();

/** A check must end to give a verdict; a dev server never does. */
const SERVICE_CHECK = 'a check must be a one-shot command (kind "task") — a service never exits, so it could only time out';

/**
 * Tasks pick checks BY NAME (`Task.checks`), so two checks of one repo may
 * not share a name — the pick would be ambiguous. Null = fine.
 */
async function checkNameClash(storage: Storage, repoId: string, name: string, selfId: string | null): Promise<string | null> {
  const clash = (await storage.listCommands(repoId)).find((c) => c.isCheck && c.id !== selfId && c.name === name);
  return clash ? `a check named "${name}" already exists in this repo — tasks pick checks by name, so rename one` : null;
}

/**
 * Checks are the definition of done (docs/checks.md § Who may define a
 * check), so defining, editing or deleting one is the dashboard's, never a
 * worker's curl — the landingNeedsBrowser rule (browsers always send Origin on
 * a write, curl does not unless told to). Without this a worker could unflag
 * or rewrite the very check that judges it, audited as `human`.
 */
export const CHECK_FROM_BROWSER = 'checks are defined, edited and deleted from the dashboard';

// The repo a command belongs to is fixed: a command line means nothing outside
// the directory it was written for.
const commandPatch = commandBody.omit({ repoId: true }).partial().strict();

export function registerCommandRoutes(app: FastifyInstance, storage: Storage, runner: CommandRunner) {
  const baselines = new CheckBaselines(storage, runner);

  app.get('/api/commands', async (req) => {
    const { repoId } = req.query as { repoId?: string };
    return storage.listCommands(repoId);
  });

  app.post('/api/commands', async (req, reply) => {
    const body = createBody.parse(req.body);
    if (!req.headers.origin && (body.isCheck || body.timeoutSec != null || body.baselineId)) {
      return reply.code(403).send({ error: CHECK_FROM_BROWSER });
    }
    if ((body.baselineId || body.acceptRed) && !body.isCheck) {
      return reply.code(400).send({ error: 'a baseline belongs to a check — set isCheck' });
    }
    const repo = await storage.getRepo(body.repoId);
    if (!repo) return reply.code(400).send({ error: 'repo not found' });
    const cwd = (body.cwd ?? '').trim();
    try {
      // Validate against the repo NOW so a broken command is rejected at the
      // form, not at the terminal it would have failed to open.
      resolveCommandCwd(repo.path, cwd);
      parseCommandLine(body.command);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    if (body.isCheck && body.kind === 'service') return reply.code(400).send({ error: SERVICE_CHECK });
    if (body.isCheck) {
      const clash = await checkNameClash(storage, repo.id, body.name.trim(), null);
      if (clash) return reply.code(409).send({ error: clash });
    }
    // A save that names its baseline must match it, and a red or no-verdict
    // one needs the human's explicit yes. A save without one (the hand-written
    // form) is unchanged.
    let baseline: Record<string, unknown> | undefined;
    if (body.baselineId) {
      const got = baselines.forSave(body.baselineId, repo.id, {
        command: body.command,
        cwd,
        timeoutSec: body.timeoutSec ?? null,
      });
      if (!got.ok) return reply.code(409).send({ error: got.reason });
      const b = got.baseline;
      if (b.verdict !== 'green' && !body.acceptRed) {
        const why = b.verdict === 'red' ? `exits ${b.exit}` : `gave no verdict (${b.error})`;
        return reply.code(409).send({
          error: `the baseline ${why} on the current tree — every task would get fix turns for that failure; save anyway only if you mean it`,
          baseline: b,
        });
      }
      baseline = { id: b.id, verdict: b.verdict, exit: b.exit, error: b.error, accepted: b.verdict !== 'green' };
    }
    const command = await storage.createCommand({
      repoId: repo.id,
      name: body.name.trim(),
      command: body.command.trim(),
      kind: body.kind ?? 'task',
      cwd: cwd === '' || cwd === '.' ? null : cwd,
      sortOrder: body.sortOrder,
      isCheck: body.isCheck ?? false,
      timeoutSec: body.timeoutSec ?? null,
    });
    await storage.appendEvent({
      kind: 'command.changed',
      actor: 'human',
      repoId: repo.id,
      data: {
        action: 'created',
        name: command.name,
        command: command.command,
        isCheck: command.isCheck,
        ...(baseline ? { baseline } : {}),
      },
    });
    broadcast({ type: 'command.updated', command });
    return command;
  });

  app.patch('/api/commands/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = commandPatch.parse(req.body);
    const cur = await storage.getCommand(id);
    if (!cur) return reply.code(404).send({ error: 'command not found' });
    if (!req.headers.origin) {
      // Turning a check on or off, or retiming one, is the check's definition;
      // so is anything about an existing check (a command rewritten to `true`
      // or a renamed check unflags it just as well). Ordering is not.
      const flagChange =
        (body.isCheck !== undefined && body.isCheck !== cur.isCheck) ||
        (body.timeoutSec !== undefined && (body.timeoutSec ?? null) !== cur.timeoutSec);
      const { sortOrder: _order, ...rest } = body;
      const editsCheck = cur.isCheck && Object.values(rest).some((v) => v !== undefined);
      if (flagChange || editsCheck) return reply.code(403).send({ error: CHECK_FROM_BROWSER });
    }
    const repo = await storage.getRepo(cur.repoId);
    if (!repo) return reply.code(400).send({ error: 'repo not found' });
    const cwd = body.cwd === undefined ? undefined : (body.cwd ?? '').trim();
    try {
      resolveCommandCwd(repo.path, cwd === undefined ? cur.cwd : cwd);
      parseCommandLine(body.command ?? cur.command);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    if ((body.isCheck ?? cur.isCheck) && (body.kind ?? cur.kind) === 'service') {
      return reply.code(400).send({ error: SERVICE_CHECK });
    }
    if (body.isCheck ?? cur.isCheck) {
      const clash = await checkNameClash(storage, cur.repoId, body.name?.trim() ?? cur.name, cur.id);
      if (clash) return reply.code(409).send({ error: clash });
    }
    const command = await storage.updateCommand(id, {
      name: body.name?.trim(),
      command: body.command?.trim(),
      kind: body.kind,
      cwd: cwd === undefined ? undefined : cwd === '' || cwd === '.' ? null : cwd,
      sortOrder: body.sortOrder,
      isCheck: body.isCheck,
      timeoutSec: body.timeoutSec,
    });
    if (!command) return reply.code(404).send({ error: 'command not found' });
    await storage.appendEvent({
      kind: 'command.changed',
      actor: 'human',
      repoId: command.repoId,
      data: {
        action: 'updated',
        name: command.name,
        command: command.command,
        ...(body.isCheck !== undefined || body.timeoutSec !== undefined
          ? { isCheck: command.isCheck, timeoutSec: command.timeoutSec }
          : {}),
      },
    });
    broadcast({ type: 'command.updated', command });
    return command;
  });

  app.delete('/api/commands/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const cur = await storage.getCommand(id);
    if (cur?.isCheck && !req.headers.origin) return reply.code(403).send({ error: CHECK_FROM_BROWSER });
    await storage.deleteCommand(id);
    // A live run of it keeps running, detached from the row it came from.
    runner.detach(id);
    if (cur) {
      await storage.appendEvent({
        kind: 'command.changed',
        actor: 'human',
        repoId: cur.repoId,
        data: { action: 'deleted', name: cur.name },
      });
    }
    broadcast({ type: 'command.deleted', commandId: id });
    return { ok: true };
  });

  /** package.json scripts of a repo, ready to be saved as commands. */
  app.get('/api/repos/:id/scripts', async (req, reply) => {
    const { id } = req.params as { id: string };
    const repo = await storage.getRepo(id);
    if (!repo) return reply.code(404).send({ error: 'repo not found' });
    return scanRepoScripts(repo.path);
  });

  /**
   * A check's baseline (docs/checks.md § Baseline): run the command line once
   * on the current tree, BEFORE it is saved as a check. 202 at once — a check
   * may take its whole timeout — and the result is polled from the GET below.
   * Browser-only like every check definition.
   */
  app.post('/api/commands/baseline', async (req, reply) => {
    if (!req.headers.origin) return reply.code(403).send({ error: CHECK_FROM_BROWSER });
    const body = baselineBody.parse(req.body);
    const repo = await storage.getRepo(body.repoId);
    if (!repo) return reply.code(400).send({ error: 'repo not found' });
    const raw = (body.cwd ?? '').trim();
    const cwd = raw === '.' ? '' : raw;
    try {
      resolveCommandCwd(repo.path, cwd);
      parseCommandLine(body.command);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const baseline = await baselines.start(
      repo,
      { name: body.name.trim(), command: body.command, cwd, timeoutSec: body.timeoutSec ?? null },
      'human',
    );
    return reply.code(202).send(baseline);
  });

  app.get('/api/commands/baseline/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = baselines.get(id);
    if (!b) return reply.code(404).send({ error: 'no such baseline (the server may have restarted)' });
    return b;
  });

  app.post('/api/commands/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string };
    const command = await storage.getCommand(id);
    if (!command) return reply.code(404).send({ error: 'command not found' });
    const repo = await storage.getRepo(command.repoId);
    if (!repo) return reply.code(400).send({ error: 'repo not found' });
    try {
      return await runner.start(command, repo, 'human');
    } catch (e) {
      const err = e as Error & { conflict?: true };
      // Already running, or the PTY cap is full — both are "try again later",
      // not "this command is broken".
      const conflict = err.conflict === true || /session cap reached/.test(err.message);
      return reply.code(conflict ? 409 : 400).send({ error: err.message });
    }
  });

  app.get('/api/command-runs', async () => runner.list());

  app.post('/api/command-runs/:runId/stop', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const run = runner.get(runId);
    if (!run) return reply.code(404).send({ error: 'no such command run' });
    if (!runner.stop(runId)) return reply.code(409).send({ error: 'command is not running' });
    await storage.appendEvent({
      kind: 'command.run',
      actor: 'human',
      repoId: run.repoId,
      data: { action: 'stop-requested', name: run.name },
    });
    return { ok: true };
  });

  app.post('/api/command-runs/clear', async () => ({ ok: true, cleared: runner.clearFinished() }));
}
