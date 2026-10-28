# Timeline

The timeline shows what every task did over a window: when it waited in the queue, ran, parked, sat in a review round or the checks, was fixed, idled in review and landed. Later phases add "now" and a predicted future. It reads the audit log (`tm_events`) and `tm_runs`; it writes nothing.

This document covers **phase 1 (data foundations)**: the shared segment builder and the range API. There is no SPA view yet.

## Segments

`shared/src/timeline.ts` is pure and shared. The server builds segments for the API with it, and the SPA will keep the same fold alive by appending `event.appended` rows, so both sides read one set of rules.

A `TimelineSegment` is one task in one state for a stretch of time:

| field | |
|---|---|
| `kind` | `queued` · `running` · `waiting` · `review-round` · `checks` · `fixing` · `idle-in-review` · `landed`, plus the zero-length end markers `failed` / `cancelled` (`start === end`) |
| `start` / `end` | ISO. `end: null` = the task is still in this state |
| `runId?` | the worker run of a running/fixing stretch, or the reviewer's aux run of a review round |
| `outcome?` | how it ended: the next status (running, queued, waiting, idle, landed), the review state of a round (`passed`, `fixing`, `flagged`, `error`, `skipped:unchanged-diff`), the checks verdict (`green`, `red`, `error`, `skipped:empty-diff`), or the reason on a failed/cancelled marker |
| `data` | `claim` (`base`/`custom-queue`/`overflow`), `actor`, `handoff`, `fix` + `round` on a fix turn, `verdict`/`findings`/`round` on a round, `checkState`/`checks` on a checks stage, `children`/`shells`/`ended` on a wait, `status` (`done`/`published`)/`landing`/`sha` on a landing, `landPhase`/`landingPhase`/`shippedSha` from the land events |
| `clippedStart?` / `clippedEnd?` | the segment crossed the window edge. `start`/`end` is then the edge, and a clipped end carries no `outcome` |

### Where each kind comes from

- **queued**: a `task.transition` to `queued`, or a `task.created` row with `status: 'queued'` (a task created straight into the queue has no transition row).
- **running**: a transition to `running`, with `data.claim` from the claim SQL. Each `run.started` attaches its run. A second run inside one running stretch (a loop iteration, a transient resume) splits it, one segment per run.
- **waiting**: a transition to `waiting`. The `task.waiting` park row adds `children`/`shells`. Its end row (`resumed`, `expired`, `stale`) becomes `data.ended`. When the wait ends back in `running`, the turn continues as the same kind (a fix turn stays `fixing`) with the same run.
- **checks / review-round / idle-in-review**: a transition to `review`. The Stop hook records `reviewState`/`checkState` on that row's audit data (`routes/internal.ts`, this phase). With `checkState: 'pending'` the stretch is `checks`; with `reviewState: 'pending'` it is `review-round`; otherwise it is `idle-in-review`.
  - `task.checked` closes a checks stage with its verdict. `run.reviewed` closes a round with its state. `task.review-requested` (Review now) opens a round from idle.
  - After each verdict the task is `idle-in-review`. A review round runs from the landing in `review` with a pending review to its `run.reviewed`.
- **fixing**: a review or check fix turn back in `running`. The orchestrator writes `task.follow-up` with `reason: 'adversarial-review' | 'checks'` just BEFORE the follow-up transitions the task to `running`. A transition to `running` within 5 minutes of that announcement is `fixing`, which keeps a refused resume from relabelling a later human turn.
- **landed**: a transition to `done` or `published`. `done → published` updates `data.status` on the same segment instead of opening a new one.
- **failed / cancelled**: zero-length markers. `draft` and `blocked` are not on the timeline: the task simply has no open segment.
- **deleted**: `DELETE /api/tasks/:id` writes no transition, only a `task.deleted` row (it refuses `running`, so a queued, waiting or in-review task can be deleted). That row closes the open segment with `outcome: 'deleted'`; there is no marker, since the task is gone.

**Provisional idle.** A `review` landing whose row says nothing about a pending stage opens a *provisional* idle-in-review. This covers rows from before this phase, a pause, a stall park and a loop's land. If a `task.checked` or `run.reviewed` follows in the same stint, the open stretch was the checks or the round, and it is relabelled in place. Only the OPEN segment is ever relabelled, so a live fold and a batch build agree. A non-skipped checks verdict whose stage did not stop also leaves the next idle provisional, because a review round may follow.

**Not modelled (yet).** A loop's between-iteration checks run while the task stays `running`. They are not carved out of the running stretch.

### API

- `buildTaskSegments(events, runs, { since, until, now })` returns `Record<taskId, TimelineSegment[]>`. It is exactly `foldEvent` over the events sorted by id, then `timelineSegments`. Runs only fill in a missing `runId`: a worker run of the task started inside a running/fixing stretch, or a `review` aux run (`subjectId` = the task) inside a round.
- `foldEvent(state, event)` appends one row. Rows are folded oldest first, and a row whose id is at or below the newest folded id is a duplicate and is ignored (event ids are time-sortable and keep insertion order within a millisecond). It is copy-on-write: only the touched task's track is replaced. `foldRun(state, run)` adds or replaces a run, and `initTimeline()` is the empty state.
- `timelineSegments(state, window)` materialises the segments with clipping. A segment that ended before `since` is dropped. One that began before it starts at `since`. One still open is `end: null` when `until ≥ now`, and ends at `until` otherwise.
- `stateAt(segmentsByTask, T)` returns `{ running, waiting, inReview, checking, queued, landed }` as task ids. A segment holds `[start, end)`. `running` includes fix turns. `inReview` covers a round or an idle review, while checks count as `checking`. Markers hold no time.

## Range API

`server/src/routes/timeline.ts`. Read-only, no `Origin` needed.

- **`GET /api/timeline?since&until&repoIds`** returns `TimelineResponse`: `{ events, runs, segments, since, until, truncated, coveredSince }`.
  - **Window.** The default is the last 24 h. ISO timestamps are required, `since < until`, and the window is at most `TIMELINE_MAX_DAYS` (31); anything else gets a 400.
  - **`repoIds`.** A comma list. Absent means every repo. Present but empty (`repoIds=`) means **nothing**, like `TaskFilter.repoIds` and the workspace scope.
  - **`events`.** The `TIMELINE_EVENT_KINDS` rows in the window, plus each task's **seed**: its newest `task.transition`/`task.created` before the window (the state it entered with) AND every timeline row of that task after it and before the window. The anchor alone is not enough: the Stop hook marks almost every review landing `reviewState`/`checkState: 'pending'`, so without the `task.checked`/`run.reviewed` that settled it before the window, a round or checks stage would be reopened from the window's start. They are sorted oldest first, so a client can fold them itself.
  - **`runs`.** Worker runs and `review`/`compact` aux runs that overlap the window (`started_at < until`, `ended_at` null or ≥ `since`).
  - **Tasks covered.** Those with a row in the window or a run overlapping it, PLUS every task whose newest `task.transition`/`task.created`/`task.deleted` before the window left it in an open state (`queued`, `running`, `waiting`, `review`; `taskAnchorsBefore`, scoped by that row's repo). Without the second set a task that sat in one state through the whole window (a review waiting days for the human, a long queue) had no row in it and dropped out of the segments and `stateAt`. A task that was `done`/`published`/`failed`/`cancelled`/`draft`/`blocked` at the window's start and untouched inside it is not listed: it has no open segment to show. Neither is a task DELETED before the window: `task.deleted` is an anchor kind for exactly that, or a task deleted from the queue or review would be open in every later window. `task.deleted` rows carry no repo, so the window's deletions are fetched again by task id (`deletionsIn`) and a repo-scoped window still sees them close their segment.
  - **Caps.** Events and runs are capped at `TIMELINE_ROW_CAP` (20 000) each. On a cut, `truncated: true` and the newest rows are kept. `coveredSince` (one ms after the oldest kept row) is then where the segments are complete from. Seeds and clipping start there, not at `since`.
- **`GET /api/tasks/:id/history`** returns `TaskHistoryResponse`: `{ events, runs, segments, truncated }`. It is the same builder over one task's whole life (its worker runs and the aux runs about it), for the future task panel History tab. An unknown task gets a 404.

### Storage

- **`EventFilter`** gains `kinds[]`, `taskIds[]`, `repoIds[]` (each EMPTY array matches nothing) and `until` (exclusive). **`RunFilter`** gains `until` (on `started_at`, exclusive), `activeSince` (`ended_at` NULL or ≥), `repoIds[]` and `limit`.
- Both drivers build their SQL from `storage/event-sql.ts` (`eventListSql`, `runListSql`), so the filters cannot drift. The SQL is dialect-neutral and uses only `?` placeholders.
- `taskSeedEvents(anchorKinds, kinds, taskIds, before)` is new on `Storage`: each task's newest `anchorKinds` row before `before` (`MAX(id)` grouped by task), joined back to that task's `kinds` rows after it and before `before` (one stint, so it stays small; served by `tm_events_task_idx`). The route chunks its ids by 500. A truncated `/history` seeds the same way.
- `taskAnchorsBefore(anchorKinds, before, repoIds?)` is new on `Storage`: EVERY task's newest `anchorKinds` row before `before`, filtered by that row's repo (`taskAnchorsSql`). The route keeps the ones that entered an open state. On the live DB (≈16k events, ≈870 tasks) it costs a few ms.
- `listEvents`' hard cap went from 2 000 to `EVENT_LIST_MAX` (50 000). Every existing caller passes its own limit. The one that asked for more, `reports/service.ts` (`TRANSITION_LIMIT` 20 000), was silently clipped to 2 000 before and now gets what it asks for.
- **Migration 50** adds `tm_events(repo_id, at)` and `tm_events(kind, at)`. A repo-scoped window now searches `tm_events_repo_at_idx`.

## Verification

- `server/src/timeline.test.ts` (`npm test`) covers:
  - A claimed → running → review(pending) → reviewed → idle → done sequence.
  - A waiting park and resume.
  - An old-shaped landing relabelled into checks, followed by a review fix round, a check fix round, then a failed marker.
  - The stale fix-announcement guard, the runId fallback, `done → published`, the cancelled marker and clipping.
  - `foldEvent` event by event equals the batch build, earlier states are not mutated, and duplicates are ignored.
  - `stateAt` mid-sequence and at a boundary.
  - The `EventFilter` additions, `taskSeedEvents` and the migration-50 indexes on a temp SQLite DB.
  - A review round and a checks stage that settled BEFORE `since` are not reopened, for the window and for a truncated history (review round 1).
  - `loadTimeline` (seed, clipping, repo scope, run overlap, truncation) and `loadTaskHistory`.
  - A task idle in review and a task queued through the whole window are listed and counted by `stateAt`; a published task, a draft and another repo's task are not.
  - A task deleted before the window (from review or the queue) is not listed; one deleted inside it closes at the deletion, scoped or not.
  - `parseTimelineQuery`.
- Against a `.backup` copy of the live DB, through an `app.inject` harness that registers only these routes:
  - 24 h / 7 d / 30.9 d windows answered in 57–549 ms, untruncated (≈4.7k events over 30 days).
  - 40 days and a non-ISO `since` returned 400, and `repoIds=` returned empty.
  - A repo-scoped window held only that repo's tasks, and an unknown task's history returned 404.
  - A real fix-round task rendered as review-round → idle → fixing → review-round with the reviewer runs attached, from rows written before the Stop hook recorded `reviewState`.
