// Wishes and vision (docs/office.md § Wishes and vision): the wish form (the
// Inbox and /office), the wish list, and the vision / priorities editor with a
// preview. A wish wakes the Director; a doc save that CHANGED the file wakes it
// for a re-plan. The server writes the files; this only reports what it did.
import { useCallback, useEffect, useState } from 'react';
import {
  OFFICE_DOC_MAX_CHARS,
  OFFICE_WISH_TEXT_MAX,
  formatOfficeTime,
  type Office,
  type OfficeDirectorWake,
  type OfficeDocView,
  type OfficeEditableDoc,
  type OfficeReadableDoc,
  type OfficeWish,
  type OfficeWishStatus,
} from '@tm/shared';
import { api } from '../api.ts';
import { onServerEvent, useApp } from '../state.tsx';
import { Markdown } from './Markdown.tsx';
import { Sheet } from './Sheet.tsx';
import { useNow } from './TimeAgo.tsx';
import { toastDone, toastError, toastInfo } from '../toast.ts';

const errText = (e: unknown) => (e as Error)?.message || String(e);

/** One line on what the Director wake came to. */
export function wakeText(w: OfficeDirectorWake | null): string {
  if (!w) return '';
  if (w.ok) return 'the Director is on it';
  return w.pending ? `the Director will pick it up when a slot frees (${w.error})` : `the Director was not woken: ${w.error}`;
}

// ---------------------------------------------------------------------------
// Wish form
// ---------------------------------------------------------------------------

/** Text + Send. `offices` with more than one entry shows a picker. */
export function WishForm({ offices, onSent, autoFocus }: { offices: Office[]; onSent?: () => void; autoFocus?: boolean }) {
  const { workspaces } = useApp();
  const [officeId, setOfficeId] = useState(offices[0]?.id ?? '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!offices.some((o) => o.id === officeId)) setOfficeId(offices[0]?.id ?? '');
  }, [offices, officeId]);
  if (!offices.length) return <div className="muted office-pad">No office in this workspace — create one on the Office page.</div>;
  const send = async () => {
    if (!text.trim() || !officeId) return;
    setBusy(true);
    try {
      const r = await api.createOfficeWish(officeId, text.trim());
      setText('');
      (r.wake.ok ? toastDone : toastInfo)(`wish:${r.wish.id}`, `Wish saved — ${wakeText(r.wake)}`);
      onSent?.();
    } catch (e) {
      toastError(e, 'Could not save the wish');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="office-wish-form">
      {offices.length > 1 && (
        <select className="field" value={officeId} onChange={(e) => setOfficeId(e.target.value)} aria-label="Office">
          {offices.map((o) => (
            <option key={o.id} value={o.id}>
              {workspaces.find((w) => w.id === o.workspaceId)?.name ?? 'Office'}
            </option>
          ))}
        </select>
      )}
      <textarea
        className="field"
        rows={3}
        maxLength={OFFICE_WISH_TEXT_MAX}
        placeholder="What should the office work toward? The Director re-plans with it."
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
        }}
      />
      <div className="office-actions">
        <button className="btn primary" disabled={busy || !text.trim()} onClick={() => void send()}>
          {busy ? 'Saving…' : 'Add wish'}
        </button>
        <span className="muted office-hint">wakes the Director (the office's budget and pause still apply)</span>
      </div>
    </div>
  );
}

/**
 * The Inbox's entry: `open` is the page's state — the button sits in the title,
 * the form below it on desktop, in a `<Sheet>` on a phone.
 */
export function InboxWishButton({ offices, open, onToggle }: { offices: Office[]; open: boolean; onToggle: () => void }) {
  if (!offices.length) return null;
  return (
    <button type="button" className={`btn ghost${open ? ' on' : ''}`} onClick={onToggle} title="a standing wish for the Virtual Office's Director">
      + Wish
    </button>
  );
}

export function InboxWishForm({ offices, mobile, onClose }: { offices: Office[]; mobile: boolean; onClose: () => void }) {
  if (!offices.length) return null;
  const form = <WishForm offices={offices} autoFocus onSent={onClose} />;
  return mobile ? (
    <Sheet label="Wish" title="A wish for the office" onClose={onClose} disableDrag>
      {form}
    </Sheet>
  ) : (
    <div className="panel inbox-wish">{form}</div>
  );
}

// ---------------------------------------------------------------------------
// Wish list
// ---------------------------------------------------------------------------

const STATUSES: OfficeWishStatus[] = ['open', 'planned', 'done', 'dropped'];

export function useOfficeWishes(officeId: string): { wishes: OfficeWish[] | null; reload: () => void } {
  const [wishes, setWishes] = useState<OfficeWish[] | null>(null);
  const reload = useCallback(() => {
    api.listOfficeWishes(officeId).then(setWishes, () => {});
  }, [officeId]);
  useEffect(() => {
    setWishes(null);
    reload();
    return onServerEvent((e) => {
      if (e.type !== 'office-wish.updated' || e.wish.officeId !== officeId) return;
      setWishes((cur) => {
        if (!cur) return cur;
        const i = cur.findIndex((w) => w.id === e.wish.id);
        return i < 0 ? [...cur, e.wish] : cur.map((w) => (w.id === e.wish.id ? e.wish : w));
      });
    });
  }, [officeId, reload]);
  return { wishes, reload };
}

function WishList({ office, wishes }: { office: Office; wishes: OfficeWish[] | null }) {
  const now = useNow();
  const [showClosed, setShowClosed] = useState(false);
  if (wishes === null) return <div className="muted office-pad">Loading…</div>;
  const closed = wishes.filter((w) => w.status === 'done' || w.status === 'dropped');
  const shown = showClosed ? wishes : wishes.filter((w) => w.status === 'open' || w.status === 'planned');
  const set = async (w: OfficeWish, status: OfficeWishStatus) => {
    try {
      await api.patchOfficeWish(w.id, { status });
    } catch (e) {
      toastError(e, 'Could not change the wish');
    }
  };
  return (
    <div className="office-wish-list">
      {shown.length === 0 && <div className="muted office-pad">No open wishes.</div>}
      {shown.map((w) => (
        <div key={w.id} className={`office-wish-row ${w.status}`}>
          <span className="office-wish-text">{w.text}</span>
          <span className="muted office-hint">{formatOfficeTime(Date.parse(w.createdAt), now, office.timezone)}</span>
          <select className="field office-wish-status" value={w.status} aria-label="Wish status" onChange={(e) => void set(w, e.target.value as OfficeWishStatus)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      ))}
      {closed.length > 0 && (
        <button type="button" className="btn ghost office-gap" onClick={() => setShowClosed((v) => !v)}>
          {showClosed ? 'Hide done and dropped' : `Show done and dropped (${closed.length})`}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Doc editor
// ---------------------------------------------------------------------------

const DOC_LABEL: Record<OfficeReadableDoc, string> = { 'vision.md': 'Vision', 'priorities.md': 'Priorities', 'roadmap.md': 'Roadmap' };

function DocEditor({ office, name, onClose }: { office: Office; name: OfficeEditableDoc; onClose: () => void }) {
  const [doc, setDoc] = useState<OfficeDocView | null>(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.getOfficeDoc(office.id, name).then(
      (d) => (setDoc(d), setText(d.content)),
      (e) => setErr(errText(e)),
    );
  }, [office.id, name]);
  const save = async () => {
    if (!doc) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.putOfficeDoc(office.id, name, { content: text, baseSha256: doc.sha256 });
      setDoc(r.doc);
      if (!r.changed) toastInfo(`doc:${name}`, `${name} unchanged — nothing to re-plan`);
      else (r.wake?.ok ? toastDone : toastInfo)(`doc:${name}`, `${name} saved — ${wakeText(r.wake)}`);
      onClose();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  if (!doc) return err ? <div className="warn-text office-pad">{err}</div> : <div className="muted office-pad">Loading…</div>;
  return (
    <div className="office-doc-editor">
      <div className="office-doc-tabs" role="tablist">
        <button role="tab" aria-selected={!preview} className={`btn ghost${!preview ? ' on' : ''}`} onClick={() => setPreview(false)}>
          Edit
        </button>
        <button role="tab" aria-selected={preview} className={`btn ghost${preview ? ' on' : ''}`} onClick={() => setPreview(true)}>
          Preview
        </button>
        <span className="muted office-hint">{text.length} / {OFFICE_DOC_MAX_CHARS}</span>
      </div>
      {preview ? (
        <div className="office-doc-preview">{text.trim() ? <Markdown label={name} text={text} safe /> : <div className="muted">(empty)</div>}</div>
      ) : (
        <textarea className="field office-doc-text mono" value={text} maxLength={OFFICE_DOC_MAX_CHARS} onChange={(e) => setText(e.target.value)} />
      )}
      <div className="office-actions">
        <button className="btn primary" disabled={busy || text === doc.content} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <span className="muted office-hint">a change wakes the Director to re-plan the roadmap</span>
      </div>
      {err && <div className="warn-text">{err}</div>}
    </div>
  );
}

function DocView({ office, name, onEdit }: { office: Office; name: OfficeReadableDoc; onEdit?: () => void }) {
  const [doc, setDoc] = useState<OfficeDocView | null>(null);
  const load = useCallback(() => {
    api.getOfficeDoc(office.id, name).then(setDoc, () => {});
  }, [office.id, name]);
  useEffect(() => {
    load();
    // a save, a hand edit the tick noticed, or a shift that rewrote the roadmap all announce `office.updated`
    return onServerEvent((e) => {
      if (e.type === 'office.updated' && e.office.id === office.id) load();
    });
  }, [office.id, load]);
  return (
    <div className="office-doc">
      <div className="office-doc-head">
        <span className="office-doc-name">{DOC_LABEL[name]}</span>
        <span className="muted mono office-hint">{name}</span>
        <span style={{ flex: 1 }} />
        {onEdit ? (
          <button className="btn ghost" onClick={onEdit}>
            Edit
          </button>
        ) : (
          <span className="muted office-hint">written by the Director</span>
        )}
      </div>
      {doc === null ? (
        <div className="muted">Loading…</div>
      ) : doc.content.trim() ? (
        <Markdown label={name} text={doc.content} safe />
      ) : (
        <div className="muted">(empty)</div>
      )}
    </div>
  );
}

/** The /office panel (on a phone: the content of its `<Sheet>`): vision, priorities, roadmap and wishes. */
export function OfficeVision({ office }: { office: Office }) {
  const [editing, setEditing] = useState<OfficeEditableDoc | null>(null);
  const [tab, setTab] = useState<OfficeReadableDoc | 'wishes'>('wishes');
  const { wishes } = useOfficeWishes(office.id);
  const open = wishes?.filter((w) => w.status === 'open').length ?? 0;
  const editor = editing && <DocEditor key={editing} office={office} name={editing} onClose={() => setEditing(null)} />;
  return (
    <div className="office-vision">
      <div className="office-doc-tabs office-pad" role="tablist">
        {(['wishes', 'vision.md', 'priorities.md', 'roadmap.md'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`btn ghost${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}>
            {t === 'wishes' ? `Wishes${open ? ` · ${open}` : ''}` : DOC_LABEL[t]}
          </button>
        ))}
      </div>
      {tab === 'wishes' ? (
        <>
          <WishForm offices={[office]} />
          <WishList office={office} wishes={wishes} />
        </>
      ) : editing === tab ? (
        editor
      ) : (
        <DocView office={office} name={tab} onEdit={tab === 'roadmap.md' ? undefined : () => setEditing(tab)} />
      )}
    </div>
  );
}
