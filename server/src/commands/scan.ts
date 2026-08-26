import fs from 'node:fs';
import path from 'node:path';
import type { CommandKind, RepoScripts, ScannedScript } from '@tm/shared';

/** Bounds: a monorepo scan must stay a directory listing, not a crawl. */
const MAX_PACKAGES = 60;
const MAX_SCRIPTS = 300;

/** Script names we can safely put into an argv without quoting. */
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9_@.:/-]+$/;

/** A long-running script — the kind that belongs in the header indicator. */
const SERVICE_NAME = /^(dev|start|serve|watch|preview|storybook|studio)(:|$)|:(dev|watch|serve|start)$/i;
const SERVICE_BODY = /\b(nodemon|vite(?!\s+build)|next dev|nest start|webpack serve|--watch\b|-w\b|concurrently|tsc -w)/;

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
      scripts.push({
        name,
        script: body,
        cwd: dir,
        packageName,
        suggested: `${packageManager} run ${name}`,
        kind: guessKind(name, body),
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
