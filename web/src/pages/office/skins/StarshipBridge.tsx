// The Starship bridge skin (docs/office.md § Starship bridge): the same
// `OfficeLayout` seen from above as a ship's bridge — each department a
// station module floating in a star field, every desk a console whose screen
// is LIT BY ITS OWNER'S STATE (working: accent, waiting: blinking amber hail,
// guarded: standby, paused / over budget: red, off: dark), a holo-table where a
// huddle meets, a replicator where the coffee was, the airlock (you) and the
// comms array (the channel) in the lobby. A hand-off is a comms beam: a glow
// with a marching core and a pulse running along it.
//
// Drawn top-down through `officeFlatProjection` (shared), SVG + CSS only, no
// assets. Every colour is a `--tm-bridge-*` / `--tm-*` token, every infinite
// animation is stepped and listed in theme.css § Calm, and
// prefers-reduced-motion turns them off.
import { useMemo, type ReactNode } from 'react';
import {
  OFFICE_SKIN_PLACES,
  officeFlatProjection,
  officeHash,
  officeScatter,
  type OfficeFlatProjection,
  type OfficeLayout,
  type OfficePixelAct,
  type OfficeViewEdge,
  type OfficeViewRoom,
} from '@tm/shared';
import type { OfficeSkinProps } from '../../../officeThemes.ts';
import { FALLBACK_WIDTH, FlatAvatar, cssVars, flatEdgePath, useAmbientScene, useAmbientTick, useWalk, useWidth, type BubbleGlyphs } from './common.tsx';

const PLACES = OFFICE_SKIN_PLACES['starship-bridge'];
const GLYPHS: BubbleGlyphs = { waiting: '!', guarded: 'standby', dozing: 'z', paused: '⏸', overBudget: '$', huddle: '📡', chat: '💬' };

/** what the console screen shows for its owner's act */
const SCREEN: Record<OfficePixelAct, string> = {
  typing: 'on',
  'hand-up': 'hail',
  asleep: 'standby',
  dozing: 'off',
  greyed: 'alert',
  huddle: 'away',
  idle: 'idle',
};

export default function StarshipBridge({ layout, mobile, selectedRoleId, highlight, onAvatar }: OfficeSkinProps) {
  const [wrap, width] = useWidth();
  const proj = useMemo(() => officeFlatProjection(layout, width || FALLBACK_WIDTH, { minTile: 12, maxTile: mobile ? 26 : 24 }), [layout, width, mobile]);
  const tick = useAmbientTick();
  const walk = useWalk(proj.tile, proj.width);
  const { spots, spotAt, actOf } = useAmbientScene(layout, tick);
  const stars = useMemo(() => officeScatter(officeHash(`${layout.width}x${layout.height}`), Math.round((proj.width * proj.height) / 2600), proj.width, proj.height), [layout.width, layout.height, proj.width, proj.height]);
  const t = proj.tile;

  return (
    <div className={`sb-wrap${mobile ? ' phone' : ''}`} ref={wrap}>
      <div
        className={`sb-floor${highlight ? ' has-hl' : ''}${walk ? ' walk' : ''}`}
        style={cssVars({ '--sb-t': `${t}px`, width: proj.width, height: proj.height })}
        role="group"
        aria-label="Starship bridge"
      >
        <svg className="sb-svg" width={proj.width} height={proj.height} viewBox={`0 0 ${proj.width} ${proj.height}`} aria-hidden>
          <rect className="sb-space" x={0} y={0} width={proj.width} height={proj.height} />
          <g className="sb-stars">
            {stars.map((s, i) => (
              <rect key={i} className={`sb-star k${s.k}`} x={s.x} y={s.y} width={s.k === 2 ? 2 : 1} height={s.k === 2 ? 2 : 1} />
            ))}
          </g>
          {layout.rooms.map((room) => (
            <Station key={room.id} proj={proj} room={room} actOf={actOf} />
          ))}
          <Airlock proj={proj} layout={layout} />
          <g className="sb-beams">
            {layout.edges.map((e) => {
              const d = flatEdgePath(proj, e, spotAt, e.kind === 'huddle' ? 0 : 0.18);
              const cls = `k-${e.kind}${e.tainted ? ' tainted' : ''}${highlight?.edgeId === e.id ? ' hl' : ''}`;
              return (
                <g key={e.id} className={`sb-beam ${cls}`}>
                  <path className="sb-beam-glow" d={d} />
                  <path className="sb-beam-core" d={d} />
                </g>
              );
            })}
          </g>
        </svg>

        {layout.edges
          .filter((e) => e.kind !== 'huddle')
          .map((e) => (
            <Pulse key={e.id} edge={e} d={flatEdgePath(proj, e, spotAt, 0.18)} lit={highlight?.edgeId === e.id} />
          ))}

        {layout.avatars.map((a) => {
          const spot = spots.get(a.roleId)!;
          const act = actOf.get(a.roleId)!;
          return (
            <FlatAvatar
              key={a.roleId}
              prefix="sb"
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
              <Crew act={act} seated={act === 'typing' || act === 'asleep' || act === 'dozing'} cup={act === 'idle' && spot.activity === 'coffee'} />
            </FlatAvatar>
          );
        })}
      </div>
    </div>
  );
}

// ---- the floor -------------------------------------------------------------------

function Station({ proj, room, actOf }: { proj: OfficeFlatProjection; room: OfficeViewRoom; actOf: ReadonlyMap<string, OfficePixelAct> }) {
  const t = proj.tile;
  const r = proj.rect(room.rect);
  const grid: ReactNode[] = [];
  for (let i = 2; i < room.rect.w; i += 2) grid.push(<line key={`x${i}`} x1={r.x + i * t} y1={r.y + 1.6 * t} x2={r.x + i * t} y2={r.y + r.h} />);
  for (let j = 3; j < room.rect.h; j += 2) grid.push(<line key={`y${j}`} x1={r.x} y1={r.y + j * t} x2={r.x + r.w} y2={r.y + j * t} />);
  const k = proj.project(room.coffee);
  return (
    <g className={`sb-station sb-dept-${room.id}`}>
      <rect className="sb-hull" x={r.x} y={r.y} width={r.w} height={r.h} rx={t * 0.7} />
      <g className="sb-grid">{grid}</g>
      {/* the station's header: a lit strip in the department's hue, its name on it */}
      <rect className="sb-head" x={r.x + t * 0.5} y={r.y + t * 0.35} width={r.w - t} height={t * 1.1} rx={t * 0.3} />
      <text className="sb-label" x={r.x + t * 0.9} y={r.y + t * 1.15} style={{ fontSize: Math.max(9, Math.round(t * 0.62)) }}>
        {PLACES.rooms[room.id]}
      </text>
      <rect className="sb-bulkhead" x={r.x} y={r.y} width={r.w} height={r.h} rx={t * 0.7} />
      {room.desks.map((d) => {
        const act = actOf.get(d.roleId) ?? 'idle';
        const c = proj.rect(d.rect);
        const seat = proj.project(d.seat);
        return (
          <g key={d.roleId} className={`sb-console s-${SCREEN[act]}`}>
            {/* the pilot's seat, under the avatar */}
            <circle className="sb-seat" cx={seat.x} cy={seat.y - t * 0.15} r={t * 0.62} />
            {/* the console: a curved desk with a screen and three keys */}
            <path className="sb-desk" d={consolePath(c.x, c.y, c.w, c.h)} />
            <rect className="sb-screen" x={c.x + c.w * 0.14} y={c.y + c.h * 0.16} width={c.w * 0.72} height={c.h * 0.4} rx={t * 0.12} />
            {[0, 1, 2].map((i) => (
              <rect key={i} className={`sb-key k${i}`} x={c.x + c.w * (0.3 + i * 0.16)} y={c.y + c.h * 0.68} width={c.w * 0.08} height={c.h * 0.12} />
            ))}
          </g>
        );
      })}
      {/* the replicator: where an idle crew member fetches a cup */}
      <g className="sb-replicator">
        <rect className="sb-desk" x={k.x - t * 0.55} y={k.y - t * 0.55} width={t * 1.1} height={t * 1.1} rx={t * 0.2} />
        <rect className="sb-slot" x={k.x - t * 0.3} y={k.y - t * 0.15} width={t * 0.6} height={t * 0.3} />
      </g>
      {huddleTables(room).map((h) => {
        const p = proj.project(h.at);
        return (
          <g key={h.id} className="sb-holo">
            <circle className="sb-holo-ring" cx={p.x} cy={p.y} r={t * 2.4} />
            <circle className="sb-holo-table" cx={p.x} cy={p.y} r={t * 0.95} />
            <circle className="sb-holo-light" cx={p.x} cy={p.y} r={t * 0.5} />
          </g>
        );
      })}
    </g>
  );
}

/** a console seen from above: a desk whose front edge bows toward the seat */
function consolePath(x: number, y: number, w: number, h: number): string {
  return `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h * 0.7} Q ${x + w / 2} ${y + h * 1.25} ${x} ${y + h * 0.7} Z`;
}

/** the layout's own table rule: the first huddle at `room.table`, a second at the far end */
function huddleTables(room: OfficeViewRoom): { id: string; at: { x: number; y: number } }[] {
  if (!room.table) return [];
  const table = room.table;
  return room.huddleIds.map((id, k) => ({ id, at: k === 0 ? table : { x: room.floor.x + room.floor.w / 2 + 0.5, y: table.y } }));
}

function Airlock({ proj, layout }: { proj: OfficeFlatProjection; layout: OfficeLayout }) {
  const t = proj.tile;
  const r = proj.rect(layout.lobby);
  const door = proj.project(layout.door);
  const board = proj.project(layout.board);
  return (
    <g className="sb-lobby">
      <rect className="sb-hull lobby" x={r.x} y={r.y} width={r.w} height={r.h} rx={t * 0.7} />
      <rect className="sb-bulkhead" x={r.x} y={r.y} width={r.w} height={r.h} rx={t * 0.7} />
      <text className="sb-label lobby" x={r.x + r.w / 2} y={r.y + t * 0.95} style={{ fontSize: Math.max(9, Math.round(t * 0.55)) }}>
        {PLACES.lobby}
      </text>
      {/* the airlock: two sliding leaves and their seam */}
      <g className="sb-airlock">
        <rect className="sb-door" x={door.x - t * 0.9} y={door.y - t * 0.8} width={t * 0.88} height={t * 1.6} />
        <rect className="sb-door" x={door.x + t * 0.02} y={door.y - t * 0.8} width={t * 0.88} height={t * 1.6} />
        <rect className="sb-door-light" x={door.x - t * 0.9} y={door.y - t * 0.95} width={t * 1.8} height={t * 0.12} />
      </g>
      <text className="sb-place-label" x={door.x} y={door.y + t * 1.35}>
        {PLACES.door}
      </text>
      {/* the comms array: a dish with three status lights — the channel */}
      <g className="sb-array">
        <circle className="sb-dish" cx={board.x} cy={board.y} r={t * 0.85} />
        <circle className="sb-dish-core" cx={board.x} cy={board.y} r={t * 0.28} />
        {[-1, 0, 1].map((i) => (
          <rect key={i} className={`sb-array-led l${i + 1}`} x={board.x - t * 1.45} y={board.y + i * t * 0.4 - t * 0.1} width={t * 0.3} height={t * 0.2} />
        ))}
      </g>
      <text className="sb-place-label" x={board.x} y={board.y + t * 1.35}>
        {PLACES.board}
      </text>
    </g>
  );
}

// ---- hand-offs -----------------------------------------------------------------

/** the pulse running along a comms beam; at rest (calm, reduced motion) it waits halfway */
function Pulse({ edge, d, lit }: { edge: OfficeViewEdge; d: string; lit: boolean }) {
  return (
    <span
      className={`sb-pulse k-${edge.kind}${edge.tainted ? ' tainted' : ''}${lit ? ' hl' : ''}`}
      style={{ offsetPath: `path('${d}')`, animationDelay: `-${officeHash(edge.id) % 2400}ms` }}
      aria-hidden
    />
  );
}

// ---- crew ------------------------------------------------------------------------

/**
 * A crew member, 12×16: a uniform in the role's colour with a dark collar and
 * a combadge. Seated = seen from behind at the console (head and shoulders,
 * arms on the keys; asleep, the head drops). Standing faces the viewer; the
 * waiting one raises its right arm; a coffee break holds a cup.
 */
function Crew({ act, seated, cup }: { act: OfficePixelAct; seated: boolean; cup: boolean }) {
  const parts: ReactNode[] = [];
  if (seated) {
    const hy = act === 'typing' ? 3.4 : 5;
    parts.push(<rect key="al" className="arm al" x={1.4} y={6.4} width={1.6} height={4} rx={0.8} />);
    parts.push(<rect key="ar" className="arm ar" x={9} y={6.4} width={1.6} height={4} rx={0.8} />);
    parts.push(<rect key="b" className="body" x={2.6} y={7} width={6.8} height={6.4} rx={2} />);
    parts.push(<rect key="col" className="trim" x={3.6} y={7} width={4.8} height={1.1} rx={0.5} />);
    parts.push(<circle key="h" className="hair" cx={6} cy={hy} r={2.7} />);
  } else {
    parts.push(<rect key="l1" className="legs" x={3.7} y={12.4} width={2} height={3.4} rx={0.6} />);
    parts.push(<rect key="l2" className="legs" x={6.3} y={12.4} width={2} height={3.4} rx={0.6} />);
    parts.push(<rect key="al" className="arm" x={1.3} y={6.8} width={1.6} height={4.6} rx={0.8} />);
    if (act === 'hand-up') parts.push(<rect key="ar" className="arm" x={9.1} y={0.6} width={1.6} height={6.6} rx={0.8} />);
    else parts.push(<rect key="ar" className="arm" x={9.1} y={6.8} width={1.6} height={4.6} rx={0.8} />);
    if (cup) parts.push(<rect key="cup" className="cup" x={10.2} y={10} width={1.6} height={1.8} rx={0.3} />);
    parts.push(<rect key="b" className="body" x={2.6} y={6.4} width={6.8} height={6.6} rx={1.8} />);
    parts.push(<rect key="col" className="trim" x={2.6} y={6.4} width={6.8} height={1.2} rx={0.6} />);
    parts.push(<circle key="badge" className="badge" cx={4.4} cy={8.8} r={0.7} />);
    parts.push(<circle key="h" className="skin" cx={6} cy={3.4} r={2.6} />);
    parts.push(<path key="hair" className="hair" d="M3.4 3.2 A2.6 2.6 0 0 1 8.6 3.2 L8.6 2.6 L3.4 2.6 Z" />);
    parts.push(<rect key="e1" className="eye" x={4.7} y={3.4} width={0.7} height={0.7} />);
    parts.push(<rect key="e2" className="eye" x={6.6} y={3.4} width={0.7} height={0.7} />);
  }
  return (
    <svg className={`sb-crew${seated ? ' seated' : ''}`} viewBox="0 0 12 16" aria-hidden>
      {parts}
    </svg>
  );
}
