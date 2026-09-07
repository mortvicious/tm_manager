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

## The other fixed cost: reviewing the same diff twice

This file is about what a WORKER turn re-buys. The second-largest repeat charge
was the REVIEWER: the 2026-08-31..09-01 audit found 36 adversarial reviews for
17 tasks in two days (≈$275), because `reviewWorkerChange` reads `git diff HEAD`
— the whole uncommitted tree, not just this turn's work — so every Stop after
the first presented a fat diff and paid for a full headless run over changes
already judged. Talk-only Stops (dispatch replies, answered questions) were the
worst case: zero new code, full review price.

The diff is now hashed (sha256 of the raw output, before the 60k prompt
truncation) and the hash stored on the task; an unchanged hash spawns nothing.
The saving is not a smaller prompt but a run that does not happen, so it does
not show up in the measurements above — count `run.reviewed` rows carrying
`skipped` instead. `review.maxRounds` also dropped to 1, because each extra
round resumes a 300–500k-token session (≈$15) before its first useful token.
Full rationale: `docs/design.md` § Adversarial review, decisions log 2026-09-03.

## The third: waking a session to be told something

A dispatch delivery is a session resume, and a resume re-writes the WHOLE
conversation to cache twice — measured at 395k + 398k tokens on a 400k session,
≈$15 — before the agent produces a single useful token. The reply then Stops
into the adversarial reviewer, possibly for another fix round. The same audit
found the two auth tasks `0cb8555a ⇄ a5d9442a` spending 8 dispatches of 4–6.5k
chars on each other, mostly status reports and corrections of corrections; one
reply that made **zero code change** cost ~$23 for four minutes.

Since 2026-09-05 a dispatch must declare an `intent`. `needs_action` delivers
as before. **`fyi` never wakes a session**: it waits and is prepended to the
next turn the target takes anyway, or is recorded as a note if that task has
already finished for good. The per-run cap went 5 → 2 and the per-pair cap
8 → 3. Full rationale and the delivery rules: `docs/dispatch.md` § Intent,
decisions log 2026-09-05.

Like the review skip, the saving is a run that does not happen, so it will not
show up in the preamble measurements above. Count it instead as `tm_dispatches`
rows with `intent = 'fyi'` that reached `delivered` without a `run.started`
between their `created_at` and `delivered_at`.

## The fourth: paying for the whole conversation to resume it

The resume itself is the single biggest line in the audit. Workers run on a 1M
window so the CLI never compacts on its own; the 2026-08-31..09-01 sessions
reached 400–500k tokens per call, and the top session had **267 of its 367 calls
above 150k**. Every `--resume` — a review fix round, a dispatch delivery, a
Proceed, the publish turn — re-writes that entire conversation to cache **twice**
before the follow-up turn says a word (measured 395k + 398k tokens on one 400k
session, ≈$15), and every later turn of the run re-reads it at $1.50/MTok.

Resume re-writes alone were **16.4M tokens ≈ $308** of ~$1,040 of worker spend;
cache reads another **≈$496**. And most of what is being re-bought is not
knowledge — it is old heredoc file contents, superseded perl one-liners,
screenshots.

The constraint on any fix is quality: good work has come out of ~300k-token
sessions, so the answer cannot be "start fresh sooner".

### The gate

`agent.resumeContextCap` (default **300,000** tokens, 0 = off) is checked in
`Orchestrator.resumeHandoff`, called from `startWorker` — **only** when an idle
session is about to be resumed, never mid-run. The measure is the previous run's
last-turn context read straight from its transcript: `RunStats.contextTokens`,
the raw number behind `contextPct` (which divides by a fixed 200k and clamps at
100, so it reads "100%" for every session this decision is ever about).

Under the cap, nothing changes. Over it, in order of preference:

- **`compact`** — a `-p` turn whose prompt IS the `/compact` slash command:
  `claude -p --resume <id> "/compact <focus>"`. Measured against CLI v2.1.257 on
  two real sessions: the transcript gains
  `{type:'system', subtype:'compact_boundary', compactMetadata:{trigger:'manual',
  preTokens:191365, postTokens:10360}}`, `num_turns` 0, empty result. The
  session keeps its id, so the worker PTY behind it resumes the SAME session and
  everything downstream (`sessionId`, `statsBaseline`, the attachable terminal)
  is untouched. Cost shape: ONE cache-write of the conversation instead of two,
  and afterwards the session is ~10k rather than ~400k, so the rest of the run
  is cheap as well.
  The focus string is built from the task title plus what the turn is about to
  do (`compactFocus`), because a summariser keeps what it is told matters —
  naming the pending instruction is what stops the summary from being a neutral
  recap that drops the half the follow-up needs.
- **`fresh`** — only if the compaction failed. The existing non-resume branch of
  `buildWorkerPrompt`, but handed a richer `Previous run summary` than the task
  row's 4000-char `resultSummary`: the previous session's **last assistant text
  in full**, plus **the files it changed** (`git diff --name-only HEAD` +
  untracked, no `git add -N`, so naming files never touches the index), with an
  instruction to re-read those files and nothing else.
- **`resume`**, unchanged, is what a failed compaction falls back to for the
  **publish turn** specifically. Publish commits work it must already know
  about, and the existing no-session path for it is `publishRepo` in-process,
  not "a new agent guesses a commit message" — so that one turn pays the old
  price rather than handing the commit to a stranger.

`--autocompact <100k..1M>` does the same compaction with `trigger:'auto'` and
was measured working too (175,101 → 6,682). It is **not** what we use: it takes
no focus string, and it would then apply for the whole resumed run, which is
exactly the mid-run interference the cap is defined to avoid.

Two consequences worth knowing. A compaction is a paid turn on the resumed
transcript, and the resume baseline is snapshotted **before** the gate runs, so
that cost lands on the run that chose to compact — which is what makes the
comparison below honest. And for the ~1–3 minutes it takes, the task sits
`running` with no run row and no PTY yet; like a headless adversarial review, it
holds no orchestrator concurrency slot, only a `liveHeadless` entry (so
`/killall` and the restart guard still see it).

### That window is the dangerous part

Before this gate, the distance between `followUp` marking a task `running` and
the PTY spawning was a few milliseconds. It is now up to ten minutes, which is
long enough for the world to move — and everything downstream of the gate used
to assume it had not. Two rules close that:

- **A compaction WE stopped is `aborted`, never `failed`.** The answer to a
  failed compaction is to spawn an agent; doing that seconds after `/killall`
  reported the machine idle, or while a forced restart is closing storage, is
  the worst outcome the gate can produce. `stopAllHeadless()` records when it
  swept (`headlessStoppedSince`), `cancel()` stops the compaction for its task
  by name (`abortCompaction`), and either way `resumeHandoff` returns `abort`:
  no run row, no spawn, the task parked in `review` with the reason. A genuine
  CLI failure or a ten-minute timeout is still `failed` and still falls through
  to `fresh` — `compactSession` runs its own deadline timer precisely so a
  timeout's SIGTERM is not mistaken for an abort's.
- **The task row is re-read after the gate.** `cancel()` writes to storage, not
  to the `Task` object `startWorker` is holding; anything other than `running`
  means the turn must not happen, and the re-read row (not the stale one) is
  what gets broadcast, or the UI would flip a just-cancelled task back to
  `running`.
- **A task inside the gate has no run row, so boot recovery cannot see it.**
  `recoverOnBoot` sweeps `tm_runs`; a compacting task is `running` with nothing
  in that table, and nothing else frees the state (`followUp` answers "marked
  running but has no live session", enqueue and retry refuse a running task —
  only Cancel would). So recovery now also sweeps tasks that are `running` with
  no `running` run row, parking them in `review` if they ever had a worker and
  `failed` if they never did. `stop()` additionally awaits `drainResumeGates()`
  before closing storage, so the graceful path settles rather than needing to
  be recovered from; a SIGKILL or a crash cannot be drained, which is why the
  boot sweep is the real fix and the drain is the courtesy.
- **The gate must not be awaited inside the scheduler.** Dispatch delivery runs
  inside `maybeSchedule()`'s single-flight pass, so awaiting a ten-minute
  compaction there would freeze the claim loop, the custom queue and every
  other delivery. It fires the `followUp` and settles from its result instead
  (`docs/dispatch.md` § Delivery).

Because a turn can now be certain-but-unspawned for minutes, `activeWorkers()`
counts those too — gates in flight and dispatch turns fired — rather than live
PTYs alone. `status()` still reports the honest live count for the UI.

Every spawn records which path it took: `run.started` gains
`handoff: 'resume' | 'compact' | 'fresh'`, plus `contextTokens` (what the gate
measured), `cap`, and either `compactedFrom`/`compactedTo` or `compactError`.

Note that an ordinary cold claim — a queued task with no previous session at all
— also records `handoff: 'fresh'`, because that is what it is. The two are told
apart by `contextTokens`, which is present only when there WAS a session to
resume: `fresh` with a `contextTokens` (and a `compactError`) is the gate
declining, `fresh` without one is just a new task starting.

### Counting the saving

Unlike the two sections above, this one shows up directly in money. Take a task
with several resumes and compare `costUsd` of runs whose `run.started` carries
`handoff: 'resume'` against the ones carrying `'compact'`, on the same task and
the same model. The re-write is the floor of a resumed run's cost, so the
difference should be most of it.

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
5. Exercise the resume gate at a cap low enough to fire on a small session
   (`agent.resumeContextCap`), then read the `run.started` row: `handoff` must
   say `compact`, `compactedTo` must be far below `compactedFrom`, and the
   session must still be the same one in the same terminal. A `handoff: 'fresh'`
   here is a compaction that failed, not a success — read `compactError`.
