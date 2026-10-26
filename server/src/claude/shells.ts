import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
  const needles = commands.filter((c) => c.trim()).flatMap(evalNeedles);
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

/**
 * The `eval '<command>'` texts a background shell running `command` shows in
 * `ps`. The CLI quotes a `'` as `'"'"'` (measured, 2.1.280); `'\''` is the
 * other common form, accepted in case that ever changes.
 */
function evalNeedles(command: string): string[] {
  return [`'"'"'`, `'\\''`].map((q) => `eval '${command.replace(/'/g, q).replace(/\n/g, '\\012')}'`);
}

/** What the transcript says about one background shell (see `shellDetails`). */
export interface ShellDetail {
  /** the output file the CLI reported for it, verified to be `…/tasks/<id>.output` */
  outputPath: string | null;
  /** when it was launched (epoch ms): the tool_result's time, less the Bash timeout when auto-backgrounded */
  startedAt: number | null;
}

/**
 * The launch facts of background shells `ids`, read from the session's
 * transcript (measured, CLI 2.1.280): the launching Bash call's `tool_result`
 * line carries `toolUseResult.backgroundTaskId` = the `background_tasks` id,
 * a `timestamp`, `timedOutAfterMs` when the CLI moved a foreground command to
 * the background, and the text "Output is being written to: <path>" — the
 * file the shell's stdout and stderr go to
 * (`<tmp>/claude-<uid>/<cwd slug>/<sessionId>/tasks/<id>.output`). Only a path
 * the CLI reported, ending in exactly `/tasks/<id>.output`, is ever returned;
 * the output route never opens anything else. A shell launched by a subagent
 * is in the subagent's own transcript and is not found here — its path comes
 * from the process itself (`shellProcesses`).
 */
export async function shellDetails(transcriptPath: string, ids: string[]): Promise<Map<string, ShellDetail>> {
  const out = new Map<string, ShellDetail>();
  if (!ids.length) return out;
  let text: string;
  try {
    text = await readFile(transcriptPath, 'utf8');
  } catch {
    return out;
  }
  const want = new Set(ids);
  for (const line of text.split('\n')) {
    if (!line.includes('backgroundTaskId')) continue;
    try {
      const d = JSON.parse(line) as {
        toolUseResult?: unknown;
        timestamp?: unknown;
        message?: { content?: unknown };
      };
      const r = d.toolUseResult as Record<string, unknown> | undefined;
      if (!r || typeof r !== 'object') continue;
      const id = r.backgroundTaskId;
      if (typeof id !== 'string' || !want.has(id)) continue;
      const at = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN;
      const timedOut = typeof r.timedOutAfterMs === 'number' ? r.timedOutAfterMs : 0;
      const m = /Output is being written to: (\/.+?\.output)\b/.exec(contentText(d.message?.content));
      out.set(id, {
        outputPath: m && reportedOutputPath(m[1], id) ? m[1] : null,
        startedAt: Number.isFinite(at) ? at - timedOut : null,
      });
      want.delete(id);
      if (!want.size) break;
    } catch {
      /* a partial line */
    }
  }
  return out;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (typeof c !== 'object' || c === null) return '';
      const { text, content: inner } = c as {
        text?: unknown;
        content?: unknown;
      };
      return typeof text === 'string' ? text : contentText(inner);
    })
    .join('\n');
}

/** An absolute, normalised path whose last two parts are `tasks/<id>.output`. */
export function reportedOutputPath(p: string, id: string): boolean {
  return (
    path.isAbsolute(p) &&
    path.normalize(p) === p &&
    path.basename(p) === `${id}.output` &&
    path.basename(path.dirname(p)) === 'tasks'
  );
}

/** One background shell process of a live claude (see `shellProcesses`). */
export interface ShellProcess {
  pid: number;
  /** the claude process it belongs to */
  claudePid: number;
  /** argv as `ps` renders it */
  args: string;
  /** the file its stdout is open on (`lsof`), null when unreadable */
  stdout: string | null;
}

/**
 * The background shell processes of the given claude pids. Measured (CLI
 * 2.1.280): each background shell is a DIRECT child of the claude process,
 * leads its own process group, runs `<shell> -c … eval '<command>' …`, and
 * has its stdout (fd 1) open on `…/tasks/<id>.output` — which is what ties a
 * process to a `background_tasks` id exactly (two shells may run the same
 * command). Anything else the claude process has spawned (MCP servers, the
 * hook curls) fails one of those tests. Agent PTYs, repo commands and login
 * shells are children of THIS server's process, never of a claude pid, so no
 * pid this returns can be one of them.
 */
export async function shellProcesses(claudePids: number[]): Promise<ShellProcess[]> {
  const parents = new Set(claudePids.filter((p) => Number.isInteger(p) && p > 1));
  if (!parents.size) return [];
  let ps: string;
  try {
    ps = (
      await execFileP('ps', ['-ww', '-A', '-o', 'pid=,ppid=,pgid=,args='], {
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout;
  } catch {
    return [];
  }
  const found: ShellProcess[] = [];
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [pid, ppid, pgid] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!parents.has(ppid) || pgid !== pid || !m[4].includes(" eval '")) continue;
    found.push({ pid, claudePid: ppid, args: m[4], stdout: null });
  }
  if (!found.length) return found;
  let lsof = '';
  try {
    lsof = (await execFileP('lsof', ['-a', '-p', found.map((f) => f.pid).join(','), '-d', '1', '-Fpn'])).stdout;
  } catch (e) {
    // lsof exits 1 when any one pid is gone, with the rest still on stdout
    lsof = typeof (e as { stdout?: unknown }).stdout === 'string' ? (e as { stdout: string }).stdout : '';
  }
  let cur: ShellProcess | undefined;
  for (const line of lsof.split('\n')) {
    if (line.startsWith('p')) cur = found.find((f) => f.pid === Number(line.slice(1)));
    else if (line.startsWith('n') && cur && cur.stdout === null) cur.stdout = line.slice(1);
  }
  return found;
}

/**
 * The process of background shell `id` (running `command`) among a claude
 * process's shells: the one whose stdout is `…/tasks/<id>.output`; without
 * lsof's answer, the ONE process whose argv carries that exact command (two
 * running the same command are ambiguous and match nothing).
 */
export function shellProcessFor(
  procs: ShellProcess[],
  claudePid: number,
  id: string,
  command: string,
): ShellProcess | null {
  const mine = procs.filter((p) => p.claudePid === claudePid);
  const byFile = mine.find((p) => p.stdout !== null && reportedOutputPath(p.stdout, id));
  if (byFile) return byFile;
  if (!command.trim()) return null;
  const needles = evalNeedles(command);
  const byCmd = mine.filter((p) => p.stdout === null && needles.some((n) => p.args.includes(n)));
  return byCmd.length === 1 ? byCmd[0] : null;
}

/** SIGTERM a shell's whole process group (its own children go with it). false when it is already gone. */
export function killShellGroup(pid: number): boolean {
  try {
    process.kill(-pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}
