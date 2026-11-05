import { z } from 'zod';
import type { FeaturePlan, FeaturePlanTask, PlanFinding, PlanResolution, PlanReviewRound } from '@tm/shared';
import { AGENT_TITLE_MAX } from '@tm/shared';
import { planTaskSchema } from './feature-plan.ts';

// Fix rounds of the Feature plan loop (docs/features.md § Fix rounds). After
// the first full plan + review, a re-plan no longer rewrites the plan: the
// planner returns EDITS for the numbered blocker/major findings only, the
// server applies them (untouched cards stay byte-identical, ids kept, human
// edits survive), and the reviewer judges each numbered finding resolved or not
// plus only what the edits changed. A fresh rewrite + fresh review every round
// fixed each round's findings and found an entirely new set each time
// (feature 0e323bef, rounds 3–5) — the same lesson as the diff review's
// converging fix rounds (decisions.md 2026-10-26).

/** New minors a fix-round reviewer may raise (the diff review's FIX_ROUND_MAX_MINORS). */
export const PLAN_FIX_MAX_MINORS = 3;

const ref = z.string().min(1).max(64);
const reason = z.string().min(1).max(2000);
/** a phase: its 1-based number in the plan AS SENT, or the `id` of a phase added this round */
const phaseRef = z.union([z.number().int().min(1).max(20), ref]);
/** where in the target phase: after this card, `"start"`, or null/absent = at the end */
const after = ref.nullish();

const taskFields = planTaskSchema.omit({ dependsOn: true }).extend({ dependsOn: z.array(ref).max(12).nullish() });

export const planEditSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('update'), card: ref, set: taskFields.partial(), reason }),
  z.object({ op: z.literal('add'), id: ref, phase: phaseRef, after, task: taskFields, reason }),
  z.object({ op: z.literal('remove'), card: ref, reason }),
  z.object({ op: z.literal('move'), card: ref, phase: phaseRef, after, reason }),
  z.object({
    op: z.literal('add-phase'),
    id: ref,
    /** insert after this phase (1-based number as sent, or an added phase's id); 0 = first */
    after: z.union([z.number().int().min(0).max(20), ref]),
    title: z.string().min(1).max(200),
    goal: z.string().min(1).max(2000),
    reason,
  }),
  z.object({
    op: z.literal('edit-phase'),
    phase: phaseRef,
    title: z.string().min(1).max(200).nullish(),
    goal: z.string().min(1).max(2000).nullish(),
    reason,
  }),
]);
export type PlanEdit = z.infer<typeof planEditSchema>;

export const planFixSchema = z.object({
  edits: z.array(planEditSchema).max(80),
  /** replaces the plan's summary/considerations only when given */
  summary: z.string().min(1).max(8000).nullish(),
  considerations: z.array(z.string().min(1).max(2000)).max(20).nullish(),
  /** per finding: how it was fixed, or why the planner thinks it is wrong (the reviewer judges) */
  notes: z.array(z.object({ finding: z.number().int().min(1), note: z.string().min(1).max(2000) })).max(60),
});
export type PlanFix = z.infer<typeof planFixSchema>;

const TASK_FIELDS_JSON = {
  title: { type: 'string' },
  description: { type: 'string' },
  category: { type: ['string', 'null'] },
  effort: { type: ['string', 'null'], enum: ['low', 'medium', 'high', 'xhigh', 'max', null] },
  review: { type: ['boolean', 'null'] },
  exitCriteria: { type: ['array', 'null'], maxItems: 12, items: { type: 'string' } },
  dependsOn: { type: ['array', 'null'], maxItems: 12, items: { type: 'string' } },
  repoId: { type: ['string', 'null'] },
};
const PHASE_REF_JSON = { type: ['integer', 'string'] };

export const PLAN_FIX_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    edits: {
      type: 'array',
      maxItems: 80,
      items: {
        oneOf: [
          { type: 'object', properties: { op: { const: 'update' }, card: { type: 'string' }, set: { type: 'object', properties: TASK_FIELDS_JSON }, reason: { type: 'string' } }, required: ['op', 'card', 'set', 'reason'] },
          { type: 'object', properties: { op: { const: 'add' }, id: { type: 'string' }, phase: PHASE_REF_JSON, after: { type: ['string', 'null'] }, task: { type: 'object', properties: TASK_FIELDS_JSON, required: ['title', 'description', 'exitCriteria'] }, reason: { type: 'string' } }, required: ['op', 'id', 'phase', 'task', 'reason'] },
          { type: 'object', properties: { op: { const: 'remove' }, card: { type: 'string' }, reason: { type: 'string' } }, required: ['op', 'card', 'reason'] },
          { type: 'object', properties: { op: { const: 'move' }, card: { type: 'string' }, phase: PHASE_REF_JSON, after: { type: ['string', 'null'] }, reason: { type: 'string' } }, required: ['op', 'card', 'phase', 'reason'] },
          { type: 'object', properties: { op: { const: 'add-phase' }, id: { type: 'string' }, after: PHASE_REF_JSON, title: { type: 'string' }, goal: { type: 'string' }, reason: { type: 'string' } }, required: ['op', 'id', 'after', 'title', 'goal', 'reason'] },
          { type: 'object', properties: { op: { const: 'edit-phase' }, phase: PHASE_REF_JSON, title: { type: ['string', 'null'] }, goal: { type: ['string', 'null'] }, reason: { type: 'string' } }, required: ['op', 'phase', 'reason'] },
        ],
      },
    },
    summary: { type: ['string', 'null'] },
    considerations: { type: ['array', 'null'], items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'object', properties: { finding: { type: 'integer' }, note: { type: 'string' } }, required: ['finding', 'note'] } },
  },
  required: ['edits', 'notes'],
});

export const planFixReviewSchema = z.object({
  /** one entry per numbered previous finding */
  previous: z
    .array(z.object({ id: z.number().int().min(1), status: z.enum(['resolved', 'unresolved']), note: z.string().max(2000).nullish() }))
    .max(60),
  findings: z
    .array(
      z.object({
        severity: z.enum(['blocker', 'major', 'minor']),
        summary: z.string().min(1).max(2000),
        detail: z.string().max(4000).nullish(),
      }),
    )
    .max(30),
});
export type PlanFixReview = z.infer<typeof planFixReviewSchema>;

export const PLAN_FIX_REVIEW_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    previous: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, status: { type: 'string', enum: ['resolved', 'unresolved'] }, note: { type: ['string', 'null'] } },
        required: ['id', 'status'],
      },
    },
    findings: {
      type: 'array',
      maxItems: 30,
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          summary: { type: 'string' },
          detail: { type: ['string', 'null'] },
        },
        required: ['severity', 'summary'],
      },
    },
  },
  required: ['previous', 'findings'],
});

/**
 * Short, unique labels for the plan's cards (an id prefix, 8 chars, longer on a
 * collision) — what the planner and the reviewer read and reference.
 */
export function cardLabels(plan: FeaturePlan): Map<string, string> {
  const ids = plan.phases.flatMap((p) => p.tasks.map((t) => t.id));
  for (let n = 8; n < 64; n += 4) {
    const labels = ids.map((id) => id.replace(/-/g, '').slice(0, n));
    if (new Set(labels).size === labels.length) return new Map(ids.map((id, i) => [id, labels[i]]));
  }
  return new Map(ids.map((id) => [id, id]));
}

/** The plan as the planner/reviewer of a fix round read it: phases numbered, cards labelled, deps as labels. */
export function renderPlanForFix(plan: FeaturePlan, labels = cardLabels(plan)): string {
  return JSON.stringify(
    {
      summary: plan.summary,
      considerations: plan.considerations,
      phases: plan.phases.map((p, pi) => ({
        phase: pi + 1,
        title: p.title,
        goal: p.goal,
        tasks: p.tasks.map((t) => ({
          card: labels.get(t.id) ?? t.id,
          title: t.title,
          description: t.description,
          category: t.category ?? null,
          effort: t.effort ?? null,
          review: t.review ?? null,
          exitCriteria: t.exitCriteria,
          dependsOn: (t.dependsOn ?? []).map((d) => labels.get(d) ?? d),
          ...(t.repoId ? { repoId: t.repoId } : {}),
          ...(t.excluded ? { excluded: true } : {}),
        })),
      })),
    },
    null,
    1,
  );
}

export type ApplyResult =
  | {
      ok: true;
      plan: FeaturePlan;
      changed: string[];
      removed: string[];
      log: string[];
      /** card id → the label the planner used (its own id for an added card) — what the reviewer reads */
      labels: Map<string, string>;
    }
  | { ok: false; error: string };

/** The editor's limits (routes/features.ts planBody) — a fix may not grow a plan past them or past where it already is. */
const MAX_PHASES = 10;
const MAX_TASKS_PER_PHASE = 20;

/**
 * Applies a fix round's edits to the plan. Pure; never mutates `plan`. Every
 * reference is checked and a bad one fails the WHOLE result with a message the
 * aux runner types back as a correction (so the planner fixes its own refs).
 * Only what THIS round touched is held to the rules (titles, dependency order):
 * an untouched card may carry a human's edit the approval surface allows — a
 * long title, a dependency the human moved below it or deleted — and failing
 * the planner over a card it was told not to touch would loop on corrections.
 * Such a dependency is dropped here, exactly as approval would drop it.
 * `null` in an update's `set` means "unchanged" (models send it for fields they
 * leave alone).
 */
export function applyPlanEdits(plan: FeaturePlan, fix: PlanFix, newId: () => string): ApplyResult {
  const labels = cardLabels(plan);
  type Card = FeaturePlanTask & { depRefs?: string[] };
  type Phase = { key: string; title: string; goal: string; tasks: Card[] };
  const phases: Phase[] = plan.phases.map((p, i) => ({
    key: `#${i + 1}`,
    title: p.title,
    goal: p.goal,
    tasks: p.tasks.map((t) => structuredClone(t)),
  }));
  const byRef = new Map<string, Card>();
  for (const p of phases) for (const t of p.tasks) byRef.set(labels.get(t.id)!, t);
  const changed = new Set<string>();
  const removed: string[] = [];
  const log: string[] = [];
  /** anchor phase key → the phase last inserted right after it (so p1, p2 both "after 1" keep their order) */
  const insertedAfter = new Map<string, string>();
  const fail = (i: number, msg: string): ApplyResult => ({ ok: false, error: `edit ${i + 1}: ${msg}` });

  const phaseKey = (r: number | string): string => {
    if (typeof r === 'number') return `#${r}`;
    return /^\s*\d+\s*$/.test(r) ? `#${Number(r)}` : r; // "2" is phase 2
  };
  const findPhase = (r: number | string): Phase | undefined => phases.find((p) => p.key === phaseKey(r));
  const phaseOf = (c: Card) => phases.find((p) => p.tasks.includes(c));
  const place = (phase: Phase, card: Card, at: string | null | undefined): string | null => {
    if (at == null) phase.tasks.push(card);
    else if (at === 'start') phase.tasks.unshift(card);
    else {
      const anchor = byRef.get(at);
      const idx = anchor ? phase.tasks.indexOf(anchor) : -1;
      if (idx < 0) return `"after": ${JSON.stringify(at)} is not a card of that phase`;
      phase.tasks.splice(idx + 1, 0, card);
    }
    return null;
  };
  const describe = (c: Card) => `${labels.get(c.id) ?? c.id} "${c.title}"`;

  for (const [i, e] of fix.edits.entries()) {
    switch (e.op) {
      case 'update': {
        const c = byRef.get(e.card);
        if (!c) return fail(i, `no card ${JSON.stringify(e.card)}`);
        const { dependsOn, ...rest } = e.set;
        const set = Object.entries(rest).filter(([, v]) => v !== undefined && v !== null);
        for (const [k, v] of set) (c as unknown as Record<string, unknown>)[k] = v;
        if (dependsOn != null) c.depRefs = dependsOn;
        changed.add(c.id);
        const fields = [...set.map(([k]) => k), ...(dependsOn != null ? ['dependsOn'] : [])];
        log.push(`updated ${describe(c)} (${fields.join(', ') || 'nothing'}): ${e.reason}`);
        break;
      }
      case 'add': {
        if (byRef.has(e.id)) return fail(i, `id ${JSON.stringify(e.id)} is already taken`);
        const phase = findPhase(e.phase);
        if (!phase) return fail(i, `no phase ${JSON.stringify(e.phase)}`);
        const { dependsOn, ...task } = e.task;
        const c: Card = {
          id: newId(),
          title: task.title,
          description: task.description,
          category: task.category ?? null,
          effort: task.effort ?? null,
          review: task.review ?? null,
          exitCriteria: task.exitCriteria ?? [],
          dependsOn: [],
          ...(task.repoId ? { repoId: task.repoId } : {}),
          excluded: false,
          depRefs: dependsOn ?? [],
        };
        const err = place(phase, c, e.after);
        if (err) return fail(i, err);
        byRef.set(e.id, c);
        labels.set(c.id, e.id);
        changed.add(c.id);
        log.push(`added ${describe(c)} to phase "${phase.title}": ${e.reason}`);
        break;
      }
      case 'remove': {
        const c = byRef.get(e.card);
        const phase = c && phaseOf(c);
        if (!c || !phase) return fail(i, `no card ${JSON.stringify(e.card)}`);
        phase.tasks.splice(phase.tasks.indexOf(c), 1);
        byRef.delete(e.card);
        removed.push(c.id);
        changed.delete(c.id);
        log.push(`removed ${describe(c)}: ${e.reason}`);
        break;
      }
      case 'move': {
        const c = byRef.get(e.card);
        const from = c && phaseOf(c);
        if (!c || !from) return fail(i, `no card ${JSON.stringify(e.card)}`);
        const to = findPhase(e.phase);
        if (!to) return fail(i, `no phase ${JSON.stringify(e.phase)}`);
        if (e.after === e.card) return fail(i, 'a card cannot be placed after itself');
        from.tasks.splice(from.tasks.indexOf(c), 1);
        const err = place(to, c, e.after);
        if (err) return fail(i, err);
        changed.add(c.id);
        log.push(`moved ${describe(c)} to phase "${to.title}": ${e.reason}`);
        break;
      }
      case 'add-phase': {
        if (findPhase(e.id) || /^\s*\d+\s*$/.test(e.id)) return fail(i, `phase id ${JSON.stringify(e.id)} is taken (use a non-numeric id, e.g. p1)`);
        let anchorKey = '#0';
        if (e.after !== 0 && e.after !== '0') {
          const anchor = findPhase(e.after);
          if (!anchor) return fail(i, `no phase ${JSON.stringify(e.after)}`);
          anchorKey = anchor.key;
        }
        const behind = insertedAfter.get(anchorKey) ?? anchorKey;
        const idx = behind === '#0' ? 0 : phases.findIndex((p) => p.key === behind) + 1;
        phases.splice(idx, 0, { key: e.id, title: e.title, goal: e.goal, tasks: [] });
        insertedAfter.set(anchorKey, e.id);
        log.push(`added phase "${e.title}": ${e.reason}`);
        break;
      }
      case 'edit-phase': {
        const p = findPhase(e.phase);
        if (!p) return fail(i, `no phase ${JSON.stringify(e.phase)}`);
        if (e.title) p.title = e.title;
        if (e.goal) p.goal = e.goal;
        log.push(`edited phase "${p.title}": ${e.reason}`);
        break;
      }
    }
  }

  // An empty phase this round EMPTIED is dropped; one a human left empty stays.
  const kept = phases.filter((p) => p.tasks.length > 0 || (p.key.startsWith('#') && plan.phases[Number(p.key.slice(1)) - 1]?.tasks.length === 0));
  if (!kept.some((p) => p.tasks.length > 0)) return { ok: false, error: 'the edits would leave the plan with no tasks' };
  if (kept.length > Math.max(MAX_PHASES, plan.phases.length)) return { ok: false, error: `the plan would have ${kept.length} phases (max ${MAX_PHASES})` };
  const crowded = kept.find(
    (p) => p.tasks.length > MAX_TASKS_PER_PHASE && p.tasks.some((t) => changed.has(t.id)),
  );
  if (crowded) return { ok: false, error: `phase "${crowded.title}" would have ${crowded.tasks.length} tasks (max ${MAX_TASKS_PER_PHASE})` };
  const tooLong = kept.flatMap((p) => p.tasks).find((t) => changed.has(t.id) && t.title.length > AGENT_TITLE_MAX);
  if (tooLong) return { ok: false, error: `card title longer than ${AGENT_TITLE_MAX} chars: "${tooLong.title}"` };

  // Dependencies: resolve the refs this round set (strict), then every edge must
  // point at an EARLIER card — strictly for cards this round touched, dropped
  // silently for untouched ones (approval drops the same edges).
  const order = kept.flatMap((p) => p.tasks);
  const pos = new Map(order.map((t, i) => [t.id, i]));
  const removedLabels = new Set(removed.map((id) => labels.get(id)));
  for (const c of order) {
    if (c.depRefs) {
      const ids: string[] = [];
      for (const r of c.depRefs) {
        const target = byRef.get(r);
        if (!target) {
          if (removedLabels.has(r)) continue;
          return { ok: false, error: `card ${describe(c)} dependsOn ${JSON.stringify(r)}, which is no card` };
        }
        ids.push(target.id);
      }
      c.dependsOn = [...new Set(ids)];
      delete c.depRefs;
    }
    const strict = changed.has(c.id);
    const deps: string[] = [];
    for (const d of c.dependsOn ?? []) {
      const at = pos.get(d);
      const earlier = at !== undefined && at < pos.get(c.id)!;
      if (earlier) deps.push(d);
      else if (strict && at !== undefined) {
        return { ok: false, error: `card ${describe(c)} depends on ${describe(order[at])}, which is not EARLIER in the plan` };
      }
      // a missing target (removed, or deleted by a human) or an untouched card's forward edge: dropped
    }
    c.dependsOn = deps;
  }
  // a moved card can turn an UNTOUCHED card's edge onto it forward: that edge is the edit's doing — strict
  const original = plan.phases.flatMap((p) => p.tasks);
  const originalPos = new Map(original.map((t, i) => [t.id, i]));
  for (const c of order) {
    if (changed.has(c.id)) continue;
    const before = (original.find((t) => t.id === c.id)?.dependsOn ?? []).filter(
      (d) => (originalPos.get(d) ?? Infinity) < originalPos.get(c.id)!, // only edges that WERE valid
    );
    const lost = before.find((d) => !c.dependsOn?.includes(d) && changed.has(d) && pos.has(d));
    if (lost) {
      return { ok: false, error: `moving ${describe(order[pos.get(lost)!])} puts it after ${describe(c)}, which depends on it — move that card too, or update its dependsOn` };
    }
  }

  return {
    ok: true,
    plan: {
      summary: fix.summary ?? plan.summary,
      considerations: fix.considerations ?? plan.considerations,
      phases: kept.map((p) => ({ title: p.title, goal: p.goal, tasks: p.tasks })),
    },
    changed: [...changed].filter((id) => pos.has(id)),
    removed,
    log,
    labels,
  };
}

/** `schema` for the aux runner: zod-validates the edits AND applies them, so a bad ref is typed back as a correction. */
export function planFixAcceptor(plan: FeaturePlan, newId: () => string) {
  return {
    safeParse(v: unknown): { success: true; data: { fix: PlanFix; applied: Extract<ApplyResult, { ok: true }> } } | { success: false; error: { message: string } } {
      const parsed = planFixSchema.safeParse(v);
      if (!parsed.success) return { success: false, error: { message: parsed.error.message } };
      const applied = applyPlanEdits(plan, parsed.data, newId);
      if (!applied.ok) return { success: false, error: { message: applied.error } };
      return { success: true, data: { fix: parsed.data, applied } };
    },
  };
}

function numbered(findings: PlanFinding[]): string[] {
  return findings.map((f, i) => `F${i + 1} [${f.severity}] ${f.summary}${f.detail ? ` — ${f.detail}` : ''}`);
}

export function buildPlanFixPrompt(opts: {
  repoName: string;
  repoPath: string;
  title: string;
  request: string;
  plan: FeaturePlan;
  findings: PlanFinding[];
  note?: string | null;
}): string {
  const lines = [
    `You are the planning agent of a task manager, in a FIX ROUND. The phased plan below (repo "${opts.repoName}"`,
    `at ${opts.repoPath}) was reviewed adversarially. Fix ONLY the numbered findings. Do not rewrite, reword,`,
    `reorganise or "improve" anything a finding does not require: every card you do not edit is kept exactly`,
    `as it is, and was already reviewed. Explore the repository READ-ONLY as needed to fix a finding correctly.`,
    ``,
    `--- the request ---`,
    opts.title,
    ``,
    opts.request,
    `--- end of request ---`,
    ``,
    `--- the current plan (phases numbered from 1; every card has a "card" label) ---`,
    renderPlanForFix(opts.plan),
    `--- end of plan ---`,
    ``,
    `--- findings to fix ---`,
    ...numbered(opts.findings),
    `--- end of findings ---`,
    ``,
    `Return EDITS, applied in order by the server:`,
    `- {"op":"update","card":"<label>","set":{...only the fields you change...},"reason"} — fields (omit or null = unchanged): title (one line,`,
    `  at most ${AGENT_TITLE_MAX} chars), description, category, effort, review, exitCriteria, dependsOn (the WHOLE new list,`,
    `  as card labels). Edit a description by sending the full new text.`,
    `- {"op":"add","id":"<new label, e.g. n1>","phase":<number or added phase id>,"after":"<label>"|"start"|null,"task":{title,`,
    `  description, exitCriteria, category?, effort?, review?, dependsOn?},"reason"} — null "after" = end of the phase.`,
    `- {"op":"remove","card":"<label>","reason"} · {"op":"move","card","phase","after","reason"}`,
    `- {"op":"add-phase","id":"<new id, e.g. p1>","after":<phase number, 0 = first, or added phase id>,"title","goal","reason"}`,
    `  · {"op":"edit-phase","phase","title"?,"goal"?,"reason"}`,
    `Phase numbers and labels refer to the plan AS SENT above; a card or phase you add is referenced by its new id.`,
    `A dependsOn may only name an EARLIER card (same phase above it, or an earlier phase). A phase left empty is dropped.`,
    `Split a too-large task by updating it and adding the rest as new cards. "summary"/"considerations" replace`,
    `the plan's only when you send them.`,
    `"notes": one entry per finding — how you fixed it, or, if you are sure a finding is wrong, why (the reviewer`,
    `judges that). Rules: do NOT write any files. Do not spawn more than 3 subagents.`,
  ];
  if (opts.note) {
    lines.push(
      ``,
      `Additional instruction from the user for this round — follow it, even where it needs edits beyond the`,
      `findings (say which edits it caused in their "reason"):`,
      opts.note,
    );
  }
  return lines.join('\n');
}

export function buildPlanFixReviewPrompt(opts: {
  repoName: string;
  title: string;
  request: string;
  plan: FeaturePlan;
  findings: PlanFinding[];
  notes: PlanFix['notes'];
  log: string[];
  changed: string[];
  /** the labels the planner used (applyPlanEdits' `labels`), so the edit log and the plan name a card alike */
  labels?: Map<string, string>;
}): string {
  const labels = opts.labels ?? cardLabels(opts.plan);
  return [
    `You are the adversarial PLAN reviewer for repo "${opts.repoName}", in a FIX ROUND. An earlier review raised the`,
    `numbered findings below; the planner has EDITED the plan to address them (it did not rewrite it).`,
    ``,
    `--- the request ---`,
    opts.title,
    ``,
    opts.request,
    `--- end of request ---`,
    ``,
    `--- the current plan, after the edits ---`,
    renderPlanForFix(opts.plan, labels),
    `--- end of plan ---`,
    ``,
    `--- the findings this round had to fix ---`,
    ...numbered(opts.findings),
    `--- end of findings ---`,
    ``,
    `The planner's notes: ${opts.notes.length ? '' : '(none)'}`,
    ...opts.notes.map((n) => `- F${n.finding}: ${n.note}`),
    ``,
    `The edits applied this round:`,
    ...(opts.log.length ? opts.log.map((l) => `- ${l}`) : ['- (none)']),
    `Cards changed or added this round: ${opts.changed.map((id) => labels.get(id) ?? id).join(', ') || '(none)'}`,
    ``,
    `Your job, reading the repository (CLAUDE.md, docs/, the code) as needed:`,
    `1. "previous": for EVERY numbered finding, {"id": <n>, "status": "resolved"|"unresolved", "note"}. Resolved means`,
    `   the CURRENT plan no longer has the problem (a sound rebuttal in the planner's notes also counts).`,
    `2. "findings": NEW problems only — in the changed/added cards, or caused by this round's edits elsewhere`,
    `   (a broken dependency, a contradiction with an untouched card). Untouched cards were reviewed in earlier`,
    `   rounds: do not re-review them for majors or minors; raise one only if it is a BLOCKER you are certain of.`,
    `   At most ${PLAN_FIX_MAX_MINORS} minors. Do not restate a numbered finding as a new one.`,
    `Do NOT rubber-stamp, and do not invent problems to look thorough. Do not write any files. Do not spawn more`,
    `than 3 subagents. Return via the structured schema.`,
  ].join('\n');
}

/**
 * The round a fix review produces: every handed-over finding the reviewer did
 * not mark resolved (missing = unresolved — fails closed) stays open, plus the
 * new findings (all blockers/majors, the first PLAN_FIX_MAX_MINORS minors).
 * The verdict is derived, never the reviewer's word.
 */
export function mergePlanFixRound(
  handedOver: PlanFinding[],
  review: PlanFixReview,
  meta: { round: number; model: string; at: string; edits: string[] },
): PlanReviewRound {
  const status = new Map(review.previous.map((p) => [p.id, p]));
  const resolutions: PlanResolution[] = handedOver.map((f, i) => {
    const s = status.get(i + 1);
    return { summary: f.summary, severity: f.severity, status: s?.status === 'resolved' ? 'resolved' : 'unresolved', note: s?.note ?? (s ? null : 'not answered by the reviewer') };
  });
  const carried: PlanFinding[] = handedOver.flatMap((f, i) => {
    const r = resolutions[i];
    if (r.status === 'resolved') return [];
    return [{ ...f, detail: [f.detail, r.note ? `still open: ${r.note}` : 'still open'].filter(Boolean).join(' — ') }];
  });
  const fresh = review.findings.map((f) => ({ severity: f.severity, summary: f.summary, detail: f.detail ?? null }));
  const minors = fresh.filter((f) => f.severity === 'minor').slice(0, PLAN_FIX_MAX_MINORS);
  const findings = [...carried, ...fresh.filter((f) => f.severity !== 'minor'), ...minors];
  const order = { blocker: 0, major: 1, minor: 2 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const verdict = findings.some((f) => f.severity === 'blocker') ? 'blocker' : findings.length ? 'minor' : 'clean';
  return { round: meta.round, verdict, findings, model: meta.model, at: meta.at, mode: 'fix', resolutions, edits: meta.edits };
}
