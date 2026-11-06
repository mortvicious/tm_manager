// Dialect-neutral DDL: runs unchanged on bundled SQLite (>=3.35) and Postgres.
// All tables carry the fixed `tm_` prefix (see docs/decisions.md).

import { uniqueWorkspaceSlug } from '@tm/shared';

// One generation of the migration-12 group backfill: every row whose parent
// already has a group inherits it. Dialect-neutral (correlated subquery on the
// table being updated works on both SQLite and Postgres).
const BACKFILL_GENERATION = `UPDATE tm_tasks SET
    group_id = (SELECT p.group_id FROM tm_tasks p WHERE p.id = tm_tasks.parent_id),
    group_path = (SELECT p.group_path || p.id || '/' FROM tm_tasks p WHERE p.id = tm_tasks.parent_id)
  WHERE group_id IS NULL AND parent_id IS NOT NULL
    AND (SELECT p.group_id FROM tm_tasks p WHERE p.id = tm_tasks.parent_id) IS NOT NULL`;

/** Depth the backfill reaches. Real trees are 1-2 deep (split children, and
 *  agent follow-ups linked as siblings); 8 is slack, not a limit on new rows. */
const BACKFILL_GENERATIONS = 8;
export const MIGRATIONS: { id: number; statements: string[] }[] = [
  {
    id: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS tm_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tm_repos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        role TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tm_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        repo_id TEXT REFERENCES tm_repos(id),
        parent_id TEXT REFERENCES tm_tasks(id),
        status TEXT NOT NULL DEFAULT 'draft',
        source TEXT NOT NULL DEFAULT 'manual',
        source_ref TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        result_summary TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tm_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tm_tasks(id),
        repo_id TEXT,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        pid INTEGER,
        exit_code INTEGER,
        needs_attention INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        ended_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS tm_proposals (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        repo_id TEXT,
        task_id TEXT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS tm_tasks_status_idx ON tm_tasks(status)`,
      `CREATE INDEX IF NOT EXISTS tm_tasks_parent_idx ON tm_tasks(parent_id)`,
    ],
  },
  {
    id: 2,
    // per-task model/effort overrides + per-run session identity and usage stats
    statements: [
      `ALTER TABLE tm_tasks ADD COLUMN model TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN effort TEXT`,
      `ALTER TABLE tm_runs ADD COLUMN model TEXT`,
      `ALTER TABLE tm_runs ADD COLUMN effort TEXT`,
      `ALTER TABLE tm_runs ADD COLUMN session_id TEXT`,
      `ALTER TABLE tm_runs ADD COLUMN transcript_path TEXT`,
      `ALTER TABLE tm_runs ADD COLUMN stats TEXT`,
    ],
  },
  {
    id: 3,
    // task completed but PTY kept attachable: distinguishes "working" from
    // "idle terminal" in the Queue and silences idle-prompt notifications
    statements: [`ALTER TABLE tm_runs ADD COLUMN idle INTEGER NOT NULL DEFAULT 0`],
  },
  {
    id: 4,
    // Agent Task API (docs/agent-api-design.md): provenance + loop guards +
    // per-run auth tokens (design review R4/R5/R10)
    statements: [
      `ALTER TABLE tm_tasks ADD COLUMN created_by_run TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN spawn_depth INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE tm_runs ADD COLUMN run_token TEXT`,
    ],
  },
  {
    id: 5,
    // Append-only audit log (docs/dashboard-design.md): every mutation traced
    // with an actor. Time-sortable TEXT id; no FKs so events outlive deletions.
    statements: [
      `CREATE TABLE IF NOT EXISTS tm_events (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        task_id TEXT,
        run_id TEXT,
        repo_id TEXT,
        data TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS tm_events_at_idx ON tm_events(at)`,
      `CREATE INDEX IF NOT EXISTS tm_events_task_idx ON tm_events(task_id)`,
    ],
  },
  {
    id: 6,
    // free-text domain category ("UI", "Estimator", ...) — agents invent and
    // assign these themselves; humans can edit
    statements: [`ALTER TABLE tm_tasks ADD COLUMN category TEXT`],
  },
  {
    id: 7,
    // adversarial review of each worker's change (docs/decisions.md 2026-08-24)
    statements: [`ALTER TABLE tm_tasks ADD COLUMN review_summary TEXT`],
  },
  {
    id: 8,
    // per-task review override (null = use the review.enabled setting)
    statements: [`ALTER TABLE tm_tasks ADD COLUMN review INTEGER`],
  },
  {
    id: 9,
    // Feature interface (docs/future/feature-interface.md): a per-repo big
    // request that an analysis decomposes into ordered phases of tasks.
    // repo_id is nullable ON PURPOSE — deleteRepo nulls it, exactly as it does
    // for tm_tasks, so removing a repo never trips a foreign key.
    statements: [
      `CREATE TABLE IF NOT EXISTS tm_features (
        id TEXT PRIMARY KEY,
        repo_id TEXT REFERENCES tm_repos(id),
        title TEXT NOT NULL,
        request TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        analysis TEXT,
        review TEXT,
        analysis_rounds INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `ALTER TABLE tm_tasks ADD COLUMN feature_id TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN feature_phase INTEGER`,
      `CREATE INDEX IF NOT EXISTS tm_features_repo_idx ON tm_features(repo_id)`,
      `CREATE INDEX IF NOT EXISTS tm_tasks_feature_idx ON tm_tasks(feature_id)`,
    ],
  },
  {
    id: 10,
    // Session continuity ("proceed"): a run may CONTINUE the claude session of
    // an earlier run (`claude --resume`). Both runs then share one transcript,
    // so the resumed run stores the cumulative totals it inherited and reports
    // only the delta — otherwise every proceed double-counts cost/tokens.
    statements: [
      `ALTER TABLE tm_runs ADD COLUMN resumed_from TEXT`,
      `ALTER TABLE tm_runs ADD COLUMN stats_baseline TEXT`,
    ],
  },
  {
    id: 11,
    // Mobile emulator: per-repo dev-server URL framed in the floating window.
    // Scheme is validated at the API boundary (http/https only) — the column
    // itself is a plain TEXT so an existing row simply stays NULL.
    statements: [`ALTER TABLE tm_repos ADD COLUMN preview_url TEXT`],
  },
  {
    id: 12,
    // Task groups (docs/grouping.md): every task carries the id of its ROOT
    // ancestor plus the materialized path of ancestor ids to it, so a split
    // tree is one addressable, filterable, nameable group. Both columns stay
    // nullable in SQL (ALTER ADD COLUMN cannot backfill a NOT NULL) — the
    // drivers always write them and rowToTask falls back to "own root".
    // group_name / group_color are meaningful on the ROOT row only.
    statements: [
      `ALTER TABLE tm_tasks ADD COLUMN group_id TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN group_path TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN group_name TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN group_color INTEGER`,
      // Backfill generation by generation instead of a recursive CTE: bounded
      // iteration terminates even if a legacy row pair references each other
      // (nothing rejected a 2-cycle before this migration), where WITH
      // RECURSIVE would spin forever.
      `UPDATE tm_tasks SET group_id = id, group_path = '/' WHERE parent_id IS NULL`,
      ...Array.from({ length: BACKFILL_GENERATIONS }, () => BACKFILL_GENERATION),
      // Deeper than the bounded sweep, or inside a cycle: stand it up as its
      // own root rather than leaving a NULL group.
      `UPDATE tm_tasks SET group_id = id, group_path = '/' WHERE group_id IS NULL`,
      `CREATE INDEX IF NOT EXISTS tm_tasks_group_idx ON tm_tasks(group_id)`,
    ],
  },
  {
    id: 13,
    // Custom repo commands (docs/commands.md): saved command lines ("pnpm run
    // start:dev") a repo can run in a PTY on demand. `sort_order`, not `sort`
    // — a bare `sort` reads as a keyword in too many dialects to be worth it.
    // Runs are NOT stored: a PTY dies with the server (see CommandRun).
    statements: [
      `CREATE TABLE IF NOT EXISTS tm_commands (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES tm_repos(id),
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'task',
        cwd TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS tm_commands_repo_idx ON tm_commands(repo_id)`,
    ],
  },
  {
    id: 14,
    // Auto-publish (docs/publish.md): when the worker finishes, the same agent
    // session commits and pushes instead of parking the task in `review`.
    // A constant DEFAULT is the one form of NOT NULL that ALTER ADD COLUMN
    // accepts in BOTH dialects, so existing rows read as "off".
    statements: [`ALTER TABLE tm_tasks ADD COLUMN auto_publish INTEGER NOT NULL DEFAULT 0`],
  },
  {
    id: 15,
    // Dispatches (docs/dispatch.md): a message from one task's agent session
    // to a related task's session, delivered by resuming the target's own
    // claude session instead of creating a new task. No FKs on purpose — like
    // tm_events, a dispatch outlives the deletion of either task (delivery to
    // a deleted target settles it as failed, with the reason).
    statements: [
      `CREATE TABLE IF NOT EXISTS tm_dispatches (
        id TEXT PRIMARY KEY,
        from_task_id TEXT NOT NULL,
        from_run_id TEXT,
        to_task_id TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        note TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS tm_dispatches_to_idx ON tm_dispatches(to_task_id, status)`,
      `CREATE INDEX IF NOT EXISTS tm_dispatches_from_idx ON tm_dispatches(from_task_id)`,
    ],
  },
  {
    id: 16,
    // Custom queue (docs/queue.md): a nullable timestamp doubles as membership
    // flag and FIFO position, so no default is needed and every existing row
    // reads as "not in the custom queue".
    statements: [`ALTER TABLE tm_tasks ADD COLUMN custom_queue_at TEXT`],
  },
  {
    id: 17,
    // sha256 of the `git diff HEAD` the last adversarial review actually read.
    // A Stop whose diff hashes the same has nothing new to review, so the
    // headless reviewer is skipped entirely (docs/design.md § Adversarial
    // review). NULL on every existing row = "never reviewed", which reviews.
    statements: [`ALTER TABLE tm_tasks ADD COLUMN review_diff_hash TEXT`],
  },
  {
    id: 18,
    // Dispatch intent (docs/dispatch.md § Intent): `needs_action` may wake the
    // target's session, `fyi` may not — it rides along on the next resume that
    // happens for a real reason. Defaulting to 'needs_action' makes every
    // existing row keep exactly the behaviour it was created under.
    statements: [`ALTER TABLE tm_dispatches ADD COLUMN intent TEXT NOT NULL DEFAULT 'needs_action'`],
  },
  {
    id: 19,
    // Chat (docs/chat.md): a free-form conversation with claude in a repo's
    // working directory, shared by the SPA and the phone. FK-less like
    // tm_events and tm_dispatches — a chat's messages are deleted explicitly
    // by deleteChat, and a repo that goes away leaves its chats readable
    // rather than taking the transcript with it.
    //
    // `session_id` is claude's own, captured from the first turn's result
    // envelope; NULL means "no turn has landed yet", which is what makes turn
    // one the one that carries no --resume. `status` is the serialisation
    // lock: beginChatTurn flips idle -> thinking conditionally, so two
    // surfaces sending at once cannot put two children on one session.
    statements: [
      `CREATE TABLE IF NOT EXISTS tm_chats (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT,
        mode TEXT NOT NULL DEFAULT 'read',
        session_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        error TEXT,
        turns INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_message_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS tm_chats_repo_idx ON tm_chats(repo_id)`,
      `CREATE TABLE IF NOT EXISTS tm_chat_messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        actor TEXT NOT NULL,
        error TEXT,
        cost_usd REAL NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      )`,
      // id is the time-sortable eventId(), so (chat_id, id) is the read order
      // AND the pagination key — no created_at tiebreak needed inside a ms.
      `CREATE INDEX IF NOT EXISTS tm_chat_messages_chat_idx ON tm_chat_messages(chat_id, id)`,
    ],
  },
  {
    id: 20,
    // The pid of a chat's running turn (docs/chat.md § Crash recovery). A chat
    // owns no tm_runs row, so the orchestrator's boot pid sweep cannot see its
    // child — and the child is spawned detached, so a crash leaves it alive.
    // NULL on every existing row, which reads correctly as "no turn running".
    statements: [`ALTER TABLE tm_chats ADD COLUMN pid INTEGER`],
  },
  {
    id: 21,
    // When the 5h usage window has to reset before this task's own claude
    // session can carry on (docs/wake.md). ISO time; the orchestrator resumes
    // the task at it and clears the column. NULL on every existing row, which
    // reads correctly as "not waiting on anything".
    statements: [`ALTER TABLE tm_tasks ADD COLUMN wake_at TEXT`],
  },
  {
    id: 22,
    // Where the adversarial review of the task's current change stands, and
    // every round it received (JSON array of ReviewRound). NULL reads as "not
    // auto-reviewed" / "no rounds" on existing rows — the previous behaviour.
    statements: [
      `ALTER TABLE tm_tasks ADD COLUMN review_state TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN review_rounds TEXT`,
    ],
  },
  {
    id: 23,
    // Questions (docs/questions.md): a worker's AskUserQuestion call, parked
    // while its session waits inside the PreToolUse hook for a human answer.
    // No FKs on purpose — like tm_events and tm_dispatches, the row is the
    // record of what was asked and decided, and it outlives the task. JSON
    // columns: `questions` (the CLI's own array, verbatim) and `answers`
    // (keyed by question text, the shape the tool takes back).
    statements: [
      `CREATE TABLE IF NOT EXISTS tm_questions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        tool_use_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        questions TEXT NOT NULL,
        answers TEXT,
        answered_by TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS tm_questions_run_idx ON tm_questions(run_id, status)`,
      `CREATE INDEX IF NOT EXISTS tm_questions_task_idx ON tm_questions(task_id, status)`,
      // the hook re-sends its call every minute; one row per call, even when
      // two re-sends overlap (curl's 75s timeout racing a slow server)
      `CREATE UNIQUE INDEX IF NOT EXISTS tm_questions_tool_idx ON tm_questions(run_id, tool_use_id)`,
    ],
  },
  {
    id: 24,
    // Reports (docs/reports.md): a work-summary document over several repos and
    // a date range. FK-less like tm_events and tm_questions — the document is a
    // record of what was delivered in a window and must outlive the repo rows
    // it names. `repo_ids` is a JSON array (a report is multi-repo by
    // definition, so there is no single repo_id column to hang an FK on).
    //
    // The index is the other half: a report asks tm_tasks for a WINDOW, and
    // without it a month-wide report scans the whole table. `updated_at` is
    // what both bounds of TaskFilter compare against.
    statements: [
      `CREATE TABLE IF NOT EXISTS tm_reports (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        repo_ids TEXT NOT NULL,
        from_date TEXT NOT NULL,
        to_date TEXT NOT NULL,
        preset TEXT NOT NULL DEFAULT 'custom',
        language TEXT NOT NULL DEFAULT 'ru',
        status TEXT NOT NULL DEFAULT 'pending',
        markdown TEXT,
        summary TEXT,
        task_count INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS tm_reports_created_idx ON tm_reports(created_at)`,
      `CREATE INDEX IF NOT EXISTS tm_tasks_updated_idx ON tm_tasks(updated_at)`,
    ],
  },
  {
    id: 25,
    // Per-task reviewer (docs/design.md § Adversarial review): which model (and
    // effort) runs the adversarial review of THIS task's change. NULL reads as
    // "use the global review.model" — the previous behaviour on existing rows.
    statements: [
      `ALTER TABLE tm_tasks ADD COLUMN review_model TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN review_effort TEXT`,
    ],
  },
  {
    id: 26,
    // Manual task order (docs/grouping.md § Order): the board's drag-to-reorder
    // and the global claim's tiebreaker after priority. DOUBLE PRECISION, not
    // REAL — REAL is float4 on Postgres, which runs out of midpoints after a
    // handful of drags (SQLite reads the name as REAL affinity, a double).
    // The backfill ranks existing rows by creation (id breaks a tie), so every
    // sibling set keeps the order it had before anything is dragged.
    statements: [
      `ALTER TABLE tm_tasks ADD COLUMN sort_order DOUBLE PRECISION NOT NULL DEFAULT 0`,
      `UPDATE tm_tasks SET sort_order = 1 + (SELECT COUNT(*) FROM tm_tasks o
          WHERE o.created_at < tm_tasks.created_at
             OR (o.created_at = tm_tasks.created_at AND o.id < tm_tasks.id))`,
    ],
  },
  {
    id: 27,
    // Opus 5.5 (user decision 2026-09-23): the opus TIER moves to the newer
    // point release, so a stored `claude-opus-5` is repointed rather than left
    // behind. This is a deliberate exception to the "existing installs keep
    // whatever tm_config holds" policy of the 2026-09-03 Fable-5.1 entry: 5.1
    // was an ADDITIONAL option beside a model the user had chosen between,
    // while 5.5 supersedes a tier they only ever chose as "opus".
    //
    // Values are JSON (getSettings JSON.parse()s them), so the literal carries
    // its quotes. Scoped to the model KEYS by name, never `WHERE value = ...`
    // alone — no unrelated setting can ever be rewritten by a value collision.
    // tm_tasks.model / review_model are deliberately NOT touched: a per-task
    // pin records what actually ran on work that may already be published, and
    // rewriting it would re-date history and misprice the cost chip.
    statements: [
      `UPDATE tm_config SET value = '"claude-opus-5-5"'
        WHERE value = '"claude-opus-5"'
          AND key IN ('agent.model', 'analysis.model', 'orchestrator.model',
                      'review.model', 'router.primaryModel', 'router.fallbackModel',
                      'chat.model')`,
    ],
  },
  {
    id: 28,
    // Every claude this server spawns is a terminal now (docs/decisions.md
    // 2026-09-24, "Headless is retired"): review, plan, plan-review, analysis,
    // compact, report, chat and commit-message sessions are `mode = 'aux'`
    // rows in the SAME table, told apart by `kind`. `subject_id` names what
    // the session is about — a task for review/compact, a feature for
    // plan/plan-review, a chat, a report, a repo for analysis/commit — and
    // `task_id` stays NULL on purpose: every worker rule keyed on
    // `tm_runs.task_id` (the stop hook's newer-run guard, resumable-session
    // lookup, the task's latest run, per-task cost) must never see a
    // reviewer as the task's agent. `label` is what the runs list shows.
    // The legacy 'analyze' rows (analysis and the feature pipeline, which
    // shared one mode) become 'aux'/'analysis'.
    statements: [
      `ALTER TABLE tm_runs ADD COLUMN kind TEXT`,
      `ALTER TABLE tm_runs ADD COLUMN subject_id TEXT`,
      `ALTER TABLE tm_runs ADD COLUMN label TEXT`,
      `UPDATE tm_runs SET mode = 'aux', kind = 'analysis' WHERE mode = 'analyze'`,
      `CREATE INDEX IF NOT EXISTS tm_runs_subject_idx ON tm_runs (subject_id)`,
    ],
  },
  {
    id: 29,
    // The reviewer reads the change THIS task made, committed or not
    // (docs/decisions.md 2026-09-24, "The reviewer reads the task's commits"):
    // the HEAD sha + branch when the task's first worker run spawned, and
    // when. Set once, never moved by a retry or fix round.
    statements: [
      `ALTER TABLE tm_tasks ADD COLUMN base_sha TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN base_ref TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN base_at TEXT`,
    ],
  },
  {
    id: 30,
    // Shared spaces (docs/shared-spaces.md): a set of repos sharing one
    // knowledge folder on disk and a ledger of cross-repo requests/notes that
    // every member's worker reads at the start of a turn. FK-less like
    // tm_events/tm_dispatches: a note outlives the task that wrote it, and a
    // deleted repo leaves its id in `repo_ids`, filtered on read.
    statements: [
      `CREATE TABLE IF NOT EXISTS tm_spaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        repo_ids TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tm_shared_notes (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        from_repo_id TEXT,
        from_task_id TEXT,
        to_repo_id TEXT,
        status TEXT NOT NULL,
        task_id TEXT,
        resolution TEXT,
        files TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS tm_shared_notes_space_idx ON tm_shared_notes (space_id, status)`,
      `CREATE INDEX IF NOT EXISTS tm_shared_notes_to_idx ON tm_shared_notes (to_repo_id, status)`,
      `CREATE INDEX IF NOT EXISTS tm_shared_notes_task_idx ON tm_shared_notes (task_id)`,
    ],
  },
  {
    id: 31,
    // "Undo start" (docs/queue.md § Undo start): a running task sent back to
    // `queued` keeps its place but no claim may take it until the human
    // releases it — otherwise the queue would restart it on the next pass.
    statements: [`ALTER TABLE tm_tasks ADD COLUMN queue_held_at TEXT`],
  },
  {
    id: 32,
    // Web Push devices (docs/push.md): one row per subscribed browser, keyed on
    // the push service's endpoint. FK-less like tm_events; `kinds` is a JSON
    // array of PushKind — what this device wants to be pinged about.
    statements: [
      `CREATE TABLE IF NOT EXISTS tm_push_devices (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        label TEXT NOT NULL,
        kinds TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_ok_at TEXT,
        last_error TEXT,
        fail_count INTEGER NOT NULL DEFAULT 0
      )`,
    ],
  },
  {
    id: 33,
    // Budget fuses (docs/token-budget.md § Fuses). `tm_runs.cost_usd` is
    // `stats.costUsd` lifted out of the JSON so both dialects can SUM it with
    // the same SQL (the day fuse, the task roll-up); `tm_tasks.cost_usd` is
    // that roll-up kept on the row (worker runs + review/compact aux runs
    // about the task), rewritten by `updateRun` whenever a run's stats move.
    // Existing rows are backfilled in JS by each driver right after this
    // migration (`backfillCosts`) — JSON extraction is not dialect-neutral.
    // tm_runs had no task_id index; the roll-up and the per-task run reads
    // both want one.
    statements: [
      `ALTER TABLE tm_runs ADD COLUMN cost_usd DOUBLE PRECISION`,
      `ALTER TABLE tm_tasks ADD COLUMN cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0`,
      `CREATE INDEX IF NOT EXISTS tm_runs_task_idx ON tm_runs (task_id)`,
      `CREATE INDEX IF NOT EXISTS tm_runs_started_idx ON tm_runs (started_at)`,
    ],
  },
  {
    id: 34,
    // Repo checks + the verify loop (docs/checks.md). A check is a saved repo
    // command flagged `is_check`, with its own timeout (NULL = the default);
    // a task carries its definition of done (`acceptance`), which checks
    // apply (`checks`, JSON array of names, NULL = all), and where the checks
    // of its current change stand (`check_state`, `check_results` JSON, and
    // `check_diff_hash` — the change the results belong to, so a talk-only
    // turn does not re-run green checks).
    statements: [
      `ALTER TABLE tm_commands ADD COLUMN is_check INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE tm_commands ADD COLUMN timeout_sec INTEGER`,
      `ALTER TABLE tm_tasks ADD COLUMN acceptance TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN checks TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN check_state TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN check_results TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN check_diff_hash TEXT`,
    ],
  },
  {
    id: 35,
    // Attempts (docs/design.md § Retry with context): fresh worker sessions
    // the task has had, bumped by `bumpTaskAttempts` on every spawn that is
    // not a resume. Backfilled from the runs that carry no `resumed_from`
    // lineage — exact for every fresh start, and a resume gate's `fresh`
    // handoff (which records no lineage either) counts too, as it does live.
    statements: [
      `ALTER TABLE tm_tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`,
      `UPDATE tm_tasks SET attempts = (SELECT COUNT(*) FROM tm_runs r WHERE r.task_id = tm_tasks.id AND r.mode = 'worker' AND r.resumed_from IS NULL)`,
    ],
  },
  {
    id: 36,
    // Landing tiers (docs/design.md § Landing tiers): a per-repo tier, a
    // per-task override (null = the repo's) and the stamp of an orchestrator
    // landing. They replace two flags: the per-task `auto_publish` (carried
    // over as the task's `auto-publish` override; the column stays, unread)
    // and the global `orchestrator.autoComplete` setting (removed — a stored
    // `true` puts every repo on `on-green`, the tier it was the narrow form of).
    statements: [
      `ALTER TABLE tm_repos ADD COLUMN landing TEXT NOT NULL DEFAULT 'supervised'`,
      `ALTER TABLE tm_tasks ADD COLUMN landing TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN auto_landed_at TEXT`,
      // an external task never lands above supervised (isExternalTask): its old flag is dropped, not carried
      `UPDATE tm_tasks SET landing = 'auto-publish' WHERE auto_publish = 1 AND source IN ('manual', 'feature') AND created_by_run IS NULL`,
      `UPDATE tm_repos SET landing = 'on-green' WHERE EXISTS (SELECT 1 FROM tm_config WHERE key = 'orchestrator.autoComplete' AND value = 'true')`,
      `DELETE FROM tm_config WHERE key = 'orchestrator.autoComplete'`,
    ],
  },
  {
    id: 37,
    // Loop tasks (docs/loops.md): `kind` ('task' | 'loop'), the loop's goal,
    // iteration bound and USD ceiling, and where it stands — iterations
    // started, `loop_state` (no new task status: between iterations the task
    // stays `running`) and the per-iteration history (JSON). The checks
    // subset is the existing `checks` column.
    statements: [
      `ALTER TABLE tm_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'`,
      `ALTER TABLE tm_tasks ADD COLUMN loop_goal TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN loop_max_iterations INTEGER`,
      `ALTER TABLE tm_tasks ADD COLUMN loop_budget_usd DOUBLE PRECISION`,
      `ALTER TABLE tm_tasks ADD COLUMN loop_iteration INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE tm_tasks ADD COLUMN loop_state TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN loop_history TEXT`,
    ],
  },
  {
    id: 38,
    // Hidden tasks (docs/design.md § Hidden tasks): ISO time the human hid
    // the task, null = visible. A board-only flag — no claim reads it — and
    // every status transition clears it.
    statements: [`ALTER TABLE tm_tasks ADD COLUMN hidden_at TEXT`],
  },
  {
    id: 39,
    // Agent brief (docs/agent-api-design.md § Title and brief): the filing agent's short
    // "what will be done" for the human, written before any work. Required on
    // the agent create/file routes; null on every other task.
    statements: [`ALTER TABLE tm_tasks ADD COLUMN brief TEXT`],
  },
  {
    id: 40,
    // Pause all (docs/pause.md): the turn Continue owes this task, as JSON
    // (`PausedTurn`), null = nothing owed. Holds the task's repo in the claim
    // gates (queue-sql.ts) and is cleared by every status transition.
    statements: [`ALTER TABLE tm_tasks ADD COLUMN paused_turn TEXT`],
  },
  {
    id: 41,
    // Push policy (docs/publish.md § Push policy): what worker turns are told
    // about `git push` when no review holds the ship. The default is the
    // behaviour before the column existed: no rule, the repo's CLAUDE.md decides.
    statements: [`ALTER TABLE tm_repos ADD COLUMN push_policy TEXT NOT NULL DEFAULT 'repo-rules'`],
  },
  {
    id: 42,
    // Question autopilot (docs/questions.md § Autopilot): minutes a worker's
    // question waits before the server picks its Recommended option. NULL is
    // off, the default — the behaviour before the column existed.
    statements: [`ALTER TABLE tm_repos ADD COLUMN question_autopilot_minutes INTEGER`],
  },
  {
    id: 43,
    // Observed publish (docs/publish.md § Observed publish): the task's newest
    // commit, seen on a remote when its work turn landed — what offers "Mark
    // published" on a supervised task. Cleared by any move off review/done/
    // published, so it always describes the CURRENT landing.
    statements: [`ALTER TABLE tm_tasks ADD COLUMN shipped_sha TEXT`, `ALTER TABLE tm_tasks ADD COLUMN shipped_at TEXT`],
  },
  {
    id: 44,
    // Stale drafts (docs/inbox.md § Stale drafts): ISO time a "Keep" on the
    // Inbox's stale-draft row expires — until then the draft is off that list
    // (it stays on the board). Written only by keepTaskInInbox, cleared by
    // every status transition.
    statements: [`ALTER TABLE tm_tasks ADD COLUMN inbox_kept_until TEXT`],
  },
  {
    id: 45,
    // Agent-owned commands (docs/commands.md § Agent-owned commands): the task
    // whose agent saved the command (null = a human's, never cleaned up), the
    // time the cleanup archived it (hidden from the launcher, restorable), and
    // the last start, which the "unused for N days" rule reads. Owners of rows
    // saved before this migration are backfilled in JS (`commandOwnerBackfill`)
    // from the `command.changed` audit rows — JSON extraction is not
    // dialect-neutral.
    statements: [
      `ALTER TABLE tm_commands ADD COLUMN owner_task_id TEXT`,
      `ALTER TABLE tm_commands ADD COLUMN archived_at TEXT`,
      `ALTER TABLE tm_commands ADD COLUMN last_run_at TEXT`,
    ],
  },
  {
    id: 46,
    // Parallel same-repo tasks (docs/parallel.md): a repo's parallel cap
    // (1 = today's exclusivity) and delivery (`direct` = today; `pr` = every
    // task works in its own server-managed git worktree on `tm/<task8>`, the
    // server opens a draft PR and lands by local squash + fast-forward push),
    // the setup command run in a new worktree and the untracked files copied
    // into it (JSON array, null = the defaults). On the task: the worktree
    // directory (kept after eviction — the session's cwd, re-created at the
    // same path), its branch, its PR, and when the directory was evicted.
    statements: [
      `ALTER TABLE tm_repos ADD COLUMN parallel INTEGER NOT NULL DEFAULT 1`,
      `ALTER TABLE tm_repos ADD COLUMN delivery TEXT NOT NULL DEFAULT 'direct'`,
      `ALTER TABLE tm_repos ADD COLUMN worktree_setup TEXT`,
      `ALTER TABLE tm_repos ADD COLUMN worktree_copy TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN workdir TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN branch TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN pr_number INTEGER`,
      `ALTER TABLE tm_tasks ADD COLUMN pr_url TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN pr_state TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN worktree_evicted_at TEXT`,
    ],
  },
  {
    id: 47,
    // Base branch (docs/parallel.md § Base branch): the branch a `pr` repo's
    // worktrees fork from, its PRs target and its lands push to (null = the
    // remote default, origin/HEAD), and on the task the base its worktree was
    // forked from / last moved onto, so a changed base moves the branch once.
    statements: [
      `ALTER TABLE tm_repos ADD COLUMN base_branch TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN worktree_base TEXT`,
    ],
  },
  {
    id: 48,
    // Approvals (docs/approvals.md): a human-only action an agent requested
    // (push a ref, mark published, rebuild & restart, sync a local branch),
    // run by the server once the human approves it. FK-less like tm_questions:
    // the row is the record of what was asked, decided and done. `params` is
    // the JSON of exactly what runs. On the repo, the actions it pre-approves
    // (JSON array, null = none).
    statements: [
      `CREATE TABLE IF NOT EXISTS tm_approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        run_id TEXT NOT NULL,
        repo_id TEXT,
        action TEXT NOT NULL,
        params TEXT NOT NULL,
        summary TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        decided_by TEXT,
        result TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        finished_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS tm_approvals_status_idx ON tm_approvals(status, created_at)`,
      `CREATE INDEX IF NOT EXISTS tm_approvals_task_idx ON tm_approvals(task_id, status)`,
      `ALTER TABLE tm_repos ADD COLUMN auto_approve TEXT`,
      // a device that is pinged about questions is pinged about approvals too —
      // both are an agent waiting on the human (kinds is a JSON array of strings)
      `UPDATE tm_push_devices SET kinds = REPLACE(kinds, '"question"', '"question","approval"') WHERE kinds LIKE '%"question"%' AND kinds NOT LIKE '%"approval"%'`,
    ],
  },
  {
    id: 49,
    // Workspaces (docs/workspaces.md): a named, scoped view over a set of
    // repos — no folder, no ledger, a repo may be in many. FK-less like
    // tm_spaces: `repo_ids` is a JSON array filtered against tm_repos on read,
    // so deleting a repo never has to touch a workspace. `color` is a group
    // palette slot (null = none). Each existing shared space is seeded as one
    // workspace in JS (`workspaceSeedRows`) in the same transaction — once,
    // so a seeded workspace the human deletes stays deleted.
    statements: [
      `CREATE TABLE IF NOT EXISTS tm_workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        repo_ids TEXT NOT NULL,
        color INTEGER,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS tm_workspaces_slug_idx ON tm_workspaces (slug)`,
    ],
  },
  {
    id: 50,
    // Timeline (docs/timeline.md): `/api/timeline` reads a window of the audit
    // log by repo scope and by kind — neither had an index (only `at` and
    // `task_id`), so a 31-day window scanned every row since.
    statements: [
      `CREATE INDEX IF NOT EXISTS tm_events_repo_at_idx ON tm_events(repo_id, at)`,
      `CREATE INDEX IF NOT EXISTS tm_events_kind_at_idx ON tm_events(kind, at)`,
    ],
  },
  {
    id: 51,
    // Task waits + declared dependencies (docs/task-waits.md): `wait_for` is
    // the JSON `TaskWait` of a worker parked `blocked` on another task (cleared
    // by every transition); `depends_on` a JSON array of task ids the claim
    // gate (`DEPENDS_ON_GATE`) waits on. Both FK-less like the rest.
    statements: [
      `ALTER TABLE tm_tasks ADD COLUMN wait_for TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN depends_on TEXT`,
    ],
  },
  {
    id: 52,
    // Scheduled jobs (docs/jobs.md): deferred checks fired by the server as
    // aux terminals (kind 'job'). Jobs are NOT tasks. FK-less like tm_events:
    // `context` is a JSON snapshot of the filer taken at create time, so a
    // deleted task loses nothing. `repeat_every_ms` is DOUBLE PRECISION
    // because 180 days in ms overflows a pg INTEGER and float8 reads back as a
    // number (BIGINT would read as a string). One `tm_job_runs` row per
    // firing: the verdict, findings and the human's acknowledgement.
    statements: [
      `CREATE TABLE IF NOT EXISTS tm_jobs (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL,
        context TEXT,
        source TEXT NOT NULL,
        created_by_run TEXT,
        created_by_task TEXT,
        status TEXT NOT NULL,
        next_run_at TEXT,
        repeat_every_ms DOUBLE PRECISION,
        repeat_until TEXT,
        max_runs INTEGER,
        runs_count INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        effort TEXT,
        last_run_id TEXT,
        last_verdict TEXT,
        last_summary TEXT,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS tm_jobs_due_idx ON tm_jobs(status, next_run_at)`,
      `CREATE INDEX IF NOT EXISTS tm_jobs_repo_idx ON tm_jobs(repo_id, status)`,
      `CREATE INDEX IF NOT EXISTS tm_jobs_task_idx ON tm_jobs(created_by_task)`,
      `CREATE TABLE IF NOT EXISTS tm_job_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        run_id TEXT,
        run_number INTEGER NOT NULL,
        fired_by TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        verdict TEXT,
        summary TEXT,
        findings TEXT,
        follow_ups TEXT,
        report_path TEXT,
        error TEXT,
        acknowledged_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS tm_job_runs_job_idx ON tm_job_runs(job_id, started_at)`,
      `CREATE INDEX IF NOT EXISTS tm_job_runs_open_idx ON tm_job_runs(verdict, acknowledged_at)`,
      // a device pinged about failures is pinged about jobs that found something too
      `UPDATE tm_push_devices SET kinds = REPLACE(kinds, '"failed"', '"failed","job"') WHERE kinds LIKE '%"failed"%' AND kinds NOT LIKE '%"job"%'`,
    ],
  },
  {
    id: 53,
    // Virtual Office (docs/office.md § Data model). FK-less like tm_events and
    // tm_workspaces: an office names its workspace, a role its office, a shift
    // both, by id only — deleting a workspace never has to touch an office and
    // a shift row outlives the role it ran for (it is history). ONE office per
    // workspace (unique index). Money is DOUBLE PRECISION (pg REAL is float4),
    // flags are INTEGER 0/1 like tm_runs.needs_attention, lists are JSON TEXT.
    // `paused_at`/`paused_reason` are written only by the conditional
    // `pauseOffice`; `budget_tripped_on` is the office-local day the day budget
    // tripped. A role's `notes_tainted_at`, `session_id`, `session_tainted`
    // carry the taint model (`mayResume`).
    statements: [
      `CREATE TABLE IF NOT EXISTS tm_offices (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        folder_path TEXT NOT NULL,
        autonomy TEXT NOT NULL DEFAULT 'proposals',
        day_budget_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        max_slots INTEGER NOT NULL DEFAULT 1,
        max_tasks_per_shift INTEGER NOT NULL DEFAULT 3,
        max_open_tasks INTEGER NOT NULL DEFAULT 10,
        paused_at TEXT,
        paused_reason TEXT,
        budget_tripped_on TEXT,
        theme TEXT,
        timezone TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS tm_offices_workspace_idx ON tm_offices (workspace_id)`,
      `CREATE TABLE IF NOT EXISTS tm_office_roles (
        id TEXT PRIMARY KEY,
        office_id TEXT NOT NULL,
        preset TEXT,
        role_key TEXT NOT NULL,
        name TEXT NOT NULL,
        avatar TEXT NOT NULL,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT,
        tools TEXT NOT NULL,
        autonomy TEXT,
        cap_usd DOUBLE PRECISION,
        schedules TEXT NOT NULL,
        triggers TEXT NOT NULL,
        guards TEXT NOT NULL,
        notes_path TEXT NOT NULL,
        notes_tainted_at TEXT,
        session_id TEXT,
        session_tainted INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS tm_office_roles_key_idx ON tm_office_roles (office_id, role_key)`,
      `CREATE TABLE IF NOT EXISTS tm_office_shifts (
        id TEXT PRIMARY KEY,
        office_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        trigger_kind TEXT NOT NULL,
        trigger_ref TEXT,
        trigger_at TEXT NOT NULL,
        verdict TEXT NOT NULL,
        skip_reason TEXT,
        run_id TEXT,
        cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        tainted INTEGER NOT NULL DEFAULT 0,
        taint_sources TEXT NOT NULL,
        brief_id TEXT,
        filed_task_ids TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        error TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS tm_office_shifts_office_idx ON tm_office_shifts (office_id, started_at)`,
      `CREATE INDEX IF NOT EXISTS tm_office_shifts_role_idx ON tm_office_shifts (role_id, started_at)`,
      `CREATE INDEX IF NOT EXISTS tm_office_shifts_run_idx ON tm_office_shifts (run_id)`,
    ],
  },
  {
    id: 54,
    // Office tasks (docs/office.md § Data model): which office and role filed
    // a task, and when its shift was tainted. Create-only — `updateTask`
    // writes neither (its column list is explicit). Any `office_id` makes the
    // task external (`isExternalTask`), so it never lands above supervised.
    statements: [
      `ALTER TABLE tm_tasks ADD COLUMN office_id TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN role_id TEXT`,
      `ALTER TABLE tm_tasks ADD COLUMN tainted_at TEXT`,
      `CREATE INDEX IF NOT EXISTS tm_tasks_office_idx ON tm_tasks (office_id)`,
    ],
  },
  {
    id: 55,
    // Shift filing (docs/office.md § Filing): what a shift's `tasks` section
    // became beyond the filed ids — the status, the note, the requests held
    // under proposals autonomy and the ones dropped by a cap (JSON
    // `OfficeShiftFiling`; NULL = no tasks asked for). The office caps' new
    // defaults (8 per shift, 12 open) are written by the insert, which always
    // names both columns, so the column DEFAULTs of migration 53 are never read.
    statements: [`ALTER TABLE tm_office_shifts ADD COLUMN filing TEXT`],
  },
  {
    id: 56,
    // Shift command runs (docs/office.md § Command runs): a role's allowlist
    // of saved commands (JSON `OfficeRoleCommand[]`, written only by the
    // Origin-gated `PUT …/commands` route) and what a shift's `commands`
    // section became — requests, dropped ids, each run's exit code and tail,
    // the command-done wake (JSON `OfficeShiftCommands`; NULL = none asked for).
    statements: [
      `ALTER TABLE tm_office_roles ADD COLUMN command_ids TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE tm_office_shifts ADD COLUMN commands TEXT`,
    ],
  },
  {
    id: 57,
    // The office scheduler (docs/office.md § Scheduler and states): a role's
    // `armed_at` is when its schedule started counting (created, enabled,
    // schedules changed, office enabled) — slots before it never fire, and it
    // is persisted so a restart does not re-arm and cancel a catch-up. Existing
    // roles count from their creation. A skipped shift's `skip_code` is the
    // gate's code (`guard`, a hard-gate code, a runner refusal), so the role
    // card can tell a guard skip from a pause it already shows.
    statements: [
      `ALTER TABLE tm_office_roles ADD COLUMN armed_at TEXT`,
      `UPDATE tm_office_roles SET armed_at = created_at WHERE armed_at IS NULL`,
      `ALTER TABLE tm_office_shifts ADD COLUMN skip_code TEXT`,
      `CREATE INDEX IF NOT EXISTS tm_office_shifts_role_trigger_idx ON tm_office_shifts (role_id, trigger_kind, started_at)`,
    ],
  },
  {
    id: 58,
    // Office briefings, proposals, wishes (docs/office.md § Data model, phase
    // 3). FK-less like the rest of the office: a brief/proposal names its
    // office, role and shift by id and outlives them (history). A brief's text
    // is a file in the office folder (`path`); the row is the index. A
    // proposal's `status` moves only through the conditional `decideProposal`
    // (pending → accepted|rejected), so a second decision is a no-op. Both
    // carry `tainted_at` (the shift's taint) and `reviewed_at` (`markReviewed`).
    // `tm_features.office_id`/`tainted_at`: a Director's cross-repo feature,
    // create-only like the task columns of migration 54.
    statements: [
      `CREATE TABLE IF NOT EXISTS tm_office_briefs (
        id TEXT PRIMARY KEY,
        office_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        shift_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        summary TEXT NOT NULL,
        tainted_at TEXT,
        reviewed_at TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS tm_office_briefs_office_idx ON tm_office_briefs (office_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS tm_office_briefs_shift_idx ON tm_office_briefs (shift_id)`,
      `CREATE TABLE IF NOT EXISTS tm_office_proposals (
        id TEXT PRIMARY KEY,
        office_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        shift_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        repo_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        tainted_at TEXT,
        reviewed_at TEXT,
        decided_at TEXT,
        decided_by TEXT,
        filed_task_id TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS tm_office_proposals_office_idx ON tm_office_proposals (office_id, status, created_at)`,
      `CREATE INDEX IF NOT EXISTS tm_office_proposals_shift_idx ON tm_office_proposals (shift_id)`,
      `CREATE TABLE IF NOT EXISTS tm_office_wishes (
        id TEXT PRIMARY KEY,
        office_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS tm_office_wishes_office_idx ON tm_office_wishes (office_id, status, created_at)`,
      `ALTER TABLE tm_features ADD COLUMN office_id TEXT`,
      `ALTER TABLE tm_features ADD COLUMN tainted_at TEXT`,
      `CREATE INDEX IF NOT EXISTS tm_features_office_idx ON tm_features (office_id)`,
    ],
  },
  {
    id: 59,
    // Office proposals as Inbox decisions (docs/office.md § Proposals): the
    // columns migration 58's `tm_office_proposals` needs once shifts write
    // it — `workspace_id` (the office's workspace at creation, the Inbox
    // scope of a repo-less row), `run_id` (the shift's aux run), `origin`
    // (`proposal` = the `proposals` section, `task` = a `tasks` request under
    // proposals autonomy), `category`/`effort` (carried onto the accepted
    // task) and `note` (a reject's reason). The pending index serves the Inbox
    // and the per-office pending cap. Web Push reuses the `proposal` kind.
    statements: [
      `ALTER TABLE tm_office_proposals ADD COLUMN workspace_id TEXT`,
      `ALTER TABLE tm_office_proposals ADD COLUMN run_id TEXT`,
      `ALTER TABLE tm_office_proposals ADD COLUMN origin TEXT`,
      `ALTER TABLE tm_office_proposals ADD COLUMN category TEXT`,
      `ALTER TABLE tm_office_proposals ADD COLUMN effort TEXT`,
      `ALTER TABLE tm_office_proposals ADD COLUMN note TEXT`,
      `CREATE INDEX IF NOT EXISTS tm_office_proposals_status_idx ON tm_office_proposals (status, created_at)`,
    ],
  },
  {
    id: 60,
    // Office comms and signals (docs/office.md § Data model, phase 4). FK-less
    // like the rest of the office. A message's `from_role_id` NULL = the
    // stakeholder, `to_role_id` NULL = the channel; it is routed once, by the
    // conditional `routeMessage` (`routed_at IS NULL`). A huddle's `turns`
    // grows only through the conditional `stepHuddle` (open AND turns <
    // max_turns) and it closes once (`closeHuddle`, open → decided|expired).
    // A signal is unique per `(source, external_id)`, so a re-delivered
    // webhook is one row (`appendSignal` = INSERT … ON CONFLICT DO NOTHING),
    // and consumed once (`consumeSignal`). `tm_chats.office_id`/`participants`
    // make a chat an office group chat (participants = role ids, JSON).
    statements: [
      `CREATE TABLE IF NOT EXISTS tm_office_messages (
        id TEXT PRIMARY KEY,
        office_id TEXT NOT NULL,
        from_role_id TEXT,
        to_role_id TEXT,
        kind TEXT NOT NULL,
        subject_kind TEXT,
        subject_id TEXT,
        body TEXT NOT NULL,
        tainted_at TEXT,
        reviewed_at TEXT,
        routed_at TEXT,
        routed_task_id TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS tm_office_messages_office_idx ON tm_office_messages (office_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS tm_office_messages_to_idx ON tm_office_messages (office_id, to_role_id, routed_at)`,
      `CREATE INDEX IF NOT EXISTS tm_office_messages_subject_idx ON tm_office_messages (subject_kind, subject_id)`,
      `CREATE TABLE IF NOT EXISTS tm_office_huddles (
        id TEXT PRIMARY KEY,
        office_id TEXT NOT NULL,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        role_ids TEXT NOT NULL DEFAULT '[]',
        turns INTEGER NOT NULL DEFAULT 0,
        max_turns INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        decision TEXT,
        tainted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS tm_office_huddles_office_idx ON tm_office_huddles (office_id, status, created_at)`,
      `CREATE INDEX IF NOT EXISTS tm_office_huddles_subject_idx ON tm_office_huddles (subject_kind, subject_id)`,
      `CREATE TABLE IF NOT EXISTS tm_office_signals (
        id TEXT PRIMARY KEY,
        office_id TEXT NOT NULL,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        raw_text TEXT NOT NULL,
        url TEXT,
        received_at TEXT NOT NULL,
        consumed_shift_id TEXT
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS tm_office_signals_external_idx ON tm_office_signals (source, external_id)`,
      `CREATE INDEX IF NOT EXISTS tm_office_signals_office_idx ON tm_office_signals (office_id, consumed_shift_id, received_at)`,
      `ALTER TABLE tm_chats ADD COLUMN office_id TEXT`,
      `ALTER TABLE tm_chats ADD COLUMN participants TEXT`,
      `CREATE INDEX IF NOT EXISTS tm_chats_office_idx ON tm_chats (office_id)`,
    ],
  },
  {
    id: 61,
    // Memory per run (docs/memory.md § Memory per run): the most the run's
    // process tree (claude + everything it started) measured, MiB — macOS
    // physical footprint, RSS elsewhere. Written by the 30 s sampler only
    // when it grows (`bumpRunPeakMem`); null = never sampled (a run older
    // than this, or one shorter than a sample).
    statements: [`ALTER TABLE tm_runs ADD COLUMN peak_mem_mb DOUBLE PRECISION`],
  },
  {
    id: 62,
    // Office group chat (docs/office.md § Group chat). On a message of an
    // office chat: `role_id` = the role the stakeholder's message was routed
    // to (@mention, else the Director) or the role that wrote a reply;
    // `tainted_at` = the reply came from a tainted role context (a shift
    // never reads its text); `channel_message_id` = the stakeholder message
    // was sent to the office channel as a request — set once, conditionally.
    statements: [
      `ALTER TABLE tm_chat_messages ADD COLUMN role_id TEXT`,
      `ALTER TABLE tm_chat_messages ADD COLUMN tainted_at TEXT`,
      `ALTER TABLE tm_chat_messages ADD COLUMN channel_message_id TEXT`,
    ],
  },
  {
    id: 63,
    // The office planner (docs/office.md § Office planner): one chat per
    // WORKSPACE (`planner_workspace_id`; the office may not exist yet, and a
    // workspace has at most one office), in no chat list. A planner reply's
    // proposal — a blueprint, or a diff with the fingerprint of the office it
    // was planned against — is `blueprint` (JSON), applied once
    // (`blueprint_applied_at`, a conditional write).
    statements: [
      `ALTER TABLE tm_chats ADD COLUMN planner_workspace_id TEXT`,
      `CREATE INDEX IF NOT EXISTS tm_chats_planner_idx ON tm_chats (planner_workspace_id)`,
      `ALTER TABLE tm_chat_messages ADD COLUMN blueprint TEXT`,
      `ALTER TABLE tm_chat_messages ADD COLUMN blueprint_applied_at TEXT`,
    ],
  },  {
    id: 64,
    // Stakeholder ratings (docs/office.md § Ratings): one 👍/👎 per subject — a
    // role's brief, proposal, role-tagged task or channel message — unique on
    // (subject_kind, subject_id), so a second rating UPDATES the row. FK-less
    // like every office table; `deleteOffice` removes them with the office.
    statements: [
      `CREATE TABLE IF NOT EXISTS tm_office_ratings (
        id TEXT PRIMARY KEY,
        office_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        value INTEGER NOT NULL,
        comment TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS tm_office_ratings_subject_idx ON tm_office_ratings (subject_kind, subject_id)`,
      `CREATE INDEX IF NOT EXISTS tm_office_ratings_office_idx ON tm_office_ratings (office_id, created_at)`,
    ],
  },
];

/** The migration after which each driver seeds one workspace per shared space, in JS, once. */
export const WORKSPACE_SEED_MIGRATION_ID = 49;

/**
 * Migration 49's seed, shared by both drivers: one workspace per `tm_spaces`
 * row, oldest space first (`sort_order` 0, 1, …), the space's name and repo ids
 * as they are, colour unset, and a slug unique among the seeded rows (a
 * numeric suffix on collision, never the reserved `all`). The table is new in
 * the same migration, so nothing else can hold a slug yet.
 */
export function workspaceSeedRows(
  spaces: { name: string; repo_ids: string; created_at: string }[],
  newId: () => string,
  at: string,
): { id: string; name: string; slug: string; repoIds: string; color: null; sortOrder: number; createdAt: string; updatedAt: string }[] {
  const taken = new Set<string>();
  return [...spaces]
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
    .map((sp, i) => {
      const slug = uniqueWorkspaceSlug(sp.name, taken);
      taken.add(slug);
      return { id: newId(), name: sp.name, slug, repoIds: sp.repo_ids, color: null, sortOrder: i, createdAt: at, updatedAt: at };
    });
}

/** The migration whose command owners each driver backfills in JS once it is applied. */
export const COMMAND_OWNER_MIGRATION_ID = 45;

/** How far an audit row's time may sit from the command's `created_at` and still be its creation. */
const OWNER_MATCH_MS = 60_000;

/**
 * Migration 45's owner backfill, shared by both drivers. A pre-45 audit row
 * carries no command id, so a command is matched to the AGENT `created` row
 * of the same repo, name and command line written closest to its
 * `created_at` (the route writes the two within milliseconds). No match — a
 * human's command, or one whose audit row is gone — stays unowned, which is
 * the safe side: an unowned command is never cleaned up.
 */
export function commandOwnerBackfill(
  commands: { id: string; repo_id: string; name: string; command: string; created_at: string }[],
  events: { at: string; actor: string; task_id: string | null; repo_id: string | null; data: unknown }[],
): { id: string; ownerTaskId: string }[] {
  const created = events.flatMap((e) => {
    if (!e.task_id || !e.actor.startsWith('agent:')) return [];
    let d: any = e.data;
    if (typeof d === 'string') {
      try {
        d = JSON.parse(d);
      } catch {
        return [];
      }
    }
    if (!d || d.action !== 'created') return [];
    return [{ at: Date.parse(e.at), taskId: e.task_id, repoId: e.repo_id, name: d.name, command: d.command }];
  });
  const out: { id: string; ownerTaskId: string }[] = [];
  for (const c of commands) {
    const t = Date.parse(c.created_at);
    let best: { taskId: string; gap: number } | null = null;
    for (const e of created) {
      if (e.repoId !== c.repo_id || e.name !== c.name || e.command !== c.command) continue;
      const gap = Math.abs(e.at - t);
      if (gap <= OWNER_MATCH_MS && (!best || gap < best.gap)) best = { taskId: e.taskId, gap };
    }
    if (best) out.push({ id: c.id, ownerTaskId: best.taskId });
  }
  return out;
}

/** The migration whose rows each driver backfills in JS once it is applied. */
export const COST_MIGRATION_ID = 33;
