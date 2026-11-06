// useOfficeView (docs/office.md § The view): THE seam the office place reads,
// like useTimeline for /timeline. It loads the office (roles + newest shifts),
// its states, channel, huddles, briefs, the feed's audit rows and the history
// of the office's recently active tasks, keeps all of it live from
// `/ws/events`, and lays it out with the pure `layoutOffice`. Skins, the card
// and the feed only render what it returns.
//
// Live: every listener is subscribed BEFORE the first fetch and buffers until
// it lands (then replays), so nothing that happens mid-load is lost. No event
// carries shift rows, so an office.updated / office.shift row / shift run
// start or exit re-reads the detail (debounced); a reconnect re-reads all.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  OFFICE_FEED_EVENT_KINDS,
  buildTaskHistory,
  layoutOffice,
  type AuditEvent,
  type HistoryStep,
  type OfficeBrief,
  type OfficeDetail,
  type OfficeHuddle,
  type OfficeLayout,
  type OfficeMessage,
  type OfficeMessageRoute,
  type OfficeStates,
  type OfficeTaskSteps,
  type ServerEvent,
} from '@tm/shared';
import { api } from './api.ts';
import { onTick } from './clock.ts';
import { onServerEvent, useApp } from './state.tsx';
import { errorText } from './toast.ts';

const FEED_KINDS = new Set<string>(OFFICE_FEED_EVENT_KINDS);
/** audit kinds that mean a shift row changed (no event carries shifts) */
const SHIFT_KINDS = new Set<string>(['office.shift', 'office.shift-skipped', 'office.wake', 'office.brief', 'office.filing']);
/** the office tasks whose history steps join the feed: active in this window, newest first */
const TASK_WINDOW_MS = 48 * 3600_000;
const TASK_MAX = 8;

export interface OfficeViewData {
  detail: OfficeDetail | null;
  states: OfficeStates | null;
  layout: OfficeLayout | null;
  error: string | null;
  reload: () => void;
}

const upsert = <T extends { id: string }>(list: T[], row: T): T[] => {
  const i = list.findIndex((x) => x.id === row.id);
  if (i < 0) return [row, ...list];
  const next = list.slice();
  next[i] = row;
  return next;
};

const officeOf = (e: AuditEvent): unknown => (e.data as { officeId?: unknown } | null)?.officeId;

export function useOfficeView(officeId: string, columns: number): OfficeViewData {
  const { tasks, connected } = useApp();
  const [detail, setDetail] = useState<OfficeDetail | null>(null);
  const [states, setStates] = useState<OfficeStates | null>(null);
  const [messages, setMessages] = useState<OfficeMessage[]>([]);
  const [routes, setRoutes] = useState<Record<string, OfficeMessageRoute>>({});
  const [huddles, setHuddles] = useState<OfficeHuddle[]>([]);
  const [briefs, setBriefs] = useState<OfficeBrief[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // a debounced re-read of the detail + states (shift rows have no event)
  const soonTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soon = useRef<() => void>(() => {});
  soon.current = () => {
    if (soonTimer.current) clearTimeout(soonTimer.current);
    soonTimer.current = setTimeout(() => {
      soonTimer.current = null;
      Promise.all([api.getOffice(officeId), api.officeStates(officeId)])
        .then(([d, s]) => {
          setDetail(d);
          setStates(s);
        })
        .catch(() => {}); // the next tick tries again; the first load reports errors
    }, 400);
  };
  useEffect(() => () => void (soonTimer.current && clearTimeout(soonTimer.current)), []);

  useEffect(() => onTick(30_000, () => setNow(Date.now())), []);
  useEffect(() => onTick(60_000, () => soon.current()), []);

  // a reconnect missed rows: read everything again
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnected.current) setNonce((n) => n + 1);
    wasConnected.current = connected;
  }, [connected]);

  useEffect(() => {
    let cancelled = false;
    let buffered: ServerEvent[] | null = [];
    const apply = (e: ServerEvent) => {
      switch (e.type) {
        case 'office.updated':
          if (e.office.id !== officeId) return;
          setDetail((cur) => (cur ? { ...cur, office: e.office, roles: e.roles ?? cur.roles } : cur));
          if (e.states) setStates(e.states);
          soon.current();
          return;
        case 'office-message.created':
        case 'office-message.updated':
          if (e.message.officeId !== officeId) return;
          setMessages((cur) => upsert(cur, e.message));
          if (e.type === 'office-message.updated' && e.route) {
            const route = e.route;
            setRoutes((cur) => ({ ...cur, [route.messageId]: route }));
          }
          return;
        case 'office-huddle.updated':
          if (e.huddle.officeId !== officeId) return;
          setHuddles((cur) => upsert(cur, e.huddle));
          return;
        case 'office.brief':
          if (e.brief.officeId !== officeId) return;
          setBriefs((cur) => upsert(cur, e.brief));
          return;
        case 'event.appended':
          if (officeOf(e.event) !== officeId) return;
          if (FEED_KINDS.has(e.event.kind)) setEvents((cur) => (cur.some((x) => x.id === e.event.id) ? cur : [e.event, ...cur].slice(0, 300)));
          if (SHIFT_KINDS.has(e.event.kind)) soon.current();
          return;
        case 'run.started':
        case 'run.exited':
          if (e.run.mode === 'aux' && e.run.kind === 'shift') soon.current();
          return;
        default:
          return;
      }
    };
    const off = onServerEvent((e) => {
      if (cancelled) return;
      if (buffered) buffered.push(e);
      else apply(e);
    });
    Promise.all([
      api.getOffice(officeId),
      api.officeStates(officeId),
      api.officeChannel(officeId),
      api.officeHuddles(officeId),
      api.listOfficeBriefs(officeId, 100),
      api.officeFeed(officeId, 200),
    ])
      .then(([d, s, ch, hu, br, ev]) => {
        if (cancelled) return;
        setDetail(d);
        setStates(s);
        setMessages(ch.messages);
        setRoutes(ch.routes);
        setHuddles(hu.huddles);
        setBriefs(br);
        setEvents(ev);
        setError(null);
        const replay = buffered ?? [];
        buffered = null;
        replay.forEach(apply);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(errorText(e));
        const replay = buffered ?? [];
        buffered = null;
        replay.forEach(apply);
      });
    return () => {
      cancelled = true;
      off();
    };
  }, [officeId, nonce]);

  // ---- the office's recently active tasks → history steps for the feed
  const hourly = Math.floor(now / 3600_000); // the window slides hourly, not per tick
  const officeTasks = useMemo(() => {
    const since = hourly * 3600_000 - TASK_WINDOW_MS;
    return tasks
      .filter((t) => t.officeId === officeId && Date.parse(t.updatedAt) >= since)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, TASK_MAX);
  }, [tasks, officeId, hourly]);
  const taskKey = officeTasks.map((t) => `${t.id}@${t.updatedAt}`).join(',');
  const [history, setHistory] = useState<ReadonlyMap<string, { updatedAt: string; steps: HistoryStep[] }>>(new Map());
  const historyRef = useRef(history);
  historyRef.current = history;
  useEffect(() => {
    let cancelled = false;
    const stale = officeTasks.filter((t) => historyRef.current.get(t.id)?.updatedAt !== t.updatedAt);
    if (stale.length === 0) return;
    const timer = setTimeout(() => {
      Promise.all(
        stale.map((t) =>
          api
            .taskHistory(t.id)
            .then((res) => {
              const nowIso = new Date().toISOString();
              const steps = buildTaskHistory({ task: t, events: res.events, runs: res.runs, segments: res.segments, dispatches: res.dispatches, now: nowIso });
              return [t.id, { updatedAt: t.updatedAt, steps }] as const;
            })
            .catch(() => null),
        ),
      ).then((rows) => {
        if (cancelled) return;
        setHistory((cur) => {
          const next = new Map(cur);
          for (const r of rows) if (r) next.set(r[0], r[1]);
          return next;
        });
      });
    }, 800);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // taskKey is the identity of the set and its versions
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskKey]);
  const taskSteps = useMemo<OfficeTaskSteps[]>(
    () => officeTasks.map((t) => ({ taskId: t.id, title: t.title, roleId: t.roleId, steps: history.get(t.id)?.steps ?? [] })),
    [officeTasks, history],
  );

  const layout = useMemo(
    () =>
      detail
        ? layoutOffice(detail.office, detail.roles, states, detail.shifts, messages, huddles, { now, columns, routes, briefs, events, taskSteps })
        : null,
    [detail, states, messages, huddles, now, columns, routes, briefs, events, taskSteps],
  );

  return { detail, states, layout, error, reload: () => soon.current() };
}
