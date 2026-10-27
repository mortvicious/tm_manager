import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import {
  LANDING_TIERS,
  PARALLEL_MAX,
  PUSH_POLICIES,
  REPO_DELIVERIES,
  type RepoDelivery,
  QUESTION_AUTOPILOT_MAX_MINUTES,
  QUESTION_AUTOPILOT_MIN_MINUTES,
  type LandingTier,
  type PushPolicy,
} from '@tm/shared';
import { z } from 'zod';
import { expandHome } from '../config.ts';
import { commitRepo, gitStatus, pushRepo } from '../git.ts';
import { spaceConflictForRepo } from '../spaces/service.ts';
import { parseCommandLine } from '../commands/parse.ts';
import { defaultBranch, prDeliveryRefusal, validBaseBranchName, worktreeRoot } from '../worktrees.ts';
import type { Storage } from '../storage/types.ts';

const repoBody = z
  .object({
    name: z.string().min(1).optional(),
    path: z.string().min(1),
    role: z.string().nullish(),
    // dev-server URL framed by the mobile emulator; '' / null clears it
    previewUrl: z.string().nullish(),
    // how far this repo's tasks land on their own (docs/design.md § Landing tiers)
    landing: z.enum(LANDING_TIERS as [LandingTier, ...LandingTier[]]).optional(),
    // what worker turns are told about `git push` (docs/publish.md § Push policy)
    pushPolicy: z.enum(PUSH_POLICIES as [PushPolicy, ...PushPolicy[]]).optional(),
    // question autopilot minutes (docs/questions.md § Autopilot); null or 0 = off
    questionAutopilotMinutes: z
      .union([z.literal(0), z.number().int().min(QUESTION_AUTOPILOT_MIN_MINUTES).max(QUESTION_AUTOPILOT_MAX_MINUTES)])
      .nullable()
      .optional()
      .transform((v) => (v === 0 ? null : v)),
    // parallel same-repo tasks (docs/parallel.md): PATCH only — `pr` needs a GitHub origin + gh auth, read at the switch
    parallel: z.number().int().min(1).max(PARALLEL_MAX).optional(),
    delivery: z.enum(REPO_DELIVERIES as [RepoDelivery, ...RepoDelivery[]]).optional(),
    // argv line run in each new worktree ('' / null = none)
    worktreeSetup: z.string().max(500).nullish(),
    // ignored files copied into each new worktree (null = the defaults)
    worktreeCopy: z
      .array(
        z
          .string()
          .min(1)
          .max(200)
          .refine((p) => !p.startsWith('/') && !p.startsWith('~') && !p.split('/').includes('..'), 'copy patterns are repo-relative'),
      )
      .max(30)
      .nullish(),
    // the branch pr delivery forks from / targets / lands onto (docs/parallel.md § Base branch); '' / null = the remote default
    baseBranch: z.string().max(200).nullish(),
  })
  .strict();

/**
 * Parallel tasks and PR delivery (docs/parallel.md) are outward-facing — the
 * server pushes branches, opens PRs and lands on the default branch — and a
 * setup command runs in every new worktree, so turning any of them ON is the
 * dashboard's (Origin), like a landing tier. Turning them off is allowed from
 * anywhere.
 */
export function parallelNeedsBrowser(
  body: { parallel?: number; delivery?: RepoDelivery; worktreeSetup?: string | null; baseBranch?: string | null },
  origin: string | undefined,
): boolean {
  if (origin) return false;
  // the base branch is where lands PUSH (for some repos a deploy): any change, set or cleared, is the dashboard's
  return (body.parallel ?? 1) > 1 || body.delivery === 'pr' || !!body.worktreeSetup?.trim() || body.baseBranch !== undefined;
}
export const PARALLEL_FROM_BROWSER = 'parallel tasks, PR delivery, the base branch and the worktree setup command are set from the dashboard';

/**
 * Raising a landing tier lets work reach `done` (or the remote) with no human
 * in between, so it is the dashboard's to set, never a worker's curl (the
 * questions/spaces rule: browsers always send Origin, curl does not unless
 * told to). Lowering back to supervised is always allowed.
 */
export function landingNeedsBrowser(landing: LandingTier | null | undefined, origin: string | undefined): boolean {
  return !!landing && landing !== 'supervised' && !origin;
}
export const LANDING_FROM_BROWSER = 'landing tiers are set from the dashboard';

/**
 * The same rule for the push policy (docs/publish.md § Push policy):
 * `agent-pushes` lets a worker push with nobody asked, so only the dashboard
 * sets it. `repo-rules` and `publish-turn` never add autonomy (the latter
 * takes it away) and are allowed from anywhere.
 */
export function pushPolicyNeedsBrowser(policy: PushPolicy | null | undefined, origin: string | undefined): boolean {
  return policy === 'agent-pushes' && !origin;
}
export const PUSH_POLICY_FROM_BROWSER = 'push policies are set from the dashboard';

/**
 * And for the question autopilot (docs/questions.md § Autopilot): any value
 * that turns it on (or shortens the wait) lets the server answer a worker's
 * question with nobody asked, so it needs the dashboard. Off is allowed from
 * anywhere.
 */
export function autopilotNeedsBrowser(minutes: number | null | undefined, origin: string | undefined): boolean {
  return typeof minutes === 'number' && !origin;
}
export const AUTOPILOT_FROM_BROWSER = 'the question autopilot is set from the dashboard';

/** The emulator puts this string straight into an iframe `src`, so the scheme
 *  is pinned to http/https here — the one place every write passes through. */
function normalizePreviewUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  // An explicit `scheme://` is taken at its word (so ftp:// is rejected, not
  // silently rewritten); anything else is tried as written and then as a bare
  // host, because "localhost:5173" is what people actually type and it parses
  // as a bogus "localhost:" scheme.
  const explicit = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  const url = explicit ? parseHttpUrl(trimmed) : parseHttpUrl(trimmed) ?? parseHttpUrl(`http://${trimmed}`);
  if (!url) throw new Error(`Preview URL must be an http(s) address, got: ${trimmed}`);
  return url.toString();
}

function parseHttpUrl(candidate: string): URL | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

export function registerRepoRoutes(app: FastifyInstance, storage: Storage) {
  app.get('/api/repos', async () => storage.listRepos());

  app.post('/api/repos', async (req, reply) => {
    const body = repoBody.parse(req.body);
    if (body.parallel !== undefined || body.delivery !== undefined || body.worktreeSetup != null || body.worktreeCopy != null || body.baseBranch != null) {
      return reply.code(400).send({ error: 'set parallel tasks and delivery on the Repos page once the repo is added' });
    }
    if (landingNeedsBrowser(body.landing, req.headers.origin)) return reply.code(403).send({ error: LANDING_FROM_BROWSER });
    if (pushPolicyNeedsBrowser(body.pushPolicy, req.headers.origin)) return reply.code(403).send({ error: PUSH_POLICY_FROM_BROWSER });
    if (autopilotNeedsBrowser(body.questionAutopilotMinutes, req.headers.origin)) {
      return reply.code(403).send({ error: AUTOPILOT_FROM_BROWSER });
    }
    let abs: string;
    try {
      abs = expandHome(body.path);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      return reply.code(400).send({ error: `Path is not an existing directory: ${abs}` });
    }
    const name = body.name?.trim() || abs.split('/').filter(Boolean).pop() || abs;
    // a task worktree (docs/parallel.md) is the server's, never a repo of its own
    const repos = await storage.listRepos();
    if (repos.some((r) => abs === worktreeRoot(r) || abs.startsWith(worktreeRoot(r) + '/'))) {
      return reply.code(400).send({ error: 'that path is inside a repo\'s task worktrees (<repo>.worktrees) — register the repo itself' });
    }
    const clash = await spaceConflictForRepo(storage, { name, path: abs });
    if (clash) return reply.code(400).send({ error: clash });
    let previewUrl: string | null;
    try {
      previewUrl = normalizePreviewUrl(body.previewUrl);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const repo = await storage.createRepo({
      name,
      path: abs,
      role: body.role ?? null,
      previewUrl,
      landing: body.landing,
      pushPolicy: body.pushPolicy,
      questionAutopilotMinutes: body.questionAutopilotMinutes,
    });
    await storage.appendEvent({
      kind: 'repo.changed',
      actor: 'human',
      repoId: repo.id,
      data: {
        action: 'created',
        name,
        landing: repo.landing,
        pushPolicy: repo.pushPolicy,
        questionAutopilotMinutes: repo.questionAutopilotMinutes,
      },
    });
    return repo;
  });

  app.patch('/api/repos/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = repoBody.partial().parse(req.body);
    if (landingNeedsBrowser(body.landing, req.headers.origin)) return reply.code(403).send({ error: LANDING_FROM_BROWSER });
    if (pushPolicyNeedsBrowser(body.pushPolicy, req.headers.origin)) return reply.code(403).send({ error: PUSH_POLICY_FROM_BROWSER });
    if (autopilotNeedsBrowser(body.questionAutopilotMinutes, req.headers.origin)) {
      return reply.code(403).send({ error: AUTOPILOT_FROM_BROWSER });
    }
    if (parallelNeedsBrowser(body, req.headers.origin)) return reply.code(403).send({ error: PARALLEL_FROM_BROWSER });
    const current = await storage.getRepo(id);
    if (!current) return reply.code(404).send({ error: 'repo not found' });
    // `direct` is always one task at a time; `pr` must be provable before it is written
    let parallel = body.parallel;
    const delivery = body.delivery ?? current.delivery;
    if (delivery === 'direct') {
      if ((parallel ?? 1) > 1) return reply.code(400).send({ error: 'more than one task at a time needs PR delivery (each task in its own worktree)' });
      if (body.delivery === 'direct') parallel = 1;
    }
    let baseBranch: string | null | undefined;
    if ('baseBranch' in body) {
      baseBranch = body.baseBranch?.trim().replace(/^origin\//, '') || null;
      if (baseBranch && !validBaseBranchName(baseBranch)) return reply.code(400).send({ error: `not a branch name: ${baseBranch}` });
      if (baseBranch && baseBranch !== current.baseBranch && !(await defaultBranch({ path: current.path, baseBranch }))) {
        return reply.code(400).send({ error: `origin/${baseBranch} does not exist — push the branch first, or check the name` });
      }
    }
    if (body.delivery === 'pr' && current.delivery !== 'pr') {
      const refusal = await prDeliveryRefusal({ path: current.path, baseBranch: baseBranch === undefined ? current.baseBranch : baseBranch });
      if (refusal) return reply.code(400).send({ error: refusal });
    }
    let worktreeSetup: string | null | undefined;
    if ('worktreeSetup' in body) {
      worktreeSetup = body.worktreeSetup?.trim() || null;
      if (worktreeSetup) {
        try {
          parseCommandLine(worktreeSetup);
        } catch (e) {
          return reply.code(400).send({ error: `setup command: ${(e as Error).message}` });
        }
      }
    }
    let abs: string | undefined;
    if (body.path) {
      try {
        abs = expandHome(body.path);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        return reply.code(400).send({ error: `Path is not an existing directory: ${abs}` });
      }
      const clash = await spaceConflictForRepo(storage, { name: body.name ?? 'this repo', path: abs });
      if (clash) return reply.code(400).send({ error: clash });
    }
    let previewUrl: string | null | undefined;
    if ('previewUrl' in body) {
      try {
        previewUrl = normalizePreviewUrl(body.previewUrl);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    }
    const before = current;
    const repo = await storage.updateRepo(id, {
      name: body.name,
      path: abs,
      role: body.role,
      previewUrl,
      landing: body.landing,
      pushPolicy: body.pushPolicy,
      questionAutopilotMinutes: body.questionAutopilotMinutes,
      parallel,
      delivery: body.delivery,
      worktreeSetup,
      worktreeCopy: 'worktreeCopy' in body ? (body.worktreeCopy ?? null) : undefined,
      baseBranch,
    });
    if (!repo) return reply.code(404).send({ error: 'repo not found' });
    await storage.appendEvent({
      kind: 'repo.changed',
      actor: 'human',
      repoId: id,
      data: {
        action: 'updated',
        ...(before && before.landing !== repo.landing ? { landing: { from: before.landing, to: repo.landing } } : {}),
        ...(before && before.pushPolicy !== repo.pushPolicy ? { pushPolicy: { from: before.pushPolicy, to: repo.pushPolicy } } : {}),
        ...(before && before.questionAutopilotMinutes !== repo.questionAutopilotMinutes
          ? { questionAutopilotMinutes: { from: before.questionAutopilotMinutes, to: repo.questionAutopilotMinutes } }
          : {}),
        ...(before.parallel !== repo.parallel ? { parallel: { from: before.parallel, to: repo.parallel } } : {}),
        ...(before.delivery !== repo.delivery ? { delivery: { from: before.delivery, to: repo.delivery } } : {}),
        ...(before.worktreeSetup !== repo.worktreeSetup ? { worktreeSetup: { from: before.worktreeSetup, to: repo.worktreeSetup } } : {}),
        ...(JSON.stringify(before.worktreeCopy) !== JSON.stringify(repo.worktreeCopy) ? { worktreeCopy: { from: before.worktreeCopy, to: repo.worktreeCopy } } : {}),
        ...(before.baseBranch !== repo.baseBranch ? { baseBranch: { from: before.baseBranch, to: repo.baseBranch } } : {}),
      },
    });
    return repo;
  });

  app.delete('/api/repos/:id', async (req) => {
    const { id } = req.params as { id: string };
    await storage.deleteRepo(id);
    await storage.appendEvent({ kind: 'repo.changed', actor: 'human', repoId: id, data: { action: 'deleted' } });
    return { ok: true };
  });

  app.get('/api/repos/:id/git', async (req, reply) => {
    const { id } = req.params as { id: string };
    const repo = await storage.getRepo(id);
    if (!repo) return reply.code(404).send({ error: 'repo not found' });
    return gitStatus(repo);
  });

  // git add -A + commit; the message is written by claude-opus-5-5 from the
  // staged diff (user policy). Explicit button, human actor.
  app.post('/api/repos/:id/commit', async (req, reply) => {
    const { id } = req.params as { id: string };
    const repo = await storage.getRepo(id);
    if (!repo) return reply.code(404).send({ error: 'repo not found' });
    const result = await commitRepo(storage, repo);
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    return result;
  });

  app.post('/api/repos/:id/push', async (req, reply) => {
    const { id } = req.params as { id: string };
    const repo = await storage.getRepo(id);
    if (!repo) return reply.code(404).send({ error: 'repo not found' });
    const result = await pushRepo(storage, repo);
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    return result;
  });
}
