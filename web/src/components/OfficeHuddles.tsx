// Huddles (docs/office.md § Huddles): the office's huddles, newest first —
// subject, participants, turns used of the cap, status, the decision and the
// transcript — plus the stakeholder's "Open a huddle" form (a subject is
// required: no free chat) and Close on an open one. The server runs the
// turns; this only shows the record and follows `office-huddle.updated`.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  OFFICE_HUDDLE_DEFAULT_TURNS,
  OFFICE_HUDDLE_MAX_ROLES,
  OFFICE_HUDDLE_MAX_TURNS,
  OFFICE_HUDDLE_MIN_ROLES,
  OFFICE_HUDDLE_MIN_TURNS,
  OFFICE_HUDDLE_QUESTION_MAX,
  TERMINAL_TASK_STATUSES,
  formatOfficeTime,
  huddleNextRoleId,
  isStandupRole,
  type Office,
  type OfficeHuddleView,
  type OfficeRole,
  type OfficeSubjectKind,
} from '@tm/shared';
import { api } from '../api.ts';
import { useArm } from '../arm.ts';
import { onServerEvent, useApp } from '../state.tsx';
import { toastError } from '../toast.ts';
import { useNow } from './TimeAgo.tsx';

const short = (id: string) => id.slice(0, 8);

function roleName(roles: OfficeRole[], id: string | null): string {
  if (id === null) return 'You (stakeholder)';
  const r = roles.find((x) => x.id === id);
  return r ? `${r.avatar} ${r.name}` : 'deleted role';
}

/** The huddles, re-read on every huddle event of this office. */
function useHuddles(officeId: string): { huddles: OfficeHuddleView[] | null; error: string | null; reload: () => void } {
  const [huddles, setHuddles] = useState<OfficeHuddleView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api.officeHuddles(officeId).then(
      (r) => (setHuddles(r.huddles), setError(null)),
      (e) => setError((e as Error)?.message || String(e)),
    );
  }, [officeId]);
  useEffect(() => {
    setHuddles(null);
    reload();
    return onServerEvent((e) => {
      if (e.type === 'office-huddle.updated' && e.huddle.officeId === officeId) reload();
    });
  }, [officeId, reload]);
  return { huddles, error, reload };
}

function HuddleRow({
  office,
  huddle: h,
  roles,
  now,
  onOpenTask,
  onChanged,
}: {
  office: Office;
  huddle: OfficeHuddleView;
  roles: OfficeRole[];
  now: number;
  onOpenTask: (id: string) => void;
  onChanged: () => void;
}) {
  const arm = useArm();
  const [open, setOpen] = useState(h.status === 'open');
  const [busy, setBusy] = useState(false);
  const next = huddleNextRoleId(h);
  const close = async () => {
    setBusy(true);
    try {
      await api.closeOfficeHuddle(h.id);
    } catch (e) {
      toastError(e, 'Could not close the huddle');
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return (
    <div className={`office-huddle${h.taintedAt ? ' tainted' : ''}`}>
      <div className="office-msg-head">
        <span className="office-shift-when">{formatOfficeTime(Date.parse(h.createdAt), now, office.timezone)}</span>
        {h.subject.kind === 'task' ? (
          <button className="office-link" onClick={() => onOpenTask(h.subject.id)}>
            {h.subjectLabel}
          </button>
        ) : (
          <span className="office-shift-role">{h.subjectLabel}</span>
        )}
        <span className={`chip office-huddle-${h.status}`}>{h.status}</span>
        <span className="muted">
          turn {h.turns}/{h.maxTurns}
        </span>
        {h.taintedAt && <span className="chip office-taint">untrusted</span>}
        <button className="btn ghost office-huddle-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide' : 'Transcript'}
        </button>
      </div>
      <div className="office-huddle-who muted">
        {h.roleIds.map((id) => roleName(roles, id)).join(' · ')}
        {h.openedBy && ` — opened by ${h.openedBy === 'director' ? 'the Director' : 'you'}`}
        {h.status === 'open' && next && ` — next: ${roleName(roles, next)}`}
      </div>
      {h.decision && (
        <div className={`office-huddle-decision${h.status === 'expired' ? ' muted' : ''}`}>
          <span className="office-huddle-label">{h.status === 'decided' ? 'Decision' : 'Closed'}</span> {h.decision}
          {h.decisionMessageId && <span className="muted"> — sent to the Director to route</span>}
        </div>
      )}
      {open && (
        <div className="office-huddle-transcript">
          {h.entries.length === 0 && <div className="muted">Nothing said yet.</div>}
          {h.entries.map((e) => (
            <div key={e.messageId} className={`office-huddle-line${e.taintedAt ? ' tainted' : ''}${e.kind === 'server' ? ' server' : ''}`}>
              <span className="office-huddle-label">
                {e.kind === 'opening' ? 'Opened' : `Turn ${e.turn ?? '?'}`} · {e.kind === 'server' ? 'server' : roleName(roles, e.roleId)}
              </span>
              {e.taintedAt && <span className="chip office-taint">untrusted</span>}
              <div className="office-msg-body">{e.text}</div>
            </div>
          ))}
        </div>
      )}
      {h.status === 'open' && (
        <div className="office-actions">
          <button className={`btn${arm.armed === 'close' ? ' danger' : ''}`} disabled={busy} onClick={() => arm.press('close') && void close()}>
            {arm.armed === 'close' ? 'Close without a decision? tap again' : 'Close'}
          </button>
        </div>
      )}
    </div>
  );
}

const SUBJECT_KINDS: { kind: OfficeSubjectKind; label: string }[] = [
  { kind: 'task', label: 'A task' },
  { kind: 'proposal', label: 'A proposal (id)' },
  { kind: 'signal', label: 'A signal (id)' },
  { kind: 'message', label: 'A channel message (id)' },
];

function OpenForm({ office, roles, onOpened }: { office: Office; roles: OfficeRole[]; onOpened: () => void }) {
  const { tasks, workspaces } = useApp();
  const [kind, setKind] = useState<OfficeSubjectKind>('task');
  const [subjectId, setSubjectId] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [maxTurns, setMaxTurns] = useState(OFFICE_HUDDLE_DEFAULT_TURNS);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const repoIds = useMemo(() => new Set(workspaces.find((w) => w.id === office.workspaceId)?.repoIds ?? []), [workspaces, office.workspaceId]);
  const openTasks = useMemo(
    () =>
      tasks
        .filter((t) => t.repoId && repoIds.has(t.repoId) && !(TERMINAL_TASK_STATUSES as readonly string[]).includes(t.status))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 100),
    [tasks, repoIds],
  );
  const enabled = roles.filter((r) => r.enabled);
  const toggle = (key: string) =>
    setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : p.length >= OFFICE_HUDDLE_MAX_ROLES ? p : [...p, key]));
  const ready = subjectId.trim() !== '' && picked.length >= OFFICE_HUDDLE_MIN_ROLES && picked.length <= OFFICE_HUDDLE_MAX_ROLES;
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      await api.openOfficeHuddle(office.id, {
        subject: { kind, id: subjectId.trim() },
        roles: picked,
        maxTurns,
        question: question.trim() || null,
      });
      setSubjectId('');
      setPicked([]);
      setQuestion('');
      onOpened();
    } catch (e) {
      toastError(e, 'Could not open the huddle');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="office-msg-compose">
      <div className="office-msg-compose-row">
        <select
          className="field"
          value={kind}
          aria-label="Subject kind"
          onChange={(e) => {
            setKind(e.target.value as OfficeSubjectKind);
            setSubjectId('');
          }}
        >
          {SUBJECT_KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
        {kind === 'task' ? (
          <select className="field" value={subjectId} aria-label="Task" onChange={(e) => setSubjectId(e.target.value)}>
            <option value="">Pick an open task…</option>
            {openTasks.map((t) => (
              <option key={t.id} value={t.id}>
                {short(t.id)} — {t.title}
              </option>
            ))}
          </select>
        ) : (
          <input className="field mono" placeholder={`${kind} id`} value={subjectId} onChange={(e) => setSubjectId(e.target.value)} />
        )}
      </div>
      <div className="office-huddle-roles" role="group" aria-label="Participants">
        {enabled.map((r) => (
          <label key={r.id} className="office-huddle-role">
            <input type="checkbox" checked={picked.includes(isStandupRole(r) ? 'director' : r.key)} onChange={() => toggle(isStandupRole(r) ? 'director' : r.key)} />
            {r.avatar} {r.name}
          </label>
        ))}
      </div>
      <div className="office-msg-compose-row">
        <label className="muted">
          Turns{' '}
          <select className="field" value={maxTurns} onChange={(e) => setMaxTurns(Number(e.target.value))} aria-label="Turns">
            {Array.from({ length: OFFICE_HUDDLE_MAX_TURNS - OFFICE_HUDDLE_MIN_TURNS + 1 }, (_, i) => OFFICE_HUDDLE_MIN_TURNS + i).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <span className="muted office-hint">
          {OFFICE_HUDDLE_MIN_ROLES}–{OFFICE_HUDDLE_MAX_ROLES} roles, one turn each in their own session; the last turn must decide
        </span>
      </div>
      <textarea
        className="field"
        rows={2}
        maxLength={OFFICE_HUDDLE_QUESTION_MAX}
        placeholder="What should they settle? (optional — the transcript's first line)"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
      />
      <div className="office-actions">
        <button className="btn primary" disabled={busy || !ready || !office.enabled} onClick={() => void submit()}>
          Open huddle
        </button>
        {!office.enabled && <span className="muted office-hint">turn the office on first</span>}
      </div>
    </div>
  );
}

export function OfficeHuddles({
  office,
  roles,
  inSheet,
  onOpenTask,
}: {
  office: Office;
  roles: OfficeRole[];
  inSheet: boolean;
  onOpenTask: (id: string) => void;
}) {
  const now = useNow();
  const { huddles, error, reload } = useHuddles(office.id);
  const openCount = huddles?.filter((h) => h.status === 'open').length ?? 0;
  return (
    <div className="office-huddles">
      {!inSheet && (
        <div className="office-section-title">
          Huddles <span className="muted">{openCount ? `${openCount} open` : ''}</span>
        </div>
      )}
      {huddles === null && !error && <div className="muted office-pad">Loading…</div>}
      {huddles?.length === 0 && (
        <div className="muted office-pad">
          No huddles yet — 2–3 roles settle one subject in a few turns. The Director opens one from the channel, or you open one below.
        </div>
      )}
      {huddles?.map((h) => (
        <HuddleRow key={h.id} office={office} huddle={h} roles={roles} now={now} onOpenTask={onOpenTask} onChanged={reload} />
      ))}
      {error && <div className="warn-text office-pad">{error}</div>}
      <OpenForm office={office} roles={roles} onOpened={reload} />
    </div>
  );
}
