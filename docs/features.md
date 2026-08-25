# Feature interface — big request → analysis → reviewed plan → approved tasks

Status: **implemented 2026-08-25** (design written the same day). This file is the original design analysis, kept verbatim below, plus an **[As built](#as-built-2026-08-25)** section at the end recording where the implementation went further than, or deliberately away from, the design. Companion doc: [`future/autonomy-cloud-shadow.md`](future/autonomy-cloud-shadow.md) — the request that motivated this: a single user ask ("dockerize + shadow DB + cloud autonomy") that is far too big for one task and needs phased decomposition.

## Motivation

Today the intake units are a single task (human-written) or an Analyze run over existing tasks. There is no home for a **big request**: a paragraph-to-page description of a large capability, which needs to be analyzed, decomposed into ordered tasks, sanity-checked, *approved by the human*, and then executed by the normal orchestrator machinery over hours or days. The docker/shadow/cloud analysis is the canonical example: ~4 phases, each several tasks, with strict ordering (containers before shadow enforcement before cloud).

The Feature interface is that home. Key property: **it composes almost entirely out of existing subsystems** — headless structured analysis (`analyze.ts`), adversarial review (`review.ts` pattern), proposal-accept transactions, parent/child task mechanics, the claim loop. What's genuinely new is one entity, one pipeline, and one page.

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
- **analyzing** — one headless run (`claude -p`, model `claude-fable-5` per role-model policy, write tools disallowed, `--json-schema`) with cwd = the repo, prompt = request + repo role + existing open tasks + instructions. Output: structured plan (schema below).
- **analysis-review** — a *second* independent headless run adversarially reviews the plan against the request and the repo (missing steps? wrong ordering? tasks too big/vague? contradicts CLAUDE.md/docs?). Verdict `clean | minor | blocker`. Blockers → fold findings into a re-analysis prompt and repeat, bounded by `feature.analysisMaxRounds` (default 2, mirrors `review.maxRounds`). This is the same shape as the existing work→review→work loop, applied to planning instead of diffs.
- **proposed** — the plan is shown visually (below). Nothing exists as real tasks yet.
- **approved** — user approves (possibly after editing); real `tm_tasks` rows are created transactionally (composite storage method, like `acceptProposal`).
- **running / paused / review / done** — execution + roll-up, below.

## Data model

New table + one column on tasks (migration N):

- `tm_features(id, repo_id, title, request TEXT, status, analysis TEXT /*JSON: latest plan*/, review TEXT /*JSON: findings/verdict per round*/, analysis_rounds INT, error, created_at, updated_at)`
- `tm_tasks` gains nullable `feature_id` and `feature_phase INT` (0-based phase index). Existing `priority`/`parent_id` untouched — a feature is **not** modeled as a parent task: parent/child means "split of one task" with all-children-resolve semantics; a feature needs phase ordering, a request document, and an approval gate, which don't fit that machinery. Tasks within a feature can still be split by workers as usual (their children inherit `feature_id`/`feature_phase`).
- Task `source`: new enum value `feature` (provenance chip in Board filters alongside human/agent/sentry/analyze).

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
- Actions: **Re-analyze** (with an optional user note appended to the prompt), **Approve** (creates tasks, feature → approved), **Cancel**.
- Post-approval the same page becomes the execution dashboard: cards show live task status (reusing `/ws/events` — cards are just tasks filtered by `feature_id`), with the current phase highlighted and per-card links into the existing TaskSlideOver/terminal.

All styling resolves to `--tm-*` tokens as usual.

## Execution semantics

Orchestrator stays untouched except **claim eligibility**: a task with `feature_id` is claimable only if its feature is `running` AND every task in lower phases of that feature is resolved (`done` or `cancelled`). Cheapest implementation: extend the `claimNextQueuedTask` WHERE clause (or pre-filter in `maybeSchedule`) — no new scheduler.

- **Start feature** (approved → running) enqueues phase 0's tasks; when a phase fully resolves, the server auto-enqueues the next phase (event-driven, on the same `resolveChildCompletion`-style hook path).
- **Per-task flow is 100% the existing one**: worker PTY, hooks, adversarial diff review, work→review→work rounds, human review→done. Nothing feature-specific inside a run.
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
| The two-headless-run pipeline | `server/src/claude/feature-analysis.ts` |
| REST + events | `server/src/routes/features.ts` |
| Phase pump | `Orchestrator.advanceFeature` / `resolveCompletion` |
| UI | `web/src/pages/{Features,Feature}.tsx`, `components/FeatureBadge.tsx`, `theme.css` |

### Deltas from the design above

1. **`analysis-review` is not a persisted status.** The plan review runs *inside* `analyzing`: one `tm_runs` row (mode `analyze`) spans the whole pipeline, and each `claude -p` child registers itself with `trackHeadlessChild` so the single Kill button always points at whatever is currently burning. The rounds are visible as `feature.review.rounds[]` instead of as a status. The feature leaves `analyzing` exactly once, for `proposed` or `failed`.
2. **Approve ≠ start.** Approval materialises the cards as **`draft`** tasks, not `queued`. Only `POST /features/:id/start` (approved → running) lets the phase pump move the current phase to `queued`. A plan can therefore be approved and reviewed on the Board before any agent touches the repo.
3. **Phase gating lives in one shared SQL fragment.** `FEATURE_CLAIM_GATE` is spliced into `claimNextQueuedTask` in *both* drivers, so SQLite and Postgres cannot drift. Its JS twin `isFeatureTaskBlocking` drives `resolveFeatureCompletion`; the two are documented as one policy and must be edited together (a mismatch between them wedges a phase — it is exactly the bug the test suite caught during the build).
4. **A worker-filed draft does not hold a phase open.** Children a worker files inside a feature inherit `feature_id`/`feature_phase` (as designed) — but an *unqueued* one (`status='draft'`, `source<>'feature'`) is a human-triage item, not phase work, and is exempt from the gate. Split children, which are queued, do block their phase as intended.
5. **The overflow claim is deliberately weaker.** `claimNextAgentChildTask` (the agent-API R1 credit that lets a live worker's child start at the concurrency cap) applies only a *cancelled-feature* gate. Applying the full phase gate there would deadlock a live session the moment a sibling failure paused the feature.
6. **Standing caps are injected as a marker-delimited block** (`<!-- tm:standing-caps -->`) at task-creation time, inside the approval transaction, by `buildFeatureTaskDescription`. Stripping-then-appending makes re-injection idempotent, so an edited card can never accumulate two copies. Both caps and the docs-update exit criterion are in the block; the plan prompt explicitly tells the analysis *not* to write them itself.
7. **Failure semantics.** Any `failed` task pauses a running feature (as designed). `POST /resume` refuses with a 409 while a failed task remains, rather than no-oping — resuming would re-pause instantly. `pause` does **not** kill running tasks; the claim gate simply stops handing out new ones.
8. **Deleting a repo nulls its features' `repo_id`**, exactly as it already does for tasks (the alternative, a NOT NULL FK, would make repo deletion fail). A repo-less feature refuses to analyze or approve with a clear 409.
9. **`feature.analysisMaxRounds`** (default 2) is a real settings key with a Config row, mirroring `review.maxRounds`. `0` means "review the plan once, never re-plan" — the blocker verdict is still surfaced rather than hidden, and the human decides.
10. **Agent API is read-only and narrow**: `GET /api/agent/features/:id` answers only for the feature the calling run's own task belongs to. Agents cannot create or mutate features in v1 (design open question 2).
11. **Known interaction**: a feature analysis creates an `analyze`-mode run for its repo, so the pre-existing "one analysis per repo at a time" guard on `POST /api/analyze` also refuses while a feature is analyzing. That serialization is intentional.

### Open questions, as decided

1. *Cross-repo features* — not modeled. A feature is one repo; work belonging elsewhere should be filed as a normal task in that repo.
2. *Auto-approve tier* — not built. Approval is the whole point of the interface.
3. *Analysis context budget* — the plan prompt explicitly instructs the agent to read `CLAUDE.md` and `docs/` first, and carries up to 60 of the repo's open tasks (excluding this feature's own) so it does not duplicate them.
4. *Where the request is written* — DB-only. No "export to docs/" action yet.

### Verification

- `npm run typecheck` + `npm run build` clean.
- Offline suite against a throwaway SQLite DB + the real routes on a scratch port: create/edit guards, `.strict()` rejection of machine-owned fields, duplicate card ids, approve (exclusions honoured, phase indexes, per-card effort/review carried over, caps present in every description), double-approve 409, plan frozen post-approval, phase gating (phase N+1 unclaimable until phase N resolves, auto-enqueue on completion), failure → paused, resume guard, pause blocks claiming, roll-up to review, complete, cancel (draft/queued cancelled, running killed through the orchestrator), agent-filed drafts not wedging a phase, repo deletion detaching features. All pass.
- Bounded re-analysis loop tested deterministically with a stub `claude` on PATH: blocker → re-analysis (findings folded into the prompt) → clean, two rounds recorded; `analysisMaxRounds: 0` stops after one round and still surfaces the blocker.
- Live pipeline run against a scratch repo: 93s, `claude-fable-5` plan + independent `claude-fable-5` plan review, verdict `minor` with one real finding, 2 phases → 2 tasks on approval, caps present in the generated descriptions.
- Browser: Features list, the proposed-plan board (editable cards, exclude, move, reorder, add), Save plan → Approve → Start, and the post-approval execution dashboard with the current phase highlighted and live task statuses. No console errors. Verified on a **separate scratch server instance**; the user's running server was never restarted.
