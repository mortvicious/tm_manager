// Timeline range API (docs/timeline.md): the audit rows and runs of a window,
// plus the past segments the shared fold builds from them. Read-only.
import type { FastifyInstance } from 'fastify';
import {
  buildTaskSegments,
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

export async function loadTaskHistory(storage: Storage, taskId: string, createdAt: string, now: string, cap = TIMELINE_ROW_CAP): Promise<TaskHistoryResponse> {
  const rows = await storage.listEvents({ kinds: [...TIMELINE_EVENT_KINDS], taskId, limit: cap + 1 });
  const since = rows.length && rows[rows.length - 1].at < createdAt ? rows[rows.length - 1].at : createdAt;
  const { events, truncated, coveredSince } = capEvents(rows, cap, since);
  const seeds = truncated ? await seedEvents(storage, [taskId], coveredSince) : [];
  const [own, about] = await Promise.all([storage.listRuns({ taskId }), storage.listRuns({ subjectId: taskId })]);
  const runs = [...own, ...about.filter((r) => r.mode === 'aux')].filter(timelineRun);
  const all = sortEvents([...seeds, ...events]);
  const segments = buildTaskSegments(all, runs, { since: coveredSince, until: now, now })[taskId] ?? [];
  return { events: all, runs, segments, truncated };
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

  app.get('/api/tasks/:id/history', async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await storage.getTask(id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    return loadTaskHistory(storage, id, task.createdAt, new Date().toISOString());
  });
}
