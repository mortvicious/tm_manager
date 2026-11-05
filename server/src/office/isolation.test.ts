// docs/office.md § Isolation — the untrusted-storage resolver and a trusted shift's deny rules.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { archiveRoleNotes, scaffoldOfficeFolder, validateOfficeFolder } from './folder.ts';
import { denyRuleRefusal, trustedShiftDenies, untrustedPath } from './isolation.ts';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-isolation-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('untrustedPath', () => {
  const office = { folderPath: path.join(tmp, 'office') };

  test('resolves inside the office folder (the measured layout)', () => {
    assert.equal(untrustedPath(office, ''), path.join(tmp, 'office', 'untrusted'));
    assert.equal(untrustedPath(office, 'web/page.md'), path.join(tmp, 'office', 'untrusted', 'web', 'page.md'));
  });

  test('refuses an absolute or escaping relPath, and a relative folder', () => {
    assert.throws(() => untrustedPath(office, '/etc/passwd'), /relative/);
    assert.throws(() => untrustedPath(office, '../vision.md'), /escapes/);
    assert.throws(() => untrustedPath(office, 'a/../../roles/qa.md'), /escapes/);
    assert.throws(() => untrustedPath({ folderPath: 'office' }, 'x'), /absolute/);
  });
});

describe('trustedShiftDenies', () => {
  const root = path.join(tmp, 'deny office');
  const office = { folderPath: root };
  fs.mkdirSync(path.join(root, 'roles'), { recursive: true });
  fs.mkdirSync(path.join(root, 'deliverables', 'scan'), { recursive: true });

  test('denies the untrusted storage recursively in the CLI absolute form', () => {
    assert.deepEqual(trustedShiftDenies(office, []), [`Read(/${root}/untrusted/**)`]);
  });

  test('adds each tainted file exactly, a tainted directory recursively', () => {
    assert.deepEqual(trustedShiftDenies(office, ['roles/scout.md', 'deliverables/scan', 'roles/scout.md']), [
      `Read(/${root}/untrusted/**)`,
      `Read(/${root}/roles/scout.md)`,
      `Read(/${root}/deliverables/scan/**)`,
    ]);
  });

  test('a symlinked folder is denied on both its spellings', () => {
    const link = path.join(tmp, 'office-link');
    fs.symlinkSync(root, link);
    const rules = trustedShiftDenies({ folderPath: link }, ['roles/scout.md']);
    for (const r of [
      `Read(/${link}/untrusted/**)`,
      `Read(/${root}/untrusted/**)`,
      `Read(/${link}/roles/scout.md)`,
      `Read(/${root}/roles/scout.md)`,
    ])
      assert.ok(rules.includes(r), r);
  });

  test('refuses a tainted path outside the folder, the folder itself, or an absolute one', () => {
    assert.throws(() => trustedShiftDenies(office, ['../elsewhere.md']), /escapes/);
    assert.throws(() => trustedShiftDenies(office, ['.']), /escapes/);
    assert.throws(() => trustedShiftDenies(office, [path.join(root, 'roles/x.md')]), /relative/);
  });

  test('a path a rule cannot name literally fails closed', () => {
    assert.throws(() => trustedShiftDenies({ folderPath: path.join(tmp, 'o*') }, []), /permission rule/);
    assert.throws(() => trustedShiftDenies(office, ['roles/[a].md']), /permission rule/);
    for (const bad of ['/a/b*', '/a/b?', '/a/[b]', '/a/{b}', '/a/(b)', '/a/b\\c', '/a/!b', '/a/b\nc'])
      assert.ok(denyRuleRefusal(bad), JSON.stringify(bad));
    assert.equal(denyRuleRefusal('/Users/me/17 - task-manager/office'), null);
  });
});

describe('the folder goes through the resolver', () => {
  test('validation refuses a folder no deny rule could name', () => {
    const v = validateOfficeFolder(path.join(tmp, 'office (copy)'), []);
    assert.ok('error' in v && /permission rule/.test(v.error));
    assert.ok('path' in validateOfficeFolder(path.join(tmp, 'plain office'), []));
  });

  test('scaffold and archive write the untrusted storage where untrustedPath says', () => {
    const office = { id: 'o1', folderPath: path.join(tmp, 'scaffolded') };
    const res = scaffoldOfficeFolder(office, [{ key: 'qa', name: 'Q', title: 'QA', prompt: 'p' }]);
    const rel = path.relative(office.folderPath, untrustedPath(office, ''));
    assert.ok(res.created.includes(`${rel}/`));
    assert.ok(fs.existsSync(untrustedPath(office, 'README.md')));
    assert.match(fs.readFileSync(path.join(office.folderPath, 'README.md'), 'utf8'), new RegExp(`\`${rel}/\``));
    const moved = archiveRoleNotes(office, 'qa');
    assert.ok(moved);
    assert.ok(path.join(office.folderPath, moved).startsWith(untrustedPath(office, 'archived-notes') + path.sep));
  });
});
