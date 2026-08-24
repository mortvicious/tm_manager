import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type AuditEvent,
  type Proposal,
  type Repo,
  type Run,
  type Task,
} from '@tm/shared';
import { broadcast } from '../events.ts';
import { MIGRATIONS } from './migrations.ts';
import { eventId, now, rowToEvent, rowToProposal, rowToRepo, rowToRun, rowToTask } from './rows.ts';
import type {
  ChildCounts,
  EventFilter,
  NewAuditEvent,
  NewProposal,
  NewRun,
  NewTask,
  Storage,
  TaskFilter,
} from './types.ts';

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
      });
      run();
    }
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
    const sql = `SELECT * FROM tm_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...params, Math.min(f?.limit ?? 100, 2000)) as any[]).map(rowToEvent);
  }

  // ---- repos ----

  async listRepos(): Promise<Repo[]> {
    return (this.db.prepare(`SELECT * FROM tm_repos ORDER BY created_at`).all() as any[]).map(rowToRepo);
  }

  async getRepo(id: string): Promise<Repo | null> {
    const r = this.db.prepare(`SELECT * FROM tm_repos WHERE id = ?`).get(id);
    return r ? rowToRepo(r) : null;
  }

  async createRepo(r: { name: string; path: string; role?: string | null }): Promise<Repo> {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO tm_repos (id, name, path, role, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, r.name, r.path, r.role ?? null, now());
    return (await this.getRepo(id))!;
  }

  async updateRepo(id: string, patch: Partial<Pick<Repo, 'name' | 'path' | 'role'>>): Promise<Repo | null> {
    const cur = await this.getRepo(id);
    if (!cur) return null;
    this.db
      .prepare(`UPDATE tm_repos SET name = ?, path = ?, role = ? WHERE id = ?`)
      .run(patch.name ?? cur.name, patch.path ?? cur.path, patch.role === undefined ? cur.role : patch.role, id);
    return this.getRepo(id);
  }

  async deleteRepo(id: string): Promise<void> {
    const del = this.db.transaction((repoId: string) => {
      this.db.prepare(`UPDATE tm_tasks SET repo_id = NULL WHERE repo_id = ?`).run(repoId);
      this.db.prepare(`DELETE FROM tm_repos WHERE id = ?`).run(repoId);
    });
    del(id);
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
    const sql = `SELECT * FROM tm_tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY priority DESC, created_at`;
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToTask);
  }

  async getTask(id: string): Promise<Task | null> {
    const r = this.db.prepare(`SELECT * FROM tm_tasks WHERE id = ?`).get(id);
    return r ? rowToTask(r) : null;
  }

  private insertTaskSync(t: NewTask, actor: string): Task {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO tm_tasks (id, title, description, repo_id, parent_id, status, source, source_ref, priority, model, effort, category, review, created_by_run, spawn_depth, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
        ts,
        ts,
      );
    const task = rowToTask(this.db.prepare(`SELECT * FROM tm_tasks WHERE id = ?`).get(id));
    this.appendEventSync({
      kind: 'task.created',
      actor,
      taskId: task.id,
      repoId: task.repoId,
      data: { title: task.title, status: task.status, source: task.source, spawnDepth: task.spawnDepth },
    });
    return task;
  }

  async createTask(t: NewTask, actor: string): Promise<Task> {
    return this.inTxn(() => this.insertTaskSync(t, actor));
  }

  private updateTaskSync(id: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): Task | null {
    const cur = this.db.prepare(`SELECT * FROM tm_tasks WHERE id = ?`).get(id) as any;
    if (!cur) return null;
    const t = rowToTask(cur);
    // Spread keeps undefined values, which would clobber NOT NULL columns — strip them.
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = { ...t, ...clean, updatedAt: now() };
    this.db
      .prepare(
        `UPDATE tm_tasks SET title=?, description=?, repo_id=?, parent_id=?, status=?, source=?, source_ref=?, priority=?, model=?, effort=?, category=?, review=?, result_summary=?, review_summary=?, error=?, updated_at=? WHERE id=?`,
      )
      .run(
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
        next.resultSummary,
        next.reviewSummary,
        next.error,
        next.updatedAt,
        id,
      );
    return rowToTask(this.db.prepare(`SELECT * FROM tm_tasks WHERE id = ?`).get(id));
  }

  async updateTask(id: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): Promise<Task | null> {
    return this.updateTaskSync(id, patch);
  }

  async deleteTask(id: string): Promise<void> {
    const del = this.db.transaction((taskId: string) => {
      this.db.prepare(`UPDATE tm_tasks SET parent_id = NULL WHERE parent_id = ?`).run(taskId);
      this.db.prepare(`DELETE FROM tm_proposals WHERE task_id = ?`).run(taskId);
      this.db.prepare(`UPDATE tm_runs SET task_id = NULL WHERE task_id = ?`).run(taskId);
      this.db.prepare(`DELETE FROM tm_tasks WHERE id = ?`).run(taskId);
    });
    del(id);
  }

  async claimNextQueuedTask(actor: string): Promise<Task | null> {
    // .get() (not .run()) — RETURNING rows are discarded by .run().
    // Atomic only because the orchestrator is single-process; a Postgres
    // multi-writer setup would need FOR UPDATE SKIP LOCKED (Phase 7 note).
    return this.inTxn((): Task | null => {
      const r = this.db
        .prepare(
          `UPDATE tm_tasks SET status = 'running', updated_at = ?
           WHERE id = (SELECT id FROM tm_tasks WHERE status = 'queued' AND repo_id IS NOT NULL
                       ORDER BY priority DESC, created_at LIMIT 1)
           RETURNING *`,
        )
        .get(now());
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

  async transitionTask(
    id: string,
    from: Task['status'][],
    to: Task['status'],
    actor: string,
    patch?: Partial<Pick<Task, 'error' | 'resultSummary'>>,
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
        data: { from: prev?.status ?? null, to },
      });
      return task;
    });
  }

  async resolveChildCompletion(childId: string, parentDoneStatus: 'review' | 'done', actor: string): Promise<Task | null> {
    return this.inTxn((): Task | null => {
      const child = this.db.prepare(`SELECT parent_id FROM tm_tasks WHERE id = ?`).get(childId) as
        | { parent_id: string | null }
        | undefined;
      if (!child?.parent_id) return null;
      const rows = this.db.prepare(`SELECT status FROM tm_tasks WHERE parent_id = ?`).all(child.parent_id) as {
        status: string;
      }[];
      const unresolved = rows.filter((r) => !['done', 'cancelled', 'failed'].includes(r.status)).length;
      if (unresolved > 0) return null;
      const failed = rows.filter((r) => r.status === 'failed').length;
      if (failed > 0) {
        // Conditional on blocked: a done/review parent with agent-filed
        // children must not get a failure scribbled on it (review R3).
        const r = this.db
          .prepare(`UPDATE tm_tasks SET error = ?, updated_at = ? WHERE id = ? AND status = 'blocked' RETURNING *`)
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
        .prepare(`UPDATE tm_tasks SET status = ?, updated_at = ? WHERE id = ? AND status = 'blocked' RETURNING *`)
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
      .prepare(`SELECT COUNT(*) AS n FROM tm_tasks WHERE status = 'queued' AND created_by_run IS NOT NULL`)
      .get() as { n: number };
    return Number(r.n);
  }

  async claimNextAgentChildTask(eligibleRunIds: string[], actor: string): Promise<Task | null> {
    if (eligibleRunIds.length === 0) return null;
    const placeholders = eligibleRunIds.map(() => '?').join(', ');
    return this.inTxn((): Task | null => {
      const r = this.db
        .prepare(
          `UPDATE tm_tasks SET status = 'running', updated_at = ?
           WHERE id = (SELECT id FROM tm_tasks
                       WHERE status = 'queued' AND repo_id IS NOT NULL AND created_by_run IN (${placeholders})
                       ORDER BY created_at LIMIT 1)
           RETURNING *`,
        )
        .get(now(), ...eligibleRunIds);
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
        `INSERT INTO tm_runs (id, task_id, repo_id, mode, status, pid, model, effort, run_token, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        r.taskId ?? null,
        r.repoId ?? null,
        r.mode,
        r.pid ?? null,
        r.model ?? null,
        r.effort ?? null,
        r.runToken ?? null,
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
    this.db
      .prepare(
        `UPDATE tm_runs SET status=?, pid=?, exit_code=?, needs_attention=?, idle=?, session_id=?, transcript_path=?, stats=?, ended_at=? WHERE id=?`,
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
        next.endedAt,
        id,
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

  // ---- settings ----

  async getSettings(): Promise<AppSettings> {
    const rows = this.db.prepare(`SELECT key, value FROM tm_config`).all() as { key: string; value: string }[];
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
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
}
