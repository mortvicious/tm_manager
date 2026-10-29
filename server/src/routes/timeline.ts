// Timeline range API (docs/timeline.md): the audit rows and runs of a window,
// plus the past segments the shared fold builds from them; and the schedule
// accuracy replay over them (§ Prediction accuracy). Read-only.
import type { FastifyInstance } from 'fastify';
import {
  ACCURACY_CONTROL_KINDS,
  ACCURACY_DEFAULT_DAYS,
  buildTaskSegments,
  HISTORY_EXTRA_EVENT_KINDS,
  replayClaimSteps,
  type ScheduleAccuracy,
  sortEvents,
  TIMELINE_EVENT_KINDS,
  TIMELINE_MAX_DAYS,
  TIMELINE_ROW_CAP,
  type AuditEvent,
  type AuditKind,
  type Run,
  type TaskHistoryResponse,
  type TimelineResponse,
} from '@tm/shared';
import { scheduleBaselineCached } from '../schedule-baseline.ts';
import { EVENT_LIST_MAX } from '../storage/event-sql.ts';
import type { Storage } from '../storage/types.ts';

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_MS = DAY_MS;
/** ids per seed query (bound parameters) */
const SEED_CHUNK = 500;

class BadRequest extends Error {}

/** the runs a timeline shows: worker turns, and the reviewer / compaction terminals about a task */
const timelineRun = (r: Run) => r.mode === 'worker' || r.kind === 'review' || r.kind === 'compact';

/**
 * Newest-first rows cut at `cap`: keep the newest `cap`, and say from when on
 * they are complete — the millisecond of the oldest kept row may be split by
 * the cut, so coverage starts one millisecond after it.
 */
function capEvents(rows: AuditEvent[], cap: number, since: string): { events: AuditEvent[]; truncated: boolean; coveredSince: string } {
  if (rows.length <= cap) return { events: rows, truncated: false, coveredSince: since };
  const kept = rows.slice(0, cap);
  const coveredSince = new Date(Date.parse(kept[kept.length - 1].at) + 1).toISOString();
  return { events: kept.filter((e) => e.at >= coveredSince), truncated: true, coveredSince };
}

/**
 * The rows that say what state a task entered the window in. `task.deleted`
 * is one too: a task deleted while queued/waiting/in review writes no
 * transition, and without it its last transition would keep it open in every
 * later window (review round 3).
 */
const SEED_ANCHOR_KINDS: AuditKind[] = ['task.transition', 'task.created', 'task.deleted'];

/**
 * The stint each task entered the covered window in: its last transition (or
 * its creation) before the window plus every timeline row after it. The
 * anchor alone would reopen a review round / checks stage whose verdict
 * settled before the window (review round 1).
 */
async function seedEvents(storage: Storage, taskIds: string[], before: string): Promise<AuditEvent[]> {
  const out: AuditEvent[] = [];
  for (let i = 0; i < taskIds.length; i += SEED_CHUNK) {
    out.push(...(await storage.taskSeedEvents(SEED_ANCHOR_KINDS, [...TIMELINE_EVENT_KINDS], taskIds.slice(i, i + SEED_CHUNK), before)));
  }
  return out;
}

/** the states that open a segment and stay open until the task's next transition */
const OPEN_STATES = new Set(['queued', 'running', 'waiting', 'review']);

/** an anchor row (a task's newest transition/creation before the window) that left the task in an open state */
function entersOpen(e: AuditEvent): boolean {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const state = e.kind === 'task.transition' ? d.to : d.status;
  return typeof state === 'string' && OPEN_STATES.has(state);
}

/**
 * Tasks that sat in ONE open state through the whole window — a review waiting
 * on the human for days, a long queue — have no row and no run inside it, so
 * the window's own rows never name them (review round 2).
 */
async function openBefore(storage: Storage, before: string, repoIds?: string[]): Promise<string[]> {
  return (await storage.taskAnchorsBefore(SEED_ANCHOR_KINDS, before, repoIds)).filter(entersOpen).map((e) => e.taskId!);
}

/** the in-window deletions of these tasks — fetched by task, because the `task.deleted` row carries no repo and a repo scope would drop it */
async function deletionsIn(storage: Storage, taskIds: string[], since: string, until: string): Promise<AuditEvent[]> {
  const out: AuditEvent[] = [];
  for (let i = 0; i < taskIds.length; i += SEED_CHUNK) {
    out.push(...(await storage.listEvents({ kind: 'task.deleted', taskIds: taskIds.slice(i, i + SEED_CHUNK), since, until, limit: SEED_CHUNK })));
  }
  return out;
}

const dedupe = (rows: AuditEvent[]) => [...new Map(rows.map((e) => [e.id, e])).values()];

export interface TimelineQuery {
  since: string;
  until: string;
  /** undefined = every repo; [] = nothing */
  repoIds?: string[];
  now: string;
  cap?: number;
}

export async function loadTimeline(storage: Storage, q: TimelineQuery): Promise<TimelineResponse> {
  const cap = q.cap ?? TIMELINE_ROW_CAP;
  const rows = await storage.listEvents({
    kinds: [...TIMELINE_EVENT_KINDS],
    since: q.since,
    until: q.until,
    repoIds: q.repoIds,
    limit: cap + 1,
  });
  const { events, truncated: eventsCut, coveredSince } = capEvents(rows, cap, q.since);
  const allRuns = (await storage.listRuns({ until: q.until, activeSince: coveredSince, repoIds: q.repoIds, limit: cap + 1 })).filter(timelineRun);
  const runsCut = allRuns.length > cap;
  const runs = runsCut ? allRuns.slice(0, cap) : allRuns;

  const taskIds = new Set<string>();
  for (const e of events) if (e.taskId) taskIds.add(e.taskId);
  for (const r of runs) {
    const id = r.mode === 'worker' ? r.taskId : r.subjectId;
    if (id) taskIds.add(id);
  }
  for (const id of await openBefore(storage, coveredSince, q.repoIds)) taskIds.add(id);
  const seeds = await seedEvents(storage, [...taskIds], coveredSince);
  const all = sortEvents(dedupe([...seeds, ...events, ...(await deletionsIn(storage, [...taskIds], coveredSince, q.until))]));
  return {
    events: all,
    runs,
    segments: buildTaskSegments(all, runs, { since: coveredSince, until: q.until, now: q.now }),
    since: q.since,
    until: q.until,
    truncated: eventsCut || runsCut,
    coveredSince,
  };
}

/**
 * One task's whole life (docs/timeline.md § API, § Task history). The fold's
 * rows are fetched, capped and seeded exactly as before, so `segments` is the
 * timeline's own answer; the History strip's extra kinds are a second query
 * over the same covered span, under the same cap, merged into `events`.
 */
export async function loadTaskHistory(storage: Storage, taskId: string, createdAt: string, now: string, cap = TIMELINE_ROW_CAP): Promise<TaskHistoryResponse> {
  const rows = await storage.listEvents({ kinds: [...TIMELINE_EVENT_KINDS], taskId, limit: cap + 1 });
  const since = rows.length && rows[rows.length - 1].at < createdAt ? rows[rows.length - 1].at : createdAt;
  const { events, truncated, coveredSince } = capEvents(rows, cap, since);
  const seeds = truncated ? await seedEvents(storage, [taskId], coveredSince) : [];
  const extraRows = await storage.listEvents({
    kinds: [...HISTORY_EXTRA_EVENT_KINDS],
    taskId,
    ...(truncated ? { since: coveredSince } : {}),
    limit: cap + 1,
  });
  const extra = capEvents(extraRows, cap, coveredSince);
  const [own, about, dispatches] = await Promise.all([
    storage.listRuns({ taskId }),
    storage.listRuns({ subjectId: taskId }),
    storage.listDispatches({ taskId }),
  ]);
  const runs = [...own, ...about.filter((r) => r.mode === 'aux')].filter(timelineRun);
  const folded = sortEvents([...seeds, ...events]);
  const segments = buildTaskSegments(folded, runs, { since: coveredSince, until: now, now })[taskId] ?? [];
  return {
    events: sortEvents(dedupe([...folded, ...extra.events])),
    runs,
    segments,
    dispatches: [...dispatches].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)),
    truncated: truncated || extra.truncated,
  };
}

/** a replay result is reused this long per `days` (the log it grades moves by minutes, not by renders) */
const ACCURACY_TTL_MS = 10 * 60_000;
const accuracyCache = new Map<number, { at: number; value: ScheduleAccuracy }>();
const accuracyInFlight = new Map<number, Promise<ScheduleAccuracy>>();

/**
 * `loadAccuracy` cached per `days` for ACCURACY_TTL_MS with one in-flight
 * computation shared by every caller: an uncached replay is seconds of CPU in
 * the API process, so a polling page or a worker's curl must not repeat it.
 */
export function accuracyCached(storage: Storage, days: number, nowMs = Date.now()): Promise<ScheduleAccuracy> {
  const hit = accuracyCache.get(days);
  if (hit && nowMs - hit.at < ACCURACY_TTL_MS) return Promise.resolve(hit.value);
  const pending = accuracyInFlight.get(days);
  if (pending) return pending;
  const p = loadAccuracy(storage, days, nowMs)
    .then((value) => {
      accuracyCache.set(days, { at: nowMs, value });
      return value;
    })
    .finally(() => accuracyInFlight.delete(days));
  accuracyInFlight.set(days, p);
  return p;
}

/** for tests: forget cached replays */
export function resetAccuracyCache() {
  accuracyCache.clear();
}

/** hand the event loop back (a macrotask, so I/O and timers run — a resolved `await` does not) */
const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** run a generator to its return value, yielding the event loop between steps */
async function drainYielding<T>(it: Generator<void, T, void>): Promise<T> {
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    await yieldLoop();
  }
}

/**
 * The schedule accuracy replay over the last `days` (docs/timeline.md §
 * Prediction accuracy): the window's timeline rows (seeds included), the
 * queue/undo/pause/toggle/feature/push-health rows of all time (they are few,
 * and a membership or a switch may predate the window), every worker run (an
 * overflow credit names its creator's run), the current rows and baseline.
 */
export async function loadAccuracy(storage: Storage, days: number, nowMs = Date.now()): Promise<ScheduleAccuracy> {
  const now = new Date(nowMs).toISOString();
  const since = new Date(nowMs - days * DAY_MS).toISOString();
  // One load per macrotask: the SQLite driver answers synchronously, so loads
  // chained by `await` (or a Promise.all) would hold the event loop for their sum.
  const tl = await loadTimeline(storage, { since, until: now, now });
  await yieldLoop();
  const control = await storage.listEvents({ kinds: [...ACCURACY_CONTROL_KINDS], until: now, limit: EVENT_LIST_MAX });
  await yieldLoop();
  const tasks = await storage.listTasks();
  await yieldLoop();
  const [repos, features, settings] = await Promise.all([storage.listRepos(), storage.listFeatures(), storage.getSettings()]);
  await yieldLoop();
  const workerRuns = await storage.listRuns({ mode: 'worker' });
  await yieldLoop();
  const baseline = await scheduleBaselineCached(storage, nowMs);
  await yieldLoop();
  // worked time reads each run's first idle: stats-finals back to the oldest run of a task that may have landed in the window
  const maybeLanded = new Set(tasks.filter((t) => (t.status === 'done' || t.status === 'published') && t.updatedAt >= since).map((t) => t.id));
  const oldest = workerRuns.reduce((m, r) => (r.taskId && maybeLanded.has(r.taskId) && r.startedAt < m ? r.startedAt : m), since);
  const statsFinals = await storage.listEvents({ kind: 'run.stats-final', since: oldest, until: now, limit: EVENT_LIST_MAX });
  await yieldLoop();
  const runs = [...new Map([...tl.runs, ...workerRuns].map((r) => [r.id, r])).values()];
  // stepwise: one predictSchedule per claim, the event loop handed back between them
  return drainYielding(replayClaimSteps({
    tasks,
    repos,
    features,
    settings,
    events: [...tl.events, ...control, ...statsFinals],
    runs,
    baseline,
    since,
    until: now,
    truncated: tl.truncated,
  }));
}

function isoParam(v: unknown, name: string): string | undefined {
  if (v === undefined || v === '') return undefined;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (Number.isNaN(t)) throw new BadRequest(`${name} must be an ISO timestamp`);
  return new Date(t).toISOString();
}

/** `?since&until&repoIds` → a checked window (default: the last 24 h) */
export function parseTimelineQuery(raw: Record<string, unknown>, nowMs = Date.now()): TimelineQuery {
  const now = new Date(nowMs).toISOString();
  const until = isoParam(raw.until, 'until') ?? now;
  const since = isoParam(raw.since, 'since') ?? new Date(Date.parse(until) - DEFAULT_WINDOW_MS).toISOString();
  if (since >= until) throw new BadRequest('since must be before until');
  if (Date.parse(until) - Date.parse(since) > TIMELINE_MAX_DAYS * DAY_MS) {
    throw new BadRequest(`window is longer than ${TIMELINE_MAX_DAYS} days`);
  }
  let repoIds: string[] | undefined;
  if (raw.repoIds !== undefined) {
    if (typeof raw.repoIds !== 'string') throw new BadRequest('repoIds must be a comma-separated list');
    // present but empty = an empty scope, which matches nothing
    repoIds = raw.repoIds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return { since, until, repoIds, now };
}

export function registerTimelineRoutes(app: FastifyInstance, storage: Storage) {
  app.get('/api/timeline', async (req, reply) => {
    let q: TimelineQuery;
    try {
      q = parseTimelineQuery(req.query as Record<string, unknown>);
    } catch (e) {
      if (e instanceof BadRequest) return reply.code(400).send({ error: e.message });
      throw e;
    }
    return loadTimeline(storage, q);
  });

  app.get('/api/schedule/accuracy', async (req, reply) => {
    const raw = (req.query as Record<string, unknown>).days;
    const days = raw === undefined || raw === '' ? ACCURACY_DEFAULT_DAYS : Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > TIMELINE_MAX_DAYS) {
      return reply.code(400).send({ error: `days must be an integer from 1 to ${TIMELINE_MAX_DAYS}` });
    }
    return accuracyCached(storage, days);
  });

  app.get('/api/tasks/:id/history', async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await storage.getTask(id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    return loadTaskHistory(storage, id, task.createdAt, new Date().toISOString());
  });
}
