// The Metro board version's layout (docs/board-versions.md § Metro): pure, so
// the view memoises it and the tests pin it. Every group with two or more tasks
// shown is a LINE whose stations are its members in run order — the global
// claim's own comparator (`compareClaimOrder`, the JS twin of
// `MANUAL_CLAIM_ORDER`), so a line reads in the order the queue claims it. A
// `blocked` split parent is the line's origin, not a station. Deeper subtasks
// branch off below their top-level station, in lanes chosen so no branch's
// drop from its station crosses another branch. Single tasks are the "Local stops".
//
// Geometry is in SLOTS (x) and LANES (y, 0 = the main line); the view turns
// them into pixels for the desktop map and into rows for the phone timetable.

import type { Task, TaskStatus } from './types.ts';
import { compareClaimOrder, groupColorSlot } from './types.ts';

export type MetroTask = Pick<
  Task,
  'id' | 'title' | 'parentId' | 'groupId' | 'groupName' | 'groupColor' | 'status' | 'sortOrder' | 'priority' | 'createdAt'
>;

/** A station counts as started — the line is solid up to the last one — once its task has run. */
const STARTED: readonly TaskStatus[] = ['running', 'waiting', 'review', 'blocked', 'done', 'published', 'failed'];
export const metroStarted = (s: TaskStatus) => STARTED.includes(s);

export interface MetroStation {
  id: string;
  /** x position in station slots (0 = the first station) */
  slot: number;
}

export interface MetroBranch {
  /** the top-level station it leaves from */
  fromId: string;
  fromSlot: number;
  /** 1.. below the main line */
  lane: number;
  /** every descendant of `fromId`, in run order; slots `fromSlot + 1 …` */
  stations: MetroStation[];
  /** index into `stations` of the last started one, −1 when none has */
  lastStarted: number;
}

export interface MetroLine {
  /** the group id */
  id: string;
  label: string;
  colorSlot: number;
  /** the `blocked` split root, drawn as the line's origin; null when the root is a station or not shown */
  originId: string | null;
  main: MetroStation[];
  branches: MetroBranch[];
  /** index into `main` of the last started station, −1 when none has */
  lastStarted: number;
  /** lanes below the main line (0 = no branches) */
  lanes: number;
  /** the rightmost slot used, branches included */
  maxSlot: number;
  /** tasks on the line, origin included */
  count: number;
  /** done + published among them */
  landed: number;
}

export interface MetroLayout {
  lines: MetroLine[];
  /** single tasks (a group of one on the board), in run order */
  local: string[];
}

const groupSize = (tasks: readonly MetroTask[]) => {
  const m = new Map<string, MetroTask[]>();
  for (const t of tasks) {
    const list = m.get(t.groupId);
    if (list) list.push(t);
    else m.set(t.groupId, [t]);
  }
  return m;
};

export function layoutMetro(tasks: readonly MetroTask[]): MetroLayout {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // the comparator only reads the fields `MetroTask` carries
  const cmp = compareClaimOrder(byId as unknown as ReadonlyMap<string, Task>) as unknown as (a: MetroTask, b: MetroTask) => number;

  const specs: { line: MetroLine; key: MetroTask }[] = [];
  const loose: MetroTask[] = [];
  for (const [groupId, list] of groupSize(tasks)) {
    if (list.length < 2) {
      loose.push(...list);
      continue;
    }
    list.sort(cmp);
    const inLine = new Set(list.map((t) => t.id));
    const root = byId.get(groupId);
    const originId = root && root.status === 'blocked' ? root.id : null;
    // the line's tree: a parent outside the shown set hangs the member off the root level
    const parentOf = (t: MetroTask) => (t.parentId && inLine.has(t.parentId) ? t.parentId : null);
    const topOf = new Map<string, string>(); // member → its top-level station
    const top = (t: MetroTask): string => {
      const known = topOf.get(t.id);
      if (known) return known;
      let cur = t;
      const seen = new Set<string>([t.id]);
      for (;;) {
        const p = parentOf(cur);
        // the top-level station: the root itself, a child of the root (or of
        // the origin), or a member whose parent is not shown
        if (!p || p === groupId) break;
        const pt = byId.get(p)!;
        if (seen.has(pt.id)) break; // a cycle in the data: stop where it closes
        seen.add(pt.id);
        cur = pt;
      }
      topOf.set(t.id, cur.id);
      return cur.id;
    };

    const main: MetroStation[] = [];
    const under = new Map<string, MetroTask[]>();
    for (const t of list) {
      if (t.id === originId) continue;
      const tp = top(t);
      if (tp === t.id) main.push({ id: t.id, slot: main.length });
      else {
        const b = under.get(tp);
        if (b) b.push(t);
        else under.set(tp, [t]);
      }
    }

    // branches into lanes. A branch spans [fromSlot, fromSlot + n] and its
    // connector drops straight down at fromSlot through every lane above its
    // own, so no branch in an upper lane may cover that slot. Placing right to
    // left, each branch goes one lane below every branch already placed that
    // starts inside its span (those start further right, so its own drop
    // passes them clear) — and lanes above it never cover its fromSlot.
    const branches: MetroBranch[] = [];
    let maxSlot = main.length - 1;
    for (const st of main) {
      const below = under.get(st.id);
      if (!below) continue;
      const stations = below.map((t, j) => ({ id: t.id, slot: st.slot + 1 + j }));
      let lastStarted = -1;
      below.forEach((t, j) => metroStarted(t.status) && (lastStarted = j));
      branches.push({ fromId: st.id, fromSlot: st.slot, lane: 0, stations, lastStarted });
      maxSlot = Math.max(maxSlot, st.slot + below.length);
    }
    const end = (b: MetroBranch) => b.fromSlot + b.stations.length;
    for (let i = branches.length - 1; i >= 0; i--) {
      const b = branches[i];
      let lane = 1;
      for (let j = i + 1; j < branches.length && branches[j].fromSlot <= end(b); j++) lane = Math.max(lane, branches[j].lane + 1);
      b.lane = lane;
    }
    const lanes = branches.reduce((m, b) => Math.max(m, b.lane), 0);

    let lastStarted = -1;
    main.forEach((s, i) => metroStarted(byId.get(s.id)!.status) && (lastStarted = i));
    specs.push({
      key: root ?? list[0],
      line: {
        id: groupId,
        label: root?.groupName || root?.title || 'Group',
        colorSlot: groupColorSlot(root, groupId),
        originId,
        main,
        branches,
        lastStarted,
        lanes,
        maxSlot,
        count: list.length,
        landed: list.filter((t) => t.status === 'done' || t.status === 'published').length,
      },
    });
  }

  // lines in the queue's order of their roots (priority, then the root's key)
  specs.sort((a, b) => cmp(a.key, b.key) || a.line.id.localeCompare(b.line.id));
  loose.sort(cmp);
  return { lines: specs.map((s) => s.line), local: loose.map((t) => t.id) };
}

export interface MetroRow {
  id: string;
  /** null for a main-line station; the top-level station a branch station hangs off */
  branchOf: string | null;
  /** main rail above / below this row: solid (started), dashed (still to come) or none */
  railUp: 'solid' | 'dashed' | null;
  railDown: 'solid' | 'dashed' | null;
  /** branch rows: whether the branch's own rail above/below is solid, dashed or absent */
  branchUp: 'solid' | 'dashed' | null;
  branchDown: 'solid' | 'dashed' | null;
}

/**
 * The phone timetable: a line read top to bottom — each top-level station,
 * then its branch stations indented under it — with the rail state each row
 * draws, so the solid/dashed split matches the desktop map.
 */
export function metroRows(line: MetroLine): MetroRow[] {
  const rows: MetroRow[] = [];
  const branchOf = new Map(line.branches.map((b) => [b.fromId, b]));
  // the rail into station i is solid when i is started-or-before the last started
  const seg = (i: number): 'solid' | 'dashed' => (i <= line.lastStarted ? 'solid' : 'dashed');
  const n = line.main.length;
  const hasOrigin = line.originId != null;
  line.main.forEach((s, i) => {
    const railUp = i > 0 || hasOrigin ? seg(i) : null;
    const railDown = i < n - 1 ? seg(i + 1) : null;
    rows.push({ id: s.id, branchOf: null, railUp, railDown, branchUp: null, branchDown: null });
    const b = branchOf.get(s.id);
    if (!b) return;
    const bseg = (j: number): 'solid' | 'dashed' => (j <= b.lastStarted ? 'solid' : 'dashed');
    b.stations.forEach((st, j) => {
      rows.push({
        id: st.id,
        branchOf: s.id,
        railUp: railDown,
        railDown,
        branchUp: bseg(j),
        branchDown: j < b.stations.length - 1 ? bseg(j + 1) : null,
      });
    });
  });
  return rows;
}
