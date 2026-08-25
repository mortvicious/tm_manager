import type { FeatureStatus } from '@tm/shared';

const LABEL: Record<FeatureStatus, string> = {
  draft: 'draft',
  analyzing: 'analyzing…',
  proposed: 'plan proposed',
  approved: 'approved',
  running: 'running',
  paused: 'paused',
  review: 'review',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** Feature lifecycle chip — the Feature twin of StatusBadge. */
export function FeatureBadge({ status }: { status: FeatureStatus }) {
  return (
    <span className={`fbadge f-${status}`} title={`feature status: ${status}`}>
      <span className="dot" />
      {LABEL[status] ?? status}
    </span>
  );
}
