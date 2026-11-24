// docs/office.md § Conversation list — migration 67 on a temp SQLite DB: a
// chat's newest-message preview and message count are MAINTAINED columns,
// written by appendChatMessage and mapped by rowToChat, so every
// Chat-returning path carries them — the list, getChat, and above all the
// `UPDATE … RETURNING *` of beginChatTurn/finishChatTurn, which is the
// chat.updated payload after every reply. The backfill fills a chat whose
// messages predate the migration. (The suite runs SQLite only; the Postgres
// driver shares the migration and the same UPDATE, see postgres.ts.)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { after, before, describe, test } from 'node:test';
import { CHAT_PREVIEW_CHARS, chatPreviewText, type Chat } from '@tm/shared';
import { SqliteStorage } from './sqlite.ts';
import { MIGRATIONS } from './migrations.ts';

let tmp = '';
let storage: SqliteStorage;
let repoId = '';

const newChat = (title = 'c') =>
  storage.createChat({ repoId, title, model: 'claude-opus-5-5', effort: null, mode: 'read' });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-chat-summary-'));
  storage = new SqliteStorage(path.join(tmp, 'tm.db'));
  await storage.migrate();
  repoId = (await storage.createRepo({ name: 'r', path: tmp } as never)).id;
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('chatPreviewText (pure)', () => {
  test('collapses whitespace, drops fence markers, cuts with an ellipsis, and is idempotent', () => {
    assert.equal(chatPreviewText('  a\n\n b\t c '), 'a b c');
    assert.equal(chatPreviewText('see\n```ts\nconst x = 1;\n```\nok'), 'see const x = 1; ok');
    const long = 'x'.repeat(500);
    const cut = chatPreviewText(long);
    assert.equal(Array.from(cut).length, CHAT_PREVIEW_CHARS);
    assert.ok(cut.endsWith('…'));
    assert.equal(chatPreviewText(cut), cut);
    // code points, not UTF-16 units: an emoji is never split
    const emoji = chatPreviewText('😀'.repeat(300));
    assert.equal(Array.from(emoji).length, CHAT_PREVIEW_CHARS);
    assert.ok(!/[\uD800-\uDBFF]…$/.test(emoji));
  });
});

describe('maintained preview and count', () => {
  test('a chat with no message lists lastMessage null and messageCount 0', async () => {
    const c = await newChat('empty');
    assert.equal(c.lastMessage, null);
    assert.equal(c.messageCount, 0);
    const listed = (await storage.listChats()).find((x) => x.id === c.id)!;
    assert.equal(listed.lastMessage, null);
    assert.equal(listed.messageCount, 0);
  });

  test('N messages: the count and the newest message, on the list and on getChat', async () => {
    const c = await newChat('busy');
    await storage.appendChatMessage({ chatId: c.id, role: 'user', text: 'hello   there\n\nfriend', actor: 'human', roleId: 'role-d' });
    await storage.appendChatMessage({ chatId: c.id, role: 'assistant', text: 'Hi.', actor: 'claude', roleId: 'role-d' });
    await storage.appendChatMessage({ chatId: c.id, role: 'user', text: 'y'.repeat(400), actor: 'telegram' });
    const listed = (await storage.listChats()).find((x) => x.id === c.id)!;
    const got = (await storage.getChat(c.id))!;
    for (const x of [listed, got]) {
      assert.equal(x.messageCount, 3);
      assert.equal(x.lastMessage?.role, 'user');
      assert.equal(x.lastMessage?.actor, 'telegram');
      assert.equal(x.lastMessage?.roleId, null);
      assert.equal(Array.from(x.lastMessage!.text).length, CHAT_PREVIEW_CHARS);
    }
  });

  test('an empty failed reply previews its error', async () => {
    const c = await newChat('failed');
    await storage.appendChatMessage({ chatId: c.id, role: 'assistant', text: '', actor: 'claude', error: 'model_not_found' });
    const got = (await storage.getChat(c.id))!;
    assert.equal(got.lastMessage?.text, '⚠ model_not_found');
  });

  test('beginChatTurn and finishChatTurn (the chat.updated payload of a turn) carry them', async () => {
    const c = await newChat('turn');
    await storage.appendChatMessage({ chatId: c.id, role: 'user', text: 'question?', actor: 'human', roleId: 'r1' });
    const begun = (await storage.beginChatTurn(c.id))!;
    assert.equal(begun.status, 'thinking');
    assert.equal(begun.messageCount, 1);
    assert.deepEqual(begun.lastMessage, { text: 'question?', role: 'user', actor: 'human', roleId: 'r1' });
    await storage.appendChatMessage({ chatId: c.id, role: 'assistant', text: 'answer.', actor: 'claude', roleId: 'r1' });
    const finished = (await storage.finishChatTurn(c.id, { error: null, costUsd: 0.01 }))!;
    assert.equal(finished.status, 'idle');
    assert.equal(finished.messageCount, 2);
    assert.deepEqual(finished.lastMessage, { text: 'answer.', role: 'assistant', actor: 'claude', roleId: 'r1' });
    // a patch reads back through getChat and keeps them too
    const patched = (await storage.updateChat(c.id, { title: 'renamed' }))!;
    assert.equal(patched.messageCount, 2);
    assert.equal(patched.lastMessage?.text, 'answer.');
  });
});

describe('migration 67 backfill', () => {
  test('a DB migrated up to 66 with messages gains the preview and the count on the next migrate', async () => {
    const file = path.join(tmp, 'old66.db');
    const db = new Database(file);
    db.exec(`CREATE TABLE tm_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
    for (const m of MIGRATIONS.filter((m) => m.id <= 66)) {
      for (const s of m.statements) db.exec(s);
      db.prepare(`INSERT INTO tm_migrations (id, applied_at) VALUES (?, ?)`).run(m.id, new Date().toISOString());
    }
    const at = new Date().toISOString();
    const chat = db.prepare(
      `INSERT INTO tm_chats (id, repo_id, title, model, mode, status, turns, cost_usd, created_at, updated_at, last_message_at)
       VALUES (?, 'r', ?, 'm', 'read', 'idle', 0, 0, ?, ?, ?)`,
    );
    chat.run('with', 'with messages', at, at, at);
    chat.run('without', 'no messages', at, at, null);
    chat.run('errored', 'failed reply last', at, at, at);
    const msg = db.prepare(
      `INSERT INTO tm_chat_messages (id, chat_id, role, text, actor, error, cost_usd, created_at, role_id) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    );
    msg.run('0001-a', 'with', 'user', 'first', 'human', null, at, 'role-x');
    msg.run('0002-a', 'with', 'assistant', 'second', 'claude', null, at, 'role-x');
    msg.run('0003-a', 'with', 'user', 'z'.repeat(300), 'human', null, at, 'role-y');
    msg.run('0004-a', 'errored', 'user', 'ask', 'human', null, at, null);
    msg.run('0005-a', 'errored', 'assistant', '', 'claude', 'boom', at, null);
    db.close();

    const s = new SqliteStorage(file);
    await s.migrate();
    const byId = new Map<string, Chat>((await s.listChats()).map((c) => [c.id, c]));
    const w = byId.get('with')!;
    assert.equal(w.messageCount, 3);
    assert.equal(w.lastMessage?.role, 'user');
    assert.equal(w.lastMessage?.actor, 'human');
    assert.equal(w.lastMessage?.roleId, 'role-y');
    assert.equal(w.lastMessage?.text, 'z'.repeat(140), 'the backfill stores a raw SUBSTR of 140');
    assert.equal(chatPreviewText(w.lastMessage!.text).length, CHAT_PREVIEW_CHARS);
    const none = byId.get('without')!;
    assert.equal(none.messageCount, 0);
    assert.equal(none.lastMessage, null);
    assert.equal(byId.get('errored')!.lastMessage?.text, '⚠ boom');
    // and the maintained write carries on from the backfilled count
    await s.appendChatMessage({ chatId: 'with', role: 'assistant', text: 'fourth', actor: 'claude' });
    const after4 = (await s.getChat('with'))!;
    assert.equal(after4.messageCount, 4);
    assert.equal(after4.lastMessage?.text, 'fourth');
  });
});
