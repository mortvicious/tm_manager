import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Chat, ChatMessage, OfficeChannelResponse, OfficeHuddleView, OfficeMessage } from '@tm/shared';
import {
  OFFICE_READ_KEY,
  advanceMarker,
  applyChatMessage,
  baselineReadMap,
  buildConversations,
  chatUnread,
  conversationKey,
  formatUnread,
  loadBaselinedReadMap,
  loadReadMap,
  markRead,
  mergeChatUpdate,
  onReadChange,
  parseReadMap,
  pruneReadMap,
  timeUnread,
  upsertChat,
  writeBaseline,
  type ReadStorage,
  channelReadMark,
  huddleReadMark,
} from './officeConversations.ts';

const roles = [
  { id: 'd', name: 'Ada' },
  { id: 'q', name: 'Mira' },
  { id: 'u', name: 'Kai' },
];

const chat = (over: Partial<Chat> = {}): Chat => ({
  id: 'c1',
  repoId: 'r',
  title: 'Group chat',
  model: 'm',
  effort: null,
  mode: 'read',
  sessionId: null,
  status: 'idle',
  error: null,
  pid: null,
  turns: 0,
  costUsd: 0,
  createdAt: '2026-11-20T08:00:00.000Z',
  updatedAt: '2026-11-20T08:00:00.000Z',
  lastMessageAt: null,
  lastMessage: null,
  messageCount: 0,
  officeId: 'o1',
  participants: ['d', 'q', 'u', 'x'],
  plannerWorkspaceId: null,
  ...over,
});

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  chatId: 'c1',
  role: 'user',
  text: 'hello',
  actor: 'human',
  error: null,
  costUsd: 0,
  durationMs: null,
  createdAt: '2026-11-20T09:00:00.000Z',
  roleId: 'd',
  taintedAt: null,
  channelMessageId: null,
  blueprint: null,
  blueprintAppliedAt: null,
  ...over,
});

const officeMsg = (over: Partial<OfficeMessage> = {}): OfficeMessage => ({
  id: 'om1',
  officeId: 'o1',
  fromRoleId: 'q',
  toRoleId: null,
  kind: 'request' as OfficeMessage['kind'],
  subject: null,
  body: 'Flaky checkout\nfails 1 in 5',
  taintedAt: null,
  reviewedAt: null,
  routedAt: null,
  routedTaskId: null,
  createdAt: '2026-11-20T07:00:00.000Z',
  ...over,
});

const channel = (messages: OfficeMessage[]): OfficeChannelResponse => ({ messages, routes: {}, passes: {}, routingDueAt: null });

const huddle = (over: Partial<OfficeHuddleView> = {}): OfficeHuddleView => ({
  id: 'h1',
  officeId: 'o1',
  subject: { kind: 'task', id: 't1' } as OfficeHuddleView['subject'],
  roleIds: ['d', 'q'],
  turns: 1,
  maxTurns: 4,
  status: 'open',
  decision: null,
  taintedAt: null,
  createdAt: '2026-11-20T06:00:00.000Z',
  updatedAt: '2026-11-20T06:30:00.000Z',
  closedAt: null,
  entries: [
    { messageId: 'e1', kind: 'opening', turn: null, roleId: null, text: 'Should we?', taintedAt: null, at: '2026-11-20T06:00:00.000Z' },
    { messageId: 'e2', kind: 'turn', turn: 1, roleId: 'd', text: 'Yes.', taintedAt: null, at: '2026-11-20T06:30:00.000Z' },
  ],
  subjectLabel: 'Fix flaky test',
  openedBy: 'stakeholder',
  decisionMessageId: null,
  ...over,
});

class FakeStorage implements ReadStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

test('merging: the channel, chats and huddles in one list, newest activity first, stable on ties', () => {
  const rows = buildConversations({
    officeId: 'o1',
    chats: [
      chat({ id: 'c1', lastMessageAt: '2026-11-20T10:00:00.000Z', messageCount: 2, lastMessage: { text: 'Done.', role: 'assistant', actor: 'claude', roleId: 'q' } }),
      chat({ id: 'c2', title: 'Second', createdAt: '2026-11-19T00:00:00.000Z' }),
    ],
    channel: channel([officeMsg()]),
    huddles: [huddle()],
    roles,
    read: {},
  });
  assert.deepEqual(
    rows.map((r) => r.key),
    ['chat:c1', 'channel:o1', 'huddle:h1', 'chat:c2'],
  );
  const c1 = rows[0];
  assert.deepEqual(c1.preview, { sender: 'Mira', text: 'Done.', tainted: false });
  assert.deepEqual(c1.roleIds, ['d', 'q', 'u'], 'at most three avatars');
  const ch = rows[1];
  assert.equal(ch.title, 'Channel');
  assert.deepEqual(ch.preview, { sender: 'Mira', text: 'Flaky checkout — fails 1 in 5', tainted: false });
  assert.equal(ch.detail, '1 unrouted');
  assert.equal(ch.working, false);
  const h = rows[2];
  assert.equal(h.title, 'Huddle: Fix flaky test');
  assert.deepEqual(h.preview, { sender: 'Ada', text: 'Yes.', tainted: false });
  assert.equal(h.detail, 'turn 1/4 · open');
  // a brand-new chat sorts by its creation, never to the bottom as "no activity"
  assert.equal(rows[3].lastAt, '2026-11-19T00:00:00.000Z');
  assert.equal(rows[3].preview, null);

  // the channel is a row even before it loads; no activity sorts last
  const empty = buildConversations({ officeId: 'o1', chats: [], channel: null, huddles: null, roles, read: {} });
  assert.deepEqual(
    empty.map((r) => [r.key, r.lastAt]),
    [['channel:o1', null]],
  );
});

test('previews: the stakeholder is "You", an unknown role is named as deleted, a tainted channel message is flagged', () => {
  const rows = buildConversations({
    officeId: 'o1',
    chats: [chat({ lastMessageAt: '2026-11-20T10:00:00.000Z', messageCount: 1, lastMessage: { text: 'hi\n\nthere', role: 'user', actor: 'human', roleId: 'd' } })],
    channel: channel([officeMsg({ fromRoleId: 'gone', taintedAt: '2026-11-20T07:00:00.000Z', body: 'Only a subject' })]),
    huddles: [huddle({ entries: [], status: 'decided', decision: 'Ship it', closedAt: '2026-11-20T08:00:00.000Z' })],
    roles,
    read: {},
  });
  const by = new Map(rows.map((r) => [r.key, r]));
  assert.deepEqual(by.get('chat:c1')!.preview, { sender: 'You', text: 'hi there', tainted: false });
  assert.deepEqual(by.get('channel:o1')!.preview, { sender: 'a deleted role', text: 'Only a subject', tainted: true });
  const h = by.get('huddle:h1')!;
  assert.deepEqual(h.preview, { sender: 'Decision', text: 'Ship it', tainted: false });
  assert.equal(h.lastAt, '2026-11-20T08:00:00.000Z', 'a closed huddle sorts by its close');
  assert.equal(h.working, false);
});

test('working: a chat while thinking, a huddle while open with a turn owed', () => {
  const rows = buildConversations({
    officeId: 'o1',
    chats: [chat({ status: 'thinking' })],
    channel: null,
    huddles: [huddle({ id: 'open' }), huddle({ id: 'spent', turns: 4 }), huddle({ id: 'done', status: 'expired' })],
    roles,
    read: {},
  });
  const w = Object.fromEntries(rows.map((r) => [r.key, r.working]));
  assert.deepEqual(w, { 'chat:c1': true, 'channel:o1': false, 'huddle:open': true, 'huddle:spent': false, 'huddle:done': false });
});

test('unread maths: counts for chats, times for the channel and huddles, clamped, capped', () => {
  assert.equal(chatUnread(5, undefined), 5);
  assert.equal(chatUnread(5, { count: 3, at: '' }), 2);
  assert.equal(chatUnread(2, { count: 7, at: '' }), 0, 'never negative');
  const times = ['2026-11-20T01:00:00Z', '2026-11-20T02:00:00Z', '2026-11-20T03:00:00Z'];
  assert.equal(timeUnread(times, undefined), 3);
  assert.equal(timeUnread(times, { count: 0, at: '2026-11-20T02:00:00Z' }), 1);
  assert.equal(formatUnread(0), null);
  assert.equal(formatUnread(-1), null);
  assert.equal(formatUnread(7), '7');
  assert.equal(formatUnread(99), '99');
  assert.equal(formatUnread(100), '99+');

  const read = {
    [conversationKey('chat', 'c1')]: { count: 1, at: '2026-11-20T09:00:00.000Z' },
    [conversationKey('channel', 'o1')]: { count: 1, at: '2026-11-20T07:00:00.000Z' },
    [conversationKey('huddle', 'h1')]: { count: 1, at: '2026-11-20T06:00:00.000Z' },
  };
  const rows = buildConversations({
    officeId: 'o1',
    chats: [chat({ messageCount: 4, lastMessageAt: '2026-11-20T10:00:00.000Z' })],
    channel: channel([officeMsg(), officeMsg({ id: 'om2', createdAt: '2026-11-20T07:30:00.000Z' })]),
    huddles: [huddle()],
    roles,
    read,
  });
  const u = Object.fromEntries(rows.map((r) => [r.key, r.unread]));
  assert.deepEqual(u, { 'chat:c1': 3, 'channel:o1': 1, 'huddle:h1': 1 });
  // reading writes each row's own marker, after which nothing is unread
  const after = buildConversations({
    officeId: 'o1',
    chats: [chat({ messageCount: 4, lastMessageAt: '2026-11-20T10:00:00.000Z' })],
    channel: channel([officeMsg(), officeMsg({ id: 'om2', createdAt: '2026-11-20T07:30:00.000Z' })]),
    huddles: [huddle()],
    roles,
    read: baselineReadMap(rows),
  });
  assert.ok(after.every((r) => r.unread === 0));
});

test('chat.message moves the row once; a message the row already counts is ignored', () => {
  const c0 = chat();
  const c1 = applyChatMessage(c0, msg());
  assert.equal(c1.messageCount, 1);
  assert.equal(c1.lastMessageAt, '2026-11-20T09:00:00.000Z');
  assert.deepEqual(c1.lastMessage, { text: 'hello', role: 'user', actor: 'human', roleId: 'd' });
  assert.equal(applyChatMessage(c1, msg()), c1, 'the same frame twice counts once');
  const c2 = applyChatMessage(c1, msg({ id: 'm2', role: 'assistant', actor: 'claude', text: '', error: 'boom', createdAt: '2026-11-20T09:01:00.000Z' }));
  assert.equal(c2.messageCount, 2);
  assert.equal(c2.lastMessage?.text, '⚠ boom');
  assert.equal(applyChatMessage(c2, msg({ chatId: 'other', createdAt: '2026-11-20T10:00:00.000Z' })), c2, 'another chat’s frame');
});

test('the chat.updated merge rule: a lower or missing count keeps the local preview, else the incoming row wins', () => {
  const local = chat({
    status: 'thinking',
    messageCount: 2,
    lastMessageAt: '2026-11-20T09:01:00.000Z',
    lastMessage: { text: 'reply', role: 'assistant', actor: 'claude', roleId: 'd' },
  });
  // finishChatTurn's RETURNING * after the reply: same count → incoming as is
  const finished = chat({ status: 'idle', turns: 1, messageCount: 2, lastMessageAt: '2026-11-20T09:01:00.000Z', lastMessage: local.lastMessage });
  assert.deepEqual(mergeChatUpdate(local, finished), finished);
  // a row read before the last message (lower count) never rewinds
  const stale = chat({ status: 'idle', title: 'Renamed', messageCount: 1, lastMessageAt: '2026-11-20T09:00:00.000Z', lastMessage: { text: 'q', role: 'user', actor: 'human', roleId: 'd' } });
  const m = mergeChatUpdate(local, stale);
  assert.equal(m.title, 'Renamed');
  assert.equal(m.status, 'idle');
  assert.equal(m.messageCount, 2);
  assert.equal(m.lastMessage?.text, 'reply');
  assert.equal(m.lastMessageAt, '2026-11-20T09:01:00.000Z');
  // an older server's row has no fields at all
  const bare = { ...chat({ status: 'idle' }) } as Partial<Chat>;
  delete bare.lastMessage;
  delete bare.messageCount;
  const k = mergeChatUpdate(local, bare as Chat);
  assert.equal(k.messageCount, 2);
  assert.equal(k.lastMessage?.text, 'reply');
  // a higher count (messages this client missed) is taken
  const ahead = chat({ messageCount: 5, lastMessageAt: '2026-11-20T11:00:00.000Z', lastMessage: { text: 'new', role: 'user', actor: 'telegram', roleId: null } });
  assert.deepEqual(mergeChatUpdate(local, ahead), ahead);
  // no local row → incoming; upsert puts a new chat first and merges a known one
  assert.equal(mergeChatUpdate(undefined, stale), stale);
  const list = upsertChat([local], chat({ id: 'c9' }));
  assert.deepEqual(
    list.map((c) => c.id),
    ['c9', 'c1'],
  );
  assert.equal(upsertChat(list, stale)[1].messageCount, 2);
});

test('the read store: parse, advance-only markRead, baseline on a fresh device, prune, same-tab notify', () => {
  assert.equal(parseReadMap(null), null);
  assert.deepEqual(parseReadMap('not json'), {});
  assert.deepEqual(parseReadMap('[1]'), {});
  assert.deepEqual(parseReadMap('{"a":{"count":2,"at":"x"},"b":{"count":"2"},"c":null}'), { a: { count: 2, at: 'x' } });
  assert.deepEqual(advanceMarker({ count: 5, at: 'b' }, { count: 3, at: 'a' }), { count: 5, at: 'b' });
  assert.deepEqual(advanceMarker({ count: 1, at: 'a' }, { count: 3, at: 'b' }), { count: 3, at: 'b' });

  const s = new FakeStorage();
  let calls = 0;
  const off = onReadChange(() => calls++);
  try {
    const rows = buildConversations({ officeId: 'o1', chats: [chat({ messageCount: 3, lastMessageAt: '2026-11-20T09:00:00.000Z' })], channel: null, huddles: [], roles, read: {} });
    writeBaseline(rows, s);
    assert.deepEqual(loadReadMap(s), { 'channel:o1': { count: 0, at: '' }, 'chat:c1': { count: 3, at: '2026-11-20T09:00:00.000Z' } });
    assert.equal(calls, 1);
    writeBaseline([], s);
    assert.equal(calls, 1, 'the baseline is written once per device, never over real markers');
    markRead('chat:c1', { count: 5, at: '2026-11-20T10:00:00.000Z' }, s);
    assert.equal(loadReadMap(s)!['chat:c1'].count, 5);
    assert.equal(calls, 2);
    markRead('chat:c1', { count: 4, at: '2026-11-20T09:30:00.000Z' }, s);
    assert.equal(loadReadMap(s)!['chat:c1'].count, 5, 'never rewinds');
    assert.equal(calls, 2, 'a no-op write is skipped');
    assert.ok(s.data.has(OFFICE_READ_KEY) && OFFICE_READ_KEY.startsWith('tm.'));
  } finally {
    off();
  }

  const big: Record<string, { count: number; at: string }> = {};
  for (let i = 0; i < 10; i++) big[`k${i}`] = { count: i, at: `2026-11-${String(10 + i).padStart(2, '0')}` };
  assert.deepEqual(Object.keys(pruneReadMap(big, 3)).sort(), ['k7', 'k8', 'k9']);
  assert.equal(pruneReadMap(big, 20), big);
});

test('read marks: the threads and the list mark the channel and a huddle with the same marker', () => {
  const ch = channel([officeMsg({ id: 'a' }), officeMsg({ id: 'b', createdAt: '2026-11-20T08:00:00.000Z' })]);
  const rows = buildConversations({ officeId: 'o1', chats: [], channel: ch, huddles: [huddle()], roles, read: {} });
  const by = new Map(rows.map((r) => [r.key, r]));
  assert.deepEqual(channelReadMark(ch), { count: 2, at: '2026-11-20T08:00:00.000Z' });
  assert.deepEqual(by.get('channel:o1')!.readMark, channelReadMark(ch));
  assert.deepEqual(huddleReadMark(huddle()), { count: 2, at: '2026-11-20T06:30:00.000Z' });
  assert.deepEqual(by.get('huddle:h1')!.readMark, huddleReadMark(huddle()));
  assert.deepEqual(channelReadMark(null), { count: 0, at: '' });
  // marking with it clears the row's unread
  const read = { 'channel:o1': channelReadMark(ch), 'huddle:h1': huddleReadMark(huddle()) };
  const after = buildConversations({ officeId: 'o1', chats: [], channel: ch, huddles: [huddle()], roles, read });
  assert.deepEqual(
    after.map((r) => r.unread),
    [0, 0],
  );
});

test('baseline: a thread marking first does not make every other conversation unread', () => {
  const s = new FakeStorage();
  // the phone opens one huddle's sheet before anything wrote the baseline
  markRead('huddle:h1', { count: 2, at: '2026-11-20T06:30:00.000Z' }, s);
  assert.notEqual(loadReadMap(s), null);
  assert.equal(loadBaselinedReadMap(s), null, 'no unread is shown before the baseline');
  const rows = buildConversations({
    officeId: 'o1',
    chats: [],
    channel: channel([officeMsg()]),
    huddles: [huddle(), huddle({ id: 'h2' })],
    roles,
    read: {},
  });
  writeBaseline(rows, s);
  const read = loadBaselinedReadMap(s)!;
  assert.ok(read['huddle:h2'] && read['channel:o1'], 'missing keys get their current marker');
  const after = buildConversations({ officeId: 'o1', chats: [], channel: channel([officeMsg()]), huddles: [huddle(), huddle({ id: 'h2' })], roles, read });
  assert.deepEqual(after.map((r) => r.unread), [0, 0, 0]);
  // once per device: a later baseline never overwrites a real marker
  markRead('huddle:h2', { count: 9, at: '2026-11-21T00:00:00.000Z' }, s);
  writeBaseline(rows, s);
  assert.equal(loadReadMap(s)!['huddle:h2'].count, 9);
});
