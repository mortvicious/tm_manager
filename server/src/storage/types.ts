import type {
  AppSettings,
  AuditEvent,
  AuditKind,
  Feature,
  FeaturePlan,
  FeatureReview,
  FeatureStatus,
  Proposal,
  ProposalPayload,
  Repo,
  Run,
  RunMode,
  RunStats,
  RunStatus,
  Task,
  TaskSource,
  TaskStatus,
} from '@tm/shared';

export interface NewAuditEvent {
  kind: AuditKind;
  actor: string;
  taskId?: string | null;
  runId?: string | null;
  repoId?: string | null;
  data?: Record<string, unknown> | null;
}

export interface EventFilter {
  kind?: AuditKind;
  actor?: string;
  taskId?: string;
  limit?: number;
  /** ISO timestamp lower bound (inclusive) */
  since?: string;
}

export interface TaskFilter {
  status?: TaskStatus;
  repoId?: string;
  parentId?: string;
  featureId?: string;
}

export interface NewRepo {
  name: string;
  path: string;
  role?: string | null;
  /** dev-server URL for the mobile emulator; validated http/https at the route */
  previewUrl?: string | null;
}

/** undefined = leave as-is; null clears the column. */
export type RepoPatch = Partial<Pick<Repo, 'name' | 'path' | 'role' | 'previewUrl'>>;

export interface NewTask {
  title: string;
  description?: string | null;
  repoId?: string | null;
  parentId?: string | null;
  status?: TaskStatus;
  source?: TaskSource;
  sourceRef?: string | null;
  priority?: number;
  model?: string | null;
  effort?: Task['effort'];
  category?: string | null;
  review?: boolean | null;
  createdByRun?: string | null;
  spawnDepth?: number;
  featureId?: string | null;
  featurePhase?: number | null;
}

export interface NewFeature {
  repoId: string;
  title: string;
  request: string;
}

export interface FeaturePatch {
  title?: string;
  request?: string;
  analysis?: FeaturePlan | null;
  review?: FeatureReview | null;
  analysisRounds?: number;
  error?: string | null;
}

/** What resolveFeatureCompletion actually did, so callers can broadcast. */
export interface FeatureResolution {
  feature: Feature;
  /** tasks whose status changed (phase enqueued) */
  tasks: Task[];
  action: 'paused' | 'phase-started' | 'review' | 'none';
  /** 0-based index of the phase that was just enqueued */
  phase?: number;
}

export interface NewRun {
  taskId?: string | null;
  repoId?: string | null;
  mode: RunMode;
  pid?: number | null;
  model?: string | null;
  effort?: Task['effort'];
  /** per-run auth token for hook callbacks and the agent API (never exposed in Run) */
  runToken?: string | null;
  /** run whose claude session this one continues (`claude --resume`) */
  resumedFrom?: string | null;
  /** cumulative transcript totals inherited from that session, subtracted from
   *  this run's raw sums so usage is never counted twice */
  statsBaseline?: RunStats | null;
}

export interface NewProposal {
  runId?: string | null;
  repoId?: string | null;
  taskId?: string | null;
  kind: Proposal['kind'];
  payload: ProposalPayload;
}

export interface ChildCounts {
  total: number;
  done: number;
  failed: number;
  unresolved: number; // not done/cancelled/failed
}

// NOTE: deliberately no generic `transaction(fn)` — better-sqlite3 transactions
// are sync-only, so multi-step mutations are first-class composite methods
// implemented transactionally inside each driver.
export interface Storage {
  migrate(): Promise<void>;
  close(): Promise<void>;

  listRepos(): Promise<Repo[]>;
  getRepo(id: string): Promise<Repo | null>;
  createRepo(r: NewRepo): Promise<Repo>;
  updateRepo(id: string, patch: RepoPatch): Promise<Repo | null>;
  deleteRepo(id: string): Promise<void>;

  listTasks(f?: TaskFilter): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  createTask(t: NewTask, actor: string): Promise<Task>;
  updateTask(id: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): Promise<Task | null>;
  deleteTask(id: string): Promise<void>;
  /** Atomic queued→running claim (repo-less tasks are never claimed); null when queue is empty. */
  claimNextQueuedTask(actor: string): Promise<Task | null>;
  /** Conditional transition: applies only when current status is in `from`; null otherwise. */
  transitionTask(
    id: string,
    from: TaskStatus[],
    to: TaskStatus,
    actor: string,
    patch?: Partial<Pick<Task, 'error' | 'resultSummary'>>,
  ): Promise<Task | null>;
  /**
   * Atomic parent re-evaluation after a child reaches a terminal status.
   * All children resolved & none failed → parent blocked→parentDoneStatus.
   * Any failed → parent stays blocked with error surfaced.
   * Returns the updated parent, or null when nothing changed.
   */
  resolveChildCompletion(childId: string, parentDoneStatus: 'review' | 'done', actor: string): Promise<Task | null>;
  countChildren(parentId: string): Promise<ChildCounts>;

  listRuns(f?: { taskId?: string; status?: RunStatus; mode?: RunMode }): Promise<Run[]>;
  getRun(id: string): Promise<Run | null>;
  /** Resolve a run from its per-run token (agent API / hook auth, review R5). */
  getRunByToken(token: string): Promise<Run | null>;
  /** Lifetime count of tasks a run has filed (per-run creation cap). */
  countTasksCreatedByRun(runId: string): Promise<number>;
  /** Currently-queued agent-created tasks (global flood ceiling, review R8). */
  countQueuedAgentTasks(): Promise<number>;
  /** Overflow claim (review R1): claim a queued task created by one of the
   *  given runs even when the concurrency cap is reached. */
  claimNextAgentChildTask(eligibleRunIds: string[], actor: string): Promise<Task | null>;
  createRun(r: NewRun): Promise<Run>;
  updateRun(
    id: string,
    patch: Partial<
      Pick<Run, 'status' | 'pid' | 'exitCode' | 'needsAttention' | 'idle' | 'sessionId' | 'transcriptPath' | 'stats' | 'endedAt'>
    >,
  ): Promise<Run | null>;

  listProposals(f?: { status?: Proposal['status']; taskId?: string; repoId?: string }): Promise<Proposal[]>;
  getProposal(id: string): Promise<Proposal | null>;
  createProposal(p: NewProposal): Promise<Proposal>;
  rejectProposal(id: string): Promise<Proposal | null>;
  /**
   * Atomic accept: rewrite→patch task; split→create queued children + block parent;
   * new_task→draft task; solution_options→append chosen option to description.
   * Returns affected tasks so callers can broadcast updates.
   */
  acceptProposal(
    id: string,
    actor: string,
    chosenOptionIndex?: number,
  ): Promise<{ proposal: Proposal; tasks: Task[] } | null>;

  // ---- features (docs/future/feature-interface.md) ----

  listFeatures(f?: { repoId?: string; status?: FeatureStatus }): Promise<Feature[]>;
  getFeature(id: string): Promise<Feature | null>;
  createFeature(f: NewFeature, actor: string): Promise<Feature>;
  /** Content edits only — status moves exclusively through transitionFeature. */
  updateFeature(id: string, patch: FeaturePatch, actor: string): Promise<Feature | null>;
  /** Conditional transition, twin of transitionTask. */
  transitionFeature(
    id: string,
    from: FeatureStatus[],
    to: FeatureStatus,
    actor: string,
    patch?: FeaturePatch,
  ): Promise<Feature | null>;
  /** Deletes a feature that owns no tasks; returns false when it still does. */
  deleteFeature(id: string): Promise<boolean>;
  /**
   * Atomic approval: proposed→approved, materialising every non-excluded plan
   * card as a `draft` tm_tasks row (source 'feature', feature_id/feature_phase
   * set). Descriptions are built server-side so the standing caps are always
   * present. Returns null when the feature is not approvable.
   */
  approveFeature(id: string, actor: string): Promise<{ feature: Feature; tasks: Task[] } | null>;
  /**
   * Atomic re-evaluation of a RUNNING feature after one of its tasks reached a
   * terminal status (or on start/resume):
   *  - any task failed → feature → paused
   *  - lowest phase with unresolved tasks → enqueue its draft tasks
   *  - nothing unresolved anywhere → feature → review
   */
  resolveFeatureCompletion(featureId: string, actor: string): Promise<FeatureResolution | null>;
  /** Cancels the feature and its non-terminal tasks; running ones are returned
   *  so the caller can kill their sessions (storage never touches PTYs). */
  cancelFeature(id: string, actor: string): Promise<{ feature: Feature; tasks: Task[]; runningTaskIds: string[] } | null>;

  /** Append-only audit log (synchronous inline; transitions log inside the
   *  same transaction as the mutation). */
  appendEvent(e: NewAuditEvent): Promise<AuditEvent>;
  listEvents(f?: EventFilter): Promise<AuditEvent[]>;

  getSettings(): Promise<AppSettings>;
  setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void>;
}
