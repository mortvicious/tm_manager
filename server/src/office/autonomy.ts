// The office autonomy opt-in (docs/office.md § Autonomous opt-in,
// decisions.md 2026-11-07): the I/O half of `officeAutonomyRefusal`
// (shared/src/office.ts). It reads the rows the pure rule needs — the
// office, the task's role, repo and feature, the shift the task came from
// and the office's spend today — fresh, every time a power is about to be
// used: a landing tier is resolved (`Orchestrator`), a tier is written
// (`landingRefusal`), a push-ref is requested (`ApprovalService`). Nothing
// is cached here, so the kill switch or a budget trip takes effect on the
// very next read.

import {
  effectiveAutonomy,
  effectiveLanding,
  isExternalTask,
  officeAutonomyRefusal,
  type LandingTier,
  type OfficeAutonomyFacts,
  type OfficeAutonomyFiler,
  type OfficeAutonomousTask,
  type Repo,
  type Task,
  type TaskStatus,
} from '@tm/shared';
import type { Storage } from '../storage/types.ts';
import { officeDayOf } from './budget.ts';

/**
 * The shift a task came from: the shift whose run filed it
 * (`created_by_run` = the shift's aux run — a filing, an accepted proposal,
 * a routed message), else, for a feature card, the shift that filed the
 * feature (its `office.feature` audit row). Null = unknown, which the rule
 * refuses.
 */
export async function officeTaskFiler(storage: Storage, task: Pick<Task, 'officeId' | 'createdByRun' | 'featureId'>): Promise<OfficeAutonomyFiler | null> {
  if (!task.officeId) return null;
  let shiftId: string | null = null;
  if (task.createdByRun) {
    const run = await storage.getRun(task.createdByRun);
    if (!run || run.kind !== 'shift' || !run.subjectId) return null;
    shiftId = run.subjectId;
  } else if (task.featureId) {
    const feature = await storage.getFeature(task.featureId);
    if (!feature || feature.officeId !== task.officeId) return null;
    const rows = await storage.listEvents({ kind: 'office.feature', ...(feature.repoId ? { repoIds: [feature.repoId] } : {}), limit: 1000 });
    const row = rows.find((e) => (e.data as { featureId?: unknown } | null)?.featureId === feature.id);
    const id = (row?.data as { shiftId?: unknown } | null)?.shiftId;
    shiftId = typeof id === 'string' ? id : null;
  }
  if (!shiftId) return null;
  const shift = await storage.getShift(shiftId);
  if (!shift || shift.officeId !== task.officeId) return null;
  if (task.createdByRun && shift.runId !== task.createdByRun) return null;
  return { tainted: shift.tainted, trigger: shift.trigger.kind };
}

/**
 * The facts for an office task, or null for any other task. The cheap rows
 * (office, role, repo) come first; the filing shift, the feature and the
 * spend are read only when those could still grant — otherwise the rule
 * refuses on an earlier condition anyway, so leaving them null is exact.
 */
export async function officeAutonomyFacts(
  storage: Storage,
  task: Pick<Task, 'officeId' | 'roleId' | 'repoId' | 'featureId' | 'createdByRun'>,
  now = Date.now(),
  known?: { repo?: Repo | null },
): Promise<OfficeAutonomyFacts | null> {
  if (!task.officeId) return null;
  const office = await storage.getOffice(task.officeId);
  const role = task.roleId ? await storage.getOfficeRole(task.roleId) : null;
  const repo = known?.repo !== undefined && known.repo?.id === task.repoId ? known.repo : task.repoId ? await storage.getRepo(task.repoId) : null;
  const facts: OfficeAutonomyFacts = {
    office,
    role: role && role.officeId === task.officeId ? role : null,
    repo,
    feature: null,
    filer: null,
    spentTodayUsd: null,
    now,
  };
  const autonomy = office ? (facts.role ? effectiveAutonomy(office, facts.role) : office.autonomy) : null;
  if (!office || office.killSwitch || !repo?.officeAutonomyOptin || autonomy !== 'autonomous') return facts;
  facts.feature = task.featureId ? await storage.getFeature(task.featureId) : null;
  facts.filer = await officeTaskFiler(storage, task);
  facts.spentTodayUsd = await storage.officeSpendSince(office.id, officeDayOf(office, now).sinceIso);
  return facts;
}

/** Why `task` may not use the opt-in's powers right now, or null when it may (a fresh read). */
export async function officeAutonomyRefusalFor(storage: Storage, task: Task, now = Date.now(), known?: { repo?: Repo | null }): Promise<string | null> {
  return officeAutonomyRefusal(task, await officeAutonomyFacts(storage, task, now, known));
}

/**
 * `effectiveLanding` with the opt-in's facts read for an office task — THE
 * server-side resolution of a tier that is about to be acted on. A non-office
 * task needs no read; an office task without the opt-in stays clamped.
 */
export async function resolveLanding(storage: Storage, task: Task, repo: Repo | null | undefined, now = Date.now()): Promise<LandingTier> {
  if (!task.officeId || !isExternalTask(task)) return effectiveLanding(task, repo);
  const facts = await officeAutonomyFacts(storage, task, now, { repo: repo ?? null });
  return effectiveLanding(task, repo, facts);
}

/** The statuses whose landing is still ahead — the ones the badge is about. */
const LANDING_AHEAD: readonly TaskStatus[] = ['queued', 'running', 'waiting', 'review', 'blocked'];

/**
 * The open office tasks whose tier the opt-in raises above supervised right
 * now (`OrchestratorStatus.autonomous`, the SPA's "autonomous" badge). The
 * badge is a READING; every landing re-resolves through `resolveLanding`.
 * Short-circuits to [] while no repo has opted in or every office is
 * kill-switched, off or paused — the common case costs two reads.
 */
export async function autonomousOfficeTasks(storage: Storage, now = Date.now()): Promise<OfficeAutonomousTask[]> {
  const offices = (await storage.listOffices()).filter((o) => o.enabled && !o.killSwitch && !o.pausedAt);
  if (!offices.length) return [];
  const repos = await storage.listRepos();
  if (!repos.some((r) => r.officeAutonomyOptin)) return [];
  const byId = new Map(repos.map((r) => [r.id, r]));
  const out: OfficeAutonomousTask[] = [];
  for (const office of offices) {
    for (const t of await storage.listTasks({ officeId: office.id })) {
      if (!LANDING_AHEAD.includes(t.status) || !t.repoId) continue;
      const repo = byId.get(t.repoId);
      if (!repo?.officeAutonomyOptin) continue;
      const landing = effectiveLanding(t, repo, await officeAutonomyFacts(storage, t, now, { repo }));
      if (landing !== 'supervised') out.push({ taskId: t.id, officeId: office.id, landing });
    }
  }
  return out;
}
