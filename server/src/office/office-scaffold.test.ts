// docs/office.md § Presets / § Office folder — presets, generated names, folder validation and scaffolding.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import {
  MODEL_OPTIONS,
  OFFICE_ROLE_PRESETS,
  SHIFT_WEB_TOOLS,
  cronError,
  guardError,
  shiftToolsRefusal,
} from '@tm/shared';
import { validateSpacePath } from '../spaces/service.ts';
import { OFFICE_README_MARKER, defaultOfficeFolder, scaffoldOfficeFolder, validateOfficeFolder } from './folder.ts';
import { OFFICE_THEMES, generateOfficeIdentities, generateRoleIdentity, officeTheme } from './names.ts';
import { OFFICE_PRESETS, roleFromPreset } from './presets.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-office-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('presets', () => {
  test('five presets, each valid and read-only', () => {
    assert.deepEqual([...OFFICE_ROLE_PRESETS].sort(), ['developer', 'devops', 'director', 'qa', 'seo']);
    for (const id of OFFICE_ROLE_PRESETS) {
      const p = OFFICE_PRESETS[id];
      assert.equal(p.preset, id);
      assert.equal(shiftToolsRefusal(p.tools), null, id);
      for (const bad of ['Bash', 'Edit', 'Write', 'NotebookEdit']) assert.ok(!p.tools.includes(bad), `${id} lists ${bad}`);
      assert.ok(MODEL_OPTIONS.includes(p.model), `${id} model ${p.model}`);
      assert.ok(p.schedules.length > 0, id);
      for (const s of p.schedules) assert.equal(cronError(s), null, `${id} ${s}`);
      for (const g of p.guards) assert.equal(guardError(g), null, `${id} ${g.kind}`);
      assert.match(p.prompt, /worker task/i, `${id} says how execution leaves a shift`);
    }
  });

  test('defaults: every preset on opus 5.5 (effort differs), SEO without web tools', () => {
    for (const id of OFFICE_ROLE_PRESETS) assert.equal(OFFICE_PRESETS[id].model, 'claude-opus-5-5', id);
    assert.ok(new Set(OFFICE_ROLE_PRESETS.map((id) => OFFICE_PRESETS[id].effort)).size > 1);
    assert.deepEqual(OFFICE_PRESETS.director.schedules, ['0 9,17 * * 1-5']);
    for (const w of SHIFT_WEB_TOOLS) assert.ok(!OFFICE_PRESETS.seo.tools.includes(w));
    assert.ok(OFFICE_PRESETS.qa.guards.some((g) => g.kind === 'new-commits-since'));
    assert.match(OFFICE_PRESETS.qa.prompt, /exploratory pass[\s\S]*FILED as worker tasks/);
    assert.match(OFFICE_PRESETS.devops.prompt, /SAVED COMMANDS a human allowlisted/);
    assert.match(OFFICE_PRESETS.seo.prompt, /SAVED COMMANDS a human allowlisted/);
  });

  test('roleFromPreset copies — editing the role never edits the preset', () => {
    const r = roleFromPreset('qa');
    r.tools.push('WebFetch');
    r.schedules[0] = '* * * * *';
    (r.guards[0] as { kind: string }).kind = 'cooldown';
    assert.ok(!OFFICE_PRESETS.qa.tools.includes('WebFetch'));
    assert.equal(OFFICE_PRESETS.qa.schedules[0], '0 11,16 * * 1-5');
    assert.equal(OFFICE_PRESETS.qa.guards[0]!.kind, 'new-commits-since');
  });
});

describe('names', () => {
  test('stable for the same seed', () => {
    for (const t of OFFICE_THEMES) {
      assert.deepEqual(generateRoleIdentity('office-1', 'qa', t), generateRoleIdentity('office-1', 'qa', t));
    }
  });

  test('differ across themes', () => {
    const names = OFFICE_THEMES.map((t) => generateRoleIdentity('office-1', 'qa', t).name);
    assert.equal(new Set(names).size, OFFICE_THEMES.length, names.join(' / '));
  });

  test('unknown theme falls back; a whole office has no duplicate given names', () => {
    assert.equal(officeTheme('nope'), 'pixel-office');
    assert.deepEqual(generateRoleIdentity('o', 'qa', null), generateRoleIdentity('o', 'qa', 'pixel-office'));
    const keys = [...OFFICE_ROLE_PRESETS, 'custom-a', 'custom-b', 'custom-c'];
    for (const t of OFFICE_THEMES) {
      const ids = generateOfficeIdentities('office-x', keys, t);
      assert.equal(new Set(Object.values(ids).map((i) => i.name)).size, keys.length, t);
      assert.deepEqual(ids, generateOfficeIdentities('office-x', keys, t));
      for (const i of Object.values(ids)) assert.ok(i.avatar.length > 0);
    }
  });
});

describe('folder', () => {
  const repoA = path.join(tmp, 'repos', 'a');
  fs.mkdirSync(repoA, { recursive: true });
  const repos = [{ id: 'ra', name: 'a', path: repoA }];

  test('refuses inside and containing a repo, relative and home', () => {
    assert.match((validateOfficeFolder(path.join(repoA, 'office'), repos) as { error: string }).error, /inside repo "a"/);
    assert.match((validateOfficeFolder(path.join(tmp, 'repos'), repos) as { error: string }).error, /contains repo "a"/);
    assert.ok('error' in validateOfficeFolder('rel/path', repos));
    assert.ok('error' in validateOfficeFolder('~', repos));
    assert.deepEqual(validateOfficeFolder(path.join(tmp, 'off'), repos), { path: path.join(tmp, 'off') });
  });

  test('a symlink cannot smuggle the folder into a repo; spaces share the rule', () => {
    const link = path.join(tmp, 'link-to-a');
    fs.symlinkSync(repoA, link);
    assert.match((validateOfficeFolder(path.join(link, 'new', 'dir'), repos) as { error: string }).error, /inside repo/);
    assert.deepEqual(validateSpacePath(path.join(link, 'x'), repos as never), validateOfficeFolder(path.join(link, 'x'), repos));
  });

  test('a workspace whose repos share a space resolves to <space>/office', () => {
    const repoB = path.join(tmp, 'repos', 'b');
    fs.mkdirSync(repoB, { recursive: true });
    const all = [...repos, { id: 'rb', name: 'b', path: repoB }];
    const spaces = [{ path: path.join(tmp, 'space'), repoIds: ['ra', 'rb'] }];
    assert.deepEqual(defaultOfficeFolder({ repoIds: ['ra', 'rb'] }, spaces, all), {
      path: path.join(tmp, 'space', 'office'),
      source: 'space',
    });
    // a repo outside the space → no shared folder
    assert.equal(defaultOfficeFolder({ repoIds: ['ra', 'rb'] }, [{ path: spaces[0]!.path, repoIds: ['ra'] }], all), null);
    assert.equal(defaultOfficeFolder({ repoIds: [] }, spaces, all), null);
    assert.equal(defaultOfficeFolder({ repoIds: ['gone'] }, spaces, all), null);
  });

  test('scaffold is idempotent and never overwrites an edited file', () => {
    const office = { id: 'office-1', folderPath: path.join(tmp, 'office-folder') };
    const roles = [{ key: 'qa', name: 'Dr. Tanaka', title: 'QA / Tester', prompt: 'Test things.' }];
    const first = scaffoldOfficeFolder(office, roles, { repos });
    for (const rel of ['vision.md', 'priorities.md', 'roadmap.md', 'roles/qa.md', 'README.md', 'untrusted/README.md', 'briefings/', 'deliverables/']) {
      assert.ok(first.created.includes(rel), rel);
    }
    assert.match(fs.readFileSync(path.join(office.folderPath, 'untrusted', 'README.md'), 'utf8'), /never read this folder unreviewed/);
    assert.ok(fs.readFileSync(path.join(office.folderPath, 'README.md'), 'utf8').startsWith(OFFICE_README_MARKER));

    fs.writeFileSync(path.join(office.folderPath, 'vision.md'), 'MY VISION\n');
    fs.writeFileSync(path.join(office.folderPath, 'roles', 'qa.md'), 'my notes\n');
    const second = scaffoldOfficeFolder(office, roles, { repos });
    assert.deepEqual(second.created, []);
    assert.equal(second.readmeUpdated, false);
    assert.equal(fs.readFileSync(path.join(office.folderPath, 'vision.md'), 'utf8'), 'MY VISION\n');
    assert.equal(fs.readFileSync(path.join(office.folderPath, 'roles', 'qa.md'), 'utf8'), 'my notes\n');

    // a new role adds its file and refreshes the marked README
    const third = scaffoldOfficeFolder(office, [...roles, { key: 'seo', name: 'Liaison Park', title: 'SEO', prompt: 'x' }]);
    assert.deepEqual(third.created, ['roles/seo.md']);
    assert.equal(third.readmeUpdated, true);
    assert.match(fs.readFileSync(path.join(office.folderPath, 'README.md'), 'utf8'), /roles\/seo\.md/);

    // a README without the marker is the human's
    fs.writeFileSync(path.join(office.folderPath, 'README.md'), 'mine\n');
    assert.equal(scaffoldOfficeFolder(office, []).readmeUpdated, false);
    assert.equal(fs.readFileSync(path.join(office.folderPath, 'README.md'), 'utf8'), 'mine\n');
  });

  test('scaffold refuses a folder inside a repo and a bad role key, writing nothing', () => {
    const inRepo = path.join(repoA, 'office');
    assert.throws(() => scaffoldOfficeFolder({ id: 'o', folderPath: inRepo }, [], { repos }), /inside repo/);
    assert.ok(!fs.existsSync(inRepo));
    const p = path.join(tmp, 'bad-key');
    assert.throws(() => scaffoldOfficeFolder({ id: 'o', folderPath: p }, [{ key: '../x', name: 'n', title: 't', prompt: 'p' }]), /bad role key/);
    assert.ok(!fs.existsSync(p));
  });
});
