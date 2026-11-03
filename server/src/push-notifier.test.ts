// Push deep links carry the panel tab the news is about (docs/push.md § Opening a notification).
// Run: npm test   (node:test through tsx)
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import type { Question, Task } from '@tm/shared';
import { broadcast } from './events.ts';
import { PushNotifier, taskUrl } from './push/notifier.ts';
import type { PushService } from './push/service.ts';
import type { Storage } from './storage/types.ts';

const ID = '0123abcd-0000-4000-8000-000000000001';

function task(over: Partial<Task>): Task {
  return {
    id: ID,
    title: 'T',
    status: 'running',
    reviewState: null,
    checkState: null,
    reviewRounds: [],
    resultSummary: 'did it',
    error: null,
    pausedTurn: null,
    waitFor: null,
    dependsOn: [],
    autoLandedAt: null,
    ...over,
  } as Task;
}

describe('push task URLs', () => {
  let row: Task;
  let sent: { kind: string; url: string | undefined }[];
  let notifier: PushNotifier;

  beforeEach(async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    row = task({});
    sent = [];
    const storage = {
      listTasks: async () => [row],
      listFeatures: async () => [],
      listReports: async () => [],
      getTask: async () => row,
    } as unknown as Storage;
    const push = {
      enabled: true,
      deliver: async (kind: string, p: { url?: string }) => void sent.push({ kind, url: p.url }),
    } as unknown as PushService;
    notifier = new PushNotifier({ storage, push });
    await notifier.start();
  });

  afterEach(() => {
    notifier.stop();
    mock.timers.reset();
  });

  async function move(over: Partial<Task>): Promise<void> {
    row = task(over);
    broadcast({ type: 'task.updated', task: row });
    await new Promise<void>((r) => setImmediate(r));
    mock.timers.tick(5000);
    for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
  }

  test('taskUrl encodes the id and appends only a known tab', () => {
    assert.equal(taskUrl('abc'), '/?task=abc');
    assert.equal(taskUrl('a b', 'review'), '/?task=a%20b&tab=review');
    assert.equal(taskUrl('abc', 'history'), '/?task=abc&tab=history');
  });

  test('review-ready opens the Review tab', async () => {
    await move({ status: 'review', reviewState: 'passed' });
    assert.deepEqual(sent.filter((s) => s.kind === 'review'), [{ kind: 'review', url: `/?task=${ID}&tab=review` }]);
  });

  test('auto-landed opens the Review tab', async () => {
    await move({ status: 'done', autoLandedAt: new Date().toISOString() });
    assert.deepEqual(sent.filter((s) => s.kind === 'done'), [{ kind: 'done', url: `/?task=${ID}&tab=review` }]);
  });

  test('failed opens the History tab', async () => {
    await move({ status: 'failed', error: 'boom' });
    assert.deepEqual(sent.filter((s) => s.kind === 'failed'), [{ kind: 'failed', url: `/?task=${ID}&tab=history` }]);
  });

  test('a question carries no tab', async () => {
    const q = {
      id: 'q1',
      taskId: ID,
      status: 'pending',
      questions: [{ question: 'Which?', options: [{ label: 'A' }] }],
    } as unknown as Question;
    broadcast({ type: 'question.updated', question: q });
    for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
    assert.deepEqual(sent, [{ kind: 'question', url: `/?task=${ID}` }]);
  });
});
