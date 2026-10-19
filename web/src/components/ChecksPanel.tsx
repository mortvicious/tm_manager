import type { CheckResult, Task } from '@tm/shared';
import { useApp } from '../state.tsx';
import { IconTerminal } from './Icons.tsx';

const STATE_TEXT: Record<NonNullable<Task['checkState']>, string> = {
  pending: 'checks due — they run before the review',
  running: 'checks running',
  green: 'checks green',
  red: 'checks red',
  error: 'checks gave no verdict',
};

function outcomeText(r: CheckResult): string {
  const flaky = r.retried ? (r.outcome === 'green' ? ' · red once, green on the re-run' : ' · red twice') : '';
  const how = r.outcome === 'error' ? (r.error ?? 'no verdict') : `exit ${r.exit ?? '?'}`;
  return `${how} · ${Math.round(r.durationMs / 1000)}s${flaky}`;
}

/**
 * The repo checks of this task's latest change (docs/checks.md): where they
 * stand and each check's result, with its output tail. The run itself is an
 * ordinary command run, so its terminal opens while the PTY is kept.
 */
export function ChecksPanel({ task, onOpenTerminal }: { task: Task; onOpenTerminal: (runId: string) => void }) {
  const { commandRuns } = useApp();
  if (!task.checkState && task.checkResults.length === 0) return null;
  const live = commandRuns.find((r) => r.checkTaskId === task.id && r.status === 'running');
  return (
    <div className="checks-panel">
      <div className="section-head">
        Repo checks
        {task.checkState && <span className={`checks-state cs-${task.checkState}`}> · {STATE_TEXT[task.checkState]}</span>}
        {live && (
          <button className="btn ghost checks-live" onClick={() => onOpenTerminal(live.id)} title="Watch the check that is running">
            <IconTerminal /> {live.name}
          </button>
        )}
      </div>
      {task.checkResults.map((r) => {
        const kept = r.runId ? commandRuns.find((x) => x.id === r.runId) : undefined;
        return (
          <details key={r.name} className="check-row" open={r.outcome !== 'green'}>
            <summary>
              <span className={`check-outcome co-${r.outcome}`}>{r.outcome}</span>{' '}
              <span className="mono">{r.name}</span> <span className="muted mono">{outcomeText(r)}</span>
              {kept && (
                <button
                  className="btn ghost"
                  title="Open this check's terminal"
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenTerminal(kept.id);
                  }}
                >
                  <IconTerminal />
                </button>
              )}
            </summary>
            <pre className="check-tail">{r.tail.trim() || '(no output)'}</pre>
          </details>
        );
      })}
    </div>
  );
}
