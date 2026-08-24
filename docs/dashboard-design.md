# Design: Dashboard & full observability

Status: **APPROVED by adversarial review 2026-08-24 with 12 required changes** — implement exactly these amendments:
1. Event logging lives in the STORAGE layer: required `actor` param on transitionTask/claims/resolveChildCompletion/acceptProposal/createTask; event appended in the same transaction, only when the mutation matched (13 call sites + 4 storage-internal transitions make caller-side appends unmaintainable). Non-transition kinds stay caller-appended.
2. Actor threaded through orchestrator public methods (routes pass `human`; claim loop `orchestrator`; boot `system`).
3. Time-sortable event ids (ms-prefix + random, UUIDv7-style); feed ordered by id DESC; index on `at` only (+task_id); migration 5; no FKs.
4. No SQL date bucketing — fetch windowed rows, bucket in JS on server-local time (UTC `at` + Baku offset would split evening sessions in SQL).
5. Base tables answer every aggregate they can; events only for per-day done/failed, byActor, attention, overflow, boot.recovery, repeat failures.
6. Synchronous inline appends — NO fire-and-forget queue (an audit log must not lose events on crash).
7. Retention pruner CUT ("nothing untraced" means keep it; ~few MB/year).
8. `run.stats-final` appended at FIRST IDLE (Stop) as well as exit; workedMs = startedAt → first-idle-or-exit (idle chat time is not work).
9. Anomalies: `info` severity added; stale-review = info, knob ≥72h; long-run excludes idle runs; knobs limited to anomaly.longRunMin + anomaly.costUsd.
10. New kinds: task.created/edited/deleted, repo.changed, config.changed (key only, token values never logged), run.killed. Terminal I/O + page views documented as deliberately untraced.
11. Dashboard ignores run.updated for overview refetch (60s visible-page interval + throttled refetch on started/exited/task.updated); new `event.appended` broadcast feeds the activity list.
12. Cumulative cost line cut; all charts hand-rolled SVG on --tm-* tokens.

Original design below (amendments above override where they conflict).

Goal (user): "how much worked, how many agents day/week, how much context, anomalies, depth, etc. **Nothing should be left untraced.**"

## 1. What is already traced vs. what is not

Already in the DB per run/task: durations (started/ended), tokens in/out/cache, cost estimate, context %, model, effort, mode, idle flag, exit codes, task statuses, source (manual/sentry/auto), spawn depth, createdByRun, proposals.

**Not traced today (the gaps "nothing untraced" closes):**
- **State transitions over time.** We overwrite `status`; there is no history. Who moved a task (human button, Stop hook, orchestrator, boot recovery, agent API) is not recorded anywhere.
- **Attention events** — needs-attention flags are cleared, not accumulated.
- **Scheduling decisions** — overflow claims, claim-twin reverts, spawn failures exist only in task.error or logs.

## 2. New: append-only event log `tm_events`

```sql
tm_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT-equivalent,   -- dialect note: sqlite AUTOINCREMENT vs pg GENERATED; use TEXT uuid instead to stay dialect-neutral
  at TEXT NOT NULL,                 -- ISO timestamp
  kind TEXT NOT NULL,               -- task.transition | run.started | run.exited | run.attention |
                                    -- run.stats-final | proposal.created | proposal.decided |
                                    -- orchestrator.toggle | schedule.overflow-claim | schedule.spawn-fail |
                                    -- boot.recovery | agent.create | sentry.sync
  actor TEXT NOT NULL,              -- human | hook | orchestrator | agent:<runId8> | analyze | system
  task_id TEXT, run_id TEXT, repo_id TEXT,
  data TEXT                         -- JSON: {from, to}, {model, cost}, {reason}, ...
)
```

- Written **at the mutation sites** (transitionTask callers, orchestrator, internal routes, agent routes, sentry sync) — NOT by hooking `broadcast()` (run.updated fires every 20s per live run; persisting the event stream verbatim would be noise, and broadcast has no actor information).
- `actor` is the key novelty: every transition names who did it. The routes know (human = REST without run token; hook = internal route; agent = agent API; orchestrator/system = internal calls).
- Retention: nightly prune > 90 days (config `events.retentionDays`).
- Storage interface: `appendEvent(e)` + `listEvents(filter, limit)` + aggregate queries below. Dialect-neutral SQL (TEXT uuid PK, indexed on `at`, `kind`, `task_id`).

## 3. Aggregation endpoints (computed server-side, SQL + event log)

```
GET /api/stats/overview?days=7
  → { totals: { workedMs, costUsd, tokens, runs, tasksDone, tasksFailed, avgCtxPct,
                attentionEvents, agentFiledTasks, overflowClaims },
      perDay:   [{ date, runs, workedMs, costUsd, done, failed }],   # bar-chart series
      perRepo:  [{ repoId, name, runs, costUsd, done, failed }],
      perModel: [{ model, runs, costUsd, tokens }],
      depth:    [{ depth, count }],                                  # provenance ladder
      byActor:  [{ actor, transitions }] }

GET /api/stats/anomalies
  → [{ severity: 'warn'|'critical', kind, message, taskId?, runId?, at }]
```

**Anomaly rules (v1, all computed on demand — no background scanner):**
| rule | severity |
|---|---|
| run live > 30 min without a Stop (config `anomaly.longRunMin`) | warn |
| run ctx % > 80 (context nearly full — agent likely degrading) | warn |
| run cost > $10 (config `anomaly.costUsd`) | critical |
| task failed ≥ 2 times (repeat failures) | warn |
| task in review > 24 h (stale review) | warn |
| agent-filed drafts older than 7 d (nobody triaged) | warn |
| boot.recovery events in last 24 h (crashes/restarts mid-run) | warn |
| queued > 30 min while orchestrator enabled (starvation) | critical |
| depth-2 tasks present (max-depth chains — look at what agents are doing) | info→warn |

## 4. Dashboard page (new sidebar item, first position)

Layout per the `--tm-*` token system, information-design first (scan, don't read):
- **Stat tile row** (today + 7d): worked time, cost, runs, done/failed, avg ctx%.
- **Agents per day** — 14-day bar chart (runs/day, split worker vs analyze by color).
- **Cost per day** — 14-day bars with cumulative line.
- **Anomalies panel** — severity-striped list (critical first), each row deep-links to its task/run.
- **Provenance & depth** — human vs sentry vs agent-filed counts; depth ladder 0/1/2.
- **Per-repo table** — runs, cost, done/failed per registered repo.
- **Activity feed** — the last ~50 `tm_events`, filterable by kind/actor (this IS the "nothing untraced" surface).
- Charts hand-rolled SVG (no chart lib; follow the dataviz guidance at build time), theme-token colors, live-updating from `/ws/events` (recompute on task/run events, throttled).

## 5. Wiring points (implementation sketch)

- `transitionTask` stays pure; **callers** append events (they know the actor). Sites: routes/tasks.ts (human), routes/internal.ts (hook), routes/agent.ts (agent), orchestrator.ts (orchestrator/system/boot), sentry.ts, proposals accept/reject.
- Orchestrator overflow claims + spawn failures append `schedule.*` events.
- `run.stats-final` appended once at exit (not per 20s refresh).

## Review questions for the adversarial pass

1. Event-log write amplification: any hot path where appendEvent adds meaningful latency or lock contention (better-sqlite3 sync writes inside request handlers)? Should writes be fire-and-forget queued?
2. Actor attribution correctness: can a path mislabel (e.g. agent API create → task later transitioned by orchestrator — is the CREATE actor separate from TRANSITION actors)? Missing sites?
3. Anomaly rules: false-positive traps (long-run rule vs legitimately long tasks; stale-review vs user's actual workflow of leaving things in review)? Which rules need config knobs vs hardcoded?
4. Aggregation cost: overview query shape over months of data — index plan; does perDay need a covering index on tm_events.at or should aggregates come from tm_runs/tm_tasks directly (events only for actor/anomaly data)?
5. Dialect neutrality of the new DDL + queries (GROUP BY date bucketing differs: sqlite strftime vs pg to_char — how to keep SQL identical? compute buckets in JS from raw rows?).
6. Retention prune: safe to delete events for tasks that still exist? UI implications?
7. Is anything STILL untraced after this design (config changes? repo add/remove? handbook views — irrelevant? terminal attach/input events — privacy vs completeness)?
