import { TASK_PRESETS, matchTaskPreset, type EffortLevel, type TaskPreset } from '@tm/shared';

/** The review dropdown's three states, as the forms hold them. */
export type ReviewChoice = 'default' | 'on' | 'off';

export const reviewChoiceOf = (review: boolean | null): ReviewChoice =>
  review == null ? 'default' : review ? 'on' : 'off';

export const reviewValueOf = (choice: ReviewChoice): boolean | null =>
  choice === 'default' ? null : choice === 'on';

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
          className={`btn preset-btn${active?.id === p.id ? ' on' : ''}`}
          aria-pressed={active?.id === p.id}
          title={`${p.model} · ${p.effort} effort · ${
            p.review == null ? 'review per config' : p.review ? 'adversarial review' : 'no adversarial review'
          }`}
          onClick={() => onApply(p)}
        >
          {p.label}
          <span className="preset-hint">{p.hint}</span>
        </button>
      ))}
    </div>
  );
}
