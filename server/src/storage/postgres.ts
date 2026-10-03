import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  TERMINAL_TASK_STATUSES,
  type AppSettings,
  type AuditEvent,
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
  type Task,
} from '@tm/shared';
import { planCards } from '../claude/feature-plan.ts';
import { broadcast } from '../events.ts';
import { FEATURE_CLAIM_GATE, FEATURE_OVERFLOW_GATE, isFeatureTaskBlocking } from './feature-sql.ts';
import { CUSTOM_QUEUE_HEAD_ORDER, CUSTOM_QUEUE_HEAD_WHERE, CUSTOM_QUEUE_IDLE } from './queue-sql.ts';
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
import { MIGRATIONS } from './migrations.ts';
import { PUSH_RESULT_FAIL_SQL, PUSH_RESULT_OK_SQL, PUSH_UPSERT_SQL, rowToPushDevice } from './push-sql.ts';
import type { NewPushDevice, PushDeviceRecord } from './types.ts';
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
  rowToEvent,
  rowToFeature,
  rowToProposal,
  rowToRepo,
  rowToRun,
  rowToTask,
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
  SharedNoteFilter,
  SharedNotePatch,
  SpacePatch,
  ReportPatch,
  QuestionFilter,
  NewFeature,
  NewProposal,
  NewRepo,
  NewRun,
  NewTask,
  RepoPatch,
  Storage,
  TaskFilter,
} from './types.ts';

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
    const where: string[] = [];
    const params: unknown[] = [];
    if (f?.kind) {
      where.push(`kind = ?`);
      params.push(f.kind);
    }
    if (f?.actor) {
      where.push(`actor = ?`);
      params.push(f.actor);
    }
    if (f?.taskId) {
      where.push(`task_id = ?`);
      params.push(f.taskId);
    }
    if (f?.since) {
      where.push(`at >= ?`);
      params.push(f.since);
    }
    params.push(Math.min(f?.limit ?? 100, 2000));
    const sql = `SELECT * FROM tm_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    return (await this.q(sql, params)).map(rowToEvent);
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
    await this.q(`INSERT INTO tm_repos (id, name, path, role, preview_url, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
      id,
      r.name,
      r.path,
      r.role ?? null,
      r.previewUrl ?? null,
      now(),
    ]);
    return (await this.getRepo(id))!;
  }

  async updateRepo(id: string, patch: RepoPatch): Promise<Repo | null> {
    const cur = await this.getRepo(id);
    if (!cur) return null;
    await this.q(`UPDATE tm_repos SET name = ?, path = ?, role = ?, preview_url = ? WHERE id = ?`, [
      patch.name ?? cur.name,
      patch.path ?? cur.path,
      patch.role === undefined ? cur.role : patch.role,
      patch.previewUrl === undefined ? cur.previewUrl : patch.previewUrl,
      id,
    ]);
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
      `INSERT INTO tm_commands (id, repo_id, name, command, kind, cwd, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, c.repoId, c.name, c.command, c.kind ?? 'task', c.cwd ?? null, sortOrder, at, at],
    );
    return (await this.getCommand(id))!;
  }

  async updateCommand(id: string, patch: CommandPatch): Promise<RepoCommand | null> {
    const cur = await this.getCommand(id);
    if (!cur) return null;
    await this.q(
      `UPDATE tm_commands SET name = ?, command = ?, kind = ?, cwd = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
      [
        patch.name ?? cur.name,
        patch.command ?? cur.command,
        patch.kind ?? cur.kind,
        patch.cwd === undefined ? cur.cwd : patch.cwd,
        patch.sortOrder ?? cur.sortOrder,
        now(),
        id,
      ],
    );
    return this.getCommand(id);
  }

  async deleteCommand(id: string): Promise<void> {
    await this.q(`DELETE FROM tm_commands WHERE id = ?`, [id]);
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
      `INSERT INTO tm_tasks (id, title, description, repo_id, parent_id, group_id, group_path, status, source, source_ref, priority, model, effort, category, review, auto_publish, created_by_run, spawn_depth, feature_id, feature_phase, created_at, updated_at, review_model, review_effort, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, (${NEXT_SORT_ORDER_SQL}))`,
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
        t.autoPublish ? 1 : 0,
        t.createdByRun ?? null,
        t.spawnDepth ?? 0,
        t.featureId ?? null,
        t.featurePhase ?? null,
        ts,
        ts,
        t.reviewModel ?? null,
        t.reviewEffort ?? null,
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
      `UPDATE tm_tasks SET title=$1, description=$2, repo_id=$3, parent_id=$4, group_id=$5, group_path=$6, group_name=$7, group_color=$8, status=$9, source=$10, source_ref=$11, priority=$12, model=$13, effort=$14, category=$15, review=$16, auto_publish=$17, custom_queue_at=$18, feature_id=$19, feature_phase=$20, result_summary=$21, review_summary=$22, review_diff_hash=$23, review_state=$24, review_rounds=$25, wake_at=$26, error=$27, updated_at=$28, review_model=$29, review_effort=$30, base_sha=$31, base_ref=$32, base_at=$33, queue_held_at=$34 WHERE id=$35`,
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
        next.autoPublish ? 1 : 0,
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
        id,
      ],
    );
    const r = await c.query(`SELECT * FROM tm_tasks WHERE id = $1`, [id]);
    return rowToTask(r.rows[0]);
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

  async claimNextQueuedTask(actor: string): Promise<Task | null> {
    // Single-process orchestrator; multi-writer would need FOR UPDATE SKIP LOCKED.
    return this.tx(async (c, sink) => {
      const r = await c.query(
        `UPDATE tm_tasks SET status = 'running', updated_at = $1
         WHERE id = (SELECT t.id FROM tm_tasks t WHERE t.status = 'queued' AND t.repo_id IS NOT NULL
                       AND t.custom_queue_at IS NULL
                       AND t.queue_held_at IS NULL
                       AND ${FEATURE_CLAIM_GATE}
                     ORDER BY ${MANUAL_CLAIM_ORDER} LIMIT 1)
         RETURNING *`,
        [now()],
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

  async peekCustomQueue(): Promise<Task | null> {
    const rows = await this.q(
      `SELECT t.* FROM tm_tasks t WHERE ${CUSTOM_QUEUE_HEAD_WHERE} AND ${FEATURE_CLAIM_GATE} ${CUSTOM_QUEUE_HEAD_ORDER}`,
    );
    return rows[0] ? rowToTask(rows[0]) : null;
  }

  async claimNextCustomQueuedTask(actor: string): Promise<Task | null> {
    // Twin of the sqlite driver: head selection + busy check in one statement.
    return this.tx(async (c, sink) => {
      const r = await c.query(
        `UPDATE tm_tasks SET status = 'running', updated_at = $1
         WHERE id = (SELECT t.id FROM tm_tasks t WHERE ${CUSTOM_QUEUE_HEAD_WHERE}
                       AND ${FEATURE_CLAIM_GATE}
                     ${CUSTOM_QUEUE_HEAD_ORDER})
           AND ${CUSTOM_QUEUE_IDLE}
         RETURNING *`,
        [now()],
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
    patch?: Partial<Pick<Task, 'error' | 'resultSummary' | 'reviewState' | 'queueHeldAt'>>,
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
    // An Undo-start hold (docs/queue.md § Undo start) means "queued, but not
    // yet" and exists only for the transition that sets it: every other status
    // change releases it, so a hold can never outlive the `queued` it was for.
    if (patch && 'queueHeldAt' in patch) {
      sets.push('queue_held_at = ?');
      vals.push(patch.queueHeldAt ?? null);
    } else {
      sets.push('queue_held_at = NULL');
    }
    // Terminal status ends custom-queue membership (twin of the sqlite driver).
    if (TERMINAL_TASK_STATUSES.includes(to)) sets.push('custom_queue_at = NULL');
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
        data: { from: prevRes.rows[0]?.status ?? null, to },
      }, sink);
      return task;
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
          `UPDATE tm_tasks SET error = $1, updated_at = $2 WHERE id = $3 AND status = 'blocked' RETURNING *`,
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
        `UPDATE tm_tasks SET status = $1, updated_at = $2 WHERE id = $3 AND status = 'blocked' RETURNING *`,
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
    const where: string[] = [];
    const params: unknown[] = [];
    if (f?.taskId) {
      where.push(`task_id = ?`);
      params.push(f.taskId);
    }
    if (f?.repoId) {
      where.push(`repo_id = ?`);
      params.push(f.repoId);
    }
    if (f?.status) {
      where.push(`status = ?`);
      params.push(f.status);
    }
    if (f?.mode) {
      where.push(`mode = ?`);
      params.push(f.mode);
    }
    if (f?.kind) {
      where.push(`kind = ?`);
      params.push(f.kind);
    }
    if (f?.subjectId) {
      where.push(`subject_id = ?`);
      params.push(f.subjectId);
    }
    if (f?.since) {
      where.push(`started_at >= ?`);
      params.push(f.since);
    }
    const sql = `SELECT * FROM tm_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC, id DESC`;
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
    const r = await this.q(`SELECT COUNT(*) AS n FROM tm_tasks WHERE status = 'queued' AND created_by_run IS NOT NULL`);
    return Number(r[0].n);
  }

  async claimNextAgentChildTask(eligibleRunIds: string[], actor: string): Promise<Task | null> {
    if (eligibleRunIds.length === 0) return null;
    const placeholders = eligibleRunIds.map((_, i) => `$${i + 2}`).join(', ');
    return this.tx(async (c, sink) => {
      const r = await c.query(
        `UPDATE tm_tasks SET status = 'running', updated_at = $1
         WHERE id = (SELECT t.id FROM tm_tasks t
                     WHERE t.status = 'queued' AND t.repo_id IS NOT NULL AND t.created_by_run IN (${placeholders})
                       AND t.custom_queue_at IS NULL
                       AND t.queue_held_at IS NULL
                       AND ${FEATURE_OVERFLOW_GATE}
                     ORDER BY t.created_at LIMIT 1)
         RETURNING *`,
        [now(), ...eligibleRunIds],
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
      `UPDATE tm_runs SET status=?, pid=?, exit_code=?, needs_attention=?, idle=?, session_id=?, transcript_path=?, stats=?, ended_at=? WHERE id=?`,
      [
        next.status,
        next.pid,
        next.exitCode,
        next.needsAttention ? 1 : 0,
        next.idle ? 1 : 0,
        next.sessionId,
        next.transcriptPath,
        next.stats ? JSON.stringify(next.stats) : null,
        next.endedAt,
        id,
      ],
    );
    return this.getRun(id);
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

  async listChats(repoId?: string): Promise<Chat[]> {
    const where = repoId ? `WHERE repo_id = ?` : '';
    const params = repoId ? [repoId] : [];
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
      `INSERT INTO tm_chats (id, repo_id, title, model, effort, mode, status, turns, cost_usd, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'idle', 0, 0, ?, ?)`,
      [id, c.repoId, c.title, c.model, c.effort ?? null, c.mode, ts, ts],
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
        toPg(`INSERT INTO tm_chat_messages (id, chat_id, role, text, actor, error, cost_usd, duration_ms, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
        [id, m.chatId, m.role, m.text, m.actor, m.error ?? null, m.costUsd ?? 0, m.durationMs ?? null, at],
      );
      await c.query(toPg(`UPDATE tm_chats SET last_message_at = ?, updated_at = ? WHERE id = ?`), [at, at, m.chatId]);
      const r = await c.query(toPg(`SELECT * FROM tm_chat_messages WHERE id = ?`), [id]);
      return rowToChatMessage(r.rows[0]);
    });
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
        `INSERT INTO tm_features (id, repo_id, title, request, status, analysis, review, analysis_rounds, error, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'draft', NULL, NULL, 0, NULL, $5, $6)`,
        [id, f.repoId, f.title, f.request, ts, ts],
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
      const tasks: Task[] = [];
      for (const card of cards) {
        tasks.push(
          await this.insertTaskWith(
            c,
            {
              title: card.card.title,
              description: card.description,
              repoId: feature.repoId,
              status: 'draft',
              source: 'feature',
              category: card.card.category ?? null,
              effort: card.card.effort ?? null,
              review: card.card.review ?? null,
              featureId: feature.id,
              featurePhase: card.phase,
            },
            actor,
            sink,
          ),
        );
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

      const failed = tasks.filter((t) => t.status === 'failed');
      if (failed.length > 0) {
        const paused = await this.transitionFeatureWith(c, sink, featureId, ['running'], 'paused', actor, {
          error: `${failed.length} task(s) failed — retry or cancel them, then Resume`,
        });
        return paused ? { feature: paused, tasks: [], action: 'paused' as const } : null;
      }

      const pending = tasks.filter(isFeatureTaskBlocking);
      if (pending.length === 0) {
        const done = await this.transitionFeatureWith(c, sink, featureId, ['running'], 'review', actor, { error: null });
        return done ? { feature: done, tasks: [], action: 'review' as const } : null;
      }

      const phase = Math.min(...pending.map((t) => t.featurePhase ?? 0));
      const started: Task[] = [];
      for (const t of pending) {
        if ((t.featurePhase ?? 0) !== phase || t.status !== 'draft' || t.source !== 'feature') continue;
        if (!t.repoId) continue; // never queue a repo-less task
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
      if (started.length === 0) return { feature, tasks: [], action: 'none' as const, phase };
      return { feature, tasks: started, action: 'phase-started' as const, phase };
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
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
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
