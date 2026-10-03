import { useEffect, useMemo, useState } from 'react';
import type { Question, QuestionItem } from '@tm/shared';
import { api } from '../api.ts';
import { exitGhost } from '../motion.ts';
import { useApp } from '../state.tsx';
import { IconX } from './Icons.tsx';

// docs/questions.md — the browser half. A worker's AskUserQuestion pops up
// here on whatever page is open: the task's title, each question with its
// options, an "Other" free-text line, and one Submit that hands every answer
// back to the waiting agent. Closing the modal only dismisses it for this
// question; the header chip reopens it, and the task panel shows the same
// form inline.

/** index of the synthetic "Other" card; options are picked by INDEX so two
 *  options with the same label stay distinct */
const OTHER = -1;

function Item({
  item,
  value,
  onChange,
}: {
  item: QuestionItem;
  value: { picked: number[]; other: string };
  onChange: (v: { picked: number[]; other: string }) => void;
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
      <div className="qopts">
        {item.options.map((o, i) => card(i, o.label, o.description))}
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

/** The form itself — shared by the modal and the task panel. */
export function QuestionForm({ question, onDone }: { question: Question; onDone?: () => void }) {
  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setDraft({});
    setErr(null);
  }, [question.id]);

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
        />
      ))}
      {err && <div className="warn-text">{err}</div>}
      <div className="qform-foot">
        <span className="muted">The agent is waiting inside its session for this answer.</span>
        <button className="btn primary" disabled={!answers || busy} onClick={submit}>
          {busy ? 'Sending…' : 'Answer'}
        </button>
      </div>
    </div>
  );
}

export function QuestionModal() {
  const { questions, tasks, questionNudge } = useApp();
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  // the header chip: reopen whatever was dismissed
  useEffect(() => {
    if (questionNudge > 0) setDismissed(new Set());
  }, [questionNudge]);

  // the slice is the pending set (state.tsx); oldest first
  const pending = useMemo(() => [...questions].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [questions]);
  const current = pending.find((q) => !dismissed.has(q.id)) ?? null;

  useEffect(() => {
    if (!current) return;
    // Capture phase, and stop there: this is the topmost layer, so one Escape
    // must not also close a slide-over underneath. Typing in the "Other"
    // field is not a dismissal.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      e.stopPropagation();
      setDismissed((d) => new Set(d).add(current.id));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [current]);

  if (!current) return null;
  const task = tasks.find((t) => t.id === current.taskId);
  const close = () => setDismissed((d) => new Set(d).add(current.id));
  return (
    <>
      <div className="overlay qmodal-overlay" ref={exitGhost} onClick={close} />
      <div className="qmodal" ref={exitGhost} role="dialog" aria-label="An agent is asking you">
        <div className="qmodal-head">
          <span className="badge s-attention">
            <span className="dot" /> asks you
          </span>
          <span className="qmodal-title">{task?.title ?? `task ${current.taskId.slice(0, 8)}`}</span>
          {pending.length > 1 && <span className="chip">{pending.length} waiting</span>}
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn ghost" onClick={close} title="Dismiss for now (the ❓ chip in the header brings it back)">
            <IconX />
          </button>
        </div>
        <div className="qmodal-body">
          <QuestionForm question={current} />
        </div>
      </div>
    </>
  );
}
