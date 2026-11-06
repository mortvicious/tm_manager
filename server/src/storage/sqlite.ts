import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import {
  DEFAULT_SETTINGS,
  TERMINAL_TASK_STATUSES,
  runTaskId,
  type AppSettings,
  type AuditEvent,
  type AuditKind,
  type Chat,
  type ChatMessage,
  type Dispatch,
  type Question,
  type Feature,
  type FeatureStatus,
  type Proposal,
  type Repo,
  type RepoCommand,
  type Report,
  type Run,
  type SharedNote,
  type SharedNoteStatus,
  type Space,
  type Workspace,
  type Task,
} from '@tm/shared';
import { approvalCardRepos, planCards, planFeatureProgress } from '../claude/feature-plan.ts';
import { broadcast } from '../events.ts';
import { machineDefaults } from '../machine.ts';
import { FEATURE_CLAIM_GATE, FEATURE_OVERFLOW_GATE } from './feature-sql.ts';
import { CUSTOM_QUEUE_HEAD_ORDER, CUSTOM_QUEUE_HEAD_WHERE, CUSTOM_QUEUE_SAME_REPO, CUSTOM_QUEUE_WAITING_SQL, OFFICE_CLAIM_GATE, OFFICE_TRIPPED_SQL, REPO_EXCLUSIVE_GATE, planQueueReorder, reorderAudit, skipRepos, type QueueMoveAnchor } from './queue-sql.ts';
import { runCost, taskCostSql } from './cost-sql.ts';
import { OFFICE_RATING_GET_SQL, OFFICE_RATINGS_DELETE_SQL, OFFICE_RATING_UPSERT_SQL, officeRatingListSql, officeRatingUpsertParams, rowToOfficeRating, type NewOfficeRating, type OfficeRatingFilter } from './rating-sql.ts';
import { OFFICE_METRIC_BREACH_SQL, OFFICE_METRIC_DELETE_SQL, OFFICE_METRIC_ERROR_SQL, OFFICE_METRIC_GET_SQL, OFFICE_METRIC_INSERT_SQL, OFFICE_METRIC_NO_SIDE_SQL, OFFICE_METRIC_OK_SQL, OFFICE_METRIC_POINTS_DELETE_SQL, OFFICE_METRIC_POINTS_PRUNE_SQL, OFFICE_METRIC_POINT_INSERT_SQL, OFFICE_METRIC_VALUE_SQL, OFFICE_METRICS_DELETE_SQL, OFFICE_METRICS_POINTS_DELETE_FOR_OFFICE_SQL, officeMetricInsertParams, officeMetricListSql, officeMetricPatchSql, officeMetricPointsSql, officeMetricPruneParams, rowToOfficeMetric, rowToOfficeMetricPoint, type NewOfficeMetric, type OfficeMetricFilter, type OfficeMetricPatch, type OfficeMetricRun, type OfficeMetricRunResult } from './metric-sql.ts';
import { metricSide, type OfficeMetric, type OfficeMetricPoint } from '@tm/shared';
import { REPO_PARALLEL_SQL, repoParallelParams, worktreePatchSql } from './worktree-sql.ts';
import { LOOP_LEAVES_RUNNING_SQL, loopStepSets, stepLoopSql } from './loop-sql.ts';
import {
  MANUAL_CLAIM_ORDER,
  MOVE_SUBTREE_SQL,
  NEXT_SORT_ORDER_SQL,
  ROOT_PATH,
  keyNextTo,
  moveSubtreeParams,
  pathContains,
  placement,
  siblingsQuery,
  type MoveAnchor,
} from './group.ts';
import {
  COMMAND_OWNER_MIGRATION_ID,
  COST_MIGRATION_ID,
  MIGRATIONS,
  WORKSPACE_SEED_MIGRATION_ID,
  commandOwnerBackfill,
  workspaceSeedRows,
} from './migrations.ts';
import {
  WORKSPACE_APPEND_SQL,
  WORKSPACE_INSERT_SQL,
  WORKSPACE_LIST_SQL,
  WORKSPACE_SORT_SQL,
  workspaceOrder,
  workspacePatchColumns,
} from './workspace-sql.ts';
import {
  OFFICE_BY_WORKSPACE_SQL,
  OFFICE_BRIEF_GET_SQL,
  OFFICE_BRIEF_INSERT_SQL,
  OFFICE_BRIEFS_DELETE_SQL,
  OFFICE_PROPOSAL_GET_SQL,
  OFFICE_PROPOSAL_INSERT_SQL,
  OFFICE_PROPOSALS_DELETE_SQL,
  OFFICE_WISH_DELETE_SQL,
  OFFICE_WISH_GET_SQL,
  OFFICE_WISH_INSERT_SQL,
  OFFICE_MESSAGE_GET_SQL,
  OFFICE_MESSAGE_CLEAR_TAINT_SQL,
  OFFICE_MESSAGE_INSERT_SQL,
  OFFICE_MESSAGES_DELETE_SQL,
  OFFICE_HUDDLE_GET_SQL,
  OFFICE_HUDDLE_INSERT_SQL,
  OFFICE_HUDDLES_DELETE_SQL,
  OFFICE_SIGNAL_BY_EXTERNAL_SQL,
  OFFICE_SIGNAL_GET_SQL,
  OFFICE_SIGNAL_INSERT_SQL,
  OFFICE_SIGNALS_DELETE_SQL,
  officeMessageInsertParams,
  officeMessageListSql,
  officeMessageRouteSql,
  officeHuddleInsertParams,
  officeHuddleListSql,
  officeHuddleStepSql,
  officeHuddleCloseSql,
  officeHuddleTaintSql,
  officeSignalInsertParams,
  officeSignalListSql,
  officeSignalConsumeSql,
  rowToOfficeMessage,
  rowToOfficeHuddle,
  rowToOfficeSignal,
  type NewOfficeMessage,
  type NewOfficeHuddle,
  type NewOfficeSignal,
  type OfficeMessageFilter,
  type OfficeHuddleFilter,
  type OfficeSignalFilter,
  OFFICE_WISHES_DELETE_SQL,
  officeBriefInsertParams,
  officeBriefListSql,
  officeMarkReviewedSql,
  OFFICE_BRIEF_CLEAR_TAINT_SQL,
  officeProposalDecideSql,
  officeProposalFiledSql,
  officeProposalInsertParams,
  officeProposalListSql,
  officeWishInsertParams,
  officeWishListSql,
  officeWishPatchSql,
  rowToOfficeBrief,
  rowToOfficeProposal,
  rowToOfficeWish,
  type NewOfficeBrief,
  type NewOfficeProposal,
  type NewOfficeWish,
  type OfficeBriefFilter,
  type OfficeProposalFilter,
  type OfficeReviewable,
  type OfficeWishFilter,
  type OfficeWishPatch,
  OFFICE_DELETE_SQL,
  OFFICE_GET_SQL,
  OFFICE_INSERT_SQL,
  OFFICE_LIST_SQL,
  OFFICE_ROLE_DELETE_SQL,
  OFFICE_ROLE_GET_SQL,
  OFFICE_ROLE_INSERT_SQL,
  OFFICE_ROLES_DELETE_SQL,
  OFFICE_SHIFT_GET_SQL,
  OFFICE_SHIFT_INSERT_SQL,
  OFFICE_SHIFTS_DELETE_SQL,
  OFFICE_PROPOSAL_UNDO_ACCEPT_SQL,
  OFFICE_PROPOSALS_PENDING_COUNT_SQL,
  officeInsertParams,
  officeOpenTasksSql,
  officePatchSql,
  officePauseSql,
  officeKillSwitchSql,
  officeRoleInsertParams,
  officeRoleListSql,
  officeRolePatchSql,
  officeShiftInsertParams,
  officeShiftListSql,
  officeShiftPatchSql,
  officeSpendSql,
  OFFICE_DIRECTOR_ROLE_SQL,
  OFFICE_WORKSPACE_REPOS_SQL,
  REPO_EXISTS_SQL,
  parseRepoIds,
  rowToOffice,
  rowToOfficeRole,
  rowToOfficeShift,
  type NewOffice,
  type NewOfficeRole,
  type NewOfficeShift,
  type OfficePatch,
  type OfficeRolePatch,
  type OfficeShiftFilter,
  type OfficeShiftPatch,
} from './office-sql.ts';
import type {
  Office,
  OfficeBrief,
  OfficeHuddle,
  OfficeMessage,
  OfficeProposal,
  OfficeRole,
  OfficeShift,
  OfficeSignal,
  OfficeWish,
  OfficeRating,
  OfficeRatingSubjectKind,
} from '@tm/shared';
import { officeTrippedParam } from '@tm/shared';
import {
  APPROVAL_DECIDE_SQL,
  APPROVAL_INSERT_SQL,
  REPO_AUTO_APPROVE_SQL,
  approvalExpireSql,
  approvalInsertParams,
  approvalListSql,
  approvalStepSql,
  autoApproveValue,
  REPO_OFFICE_AUTONOMY_SQL,
  rowToApproval,
  type ApprovalFilter,
  type NewApproval,
} from './approval-sql.ts';
import {
  JOB_DELETE_SQL,
  JOB_INSERT_SQL,
  JOB_RUN_ACK_SQL,
  JOB_RUN_FINISH_SQL,
  JOB_RUN_INSERT_SQL,
  JOB_RUN_SET_RUN_ID_SQL,
  JOB_RUNS_ACK_ALL_SQL,
  JOB_RUNS_DELETE_SQL,
  JOB_RUNS_FOR_JOB_SQL,
  JOB_RUNS_OPEN_SQL,
  JOB_RUNS_UNFINISHED_SQL,
  JOB_SCHEDULED_COUNT_SQL,
  jobClaimSql,
  jobInsertParams,
  jobListSql,
  jobPatchSql,
  jobRunFinishParams,
  jobStepSql,
  rowToJob,
  rowToJobRun,
  type JobFilter,
  type JobPatch,
  type JobRunFinish,
  type NewJob,
} from './job-sql.ts';
import type { Job, JobRun, JobStatus, JobVerdict } from '@tm/shared';
import type { Approval, ApprovalStatus } from '@tm/shared';
import { PUSH_RESULT_FAIL_SQL, PUSH_RESULT_OK_SQL, PUSH_UPSERT_SQL, rowToPushDevice } from './push-sql.ts';
import type { LoopStep, NewPushDevice, PushDeviceRecord } from './types.ts';
import type { NamedGroupFiling } from './types.ts';
import { normalizeGroupName, pickNamedGroup, type NamedGroupCandidate } from '@tm/shared';
import { featureCardGroup, namedGroupCandidates, namedGroupInsert, RESOLVING_CHILDREN_SQL, runWalkSync, untrustedWalk } from './group-filing-sql.ts';
import type { LoopState } from '@tm/shared';
import type { PushKind } from '@tm/shared';
import {
  SHARED_NOTE_INSERT_SQL,
  SPACE_INSERT_SQL,
  sharedNoteListQuery,
  sharedNoteUpdate,
  spacePatchColumns,
} from './space-sql.ts';
import {
  eventId,
  now,
  rowToChat,
  rowToChatMessage,
  rowToCommand,
  rowToDispatch,
  rowToQuestion,
  reportPatchColumns,
  rowToReport,
  rowToSharedNote,
  rowToSpace,
  rowToWorkspace,
  rowToEvent,
  rowToFeature,
  rowToProposal,
  rowToRepo,
  rowToRun,
  rowToTask,
  safeParse,
} from './rows.ts';
import type {
  ChatPatch,
  ChatTurnResult,
  ChildCounts,
  CommandPatch,
  DispatchFilter,
  RunFilter,
  EventFilter,
  FeaturePatch,
  FeatureResolution,
  NewAuditEvent,
  NewChat,
  NewChatMessage,
  NewCommand,
  NewDispatch,
  NewQuestion,
  NewReport,
  NewSharedNote,
  NewSpace,
  NewWorkspace,
  SharedNoteFilter,
  SharedNotePatch,
  SpacePatch,
  WorkspacePatch,
  ReportPatch,
  QuestionFilter,
  NewFeature,
  NewProposal,
  NewRepo,
  NewRun,
  NewTask,
  RepoPatch,
  WorktreePatch,
  Storage,
  TaskFilter,
} from './types.ts';
import { eventListSql, runListSql, taskAnchorsSql, taskSeedEventsSql } from './event-sql.ts';


export class SqliteStorage implements Storage {
  private db: Database.Database;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  async migrate(): Promise<void> {
    this.db.exec(`CREATE TABLE IF NOT EXISTS tm_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
    const applied = new Set(
      (this.db.prepare(`SELECT id FROM tm_migrations`).all() as { id: number }[]).map((r) => r.id),
    );
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      const run = this.db.transaction(() => {
        for (const s of m.statements) this.db.exec(s);
        this.db.prepare(`INSERT INTO tm_migrations (id, applied_at) VALUES (?, ?)`).run(m.id, now());
        // Same transaction (a savepoint inside it): a crash cannot leave the
        // migration marked applied with no costs.
        if (m.id === COST_MIGRATION_ID) this.backfillCosts();
        if (m.id === COMMAND_OWNER_MIGRATION_ID) this.backfillCommandOwners();
        if (m.id === WORKSPACE_SEED_MIGRATION_ID) this.seedWorkspaces();
      });
      run();
    }
  }

  /** Migration 33: lift `stats.costUsd` into `tm_runs.cost_usd` for every existing run, then roll every task up. */
  private backfillCosts(): void {
    const rows = this.db.prepare(`SELECT id, stats FROM tm_runs WHERE stats IS NOT NULL`).all() as {
      id: string;
      stats: string;
    }[];
    const set = this.db.prepare(`UPDATE tm_runs SET cost_usd = ? WHERE id = ?`);
    this.db.transaction(() => {
      for (const r of rows) set.run(runCost(safeParse(r.stats, null)), r.id);
      this.db.exec(`UPDATE tm_tasks SET cost_usd = ${taskCostSql('tm_tasks.id')}`);
    })();
  }

  /** Migration 45: owners of agent-saved commands from their `command.changed` audit rows. */
  private backfillCommandOwners(): void {
    const commands = this.db.prepare(`SELECT id, repo_id, name, command, created_at FROM tm_commands`).all() as any[];
    if (commands.length === 0) return;
    const events = this.db
      .prepare(`SELECT at, actor, task_id, repo_id, data FROM tm_events WHERE kind = 'command.changed' AND task_id IS NOT NULL`)
      .all() as any[];
    const set = this.db.prepare(`UPDATE tm_commands SET owner_task_id = ? WHERE id = ?`);
    for (const o of commandOwnerBackfill(commands, events)) set.run(o.ownerTaskId, o.id);
  }

  /** Migration 49: one workspace per shared space, once (docs/workspaces.md § Seed). */
  private seedWorkspaces(): void {
    const spaces = this.db.prepare(`SELECT name, repo_ids, created_at FROM tm_spaces`).all() as any[];
    const insert = this.db.prepare(WORKSPACE_INSERT_SQL);
    for (const w of workspaceSeedRows(spaces, randomUUID, now())) {
      insert.run(w.id, w.name, w.slug, w.repoIds, w.color, w.sortOrder, w.createdAt, w.updatedAt);
    }
  }

  async spendSince(sinceIso: string): Promise<number> {
    const r = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM tm_runs WHERE started_at >= ?`)
      .get(sinceIso) as { s: number | null };
    return Number(r.s ?? 0) || 0;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // Broadcasts are BUFFERED until the surrounding transaction commits — a
  // rollback must not leave phantom events in the UI feed (dashboard impl R4).
  private pendingBroadcasts: AuditEvent[] = [];

  private flushEventBroadcasts(): void {
    const evs = this.pendingBroadcasts;
    this.pendingBroadcasts = [];
    for (const ev of evs) queueMicrotask(() => broadcast({ type: 'event.appended', event: ev }));
  }

  private discardEventBroadcasts(): void {
    this.pendingBroadcasts = [];
  }

  /** Synchronous audit append — used inside the same transaction as the
   *  mutation it records (dashboard review Q1/A1). */
  private appendEventSync(e: NewAuditEvent): AuditEvent {
    const ev: AuditEvent = {
      id: eventId(),
      at: now(),
      kind: e.kind,
      actor: e.actor,
      taskId: e.taskId ?? null,
      runId: e.runId ?? null,
      repoId: e.repoId ?? null,
      data: e.data ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO tm_events (id, at, kind, actor, task_id, run_id, repo_id, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ev.id, ev.at, ev.kind, ev.actor, ev.taskId, ev.runId, ev.repoId, ev.data ? JSON.stringify(ev.data) : null);
    this.pendingBroadcasts.push(ev);
    return ev;
  }

  async appendEvent(e: NewAuditEvent): Promise<AuditEvent> {
    const ev = this.appendEventSync(e);
    this.flushEventBroadcasts();
    return ev;
  }

  /** Run a sync transaction fn; flush event broadcasts only on commit. */
  private inTxn<T>(fn: () => T): T {
    const txn = this.db.transaction(fn);
    try {
      const out = txn();
      this.flushEventBroadcasts();
      return out;
    } catch (e) {
      this.discardEventBroadcasts();
      throw e;
    }
  }

  async listEvents(f?: EventFilter): Promise<AuditEvent[]> {
    const { sql, params } = eventListSql(f);
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToEvent);
  }

  async taskSeedEvents(anchorKinds: AuditKind[], kinds: AuditKind[], taskIds: string[], before: string): Promise<AuditEvent[]> {
    if (taskIds.length === 0 || anchorKinds.length === 0) return [];
    // an empty `kinds` still returns the anchors (the IN list needs one value)
    const { sql, params } = taskSeedEventsSql(anchorKinds, kinds.length ? kinds : anchorKinds, taskIds, before);
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToEvent);
  }
  async taskAnchorsBefore(anchorKinds: AuditKind[], before: string, repoIds?: string[]): Promise<AuditEvent[]> {
    if (anchorKinds.length === 0 || (repoIds && repoIds.length === 0)) return [];
    const { sql, params } = taskAnchorsSql(anchorKinds, before, repoIds);
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToEvent);
  }



  async setEventData(id: string, data: Record<string, unknown>): Promise<void> {
    this.db.prepare(`UPDATE tm_events SET data = ? WHERE id = ?`).run(JSON.stringify(data), id);
  }

  // ---- repos ----

  async listRepos(): Promise<Repo[]> {
    return (this.db.prepare(`SELECT * FROM tm_repos ORDER BY created_at`).all() as any[]).map(rowToRepo);
  }

  async getRepo(id: string): Promise<Repo | null> {
    const r = this.db.prepare(`SELECT * FROM tm_repos WHERE id = ?`).get(id);
    return r ? rowToRepo(r) : null;
  }

  async createRepo(r: NewRepo): Promise<Repo> {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO tm_repos (id, name, path, role, preview_url, landing, push_policy, question_autopilot_minutes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, r.name, r.path, r.role ?? null, r.previewUrl ?? null, r.landing ?? 'supervised', r.pushPolicy ?? 'repo-rules', r.questionAutopilotMinutes ?? null, now());
    return (await this.getRepo(id))!;
  }

  async updateRepo(id: string, patch: RepoPatch): Promise<Repo | null> {
    const cur = await this.getRepo(id);
    if (!cur) return null;
    this.db
      .prepare(`UPDATE tm_repos SET name = ?, path = ?, role = ?, preview_url = ?, landing = ?, push_policy = ?, question_autopilot_minutes = ? WHERE id = ?`)
      .run(
        patch.name ?? cur.name,
        patch.path ?? cur.path,
        patch.role === undefined ? cur.role : patch.role,
        patch.previewUrl === undefined ? cur.previewUrl : patch.previewUrl,
        patch.landing ?? cur.landing,
        patch.pushPolicy ?? cur.pushPolicy,
        patch.questionAutopilotMinutes === undefined ? cur.questionAutopilotMinutes : patch.questionAutopilotMinutes,
        id,
      );
    this.db
      .prepare(REPO_PARALLEL_SQL)
      .run(...repoParallelParams(cur, patch), id);
    if (patch.autoApprove !== undefined) this.db.prepare(REPO_AUTO_APPROVE_SQL).run(autoApproveValue(patch.autoApprove), id);
    if (patch.officeAutonomyOptin !== undefined) this.db.prepare(REPO_OFFICE_AUTONOMY_SQL).run(patch.officeAutonomyOptin ? 1 : 0, id);
    return this.getRepo(id);
  }

  async deleteRepo(id: string): Promise<void> {
    const del = this.db.transaction((repoId: string) => {
      this.db.prepare(`UPDATE tm_tasks SET repo_id = NULL WHERE repo_id = ?`).run(repoId);
      // Commands are owned by the repo (repo_id NOT NULL): a command line has
      // no meaning without the directory it runs in, so it goes with it.
      this.db.prepare(`DELETE FROM tm_commands WHERE repo_id = ?`).run(repoId);
      // Features follow tasks: detached, not deleted (their plan is still
      // readable) — and the FK would otherwise reject the delete.
      this.db.prepare(`UPDATE tm_features SET repo_id = NULL, updated_at = ? WHERE repo_id = ?`).run(now(), repoId);
      this.db.prepare(`DELETE FROM tm_repos WHERE id = ?`).run(repoId);
    });
    del(id);
  }

  // ---- commands (docs/commands.md) ----

  async listCommands(repoId?: string): Promise<RepoCommand[]> {
    const sql = `SELECT * FROM tm_commands ${repoId ? 'WHERE repo_id = ?' : ''} ORDER BY sort_order, created_at`;
    const rows = repoId ? this.db.prepare(sql).all(repoId) : this.db.prepare(sql).all();
    return (rows as any[]).map(rowToCommand);
  }

  async getCommand(id: string): Promise<RepoCommand | null> {
    const r = this.db.prepare(`SELECT * FROM tm_commands WHERE id = ?`).get(id);
    return r ? rowToCommand(r) : null;
  }

  async createCommand(c: NewCommand): Promise<RepoCommand> {
    const id = randomUUID();
    const at = now();
    const sortOrder =
      c.sortOrder ??
      Number(
        (this.db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM tm_commands WHERE repo_id = ?`).get(
          c.repoId,
        ) as { next: number }).next,
      );
    this.db
      .prepare(
        `INSERT INTO tm_commands (id, repo_id, name, command, kind, cwd, sort_order, is_check, timeout_sec, owner_task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, c.repoId, c.name, c.command, c.kind ?? 'task', c.cwd ?? null, sortOrder, c.isCheck ? 1 : 0, c.timeoutSec ?? null, c.ownerTaskId ?? null, at, at);
    return (await this.getCommand(id))!;
  }

  async updateCommand(id: string, patch: CommandPatch): Promise<RepoCommand | null> {
    const cur = await this.getCommand(id);
    if (!cur) return null;
    this.db
      .prepare(
        `UPDATE tm_commands SET name = ?, command = ?, kind = ?, cwd = ?, sort_order = ?, is_check = ?, timeout_sec = ?, owner_task_id = ?, archived_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.name ?? cur.name,
        patch.command ?? cur.command,
        patch.kind ?? cur.kind,
        patch.cwd === undefined ? cur.cwd : patch.cwd,
        patch.sortOrder ?? cur.sortOrder,
        (patch.isCheck ?? cur.isCheck) ? 1 : 0,
        patch.timeoutSec === undefined ? cur.timeoutSec : patch.timeoutSec,
        patch.ownerTaskId === undefined ? cur.ownerTaskId : patch.ownerTaskId,
        patch.archivedAt === undefined ? cur.archivedAt : patch.archivedAt,
        now(),
        id,
      );
    return this.getCommand(id);
  }

  async deleteCommand(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM tm_commands WHERE id = ?`).run(id);
  }

  async touchCommandRun(id: string, at: string): Promise<void> {
    this.db.prepare(`UPDATE tm_commands SET last_run_at = ? WHERE id = ?`).run(at, id);
  }

  // ---- tasks ----

  async listTasks(f?: TaskFilter): Promise<Task[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f?.status) {
      where.push(`status = ?`);
      params.push(f.status);
    }
    if (f?.repoId) {
      where.push(`repo_id = ?`);
      params.push(f.repoId);
    }
    if (f?.parentId) {
      where.push(`parent_id = ?`);
      params.push(f.parentId);
    }
    if (f?.groupId) {
      where.push(`group_id = ?`);
      params.push(f.groupId);
    }
    if (f?.featureId) {
      where.push(`feature_id = ?`);
      params.push(f.featureId);
    }
    if (f?.officeId) {
      where.push(`office_id = ?`);
      params.push(f.officeId);
    }
    if (f?.updatedSince) {
      where.push(`updated_at >= ?`);
      params.push(f.updatedSince);
    }
    if (f?.updatedUntil) {
      where.push(`updated_at <= ?`);
      params.push(f.updatedUntil);
    }
    if (f?.repoIds) {
      // An empty scope matches NOTHING rather than everything (storage/types.ts).
      // `1 = 0` keeps the shape of the query — no branch that skips the WHERE.
      if (f.repoIds.length === 0) where.push(`1 = 0`);
      else {
        where.push(`repo_id IN (${f.repoIds.map(() => '?').join(', ')})`);
        params.push(...f.repoIds);
      }
    }
    const sql = `SELECT * FROM tm_tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY priority DESC, sort_order, created_at`;
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToTask);
  }

  async getTask(id: string): Promise<Task | null> {
    const r = this.db.prepare(`SELECT * FROM tm_tasks WHERE id = ?`).get(id);
    return r ? rowToTask(r) : null;
  }

  /** The group columns a row must carry, derived from its parent (docs/grouping.md). */
  private placeSync(id: string, parentId: string | null | undefined): { groupId: string; groupPath: string } {
    if (!parentId) return placement(id, null);
    const p = this.db.prepare(`SELECT id, group_id, group_path FROM tm_tasks WHERE id = ?`).get(parentId) as
      | { id: string; group_id: string | null; group_path: string | null }
      | undefined;
    // Unknown parent: the FK rejects the write anyway, so fall back to a root
    // placement instead of inventing a group id.
    if (!p) return placement(id, null);
    return placement(id, { id: p.id, group_id: p.group_id ?? p.id, group_path: p.group_path ?? ROOT_PATH });
  }

  private insertTaskSync(t: NewTask, actor: string): Task {
    const id = randomUUID();
    const ts = now();
    const place = this.placeSync(id, t.parentId);
    this.db
      .prepare(
        `INSERT INTO tm_tasks (id, title, description, repo_id, parent_id, group_id, group_path, status, source, source_ref, priority, model, effort, category, review, landing, created_by_run, spawn_depth, feature_id, feature_phase, created_at, updated_at, review_model, review_effort, acceptance, checks, kind, loop_goal, loop_max_iterations, loop_budget_usd, brief, depends_on, office_id, role_id, tainted_at, group_name, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (${NEXT_SORT_ORDER_SQL}))`,
      )
      .run(
        id,
        t.title,
        t.description ?? null,
        t.repoId ?? null,
        t.parentId ?? null,
        place.groupId,
        place.groupPath,
        t.status ?? 'draft',
        t.source ?? 'manual',
        t.sourceRef ?? null,
        t.priority ?? 0,
        t.model ?? null,
        t.effort ?? null,
        t.category ?? null,
        t.review == null ? null : t.review ? 1 : 0,
        t.landing ?? null,
        t.createdByRun ?? null,
        t.spawnDepth ?? 0,
        t.featureId ?? null,
        t.featurePhase ?? null,
        ts,
        ts,
        t.reviewModel ?? null,
        t.reviewEffort ?? null,
        t.acceptance ?? null,
        t.checks == null ? null : JSON.stringify(t.checks),
        t.kind ?? 'task',
        t.loopGoal ?? null,
        t.loopMaxIterations ?? null,
        t.loopBudgetUsd ?? null,
        t.brief ?? null,
        t.dependsOn?.length ? JSON.stringify([...new Set(t.dependsOn)]) : null,
        t.officeId ?? null,
        t.roleId ?? null,
        t.taintedAt ?? null,
        // a non-human filing's `new` group (docs/grouping.md § Agent filings) — root rows only
        t.parentId ? null : (t.rootGroupName ?? null),
      );
    const task = rowToTask(this.db.prepare(`SELECT * FROM tm_tasks WHERE id = ?`).get(id));
    this.appendEventSync({
      kind: 'task.created',
      actor,
      taskId: task.id,
      repoId: task.repoId,
      data: {
        title: task.title,
        status: task.status,
        source: task.source,
        spawnDepth: task.spawnDepth,
        groupId: task.groupId,
        // the filing's group decision (docs/grouping.md § Agent filings)
        ...(t.groupDecision ? { group: { ...t.groupDecision, groupId: task.groupId } } : {}),
      },
    });
    return task;
  }

  async createTask(t: NewTask, actor: string): Promise<Task> {
    return this.inTxn(() => this.insertTaskSync(t, actor));
  }

  async createTaskInNamedGroup(
    t: NewTask,
    actor: string,
    g: NamedGroupFiling,
  ): Promise<{ task: Task; joined: NamedGroupCandidate | null }> {
    // better-sqlite3 runs one transaction at a time on its one connection, so
    // the read and the insert below cannot interleave with a racing filer.
    return this.inTxn(() => {
      const all = (sql: string, params: unknown[]) => this.db.prepare(sql).all(...params) as Record<string, unknown>[];
      const key = normalizeGroupName(g.name);
      const joined = g.forceNew
        ? null
        : pickNamedGroup(runWalkSync(namedGroupCandidates(g.repoIds, key, normalizeGroupName), all), key, g.filerUntrusted);
      const task = this.insertTaskSync(namedGroupInsert(t, g, joined), actor);
      return { task, joined };
    });
  }

  async untrustedTaskIds(ids: string[]): Promise<Set<string>> {
    return runWalkSync(untrustedWalk(ids), (sql, params) => this.db.prepare(sql).all(...params) as Record<string, unknown>[]);
  }

  private updateTaskSync(id: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): Task | null {
    const cur = this.db.prepare(`SELECT * FROM tm_tasks WHERE id = ?`).get(id) as any;
    if (!cur) return null;
    const t = rowToTask(cur);
    // Spread keeps undefined values, which would clobber NOT NULL columns — strip them.
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = { ...t, ...clean, updatedAt: now() };
    // Re-parenting moves this task AND everything under it into the new group.
    const moved = next.parentId !== t.parentId;
    let place = { groupId: t.groupId, groupPath: t.groupPath };
    if (moved) {
      if (next.parentId === id) throw new Error('a task cannot be its own parent');
      const p = next.parentId
        ? (this.db.prepare(`SELECT id, group_id, group_path FROM tm_tasks WHERE id = ?`).get(next.parentId) as
            | { id: string; group_id: string | null; group_path: string | null }
            | undefined)
        : undefined;
      if (next.parentId && !p) throw new Error('parent task not found');
      if (p && pathContains(p.group_path ?? ROOT_PATH, id)) {
        throw new Error('re-parenting a task under its own descendant would create a cycle');
      }
      place = placement(
        id,
        p ? { id: p.id, group_id: p.group_id ?? p.id, group_path: p.group_path ?? ROOT_PATH } : null,
      );
      // Descendants first: their match uses this row's OLD path prefix.
      this.db.prepare(MOVE_SUBTREE_SQL).run(...(moveSubtreeParams(
        { id, group_path: t.groupPath },
        place,
        next.updatedAt,
      ) as any[]));
    }
    // group_name/group_color describe a GROUP, and only its root may carry
    // them — a task that just gained a parent drops both.
    const isRoot = place.groupId === id;
    this.db
      .prepare(
        `UPDATE tm_tasks SET title=?, description=?, repo_id=?, parent_id=?, group_id=?, group_path=?, group_name=?, group_color=?, status=?, source=?, source_ref=?, priority=?, model=?, effort=?, category=?, review=?, landing=?, auto_landed_at=?, custom_queue_at=?, feature_id=?, feature_phase=?, result_summary=?, review_summary=?, review_diff_hash=?, review_state=?, review_rounds=?, wake_at=?, error=?, updated_at=?, review_model=?, review_effort=?, base_sha=?, base_ref=?, base_at=?, queue_held_at=?, acceptance=?, checks=?, check_state=?, check_results=?, check_diff_hash=?, loop_goal=?, loop_max_iterations=?, loop_budget_usd=?, loop_iteration=?, loop_state=?, loop_history=?, hidden_at=?, paused_turn=?, shipped_sha=?, shipped_at=? WHERE id=?`,
      )
      .run(
        next.title,
        next.description,
        next.repoId,
        next.parentId,
        place.groupId,
        place.groupPath,
        isRoot ? next.groupName : null,
        isRoot ? next.groupColor : null,
        next.status,
        next.source,
        next.sourceRef,
        next.priority,
        next.model,
        next.effort,
        next.category,
        next.review == null ? null : next.review ? 1 : 0,
        next.landing ?? null,
        next.autoLandedAt ?? null,
        next.customQueueAt ?? null,
        next.featureId,
        next.featurePhase,
        next.resultSummary,
        next.reviewSummary,
        next.reviewDiffHash ?? null,
        next.reviewState ?? null,
        JSON.stringify(next.reviewRounds ?? []),
        next.wakeAt ?? null,
        next.error,
        next.updatedAt,
        next.reviewModel ?? null,
        next.reviewEffort ?? null,
        next.baseSha ?? null,
        next.baseRef ?? null,
        next.baseAt ?? null,
        next.queueHeldAt ?? null,
        next.acceptance ?? null,
        next.checks == null ? null : JSON.stringify(next.checks),
        next.checkState ?? null,
        JSON.stringify(next.checkResults ?? []),
        next.checkDiffHash ?? null,
        next.loopGoal ?? null,
        next.loopMaxIterations ?? null,
        next.loopBudgetUsd ?? null,
        next.loopIteration ?? 0,
        next.loopState ?? null,
        JSON.stringify(next.loopHistory ?? []),
        next.hiddenAt ?? null,
        next.pausedTurn ? JSON.stringify(next.pausedTurn) : null,
        next.shippedSha ?? null,
        next.shippedAt ?? null,
        id,
      );
    return rowToTask(this.db.prepare(`SELECT * FROM tm_tasks WHERE id = ?`).get(id));
  }

  async stepLoop(id: string, from: (LoopState | null)[], patch: LoopStep): Promise<Task | null> {
    const { sets, vals } = loopStepSets(patch);
    const named = from.filter((s): s is LoopState => s !== null);
    const r = this.db.prepare(stepLoopSql(sets, from)).get(...vals, now(), id, ...named);
    return r ? rowToTask(r) : null;
  }

  async bumpTaskAttempts(id: string): Promise<Task | null> {
    const r = this.db.prepare(`UPDATE tm_tasks SET attempts = attempts + 1 WHERE id = ? RETURNING *`).get(id);
    return r ? rowToTask(r) : null;
  }

  async setTaskHidden(id: string, hidden: boolean): Promise<Task | null> {
    const r = this.db
      .prepare(`UPDATE tm_tasks SET hidden_at = ?, updated_at = ? WHERE id = ?${hidden ? ` AND status NOT IN ('running', 'waiting')` : ''} RETURNING *`)
      .get(hidden ? now() : null, now(), id);
    return r ? rowToTask(r) : null;
  }

  async keepTaskInInbox(id: string, until: string): Promise<Task | null> {
    const r = this.db
      .prepare(`UPDATE tm_tasks SET inbox_kept_until = ?, updated_at = ? WHERE id = ? AND status = 'draft' RETURNING *`)
      .get(until, now(), id);
    return r ? rowToTask(r) : null;
  }

  async updateTaskWorktree(id: string, patch: WorktreePatch): Promise<Task | null> {
    const q = worktreePatchSql(id, patch);
    if (!q) return this.getTask(id);
    const r = this.db.prepare(q.sql).get(...q.params);
    return r ? rowToTask(r) : null;
  }

  async updateTask(id: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): Promise<Task | null> {
    // A re-parent rewrites the moved subtree too, so it must be one transaction.
    return this.inTxn(() => this.updateTaskSync(id, patch));
  }

  async moveTask(id: string, parentId: string | null, anchor: MoveAnchor, actor: string): Promise<Task[] | null> {
    return this.inTxn((): Task[] | null => {
      const cur = this.db.prepare(`SELECT * FROM tm_tasks WHERE id = ?`).get(id);
      if (!cur) return null;
      const before = rowToTask(cur);
      // Same guards and subtree move as a PATCH parentId (throws roll back).
      if (parentId !== before.parentId) this.updateTaskSync(id, { parentId });
      const changed = new Set<string>([id]);
      if (typeof anchor === 'object') {
        const q = siblingsQuery(parentId, id);
        const pos = keyNextTo(this.db.prepare(q.sql).all(...q.params) as any[], id, anchor);
        if ('key' in pos) {
          this.db.prepare(`UPDATE tm_tasks SET sort_order = ? WHERE id = ?`).run(pos.key, id);
        } else {
          const set = this.db.prepare(`UPDATE tm_tasks SET sort_order = ? WHERE id = ?`);
          pos.renumber.forEach((rid, i) => {
            set.run(i + 1, rid);
            changed.add(rid);
          });
        }
      } else if (anchor === 'end') {
        const k = (this.db.prepare(NEXT_SORT_ORDER_SQL).get() as { k: number }).k;
        this.db.prepare(`UPDATE tm_tasks SET sort_order = ? WHERE id = ?`).run(k, id);
      }
      const task = rowToTask(this.db.prepare(`SELECT * FROM tm_tasks WHERE id = ?`).get(id));
      this.appendEventSync({
        kind: 'task.moved',
        actor,
        taskId: id,
        repoId: task.repoId,
        data: {
          fromParentId: before.parentId,
          parentId,
          fromGroupId: before.groupId,
          groupId: task.groupId,
          anchor,
          renumbered: changed.size > 1 ? changed.size : undefined,
        },
      });
      const rows = new Map<string, Task>();
      for (const r of this.db.prepare(`SELECT * FROM tm_tasks WHERE group_id = ?`).all(task.groupId) as any[]) {
        rows.set(r.id, rowToTask(r));
      }
      for (const rid of changed) {
        if (rows.has(rid)) continue;
        const r = this.db.prepare(`SELECT * FROM tm_tasks WHERE id = ?`).get(rid);
        if (r) rows.set(rid, rowToTask(r));
      }
      return [...rows.values()];
    });
  }

  async reorderCustomQueue(id: string, anchor: QueueMoveAnchor, actor: string): Promise<{ refused: string } | { tasks: Task[] } | null> {
    return this.inTxn((): { refused: string } | { tasks: Task[] } | null => {
      const cur = this.db.prepare(`SELECT * FROM tm_tasks WHERE id = ?`).get(id) as any;
      if (!cur) return null;
      const plan = planQueueReorder(cur, this.db.prepare(CUSTOM_QUEUE_WAITING_SQL).all() as any[], anchor);
      if ('refused' in plan) return plan;
      if (!plan.writes.length) return { tasks: [] };
      // Only the mark: updated_at stays, like moveTask's sort_order writes.
      const set = this.db.prepare(`UPDATE tm_tasks SET custom_queue_at = ? WHERE id = ?`);
      for (const w of plan.writes) set.run(w.at, w.id);
      const task = rowToTask(this.db.prepare(`SELECT * FROM tm_tasks WHERE id = ?`).get(id));
      this.appendEventSync({
        kind: 'task.queue',
        actor,
        taskId: id,
        repoId: task.repoId,
        data: reorderAudit(anchor, plan),
      });
      const get = this.db.prepare(`SELECT * FROM tm_tasks WHERE id = ?`);
      const ids = [id, ...plan.writes.map((w) => w.id).filter((rid) => rid !== id)];
      return { tasks: ids.map((rid) => rowToTask(get.get(rid))) };
    });
  }

  async deleteTask(id: string): Promise<void> {
    const del = this.db.transaction((taskId: string) => {
      // Orphaned children become roots of their own groups, carrying their
      // descendants with them (docs/grouping.md § Deleting a task).
      const kids = this.db
        .prepare(`SELECT id, group_path FROM tm_tasks WHERE parent_id = ?`)
        .all(taskId) as { id: string; group_path: string | null }[];
      const ts = now();
      for (const k of kids) {
        const node = { id: k.id, group_path: k.group_path ?? ROOT_PATH };
        const place = placement(k.id, null);
        this.db.prepare(MOVE_SUBTREE_SQL).run(...(moveSubtreeParams(node, place, ts) as any[]));
        this.db
          .prepare(`UPDATE tm_tasks SET parent_id = NULL, group_id = ?, group_path = ?, updated_at = ? WHERE id = ?`)
          .run(place.groupId, place.groupPath, ts, k.id);
      }
      this.db.prepare(`DELETE FROM tm_proposals WHERE task_id = ?`).run(taskId);
      this.db.prepare(`UPDATE tm_runs SET task_id = NULL WHERE task_id = ?`).run(taskId);
      this.db.prepare(`DELETE FROM tm_tasks WHERE id = ?`).run(taskId);
    });
    del(id);
  }

  /**
   * The ONE value OFFICE_CLAIM_GATE binds: the offices whose day budget
   * tripped on their own office-local day (queue-sql.ts — SQLite has no zones).
   */
  private officeTripped(): string {
    const rows = this.db.prepare(OFFICE_TRIPPED_SQL).all() as { id: string; timezone: string; budget_tripped_on: string | null }[];
    return officeTrippedParam(
      rows.map((r) => ({ id: r.id, timezone: r.timezone, budgetTrippedOn: r.budget_tripped_on })),
      Date.now(),
    );
  }

  async claimNextQueuedTask(actor: string, skipRepoIds: string[] = []): Promise<Task | null> {
    // .get() (not .run()) — RETURNING rows are discarded by .run().
    // Atomic only because the orchestrator is single-process; a Postgres
    // multi-writer setup would need FOR UPDATE SKIP LOCKED (Phase 7 note).
    return this.inTxn((): Task | null => {
      const r = this.db
        .prepare(
          `UPDATE tm_tasks SET status = 'running', updated_at = ?
           WHERE id = (SELECT t.id FROM tm_tasks t WHERE t.status = 'queued' AND t.repo_id IS NOT NULL
                         AND t.custom_queue_at IS NULL
                         AND t.queue_held_at IS NULL
                         AND ${FEATURE_CLAIM_GATE}
                         AND ${OFFICE_CLAIM_GATE}
                         AND ${REPO_EXCLUSIVE_GATE}${skipRepos(skipRepoIds.length)}
                       ORDER BY ${MANUAL_CLAIM_ORDER} LIMIT 1)
           RETURNING *`,
        )
        .get(now(), this.officeTripped(), ...skipRepoIds);
      if (!r) return null;
      const task = rowToTask(r);
      this.appendEventSync({
        kind: 'task.transition',
        actor,
        taskId: task.id,
        repoId: task.repoId,
        data: { from: 'queued', to: 'running', claim: 'base' },
      });
      return task;
    });
  }

  async peekCustomQueue(skipRepoIds: string[] = []): Promise<Task | null> {
    const r = this.db
      .prepare(
        `SELECT t.* FROM tm_tasks t WHERE ${CUSTOM_QUEUE_HEAD_WHERE} AND ${FEATURE_CLAIM_GATE}
           AND ${OFFICE_CLAIM_GATE}${skipRepos(skipRepoIds.length)}
         ${CUSTOM_QUEUE_HEAD_ORDER}`,
      )
      .get(this.officeTripped(), ...skipRepoIds);
    return r ? rowToTask(r) : null;
  }

  async claimCustomQueuedTask(id: string, actor: string): Promise<Task | null> {
    // The eligibility re-check and the claim live in ONE statement: the row
    // is claimed only while it is still the head of ITS repo, so a second
    // same-repo member can never be claimed once the first is `running`
    // (heldBy in CUSTOM_QUEUE_HEAD_WHERE), nor ahead of an older one.
    return this.inTxn((): Task | null => {
      const r = this.db
        .prepare(
          `UPDATE tm_tasks SET status = 'running', updated_at = ?
           WHERE id = ? AND id = (SELECT t.id FROM tm_tasks t WHERE ${CUSTOM_QUEUE_HEAD_WHERE}
                                    AND ${FEATURE_CLAIM_GATE} AND ${OFFICE_CLAIM_GATE} AND ${CUSTOM_QUEUE_SAME_REPO}
                                  ${CUSTOM_QUEUE_HEAD_ORDER})
           RETURNING *`,
        )
        .get(now(), id, this.officeTripped(), id);
      if (!r) return null;
      const task = rowToTask(r);
      this.appendEventSync({
        kind: 'task.transition',
        actor,
        taskId: task.id,
        repoId: task.repoId,
        data: { from: 'queued', to: 'running', claim: 'custom-queue' },
      });
      return task;
    });
  }

  async transitionTask(
    id: string,
    from: Task['status'][],
    to: Task['status'],
    actor: string,
    patch?: Partial<Pick<Task, 'error' | 'resultSummary' | 'reviewState' | 'checkState' | 'queueHeldAt' | 'pausedTurn' | 'waitFor' | 'autoLandedAt' | 'loopState' | 'shippedSha' | 'shippedAt'>>,
    audit?: Record<string, unknown>,
  ): Promise<Task | null> {
    // Conditional single-statement transition — immune to check-then-set races
    // between route handlers, hook callbacks and the claim loop. Patch keys are
    // applied only when present, so `error: null` explicitly clears.
    const sets = ['status = ?', 'updated_at = ?'];
    const vals: unknown[] = [to, now()];
    if (patch && 'error' in patch) {
      sets.push('error = ?');
      vals.push(patch.error ?? null);
    }
    if (patch && 'resultSummary' in patch) {
      sets.push('result_summary = ?');
      vals.push(patch.resultSummary ?? null);
    }
    if (patch && 'reviewState' in patch) {
      sets.push('review_state = ?');
      vals.push(patch.reviewState ?? null);
    }
    if (patch && 'checkState' in patch) {
      sets.push('check_state = ?');
      vals.push(patch.checkState ?? null);
    }
    if (patch && 'loopState' in patch) {
      sets.push('loop_state = ?');
      vals.push(patch.loopState ?? null);
    } else if (to !== 'running' && to !== 'waiting') {
      // A loop's in-flight states exist only while the task is `running`
      // (docs/loops.md § State): whatever moves it out — cancel, Undo, a
      // budget refusal, an exit, boot recovery — leaves it `paused`.
      sets.push(LOOP_LEAVES_RUNNING_SQL);
    }
    // An Undo-start hold (docs/queue.md § Undo start) means "queued, but not
    // yet" and exists only for the transition that sets it: every other status
    // change releases it, so a hold can never outlive the `queued` it was for.
    if (patch && 'queueHeldAt' in patch) {
      sets.push('queue_held_at = ?');
      vals.push(patch.queueHeldAt ?? null);
    } else {
      sets.push('queue_held_at = NULL');
    }
    // A Pause-all marker (docs/pause.md) is owed to the turn that was cut
    // short: any other move means a human (or Continue itself) took the task
    // over, so it is released unless the transition is the one setting it.
    if (patch && 'pausedTurn' in patch) {
      sets.push('paused_turn = ?');
      vals.push(patch.pausedTurn ? JSON.stringify(patch.pausedTurn) : null);
    } else {
      sets.push('paused_turn = NULL');
    }
    // A worker's wait on another task (docs/task-waits.md) is the `blocked`
    // park that sets it: any other move — the resume, Unblock, a cancel —
    // ends the wait.
    if (patch && 'waitFor' in patch) {
      sets.push('wait_for = ?');
      vals.push(patch.waitFor ? JSON.stringify(patch.waitFor) : null);
    } else {
      sets.push('wait_for = NULL');
    }
    // Hiding (docs/design.md § Hidden tasks) is for a task at rest: any status
    // change makes it visible again, so a hidden task can never be working.
    sets.push('hidden_at = NULL');
    // A Keep on a stale draft (docs/inbox.md § Stale drafts) is about the draft
    // as it sat: any status change ends it.
    sets.push('inbox_kept_until = NULL');
    // A terminal status ends the task's custom-queue membership (docs/queue.md):
    // a mark must never outlive the work, or a later follow-up into `review`
    // would hold its repo's place in the queue again.
    if (TERMINAL_TASK_STATUSES.includes(to)) sets.push('custom_queue_at = NULL');
    // The auto-landed stamp describes the CURRENT landing only
    // (docs/design.md § Landing tiers): set by the landing itself, dropped by
    // any move off done/published (a retry, a reopen).
    if (patch && 'autoLandedAt' in patch) {
      sets.push('auto_landed_at = ?');
      vals.push(patch.autoLandedAt ?? null);
    } else if (to !== 'done' && to !== 'published') {
      sets.push('auto_landed_at = NULL');
    }
    // Observed publish (docs/publish.md § Observed publish): the shipped sha
    // describes the CURRENT landing too — set by the landing that saw it,
    // dropped by any move back into work (a follow-up, retry, cancel).
    if (patch && 'shippedSha' in patch) {
      sets.push('shipped_sha = ?', 'shipped_at = ?');
      vals.push(patch.shippedSha ?? null, patch.shippedSha ? (patch.shippedAt ?? new Date().toISOString()) : null);
    } else if (to !== 'review' && to !== 'done' && to !== 'published') {
      sets.push('shipped_sha = NULL', 'shipped_at = NULL');
    }
    const placeholders = from.map(() => '?').join(', ');
    return this.inTxn((): Task | null => {
      const prev = this.db.prepare(`SELECT status FROM tm_tasks WHERE id = ?`).get(id) as
        | { status: string }
        | undefined;
      const r = this.db
        .prepare(`UPDATE tm_tasks SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders}) RETURNING *`)
        .get(...vals, id, ...from);
      if (!r) return null;
      const task = rowToTask(r);
      this.appendEventSync({
        kind: 'task.transition',
        actor,
        taskId: task.id,
        repoId: task.repoId,
        data: { ...audit, from: prev?.status ?? null, to },
      });
      return task;
    });
  }

  async setTaskDependsOn(id: string, dependsOn: string[], actor: string): Promise<Task | null> {
    return this.inTxn((): Task | null => {
      const ids = [...new Set(dependsOn)];
      const r = this.db
        .prepare(`UPDATE tm_tasks SET depends_on = ?, updated_at = ? WHERE id = ? RETURNING *`)
        .get(ids.length ? JSON.stringify(ids) : null, now(), id);
      if (!r) return null;
      const t = rowToTask(r);
      this.appendEventSync({ kind: 'task.depends-on', actor, taskId: t.id, repoId: t.repoId, data: { dependsOn: ids } });
      return t;
    });
  }

  async resolveChildCompletion(childId: string, parentDoneStatus: 'review' | 'done', actor: string): Promise<Task | null> {
    return this.inTxn((): Task | null => {
      const child = this.db.prepare(`SELECT parent_id FROM tm_tasks WHERE id = ?`).get(childId) as
        | { parent_id: string | null }
        | undefined;
      if (!child?.parent_id) return null;
      const rows = this.db.prepare(RESOLVING_CHILDREN_SQL).all(child.parent_id) as {
        status: string;
      }[];
      const unresolved = rows.filter((r) => !TERMINAL_TASK_STATUSES.includes(r.status as Task['status'])).length;
      if (unresolved > 0) return null;
      const failed = rows.filter((r) => r.status === 'failed').length;
      if (failed > 0) {
        // Conditional on blocked: a done/review parent with agent-filed
        // children must not get a failure scribbled on it (review R3).
        const r = this.db
          .prepare(`UPDATE tm_tasks SET error = ?, updated_at = ? WHERE id = ? AND status = 'blocked' AND wait_for IS NULL RETURNING *`)
          .get(`${failed} subtask(s) failed`, now(), child.parent_id);
        if (!r) return null;
        const t = rowToTask(r);
        this.appendEventSync({
          kind: 'task.transition',
          actor,
          taskId: t.id,
          repoId: t.repoId,
          data: { from: 'blocked', to: 'blocked', childrenFailed: failed },
        });
        return t;
      }
      const r = this.db
        .prepare(`UPDATE tm_tasks SET status = ?, updated_at = ? WHERE id = ? AND status = 'blocked' AND wait_for IS NULL RETURNING *`)
        .get(parentDoneStatus, now(), child.parent_id);
      if (!r) return null;
      const t = rowToTask(r);
      this.appendEventSync({
        kind: 'task.transition',
        actor,
        taskId: t.id,
        repoId: t.repoId,
        data: { from: 'blocked', to: parentDoneStatus, resolvedChildren: rows.length },
      });
      return t;
    });
  }

  async countChildren(parentId: string): Promise<ChildCounts> {
    const rows = this.db.prepare(`SELECT status FROM tm_tasks WHERE parent_id = ?`).all(parentId) as {
      status: string;
    }[];
    const total = rows.length;
    const done = rows.filter((r) => r.status === 'done').length;
    const failed = rows.filter((r) => r.status === 'failed').length;
    const resolved = rows.filter((r) => TERMINAL_TASK_STATUSES.includes(r.status as Task['status'])).length;
    return { total, done, failed, unresolved: total - resolved };
  }

  // ---- runs ----

  async listRuns(f?: RunFilter): Promise<Run[]> {
    const { sql, params } = runListSql(f);
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToRun);
  }


  async getRun(id: string): Promise<Run | null> {
    const r = this.db.prepare(`SELECT * FROM tm_runs WHERE id = ?`).get(id);
    return r ? rowToRun(r) : null;
  }

  async getRunByToken(token: string): Promise<Run | null> {
    if (!token) return null;
    const r = this.db.prepare(`SELECT * FROM tm_runs WHERE run_token = ?`).get(token);
    return r ? rowToRun(r) : null;
  }

  async countTasksCreatedByRun(runId: string): Promise<number> {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM tm_tasks WHERE created_by_run = ?`).get(runId) as {
      n: number;
    };
    return Number(r.n);
  }

  async countQueuedAgentTasks(): Promise<number> {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM tm_tasks WHERE status = 'queued' AND created_by_run IS NOT NULL AND office_id IS NULL`)
      .get() as { n: number };
    return Number(r.n);
  }

  async claimNextAgentChildTask(eligibleRunIds: string[], actor: string, skipRepoIds: string[] = []): Promise<Task | null> {
    if (eligibleRunIds.length === 0) return null;
    const placeholders = eligibleRunIds.map(() => '?').join(', ');
    return this.inTxn((): Task | null => {
      const r = this.db
        .prepare(
          `UPDATE tm_tasks SET status = 'running', updated_at = ?
           WHERE id = (SELECT t.id FROM tm_tasks t
                       WHERE t.status = 'queued' AND t.repo_id IS NOT NULL AND t.created_by_run IN (${placeholders})
                         AND t.custom_queue_at IS NULL
                         AND t.queue_held_at IS NULL
                         AND ${FEATURE_OVERFLOW_GATE}
                         AND ${OFFICE_CLAIM_GATE}
                         AND ${REPO_EXCLUSIVE_GATE}${skipRepos(skipRepoIds.length)}
                       ORDER BY t.created_at LIMIT 1)
           RETURNING *`,
        )
        .get(now(), ...eligibleRunIds, this.officeTripped(), ...skipRepoIds);
      if (!r) return null;
      const task = rowToTask(r);
      this.appendEventSync({
        kind: 'task.transition',
        actor,
        taskId: task.id,
        repoId: task.repoId,
        data: { from: 'queued', to: 'running', claim: 'overflow', createdByRun: task.createdByRun },
      });
      return task;
    });
  }

  async createRun(r: NewRun): Promise<Run> {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO tm_runs (id, task_id, repo_id, mode, kind, subject_id, label, status, pid, model, effort, run_token, resumed_from, stats_baseline, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        r.taskId ?? null,
        r.repoId ?? null,
        r.mode,
        r.kind ?? (r.mode === 'worker' ? 'worker' : null),
        r.subjectId ?? null,
        r.label ?? null,
        r.pid ?? null,
        r.model ?? null,
        r.effort ?? null,
        r.runToken ?? null,
        r.resumedFrom ?? null,
        r.statsBaseline ? JSON.stringify(r.statsBaseline) : null,
        now(),
      );
    return (await this.getRun(id))!;
  }

  async updateRun(
    id: string,
    patch: Partial<
      Pick<Run, 'status' | 'pid' | 'exitCode' | 'needsAttention' | 'idle' | 'sessionId' | 'transcriptPath' | 'stats' | 'endedAt'>
    >,
  ): Promise<Run | null> {
    const cur = await this.getRun(id);
    if (!cur) return null;
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = { ...cur, ...clean };
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE tm_runs SET status=?, pid=?, exit_code=?, needs_attention=?, idle=?, session_id=?, transcript_path=?, stats=?, cost_usd=?, ended_at=? WHERE id=?`,
        )
        .run(
          next.status,
          next.pid,
          next.exitCode,
          next.needsAttention ? 1 : 0,
          next.idle ? 1 : 0,
          next.sessionId,
          next.transcriptPath,
          next.stats ? JSON.stringify(next.stats) : null,
          runCost(next.stats),
          next.endedAt,
          id,
        );
      // The task's roll-up moves with its runs' stats (docs/token-budget.md § Fuses).
      const taskId = 'stats' in clean ? runTaskId(next) : null;
      if (taskId) this.db.prepare(`UPDATE tm_tasks SET cost_usd = ${taskCostSql('tm_tasks.id')} WHERE id = ?`).run(taskId);
    });
    write();
    return this.getRun(id);
  }

  async bumpRunPeakMem(id: string, mb: number): Promise<Run | null> {
    if (!(mb > 0)) return null;
    const r = this.db.prepare(`UPDATE tm_runs SET peak_mem_mb = ? WHERE id = ? AND (peak_mem_mb IS NULL OR peak_mem_mb < ?)`).run(mb, id, mb);
    return r.changes > 0 ? this.getRun(id) : null;
  }

  // ---- dispatches (docs/dispatch.md) ----

  async listDispatches(f?: DispatchFilter): Promise<Dispatch[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f?.taskId) {
      where.push(`(from_task_id = ? OR to_task_id = ?)`);
      params.push(f.taskId, f.taskId);
    }
    if (f?.toTaskId) {
      where.push(`to_task_id = ?`);
      params.push(f.toTaskId);
    }
    if (f?.status) {
      where.push(`status = ?`);
      params.push(f.status);
    }
    if (f?.since) {
      where.push(`created_at >= ?`);
      params.push(f.since);
    }
    const sql = `SELECT * FROM tm_dispatches ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC`;
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToDispatch);
  }

  async getDispatch(id: string): Promise<Dispatch | null> {
    const r = this.db.prepare(`SELECT * FROM tm_dispatches WHERE id = ?`).get(id);
    return r ? rowToDispatch(r) : null;
  }

  async createDispatch(d: NewDispatch): Promise<Dispatch> {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO tm_dispatches (id, from_task_id, from_run_id, to_task_id, message, intent, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(id, d.fromTaskId, d.fromRunId ?? null, d.toTaskId, d.message, d.intent, now());
    return (await this.getDispatch(id))!;
  }

  async settleDispatch(
    id: string,
    status: 'delivered' | 'failed' | 'cancelled',
    note?: string | null,
  ): Promise<Dispatch | null> {
    const r = this.db
      .prepare(
        `UPDATE tm_dispatches SET status = ?, note = ?, delivered_at = ? WHERE id = ? AND status = 'pending' RETURNING *`,
      )
      .get(status, note ?? null, status === 'delivered' ? now() : null, id);
    return r ? rowToDispatch(r) : null;
  }

  async countDispatchesByRun(runId: string): Promise<number> {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM tm_dispatches WHERE from_run_id = ?`).get(runId) as {
      n: number;
    };
    return Number(r.n);
  }

  async countDispatchesBetween(taskA: string, taskB: string): Promise<number> {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM tm_dispatches WHERE (from_task_id = ? AND to_task_id = ?) OR (from_task_id = ? AND to_task_id = ?)`,
      )
      .get(taskA, taskB, taskB, taskA) as { n: number };
    return Number(r.n);
  }


  // ---- questions (docs/questions.md) ----

  async listQuestions(f?: QuestionFilter): Promise<Question[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f?.status) {
      where.push(`status = ?`);
      params.push(f.status);
    }
    if (f?.taskId) {
      where.push(`task_id = ?`);
      params.push(f.taskId);
    }
    if (f?.runId) {
      where.push(`run_id = ?`);
      params.push(f.runId);
    }
    const sql = `SELECT * FROM tm_questions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC`;
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToQuestion);
  }

  // ---- scheduled jobs (docs/jobs.md; SQL shared in job-sql.ts) ----

  async listJobs(f?: JobFilter): Promise<Job[]> {
    const { sql, params } = jobListSql(f);
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToJob);
  }

  async getJob(id: string): Promise<Job | null> {
    const r = this.db.prepare(`SELECT * FROM tm_jobs WHERE id = ?`).get(id);
    return r ? rowToJob(r) : null;
  }

  async createJob(j: NewJob): Promise<Job> {
    const id = randomUUID();
    this.db.prepare(JOB_INSERT_SQL).run(...jobInsertParams(id, j, now()));
    return (await this.getJob(id))!;
  }

  async updateJob(id: string, p: JobPatch): Promise<Job | null> {
    const q = jobPatchSql(id, p, now());
    if (!q) return this.getJob(id);
    const r = this.db.prepare(q.sql).get(...q.params);
    return r ? rowToJob(r) : null;
  }

  async deleteJob(id: string): Promise<boolean> {
    this.db.prepare(JOB_RUNS_DELETE_SQL).run(id);
    return this.db.prepare(JOB_DELETE_SQL).run(id).changes > 0;
  }

  async countLiveJobs(repoId: string): Promise<number> {
    return Number((this.db.prepare(JOB_SCHEDULED_COUNT_SQL).get(repoId) as any)?.n ?? 0);
  }

  async claimDueJob(id: string, at: string, force = false): Promise<Job | null> {
    const { sql, params } = jobClaimSql(id, at, force);
    const r = this.db.prepare(sql).get(...params);
    return r ? rowToJob(r) : null;
  }

  async stepJob(
    id: string,
    from: JobStatus[],
    to: JobStatus,
    opts: { nextRunAt?: string | null; last?: { runId: string | null; verdict: JobVerdict; summary: string | null; at: string; counted: boolean } } = {},
  ): Promise<Job | null> {
    const { sql, params } = jobStepSql(id, from, to, now(), opts);
    const r = this.db.prepare(sql).get(...params);
    return r ? rowToJob(r) : null;
  }

  async createJobRun(r: { jobId: string; runNumber: number; firedBy: string }): Promise<JobRun> {
    const id = randomUUID();
    this.db.prepare(JOB_RUN_INSERT_SQL).run(id, r.jobId, null, r.runNumber, r.firedBy, now());
    return (await this.getJobRun(id))!;
  }

  async setJobRunRunId(id: string, runId: string): Promise<void> {
    this.db.prepare(JOB_RUN_SET_RUN_ID_SQL).run(runId, id);
  }

  async finishJobRun(id: string, f: JobRunFinish): Promise<JobRun | null> {
    const r = this.db.prepare(JOB_RUN_FINISH_SQL).get(...jobRunFinishParams(id, f, now()));
    return r ? rowToJobRun(r) : null;
  }

  async getJobRun(id: string): Promise<JobRun | null> {
    const r = this.db.prepare(`SELECT * FROM tm_job_runs WHERE id = ?`).get(id);
    return r ? rowToJobRun(r) : null;
  }

  async listJobRuns(jobId: string): Promise<JobRun[]> {
    return (this.db.prepare(JOB_RUNS_FOR_JOB_SQL).all(jobId) as any[]).map(rowToJobRun);
  }

  async listOpenJobRuns(): Promise<JobRun[]> {
    return (this.db.prepare(JOB_RUNS_OPEN_SQL).all() as any[]).map(rowToJobRun);
  }

  async listUnfinishedJobRuns(): Promise<JobRun[]> {
    return (this.db.prepare(JOB_RUNS_UNFINISHED_SQL).all() as any[]).map(rowToJobRun);
  }

  async acknowledgeJobRun(id: string): Promise<JobRun | null> {
    const r = this.db.prepare(JOB_RUN_ACK_SQL).get(now(), id);
    return r ? rowToJobRun(r) : null;
  }

  async acknowledgeJobRuns(jobId: string): Promise<JobRun[]> {
    return (this.db.prepare(JOB_RUNS_ACK_ALL_SQL).all(now(), jobId) as any[]).map(rowToJobRun);
  }

  // ---- approvals (docs/approvals.md; SQL shared in approval-sql.ts) ----

  async listApprovals(f?: ApprovalFilter): Promise<Approval[]> {
    const { sql, params } = approvalListSql(f);
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToApproval);
  }

  async getApproval(id: string): Promise<Approval | null> {
    const r = this.db.prepare(`SELECT * FROM tm_approvals WHERE id = ?`).get(id);
    return r ? rowToApproval(r) : null;
  }

  async createApproval(a: NewApproval): Promise<Approval> {
    const id = randomUUID();
    this.db.prepare(APPROVAL_INSERT_SQL).run(...approvalInsertParams(id, a, now()));
    return (await this.getApproval(id))!;
  }

  async decideApproval(id: string, status: 'approved' | 'rejected', actor: string, result: string | null = null): Promise<Approval | null> {
    const r = this.db.prepare(APPROVAL_DECIDE_SQL).get(status, actor, now(), result, id);
    return r ? rowToApproval(r) : null;
  }

  async stepApproval(id: string, from: ApprovalStatus[], to: ApprovalStatus, result: string | null = null): Promise<Approval | null> {
    const { sql, params } = approvalStepSql(from, to, result, now(), id);
    const r = this.db.prepare(sql).get(...params);
    return r ? rowToApproval(r) : null;
  }

  async expireApprovals(from: ApprovalStatus[], note: string): Promise<Approval[]> {
    const { sql, params } = approvalExpireSql(from, note, now());
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToApproval);
  }

  // ---- web push devices (docs/push.md) ----

  async listPushDevices(): Promise<PushDeviceRecord[]> {
    return this.db.prepare(`SELECT * FROM tm_push_devices ORDER BY created_at`).all().map(rowToPushDevice);
  }

  async upsertPushDevice(d: NewPushDevice): Promise<PushDeviceRecord> {
    const t = now();
    const r = this.db
      .prepare(PUSH_UPSERT_SQL)
      .get(randomUUID(), d.endpoint, d.p256dh, d.auth, d.label, JSON.stringify(d.kinds), t, t);
    return rowToPushDevice(r);
  }

  async updatePushDevice(id: string, patch: { label?: string; kinds?: PushKind[] }): Promise<PushDeviceRecord | null> {
    const r = this.db
      .prepare(
        `UPDATE tm_push_devices SET label = COALESCE(?, label), kinds = COALESCE(?, kinds), updated_at = ? WHERE id = ? RETURNING *`,
      )
      .get(patch.label ?? null, patch.kinds ? JSON.stringify(patch.kinds) : null, now(), id);
    return r ? rowToPushDevice(r) : null;
  }

  async deletePushDevice(id: string): Promise<boolean> {
    return this.db.prepare(`DELETE FROM tm_push_devices WHERE id = ?`).run(id).changes > 0;
  }

  async recordPushResult(id: string, error: string | null): Promise<void> {
    if (error === null) this.db.prepare(PUSH_RESULT_OK_SQL).run(now(), id);
    else this.db.prepare(PUSH_RESULT_FAIL_SQL).run(error, id);
  }

  async getQuestion(id: string): Promise<Question | null> {
    const r = this.db.prepare(`SELECT * FROM tm_questions WHERE id = ?`).get(id);
    return r ? rowToQuestion(r) : null;
  }

  async createQuestion(q: NewQuestion): Promise<Question> {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO tm_questions (id, task_id, run_id, tool_use_id, status, questions, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(id, q.taskId, q.runId, q.toolUseId, JSON.stringify(q.questions), now());
    return (await this.getQuestion(id))!;
  }

  async answerQuestion(id: string, answers: Record<string, string>, actor: string): Promise<Question | null> {
    const r = this.db
      .prepare(
        `UPDATE tm_questions SET status = 'answered', answers = ?, answered_by = ?, answered_at = ? WHERE id = ? AND status = 'pending' RETURNING *`,
      )
      .get(JSON.stringify(answers), actor, now(), id);
    return r ? rowToQuestion(r) : null;
  }

  async setQuestionAnswers(id: string, answers: Record<string, string>): Promise<void> {
    this.db.prepare(`UPDATE tm_questions SET answers = ? WHERE id = ?`).run(JSON.stringify(answers), id);
  }

  async expireQuestions(f: { runId?: string; taskId?: string }, note: string): Promise<Question[]> {
    const where: string[] = [`status = 'pending'`];
    const params: unknown[] = [note, now()];
    if (f.runId) {
      where.push(`run_id = ?`);
      params.push(f.runId);
    }
    if (f.taskId) {
      where.push(`task_id = ?`);
      params.push(f.taskId);
    }
    const rows = this.db
      .prepare(`UPDATE tm_questions SET status = 'expired', note = ?, answered_at = ? WHERE ${where.join(' AND ')} RETURNING *`)
      .all(...params) as any[];
    return rows.map(rowToQuestion);
  }

  // ---- chats (docs/chat.md) ----

  async listChats(repoId?: string, officeId?: string): Promise<Chat[]> {
    const conds: string[] = [];
    const params: string[] = [];
    if (repoId) {
      conds.push(`repo_id = ?`);
      params.push(repoId);
    }
    if (officeId) {
      conds.push(`office_id = ?`);
      params.push(officeId);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    // A brand-new chat has no messages yet, so it must sort by created_at or
    // it would land at the bottom of the list the moment it is opened.
    const sql = `SELECT * FROM tm_chats ${where} ORDER BY COALESCE(last_message_at, created_at) DESC, id DESC`;
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToChat);
  }

  async getChat(id: string): Promise<Chat | null> {
    const r = this.db.prepare(`SELECT * FROM tm_chats WHERE id = ?`).get(id);
    return r ? rowToChat(r) : null;
  }

  async createChat(c: NewChat): Promise<Chat> {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO tm_chats (id, repo_id, title, model, effort, mode, status, turns, cost_usd, created_at, updated_at, office_id, participants, planner_workspace_id)
         VALUES (?, ?, ?, ?, ?, ?, 'idle', 0, 0, ?, ?, ?, ?, ?)`,
      )
      .run(id, c.repoId, c.title, c.model, c.effort ?? null, c.mode, ts, ts, c.officeId ?? null, JSON.stringify(c.participants ?? []), c.plannerWorkspaceId ?? null);
    return (await this.getChat(id))!;
  }

  async updateChat(id: string, patch: ChatPatch): Promise<Chat | null> {
    const cur = await this.getChat(id);
    if (!cur) return null;
    const next = {
      title: patch.title ?? cur.title,
      model: patch.model ?? cur.model,
      effort: patch.effort === undefined ? cur.effort : patch.effort,
      mode: patch.mode ?? cur.mode,
    };
    this.db
      .prepare(`UPDATE tm_chats SET title = ?, model = ?, effort = ?, mode = ?, updated_at = ? WHERE id = ?`)
      .run(next.title, next.model, next.effort, next.mode, now(), id);
    return this.getChat(id);
  }

  async deleteChat(id: string): Promise<boolean> {
    return this.inTxn(() => {
      const r = this.db.prepare(`DELETE FROM tm_chats WHERE id = ?`).run(id);
      if (r.changes === 0) return false;
      // No FK to cascade for us (migration 19) — the transcript goes with it.
      this.db.prepare(`DELETE FROM tm_chat_messages WHERE chat_id = ?`).run(id);
      return true;
    });
  }

  async listChatMessages(chatId: string, limit?: number): Promise<ChatMessage[]> {
    if (limit && limit > 0) {
      // Newest `limit`, returned oldest-first: the tail is what a chat window
      // shows, and reversing in SQL keeps the caller from having to know that.
      const rows = this.db
        .prepare(`SELECT * FROM tm_chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?`)
        .all(chatId, limit) as any[];
      return rows.reverse().map(rowToChatMessage);
    }
    return (this.db.prepare(`SELECT * FROM tm_chat_messages WHERE chat_id = ? ORDER BY id ASC`).all(chatId) as any[]).map(
      rowToChatMessage,
    );
  }

  async appendChatMessage(m: NewChatMessage): Promise<ChatMessage> {
    const id = eventId();
    const at = now();
    return this.inTxn(() => {
      this.db
        .prepare(
          `INSERT INTO tm_chat_messages (id, chat_id, role, text, actor, error, cost_usd, duration_ms, created_at, role_id, tainted_at, blueprint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, m.chatId, m.role, m.text, m.actor, m.error ?? null, m.costUsd ?? 0, m.durationMs ?? null, at, m.roleId ?? null, m.taintedAt ?? null, m.blueprint ? JSON.stringify(m.blueprint) : null);
      this.db.prepare(`UPDATE tm_chats SET last_message_at = ?, updated_at = ? WHERE id = ?`).run(at, at, m.chatId);
      return rowToChatMessage(this.db.prepare(`SELECT * FROM tm_chat_messages WHERE id = ?`).get(id));
    });
  }

  async getChatMessage(id: string): Promise<ChatMessage | null> {
    const r = this.db.prepare(`SELECT * FROM tm_chat_messages WHERE id = ?`).get(id);
    return r ? rowToChatMessage(r) : null;
  }

  async setChatMessageChannel(id: string, channelMessageId: string): Promise<ChatMessage | null> {
    const r = this.db
      .prepare(`UPDATE tm_chat_messages SET channel_message_id = ? WHERE id = ? AND channel_message_id IS NULL RETURNING *`)
      .get(channelMessageId, id);
    return r ? rowToChatMessage(r) : null;
  }

  async getPlannerChat(workspaceId: string): Promise<Chat | null> {
    const r = this.db.prepare(`SELECT * FROM tm_chats WHERE planner_workspace_id = ? ORDER BY created_at ASC, id ASC LIMIT 1`).get(workspaceId);
    return r ? rowToChat(r) : null;
  }

  async markChatBlueprintApplied(id: string): Promise<ChatMessage | null> {
    const r = this.db
      .prepare(`UPDATE tm_chat_messages SET blueprint_applied_at = ? WHERE id = ? AND blueprint IS NOT NULL AND blueprint_applied_at IS NULL RETURNING *`)
      .get(now(), id);
    return r ? rowToChatMessage(r) : null;
  }

  async beginChatTurn(id: string): Promise<Chat | null> {
    const r = this.db
      .prepare(
        `UPDATE tm_chats SET status = 'thinking', error = NULL, updated_at = ?
         WHERE id = ? AND status IN ('idle', 'error') RETURNING *`,
      )
      .get(now(), id);
    return r ? rowToChat(r) : null;
  }

  async setChatPid(id: string, pid: number | null): Promise<void> {
    this.db.prepare(`UPDATE tm_chats SET pid = ? WHERE id = ?`).run(pid, id);
  }

  async finishChatTurn(id: string, res: ChatTurnResult): Promise<Chat | null> {
    const ts = now();
    // `session_id = COALESCE(?, session_id)` — a failed turn (or one whose
    // envelope carried no id) must not erase the id the conversation is on.
    const r = this.db
      .prepare(
        `UPDATE tm_chats SET
           status = ?,
           error = ?,
           session_id = COALESCE(?, session_id),
           pid = NULL,
           turns = turns + ?,
           cost_usd = cost_usd + ?,
           updated_at = ?
         WHERE id = ? RETURNING *`,
      )
      .get(
        res.error ? 'error' : 'idle',
        res.error,
        res.sessionId ?? null,
        res.error ? 0 : 1,
        res.costUsd,
        ts,
        id,
      );
    return r ? rowToChat(r) : null;
  }

  async countThinkingChats(): Promise<number> {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM tm_chats WHERE status = 'thinking'`).get() as { n: number };
    return Number(r.n);
  }

  // ---- proposals ----

  async listProposals(f?: {
    status?: Proposal['status'];
    taskId?: string;
    repoId?: string;
  }): Promise<Proposal[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f?.status) {
      where.push(`status = ?`);
      params.push(f.status);
    }
    if (f?.taskId) {
      where.push(`task_id = ?`);
      params.push(f.taskId);
    }
    if (f?.repoId) {
      where.push(`repo_id = ?`);
      params.push(f.repoId);
    }
    const sql = `SELECT * FROM tm_proposals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToProposal);
  }

  async getProposal(id: string): Promise<Proposal | null> {
    const r = this.db.prepare(`SELECT * FROM tm_proposals WHERE id = ?`).get(id);
    return r ? rowToProposal(r) : null;
  }

  async createProposal(p: NewProposal): Promise<Proposal> {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO tm_proposals (id, run_id, repo_id, task_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, p.runId ?? null, p.repoId ?? null, p.taskId ?? null, p.kind, JSON.stringify(p.payload), now());
    return (await this.getProposal(id))!;
  }

  async rejectProposal(id: string): Promise<Proposal | null> {
    this.db.prepare(`UPDATE tm_proposals SET status = 'rejected' WHERE id = ? AND status = 'pending'`).run(id);
    return this.getProposal(id);
  }

  async acceptProposal(
    id: string,
    actor: string,
    chosenOptionIndex?: number,
  ): Promise<{ proposal: Proposal; tasks: Task[] } | null> {
    return this.inTxn((): { proposal: Proposal; tasks: Task[] } | null => {
      const row = this.db.prepare(`SELECT * FROM tm_proposals WHERE id = ?`).get(id);
      if (!row) return null;
      const proposal = rowToProposal(row);
      if (proposal.status !== 'pending') return null;

      const affected: Task[] = [];
      const p = proposal.payload;

      switch (proposal.kind) {
        case 'rewrite': {
          if (!proposal.taskId) return null;
          const t = this.updateTaskSync(proposal.taskId, {
            title: p.title ?? undefined,
            description: p.description ?? undefined,
          });
          if (!t) return null;
          affected.push(t);
          break;
        }
        case 'split': {
          if (!proposal.taskId || !p.subtasks?.length) return null;
          const parent = this.db.prepare(`SELECT * FROM tm_tasks WHERE id = ?`).get(proposal.taskId);
          if (!parent) return null;
          const parentTask = rowToTask(parent);
          // Conditional block FIRST — blocking a RUNNING parent would spawn
          // child workers into a repo its agent is still editing, and a DONE
          // parent must not be resurrected (review R3). Returning null before
          // any insert keeps the no-op commit truly empty.
          const blocked = this.db
            .prepare(
              `UPDATE tm_tasks SET status = 'blocked', updated_at = ?
               WHERE id = ? AND status IN ('draft', 'queued', 'review', 'failed', 'blocked') RETURNING *`,
            )
            .get(now(), parentTask.id);
          if (!blocked) return null;
          this.appendEventSync({
            kind: 'task.transition',
            actor,
            taskId: parentTask.id,
            repoId: parentTask.repoId,
            data: { from: parentTask.status, to: 'blocked', splitAccept: true },
          });
          for (const st of p.subtasks) {
            affected.push(
              this.insertTaskSync({
                title: st.title,
                description: st.description,
                repoId: parentTask.repoId,
                parentId: parentTask.id,
                status: 'queued',
                source: 'auto',
                // inherit depth: split must not launder agent-created tasks
                // back to depth 0 (review R4)
                spawnDepth: parentTask.spawnDepth,
                // children of a feature task belong to the SAME phase — the
                // phase cannot close until they are resolved too.
                featureId: parentTask.featureId,
                featurePhase: parentTask.featurePhase,
              }, actor),
            );
          }
          affected.push(rowToTask(blocked));
          break;
        }
        case 'new_task': {
          affected.push(
            this.insertTaskSync(
              {
                title: p.title ?? 'Untitled task',
                description: p.description ?? p.rationale,
                repoId: proposal.repoId,
                status: 'draft',
                source: 'auto',
              },
              actor,
            ),
          );
          break;
        }
        case 'solution_options': {
          if (!proposal.taskId || !p.options?.length) return null;
          const opt = p.options[chosenOptionIndex ?? 0];
          if (!opt) return null;
          const cur = this.db.prepare(`SELECT * FROM tm_tasks WHERE id = ?`).get(proposal.taskId);
          if (!cur) return null;
          const task = rowToTask(cur);
          const appended =
            (task.description ?? '') +
            `\n\n## Chosen approach: ${opt.label}\n${opt.approach}\nTradeoffs: ${opt.tradeoffs}`;
          const t = this.updateTaskSync(task.id, { description: appended.trim() });
          if (t) affected.push(t);
          break;
        }
      }

      this.db.prepare(`UPDATE tm_proposals SET status = 'accepted' WHERE id = ?`).run(id);
      const updated = rowToProposal(this.db.prepare(`SELECT * FROM tm_proposals WHERE id = ?`).get(id));
      this.appendEventSync({
        kind: 'proposal.decided',
        actor,
        taskId: proposal.taskId,
        repoId: proposal.repoId,
        data: { proposalId: id, kind: proposal.kind, decision: 'accepted' },
      });
      return { proposal: updated, tasks: affected };
    });
  }

  // ---- features ----

  async listFeatures(f?: { repoId?: string; status?: FeatureStatus }): Promise<Feature[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f?.repoId) {
      where.push(`repo_id = ?`);
      params.push(f.repoId);
    }
    if (f?.status) {
      where.push(`status = ?`);
      params.push(f.status);
    }
    const sql = `SELECT * FROM tm_features ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToFeature);
  }

  async getFeature(id: string): Promise<Feature | null> {
    const r = this.db.prepare(`SELECT * FROM tm_features WHERE id = ?`).get(id);
    return r ? rowToFeature(r) : null;
  }

  async createFeature(f: NewFeature, actor: string): Promise<Feature> {
    return this.inTxn((): Feature => {
      const id = randomUUID();
      const ts = now();
      this.db
        .prepare(
          `INSERT INTO tm_features (id, repo_id, title, request, status, analysis, review, analysis_rounds, error, office_id, tainted_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'draft', NULL, NULL, 0, NULL, ?, ?, ?, ?)`,
        )
        .run(id, f.repoId, f.title, f.request, f.officeId ?? null, f.taintedAt ?? null, ts, ts);
      const feature = rowToFeature(this.db.prepare(`SELECT * FROM tm_features WHERE id = ?`).get(id));
      this.appendEventSync({
        kind: 'feature.created',
        actor,
        repoId: feature.repoId,
        data: { featureId: feature.id, title: feature.title },
      });
      return feature;
    });
  }

  /** Applies only the present keys; `analysis: null` explicitly clears. */
  private writeFeaturePatchSync(id: string, patch: FeaturePatch): Feature | null {
    const sets: string[] = ['updated_at = ?'];
    const vals: unknown[] = [now()];
    if ('title' in patch && patch.title !== undefined) {
      sets.push('title = ?');
      vals.push(patch.title);
    }
    if ('request' in patch && patch.request !== undefined) {
      sets.push('request = ?');
      vals.push(patch.request);
    }
    if ('analysis' in patch) {
      sets.push('analysis = ?');
      vals.push(patch.analysis ? JSON.stringify(patch.analysis) : null);
    }
    if ('review' in patch) {
      sets.push('review = ?');
      vals.push(patch.review ? JSON.stringify(patch.review) : null);
    }
    if ('analysisRounds' in patch && patch.analysisRounds !== undefined) {
      sets.push('analysis_rounds = ?');
      vals.push(patch.analysisRounds);
    }
    if ('error' in patch) {
      sets.push('error = ?');
      vals.push(patch.error ?? null);
    }
    const r = this.db.prepare(`UPDATE tm_features SET ${sets.join(', ')} WHERE id = ? RETURNING *`).get(...vals, id);
    return r ? rowToFeature(r) : null;
  }

  async updateFeature(id: string, patch: FeaturePatch, actor: string): Promise<Feature | null> {
    return this.inTxn((): Feature | null => {
      const feature = this.writeFeaturePatchSync(id, patch);
      if (!feature) return null;
      this.appendEventSync({
        kind: 'feature.edited',
        actor,
        repoId: feature.repoId,
        data: { featureId: id, fields: Object.keys(patch) },
      });
      return feature;
    });
  }

  async transitionFeature(
    id: string,
    from: FeatureStatus[],
    to: FeatureStatus,
    actor: string,
    patch?: FeaturePatch,
  ): Promise<Feature | null> {
    return this.inTxn((): Feature | null => this.transitionFeatureSync(id, from, to, actor, patch));
  }

  /** Conditional status move — the twin of transitionTask, immune to
   *  check-then-set races between routes, the analysis pipeline and hooks. */
  private transitionFeatureSync(
    id: string,
    from: FeatureStatus[],
    to: FeatureStatus,
    actor: string,
    patch?: FeaturePatch,
  ): Feature | null {
    const prev = this.db.prepare(`SELECT status FROM tm_features WHERE id = ?`).get(id) as
      | { status: string }
      | undefined;
    const placeholders = from.map(() => '?').join(', ');
    const guarded = this.db
      .prepare(`SELECT id FROM tm_features WHERE id = ? AND status IN (${placeholders})`)
      .get(id, ...from) as { id: string } | undefined;
    if (!guarded) return null;
    if (patch) this.writeFeaturePatchSync(id, patch);
    const r = this.db
      .prepare(`UPDATE tm_features SET status = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders}) RETURNING *`)
      .get(to, now(), id, ...from);
    if (!r) return null;
    const feature = rowToFeature(r);
    this.appendEventSync({
      kind: 'feature.transition',
      actor,
      repoId: feature.repoId,
      data: { featureId: id, from: prev?.status ?? null, to },
    });
    return feature;
  }

  async deleteFeature(id: string): Promise<boolean> {
    return this.inTxn((): boolean => {
      const n = this.db.prepare(`SELECT COUNT(*) AS n FROM tm_tasks WHERE feature_id = ?`).get(id) as { n: number };
      if (Number(n.n) > 0) return false;
      this.db.prepare(`DELETE FROM tm_features WHERE id = ?`).run(id);
      return true;
    });
  }

  async approveFeature(id: string, actor: string): Promise<{ feature: Feature; tasks: Task[] } | null> {
    return this.inTxn((): { feature: Feature; tasks: Task[] } | null => {
      const row = this.db.prepare(`SELECT * FROM tm_features WHERE id = ?`).get(id);
      if (!row) return null;
      const feature = rowToFeature(row);
      if (feature.status !== 'proposed' || !feature.repoId || !feature.analysis) return null;
      const cards = planCards(feature);
      if (cards.length === 0) return null;
      // A cross-repo office feature (docs/office.md § Director features): each
      // card lands in ITS repo of the workspace, carries the office and its
      // Director, and is tainted when the feature is. A refusal throws, so the
      // whole approval rolls back.
      let roleId: string | null = null;
      let workspaceRepoIds: string[] | null = null;
      if (feature.officeId) {
        const ws = this.db.prepare(OFFICE_WORKSPACE_REPOS_SQL).get(feature.officeId) as { repo_ids: string } | undefined;
        workspaceRepoIds = ws ? parseRepoIds(ws.repo_ids).filter((r) => !!this.db.prepare(REPO_EXISTS_SQL).get(r)) : null;
        roleId = (this.db.prepare(OFFICE_DIRECTOR_ROLE_SQL).get(feature.officeId) as { id: string } | undefined)?.id ?? null;
      }
      const repoOfCard = approvalCardRepos(feature, cards, workspaceRepoIds);
      const tasks: Task[] = [];
      const taskOfCard = new Map<string, string>();
      cards.forEach((c, i) => {
        const task = this.insertTaskSync(
            {
              title: c.card.title,
              description: c.description,
              repoId: repoOfCard[i],
              // Approved ≠ started: cards land as drafts and only the feature's
              // phase gate moves them to queued.
              status: 'draft',
              source: 'feature',
              category: c.card.category ?? null,
              effort: c.card.effort ?? null,
              review: c.card.review ?? null,
              featureId: feature.id,
              featurePhase: c.phase,
              // planCards keeps only edges onto EARLIER cards, so each is
              // already inserted (docs/task-waits.md § Feature plans)
              dependsOn: c.dependsOnCards.map((id) => taskOfCard.get(id)).filter((id): id is string => !!id),
              ...(feature.officeId ? { officeId: feature.officeId, roleId, taintedAt: feature.taintedAt } : {}),
              // one group named after the feature (docs/grouping.md § Agent filings)
              ...featureCardGroup(feature, i, tasks[0]?.id ?? null),
            },
            actor,
          );
        taskOfCard.set(c.card.id, task.id);
        tasks.push(task);
      });
      const updated = this.transitionFeatureSync(id, ['proposed'], 'approved', actor, { error: null });
      // Unreachable (status was read inside this transaction), but returning
      // null here would COMMIT the inserts above and leave orphan tasks under a
      // still-'proposed' feature — throw so the whole approval rolls back.
      if (!updated) throw new Error('feature approval raced: status changed mid-transaction');
      return { feature: updated, tasks };
    });
  }

  async resolveFeatureCompletion(featureId: string, actor: string): Promise<FeatureResolution | null> {
    return this.inTxn((): FeatureResolution | null => {
      const row = this.db.prepare(`SELECT * FROM tm_features WHERE id = ?`).get(featureId);
      if (!row) return null;
      const feature = rowToFeature(row);
      if (feature.status !== 'running') return null;
      const tasks = (
        this.db.prepare(`SELECT * FROM tm_tasks WHERE feature_id = ?`).all(featureId) as any[]
      ).map(rowToTask);
      if (tasks.length === 0) return null;

      // the decision is shared with the pg driver (planFeatureProgress); this only executes it
      const plan = planFeatureProgress(feature, tasks);
      if (plan.kind === 'paused') {
        const paused = this.transitionFeatureSync(featureId, ['running'], 'paused', actor, { error: plan.error });
        return paused ? { feature: paused, tasks: [], action: 'paused' } : null;
      }
      if (plan.kind === 'review') {
        const done = this.transitionFeatureSync(featureId, ['running'], 'review', actor, { error: null });
        return done ? { feature: done, tasks: [], action: 'review' } : null;
      }

      const { phase } = plan;
      // a tainted office card stays a draft for the human (plan.held); its count is the feature's reason
      const shown = plan.error !== undefined ? (this.writeFeaturePatchSync(featureId, { error: plan.error }) ?? feature) : feature;
      const held = plan.held.length;
      const started: Task[] = [];
      for (const t of plan.queue) {
        const r = this.db
          .prepare(`UPDATE tm_tasks SET status = 'queued', error = NULL, updated_at = ? WHERE id = ? AND status = 'draft' RETURNING *`)
          .get(now(), t.id);
        if (!r) continue;
        const queued = rowToTask(r);
        started.push(queued);
        this.appendEventSync({
          kind: 'task.transition',
          actor,
          taskId: queued.id,
          repoId: queued.repoId,
          data: { from: 'draft', to: 'queued', featureId, featurePhase: phase },
        });
      }
      if (started.length === 0) return { feature: shown, tasks: [], action: 'none', phase, held };
      return { feature: shown, tasks: started, action: 'phase-started', phase, held };
    });
  }

  async cancelFeature(
    id: string,
    actor: string,
  ): Promise<{ feature: Feature; tasks: Task[]; runningTaskIds: string[] } | null> {
    return this.inTxn((): { feature: Feature; tasks: Task[]; runningTaskIds: string[] } | null => {
      // Cancel the FEATURE first: if it is already cancelled/done this returns
      // null before a single task row is touched (cancelling tasks under a
      // feature that stayed alive would be worse than doing nothing).
      const feature = this.transitionFeatureSync(
        id,
        ['draft', 'analyzing', 'proposed', 'approved', 'running', 'paused', 'review', 'failed'],
        'cancelled',
        actor,
      );
      if (!feature) return null;
      const tasks = (this.db.prepare(`SELECT * FROM tm_tasks WHERE feature_id = ?`).all(id) as any[]).map(rowToTask);
      const cancelled: Task[] = [];
      for (const t of tasks) {
        if (t.status !== 'draft' && t.status !== 'queued') continue;
        const r = this.db
          .prepare(
            `UPDATE tm_tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('draft', 'queued') RETURNING *`,
          )
          .get(now(), t.id);
        if (!r) continue;
        const c = rowToTask(r);
        cancelled.push(c);
        this.appendEventSync({
          kind: 'task.transition',
          actor,
          taskId: c.id,
          repoId: c.repoId,
          data: { from: t.status, to: 'cancelled', featureId: id },
        });
      }
      return { feature, tasks: cancelled, runningTaskIds: tasks.filter((t) => t.status === 'running').map((t) => t.id) };
    });
  }

  // ---- settings ----

  // ---- Reports (docs/reports.md) ----

  async listReports(): Promise<Report[]> {
    return (this.db.prepare(`SELECT * FROM tm_reports ORDER BY created_at DESC`).all() as any[]).map(rowToReport);
  }

  async getReport(id: string): Promise<Report | null> {
    const r = this.db.prepare(`SELECT * FROM tm_reports WHERE id = ?`).get(id);
    return r ? rowToReport(r) : null;
  }

  async createReport(r: NewReport, actor: string): Promise<Report> {
    const id = randomUUID();
    const at = now();
    this.db
      .prepare(
        `INSERT INTO tm_reports (id, title, repo_ids, from_date, to_date, preset, language, status, task_count, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .run(id, r.title, JSON.stringify(r.repoIds), r.fromDate, r.toDate, r.preset, r.language, r.model, at, at);
    const created = (await this.getReport(id))!;
    await this.appendEvent({
      kind: 'report.changed',
      actor,
      data: { action: 'created', reportId: id, repoIds: r.repoIds, from: r.fromDate, to: r.toDate, language: r.language },
    });
    return created;
  }

  async updateReport(id: string, patch: ReportPatch): Promise<Report | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [col, val] of reportPatchColumns(patch)) {
      sets.push(`${col} = ?`);
      params.push(val);
    }
    if (sets.length === 0) return this.getReport(id);
    sets.push(`updated_at = ?`);
    params.push(now(), id);
    const r = this.db.prepare(`UPDATE tm_reports SET ${sets.join(', ')} WHERE id = ? RETURNING *`).get(...params);
    return r ? rowToReport(r) : null;
  }

  async deleteReport(id: string): Promise<boolean> {
    const info = this.db.prepare(`DELETE FROM tm_reports WHERE id = ?`).run(id);
    return info.changes > 0;
  }
  // ---- Shared spaces (docs/shared-spaces.md) ----

  async listSpaces(): Promise<Space[]> {
    return (this.db.prepare(`SELECT * FROM tm_spaces ORDER BY created_at ASC`).all() as any[]).map(rowToSpace);
  }

  async getSpace(id: string): Promise<Space | null> {
    const r = this.db.prepare(`SELECT * FROM tm_spaces WHERE id = ?`).get(id);
    return r ? rowToSpace(r) : null;
  }

  async createSpace(s: NewSpace): Promise<Space> {
    const id = randomUUID();
    const at = now();
    this.db.prepare(SPACE_INSERT_SQL).run(id, s.name, s.path, JSON.stringify(s.repoIds), at, at);
    return (await this.getSpace(id))!;
  }

  async updateSpace(id: string, patch: SpacePatch): Promise<Space | null> {
    const cols = spacePatchColumns(patch);
    if (cols.length === 0) return this.getSpace(id);
    const r = this.db
      .prepare(`UPDATE tm_spaces SET ${cols.map(([c]) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? RETURNING *`)
      .get(...cols.map(([, v]) => v), now(), id);
    return r ? rowToSpace(r) : null;
  }

  async deleteSpace(id: string): Promise<boolean> {
    return this.inTxn(() => {
      this.db.prepare(`DELETE FROM tm_shared_notes WHERE space_id = ?`).run(id);
      return this.db.prepare(`DELETE FROM tm_spaces WHERE id = ?`).run(id).changes > 0;
    });
  }

  // ---- Virtual Office (docs/office.md § Data model; SQL in office-sql.ts) ----

  async listOffices(): Promise<Office[]> {
    return (this.db.prepare(OFFICE_LIST_SQL).all() as any[]).map(rowToOffice);
  }

  async getOffice(id: string): Promise<Office | null> {
    const r = this.db.prepare(OFFICE_GET_SQL).get(id);
    return r ? rowToOffice(r) : null;
  }

  async getOfficeByWorkspace(workspaceId: string): Promise<Office | null> {
    const r = this.db.prepare(OFFICE_BY_WORKSPACE_SQL).get(workspaceId);
    return r ? rowToOffice(r) : null;
  }

  async createOffice(o: NewOffice): Promise<Office> {
    const id = randomUUID();
    this.db.prepare(OFFICE_INSERT_SQL).run(...(officeInsertParams(id, o, now()) as any[]));
    return (await this.getOffice(id))!;
  }

  async updateOffice(id: string, patch: OfficePatch): Promise<Office | null> {
    const q = officePatchSql(id, patch, now());
    if (!q) return this.getOffice(id);
    const r = this.db.prepare(q.sql).get(...(q.params as any[]));
    return r ? rowToOffice(r) : null;
  }

  async deleteOffice(id: string): Promise<boolean> {
    return this.inTxn(() => {
      this.db.prepare(OFFICE_SHIFTS_DELETE_SQL).run(id);
      this.db.prepare(OFFICE_BRIEFS_DELETE_SQL).run(id);
      this.db.prepare(OFFICE_PROPOSALS_DELETE_SQL).run(id);
      this.db.prepare(OFFICE_WISHES_DELETE_SQL).run(id);
      this.db.prepare(OFFICE_RATINGS_DELETE_SQL).run(id);
      this.db.prepare(OFFICE_METRICS_POINTS_DELETE_FOR_OFFICE_SQL).run(id);
      this.db.prepare(OFFICE_METRICS_DELETE_SQL).run(id);
      this.db.prepare(OFFICE_MESSAGES_DELETE_SQL).run(id);
      this.db.prepare(OFFICE_HUDDLES_DELETE_SQL).run(id);
      this.db.prepare(OFFICE_SIGNALS_DELETE_SQL).run(id);
      this.db.prepare(OFFICE_ROLES_DELETE_SQL).run(id);
      return this.db.prepare(OFFICE_DELETE_SQL).run(id).changes > 0;
    });
  }

  async pauseOffice(id: string, reason: string | null, expectedPaused: boolean): Promise<Office | null> {
    const q = officePauseSql(id, reason, expectedPaused, now());
    const r = this.db.prepare(q.sql).get(...(q.params as any[]));
    return r ? rowToOffice(r) : null;
  }

  async setOfficeKillSwitch(id: string, on: boolean): Promise<Office | null> {
    const q = officeKillSwitchSql(id, on, now());
    const r = this.db.prepare(q.sql).get(...(q.params as any[]));
    return r ? rowToOffice(r) : null;
  }

  async listOfficeRoles(officeId?: string): Promise<OfficeRole[]> {
    const q = officeRoleListSql(officeId);
    return (this.db.prepare(q.sql).all(...(q.params as any[])) as any[]).map(rowToOfficeRole);
  }

  async getOfficeRole(id: string): Promise<OfficeRole | null> {
    const r = this.db.prepare(OFFICE_ROLE_GET_SQL).get(id);
    return r ? rowToOfficeRole(r) : null;
  }

  async createOfficeRole(role: NewOfficeRole): Promise<OfficeRole> {
    const id = randomUUID();
    this.db.prepare(OFFICE_ROLE_INSERT_SQL).run(...(officeRoleInsertParams(id, role, now()) as any[]));
    return (await this.getOfficeRole(id))!;
  }

  async updateOfficeRole(id: string, patch: OfficeRolePatch): Promise<OfficeRole | null> {
    const q = officeRolePatchSql(id, patch, now());
    if (!q) return this.getOfficeRole(id);
    const r = this.db.prepare(q.sql).get(...(q.params as any[]));
    return r ? rowToOfficeRole(r) : null;
  }

  async deleteOfficeRole(id: string): Promise<boolean> {
    return this.db.prepare(OFFICE_ROLE_DELETE_SQL).run(id).changes > 0;
  }

  async appendShift(s: NewOfficeShift): Promise<OfficeShift> {
    const id = randomUUID();
    this.db.prepare(OFFICE_SHIFT_INSERT_SQL).run(...(officeShiftInsertParams(id, s, now()) as any[]));
    return (await this.getShift(id))!;
  }

  async updateShift(id: string, patch: OfficeShiftPatch): Promise<OfficeShift | null> {
    const q = officeShiftPatchSql(id, patch);
    if (!q) return this.getShift(id);
    const r = this.db.prepare(q.sql).get(...(q.params as any[]));
    return r ? rowToOfficeShift(r) : null;
  }

  async getShift(id: string): Promise<OfficeShift | null> {
    const r = this.db.prepare(OFFICE_SHIFT_GET_SQL).get(id);
    return r ? rowToOfficeShift(r) : null;
  }

  async listShifts(f?: OfficeShiftFilter): Promise<OfficeShift[]> {
    const q = officeShiftListSql(f);
    return (this.db.prepare(q.sql).all(...(q.params as any[])) as any[]).map(rowToOfficeShift);
  }

  async officeSpendSince(officeId: string, sinceIso: string, roleId?: string): Promise<number> {
    const q = officeSpendSql(officeId, sinceIso, roleId);
    const r = this.db.prepare(q.sql).get(...(q.params as any[])) as { s: number | null };
    return Number(r.s ?? 0) || 0;
  }

  async countOpenOfficeTasks(officeId: string, roleId?: string): Promise<number> {
    const q = officeOpenTasksSql(officeId, roleId);
    const r = this.db.prepare(q.sql).get(...(q.params as any[])) as { n: number };
    return Number(r.n ?? 0);
  }

  // ---- office briefs, proposals, wishes (migration 58; SQL in office-sql.ts) ----

  async appendBrief(b: NewOfficeBrief): Promise<OfficeBrief> {
    const id = randomUUID();
    this.db.prepare(OFFICE_BRIEF_INSERT_SQL).run(...(officeBriefInsertParams(id, b, now()) as any[]));
    return (await this.getBrief(id))!;
  }

  async getBrief(id: string): Promise<OfficeBrief | null> {
    const r = this.db.prepare(OFFICE_BRIEF_GET_SQL).get(...([id] as any[]));
    return r ? rowToOfficeBrief(r) : null;
  }

  async listBriefs(f?: OfficeBriefFilter): Promise<OfficeBrief[]> {
    const q = officeBriefListSql(f);
    return (this.db.prepare(q.sql).all(...(q.params as any[])) as any[]).map(rowToOfficeBrief);
  }

  async appendOfficeProposal(p: NewOfficeProposal): Promise<OfficeProposal> {
    const id = randomUUID();
    this.db.prepare(OFFICE_PROPOSAL_INSERT_SQL).run(...(officeProposalInsertParams(id, p, now()) as any[]));
    return (await this.getOfficeProposal(id))!;
  }

  async getOfficeProposal(id: string): Promise<OfficeProposal | null> {
    const r = this.db.prepare(OFFICE_PROPOSAL_GET_SQL).get(...([id] as any[]));
    return r ? rowToOfficeProposal(r) : null;
  }

  async listOfficeProposals(f?: OfficeProposalFilter): Promise<OfficeProposal[]> {
    const q = officeProposalListSql(f);
    return (this.db.prepare(q.sql).all(...(q.params as any[])) as any[]).map(rowToOfficeProposal);
  }

  async decideProposal(
    id: string,
    to: 'accepted' | 'rejected',
    by: string,
    filedTaskId: string | null = null,
    note: string | null = null,
  ): Promise<OfficeProposal | null> {
    const q = officeProposalDecideSql(id, to, by, now(), filedTaskId, note);
    const r = this.db.prepare(q.sql).get(...(q.params as any[]));
    return r ? rowToOfficeProposal(r) : null;
  }

  async undoOfficeProposalAccept(id: string): Promise<OfficeProposal | null> {
    const r = this.db.prepare(OFFICE_PROPOSAL_UNDO_ACCEPT_SQL).get(id);
    return r ? rowToOfficeProposal(r) : null;
  }

  async countPendingOfficeProposals(officeId: string): Promise<number> {
    const r = this.db.prepare(OFFICE_PROPOSALS_PENDING_COUNT_SQL).get(officeId) as { n: number };
    return Number(r.n ?? 0);
  }

  async setProposalFiledTask(id: string, taskId: string): Promise<OfficeProposal | null> {
    const q = officeProposalFiledSql(id, taskId);
    const r = this.db.prepare(q.sql).get(...(q.params as any[]));
    return r ? rowToOfficeProposal(r) : null;
  }

  async markReviewed(table: 'brief', id: string): Promise<OfficeBrief | null>;
  async markReviewed(table: 'proposal', id: string): Promise<OfficeProposal | null>;
  async markReviewed(table: 'message', id: string): Promise<OfficeMessage | null>;
  async markReviewed(
    table: OfficeReviewable,
    id: string,
  ): Promise<OfficeBrief | OfficeProposal | OfficeMessage | null> {
    const q = officeMarkReviewedSql(table, id, now());
    const r = this.db.prepare(q.sql).get(...(q.params as any[]));
    if (!r) return null;
    return table === 'brief' ? rowToOfficeBrief(r) : table === 'message' ? rowToOfficeMessage(r) : rowToOfficeProposal(r);
  }

  async clearBriefTaint(id: string, expectedTaintedAt: string, newPath: string): Promise<OfficeBrief | null> {
    const r = this.db.prepare(OFFICE_BRIEF_CLEAR_TAINT_SQL).get(newPath, now(), id, expectedTaintedAt);
    return r ? rowToOfficeBrief(r) : null;
  }

  async createWish(w: NewOfficeWish): Promise<OfficeWish> {
    const id = randomUUID();
    this.db.prepare(OFFICE_WISH_INSERT_SQL).run(...(officeWishInsertParams(id, w, now()) as any[]));
    return (await this.getWish(id))!;
  }

  async getWish(id: string): Promise<OfficeWish | null> {
    const r = this.db.prepare(OFFICE_WISH_GET_SQL).get(...([id] as any[]));
    return r ? rowToOfficeWish(r) : null;
  }

  async listWishes(f?: OfficeWishFilter): Promise<OfficeWish[]> {
    const q = officeWishListSql(f);
    return (this.db.prepare(q.sql).all(...(q.params as any[])) as any[]).map(rowToOfficeWish);
  }

  async updateWish(id: string, patch: OfficeWishPatch): Promise<OfficeWish | null> {
    const q = officeWishPatchSql(id, patch, now());
    if (!q) return this.getWish(id);
    const r = this.db.prepare(q.sql).get(...(q.params as any[]));
    return r ? rowToOfficeWish(r) : null;
  }

  async deleteWish(id: string): Promise<boolean> {
    return this.db.prepare(OFFICE_WISH_DELETE_SQL).run(id).changes > 0;
  }

  // ---- office ratings (migration 64; SQL in rating-sql.ts) ----

  async getOfficeRating(kind: OfficeRatingSubjectKind, subjectId: string): Promise<OfficeRating | null> {
    const r = this.db.prepare(OFFICE_RATING_GET_SQL).get(kind, subjectId);
    return r ? rowToOfficeRating(r) : null;
  }

  async upsertOfficeRating(r: NewOfficeRating): Promise<OfficeRating> {
    return rowToOfficeRating(this.db.prepare(OFFICE_RATING_UPSERT_SQL).get(...(officeRatingUpsertParams(randomUUID(), r, now()) as any[])));
  }

  async listOfficeRatings(f?: OfficeRatingFilter): Promise<OfficeRating[]> {
    const q = officeRatingListSql(f);
    return (this.db.prepare(q.sql).all(...(q.params as any[])) as any[]).map(rowToOfficeRating);
  }

  // ---- office product metrics (migration 65; SQL in metric-sql.ts) ----

  async createOfficeMetric(m: NewOfficeMetric): Promise<OfficeMetric> {
    const id = randomUUID();
    this.db.prepare(OFFICE_METRIC_INSERT_SQL).run(...(officeMetricInsertParams(id, m, now()) as any[]));
    return (await this.getOfficeMetric(id))!;
  }

  async getOfficeMetric(id: string): Promise<OfficeMetric | null> {
    const r = this.db.prepare(OFFICE_METRIC_GET_SQL).get(id);
    return r ? rowToOfficeMetric(r) : null;
  }

  async listOfficeMetrics(f?: OfficeMetricFilter): Promise<OfficeMetric[]> {
    const q = officeMetricListSql(f);
    return (this.db.prepare(q.sql).all(...(q.params as any[])) as any[]).map(rowToOfficeMetric);
  }

  async updateOfficeMetric(id: string, patch: OfficeMetricPatch): Promise<OfficeMetric | null> {
    return this.inTxn(() => {
      const r = this.db.prepare(OFFICE_METRIC_GET_SQL).get(id);
      if (!r) return null;
      const q = officeMetricPatchSql(id, patch, rowToOfficeMetric(r), now());
      if (q) this.db.prepare(q.sql).run(...(q.params as any[]));
      return rowToOfficeMetric(this.db.prepare(OFFICE_METRIC_GET_SQL).get(id));
    });
  }

  async deleteOfficeMetric(id: string): Promise<boolean> {
    return this.inTxn(() => {
      this.db.prepare(OFFICE_METRIC_POINTS_DELETE_SQL).run(id);
      return this.db.prepare(OFFICE_METRIC_DELETE_SQL).run(id).changes > 0;
    });
  }

  async recordOfficeMetricRun(id: string, run: OfficeMetricRun): Promise<OfficeMetricRunResult | null> {
    return this.inTxn(() => {
      const r = this.db.prepare(OFFICE_METRIC_GET_SQL).get(id);
      if (!r) return null;
      const prev = rowToOfficeMetric(r);
      let crossed = false;
      if (run.value === null) this.db.prepare(OFFICE_METRIC_ERROR_SQL).run(run.at, run.error, id);
      else {
        this.db.prepare(OFFICE_METRIC_POINT_INSERT_SQL).run(id, run.at, run.value, run.runId);
        this.db.prepare(OFFICE_METRIC_POINTS_PRUNE_SQL).run(...(officeMetricPruneParams(id) as any[]));
        this.db.prepare(OFFICE_METRIC_VALUE_SQL).run(run.value, run.at, run.at, id);
        const side = metricSide(run.value, prev);
        if (side === 'breach') crossed = this.db.prepare(OFFICE_METRIC_BREACH_SQL).run(run.at, id).changes > 0;
        else if (side === 'ok') this.db.prepare(OFFICE_METRIC_OK_SQL).run(id);
        else this.db.prepare(OFFICE_METRIC_NO_SIDE_SQL).run(id);
      }
      return { metric: rowToOfficeMetric(this.db.prepare(OFFICE_METRIC_GET_SQL).get(id)), crossed, previousSide: prev.lastSide, previousValue: prev.lastValue };
    });
  }

  async listOfficeMetricPoints(metricId: string, limit: number): Promise<OfficeMetricPoint[]> {
    const q = officeMetricPointsSql(metricId, limit);
    return (this.db.prepare(q.sql).all(...(q.params as any[])) as any[]).map(rowToOfficeMetricPoint).reverse();
  }

  // ---- office messages, huddles, signals (migration 60; SQL in office-sql.ts) ----

  async appendOfficeMessage(m: NewOfficeMessage): Promise<OfficeMessage> {
    const id = randomUUID();
    this.db.prepare(OFFICE_MESSAGE_INSERT_SQL).run(...(officeMessageInsertParams(id, m, now()) as any[]));
    const message = (await this.getOfficeMessage(id))!;
    queueMicrotask(() => broadcast({ type: 'office-message.created', message }));
    return message;
  }

  async getOfficeMessage(id: string): Promise<OfficeMessage | null> {
    const r = this.db.prepare(OFFICE_MESSAGE_GET_SQL).get(id);
    return r ? rowToOfficeMessage(r) : null;
  }

  async listOfficeMessages(f?: OfficeMessageFilter): Promise<OfficeMessage[]> {
    const q = officeMessageListSql(f);
    return (this.db.prepare(q.sql).all(...(q.params as any[])) as any[]).map(rowToOfficeMessage);
  }

  async routeMessage(id: string, taskId: string | null = null): Promise<OfficeMessage | null> {
    const q = officeMessageRouteSql(id, taskId, now());
    const r = this.db.prepare(q.sql).get(...(q.params as any[]));
    return r ? rowToOfficeMessage(r) : null;
  }

  async clearMessageTaint(id: string, expectedTaintedAt: string): Promise<OfficeMessage | null> {
    const r = this.db.prepare(OFFICE_MESSAGE_CLEAR_TAINT_SQL).get(now(), id, expectedTaintedAt);
    return r ? rowToOfficeMessage(r) : null;
  }

  async createHuddle(h: NewOfficeHuddle): Promise<OfficeHuddle> {
    const id = randomUUID();
    this.db.prepare(OFFICE_HUDDLE_INSERT_SQL).run(...(officeHuddleInsertParams(id, h, now()) as any[]));
    return (await this.getHuddle(id))!;
  }

  async getHuddle(id: string): Promise<OfficeHuddle | null> {
    const r = this.db.prepare(OFFICE_HUDDLE_GET_SQL).get(id);
    return r ? rowToOfficeHuddle(r) : null;
  }

  async listHuddles(f?: OfficeHuddleFilter): Promise<OfficeHuddle[]> {
    const q = officeHuddleListSql(f);
    return (this.db.prepare(q.sql).all(...(q.params as any[])) as any[]).map(rowToOfficeHuddle);
  }

  async stepHuddle(id: string): Promise<OfficeHuddle | null> {
    const q = officeHuddleStepSql(id, now());
    const r = this.db.prepare(q.sql).get(...(q.params as any[]));
    return r ? rowToOfficeHuddle(r) : null;
  }

  async taintHuddle(id: string): Promise<OfficeHuddle | null> {
    const q = officeHuddleTaintSql(id, now());
    const r = this.db.prepare(q.sql).get(...(q.params as any[]));
    return r ? rowToOfficeHuddle(r) : null;
  }

  async closeHuddle(id: string, to: 'decided' | 'expired', decision: string | null = null): Promise<OfficeHuddle | null> {
    const q = officeHuddleCloseSql(id, to, decision, now());
    const r = this.db.prepare(q.sql).get(...(q.params as any[]));
    return r ? rowToOfficeHuddle(r) : null;
  }

  async appendSignal(s: NewOfficeSignal): Promise<{ signal: OfficeSignal; created: boolean }> {
    const r = this.db.prepare(OFFICE_SIGNAL_INSERT_SQL).get(...(officeSignalInsertParams(randomUUID(), s, now()) as any[]));
    if (r) return { signal: rowToOfficeSignal(r), created: true };
    const existing = this.db.prepare(OFFICE_SIGNAL_BY_EXTERNAL_SQL).get(s.source, s.externalId);
    return { signal: rowToOfficeSignal(existing), created: false };
  }

  async getSignal(id: string): Promise<OfficeSignal | null> {
    const r = this.db.prepare(OFFICE_SIGNAL_GET_SQL).get(id);
    return r ? rowToOfficeSignal(r) : null;
  }

  async listSignals(f?: OfficeSignalFilter): Promise<OfficeSignal[]> {
    const q = officeSignalListSql(f);
    return (this.db.prepare(q.sql).all(...(q.params as any[])) as any[]).map(rowToOfficeSignal);
  }

  async consumeSignal(id: string, shiftId: string): Promise<OfficeSignal | null> {
    const q = officeSignalConsumeSql(id, shiftId);
    const r = this.db.prepare(q.sql).get(...(q.params as any[]));
    return r ? rowToOfficeSignal(r) : null;
  }

  // ---- Workspaces (docs/workspaces.md) ----

  async listWorkspaces(): Promise<Workspace[]> {
    return (this.db.prepare(WORKSPACE_LIST_SQL).all() as any[]).map(rowToWorkspace);
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    const r = this.db.prepare(`SELECT * FROM tm_workspaces WHERE id = ?`).get(id);
    return r ? rowToWorkspace(r) : null;
  }

  async createWorkspace(w: NewWorkspace): Promise<Workspace> {
    const id = randomUUID();
    const at = now();
    this.db.prepare(WORKSPACE_APPEND_SQL).run(id, w.name, w.slug, JSON.stringify(w.repoIds), w.color, at, at);
    return (await this.getWorkspace(id))!;
  }

  async updateWorkspace(id: string, patch: WorkspacePatch): Promise<Workspace | null> {
    const cols = workspacePatchColumns(patch);
    if (cols.length === 0) return this.getWorkspace(id);
    const r = this.db
      .prepare(`UPDATE tm_workspaces SET ${cols.map(([c]) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? RETURNING *`)
      .get(...cols.map(([, v]) => v), now(), id);
    return r ? rowToWorkspace(r) : null;
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    return this.db.prepare(`DELETE FROM tm_workspaces WHERE id = ?`).run(id).changes > 0;
  }

  async reorderWorkspaces(ids: string[]): Promise<Workspace[]> {
    this.inTxn(() => {
      const order = workspaceOrder(this.db.prepare(WORKSPACE_LIST_SQL).all() as { id: string }[], ids);
      const set = this.db.prepare(WORKSPACE_SORT_SQL);
      const at = now();
      order.forEach((id, i) => set.run(i, at, id));
    });
    return this.listWorkspaces();
  }

  async listSharedNotes(f: SharedNoteFilter): Promise<SharedNote[]> {
    const { sql, params } = sharedNoteListQuery(f);
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToSharedNote);
  }

  async getSharedNote(id: string): Promise<SharedNote | null> {
    const r = this.db.prepare(`SELECT * FROM tm_shared_notes WHERE id = ?`).get(id);
    return r ? rowToSharedNote(r) : null;
  }

  async createSharedNote(n: NewSharedNote): Promise<SharedNote> {
    const id = randomUUID();
    const at = now();
    this.db
      .prepare(SHARED_NOTE_INSERT_SQL)
      .run(id, n.spaceId, n.kind, n.title, n.body, n.fromRepoId, n.fromTaskId, n.toRepoId, 'open', null, null, JSON.stringify(n.files), n.actor, at, at);
    return (await this.getSharedNote(id))!;
  }

  async updateSharedNote(
    id: string,
    patch: SharedNotePatch,
    fromStatus?: readonly SharedNoteStatus[],
  ): Promise<SharedNote | null> {
    const u = sharedNoteUpdate(id, patch, now(), fromStatus);
    if (!u) return this.getSharedNote(id);
    const r = this.db.prepare(u.sql).get(...u.params);
    return r ? rowToSharedNote(r) : null;
  }

  async deleteSharedNote(id: string): Promise<boolean> {
    return this.db.prepare(`DELETE FROM tm_shared_notes WHERE id = ?`).run(id).changes > 0;
  }


  async getSettings(): Promise<AppSettings> {
    const rows = this.db.prepare(`SELECT key, value FROM tm_config`).all() as { key: string; value: string }[];
    // machine-dependent defaults (the RAM-suggested concurrency) under any saved row
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS, ...machineDefaults() };
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {
        // ignore malformed values, keep default
      }
    }
    return out as unknown as AppSettings;
  }

  async setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO tm_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value));
  }

  async deleteSetting(key: string): Promise<void> {
    this.db.prepare(`DELETE FROM tm_config WHERE key = ?`).run(key);
  }
}
