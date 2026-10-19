import { useEffect, useState } from 'react';
import type { Run } from '@tm/shared';

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

export function RunStatsChips({ run }: { run: Run }) {
  const s = run.stats;
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <span className="chip">
        <Elapsed since={run.startedAt} until={run.endedAt} />
      </span>
      {run.model && <span className="chip">{run.model.replace('claude-', '')}</span>}
      {run.effort && <span className="chip">effort {run.effort}</span>}
      {s && (
        <>
          <span className="chip" title="estimated from transcript usage">${s.costUsd.toFixed(3)}</span>
          <span className="chip">
            {Math.round((s.inputTokens + s.outputTokens) / 1000)}k tok
          </span>
          <span className="chip" title="share of the model's context window used">
            ctx {Math.round(s.contextPct)}%
          </span>
        </>
      )}
    </span>
  );
}
