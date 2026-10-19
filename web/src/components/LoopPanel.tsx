import { useEffect, useState } from 'react';
import { LOOP_DEFAULT_MAX_ITERATIONS, LOOP_MAX_ITERATIONS_LIMIT, type LoopIteration, type LoopState, type Task } from '@tm/shared';
import { api } from '../api.ts';
import { Markdown } from './Markdown.tsx';

// Loop tasks (docs/loops.md): a goal worked in fresh sessions, one per
// iteration, over a ledger the agent keeps. The card shows the counter and a
// sparkline of the check metric; the panel shows the iterations, the ledger
// and Continue.

const STATE_TEXT: Record<LoopState, string> = {
  iterating: 'iteration running',
  checking: 'checking the iteration',
  next: 'next iteration due',
  met: 'goal met',
  'max-iterations': 'out of iterations',
  budget: 'budget spent',
  'no-progress': 'stopped — no progress',
  paused: 'paused',
  error: 'stopped — error',
};

export const loopMax = (t: Pick<Task, 'loopMaxIterations'>) => t.loopMaxIterations ?? LOOP_DEFAULT_MAX_ITERATIONS;

/**
 * The check metric per iteration as a polyline: TM_METRIC when the checks
 * print one, else the number of green checks. Nothing to draw below two points.
 */
export function LoopSparkline({ history, width = 56, height = 14 }: { history: LoopIteration[]; width?: number; height?: number }) {
  const pts = history.filter((h) => h.metric !== null);
  if (pts.length < 2) return null;
  const vals = pts.map((h) => h.metric as number);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const pad = 2;
  const xy = vals.map((v, i) => [
    pad + (i * (width - 2 * pad)) / (vals.length - 1),
    hi === lo ? height / 2 : pad + (1 - (v - lo) / span) * (height - 2 * pad),
  ]);
  const last = xy[xy.length - 1];
  const source = pts[pts.length - 1].metricSource === 'tm-metric' ? 'TM_METRIC' : 'green checks';
  return (
    <svg
      className="loop-spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${source} per iteration: ${vals.join(', ')}`}
    >
      <title>{`${source} per iteration: ${vals.join(' → ')}`}</title>
      <polyline points={xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')} />
      <circle cx={last[0]} cy={last[1]} r={1.8} />
    </svg>
  );
}

/** The board card's loop chip: iteration counter + sparkline. */
export function LoopChip({ task }: { task: Task }) {
  if (task.kind !== 'loop') return null;
  const state = task.loopState;
  return (
    <span
      className={`chip loop-chip${state === 'met' ? ' loop-met' : ''}`}
      title={`loop task — iteration ${task.loopIteration} of ${loopMax(task)}${state ? ` · ${STATE_TEXT[state]}` : ''}`}
    >
      ↻ {task.loopIteration}/{loopMax(task)}
      <LoopSparkline history={task.loopHistory} />
    </span>
  );
}

/** The loop's own fields in the new-task form (two `form-grid` cells). */
export function LoopFields({
  goal,
  maxIterations,
  budgetUsd,
  onGoal,
  onMaxIterations,
  onBudgetUsd,
}: {
  goal: string;
  maxIterations: string;
  budgetUsd: string;
  onGoal: (v: string) => void;
  onMaxIterations: (v: string) => void;
  onBudgetUsd: (v: string) => void;
}) {
  return (
    <>
      <div className="wide">
        <label className="label">Loop goal</label>
        <textarea
          className="field"
          rows={2}
          placeholder="What the loop works toward, e.g. “every tsc --strict error in web/ fixed” — each iteration is a fresh agent reading the ledger"
          value={goal}
          onChange={(e) => onGoal(e.target.value)}
        />
      </div>
      <div className="loop-limits wide">
        <label className="label">
          Max iterations
          <input
            className="field"
            type="number"
            min={1}
            max={LOOP_MAX_ITERATIONS_LIMIT}
            value={maxIterations}
            placeholder={String(LOOP_DEFAULT_MAX_ITERATIONS)}
            onChange={(e) => onMaxIterations(e.target.value)}
          />
        </label>
        <label className="label">
          Budget (USD)
          <input
            className="field"
            type="number"
            min={0.5}
            step={0.5}
            value={budgetUsd}
            placeholder="required"
            onChange={(e) => onBudgetUsd(e.target.value)}
          />
        </label>
      </div>
    </>
  );
}

/** Parse the form's strings into the API's loop fields; a string = what is wrong. */
export function loopInput(goal: string, maxIterations: string, budgetUsd: string):
  | { loopGoal: string; loopMaxIterations: number; loopBudgetUsd: number }
  | string {
  if (!goal.trim()) return 'a loop needs a goal';
  const max = maxIterations.trim() ? Number(maxIterations) : LOOP_DEFAULT_MAX_ITERATIONS;
  if (!Number.isInteger(max) || max < 1 || max > LOOP_MAX_ITERATIONS_LIMIT) return `max iterations: 1..${LOOP_MAX_ITERATIONS_LIMIT}`;
  const budget = Number(budgetUsd);
  if (!budgetUsd.trim() || !(budget > 0)) return 'a loop needs a budget in USD';
  return { loopGoal: goal.trim(), loopMaxIterations: max, loopBudgetUsd: budget };
}

const CONTINUABLE: LoopState[] = ['max-iterations', 'budget', 'no-progress', 'paused', 'error'];

/**
 * The task panel's loop section: where it stands, the limits (editable),
 * Continue, every iteration, and the ledger the agent keeps.
 */
export function LoopPanel({ task, onError }: { task: Task; onError: (msg: string) => void }) {
  const [ledger, setLedger] = useState<string | null>(null);
  const [max, setMax] = useState(String(loopMax(task)));
  const [budget, setBudget] = useState(task.loopBudgetUsd != null ? String(task.loopBudgetUsd) : '');
  const [busy, setBusy] = useState(false);
  const lastN = task.loopHistory.at(-1)?.n;
  useEffect(() => {
    setMax(String(loopMax(task)));
    setBudget(task.loopBudgetUsd != null ? String(task.loopBudgetUsd) : '');
  }, [task.loopMaxIterations, task.loopBudgetUsd]);
  // re-read after every iteration (the ledger is rewritten by each one)
  useEffect(() => {
    let live = true;
    api
      .loopLedger(task.id)
      .then((r) => live && setLedger(r.text))
      .catch(() => live && setLedger(null));
    return () => {
      live = false;
    };
  }, [task.id, lastN, task.loopState]);
  if (task.kind !== 'loop') return null;

  const canContinue =
    !!task.loopState && CONTINUABLE.includes(task.loopState) && ['review', 'failed', 'cancelled'].includes(task.status);
  const limitsChanged = Number(max) !== loopMax(task) || Number(budget) !== (task.loopBudgetUsd ?? NaN);
  const saveLimits = async () => {
    setBusy(true);
    try {
      await api.updateTask(task.id, { loopMaxIterations: Number(max), loopBudgetUsd: Number(budget) });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const go = async () => {
    setBusy(true);
    try {
      await api.continueLoop(task.id);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="loop-panel">
      <div className="section-head">
        Loop
        <span className="muted mono">
          {' '}
          · iteration {task.loopIteration}/{loopMax(task)}
          {task.loopState ? ` · ${STATE_TEXT[task.loopState]}` : ' · not started'}
          {task.loopBudgetUsd != null ? ` · $${task.costUsd.toFixed(2)} of $${task.loopBudgetUsd.toFixed(2)}` : ''}
        </span>
        <LoopSparkline history={task.loopHistory} width={80} height={18} />
      </div>
      {task.loopGoal && <div className="loop-goal">{task.loopGoal}</div>}
      <div className="loop-limits">
        <label className="label">
          Max iterations
          <input
            className="field"
            type="number"
            min={1}
            max={LOOP_MAX_ITERATIONS_LIMIT}
            value={max}
            onChange={(e) => setMax(e.target.value)}
          />
        </label>
        <label className="label">
          Budget (USD)
          <input className="field" type="number" min={0.5} step={0.5} value={budget} onChange={(e) => setBudget(e.target.value)} />
        </label>
        {limitsChanged && (
          <button className="btn" disabled={busy} onClick={() => void saveLimits()}>
            Save limits
          </button>
        )}
        {canContinue && (
          <button className="btn primary" disabled={busy} onClick={() => void go()} title="start the next iteration (a fresh agent reading the ledger)">
            Continue loop
          </button>
        )}
      </div>
      {task.loopHistory.length > 0 && (
        <table className="loop-iterations">
          <thead>
            <tr>
              <th>#</th>
              <th>checks</th>
              <th>goal</th>
              <th>metric</th>
              <th>Σ $</th>
              <th>note</th>
            </tr>
          </thead>
          <tbody>
            {task.loopHistory.map((h) => (
              <tr key={h.n} className={h.noProgress ? 'loop-np' : undefined}>
                <td className="mono">{h.n}</td>
                <td>
                  <span className={`check-outcome co-${h.checkState ?? 'none'}`}>{h.checkState ?? '—'}</span>
                </td>
                <td>{h.goalMet === true ? 'met' : h.goalMet === false ? 'not yet' : '?'}</td>
                <td className="mono">{h.metric ?? '—'}</td>
                <td className="mono">{h.costUsd.toFixed(2)}</td>
                <td>
                  {h.note ?? ''}
                  {h.noProgress && <span className="muted"> · no progress</span>}
                  {h.handoff && <span className="muted"> · leftovers committed</span>}
                  {h.stop && <span className="muted"> · {STATE_TEXT[h.stop]}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <details className="loop-ledger" open={!!ledger}>
        <summary className="muted">Ledger · progress.md</summary>
        {ledger ? <Markdown label="loop ledger" text={ledger} /> : <div className="hint">No ledger yet — the first iteration writes it.</div>}
      </details>
    </div>
  );
}

