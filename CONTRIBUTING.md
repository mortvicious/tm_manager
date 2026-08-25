# Contributing

## Setup

```bash
npm install
npm run dev     # server on 127.0.0.1:5175, Vite on localhost:5173
```

`npm install` runs a postinstall step that restores the exec bit on `node-pty`'s `spawn-helper`. If a task fails with `posix_spawnp failed`, run `npm rebuild` or re-run install.

## Checks before opening a PR

There is no test framework yet. Every change must at least pass:

```bash
npx tsc -p server/tsconfig.json --noEmit
npx tsc -p web/tsconfig.json --noEmit
npm run build
```

Beyond that, verify behaviour by hand: curl the REST API, and exercise the flow you touched in the UI. `docs/design.md` § Verification lists the flows worth re-running.

## Conventions

Read [`CLAUDE.md`](CLAUDE.md) first. The rules that trip people up:

- **Design tokens.** Visual changes must resolve to the `--tm-*` tokens in `docs/tm-design-tokens.html`, mirrored in `web/src/theme.css`. No hardcoded colors, spacing, or fonts outside that layer. xterm.js needs concrete values, so take those from the sheet's terminal tokens.
- **SQL stays dialect neutral.** Both storage drivers share the same SQL strings with `?` placeholders; the Postgres driver rewrites them to `$n`. Never put a `?` inside a SQL string literal.
- **No generic `transaction(fn)`.** Multi-step mutations are first-class composite methods on `Storage`, implemented transactionally in each driver. `better-sqlite3` transactions are synchronous only, so an async facade would commit before awaited work runs.
- **PTY spawns take an args array**, never a shell string.
- **Do not weaken the localhost bind, the Host allowlist, the Origin check, or the token guards.** See [SECURITY.md](SECURITY.md).
- **Document your work in `docs/`.** Updating the relevant doc is part of the change, not a follow-up.

## Changes touching both drivers

Anything that adds a migration or a composite method has to land in `server/src/storage/sqlite.ts` and `server/src/storage/postgres.ts` together. The Postgres driver has not been smoke-tested against a live database yet, so keep it compiling and reviewed even if you only run SQLite.

## Commits and PRs

Describe what changed and how you verified it. Small, reviewable commits are preferred.
