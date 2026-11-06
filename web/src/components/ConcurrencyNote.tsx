// The concurrency-vs-RAM note (docs/memory.md § Concurrency from RAM): what
// this Mac's RAM suggests for `orchestrator.concurrency`, and a warning when
// the value on the page — or chats and jobs stacked on top of it — goes above
// that. Reads the form's UNSAVED values, so it answers before Save. Used by
// the original Config page and the settings registry alike.
import { concurrencyAdvice, type AppSettings, type MachineInfo } from '@tm/shared';

export function ConcurrencyNote({
  cfg,
  machine,
  only,
}: {
  cfg: AppSettings;
  /** `OrchestratorStatus.machine`; absent on a server predating it → nothing */
  machine: MachineInfo | undefined;
  /** 'stack' = the chats/jobs row: only the stacked-sessions warning, no suggestion line */
  only?: 'stack';
}) {
  if (!machine) return null;
  const a = concurrencyAdvice(cfg, machine.totalMemBytes);
  const warnings = only === 'stack' ? (a.stacked ? [a.warnings[a.warnings.length - 1]] : []) : a.warnings;
  return (
    <>
      {!only && <div className="hint">{`suggested for this Mac (${a.totalGb} GB RAM): ${a.suggested}`}</div>}
      {warnings.map((w) => (
        <div key={w} className="warn-text" role="note">
          {w}
        </div>
      ))}
    </>
  );
}
