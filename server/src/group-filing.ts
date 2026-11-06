// Group decisions for non-human filings (docs/grouping.md § Agent filings).
//
// Every task a non-human creator files lands with an explicit decision —
// joined, new, or ungrouped with a reason — audited on its create. A group is
// still a task tree: join = parent under the group's ROOT (flat, at the end of
// its run order: a new row takes the global max key), new = a root carrying
// `group_name`, ungrouped = its own root on purpose.
//
// Membership WIDENS reach (dispatch accepts "own group", reachOf "your group"),
// so every join here is bounded by reach (the root's repo is the caller's, its
// shared space's or one of its workspaces') and by trust: a join never mixes
// untrusted members (tainted / Sentry / job chains, `untrustedTaskIds`) with
// trusted ones. A refused join for trust is downgraded, never a 4xx: the
// filing still lands, ungrouped, with the reason in the response.

import {
  AGENT_GROUP_MAX_MEMBERS,
  TERMINAL_TASK_STATUSES,
  groupLabel,
  normalizeGroupName,
  trustCompatible,
  type AgentGroupSummary,
  type GroupDecisionRecord,
  type GroupRequest,
  type Task,
} from '@tm/shared';
import { spaceForRepo } from './spaces/service.ts';
import type { Storage } from './storage/types.ts';

/** The caller's repo + its shared space's repos + every workspace that holds it. */
export async function reachRepoIds(storage: Storage, repoId: string | null): Promise<string[]> {
  if (!repoId) return [];
  const out = new Set<string>([repoId]);
  const space = await spaceForRepo(storage, repoId);
  for (const r of space?.repoIds ?? []) out.add(r);
  for (const w of await storage.listWorkspaces()) if (w.repoIds.includes(repoId)) for (const r of w.repoIds) out.add(r);
  return [...out];
}

/** Who is filing: the caller's own task (null for a server-side creator), its run, its reach and trust. */
export interface FilerContext {
  runId: string | null;
  filer: Task | null;
  reach: string[];
  untrusted: boolean;
}

export async function filerContext(storage: Storage, run: { id: string; repoId: string | null }, filer: Task | null): Promise<FilerContext> {
  const untrusted = filer ? (await storage.untrustedTaskIds([filer.id])).has(filer.id) : false;
  return { runId: run.id, filer, reach: await reachRepoIds(storage, run.repoId), untrusted };
}

const isOpen = (t: Pick<Task, 'status'>) => !TERMINAL_TASK_STATUSES.includes(t.status);
const blockedSplitRoot = (t: Pick<Task, 'status' | 'waitFor'>) => t.status === 'blocked' && !t.waitFor;

export type JoinCheck =
  | { ok: true; root: Task; members: Task[] }
  | { ok: false; code: 403 | 404 | 409; error: string }
  /** allowed in reach, but not for this filer's trust — file ungrouped instead */
  | { ok: false; downgrade: string; root: Task };

export const JOIN_BLOCKED_ROOT =
  "that group's root is a blocked split parent, which waits on every child — agents may not add to one (a split sibling uses linkToParent); file it with {\"new\": \"<name>\"} instead";
export const JOIN_FULL = `that group already has ${AGENT_GROUP_MAX_MEMBERS} members — file it with {"new": "<name>"} instead`;
export const JOIN_OUT_OF_REACH =
  "that group's root is outside your reach — you may join groups rooted in your repo, your shared space's repos or your workspaces' repos, or your own task's group";
export const JOIN_TRUST_DOWNGRADE =
  'not joined: that group holds tasks of a different trust (a filing from a tainted shift, a Sentry issue or a job never shares a group with trusted tasks, and the reverse) — filed ungrouped instead';

/**
 * May `ctx` hang a new task under the group of `id` (a member's or the
 * group's own id)? Finished groups are allowed: follow-up work on landed work.
 */
export async function checkJoin(storage: Storage, ctx: FilerContext, id: string): Promise<JoinCheck> {
  const target = await storage.getTask(id);
  if (!target) return { ok: false, code: 404, error: 'no task or group with that id — address it by its exact full id (GET /api/agent/groups lists them)' };
  const root = target.groupId === target.id ? target : await storage.getTask(target.groupId);
  if (!root) return { ok: false, code: 404, error: 'that group has no root any more — file it with {"new": "<name>"}' };
  const members = await storage.listTasks({ groupId: root.id });
  const own = ctx.filer?.groupId === root.id;
  const mine = ctx.runId !== null && members.some((m) => m.createdByRun === ctx.runId);
  if (!own && !mine && !(root.repoId && ctx.reach.includes(root.repoId))) return { ok: false, code: 403, error: JOIN_OUT_OF_REACH };
  if (blockedSplitRoot(root)) return { ok: false, code: 409, error: JOIN_BLOCKED_ROOT };
  if (members.length >= AGENT_GROUP_MAX_MEMBERS) return { ok: false, code: 409, error: JOIN_FULL };
  const untrusted = await storage.untrustedTaskIds(members.map((m) => m.id));
  if (!trustCompatible(ctx.untrusted, members.length, untrusted.size)) return { ok: false, downgrade: JOIN_TRUST_DOWNGRADE, root };
  return { ok: true, root, members };
}

/** What the create will do — `parentId`/`rootGroupName` plus the audited record and a note for the agent. */
export type GroupPlan =
  | { kind: 'join'; rootId: string; record: GroupDecisionRecord; note: string | null }
  | { kind: 'new'; name: string; forceNew: boolean; record: GroupDecisionRecord; note: string | null }
  | { kind: 'none'; record: GroupDecisionRecord; note: string | null }
  | { kind: 'refuse'; code: number; error: string };

export type AgentGroupRequest = GroupRequest & { forceNew?: boolean };

/** Earlier filings of this run in `repoId`, newest first. */
async function runFilings(storage: Storage, runId: string, repoId: string): Promise<Task[]> {
  return (await storage.listTasks({ repoId }))
    .filter((t) => t.createdByRun === runId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/** A task on its own on purpose: a root with no name and nobody under it. */
async function loneRoot(storage: Storage, t: Task): Promise<boolean> {
  if (t.groupId !== t.id || t.groupName) return false;
  return (await storage.listTasks({ groupId: t.id })).length <= 1;
}

/** "a 2nd ungrouped filing" hint (§ Agent filings, edge case 1). */
async function secondUngroupedNote(storage: Storage, ctx: FilerContext, repoId: string): Promise<string | null> {
  if (!ctx.runId) return null;
  for (const t of await runFilings(storage, ctx.runId, repoId)) {
    if (await loneRoot(storage, t)) {
      return `this is your second ungrouped filing in this repo — if it belongs with ${t.id} ("${t.title}"), file related work with {"new": "<name>"} and move the first one in: POST /api/agent/tasks/${t.id}/move {"place": "group", "targetId": "<new task id>"}`;
    }
  }
  return null;
}

/**
 * The plan for `POST /api/agent/tasks`'s `group` (or its omission) filing into
 * `targetRepoId`. An omitted group never refuses — a 400 would burn a turn and
 * break agents with stale instructions — it takes the deterministic default:
 * (1) the group of this run's previous filing in the same repo (when that one
 * was grouped), (2) the caller's own group when it has ≥ 2 members and a name,
 * (3) ungrouped.
 */
export async function planAgentGroup(
  storage: Storage,
  ctx: FilerContext,
  req: AgentGroupRequest | undefined,
  targetRepoId: string,
): Promise<GroupPlan> {
  if (req && 'join' in req) {
    const c = await checkJoin(storage, ctx, req.join);
    if (c.ok) return { kind: 'join', rootId: c.root.id, record: { decision: 'joined', groupId: c.root.id, name: c.root.groupName }, note: null };
    if ('downgrade' in c) {
      return {
        kind: 'none',
        record: { decision: 'ungrouped', reason: 'join downgraded for trust', downgraded: c.downgrade },
        note: c.downgrade,
      };
    }
    return { kind: 'refuse', code: c.code, error: c.error };
  }
  if (req && 'new' in req) {
    return { kind: 'new', name: req.new, forceNew: !!req.forceNew, record: { decision: 'new', name: req.new }, note: null };
  }
  if (req && 'ungrouped' in req) {
    return { kind: 'none', record: { decision: 'ungrouped', reason: req.ungrouped }, note: await secondUngroupedNote(storage, ctx, targetRepoId) };
  }

  // Omitted — the default rules, in order.
  const omitted = 'no "group" given (it is required — see § Grouping tasks in the instructions)';
  if (ctx.runId) {
    const prev = (await runFilings(storage, ctx.runId, targetRepoId))[0];
    if (prev && !(await loneRoot(storage, prev))) {
      const c = await checkJoin(storage, ctx, prev.groupId);
      if (c.ok) {
        return {
          kind: 'join',
          rootId: c.root.id,
          record: { decision: 'joined', groupId: c.root.id, name: c.root.groupName, defaulted: 'previous-filing' },
          note: `${omitted}: joined the group of your previous filing ${prev.id} ("${groupLabel(c.root)}")`,
        };
      }
    }
  }
  const own = ctx.filer;
  if (own) {
    const root = own.groupId === own.id ? own : await storage.getTask(own.groupId);
    if (root?.groupName && (await storage.listTasks({ groupId: root.id })).length >= 2) {
      const c = await checkJoin(storage, ctx, root.id);
      if (c.ok) {
        return {
          kind: 'join',
          rootId: c.root.id,
          record: { decision: 'joined', groupId: c.root.id, name: c.root.groupName, defaulted: 'own-group' },
          note: `${omitted}: joined your own task's group "${c.root.groupName}"`,
        };
      }
    }
  }
  const second = await secondUngroupedNote(storage, ctx, targetRepoId);
  return {
    kind: 'none',
    record: { decision: 'ungrouped', reason: 'defaulted: no grouped previous filing and no named own group', defaulted: 'ungrouped' },
    note: `${omitted}: filed ungrouped${second ? ` — ${second}` : ''}`,
  };
}

/** One summary row per group — the shape of `GET /api/agent/groups`. */
export async function summarizeGroup(
  storage: Storage,
  ctx: FilerContext,
  root: Task,
  members: Task[],
  repoNames: Map<string, string>,
): Promise<AgentGroupSummary> {
  const untrusted = await storage.untrustedTaskIds(members.map((m) => m.id));
  const inReach = (root.repoId && ctx.reach.includes(root.repoId)) || ctx.filer?.groupId === root.id;
  const joinRefusal = !inReach
    ? JOIN_OUT_OF_REACH
    : blockedSplitRoot(root)
      ? JOIN_BLOCKED_ROOT
      : members.length >= AGENT_GROUP_MAX_MEMBERS
        ? JOIN_FULL
        : !trustCompatible(ctx.untrusted, members.length, untrusted.size)
          ? JOIN_TRUST_DOWNGRADE
          : null;
  const repos = [...new Set(members.map((m) => m.repoId).filter((r): r is string => !!r))].map((r) => repoNames.get(r) ?? r);
  return {
    id: root.id,
    name: groupLabel(root),
    named: !!root.groupName,
    repos,
    members: members.length,
    open: members.filter(isOpen).length,
    rootStatus: root.status,
    lastActivity: members.reduce((m, t) => (t.updatedAt > m ? t.updatedAt : m), root.updatedAt),
    joinRefusal,
  };
}

/**
 * OPEN groups (≥ 1 non-terminal member) touching `repoIds`, most recently
 * active first. A "group" is a tree of ≥ 2 tasks or a named root; a lone
 * unnamed task is not listed. `q` matches the label normalised.
 */
export async function listOpenGroups(
  storage: Storage,
  ctx: FilerContext,
  opts: { repoIds: string[]; q?: string; limit?: number },
): Promise<AgentGroupSummary[]> {
  if (opts.repoIds.length === 0) return [];
  // One read of every task: a group's members may sit outside the scope
  // (trees span repos), and a per-group read would be one query per lone task.
  const byGroup = new Map<string, Task[]>();
  for (const t of await storage.listTasks()) {
    const g = byGroup.get(t.groupId);
    if (g) g.push(t);
    else byGroup.set(t.groupId, [t]);
  }
  const scope = new Set(opts.repoIds);
  const q = opts.q ? normalizeGroupName(opts.q) : '';
  const repoNames = new Map((await storage.listRepos()).map((r) => [r.id, r.name]));
  const candidates: { root: Task; members: Task[]; last: string }[] = [];
  for (const [groupId, members] of byGroup) {
    const root = members.find((t) => t.id === groupId);
    if (!root) continue;
    if (members.length < 2 && !root.groupName) continue;
    if (!members.some(isOpen)) continue;
    if (!members.some((m) => m.repoId && scope.has(m.repoId))) continue;
    if (q && !normalizeGroupName(groupLabel(root)).includes(q)) continue;
    candidates.push({ root, members, last: members.reduce((m, t) => (t.updatedAt > m ? t.updatedAt : m), root.updatedAt) });
  }
  candidates.sort((a, b) => b.last.localeCompare(a.last));
  const out: AgentGroupSummary[] = [];
  for (const c of candidates.slice(0, opts.limit ?? 50)) out.push(await summarizeGroup(storage, ctx, c.root, c.members, repoNames));
  return out;
}

/** Office / job / shared-note: join `id`'s group if this filer may, else null with the reason. */
export async function serverJoin(storage: Storage, ctx: FilerContext, id: string): Promise<{ rootId: string } | { reason: string }> {
  const c = await checkJoin(storage, ctx, id);
  if (c.ok) return { rootId: c.root.id };
  return { reason: 'downgrade' in c ? c.downgrade : c.error };
}
