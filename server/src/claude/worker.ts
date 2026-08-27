import type { AppSettings, EffortLevel, Task } from '@tm/shared';
import { needsFallbackModel } from './usage.ts';

export interface WorkerInvocation {
  cmd: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Built-in tools a worker session is given. `--tools` filters the tool SCHEMAS
 * the model is sent, which is what the fixed preamble is mostly made of —
 * unlike `--allowedTools`, which is only a permission gate and costs the same
 * context either way (docs/token-budget.md). Anything left out here is not
 * re-sent on every turn: interactive-only tools (AskUserQuestion — nobody is
 * watching a hidden terminal), planning tools (workers never run in plan mode),
 * artifact/cron/remote-session tooling and the workflow orchestrator.
 * `Skill` and `ToolSearch` stay so a worker can still reach a project skill or
 * load an MCP schema on demand.
 */
const WORKER_TOOLS = [
  // shell — also the publish turn's only tool (git add/commit/push)
  'Bash',
  'BashOutput',
  'KillShell',
  // files
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  // delegation — the standing rules ask for it, so it must be present
  'Agent',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Skill',
  'ToolSearch',
];

// Standing instructions appended to every worker prompt (user-mandated caps).
// Kept deliberately tight: this block is re-sent on every turn of the session,
// so a paragraph here is paid for dozens of times (docs/token-budget.md).
const STANDING_RULES = [
  'Work autonomously. Before you edit anything, write a short plan — what you will change, in which',
  'files, and how you will verify it. Nobody approves it: write it, then execute it in the same turn.',
  'Delegate repo exploration and multi-file reading to a subagent and act on its summary: a',
  "subagent's reading is discarded when it returns, while anything you read yourself is re-sent on",
  'every later turn. Up to 3 subagents per session, one at a time, and no parallel agent fan-outs.',
  "$TM_ARTIFACTS_DIR is this task's shared file space: read any input files the user left there, and",
  'save deliverables (a report, dataset, gathered notes) there so they appear in the task panel.',
  'Route follow-up and cross-repo work through the Task Manager API instead of doing it yourself —',
  '`curl -s -H "x-tm-token: $TM_TOKEN" "$TM_CALLBACK_URL/api/agent/instructions"` explains how; never',
  'work around its refusals. When a related task already exists (one you filed, or the one that filed',
  'yours), DISPATCH to its session instead of creating another task — dispatch reuses that agent',
  'conversation rather than spawning a new one.',
  'Finish with a short summary of what you changed and how you verified it. Your change is then',
  'adversarially reviewed before the user sees it, so make it correct and self-consistent: verify it',
  'compiles/passes and handle the edge cases a reviewer would probe.',
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
// in case the conversation was compacted along the way. Keep it in lockstep with
// STANDING_RULES — a resumed turn that restates an older wording silently
// overrides the fresh prompt for the rest of the session.
const RESUME_REMINDER = [
  'Same session as before — everything you did and learned still applies. Standing rules hold: work',
  'autonomously; plan briefly before you edit; delegate exploration to a subagent instead of reading',
  'files turn by turn (up to 3 subagents per session, one at a time, no parallel fan-outs); save',
  'deliverables in $TM_ARTIFACTS_DIR; route follow-up/cross-repo work through the Task Manager API,',
  "dispatching to a related task's session rather than creating a new task; finish with a short",
  'summary of what you changed and how you verified it.',
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

  // Also the cheapest place to shrink the fixed preamble: bundled skills are
  // ~40 skill descriptions a worker never invokes (/design, /schedule,
  // statusline-setup…). Project skills (.claude/skills in the target repo) are
  // NOT affected by this flag, so a repo can still ship its own.
  const hookSettings = {
    disableBundledSkills: true,
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
  // Tool SCHEMAS the session is sent. `--tools`/`--allowedTools` are variadic in
  // the CLI, so they MUST use the `--flag=value` form: pushed as two argv
  // elements the parser swallows the following argument — which here is the
  // prompt itself.
  args.push(`--tools=${WORKER_TOOLS.join(',')}`);
  // Browser/MCP tooling (worth ~2.6k of preamble — docs/token-budget.md) is
  // withheld only when THIS invocation can prove it is not needed, and it is
  // never *taken away*:
  //
  //  - `--no-chrome` is applied to FRESH sessions only. A resumed turn cannot
  //    see what the earlier turns of its session were told to do — a follow-up
  //    two turns ago may have said "take a screenshot to verify", and the
  //    session was killed mid-way (the audit found 66 of 100 runs end killed)
  //    before a plain Proceed or a second review round resumed it with no
  //    keyword of its own. Gating a resume on its own text alone revokes the
  //    MCP server mid-work, which is a regression, not a saving. Monotone
  //    beats a persisted flag here: chrome-on is the safe direction, so the
  //    rule needs no extra state to be correct.
  //  - a fresh session is gated on its whole prompt — title, description, the
  //    follow-up instruction when a respawn carries one, and the previous
  //    run's summary that goes with it — not just the title, so a respawned
  //    follow-up asking for browser work keeps its tools.
  //
  // Keyword set is the model router's `needsFallbackModel` (word-boundary
  // anchored, so "browserslist" does not match — review F11 in usage.ts). A
  // browser turn is left on the user's own Chrome configuration and never
  // forced on with `--chrome`: that flag makes the session wait on the
  // extension, and a hidden PTY with no browser attached never gets its first
  // turn back.
  const browserText =
    [task.description, opts.followUp, opts.followUp ? task.resultSummary : null]
      .filter(Boolean)
      .join('\n') || null;
  if (!opts.resumeSessionId && !needsFallbackModel(task.title, browserText)) {
    args.push('--no-chrome');
  }

  // Permission allowlist — orthogonal to --tools (that one decides which
  // schemas are sent, this one which calls are permitted). Left empty by
  // default: an allowlist that is too narrow makes a hidden terminal stall on a
  // permission prompt nobody can answer.
  const allowed = settings['agent.allowedTools'];
  if (allowed.length > 0) args.push(`--allowedTools=${allowed.join(' ')}`);

  // A resumed session already holds the task, the rules and everything it did
  // before — restating them would only bury the new instruction.
  // Exception: the publish turn is deliberately narrower than the standing
  // rules (no code, no subagents, git output as the closing report), so the
  // reminder goes ABOVE it — the last thing the agent reads on that turn has
  // to be the narrow instruction, not "plan, delegate, summarise".
  const isPublishTurn = opts.followUp === PUBLISH_INSTRUCTION;
  const resumeBody = opts.followUp ?? DEFAULT_PROCEED;
  const prompt = opts.resumeSessionId
    ? [
        `# Continuing task: ${task.title}`,
        '',
        ...(isPublishTurn ? [RESUME_REMINDER, '', resumeBody] : [resumeBody, '', RESUME_REMINDER]),
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
