import type { Run } from '@tm/shared';

/**
 * Per-task views of the runs list, built once per `runs` array
 * (docs/spa-performance.md § Row lookups). The list is replaced, never
 * mutated, on every run event (state.tsx), so the array itself is the cache
 * key: every row of one render shares one index instead of each scanning all
 * ~1700 runs. Order is the list's own (started_at DESC), so a `find` over a
 * task's slice picks exactly the run a `find` over the whole list did.
 */
type Indexed = Pick<Run, 'taskId'> & Partial<Pick<Run, 'kind' | 'subjectId' | 'status'>>;

interface RunIndex {
  byTask: Map<string, Indexed[]>;
  liveReview: Map<string, Indexed>;
}

const cache = new WeakMap<readonly Indexed[], RunIndex>();
const NONE: readonly never[] = [];

function indexOf(runs: readonly Indexed[]): RunIndex {
  let ix = cache.get(runs);
  if (ix) return ix;
  ix = { byTask: new Map(), liveReview: new Map() };
  for (const r of runs) {
    if (r.taskId) {
      const list = ix.byTask.get(r.taskId);
      if (list) list.push(r);
      else ix.byTask.set(r.taskId, [r]);
    }
    if (r.kind === 'review' && r.status === 'running' && r.subjectId && !ix.liveReview.has(r.subjectId)) {
      ix.liveReview.set(r.subjectId, r);
    }
  }
  cache.set(runs, ix);
  return ix;
}

/** `runs.filter((r) => r.taskId === taskId)`, from the shared index */
export function runsOfTask<T extends Indexed>(runs: readonly T[], taskId: string): readonly T[] {
  return (indexOf(runs).byTask.get(taskId) as T[] | undefined) ?? NONE;
}

/** the first running review run about `taskId`, in list order */
export function liveReviewOf<T extends Indexed>(runs: readonly T[], taskId: string): T | undefined {
  return indexOf(runs).liveReview.get(taskId) as T | undefined;
}
