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
  to /Applications; to start it at login tick **Open TM Bar at login** in the
  menu (§ Open at login). `TMNodePath` = the node that ran the build
  (`TM_BAR_NODE` overrides) — the node the Service actions run with (§ Service).
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
- **Service**: how the front door runs — the launchd agent (with its pid), a
  terminal `npm start`, or dev — and, when it does not answer, what launchd says
  (running but not answering yet / stopped / installed but not loaded / not
  installed); the service actions and the logs (§ Service).
- **Open TM Bar at login** (§ Open at login).
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

## Service

The front door as a per-user launchd agent (docs/host.md § Running as a
service) from the menu. The app holds no plist logic. It runs
`scripts/service.mjs` the way `npm run service:*` does:
`<node> --import tsx scripts/service.mjs <command> [--force]`, an argv in
`TMRepoRoot`, never a shell. So every rule stays in one place: the port checks,
the fail-closed restart guard, plist generation and `plutil -lint`.

**Which node**: `TM_BAR_NODE`, `defaults write com.taskmanager.bar nodePath …`,
Info.plist `TMNodePath` (the build's node), the installed plist's
`ProgramArguments[0]`, then `/opt/homebrew/bin/node` and `/usr/local/bin/node`.
The first executable one wins. A GUI app's PATH has no nvm, so the build
records the node. Build with the node the service should run (v24): `install`
writes `process.execPath` into the plist. The child's PATH is that node's dir
first, then the app's own. `install` adds the login shell's PATH as it always
does, so `claude`/`git`/`gh` from Homebrew are found (measured: a `zsh -l` from
an empty environment yields `/opt/homebrew/bin` first). `TM_SERVICE_LABEL` and
`TM_LAUNCH_AGENTS_DIR` are passed explicitly, so the script and the app always
look at the same job.

**Mode**, read every poll while the menu is open, with no node involved:
`launchctl print gui/<uid>/<label>` (`state`, `pid`; the first match, as in
service.mjs) plus whether the plist exists. `host.service === 'launchd'` in
`/host/status` decides "runs as the service". The label is `TM_SERVICE_LABEL`,
else `defaults … serviceLabel`, else `com.taskmanager.server`.

| front door | launchd | buttons |
|---|---|---|
| answers, `service: launchd` | — | **Restart service**, **Reinstall** (rewrites the plist), **Uninstall…** |
| answers, a terminal / dev | no plist | **Install service** disabled: "stop npm start (Ctrl-C), then Install". The installer refuses while the port is taken anyway. |
| answers, a terminal / dev | plist or loaded | **Uninstall service…** |
| not answering | loaded, running | **Restart service** (+ Uninstall…) |
| not answering | loaded, not running, or plist only | **Start service** (+ Uninstall…) |
| not answering | none | **Install service** |

- **Start service** = the new `service.mjs start` (`npm run service:start`).
  Already running → nothing. Loaded → `launchctl kickstart`. Plist on disk but
  not loaded → `launchctl bootstrap` of the file as written (regenerating it is
  `install`'s job). No plist → "not installed". Then it waits for the API, like
  install. Nothing is stopped, so no guard is read. A port held by something
  else refuses.
- Restart, Reinstall and Uninstall stop the front door, so service.mjs reads
  `restart-check` first (fail-closed). A refusal exits **3**
  (`REFUSED_WHILE_WORKING`, the only exit the app treats as overridable). The
  menu shows the script's line verbatim ("4 agent session(s) still working —
  …") and a **Force … — kills running agents** button. Force takes two presses
  (the second within 4 s; the label turns red to "Confirm: kill agents and
  …"), then reruns with `--force`. **Uninstall…** is two-press too: afterwards
  nothing serves the task manager until `npm start`.
- One command at a time. A spinner shows "Restarting the service…" and so on,
  then the script's last `✓`/`✗` line plus any `⚠` lines (an old node, `claude`
  missing from the service PATH). Its output also goes to the unified log
  (`service <cmd> exit=<n> <line>`). The command keeps running if the menu
  closes. A 180 s ceiling SIGTERMs a hung script: guard 20 s + stop 40 s +
  login shell 10 s + up 60 s is install's worst case.

**Logs**: buttons **API**, **Front door** and **launchd** open `api.log`,
`host.log` and `launchd.log` in Console.app (`com.apple.Console`, else the
default app). The folder button reveals the folder in Finder. The folder is
`host.logDir` from `/host/status`, else `<TMRepoRoot>/server/data/logs` (the
front door is down, or it is a terminal one that writes no files). Only files
that exist get a button.

None of this is an HTTP surface: the app runs a local script as the logged-in
user, exactly what that user can already type.

## Open at login

**Open TM Bar at login** registers the app with `SMAppService.mainApp`
(ServiceManagement, macOS 13+): the system's own Login Items list, with no
helper and no plist of ours. `requiresApproval` shows "Allow it in System
Settings → Login Items" with an **Open** button
(`SMAppService.openSystemSettingsLoginItems`). An error is shown under the
toggle. The toggle is hidden when the binary is not in a `.app` bundle (`swift
run`).

**Verified with the ad-hoc signature** (2026-11-06, macOS 26): `register()` →
`enabled`. It stays `enabled` after `npm run menubar:build` rebuilds and
re-signs the bundle at the same path (new cdhash). `unregister()` →
`notRegistered`. The registration is tied to the bundle's PATH, so register
the copy you keep: the main checkout's `macos/TMBar/build/TM Bar.app`, or a
copy in /Applications. Never register a worktree's build: the worktree is
deleted when its task lands. A launch at a real login was not exercised
(that needs a logout). `sfltool dumpbtm`, which lists the entry, needs admin.

**Fallback** if a future macOS refuses ad-hoc apps (status `notFound` or an
error on register): a LaunchAgent that opens the bundle,
`~/Library/LaunchAgents/com.taskmanager.bar.plist` with `ProgramArguments`
`/usr/bin/open`, `-a`, `<path>/TM Bar.app` and `RunAtLoad` true, loaded with
`launchctl bootstrap gui/$(id -u) <plist>`. No `KeepAlive`, because Quit must
stay quit.

## Look

Native chrome: system font, SF Symbols, system colours (green running, orange
paused/attention, red stopped/fuse). No custom colours, so nothing to map onto
the `--tm-*` sheet; a future custom colour must come from that sheet.

## Cost

The poll is two small HTTP GETs every 5 s with a 1 s timer tolerance
(coalesced wakeups); decoding and diffing are microseconds, and an unchanged
poll redraws nothing. While the menu is OPEN each poll also spawns one
`launchctl print` for § Service (a few ms; never while closed); node runs only
when a service button is pressed.

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
- `--env TM_BAR_LOGIN=on|off` registers or unregisters the login item at
  launch. `--env TM_BAR_SERVICE_ACTION=install|start|restart|uninstall` runs
  that service command once at launch, through the same `Store.runService` as
  the button. Both log their result. Verification only, like
  `TM_BAR_ALWAYS_OPEN`.
- **Rehearsal service** (how § Service was verified on 2026-11-06, with the
  real front door in a terminal and agents working): in a worktree, write
  `server/data/config.json` = `{"port":5185,"host":{"port":5186}}`. Then launch
  with `--env TM_BAR_URL=http://127.0.0.1:5186 --env
  TM_SERVICE_LABEL=com.taskmanager.server.rehearsal --env
  TM_LAUNCH_AGENTS_DIR=<scratch dir>`. Results: install → `exit=0 ✓ up`,
  `svc=…:running/pid…`, `runs-as=launchd`, `api.log`/`host.log`/`launchd.log`
  written. restart → `exit=0`. `launchctl kill SIGTERM` (clean exit, left
  down) then start → kickstart, `exit=0`. `launchctl bootout` then start →
  bootstrap, `exit=0`. uninstall → `exit=0`, plist gone. The refusal: the same
  label with `--env TM_HOST_PORT=5176`, so the script reads the LIVE front
  door's restart-check (a GET). restart → `exit=3 ✗ 4 agent session(s) still
  working — …`, and the rehearsal agent's pid was unchanged.

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
| `Sources/TMBar/Service.swift` | `launchctl print` reading, the service.mjs runner, Console.app logs |
| `Sources/TMBar/LoginItem.swift` | `SMAppService.mainApp` |
| `scripts/service.mjs` | the launchd agent (docs/host.md § Running as a service); `start`, exit 3 on a guard refusal |
| `scripts/menubar.mjs` | build + bundle + sign, open |
| `server/src/routes/menubar.ts`, `shared/src/menubar.ts`, `server/src/inbox-input.ts` | the summary route |
