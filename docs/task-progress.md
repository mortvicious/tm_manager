# Task progress %

An approximate progress % on every live task, drawn as a hairline along the
bottom of its board row plus a small `~45%` beside the status badge (desktop
and phone rows). Board row only for now: no task panel, Telegram, push or
Inbox surface. Design chosen with the user in task e10cf300
(`progress-spec.md` in its artifacts); decisions.md 2026-10-26.

## The model

One pure function in `shared/src/progress.ts`:

```ts
taskProgress(task, signals, baseline) → { pct, band, source, overrun, detail } | null
```

so the SPA and any later surface read the same number. `null` means show
nothing.

### Bands

The band comes from the row, in the order `badgeReading()`
(`web/src/components/StatusBadge.tsx`) reads it:

| band | % | row state |
|---|---|---|
| work | 0–70 | `running` / `waiting` — the agent is coding |
| checks | 70–80 | `review` + `checkState` `pending` (72) / `running` (76) |
| auto-review | 80–90 | `review` + `reviewState` `pending` (82) / `reviewing` (86) |
| fixing | 90–95 | `running` + `reviewState: fixing`, or "fixing checks" (`running` + `checkState` `running`/`red`) — 91 |
| landing | 95 | a live publish turn (worker run labelled `publish`) |
| done | 100 | `done` / `published` |

Hidden: `draft`, `queued`, `blocked`, `failed`, `cancelled`, a SETTLED review
(`passed`/`flagged`/`skipped`/`error`, checks `red`/`error` — it waits on the
human, so a % there means nothing) and any row with a Pause-all marker
(`pausedTurn`). The board draws no bar on `done`/`published` rows either: the
function returns 100 for them, but a full bar on every finished row is noise.

### Work fraction

Inside the work band, in this order:

1. **Loop tasks** (`kind: 'loop'`): ended iterations / `loopMaxIterations`
   (an iteration counts once its checks run or the next one is queued).
2. **The agent's todo list**, when its latest list in THIS run has ≥ 2 items:
   `(completed + 0.5 × in_progress) / total`.
3. **Output tokens vs the repo baseline**: the sum of `stats.outputTokens`
   over the task's `mode: 'worker'` runs (the SPA already holds every run, and
   live runs are re-summarised every 20 s), piecewise `0 → 0`, `median → 0.6`,
   `p90 → 0.95`.
4. No baseline (fewer than 10 landed tasks overall) → no work % at all.

Every fraction is capped at 0.95 of the band, so the work band never reaches
the checks band while the agent is still coding.

Raw run wall time is deliberately NOT a signal: idle PTYs inflate it (medians
28–75 min, a max around 14,900 min).

### Todo list

`ActivityWatcher` (`server/src/claude/activity.ts`) already tails each live
run's transcript; its `TodoTracker` rebuilds the list from the same lines and
`RunActivity.todos` carries `{ done, inProgress, total }` to the SPA over the
existing `run.activity` event (emitted when the counts move, even if the
narration line did not). Two shapes are read:

- `TodoWrite` — rewrites the whole list each call (`input.todos[]{status}`).
- `TaskCreate` / `TaskUpdate` — built call by call: a create's id comes back in
  its result (`toolUseResult.task.id`, else "Task #3 created…"), an update
  sets `status`, `deleted` drops it.

Whichever was touched last is the list. Sidechain lines (a subagent's own
list) are skipped. A resumed run inherits the whole session, so the first read
pre-scans the transcript (its last 64 MiB) for the list before tailing; a list
last touched before the run started belongs to an earlier turn and is not
used.

**Measured 2026-10-26: no worker transcript contains either tool.** On CLI
2.1.280 `TodoWrite` is gone (the name in `WORKER_TOOLS` matches nothing) and
the task tools are not in `WORKER_TOOLS`, so today every work % comes from
tokens. Enabling `TaskCreate`/`TaskUpdate` for workers is a separate decision
(every turn pays for their schemas); the tracker is ready for it.

## Baseline

`GET /api/progress/baseline` (`server/src/routes/progress.ts` →
`progressBaselineCached` in `server/src/progress.ts`, computed by the pure
`progressBaseline`): median + nearest-rank p90 of the per-task worker
output-token sum over the `done`/`published` tasks updated in the last 90 days,
per repo and over all repos; tasks with no output are left out. The repo's own
line is used when it has ≥ 10 such tasks, else the all-repo line. Cached for an
hour on the server, like the `cost-high` line in `anomalies.ts`; the SPA
fetches it once and again after an hour (`web/src/progress.ts`).

Numbers on 2026-10-26 (a DB copy, `app.inject`): neko-frontend 91k / 175k
(n 295), neko-nest 72k / 134k (191), task-manager 54k / 126k (116),
neko-vite-new 42k / 110k (98); all repos 72k / 152k (704).

## Overrun

Past the baseline p90 the work band holds at 95 % of itself (67 %) with
`overrun: true`: the bar turns muted (`--tm-text-muted`), the `~%` goes italic,
and the title says "longer than usual". No asymptotic creep, no hiding.

## Never backwards

The normal chain (work → checks → auto-review → fixing → landing → done) only
rises. Two things would make it fall: a todo list that grows, and a fix round's
re-check / re-review (91 → 72). `signals.floor` covers both: the SPA keeps the
highest % shown per task (`web/src/progress.ts`, in localStorage so a reload
mid-chain keeps it) and `taskProgress` never returns less, capped at 95 while
live. So a re-check after a fix holds the fix band's value while its band
label (tooltip) says `checks`.

A floor stands only while no worker run of the task started after it: a new
run is a new chain (a follow-up, Retry), while a chain's fix rounds are typed
into its live session. It is stamped no earlier than the newest run's start,
so a phone with a skewed clock cannot void it, and it is dropped when the row
is hidden or done.

## UI

`web/src/components/TaskProgress.tsx`: `ProgressBar` (the 2px hairline,
`calc(var(--tm-space-1) / 2)`, `transform: scaleX(pct)` from the left so a step
never reflows the row) is rendered by `TaskRow` when the board passes
`progress`; `ProgressPct` (`~45%`, mono, muted) sits after the status badge,
and on a phone right after the badge that leads the meta line. Colours: work /
fixing / landing `--tm-status-running`, checks / auto-review
`--tm-status-review`, overrun `--tm-text-muted`. Motion `--tm-dur-slow` /
`--tm-ease-out`, none under `prefers-reduced-motion`. Glass needs no rule of
its own: the remapped tokens carry it. The title on both explains the source:
"~44% · work · 59k of ~54k tokens (repo median)", "~86% · auto-review ·
reading the change", "work · 4/6 todos".

## Verification (2026-10-26)

- `npm run typecheck`; `vite build` to a scratch outDir (web/dist is what the
  live front door serves).
- Baseline: `app.inject` on a copy of `server/data/taskman.db` — the numbers
  above, matching the spec's hand count.
- Pure function: a tsx script (`progress-unit-check.ts` in task 3d8f7415's
  artifacts) over all 3,840 status × review × check × tokens × paused
  combinations — hidden states hidden, never 100 before done, no band later
  than the row, the chain monotonic, the floor holding a re-check, overrun hold
  at 67, piecewise points, repo → all-repo fallback, todos (< 2 items falls
  back), loop iterations, and the `TodoTracker` over both tool shapes and
  sidechains; plus the watcher on a 930 KB transcript whose creates sit above
  the 512 KB tail.
- Browser: Playwright on the live board (Classic + Glass, 1440px desktop +
  393px phone), baseline fulfilled from the DB copy and two rows rewritten
  into checks / auto-review states.
