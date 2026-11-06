#!/usr/bin/env node
/**
 * Run the front door (server/src/host.ts) as a per-user launchd agent instead
 * of a terminal tab — docs/host.md § Running as a service.
 *
 *   npm run service:install   [-- --process-type Standard|Interactive|Background] [--no-caffeinate] [--force]
 *   npm run service:status
 *   npm run service:restart   [-- --force]     restart the FRONT DOOR (and the API it supervises)
 *   npm run service:start                      start an installed agent that is not running
 *   npm run service:logs                       tail -F api.log + host.log
 *   npm run service:uninstall                  stop it and remove the plist
 *
 * Why: macOS bills every descendant of a terminal app to that app, so
 * `npm start` in Warp made the API, every worker, every dev server and every
 * `tsc` show up as "Warp 13 GB"; the terminal's scrollback grew for days; and a
 * terminal that stopped reading wedged the API inside a synchronous TTY write.
 * A launchd agent is its own responsible process, and host.ts writes its and
 * the API's output to rotated files under server/data/logs when it is not on a
 * terminal (server/src/host-log.ts).
 *
 * Run under tsx (the npm scripts do) — it reads ports through the same
 * loadBootConfig as the server. Environment overrides for a rehearsal instance:
 * TM_SERVICE_LABEL (default com.taskmanager.server), TM_LAUNCH_AGENTS_DIR.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBootConfig } from '../server/src/config.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = process.env.TM_SERVICE_LABEL || 'com.taskmanager.server';
const agentsDir = process.env.TM_LAUNCH_AGENTS_DIR || path.join(os.homedir(), 'Library', 'LaunchAgents');
const plistPath = path.join(agentsDir, `${LABEL}.plist`);
const logDir = path.join(repo, 'server', 'data', 'logs');
const uid = process.getuid();
const domain = `gui/${uid}`;
const target = `${domain}/${LABEL}`;
const PROCESS_TYPES = ['Standard', 'Interactive', 'Background'];
/** launchd's own default soft limit is 256 open files; a terminal's is far higher. */
const OPEN_FILES = 65536;

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  if (i !== -1) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fail(msg, code = 1) {
  console.error(`✗ ${msg}`);
  process.exit(code);
}
/** Exit code of a restart-guard refusal (agents working / guard unreadable) —
 *  the one failure `--force` overrides; TM Bar offers Force only on it. */
const REFUSED_WHILE_WORKING = 3;

if (process.platform !== 'darwin') fail('launchd is macOS only — on another OS run `npm start` under your own supervisor.');

const cfg = loadBootConfig();
const HOST = `http://127.0.0.1:${cfg.host.port}`;

// ------------------------------------------------------------------ helpers

function launchctl(args, { quiet = false } = {}) {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' });
  if (!quiet && r.status !== 0) process.stderr.write(r.stderr || r.stdout);
  return r;
}

/** `launchctl print` parsed for the fields worth showing; null when not loaded. */
function serviceInfo() {
  const r = launchctl(['print', target], { quiet: true });
  if (r.status !== 0) return null;
  const pick = (key) => r.stdout.match(new RegExp(`^\\s*${key} = (.*)$`, 'm'))?.[1] ?? null;
  return { state: pick('state'), pid: pick('pid'), runs: pick('runs'), lastExit: pick('last exit code') };
}

function portTaken(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(800, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

async function getJson(url, timeoutMs = 2000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

/** The PATH a terminal tab would give the server: node's own dir first (nvm is
 *  usually only on an INTERACTIVE shell's PATH), then the login shell's, then
 *  the system dirs. Workers spawn `claude`, `git`, `gh`; terminals spawn $SHELL. */
function buildPath(nodeBin) {
  const shell = process.env.SHELL || '/bin/zsh';
  let login = '';
  try {
    login = execFileSync(shell, ['-l', '-c', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 10_000 });
  } catch {
    /* fall back to the inherited PATH */
  }
  const dirs = [
    path.dirname(nodeBin),
    ...(process.env.PATH ?? '').split(':'),
    ...login.split(':'),
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  const seen = new Set();
  // node_modules/.bin from `npm run` must not leak into the service's PATH
  return dirs.filter((d) => d && !d.includes(`${path.sep}node_modules${path.sep}`) && !seen.has(d) && seen.add(d)).join(':');
}

function which(bin, PATH) {
  for (const d of PATH.split(':')) {
    const p = path.join(d, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist({ node, PATH, processType, caffeinate }) {
  const env = {
    PATH,
    HOME: os.homedir(),
    SHELL: process.env.SHELL || '/bin/zsh',
    LANG: process.env.LANG || 'en_US.UTF-8',
    // host.ts: output to server/data/logs, `service: 'launchd'` in /host/status
    TM_LOG_FILES: '1',
    TM_SERVICE: 'launchd',
    ...(caffeinate ? { TM_CAFFEINATE: '1' } : {}),
  };
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join('\n');
  // Not `npm start`: npm and tsx's CLI would each sit between launchd and
  // host.ts, and launchd's SIGTERM goes to the job's main pid. `--import tsx`
  // makes host.ts the main pid itself, and its execArgv (what the API child is
  // spawned with) carries the loader on.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by scripts/service.mjs (docs/host.md § Running as a service). Re-run
     \`npm run service:install\` instead of editing: it rewrites this file. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>--import</string>
    <string>tsx</string>
    <string>server/src/host.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(repo)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <!-- restart after a crash, stay down after a clean exit (SIGTERM/SIGINT → exit 0) -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <!-- host.ts stops the API (SIGTERM, SIGKILL after 8 s) before it exits -->
  <key>ExitTimeOut</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>${xml(processType)}</string>
  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>${OPEN_FILES}</integer>
  </dict>
  <!-- only what escapes host.ts's own file logs: boot errors and crash traces -->
  <key>StandardOutPath</key>
  <string>${xml(path.join(logDir, 'launchd.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(logDir, 'launchd.log'))}</string>
</dict>
</plist>
`;
}

async function waitUp(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await getJson(`${HOST}/host/status`);
    if (s?.status === 200 && s.body?.api?.up) return s.body;
    await sleep(1000);
  }
  return null;
}

/** Wait until launchd reports the job not running (the host exited). */
async function waitStopped(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const i = serviceInfo();
    if (!i || i.state !== 'running') return true;
    await sleep(500);
  }
  return false;
}

/**
 * The API's own restart guard, read through the front door — and FAIL-CLOSED:
 * stopping the front door stops the API and every worker PTY, so only an answer
 * that says it is safe lets the action through. Safe means one of:
 *   - restart-check answered 200 with `blocked: false`;
 *   - the front door answered 503 `apiDown` — no API, so no agents to kill;
 *   - nothing listens on the front door's port at all (a dead service).
 * A timeout, an error, any other status or an unreadable body refuses; under
 * load the check can take long, so the wait is generous. `--force` overrides.
 */
async function refuseIfWorking(what) {
  if (flag('--force')) return;
  const why = await restartCheckRefusal();
  if (why) fail(`${why} — not ${what}. Wait and retry, or pass \`-- --force\` (it kills any running agents).`, REFUSED_WHILE_WORKING);
}

async function restartCheckRefusal() {
  if (!(await portTaken(cfg.host.port))) return null; // nothing running to protect
  let status;
  let body;
  try {
    const res = await fetch(`${HOST}/api/server/restart-check`, { signal: AbortSignal.timeout(20_000) });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch (e) {
    return `could not read the restart check at ${HOST}/api/server/restart-check (${e.name === 'TimeoutError' ? 'no answer within 20 s' : e.message})`;
  }
  if (status === 200 && body?.blocked === false) return null;
  if (status === 503 && body?.apiDown === true) return null;
  if (body?.blocked === true) return String(body.error ?? 'agents are working');
  return `could not read the restart check (HTTP ${status}${body?.error ? `: ${body.error}` : ''})`;
}

// ----------------------------------------------------------------- commands

async function install() {
  const processType = option('--process-type') ?? 'Standard';
  if (!PROCESS_TYPES.includes(processType)) fail(`--process-type must be one of ${PROCESS_TYPES.join(', ')}`);
  const node = option('--node') ?? process.execPath;
  const v = spawnSync(node, ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.trim();
  const [maj, min] = v.split('.').map(Number);
  if (!(maj > 22 || (maj === 22 && min >= 12))) fail(`${node} is node ${v || '?'}; the server needs >= 22.12 (v24 recommended)`);
  if (maj !== 24) console.warn(`⚠ node ${v} — v24 is the tested one (v20 segfaults under tsx). Pass \`-- --node /path/to/v24/bin/node\` to pick it.`);
  if (!fs.existsSync(path.join(repo, 'node_modules', 'tsx'))) fail('node_modules/tsx is missing — run `npm install` first');

  const loaded = serviceInfo();
  if (!loaded && !flag('--force')) {
    // Something else serves these ports — almost always `npm start` in a
    // terminal. The agent would crash-loop on EADDRINUSE (or silently adopt an
    // API it cannot respawn), so say so instead.
    if (await portTaken(cfg.host.port)) {
      fail(`port ${cfg.host.port} is in use — a front door is already running (\`npm start\` in a terminal?). Stop it first (Ctrl-C there), then install.`);
    }
    if (await portTaken(cfg.port)) {
      fail(`the API port ${cfg.port} is in use — stop that server first, or the service would adopt an API it cannot restart. \`-- --force\` to install anyway.`);
    }
  }
  if (loaded) await refuseIfWorking('reinstalling');

  const PATH = buildPath(node);
  for (const bin of ['claude', 'git']) {
    if (!which(bin, PATH)) console.warn(`⚠ \`${bin}\` is not on the service PATH (${PATH}) — workers will not start`);
  }
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  const caffeinate = !flag('--no-caffeinate');
  const body = plist({ node, PATH, processType, caffeinate });
  const tmp = `${plistPath}.tmp`;
  fs.writeFileSync(tmp, body);
  const lint = spawnSync('plutil', ['-lint', tmp], { encoding: 'utf8' });
  if (lint.status !== 0) {
    fs.rmSync(tmp, { force: true });
    fail(`plutil -lint: ${lint.stdout}${lint.stderr}`);
  }
  if (loaded) {
    console.log(`stopping the running ${LABEL}…`);
    launchctl(['bootout', target], { quiet: true });
    await waitStopped();
  }
  fs.renameSync(tmp, plistPath);
  const b = launchctl(['bootstrap', domain, plistPath]);
  if (b.status !== 0) fail(`launchctl bootstrap ${domain} ${plistPath} failed`);
  console.log(`✓ installed ${plistPath} (ProcessType ${processType}${caffeinate ? ', caffeinate -i' : ''})`);
  console.log('  waiting for the API…');
  const up = await waitUp();
  if (!up) fail(`the front door did not report the API up within 60 s — see ${path.join(logDir, 'launchd.log')}, host.log and api.log`);
  console.log(`✓ up: ${HOST} (front door pid ${serviceInfo()?.pid ?? '?'}, API pid ${up.api.pid ?? '?'})`);
  console.log(`  logs: ${logDir}/{api,host}.log — \`npm run service:logs\``);
}

async function uninstall() {
  if (serviceInfo()) {
    await refuseIfWorking('stopping');
    launchctl(['bootout', target]);
    if (!(await waitStopped())) console.warn('⚠ launchd still reports it running');
  }
  fs.rmSync(plistPath, { force: true });
  console.log(`✓ ${LABEL} stopped and removed — \`npm start\` in a terminal works as before`);
}

async function restart() {
  if (!serviceInfo()) fail(`${LABEL} is not loaded — \`npm run service:install\``);
  await refuseIfWorking('restarting');
  // SIGTERM → host.ts stops the API and exits 0, which KeepAlive leaves down;
  // kickstart then starts the fresh one. (`kickstart -k` alone would race the
  // graceful stop.)
  launchctl(['kill', 'SIGTERM', target], { quiet: true });
  if (!(await waitStopped())) fail('the front door did not exit within 40 s');
  launchctl(['kickstart', target]);
  const up = await waitUp();
  if (!up) fail(`the API did not come back within 60 s — see ${logDir}`);
  console.log(`✓ restarted: front door pid ${serviceInfo()?.pid ?? '?'}, API booted ${up.api.bootedAt}`);
}

/**
 * Start an INSTALLED agent that is not running — after a clean exit (KeepAlive
 * leaves it down), a `launchctl bootout`, or a login where it was booted out.
 * Nothing is stopped, so there is no restart guard to read. Loaded → kickstart;
 * plist on disk but not loaded → bootstrap it as written (never regenerated
 * here: that is `install`'s job); no plist → not installed. TM Bar's
 * "Start service" (docs/menubar.md § Service).
 */
async function start() {
  const i = serviceInfo();
  if (i?.state === 'running') {
    console.log(`✓ ${LABEL} is already running (pid ${i.pid ?? '?'})`);
  } else if (i) {
    if (await portTaken(cfg.host.port)) fail(`port ${cfg.host.port} is in use by something other than ${LABEL} — stop it first`);
    const k = launchctl(['kickstart', target]);
    if (k.status !== 0) fail(`launchctl kickstart ${target} failed`);
  } else if (fs.existsSync(plistPath)) {
    if (await portTaken(cfg.host.port)) fail(`port ${cfg.host.port} is in use — a front door is already running (\`npm start\` in a terminal?)`);
    const b = launchctl(['bootstrap', domain, plistPath]);
    if (b.status !== 0) fail(`launchctl bootstrap ${domain} ${plistPath} failed`);
  } else {
    fail(`${LABEL} is not installed — \`npm run service:install\``);
  }
  const up = await waitUp();
  if (!up) fail(`the API did not come up within 60 s — see ${logDir}`);
  console.log(`✓ up: ${HOST} (front door pid ${serviceInfo()?.pid ?? '?'}, API booted ${up.api.bootedAt})`);
}

async function status() {
  const i = serviceInfo();
  console.log(`${LABEL}: ${i ? `${i.state}${i.pid ? `, pid ${i.pid}` : ''}, runs ${i.runs}, last exit ${i.lastExit}` : 'not loaded'}`);
  console.log(`plist: ${fs.existsSync(plistPath) ? plistPath : '(none)'}`);
  const s = await getJson(`${HOST}/host/status`);
  if (s?.body?.host) {
    const { api, host } = s.body;
    console.log(`front door ${HOST}: ${host.service === 'launchd' ? 'launchd' : 'NOT the service (a terminal `npm start`?)'}${host.stale ? ', stale (service:restart to load host.ts changes)' : ''}`);
    console.log(`API: ${api.up ? `up, pid ${api.pid ?? '? (adopted)'}, booted ${api.bootedAt}` : 'down'}${api.restarts ? `, ${api.restarts} restarts` : ''}`);
    console.log(`logs: ${host.logDir ?? 'the terminal running it'}`);
  } else {
    console.log(`front door ${HOST}: not answering`);
  }
}

function logs() {
  const files = ['host.log', 'api.log'].map((f) => path.join(logDir, f)).filter((f) => fs.existsSync(f));
  if (!files.length) fail(`no logs in ${logDir} yet`);
  spawnSync('tail', ['-n', '50', '-F', ...files], { stdio: 'inherit' });
}

const commands = { install, uninstall, restart, start, status, logs };
if (!commands[cmd]) {
  console.error('usage: tsx scripts/service.mjs install|uninstall|restart|start|status|logs');
  process.exit(2);
}
await commands[cmd]();
