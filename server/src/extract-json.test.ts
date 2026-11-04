// The fenced result block of an aux session (server/src/claude/aux.ts extractJson).
// Run: npm test
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { extractJson } from './claude/aux.ts';

const fence = '```';

describe('extractJson', () => {
  test('a plain trailing json fence', () => {
    assert.deepEqual(extractJson(`Done.\n\n${fence}json\n{"a":1}\n${fence}`), { a: 1 });
  });

  test('a ``` inside a JSON string does not cut the block (feature 0e323bef round 2)', () => {
    const value = { tasks: [{ description: `escape a ${fence} inside the text, and a ${fence}json opener too` }] };
    const text = `Prose with an aside ${fence}x${fence}.\n\n${fence}json\n${JSON.stringify(value)}\n${fence}`;
    assert.deepEqual(extractJson(text), value);
  });

  test('the LAST tagged fence wins over an earlier one', () => {
    const text = `${fence}json\n{"old":true}\n${fence}\nthen\n${fence}json\n{"new":true}\n${fence}`;
    assert.deepEqual(extractJson(text), { new: true });
  });

  test('a bare fence, then the whole text, then null', () => {
    assert.deepEqual(extractJson(`${fence}\n[1,2]\n${fence}`), [1, 2]);
    assert.deepEqual(extractJson('  {"b":2} '), { b: 2 });
    assert.equal(extractJson(`${fence}json\n{broken\n${fence}`), null);
  });
});
