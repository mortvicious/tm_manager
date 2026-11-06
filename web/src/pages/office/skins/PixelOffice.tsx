// The Pixel office skin (docs/office.md § The view → Pixel office): the
// default `OFFICE_THEMES` entry. An ISOMETRIC pixel-art floor drawn with SVG
// and CSS only — no image assets — from the pure `OfficeLayout`, through the
// pure projection in shared (`officeIsoProjection`): rooms with back walls and
// a tiled floor, desks with monitors and chairs, a coffee corner and a plant
// per room, huddle tables, and the lobby's door (you) and notice board (the
// channel). Each role is a pixel sprite acting out its STATE (not only its
// pose): typing at a lit monitor, asleep at the desk with the guard's skip
// reason in a bubble, a raised hand when something waits on you, greyed when
// paused or over budget, grouped round a table in a huddle. A hand-off is a
// paper packet flying an arc from one avatar to the other.
//
// Ambient life: an idle avatar strolls, fetches coffee or chats, one step per
// AMBIENT_MS on the shared clock and only while the app is not calm
// (`html[data-calm]`: unfocused, hidden, 60 s idle, reduced motion). Every
// infinite animation here is stepped and listed in theme.css § Calm, and
// prefers-reduced-motion turns every animation and transition off.
import { useMemo, type CSSProperties, type ReactNode } from 'react';
import {
  OFFICE_ISO_WALL,
  officeHash,
  officeIsoProjection,
  officeSkipReason,
  officeEdgeEnds,
  type OfficePixelAct as PixelAct,
  type OfficeIsoProjection,
  type OfficeIsoRegion,
  type OfficeIsoScreenPoint,
  type OfficeLayout,
  type OfficeViewAvatar,
  type OfficeViewEdge,
  type OfficeViewPoint,
  type OfficeViewRect,
  type OfficeViewRoom,
  type OfficeWanderActivity,
} from '@tm/shared';
import type { OfficeSkinProps } from '../../../officeThemes.ts';
import { FALLBACK_WIDTH, STATE_LABEL, clip, cssVars as v, useAmbientScene, useAmbientTick, useWalk, useWidth } from './common.tsx';

const pts = (list: readonly OfficeIsoScreenPoint[]): string => list.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

export default function PixelOffice({ layout, mobile, selectedRoleId, highlight, onAvatar }: OfficeSkinProps) {
  const [wrap, width] = useWidth();
  const proj = useMemo(() => officeIsoProjection(layout, width || FALLBACK_WIDTH, { maxA: mobile ? 18 : 22 }), [layout, width, mobile]);
  const tick = useAmbientTick();
  // avatars WALK only between ambient spots: a new scale (first measure, a
  // resize, the stack fallback) re-places them at once, then walking resumes
  const walk = useWalk(proj.a, proj.mode, proj.width);
  const { spots, spotAt, actOf } = useAmbientScene(layout, tick);

  const roomBlocks = [...layout.rooms].sort((p, q) => p.rect.y - q.rect.y || p.rect.x - q.rect.x);
  const px = Math.max(2, Math.round((proj.a * 2.6) / 16)); // one sprite pixel, whole px so it stays crisp

  return (
    <div className={`po-wrap${mobile ? ' phone' : ''}`} ref={wrap}>
      <div
        className={`po-floor${highlight ? ' has-hl' : ''}${walk ? ' walk' : ''}`}
        style={v({ '--po-a': `${proj.a}px`, '--po-px': `${px}px`, width: proj.width, height: proj.height })}
        role="group"
        aria-label="Office floor"
      >
        <svg className="po-svg" width={proj.width} height={proj.height} viewBox={`0 0 ${proj.width} ${proj.height}`} aria-hidden>
          {proj.mode === 'floor' && <Plate proj={proj} rect={proj.regions[0].rect} />}
          {roomBlocks.map((room) => (
            <Room key={room.id} proj={proj} room={room} actOf={actOf} layout={layout} />
          ))}
          <Lobby proj={proj} layout={layout} />
          <g className="po-edges">
            {layout.edges.map((e) => {
              const d = edgePath(proj, e, spotAt);
              return <path key={e.id} d={d} className={`po-edge k-${e.kind}${e.tainted ? ' tainted' : ''}${highlight?.edgeId === e.id ? ' hl' : ''}`} />;
            })}
          </g>
        </svg>

        {layout.edges
          .filter((e) => e.kind !== 'huddle')
          .map((e) => (
            <Packet key={e.id} edge={e} d={edgePath(proj, e, spotAt)} lit={highlight?.edgeId === e.id} />
          ))}

        {layout.avatars.map((a) => {
          const spot = spots.get(a.roleId)!;
          const feet = proj.project(spot.at, 0);
          return (
            <Avatar
              key={a.roleId}
              avatar={a}
              act={actOf.get(a.roleId)!}
              activity={spot.activity}
              feet={feet}
              a={proj.a}
              selected={a.roleId === selectedRoleId}
              lit={highlight?.roleIds.has(a.roleId) ?? false}
              onClick={() => onAvatar(a.roleId)}
            />
          );
        })}
      </div>
    </div>
  );
}

// ---- geometry helpers -------------------------------------------------------

/** an isometric box over a tile rect, from height z0 to z1: top, the +y face (front left), the +x face (front right) */
function Box({ proj, rect: r, z0, z1, kind, className, style, region }: { proj: OfficeIsoProjection; rect: OfficeViewRect; z0: number; z1: number; kind: string; className?: string; style?: CSSProperties; region?: OfficeIsoRegion }) {
  const c = (x: number, y: number, z: number) => (region ? proj.projectIn(region, { x, y }, z) : proj.project({ x, y }, z));
  const { x, y, w, h } = r;
  return (
    <g className={`po-box ${kind}${className ? ` ${className}` : ''}`} style={style}>
      <polygon className="fl" points={pts([c(x, y + h, z0), c(x + w, y + h, z0), c(x + w, y + h, z1), c(x, y + h, z1)])} />
      <polygon className="fr" points={pts([c(x + w, y, z0), c(x + w, y + h, z0), c(x + w, y + h, z1), c(x + w, y, z1)])} />
      <polygon className="ft" points={pts([c(x, y, z1), c(x + w, y, z1), c(x + w, y + h, z1), c(x, y + h, z1)])} />
    </g>
  );
}

/** a flat tile rect at height z (a floor decal, a rug, a screen) */
function Flat({ proj, rect: r, z = 0, className, region }: { proj: OfficeIsoProjection; rect: OfficeViewRect; z?: number; className: string; region?: OfficeIsoRegion }) {
  const c = (x: number, y: number) => (region ? proj.projectIn(region, { x, y }, z) : proj.project({ x, y }, z));
  return <polygon className={className} points={pts([c(r.x, r.y), c(r.x + r.w, r.y), c(r.x + r.w, r.y + r.h), c(r.x, r.y + r.h)])} />;
}

/** a block's tiled floor, its two back walls and a name painted on the back wall */
function Block({ proj, rect: r, label, className, labelAt = 0.6 }: { proj: OfficeIsoProjection; rect: OfficeViewRect; label: string; className: string; labelAt?: number }) {
  const region = proj.regionOf({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const c = (x: number, y: number, z = 0) => proj.projectIn(region, { x, y }, z);
  const grid: ReactNode[] = [];
  for (let i = 1; i < r.w; i++) {
    const p = c(r.x + i, r.y);
    const q = c(r.x + i, r.y + r.h);
    grid.push(<line key={`gx${i}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} />);
  }
  for (let j = 1; j < r.h; j++) {
    const p = c(r.x, r.y + j);
    const q = c(r.x + r.w, r.y + j);
    grid.push(<line key={`gy${j}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} />);
  }
  const W = OFFICE_ISO_WALL;
  const at = c(r.x + labelAt, r.y, W * 0.32);
  const size = Math.max(9, Math.round(proj.a * 0.8));
  return (
    <g className={`po-block ${className}`}>
      <polygon className="po-tiles" points={pts([c(r.x, r.y), c(r.x + r.w, r.y), c(r.x + r.w, r.y + r.h), c(r.x, r.y + r.h)])} />
      <g className="po-grid">{grid}</g>
      {/* back walls: along the top edge (faces +y) and the left edge (faces +x) */}
      <polygon className="po-wall-back" points={pts([c(r.x, r.y), c(r.x + r.w, r.y), c(r.x + r.w, r.y, W), c(r.x, r.y, W)])} />
      <polygon className="po-wall-side" points={pts([c(r.x, r.y), c(r.x, r.y + r.h), c(r.x, r.y + r.h, W), c(r.x, r.y, W)])} />
      <polyline className="po-wall-cap" points={pts([c(r.x, r.y + r.h, W), c(r.x, r.y, W), c(r.x + r.w, r.y, W)])} />
      <text className="po-wall-label" transform={`matrix(1 0.5 0 1 ${at.x.toFixed(1)} ${at.y.toFixed(1)})`} style={{ fontSize: size }}>
        {label}
      </text>
    </g>
  );
}

/** desktop: the slab every room stands on, so the gaps read as corridors */
function Plate({ proj, rect }: { proj: OfficeIsoProjection; rect: OfficeViewRect }) {
  return <Flat proj={proj} rect={rect} className="po-slab" region={proj.regions[0]} />;
}

/** where each open huddle's table stands — the layout's own rule (`room.table`, a second one at the far end) */
function huddleTables(room: OfficeViewRoom): { id: string; at: OfficeViewPoint }[] {
  if (!room.table) return [];
  const table = room.table;
  return room.huddleIds.map((id, k) => ({ id, at: k === 0 ? table : { x: room.floor.x + room.floor.w / 2 + 0.5, y: table.y } }));
}

function Room({ proj: whole, room, actOf, layout }: { proj: OfficeIsoProjection; room: OfficeViewRoom; actOf: ReadonlyMap<string, PixelAct>; layout: OfficeLayout }) {
  type Prop = { depth: number; node: ReactNode };
  const props: Prop[] = [];
  // everything in the room projects through the room's own block (stack mode), even a point on its edge
  const region = whole.regionOf({ x: room.rect.x + room.rect.w / 2, y: room.rect.y + room.rect.h / 2 });
  const proj: OfficeIsoProjection = { ...whole, project: (p, z) => whole.projectIn(region, p, z), regionOf: () => region };
  const depth = (p: OfficeViewPoint) => proj.project(p).depth;
  for (const d of room.desks) {
    const act = actOf.get(d.roleId);
    const r = d.rect;
    const cx = r.x + r.w / 2;
    const lit = act === 'typing';
    const holder = layout.avatars.find((a) => a.roleId === d.roleId);
    props.push({
      depth: depth({ x: r.x + r.w, y: r.y + r.h }),
      node: (
        <g key={`desk-${d.roleId}`} className={`po-desk${lit ? ' lit' : ''}`}>
          <Box proj={proj} rect={r} z0={0} z1={0.75} kind="po-wood" />
          {/* the role's mug on the desk, in its colour */}
          {holder && <Box proj={proj} rect={{ x: r.x + r.w - 0.55, y: r.y + r.h - 0.55, w: 0.25, h: 0.25 }} z0={0.75} z1={0.98} kind="po-mug" style={v({ '--base': `var(--tm-group-${holder.colorSlot})` })} />}
          <Box proj={proj} rect={{ x: cx - 0.1, y: r.y + 0.3, w: 0.2, h: 0.15 }} z0={0.75} z1={0.95} kind="po-metal" />
          <Box proj={proj} rect={{ x: cx - 0.7, y: r.y + 0.2, w: 1.4, h: 0.14 }} z0={0.95} z1={1.75} kind="po-metal" />
          {/* the screen is the monitor's front (+y) face */}
          <Screen proj={proj} x={cx - 0.62} y={r.y + 0.34} w={1.24} z0={1.02} z1={1.68} />
          <Box proj={proj} rect={{ x: cx - 0.55, y: r.y + r.h - 0.6, w: 1.1, h: 0.3 }} z0={0.75} z1={0.8} kind="po-key" />
        </g>
      ),
    });
    props.push({
      depth: depth({ x: d.seat.x, y: d.seat.y }) - 1,
      node: <Box key={`chair-${d.roleId}`} proj={proj} rect={{ x: d.seat.x - 0.4, y: d.seat.y - 0.35, w: 0.8, h: 0.7 }} z0={0.3} z1={0.45} kind="po-chair" />,
    });
  }
  // the coffee corner: a counter with a machine on it
  const k = room.coffee;
  props.push({
    depth: depth({ x: k.x + 0.5, y: k.y + 0.4 }),
    node: (
      <g key="coffee" className="po-coffee">
        <Box proj={proj} rect={{ x: k.x - 0.6, y: k.y - 0.4, w: 1.1, h: 0.8 }} z0={0} z1={0.8} kind="po-wood" />
        <Box proj={proj} rect={{ x: k.x - 0.35, y: k.y - 0.3, w: 0.5, h: 0.4 }} z0={0.8} z1={1.45} kind="po-metal" />
        <Box proj={proj} rect={{ x: k.x - 0.25, y: k.y + 0.1, w: 0.12, h: 0.02 }} z0={1.2} z1={1.32} kind="po-led" />
      </g>
    ),
  });
  // a plant in the back corner
  const pl = { x: room.rect.x + room.rect.w - 1, y: room.rect.y + 1 };
  props.push({ depth: depth(pl), node: <Plant key="plant" proj={proj} at={pl} /> });
  // huddle tables, each on a ring that groups its members
  const rings: ReactNode[] = [];
  for (const t of huddleTables(room)) {
    rings.push(<Flat key={`ring-${t.id}`} proj={proj} rect={{ x: t.at.x - 2.7, y: t.at.y - 2, w: 5.4, h: 4.1 }} className="po-huddle-ring" />);
    props.push({
      depth: depth({ x: t.at.x + 1.1, y: t.at.y + 0.6 }),
      node: <Box key={`table-${t.id}`} proj={proj} rect={{ x: t.at.x - 1.1, y: t.at.y - 0.6, w: 2.2, h: 1.2 }} z0={0} z1={0.7} kind="po-table" />,
    });
  }
  props.sort((p, q) => p.depth - q.depth);
  return (
    <g className={`po-room po-room-${room.id}`}>
      <Block proj={proj} rect={room.rect} label={room.label} className="po-room-block" />
      {rings}
      {props.map((p) => p.node)}
    </g>
  );
}

function Screen({ proj, x, y, w, z0, z1 }: { proj: OfficeIsoProjection; x: number; y: number; w: number; z0: number; z1: number }) {
  const c = (px: number, pz: number) => proj.project({ x: px, y }, pz);
  return <polygon className="po-screen" points={pts([c(x, z0), c(x + w, z0), c(x + w, z1), c(x, z1)])} />;
}

function Plant({ proj, at }: { proj: OfficeIsoProjection; at: OfficeViewPoint }) {
  const a = proj.a;
  const c = proj.project(at, 0.55);
  // pixel leaves: a few blocks in screen space above the pot
  const leaves = [
    [-0.55, -1.1, 0.5, 0.5],
    [0.05, -1.3, 0.5, 0.55],
    [-0.25, -1.75, 0.5, 0.6],
    [-0.8, -0.65, 0.45, 0.4],
    [0.35, -0.75, 0.45, 0.4],
  ];
  return (
    <g className="po-plant">
      <Box proj={proj} rect={{ x: at.x - 0.3, y: at.y - 0.3, w: 0.6, h: 0.6 }} z0={0} z1={0.55} kind="po-pot" />
      {leaves.map(([dx, dy, w, h], i) => (
        <rect key={i} className={i % 2 ? 'po-leaf dark' : 'po-leaf'} x={c.x + dx * a} y={c.y + dy * a} width={w * a} height={h * a} />
      ))}
    </g>
  );
}

function Lobby({ proj, layout }: { proj: OfficeIsoProjection; layout: OfficeLayout }) {
  const r = layout.lobby;
  const region = proj.regionOf({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const c = (x: number, z: number) => proj.projectIn(region, { x, y: r.y + 0.02 }, z);
  const door = layout.door;
  const board = layout.board;
  const doorLabel = proj.projectIn(region, { x: door.x, y: door.y + 0.9 }, 0);
  const boardLabel = proj.projectIn(region, { x: board.x, y: board.y + 0.9 }, 0);
  const notes = [
    [-0.75, 1.05, 'n1'],
    [-0.15, 1.15, 'n2'],
    [0.35, 0.95, 'n3'],
  ] as const;
  return (
    <g className="po-lobby">
      <Block proj={proj} rect={r} label="Lobby" className="po-lobby-block" labelAt={layout.door.x - r.x + 1.2} />
      <Flat proj={proj} rect={{ x: door.x - 1, y: r.y + 0.3, w: 2, h: 1.6 }} className="po-rug" region={region} />
      <polygon className="po-door" points={pts([c(door.x - 0.6, 0), c(door.x + 0.6, 0), c(door.x + 0.6, 1.35), c(door.x - 0.6, 1.35)])} />
      <rect className="po-knob" x={c(door.x + 0.38, 0.7).x} y={c(door.x + 0.38, 0.7).y} width={Math.max(2, proj.a * 0.18)} height={Math.max(2, proj.a * 0.18)} />
      <polygon className="po-cork" points={pts([c(board.x - 1, 0.45), c(board.x + 1, 0.45), c(board.x + 1, 1.4), c(board.x - 1, 1.4)])} />
      {notes.map(([dx, z, cls]) => (
        <polygon key={cls} className={`po-note ${cls}`} points={pts([c(board.x + dx, z - 0.32), c(board.x + dx + 0.42, z - 0.32), c(board.x + dx + 0.42, z + 0.1), c(board.x + dx, z + 0.1)])} />
      ))}
      <text className="po-place-label" x={doorLabel.x} y={doorLabel.y}>
        You
      </text>
      <text className="po-place-label" x={boardLabel.x} y={boardLabel.y}>
        Channel
      </text>
    </g>
  );
}

// ---- hand-offs ----------------------------------------------------------------

/** an arc from one end to the other, at chest height for an avatar and wall height for a place */
function edgePath(proj: OfficeIsoProjection, e: OfficeViewEdge, spots: ReadonlyMap<string, OfficeViewPoint>): string {
  const ends = officeEdgeEnds(e, spots);
  const p = proj.project(ends.from, 'role' in e.from ? 1.3 : 1.1);
  const q = proj.project(ends.to, 'role' in e.to ? 1.3 : 1.1);
  const dist = Math.hypot(q.x - p.x, q.y - p.y);
  const lift = Math.max(proj.a, Math.min(dist * 0.3, proj.a * 6));
  const mx = (p.x + q.x) / 2;
  const my = (p.y + q.y) / 2 - lift;
  return `M ${p.x.toFixed(1)} ${p.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
}

/** the paper packet flying along a hand-off; at rest (calm, reduced motion) it waits halfway */
function Packet({ edge, d, lit }: { edge: OfficeViewEdge; d: string; lit: boolean }) {
  return (
    <span
      className={`po-packet k-${edge.kind}${edge.tainted ? ' tainted' : ''}${lit ? ' hl' : ''}`}
      style={{ offsetPath: `path('${d}')`, animationDelay: `-${officeHash(edge.id) % 3200}ms` }}
      aria-hidden
    />
  );
}

// ---- avatars --------------------------------------------------------------------

function bubbleFor(a: OfficeViewAvatar, act: PixelAct, activity: OfficeWanderActivity): { cls: string; text: ReactNode } | null {
  switch (act) {
    case 'typing':
      return {
        cls: 'b-typing',
        text: (
          <>
            <i />
            <i />
            <i />
          </>
        ),
      };
    case 'hand-up':
      return { cls: 'b-waiting', text: '!' };
    case 'asleep': {
      const why = officeSkipReason(a.detail);
      return { cls: 'b-guarded', text: <>z<span className="po-bubble-why">{why ? clip(why, 34) : 'skipped'}</span></> };
    }
    case 'dozing':
      return { cls: 'b-dozing', text: 'z' };
    case 'greyed':
      return { cls: 'b-blocked', text: a.state === 'over-budget' ? '$' : '⏸' };
    case 'huddle':
      return { cls: 'b-huddle', text: '💬' };
    default:
      return activity === 'chat' ? { cls: 'b-chat', text: '💬' } : null;
  }
}

function Avatar({
  avatar: a,
  act,
  activity,
  feet,
  a: unit,
  selected,
  lit,
  onClick,
}: {
  avatar: OfficeViewAvatar;
  act: PixelAct;
  activity: OfficeWanderActivity;
  feet: OfficeIsoScreenPoint;
  a: number;
  selected: boolean;
  lit: boolean;
  onClick: () => void;
}) {
  const bubble = bubbleFor(a, act, activity);
  const seated = act === 'typing' || act === 'asleep' || act === 'dozing';
  return (
    <button
      type="button"
      className={`po-avatar act-${act} st-${a.state} wander-${activity}${selected ? ' selected' : ''}${lit ? ' hl' : ''}`}
      style={v({ '--x': `${feet.x.toFixed(1)}px`, '--y': `${feet.y.toFixed(1)}px`, '--c': `var(--tm-group-${a.colorSlot})`, '--plate': `${Math.round(unit * 4.6)}px`, zIndex: 10 + Math.round(feet.depth / 10) })}
      onClick={onClick}
      aria-label={`${a.name}, ${a.title} — ${STATE_LABEL[a.state]}${a.detail ? `: ${a.detail}` : ''}`}
      aria-pressed={selected}
      title={`${a.name} — ${a.detail || STATE_LABEL[a.state]}`}
    >
      {bubble && (
        <span className={`po-bubble ${bubble.cls}`} aria-hidden>
          {bubble.text}
        </span>
      )}
      <span className="po-shadow" aria-hidden />
      <Sprite act={act} seated={seated} cup={act === 'idle' && activity === 'coffee'} />
      <span className="po-plate" aria-hidden>
        <span className={`po-pip st-${a.state}`} />
        <span className="po-plate-emoji">{a.avatar}</span>
        <span className="po-plate-name">{a.name}</span>
      </span>
    </button>
  );
}

/** a 10×16 pixel person; `seated` = seen from behind at the desk, lower */
function Sprite({ act, seated, cup }: { act: PixelAct; seated: boolean; cup: boolean }) {
  const R = (x: number, y: number, w: number, h: number, cls: string, key?: string) => <rect key={key ?? `${cls}${x}.${y}`} className={cls} x={x} y={y} width={w} height={h} />;
  const parts: ReactNode[] = [];
  if (seated) {
    const sleep = act !== 'typing';
    const hy = sleep ? 3 : 1; // the head drops onto the arms when asleep
    // back view: hair all round, shoulders, arms reaching for the keyboard
    parts.push(R(3, hy, 4, 1, 'hair', 'h0'), R(2, hy + 1, 6, 3, 'hair', 'h1'), R(3, hy + 4, 4, 1, 'skin', 'neck'));
    parts.push(R(2, 6, 6, 5, 'body', 'b'), R(2, 6, 6, 1, 'body-hi', 'bh'));
    parts.push(R(1, 7, 1, 3, 'arm al', 'al'), R(8, 7, 1, 3, 'arm ar', 'ar'));
    parts.push(R(3, 11, 4, 1, 'legs', 'lg'));
  } else {
    parts.push(R(3, 0, 4, 1, 'hair', 'h0'), R(2, 1, 6, 1, 'hair', 'h1'), R(2, 2, 6, 3, 'skin', 'face'), R(2, 2, 1, 2, 'hair', 'hs1'), R(7, 2, 1, 2, 'hair', 'hs2'));
    parts.push(R(3, 3, 1, 1, 'eye', 'e1'), R(6, 3, 1, 1, 'eye', 'e2'), R(4, 5, 2, 1, 'skin', 'neck'));
    parts.push(R(2, 6, 6, 5, 'body', 'b'), R(2, 6, 6, 1, 'body-hi', 'bh'));
    parts.push(R(1, 6, 1, 4, 'arm', 'al'), R(1, 10, 1, 1, 'skin', 'hl'));
    if (act === 'hand-up') {
      // the right arm up, the hand above the head
      parts.push(R(8, 1, 1, 5, 'arm', 'ar'), R(8, 0, 1, 1, 'skin', 'hr'));
    } else {
      parts.push(R(8, 6, 1, 4, 'arm', 'ar'), R(8, 10, 1, 1, 'skin', 'hr'));
      if (cup) parts.push(R(9, 9, 1, 2, 'cup', 'cup'));
    }
    parts.push(R(3, 11, 2, 4, 'legs', 'l1'), R(5, 11, 2, 4, 'legs', 'l2'), R(2, 15, 3, 1, 'shoe', 's1'), R(5, 15, 3, 1, 'shoe', 's2'));
  }
  return (
    <svg className={`po-sprite${seated ? ' seated' : ''}`} viewBox="0 0 10 16" shapeRendering="crispEdges" aria-hidden>
      {parts}
    </svg>
  );
}
