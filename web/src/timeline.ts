import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  foldEvent,
  foldEvents,
  foldRun,
  initTimeline,
  predictSchedule,
  TIMELINE_EVENT_KINDS,
  timelineSegments,
  type AuditEvent,
  type PredictedSlot,
  type Run,
  type ScheduleBaseline,
  type Task,
  type TimelineSegment,
  type TimelineState,
} from '@tm/shared';
import { api } from './api.ts';
import { computeProgress, useProgressBaseline } from './progress.ts';
import { onServerEvent, useApp } from './state.tsx';
import { useWorkspace } from './workspace.ts';

/**
 * The timeline's data seam (docs/timeline.md § SPA): the past of a window,
 * kept live by folding `/ws/events` rows through the shared `foldEvent` — the
 * server's batch build IS that fold, so the two never disagree — plus NOW and
 * the predicted future, recomputed from app state on every change and on a
 * 30 s tick. Views (TimelineTracks, TimelineStream) only render what this
 * returns.
 */

// ---- duration baseline (cached like the progress baseline) -------------------

const BASELINE_TTL_MS = 3600_000;
let baseline: ScheduleBaseline | null = null;
let fetchedAt = 0;
let fetching = false;
const baselineListeners = new Set<() => void>();

function loadBaseline(): void {
  if (fetching || Date.now() - fetchedAt < BASELINE_TTL_MS) return;
  fetching = true;
  api
    .scheduleBaseline()
    .then((b) => {
      baseline = b;
      fetchedAt = Date.now();
      for (const l of baselineListeners) l();
    })
    // a blip: retry in a minute; the simulator falls back to its defaults meanwhile
    .catch(() => {
      fetchedAt = Date.now() - BASELINE_TTL_MS + 60_000;
    })
    .finally(() => {
      fetching = false;
    });
}

function subscribeBaseline(l: () => void): () => void {
  baselineListeners.add(l);
  loadBaseline();
  return () => {
    baselineListeners.delete(l);
  };
}

export function useScheduleBaseline(): ScheduleBaseline | null {
  const b = useSyncExternalStore(subscribeBaseline, () => baseline);
  loadBaseline(); // a no-op inside the hour
  return b;
}

// ---- NOW ----------------------------------------------------------------------

/** how often NOW and the ETAs move without any event */
export const TIMELINE_TICK_MS = 30_000;

function useTick(ms: number): [number, () => void] {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  const bump = useCallback(() => setNow(Date.now()), []);
  return [now, bump];
}

// ---- optimistic patches -------------------------------------------------------

/**
 * Task fields a drag may change before the server answers (phase 4 reorders
 * the global and custom queues). Each entry is dropped by itself once the
 * server's row moves past the one it was applied over (`updatedAt` differs),
 * so a confirmed move never lingers and a refused one is cleared by its
 * caller through the returned function.
 */
export type OptimisticTaskPatch = Partial<Pick<Task, 'sortOrder' | 'priority' | 'customQueueAt' | 'queueHeldAt' | 'status'>>;
export interface OptimisticPatch {
  tasks: Record<string, OptimisticTaskPatch>;
}

interface PatchEntry {
  patch: OptimisticTaskPatch;
  /** the server row's `updatedAt` it was applied over */
  over: string;
  seq: number;
}

function patchedTasks(tasks: Task[], entries: Record<string, PatchEntry[]>): Task[] {
  if (!Object.keys(entries).length) return tasks;
  return tasks.map((t) => {
    const list = entries[t.id]?.filter((e) => e.over === t.updatedAt);
    if (!list?.length) return t;
    return Object.assign({}, t, ...list.map((e) => e.patch)) as Task;
  });
}

// ---- the hook -------------------------------------------------------------------

export interface TimelineWindowArg {
  /** ISO start of the past shown */
  since: string;
  /** ISO end; omitted/null = live, the window ends at NOW and moves with it */
  until?: string | null;
}

export interface UseTimeline {
  /** past segments per task, clipped to the window (open ones `end: null`) */
  segments: Record<string, TimelineSegment[]>;
  /** epoch ms of NOW, moved by the tick and by every folded event */
  now: number;
  /** the window actually shown (since = the answer's `coveredSince`) */
  since: string;
  until: string;
  live: boolean;
  loading: boolean;
  error: string | null;
  /** a row cap cut the window: segments before `since` are missing */
  truncated: boolean;
  /** the duration baseline the ETAs came from (null = the simulator's defaults) */
  baseline: ScheduleBaseline | null;
  /** tasks with any optimistic patch applied — what the prediction ran over */
  tasks: Task[];
  /**
   * `predictSchedule()` over the WHOLE board (claims, the cap and repo holds
   * are global), then cut to the workspace: scheduled slots by start, then
   * the unscheduled with their reason
   */
  predicted: PredictedSlot[];
  applyOptimistic(patch: OptimisticPatch): () => void;
  clearOptimistic(): void;
  reload(): void;
}

const TIMELINE_KINDS: ReadonlySet<string> = new Set(TIMELINE_EVENT_KINDS);
/** the runs the server's timeline carries (routes/timeline.ts `timelineRun`) */
const timelineRun = (r: Run) => r.mode === 'worker' || r.kind === 'review' || r.kind === 'compact';

export function useTimeline(win: TimelineWindowArg): UseTimeline {
  const app = useApp();
  const { tasks, connected } = app;
  const { repoIds } = useWorkspace();
  const base = useScheduleBaseline();
  const [now, bumpNow] = useTick(TIMELINE_TICK_MS);

  const live = win.until == null;
  // a fixed window's end; a live one is fetched up to the moment of the fetch
  const fixedUntil = win.until ?? null;
  const scope = useMemo(() => (repoIds ? [...repoIds].sort() : null), [repoIds]);
  const scopeKey = scope ? scope.join(',') : '*';

  const [fold, setFold] = useState<TimelineState>(initTimeline);
  const [meta, setMeta] = useState<{ coveredSince: string; truncated: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // a reconnect missed whatever happened while the socket was down: refetch
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnected.current) reload();
    wasConnected.current = connected;
  }, [connected, reload]);

  // scope is read by the listener, which is bound once per fetch
  const scopeRef = useRef<ReadonlySet<string> | null>(null);
  scopeRef.current = scope ? new Set(scope) : null;

  // the window+scope the fold holds: a new one starts empty, a reload keeps showing the old rows
  const foldKey = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const key = `${win.since}|${fixedUntil ?? 'live'}|${scopeKey}`;
    if (foldKey.current !== key) {
      foldKey.current = key;
      setFold(initTimeline());
      setMeta(null);
    }
    // Subscribed BEFORE the fetch: rows that arrive while it is in flight are
    // buffered and folded after the answer. `foldEvent` drops an id at or
    // below the newest folded one, so a row the answer already had is a no-op.
    let buffered: { events: AuditEvent[]; runs: Run[] } | null = { events: [], runs: [] };
    const relevantEvent = (e: AuditEvent, state: TimelineState) => {
      if (!TIMELINE_KINDS.has(e.kind)) return false;
      const sc = scopeRef.current;
      if (!sc) return true;
      // `task.deleted` carries no repo: it closes a task the window already shows
      if (e.repoId === null) return !!e.taskId && e.taskId in state.tasks;
      return sc.has(e.repoId);
    };
    const relevantRun = (r: Run) => {
      if (!timelineRun(r)) return false;
      const sc = scopeRef.current;
      return !sc || (r.repoId !== null && sc.has(r.repoId));
    };
    const off = onServerEvent((e) => {
      if (!live) return; // a past window does not move
      if (e.type === 'event.appended') {
        if (buffered) buffered.events.push(e.event);
        else {
          setFold((s) => (relevantEvent(e.event, s) ? foldEvent(s, e.event) : s));
          bumpNow();
        }
      } else if (e.type === 'run.started' || e.type === 'run.updated' || e.type === 'run.exited') {
        if (!relevantRun(e.run)) return;
        if (buffered) buffered.runs.push(e.run);
        else setFold((s) => foldRun(s, e.run));
      }
      // `task.updated` needs no fold: it moves the app's task rows, which the
      // prediction below reads
    });
    setLoading(true);
    setError(null);
    const until = fixedUntil ?? new Date().toISOString();
    api
      .timeline({ since: win.since, until, repoIds: scope ?? undefined })
      .then((res) => {
        if (cancelled) return;
        let state = foldEvents(res.events, res.runs);
        const pending = buffered!;
        buffered = null;
        for (const r of pending.runs) if (relevantRun(r)) state = foldRun(state, r);
        for (const e of [...pending.events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
          if (relevantEvent(e, state)) state = foldEvent(state, e);
        }
        setFold(state);
        setMeta({ coveredSince: res.coveredSince, truncated: res.truncated });
        bumpNow();
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        buffered = null;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      off();
    };
    // scopeKey stands for `scope`; nonce is reload()
  }, [win.since, fixedUntil, live, scopeKey, nonce, bumpNow]);

  const since = meta?.coveredSince ?? win.since;
  const nowIso = new Date(now).toISOString();
  const until = fixedUntil ?? nowIso;
  const segments = useMemo(
    () => timelineSegments(fold, { since, until, now: nowIso }),
    [fold, since, until, nowIso],
  );

  // ---- optimistic patches ----
  const seq = useRef(0);
  const [patches, setPatches] = useState<Record<string, PatchEntry[]>>({});
  const applyOptimistic = useCallback(
    (patch: OptimisticPatch) => {
      const id = ++seq.current;
      const byId = new Map(tasks.map((t) => [t.id, t]));
      setPatches((cur) => {
        const next = { ...cur };
        for (const [taskId, p] of Object.entries(patch.tasks)) {
          const t = byId.get(taskId);
          if (!t) continue;
          next[taskId] = [...(next[taskId] ?? []), { patch: p, over: t.updatedAt, seq: id }];
        }
        return next;
      });
      return () =>
        setPatches((cur) => {
          const next: Record<string, PatchEntry[]> = {};
          for (const [taskId, list] of Object.entries(cur)) {
            const kept = list.filter((e) => e.seq !== id);
            if (kept.length) next[taskId] = kept;
          }
          return next;
        });
    },
    [tasks],
  );
  const clearOptimistic = useCallback(() => setPatches({}), []);
  // drop entries the server's row has moved past
  useEffect(() => {
    setPatches((cur) => {
      if (!Object.keys(cur).length) return cur;
      const at = new Map(tasks.map((t) => [t.id, t.updatedAt]));
      let changed = false;
      const next: Record<string, PatchEntry[]> = {};
      for (const [taskId, list] of Object.entries(cur)) {
        const kept = list.filter((e) => at.get(taskId) === e.over);
        if (kept.length !== list.length) changed = true;
        if (kept.length) next[taskId] = kept;
      }
      return changed ? next : cur;
    });
  }, [tasks]);
  const effectiveTasks = useMemo(() => patchedTasks(tasks, patches), [tasks, patches]);

  // ---- the predicted future ----
  const { repos, features, runs, activity, commands, orch, settings } = app;
  const progressBase = useProgressBaseline();
  const allPredicted = useMemo(() => {
    const liveRuns = runs.filter((r) => r.status === 'running');
    // the same reading as the board row's bar, floor included (progress.ts)
    const progress: Record<string, number | null> = {};
    for (const t of effectiveTasks) {
      if (t.status === 'running' || t.status === 'waiting') progress[t.id] = computeProgress(t, runs, activity, progressBase)?.pct ?? null;
    }
    const repoChecks: Record<string, string[]> = {};
    for (const c of commands) {
      if (!c.isCheck || c.archivedAt) continue;
      (repoChecks[c.repoId] ??= []).push(c.name);
    }
    // the runs that filed a task (`createdByRun`), so an agent-filed member's filer is known after its run ended
    const filers = new Set(effectiveTasks.map((t) => t.createdByRun).filter((id): id is string => !!id));
    const runTaskIds: Record<string, string> = {};
    for (const r of runs) if (filers.has(r.id) && r.taskId) runTaskIds[r.id] = r.taskId;
    return predictSchedule({
      tasks: effectiveTasks,
      repos,
      features,
      // the live status outranks the settings snapshot, which is read once per refresh
      settings: {
        'orchestrator.enabled': orch.enabled,
        'orchestrator.paused': orch.paused ?? settings?.['orchestrator.paused'] ?? false,
        'orchestrator.concurrency': orch.concurrency,
        'review.enabled': settings?.['review.enabled'],
      },
      runs: liveRuns,
      progress,
      baseline: base,
      // auth/protected hold the repo (docs/parallel.md § Push health); a network blip does not
      pushFailing: (orch.pushHealth ?? []).filter((h) => !h.ok && (h.kind === 'auth' || h.kind === 'protected')).map((h) => h.repoId),
      repoChecks,
      runTaskIds,
      now,
    });
  }, [effectiveTasks, repos, features, runs, activity, commands, orch, settings, progressBase, base, now]);
  const predicted = useMemo(() => {
    const sc = scope ? new Set(scope) : null;
    const mine = sc ? allPredicted.filter((p) => p.repoId === null || sc.has(p.repoId)) : allPredicted;
    const at = (p: PredictedSlot) => (p.scheduled ? Date.parse(p.start) : Infinity);
    return [...mine].sort((a, b) => at(a) - at(b));
  }, [allPredicted, scope]);

  return {
    segments,
    now,
    since,
    until,
    live,
    loading,
    error,
    truncated: meta?.truncated ?? false,
    baseline: base,
    tasks: effectiveTasks,
    predicted,
    applyOptimistic,
    clearOptimistic,
    reload,
  };
}

// ---- sub-lanes ------------------------------------------------------------------

/**
 * Sub-lanes by interval overlap (docs/timeline.md § Tracks): greedy over the
 * items by start (then end), each into the lowest lane whose last item has
 * ended by its start. Half-open intervals — an item starting exactly where
 * another ends shares its lane. `minLanes` is the row's floor (a pr repo's
 * `parallel`), never a ceiling: an overlap the data really holds gets a lane
 * of its own rather than being drawn over. Returns each item's lane in the
 * input order and the row's lane count.
 */
export function assignLanes(items: readonly { start: number; end: number }[], minLanes = 1): { lanes: number[]; count: number } {
  const order = items.map((_, i) => i).sort((a, b) => items[a].start - items[b].start || items[a].end - items[b].end || a - b);
  const lanes = new Array<number>(items.length);
  const laneEnd: number[] = [];
  for (const i of order) {
    const { start, end } = items[i];
    let lane = laneEnd.findIndex((e) => e <= start);
    if (lane === -1) lane = laneEnd.push(0) - 1;
    laneEnd[lane] = Math.max(start, end);
    lanes[i] = lane;
  }
  return { lanes, count: Math.max(1, minLanes, laneEnd.length) };
}
