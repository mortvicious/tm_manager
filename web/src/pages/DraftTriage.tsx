import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BULK_MAX, type BulkAction, type Task, type TriageDraft, type TriageGroup } from '@tm/shared';
import { api } from '../api.ts';
import { useArm } from '../arm.ts';
import { CANCEL_STALE_REASON, staleDays, useDraftTriage } from '../components/Inbox.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { useApp } from '../state.tsx';
import { toastError } from '../toast.ts';
import { useWorkspace } from '../workspace.ts';

/**
 * Agent-draft triage (docs/inbox.md § Draft triage): every idle agent-filed
 * draft in the current workspace, grouped by the task that filed it (or by
 * repo), judged a whole group at a time. Membership, grouping and order are
 * the shared pure `triageDrafts`; every press is ONE `POST /api/tasks/bulk`
 * per BULK_MAX ids, so refusals come back per id and are shown on the row.
 * Never automatic: nothing here runs without a press, and the group-wide
 * Cancel / Enqueue / Add to queue need a second one (src/arm.ts).
 */

type TriageAction = Extract<BulkAction, 'keep' | 'enqueue' | 'queue' | 'hide' | 'unhide' | 'cancel'>;
type Grouping = 'filer' | 'repo';

const ACTIONS: { id: TriageAction; label: string; title: string }[] = [
  { id: 'keep', label: 'Keep', title: 'keep: out of the Inbox stale list for another stale-draft window' },
  { id: 'enqueue', label: 'Enqueue', title: 'into the global queue' },
  { id: 'queue', label: 'Add to queue', title: 'into the custom queue (serial per repo, runs even with the global queue stopped)' },
  { id: 'hide', label: 'Hide', title: 'hide from the board — Board › Hidden brings it back' },
  { id: 'cancel', label: 'Cancel', title: `cancel, recorded as “${CANCEL_STALE_REASON}”` },
];

/** a group-wide press of these only arms it; the second one runs */
const GROUP_ARMED: Partial<Record<TriageAction, (n: number) => string>> = {
  cancel: (n) => `Cancel ${n}?`,
  enqueue: (n) => `Enqueue ${n}?`,
  queue: (n) => `Queue ${n}?`,
};

const GROUPING_KEY = 'tm.triage.group';

function storedGrouping(): Grouping {
  try {
    return localStorage.getItem(GROUPING_KEY) === 'repo' ? 'repo' : 'filer';
  } catch {
    return 'filer';
  }
}

export function DraftTriagePage({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const { repos, runs, questions, refresh, settings, loaded } = useApp();
  const { workspace, wsHref } = useWorkspace();
  const [grouping, setGroupingState] = useState<Grouping>(storedGrouping);
  const [showHidden, setShowHidden] = useState(false);
  const triage = useDraftTriage(showHidden);
  const groups = grouping === 'filer' ? triage.byFiler : triage.byRepo;
  // runs arrive after tasks (state.tsx refresh): until then every filer would read "run unknown"
  const settling = !loaded || (!runs.length && triage.drafts.some((d) => d.task.createdByRun));
  const arm = useArm();
  /** the key of the press in flight (one at a time) */
  const [busy, setBusy] = useState<string | null>(null);
  /** id → why the server refused the last press that included it */
  const [refused, setRefused] = useState<Record<string, string>>({});

  const repoName = (id: string | null) => (id ? (repos.find((r) => r.id === id)?.name ?? 'unknown repo') : 'no repo');
  const asking = useMemo(() => new Set(questions.map((q) => q.taskId)), [questions]);
  const attentive = useMemo(
    () => new Set(runs.filter((r) => r.needsAttention && r.status === 'running' && r.taskId).map((r) => r.taskId!)),
    [runs],
  );

  const setGrouping = (g: Grouping) => {
    setGroupingState(g);
    try {
      localStorage.setItem(GROUPING_KEY, g);
    } catch {
      /* private mode: per page load only */
    }
  };

  const run = async (key: string, action: TriageAction, ids: string[]) => {
    const label = ACTIONS.find((a) => a.id === action)?.label ?? (action === 'unhide' ? 'Unhide' : action);
    setBusy(key);
    const out: Record<string, string> = {};
    try {
      for (let i = 0; i < ids.length; i += BULK_MAX) {
        const chunk = ids.slice(i, i + BULK_MAX);
        const r = await api.bulkTasks({ action, ids: chunk, ...(action === 'cancel' ? { reason: CANCEL_STALE_REASON } : {}) });
        for (const x of r.results) if (!x.ok) out[x.id] = `${label}: ${x.error}`;
      }
      const n = Object.keys(out).length;
      if (n && ids.length > 1) toastError(new Error(`${n} of ${ids.length} refused — reasons on the rows`), label);
    } catch (e) {
      toastError(e, label);
    } finally {
      setRefused((cur) => {
        const next = { ...cur };
        for (const id of ids) delete next[id];
        return { ...next, ...out };
      });
      setBusy(null);
      arm.disarm();
      await refresh();
    }
  };

  const groupHead = (g: TriageGroup) => {
    if (g.kind === 'filer' && g.filer) {
      const f: Task = g.filer;
      return (
        <>
          <button type="button" className="triage-filer" title="open the task that filed these" onClick={() => onOpenTask(f.id)}>
            {f.title}
          </button>
          <StatusBadge
            status={f.status}
            attention={f.status === 'running' && attentive.has(f.id)}
            question={asking.has(f.id)}
            reviewState={f.reviewState}
            checkState={f.checkState}
            loopState={f.loopState}
            paused={!!f.pausedTurn}
            explain={false}
          />
          <span className="inbox-repo">{repoName(f.repoId)}</span>
        </>
      );
    }
    if (g.kind === 'repo') return <span className="triage-label">{repoName(g.repoId)}</span>;
    return <span className="triage-label muted">{g.label}</span>;
  };

  const actionButtons = (scope: string, ids: string[], hiddenOnly: boolean, group: boolean) =>
    ACTIONS.map((a) => {
      const action: TriageAction = a.id === 'hide' && hiddenOnly ? 'unhide' : a.id;
      const label = action === 'unhide' ? 'Unhide' : a.label;
      // a single row's Cancel arms too: closing work is never one stray click
      const armedLabel = group ? GROUP_ARMED[a.id] : a.id === 'cancel' ? () => 'Cancel?' : undefined;
      const key = `${scope}:${a.id}`;
      const armed = armedLabel && arm.armed === key;
      return (
        <button
          key={a.id}
          type="button"
          className={`btn${armed ? ' danger' : ''}`}
          disabled={busy !== null || !ids.length}
          title={a.id === 'hide' && hiddenOnly ? 'show on the board again' : a.title}
          onClick={() => {
            if (armedLabel && !arm.press(key)) return;
            void run(key, action, ids);
          }}
        >
          {busy === key ? '…' : armed ? armedLabel(ids.length) : label}
        </button>
      );
    });

  const row = (d: TriageDraft) => {
    const t = d.task;
    return (
      <li key={t.id} className="triage-row">
        <div className="triage-row-line">
          <span className="triage-main">
            <button type="button" className="triage-title" title="open the task" onClick={() => onOpenTask(t.id)}>
              {t.title}
            </button>
            <span className="inbox-repo">{repoName(t.repoId)}</span>
            <span className="triage-age" title={`filed ${new Date(t.createdAt).toLocaleString()}`}>
              {d.ageDays}d
          </span>
          {d.stale && (
            <span className="chip triage-stale" title={`older than ${staleDays(settings)} days and not kept (the Inbox lists it)`}>
              stale
            </span>
          )}
          {d.kept && (
            <span className="chip" title={`kept until ${new Date(t.inboxKeptUntil!).toLocaleString()}`}>
              kept
            </span>
          )}
          {t.hiddenAt && <span className="chip">hidden</span>}
          </span>
          <span className="triage-acts">{actionButtons(`t:${t.id}`, [t.id], !!t.hiddenAt, false)}</span>
        </div>
        {refused[t.id] && <div className="triage-refused">{refused[t.id]}</div>}
      </li>
    );
  };

  return (
    <div className="triage-page">
      <h1 className="page-title">
        Draft triage
        {workspace && <span className="inbox-ws">· {workspace.name}</span>}
        <span className="inbox-count">
          {triage.drafts.length === 1 ? '1 agent-filed draft' : `${triage.drafts.length} agent-filed drafts`}
          {` · ${groups.length === 1 ? '1 group' : `${groups.length} groups`}`}
        </span>
        <span style={{ flex: 1 }} />
        <Link className="btn ghost deck-back" to={wsHref('/inbox')}>
          Inbox
        </Link>
      </h1>
      <div className="triage-tools">
        <span className="seg" role="group" aria-label="Group by">
          {(['filer', 'repo'] as const).map((g) => (
            <button
              key={g}
              type="button"
              aria-pressed={grouping === g}
              className={`btn ${grouping === g ? 'primary' : ''}`}
              onClick={() => setGrouping(g)}
            >
              by {g}
            </button>
          ))}
        </span>
        <label className="triage-hidden">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> show hidden
        </label>
        <span className="hint">nothing here runs on its own — every action is a press</span>
      </div>
      {settling && <div className="inbox-empty">Loading…</div>}
      {!settling && !groups.length && (
        <div className="inbox-empty">
          No agent-filed drafts{workspace ? ` in ${workspace.name}` : ''}
          {showHidden ? '' : ' (hidden ones are behind “show hidden”)'}.
        </div>
      )}
      {!settling &&
        groups.map((g) => {
        const ids = g.drafts.map((d) => d.task.id);
        const hiddenOnly = g.drafts.every((d) => !!d.task.hiddenAt);
        return (
          <section key={g.key} className="panel triage-group">
            <div className="triage-group-head">
              <span className="triage-main">
                {groupHead(g)}
                <span className="triage-count">{ids.length === 1 ? '1 draft' : `${ids.length} drafts`}</span>
              </span>
              <span className="triage-acts">{actionButtons(`g:${g.key}`, ids, hiddenOnly, true)}</span>
            </div>
            <ul className="triage-rows">{g.drafts.map(row)}</ul>
          </section>
        );
      })}
    </div>
  );
}
