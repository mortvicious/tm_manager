import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { READ_ONLY_DISALLOWED, aux } from './aux.ts';

/**
 * Compacting a session before resuming it (docs/token-budget.md § The fourth).
 *
 * A worker session that has grown past `agent.resumeContextCap` is expensive to
 * `--resume`: the CLI re-writes the WHOLE conversation to cache twice (measured
 * 395k + 398k tokens, ~$15) before the follow-up turn says a word, and every
 * later turn re-reads it. Most of those bytes are stale — old heredocs, tool
 * output, screenshots — not knowledge.
 *
 * The CLI compacts when a turn's prompt IS the `/compact` slash command, and it
 * runs the compaction and nothing else. It used to be a `-p` turn; it is now an
 * interactive terminal of its own (aux kind `compact`, docs/design.md § PTY
 * sessions) that the human can watch — measured on 2.1.280: the positional
 * `/compact <focus>` runs, SessionStart fires again with `source: "compact"`,
 * the boundary lands, no Stop fires. Measured against v2.1.257 (`-p`) on two
 * real 175k/191k sessions:
 *
 *   claude -p --resume <id> "/compact <focus>"
 *     → transcript gains {type:'system', subtype:'compact_boundary',
 *       compactMetadata:{trigger:'manual', preTokens:191365, postTokens:10360}},
 *       num_turns 0, empty result, one cache-write of the conversation.
 *
 * `--autocompact <100k..1M>` does the same with trigger:'auto', but takes no
 * focus string and would then apply for the whole resumed run — the gate is
 * meant to fire only between turns, never mid-run. So `/compact` it is.
 *
 * Cost shape: compaction is ONE cache-write of the conversation, i.e. half of
 * the two the plain resume pays, and afterwards the session is ~10k instead of
 * ~400k, so every subsequent turn of the run is cheap too.
 *
 * The session id survives (no `--fork-session`), so the worker PTY that follows
 * resumes the SAME id and picks up the compacted state.
 */

const COMPACT_TIMEOUT_MS = 10 * 60_000;

/** Bytes of transcript tail scanned for the boundary this call should have written. */
const TAIL_BYTES = 512 * 1024;

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE') env[k] = v;
  }
  return env;
}

export interface CompactResult {
  /**
   * `compacted` — verified against the transcript.
   * `failed`    — the CLI errored, or produced no boundary.
   * `aborted`   — WE stopped it: `/killall`, a forced restart, or the task
   *               being cancelled while the compaction ran. Deliberately not
   *               `failed`, because the caller's answer to a failure is to
   *               spawn an agent, and spawning one seconds after an emergency
   *               stop reported everything dead is the bug this distinction
   *               exists to prevent.
   */
  outcome: 'compacted' | 'failed' | 'aborted';
  /** convenience for the success case only */
  ok: boolean;
  /** last-turn context before the compaction, per the boundary record */
  preTokens: number | null;
  /** what the session is worth now — the number the next resume pays for */
  postTokens: number | null;
  /** why it did not happen, for the audit row */
  reason?: string;
}

/**
 * In-flight compactions by caller key (the task id). A compaction is a paid
 * 1–3 minute turn on someone else's behalf; when that someone cancels, there is
 * no reason to keep buying it, and no reason to make them wait for it either.
 */
const inFlight = new Map<string, { abort: () => void }>();

/**
 * Stop the compaction running for `key`, if any. Idempotent, and safe to call
 * for a key with nothing in flight. The call it aborts resolves `aborted`.
 */
export function abortCompaction(key: string): boolean {
  const e = inFlight.get(key);
  if (!e) return false;
  e.abort();
  return true;
}

/**
 * Stop every in-flight compaction — shutdown. `aux().stopAll()` already
 * ends these sessions (they are aux runs) and `aux().stoppedSince` already
 * makes their results `aborted`; this exists so a caller that wants to
 * WAIT for them has a way to be sure they are on their way down first.
 */
export function abortAllCompactions(): number {
  const keys = [...inFlight.keys()];
  for (const k of keys) inFlight.get(k)?.abort();
  return keys.length;
}

/**
 * The focus a compaction is given. Deliberately built from what the NEXT turn
 * needs rather than from the conversation: the summariser keeps what it is told
 * matters, so naming the task and the pending instruction is what stops the
 * summary from being a neutral recap that drops the half the follow-up is
 * about.
 */
export function compactFocus(taskTitle: string, followUp: string | undefined, purpose: 'work' | 'publish'): string {
  const next =
    purpose === 'publish'
      ? 'commit and push the work of this task'
      : followUp
        ? `act on this instruction: ${followUp.slice(0, 800)}`
        : 'carry on with the remaining work';
  return [
    `Keep everything still needed to continue the task "${taskTitle}".`,
    'Preserve in full: every file this session already changed and why, the decisions and constraints it agreed to,',
    'what it verified, and what is still unfinished or known-broken.',
    'Drop verbatim tool output that has been superseded — old file dumps, long command output, search results.',
    `The very next thing this session must do is ${next}`,
  ].join(' ');
}

/**
 * Read the transcript tail for a `compact_boundary` written at or after
 * `since`. The `-p` envelope of a `/compact` turn is an empty success and looks
 * exactly like a prompt the model ignored, so the boundary record is the only
 * honest proof the compaction actually happened — and the caller has to know,
 * because "resume as if compacted when it was not" silently re-buys the whole
 * conversation.
 */
function readBoundary(transcriptPath: string, since: number): { pre: number; post: number } | null {
  let buf: string;
  try {
    const size = fs.statSync(transcriptPath).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const len = size - start;
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, start);
      buf = b.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  let found: { pre: number; post: number } | null = null;
  for (const line of buf.split('\n')) {
    // A partial first line from the mid-file seek simply fails to parse.
    if (!line.includes('compact_boundary')) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j?.subtype !== 'compact_boundary') continue;
    const at = Date.parse(j.timestamp ?? '');
    // A minute of slack: the boundary's timestamp is stamped by the CLI, whose
    // clock is this machine's, but the record is written after the summarising
    // request started — bounding it below is about excluding the PREVIOUS
    // compaction of a session that has been compacted before, not precision.
    if (Number.isFinite(at) && at < since - 60_000) continue;
    const m = j.compactMetadata ?? {};
    found = { pre: Number(m.preTokens ?? 0), post: Number(m.postTokens ?? 0) };
  }
  return found;
}

/**
 * The other half of the gate: when an over-cap session cannot be compacted, the
 * follow-up starts a FRESH agent, and a fresh agent is only as good as what it
 * is handed. The plain fresh follow-up had one input — the task row's 4000-char
 * `resultSummary`. This adds the two things that turn "read the repo again"
 * into "read these files": the previous session's last assistant text IN FULL,
 * and the files it actually touched.
 *
 * `git diff --name-only HEAD` plus untracked files, and deliberately NOT
 * `git add -N .` first (which `review.ts` does need, for content): naming files
 * must not mutate the index of a repo the human may be mid-`git add` in.
 */
export function changedFiles(cwd: string): Promise<string[]> {
  const run = (argv: string[]) =>
    new Promise<string>((resolve) => {
      execFile('git', argv, { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env: cleanEnv() }, (_e, out) =>
        resolve(String(out ?? '')),
      );
    });
  return Promise.all([
    run(['diff', '--name-only', 'HEAD']),
    run(['ls-files', '--others', '--exclude-standard']),
  ]).then(([tracked, untracked]) => {
    const seen = new Set<string>();
    for (const f of `${tracked}\n${untracked}`.split('\n')) {
      const t = f.trim();
      if (t) seen.add(t);
    }
    // A session that changed 400 files is a session whose file list is not the
    // useful part of the handoff; cap it and say so rather than paying for it.
    return [...seen].slice(0, 200);
  });
}

/** Assembles that handoff into the `Previous run summary` block. */
export function freshHandoff(opts: {
  lastAssistantText: string | null;
  fallbackSummary: string | null;
  files: string[];
  reason: string;
}): string {
  const parts = [
    `The previous agent session for this task grew too large to continue and was not resumed (${opts.reason}).` +
      ' You are a NEW session with none of its context. Everything below is what it left behind.',
    '',
    '### Its closing report',
    opts.lastAssistantText ?? opts.fallbackSummary ?? '(none recorded)',
  ];
  if (opts.files.length) {
    parts.push(
      '',
      '### Files it changed (uncommitted, `git diff --name-only HEAD` + untracked)',
      opts.files.map((f) => `- ${f}`).join('\n'),
      '',
      'Re-read THOSE files before anything else — they are the state of the work. Do not re-explore the' +
        ' repo from scratch, and do not redo work that is already in them.',
    );
  }
  return parts.join('\n');
}

/**
 * Compact `sessionId` in place. Never throws: a compaction that fails is a
 * decision the caller makes differently, not an error that should sink the turn
 * the user asked for.
 */
export async function compactSession(opts: {
  cwd: string;
  sessionId: string;
  transcriptPath: string;
  model: string;
  focus: string;
  /** runs-list label of the compaction's terminal */
  label: string;
  /** the task the session belongs to — the run's subject, and the abort key */
  key: string;
  repoId: string | null;
}): Promise<CompactResult> {
  const startedAt = Date.now();
  const ctl = new AbortController();
  let stopped = false;
  inFlight.set(opts.key, {
    abort: () => {
      stopped = true;
      ctl.abort();
    },
  });
  try {
    const o = await aux().run({
      kind: 'compact',
      subjectId: opts.key,
      repoId: opts.repoId,
      label: opts.label,
      cwd: opts.cwd,
      model: opts.model,
      // No `--effort`: compaction is a fixed summarisation procedure, and
      // buying extended thinking for it is exactly the spend this gate exists
      // to avoid.
      effort: null,
      prompt: `/compact ${opts.focus}`,
      resumeSessionId: opts.sessionId,
      // Also where the boundary is looked for: a resumed session keeps writing
      // its original transcript file.
      baselineTranscript: opts.transcriptPath,
      // A `/compact` turn calls no tools; the denials are belt-and-braces
      // against a session that answers the slash command as prose instead.
      tools: ['Read'],
      disallowedTools: READ_ONLY_DISALLOWED,
      permission: 'dontAsk',
      lean: true,
      timeoutMs: COMPACT_TIMEOUT_MS,
      completion: 'compact',
      isCompacted: async (tp) => readBoundary(tp, startedAt) !== null,
      signal: ctl.signal,
    });
    // Aborted takes precedence over everything, including a boundary that did
    // land: the caller must not treat a killed run as an outcome it may act on.
    // `stoppedSince` covers the global sweeps (/killall, forced restart);
    // `stopped` a targeted `abortCompaction`. A timeout is our OWN deadline and
    // stays a failure — it is not mistaken for either.
    if (stopped || o.status === 'aborted' || aux().stoppedSince(startedAt)) {
      return { outcome: 'aborted', ok: false, preTokens: null, postTokens: null, reason: 'stopped' };
    }
    if (o.status !== 'ok') {
      return { outcome: 'failed', ok: false, preTokens: null, postTokens: null, reason: (o.error ?? 'failed').slice(0, 300) };
    }
    const b = readBoundary(opts.transcriptPath, startedAt);
    if (!b) {
      return { outcome: 'failed', ok: false, preTokens: null, postTokens: null, reason: 'no compact_boundary in transcript' };
    }
    return { outcome: 'compacted', ok: true, preTokens: b.pre, postTokens: b.post };
  } finally {
    inFlight.delete(opts.key);
  }
}
