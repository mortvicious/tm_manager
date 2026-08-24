import type { AppSettings, EffortLevel, Task } from '@tm/shared';

export interface WorkerInvocation {
  cmd: string;
  args: string[];
  env: Record<string, string>;
}

// Standing instructions appended to every worker prompt (user-mandated caps).
const STANDING_RULES = [
  'Work autonomously on the task above.',
  'Do not spawn more than 3 subagents in this session, and avoid parallel agent fan-outs.',
  'The directory $TM_ARTIFACTS_DIR is this task\'s shared file space: the user may have placed input',
  'files there for you (screenshots, data) — read them if relevant; and if the task asks you to produce',
  'a file (a report, dataset, gathered notes), save it there so it appears in the task panel.',
  'You can file follow-up tasks and coordinate cross-repo work through the Task Manager API:',
  'fetch `curl -s -H "x-tm-token: $TM_TOKEN" "$TM_CALLBACK_URL/api/agent/instructions"` for the how-to',
  '(create tasks, target other repos by role, poll a task you filed). Use it instead of doing',
  "out-of-scope work yourself; never work around the API's refusals.",
  'When you are finished, print a short summary of what you changed and how you verified it.',
  'Your change will then be adversarially reviewed before the user sees it, so make it correct and',
  'self-consistent: verify it compiles/passes and handle the edge cases a reviewer would probe.',
].join(' ');

/**
 * Builds the interactive `claude` invocation for a worker PTY.
 * Args array only — never a shell string (quoting hazard, review m8).
 * Completion/attention detection comes from lifecycle hooks injected via
 * --settings: they curl back to our internal routes with the per-boot token.
 * `$TM_*` placeholders are expanded by the hook's shell from the PTY env, so
 * the settings JSON itself is static per run.
 */
export function buildWorkerInvocation(opts: {
  task: Task;
  settings: AppSettings;
  runId: string;
  token: string;
  callbackUrl: string; // e.g. http://127.0.0.1:5175 — derived from the bound address
  artifactsDir: string;
  /** re-run with an additional human instruction (previous summary included) */
  followUp?: string;
}): WorkerInvocation {
  const { task, settings } = opts;
  const model = task.model ?? settings['agent.model'];
  const effort: EffortLevel = task.effort ?? settings['agent.effort'];
  const permissionMode = settings['agent.permissionMode'];

  // curl hardening (review m4): --max-time so a wedged server can't hang the
  // agent's turn, `|| true` so hook exit codes never block stopping.
  const hookCurl = (path: string) =>
    `curl -s --max-time 5 -X POST -H "x-tm-token: $TM_TOKEN" -H "content-type: application/json" --data-binary @- "$TM_CALLBACK_URL${path}" >/dev/null 2>&1 || true`;

  const hookSettings = {
    hooks: {
      // SessionStart reports session_id/transcript_path immediately so live
      // stats can stream mid-run instead of waiting for the first Stop.
      SessionStart: [
        { hooks: [{ type: 'command', command: hookCurl('/api/internal/runs/$TM_RUN_ID/session-start') }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: hookCurl('/api/internal/runs/$TM_RUN_ID/stop') }] }],
      SessionEnd: [
        { hooks: [{ type: 'command', command: hookCurl('/api/internal/runs/$TM_RUN_ID/session-end') }] },
      ],
      Notification: [
        { hooks: [{ type: 'command', command: hookCurl('/api/internal/runs/$TM_RUN_ID/needs-attention') }] },
      ],
    },
  };

  const args: string[] = ['--model', model, '--effort', effort, '--settings', JSON.stringify(hookSettings)];

  if (permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', permissionMode);
  }
  const allowed = settings['agent.allowedTools'];
  if (allowed.length > 0) args.push('--allowedTools', allowed.join(' '));

  const prompt = [
    `# Task: ${task.title}`,
    task.description ? `\n${task.description}` : '',
    opts.followUp
      ? `\n\n## Previous run summary\n${task.resultSummary ?? '(none recorded)'}\n\n## Follow-up instruction from the user\n${opts.followUp}`
      : '',
    `\n\n${STANDING_RULES}`,
  ].join('');
  args.push(prompt);

  return {
    cmd: 'claude',
    args,
    env: {
      TM_RUN_ID: opts.runId,
      TM_TOKEN: opts.token,
      TM_CALLBACK_URL: opts.callbackUrl,
      TM_ARTIFACTS_DIR: opts.artifactsDir,
    },
  };
}
