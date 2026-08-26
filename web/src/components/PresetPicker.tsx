import { TASK_PRESETS, matchTaskPreset, type EffortLevel, type TaskPreset } from '@tm/shared';

/** The review dropdown's three states, as the forms hold them. */
export type ReviewChoice = 'default' | 'on' | 'off';

export const reviewChoiceOf = (review: boolean | null): ReviewChoice =>
  review == null ? 'default' : review ? 'on' : 'off';

export const reviewValueOf = (choice: ReviewChoice): boolean | null =>
  choice === 'default' ? null : choice === 'on';

/**
 * The hue a preset is drawn with, everywhere it appears. Class only — the
 * colour itself is `--tm-preset-*` in the token sheet, and `preset-<id>` just
 * points `--tm-preset` at the right one, so the picker button and the board
 * chip can never disagree about what "Complex" looks like.
 */
export const presetClass = (p: TaskPreset) => `preset-${p.id}`;

/** All three values spelled out — the glanceable hint's complete half. */
export const presetTitle = (p: TaskPreset) =>
  `${p.model} · ${p.effort} effort · ${
    p.review == null ? 'review per config' : p.review ? 'adversarial review' : 'no adversarial review'
  }`;

/**
 * One-click model / effort / adversarial-review bundles (`TASK_PRESETS`).
 * Purely a shortcut for the three dropdowns below it — the dropdowns stay
 * editable, and touching one just drops the row back to "custom".
 */
export function PresetPicker({
  model,
  effort,
  review,
  onApply,
}: {
  /** '' = no override (the dropdowns' "default" option) */
  model: string;
  effort: string;
  review: ReviewChoice;
  onApply: (p: TaskPreset) => void;
}) {
  const active = matchTaskPreset({
    model: model || null,
    effort: (effort || null) as EffortLevel | null,
    review: reviewValueOf(review),
  });
  return (
    <div className="preset-row">
      {TASK_PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`btn preset-btn ${presetClass(p)}${active?.id === p.id ? ' on' : ''}`}
          aria-pressed={active?.id === p.id}
          title={presetTitle(p)}
          onClick={() => onApply(p)}
        >
          {p.label}
          <span className="preset-hint">{p.hint}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The board's read-only twin of the picker: the preset a task's three
 * overrides add up to, in that preset's colour. Renders nothing when the
 * values match no preset ("custom", and for most tasks "no overrides at all")
 * — a chip on every row would say nothing.
 */
export function PresetChip({
  model,
  effort,
  review,
}: {
  model: string | null;
  effort: EffortLevel | null;
  review: boolean | null;
}) {
  const p = matchTaskPreset({ model, effort, review });
  if (!p) return null;
  return (
    <span className={`chip preset-chip ${presetClass(p)}`} title={`preset · ${p.label} — ${presetTitle(p)}`}>
      <span className="preset-dot" aria-hidden="true" />
      {p.label}
    </span>
  );
}
