# Moving the task manager to a Windows machine

Written 2026-11-13, when the setup moved from the Mac (`/Users/faigomarov/Development`) to a Windows PC. The transfer bundle `tm-windows-transfer-2026-11-13.zip` has a copy of this file as `README.md`.

## Short version

- **Run it under WSL2 (Ubuntu), not native Windows.** Keep the repos inside the Linux filesystem (`~/Development`), not under `/mnt/c`.
- **Stop the Mac's server before starting the new one.** One Telegram bot token can only be long-polled by one process.
- Clone the repos and restore the data:
  1. Run `scripts/restore.sh`.
  2. `npm install`.
  3. Rewrite the paths with `scripts/rewrite-paths.mjs`.
  4. Set `remote.hostname`.
  5. `npm run build && npm start`.

## Why WSL2 and not native Windows

The server assumes a POSIX host in places that matter:

- **Hooks.** The worker hooks (Stop, SessionEnd, Notification, the `AskUserQuestion` wait loop, PreCompact) are `sh` + `curl` snippets injected through `--settings`.
- **Terminals.** Terminals are `$SHELL -l`.
- **Process control.** Kills go to process groups.
- **Background shells.** They are found with `ps`/`lsof`.

The macOS-only parts already have Linux branches:

| Part | On Linux (WSL) |
|---|---|
| Memory fuse (`memory.ts`) | Has a `linux` branch. |
| Memory per run (`proc-memory.ts`) | `ps` RSS instead of `top` footprint. |
| Worktree `node_modules` (`worktrees.ts`) | Plain `cp -R` instead of an APFS clone. Slower and uses real disk. |
| Terminals (`shells/runner.ts`) | `$SHELL`, not `/bin/zsh`. |
| `caffeinate` (`host.ts`) | Darwin only, skipped. |

These don't exist on Linux:

- **TM Bar** (`macos/TMBar`, SwiftUI).
- **The launchd service** (`npm run service:*`, `scripts/service.mjs`). Use `npm start` in tmux, or a systemd user unit.

Native Windows has not been tried and is not supported.

## The bundle

| Path | What | Secret? |
|---|---|---|
| `db/taskman.db` | SQLite online backup (`.backup`) of `server/data/taskman.db`, integrity checked | data |
| `db/taskman.sql.gz` | The same as a plain SQL dump (portable, for a Postgres move or inspection) | data |
| `server-data/config.json` | Telegram bot token + allowed user id, Web Push VAPID pair, Sentry token, `remote` (tailnet), storage choice | **yes** |
| `shared-folders/neko-shared/` | The neko shared space (ledger, knowledge, `REQUESTS.md`) and the neko office (`office/`) | — |
| `shared-folders/Gor - shared/` | The second office's folder (vision, roadmap, roles, briefings, `untrusted/`) | — |
| `repo-secrets/<repo>/` | Every git-ignored file a clone won't have: `.env*`, `credentials.json`, `.vercel/`, `.claude/settings.local.json`, `gsheet/input/pushed/` | **yes** |
| `claude/` | `~/.claude/settings.json`, `skills/`, every project's `memory/`, and this migration session's transcript | some |
| `ssh/neko_ec2_proxy.pem` | The EC2 proxy key (`ssh/config.mac` is the old `~/.ssh/config` for reference) | **yes** |
| `scripts/restore.sh` | Clone + copy everything into place (never overwrites) | — |
| `scripts/rewrite-paths.mjs` | DB path rewrite (below) | — |

**Left out on purpose:**

- **`server/data/artifacts/` (5.3 GB).** Per-task artifact dirs of finished runs. Copy it separately into `server/data/artifacts/` if you want old reports and progress ledgers.
- **Session transcripts `~/.claude/projects/*/*.jsonl` (2.4 GB).** The CLI files sessions by cwd, so a moved checkout can't `--resume` them anyway. A task whose old session is gone starts fresh with its `## Previous attempt` block.
- **`~/.ssh/id_ed25519`.** Make a new key on the new machine.
- **`host.token`.** Regenerated on every boot.

The bundle holds live secrets. Keep it off cloud drives and delete it once the restore is done.

## GitHub identity

- **Account:** `mortvicious`.
- **Commit identity:** `Faig Omarov <shindo.shitai@gmail.com>`. On the Mac, `user.name` came from the macOS account name, so set it explicitly on the new machine.
- **Protocol:** SSH (`git@github.com:mortvicious/…`).

Inside WSL:

```bash
git config --global user.name  "Faig Omarov"
git config --global user.email "shindo.shitai@gmail.com"
ssh-keygen -t ed25519 -C "shindo.shitai@gmail.com"
gh auth login            # GitHub.com → SSH → upload the new key → browser login
ssh -T git@github.com    # "Hi mortvicious!"
```

The server's own pushes (lands, PR sync, push-health preflight) use the same SSH key. On the Mac its passphrase lived in the keychain. On Linux, either use a key without a passphrase or run `keychain`/`ssh-agent` from your shell profile. Otherwise every land fails, and the push-health banner turns red.

| Repo folder | Remote | Branch |
|---|---|---|
| `3 - neko-nest` | `mortvicious/neko-nest` | `staging` (push = production deploy) |
| `4 - neko-vite-new` | `mortvicious/condo-mono` | `staging` |
| `17 - task-manager` | `mortvicious/tm_manager` | `main` |
| `18 - neko-frontend` | `mortvicious/neko-frontend` | `main` (production builds only from `release`) |
| `16 - profitbase-exporter` | `mortvicious/profitbase-exporter` (**private, created 2026-11-13**; it had no remote before) | `main` |
| `11 - graphql-lambda-collector` | `mortvicious/graphql-lambda-collector` | `feature/rent` |

## Step by step

**1. Mac: stop it.**

```bash
npm run service:stop
```

Or Ctrl-C the `npm start` terminal. Use `npm run service:uninstall` if you won't run it on the Mac again. If the Mac kept working after the bundle was made, re-export the DB:

```bash
sqlite3 server/data/taskman.db ".backup '/path/taskman.db'"
```

**2. Windows: WSL2.**

In an admin PowerShell, run `wsl --install -d Ubuntu`, then reboot. Optional: in `%UserProfile%\.wslconfig` set:

```ini
[wsl2]
networkingMode=mirrored
memory=…
```

Mirrored networking lets Windows-side tools reach `127.0.0.1` in WSL directly.

**3. Toolchain inside WSL.**

```bash
sudo apt update && sudo apt install -y build-essential python3 git curl lsof sqlite3 unzip tmux
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash   # then reopen the shell
nvm install 24 && nvm alias default 24     # engines: node >= 22.12; v24 is what was used (v20 segfaulted tsx)
type -p gh || (sudo mkdir -p -m 755 /etc/apt/keyrings && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null && sudo apt update && sudo apt install -y gh)
curl -fsSL https://claude.ai/install.sh | bash     # Claude Code; then run `claude` once and log in
```

Workers spawn `claude` from `PATH`, so it must be installed and logged in **inside WSL**. A Windows-side install doesn't count.

**4. GitHub.** Follow § GitHub identity.

**5. Unpack and restore.**

```bash
mkdir -p ~/transfer && cd ~/transfer
cp /mnt/c/Users/<you>/Downloads/tm-windows-transfer-2026-11-13.zip . && unzip -q tm-windows-transfer-2026-11-13.zip
bash tm-windows-transfer/scripts/restore.sh            # base = ~/Development
```

**6. Install, rewrite the paths, build.**

```bash
cd ~/Development/"17 - task-manager"
npm install
node ~/transfer/tm-windows-transfer/scripts/rewrite-paths.mjs server/data/taskman.db ~/Development --dry
node ~/transfer/tm-windows-transfer/scripts/rewrite-paths.mjs server/data/taskman.db ~/Development
npm run typecheck && npm test && npm run build
```

The script rewrites only the columns the server acts on:

- `tm_repos.path`
- `tm_spaces.path`
- `tm_offices.folder_path`
- `tm_tasks.workdir`

History rows keep the Mac paths they were written with: task descriptions, events, `tm_runs.transcript_path`. Saved commands that named a Mac path were all archived at export time.

**7. `server/data/config.json`.**

- **Keep as-is:**
  - the Telegram token and user id;
  - the `push` VAPID pair (it binds every Web Push subscription);
  - `sentry`;
  - `storage`;
  - the ports.
- **`remote.hostname`:** the new machine's MagicDNS name (`<machine>.<tailnet>.ts.net`). Or set `remote.enabled: false` until Tailscale is set up.

**8. Start.**

```bash
npm start     # front door http://localhost:5176, API 5175
```

For a long-lived run, use tmux: `tmux new -s tm 'npm start'`. With mirrored networking, the Windows browser opens `http://localhost:5176` directly.

**9. Phone (optional).**

Install Tailscale. Either:

- run it on the Windows host and point `tailscale serve` at `http://127.0.0.1:5177`, which needs mirrored networking so the connection reaches WSL as loopback; or
- install it inside WSL and run serve there.

The remote gate admits only loopback peers on 5177 (see `docs/remote-access.md`). Re-add the Home Screen app from the new hostname, since a new origin means a new PWA. Old push device rows clean themselves up on their first 404/410.

**10. First checks.**

- `/api/orchestrator`: push health is green for every PR repo, which proves the server's SSH push works.
- The Repos page lists the new paths.
- Telegram `/status` answers.
- Turn the queue back on only after that. It was **off** at export (`orchestrator.enabled: false`).

## State at the cutover (2026-11-13)

**Every repo is fully pushed.** There are no local-only commits on any branch. Two stashes and dirty worktrees were saved as commits or branches. Pushed during the cutover:

| Repo | Pushed |
|---|---|
| task-manager | `tm/5ce78ac0` |
| neko-frontend | `handoff/s6t1-e4875b8`, `ios-tabbar-anchor` (own branch, not main), `tm/89013a57`, `tm/a0d10627`, `tm/ef569d32`, `strip-targets` (+ a WIP commit of the `18 - neko-frontend-strip` worktree's 9 uncommitted files) |
| neko-vite-new | `staging` (188 docs-only commits: the Next ledger `nextjs/PLAN.md`, `BACKEND-FINDINGS.md`, a report), `feature/redesign`, `worktree-improvement+listing+nothing-found` (+ WIP commit), `stash/translation-sync-churn-2026-09-07` (the old stash as a branch) |
| profitbase-exporter | New private repo, `main` |

**Landed:** Magma plumbing (task 88d328e1, PR #101) went through the task manager's own land as `07b6af6` on `main`.

**Parked: done in the app, never merged into `main`.** These are task-manager features from October whose tasks were moved to `done` without a land. Each branch is on GitHub. Each conflicts with today's `main`, so it needs a rebase plus conflict resolution, then typecheck/build, then a land:

| Task | Branch / PR | Feature | Size vs main |
|---|---|---|---|
| 64399bb1 | `tm/64399bb1`, PR #3 | Pause one repo's custom queue (hold, not cancel) | 19 files, +752/−51, heavy in `orchestrator.ts` |
| 84f9ebf3 | `tm/84f9ebf3`, PR #1 | Branches page: merged/pushed vs local-only per repo | 16 files, +1440 |
| 5ce78ac0 | `tm/5ce78ac0` | A review task's primary button is Done, not Publish | 5 files, +243 (landing tiers changed this area since) |

Each can be done by hand, or by giving the task a follow-up from the app ("rebase onto origin/main, resolve, finish"). Its old session is gone, so it starts fresh with its previous attempt.

**Stale PR records in neko-frontend:** PRs #10, #22, #23, #24, #27, #29, #39, #40, #41, #53. They are still open, but their content reached `main` through later squashed lands (B9-T3, B10-PLAN/T4, B11-T3…). Every file those branches add exists on `main` except one per branch, which looks like a moved report file. They can be closed.

**Open work in the app:** 45 drafts and 1 queued task, untouched. Among the drafts are the Magma feature's later phases (side-nav, rebrand to Gor, office messenger, coverage).
