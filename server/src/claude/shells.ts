import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * Background shells and the `waiting` park (docs/design.md § Waiting).
 *
 * The Stop payload's `background_tasks` lists every running shell the same
 * way (`{ id, type: 'shell', status, command, description }`) whether the
 * agent launched it with `run_in_background: true` or the CLI moved a
 * foreground command there after its Bash timeout. The transcript tells them
 * apart (measured on CLI 2.1.280): the launching Bash call's `tool_result`
 * line carries `toolUseResult.backgroundTaskId` = the entry's id, plus
 * `timedOutAfterMs` ONLY when the CLI auto-backgrounded it. A command the
 * agent meant to run in the foreground was never something it chose to end
 * its turn on, so such shells do not hold the park (decisions.md 2026-10-26).
 */

/** Ids among `ids` that the transcript shows were auto-backgrounded by the Bash timeout. */
export async function autoBackgroundedShells(transcriptPath: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  let text: string;
  try {
    text = await readFile(transcriptPath, 'utf8');
  } catch {
    return []; // unreadable transcript: every shell keeps counting — the safe side
  }
  const want = new Set(ids);
  const found: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('timedOutAfterMs') || !line.includes('backgroundTaskId')) continue;
    try {
      const r = (JSON.parse(line) as { toolUseResult?: unknown }).toolUseResult as Record<string, unknown> | undefined;
      if (!r || typeof r !== 'object') continue;
      const id = r.backgroundTaskId;
      if (typeof id === 'string' && want.has(id) && typeof r.timedOutAfterMs === 'number') {
        found.push(id);
        want.delete(id);
      }
    } catch {
      /* a partial line */
    }
  }
  return found;
}

/** The running shell entries of a Stop payload's `background_tasks`. */
export function shellEntries(body: unknown): { id: string; command: string }[] {
  const list = (body as { background_tasks?: unknown } | null)?.background_tasks;
  if (!Array.isArray(list)) return [];
  const out: { id: string; command: string }[] = [];
  for (const t of list) {
    if (typeof t !== 'object' || t === null) continue;
    const { id, type, status, command } = t as Record<string, unknown>;
    if (type !== 'shell' || typeof id !== 'string' || !id) continue;
    if (status !== 'running' && status !== 'pending') continue;
    out.push({ id, command: typeof command === 'string' ? command : '' });
  }
  return out;
}

/**
 * Kill the background shells of a live claude process that run one of
 * `commands`. Measured shape: each background shell is a DIRECT child of the
 * claude pid, leads its own process group, and its argv is
 * `<shell> -c source …/shell-snapshots/snapshot-… && … eval '<command>' …`
 * (`ps` renders a newline as `\012`). Matching on that exact `eval` text of
 * a direct child that leads its own group keeps MCP
 * servers and every other child alone; the whole group is signalled so the
 * shell's own children (`find`, `npx …`) go with it. Returns how many groups
 * were signalled; best effort — a shell it cannot match keeps running, and
 * the caller lands the turn regardless.
 */
export async function killBackgroundShells(claudePid: number | undefined, commands: string[]): Promise<number> {
  if (!claudePid || !commands.length) return 0;
  let out: string;
  try {
    out = (await execFileP('ps', ['-ww', '-A', '-o', 'pid=,ppid=,pgid=,args='], { maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch {
    return 0;
  }
  // The CLI quotes a `'` as `'"'"'` (measured, 2.1.280); `'\''` is the
  // other common form, accepted in case that ever changes.
  const needles = commands
    .filter((c) => c.trim())
    .flatMap((c) => [`'"'"'`, `'\\''`].map((q) => `eval '${c.replace(/'/g, q).replace(/\n/g, '\\012')}'`));
  let killed = 0;
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [pid, ppid, pgid] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const args = m[4];
    if (ppid !== claudePid || pgid !== pid) continue;
    if (!needles.some((n) => args.includes(n))) continue;
    try {
      process.kill(-pgid, 'SIGTERM');
      killed++;
    } catch {
      /* already gone */
    }
  }
  return killed;
}
