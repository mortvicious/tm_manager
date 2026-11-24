import {
  jobRunNeedsHuman,
  type Feature,
  type FeatureStatus,
  type InboxItem,
  type Job,
  type JobRun,
  type OfficeProposal,
  type ShellSession,
  type Task,
} from '@tm/shared';

/**
 * The desktop sidebar's live counters (docs/magma.md § 12, docs/design.md
 * § Side-nav counters): pure functions over the store's plain arrays, no DOM,
 * no React. Every count is scoped like the page it links to: `scope` is the
 * current workspace's repo set (`useWorkspace().repoIds`), null = All, and a
 * repo-less item is in every scope — the same rule as `inScopeRepo` in
 * workspace.ts and `buildInbox`.
 *
 * The `cached*` wrappers memoise per (array identity, scope identity) in
 * WeakMaps, like runIndex.ts: the store replaces an array on every change and
 * never mutates it, so a publish that did not touch `tasks` (a `run.activity`
 * frame) answers every task counter from the cache.
 */

export type RepoScope = ReadonlySet<string> | null;

function inScopeRepo(scope: RepoScope, repoId: string | null | undefined): boolean {
  return scope === null || repoId == null || scope.has(repoId);
}

export interface BoardCounts {
  /** running or waiting: a live session holding its slot */
  live: number;
  drafts: number;
}

/** the board's rows (`useBoardTasks()` = in scope and not hidden): live sessions and drafts */
export function boardCounts(tasks: readonly Pick<Task, 'status' | 'repoId' | 'hiddenAt'>[], scope: RepoScope): BoardCounts {
  let live = 0;
  let drafts = 0;
  for (const t of tasks) {
    if (t.hiddenAt || !inScopeRepo(scope, t.repoId)) continue;
    if (t.status === 'running' || t.status === 'waiting') live++;
    else if (t.status === 'draft') drafts++;
  }
  return { live, drafts };
}

/** the Queue page's two lists together (custom + global): every queued task in scope, held and hidden included */
export function queueCount(tasks: readonly Pick<Task, 'status' | 'repoId'>[], scope: RepoScope): number {
  let n = 0;
  for (const t of tasks) if (t.status === 'queued' && inScopeRepo(scope, t.repoId)) n++;
  return n;
}

/** a feature is in flight unless it is still a draft or has ended */
const FEATURE_NOT_IN_FLIGHT: ReadonlySet<FeatureStatus> = new Set(['draft', 'done', 'failed', 'cancelled']);

/** features in flight: analyzing, proposed, approved, running, paused, review */
export function featuresCount(features: readonly Pick<Feature, 'status' | 'repoId'>[], scope: RepoScope): number {
  let n = 0;
  for (const f of features) if (!FEATURE_NOT_IN_FLIGHT.has(f.status) && inScopeRepo(scope, f.repoId)) n++;
  return n;
}

export interface JobsCounts {
  running: number;
  /** jobs with an unacknowledged attention/error run — the Inbox `job` kind, one per job */
  needsYou: number;
}

export function jobsCounts(
  jobs: readonly Pick<Job, 'id' | 'status' | 'repoId'>[],
  jobRuns: readonly Pick<JobRun, 'jobId' | 'verdict' | 'acknowledgedAt'>[],
  scope: RepoScope,
): JobsCounts {
  let running = 0;
  const inScope = new Set<string>();
  for (const j of jobs) {
    if (!inScopeRepo(scope, j.repoId)) continue;
    inScope.add(j.id);
    if (j.status === 'running') running++;
  }
  const flagged = new Set<string>();
  for (const r of jobRuns) if (inScope.has(r.jobId) && jobRunNeedsHuman(r)) flagged.add(r.jobId);
  return { running, needsYou: flagged.size };
}

export interface InboxCounts {
  /** what waits on the human (`decisions()`: stale drafts left out) */
  decisions: number;
  /** of those, a question or a needs-attention run */
  urgent: number;
}

/** over `useInbox()`'s already scoped list */
export function inboxCounts(items: readonly Pick<InboxItem, 'kind'>[]): InboxCounts {
  let decisions = 0;
  let urgent = 0;
  for (const i of items) {
    if (i.kind === 'stale-draft') continue;
    decisions++;
    if (i.kind === 'question' || i.kind === 'attention') urgent++;
  }
  return { decisions, urgent };
}

/**
 * Pending office proposals, scoped as the Inbox scopes them: by the repo when
 * the proposal names one, else by its office's workspace (`workspaceId` = the
 * current workspace's id, null = All).
 */
export function officeProposalsCount(
  proposals: readonly Pick<OfficeProposal, 'status' | 'repoId' | 'workspaceId'>[],
  scope: RepoScope,
  workspaceId: string | null,
): number {
  let n = 0;
  for (const p of proposals) {
    if (p.status !== 'pending') continue;
    if (p.repoId ? inScopeRepo(scope, p.repoId) : scope === null || workspaceId === null || p.workspaceId === workspaceId) n++;
  }
  return n;
}

/** live login shells on the Terminals page */
export function terminalsCount(shells: readonly Pick<ShellSession, 'status' | 'repoId'>[], scope: RepoScope): number {
  let n = 0;
  for (const s of shells) if (s.status === 'running' && inScopeRepo(scope, s.repoId)) n++;
  return n;
}

/** a counter's text: '99+' above 99 */
export function formatCount(n: number): string {
  return n > 99 ? '99+' : String(n);
}

/**
 * The link's accessible name: the label, then only the non-zero parts —
 * "Board, 2 running, 54 drafts", "Board, 54 drafts", "Queue" at zero.
 */
export function navCountLabel(label: string, parts: readonly (readonly [number, string])[]): string {
  const said = parts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`);
  return said.length ? `${label}, ${said.join(', ')}` : label;
}

// ---- memoised per (array, scope) ------------------------------------------

/** the WeakMap key standing for "All" (a null scope) */
const ALL = {};

/**
 * `fn(arr, scope)` cached on the array's identity and then the scope's. The
 * second-level key is the scope Set itself (stable per workspace while the
 * workspace list is unchanged) or ALL.
 */
function memoByArray<A extends object, R>(fn: (arr: A, scope: RepoScope) => R): (arr: A, scope: RepoScope) => R {
  const cache = new WeakMap<A, WeakMap<object, R>>();
  return (arr, scope) => {
    let byScope = cache.get(arr);
    if (!byScope) {
      byScope = new WeakMap();
      cache.set(arr, byScope);
    }
    const key = scope ?? ALL;
    if (byScope.has(key)) return byScope.get(key)!;
    const r = fn(arr, scope);
    byScope.set(key, r);
    return r;
  };
}

export const cachedBoardCounts = memoByArray(boardCounts);
export const cachedQueueCount = memoByArray(queueCount);
export const cachedFeaturesCount = memoByArray(featuresCount);
export const cachedTerminalsCount = memoByArray(terminalsCount);

const jobsCache = new WeakMap<object, WeakMap<object, WeakMap<object, JobsCounts>>>();

/** `jobsCounts`, cached on (jobs, jobRuns, scope) identity */
export function cachedJobsCounts(
  jobs: readonly Pick<Job, 'id' | 'status' | 'repoId'>[],
  jobRuns: readonly Pick<JobRun, 'jobId' | 'verdict' | 'acknowledgedAt'>[],
  scope: RepoScope,
): JobsCounts {
  let byRuns = jobsCache.get(jobs);
  if (!byRuns) jobsCache.set(jobs, (byRuns = new WeakMap()));
  let byScope = byRuns.get(jobRuns);
  if (!byScope) byRuns.set(jobRuns, (byScope = new WeakMap()));
  const key = scope ?? ALL;
  let r = byScope.get(key);
  if (!r) byScope.set(key, (r = jobsCounts(jobs, jobRuns, scope)));
  return r;
}

const proposalsCache = new WeakMap<object, WeakMap<object, Map<string | null, number>>>();

/** `officeProposalsCount`, cached on (proposals, scope, workspace id) */
export function cachedOfficeProposalsCount(
  proposals: readonly Pick<OfficeProposal, 'status' | 'repoId' | 'workspaceId'>[],
  scope: RepoScope,
  workspaceId: string | null,
): number {
  let byScope = proposalsCache.get(proposals);
  if (!byScope) proposalsCache.set(proposals, (byScope = new WeakMap()));
  const key = scope ?? ALL;
  let byWs = byScope.get(key);
  if (!byWs) byScope.set(key, (byWs = new Map()));
  let n = byWs.get(workspaceId);
  if (n === undefined) byWs.set(workspaceId, (n = officeProposalsCount(proposals, scope, workspaceId)));
  return n;
}

// ---- the desktop sidebar's grouping ----------------------------------------

export interface NavCoverage {
  /** NAV paths no group lists — they would drop out of the sidebar */
  missing: string[];
  /** paths listed more than once */
  duplicate: string[];
  /** listed paths that are not in NAV */
  unknown: string[];
}

/** whether the sidebar's groups list every NAV path exactly once */
export function navCoverage(navPaths: readonly string[], groups: readonly { paths: readonly string[] }[]): NavCoverage {
  const nav = new Set(navPaths);
  const seen = new Set<string>();
  const duplicate: string[] = [];
  const unknown: string[] = [];
  for (const g of groups) {
    for (const p of g.paths) {
      if (seen.has(p)) duplicate.push(p);
      seen.add(p);
      if (!nav.has(p)) unknown.push(p);
    }
  }
  return { missing: navPaths.filter((p) => !seen.has(p)), duplicate, unknown };
}
