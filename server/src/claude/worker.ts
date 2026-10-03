import { isCodexModel, type AppSettings, type EffortLevel, type Task } from '@tm/shared';
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
 * re-sent on every turn: planning tools (workers never run in plan mode),
 * artifact/cron/remote-session tooling and the workflow orchestrator.
 * `Skill` and `ToolSearch` stay so a worker can still reach a project skill or
 * load an MCP schema on demand. `AskUserQuestion` is IN even though nobody
 * watches the hidden terminal: the PreToolUse hook below carries the question
 * to the dashboard and the phone and hands the answer back to the tool, so
 * the dialog is never drawn in the terminal (docs/questions.md).
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
  // decisions for the human — see the PreToolUse hook (docs/questions.md)
  'AskUserQuestion',
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
  'Decisions: when a choice would materially change the outcome — an architecture or library',
  'choice, an ambiguous or conflicting requirement, a destructive or irreversible step, scope that',
  'could go two ways — stop and ask with the AskUserQuestion tool. It reaches the user in the',
  'dashboard and on their phone, and your session waits for the answer. Decide small things',
  'yourself; never ask about those.',
  'Finish with a short summary of what you changed and how you verified it. Your change is then',
  'adversarially reviewed before the user sees it, so make it correct and self-consistent: verify it',
  'compiles/passes and handle the edge cases a reviewer would probe.',
].join(' ');

/**
 * The ship gate (docs/design.md § Adversarial review, "Review before ship").
 * The review round runs at the worker's Stop, so a worker that pushes and
 * deploys in its own turn — which some repos' CLAUDE.md require — ships
 * before the reviewer has read a line. When the task will be reviewed, every
 * worker turn except the publish turn carries this rule, and the publish turn
 * (PUBLISH_INSTRUCTION, step 5) runs the held-back deploy/verify steps.
 * A local commit never ships, and the reviewer reads the task's commits
 * (by their trailer, commitTrailerRule) as well as the working tree.
 */
const SHIP_GATE_RULE = [
  'Ship gate — this overrides the repo\'s CLAUDE.md and any other instruction to push or deploy:',
  'this task is adversarially reviewed BEFORE it ships, so in this session do NOT `git push`, deploy',
  '(Vercel, ECS, any release step) or verify against production. Committing locally is fine (the',
  "reviewer reads this task's commits and the working tree). Then stop: after the review, the",
  'Publish turn pushes and runs the deploy/verify steps.',
].join(' ');

/**
 * How the reviewer finds this task's commits (docs/design.md § Adversarial
 * review, "What the reviewer reads"): `git log --all --grep` on this trailer,
 * so work committed on any branch or worktree counts and a second worker's
 * commits in the same repo never do. On EVERY turn — the publish turn is the
 * one that commits most often — and never on SHIP_GATE_RULE's condition.
 */
export function commitTrailerRule(taskId: string): string {
  return `Every commit you make for this task — merge and squash commits included — ends its message with the trailer line \`Task: ${taskId}\` (e.g. \`git commit --trailer "Task: ${taskId}"\`); the reviewer finds this task's commits by it.`;
}

/**
 * Whether this task's change is reviewed before it ships — the same test the
 * Stop hook uses to mark the landing `pending` (routes/internal.ts), so the
 * prompt never promises a review that will not run. Auto-publish skips the
 * review round by design, so it keeps the repo's own push behaviour.
 */
export function shipHeldForReview(task: Pick<Task, 'review' | 'autoPublish'>, settings: AppSettings): boolean {
  return !task.autoPublish && (task.review ?? settings['review.enabled']);
}

/**
 * What the AskUserQuestion hook prints when it cannot reach the server at all
 * (docs/questions.md). A deny, not a silent exit: exiting 0 with no output
 * would let the tool run and draw its dialog in a terminal nobody watches.
 */
export const ASK_UNREACHABLE = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason:
      'Task Manager could not deliver this question to the user. Do not ask again this turn: decide yourself, state the assumption in your summary, and continue.',
  },
};

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
  "5. Only if the push succeeded: run the post-push steps this repo's own instructions (CLAUDE.md)",
  '   require — a deploy, a live verification. They were held back until review; if there are none,',
  '   skip this. A failing deploy or check is reported, not fixed in this turn.',
  '',
  'Do NOT write, edit or refactor any code in this turn, do not amend or rebase existing commits, do',
  'not force-push, do not create branches or pull requests, and do not spawn subagents. If a step',
  'fails (rejected push, no remote, protected branch), stop and report the exact error instead of',
  'working around it. Finish by printing the commit sha (if you made one), the push result and the',
  'result of any step 5.',
].join('\n');

const PUBLISH_UP_TO_HEAD = 'Publish the work you did for this task — ONLY up to its own last commit.';

/**
 * The publish turn of a STACKED task (docs/queue.md § Stacked tasks): later
 * tasks in this checkout, not yet approved, have work on top of this one —
 * their commits after `sha`, or their edits in the working tree — so the
 * ordinary `git add -A` + `git push` would ship them too. This task's own
 * leftovers were already committed under its trailer by the queue's hand-off,
 * so the turn pushes exactly `sha` and stages nothing. Recognised as a publish
 * turn by `isPublishInstruction` (identity for PUBLISH_INSTRUCTION, this
 * fixed first line for the variant).
 */
export function publishUpToInstruction(p: { sha: string; remote: string; mergeRef: string }): string {
  return [
    PUBLISH_UP_TO_HEAD,
    'Later tasks in this checkout have unapproved work on top of yours (commits after it and/or edits in',
    'the working tree), so do this in THIS session, yourself, with the Bash tool:',
    '',
    `1. Push exactly your last commit: \`git push ${p.remote} ${p.sha}:${p.mergeRef}\`.`,
    '2. Only if the push succeeded: run the post-push steps this repo\'s own instructions (CLAUDE.md)',
    '   require — but ONLY steps that act on what was pushed (a CI/deploy triggered by the push, a live',
    '   check of it). Do NOT deploy or build from the local working tree: it contains the later tasks\'',
    '   unapproved work. Report any step you skipped for that reason.',
    '',
    'Do NOT stage, commit, stash, reset, checkout, amend, rebase or force-push anything, do not touch the',
    'working tree, do not create branches or pull requests, and do not spawn subagents. If the push fails',
    '(rejected, non-fast-forward, no remote), stop and report the exact error instead of working around',
    'it. Finish by printing the push result and the result of any step 2.',
  ].join('\n');
}

/** Is this follow-up text a publish turn (either form)? */
export function isPublishInstruction(text: string | undefined): boolean {
  return text === PUBLISH_INSTRUCTION || (!!text && text.startsWith(PUBLISH_UP_TO_HEAD));
}

// A resumed session keeps its original prompt, so this only re-anchors the caps
// in case the conversation was compacted along the way. Keep it in lockstep with
// STANDING_RULES — a resumed turn that restates an older wording silently
// overrides the fresh prompt for the rest of the session.
const RESUME_REMINDER = [
  'Same session as before — everything you did and learned still applies. Standing rules hold: work',
  'autonomously; plan briefly before you edit; delegate exploration to a subagent instead of reading',
  'files turn by turn (up to 3 subagents per session, one at a time, no parallel fan-outs); save',
  'deliverables in $TM_ARTIFACTS_DIR; route follow-up/cross-repo work through the Task Manager API,',
  "dispatching to a related task's session rather than creating a new task; ask the user with",
  'AskUserQuestion when a decision would materially change the outcome (it reaches their dashboard',
  'and phone and waits), decide small things yourself; finish with a short summary of what you',
  'changed and how you verified it.',
].join(' ');

/**
 * The prompt text itself — CLI-agnostic, so both the `claude` and `codex`
 * branches of buildWorkerInvocation build it the same way. `resumeSessionId`
 * only changes which header/reminder wraps it; it never implies `--resume`
 * (codex never sets it — see isCodexModel branch below).
 */
function buildWorkerPrompt(opts: {
  task: Task;
  followUp?: string;
  resumeSessionId?: string;
  dispatchNote?: string;
  /** The shared-space block (docs/shared-spaces.md); a context note like `dispatchNote`. */
  sharedNote?: string;
  previousSummary?: string;
  /** shipHeldForReview(): add SHIP_GATE_RULE (never on the publish turn). */
  shipGate: boolean;
}): string {
  const { task } = opts;
  // Strict identity on purpose: the publish turn is recognised by BEING the
  // publish instruction (or the stacked variant's fixed first line). That is why an `fyi` backlog travels as its own
  // `dispatchNote` and is never concatenated onto `followUp` — doing that
  // would silently turn every publish turn into an ordinary one.
  const isPublishTurn = isPublishInstruction(opts.followUp);
  const resumeBody = opts.followUp ?? DEFAULT_PROCEED;
  // The note goes FIRST (context the turn may need) and never last: the last
  // thing a resumed agent reads must stay the instruction it has to act on.
  // The shared-space block is the same kind of context and follows the same
  // rule (never concatenated onto `followUp`, never last).
  const note = [
    ...(opts.dispatchNote ? [opts.dispatchNote, ''] : []),
    ...(opts.sharedNote && !isPublishTurn ? [opts.sharedNote, ''] : []),
  ];
  // The publish turn is the one turn that SHOULD push — the gate is exactly
  // what it lifts.
  const gate = opts.shipGate && !isPublishTurn;
  return opts.resumeSessionId
    ? [
        `# Continuing task: ${task.title}`,
        '',
        ...note,
        ...(isPublishTurn ? [RESUME_REMINDER, '', resumeBody] : [resumeBody, '', RESUME_REMINDER]),
        '',
        commitTrailerRule(task.id),
        ...(gate ? ['', SHIP_GATE_RULE] : []),
      ].join('\n')
    : [
        // The shared-space block LEADS a fresh prompt: it is what to read
        // before planning, and between a long description and the standing
        // rules it was read past (docs/shared-spaces.md § What a worker gets).
        opts.sharedNote && !isPublishTurn ? `${opts.sharedNote}\n\n` : '',
        `# Task: ${task.title}`,
        task.description ? `\n${task.description}` : '',
        opts.followUp
          ? // `previousSummary` is the richer handoff the resume gate builds
            // when it declines to resume an over-cap session (the full last
            // assistant text plus the files that session touched), so the new
            // agent re-reads only those files instead of rediscovering the
            // work. Without it this falls back to the task row's 4000-char
            // `resultSummary`, which is all a plain fresh follow-up ever had.
            `\n\n## Previous run summary\n${opts.previousSummary ?? task.resultSummary ?? '(none recorded)'}\n\n## Follow-up instruction from the user\n${opts.followUp}`
          : '',
        opts.dispatchNote ? `\n\n${opts.dispatchNote}` : '',
        `\n\n${STANDING_RULES}`,
        `\n\n${commitTrailerRule(task.id)}`,
        gate ? `\n\n${SHIP_GATE_RULE}` : '',
      ].join('');
}

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
 * The `fyi` backlog block (docs/dispatch.md § Intent). These messages did NOT
 * cause this turn — they were queued by related sessions with nothing for this
 * task to do, and are riding along on a resume that was going to happen anyway.
 * Deliberately worded so the agent does not treat them as a new instruction:
 * an `fyi` that turns into work is exactly the wake-up this split removes.
 */
export function buildDispatchNote(
  items: { fromTitle: string; fromTaskId: string; message: string }[],
): string {
  const parts = [
    `## FYI from related task sessions (queued while you were not running)`,
    '',
    `${items.length === 1 ? 'This message was' : `These ${items.length} messages were`} sent to you as FYI —`,
    `context, answers or corrections, with nothing specifically asked of you. Read them, let them`,
    `inform what you are doing now, and do NOT treat them as a new instruction or start separate work`,
    `for them. No reply is expected; dispatch back only if you have something the sender must act on.`,
    '',
  ];
  for (const d of items) {
    // full id on purpose — it is the address for dispatching an answer back
    parts.push(`### FYI from task "${d.fromTitle}" (task id: ${d.fromTaskId})`, '', d.message, '');
  }
  return parts.join('\n');
}

/**
 * Builds the worker invocation for a hidden PTY — `claude` (default) or
 * `codex exec` when the task's model names Codex (isCodexModel). Args array
 * only — never a shell string (quoting hazard, review m8).
 *
 * Claude path: completion/attention detection comes from lifecycle hooks
 * injected via --settings, which curl back to our internal routes with the
 * per-boot token. `$TM_*` placeholders are expanded by the hook's shell from
 * the PTY env, so the settings JSON itself is static per run.
 *
 * Codex path: `codex exec` has no hook-injection mechanism like --settings,
 * so there is no Stop/Notification-equivalent wired up. Completion instead
 * rides the SAME fallback the claude path already has for a hookless exit
 * (orchestrator.ts handleExit: exit 0 → review, nonzero → failed) — `codex
 * exec` runs one turn to completion and exits on its own, so that fallback
 * IS the primary signal here, not a backstop. Session resume is likewise not
 * implemented: nothing populates Run.sessionId for a codex run, so
 * findResumableRun never matches one and follow-ups/publish on a codex task
 * fall back to their existing "no resumable session" paths (fresh spawn /
 * direct-git publish) automatically — resumeSessionId is accepted here only
 * so the shared prompt-header logic still works, never turned into a CLI flag.
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
   * `fyi` dispatches that were waiting for this session to be resumed for some
   * other reason (docs/dispatch.md § Intent). Prepended to the turn; it is
   * never the reason the turn exists.
   */
  dispatchNote?: string;
  /**
   * The repo's shared space (docs/shared-spaces.md): its folder becomes
   * `$TM_SHARED_DIR` and an extra `--add-dir` (so the agent may write its
   * knowledge there), and `note` is the turn's block of open requests.
   */
  shared?: { dir: string; note?: string };
  /**
   * Continue an existing claude session instead of starting a fresh one
   * (`claude --resume <id>`) — the "proceed" flow. The agent keeps its whole
   * conversation, so the prompt carries only the new instruction.
   */
  resumeSessionId?: string;
  /**
   * Handoff text for a follow-up that is deliberately NOT resuming: the resume
   * gate found the session past `agent.resumeContextCap` and could not compact
   * it (docs/token-budget.md § The fourth). Ignored when `resumeSessionId` is
   * set — a resumed session needs no summary of itself.
   */
  previousSummary?: string;
}): WorkerInvocation {
  const { task, settings } = opts;
  const model = task.model ?? settings['agent.model'];
  const env = {
    TM_RUN_ID: opts.runId,
    TM_TOKEN: opts.token,
    TM_CALLBACK_URL: opts.callbackUrl,
    TM_ARTIFACTS_DIR: opts.artifactsDir,
    // The CLI loads CLAUDE.md from `--add-dir` folders only with this set, and
    // the shared folder's generated CLAUDE.md is how the map reaches the
    // agent's context without it having to choose to open a file
    // (docs/shared-spaces.md § What a worker gets). The shared folder is the
    // only --add-dir a worker gets, so no other directory's memory comes in.
    ...(opts.shared ? { TM_SHARED_DIR: opts.shared.dir, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' } : {}),
  };

  if (isCodexModel(model)) {
    const prompt = buildWorkerPrompt({
      task,
      followUp: opts.followUp,
      resumeSessionId: opts.resumeSessionId,
      dispatchNote: opts.dispatchNote,
      sharedNote: opts.shared?.note,
      previousSummary: opts.previousSummary,
      shipGate: shipHeldForReview(task, settings),
    });
    // `-c model_reasoning_effort` has no Codex-CLI-wide free/paid distinction
    // worth encoding yet, so effort is not forwarded — "free" is entirely a
    // property of how `codex login` was authenticated (ChatGPT account vs an
    // OPENAI_API_KEY), which is outside this process's control.
    // `codex exec` has no `--ask-for-approval` (that flag only exists on the
    // interactive TUI, confirmed against v0.150.1's `codex exec --help` — it
    // errors as an unexpected argument) — exec already runs with approval
    // policy "never" by default since there is no one to prompt, so
    // --sandbox workspace-write alone is the exec/sandbox twin of
    // --dangerously-skip-permissions (same reasoning as the Claude
    // Notification hook existing at all: a hidden run cannot answer a prompt).
    const args = ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check'];
    // codex-free vs a pinned codex-<model> id (e.g. codex-gpt-5.1-codex-mini)
    const pinnedModel = model === 'codex-free' ? null : model.replace(/^codex-/, '');
    if (pinnedModel) args.push('--model', pinnedModel);
    args.push(prompt);
    return { cmd: 'codex', args, env };
  }

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
  // The AskUserQuestion carrier (docs/questions.md). Unlike the fire-and-forget
  // hooks above, this one's stdout IS the tool decision, so nothing is
  // discarded and `|| true` would be wrong: the loop re-sends the same body
  // (idempotent on tool_use_id server-side) until the server answers with a
  // decision; a `pending` reply just means "still waiting" and resets the
  // failure count. Five consecutive failed ATTEMPTS — curl error or a reply
  // that is neither a decision nor pending (403, 400, 500, an error page) —
  // print a deny that tells the agent to decide for itself: a hidden terminal
  // must never be left on a dialog nobody can see. The one reply that exits
  // SILENTLY is the route's "run is not working" 409: the session is idle, so
  // this is a human typing into an attached terminal after the turn — the one
  // place the CLI's own dialog works, so it is left to draw it. `case`
  // patterns carry no quotes on purpose (inside a pattern `"` quotes rather
  // than matches — review round 1). `timeout` is the CLI's own cap on the hook
  // (seconds; default 600), raised to a week: the human is the slow part.
  const askHook = [
    'b=$(cat); f=0; while :; do',
    `o=$(printf %s "$b" | curl -s --max-time 75 -X POST -H "x-tm-token: $TM_TOKEN" -H "content-type: application/json" --data-binary @- "$TM_CALLBACK_URL/api/internal/runs/$TM_RUN_ID/question?waitMs=60000"); c=$?;`,
    'if [ $c -ne 0 ]; then f=$((f+1)); else case "$o" in',
    '*hookSpecificOutput*) printf %s "$o"; exit 0;;',
    '*run?is?not?working*) exit 0;;',
    '*pending*) f=0;;',
    '*) f=$((f+1));;',
    'esac; fi;',
    `[ $f -ge 5 ] && { printf %s '${JSON.stringify(ASK_UNREACHABLE)}'; exit 0; };`,
    'sleep 3; done',
  ].join(' ');

  const hookSettings = {
    disableBundledSkills: true,
    hooks: {
      PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: askHook, timeout: 604_800 }] }],
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
      // The `waiting` status (docs/design.md § Waiting): Stop fires at the end
      // of EVERY turn, including one the agent ends with a background subagent
      // still running — the CLI re-invokes the session when that child returns.
      // These two let the server count the children still out, so that Stop
      // parks the task as `waiting` instead of handing a half-done tree to the
      // reviewer. Both fire for background subagents as well as foreground
      // ones; foreground ones simply come and go inside the turn.
      SubagentStart: [
        { hooks: [{ type: 'command', command: hookCurl('/api/internal/runs/$TM_RUN_ID/subagent-start') }] },
      ],
      SubagentStop: [
        { hooks: [{ type: 'command', command: hookCurl('/api/internal/runs/$TM_RUN_ID/subagent-stop') }] },
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

  // The shared space folder lives outside the repo; without this a write there
  // is an out-of-workspace edit the permission layer may stop on. `=` form on
  // purpose: `--add-dir` is variadic and would otherwise swallow the prompt.
  if (opts.shared) args.push(`--add-dir=${opts.shared.dir}`);

  // A resumed session already holds the task, the rules and everything it did
  // before — restating them would only bury the new instruction.
  // Exception: the publish turn is deliberately narrower than the standing
  // rules (no code, no subagents, git output as the closing report), so the
  // reminder goes ABOVE it — the last thing the agent reads on that turn has
  // to be the narrow instruction, not "plan, delegate, summarise".
  const prompt = buildWorkerPrompt({
    task,
    followUp: opts.followUp,
    resumeSessionId: opts.resumeSessionId,
    dispatchNote: opts.dispatchNote,
    sharedNote: opts.shared?.note,
    previousSummary: opts.previousSummary,
    shipGate: shipHeldForReview(task, settings),
  });
  args.push(prompt);

  return { cmd: 'claude', args, env };
}
