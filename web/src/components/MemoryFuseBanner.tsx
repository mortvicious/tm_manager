import { useApp } from '../state.tsx';

/**
 * The memory fuse's line (docs/memory.md): while the machine is low on
 * memory nothing new AUTOMATIC starts — claims, wake-ups, verify rounds,
 * planning, jobs, office shifts. Live turns finish and your own clicks still
 * work, which the line says so a quiet queue does not read as a stuck one.
 * Nothing while the fuse is off or clear.
 */
export function MemoryFuseBanner() {
  const { orch } = useApp();
  const m = orch.memory;
  if (!m?.hold) return null;
  const s = m.sample;
  return (
    <div className="push-health">
      <div className="push-health-row memory-fuse" role="status">
        <strong>Memory fuse: new automatic work is on hold</strong>
        <span>
          {' '}
          — {m.reason ?? 'memory pressure'}
          {m.since ? `, since ${time(m.since)}` : ''}. Running turns finish; your own clicks still work. It clears once
          memory stays 5 points inside the limits for about 45 s.
        </span>
        {s && (
          <code className="push-health-error">
            {Math.round(s.freePct)}% free · swap {(s.swapUsedMb / 1024).toFixed(1)} of {(s.swapTotalMb / 1024).toFixed(1)} GB
          </code>
        )}
      </div>
    </div>
  );
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
