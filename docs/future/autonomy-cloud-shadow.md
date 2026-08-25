# Next security + autonomy layer — Docker, shadow DBs, cloud

Status: **future / not started**. Analysis written 2026-08-25 (Claude, conversation with user). This is the motivating example for the [Feature interface](../features.md), which shipped 2026-08-25: one big request spanning ~4 ordered phases. Writing this document into a Feature and running Analyze is now the intended way to start it.

User request, verbatim intent: (1) tm_manager inside Docker; (2) a mechanism users can enable that redirects prod-DB writes of their registered repos to a small/cheap shadow DB so big things are tested without touching prod; (3) cloud deployment so work can be dispatched from anywhere by creating a task, with a terminate-all button plus safety measures, and ideally a fully autonomous mode (scan issues → create tasks → wait for usage reset → review work → commit and push).

## The one reframe that makes everything click

Today the unit of execution is "a `claude` process in a PTY with `cwd = repo path`". Change that unit to **"a `claude` process in a PTY inside a per-run Docker container"** and all three asks fall out of it:

- Docker containment (ask 1) is the unit itself.
- Shadow DB (ask 2) becomes *enforceable* instead of advisory, because we control the container's env and network.
- Cloud (ask 3) is running the same containers on a VM instead of the Mac.

This barely disturbs the architecture. `session-manager.ts` spawns via an args array already; `pty.spawn('claude', args, {cwd})` becomes `pty.spawn('docker', ['run','-it','--rm','--name','tm-run-<id>', ...mounts, ...env, image, 'claude', ...args])` — node-pty attached to `docker run -it` is still a real TTY, so xterm.js attach, the ring buffer, and hooks-over-curl all survive unchanged. The hooks callback just needs the container to reach the server (`host.docker.internal` locally, the private IP in cloud).

## 1. Docker

**Workers go in containers, not (necessarily) the whole server.** Two options:

- Whole app in one container — simple, but workers still share a filesystem with each other and the server; small isolation win, complicates local dev (Keychain, mounting every repo).
- **Server on host (or its own container), one container per run** — the right shape. Each run mounts *only its target repo*, gets resource limits (`--memory`, `--cpus`, `--pids-limit`) and a network policy. `bypassPermissions` stops being a red switch: blast radius is one repo checkout.

Concrete wins and changes:

- **Boot recovery gets simpler**: verify-pid-cmdline-then-kill becomes `docker ps --filter label=tm-run` → kill orphans. Containers are a better recovery unit than pids.
- **Terminate-all becomes trustworthy**: `docker kill` by label kills the worker *and every subprocess it spawned*; today SIGKILL on the claude pid can orphan children.
- **Auth in containers**: on Linux the CLI uses `~/.claude/.credentials.json`, not Keychain. Use `claude setup-token` (long-lived OAuth token) — the supported headless path, and what cloud needs anyway.
- **Gotchas**: run with `--user` mapping so repo edits aren't root-owned; git identity + per-repo deploy key in image/env for commit/push; Docker Desktop macOS file I/O is slow for npm-heavy tasks (VirtioFS helps; vanishes on real Linux in cloud); the per-repo workspace-trust dialog reappears per-container unless trust config is pre-seeded in the image.
- **Usage pill**: `~/.claude.json` cache lives on the host and nothing refreshes it headlessly anyway (decision log 2026-08-25), so the transcript-estimate fallback carries more weight — mount the transcripts dir out of containers so `usage.ts` keeps scanning them.

## 2. Shadow DB

**Reframe.** A transparent proxy that "redirects all prod writes to a shadow" is rejected: reads-from-prod + writes-to-shadow is immediately inconsistent (app writes a row, can't read it back), and it's per-wire-protocol work (pg, mysql, mongo, HTTP APIs). What works is **environment substitution + network enforcement**, layered:

**Layer 1 — per-repo env overrides (the user-facing mechanism).** `tm_repos` gains an env-override map, e.g. `DATABASE_URL → <shadow url>`, injected into the worker PTY env (we already inject `TM_RUN_ID` etc.). Worker prompt states "you are on a shadow database." Covers ~90% of real repos; small change; useful even without Docker (just advisory).

**Layer 2 — shadow provisioners (per-repo choice):**
- *Manual*: user pastes a shadow connection string. Zero work.
- *Neon / Supabase branching (the standout)*: Neon does copy-on-write Postgres branches — create a branch of prod **per run** via one API call, instant, real data, free tier covers it; delete when the task leaves review. Purpose-built for "agent tests big things on a disposable prod copy." PlanetScale = same for MySQL.
- *Local `docker run postgres` + seed script*: fully free, synthetic data; trivial once per-run containers exist (sidecar DB container on the run's network).

Data-sensitivity tradeoff: a Neon branch *is* prod data (PII) handed to an agent; docker+seed is synthetic but less realistic. Per-repo choice.

**Layer 3 — enforcement (why Docker matters here).** With per-run containers, the prod DB host is simply *not reachable*: the run's network denies egress to the prod host (or allowlists only the shadow). "Use the shadow" becomes a guarantee — a hardcoded prod connection string fails to connect instead of silently writing to prod. `--add-host` can even DNS-remap the prod hostname to the shadow to catch hardcoded hosts transparently.

Generalizes beyond DBs: the same override map swaps Stripe keys for test keys, prod API bases for staging, etc.

## 3. Cloud + autonomy

Feasible; most pieces already exist: Analyze (scan → propose), the claim loop, work→review→work with headless adversarial review, per-repo Commit/Push with generated messages, the agent API, usage windows with `resetsAt`. Genuinely new:

**a) Getting there safely.** The entire current security model is "bind 127.0.0.1", and the terminal WS is arbitrary code execution (SECURITY.md). Do **not** put it behind public HTTPS + a login form as v1. **Run the VM on Tailscale** (or WireGuard): server keeps binding a private interface, phone/laptop join the tailnet, existing Origin+token checks stay as defense-in-depth. Near-zero code change; answers "dispatch from anywhere" and "review from anywhere" at once.

**b) Repos change identity: local path → git URL.** In cloud a repo is clone URL + branch, cloned into a server workspace, pulled before each run. Workers work on branches and **push branches / open PRs, never main** — scoped deploy keys per repo, branch protection on. Biggest schema/UX change of the plan; also upgrades review: "review in browser" becomes partly "review the PR on GitHub from your phone."

**c) "Review on browser, if cloud-based?" — two readings, both answered:**
- *Human reviewing*: existing web UI + xterm attach already works from any browser over the tailnet; plus PR diffs on GitHub.
- *Agent reviewing its own work in a browser* (screenshots/e2e): headless Chromium (Playwright) inside the worker image — the container is actually the easier place for this than the Mac, but it's its own phase; don't couple to the migration.

**d) The autonomous loop** = existing pieces + three new policies:
1. *Intake cron* — "scan issues": periodic Analyze + a real Sentry/GitHub-issues pull (the stub grows up). Proposals get an **auto-accept policy tier** (today human-only): e.g. auto-accept split/new_task below a size threshold, queue the rest.
2. *Usage-aware pausing* — routing already gates on `sessionUsagePct`; extend the claim loop: above threshold → sleep until the window's `resetsAt`, resume. Runs on the transcript estimate + `resetsAt` arithmetic (nothing refreshes the account cache headlessly); accept imprecision, keep a margin.
3. *Landing policy* — today review→done is an explicit human action. Add tiers per repo/task: **autonomous** = clean review verdict → auto-commit → push branch/PR; **supervised** = park in `review`. Default supervised; opt repos in.

**e) Terminate-all + safety.** `stop-and-kill` exists; cloud-grade adds:
- Kill = `docker kill` by label (complete, instant) + revoke queue in one action.
- **Dead-man switch**: invert the heartbeat — a worker container that can't reach the server for N minutes stops itself. Server down ≠ agents running unsupervised.
- **Hard budget fuses**: max runs/day, max tokens/day, max wall-clock per run — automatic terminators, not just the manual button.
- **Prompt injection through intake**: "scan issues → create tasks" means attacker-controlled text (issue bodies, Sentry events) becomes agent instructions on a machine with push credentials. Mitigation: externally-sourced tasks never get the autonomous landing tier — always park in review — and run with the most restricted permission mode.

## Verdict and order

Possible, all of it, with two reframes: shadow DB is *env substitution + network enforcement*, not write-proxying; cloud exposure is *VPN-first*, not public auth. Sequencing (each layer founds the next):

1. **Per-run worker containers** (local, Docker Desktop) — spawn/kill/recovery changes in session-manager + orchestrator, `setup-token` auth, worker image. Everything else depends on this.
2. **Env-override map + shadow provisioners** — manual URL first, then Neon branching, then network enforcement (nearly free after step 1).
3. **Cloud**: Linux VM + Tailscale + git-URL repos + PR-based landing.
4. **Autonomy policies**: intake cron, auto-accept tier, usage-aware pause, landing tiers, dead-man switch, budget fuses — each independently toggleable, default off.

Biggest design decision to make first: do repos stay "local paths" with cloud as a variant, or does the model migrate to **"git URL + workspace clone" everywhere** (local mode clones from a local path)? Lean the latter — one model, and it makes worker isolation real even locally, since a worker never touches the actual checkout.
