import { useIsMobile } from './Layout.tsx';
import { BOARD_VERSIONS, BOARD_VERSIONS_SWITCHABLE, setBoardVersion, useBoardVersion, type BoardVersion } from '../boardVersions.ts';

function VersionSelect({ className }: { className?: string }) {
  const current = useBoardVersion();
  return (
    <select
      className={`field${className ? ` ${className}` : ''}`}
      aria-label="Board version"
      title="Board version, on this device only"
      value={current.id}
      onChange={(e) => setBoardVersion(e.target.value as BoardVersion['id'])}
    >
      {BOARD_VERSIONS.map((v) => (
        <option key={v.id} value={v.id}>
          {`version: ${v.label}`}
        </option>
      ))}
    </select>
  );
}

/**
 * The desktop Versions control (docs/board-versions.md § Versions control): a
 * compact menu in the board head — the original Board's `headSlot`, and each
 * version's own head. Nothing while `original` is the only version, and
 * nothing on a phone, which switches in Settings (BoardVersionsSetting).
 */
export function BoardVersionsControl() {
  const mobile = useIsMobile();
  if (!BOARD_VERSIONS_SWITCHABLE || mobile) return null;
  return <VersionSelect className="board-version-select" />;
}

/** The phone's Versions control: a Settings row beside Appearance, per device like it. */
export function BoardVersionsSetting() {
  const current = useBoardVersion();
  if (!BOARD_VERSIONS_SWITCHABLE) return null;
  return (
    <div className="cfg-row">
      <div>
        <div>Board version</div>
        <div className="hint">{current.id === 'original' ? 'the original board, on this device only' : `${current.label}, on this device only`}</div>
      </div>
      <VersionSelect />
    </div>
  );
}
