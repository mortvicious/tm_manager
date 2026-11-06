# The memory fuse

Task a081c4c5 (2026-11-06). Part of the group "the laptop must stop freezing under
the task manager's own load".

## Why

Measured on the 8 GB MacBook after 10 h of uptime: swap 4.9 of 6 GB in use, load
average peaking at 87. macOS bills every descendant of the terminal app to that
app. `npm start` runs in Warp, so "Warp 13 GB" in the memory dialog was really the
task manager's process tree:

| process | footprint |
| --- | --- |
| neko-nest `nest start --watch` (repo command) | 2.6 GB |
| a worker's `tsc --noEmit` | 1.7 GB |
| 5 × `claude` | ≈ 250 MB each |
| the API | ≈ 0.3 GB |

`orchestrator.concurrency` was 4. Every new claim, wake, reviewer or job adds another
`claude` and whatever it runs, so the server kept piling work onto a machine that was
already swapping. The fuse is in the same family as `budget.dayUsd`
(`docs/token-budget.md` § Fuses). While the machine is under memory pressure, nothing
new and automatic starts. Turns that are already running finish.

## Settings

| key | default | meaning |
| --- | --- | --- |
| `memory.minFreePct` | 0 (off) | hold while free memory is below this % of physical memory |
| `memory.maxSwapPct` | 0 (off) | hold while more than this % of allocated swap is in use |

Either half alone is enough to trip the fuse. Both are 0 by default, like every other
fuse; `PATCH /api/settings` takes `null` as 0. They are in Config → *Budget & alerts*
(both settings versions). For the 8 GB Mac, a reasonable start is `minFreePct` 15
and `maxSwapPct` 75. The freeze above was at 82% swap.

## The sampler (`server/src/memory.ts`)

The sampler runs every 15 s (`MEMORY_SAMPLE_MS`), from an orchestrator timer plus
one sample at construction. On macOS it makes ONE call,
`sysctl -n kern.memorystatus_level vm.swapusage kern.memorystatus_vm_pressure_level`
(argv, no shell, ≈ 10 ms):

- `kern.memorystatus_level` is the "System-wide memory free percentage" that
  `memory_pressure` prints. This is `freePct`.
- `vm.swapusage` gives used and total swap. This is `swapPct`. macOS grows swap on
  demand, so the percentage drops when a new swap file is added. The reason line
  always gives the GB as well.
- `kern.memorystatus_vm_pressure_level` (1 normal, 2 warn, 4 critical) is recorded
  and shown, never gated on. It reaches "warn" late, and its levels are too coarse to
  tune.

On Linux the sampler reads `/proc/meminfo` (`MemAvailable`, `Swap*`). Anywhere else it
uses `os.freemem()` with no swap. With the fuse off, no sample is taken at all.

The reading is folded into one cached, process-wide state by the pure
`stepMemoryFuse` (`shared/src/memory.ts`). Every gate reads `memoryHold(settings)`,
which is synchronous and does no I/O, so the claim path never waits on a subprocess.
Passing the settings means that turning the fuse off releases the hold immediately,
before the next sample.

### Hysteresis

- **Trip** after `MEMORY_TRIP_SAMPLES` (2) consecutive breaching samples, ≈ 15–30 s.
  A single `tsc` spike is not an episode.
- **Clear** after `MEMORY_CLEAR_SAMPLES` (3) consecutive samples that are
  `MEMORY_CLEAR_MARGIN_PCT` (5) points INSIDE both limits: free ≥ min + 5 and
  swap ≤ max − 5. A sample between the line and the margin neither clears nor counts
  toward clearing, and a relapse resets the count. Back over the line is not enough
  to clear, so the fuse does not flap around the threshold.
- **Fails open.** An unreadable sample never trips the fuse and counts as clear, so a
  broken `sysctl` cannot hold the queue forever. `state.error` keeps the cause.

## What it holds

"Automatic" means anything the server would start on its own. A human click is never
held: Run now, Proceed, Follow-up, Retry, Review now, Wake now, Analyze, a job's Run
now, and so on.

| source | where | while held |
| --- | --- | --- |
| claims: custom queue, global, overflow; loop iterations; paused-turn resumes (Continue's backlog); wait resumes; dispatch delivery | `maybeSchedule` returns right after the Pause-all check | queued tasks stay queued, pending dispatches stay pending; the next pass after the clear picks them up |
| auto wake-ups | `wakeSweep` skips `wakeDue` | `wake_at` marks stay; they fire on a later sweep. Parking stalled turns still runs, because it starts nothing |
| verify rounds: the check stage and the reviewer session | top of each `reviewLoop` pass, and between the checks and the reviewer (`memoryHeldRound`) | the row keeps `review_state`/`check_state` `pending`; the clear re-runs it through `resumeVerifyRounds` (the same function Continue uses). One `task.memory-held` row per task per episode. A human's *Review now* is not held |
| scheduled jobs | `JobService.sweep` | due jobs stay due; `jobs.hold` = `memory` ("the memory fuse holds automatic work") |
| office shifts: cron, event, signal, huddle turns, the Director's channel routing | `officeGate` returns code `memory` | a DEFER code in the scheduler, event triggers, signals and the docs watcher, so the slot or event stays owed; huddles and routing wait for a later tick. A human `request` (Wake now, a wish, Ask the Director) passes |
| office command runs | `officeCommandGate` code `memory` | skipped and audited `office.command`, like any hard-gate refusal (never re-run) |
| office feature planning | `fileOfficeFeature` | the feature stays a `draft` with `not analyzed: <reason> — press Analyze to plan it` |

**Not held, on purpose.** A turn already running and its own tail are not held:
- the review fix turn or check-fix turn that a round which already started sends back
  into the SAME session;
- a transient-error resume (`continue` typed into a live PTY);
- the rebase-conflict turn of a land.

Holding them would strand a half-finished verify loop that has no retry path. The
auto-publish publish turn at the end of a settled round is not held either: it is
one short turn, and `budgetAllows` is where it is refused. Chat turns, reports and
repo commands are human-started. The fuse is **not a `budgetAllows` kind** because a
refusal there is final for that turn (`refuseOverBudget` lands the task in `review`
with the reason), while a memory hold has to wait and then resume by itself.

## Surfaces

- **`OrchestratorStatus.memory`** is the cached state: latest sample, limits,
  `tripped`, `since`, `reason`, plus `hold`, the readable line. It is broadcast as
  `orchestrator.status` on every trip and clear.
- **Board.** `MemoryFuseBanner` (Layout, on `/`, `/board`, `/timeline`, `/queue`,
  `/inbox`) says that new automatic work is on hold, why, since when, that running
  turns finish and clicks still work, and when it will clear. It lives in Layout, not
  in the frozen `Board.tsx`.
- **Predicted schedule.** `predictSchedule` takes `memoryHold` (the SPA passes
  `orch.memory.hold`) and stops its pass like Pause all. Every candidate, paused
  marker, due wake and due loop iteration gets the wait `{ code: 'memory', text:
  <hold> }` (`docs/schedule.md` § The pass). The hold is assumed to last the whole
  horizon, and the held verify rounds are not modelled.
- **Alert.** On a trip, one `memory-pressure` anomaly (🧠 *Memory fuse tripped*,
  severity `warn`) is sent to Telegram (`notify.anomaly`) and to devices with the
  Anomalies push kind. Its key is `memory-pressure:<episode start>`, so a later
  sample in the same episode never re-pings. A clear does not ping. The Dashboard
  lists a live hold as a `memory-pressure` anomaly.
- **Audit.** Each trip and each clear writes one `memory.fuse` row
  `{ tripped, reason, limits, freePct, swapPct, swapUsedMb, swapTotalMb, pressureLevel }`.

## Verification

`server/src/memory.test.ts` (`npm test`) covers:
- the pure hysteresis: trip after 2 samples, the margin band, a relapse, off, fail-open;
- the swap-line parser;
- the sampler cache with an injected sampler (`setMemorySampler`);
- an Orchestrator over a temp SQLite DB with a SIMULATED sampler and `startWorker`
  stubbed out. Tripped: a queued task is not claimed, an automatic office shift gets
  `memory` while a human request passes, and exactly one alert and one audit row are
  written per episode. Inside the margin it stays held. Cleared: the pass claims the
  task and the shift gate opens.

`server/src/schedule.test.ts` covers the predicted `memory` wait while a live turn
keeps running.
