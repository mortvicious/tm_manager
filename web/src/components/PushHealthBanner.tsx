import type { RepoPushHealth } from '@tm/shared';
import { useApp } from '../state.tsx';

/**
 * The board's push-health line (docs/parallel.md § Push health): a `pr` repo
 * the server cannot push to (red — nothing starts or lands there until it
 * passes again), and a repo whose LOCAL base branch has commits origin lacks
 * (amber — new worktrees fork without them). Nothing when every repo is fine.
 * `repoId` narrows it to the repo the board is filtered to.
 */
export function PushHealthBanner({ repoId }: { repoId?: string | null }) {
  const { orch } = useApp();
  const rows = (orch.pushHealth ?? []).filter((h) => !repoId || h.repoId === repoId);
  const failing = rows.filter((h) => !h.ok);
  const ahead = rows.filter((h) => h.ok && (h.localAhead ?? 0) > 0);
  if (!failing.length && !ahead.length) return null;
  return (
    <div className="push-health">
      {failing.map((h) => (
        <div key={h.repoId} className="push-health-row failing" role="alert">
          <strong>{h.repoName}: push to origin fails</strong>
          <span>
            {' '}
            ({h.kind}
            {h.failingSince ? `, since ${since(h.failingSince)}` : ''}) — no new task starts and nothing lands here until it works.
          </span>
          {h.error && <code className="push-health-error">{h.error}</code>}
        </div>
      ))}
      {ahead.map((h) => (
        <div key={h.repoId} className="push-health-row ahead">
          <strong>{h.repoName}</strong>: local {baseName(h)} is {h.localAhead} commit{h.localAhead === 1 ? '' : 's'} ahead of{' '}
          {h.base ?? 'origin'} — new worktrees fork without {h.localAhead === 1 ? 'it' : 'them'}. Push the base branch first.
        </div>
      ))}
    </div>
  );
}

function baseName(h: RepoPushHealth): string {
  return h.base?.replace(/^origin\//, '') ?? 'base';
}

function since(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
