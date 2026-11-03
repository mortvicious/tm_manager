import { effectiveLanding, publishCaution, publishGateReason, type InboxItem } from '@tm/shared';
import { useApp } from '../state.tsx';
import { ChecksPanel } from './ChecksPanel.tsx';
import { Block, lastDiffStat, statText } from './Inbox.tsx';
import { LANDING_HINT } from './LandingPicker.tsx';
import { ReviewPanel, verdictChip } from './ReviewPanel.tsx';
import { TaskDiff } from './TaskDiff.tsx';

export type ReviewItem = Extract<InboxItem, { kind: 'review' }>;

/**
 * One card of the Review deck (docs/inbox.md § Review deck): everything the
 * ship-or-not decision needs on one surface — why it is (or is not) ready,
 * the verify gate, the reviewer's summary and findings, the checks, how it
 * lands, the PR of a worktree task and, for the CURRENT card only, the diff.
 */
export function ReviewDeckCard({
  item,
  onOpenTerminal,
  diff,
}: {
  item: ReviewItem;
  onOpenTerminal: (runId: string) => void;
  /** mount the diff (one fetch per card — only the card under the cursor) */
  diff: boolean;
}) {
  const { repos } = useApp();
  const t = item.task;
  const repo = repos.find((r) => r.id === t.repoId);
  const caution = publishCaution(t);
  const gate = publishGateReason(t);
  const landing = effectiveLanding(t, repo);
  const stat = lastDiffStat(t);
  const verdict = verdictChip(t);
  const last = t.reviewRounds[t.reviewRounds.length - 1] ?? null;
  return (
    <>
      <div className="deck-card-head">
        <h2 className="deck-card-title">{t.title}</h2>
        <span className="deck-card-id mono">{t.id.slice(0, 8)}</span>
        {repo && <span className="inbox-repo">{repo.name}</span>}
      </div>
      <div className="inbox-facts">
        {item.ready ? (
          <span className="chip verdict v-clean">✓ {item.ready}</span>
        ) : (
          caution && <span className="chip verdict v-concerns">⚠ {caution}</span>
        )}
        {gate && <span className="chip verdict v-pending">{gate}</span>}
        <span className="chip" title={LANDING_HINT[landing]}>
          lands {landing}
        </span>
        {t.branch && (
          <span className="chip mono" title="this task's worktree branch (docs/parallel.md)">
            {t.branch}
          </span>
        )}
        {t.prUrl && (
          <a className="chip" href={t.prUrl} target="_blank" rel="noreferrer" title="the task's pull request">
            PR{t.prNumber ? ` #${t.prNumber}` : ''}
            {t.prState ? ` · ${t.prState}` : ''}
          </a>
        )}
        {stat && (
          <span className="chip mono" title="files touched, lines added and removed — the diff the reviewer read">
            {statText(stat)}
          </span>
        )}
      </div>
      {verdict && <div className="deck-card-what">{verdict.what}</div>}
      <ReviewPanel task={t} />
      {!last?.summary && t.resultSummary && <Block label="Agent">{t.resultSummary}</Block>}
      <ChecksPanel task={t} onOpenTerminal={onOpenTerminal} />
      {diff && <TaskDiff task={t} repo={repo} />}
    </>
  );
}
