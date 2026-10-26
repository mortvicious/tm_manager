import { useSyncExternalStore } from 'react';
import { taskProgress, type ProgressBaseline, type Run, type RunActivity, type Task, type TaskProgress } from '@tm/shared';
import { api } from './api.ts';
import { useApp } from './state.tsx';

/**
 * The board row's progress % (docs/task-progress.md). The number itself is the
 * shared `taskProgress`; this file only gathers its inputs from the app state
 * and keeps the two pieces of memory it needs: the repo token baseline
 * (fetched once, refreshed hourly) and the per-task floor that keeps the bar
 * from moving backwards.
 */

// ---- baseline ---------------------------------------------------------------

const BASELINE_TTL_MS = 3600_000;
let baseline: ProgressBaseline | null = null;
let fetchedAt = 0;
let fetching = false;
const listeners = new Set<() => void>();

function loadBaseline(): void {
  if (fetching || Date.now() - fetchedAt < BASELINE_TTL_MS) return;
  fetching = true;
  api
    .progressBaseline()
    .then((b) => {
      baseline = b;
      fetchedAt = Date.now();
      for (const l of listeners) l();
    })
    // an older server without the route, or a blip: retry in a minute, show no work % meanwhile
    .catch(() => {
      fetchedAt = Date.now() - BASELINE_TTL_MS + 60_000;
    })
    .finally(() => {
      fetching = false;
    });
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  loadBaseline();
  return () => listeners.delete(l);
}

export function useProgressBaseline(): ProgressBaseline | null {
  const b = useSyncExternalStore(subscribe, () => baseline);
  loadBaseline(); // a no-op inside the hour
  return b;
}

// ---- floor --------------------------------------------------------------------

/**
 * The highest % shown per task, and when. It stands only while no worker run
 * of the task started after it: a new run is a new chain (a human follow-up,
 * Retry), while the fix rounds of one chain are typed into the live session.
 * localStorage, so a reload mid-chain does not drop the bar either.
 */
interface Floor {
  pct: number;
  at: string;
}
const FLOOR_KEY = 'tm.progress.floor';
const FLOOR_MAX_AGE_MS = 7 * 24 * 3600_000;
let floors: Record<string, Floor> | null = null;

function floorMap(): Record<string, Floor> {
  if (floors) return floors;
  floors = {};
  try {
    const raw = JSON.parse(localStorage.getItem(FLOOR_KEY) ?? '{}') as Record<string, Floor>;
    const cutoff = Date.now() - FLOOR_MAX_AGE_MS;
    for (const [id, f] of Object.entries(raw)) {
      if (f && typeof f.pct === 'number' && typeof f.at === 'string' && Date.parse(f.at) >= cutoff) floors[id] = f;
    }
  } catch {
    // private mode / corrupt value: memory only
  }
  return floors;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveFloors(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(FLOOR_KEY, JSON.stringify(floorMap()));
    } catch {
      // quota / private mode: memory only
    }
  }, 1000);
}

// ---- inputs -------------------------------------------------------------------

/** worker runs per task, indexed once per runs array (TaskRow renders hundreds) */
const runIndex = new WeakMap<Run[], Map<string, Run[]>>();
function workerRunsOf(runs: Run[], taskId: string): Run[] {
  let idx = runIndex.get(runs);
  if (!idx) {
    idx = new Map();
    for (const r of runs) {
      if (r.mode !== 'worker' || !r.taskId) continue;
      const list = idx.get(r.taskId);
      if (list) list.push(r);
      else idx.set(r.taskId, [r]);
    }
    runIndex.set(runs, idx);
  }
  return idx.get(taskId) ?? [];
}

/** statuses that can carry a % at all — everything else skips the work below */
const LIVE = new Set<Task['status']>(['running', 'waiting', 'review']);

export function computeProgress(
  task: Task,
  runs: Run[],
  activity: Record<string, RunActivity>,
  base: ProgressBaseline | null,
): TaskProgress | null {
  if (!LIVE.has(task.status)) {
    const m = floorMap();
    if (task.id in m) {
      delete m[task.id];
      saveFloors();
    }
    return null;
  }
  const worker = workerRunsOf(runs, task.id);
  let outputTokens = 0;
  let newestStart = 0;
  let live: Run | undefined;
  for (const r of worker) {
    outputTokens += r.stats?.outputTokens ?? 0;
    newestStart = Math.max(newestStart, Date.parse(r.startedAt) || 0);
    if (r.status === 'running' && !live) live = r;
  }
  const m = floorMap();
  const f = m[task.id];
  const floor = f && Date.parse(f.at) >= newestStart ? f.pct : null;
  const p = taskProgress(
    task,
    {
      outputTokens,
      todos: live ? (activity[live.id]?.todos ?? null) : null,
      publishing: !!live && live.label === 'publish' && !live.idle,
      floor,
    },
    base,
  );
  if (!p || p.band === 'done') {
    if (f) {
      delete m[task.id];
      saveFloors();
    }
  } else if (floor === null || p.pct > floor) {
    // stamped no earlier than the newest run, so a skewed phone clock cannot void it
    m[task.id] = { pct: p.pct, at: new Date(Math.max(Date.now(), newestStart)).toISOString() };
    saveFloors();
  }
  return p;
}

/** The row's % — the same reading for the bar and the text beside the badge. */
export function useTaskProgress(task: Task): TaskProgress | null {
  const { runs, activity } = useApp();
  const base = useProgressBaseline();
  return computeProgress(task, runs, activity, base);
}

/** "work · 54k of ~91k tokens (repo median)" + the overrun hint, for a title. */
export function progressTitle(p: TaskProgress): string {
  const head = `~${p.pct}% · ${p.detail}`;
  return p.overrun && !p.detail.includes('longer than usual') ? `${head} · longer than usual` : head;
}
