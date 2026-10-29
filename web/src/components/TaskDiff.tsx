import { useCallback, useEffect, useRef, useState } from 'react';
import type { Repo, Task, TaskDiffFile, TaskDiffResponse, TaskDiffSection } from '@tm/shared';
import { api } from '../api.ts';
import { onServerEvent } from '../state.tsx';
import { useIsMobile } from './Layout.tsx';
import { fmtAgo, useNow } from './TimeAgo.tsx';

/**
 * The task panel's Diff tab (docs/task-diff.md § The Diff tab): the change the
 * reviewer reads, from `GET /api/tasks/:id/diff`, as a scope line, the task's
 * commits and a file list whose rows expand into a read-only patch.
 *
 * Patch text is only ever a text node — never markdown, never HTML — and each
 * patch block scrolls sideways on its own; vertically the panel's one scroller
 * moves everything (a nested vertical scroller breaks the phone sheet's drag).
 */

/** at most one automatic refetch per this many ms; Refresh is never throttled */
const REFETCH_MS = 5_000;

const STATUS_LETTER: Record<TaskDiffFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The base branch a worktree task's range is measured from, as the server resolves it. */
function baseName(task: Pick<Task, 'worktreeBase'>, repo: Pick<Repo, 'baseBranch'> | undefined): string {
  return task.worktreeBase ?? repo?.baseBranch ?? 'the default branch';
}

/** The scope in plain words — what this list IS, before any number. */
export function scopeLine(d: TaskDiffResponse, task: Pick<Task, 'worktreeBase'>, repo: Pick<Repo, 'baseBranch'> | undefined): string {
  const { scope } = d;
  const n = d.commits.length;
  const base = baseName(task, repo);
  const uncommitted = scope.includeUncommitted && d.files.some((f) => f.sections.some((s) => s.source === 'uncommitted') || f.sections.length === 0)
    ? ' + uncommitted'
    : '';
  if (scope.evicted) {
    return n > 0 ? `evicted worktree: committed work only — ${plural(n, 'commit')} (by Task trailer)` : 'evicted worktree: committed work only — no commits found';
  }
  switch (scope.kind) {
    case 'trailer':
      return `${plural(n, 'commit')} (by Task trailer)${uncommitted}`;
    case 'base-range':
      return `${plural(n, 'commit')} since its base ${scope.baseSha?.slice(0, 8) ?? ''}${uncommitted}`.replace(/ {2,}/g, ' ');
    case 'branch-range':
      return `branch ${scope.branch ?? 'tm/…'} since its fork from origin/${base}${uncommitted}`;
    case 'landed':
      return `landed squash on ${base}`;
    case 'none':
      return d.files.length > 0 ? 'uncommitted changes only — no commits attributed' : 'no change yet';
  }
}

const ATTRIBUTION: Record<TaskDiffResponse['scope']['attribution'], string> = {
  trailer: 'commits found by their Task: trailer',
  base: 'commits from base..HEAD (the task worked alone in the checkout)',
  none: 'no commits attributed to this task',
};

function sectionLabel(s: TaskDiffSection): string {
  if (s.source === 'committed') return 'committed';
  if (s.source === 'uncommitted') return 'uncommitted';
  return `commit ${s.source.slice('commit:'.length, 'commit:'.length + 7)}`;
}

/** One line's class: + / − / @@ / the file headers git prints before the hunks. */
function lineKind(line: string): string {
  if (line.startsWith('@@')) return 'td-hunk';
  if (line.startsWith('+++ ') || line.startsWith('--- ')) return 'td-meta';
  if (line.startsWith('+')) return 'td-add';
  if (line.startsWith('-')) return 'td-del';
  if (line.startsWith('\\')) return 'td-meta';
  if (/^(diff --git |index |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files )/.test(line)) {
    return 'td-meta';
  }
  return 'td-ctx';
}

function Patch({ section }: { section: TaskDiffSection }) {
  const lines = section.patch.replace(/\n$/, '').split('\n');
  return (
    <div className="td-section">
      <div className="td-section-head">
        <span className="td-source">{sectionLabel(section)}</span>
        {section.truncated && <span className="td-note">patch cut at the size cap — the counts above are complete</span>}
      </div>
      {section.patch && (
        // text children only: the patch is untrusted bytes from the repo
        <pre className="td-patch">
          {lines.map((l, i) => (
            <span key={i} className={lineKind(l)}>
              {l === '' ? ' ' : l}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}

function FileRow({ file, open, onToggle, untrackedCapped }: { file: TaskDiffFile; open: boolean; onToggle: () => void; untrackedCapped: boolean }) {
  const truncated = file.sections.some((s) => s.truncated);
  const empty = file.sections.length === 0;
  return (
    <li className={`td-file${open ? ' open' : ''}`}>
      <button type="button" className="td-file-row" aria-expanded={open} onClick={onToggle}>
        <span className={`td-status td-status-${file.status}`} title={file.status}>
          {STATUS_LETTER[file.status]}
        </span>
        <span className="td-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {file.oldPath && <span className="td-oldpath">{file.oldPath} → </span>}
          {file.path}
        </span>
        <span className="td-counts">
          {file.binary ? (
            <span className="td-note">binary</span>
          ) : (
            <>
              <span className="td-plus">+{file.insertions}</span>
              <span className="td-minus">−{file.deletions}</span>
            </>
          )}
          {truncated && <span className="td-note">cut</span>}
        </span>
      </button>
      {open && (
        <div className="td-file-body">
          {file.binary && <div className="td-note">Binary file — no text diff.</div>}
          {empty && !file.binary && (
            <div className="td-note">
              {untrackedCapped ? 'No patch: empty file, or an untracked file past the read cap.' : 'No patch: an empty file.'}
            </div>
          )}
          {file.sections.map((s) => (
            <Patch key={s.source} section={s} />
          ))}
        </div>
      )}
    </li>
  );
}

export function TaskDiff({ task, repo }: { task: Task; repo: Repo | undefined }) {
  const taskId = task.id;
  const mobile = useIsMobile();
  const now = useNow();
  const [data, setData] = useState<TaskDiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());

  // a response is applied only if it is the newest request for THIS task
  const seq = useRef(0);
  const lastFetch = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const mine = ++seq.current;
    lastFetch.current = Date.now();
    setLoading(true);
    api
      .taskDiff(taskId)
      .then((d) => {
        if (mine !== seq.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, [taskId]);

  /** an automatic refetch: at once if the last read is old enough, else once at the end of the window */
  const soon = useCallback(() => {
    if (timer.current) return;
    const wait = lastFetch.current + REFETCH_MS - Date.now();
    if (wait <= 0) load();
    else timer.current = setTimeout(load, wait);
  }, [load]);

  // first open (and a breadcrumb swap to another task): a fresh read, nothing carried over
  useEffect(() => {
    setData(null);
    setError(null);
    setOpen(new Set());
    load();
    return () => {
      seq.current++;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [load]);

  // the change moves when the task row does (a commit lands with the Stop) or a run of it exits
  // (keyed on the task: a swap's new `updatedAt` is the mount read's, not a move)
  const seenUpdatedAt = useRef({ id: taskId, at: task.updatedAt });
  useEffect(() => {
    const seen = seenUpdatedAt.current;
    seenUpdatedAt.current = { id: taskId, at: task.updatedAt };
    if (seen.id === taskId && seen.at !== task.updatedAt) soon();
  }, [taskId, task.updatedAt, soon]);
  useEffect(
    () =>
      onServerEvent((e) => {
        if (e.type === 'run.exited' && e.run.taskId === taskId) soon();
      }),
    [taskId, soon],
  );

  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const refresh = (
    <button type="button" className="btn ghost td-btn" onClick={load} disabled={loading} title="Read the change again">
      {loading ? 'Reading…' : 'Refresh'}
    </button>
  );

  if (!data) {
    return (
      <div className="td">
        <div className="td-head">
          <span className="td-scope muted">{error ? 'Could not read the change.' : 'Reading the change…'}</span>
          {refresh}
        </div>
        {error && <div className="warn-text">{error}</div>}
      </div>
    );
  }

  const readAge = fmtAgo(now - Date.parse(data.readAt));
  const allOpen = data.files.length > 0 && data.files.every((f) => open.has(f.path));

  return (
    <div className="td">
      <div className="td-head">
        <span className="td-scope">{scopeLine(data, task, repo)}</span>
        {refresh}
      </div>
      <div className="td-meta-row muted">
        <span>{ATTRIBUTION[data.scope.attribution]}</span>
        {data.files.length > 0 && (
          <span className="td-stat">
            {plural(data.stat.files, 'file')} <span className="td-plus">+{data.stat.insertions}</span>{' '}
            <span className="td-minus">−{data.stat.deletions}</span>
          </span>
        )}
        <span title={new Date(data.readAt).toLocaleString()}>read {readAge === 'now' ? 'just now' : `${readAge} ago`}</span>
      </div>
      {error && <div className="warn-text">Refresh failed: {error}</div>}
      {data.truncated && (
        <div className="hint td-banner">
          Some patches were cut to stay within the size caps (about 400 KB a file, 4 MB in all). Every file is still listed with its full counts.
        </div>
      )}
      {data.untrackedCapped && <div className="td-note">Some untracked files were listed without reading their patch.</div>}

      {data.commits.length > 0 && (
        <ol className="td-commits">
          {data.commits.map((c) => (
            <li key={c.sha}>
              <code className="td-sha" title={c.sha}>
                {c.sha.slice(0, 7)}
              </code>
              <span className="td-subject">{c.subject}</span>
            </li>
          ))}
        </ol>
      )}

      {data.files.length > 0 ? (
        <>
          {!mobile && data.files.length > 1 && (
            <div className="td-tools">
              <button
                type="button"
                className="btn ghost td-btn"
                onClick={() => setOpen(allOpen ? new Set() : new Set(data.files.map((f) => f.path)))}
              >
                {allOpen ? 'Collapse all' : 'Expand all'}
              </button>
            </div>
          )}
          <ul className="td-files">
            {data.files.map((f) => (
              <FileRow key={f.path} file={f} open={open.has(f.path)} onToggle={() => toggle(f.path)} untrackedCapped={data.untrackedCapped} />
            ))}
          </ul>
        </>
      ) : (
        <div className="muted">{data.scope.kind === 'none' ? 'Nothing has changed for this task yet.' : 'No file differs in this scope.'}</div>
      )}
    </div>
  );
}
