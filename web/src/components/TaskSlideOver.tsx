import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  EFFORT_LEVELS,
  GROUP_COLOR_COUNT,
  MODEL_OPTIONS,
  groupAncestors,
  groupColorSlot,
  groupLabel,
  type EffortLevel,
  type Proposal,
  type Task,
} from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { DispatchStrip } from './DispatchStrip.tsx';
import { IconAnalyze, IconPlay, IconPublish, IconQueue, IconTerminal, IconX } from './Icons.tsx';
import { Markdown } from './Markdown.tsx';
import { PresetPicker, reviewChoiceOf, reviewValueOf, type ReviewChoice } from './PresetPicker.tsx';
import { RunStatsChips } from './RunMeta.tsx';
import { StatusBadge } from './StatusBadge.tsx';

function ProposalCard({ p, onDone }: { p: Proposal; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [optIdx, setOptIdx] = useState(0);
  const act = async (accept: boolean) => {
    setBusy(true);
    try {
      if (accept) await api.acceptProposal(p.id, p.kind === 'solution_options' ? optIdx : undefined);
      else await api.rejectProposal(p.id);
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel" style={{ padding: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <span className="chip">{p.kind}</span>
        <span className="muted" style={{ fontSize: 11 }}>
          {new Date(p.createdAt).toLocaleString()}
        </span>
      </div>
      {p.payload.title && <div style={{ fontWeight: 600 }}>{p.payload.title}</div>}
      {p.payload.description && <div style={{ whiteSpace: 'pre-wrap' }}>{p.payload.description}</div>}
      <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
        {p.payload.rationale}
      </div>
      {p.kind === 'split' && p.payload.subtasks && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          {p.payload.subtasks.map((s, i) => (
            <li key={i}>
              <b>{s.title}</b> — <span className="muted">{s.description}</span>
            </li>
          ))}
        </ul>
      )}
      {p.kind === 'solution_options' && p.payload.options && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {p.payload.options.map((o, i) => (
            <label key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="radio" checked={optIdx === i} onChange={() => setOptIdx(i)} />
              <span>
                <b>{o.label}</b> — {o.approach} <span className="muted">({o.tradeoffs})</span>
              </span>
            </label>
          ))}
        </div>
      )}
      {p.status === 'pending' ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="btn primary" disabled={busy} onClick={() => act(true)}>
            Accept
          </button>
          <button className="btn" disabled={busy} onClick={() => act(false)}>
            Reject
          </button>
        </div>
      ) : (
        <div className="chip" style={{ marginTop: 8 }}>
          {p.status}
        </div>
      )}
    </div>
  );
}

/** The task's line of ancestry, root first — its path to the first parent. */
function GroupPath({ task, tasks, onOpen }: { task: Task; tasks: Task[]; onOpen: (id: string) => void }) {
  const ancestors = groupAncestors(task);
  if (ancestors.length === 0) return null;
  return (
    <div className="group-path">
      {ancestors.map((id) => {
        const a = tasks.find((t) => t.id === id);
        return (
          <span key={id}>
            <button className="crumb" title={a ? 'Open this task' : 'This ancestor no longer exists'} disabled={!a} onClick={() => onOpen(id)}>
              {a ? a.title : `${id.slice(0, 8)}…`}
            </button>
            <span className="sep">/</span>
          </span>
        );
      })}
      <span className="self">{task.title}</span>
    </div>
  );
}

export function TaskSlideOver({
  taskId,
  onClose,
  onOpenTask,
  onOpenTerminal,
}: {
  taskId: string;
  onClose: () => void;
  /** swap the panel to another task (the group breadcrumb) */
  onOpenTask: (id: string) => void;
  onOpenTerminal: (runId: string) => void;
}) {
  const { tasks, repos, runs, proposals, dispatches, refresh } = useApp();
  const task = tasks.find((t) => t.id === taskId);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [repoId, setRepoId] = useState<string>('');
  const [model, setModel] = useState<string>('');
  const [effort, setEffort] = useState<string>('');
  const [category, setCategory] = useState<string>('');
  const [groupName, setGroupName] = useState<string>('');
  const [groupColor, setGroupColor] = useState<string>('');
  const [review, setReview] = useState<ReviewChoice>('default');
  const [autoPublish, setAutoPublish] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [followUpMsg, setFollowUpMsg] = useState('');
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  const [resumeSession, setResumeSession] = useState<string | null>(null);
  const [files, setFiles] = useState<{ name: string; size: number; mtime: string }[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);

  const taskRuns = useMemo(() => runs.filter((r) => r.taskId === taskId), [runs, taskId]);
  // Changes whenever one of this task's runs gains a session id or ends, which
  // is exactly when resumability can flip.
  const runSig = useMemo(
    () => taskRuns.map((r) => `${r.id}:${r.sessionId ?? ''}:${r.status}`).join('|'),
    [taskRuns],
  );

  // Keyed on id, not the task object: task.updated events must not wipe edits.
  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDescription(task.description ?? '');
      setRepoId(task.repoId ?? '');
      setModel(task.model ?? '');
      setEffort(task.effort ?? '');
      setCategory(task.category ?? '');
      setGroupName(task.groupName ?? '');
      setGroupColor(task.groupColor == null ? '' : String(task.groupColor));
      setReview(reviewChoiceOf(task.review));
      setAutoPublish(task.autoPublish);
      setFollowUpMsg('');
    }
  }, [task?.id]);

  // Deliverable files — refresh when the panel opens and when the task's
  // status changes (a finished run may have just written files).
  useEffect(() => {
    if (!task) return;
    api.taskFiles(task.id).then(setFiles).catch(() => setFiles([]));
  }, [task?.id, task?.status]);

  // Can "Proceed" reopen an earlier agent session? Only the server knows —
  // it also checks the transcript is still on disk. Re-checked when a run
  // starts/ends so the button appears as soon as a session is recorded.
  useEffect(() => {
    if (!task) return;
    let live = true;
    api
      .resumable(task.id)
      .then((r) => live && setResumeSession(r.sessionId))
      .catch(() => live && setResumeSession(null));
    return () => {
      live = false;
    };
  }, [task?.id, runSig]);

  const latestRun = taskRuns[0];
  const taskProposals = useMemo(() => proposals.filter((p) => p.taskId === taskId), [proposals, taskId]);

  if (!task) return null;

  // group identity lives on the ROOT task — the server rejects it elsewhere
  const isRoot = task.id === task.groupId;
  const groupTasks = tasks.filter((t) => t.groupId === task.groupId);
  const groupRoot = groupTasks.find((t) => t.id === task.groupId);
  const slot = groupColorSlot(groupRoot, task.groupId);
  const groupTint = { '--tm-group': `var(--tm-group-${slot})` } as CSSProperties;

  const dirty =
    title !== task.title ||
    description !== (task.description ?? '') ||
    repoId !== (task.repoId ?? '') ||
    model !== (task.model ?? '') ||
    effort !== (task.effort ?? '') ||
    category !== (task.category ?? '') ||
    review !== reviewChoiceOf(task.review) ||
    autoPublish !== task.autoPublish ||
    (isRoot &&
      (groupName !== (task.groupName ?? '') || groupColor !== (task.groupColor == null ? '' : String(task.groupColor))));

  const save = async () => {
    setErr(null);
    try {
      await api.updateTask(task.id, {
        title,
        description: description || null,
        repoId: repoId || null,
        model: model || null,
        effort: (effort || null) as EffortLevel | null,
        category: category.trim() || null,
        review: reviewValueOf(review),
        autoPublish,
        ...(isRoot
          ? { groupName: groupName.trim() || null, groupColor: groupColor === '' ? null : Number(groupColor) }
          : {}),
      });
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const action = async (
    a: 'enqueue' | 'run-now' | 'cancel' | 'retry' | 'unblock' | 'complete' | 'publish' | 'queue' | 'unqueue',
  ) => {
    setErr(null);
    try {
      await api.taskAction(task.id, a);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const analyze = async () => {
    setErr(null);
    if (!task.repoId) {
      setErr('Assign a repo before analyzing');
      return;
    }
    try {
      await api.analyze({ repoId: task.repoId, taskIds: [task.id] });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const loadFiles = () => task && api.taskFiles(task.id).then(setFiles).catch(() => {});
  const doUpload = async (fileList: FileList | File[]) => {
    if (!task) return;
    const arr = Array.from(fileList);
    if (arr.length === 0) return;
    setUploading(true);
    setErr(null);
    try {
      await api.uploadTaskFiles(task.id, arr);
      loadFiles();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUploading(false);
    }
  };
  const delFile = async (name: string) => {
    if (!task) return;
    try {
      await api.deleteTaskFile(task.id, name);
      loadFiles();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  // Both follow-up buttons: same busy/error/clear handling, different call.
  const send = async (call: () => Promise<unknown>) => {
    setErr(null);
    setSendingFollowUp(true);
    try {
      await call();
      setFollowUpMsg('');
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSendingFollowUp(false);
    }
  };

  const del = async () => {
    if (!confirm('Delete this task?')) return;
    try {
      await api.deleteTask(task.id);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="slideover">
        <div className="slideover-head">
          <span className="mono muted">{task.id.slice(0, 8)}</span>
          <StatusBadge status={task.status} attention={latestRun?.needsAttention && task.status === 'running'} />
          <span className="chip">{task.source}</span>
          {task.category && <span className="chip" style={{ color: 'var(--tm-accent)' }}>{task.category}</span>}
          {groupTasks.length > 1 && (
            <span
              className="chip group-chip"
              style={groupTint}
              title={`task group · ${groupTasks.length} tasks${isRoot ? ' · this is the group root' : ''}`}
            >
              {groupLabel(groupRoot, task.title)} · {groupTasks.length}
            </span>
          )}
          {task.parentId && <span className="chip">subtask</span>}
          {task.createdByRun && (
            <span className="chip" title={`filed by agent run ${task.createdByRun.slice(0, 8)} (depth ${task.spawnDepth})`}>
              agent d{task.spawnDepth}
            </span>
          )}
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>
            <IconX />
          </button>
        </div>
        <div className="slideover-body">
          <GroupPath task={task} tasks={tasks} onOpen={onOpenTask} />
          <div>
            <label className="label">Title</label>
            <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label className="label">Description</label>
            <textarea
              className="field"
              rows={6}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="form-grid">
            <div>
              <label className="label">Repo</label>
              <select className="field" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
                <option value="">— none —</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                    {r.role ? ` (${r.role})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Category</label>
              <input
                className="field"
                list="tm-categories-drawer"
                placeholder="UI, Estimator…"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
              <datalist id="tm-categories-drawer">
                {[...new Set(tasks.map((t) => t.category).filter(Boolean))].map((c) => (
                  <option key={c as string} value={c as string} />
                ))}
              </datalist>
            </div>
            {isRoot && groupTasks.length > 1 && (
              <>
                <div>
                  <label className="label">Group name</label>
                  <input
                    className="field"
                    placeholder={task.title}
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label">Group colour</label>
                  <select
                    className="field group-swatch"
                    style={groupColor === '' ? groupTint : ({ '--tm-group': `var(--tm-group-${groupColor})` } as CSSProperties)}
                    value={groupColor}
                    onChange={(e) => setGroupColor(e.target.value)}
                  >
                    <option value="">auto (from group id)</option>
                    {Array.from({ length: GROUP_COLOR_COUNT }, (_, i) => (
                      <option key={i + 1} value={String(i + 1)}>
                        colour {i + 1}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
            <div className="wide">
              <label className="label">Preset</label>
              <PresetPicker
                model={model}
                effort={effort}
                review={review}
                onApply={(p) => {
                  setModel(p.model);
                  setEffort(p.effort);
                  setReview(reviewChoiceOf(p.review));
                }}
              />
            </div>
            <div>
              <label className="label">Adversarial review</label>
              <select className="field" value={review} onChange={(e) => setReview(e.target.value as ReviewChoice)}>
                <option value="default">default (config)</option>
                <option value="on">review this</option>
                <option value="off">skip (small task)</option>
              </select>
            </div>
            <div>
              <label className="label">Auto-publish on end</label>
              <select
                className="field"
                value={autoPublish ? 'on' : 'off'}
                onChange={(e) => setAutoPublish(e.target.value === 'on')}
              >
                <option value="off">off — stop at review</option>
                <option value="on">on — commit &amp; push at the end</option>
              </select>
            </div>
            <div>
              <label className="label">Updated</label>
              <div className="mono muted" style={{ paddingTop: 6 }}>
                {new Date(task.updatedAt).toLocaleString()}
              </div>
            </div>
            <div>
              <label className="label">Model</label>
              <select className="field mono" value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">default (config)</option>
                {(model && !MODEL_OPTIONS.includes(model) ? [model, ...MODEL_OPTIONS] : MODEL_OPTIONS).map(
                  (m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ),
                )}
              </select>
            </div>
            <div>
              <label className="label">Effort</label>
              <select className="field mono" value={effort} onChange={(e) => setEffort(e.target.value)}>
                <option value="">default (config)</option>
                {EFFORT_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {dirty && (
            <button className="btn primary" onClick={save} style={{ alignSelf: 'flex-start' }}>
              Save changes
            </button>
          )}

          {err && <div className="warn-text">{err}</div>}
          {task.error && (
            <div className="warn-text" style={{ whiteSpace: 'pre-wrap' }}>
              {task.error}
            </div>
          )}
          {task.reviewSummary && <Markdown label="Adversarial review" text={task.reviewSummary} />}
          {task.resultSummary && <Markdown label="Result summary" text={task.resultSummary} />}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {['draft', 'review', 'blocked', 'failed', 'cancelled'].includes(task.status) && (
              <button className="btn" onClick={() => action('enqueue')}>
                Enqueue
              </button>
            )}
            {/* custom queue (docs/queue.md): runs even with the global queue stopped, one task at a time */}
            {(['draft', 'review', 'failed', 'cancelled'].includes(task.status) ||
              (task.status === 'queued' && !task.customQueueAt)) && (
              <button
                className="btn queue-btn"
                title="Add to the queue — runs one task at a time, independent of the global queue"
                onClick={() => action('queue')}
              >
                <IconQueue /> Add to queue
              </button>
            )}
            {task.status === 'queued' && task.customQueueAt && (
              <button className="btn danger" onClick={() => action('unqueue')}>
                Remove from queue
              </button>
            )}
            {['draft', 'queued', 'review', 'failed', 'cancelled'].includes(task.status) && (
              <button className="btn primary" onClick={() => action('run-now')}>
                <IconPlay /> Run now
              </button>
            )}
            {task.status === 'running' && (
              <button className="btn danger" onClick={() => action('cancel')}>
                Cancel
              </button>
            )}
            {task.status === 'queued' && !task.customQueueAt && (
              <button className="btn danger" onClick={() => action('cancel')}>
                Remove from queue
              </button>
            )}
            {task.status === 'review' && (
              <button
                className="btn primary"
                title={
                  resumeSession
                    ? `Commit and push this work in session ${resumeSession.slice(0, 8)} — the same terminal the agent worked in`
                    : 'Commit and push this work (no agent session left to reopen, so the server does it directly)'
                }
                onClick={() => action('publish')}
              >
                <IconPublish /> Publish
              </button>
            )}
            {task.status === 'review' && (
              <button className="btn" onClick={() => action('complete')}>
                Mark done
              </button>
            )}
            {['review', 'done', 'failed'].includes(task.status) && (
              <button
                className="btn"
                title={
                  task.reviewSummary
                    ? 'Send the review findings back to a worker to fix'
                    : 'Adversarially review this task and fix what it finds'
                }
                onClick={async () => {
                  setErr(null);
                  try {
                    await api.applyReview(task.id);
                    await refresh();
                  } catch (e) {
                    setErr((e as Error).message);
                  }
                }}
              >
                <IconAnalyze /> Apply review fixes
              </button>
            )}
            {task.status === 'blocked' && (
              <button className="btn" onClick={() => action('unblock')}>
                Unblock
              </button>
            )}
            {latestRun && (
              <button className="btn" onClick={() => onOpenTerminal(latestRun.id)}>
                <IconTerminal /> Open terminal
              </button>
            )}
            {task.status !== 'running' && latestRun?.status === 'running' && (
              <button
                className="btn danger"
                title="Close the agent's terminal session (task status is unchanged)"
                onClick={async () => {
                  setErr(null);
                  try {
                    await api.stopAgent(task.id);
                    await refresh();
                  } catch (e) {
                    setErr((e as Error).message);
                  }
                }}
              >
                Stop agent
              </button>
            )}
            {latestRun && <RunStatsChips run={latestRun} />}
            <button className="btn" onClick={analyze}>
              <IconAnalyze /> Analyze
            </button>
            <button className="btn danger" onClick={del}>
              Delete
            </button>
          </div>

          {(task.status !== 'draft' || latestRun) && (
            <div>
              <label className="label">Follow-up</label>
              <textarea
                className="field"
                rows={3}
                placeholder={
                  resumeSession
                    ? 'New instruction — continues the agent\'s previous session, which still remembers everything'
                    : 'New instruction — re-runs the task with the previous summary as context'
                }
                value={followUpMsg}
                onChange={(e) => setFollowUpMsg(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  className="btn primary"
                  disabled={!followUpMsg.trim() || sendingFollowUp}
                  onClick={() => send(() => api.followUp(task.id, followUpMsg.trim()))}
                >
                  {sendingFollowUp ? 'Sending…' : 'Send follow-up'}
                </button>
                <button
                  className="btn"
                  disabled={!resumeSession || sendingFollowUp}
                  title={
                    resumeSession
                      ? `Reopen session ${resumeSession.slice(0, 8)} and carry on — use this when the terminal died mid-task (usage limit, dropped connection). Any text above is sent as the instruction.`
                      : 'No agent session to continue — run the task first, or use Run now for a fresh agent'
                  }
                  onClick={() => send(() => api.proceed(task.id, followUpMsg.trim() || undefined))}
                >
                  <IconPlay /> Proceed
                </button>
                {resumeSession && (
                  <span className="mono muted" style={{ fontSize: 11 }}>
                    resumes {resumeSession.slice(0, 8)}
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="section-head">Files</div>
          <div
            className={`dropzone ${dragOver ? 'over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void doUpload(e.dataTransfer.files);
            }}
            onClick={() => document.getElementById(`tm-file-${task.id}`)?.click()}
          >
            {uploading ? 'Uploading…' : 'Drop screenshots or files here, or click to pick'}
            <input
              id={`tm-file-${task.id}`}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files) void doUpload(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
          {files.length > 0 && (
            <div className="panel">
              {files.map((f) => (
                <div key={f.name} className="task-row" style={{ cursor: 'default' }}>
                  <a
                    className="title mono"
                    style={{ textDecoration: 'none', color: 'inherit', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
                    href={`/api/tasks/${task.id}/files/${encodeURIComponent(f.name)}`}
                    download={f.name}
                  >
                    {f.name}
                  </a>
                  <span className="mono muted">
                    {f.size < 1024 ? `${f.size} B` : f.size < 1048576 ? `${(f.size / 1024).toFixed(1)} KB` : `${(f.size / 1048576).toFixed(1)} MB`}
                  </span>
                  <button
                    className="btn ghost"
                    title="remove"
                    onClick={() => delFile(f.name)}
                    style={{ padding: '2px 8px' }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {dispatches.some((d) => d.fromTaskId === task.id || d.toTaskId === task.id) && (
            <>
              <div className="section-head">Dispatches</div>
              <div className="panel" style={{ padding: '6px 10px' }}>
                <DispatchStrip taskId={task.id} direction="both" full onOpenTask={onOpenTask} />
              </div>
            </>
          )}

          {taskProposals.length > 0 && (
            <>
              <div className="section-head">Proposals</div>
              {taskProposals.map((p) => (
                <ProposalCard key={p.id} p={p} onDone={refresh} />
              ))}
            </>
          )}
        </div>
      </div>
    </>
  );
}
