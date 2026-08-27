# Worker prompt — the standing rules

Every worker session is spawned by `buildWorkerInvocation` (`server/src/claude/worker.ts`)
with a prompt whose tail is a fixed block of standing instructions. There are two
copies of that block and they are ONE policy:

- `STANDING_RULES` — appended to a **fresh** prompt (`# Task: …` + description
  [+ previous summary and follow-up instruction]).
- `RESUME_REMINDER` — appended to a **resumed** turn (`claude --resume`, i.e.
  Proceed / follow-up / review-fix / dispatch delivery). The session already
  holds the original prompt; this only re-anchors the rules in case the
  conversation was compacted along the way.

**Edit them together.** A resumed turn arrives *after* the fresh prompt, so
whatever the reminder says is the most recent instruction the agent has seen —
a stale reminder silently overrides the new rules for the rest of the session.

## What the block says

| Rule | Why it is there |
| --- | --- |
| Work autonomously | No human is watching the hidden terminal. |
| **Plan first** | State what you will change, in which files, and how you will verify it — then execute, same turn. |
| **Delegate exploration** | Repo exploration and multi-file reading go to a subagent; act on its summary. Max 3 subagents per session, one at a time, no parallel fan-outs. |
| `$TM_ARTIFACTS_DIR` | The task's shared file space — inputs from the user, deliverables back to the task panel. |
| Task Manager API | File follow-up/cross-repo work instead of doing it yourself; never work around the API's refusals. |
| Dispatch before create | A related task already exists → message its session (`docs/dispatch.md`), don't mint a duplicate task. |
| Final summary | The orchestrator stores it as `result_summary`; the review round and the next run read it. |
| Adversarial review warning | The change is reviewed before the human sees it, so it must compile and hold up. |

### One exception: the publish turn

`PUBLISH_INSTRUCTION` (`docs/publish.md`) is deliberately *narrower* than the
standing rules — no code, no subagents, and the closing report is the commit sha
and push result rather than a work summary. On that turn only, the reminder is
placed **above** the instruction, so the last thing the agent reads is the narrow
version and not "plan, delegate, summarise". Every other resumed turn keeps the
usual order (instruction, then reminder).

## Why "delegate" is phrased as a directive, not a cap (2026-08-27)

The subagent line used to read *"Do not spawn more than 3 subagents in this
session, and avoid parallel agent fan-outs."* That is a pure prohibition, and
agents complied with it perfectly: sidechain (subagent) spend across the whole
audited week was **$0**. Nobody delegated anything.

The cost of not delegating is measurable. In the token audit (7 days to
2026-08-27, full report in the "Audit project for token usage" task artifact
`token-usage-audit.md`), **68.4% of all spend was cache read** — the
conversation re-sent on every turn. Session cost is Σ over turns of (context
size at that turn), so a file the agent reads inline is not paid for once, it is
paid for on every remaining turn of the session. In the transcript of "Search UI
update (map mode)" (289 turns, context 54k → 476k, $190 across 4 runs), 65 turns
were pure exploration (`sed`/`grep`/`cat`/`find`/`git log`/Read) and their output
drove 24% of all context growth. Modelled against that same transcript,
delegating exploration cuts the main chain from **$126 → $86 (-32%)**, *after*
paying three subagents' own ~50k preambles (~$7). A subagent's exploration is
discarded when it returns; only its conclusion enters the parent context.

So the line now leads with the instruction ("delegate … and act on its summary"),
carries the reason in one clause, and states the cap as a ceiling on the
delegation it is asking for — `Up to 3 subagents per session, one at a time, and
no parallel agent fan-outs`. The cap that `CLAUDE.md` mandates is fully intact
in both copies; what changed is that it now bounds a behaviour instead of
forbidding one.

**Do not "tidy" this back into a prohibition.** Wording like "do not spawn more
than 3 subagents" with no directive in front of it reproduces the $0-sidechain
behaviour the audit found.

## Why plan-first

17 of 70 tasks (24%) needed more than one run, costing $716 — 33% of tracked
spend — and 66 of 100 runs ended `killed`. Rework, not turns-per-run, is the
expensive failure mode. Plan-first is aimed at that: modelled on turn count
alone it is only ~5% ($126 → $119), so it should not be judged by tokens per
turn. It is deliberately the *regular-terminal* habit, not plan mode — no
approval gate, no separate turn, a couple of sentences for a small task.

## Out of scope here (identified by the same audit, not yet done)

Prompt text alone cannot fix these; they are structural:

- No context ceiling / forced compaction on long runs.
- `CONTEXT_WINDOW = 200_000` (`server/src/claude/stats.ts`) pins `contextPct` at
  100 while real contexts reach 476k–910k.
- `anomaly.costUsd` is read only by the stats dashboard route, never enforced.
- The sticky `fableUnavailable` latch in `server/src/claude/review.ts`.
- ~~The fixed ~52k preamble~~ — done 2026-08-27, see `docs/token-budget.md`.
  (Not via `agent.allowedTools`: that flag is a permission gate and moves no
  context. The schemas come off with `--tools`.)

## Keep it short — it is re-sent every turn

This block is part of the fixed preamble measured in `docs/token-budget.md`: it
is re-sent on every turn of the session, so a paragraph added here is paid for
dozens of times. The 2026-08-27 pass rewrote both constants tighter — same rules,
same mandated caps, ~a third fewer words — which is why the wording is terse.
Terse is not the same as gutted: every rule in the table above must survive any
edit, and the `CLAUDE.md`-mandated "max 3 subagents per session" must appear
literally in **both** constants.

## Verifying a change to this block

`npm run typecheck` and `npm run build`, then compose both branches of
`buildWorkerInvocation` (with and without `resumeSessionId`) and read the last
element of `args` — the caps must survive in both and must not contradict each
other. The behavioural signal is in the transcripts: the first assistant turn
states a plan, and exploration shows up as sidechain messages with **non-zero**
subagent token usage rather than a long inline run of `sed`/`grep`/`cat`.
`tm_runs.stats` for a comparable task before/after gives the number that
matters: cost per task.
