import { LANDING_TIERS, type LandingTier, type Repo } from '@tm/shared';

/** One line per tier — the same words on the repo row and the task forms (docs/design.md § Landing tiers). */
export const LANDING_LABEL: Record<LandingTier, string> = {
  supervised: 'supervised — stop at review',
  'on-green': 'on-green — done when checks green + review clean',
  'auto-publish': 'auto-publish — push when checks green + review clean',
};

export const LANDING_HINT: Record<LandingTier, string> = {
  supervised: 'The agent stops at review; you mark it done or press Publish.',
  'on-green':
    'After the checks and the review round, a green, clean change moves to done on its own (local commits — you publish). Anything else stays in review.',
  'auto-publish':
    'The same gate, then the agent commits and pushes in its own terminal and the task lands in published. Red checks or a flagged review stay in review.',
};

/**
 * A task's landing tier override: "repo default" (null) or one of the tiers.
 * An external task (Sentry, proposals, agent filings — `isExternalTask`)
 * never lands above supervised, so the picker is shown locked.
 */
export function LandingPicker({
  value,
  onChange,
  repo,
  external,
}: {
  value: LandingTier | null;
  onChange: (v: LandingTier | null) => void;
  repo: Repo | undefined;
  external: boolean;
}) {
  const inherited: LandingTier = repo?.landing ?? 'supervised';
  const effective: LandingTier = external ? 'supervised' : (value ?? inherited);
  return (
    <div className="wide">
      <label className="label">Landing</label>
      {external ? (
        <select className="field" value="supervised" disabled>
          <option value="supervised">supervised — external task</option>
        </select>
      ) : (
        <select
          className="field"
          value={value ?? ''}
          onChange={(e) => onChange((e.target.value || null) as LandingTier | null)}
        >
          <option value="">repo default ({repo ? inherited : 'supervised'})</option>
          {LANDING_TIERS.map((t) => (
            <option key={t} value={t}>
              {LANDING_LABEL[t]}
            </option>
          ))}
        </select>
      )}
      <div className="hint">
        {external
          ? 'This task’s text came from outside your own words (an import, a proposal, an agent’s filing), so it always stops at review.'
          : LANDING_HINT[effective]}
      </div>
    </div>
  );
}
