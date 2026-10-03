import { setDesign, setSchemePref, useLook, type Design, type SchemePref } from '../appearance.ts';

const DESIGNS: { id: Design; label: string }[] = [
  { id: 'glass', label: 'Glass' },
  { id: 'classic', label: 'Classic' },
];

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
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    // a toggle-button group, like the Board's View switch: plain buttons need no roving focus
    <span className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
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
          <div className="hint">
            {look.design === 'glass'
              ? 'iOS Liquid Glass, on this device only. Features and Chat are left out of the menus.'
              : 'The original terminal look, on this device only.'}
          </div>
        </div>
        <Segmented label="Design" value={look.design} options={DESIGNS} onChange={setDesign} />
      </div>
      <div className="cfg-row">
        <div>
          <div>Light or dark</div>
          <div className="hint">
            {look.pref === 'system' ? `follows this device (now ${look.scheme})` : `pinned to ${look.pref} on this device`}
          </div>
        </div>
        <Segmented label="Light or dark" value={look.pref} options={SCHEMES} onChange={setSchemePref} />
      </div>
    </div>
  );
}
