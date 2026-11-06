#!/usr/bin/env node
/**
 * Build / open TM Bar, the menu-bar status app over the front door
 * (docs/menubar.md). Kept out of the npm workspaces on purpose: `npm run
 * typecheck|build|test` never need Xcode or Swift.
 *
 *   npm run menubar:build            swift build -c release + "TM Bar.app" bundle, ad-hoc signed
 *   npm run menubar:open             build if the bundle is missing, then open it
 *   npm run menubar:build -- --debug   debug build (faster compile, same bundle layout)
 *
 * The bundle lands in macos/TMBar/build/TM Bar.app (git-ignored). Its
 * Info.plist carries `TMRepoRoot` = this checkout, which the app reads to find
 * server/data/config.json (`host.port`, default 5176). TM_BAR_REPO overrides
 * the recorded root (e.g. build in a worktree, point at the main checkout).
 * `TMNodePath` = the node running this script (TM_BAR_NODE overrides): the
 * node the app's Service actions run `scripts/service.mjs` with, since a GUI
 * app's PATH has no nvm — build with the node the service should use (v24).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = path.join(repo, 'macos', 'TMBar');
const outDir = path.join(pkg, 'build');
const APP_NAME = 'TM Bar';
const app = path.join(outDir, `${APP_NAME}.app`);
const BUNDLE_ID = 'com.taskmanager.bar';
const EXECUTABLE = 'TMBar';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'build';
const debug = argv.includes('--debug');

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { stdio: 'inherit', ...opts });
  if (r.error) fail(`${bin}: ${r.error.message}`);
  if (r.status !== 0) fail(`${bin} ${args.join(' ')} exited ${r.status}`);
  return r;
}

function plistEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function infoPlist(repoRoot, version, nodePath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${plistEscape(version)}</string>
  <key>CFBundleVersion</key><string>${plistEscape(version)}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
  <key>TMRepoRoot</key><string>${plistEscape(repoRoot)}</string>
  <key>TMNodePath</key><string>${plistEscape(nodePath)}</string>
</dict>
</plist>
`;
}

function build() {
  if (process.platform !== 'darwin') fail('TM Bar is macOS only.');
  const which = spawnSync('xcrun', ['--find', 'swift'], { encoding: 'utf8' });
  if (which.status !== 0) fail('swift not found — install Xcode or the Command Line Tools.');

  const config = debug ? 'debug' : 'release';
  run('swift', ['build', '-c', config, '--package-path', pkg]);
  const binDir = spawnSync('swift', ['build', '-c', config, '--package-path', pkg, '--show-bin-path'], {
    encoding: 'utf8',
  });
  if (binDir.status !== 0) fail('swift build --show-bin-path failed');
  const binary = path.join(binDir.stdout.trim(), EXECUTABLE);
  if (!fs.existsSync(binary)) fail(`built binary missing: ${binary}`);

  // Assemble next to the old bundle and swap, so an open app is never half-written.
  const staging = `${app}.next`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.join(staging, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(staging, 'Contents', 'Resources'), { recursive: true });
  fs.copyFileSync(binary, path.join(staging, 'Contents', 'MacOS', EXECUTABLE));
  fs.chmodSync(path.join(staging, 'Contents', 'MacOS', EXECUTABLE), 0o755);

  const repoRoot = process.env.TM_BAR_REPO ? path.resolve(process.env.TM_BAR_REPO) : repo;
  const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version ?? '0.1.0';
  const nodePath = process.env.TM_BAR_NODE ? path.resolve(process.env.TM_BAR_NODE) : process.execPath;
  fs.writeFileSync(path.join(staging, 'Contents', 'Info.plist'), infoPlist(repoRoot, version, nodePath));
  fs.writeFileSync(path.join(staging, 'Contents', 'PkgInfo'), 'APPL????');

  // Ad-hoc signature: enough for Gatekeeper on the machine that built it.
  run('codesign', ['--force', '--sign', '-', '--timestamp=none', staging]);

  fs.rmSync(app, { recursive: true, force: true });
  fs.renameSync(staging, app);
  console.log(`✓ ${path.relative(repo, app)}  (repo root: ${repoRoot}, node: ${nodePath})`);
}

function open() {
  if (!fs.existsSync(path.join(app, 'Contents', 'MacOS', EXECUTABLE))) build();
  run('open', [app]);
  console.log(`✓ opened ${APP_NAME} — look for its icon in the menu bar`);
}

if (cmd === 'build') build();
else if (cmd === 'open') open();
else fail(`unknown command ${cmd} (build | open)`);
