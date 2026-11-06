import type { Approval, Feature, Job, JobRun, OfficeProposal, OfficeRole, Proposal, Question, Repo, Run, Task } from '@tm/shared';
import type { Storage } from './storage/types.ts';

/**
 * Every row `buildInbox` (shared, docs/inbox.md) reads, loaded from storage in
 * one place. Telegram's board (`telegram/board.ts`) and TM Bar's summary route
 * (`routes/menubar.ts`, docs/menubar.md) both read the Inbox through this, so a
 * new inbox kind's source is added once and neither surface miscounts.
 */
export interface InboxSources {
  tasks: Task[];
  repos: Repo[];
  /** every `running` run (worker and aux) */
  live: Run[];
  questions: Question[];
  approvals: Approval[];
  proposals: Proposal[];
  features: Feature[];
  jobs: Job[];
  jobRuns: JobRun[];
  officeProposals: OfficeProposal[];
  officeRoles: OfficeRole[];
  /** `inbox.staleDraftDays` */
  staleDraftDays: number;
}

export async function loadInboxSources(storage: Storage): Promise<InboxSources> {
  const [tasks, repos, live, questions, approvals, proposals, features, settings] = await Promise.all([
    storage.listTasks(),
    storage.listRepos(),
    storage.listRuns({ status: 'running' }),
    storage.listQuestions({ status: 'pending' }),
    storage.listApprovals({ status: 'pending' }),
    storage.listProposals({ status: 'pending' }),
    storage.listFeatures({ status: 'proposed' }),
    storage.getSettings(),
  ]);
  const [jobs, jobRuns, officeProposals, officeRoles] = await Promise.all([
    storage.listJobs(),
    storage.listOpenJobRuns(),
    storage.listOfficeProposals({ status: 'pending' }),
    storage.listOfficeRoles(),
  ]);
  return {
    tasks,
    repos,
    live,
    questions,
    approvals,
    proposals,
    features,
    jobs,
    jobRuns,
    officeProposals,
    officeRoles,
    staleDraftDays: settings['inbox.staleDraftDays'],
  };
}
