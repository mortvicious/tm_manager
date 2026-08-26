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
  '(create tasks, target other repos by role, poll a task you filed, dispatch messages). Use it',
  "instead of doing out-of-scope work yourself; never work around the API's refusals.",
  'When a related task already exists (one you filed, or the one that filed yours), DISPATCH your',
  'message to its session via the API instead of creating another task — dispatch reuses the',
  'existing agent conversation rather than spawning a new one.',
  'When you are finished, print a short summary of what you changed and how you verified it.',
  'Your change will then be adversarially reviewed before the user sees it, so make it correct and',
  'self-consistent: verify it compiles/passes and handle the edge cases a reviewer would probe.',
].join(' ');

/** Sent when the human hits "proceed" without typing anything. */
export const DEFAULT_PROCEED =
  'Proceed — continue from exactly where you left off. The previous session was interrupted' +
  ' (usage limit, connection loss or a closed terminal), not finished. Re-check the current state' +
  ' of the work before assuming anything, then carry on.';

/**
 * "Publish": sent into the SAME agent session that did the work (`--resume`),
 * so the commit is written by the agent that knows what it changed and the git
 * output lands in the terminal the human has been watching. Deliberately
 * narrow — this turn ships what already exists, it does not write code.
 * Whether it worked is decided afterwards by `verifyPublished`, not by what
 * the agent says here.
 */
export const PUBLISH_INSTRUCTION = [
  'Publish the work you did for this task. Do this in THIS session, yourself, with the Bash tool:',
  '',
  '1. `git status --porcelain` — see what is there.',
  '2. `git add -A` to stage everything (do not add files outside this repo).',
  '3. Commit with a concise message: an imperative summary under 70 chars, and if the change set is',
  '   non-trivial a blank line plus 1-4 short bullets. Skip this step if there is nothing staged.',
  '4. Push the current branch: `git push`, or `git push -u origin HEAD` when it has no upstream.',
  '',
  'Do NOT write, edit or refactor any code in this turn, do not amend or rebase existing commits, do',
  'not force-push, do not create branches or pull requests, and do not spawn subagents. If a step',
  'fails (rejected push, no remote, protected branch), stop and report the exact error instead of',
  'working around it. Finish by printing the commit sha (if you made one) and the push result.',
].join('\n');

// A resumed session keeps its original prompt, so this only re-anchors the caps
// in case the conversation was compacted along the way.
const RESUME_REMINDER = [
  'This is the same session as before — everything you already did and learned still applies.',
  'The standing rules from the start of this session remain in force: work autonomously, do not',
  'spawn more than 3 subagents and avoid parallel agent fan-outs, save deliverables into',
  '$TM_ARTIFACTS_DIR, file follow-up/cross-repo work through the Task Manager API instead of doing',
  'it yourself (dispatch to an existing related task\'s session rather than creating a new task),',
  'and finish with a short summary of what you changed and how you verified it.',
].join(' ');

/**
 * The prompt of a resumed turn that delivers queued dispatches (docs/dispatch.md):
 * messages other task sessions sent to THIS task's session while it was busy or
 * between turns. All pending dispatches for the target are delivered in one
 * turn, oldest first, so one resume handles the whole backlog.
 */
export function buildDispatchTurn(
  items: { fromTitle: string; fromTaskId: string; message: string }[],
): string {
  const parts = [
    `You have ${items.length === 1 ? 'a dispatched message' : `${items.length} dispatched messages`} from related task sessions`,
    `(agent-to-agent coordination — no new task was created for this):`,
    '',
  ];
  for (const d of items) {
    // full id on purpose — it is the address for dispatching an answer back
    parts.push(`## Dispatch from task "${d.fromTitle}" (task id: ${d.fromTaskId})`, '', d.message, '');
  }
  parts.push(
    `Act on the dispatch(es) above within THIS task's scope. If the sender needs an answer, dispatch`,
    `back through the Task Manager API instead of creating a new task. Then finish your turn with a`,
    `short summary as usual.`,
  );
  return parts.join('\n');
}

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
  /**
   * Continue an existing claude session instead of starting a fresh one
   * (`claude --resume <id>`) — the "proceed" flow. The agent keeps its whole
   * conversation, so the prompt carries only the new instruction.
   */
  resumeSessionId?: string;
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

  const args: string[] = [];
  // --resume must name the session we continue; everything else stays identical
  // so hooks, permissions and tool policy are re-applied to the resumed turn.
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  args.push('--model', model, '--effort', effort, '--settings', JSON.stringify(hookSettings));

  if (permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', permissionMode);
  }
  const allowed = settings['agent.allowedTools'];
  if (allowed.length > 0) args.push('--allowedTools', allowed.join(' '));

  // A resumed session already holds the task, the rules and everything it did
  // before — restating them would only bury the new instruction.
  const prompt = opts.resumeSessionId
    ? [
        `# Continuing task: ${task.title}`,
        '',
        opts.followUp ?? DEFAULT_PROCEED,
        '',
        RESUME_REMINDER,
      ].join('\n')
    : [
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
