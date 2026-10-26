# The front door — splitting the page from the server

`server/src/host.ts` is a second, deliberately boring process. It serves the
built SPA and reverse-proxies `/api` and `/ws` to the API server, and it
supervises that API as a child. Everything here exists to buy one property:

> **the page and the server no longer share a lifetime.**

## Why

`npm start` used to be one process. Fastify served `web/dist` *and* the API on
:5175, so the moment the server stopped there was no page either — and the
button that restarts the server lives on that page. Restart, and you are
watching a browser tab that cannot reload; if the replacement fails to bind,
there is nothing left to press. (It did fail: see the handoff race below.)

Dev was only half-split. Vite already owned :5173 and stayed up on its own, but
it can only *proxy* to a server; it cannot start one. And a page loaded while
the API was down never recovered — the events socket is gated on a token
fetched exactly once at mount, so a failed first fetch meant no socket, ever.

## Shape

```
browser ─→ :5176  front door  ──proxy /api,/ws──→ :5175  API server
                  │  serves web/dist                    (spawned + watched
                  │  /host/status|start|stop|restart      by the front door)
```

Dev is the same picture with Vite in front: `:5173` proxies `/api` + `/ws`
straight to the API and `/host` to the front door, which is still the process
that owns the API child.

| command | processes | open |
|---|---|---|
| `npm run dev` | front door (+ API child under `tsx watch`), Vite | **:5173** |
| `npm start` | front door (+ API child) | **:5176** |
| `npm run dev:server` | API alone, `tsx watch` | — |
| `npm run dev:web` | Vite alone | :5173 |
| `npm run start:api` | API alone, serving `web/dist` itself | :5175 |

`start:api` is the old single-process behaviour, kept because it is the smallest
thing that runs and the right answer when the front door is what you suspect.
The API still serves `web/dist` at :5175 when it is there — that path was not
removed, it just stopped being the recommended one.

Ports come from `server/data/config.json`: `port` (API, 5175) and `host.port`
(front door, 5176). A config file that predates `host` gets the default without
being rewritten. `TM_HOST_PORT` overrides the front door for a throwaway
instance; the two ports must differ and both are validated at load.

## A reverse proxy, not a second origin

The SPA addresses `/api/...` relative and builds its WebSocket URLs from
`location.host`. Keeping the front door a *proxy* means all of that keeps
working unchanged, and — the actual reason — it means the security model is
untouched: no CORS layer, and no loosening of `isAllowedHost`, which pins the
`Host` header's port to the server's own. That equality check is the
DNS-rebinding guard on a server whose terminal WebSocket is a code-execution
surface. A second origin would have required weakening it.

So the proxy rewrites **`Host`** (so the API's allowlist passes) and passes
**`Origin`** through untouched (so the API still judges it; the one exception is
an admitted remote request, § The remote gate) — exactly what
Vite's `changeOrigin: true` does in dev. End to end, a terminal or events
socket opened through :5176 is still refused for a bad token, a foreign origin
or a missing origin, because the API is still the one deciding.

The front door applies the same `isAllowedHost` / `isAllowedOriginHost`
predicates to *itself*, against its own port, and binds loopback unless LAN mode
is on — in which case it binds `::` (dual-stack; `0.0.0.0` is IPv4-only and
loses `localhost` on macOS) and widens to private addresses only, mirroring
`docs/mobile.md`. It is not a way around any of that.

No new dependency: `node:http` plus `node:net`. This is the process that has to
still be running when nothing else is.

## The remote gate (`tailscale serve` → here)

Remote access (`docs/remote-access.md`) puts `tailscale serve` in front of this
process: it terminates HTTPS for the Mac's MagicDNS name on the tailnet and
forwards to the front door, keeping the original port-less `Host` and
stamping `Tailscale-User-Login` with the connecting person's identity. The gate
lives HERE, not in the API, because the proxy rewrites `Host` to
`127.0.0.1:<api>` and the API can no longer tell a request from the phone from
one typed at the Mac.

**Remote-ness is decided by the listener, never by `Host`.** serve forwards the
client's `Host` verbatim, so `curl -H 'Host: 127.0.0.1:5176' https://<name>/`
arrives looking local. With `remote.enabled` the front door opens a SECOND
listener, `127.0.0.1:<remote.port>` (default 5177, always loopback), which is the
only thing serve points at. EVERY request and WS upgrade on it, `/host/*`
included, goes through `checkRemote()` in `server/src/remote.ts`:

1. 403 (`{"error":"forbidden: <reason>"}`; a WS upgrade gets a bare `403` and
   the socket closes) unless ALL of: `remote.enabled`; `Host` is EXACTLY
   `remote.hostname`, port-less or `:443` (a loopback Host is `forbidden host`,
   and the match is never a `.ts.net` suffix); the TCP peer is loopback;
   `Tailscale-User-Login` is on `remote.allowedLogins` (case-insensitive,
   exact); and `Origin` is exactly `https://<hostname>` — required on a WS
   upgrade and on every method but GET/HEAD, and refused on any method when
   present and different.
2. Admitted: every `tailscale-*` header is stripped, and the Origin — just
   verified — is **rewritten to this front door's loopback origin**
   (`http://127.0.0.1:<host port>`). The API's Origin checks and the `/host/*`
   check below therefore stay loopback/LAN-only; the API has no remote code path
   at all. See `docs/decisions.md` 2026-09-29 for why this and not a `net.ts`
   entry.

The MAIN listener (`host.port`) refuses anything that looks proxied: a request
with `X-Forwarded-For`/`-Host`/`-Proto` (serve adds all three) or any
`Tailscale-*` header gets 403 `proxied requests are not served on the local
port` (`looksProxied`). That is the tripwire for serve pointed at 5176 by
mistake, which would otherwise reopen the loopback-Host bypass. Nothing local
sends those headers (the Vite dev proxy has no `xfwd`).

Refusals are logged at most once a minute per reason. The FIRST admitted request
of each login per front-door boot is audited: this process has no storage, so it
POSTs `{login, userAgent}` to `POST /api/host/remote-login`, which writes a
`tm_events` row (`kind: 'remote.login'`, `actor: 'remote'`). That route takes an
`x-tm-host-token` secret the front door mints at every boot into
`server/data/host.token` (0600) — a file rather than the child's env so an
adopted API can read it too — so the remote client this process proxies for
cannot write sign-in rows. A failed hand-off (API down) is retried on that
login's next request.

## Supervision

- **Spawn** on boot, with `TM_SUPERVISED=1` in the child's environment.
- **Adopt** instead, if something is already listening on the API port — a
  `npm run dev:server` in another terminal is a normal setup, and shadowing or
  killing it would be a surprise. Adopted means `managed: false`: the front door
  proxies to it and can ask it to restart *itself*, but cannot respawn it.
- **Auto-restart** on unexpected exit, with backoff (500ms doubling to 15s,
  reset once a child has lived 10s). An explicit `/host/stop` sets
  `desired: 'down'` and is not undone by the exit watcher.
- **Kill the tree, not the pid.** In dev the child is `tsx watch`, which runs the
  real server as a grandchild; the child is spawned `detached` (its own process
  group) and signalled with `kill(-pid)`, escalating SIGTERM → SIGKILL after 8s.
  Detached also means it does not die with the front door, which is why every
  exit path stops it explicitly.
- **Wait for the port**, not for a guess: a replacement is spawned only once
  nothing is listening on the API port.

`TM_SUPERVISED=1` changes exactly one thing inside the API: `POST
/api/server/restart` **exits** instead of detaching a replacement of its own.
Two supervisors racing for one port is the failure that flag prevents — the
self-respawn would be a process the front door does not know about and cannot
stop, and the front door's own replacement would then lose to `EADDRINUSE`.

## Control API (`/host/*`)

| route | does |
|---|---|
| `GET /host/status` | `HostStatus` (`@tm/shared`): api up/managed/pid/port/bootedAt/restarts/desired/lastExit/lastError, host port/dev/spaBuilt/buildId/stale, and `rebuild` (the job below) |
| `POST /host/start` | start the API if it is not answering; 200 with `already: true` if it is |
| `POST /host/stop` | stop a **managed** API; 409 on one it merely adopted; 409 `in_progress` during a rebuild |
| `POST /host/restart` | managed: stop → wait → spawn. Adopted: forward to `POST /api/server/restart`; 409 `in_progress` during a rebuild |
| `POST /host/rebuild-restart` | start the Rebuild & restart job (below): 202, or 409 `in_progress` / `not_quiet`. Body `{force?, typecheck?}` |
| `GET /host/rebuild-restart` | the job alone (`RebuildJob`) |

`stop` and `restart` refuse while agents are working, and they do not restate
the rule: they `GET /api/server/restart-check` and forward the API's own answer
verbatim (`{blocked, error, running, aux, services}` — `aux` was `headless` before every claude became a terminal). `{"force": true}`
is the override, same as the API's. An API that is not answering cannot be
killing anything, so a down server is never blocked.

The routes are guarded like the API's: `Host` allowlist on everything, `Origin`
allowlist on non-GET, because a drive-by page must not be able to stop the
server blind. Reached through the remote name they pass the remote gate first
(identity + exact Origin, which is then required on every POST), so the
tailnet name never exposes them unauthenticated.

## What the UI does with it

The header's server pill now distinguishes two things it used to call `offline`:

- **`offline`** — the events socket is down but the front door either is not
  there or still sees the API. Keep retrying; nothing to press.
- **`stopped`** — the front door answered and says the API is not running. The
  button becomes **Start server**, and its tooltip carries the last exit or
  error. This is the case that used to be unreachable, because the page died
  with the server.

A phone's header has no room for that pill, so the phone gets the same two
readings as a sticky banner at the top of the page, with **Start server** on the
`stopped` one (`docs/mobile.md` § Server offline). Both call one hook,
`useServerStart()` in `Layout.tsx`, so they cannot disagree about when Start is
offered.

`/host/status` is polled every 3s only while the socket is down; with the socket
up the API is already telling the page everything. A page not served through a
front door gets a failed fetch, `host: null`, and no new controls — `npm run
dev:web` alone still works, it just has nothing to start.

The bootstrap in `web/src/state.tsx` now retries `/api/session` until it
succeeds. "Load the page first, start the server second" is an ordinary sequence
once the page outlives the server.

## Rebuild & restart

One press after an agent finished work on the task manager itself: build the
SPA, restart the API onto the new server code, reload the window. The usual
sequence is **Pause all** (`docs/pause.md` § Restart while paused) → **Rebuild &
restart** → **Continue**.

**Where it runs.** In the front door, as a job (`runRebuild` in `host.ts`),
because the API is the thing it restarts. The steps are `server/src/rebuild.ts`
and nothing else; `scripts/rebuild-restart.mjs` (`npm run rebuild:restart [--
--force] [-- --no-typecheck]`) is a client of the route when a front door
answers, and runs the same `rebuild.ts` steps itself when none does (then
restarting through `POST /api/server/restart`, or reporting "nothing to
restart" when no API is up). It runs under `tsx`, because the steps are
TypeScript shared with the front door. One job at a time: a second press is 409
`in_progress`, and so are `/host/stop` and `/host/restart` while it runs. The
claim is taken synchronously, before the guard's await, so two quick presses
cannot both start a build.

**Steps.**

1. **Guard** — the same `restart-check` as `/host/restart`: 409 `reason:
   'not_quiet'` with the counts while any worker or aux session is live; `{force:
   true}` overrides. It does NOT require `paused` — quiet is the precondition —
   but the button nudges Pause all, because an unpaused queue can claim a task
   during the build.
2. **Build** (skipped in dev) — `vite build --outDir dist.next --emptyOutDir`,
   never in place (vite empties its outDir first, so a broken build in `dist`
   would leave the front door serving nothing). Success → `swapDist()`: `dist` →
   `dist.prev`, `dist.next` → `dist`, delete `dist.prev`, synchronously, so the
   front door serves no request between the renames. Failure → the partial
   `dist.next` is removed, the old `dist` is untouched, nothing restarts, the
   job is `failed` (`reason: 'build'`) with the log's last 40 lines.
3. **Typecheck** — both `tsc` passes, as `npm run typecheck`. **Decided:** on by
   default in both modes (a restart is the step that cannot be taken back, and a
   server that does not typecheck may not boot); `{typecheck: false}` /
   `--no-typecheck` skips it. Failure refuses the restart (`reason:
   'typecheck'`) and leaves the new dist in place — it is already being served
   and is harmless; open tabs are offered the reload.
4. **Guard again** — the build took a minute; an agent that started meanwhile
   fails the job with `reason: 'not_quiet'` instead of being killed.
5. **Restart** — managed: `stopApi` → spawn; adopted: the API's own restart
   route. Then wait up to 60 s for `/api/health` to answer with a **new**
   `bootedAt` (merely "up" is not enough — the old one was up). Timeout →
   `failed`, `reason: 'timeout'`. The front door keeps respawning a crashing
   child with its usual backoff (500 ms doubling to 15 s), so the UI shows the
   server offline/stopped with **Start server**, and the API's own output (a
   broken server file's stack trace) is in the front door's terminal.

Steps are run with `process.execPath` (vite's and tsc's JS entry, argv, never a
shell), output captured, ANSI stripped. A front door shutting down mid-job
SIGKILLs the build or typecheck child.

**Dev mode** (`TM_DEV=1`, `npm run dev`): no build — Vite serves source and
hot-reloads — so typecheck → restart → reload. The page's build id is `dev` and
the build-id comparison is off.

**The front door is not reloaded.** It is the process running the job. At boot
it hashes `host.ts`, `config.ts`, `net.ts`, `remote.ts` and `rebuild.ts`;
`/host/status` reports `host.stale: true` once they differ (sticky), and the job
carries `hostStale`. The header then shows **Front door stale**: stop and re-run
`npm start` to load those changes. The very first deploy of this feature is
such a case — a front door that predates the route has no `rebuild` in its
status, so the button is simply absent until `npm start` is restarted once (the
CLI falls back to running the steps itself).

**Job state** — `RebuildJob` (`@tm/shared`): `state` (`idle | building |
typechecking | restarting | done | failed`), `startedAt`, `finishedAt`, `step`
(words), `error`, `reason` (`not_quiet | build | typecheck | restart | timeout |
error`), `logTail`, `buildId`, `hostStale`, `dev`, `bootedBefore`,
`bootedAfter`. In memory: a front door restart forgets it (`idle`).

### Build id → the window reloads itself

`web/vite.config.ts` stamps every build with an id — UTC timestamp + `git
rev-parse --short HEAD` (`20261026T121140Z-1a2b3c4`) — as `__TM_BUILD_ID__` in
the bundle (`BUILD_ID` in `web/src/rebuild.ts`) and as `web/dist/build.json`,
which the front door reports as `host.buildId` (null in dev and when unbuilt).

- **The tab that pressed** follows the job on `GET /host/rebuild-restart` (a
  module store, so the phone's More sheet closing does not stop it) and runs
  `location.reload()` the moment it is `done`. On `failed` it toasts the error,
  and the header's **Rebuild failed** opens the error and the log tail
  (desktop popover, phone sheet) with Dismiss.
- **Every other tab** (a phone, a second window, a CLI run) re-reads
  `/host/status` on every reconnect — the restart drops the events socket — and
  when the served id differs from its own shows a sticky **A new version … —
  Reload** toast instead of reloading under the human.

### The button

**Rebuild & restart** sits beside **Restart server** in `ServerControl`
(desktop header; phone More sheet). Two presses (`useArm`; the armed label says
`(not paused)` when the machine is not paused). Disabled with **Pause all
first** while any agent is working (the same count as Restart server). While
the job runs it reads **Building… / Typechecking… / Restarting… / Reloading…**
and Restart server is disabled. Pause state survives the restart (it is a
row); press **Continue** yourself — the job never continues for you.

## The handoff race (fixed here, and the reason any of this is load-bearing)

`POST /api/server/restart` spawned the replacement 250ms after replying and
exited 400ms after that — the child bound the port while the parent still held
it. Whenever the child booted in under 400ms (an empty database with no repos to
recover is enough) it died on `EADDRINUSE`, with `stdio: 'ignore'` swallowing
the stack trace, and **the restart button left nothing running**.

The order is now: close Fastify and the storage (4s cap — a wedged close must
not turn a restart into a permanent stop), *then* spawn, then exit. Belt and
braces, boot retries `EADDRINUSE` for up to 8s before giving up; every other
listen error is still fatal on the first try.

## Failure modes

| symptom | cause | fix |
|---|---|---|
| `503 {"apiDown": true}` from `/api/...` | the API is not running; the front door is | **Start server** in the header (on a phone, in the offline banner), or `POST /host/start` |
| the UI is a 503 text page | `web/dist` is missing | `npm run build` — the front door re-checks per request, no restart needed |
| `/host/*` requests fail, no Start button | no front door in front of this page (`dev:web` alone, `start:api`) | run `npm start` or `npm run dev` |
| `409` from `/host/stop` on an API that is up | it was adopted, not spawned here | stop it where you started it |
| `409` naming agent sessions | the API's restart guard | stop the agents, or `{"force": true}` |
| Rebuild & restart: `failed`, `reason: build` | the SPA does not build | fix it; the old page is still served. The log tail is under **Rebuild failed** |
| Rebuild & restart: `failed`, `reason: typecheck` | `npm run typecheck` fails | fix it and press again; the API was not restarted (the new SPA is already served) |
| Rebuild & restart: `failed`, `reason: timeout` | the new server does not boot | read the front door's terminal; the supervisor keeps respawning with backoff, and **Start server** works once it is fixed |
| no Rebuild & restart button / **Front door stale** | the front door predates the route, or `host.ts` changed since it booted | stop and re-run `npm start` |
| `403 forbidden: no tailnet identity` on the `ts.net` name | the request came from a tagged node (the Mac itself) or through Funnel — no `Tailscale-User-Login` | expected; open it from the phone |
| `403 forbidden: remote access is disabled` | `remote.enabled` is false | set it in `data/config.json`, restart the front door |
| `403 forbidden: proxied requests are not served on the local port` over the `ts.net` name | serve points at `host.port` (5176) | `tailscale serve --bg --https=443 http://127.0.0.1:<remote.port>` (5177) |
| `502` from serve with remote on | nothing on `remote.port`: the front door is down, or `remote.enabled` is false so the listener was never opened | start the front door; check the boot banner's `remote:` line |
| front door refuses to boot: `remote.enabled and LAN mode … mutually exclusive` | `lan.enabled` or `TM_LAN=1` (`npm run start:lan`) with remote on | start with `npm start`; drop `lan.enabled` |
| front door dies with `Error: write EPIPE` / `Unhandled 'error' event` on a `Socket` (fixed 2026-09-29) | a browser dropped a proxied WebSocket (tab closed, phone backgrounded) while the API was still streaming into it; Node's http server removes its own `error` listener from an upgraded socket, so the pipe's EPIPE had no handler | `proxyUpgrade` now owns an `error` listener on the client socket from the first line and tears both halves down on either side's close; `refuseUpgrade` does the same. Any new code that takes an upgraded socket must attach its own `error` listener |
