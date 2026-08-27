# Token budget — the fixed preamble every worker turn re-buys

Every turn of a worker session re-sends the whole conversation, and the bottom of
that conversation is a *fixed preamble*: the CLI's system prompt, the schema of
every tool the session was given, the skill listing, the subagent listing and the
repo's `CLAUDE.md`. It is identical on turn 1 and turn 200, so its cost is
`preamble × turns`, paid as cache reads.

The audit behind this document ("Audit project for token usage", artifact
`token-usage-audit.md`, 7 days to 2026-08-27) measured the first assistant
message of 86 worker sessions, *before* the agent did anything:

| | tokens |
| --- | --- |
| min | 23,281 |
| p25 | 42,123 |
| **median** | **52,337** |
| p90 | 60,355 |
| max | 65,281 |

52,337 × 6,152 worker turns × $1.50/MTok = **$483/wk — 32% of the whole worker
cache-read bill**, for text that never changes. The repo `CLAUDE.md` files are
not the cause (the frontend repo's is 9.5 KB ≈ 2.4k tokens); the 23k–65k spread
is *tool and skill surface*.

## What `buildWorkerInvocation` now does about it

Three levers, all in `server/src/claude/worker.ts`:

### 1. `--tools=<WORKER_TOOLS>` — the big one

`--tools` selects which of the CLI's **built-in tools** exist for the session, so
the ones left out are never sent as schemas at all.

This is *not* what `--allowedTools` does. `--allowedTools` is a **permission**
gate: the schemas are still sent and still paid for on every turn, the calls are
just refused. The task that opened this work assumed `agent.allowedTools` was the
lever; measured, it is not — it cannot move the preamble by a single token.
`agent.allowedTools` therefore keeps its empty default (an allowlist that is too
narrow makes a *hidden* terminal stall on a permission prompt nobody can answer),
and the schema trimming is done by `--tools`.

`WORKER_TOOLS` keeps shell (`Bash`/`BashOutput`/`KillShell` — also the publish
turn's only tool), files (`Read`/`Write`/`Edit`/`NotebookEdit`/`Glob`/`Grep`),
`Agent` (the standing rules ask the worker to delegate, so it must be present),
`TodoWrite`, `WebFetch`/`WebSearch`, and `Skill`/`ToolSearch` so a project skill
or an MCP schema can still be reached on demand. What it drops: interactive-only
tools (`AskUserQuestion` — nobody is watching a hidden terminal), plan-mode
tools, artifact/cron/remote-session/workflow tooling, and the rest of the surface
a headless worker cannot use.

**MCP tools are not affected.** `--tools` filters the built-in set only; verified
against a throwaway stdio MCP server — with the restricted list in place the
session still called `ping_probe` and got `pong` back. A browser task keeps its
`mcp__claude-in-chrome__*` tools.

> `--tools` and `--allowedTools` are **variadic** in the CLI. They must be passed
> as `--flag=value` in one argv element. Pushed as two elements the parser keeps
> consuming — and the next element is the prompt itself, so the session starts
> with no prompt at all. (This was already latent on the `--allowedTools` push;
> it never fired only because the setting defaults to empty.)

### 2. `disableBundledSkills` in the `--settings` JSON

The skill listing is ~40 bundled skill descriptions a worker never invokes
(`/design`, `/schedule`, `statusline-setup`, the artifact skills…). There is no
CLI flag that trims *part* of the listing — `--disable-slash-commands` kills
skills wholesale, `--safe-mode` also throws away `CLAUDE.md`, hooks and MCP — but
the settings key `disableBundledSkills` drops exactly the bundled ones and leaves
a repo's own `.claude/skills` intact. It rides the `--settings` JSON the hooks
already travel in, so it costs no extra flag.

### 3. `--no-chrome` for fresh sessions that plainly are not browser work

Gated by `needsFallbackModel()` (`server/src/claude/usage.ts`) — the same
word-boundary-anchored keyword set the model router uses, so `browserslist` and
`monochrome` do not match (review finding F11).

**The gate is monotone: chrome is withheld, never taken away.** Two review
rounds landed on the same class of bug from opposite ends, and the rule that
closes both is that `--no-chrome` may only be applied to a **fresh** session:

- Every resumed turn re-enters `buildWorkerInvocation` with new text — a human
  follow-up, a dispatched message (`buildDispatchTurn`), the reviewer's fix list
  (`orchestrator.ts`), a bare Proceed. Gating a resume on the *task* alone
  revokes the MCP server from a follow-up that asked for browser work (round-1
  finding); gating it on *this turn's* text alone revokes it one turn later —
  the follow-up says "take a screenshot to verify", the session is killed (the
  audit found 66 of 100 runs end killed), and the human's Proceed carries no
  keyword at all (round-2 finding). A resumed turn cannot see what its earlier
  turns were told to do, so it does not try: **resumed turns never get
  `--no-chrome`.**
- A fresh session has no earlier turns, so it is gated on its whole prompt:
  `task.title`, `task.description`, `opts.followUp` when a respawned follow-up
  carries one, and the previous run's `resultSummary` that ships with it.

The alternative — a `browser_tools` flag persisted on `tm_tasks`, set by any
matching turn and OR'd into the gate — buys back the ~2.6k on resumed runs of
non-browser tasks (roughly a third of runs), at the price of a migration in both
drivers and a piece of hidden per-task state with no UI. At ~$24/wk for the whole
lever that trade was not worth taking; chrome-on is the safe direction, and
monotone is correct without any state at all.

A browser/e2e turn is left on the
user's own Chrome configuration; it is deliberately **not** forced on with
`--chrome`, because that flag makes the session wait on the browser extension and
a hidden PTY with no browser attached never returns its first turn (observed:
two runs stalled past 150s and produced no assistant message at all).

Honest accounting: this is the *small* lever, and it was measured rather than
assumed. The chrome MCP tools arrive **deferred** — names only, loaded on demand
via `ToolSearch` — so switching them off saves the deferred name list, the
server's instruction block and the ToolSearch preamble around them, not 22k of
schemas. Isolated: **17,020 with chrome on vs 14,446 with `--no-chrome`, i.e.
2,574 tokens**, about $24/wk of the $483. Kept because it is 2 lines and because
an MCP server a worker cannot reach has no business being connected; not kept at
the price of a schema migration (see above).

### 4. Prompt text

`STANDING_RULES` and `RESUME_REMINDER` (`docs/worker-prompt.md`) were tightened
in the same pass — same rules, same mandated caps, fewer words. Worth ~100
tokens per turn, i.e. a rounding error next to the tool surface; done because the
block genuinely is re-sent on every turn, not because it was the problem.

## What could NOT be trimmed

**The subagent listing.** A worker is offered `claude`, `claude-code-guide`,
`Explore`, `general-purpose`, `Plan` and `statusline-setup`, and it will only
ever use two of them. There is no CLI flag and no settings key that removes or
filters built-in agent types (`claude --help` in 2.1.241 has `--agent` and
`--agents`, which *select* and *add*; the settings surface has
`disableBundledSkills`, `disabledBuiltinTools`, `disabledMcpServers` — nothing
for agents). `--agents` adds custom definitions, it does not replace the
built-ins. So this part of the preamble stays until the CLI offers a switch.

## Measurements

Method — the same one the audit used, and the only one that counts: run the
session, read the **first non-sidechain assistant message** of its transcript in
`~/.claude/projects/**/<session>.jsonl`, and sum
`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
`claude -p` is **not** a valid stand-in (its system prompt is a different,
smaller one — 24,956 against the same repo where an interactive session measured
41,649); the measurement must run in a PTY.

All rows below: interactive PTY, this repo, `claude-opus-5`, trivial prompt.

| configuration | first-turn context | delta |
| --- | --- | --- |
| baseline — the flags workers used before this change | **41,649** | — |
| `+ --tools=<WORKER_TOOLS>` | 18,902 | −22,747 |
| `+ disableBundledSkills` | 17,020 | −1,882 |
| `+ --no-chrome` | **14,446** | −2,574 |
| **total** | | **−27,203 (−65%)** |

`--tools` is 84% of the win. The skill listing and chrome are the two small
levers, and both were measured in isolation rather than credited by assumption —
the chrome row in particular, because those MCP tools arrive deferred and a
"saving that is not there" was the specific thing this task asked to check.

End to end, the *real* `buildWorkerInvocation` output (production settings,
hooks, full `STANDING_RULES`) running a real task in a scratch repo measured
**12,193** — lower than the 14,446 row because a scratch repo has no `CLAUDE.md`.

Applied to the audit's population, a median of 52,337 becomes roughly **25k**,
against a target of 30k: about **$250/wk** of the $483.

## Re-measuring after a change here

1. `npm run typecheck` && `npm run build`.
2. Run one real task through the orchestrator and read its first non-sidechain
   assistant message as above. Anything else (a `-p` run, a token estimate, a
   flag that "should" help) is not a measurement.
3. Check a browser task still has its MCP tools, and that `browserslist` still
   does not read as one. Then check the monotonicity property, which is the part
   two review rounds went after: **no resumed turn may ever add `--no-chrome`**,
   whatever its own text says, and a fresh respawn must read its follow-up and
   the previous run's summary, not just the title.
4. Run a publish turn — it needs `Bash` and git, and it is the one turn whose
   tool needs are narrower than everything else's.
