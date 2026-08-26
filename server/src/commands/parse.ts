import fs from 'node:fs';
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
