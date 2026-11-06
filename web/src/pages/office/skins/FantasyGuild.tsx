// The Fantasy guild hall skin (docs/office.md § Fantasy guild hall): the same
// `OfficeLayout` seen from above as a guild's hall — each department a
// stone-walled chamber on plank floors under its own guild BANNER (in the
// department's hue), every desk an oak table with an open book and a candle
// that burns while its owner works, a round table where a huddle meets, an
// ale barrel where the coffee was, the gate (you) and the quest board (the
// channel) in the gatehouse. A hand-off is a SCROLL carried along a dotted
// trail from one member to the other.
//
// Drawn top-down through `officeFlatProjection` (shared), SVG + CSS only, no
// assets. Every colour is a `--tm-guild-*` / `--tm-*` token, every infinite
// animation is stepped and listed in theme.css § Calm, and
// prefers-reduced-motion turns them off.
import { useMemo, type ReactNode } from 'react';
import {
  OFFICE_SKIN_PLACES,
  officeFlatProjection,
  officeHash,
  type OfficeFlatProjection,
  type OfficeLayout,
  type OfficePixelAct,
  type OfficeViewEdge,
  type OfficeViewRoom,
} from '@tm/shared';
import type { OfficeSkinProps } from '../../../officeThemes.ts';
import { FALLBACK_WIDTH, FlatAvatar, cssVars, flatEdgePath, useAmbientScene, useAmbientTick, useWalk, useWidth, type BubbleGlyphs } from './common.tsx';

const PLACES = OFFICE_SKIN_PLACES['fantasy-guild'];
const GLYPHS: BubbleGlyphs = { waiting: '!', guarded: 'z', dozing: 'z', paused: '⏸', overBudget: '🪙', huddle: '🗣️', chat: '💬' };

/** the candle on its owner's table: lit while working, guttering while waiting, out otherwise */
const CANDLE: Record<OfficePixelAct, string> = {
  typing: 'lit',
  'hand-up': 'gutter',
  asleep: 'out',
  dozing: 'out',
  greyed: 'out',
  huddle: 'out',
  idle: 'low',
};

export default function FantasyGuild({ layout, mobile, selectedRoleId, highlight, onAvatar }: OfficeSkinProps) {
  const [wrap, width] = useWidth();
  const proj = useMemo(() => officeFlatProjection(layout, width || FALLBACK_WIDTH, { minTile: 12, maxTile: mobile ? 26 : 24 }), [layout, width, mobile]);
  const tick = useAmbientTick();
  const walk = useWalk(proj.tile, proj.width);
  const { spots, spotAt, actOf } = useAmbientScene(layout, tick);
  const t = proj.tile;

  return (
    <div className={`fg-wrap${mobile ? ' phone' : ''}`} ref={wrap}>
      <div
        className={`fg-floor${highlight ? ' has-hl' : ''}${walk ? ' walk' : ''}`}
        style={cssVars({ '--fg-t': `${t}px`, width: proj.width, height: proj.height })}
        role="group"
        aria-label="Guild hall"
      >
        <svg className="fg-svg" width={proj.width} height={proj.height} viewBox={`0 0 ${proj.width} ${proj.height}`} aria-hidden>
          <rect className="fg-ground" x={0} y={0} width={proj.width} height={proj.height} />
          <Flagstones proj={proj} layout={layout} />
          {layout.rooms.map((room) => (
            <Chamber key={room.id} proj={proj} room={room} actOf={actOf} />
          ))}
          <Gatehouse proj={proj} layout={layout} />
          <g className="fg-trails">
            {layout.edges.map((e) => (
              <path
                key={e.id}
                d={flatEdgePath(proj, e, spotAt, e.kind === 'huddle' ? 0 : 0.28)}
                className={`fg-trail k-${e.kind}${e.tainted ? ' tainted' : ''}${highlight?.edgeId === e.id ? ' hl' : ''}`}
              />
            ))}
          </g>
        </svg>

        {layout.edges
          .filter((e) => e.kind !== 'huddle')
          .map((e) => (
            <Scroll key={e.id} edge={e} d={flatEdgePath(proj, e, spotAt, 0.28)} lit={highlight?.edgeId === e.id} />
          ))}

        {layout.avatars.map((a) => {
          const spot = spots.get(a.roleId)!;
          const act = actOf.get(a.roleId)!;
          return (
            <FlatAvatar
              key={a.roleId}
              prefix="fg"
              avatar={a}
              act={act}
              activity={spot.activity}
              at={proj.project(spot.at)}
              tile={t}
              glyphs={GLYPHS}
              selected={a.roleId === selectedRoleId}
              lit={highlight?.roleIds.has(a.roleId) ?? false}
              onClick={() => onAvatar(a.roleId)}
            >
              <Robed act={act} seated={act === 'typing' || act === 'asleep' || act === 'dozing'} tankard={act === 'idle' && spot.activity === 'coffee'} />
            </FlatAvatar>
          );
        })}
      </div>
    </div>
  );
}

// ---- the floor -------------------------------------------------------------------

/** the courtyard between the chambers: a loose flagstone pattern */
function Flagstones({ proj, layout }: { proj: OfficeFlatProjection; layout: Pick<OfficeLayout, 'width' | 'height'> }) {
  const t = proj.tile;
  const stones: ReactNode[] = [];
  // rows of 2×2 stones, every other row offset by one tile; the edge stones are cut to the floor
  for (let y = 0; y < layout.height; y += 2) {
    const h = Math.min(2, layout.height - y);
    for (let x = (y / 2) % 2 ? -1 : 0; x < layout.width; x += 2) {
      const x0 = Math.max(0, x);
      const w = Math.min(x + 2, layout.width) - x0;
      if (w <= 0.5 || h <= 0.5) continue;
      stones.push(<rect key={`${x}.${y}`} className="fg-flag" x={x0 * t + 1} y={y * t + 1} width={w * t - 2} height={h * t - 2} rx={t * 0.3} />);
    }
  }
  return <g className="fg-flags">{stones}</g>;
}

function Chamber({ proj, room, actOf }: { proj: OfficeFlatProjection; room: OfficeViewRoom; actOf: ReadonlyMap<string, OfficePixelAct> }) {
  const t = proj.tile;
  const r = proj.rect(room.rect);
  // planks run across the chamber; their joints step every other row
  const planks: ReactNode[] = [];
  for (let j = 1; j < room.rect.h; j++) {
    const y = r.y + j * t;
    planks.push(<line key={`p${j}`} x1={r.x} y1={y} x2={r.x + r.w} y2={y} />);
    for (let i = j % 2 ? 3 : 1.5; i < room.rect.w; i += 3) planks.push(<line key={`j${j}.${i}`} x1={r.x + i * t} y1={y - t} x2={r.x + i * t} y2={y} />);
  }
  const k = proj.project(room.coffee);
  const bannerX = r.x + r.w - t * 2.4;
  return (
    <g className={`fg-chamber fg-dept-${room.id}`}>
      <rect className="fg-planks" x={r.x} y={r.y} width={r.w} height={r.h} />
      <g className="fg-plank-lines">{planks}</g>
      <rect className="fg-wall" x={r.x} y={r.y} width={r.w} height={r.h} />
      {/* the chamber's name on a parchment ribbon */}
      <path className="fg-ribbon" d={`M ${r.x + t * 0.6} ${r.y + t * 0.45} H ${r.x + r.w - t * 3.2} L ${r.x + r.w - t * 3.6} ${r.y + t * 0.95} L ${r.x + r.w - t * 3.2} ${r.y + t * 1.45} H ${r.x + t * 0.6} Z`} />
      <text className="fg-label" x={r.x + t * 0.95} y={r.y + t * 1.17} style={{ fontSize: Math.max(9, Math.round(t * 0.6)) }}>
        {PLACES.rooms[room.id]}
      </text>
      {/* the guild banner: a pole and a swallow-tailed cloth in the department's hue */}
      <g className="fg-banner">
        <rect className="fg-pole" x={bannerX - t * 0.2} y={r.y + t * 0.2} width={t * 2} height={t * 0.22} rx={t * 0.1} />
        <path className="fg-cloth" d={`M ${bannerX} ${r.y + t * 0.42} H ${bannerX + t * 1.6} V ${r.y + t * 2.6} L ${bannerX + t * 0.8} ${r.y + t * 2.05} L ${bannerX} ${r.y + t * 2.6} Z`} />
        <circle className="fg-sigil" cx={bannerX + t * 0.8} cy={r.y + t * 1.25} r={t * 0.32} />
      </g>
      {room.desks.map((d) => {
        const act = actOf.get(d.roleId) ?? 'idle';
        const c = proj.rect(d.rect);
        const seat = proj.project(d.seat);
        const cx = c.x + c.w * 0.82;
        const cy = c.y + c.h * 0.42;
        return (
          <g key={d.roleId} className={`fg-table c-${CANDLE[act]}`}>
            <circle className="fg-stool" cx={seat.x} cy={seat.y - t * 0.15} r={t * 0.55} />
            <rect className="fg-oak" x={c.x} y={c.y} width={c.w} height={c.h} rx={t * 0.2} />
            <rect className="fg-oak-edge" x={c.x} y={c.y + c.h - t * 0.18} width={c.w} height={t * 0.18} />
            {/* an open book: two parchment pages and a spine */}
            <rect className="fg-page" x={c.x + c.w * 0.3} y={c.y + c.h * 0.22} width={c.w * 0.19} height={c.h * 0.56} />
            <rect className="fg-page" x={c.x + c.w * 0.5} y={c.y + c.h * 0.22} width={c.w * 0.19} height={c.h * 0.56} />
            <rect className="fg-spine" x={c.x + c.w * 0.49} y={c.y + c.h * 0.2} width={Math.max(1, c.w * 0.012)} height={c.h * 0.6} />
            <rect className="fg-ink" x={c.x + c.w * 0.1} y={c.y + c.h * 0.35} width={c.w * 0.08} height={c.h * 0.3} rx={t * 0.06} />
            {/* the candle: its flame burns while its owner works */}
            <circle className="fg-candle" cx={cx} cy={cy} r={t * 0.2} />
            <path className="fg-flame" d={`M ${cx} ${cy - t * 0.78} Q ${cx + t * 0.22} ${cy - t * 0.35} ${cx} ${cy - t * 0.12} Q ${cx - t * 0.22} ${cy - t * 0.35} ${cx} ${cy - t * 0.78} Z`} />
          </g>
        );
      })}
      {/* the ale barrel: where an idle member fetches a tankard */}
      <g className="fg-barrel">
        <circle className="fg-cask" cx={k.x} cy={k.y} r={t * 0.62} />
        <circle className="fg-hoop" cx={k.x} cy={k.y} r={t * 0.45} />
        <circle className="fg-bung" cx={k.x} cy={k.y} r={t * 0.12} />
      </g>
      {huddleTables(room).map((h) => {
        const p = proj.project(h.at);
        return (
          <g key={h.id} className="fg-council">
            <circle className="fg-council-ring" cx={p.x} cy={p.y} r={t * 2.4} />
            <circle className="fg-oak" cx={p.x} cy={p.y} r={t * 1.05} />
            <circle className="fg-map" cx={p.x} cy={p.y} r={t * 0.55} />
          </g>
        );
      })}
    </g>
  );
}

/** the layout's own table rule: the first huddle at `room.table`, a second at the far end */
function huddleTables(room: OfficeViewRoom): { id: string; at: { x: number; y: number } }[] {
  if (!room.table) return [];
  const table = room.table;
  return room.huddleIds.map((id, k) => ({ id, at: k === 0 ? table : { x: room.floor.x + room.floor.w / 2 + 0.5, y: table.y } }));
}

function Gatehouse({ proj, layout }: { proj: OfficeFlatProjection; layout: OfficeLayout }) {
  const t = proj.tile;
  const r = proj.rect(layout.lobby);
  const door = proj.project(layout.door);
  const board = proj.project(layout.board);
  const notes = [
    [-0.75, -0.45],
    [0.05, -0.55],
    [-0.35, 0.15],
    [0.45, 0.1],
  ];
  return (
    <g className="fg-lobby">
      <rect className="fg-planks lobby" x={r.x} y={r.y} width={r.w} height={r.h} />
      <rect className="fg-wall" x={r.x} y={r.y} width={r.w} height={r.h} />
      <text className="fg-label lobby" x={r.x + r.w / 2} y={r.y + t * 0.95} style={{ fontSize: Math.max(9, Math.round(t * 0.55)) }}>
        {PLACES.lobby}
      </text>
      {/* the gate: an arched oak door with iron bands */}
      <g className="fg-gate">
        <path className="fg-door" d={`M ${door.x - t * 0.85} ${door.y + t * 0.8} V ${door.y - t * 0.15} A ${t * 0.85} ${t * 0.85} 0 0 1 ${door.x + t * 0.85} ${door.y - t * 0.15} V ${door.y + t * 0.8} Z`} />
        <rect className="fg-band" x={door.x - t * 0.85} y={door.y - t * 0.05} width={t * 1.7} height={t * 0.14} />
        <rect className="fg-band" x={door.x - t * 0.85} y={door.y + t * 0.45} width={t * 1.7} height={t * 0.14} />
      </g>
      <text className="fg-place-label" x={door.x} y={door.y + t * 1.35}>
        {PLACES.door}
      </text>
      {/* the quest board: pinned parchment — the channel */}
      <g className="fg-quests">
        <rect className="fg-board" x={board.x - t * 1.2} y={board.y - t * 0.8} width={t * 2.4} height={t * 1.6} rx={t * 0.12} />
        {notes.map(([dx, dy], i) => (
          <rect key={i} className={`fg-note n${i}`} x={board.x + dx * t} y={board.y + dy * t} width={t * 0.6} height={t * 0.5} />
        ))}
      </g>
      <text className="fg-place-label" x={board.x} y={board.y + t * 1.35}>
        {PLACES.board}
      </text>
    </g>
  );
}

// ---- hand-offs -----------------------------------------------------------------

/** the scroll carried along a hand-off's trail; at rest (calm, reduced motion) it waits halfway */
function Scroll({ edge, d, lit }: { edge: OfficeViewEdge; d: string; lit: boolean }) {
  return (
    <span
      className={`fg-scroll k-${edge.kind}${edge.tainted ? ' tainted' : ''}${lit ? ' hl' : ''}`}
      style={{ offsetPath: `path('${d}')`, animationDelay: `-${officeHash(edge.id) % 4000}ms` }}
      aria-hidden
    />
  );
}

// ---- guild members ---------------------------------------------------------------

/**
 * A robed guild member, 12×16: a cloak in the role's colour, a hood a shade
 * darker, a belt. Seated = seen from behind at the table (hood and shoulders,
 * sleeves on the book; asleep, the hood drops). Standing faces the viewer;
 * the waiting one raises its right sleeve; a break at the barrel holds a
 * tankard.
 */
function Robed({ act, seated, tankard }: { act: OfficePixelAct; seated: boolean; tankard: boolean }) {
  const parts: ReactNode[] = [];
  if (seated) {
    const hy = act === 'typing' ? 3.6 : 5.2;
    parts.push(<rect key="al" className="arm al" x={1.2} y={6.6} width={1.8} height={4} rx={0.9} />);
    parts.push(<rect key="ar" className="arm ar" x={9} y={6.6} width={1.8} height={4} rx={0.9} />);
    parts.push(<path key="b" className="body" d="M3 7 L9 7 L10.2 13.6 L1.8 13.6 Z" />);
    parts.push(<circle key="h" className="hood" cx={6} cy={hy} r={2.9} />);
  } else {
    parts.push(<path key="b" className="body" d="M4 6 L8 6 L10.6 15.6 L1.4 15.6 Z" />);
    parts.push(<rect key="belt" className="belt" x={3.2} y={10} width={5.6} height={0.9} />);
    parts.push(<rect key="al" className="arm" x={1.4} y={6.6} width={1.8} height={4.6} rx={0.9} />);
    if (act === 'hand-up') parts.push(<rect key="ar" className="arm" x={8.8} y={0.6} width={1.8} height={6.6} rx={0.9} />, <circle key="hr" className="skin" cx={9.7} cy={0.9} r={0.8} />);
    else parts.push(<rect key="ar" className="arm" x={8.8} y={6.6} width={1.8} height={4.6} rx={0.9} />);
    if (tankard) parts.push(<rect key="tk" className="tankard" x={9.8} y={10.2} width={1.8} height={2} rx={0.3} />);
    parts.push(<circle key="h" className="hood" cx={6} cy={3.6} r={3} />);
    parts.push(<circle key="f" className="skin" cx={6} cy={4.1} r={1.9} />);
    parts.push(<rect key="e1" className="eye" x={5} y={3.9} width={0.6} height={0.6} />);
    parts.push(<rect key="e2" className="eye" x={6.4} y={3.9} width={0.6} height={0.6} />);
  }
  return (
    <svg className={`fg-robed${seated ? ' seated' : ''}`} viewBox="0 0 12 16" aria-hidden>
      {parts}
    </svg>
  );
}
