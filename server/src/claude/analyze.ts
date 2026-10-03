import { z } from 'zod';
import type { Repo, Task } from '@tm/shared';
import { broadcast } from '../events.ts';
import { READ_ONLY_DISALLOWED, READ_ONLY_TOOLS, acceptJson, aux, resultInstruction } from './aux.ts';
import type { Storage } from '../storage/types.ts';

// Structured output contract for the analysis agent.
const proposalSchema = z.object({
  categories: z
    .array(z.object({ taskId: z.string(), category: z.string().min(1).max(60) }))
    .max(50)
    .nullish(),
  proposals: z
    .array(
      z.object({
        kind: z.enum(['rewrite', 'split', 'new_task', 'solution_options']),
        targetTaskId: z.string().nullish(),
        title: z.string().nullish(),
        description: z.string().nullish(),
        rationale: z.string(),
        subtasks: z.array(z.object({ title: z.string(), description: z.string() })).nullish(),
        options: z
          .array(z.object({ label: z.string(), approach: z.string(), tradeoffs: z.string() }))
          .nullish(),
      }),
    )
    .max(20),
});

// Hand-written JSON Schema for --json-schema (kept in sync with the zod shape).
const JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    categories: {
      type: ['array', 'null'],
      maxItems: 50,
      items: {
        type: 'object',
        properties: { taskId: { type: 'string' }, category: { type: 'string' } },
        required: ['taskId', 'category'],
      },
    },
    proposals: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['rewrite', 'split', 'new_task', 'solution_options'] },
          targetTaskId: { type: ['string', 'null'] },
          title: { type: ['string', 'null'] },
          description: { type: ['string', 'null'] },
          rationale: { type: 'string' },
          subtasks: {
            type: ['array', 'null'],
            items: {
              type: 'object',
              properties: { title: { type: 'string' }, description: { type: 'string' } },
              required: ['title', 'description'],
            },
          },
          options: {
            type: ['array', 'null'],
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                approach: { type: 'string' },
                tradeoffs: { type: 'string' },
              },
              required: ['label', 'approach', 'tradeoffs'],
            },
          },
        },
        required: ['kind', 'rationale'],
      },
    },
  },
  required: ['proposals'],
});

function buildPrompt(repo: Repo, tasks: Task[]): string {
  const taskList = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
    source: t.source,
    parentId: t.parentId,
  }));
  return [
    `You are the analysis agent of a task manager. Repo under analysis: "${repo.name}" at ${repo.path}` +
      (repo.role ? ` (role: ${repo.role})` : '') + '.',
    `Current open tasks (JSON):`,
    JSON.stringify(taskList, null, 2),
    ``,
    `First: assign every listed task a short domain category — a label like "UI", "Estimator",`,
    `"Auth", "Data pipeline" — grounded in the repo's actual structure. Reuse one label per domain;`,
    `invent new ones sparingly. Return them in the top-level "categories" array (applied directly).`,
    ``,
    `Then explore the repository read-only as needed and propose improvements to the TASKS (not the code):`,
    `- "rewrite": clearer title/description for an existing task (set targetTaskId, title, description)`,
    `- "split": break an existing task into 2-5 concrete subtasks (set targetTaskId, subtasks)`,
    `- "new_task": a task that is missing but clearly needed (set title, description)`,
    `- "solution_options": for an ambiguous task, 2-4 alternative approaches with tradeoffs (set targetTaskId, options)`,
    ``,
    `Rules: only reference targetTaskId values from the list above. Every proposal needs a short rationale`,
    `grounded in what you actually found in the repo. Prefer few high-value proposals over many trivial ones.`,
    `Do not spawn more than 3 subagents. Return via the fenced JSON result block described below.`,
  ].join('\n');
}

export interface AnalyzeDeps {
  storage: Storage;
}

/** Fire-and-forget analysis run; results land as proposals via events. */
export async function startAnalysis(
  deps: AnalyzeDeps,
  repo: Repo,
  tasks: Task[],
): Promise<{ runId: string }> {
  const { storage } = deps;
  const settings = await storage.getSettings();
  // Role split (user policy 2026-08-24): analysis runs on the orchestrator-tier
  // model (fable), workers do the heavy lifting on opus.
  const model = settings['analysis.model'];

  // A read-only aux terminal (kind `analysis`, subject = the repo), with the
  // same `dontAsk` + denials the `-p` run had (docs/design.md § PTY sessions).
  // Fire-and-forget: the route answers with the run id once the PTY is up,
  // and the proposals land over the event bus when the session settles.
  const { runId, done } = await aux().start({
    kind: 'analysis',
    subjectId: repo.id,
    repoId: repo.id,
    label: `analysis: ${repo.name}`,
    cwd: repo.path,
    model,
    effort: settings['agent.effort'],
    prompt: buildPrompt(repo, tasks) + '\n' + resultInstruction(JSON_SCHEMA),
    tools: READ_ONLY_TOOLS,
    disallowedTools: READ_ONLY_DISALLOWED,
    permission: 'dontAsk',
    lean: true,
    timeoutMs: 10 * 60_000,
    accept: acceptJson(proposalSchema),
  });

  void done.then(async (res) => {
    try {
      if (res.status !== 'ok' || !res.value) {
        if (res.status !== 'aborted') console.error('analyze failed:', (res.error ?? 'no result').slice(0, 500));
        return;
      }
      const parsed = { data: res.value };
      const validTaskIds = new Set(tasks.map((t) => t.id));
      // Categories apply DIRECTLY (metadata, reversible, audited) — but never
      // clobber a category a human or worker already set.
      for (const cat of parsed.data.categories ?? []) {
        if (!validTaskIds.has(cat.taskId)) continue;
        const existing = tasks.find((t) => t.id === cat.taskId);
        if (existing?.category) continue;
        const updated = await storage.updateTask(cat.taskId, { category: cat.category.trim() });
        if (updated) {
          await storage.appendEvent({
            kind: 'task.edited',
            actor: 'analyze',
            taskId: cat.taskId,
            repoId: updated.repoId,
            data: { fields: ['category'], category: cat.category },
          });
          broadcast({ type: 'task.updated', task: updated });
        }
      }
      for (const p of parsed.data.proposals) {
        const taskId = p.targetTaskId && validTaskIds.has(p.targetTaskId) ? p.targetTaskId : null;
        // kinds that require a target are dropped when the model hallucinated an id
        if (!taskId && p.kind !== 'new_task') continue;
        const proposal = await storage.createProposal({
          runId,
          repoId: repo.id,
          taskId,
          kind: p.kind,
          payload: {
            title: p.title ?? undefined,
            description: p.description ?? undefined,
            rationale: p.rationale,
            subtasks: p.subtasks ?? undefined,
            options: p.options ?? undefined,
          },
        });
        broadcast({ type: 'proposal.created', proposal });
        await storage.appendEvent({
          kind: 'proposal.created',
          actor: 'analyze',
          taskId: proposal.taskId,
          runId,
          repoId: repo.id,
          data: { kind: proposal.kind },
        });
      }
    } catch (e) {
      console.error('analyze finalize error:', e);
    }
  });

  return { runId };
}
