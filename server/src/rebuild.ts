/**
 * Rebuild & restart — the steps (docs/host.md § Rebuild & restart).
 *
 * ONE implementation, two callers: the front door (host.ts) runs these as its
 * `/host/rebuild-restart` job, and `scripts/rebuild-restart.mjs` runs them
 * itself when no front door is listening. Neither restates them.
 *
 * Deliberately free of the API's modules: this runs in the HOST process, which
 * must keep working while the API it is about to restart is broken.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { serverRoot } from './config.ts';

export const repoRoot = path.resolve(serverRoot, '..');
export const webDir = path.join(repoRoot, 'web');
export const webDist = path.join(webDir, 'dist');
/** where the build goes first; only a finished build is swapped in */
const nextDist = path.join(webDir, 'dist.next');
const prevDist = path.join(webDir, 'dist.prev');

const BUILD_TIMEOUT_MS = 5 * 60_000;
const TYPECHECK_TIMEOUT_MS = 5 * 60_000;
const TAIL_LINES = 40;

export interface StepResult {
  ok: boolean;
  /** the last lines of the step's combined output, ANSI stripped */
  tail: string;
  /** set when it failed, in words */
  error: string | null;
}

/** The id `vite build` stamped into a dist (web/vite.config.ts), or null. */
export function readBuildId(dist = webDist): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dist, 'build.json'), 'utf8'));
    return typeof j?.id === 'string' ? j.id : null;
  } catch {
    return null;
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function tailOf(buf: string): string {
  return buf.replace(ANSI, '').trimEnd().split('\n').slice(-TAIL_LINES).join('\n');
}

/** A package's bin, hoisted to the root by npm workspaces or local to web/. */
function binOf(pkg: string, rel: string): string | null {
  for (const base of [repoRoot, webDir]) {
    const p = path.join(base, 'node_modules', pkg, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Run a node script (never a shell): `process.execPath`, so the step uses the
 * same node as the process running it — a PATH `node` may be a different major.
 * Not the host's execArgv: those are tsx's loader flags, which vite and tsc
 * do not need. `onChild` hands the caller the process so a shutdown can kill it.
 */
function runNode(
  script: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  onChild?: (c: ChildProcess | null) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StepResult> {
  return new Promise((resolve) => {
    let out = '';
    const keep = (c: Buffer) => {
      out += c.toString('utf8');
      if (out.length > 64_000) out = out.slice(-64_000);
    };
    const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    onChild?.(child);
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      onChild?.(null);
      resolve({ ok: false, tail: tailOf(out), error: e.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      onChild?.(null);
      const ok = code === 0 && !timedOut;
      resolve({
        ok,
        tail: tailOf(out),
        error: ok ? null : timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : `exited ${signal ?? code}`,
      });
    });
  });
}

/**
 * `vite build` into `web/dist.next`, NEVER in place: vite empties its outDir
 * first, so a failed or half build in `dist` would leave the front door serving
 * nothing. The live `dist` is untouched until `swapDist()`.
 */
export async function buildSpa(onChild?: (c: ChildProcess | null) => void): Promise<StepResult & { buildId: string | null }> {
  const vite = binOf('vite', 'bin/vite.js');
  if (!vite) return { ok: false, tail: '', error: 'vite is not installed — run npm install', buildId: null };
  fs.rmSync(nextDist, { recursive: true, force: true });
  const r = await runNode(vite, ['build', '--outDir', 'dist.next', '--emptyOutDir'], webDir, BUILD_TIMEOUT_MS, onChild);
  if (!r.ok) {
    fs.rmSync(nextDist, { recursive: true, force: true });
    return { ...r, error: `build failed (${r.error})`, buildId: null };
  }
  if (!fs.existsSync(path.join(nextDist, 'index.html'))) {
    return { ...r, ok: false, error: 'build produced no index.html', buildId: null };
  }
  return { ...r, buildId: readBuildId(nextDist) };
}

/**
 * dist → dist.prev, dist.next → dist, drop dist.prev. Synchronous on purpose:
 * in the front door no request is served between the two renames, because
 * nothing else runs on its event loop until this returns. A failed second
 * rename puts the old dist back.
 */
export function swapDist(): void {
  fs.rmSync(prevDist, { recursive: true, force: true });
  const hadDist = fs.existsSync(webDist);
  if (hadDist) fs.renameSync(webDist, prevDist);
  try {
    fs.renameSync(nextDist, webDist);
  } catch (e) {
    if (hadDist) fs.renameSync(prevDist, webDist);
    throw e;
  }
  fs.rmSync(prevDist, { recursive: true, force: true });
}

/**
 * `npm run typecheck`'s two passes, run directly. A fast-fail before the
 * restart: a server that does not typecheck may well not boot, and the
 * restart is the step that cannot be taken back. It never touches dist.
 */
export async function typecheck(onChild?: (c: ChildProcess | null) => void): Promise<StepResult> {
  const tsc = binOf('typescript', 'bin/tsc');
  if (!tsc) return { ok: false, tail: '', error: 'typescript is not installed — run npm install' };
  for (const project of ['server/tsconfig.json', 'web/tsconfig.json']) {
    const r = await runNode(tsc, ['-p', project, '--noEmit'], repoRoot, TYPECHECK_TIMEOUT_MS, onChild);
    if (!r.ok) return { ...r, error: `typecheck failed in ${project.split('/')[0]} (${r.error})` };
  }
  return { ok: true, tail: '', error: null };
}

/**
 * What the front door is made of. host.ts is the process running the job, so
 * a restart of the API cannot reload it; a fingerprint taken at its boot and
 * compared later is how the job knows to say so.
 */
const HOST_MODULES = ['host.ts', 'config.ts', 'net.ts', 'remote.ts', 'rebuild.ts'];
export function hostFingerprint(): string {
  const h = createHash('sha256');
  for (const f of HOST_MODULES) {
    try {
      h.update(fs.readFileSync(path.join(serverRoot, 'src', f)));
    } catch {
      h.update(`missing:${f}`);
    }
  }
  return h.digest('hex');
}
