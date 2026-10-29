/**
 * Task History steps (docs/timeline.md § Task history). Pure: turns one task's
 * `GET /api/tasks/:id/history` answer (its `HISTORY_EVENT_KINDS` rows, runs,
 * segments and dispatches) into the lifecycle strip the task panel's History
 * tab renders, oldest first. Shared so the timeline can reuse it.
 *
 * Durations come from the fold's segments wherever one exists (a worker run's
 * worked time is the sum of its running/fixing stretches, not `startedAt..
 * endedAt` — the PTY stays attachable, idle, long after the turn landed); cost
 * and tokens from `tm_runs.stats`. A step NEVER carries an answer to a
 * question: `question.answered` holds the answer map, which may be a redacted
 * secret, and this module does not read it.
 */
import type { TimelineSegment } from './timeline.ts';
import type { AuditEvent, Dispatch, Run, RunStats, Task } from './types.ts';

export type HistoryStepKind =
  | 'created'
  | 'queued'
  | 'claimed'
  | 'run'
  | 'fix'
  | 'compact'
  | 'waiting'
  | 'review'
  | 'checks'
  | 'wake'
  | 'transient'
  | 'stop-failure'
  | 'auto-compact'
  | 'killed'
  | 'question'
  | 'dispatch'
  | 'queue'
  | 'loop'
  | 'budget'
  | 'worktree'
  | 'pr'
  | 'landing'
  | 'land'
  | 'publish'
  | 'shipped'
  | 'landed'
  | 'closed'
  | 'retry'
  | 'undo'
  | 'release'
  | 'paused'
  | 'resumed'
  | 'failed'
  | 'cancelled';

export type HistoryTone = 'neutral' | 'info' | 'good' | 'warn' | 'bad';

export interface HistoryStep {
  kind: HistoryStepKind;
  at: string;
  /** a point step has `end === at`; null = still open */
  end: string | null;
  /** 0 for a point step; null while open, unless `now` was given */
  durationMs: number | null;
  /** run cost (worker turn, reviewer, compaction); null where no run is behind the step */
  costUsd: number | null;
  /** input + output + cache read + cache write of the run(s) behind the step */
  tokens: number | null;
  actor: string | null;
  label: string;
  detail: string | null;
  runId?: string;
  tone: HistoryTone;
}

export interface TaskHistoryInput {
  task: Pick<Task, 'id' | 'createdAt' | 'createdByRun' | 'spawnDepth' | 'source' | 'status' | 'error'>;
  events: readonly AuditEvent[];
  runs: readonly Run[];
  segments: readonly TimelineSegment[];
  /** both directions; without it only RECEIVED dispatches are known (from the receiver's `task.dispatch` rows) */
  dispatches?: readonly Dispatch[];
  /** measures open steps; omitted = they stay `durationMs: null` */
  now?: string;
}

/** a fix turn's announcement (`task.follow-up` with a reason) precedes its run by at most this */
const FIX_ANNOUNCE_MS = 5 * 60_000;
/** question text shown on a step, at most */
const QUESTION_CHARS = 120;

const ms = (iso: string) => Date.parse(iso);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const short = (id: string | null | undefined) => (id ? id.slice(0, 8) : '?');
const join = (...parts: (string | undefined | null | false)[]) => parts.filter(Boolean).join(' · ') || null;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function runTokens(stats: RunStats | null | undefined): number | null {
  if (!stats) return null;
  return (stats.inputTokens ?? 0) + (stats.outputTokens ?? 0) + (stats.cacheReadTokens ?? 0) + (stats.cacheWriteTokens ?? 0);
}

function sumRuns(runs: readonly Run[]): { costUsd: number | null; tokens: number | null } {
  let cost: number | null = null;
  let tokens: number | null = null;
  for (const r of runs) {
    if (!r.stats) continue;
    cost = (cost ?? 0) + (r.stats.costUsd ?? 0);
    tokens = (tokens ?? 0) + (runTokens(r.stats) ?? 0);
  }
  return { costUsd: cost, tokens };
}

interface Draft extends Omit<HistoryStep, 'durationMs' | 'costUsd' | 'tokens' | 'actor' | 'detail'> {
  durationMs?: number | null;
  costUsd?: number | null;
  tokens?: number | null;
  actor?: string | null;
  detail?: string | null;
}

function point(kind: HistoryStepKind, e: AuditEvent, label: string, detail: string | null, tone: HistoryTone = 'neutral'): Draft {
  return { kind, at: e.at, end: e.at, label, detail, tone, actor: e.actor, ...(e.runId ? { runId: e.runId } : {}) };
}

/** the latest of `runs` (sorted by start) whose span holds `at` */
function runHolding(runs: readonly Run[], at: string): Run | undefined {
  const t = ms(at);
  let hit: Run | undefined;
  for (const r of runs) {
    if (ms(r.startedAt) > t) break;
    if (r.endedAt === null || ms(r.endedAt) >= t) hit = r;
  }
  return hit;
}

const byStart = (a: { startedAt: string }, b: { startedAt: string }) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0);

const TURN_SEGS = new Set(['running', 'fixing']);

const CLAIM_LABEL: Record<string, string> = {
  base: 'claimed from the queue',
  'custom-queue': 'claimed from the custom queue',
  overflow: 'claimed as overflow',
};

const WAKE_TONE: Record<string, HistoryTone> = {
  parked: 'warn',
  'left-to-cli': 'info',
  'cli-resumed': 'good',
  resumed: 'good',
  'handed-off': 'bad',
  'cli-abandoned': 'warn',
  skipped: 'neutral',
  refused: 'bad',
  failed: 'bad',
};

function reviewTone(state: string | undefined, verdict: string | undefined, skipped: string | undefined): HistoryTone {
  if (skipped) return skipped === 'checks-red' ? 'bad' : 'neutral';
  if (state === 'passed' || verdict === 'clean') return 'good';
  if (state === 'error') return 'bad';
  return 'warn';
}

/**
 * The lifecycle strip of one task, oldest first. Every step kind is read from
 * the row that records it; see docs/timeline.md § Task history for the table.
 */
export function buildTaskHistory(input: TaskHistoryInput): HistoryStep[] {
  const { task, segments } = input;
  const events = [...input.events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const runs = [...input.runs].sort(byStart);
  const workerRuns = runs.filter((r) => r.mode === 'worker' && r.taskId === task.id);
  const reviewRuns = runs.filter((r) => r.mode === 'aux' && r.kind === 'review' && r.subjectId === task.id);
  const compactRuns = runs.filter((r) => r.mode === 'aux' && r.kind === 'compact' && r.subjectId === task.id);
  const steps: Draft[] = [];

  // ── created ──────────────────────────────────────────────────────────────
  const created = events.find((e) => e.kind === 'task.created');
  const agentCreate = events.find((e) => e.kind === 'agent.create');
  const filedBy = task.createdByRun ?? agentCreate?.runId ?? null;
  const depth = num(created?.data?.spawnDepth) ?? task.spawnDepth;
  steps.push({
    kind: 'created',
    at: created?.at ?? task.createdAt,
    end: created?.at ?? task.createdAt,
    actor: created?.actor ?? agentCreate?.actor ?? null,
    label: filedBy ? 'filed by an agent' : 'created',
    detail: filedBy
      ? join(`run ${short(filedBy)}`, `depth ${depth}`, str(agentCreate?.data?.effectiveStatus) && `as ${agentCreate!.data!.effectiveStatus}`, str(agentCreate?.data?.note))
      : join(str(created?.data?.source) ?? task.source, str(created?.data?.status) && `as ${created!.data!.status}`),
    tone: 'neutral',
    ...(filedBy ? { runId: filedBy } : {}),
  });

  // ── segment-backed spans: queued, waiting ────────────────────────────────
  for (const s of segments) {
    if (s.kind === 'queued') {
      steps.push({
        kind: 'queued',
        at: s.start,
        end: s.end,
        label: 'queued',
        detail: join(str(s.data.reason), s.outcome && s.outcome !== 'running' && `then ${s.outcome}`),
        tone: 'neutral',
      });
    } else if (s.kind === 'waiting') {
      const children = num(s.data.children);
      const shells = num(s.data.shells);
      steps.push({
        kind: 'waiting',
        at: s.start,
        end: s.end,
        label: 'waiting on background work',
        detail: join(
          children ? `${children} subagent${children === 1 ? '' : 's'}` : undefined,
          shells ? `${shells} shell${shells === 1 ? '' : 's'}` : undefined,
          str(s.data.ended) && `ended: ${s.data.ended}`,
        ),
        tone: 'info',
      });
    }
  }

  // ── worker runs (turns, fix turns) ───────────────────────────────────────
  const turnSegs = segments.filter((s) => TURN_SEGS.has(s.kind));
  const segsByRun = new Map<string, TimelineSegment[]>();
  for (const s of turnSegs) {
    // a stretch without a run (a prompt typed into a live session) belongs to the run whose PTY was live then
    const id = s.runId ?? runHolding(workerRuns, s.start)?.id;
    if (!id) continue;
    const list = segsByRun.get(id) ?? [];
    list.push(s);
    segsByRun.set(id, list);
  }
  const startedOf = new Map<string, AuditEvent>();
  const killedOf = new Map<string, AuditEvent>();
  for (const e of events) {
    if (!e.runId) continue;
    if (e.kind === 'run.started' && !startedOf.has(e.runId)) startedOf.set(e.runId, e);
    if (e.kind === 'run.killed') killedOf.set(e.runId, e);
  }
  const fixAnnouncements = events.filter((e) => e.kind === 'task.follow-up' && str(e.data?.reason));
  const usedFix = new Set<string>();
  for (const r of workerRuns) {
    const segs = segsByRun.get(r.id) ?? [];
    const startedRow = startedOf.get(r.id);
    const handoff = str(startedRow?.data?.handoff);
    const fixSeg = segs.find((s) => s.kind === 'fixing');
    const fix = fixAnnouncements.find((e) => !usedFix.has(e.id) && ms(r.startedAt) >= ms(e.at) && ms(r.startedAt) - ms(e.at) <= FIX_ANNOUNCE_MS);
    const isFix = !!fixSeg || !!fix;
    if (fix) usedFix.add(fix.id);
    const reason = str(fixSeg?.data.fix) ?? str(fix?.data?.reason);
    const round = fixSeg?.data.round ?? fix?.data?.round;
    const killed = killedOf.get(r.id);
    const publish = r.label === 'publish' || segs.some((s) => s.data.publish === true);
    const loopIteration = num(startedRow?.data?.loopIteration);
    let at = r.startedAt;
    let end: string | null = r.endedAt;
    let durationMs: number | null | undefined;
    if (segs.length) {
      at = segs[0].start < r.startedAt ? segs[0].start : r.startedAt;
      const last = segs[segs.length - 1];
      end = last.end;
      durationMs = segs.reduce<number | null>((sum, s) => {
        if (sum === null) return null;
        if (s.end === null) return input.now ? sum + Math.max(0, ms(input.now) - ms(s.start)) : null;
        return sum + (ms(s.end) - ms(s.start));
      }, 0);
    }
    // `status: 'killed'` alone is no cut: followUp and the landing retire every IDLE terminal that way.
    // A cut turn has a `run.killed` row (cancel, undo, kill, stall, pause) or a turn still open when the PTY ended.
    const lastSeg = segs[segs.length - 1];
    const cutOpen = r.status === 'killed' && r.endedAt !== null && !!lastSeg && (lastSeg.end === null || lastSeg.end > r.endedAt);
    const outcome = killed || cutOpen ? `killed${str(killed?.data?.reason) ? ` (${killed!.data!.reason})` : ''}` : r.exitCode !== null && r.exitCode !== 0 ? `exit ${r.exitCode}` : undefined;
    const runKind: HistoryStepKind = isFix ? 'fix' : 'run';
    const label = publish
      ? 'publish turn'
      : isFix
        ? reason === 'checks'
          ? 'fix turn (checks red)'
          : reason === 'adversarial-review'
            ? 'fix turn (review findings)'
            : 'fix turn'
        : loopIteration !== undefined
          ? `loop iteration ${loopIteration}`
          : 'worker turn';
    steps.push({
      kind: runKind,
      at,
      end,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...sumRuns([r]),
      actor: startedRow?.actor ?? null,
      label,
      detail: join(
        handoff,
        r.model ?? str(startedRow?.data?.model),
        isFix && round !== undefined && round !== null ? `round ${round}` : undefined,
        isFix && Array.isArray(fix?.data?.red) ? `red: ${(fix!.data!.red as unknown[]).join(', ')}` : undefined,
        outcome,
      ),
      runId: r.id,
      tone: outcome ? 'warn' : isFix ? 'info' : 'neutral',
    });
  }
  // a run.killed whose run is not in the list (pruned row): still a fact
  for (const [runId, e] of killedOf) {
    if (runs.some((r) => r.id === runId)) continue;
    steps.push(point('killed', e, 'run killed', join(str(e.data?.reason)), 'warn'));
  }
  // a fix announced but never started (the resume was refused)
  for (const e of fixAnnouncements) {
    if (usedFix.has(e.id)) continue;
    if (workerRuns.some((r) => ms(r.startedAt) >= ms(e.at) && ms(r.startedAt) - ms(e.at) <= FIX_ANNOUNCE_MS)) continue;
    steps.push(point('fix', e, 'fix turn requested', join(str(e.data?.reason), e.data?.round != null && `round ${e.data.round}`), 'warn'));
  }

  // ── compaction terminals (the resume gate) ───────────────────────────────
  for (const r of compactRuns) {
    steps.push({
      kind: 'compact',
      at: r.startedAt,
      end: r.endedAt,
      ...(r.endedAt ? { durationMs: ms(r.endedAt) - ms(r.startedAt) } : {}),
      ...sumRuns([r]),
      actor: 'orchestrator',
      label: 'compacted before resume',
      detail: join(r.model, r.status === 'killed' && 'aborted'),
      runId: r.id,
      tone: r.status === 'killed' ? 'warn' : 'neutral',
    });
  }

  // ── review rounds, check stages ──────────────────────────────────────────
  let prevReviewAt = '';
  for (const e of events) {
    if (e.kind !== 'run.reviewed') continue;
    const d = e.data ?? {};
    const skipped = str(d.skipped);
    const seg = segments.find((s) => s.kind === 'review-round' && s.end === e.at);
    const mine = skipped ? [] : reviewRuns.filter((r) => r.startedAt <= e.at && r.startedAt > prevReviewAt && (!seg || r.startedAt >= seg.start));
    if (!skipped) prevReviewAt = e.at;
    const findings = Array.isArray(d.findings) ? d.findings.length : undefined;
    const state = str(d.state);
    const verdict = str(d.verdict);
    let at = e.at;
    let durationMs: number | undefined;
    if (seg) {
      at = seg.start;
      durationMs = ms(e.at) - ms(seg.start);
    } else if (mine.length) {
      at = mine[0].startedAt;
      durationMs = ms(e.at) - ms(at);
    }
    steps.push({
      kind: 'review',
      at,
      end: e.at,
      durationMs: durationMs ?? 0,
      ...sumRuns(mine),
      actor: str(d.requestedBy) ?? e.actor,
      label: skipped
        ? skipped === 'checks-red'
          ? 'review skipped: checks red'
          : `review skipped: ${skipped === 'unchanged-diff' ? 'unchanged diff' : skipped === 'empty-diff' ? 'no change' : skipped}`
        : `review round${num(d.round) !== undefined ? ` ${d.round}` : ''}: ${state ?? verdict ?? 'done'}`,
      detail: skipped
        ? join(str(d.stop))
        : join(verdict, findings !== undefined && `${findings} finding${findings === 1 ? '' : 's'}`, str(d.model), num(d.fixRound) ? `after fix ${d.fixRound}` : undefined, str(d.requestedBy) && 'requested'),
      ...(mine.length ? { runId: mine[mine.length - 1].id } : {}),
      tone: reviewTone(state, verdict, skipped),
    });
  }
  for (const e of events) {
    if (e.kind !== 'task.checked') continue;
    const d = e.data ?? {};
    const skipped = str(d.skipped);
    const state = str(d.state);
    const results = Array.isArray(d.results) ? (d.results as Record<string, unknown>[]) : [];
    const seg = segments.find((s) => s.kind === 'checks' && s.end === e.at);
    let at = e.at;
    let durationMs = 0;
    if (seg) {
      at = seg.start;
      durationMs = ms(e.at) - ms(seg.start);
    } else {
      // a loop's checks run while `running`: the results carry their own times
      const sum = results.reduce((n, r) => n + (num(r.durationMs) ?? 0), 0);
      if (sum > 0) {
        at = new Date(ms(e.at) - sum).toISOString();
        durationMs = sum;
      }
    }
    steps.push({
      kind: 'checks',
      at,
      end: e.at,
      durationMs,
      actor: e.actor,
      label: skipped ? `checks skipped: ${skipped === 'unchanged-diff' ? 'unchanged diff' : skipped === 'empty-diff' ? 'no change' : skipped}` : `checks ${state ?? 'ran'}${num(d.round) !== undefined ? ` (round ${d.round})` : ''}`,
      detail: join(
        results.length ? results.map((r) => `${String(r.name ?? '?')} ${String(r.outcome ?? '')}`.trim()).join(', ') : undefined,
        str(d.stop) && `stopped: ${d.stop}`,
      ),
      tone: skipped ? 'neutral' : state === 'green' ? 'good' : state === 'red' ? 'bad' : 'warn',
    });
  }

  // ── questions (asked → answered / auto-picked / expired) ─────────────────
  const questions = new Map<string, { asked?: AuditEvent; end?: AuditEvent; skips: AuditEvent[] }>();
  for (const e of events) {
    if (!e.kind.startsWith('question.')) continue;
    const id = str(e.data?.questionId) ?? e.id;
    const q = questions.get(id) ?? { skips: [] };
    if (e.kind === 'question.asked') q.asked ??= e;
    else if (e.kind === 'question.autopilot') q.skips.push(e);
    else if (!q.end) q.end = e; // answered | expired: the first settles it
    questions.set(id, q);
  }
  for (const q of questions.values()) {
    const first = q.asked ?? q.end ?? q.skips[0];
    if (!first) continue;
    const texts = Array.isArray(q.asked?.data?.questions) ? (q.asked!.data!.questions as unknown[]).filter((t): t is string => typeof t === 'string') : [];
    // never `data.answers`: it may be a redacted secret
    const end = q.end;
    const autopicked = end?.kind === 'question.answered' && end.data?.policy === 'autopilot';
    const label = !end
      ? 'question waiting for an answer'
      : end.kind === 'question.expired'
        ? 'question expired'
        : autopicked
          ? 'question auto-picked'
          : 'question answered';
    const lastSkip = q.skips[q.skips.length - 1];
    steps.push({
      kind: 'question',
      at: first.at,
      end: end?.at ?? null,
      ...(end ? { durationMs: ms(end.at) - ms(first.at) } : {}),
      actor: end?.actor ?? first.actor,
      label,
      detail: join(
        texts.length ? clip(texts[0], QUESTION_CHARS) : undefined,
        texts.length > 1 && `+${texts.length - 1} more`,
        end?.kind === 'question.answered' && !autopicked && `by ${end.actor}`,
        end?.kind === 'question.expired' && str(end.data?.note),
        lastSkip && !autopicked && str(lastSkip.data?.reason) && `autopilot skipped: ${lastSkip.data!.reason}`,
      ),
      ...(first.runId ? { runId: first.runId } : {}),
      tone: !end ? 'info' : end.kind === 'question.expired' ? 'warn' : autopicked ? 'info' : 'good',
    });
  }

  // ── dispatches, both directions ──────────────────────────────────────────
  if (input.dispatches) {
    for (const d of input.dispatches) {
      const sent = d.fromTaskId === task.id;
      if (!sent && d.toTaskId !== task.id) continue;
      const end = d.deliveredAt ?? (d.status === 'pending' ? null : d.createdAt);
      steps.push({
        kind: 'dispatch',
        at: d.createdAt,
        end,
        ...(end ? { durationMs: Math.max(0, ms(end) - ms(d.createdAt)) } : {}),
        actor: sent ? 'agent' : null,
        label: sent ? `dispatch sent to ${short(d.toTaskId)}` : `dispatch received from ${short(d.fromTaskId)}`,
        detail: join(d.intent === 'fyi' ? 'fyi' : 'needs action', d.status, d.note),
        ...(sent && d.fromRunId ? { runId: d.fromRunId } : {}),
        tone: d.status === 'failed' ? 'bad' : d.status === 'pending' ? 'info' : 'neutral',
      });
    }
  } else {
    // only the receiving side is on this task's rows
    const byId = new Map<string, AuditEvent[]>();
    for (const e of events) {
      if (e.kind !== 'task.dispatch') continue;
      const id = str(e.data?.dispatchId) ?? e.id;
      byId.set(id, [...(byId.get(id) ?? []), e]);
    }
    for (const rows of byId.values()) {
      const made = rows.find((e) => e.data?.phase === 'created') ?? rows[0];
      const settled = rows.find((e) => e !== made && e.data?.phase !== 'created');
      const phase = str(settled?.data?.phase) ?? 'pending';
      steps.push({
        kind: 'dispatch',
        at: made.at,
        end: settled?.at ?? null,
        ...(settled ? { durationMs: ms(settled.at) - ms(made.at) } : {}),
        actor: made.actor,
        label: `dispatch received from ${short(str(made.data?.fromTaskId))}`,
        detail: join(made.data?.intent === 'fyi' ? 'fyi' : made.data?.intent ? 'needs action' : undefined, phase, str(settled?.data?.note)),
        tone: phase === 'failed' ? 'bad' : phase === 'pending' ? 'info' : 'neutral',
      });
    }
  }

  // ── everything else is a point on the strip ──────────────────────────────
  const retries = events.filter((e) => e.kind === 'task.retry');
  for (const e of events) {
    const d = e.data ?? {};
    switch (e.kind) {
      case 'task.transition': {
        const to = str(d.to);
        const from = str(d.from);
        const reason = str(d.reason);
        if (to === 'running' && from === 'queued' && str(d.claim)) {
          steps.push(point('claimed', e, CLAIM_LABEL[d.claim as string] ?? `claimed (${d.claim})`, null, 'neutral'));
        } else if (to === 'done' || to === 'published') {
          const landing = str(d.landing);
          const auto = !!landing && e.actor === 'orchestrator';
          steps.push(
            point(
              'landed',
              e,
              auto ? `auto-landed: ${to}` : to === 'published' ? 'published' : 'done',
              join(landing, reason, d.observed === true && 'observed push', str(d.sha) && short(d.sha as string)),
              'good',
            ),
          );
        } else if (to === 'failed') {
          // the error is on the task row, not the transition; a later retry carries the one it cleared
          const retry = retries.find((r) => r.id > e.id);
          const error = reason ?? (retry ? str(retry.data?.previousError) : task.status === 'failed' ? (task.error ?? undefined) : undefined);
          steps.push(point('failed', e, 'failed', error ?? null, 'bad'));
        } else if (to === 'cancelled') {
          steps.push(point('cancelled', e, 'cancelled', reason ?? null, 'neutral'));
        } else if (reason === 'pause all') {
          steps.push(point('paused', e, 'paused (pause all)', join(from && `${from} → ${to}`), 'warn'));
        }
        break;
      }
      case 'schedule.overflow-claim': {
        // never written today (an overflow claim is `claim: 'overflow'` on the transition); kept for older/future rows
        const near = events.some((x) => x.kind === 'task.transition' && x.data?.claim && Math.abs(ms(x.at) - ms(e.at)) <= 5_000);
        if (!near) steps.push(point('claimed', e, CLAIM_LABEL.overflow, null, 'neutral'));
        break;
      }
      case 'task.wake': {
        const action = str(d.action) ?? 'wake';
        const label =
          action === 'parked'
            ? 'parked on the usage limit'
            : action === 'left-to-cli'
              ? 'left to the CLI to continue'
              : action === 'cli-resumed'
                ? 'CLI continued after the limit'
                : action === 'cli-abandoned'
                  ? 'CLI did not continue'
                  : action === 'handed-off'
                    ? 'wake handed to the human'
                    : action === 'resumed'
                      ? 'woken after the limit'
                      : `wake ${action}`;
        steps.push(point('wake', e, label, join(str(d.wakeAt) && `until ${d.wakeAt}`, str(d.reason), str(d.error)), WAKE_TONE[action] ?? 'neutral'));
        break;
      }
      case 'run.transient-retry': {
        const action = str(d.action) ?? 'retry';
        steps.push(
          point(
            'transient',
            e,
            `API error${str(d.code) ? ` ${d.code}` : ''}: ${action}`,
            join(num(d.attempt) !== undefined && `attempt ${d.attempt}`, str(d.delivery), str(d.reason), str(d.why), str(d.error)),
            action === 'resumed' ? 'info' : action === 'skipped' ? 'neutral' : 'bad',
          ),
        );
        break;
      }
      case 'run.stop-failure':
        steps.push(point('stop-failure', e, `stopped on ${str(d.code) ?? 'an API error'}`, join(str(d.action), str(d.message)), str(d.action) === 'failed' || str(d.action) === 'exhausted' ? 'bad' : 'warn'));
        break;
      case 'run.auto-compact':
        steps.push(point('auto-compact', e, 'compacted mid-run', join(num(d.contextTokens) !== undefined && `at ${Math.round((d.contextTokens as number) / 1000)}k tokens`, str(d.trigger)), 'info'));
        break;
      case 'task.queue': {
        const action = str(d.action);
        if (action === 'reorder') break; // drags are noise on a life strip
        steps.push(point('queue', e, action === 'remove' ? 'removed from the custom queue' : 'added to the custom queue', null, 'neutral'));
        break;
      }
      case 'task.loop': {
        const phase = str(d.phase);
        if (phase === 'started') break; // the iteration's run step says it
        steps.push(
          point(
            'loop',
            e,
            phase === 'ended' ? `loop iteration ${d.n ?? '?'} ended` : phase === 'continued' ? 'loop continued' : `loop ${phase ?? 'step'}`,
            join(d.goalMet === true && 'goal met', str(d.checks) && `checks ${d.checks}`, str(d.stop) && `stop: ${d.stop}`, num(d.metric) !== undefined && `metric ${d.metric}`),
            d.goalMet === true ? 'good' : str(d.stop) ? 'warn' : 'neutral',
          ),
        );
        break;
      }
      case 'task.budget':
        steps.push(point('budget', e, `budget fuse: ${str(d.refused) ?? 'refused'}`, join(str(d.fuse), num(d.spentUsd) !== undefined && `$${(d.spentUsd as number).toFixed(2)} of $${num(d.capUsd)?.toFixed(2) ?? '?'}`), 'bad'));
        break;
      case 'agent.close':
        steps.push(point('closed', e, `closed by an agent: ${str(d.to) ?? ''}`.trim(), join(str(d.reason), str(d.via)), 'neutral'));
        break;
      case 'task.worktree': {
        const action = str(d.action) ?? 'worktree';
        steps.push(point('worktree', e, `worktree ${action}`, join(str(d.branch), str(d.why), str(d.error), d.staleBase === true && 'stale base'), action.endsWith('failed') ? 'bad' : 'neutral'));
        break;
      }
      case 'task.pr': {
        const action = str(d.action) ?? 'pr';
        steps.push(
          point('pr', e, `PR ${num(d.number) !== undefined ? `#${d.number} ` : ''}${action}`, join(str(d.url), str(d.why), str(d.error)), action.endsWith('failed') || action === 'merge-unconfirmed' ? 'bad' : action === 'merged' ? 'good' : 'neutral'),
        );
        break;
      }
      case 'task.landing': {
        const phase = str(d.phase);
        steps.push(
          point('landing', e, phase === 'held' ? 'landing held' : phase === 'publish' ? 'auto-publishing' : phase === 'refused' ? 'landing refused' : `landing ${phase ?? ''}`.trim(), join(str(d.landing), str(d.reason), str(d.why), str(d.error)), phase === 'refused' ? 'bad' : 'info'),
        );
        break;
      }
      case 'task.land': {
        const phase = str(d.phase) ?? 'land';
        steps.push(
          point(
            'land',
            e,
            phase === 'pushed' ? 'landed on the default branch' : phase === 'conflict' ? 'land conflict' : phase === 'red' ? 'land re-check red' : `land ${phase}`,
            join(str(d.onto) && `onto ${d.onto}`, str(d.sha) && short(d.sha as string), Array.isArray(d.files) && `${d.files.length} file${d.files.length === 1 ? '' : 's'}`, str(d.error), str(d.detail)),
            phase === 'pushed' ? 'good' : phase === 'conflict' || phase === 'red' || (phase === 'checkout' && d.ok === false) ? 'bad' : phase === 'raced' ? 'warn' : 'neutral',
          ),
        );
        break;
      }
      case 'task.publish': {
        const phase = str(d.phase) ?? 'publish';
        steps.push(
          point(
            'publish',
            e,
            phase === 'start' ? 'publish started' : `publish ${phase}`,
            join(str(d.delivery), str(d.branch), str(d.reason), str(d.error)),
            phase === 'published' ? 'good' : phase === 'failed' || phase === 'refused' ? 'bad' : phase === 'incomplete' ? 'warn' : 'neutral',
          ),
        );
        break;
      }
      case 'task.shipped':
        steps.push(point('shipped', e, 'push seen on the remote', join(str(d.sha) && short(d.sha as string), str(d.ref), d.pushedBeforeReview === true && 'pushed before review'), d.pushedBeforeReview === true ? 'warn' : 'good'));
        break;
      case 'task.retry':
        steps.push(point('retry', e, d.via === 'run-now' ? 'retried (run now)' : 'retried', str(d.previousError) ?? null, 'warn'));
        break;
      case 'task.undo':
        if (d.action === 'release') steps.push(point('release', e, 'released the hold', join(str(d.queue) && `${d.queue} queue`), 'neutral'));
        else steps.push(point('undo', e, 'start undone', join(str(d.to) && `back to ${d.to}`, d.held === true && 'held'), 'warn'));
        break;
      case 'task.paused':
        steps.push(point('resumed', e, 'resumed after pause', join(str(d.kind), str(d.error)), str(d.error) ? 'bad' : 'info'));
        break;
    }
  }

  const rank = (k: HistoryStepKind) => TIE_RANK[k] ?? TIE_RANK_DEFAULT;
  return steps
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.at < b.s.at ? -1 : a.s.at > b.s.at ? 1 : rank(a.s.kind) - rank(b.s.kind) || a.i - b.i))
    .map(({ s }) => finish(s, input.now));
}

/**
 * Order of steps sharing one instant: the cause before what it starts (a
 * retry re-queues, a claim starts the turn); the rest keep insertion order.
 */
const TIE_RANK: Partial<Record<HistoryStepKind, number>> = { created: 0, retry: 1, undo: 1, release: 1, queued: 2, claimed: 3 };
const TIE_RANK_DEFAULT = 4;

function finish(d: Draft, now: string | undefined): HistoryStep {
  let durationMs = d.durationMs;
  if (durationMs === undefined) {
    if (d.end !== null) durationMs = Math.max(0, ms(d.end) - ms(d.at));
    else durationMs = now ? Math.max(0, ms(now) - ms(d.at)) : null;
  }
  const step: HistoryStep = {
    kind: d.kind,
    at: d.at,
    end: d.end,
    durationMs,
    costUsd: d.costUsd ?? null,
    tokens: d.tokens ?? null,
    actor: d.actor ?? null,
    label: d.label,
    detail: d.detail ?? null,
    tone: d.tone,
  };
  if (d.runId) step.runId = d.runId;
  return step;
}

export interface HistoryTotals {
  /** first step to the last step's end (or `now` while one is open) */
  wallMs: number;
  /** worker turns: the sum of run/fix steps' worked time (waiting excluded) */
  workedMs: number;
  /** every run passed in: worker turns, reviewers, compactions — `Task.costUsd`'s set */
  costUsd: number;
  /** fresh worker sessions (`resumedFrom` null) — what `Task.attempts` counts */
  attempts: number;
}

export function historyTotals(steps: readonly HistoryStep[], runs: readonly Run[], now?: string): HistoryTotals {
  let first = Infinity;
  let last = -Infinity;
  let workedMs = 0;
  for (const s of steps) {
    const a = ms(s.at);
    if (a < first) first = a;
    const e = s.end !== null ? ms(s.end) : now ? ms(now) : a;
    if (e > last) last = e;
    if ((s.kind === 'run' || s.kind === 'fix') && s.durationMs) workedMs += s.durationMs;
  }
  let costUsd = 0;
  let attempts = 0;
  for (const r of runs) {
    costUsd += r.stats?.costUsd ?? 0;
    if (r.mode === 'worker' && r.resumedFrom === null) attempts++;
  }
  return { wallMs: Number.isFinite(first) ? Math.max(0, last - first) : 0, workedMs, costUsd, attempts };
}
