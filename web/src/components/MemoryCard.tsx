// The Dashboard's Memory card (docs/memory.md § Memory per run): the
// machine's free % and swap, and every live process tree the task manager
// owns — worker and aux runs, repo commands, terminals, the API — from the
// 30 s sample in `OrchestratorStatus.procMemory`. Workspace-scoped like the
// rest of the Dashboard: a tree with no repo (the API, a chat) always shows.

import { formatMb, pressureName, type MemTree } from '@tm/shared';
import { useApp } from '../state.tsx';
import { useWorkspace } from '../workspace.ts';

const KIND_LABEL: Record<MemTree['kind'], string> = {
  worker: 'agent',
  aux: 'aux',
  command: 'cmd',
  shell: 'shell',
  server: 'server',
};

function kindText(t: MemTree): string {
  if (t.kind === 'aux' && t.sub) return t.sub;
  if (t.kind === 'command' && t.sub === 'check') return 'check';
  return KIND_LABEL[t.kind];
}

export function MemoryCard({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const { orch } = useApp();
  const { inScopeRepo } = useWorkspace();
  const pm = orch.procMemory;
  if (!pm) return null;
  const sys = pm.system;
  const trees = pm.trees.filter((t) => inScopeRepo(t.repoId));
  const scale = Math.max(pm.physMb, ...trees.map((t) => t.mb), 1);
  const level = pressureName(sys?.pressureLevel);
  const ago = pm.at ? Math.max(0, Math.round((Date.now() - Date.parse(pm.at)) / 1000)) : null;
  return (
    <div className="chart-card mem-card">
      <h3>Memory</h3>
      <div className="chart-sub">
        {pm.at
          ? `${pm.method === 'footprint' ? 'physical footprint' : 'resident size'} of each process tree · sampled every 30 s${ago !== null && ago > 45 ? ` · ${ago}s ago` : ''}`
          : 'waiting for the first sample'}
        {pm.error && <span className="warn-text"> · {pm.error}</span>}
      </div>
      <div className="mem-system">
        <span className="mem-fig">
          <span className="mem-fig-value">{sys ? `${Math.round(sys.freePct)}%` : '—'}</span>
          <span className="mem-fig-label">free</span>
        </span>
        <span className="mem-fig">
          <span className="mem-fig-value">{sys && sys.swapTotalMb > 0 ? formatMb(sys.swapUsedMb) : '—'}</span>
          <span className="mem-fig-label">{sys && sys.swapTotalMb > 0 ? `swap of ${formatMb(sys.swapTotalMb)}` : 'swap'}</span>
        </span>
        {level && (
          <span className="mem-fig">
            <span className={`mem-fig-value${sys!.pressureLevel! >= 4 ? ' sev-critical' : sys!.pressureLevel! >= 2 ? ' sev-warn' : ''}`}>{level}</span>
            <span className="mem-fig-label">pressure</span>
          </span>
        )}
        <span className="mem-fig">
          <span className="mem-fig-value">{formatMb(pm.totalMb)}</span>
          <span className="mem-fig-label">task manager{pm.physMb > 0 ? ` of ${formatMb(pm.physMb)}` : ''}</span>
        </span>
      </div>
      {pm.memoryHigh.high && (
        <div className="anomaly-row mem-high" style={{ cursor: 'default' }}>
          <span className={`sev sev-${pm.memoryHigh.severity}`}>high</span>
          <span style={{ minWidth: 0 }}>{pm.memoryHigh.reason}</span>
        </div>
      )}
      {trees.map((t) => (
        <div
          key={t.id}
          className="mem-row"
          onClick={() => t.taskId && onOpenTask(t.taskId)}
          style={{ cursor: t.taskId ? 'pointer' : 'default' }}
          title={t.taskId ? 'open the task' : undefined}
        >
          <span className="mem-kind">{kindText(t)}</span>
          <span className="mem-main">
            <span className="mem-label">{t.label}</span>
            <span className="mem-detail">
              peak {formatMb(t.peakMb)} · {t.procs} {t.procs === 1 ? 'process' : 'processes'}
              {t.biggest && t.procs > 1 && ` · biggest ${t.biggest.comm || t.biggest.pid} ${formatMb(t.biggest.mb)}`}
            </span>
            <span className="mem-bar">
              <span className="mem-bar-fill" style={{ width: `${Math.min(100, (t.mb / scale) * 100)}%` }} />
            </span>
          </span>
          <span className="mem-value">{formatMb(t.mb)}</span>
        </div>
      ))}
      {pm.at && trees.length === 0 && <div className="muted">no live process trees in this workspace</div>}
    </div>
  );
}
