# Security Policy

## Threat model

Task Manager spawns `claude` processes in your repositories and exposes each one as an interactive terminal over WebSocket. Anything that can reach the server can run arbitrary code as your user. It is designed to run only on the machine that owns those repos.

Current defenses:

- The API (Fastify) and the front door (`server/src/host.ts`, which serves the UI and proxies to the API) listen on `127.0.0.1` only. The one exception is **LAN mode** (`lan.enabled` in `server/data/config.json`, or `TM_LAN=1` / `npm run start:lan`), an explicit opt-in that binds every interface with **no authentication**: anyone on that network can run commands. Use it only on a network you trust completely (`docs/mobile.md`).
- `Host` headers are checked against loopback names on the listener's own port (in LAN mode: private addresses only). This is the DNS-rebinding guard. A foreign `Origin` is refused on non-GET requests (a request with no `Origin`, such as curl or a hook, is allowed) and on WebSocket upgrades, where an `Origin` is required.
- The terminal and events WebSockets require the per-boot session token. Note that `GET /api/session` hands it to any page that passes the `Host` check, so the token is not user authentication.
- The internal hook callback routes (`/api/internal/runs/:id/*`) and the agent API (`/api/agent/*`) authenticate with a **per-run** token, which also bounds what that run may do. The master session token is deliberately not accepted there.
- **Remote access** (`docs/remote-access.md`) is off by default. When `remote.enabled` is on, the only way in from outside the Mac is `tailscale serve` on the tailnet, pointed at a dedicated loopback listener (`remote.port`). Every request on that listener is gated, whatever its `Host`, because serve forwards the client's `Host` verbatim. It is admitted only if its `Host` is exactly `remote.hostname`, it arrived from loopback, carries a `Tailscale-User-Login` on `remote.allowedLogins` (stamped by `tailscaled`, which strips client copies), and has exactly `https://<hostname>` as its `Origin` on writes and WebSocket upgrades. The main port refuses any request carrying proxy (`X-Forwarded-*`) or `Tailscale-*` headers. Remote access and LAN mode refuse to boot together.

Do not bind the server to `0.0.0.0` outside LAN mode, put it behind a public reverse proxy, or expose it to the internet by any means: never publicly. The tailnet via `tailscale serve` plus the identity gate is the only supported remote path. Never use `tailscale funnel`, which is public; the gate refuses Funnel traffic because it carries no identity headers. Do not remove or relax the checks above.

### Secrets

`GET /api/config` needs no `Origin`, so every worker can read it: a worker knows `$TM_CALLBACK_URL`, and an admitted tailnet client or, in LAN mode, any LAN device can read it too. No secret may live in `tm_config`:

- The Telegram bot token, the VAPID private key and the **Sentry auth token** live in `server/data/config.json` (written `0600` by the server). The Sentry token moved there on 2026-10-26: boot copies a legacy `tm_config` row into the file and deletes the row, on both drivers. `/api/config` strips the key from both `GET` and `PUT` responses in any case. The Config page sees only `GET /api/sentry/token` → `{ set, last4 }` and writes through `PUT /api/sentry/token`, which needs `Origin` and is audited by key only. **A token that was ever stored in `tm_config` must be rotated.**
- Answers to agents' questions are redacted when they look like credentials (`docs/questions.md` § Secrets): the audit row right away, the question row once the run's turn is over, and anything older at boot. Telegram never echoes free text.
- Checks (`docs/checks.md` § Who may define a check) and landing tiers can only be raised, defined or removed with a browser's `Origin`, so a worker cannot loosen the gates that judge it.

A local process can send forged `Tailscale-*` headers to `127.0.0.1`. That is not a threat this app defends against: such a process already has full loopback access to everything the gate protects.

## Out of scope

- Agents behave as instructed. A task description is executed by a model with write access to the target repo, and `bypassPermissions` mode disables prompting entirely. Reviewing what you queue is your responsibility.
- Local files that the app reads by design, such as `~/.claude` transcripts used for usage estimates.
- Credentials stored in `server/data/config.json` (Sentry and Telegram tokens, the VAPID key, a Postgres connection string). They are kept unencrypted on your machine.

## Reporting a vulnerability

Open a GitHub security advisory on the repository, or a private issue if advisories are unavailable. Please do not open a public issue for anything that lets a remote party reach the terminal WebSocket or the internal routes.
