import type { Task } from '@tm/shared';

/**
 * Find a task by its id, the rules of Telegram's `/task <id>`
 * (server/src/telegram/ids.ts) so a short id copied from the phone works here:
 * an exact id wins, otherwise a prefix of at least MIN_TASK_ID_PREFIX
 * characters that names exactly one task. Case and a leading `#` are ignored,
 * and so is the decoration an id is usually copied with — a commit's
 * `Task: <id>` trailer or the panel breadcrumb's trailing `…`.
 */
export const MIN_TASK_ID_PREFIX = 4;
/** candidates listed for an ambiguous prefix, as ids.ts MAX_CANDIDATES */
export const MAX_TASK_ID_CANDIDATES = 6;

export type TaskIdMatch =
  | { kind: 'empty' }
  | { kind: 'found'; task: Task }
  | { kind: 'too-short'; query: string }
  | { kind: 'none'; query: string }
  | { kind: 'ambiguous'; query: string; candidates: Task[]; more: number };

export function normalizeTaskId(raw: string): string {
  return raw
    .trim()
    .replace(/^task:\s*/i, '')
    .replace(/^#/, '')
    .replace(/(…|\.\.\.)$/, '')
    .trim()
    .toLowerCase();
}

export function findTaskById(tasks: readonly Task[], raw: string): TaskIdMatch {
  const query = normalizeTaskId(raw);
  if (!query) return { kind: 'empty' };
  const exact = tasks.find((t) => t.id.toLowerCase() === query);
  if (exact) return { kind: 'found', task: exact };
  if (query.length < MIN_TASK_ID_PREFIX) return { kind: 'too-short', query };
  const hits = tasks.filter((t) => t.id.toLowerCase().startsWith(query));
  if (hits.length === 0) return { kind: 'none', query };
  if (hits.length === 1) return { kind: 'found', task: hits[0] };
  // newest first: the task you just copied the id of is the likely one
  const sorted = [...hits].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    kind: 'ambiguous',
    query,
    candidates: sorted.slice(0, MAX_TASK_ID_CANDIDATES),
    more: Math.max(0, sorted.length - MAX_TASK_ID_CANDIDATES),
  };
}
