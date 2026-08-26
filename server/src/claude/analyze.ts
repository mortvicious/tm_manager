import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { Repo, Task } from '@tm/shared';
import { broadcast } from '../events.ts';
import { registerHeadless } from './headless.ts';
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
    `Do not spawn more than 3 subagents. Return via the structured output schema.`,
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
  const run = await storage.createRun({
    repoId: repo.id,
    mode: 'analyze',
    model,
    effort: settings['agent.effort'],
  });

  const args = [
    '-p',
    '--model',
    model,
    '--effort',
    settings['agent.effort'],
    '--permission-mode',
    'dontAsk',
    '--disallowedTools',
    'Edit',
    'Write',
    'NotebookEdit',
    'Bash',
    '--output-format',
    'json',
    '--json-schema',
    JSON_SCHEMA,
  ];

  // Hoisted BEFORE execFile: spawn errors fire on process.nextTick, which
  // drains before promise microtasks — a `const finish` defined after an
  // await would still be in its TDZ and crash the server (review R1).
  const finish = async (err: Error | null, stdout: string) => {
    const endedAt = new Date().toISOString();
    try {
      // A user kill (R4) must not be clobbered back to plain 'exited'.
      const cur = await storage.getRun(run.id);
      if (cur?.status === 'killed') return;
      // Parse the result ENVELOPE, not raw stdout (review M2). The envelope
      // carries `structured_output` already parsed against our schema.
      let envelope: any = null;
      try {
        envelope = JSON.parse(stdout);
      } catch {
        // fall through to error handling
      }
      if (err && !envelope) {
        await storage.updateRun(run.id, { status: 'exited', exitCode: 1, endedAt });
        console.error('analyze failed:', err.message.slice(0, 500));
        return;
      }
      if (!envelope || envelope.is_error || !envelope.structured_output) {
        await storage.updateRun(run.id, { status: 'exited', exitCode: 1, endedAt });
        console.error('analyze returned no structured output:', String(envelope?.result).slice(0, 300));
        return;
      }
      const parsed = proposalSchema.safeParse(envelope.structured_output);
      if (!parsed.success) {
        await storage.updateRun(run.id, { status: 'exited', exitCode: 1, endedAt });
        console.error('analyze output failed validation:', parsed.error.message.slice(0, 500));
        return;
      }
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
          runId: run.id,
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
          runId: run.id,
          repoId: repo.id,
          data: { kind: proposal.kind },
        });
      }
      const u = envelope.usage ?? {};
      await storage.updateRun(run.id, {
        status: 'exited',
        exitCode: 0,
        endedAt,
        sessionId: envelope.session_id ?? null,
        stats: {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          costUsd: Math.round((envelope.total_cost_usd ?? 0) * 1000) / 1000,
          contextPct: 0,
        },
      });
    } catch (e) {
      console.error('analyze finalize error:', e);
      await storage.updateRun(run.id, { status: 'exited', exitCode: 1, endedAt }).catch(() => {});
    }
  };

  const child = execFile(
    'claude',
    args,
    {
      cwd: repo.path,
      timeout: 10 * 60_000,
      maxBuffer: 64 * 1024 * 1024, // -p envelopes can be large (review M1)
      env: cleanEnv(),
    },
    (err, stdout) => {
      void finish(err, stdout);
    },
  );
  // stdin errors (EPIPE when claude exits before draining) would otherwise be
  // an unhandled 'error' event → process crash (review R1).
  child.stdin?.on('error', () => {});
  child.stdin?.write(buildPrompt(repo, tasks));
  child.stdin?.end();
  trackHeadlessChild(run.id, child, `analysis of ${repo.name}`);
  await storage.updateRun(run.id, { pid: child.pid ?? null });

  return { runId: run.id };
}

// Live headless children by runId — lets the kill route stop a burning run
// (R4). Shared with the feature-analysis pipeline, which spawns several
// `claude -p` processes under ONE run row; registering each in turn keeps a
// single Kill button honest.
const analyzeChildren = new Map<string, ReturnType<typeof execFile>>();

export function trackHeadlessChild(runId: string, child: ReturnType<typeof execFile>, label = 'analysis'): void {
  analyzeChildren.set(runId, child);
  child.on('exit', () => {
    if (analyzeChildren.get(runId) === child) analyzeChildren.delete(runId);
  });
  // Also joins the pool the restart guard reads: a headless agent has no PTY,
  // so nothing else would notice it is working (docs/commands.md).
  registerHeadless(child, label);
}

export function killAnalysis(runId: string): boolean {
  const child = analyzeChildren.get(runId);
  if (!child || child.exitCode !== null) return false;
  child.kill('SIGTERM');
  // Same escalation as PTY sessions: a wedged claude -p must not outlive the
  // kill by more than 5s (final review F3).
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 5000).unref();
  return true;
}

// Same env hygiene as PTY workers: strip inherited claude session markers.
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE') env[k] = v;
  }
  return env;
}
