import {
  CUSTOM_PRESET_LABEL_MAX,
  CUSTOM_PRESET_MAX,
  EFFORT_LEVELS,
  GROUP_COLOR_COUNT,
  MODEL_OPTIONS,
  TASK_PRESETS,
  customPresetProblem,
  presetHint,
  type CustomTaskPreset,
  type EffortLevel,
} from '@tm/shared';
import { IconTrash } from './Icons.tsx';
import { presetClass, presetTitle, reviewChoiceOf, reviewValueOf, type ReviewChoice } from './PresetPicker.tsx';

/** The per-task model list plus the Codex id the built-in `codexFree` preset uses (as Telegram's MODEL_CHOICES). */
const PRESET_MODELS = [...MODEL_OPTIONS, 'codex-free'];

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** `p-` + 8 base36 chars (CUSTOM_PRESET_ID_RE). Not crypto.randomUUID — that is absent over plain-http LAN mode. */
function newPresetId(taken: Set<string>): string {
  for (;;) {
    let s = 'p-';
    for (let i = 0; i < 8; i++) s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    if (!taken.has(s)) return s;
  }
}

/**
 * Config → Presets: the built-ins (read-only) and the user's own presets
 * (`presets.custom`), edited in place and persisted by the page's Save like
 * every other setting. The list-level rules come from `customPresetProblem`,
 * the same function the server's validator runs, so the warning here is the
 * 400 Save would get.
 */
export function PresetEditor({
  value,
  onChange,
}: {
  value: CustomTaskPreset[];
  onChange: (next: CustomTaskPreset[]) => void;
}) {
  const problem = customPresetProblem(value);
  const patch = (i: number, p: Partial<CustomTaskPreset>) =>
    onChange(value.map((c, j) => (j === i ? { ...c, ...p } : c)));

  const add = () => {
    const used = new Set(value.map((c) => c.color));
    const color = Array.from({ length: GROUP_COLOR_COUNT }, (_, i) => i + 1).find((n) => !used.has(n)) ?? 1;
    const names = new Set([...TASK_PRESETS, ...value].map((p) => p.label.toLowerCase()));
    let n = value.length + 1;
    while (names.has(`preset ${n}`)) n++;
    onChange([
      ...value,
      {
        id: newPresetId(new Set(value.map((c) => c.id))),
        label: `Preset ${n}`,
        model: 'claude-opus-5-5',
        effort: 'high',
        review: null,
        color,
      },
    ]);
  };

  return (
    <>
      <div className="cfg-row">
        <div>
          <div>Built-in</div>
          <div className="hint">always offered first; not editable</div>
        </div>
        <span className="preset-row">
          {TASK_PRESETS.map((p) => (
            <span key={p.id} className={`chip preset-chip ${presetClass(p)}`} title={presetTitle(p)}>
              <span className="preset-dot" aria-hidden="true" />
              {p.label}
            </span>
          ))}
        </span>
      </div>

      {value.length === 0 && (
        <div className="cmd-empty">No custom presets yet — add one to offer it next to the built-ins.</div>
      )}
      {value.map((c, i) => {
        const models = PRESET_MODELS.includes(c.model) ? PRESET_MODELS : [c.model, ...PRESET_MODELS];
        const shown = { ...c, hint: presetHint(c), custom: true };
        return (
          <div key={c.id} className="preset-edit-row">
            <input
              className="field"
              style={{ width: 150 }}
              value={c.label}
              maxLength={CUSTOM_PRESET_LABEL_MAX}
              placeholder="name"
              aria-label="Preset name"
              onChange={(e) => patch(i, { label: e.target.value })}
            />
            <select
              className="field mono"
              style={{ width: 170 }}
              value={c.model}
              aria-label="Model"
              onChange={(e) => patch(i, { model: e.target.value })}
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <select
              className="field mono"
              style={{ width: 96 }}
              value={c.effort}
              aria-label="Effort"
              onChange={(e) => patch(i, { effort: e.target.value as EffortLevel })}
            >
              {EFFORT_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <select
              className="field"
              style={{ width: 150 }}
              value={reviewChoiceOf(c.review)}
              aria-label="Adversarial review"
              onChange={(e) => patch(i, { review: reviewValueOf(e.target.value as ReviewChoice) })}
            >
              <option value="default">review: config</option>
              <option value="on">review: on</option>
              <option value="off">review: off</option>
            </select>
            <span className="preset-swatches" role="radiogroup" aria-label="Colour">
              {Array.from({ length: GROUP_COLOR_COUNT }, (_, k) => k + 1).map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={c.color === n}
                  aria-label={`colour ${n}`}
                  className={`preset-swatch preset-color-${n}${c.color === n ? ' on' : ''}`}
                  onClick={() => patch(i, { color: n })}
                />
              ))}
            </span>
            <span className="preset-edit-hint" title={presetTitle(shown)}>
              {shown.hint}
            </span>
            <button
              type="button"
              className="btn ghost"
              title="Delete preset"
              aria-label={`Delete preset ${c.label}`}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <IconTrash />
            </button>
          </div>
        );
      })}
      {problem && <div className="warn-text">{problem}</div>}
      <div className="preset-edit-add">
        <button type="button" className="btn" onClick={add} disabled={value.length >= CUSTOM_PRESET_MAX}>
          Add preset
        </button>
        <span className="hint">
          {value.length}/{CUSTOM_PRESET_MAX} — saved with the page. A preset is never stored on a task: the board chip is
          matched from the task's values, so editing or deleting a preset re-labels those tasks
        </span>
      </div>
    </>
  );
}
