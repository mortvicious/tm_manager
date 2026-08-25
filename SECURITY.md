# Security Policy

## Threat model

Task Manager spawns `claude` processes in your repositories and exposes each one as an interactive terminal over WebSocket. Anything that can reach the server can run arbitrary code as your user. It is designed to run only on the machine that owns those repos.

Current defenses:

- Fastify listens on `127.0.0.1` only.
- `Host` headers are checked against `127.0.0.1:<port>` and `localhost:<port>`; WebSocket upgrades validate `Origin` against the app's own origin.
- The terminal WebSocket and the internal hook callback routes require a per boot session token held in memory.
- Agent API calls (`/api/agent/*`) authenticate with a per run token, which also bounds what that run may do.

Do not bind the server to `0.0.0.0`, put it behind a public reverse proxy, or tunnel it to the internet. Do not remove or relax the checks above.

## Out of scope

- Agents behave as instructed. A task description is executed by a model with write access to the target repo, and `bypassPermissions` mode disables prompting entirely. Reviewing what you queue is your responsibility.
- Local files that the app reads by design, such as `~/.claude` transcripts used for usage estimates.
- Sentry or database credentials you paste into `server/data/config.json` or the settings UI. They are stored unencrypted on your machine.

## Reporting a vulnerability

Open a GitHub security advisory on the repository, or a private issue if advisories are unavailable. Please do not open a public issue for anything that lets a remote party reach the terminal WebSocket or the internal routes.
