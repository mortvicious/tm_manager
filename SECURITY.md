# Security Policy

## Threat model

Task Manager spawns `claude` processes in your repositories and exposes each one as an interactive terminal over WebSocket. Anything that can reach the server can run arbitrary code as your user. It is designed to run only on the machine that owns those repos.

Current defenses:

- The API (Fastify) and the front door (`server/src/host.ts`, which serves the UI and proxies to the API) listen on `127.0.0.1` only. The one exception is **LAN mode** (`lan.enabled` in `server/data/config.json`, or `TM_LAN=1` / `npm run start:lan`), an explicit opt-in that binds every interface with **no authentication**: anyone on that network can run commands. Use it only on a network you trust completely (`docs/mobile.md`).
- `Host` headers are checked against loopback names on the listener's own port (in LAN mode: private addresses only). This is the DNS-rebinding guard. A foreign `Origin` is refused on non-GET requests (a request with no `Origin`, such as curl or a hook, is allowed) and on WebSocket upgrades, where an `Origin` is required.
- The terminal and events WebSockets require the per-boot session token. Note that `GET /api/session` hands it to any page that passes the `Host` check, so the token is not user authentication.
- The internal hook callback routes (`/api/internal/runs/:id/*`) and the agent API (`/api/agent/*`) authenticate with a **per-run** token, which also bounds what that run may do. The master session token is deliberately not accepted there.
- **Remote access** (`docs/remote-access.md`) is off by default. When `remote.enabled` is on, the only way in from outside the Mac is `tailscale serve` on the tailnet. The front door admits a request that addressed it by `remote.hostname` only if it arrived from loopback, carries a `Tailscale-User-Login` on `remote.allowedLogins` (stamped by `tailscaled`, which strips client copies), and has exactly `https://<hostname>` as its `Origin` on writes and WebSocket upgrades. Remote access and LAN mode refuse to boot together.

Do not bind the server to `0.0.0.0` outside LAN mode, put it behind a public reverse proxy, or expose it to the internet by any means: never publicly. The tailnet via `tailscale serve` plus the identity gate is the only supported remote path. Never use `tailscale funnel`, which is public; the gate refuses Funnel traffic because it carries no identity headers. Do not remove or relax the checks above.

A local process can send forged `Tailscale-*` headers to `127.0.0.1`. That is not a threat this app defends against: such a process already has full loopback access to everything the gate protects.

## Out of scope

- Agents behave as instructed. A task description is executed by a model with write access to the target repo, and `bypassPermissions` mode disables prompting entirely. Reviewing what you queue is your responsibility.
- Local files that the app reads by design, such as `~/.claude` transcripts used for usage estimates.
- Sentry or database credentials you paste into `server/data/config.json` or the settings UI. They are stored unencrypted on your machine.

## Reporting a vulnerability

Open a GitHub security advisory on the repository, or a private issue if advisories are unavailable. Please do not open a public issue for anything that lets a remote party reach the terminal WebSocket or the internal routes.
