import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  Repo,
  SharedNote,
  SharedNoteKind,
  SharedNoteStatus,
  Space,
  SpaceFile,
  Task,
} from '@tm/shared';
import type { ActionResult, OrchestratorApi } from '../app-types.ts';
import { broadcast } from '../events.ts';
import type { SharedNotePatch, Storage } from '../storage/types.ts';
import { queueAddTask } from '../task-actions.ts';

// Shared spaces (docs/shared-spaces.md). A space is a set of repos that work
// on one product: one knowledge FOLDER on disk (outside every repo, so no
// agent ever commits it into the wrong history) and one LEDGER of cross-repo
// requests/notes in tm_shared_notes. Every worker in a member repo gets the
// folder as $TM_SHARED_DIR and, at the start of a turn, the open requests
// addressed to its repo — which is what stops "nest fixed it and wrote a
// report nobody reads" from being the end of the story.
//
// Called in-process by the SPA routes ('human'), the agent API
// ('agent:<run8>') and the Telegram command — never a second copy.

export interface SpaceDeps {
  storage: Storage;
  orchestrator?: OrchestratorApi;
}

export const NOTE_TITLE_MAX = 200;
export const NOTE_BODY_MAX = 20_000;
export const NOTE_FILES_MAX = 20;
/** Requests listed in a worker prompt; the rest are counted and one GET away. */
export const PROMPT_REQUEST_LIMIT = 10;
/** Files the Shared page lists before it stops walking. */
const FILE_LIST_CAP = 2000;
/** Largest file the Shared page will show. */
export const FILE_VIEW_MAX = 5 * 1024 * 1024;

const ACTIVE_REQUEST: SharedNoteStatus[] = ['open', 'filed'];
const err = (code: number, error: string) => ({ code, error });

// ---------------------------------------------------------------------------
// Paths

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * The folder must be a real, dedicated directory OUTSIDE every registered
 * repo — inside one it would be committed into that repo's history (and be
 * invisible to the others' git), and a folder that CONTAINS a repo would hand
 * agents a write-scope over whole working trees via `--add-dir`.
 */
export function validateSpacePath(raw: string, repos: Repo[]): { path: string } | { error: string } {
  const t = raw.trim();
  // `~user/…` is not expanded — only the caller's own home.
  if (!path.isAbsolute(t) && t !== '~' && !t.startsWith('~/')) {
    return { error: 'path must be absolute (or start with ~/)' };
  }
  const p = path.resolve(expandHome(t));
  // Compare real paths, so a symlink cannot smuggle the folder into (or
  // around) a repo. A folder that does not exist yet resolves through its
  // deepest existing ancestor — `link-to-repo/new/dir` is still inside.
  const real = (x: string): string => {
    let head = x;
    const tail: string[] = [];
    for (;;) {
      try {
        return path.join(fs.realpathSync(head), ...tail);
      } catch {
        const up = path.dirname(head);
        if (up === head) return x;
        tail.unshift(path.basename(head));
        head = up;
      }
    }
  };
  const rp0 = real(p);
  if (p === path.parse(p).root || rp0 === path.parse(rp0).root || p === os.homedir() || rp0 === real(os.homedir())) {
    return { error: 'pick a dedicated folder, not / or your home' };
  }
  for (const r of repos) {
    for (const rp of new Set([path.resolve(r.path), real(r.path)])) {
      for (const sp of new Set([p, rp0])) {
        if (inside(sp, rp)) return { error: `the folder is inside repo "${r.name}" — pick one outside every repo` };
        if (inside(rp, sp)) return { error: `the folder contains repo "${r.name}" — pick a dedicated folder` };
      }
    }
  }
  return { path: p };
}

/**
 * The "outside every repo" rule from the other side: a repo registered (or
 * moved) later must not land inside a space folder or contain one, or
 * `--add-dir` would hand one repo's agent another checkout. Returns the
 * refusal, or null. `sharedContext` re-checks at every spawn as well, for a
 * folder that became a problem some other way (a symlink, a moved checkout).
 */
export async function spaceConflictForRepo(storage: Storage, repo: { name: string; path: string }): Promise<string | null> {
  for (const s of await storage.listSpaces()) {
    const v = validateSpacePath(s.path, [repo as Repo]);
    if ('error' in v) return `shared space "${s.name}" (${s.path}): ${v.error.replace(/^the folder/, 'its folder')}`;
  }
  return null;
}

/**
 * A relative path inside the space folder, normalised to `/`, or null when it
 * would escape (absolute, `..`, NUL). Used for note `files` and file reads.
 */
export function safeRelative(rel: string): string | null {
  if (typeof rel !== 'string' || rel.includes('\0')) return null;
  const clean = rel.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!clean || clean.startsWith('/') || /^[A-Za-z]:/.test(clean)) return null;
  const norm = path.posix.normalize(clean);
  if (norm === '..' || norm.startsWith('../') || norm === '.') return null;
  return norm;
}

/** Resolve a relative path to a REAL file inside the folder (symlinks resolved on both sides). */
export function resolveSpaceFile(space: Space, rel: string): string | null {
  const safe = safeRelative(rel);
  if (!safe) return null;
  try {
    const root = fs.realpathSync(space.path);
    const real = fs.realpathSync(path.join(root, safe));
    if (!inside(real, root)) return null;
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

export function listSpaceFiles(space: Space): { files: SpaceFile[]; truncated: boolean } {
  const files: SpaceFile[] = [];
  let truncated = false;
  let root: string;
  try {
    root = fs.realpathSync(space.path);
  } catch {
    return { files, truncated };
  }
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '.DS_Store') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, depth + 1);
      else if (e.isFile()) {
        if (files.length >= FILE_LIST_CAP) {
          truncated = true;
          return;
        }
        try {
          const st = fs.statSync(abs);
          files.push({ path: path.relative(root, abs).split(path.sep).join('/'), size: st.size, mtime: st.mtime.toISOString() });
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  };
  walk(root, 0);
  return { files, truncated };
}

// ---------------------------------------------------------------------------
// Spaces

async function memberRepos(storage: Storage, space: Space): Promise<Repo[]> {
  const all = await storage.listRepos();
  // A deleted repo leaves its id in `repo_ids` (FK-less); it simply stops being a member.
  return space.repoIds.map((id) => all.find((r) => r.id === id)).filter((r): r is Repo => !!r);
}

/** The ONE space a repo belongs to, or null. */
export async function spaceForRepo(storage: Storage, repoId: string | null | undefined): Promise<Space | null> {
  if (!repoId) return null;
  const spaces = await storage.listSpaces();
  return spaces.find((s) => s.repoIds.includes(repoId)) ?? null;
}

/** Existence + the one-space-per-repo rule (a worker gets exactly one $TM_SHARED_DIR). */
async function checkMembers(storage: Storage, repoIds: string[], selfId: string | null): Promise<string | null> {
  if (repoIds.length === 0) return 'pick at least one repo';
  const repos = await storage.listRepos();
  for (const id of repoIds) if (!repos.some((r) => r.id === id)) return `unknown repo ${id}`;
  for (const s of await storage.listSpaces()) {
    if (s.id === selfId) continue;
    const clash = s.repoIds.find((id) => repoIds.includes(id));
    if (clash) {
      const name = repos.find((r) => r.id === clash)?.name ?? clash;
      return `repo "${name}" already belongs to space "${s.name}" — a repo can be in one space`;
    }
  }
  return null;
}

export async function createSpace(
  deps: SpaceDeps,
  input: { name: string; path: string; repoIds: string[] },
  actor: string,
): Promise<{ space: Space; imported: number; importError?: string } | { code: number; error: string }> {
  const { storage } = deps;
  const repoIds = [...new Set(input.repoIds)];
  const bad = await checkMembers(storage, repoIds, null);
  if (bad) return err(409, bad);
  const v = validateSpacePath(input.path, await storage.listRepos());
  if ('error' in v) return err(400, v.error);
  try {
    fs.mkdirSync(v.path, { recursive: true });
  } catch (e) {
    return err(400, `cannot create ${v.path}: ${(e as Error).message}`);
  }
  const space = await storage.createSpace({ name: input.name.trim(), path: v.path, repoIds });
  await storage.appendEvent({ kind: 'space.changed', actor, data: { action: 'created', spaceId: space.id, path: space.path, repoIds } });
  broadcast({ type: 'space.updated', space });
  // A seed file left in the folder (the consolidation of what came before)
  // lands in the ledger with the space itself.
  const imp = await importSeed(deps, space, 'import');
  await writeFolderDocs(storage, space);
  return { space, imported: imp.imported, ...(imp.error ? { importError: imp.error } : {}) };
}

export async function updateSpace(
  deps: SpaceDeps,
  id: string,
  patch: { name?: string; path?: string; repoIds?: string[] },
  actor: string,
): Promise<{ space: Space } | { code: number; error: string }> {
  const { storage } = deps;
  const cur = await storage.getSpace(id);
  if (!cur) return err(404, 'space not found');
  const next: { name?: string; path?: string; repoIds?: string[] } = {};
  if (patch.name !== undefined) next.name = patch.name.trim();
  if (patch.repoIds !== undefined) {
    next.repoIds = [...new Set(patch.repoIds)];
    const bad = await checkMembers(storage, next.repoIds, id);
    if (bad) return err(409, bad);
  }
  if (patch.path !== undefined) {
    const v = validateSpacePath(patch.path, await storage.listRepos());
    if ('error' in v) return err(400, v.error);
    // A path change REPOINTS the space; it never moves files. Refuse one that
    // would strand the knowledge (INDEX.md, knowledge/, archive/…) in the old
    // folder while agents are pointed at an empty new one — move it first.
    const left = v.path === cur.path ? [] : userContent(cur.path);
    if (left.length && userContent(v.path).length === 0) {
      return err(
        409,
        `${cur.path} still holds ${left.slice(0, 4).join(', ')}${left.length > 4 ? ', …' : ''} — move the folder to ${v.path} first (mv), then change the path`,
      );
    }
    try {
      fs.mkdirSync(v.path, { recursive: true });
    } catch (e) {
      return err(400, `cannot create ${v.path}: ${(e as Error).message}`);
    }
    next.path = v.path;
  }
  const space = await storage.updateSpace(id, next);
  if (!space) return err(404, 'space not found');
  await storage.appendEvent({ kind: 'space.changed', actor, data: { action: 'edited', spaceId: id, fields: Object.keys(next) } });
  broadcast({ type: 'space.updated', space });
  await writeFolderDocs(storage, space);
  return { space };
}

/** Top-level entries of a space folder other than the files this server generates. */
function userContent(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((e) => !['README.md', 'REQUESTS.md', 'CLAUDE.md', '.tm', '.DS_Store'].includes(e));
  } catch {
    return [];
  }
}

/** The ledger goes with the row; the FOLDER stays — it is the user's knowledge, not ours to delete. */
export async function deleteSpace(deps: SpaceDeps, id: string, actor: string): Promise<boolean> {
  const { storage } = deps;
  const cur = await storage.getSpace(id);
  if (!cur) return false;
  const ok = await storage.deleteSpace(id);
  if (ok) {
    await storage.appendEvent({ kind: 'space.changed', actor, data: { action: 'deleted', spaceId: id, path: cur.path } });
    broadcast({ type: 'space.deleted', spaceId: id });
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Notes

export interface NoteInput {
  kind: SharedNoteKind;
  title: string;
  body: string;
  toRepoId: string | null;
  files?: string[];
}

function cleanFiles(files: string[] | undefined): string[] | { error: string } {
  const out: string[] = [];
  for (const f of files ?? []) {
    const s = safeRelative(f);
    if (!s) return { error: `file "${f}" must be a path relative to the space folder` };
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > NOTE_FILES_MAX) return { error: `at most ${NOTE_FILES_MAX} files per note` };
  return out;
}

export async function createNote(
  deps: SpaceDeps,
  space: Space,
  input: NoteInput,
  author: { actor: string; fromRepoId: string | null; fromTaskId: string | null },
): Promise<{ note: SharedNote } | { code: number; error: string }> {
  const { storage } = deps;
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title) return err(400, 'title is required');
  if (title.length > NOTE_TITLE_MAX) return err(400, `title is longer than ${NOTE_TITLE_MAX} characters`);
  if (body.length > NOTE_BODY_MAX) return err(400, `body is longer than ${NOTE_BODY_MAX} characters`);
  if (input.toRepoId !== null && !space.repoIds.includes(input.toRepoId)) {
    return err(400, 'the addressed repo is not a member of this space');
  }
  if (input.kind === 'request') {
    if (!input.toRepoId) return err(400, 'a request needs the repo that must act (to)');
    if (!body) return err(400, 'a request needs a body — the contract the other repo will act on');
    if (author.fromRepoId && input.toRepoId === author.fromRepoId) {
      return err(400, 'a request to your own repo is a task, not a shared request — file a task instead');
    }
    // An agent re-discovering the same gap must not open it twice.
    const dup = (await storage.listSharedNotes({ spaceId: space.id, kind: 'request', status: ACTIVE_REQUEST, toRepoId: input.toRepoId }))
      .find((n) => n.title.trim().toLowerCase() === title.toLowerCase());
    if (dup) return err(409, `an identical request is already ${dup.status} (id ${dup.id}) — add to it instead of opening another`);
  }
  const files = cleanFiles(input.files);
  if ('error' in files) return err(400, files.error);
  const note = await storage.createSharedNote({
    spaceId: space.id,
    kind: input.kind,
    title,
    body,
    fromRepoId: author.fromRepoId,
    fromTaskId: author.fromTaskId,
    toRepoId: input.toRepoId,
    files,
    actor: author.actor,
  });
  await storage.appendEvent({
    kind: 'shared-note.changed',
    actor: author.actor,
    taskId: author.fromTaskId,
    repoId: author.fromRepoId,
    data: { action: 'created', noteId: note.id, spaceId: space.id, kind: note.kind, to: note.toRepoId, title },
  });
  broadcast({ type: 'shared-note.updated', note });
  await writeRequestsMirror(storage, space);
  return { note };
}

export async function patchNote(
  deps: SpaceDeps,
  id: string,
  patch: SharedNotePatch,
  actor: string,
  opts: { fromStatus?: SharedNoteStatus[]; audit?: Record<string, unknown> } = {},
): Promise<{ note: SharedNote } | { code: number; error: string }> {
  const { storage } = deps;
  const cur = await storage.getSharedNote(id);
  if (!cur) return err(404, 'note not found');
  const space = await storage.getSpace(cur.spaceId);
  if (!space) return err(404, 'space not found');
  const clean: SharedNotePatch = { ...patch };
  if (clean.title !== undefined) {
    clean.title = clean.title.trim();
    if (!clean.title || clean.title.length > NOTE_TITLE_MAX) return err(400, `title must be 1..${NOTE_TITLE_MAX} characters`);
  }
  if (clean.body !== undefined && clean.body.length > NOTE_BODY_MAX) return err(400, `body is longer than ${NOTE_BODY_MAX} characters`);
  if (clean.toRepoId !== undefined && clean.toRepoId !== null && !space.repoIds.includes(clean.toRepoId)) {
    return err(400, 'the addressed repo is not a member of this space');
  }
  if (cur.kind === 'request' && clean.toRepoId === null) return err(400, 'a request needs the repo that must act');
  if (clean.files !== undefined) {
    const f = cleanFiles(clean.files);
    if ('error' in f) return err(400, f.error);
    clean.files = f;
  }
  if (clean.status === 'open' && clean.taskId === undefined) clean.taskId = null;
  const note = await storage.updateSharedNote(id, clean, opts.fromStatus);
  if (!note) return err(409, `note is ${cur.status} — reload and try again`);
  await storage.appendEvent({
    kind: 'shared-note.changed',
    actor,
    repoId: note.toRepoId,
    data: { action: 'edited', noteId: id, fields: Object.keys(clean), from: cur.status, to: note.status, ...(opts.audit ?? {}) },
  });
  broadcast({ type: 'shared-note.updated', note });
  await writeRequestsMirror(storage, space);
  return { note };
}

export async function deleteNote(deps: SpaceDeps, id: string, actor: string): Promise<boolean> {
  const { storage } = deps;
  const cur = await storage.getSharedNote(id);
  if (!cur) return false;
  const ok = await storage.deleteSharedNote(id);
  if (ok) {
    await storage.appendEvent({ kind: 'shared-note.changed', actor, data: { action: 'deleted', noteId: id, title: cur.title } });
    broadcast({ type: 'shared-note.deleted', noteId: id });
    const space = await storage.getSpace(cur.spaceId);
    if (space) await writeRequestsMirror(storage, space);
  }
  return ok;
}

/**
 * `filed` is a claim on a task, and the task is the truth: once it lands
 * done/published the request is done; cancelled or deleted, it reopens (the
 * work was never delivered). Read-time, so there is no hook in the task
 * lifecycle to forget — every list goes through here.
 */
export async function reconcileFiled(deps: SpaceDeps, notes: SharedNote[]): Promise<SharedNote[]> {
  const out: SharedNote[] = [];
  for (const n of notes) {
    if (n.status !== 'filed' || !n.taskId) {
      out.push(n);
      continue;
    }
    const task = await deps.storage.getTask(n.taskId);
    let patch: SharedNotePatch | null = null;
    if (!task) patch = { status: 'open', taskId: null, resolution: `task ${n.taskId.slice(0, 8)} was deleted — reopened` };
    else if (task.status === 'cancelled') {
      patch = { status: 'open', taskId: null, resolution: `task ${task.id.slice(0, 8)} was cancelled — reopened` };
    } else if (task.status === 'done' || task.status === 'published') {
      patch = { status: 'done', resolution: n.resolution ?? `task ${task.id.slice(0, 8)} landed ${task.status}` };
    }
    if (!patch) {
      out.push(n);
      continue;
    }
    const r = await patchNote(deps, n.id, patch, 'system', { fromStatus: ['filed'], audit: { reconciled: true } });
    out.push('note' in r ? r.note : n);
  }
  return out;
}

export async function listNotes(
  deps: SpaceDeps,
  f: Parameters<Storage['listSharedNotes']>[0],
): Promise<SharedNote[]> {
  return reconcileFiled(deps, await deps.storage.listSharedNotes(f));
}

/**
 * File a task for a request in the repo it is addressed to. Single-winner:
 * the open → filed claim is a conditional write, so two agents triaging the
 * same request at once cannot both file it. `placement: 'queue'` puts the task
 * in the CUSTOM queue (docs/queue.md) — strictly serial, independent of the
 * global switch, and an agent-filed member never starts while its filer is
 * unresolved (running/waiting/review/blocked/failed) or while any task in the
 * repo is working or mid-review (storage/queue-sql.ts). That hold is the only
 * reason a same-repo follow-up may skip the draft rule.
 */
export async function fileRequest(
  deps: SpaceDeps,
  noteId: string,
  opts: {
    actor: string;
    placement: 'queue' | 'draft';
    title?: string;
    description?: string;
    category?: string | null;
    createdByRun?: string | null;
    spawnDepth?: number;
    /** why the requested placement was downgraded (set by the caller's policy) */
    placementNote?: string | null;
  },
): Promise<{ note: SharedNote; task: Task; placement: 'queue' | 'draft'; placementNote: string | null } | { code: number; error: string }> {
  const { storage } = deps;
  const cur = await storage.getSharedNote(noteId);
  if (!cur) return err(404, 'request not found');
  if (cur.kind !== 'request') return err(400, 'only requests can be filed — a note is knowledge, not work');
  if (cur.status !== 'open') {
    return err(409, cur.taskId ? `already ${cur.status} as task ${cur.taskId}` : `request is ${cur.status}`);
  }
  if (!cur.toRepoId || !(await storage.getRepo(cur.toRepoId))) return err(409, 'the addressed repo no longer exists');
  const space = await storage.getSpace(cur.spaceId);
  if (!space) return err(404, 'space not found');

  const claimed = await storage.updateSharedNote(noteId, { status: 'filed' }, ['open']);
  if (!claimed) return err(409, 'someone filed or resolved it a moment ago — reload');

  let task: Task;
  try {
    task = await storage.createTask(
      {
        title: (opts.title ?? cur.title).trim().slice(0, 300),
        description: opts.description?.trim() || (await filedDescription(storage, space, cur)),
        repoId: cur.toRepoId,
        status: 'draft',
        source: 'auto',
        category: opts.category ?? null,
        createdByRun: opts.createdByRun ?? null,
        spawnDepth: opts.spawnDepth ?? 0,
      },
      opts.actor,
    );
  } catch (e) {
    await storage.updateSharedNote(noteId, { status: 'open' }, ['filed']);
    throw e;
  }
  broadcast({ type: 'task.updated', task });

  let placement: 'queue' | 'draft' = opts.placement;
  let placementNote = opts.placementNote ?? null;
  if (placement === 'queue') {
    const q: ActionResult = await queueAddTask(deps, task.id, opts.actor);
    if ('task' in q && q.task) task = q.task;
    else {
      placement = 'draft';
      placementNote = `could not join the custom queue (${'error' in q ? q.error : 'unknown'}) — left as draft`;
    }
  }

  const linked = await patchNote(deps, noteId, { taskId: task.id }, opts.actor, {
    audit: { action: 'filed', taskId: task.id, placement, placementNote },
  });
  const note = 'note' in linked ? linked.note : { ...claimed, taskId: task.id };
  return { note, task, placement, placementNote };
}

async function filedDescription(storage: Storage, space: Space, n: SharedNote): Promise<string> {
  const from = n.fromRepoId ? (await storage.getRepo(n.fromRepoId))?.name ?? 'another repo' : 'a human';
  return [
    n.body,
    '',
    '---',
    `Filed from shared request ${n.id} (space "${space.name}", written by ${from} on ${n.createdAt.slice(0, 10)}${
      n.fromTaskId ? `, task ${n.fromTaskId}` : ''
    }). The shared knowledge folder is $TM_SHARED_DIR (${space.path}).`,
    ...(n.files.length ? [`Files it refers to (relative to that folder): ${n.files.join(', ')}.`] : []),
    'First check whether this is already done here; the request resolves by itself when this task lands done/published.',
    `If it turns out to be already done or not needed, resolve it instead: POST $TM_CALLBACK_URL/api/agent/shared/notes/${n.id}/resolve {"status":"done"|"dismissed","resolution":"<evidence>"}.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Seed import

interface SeedItem {
  kind?: unknown;
  from?: unknown;
  to?: unknown;
  title?: unknown;
  body?: unknown;
  files?: unknown;
  sourceTaskIds?: unknown;
}

/**
 * `<folder>/.tm/import.json` → ledger rows, then the file is renamed so it
 * imports exactly once. Repos are matched by id, exact name or role within the
 * space; an item that does not resolve is skipped and counted, never guessed.
 */
export async function importSeed(
  deps: SpaceDeps,
  space: Space,
  actor: string,
): Promise<{ imported: number; skipped: number; error?: string }> {
  const file = path.join(space.path, '.tm', 'import.json');
  if (!fs.existsSync(file)) return { imported: 0, skipped: 0 };
  let items: SeedItem[];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    items = Array.isArray(raw?.items) ? raw.items : [];
  } catch (e) {
    return { imported: 0, skipped: 0, error: `.tm/import.json is not valid JSON: ${(e as Error).message}` };
  }
  const members = await memberRepos(deps.storage, space);
  const find = (v: unknown): Repo | null => {
    if (typeof v !== 'string' || !v) return null;
    const needle = v.toLowerCase();
    return (
      members.find((r) => r.id === v) ??
      members.find((r) => r.name.toLowerCase() === needle) ??
      (members.filter((r) => (r.role ?? '').toLowerCase() === needle).length === 1
        ? members.find((r) => (r.role ?? '').toLowerCase() === needle)!
        : null)
    );
  };
  let imported = 0;
  let skipped = 0;
  for (const it of items) {
    const kind = it.kind === 'request' || it.kind === 'note' ? it.kind : null;
    const from = find(it.from);
    const to = it.to == null ? null : find(it.to);
    if (!kind || typeof it.title !== 'string' || (it.to != null && !to)) {
      skipped++;
      continue;
    }
    const sources = Array.isArray(it.sourceTaskIds) ? it.sourceTaskIds.filter((s): s is string => typeof s === 'string') : [];
    const body = [typeof it.body === 'string' ? it.body : '', sources.length ? `\n\nSource tasks: ${sources.join(', ')}` : '']
      .join('')
      .slice(0, NOTE_BODY_MAX);
    const r = await createNote(
      deps,
      space,
      {
        kind,
        title: it.title.slice(0, NOTE_TITLE_MAX),
        body,
        toRepoId: to?.id ?? null,
        files: Array.isArray(it.files) ? it.files.filter((f): f is string => typeof f === 'string' && !!safeRelative(f)) : [],
      },
      { actor, fromRepoId: from?.id ?? null, fromTaskId: null },
    );
    if ('note' in r) imported++;
    else skipped++;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.renameSync(file, path.join(space.path, '.tm', `import.imported-${stamp}.json`));
  } catch (e) {
    return { imported, skipped, error: `imported, but could not rename import.json: ${(e as Error).message}` };
  }
  await deps.storage.appendEvent({ kind: 'space.changed', actor, data: { action: 'imported', spaceId: space.id, imported, skipped } });
  return { imported, skipped };
}

// ---------------------------------------------------------------------------
// The folder's two generated files

/**
 * README.md is OURS and rewritten on every space change (it names the member
 * repos and the API, which must not drift); INDEX.md and everything else are
 * the humans' and agents'. REQUESTS.md mirrors the ledger so the folder is
 * complete on its own — for a human in Finder and for an agent without curl.
 */
/** First line of the generated CLAUDE.md; without it the file is the user's and is left alone. */
const MEMORY_MARKER = '<!-- tm:shared-memory — generated by the Task Manager';
/** How much of INDEX.md is copied into CLAUDE.md (memory is loaded on every session start). */
export const MEMORY_INDEX_MAX = 16_000;

/**
 * The folder's CLAUDE.md: what makes a worker SEE the shared knowledge instead
 * of being told where it is. Workers run with
 * `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` and `--add-dir=<folder>`, so
 * the CLI loads this file as memory (measured on CLI 2.1.280: loaded in an
 * interactive PTY under the workers' permission mode, no dialog). `@` imports
 * inside an add-dir CLAUDE.md are NOT followed (measured too), so INDEX.md is
 * copied in rather than imported, and the copy is refreshed at every spawn
 * (`sharedContext`), since agents edit INDEX.md between turns. Written only
 * when the content changed; a CLAUDE.md without our marker line belongs to the
 * user and is never overwritten. Best-effort — never fails a spawn.
 */
export async function writeSharedMemory(storage: Storage, space: Space): Promise<void> {
  try {
    const file = path.join(space.path, 'CLAUDE.md');
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (cur !== null && !cur.startsWith(MEMORY_MARKER)) return;
    const repos = await memberRepos(storage, space);
    let index = '';
    try {
      index = fs.readFileSync(path.join(space.path, 'INDEX.md'), 'utf8');
    } catch {
      /* no map yet */
    }
    const cut = index.length > MEMORY_INDEX_MAX;
    const text = [
      `${MEMORY_MARKER} from INDEX.md on every agent start (docs/shared-spaces.md). Do not edit: change INDEX.md. Delete this line to take the file over. -->`,
      `# Shared space "${space.name}": knowledge shared by ${repos.map((r) => r.name).join(', ') || 'its repos'}`,
      '',
      `You are working in one of these repos. This folder (${space.path}, also \`$TM_SHARED_DIR\`) holds what the`,
      `other repos' agents learned, shipped, decided or left unfinished. Your own repo's history does not show`,
      `it, and their conversations are gone.`,
      '',
      `**Before you plan any change:** find your task's area in the map below and read the files it points to,`,
      `plus your repo's page under \`repos/\`. Your plan names the shared files you read, or says none apply.`,
      `If you delegate exploration to a subagent, give it this folder too.`,
      '',
      `**While you work:** durable knowledge goes into this folder (keep INDEX.md current). Work another repo`,
      `must do is a REQUEST through the Task Manager API (\`GET $TM_CALLBACK_URL/api/agent/shared\`), not a file.`,
      `No secrets here.`,
      '',
      '---',
      '',
      index
        ? `## The map (a copy of INDEX.md${cut ? `, first ${MEMORY_INDEX_MAX} characters; open INDEX.md for the rest` : ''})\n\n${cut ? index.slice(0, MEMORY_INDEX_MAX) : index}`
        : '## The map\n\nThere is no INDEX.md yet. Create it when you add the first knowledge file.',
      '',
    ].join('\n');
    if (text !== cur) fs.writeFileSync(file, text);
  } catch (e) {
    console.error(`shared space ${space.name}: writing CLAUDE.md failed:`, e);
  }
}

/**
 * This repo's own page in the folder (`repos/<name>.md`), matched loosely: the
 * file's stem appears in the repo's name or directory ("neko-frontend.md" for
 * "18 - neko-frontend"). The longest stem wins, so "nest" never beats "neko-nest".
 */
export function repoPage(space: Space, repo: Pick<Repo, 'name' | 'path'>): string | null {
  try {
    const hay = `${repo.name} ${path.basename(repo.path)}`.toLowerCase();
    const hits = fs
      .readdirSync(path.join(space.path, 'repos'))
      .filter((f) => f.endsWith('.md') && hay.includes(f.slice(0, -3).toLowerCase()))
      .sort((a, b) => b.length - a.length);
    return hits[0] ? `repos/${hits[0]}` : null;
  } catch {
    return null;
  }
}

export async function writeFolderDocs(storage: Storage, space: Space): Promise<void> {
  try {
    const repos = await memberRepos(storage, space);
    fs.mkdirSync(space.path, { recursive: true });
    fs.writeFileSync(path.join(space.path, 'README.md'), readmeText(space, repos));
  } catch (e) {
    console.error(`shared space ${space.name}: writing README.md failed:`, e);
  }
  await writeRequestsMirror(storage, space);
  await writeSharedMemory(storage, space);
}

function readmeText(space: Space, repos: Repo[]): string {
  return `<!-- Generated by the Task Manager (docs/shared-spaces.md) — rewritten on every space change; do not edit. Put your own content in INDEX.md. -->
# ${space.name} — shared space

Shared knowledge for every agent and human working in:
${repos.map((r) => `- **${r.name}**${r.role ? ` (${r.role})` : ''} — \`${r.path}\``).join('\n') || '- (no member repos)'}

Each repo's agents run in their own working tree and cannot see each other's
conversations or per-task artifacts. This folder is the one place they all read
from and write to. Workers get it as \`$TM_SHARED_DIR\`.

## Layout

| Path | What | Who edits |
|---|---|---|
| \`INDEX.md\` | The map — start here. Update it whenever you add or rename a file. | agents, humans |
| \`knowledge/<topic>.md\` | Durable, deduplicated facts: API contracts, data model, migration status, gotchas. Edit in place — the newest fact wins, cite the task id. | agents, humans |
| \`repos/<repo>.md\` | Per repo: what it owns, its current state, what the others must know about it. | agents, humans |
| \`archive/\` | Original per-task outputs, copied for history. Treat it as read-only. | — |
| \`REQUESTS.md\` | GENERATED mirror of the request/note ledger. Do not edit it; edits are overwritten. | the Task Manager |
| \`CLAUDE.md\` | GENERATED on every agent start: the working rules plus a copy of \`INDEX.md\`. Workers load it as memory, so the map is in their context before they read the task. Edit \`INDEX.md\`, not this. | the Task Manager |
| \`.tm/import.json\` | Optional seed file, imported into the ledger once (then renamed). | humans |

## Requests and notes (the ledger)

A **request** is work another repo still has to do because of your change or
finding. Write one instead of a report nobody reads: the agents of the target
repo see every open request addressed to it at the start of each task, check
whether it is already done, and file a task for it themselves. A **note** is
durable knowledge every member should know. Humans manage both on the
dashboard's **Shared** page.

Agent API (the token and URL are in every worker's environment):

\`\`\`bash
H="x-tm-token: $TM_TOKEN"; U="$TM_CALLBACK_URL/api/agent/shared"
curl -s -H "$H" "$U"                                   # the space, requests to your repo, your open asks, notes
curl -s -H "$H" "$U/notes/<id>"                        # one request/note in full
curl -s -X POST -H "$H" -H 'content-type: application/json' "$U/notes" \\
  -d '{"kind":"request","to":"<repo name|id|role>","title":"…","body":"<contract: what changed, what to do, how to verify>","files":["knowledge/x.md"]}'
curl -s -X POST -H "$H" -H 'content-type: application/json' "$U/notes/<id>/file" -d '{}'   # file a task for a request to YOUR repo
curl -s -X POST -H "$H" -H 'content-type: application/json' "$U/notes/<id>/resolve" \\
  -d '{"status":"done","resolution":"<evidence: commit, file, endpoint>"}'
\`\`\`

## Rules

1. Read \`INDEX.md\` and whatever in it concerns your task before you start.
2. Durable knowledge goes HERE, not only in \`$TM_ARTIFACTS_DIR\`. Other repos never read that.
3. Work for another repo is a **request** in the ledger, with a full contract. A file alone is not enough.
4. Never implement another repo's request inside an unrelated task. File it; it runs once your task has shipped or closed.
5. No secrets here: no tokens, passwords, \`.env\` values or customer data.
`;
}

export async function writeRequestsMirror(storage: Storage, space: Space): Promise<void> {
  try {
    const repos = await storage.listRepos();
    const name = (id: string | null) => (id ? repos.find((r) => r.id === id)?.name ?? id.slice(0, 8) : 'everyone');
    const notes = await storage.listSharedNotes({ spaceId: space.id, oldestFirst: true, limit: 2000 });
    const active = notes.filter((n) => n.kind === 'request' && ACTIVE_REQUEST.includes(n.status));
    const lines: string[] = [
      `<!-- Generated by the Task Manager at ${new Date().toISOString()} — do not edit; use the dashboard (Shared) or the agent API. -->`,
      `# Requests & notes — ${space.name}`,
      '',
      `## Open requests (${active.length})`,
      '',
    ];
    const targets = [...new Set(active.map((n) => n.toRepoId))];
    if (targets.length === 0) lines.push('_None._', '');
    for (const t of targets) {
      const mine = active.filter((n) => n.toRepoId === t);
      lines.push(`### → ${name(t)} (${mine.length})`, '');
      for (const n of mine) {
        lines.push(
          `#### ${n.title}`,
          `\`${n.id}\` · ${n.status}${n.taskId ? ` as task \`${n.taskId}\`` : ''} · from ${name(n.fromRepoId)} · ${n.createdAt.slice(0, 10)}${
            n.files.length ? ` · files: ${n.files.join(', ')}` : ''
          }`,
          '',
          n.body,
          '',
        );
      }
    }
    const kept = notes.filter((n) => n.kind === 'note' && n.status !== 'dismissed');
    lines.push(`## Notes (${kept.length})`, '');
    if (kept.length === 0) lines.push('_None._', '');
    for (const n of kept) {
      lines.push(
        `### ${n.title}`,
        `\`${n.id}\` · from ${name(n.fromRepoId)}${n.toRepoId ? ` · about ${name(n.toRepoId)}` : ''} · ${n.createdAt.slice(0, 10)}${
          n.files.length ? ` · files: ${n.files.join(', ')}` : ''
        }`,
        '',
        n.body,
        '',
      );
    }
    const resolved = notes
      .filter((n) => n.kind === 'request' && !ACTIVE_REQUEST.includes(n.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 30);
    lines.push(`## Recently resolved requests`, '');
    if (resolved.length === 0) lines.push('_None._', '');
    for (const n of resolved) {
      lines.push(
        `- **${n.status}** · ${n.title} → ${name(n.toRepoId)} · \`${n.id.slice(0, 8)}\`${n.resolution ? ` — ${n.resolution.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`,
      );
    }
    fs.mkdirSync(space.path, { recursive: true });
    fs.writeFileSync(path.join(space.path, 'REQUESTS.md'), lines.join('\n') + '\n');
  } catch (e) {
    console.error(`shared space ${space.name}: writing REQUESTS.md failed:`, e);
  }
}

// ---------------------------------------------------------------------------
// The worker prompt block

/**
 * What a worker in a member repo is told at the start of a turn. A fresh
 * session gets the space and every open request addressed to its repo; a
 * resumed one only what arrived since its previous turn started (`since`) —
 * the session already read the rest — and nothing at all when there is
 * nothing new. Never called for the publish turn.
 */
export async function sharedPromptBlock(
  deps: SpaceDeps,
  task: Task,
  space: Space,
  opts: { since?: string } = {},
): Promise<string | undefined> {
  const { storage } = deps;
  if (!task.repoId) return undefined;
  const repos = await memberRepos(storage, space);
  const name = (id: string | null) => (id ? repos.find((r) => r.id === id)?.name ?? 'a removed repo' : 'a human');
  // `filed` too, so a request whose task was cancelled or deleted reopens
  // (reconcileFiled) and is offered here instead of waiting for someone to
  // open the Shared page. The resume cut is applied AFTER that reconcile and
  // on `updatedAt`, not `createdAt`: a reopen (by reconcile or a human) and an
  // append both bump it, so a request reopened while this session was idle
  // reaches it too — a createdAt cut kept the original date and hid it.
  const all = await listNotes(deps, {
    spaceId: space.id,
    kind: 'request',
    status: ['open', 'filed'],
    toRepoId: task.repoId,
    oldestFirst: true,
  });
  const since = opts.since;
  const open = all.filter((n) => n.status === 'open' && (!since || n.updatedAt > since));
  if (opts.since && open.length === 0) return undefined;
  const shown = open.slice(0, PROMPT_REQUEST_LIMIT);
  const list = shown.map(
    (n) => `- \`${n.id}\` ${n.title} — from ${name(n.fromRepoId)}, ${n.createdAt.slice(0, 10)}`,
  );
  if (open.length > shown.length) list.push(`- …and ${open.length - shown.length} more (GET /api/agent/shared lists them all).`);
  const triage = [
    `Triage them before you finish, but never instead of your task, and never implement one inside it`,
    `unless it is squarely in scope: read it (\`GET $TM_CALLBACK_URL/api/agent/shared/notes/<id>\`), check`,
    `whether this repo already does it, then either resolve it with the evidence (\`POST …/notes/<id>/resolve\`)`,
    `or file it (\`POST …/notes/<id>/file\`) — the task joins the queue and starts only after your task is published, done or cancelled and nothing else in this repo is working.`,
  ].join(' ');
  if (opts.since) {
    return [
      `## New, reopened or updated requests for this repo in shared space "${space.name}" (since your last turn)`,
      '',
      ...list,
      '',
      triage,
    ].join('\n');
  }
  // Placed at the TOP of a fresh prompt (buildWorkerPrompt), ahead of the
  // task: when it sat between a long task description and the standing rules,
  // an agent read past "start with its INDEX.md" and went straight to the
  // code (2026-09-28, task d474e1e1). So reading comes first, as a step with
  // an observable result (the plan names what was read), and the map itself
  // is already in context through the folder's CLAUDE.md (writeSharedMemory).
  const self = repos.find((r) => r.id === task.repoId);
  const page = self ? repoPage(space, self) : null;
  return [
    `## Shared space "${space.name}" (${repos.map((r) => r.name).join(', ')}): read before you plan`,
    '',
    `This repo shares a knowledge folder with the repos above: $TM_SHARED_DIR (${space.path}). It holds what`,
    `their agents shipped, decided and left unfinished, which this repo's history does not show. Its map is`,
    `INDEX.md. A copy is loaded into your context from the folder's CLAUDE.md; open the file if you do not see it.`,
    '',
    `**Step 1, before your plan:** find this task's area in INDEX.md and read the files it points to` +
      (page ? `, plus this repo's page \`${page}\`.` : '.'),
    `Your plan must name the shared files you read, or say that none apply. If you delegate exploration to a`,
    `subagent, include $TM_SHARED_DIR in its brief.`,
    '',
    `**While you work:** the other repos' agents never see your conversation or $TM_ARTIFACTS_DIR. When you`,
    `learn something they need, write it into the folder (keep INDEX.md current). When you change something`,
    `another repo must follow up on, write a REQUEST with a full contract (\`curl -s -H "x-tm-token: $TM_TOKEN"`,
    `"$TM_CALLBACK_URL/api/agent/shared"\` shows how). Mention every request you wrote or resolved in your final summary.`,
    '',
    ...(shown.length
      ? [`Open requests addressed to THIS repo (oldest first):`, '', ...list, '', triage]
      : [`No open requests are addressed to this repo right now.`]),
  ].join('\n');
}
