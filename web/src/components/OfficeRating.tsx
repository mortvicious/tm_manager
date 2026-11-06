// Stakeholder 👍/👎 on an office role's work (docs/office.md § Ratings): a
// brief, a proposal, a role-tagged task or a role's channel message. One
// rating per subject — pressing the other thumb changes it, a comment is
// optional and is the stakeholder's own (trusted) line in the role's feedback
// file. Ratings follow `office-rating.updated`, so the phone's Telegram press
// shows up here live.
import { useEffect, useMemo, useState } from 'react';
import { OFFICE_RATING_COMMENT_MAX, type OfficeRating, type OfficeRatingSubjectKind, type OfficeRatingValue } from '@tm/shared';
import { api } from '../api.ts';
import { onServerEvent } from '../state.tsx';

export const ratingKey = (kind: OfficeRatingSubjectKind, id: string) => `${kind}:${id}`;

/**
 * The ratings of one office (`officeId`), or of a fixed subject list. Keyed by
 * `ratingKey`. Live: an `office-rating.updated` for a matching subject replaces it.
 */
export function useOfficeRatings(q: { officeId?: string; kind?: OfficeRatingSubjectKind; ids?: readonly string[] }): Map<string, OfficeRating> {
  const idsKey = q.ids ? q.ids.join(',') : null;
  const [list, setList] = useState<OfficeRating[]>([]);
  useEffect(() => {
    let live = true;
    const ids = idsKey === null ? undefined : idsKey ? idsKey.split(',') : [];
    setList([]);
    if (!q.officeId && !ids?.length) return;
    api.listOfficeRatings({ officeId: q.officeId, kind: q.kind, ids }).then(
      (l) => live && setList(l),
      () => {},
    );
    const wanted = ids ? new Set(ids) : null;
    const off = onServerEvent((e) => {
      if (e.type !== 'office-rating.updated') return;
      const r = e.rating;
      if (q.officeId && r.officeId !== q.officeId) return;
      if (q.kind && r.subjectKind !== q.kind) return;
      if (wanted && !wanted.has(r.subjectId)) return;
      setList((cur) => [r, ...cur.filter((x) => x.id !== r.id)]);
    });
    return () => {
      live = false;
      off();
    };
  }, [q.officeId, q.kind, idsKey]);
  return useMemo(() => new Map(list.map((r) => [ratingKey(r.subjectKind, r.subjectId), r])), [list]);
}

/** One subject's rating (the task panel). */
export function useOfficeRating(kind: OfficeRatingSubjectKind, id: string, enabled = true): OfficeRating | null {
  const ids = useMemo(() => (enabled ? [id] : []), [enabled, id]);
  return useOfficeRatings({ kind, ids }).get(ratingKey(kind, id)) ?? null;
}

/**
 * 👍 / 👎 (+ an optional comment). `rating` is what the parent's hook holds;
 * the buttons show the server's answer right away and the broadcast confirms it.
 */
export function RatingButtons({
  kind,
  id,
  rating,
  compact = false,
}: {
  kind: OfficeRatingSubjectKind;
  id: string;
  rating: OfficeRating | null | undefined;
  /** no comment editor, just the thumbs (a dense row) */
  compact?: boolean;
}) {
  const [local, setLocal] = useState<OfficeRating | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // the newer of the parent's row and our own answer
  const cur = !local ? (rating ?? null) : !rating || rating.id !== local.id || local.updatedAt >= rating.updatedAt ? local : rating;

  const send = async (value: OfficeRatingValue, comment?: string | null) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.rateOffice({ kind, id, value, ...(comment !== undefined ? { comment } : {}) });
      setLocal(r.rating);
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const thumb = (value: OfficeRatingValue) => {
    const on = cur?.value === value;
    return (
      <button
        type="button"
        className={`btn ghost office-rating-btn${on ? ' on' : ''}${value === 1 ? ' up' : ' down'}`}
        aria-pressed={on}
        title={value === 1 ? 'Good work — tell the role' : 'Not useful — tell the role'}
        aria-label={value === 1 ? 'thumbs up' : 'thumbs down'}
        disabled={busy}
        onClick={(ev) => {
          ev.stopPropagation();
          if (!on) void send(value);
          else if (!compact) {
            setDraft(cur?.comment ?? '');
            setEditing(true);
          }
        }}
      >
        {value === 1 ? '👍' : '👎'}
      </button>
    );
  };

  return (
    <span className="office-rating" onClick={(ev) => ev.stopPropagation()}>
      {thumb(1)}
      {thumb(-1)}
      {!compact && cur && !editing && (
        <button
          type="button"
          className="btn ghost office-rating-comment-btn"
          disabled={busy}
          onClick={() => {
            setDraft(cur.comment ?? '');
            setEditing(true);
          }}
        >
          {cur.comment ? <span className="office-rating-comment">“{cur.comment}”</span> : 'add a comment'}
        </button>
      )}
      {editing && cur && (
        <form
          className="office-rating-form"
          onSubmit={(ev) => {
            ev.preventDefault();
            void send(cur.value, draft.trim() ? draft : null);
          }}
        >
          <input
            className="input"
            autoFocus
            maxLength={OFFICE_RATING_COMMENT_MAX}
            placeholder="Why? (the role reads it next shift)"
            value={draft}
            onChange={(ev) => setDraft(ev.target.value)}
          />
          <button type="submit" className="btn" disabled={busy}>
            Save
          </button>
          <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      )}
      {err && <span className="warn-text">{err}</span>}
    </span>
  );
}
