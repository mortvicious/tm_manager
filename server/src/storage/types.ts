import type { MoveAnchor } from './group.ts';
import type { PushDevice, PushKind } from '@tm/shared';
import type {
  AppSettings,
  AuditEvent,
  AuditKind,
  Chat,
  ChatMessage,
  ChatMode,
  ChatRole,
  Dispatch,
  DispatchIntent,
  DispatchStatus,
  Feature,
  FeaturePlan,
  FeatureReview,
  FeatureStatus,
  Proposal,
  ProposalPayload,
  EffortLevel,
  Question,
  QuestionItem,
  QuestionStatus,
  Report,
  ReportLanguage,
  ReportRangePreset,
  ReportStatus,
  SharedNote,
  SharedNoteKind,
  SharedNoteStatus,
  Space,
  Repo,
  RepoCommand,
  Run,
  RunKind,
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
  /** every task in one tree — the root's id (docs/grouping.md) */
  groupId?: string;
  featureId?: string;
  /**
   * ISO lower bound on `updated_at`, inclusive — "what did this period touch"
   * (docs/telegram.md § Reports). A period report asks the DB for its window
   * rather than reading every row and filtering in JS, so the cost of a 24h
   * report does not grow with the age of the install.
   */
  updatedSince?: string;
  /**
   * ISO UPPER bound on `updated_at`, inclusive — the other half of a window.
   * `updatedSince` alone answers "since when"; a report answers "between", so
   * it needs a closing bound or every report would run to now (docs/reports.md).
   */
  updatedUntil?: string;
  /**
   * Several repos at once, for the multi-repo report. Disjunctive, and NOT a
   * replacement for `repoId` (which stays the single-repo fast path every other
   * caller uses). An EMPTY array matches nothing — a report over no repos has
   * no scope, and silently widening that to "all repos" would put private work
   * in a document that did not ask for it.
   */
  repoIds?: string[];
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

export interface NewCommand {
  repoId: string;
  name: string;
  command: string;
  kind?: RepoCommand['kind'];
  cwd?: string | null;
  sortOrder?: number;
}

/** undefined = leave as-is; `cwd: null` clears it back to the repo root. */
export type CommandPatch = Partial<Pick<RepoCommand, 'name' | 'command' | 'kind' | 'cwd' | 'sortOrder'>>;

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
  reviewModel?: string | null;
  reviewEffort?: Task['effort'];
  autoPublish?: boolean;
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
  /** what the session is (docs/design.md § PTY sessions); defaults to 'worker' for a worker */
  kind?: RunKind;
  /** the task / feature / chat / report / repo an aux session is about */
  subjectId?: string | null;
  /** runs-list label of an aux session */
  label?: string | null;
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

export interface NewDispatch {
  fromTaskId: string;
  fromRunId?: string | null;
  toTaskId: string;
  message: string;
  /** `fyi` never wakes an idle session (docs/dispatch.md § Intent) */
  intent: DispatchIntent;
}

export interface NewChat {
  repoId: string;
  title: string;
  model: string;
  effort: EffortLevel | null;
  mode: ChatMode;
}

/** Everything a human may change about a chat after it exists. */
export interface ChatPatch {
  title?: string;
  model?: string;
  effort?: EffortLevel | null;
  mode?: ChatMode;
}

export interface NewChatMessage {
  chatId: string;
  role: ChatRole;
  text: string;
  actor: string;
  error?: string | null;
  costUsd?: number;
  durationMs?: number | null;
}

/** How a turn ended, applied to the chat row in one write. */
export interface ChatTurnResult {
  /** cleared to NULL: the turn that owned this pid is over */
  /** claude's session id from the result envelope; null leaves the stored one */
  sessionId?: string | null;
  /** null on success — set means the turn failed and the chat goes to `error` */
  error: string | null;
  costUsd: number;
}

export interface NewQuestion {
  taskId: string;
  runId: string;
  toolUseId: string | null;
  questions: QuestionItem[];
}

/** A stored Web Push subscription (docs/push.md): the SPA's view plus the keys. */
export interface PushDeviceRecord extends PushDevice {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface NewPushDevice {
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  kinds: PushKind[];
}

export interface QuestionFilter {
  status?: QuestionStatus;
  taskId?: string;
  runId?: string;
}

export interface DispatchFilter {
  /** matches EITHER side (from or to) — the per-task panel view */
  taskId?: string;
  toTaskId?: string;
  status?: DispatchStatus;
  /** ISO lower bound on `created_at`, inclusive — the report window */
  since?: string;
}

export interface RunFilter {
  taskId?: string;
  repoId?: string;
  status?: RunStatus;
  mode?: RunMode;
  kind?: RunKind;
  subjectId?: string;
  /** ISO lower bound on `started_at`, inclusive — the report window */
  since?: string;
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
export interface NewReport {
  title: string;
  repoIds: string[];
  fromDate: string;
  toDate: string;
  preset: ReportRangePreset;
  language: ReportLanguage;
  model: string | null;
}

/** undefined = leave as-is; null clears the column. */
export interface ReportPatch {
  title?: string;
  status?: ReportStatus;
  markdown?: string | null;
  summary?: string | null;
  taskCount?: number;
  model?: string | null;
  error?: string | null;
}

/** Shared spaces (docs/shared-spaces.md). */
export interface NewSpace {
  name: string;
  path: string;
  repoIds: string[];
}

export interface SpacePatch {
  name?: string;
  path?: string;
  repoIds?: string[];
}

export interface NewSharedNote {
  spaceId: string;
  kind: SharedNoteKind;
  title: string;
  body: string;
  fromRepoId: string | null;
  fromTaskId: string | null;
  toRepoId: string | null;
  files: string[];
  actor: string;
}

/** undefined = leave as-is; null clears the column. */
export interface SharedNotePatch {
  title?: string;
  body?: string;
  toRepoId?: string | null;
  status?: SharedNoteStatus;
  taskId?: string | null;
  resolution?: string | null;
  files?: string[];
}

export interface SharedNoteFilter {
  spaceId?: string;
  kind?: SharedNoteKind;
  status?: SharedNoteStatus[];
  /** null = notes addressed to nobody in particular */
  toRepoId?: string | null;
  taskId?: string;
  /** strictly after this ISO instant */
  createdAfter?: string;
  oldestFirst?: boolean;
  limit?: number;
}

export interface Storage {
  migrate(): Promise<void>;
  close(): Promise<void>;

  listRepos(): Promise<Repo[]>;
  getRepo(id: string): Promise<Repo | null>;
  createRepo(r: NewRepo): Promise<Repo>;
  updateRepo(id: string, patch: RepoPatch): Promise<Repo | null>;
  deleteRepo(id: string): Promise<void>;

  /** Saved repo commands (docs/commands.md), launcher order. */
  listCommands(repoId?: string): Promise<RepoCommand[]>;
  getCommand(id: string): Promise<RepoCommand | null>;
  createCommand(c: NewCommand): Promise<RepoCommand>;
  updateCommand(id: string, patch: CommandPatch): Promise<RepoCommand | null>;
  deleteCommand(id: string): Promise<void>;

  listTasks(f?: TaskFilter): Promise<Task[]>;
  /**
   * Task-group invariants (docs/grouping.md), maintained by BOTH drivers:
   * createTask derives `group_id`/`group_path` from the parent row; updateTask
   * re-parents the whole subtree (throwing on a self/descendant parent) and
   * drops `group_name`/`group_color` from a task that stops being a root;
   * deleteTask promotes orphaned children to roots of their own groups.
   */
  getTask(id: string): Promise<Task | null>;
  createTask(t: NewTask, actor: string): Promise<Task>;
  updateTask(id: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): Promise<Task | null>;
  deleteTask(id: string): Promise<void>;
  /**
   * Re-parent AND position a task in one transaction (docs/grouping.md § Order):
   * `parentId` as updateTask (same errors, same subtree move), then the key
   * next to `anchor` among the destination's siblings — renumbering them when
   * the gap is spent. Audited `task.moved`. Returns every row whose group or
   * key changed (the moved subtree, the destination group, a renumbered set),
   * or null when the task does not exist.
   */
  moveTask(id: string, parentId: string | null, anchor: MoveAnchor, actor: string): Promise<Task[] | null>;
  /** Atomic queued→running claim (repo-less tasks are never claimed); null when queue is empty. */
  claimNextQueuedTask(actor: string): Promise<Task | null>;
  /**
   * Custom queue (docs/queue.md). `peekCustomQueue` is the head the next
   * claim WOULD take (FIFO by `customQueueAt`, feature gate applied) — the
   * orchestrator checks the head's repo for foreign sessions before claiming.
   * `claimNextCustomQueuedTask` claims that head in one statement, and only
   * while NO custom-queue member is `running`: the queue is strictly serial.
   * Both drivers share the SQL verbatim (storage/queue-sql.ts).
   */
  peekCustomQueue(): Promise<Task | null>;
  claimNextCustomQueuedTask(actor: string): Promise<Task | null>;
  /** Conditional transition: applies only when current status is in `from`; null otherwise. */
  transitionTask(
    id: string,
    from: TaskStatus[],
    to: TaskStatus,
    actor: string,
    patch?: Partial<Pick<Task, 'error' | 'resultSummary' | 'reviewState' | 'queueHeldAt'>>,
  ): Promise<Task | null>;
  /**
   * Atomic parent re-evaluation after a child reaches a terminal status.
   * All children resolved & none failed → parent blocked→parentDoneStatus.
   * Any failed → parent stays blocked with error surfaced.
   * Returns the updated parent, or null when nothing changed.
   */
  resolveChildCompletion(childId: string, parentDoneStatus: 'review' | 'done', actor: string): Promise<Task | null>;
  countChildren(parentId: string): Promise<ChildCounts>;

  listRuns(f?: RunFilter): Promise<Run[]>;
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

  // ---- dispatches (docs/dispatch.md) ----

  /** Newest first. */
  listDispatches(f?: DispatchFilter): Promise<Dispatch[]>;
  getDispatch(id: string): Promise<Dispatch | null>;
  createDispatch(d: NewDispatch): Promise<Dispatch>;
  /**
   * Conditional pending→terminal settle (delivered/failed/cancelled) — the
   * single-flight delivery loop and the human cancel route both go through
   * this, so a dispatch can never be settled twice. Returns null when it was
   * no longer pending.
   */
  settleDispatch(
    id: string,
    status: 'delivered' | 'failed' | 'cancelled',
    note?: string | null,
  ): Promise<Dispatch | null>;
  /** Lifetime dispatches sent by one run (per-run cap). */
  countDispatchesByRun(runId: string): Promise<number>;
  /** Lifetime dispatches between two tasks, both directions (ping-pong cap). */
  countDispatchesBetween(taskA: string, taskB: string): Promise<number>;

  // ---- questions (docs/questions.md) ----

  /** Newest first. */
  listQuestions(f?: QuestionFilter): Promise<Question[]>;
  getQuestion(id: string): Promise<Question | null>;
  createQuestion(q: NewQuestion): Promise<Question>;
  /**
   * Conditional pending→answered — the SPA route and the Telegram press both
   * go through this, so a question can never be answered twice. Returns null
   * when it was no longer pending (already answered elsewhere, or expired).
   */
  answerQuestion(id: string, answers: Record<string, string>, actor: string): Promise<Question | null>;
  /**
   * Every pending question matching the filter → `expired` with `note`, in one
   * statement; returns the rows it expired (possibly none). An empty filter
   * expires ALL pending questions — the boot sweep.
   */
  expireQuestions(f: { runId?: string; taskId?: string }, note: string): Promise<Question[]>;

  // ---- web push devices (docs/push.md) ----

  listPushDevices(): Promise<PushDeviceRecord[]>;
  /**
   * Keyed on the endpoint: re-subscribing the same browser (a new permission
   * grant, a rotated key) replaces its keys and kinds and resets the failure
   * count instead of adding a second row that would ping twice.
   */
  upsertPushDevice(d: NewPushDevice): Promise<PushDeviceRecord>;
  updatePushDevice(id: string, patch: { label?: string; kinds?: PushKind[] }): Promise<PushDeviceRecord | null>;
  deletePushDevice(id: string): Promise<boolean>;
  /** success: last_ok_at = now, fail_count = 0; failure: last_error, fail_count + 1 */
  recordPushResult(id: string, error: string | null): Promise<void>;

  // ---- chats (docs/chat.md) ----

  /** Newest activity first. */
  listChats(repoId?: string): Promise<Chat[]>;
  getChat(id: string): Promise<Chat | null>;
  createChat(c: NewChat): Promise<Chat>;
  updateChat(id: string, patch: ChatPatch): Promise<Chat | null>;
  /** Deletes the chat AND its messages, transactionally — there is no FK to do
   *  it for us (migration 19), and a transcript with no chat is unreachable. */
  deleteChat(id: string): Promise<boolean>;
  /** Oldest first, newest `limit` rows when given (the page renders bottom-up). */
  listChatMessages(chatId: string, limit?: number): Promise<ChatMessage[]>;
  appendChatMessage(m: NewChatMessage): Promise<ChatMessage>;
  /**
   * The serialisation lock. Flips `idle`/`error` → `thinking` and clears the
   * previous error, in ONE conditional statement — a chat already `thinking`
   * returns null and its caller refuses. This is what stops the browser and
   * the phone from putting two `claude -p` children on one session id, and it
   * is a composite method for the same reason every other one is: there is no
   * generic `transaction(fn)` (see the note above).
   */
  beginChatTurn(id: string): Promise<Chat | null>;
  /**
   * Record (or clear) the pid of the turn running right now. Separate from
   * `beginChatTurn` because the lock is taken BEFORE the child exists — and
   * separate from a general patch so a crash between the two leaves a chat
   * `thinking` with a null pid, which boot recovery reads as "nothing to
   * kill", the safe half of the answer.
   */
  setChatPid(id: string, pid: number | null): Promise<void>;
  /**
   * The other half: `thinking` → `idle` (or `error`), recording the session id
   * the turn captured, its cost, and bumping the turn counter on success.
   * Unconditional on purpose — the turn that owns the lock is the only caller,
   * and a boot that finds a stranded `thinking` row must be able to clear it.
   */
  finishChatTurn(id: string, r: ChatTurnResult): Promise<Chat | null>;
  /** Live turns across all chats, for the `chat.concurrency` fence. */
  countThinkingChats(): Promise<number>;

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

  /**
   * Reports (docs/reports.md). Plain CRUD: unlike a task there is no state
   * machine here — a report is created `pending`, moved to `running` by the
   * service that spawns its claude pass, and lands `ready` or `failed`. No
   * composite is needed because only one writer ever touches a given row.
   */
  listReports(): Promise<Report[]>;
  getReport(id: string): Promise<Report | null>;
  createReport(r: NewReport, actor: string): Promise<Report>;
  updateReport(id: string, patch: ReportPatch): Promise<Report | null>;
  deleteReport(id: string): Promise<boolean>;

  /**
   * Shared spaces (docs/shared-spaces.md). Plain CRUD plus one conditional
   * update: `updateSharedNote(id, patch, fromStatus)` only writes while the
   * note is in one of `fromStatus`, which is what makes filing a request
   * single-winner. `deleteSpace` removes the space's notes in the same
   * transaction.
   */
  listSpaces(): Promise<Space[]>;
  getSpace(id: string): Promise<Space | null>;
  createSpace(s: NewSpace): Promise<Space>;
  updateSpace(id: string, patch: SpacePatch): Promise<Space | null>;
  deleteSpace(id: string): Promise<boolean>;
  listSharedNotes(f: SharedNoteFilter): Promise<SharedNote[]>;
  getSharedNote(id: string): Promise<SharedNote | null>;
  createSharedNote(n: NewSharedNote): Promise<SharedNote>;
  updateSharedNote(id: string, patch: SharedNotePatch, fromStatus?: readonly SharedNoteStatus[]): Promise<SharedNote | null>;
  deleteSharedNote(id: string): Promise<boolean>;

  getSettings(): Promise<AppSettings>;
  setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void>;
}
