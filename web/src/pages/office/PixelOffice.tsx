// The Pixel office skin (docs/office.md § The view → Pixel office): the
// default `OFFICE_THEMES` entry. A top-down floor plan of the pure
// `OfficeLayout`: tiled rooms with desks, a coffee corner and a huddle table, a
// lobby with the door (you) and the channel's notice board, and pixel avatars
// acting out their role state. Hand-offs are dashed lines with an envelope
// flying along them.
//
// Ambient life: an idle avatar strolls, fetches coffee or chats with a
// neighbour, one step per AMBIENT_MS on the shared clock, and only while the
// app is not calm (`html[data-calm]`: unfocused, hidden, 60 s idle, reduced
// motion) — a calm page sees a still office and pays nothing. Every infinite
// animation here is stepped and listed in theme.css § Calm.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { officeWanderSpot, type OfficeViewAvatar, type OfficeViewEdge, type OfficeWanderActivity } from '@tm/shared';
import { onTick } from '../../clock.ts';
import type { OfficeSkinProps } from '../../officeThemes.ts';

const AMBIENT_MS = 8_000;
const U_MIN = 12;
const U_MAX = 34;

/** The ambient step: frozen while the page is calm (no re-render at all then). */
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

const v = (vars: Record<string, string | number>): CSSProperties => vars as CSSProperties;

export default function PixelOffice({ layout, mobile, selectedRoleId, highlight, onAvatar }: OfficeSkinProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const u = width > 0 ? Math.max(U_MIN, Math.min(U_MAX, Math.floor(width / layout.width))) : 20;
  const tick = useAmbientTick();
  const poseOf = new Map(layout.avatars.map((a) => [a.roleId, a.pose]));

  return (
    <div className={`po-wrap${mobile ? ' phone' : ''}`} ref={wrap}>
      <div
        className={`po-floor${highlight ? ' has-hl' : ''}`}
        style={v({ '--po-u': `${u}px`, width: u * layout.width, height: u * layout.height })}
        role="group"
        aria-label="Office floor"
      >
        {layout.rooms.map((room) => (
          <section key={room.id} className={`po-room po-room-${room.id}`} style={v({ '--x': room.rect.x, '--y': room.rect.y, '--w': room.rect.w, '--h': room.rect.h })} aria-label={room.label}>
            <div className="po-room-name">{room.label}</div>
          </section>
        ))}
        {layout.rooms.flatMap((room) => [
          ...room.desks.map((d) => (
            <div
              key={`desk-${d.roleId}`}
              className={`po-desk${poseOf.get(d.roleId) === 'working' ? ' lit' : ''}`}
              style={v({ '--x': d.rect.x, '--y': d.rect.y, '--w': d.rect.w, '--h': d.rect.h })}
              aria-hidden
            >
              <span className="po-monitor" />
            </div>
          )),
          <span key={`coffee-${room.id}`} className="po-prop po-coffee" style={v({ '--x': room.coffee.x, '--y': room.coffee.y })} aria-hidden>
            ☕
          </span>,
          <span key={`plant-${room.id}`} className="po-prop po-plant" style={v({ '--x': room.rect.x + room.rect.w - 1, '--y': room.rect.y + 1 })} aria-hidden>
            🪴
          </span>,
          room.table && <span key={`table-${room.id}`} className="po-table" style={v({ '--x': room.table.x, '--y': room.table.y })} aria-hidden />,
        ])}
        <div className="po-lobby" style={v({ '--x': layout.lobby.x, '--y': layout.lobby.y, '--w': layout.lobby.w, '--h': layout.lobby.h })} aria-hidden>
          <span className="po-lobby-name">Lobby</span>
        </div>
        <span className="po-prop po-door" style={v({ '--x': layout.door.x, '--y': layout.door.y })} title="You (the stakeholder)">
          🚪<span className="po-prop-label">You</span>
        </span>
        <span className="po-prop po-board" style={v({ '--x': layout.board.x, '--y': layout.board.y })} title="The channel">
          📌<span className="po-prop-label">Channel</span>
        </span>

        <svg className="po-edges" viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden>
          {layout.edges.map((e) => (
            <line
              key={e.id}
              className={`po-edge k-${e.kind}${e.tainted ? ' tainted' : ''}${highlight?.edgeId === e.id ? ' hl' : ''}`}
              x1={e.fromAt.x}
              y1={e.fromAt.y}
              x2={e.toAt.x}
              y2={e.toAt.y}
            />
          ))}
        </svg>
        {layout.edges
          .filter((e) => e.kind !== 'huddle')
          .map((e) => (
            <Envelope key={e.id} edge={e} lit={highlight?.edgeId === e.id} />
          ))}

        {layout.avatars.map((a) => {
          const spot = officeWanderSpot(a, layout, tick);
          return (
            <Avatar
              key={a.roleId}
              avatar={a}
              x={spot.at.x}
              y={spot.at.y}
              activity={spot.activity}
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

function Envelope({ edge, lit }: { edge: OfficeViewEdge; lit: boolean }) {
  const mx = (edge.fromAt.x + edge.toAt.x) / 2;
  const my = (edge.fromAt.y + edge.toAt.y) / 2;
  return (
    <span
      className={`po-envelope k-${edge.kind}${lit ? ' hl' : ''}`}
      style={v({ '--x1': edge.fromAt.x, '--y1': edge.fromAt.y, '--x2': edge.toAt.x, '--y2': edge.toAt.y, '--x': mx, '--y': my })}
      aria-hidden
    >
      ✉
    </span>
  );
}

const BUBBLE: Partial<Record<OfficeViewAvatar['pose'] | OfficeWanderActivity, string>> = {
  waiting: '!',
  dozing: 'z',
  huddling: '💬',
  chat: '💬',
};

function Avatar({
  avatar: a,
  x,
  y,
  activity,
  selected,
  lit,
  onClick,
}: {
  avatar: OfficeViewAvatar;
  x: number;
  y: number;
  activity: OfficeWanderActivity;
  selected: boolean;
  lit: boolean;
  onClick: () => void;
}) {
  const bubble = a.pose === 'blocked' ? (a.state === 'over-budget' ? '$' : '⏸') : a.pose === 'working' ? null : (BUBBLE[a.pose === 'idle' ? activity : a.pose] ?? null);
  return (
    <button
      type="button"
      className={`po-avatar pose-${a.pose} act-${activity}${selected ? ' selected' : ''}${lit ? ' hl' : ''}`}
      style={v({ '--x': x, '--y': y, '--c': `var(--tm-group-${a.colorSlot})` })}
      onClick={onClick}
      aria-label={`${a.name}, ${a.title} — ${a.state.replace(/-/g, ' ')}${a.detail ? `: ${a.detail}` : ''}`}
      aria-pressed={selected}
      title={`${a.name} — ${a.detail || a.state}`}
    >
      {a.pose === 'working' && (
        <span className="po-bubble po-typing" aria-hidden>
          <i />
          <i />
          <i />
        </span>
      )}
      {bubble && (
        <span className={`po-bubble b-${a.pose}`} aria-hidden>
          {bubble}
        </span>
      )}
      <span className="po-sprite" aria-hidden>
        <span className="po-head">{a.avatar}</span>
        <span className="po-body" />
      </span>
      <span className="po-name">{a.name}</span>
    </button>
  );
}
