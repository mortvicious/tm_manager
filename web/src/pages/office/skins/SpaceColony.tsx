// The Space colony skin (docs/office.md § Space colony): the engine's
// `OfficeLayout` drawn as a top-down colony map. Every department is a
// pressurised MODULE whose roof light shows its crew's most urgent state
// (`colonyModuleLight`), every desk a console with its role's lamp, the gaps
// are TUBES (`colonyTubes`) and the lobby is the docking hub with the airlock
// (you) and the comm mast (the channel). A hand-off is a colonist WALKING the
// tubes from the sender's module to the receiver's (`colonyRoute`), carrying a
// data crate. Roles act out their state through the same `officePixelAct` the
// Pixel office uses, in suits.
//
// Large offices: the map is culled to the viewport (`colonyCull`) — modules,
// colonists and walks outside the visible part of the page (plus a margin) are
// not rendered at all; the cheap tube network always is. The view is measured
// on scroll (any scroller, capture) and resize, one rAF later, and quantised
// to whole chunks so scrolling does not re-render on every pixel.
//
// Motion: ambient life steps every AMBIENT_MS on the shared clock only while
// the app is not calm; every infinite animation is stepped and listed in
// theme.css § Calm; prefers-reduced-motion turns them and the walk transition
// off, and a walker then stands halfway along its route.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import {
  colonyCull,
  colonyHatch,
  colonyLampOf,
  colonyModuleLight,
  colonyRoute,
  colonyRouteLength,
  colonyTubes,
  officeHash,
  officePixelAct,
  officeSkipReason,
  officeWanderSpot,
  type ColonyLight,
  type OfficeLayout,
  type OfficePixelAct as Act,
  type OfficeViewAvatar,
  type OfficeViewEdge,
  type OfficeViewPoint,
  type OfficeViewRect,
  type OfficeViewRoom,
  type OfficeWanderActivity,
} from '@tm/shared';
import { onTick } from '../../../clock.ts';
import type { OfficeSkinProps } from '../../../officeThemes.ts';

const AMBIENT_MS = 8_000;
const FALLBACK_WIDTH = 720;
/** the culling view is rounded out to chunks of this many tiles */
const CULL_CHUNK = 6;

const v = (vars: Record<string, string | number>): CSSProperties => vars as CSSProperties;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function useAmbientTick(): number {
  const [tick, setTick] = useState(() => Math.floor(Date.now() / AMBIENT_MS));
  useEffect(
    () =>
      onTick(AMBIENT_MS, () => {
        if (document.documentElement.hasAttribute('data-calm')) return;
        setTick(Math.floor(Date.now() / AMBIENT_MS));
      }),
    [],
  );
  return tick;
}

/** The part of the map on screen, in tiles, rounded out to CULL_CHUNK; null until measured. */
function useVisibleTiles(wrap: RefObject<HTMLDivElement | null>, map: RefObject<HTMLDivElement | null>, t: number): OfficeViewRect | null {
  const [view, setView] = useState<OfficeViewRect | null>(null);
  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const w = wrap.current;
      const m = map.current;
      if (!w || !m || t <= 0) return;
      const mr = m.getBoundingClientRect();
      const wr = w.getBoundingClientRect();
      const left = Math.max(wr.left, 0);
      const top = Math.max(wr.top, 0);
      const right = Math.min(wr.right, window.innerWidth);
      const bottom = Math.min(wr.bottom, window.innerHeight);
      const x0 = Math.floor((left - mr.left) / t / CULL_CHUNK) * CULL_CHUNK;
      const y0 = Math.floor((top - mr.top) / t / CULL_CHUNK) * CULL_CHUNK;
      const x1 = Math.ceil((right - mr.left) / t / CULL_CHUNK) * CULL_CHUNK;
      const y1 = Math.ceil((bottom - mr.top) / t / CULL_CHUNK) * CULL_CHUNK;
      // off screen altogether: an empty view (nothing but the tubes)
      const next = { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
      setView((cur) => (cur && cur.x === next.x && cur.y === next.y && cur.w === next.w && cur.h === next.h ? cur : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    const ro = new ResizeObserver(schedule);
    if (wrap.current) ro.observe(wrap.current);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      ro.disconnect();
    };
  }, [wrap, map, t]);
  return view;
}

export default function SpaceColony({ layout, mobile, selectedRoleId, highlight, onAvatar }: OfficeSkinProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const map = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // one tile in px: fit the width, within 12..(phone 24, desktop 26); below 12 the map scrolls sideways
  const t = Math.max(12, Math.min(mobile ? 24 : 26, Math.floor((width || FALLBACK_WIDTH) / layout.width)));
  const W = layout.width * t;
  const H = layout.height * t;
  const tick = useAmbientTick();
  const [walk, setWalk] = useState(false);
  useLayoutEffect(() => {
    setWalk(false);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setWalk(true)));
    return () => cancelAnimationFrame(id);
  }, [t]);

  // a guarded role sleeps in its stasis pod: out of ambient life before the spots are read
  const scene = useMemo<Pick<OfficeLayout, 'rooms' | 'avatars'>>(
    () => ({ rooms: layout.rooms, avatars: layout.avatars.map((a) => (a.wanders && a.state === 'guarded' ? { ...a, wanders: false } : a)) }),
    [layout],
  );
  const spots = useMemo(() => new Map(scene.avatars.map((a) => [a.roleId, officeWanderSpot(a, scene, tick)])), [scene, tick]);
  const spotAt = useMemo(() => new Map([...spots].map(([id, s]) => [id, s.at])), [spots]);
  const routes = useMemo(() => new Map(layout.edges.map((e) => [e.id, colonyRoute(e, layout, spotAt)])), [layout, spotAt]);
  const tubes = useMemo(() => colonyTubes(layout), [layout]);
  const view = useVisibleTiles(wrap, map, t);
  const shown = useMemo(() => colonyCull(layout, view, routes, spotAt), [layout, view, routes, spotAt]);
  const colorOf = useMemo(() => new Map(layout.avatars.map((a) => [a.roleId, a.colorSlot])), [layout]);

  return (
    <div className={`sc-wrap${mobile ? ' phone' : ''}`} ref={wrap}>
      <div
        ref={map}
        className={`sc-map${highlight ? ' has-hl' : ''}${walk ? ' walk' : ''}`}
        style={v({ '--sc-t': `${t}px`, '--sc-px': `${Math.max(2, Math.round((t * 1.7) / 14))}px`, width: W, height: H })}
        role="group"
        aria-label="Colony map"
      >
        <svg className="sc-svg" width={W} height={H} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden>
          <Tubes tubes={tubes} />
          {layout.rooms.filter((r) => shown.rooms.has(r.id)).map((room) => (
            <Module key={room.id} room={room} layout={layout} />
          ))}
          {shown.hub && <Hub layout={layout} />}
          <g className="sc-links">
            {layout.edges
              .filter((e) => shown.edges.has(e.id))
              .map((e) => (
                <polyline
                  key={e.id}
                  points={(routes.get(e.id) ?? []).map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')}
                  className={`sc-trail k-${e.kind}${e.tainted ? ' tainted' : ''}${highlight?.edgeId === e.id ? ' hl' : ''}`}
                />
              ))}
          </g>
        </svg>

        {layout.edges
          .filter((e) => e.kind !== 'huddle' && shown.edges.has(e.id))
          .map((e) => (
            <Walker key={e.id} edge={e} route={routes.get(e.id) ?? []} t={t} colorSlot={'role' in e.from ? colorOf.get(e.from.role) : undefined} lit={highlight?.edgeId === e.id} />
          ))}

        {layout.avatars
          .filter((a) => shown.avatars.has(a.roleId))
          .map((a) => {
            const spot = spots.get(a.roleId)!;
            return (
              <Colonist
                key={a.roleId}
                avatar={a}
                act={officePixelAct(a)}
                activity={spot.activity}
                at={spot.at}
                t={t}
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

// ---- the map --------------------------------------------------------------------

function Tubes({ tubes }: { tubes: ReturnType<typeof colonyTubes> }) {
  return (
    <g className="sc-tubes">
      {tubes.rows.map((r) => (
        <line key={`r${r.y}`} x1={r.x0} y1={r.y} x2={r.x1} y2={r.y} />
      ))}
      {tubes.trunks.map((k) => (
        <line key={`k${k.x}`} x1={k.x} y1={k.y0} x2={k.x} y2={k.y1} />
      ))}
      {tubes.hatches.map((h) => (
        <line key={`h${h.roomId}`} x1={h.x} y1={h.y0} x2={h.x} y2={h.y1} />
      ))}
    </g>
  );
}

const DEPT_SLOT: Record<OfficeViewRoom['id'], number> = { leadership: 1, engineering: 2, operations: 6, growth: 5, commons: 3 };

function Module({ room, layout }: { room: OfficeViewRoom; layout: OfficeLayout }) {
  const r = room.rect;
  const light: ColonyLight = colonyModuleLight(room, layout.avatars);
  const hatch = colonyHatch(room);
  const nodes: ReactNode[] = [];
  for (const d of room.desks) {
    const a = layout.avatars.find((x) => x.roleId === d.roleId);
    const lamp: ColonyLight = a ? colonyLampOf(a) : 'dark';
    const k = d.rect;
    nodes.push(
      <g key={d.roleId} className={`sc-console lamp-${lamp}`}>
        <rect className="sc-console-body" x={k.x} y={k.y} width={k.w} height={k.h} rx={0.3} />
        <rect className="sc-console-screen" x={k.x + 0.35} y={k.y + 0.25} width={k.w - 0.7} height={0.6} rx={0.1} />
        <circle className="sc-lamp" cx={k.x + k.w - 0.35} cy={k.y + k.h - 0.3} r={0.18} />
        <circle className="sc-seat" cx={d.seat.x} cy={d.seat.y} r={0.55} />
      </g>,
    );
  }
  // the galley (the engine's coffee corner) and a hydroponics bed in the far corner of the strip
  const g = room.coffee;
  const f = room.floor;
  return (
    <g className={`sc-module light-${light}`} style={v({ '--dept': `var(--tm-group-${DEPT_SLOT[room.id]})` })}>
      <rect className="sc-hull" x={r.x} y={r.y} width={r.w} height={r.h} rx={1.2} />
      <rect className="sc-deck" x={r.x + 0.35} y={r.y + 0.35} width={r.w - 0.7} height={r.h - 0.7} rx={0.9} />
      <rect className="sc-light" x={r.x + 1.2} y={r.y + 0.12} width={r.w - 2.4} height={0.26} rx={0.13} />
      <text className="sc-module-label" x={r.x + 1} y={r.y + 1.45}>
        {room.label}
      </text>
      <rect className="sc-hatch" x={hatch.x - 0.8} y={hatch.y - 0.35} width={1.6} height={0.7} rx={0.2} />
      {nodes}
      <g className="sc-galley">
        <rect x={g.x - 0.6} y={g.y - 0.5} width={1.1} height={0.9} rx={0.2} />
        <circle cx={g.x - 0.05} cy={g.y - 0.05} r={0.18} />
      </g>
      <g className="sc-hydro">
        <rect x={f.x + 0.2} y={f.y + f.h - 1.1} width={1.6} height={0.8} rx={0.2} />
        {[0.5, 1, 1.5].map((dx) => (
          <circle key={dx} cx={f.x + 0.2 + dx - 0.05} cy={f.y + f.h - 0.7} r={0.22} />
        ))}
      </g>
      {huddleTables(room).map((h) => (
        <g key={h.id} className="sc-holo">
          <circle className="sc-holo-ring" cx={h.at.x} cy={h.at.y} r={2.4} />
          <circle className="sc-holo-table" cx={h.at.x} cy={h.at.y} r={0.9} />
        </g>
      ))}
    </g>
  );
}

/** the layout's own huddle table rule (`room.table`, a second one at the far end) */
function huddleTables(room: OfficeViewRoom): { id: string; at: OfficeViewPoint }[] {
  if (!room.table) return [];
  const table = room.table;
  return room.huddleIds.map((id, k) => ({ id, at: k === 0 ? table : { x: room.floor.x + room.floor.w / 2 + 0.5, y: table.y } }));
}

function Hub({ layout }: { layout: OfficeLayout }) {
  const r = layout.lobby;
  const door = layout.door;
  const board = layout.board;
  return (
    <g className="sc-hub">
      <rect className="sc-hull" x={r.x} y={r.y} width={r.w} height={r.h} rx={1.2} />
      <rect className="sc-deck" x={r.x + 0.35} y={r.y + 0.35} width={r.w - 0.7} height={r.h - 0.7} rx={0.9} />
      <text className="sc-module-label" x={r.x + r.w / 2} y={r.y + 1.05} textAnchor="middle">
        Docking hub
      </text>
      {/* the airlock: the human comes and goes here */}
      <g className="sc-airlock">
        <circle cx={door.x} cy={door.y} r={0.95} />
        <line x1={door.x - 0.95} y1={door.y} x2={door.x + 0.95} y2={door.y} />
      </g>
      <text className="sc-place-label" x={door.x + 1.2} y={r.y + r.h - 0.55}>
        You
      </text>
      {/* the comm mast: the channel */}
      <g className="sc-mast">
        <line x1={board.x} y1={board.y + 0.8} x2={board.x} y2={board.y - 0.7} />
        <path d={`M ${board.x - 0.7} ${board.y - 0.9} Q ${board.x} ${board.y - 0.2} ${board.x + 0.7} ${board.y - 0.9}`} />
        <circle className="sc-beacon" cx={board.x} cy={board.y - 0.75} r={0.16} />
      </g>
      <text className="sc-place-label" x={board.x - 1} y={r.y + r.h - 0.55} textAnchor="end">
        Channel
      </text>
    </g>
  );
}

// ---- hand-offs: a colonist walking the tubes ------------------------------------------

function Walker({ edge, route, t, colorSlot, lit }: { edge: OfficeViewEdge; route: readonly OfficeViewPoint[]; t: number; colorSlot: number | undefined; lit: boolean }) {
  if (route.length < 2) return null;
  const d = `M ${route.map((p) => `${(p.x * t).toFixed(1)} ${(p.y * t).toFixed(1)}`).join(' L ')}`;
  const len = colonyRouteLength(route);
  const secs = Math.max(3, Math.min(14, len * 0.35));
  const steps = Math.max(8, Math.round(len * 2));
  return (
    <span
      className={`sc-walker k-${edge.kind}${edge.tainted ? ' tainted' : ''}${lit ? ' hl' : ''}`}
      style={v({
        offsetPath: `path('${d}')`,
        animationDuration: `${secs.toFixed(1)}s`,
        animationTimingFunction: `steps(${steps}, jump-none)`,
        animationDelay: `-${(officeHash(edge.id) % Math.round(secs * 1000))}ms`,
        '--c': colorSlot ? `var(--tm-group-${colorSlot})` : 'var(--tm-accent)',
      })}
      title={edge.label}
      aria-hidden
    >
      <span className="sc-walker-body" />
      <span className="sc-crate" />
    </span>
  );
}

// ---- colonists ------------------------------------------------------------------------

const STATE_LABEL: Record<OfficeViewAvatar['state'], string> = {
  'off-duty': 'off duty',
  scheduled: 'scheduled',
  guarded: 'guarded',
  'on-shift': 'on shift',
  'in-huddle': 'in a huddle',
  'waiting-for-you': 'waiting for you',
  'over-budget': 'over budget',
  paused: 'paused',
};

function bubbleFor(a: OfficeViewAvatar, act: Act, activity: OfficeWanderActivity): { cls: string; text: ReactNode } | null {
  switch (act) {
    case 'typing':
      return { cls: 'b-typing', text: <><i /><i /><i /></> };
    case 'hand-up':
      return { cls: 'b-waiting', text: '!' };
    case 'asleep': {
      const why = officeSkipReason(a.detail);
      return { cls: 'b-guarded', text: <>z<span className="sc-bubble-why">{why ? clip(why, 34) : 'skipped'}</span></> };
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

function Colonist({
  avatar: a,
  act,
  activity,
  at,
  t,
  selected,
  lit,
  onClick,
}: {
  avatar: OfficeViewAvatar;
  act: Act;
  activity: OfficeWanderActivity;
  at: OfficeViewPoint;
  t: number;
  selected: boolean;
  lit: boolean;
  onClick: () => void;
}) {
  const bubble = bubbleFor(a, act, activity);
  return (
    <button
      type="button"
      className={`sc-colonist act-${act} st-${a.state} wander-${activity}${selected ? ' selected' : ''}${lit ? ' hl' : ''}`}
      style={v({ '--x': `${(at.x * t).toFixed(1)}px`, '--y': `${(at.y * t).toFixed(1)}px`, '--c': `var(--tm-group-${a.colorSlot})`, zIndex: 10 + Math.round(at.y * 4) })}
      onClick={onClick}
      aria-label={`${a.name}, ${a.title} — ${STATE_LABEL[a.state]}${a.detail ? `: ${a.detail}` : ''}`}
      aria-pressed={selected}
      title={`${a.name} — ${a.detail || STATE_LABEL[a.state]}`}
    >
      {bubble && (
        <span className={`sc-bubble ${bubble.cls}`} aria-hidden>
          {bubble.text}
        </span>
      )}
      {act === 'asleep' && <span className="sc-pod" aria-hidden />}
      <span className="sc-shadow" aria-hidden />
      <Suit act={act} ration={act === 'idle' && activity === 'coffee'} />
      <span className="sc-plate" aria-hidden>
        <span className={`sc-pip st-${a.state}`} />
        <span className="sc-plate-emoji">{a.avatar}</span>
        <span className="sc-plate-name">{a.name}</span>
      </span>
    </button>
  );
}

/** a 10×14 pixel colonist in a suit: helmet with visor, backpack, the role's colour */
function Suit({ act, ration }: { act: Act; ration: boolean }) {
  const R = (x: number, y: number, w: number, h: number, cls: string, key: string) => <rect key={key} className={cls} x={x} y={y} width={w} height={h} />;
  const seated = act === 'typing' || act === 'asleep' || act === 'dozing';
  const parts: ReactNode[] = [
    R(3, 0, 4, 1, 'helmet', 'h0'),
    R(2, 1, 6, 4, 'helmet', 'h1'),
    // seated at the console = seen from behind: no visor
    ...(seated ? [] : [R(3, 2, 4, 2, 'visor', 'vs'), R(3, 2, 1, 1, 'visor-hi', 'vh')]),
    R(2, 5, 6, 5, 'suit', 'b'),
    R(2, 5, 6, 1, 'suit-hi', 'bh'),
    R(4, 6, 2, 2, 'panel', 'pn'),
    R(1, 5, 1, 4, 'arm al', 'al'),
  ];
  if (act === 'hand-up') parts.push(R(8, 0, 1, 5, 'arm ar', 'ar'), R(8, 0, 1, 1, 'glove', 'gr'));
  else parts.push(R(8, 5, 1, 4, 'arm ar', 'ar'), R(8, 9, 1, 1, 'glove', 'gr'));
  parts.push(R(1, 9, 1, 1, 'glove', 'gl'));
  if (ration && act !== 'hand-up') parts.push(R(9, 8, 1, 2, 'ration', 'ra'));
  if (seated) parts.push(R(3, 10, 4, 1, 'boot', 'bt'));
  else parts.push(R(3, 10, 2, 3, 'suit', 'l1'), R(5, 10, 2, 3, 'suit', 'l2'), R(2, 13, 3, 1, 'boot', 'b1'), R(5, 13, 3, 1, 'boot', 'b2'));
  return (
    <svg className={`sc-suit${seated ? ' seated' : ''}`} viewBox="0 0 10 14" shapeRendering="crispEdges" aria-hidden>
      {parts}
    </svg>
  );
}
