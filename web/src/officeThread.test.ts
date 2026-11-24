import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, OfficeHuddleEntry } from '@tm/shared';
import {
  buildThread,
  buildThreadOf,
  channelEntryView,
  countNewSince,
  countNewSinceOf,
  huddleEntryView,
  dayLabel,
  GROUP_WINDOW_MS,
  isOwnMessage,
  resolveTaskRefs,
  senderKey,
  taskRefCandidates,
} from './officeThread.ts';

let seq = 0;
function msg(over: Partial<ChatMessage> & { createdAt: string }): ChatMessage {
  seq++;
  return {
    id: `m${seq}`,
    chatId: 'c1',
    role: 'assistant',
    text: 'hi',
    actor: 'claude',
    error: null,
    costUsd: 0,
    durationMs: null,
    roleId: 'r-qa',
    taintedAt: null,
    channelMessageId: null,
    blueprint: null,
    blueprintAppliedAt: null,
    ...over,
  };
}

/** a local wall-clock instant (the grouping is in local time) */
function local(y: number, mo: number, d: number, h = 10, mi = 0, s = 0): string {
  return new Date(y, mo - 1, d, h, mi, s).toISOString();
}

const NOW = new Date(2026, 10, 24, 12, 0); // Tue 24 Nov 2026, local

test('own messages: user role, human or telegram actor', () => {
  assert.equal(isOwnMessage({ role: 'user', actor: 'human' }), true);
  assert.equal(isOwnMessage({ role: 'user', actor: 'telegram' }), true);
  assert.equal(isOwnMessage({ role: 'assistant', actor: 'claude' }), false);
  // routed to different roles, the stakeholder is still one sender
  assert.equal(senderKey({ role: 'user', actor: 'human', roleId: 'a' }), senderKey({ role: 'user', actor: 'telegram', roleId: 'b' }));
  assert.notEqual(senderKey({ role: 'assistant', actor: 'claude', roleId: 'a' }), senderKey({ role: 'assistant', actor: 'claude', roleId: 'b' }));
});

test('day labels: Today, Yesterday, weekday within 6 days, else a date', () => {
  assert.equal(dayLabel(new Date(2026, 10, 24, 0, 1), NOW), 'Today');
  assert.equal(dayLabel(new Date(2026, 10, 23, 23, 59), NOW), 'Yesterday');
  assert.equal(dayLabel(new Date(2026, 10, 18, 9), NOW), 'Wednesday'); // 6 days ago
  assert.equal(dayLabel(new Date(2026, 10, 17, 9), NOW), '17 Nov 2026'); // 7 days ago
  assert.equal(dayLabel(new Date(2026, 10, 25, 9), NOW), '25 Nov 2026'); // future: a date
});

test('same sender within 5 minutes of the previous message is one group', () => {
  const a = msg({ createdAt: local(2026, 11, 24, 10, 0) });
  const b = msg({ createdAt: local(2026, 11, 24, 10, 4) });
  const c = msg({ createdAt: local(2026, 11, 24, 10, 8) }); // 4 min after b: still joined
  const d = msg({ createdAt: new Date(Date.parse(c.createdAt) + GROUP_WINDOW_MS + 1000).toISOString() });
  const items = buildThread([a, b, c, d], NOW);
  assert.deepEqual(
    items.map((i) => (i.kind === 'day' ? `day:${i.label}` : i.messages.map((m) => m.id).join('+'))),
    ['day:Today', `${a.id}+${b.id}+${c.id}`, d.id],
  );
});

test('a different sender, or a different role, starts a new group', () => {
  const t = local(2026, 11, 24, 10, 0);
  const own = msg({ role: 'user', actor: 'human', createdAt: t });
  const own2 = msg({ role: 'user', actor: 'telegram', roleId: 'r-dir', createdAt: t });
  const qa = msg({ createdAt: t });
  const ux = msg({ roleId: 'r-ux', createdAt: t });
  const items = buildThread([own, own2, qa, ux], NOW).filter((i) => i.kind === 'group');
  assert.equal(items.length, 3);
  assert.equal(items[0].kind === 'group' && items[0].own, true);
  assert.equal(items[0].kind === 'group' && items[0].messages.length, 2);
  assert.equal(items[1].kind === 'group' && items[1].roleId, 'r-qa');
  assert.equal(items[2].kind === 'group' && items[2].roleId, 'r-ux');
});

test('a day separator always ends a group, and keys are stable as the thread grows', () => {
  const a = msg({ createdAt: local(2026, 11, 23, 23, 58) });
  const b = msg({ createdAt: local(2026, 11, 24, 0, 1) }); // 3 min later, next day
  const items = buildThread([a, b], NOW);
  assert.deepEqual(
    items.map((i) => i.key),
    ['day:2026-11-23', a.id, 'day:2026-11-24', b.id],
  );
  assert.equal(items[0].kind === 'day' && items[0].label, 'Yesterday');
  const c = msg({ createdAt: local(2026, 11, 24, 0, 2) });
  const grown = buildThread([a, b, c], NOW);
  assert.equal(grown.length, 4);
  assert.equal(grown[3].key, b.id); // the group keeps its first message's id
  assert.equal(grown[3].kind === 'group' && grown[3].messages.length, 2);
});

test('empty transcript is no rows', () => {
  assert.deepEqual(buildThread([], NOW), []);
});

test('countNewSince counts others after the mark, never own messages', () => {
  const t = local(2026, 11, 24);
  const a = msg({ createdAt: t });
  const mine = msg({ role: 'user', actor: 'human', createdAt: t });
  const b = msg({ createdAt: t });
  const c = msg({ createdAt: t });
  assert.equal(countNewSince([a, mine, b, c], a.id), 2);
  assert.equal(countNewSince([a, mine, b, c], c.id), 0);
  assert.equal(countNewSince([a, b], null), 0);
  assert.equal(countNewSince([a, b], 'gone'), 0);
});

test('task refs: full ids, ?task= links, id8; numbers and uuid segments are not ids', () => {
  const full = '0247f8c9-f18f-4615-8b5d-48629ba5ec40';
  const c = taskRefCandidates(`See ?task=${full.toUpperCase()} and db6965bc, also 20261124 and deadbeef1.`);
  assert.deepEqual(c.full, [full]);
  assert.deepEqual(c.short, ['db6965bc']); // the uuid's own 0247f8c9 is not repeated as a short id
});

test('resolveTaskRefs keeps known ids and unambiguous id8s only', () => {
  const tasks = [
    { id: '0247f8c9-f18f-4615-8b5d-48629ba5ec40' },
    { id: 'db6965bc-ea9f-4ef3-bdca-610be2120a87' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000001' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000002' },
  ];
  assert.deepEqual(
    resolveTaskRefs(
      { full: ['0247f8c9-f18f-4615-8b5d-48629ba5ec40', '11111111-1111-4111-8111-111111111111'], short: ['db6965bc', 'aaaaaaaa', 'bbbbbbbb'] },
      tasks,
    ),
    ['0247f8c9-f18f-4615-8b5d-48629ba5ec40', 'db6965bc-ea9f-4ef3-bdca-610be2120a87'],
  );
  // a short id naming a task already linked in full is not a second card
  assert.deepEqual(resolveTaskRefs({ full: ['db6965bc-ea9f-4ef3-bdca-610be2120a87'], short: ['db6965bc'] }, tasks), [
    'db6965bc-ea9f-4ef3-bdca-610be2120a87',
  ]);
  assert.deepEqual(resolveTaskRefs({ full: [], short: [] }, tasks), []);
});

// ---- the channel's and huddles' threads (buildThreadOf + the entry views) ----

function cmsg(id: string, fromRoleId: string | null, createdAt: string) {
  return { id, fromRoleId, createdAt };
}

test('channel: writers group, the stakeholder (no role) is own', () => {
  const items = buildThreadOf(
    [
      cmsg('a', 'r-qa', local(2026, 11, 20, 10, 0)),
      cmsg('b', 'r-qa', local(2026, 11, 20, 10, 2)),
      cmsg('c', null, local(2026, 11, 20, 10, 3)),
      cmsg('d', 'r-ux', local(2026, 11, 20, 10, 4)),
    ],
    channelEntryView,
    NOW,
  );
  const groups = items.filter((i) => i.kind === 'group');
  assert.deepEqual(
    groups.map((g) => (g.kind === 'group' ? [g.key, g.own, g.messages.length] : null)),
    [
      ['a', false, 2],
      ['c', true, 1],
      ['d', false, 1],
    ],
  );
  assert.equal(items[0].kind, 'day');
});

function hentry(over: Partial<OfficeHuddleEntry> & { messageId: string; at: string }): OfficeHuddleEntry {
  return { kind: 'turn', turn: 1, roleId: 'r-qa', text: 't', taintedAt: null, ...over };
}

test('huddle: the opening question is own, a server note is a system row that ends a group', () => {
  const at = (mi: number) => local(2026, 11, 20, 11, mi);
  const items = buildThreadOf(
    [
      hentry({ messageId: 'o', kind: 'opening', turn: null, roleId: null, at: at(0) }),
      hentry({ messageId: 't1', roleId: 'r-qa', at: at(1) }),
      hentry({ messageId: 's', kind: 'server', turn: 2, roleId: null, at: at(2) }),
      hentry({ messageId: 't3', roleId: 'r-qa', turn: 3, at: at(3) }),
    ],
    huddleEntryView,
    NOW,
  );
  assert.deepEqual(
    items.map((i) => (i.kind === 'group' ? `g:${i.key}:${i.own}` : i.kind === 'system' ? `s:${i.key}` : 'day')),
    ['day', 'g:o:true', 'g:t1:false', 's:s', 'g:t3:false'],
  );
});

test('countNewSinceOf counts others after the mark', () => {
  const es = [
    { id: 'a', own: false },
    { id: 'b', own: true },
    { id: 'c', own: false },
  ];
  assert.equal(countNewSinceOf(es, 'a'), 1);
  assert.equal(countNewSinceOf(es, 'zz'), 0);
  assert.equal(countNewSinceOf(es, null), 0);
});
