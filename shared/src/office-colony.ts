// The Space colony skin's pure geometry (docs/office.md § Space colony): the
// colony map is the engine's `OfficeLayout` seen top-down — every room a
// pressurised MODULE, the gaps between them TUBES, the lobby the docking hub.
// Three things are decided here, without I/O or a clock, so the tests pin them:
//
// - `colonyModuleLight`: the light a module shows, from its crew's states
// - `colonyRoute`: the walk a colonist takes for a hand-off — out of the
//   sender's module through its hatch, along the tubes, into the receiver's
// - `colonyCull`: which modules, colonists and walks lie in a viewport, so a
//   large office draws only what is on screen

import type { OfficeRoleState } from './office.ts';
import { officeEdgeEnds } from './office-iso.ts';
import type { OfficeLayout, OfficeViewAvatar, OfficeViewEdge, OfficeViewPoint, OfficeViewRect, OfficeViewRoom } from './office-view.ts';

// ---- module lights ----------------------------------------------------------

/**
 * A module's light, most urgent first: `alert` (someone waits on you) ·
 * `fault` (paused / over budget) · `active` (on shift or in a huddle) ·
 * `standby` (scheduled, guarded, on call) · `dark` (everyone off).
 */
export type ColonyLight = 'alert' | 'fault' | 'active' | 'standby' | 'dark';
export const COLONY_LIGHTS: readonly ColonyLight[] = ['alert', 'fault', 'active', 'standby', 'dark'];

/** One role's lamp on its console. */
export function colonyLampOf(a: Pick<OfficeViewAvatar, 'state' | 'pose'>): ColonyLight {
  const s: OfficeRoleState = a.state;
  if (s === 'waiting-for-you') return 'alert';
  if (s === 'paused' || s === 'over-budget') return 'fault';
  if (s === 'on-shift' || s === 'in-huddle') return 'active';
  // off-duty is either dozing (off) or idle (on call, enabled)
  if (s === 'off-duty') return a.pose === 'dozing' ? 'dark' : 'standby';
  return 'standby';
}

/** The module's light: its most urgent lamp; an empty module is dark. */
export function colonyModuleLight(room: Pick<OfficeViewRoom, 'id'>, avatars: readonly Pick<OfficeViewAvatar, 'room' | 'state' | 'pose'>[]): ColonyLight {
  let best = COLONY_LIGHTS.length - 1;
  for (const a of avatars) {
    if (a.room !== room.id) continue;
    best = Math.min(best, COLONY_LIGHTS.indexOf(colonyLampOf(a)));
  }
  return COLONY_LIGHTS[best];
}

// ---- tubes and walks -------------------------------------------------------

/** How far inside a module its hatch's inner step is, tiles. */
const HATCH_IN = 0.7;

/** A module's hatch: the middle of its bottom wall. */
export function colonyHatch(room: Pick<OfficeViewRoom, 'rect'>): OfficeViewPoint {
  return { x: room.rect.x + room.rect.w / 2, y: room.rect.y + room.rect.h };
}

/** The tube that runs under a module (in the gap below its row). */
function tubeY(room: Pick<OfficeViewRoom, 'rect'>, layout: Pick<OfficeLayout, 'rooms'>): number {
  // rooms in one row share their height, so the row's bottom is this room's
  const bottom = Math.max(...layout.rooms.filter((r) => r.rect.y === room.rect.y).map((r) => r.rect.y + r.rect.h));
  return bottom + 0.5;
}

export interface ColonyTubes {
  /** horizontal tubes, one per row of modules (the last one runs above the hub) */
  rows: { y: number; x0: number; x1: number }[];
  /** the two trunks down the floor's sides, joining every row tube and the hub */
  trunks: { x: number; y0: number; y1: number }[];
  /** a short tube from each module's hatch down to its row tube */
  hatches: { roomId: string; x: number; y0: number; y1: number }[];
}

/** The tube network: drawn under everything; every `colonyRoute` stays on it. */
export function colonyTubes(layout: Pick<OfficeLayout, 'rooms' | 'width' | 'lobby'>): ColonyTubes {
  const left = 0.5;
  const right = layout.width - 0.5;
  const ys = [...new Set(layout.rooms.map((r) => tubeY(r, layout)))].sort((a, b) => a - b);
  const top = ys[0] ?? layout.lobby.y - 0.5;
  return {
    rows: ys.map((y) => ({ y, x0: left, x1: right })),
    trunks: [
      { x: left, y0: top, y1: layout.lobby.y + layout.lobby.h / 2 },
      { x: right, y0: top, y1: layout.lobby.y + layout.lobby.h / 2 },
    ],
    hatches: layout.rooms.map((r) => {
      const h = colonyHatch(r);
      return { roomId: r.id, x: h.x, y0: h.y - HATCH_IN, y1: tubeY(r, layout) };
    }),
  };
}

/** Where an edge end stands on the network: its module (or the hub) and the point. */
interface Stop {
  at: OfficeViewPoint;
  /** null = the docking hub (the door and the channel board stand there) */
  room: OfficeViewRoom | null;
}

function stopOf(end: OfficeViewEdge['from'], at: OfficeViewPoint, layout: Pick<OfficeLayout, 'rooms' | 'avatars'>): Stop {
  if ('role' in end) {
    const a = layout.avatars.find((x) => x.roleId === end.role);
    const room = a ? (layout.rooms.find((r) => r.id === a.room) ?? null) : null;
    if (room) return { at, room };
  }
  return { at, room: null };
}

/** Drop repeated points (a zero-length leg would stall the walker). */
function compact(path: OfficeViewPoint[]): OfficeViewPoint[] {
  const out: OfficeViewPoint[] = [];
  for (const p of path) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q.x - p.x) > 1e-6 || Math.abs(q.y - p.y) > 1e-6) out.push(p);
  }
  return out;
}

/**
 * The walk for a hand-off, as a polyline in tiles: from the sender's current
 * spot (`spots`, its ambient position) to the receiver's. Inside one module it
 * is a straight line. Otherwise it leaves through the sender's hatch, follows
 * its row tube — and, between rows or to the hub, the nearer side trunk — and
 * enters the receiver's module through its hatch. A door / board end (the
 * human, the channel) is in the hub, reached from the bottom of the trunk.
 */
export function colonyRoute(
  edge: OfficeViewEdge,
  layout: Pick<OfficeLayout, 'rooms' | 'avatars' | 'width' | 'lobby'>,
  spots?: ReadonlyMap<string, OfficeViewPoint>,
): OfficeViewPoint[] {
  const ends = officeEdgeEnds(edge, spots ?? new Map());
  const a = stopOf(edge.from, ends.from, layout);
  const b = stopOf(edge.to, ends.to, layout);
  if (a.room && b.room && a.room.id === b.room.id) return compact([a.at, b.at]);
  if (!a.room && !b.room) return compact([a.at, b.at]);
  const hubY = layout.lobby.y + layout.lobby.h / 2;
  const left = 0.5;
  const right = layout.width - 0.5;
  // the leg from a stop to its row tube (or, for the hub, to the trunk's foot)
  const out = (s: Stop): { path: OfficeViewPoint[]; tube: OfficeViewPoint } => {
    if (!s.room) return { path: [s.at], tube: { x: s.at.x, y: hubY } };
    const h = colonyHatch(s.room);
    const ty = tubeY(s.room, layout);
    return { path: [s.at, { x: h.x, y: h.y - HATCH_IN }, { x: h.x, y: ty }], tube: { x: h.x, y: ty } };
  };
  const pa = out(a);
  const pb = out(b);
  const back = [...pb.path].reverse();
  // same row tube: walk along it
  if (a.room && b.room && pa.tube.y === pb.tube.y) return compact([...pa.path, ...back]);
  // otherwise via the nearer trunk
  const cost = (x: number) => Math.abs(pa.tube.x - x) + Math.abs(pb.tube.x - x);
  const trunk = cost(left) <= cost(right) ? left : right;
  const mid: OfficeViewPoint[] = [
    { x: trunk, y: pa.tube.y },
    { x: trunk, y: pb.tube.y },
  ];
  // a hub end: the trunk's foot, then across the hub floor to the place
  const head = a.room ? pa.path : [a.at, { x: a.at.x, y: hubY }];
  const tail = b.room ? back : [{ x: b.at.x, y: hubY }, b.at];
  return compact([...head, ...mid, ...tail]);
}

/** A polyline's length, tiles. */
export function colonyRouteLength(path: readonly OfficeViewPoint[]): number {
  let n = 0;
  for (let i = 1; i < path.length; i++) n += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  return n;
}

// ---- viewport culling ---------------------------------------------------------

/** How many tiles past the viewport still count as visible (a walker entering, a bubble's overhang). */
export const COLONY_CULL_MARGIN = 4;

const overlaps = (a: OfficeViewRect, b: OfficeViewRect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function bbox(path: readonly OfficeViewPoint[]): OfficeViewRect {
  const xs = path.map((p) => p.x);
  const ys = path.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  // a straight horizontal / vertical walk still has an area to hit
  return { x, y, w: Math.max(Math.max(...xs) - x, 0.01), h: Math.max(Math.max(...ys) - y, 0.01) };
}

export interface ColonyVisible {
  rooms: ReadonlySet<string>;
  avatars: ReadonlySet<string>;
  edges: ReadonlySet<string>;
  /** the hub (lobby) */
  hub: boolean;
}

/**
 * What lies in `view` (tiles, grown by `margin` each side). `view: null` (not
 * measured yet) shows everything. An avatar counts by its current spot, an
 * edge by its walk's bounding box.
 */
export function colonyCull(
  layout: Pick<OfficeLayout, 'rooms' | 'avatars' | 'edges' | 'lobby'>,
  view: OfficeViewRect | null,
  routes: ReadonlyMap<string, readonly OfficeViewPoint[]>,
  spots?: ReadonlyMap<string, OfficeViewPoint>,
  margin = COLONY_CULL_MARGIN,
): ColonyVisible {
  if (!view) {
    return { rooms: new Set(layout.rooms.map((r) => r.id)), avatars: new Set(layout.avatars.map((a) => a.roleId)), edges: new Set(layout.edges.map((e) => e.id)), hub: true };
  }
  const v = { x: view.x - margin, y: view.y - margin, w: view.w + margin * 2, h: view.h + margin * 2 };
  const pointIn = (p: OfficeViewPoint) => p.x >= v.x && p.x <= v.x + v.w && p.y >= v.y && p.y <= v.y + v.h;
  return {
    rooms: new Set(layout.rooms.filter((r) => overlaps(r.rect, v)).map((r) => r.id)),
    avatars: new Set(layout.avatars.filter((a) => pointIn(spots?.get(a.roleId) ?? a.at)).map((a) => a.roleId)),
    edges: new Set(
      layout.edges
        .filter((e) => {
          const r = routes.get(e.id);
          return r && r.length > 0 ? overlaps(bbox(r), v) : pointIn(e.fromAt) || pointIn(e.toAt);
        })
        .map((e) => e.id),
    ),
    hub: overlaps(layout.lobby, v),
  };
}
