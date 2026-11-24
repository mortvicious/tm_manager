import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boardCounts,
  cachedBoardCounts,
  cachedJobsCounts,
  cachedOfficeProposalsCount,
  cachedQueueCount,
  featuresCount,
  formatCount,
  inboxCounts,
  jobsCounts,
  navCountLabel,
  navCoverage,
  officeProposalsCount,
  queueCount,
  terminalsCount,
} from './navCounts.ts';

const A = new Set(['repo-a']);
const B = new Set(['repo-b']);
const NOTHING = new Set<string>();

const task = (status: string, repoId = 'repo-a', hiddenAt: string | null = null) =>
  ({ status, repoId, hiddenAt }) as { status: never; repoId: string; hiddenAt: string | null };

test('board: running and waiting are live, drafts counted apart, hidden rows left out', () => {
  const tasks = [
    task('running'),
    task('waiting'),
    task('draft'),
    task('draft'),
    task('draft', 'repo-a', '2026-11-01T00:00:00Z'),
    task('running', 'repo-a', '2026-11-01T00:00:00Z'),
    task('queued'),
    task('review'),
    task('blocked'),
    task('done'),
  ];
  assert.deepEqual(boardCounts(tasks, null), { live: 2, drafts: 2 });
});

test('board: workspace scope, and zero', () => {
  const tasks = [task('running', 'repo-a'), task('draft', 'repo-b'), task('draft', 'repo-b')];
  assert.deepEqual(boardCounts(tasks, A), { live: 1, drafts: 0 });
  assert.deepEqual(boardCounts(tasks, B), { live: 0, drafts: 2 });
  assert.deepEqual(boardCounts(tasks, NOTHING), { live: 0, drafts: 0 });
  assert.deepEqual(boardCounts([], null), { live: 0, drafts: 0 });
});

test('queue: every queued task in scope, hidden and held ones included', () => {
  const tasks = [
    task('queued'),
    task('queued', 'repo-a', '2026-11-01T00:00:00Z'),
    { status: 'queued', repoId: 'repo-a', hiddenAt: null, customQueueAt: '2026-11-01T00:00:00Z', queueHeldAt: '2026-11-01T00:00:00Z' },
    task('queued', 'repo-b'),
    task('running'),
    task('draft'),
  ] as Parameters<typeof queueCount>[0];
  assert.equal(queueCount(tasks, null), 4);
  assert.equal(queueCount(tasks, A), 3);
  assert.equal(queueCount(tasks, B), 1);
  assert.equal(queueCount(tasks, NOTHING), 0);
  assert.equal(queueCount([], null), 0);
});

test('features: in flight = analyzing, proposed, approved, running, paused, review', () => {
  const statuses = ['draft', 'analyzing', 'proposed', 'approved', 'running', 'paused', 'review', 'done', 'failed', 'cancelled'] as const;
  const features = statuses.map((status) => ({ status, repoId: 'repo-a' }));
  assert.equal(featuresCount(features, null), 6);
  assert.equal(featuresCount(features, A), 6);
  assert.equal(featuresCount(features, B), 0);
  assert.equal(featuresCount([], null), 0);
});

test('jobs: running per scope, needs-you = jobs with an open attention/error run', () => {
  const jobs = [
    { id: 'j1', status: 'running' as const, repoId: 'repo-a' },
    { id: 'j2', status: 'scheduled' as const, repoId: 'repo-a' },
    { id: 'j3', status: 'running' as const, repoId: 'repo-b' },
  ];
  const runs = [
    { jobId: 'j2', verdict: 'attention' as const, acknowledgedAt: null },
    { jobId: 'j2', verdict: 'error' as const, acknowledgedAt: null }, // same job: one
    { jobId: 'j1', verdict: 'attention' as const, acknowledgedAt: '2026-11-01T00:00:00Z' }, // acknowledged
    { jobId: 'j1', verdict: 'ok' as const, acknowledgedAt: null },
    { jobId: 'j3', verdict: 'error' as const, acknowledgedAt: null },
    { jobId: 'gone', verdict: 'error' as const, acknowledgedAt: null }, // its job is not in the list
  ];
  assert.deepEqual(jobsCounts(jobs, runs, null), { running: 2, needsYou: 2 });
  assert.deepEqual(jobsCounts(jobs, runs, A), { running: 1, needsYou: 1 });
  assert.deepEqual(jobsCounts(jobs, runs, B), { running: 1, needsYou: 1 });
  assert.deepEqual(jobsCounts(jobs, runs, NOTHING), { running: 0, needsYou: 0 });
  assert.deepEqual(jobsCounts([], [], null), { running: 0, needsYou: 0 });
});

test('inbox: decisions leave stale drafts out; urgent = question or attention', () => {
  const items = [{ kind: 'question' }, { kind: 'attention' }, { kind: 'review' }, { kind: 'failed' }, { kind: 'stale-draft' }, { kind: 'stale-draft' }] as const;
  assert.deepEqual(inboxCounts(items), { decisions: 4, urgent: 2 });
  assert.deepEqual(inboxCounts([{ kind: 'stale-draft' }]), { decisions: 0, urgent: 0 });
  assert.deepEqual(inboxCounts([]), { decisions: 0, urgent: 0 });
});

test('office proposals: pending only, by repo when named, else by the office workspace', () => {
  const proposals = [
    { status: 'pending' as const, repoId: 'repo-a', workspaceId: 'ws-1' },
    { status: 'pending' as const, repoId: null, workspaceId: 'ws-1' },
    { status: 'pending' as const, repoId: null, workspaceId: 'ws-2' },
    { status: 'accepted' as const, repoId: 'repo-a', workspaceId: 'ws-1' },
    { status: 'rejected' as const, repoId: null, workspaceId: 'ws-1' },
  ];
  assert.equal(officeProposalsCount(proposals, null, null), 3);
  assert.equal(officeProposalsCount(proposals, A, 'ws-1'), 2);
  assert.equal(officeProposalsCount(proposals, B, 'ws-2'), 1);
  assert.equal(officeProposalsCount(proposals, NOTHING, 'ws-3'), 0);
  assert.equal(officeProposalsCount([], null, null), 0);
});

test('terminals: live shells in scope', () => {
  const shells = [
    { status: 'running' as const, repoId: 'repo-a' },
    { status: 'exited' as const, repoId: 'repo-a' },
    { status: 'killed' as const, repoId: 'repo-a' },
    { status: 'running' as const, repoId: 'repo-b' },
  ];
  assert.equal(terminalsCount(shells, null), 2);
  assert.equal(terminalsCount(shells, A), 1);
  assert.equal(terminalsCount(shells, NOTHING), 0);
  assert.equal(terminalsCount([], null), 0);
});

test('formatCount caps at 99+', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(7), '7');
  assert.equal(formatCount(99), '99');
  assert.equal(formatCount(100), '99+');
  assert.equal(formatCount(4321), '99+');
});

test('navCountLabel names only the non-zero parts', () => {
  assert.equal(navCountLabel('Board', [[2, 'running'], [54, 'drafts']]), 'Board, 2 running, 54 drafts');
  assert.equal(navCountLabel('Board', [[0, 'running'], [54, 'drafts']]), 'Board, 54 drafts');
  assert.equal(navCountLabel('Queue', [[0, 'queued']]), 'Queue');
  assert.equal(navCountLabel('Inbox', [[7, 'decisions'], [1, 'urgent']]), 'Inbox, 7 decisions, 1 urgent');
});

test('cached counters: same array + scope → the same result object; a new array or scope recomputes', () => {
  const tasks = [task('running'), task('queued'), task('draft', 'repo-b')];
  const first = cachedBoardCounts(tasks, null);
  assert.equal(cachedBoardCounts(tasks, null), first);
  assert.deepEqual(first, { live: 1, drafts: 1 });
  const scoped = cachedBoardCounts(tasks, A);
  assert.notEqual(scoped, first);
  assert.deepEqual(scoped, { live: 1, drafts: 0 });
  assert.equal(cachedBoardCounts(tasks, A), scoped);
  // the store replaces the array on a change: the new array is counted afresh
  const next = [...tasks, task('waiting')];
  assert.deepEqual(cachedBoardCounts(next, null), { live: 2, drafts: 1 });
  assert.equal(cachedQueueCount(tasks, null), 1);
  assert.equal(cachedQueueCount(tasks, B), 0);

  const jobs = [{ id: 'j1', status: 'running' as const, repoId: 'repo-a' }];
  const runs: { jobId: string; verdict: 'error'; acknowledgedAt: null }[] = [];
  const j = cachedJobsCounts(jobs, runs, null);
  assert.equal(cachedJobsCounts(jobs, runs, null), j);
  assert.deepEqual(cachedJobsCounts(jobs, [{ jobId: 'j1', verdict: 'error', acknowledgedAt: null }], null), { running: 1, needsYou: 1 });

  const props = [{ status: 'pending' as const, repoId: null, workspaceId: 'ws-1' }];
  assert.equal(cachedOfficeProposalsCount(props, null, null), 1);
  assert.equal(cachedOfficeProposalsCount(props, A, 'ws-2'), 0);
  assert.equal(cachedOfficeProposalsCount(props, A, 'ws-1'), 1);
});

test('navCoverage: every NAV path exactly once', () => {
  const nav = ['/board', '/inbox', '/queue'];
  assert.deepEqual(navCoverage(nav, [{ paths: ['/board'] }, { paths: ['/queue', '/inbox'] }]), { missing: [], duplicate: [], unknown: [] });
  assert.deepEqual(navCoverage(nav, [{ paths: ['/board', '/board'] }, { paths: ['/new'] }]), {
    missing: ['/inbox', '/queue'],
    duplicate: ['/board'],
    unknown: ['/new'],
  });
});
