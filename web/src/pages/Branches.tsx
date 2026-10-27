import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BranchCommit,
  BranchesOverview,
  EssentialBranchState,
  MergeTarget,
  RepoBranchState,
  WorkBranchState,
  WorktreeState,
} from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { fmtAgo, useNow } from '../components/TimeAgo.tsx';

/**
 * Branches (docs/branches.md): per repo, what is merged into an essential
 * branch (main, staging, …) and on the remote, versus what exists only on
 * this machine — essential commits not pushed, work in worktrees and branches
 * that no essential branch has yet, uncommitted files.
 *
 * Read from git on request (a few seconds on a big repo), so nothing polls:
 * it loads on open, on Refresh, and when the tab comes back after a while.
 * Fetch asks the remote first; without it the remote side is only as fresh as
 * the last fetch, which each repo shows.
 */

/** a remote read older than this is called out — "pushed" is only as true as the last fetch */
const STALE_FETCH_MS = 24 * 3600_000;
const REVISIT_MS = 60_000;

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : '');

/** `/Users/me/dev/app.worktrees/1a2b3c4d` → `app.worktrees/1a2b3c4d` */
function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

function dirtyText(wt: WorktreeState | undefined): string | null {
  if (!wt || (!wt.changed && !wt.untracked)) return null;
  return [wt.changed && `${wt.changed} changed`, wt.untracked && `${wt.untracked} untracked`].filter(Boolean).join(' · ');
}

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

function CommitList({ commits, total }: { commits: BranchCommit[]; total: number }) {
  if (!commits.length) return null;
  return (
    <ul className="br-commits">
      {commits.map((c) => (
        <li key={c.sha}>
          <span className="mono br-sha">{short(c.sha)}</span> {c.subject}
        </li>
      ))}
      {total > commits.length && <li className="muted">… and {total - commits.length} more</li>}
    </ul>
  );
}

function targetText(t: MergeTarget, remote: string | null): string {
  const where = !remote ? t.branch : t.where === 'remote' ? `${remote}/${t.branch}` : `local ${t.branch}`;
  return t.how === 'ancestor' ? where : `${where} (${t.how === 'squash' ? 'squashed' : 'same patches'})`;
}

/** where a merged branch's work lives — the remote copy when it is there, else the local one, flagged */
function mergedWhere(b: WorkBranchState, remote: string | null): { text: string; localOnly: boolean } {
  const onRemote = b.mergedInto.filter((t) => t.where === 'remote');
  const shown = onRemote.length ? onRemote : b.mergedInto;
  return { text: shown.map((t) => targetText(t, remote)).join(', '), localOnly: !onRemote.length };
}

function EssentialRow({ e, repo, worktree }: { e: EssentialBranchState; repo: RepoBranchState; worktree?: WorktreeState }) {
  const remoteName = repo.remote ? `${repo.remote}/${e.name}` : null;
  const chips: { text: string; tone: 'ok' | 'warn' | 'muted' | 'local' }[] = [];
  if (!repo.remote) chips.push({ text: 'no remote', tone: 'muted' });
  else if (!e.localSha) chips.push({ text: `only on ${repo.remote}`, tone: 'muted' });
  else if (!e.remoteSha) chips.push({ text: `not on ${repo.remote} · ${plural(e.unpushedCount, 'commit')} on no remote`, tone: 'local' });
  else {
    if (e.unpushedCount) chips.push({ text: `${plural(e.unpushedCount, 'commit')} not pushed`, tone: 'local' });
    if (e.behind) chips.push({ text: `${e.behind} behind ${remoteName}`, tone: 'warn' });
    if (!e.unpushedCount && !e.behind) chips.push({ text: `in sync with ${remoteName}`, tone: 'ok' });
  }
  const dirty = dirtyText(worktree);
  if (dirty) chips.push({ text: `uncommitted: ${dirty}`, tone: 'local' });
  return (
    <div className="br-row">
      <div className="br-row-head">
        <span className="mono br-name">{e.name}</span>
        {e.isDefault && <span className="chip">default</span>}
        {worktree && !worktree.isMain && <span className="chip mono" title={worktree.path}>{shortPath(worktree.path)}</span>}
        {chips.map((c) => (
          <span key={c.text} className={`chip br-tone-${c.tone}`}>
            {c.text}
          </span>
        ))}
      </div>
      {e.unpushed.length > 0 && (
        <details className="br-details">
          <summary>{e.remoteSha ? `Not on ${remoteName}` : 'On no remote'}</summary>
          <CommitList commits={e.unpushed} total={e.unpushedCount} />
        </details>
      )}
    </div>
  );
}

function WorkRow({
  b,
  repo,
  worktree,
  onOpenTask,
}: {
  b: WorkBranchState;
  repo: RepoBranchState;
  worktree?: WorktreeState;
  onOpenTask: (id: string) => void;
}) {
  const now = useNow();
  const dirty = dirtyText(worktree);
  const chips: { text: string; tone: 'ok' | 'warn' | 'muted' | 'local'; title?: string }[] = [];
  if (b.state === 'unmerged') {
    chips.push({ text: `${plural(b.pendingCount, 'commit')} not merged`, tone: 'warn', title: 'in no essential branch, local or remote' });
    if (!repo.remote) {
      // nothing to push to — "local only" would be noise
    } else if (b.pendingLocalOnly === b.pendingCount && !b.remoteRef) {
      chips.push({ text: 'local only — not pushed', tone: 'local' });
    } else if (b.pendingLocalOnly) {
      chips.push({ text: `${b.pendingLocalOnly} not pushed`, tone: 'local', title: b.remoteRef ? `newer than ${b.remoteRef}` : 'on no remote' });
    } else {
      chips.push({ text: `pushed${b.remoteRef ? ` to ${b.remoteRef}` : ''}`, tone: 'ok' });
    }
    if (b.inheritedUnpushed) {
      chips.push({
        text: `built on ${plural(b.inheritedUnpushed, 'unpushed commit')}`,
        tone: 'local',
        title: 'essential-branch commits under this branch that are not on the remote yet',
      });
    }
  } else {
    const where = mergedWhere(b, repo.remote);
    const unpushed = where.localOnly && !!repo.remote;
    // At an essential tip, git cannot tell "never committed on" from "fast-forwarded in".
    // That matters only while the work is not on the remote, so it is named only once it is.
    if (!unpushed && repo.essentials.some((e) => e.remoteSha === b.sha || e.localSha === b.sha)) {
      chips.push({ text: 'no commits of its own', tone: 'muted', title: `at ${where.text}` });
    } else {
      chips.push({
        text: where.text ? `on ${where.text}${unpushed ? ' — not pushed' : ''}` : 'merged',
        tone: unpushed ? 'local' : 'ok',
        title: unpushed ? 'merged locally — the essential branch is not pushed yet' : undefined,
      });
    }
  }
  if (b.behindRemote) chips.push({ text: `${b.behindRemote} behind ${b.remoteRef}`, tone: 'warn' });
  if (dirty) chips.push({ text: `uncommitted: ${dirty}`, tone: 'local' });

  return (
    <div className="br-row">
      <div className="br-row-head">
        <span className="mono br-name">{b.name}</span>
        {chips.map((c) => (
          <span key={c.text} className={`chip br-tone-${c.tone}`} title={c.title}>
            {c.text}
          </span>
        ))}
      </div>
      <div className="br-row-meta">
        {b.taskId && (
          <button className="br-task" onClick={() => onOpenTask(b.taskId!)} title="Open task">
            {b.taskTitle ?? b.taskId.slice(0, 8)}
            {b.taskStatus && <span className="muted"> · {b.taskStatus}</span>}
          </button>
        )}
        <span className="muted" title={worktree?.path}>
          {worktree ? `worktree ${worktree.isMain ? '(main checkout)' : shortPath(worktree.path)}` : 'branch only'}
        </span>
        <span className="muted" title={`${b.sha}\n${b.at}`}>
          <span className="mono">{short(b.sha)}</span> · {fmtAgo(now - Date.parse(b.at))} ago
        </span>
      </div>
      {b.pending.length > 0 && (
        <details className="br-details">
          <summary>Not merged</summary>
          <CommitList commits={b.pending} total={b.pendingCount} />
        </details>
      )}
    </div>
  );
}

function RepoCard({ repo, onOpenTask }: { repo: RepoBranchState; onOpenTask: (id: string) => void }) {
  const now = useNow();
  if (repo.error) {
    return (
      <section className="panel br-repo">
        <div className="br-repo-head">
          <span className="br-repo-name">{repo.repoName}</span>
          <span className="warn-text">{repo.error}</span>
        </div>
      </section>
    );
  }
  const wtByBranch = new Map(repo.worktrees.filter((w) => w.branch).map((w) => [w.branch!, w]));
  const awaiting = repo.branches.filter((b) => b.state === 'unmerged' || dirtyText(wtByBranch.get(b.name)));
  const merged = repo.branches.filter((b) => !awaiting.includes(b));
  const detached = repo.worktrees.filter((w) => !w.branch && !w.prunable);
  const prunable = repo.worktrees.filter((w) => w.prunable);
  const fetchedMs = repo.fetchedAt ? now - Date.parse(repo.fetchedAt) : null;

  return (
    <section className="panel br-repo">
      <div className="br-repo-head">
        <span className="br-repo-name">{repo.repoName}</span>
        <span className="muted mono br-path" title={repo.path}>
          {shortPath(repo.path)}
        </span>
        <span className="br-spacer" />
        {repo.remote ? (
          <span className={fetchedMs === null || fetchedMs > STALE_FETCH_MS ? 'br-stale' : 'muted'} title={repo.fetchedAt ?? 'never fetched'}>
            {repo.remote} · {fetchedMs === null ? 'never fetched' : `fetched ${fmtAgo(fetchedMs)} ago`}
          </span>
        ) : (
          <span className="muted">no remote</span>
        )}
      </div>
      {repo.fetchError && <div className="warn-text br-gap">{repo.fetchError}</div>}

      <h3 className="br-h">Essential branches</h3>
      {repo.essentials.length ? (
        repo.essentials.map((e) => <EssentialRow key={e.name} e={e} repo={repo} worktree={wtByBranch.get(e.name)} />)
      ) : (
        <div className="muted br-gap">No essential branch found (looked for the remote's default, main, master, staging, develop, …).</div>
      )}

      <h3 className="br-h">
        Awaiting merge <span className="muted">{awaiting.length + detached.length}</span>
      </h3>
      {awaiting.length + detached.length === 0 && <div className="muted br-gap">Nothing — every branch is in an essential branch.</div>}
      {awaiting.map((b) => (
        <WorkRow key={b.name} b={b} repo={repo} worktree={wtByBranch.get(b.name)} onOpenTask={onOpenTask} />
      ))}
      {detached.map((w) => (
        <div className="br-row" key={w.path}>
          <div className="br-row-head">
            <span className="mono br-name">detached {short(w.sha)}</span>
            <span className="chip br-tone-warn">no branch</span>
            {dirtyText(w) && <span className="chip br-tone-local">uncommitted: {dirtyText(w)}</span>}
          </div>
          <div className="br-row-meta">
            <span className="muted" title={w.path}>
              worktree {w.isMain ? '(main checkout)' : shortPath(w.path)}
            </span>
          </div>
        </div>
      ))}
      {repo.truncated && <div className="muted br-gap">Only the newest branches were read; older ones without a worktree are not listed.</div>}

      {merged.length > 0 && (
        <details className="br-details br-merged">
          <summary>
            Merged <span className="muted">{merged.length}</span>
          </summary>
          {merged.map((b) => (
            <WorkRow key={b.name} b={b} repo={repo} worktree={wtByBranch.get(b.name)} onOpenTask={onOpenTask} />
          ))}
        </details>
      )}

      {prunable.length > 0 && (
        <div className="muted br-gap">
          {plural(prunable.length, 'worktree')} whose directory is gone ({prunable.map((w) => shortPath(w.path)).join(', ')}) —{' '}
          <span className="mono">git worktree prune</span> drops {prunable.length === 1 ? 'it' : 'them'}.
        </div>
      )}
    </section>
  );
}

export function BranchesPage({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const { repos } = useApp();
  const [repoId, setRepoId] = useState('');
  const [data, setData] = useState<BranchesOverview | null>(null);
  const [busy, setBusy] = useState<'read' | 'fetch' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const loadedAt = useRef(0);
  // the newest request wins: a slow read for the previous repo filter must not overwrite this one
  const seq = useRef(0);

  const load = useCallback(
    async (fetchFirst: boolean) => {
      const mine = ++seq.current;
      setBusy(fetchFirst ? 'fetch' : 'read');
      setErr(null);
      try {
        const next = fetchFirst ? await api.fetchBranches(repoId || undefined) : await api.branches(repoId || undefined);
        if (mine !== seq.current) return;
        setData(next);
        loadedAt.current = Date.now();
      } catch (e) {
        if (mine === seq.current) setErr((e as Error).message);
      } finally {
        if (mine === seq.current) setBusy(null);
      }
    },
    [repoId],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // back on the tab after a while: re-read (local only — never a fetch on its own)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - loadedAt.current > REVISIT_MS) void load(false);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const shown = data?.repos ?? [];
  const totals = shown.reduce(
    (acc, r) => {
      const wt = new Map(r.worktrees.filter((w) => w.branch).map((w) => [w.branch!, w]));
      acc.awaiting += r.branches.filter((b) => b.state === 'unmerged' || dirtyText(wt.get(b.name))).length;
      acc.unpushed += r.essentials.reduce((n, e) => n + e.unpushedCount, 0);
      acc.dirty += r.worktrees.filter((w) => w.changed || w.untracked).length;
      return acc;
    },
    { awaiting: 0, unpushed: 0, dirty: 0 },
  );

  return (
    <div>
      <h1 className="page-title">
        Branches
        <span style={{ flex: 1 }} />
        <select className="field br-select" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
          <option value="">All repos</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <button className="btn ghost" disabled={!!busy} onClick={() => void load(false)} title="Re-read local git state">
          {busy === 'read' ? 'Reading…' : 'Refresh'}
        </button>
        <button className="btn" disabled={!!busy} onClick={() => void load(true)} title="git fetch --prune, then re-read">
          {busy === 'fetch' ? 'Fetching…' : 'Fetch'}
        </button>
      </h1>

      {err && <div className="warn-text br-gap">{err}</div>}
      {!data && !err && <div className="muted">Reading git…</div>}
      {data && shown.length === 0 && (
        <div className="empty panel">
          <div className="big">No repos registered</div>
        </div>
      )}
      {data && shown.length > 0 && (
        <div className="br-summary">
          <span className={`chip ${totals.awaiting ? 'br-tone-warn' : 'br-tone-ok'}`}>{plural(totals.awaiting, 'branch', 'branches')} awaiting merge</span>
          <span className={`chip ${totals.unpushed ? 'br-tone-local' : 'br-tone-ok'}`}>
            {plural(totals.unpushed, 'essential commit')} not pushed
          </span>
          <span className={`chip ${totals.dirty ? 'br-tone-local' : 'br-tone-ok'}`}>
            {plural(totals.dirty, 'checkout')} with uncommitted files
          </span>
        </div>
      )}
      <div className="br-list">
        {shown.map((r) => (
          <RepoCard key={r.repoId} repo={r} onOpenTask={onOpenTask} />
        ))}
      </div>
    </div>
  );
}
