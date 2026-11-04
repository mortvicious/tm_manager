import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { isJobDue, roughDuration, type Job } from '@tm/shared';
import { useApp } from '../state.tsx';
import { useWorkspace } from '../workspace.ts';
import { useNow } from './TimeAgo.tsx';
import { IconJobs } from './Icons.tsx';

/**
 * Scheduled jobs on the board (docs/jobs.md § On the board): the live ones
 * as tiny task-like rows above whichever board version is showing — running
 * first, then due, then the next few scheduled, plus any whose last run wants
 * a look. Rendered by BoardRoute, so the frozen original Board is untouched;
 * nothing at all when no job is worth a row.
 */
const SHOWN = 6;
const HORIZON_MS = 7 * 86_400_000;

export function BoardJobs() {
  const { jobs, jobRuns } = useApp();
  const { repoIds, wsHref } = useWorkspace();
  const navigate = useNavigate();
  const now = useNow();
  const flagged = useMemo(() => new Set(jobRuns.map((r) => r.jobId)), [jobRuns]);

  const rows = useMemo(() => {
    const rank = (j: Job) => (j.status === 'running' ? 0 : flagged.has(j.id) ? 1 : isJobDue(j, now) ? 2 : 3);
    return jobs
      .filter((j) => !repoIds || repoIds.has(j.repoId))
      .filter(
        (j) =>
          j.status === 'running' ||
          flagged.has(j.id) ||
          (j.status === 'scheduled' && !!j.nextRunAt && Date.parse(j.nextRunAt) - now < HORIZON_MS),
      )
      .sort((a, b) => rank(a) - rank(b) || (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''))
      .slice(0, SHOWN);
  }, [jobs, repoIds, flagged, now]);

  if (!rows.length) return null;
  return (
    <div className="board-jobs" aria-label="Scheduled jobs">
      {rows.map((j) => {
        const due = isJobDue(j, now);
        const state = j.status === 'running' ? 'running' : flagged.has(j.id) ? 'attention' : due ? 'due' : '';
        const when =
          j.status === 'running'
            ? 'running'
            : flagged.has(j.id)
              ? (j.lastVerdict ?? 'look')
              : due
                ? 'due'
                : j.nextRunAt
                  ? `in ${roughDuration(Date.parse(j.nextRunAt) - now)}`
                  : j.status;
        return (
          <button
            key={j.id}
            className={`board-job ${state}`}
            title={`Scheduled job: ${j.title}`}
            onClick={() => navigate(wsHref(`/jobs?job=${j.id}`))}
          >
            <IconJobs />
            <span className="board-job-title">{j.title}</span>
            <span className="board-job-when">{when}</span>
          </button>
        );
      })}
    </div>
  );
}
