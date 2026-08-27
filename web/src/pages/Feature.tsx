import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  EFFORT_LEVELS,
  type EffortLevel,
  type Feature,
  type FeaturePlan,
  type FeaturePlanTask,
  type Task,
} from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { FeatureBadge } from '../components/FeatureBadge.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { Markdown } from '../components/Markdown.tsx';

// The visual approval surface: request → analysis → adversarial verdict →
// editable phase columns of task cards → Approve. After approval the same
// columns become the execution dashboard (cards are the real tasks, live over
// /ws/events). Every style resolves to a --tm-* token via theme.css.

// Mirrors isFeatureTaskBlocking on the server: a published task is settled.
const RESOLVED = ['published', 'done', 'cancelled'];

/** Deep clone that survives the structuredClone gaps in older Safari. */
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const newCardId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `card-${Date.now()}-${Math.random()}`;

function PlanCardEditor({
  card,
  onChange,
  onDone,
}: {
  card: FeaturePlanTask;
  onChange: (patch: Partial<FeaturePlanTask>) => void;
  onDone: () => void;
}) {
  return (
    <>
      <input className="field" value={card.title} onChange={(e) => onChange({ title: e.target.value })} />
      <textarea
        className="field"
        rows={8}
        value={card.description}
        onChange={(e) => onChange({ description: e.target.value })}
      />
      <textarea
        className="field"
        rows={3}
        placeholder="exit criteria, one per line"
        value={card.exitCriteria.join('\n')}
        onChange={(e) => onChange({ exitCriteria: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
      />
      <div className="plan-card-edit">
        <input
          className="field"
          style={{ flex: 1 }}
          placeholder="category"
          value={card.category ?? ''}
          onChange={(e) => onChange({ category: e.target.value || null })}
        />
        <select
          className="field mono"
          style={{ width: 96 }}
          value={card.effort ?? ''}
          onChange={(e) => onChange({ effort: (e.target.value || null) as EffortLevel | null })}
        >
          <option value="">effort</option>
          {EFFORT_LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <select
          className="field"
          style={{ width: 96 }}
          value={card.review === null || card.review === undefined ? '' : card.review ? 'on' : 'off'}
          onChange={(e) => onChange({ review: e.target.value === '' ? null : e.target.value === 'on' })}
        >
          <option value="">review</option>
          <option value="on">review</option>
          <option value="off">skip</option>
        </select>
      </div>
      <button className="btn" onClick={onDone}>
        Done editing
      </button>
    </>
  );
}

function PlanColumns({
  plan,
  onPlan,
  editable,
}: {
  plan: FeaturePlan;
  onPlan: (next: FeaturePlan) => void;
  editable: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);

  const mutate = (fn: (draft: FeaturePlan) => void) => {
    const next = clone(plan);
    fn(next);
    onPlan(next);
  };

  const move = (pi: number, ti: number, dPhase: number, dIndex: number) =>
    mutate((d) => {
      const from = d.phases[pi];
      const [card] = from.tasks.splice(ti, 1);
      const target = Math.min(Math.max(pi + dPhase, 0), d.phases.length - 1);
      const at = dPhase !== 0 ? d.phases[target].tasks.length : Math.min(Math.max(ti + dIndex, 0), from.tasks.length);
      d.phases[target].tasks.splice(at, 0, card);
    });

  return (
    <div className="phase-board">
      {plan.phases.map((phase, pi) => (
        <div className="phase-col" key={pi}>
          <div className="phase-head">
            <span className="phase-index">phase {pi + 1}</span>
            {editable ? (
              <input
                className="field"
                value={phase.title}
                onChange={(e) => mutate((d) => void (d.phases[pi].title = e.target.value))}
              />
            ) : (
              <span className="phase-title">{phase.title}</span>
            )}
            <span className="phase-goal">{phase.goal}</span>
          </div>

          {phase.tasks.length === 0 && <span className="muted">no cards</span>}

          {phase.tasks.map((card, ti) => (
            <div className={`plan-card ${card.excluded ? 'excluded' : ''}`} key={card.id}>
              {editing === card.id && editable ? (
                <PlanCardEditor
                  card={card}
                  onChange={(patch) => mutate((d) => Object.assign(d.phases[pi].tasks[ti], patch))}
                  onDone={() => setEditing(null)}
                />
              ) : (
                <>
                  <span className="card-title">{card.title}</span>
                  <span className="card-body">{card.description}</span>
                  {card.exitCriteria.length > 0 && (
                    <ul className="crit">
                      {card.exitCriteria.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  )}
                  <div className="card-meta">
                    {card.category && (
                      <span className="chip" style={{ color: 'var(--tm-accent)' }}>
                        {card.category}
                      </span>
                    )}
                    {card.effort && <span className="chip mono">{card.effort}</span>}
                    {card.review === false && <span className="chip">no review</span>}
                    {card.excluded && <span className="chip">excluded</span>}
                  </div>
                </>
              )}
              {editable && (
                <div className="card-tools">
                  <button className="btn ghost" title="Edit this card" onClick={() => setEditing(card.id)}>
                    Edit
                  </button>
                  <button
                    className="btn ghost"
                    title={card.excluded ? 'Include in the approval' : 'Exclude from the approval'}
                    onClick={() => mutate((d) => void (d.phases[pi].tasks[ti].excluded = !card.excluded))}
                  >
                    {card.excluded ? 'Include' : 'Exclude'}
                  </button>
                  <button className="btn ghost" title="Move to the previous phase" disabled={pi === 0} onClick={() => move(pi, ti, -1, 0)}>
                    ←
                  </button>
                  <button
                    className="btn ghost"
                    title="Move to the next phase"
                    disabled={pi === plan.phases.length - 1}
                    onClick={() => move(pi, ti, 1, 0)}
                  >
                    →
                  </button>
                  <button className="btn ghost" title="Move up" disabled={ti === 0} onClick={() => move(pi, ti, 0, -1)}>
                    ↑
                  </button>
                  <button
                    className="btn ghost"
                    title="Move down"
                    disabled={ti === phase.tasks.length - 1}
                    onClick={() => move(pi, ti, 0, 1)}
                  >
                    ↓
                  </button>
                  <button
                    className="btn ghost danger"
                    title="Delete this card"
                    onClick={() => mutate((d) => void d.phases[pi].tasks.splice(ti, 1))}
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>
          ))}

          {editable && (
            <button
              className="btn"
              onClick={() =>
                mutate((d) =>
                  void d.phases[pi].tasks.push({
                    id: newCardId(),
                    title: 'New task',
                    description: '',
                    category: null,
                    effort: null,
                    review: null,
                    exitCriteria: [],
                    excluded: false,
                  }),
                )
              }
            >
              + Add card
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function TaskColumns({
  plan,
  tasks,
  onOpenTask,
}: {
  plan: FeaturePlan | null;
  tasks: Task[];
  onOpenTask: (id: string) => void;
}) {
  const phaseCount = Math.max(
    plan?.phases.length ?? 0,
    ...tasks.map((t) => (t.featurePhase ?? 0) + 1),
    1,
  );
  const unresolved = tasks.filter((t) => !RESOLVED.includes(t.status));
  const current = unresolved.length ? Math.min(...unresolved.map((t) => t.featurePhase ?? 0)) : -1;

  return (
    <div className="phase-board">
      {Array.from({ length: phaseCount }, (_, pi) => {
        const list = tasks.filter((t) => (t.featurePhase ?? 0) === pi);
        const phase = plan?.phases[pi];
        const done = list.filter((t) => RESOLVED.includes(t.status)).length;
        return (
          <div className={`phase-col ${pi === current ? 'current' : ''}`} key={pi}>
            <div className="phase-head">
              <span className="phase-index">
                phase {pi + 1} · {done}/{list.length}
                {pi === current ? ' · current' : ''}
              </span>
              <span className="phase-title">{phase?.title ?? `Phase ${pi + 1}`}</span>
              {phase?.goal && <span className="phase-goal">{phase.goal}</span>}
            </div>
            {list.length === 0 && <span className="muted">no tasks</span>}
            {list.map((t) => (
              <div className="plan-card clickable" key={t.id} onClick={() => onOpenTask(t.id)}>
                <span className="card-title">{t.title}</span>
                <div className="card-meta">
                  <StatusBadge status={t.status} />
                  {t.category && (
                    <span className="chip" style={{ color: 'var(--tm-accent)' }}>
                      {t.category}
                    </span>
                  )}
                  {t.parentId && <span className="chip">subtask</span>}
                </div>
                {t.error && <span className="warn-text">{t.error}</span>}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function FeaturePage({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { features, tasks, repos, refresh } = useApp();
  const feature: Feature | undefined = features.find((f) => f.id === id);
  const featureTasks = useMemo(
    () =>
      tasks
        .filter((t) => t.featureId === id)
        .slice()
        .sort((a, b) => (a.featurePhase ?? 0) - (b.featurePhase ?? 0) || a.createdAt.localeCompare(b.createdAt)),
    [tasks, id],
  );

  const [draftPlan, setDraftPlan] = useState<FeaturePlan | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [showRequest, setShowRequest] = useState(true);
  // The global feature list arrives asynchronously; without this the page
  // would flash "not found" on every cold load.
  const [missing, setMissing] = useState(false);
  const [editRequest, setEditRequest] = useState(false);
  const [requestDraft, setRequestDraft] = useState({ title: '', request: '' });
  const seeded = useRef<string | null>(null);

  // Re-seed the editable plan from the server whenever a NEW analysis lands —
  // but never clobber unsaved local card edits.
  useEffect(() => {
    if (!feature) return;
    const stamp = `${feature.id}:${feature.updatedAt}`;
    if (dirty || seeded.current === stamp) return;
    seeded.current = stamp;
    setDraftPlan(feature.analysis ? clone(feature.analysis) : null);
  }, [feature, dirty]);

  useEffect(() => {
    if (feature && !editRequest) setRequestDraft({ title: feature.title, request: feature.request });
  }, [feature, editRequest]);

  // Deep links land before the global feature list does — probe the server
  // once so we can tell "still loading" from "really gone", and pull the store
  // up to date if this feature was created outside this session.
  useEffect(() => {
    let alive = true;
    setMissing(false);
    api.getFeature(id).then(
      () => {
        if (alive && !features.some((f) => f.id === id)) void refresh();
      },
      () => {
        if (alive) setMissing(true);
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!feature) {
    return (
      <div className="empty panel">
        <div className="big">{missing ? 'Feature not found' : 'Loading…'}</div>
        {missing && <Link to="/features">Back to features</Link>}
      </div>
    );
  }

  const repo = repos.find((r) => r.id === feature.repoId);
  const latestRound = feature.review?.rounds[feature.review.rounds.length - 1] ?? null;
  const preApproval = feature.status === 'proposed';
  const plan = preApproval ? draftPlan : feature.analysis;

  const act = async (label: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(label);
    setErr(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const savePlan = () =>
    act('save', async () => {
      if (!draftPlan) return;
      await api.updateFeaturePlan(feature.id, draftPlan);
      setDirty(false);
      seeded.current = null;
    });

  const included = plan?.phases.reduce((n, p) => n + p.tasks.filter((t) => !t.excluded).length, 0) ?? 0;

  return (
    <div>
      <h1 className="page-title">
        <Link to="/features" className="muted" style={{ textDecoration: 'none' }}>
          Features
        </Link>
        <span className="muted">/</span>
        {feature.title}
      </h1>

      <div className="feature-head">
        <div className="grow">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <FeatureBadge status={feature.status} />
            {repo ? <span className="chip">{repo.name}</span> : <span className="chip">repo removed</span>}
            {feature.analysis && (
              <span className="chip mono">
                {feature.analysis.phases.length} phases · {included} tasks
              </span>
            )}
            {feature.analysisRounds > 0 && <span className="chip mono">{feature.analysisRounds} analysis round(s)</span>}
          </div>
        </div>
        <div className="feature-actions">
          {(feature.status === 'draft' || feature.status === 'proposed' || feature.status === 'failed') && (
            <button
              className="btn"
              disabled={busy !== null}
              onClick={() => act('analyze', () => api.analyzeFeature(feature.id, note))}
              title="Run the headless analysis + adversarial plan review"
            >
              {feature.analysis ? 'Re-analyze' : 'Analyze'}
            </button>
          )}
          {preApproval && (
            <>
              <button className="btn" disabled={busy !== null || !dirty} onClick={savePlan}>
                {busy === 'save' ? 'Saving…' : 'Save plan'}
              </button>
              <button
                className="btn primary"
                disabled={busy !== null || dirty || included === 0}
                title={dirty ? 'Save your plan edits first' : 'Create the tasks for this plan'}
                onClick={() => act('approve', () => api.approveFeature(feature.id))}
              >
                Approve {included} task(s)
              </button>
            </>
          )}
          {feature.status === 'approved' && (
            <button className="btn primary" disabled={busy !== null} onClick={() => act('start', () => api.featureAction(feature.id, 'start'))}>
              Start feature
            </button>
          )}
          {feature.status === 'running' && (
            <button className="btn" disabled={busy !== null} onClick={() => act('pause', () => api.featureAction(feature.id, 'pause'))}>
              Pause
            </button>
          )}
          {feature.status === 'paused' && (
            <button className="btn primary" disabled={busy !== null} onClick={() => act('resume', () => api.featureAction(feature.id, 'resume'))}>
              Resume
            </button>
          )}
          {feature.status === 'review' && (
            <button className="btn primary" disabled={busy !== null} onClick={() => act('complete', () => api.featureAction(feature.id, 'complete'))}>
              Mark feature done
            </button>
          )}
          {!['cancelled', 'done'].includes(feature.status) && (
            <button
              className="btn danger"
              disabled={busy !== null}
              onClick={() => {
                if (!confirm('Cancel this feature? Its draft/queued tasks are cancelled and running ones killed.')) return;
                void act('cancel', () => api.featureAction(feature.id, 'cancel'));
              }}
            >
              Cancel feature
            </button>
          )}
          {featureTasks.length === 0 && (
            <button
              className="btn danger"
              disabled={busy !== null}
              onClick={() => {
                if (!confirm('Delete this feature and its request?')) return;
                void act('delete', async () => {
                  await api.deleteFeature(feature.id);
                  navigate('/features');
                });
              }}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {err && <div className="warn-text" style={{ marginBottom: 12 }}>{err}</div>}
      {feature.error && <div className="warn-text" style={{ marginBottom: 12 }}>{feature.error}</div>}

      <div className="section-head" style={{ cursor: 'pointer' }} onClick={() => setShowRequest((v) => !v)}>
        Request <span className="count">{showRequest ? '−' : '+'}</span>
      </div>
      {showRequest && (
        <div style={{ marginBottom: 18 }}>
          {editRequest ? (
            <div className="panel" style={{ padding: 14 }}>
              <label className="label">Title</label>
              <input
                className="field"
                value={requestDraft.title}
                onChange={(e) => setRequestDraft({ ...requestDraft, title: e.target.value })}
              />
              <label className="label" style={{ marginTop: 10 }}>
                Request
              </label>
              <textarea
                className="field"
                rows={14}
                value={requestDraft.request}
                onChange={(e) => setRequestDraft({ ...requestDraft, request: e.target.value })}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button
                  className="btn primary"
                  disabled={busy !== null}
                  onClick={() =>
                    act('request', async () => {
                      await api.updateFeature(feature.id, requestDraft);
                      setEditRequest(false);
                    })
                  }
                >
                  Save request
                </button>
                <button className="btn" onClick={() => setEditRequest(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <Markdown label="the request" text={feature.request} />
              {['draft', 'proposed', 'failed'].includes(feature.status) && (
                <button className="btn" style={{ marginTop: 10 }} onClick={() => setEditRequest(true)}>
                  Edit request
                </button>
              )}
            </>
          )}
          {['draft', 'proposed', 'failed'].includes(feature.status) && (
            <div className="panel" style={{ marginTop: 12, padding: 14 }}>
              <label className="label">Note for the next analysis (optional)</label>
              <input
                className="field"
                placeholder="e.g. keep phase 1 as-is, split the cloud work further"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          )}
        </div>
      )}

      {feature.status === 'analyzing' && (
        <div className="empty panel" style={{ marginBottom: 18 }}>
          <div className="big">Analyzing…</div>
          A headless planning run is decomposing the request; a second run then reviews the plan adversarially. This
          page updates itself when the plan lands.
        </div>
      )}

      {feature.analysis && (
        <>
          <div className="section-head">Analysis</div>
          <div style={{ marginBottom: 18 }}>
            <Markdown label="summary" text={feature.analysis.summary} />
            {feature.analysis.considerations.length > 0 && (
              <div className="panel" style={{ padding: 14, marginTop: 10 }}>
                <div className="label" style={{ margin: 0 }}>considerations</div>
                <ul
                  style={{
                    marginTop: 8,
                    paddingLeft: 20,
                    color: 'var(--tm-text-muted)',
                    fontSize: 'var(--tm-text-sm)',
                    lineHeight: 1.6,
                  }}
                >
                  {feature.analysis.considerations.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </>
      )}

      {latestRound && (
        <>
          <div className="section-head">
            Adversarial plan review
            <span className={`count verdict-${latestRound.verdict}`}>{latestRound.verdict}</span>
          </div>
          <div className="panel" style={{ padding: 14, marginBottom: 18 }}>
            <div className="muted" style={{ fontSize: 'var(--tm-text-xs)', marginBottom: 8 }}>
              round {latestRound.round} of {feature.review?.rounds.length} · {latestRound.model} ·{' '}
              {new Date(latestRound.at).toLocaleString()}
            </div>
            {latestRound.findings.length === 0 ? (
              <span className="muted">No issues found.</span>
            ) : (
              latestRound.findings.map((f, i) => (
                <div className="finding-row" key={i}>
                  <span className={`sev-tag sev-${f.severity === 'minor' ? 'info' : f.severity === 'major' ? 'warn' : 'critical'}`}>
                    {f.severity}
                  </span>
                  <span>
                    {f.summary}
                    {f.detail ? <span className="muted"> — {f.detail}</span> : null}
                  </span>
                </div>
              ))
            )}
          </div>
        </>
      )}

      <div className="section-head">
        {preApproval ? 'Proposed plan — edit, then approve' : 'Phases'}
        {dirty && <span className="count verdict-minor">unsaved edits</span>}
      </div>
      {plan ? (
        preApproval ? (
          <PlanColumns
            plan={plan}
            editable
            onPlan={(next) => {
              setDraftPlan(next);
              setDirty(true);
            }}
          />
        ) : featureTasks.length > 0 ? (
          <TaskColumns plan={plan} tasks={featureTasks} onOpenTask={onOpenTask} />
        ) : (
          <PlanColumns plan={plan} editable={false} onPlan={() => {}} />
        )
      ) : (
        <div className="empty panel">
          <div className="big">No plan yet</div>
          Run Analyze to decompose the request into ordered phases.
        </div>
      )}
    </div>
  );
}
