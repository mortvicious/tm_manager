// What every office skin shares (docs/office.md § Skins): the ambient clock,
// the frame's width, the ambient scene (where each avatar is now and what it
// acts out), the state words for aria labels, and — for the two top-down
// skins (Starship bridge, Fantasy guild hall) — the avatar button and the hand-off
// arc over the flat projection. Nothing here fetches or decides: a skin draws.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import {
  officeEdgeEnds,
  officePlateName,
  officePixelAct,
  officeSkipReason,
  officeWanderSpot,
  type OfficeFlatProjection,
  type OfficeLayout,
  type OfficePixelAct,
  type OfficeViewAvatar,
  type OfficeViewEdge,
  type OfficeViewPoint,
  type OfficeWanderActivity,
} from '@tm/shared';
import { onTick } from '../../../clock.ts';

export const AMBIENT_MS = 8_000;
export const FALLBACK_WIDTH = 720;

/** The ambient step: frozen while the page is calm (no re-render at all then). */
export function useAmbientTick(): number {
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

/** The width of the element behind `ref`, kept current (0 before the first measure). */
export function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/**
 * Avatars WALK only between ambient spots: a new scale (the first measure, a
 * resize) re-places them at once — the class is dropped for two frames — then
 * walking resumes.
 */
export function useWalk(...scale: unknown[]): boolean {
  const [walk, setWalk] = useState(false);
  useLayoutEffect(() => {
    setWalk(false);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setWalk(true)));
    return () => cancelAnimationFrame(id);
  }, scale);
  return walk;
}

export interface AmbientScene {
  spots: ReadonlyMap<string, { at: OfficeViewPoint; activity: OfficeWanderActivity }>;
  /** role → where it stands now (what a hand-off end follows) */
  spotAt: ReadonlyMap<string, OfficeViewPoint>;
  actOf: ReadonlyMap<string, OfficePixelAct>;
}

/**
 * Where everyone is at this ambient tick. A guarded role sleeps at its desk: it
 * is taken out of ambient life (and out of its neighbours' chat partners)
 * before the wander spots are read.
 */
export function useAmbientScene(layout: OfficeLayout, tick: number): AmbientScene {
  const scene = useMemo<Pick<OfficeLayout, 'rooms' | 'avatars'>>(
    () => ({ rooms: layout.rooms, avatars: layout.avatars.map((a) => (a.wanders && a.state === 'guarded' ? { ...a, wanders: false } : a)) }),
    [layout],
  );
  const spots = useMemo(() => new Map(scene.avatars.map((a) => [a.roleId, officeWanderSpot(a, scene, tick)])), [scene, tick]);
  const spotAt = useMemo(() => new Map([...spots].map(([id, s]) => [id, s.at])), [spots]);
  const actOf = useMemo(() => new Map(layout.avatars.map((a) => [a.roleId, officePixelAct(a)])), [layout]);
  return { spots, spotAt, actOf };
}

export const cssVars = (vars: Record<string, string | number>): CSSProperties => vars as CSSProperties;

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const STATE_LABEL: Record<OfficeViewAvatar['state'], string> = {
  'off-duty': 'off duty',
  scheduled: 'scheduled',
  guarded: 'guarded',
  'on-shift': 'on shift',
  'in-huddle': 'in a huddle',
  'waiting-for-you': 'waiting for you',
  'over-budget': 'over budget',
  paused: 'paused',
};

// ---- the top-down skins -------------------------------------------------------

/** A skin's words for the bubbles (the typing dots are the same everywhere). */
export interface BubbleGlyphs {
  waiting: string;
  /** guarded: the word before the skip reason */
  guarded: string;
  dozing: string;
  paused: string;
  overBudget: string;
  huddle: string;
  chat: string;
}

/** The bubble an avatar wears for its act (and, when idle, its ambient activity). */
export function bubbleFor(
  a: OfficeViewAvatar,
  act: OfficePixelAct,
  activity: OfficeWanderActivity,
  g: BubbleGlyphs,
  prefix: string,
): { cls: string; text: ReactNode } | null {
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
      return { cls: 'b-waiting', text: g.waiting };
    case 'asleep': {
      const why = officeSkipReason(a.detail);
      return {
        cls: 'b-guarded',
        text: (
          <>
            {g.guarded}
            <span className={`${prefix}-bubble-why`}>{why ? clip(why, 34) : 'skipped'}</span>
          </>
        ),
      };
    }
    case 'dozing':
      return { cls: 'b-dozing', text: g.dozing };
    case 'greyed':
      return { cls: 'b-blocked', text: a.state === 'over-budget' ? g.overBudget : g.paused };
    case 'huddle':
      return { cls: 'b-huddle', text: g.huddle };
    default:
      return activity === 'chat' ? { cls: 'b-chat', text: g.chat } : null;
  }
}

/**
 * One role on a top-down floor: a button anchored at the point it stands on,
 * its figure (the skin's `children`), a bubble above, a name plate below with
 * the state pip. Classes are `<prefix>-avatar act-<act> st-<state> wander-<activity>`.
 */
export function FlatAvatar({
  prefix,
  avatar: a,
  act,
  activity,
  at,
  tile,
  glyphs,
  selected,
  lit,
  onClick,
  children,
}: {
  prefix: string;
  avatar: OfficeViewAvatar;
  act: OfficePixelAct;
  activity: OfficeWanderActivity;
  /** px on the floor */
  at: OfficeViewPoint;
  tile: number;
  glyphs: BubbleGlyphs;
  selected: boolean;
  lit: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const bubble = bubbleFor(a, act, activity, glyphs, prefix);
  return (
    <button
      type="button"
      className={`${prefix}-avatar act-${act} st-${a.state} wander-${activity}${selected ? ' selected' : ''}${lit ? ' hl' : ''}`}
      style={cssVars({
        '--x': `${at.x.toFixed(1)}px`,
        '--y': `${at.y.toFixed(1)}px`,
        '--c': `var(--tm-group-${a.colorSlot})`,
        '--plate': `${Math.round(tile * 3.9)}px`,
        zIndex: 10 + Math.round(at.y / 4),
      })}
      onClick={onClick}
      aria-label={`${a.name}, ${a.title} — ${STATE_LABEL[a.state]}${a.detail ? `: ${a.detail}` : ''}`}
      aria-pressed={selected}
      title={`${a.name} — ${a.detail || STATE_LABEL[a.state]}`}
    >
      {bubble && (
        <span className={`${prefix}-bubble ${bubble.cls}`} aria-hidden>
          {bubble.text}
        </span>
      )}
      <span className={`${prefix}-ring`} aria-hidden />
      {children}
      <span className={`${prefix}-plate`} aria-hidden>
        <span className={`${prefix}-pip st-${a.state}`} />
        <span className={`${prefix}-plate-emoji`}>{a.avatar}</span>
        <span className={`${prefix}-plate-name`}>{officePlateName(a.name)}</span>
      </span>
    </button>
  );
}

/**
 * A hand-off's path on a flat floor, px: from one end to the other, bowed to
 * the side by `bow` (0 = straight). A role end follows that avatar's current
 * ambient spot (`officeEdgeEnds`), so the beam / scroll always joins the
 * right two avatars.
 */
export function flatEdgePath(proj: OfficeFlatProjection, e: OfficeViewEdge, spots: ReadonlyMap<string, OfficeViewPoint>, bow: number): string {
  const ends = officeEdgeEnds(e, spots);
  // an avatar's end is at its chest (a little above where it stands)
  const lift = (end: OfficeViewEdge['from']) => ('role' in end ? 0.7 : 0);
  const p = proj.project({ x: ends.from.x, y: ends.from.y - lift(e.from) });
  const q = proj.project({ x: ends.to.x, y: ends.to.y - lift(e.to) });
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const dist = Math.hypot(dx, dy) || 1;
  const off = Math.min(dist * bow, proj.tile * 4);
  // the normal that points up the screen, so arcs bow the same way for every pair
  let nx = -dy / dist;
  let ny = dx / dist;
  if (ny > 0) (nx = -nx), (ny = -ny);
  const mx = (p.x + q.x) / 2 + nx * off;
  const my = (p.y + q.y) / 2 + ny * off;
  return `M ${p.x.toFixed(1)} ${p.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
}
