// Agent-draft triage grouping (docs/inbox.md § Draft triage).
// Run: npm test   (node:test through tsx; pure, no git and no DB)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { triageDrafts, type Run, type Task, type TriageGroup } from '@tm/shared';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function t(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: `T ${id}`,
    status: 'draft',
    repoId: 'r1',
    source: 'manual',
    createdByRun: null,
    hiddenAt: null,
    inboxKeptUntil: null,
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    ...extra,
  } as unknown as Task;
}
const run = (id: string, taskId: string | null) => ({ id, taskId }) as Run;

const keys = (gs: TriageGroup[]) => gs.map((g) => g.key);
const members = (gs: TriageGroup[]) => Object.fromEntries(gs.map((g) => [g.key, g.drafts.map((d) => d.task.id)]));

describe('triageDrafts', () => {
  const filerA = t('A', { status: 'review', title: 'filer A' });
  const filerB = t('B', { status: 'done', repoId: 'r2' });
  const runs = [run('ra', 'A'), run('rb', 'B'), run('rgone', 'Z'), run('raux', null)];

  test('only external drafts, hidden only on request', () => {
    const tasks = [
      filerA,
      filerB,
      t('d1', { createdByRun: 'ra' }),
      t('manual'),
      t('feat', { source: 'feature' }),
      t('queued', { status: 'queued', createdByRun: 'ra' }),
      t('hidden', { createdByRun: 'ra', hiddenAt: daysAgo(0) }),
      t('sentry', { source: 'sentry' }),
    ];
    const r = triageDrafts({ tasks, runs, now: NOW });
    assert.deepEqual(r.drafts.map((d) => d.task.id).sort(), ['d1', 'sentry']);
    const h = triageDrafts({ tasks, runs, now: NOW, includeHidden: true });
    assert.deepEqual(h.drafts.map((d) => d.task.id).sort(), ['d1', 'hidden', 'sentry']);
  });

  test('repo scope: null = all, empty = nothing, a set keeps repo-less drafts', () => {
    const tasks = [t('x1', { source: 'auto', repoId: 'r1' }), t('x2', { source: 'auto', repoId: 'r2' }), t('x3', { source: 'auto', repoId: null })];
    const ids = (repoIds: ReadonlySet<string> | null) =>
      triageDrafts({ tasks, runs: [], now: NOW, repoIds }).drafts.map((d) => d.task.id).sort();
    assert.deepEqual(ids(null), ['x1', 'x2', 'x3']);
    assert.deepEqual(ids(new Set()), []);
    assert.deepEqual(ids(new Set(['r2'])), ['x2', 'x3']);
  });

  test('byFiler: filer task, run unknown, filer deleted, source fallback', () => {
    const tasks = [
      filerA,
      filerB,
      t('a1', { createdByRun: 'ra' }),
      t('b1', { createdByRun: 'rb' }),
      t('lost', { createdByRun: 'nope' }),
      t('aux', { createdByRun: 'raux' }),
      t('orphan', { createdByRun: 'rgone' }),
      t('s1', { source: 'sentry' }),
    ];
    const { byFiler } = triageDrafts({ tasks, runs, now: NOW });
    const g = Object.fromEntries(byFiler.map((x) => [x.key, x]));
    assert.equal(g['filer:A'].kind, 'filer');
    assert.equal(g['filer:A'].filer?.title, 'filer A');
    assert.equal(g['filer:A'].repoId, 'r1');
    assert.equal(g['filer:B'].repoId, 'r2');
    assert.equal(g['run-unknown'].label, 'filer run unknown');
    assert.deepEqual(g['run-unknown'].drafts.map((d) => d.task.id).sort(), ['aux', 'lost']);
    assert.equal(g['filer-deleted'].label, 'filer task deleted');
    assert.equal(g['source:sentry'].label, 'source: sentry');
    assert.equal(g['source:sentry'].source, 'sentry');
  });

  test('ordering: drafts oldest first; groups by size, then oldest member', () => {
    const tasks = [
      filerA,
      filerB,
      t('a-new', { createdByRun: 'ra', createdAt: daysAgo(1) }),
      t('a-old', { createdByRun: 'ra', createdAt: daysAgo(5) }),
      t('b-oldest', { createdByRun: 'rb', createdAt: daysAgo(30), repoId: 'r2' }),
      t('s-mid', { source: 'auto', createdAt: daysAgo(10), repoId: 'r2' }),
    ];
    const r = triageDrafts({ tasks, runs, now: NOW });
    assert.deepEqual(keys(r.byFiler), ['filer:A', 'filer:B', 'source:auto']);
    assert.deepEqual(members(r.byFiler)['filer:A'], ['a-old', 'a-new']);
    // repos: r1 has 2, r2 has 2 → r2 first because its oldest is older
    assert.deepEqual(keys(r.byRepo), ['repo:r2', 'repo:r1']);
    assert.deepEqual(members(r.byRepo)['repo:r2'], ['b-oldest', 's-mid']);
  });

  test('age, stale and kept', () => {
    const tasks = [
      t('young', { source: 'auto', createdAt: daysAgo(3) }),
      t('old', { source: 'auto', createdAt: daysAgo(20) }),
      t('kept', { source: 'auto', createdAt: daysAgo(20), inboxKeptUntil: daysAgo(-2) }),
      t('lapsed', { source: 'auto', createdAt: daysAgo(20), inboxKeptUntil: daysAgo(1) }),
    ];
    const r = triageDrafts({ tasks, runs: [], now: NOW, staleDraftDays: 14 });
    const by = Object.fromEntries(r.drafts.map((d) => [d.task.id, d]));
    assert.equal(by.young.ageDays, 3);
    assert.equal(by.old.ageDays, 20);
    assert.deepEqual([by.young.stale, by.old.stale, by.kept.stale, by.lapsed.stale], [false, true, false, true]);
    assert.deepEqual([by.young.kept, by.old.kept, by.kept.kept, by.lapsed.kept], [false, false, true, false]);
    // a shorter window makes the young one stale too
    assert.equal(triageDrafts({ tasks, runs: [], now: NOW, staleDraftDays: 2 }).drafts.find((d) => d.task.id === 'young')?.stale, true);
  });
});
