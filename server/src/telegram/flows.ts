import { EFFORT_LEVELS, MODEL_OPTIONS, TASK_PRESETS, type EffortLevel, type Repo } from '@tm/shared';
import type { Orchestrator } from '../orchestrator.ts';
import type { Storage } from '../storage/types.ts';
import type { TaskEdit } from '../task-actions.ts';
import {
  createAndAnalyzeFeature,
  createTask,
  editTask,
  enqueueTask,
  followUpTask,
  proceedTask,
  queueAdd,
  runNowTask,
} from './actions.ts';
import { escapeHtml, type Reply } from './api.ts';
import type { InlineKeyboardMarkup } from './types.ts';
import { short } from './ids.ts';

// The conversational half of the bot. Anything that needs free text (a title,
// a description, a feature request) is a reply-to conversation; anything that
// is a choice is an inline keyboard. Both live here so a flow's steps, its
// buttons and its terminal action cannot drift apart.
//
// Deliberately ONE flow at a time. The gate allows exactly one user, so "the
// active flow" is unambiguous, and a second half-finished /new is a way to
// file a task into the wrong repo rather than a feature. Starting anything
// else — any slash command, /new again — drops the flow and says so.
//
// State is in memory only. A restart loses a half-typed task, which is the
// right trade: the alternative is a table of dangling intentions that fire
// hours later, exactly what the boot-discard rule exists to prevent.

/** A flow left untouched for this long is gone; the next message starts fresh. */
export const FLOW_TIMEOUT_MS = 10 * 60_000;

export type FlowKind = 'new' | 'edit' | 'feature' | 'proceed' | 'draft';

interface FlowData {
  repoId?: string;
  title?: string;
  description?: string | null;
  model?: string | null;
  effort?: EffortLevel | null;
  review?: boolean | null;
  autoPublish?: boolean;
  /** /edit and /proceed */
  taskId?: string;
  /** /edit: which field the next message or press sets */
  field?: EditField;
  /** /feature: the whole request text */
  request?: string;
  /** /proceed: false = no session to resume, so the answer starts a fresh one */
  resumable?: boolean;
}

export interface Flow {
  kind: FlowKind;
  step: string;
  data: FlowData;
  /** epoch ms; past it the flow is dead (checked, never timer-driven) */
  expiresAt: number;
}

/**
 * What a step produced: the message, and whether the WRITE behind it actually
 * succeeded. The two are not the same — a refused `editTask` still has a
 * perfectly good sentence to send — and collapsing them is how the audit trail
 * ends up recording `ok: true` for a write that was refused.
 */
export interface StepResult {
  reply: Reply;
  ok: boolean;
}

const step = (reply: Reply, ok = true): StepResult => ({ reply, ok });

export interface FlowDeps {
  storage: Storage;
  orchestrator: Orchestrator;
  actor: string;
}

/** Fields /edit can set — the subset of the PATCH body worth a phone keyboard. */
type EditField = 'title' | 'description' | 'category' | 'repo' | 'model' | 'effort' | 'review' | 'autopublish';

const EDIT_FIELDS: { id: EditField; label: string; free: boolean }[] = [
  { id: 'title', label: 'Title', free: true },
  { id: 'description', label: 'Description', free: true },
  { id: 'category', label: 'Category', free: true },
  // Without this a repo-less task is a dead end on the phone: every run path
  // refuses with "assign a repo before running this task" and no bot surface
  // could assign one. Tasks arrive repo-less from the REST body and from
  // agent/proposal creation, so the refusal was reachable and unactionable.
  { id: 'repo', label: 'Repo', free: false },
  { id: 'model', label: 'Model', free: false },
  { id: 'effort', label: 'Effort', free: false },
  { id: 'review', label: 'Review', free: false },
  { id: 'autopublish', label: 'Auto-publish', free: false },
];

/**
 * The models the picker offers. `MODEL_OPTIONS` plus the one Codex id the
 * presets already expose — the field accepts any string, but a phone keyboard
 * is a shortlist, and /edit's free-text path is not offered for model on
 * purpose (a typo'd model id fails at spawn time, hours later).
 */
const MODEL_CHOICES = [...MODEL_OPTIONS, 'codex-free'];

// ---- the store ----------------------------------------------------------

export class FlowStore {
  private flow: Flow | null = null;
  /**
   * Monotonic flow-instance number, stamped into every wizard button. The step
   * NAME is not identity: `/edit taskA` → tap Model → abandon with
   * `/edit taskB` → tap Model → then scroll up and tap taskA's keyboard, and a
   * name-only check ("is the flow on 'value' with field 'model'?") says yes —
   * patching taskB from a keyboard rendered under taskA's prompt. Never reset,
   * so a button from a cleared flow is stale rather than accidentally valid
   * again.
   */
  private n = 0;

  /** The instance number the buttons rendered right now must carry. */
  seq(): number {
    return this.n;
  }

  /** The live flow, or null when there is none or it timed out. */
  get(): Flow | null {
    if (this.flow && Date.now() > this.flow.expiresAt) this.flow = null;
    return this.flow;
  }

  set(kind: FlowKind, step: string, data: FlowData): Flow {
    this.n++;
    this.flow = { kind, step, data, expiresAt: Date.now() + FLOW_TIMEOUT_MS };
    return this.flow;
  }

  /** Advance in place, refreshing the timeout — a flow being used stays alive. */
  advance(step: string, patch: Partial<FlowData> = {}): Flow | null {
    if (!this.flow) return null;
    this.flow = {
      ...this.flow,
      step,
      data: { ...this.flow.data, ...patch },
      expiresAt: Date.now() + FLOW_TIMEOUT_MS,
    };
    return this.flow;
  }

  clear(): void {
    this.flow = null;
  }
}

// ---- keyboards ----------------------------------------------------------

/**
 * `w:<seq>:<step>:<value>` — the one place a wizard button's wire form is
 * composed. Worst case is 2 + 6 + 6 + 36 = 50 bytes against Telegram's 64.
 */
const wz = (seq: number, step: string, value: string) => `w:${seq}:${step}:${value}`;

/** Cancel is the one press exempt from the seq check — see handleFlowButton. */
const CANCEL_ROW = [{ text: '✕ Cancel', callback_data: 'w:0:cancel:x' }];

/** Two columns: on a phone, one button per row wastes the screen. */
function grid(buttons: { text: string; callback_data: string }[], perRow = 2): InlineKeyboardMarkup {
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < buttons.length; i += perRow) rows.push(buttons.slice(i, i + perRow));
  rows.push(CANCEL_ROW);
  return { inline_keyboard: rows };
}

function repoKeyboard(repos: Repo[], seq: number): InlineKeyboardMarkup {
  return grid(repos.map((r) => ({ text: r.name, callback_data: wz(seq, 'repo', r.id) })));
}

function presetKeyboard(seq: number): InlineKeyboardMarkup {
  return grid([
    ...TASK_PRESETS.map((p) => ({ text: `${p.label} (${p.hint})`, callback_data: wz(seq, 'preset', p.id) })),
    { text: '⚙ Custom…', callback_data: wz(seq, 'preset', 'custom') },
  ], 1);
}

function modelKeyboard(seq: number): InlineKeyboardMarkup {
  return grid([
    { text: 'default (config)', callback_data: wz(seq, 'model', 'd') },
    ...MODEL_CHOICES.map((m, i) => ({ text: m, callback_data: wz(seq, 'model', String(i)) })),
  ]);
}

function effortKeyboard(seq: number): InlineKeyboardMarkup {
  return grid([
    { text: 'default (config)', callback_data: wz(seq, 'effort', 'd') },
    ...EFFORT_LEVELS.map((e) => ({ text: e, callback_data: wz(seq, 'effort', e) })),
  ], 3);
}

function reviewKeyboard(seq: number): InlineKeyboardMarkup {
  return grid([
    { text: 'default (config)', callback_data: wz(seq, 'review', 'd') },
    { text: 'on', callback_data: wz(seq, 'review', 'on') },
    { text: 'off', callback_data: wz(seq, 'review', 'off') },
  ], 3);
}

function autoPublishKeyboard(seq: number): InlineKeyboardMarkup {
  return grid([
    { text: 'off — stop at review', callback_data: wz(seq, 'autopub', 'off') },
    { text: 'on — commit & push', callback_data: wz(seq, 'autopub', 'on') },
  ], 1);
}

/**
 * `➕` is the custom queue everywhere else in this module set — the marker on
 * a queued row, the `/task` standing line, `taskActionKeyboard`'s own pair of
 * buttons. It used to sit on the GLOBAL enqueue here, which is the one queue
 * that stops when /off is set: exactly the opposite of what a `➕` promises.
 * The global option now wears `⏳` to match `taskActionKeyboard`, and the
 * custom queue is reachable from /new at all, which it previously was not.
 */
function onCreateKeyboard(seq: number): InlineKeyboardMarkup {
  return grid([
    { text: '📝 Save as draft', callback_data: wz(seq, 'create', 'draft') },
    { text: '⏳ Queue', callback_data: wz(seq, 'create', 'queue') },
    { text: '➕ Custom queue (serial, ignores /off)', callback_data: wz(seq, 'create', 'custom') },
    { text: '▶ Run now', callback_data: wz(seq, 'create', 'run') },
  ], 1);
}

function editFieldKeyboard(seq: number): InlineKeyboardMarkup {
  return grid(EDIT_FIELDS.map((f) => ({ text: f.label, callback_data: wz(seq, 'field', f.id) })));
}

const skipKeyboard = (seq: number): InlineKeyboardMarkup => ({
  inline_keyboard: [[{ text: '⏭ Skip', callback_data: wz(seq, 'desc', 'skip') }], CANCEL_ROW],
});

const draftConfirmKeyboard = (seq: number): InlineKeyboardMarkup => ({
  inline_keyboard: [
    [
      { text: '✅ Create draft', callback_data: wz(seq, 'draft', 'yes') },
      { text: '✕ Discard', callback_data: wz(seq, 'draft', 'no') },
    ],
  ],
});

// ---- starting a flow ----------------------------------------------------

const TITLE_MAX = 300;

/**
 * First line as the title, the rest as the description. A single line longer
 * than the title cap spills the REMAINDER into the description — slicing from
 * TITLE_MAX rather than from 0, so nothing is lost and nothing is said twice
 * (the whole text as the description would repeat the 300 characters already
 * standing as the title in the preview, the summary and the stored row).
 */
function splitText(text: string): { title: string; description: string | null } {
  const trimmed = text.trim();
  const nl = trimmed.indexOf('\n');
  if (nl === -1) {
    return { title: trimmed.slice(0, TITLE_MAX), description: trimmed.slice(TITLE_MAX).trim() || null };
  }
  return { title: trimmed.slice(0, nl).trim().slice(0, TITLE_MAX), description: trimmed.slice(nl + 1).trim() || null };
}

/** /new — the repo is first because everything after it is repo-shaped. */
export async function startNew(deps: FlowDeps, flows: FlowStore, seed?: string): Promise<Reply> {
  const repos = await deps.storage.listRepos();
  if (repos.length === 0) return { html: 'No repos are registered — add one in the web UI first.' };
  const seeded = seed?.trim() ? splitText(seed) : null;
  flows.set('new', 'repo', seeded ? { title: seeded.title, description: seeded.description } : {});
  const head = seeded
    ? `<b>New task</b>\n${escapeHtml(seeded.title)}\n\nWhich repo?`
    : '<b>New task</b> — which repo?';
  return { html: head, keyboard: repoKeyboard(repos, flows.seq()) };
}

/** /edit &lt;id&gt; — the task is already resolved by the command handler. */
export function startEdit(flows: FlowStore, taskId: string, title: string): Reply {
  flows.set('edit', 'field', { taskId });
  return {
    html: `<b>Edit</b> “${escapeHtml(title)}” (<code>${short(taskId)}</code>) — which field?`,
    keyboard: editFieldKeyboard(flows.seq()),
  };
}

/** /feature — the request text first (it is the whole point), then the repo. */
export async function startFeature(deps: FlowDeps, flows: FlowStore, seed: string): Promise<Reply> {
  const repos = await deps.storage.listRepos();
  if (repos.length === 0) return { html: 'No repos are registered — add one in the web UI first.' };
  if (!seed.trim()) {
    flows.set('feature', 'text', {});
    return {
      html:
        '<b>New feature</b> — send the request as one message.\n\n' +
        'The first line becomes the title; the whole message is what the analysis reads.',
      keyboard: { inline_keyboard: [CANCEL_ROW] },
    };
  }
  flows.set('feature', 'repo', { request: seed.trim(), title: splitText(seed).title });
  return { html: '<b>New feature</b> — which repo?', keyboard: repoKeyboard(repos, flows.seq()) };
}

/**
 * /proceed &lt;id&gt; with no text: ask for it rather than resuming blind.
 *
 * `resumable` decides which move the answer triggers, not whether it is
 * collected: with a session the text resumes it, without one it starts a fresh
 * worker carrying the instruction (the web drawer's follow-up behaviour). The
 * prompt says which, so nobody is surprised by a new agent.
 */
export function startProceed(flows: FlowStore, taskId: string, title: string, resumable = true): Reply {
  flows.set('proceed', 'text', { taskId, resumable });
  return {
    html:
      `<b>Proceed</b> — what should “${escapeHtml(title)}” do next? Send it as one message.` +
      (resumable ? '' : `\n\n<i>No session left to resume — this will start a fresh agent carrying your instruction.</i>`),
    keyboard: { inline_keyboard: [CANCEL_ROW] },
  };
}

/**
 * Free text with no flow running. It NEVER becomes a task on its own — the
 * design doc is explicit that a bare message is inert until an explicit
 * confirm, because "I was thinking out loud" and "queue this" look identical
 * in a chat window.
 */
export function offerDraft(flows: FlowStore, text: string): Reply {
  const { title, description } = splitText(text);
  flows.set('draft', 'confirm', { title, description });
  return {
    html:
      `Not a command. Create a <b>draft</b> task from this?\n\n` +
      `<b>${escapeHtml(title)}</b>` +
      (description ? `\n${escapeHtml(description.slice(0, 500))}${description.length > 500 ? '…' : ''}` : ''),
    keyboard: draftConfirmKeyboard(flows.seq()),
  };
}

// ---- the text half ------------------------------------------------------

/**
 * A plain message while a flow is waiting for free text. Returns null when the
 * live flow is waiting for a BUTTON instead — the caller re-prompts rather
 * than silently swallowing what was typed.
 */
export async function handleFlowText(deps: FlowDeps, flows: FlowStore, text: string): Promise<StepResult | null> {
  const flow = flows.get();
  if (!flow) return null;
  const body = text.trim();
  if (!body) return null;

  if (flow.kind === 'new' && flow.step === 'title') {
    flows.advance('desc', { title: body.slice(0, TITLE_MAX) });
    return step({ html: 'Description? (or skip)', keyboard: skipKeyboard(flows.seq()) });
  }
  if (flow.kind === 'new' && flow.step === 'desc') {
    flows.advance('preset', { description: body });
    return step({ html: paramsPrompt(flow.data.title ?? ''), keyboard: presetKeyboard(flows.seq()) });
  }
  if (flow.kind === 'draft' && flow.step === 'confirm') {
    // A second thought while the first is still waiting on its confirm button.
    // The headline behaviour of this surface is "send a thought, get a draft
    // offer", so the newer text REPLACES the pending offer rather than being
    // swallowed for the rest of the ten-minute timeout. Nothing is lost: the
    // superseded offer had created nothing, which is the whole point of the
    // confirm gate.
    return step(offerDraft(flows, body));
  }
  if (flow.kind === 'edit' && flow.step === 'value') {
    // A choice field is waiting for a BUTTON; returning null re-prompts rather
    // than writing whatever was typed into the wrong column.
    return applyEdit(deps, flows, flow, body);
  }
  if (flow.kind === 'feature' && flow.step === 'text') {
    const repos = await deps.storage.listRepos();
    flows.advance('repo', { request: body, title: splitText(body).title });
    return step({ html: '<b>New feature</b> — which repo?', keyboard: repoKeyboard(repos, flows.seq()) });
  }
  if (flow.kind === 'proceed' && flow.step === 'text') {
    const taskId = flow.data.taskId!;
    const resumable = flow.data.resumable !== false;
    flows.clear();
    const actionDeps = { storage: deps.storage, orchestrator: deps.orchestrator };
    const r = resumable
      ? await proceedTask(actionDeps, taskId, deps.actor, body)
      : await followUpTask(actionDeps, taskId, body, deps.actor);
    return step({ html: `${r.ok ? '✅' : '⚠'} ${escapeHtml(r.text)}` }, r.ok);
  }
  return null;
}

function paramsPrompt(title: string): string {
  return (
    `<b>${escapeHtml(title)}</b>\n\n` +
    `Agent settings — pick a preset, or Custom to choose model, effort and review yourself.`
  );
}

// ---- the button half ----------------------------------------------------

export interface FlowButton {
  /** which flow INSTANCE rendered this button (0 = the exempt Cancel) */
  seq: number;
  step: string;
  value: string;
}

/**
 * `w:<step>:<value>`. A separate namespace from the action codec in
 * actions.ts: those buttons are stateless and stay valid forever (a Publish
 * button on a week-old notification still means one thing), while these are
 * meaningless without the flow they belong to. Keeping them apart is what
 * lets a stale wizard press be REFUSED rather than misread as an action.
 */
export function parseFlowData(data: string): FlowButton | null {
  const m = /^w:(\d{1,9}):([a-z]+):([\w-]{1,48})$/.exec(data);
  return m ? { seq: Number(m[1]), step: m[2], value: m[3] } : null;
}

export interface FlowPress {
  /** the toast for answerCallbackQuery */
  toast: string;
  reply: Reply | null;
  /** what the audit row calls this press */
  audit: string;
  ok: boolean;
}

export async function handleFlowButton(deps: FlowDeps, flows: FlowStore, b: FlowButton): Promise<FlowPress> {
  const expired = (): FlowPress => ({
    toast: 'That step is no longer active',
    reply: { html: '⏳ That step is no longer active — start again with /new, /edit or /feature.' },
    audit: `flow:${b.step}`,
    ok: false,
  });

  // Cancel is exempt from the seq check: it is idempotent, it writes nothing,
  // and "the Cancel button on the message above no longer works" is a worse
  // surprise than cancelling something already gone.
  if (b.step === 'cancel') {
    const had = flows.get() !== null;
    flows.clear();
    return {
      toast: had ? 'Cancelled' : 'Nothing to cancel',
      reply: { html: had ? 'Cancelled.' : 'Nothing in progress.' },
      audit: 'flow:cancel',
      ok: true,
    };
  }

  const flow = flows.get();
  if (!flow) return expired();
  // The press must come from the keyboard THIS flow instance rendered. The
  // step name alone is not identity: an abandoned /edit and its replacement sit
  // at the same step with the same field, so a scroll-up tap on the old
  // keyboard would patch the new flow's task.
  if (b.seq !== flows.seq()) return expired();
  // `deliver` takes either a bare prompt (a step that only asks the next
  // question — nothing was written, so there is nothing to fail) or a
  // StepResult, whose `ok` is the WRITE's outcome and must reach both the
  // toast and the audit row. Defaulting `ok` to true for a terminal press is
  // how "Created" ended up on top of a refused enqueue.
  const deliver = (r: Reply | StepResult | null, toast = 'OK', okOverride?: boolean): FlowPress => {
    const res = r && 'reply' in r ? r : { reply: r, ok: true };
    const ok = okOverride ?? res.ok;
    return {
      toast: ok ? toast : 'Failed',
      reply: res.reply,
      audit: `flow:${flow.kind}:${b.step}`,
      ok,
    };
  };

  // The press must answer the step the flow is actually on: a button from an
  // earlier step (or an earlier flow) is stale, not a shortcut.
  const expects = (kind: FlowKind, step: string) => flow.kind === kind && flow.step === step;

  if (b.step === 'draft') {
    if (!expects('draft', 'confirm')) return expired();
    if (b.value === 'no') {
      flows.clear();
      return deliver({ html: 'Discarded — nothing was created.' }, 'Discarded');
    }
    const repos = await deps.storage.listRepos();
    if (repos.length === 0) {
      flows.clear();
      return deliver({ html: 'No repos are registered — add one in the web UI first.' }, 'No repos', false);
    }
    if (repos.length === 1) return deliver(await finishDraft(deps, flows, repos[0].id), 'Created');
    flows.advance('repo');
    return deliver({ html: 'Which repo?', keyboard: repoKeyboard(repos, flows.seq()) });
  }

  if (b.step === 'repo') {
    // `/edit` reuses the same repo keyboard, so the press lands here with the
    // flow on 'value' rather than 'repo'.
    const editingRepo = expects('edit', 'value') && flow.data.field === 'repo';
    if (flow.step !== 'repo' && !editingRepo) return expired();
    const repo = await deps.storage.getRepo(b.value);
    if (!repo) return deliver({ html: '⚠ That repo is gone.' }, 'Repo not found', false);
    if (editingRepo) return deliver(await applyEditValue(deps, flows, flow, { repoId: repo.id }));
    if (flow.kind === 'draft') return deliver(await finishDraft(deps, flows, repo.id), 'Created');
    if (flow.kind === 'feature') {
      flows.clear();
      const r = await createAndAnalyzeFeature(
        { storage: deps.storage, orchestrator: deps.orchestrator },
        { repoId: repo.id, title: flow.data.title || 'Feature', request: flow.data.request ?? '' },
        deps.actor,
      );
      return deliver({ html: `${r.ok ? '🧩' : '⚠'} ${escapeHtml(r.text)}` }, r.ok ? 'Analysing' : 'Failed', r.ok);
    }
    // /new: a seeded title (free text → "create a task") skips straight ahead.
    // `startNew` always writes a `description` key when seeded — `splitText`
    // returns `string | null`, never undefined — so a seeded flow goes to the
    // params step and an unseeded one never reaches here with a title.
    if (flow.data.title) {
      flows.advance('preset', { repoId: repo.id });
      return deliver({ html: paramsPrompt(flow.data.title), keyboard: presetKeyboard(flows.seq()) });
    }
    flows.advance('title', { repoId: repo.id });
    return deliver({
      html: `Repo <b>${escapeHtml(repo.name)}</b>. What is the task? Send the title as one message.`,
      keyboard: { inline_keyboard: [CANCEL_ROW] },
    });
  }

  if (b.step === 'desc') {
    if (!expects('new', 'desc')) return expired();
    flows.advance('preset', { description: null });
    return deliver({ html: paramsPrompt(flow.data.title ?? ''), keyboard: presetKeyboard(flows.seq()) });
  }

  if (b.step === 'preset') {
    if (!expects('new', 'preset')) return expired();
    if (b.value === 'custom') {
      flows.advance('model');
      return deliver({ html: 'Model?', keyboard: modelKeyboard(flows.seq()) });
    }
    const preset = TASK_PRESETS.find((p) => p.id === b.value);
    if (!preset) return deliver({ html: '⚠ Unknown preset.' }, 'Unknown preset', false);
    flows.advance('autopub', { model: preset.model, effort: preset.effort, review: preset.review });
    return deliver({ html: autoPublishPrompt(), keyboard: autoPublishKeyboard(flows.seq()) });
  }

  if (b.step === 'model') {
    const model = b.value === 'd' ? null : (MODEL_CHOICES[Number(b.value)] ?? null);
    if (b.value !== 'd' && model === null) return deliver({ html: '⚠ Unknown model.' }, 'Unknown model', false);
    if (expects('new', 'model')) {
      flows.advance('effort', { model });
      return deliver({ html: 'Effort?', keyboard: effortKeyboard(flows.seq()) });
    }
    if (expects('edit', 'value') && flow.data.field === 'model') return deliver(await applyEditValue(deps, flows, flow, { model }));
    return expired();
  }

  if (b.step === 'effort') {
    const effort = b.value === 'd' ? null : (EFFORT_LEVELS.find((e) => e === b.value) ?? null);
    if (b.value !== 'd' && effort === null) return deliver({ html: '⚠ Unknown effort.' }, 'Unknown effort', false);
    if (expects('new', 'effort')) {
      flows.advance('review', { effort });
      return deliver({ html: 'Adversarial review of the change?', keyboard: reviewKeyboard(flows.seq()) });
    }
    if (expects('edit', 'value') && flow.data.field === 'effort') return deliver(await applyEditValue(deps, flows, flow, { effort }));
    return expired();
  }

  if (b.step === 'review') {
    const review = b.value === 'd' ? null : b.value === 'on';
    if (expects('new', 'review')) {
      flows.advance('autopub', { review });
      return deliver({ html: autoPublishPrompt(), keyboard: autoPublishKeyboard(flows.seq()) });
    }
    if (expects('edit', 'value') && flow.data.field === 'review') return deliver(await applyEditValue(deps, flows, flow, { review }));
    return expired();
  }

  if (b.step === 'autopub') {
    const autoPublish = b.value === 'on';
    if (expects('new', 'autopub')) {
      flows.advance('create', { autoPublish });
      return deliver({ html: summary(flow.data, autoPublish), keyboard: onCreateKeyboard(flows.seq()) });
    }
    if (expects('edit', 'value') && flow.data.field === 'autopublish') {
      return deliver(await applyEditValue(deps, flows, flow, { autoPublish }));
    }
    return expired();
  }

  if (b.step === 'create') {
    if (!expects('new', 'create')) return expired();
    return deliver(await finishNew(deps, flows, flow, b.value), 'Created');
  }

  if (b.step === 'field') {
    if (!expects('edit', 'field')) return expired();
    const field = EDIT_FIELDS.find((f) => f.id === b.value);
    if (!field) return deliver({ html: '⚠ Unknown field.' }, 'Unknown field', false);
    flows.advance('value', { field: field.id });
    if (field.free) {
      return deliver({
        html: `Send the new <b>${escapeHtml(field.label.toLowerCase())}</b> as one message.`,
        keyboard: { inline_keyboard: [CANCEL_ROW] },
      });
    }
    const keyboard =
      field.id === 'repo'
        ? repoKeyboard(await deps.storage.listRepos(), flows.seq())
        : field.id === 'model'
          ? modelKeyboard(flows.seq())
          : field.id === 'effort'
            ? effortKeyboard(flows.seq())
            : field.id === 'review'
              ? reviewKeyboard(flows.seq())
              : autoPublishKeyboard(flows.seq());
    return deliver({ html: `New <b>${escapeHtml(field.label.toLowerCase())}</b>?`, keyboard });
  }

  return expired();
}

function autoPublishPrompt(): string {
  return (
    'Auto-publish when the work finishes?\n\n' +
    '<i>On</i> skips both the review gate and the adversarial round — the same session commits and pushes.'
  );
}

function summary(d: FlowData, autoPublish: boolean): string {
  return [
    `<b>${escapeHtml(d.title ?? '')}</b>`,
    d.description ? escapeHtml(d.description.slice(0, 300)) + (d.description.length > 300 ? '…' : '') : '',
    ``,
    `model: <code>${escapeHtml(d.model ?? 'default')}</code> · effort: <code>${escapeHtml(d.effort ?? 'default')}</code>`,
    `review: <code>${d.review === null || d.review === undefined ? 'default' : d.review ? 'on' : 'off'}</code> · auto-publish: <code>${autoPublish ? 'on' : 'off'}</code>`,
    ``,
    `On create:`,
  ].join('\n');
}

// ---- terminal actions ---------------------------------------------------

async function finishDraft(deps: FlowDeps, flows: FlowStore, repoId: string): Promise<StepResult> {
  const flow = flows.get();
  if (!flow) return step({ html: '⏳ That step is no longer active.' }, false);
  flows.clear();
  const task = await createTask(
    { storage: deps.storage, orchestrator: deps.orchestrator },
    { title: flow.data.title ?? 'Untitled', description: flow.data.description ?? null, repoId, status: 'draft' },
    deps.actor,
  );
  return step({
    html: `📝 Draft <code>${short(task.id)}</code> created: <b>${escapeHtml(task.title)}</b>\n\n/edit ${short(task.id)} to set it up, /enqueue ${short(task.id)} to run it.`,
  });
}

async function finishNew(deps: FlowDeps, flows: FlowStore, flow: Flow, onCreate: string): Promise<StepResult> {
  const d = flow.data;
  flows.clear();
  const actionDeps = { storage: deps.storage, orchestrator: deps.orchestrator };
  const task = await createTask(
    actionDeps,
    {
      title: d.title ?? 'Untitled',
      description: d.description ?? null,
      repoId: d.repoId ?? null,
      status: 'draft',
      model: d.model ?? null,
      effort: d.effort ?? null,
      review: d.review ?? null,
      autoPublish: d.autoPublish ?? false,
    },
    deps.actor,
  );
  const head = `✅ <code>${short(task.id)}</code> <b>${escapeHtml(task.title)}</b>`;
  if (onCreate === 'draft') return step({ html: `${head}\nSaved as a draft.` });
  // Created as a draft either way, then moved: the create and the transition
  // are separate rows in the audit trail, which is what the web UI writes too.
  // The follow-on can be REFUSED (a repo-less task, a live session), and when
  // it is, `ok` has to say so — the task exists but the queue move did not
  // happen, and a toast reading "Created" over an audit row reading ok: true
  // would record a queueing that never took place.
  const r =
    onCreate === 'run'
      ? await runNowTask(actionDeps, task.id, deps.actor)
      : onCreate === 'custom'
        ? await queueAdd(actionDeps, task.id, deps.actor)
        : await enqueueTask(actionDeps, task.id, deps.actor);
  return step({ html: `${head}\n${r.ok ? '' : '⚠ '}${escapeHtml(r.text)}` }, r.ok);
}

/** /edit with a free-text value. */
async function applyEdit(deps: FlowDeps, flows: FlowStore, flow: Flow, text: string): Promise<StepResult | null> {
  const field = flow.data.field;
  if (field === 'title') return applyEditValue(deps, flows, flow, { title: text.slice(0, TITLE_MAX) });
  if (field === 'description') return applyEditValue(deps, flows, flow, { description: text });
  if (field === 'category') {
    const v = text.trim();
    if (v.length > 60) {
      // The flow stays on this step so a shorter one can follow — and this is
      // NOT a success, however friendly the sentence.
      return step({ html: '⚠ A category is at most 60 characters — nothing changed, send a shorter one.' }, false);
    }
    return applyEditValue(deps, flows, flow, { category: v === '-' ? null : v });
  }
  return null;
}

async function applyEditValue(deps: FlowDeps, flows: FlowStore, flow: Flow, patch: TaskEdit): Promise<StepResult> {
  const taskId = flow.data.taskId!;
  flows.clear();
  const r = await editTask({ storage: deps.storage, orchestrator: deps.orchestrator }, taskId, patch, deps.actor);
  const what = Object.keys(patch)[0];
  return step(
    { html: `${r.ok ? '✏️' : '⚠'} ${escapeHtml(r.text)}${r.ok ? ` (${escapeHtml(what)})` : ''}` },
    r.ok,
  );
}
