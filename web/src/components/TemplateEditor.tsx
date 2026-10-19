import { useMemo, useState } from 'react';
import {
  TASK_TEMPLATE_MAX,
  TASK_TEMPLATE_NAME_MAX,
  taskTemplateProblem,
  type TaskPreset,
  type TaskTemplate,
} from '@tm/shared';
import { useApp } from '../state.tsx';
import { IconTrash } from './Icons.tsx';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** `t-` + 8 base36 chars (TASK_TEMPLATE_ID_RE). Not crypto.randomUUID — that is absent over plain-http LAN mode. */
function newTemplateId(taken: Set<string>): string {
  for (;;) {
    let s = 't-';
    for (let i = 0; i < 8; i++) s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    if (!taken.has(s)) return s;
  }
}

type ChecksMode = 'all' | 'none' | 'only';
const modeOf = (c: string[] | null): ChecksMode => (c == null ? 'all' : c.length ? 'only' : 'none');

/**
 * Config → Templates (docs/inbox.md § Templates): task CONTENT — a title
 * pattern, a description skeleton, a definition of done, which checks, and a
 * preset by name. Persisted by the page's Save as `task.templates`; the
 * warning is `taskTemplateProblem`, the rule the server's PUT runs.
 */
export function TemplateEditor({
  value,
  onChange,
  presets,
}: {
  value: TaskTemplate[];
  onChange: (v: TaskTemplate[]) => void;
  /** built-ins + the custom presets as they stand on this page (unsaved edits included) */
  presets: TaskPreset[];
}) {
  const { commands } = useApp();
  const checkNames = useMemo(
    () => [...new Set(commands.filter((c) => c.isCheck).map((c) => c.name))].sort(),
    [commands],
  );
  const problem = taskTemplateProblem(value, presets);
  const patch = (i: number, p: Partial<TaskTemplate>) => onChange(value.map((t, j) => (j === i ? { ...t, ...p } : t)));
  const add = () =>
    onChange([
      ...value,
      {
        id: newTemplateId(new Set(value.map((t) => t.id))),
        name: '',
        title: '',
        description: '',
        acceptance: '',
        checks: null,
        preset: null,
      },
    ]);

  return (
    <div className="template-list">
      {value.map((t, i) => (
        <TemplateCard
          key={t.id}
          t={t}
          presets={presets}
          checkNames={checkNames}
          onPatch={(p) => patch(i, p)}
          onDelete={() => onChange(value.filter((_, j) => j !== i))}
        />
      ))}
      {problem && <div className="warn-text">{problem}</div>}
      <div>
        <button type="button" className="btn" disabled={value.length >= TASK_TEMPLATE_MAX} onClick={add}>
          + Add template
        </button>
      </div>
    </div>
  );
}

function TemplateCard({
  t,
  presets,
  checkNames,
  onPatch,
  onDelete,
}: {
  t: TaskTemplate;
  presets: TaskPreset[];
  checkNames: string[];
  onPatch: (p: Partial<TaskTemplate>) => void;
  onDelete: () => void;
}) {
  // "only these" is a mode of the form, not of the value: an emptied list must
  // not flip the select to "none" under the cursor (it SAVES as none — the hint says so)
  const [only, setOnly] = useState(modeOf(t.checks) === 'only');
  const mode: ChecksMode = only ? 'only' : modeOf(t.checks);
  // the raw text, so a trailing comma survives while the next name is typed
  const [raw, setRaw] = useState((t.checks ?? []).join(', '));
  return (
    <div className="panel template-card">
      <div className="template-head">
        <input
          className="field"
          aria-label="Template name"
          placeholder="Name — “Bug fix”, “UI change + screenshot”"
          maxLength={TASK_TEMPLATE_NAME_MAX}
          value={t.name}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <button
          type="button"
          className="btn ghost"
          title="Delete this template"
          aria-label={`Delete template ${t.name || ''}`}
          onClick={onDelete}
        >
          <IconTrash />
        </button>
      </div>
      <div className="form-grid">
        <div className="wide">
          <label className="label">Title pattern</label>
          <input
            className="field"
            placeholder="Fix: {}   — {} is where the typed title goes; without it the pattern is a prefix"
            value={t.title}
            onChange={(e) => onPatch({ title: e.target.value })}
          />
        </div>
        <div className="wide">
          <label className="label">Description skeleton</label>
          <textarea
            className="field"
            rows={3}
            placeholder={'## Steps to reproduce\n## Expected\n## Actual'}
            value={t.description}
            onChange={(e) => onPatch({ description: e.target.value })}
          />
        </div>
        <div className="wide">
          <label className="label">Definition of done</label>
          <textarea
            className="field"
            rows={2}
            placeholder="What must be true when it is finished"
            value={t.acceptance}
            onChange={(e) => onPatch({ acceptance: e.target.value })}
          />
        </div>
        <div>
          <label className="label">Checks</label>
          <select
            className="field"
            value={mode}
            onChange={(e) => {
              const m = e.target.value as ChecksMode;
              setOnly(m === 'only');
              const checks =
                m === 'all' ? null : m === 'none' ? [] : t.checks?.length ? t.checks : checkNames.slice(0, 1);
              setRaw((checks ?? []).join(', '));
              onPatch({ checks });
            }}
          >
            <option value="all">the repo's default (all)</option>
            <option value="none">none</option>
            <option value="only">only these…</option>
          </select>
        </div>
        <div>
          <label className="label">Preset</label>
          <select
            className="field"
            value={t.preset ?? ''}
            onChange={(e) => onPatch({ preset: e.target.value || null })}
          >
            <option value="">none (form defaults)</option>
            {/* a preset deleted since stays visible so the problem line can name it */}
            {t.preset && !presets.some((p) => p.id === t.preset) && <option value={t.preset}>{t.preset} (gone)</option>}
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} — {p.hint}
              </option>
            ))}
          </select>
        </div>
        {mode === 'only' && (
          <div className="wide">
            <input
              className="field mono"
              aria-label="Check names"
              placeholder={
                checkNames.length
                  ? `check names, comma-separated: ${checkNames.join(', ')}`
                  : 'check names, comma-separated'
              }
              value={raw}
              onChange={(e) => {
                setRaw(e.target.value);
                onPatch({
                  checks: e.target.value
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                });
              }}
            />
            <div className="hint">
              Names belong to a repo: a repo keeps the names it has, and one that has none of them runs all its checks.
              An empty list saves as none.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
