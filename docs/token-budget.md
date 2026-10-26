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
the todo list (`TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet` on current CLIs,
`TodoWrite` on older ones — the board's work % reads it, `docs/task-progress.md`), `WebFetch`/`WebSearch`, and `Skill`/`ToolSearch` so a project skill
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
window so the CLI never compacted on its own (until § The fifth gave work turns
a window of their own); the 2026-08-31..09-01 sessions
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
the raw number behind `contextPct`. Until 2026-10-26 the percentage divided by
a fixed 200k and clamped at 100, so it read "100%" for every session this
decision is ever about; it now divides by the model's own window (§ Cost
accounting), but the cap stays a token count either way.

Under the cap, nothing changes. Over it, in order of preference:

- **`compact`** — a turn whose prompt IS the `/compact` slash command, run
  since 2026-09-24 as an attachable aux terminal (kind `compact`):
  `claude --resume <id> … -- "/compact <focus>"`. It was a `-p` turn before, and
  the cost shape is the same; see § Aux sessions. Measured against CLI v2.1.257 on
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
was measured working too (175,101 → 6,682). It is **not** what the GATE uses:
it would apply for the whole resumed run, which is exactly the mid-run
interference the cap is defined to avoid, and (at the time) it took no focus
string. The second reason is obsolete — a `PreCompact` hook's stdout is the
focus — and an in-run ceiling for every work turn now exists on purpose, in
§ The fifth (decisions.md 2026-10-26). The gate is unchanged by it: it still
decides every resume, and the window is never set below the cap.

The gate's `/compact` is also the last thing a resumed session hears about its
first prompt, so since § The fifth the focus carries a "preserve word for word"
clause (`compactPreserve`: the trailer rule, the push rule, the definition of
done, `$TM_ARTIFACTS_DIR`, a loop's result block), and the first resume after a
gate compaction re-sends the definition of done, which a resume never carried.

Two consequences worth knowing. A compaction is a paid turn on the resumed
transcript, and the resume baseline is snapshotted **before** the gate runs, so
that cost lands on the run that chose to compact — which is what makes the
comparison below honest. And for the ~1–3 minutes it takes, the task sits
`running` with no WORKER run row and no worker PTY yet. The compaction itself is
an aux run in the aux pool, so it holds no orchestrator concurrency slot, and
`/killall` and the restart guard still see it.

### That window is the dangerous part

Before this gate, the distance between `followUp` marking a task `running` and
the PTY spawning was a few milliseconds. It is now up to ten minutes, which is
long enough for the world to move — and everything downstream of the gate used
to assume it had not. Two rules close that:

- **A compaction WE stopped is `aborted`, never `failed`.** The answer to a
  failed compaction is to spawn an agent; doing that seconds after `/killall`
  reported the machine idle, or while a forced restart is closing storage, is
  the worst outcome the gate can produce. `aux().stopAll()` records when it
  swept (`aux().stoppedSince`), `cancel()` stops the compaction for its task
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

## The fifth: context growth INSIDE a fresh session (2026-10-26)

The resume gate only acts between turns. A fresh session that grows in one long
run never meets it: **138 of 441 worker runs** in the 30 days to 2026-10-26
ended at ≥300k context and carried **62.9% of the $16,688** worker spend (max
585k), all on opus-5-5, whose 1M window puts the CLI's own autocompact at
≈967k — it never fired. Every turn past ~300k re-reads all of it.

### What a work turn gets

- **`CLAUDE_CODE_AUTO_COMPACT_WINDOW`** in the worker env, from
  `agent.autoCompactWindow` via `autoCompactWindowFor` (shared). The env var
  outranks `--autocompact`, `/autocompact` and `autoCompactWindow` in the
  user's settings, so one rule holds whatever `~/.claude` says. Resolution:
  0 = none (the CLI default); otherwise raised to at least
  `agent.resumeContextCap` (a lower window would compact a session the gate
  just chose to resume as-is — the gate owns resumes), clamped to the CLI's
  100k..1M, and dropped when it is not below the model's own window (the CLI
  takes the minimum anyway — a haiku session is left alone). Never on the
  **publish turn** (it only commits and pushes, and the gate already compacted
  a big one), never on codex.
- **`PreCompact` (matcher `auto`)** → `POST /api/internal/runs/:id/compact-focus`.
  The hook's plain stdout becomes the compaction's custom instructions (main
  session only), so it prints `compactFocus(title, turn instruction, purpose,
  compactPreserve(…))` — the gate's own focus, naming the follow-up this run
  was started on (`turnInstructions`, memory only) and the rules to keep word
  for word. Like the AskUserQuestion carrier its stdout matters, so it is not
  `hookCurl`: `curl -sf … || true` — an HTTP error or a dead server prints
  NOTHING (the CLI's default instructions) and never exits 2 (which would block
  the compaction). Each one writes a `run.auto-compact` audit row (trigger,
  last measured context) to count them by.
- **`SessionStart` (matcher `compact`)** → `/compact-context`, answering the
  CLI's `hookSpecificOutput.additionalContext` JSON: `postCompactRules` — the
  resume reminder (the standing rules, condensed), the trailer rule, the push
  rule (`shipRuleFor`), the definition of done, a loop iteration's result block.
  A summary keeps what it is told matters, and the first prompt's rules are
  exactly what a "what has been done" recap drops; restated after the
  boundary they are in context whatever it kept. Fires on a human's `/compact`
  in the terminal too. The plain SessionStart hook keeps firing beside it.

Both routes answer 204 (→ the hook prints nothing) for anything but a worker
run, and both sit under the per-run token guard.

### The window: 300k

`agent.autoCompactWindow` defaults to **300 000**, the resume cap's number. The
quality constraint above — good work has come out of ~300k sessions — is the
ONE thing measured about where quality starts to be in question, so the
ceiling sits AT the known-good size, not below it (the superseded draft
ea3bad8b's 150k contradicted it). One number then bounds a session in-run and
at resume. The CLI keeps ≈33k of headroom under the window (measured: a
100k window compacted at preTokens 67,548 and 68,680, matching ≈967k on 1M),
so 300k compacts at ≈267k, to ≈13–30k.

One overlap is deliberate: a session the gate resumes as-is because it is
under the cap but above that threshold (≈267–300k) compacts early in the
resumed turn (not measured on a resume: in-run, the CLI compacted between
calls, as soon as the last reading crossed the threshold), focused on the
follow-up (`turnInstructions`). Setting the window to cap + 33k would avoid it at the
price of a ceiling above the known-good size.

Simulated over 392 last-30-day worker transcripts (compaction to 30k, each
costing a full read, 15k output and a cache rewrite — upper bounds, rework and
quality loss not modelled; autonomy-round analysis 663c5006):

| Window | Saved / 30 days | Compactions |
|---|---|---|
| 200k | ~$4.9k | 320 |
| 300k | ~$2.8k (~17% of worker $) | 139 |
| 400k | ~$1.0k | 42 |
| 500k | ~$0.1k | 9 |

Re-measure before moving it: compare per-task `costUsd` and rework (fix rounds,
`run.auto-compact` rows per task) before vs after. Lowering it toward 200k needs
evidence that compacted sessions still do good work; raising it gives most of
the saving back.

### What did not change

- **The resume gate.** Its boundary reader (`readBoundary`) skips
  `trigger: 'auto'` boundaries: a worker that compacted itself in its last
  seconds would sit inside the gate's minute of slack and pass for the gate's
  own `/compact` (`trigger: 'manual'`, measured). A boundary with no trigger
  (older CLI) still counts.
- **The session.** An auto-compaction keeps the session id and the transcript
  file (measured: resumed after two of them, same id, the summary's facts
  intact), so `--resume`, Proceed, publish and `statsBaseline` are untouched —
  the transcript is append-only, so the cumulative baseline deltas stay right,
  and run cost is charged by time window anyway.
- **`contextTokens`** follows a main-chain `compact_boundary`'s `postTokens`
  (`stats.ts`): a compaction writes no usage line, so a run cut right after
  one used to read its pre-compaction size and would have sent the gate
  compacting it again.
- **Not counted:** the compaction call itself writes no `usage` line, so its
  cost (one read of the ~267k context plus the summary) is invisible to
  `costUsd`, as the gate's own compaction always was.

## Aux sessions: interactive terminals instead of `claude -p` (2026-09-24)

Every non-worker claude (review, plan, plan-review, analysis, compact, report,
chat, commit) became an interactive terminal (`docs/design.md` § PTY sessions).
The obvious worry is the one measured at the top of this file: an interactive
session's preamble is BIGGER than `-p`'s (41,649 vs 24,956 on this repo). It
does not come out that way here, because the aux runner applies the worker's
three levers to every role except chat:

- `--tools=` names only what the role can use under `dontAsk`: Read/Glob/Grep/
  Agent/TodoWrite for review and analysis, the same plus Bash for planning,
  Read for compact, and **none** for report and commit (`--tools=`).
- `disableBundledSkills`, in the same `--settings` JSON that carries the hooks.
- `--no-chrome`.

**Measured** on this repo, first assistant message, Haiku 4.5, CLI 2.1.280:
the interactive session with `--tools=Read,Glob,Grep` + `--no-chrome` +
`disableBundledSkills` cost **18,532** cache-write tokens; `claude -p` with the
old argv (only the four denials) cost **28,478**. The read-only roles are about
10k tokens cheaper per turn than they were. A `--tools=` session (report, commit)
drops further.

**Nothing re-buys context per turn that `-p` did not.**
- One aux session is one conversation. A correction for an invalid result is
  TYPED into the same live session, so it is one more turn on a warm cache, never
  a second process that would re-write the prompt.
- The session is ended as soon as its result is accepted, so no idle terminal
  lingers into a cache expiry.
- The two kinds that `--resume` (chat turns, compaction) did so under `-p` as
  well, one resume per turn, and still do exactly that.
- A chat turn's cost is what the transcript recorded during the turn (its run's
  time window, § Cost accounting; the `statsBaseline` subtraction before
  2026-10-26), which is what `-p`'s `total_cost_usd` reported.

**Two accounting differences, both visible now.**
- Every aux session is a `tm_runs` row with transcript stats, so the dashboard's
  spend (`/api/stats`) now INCLUDES review, plan, report, chat and commit sessions.
  Under `-p` only the analysis row was counted; the rest never reached a row.
- A compaction row reads **$0**. The summarising request is not written into the
  transcript as an assistant message with usage, and its stats are the transcript
  delta. Its real cost still lands where § The gate says: on the next worker
  run's first turn, as before.

## Fuses: a ceiling before any loop (2026-10-19)

Everything above trims what a turn costs. The fuses bound how many turns get
bought without a human deciding: autonomy part 1 of 6 (the verify loop,
on-green landing and loop tasks all rely on them). All three live in `tm_config`
(Config → Budget & alerts, `PUT /api/config`) and are **off by default** — `0`,
and a `null` PUT is stored as `0`.

**The measure: `Task.costUsd`.** The sum of `RunStats.costUsd` over the task's
worker runs AND the aux runs about it (review, compact — `task_id` NULL,
`subject_id` = the task; attribution `runTaskId` in shared). It is kept on the
row: `tm_tasks.cost_usd` (migration 33) is rewritten by `updateRun` whenever a
run's stats are written — one `UPDATE … SET cost_usd = (SELECT SUM …)` over
`tm_runs.cost_usd`, the `stats.costUsd` figure lifted out of the JSON so both
dialects sum it with one statement (`storage/cost-sql.ts`). Resumed runs already
report only their own window (`summarizeRun`, § Cost accounting), so the sum
never double counts.
Existing rows were backfilled in JS inside the migration's transaction. Every
stats writer (the 20s live refresh, the Stop/SessionEnd hooks, exit, an aux
session's finish) then re-broadcasts the task, so the card's `Σ $x.xx` chip and
the task panel's moves with the run's own chip. `updateTask` never writes the
column, so a stale copy of a task cannot clobber it.

**`budgetAllows(task, kind)`** (`server/src/budget.ts`, wrapped as
`Orchestrator.budgetAllows`) is the ONE gate the later parts call:

| kind | measured against | asked by |
|---|---|---|
| `claim` | today's spend vs `budget.dayUsd` | `maybeSchedule`, once per pass |
| `fix-round` | the task's roll-up vs `budget.taskUsd` | `runReviewRound`, before typing findings back |
| `dispatch` | ″ | `deliverDispatches`, before a `needs_action` wake |
| `wake` | ″ | `wakeDue`, before the 5h-window resume |
| `check-round` | ″ | the repo-check fix round of the verify loop (`docs/checks.md`) |
| `transient-resume` | ″ | `fireTransient`, before each automatic resume of a turn a transient API error cut short (`docs/design.md` § Transient API errors) |
| `auto-publish` | ″ | `landIfClean`, before the publish turn of an `auto-publish` landing tier (`docs/design.md` § Landing tiers); labelled "publish turn (auto-publish landing)" |
| `loop-iteration` | ″, and the loop's own `loopBudgetUsd` | `settleLoopIteration` and `pumpLoops`, before a loop task's next iteration (`docs/loops.md`) |

**Loop tasks (2026-10-19).** On a `kind: 'loop'` task every per-task kind
above is ALSO measured against the task's own `loopBudgetUsd`; the lower of it
and `budget.taskUsd` wins, and a refusal by the loop's cap names the fuse
`loop.budgetUsd` (`loopBudget()` in `budget.ts`). The loop budget is required
on create and, unlike the global fuses, always on.

At or OVER the cap refuses. It returns `{ ok: true }` or
`{ ok: false, fuse, spentUsd, capUsd, reason }`.

- **`budget.taskUsd`** — no AUTOMATIC turn starts once the task has cost that
  much. Refused, the reason goes on the row (`error`, keeping any earlier error
  under it as `Earlier: …`), a `task.budget` audit row records the fuse, and one
  `task-budget` anomaly ping goes out per task and cap. The task stays where it
  is parked (`review` for a fix round, `review`/`failed` for a wake); a later
  caller that refuses a task still `running`/`waiting` moves it to `review`.
  Per path: the fix round leaves the findings `flagged`; a dispatch is settled
  `failed` with the reason (the message stays readable on its row, never
  retried every pass); a wake clears the mark and is audited
  `task.wake { action: 'refused' }`. **A human click is never gated**: Proceed,
  Run now, Retry, Follow-up, Apply fixes and Publish do not call it. An
  auto-publish landing IS gated since the landing tiers (2026-10-19): the
  orchestrator starts that publish turn, not a human, so it asks
  `budgetAllows(task, 'auto-publish')`; a refusal goes through
  `refuseOverBudget` and leaves the task in `review` for the human's Publish.
- **`budget.dayUsd`** — the orchestrator stops CLAIMING (custom queue, global
  and overflow) for the rest of the server-local day once today's spend reaches
  it. Today's spend is every run of any mode STARTED since local midnight
  (`spendSince`, indexed on `started_at`) — the Dashboard's attribution, so a
  turn that started at 23:50 counts for the day it started. Running turns
  finish; dispatch delivery, fix rounds and wakes are continuations and fall
  under `budget.taskUsd` instead. One `task.budget` row and one `day-budget`
  ping per day; the Dashboard shows it as a critical anomaly and stops calling
  queued tasks starved.
- **`budget.runMinutes`** — wall clock per worker turn (`run.startedAt`; every
  resume is a new run). Past it the 60s anomaly sweep raises the run's
  needs-attention flag and you get the attention ping worded for it (⏱ Over N
  min). The turn is **never killed**. The flag is deliberately not stamped in
  `attentionAt`, so the agent's own progress does not clear it (it IS
  progressing); Stop and exit clear it like any flag. A real permission prompt
  on that run takes the flag over (`takeOvertimeFlag` in the attention route), so
  the prompt still gets its own ping and clears on progress as usual. Raised
  once per run. **The fuse's flag never means "blocked on a human"**: every
  rule that read `needsAttention` that way asks `Orchestrator.promptAttention(run)`
  instead (flag set AND not the fuse's). Two did (review round 1): the
  shell-wait expiry replay, which held a park on any flag and so left a
  dev-server park `waiting` forever — holding its slot and, through the
  same-repo gate, its repo — and now lands it and clears the fuse's flag; and
  the usage-limit parker, which skipped any flagged run and so never parked an
  over-time turn the 5h window then cut short.

### The expensive-task alert: each repo's own history (2026-10-26)

The `cost-high` notification (`docs/telegram.md` § Anomalies, push kind
`anomaly`) used to compare a task's roll-up to `anomaly.costUsd` = $10, which
sat below the median task of every repo but one: 126 critical alerts for 126 of
146 tasks in a week, so neither the alert nor the word "critical" carried a
signal. Two settings now, one rule each:

| setting | compares | where | default |
|---|---|---|---|
| `anomaly.costUsd` | one RUN's `stats.costUsd` | the Dashboard's `cost-high` row only (`routes/stats.ts`) | $10 |
| `anomaly.taskCostUsd` | a TASK's roll-up `Task.costUsd` | the minute sweep's `cost-high` notification | `0` = adaptive |

**The line** (`costLine(repoId, tasks, fixed)` in `server/src/anomalies.ts`,
pure): a fixed `anomaly.taskCostUsd` > 0 is the line as given. `0` is adaptive:
the nearest-rank p90 of the task roll-ups of the SAME repo over the tasks
updated in the last 30 days (`COST_LINE_WINDOW_MS`), counting only tasks that
cost something (a $0 draft says nothing about what work costs); a repo with
fewer than 10 such tasks (`COST_LINE_MIN_TASKS`) uses the all-repo p90; and the
line is never below **$10** (`COST_LINE_FLOOR_USD`). The baseline is ONE
`listTasks({ updatedSince })` per sweep, cached for an hour
(`Orchestrator.costBaseline`). The tasks judged are unchanged: those with a run
in the last 24h or still live.

**Severity** (`costVerdict`): above the line → `warn`, key `cost-high:<task>`;
above 2× the line → `critical`, key `cost-high-2x:<task>`. Each key goes out
once ever, so a task that keeps growing escalates exactly once; a task that
jumps straight past 2× gets only the critical one, and a task already pinged
critical never gets a warn after it (the line moved up). Tasks pinged under the
old rule keep their `cost-high:` key, so they can only escalate. The `budget.*`
fuse trips (`task-budget`, `day-budget`) stay their own alert types.

**The message states the baseline**: `has cost $118.40, 1.3× this repo's p90
($92)`; the all-repo and floor cases say so (`the all-repo p90 ($92; this repo
has under 10 tasks in 30 days)`, `the $10 floor (p90 $7.50)`), a fixed line says
`the $50 threshold`. The audit row's data carries `costUsd`, `lineUsd`,
`lineSource`, `p90`, `n`.

**The alert is not the control.** An adaptive line self-normalises: if every
task gets dearer the p90 drifts up with it and the alert goes quiet — the floor
bounds that from below only. The hard ceiling is `budget.taskUsd` (off by
default, above); set it, not this, to stop spend.

Measured on a copy of the live DB (2026-10-26, after subagent spend was counted):
lines neko-frontend $98, neko-nest $73, task-manager $58, neko-vite-new $24,
two small repos on the all-repo $92; of the 136 tasks with a run in the last 7
days the old rule alerted 117 (86%), the new one 17 warn + 0 critical (12.5%).

Not built: the velocity rule (one run's cost growing > $X in 10 min from the
20s live-stats tick), which would catch context growth while it happens.

## Cost accounting: what a run is charged (2026-10-26)

`RunStats` is parsed from the session's transcripts by `summarizeTranscript`
(`claude/stats.ts`); `costUsd` is an ESTIMATE at list prices, and it feeds
every chip, `Task.costUsd`, the fuses and the anomaly alerts. Three gaps were
closed together (autonomy-round analysis 663c5006, feasibility § 1). Together
they raise every cost roll-up by about 30%. Measured over 30 days and 474
sessions: about $4.0k of subagent spend and about $1.45k of 1h cache writes
were missing, against $18.4k recorded.

**Subagents are counted.** The CLI writes a subagent's conversation to its OWN
file, never to the parent's: `<project>/<sessionId>/subagents/agent-<id>.jsonl`
(+ `agent-<id>.meta.json`: `agentType`, `toolUseId`, `spawnDepth`). Nested
subagents land in the same flat folder. Every line is `isSidechain: true`. The
old parser read only `<sessionId>.jsonl`, so its `isSidechain` filter never
saw a sidechain line, and 249 of 474 sessions had uncounted subagents (run
5559a62e recorded $32.56; with its Explore subagent and the 1h price it is
$49.08). `RunStats.subagentCostUsd` is the subagents' part. It is already
inside `costUsd`, and it is absent on rows summarised before. Subagent lines
never touch `contextTokens`, `contextPct` or `lastAssistantText`: those
describe the main chain's last turn.

**Every message is priced at its own model.** `message.model` sets the price,
falling back to the run's model for `<synthetic>` and lines without one,
because a subagent runs opus, fable, sonnet or haiku whatever its parent is.
A resume that switches model is priced correctly on both sides as well.

**Cache writes are priced by TTL.** A 5-minute write is 1.25× input and a
1-hour write is 2× input. They are split on
`usage.cache_creation.ephemeral_1h_input_tokens` / `…_5m_…`. Worker sessions
write only 1h cache (113.6M tokens in 30 days, none at 5m) and subagents only
5m. A line without the split is billed at the 5m rate, as before.

**A message is counted once, at its largest reading.** One API message spans
several transcript lines, each repeating its usage, so they are deduped by
`message.id`. The repeats are not identical, though: `output_tokens` grows
across a streamed message's lines (482 of 6,965 repeats, never shrinking). The
old first-line rule therefore undercounted output, so each field now keeps its
maximum. `usage.ts`'s 5h/7d estimate had the same bug and the same blind spot
for subagent files. Both are fixed there too.

**A run is charged by TIME, not by subtraction.** `summarizeRun` counts the
messages stamped inside the run's `startedAt..endedAt` window (open while it is
live), across the main and subagent files. The old approach subtracted
`statsBaseline` from the whole session. That is now only the fallback for a row
with no `startedAt`, and the baseline is still captured at resume. Subtraction
would have been wrong after this change. Every baseline written before it
excludes subagents and is priced at the old cache rate, so a resumed run
re-summarised afterwards would have absorbed the whole session's earlier
subagent spend plus a repricing delta. A window does neither. It is exact
because runs on one session never overlap in time (a resume never shares a
session id with a live process). On 40 resumed runs the window reproduced the
subtraction's token counts exactly.

**Parsed files are cached** by path on mtime+size (≤ 400 files, least recently
used out). The 20 s live refresh re-summarises every running run, and a
finished subagent file never changes again. A cache hit costs about 1 ms
against 20–90 ms for a parse.

**Context share is per model.** `contextWindowFor(model)` (shared, a prefix
table like `priceFor`) returns 200k for `claude-haiku-4-5` and 1M for
everything else in `MODEL_OPTIONS`: Fable 5.x, Opus 5.x and Sonnet 5 run a 1M
window by default. `contextPctOf(stats, model, window?)` recomputes the share
from `contextTokens` wherever a row has it (rows before that field return the
stored, 200k-clamped figure). Its readers are the run chips (`RunMeta`, `Queue`),
the Telegram board, the Dashboard's average/max context and the
**`context-high` anomaly** (>80%). The anomaly fired on 334 of 453 worker runs
in 30 days against the 200k divisor; against the model's window it would have
fired on none, because the largest sessions reach about 500k. The `window`
argument is for an autocompact window, as the CLI's own status line divides.
`agent.autoCompactWindow` now exists (§ The fifth), but no reader passes it, on
purpose: against a 300k window every session about to compact would read
>80% and `context-high` would fire on the mechanism working. A `<synthetic>` message (the CLI's own error or
limit notice, with all-zero usage) no longer counts as the last turn. Before,
a session that ended on one read as `contextTokens: 0`, which let the resume
gate wave a 400k resume through.

**Not backfilled.** Run rows summarised before this change keep their old
`costUsd`. The CLI deletes transcripts after about 30 days anyway, and a
re-summarise rewrites history that the day fuse and past reports already read.
A run is re-priced only when something summarises it again: the live refresh,
a hook, or exit.

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
