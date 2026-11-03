// A task's neighbourhood on the board: what the focus layer of every board
// version lights up (docs/board-versions.md § Versions control). Pure, so the
// four versions cannot disagree about what is related to what.
//
// Only tasks in the list given are related: the caller passes the board's own
// set (workspace scope, hidden tasks left out), and a parent, filer or
// dispatch partner outside it simply does not appear.

import type { Dispatch, Run, Task } from './types.ts';

export type TaskRelationKind =
  | 'parent'
  | 'child'
  | 'sibling-in-group'
  | 'filed-by'
  | 'filed'
  | 'dispatch-in'
  | 'dispatch-out';

/** The order relations are listed in, and every kind exactly once. */
export const TASK_RELATION_KINDS: readonly TaskRelationKind[] = [
  'parent',
  'child',
  'sibling-in-group',
  'filed-by',
  'filed',
  'dispatch-in',
  'dispatch-out',
];

/** What a list heading calls each kind, read from the focused task. */
export const TASK_RELATION_LABELS: Record<TaskRelationKind, string> = {
  parent: 'parent',
  child: 'subtasks',
  'sibling-in-group': 'siblings in group',
  'filed-by': 'filed by',
  filed: 'filed',
  'dispatch-in': 'dispatch from',
  'dispatch-out': 'dispatch to',
};

export type RelationTask = Pick<Task, 'id' | 'parentId' | 'createdByRun'>;
export type RelationDispatch = Pick<Dispatch, 'id' | 'fromTaskId' | 'toTaskId' | 'intent' | 'status' | 'createdAt'>;
export type RelationRun = Pick<Run, 'id' | 'taskId'>;

export interface TaskRelation {
  kind: TaskRelationKind;
  taskId: string;
  /** dispatch kinds only: every dispatch between the two in that direction, oldest first */
  dispatches?: RelationDispatch[];
}

export interface TaskNeighbourhood {
  taskId: string;
  /** grouped by kind in `TASK_RELATION_KINDS` order, then in the order the tasks were given */
  relations: TaskRelation[];
  /** every related task id (a task related twice — parent AND filer — is here once); the task itself excluded */
  ids: Set<string>;
}

export interface RelationInput<T extends RelationTask = RelationTask> {
  tasks: readonly T[];
  dispatches?: readonly RelationDispatch[];
  /** maps `createdByRun` to the task whose worker filed it; aux runs carry no task and relate nothing */
  runs?: readonly RelationRun[];
}

export interface RelationIndex {
  /** null for a task not in the list */
  neighbourhood(taskId: string): TaskNeighbourhood | null;
  /** the task whose worker run filed this one, when that task is in the list */
  filerOf(taskId: string): string | null;
}

/** Build once per board render; `neighbourhood` is then cheap per click. */
export function buildRelationIndex<T extends RelationTask>(input: RelationInput<T>): RelationIndex {
  const order = new Map<string, number>();
  input.tasks.forEach((t, i) => order.set(t.id, i));
  const has = (id: string | null | undefined): id is string => id != null && order.has(id);

  const runTask = new Map<string, string>();
  for (const r of input.runs ?? []) if (r.taskId) runTask.set(r.id, r.taskId);

  const children = new Map<string, string[]>();
  const filed = new Map<string, string[]>();
  const filer = new Map<string, string>();
  const push = (m: Map<string, string[]>, k: string, v: string) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  const byId = new Map<string, T>();
  for (const t of input.tasks) {
    byId.set(t.id, t);
    if (has(t.parentId) && t.parentId !== t.id) push(children, t.parentId, t.id);
    const by = t.createdByRun ? runTask.get(t.createdByRun) : undefined;
    if (has(by) && by !== t.id) {
      filer.set(t.id, by);
      push(filed, by, t.id);
    }
  }

  // dispatches per ordered pair; self-dispatch and partners outside the list dropped
  const out = new Map<string, Map<string, RelationDispatch[]>>();
  const into = new Map<string, Map<string, RelationDispatch[]>>();
  const add = (m: Map<string, Map<string, RelationDispatch[]>>, a: string, b: string, d: RelationDispatch) => {
    let inner = m.get(a);
    if (!inner) m.set(a, (inner = new Map()));
    const list = inner.get(b);
    if (list) list.push(d);
    else inner.set(b, [d]);
  };
  const ds = [...(input.dispatches ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const d of ds) {
    if (d.fromTaskId === d.toTaskId || !has(d.fromTaskId) || !has(d.toTaskId)) continue;
    add(out, d.fromTaskId, d.toTaskId, d);
    add(into, d.toTaskId, d.fromTaskId, d);
  }

  const byOrder = (a: string, b: string) => (order.get(a) ?? 0) - (order.get(b) ?? 0);

  return {
    filerOf: (id) => filer.get(id) ?? null,
    neighbourhood(id) {
      const t = byId.get(id);
      if (!t) return null;
      const relations: TaskRelation[] = [];
      const ids = new Set<string>();
      const rel = (kind: TaskRelationKind, list: Iterable<string>) => {
        for (const other of [...list].filter((o) => o !== id).sort(byOrder)) {
          relations.push({ kind, taskId: other });
          ids.add(other);
        }
      };
      const parent = has(t.parentId) && t.parentId !== id ? t.parentId : null;
      rel('parent', parent ? [parent] : []);
      rel('child', children.get(id) ?? []);
      // siblings: the same parent, so the same group by construction
      rel('sibling-in-group', parent ? (children.get(parent) ?? []) : []);
      const by = filer.get(id);
      rel('filed-by', by ? [by] : []);
      rel('filed', filed.get(id) ?? []);
      for (const [kind, m] of [
        ['dispatch-in', into.get(id)],
        ['dispatch-out', out.get(id)],
      ] as const) {
        if (!m) continue;
        for (const other of [...m.keys()].sort(byOrder)) {
          relations.push({ kind, taskId: other, dispatches: m.get(other) });
          ids.add(other);
        }
      }
      return { taskId: id, relations, ids };
    },
  };
}

/** One-shot form of `buildRelationIndex(input).neighbourhood(taskId)`. */
export function taskNeighbourhood(input: RelationInput, taskId: string): TaskNeighbourhood | null {
  return buildRelationIndex(input).neighbourhood(taskId);
}
