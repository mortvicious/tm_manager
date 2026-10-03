import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import { GROUP_COLOR_COUNT, type Task, type TaskStatus } from '@tm/shared';
import { IconCheck, IconChevron, IconPencil, IconX } from './Icons.tsx';

// The header of one task group on the board (docs/grouping.md § Board). It is
// three controls and a drop target:
//   caret        folds the group down to this one line (and back)
//   name         filters the board to the group; double-click renames it
//   pencil       rename + colour, inline — Enter saves, Escape abandons
//   the header   [data-drop-group] — a task dropped here is appended to it
// The name and colour live on the group's ROOT row, which is what `onRename`
// and `onColor` patch.

/** Status order of the folded summary — live work first, history last. */
const SUMMARY_ORDER: TaskStatus[] = [
  'running',
  'waiting',
  'review',
  'queued',
  'draft',
  'blocked',
  'failed',
  'done',
  'published',
  'cancelled',
];

export function GroupHead({
  groupId,
  label,
  name,
  color,
  shown,
  size,
  members,
  collapsed,
  dropClass,
  onToggle,
  onFilter,
  onRename,
  onColor,
}: {
  groupId: string;
  /** what the header reads — the root's group name, else its title */
  label: string;
  /** the root's stored name (null = unnamed), the rename field's start value */
  name: string | null;
  /** the root's stored colour slot (null = derived from the id) */
  color: number | null;
  /** rows of this group in this list */
  shown: number;
  /** the whole group, all lists */
  size: number;
  /** the rows of this block — the folded summary counts them */
  members: Task[];
  collapsed: boolean;
  dropClass: string;
  onToggle: () => void;
  onFilter: () => void;
  onRename: (name: string | null) => Promise<void>;
  onColor: (slot: number | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const start = () => {
    setDraft(name ?? '');
    setEditing(true);
  };
  const commit = async () => {
    const next = draft.trim() || null;
    if (next === name) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await onRename(next);
      setEditing(false);
    } catch {
      // the board shows the error; the field stays open with the text intact
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setEditing(false);
    }
  };

  const counts = new Map<TaskStatus, number>();
  for (const t of members) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const summary = SUMMARY_ORDER.filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${s}`)
    .join(' · ');

  return (
    <div className={`task-group-head ${dropClass}`} data-drop-group={groupId}>
      <button
        className="group-fold"
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand group' : 'Collapse group'}
        title={collapsed ? 'Expand group' : 'Collapse group'}
        onClick={onToggle}
      >
        <span className={`caret ${collapsed ? 'closed' : ''}`}>
          <IconChevron />
        </span>
      </button>
      {editing ? (
        <>
          <input
            className="field group-rename"
            autoFocus
            aria-label="Group name"
            placeholder={label}
            maxLength={80}
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
          />
          <span className="group-swatches" role="radiogroup" aria-label="Group colour">
            {Array.from({ length: GROUP_COLOR_COUNT }, (_, i) => i + 1).map((slot) => (
              <button
                key={slot}
                role="radio"
                aria-checked={color === slot}
                aria-label={`colour ${slot}`}
                title={`colour ${slot}`}
                className={`group-swatch-dot ${color === slot ? 'on' : ''}`}
                style={{ '--tm-group': `var(--tm-group-${slot})` } as CSSProperties}
                disabled={busy}
                onClick={() => void onColor(slot)}
              />
            ))}
            <button
              role="radio"
              aria-checked={color == null}
              className={`group-swatch-auto ${color == null ? 'on' : ''}`}
              title="auto — derived from the group"
              disabled={busy}
              onClick={() => void onColor(null)}
            >
              auto
            </button>
          </span>
          <button className="group-icon" title="Save name (Enter)" aria-label="Save name" disabled={busy} onClick={() => void commit()}>
            <IconCheck />
          </button>
          <button className="group-icon" title="Cancel (Escape)" aria-label="Cancel" disabled={busy} onClick={() => setEditing(false)}>
            <IconX />
          </button>
        </>
      ) : (
        <>
          <button
            className="name"
            title={`Filter the board to this group (${size} tasks) · double-click to rename`}
            onClick={onFilter}
            onDoubleClick={start}
          >
            {label}
          </button>
          <span className="count">{shown}</span>
          {shown < size && <span className="part">of {size}</span>}
          {collapsed && summary && <span className="summary">{summary}</span>}
          <span className="grow" />
          <button className="group-icon" title="Rename or recolour group" aria-label="Rename group" onClick={start}>
            <IconPencil />
          </button>
        </>
      )}
    </div>
  );
}
