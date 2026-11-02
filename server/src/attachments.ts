import fs from 'node:fs';
import path from 'node:path';
import { LOOP_LEDGER } from './loop.ts';

/**
 * Files attached to a task (docs/design.md § Attached files): the human drops
 * them into the task's `$TM_ARTIFACTS_DIR` from the New task dialog or the
 * panel's Files section, and a FRESH worker prompt names them under the task,
 * so an attached screenshot is read before planning rather than only if the
 * agent remembers the standing rule. A resumed session saw the block already.
 */

/** Written by the server or the loop itself — never something to read as input. */
const NOT_INPUT = new Set(['worktree-setup.log', LOOP_LEDGER]);
/** a long list is noise: the agent can `ls` the rest */
export const ATTACHED_LIST_MAX = 30;

export type AttachedFile = { name: string; size: number };

/** The top-level files of a task's artifacts dir, oldest first (the order they were attached). */
export function readAttachedFiles(dir: string): AttachedFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: (AttachedFile & { mtime: number })[] = [];
  for (const d of entries) {
    if (!d.isFile() || d.name.startsWith('.') || NOT_INPUT.has(d.name)) continue;
    try {
      const st = fs.statSync(path.join(dir, d.name));
      out.push({ name: d.name, size: st.size, mtime: st.mtimeMs });
    } catch {
      /* removed between readdir and stat */
    }
  }
  return out.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name)).map(({ name, size }) => ({ name, size }));
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** The prompt block, or null when nothing is attached. */
export function attachedFilesNote(files: AttachedFile[]): string | null {
  if (files.length === 0) return null;
  const shown = files.slice(0, ATTACHED_LIST_MAX);
  const more = files.length - shown.length;
  return [
    '## Attached files',
    'These files are in $TM_ARTIFACTS_DIR (attached by the user, or left there by an earlier attempt). Read the ones that matter to the task before you plan — images with the Read tool.',
    ...shown.map((f) => `- ${f.name} (${fmtSize(f.size)})`),
    ...(more > 0 ? [`- … and ${more} more (ls $TM_ARTIFACTS_DIR)`] : []),
  ].join('\n');
}
