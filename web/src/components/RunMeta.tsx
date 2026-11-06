import { useEffect, useState } from 'react';
import { contextPctOf, formatMb, type Run } from '@tm/shared';
import { useApp } from '../state.tsx';

export function Elapsed({ since, until }: { since: string; until?: string | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (until) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [until]);
  const end = until ? new Date(until).getTime() : Date.now();
  const s = Math.max(0, Math.floor((end - new Date(since).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const txt = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
  return <span className="mono">{txt}</span>;
}

/** Compact usage chips for a run: duration · model · cost · context %. */
/**
 * What the TASK has cost so far (docs/token-budget.md § Fuses): every worker
 * turn plus the review and compact sessions about it — the figure
 * `budget.taskUsd` is measured against. Nothing under a cent is drawn.
 */
export function TaskCostChip({ costUsd }: { costUsd: number }) {
  if (!(costUsd >= 0.01)) return null;
  return (
    <span className="chip task-cost" title="this task so far: every agent turn, plus its reviews and compactions">
      Σ ${costUsd.toFixed(2)}
    </span>
  );
}

/**
 * How many fresh agent sessions the task has had (`Task.attempts`, docs/design.md
 * § Retry with context). `quiet` hides the first — on a board row only a
 * re-attempt is news.
 */
export function TaskAttemptsChip({ attempts, quiet = false }: { attempts: number; quiet?: boolean }) {
  if (!(attempts >= (quiet ? 2 : 1))) return null;
  return (
    <span
      className="chip task-attempts"
      title="fresh agent sessions this task has had (Retry, Run now, a fresh follow-up); resumes are not counted"
    >
      {attempts === 1 ? '1 attempt' : `${attempts} attempts`}
    </span>
  );
}

/**
 * The task's numbers and its latest run's, as ONE quiet line at the top of the
 * task panel (docs/design.md § Task panel head) — read, never acted on, so they
 * are text with separators rather than more chips beside the action buttons.
 */
/**
 * The run's memory (docs/memory.md § Memory per run): its process tree now
 * (live runs, from the 30 s sample in OrchestratorStatus.procMemory) and the
 * peak stored on the run row. Null when never sampled.
 */
export function useRunMemory(run: Run | null): { mb: number | null; peakMb: number } | null {
  const { orch } = useApp();
  if (!run) return null;
  const live = orch.procMemory?.trees.find((t) => t.runId === run.id) ?? null;
  const peak = Math.max(run.peakMemMb ?? 0, live?.peakMb ?? 0);
  if (!live && !(peak > 0)) return null;
  return { mb: live ? live.mb : null, peakMb: peak };
}

export function TaskStatsLine({ costUsd, attempts, run }: { costUsd: number; attempts: number; run: Run | null }) {
  const s = run?.stats;
  const mem = useRunMemory(run);
  const task = [
    costUsd >= 0.01 && (
      <span key="cost" className="so-stat" title="this task so far: every agent turn, plus its reviews and compactions">
        Σ ${costUsd.toFixed(2)}
      </span>
    ),
    attempts >= 1 && (
      <span
        key="attempts"
        className="so-stat"
        title="fresh agent sessions this task has had (Retry, Run now, a fresh follow-up); resumes are not counted"
      >
        {attempts === 1 ? '1 attempt' : `${attempts} attempts`}
      </span>
    ),
  ].filter(Boolean);
  if (!run && task.length === 0) return null;
  return (
    <div className="so-stats">
      {task}
      {run && (
        <span className="so-stat-run" title="the latest agent run">
          <span className="so-stat-label">last run</span>
          <span className="so-stat">
            <Elapsed since={run.startedAt} until={run.endedAt} />
          </span>
          {run.model && <span className="so-stat">{run.model.replace('claude-', '')}</span>}
          {run.effort && <span className="so-stat">{run.effort}</span>}
          {s && (
            <>
              <span className="so-stat" title="estimated from transcript usage">
                ${s.costUsd.toFixed(2)}
              </span>
              <span className="so-stat">{Math.round((s.inputTokens + s.outputTokens) / 1000)}k tok</span>
              <span className="so-stat" title="share of the model's context window used">
                ctx {Math.round(contextPctOf(s, run.model))}%
              </span>
            </>
          )}
          {mem && (
            <span
              className="so-stat"
              title="memory of the run's process tree — claude plus everything it started (tsc, dev servers, browsers); sampled every 30 s"
            >
              {mem.mb != null ? `mem ${formatMb(mem.mb)} · peak ${formatMb(mem.peakMb)}` : `peak mem ${formatMb(mem.peakMb)}`}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
