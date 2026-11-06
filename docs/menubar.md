# TM Bar — the menu-bar app

A small native macOS menu-bar app that reads the task manager at a glance: is
the server up, what is running, what waits on you, is memory tight. It sits ON
TOP of the Node front door (`server/src/host.ts`, [host.md](host.md)) and talks
to nothing else. It is not a second server: no Swift proxy, no Swift remote
gate; `tailscale serve` → the remote listener (5177) and the iPhone path are
untouched (decisions.md 2026-11-06).

## Build and run

```
npm run menubar:build            # swift build -c release + "TM Bar.app", ad-hoc signed
npm run menubar:open             # build if missing, then open it
npm run menubar:build -- --debug # debug compile, same bundle layout
```

- Code: `macos/TMBar/`, a Swift Package (SwiftUI `MenuBarExtra`, macOS 14+, no
  third-party dependencies). Build script: `scripts/menubar.mjs` (plain node).
- Bundle: `macos/TMBar/build/TM Bar.app` (git-ignored). `Info.plist` sets
  `LSUIElement` (no Dock icon, no app menu), `NSAllowsLocalNetworking`, and
  `TMRepoRoot` = the checkout it was built from. The bundle is assembled in
  `TM Bar.app.next` and swapped in, then `codesign --sign -` (ad-hoc) — enough
  for Gatekeeper on the Mac that built it. Double-click it in Finder, or drag it
  to /Applications; to start at login add it under System Settings → General →
  Login Items.
- It is outside the npm workspaces: `npm run typecheck|build|test` never need
  Xcode or Swift.

### Finding the front door

In order: `TM_BAR_URL` in the environment (a rehearsal instance or a test
harness; `open --env TM_BAR_URL=… "TM Bar.app"`), then
`defaults write com.taskmanager.bar hostURL http://127.0.0.1:5176`, then
`host.port` from `<TMRepoRoot>/server/data/config.json`, then
`http://127.0.0.1:5176`. Always `127.0.0.1`, never `localhost`: the front door
binds IPv4 loopback and `isAllowedHost` pins the port. Building in a worktree
records the worktree as `TMRepoRoot`; `TM_BAR_REPO=<main checkout> npm run
menubar:build` points it at the main checkout's config instead (only matters
when `host.port` is not the default).

## What it reads

| poll | requests | when |
|---|---|---|
| closed menu | `GET /host/status` + `GET /api/orchestrator` | every 5 s |
| open menu | `GET /host/status` + `GET /api/menubar` | at once on open, then every 2 s |
| Mac asleep | nothing | `NSWorkspace.willSleep` cancels the loop, `didWake` restarts it |

Both GETs are plain loopback GETs with no Origin, which the front door's and
the API's guards already allow (`net.ts`: Host allowlist on everything, Origin
judged only on non-GET). When `/host/status` fails the API reads are skipped;
when it says `api.up: false` only the host status is read. An unchanged poll
reassigns nothing, so nothing redraws, and a poll cut short by the loop's
restart (menu opened, Mac going to sleep) writes nothing — it is not a reading,
so the icon never flickers to *unreachable*. No WebSocket in v1: the events socket
needs the per-boot session token and pushes every board change, which costs
more than two small GETs every 5 s.

### `GET /api/menubar`

`server/src/routes/menubar.ts`, built by the pure `buildMenubarSummary`
(`shared/src/menubar.ts`, type `MenubarSummary`). Read-only, same guards as
every API GET, no data that `/api/orchestrator`, `/api/tasks`, `/api/runs` and
the inbox sources do not already expose.

- `queue` — `enabled`, `paused` (Pause all), `running` (live worker PTYs),
  `concurrency`, `aux`.
- `tasks` — every `running`/`waiting` task: id, title, repo name, status, the
  live worker run's `startedAt` (the elapsed clock), `needsAttention`, `asking`;
  longest-running first.
- `inbox` — `total` (what the SPA's Inbox chip shows: every `buildInbox` item but
  stale drafts), `questions`, `needsYou` (= total − questions), `urgent` (a
  question or needs-attention item). It runs THE shared `buildInbox` over the
  same rows Telegram's board reads (`server/src/inbox-input.ts`
  `loadInboxSources`, extracted from `telegram/board.ts` so the two cannot
  drift), unscoped — every workspace.
- `memory` — the fuse (docs/memory.md): free %, swap %/MB, macOS pressure level,
  `armed` (a limit is set), `tripped`, `reason`, `hold`. The fuse samples only
  while armed, so with it off the route takes its own reading
  (`sampleSystemMemory`, the same `sysctl`, cached 15 s; a failed reading is
  `null` fields, never a failed summary).
- `heavy` — heavy slots `max`/`held`/`waiting` (docs/memory.md § Heavy work).

Concurrent calls within 1 s share one read. An API older than this route
answers 404; the menu then says so ("Rebuild & restart it") and keeps the icon
on `/api/orchestrator`.

## The icon

One SF Symbol for the most urgent state, plus the running count whenever the
API is up:

| state (first that holds) | symbol |
|---|---|
| front door not answering | `exclamationmark.triangle` |
| Rebuild & restart in flight (`rebuild.state` not idle/done/failed) — its restart takes the API down on purpose, so this outranks stopped | `arrow.triangle.2.circlepath` |
| API stopped (`api.up: false`) | `stop.circle` |
| memory fuse holding (`memory.hold`) | `memorychip` |
| Pause all | `pause.circle` |
| workers running | `bolt.circle.fill` + count |
| idle | `checklist` |

## The menu

- **Server**: API up · booted N ago · restarts; last exit (code/signal, when),
  last error; a running Rebuild & restart's step, or the last one's failure;
  `host.stale` → "restart `npm start`" (or `npm run service:restart` under
  launchd); dev mode.
- **Tasks**: running/waiting count and slots, then one row per task — title,
  repo, asks you / needs attention / waiting, elapsed (ticks every second while
  open). A click opens `/?task=<id>` (the SPA's deep link).
- **Inbox** N — questions · need you; a click opens `/inbox`.
- **Memory** free % · swap %, pressure word; the fuse's hold reason in red while
  tripped; heavy slots while any are held or queued.
- **Open task manager** (⌘O), **Start server** (only when the API is stopped),
  **Quit** (⌘Q).

Pages open in the installed Brave (`com.brave.Browser`, through
`NSWorkspace.open(_:withApplicationAt:)`) and otherwise in the default browser.
In dev (`host.dev`) the page is Vite on `http://localhost:5173`, since the front
door serves no SPA there.

**Start server** is the app's only write: `POST /host/start` with
`Origin: http://127.0.0.1:<port>` (the front door's own loopback origin,
already allowed — the allowlist is not widened) and `{}`. There is no new
unauthenticated surface: everything the app can do, a loopback `curl` could
already do.

## Look

Native chrome: system font, SF Symbols, system colours (green running, orange
paused/attention, red stopped/fuse). No custom colours, so nothing to map onto
the `--tm-*` sheet; a future custom colour must come from that sheet.

## Cost

The poll is two small HTTP GETs every 5 s with a 1 s timer tolerance
(coalesced wakeups); decoding and diffing are microseconds, and an unchanged
poll redraws nothing.

### Measurements

2026-11-06, the 8 GB M-series Mac, release build, `ps -o cputime` over 60 s
against the live front door (two agents running on the machine):

| mode | CPU time / 60 s | ≈ CPU | RSS |
|---|---|---|---|
| menu closed (5 s: `/host/status` + `/api/orchestrator`) | 60–70 ms | 0.1 % | ~60–70 MB |
| menu open (`TM_BAR_ALWAYS_OPEN=1`, 2 s: `/host/status` + `/api/menubar`) | 170 ms | 0.3 % | ~70 MB |

`top` read the closed-menu process at 0.1 %. `/api/menubar` answered in
under 1 ms on a copy of the live DB (≈1,000 tasks). On the server side, a
`/host/status` costs the front door one `/api/health` probe.

## Verifying

- `log stream --predicate 'subsystem == "com.taskmanager.bar"'` — one line per
  CHANGE of what the menu would show (`state=… tasks=[…] inbox=total/q/you
  mem=…`).
- `open -n --env TM_BAR_ALWAYS_OPEN=1 "macos/TMBar/build/TM Bar.app"` polls as
  if the menu were open (summary route, 2 s), so the log shows tasks, Inbox and
  memory without a click. Verification only.
- `--env TM_BAR_URL=http://127.0.0.1:<port>` points an instance at a test
  harness or a closed port (→ `state=unreachable`).
- The route itself: `server/src/menubar.test.ts` (`npm test`).

## Files

| file | what |
|---|---|
| `macos/TMBar/Package.swift` | SwiftPM manifest (Swift 6 language mode, macOS 14) |
| `Sources/TMBar/App.swift` | `MenuBarExtra` scene + the icon label |
| `Sources/TMBar/Store.swift` | the poller, sleep/wake, `BarState` |
| `Sources/TMBar/MenuView.swift` | the menu window |
| `Sources/TMBar/Client.swift` | URLSession (ephemeral, 3 s timeout, no proxy), loopback Origin on the write |
| `Sources/TMBar/Config.swift` | front door URL resolution |
| `Sources/TMBar/HostModels.swift`, `ApiModels.swift` | decodable subsets of `HostStatus`, `OrchestratorStatus`, `MenubarSummary` |
| `Sources/TMBar/Browser.swift` | Brave-or-default opener, deep links |
| `scripts/menubar.mjs` | build + bundle + sign, open |
| `server/src/routes/menubar.ts`, `shared/src/menubar.ts`, `server/src/inbox-input.ts` | the summary route |
