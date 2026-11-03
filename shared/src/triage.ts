// Agent-draft triage (docs/inbox.md § Draft triage): every idle agent-filed
// draft in scope, grouped by the task that filed it or by repo, so a pile of
// follow-ups is judged per origin rather than one stale row at a time. Pure —
// the SPA runs it over what useApp() already holds; nothing here acts.
import { DEFAULT_SETTINGS, isExternalTask, isStaleDraft, type Run, type Task, type TaskSource } from './types.ts';

export interface TriageDraft {
  task: Task;
  /** whole days since the draft was filed (createdAt, never updatedAt — like isStaleDraft) */
  ageDays: number;
  /** what the Inbox's stale-draft kind would list (isStaleDraft) */
  stale: boolean;
  /** Keep pressed and still in force (inboxKeptUntil in the future) */
  kept: boolean;
}

/**
 * - `filer`: the task whose run filed these (`createdByRun` → `Run.taskId`)
 * - `run-unknown`: `createdByRun` names a run that is gone (or has no task)
 * - `filer-deleted`: the run is known, its task is not
 * - `source`: external by source (sentry, auto…) with no filing run
 * - `repo`: the byRepo grouping
 */
export type TriageGroupKind = 'filer' | 'run-unknown' | 'filer-deleted' | 'source' | 'repo';

export interface TriageGroup {
  key: string;
  kind: TriageGroupKind;
  label: string;
  /** the filing task (kind `filer` only) */
  filer: Task | null;
  /** the filer's repo (`filer`), the repo (`repo`), else null */
  repoId: string | null;
  source: TaskSource | null;
  /** oldest filed first */
  drafts: TriageDraft[];
}

export interface TriageInput {
  tasks: readonly Task[];
  runs: readonly Pick<Run, 'id' | 'taskId'>[];
  /** null/absent = every repo; an EMPTY set = nothing; otherwise the set plus repo-less drafts (the workspace rule) */
  repoIds?: ReadonlySet<string> | null;
  includeHidden?: boolean;
  now?: number;
  /** `inbox.staleDraftDays` */
  staleDraftDays?: number;
}

export interface Triage {
  drafts: TriageDraft[];
  byFiler: TriageGroup[];
  byRepo: TriageGroup[];
}

const DAY_MS = 86_400_000;

export function triageDrafts(input: TriageInput): Triage {
  const now = input.now ?? Date.now();
  const days = input.staleDraftDays ?? DEFAULT_SETTINGS['inbox.staleDraftDays'];
  const scope = input.repoIds ?? null;
  const inScope = (repoId: string | null) => !scope || (scope.size > 0 && (repoId == null || scope.has(repoId)));
  const drafts: TriageDraft[] = input.tasks
    .filter((t) => t.status === 'draft' && isExternalTask(t) && (input.includeHidden || !t.hiddenAt) && inScope(t.repoId))
    .sort(oldestFirst)
    .map((task) => ({
      task,
      ageDays: Math.max(0, Math.floor((now - Date.parse(task.createdAt)) / DAY_MS)),
      stale: isStaleDraft(task, now, days),
      kept: !!task.inboxKeptUntil && Date.parse(task.inboxKeptUntil) > now,
    }));

  const runs = new Map(input.runs.map((r) => [r.id, r]));
  const tasks = new Map(input.tasks.map((t) => [t.id, t]));
  const byFiler = new Map<string, TriageGroup>();
  const byRepo = new Map<string, TriageGroup>();
  const add = (into: Map<string, TriageGroup>, head: Omit<TriageGroup, 'drafts'>, d: TriageDraft) => {
    let g = into.get(head.key);
    if (!g) into.set(head.key, (g = { ...head, drafts: [] }));
    g.drafts.push(d);
  };

  for (const d of drafts) {
    const t = d.task;
    add(byFiler, filerHead(t, runs, tasks), d);
    add(
      byRepo,
      { key: `repo:${t.repoId ?? ''}`, kind: 'repo', label: t.repoId ?? 'no repo', filer: null, repoId: t.repoId, source: null },
      d,
    );
  }
  return { drafts, byFiler: ordered(byFiler), byRepo: ordered(byRepo) };
}

function filerHead(
  t: Task,
  runs: Map<string, Pick<Run, 'id' | 'taskId'>>,
  tasks: Map<string, Task>,
): Omit<TriageGroup, 'drafts'> {
  const none = { filer: null, repoId: null, source: null };
  if (!t.createdByRun) return { ...none, key: `source:${t.source}`, kind: 'source', label: `source: ${t.source}`, source: t.source };
  const run = runs.get(t.createdByRun);
  if (!run || !run.taskId) return { ...none, key: 'run-unknown', kind: 'run-unknown', label: 'filer run unknown' };
  const filer = tasks.get(run.taskId);
  if (!filer) return { ...none, key: 'filer-deleted', kind: 'filer-deleted', label: 'filer task deleted' };
  return { key: `filer:${filer.id}`, kind: 'filer', label: filer.title, filer, repoId: filer.repoId, source: null };
}

function oldestFirst(a: Task, b: Task): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/** biggest first, then the one whose oldest draft is oldest (each group's drafts are already oldest first) */
function ordered(groups: Map<string, TriageGroup>): TriageGroup[] {
  return [...groups.values()].sort(
    (a, b) => b.drafts.length - a.drafts.length || oldestFirst(a.drafts[0].task, b.drafts[0].task) || a.key.localeCompare(b.key),
  );
}
