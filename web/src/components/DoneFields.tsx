import { useMemo } from 'react';
import { useApp } from '../state.tsx';

/**
 * A task's definition of done (docs/checks.md): the acceptance text handed to
 * the worker and the reviewer, and which of the repo's checks run after each
 * turn. `checks` null = all of the repo's checks (including ones added later);
 * an explicit list is a pick, [] = none. Two `form-grid` cells.
 */
export function DoneFields({
  repoId,
  acceptance,
  checks,
  onAcceptance,
  onChecks,
}: {
  repoId: string | null;
  acceptance: string;
  checks: string[] | null;
  onAcceptance: (v: string) => void;
  onChecks: (v: string[] | null) => void;
}) {
  const { commands } = useApp();
  const repoChecks = useMemo(
    () => commands.filter((c) => c.repoId === repoId && c.isCheck).sort((a, b) => a.sortOrder - b.sortOrder),
    [commands, repoId],
  );
  const on = (name: string) => checks == null || checks.includes(name);
  const toggle = (name: string) => {
    const current = checks ?? repoChecks.map((c) => c.name);
    const next = current.includes(name) ? current.filter((n) => n !== name) : [...current, name];
    // every check ticked again reads as the default, so later checks apply too
    onChecks(repoChecks.every((c) => next.includes(c.name)) ? null : next);
  };
  // a stored pick that names no current check (renamed/deleted) — kept, shown
  const stale = (checks ?? []).filter((n) => !repoChecks.some((c) => c.name === n));

  return (
    <>
      <div className="wide">
        <label className="label">Definition of done</label>
        <textarea
          className="field"
          rows={2}
          placeholder="What must be true when this is finished (optional) — the agent works to it, the reviewer judges against it"
          value={acceptance}
          onChange={(e) => onAcceptance(e.target.value)}
        />
      </div>
      {repoId && (
        <div className="wide">
          <label className="label">Checks</label>
          {repoChecks.length === 0 ? (
            <div className="hint">
              This repo has no checks. Mark a command as a <i>check</i> on the Repos page and it runs after every agent
              turn, before the review.
            </div>
          ) : (
            <>
              <div className="done-checks">
                {repoChecks.map((c) => (
                  <label key={c.id} className="done-check" title={c.command}>
                    <input type="checkbox" checked={on(c.name)} onChange={() => toggle(c.name)} />
                    <span className="mono">{c.name}</span>
                  </label>
                ))}
                {stale.map((n) => (
                  <span key={n} className="done-check muted" title="no check has this name any more — ignored">
                    <s className="mono">{n}</s>
                  </span>
                ))}
              </div>
              <div className="hint">
                {checks == null
                  ? 'All of the repo’s checks (the default, including ones added later). Red ones go back to the agent to fix.'
                  : checks.length === 0
                    ? 'No checks for this task.'
                    : 'Only the ticked checks run for this task.'}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
