import { BoardVersionsSetting } from './BoardVersions.tsx';
import { DESIGN_LABELS, setDesign, setSchemePref, useLook, type Design, type SchemePref } from '../appearance.ts';

const DESIGNS: { id: Design; label: string }[] = (['glass', 'classic', 'magma'] as const).map((id) => ({
  id,
  label: DESIGN_LABELS[id],
}));

const DESIGN_HINTS: Record<Design, string> = {
  glass: 'iOS Liquid Glass, on this device only. Features and Chat are left out of the menus.',
  classic: 'The original terminal look, on this device only.',
  magma: 'Glow on black, with game-like panels, on this device only. Always dark.',
};

const SCHEMES: { id: SchemePref; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    // a toggle-button group, like the Board's View switch: plain buttons need no roving focus
    <span className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          disabled={disabled}
          className={`btn ${value === o.id ? 'primary' : ''}`}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

/**
 * Settings → Appearance (docs/glass.md). Per DEVICE, like Notifications, and
 * applied as it is clicked. It is not part of the page's Save, which writes
 * tm_config for every browser at once.
 */
export function AppearanceSettings() {
  const look = useLook();
  return (
    <div className="panel cfg-group">
      <h3>Appearance</h3>
      <div className="cfg-row">
        <div>
          <div>Design</div>
          <div className="hint">{DESIGN_HINTS[look.design]}</div>
        </div>
        <Segmented label="Design" value={look.design} options={DESIGNS} onChange={setDesign} />
      </div>
      <div className="cfg-row">
        <div>
          <div>Light or dark</div>
          <div className="hint">
            {look.design === 'magma'
              ? 'Magma is dark-only. This choice applies to Glass and Classic.'
              : look.pref === 'system'
                ? `follows this device (now ${look.scheme})`
                : `pinned to ${look.pref} on this device`}
          </div>
        </div>
        {/* Magma is dark-only (docs/magma.md § 2): shown, disabled, and the stored pick kept for the other designs */}
        <Segmented
          label="Light or dark"
          value={look.pref}
          options={SCHEMES}
          onChange={setSchemePref}
          disabled={look.design === 'magma'}
        />
      </div>
      {/* the phone's Versions control (docs/board-versions.md); nothing while the original is the only one */}
      <BoardVersionsSetting />
    </div>
  );
}
