// Fix rounds of the Feature plan loop (server/src/claude/plan-fix.ts, docs/features.md § Fix rounds).
// Run: npm test
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { FeaturePlan, PlanFinding } from '@tm/shared';
import { applyPlanEdits, cardLabels, mergePlanFixRound, planFixAcceptor, type PlanFix } from './claude/plan-fix.ts';

const card = (id: string, title: string, dependsOn: string[] = []) => ({
  id,
  title,
  description: `${title} body`,
  category: null,
  effort: null,
  review: null,
  exitCriteria: ['done'],
  dependsOn,
  excluded: false,
});

const plan: FeaturePlan = {
  summary: 's',
  considerations: ['c'],
  phases: [
    { title: 'Engine', goal: 'g1', tasks: [card('aaaaaaaa-1', 'Schema'), card('bbbbbbbb-2', 'Runner', ['aaaaaaaa-1'])] },
    { title: 'View', goal: 'g2', tasks: [card('cccccccc-3', 'Page', ['bbbbbbbb-2'])] },
  ],
};
let n = 0;
const newId = () => `new-${++n}`;
const fix = (edits: PlanFix['edits']): PlanFix => ({ edits, notes: [] });

describe('applyPlanEdits', () => {
  test('labels are 8-char id prefixes', () => {
    assert.deepEqual([...cardLabels(plan).values()], ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']);
  });

  test('an update touches only that card; every other card stays identical, ids kept', () => {
    const r = applyPlanEdits(plan, fix([{ op: 'update', card: 'bbbbbbbb', set: { description: 'new body' }, reason: 'F1' }]), newId);
    assert.ok(r.ok, !r.ok ? r.error : '');
    assert.equal(r.plan.phases[0].tasks[1].description, 'new body');
    assert.equal(r.plan.phases[0].tasks[1].id, 'bbbbbbbb-2');
    assert.deepEqual(r.plan.phases[0].tasks[0], plan.phases[0].tasks[0]);
    assert.deepEqual(r.plan.phases[1], plan.phases[1]);
    assert.deepEqual(r.changed, ['bbbbbbbb-2']);
    assert.equal(plan.phases[0].tasks[1].description, 'Runner body', 'input not mutated');
  });

  test('split: update + add with a dependency on a new card, in place', () => {
    const r = applyPlanEdits(
      plan,
      fix([
        { op: 'add', id: 'n1', phase: 1, after: 'aaaaaaaa', task: { title: 'Runner core', description: 'd', exitCriteria: ['x'] }, reason: 'split' },
        { op: 'update', card: 'bbbbbbbb', set: { title: 'Runner wiring', dependsOn: ['n1'] }, reason: 'split' },
      ]),
      newId,
    );
    assert.ok(r.ok, !r.ok ? r.error : '');
    const [schema, core, runner] = r.plan.phases[0].tasks;
    assert.equal(schema.id, 'aaaaaaaa-1');
    assert.equal(core.title, 'Runner core');
    assert.deepEqual(runner.dependsOn, [core.id]);
    assert.deepEqual(new Set(r.changed), new Set([core.id, 'bbbbbbbb-2']));
  });

  test('remove drops dependencies on the removed card; an emptied phase is dropped', () => {
    const r = applyPlanEdits(
      plan,
      fix([
        { op: 'remove', card: 'aaaaaaaa', reason: 'dup' },
        { op: 'move', card: 'cccccccc', phase: 1, after: 'bbbbbbbb', reason: 'merge' },
      ]),
      newId,
    );
    assert.ok(r.ok, !r.ok ? r.error : '');
    assert.equal(r.plan.phases.length, 1);
    assert.deepEqual(r.plan.phases[0].tasks.map((t) => t.id), ['bbbbbbbb-2', 'cccccccc-3']);
    assert.deepEqual(r.plan.phases[0].tasks[0].dependsOn, []);
    assert.deepEqual(r.removed, ['aaaaaaaa-1']);
  });

  test('add-phase inserts where asked, and new cards can go into it by its id', () => {
    const r = applyPlanEdits(
      plan,
      fix([
        { op: 'add-phase', id: 'p1', after: 1, title: 'Briefings', goal: 'g', reason: 'F2' },
        { op: 'add', id: 'n1', phase: 'p1', after: null, task: { title: 'Stand-up', description: 'd', exitCriteria: [], dependsOn: ['bbbbbbbb'] }, reason: 'F2' },
      ]),
      newId,
    );
    assert.ok(r.ok, !r.ok ? r.error : '');
    assert.deepEqual(r.plan.phases.map((p) => p.title), ['Engine', 'Briefings', 'View']);
    assert.deepEqual(r.plan.phases[1].tasks[0].dependsOn, ['bbbbbbbb-2']);
  });

  test('bad refs and forward dependencies fail the whole result with a typed-back message', () => {
    const unknown = applyPlanEdits(plan, fix([{ op: 'update', card: 'zzzzzzzz', set: { title: 'x' }, reason: 'r' }]), newId);
    assert.equal(unknown.ok, false);
    assert.match(!unknown.ok ? unknown.error : '', /edit 1: no card "zzzzzzzz"/);
    const forward = applyPlanEdits(plan, fix([{ op: 'move', card: 'cccccccc', phase: 1, after: 'start', reason: 'r' }]), newId);
    assert.equal(forward.ok, false);
    assert.match(!forward.ok ? forward.error : '', /cccccccc "Page" depends on bbbbbbbb "Runner", which is not EARLIER/);
    const badDep = applyPlanEdits(plan, fix([{ op: 'update', card: 'cccccccc', set: { dependsOn: ['nope'] }, reason: 'r' }]), newId);
    assert.match(!badDep.ok ? badDep.error : '', /dependsOn "nope", which is no card/);
  });

  test('untouched human edits never fail a fix: long title kept, forward/dangling deps dropped (review round 1)', () => {
    const human: FeaturePlan = structuredClone(plan);
    human.phases[1].tasks[0].title = 'x'.repeat(120);
    human.phases[0].tasks.reverse(); // Runner above Schema: its dep on Schema now points forward
    human.phases[1].tasks[0].dependsOn = ['gone-card'];
    const r = applyPlanEdits(human, fix([{ op: 'update', card: 'aaaaaaaa', set: { description: 'd2' }, reason: 'F1' }]), newId);
    assert.ok(r.ok, !r.ok ? r.error : '');
    assert.equal(r.plan.phases[1].tasks[0].title.length, 120);
    assert.deepEqual(r.plan.phases[0].tasks[0].dependsOn, []); // Runner's forward edge dropped
    assert.deepEqual(r.plan.phases[1].tasks[0].dependsOn, []); // dangling edge dropped
  });

  test('null in an update means unchanged', () => {
    const r = applyPlanEdits(
      plan,
      fix([{ op: 'update', card: 'bbbbbbbb', set: { description: 'n', exitCriteria: null, dependsOn: null, category: null }, reason: 'r' }]),
      newId,
    );
    assert.ok(r.ok);
    const t = r.plan.phases[0].tasks[1];
    assert.deepEqual(t.exitCriteria, ['done']);
    assert.deepEqual(t.dependsOn, ['aaaaaaaa-1']);
  });

  test('two phases added after the same one keep their order; "2" is phase 2', () => {
    const r = applyPlanEdits(
      plan,
      fix([
        { op: 'add-phase', id: 'p1', after: 1, title: 'A', goal: 'g', reason: 'r' },
        { op: 'add-phase', id: 'p2', after: 1, title: 'B', goal: 'g', reason: 'r' },
        { op: 'add', id: 'n1', phase: 'p1', task: { title: 'a', description: 'd', exitCriteria: [] }, reason: 'r' },
        { op: 'add', id: 'n2', phase: 'p2', task: { title: 'b', description: 'd', exitCriteria: [], dependsOn: ['n1'] }, reason: 'r' },
        { op: 'add', id: 'n3', phase: '2', task: { title: 'c', description: 'd', exitCriteria: [] }, reason: 'r' },
      ]),
      newId,
    );
    assert.ok(r.ok, !r.ok ? r.error : '');
    assert.deepEqual(r.plan.phases.map((p) => p.title), ['Engine', 'A', 'B', 'View']);
    assert.deepEqual(r.plan.phases[3].tasks.map((t) => t.title), ['Page', 'c']);
    assert.equal(r.labels.get(r.plan.phases[1].tasks[0].id), 'n1', 'the reviewer sees the planner\'s own id');
  });

  test('a fix may not empty the plan, nor break an untouched card by moving what it depends on', () => {
    const empty = applyPlanEdits(plan, fix(['aaaaaaaa', 'bbbbbbbb', 'cccccccc'].map((card) => ({ op: 'remove' as const, card, reason: 'r' }))), newId);
    assert.match(!empty.ok ? empty.error : '', /no tasks/);
    const broke = applyPlanEdits(plan, fix([{ op: 'move', card: 'bbbbbbbb', phase: 2, after: 'cccccccc', reason: 'r' }]), newId);
    assert.match(!broke.ok ? broke.error : '', /moving bbbbbbbb .* puts it after cccccccc/);
  });

  test('the acceptor validates and applies, so the aux runner can type a correction', () => {
    const acc = planFixAcceptor(plan, newId);
    assert.equal(acc.safeParse({ edits: [{ op: 'remove', card: 'nope', reason: 'r' }], notes: [] }).success, false);
    const ok = acc.safeParse({ edits: [], notes: [{ finding: 1, note: 'wrong: see docs' }] });
    assert.ok(ok.success);
  });
});

describe('mergePlanFixRound', () => {
  const handed: PlanFinding[] = [
    { severity: 'major', summary: 'A', detail: null },
    { severity: 'major', summary: 'B', detail: 'b' },
    { severity: 'blocker', summary: 'C', detail: null },
  ];
  const meta = { round: 6, model: 'm', at: 'now', edits: ['updated x'] };

  test('resolved findings close; unresolved and UNANSWERED ones stay open (fails closed)', () => {
    const r = mergePlanFixRound(handed, { previous: [{ id: 1, status: 'resolved' }, { id: 2, status: 'unresolved', note: 'still vague' }], findings: [] }, meta);
    assert.deepEqual(r.resolutions?.map((x) => x.status), ['resolved', 'unresolved', 'unresolved']);
    assert.deepEqual(r.findings.map((f) => f.summary), ['C', 'B']);
    assert.match(r.findings[1].detail ?? '', /still open: still vague/);
    assert.equal(r.verdict, 'blocker');
    assert.equal(r.mode, 'fix');
  });

  test('new minors are capped at 3; all resolved and nothing new = clean', () => {
    const minors = Array.from({ length: 5 }, (_, i) => ({ severity: 'minor' as const, summary: `m${i}` }));
    const r = mergePlanFixRound(handed, { previous: [1, 2, 3].map((id) => ({ id, status: 'resolved' as const })), findings: [{ severity: 'major', summary: 'new' }, ...minors] }, meta);
    assert.deepEqual(r.findings.map((f) => f.summary), ['new', 'm0', 'm1', 'm2']);
    assert.equal(r.verdict, 'minor');
    const clean = mergePlanFixRound(handed, { previous: [1, 2, 3].map((id) => ({ id, status: 'resolved' as const })), findings: [] }, meta);
    assert.equal(clean.verdict, 'clean');
    assert.deepEqual(clean.findings, []);
  });
});
