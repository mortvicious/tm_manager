import type { Question, QuestionItem, QuestionStatus, Run } from '@tm/shared';
import { broadcast, onEvent } from './events.ts';
import type { Storage } from './storage/types.ts';

// docs/questions.md — a worker's AskUserQuestion, carried to the human.
//
// The agent calls the CLI's own AskUserQuestion tool. A PreToolUse hook
// (worker.ts) forwards the call here and WAITS: the session sits inside the
// hook until a human answers from the SPA or the phone, and the hook hands
// the answers back as the tool's input, so the dialog is never drawn in the
// hidden terminal. One service, in-process, called by the internal route, the
// human route and the Telegram press alike — the row is the truth and the
// conditional pending→answered write is what stops two surfaces answering
// one question.

/** Bounds on what a hook may park here. Wider than the CLI's own schema
 *  (2-4 options, a 12-char header) on purpose: the CLI validated the call
 *  before the hook ran, and what it sent is handed back to it VERBATIM. */
const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 8;
const MAX_TEXT = 4000;
/** the whole `questions` array, serialised — the row's JSON column */
const MAX_JSON = 64_000;

/** Longest the internal route holds a request; the hook loops on `pending`. */
export const QUESTION_WAIT_CAP_MS = 60_000;

export type AnswerResult =
  | { ok: true; question: Question }
  | { ok: false; code: 400 | 404 | 409; error: string };

function str(v: unknown, max = MAX_TEXT): string | null {
  return typeof v === 'string' && v.trim() && v.length <= max ? v : null;
}

/**
 * Validate the hook's `tool_input.questions` and return the ORIGINAL objects
 * (never rebuilt or truncated): the answered input handed back to the tool
 * must be the input the CLI validated a moment ago, unknown fields included.
 * Anything malformed or oversized is refused, not trimmed.
 */
export function parseQuestions(input: unknown): QuestionItem[] | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_QUESTIONS) return null;
  for (const q of raw) {
    if (typeof q !== 'object' || q === null) return null;
    const o = q as Record<string, unknown>;
    if (!str(o.question)) return null;
    if (o.header !== undefined && (typeof o.header !== 'string' || o.header.length > 200)) return null;
    if (!Array.isArray(o.options) || o.options.length === 0 || o.options.length > MAX_OPTIONS) return null;
    for (const opt of o.options) {
      if (typeof opt !== 'object' || opt === null) return null;
      const p = opt as Record<string, unknown>;
      if (!str(p.label, 200)) return null;
      if (p.description !== undefined && (typeof p.description !== 'string' || p.description.length > MAX_TEXT)) return null;
    }
  }
  if (JSON.stringify(raw).length > MAX_JSON) return null;
  return raw as QuestionItem[];
}

/**
 * Validate a human's answers against the row: every question answered, each
 * a non-empty string. Free text is allowed (the CLI offers "Other" too), so
 * the value is not required to be one of the labels.
 */
export function parseAnswers(q: Question, input: unknown): Record<string, string> | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const item of q.questions) {
    const v = str(raw[item.question]);
    if (!v) return null;
    out[item.question] = v;
  }
  return out;
}

/**
 * What the PreToolUse hook prints for the CLI. `allow` + the original
 * questions with `answers` filled in is exactly what the tool's own dialog
 * would have produced, so the tool runs as if the human had answered in the
 * terminal. An expired question is a `deny` with the reason — the agent must
 * hear that nobody answered rather than get an empty allow.
 */
export function hookDecision(q: Question): Record<string, unknown> {
  if (q.status === 'answered' && q.answers) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: `Answered by the user via Task Manager (${q.answeredBy ?? 'human'})`,
        updatedInput: { questions: q.questions, answers: q.answers },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `This question was not answered (${q.note ?? 'expired'}). Do not ask again this turn: decide yourself, ` +
        'state the assumption in your summary, and continue.',
    },
  };
}

export class QuestionService {
  constructor(private readonly storage: Storage) {}

  /**
   * Park a hook's question. Idempotent on (run, tool_use_id): the hook re-sends
   * the same body every minute while it waits, and a second row for the same
   * call would page the human twice and leave one of them unanswerable.
   */
  async ask(run: Run, body: unknown): Promise<{ question: Question; created: boolean } | { error: string }> {
    if (!run.taskId) return { error: 'run has no task' };
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    // Required, not optional: it is the whole idempotency key. Without it every
    // minute's re-send would page the human again (review round 1).
    const toolUseId = typeof b.tool_use_id === 'string' && b.tool_use_id.length <= 200 ? b.tool_use_id : '';
    if (!toolUseId) return { error: 'tool_use_id is missing' };
    const find = async () => (await this.storage.listQuestions({ runId: run.id })).find((q) => q.toolUseId === toolUseId);
    const existing = await find();
    if (existing) return { question: existing, created: false };
    const questions = parseQuestions(b.tool_input);
    if (!questions) return { error: 'tool_input.questions is missing, malformed or oversized' };
    let question: Question;
    try {
      question = await this.storage.createQuestion({ taskId: run.taskId, runId: run.id, toolUseId, questions });
    } catch (e) {
      // two overlapping re-sends: the unique (run_id, tool_use_id) index let
      // exactly one in — return that one
      const raced = await find();
      if (!raced) throw e;
      return { question: raced, created: false };
    }
    await this.storage.appendEvent({
      kind: 'question.asked',
      actor: 'hook',
      runId: run.id,
      taskId: run.taskId,
      repoId: run.repoId,
      data: { questionId: question.id, questions: questions.map((q) => q.question) },
    });
    broadcast({ type: 'question.updated', question });
    return { question, created: true };
  }

  /**
   * The long-poll the hook sits on: resolves with the row as soon as it leaves
   * `pending` (answered or expired), or after `waitMs` with it still pending.
   * Same shape as the agent route's task poll — subscribe, time out,
   * unsubscribe on both paths — and re-read after subscribing so an answer
   * that landed between the caller's read and the subscription is not missed.
   */
  async wait(id: string, waitMs: number): Promise<Question | null> {
    const wait = Math.min(Math.max(Number(waitMs) || 0, 0), QUESTION_WAIT_CAP_MS);
    let q = await this.storage.getQuestion(id);
    if (!q || q.status !== 'pending' || wait === 0) return q;
    return new Promise<Question | null>((resolve) => {
      let done = false;
      const finish = (value: Question | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        resolve(value);
      };
      const timer = setTimeout(() => finish(q), wait);
      const off = onEvent((e) => {
        if (e.type === 'question.updated' && e.question.id === id) {
          q = e.question;
          if (q.status !== 'pending') finish(q);
        }
      });
      // the gap between the read above and the subscription
      void this.storage.getQuestion(id).then((fresh) => {
        if (fresh && fresh.status !== 'pending') finish(fresh);
      });
    });
  }

  /** A human's answer, from either surface. Conditional: second answers are refused, not merged. */
  async answer(id: string, input: unknown, actor: string): Promise<AnswerResult> {
    const q = await this.storage.getQuestion(id);
    if (!q) return { ok: false, code: 404, error: 'no such question' };
    if (q.status !== 'pending') {
      return {
        ok: false,
        code: 409,
        error:
          q.status === 'answered'
            ? `already answered${q.answeredBy ? ` (${q.answeredBy})` : ''}`
            : `expired${q.note ? `: ${q.note}` : ''}`,
      };
    }
    const answers = parseAnswers(q, input);
    if (!answers) return { ok: false, code: 400, error: 'every question needs a non-empty answer' };
    const updated = await this.storage.answerQuestion(id, answers, actor);
    if (!updated) return { ok: false, code: 409, error: 'already answered' };
    await this.storage.appendEvent({
      kind: 'question.answered',
      actor,
      runId: updated.runId,
      taskId: updated.taskId,
      data: { questionId: id, answers },
    });
    broadcast({ type: 'question.updated', question: updated });
    return { ok: true, question: updated };
  }

  /**
   * The run is over (exit, kill, cancel, Stop) — nothing will ever collect an
   * answer, so the human must stop being asked. Audited once per row.
   */
  async expireForRun(runId: string, note: string): Promise<Question[]> {
    return this.settleExpired(await this.storage.expireQuestions({ runId }, note), 'system');
  }

  async expireForTask(taskId: string, note: string, actor = 'system'): Promise<Question[]> {
    return this.settleExpired(await this.storage.expireQuestions({ taskId }, note), actor);
  }

  /** Boot: no hook survives a restart, so no pending row can be collected. */
  async expireAll(note: string): Promise<Question[]> {
    return this.settleExpired(await this.storage.expireQuestions({}, note), 'system');
  }

  private async settleExpired(rows: Question[], actor: string): Promise<Question[]> {
    for (const q of rows) {
      await this.storage.appendEvent({
        kind: 'question.expired',
        actor,
        runId: q.runId,
        taskId: q.taskId,
        data: { questionId: q.id, note: q.note },
      });
      broadcast({ type: 'question.updated', question: q });
    }
    return rows;
  }

  listPending(): Promise<Question[]> {
    return this.storage.listQuestions({ status: 'pending' });
  }

  list(f: { status?: QuestionStatus; taskId?: string }): Promise<Question[]> {
    return this.storage.listQuestions(f);
  }

  get(id: string): Promise<Question | null> {
    return this.storage.getQuestion(id);
  }
}
