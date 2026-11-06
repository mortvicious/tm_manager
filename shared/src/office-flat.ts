// The flat (top-down) skins' projection and their place names (docs/office.md
// § Starship bridge / § Fantasy guild hall). Pure, no I/O: the Starship bridge
// and the Fantasy guild hall both draw `layoutOffice`'s tiles straight down
// at a whole-px tile size, so the engine's one-column stack (a phone) is
// already a vertical stack and needs no mode of its own — unlike the
// isometric Pixel office (`office-iso.ts`).

import type { OfficeDepartment, OfficeLayout, OfficeThemeId, OfficeViewPoint, OfficeViewRect } from './office-view.ts';
import { OFFICE_DEPARTMENTS } from './office-view.ts';

export interface OfficeFlatProjection {
  /** one floor tile, whole px */
  tile: number;
  /** the drawn floor, px */
  width: number;
  height: number;
  project(p: OfficeViewPoint): OfficeViewPoint;
  rect(r: OfficeViewRect): OfficeViewRect;
}

export interface OfficeFlatOptions {
  /** smallest tile (a narrower frame scrolls sideways); default 10 */
  minTile?: number;
  /** largest tile (a wide frame does not blow the floor up); default 28 */
  maxTile?: number;
}

/** The largest whole-px tile that fits `availWidth`, clamped to [minTile, maxTile]. */
export function officeFlatProjection(layout: Pick<OfficeLayout, 'width' | 'height'>, availWidth: number, opts: OfficeFlatOptions = {}): OfficeFlatProjection {
  const min = Math.max(1, Math.floor(opts.minTile ?? 10));
  const max = Math.max(min, Math.floor(opts.maxTile ?? 28));
  const fit = layout.width > 0 && Number.isFinite(availWidth) && availWidth > 0 ? Math.floor(availWidth / layout.width) : max;
  const tile = Math.min(max, Math.max(min, fit));
  return {
    tile,
    width: layout.width * tile,
    height: layout.height * tile,
    project: (p) => ({ x: p.x * tile, y: p.y * tile }),
    rect: (r) => ({ x: r.x * tile, y: r.y * tile, w: r.w * tile, h: r.h * tile }),
  };
}

/** What a skin calls the places on the floor; the layout's own labels are the Pixel office's. */
export interface OfficeSkinPlaces {
  rooms: Readonly<Record<OfficeDepartment, string>>;
  lobby: string;
  /** the stakeholder's end of a hand-off */
  door: string;
  /** the channel's end */
  board: string;
}

const LAYOUT_ROOMS = Object.fromEntries(OFFICE_DEPARTMENTS.map((d) => [d.id, d.label])) as Record<OfficeDepartment, string>;

/**
 * Per theme, in the words of its generated names (`server/src/office/names.ts`:
 * Captain / Chief Engineer / Ops / Science / Comms officer on the bridge;
 * Guildmaster / the Artificer / the Smith / the Seeker / the Herald in the hall).
 */
export const OFFICE_SKIN_PLACES: Readonly<Record<OfficeThemeId, OfficeSkinPlaces>> = {
  'pixel-office': { rooms: LAYOUT_ROOMS, lobby: 'Lobby', door: 'You', board: 'Channel' },
  'starship-bridge': {
    rooms: {
      leadership: 'Command',
      engineering: 'Engineering',
      operations: 'Ops station',
      growth: 'Comms',
      commons: 'Crew deck',
    },
    lobby: 'Airlock',
    door: 'You',
    board: 'Comms array',
  },
  'fantasy-guild': {
    rooms: {
      leadership: "Guildmaster's hall",
      engineering: "Artificers' workshop",
      operations: 'Smithy',
      growth: "Heralds' tower",
      commons: 'Common room',
    },
    lobby: 'Gatehouse',
    door: 'You',
    board: 'Quest board',
  },
  'space-colony': { rooms: LAYOUT_ROOMS, lobby: 'Lobby', door: 'You', board: 'Channel' },
};

/**
 * What a top-down skin's name plate shows: the whole name when it is short,
 * else the given name out of a themed one — "Chief Engineer Orion" → "Orion",
 * "Thorin the Artificer" → "Thorin" — so four Chief Engineers do not all read
 * "Chief…". The full name stays in the title, the aria label and the card.
 */
export function officePlateName(name: string): string {
  const n = name.trim();
  if (n.length <= 10) return n;
  const the = /^(\S+) the \S/.exec(n);
  if (the) return the[1];
  const words = n.split(/\s+/);
  return words[words.length - 1];
}

/** A deterministic star field (or any scatter) over a w×h px area: `count` points from `seed`. Pure. */
export function officeScatter(seed: number, count: number, w: number, h: number): { x: number; y: number; k: number }[] {
  const out: { x: number; y: number; k: number }[] = [];
  let s = seed >>> 0 || 1;
  const next = () => {
    // xorshift32
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
  for (let i = 0; i < count; i++) out.push({ x: Math.floor(next() * w), y: Math.floor(next() * h), k: Math.floor(next() * 3) });
  return out;
}
