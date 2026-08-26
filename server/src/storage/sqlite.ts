import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import {
  DEFAULT_SETTINGS,
  TERMINAL_TASK_STATUSES,
  type AppSettings,
  type AuditEvent,
  type Dispatch,
  type Feature,
  type FeatureStatus,
  type Proposal,
  type Repo,
  type RepoCommand,
  type Run,
  type Task,
} from '@tm/shared';
import { planCards } from '../claude/feature-plan.ts';
import { broadcast } from '../events.ts';
import { FEATURE_CLAIM_GATE, FEATURE_OVERFLOW_GATE, isFeatureTaskBlocking } from './feature-sql.ts';
import { MOVE_SUBTREE_SQL, ROOT_PATH, moveSubtreeParams, pathContains, placement } from './group.ts';
import { MIGRATIONS } from './migrations.ts';
import { eventId, now, rowToCommand, rowToDispatch, rowToEvent, rowToFeature, rowToProposal, rowToRepo, rowToRun, rowToTask } from './rows.ts';
import type {
  ChildCounts,
  CommandPatch,
  DispatchFilter,
  EventFilter,
  FeaturePatch,
  FeatureResolution,
  NewAuditEvent,
  NewCommand,
  NewDispatch,
  NewFeature,
  NewProposal,
  NewRepo,
  NewRun,
  NewTask,
  RepoPatch,
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

  async createRepo(r: NewRepo): Promise<Repo> {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO tm_repos (id, name, path, role, preview_url, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, r.name, r.path, r.role ?? null, r.previewUrl ?? null, now());
    return (await this.getRepo(id))!;
  }

  async updateRepo(id: string, patch: RepoPatch): Promise<Repo | null> {
    const cur = await this.getRepo(id);
    if (!cur) return null;
    this.db
      .prepare(`UPDATE tm_repos SET name = ?, path = ?, role = ?, preview_url = ? WHERE id = ?`)
      .run(
        patch.name ?? cur.name,
        patch.path ?? cur.path,
        patch.role === undefined ? cur.role : patch.role,
        patch.previewUrl === undefined ? cur.previewUrl : patch.previewUrl,
        id,
      );
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
        `INSERT INTO tm_commands (id, repo_id, name, command, kind, cwd, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, c.repoId, c.name, c.command, c.kind ?? 'task', c.cwd ?? null, sortOrder, at, at);
    return (await this.getCommand(id))!;
  }

  async updateCommand(id: string, patch: CommandPatch): Promise<RepoCommand | null> {
    const cur = await this.getCommand(id);
    if (!cur) return null;
    this.db
      .prepare(`UPDATE tm_commands SET name = ?, command = ?, kind = ?, cwd = ?, sort_order = ?, updated_at = ? WHERE id = ?`)
      .run(
        patch.name ?? cur.name,
        patch.command ?? cur.command,
        patch.kind ?? cur.kind,
        patch.cwd === undefined ? cur.cwd : patch.cwd,
        patch.sortOrder ?? cur.sortOrder,
        now(),
        id,
      );
    return this.getCommand(id);
  }

  async deleteCommand(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM tm_commands WHERE id = ?`).run(id);
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
    const sql = `SELECT * FROM tm_tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY priority DESC, created_at`;
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
        `INSERT INTO tm_tasks (id, title, description, repo_id, parent_id, group_id, group_path, status, source, source_ref, priority, model, effort, category, review, auto_publish, created_by_run, spawn_depth, feature_id, feature_phase, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        t.autoPublish ? 1 : 0,
        t.createdByRun ?? null,
        t.spawnDepth ?? 0,
        t.featureId ?? null,
        t.featurePhase ?? null,
        ts,
        ts,
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
      },
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
        `UPDATE tm_tasks SET title=?, description=?, repo_id=?, parent_id=?, group_id=?, group_path=?, group_name=?, group_color=?, status=?, source=?, source_ref=?, priority=?, model=?, effort=?, category=?, review=?, auto_publish=?, feature_id=?, feature_phase=?, result_summary=?, review_summary=?, error=?, updated_at=? WHERE id=?`,
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
        next.autoPublish ? 1 : 0,
        next.featureId,
        next.featurePhase,
        next.resultSummary,
        next.reviewSummary,
        next.error,
        next.updatedAt,
        id,
      );
    return rowToTask(this.db.prepare(`SELECT * FROM tm_tasks WHERE id = ?`).get(id));
  }

  async updateTask(id: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): Promise<Task | null> {
    // A re-parent rewrites the moved subtree too, so it must be one transaction.
    return this.inTxn(() => this.updateTaskSync(id, patch));
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

  async claimNextQueuedTask(actor: string): Promise<Task | null> {
    // .get() (not .run()) — RETURNING rows are discarded by .run().
    // Atomic only because the orchestrator is single-process; a Postgres
    // multi-writer setup would need FOR UPDATE SKIP LOCKED (Phase 7 note).
    return this.inTxn((): Task | null => {
      const r = this.db
        .prepare(
          `UPDATE tm_tasks SET status = 'running', updated_at = ?
           WHERE id = (SELECT t.id FROM tm_tasks t WHERE t.status = 'queued' AND t.repo_id IS NOT NULL
                         AND ${FEATURE_CLAIM_GATE}
                       ORDER BY t.priority DESC, t.created_at LIMIT 1)
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
      const unresolved = rows.filter((r) => !TERMINAL_TASK_STATUSES.includes(r.status as Task['status'])).length;
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
    const resolved = rows.filter((r) => TERMINAL_TASK_STATUSES.includes(r.status as Task['status'])).length;
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
           WHERE id = (SELECT t.id FROM tm_tasks t
                       WHERE t.status = 'queued' AND t.repo_id IS NOT NULL AND t.created_by_run IN (${placeholders})
                         AND ${FEATURE_OVERFLOW_GATE}
                       ORDER BY t.created_at LIMIT 1)
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
        `INSERT INTO tm_runs (id, task_id, repo_id, mode, status, pid, model, effort, run_token, resumed_from, stats_baseline, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
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
        `INSERT INTO tm_dispatches (id, from_task_id, from_run_id, to_task_id, message, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(id, d.fromTaskId, d.fromRunId ?? null, d.toTaskId, d.message, now());
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
          `INSERT INTO tm_features (id, repo_id, title, request, status, analysis, review, analysis_rounds, error, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'draft', NULL, NULL, 0, NULL, ?, ?)`,
        )
        .run(id, f.repoId, f.title, f.request, ts, ts);
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
      const tasks: Task[] = [];
      for (const c of cards) {
        tasks.push(
          this.insertTaskSync(
            {
              title: c.card.title,
              description: c.description,
              repoId: feature.repoId,
              // Approved ≠ started: cards land as drafts and only the feature's
              // phase gate moves them to queued.
              status: 'draft',
              source: 'feature',
              category: c.card.category ?? null,
              effort: c.card.effort ?? null,
              review: c.card.review ?? null,
              featureId: feature.id,
              featurePhase: c.phase,
            },
            actor,
          ),
        );
      }
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

      const failed = tasks.filter((t) => t.status === 'failed');
      if (failed.length > 0) {
        const paused = this.transitionFeatureSync(featureId, ['running'], 'paused', actor, {
          error: `${failed.length} task(s) failed — retry or cancel them, then Resume`,
        });
        return paused ? { feature: paused, tasks: [], action: 'paused' } : null;
      }

      const pending = tasks.filter(isFeatureTaskBlocking);
      if (pending.length === 0) {
        const done = this.transitionFeatureSync(featureId, ['running'], 'review', actor, { error: null });
        return done ? { feature: done, tasks: [], action: 'review' } : null;
      }

      const phase = Math.min(...pending.map((t) => t.featurePhase ?? 0));
      const started: Task[] = [];
      for (const t of pending) {
        if ((t.featurePhase ?? 0) !== phase || t.status !== 'draft' || t.source !== 'feature') continue;
        if (!t.repoId) continue; // never queue a repo-less task: the claim loop skips it forever
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
      if (started.length === 0) return { feature, tasks: [], action: 'none', phase };
      return { feature, tasks: started, action: 'phase-started', phase };
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
