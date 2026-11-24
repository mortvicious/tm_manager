// Huddles (docs/office.md § Huddles): the office's huddles, newest first, each
// opening as a messenger thread (docs/magma.md § 13, docs/office.md § Huddles ›
// The thread) — a header with the subject, participants, turns used of the
// cap, status, the decision and Close on an open one; the transcript as
// bubbles; a working row naming the role whose turn is due — plus the
// stakeholder's "Open a huddle" form (a subject is required: no free chat),
// reached from the list header. Humans never post into a huddle, so the thread
// has no composer. The server runs the turns; this only shows the record and
// follows `office-huddle.updated`. Reaching the end marks the huddle read
// (`markRead`, src/officeConversations.ts).
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  type OfficeHuddleEntry,
  type OfficeHuddleView,
  type OfficeRole,
  type OfficeSubjectKind,
} from '@tm/shared';
import { api } from '../api.ts';
import { useArm } from '../arm.ts';
import { useClock } from '../clock.ts';
import { conversationKey, formatUnread, huddleReadMark, markRead, timeUnread } from '../officeConversations.ts';
import { buildThreadOf, dayKey, huddleEntryView, timeLabel, type ThreadOfItem } from '../officeThread.ts';
import { onServerEvent, useApp } from '../state.tsx';
import { toastError } from '../toast.ts';
import { useReadMap } from './officeConversationHooks.ts';
import { DayPill, JumpPill, RoleAvatar, TaskLinks, WorkingRow, fullTime, roleDisplayName, useThreadScroll } from './OfficeThread.tsx';
import { RoleAvatars } from './RoleChip.tsx';
import { fmtAgo, useNow } from './TimeAgo.tsx';

const short = (id: string) => id.slice(0, 8);

function roleName(roles: OfficeRole[], id: string | null): string {
  if (id === null) return 'You (stakeholder)';
  const r = roles.find((x) => x.id === id);
  return r ? `${r.avatar} ${r.name}` : 'deleted role';
}

export interface HuddlesSource {
  huddles: OfficeHuddleView[] | null;
  error: string | null;
  reload: () => void;
}

/** The huddles, re-read on every huddle event of this office. */
export function useHuddles(officeId: string): HuddlesSource {
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

type HuddleGroup = Extract<ThreadOfItem<OfficeHuddleEntry>, { kind: 'group' }>;

/** One speaker's run of huddle bubbles (the opening question is the stakeholder's own, on the right). */
const HuddleGroupView = memo(function HuddleGroupView({ group, roles }: { group: HuddleGroup; roles: OfficeRole[] }) {
  const last = group.messages[group.messages.length - 1];
  const role = group.own ? null : (roles.find((r) => r.id === group.sender) ?? null);
  const name = group.own ? 'You' : roleDisplayName(role);
  return (
    <div className={`thread-group ${group.own ? 'own' : 'other'}`} role="group" aria-label={`${name}, ${fullTime(group.messages[0].at)}`}>
      {!group.own && <RoleAvatar role={role} />}
      <div className="thread-stack">
        {!group.own && <div className="thread-sender">{name}</div>}
        {group.messages.map((e) => (
          <div key={e.messageId} className="thread-item">
            <div className={`thread-bubble${e.taintedAt ? ' tainted' : ''}`} title={fullTime(e.at)}>
              <span className="sr-only">{fullTime(e.at)}: </span>
              <div className="thread-bubble-head">
                <span className="office-huddle-label">{e.kind === 'opening' ? 'Opened' : `Turn ${e.turn ?? '?'}`}</span>
                {e.taintedAt && <span className="chip office-taint">untrusted</span>}
              </div>
              <div className="office-msg-body">{e.text}</div>
              <TaskLinks text={e.text} />
            </div>
          </div>
        ))}
        <time className="thread-time" dateTime={last.at} title={fullTime(last.at)}>
          {timeLabel(new Date(last.at))}
        </time>
      </div>
    </div>
  );
});

/**
 * One huddle as a thread (also the conversation list's thread): the header,
 * the transcript as bubbles (a server note as a centred line), the working
 * row while a turn is due, and the jump pill. `onBack` shows a back button
 * (the phone list); `onChanged` re-reads after Close.
 */
export function HuddleThread({
  office,
  huddle: h,
  roles,
  now,
  inSheet,
  onOpenTask,
  onChanged,
  onBack,
}: {
  office: Office;
  huddle: OfficeHuddleView;
  roles: OfficeRole[];
  now: number;
  inSheet: boolean;
  onOpenTask: (id: string) => void;
  onChanged: () => void;
  onBack?: () => void;
}) {
  const arm = useArm();
  const [busy, setBusy] = useState(false);
  const next = huddleNextRoleId(h);
  const nextRole = next ? (roles.find((r) => r.id === next) ?? null) : null;
  const working = h.status === 'open' && next !== null;
  const logRef = useRef<HTMLDivElement | null>(null);
  const minute = useClock(60_000);
  const today = dayKey(new Date(minute));
  // `today` is in the deps on purpose: the labels change when the day turns
  const items = useMemo(() => buildThreadOf(h.entries, huddleEntryView, new Date()), [h.entries, today]);
  const entries = useMemo(() => h.entries.map((e) => ({ id: e.messageId, own: e.roleId === null && e.kind !== 'server' })), [h.entries]);
  const hRef = useRef(h);
  hRef.current = h;
  const onSeen = useCallback(() => markRead(conversationKey('huddle', h.id), huddleReadMark(hRef.current)), [h.id]);
  const { showPill, fresh, jump } = useThreadScroll(logRef, entries, working, onSeen);

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
    <div className={`office-chat office-huddle-thread${inSheet ? ' in-sheet' : ''}${h.taintedAt ? ' tainted' : ''}`}>
      <div className="office-huddle-head">
        <div className="office-huddle-head-top">
          {onBack && (
            <button className="btn ghost" onClick={onBack} aria-label="Back to the huddles">
              ←
            </button>
          )}
          {h.subject.kind === 'task' ? (
            <button className="office-link office-huddle-subject" onClick={() => onOpenTask(h.subject.id)}>
              {h.subjectLabel}
            </button>
          ) : (
            <span className="office-huddle-subject">{h.subjectLabel}</span>
          )}
          <span className={`chip office-huddle-${h.status}`}>{h.status}</span>
          <span className="muted">
            turn {h.turns}/{h.maxTurns}
          </span>
          {h.taintedAt && <span className="chip office-taint">untrusted</span>}
          {h.status === 'open' && (
            <button
              className={`btn ghost office-huddle-close${arm.armed === 'close' ? ' danger' : ''}`}
              disabled={busy}
              onClick={() => arm.press('close') && void close()}
            >
              {arm.armed === 'close' ? 'Close without a decision? tap again' : 'Close'}
            </button>
          )}
        </div>
        <div className="office-huddle-who muted">
          <RoleAvatars roleIds={h.roleIds} roles={roles} fallback="⧉" />
          <span>
            {h.roleIds.map((id) => roleName(roles, id)).join(' · ')}
            {h.openedBy && ` — opened by ${h.openedBy === 'director' ? 'the Director' : 'you'}`}
            {` — ${formatOfficeTime(Date.parse(h.createdAt), now, office.timezone)}`}
          </span>
        </div>
        {h.decision && (
          <div className={`office-huddle-decision${h.status === 'expired' ? ' muted' : ''}`}>
            <span className="office-huddle-label">{h.status === 'decided' ? 'Decision' : 'Closed'}</span> {h.decision}
            {h.decisionMessageId && <span className="muted"> — sent to the Director to route</span>}
          </div>
        )}
      </div>
      <div className="office-chat-log thread-log" ref={logRef} role="log" aria-live="polite" aria-relevant="additions">
        {h.entries.length === 0 && !working && <div className="muted">Nothing said yet.</div>}
        {items.map((it) =>
          it.kind === 'day' ? (
            <DayPill key={it.key} label={it.label} />
          ) : it.kind === 'system' ? (
            <div key={it.key} className={`thread-system${it.entry.taintedAt ? ' tainted' : ''}`} title={fullTime(it.entry.at)}>
              <span>
                {`Turn ${it.entry.turn ?? '?'} · server: `}
                {it.entry.text}
              </span>
            </div>
          ) : (
            <HuddleGroupView key={it.key} group={it} roles={roles} />
          ),
        )}
        {working && <WorkingRow role={nextRole} label={`${nextRole ? nextRole.name : 'A deleted role'} is taking turn ${h.turns + 1}…`} />}
      </div>
      <div className="thread-foot">
        <JumpPill show={showPill} fresh={fresh} onJump={jump} />
      </div>
    </div>
  );
}

const SUBJECT_KINDS: { kind: OfficeSubjectKind; label: string }[] = [
  { kind: 'task', label: 'A task' },
  { kind: 'proposal', label: 'A proposal (id)' },
  { kind: 'signal', label: 'A signal (id)' },
  { kind: 'message', label: 'A channel message (id)' },
];

/** The stakeholder's "Open a huddle" form (a subject is required). */
export function OpenForm({
  office,
  roles,
  onOpened,
  onCancel,
}: {
  office: Office;
  roles: OfficeRole[];
  onOpened: () => void;
  /** shows a Cancel button (the form was opened from a list header) */
  onCancel?: () => void;
}) {
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
        {onCancel && (
          <button className="btn ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
        {!office.enabled && <span className="muted office-hint">turn the office on first</span>}
      </div>
    </div>
  );
}

const NEW_HUDDLE = 'new';

/**
 * The huddles on their own (the phone sheet): a list, newest first, with
 * "Open a huddle" in its header; a row opens that huddle's thread, ← returns.
 */
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
  const read = useReadMap();
  const [picked, setPicked] = useState<string | null>(null);
  const openCount = huddles?.filter((h) => h.status === 'open').length ?? 0;
  const selected = picked && picked !== NEW_HUDDLE ? (huddles?.find((h) => h.id === picked) ?? null) : null;

  if (selected) {
    return (
      <HuddleThread
        key={selected.id}
        office={office}
        huddle={selected}
        roles={roles}
        now={now}
        inSheet={inSheet}
        onOpenTask={onOpenTask}
        onChanged={reload}
        onBack={() => setPicked(null)}
      />
    );
  }
  return (
    <div className="office-huddles">
      <div className={`office-section-title office-conv-title-bar${inSheet ? ' in-sheet' : ''}`}>
        <span>
          {!inSheet && 'Huddles '}
          <span className="muted">{openCount ? `${openCount} open` : ''}</span>
        </span>
        <button className={`btn ghost${picked === NEW_HUDDLE ? ' active' : ''}`} onClick={() => setPicked(picked === NEW_HUDDLE ? null : NEW_HUDDLE)}>
          Open a huddle
        </button>
      </div>
      {picked === NEW_HUDDLE && (
        <OpenForm
          office={office}
          roles={roles}
          onOpened={() => {
            reload();
            setPicked(null);
          }}
          onCancel={() => setPicked(null)}
        />
      )}
      {picked !== null && picked !== NEW_HUDDLE && huddles && <div className="muted office-pad">This huddle is gone.</div>}
      {huddles === null && !error && <div className="muted office-pad">Loading…</div>}
      {huddles?.length === 0 && picked !== NEW_HUDDLE && (
        <div className="muted office-pad">
          No huddles yet — 2–3 roles settle one subject in a few turns. The Director opens one from the channel, or you open one here.
        </div>
      )}
      {huddles && huddles.length > 0 && (
        <ul className="office-huddle-list" aria-label="Huddles">
          {huddles.map((h) => {
            const last = h.entries.length ? h.entries[h.entries.length - 1] : null;
            const lastAt = last?.at ?? h.createdAt;
            // a fresh device (no read store yet) reads as nothing unread, like the conversation list
            const badge = read ? formatUnread(timeUnread(h.entries.map((e) => e.at), read[conversationKey('huddle', h.id)])) : null;
            return (
              <li key={h.id}>
                <button className="office-conv-row" onClick={() => setPicked(h.id)}>
                  <RoleAvatars roleIds={h.roleIds} roles={roles} fallback="⧉" />
                  <span className="office-conv-main">
                    <span className="office-conv-top">
                      <span className="office-conv-title">{h.subjectLabel}</span>
                      <time className="office-conv-time" dateTime={lastAt}>
                        {fmtAgo(now - Date.parse(lastAt))}
                      </time>
                    </span>
                    <span className="office-conv-bottom">
                      <span className={`office-conv-preview${last?.taintedAt ? ' tainted' : ''}`}>
                        {last ? last.text : (h.decision ?? 'Nothing said yet')}
                      </span>
                      {h.status === 'open' && huddleNextRoleId(h) !== null && (
                        <span className="office-conv-working" title="a turn is due">
                          <span className="sr-only">working</span>
                        </span>
                      )}
                      {badge && <span className="office-conv-unread">{badge}</span>}
                    </span>
                    <span className="office-conv-detail">
                      turn {h.turns}/{h.maxTurns} · {h.status}
                      {h.taintedAt && <span className="chip office-taint">untrusted</span>}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && <div className="warn-text office-pad">{error}</div>}
    </div>
  );
}
