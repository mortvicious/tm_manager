# Timeline

`/timeline` shows every task of the current workspace in time order: the PAST rebuilt from the audit log, a moving NOW, and a PREDICTED future with an ETA and the reason each item waits. Predicted points of queued tasks can be dragged to reorder the real queues, and a cursor scrubs or plays back the past. Desktop draws horizontal per-repo tracks, the phone one vertical stream. It is a new view BESIDE the legacy Board, which is frozen (docs/decisions.md 2026-10-29). Everything but a drag is a read.

Files: `shared/src/timeline.ts` (the fold), `shared/src/schedule.ts` (the simulator and the duration baseline, docs/schedule.md), `shared/src/schedule-accuracy.ts` (the replay), `shared/src/queue-drop.ts` (drag → move), `server/src/routes/timeline.ts` + `routes/schedule.ts`, `web/src/timeline.ts` (`useTimeline`), `web/src/pages/Timeline.tsx` and `web/src/components/timeline/`.

## Data path

```
tm_events + tm_runs ──GET /api/timeline──▶ foldEvents (shared) ──▶ segments ──▶ tracks / stream
        │                                       ▲                       │
        └── /ws/events event.appended, run.* ───┘ foldEvent / foldRun   └─▶ stateAt(T) · segmentAt
tasks, repos, features, live runs, status, /api/schedule/baseline ──▶ predictSchedule (in the SPA) ──▶ ghosts
```

1. **Rows.** The past is the audit log (`TIMELINE_EVENT_KINDS`: `task.created`, `task.transition`, `run.started`, `task.follow-up`, `run.reviewed`, `task.checked`, `task.review-requested`, `task.waiting`, the land rows `task.land`/`task.landing`/`task.shipped`, `task.deleted`) plus `tm_runs` (worker, `review` and `compact` runs). Nothing new is written for the timeline except the Stop hook's `reviewState`/`checkState` on its landing's transition data (§ Where each kind comes from).
2. **One pure fold** (§ Segments). `buildTaskSegments` is exactly `foldEvent` over id-sorted rows, then `timelineSegments` clips to the window. The server runs it for `GET /api/tasks/:id/history`; `GET /api/timeline` (§ Range API) returns the raw rows plus a seed per task, and the SPA folds them.
3. **Live** (§ `useTimeline`). The hook subscribes to `/ws/events` before it fetches, folds every later `event.appended` / `run.*` through the SAME `foldEvent`/`foldRun`, and never refetches on an event — only on a new window, a workspace switch, `reload()` or a socket reconnect. NOW ticks every 30 s and on every folded row.
4. **`stateAt(segments, T)`** buckets every task at an instant (`running` — fixing included — `waiting`, `checking`, `inReview`, `queued`, `landed`). The live counts on NOW read it at `now`; the scrub cursor (§ Scrub and playback) reads it at T, with `segmentAt` per task for the segment that holds T.
5. **The future** is computed IN THE BROWSER (§ Prediction) from state the SPA already holds, so a drag re-predicts with no round trip. The server runs the same function only to grade it (§ Prediction accuracy).

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
- `foldEvents(events, runs)` is the fold state of a batch (one copy, in place). `buildTaskSegments` is `timelineSegments(foldEvents(…))`; the SPA seeds its live state with it.
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
- **`GET /api/tasks/:id/history`** returns `TaskHistoryResponse`: `{ events, runs, segments, dispatches, truncated }`. It is the same builder over one task's whole life (its worker runs and the aux runs about it), for the task panel's History tab (§ Task history). An unknown task gets a 404. The SPA reads it through `api.taskHistory(id)`.
  - **`events`** are the task's `HISTORY_EVENT_KINDS` rows: the fold's `TIMELINE_EVENT_KINDS` plus `HISTORY_EXTRA_EVENT_KINDS` (retry, undo, wake, paused, transient-retry, stop-failure, auto-compact, killed, the four question kinds, dispatch, publish, pr, worktree, queue, loop, budget, agent create/close, `schedule.overflow-claim`). `run.attention` is left out on purpose: it is raised and cleared on every permission prompt and would drown the strip.
  - **`segments` are unchanged.** The fold's rows are still fetched by themselves, capped, seeded and clipped exactly as before; the extra kinds are a second query over the same covered span (all time, or from `coveredSince` when the first cut), under the same cap, merged into `events`. `foldInto` returns before touching state for any kind outside `TIMELINE_EVENT_KINDS`, so the extra rows could not move a segment anyway, but the separate query also keeps the cap from cutting the fold's rows sooner. `truncated` is either cut. `/api/timeline` still fetches `TIMELINE_EVENT_KINDS` only.
  - **`dispatches`** are the task's `tm_dispatches` rows in BOTH directions (`listDispatches({ taskId })`, which already matches either side), oldest first. They are needed because every `task.dispatch` audit row (`created`, `delivered`/`failed`, `cancelled`) is filed under the RECEIVER, with the sender only in `data.fromTaskId`, so a dispatch the task SENT is not among its own rows.

### Storage

- **`EventFilter`** gains `kinds[]`, `taskIds[]`, `repoIds[]` (each EMPTY array matches nothing) and `until` (exclusive). **`RunFilter`** gains `until` (on `started_at`, exclusive), `activeSince` (`ended_at` NULL or ≥), `repoIds[]` and `limit`.
- Both drivers build their SQL from `storage/event-sql.ts` (`eventListSql`, `runListSql`), so the filters cannot drift. The SQL is dialect-neutral and uses only `?` placeholders.
- `taskSeedEvents(anchorKinds, kinds, taskIds, before)` is new on `Storage`: each task's newest `anchorKinds` row before `before` (`MAX(id)` grouped by task), joined back to that task's `kinds` rows after it and before `before` (one stint, so it stays small; served by `tm_events_task_idx`). The route chunks its ids by 500. A truncated `/history` seeds the same way.
- `taskAnchorsBefore(anchorKinds, before, repoIds?)` is new on `Storage`: EVERY task's newest `anchorKinds` row before `before`, filtered by that row's repo (`taskAnchorsSql`). The route keeps the ones that entered an open state. On the live DB (≈16k events, ≈870 tasks) it costs a few ms.
- `listEvents`' hard cap went from 2 000 to `EVENT_LIST_MAX` (50 000). Every existing caller passes its own limit. The one that asked for more, `reports/service.ts` (`TRANSITION_LIMIT` 20 000), was silently clipped to 2 000 before and now gets what it asks for.
- **Migration 50** adds `tm_events(repo_id, at)` and `tm_events(kind, at)`. A repo-scoped window now searches `tm_events_repo_at_idx`.

## Task history

`shared/src/task-history.ts`, pure: `buildTaskHistory({ task, events, runs, segments, dispatches?, now? })` turns a `/history` answer into `HistoryStep[]`, oldest first, for the task panel's History tab (and later the timeline). A step is `{ kind, at, end, durationMs, costUsd, tokens, actor, label, detail, runId?, tone }`.

- **Point steps** have `end === at` and `durationMs: 0`. **Open steps** have `end: null`, and their `durationMs` is measured to `now` when it is given, otherwise it is null.
- **Ties at one instant** put the cause first: created, then retry/undo/release, then queued, then claimed, then the rest in insertion order.
- **`tone`** is `neutral | info | good | warn | bad`.
- **`tokens`** is input + output + cache read + cache write of the run(s) behind the step.

**Durations come from segment boundaries** wherever a segment exists. A worker run's worked time is the SUM of its running/fixing stretches. It is never `startedAt..endedAt`, because the PTY stays attachable and idle long after the turn landed. A stretch with no `runId` (a prompt typed into a live session) belongs to the run whose PTY was live at its start. A waiting park in the middle of a run is its own step and is not worked time.

| step | read from |
|---|---|
| `created` | `task.created` (actor, source, status). Agent-filed: `task.createdByRun` / `agent.create`'s `runId` as the filing run, `spawnDepth` as depth, and `effectiveStatus`/`note`. |
| `queued` | `queued` segments. |
| `claimed` | `data.claim` on the queued → running transition: base / custom queue / overflow. `schedule.overflow-claim` is never written today (overflow is `claim: 'overflow'`), so such a row is a step only when no claim transition sits within 5 s of it. |
| `run` / `fix` | `tm_runs` worker rows. Handoff and model come from `run.started`. Duration comes from the run's turn segments, cost and tokens from `stats`. Also: exit code, and `killed` (with `run.killed`'s reason) — only for a CUT turn: a `run.killed` row (cancel, undo, kill, stall, pause) or a turn segment still open at `endedAt`. `status: 'killed'` alone is not one, because `followUp` and the landing retire every idle terminal that way. The label is `publish turn` (`label = 'publish'`) or `loop iteration n`. A run is a `fix` when it holds a `fixing` segment or starts within 5 min of a `task.follow-up` with a `reason` (round, red check names). An announcement with no run is a point `fix turn requested`. |
| `compact` | `compact` aux runs (the resume gate), with cost. |
| `waiting` | `waiting` segments (subagents/shells, how the park ended). |
| `review` | `run.reviewed`: verdict, state, findings count, model, fix round, Review now. Skips are `unchanged-diff` / `empty-diff` / `checks-red`. The span is the `review-round` segment closed by the row. Cost is the sum of the `review` aux runs started since the previous round (a Fable→Opus fallback is two runs); `runId` is the last of them. |
| `checks` | `task.checked`: state, round, results (`name outcome`), stop. The span is the `checks` segment the row closed, or the results' own `durationMs` sum for a loop's in-run checks. |
| `wake`, `transient`, `stop-failure`, `auto-compact` | `task.wake` (by `action`), `run.transient-retry`, `run.stop-failure`, `run.auto-compact`. |
| `question` | `question.asked` → `answered` / `expired` (by `questionId`). `answered` with `policy: 'autopilot'` is *auto-picked*. A `question.autopilot` skip adds its reason. The text is the first question, clipped to 120 chars, and the wait time is the span. **`data.answers` is never read**: an answer may be a redacted secret. |
| `dispatch` | `dispatches`: sent (`→ to8`, `runId` = the sending run) or received (`← from8`), then intent and status, spanning `createdAt..deliveredAt`. Without the list, the receiver's own `task.dispatch` rows give the received ones. The message is not shown. |
| `queue`, `loop`, `budget`, `closed`, `worktree`, `pr`, `landing`, `land`, `publish`, `shipped` | `task.queue` (add/remove; reorders skipped), `task.loop` (not `started`, which the run says), `task.budget`, `agent.close`, `task.worktree`, `task.pr`, `task.landing`, `task.land`, `task.publish`, `task.shipped`, each labelled by its `action`/`phase`. |
| `landed` | Transitions to done/published. *auto-landed* when the row carries `landing` and the actor is `orchestrator`. |
| `retry`, `undo`, `release`, `paused`, `resumed`, `failed`, `cancelled` | `task.retry` (the error it cleared), `task.undo` (`undo` / `release`), a transition with reason `pause all`, `task.paused` (`resumed`), and failed/cancelled transitions. A failure's error is not on its transition: it comes from the next `task.retry`'s `previousError`, else from the task row when that is the current failure. |

`historyTotals(steps, runs, now?)` returns four totals:

- **`wallMs`**: the first step to the last end, or to `now` while a step is open.
- **`workedMs`**: the sum of the `run`/`fix` steps.
- **`costUsd`**: every run passed in (worker, reviewer, compaction — `Task.costUsd`'s set).
- **`attempts`**: worker runs with `resumedFrom` null, i.e. fresh sessions, as `Task.attempts` counts them.

## SPA

`/timeline` (`web/src/pages/Timeline.tsx`, nav entry **Timeline** in the desktop sidebar and the phone More sheet, carried through `wsHref` so `?ws=` survives) shows the current workspace's past, NOW and predicted future. The page picks a live window (6 h · 24 h · 3 d · 7 d back from now) and the shape: `useIsMobile()` → `components/timeline/TimelineStream.tsx` (the phone stream, § Phone stream), else `components/timeline/TimelineTracks.tsx` (horizontal per-repo tracks, § Tracks, then the not-scheduled list). Both read only `useTimeline`; words and colours for both are in `components/timeline/format.ts`.

### Tracks (desktop)

`TimelineTracks.tsx` draws one horizontal track per workspace repo (every repo in `useWorkspace().repoIds`, All = every repo, in the app's order; a busy-but-unlisted repo or repo-less work gets a row of its own), time left → right. Geometry is computed in TIME by the pure `components/timeline/layout.ts` (`buildTrackLayout`); the component maps it to px and draws only what intersects the visible window ± half a viewport, so a long window at a close zoom renders a few dozen nodes (7 d of the live DB: ≈ 60 at Hour, ≈ 120 at Day, ≈ 650 at Week, a scroll frame ≈ 3 ms).

- **Bars.** A task's segments are cut into bars: a maximal run of ACTIVE segments (`running`, `waiting`, `review-round`, `checks`, `fixing`) — a worker turn and the verify round it parks into. The bar's fill and border say how it ENDED (`OUTCOME_COLOR`: still open → running, a `landed` marker → done/published, `failed`/`cancelled` markers, an idle tail → in review, else the next status the last stretch moved to); the non-`running` segments inside are striped sub-segments in their own colour (`SEGMENT_COLOR`; checks and fixing use the timeline tokens `--tm-tl-checks` / `--tm-tl-fixing`). An `idle-in-review` stretch after a bar is its TAIL, drawn as a thin line UNDER whatever runs next (a settled review does not hold the repo — docs/queue.md — so the next task really does run over it). `landed` is a diamond marker, `failed`/`cancelled` round ones. `queued` stretches are not drawn: a queued task shows as its ghost. A bar clipped by the window's start has a dashed left edge; a live one a dashed right edge.
- **Sub-lanes.** `assignLanes(items, minLanes)` in `web/src/timeline.ts` — greedy by start over half-open intervals, each item into the lowest lane free at its start — over the bars' ACTIVE intervals (tails excluded, for the reason above) and the ghosts. `minLanes` is `repoParallelCap(repo)`, so a pr repo with `parallel` 2–3 always shows that many lanes; it is a floor, not a ceiling: an overlap the data really holds (e.g. a review round of one task while two others run) gets one more lane instead of being drawn over. The row label says `n parallel` for the cap. A live bar and the `running` ghost that continues it are one interval on one lane.
- **NOW** is a line across every track plus a pill on the axis at `tl.now`, so it moves on the hook's 30 s tick and on every folded event. A fixed (past) window labels it `end`. The pill is also the time cursor's handle (§ Scrub and playback).
- **Ghosts.** Every scheduled `PredictedSlot` is a dashed bar from its start to the end of its last `after` stretch (checks/review/publish tinted inside it); a `running` slot starts at NOW and continues the live bar in the teal outline. The label leads with the ETA (`ends ~14:43`, or `~14:05 → 14:43`) and the reason it waited (the last `waits` entry), then the title — left out on a continuation, whose title is on the live bar beside it. Unscheduled slots have no time: they stay in the **Not scheduled** list under the tracks.
- **Zoom** is the time one viewport shows: **Hour** (3 h), **Day** (24 h), **Week** (7 d) buttons, and ctrl/⌘-wheel (a trackpad pinch is a ctrl-wheel) continuously between 30 min and 14 d, anchored at the pointer (a native non-passive listener — React's is passive and cannot `preventDefault`). A preset keeps NOW where it is when NOW is on screen. **Pan**: drag on empty track area (pointer capture; touch scrolls natively) or horizontal scroll; **Now** scrolls back. On first render — and whenever the window's `since` changes — NOW is placed at 70 % of the viewport so the predicted future has the rest. The canvas always fills the viewport and runs a little past the last thing drawn.
- **Hover card** (`position: fixed`, flipped at the viewport edges): the task's title, its segment kind, current status and repo; for a bar the segment under the pointer (`segmentAt`) with its times, the turn's span, the task's worked time (`running + waiting + fixing` in the window, "in this window" when clipped), how it ended and the reason/error the fold kept; for a ghost its source, ETA, the work → checks → review → publish chain, the worker lane and every `waits` entry. **Click** on a bar, tail, marker or ghost → `onOpenTask` (the app's `?task=` panel); a task that no longer exists is not clickable. Bars and ghosts are focusable buttons (`aria-label` with title, outcome and times); Enter/Space opens the task.
- **Tokens.** `--tm-tl-lane-h`, `--tm-tl-label-w`, `--tm-tl-axis-h`, `--tm-tl-card-w` (layout, in `:root`) and `--tm-tl-checks`, `--tm-tl-fixing` (per theme) are new in `theme.css` and `docs/tm-design-tokens.html`; everything else is an existing `--tm-*` token, lane offsets are `calc()`s over them (`--lane`/`--lanes` custom properties set inline). Styles are `.tlt-*` in `theme.css`. **Glass** (`glass.css`, scoped to `[data-design='glass']`): the tracks card is a `.panel` and gets the card material for free; the sticky repo column is frosted (`--tm-glass-bar` + blur) so the bars scroll under it, bar and stripe fills mix with `transparent` instead of Classic's raised grey, and the hover card is the popover material. Nothing touches `.main`/`.header`/`.app`.

### Phone stream

`TimelineStream` is the phone's shape: ONE vertical stream of compact task rows, so a thumb scrolls time instead of panning a chart.

- **Order.** Past above, oldest → newest (the newest 60 segments, one row per segment: kind dot, label, `segmentWhen`, outcome; a still-open stretch reads in full text colour). Then the **NOW divider**, then **Predicted** (scheduled slots by start: source, start clock + `in 12m` + the total `~38m` through checks/review/publish; a `running` slot reads `ends 14:43 (in 12m)`), then **Not scheduled**, at most 50 future rows with a `+n more` count. Predicted rows carry their reason — the LAST `waits` entry (`waited: …` on a scheduled one) — as a button under the meta line.
- **NOW** is `position: sticky` with BOTH `top: 0` and `bottom: 0` — sticky insets count from inside `.main`'s padding, which already clears the floating header and the tab bar (`--tm-tabbar-clear`) — so it sticks to whichever edge the past or the future scrolled it off and never leaves the screen; tapping it scrolls back to NOW. It names the clock and `stateAt`'s live counts (`2 running · 1 in review · 3 queued`), or `window ended …` for a fixed window. In Glass it wears the bar material.
- **Opens at NOW.** Once per mount, after the first answer, a zero-height in-flow anchor just above the divider is scrolled to the middle of the screen (`scrollIntoView({ block: 'center' })`). The anchor, not the divider: a stuck sticky box reports where it is stuck, so scrolling it "into view" would do nothing.
- **Repo rails.** Each row's left edge is its repo's rail, in the group palette (`--tm-group-1..7`, by the repo's place in the repo list, so a repo keeps its hue across pages and reloads); consecutive rows join into one stripe. A legend above the stream names the hues of the repos it shows (`×n` on a parallel repo). A **parallel repo** (`repoParallelCap` > 1, docs/parallel.md) draws one thin stripe per lane with the row's own lane lit (the others at 28% of the hue). Lanes are a display reading, assigned in one start-ordered pass over the repo's past stretches that hold a slot (running, waiting, fixing, checks, review round) and its scheduled slots together: a task keeps its lane while its stretches touch (so a running segment and its predicted remainder share it), else the lowest free lane. They are NOT the simulator's `lane`, which is the global worker lane.
- **Tap / explain.** Tapping a row opens the task (`onOpenTask`, the task panel); a row of a deleted task explains instead. A **long press** (480 ms, cancelled by a 10 px move, the following click swallowed; the context menu also explains) or a tap on the **reason** opens a `<Sheet>` (docs/mobile.md § Tap to explain): a past row says what that kind of stretch is, when and how it ended; a predicted row gives the ETA line, work → checks → review → publish with their starts and lengths, where it lands, EVERY wait oldest first (the one it still waits for highlighted), and where the lengths came from (this repo's medians over n tasks, the all-repo line, or the defaults). The content is plain blocks in the Sheet's body — the library's scroller is the only scroller, so drag-from-the-top keeps working — with **Open the task** as its action.
- **Touch.** Rows are at least `--tm-tap` tall, the reason button `--tm-tap-dense`; rows are not text-selectable and carry no callout, so a long press is never a selection. The bottom clears the tab bar through `.main`'s own `--tm-tabbar-clear` padding, which the divider's sticky `bottom: 0` sits on.
- **Designs.** Classic is `theme.css` tokens only; Glass adds `[data-design='glass']` rules in `glass.css` (divider material and press, hairline rows with the board's press highlight, pill-shaped rails).

### Scrub and playback

A time cursor over the past, on both shapes (`components/timeline/scrub.tsx`, `useScrub(tl)`; phase 5 of the timeline feature).

- **State.** `at === null` is LIVE (the cursor is NOW). A **drag** is a look: it scrubs while the pointer is down and returns to live on release. A **playback session** — Play, Pause, or a keyboard step — PINS the cursor: it stays where it was left until **Now** is pressed or playback reaches NOW. The cursor is clamped to [NOW − `TIMELINE_MAX_DAYS`, NOW].
- **Reading.** The shared `stateAt(tl.segments, T)` — the same buckets as the live counts — plus `segmentAt` per task for the segment that holds T. The chip (`chipText`) reads `14:20 — 2 running, 1 checking, 1 in review, 5 landed` (empty buckets left out, `nothing live` when all are; queued is not a "where it was" set and is not counted). The held-segment set keeps its identity while it is the same set, so memoised tracks do not re-render on every frame.
- **Desktop** (`TimelineTracks`). Drag the NOW pill, or press anywhere on the axis's time area (touch too: the axis is `touch-action: none`; empty track still pans). While scrubbing, a second line marks T, the NOW line and pill stay drawn but quieter, the bar holding each task's segment at T (an active part, its idle tail, or its landed marker) is outlined, everything else — the rest of the past and every ghost — recedes, and the chip replaces the live counts in the toolbar. A drag pushed past the view's left edge steps the cursor back 2 % of a viewport per move and pans the view under it; at the canvas's start it goes before the window and the hook extends it. The handle is a focusable `role="slider"`: ←/→ step 5 min (Shift ×10) and pin, and a step that leaves the viewport brings the view along (cursor at 20 %), as playback does; Escape/End return to live. **Play** starts at the viewport's left edge (never before the window) and the view follows the cursor once it passes 80 % of the viewport; ×1/×10/×60/×600 is a segmented control.
- **Phone** (`TimelineStream`). A bar stuck to the bottom of `.main`'s padding (above the tab bar; the NOW divider's sticky `bottom` is the bar's measured height, `--tl-scrub-h`, so the two never overlap): Play/Pause, a range slider, a speed button cycling ×1 → ×10 → ×60 → ×600, and **Now**. The slider runs from one window's length (at least 6 h) BEFORE the loaded start to NOW, the part not loaded yet hatched; its range is frozen while a finger is on it, so an extension under the drag does not change what the thumb means. Release anywhere (a `window` `pointerup`/`pointercancel` — off the slider the input gets none) returns to live; the slider's own `change` at release is ignored, only a KEY step pins. While scrubbing, the bar lists the sets at T (running · waiting · checking · in review · landed, three titles each + `+n`, a tap opens the task) above the chip, and the past list shows the newest 60 rows UP TO T, the ones holding T lit and the rest dimmed. **Play** starts at the later of the window's start and 24 h back.
- **Playback** is a `requestAnimationFrame` loop: each frame advances the cursor by the real elapsed time × speed and stops at NOW, which returns to live. Paused while a drag is in progress.
- **Designs.** Tokens only (`.tl-scrub*`, `.tlt-cursor*` in `theme.css`; the cursor is `--tm-text`, distinct from NOW's accent). Glass (`glass.css`): the phone bar wears the bar material like the NOW divider, the chip the glass button fill, a lit row the press fill. The slider thumb is the Glass `--tm-knob`, falling back to the raised surface in Classic.

### `useTimeline({ since, until? })`

`web/src/timeline.ts` is the seam every timeline view reads.

- **Fetch.** `GET /api/timeline?since&until&repoIds` for the window and the current workspace (`useWorkspace().repoIds`, sorted; All = no `repoIds`). `until` omitted/null = a LIVE window: fetched up to the moment of the fetch, then it ends at NOW and moves with it. The answer's `events`/`runs` seed the fold with `foldEvents`; the window shown starts at `coveredSince`. Refetched on a new window, a workspace switch, `reload()`, and a socket RECONNECT (rows sent while it was down are lost) — never on an event.
- **Live, no refetch.** `state.tsx` keeps a module-level listener registry: `onServerEvent(fn)` gets every `/ws/events` message after the store applied it (one socket, so module-level). The hook folds `event.appended` rows of `TIMELINE_EVENT_KINDS` through the shared `foldEvent`, and `run.started|updated|exited` of the runs the route carries (worker, `review`, `compact`) through `foldRun`. The 200-row `auditEvents` slice is not widened. Scope: a row's `repoId` must be in the workspace; `task.deleted` carries no repo and is folded when its task is already on the timeline. The listener subscribes BEFORE the fetch and buffers what arrives while it is in flight; the buffer is folded after the answer, and `foldEvent`'s id check drops the rows the answer already had. A fixed (past) window ignores live rows. `task.updated` needs no fold: it moves the app's task rows, which the prediction reads.
- **NOW.** `now` ticks every `TIMELINE_TICK_MS` (30 s) and jumps on every folded row, so a just-opened segment is never clipped as "after the window".
- **`ensureCovered(t)`** extends the past backwards for a scrub cursor left of `since`: it fetches ONLY the older gap `[t − max(3 h, the window's length), since]` once, merges it by id into every row folded so far (the hook keeps the window's events and runs, live rows included, in a map — an older row cannot be appended to an oldest-first fold) and refolds with `foldEvents`; `since` moves to the gap's `coveredSince`, `origin` stays the asked `since` (views key their first placement on it; the tracks keep the same time in view when `since` moves). Cheap to call every frame: a covered `t`, or one the fetch in flight covers, is a no-op; a further one waits for it and then fetches the rest. Refused on a truncated window (an older gap would leave a hole) and before the first answer; bounded by `TIMELINE_MAX_DAYS` back from now. A new window, a workspace switch, a reload or a reconnect drops the extension. `extending` is true while the fetch is in flight. Measured in the browser: one drag from NOW to a day before the window → one `/api/timeline` request.
- **Duration baseline.** `GET /api/schedule/baseline` once per hour per page load, in memory (`useScheduleBaseline`, the same shape as `useProgressBaseline`); a failure retries in a minute and the simulator uses its defaults meanwhile.
- **Prediction.** `predictSchedule()` (`shared/src/schedule.ts`, docs/schedule.md) in a `useMemo` over the app state — tasks (with optimistic patches), repos, features, the live runs, the commands' check names per repo (`repoChecks`), `createdByRun` → task ids from the runs list, `taskProgress` per running/waiting task through `computeProgress` (the board row's reading, the per-task floor included), the duration baseline, push-failing repos (`OrchestratorStatus.pushHealth`, `!ok` with kind `auth`/`protected` — the kinds that hold a repo), and settings — the LIVE `OrchestratorStatus` `enabled`/`paused`/`concurrency` outrank the `/api/config` snapshot, which is read once per refresh. The day budget fuse is not on the status, so `dayBudgetReached` is left unset. Recomputed on any of those changing and on the 30 s tick. It runs over the WHOLE board — the claim order, the worker cap and the repo holds are global — and only the OUTPUT is cut to the workspace (a slot's `repoId` in scope, repo-less always), sorted by start, unscheduled last.
- **`applyOptimistic(patch)`** (`{ tasks: { [id]: { sortOrder?, priority?, customQueueAt?, queueHeldAt?, status? } } }`) is the drag seam ([Drag the future](#drag-the-future)): the patch is laid over the task rows the prediction reads, so the future re-predicts before the server answers. Each entry remembers the row it was applied over — its `updatedAt` plus the fields the patch sets — and is dropped by itself once the server's row moves past it (the confirmed move arrives as `task.updated`; a reorder does not bump `updatedAt`, which is why the patched fields count too); the returned function removes the patch (a refused move), `clearOptimistic()` all of them. `tasks` on the result is the patched list.
- **`preview(patch)`** runs the same prediction with a patch laid over `tasks` without applying it — what a drop WOULD predict (the drag ghost's ETA). Whole board, unsorted, not cut to the workspace.

### Drag the future

Predicted points of QUEUED tasks drag to reorder the real queues (`components/timeline/TimelineDrag.tsx`; the decision is the pure `planQueueDrop` in `shared/src/queue-drop.ts`, tested in `server/src/queue-drop.test.ts`).

- **What drags.** A scheduled slot whose task is `queued` and whose source is not `running` (`slotDraggable`): custom-queue, global and overflow slots. Running remainders, the past, unscheduled rows (held, draft, blocked…) and slots of tasks in review (`resume`, `wake`) have no grip and take no drop. Targets are the same set, hit-tested by `[data-tl-drop=<taskId>]`.
- **The gesture** is the board's (`TaskDrag.tsx`, whose constants and `scrollParent` it imports): pointer events on a grip only, never HTML5 DnD; a mouse arms after 4 px, a touch after a 350 ms hold (a flick before that is the browser's scroll; `touch-action: manipulation` on coarse pointers, a native non-passive `touchmove` on the grip once armed); Escape cancels; auto-scroll at the edge of the tracks' scroller (horizontal) or the page (vertical). Every grip handler stops propagation, so the tracks' pan and hover card, the stream's long-press explain and both views' click-to-open never see a drag. Tracks: a grip at the ghost's left, a draggable ghost at least 18 px wide; the earlier/later HALF of the target ghost is before/after. Stream: a grip after the rail; the top/bottom half of the row.
- **Mapping** (`planQueueDrop(tasks, moving, target, side)`):
  - both in the custom queue → `POST /api/tasks/:id/queue-move` `{ place: side, targetId }`, any repo, any priority (that order is the mark alone);
  - both in the global queue, same parent (roots included) → `POST /api/tasks/:id/move` `before|after` the target;
  - global, different groups → the dragged task's group ROOT moves `before|after` the target's root — roots are siblings, so nothing regroups, and the claim order reads the root's key right after priority (`compareClaimOrder`);
  - refused, nothing sent: one in each queue (`separate orders; Add/Remove from queue moves it over`), different priorities in the global queue (`claim order is priority first … change the priority instead` — no key change can cross it), and one group under different parents (`before/after` would re-parent).
- **The ghost** follows the pointer (kept on screen) with the hint — or the refusal, in the failed colour — and the ETA the drop would give: `starts 08:51 (in 1h 41m) · was 09:19`, from `preview()` once per target, not per pixel. The target draws its side as an accent edge (left/right on the tracks, top/bottom in the stream), a refusal as a red outline. Letting go over a refusal toasts it too — on a phone the finger covered the ghost.
- **Optimistic, then reconciled.** On drop the plan's patch goes through `applyOptimistic` (a `sortOrder` midpoint beside the target among its siblings; for the custom queue a mark midpoint, or the waiting set renumbered across its span — the shape of `planQueueReorder`), so the prediction re-renders at once. A patch is dropped when the server's row moves past it — `updatedAt` OR a patched field differs, because a reorder writes `sort_order`/`custom_queue_at` and leaves `updated_at` alone — i.e. on the confirming `task.updated`; after a success the caller also clears it after 4 s (a no-op answer, or rows the client renumbered and the server did not). A refusal (a 409 from either route) removes it at once and toasts the server's reason.

- **The custom-queue rule** (docs/queue.md § Reordering). The custom queue's order IS `custom_queue_at`, its FIFO mark, so a reorder rewrites that column and nothing else: the moved member gets the millisecond midpoint between its new neighbours (one row), and only when they are tied or < 2 ms apart is the waiting set renumbered evenly inside its CURRENT [min, max] span — never later than max, where the next Add to queue click must still land behind. `CUSTOM_QUEUE_HEAD_ORDER` and its twin `customQueueWaiting` already sort on the column, so no claim SQL changed. Running, review and blocked members keep their marks; `updated_at` is not bumped.
- **Why refusals, not silent fixes.** A drop the server's claim order cannot express is refused before anything is sent, with the reason, rather than mapped to a nearby move that would change something else: crossing a priority would need a priority edit (hidden power from a drag), crossing queues is Add/Remove from queue, and a sibling move between different parents would regroup the task. Past and running points never drag, and unscheduled rows (draft, held, blocked parents) have no slot to drag.

## Prediction

`predictSchedule(input)` (`shared/src/schedule.ts`; full reference docs/schedule.md § Simulator) runs in a `useMemo` in `useTimeline` over the WHOLE board, and only its output is cut to the workspace. It is pure and runs client-side on purpose (docs/decisions.md 2026-10-29): the SPA already holds every input, a drag re-predicts on the next frame through `preview()`/`applyOptimistic`, and no server endpoint or cache can go stale. The server imports the same function only for the accuracy replay.

### What it mirrors

It replays `Orchestrator.maybeSchedule` over virtual time — at each instant something changes (a predicted work segment ends, a round settles, a wake falls due) it runs one claim pass in the server's order, starts what that pass would start, and re-runs the pass at the same instant (up to 4 times), as each settled turn calls `maybeSchedule` again:

1. **Pause all** (`orchestrator.paused`): nothing starts, no verify round settles, every candidate waits `paused`.
2. **Paused-turn markers** (`paused_turn` `resume|publish|land`) resume first, oldest first, within `orchestrator.concurrency`.
3. **Custom queue**, independent of the queue switch: `customQueueWaiting` FIFO, `queue_held_at` skipped, push-failing repos skipped, `FEATURE_CLAIM_GATE`, `CUSTOM_QUEUE_HEAD_WHERE` (one head per repo, `customQueueHoldsRepo`, the agent-filed member's FILER hold) and the pump's `repoBusy`.
4. **Loops** in `loop_state = 'next'`, within the cap.
5. **Global claim** (queue switch on, day fuse not tripped): `compareClaimOrder` (priority, then `MANUAL_CLAIM_ORDER`: the group root's `sort_order`, root first, own key), `FEATURE_CLAIM_GATE` (`isFeatureTaskBlocking`), `REPO_EXCLUSIVE_GATE` (`holdsRepoForClaim` + `repoHasRoom`/`repoParallelCap`, so a `pr` repo admits up to `parallel` worktree holders and never one beside a checkout holder).
6. **Overflow**: one child per live, non-idle creating run, past the cap (`FEATURE_OVERFLOW_GATE`).
7. **Wake sweep** (`agent.autoWake`): `review`/`failed` rows with `wake_at` resume at `wake_at` + 90 s, earliest first, within the cap, ignoring the repo gate as `wakeDue` does.

After each predicted work segment the row is moved the way the Stop hook moves it: `review` with checks due (`verifyOpen`) when the repo has checks the task selects, then a review round when `task.review ?? review.enabled`, each holding the repo but no worker lane; then `effectiveLanding` decides: `supervised` stays in `review`, `on-green` → `done` (a worktree task stays in `review`, PR ready), `auto-publish` → a 3-min publish turn → `published`. So a predicted landing frees a repo or opens a feature phase exactly where the real row write would.

### Twins to edit together

The simulator is a JS twin of the claim SQL. Each SQL fragment and shared twin carries a `JS twin: predictSchedule` comment (`planQueueReorder` a `JS twin: planQueueDrop` one); editing one without the others makes the prediction lie silently (the accuracy replay is how you would notice):

| SQL / server | JS twin the simulator calls |
| --- | --- |
| `queue-sql.ts` `REPO_EXCLUSIVE_GATE`, `repoHasRoom`, `repoCapSql`, `heldBy` | `holdsRepoForClaim`, `repoHasRoom`, `repoParallelCap`, `customQueueHoldsRepo`, `verifyOpen` (shared) |
| `queue-sql.ts` `CUSTOM_QUEUE_HEAD_WHERE`, `CUSTOM_QUEUE_HEAD_ORDER` | `customQueueWaiting`, the filer hold inside `predictSchedule` |
| `feature-sql.ts` `FEATURE_CLAIM_GATE`, `FEATURE_OVERFLOW_GATE` | `isFeatureTaskBlocking` (moved to shared; `feature-sql.ts` re-exports it) |
| `group.ts` `MANUAL_CLAIM_ORDER` | `compareClaimOrder` |
| `Orchestrator.maybeSchedule` pass order, `wakeDue` | the pass above, `SCHEDULE_WAKE_DELAY_MS` |
| `queue-sql.ts` `planQueueReorder` (the reorder endpoint) | `planQueueDrop`'s custom-queue patch (`shared/src/queue-drop.ts`) |

### Durations

Every length is WORKED time, never wall time — a session that sat idle in review for hours is not "long". The baseline is `GET /api/schedule/baseline` (`durationBaseline`, docs/schedule.md § Baseline; cached 1 h server-side, fetched hourly by the SPA): per repo with ≥ 10 landed tasks in 90 days, else all repos, else `SCHEDULE_DEFAULT_LINE` (work 20 min / p75 35, review 8, checks 4).

- **Worked time** of a task = the sum over its worker runs of `runWorkedMs`: start → the run's first `run.stats-final` (its first idle), else its exit — the Dashboard's own rule.
- **A fresh work segment** (claim, resume, wake, loop iteration) is the repo's `workMs.median`.
- **Review and check rounds** are the medians of landed tasks' review aux runs (`startedAt → endedAt`) and of `task.checked` stages (sum of the serial checks' `durationMs`).
- **A live turn's remaining time** comes from the board's progress % (`taskProgress`, docs/task-progress.md), rescaled to its WORK band (`pct / 70 × 100` — the bar's 70–100 are checks, review and landing, which the simulator adds as their own segments): `elapsed × (100/pct − 1)`, clamped to [1 min, `workMs.p75`]. With no usable % (none, 0, or past the work band — a fix turn) it is `median − elapsed`, at least 1 min. A publish run is 3 min − elapsed.

### How prediction can be wrong, and why

The simulator predicts what the server will do if NOTHING new happens: no human click, no new task, no surprise verdict. It is faithful to the claim rules (the replay below), and its errors come from the world, not the rules:

- **Human clicks.** Run now, Proceed, Retry, Undo start, Cancel, a follow-up typed into a live session and a manual Publish all start or end turns the moment they are pressed. Run now in particular takes a worker lane outside the claim order, pushing every later ghost back by one turn.
- **Priority and order edits.** Claim order is priority first. A priority edit or a board move re-predicts at once, but a FUTURE edit cannot be foreseen. The accuracy replay uses each task's CURRENT priority and sort order (it has no history of them), so it measures rule fidelity, not this drift.
- **Review fix rounds.** A clean verdict is assumed. A flagged round sends findings back into the same session (`review.maxRounds`, default 1): one more work turn plus one more review round, all holding the repo.
- **Check reds.** Green is assumed. A red check resumes the session with a fix turn, up to `checks.maxRounds` (3) times, each followed by another check stage — the worst case is several times the predicted verify round.
- **Dispatch turns taking slots.** A `needs_action` dispatch resumes its target's session and counts in `activeWorkers()` like any turn, so it takes a lane the simulator gave to the next claim. Dispatches are not modelled at all.
- **Agent-filed tasks that do not exist yet.** About 70 % of tasks are agent-filed (828 tasks, 2026-10-28), and none of them exists before its filer runs. A filed overflow child or custom-queue member can start ahead of ghosts already on the timeline.
- **Budget fuses.** `budget.dayUsd` is not on `OrchestratorStatus`, so the SPA leaves `dayBudgetReached` unset and keeps predicting global claims after the fuse trips. `budget.taskUsd` refusing an automatic turn (a fix turn, auto-publish) is not foreseen either.
- **The CLI's own wake timing.** A usage-limit wake is predicted at `wake_at` + 90 s. In reality the CLI auto-continues at the reset + 30–90 s, the server takes over 3 min later if nothing moved, a weekly limit hands the task to the human after 3 wakes, and `resolveWakeAt` may pick the later of two reset times — any of these moves the ETA by minutes to days.
- **Progress % on long tasks.** The remaining time is clamped to the repo's p75, so a task that runs long keeps reading "ends in a few minutes" and its ETA slides forward on every tick. A todo list the agent extends mid-turn makes the % go flat; the output-token reading is held at 67 % above the repo's p90 ("longer than usual"), which freezes the estimate exactly when it matters most.
- **Baseline bias.** The fresh-segment length is one median per repo. The measured median error is about 20 min either way, and it ran SHORT over the last 14 days because recent tasks are longer than the 90-day median.
- **Not modelled on purpose** (docs/schedule.md § Durations): a blocked split parent resolving, a feature pausing after a failure, a loop beyond its next iteration, the PTY hard cap, in-process follow-on holds.

**Measured** (`GET /api/schedule/accuracy`, live API, 2026-10-29; method and the 2026-10-28 run in § Prediction accuracy):

| window | claims matched | contested matched | duration n | median abs error | median signed | median predicted / actual |
| --- | --- | --- | --- | --- | --- | --- |
| 14 d | **135 / 135 (100 %)** | 124 / 124 | 257 | **21.4 min** | −16.0 min (short) | 44.6 / 53.3 min |
| 31 d | **198 / 199 (99.5 %)** | 165 / 166 | 459 | **17.9 min** | −3.8 min | 44.6 / 37.9 min |

Read it as: WHICH task runs next is right essentially every time (every claim in both windows was a custom-queue claim — the global switch was off, so `base`/`overflow` have only unit-test coverage), and WHEN it starts is good to about ±20 min per queued task ahead of it, compounding along a queue. The one miss is a pre-2026-09-28 rule graded against today's twin (§ Measured).

## Prediction accuracy

How well the schedule simulator (`predictSchedule`, docs/schedule.md § Simulator) agrees with the claims the server actually made. **`GET /api/schedule/accuracy?days=14`** (`days` 1–31, default 14; anything else gets a 400) is in `server/src/routes/timeline.ts` (`loadAccuracy`). It is backed by the pure **`replayClaims()`** (`shared/src/schedule-accuracy.ts`). Read-only, and no `Origin` is needed.

### Method

The replay takes every `task.transition` in the window that carries `data.claim` (`base` = the global claim, `custom-queue`, `overflow`). For each one it rebuilds the board as it stood **just before that row** (id order, so rows of the same millisecond keep their order). It then runs `predictSchedule` with `now` = the claim's instant. The claim **matches** when the simulator's first claim (earliest start, then lane) is the claimed task AND starts at that same instant. A prediction of "the same task, two minutes later" is a miss.

What the replay rebuilds from the log:

- **Status.** Each task's last `task.transition` / `task.created` before the claim. The window's rows come from `loadTimeline`, seeds included. A task with no row at all keeps its current status. A task whose first row is its `task.created` did not exist yet.
- **Review and check rounds.** Read from the phase-0 segment fold: `buildTaskSegments` over every row, then `segmentAt` (the lookup `stateAt` uses, now exported). `review-round` means `reviewState: 'reviewing'`, `checks` means `checkState: 'running'`, and an idle review is settled. The fold covers ALL the rows, so a provisional idle that a later verdict relabels is a round at every instant inside it.
- **Custom-queue marks.** From `task.queue` rows: `add` sets the mark to the row's time, `remove` clears it, and `reorder` sets it to `data.after`. A terminal transition clears the mark. So does a human/telegram transition into `queued` (Enqueue/Retry mean the global queue), except that a following `task.undo { action: 'undo' }` puts it back. `task.undo { action: 'release', queue: 'global' }` clears it too.
- **Undo-start holds.** `task.undo { held: true }` sets the hold, and release or any transition clears it.
- **Pause-all markers.** The `suspended` ids of `orchestrator.pause` rows, cleared by the task's next transition.
- **Settings and holds.** `orchestrator.enabled` from `orchestrator.toggle` and `orchestrator.paused` from `orchestrator.pause`. For each, the value before the first row is the inverse of that row, else the current setting. Feature status comes from `feature.transition`. A `repo.push-health` row with `ok: false` of kind `auth`/`protected` holds the repo until the next row.
- **Live runs.** Worker and review runs with `startedAt ≤ T < endedAt`, or ended-less and still `running`. The run's current `idle` flag is dropped. Every worker run is passed, so an overflow credit and an agent filing's filer resolve.

The control rows (`ACCURACY_CONTROL_KINDS`) are fetched over all time, because a membership or a switch may predate the window. Done/published/cancelled rows without a feature are left out of each simulation: they gate nothing. That cut the 14-day run from ≈13 s to 4–10 s on the live DB.

### Cost in the API process

An uncached replay is seconds of CPU in the single-process API, and the route needs no `Origin` (it is a read). So it must neither freeze the server nor be repeatable at will:

- **Cached.** `accuracyCached` keeps each `days` result for 10 min (`ACCURACY_TTL_MS`). Concurrent callers share ONE in-flight computation, so a polling page or a worker's curl gets the cached answer, never a new replay.
- **Stepwise.** `replayClaims` is a thin drain over the generator `replayClaimSteps`, which yields after the segment fold and after every claim (each claim is one full `predictSchedule`). `loadAccuracy` drains it with a `setImmediate` between steps.
- **One load per macrotask.** `loadAccuracy` also yields between its loads. The SQLite driver answers synchronously, so loads chained by `await` or put in a `Promise.all` would hold the loop for their sum: an `await` on a resolved promise is a microtask, and I/O never runs in between.
- **What still blocks.** The longest stretch is now one storage call or one claim's simulation, never the whole replay.
  - Measured on the DB copy at a machine load average of 22–30, with a 20 ms probe timer: a claim step took ≤ ~0.7 s (72 ms at normal load).
  - The slowest single call is `listTasks()` (860 rows): 0.7–4 s at that load. It is the same call `GET /api/tasks` makes on every board load. Splitting it would need a paged storage read, and moving the replay off the loop would need a `worker_thread` with its own storage connection. Neither is done.
  - A cached call answers in under 0.1 s.

**Approximations** (also returned verbatim as `approximations`):

- Priority, sort order, group, feature phase, `workdir` and the repo rows (`parallel`, `delivery`, `landing`) come from the CURRENT rows.
- `orchestrator.concurrency` is the current value. `config.changed` records keys, never values, so a claim made before the last change may have run under another cap; the response names when that change was.
- `review.enabled` and `agent.autoWake` are the current values. Wake-ups (`wake_at`) and loop states are not replayed, and the day budget fuse is taken as never reached.
- A custom-queue member with no `task.queue add` row before its custom-queue claim (an agent filing) counts as a member from its creation.
- Deleted tasks are gone. Their claims are counted in `skipped`, and a hold they had on a repo is not seen.
- The replay grades the past against TODAY's rules (the shared twins). A claim made under a rule that has since changed shows up as a miss.

### Response

`ScheduleAccuracy`:

- `{ total, matched, rate }` overall and per claim kind (`byClaimKind.base | custom-queue | overflow`).
- `contested`: the claims that were a real choice, with two or more queued, unheld candidates in the rebuilt state. A lone waiting task is an easy match.
- `skipped`: claims of deleted tasks.
- `samePassOtherOrder`: misses where the claimed task WAS among the claims predicted for that instant, only in another order.
- `mismatches`: oldest first, capped at `ACCURACY_MISMATCH_CAP` (50), with `mismatchesTotal` uncapped. Each is `{ at, predicted: { taskId, title, source, start } | null, actual: { taskId, title, claim }, reason }`. The `reason` reads like "predicted 2 min later (global) — waits for nest: Task B in review round" or "predicted global claim of "G" instead; …".
- `duration`: for the tasks that landed (first transition to `done`/`published`) in the window with worked time, the **median absolute error** of the predicted work segment against the actual worked time.
  - Predicted is `scheduleWorkMs`, the same figure the simulator uses (the repo's median from the CURRENT baseline, else all repos', else the default). Note that the current baseline includes the window's own landed tasks.
  - Actual is the sum of `runWorkedMs` over the task's worker runs, as in the baseline.
  - Also reported: the signed median (`medianErrorMs`, negative = predicted short) and the medians of both sides.
- `approximations` and `truncated` (the timeline load hit its row cap).

### Measured (live DB copy, 2026-10-28)

Measured on a `.backup` copy of the live DB through an `app.inject` harness that registers only the timeline routes.

| window | claims | matched | contested (matched/total) | duration n | median abs error | median signed error | median predicted / actual |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 14 d (10-14 → 10-28) | 127 | **127 (100%)** | 116 / 116 | 246 | **21.3 min** | −15.8 min (short) | 43.9 / 51.7 min |
| 31 d (09-27 → 10-28) | 191 | **190 (99.5%)** | 157 / 158 | 454 | **17.7 min** | −3.3 min | 43.9 / 37.1 min |

- **Every claim was a `custom-queue` claim.** The global queue switch was off for the whole period, so `base` and `overflow` have no live numbers; the unit test covers them.
- **Skipped:** 0 in both windows.
- **The one miss** (2026-09-28 20:48) was two custom-queue heads in one pass, the same pass in another order. The simulator put an agent-filed nest member first. The server held it until the next morning, and claimed it 2 s after a nest task sitting in an idle review (an old-shaped landing with no recorded round) was marked done. That is the pre-2026-09-28 hold, where a filed member waited while any same-repo task sat in review. It was replaced that day (docs/queue.md), so this is a past rule graded against today's twin, not a twin bug.
- **The control.** Re-running the 14-day window on a copy with the `task.queue` rows deleted drops it to 15/127. The match comes from the rebuilt membership, not from the replay echoing the log.
- **Duration.** The median work segment is about 20 min off in either window. Over 14 days it runs short (recent tasks are longer than the baseline's median), while over 31 days the bias is nearly gone. The p75 is not used for fresh turns, only to clamp live ones.

## Verification

- Drag the future (`npm test`: `server/src/queue-drop.test.ts` — siblings, another group's roots, same group/other parent refused, priority and cross-queue refusals, custom-queue midpoint, renumber and same-millisecond marks, non-queued). In the browser, a throwaway API from the task's worktree (its own fresh `server/data`, port 5195, a stub `claude` on PATH that only sleeps, so two "running" tasks held both scratch repos and seven queued tasks were predicted behind them):
  - Desktop 1440×900 (Chromium): grips on the seven queued ghosts, none on the running remainders. G2 → before G1 sent `/move {before, G1}`, the ghost read `starts 08:51 · was 09:19` while hovering, the ghost's ETA moved the instant the mouse was released, and the global order became Hi prio, G2, G1, G3. C3 → before C1 sent `queue-move`; the custom order became C3, C1, C2. G1 → before Hi prio (priority 1 vs 0) and G3 → before C2 (global vs custom) showed the refusal, sent nothing and changed nothing. The Queue page then listed C3 #1, C1 #2, C2 #3 and Hi prio, G2, G1, G3. A `/move` forced to 409 (Playwright route) put the ETA back and toasted the reason.
  - Phone 393×852 (`.app.mobile`, CDP touches): a 450 ms hold then a drag reordered G1 above G2 (`/move`) and C1 above C3 (`queue-move`; `customQueueWaiting` order C1, C3, C2); the cross-priority drop was refused with nothing sent; a flick with no hold did not arm; no explain sheet opened from a drag.
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
- `server/src/task-history.test.ts` (`npm test`) covers:
  - A full life through `buildTaskHistory`: created → claimed → run → review flagged → fix round → review passed → auto-landed done, with segment durations (not the idle PTY's `endedAt`), run and reviewer costs, and `historyTotals`.
  - Idle terminals retired as `status: 'killed'` (followUp, landing) read as normal turns; a `run.killed` row or a turn open at `endedAt` reads killed.
  - Agent-filed creation with depth. A question answered, and one expired after an autopilot skip, with the answer text appearing in no step. A usage-limit stop-failure, park and wake. A transient retry and an auto-compact. A failed marker whose error comes from the retry. Undo and release. Dispatches sent and received, and the received-only fallback.
  - Checks/waiting/PR/landing/publish/shipped points, and an overflow claim.
  - `loadTaskHistory` on a temp SQLite DB: it returns the extra kinds (never `run.attention` or `task.edited`) and both dispatch directions, its `segments` deep-equal the pre-widening loader's for the same rows (untruncated and at cap 2), and `loadTimeline` still returns only the fold's kinds.
- Against a `.backup` copy of the live DB, through an `app.inject` harness that registers only these routes:
  - 24 h / 7 d / 30.9 d windows answered in 57–549 ms, untruncated (≈4.7k events over 30 days).
  - 40 days and a non-ISO `since` returned 400, and `repoIds=` returned empty.
  - A repo-scoped window held only that repo's tasks, and an unknown task's history returned 404.
  - A real fix-round task rendered as review-round → idle → fixing → review-round with the reviewer runs attached, from rows written before the Stop hook recorded `reviewState`.
- The desktop tracks (`/timeline`, a scratch build in headless Chromium 1440×900 over the live front door — every non-GET aborted — with `/api/timeline` + `/api/schedule/baseline` answered by a routes-only harness over a DB copy; Classic and Glass, dark and light):
  - Six workspace rows; neko-nest, neko-frontend (2 parallel) and task-manager drew sub-lanes — task-manager 3 lanes over a cap of 2, where a verify round (checks → review) overlapped two running tasks. 60 bars with 19 striped sub-segments, 58 idle tails, 43 landed/failed markers and 11 ghosts (the running ones continuing their live bar on the same lane, labelled `ends ~01:02`).
  - NOW opened at 70 % of the viewport. Hour/Week/Day kept NOW at the same x; ctrl-wheel zoomed 24 h → 13 h; a 250 px drag panned 250 px; hovering a bar and a ghost showed their cards; clicking a bar opened `?task=<id>`. No page errors.
  - 7 d window: 60 / 123 / 650 nodes at Hour / Day / Week, ≈ 3 ms per scroll step in both designs.
- The SPA seam (`/timeline`, a scratch build served over the live front door by Playwright, `/api/timeline` + `/api/schedule/baseline` answered by a routes-only harness over a DB copy, every non-GET aborted):
  - Desktop, All: past tracks (43 tasks over 24 h), NOW, 5 predicted `running` slots with lane, ETA and review after the work, 59 not scheduled with their reason (queue off).
  - A synthetic `task.transition` injected on the events socket put the task on the past list as `queued … → now` and into NOW's queued row; a REAL draft → cancelled transition (a probe task filed and closed through the agent API) appeared as a `cancelled` marker. `/api/timeline` was not called again in either case.
  - NOW (and the prediction, which reads it) moved on the 30 s tick with no event.
  - `?ws=neko`: the fetch carried the workspace's repo ids, only neko repos were listed, a row from another repo was not folded, and the sidebar link read `/timeline?ws=neko`.
  - Phone (393 px, iPhone UA): `.app.mobile`, the stream (past newest 60, NOW, predicted), and the More sheet's Timeline link read `/timeline?ws=neko`.
- `server/src/schedule-accuracy.test.ts` (`npm test`) covers:
  - A synthetic log of eight server-made claims that must replay at 100%. Its cases: a priority win, two base claims in one pass, a review round and a checks stage holding the repo until their verdicts, custom-queue heads with one waiting on a busy repo, an overflow child past a full cap, a Pause/Continue, and an Undo-start hold skipped by the next claim. The queue switch is reconstructed from `orchestrator.toggle` (the current setting says on, the log says off before T0).
  - A claim moved into the open review round is a mismatch whose reason names the holder.
  - Dropping the `task.undo` row makes the held task the prediction.
  - A deleted task's claim is skipped, and the mismatch cap is applied.
  - The worked-duration error.
  - The route's `days` validation, and a real `claimNextQueuedTask` row through SQLite replaying as a matched `base` claim.
  - The cache: a new claim is not seen until `resetAccuracyCache`, two concurrent callers share one result, and the recomputed replay counts the new claim as matched.
- The phone stream (`TimelineStream`, a scratch build served over the live front door by Playwright Chromium at 393×852 with touch and an iPhone UA, `/api/timeline` + `/api/schedule/baseline` from a routes-only harness over a DB copy, every non-GET aborted), in Classic and Glass, dark and light:
  - It opened scrolled to NOW (divider near mid-screen) once the first answer and the board's load were in — also when the socket's first connect refetched the window meanwhile (the case that first left it at the top).
  - Scrolled to the top, NOW stuck at the bottom just above the tab bar; scrolled to the end, it stuck at the top under the header (Classic) or the floating header (Glass).
  - Rails: a legend of the four repos shown (`×2` on the three parallel ones), every row a repo hue in the token palette, 42 rows with a lit lane; rows ≥ 44 px; no element under `.tl-stream` or inside the explain sheet has its own scroller.
  - Tapping a predicted row's reason opened the Sheet (source, ETA, work → review, lands, every wait, the baseline note, Open the task); a 650 ms touch hold on a past row opened its explanation and did NOT open the task; a plain tap opened the task panel (`?task=<id>`).
- The scrub cursor and playback (a scratch build in Playwright Chromium over the live front door, every non-GET aborted, `/api/timeline` + `/api/schedule/baseline` from a routes-only harness over a DB copy that logged every timeline request), Classic and Glass, dark:
  - Desktop 1440×900: dragging the NOW pill 500 px left read `Oct 28 18:53 — 1 in review, 27 landed`, outlined the bars holding T and dimmed the rest; release removed the chip and the handle read `now 07:06` again.
  - Scrolled to the canvas's start, one 40-move drag over the repo column → exactly ONE extra `/api/timeline` request (the older gap only, `until` = the old start), `since` moved a window back and the view kept its place; a further push past the view's edge stepped the cursor back with the view, the cursor line staying at the time area's left edge.
  - Hour zoom, ×600, Play: the cursor advanced 05:12 → 05:33 in 2 s, Pause held it (05:54 after 1.5 s), Play resumed from there and on reaching NOW the chip disappeared and the handle read `now …` (live).
  - Phone 393×852 (touch, iPhone UA): dragging the slider listed the sets at T (running / in review / landed with titles), lit 15 rows of the past list (cut at T) and dimmed 45; a drag on into the hatched part made ONE extension request for the whole drag (the slider's frozen range); releasing off the slider returned to live; the speed button cycled ×60 → ×600 → ×1, Play advanced the chip and **Now** returned to live.
- **Phase 6, the whole feature in a real browser** (2026-10-29, Claude in Chrome over a throwaway API from the task's worktree: its own fresh `server/data`, port 5195, started as a one-shot command with a stub `claude` on `PATH` that only sleeps; three scratch repos; seven past tasks seeded as `task.transition` rows 2.5–9 h back, two live stub runs holding alpha and beta, four global and three custom-queue tasks queued). The extension's screenshots timed out, so everything was read off the DOM, with real mouse and key input:
  - **Desktop 1440×900, Glass.** Three repo rows, all 9 bars (5 done, 1 failed, 1 in review, 2 live), the NOW pill and line, the counts `2 running · 0 waiting · 0 checks · 1 in review · 7 queued`, and 7 ghosts, each labelled with ETA and reason (`all 2 worker slots busy`, `waits for beta: R2 live beta running`, `waits for gamma: C2 custom gamma in review round`).
  - **Drag.** G3 → before G2 sent `/move`: `sort_order` 12.5 between G1 (12) and G2 (13), one `task.moved` row, and the ghosts re-predicted at once (G3 ~12:26, G2 ~12:54). G1 → onto Hi prio (priority 0 vs 1) toasted `claim order is priority first … change the priority instead`, and nothing was written.
  - **Scrub.** Shift+← on the focused handle pinned the cursor. At 02:26 the chip read `02:26 — 1 running`, the bar holding T (Fix login redirect, 02:10–02:50) was lit and the rest dimmed; Escape returned to `now …` with nothing dimmed. **Fixed here:** keyboard steps used to leave the cursor off-screen (x = −2056 px), where the lit bar was culled. A step that leaves the viewport now brings the view along, like playback.
  - **Desktop, Classic.** The same rows, bars, ghosts and counts in the Classic tokens. Dragging C3 → before C1 sent `queue-move`: the waiting set was renumbered inside its [min, max] span (C3 .478, C1 .509, C2 .541) with one `task.queue { action: 'reorder', renumbered: 3 }` row.
  - **Phone 393×852** (an iframe at that width, since the window will not go below 500 px; `.app.mobile`). Classic: 47 stream rows, the NOW divider with counts, predicted rows with `waited: …` reasons, 7 grips, and the scrub bar. A mouse drag of G2 onto G3's top half sent `/move` (G2 → 12.25). Slider key steps pinned at `Oct 28 11:18 — nothing live`, then at `02:22 — 1 running`, with Fix login redirect listed under running and past rows lit or dimmed. Glass: the divider and scrub bar carry `blur(24px) saturate(1.8)`; Play advanced 11:19 → 11:28 at ×60, and **Now** restored all 47 rows. The touch hold itself was covered with CDP touches in the drag phase above. No console errors.
