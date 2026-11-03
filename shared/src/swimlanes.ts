// The Swimlanes board version's layout (docs/board-versions.md § Swimlanes):
// pure, so the view memoises it and the tests pin it. A 2-D table: one lane
// per group (or repo, or feature), one column per stage. A lane's header
// counts every member (landed/total and the per-status bar); the cells show
// what the finished filter lets through. Inside a cell tasks keep tree
// pre-order, so a child sits right under its parent, indented by how many of
// its ancestors share the cell.

import type { Task, TaskStatus } from './types.ts';
import { groupColorSlot, groupLabel } from './types.ts';

export type SwimlaneStage = 'queued' | 'working' | 'review' | 'stuck' | 'landed';
export type SwimlaneLaneBy = 'group' | 'repo' | 'feature';

export const SWIMLANE_STAGES: readonly { id: SwimlaneStage; label: string; statuses: readonly TaskStatus[] }[] = [
  { id: 'queued', label: 'Queued', statuses: ['draft', 'queued'] },
  { id: 'working', label: 'Working', statuses: ['running', 'waiting'] },
  { id: 'review', label: 'Review', statuses: ['review'] },
  { id: 'stuck', label: 'Stuck', statuses: ['failed', 'blocked'] },
  { id: 'landed', label: 'Landed', statuses: ['done', 'published'] },
];

/** The order of the lane header's status bar (the mockup's): landed first, stuck last. */
export const SWIMLANE_BAR_ORDER: readonly TaskStatus[] = ['done', 'published', 'review', 'running', 'waiting', 'queued', 'draft', 'failed', 'blocked'];

/** A landed task stays in the Landed column this long unless the filter is `all`. */
export const SWIMLANE_RECENT_MS = 3 * 24 * 3600_000;

/** How many cards a cell shows before a "+n more" (the view may unfold it). */
export const SWIMLANE_CELL_CAP = 30;

/** The lane key of tasks that have no group / repo / feature. */
export const SWIMLANE_LOOSE = 'loose';

/** The stage a status sits in; `cancelled` is in none (the view leaves it out). */
export function swimlaneStage(status: TaskStatus): SwimlaneStage | null {
  for (const s of SWIMLANE_STAGES) if (s.statuses.includes(status)) return s.id;
  return null;
}

export type SwimlaneTask = Pick<
  Task,
  'id' | 'title' | 'parentId' | 'groupId' | 'groupName' | 'groupColor' | 'status' | 'sortOrder' | 'repoId' | 'featureId' | 'updatedAt'
>;

export interface SwimlaneInput {
  tasks: readonly SwimlaneTask[];
  laneBy: SwimlaneLaneBy;
  repos: readonly { id: string; name: string }[];
  features: readonly { id: string; title: string; repoId: string | null }[];
  /** false: only landed tasks updated within `recentMs`, and lanes with nothing left to show are dropped */
  showAll: boolean;
  now: number;
  recentMs?: number;
  /** a group root that is not in `tasks` (hidden, out of scope): its name and colour still label the lane */
  rootOf?: (groupId: string) => Pick<SwimlaneTask, 'title' | 'groupName' | 'groupId' | 'groupColor' | 'repoId' | 'featureId'> | undefined;
}

export interface SwimlaneCard {
  id: string;
  /** how many of its ancestors sit in the same cell (0 = flush) */
  depth: number;
}

export interface SwimlaneLane {
  /** group id / repo id / feature id, or `SWIMLANE_LOOSE` */
  id: string;
  label: string;
  /** a second line: the feature a group belongs to */
  sub: string | null;
  /** colour slot 1..7; null for the loose lane */
  colorSlot: number | null;
  /** the lane's own repo (cards in another repo get a chip); null = none */
  repoId: string | null;
  loose: boolean;
  total: number;
  landed: number;
  /** per-status counts in `SWIMLANE_BAR_ORDER`, zeros left out */
  segments: { status: TaskStatus; count: number }[];
  cells: Record<SwimlaneStage, SwimlaneCard[]>;
}

export interface SwimlaneLayout {
  lanes: SwimlaneLane[];
  /** cards shown per column (after the finished filter) */
  stageCounts: Record<SwimlaneStage, number>;
}

const LANDED: readonly TaskStatus[] = ['done', 'published'];
const emptyCells = (): Record<SwimlaneStage, SwimlaneCard[]> => ({ queued: [], working: [], review: [], stuck: [], landed: [] });

function mostCommon(values: (string | null)[]): string | null {
  const n = new Map<string, number>();
  let best: string | null = null;
  for (const v of values) {
    if (!v) continue;
    const c = (n.get(v) ?? 0) + 1;
    n.set(v, c);
    if (best === null || c > n.get(best)!) best = v;
  }
  return best;
}

/** Tree pre-order over the whole set: groups by their root's queue key, a parent before its subtasks (by `sortOrder`). */
function preorder(tasks: readonly SwimlaneTask[]): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const groupKey = new Map<string, number>();
  for (const t of tasks) {
    const root = byId.get(t.groupId);
    const k = root ? root.sortOrder : Math.min(groupKey.get(t.groupId) ?? Infinity, t.sortOrder);
    groupKey.set(t.groupId, k);
  }
  const kids = new Map<string, SwimlaneTask[]>();
  const roots: SwimlaneTask[] = [];
  for (const t of tasks) {
    if (t.parentId && byId.has(t.parentId)) {
      const l = kids.get(t.parentId);
      if (l) l.push(t);
      else kids.set(t.parentId, [t]);
    } else roots.push(t);
  }
  const bySort = (a: SwimlaneTask, b: SwimlaneTask) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id);
  roots.sort((a, b) => groupKey.get(a.groupId)! - groupKey.get(b.groupId)! || a.groupId.localeCompare(b.groupId) || bySort(a, b));
  const order = new Map<string, number>();
  const stack = [...roots].reverse();
  while (stack.length) {
    const t = stack.pop()!;
    if (order.has(t.id)) continue; // a parent cycle in bad data is visited once
    order.set(t.id, order.size);
    const ch = kids.get(t.id);
    if (ch) stack.push(...[...ch].sort(bySort).reverse());
  }
  // anything a cycle kept unreachable still gets a place
  for (const t of tasks) if (!order.has(t.id)) order.set(t.id, order.size);
  return order;
}

interface LaneSpec {
  id: string;
  label: string;
  sub: string | null;
  colorSlot: number | null;
  repoId: string | null;
  loose: boolean;
  /** live lanes first by this key, then finished lanes, newest first */
  key: number | string;
  members: SwimlaneTask[];
}

export function layoutSwimlanes({ tasks, laneBy, repos, features, showAll, now, recentMs = SWIMLANE_RECENT_MS, rootOf }: SwimlaneInput): SwimlaneLayout {
  const all = tasks.filter((t) => swimlaneStage(t.status) !== null);
  const byId = new Map(all.map((t) => [t.id, t]));
  const order = preorder(all);
  const repoName = new Map(repos.map((r) => [r.id, r.name]));
  const featureById = new Map(features.map((f) => [f.id, f]));

  const buckets = new Map<string, SwimlaneTask[]>();
  const keyOf = (t: SwimlaneTask): string | null => (laneBy === 'group' ? t.groupId : laneBy === 'repo' ? t.repoId : t.featureId);
  for (const t of all) {
    const k = keyOf(t) ?? SWIMLANE_LOOSE;
    const l = buckets.get(k);
    if (l) l.push(t);
    else buckets.set(k, [t]);
  }

  const specs: LaneSpec[] = [];
  const loose: SwimlaneTask[] = [];
  for (const [k, members] of buckets) {
    // a single task is not a group: it joins the shared lane at the bottom
    if (k === SWIMLANE_LOOSE || (laneBy === 'group' && members.length < 2)) {
      loose.push(...members);
      continue;
    }
    const minOrder = Math.min(...members.map((t) => order.get(t.id)!));
    if (laneBy === 'group') {
      const root = byId.get(k) ?? rootOf?.(k);
      const feature = root?.featureId ? featureById.get(root.featureId) : undefined;
      specs.push({
        id: k,
        label: groupLabel(root, 'Group'),
        sub: feature?.title ?? null,
        colorSlot: groupColorSlot(root, k),
        repoId: root?.repoId ?? mostCommon(members.map((t) => t.repoId)),
        loose: false,
        key: minOrder,
        members,
      });
    } else if (laneBy === 'repo') {
      const name = repoName.get(k) ?? 'repo';
      specs.push({ id: k, label: name, sub: null, colorSlot: groupColorSlot(undefined, k), repoId: k, loose: false, key: name.toLowerCase(), members });
    } else {
      const f = featureById.get(k);
      specs.push({
        id: k,
        label: f?.title ?? 'Feature',
        sub: null,
        colorSlot: groupColorSlot(undefined, k),
        repoId: f?.repoId ?? mostCommon(members.map((t) => t.repoId)),
        loose: false,
        key: minOrder,
        members,
      });
    }
  }

  const isFinished = (s: LaneSpec) => s.members.every((t) => LANDED.includes(t.status));
  const newest = (s: LaneSpec) => s.members.reduce((m, t) => (t.updatedAt > m ? t.updatedAt : m), '');
  specs.sort((a, b) => {
    const fa = isFinished(a);
    const fb = isFinished(b);
    if (fa !== fb) return fa ? 1 : -1;
    if (fa) return newest(b).localeCompare(newest(a)) || a.id.localeCompare(b.id);
    if (typeof a.key === 'number' && typeof b.key === 'number') return a.key - b.key || a.id.localeCompare(b.id);
    return String(a.key).localeCompare(String(b.key)) || a.id.localeCompare(b.id);
  });
  if (loose.length) {
    const label = laneBy === 'group' ? 'Ungrouped' : laneBy === 'repo' ? 'No repo' : 'No feature';
    specs.push({ id: SWIMLANE_LOOSE, label, sub: null, colorSlot: null, repoId: null, loose: true, key: Infinity, members: loose });
  }

  const shows = (t: SwimlaneTask) => showAll || !LANDED.includes(t.status) || now - Date.parse(t.updatedAt) <= recentMs;
  const stageCounts = { queued: 0, working: 0, review: 0, stuck: 0, landed: 0 };
  const lanes: SwimlaneLane[] = [];
  for (const s of specs) {
    const cells = emptyCells();
    const shown = s.members.filter(shows).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    if (!shown.length) continue;
    const stageById = new Map<string, SwimlaneStage>();
    for (const t of shown) stageById.set(t.id, swimlaneStage(t.status)!);
    for (const t of shown) {
      const stage = stageById.get(t.id)!;
      let depth = 0;
      const seen = new Set<string>([t.id]);
      for (let p = t.parentId; p && !seen.has(p); p = byId.get(p)?.parentId ?? null) {
        seen.add(p);
        if (stageById.get(p) === stage) depth++;
      }
      cells[stage].push({ id: t.id, depth });
      stageCounts[stage]++;
    }
    const counts = new Map<TaskStatus, number>();
    for (const t of s.members) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
    lanes.push({
      id: s.id,
      label: s.label,
      sub: s.sub,
      colorSlot: s.colorSlot,
      repoId: s.repoId,
      loose: s.loose,
      total: s.members.length,
      landed: s.members.filter((t) => LANDED.includes(t.status)).length,
      segments: SWIMLANE_BAR_ORDER.filter((st) => counts.has(st)).map((status) => ({ status, count: counts.get(status)! })),
      cells,
    });
  }
  return { lanes, stageCounts };
}
