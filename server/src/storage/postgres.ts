import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type AuditEvent,
  type Feature,
  type FeatureStatus,
  type Proposal,
  type Repo,
  type Run,
  type Task,
} from '@tm/shared';
import { planCards } from '../claude/feature-plan.ts';
import { broadcast } from '../events.ts';
import { FEATURE_CLAIM_GATE, FEATURE_OVERFLOW_GATE, isFeatureTaskBlocking } from './feature-sql.ts';
import { MIGRATIONS } from './migrations.ts';
import { eventId, now, rowToEvent, rowToFeature, rowToProposal, rowToRepo, rowToRun, rowToTask } from './rows.ts';
import type {
  ChildCounts,
  EventFilter,
  FeaturePatch,
  FeatureResolution,
  NewAuditEvent,
  NewFeature,
  NewProposal,
  NewRun,
  NewTask,
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

  async createRepo(r: { name: string; path: string; role?: string | null }): Promise<Repo> {
    const id = randomUUID();
    await this.q(`INSERT INTO tm_repos (id, name, path, role, created_at) VALUES (?, ?, ?, ?, ?)`, [
      id,
      r.name,
      r.path,
      r.role ?? null,
      now(),
    ]);
    return (await this.getRepo(id))!;
  }

  async updateRepo(id: string, patch: Partial<Pick<Repo, 'name' | 'path' | 'role'>>): Promise<Repo | null> {
    const cur = await this.getRepo(id);
    if (!cur) return null;
    await this.q(`UPDATE tm_repos SET name = ?, path = ?, role = ? WHERE id = ?`, [
      patch.name ?? cur.name,
      patch.path ?? cur.path,
      patch.role === undefined ? cur.role : patch.role,
      id,
    ]);
    return this.getRepo(id);
  }

  async deleteRepo(id: string): Promise<void> {
    await this.tx(async (c) => {
      await c.query(`UPDATE tm_tasks SET repo_id = NULL WHERE repo_id = $1`, [id]);
      // Features follow tasks: detached, not deleted (see sqlite driver).
      await c.query(`UPDATE tm_features SET repo_id = NULL, updated_at = $1 WHERE repo_id = $2`, [now(), id]);
      await c.query(`DELETE FROM tm_repos WHERE id = $1`, [id]);
    });
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
    if (f?.featureId) {
      where.push(`feature_id = ?`);
      params.push(f.featureId);
    }
    const sql = `SELECT * FROM tm_tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY priority DESC, created_at`;
    return (await this.q(sql, params)).map(rowToTask);
  }

  async getTask(id: string): Promise<Task | null> {
    const r = await this.q(`SELECT * FROM tm_tasks WHERE id = ?`, [id]);
    return r[0] ? rowToTask(r[0]) : null;
  }

  private async insertTaskWith(
    c: pg.PoolClient | pg.Pool,
    t: NewTask,
    actor: string,
    sink?: AuditEvent[],
  ): Promise<Task> {
    const id = randomUUID();
    const ts = now();
    await c.query(
      `INSERT INTO tm_tasks (id, title, description, repo_id, parent_id, status, source, source_ref, priority, model, effort, category, review, created_by_run, spawn_depth, feature_id, feature_phase, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        id,
        t.title,
        t.description ?? null,
        t.repoId ?? null,
        t.parentId ?? null,
        t.status ?? 'draft',
        t.source ?? 'manual',
        t.sourceRef ?? null,
        t.priority ?? 0,
        t.model ?? null,
        t.effort ?? null,
        t.category ?? null,
        t.review == null ? null : t.review ? 1 : 0,
        t.createdByRun ?? null,
        t.spawnDepth ?? 0,
        t.featureId ?? null,
        t.featurePhase ?? null,
        ts,
        ts,
      ],
    );
    const r = await c.query(`SELECT * FROM tm_tasks WHERE id = $1`, [id]);
    const task = rowToTask(r.rows[0]);
    await this.appendEventWith(c, {
      kind: 'task.created',
      actor,
      taskId: task.id,
      repoId: task.repoId,
      data: { title: task.title, status: task.status, source: task.source, spawnDepth: task.spawnDepth },
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
    await c.query(
      `UPDATE tm_tasks SET title=$1, description=$2, repo_id=$3, parent_id=$4, status=$5, source=$6, source_ref=$7, priority=$8, model=$9, effort=$10, category=$11, review=$12, feature_id=$13, feature_phase=$14, result_summary=$15, review_summary=$16, error=$17, updated_at=$18 WHERE id=$19`,
      [
        next.title,
        next.description,
        next.repoId,
        next.parentId,
        next.status,
        next.source,
        next.sourceRef,
        next.priority,
        next.model,
        next.effort,
        next.category,
        next.review == null ? null : next.review ? 1 : 0,
        next.featureId,
        next.featurePhase,
        next.resultSummary,
        next.reviewSummary,
        next.error,
        next.updatedAt,
        id,
      ],
    );
    const r = await c.query(`SELECT * FROM tm_tasks WHERE id = $1`, [id]);
    return rowToTask(r.rows[0]);
  }

  async updateTask(id: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): Promise<Task | null> {
    return this.updateTaskWith(this.pool, id, patch);
  }

  async deleteTask(id: string): Promise<void> {
    await this.tx(async (c) => {
      await c.query(`UPDATE tm_tasks SET parent_id = NULL WHERE parent_id = $1`, [id]);
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
                       AND ${FEATURE_CLAIM_GATE}
                     ORDER BY t.priority DESC, t.created_at LIMIT 1)
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

  async transitionTask(
    id: string,
    from: Task['status'][],
    to: Task['status'],
    actor: string,
    patch?: Partial<Pick<Task, 'error' | 'resultSummary'>>,
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
      const unresolved = rows.filter((r) => !['done', 'cancelled', 'failed'].includes(r.status)).length;
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
    const resolved = rows.filter((r) => ['done', 'cancelled', 'failed'].includes(r.status)).length;
    return { total, done, failed, unresolved: total - resolved };
  }

  // ---- runs ----

  async listRuns(f?: { taskId?: string; status?: Run['status']; mode?: Run['mode'] }): Promise<Run[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f?.taskId) {
      where.push(`task_id = ?`);
      params.push(f.taskId);
    }
    if (f?.status) {
      where.push(`status = ?`);
      params.push(f.status);
    }
    if (f?.mode) {
      where.push(`mode = ?`);
      params.push(f.mode);
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
      `INSERT INTO tm_runs (id, task_id, repo_id, mode, status, pid, model, effort, run_token, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
      [id, r.taskId ?? null, r.repoId ?? null, r.mode, r.pid ?? null, r.model ?? null, r.effort ?? null, r.runToken ?? null, now()],
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
