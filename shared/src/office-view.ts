// The office view (docs/office.md § The view): ONE pure layout of a Virtual
// Office as a place — rooms (one per department), desks, avatars acting out
// their role state, the hand-offs live between them, and a history feed — that
// every skin (`web/src/officeThemes.ts`) draws. No I/O, no clock: `now` is an
// option, so the SPA re-lays it on a tick and the tests pin it.
//
// Coordinates are floor TILES (a skin picks the pixel size of one): x grows
// right, y grows down, a point is a tile centre-ish, a rect is its top-left
// plus size. The geometry is the same for every skin; a skin only dresses it.

import type { AuditEvent, AuditKind } from './types.ts';
import type {
  Office,
  OfficeBrief,
  OfficeHuddle,
  OfficeMessage,
  OfficeMessageRoute,
  OfficeRole,
  OfficeRoleState,
  OfficeShift,
  OfficeStates,
} from './office.ts';
import type { HistoryStep, HistoryStepKind, HistoryTone } from './task-history.ts';

// ---- themes ----------------------------------------------------------------

/** Every theme id the office knows (`Office.theme`); the SPA lists only the skins it has implemented. */
export type OfficeThemeId = 'pixel-office' | 'starship-bridge' | 'fantasy-guild' | 'space-colony';
export const OFFICE_THEME_IDS: readonly OfficeThemeId[] = ['pixel-office', 'starship-bridge', 'fantasy-guild', 'space-colony'];
export const DEFAULT_OFFICE_THEME_ID: OfficeThemeId = 'pixel-office';
export const OFFICE_THEME_LABELS: Readonly<Record<OfficeThemeId, string>> = {
  'pixel-office': 'Pixel office',
  'starship-bridge': 'Starship bridge',
  'fantasy-guild': 'Fantasy guild hall',
  'space-colony': 'Space colony',
};

/** `Office.theme` is a free id: anything unknown reads as the default theme. */
export function officeThemeId(theme: string | null | undefined): OfficeThemeId {
  return OFFICE_THEME_IDS.includes(theme as OfficeThemeId) ? (theme as OfficeThemeId) : DEFAULT_OFFICE_THEME_ID;
}

// ---- departments -----------------------------------------------------------

export type OfficeDepartment = 'leadership' | 'engineering' | 'operations' | 'growth' | 'commons';

/** Room order on the floor; a room with no role is left out. */
export const OFFICE_DEPARTMENTS: readonly { id: OfficeDepartment; label: string }[] = [
  { id: 'leadership', label: "Director's office" },
  { id: 'engineering', label: 'Engineering' },
  { id: 'operations', label: 'Operations' },
  { id: 'growth', label: 'Growth' },
  { id: 'commons', label: 'Commons' },
];

/** A role's department: by preset; a custom role (no preset) works in the commons. */
export function officeDepartment(role: Pick<OfficeRole, 'preset'>): OfficeDepartment {
  switch (role.preset) {
    case 'director':
      return 'leadership';
    case 'developer':
    case 'qa':
      return 'engineering';
    case 'devops':
      return 'operations';
    case 'seo':
      return 'growth';
    default:
      return 'commons';
  }
}

// ---- geometry --------------------------------------------------------------

export interface OfficeViewPoint {
  x: number;
  y: number;
}
export interface OfficeViewRect extends OfficeViewPoint {
  w: number;
  h: number;
}

/** desks per row inside a room */
export const OFFICE_DESKS_PER_ROW = 3;
const DESK_W = 4; // one desk cell, tiles
const DESK_H = 4;
const ROOM_PAD = 1;
const ROOM_HEAD = 2; // the room's name plate
const ROOM_FOOT = 4; // the open strip: coffee, huddle table, strolling room
const ROOM_W = ROOM_PAD * 2 + OFFICE_DESKS_PER_ROW * DESK_W; // 14
const WALL = 1; // gap between rooms and around the floor
const LOBBY_H = 3;

export interface OfficeViewDesk {
  roleId: string;
  /** the desk itself */
  rect: OfficeViewRect;
  /** where the role sits at it */
  seat: OfficeViewPoint;
}

export interface OfficeViewRoom {
  id: OfficeDepartment;
  label: string;
  rect: OfficeViewRect;
  /** in seat order (the role list's order within the department) */
  desks: OfficeViewDesk[];
  /** the coffee corner (ambient life) */
  coffee: OfficeViewPoint;
  /** the open strip below the desks where idle roles stroll */
  floor: OfficeViewRect;
  /** the huddle table, when an open huddle meets in this room */
  table: OfficeViewPoint | null;
  /** huddle ids meeting here (newest first) */
  huddleIds: string[];
}

// ---- avatars ---------------------------------------------------------------

/**
 * What the avatar acts out, from its `OfficeRoleState`:
 * working (on shift, typing) · huddling (at the table) · waiting (hand up, a
 * question/approval for the human) · idle (between shifts — ambient life) ·
 * dozing (off: role or office disabled) · blocked (paused / over budget).
 */
export type OfficeAvatarPose = 'working' | 'huddling' | 'waiting' | 'idle' | 'dozing' | 'blocked';

export interface OfficeViewShiftRef {
  id: string;
  runId: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface OfficeViewAvatar {
  roleId: string;
  key: string;
  name: string;
  title: string;
  /** the role's emoji */
  avatar: string;
  room: OfficeDepartment;
  /** its desk seat */
  seat: OfficeViewPoint;
  /** where it is now: the seat, or a place at its huddle's table */
  at: OfficeViewPoint;
  state: OfficeRoleState;
  detail: string;
  pose: OfficeAvatarPose;
  /** ambient life may move it (`officeWanderSpot`) — only an idle avatar */
  wanders: boolean;
  /** 1..7, the `--tm-group-<n>` token its body wears; stable per role */
  colorSlot: number;
  enabled: boolean;
  /** the open huddle it sits in (newest) */
  huddleId: string | null;
  /** the shift running now (verdict ran, not ended) */
  liveShift: OfficeViewShiftRef | null;
  /** the newest shift that ran (live or ended) — the card's terminal link */
  lastShift: OfficeViewShiftRef | null;
  lastBrief: { id: string; summary: string; createdAt: string; tainted: boolean } | null;
  spentTodayUsd: number;
  nextSlotAt: string | null;
  /** the role's notes were written by a tainted shift and not yet reviewed */
  notesTainted: boolean;
}

// ---- hand-offs -------------------------------------------------------------

/** An edge end: a role id, the stakeholder (the human, at the door) or the channel (the notice board). */
export type OfficeViewEnd = { role: string } | { place: 'door' | 'board' };

export interface OfficeViewEdge {
  id: string;
  kind: 'message' | 'route' | 'huddle';
  from: OfficeViewEnd;
  to: OfficeViewEnd;
  fromAt: OfficeViewPoint;
  toAt: OfficeViewPoint;
  /** when it happened (message / route time; a huddle's last turn) */
  at: string;
  /** a short server-made label (never agent text) */
  label: string;
  /** the row behind it: message id, routed message id, huddle id */
  refId: string;
  tainted: boolean;
}

// ---- feed --------------------------------------------------------------------

export type OfficeFeedKind =
  | 'shift-start'
  | 'shift-end'
  | 'shift-skipped'
  | 'brief'
  | 'message'
  | 'route'
  | 'huddle-open'
  | 'huddle-closed'
  | 'task-step'
  | 'event';

export interface OfficeFeedRef {
  kind: 'shift' | 'brief' | 'task' | 'huddle' | 'message';
  id: string;
  /** an aux/worker run to open as a terminal */
  runId?: string | null;
}

export interface OfficeFeedItem {
  /** unique within a feed, stable across re-lays */
  id: string;
  at: string;
  kind: OfficeFeedKind;
  /** roles involved — what a selected item highlights */
  roleIds: string[];
  text: string;
  tone: HistoryTone;
  /** the edge this item drew, when it is still on the floor */
  edgeId?: string;
  ref?: OfficeFeedRef;
  /** the text includes words a tainted shift / external source wrote */
  tainted?: boolean;
}

/**
 * Audit kinds the feed reads from tm_events. Shifts, briefs, messages, routes and
 * huddles come from their own rows (so `office.shift`, `office.brief`,
 * `office.message`, `office.message-routed` and `office.huddle` would be
 * duplicates); bookkeeping kinds (`office.changed`, `office.channel-presented`,
 * `office.signals`, `office.shift-deferred`) are not news.
 */
export const OFFICE_FEED_EVENT_KINDS: readonly AuditKind[] = [
  'office.paused',
  'office.resumed',
  'office.wake',
  'office.taint-cleared',
  'office.proposals',
  'office.proposal-decided',
  'office.feature',
  'office.wish',
  'office.vision-changed',
  'office.filing',
  'office.command',
  'office.chat-to-channel',
];

/** The task step kinds the feed shows (the rest is task-panel detail). */
export const OFFICE_FEED_STEP_KINDS: ReadonlySet<HistoryStepKind> = new Set<HistoryStepKind>([
  'claimed',
  'run',
  'review',
  'checks',
  'question',
  'publish',
  'shipped',
  'landed',
  'failed',
  'cancelled',
]);

/** One office task's history steps (`buildTaskHistory`), for the feed. */
export interface OfficeTaskSteps {
  taskId: string;
  title: string;
  roleId: string | null;
  steps: readonly HistoryStep[];
}

// ---- the layout --------------------------------------------------------------

export interface OfficeLayoutOptions {
  /** ISO or epoch ms; decides which hand-offs are still live */
  now: string | number;
  /** rooms per floor row (desktop ≈ 3, phone 1 = the vertical stack); default 3 */
  columns?: number;
  /** `OfficeChannelResponse.routes` */
  routes?: Readonly<Record<string, OfficeMessageRoute>>;
  briefs?: readonly OfficeBrief[];
  /** `office.*` audit rows (any order; other offices' are dropped) */
  events?: readonly AuditEvent[];
  taskSteps?: readonly OfficeTaskSteps[];
  /** how long a message / route stays on the floor as an edge; default 30 min */
  edgeWindowMs?: number;
  /** feed length; default 120 */
  feedLimit?: number;
}

export interface OfficeLayout {
  /** floor size, tiles */
  width: number;
  height: number;
  rooms: OfficeViewRoom[];
  avatars: OfficeViewAvatar[];
  edges: OfficeViewEdge[];
  /** newest first */
  feed: OfficeFeedItem[];
  /** the lobby: the door (the stakeholder) and the channel's notice board */
  lobby: OfficeViewRect;
  door: OfficeViewPoint;
  board: OfficeViewPoint;
}

export const OFFICE_EDGE_WINDOW_MS = 30 * 60_000;
export const OFFICE_FEED_LIMIT = 120;

/** FNV-1a, 32-bit — a stable small hash for colours and ambient life (not security). */
export function officeHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function poseOf(state: OfficeRoleState, active: boolean): OfficeAvatarPose {
  switch (state) {
    case 'on-shift':
      return 'working';
    case 'in-huddle':
      return 'huddling';
    case 'waiting-for-you':
      return 'waiting';
    case 'paused':
    case 'over-budget':
      return 'blocked';
    case 'off-duty':
      // off-duty also covers "on call" (enabled, no schedule): that one is idle
      return active ? 'idle' : 'dozing';
    default:
      return 'idle';
  }
}

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);
const clip = (s: string, n = 90): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
/** a message's subject line (its stored text is subject, blank line, body) */
const firstLine = (s: string): string => clip(s.split('\n')[0] ?? '');
/** newest first, ties by id descending — the feed's order */
const newestFirst = (a: { at: string; id: string }, b: { at: string; id: string }): number => {
  const d = ms(b.at) - ms(a.at);
  if (d !== 0 && !Number.isNaN(d)) return d;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
};

/** Places around a huddle table, in seat order. */
const TABLE_SPOTS: readonly OfficeViewPoint[] = [
  { x: -1.9, y: 0 },
  { x: 1.9, y: 0 },
  { x: 0, y: -1.3 },
  { x: 0, y: 1.6 },
];

/**
 * Lay the office out. Pure: the same inputs give the same layout.
 *
 * Rooms: one per department with roles, in `OFFICE_DEPARTMENTS` order, packed
 * `columns` to a row (rooms in a row share the tallest height). Desks: the
 * roles in the given order, `OFFICE_DESKS_PER_ROW` to a row. Open huddles meet
 * at a table in the room of their first participant; their members sit there
 * (a paused / over-budget member stays at its desk). Edges: messages and
 * forwards younger than `edgeWindowMs`, plus every open huddle as a ring.
 */
export function layoutOffice(
  office: Office,
  roles: readonly OfficeRole[],
  states: OfficeStates | null,
  shifts: readonly OfficeShift[],
  messages: readonly OfficeMessage[],
  huddles: readonly OfficeHuddle[],
  opts: OfficeLayoutOptions,
): OfficeLayout {
  const now = typeof opts.now === 'number' ? opts.now : Date.parse(opts.now);
  const columns = Math.max(1, Math.floor(opts.columns ?? 3));
  const windowMs = opts.edgeWindowMs ?? OFFICE_EDGE_WINDOW_MS;
  const feedLimit = opts.feedLimit ?? OFFICE_FEED_LIMIT;
  const routes = opts.routes ?? {};
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const nameOf = (id: string | null | undefined): string => (id ? (roleById.get(id)?.name ?? 'a former role') : 'You');
  const stateById = new Map((states?.states ?? []).map((s) => [s.roleId, s]));

  // ---- rooms and desks
  const byDept = new Map<OfficeDepartment, OfficeRole[]>();
  for (const r of roles) {
    const d = officeDepartment(r);
    const list = byDept.get(d) ?? [];
    list.push(r);
    byDept.set(d, list);
  }
  const depts = OFFICE_DEPARTMENTS.filter((d) => byDept.has(d.id));
  const rooms: OfficeViewRoom[] = [];
  let y = WALL;
  for (let i = 0; i < depts.length; i += columns) {
    const row = depts.slice(i, i + columns);
    const rowsOfDesks = Math.max(...row.map((d) => Math.ceil(byDept.get(d.id)!.length / OFFICE_DESKS_PER_ROW)));
    const h = ROOM_HEAD + rowsOfDesks * DESK_H + ROOM_FOOT + ROOM_PAD;
    row.forEach((d, c) => {
      const rect = { x: WALL + c * (ROOM_W + WALL), y, w: ROOM_W, h };
      const desks = byDept.get(d.id)!.map((r, k): OfficeViewDesk => {
        const dx = rect.x + ROOM_PAD + (k % OFFICE_DESKS_PER_ROW) * DESK_W;
        const dy = rect.y + ROOM_HEAD + Math.floor(k / OFFICE_DESKS_PER_ROW) * DESK_H;
        return {
          roleId: r.id,
          rect: { x: dx + 0.5, y: dy + 0.5, w: DESK_W - 1, h: 1.5 },
          seat: { x: dx + DESK_W / 2, y: dy + 2.8 },
        };
      });
      const floor = { x: rect.x + ROOM_PAD, y: rect.y + h - ROOM_PAD - ROOM_FOOT, w: ROOM_W - ROOM_PAD * 2, h: ROOM_FOOT };
      rooms.push({
        id: d.id,
        label: d.label,
        rect,
        desks,
        coffee: { x: floor.x + floor.w - 1, y: floor.y + floor.h - 1 },
        floor,
        table: null,
        huddleIds: [],
      });
    });
    y += h + WALL;
  }
  const width = WALL + Math.min(columns, Math.max(depts.length, 1)) * (ROOM_W + WALL);
  const lobby = { x: WALL, y, w: width - WALL * 2, h: LOBBY_H };
  const door: OfficeViewPoint = { x: lobby.x + 1.5, y: lobby.y + LOBBY_H / 2 };
  const board: OfficeViewPoint = { x: lobby.x + lobby.w - 1.5, y: lobby.y + LOBBY_H / 2 };
  const height = y + LOBBY_H + WALL;
  const roomOf = new Map<string, OfficeViewRoom>();
  const deskOf = new Map<string, OfficeViewDesk>();
  for (const room of rooms) for (const d of room.desks) (roomOf.set(d.roleId, room), deskOf.set(d.roleId, d));

  // ---- huddles: open ones meet at a table in the first participant's room
  const open = huddles.filter((h) => h.status === 'open' && h.officeId === office.id).sort((a, b) => newestFirst({ at: a.createdAt, id: a.id }, { at: b.createdAt, id: b.id }));
  const huddleOf = new Map<string, OfficeHuddle>(); // role → newest open huddle
  const tableSpot = new Map<string, OfficeViewPoint>();
  for (const h of open) {
    const members = h.roleIds.filter((id) => roleById.has(id) && !huddleOf.has(id));
    const host = h.roleIds.map((id) => roomOf.get(id)).find((r) => r);
    if (!host || members.length === 0) continue;
    if (!host.table) host.table = { x: host.floor.x + 3, y: host.floor.y + host.floor.h / 2 };
    host.huddleIds.push(h.id);
    // a second huddle in the same room takes the far end of the strip
    const t = host.huddleIds.length === 1 ? host.table : { x: host.floor.x + host.floor.w / 2 + 0.5, y: host.table.y };
    members.forEach((id, k) => {
      huddleOf.set(id, h);
      const s = TABLE_SPOTS[k % TABLE_SPOTS.length];
      tableSpot.set(id, { x: t.x + s.x, y: t.y + s.y });
    });
  }

  // ---- shifts and briefs per role
  const liveShift = new Map<string, OfficeShift>();
  const lastShift = new Map<string, OfficeShift>();
  for (const s of shifts) {
    if (s.verdict !== 'ran') continue;
    const prev = lastShift.get(s.roleId);
    if (!prev || ms(s.startedAt) > ms(prev.startedAt)) lastShift.set(s.roleId, s);
    if (s.endedAt === null) {
      const lp = liveShift.get(s.roleId);
      if (!lp || ms(s.startedAt) > ms(lp.startedAt)) liveShift.set(s.roleId, s);
    }
  }
  const lastBrief = new Map<string, OfficeBrief>();
  for (const b of opts.briefs ?? []) {
    if (b.officeId !== office.id) continue;
    const prev = lastBrief.get(b.roleId);
    if (!prev || ms(b.createdAt) > ms(prev.createdAt)) lastBrief.set(b.roleId, b);
  }
  const ref = (s: OfficeShift | undefined): OfficeViewShiftRef | null =>
    s ? { id: s.id, runId: s.runId, startedAt: s.startedAt, endedAt: s.endedAt } : null;

  // ---- avatars
  const avatars: OfficeViewAvatar[] = [];
  for (const r of roles) {
    const desk = deskOf.get(r.id)!;
    const st = stateById.get(r.id);
    const state: OfficeRoleState = st?.state ?? 'off-duty';
    const active = r.enabled && office.enabled;
    let pose = poseOf(state, active);
    const h = huddleOf.get(r.id) ?? null;
    if (h && pose !== 'blocked' && pose !== 'dozing') pose = 'huddling';
    const at = h && pose === 'huddling' ? tableSpot.get(r.id)! : desk.seat;
    const b = lastBrief.get(r.id);
    avatars.push({
      roleId: r.id,
      key: r.key,
      name: r.name,
      title: r.title,
      avatar: r.avatar,
      room: roomOf.get(r.id)!.id,
      seat: desk.seat,
      at,
      state,
      detail: st?.detail ?? '',
      pose,
      wanders: pose === 'idle',
      colorSlot: (officeHash(r.id) % 7) + 1,
      enabled: r.enabled,
      huddleId: pose === 'huddling' ? (h?.id ?? null) : null,
      liveShift: ref(liveShift.get(r.id)),
      lastShift: ref(lastShift.get(r.id)),
      lastBrief: b ? { id: b.id, summary: b.summary, createdAt: b.createdAt, tainted: b.taintedAt !== null } : null,
      spentTodayUsd: st?.spentTodayUsd ?? 0,
      nextSlotAt: st?.nextSlotAt ?? null,
      notesTainted: r.notesTaintedAt !== null,
    });
  }
  const avatarOf = new Map(avatars.map((a) => [a.roleId, a]));
  const pointOf = (end: OfficeViewEnd): OfficeViewPoint | null =>
    'role' in end ? (avatarOf.get(end.role)?.at ?? null) : end.place === 'door' ? door : board;
  const director = roles.find((r) => r.preset === 'director') ?? null;

  // ---- edges
  const edges: OfficeViewEdge[] = [];
  const live = (at: string): boolean => {
    const t = ms(at);
    return !Number.isNaN(t) && t <= now + 60_000 && now - t <= windowMs;
  };
  const pushEdge = (e: Omit<OfficeViewEdge, 'fromAt' | 'toAt'>): string | undefined => {
    const fromAt = pointOf(e.from);
    const toAt = pointOf(e.to);
    if (!fromAt || !toAt) return undefined;
    edges.push({ ...e, fromAt, toAt });
    return e.id;
  };
  const isHuddleTranscript = (m: OfficeMessage): boolean => m.subject?.kind === 'huddle' && m.toRoleId === null;
  const msgEdge = new Map<string, string>();
  for (const m of messages) {
    if (m.officeId !== office.id || isHuddleTranscript(m) || !live(m.createdAt)) continue;
    const from: OfficeViewEnd = m.fromRoleId ? { role: m.fromRoleId } : { place: 'door' };
    // an unrouted channel message waits on the board for the Director's routing
    const to: OfficeViewEnd = m.toRoleId ? { role: m.toRoleId } : { place: 'board' };
    const id = pushEdge({ id: `m:${m.id}`, kind: 'message', from, to, at: m.createdAt, label: m.kind, refId: m.id, tainted: m.taintedAt !== null });
    if (id) msgEdge.set(m.id, id);
  }
  const shiftRole = new Map(shifts.map((s) => [s.id, s.roleId]));
  const routeEdge = new Map<string, string>();
  for (const r of Object.values(routes)) {
    if (r.action !== 'forward' || !r.toRoleId || !live(r.at)) continue;
    const router = (r.shiftId && shiftRole.get(r.shiftId)) || director?.id;
    const from: OfficeViewEnd = router ? { role: router } : { place: 'board' };
    const id = pushEdge({ id: `r:${r.messageId}`, kind: 'route', from, to: { role: r.toRoleId }, at: r.at, label: 'forward', refId: r.messageId, tainted: r.tainted });
    if (id) routeEdge.set(r.messageId, id);
  }
  const huddleEdge = new Map<string, string>();
  for (const h of open) {
    const seated = h.roleIds.filter((id) => avatarOf.get(id)?.huddleId === h.id);
    if (seated.length < 2) continue;
    const pairs = seated.length === 2 ? 1 : seated.length;
    for (let k = 0; k < pairs; k++) {
      const id = pushEdge({
        id: `h:${h.id}:${k}`,
        kind: 'huddle',
        from: { role: seated[k] },
        to: { role: seated[(k + 1) % seated.length] },
        at: h.updatedAt,
        label: `huddle ${h.turns}/${h.maxTurns}`,
        refId: h.id,
        tainted: h.taintedAt !== null,
      });
      if (id && k === 0) huddleEdge.set(h.id, id);
    }
  }

  // ---- feed
  const feed: OfficeFeedItem[] = [];
  for (const s of shifts) {
    if (s.officeId !== office.id) continue;
    const who = nameOf(s.roleId);
    const trig = s.trigger.ref ? `${s.trigger.kind} ${clip(s.trigger.ref, 40)}` : s.trigger.kind;
    if (s.verdict === 'skipped') {
      feed.push({
        id: `s:${s.id}:skip`,
        at: s.startedAt,
        kind: 'shift-skipped',
        roleIds: [s.roleId],
        text: `${who} skipped a shift (${trig})${s.skipReason ? ` — ${clip(s.skipReason, 80)}` : ''}`,
        tone: 'neutral',
        ref: { kind: 'shift', id: s.id },
      });
      continue;
    }
    feed.push({
      id: `s:${s.id}:start`,
      at: s.startedAt,
      kind: 'shift-start',
      roleIds: [s.roleId],
      text: `${who} started a shift (${trig})`,
      tone: 'info',
      ref: { kind: 'shift', id: s.id, runId: s.runId },
      tainted: s.tainted || undefined,
    });
    if (s.endedAt) {
      const bits = [`$${s.costUsd.toFixed(2)}`];
      if (s.filedTaskIds.length) bits.push(`filed ${s.filedTaskIds.length} task${s.filedTaskIds.length === 1 ? '' : 's'}`);
      feed.push({
        id: `s:${s.id}:end`,
        at: s.endedAt,
        kind: 'shift-end',
        roleIds: [s.roleId],
        text: s.error ? `${who}'s shift failed — ${clip(s.error, 80)}` : `${who} finished a shift · ${bits.join(' · ')}`,
        tone: s.error ? 'bad' : 'good',
        ref: { kind: 'shift', id: s.id, runId: s.runId },
        tainted: s.tainted || undefined,
      });
    }
  }
  for (const b of opts.briefs ?? []) {
    if (b.officeId !== office.id) continue;
    feed.push({
      id: `b:${b.id}`,
      at: b.createdAt,
      kind: 'brief',
      roleIds: [b.roleId],
      text: `${nameOf(b.roleId)} wrote ${b.kind === 'standup' ? 'the stand-up' : 'a brief'}: ${clip(b.summary, 100)}`,
      tone: 'info',
      ref: { kind: 'brief', id: b.id },
      tainted: b.taintedAt !== null || undefined,
    });
  }
  for (const m of messages) {
    if (m.officeId !== office.id || isHuddleTranscript(m)) continue;
    const to = m.toRoleId ? nameOf(m.toRoleId) : 'the channel';
    feed.push({
      id: `m:${m.id}`,
      at: m.createdAt,
      kind: 'message',
      roleIds: [m.fromRoleId, m.toRoleId].filter((x): x is string => !!x),
      text: `${nameOf(m.fromRoleId)} → ${to} (${m.kind}): ${firstLine(m.body)}`,
      tone: 'neutral',
      edgeId: msgEdge.get(m.id),
      ref: { kind: 'message', id: m.id },
      tainted: m.taintedAt !== null || undefined,
    });
  }
  const msgById = new Map(messages.map((m) => [m.id, m]));
  for (const r of Object.values(routes)) {
    const m = msgById.get(r.messageId);
    if (!m || m.officeId !== office.id || r.action === 'deliver') continue;
    const router = (r.shiftId && shiftRole.get(r.shiftId)) || director?.id || null;
    const what =
      r.action === 'task'
        ? r.dropped
          ? `as a task (dropped: ${clip(r.dropped, 60)})`
          : r.proposalId
            ? 'as a proposal'
            : 'as a task'
        : r.action === 'huddle'
          ? 'into a huddle'
          : r.action === 'forward'
            ? `to ${nameOf(r.toRoleId)}`
            : 'with a note';
    feed.push({
      id: `r:${r.messageId}`,
      at: r.at,
      kind: 'route',
      roleIds: [router, m.fromRoleId, r.toRoleId ?? null].filter((x): x is string => !!x),
      text: `${router ? nameOf(router) : 'The Director'} routed ${nameOf(m.fromRoleId)}'s ${m.kind} ${what}`,
      tone: r.dropped ? 'warn' : 'neutral',
      edgeId: routeEdge.get(r.messageId),
      ref: r.taskId ? { kind: 'task', id: r.taskId } : r.huddleId ? { kind: 'huddle', id: r.huddleId } : { kind: 'message', id: r.messageId },
    });
  }
  for (const h of huddles) {
    if (h.officeId !== office.id) continue;
    const who = h.roleIds.map((id) => nameOf(id)).join(', ');
    feed.push({
      id: `h:${h.id}:open`,
      at: h.createdAt,
      kind: 'huddle-open',
      roleIds: [...h.roleIds],
      text: `Huddle opened (${h.subject.kind}): ${who}`,
      tone: 'info',
      edgeId: huddleEdge.get(h.id),
      ref: { kind: 'huddle', id: h.id },
      tainted: h.taintedAt !== null || undefined,
    });
    if (h.status !== 'open' && h.closedAt) {
      feed.push({
        id: `h:${h.id}:close`,
        at: h.closedAt,
        kind: 'huddle-closed',
        roleIds: [...h.roleIds],
        text: h.status === 'decided' ? `Huddle decided after ${h.turns} turn${h.turns === 1 ? '' : 's'}` : `Huddle expired after ${h.turns} turn${h.turns === 1 ? '' : 's'}`,
        tone: h.status === 'decided' ? 'good' : 'warn',
        ref: { kind: 'huddle', id: h.id },
      });
    }
  }
  const feedKinds = new Set<string>(OFFICE_FEED_EVENT_KINDS);
  for (const e of opts.events ?? []) {
    if (!feedKinds.has(e.kind)) continue;
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (d.officeId !== office.id) continue;
    const item = eventItem(e, d, nameOf);
    if (item) feed.push(item);
  }
  for (const t of opts.taskSteps ?? []) {
    for (const s of t.steps) {
      if (!OFFICE_FEED_STEP_KINDS.has(s.kind)) continue;
      feed.push({
        id: `t:${t.taskId}:${s.kind}:${s.at}`,
        at: s.at,
        kind: 'task-step',
        roleIds: t.roleId ? [t.roleId] : [],
        text: `${clip(t.title, 60)}: ${s.label}`,
        tone: s.tone,
        ref: { kind: 'task', id: t.taskId, runId: s.runId ?? null },
      });
    }
  }
  // de-duplicate on id (a task step can repeat its kind at one instant) and order
  const seen = new Set<string>();
  const unique = feed.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
  unique.sort(newestFirst);

  return { width, height, rooms, avatars, edges, feed: unique.slice(0, feedLimit), lobby, door, board };
}

/** One feed line from an `OFFICE_FEED_EVENT_KINDS` audit row — server-known fields only, never agent text. */
function eventItem(e: AuditEvent, d: Record<string, unknown>, nameOf: (id: string | null | undefined) => string): OfficeFeedItem | null {
  const roleId = typeof d.roleId === 'string' ? d.roleId : null;
  const roleIds = roleId ? [roleId] : [];
  const base = { id: `e:${e.id}`, at: e.at, kind: 'event' as const, roleIds };
  const num = (v: unknown): number => (typeof v === 'number' ? v : Array.isArray(v) ? v.length : 0);
  switch (e.kind) {
    case 'office.paused':
      return { ...base, text: 'Office paused', tone: 'warn' };
    case 'office.resumed':
      return { ...base, text: 'Office resumed', tone: 'good' };
    case 'office.wake':
      return { ...base, text: `${nameOf(roleId)} was woken by ${e.actor}`, tone: 'info' };
    case 'office.taint-cleared':
      return { ...base, text: 'A human reviewed untrusted text and cleared its taint', tone: 'good' };
    case 'office.proposals':
      return { ...base, text: `${nameOf(roleId)} proposed work`, tone: 'info' };
    case 'office.proposal-decided':
      return {
        ...base,
        text: `A proposal by ${nameOf(roleId)} was ${d.accepted ? 'accepted' : 'rejected'}`,
        tone: d.accepted ? 'good' : 'neutral',
      };
    case 'office.feature':
      return { ...base, text: d.dropped ? `${nameOf(roleId)}'s feature request was dropped` : `${nameOf(roleId)} filed a feature`, tone: d.dropped ? 'warn' : 'info' };
    case 'office.wish':
      return { ...base, text: 'You added a wish for the Director', tone: 'info' };
    case 'office.vision-changed':
      return { ...base, text: `${typeof d.name === 'string' ? d.name : 'A planning doc'} changed`, tone: 'info' };
    case 'office.filing': {
      const filed = num(d.filed ?? d.filedTaskIds ?? d.taskIds);
      return { ...base, text: filed ? `${nameOf(roleId)} filed ${filed} task${filed === 1 ? '' : 's'}` : `${nameOf(roleId)} filed work`, tone: 'info' };
    }
    case 'office.command': {
      const name = typeof d.name === 'string' && d.name ? d.name : 'a saved command';
      if (d.action === 'skipped') return { ...base, text: `${name} was not run for ${nameOf(roleId)}`, tone: 'neutral' };
      const exit = typeof d.exitCode === 'number' ? d.exitCode : null;
      if (d.action === 'ran') return { ...base, text: `${name} ran for ${nameOf(roleId)}${exit === null ? '' : ` (exit ${exit})`}`, tone: exit === 0 ? 'good' : 'warn' };
      return { ...base, text: `${name} ${typeof d.action === 'string' ? d.action : 'ended'} for ${nameOf(roleId)}`, tone: 'warn' };
    }
    case 'office.chat-to-channel':
      return { ...base, text: 'You sent a chat message to the channel', tone: 'info' };
    default:
      return null;
  }
}

// ---- ambient life ------------------------------------------------------------

export type OfficeWanderActivity = 'desk' | 'coffee' | 'stroll' | 'chat';

/**
 * Where an idle avatar is at ambient tick `tick` (docs/office.md § The view →
 * Ambient life). Deterministic in (role id, tick): every tab shows the same
 * scene, and a test can pin it. Mostly at the desk; sometimes coffee, a stroll
 * across the room's open strip, or a chat beside another idle role of the
 * same room. A non-wandering avatar always reads `{at: avatar.at, desk}`.
 */
export function officeWanderSpot(
  avatar: Pick<OfficeViewAvatar, 'roleId' | 'at' | 'seat' | 'wanders' | 'room'>,
  layout: Pick<OfficeLayout, 'rooms' | 'avatars'>,
  tick: number,
): { at: OfficeViewPoint; activity: OfficeWanderActivity } {
  if (!avatar.wanders) return { at: avatar.at, activity: 'desk' };
  const room = layout.rooms.find((r) => r.id === avatar.room);
  if (!room) return { at: avatar.seat, activity: 'desk' };
  const h = officeHash(`${avatar.roleId}#${tick}`);
  const roll = h % 10;
  if (roll < 4) return { at: avatar.seat, activity: 'desk' };
  if (roll < 6) {
    const k = (h >>> 8) % 3;
    return { at: { x: room.coffee.x - 1 - k * 0.8, y: room.coffee.y - 0.2 }, activity: 'coffee' };
  }
  const f = room.floor;
  const stroll = { x: f.x + 0.8 + ((h >>> 8) % 100) / 100 * (f.w - 1.6), y: f.y + 0.8 + ((h >>> 16) % 100) / 100 * (f.h - 1.6) };
  if (roll < 8) return { at: stroll, activity: 'stroll' };
  const peers = layout.avatars.filter((a) => a.wanders && a.room === avatar.room && a.roleId !== avatar.roleId);
  if (peers.length === 0) return { at: stroll, activity: 'stroll' };
  const peer = peers[(h >>> 4) % peers.length];
  // stand beside the peer's desk, facing it
  return { at: { x: peer.seat.x + (peer.seat.x > avatar.seat.x ? -1.2 : 1.2), y: peer.seat.y + 0.3 }, activity: 'chat' };
}
