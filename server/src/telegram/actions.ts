import { broadcast } from '../events.ts';
import type { Orchestrator } from '../orchestrator.ts';
import type { Storage } from '../storage/types.ts';

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

/** review → done, the same move as POST /api/tasks/:id/complete. */
export async function completeTask(deps: ActionDeps, taskId: string, actor: string): Promise<ActionOutcome> {
  const task = await deps.storage.transitionTask(taskId, ['review'], 'done', actor);
  if (!task) return fail('task is not in review (already handled?)');
  broadcast({ type: 'task.updated', task });
  await deps.orchestrator.closeTaskSessions(taskId, actor);
  await deps.orchestrator.resolveCompletion(task, actor);
  return done(`“${task.title}” marked done.`);
}

/** review → published via the task's own session (POST /api/tasks/:id/publish). */
export async function publishTask(deps: ActionDeps, taskId: string, actor: string): Promise<ActionOutcome> {
  const result = await deps.orchestrator.publish(taskId, actor);
  if ('error' in result) return fail(result.error);
  return done(`Publish turn started for “${result.task.title}” — you'll get the landing status.`);
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
  /** `option` set = "accept, choosing THIS solution option" (0-based) */
  | { kind: 'proposal.accept'; id: string; option?: number }
  | { kind: 'proposal.reject'; id: string }
  | { kind: 'feature.approve'; id: string };

const WIRE: Record<ButtonAction['kind'], string> = {
  'task.done': 't:done',
  'task.publish': 't:pub',
  'task.proceed': 't:go',
  'proposal.accept': 'p:acc',
  'proposal.reject': 'p:rej',
  'feature.approve': 'f:ok',
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
