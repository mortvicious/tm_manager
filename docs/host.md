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
**`Origin`** through untouched (so the API still judges it) — exactly what
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
| `GET /host/status` | `HostStatus` (`@tm/shared`): api up/managed/pid/port/bootedAt/restarts/desired/lastExit/lastError, host port/dev/spaBuilt |
| `POST /host/start` | start the API if it is not answering; 200 with `already: true` if it is |
| `POST /host/stop` | stop a **managed** API; 409 on one it merely adopted |
| `POST /host/restart` | managed: stop → wait → spawn. Adopted: forward to `POST /api/server/restart` |

`stop` and `restart` refuse while agents are working, and they do not restate
the rule: they `GET /api/server/restart-check` and forward the API's own answer
verbatim (`{blocked, error, running, headless, services}`). `{"force": true}`
is the override, same as the API's. An API that is not answering cannot be
killing anything, so a down server is never blocked.

The routes are guarded like the API's: `Host` allowlist on everything, `Origin`
allowlist on non-GET, because a drive-by page must not be able to stop the
server blind.

## What the UI does with it

The header's server pill now distinguishes two things it used to call `offline`:

- **`offline`** — the events socket is down but the front door either is not
  there or still sees the API. Keep retrying; nothing to press.
- **`stopped`** — the front door answered and says the API is not running. The
  button becomes **Start server**, and its tooltip carries the last exit or
  error. This is the case that used to be unreachable, because the page died
  with the server.

`/host/status` is polled every 3s only while the socket is down; with the socket
up the API is already telling the page everything. A page not served through a
front door gets a failed fetch, `host: null`, and no new controls — `npm run
dev:web` alone still works, it just has nothing to start.

The bootstrap in `web/src/state.tsx` now retries `/api/session` until it
succeeds. "Load the page first, start the server second" is an ordinary sequence
once the page outlives the server.

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
| `503 {"apiDown": true}` from `/api/...` | the API is not running; the front door is | **Start server** in the header, or `POST /host/start` |
| the UI is a 503 text page | `web/dist` is missing | `npm run build` — the front door re-checks per request, no restart needed |
| `/host/*` requests fail, no Start button | no front door in front of this page (`dev:web` alone, `start:api`) | run `npm start` or `npm run dev` |
| `409` from `/host/stop` on an API that is up | it was adopted, not spawned here | stop it where you started it |
| `409` naming agent sessions | the API's restart guard | stop the agents, or `{"force": true}` |
