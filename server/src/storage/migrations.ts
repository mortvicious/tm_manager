// Dialect-neutral DDL: runs unchanged on bundled SQLite (>=3.35) and Postgres.
// All tables carry the fixed `tm_` prefix (see docs/decisions.md).
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
];
