import type { Feature, Proposal, Run, Task } from '@tm/shared';
import type { Storage } from '../storage/types.ts';

// Short ids. Every entity in this system is a uuid, and nobody types 36
// characters on a phone — the board already shows the first 8 everywhere, so
// the bot accepts that prefix (and any other) wherever an id is expected.
//
// The rule is deliberately strict in two directions: a prefix shorter than
// MIN_SHORT is refused rather than resolved (three characters over a few
// hundred tasks is a coin flip), and a prefix matching MORE than one row is an
// error naming the candidates rather than a pick. Guessing here means running
// the wrong agent in the wrong repo.

/** Below this, a prefix is too likely to collide to be worth resolving. */
export const MIN_SHORT_ID = 4;
/** How many candidates an ambiguity error lists before it says "and N more". */
const MAX_CANDIDATES = 6;

export type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Identified {
  id: string;
}

/** What each candidate is called in an ambiguity message. */
type Label<T> = (item: T) => string;

const norm = (raw: string) => raw.trim().toLowerCase().replace(/^#/, '');

/**
 * Resolve `raw` against `items`. An exact id always wins outright — a full id
 * that happens to be a prefix of nothing else is not ambiguous, and neither is
 * one that (impossibly, but cheaply guarded) prefixes another.
 */
export function resolveIn<T extends Identified>(
  raw: string,
  items: T[],
  kind: string,
  label: Label<T>,
): Resolved<T> {
  const q = norm(raw);
  if (!q) return { ok: false, error: `which ${kind}? give me its id (the first ${MIN_SHORT_ID}+ characters is enough)` };
  const exact = items.find((i) => i.id.toLowerCase() === q);
  if (exact) return { ok: true, value: exact };
  if (q.length < MIN_SHORT_ID) {
    return { ok: false, error: `“${raw}” is too short — give me at least ${MIN_SHORT_ID} characters of the ${kind} id` };
  }
  const hits = items.filter((i) => i.id.toLowerCase().startsWith(q));
  if (hits.length === 1) return { ok: true, value: hits[0] };
  if (hits.length === 0) return { ok: false, error: `no ${kind} starts with “${raw}”` };
  const shown = hits.slice(0, MAX_CANDIDATES).map((i) => `${short(i.id)} — ${label(i)}`);
  const more = hits.length > shown.length ? `\n…and ${hits.length - shown.length} more` : '';
  return {
    ok: false,
    error: `“${raw}” matches ${hits.length} ${kind}s — type more of the id:\n${shown.join('\n')}${more}`,
  };
}

/** The 8-character form the board shows and every bot message prints. */
export function short(id: string): string {
  return id.slice(0, 8);
}

export async function resolveTask(storage: Storage, raw: string): Promise<Resolved<Task>> {
  return resolveIn(raw, await storage.listTasks(), 'task', (t) => t.title);
}

export async function resolveFeature(storage: Storage, raw: string): Promise<Resolved<Feature>> {
  return resolveIn(raw, await storage.listFeatures(), 'feature', (f) => f.title);
}

export async function resolveProposal(storage: Storage, raw: string): Promise<Resolved<Proposal>> {
  return resolveIn(raw, await storage.listProposals(), 'proposal', (p) => p.payload.title ?? p.kind);
}

/**
 * Runs resolve against the LIVE ones only. `/kill` is the sole run command and
 * a finished run cannot be killed, so matching a week of exited rows would
 * turn every short id into an ambiguity error for no reachable outcome.
 */
export async function resolveLiveRun(storage: Storage, raw: string): Promise<Resolved<Run>> {
  return resolveIn(raw, await storage.listRuns({ status: 'running' }), 'live run', (r) => `${r.mode} · ${short(r.taskId ?? '')}`);
}

/** Repos are picked by id prefix OR by name — nobody remembers a repo uuid. */
export async function resolveRepo(storage: Storage, raw: string) {
  const repos = await storage.listRepos();
  const q = norm(raw);
  const byName = repos.filter((r) => r.name.toLowerCase() === q);
  if (byName.length === 1) return { ok: true as const, value: byName[0] };
  if (byName.length > 1) {
    return { ok: false as const, error: `${byName.length} repos are called “${raw}” — use the id instead` };
  }
  return resolveIn(raw, repos, 'repo', (r) => r.name);
}
