// A task's own change, split per file (docs/task-diff.md). Pure: the server
// builds the diff text with `taskChangeRead` (server/src/claude/review.ts) and
// this module turns it into the per-file `TaskDiffResponse` the panel renders.
import type { DiffStat } from './types.ts';

/**
 * How the task's commits were found — the reviewer's own scope
 * (`Orchestrator.changeScope`):
 * - `trailer`: commits on any ref carrying `Task: <id>`;
 * - `branch-range`: a live worktree task's fork..HEAD in its own tree;
 * - `base-range`: base..HEAD in the checkout, the task having worked alone;
 * - `landed`: a published worktree task — the squash commit, by trailer;
 * - `none`: no commits attributed (never ran, or uncommitted-only).
 */
export type TaskDiffScopeKind = 'trailer' | 'branch-range' | 'base-range' | 'landed' | 'none';

export interface TaskDiffScope {
  kind: TaskDiffScopeKind;
  baseSha: string | null;
  /** the worktree branch (`Task.branch`), null for a checkout task */
  branch: string | null;
  /** the uncommitted `git diff HEAD` and untracked files were read */
  includeUncommitted: boolean;
  attribution: 'trailer' | 'base' | 'none';
  /** the task's worktree is gone (evicted/removed): read from the checkout by trailer, uncommitted not read */
  evicted: boolean;
}

/** `committed` = one net diff over a linear run; `commit:<sha12>` = one commit's own patch; `uncommitted` = the tree */
export type TaskDiffSource = 'committed' | 'uncommitted' | `commit:${string}`;

export interface TaskDiffSection {
  source: TaskDiffSource;
  /** this file's part of that source, `diff --git` header included; cut to the caps */
  patch: string;
  truncated: boolean;
}

export type TaskDiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';

export interface TaskDiffFile {
  path: string;
  /** the source path of a rename/copy */
  oldPath?: string;
  status: TaskDiffFileStatus;
  insertions: number;
  deletions: number;
  binary: boolean;
  sections: TaskDiffSection[];
}

export interface TaskDiffResponse {
  taskId: string;
  scope: TaskDiffScope;
  /** the task's commits, oldest first */
  commits: { sha: string; subject: string }[];
  /** always the complete list — only patches are cut */
  files: TaskDiffFile[];
  stat: DiffStat;
  /** some patch was cut (per-file or total cap), or untracked files were capped */
  truncated: boolean;
  /** more untracked files than `UNTRACKED_DIFF_CAP`, or than the read's time budget: the rest are listed without a patch */
  untrackedCapped: boolean;
  readAt: string;
}

/** about 400 KB of one file's patches (all its sections together) */
export const DIFF_FILE_PATCH_CAP = 400_000;
/** about 4 MB of patches in one response */
export const DIFF_TOTAL_PATCH_CAP = 4_000_000;
/** untracked files diffed per read; the rest are listed only */
export const UNTRACKED_DIFF_CAP = 200;

const COMMIT_MARKER = /^### commit ([0-9a-f]{7,40})$/;
const SECTION_MARKER = /^--- (committed|uncommitted) .*---$/;

/** git's C-style quoted path (`"a/t\303\251st"`), or the bare one. */
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && i + 1 < body.length) {
      const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
      if (oct) {
        bytes.push(parseInt(oct[0], 8));
        i += 3;
        continue;
      }
      const e = esc[body[i + 1]];
      if (e !== undefined) {
        bytes.push(e);
        i++;
        continue;
      }
    }
    for (const b of new TextEncoder().encode(c)) bytes.push(b);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** `a/x` / `b/x` → `x`; null for /dev/null */
function stripSide(p: string): string | null {
  const u = unquote(p.trim());
  if (u === '/dev/null') return null;
  return /^[ab]\//.test(u) ? u.slice(2) : u;
}

/** The two paths of a `diff --git` header; best effort when they contain spaces. */
function headerPaths(rest: string): { a: string; b: string } {
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*")\s+(.*)$/.exec(rest);
    if (m) return { a: stripSide(m[1]) ?? '', b: stripSide(m[2]) ?? '' };
  }
  // `a/P b/P` — the usual case, spaces in P included
  if ((rest.length - 5) % 2 === 0) {
    const n = (rest.length - 5) / 2;
    if (rest.startsWith('a/') && rest.slice(2 + n, 5 + n) === ' b/' && rest.slice(2, 2 + n) === rest.slice(5 + n)) {
      return { a: rest.slice(2, 2 + n), b: rest.slice(5 + n) };
    }
  }
  const m = /^(.*?) (b\/.*|"b\/.*)$/.exec(rest);
  if (m) return { a: stripSide(m[1]) ?? '', b: stripSide(m[2]) ?? '' };
  return { a: rest, b: rest };
}

interface Piece {
  path: string;
  oldPath?: string;
  status: TaskDiffFileStatus;
  insertions: number;
  deletions: number;
  binary: boolean;
  source: TaskDiffSource;
  lines: string[];
}

/**
 * Splits diff text into files. Understands `diff --git` sections (new,
 * deleted, renamed, copied, binary) and this module's own markers —
 * `--- committed (…) ---`, `### commit <sha12>`, `--- uncommitted (…) ---` —
 * which set the SOURCE of the sections after them (`initial` before any
 * marker). Markers are only recognised between hunks: hunk bodies are walked
 * by their `@@` line counts, so a removed line that itself reads
 * `-- committed …` stays a deletion. A file touched by several sources is ONE
 * entry with one section per source; its counts add up (like `diffStat`).
 * No caps here — `capDiffFiles` applies them.
 */
export function splitDiffFiles(text: string, initial: TaskDiffSource = 'uncommitted'): TaskDiffFile[] {
  const pieces: Piece[] = [];
  let source: TaskDiffSource = initial;
  let cur: Piece | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    if (oldLeft > 0 || newLeft > 0) {
      // inside a hunk: every line belongs to it
      cur?.lines.push(line);
      if (line.startsWith('+')) {
        newLeft--;
        if (cur) cur.insertions++;
      } else if (line.startsWith('-')) {
        oldLeft--;
        if (cur) cur.deletions++;
      } else if (line.startsWith('\\')) {
        // "\ No newline at end of file"
      } else {
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const { a, b } = headerPaths(line.slice('diff --git '.length));
      cur = { path: b || a, status: 'modified', insertions: 0, deletions: 0, binary: false, source, lines: [line] };
      if (a && b && a !== b) cur.oldPath = a;
      pieces.push(cur);
      continue;
    }
    const commit = COMMIT_MARKER.exec(line);
    if (commit) {
      source = `commit:${commit[1].slice(0, 12)}`;
      cur = null;
      continue;
    }
    const section = SECTION_MARKER.exec(line);
    if (section) {
      source = section[1] as 'committed' | 'uncommitted';
      cur = null;
      continue;
    }
    if (!cur) continue; // a note line of the module's own ("(none)") or noise
    cur.lines.push(line);
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
    } else if (line.startsWith('new file mode')) cur.status = 'added';
    else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      cur.status = 'renamed';
      cur.oldPath = unquote(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) cur.path = unquote(line.slice('rename to '.length));
    else if (line.startsWith('copy from ')) {
      cur.status = 'copied';
      cur.oldPath = unquote(line.slice('copy from '.length));
    } else if (line.startsWith('copy to ')) cur.path = unquote(line.slice('copy to '.length));
    else if (line.startsWith('+++ ')) {
      const p = stripSide(line.slice(4));
      if (p) cur.path = p;
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') cur.binary = true;
    else if (line === '') cur.lines.pop(); // a blank separator line between sections is not part of the patch
  }

  const byPath = new Map<string, TaskDiffFile>();
  const out: TaskDiffFile[] = [];
  for (const p of pieces) {
    if (p.oldPath === p.path || (p.status !== 'renamed' && p.status !== 'copied')) delete p.oldPath;
    const patch = `${p.lines.join('\n')}\n`;
    let f = byPath.get(p.path);
    if (!f) {
      f = { path: p.path, status: p.status, insertions: 0, deletions: 0, binary: false, sections: [] };
      if (p.oldPath) f.oldPath = p.oldPath;
      byPath.set(p.path, f);
      out.push(f);
    } else if (p.status === 'deleted' && f.status !== 'added') {
      // the last word on a file that ends deleted
      f.status = 'deleted';
    }
    f.insertions += p.insertions;
    f.deletions += p.deletions;
    f.binary ||= p.binary;
    const same = f.sections.find((s) => s.source === p.source);
    if (same) same.patch += patch;
    else f.sections.push({ source: p.source, patch, truncated: false });
  }
  return out;
}

/** Cut at a line end at or before `max` characters. */
function cut(patch: string, max: number): string {
  if (max <= 0) return '';
  if (patch.length <= max) return patch;
  const nl = patch.lastIndexOf('\n', max - 1);
  return nl > 0 ? patch.slice(0, nl + 1) : '';
}

/**
 * Applies the caps to the patches only — every file stays listed with its
 * counts. A file's sections share `perFile`; the response shares `total`,
 * spent in list order. A cut section says `truncated`.
 */
export function capDiffFiles(
  files: TaskDiffFile[],
  caps: { perFile: number; total: number } = { perFile: DIFF_FILE_PATCH_CAP, total: DIFF_TOTAL_PATCH_CAP },
): { files: TaskDiffFile[]; truncated: boolean } {
  let left = caps.total;
  let truncated = false;
  const out = files.map((f) => {
    let fileLeft = caps.perFile;
    const sections = f.sections.map((s) => {
      const room = Math.min(fileLeft, left);
      const patch = cut(s.patch, room);
      fileLeft -= patch.length;
      left -= patch.length;
      const cutHere = patch.length < s.patch.length;
      truncated ||= cutHere || s.truncated;
      return { ...s, patch, truncated: s.truncated || cutHere };
    });
    return { ...f, sections };
  });
  return { files: out, truncated };
}

/** files / +lines / -lines over the parsed list (a file in several sources counts once). */
export function diffFilesStat(files: TaskDiffFile[]): DiffStat {
  let insertions = 0;
  let deletions = 0;
  for (const f of files) {
    insertions += f.insertions;
    deletions += f.deletions;
  }
  return { files: files.length, insertions, deletions };
}
