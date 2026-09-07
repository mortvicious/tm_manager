import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import type { ReviewFinding, ReviewRound, Task } from '@tm/shared';

/**
 * The adversarial-review section of the task panel (docs/design.md
 * § Adversarial review): where the review stands, the reviewer's overall
 * reading of the work, and every round the task received as collapsible
 * entries — the latest open, the rest one line each until chosen.
 */

const SEVERITY_ORDER: ReviewFinding['severity'][] = ['blocker', 'major', 'minor'];

function actionableOf(r: ReviewRound): number {
  return r.findings.filter((f) => f.severity !== 'minor').length;
}

function verdictLabel(r: ReviewRound): { text: string; cls: string } {
  if (r.error) return { text: 'could not run', cls: 'v-error' };
  if (r.verdict === 'clean') return { text: '✓ clean', cls: 'v-clean' };
  if (r.verdict === 'blocker') return { text: '⛔ blocker', cls: 'v-blocker' };
  return { text: '⚠ concerns', cls: 'v-concerns' };
}

/** The headline the section opens with — one line, from the persisted state. */
export function reviewHeadline(task: Task): { text: string; cls: string } | null {
  const last = task.reviewRounds[task.reviewRounds.length - 1];
  switch (task.reviewState) {
    case 'pending':
      return { text: 'Auto-review queued…', cls: 'v-pending' };
    case 'reviewing':
      return { text: 'Auto-review in progress…', cls: 'v-pending' };
    case 'fixing':
      return {
        text: `Fixing review findings (round ${task.reviewRounds.length})…`,
        cls: 'v-pending',
      };
    case 'passed': {
      if (!last) return null;
      const minors = last.findings.length;
      const rounds = task.reviewRounds.length > 1 ? ` · ${task.reviewRounds.length} rounds` : '';
      return {
        text: `Reviewed by ${last.model}${last.effort ? ` (${last.effort})` : ''}${minors ? ` · ${minors} minor` : ''}${rounds}`,
        cls: 'v-clean',
      };
    }
    case 'flagged':
      return last
        ? { text: `Review flagged ${actionableOf(last)} issue(s) · ${last.model}`, cls: last.verdict === 'blocker' ? 'v-blocker' : 'v-concerns' }
        : null;
    case 'error':
      return { text: 'Review could not run', cls: 'v-error' };
    case 'skipped':
      return { text: 'Nothing to review (clean tree)', cls: 'v-muted' };
    default:
      return null;
  }
}

function Findings({ findings }: { findings: ReviewFinding[] }) {
  if (findings.length === 0) return <div className="muted">No issues found.</div>;
  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  return (
    <ul className="review-findings">
      {sorted.map((f, i) => (
        <li key={i} className={`sev-${f.severity}`}>
          <span className="chip sev">{f.severity}</span>
          <span className="finding-text">
            {f.summary}
            {f.detail && <span className="muted"> — {f.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RoundEntry({ r, open, onToggle }: { r: ReviewRound; open: boolean; onToggle: () => void }) {
  const v = verdictLabel(r);
  const when = new Date(r.at);
  return (
    <div className={`collapsible ${open ? 'open' : ''}`}>
      <button className="collapsible-head" onClick={onToggle} aria-expanded={open}>
        <span className={`caret ${open ? '' : 'closed'}`}>▾</span>
        <span className="mono">round {r.round}</span>
        {r.fixRound > 0 && (
          <span className="chip" title="the diff this round judged came out of a fix round">
            fix {r.fixRound}
          </span>
        )}
        <span className={`chip verdict ${v.cls}`}>{v.text}</span>
        <span className="collapsible-teaser">
          {r.findings.length} finding{r.findings.length === 1 ? '' : 's'}
          {actionableOf(r) > 0 && ` · ${actionableOf(r)} actionable`}
        </span>
        <span className="mono muted" title={when.toLocaleString()}>
          {r.model}
          {r.effort ? ` ${r.effort}` : ''}
        </span>
      </button>
      {open && (
        <div className="collapsible-body">
          {r.error && <div className="warn-text">{r.error}</div>}
          {r.summary && <div className="review-summary">{r.summary}</div>}
          <Findings findings={r.findings} />
          <div className="mono muted" style={{ marginTop: 'var(--tm-space-2)' }}>
            {when.toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
}

export function ReviewPanel({ task }: { task: Task }) {
  const rounds = task.reviewRounds;
  const latest = rounds[rounds.length - 1] ?? null;
  const headline = reviewHeadline(task);
  // the latest round starts open; any other can be chosen, one at a time
  const [openRound, setOpenRound] = useState<number | null>(latest?.round ?? null);
  const [legacyRaw, setLegacyRaw] = useState(false);
  useEffect(() => setOpenRound(latest?.round ?? null), [task.id, latest?.round]);

  // A task reviewed before rounds were persisted has only the markdown blob.
  const legacyHtml = useMemo(
    () => (rounds.length === 0 && task.reviewSummary && !legacyRaw ? (marked.parse(task.reviewSummary, { async: false }) as string) : ''),
    [rounds.length, task.reviewSummary, legacyRaw],
  );

  if (!headline && rounds.length === 0 && !task.reviewSummary) return null;

  return (
    <div className="panel review-panel" style={{ padding: 12 }}>
      <div className="review-head">
        <div className="label" style={{ margin: 0 }}>
          Adversarial review
        </div>
        <span style={{ flex: 1 }} />
        {headline && <span className={`chip verdict ${headline.cls}`}>{headline.text}</span>}
      </div>
      {latest?.summary && (task.reviewState === 'passed' || task.reviewState === 'flagged' || task.reviewState === 'fixing') && (
        <div className="review-summary lead">{latest.summary}</div>
      )}
      {rounds.length > 0 && (
        <div className="review-rounds">
          {[...rounds].reverse().map((r) => (
            <RoundEntry
              key={r.round}
              r={r}
              open={openRound === r.round}
              onToggle={() => setOpenRound((cur) => (cur === r.round ? null : r.round))}
            />
          ))}
        </div>
      )}
      {rounds.length === 0 && task.reviewSummary && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn ghost" style={{ padding: '1px 9px', fontSize: 'var(--tm-text-xs)' }} onClick={() => setLegacyRaw((r) => !r)}>
              {legacyRaw ? 'Rendered' : 'Raw'}
            </button>
          </div>
          {legacyRaw ? (
            <pre className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
              {task.reviewSummary}
            </pre>
          ) : (
            <div className="handbook" dangerouslySetInnerHTML={{ __html: legacyHtml }} />
          )}
        </div>
      )}
    </div>
  );
}
