// Dialect-neutral DDL: runs unchanged on bundled SQLite (>=3.35) and Postgres.
// All tables carry the fixed `tm_` prefix (see docs/decisions.md).

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
];
