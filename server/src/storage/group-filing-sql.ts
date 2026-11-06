// Group decisions for non-human filings (docs/grouping.md § Agent filings) —
// shared verbatim by BOTH drivers, like group.ts. The reads are written as
// generators that YIELD `{sql, params}` and receive the rows back, so the
// sqlite driver can drive them synchronously inside `inTxn` and the pg driver
// asynchronously on its transaction client: one walk, two executors, no
// recursive CTE (group.ts explains why neither driver relies on one).

import { GROUP_NAME_MAX, TERMINAL_TASK_STATUSES, type NamedGroupCandidate } from '@tm/shared';
import type { NamedGroupFiling, NewTask } from './types.ts';

export interface SqlStep {
  sql: string;
  params: unknown[];
}
export type SqlWalk<T> = Generator<SqlStep, T, Record<string, unknown>[]>;

/** Filing chain bound — far above `agent.maxSpawnDepth`'s ceiling of 50. */
const MAX_HOPS = 64;
const IN_CHUNK = 400;

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** A row that is itself outside text: a tainted shift's, a Sentry issue's, a job's. */
export function rowUntrusted(r: { tainted_at?: unknown; source?: unknown }): boolean {
  return r.tainted_at != null || r.source === 'sentry' || r.source === 'job';
}

/**
 * The seed ids whose FILING CHAIN is untrusted: the task itself, or any task
 * up its `created_by_run → tm_runs.task_id` chain, is tainted / Sentry / a job
 * follow-up. Taint is not copied onto agent filings (`tainted_at` keeps its
 * office meaning), so a task filed by a tainted task's worker — or by one it
 * filed — is untrusted through this walk instead.
 */
export function* untrustedWalk(seedIds: string[]): SqlWalk<Set<string>> {
  // Read every task on the seeds' chains level by level, then decide each
  // seed by following the recorded edges (a chain may pass through another
  // seed or a shared filer, so nothing is decided while reading).
  const bad = new Map<string, boolean>();
  const filerOf = new Map<string, string | null>();
  let level = [...new Set(seedIds)];
  for (let hop = 0; hop < MAX_HOPS && level.length > 0; hop++) {
    const next = new Set<string>();
    for (let i = 0; i < level.length; i += IN_CHUNK) {
      const chunk = level.slice(i, i + IN_CHUNK);
      const rows = yield {
        sql: `SELECT t.id, t.tainted_at, t.source, r.task_id AS filer
              FROM tm_tasks t LEFT JOIN tm_runs r ON r.id = t.created_by_run
              WHERE t.id IN (${placeholders(chunk.length)})`,
        params: chunk,
      };
      for (const row of rows) {
        const id = String(row.id);
        const filer = row.filer == null ? null : String(row.filer);
        bad.set(id, rowUntrusted(row));
        filerOf.set(id, filer);
        if (filer && !bad.has(filer) && !rowUntrusted(row)) next.add(filer);
      }
    }
    level = [...next].filter((id) => !bad.has(id));
  }
  const out = new Set<string>();
  for (const seed of new Set(seedIds)) {
    const path = new Set<string>();
    for (let cur: string | null | undefined = seed; cur && !path.has(cur); cur = filerOf.get(cur)) {
      path.add(cur);
      if (bad.get(cur)) {
        out.add(seed);
        break;
      }
    }
  }
  return out;
}

/**
 * Every open-or-not NAMED root in `repoIds` whose normalised name is `key`,
 * with its member counts and trust — the input of `pickNamedGroup`. Run inside
 * the creating transaction (and, on pg, under the name's advisory lock), so
 * two filers racing on one name see each other's root.
 */
export function* namedGroupCandidates(
  repoIds: string[],
  key: string,
  normalize: (s: string) => string,
): SqlWalk<NamedGroupCandidate[]> {
  const repos = [...new Set(repoIds)];
  if (repos.length === 0) return [];
  const roots = (yield {
    sql: `SELECT id, group_name, status, wait_for, created_at FROM tm_tasks
          WHERE parent_id IS NULL AND group_name IS NOT NULL AND repo_id IN (${placeholders(repos.length)})`,
    params: repos,
  }).filter((r) => normalize(String(r.group_name)) === key);
  const out: NamedGroupCandidate[] = [];
  for (const root of roots) {
    const members = yield { sql: `SELECT id, status FROM tm_tasks WHERE group_id = ?`, params: [root.id] };
    const untrusted = yield* untrustedWalk(members.map((m) => String(m.id)));
    out.push({
      rootId: String(root.id),
      name: String(root.group_name),
      rootStatus: String(root.status),
      rootWaiting: root.wait_for != null,
      members: members.length,
      open: members.filter((m) => !TERMINAL_TASK_STATUSES.includes(m.status as never)).length,
      untrusted: untrusted.size,
      createdAt: String(root.created_at),
    });
  }
  return out;
}

/** Drive a walk on a synchronous executor (better-sqlite3). */
export function runWalkSync<T>(walk: SqlWalk<T>, all: (sql: string, params: unknown[]) => Record<string, unknown>[]): T {
  let step = walk.next(undefined as never);
  while (!step.done) step = walk.next(all(step.value.sql, step.value.params));
  return step.value;
}

/** Drive a walk on an asynchronous executor (pg). */
export async function runWalk<T>(
  walk: SqlWalk<T>,
  all: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>,
): Promise<T> {
  let step = walk.next(undefined as never);
  while (!step.done) step = walk.next(await all(step.value.sql, step.value.params));
  return step.value;
}

/** The row `createTaskInNamedGroup` inserts: under the picked root, or a new named root. */
export function namedGroupInsert(
  t: NewTask,
  g: NamedGroupFiling,
  joined: NamedGroupCandidate | null,
): NewTask {
  if (joined) {
    return {
      ...t,
      parentId: joined.rootId,
      rootGroupName: null,
      groupDecision: { ...(t.groupDecision ?? {}), decision: 'joined', joinedExisting: true, name: joined.name },
    };
  }
  return {
    ...t,
    parentId: null,
    rootGroupName: g.name,
    groupDecision: { ...(t.groupDecision ?? {}), decision: 'new', name: g.name },
  };
}

/**
 * The children a `blocked` split parent waits on (`resolveChildCompletion`):
 * its SPLIT pieces only. A feature's cards form ONE group under its first card
 * (§ Feature approval), so a split of that root has the feature's other plan
 * cards as children too — counting them would hold the root until every
 * unrelated card is terminal (and fail it with theirs). A child that is a plan
 * card of the parent's own feature never counts. COALESCE: a NULL comparison
 * must keep the row, not drop it. JS twin: `isSplitChild` in shared — edit
 * together.
 */
export const RESOLVING_CHILDREN_SQL = `SELECT c.status FROM tm_tasks c JOIN tm_tasks p ON p.id = c.parent_id
  WHERE c.parent_id = ?
    AND NOT COALESCE(c.source = 'feature' AND c.feature_id = p.feature_id, FALSE)`;

/**
 * Feature approval (docs/grouping.md § Agent filings → Feature approval): the
 * cards form ONE group named after the feature — the first card is the root
 * (carrying the name), every later card joins it flat in plan order. Claim
 * order is unchanged: a group runs in its root's slot, members by their own
 * (increasing) keys, and the phase gate still decides eligibility.
 */
export function featureCardGroup(
  feature: { title: string },
  index: number,
  rootId: string | null,
): Pick<NewTask, 'parentId' | 'rootGroupName' | 'groupDecision'> {
  if (index === 0 || !rootId) {
    const name = feature.title.trim().slice(0, GROUP_NAME_MAX) || 'Feature';
    return { parentId: null, rootGroupName: name, groupDecision: { decision: 'new', name, by: 'feature' } };
  }
  return { parentId: rootId, groupDecision: { decision: 'joined', by: 'feature' } };
}
