# Feature interface — big request → analysis → reviewed plan → approved tasks

Status: **implemented 2026-08-25** (design written the same day). This file is the original design analysis, kept verbatim below, plus an **[As built](#as-built-2026-08-25)** section at the end recording where the implementation went further than, or deliberately away from, the design. Companion doc: [`future/autonomy-cloud-shadow.md`](future/autonomy-cloud-shadow.md) — the request that motivated this: a single user ask ("dockerize + shadow DB + cloud autonomy") that is far too big for one task and needs phased decomposition.

## Motivation

Today the intake units are a single task (human-written) or an Analyze run over existing tasks. There is no home for a **big request**: a paragraph-to-page description of a large capability, which needs to be analyzed, decomposed into ordered tasks, sanity-checked, *approved by the human*, and then executed by the normal orchestrator machinery over hours or days. The docker/shadow/cloud analysis is the canonical example: ~4 phases, each several tasks, with strict ordering (containers before shadow enforcement before cloud).

The Feature interface is that home. Key property: **it composes almost entirely out of existing subsystems** — structured analysis in a read-only aux terminal (`analyze.ts`), adversarial review (`review.ts` pattern), proposal-accept transactions, parent/child task mechanics, the claim loop. What's genuinely new is one entity, one pipeline, and one page.

## Concept and lifecycle

A **Feature** is per-repo (user decision) and owns: the raw request text, the (reviewed) analysis, and a set of generated tasks grouped into ordered phases.

```
draft ──▶ analyzing ──▶ analysis-review ──▶ proposed ──▶ approved ──▶ running ──▶ review ──▶ done
  │            │               │  ▲             │                        │
  │            └── failed      │  └─(blockers:  │                        └─▶ paused (a task failed;
  └──▶ cancelled (any state)   │     re-analyze,│                             human unpauses/edits)
                               │     bounded)   └── user edits tasks freely before approving
```

- **draft** — user writes/edits the big request (title + long markdown body, optional attachments via the existing artifacts dir mechanism).
- **analyzing** — one planning session (an aux terminal of kind `plan`, attachable from the runs list — `docs/design.md` § PTY sessions; model `claude-fable-5` per role-model policy, write tools disallowed, result as a fenced JSON block validated by zod) with cwd = the repo, prompt = request + repo role + existing open tasks + instructions. Output: structured plan (schema below).
- **analysis-review** — a *second* independent session (kind `plan-review`) adversarially reviews the plan against the request and the repo (missing steps? wrong ordering? tasks too big/vague? contradicts CLAUDE.md/docs?). Verdict `clean | minor | blocker`. Blockers → fold findings into a re-analysis prompt and repeat (since 2026-11-04 the trigger is `needsReplan`: verdict `blocker` OR any blocker/major finding, and only the blocker/major findings are handed back, like the diff review — a reviewer returned `minor` over four majors and the loop stopped with them unfixed), bounded by `feature.analysisMaxRounds` (default 2, mirrors `review.maxRounds`). This is the same shape as the existing work→review→work loop, applied to planning instead of diffs.
- **proposed** — the plan is shown visually (below). Nothing exists as real tasks yet.
- **approved** — user approves (possibly after editing); real `tm_tasks` rows are created transactionally (composite storage method, like `acceptProposal`).
- **running / paused / review / done** — execution + roll-up, below.

## Data model

New table + one column on tasks (migration N):

- `tm_features(id, repo_id, title, request TEXT, status, analysis TEXT /*JSON: latest plan*/, review TEXT /*JSON: findings/verdict per round*/, analysis_rounds INT, error, created_at, updated_at)`
- `tm_tasks` gains nullable `feature_id` and `feature_phase INT` (0-based phase index). Existing `priority`/`parent_id` untouched — a feature is **not** modeled as a parent task: parent/child means "split of one task" with all-children-resolve semantics; a feature needs phase ordering, a request document, and an approval gate, which don't fit that machinery. Tasks within a feature can still be split by workers as usual (their children inherit `feature_id`/`feature_phase`).
- Task `source`: new enum value `feature` (provenance chip in the Board search's `source` facet alongside human/agent/sentry/analyze; a `feature` facet narrows to one feature's tasks — `docs/search.md`).

Payloads TEXT not JSONB, `tm_` prefix, dialect-neutral SQL — per the storage rules.

## Analysis output schema (zod, both sides)

```ts
{
  summary: string,                 // 1-paragraph restatement of intent
  considerations: string[],        // risks, decisions taken, rejected alternatives
  phases: [{
    title: string,                 // "Per-run worker containers"
    goal: string,
    tasks: [{
      title: string,
      description: string,         // full worker-grade prompt body
      category?: string,           // reuses task categories
      effort?: 'low'|'medium'|'high'|'xhigh'|'max',
      review?: boolean,            // per-task review override, reused
      exitCriteria: string[]       // folded into description; also shown on the card
    }]
  }]
}
```

Docs rule applies: every generated task description must end with the standing caps (max 3 subagents; orchestrator concurrency stays 2) and the docs-update exit criterion — inject these server-side, don't trust the plan to include them.

## The visual approval surface

New **Feature page** (route `/features/:id`, entry from a Features section per repo — a tab on the Repos page or a sidebar item):

- Request at top (collapsible), then analysis `summary` + `considerations`, then the adversarial-review verdict/findings for transparency.
- **Phases as horizontal groups (columns), task cards inside** — same card idiom as the Board. Every card is editable pre-approval: title/description/category/effort inline, toggle a card off (excluded from approval), reorder within a phase, move between phases, add a manual card. All edits mutate the stored `analysis` JSON — no task rows exist yet.
- Actions: **Re-analyze** (with an optional user note appended to the prompt; when the LAST review round left blocker/major findings on the stored plan, Re-analyze is the next round of that loop — the plan and those findings go into the first prompt, and review rounds keep numbering on), **Approve** (creates tasks, feature → approved), **Cancel**.
- Post-approval the same page becomes the execution dashboard: cards show live task status (reusing `/ws/events` — cards are just tasks filtered by `feature_id`), with the current phase highlighted and per-card links into the existing TaskSlideOver/terminal.

All styling resolves to `--tm-*` tokens as usual.

## Execution semantics

Orchestrator stays untouched except **claim eligibility**: a task with `feature_id` is claimable only if its feature is `running` AND every task in lower phases of that feature is resolved (`done` or `cancelled`). Cheapest implementation: extend the `claimNextQueuedTask` WHERE clause (or pre-filter in `maybeSchedule`) — no new scheduler.

- **Start feature** (approved → running) enqueues phase 0's tasks; when a phase fully resolves, the server auto-enqueues the next phase (event-driven, on the same `resolveChildCompletion`-style hook path).
- **Per-task flow is 100% the existing one**: worker PTY, hooks, adversarial diff review, work→review→work rounds, human review→done (or the repo's landing tier, below). Nothing feature-specific inside a run.
- **Landing tiers make phases flow (2026-10-19, `docs/design.md` § Landing tiers).** A phase is released by its tasks reaching `done`, so on a repo whose tier is `on-green` (or with a per-task override) a task whose checks are green and whose review is clean lands `done` on its own (`landIfClean` → `resolveCompletion` → `advanceFeature`) and the next phase is queued without a click; `auto-publish` gets there through `published`. Feature tasks are created with `landing: null`, so they inherit the repo's tier, and `source: 'feature'` is not external (the human approved the plan), so they are not clamped to `supervised`. **Plan approval stays human** — the tiers govern landing a task, never approving a plan (§ Open questions 2: "approval is the whole point of this interface"). No SQL change was needed: `FEATURE_CLAIM_GATE` and its JS twin `isFeatureTaskBlocking` (`storage/feature-sql.ts`) already treat `done` as resolved, and both are unchanged.
- **Order inside a phase (2026-11-03, `docs/task-waits.md`).** Tasks of one phase run in parallel. A card may name EARLIER cards it needs (`dependsOn`, the planner's `"phase.task"` refs). Approval turns them into the tasks' `dependsOn`, and the claim (`DEPENDS_ON_GATE`, AND-ed into `FEATURE_CLAIM_GATE`) holds the task until they land. A worker that finds such a need only while running WAITS for the sibling (`POST /api/agent/wait`): it parks `blocked` and is resumed, with how to merge the sibling's change, once that sibling lands. `toStoredPlan` mints each card's id ONCE and resolves refs against that table: until 2026-11-04 it re-called the caller's `idFor` (`() => randomUUID()`) per ref, so every stored `dependsOn` pointed at no card and approval silently dropped them all (pinned by the non-deterministic-`idFor` test in `server/src/task-wait.test.ts`).
- **A task fails** → feature → `paused` (mirrors the no-auto-retry decision: never barrel into phase N+1 on a half-done phase N). Human retries/edits/cancels the task, then **Resume**.
- **All phases resolved** → feature → `review`: page shows a roll-up (per-task result summaries + link to per-repo git status for the commit/push buttons). Human marks `done`. Optional later: a final headless review over the feature's whole diff — deferred, since diffs accumulate across many commits and the current review is per-run `git diff HEAD`.
- **Cancel feature** → cancels its queued/draft tasks, kills its running ones (existing kill path), feature → cancelled.

## API

`/api/features` CRUD + `/analyze` (draft→analyzing), `/approve`, `/start`, `/pause`, `/resume`, `/cancel`, `PATCH /plan` (pre-approval card edits). Events: `feature.updated` on `/ws/events`. Agent API: read-only at first (`GET /api/agent/features/:id` so workers can see sibling context); agents do NOT create features in v1 — that's the autonomy doc's intake-tier question.

## Reuse map

| Piece | Status |
|---|---|
| Headless structured analysis (`analyze.ts` envelope parsing, zod validation) | reuse |
| Adversarial review loop w/ bounded rounds (`review.ts` shape, Fable) | reuse pattern |
| Transactional accept → task creation (`acceptProposal` shape) | new composite method, same idiom |
| Phase gating in claim loop | small orchestrator/storage change |
| Feature entity + migration, Feature page, plan-edit endpoints | new |

## Open questions (decide at build time)

1. **Cross-repo features.** User said per-repo; the motivating example was single-repo. But analysis may legitimately propose "this belongs in repo X" — v1: surface as a `new_task` proposal for the other repo, don't model multi-repo features yet.
2. **Auto-approve tier.** Ties into the autonomy analysis (companion doc): an autonomous mode could approve small clean-verdict features itself. Default: never — approval is the whole point of this interface.
3. **Analysis context budget.** Big requests + big repos: the analysis run may want the repo's `docs/` explicitly named in the prompt rather than trusting exploration (cheaper, more deterministic).
4. **Where the request is written.** A `docs/`-checked-in request file (like this one) vs. DB-only text. Leaning DB-only with an "export to docs/" action, keeping the docs-as-exit-criterion rule for the *work*, not the intake.


---

## As built (2026-08-25)

Implemented as designed; the deltas below are the decisions taken while building, and they are the authoritative description of the shipped behaviour.

### Files

| Concern | File |
|---|---|
| Entity, plan/review types, `feature.updated` event | `shared/src/types.ts` |
| Migration 9 (`tm_features` + `tasks.feature_id/feature_phase`) | `server/src/storage/migrations.ts` |
| Composite methods (both drivers) | `server/src/storage/{sqlite,postgres}.ts` |
| Phase-gating SQL, shared verbatim by both drivers | `server/src/storage/feature-sql.ts` |
| Structured-output contract, prompts, caps injection (pure) | `server/src/claude/feature-plan.ts` |
| The two-session pipeline (plan → plan-review terminals) | `server/src/claude/feature-analysis.ts` |
| REST + events | `server/src/routes/features.ts` |
| Phase pump | `Orchestrator.advanceFeature` / `resolveCompletion`; per phase, `planFeatureProgress` in `feature-plan.ts` |
| Office features (cross-repo, a Director's) | `server/src/office/features.ts`, `feature-context.ts`; `docs/office.md` § Director features |
| UI | `web/src/pages/{Features,Feature}.tsx`, `components/FeatureBadge.tsx`, `theme.css` |

### Deltas from the design above

1. **`analysis-review` is not a persisted status.** The plan review runs *inside* `analyzing`. Every call of the pipeline is its own aux terminal: a `tm_runs` row of kind `plan` or `plan-review` with `subject_id` = the feature, attachable and killable from the runs list (`docs/design.md` § PTY sessions). There used to be ONE `analyze` row spanning the pipeline, with the `-p` children tracked under it; that row is gone, and `POST /api/features/:id/analyze` no longer returns a `runId`. **Killing** either terminal fails the feature with "analysis stopped". The feature leaving `analyzing` (cancel, re-analyze) aborts the session in flight within 5 s, rather than paying for a plan nobody will read. The result is the fenced JSON block at the end of the session's final message, validated by the same `planSchema`/`planReviewSchema` zod schemas `--json-schema` was paired with. The tool policy is unchanged from `-p`: `dontAsk`, and Edit/Write/NotebookEdit denied. Bash was never denied to this role, so under `dontAsk` it runs only what the repo's own allow rules permit. The per-feature spend (`costUsd`) now rides on the `feature.analyzed` event, since there is no single row to sum it on. The rounds are visible as `feature.review.rounds[]` instead of as a status. The feature leaves `analyzing` exactly once, for `proposed` or `failed`.
2. **Approve ≠ start.** Approval materialises the cards as **`draft`** tasks, not `queued`. Only `POST /features/:id/start` (approved → running) lets the phase pump move the current phase to `queued`. A plan can therefore be approved and reviewed on the Board before any agent touches the repo.
3. **Phase gating lives in one shared SQL fragment.** `FEATURE_CLAIM_GATE` is spliced into `claimNextQueuedTask` in *both* drivers, so SQLite and Postgres cannot drift. Its JS twin `isFeatureTaskBlocking` drives `resolveFeatureCompletion`; the two are documented as one policy and must be edited together (a mismatch between them wedges a phase — it is exactly the bug the test suite caught during the build).
4. **A worker-filed draft does not hold a phase open.** Children a worker files inside a feature inherit `feature_id`/`feature_phase` (as designed) — but an *unqueued* one (`status='draft'`, `source<>'feature'`) is a human-triage item, not phase work, and is exempt from the gate. Split children, which are queued, do block their phase as intended.
5. **The overflow claim is deliberately weaker.** `claimNextAgentChildTask` (the agent-API R1 credit that lets a live worker's child start at the concurrency cap) applies only a *cancelled-feature* gate. Applying the full phase gate there would deadlock a live session the moment a sibling failure paused the feature.
6. **Standing caps are injected as a marker-delimited block** (`<!-- tm:standing-caps -->`) at task-creation time, inside the approval transaction, by `buildFeatureTaskDescription`. Stripping-then-appending makes re-injection idempotent, so an edited card can never accumulate two copies. Both caps and the docs-update exit criterion are in the block; the plan prompt explicitly tells the analysis *not* to write them itself.
7. **Failure semantics.** Any `failed` task pauses a running feature (as designed). `POST /resume` refuses with a 409 while a failed task remains, rather than no-oping — resuming would re-pause instantly. `pause` does **not** kill running tasks; the claim gate simply stops handing out new ones.
8. **Deleting a repo nulls its features' `repo_id`**, exactly as it already does for tasks (the alternative, a NOT NULL FK, would make repo deletion fail). A repo-less feature refuses to analyze or approve with a clear 409.
9. **`feature.analysisMaxRounds`** (default 2) is a real settings key with a Config row, mirroring `review.maxRounds`. `0` means "review the plan once, never re-plan" — the blocker verdict is still surfaced rather than hidden, and the human decides. A LATER round that fails (its plan session errors or times out, or the 40-minute pipeline budget runs out) keeps the previous plan and proposes it, but `feature.error` says which round failed and whether the plan shown is the one its review blocked — before 2026-11-04 that fallback was silent, and feature 0e323bef sat in `proposed` showing a blocked plan as the outcome. The cause there was `extractJson` (`claude/aux.ts`) cutting the result block at a ``` inside a JSON string; it now tries every later closing fence, farthest first (`server/src/extract-json.test.ts`).
10. **Agent API is read-only and narrow**: `GET /api/agent/features/:id` answers only for the feature the calling run's own task belongs to. Agents cannot create or mutate features in v1 (design open question 2).
11. **Known interaction**: a feature analysis creates an `analyze`-mode run for its repo, so the pre-existing "one analysis per repo at a time" guard on `POST /api/analyze` also refuses while a feature is analyzing. That serialization is intentional.

### Fix rounds (2026-11-04)

Only the FIRST round of a plan is full: a whole plan written, then reviewed whole. Every re-plan after it is a **fix round** (`server/src/claude/plan-fix.ts`), because a full rewrite plus a fresh review each round did not converge. On feature 0e323bef, rounds 3–5 each fixed every finding they were handed, and each review then found an entirely new set of majors elsewhere in a 30-task plan. The planner had also been shown only the previous plan's titles, so it rewrote every description blind.

- **The planner edits.** It gets the stored plan in full (phases numbered, every card labelled by an 8-char id prefix, `cardLabels`/`renderPlanForFix`) and the numbered blocker/major findings (`mustFix`). It returns `edits`: `update` (only the fields it changes), `add`, `remove`, `move`, `add-phase` and `edit-phase`, plus a `notes` entry per finding (how it was fixed, or a rebuttal). The server applies them (`applyPlanEdits`, pure). Untouched cards stay byte-identical with their ids, so a human's card edits survive. A bad reference fails the whole result, and the message goes back to the session as the typed correction (`planFixAcceptor` is the aux `schema`). After the edits, a dependency must point at an EARLIER card, and an emptied phase is dropped.
- **The reviewer judges, it does not re-review.** It sees the plan after the edits, the numbered findings, the planner's notes, the edit log and the changed cards. It returns `previous[{id, status, note}]` for each numbered finding, plus NEW findings only in the changed cards or caused by the edits. On untouched cards it may raise only a blocker it is certain of. New minors are capped at 3 (`PLAN_FIX_MAX_MINORS`, the diff review's `FIX_ROUND_MAX_MINORS`).
- **The server merges** (`mergePlanFixRound`). A finding not marked resolved, including one the reviewer did not answer, stays open (fails closed). The verdict is derived, never the reviewer's word: blocker if a blocker is open, minor if anything is open, else clean. The round stores `mode: 'fix'`, `resolutions` and the edit log, and the Feature page shows "resolved n of m" plus a *What this fix round did* fold.
- An unreviewed fix (the review session failed) resolves nothing: the handed-over findings stay open.
- **Only what the round touched is held to the rules.** Titles and dependency order are checked strictly on the cards the edits changed. On untouched cards, a human's edits that the approval surface allows (a long title, a dependency moved below it or onto a deleted card) never fail the fix: such an edge is dropped, exactly as approval would drop it. A move that breaks an untouched card's previously valid dependency IS refused, and the message names both cards. `null` in an update means unchanged. A numeric phase id such as `"2"` is phase 2. Phases added after the same phase keep their order. A fix may not leave a plan with no tasks. An unreviewed fix keeps a blocker verdict when a blocker is open.
- **Re-analyze** continues with a fix round whenever the last round still has blocker/major findings: the button reads **Fix findings**, and a note may widen the edits. **Re-plan from scratch** (`{fresh: true}`) writes a whole new plan instead. So does a request rewritten since the last round: every round stores `requestHash`, a sha256 prefix of the request it planned for.

### Office features (2026-11-05)

A Virtual Office's Director may file a feature from a shift (`docs/office.md` § Director features). It is the same entity, pipeline, approval surface and phase pump, with these differences, all keyed on `tm_features.office_id`:

- **Repo per card.** `repo_id` is the workspace's first repo, a listing key only. Every plan card carries `repoId` from the office's workspace. The full round's `--json-schema` makes it required with an enum of the workspace's ids. The pipeline's acceptor (`officePlanAcceptor`, also over a fix round's edited plan) rejects a card outside the workspace with a typed correction. `PATCH /plan` refuses one (400), and so does approval, inside its transaction (`FeatureApprovalRefused` → 409, nothing created). A card without one (a human-added card) files into the listing repo. Single-repo features ignore `repoId` and behave exactly as before.
- **Planned from the office folder** (`officeFeatureContext`, `planPlace`): `cwd` = the office folder, `--add-dir` per workspace repo, read-only tools with Bash denied, and the trusted shift's read denies for an untainted feature. The prompts list the workspace's repos. A tainted feature's request is a fenced data block. Planning runs count toward the office's day budget.
- **Approval** files each card into its own repo with `office_id`, `role_id` = the office's Director and, when the feature is tainted, `tainted_at`. So the cards are external and land `supervised`, and the office's claim share and budget apply to them.
- **Tainted cards are held.** The phase pump (`planFeatureProgress`, shared by both drivers' `resolveFeatureCompletion`) never queues a `draft` with `tainted_at` set (`isTaintedFeatureDraft`). The card stays a draft and still blocks its phase: `FEATURE_CLAIM_GATE` and `isFeatureTaskBlocking` are unchanged, so later phases wait. The feature's `error` reads `N tainted cards wait for you to queue them`; the pump rewrites only that reason of its own and clears it at zero. A human Enqueue / Add to queue queues the card normally and re-runs the pump, so the count follows.
- **`predictSchedule` needed no gate change**: it never simulates the pump and never predicts a draft to start. A tainted card's wait says so, and a later phase's wait names the first blocker waiting on a human. `server/src/office/features.test.ts` checks the SQL gate, `isFeatureTaskBlocking` and `predictSchedule` against each other for both cases.

### Open questions, as decided

1. *Cross-repo features* — a human's feature is still one repo, and work belonging elsewhere should be filed as a normal task in that repo. The exception, since 2026-11-05, is an **office feature** (§ Office features below): a Virtual Office Director files it, and each card names its own workspace repo.
2. *Auto-approve tier* — not built. Approval is the whole point of the interface.
3. *Analysis context budget* — the plan prompt explicitly instructs the agent to read `CLAUDE.md` and `docs/` first, and carries up to 60 of the repo's open tasks (excluding this feature's own) so it does not duplicate them.
4. *Where the request is written* — DB-only. No "export to docs/" action yet.

### Verification

- `npm run typecheck` + `npm run build` clean.
- Offline suite against a throwaway SQLite DB + the real routes on a scratch port: create/edit guards, `.strict()` rejection of machine-owned fields, duplicate card ids, approve (exclusions honoured, phase indexes, per-card effort/review carried over, caps present in every description), double-approve 409, plan frozen post-approval, phase gating (phase N+1 unclaimable until phase N resolves, auto-enqueue on completion), failure → paused, resume guard, pause blocks claiming, roll-up to review, complete, cancel (draft/queued cancelled, running killed through the orchestrator), agent-filed drafts not wedging a phase, repo deletion detaching features. All pass.
- Bounded re-analysis loop tested deterministically with a stub `claude` on PATH: blocker → re-analysis (findings folded into the prompt) → clean, two rounds recorded; `analysisMaxRounds: 0` stops after one round and still surfaces the blocker.
- Live pipeline run against a scratch repo: 93s, `claude-fable-5` plan + independent `claude-fable-5` plan review, verdict `minor` with one real finding, 2 phases → 2 tasks on approval, caps present in the generated descriptions.
- Browser: Features list, the proposed-plan board (editable cards, exclude, move, reorder, add), Save plan → Approve → Start, and the post-approval execution dashboard with the current phase highlighted and live task statuses. No console errors. Verified on a **separate scratch server instance**; the user's running server was never restarted.
