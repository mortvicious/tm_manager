import type { Task } from '@tm/shared';
import type { ActionResult } from '../app-types.ts';
import { startFeatureAnalysis } from '../claude/feature-analysis.ts';
import { broadcast } from '../events.ts';
import type { Orchestrator } from '../orchestrator.ts';
import type { NewTask, Storage } from '../storage/types.ts';
import {
  ENQUEUE_FROM,
  RETRY_FROM,
  cancelTask as svcCancelTask,
  completeTask as svcCompleteTask,
  createTask as svcCreateTask,
  editTask as svcEditTask,
  enqueueTask as svcEnqueueTask,
  queueAddTask as svcQueueAdd,
  queueRemoveTask as svcQueueRemove,
  unblockTask as svcUnblock,
  type TaskEdit,
} from '../task-actions.ts';
import { short } from './ids.ts';

// The action layer both the notification buttons and the command handlers
// (task 3) share — one implementation per action, mirroring what the REST
// route for the same action does (transition + broadcast + follow-on), with
// `actor: 'telegram'` in the audit trail. In-process, never HTTP: a self-call
// would have to pass the Host/Origin allowlists, and two paths to one action
// is how the button and the web page start disagreeing (docs/telegram.md).

export interface ActionDeps {
  storage: Storage;
  orchestrator: Orchestrator;
}

/** `text` is PLAIN text — the caller escapes it for the surface it targets. */
export interface ActionOutcome {
  ok: boolean;
  text: string;
}

const fail = (text: string): ActionOutcome => ({ ok: false, text });
const done = (text: string): ActionOutcome => ({ ok: true, text });

/**
 * Everything below delegates to server/src/task-actions.ts — the SAME
 * functions the REST routes call, with 'telegram' as the actor instead of
 * 'human'. This file's job is only to turn an `ActionResult` into the sentence
 * a chat message wants; the transition, the broadcast and the audit row are
 * the service's, so the phone and the browser cannot drift apart.
 */
function outcome(r: ActionResult, say: (t: Task) => string): ActionOutcome {
  return 'error' in r ? fail(r.error) : done(say(r.task));
}

/** review → done, the same move as POST /api/tasks/:id/complete. */
export async function completeTask(deps: ActionDeps, taskId: string, actor: string): Promise<ActionOutcome> {
  const r = await svcCompleteTask(deps, taskId, actor);
  if ('error' in r) return fail(r.error === 'task is not in review' ? 'task is not in review (already handled?)' : r.error);
  return done(`“${r.task.title}” marked done.`);
}

/** POST /api/tasks/:id/enqueue — into the GLOBAL queue. */
export async function enqueueTask(deps: ActionDeps, taskId: string, actor: string): Promise<ActionOutcome> {
  return outcome(await svcEnqueueTask(deps, taskId, ENQUEUE_FROM, actor), (t) => `“${t.title}” is queued.`);
}

/** POST /api/tasks/:id/retry — the same move, from failed/cancelled only. */
export async function retryTask(deps: ActionDeps, taskId: string, actor: string): Promise<ActionOutcome> {
  return outcome(await svcEnqueueTask(deps, taskId, RETRY_FROM, actor), (t) => `“${t.title}” is queued for a retry.`);
}

/** POST /api/tasks/:id/run-now — jump the queue, spawn an agent now. */
export async function runNowTask(deps: ActionDeps, taskId: string, actor: string): Promise<ActionOutcome> {
  return outcome(await deps.orchestrator.runNow(taskId, actor), (t) => `“${t.title}” is running.`);
}

/** POST /api/tasks/:id/cancel — de-queue, or kill the session and cancel. */
export async function cancelTask(deps: ActionDeps, taskId: string, actor: string): Promise<ActionOutcome> {
  return outcome(await svcCancelTask(deps, taskId, actor), (t) => `“${t.title}” cancelled.`);
}

/** POST /api/tasks/:id/unblock — blocked → review. */
export async function unblockTask(deps: ActionDeps, taskId: string, actor: string): Promise<ActionOutcome> {
  return outcome(await svcUnblock(deps, taskId, actor), (t) => `“${t.title}” is back in review.`);
}

/** POST /api/tasks/:id/queue — the serial custom queue (docs/queue.md). */
export async function queueAdd(deps: ActionDeps, taskId: string, actor: string): Promise<ActionOutcome> {
  return outcome(await svcQueueAdd(deps, taskId, actor), (t) => `“${t.title}” added to the custom queue.`);
}

/** POST /api/tasks/:id/unqueue. */
export async function queueRemove(deps: ActionDeps, taskId: string, actor: string): Promise<ActionOutcome> {
  return outcome(await svcQueueRemove(deps, taskId, actor), (t) => `“${t.title}” removed from the custom queue.`);
}

/** POST /api/tasks — the end of the /new flow. */
export async function createTask(deps: ActionDeps, input: NewTask, actor: string): Promise<Task> {
  return svcCreateTask(deps, input, actor);
}

/** PATCH /api/tasks/:id — the end of an /edit step. */
export async function editTask(
  deps: ActionDeps,
  taskId: string,
  patch: TaskEdit,
  actor: string,
): Promise<ActionOutcome> {
  return outcome(await svcEditTask(deps, taskId, patch, actor), (t) => `“${t.title}” updated.`);
}

/**
 * POST /api/runs/:id/kill. The guard is the route's: a run that is not live
 * cannot be killed, and a live row whose session is already gone says so
 * rather than reporting a kill that did not happen.
 */
export async function killRun(deps: ActionDeps, runId: string, actor: string): Promise<ActionOutcome> {
  const run = await deps.storage.getRun(runId);
  if (!run) return fail('run not found');
  if (run.status !== 'running') return fail(`run is not live (it is ${run.status})`);
  const killed = await deps.orchestrator.killRun(runId, actor);
  if (!killed) return fail('session already gone');
  return done(`Run ${short(runId)} killed.`);
}

/**
 * POST /api/orchestrator/start|stop. `setEnabled` writes the setting, the
 * audit row and the broadcast itself — /on and /off are one call each.
 */
export async function setQueueEnabled(deps: ActionDeps, enabled: boolean, actor: string): Promise<ActionOutcome> {
  const before = await deps.orchestrator.status();
  if (before.enabled === enabled) return done(`The queue is already ${enabled ? 'running' : 'stopped'}.`);
  await deps.orchestrator.setEnabled(enabled, actor);
  return done(
    enabled
      ? 'Queue started — picking tasks again.'
      : 'Queue stopped — no new tasks will be picked. Live sessions keep running (/kill ends one).',
  );
}

/**
 * The /feature intake: create the feature and immediately start the headless
 * analysis, because on a phone the two are never separate acts. Mirrors
 * POST /api/features + POST /api/features/:id/analyze, including the
 * transition-as-a-lock and the revert when the spawn throws.
 */
export async function createAndAnalyzeFeature(
  deps: ActionDeps,
  input: { repoId: string; title: string; request: string },
  actor: string,
): Promise<ActionOutcome> {
  const repo = await deps.storage.getRepo(input.repoId);
  if (!repo) return fail('repo not found');
  if (!input.request.trim()) return fail('the request is empty');
  const feature = await deps.storage.createFeature(input, actor);
  broadcast({ type: 'feature.updated', feature });
  const analyzing = await deps.storage.transitionFeature(feature.id, ['draft'], 'analyzing', actor, { error: null });
  if (!analyzing) return fail(`created ${short(feature.id)}, but it could not start analysing`);
  broadcast({ type: 'feature.updated', feature: analyzing });
  try {
    await startFeatureAnalysis({ storage: deps.storage }, analyzing, repo, {});
  } catch (e) {
    const reverted = await deps.storage.transitionFeature(feature.id, ['analyzing'], 'failed', 'system', {
      error: `could not start the analysis: ${(e as Error).message}`,
    });
    if (reverted) broadcast({ type: 'feature.updated', feature: reverted });
    return fail(`could not start the analysis: ${(e as Error).message}`);
  }
  return done(
    `Feature “${feature.title}” (${short(feature.id)}) is being analysed — ` +
      `the plan comes back here with an Approve button.`,
  );
}

/** review → published via the task's own session (POST /api/tasks/:id/publish). */
export async function publishTask(deps: ActionDeps, taskId: string, actor: string): Promise<ActionOutcome> {
  const result = await deps.orchestrator.publish(taskId, actor);
  if ('error' in result) return fail(result.error);
  return done(`Publish turn started for “${result.task.title}” — you'll get the landing status.`);
}

/**
 * POST /api/tasks/:id/follow-up — the web drawer's "Send follow-up" field.
 * Mode 'auto' is the difference that matters: it resumes when there IS a
 * session and otherwise spawns a FRESH worker carrying the message in its
 * prompt, where `proceed` (mode 'resume') refuses. Without this the bot had no
 * way to instruct a task whose transcript had been pruned — `/run` starts an
 * agent off the description and discards whatever the human typed.
 */
export async function followUpTask(
  deps: ActionDeps,
  taskId: string,
  message: string,
  actor: string,
): Promise<ActionOutcome> {
  const result = await deps.orchestrator.followUp(taskId, message, actor, 'auto');
  if ('error' in result) return fail(result.error);
  return done(`“${result.task.title}” picked up your instruction in a fresh session.`);
}

/** Resume the task's previous claude session (POST /api/tasks/:id/proceed). */
export async function proceedTask(
  deps: ActionDeps,
  taskId: string,
  actor: string,
  message: string | null = null,
): Promise<ActionOutcome> {
  const result = await deps.orchestrator.proceed(taskId, message, actor);
  if ('error' in result) return fail(result.error);
  return done(`“${result.task.title}” is proceeding in its own session.`);
}

/**
 * Mirrors POST /api/proposals/:id/accept. A `solution_options` proposal is a
 * choice, not a confirmation: storage resolves a missing index as option 0,
 * so accepting one without an explicit `option` would silently commit an
 * approach the owner never saw — refused here; the notification offers one
 * button per option instead.
 */
export async function acceptProposal(
  deps: ActionDeps,
  proposalId: string,
  actor: string,
  option?: number,
): Promise<ActionOutcome> {
  const proposal = await deps.storage.getProposal(proposalId);
  if (!proposal) return fail('proposal not found');
  const options = proposal.payload.options ?? [];
  if (options.length > 0 && option === undefined) {
    return fail(`this proposal offers ${options.length} options — pick one with its own button`);
  }
  if (option !== undefined && !options[option]) {
    return fail(`option ${option + 1} does not exist on this proposal`);
  }
  const result = await deps.storage.acceptProposal(proposalId, actor, option);
  if (!result) return fail('proposal not found or not pending');
  for (const task of result.tasks) broadcast({ type: 'task.updated', task });
  broadcast({ type: 'proposal.created', proposal: result.proposal }); // upserted client-side
  deps.orchestrator.maybeSchedule(); // split-accept queues children
  const chosen = option !== undefined ? ` — chose “${options[option].label}”` : '';
  const n = result.tasks.length;
  return done(`Proposal accepted${chosen}${n ? ` (${n} task(s) touched)` : ''}.`);
}

/** Mirrors POST /api/proposals/:id/reject, including its audit row. */
export async function rejectProposal(deps: ActionDeps, proposalId: string, actor: string): Promise<ActionOutcome> {
  const proposal = await deps.storage.rejectProposal(proposalId);
  if (!proposal) return fail('proposal not found');
  if (proposal.status !== 'rejected') return fail(`proposal is already ${proposal.status}`);
  await deps.storage.appendEvent({
    kind: 'proposal.decided',
    actor,
    taskId: proposal.taskId,
    repoId: proposal.repoId,
    data: { proposalId, kind: proposal.kind, decision: 'rejected' },
  });
  broadcast({ type: 'proposal.created', proposal });
  return done('Proposal rejected.');
}

// ---- the button codec ---------------------------------------------------
//
// callback_data is capped at 64 bytes by Telegram, so the wire form is a
// three-part `<ns>:<verb>:<id>` string. Encode and parse live next to the
// dispatch table they index so a new button cannot be added to one without
// the other.

export type ButtonAction =
  | { kind: 'task.done'; id: string }
  | { kind: 'task.publish'; id: string }
  | { kind: 'task.proceed'; id: string }
  | { kind: 'task.enqueue'; id: string }
  | { kind: 'task.run'; id: string }
  | { kind: 'task.cancel'; id: string }
  | { kind: 'task.retry'; id: string }
  | { kind: 'task.unblock'; id: string }
  | { kind: 'task.queueAdd'; id: string }
  | { kind: 'task.queueRemove'; id: string }
  /** `option` set = "accept, choosing THIS solution option" (0-based) */
  | { kind: 'proposal.accept'; id: string; option?: number }
  | { kind: 'proposal.reject'; id: string }
  | { kind: 'feature.approve'; id: string }
  | { kind: 'run.kill'; id: string };

const WIRE: Record<ButtonAction['kind'], string> = {
  'task.done': 't:done',
  'task.publish': 't:pub',
  'task.proceed': 't:go',
  'task.enqueue': 't:enq',
  'task.run': 't:run',
  'task.cancel': 't:can',
  'task.retry': 't:rty',
  'task.unblock': 't:unb',
  'task.queueAdd': 't:qadd',
  'task.queueRemove': 't:qrm',
  'proposal.accept': 'p:acc',
  'proposal.reject': 'p:rej',
  'feature.approve': 'f:ok',
  'run.kill': 'r:kill',
};
const FROM_WIRE = new Map(Object.entries(WIRE).map(([k, v]) => [v, k as ButtonAction['kind']]));

export function encodeAction(a: ButtonAction): string {
  // `p:acc:<n>:<id>` for an option-choosing accept, `<ns>:<verb>:<id>` else.
  if (a.kind === 'proposal.accept' && a.option !== undefined) return `${WIRE[a.kind]}:${a.option}:${a.id}`;
  return `${WIRE[a.kind]}:${a.id}`;
}

export function parseActionData(data: string): ButtonAction | null {
  const m = /^([a-z]:[a-z]+):(?:(\d{1,2}):)?([\w-]{1,48})$/.exec(data);
  if (!m) return null;
  const kind = FROM_WIRE.get(m[1]);
  if (!kind) return null;
  if (m[2] !== undefined) {
    // The option segment is only meaningful on an accept; anywhere else it is
    // a malformed button, not something to guess about.
    if (kind !== 'proposal.accept') return null;
    return { kind, id: m[3], option: Number(m[2]) };
  }
  return { kind, id: m[3] };
}

export function runButtonAction(deps: ActionDeps, a: ButtonAction, actor: string): Promise<ActionOutcome> {
  switch (a.kind) {
    case 'task.done':
      return completeTask(deps, a.id, actor);
    case 'task.publish':
      return publishTask(deps, a.id, actor);
    case 'task.proceed':
      return proceedTask(deps, a.id, actor);
    case 'task.enqueue':
      return enqueueTask(deps, a.id, actor);
    case 'task.run':
      return runNowTask(deps, a.id, actor);
    case 'task.cancel':
      return cancelTask(deps, a.id, actor);
    case 'task.retry':
      return retryTask(deps, a.id, actor);
    case 'task.unblock':
      return unblockTask(deps, a.id, actor);
    case 'task.queueAdd':
      return queueAdd(deps, a.id, actor);
    case 'task.queueRemove':
      return queueRemove(deps, a.id, actor);
    case 'run.kill':
      return killRun(deps, a.id, actor);
    case 'proposal.accept':
      return acceptProposal(deps, a.id, actor, a.option);
    case 'proposal.reject':
      return rejectProposal(deps, a.id, actor);
    case 'feature.approve':
      return approveFeature(deps, a.id, actor);
  }
}

/**
 * Approve AND start — the phone flow from the design doc ("approve button =
 * POST /features/:id/approve + start"): the visual plan check happened when
 * the analysis report was read, so a separate start tap earns nothing.
 */
export async function approveFeature(deps: ActionDeps, featureId: string, actor: string): Promise<ActionOutcome> {
  const cur = await deps.storage.getFeature(featureId);
  if (!cur) return fail('feature not found');
  if (cur.status !== 'proposed') return fail(`cannot approve from status '${cur.status}'`);
  if (!cur.repoId) return fail('this feature has no repo (it was removed)');
  const result = await deps.storage.approveFeature(featureId, actor);
  if (!result) return fail('nothing to approve — the plan has no included tasks');
  broadcast({ type: 'feature.updated', feature: result.feature });
  for (const task of result.tasks) broadcast({ type: 'task.updated', task });
  const started = await deps.storage.transitionFeature(featureId, ['approved'], 'running', actor, { error: null });
  if (!started) return done(`“${cur.title}” approved (${result.tasks.length} task(s) created), but it could not start.`);
  broadcast({ type: 'feature.updated', feature: started });
  await deps.orchestrator.advanceFeature(featureId, actor);
  return done(`“${cur.title}” approved and started — ${result.tasks.length} task(s) created.`);
}
