// The isometric projection the Pixel office skin draws through (docs/office.md
// § The view → Pixel office). Pure, no DOM: `layoutOffice` works in floor
// TILES on a flat plan; this turns a tile point (plus a height) into a screen
// pixel on a 2:1 isometric floor, so the skin, a test and any later iso skin
// share one geometry.
//
// Two modes, picked from the layout itself:
// - `floor`: the whole plan is one isometric floor (desktop, 2–3 rooms a row).
// - `stack`: the layout is ONE column (a phone or a narrow frame — the
//   engine's stack fallback). Projecting a tall single column as one floor
//   would make a long diagonal ribbon, so each room (and the lobby) becomes its
//   own isometric block, stacked top to bottom and centred, and a point is
//   projected through the block that holds it.
import type { OfficeLayout, OfficeViewAvatar, OfficeViewEdge, OfficeViewPoint, OfficeViewRect } from './office-view.ts';

/** how high the back walls stand, in tiles */
export const OFFICE_ISO_WALL = 1.6;
/** headroom above a block for walls, bubbles and name plates, in tiles */
const HEADROOM = 3;
/** room below a block for the front avatars' name plates, in tiles */
const FOOTROOM = 1.6;
/** gap between stacked blocks, in tiles */
const STACK_GAP = 0.6;

export interface OfficeIsoRegion {
  /** the tile rect this block projects */
  rect: OfficeViewRect;
  /** screen px of the rect's (x, y) corner at height 0 */
  ox: number;
  oy: number;
  /** depth offset: a later block is drawn over an earlier one */
  order: number;
}

export interface OfficeIsoScreenPoint {
  x: number;
  y: number;
  /** paint order: larger is nearer the viewer */
  depth: number;
}

export interface OfficeIsoProjection {
  mode: 'floor' | 'stack';
  /** px for half a tile's width (a tile is 2a wide and a tall on screen) */
  a: number;
  width: number;
  height: number;
  regions: OfficeIsoRegion[];
  /** a tile point at height `z` (tiles) → screen px */
  project(p: OfficeViewPoint, z?: number): OfficeIsoScreenPoint;
  /** the same through a given block — for drawing a block's own walls and floor */
  projectIn(region: OfficeIsoRegion, p: OfficeViewPoint, z?: number): OfficeIsoScreenPoint;
  /** the block that holds a tile point (else the nearest one) */
  regionOf(p: OfficeViewPoint): OfficeIsoRegion;
}

export interface OfficeIsoOptions {
  /** smallest / largest half-tile in px */
  minA?: number;
  maxA?: number;
  /** px of margin left and right */
  pad?: number;
}

const contains = (r: OfficeViewRect, p: OfficeViewPoint): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const gap = (r: OfficeViewRect, p: OfficeViewPoint): number => {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return dx * dx + dy * dy;
};

/** Whether the layout is the engine's one-column stack (more than one block, all rooms in one column). */
export function officeIsStacked(layout: Pick<OfficeLayout, 'rooms'>): boolean {
  return layout.rooms.length > 1 && layout.rooms.every((r) => r.rect.x === layout.rooms[0].rect.x);
}

/**
 * Project `layout` to fit `availWidth` px. The half-tile `a` is the largest
 * whole px that fits (clamped to [minA, maxA]); below minA the floor is wider
 * than the frame and the skin scrolls it.
 */
export function officeIsoProjection(layout: Pick<OfficeLayout, 'rooms' | 'lobby' | 'width' | 'height'>, availWidth: number, opts: OfficeIsoOptions = {}): OfficeIsoProjection {
  const minA = opts.minA ?? 8;
  const maxA = opts.maxA ?? 22;
  const pad = opts.pad ?? 8;
  const stacked = officeIsStacked(layout);
  const blocks: OfficeViewRect[] = stacked
    ? [...layout.rooms.map((r) => r.rect), layout.lobby].sort((p, q) => p.y - q.y)
    : [{ x: 0, y: 0, w: layout.width, h: layout.height }];
  const span = Math.max(...blocks.map((b) => b.w + b.h), 1);
  const fit = Math.floor((Math.max(availWidth, 0) - pad * 2) / span);
  const a = Math.max(minA, Math.min(maxA, Number.isFinite(fit) ? fit : minA));
  const width = span * a + pad * 2;

  const regions: OfficeIsoRegion[] = [];
  let cursor = 0;
  blocks.forEach((b, order) => {
    const top = cursor + HEADROOM * a;
    // centred: the block spans [ox - h·a, ox + w·a] on screen
    const ox = pad + ((span - (b.w + b.h)) * a) / 2 + b.h * a;
    regions.push({ rect: b, ox, oy: top, order });
    cursor = top + ((b.w + b.h) * a) / 2 + (stacked ? STACK_GAP * a : 0);
  });
  const height = cursor + FOOTROOM * a;

  const regionOf = (p: OfficeViewPoint): OfficeIsoRegion => {
    if (regions.length === 1) return regions[0];
    const hit = regions.find((r) => contains(r.rect, p));
    if (hit) return hit;
    let best = regions[0];
    for (const r of regions) if (gap(r.rect, p) < gap(best.rect, p)) best = r;
    return best;
  };
  const projectIn = (r: OfficeIsoRegion, p: OfficeViewPoint, z = 0): OfficeIsoScreenPoint => {
    const lx = p.x - r.rect.x;
    const ly = p.y - r.rect.y;
    return {
      x: r.ox + (lx - ly) * a,
      y: r.oy + ((lx + ly) * a) / 2 - z * a,
      depth: r.order * 100_000 + (lx + ly) * 100,
    };
  };
  const project = (p: OfficeViewPoint, z = 0): OfficeIsoScreenPoint => projectIn(regionOf(p), p, z);
  return { mode: stacked ? 'stack' : 'floor', a, width, height, regions, project, projectIn, regionOf };
}

/**
 * Where a hand-off edge starts and ends NOW: a role end follows that avatar to
 * wherever ambient life has it (`spots`), a place end (door, board) stays put.
 * A role with no spot falls back to the layout's own point.
 */
export function officeEdgeEnds(
  edge: Pick<OfficeViewEdge, 'from' | 'to' | 'fromAt' | 'toAt'>,
  spots: ReadonlyMap<string, OfficeViewPoint>,
): { from: OfficeViewPoint; to: OfficeViewPoint } {
  const at = (end: OfficeViewEdge['from'], fallback: OfficeViewPoint) => ('role' in end ? (spots.get(end.role) ?? fallback) : fallback);
  return { from: at(edge.from, edge.fromAt), to: at(edge.to, edge.toAt) };
}

/**
 * How the Pixel office acts a role out. The layout's pose decides WHERE it is;
 * the state decides the rest, so every `OfficeRoleState` reads differently:
 * on-shift types at a lit monitor · a guarded role sleeps at its desk (it does
 * not wander) with the skip reason in a bubble · an off role dozes, dimmed ·
 * waiting-for-you raises a hand · in-huddle stands at the table · paused and
 * over-budget stand greyed with ⏸ / $ · scheduled (and an on-call off-duty
 * role) is idle — ambient life, told apart by the name plate's state pip.
 */
export type OfficePixelAct = 'typing' | 'asleep' | 'dozing' | 'hand-up' | 'huddle' | 'greyed' | 'idle';

export function officePixelAct(a: Pick<OfficeViewAvatar, 'pose' | 'state'>): OfficePixelAct {
  if (a.pose === 'blocked') return 'greyed';
  if (a.pose === 'dozing') return 'dozing';
  if (a.pose === 'working') return 'typing';
  if (a.pose === 'waiting') return 'hand-up';
  if (a.pose === 'huddling') return 'huddle';
  if (a.state === 'guarded') return 'asleep';
  return 'idle';
}

/** The guard's own words from a guarded card line: `skip: <reason> · next …` → `<reason>`. */
export function officeSkipReason(detail: string): string {
  return detail.replace(/^skip:\s*/, '').split(' · ')[0].trim();
}
