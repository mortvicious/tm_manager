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

## Heavy work

The fuse only holds NEW claims and turns, so it cannot stop a live worker
that starts Lighthouse mid-turn. Measured 2026-11-06: one worker on a CLS fix
in neko-frontend ran Lighthouse against two `next start` builds, which was 19
headless Chrome processes, ≈ 1.5 GB and ≈ 1.5 cores. The load average went to
37–50 with `kernel_task` at ≈ 60 % (memory compression), the laptop lagged
with ONE agent running, and the Lighthouse scores measured on that machine
were noise. Two `tsc`/`next build` repo checks in different repos at once is
another 3–4 GB. So heavy work takes a **slot**.

**One global set of slots** (`server/src/heavy.ts` `HeavySlots`, pure half
`shared/src/heavy.ts`). `heavy.maxParallel` sets the count: 0 = auto (the
default) gives 1 up to 8 GB of RAM, 2 up to 16 GB and 3 above, and 1..4 sets
it explicitly. Raising it needs `Origin` (an agent must not widen the slots it
is queued behind). The slots are a FIFO semaphore, in memory only, since a
restart ends every holder anyway. Two kinds of holder share them:

- **Repo checks** (kind `check`). `CommandRunner.runCheck` takes a slot
  before it spawns and gives it back when the run ends, so the server's check
  stage, a worktree land's re-check, a loop iteration's checks, a baseline, an
  office shift's command and an agent's own check all queue together
  (docs/checks.md § One check at a time). The wait is NOT counted against the
  check's timeout, and `abort` is polled while waiting. A check is never held
  by the memory fuse: the verify round was already gated on it before it
  started (§ What it holds).
- **Agent leases** (`lighthouse|playwright|browser|build|other`), taken
  through the agent API (`server/src/routes/agent-heavy.ts`,
  `docs/agent-instructions.md` § Heavy work):
  - `POST /api/agent/heavy/acquire {kind, why, waitMs?}` long-polls (≤ 55 s)
    until a slot is free AND the memory fuse is clear. It answers `granted`
    or `waiting` (with `position`, `waitingOn: slot|memory` and the `reason`).
  - `GET /api/agent/heavy/:id?waitMs=` keeps waiting.
  - `POST …/:id/release` returns the pressure report.
  - Worker runs only (aux → 409), one ticket per run (a second acquire returns
    the first), and only the task's own sessions can poll or release it.
  - A lease waiting on the fuse steps aside for a check behind it, never the
    reverse.

**A lease always ends.** These are the ends recorded in the audit:

| End | When |
| --- | --- |
| `released` | the agent released it |
| `turn-ended` | the Stop or StopFailure hook, or a shell-wait replay — except while the task is parked in `waiting`, where a background shell of the same turn may still be using it (`Orchestrator.releaseHeavyAfterTurn`) |
| `run-exited` | `handleExit` |
| `abandoned` | a waiting ticket nobody polled for 90 s (`HEAVY_TICKET_STALE_MS`) |
| `unclaimed` | a granted lease no poll ever picked up within 2 min (`HEAVY_UNCLAIMED_MS`) |
| `expired` | held for 60 min (`HEAVY_LEASE_MAX_MS`) |

**The pressure report.** While anything is held the machine is sampled every
15 s. Each sample is one `sampleSystemMemory` reading plus `os.loadavg()`,
independent of whether the fuse is on, and every holder's accumulator keeps:
- the lowest free %;
- the highest swap % and macOS pressure level;
- the peak 1-minute load;
- whether the fuse was tripped;
- the most OTHER holders seen at once.

`judgeHeavyPressure` reports `underPressure` with readable `reasons` when any
of these held: the fuse tripped, the macOS pressure level reached warn or
worse, free memory went under 15 %, load went above 1.5 × the core count, or
another heavy job ran at the same time. The release returns it together with
an `advice` line telling the agent to re-measure. A poll while granted returns
the report so far. A perf-measurement task can therefore tell a fair number
from a noisy one.

**Standing worker rule** (`STANDING_RULES` / `RESUME_REMINDER` in
`claude/worker.ts`):
- when a saved check covers it, run that check through the API
  (`POST /api/agent/commands/:id/check`) instead of your own `tsc`, build or
  test in Bash;
- wrap Lighthouse, Playwright/Puppeteer, headless Chrome and full builds in a
  lease;
- run audits one at a time, close browsers between runs, and never run one
  beside another heavy job;
- re-measure under pressure.

**Surfaces.**
- `OrchestratorStatus.heavy` (`{max, auto, held, waiting}`) is re-broadcast on
  every change.
- Every board row's `ProgressPct` shows the task's wait from `heavyWaitLabel`,
  the frozen original board included, without touching `Board.tsx`. It reads
  `waiting for a check slot` (its checks), `waiting for a heavy slot` (its
  agent's lease), plus ` (memory pressure)` when the fuse holds the lease.
- `StatusBadge` takes the same line as `heavyWait`. The task panel and Stacks
  pass it in, so the badge reads it instead of **checking** or **running**.
- Settings → Budget has **Heavy work slots**.
- **Audit:** each `heavy.lease` row carries `action` (`granted` or one of the
  ends above), `kind`, `label`, `waitedMs`, `heldMs`, and `underPressure` +
  `reasons`. Agent leases write the grant and the end; a check writes its end
  only when it had to queue, so the log is not one row per check run.

## Concurrency from RAM

Task a136dff6 (2026-11-06). The fuse and the heavy slots hold work once the
machine is in trouble; the worker count decides how often it gets there. The 8 GB
Mac ran `orchestrator.concurrency` 4.

- **The default comes from the RAM.** `suggestedConcurrency(totalMem)`
  (`shared/src/capacity.ts`): **2** up to 8 GB, **3** up to 24 GB, **4** above
  (half a GiB of slack for a Mac that reports a little over its size). Both storage
  drivers lay `machineDefaults()` (`server/src/machine.ts`) over `DEFAULT_SETTINGS`
  in `getSettings()`, so an unsaved `orchestrator.concurrency` reads as the
  suggestion everywhere it is read. A fresh config on an 8 GB Mac runs 2 workers.
- **The saved value always wins.** Nothing writes the suggestion: a value saved on
  the Config page is kept on any machine, including one above the suggestion. The
  server never lowers it; it warns. An agent cannot change it at all: PUT
  `/api/config` without `Origin` answers 403 for any change of the key (like
  `heavy.maxParallel`).
- **The warning** (`concurrencyAdvice`):
  - *over* — workers above the suggestion: "4 workers is above the 2 this Mac's
    8 GB suggests…";
  - *stacked* — workers + `chat.concurrency` + `jobs.concurrency` (jobs only while
    the jobs queue is on) above the suggestion plus the default chat (2) and job (1)
    caps. Chat turns and job runs are claude sessions that take no worker slot, so
    they stack on top. The defaults on an 8 GB Mac (2 + 2 + 1) warn about nothing.
- **Where it shows.** Config → Orchestrator → Concurrency shows "suggested for this
  Mac (8 GB RAM): 2" and the warnings; the chat and job concurrency rows show the
  stacked warning. Both settings versions read the form's unsaved values, so the
  warning appears before Save. The "changed from default" marker and Reset compare
  against the machine's default (`defaultOf`, `web/src/settingsForm.ts`), which
  arrives as `OrchestratorStatus.machine` (`{ totalMemBytes, suggestedConcurrency }`).
  Telegram `/status` lists the same warnings under the queue line.

## Memory per run

Task 622ddc5e (2026-11-06). The fuse says *that* the machine is short; this says
*what* is eating it, so the limits, `orchestrator.concurrency` and the heavy slots
can be tuned from numbers instead of from the Activity Monitor guess ("Warp 13 GB"
was the task manager's tree, billed to the terminal that ran `npm start`).

### The sampler (`server/src/proc-memory.ts`, pure half `shared/src/proc-memory.ts`)

Every 30 s (`PROC_MEMORY_SAMPLE_MS`, an orchestrator timer; single-flight,
`Orchestrator.procMemorySweep`) the server reads the process table ONCE and folds it
into one **tree** per live session root:

| root | kind | the row's label |
| --- | --- | --- |
| a worker run's claude PTY (idle ones too — an idle claude still holds its memory) | `worker` | the task title |
| an aux run's PTY (review, plan, chat, job, shift, …) | `aux` + its kind | kind · task title, or the aux label |
| a repo command run (dev servers, checks, one-shots) | `command` (`check` for a check) | command · repo |
| a terminal shell | `shell` | title · repo |
| the API process ALONE | `server` | task manager API |
| the front door (`TM_SUPERVISED`, not under `tsx watch`) | `server` | front door |

- **What is measured.** macOS: `top -l 1 -stats pid,ppid,mem,command`. MEM is the
  *physical footprint* — compressed and swapped pages included — the number the memory
  dialog and Activity Monitor show. `ps` RSS undercounts a tree that is swapping and
  double-counts shared libraries, so it is only the fallback (non-macOS, or `top`
  failing). One `top` call costs ≈ 0.25 s wall / 0.2 s system CPU (measured,
  ≈ 400–540 processes), async — never on a request or claim path.
- **The fold** (`foldTrees`, pure): each root plus every descendant, stopping at
  another root, so every process is billed once. The `server` rows count their own
  process only — the API's children ARE the other roots, and an unattributed child
  is not "the server". A root whose pid has gone by the time `top` runs is left out.
  Each tree carries `mb`, `procs`, and its `biggest` process (`tsc 1.7 GB` inside a
  worker), which is what tells a fat claude from a fat `tsc`.
- **System reading.** Every sample also takes one `sampleSystemMemory()` (free %,
  swap, macOS pressure level) — independently of the fuse, whose "off reads nothing"
  contract stays as it was.
- **Peaks.** Each root's peak is kept in memory for its lifetime. For worker and aux
  runs it is stored on **`tm_runs.peak_mem_mb`** (migration 61, `Run.peakMemMb`, MiB)
  by the conditional `bumpRunPeakMem` (`… WHERE peak_mem_mb IS NULL OR peak_mem_mb < ?`,
  both drivers — it never lowers a peak): on the first sample, whenever the peak grew
  by ≥ `PEAK_WRITE_STEP_MB` (32), and once more when the root disappears, so the
  stored figure is exact to the last sample without a write every 30 s. Each write
  broadcasts `run.updated`. Repo commands and shells have no `tm_runs` row; their peak
  lives in the snapshot while they run. A run shorter than one sample has no peak
  (null).
- **Unreadable table.** The previous trees stay with `error` set; the episode is not
  stepped (no reading is not a calm reading).

`OrchestratorStatus.procMemory` (`ProcMemorySnapshot`: `at`, `method`, `system`,
`physMb`, `trees` biggest first, `totalMb`, `memoryHigh`, `error`) is the latest
sample; the status is re-broadcast after every sample.

### Surfaces

- **Dashboard → Memory** (`components/MemoryCard.tsx`): free %, swap used of
  allocated, the macOS pressure level, the task manager's total of physical memory;
  the open `memory-high` episode; then one row per tree — kind, label, peak, process
  count, biggest process, a bar against physical memory, the size now. A row with a
  task opens it. Workspace-scoped like the rest of the page (repo-less rows — the API,
  a chat — always show). A one-column grid on a phone, like every other card.
- **Task panel**: the *last run* stats line gets `mem 1.2 GB · peak 2.1 GB` while the
  run is live, `peak mem 2.1 GB` after (`useRunMemory` in `RunMeta.tsx`).
- **Anomalies list** (`GET /api/stats/anomalies`): an open episode is a `memory-high`
  row.

### The `memory-high` alert

One `memory-high` anomaly (🐘 *Memory high*) per **episode** to Telegram
(`notify.anomaly`) and to devices with the Anomalies push kind, key
`memory-high:<episode start>` — never a ping per sample. An episode is high when
either half holds (`memoryHighBreach`):

| half | setting | default | high when |
| --- | --- | --- | --- |
| one tree | `anomaly.memoryTreeGb` | 2 (0 = off) | any tree is above the line (the 2.6 GB `nest start --watch` would ping; one 1.7 GB `tsc` would not) |
| system | `anomaly.memoryPressure` | true | macOS `kern.memorystatus_vm_pressure_level` ≥ 2 (warn); with no kernel level (Linux) free < 10 % |

- **Hysteresis** (`stepMemoryHigh`, pure): opens after 2 consecutive high samples
  (30–60 s — a 15 s build spike to *warn*, measured during `vite build`, does not),
  closes after 3 consecutive calm samples, where calm = every tree under 90 % of the
  line and pressure back to normal; a sample in between neither closes nor counts.
  Both halves off → closed at once.
- **Severity** `warn`, `critical` when macOS reports critical pressure (4).
- **The message** names the cause, the three biggest trees and the task manager's
  total ("big tsc 2.9 GB above 2.0 GB. Biggest: … The task manager's tree: 4.1 GB.");
  the `anomaly.notified` row carries the reading and the top five trees, and the
  alert's task/run is the biggest non-server tree's, so a tap opens it.
- It is an **alert, not a control** — the fuse (`memory.minFreePct` /
  `memory.maxSwapPct`) is the control, with its own `memory-pressure` alert; both can
  fire in one bad minute, on purpose: one says what is big, the other that work is
  held.
- Settings: Config → *Budget & alerts* (both settings versions); `PATCH /api/settings`
  takes `null` as 0 for the GB line.

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

`server/src/heavy.test.ts` covers the heavy slots:
- the pure slot count, the pressure verdict and the badge text;
- the semaphore: FIFO order, a fuse-held lease stepping aside for a check,
  release on turn end, stale/unclaimed tickets, and a raised setting;
- two tasks in DIFFERENT repos whose checks run one after the other through a
  real `CommandRunner` over a fake PTY pool, with task B reading `waiting for
  a check slot` until A's check exits;
- an aborted wait that never spawns;
- the lease routes over `app.inject`: granted, then waiting, then granted
  after the release, one lease per run, aux refused, not-yours 404, and the
  saturated-machine pressure report.

`server/src/capacity.test.ts` covers concurrency from RAM: the suggestion per RAM
size, the over/stacked warnings (none for the defaults on 8 GB; both for a saved 4),
an unsaved key reading 2/3/4 on 8/16/32 GB through `getSettings` and GET
`/api/config`, a saved 4 kept on any machine, and PUT `/api/config` refusing an
Origin-less change.

`server/src/proc-memory.test.ts` covers memory per run:
- the `top`/`ps` parsers (units, `+`/`-` suffixes, a command with spaces);
- the fold: each process billed once, the server row alone, a nested root;
- the `memory-high` hysteresis: 2 to open, the 90 % band, critical escalation,
  3 to close, a single spike, both halves off;
- the sampler with a simulated table: the first write, the 32 MB step, a peak that
  never drops, the flush when the root goes, an unreadable table;
- an Orchestrator over a temp SQLite DB with a REAL PTY (`sleep`) whose tree is
  simulated around its pid: the worker row (task title, biggest `tsc`), the API row,
  `tm_runs.peak_mem_mb`, and exactly one alert per episode, a second after a calm.
