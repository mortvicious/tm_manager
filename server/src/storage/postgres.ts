import pg from 'pg';
import { randomUUID } from 'node:crypto';
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

/** Rewrites `?` placeholders to `$1..$n`. Constraint: no `?` inside SQL string
 *  literals — all SQL here is in-house and follows that rule. */
function toPg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Works with any Postgres connection string — Supabase's pooler string included.
export class PostgresStorage implements Storage {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    if (!connectionString) {
      throw new Error('storage.postgres.connectionString is empty in data/config.json');
    }
    this.pool = new pg.Pool({ connectionString, max: 5 });
    // Idle-client errors (Supabase drops idle connections; free tier pauses
    // projects) emit 'error' on the pool — unhandled, that crashes the whole
    // orchestrator with live agents unsupervised (final review F1).
    this.pool.on('error', (err) => console.error('pg pool idle-client error:', err.message));
  }

  private async q(sql: string, params: unknown[] = []): Promise<any[]> {
    const res = await this.pool.query(toPg(sql), params);
    return res.rows;
  }

  async migrate(): Promise<void> {
    await this.q(`CREATE TABLE IF NOT EXISTS tm_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
    const applied = new Set((await this.q(`SELECT id FROM tm_migrations`)).map((r) => Number(r.id)));
    const client = await this.pool.connect();
    try {
      for (const m of MIGRATIONS) {
        if (applied.has(m.id)) continue;
        await client.query('BEGIN');
        try {
          for (const s of m.statements) await client.query(s);
          await client.query(`INSERT INTO tm_migrations (id, applied_at) VALUES ($1, $2)`, [m.id, now()]);
          // Migration 33's rows are backfilled in the SAME transaction, so a
          // crash cannot leave the migration marked applied with no costs.
          if (m.id === COST_MIGRATION_ID) {
            const rows = (await client.query(`SELECT id, stats FROM tm_runs WHERE stats IS NOT NULL`)).rows as {
              id: string;
              stats: string;
            }[];
            for (const r of rows) {
              await client.query(`UPDATE tm_runs SET cost_usd = $1 WHERE id = $2`, [runCost(safeParse(r.stats, null)), r.id]);
            }
            await client.query(`UPDATE tm_tasks SET cost_usd = ${taskCostSql('tm_tasks.id')}`);
          }
          // Migration 45: agent owners of saved commands, same transaction.
          if (m.id === COMMAND_OWNER_MIGRATION_ID) {
            const commands = (await client.query(`SELECT id, repo_id, name, command, created_at FROM tm_commands`)).rows;
            const events = (
              await client.query(
                `SELECT at, actor, task_id, repo_id, data FROM tm_events WHERE kind = 'command.changed' AND task_id IS NOT NULL`,
              )
            ).rows;
            for (const o of commandOwnerBackfill(commands, events)) {
              await client.query(`UPDATE tm_commands SET owner_task_id = $1 WHERE id = $2`, [o.ownerTaskId, o.id]);
            }
          }
          // Migration 49: one workspace per shared space, same transaction, once.
          if (m.id === WORKSPACE_SEED_MIGRATION_ID) {
            const spaces = (await client.query(`SELECT name, repo_ids, created_at FROM tm_spaces`)).rows;
            for (const w of workspaceSeedRows(spaces, randomUUID, now())) {
              await client.query(toPg(WORKSPACE_INSERT_SQL), [
                w.id,
                w.name,
                w.slug,
                w.repoIds,
                w.color,
                w.sortOrder,
                w.createdAt,
                w.updatedAt,
              ]);
            }
          }
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
      }
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async spendSince(sinceIso: string): Promise<number> {
    const rows = await this.q(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM tm_runs WHERE started_at >= ?`, [sinceIso]);
    return Number(rows[0]?.s ?? 0) || 0;
  }

  private async appendEventWith(
    c: pg.PoolClient | pg.Pool,
    e: NewAuditEvent,
    sink?: AuditEvent[],
  ): Promise<AuditEvent> {
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
    await c.query(
      `INSERT INTO tm_events (id, at, kind, actor, task_id, run_id, repo_id, data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [ev.id, ev.at, ev.kind, ev.actor, ev.taskId, ev.runId, ev.repoId, ev.data ? JSON.stringify(ev.data) : null],
    );
    // Inside a transaction the broadcast is deferred to the sink and fired
    // after COMMIT — mid-tx broadcasts would leak phantom events on rollback
    // (dashboard impl review R4).
    if (sink) sink.push(ev);
    else queueMicrotask(() => broadcast({ type: 'event.appended', event: ev }));
    return ev;
  }

  async appendEvent(e: NewAuditEvent): Promise<AuditEvent> {
    return this.appendEventWith(this.pool, e);
  }

  async listEvents(f?: EventFilter): Promise<AuditEvent[]> {
    const { sql, params } = eventListSql(f);
    return (await this.q(sql, params)).map(rowToEvent);
  }

  async taskSeedEvents(anchorKinds: AuditKind[], kinds: AuditKind[], taskIds: string[], before: string): Promise<AuditEvent[]> {
    if (taskIds.length === 0 || anchorKinds.length === 0) return [];
    // an empty `kinds` still returns the anchors (the IN list needs one value)
    const { sql, params } = taskSeedEventsSql(anchorKinds, kinds.length ? kinds : anchorKinds, taskIds, before);
    return (await this.q(sql, params)).map(rowToEvent);
  }
  async taskAnchorsBefore(anchorKinds: AuditKind[], before: string, repoIds?: string[]): Promise<AuditEvent[]> {
    if (anchorKinds.length === 0 || (repoIds && repoIds.length === 0)) return [];
    const { sql, params } = taskAnchorsSql(anchorKinds, before, repoIds);
    return (await this.q(sql, params)).map(rowToEvent);
  }



  async setEventData(id: string, data: Record<string, unknown>): Promise<void> {
    await this.q(`UPDATE tm_events SET data = ? WHERE id = ?`, [JSON.stringify(data), id]);
  }

  // ---- repos ----

  async listRepos(): Promise<Repo[]> {
    return (await this.q(`SELECT * FROM tm_repos ORDER BY created_at`)).map(rowToRepo);
  }

  async getRepo(id: string): Promise<Repo | null> {
    const r = await this.q(`SELECT * FROM tm_repos WHERE id = ?`, [id]);
    return r[0] ? rowToRepo(r[0]) : null;
  }

  async createRepo(r: NewRepo): Promise<Repo> {
    const id = randomUUID();
    await this.q(`INSERT INTO tm_repos (id, name, path, role, preview_url, landing, push_policy, question_autopilot_minutes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id,
      r.name,
      r.path,
      r.role ?? null,
      r.previewUrl ?? null,
      r.landing ?? 'supervised',
      r.pushPolicy ?? 'repo-rules',
      r.questionAutopilotMinutes ?? null,
      now(),
    ]);
    return (await this.getRepo(id))!;
  }

  async updateRepo(id: string, patch: RepoPatch): Promise<Repo | null> {
    const cur = await this.getRepo(id);
    if (!cur) return null;
    await this.q(`UPDATE tm_repos SET name = ?, path = ?, role = ?, preview_url = ?, landing = ?, push_policy = ?, question_autopilot_minutes = ? WHERE id = ?`, [
      patch.name ?? cur.name,
      patch.path ?? cur.path,
      patch.role === undefined ? cur.role : patch.role,
      patch.previewUrl === undefined ? cur.previewUrl : patch.previewUrl,
      patch.landing ?? cur.landing,
      patch.pushPolicy ?? cur.pushPolicy,
      patch.questionAutopilotMinutes === undefined ? cur.questionAutopilotMinutes : patch.questionAutopilotMinutes,
      id,
    ]);
    await this.q(REPO_PARALLEL_SQL, [
      ...repoParallelParams(cur, patch),
      id,
    ]);
    if (patch.autoApprove !== undefined) await this.q(REPO_AUTO_APPROVE_SQL, [autoApproveValue(patch.autoApprove), id]);
    return this.getRepo(id);
  }

  async deleteRepo(id: string): Promise<void> {
    await this.tx(async (c) => {
      await c.query(`UPDATE tm_tasks SET repo_id = NULL WHERE repo_id = $1`, [id]);
      // Owned by the repo (repo_id NOT NULL) — see the sqlite driver.
      await c.query(`DELETE FROM tm_commands WHERE repo_id = $1`, [id]);
      // Features follow tasks: detached, not deleted (see sqlite driver).
      await c.query(`UPDATE tm_features SET repo_id = NULL, updated_at = $1 WHERE repo_id = $2`, [now(), id]);
      await c.query(`DELETE FROM tm_repos WHERE id = $1`, [id]);
    });
  }

  // ---- commands (docs/commands.md) ----

  async listCommands(repoId?: string): Promise<RepoCommand[]> {
    const sql = `SELECT * FROM tm_commands ${repoId ? 'WHERE repo_id = ?' : ''} ORDER BY sort_order, created_at`;
    return (await this.q(sql, repoId ? [repoId] : [])).map(rowToCommand);
  }

  async getCommand(id: string): Promise<RepoCommand | null> {
    const r = await this.q(`SELECT * FROM tm_commands WHERE id = ?`, [id]);
    return r[0] ? rowToCommand(r[0]) : null;
  }

  async createCommand(c: NewCommand): Promise<RepoCommand> {
    const id = randomUUID();
    const at = now();
    const sortOrder =
      c.sortOrder ??
      Number(
        (await this.q(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM tm_commands WHERE repo_id = ?`, [c.repoId]))[0]
          .next,
      );
    await this.q(
      `INSERT INTO tm_commands (id, repo_id, name, command, kind, cwd, sort_order, is_check, timeout_sec, owner_task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, c.repoId, c.name, c.command, c.kind ?? 'task', c.cwd ?? null, sortOrder, c.isCheck ? 1 : 0, c.timeoutSec ?? null, c.ownerTaskId ?? null, at, at],
    );
    return (await this.getCommand(id))!;
  }

  async updateCommand(id: string, patch: CommandPatch): Promise<RepoCommand | null> {
    const cur = await this.getCommand(id);
    if (!cur) return null;
    await this.q(
      `UPDATE tm_commands SET name = ?, command = ?, kind = ?, cwd = ?, sort_order = ?, is_check = ?, timeout_sec = ?, owner_task_id = ?, archived_at = ?, updated_at = ? WHERE id = ?`,
      [
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
      ],
    );
    return this.getCommand(id);
  }

  async deleteCommand(id: string): Promise<void> {
    await this.q(`DELETE FROM tm_commands WHERE id = ?`, [id]);
  }

  async touchCommandRun(id: string, at: string): Promise<void> {
    await this.q(`UPDATE tm_commands SET last_run_at = ? WHERE id = ?`, [at, id]);
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
    return (await this.q(sql, params)).map(rowToTask);
  }

  async getTask(id: string): Promise<Task | null> {
    const r = await this.q(`SELECT * FROM tm_tasks WHERE id = ?`, [id]);
    return r[0] ? rowToTask(r[0]) : null;
  }

  /** The group columns a row must carry, derived from its parent (twin of the sqlite driver). */
  private async placeWith(
    c: pg.PoolClient | pg.Pool,
    id: string,
    parentId: string | null | undefined,
  ): Promise<{ groupId: string; groupPath: string }> {
    if (!parentId) return placement(id, null);
    const r = await c.query(`SELECT id, group_id, group_path FROM tm_tasks WHERE id = $1`, [parentId]);
    const p = r.rows[0] as { id: string; group_id: string | null; group_path: string | null } | undefined;
    // Unknown parent: the FK rejects the write anyway (see sqlite driver).
    if (!p) return placement(id, null);
    return placement(id, { id: p.id, group_id: p.group_id ?? p.id, group_path: p.group_path ?? ROOT_PATH });
  }

  private async insertTaskWith(
    c: pg.PoolClient | pg.Pool,
    t: NewTask,
    actor: string,
    sink?: AuditEvent[],
  ): Promise<Task> {
    const id = randomUUID();
    const ts = now();
    const place = await this.placeWith(c, id, t.parentId);
    await c.query(
      `INSERT INTO tm_tasks (id, title, description, repo_id, parent_id, group_id, group_path, status, source, source_ref, priority, model, effort, category, review, landing, created_by_run, spawn_depth, feature_id, feature_phase, created_at, updated_at, review_model, review_effort, acceptance, checks, kind, loop_goal, loop_max_iterations, loop_budget_usd, brief, depends_on, office_id, role_id, tainted_at, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, (${NEXT_SORT_ORDER_SQL}))`,
      [
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
      ],
    );
    const r = await c.query(`SELECT * FROM tm_tasks WHERE id = $1`, [id]);
    const task = rowToTask(r.rows[0]);
    await this.appendEventWith(c, {
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
      },
    }, sink);
    return task;
  }

  async createTask(t: NewTask, actor: string): Promise<Task> {
    return this.tx((c, sink) => this.insertTaskWith(c, t, actor, sink));
  }

  private async updateTaskWith(
    c: pg.PoolClient | pg.Pool,
    id: string,
    patch: Partial<Omit<Task, 'id' | 'createdAt'>>,
  ): Promise<Task | null> {
    const curRes = await c.query(`SELECT * FROM tm_tasks WHERE id = $1`, [id]);
    if (!curRes.rows[0]) return null;
    const t = rowToTask(curRes.rows[0]);
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = { ...t, ...clean, updatedAt: now() };
    // Re-parenting moves this task AND everything under it (twin of the sqlite driver).
    const moved = next.parentId !== t.parentId;
    let place = { groupId: t.groupId, groupPath: t.groupPath };
    if (moved) {
      if (next.parentId === id) throw new Error('a task cannot be its own parent');
      const pr = next.parentId
        ? await c.query(`SELECT id, group_id, group_path FROM tm_tasks WHERE id = $1`, [next.parentId])
        : null;
      const p = pr?.rows[0] as { id: string; group_id: string | null; group_path: string | null } | undefined;
      if (next.parentId && !p) throw new Error('parent task not found');
      if (p && pathContains(p.group_path ?? ROOT_PATH, id)) {
        throw new Error('re-parenting a task under its own descendant would create a cycle');
      }
      place = placement(
        id,
        p ? { id: p.id, group_id: p.group_id ?? p.id, group_path: p.group_path ?? ROOT_PATH } : null,
      );
      // Descendants first: their match uses this row's OLD path prefix.
      await c.query(
        toPg(MOVE_SUBTREE_SQL),
        moveSubtreeParams({ id, group_path: t.groupPath }, place, next.updatedAt),
      );
    }
    // Only a group ROOT carries the group's name/colour.
    const isRoot = place.groupId === id;
    await c.query(
      `UPDATE tm_tasks SET title=$1, description=$2, repo_id=$3, parent_id=$4, group_id=$5, group_path=$6, group_name=$7, group_color=$8, status=$9, source=$10, source_ref=$11, priority=$12, model=$13, effort=$14, category=$15, review=$16, landing=$17, custom_queue_at=$18, feature_id=$19, feature_phase=$20, result_summary=$21, review_summary=$22, review_diff_hash=$23, review_state=$24, review_rounds=$25, wake_at=$26, error=$27, updated_at=$28, review_model=$29, review_effort=$30, base_sha=$31, base_ref=$32, base_at=$33, queue_held_at=$34, acceptance=$35, checks=$36, check_state=$37, check_results=$38, check_diff_hash=$39, auto_landed_at=$40, loop_goal=$41, loop_max_iterations=$42, loop_budget_usd=$43, loop_iteration=$44, loop_state=$45, loop_history=$46, hidden_at=$47, paused_turn=$48, shipped_sha=$49, shipped_at=$50 WHERE id=$51`,
      [
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
        next.autoLandedAt ?? null,
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
      ],
    );
    const r = await c.query(`SELECT * FROM tm_tasks WHERE id = $1`, [id]);
    return rowToTask(r.rows[0]);
  }

  async stepLoop(id: string, from: (LoopState | null)[], patch: LoopStep): Promise<Task | null> {
    const { sets, vals } = loopStepSets(patch);
    const named = from.filter((s): s is LoopState => s !== null);
    const rows = await this.q(stepLoopSql(sets, from), [...vals, now(), id, ...named]);
    return rows[0] ? rowToTask(rows[0]) : null;
  }

  async bumpTaskAttempts(id: string): Promise<Task | null> {
    const rows = await this.q(`UPDATE tm_tasks SET attempts = attempts + 1 WHERE id = ? RETURNING *`, [id]);
    return rows[0] ? rowToTask(rows[0]) : null;
  }

  async setTaskHidden(id: string, hidden: boolean): Promise<Task | null> {
    // Twin of the sqlite driver.
    const at = now();
    const rows = await this.q(
      `UPDATE tm_tasks SET hidden_at = ?, updated_at = ? WHERE id = ?${hidden ? ` AND status NOT IN ('running', 'waiting')` : ''} RETURNING *`,
      [hidden ? at : null, at, id],
    );
    return rows[0] ? rowToTask(rows[0]) : null;
  }

  async keepTaskInInbox(id: string, until: string): Promise<Task | null> {
    // Twin of the sqlite driver.
    const rows = await this.q(
      `UPDATE tm_tasks SET inbox_kept_until = ?, updated_at = ? WHERE id = ? AND status = 'draft' RETURNING *`,
      [until, now(), id],
    );
    return rows[0] ? rowToTask(rows[0]) : null;
  }

  async updateTaskWorktree(id: string, patch: WorktreePatch): Promise<Task | null> {
    // Twin of the sqlite driver.
    const q = worktreePatchSql(id, patch);
    if (!q) return this.getTask(id);
    const rows = await this.q(q.sql, q.params);
    return rows[0] ? rowToTask(rows[0]) : null;
  }

  async updateTask(id: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): Promise<Task | null> {
    // A re-parent rewrites the moved subtree too, so it must be one transaction.
    return this.tx((c) => this.updateTaskWith(c, id, patch));
  }

  async moveTask(id: string, parentId: string | null, anchor: MoveAnchor, actor: string): Promise<Task[] | null> {
    // Twin of the sqlite driver.
    return this.tx(async (c, sink): Promise<Task[] | null> => {
      const cur = (await c.query(`SELECT * FROM tm_tasks WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) return null;
      const before = rowToTask(cur);
      if (parentId !== before.parentId) await this.updateTaskWith(c, id, { parentId });
      const changed = new Set<string>([id]);
      if (typeof anchor === 'object') {
        const q = siblingsQuery(parentId, id);
        const pos = keyNextTo((await c.query(toPg(q.sql), q.params)).rows, id, anchor);
        if ('key' in pos) {
          await c.query(`UPDATE tm_tasks SET sort_order = $1 WHERE id = $2`, [pos.key, id]);
        } else {
          for (const [i, rid] of pos.renumber.entries()) {
            await c.query(`UPDATE tm_tasks SET sort_order = $1 WHERE id = $2`, [i + 1, rid]);
            changed.add(rid);
          }
        }
      } else if (anchor === 'end') {
        const k = Number((await c.query(NEXT_SORT_ORDER_SQL)).rows[0].k);
        await c.query(`UPDATE tm_tasks SET sort_order = $1 WHERE id = $2`, [k, id]);
      }
      const task = rowToTask((await c.query(`SELECT * FROM tm_tasks WHERE id = $1`, [id])).rows[0]);
      await this.appendEventWith(c, {
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
      }, sink);
      const rows = new Map<string, Task>();
      for (const r of (await c.query(`SELECT * FROM tm_tasks WHERE group_id = $1`, [task.groupId])).rows) {
        rows.set(r.id, rowToTask(r));
      }
      const rest = [...changed].filter((rid) => !rows.has(rid));
      if (rest.length) {
        for (const r of (await c.query(`SELECT * FROM tm_tasks WHERE id = ANY($1)`, [rest])).rows) {
          rows.set(r.id, rowToTask(r));
        }
      }
      return [...rows.values()];
    });
  }

  async reorderCustomQueue(id: string, anchor: QueueMoveAnchor, actor: string): Promise<{ refused: string } | { tasks: Task[] } | null> {
    // Twin of the sqlite driver; the waiting set is locked for the decision.
    return this.tx(async (c, sink): Promise<{ refused: string } | { tasks: Task[] } | null> => {
      const cur = (await c.query(`SELECT * FROM tm_tasks WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) return null;
      const waiting = (await c.query(`${CUSTOM_QUEUE_WAITING_SQL} FOR UPDATE`)).rows;
      const plan = planQueueReorder(cur, waiting, anchor);
      if ('refused' in plan) return plan;
      if (!plan.writes.length) return { tasks: [] };
      for (const w of plan.writes) {
        await c.query(`UPDATE tm_tasks SET custom_queue_at = $1 WHERE id = $2`, [w.at, w.id]);
      }
      const ids = [id, ...plan.writes.map((w) => w.id).filter((rid) => rid !== id)];
      const byId = new Map<string, Task>();
      for (const r of (await c.query(`SELECT * FROM tm_tasks WHERE id = ANY($1)`, [ids])).rows) byId.set(r.id, rowToTask(r));
      const task = byId.get(id)!;
      await this.appendEventWith(c, {
        kind: 'task.queue',
        actor,
        taskId: id,
        repoId: task.repoId,
        data: reorderAudit(anchor, plan),
      }, sink);
      return { tasks: ids.map((rid) => byId.get(rid)!) };
    });
  }

  async deleteTask(id: string): Promise<void> {
    await this.tx(async (c) => {
      // Orphaned children become roots of their own groups (see sqlite driver).
      const kids = (await c.query(`SELECT id, group_path FROM tm_tasks WHERE parent_id = $1`, [id])).rows as {
        id: string;
        group_path: string | null;
      }[];
      const ts = now();
      for (const k of kids) {
        const place = placement(k.id, null);
        await c.query(
          toPg(MOVE_SUBTREE_SQL),
          moveSubtreeParams({ id: k.id, group_path: k.group_path ?? ROOT_PATH }, place, ts),
        );
        await c.query(
          `UPDATE tm_tasks SET parent_id = NULL, group_id = $1, group_path = $2, updated_at = $3 WHERE id = $4`,
          [place.groupId, place.groupPath, ts, k.id],
        );
      }
      await c.query(`DELETE FROM tm_proposals WHERE task_id = $1`, [id]);
      await c.query(`UPDATE tm_runs SET task_id = NULL WHERE task_id = $1`, [id]);
      await c.query(`DELETE FROM tm_tasks WHERE id = $1`, [id]);
    });
  }

  /**
   * The ONE value OFFICE_CLAIM_GATE binds: the offices whose day budget
   * tripped on their own office-local day (queue-sql.ts — twin of the sqlite
   * driver; "today" is computed in JS so both dialects agree).
   */
  private async officeTripped(c?: pg.PoolClient): Promise<string> {
    const rows = c ? (await c.query(OFFICE_TRIPPED_SQL)).rows : await this.q(OFFICE_TRIPPED_SQL);
    return officeTrippedParam(
      rows.map((r: any) => ({ id: r.id, timezone: r.timezone, budgetTrippedOn: r.budget_tripped_on ?? null })),
      Date.now(),
    );
  }

  async claimNextQueuedTask(actor: string, skipRepoIds: string[] = []): Promise<Task | null> {
    // Single-process orchestrator; multi-writer would need FOR UPDATE SKIP LOCKED.
    return this.tx(async (c, sink) => {
      const r = await c.query(
        toPg(`UPDATE tm_tasks SET status = 'running', updated_at = ?
         WHERE id = (SELECT t.id FROM tm_tasks t WHERE t.status = 'queued' AND t.repo_id IS NOT NULL
                       AND t.custom_queue_at IS NULL
                       AND t.queue_held_at IS NULL
                       AND ${FEATURE_CLAIM_GATE}
                       AND ${OFFICE_CLAIM_GATE}
                       AND ${REPO_EXCLUSIVE_GATE}${skipRepos(skipRepoIds.length)}
                     ORDER BY ${MANUAL_CLAIM_ORDER} LIMIT 1)
         RETURNING *`),
        [now(), await this.officeTripped(c), ...skipRepoIds],
      );
      if (!r.rows[0]) return null;
      const task = rowToTask(r.rows[0]);
      await this.appendEventWith(c, {
        kind: 'task.transition',
        actor,
        taskId: task.id,
        repoId: task.repoId,
        data: { from: 'queued', to: 'running', claim: 'base' },
      }, sink);
      return task;
    });
  }

  async peekCustomQueue(skipRepoIds: string[] = []): Promise<Task | null> {
    const rows = await this.q(
      `SELECT t.* FROM tm_tasks t WHERE ${CUSTOM_QUEUE_HEAD_WHERE} AND ${FEATURE_CLAIM_GATE}
         AND ${OFFICE_CLAIM_GATE}${skipRepos(skipRepoIds.length)}
       ${CUSTOM_QUEUE_HEAD_ORDER}`,
      [await this.officeTripped(), ...skipRepoIds],
    );
    return rows[0] ? rowToTask(rows[0]) : null;
  }

  async claimCustomQueuedTask(id: string, actor: string): Promise<Task | null> {
    // Twin of the sqlite driver: claimed only while still the head of its repo.
    return this.tx(async (c, sink) => {
      const r = await c.query(
        toPg(`UPDATE tm_tasks SET status = 'running', updated_at = ?
         WHERE id = ? AND id = (SELECT t.id FROM tm_tasks t WHERE ${CUSTOM_QUEUE_HEAD_WHERE}
                                  AND ${FEATURE_CLAIM_GATE} AND ${OFFICE_CLAIM_GATE} AND ${CUSTOM_QUEUE_SAME_REPO}
                                ${CUSTOM_QUEUE_HEAD_ORDER})
         RETURNING *`),
        [now(), id, await this.officeTripped(c), id],
      );
      if (!r.rows[0]) return null;
      const task = rowToTask(r.rows[0]);
      await this.appendEventWith(c, {
        kind: 'task.transition',
        actor,
        taskId: task.id,
        repoId: task.repoId,
        data: { from: 'queued', to: 'running', claim: 'custom-queue' },
      }, sink);
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
    // Any status change unhides (twin of the sqlite driver).
    sets.push('hidden_at = NULL');
    // Any status change ends a stale-draft Keep (twin of the sqlite driver).
    sets.push('inbox_kept_until = NULL');
    // Terminal status ends custom-queue membership (twin of the sqlite driver).
    if (TERMINAL_TASK_STATUSES.includes(to)) sets.push('custom_queue_at = NULL');
    // The auto-landed stamp (twin of the sqlite driver).
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
    return this.tx(async (c, sink) => {
      const prevRes = await c.query(`SELECT status FROM tm_tasks WHERE id = $1`, [id]);
      const r = await c.query(
        toPg(`UPDATE tm_tasks SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders}) RETURNING *`),
        [...vals, id, ...from],
      );
      if (!r.rows[0]) return null;
      const task = rowToTask(r.rows[0]);
      await this.appendEventWith(c, {
        kind: 'task.transition',
        actor,
        taskId: task.id,
        repoId: task.repoId,
        data: { ...audit, from: prevRes.rows[0]?.status ?? null, to },
      }, sink);
      return task;
    });
  }

  async setTaskDependsOn(id: string, dependsOn: string[], actor: string): Promise<Task | null> {
    return this.tx(async (c, sink) => {
      const ids = [...new Set(dependsOn)];
      const r = await c.query(`UPDATE tm_tasks SET depends_on = $1, updated_at = $2 WHERE id = $3 RETURNING *`, [
        ids.length ? JSON.stringify(ids) : null,
        now(),
        id,
      ]);
      if (!r.rows[0]) return null;
      const t = rowToTask(r.rows[0]);
      await this.appendEventWith(c, { kind: 'task.depends-on', actor, taskId: t.id, repoId: t.repoId, data: { dependsOn: ids } }, sink);
      return t;
    });
  }

  async resolveChildCompletion(childId: string, parentDoneStatus: 'review' | 'done', actor: string): Promise<Task | null> {
    return this.tx(async (c, sink) => {
      const childRes = await c.query(`SELECT parent_id FROM tm_tasks WHERE id = $1`, [childId]);
      const parentId: string | null = childRes.rows[0]?.parent_id ?? null;
      if (!parentId) return null;
      const rows = (await c.query(`SELECT status FROM tm_tasks WHERE parent_id = $1`, [parentId])).rows as {
        status: string;
      }[];
      const unresolved = rows.filter((r) => !TERMINAL_TASK_STATUSES.includes(r.status as Task['status'])).length;
      if (unresolved > 0) return null;
      const failed = rows.filter((r) => r.status === 'failed').length;
      if (failed > 0) {
        // Conditional on blocked — see sqlite driver / review R3.
        const fr = await c.query(
          `UPDATE tm_tasks SET error = $1, updated_at = $2 WHERE id = $3 AND status = 'blocked' AND wait_for IS NULL RETURNING *`,
          [`${failed} subtask(s) failed`, now(), parentId],
        );
        if (!fr.rows[0]) return null;
        const ft = rowToTask(fr.rows[0]);
        await this.appendEventWith(c, {
          kind: 'task.transition',
          actor,
          taskId: ft.id,
          repoId: ft.repoId,
          data: { from: 'blocked', to: 'blocked', childrenFailed: failed },
        }, sink);
        return ft;
      }
      const r = await c.query(
        `UPDATE tm_tasks SET status = $1, updated_at = $2 WHERE id = $3 AND status = 'blocked' AND wait_for IS NULL RETURNING *`,
        [parentDoneStatus, now(), parentId],
      );
      if (!r.rows[0]) return null;
      const t = rowToTask(r.rows[0]);
      await this.appendEventWith(c, {
        kind: 'task.transition',
        actor,
        taskId: t.id,
        repoId: t.repoId,
        data: { from: 'blocked', to: parentDoneStatus, resolvedChildren: rows.length },
      }, sink);
      return t;
    });
  }

  async countChildren(parentId: string): Promise<ChildCounts> {
    const rows = (await this.q(`SELECT status FROM tm_tasks WHERE parent_id = ?`, [parentId])) as {
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
    return (await this.q(sql, params)).map(rowToRun);
  }


  async getRun(id: string): Promise<Run | null> {
    const r = await this.q(`SELECT * FROM tm_runs WHERE id = ?`, [id]);
    return r[0] ? rowToRun(r[0]) : null;
  }

  async getRunByToken(token: string): Promise<Run | null> {
    if (!token) return null;
    const r = await this.q(`SELECT * FROM tm_runs WHERE run_token = ?`, [token]);
    return r[0] ? rowToRun(r[0]) : null;
  }

  async countTasksCreatedByRun(runId: string): Promise<number> {
    const r = await this.q(`SELECT COUNT(*) AS n FROM tm_tasks WHERE created_by_run = ?`, [runId]);
    return Number(r[0].n);
  }

  async countQueuedAgentTasks(): Promise<number> {
    const r = await this.q(`SELECT COUNT(*) AS n FROM tm_tasks WHERE status = 'queued' AND created_by_run IS NOT NULL AND office_id IS NULL`);
    return Number(r[0].n);
  }

  async claimNextAgentChildTask(eligibleRunIds: string[], actor: string, skipRepoIds: string[] = []): Promise<Task | null> {
    if (eligibleRunIds.length === 0) return null;
    const placeholders = eligibleRunIds.map(() => '?').join(', ');
    return this.tx(async (c, sink) => {
      const r = await c.query(
        toPg(`UPDATE tm_tasks SET status = 'running', updated_at = ?
         WHERE id = (SELECT t.id FROM tm_tasks t
                     WHERE t.status = 'queued' AND t.repo_id IS NOT NULL AND t.created_by_run IN (${placeholders})
                       AND t.custom_queue_at IS NULL
                       AND t.queue_held_at IS NULL
                       AND ${FEATURE_OVERFLOW_GATE}
                       AND ${OFFICE_CLAIM_GATE}
                       AND ${REPO_EXCLUSIVE_GATE}${skipRepos(skipRepoIds.length)}
                     ORDER BY t.created_at LIMIT 1)
         RETURNING *`),
        [now(), ...eligibleRunIds, await this.officeTripped(c), ...skipRepoIds],
      );
      if (!r.rows[0]) return null;
      const task = rowToTask(r.rows[0]);
      await this.appendEventWith(c, {
        kind: 'task.transition',
        actor,
        taskId: task.id,
        repoId: task.repoId,
        data: { from: 'queued', to: 'running', claim: 'overflow', createdByRun: task.createdByRun },
      }, sink);
      return task;
    });
  }

  async createRun(r: NewRun): Promise<Run> {
    const id = randomUUID();
    await this.q(
      `INSERT INTO tm_runs (id, task_id, repo_id, mode, kind, subject_id, label, status, pid, model, effort, run_token, resumed_from, stats_baseline, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
      [
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
      ],
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
    await this.q(
      `UPDATE tm_runs SET status=?, pid=?, exit_code=?, needs_attention=?, idle=?, session_id=?, transcript_path=?, stats=?, cost_usd=?, ended_at=? WHERE id=?`,
      [
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
      ],
    );
    // The task's roll-up moves with its runs' stats (docs/token-budget.md §
    // Fuses). One statement recomputing the whole sum, so two runs of the same
    // task writing at once cannot leave a stale total behind.
    const taskId = 'stats' in clean ? runTaskId(next) : null;
    if (taskId) await this.q(`UPDATE tm_tasks SET cost_usd = ${taskCostSql('tm_tasks.id')} WHERE id = ?`, [taskId]);
    return this.getRun(id);
  }

  async bumpRunPeakMem(id: string, mb: number): Promise<Run | null> {
    if (!(mb > 0)) return null;
    const rows = await this.q(`UPDATE tm_runs SET peak_mem_mb = ? WHERE id = ? AND (peak_mem_mb IS NULL OR peak_mem_mb < ?) RETURNING id`, [mb, id, mb]);
    return rows.length > 0 ? this.getRun(id) : null;
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
    return (await this.q(sql, params)).map(rowToDispatch);
  }

  async getDispatch(id: string): Promise<Dispatch | null> {
    const r = await this.q(`SELECT * FROM tm_dispatches WHERE id = ?`, [id]);
    return r[0] ? rowToDispatch(r[0]) : null;
  }

  async createDispatch(d: NewDispatch): Promise<Dispatch> {
    const id = randomUUID();
    await this.q(
      `INSERT INTO tm_dispatches (id, from_task_id, from_run_id, to_task_id, message, intent, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [id, d.fromTaskId, d.fromRunId ?? null, d.toTaskId, d.message, d.intent, now()],
    );
    return (await this.getDispatch(id))!;
  }

  async settleDispatch(
    id: string,
    status: 'delivered' | 'failed' | 'cancelled',
    note?: string | null,
  ): Promise<Dispatch | null> {
    const r = await this.q(
      `UPDATE tm_dispatches SET status = ?, note = ?, delivered_at = ? WHERE id = ? AND status = 'pending' RETURNING *`,
      [status, note ?? null, status === 'delivered' ? now() : null, id],
    );
    return r[0] ? rowToDispatch(r[0]) : null;
  }

  async countDispatchesByRun(runId: string): Promise<number> {
    const r = await this.q(`SELECT COUNT(*) AS n FROM tm_dispatches WHERE from_run_id = ?`, [runId]);
    return Number(r[0].n);
  }

  async countDispatchesBetween(taskA: string, taskB: string): Promise<number> {
    const r = await this.q(
      `SELECT COUNT(*) AS n FROM tm_dispatches WHERE (from_task_id = ? AND to_task_id = ?) OR (from_task_id = ? AND to_task_id = ?)`,
      [taskA, taskB, taskB, taskA],
    );
    return Number(r[0].n);
  }


  // ---- questions (docs/questions.md) ----
  // Same SQL as the SQLite driver, `?` and all — toPg() rewrites. Keep in step.

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
    return (await this.q(sql, params)).map(rowToQuestion);
  }

  // ---- scheduled jobs (docs/jobs.md; SQL shared in job-sql.ts) ----

  async listJobs(f?: JobFilter): Promise<Job[]> {
    const { sql, params } = jobListSql(f);
    return (await this.q(sql, params)).map(rowToJob);
  }

  async getJob(id: string): Promise<Job | null> {
    const r = await this.q(`SELECT * FROM tm_jobs WHERE id = ?`, [id]);
    return r[0] ? rowToJob(r[0]) : null;
  }

  async createJob(j: NewJob): Promise<Job> {
    const id = randomUUID();
    await this.q(JOB_INSERT_SQL, jobInsertParams(id, j, now()));
    return (await this.getJob(id))!;
  }

  async updateJob(id: string, p: JobPatch): Promise<Job | null> {
    const q = jobPatchSql(id, p, now());
    if (!q) return this.getJob(id);
    const r = await this.q(q.sql, q.params);
    return r[0] ? rowToJob(r[0]) : null;
  }

  async deleteJob(id: string): Promise<boolean> {
    await this.q(JOB_RUNS_DELETE_SQL, [id]);
    const r = await this.q(`${JOB_DELETE_SQL} RETURNING id`, [id]);
    return r.length > 0;
  }

  async countLiveJobs(repoId: string): Promise<number> {
    const r = await this.q(JOB_SCHEDULED_COUNT_SQL, [repoId]);
    return Number(r[0]?.n ?? 0);
  }

  async claimDueJob(id: string, at: string, force = false): Promise<Job | null> {
    const { sql, params } = jobClaimSql(id, at, force);
    const r = await this.q(sql, params);
    return r[0] ? rowToJob(r[0]) : null;
  }

  async stepJob(
    id: string,
    from: JobStatus[],
    to: JobStatus,
    opts: { nextRunAt?: string | null; last?: { runId: string | null; verdict: JobVerdict; summary: string | null; at: string; counted: boolean } } = {},
  ): Promise<Job | null> {
    const { sql, params } = jobStepSql(id, from, to, now(), opts);
    const r = await this.q(sql, params);
    return r[0] ? rowToJob(r[0]) : null;
  }

  async createJobRun(r: { jobId: string; runNumber: number; firedBy: string }): Promise<JobRun> {
    const id = randomUUID();
    await this.q(JOB_RUN_INSERT_SQL, [id, r.jobId, null, r.runNumber, r.firedBy, now()]);
    return (await this.getJobRun(id))!;
  }

  async setJobRunRunId(id: string, runId: string): Promise<void> {
    await this.q(JOB_RUN_SET_RUN_ID_SQL, [runId, id]);
  }

  async finishJobRun(id: string, f: JobRunFinish): Promise<JobRun | null> {
    const r = await this.q(JOB_RUN_FINISH_SQL, jobRunFinishParams(id, f, now()));
    return r[0] ? rowToJobRun(r[0]) : null;
  }

  async getJobRun(id: string): Promise<JobRun | null> {
    const r = await this.q(`SELECT * FROM tm_job_runs WHERE id = ?`, [id]);
    return r[0] ? rowToJobRun(r[0]) : null;
  }

  async listJobRuns(jobId: string): Promise<JobRun[]> {
    return (await this.q(JOB_RUNS_FOR_JOB_SQL, [jobId])).map(rowToJobRun);
  }

  async listOpenJobRuns(): Promise<JobRun[]> {
    return (await this.q(JOB_RUNS_OPEN_SQL, [])).map(rowToJobRun);
  }

  async listUnfinishedJobRuns(): Promise<JobRun[]> {
    return (await this.q(JOB_RUNS_UNFINISHED_SQL, [])).map(rowToJobRun);
  }

  async acknowledgeJobRun(id: string): Promise<JobRun | null> {
    const r = await this.q(JOB_RUN_ACK_SQL, [now(), id]);
    return r[0] ? rowToJobRun(r[0]) : null;
  }

  async acknowledgeJobRuns(jobId: string): Promise<JobRun[]> {
    return (await this.q(JOB_RUNS_ACK_ALL_SQL, [now(), jobId])).map(rowToJobRun);
  }

  // ---- approvals (docs/approvals.md; SQL shared in approval-sql.ts) ----

  async listApprovals(f?: ApprovalFilter): Promise<Approval[]> {
    const { sql, params } = approvalListSql(f);
    return (await this.q(sql, params)).map(rowToApproval);
  }

  async getApproval(id: string): Promise<Approval | null> {
    const r = await this.q(`SELECT * FROM tm_approvals WHERE id = ?`, [id]);
    return r[0] ? rowToApproval(r[0]) : null;
  }

  async createApproval(a: NewApproval): Promise<Approval> {
    const id = randomUUID();
    await this.q(APPROVAL_INSERT_SQL, approvalInsertParams(id, a, now()));
    return (await this.getApproval(id))!;
  }

  async decideApproval(id: string, status: 'approved' | 'rejected', actor: string, result: string | null = null): Promise<Approval | null> {
    const r = await this.q(APPROVAL_DECIDE_SQL, [status, actor, now(), result, id]);
    return r[0] ? rowToApproval(r[0]) : null;
  }

  async stepApproval(id: string, from: ApprovalStatus[], to: ApprovalStatus, result: string | null = null): Promise<Approval | null> {
    const { sql, params } = approvalStepSql(from, to, result, now(), id);
    const r = await this.q(sql, params);
    return r[0] ? rowToApproval(r[0]) : null;
  }

  async expireApprovals(from: ApprovalStatus[], note: string): Promise<Approval[]> {
    const { sql, params } = approvalExpireSql(from, note, now());
    return (await this.q(sql, params)).map(rowToApproval);
  }

  // ---- web push devices (docs/push.md) ----

  async listPushDevices(): Promise<PushDeviceRecord[]> {
    return (await this.q(`SELECT * FROM tm_push_devices ORDER BY created_at`, [])).map(rowToPushDevice);
  }

  async upsertPushDevice(d: NewPushDevice): Promise<PushDeviceRecord> {
    const t = now();
    const r = await this.q(PUSH_UPSERT_SQL, [randomUUID(), d.endpoint, d.p256dh, d.auth, d.label, JSON.stringify(d.kinds), t, t]);
    return rowToPushDevice(r[0]);
  }

  async updatePushDevice(id: string, patch: { label?: string; kinds?: PushKind[] }): Promise<PushDeviceRecord | null> {
    const r = await this.q(
      `UPDATE tm_push_devices SET label = COALESCE(?, label), kinds = COALESCE(?, kinds), updated_at = ? WHERE id = ? RETURNING *`,
      [patch.label ?? null, patch.kinds ? JSON.stringify(patch.kinds) : null, now(), id],
    );
    return r[0] ? rowToPushDevice(r[0]) : null;
  }

  async deletePushDevice(id: string): Promise<boolean> {
    return (await this.q(`DELETE FROM tm_push_devices WHERE id = ? RETURNING id`, [id])).length > 0;
  }

  async recordPushResult(id: string, error: string | null): Promise<void> {
    if (error === null) await this.q(PUSH_RESULT_OK_SQL, [now(), id]);
    else await this.q(PUSH_RESULT_FAIL_SQL, [error, id]);
  }

  async getQuestion(id: string): Promise<Question | null> {
    const r = await this.q(`SELECT * FROM tm_questions WHERE id = ?`, [id]);
    return r[0] ? rowToQuestion(r[0]) : null;
  }

  async createQuestion(q: NewQuestion): Promise<Question> {
    const id = randomUUID();
    await this.q(
      `INSERT INTO tm_questions (id, task_id, run_id, tool_use_id, status, questions, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [id, q.taskId, q.runId, q.toolUseId, JSON.stringify(q.questions), now()],
    );
    return (await this.getQuestion(id))!;
  }

  async answerQuestion(id: string, answers: Record<string, string>, actor: string): Promise<Question | null> {
    const r = await this.q(
      `UPDATE tm_questions SET status = 'answered', answers = ?, answered_by = ?, answered_at = ? WHERE id = ? AND status = 'pending' RETURNING *`,
      [JSON.stringify(answers), actor, now(), id],
    );
    return r[0] ? rowToQuestion(r[0]) : null;
  }

  async setQuestionAnswers(id: string, answers: Record<string, string>): Promise<void> {
    await this.q(`UPDATE tm_questions SET answers = ? WHERE id = ?`, [JSON.stringify(answers), id]);
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
    const rows = await this.q(
      `UPDATE tm_questions SET status = 'expired', note = ?, answered_at = ? WHERE ${where.join(' AND ')} RETURNING *`,
      params,
    );
    return rows.map(rowToQuestion);
  }

  // ---- chats (docs/chat.md) ----
  //
  // Character-for-character the same SQL as the SQLite driver, `?` and all —
  // toPg() rewrites the placeholders. Keep the two in step.

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
    const sql = `SELECT * FROM tm_chats ${where} ORDER BY COALESCE(last_message_at, created_at) DESC, id DESC`;
    return (await this.q(sql, params)).map(rowToChat);
  }

  async getChat(id: string): Promise<Chat | null> {
    const r = await this.q(`SELECT * FROM tm_chats WHERE id = ?`, [id]);
    return r[0] ? rowToChat(r[0]) : null;
  }

  async createChat(c: NewChat): Promise<Chat> {
    const id = randomUUID();
    const ts = now();
    await this.q(
      `INSERT INTO tm_chats (id, repo_id, title, model, effort, mode, status, turns, cost_usd, created_at, updated_at, office_id, participants, planner_workspace_id)
       VALUES (?, ?, ?, ?, ?, ?, 'idle', 0, 0, ?, ?, ?, ?, ?)`,
      [id, c.repoId, c.title, c.model, c.effort ?? null, c.mode, ts, ts, c.officeId ?? null, JSON.stringify(c.participants ?? []), c.plannerWorkspaceId ?? null],
    );
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
    await this.q(`UPDATE tm_chats SET title = ?, model = ?, effort = ?, mode = ?, updated_at = ? WHERE id = ?`, [
      next.title,
      next.model,
      next.effort,
      next.mode,
      now(),
      id,
    ]);
    return this.getChat(id);
  }

  async deleteChat(id: string): Promise<boolean> {
    return this.tx(async (c) => {
      const r = await c.query(toPg(`DELETE FROM tm_chats WHERE id = ?`), [id]);
      if (!r.rowCount) return false;
      await c.query(toPg(`DELETE FROM tm_chat_messages WHERE chat_id = ?`), [id]);
      return true;
    });
  }

  async listChatMessages(chatId: string, limit?: number): Promise<ChatMessage[]> {
    if (limit && limit > 0) {
      const rows = await this.q(`SELECT * FROM tm_chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?`, [
        chatId,
        limit,
      ]);
      return rows.reverse().map(rowToChatMessage);
    }
    return (await this.q(`SELECT * FROM tm_chat_messages WHERE chat_id = ? ORDER BY id ASC`, [chatId])).map(
      rowToChatMessage,
    );
  }

  async appendChatMessage(m: NewChatMessage): Promise<ChatMessage> {
    const id = eventId();
    const at = now();
    return this.tx(async (c) => {
      await c.query(
        toPg(`INSERT INTO tm_chat_messages (id, chat_id, role, text, actor, error, cost_usd, duration_ms, created_at, role_id, tainted_at, blueprint)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
        [id, m.chatId, m.role, m.text, m.actor, m.error ?? null, m.costUsd ?? 0, m.durationMs ?? null, at, m.roleId ?? null, m.taintedAt ?? null, m.blueprint ? JSON.stringify(m.blueprint) : null],
      );
      await c.query(toPg(`UPDATE tm_chats SET last_message_at = ?, updated_at = ? WHERE id = ?`), [at, at, m.chatId]);
      const r = await c.query(toPg(`SELECT * FROM tm_chat_messages WHERE id = ?`), [id]);
      return rowToChatMessage(r.rows[0]);
    });
  }

  async getChatMessage(id: string): Promise<ChatMessage | null> {
    const r = (await this.q(`SELECT * FROM tm_chat_messages WHERE id = ?`, [id]))[0];
    return r ? rowToChatMessage(r) : null;
  }

  async setChatMessageChannel(id: string, channelMessageId: string): Promise<ChatMessage | null> {
    const r = (
      await this.q(`UPDATE tm_chat_messages SET channel_message_id = ? WHERE id = ? AND channel_message_id IS NULL RETURNING *`, [
        channelMessageId,
        id,
      ])
    )[0];
    return r ? rowToChatMessage(r) : null;
  }

  async getPlannerChat(workspaceId: string): Promise<Chat | null> {
    const r = await this.q(`SELECT * FROM tm_chats WHERE planner_workspace_id = ? ORDER BY created_at ASC, id ASC LIMIT 1`, [workspaceId]);
    return r[0] ? rowToChat(r[0]) : null;
  }

  async markChatBlueprintApplied(id: string): Promise<ChatMessage | null> {
    const r = (
      await this.q(
        `UPDATE tm_chat_messages SET blueprint_applied_at = ? WHERE id = ? AND blueprint IS NOT NULL AND blueprint_applied_at IS NULL RETURNING *`,
        [now(), id],
      )
    )[0];
    return r ? rowToChatMessage(r) : null;
  }

  async beginChatTurn(id: string): Promise<Chat | null> {
    const r = await this.q(
      `UPDATE tm_chats SET status = 'thinking', error = NULL, updated_at = ?
       WHERE id = ? AND status IN ('idle', 'error') RETURNING *`,
      [now(), id],
    );
    return r[0] ? rowToChat(r[0]) : null;
  }

  async setChatPid(id: string, pid: number | null): Promise<void> {
    await this.q(`UPDATE tm_chats SET pid = ? WHERE id = ?`, [pid, id]);
  }

  async finishChatTurn(id: string, res: ChatTurnResult): Promise<Chat | null> {
    const r = await this.q(
      `UPDATE tm_chats SET
         status = ?,
         error = ?,
         session_id = COALESCE(?, session_id),
         pid = NULL,
         turns = turns + ?,
         cost_usd = cost_usd + ?,
         updated_at = ?
       WHERE id = ? RETURNING *`,
      [res.error ? 'error' : 'idle', res.error, res.sessionId ?? null, res.error ? 0 : 1, res.costUsd, now(), id],
    );
    return r[0] ? rowToChat(r[0]) : null;
  }

  async countThinkingChats(): Promise<number> {
    const r = await this.q(`SELECT COUNT(*) AS n FROM tm_chats WHERE status = 'thinking'`);
    return Number(r[0].n);
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
    return (await this.q(sql, params)).map(rowToProposal);
  }

  async getProposal(id: string): Promise<Proposal | null> {
    const r = await this.q(`SELECT * FROM tm_proposals WHERE id = ?`, [id]);
    return r[0] ? rowToProposal(r[0]) : null;
  }

  async createProposal(p: NewProposal): Promise<Proposal> {
    const id = randomUUID();
    await this.q(
      `INSERT INTO tm_proposals (id, run_id, repo_id, task_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, p.runId ?? null, p.repoId ?? null, p.taskId ?? null, p.kind, JSON.stringify(p.payload), now()],
    );
    return (await this.getProposal(id))!;
  }

  async rejectProposal(id: string): Promise<Proposal | null> {
    await this.q(`UPDATE tm_proposals SET status = 'rejected' WHERE id = ? AND status = 'pending'`, [id]);
    return this.getProposal(id);
  }

  async acceptProposal(
    id: string,
    actor: string,
    chosenOptionIndex?: number,
  ): Promise<{ proposal: Proposal; tasks: Task[] } | null> {
    return this.tx(async (c, sink) => {
      const row = await c.query(`SELECT * FROM tm_proposals WHERE id = $1 FOR UPDATE`, [id]);
      if (!row.rows[0]) return null;
      const proposal = rowToProposal(row.rows[0]);
      if (proposal.status !== 'pending') return null;

      const affected: Task[] = [];
      const p = proposal.payload;

      switch (proposal.kind) {
        case 'rewrite': {
          if (!proposal.taskId) return null;
          const t = await this.updateTaskWith(c, proposal.taskId, {
            title: p.title ?? undefined,
            description: p.description ?? undefined,
          });
          if (!t) return null;
          affected.push(t);
          break;
        }
        case 'split': {
          if (!proposal.taskId || !p.subtasks?.length) return null;
          const parentRes = await c.query(`SELECT * FROM tm_tasks WHERE id = $1`, [proposal.taskId]);
          if (!parentRes.rows[0]) return null;
          const parentTask = rowToTask(parentRes.rows[0]);
          // Conditional block FIRST — see sqlite driver / review R3.
          const blockedRes = await c.query(
            `UPDATE tm_tasks SET status = 'blocked', updated_at = $1
             WHERE id = $2 AND status IN ('draft', 'queued', 'review', 'failed', 'blocked') RETURNING *`,
            [now(), parentTask.id],
          );
          if (!blockedRes.rows[0]) return null;
          await this.appendEventWith(c, {
            kind: 'task.transition',
            actor,
            taskId: parentTask.id,
            repoId: parentTask.repoId,
            data: { from: parentTask.status, to: 'blocked', splitAccept: true },
          }, sink);
          for (const st of p.subtasks) {
            affected.push(
              await this.insertTaskWith(c, {
                title: st.title,
                description: st.description,
                repoId: parentTask.repoId,
                parentId: parentTask.id,
                status: 'queued',
                source: 'auto',
                spawnDepth: parentTask.spawnDepth, // review R4
                // children of a feature task belong to the SAME phase
                featureId: parentTask.featureId,
                featurePhase: parentTask.featurePhase,
              }, actor, sink),
            );
          }
          affected.push(rowToTask(blockedRes.rows[0]));
          break;
        }
        case 'new_task': {
          affected.push(
            await this.insertTaskWith(
              c,
              {
                title: p.title ?? 'Untitled task',
                description: p.description ?? p.rationale,
                repoId: proposal.repoId,
                status: 'draft',
                source: 'auto',
              },
              actor,
              sink,
            ),
          );
          break;
        }
        case 'solution_options': {
          if (!proposal.taskId || !p.options?.length) return null;
          const opt = p.options[chosenOptionIndex ?? 0];
          if (!opt) return null;
          const curRes = await c.query(`SELECT * FROM tm_tasks WHERE id = $1`, [proposal.taskId]);
          if (!curRes.rows[0]) return null;
          const task = rowToTask(curRes.rows[0]);
          const appended =
            (task.description ?? '') +
            `\n\n## Chosen approach: ${opt.label}\n${opt.approach}\nTradeoffs: ${opt.tradeoffs}`;
          const t = await this.updateTaskWith(c, task.id, { description: appended.trim() });
          if (t) affected.push(t);
          break;
        }
      }

      await c.query(`UPDATE tm_proposals SET status = 'accepted' WHERE id = $1`, [id]);
      const updated = rowToProposal((await c.query(`SELECT * FROM tm_proposals WHERE id = $1`, [id])).rows[0]);
      await this.appendEventWith(c, {
        kind: 'proposal.decided',
        actor,
        taskId: proposal.taskId,
        repoId: proposal.repoId,
        data: { proposalId: id, kind: proposal.kind, decision: 'accepted' },
      }, sink);
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
    return (await this.q(sql, params)).map(rowToFeature);
  }

  async getFeature(id: string): Promise<Feature | null> {
    const r = await this.q(`SELECT * FROM tm_features WHERE id = ?`, [id]);
    return r[0] ? rowToFeature(r[0]) : null;
  }

  async createFeature(f: NewFeature, actor: string): Promise<Feature> {
    return this.tx(async (c, sink) => {
      const id = randomUUID();
      const ts = now();
      await c.query(
        `INSERT INTO tm_features (id, repo_id, title, request, status, analysis, review, analysis_rounds, error, office_id, tainted_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'draft', NULL, NULL, 0, NULL, $5, $6, $7, $8)`,
        [id, f.repoId, f.title, f.request, f.officeId ?? null, f.taintedAt ?? null, ts, ts],
      );
      const feature = rowToFeature((await c.query(`SELECT * FROM tm_features WHERE id = $1`, [id])).rows[0]);
      await this.appendEventWith(
        c,
        {
          kind: 'feature.created',
          actor,
          repoId: feature.repoId,
          data: { featureId: feature.id, title: feature.title },
        },
        sink,
      );
      return feature;
    });
  }

  /** Applies only the present keys; `analysis: null` explicitly clears. */
  private async writeFeaturePatchWith(c: pg.PoolClient, id: string, patch: FeaturePatch): Promise<Feature | null> {
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
    const r = await c.query(toPg(`UPDATE tm_features SET ${sets.join(', ')} WHERE id = ? RETURNING *`), [...vals, id]);
    return r.rows[0] ? rowToFeature(r.rows[0]) : null;
  }

  async updateFeature(id: string, patch: FeaturePatch, actor: string): Promise<Feature | null> {
    return this.tx(async (c, sink) => {
      const feature = await this.writeFeaturePatchWith(c, id, patch);
      if (!feature) return null;
      await this.appendEventWith(
        c,
        { kind: 'feature.edited', actor, repoId: feature.repoId, data: { featureId: id, fields: Object.keys(patch) } },
        sink,
      );
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
    return this.tx((c, sink) => this.transitionFeatureWith(c, sink, id, from, to, actor, patch));
  }

  /** Conditional status move — twin of transitionTask (see sqlite driver). */
  private async transitionFeatureWith(
    c: pg.PoolClient,
    sink: AuditEvent[],
    id: string,
    from: FeatureStatus[],
    to: FeatureStatus,
    actor: string,
    patch?: FeaturePatch,
  ): Promise<Feature | null> {
    const prevRes = await c.query(`SELECT status FROM tm_features WHERE id = $1`, [id]);
    const placeholders = from.map(() => '?').join(', ');
    const guard = await c.query(toPg(`SELECT id FROM tm_features WHERE id = ? AND status IN (${placeholders})`), [
      id,
      ...from,
    ]);
    if (!guard.rows[0]) return null;
    if (patch) await this.writeFeaturePatchWith(c, id, patch);
    const r = await c.query(
      toPg(`UPDATE tm_features SET status = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders}) RETURNING *`),
      [to, now(), id, ...from],
    );
    if (!r.rows[0]) return null;
    const feature = rowToFeature(r.rows[0]);
    await this.appendEventWith(
      c,
      {
        kind: 'feature.transition',
        actor,
        repoId: feature.repoId,
        data: { featureId: id, from: prevRes.rows[0]?.status ?? null, to },
      },
      sink,
    );
    return feature;
  }

  async deleteFeature(id: string): Promise<boolean> {
    return this.tx(async (c) => {
      const n = await c.query(`SELECT COUNT(*) AS n FROM tm_tasks WHERE feature_id = $1`, [id]);
      if (Number(n.rows[0].n) > 0) return false;
      await c.query(`DELETE FROM tm_features WHERE id = $1`, [id]);
      return true;
    });
  }

  async approveFeature(id: string, actor: string): Promise<{ feature: Feature; tasks: Task[] } | null> {
    return this.tx(async (c, sink) => {
      const row = await c.query(`SELECT * FROM tm_features WHERE id = $1 FOR UPDATE`, [id]);
      if (!row.rows[0]) return null;
      const feature = rowToFeature(row.rows[0]);
      if (feature.status !== 'proposed' || !feature.repoId || !feature.analysis) return null;
      const cards = planCards(feature);
      if (cards.length === 0) return null;
      // see the sqlite driver: an office feature's cards land in their own repos
      let roleId: string | null = null;
      let workspaceRepoIds: string[] | null = null;
      if (feature.officeId) {
        const ws = (await c.query(toPg(OFFICE_WORKSPACE_REPOS_SQL), [feature.officeId])).rows[0];
        if (ws) {
          workspaceRepoIds = [];
          for (const r of parseRepoIds(ws.repo_ids)) {
            if ((await c.query(toPg(REPO_EXISTS_SQL), [r])).rows[0]) workspaceRepoIds.push(r);
          }
        }
        roleId = (await c.query(toPg(OFFICE_DIRECTOR_ROLE_SQL), [feature.officeId])).rows[0]?.id ?? null;
      }
      const repoOfCard = approvalCardRepos(feature, cards, workspaceRepoIds);
      const tasks: Task[] = [];
      const taskOfCard = new Map<string, string>();
      for (const [i, card] of cards.entries()) {
        const task = await this.insertTaskWith(
            c,
            {
              title: card.card.title,
              description: card.description,
              repoId: repoOfCard[i],
              status: 'draft',
              source: 'feature',
              category: card.card.category ?? null,
              effort: card.card.effort ?? null,
              review: card.card.review ?? null,
              featureId: feature.id,
              featurePhase: card.phase,
              // see the sqlite driver: edges onto EARLIER cards only
              dependsOn: card.dependsOnCards.map((id) => taskOfCard.get(id)).filter((id): id is string => !!id),
              ...(feature.officeId ? { officeId: feature.officeId, roleId, taintedAt: feature.taintedAt } : {}),
            },
            actor,
            sink,
          );
        taskOfCard.set(card.card.id, task.id);
        tasks.push(task);
      }
      const updated = await this.transitionFeatureWith(c, sink, id, ['proposed'], 'approved', actor, { error: null });
      // See the sqlite driver: returning null here would commit orphan tasks.
      if (!updated) throw new Error('feature approval raced: status changed mid-transaction');
      return { feature: updated, tasks };
    });
  }

  async resolveFeatureCompletion(featureId: string, actor: string): Promise<FeatureResolution | null> {
    return this.tx(async (c, sink) => {
      const row = await c.query(`SELECT * FROM tm_features WHERE id = $1 FOR UPDATE`, [featureId]);
      if (!row.rows[0]) return null;
      const feature = rowToFeature(row.rows[0]);
      if (feature.status !== 'running') return null;
      const tasks = (await c.query(`SELECT * FROM tm_tasks WHERE feature_id = $1`, [featureId])).rows.map(rowToTask);
      if (tasks.length === 0) return null;

      // the decision is shared with the sqlite driver (planFeatureProgress); this only executes it
      const plan = planFeatureProgress(feature, tasks);
      if (plan.kind === 'paused') {
        const paused = await this.transitionFeatureWith(c, sink, featureId, ['running'], 'paused', actor, { error: plan.error });
        return paused ? { feature: paused, tasks: [], action: 'paused' as const } : null;
      }
      if (plan.kind === 'review') {
        const done = await this.transitionFeatureWith(c, sink, featureId, ['running'], 'review', actor, { error: null });
        return done ? { feature: done, tasks: [], action: 'review' as const } : null;
      }

      const { phase } = plan;
      // a tainted office card stays a draft for the human (plan.held); its count is the feature's reason
      const shown = plan.error !== undefined ? ((await this.writeFeaturePatchWith(c, featureId, { error: plan.error })) ?? feature) : feature;
      const held = plan.held.length;
      const started: Task[] = [];
      for (const t of plan.queue) {
        const r = await c.query(
          `UPDATE tm_tasks SET status = 'queued', error = NULL, updated_at = $1 WHERE id = $2 AND status = 'draft' RETURNING *`,
          [now(), t.id],
        );
        if (!r.rows[0]) continue;
        const queued = rowToTask(r.rows[0]);
        started.push(queued);
        await this.appendEventWith(
          c,
          {
            kind: 'task.transition',
            actor,
            taskId: queued.id,
            repoId: queued.repoId,
            data: { from: 'draft', to: 'queued', featureId, featurePhase: phase },
          },
          sink,
        );
      }
      if (started.length === 0) return { feature: shown, tasks: [], action: 'none' as const, phase, held };
      return { feature: shown, tasks: started, action: 'phase-started' as const, phase, held };
    });
  }

  async cancelFeature(
    id: string,
    actor: string,
  ): Promise<{ feature: Feature; tasks: Task[]; runningTaskIds: string[] } | null> {
    return this.tx(async (c, sink) => {
      // Feature first — see the sqlite driver.
      const feature = await this.transitionFeatureWith(
        c,
        sink,
        id,
        ['draft', 'analyzing', 'proposed', 'approved', 'running', 'paused', 'review', 'failed'],
        'cancelled',
        actor,
      );
      if (!feature) return null;
      const tasks = (await c.query(`SELECT * FROM tm_tasks WHERE feature_id = $1`, [id])).rows.map(rowToTask);
      const cancelled: Task[] = [];
      for (const t of tasks) {
        if (t.status !== 'draft' && t.status !== 'queued') continue;
        const r = await c.query(
          `UPDATE tm_tasks SET status = 'cancelled', updated_at = $1 WHERE id = $2 AND status IN ('draft', 'queued') RETURNING *`,
          [now(), t.id],
        );
        if (!r.rows[0]) continue;
        const cur = rowToTask(r.rows[0]);
        cancelled.push(cur);
        await this.appendEventWith(
          c,
          {
            kind: 'task.transition',
            actor,
            taskId: cur.id,
            repoId: cur.repoId,
            data: { from: t.status, to: 'cancelled', featureId: id },
          },
          sink,
        );
      }
      return { feature, tasks: cancelled, runningTaskIds: tasks.filter((t) => t.status === 'running').map((t) => t.id) };
    });
  }

  // ---- settings ----

  // ---- Reports (docs/reports.md) ----

  async listReports(): Promise<Report[]> {
    return (await this.q(`SELECT * FROM tm_reports ORDER BY created_at DESC`)).map(rowToReport);
  }

  async getReport(id: string): Promise<Report | null> {
    const r = await this.q(`SELECT * FROM tm_reports WHERE id = ?`, [id]);
    return r[0] ? rowToReport(r[0]) : null;
  }

  async createReport(r: NewReport, actor: string): Promise<Report> {
    const id = randomUUID();
    const at = now();
    await this.q(
      `INSERT INTO tm_reports (id, title, repo_ids, from_date, to_date, preset, language, status, task_count, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      [id, r.title, JSON.stringify(r.repoIds), r.fromDate, r.toDate, r.preset, r.language, r.model, at, at],
    );
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
    const r = await this.q(`UPDATE tm_reports SET ${sets.join(', ')} WHERE id = ? RETURNING *`, params);
    return r[0] ? rowToReport(r[0]) : null;
  }

  async deleteReport(id: string): Promise<boolean> {
    const r = await this.q(`DELETE FROM tm_reports WHERE id = ? RETURNING id`, [id]);
    return r.length > 0;
  }
  // ---- Shared spaces (docs/shared-spaces.md) ----

  async listSpaces(): Promise<Space[]> {
    return (await this.q(`SELECT * FROM tm_spaces ORDER BY created_at ASC`)).map(rowToSpace);
  }

  async getSpace(id: string): Promise<Space | null> {
    const r = await this.q(`SELECT * FROM tm_spaces WHERE id = ?`, [id]);
    return r[0] ? rowToSpace(r[0]) : null;
  }

  async createSpace(s: NewSpace): Promise<Space> {
    const id = randomUUID();
    const at = now();
    await this.q(SPACE_INSERT_SQL, [id, s.name, s.path, JSON.stringify(s.repoIds), at, at]);
    return (await this.getSpace(id))!;
  }

  async updateSpace(id: string, patch: SpacePatch): Promise<Space | null> {
    const cols = spacePatchColumns(patch);
    if (cols.length === 0) return this.getSpace(id);
    const r = await this.q(
      `UPDATE tm_spaces SET ${cols.map(([c]) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? RETURNING *`,
      [...cols.map(([, v]) => v), now(), id],
    );
    return r[0] ? rowToSpace(r[0]) : null;
  }

  async deleteSpace(id: string): Promise<boolean> {
    return this.tx(async (c) => {
      await c.query(toPg(`DELETE FROM tm_shared_notes WHERE space_id = ?`), [id]);
      const r = await c.query(toPg(`DELETE FROM tm_spaces WHERE id = ? RETURNING id`), [id]);
      return (r.rowCount ?? 0) > 0;
    });
  }

  // ---- Virtual Office (docs/office.md § Data model; SQL in office-sql.ts) ----

  async listOffices(): Promise<Office[]> {
    return (await this.q(OFFICE_LIST_SQL)).map(rowToOffice);
  }

  async getOffice(id: string): Promise<Office | null> {
    const r = await this.q(OFFICE_GET_SQL, [id]);
    return r[0] ? rowToOffice(r[0]) : null;
  }

  async getOfficeByWorkspace(workspaceId: string): Promise<Office | null> {
    const r = await this.q(OFFICE_BY_WORKSPACE_SQL, [workspaceId]);
    return r[0] ? rowToOffice(r[0]) : null;
  }

  async createOffice(o: NewOffice): Promise<Office> {
    const id = randomUUID();
    await this.q(OFFICE_INSERT_SQL, officeInsertParams(id, o, now()));
    return (await this.getOffice(id))!;
  }

  async updateOffice(id: string, patch: OfficePatch): Promise<Office | null> {
    const q = officePatchSql(id, patch, now());
    if (!q) return this.getOffice(id);
    const r = await this.q(q.sql, q.params);
    return r[0] ? rowToOffice(r[0]) : null;
  }

  async deleteOffice(id: string): Promise<boolean> {
    return this.tx(async (c) => {
      await c.query(toPg(OFFICE_SHIFTS_DELETE_SQL), [id]);
      await c.query(toPg(OFFICE_BRIEFS_DELETE_SQL), [id]);
      await c.query(toPg(OFFICE_PROPOSALS_DELETE_SQL), [id]);
      await c.query(toPg(OFFICE_WISHES_DELETE_SQL), [id]);
      await c.query(toPg(OFFICE_RATINGS_DELETE_SQL), [id]);
      await c.query(toPg(OFFICE_METRICS_POINTS_DELETE_FOR_OFFICE_SQL), [id]);
      await c.query(toPg(OFFICE_METRICS_DELETE_SQL), [id]);
      await c.query(toPg(OFFICE_MESSAGES_DELETE_SQL), [id]);
      await c.query(toPg(OFFICE_HUDDLES_DELETE_SQL), [id]);
      await c.query(toPg(OFFICE_SIGNALS_DELETE_SQL), [id]);
      await c.query(toPg(OFFICE_ROLES_DELETE_SQL), [id]);
      const r = await c.query(toPg(`${OFFICE_DELETE_SQL} RETURNING id`), [id]);
      return (r.rowCount ?? 0) > 0;
    });
  }

  async pauseOffice(id: string, reason: string | null, expectedPaused: boolean): Promise<Office | null> {
    const q = officePauseSql(id, reason, expectedPaused, now());
    const r = await this.q(q.sql, q.params);
    return r[0] ? rowToOffice(r[0]) : null;
  }

  async listOfficeRoles(officeId?: string): Promise<OfficeRole[]> {
    const q = officeRoleListSql(officeId);
    return (await this.q(q.sql, q.params)).map(rowToOfficeRole);
  }

  async getOfficeRole(id: string): Promise<OfficeRole | null> {
    const r = await this.q(OFFICE_ROLE_GET_SQL, [id]);
    return r[0] ? rowToOfficeRole(r[0]) : null;
  }

  async createOfficeRole(role: NewOfficeRole): Promise<OfficeRole> {
    const id = randomUUID();
    await this.q(OFFICE_ROLE_INSERT_SQL, officeRoleInsertParams(id, role, now()));
    return (await this.getOfficeRole(id))!;
  }

  async updateOfficeRole(id: string, patch: OfficeRolePatch): Promise<OfficeRole | null> {
    const q = officeRolePatchSql(id, patch, now());
    if (!q) return this.getOfficeRole(id);
    const r = await this.q(q.sql, q.params);
    return r[0] ? rowToOfficeRole(r[0]) : null;
  }

  async deleteOfficeRole(id: string): Promise<boolean> {
    const r = await this.q(`${OFFICE_ROLE_DELETE_SQL} RETURNING id`, [id]);
    return r.length > 0;
  }

  async appendShift(s: NewOfficeShift): Promise<OfficeShift> {
    const id = randomUUID();
    await this.q(OFFICE_SHIFT_INSERT_SQL, officeShiftInsertParams(id, s, now()));
    return (await this.getShift(id))!;
  }

  async updateShift(id: string, patch: OfficeShiftPatch): Promise<OfficeShift | null> {
    const q = officeShiftPatchSql(id, patch);
    if (!q) return this.getShift(id);
    const r = await this.q(q.sql, q.params);
    return r[0] ? rowToOfficeShift(r[0]) : null;
  }

  async getShift(id: string): Promise<OfficeShift | null> {
    const r = await this.q(OFFICE_SHIFT_GET_SQL, [id]);
    return r[0] ? rowToOfficeShift(r[0]) : null;
  }

  async listShifts(f?: OfficeShiftFilter): Promise<OfficeShift[]> {
    const q = officeShiftListSql(f);
    return (await this.q(q.sql, q.params)).map(rowToOfficeShift);
  }

  async officeSpendSince(officeId: string, sinceIso: string, roleId?: string): Promise<number> {
    const q = officeSpendSql(officeId, sinceIso, roleId);
    const r = await this.q(q.sql, q.params);
    return Number(r[0]?.s ?? 0) || 0;
  }

  async countOpenOfficeTasks(officeId: string, roleId?: string): Promise<number> {
    const q = officeOpenTasksSql(officeId, roleId);
    const r = await this.q(q.sql, q.params);
    return Number(r[0]?.n ?? 0);
  }

  // ---- office briefs, proposals, wishes (migration 58; SQL in office-sql.ts) ----

  async appendBrief(b: NewOfficeBrief): Promise<OfficeBrief> {
    const id = randomUUID();
    await this.q(OFFICE_BRIEF_INSERT_SQL, officeBriefInsertParams(id, b, now()));
    return (await this.getBrief(id))!;
  }

  async getBrief(id: string): Promise<OfficeBrief | null> {
    const r = (await this.q(OFFICE_BRIEF_GET_SQL, [id]))[0];
    return r ? rowToOfficeBrief(r) : null;
  }

  async listBriefs(f?: OfficeBriefFilter): Promise<OfficeBrief[]> {
    const q = officeBriefListSql(f);
    return (await this.q(q.sql, q.params)).map(rowToOfficeBrief);
  }

  async appendOfficeProposal(p: NewOfficeProposal): Promise<OfficeProposal> {
    const id = randomUUID();
    await this.q(OFFICE_PROPOSAL_INSERT_SQL, officeProposalInsertParams(id, p, now()));
    return (await this.getOfficeProposal(id))!;
  }

  async getOfficeProposal(id: string): Promise<OfficeProposal | null> {
    const r = (await this.q(OFFICE_PROPOSAL_GET_SQL, [id]))[0];
    return r ? rowToOfficeProposal(r) : null;
  }

  async listOfficeProposals(f?: OfficeProposalFilter): Promise<OfficeProposal[]> {
    const q = officeProposalListSql(f);
    return (await this.q(q.sql, q.params)).map(rowToOfficeProposal);
  }

  async decideProposal(
    id: string,
    to: 'accepted' | 'rejected',
    by: string,
    filedTaskId: string | null = null,
    note: string | null = null,
  ): Promise<OfficeProposal | null> {
    const q = officeProposalDecideSql(id, to, by, now(), filedTaskId, note);
    const r = (await this.q(q.sql, q.params))[0];
    return r ? rowToOfficeProposal(r) : null;
  }

  async undoOfficeProposalAccept(id: string): Promise<OfficeProposal | null> {
    const r = (await this.q(OFFICE_PROPOSAL_UNDO_ACCEPT_SQL, [id]))[0];
    return r ? rowToOfficeProposal(r) : null;
  }

  async countPendingOfficeProposals(officeId: string): Promise<number> {
    const r = (await this.q(OFFICE_PROPOSALS_PENDING_COUNT_SQL, [officeId]))[0];
    return Number(r?.n ?? 0);
  }

  async setProposalFiledTask(id: string, taskId: string): Promise<OfficeProposal | null> {
    const q = officeProposalFiledSql(id, taskId);
    const r = (await this.q(q.sql, q.params))[0];
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
    const r = (await this.q(q.sql, q.params))[0];
    if (!r) return null;
    return table === 'brief' ? rowToOfficeBrief(r) : table === 'message' ? rowToOfficeMessage(r) : rowToOfficeProposal(r);
  }

  async clearBriefTaint(id: string, expectedTaintedAt: string, newPath: string): Promise<OfficeBrief | null> {
    const r = (await this.q(OFFICE_BRIEF_CLEAR_TAINT_SQL, [newPath, now(), id, expectedTaintedAt]))[0];
    return r ? rowToOfficeBrief(r) : null;
  }

  async createWish(w: NewOfficeWish): Promise<OfficeWish> {
    const id = randomUUID();
    await this.q(OFFICE_WISH_INSERT_SQL, officeWishInsertParams(id, w, now()));
    return (await this.getWish(id))!;
  }

  async getWish(id: string): Promise<OfficeWish | null> {
    const r = (await this.q(OFFICE_WISH_GET_SQL, [id]))[0];
    return r ? rowToOfficeWish(r) : null;
  }

  async listWishes(f?: OfficeWishFilter): Promise<OfficeWish[]> {
    const q = officeWishListSql(f);
    return (await this.q(q.sql, q.params)).map(rowToOfficeWish);
  }

  async updateWish(id: string, patch: OfficeWishPatch): Promise<OfficeWish | null> {
    const q = officeWishPatchSql(id, patch, now());
    if (!q) return this.getWish(id);
    const r = (await this.q(q.sql, q.params))[0];
    return r ? rowToOfficeWish(r) : null;
  }

  async deleteWish(id: string): Promise<boolean> {
    return (await this.q(`${OFFICE_WISH_DELETE_SQL} RETURNING id`, [id])).length > 0;
  }

  // ---- office ratings (migration 64; SQL in rating-sql.ts) ----

  async getOfficeRating(kind: OfficeRatingSubjectKind, subjectId: string): Promise<OfficeRating | null> {
    const r = (await this.q(OFFICE_RATING_GET_SQL, [kind, subjectId]))[0];
    return r ? rowToOfficeRating(r) : null;
  }

  async upsertOfficeRating(r: NewOfficeRating): Promise<OfficeRating> {
    return rowToOfficeRating((await this.q(OFFICE_RATING_UPSERT_SQL, officeRatingUpsertParams(randomUUID(), r, now())))[0]);
  }

  async listOfficeRatings(f?: OfficeRatingFilter): Promise<OfficeRating[]> {
    const q = officeRatingListSql(f);
    return (await this.q(q.sql, q.params)).map(rowToOfficeRating);
  }

  // ---- office product metrics (migration 65; SQL in metric-sql.ts) ----

  async createOfficeMetric(m: NewOfficeMetric): Promise<OfficeMetric> {
    const id = randomUUID();
    await this.q(OFFICE_METRIC_INSERT_SQL, officeMetricInsertParams(id, m, now()));
    return (await this.getOfficeMetric(id))!;
  }

  async getOfficeMetric(id: string): Promise<OfficeMetric | null> {
    const r = (await this.q(OFFICE_METRIC_GET_SQL, [id]))[0];
    return r ? rowToOfficeMetric(r) : null;
  }

  async listOfficeMetrics(f?: OfficeMetricFilter): Promise<OfficeMetric[]> {
    const q = officeMetricListSql(f);
    return (await this.q(q.sql, q.params)).map(rowToOfficeMetric);
  }

  async updateOfficeMetric(id: string, patch: OfficeMetricPatch): Promise<OfficeMetric | null> {
    return this.tx(async (c) => {
      const r = (await c.query(toPg(`${OFFICE_METRIC_GET_SQL} FOR UPDATE`), [id])).rows[0];
      if (!r) return null;
      const q = officeMetricPatchSql(id, patch, rowToOfficeMetric(r), now());
      if (q) await c.query(toPg(q.sql), q.params);
      return rowToOfficeMetric((await c.query(toPg(OFFICE_METRIC_GET_SQL), [id])).rows[0]);
    });
  }

  async deleteOfficeMetric(id: string): Promise<boolean> {
    return this.tx(async (c) => {
      await c.query(toPg(OFFICE_METRIC_POINTS_DELETE_SQL), [id]);
      const r = await c.query(toPg(`${OFFICE_METRIC_DELETE_SQL} RETURNING id`), [id]);
      return (r.rowCount ?? 0) > 0;
    });
  }

  async recordOfficeMetricRun(id: string, run: OfficeMetricRun): Promise<OfficeMetricRunResult | null> {
    return this.tx(async (c) => {
      // the row lock serialises two runs of one metric; the breach UPDATE is conditional either way
      const r = (await c.query(toPg(`${OFFICE_METRIC_GET_SQL} FOR UPDATE`), [id])).rows[0];
      if (!r) return null;
      const prev = rowToOfficeMetric(r);
      let crossed = false;
      if (run.value === null) await c.query(toPg(OFFICE_METRIC_ERROR_SQL), [run.at, run.error, id]);
      else {
        await c.query(toPg(OFFICE_METRIC_POINT_INSERT_SQL), [id, run.at, run.value, run.runId]);
        await c.query(toPg(OFFICE_METRIC_POINTS_PRUNE_SQL), officeMetricPruneParams(id));
        await c.query(toPg(OFFICE_METRIC_VALUE_SQL), [run.value, run.at, run.at, id]);
        const side = metricSide(run.value, prev);
        if (side === 'breach') crossed = ((await c.query(toPg(OFFICE_METRIC_BREACH_SQL), [run.at, id])).rowCount ?? 0) > 0;
        else if (side === 'ok') await c.query(toPg(OFFICE_METRIC_OK_SQL), [id]);
        else await c.query(toPg(OFFICE_METRIC_NO_SIDE_SQL), [id]);
      }
      const metric = rowToOfficeMetric((await c.query(toPg(OFFICE_METRIC_GET_SQL), [id])).rows[0]);
      return { metric, crossed, previousSide: prev.lastSide, previousValue: prev.lastValue };
    });
  }

  async listOfficeMetricPoints(metricId: string, limit: number): Promise<OfficeMetricPoint[]> {
    const q = officeMetricPointsSql(metricId, limit);
    return (await this.q(q.sql, q.params)).map(rowToOfficeMetricPoint).reverse();
  }

  // ---- office messages, huddles, signals (migration 60; SQL in office-sql.ts) ----

  async appendOfficeMessage(m: NewOfficeMessage): Promise<OfficeMessage> {
    const id = randomUUID();
    await this.q(OFFICE_MESSAGE_INSERT_SQL, officeMessageInsertParams(id, m, now()));
    const message = (await this.getOfficeMessage(id))!;
    queueMicrotask(() => broadcast({ type: 'office-message.created', message }));
    return message;
  }

  async getOfficeMessage(id: string): Promise<OfficeMessage | null> {
    const r = (await this.q(OFFICE_MESSAGE_GET_SQL, [id]))[0];
    return r ? rowToOfficeMessage(r) : null;
  }

  async listOfficeMessages(f?: OfficeMessageFilter): Promise<OfficeMessage[]> {
    const q = officeMessageListSql(f);
    return (await this.q(q.sql, q.params)).map(rowToOfficeMessage);
  }

  async routeMessage(id: string, taskId: string | null = null): Promise<OfficeMessage | null> {
    const q = officeMessageRouteSql(id, taskId, now());
    const r = (await this.q(q.sql, q.params))[0];
    return r ? rowToOfficeMessage(r) : null;
  }

  async clearMessageTaint(id: string, expectedTaintedAt: string): Promise<OfficeMessage | null> {
    const r = (await this.q(OFFICE_MESSAGE_CLEAR_TAINT_SQL, [now(), id, expectedTaintedAt]))[0];
    return r ? rowToOfficeMessage(r) : null;
  }

  async createHuddle(h: NewOfficeHuddle): Promise<OfficeHuddle> {
    const id = randomUUID();
    await this.q(OFFICE_HUDDLE_INSERT_SQL, officeHuddleInsertParams(id, h, now()));
    return (await this.getHuddle(id))!;
  }

  async getHuddle(id: string): Promise<OfficeHuddle | null> {
    const r = (await this.q(OFFICE_HUDDLE_GET_SQL, [id]))[0];
    return r ? rowToOfficeHuddle(r) : null;
  }

  async listHuddles(f?: OfficeHuddleFilter): Promise<OfficeHuddle[]> {
    const q = officeHuddleListSql(f);
    return (await this.q(q.sql, q.params)).map(rowToOfficeHuddle);
  }

  async stepHuddle(id: string): Promise<OfficeHuddle | null> {
    const q = officeHuddleStepSql(id, now());
    const r = (await this.q(q.sql, q.params))[0];
    return r ? rowToOfficeHuddle(r) : null;
  }

  async taintHuddle(id: string): Promise<OfficeHuddle | null> {
    const q = officeHuddleTaintSql(id, now());
    const r = (await this.q(q.sql, q.params))[0];
    return r ? rowToOfficeHuddle(r) : null;
  }

  async closeHuddle(id: string, to: 'decided' | 'expired', decision: string | null = null): Promise<OfficeHuddle | null> {
    const q = officeHuddleCloseSql(id, to, decision, now());
    const r = (await this.q(q.sql, q.params))[0];
    return r ? rowToOfficeHuddle(r) : null;
  }

  async appendSignal(s: NewOfficeSignal): Promise<{ signal: OfficeSignal; created: boolean }> {
    const r = (await this.q(OFFICE_SIGNAL_INSERT_SQL, officeSignalInsertParams(randomUUID(), s, now())))[0];
    if (r) return { signal: rowToOfficeSignal(r), created: true };
    const existing = (await this.q(OFFICE_SIGNAL_BY_EXTERNAL_SQL, [s.source, s.externalId]))[0];
    return { signal: rowToOfficeSignal(existing), created: false };
  }

  async getSignal(id: string): Promise<OfficeSignal | null> {
    const r = (await this.q(OFFICE_SIGNAL_GET_SQL, [id]))[0];
    return r ? rowToOfficeSignal(r) : null;
  }

  async listSignals(f?: OfficeSignalFilter): Promise<OfficeSignal[]> {
    const q = officeSignalListSql(f);
    return (await this.q(q.sql, q.params)).map(rowToOfficeSignal);
  }

  async consumeSignal(id: string, shiftId: string): Promise<OfficeSignal | null> {
    const q = officeSignalConsumeSql(id, shiftId);
    const r = (await this.q(q.sql, q.params))[0];
    return r ? rowToOfficeSignal(r) : null;
  }

  // ---- Workspaces (docs/workspaces.md) ----

  async listWorkspaces(): Promise<Workspace[]> {
    return (await this.q(WORKSPACE_LIST_SQL)).map(rowToWorkspace);
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    const r = await this.q(`SELECT * FROM tm_workspaces WHERE id = ?`, [id]);
    return r[0] ? rowToWorkspace(r[0]) : null;
  }

  async createWorkspace(w: NewWorkspace): Promise<Workspace> {
    const id = randomUUID();
    const at = now();
    await this.q(WORKSPACE_APPEND_SQL, [id, w.name, w.slug, JSON.stringify(w.repoIds), w.color, at, at]);
    return (await this.getWorkspace(id))!;
  }

  async updateWorkspace(id: string, patch: WorkspacePatch): Promise<Workspace | null> {
    const cols = workspacePatchColumns(patch);
    if (cols.length === 0) return this.getWorkspace(id);
    const r = await this.q(
      `UPDATE tm_workspaces SET ${cols.map(([c]) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? RETURNING *`,
      [...cols.map(([, v]) => v), now(), id],
    );
    return r[0] ? rowToWorkspace(r[0]) : null;
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    const r = await this.q(`DELETE FROM tm_workspaces WHERE id = ? RETURNING id`, [id]);
    return r.length > 0;
  }

  async reorderWorkspaces(ids: string[]): Promise<Workspace[]> {
    await this.tx(async (c) => {
      const cur = (await c.query(toPg(WORKSPACE_LIST_SQL))).rows as { id: string }[];
      const at = now();
      const order = workspaceOrder(cur, ids);
      for (let i = 0; i < order.length; i++) await c.query(toPg(WORKSPACE_SORT_SQL), [i, at, order[i]]);
    });
    return this.listWorkspaces();
  }

  async listSharedNotes(f: SharedNoteFilter): Promise<SharedNote[]> {
    const { sql, params } = sharedNoteListQuery(f);
    return (await this.q(sql, params)).map(rowToSharedNote);
  }

  async getSharedNote(id: string): Promise<SharedNote | null> {
    const r = await this.q(`SELECT * FROM tm_shared_notes WHERE id = ?`, [id]);
    return r[0] ? rowToSharedNote(r[0]) : null;
  }

  async createSharedNote(n: NewSharedNote): Promise<SharedNote> {
    const id = randomUUID();
    const at = now();
    await this.q(SHARED_NOTE_INSERT_SQL, [
      id, n.spaceId, n.kind, n.title, n.body, n.fromRepoId, n.fromTaskId, n.toRepoId,
      'open', null, null, JSON.stringify(n.files), n.actor, at, at,
    ]);
    return (await this.getSharedNote(id))!;
  }

  async updateSharedNote(
    id: string,
    patch: SharedNotePatch,
    fromStatus?: readonly SharedNoteStatus[],
  ): Promise<SharedNote | null> {
    const u = sharedNoteUpdate(id, patch, now(), fromStatus);
    if (!u) return this.getSharedNote(id);
    const r = await this.q(u.sql, u.params);
    return r[0] ? rowToSharedNote(r[0]) : null;
  }

  async deleteSharedNote(id: string): Promise<boolean> {
    const r = await this.q(`DELETE FROM tm_shared_notes WHERE id = ? RETURNING id`, [id]);
    return r.length > 0;
  }


  async getSettings(): Promise<AppSettings> {
    const rows = (await this.q(`SELECT key, value FROM tm_config`)) as { key: string; value: string }[];
    // machine-dependent defaults (the RAM-suggested concurrency) under any saved row
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS, ...machineDefaults() };
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {
        // keep default
      }
    }
    return out as unknown as AppSettings;
  }

  async setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void> {
    await this.q(
      `INSERT INTO tm_config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
  }

  async deleteSetting(key: string): Promise<void> {
    await this.q(`DELETE FROM tm_config WHERE key = ?`, [key]);
  }

  /** BEGIN/COMMIT on one client; a null-returning fn still commits (no-op
   *  writes are fine). Event broadcasts buffered in `sink` fire post-COMMIT. */
  private async tx<T>(fn: (c: pg.PoolClient, sink: AuditEvent[]) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const sink: AuditEvent[] = [];
    try {
      await client.query('BEGIN');
      const out = await fn(client, sink);
      await client.query('COMMIT');
      for (const ev of sink) queueMicrotask(() => broadcast({ type: 'event.appended', event: ev }));
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
}
