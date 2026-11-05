// The office channel (docs/office.md § Channel): the history of role and
// stakeholder messages, oldest first, each with what the Director's routing
// made of it (a task, a note, a huddle, a forward) or why it still waits; the
// stakeholder's composer; and Mark reviewed on a tainted message, which
// releases its text to the next routing shift. The server routes; this only
// shows the record and follows `office-message.created|updated`.
import { useCallback, useEffect, useState } from 'react';
import {
  OFFICE_MESSAGE_BODY_MAX,
  OFFICE_MESSAGE_KINDS,
  OFFICE_MESSAGE_SUBJECT_MAX,
  OFFICE_ROUTE_MAX_PASSES,
  formatOfficeTime,
  isStandupRole,
  splitOfficeMessage,
  type Office,
  type OfficeChannelResponse,
  type OfficeMessage,
  type OfficeMessageKind,
  type OfficeMessageRoute,
  type OfficeRole,
} from '@tm/shared';
import { api } from '../api.ts';
import { useArm } from '../arm.ts';
import { onServerEvent } from '../state.tsx';
import { toastError } from '../toast.ts';
import { useNow } from './TimeAgo.tsx';

const short = (id: string) => id.slice(0, 8);

function roleLabel(roles: OfficeRole[], id: string | null, none: string): string {
  if (id === null) return none;
  const r = roles.find((x) => x.id === id);
  return r ? `${r.avatar} ${r.name}` : 'deleted role';
}

/** The channel, re-read on every message event of this office. */
function useChannel(officeId: string): { channel: OfficeChannelResponse | null; error: string | null; reload: () => void } {
  const [channel, setChannel] = useState<OfficeChannelResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api.officeChannel(officeId).then(
      (c) => (setChannel(c), setError(null)),
      (e) => setError((e as Error)?.message || String(e)),
    );
  }, [officeId]);
  useEffect(() => {
    setChannel(null);
    reload();
    return onServerEvent((e) => {
      if ((e.type === 'office-message.created' || e.type === 'office-message.updated') && e.message.officeId === officeId) reload();
    });
  }, [officeId, reload]);
  return { channel, error, reload };
}

function RouteLine({
  route,
  roles,
  onOpenTask,
}: {
  route: OfficeMessageRoute;
  roles: OfficeRole[];
  onOpenTask: (id: string) => void;
}) {
  const note = route.note ? (
    <span className="office-msg-note">
      “{route.note}”{route.tainted && <span className="chip office-taint">untrusted</span>}
    </span>
  ) : null;
  switch (route.action) {
    case 'task':
      return (
        <div className="office-msg-route">
          routed → task{' '}
          {route.taskId ? (
            <button className="office-link mono" onClick={() => onOpenTask(route.taskId!)}>
              {short(route.taskId)}
            </button>
          ) : route.proposalId ? (
            <span>— a proposal waits for you in the Inbox</span>
          ) : (
            <span className="warn-text">not filed{route.dropped ? `: ${route.dropped}` : ''}</span>
          )}{' '}
          {note}
        </div>
      );
    case 'huddle':
      return (
        <div className="office-msg-route">
          routed → huddle <span className="mono">{short(route.huddleId ?? '')}</span> {note}
        </div>
      );
    case 'forward':
      return (
        <div className="office-msg-route">
          routed → forwarded to {roleLabel(roles, route.toRoleId ?? null, 'channel')} {note}
        </div>
      );
    case 'note':
      return <div className="office-msg-route">routed → note {note}</div>;
    case 'deliver':
      return <div className="office-msg-route">delivered to {roleLabel(roles, route.toRoleId ?? null, 'channel')}</div>;
  }
}

function MessageRow({
  office,
  message: m,
  roles,
  route,
  passes,
  dueAt,
  now,
  onOpenTask,
  onChanged,
}: {
  office: Office;
  message: OfficeMessage;
  roles: OfficeRole[];
  route: OfficeMessageRoute | undefined;
  passes: number;
  dueAt: string | null;
  now: number;
  onOpenTask: (id: string) => void;
  onChanged: () => void;
}) {
  const arm = useArm();
  const [busy, setBusy] = useState(false);
  const { subject, body } = splitOfficeMessage(m.body);
  const mark = async () => {
    if (!m.taintedAt) return;
    setBusy(true);
    try {
      await api.markOfficeMessageReviewed(m.id, { taintedAt: m.taintedAt });
    } catch (e) {
      toastError(e, 'Could not mark the message reviewed');
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const waiting = !m.routedAt && (
    <div className="office-msg-route muted">
      {passes >= OFFICE_ROUTE_MAX_PASSES
        ? `not routed after ${passes} Director shifts — it no longer wakes the Director${m.taintedAt ? '; mark it reviewed to release its text' : ''}`
        : dueAt
          ? `waiting for the Director's routing pass (${formatOfficeTime(Date.parse(dueAt), now, office.timezone)})${passes ? ` · shown ${passes}×` : ''}`
          : 'waiting for the Director'}
    </div>
  );
  return (
    <div className={`office-msg${m.taintedAt ? ' tainted' : ''}`}>
      <div className="office-msg-head">
        <span className="office-shift-when">{formatOfficeTime(Date.parse(m.createdAt), now, office.timezone)}</span>
        <span className="office-shift-role">{roleLabel(roles, m.fromRoleId, 'You (stakeholder)')}</span>
        <span className="muted">→ {roleLabel(roles, m.toRoleId, 'channel')}</span>
        <span className="chip">{m.kind}</span>
        {m.taintedAt && <span className="chip office-taint">untrusted</span>}
        {m.reviewedAt && <span className="chip">reviewed</span>}
      </div>
      <div className="office-msg-subject">{subject}</div>
      {body && <div className="office-msg-body">{body}</div>}
      {route ? <RouteLine route={route} roles={roles} onOpenTask={onOpenTask} /> : waiting}
      {m.taintedAt && (
        <div className="office-actions">
          <button
            className={`btn${arm.armed === 'msg-reviewed' ? ' danger' : ''}`}
            disabled={busy}
            onClick={() => arm.press('msg-reviewed') && void mark()}
          >
            {arm.armed === 'msg-reviewed' ? 'Read and safe? tap again' : 'Mark reviewed'}
          </button>
          <span className="muted office-hint">
            written by a shift that read untrusted input — the Director sees only a digest until you vouch for this text
          </span>
        </div>
      )}
    </div>
  );
}

function Composer({ office, roles, onSent }: { office: Office; roles: OfficeRole[]; onSent: () => void }) {
  const [to, setTo] = useState('director');
  const [kind, setKind] = useState<OfficeMessageKind>('request');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const others = roles.filter((r) => !isStandupRole(r));
  const send = async () => {
    if (!subject.trim()) return;
    setBusy(true);
    try {
      await api.postOfficeMessage(office.id, { to: to === 'channel' ? null : to, kind, subject: subject.trim(), body: body.trim() });
      setSubject('');
      setBody('');
      onSent();
    } catch (e) {
      toastError(e, 'Could not send the message');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="office-msg-compose">
      <div className="office-msg-compose-row">
        <select className="field" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To">
          <option value="director">To the Director</option>
          {others.map((r) => (
            <option key={r.id} value={r.key}>
              To {r.name}
            </option>
          ))}
          <option value="channel">To the channel</option>
        </select>
        <select className="field" value={kind} onChange={(e) => setKind(e.target.value as OfficeMessageKind)} aria-label="Kind">
          {OFFICE_MESSAGE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>
      <input
        className="field"
        placeholder="Subject"
        maxLength={OFFICE_MESSAGE_SUBJECT_MAX}
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
      />
      <textarea
        className="field"
        rows={3}
        maxLength={OFFICE_MESSAGE_BODY_MAX}
        placeholder="The Director routes it: a task, a note, a huddle, or a forward."
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="office-actions">
        <button className="btn primary" disabled={busy || !subject.trim()} onClick={() => void send()}>
          Send
        </button>
      </div>
    </div>
  );
}

export function OfficeChannel({
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
  const { channel, error, reload } = useChannel(office.id);
  const unrouted = channel?.messages.filter((m) => !m.routedAt).length ?? 0;
  return (
    <div className="office-channel">
      {!inSheet && (
        <div className="office-section-title">
          Channel <span className="muted">{unrouted ? `${unrouted} unrouted` : ''}</span>
        </div>
      )}
      {channel === null && !error && <div className="muted office-pad">Loading…</div>}
      {channel?.messages.length === 0 && (
        <div className="muted office-pad">No messages yet — roles write here, and the Director routes each into a task, a note, a huddle or a forward.</div>
      )}
      {channel?.messages.map((m) => (
        <MessageRow
          key={m.id}
          office={office}
          message={m}
          roles={roles}
          route={channel.routes[m.id]}
          passes={channel.passes[m.id] ?? 0}
          dueAt={channel.routingDueAt}
          now={now}
          onOpenTask={onOpenTask}
          onChanged={reload}
        />
      ))}
      {error && <div className="warn-text office-pad">{error}</div>}
      <Composer office={office} roles={roles} onSent={reload} />
    </div>
  );
}
