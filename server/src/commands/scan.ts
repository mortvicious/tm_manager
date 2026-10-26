import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckSuggestion, CommandKind, RepoScripts, ScannedScript } from '@tm/shared';
import { parseCommandLine } from './parse.ts';

/** Bounds: a monorepo scan must stay a directory listing, not a crawl. */
const MAX_PACKAGES = 60;
const MAX_SCRIPTS = 300;

/** Script names we can safely put into an argv without quoting. */
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9_@.:/-]+$/;

/** A long-running script — the kind that belongs in the header indicator. */
const SERVICE_NAME = /^(dev|start|serve|watch|preview|storybook|studio)(:|$)|:(dev|watch|serve|start)$/i;
const SERVICE_BODY = /\b(nodemon|vite(?![\w-]|\s+build)|next dev|nest start|webpack serve|--watch\b|-w\b|concurrently|tsc -w)/;

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** pnpm / yarn / npm / bun, from `packageManager` first (it is authoritative)
 *  and the lockfile second. */
export function detectPackageManager(repoPath: string, rootPkg: any | null): string {
  const declared = typeof rootPkg?.packageManager === 'string' ? rootPkg.packageManager.split('@')[0].trim() : '';
  if (['pnpm', 'yarn', 'npm', 'bun'].includes(declared)) return declared;
  const has = (f: string) => fs.existsSync(path.join(repoPath, f));
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  return 'npm';
}

/** Workspace globs from package.json `workspaces` or pnpm-workspace.yaml.
 *  Only the shapes that actually appear are handled (`dir/*`, `dir`); the
 *  point is to find sibling packages, not to reimplement glob. */
function workspacePatterns(repoPath: string, rootPkg: any | null): string[] {
  const out: string[] = [];
  const ws = rootPkg?.workspaces;
  if (Array.isArray(ws)) out.push(...ws.filter((w: unknown) => typeof w === 'string'));
  else if (Array.isArray(ws?.packages)) out.push(...ws.packages.filter((w: unknown) => typeof w === 'string'));
  const yaml = path.join(repoPath, 'pnpm-workspace.yaml');
  if (fs.existsSync(yaml)) {
    try {
      for (const line of fs.readFileSync(yaml, 'utf8').split('\n')) {
        const m = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/.exec(line);
        if (m) out.push(m[1]);
      }
    } catch {
      // unreadable workspace file — the root package is still scannable
    }
  }
  return out;
}

/** Package directories (repo-relative, '' = root) that hold a package.json. */
function packageDirs(repoPath: string, rootPkg: any | null): string[] {
  const dirs: string[] = [''];
  for (const pattern of workspacePatterns(repoPath, rootPkg)) {
    if (dirs.length >= MAX_PACKAGES) break;
    const clean = pattern.replace(/^\.\//, '').replace(/\/\*\*$/, '/*').trim();
    if (clean === '' || clean.startsWith('!') || clean.includes('..')) continue;
    if (clean.endsWith('/*')) {
      const parent = clean.slice(0, -2);
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(path.join(repoPath, parent), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const rel = path.posix.join(parent, e.name);
        if (fs.existsSync(path.join(repoPath, rel, 'package.json'))) dirs.push(rel);
        if (dirs.length >= MAX_PACKAGES) break;
      }
    } else if (!clean.includes('*') && fs.existsSync(path.join(repoPath, clean, 'package.json'))) {
      dirs.push(clean);
    }
  }
  return [...new Set(dirs)];
}

function guessKind(name: string, body: string): CommandKind {
  return SERVICE_NAME.test(name) || SERVICE_BODY.test(body) ? 'service' : 'task';
}

// ── Suggested checks (docs/checks.md § Suggested checks) ─────────────────────
// Rules only, no AI session: what CI already runs, plus the four names every
// JS repo uses for a verdict. A suggestion is a hint in the scan list — nothing
// is saved from it without a click and a baseline run.

/** Bounds for the workflow read: a directory listing, not a crawl. */
const MAX_WORKFLOWS = 20;
const MAX_WORKFLOW_BYTES = 256 * 1024;

/** The names that give a verdict. `typecheck:*`/`lint:*` variants are checks
 *  by name too; `test:*`/`build:*` variants only when CI runs them (they are
 *  e2e suites, probes against live services, release builds…). */
const CHECK_BASE = /^(typecheck|type-check|lint|test|build)$/i;
const CHECK_VARIANT = /^(typecheck|type-check|lint):[A-Za-z0-9_.-]+$/i;
/** Variants that never give a one-shot verdict, even when CI names them. */
const NOT_A_VERDICT = /(^|:)(watch|debug|dev|serve|open|ui)(:|$)/i;
const DEBUG_BODY = /--inspect(-brk)?\b|--watch\b/;
/** npm's `npm init` placeholder: always exits 1, a check that is red forever. */
const NPM_PLACEHOLDER_TEST = /no test specified/i;

/** Built-in package-manager commands: `pnpm audit` in CI is not a script. */
const PM_BUILTINS = new Set([
  'install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'audit', 'exec', 'dlx', 'x', 'publish', 'pack',
  'version', 'why', 'outdated', 'update', 'up', 'upgrade', 'link', 'unlink', 'rebuild', 'config', 'init', 'create',
  'store', 'fetch', 'prune', 'dedupe', 'cache', 'set-script', 'help', 'login', 'logout', 'whoami', 'env', 'list', 'ls',
]);
/** Package-manager options that take a value (`pnpm --filter web build`). */
const PM_VALUE_FLAGS = new Set(['--filter', '-F', '-C', '--dir', '-w', '--workspace', '--prefix', '--cwd']);

/**
 * Every script a package manager is asked to run in the repo's GitHub
 * workflows. A line reader, not a YAML parser (no dependency): `run:` values,
 * inline or as a `|`/`>` block, split on shell separators.
 */
export function ciScriptNames(repoPath: string): Set<string> {
  const names = new Set<string>();
  const dir = path.join(repoPath, '.github', 'workflows');
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => /\.ya?ml$/i.test(f))
      .sort()
      .slice(0, MAX_WORKFLOWS);
  } catch {
    return names;
  }
  for (const f of files) {
    let text = '';
    try {
      const file = path.join(dir, f);
      if (fs.statSync(file).size > MAX_WORKFLOW_BYTES) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const cmd of runLines(text)) {
      for (const segment of cmd.split(/&&|\|\||;|\||\n/)) {
        const name = scriptOf(segment);
        if (name) names.add(name);
      }
    }
  }
  return names;
}

/** The `run:` values of a workflow file, block scalars joined by newlines. */
function runLines(text: string): string[] {
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*(?:-\s+)?)run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const keyIndent = m[1].length;
    const rest = m[2].replace(/\s+#.*$/, '').trim();
    if (/^[|>][+-]?\d*$/.test(rest)) {
      const block: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.trim() === '') {
          i++;
          continue;
        }
        if (next.length - next.trimStart().length <= keyIndent) break;
        block.push(next.trim());
        i++;
      }
      out.push(block.join('\n'));
    } else if (rest) {
      out.push(rest.replace(/^(['"])(.*)\1$/, '$2'));
    }
  }
  return out;
}

/** `npm run build` / `pnpm lint` / `yarn test` / `npm t` → the script name. */
function scriptOf(segment: string): string | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift(); // FOO=1 npm …
  const pm = tokens.shift();
  if (!pm || !['npm', 'pnpm', 'yarn', 'bun'].includes(pm)) return null;
  while (tokens.length && tokens[0].startsWith('-')) {
    const flag = tokens.shift() as string;
    if (PM_VALUE_FLAGS.has(flag) && !flag.includes('=')) tokens.shift();
  }
  const sub = tokens.shift();
  if (!sub) return null;
  if (sub === 'run' || sub === 'run-script') {
    while (tokens.length && tokens[0].startsWith('-')) tokens.shift();
    return tokens[0] && SAFE_SCRIPT_NAME.test(tokens[0]) ? tokens[0] : null;
  }
  if (sub === 'test' || sub === 't' || sub === 'tst') return 'test';
  if (pm === 'npm' || PM_BUILTINS.has(sub)) return null; // npm runs scripts only through `run` (and test/start)
  return SAFE_SCRIPT_NAME.test(sub) ? sub : null;
}

/** This server's own checkout: its `web/dist` is what the front door serves. */
const SELF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function sameDir(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

const BUILD_BODY = /\b(vite build|next build|nest build|webpack(?!\s+serve)|rollup|esbuild|tsup|turbo run build|tsc\b(?![^&|;]*--noEmit))/;

/** The package manager's "run a local binary" prefix, for an `instead` line. */
function execPrefix(pm: string): string {
  return pm === 'pnpm' ? 'pnpm exec' : pm === 'yarn' ? 'yarn' : pm === 'bun' ? 'bunx' : 'npx';
}

/** `eslint … --fix` → `npx eslint …`; `prettier --write` → `--check`. Only for a
 *  body that is one plain command (no env prefix, no operators), checked by
 *  the same tokenizer the save path uses; anything else gets no alternative. */
function withoutRewrite(body: string, pm: string): string | null {
  const plain = body.trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(plain) || !/^(eslint|prettier|biome|stylelint)\b/.test(plain)) return null;
  const line = `${execPrefix(pm)} ${plain.replace(/\s--fix\b/g, '').replace(/\s--write\b/g, ' --check')}`;
  try {
    parseCommandLine(line);
    return line;
  } catch {
    return null;
  }
}

/**
 * What a script would change besides giving a verdict. A check runs after EVERY
 * worker turn, so a rewrite moves the diff hash the no-progress guard reads,
 * and a build overwrites output something may be serving. `pre<name>` runs
 * first under npm/pnpm/yarn, so its body counts too.
 */
function sideEffectOf(
  name: string,
  body: string,
  ctx: { repoPath: string; dir: string; pm: string; table: Record<string, unknown> },
): { sideEffect: string; instead: string | null } | null {
  const pre = typeof ctx.table[`pre${name}`] === 'string' ? (ctx.table[`pre${name}`] as string) : '';
  const all = `${pre}\n${body}`;
  if (/(^|\s)--fix\b/.test(all)) return { sideEffect: 'rewrites files (--fix)', instead: withoutRewrite(body, ctx.pm) };
  if (/(^|\s)--write\b/.test(all)) return { sideEffect: 'rewrites files (--write)', instead: withoutRewrite(body, ctx.pm) };
  if (/(^|\s)(-u|--update-?snapshots?|--updateSnapshot)(\s|$)/i.test(all)) {
    return { sideEffect: 'updates snapshots (-u)', instead: null };
  }
  // A script NAMED typecheck is trusted to emit nothing (`tsc -p x.json` with
  // noEmit in the config is the usual shape; reading `extends` chains is not
  // worth it).
  if (/^build(:|$)/i.test(name) || (!/^type-?check(:|$)/i.test(name) && BUILD_BODY.test(body))) {
    const typecheck = ['typecheck', 'type-check'].find((t) => typeof ctx.table[t] === 'string');
    const instead = typecheck ? `${ctx.pm} run ${typecheck}` : null;
    if (sameDir(ctx.repoPath, SELF_ROOT)) {
      return {
        sideEffect:
          'writes web/dist, which the production front door serves (Rebuild & restart builds into web/dist.next and swaps) — a check run mid-build serves a half-written page',
        instead,
      };
    }
    return {
      sideEffect: 'writes build output into the checkout — a server running from it may serve a half-written build',
      instead,
    };
  }
  return null;
}

/** The scanner's check suggestion for one script, or null. */
function suggestCheck(
  name: string,
  body: string,
  kind: CommandKind,
  inCi: boolean,
  ctx: { repoPath: string; dir: string; pm: string; table: Record<string, unknown> },
): CheckSuggestion | null {
  if (kind === 'service' || NOT_A_VERDICT.test(name) || DEBUG_BODY.test(body)) return null;
  if (NPM_PLACEHOLDER_TEST.test(body)) return null;
  const named = CHECK_BASE.test(name) || CHECK_VARIANT.test(name);
  if (!inCi && !named) return null;
  const effect = sideEffectOf(name, body, ctx);
  return {
    reason: inCi ? 'in CI' : `named ${name.split(':')[0].toLowerCase()}`,
    sideEffect: effect?.sideEffect ?? null,
    instead: effect?.instead ?? null,
    preselect: inCi && !effect,
  };
}

/**
 * Every `package.json` script the repo offers, ready to be saved as a command.
 * Read-only and synchronous — it is a handful of `readdir`/`readFile` calls
 * behind an explicit button, never a watcher.
 */
export function scanRepoScripts(repoPath: string): RepoScripts {
  const rootPkg = readJson(path.join(repoPath, 'package.json'));
  const packageManager = detectPackageManager(repoPath, rootPkg);
  if (!rootPkg) {
    return { packageManager, scripts: [], note: 'no readable package.json at the repo root' };
  }
  const scripts: ScannedScript[] = [];
  let skipped = 0;
  const ci = ciScriptNames(repoPath);
  for (const dir of packageDirs(repoPath, rootPkg)) {
    const pkg = dir === '' ? rootPkg : readJson(path.join(repoPath, dir, 'package.json'));
    const table = pkg?.scripts;
    if (!table || typeof table !== 'object') continue;
    const packageName = typeof pkg.name === 'string' && pkg.name ? pkg.name : dir || path.basename(repoPath);
    for (const [name, body] of Object.entries(table)) {
      if (typeof body !== 'string') continue;
      if (!SAFE_SCRIPT_NAME.test(name)) {
        skipped++;
        continue;
      }
      if (scripts.length >= MAX_SCRIPTS) {
        skipped++;
        continue;
      }
      const kind = guessKind(name, body);
      // A CI line runs from the repo root unless a workflow says otherwise; a
      // workspace script counts as "in CI" only when the root has no script
      // of that name (the root's would be the one CI ran).
      const inCi = ci.has(name) && (dir === '' || typeof rootPkg.scripts?.[name] !== 'string');
      scripts.push({
        name,
        script: body,
        cwd: dir,
        packageName,
        suggested: `${packageManager} run ${name}`,
        kind,
        suggestedCheck: suggestCheck(name, body, kind, inCi, { repoPath, dir, pm: packageManager, table }),
      });
    }
  }
  const note =
    scripts.length === 0
      ? 'no scripts found in this repo'
      : skipped > 0
        ? `${skipped} script(s) skipped (unsupported name, or past the ${MAX_SCRIPTS} cap)`
        : null;
  return { packageManager, scripts, note };
}
