import { EFFORT_LEVELS, MODEL_OPTIONS, type AppSettings } from '@tm/shared';

/**
 * Whether the adversarial review will run for a task: the per-task override,
 * else the global `review.enabled` (on until the settings have loaded).
 */
export const reviewIsOn = (review: boolean | null, settings: AppSettings | null): boolean =>
  review ?? settings?.['review.enabled'] ?? true;

/** The global reviewer a null `reviewModel` resolves to. */
export const globalReviewModel = (settings: AppSettings | null): string | null => settings?.['review.model'] ?? null;

/**
 * The "differs from the global default" marker — only for an explicit choice
 * that is not already the global model (picking the default model explicitly
 * still pins it, but reads the same today, so it is not flagged).
 */
export function ReviewerChip({ reviewModel, settings }: { reviewModel: string | null; settings: AppSettings | null }) {
  const global = globalReviewModel(settings);
  if (!reviewModel || reviewModel === global) return null;
  return (
    <span
      className="chip"
      style={{ color: 'var(--tm-accent)' }}
      title={`reviewed by ${reviewModel}${global ? ` instead of the default ${global}` : ''}`}
    >
      reviewer {reviewModel}
    </span>
  );
}

/**
 * The task's reviewer model + effort dropdowns — two grid cells, rendered by
 * both the new-task form and the task panel. "" means null: the global
 * `review.model` / the reviewer's default effort. Every option list is the one
 * `MODEL_OPTIONS` array; a stored value outside it is kept visible, not lost.
 */
export function ReviewerFields({
  model,
  effort,
  onModel,
  onEffort,
  settings,
}: {
  model: string;
  effort: string;
  onModel: (m: string) => void;
  onEffort: (e: string) => void;
  settings: AppSettings | null;
}) {
  const global = globalReviewModel(settings);
  return (
    <>
      <div>
        <label className="label">
          Reviewer model <ReviewerChip reviewModel={model || null} settings={settings} />
        </label>
        <select className="field mono" value={model} onChange={(e) => onModel(e.target.value)}>
          <option value="">default ({global ?? 'config'})</option>
          {(model && !MODEL_OPTIONS.includes(model) ? [model, ...MODEL_OPTIONS] : MODEL_OPTIONS).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label">Reviewer effort</label>
        <select className="field mono" value={effort} onChange={(e) => onEffort(e.target.value)}>
          <option value="">default</option>
          {EFFORT_LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
