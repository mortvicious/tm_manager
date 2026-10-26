import { AUTOPILOT_ACTOR, isExternalTask, questionWaitedMinutes, type Question, type QuestionItem } from '@tm/shared';
import type { QuestionService } from './questions.ts';
import type { Storage } from './storage/types.ts';

// docs/questions.md § Autopilot — an opt-in, per-repo answer to a worker's
// question nobody answered: after the repo's minutes the server picks the
// question's one "(Recommended)" option, the way the human did on about 70%
// of the eligible calls. It is the exception to "no timeout on the human"
// (decisions.md 2026-10-26), so everything here fails CLOSED: any doubt about
// a question (its shape, its topic, its run) leaves it pending for the human.
//
// Stateless on purpose: the clock is the row's `created_at`, a pick is the
// ordinary conditional `answer()` (first wins, a later human gets 409), and
// boot already expires every pending row — there is nothing to recover. The
// only memory is which ineligible rows were already audited.

const RECOMMENDED = /\(recommended\)/i;

/**
 * Topics the server never answers, matched against EVERY text of the call
 * (question, header, option labels and descriptions, previews). Word STARTS,
 * so "pushed", "deployment", "migrations" are caught too; over-matching only
 * leaves a question for the human, which is the safe direction.
 */
const EXCLUDED: { reason: string; re: RegExp }[] = [
  // shipping: the Recommended push is often "push all of main", which ships
  // OTHER tasks' commits (feasibility § 4: 102 of 259 calls)
  { reason: 'ship', re: /\b(push|deploy|publish|releas|merg|ship|rollout|roll out|go live|upload)/i },
  // credentials
  { reason: 'secret', re: /\b(secret|credential|token|key|passw|passphrase|api[ -]?key|auth|login|ssh|cert)|\.env\b|\benv\b/i },
  // destructive / irreversible / production
  {
    reason: 'destructive',
    re: /\b(delet|drop|force|reset|migrat|irreversib|destroy|wipe|purge|truncat|overwrit|rm -|kill|restart|rollback|roll back|downgrad|uninstall)|\bprod(uction)?\b/i,
  },
  // outward-facing or money
  { reason: 'outward', re: /\b(email|e-mail|sms|notify (the )?(users|customers)|billing|payment|invoice|refund|charge|pay\b|purchas|subscri)/i },
  // visual variants: the human picks those by looking
  {
    reason: 'visual',
    re: /\b(mock-?ups?|variant|visual|layout|design|look|style|colou?r|theme|screenshot|font|icon|animation|ui option)|\.(png|jpe?g|gif|webp|svg|avif|heic|bmp|pdf)\b/i,
  },
];

export type AutopilotPick = { ok: true; answers: Record<string, string>; labels: string[] } | { ok: false; reason: string };

/**
 * The answers the autopilot would give, or why it must not. Eligible only
 * when EVERY part is single-select with exactly one option labelled
 * "(Recommended)", no option carries a `preview`, the question texts are
 * distinct (answers are keyed by text), and no text names an excluded topic.
 * The value is the Recommended label VERBATIM — what the dialog would write.
 */
export function autopilotPick(items: QuestionItem[]): AutopilotPick {
  if (!Array.isArray(items) || items.length === 0) return { ok: false, reason: 'no questions' };
  const answers: Record<string, string> = {};
  const labels: string[] = [];
  for (const item of items) {
    // the CLI's default is single-select; anything but absent/false is doubt
    if (item.multiSelect !== undefined && item.multiSelect !== false) return { ok: false, reason: 'multiSelect' };
    if (Object.prototype.hasOwnProperty.call(answers, item.question)) return { ok: false, reason: 'duplicate question text' };
    const options = Array.isArray(item.options) ? item.options : [];
    if (options.some((o) => o && typeof o === 'object' && 'preview' in o)) return { ok: false, reason: 'preview' };
    const recommended = options.filter((o) => typeof o?.label === 'string' && RECOMMENDED.test(o.label));
    if (recommended.length !== 1) return { ok: false, reason: recommended.length ? 'several recommended' : 'no recommended' };
    const text = [
      item.question,
      item.header,
      ...options.flatMap((o) => [o?.label, o?.description]),
    ]
      .filter((t): t is string => typeof t === 'string')
      .join('\n');
    const hit = EXCLUDED.find((x) => x.re.test(text));
    if (hit) return { ok: false, reason: hit.reason };
    answers[item.question] = recommended[0].label;
    labels.push(recommended[0].label);
  }
  return { ok: true, answers, labels };
}

/** What `hookDecision` tells the agent after an autopilot pick. */
export function autopilotReason(q: Question): string {
  const waitedMin = questionWaitedMinutes(q);
  const picks = q.questions.map((item) => `'${q.answers?.[item.question] ?? ''}'`).join(', ');
  return (
    `No one answered within ${waitedMin ?? 'the configured number of'} min; the server picked your ` +
    `recommended option${q.questions.length > 1 ? 's' : ''} ${picks}. State this assumption in your summary.`
  );
}

export interface AutopilotDeps {
  storage: Storage;
  questions: QuestionService;
  /** the run's PTY exists, has not exited and is not idle */
  sessionWorking(runId: string): boolean;
}

export class QuestionAutopilot {
  /** pending rows already audited as ineligible — memory only (a restart expires them all anyway) */
  private noted = new Set<string>();
  private sweeping = false;

  constructor(private readonly deps: AutopilotDeps) {}

  /**
   * One pass: answer every eligible pending question that has waited its
   * repo's minutes. Returns the rows it answered. Never throws (timer-safe).
   */
  async sweep(nowMs = Date.now()): Promise<Question[]> {
    if (this.sweeping) return [];
    this.sweeping = true;
    try {
      return await this.pass(nowMs);
    } catch (e) {
      console.warn('question autopilot: sweep failed:', e instanceof Error ? e.message : e);
      return [];
    } finally {
      this.sweeping = false;
    }
  }

  private async pass(nowMs: number): Promise<Question[]> {
    const { storage, questions } = this.deps;
    const pending = await questions.listPending();
    const ids = new Set(pending.map((q) => q.id));
    for (const id of this.noted) if (!ids.has(id)) this.noted.delete(id);
    if (pending.length === 0) return [];
    // Pause all stops every automatic action; the turns it cut expire their
    // questions on the way down, so this is only the window before that.
    if ((await storage.getSettings())['orchestrator.paused'] === true) return [];

    const answered: Question[] = [];
    for (const q of pending) {
      const waitedMs = nowMs - Date.parse(q.createdAt);
      if (!Number.isFinite(waitedMs)) continue;
      const task = await storage.getTask(q.taskId);
      if (!task || task.status !== 'running' || isExternalTask(task)) continue;
      const repo = task.repoId ? await storage.getRepo(task.repoId) : null;
      const minutes = repo?.questionAutopilotMinutes ?? null;
      if (!minutes || waitedMs < minutes * 60_000) continue;
      const run = await storage.getRun(q.runId);
      if (!run || run.status !== 'running' || run.idle || run.taskId !== task.id) continue;
      if (!this.deps.sessionWorking(run.id)) continue;

      const pick = autopilotPick(q.questions);
      if (!pick.ok) {
        if (!this.noted.has(q.id)) {
          this.noted.add(q.id);
          await storage.appendEvent({
            kind: 'question.autopilot',
            actor: AUTOPILOT_ACTOR,
            runId: q.runId,
            taskId: q.taskId,
            data: { questionId: q.id, action: 'skipped', reason: pick.reason, waitedMs },
          });
        }
        continue;
      }
      const r = await questions.answer(q.id, pick.answers, AUTOPILOT_ACTOR, { policy: 'autopilot', waitedMs, minutes });
      if (r.ok) answered.push(r.question);
    }
    return answered;
  }
}
