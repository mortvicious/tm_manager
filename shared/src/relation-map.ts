// The Relation map board version's layout (docs/board-versions.md § Relation
// map): pure, so the view memoises it and the tests pin it. One band per group
// (plus a final "Ungrouped" band for single tasks); inside a band the tree reads
// left to right, a parent centred vertically over its children. Edges are the
// subtask tree, "filed by agent" (`createdByRun` → the filer task) and
// dispatches, aggregated per direction.

import type { Task, TaskStatus } from './types.ts';
import { groupColorSlot } from './types.ts';
import type { RelationDispatch } from './task-relations.ts';

export type RelationMapColumns = 'depth' | 'phase' | 'status';

export type RelationMapTask = Pick<
  Task,
  'id' | 'title' | 'parentId' | 'groupId' | 'groupName' | 'groupColor' | 'status' | 'sortOrder' | 'featurePhase'
>;

export const RM_NODE_W = 230;
export const RM_NODE_H = 52;
export const RM_ROW_GAP = 12;
export const RM_COL_W = 270;
export const RM_BAND_PAD = 34;
export const RM_BAND_GAP = 14;
export const RM_X0 = 24;
export const RM_TOP = 16;
/** room above the first band for the column headers of the phase/status modes */
export const RM_HEAD_H = 28;

export interface RelationMapBand {
  /** the group id, or `ungrouped` */
  id: string;
  label: string;
  /** group colour slot 1..7; null for the ungrouped band */
  colorSlot: number | null;
  y: number;
  height: number;
  count: number;
}

export interface RelationMapNode {
  id: string;
  bandId: string;
  x: number;
  y: number;
  col: number;
  /** depth inside its band's layout tree (the phone list indents by it) */
  depth: number;
  /** tree pre-order across all bands: parent before its children (the phone list's order) */
  order: number;
}

export type RelationMapEdgeKind = 'subtask' | 'filed' | 'dispatch';

export interface RelationMapEdge {
  /** stable key: `kind:from>to` */
  key: string;
  kind: RelationMapEdgeKind;
  from: string;
  to: string;
  /** the SVG path, already offset (filed +6, dispatch −6, as the mockup) */
  d: string;
  /** bounding box for culling */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** subtask edges: the group's colour slot */
  colorSlot?: number;
  /** dispatch edges: how many, and whether one is still on its way */
  count?: number;
  pending?: boolean;
}

export interface RelationMapColumn {
  label: string;
  x: number;
}

export interface RelationMapLayout {
  bands: RelationMapBand[];
  nodes: RelationMapNode[];
  /** id → node */
  byId: Map<string, RelationMapNode>;
  edges: RelationMapEdge[];
  /** headers for the phase/status modes; empty for depth */
  columns: RelationMapColumn[];
  width: number;
  height: number;
}

export interface RelationMapInput {
  tasks: readonly RelationMapTask[];
  /** the filer task of a task (`RelationIndex.filerOf`), or null */
  filerOf: (taskId: string) => string | null;
  dispatches?: readonly RelationDispatch[];
  columns: RelationMapColumns;
}

/** Status columns, in reading order; several statuses share one. */
const STATUS_COLUMNS: { label: string; statuses: TaskStatus[] }[] = [
  { label: 'draft', statuses: ['draft'] },
  { label: 'queued', statuses: ['queued'] },
  { label: 'running', statuses: ['running', 'waiting'] },
  { label: 'review', statuses: ['review'] },
  { label: 'blocked', statuses: ['blocked'] },
  { label: 'landed', statuses: ['done', 'published'] },
  { label: 'stopped', statuses: ['failed', 'cancelled'] },
];

export function relationMapStatusColumn(status: TaskStatus): number {
  const i = STATUS_COLUMNS.findIndex((c) => c.statuses.includes(status));
  return i < 0 ? 0 : i;
}

export const UNGROUPED_BAND = 'ungrouped';

const bySort = (a: RelationMapTask, b: RelationMapTask) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id);

/** An edge from the right side of `a` to the left side of `b`, looping out to the right when `b` is not further right. */
function curve(a: RelationMapNode, b: RelationMapNode, bend: number, dy: number) {
  const y1 = a.y + RM_NODE_H / 2 + dy;
  const y2 = b.y + RM_NODE_H / 2 + dy;
  const x1 = a.x + RM_NODE_W;
  if (b.x > a.x) {
    const x2 = b.x;
    const mx = (x1 + x2) / 2;
    return { d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, minX: x1, maxX: x2, minY: Math.min(y1, y2), maxY: Math.max(y1, y2) };
  }
  const x2 = b.x + RM_NODE_W;
  const o = 60 + bend;
  return {
    d: `M${x1},${y1} C${x1 + o},${y1} ${x2 + o},${y2} ${x2},${y2}`,
    minX: Math.min(x1, x2),
    maxX: Math.max(x1, x2) + o,
    minY: Math.min(y1, y2),
    maxY: Math.max(y1, y2),
  };
}

export function layoutRelationMap({ tasks, filerOf, dispatches = [], columns }: RelationMapInput): RelationMapLayout {
  const byTask = new Map(tasks.map((t) => [t.id, t]));
  const members = new Map<string, RelationMapTask[]>();
  for (const t of tasks) {
    const list = members.get(t.groupId);
    if (list) list.push(t);
    else members.set(t.groupId, [t]);
  }

  // bands: a group with two or more tasks shown; the rest are ungrouped
  type BandSpec = { id: string; label: string; colorSlot: number | null; tasks: RelationMapTask[]; key: number };
  const groupBands: BandSpec[] = [];
  const loose: RelationMapTask[] = [];
  for (const [groupId, list] of members) {
    if (list.length < 2) {
      loose.push(...list);
      continue;
    }
    const root = byTask.get(groupId);
    groupBands.push({
      id: groupId,
      label: root?.groupName || root?.title || 'Group',
      colorSlot: groupColorSlot(root, groupId),
      tasks: list,
      key: root ? root.sortOrder : Math.min(...list.map((t) => t.sortOrder)),
    });
  }
  groupBands.sort((a, b) => a.key - b.key || a.id.localeCompare(b.id));
  const bands: BandSpec[] = loose.length
    ? [...groupBands, { id: UNGROUPED_BAND, label: 'Ungrouped', colorSlot: null, tasks: loose, key: Infinity }]
    : groupBands;

  // column keys of the non-depth modes, compacted to the ones in use
  const colKey = (t: RelationMapTask, depth: number) =>
    columns === 'depth' ? depth : columns === 'phase' ? (t.featurePhase == null ? -1 : t.featurePhase) : relationMapStatusColumn(t.status);
  const nodes: RelationMapNode[] = [];
  const outBands: RelationMapBand[] = [];
  const rawCol = new Map<string, number>();
  let order = 0;
  let y = RM_TOP + (columns === 'depth' ? 0 : RM_HEAD_H);

  for (const band of bands) {
    const inBand = new Set(band.tasks.map((t) => t.id));
    // the layout tree: the subtask parent inside a group; in the ungrouped band
    // a filed task hangs off its filer (the mockup's "one column right")
    const layoutParent = (t: RelationMapTask): string | null => {
      if (band.id !== UNGROUPED_BAND) return t.parentId && inBand.has(t.parentId) ? t.parentId : null;
      const f = filerOf(t.id);
      return f && f !== t.id && inBand.has(f) ? f : null;
    };
    const kids = new Map<string, RelationMapTask[]>();
    const roots: RelationMapTask[] = [];
    for (const t of band.tasks) {
      const p = layoutParent(t);
      if (p) {
        const list = kids.get(p);
        if (list) list.push(t);
        else kids.set(p, [t]);
      } else roots.push(t);
    }
    for (const list of kids.values()) list.sort(bySort);
    roots.sort(bySort);

    const top = y;
    const rowY = (r: number) => top + RM_BAND_PAD + r * (RM_NODE_H + RM_ROW_GAP);
    let row = 0;
    const seen = new Set<string>();
    // depth mode: tidy tree (leaves take rows, a parent sits at its children's
    // midpoint); the other modes: one row per task in tree order, since a
    // parent and its child can share a column there
    const place = (t: RelationMapTask, depth: number): number => {
      seen.add(t.id);
      const pre = order++;
      const ch = (kids.get(t.id) ?? []).filter((c) => !seen.has(c.id));
      let r: number;
      if (columns !== 'depth') {
        r = row++;
        for (const c of ch) place(c, depth + 1);
      } else if (!ch.length) {
        r = row++;
      } else {
        const rs = ch.map((c) => place(c, depth + 1));
        r = (rs[0] + rs[rs.length - 1]) / 2;
      }
      rawCol.set(t.id, colKey(t, depth));
      nodes.push({ id: t.id, bandId: band.id, x: 0, y: rowY(r), col: 0, depth, order: pre });
      return r;
    };
    for (const r of roots) place(r, 0);
    // a cycle in the data (never in practice) leaves members unreached: place them as roots
    for (const t of [...band.tasks].sort(bySort)) if (!seen.has(t.id)) place(t, 0);

    const height = RM_BAND_PAD + row * (RM_NODE_H + RM_ROW_GAP) + 4;
    outBands.push({ id: band.id, label: band.label, colorSlot: band.colorSlot, y: top, height, count: band.tasks.length });
    y = top + height + RM_BAND_GAP;
  }

  // compact column keys to 0..n-1 and set x
  const keys = [...new Set(rawCol.values())].sort((a, b) => a - b);
  const colOf = new Map(keys.map((k, i) => [k, i]));
  for (const n of nodes) {
    n.col = colOf.get(rawCol.get(n.id)!)!;
    n.x = RM_X0 + n.col * RM_COL_W;
  }
  const outColumns: RelationMapColumn[] =
    columns === 'depth'
      ? []
      : keys.map((k, i) => ({
          x: RM_X0 + i * RM_COL_W,
          label: columns === 'phase' ? (k < 0 ? 'no phase' : `phase ${k + 1}`) : STATUS_COLUMNS[k].label,
        }));
  nodes.sort((a, b) => a.y - b.y || a.x - b.x);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // edges
  const edges: RelationMapEdge[] = [];
  const bandSlot = new Map(outBands.map((b) => [b.id, b.colorSlot]));
  for (const n of nodes) {
    const t = byTask.get(n.id)!;
    const parent = t.parentId ? byId.get(t.parentId) : undefined;
    if (parent && parent.bandId === n.bandId && n.bandId !== UNGROUPED_BAND) {
      const c = curve(parent, n, 0, 0);
      edges.push({ key: `subtask:${parent.id}>${n.id}`, kind: 'subtask', from: parent.id, to: n.id, ...c, colorSlot: bandSlot.get(n.bandId) ?? undefined });
    }
    const f = filerOf(n.id);
    const filer = f && f !== n.id ? byId.get(f) : undefined;
    if (filer) {
      const c = curve(filer, n, 24, 6);
      edges.push({ key: `filed:${filer.id}>${n.id}`, kind: 'filed', from: filer.id, to: n.id, ...c });
    }
  }
  const pairs = new Map<string, { from: string; to: string; count: number; pending: boolean }>();
  for (const d of dispatches) {
    if (d.fromTaskId === d.toTaskId || !byId.has(d.fromTaskId) || !byId.has(d.toTaskId)) continue;
    const k = `${d.fromTaskId}>${d.toTaskId}`;
    const p = pairs.get(k) ?? { from: d.fromTaskId, to: d.toTaskId, count: 0, pending: false };
    p.count++;
    if (d.status === 'pending') p.pending = true;
    pairs.set(k, p);
  }
  for (const [k, p] of pairs) {
    const c = curve(byId.get(p.from)!, byId.get(p.to)!, 48, -6);
    edges.push({ key: `dispatch:${k}`, kind: 'dispatch', from: p.from, to: p.to, ...c, count: p.count, pending: p.pending });
  }

  const maxCol = nodes.reduce((m, n) => Math.max(m, n.col), 0);
  const edgeRight = edges.reduce((m, e) => Math.max(m, e.maxX), 0);
  return {
    bands: outBands,
    nodes,
    byId,
    edges,
    columns: outColumns,
    width: Math.max(RM_X0 + maxCol * RM_COL_W + RM_NODE_W + RM_X0, edgeRight + RM_X0),
    height: y,
  };
}

/** The nodes and edges inside a viewport rectangle (stage coordinates), for culling. */
export function cullRelationMap(
  layout: RelationMapLayout,
  view: { x: number; y: number; width: number; height: number },
): { nodes: RelationMapNode[]; edges: RelationMapEdge[]; bands: RelationMapBand[] } {
  const x2 = view.x + view.width;
  const y2 = view.y + view.height;
  return {
    nodes: layout.nodes.filter((n) => n.x + RM_NODE_W >= view.x && n.x <= x2 && n.y + RM_NODE_H >= view.y && n.y <= y2),
    edges: layout.edges.filter((e) => e.maxX >= view.x && e.minX <= x2 && e.maxY >= view.y && e.minY <= y2),
    bands: layout.bands.filter((b) => b.y + b.height >= view.y && b.y <= y2),
  };
}
