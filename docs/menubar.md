# TM Bar — the menu-bar app

A small native macOS menu-bar app that reads the task manager at a glance: is
the server up, what is running, what waits on you, is memory tight. It also
holds the server controls: Start / Stop / Restart the API, Rebuild & restart,
Pause all / Continue (§ Controls). It sits ON
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
  last error; "Rebuild & restart running"; `host.stale` → "restart `npm
  start`" (or `npm run service:restart` under launchd); dev mode.
- **Controls** (§ Controls): Restart · Stop (Start while the API is down) ·
  Rebuild & restart; the queue line (on/off, paused, suspended count) with
  Pause all or Continue; the job's progress; a confirm box; the last outcome.
- **Tasks**: running/waiting count and slots, then one row per task — title,
  repo, asks you / needs attention / waiting, elapsed (ticks every second while
  open). A click opens `/?task=<id>` (the SPA's deep link).
- **Inbox** N — questions · need you; a click opens `/inbox`.
- **Memory** free % · swap %, pressure word; the fuse's hold reason in red while
  tripped; heavy slots while any are held or queued.
- **Open task manager** (⌘O), **Quit** (⌘Q).

Pages open in the installed Brave (`com.brave.Browser`, through
`NSWorkspace.open(_:withApplicationAt:)`) and otherwise in the default browser.
In dev (`host.dev`) the page is Vite on `http://localhost:5173`, since the front
door serves no SPA there.

## Controls

Every control is the web page's own request — same route, same JSON body,
same loopback `Origin: http://127.0.0.1:<port>` (`Client.post`, a separate
URLSession with a 90 s timeout, since `/host/restart` waits for the new boot
and a suspending pause waits for compaction gates). The allowlist in `net.ts`
is not widened and no route was added: every guard and every refusal is the
server's, and the app only shows it. Logic in `Controls.swift`, view in
`ControlsView.swift`.

| control | request | confirm |
|---|---|---|
| Start (API down) | `POST /host/start {}` | no — it stops nothing |
| Stop | `POST /host/stop {force: false}` | yes, naming the repo commands / terminals that die with it (read from `GET /api/server/restart-check`) |
| Restart | `POST /host/restart {force: false}` | yes, same |
| Force stop / Force restart | the same with `{force: true}` | only offered after the refusal below, and confirmed again |
| Rebuild & restart | `POST /host/rebuild-restart {drain: true}` (the web button's default) | yes — "Drain & rebuild?" while agents work |
| Cancel drain | `POST /host/rebuild-restart/cancel {}` | no — it releases the job's pause and restarts nothing |
| Pause all | `POST /api/orchestrator/pause {}` (suspending, like the header button) | yes, with the live turn count |
| Continue | `POST /api/orchestrator/continue {}` | yes (the web button asks too: it spends money again), with the suspended count |

**Agents working.** Stop and Restart are refused by the front door while the
API's restart check is blocked (`409` with the check's body, `blocked: true`).
The app shows that check's `error` VERBATIM ("4 agent session(s) still working —
stop them first, or retry with force.") in red inside the confirm box, with an
explicit **Force stop / Force restart** button and the advice to Pause all
first. Any other refusal (`in_progress` while a rebuild runs, "this API was not
started by the front door", `not_draining`) is shown verbatim as a note,
without a Force offer — forcing would not help.

**Rebuild & restart progress.** The 2 s open-menu poll of `/host/status`
carries the job (`HostStatus.rebuild`): the step sentence with a spinner; while
draining, what the pause does not stop (`waitingFor.notPauseAware`, orange), a
"gives up in" countdown to `drainDeadline` and **Cancel drain**. When the job
ends, the outcome stays in the menu: `drain_timeout` → the job's own "Drain
timed out: … The API was NOT restarted." in red, `cancelled` in orange, any
other failure as "Rebuild & restart failed (reason): error" — each until
dismissed (×) or the next job; `done` → "Rebuilt & restarted at HH:MM" for 15
minutes, plus "still paused: press Continue" when the job left the machine
paused (`continued: false`). The icon shows `rebuilding` throughout. The app
does not reload anything — it has no build to swap.

**Queue line.** "Queue on/off" is `orchestrator.enabled` (the global queue
switch, shown, not toggled here); "Paused · N suspended" is Pause all with
`pausedTasks` (added to `/api/menubar`'s `queue`; the closed-menu
`/api/orchestrator` read already had it).

**Actor: `human`, no new `menubar` actor.** The API distinguishes only the
front door's own job (`by: 'rebuild'`) from a person; a press in the menu bar
is a person's click on loopback, exactly like the web button. So the app sends
no `by`, and the audit rows are the web's: `orchestrator.pause`/`continue`
with actor `human`, and for Stop/Restart the front door's stop intent →
`server.stopping` / `server.started` with cause "front door stop|restart
(forced)" (docs/host.md § Restart causes). A `menubar` actor would have meant
widening `HUMAN_ACTORS` and the stop-cause vocabulary for a label nobody reads
differently.

**Confirms are inline** (a box in the menu window, Cancel = Esc), not an
`NSAlert`: a modal from an `LSUIElement` menu-bar window steals focus and
closes the window it was asked from. Closing the menu drops an unanswered
confirm; a Force offer that arrives while the menu is closed waits for the
next open (dropped after 2 minutes, like the last outcome note). While a
request is in flight every control is disabled.

There is no new unauthenticated surface: everything the app can do, a
loopback `curl` with the same Origin could already do.

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
- The controls: `cd macos/TMBar && swift test` — `Tests/TMBarTests/ControlsTests.swift`
  runs the real `Store` against a front door stubbed in a `URLProtocol`
  (Origin and body of every write, confirm → 409 → Force offer with the
  refusal verbatim → forced request, rebuild as a drain, Cancel drain's
  refusal, pause/continue bodies without `by`, the `drain_timeout` outcome, a
  draining job's decode). Never the live server.
- Against the live front door, only presses refused by construction:
  `TM_BAR_LIVE=1 swift test --filter LiveRefusals` presses Restart only while
  the restart check is blocked (→ the Force offer, never confirmed) and Cancel
  drain only while no drain runs. 2026-11-06: refusal shown verbatim
  ("4 agent session(s) still working — stop them first, or retry with force.").

## Files

| file | what |
|---|---|
| `macos/TMBar/Package.swift` | SwiftPM manifest (Swift 6 language mode, macOS 14) |
| `Sources/TMBar/App.swift` | `MenuBarExtra` scene + the icon label |
| `Sources/TMBar/Store.swift` | the poller, sleep/wake, `BarState` |
| `Sources/TMBar/MenuView.swift` | the menu window |
| `Sources/TMBar/Controls.swift`, `ControlsView.swift` | the server controls (§ Controls) |
| `Tests/TMBarTests/` | `swift test`: controls against a stubbed front door; opt-in live refusals |
| `Sources/TMBar/Client.swift` | URLSessions (ephemeral, no proxy; reads 3 s, writes 90 s), loopback Origin on every write |
| `Sources/TMBar/Config.swift` | front door URL resolution |
| `Sources/TMBar/HostModels.swift`, `ApiModels.swift` | decodable subsets of `HostStatus`, `OrchestratorStatus`, `MenubarSummary` |
| `Sources/TMBar/Browser.swift` | Brave-or-default opener, deep links |
| `scripts/menubar.mjs` | build + bundle + sign, open |
| `server/src/routes/menubar.ts`, `shared/src/menubar.ts`, `server/src/inbox-input.ts` | the summary route |
