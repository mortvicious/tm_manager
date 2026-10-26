import { useEffect, useMemo, useState, useSyncExternalStore, type SyntheticEvent } from 'react';
import { imagePreviewType, referencedFileNames, type Question, type QuestionItem, type QuestionOption } from '@tm/shared';
import { api } from '../api.ts';
import { exitGhost } from '../motion.ts';
import { useApp } from '../state.tsx';
import { IconX } from './Icons.tsx';
import { ImageLightbox, type LightboxImage } from './ImageLightbox.tsx';
import { useIsMobile } from './Layout.tsx';
import { Sheet } from './Sheet.tsx';

// docs/questions.md — the browser half. A worker's AskUserQuestion pops up
// here on whatever page is open: the task's title, each question with its
// options, an "Other" free-text line, and one Submit that hands every answer
// back to the waiting agent. Closing the modal only dismisses it for this
// question; the header chip reopens it, and the task panel shows the same
// form inline.
//
// Images (docs/questions.md § Images): AskUserQuestion has no image field, so
// an agent that wants a mockup seen saves it in $TM_ARTIFACTS_DIR and NAMES
// the file in the question, an option's label/description or its `preview`.
// The form resolves those names against the task's files and shows them as
// thumbnails — on the option that named them, else under the question — with
// the task panel's lightbox one click away.

/** index of the synthetic "Other" card; options are picked by INDEX so two
 *  options with the same label stay distinct */
const OTHER = -1;

/** an option's own text — every place an agent may name an image */
const optionText = (o: QuestionOption) => [o.label, o.description, typeof o.preview === 'string' ? o.preview : ''].join('\n');

/** The CLI's preview text, unless it is nothing but the image references
 *  already shown as thumbnails (then the box would only repeat a file name). */
function previewText(o: QuestionOption, shown: readonly string[]): string | null {
  if (typeof o.preview !== 'string' || !o.preview.trim()) return null;
  let rest = o.preview.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  for (const n of shown) rest = rest.split(n).join('');
  return /[\p{L}\p{N}]/u.test(rest.replace(/\$TM_ARTIFACTS_DIR/g, '')) ? o.preview : null;
}

type Media = {
  /** per question: images named in the question text but by none of its options */
  question: string[][];
  /** per question, per option: images that option names */
  options: string[][][];
};

/** what a thumbnail needs from the form: its URL, the lightbox, and a way to
 *  report a file deleted since the list was read (its tile is dropped) */
type Gallery = { srcOf: (name: string) => string; open: (name: string) => void; broken: (name: string) => void };

function Thumbs({ names, gallery, label }: { names: string[]; gallery: Gallery; label: string }) {
  if (names.length === 0) return null;
  return (
    <div className="qthumbs">
      {names.map((n) => (
        <button
          type="button"
          key={n}
          className="qthumb"
          onClick={() => gallery.open(n)}
          title={`Preview ${n}`}
          aria-label={`Preview ${n} (${label})`}
        >
          <img src={gallery.srcOf(n)} alt={n} decoding="async" onError={() => gallery.broken(n)} />
        </button>
      ))}
    </div>
  );
}

function Item({
  item,
  value,
  onChange,
  images,
  optionImages,
  gallery,
}: {
  item: QuestionItem;
  value: { picked: number[]; other: string };
  onChange: (v: { picked: number[]; other: string }) => void;
  images: string[];
  optionImages: string[][];
  gallery: Gallery;
}) {
  const toggle = (i: number) => {
    if (item.multiSelect) {
      const picked = value.picked.includes(i) ? value.picked.filter((x) => x !== i) : [...value.picked, i];
      onChange({ ...value, picked });
    } else {
      onChange({ ...value, picked: [i] });
    }
  };
  const otherOn = value.picked.includes(OTHER);
  const card = (i: number, label: string, desc: string) => {
    const on = value.picked.includes(i);
    return (
      <button type="button" key={i} className={`qopt${on ? ' on' : ''}`} onClick={() => toggle(i)} aria-pressed={on}>
        <span className={`qmark${item.multiSelect ? ' box' : ''}`} />
        <span className="qopt-body">
          <span className="qopt-label">{label}</span>
          {desc && <span className="qopt-desc">{desc}</span>}
        </span>
      </button>
    );
  };
  return (
    <div className="qitem">
      <div className="qitem-head">
        {item.header && <span className="chip">{item.header}</span>}
        <span className="qitem-q">{item.question}</span>
        {item.multiSelect && <span className="muted qitem-hint">pick every option that applies</span>}
      </div>
      <Thumbs names={images} gallery={gallery} label={item.header || 'question'} />
      <div className="qopts">
        {item.options.map((o, i) => {
          const named = optionImages[i] ?? [];
          const preview = previewText(o, named);
          if (named.length === 0 && !preview) return card(i, o.label, o.description);
          return (
            <div key={i} className="qopt-group">
              {card(i, o.label, o.description)}
              <div className="qopt-media">
                <Thumbs names={named} gallery={gallery} label={o.label} />
                {preview && <pre className="qopt-preview">{preview}</pre>}
              </div>
            </div>
          );
        })}
        {card(OTHER, 'Other', 'type your own answer')}
        {otherOn && (
          <textarea
            className="field"
            rows={2}
            autoFocus
            placeholder="Your answer"
            value={value.other}
            onChange={(e) => onChange({ ...value, other: e.target.value })}
          />
        )}
      </div>
    </div>
  );
}

type Draft = Record<number, { picked: number[]; other: string }>;

type ImageFile = { name: string; mtime: string };

const fileUrl = (taskId: string, name: string) => `/api/tasks/${taskId}/files/${encodeURIComponent(name)}`;

/** Portal events bubble through the React tree: keep a pinch or drag inside the
 *  lightbox from reaching a <Sheet> the form sits in (it would drag the sheet). */
const stop = (e: SyntheticEvent) => e.stopPropagation();

/** What one part answers with, or null while it is incomplete. */
function answerOf(item: QuestionItem, v: { picked: number[]; other: string } | undefined): string | null {
  if (!v || v.picked.length === 0) return null;
  const parts = v.picked
    .slice()
    .sort((a, b) => a - b)
    .map((i) => (i === OTHER ? v.other.trim() : item.options[i]?.label ?? ''))
    .filter(Boolean);
  if (parts.length !== v.picked.length) return null; // "Other" ticked but empty
  return parts.join(', ');
}

/**
 * Half-answered questions, by question id (docs/questions.md § Drafts): the
 * form is unmounted by every dismissal — an overlay click, a swipe down the
 * phone sheet, the panel closing — and a dismissal must only hide it. Shared by
 * every QuestionForm, so a pick in the modal is there in the task panel too.
 * Dropped once the answer is accepted.
 */
const questionDrafts = new Map<string, Draft>();
const draftListeners = new Set<() => void>();
const NO_DRAFT: Draft = {};
const subscribeDrafts = (l: () => void) => {
  draftListeners.add(l);
  return () => {
    draftListeners.delete(l);
  };
};
function setQuestionDraft(id: string, d: Draft | null) {
  if (d) questionDrafts.set(id, d);
  else questionDrafts.delete(id);
  for (const l of draftListeners) l();
}

/** Anything picked or typed — what a stray swipe would cost. */
const draftTouched = (d: Draft | undefined): boolean =>
  !!d && Object.values(d).some((v) => v.picked.length > 0 || v.other.trim() !== '');

/** The form itself — shared by the modal and the task panel. */
export function QuestionForm({ question, onDone }: { question: Question; onDone?: () => void }) {
  // the store is the state: an unmount at any moment loses nothing, and the
  // modal and the task panel showing the same question stay one draft
  const draft = useSyncExternalStore(subscribeDrafts, () => questionDrafts.get(question.id) ?? NO_DRAFT);
  const setDraft = (next: (d: Draft) => Draft) =>
    setQuestionDraft(question.id, next(questionDrafts.get(question.id) ?? NO_DRAFT));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setErr(null), [question.id]);

  // the task's images, read once per question: the agent saved them before it asked
  const [files, setFiles] = useState<ImageFile[]>([]);
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const [preview, setPreview] = useState(-1);
  useEffect(() => {
    let live = true;
    setFiles([]);
    setBroken(new Set());
    setPreview(-1);
    api
      .taskFiles(question.taskId)
      .then((fs) => live && setFiles(fs.filter((f) => imagePreviewType(f.name)).map((f) => ({ name: f.name, mtime: f.mtime }))))
      .catch(() => {}); // no files, no thumbnails — the question still works
    return () => {
      live = false;
    };
  }, [question.id, question.taskId]);

  const media = useMemo<Media>(() => {
    const names = files.map((f) => f.name).filter((n) => !broken.has(n));
    const options = question.questions.map((item) => item.options.map((o) => referencedFileNames(optionText(o), names)));
    const question_ = question.questions.map((item, qi) => {
      const onOptions = new Set(options[qi].flat());
      return referencedFileNames(item.question, names).filter((n) => !onOptions.has(n));
    });
    return { question: question_, options };
  }, [files, broken, question]);

  // one lightbox over every image the form shows, in reading order
  const shown = useMemo(() => {
    const out: string[] = [];
    media.question.forEach((q, qi) => {
      for (const n of [...q, ...media.options[qi].flat()]) if (!out.includes(n)) out.push(n);
    });
    return out;
  }, [media]);
  const images = useMemo<LightboxImage[]>(
    () =>
      shown.map((name) => {
        const url = fileUrl(question.taskId, name);
        const f = files.find((x) => x.name === name);
        return { name, src: `${url}?inline=1&v=${encodeURIComponent(f?.mtime ?? '')}`, download: url };
      }),
    [shown, files, question.taskId],
  );
  const gallery: Gallery = {
    srcOf: (name) => images.find((im) => im.name === name)?.src ?? '',
    open: (name) => setPreview(shown.indexOf(name)),
    broken: (name) => setBroken((b) => (b.has(name) ? b : new Set(b).add(name))),
  };

  const answers = useMemo(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < question.questions.length; i++) {
      const a = answerOf(question.questions[i], draft[i]);
      if (a === null) return null;
      out[question.questions[i].question] = a;
    }
    return out;
  }, [draft, question]);

  const submit = async () => {
    if (!answers) return;
    setBusy(true);
    setErr(null);
    try {
      await api.answerQuestion(question.id, answers);
      setQuestionDraft(question.id, null);
      onDone?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="qform">
      {question.questions.map((item, i) => (
        <Item
          key={i}
          item={item}
          value={draft[i] ?? { picked: [], other: '' }}
          onChange={(v) => setDraft((d) => ({ ...d, [i]: v }))}
          images={media.question[i] ?? []}
          optionImages={media.options[i] ?? []}
          gallery={gallery}
        />
      ))}
      {err && <div className="warn-text">{err}</div>}
      <div className="qform-foot">
        <span className="muted">The agent is waiting inside its session for this answer.</span>
        <button className="btn primary" disabled={!answers || busy} onClick={submit}>
          {busy ? 'Sending…' : 'Answer'}
        </button>
      </div>
      <div
        hidden
        onPointerDown={stop}
        onPointerMove={stop}
        onPointerUp={stop}
        onPointerCancel={stop}
        onMouseDown={stop}
        onTouchStart={stop}
        onTouchMove={stop}
        onTouchEnd={stop}
        onWheel={stop}
        onClick={stop}
      >
        <ImageLightbox images={images} index={preview} onIndex={setPreview} onClose={() => setPreview(-1)} />
      </div>
    </div>
  );
}

export function QuestionModal() {
  const { questions, tasks, questionNudge } = useApp();
  const mobile = useIsMobile();
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  // the header chip: reopen whatever was dismissed
  useEffect(() => {
    if (questionNudge > 0) setDismissed(new Set());
  }, [questionNudge]);

  // the slice is the pending set (state.tsx); oldest first
  const pending = useMemo(() => [...questions].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [questions]);
  const current = pending.find((q) => !dismissed.has(q.id)) ?? null;
  const touched = useSyncExternalStore(subscribeDrafts, () =>
    current ? draftTouched(questionDrafts.get(current.id)) : false,
  );

  useEffect(() => {
    if (!current) return;
    // Capture phase, and stop there: this is the topmost layer, so one Escape
    // must not also close a slide-over underneath. Typing in the "Other"
    // field is not a dismissal.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      // an image lightbox (opened from this form) is above the modal: the key is
      // its own, and stopping it here would keep it from ever reaching the viewer
      if (e.defaultPrevented || document.querySelector('.yarl__root')) return;
      e.stopPropagation();
      setDismissed((d) => new Set(d).add(current.id));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [current]);

  if (!current) return null;
  const task = tasks.find((t) => t.id === current.taskId);
  const close = () => setDismissed((d) => new Set(d).add(current.id));
  const head = (dismiss: () => void) => (
    <div className="qmodal-head">
      <span className="badge s-attention">
        <span className="dot" /> asks you
      </span>
      <span className="qmodal-title">{task?.title ?? `task ${current.taskId.slice(0, 8)}`}</span>
      {pending.length > 1 && <span className="chip">{pending.length} waiting</span>}
      <span className="spacer" style={{ flex: 1 }} />
      <button className="btn ghost" onClick={dismiss} title="Dismiss for now (the ❓ chip in the header brings it back)">
        <IconX />
      </button>
    </div>
  );
  // A phone: a sheet above every other sheet; swiping it down is "not now".
  // Once an answer is under way the form stops dragging the sheet — a flick
  // while scrolling the options must not dismiss it — and only the grip does.
  if (mobile)
    return (
      <Sheet
        key={current.id}
        label="An agent is asking you"
        className="qsheet sheet-flush"
        zIndex={41}
        onClose={close}
        head={head}
        disableDrag={touched}
      >
        <QuestionForm question={current} />
      </Sheet>
    );
  return (
    <>
      <div className="overlay qmodal-overlay" ref={exitGhost} onClick={close} />
      <div className="qmodal" ref={exitGhost} role="dialog" aria-label="An agent is asking you">
        {head(close)}
        <div className="qmodal-body">
          <QuestionForm question={current} />
        </div>
      </div>
    </>
  );
}
