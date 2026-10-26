import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Command lines are stored as text but NEVER handed to a shell: they are
 * tokenized here and spawned as an argv array, the same rule the worker spawn
 * follows (CLAUDE.md). A shell operator would therefore become a literal
 * argument rather than doing what it looks like it does, so an UNQUOTED one is
 * rejected at the API boundary, with a message naming the alternative. Quoted
 * and escaped operators are kept: `node -e 'a > b'` passes a literal `>` to a
 * real shell too, so it must mean the same here.
 */
const SHELL_OPERATORS = new Set(['|', '&', ';', '<', '>', '`', '\n', '\r']);

function rejectOperator(op: string): never {
  throw new Error(
    `commands run without a shell, so an unquoted "${op}" cannot work — wrap it in quotes if you meant it literally, or put the pipeline in a package.json script and call that instead`,
  );
}

/** POSIX-ish tokenizer: whitespace splits, '…' is literal, "…" honours \\, and
 *  a bare backslash escapes the next character. */
export function parseCommandLine(raw: string): string[] {
  const line = raw.trim();
  if (!line) throw new Error('command is empty');

  const argv: string[] = [];
  let cur = '';
  let started = false; // distinguishes an empty quoted token from no token
  let i = 0;
  const push = () => {
    if (started) argv.push(cur);
    cur = '';
    started = false;
  };
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') {
      push();
      i++;
    } else if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) throw new Error('unbalanced single quote');
      cur += line.slice(i + 1, end);
      started = true;
      i = end + 1;
    } else if (ch === '"') {
      i++;
      started = true;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) {
          cur += line[i + 1];
          i += 2;
        } else {
          cur += line[i];
          i++;
        }
      }
      if (i >= line.length) throw new Error('unbalanced double quote');
      i++;
    } else if (ch === '\\' && i + 1 < line.length) {
      cur += line[i + 1];
      started = true;
      i += 2;
    } else if (SHELL_OPERATORS.has(ch)) {
      rejectOperator(ch);
    } else if (ch === '$' && line[i + 1] === '(') {
      rejectOperator('$(');
    } else {
      cur += ch;
      started = true;
      i++;
    }
  }
  push();
  if (argv.length === 0) throw new Error('command is empty');
  return argv;
}

function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path of the binary to spawn. Looked up the way a shell in that
 * directory would: an explicit path as written, otherwise every
 * `node_modules/.bin` from `cwd` up to the repo root (so a repo-local `vite`
 * works without a global install), then `PATH`.
 *
 * Resolving up front — rather than letting node-pty fail — is what turns a
 * missing `pnpm` into a 400 with a readable message instead of a terminal that
 * flashes "ENOENT" and vanishes.
 */
export function resolveBin(bin: string, cwd: string, repoRoot: string): string {
  if (bin.includes('/')) {
    const abs = path.resolve(cwd, bin);
    if (isExecutableFile(abs)) return abs;
    throw new Error(`not an executable file: ${bin}`);
  }
  const root = path.resolve(repoRoot);
  let dir = path.resolve(cwd);
  // Bounded walk: stop at the repo root, and never above it.
  for (let depth = 0; depth < 32; depth++) {
    const candidate = path.join(dir, 'node_modules', '.bin', bin);
    if (isExecutableFile(candidate)) return candidate;
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, bin);
    if (isExecutableFile(candidate)) return candidate;
  }
  throw new Error(`command not found: ${bin} — it must be on the PATH of the task-manager server process`);
}

/**
 * Absolute working directory for a command. `sub` is a repo-relative path; the
 * result is required to stay inside the repo, so a stored `../../etc` (or an
 * absolute path) can never make a command run somewhere else.
 */
export function resolveCommandCwd(repoPath: string, sub: string | null | undefined): string {
  const root = path.resolve(repoPath);
  const rel = (sub ?? '').trim();
  if (rel === '' || rel === '.') {
    if (!isDirectory(root)) throw new Error(`repo directory does not exist: ${root}`);
    return root;
  }
  if (path.isAbsolute(rel) || rel.startsWith('~')) {
    throw new Error('working directory must be relative to the repo root');
  }
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('working directory must stay inside the repo');
  }
  if (!isDirectory(abs)) throw new Error(`directory does not exist: ${rel}`);
  return abs;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Shells: `bash -c '…'` would bring back everything argv-only spawning rules out. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']);
/** Options that move a tool to another directory, whatever the tool (npm/pnpm/yarn/bun/make/git/turbo/env). */
const DIR_FLAGS = new Set(['-C', '--chdir', '--cwd', '--dir', '--directory', '--prefix', '--work-tree', '--git-dir']);

function insideRoot(abs: string, root: string): boolean {
  return abs === root || abs.startsWith(root + path.sep);
}

function resolveArgPath(value: string, cwd: string): string {
  if (value === '~' || value.startsWith('~/')) return path.join(os.homedir(), value.slice(1));
  return path.resolve(cwd, value);
}

/**
 * The reason an AGENT's command line would run somewhere other than its repo,
 * or null (docs/commands.md § Agent-owned commands). `resolveCommandCwd` keeps
 * the `cwd` field inside the repo, but the argv can still leave it:
 * `env -C "<repo>-<task worktree>" pnpm …`, `npm --prefix /elsewhere`,
 * `git -C ..`, `bash -c 'cd … && …'`. Every token is scanned — a wrapper's
 * nested command is just more tokens — and a directory option is refused only
 * when its value resolves OUTSIDE the repo, so `grep -C 3` or
 * `pnpm --dir web` pass. Fails closed: a tool whose own `--dir` means an
 * output folder outside the repo is refused too, with a message saying how.
 */
export function directoryEscape(argv: string[], cwd: string, repoRoot: string): string | null {
  const root = path.resolve(repoRoot);
  const outside = (flag: string, value: string) =>
    `"${flag} ${value}" runs the command outside the repo (${root}) — agent commands run in their own repo only; set "cwd" to a folder inside it instead`;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const base = path.basename(tok);
    if (base === 'cd' || base === 'pushd') {
      return `"${tok}" cannot change the directory of an argv command — set "cwd" (relative to the repo) instead`;
    }
    // any later -c, not just leading ones (`bash -o pipefail -c …`): fails closed
    if (SHELLS.has(base) && argv.slice(i + 1).some((a) => /^-[a-z]*c[a-z]*$/.test(a))) {
      return `"${base} -c" runs a shell, and commands run without one — put the pipeline in a package.json script and call that`;
    }
    if (base === 'env' && optionsOf(argv, i).some((a) => a.startsWith('--split-string') || /^-[a-zA-Z]*S/.test(a))) {
      return '"env -S" re-splits a string into a command line — write the argv out instead';
    }
    const eq = tok.indexOf('=');
    if (tok.startsWith('--') && eq > 0 && DIR_FLAGS.has(tok.slice(0, eq))) {
      const value = tok.slice(eq + 1);
      if (!insideRoot(resolveArgPath(value, cwd), root)) return outside(tok.slice(0, eq), value);
      continue;
    }
    if (DIR_FLAGS.has(tok) && i + 1 < argv.length) {
      const value = argv[i + 1];
      if (!insideRoot(resolveArgPath(value, cwd), root)) return outside(tok, value);
      i++;
      continue;
    }
    // attached short form: env -C/dir, make -C../x (not grep -C3: "3" stays inside)
    if (/^-C.+/.test(tok)) {
      const value = tok.slice(2);
      if (!insideRoot(resolveArgPath(value, cwd), root)) return outside('-C', value);
    }
  }
  return null;
}

/** The leading options (and `NAME=value` assignments, for env) of the program at argv[i]. */
function optionsOf(argv: string[], i: number): string[] {
  const out: string[] = [];
  for (let j = i + 1; j < argv.length; j++) {
    const a = argv[j];
    if (a === '--') break;
    if (a.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) out.push(a);
    else break;
  }
  return out;
}

/** Folders a scratch script lives in: a saved command pointing there is single-use by construction. */
function tempRoots(): string[] {
  const roots = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', os.tmpdir()];
  return [...new Set(roots.map((r) => path.resolve(r)))];
}

/**
 * The temp-folder path a command line names, or null. Refused on SAVE only
 * (docs/commands.md § Agent-owned commands): a scratchpad script dies with its
 * session, so a saved shortcut to it is a broken button a human may press
 * weeks later. The one-shot run is where such a line belongs.
 */
export function tempPathIn(argv: string[]): string | null {
  const roots = tempRoots();
  for (const tok of argv) {
    const eq = tok.startsWith('-') ? tok.indexOf('=') : -1;
    const value = eq > 0 ? tok.slice(eq + 1) : tok;
    if (!path.isAbsolute(value)) continue;
    const abs = path.resolve(value);
    if (roots.some((r) => insideRoot(abs, r))) return value;
  }
  return null;
}
